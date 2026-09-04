import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { localFaraiDir } from "../agent-core/config";
import { runCapturedProcess } from "../agent-tools/backends/captured-process";
import { ensurePrivateDirectory, ensurePrivateRegularFileIfExists, ensurePrivateSqlitePath } from "../agent-core/private-path";
import { faraiDockerEnvironment } from "./docker-environment";

export const FARAI_MANAGED_LABEL = "org.farai.managed";
export const FARAI_CONTAINER_KIND_LABEL = "org.farai.kind";
export const FARAI_ROOT_SESSION_LABEL = "org.farai.root-session";
export const FARAI_WORKSPACE_LABEL = "org.farai.workspace";
export const FARAI_WORKSPACE_HASH_LABEL = "org.farai.workspace-hash";
export const FARAI_IMAGE_CONTRACT_LABEL = "org.farai.image-contract";
export const FARAI_INTERACTIVE_CONTAINER_KIND = "interactive";
export const FARAI_CONTAINER_NAME_PREFIX = "farai-kali-";
export const CONTAINER_LEASE_MS = 60_000;
export const CONTAINER_IDLE_TTL_MS = 24 * 60 * 60 * 1_000;
const CONTAINER_RECONCILE_INTERVAL_MS = 60_000;

export type DockerProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
};

export type DockerProcessOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type DockerProcessRunner = (command: string, args: string[], options?: DockerProcessOptions) => Promise<DockerProcessResult>;

export type ManagedContainerIdentity = {
  containerName: string;
  rootSessionId: string;
  workspace: string;
  imageContract: string;
};

export type ContainerLifecyclePort = {
  acquire(identity: ManagedContainerIdentity): Promise<void>;
  withLease?<T>(identity: ManagedContainerIdentity, operation: () => Promise<T>): Promise<T>;
  release(identity: ManagedContainerIdentity): void;
  renew(): void;
  reconcile(): Promise<void>;
  suspendAll(): Promise<void>;
  remove(identity: ManagedContainerIdentity): Promise<DockerProcessResult>;
  dispose(): void | Promise<void>;
};

type LeaseRow = {
  container_name: string;
  root_session_id: string;
  workspace: string;
  image_contract: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  idle_since: string | null;
  last_used_at: string;
};

type ManagedDockerContainer = ManagedContainerIdentity & {
  state: string;
};

export class DockerContainerLifecycle implements ContainerLifecyclePort {
  private readonly registry: ContainerLeaseRegistry;
  private readonly acquired = new Map<string, ManagedContainerIdentity>();
  private readonly stopFailures = new Set<string>();
  private readonly reconcileTimer: ReturnType<typeof setInterval>;
  private activeOperations = 0;
  private operationDrain: Promise<void> | undefined;
  private resolveOperationDrain: (() => void) | undefined;
  private reconcilePromise: Promise<void> | undefined;
  private suspendPromise: Promise<void> | undefined;
  private lastReconcileAt = 0;
  private disposed = false;
  private suspending = false;

  constructor(
    private readonly runtimeId: string,
    private readonly runner: DockerProcessRunner = runDockerProcess,
    options: { registryPath?: string; idleTtlMs?: number } = {}
  ) {
    this.registry = new ContainerLeaseRegistry(options.registryPath);
    this.idleTtlMs = options.idleTtlMs ?? CONTAINER_IDLE_TTL_MS;
    this.reconcileTimer = setInterval(() => {
      if (this.disposed || this.suspending) return;
      void this.reconcile().catch(() => undefined);
    }, CONTAINER_RECONCILE_INTERVAL_MS);
    this.reconcileTimer.unref?.();
  }

  private readonly idleTtlMs: number;

  async acquire(identity: ManagedContainerIdentity): Promise<void> {
    this.assertOpen();
    this.beginOperation();
    try {
      await this.acquireUnlocked(identity);
    } finally {
      this.endOperation();
    }
  }

