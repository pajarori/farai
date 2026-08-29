import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { containerNameForSession, KaliContainerBackend } from "../agent-container/kali";
import { LspClient, LspProcessExitedError } from "./client";
import { resolveLspConfig, type ResolvedLspConfig } from "./config";
import { normalizeInspectEntries } from "./results";
import { resolveLspFile, type LspServerDefinition } from "./registry";
import type { FaraiLspConfig } from "../agent-core/config";
import type { LspInspectInput, LspInspectResult, LspPort, LspServerId } from "./types";

export type LspSpawnInput = {
  sessionId: string;
  workspace: string;
  server: LspServerId;
  command: string[];
  env: Record<string, string>;
  projectRoot: string;
};

export type LspProcessSpawner = (input: LspSpawnInput) => Promise<ChildProcessWithoutNullStreams>;

type ClientEntry = {
  sessionId: string;
  workspace: string;
  definition: LspServerDefinition;
  projectRoot: string;
  client: LspClient | undefined;
  initializing: Promise<LspClient> | undefined;
  restarts: number;
  broken?: Error;
};

export class LspManager {
  private readonly config: ResolvedLspConfig;
  private readonly entries = new Map<string, ClientEntry>();
  private readonly spawnProcess: LspProcessSpawner;

  constructor(
    private readonly defaultWorkspace: string,
    config?: FaraiLspConfig,
    options: { spawnProcess?: LspProcessSpawner } = {}
  ) {
    this.config = resolveLspConfig(config);
    this.spawnProcess = options.spawnProcess ?? (async (input) => {
      const backend = new KaliContainerBackend({
        workspace: input.workspace,
        containerName: containerNameForSession(input.sessionId)
      });
      return backend.spawnStdio(input.command, { cwd: input.projectRoot, env: input.env });
    });
  }

  forSession(sessionId: string, workspace = this.defaultWorkspace): LspPort {
    return {
      diagnose: (input) => this.diagnose(sessionId, workspace, input.path, input.content),
      inspect: (input) => this.inspect(sessionId, workspace, input)
    };
  }

  async shutdown(): Promise<void> {
    const clients = await this.collectClients([...this.entries.values()]);
    this.entries.clear();
    await Promise.allSettled(clients.map((client) => client.shutdown()));
  }

  async shutdownSession(sessionId: string): Promise<void> {
    const selected = [...this.entries.entries()].filter(([, entry]) => entry.sessionId === sessionId);
    for (const [key] of selected) this.entries.delete(key);
    const clients = await this.collectClients(selected.map(([, entry]) => entry));
    await Promise.allSettled(clients.map((client) => client.shutdown()));
  }

