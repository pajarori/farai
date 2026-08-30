import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Database } from "bun:sqlite";
import { localFaraiDir } from "../agent-core/config";
import { truncate } from "../utils";

export const FARAI_MANAGED_LABEL = "org.farai.managed";
export const FARAI_CONTAINER_KIND_LABEL = "org.farai.kind";
export const FARAI_ROOT_SESSION_LABEL = "org.farai.root-session";
export const FARAI_WORKSPACE_LABEL = "org.farai.workspace";
export const FARAI_WORKSPACE_HASH_LABEL = "org.farai.workspace-hash";
export const FARAI_IMAGE_CONTRACT_LABEL = "org.farai.image-contract";
export const FARAI_INTERACTIVE_CONTAINER_KIND = "interactive";
export const CONTAINER_LEASE_MS = 60_000;
export const CONTAINER_IDLE_TTL_MS = 24 * 60 * 60 * 1_000;

export type DockerProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
};

export type DockerProcessRunner = (command: string, args: string[]) => Promise<DockerProcessResult>;

export type ManagedContainerIdentity = {
  containerName: string;
  rootSessionId: string;
  workspace: string;
  imageContract: string;
};

export type ContainerLifecyclePort = {
  acquire(identity: ManagedContainerIdentity): Promise<void>;
  release(identity: ManagedContainerIdentity): void;
  renew(): void;
  reconcile(): Promise<void>;
  suspendAll(): Promise<void>;
  remove(identity: ManagedContainerIdentity): Promise<DockerProcessResult>;
  dispose(): void;
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
  private reconcilePromise: Promise<void> | undefined;
  private lastReconcileAt = 0;
  private disposed = false;

  constructor(
    private readonly runtimeId: string,
    private readonly runner: DockerProcessRunner = runDockerProcess,
    options: { registryPath?: string; idleTtlMs?: number } = {}
  ) {
    this.registry = new ContainerLeaseRegistry(options.registryPath);
    this.idleTtlMs = options.idleTtlMs ?? CONTAINER_IDLE_TTL_MS;
  }

  private readonly idleTtlMs: number;

  async acquire(identity: ManagedContainerIdentity): Promise<void> {
    this.assertOpen();
    if (Date.now() - this.lastReconcileAt >= 60_000) await this.reconcile();
    else await this.reconcilePromise;
    this.registry.acquire(identity, this.runtimeId, CONTAINER_LEASE_MS);
    this.acquired.set(identity.containerName, identity);
  }

  release(identity: ManagedContainerIdentity): void {
    if (this.disposed) return;
    this.registry.release(identity.containerName, this.runtimeId);
    this.acquired.delete(identity.containerName);
  }

  renew(): void {
    if (this.disposed || this.acquired.size === 0) return;
    this.registry.renew(this.runtimeId, CONTAINER_LEASE_MS);
  }

  async reconcile(): Promise<void> {
    this.assertOpen();
    if (this.reconcilePromise) return this.reconcilePromise;
    this.reconcilePromise = this.performReconcile().finally(() => {
      this.lastReconcileAt = Date.now();
      this.reconcilePromise = undefined;
    });
    return this.reconcilePromise;
  }

  private async performReconcile(): Promise<void> {
    const listed = await listManagedContainers(this.runner);
    if (!listed) return;
    const names = new Set(listed.map((container) => container.containerName));
    const toStop = new Set<string>();
    for (const container of listed) {
      if (this.registry.has(container.containerName)) continue;
      this.registry.adopt(container);
      if (container.state === "running") toStop.add(container.containerName);
    }
    this.registry.deleteMissing(names);
    const abandoned = this.registry.expireLeases();
    for (const identity of abandoned) {
      const container = listed.find((candidate) => candidate.containerName === identity.containerName);
      if (container?.state === "running") toStop.add(identity.containerName);
    }
    await Promise.allSettled([...toStop].map((name) => this.runner("docker", ["stop", "-t", "1", name])));
    const claimed = this.registry.claimExpiredIdle(this.runtimeId, this.idleTtlMs);
    await Promise.all(claimed.map(async (identity) => {
      const result = await this.runner("docker", ["rm", "-f", "-v", identity.containerName]);
      if (result.exitCode === 0 || containerDoesNotExist(result)) this.registry.delete(identity.containerName, this.runtimeId);
      else this.registry.release(identity.containerName, this.runtimeId);
    }));
  }

  async suspendAll(): Promise<void> {
    if (this.disposed) return;
    const identities = [...this.acquired.values()];
    await Promise.allSettled(identities.map(async (identity) => {
      if (!this.registry.ownedBy(identity.containerName, this.runtimeId)) return;
      const result = await this.runner("docker", ["stop", "-t", "1", identity.containerName]);
      if (result.exitCode !== 0 && !containerDoesNotExist(result) && !containerAlreadyStopped(result)) return;
      this.registry.release(identity.containerName, this.runtimeId);
      this.acquired.delete(identity.containerName);
    }));
  }

  async remove(identity: ManagedContainerIdentity): Promise<DockerProcessResult> {
    this.assertOpen();
    this.registry.claim(identity, this.runtimeId, CONTAINER_LEASE_MS);
    this.acquired.set(identity.containerName, identity);
    const result = await this.runner("docker", ["rm", "-f", "-v", identity.containerName]);
    if (result.exitCode === 0 || containerDoesNotExist(result)) {
      this.registry.delete(identity.containerName, this.runtimeId);
      this.acquired.delete(identity.containerName);
      if (result.exitCode !== 0) return { ...result, exitCode: 0, timedOut: false };
    }
    return result;
  }

  dispose(): void {
    if (this.disposed) return;
    for (const identity of this.acquired.values()) this.registry.release(identity.containerName, this.runtimeId);
    this.acquired.clear();
    this.registry.close();
    this.disposed = true;
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error("container lifecycle is closed");
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
  return labels?.[FARAI_MANAGED_LABEL] === "true"
    && labels[FARAI_CONTAINER_KIND_LABEL] === FARAI_INTERACTIVE_CONTAINER_KIND
    && labels[FARAI_ROOT_SESSION_LABEL] === identity.rootSessionId
    && labels[FARAI_WORKSPACE_LABEL] === encodeWorkspace(identity.workspace)
    && labels[FARAI_WORKSPACE_HASH_LABEL] === workspaceHash(identity.workspace)
    && labels[FARAI_IMAGE_CONTRACT_LABEL] === identity.imageContract;
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
    mkdirSync(join(path, ".."), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`create table if not exists container_leases (
      container_name text primary key,
      root_session_id text not null,
      workspace text not null,
      image_contract text not null,
      lease_owner text,
      lease_expires_at text,
      idle_since text,
      last_used_at text not null
    )`);
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

  expireLeases(): ManagedContainerIdentity[] {
    const now = new Date().toISOString();
    const rows = this.db.query(`select * from container_leases
      where lease_owner is not null and lease_expires_at is not null and lease_expires_at <= $now`).all({ $now: now }) as LeaseRow[];
    const update = this.db.query(`update container_leases set lease_owner = null, lease_expires_at = null,
      idle_since = coalesce(idle_since, $now), last_used_at = $now where container_name = $name`);
    this.db.transaction(() => {
      for (const row of rows) update.run({ $name: row.container_name, $now: row.lease_expires_at ?? now });
    })();
    return rows.map(identityFromRow);
  }

  claimExpiredIdle(runtimeId: string, idleTtlMs: number): ManagedContainerIdentity[] {
    const cutoff = new Date(Date.now() - Math.max(0, idleTtlMs)).toISOString();
    const rows = this.db.query(`select * from container_leases
      where lease_owner is null and idle_since is not null and idle_since <= $cutoff`).all({ $cutoff: cutoff }) as LeaseRow[];
    const expires = new Date(Date.now() + CONTAINER_LEASE_MS).toISOString();
    const claim = this.db.query(`update container_leases set lease_owner = $owner, lease_expires_at = $expires
      where container_name = $name and lease_owner is null`);
    const claimed: LeaseRow[] = [];
    this.db.transaction(() => {
      for (const row of rows) {
        const result = claim.run({ $name: row.container_name, $owner: runtimeId, $expires: expires });
        if (result.changes === 1) claimed.push(row);
      }
    }).immediate();
    return claimed.map(identityFromRow);
  }

  adopt(identity: ManagedContainerIdentity): void {
    const now = new Date().toISOString();
    this.db.query(`insert or ignore into container_leases
      (container_name, root_session_id, workspace, image_contract, lease_owner, lease_expires_at, idle_since, last_used_at)
      values ($name, $root, $workspace, $contract, null, null, $now, $now)`).run({
      $name: identity.containerName,
      $root: identity.rootSessionId,
      $workspace: resolve(identity.workspace),
      $contract: identity.imageContract,
      $now: now
    });
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
  const format = `{{.Names}}\t{{.State}}\t{{.Label "${FARAI_ROOT_SESSION_LABEL}"}}\t{{.Label "${FARAI_WORKSPACE_LABEL}"}}\t{{.Label "${FARAI_IMAGE_CONTRACT_LABEL}"}}`;
  const result = await runner("docker", [
    "ps", "-a",
    "--filter", `label=${FARAI_MANAGED_LABEL}=true`,
    "--filter", `label=${FARAI_CONTAINER_KIND_LABEL}=${FARAI_INTERACTIVE_CONTAINER_KIND}`,
    "--format", format
  ]);
  if (result.exitCode !== 0) return undefined;
  return result.stdout.split("\n").flatMap((line) => {
    const [containerName, state, rootSessionId, encodedWorkspace, imageContract] = line.trim().split("\t");
    const workspace = encodedWorkspace ? decodeWorkspace(encodedWorkspace) : undefined;
    if (!containerName || !state || !rootSessionId || !workspace || !imageContract) return [];
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
  return /no such container/i.test(`${result.stdout}\n${result.stderr}`);
}

function containerAlreadyStopped(result: DockerProcessResult): boolean {
  return /is not running|already stopped/i.test(`${result.stdout}\n${result.stderr}`);
}

async function runDockerProcess(command: string, args: string[], timeoutMs = 15_000): Promise<DockerProcessResult> {
  const started = Date.now();
  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    return { exitCode: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started, timedOut: false };
  }
  let stdout = "";
  let stderr = "";
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  proc.stdout?.on("data", (chunk) => { stdout += stdoutDecoder.write(chunk); });
  proc.stderr?.on("data", (chunk) => { stderr += stderrDecoder.write(chunk); });
  const exitCode = await new Promise<number | null>((resolveExit) => {
    const timer = setTimeout(() => { proc.kill("SIGTERM"); resolveExit(null); }, timeoutMs);
    proc.once("error", (error) => { clearTimeout(timer); stderr += error.message; resolveExit(127); });
    proc.once("close", (code) => {
      clearTimeout(timer);
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      resolveExit(code);
    });
  });
  return { exitCode, stdout: truncate(stdout), stderr: truncate(stderr), durationMs: Date.now() - started, timedOut: exitCode === null };
}