  async withLease<T>(identity: ManagedContainerIdentity, operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    this.beginOperation();
    try {
      await this.acquireUnlocked(identity);
      this.assertOpen();
      return await operation();
    } finally {
      this.endOperation();
    }
  }

  private async acquireUnlocked(identity: ManagedContainerIdentity): Promise<void> {
    if (Date.now() - this.lastReconcileAt >= CONTAINER_RECONCILE_INTERVAL_MS) await this.reconcile();
    else await this.reconcilePromise;
    this.assertOpen();
    this.registry.acquire(identity, this.runtimeId, CONTAINER_LEASE_MS);
    this.acquired.set(identity.containerName, identity);
    this.stopFailures.delete(identity.containerName);
  }

  release(identity: ManagedContainerIdentity): void {
    if (this.disposed) return;
    this.registry.release(identity.containerName, this.runtimeId);
    this.acquired.delete(identity.containerName);
    this.stopFailures.delete(identity.containerName);
  }

  renew(): void {
    if (this.disposed || this.acquired.size === 0) return;
    this.registry.renew(this.runtimeId, CONTAINER_LEASE_MS);
  }

  async reconcile(): Promise<void> {
    this.assertOpen();
    if (this.reconcilePromise) return this.reconcilePromise;
    this.reconcilePromise = this.performReconcile().then((completed) => {
      if (completed) this.lastReconcileAt = Date.now();
    }).finally(() => {
      this.reconcilePromise = undefined;
    });
    return this.reconcilePromise;
  }

  private async performReconcile(): Promise<boolean> {
    const listed = await listManagedContainers(this.runner);
    if (!listed) return false;
    const names = new Set(listed.map((container) => container.containerName));
    const toStop = new Map<string, ManagedContainerIdentity>();
    const toRemove = new Map<string, ManagedContainerIdentity>();
    for (const container of listed) {
      this.registry.adopt(container);
      if (this.workspaceIsOrphaned(container.workspace) && this.registry.claimUnleased(container, this.runtimeId, CONTAINER_LEASE_MS)) {
        if (containerNeedsStop(container.state)) toStop.set(container.containerName, container);
        else toRemove.set(container.containerName, container);
      } else if (containerNeedsStop(container.state) && this.registry.claimUnleased(container, this.runtimeId, CONTAINER_LEASE_MS)) {
        toStop.set(container.containerName, container);
      }
    }
    this.registry.deleteMissing(names);
    const abandoned = this.registry.expireLeases(this.runtimeId, CONTAINER_LEASE_MS);
    for (const identity of abandoned) {
      const container = listed.find((candidate) => candidate.containerName === identity.containerName);
      if (container && managedContainerIdentityMatches(container, identity)) {
        if (this.workspaceIsOrphaned(container.workspace)) toRemove.set(identity.containerName, identity);
        else if (containerNeedsStop(container.state)) toStop.set(identity.containerName, identity);
        else toRemove.set(identity.containerName, identity);
      } else {
        this.registry.delete(identity.containerName, this.runtimeId);
      }
    }
    await Promise.allSettled([...toStop.values()].map((identity) => this.stopIfOwned(identity)));
    const claimed = this.registry.claimExpiredIdle(this.runtimeId, this.idleTtlMs);
    for (const identity of claimed) toRemove.set(identity.containerName, identity);
    await Promise.all([...toRemove.values()].map((identity) => this.removeIfOwned(identity)));
    return true;
  }

  private workspaceIsOrphaned(workspace: string): boolean {
    try {
      return !statSync(workspace).isDirectory();
    } catch {
      return true;
    }
  }

  private async stopIfOwned(identity: ManagedContainerIdentity): Promise<void> {
    let release = true;
    try {
      const inspected = await this.inspectContainer(identity.containerName);
      if (inspected.error) {
        release = false;
        return;
      }
      if (!inspected.exists || !managedContainerBelongsTo(inspected.labels, identity)) {
        this.registry.delete(identity.containerName, this.runtimeId);
        return;
      }
      await this.runner("docker", ["stop", "-t", "1", identity.containerName], { timeoutMs: 1_250 });
    } catch {
    } finally {
      if (release) this.registry.release(identity.containerName, this.runtimeId);
    }
  }