  private async diagnose(sessionId: string, workspace: string, path: string, content: string) {
    if (!this.config.enabled) return undefined;
    const resolved = resolveLspFile(workspace, path);
    if (!resolved || !this.config.servers[resolved.definition.id].enabled) return undefined;
    const entry = this.entryFor(sessionId, workspace, resolved.definition, resolved.projectRoot);
    const deadline = Date.now() + this.config.waitTimeoutMs;
    try {
      const diagnostics = await this.runWithClient(entry, deadline, (client, timeoutMs) =>
        client.diagnose(resolved.containerPath, content, resolved.definition.languageId(resolved.containerPath), timeoutMs)
      );
      if (!diagnostics) return undefined;
      const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 1);
      return {
        server: resolved.definition.id,
        path: resolved.containerPath.slice("/workspace/".length),
        diagnostics: errors.slice(0, 20),
        ...(errors.length > 20 ? { truncated: true } : {})
      };
    } catch {
      return undefined;
    }
  }

  private async inspect(sessionId: string, workspace: string, input: LspInspectInput): Promise<LspInspectResult> {
    if (!this.config.enabled) throw new Error("LSP is disabled");
    if (!input.path) throw new Error(`${input.operation} requires path`);
    const resolved = resolveLspFile(workspace, input.path);
    if (!resolved) throw new Error(`No built-in LSP server supports ${input.path}`);
    if (!this.config.servers[resolved.definition.id].enabled) throw new Error(`LSP server ${resolved.definition.id} is disabled`);
    const entry = this.entryFor(sessionId, workspace, resolved.definition, resolved.projectRoot);
    const deadline = Date.now() + this.config.waitTimeoutMs;
    const raw = await this.runWithClient(entry, deadline, (client, timeoutMs) => client.inspect({
      ...input,
      path: resolved.containerPath,
      languageId: resolved.definition.languageId(resolved.containerPath)
    }, timeoutMs));
    const relativePath = resolved.containerPath.slice("/workspace/".length);
    const entries = normalizeInspectEntries(input.operation, raw, relativePath);
    return {
      server: resolved.definition.id,
      projectRoot: resolved.projectRoot === "/workspace" ? "." : resolved.projectRoot.slice("/workspace/".length),
      operation: input.operation,
      entries: entries.slice(0, 100),
      ...(entries.length > 100 ? { truncated: true } : {})
    };
  }

  private entryFor(sessionId: string, workspace: string, definition: LspServerDefinition, projectRoot: string): ClientEntry {
    const key = `${sessionId}\0${workspace}\0${definition.id}\0${projectRoot}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { sessionId, workspace, definition, projectRoot, client: undefined, initializing: undefined, restarts: 0 };
      this.entries.set(key, entry);
    }
    return entry;
  }

  private async runWithClient<T>(entry: ClientEntry, deadline: number, action: (client: LspClient, timeoutMs: number) => Promise<T>): Promise<T> {
    while (true) {
      try {
        const client = await withDeadline(this.getClient(entry), deadline, "LSP initialization");
        return await action(client, remaining(deadline));
      } catch (error) {
        if (!(error instanceof LspProcessExitedError)) throw error;
        entry.client = undefined;
        entry.initializing = undefined;
        if (entry.restarts >= 1) {
          entry.broken = error;
          throw error;
        }
        entry.restarts += 1;
      }
    }
  }

  private getClient(entry: ClientEntry): Promise<LspClient> {
    if (entry.broken) return Promise.reject(entry.broken);
    if (entry.client && !entry.client.closed) return Promise.resolve(entry.client);
    if (entry.client?.closed) {
      entry.client = undefined;
      if (entry.restarts >= 1) {
        entry.broken = new LspProcessExitedError(`LSP server ${entry.definition.id} exceeded its restart limit`);
        return Promise.reject(entry.broken);
      }
      entry.restarts += 1;
    }
    if (entry.initializing) return entry.initializing;
    const serverConfig = this.config.servers[entry.definition.id];
    entry.initializing = this.spawnProcess({
      sessionId: entry.sessionId,
      workspace: entry.workspace,
      server: entry.definition.id,
      command: serverConfig.command,
      env: serverConfig.env,
      projectRoot: entry.projectRoot
    }).then(async (process) => {
      const client = new LspClient(process, entry.definition.id, entry.projectRoot);
      await client.initialize();
      entry.client = client;
      entry.initializing = undefined;
      return client;
    }).catch((error) => {
      entry.initializing = undefined;
      throw error;
    });
    return entry.initializing;
  }

  private async collectClients(entries: ClientEntry[]): Promise<LspClient[]> {
    const clients = new Set<LspClient>();
    for (const entry of entries) {
      if (entry.client) clients.add(entry.client);
      if (entry.initializing) {
        try {
          clients.add(await entry.initializing);
        } catch {}
      }
    }
    return [...clients];
  }
}

function remaining(deadline: number): number {
  const value = deadline - Date.now();
  if (value <= 0) throw new Error("LSP operation timed out");
  return value;
}

async function withDeadline<T>(promise: Promise<T>, deadline: number, label: string): Promise<T> {
  const timeoutMs = remaining(deadline);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}
