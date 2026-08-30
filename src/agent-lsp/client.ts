import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL } from "node:url";
import { FARAI_VERSION } from "../version";
import { ContentLengthParser, encodeJsonRpcMessage, type JsonRpcId, type JsonRpcMessage } from "./protocol";
import type { LspDiagnostic, LspInspectOperation } from "./types";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type DiagnosticWaiter = {
  afterSequence: number;
  resolve: (diagnostics: LspDiagnostic[] | undefined) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class LspProcessExitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LspProcessExitedError";
  }
}

export class LspRequestTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`LSP request ${method} timed out after ${timeoutMs}ms`);
    this.name = "LspRequestTimeoutError";
  }
}

export class LspClient {
  private nextId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly documentVersions = new Map<string, number>();
  private readonly diagnostics = new Map<string, LspDiagnostic[]>();
  private readonly diagnosticSequences = new Map<string, number>();
  private readonly diagnosticWaiters = new Map<string, Set<DiagnosticWaiter>>();
  private stopping = false;
  private exited = false;
  private failed = false;

  constructor(
    private readonly process: ChildProcessWithoutNullStreams,
    readonly serverName: string,
    readonly projectRoot: string
  ) {
    const parser = new ContentLengthParser(
      (message) => this.handleMessage(message),
      (error) => this.fail(new LspProcessExitedError(`Invalid LSP response from ${serverName}: ${error.message}`))
    );
    process.stdout.on("data", (chunk: Buffer) => parser.push(chunk));
    process.stderr.on("data", () => {});
    process.stdin.on("error", (error) => {
      if (!this.stopping) this.fail(new LspProcessExitedError(`LSP stdin failed for ${serverName}: ${error.message}`));
    });
    process.on("error", (error) => this.fail(new LspProcessExitedError(`LSP process failed for ${serverName}: ${error.message}`)));
    process.on("exit", (code, signal) => {
      this.exited = true;
      if (!this.stopping) this.fail(new LspProcessExitedError(`LSP server ${serverName} exited (${code ?? signal ?? "unknown"})`));
    });
  }

  get closed(): boolean {
    return this.failed || this.exited || this.process.killed;
  }