  private async removeIfOwned(identity: ManagedContainerIdentity): Promise<void> {
    try {
      const inspected = await this.inspectContainer(identity.containerName);
      if (inspected.error) return;
      if (!inspected.exists || !managedContainerBelongsTo(inspected.labels, identity)) {
        this.registry.delete(identity.containerName, this.runtimeId);
        return;
      }
      const result = await this.runner("docker", ["rm", "-f", "-v", identity.containerName], { timeoutMs: 3_000 });
      if (result.exitCode === 0 || containerDoesNotExist(result)) this.registry.delete(identity.containerName, this.runtimeId);
      else this.registry.release(identity.containerName, this.runtimeId);
    } catch {
      this.registry.release(identity.containerName, this.runtimeId);
    }
  }

  async suspendAll(): Promise<void> {
    if (this.disposed) return;
    if (this.suspendPromise) return this.suspendPromise;
    this.suspending = true;
    this.suspendPromise = this.suspendUnlocked();
    return this.suspendPromise;
  }

  private async suspendUnlocked(): Promise<void> {
    await Promise.all([
      this.waitForOperations(),
      ...(this.reconcilePromise ? [this.reconcilePromise.catch(() => undefined)] : [])
    ]);
    const identities = [...this.acquired.values()];
    await Promise.allSettled(identities.map(async (identity) => {
      if (!this.registry.ownedBy(identity.containerName, this.runtimeId)) return;
      try {
        const inspected = await this.inspectContainer(identity.containerName);
        if (inspected.error) {
          this.stopFailures.add(identity.containerName);
          return;
        }
        if (!inspected.exists || !managedContainerBelongsTo(inspected.labels, identity)) {
          this.registry.delete(identity.containerName, this.runtimeId);
          this.acquired.delete(identity.containerName);
          this.stopFailures.delete(identity.containerName);
          return;
        }
        const result = await this.runner("docker", ["stop", "-t", "1", identity.containerName], { timeoutMs: 1_250 });
        if (result.exitCode !== 0 && !containerDoesNotExist(result) && !containerAlreadyStopped(result)) {
          this.stopFailures.add(identity.containerName);
          return;
        }
        this.registry.release(identity.containerName, this.runtimeId);
        this.acquired.delete(identity.containerName);
        this.stopFailures.delete(identity.containerName);
      } catch {
        this.stopFailures.add(identity.containerName);
      }
    }));
  }

  async remove(identity: ManagedContainerIdentity): Promise<DockerProcessResult> {
    this.assertOpen();
    this.beginOperation();
    try {
      this.registry.claim(identity, this.runtimeId, CONTAINER_LEASE_MS);
      this.acquired.set(identity.containerName, identity);
      let inspected: { exists: boolean; labels?: Record<string, string>; error?: DockerProcessResult };
      try {
        inspected = await this.inspectContainer(identity.containerName);
      } catch (error) {
        this.stopFailures.add(identity.containerName);
        return {
          exitCode: 1,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          durationMs: 0,
          timedOut: false
        };
      }
      if (inspected.error) {
        this.stopFailures.add(identity.containerName);
        return inspected.error;
      }
      if (inspected.exists && !managedContainerBelongsTo(inspected.labels, identity)) {
        this.registry.delete(identity.containerName, this.runtimeId);
        this.acquired.delete(identity.containerName);
        this.stopFailures.delete(identity.containerName);
        return {
          exitCode: 1,
          stdout: "",
          stderr: `refusing to remove container ${identity.containerName}: ownership labels do not match this Farai session`,
          durationMs: 0,
          timedOut: false
        };
      }
      const result = await this.runner("docker", ["rm", "-f", "-v", identity.containerName], { timeoutMs: 3_000 });
      if (result.exitCode === 0 || containerDoesNotExist(result)) {
        this.registry.delete(identity.containerName, this.runtimeId);
        this.acquired.delete(identity.containerName);
        this.stopFailures.delete(identity.containerName);
        if (result.exitCode !== 0) return { ...result, exitCode: 0, timedOut: false };
      } else {
        this.stopFailures.add(identity.containerName);
      }
      return result;
    } finally {
      this.endOperation();
    }
  }

  private disposePromise: Promise<void> | undefined;

  dispose(): void | Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.reconcileTimer);
    const finalize = (): void => {
      try {
        for (const identity of this.acquired.values()) {
          if (!this.stopFailures.has(identity.containerName)) this.registry.release(identity.containerName, this.runtimeId);
        }
      } finally {
        this.acquired.clear();
        this.stopFailures.clear();
        this.registry.close();
      }
    };
    const waits = [
      ...(this.reconcilePromise ? [this.reconcilePromise.catch(() => undefined)] : []),
      ...(this.suspendPromise ? [this.suspendPromise.catch(() => undefined)] : []),
      this.waitForOperations()
    ];
    if (!this.reconcilePromise && !this.suspendPromise && this.activeOperations === 0) {
      finalize();
      return;
    }
    this.disposePromise = Promise.all(waits).then(finalize);
    return this.disposePromise;
  }

  private beginOperation(): void {
    if (this.suspending) throw new Error("container lifecycle is closing");
    this.activeOperations += 1;
  }

  private endOperation(): void {
    this.activeOperations -= 1;
    if (this.activeOperations === 0) {
      this.resolveOperationDrain?.();
      this.resolveOperationDrain = undefined;
      this.operationDrain = undefined;
    }
  }

  private waitForOperations(): Promise<void> {
    if (this.activeOperations === 0) return Promise.resolve();
    if (!this.operationDrain) {
      this.operationDrain = new Promise<void>((resolve) => {
        this.resolveOperationDrain = resolve;
      });
    }
    return this.operationDrain;
  }

  private async inspectContainer(containerName: string): Promise<{ exists: boolean; labels?: Record<string, string>; error?: DockerProcessResult }> {
    const result = await this.runner("docker", ["inspect", "-f", "{{json .Config.Labels}}", containerName]);
    if (result.exitCode !== 0) {
      if (containerDoesNotExist(result)) return { exists: false };
      return { exists: true, error: result };
    }
    try {
      const labels = JSON.parse(result.stdout.trim()) as Record<string, string> | null;
      return { exists: true, ...(labels ? { labels } : {}) };
    } catch {
      return { exists: true };
    }
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error("container lifecycle is closed");
    if (this.suspending) throw new Error("container lifecycle is closing");
  }
}

export function managedContainerLabels(identity: ManagedContainerIdentity): string[] {
  return [
    "--label", `${FARAI_MANAGED_LABEL}=true`,
    "--label", `${FARAI_CONTAINER_KIND_LABEL}=${FARAI_INTERACTIVE_CONTAINER_KIND}`,
    "--label", `${FARAI_ROOT_SESSION_LABEL}=${identity.rootSessionId}`,
    "--label", `${FARAI_WORKSPACE_LABEL}=${encodeWorkspace(identity.workspace)}`,
    "--label", `${FARAI_WORKSPACE_HASH_LABEL}=${workspaceHash(identity.workspace)}`,
    "--label", `${FARAI_IMAGE_CONTRACT_LABEL}=${identity.imageContract}`
  ];
}

export function managedContainerLabelsMatch(labels: Record<string, string> | undefined, identity: ManagedContainerIdentity): boolean {
  return managedContainerBelongsTo(labels, identity)
    && labels?.[FARAI_IMAGE_CONTRACT_LABEL] === identity.imageContract;
}

export function managedContainerBelongsTo(labels: Record<string, string> | undefined, identity: ManagedContainerIdentity): boolean {
  return labels?.[FARAI_MANAGED_LABEL] === "true"
    && labels[FARAI_CONTAINER_KIND_LABEL] === FARAI_INTERACTIVE_CONTAINER_KIND
    && labels[FARAI_ROOT_SESSION_LABEL] === identity.rootSessionId
    && labels[FARAI_WORKSPACE_LABEL] === encodeWorkspace(identity.workspace)
    && (!labels[FARAI_WORKSPACE_HASH_LABEL] || labels[FARAI_WORKSPACE_HASH_LABEL] === workspaceHash(identity.workspace));
}