  async initialize(timeoutMs = 15_000): Promise<void> {
    const rootUri = pathToFileURL(this.projectRoot).toString();
    await this.request("initialize", {
      processId: null,
      clientInfo: { name: "farai", version: FARAI_VERSION },
      rootUri,
      workspaceFolders: [{ name: this.projectRoot.split("/").pop() || "workspace", uri: rootUri }],
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true, symbol: { dynamicRegistration: false } },
        textDocument: {
          synchronization: { dynamicRegistration: false, didSave: true },
          publishDiagnostics: { relatedInformation: false, versionSupport: true },
          definition: { dynamicRegistration: false, linkSupport: true },
          references: { dynamicRegistration: false },
          hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
          documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true }
        }
      }
    }, timeoutMs);
    this.notify("initialized", {});
    this.notify("workspace/didChangeConfiguration", { settings: {} });
  }

  async diagnose(path: string, content: string, languageId: string, timeoutMs: number): Promise<LspDiagnostic[] | undefined> {
    const uri = pathToFileURL(path).toString();
    const afterSequence = this.diagnosticSequences.get(uri) ?? 0;
    const pending = this.waitForDiagnostics(uri, afterSequence, timeoutMs);
    this.syncDocument(uri, content, languageId);
    return pending;
  }

  async inspect(input: {
    operation: LspInspectOperation;
    path?: string;
    content?: string;
    languageId?: string;
    line?: number;
    column?: number;
    query?: string;
  }, timeoutMs: number): Promise<unknown> {
    if (input.path && input.content !== undefined && input.languageId) {
      this.syncDocument(pathToFileURL(input.path).toString(), input.content, input.languageId);
    }
    if (input.operation === "workspace_symbols") {
      return this.request("workspace/symbol", { query: input.query ?? "" }, timeoutMs);
    }
    if (!input.path) throw new Error(`${input.operation} requires path`);
    const textDocument = { uri: pathToFileURL(input.path).toString() };
    if (input.operation === "document_symbols") {
      return this.request("textDocument/documentSymbol", { textDocument }, timeoutMs);
    }
    if (!input.line || !input.column) throw new Error(`${input.operation} requires 1-based line and column`);
    const position = { line: input.line - 1, character: input.column - 1 };
    if (input.operation === "definition") return this.request("textDocument/definition", { textDocument, position }, timeoutMs);
    if (input.operation === "references") {
      return this.request("textDocument/references", { textDocument, position, context: { includeDeclaration: true } }, timeoutMs);
    }
    return this.request("textDocument/hover", { textDocument, position }, timeoutMs);
  }

  async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (!this.closed) {
      try {
        await this.request("shutdown", undefined, 750);
      } catch {}
      try {
        this.notify("exit", undefined);
      } catch {}
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    if (!this.closed) this.process.kill("SIGTERM");
    this.fail(new LspProcessExitedError(`LSP server ${this.serverName} shut down`));
  }

  private syncDocument(uri: string, content: string, languageId: string): void {
    const current = this.documentVersions.get(uri);
    if (current === undefined) {
      this.documentVersions.set(uri, 1);
      this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text: content } });
    } else {
      const version = current + 1;
      this.documentVersions.set(uri, version);
      this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text: content }] });
    }
    this.notify("textDocument/didSave", { textDocument: { uri }, text: content });
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new LspProcessExitedError(`LSP server ${this.serverName} is not running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new LspRequestTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
      try {
        this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(String(id));
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  private send(message: JsonRpcMessage): void {
    if (this.closed) throw new LspProcessExitedError(`LSP server ${this.serverName} is not running`);
    this.process.stdin.write(encodeJsonRpcMessage(message));
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (message.method && message.id !== undefined) {
      this.handleServerRequest(message.id, message.method, message.params);
      return;
    }
    if (message.method === "textDocument/publishDiagnostics") {
      this.handleDiagnostics(message.params);
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(String(message.id));
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(String(message.id));
    if (message.error) pending.reject(new Error(`LSP ${message.error.code}: ${message.error.message}`));
    else pending.resolve(message.result);
  }

  private handleServerRequest(id: JsonRpcId, method: string, params: unknown): void {
    let result: unknown;
    if (method === "workspace/configuration") {
      const items = isRecord(params) && Array.isArray(params.items) ? params.items : [];
      result = items.map(() => ({}));
    } else if (method === "workspace/workspaceFolders") {
      const uri = pathToFileURL(this.projectRoot).toString();
      result = [{ name: this.projectRoot.split("/").pop() || "workspace", uri }];
    } else if (method === "window/workDoneProgress/create" || method === "client/registerCapability" || method === "client/unregisterCapability") {
      result = null;
    } else if (method === "workspace/applyEdit") {
      result = { applied: false, failureReason: "Farai LSP integration is read-only" };
    } else {
      this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unsupported client method: ${method}` } });
      return;
    }
    this.send({ jsonrpc: "2.0", id, result });
  }

  private handleDiagnostics(params: unknown): void {
    if (!isRecord(params) || typeof params.uri !== "string" || !Array.isArray(params.diagnostics)) return;
    const diagnostics = params.diagnostics.filter(isDiagnostic);
    this.diagnostics.set(params.uri, diagnostics);
    const sequence = (this.diagnosticSequences.get(params.uri) ?? 0) + 1;
    this.diagnosticSequences.set(params.uri, sequence);
    const waiters = this.diagnosticWaiters.get(params.uri);
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      if (sequence <= waiter.afterSequence) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(diagnostics);
    }
    if (waiters.size === 0) this.diagnosticWaiters.delete(params.uri);
  }

  private waitForDiagnostics(uri: string, afterSequence: number, timeoutMs: number): Promise<LspDiagnostic[] | undefined> {
    return new Promise((resolve, reject) => {
      const waiter: DiagnosticWaiter = {
        afterSequence,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.diagnosticWaiters.get(uri)?.delete(waiter);
          resolve(undefined);
        }, timeoutMs)
      };
      const waiters = this.diagnosticWaiters.get(uri) ?? new Set<DiagnosticWaiter>();
      waiters.add(waiter);
      this.diagnosticWaiters.set(uri, waiters);
    });
  }

  private fail(error: Error): void {
    if (this.failed) return;
    this.failed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiters of this.diagnosticWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    this.diagnosticWaiters.clear();
    if (!this.stopping && !this.process.killed) this.process.kill("SIGTERM");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isDiagnostic(value: unknown): value is LspDiagnostic {
  if (!isRecord(value) || typeof value.message !== "string" || !isRecord(value.range)) return false;
  return isPosition(value.range.start) && isPosition(value.range.end);
}

function isPosition(value: unknown): value is { line: number; character: number } {
  return isRecord(value) && typeof value.line === "number" && typeof value.character === "number";
}