export function workspaceHash(workspace: string): string {
  return createHash("sha256").update(resolve(workspace)).digest("hex");
}

function encodeWorkspace(workspace: string): string {
  return Buffer.from(resolve(workspace), "utf8").toString("base64url");
}

function decodeWorkspace(value: string): string | undefined {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    return decoded ? resolve(decoded) : undefined;
  } catch {
    return undefined;
  }
}

class ContainerLeaseRegistry {
  private readonly db: Database;

  constructor(path = join(localFaraiDir(), "docker-lifecycle.db")) {
    ensurePrivateDirectory(join(path, ".."), "farai home directory");
    ensurePrivateSqlitePath(path, "container lifecycle database");
    const db = new Database(path, { create: true });
    try {
      ensurePrivateRegularFileIfExists(path, "container lifecycle database");
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("PRAGMA busy_timeout = 5000;");
      db.exec(`create table if not exists container_leases (
        container_name text primary key,
        root_session_id text not null,
        workspace text not null,
        image_contract text not null,
        lease_owner text,
        lease_expires_at text,
        idle_since text,
        last_used_at text not null
      )`);
      ensurePrivateSqlitePath(path, "container lifecycle database");
      this.db = db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  acquire(identity: ManagedContainerIdentity, runtimeId: string, leaseMs: number): void {
    this.db.transaction(() => {
      const now = new Date();
      const current = this.row(identity.containerName);
      if (current?.lease_owner && current.lease_owner !== runtimeId && current.lease_expires_at && Date.parse(current.lease_expires_at) > now.getTime()) {
        throw new Error(`container environment ${identity.rootSessionId} is active in another Farai runtime`);
      }
      this.writeLease(identity, runtimeId, now, leaseMs);
    }).immediate();
  }

  claim(identity: ManagedContainerIdentity, runtimeId: string, leaseMs: number): void {
    this.acquire(identity, runtimeId, leaseMs);
  }

  renew(runtimeId: string, leaseMs: number): void {
    const now = new Date();
    this.db.query(`update container_leases set lease_expires_at = $expires, last_used_at = $now
      where lease_owner = $owner`).run({
      $owner: runtimeId,
      $expires: new Date(now.getTime() + leaseMs).toISOString(),
      $now: now.toISOString()
    });
  }

  release(containerName: string, runtimeId: string): void {
    const now = new Date().toISOString();
    this.db.query(`update container_leases set lease_owner = null, lease_expires_at = null,
      idle_since = coalesce(idle_since, $now), last_used_at = $now
      where container_name = $name and lease_owner = $owner`).run({ $name: containerName, $owner: runtimeId, $now: now });
  }

  expireLeases(runtimeId: string, leaseMs: number): ManagedContainerIdentity[] {
    const now = new Date().toISOString();
    const rows = this.db.query(`select * from container_leases
      where lease_owner is not null and lease_owner != $owner and lease_expires_at is not null and lease_expires_at <= $now`).all({ $now: now, $owner: runtimeId }) as LeaseRow[];
    const expires = new Date(Date.now() + leaseMs).toISOString();
    const update = this.db.query(`update container_leases set lease_owner = $owner, lease_expires_at = $expires,
      idle_since = coalesce(idle_since, $idle), last_used_at = $now
      where container_name = $name and lease_owner = $previousOwner and lease_expires_at = $previousExpires`);
    const claimed: LeaseRow[] = [];
    this.db.transaction(() => {
      for (const row of rows) {
        const result = update.run({
          $name: row.container_name,
          $previousOwner: row.lease_owner,
          $previousExpires: row.lease_expires_at,
          $owner: runtimeId,
          $expires: expires,
          $idle: row.lease_expires_at ?? now,
          $now: now
        });
        if (result.changes === 1) claimed.push(row);
      }
    }).immediate();
    return claimed.map(identityFromRow);
  }

  claimExpiredIdle(runtimeId: string, idleTtlMs: number): ManagedContainerIdentity[] {
    const cutoff = new Date(Date.now() - Math.max(0, idleTtlMs)).toISOString();
    const rows = this.db.query(`select * from container_leases
      where lease_owner is null and idle_since is not null and idle_since <= $cutoff`).all({ $cutoff: cutoff }) as LeaseRow[];
    const expires = new Date(Date.now() + CONTAINER_LEASE_MS).toISOString();
    const claim = this.db.query(`update container_leases set lease_owner = $owner, lease_expires_at = $expires
      where container_name = $name and lease_owner is null and lease_expires_at is null
        and idle_since = $idle`);
    const claimed: LeaseRow[] = [];
    this.db.transaction(() => {
      for (const row of rows) {
        const result = claim.run({ $name: row.container_name, $owner: runtimeId, $expires: expires, $idle: row.idle_since });
        if (result.changes === 1) claimed.push(row);
      }
    }).immediate();
    return claimed.map(identityFromRow);
  }

  adopt(identity: ManagedContainerIdentity): void {
    const now = new Date().toISOString();
    this.db.query(`insert into container_leases
      (container_name, root_session_id, workspace, image_contract, lease_owner, lease_expires_at, idle_since, last_used_at)
      values ($name, $root, $workspace, $contract, null, null, $now, $now)
      on conflict(container_name) do update set
        root_session_id = excluded.root_session_id,
        workspace = excluded.workspace,
        image_contract = excluded.image_contract,
        idle_since = case when container_leases.root_session_id <> excluded.root_session_id
          or container_leases.workspace <> excluded.workspace
          or container_leases.image_contract <> excluded.image_contract
          then excluded.idle_since else coalesce(container_leases.idle_since, excluded.idle_since) end,
        last_used_at = case when container_leases.root_session_id <> excluded.root_session_id
          or container_leases.workspace <> excluded.workspace
          or container_leases.image_contract <> excluded.image_contract
          then excluded.last_used_at else container_leases.last_used_at end
      where container_leases.lease_owner is null`).run({
      $name: identity.containerName,
      $root: identity.rootSessionId,
      $workspace: resolve(identity.workspace),
      $contract: identity.imageContract,
      $now: now
    });
  }

  claimUnleased(identity: ManagedContainerIdentity, runtimeId: string, leaseMs: number): boolean {
    const expires = new Date(Date.now() + leaseMs).toISOString();
    const result = this.db.query(`update container_leases set lease_owner = $owner, lease_expires_at = $expires
      where container_name = $name and root_session_id = $root and workspace = $workspace
        and image_contract = $contract and lease_owner is null and lease_expires_at is null`).run({
      $name: identity.containerName,
      $root: identity.rootSessionId,
      $workspace: resolve(identity.workspace),
      $contract: identity.imageContract,
      $owner: runtimeId,
      $expires: expires
    });
    return result.changes === 1;
  }

  has(containerName: string): boolean {
    return Boolean(this.row(containerName));
  }

  ownedBy(containerName: string, runtimeId: string): boolean {
    return this.row(containerName)?.lease_owner === runtimeId;
  }

  deleteMissing(names: Set<string>): void {
    const rows = this.db.query("select container_name from container_leases").all() as Array<{ container_name: string }>;
    const remove = this.db.query("delete from container_leases where container_name = $name and lease_owner is null");
    this.db.transaction(() => {
      for (const row of rows) if (!names.has(row.container_name)) remove.run({ $name: row.container_name });
    })();
  }

  delete(containerName: string, runtimeId: string): void {
    this.db.query("delete from container_leases where container_name = $name and lease_owner = $owner")
      .run({ $name: containerName, $owner: runtimeId });
  }

  close(): void {
    this.db.close();
  }

  private row(containerName: string): LeaseRow | undefined {
    return this.db.query("select * from container_leases where container_name = $name").get({ $name: containerName }) as LeaseRow | null ?? undefined;
  }

  private writeLease(identity: ManagedContainerIdentity, runtimeId: string, now: Date, leaseMs: number): void {
    this.db.query(`insert into container_leases
      (container_name, root_session_id, workspace, image_contract, lease_owner, lease_expires_at, idle_since, last_used_at)
      values ($name, $root, $workspace, $contract, $owner, $expires, null, $now)
      on conflict(container_name) do update set
        root_session_id = excluded.root_session_id,
        workspace = excluded.workspace,
        image_contract = excluded.image_contract,
        lease_owner = excluded.lease_owner,
        lease_expires_at = excluded.lease_expires_at,
        idle_since = null,
        last_used_at = excluded.last_used_at`).run({
      $name: identity.containerName,
      $root: identity.rootSessionId,
      $workspace: resolve(identity.workspace),
      $contract: identity.imageContract,
      $owner: runtimeId,
      $expires: new Date(now.getTime() + leaseMs).toISOString(),
      $now: now.toISOString()
    });
  }
}

async function listManagedContainers(runner: DockerProcessRunner): Promise<ManagedDockerContainer[] | undefined> {
  const format = `{{.Names}}\t{{.State}}\t{{.Label "${FARAI_ROOT_SESSION_LABEL}"}}\t{{.Label "${FARAI_WORKSPACE_LABEL}"}}\t{{.Label "${FARAI_WORKSPACE_HASH_LABEL}"}}\t{{.Label "${FARAI_IMAGE_CONTRACT_LABEL}"}}`;
  const result = await runner("docker", [
    "ps", "-a",
    "--filter", `label=${FARAI_MANAGED_LABEL}=true`,
    "--filter", `label=${FARAI_CONTAINER_KIND_LABEL}=${FARAI_INTERACTIVE_CONTAINER_KIND}`,
    "--format", format
  ], { timeoutMs: 3_000 });
  if (result.exitCode !== 0) return undefined;
  return result.stdout.split("\n").flatMap((line) => {
    const fields = line.trim().split("\t");
    const [containerName, state, rootSessionId, encodedWorkspace] = fields;
    const encodedWorkspaceHash = fields.length >= 6 ? fields[4] : "";
    const imageContract = fields.length >= 6 ? fields[5] : fields[4];
    const workspace = encodedWorkspace ? decodeWorkspace(encodedWorkspace) : undefined;
    if (!containerName || !containerName.startsWith(FARAI_CONTAINER_NAME_PREFIX) || !state || !rootSessionId || !workspace || !imageContract) return [];
    if (encodedWorkspaceHash && encodedWorkspaceHash !== workspaceHash(workspace)) return [];
    return [{ containerName, state, rootSessionId, workspace, imageContract }];
  });
}

function identityFromRow(row: LeaseRow): ManagedContainerIdentity {
  return {
    containerName: row.container_name,
    rootSessionId: row.root_session_id,
    workspace: row.workspace,
    imageContract: row.image_contract
  };
}

function containerDoesNotExist(result: DockerProcessResult): boolean {
  return /no such (container|object)/i.test(`${result.stdout}\n${result.stderr}`);
}

function containerAlreadyStopped(result: DockerProcessResult): boolean {
  return /is not running|already stopped/i.test(`${result.stdout}\n${result.stderr}`);
}

function containerNeedsStop(state: string): boolean {
  return ["created", "running", "restarting", "paused"].includes(state.toLowerCase());
}

function managedContainerIdentityMatches(left: ManagedContainerIdentity, right: ManagedContainerIdentity): boolean {
  return left.rootSessionId === right.rootSessionId && resolve(left.workspace) === resolve(right.workspace);
}

async function runDockerProcess(command: string, args: string[], options: DockerProcessOptions = {}): Promise<DockerProcessResult> {
  return await runCapturedProcess(command, args, {
    timeoutMs: options.timeoutMs ?? 3_000,
    ...(options.signal ? { signal: options.signal } : {}),
    env: faraiDockerEnvironment()
  });
}
