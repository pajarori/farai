import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { AgentRuntime } from "../agent-core/runtime";
import { App } from "./app";
import { TuiRuntimeProvider } from "./context/runtime";
import { TuiStoreProvider } from "./context/store";
import { ExitProvider } from "./context/exit";
import { createRuntimePort, type TuiCapabilities, type TuiInput, type TuiRuntimePort } from "./runtime-port";
import { DEFAULT_SESSION_TITLE } from "../session-title";
import { resolveSessionLocation } from "../session-catalog";
import { prepareUpdateCheck } from "./update-check";
import { COLOR } from "./theme";
import { FARAI_BANNER } from "../branding";
import type { UsageSummary } from "../types";

export { createRuntimePort };
export type { TuiInput, TuiRuntimePort, TuiCapabilities };

type ManagedRenderer = {
  renderer: CliRenderer;
  disposeResize: () => void;
};

type ResizeTimer = ReturnType<typeof setTimeout>;

export function createDeferredResizeHandler(
  resize: (width: number, height: number) => void,
  readSize: () => { width: number; height: number } | undefined,
  schedule: (callback: () => void) => ResizeTimer = (callback) => setTimeout(callback, 0),
  cancel: (timer: ResizeTimer) => void = clearTimeout
): { onResize: () => void; dispose: () => void } {
  let timer: ResizeTimer | undefined;
  let disposed = false;
  const onResize = () => {
    if (disposed) return;
    if (timer !== undefined) cancel(timer);
    timer = schedule(() => {
      timer = undefined;
      if (disposed) return;
      const size = readSize();
      if (size) resize(size.width, size.height);
    });
  };
  return {
    onResize,
    dispose: () => {
      disposed = true;
      if (timer !== undefined) cancel(timer);
      timer = undefined;
    }
  };
}

export async function runOpenTui(input: TuiInput): Promise<void> {
  const capabilities: TuiCapabilities = input.capabilities ?? { compact: true, cancel: true };
  const initialSessionId = await ensureSession(input);
  let activeSessionId = initialSessionId;
  let handleRendererDestroy: (() => void) | undefined;
  const managedRenderer = await createManagedRenderer(() => handleRendererDestroy?.());
  const renderer = managedRenderer.renderer;
  const updateCheck = prepareUpdateCheck();

  let done!: () => void;
  const finished = new Promise<void>((resolve) => { done = resolve; });
  let exitPromise: Promise<void> | undefined;
  const onSigint = () => { void exitCleanly(); };
  const onSigterm = () => { void exitCleanly(); };

  const exitCleanly = (): Promise<void> => {
    if (exitPromise) return exitPromise;
    exitPromise = (async () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      let resumeHint: string | undefined;
      try { resumeHint = await prepareExitHandoff(input.runtime, activeSessionId); } catch {  }
      try { await input.runtime.dispose(); } catch {  }
      managedRenderer.disposeResize();
      try { await destroyRenderer(renderer); } catch {  }
      if (resumeHint) console.log(resumeHint);
      done();
    })();
    return exitPromise;
  };

  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  handleRendererDestroy = () => { void exitCleanly(); };
  if (renderer.isDestroyed) {
    await exitCleanly();
    return;
  }

  try {
    await render(
      () => (
        <ExitProvider handler={exitCleanly}>
          <TuiRuntimeProvider value={{ port: input.runtime, workspace: input.workspace, capabilities }}>
            <TuiStoreProvider initialSessionId={initialSessionId} updateCheck={updateCheck} onActiveSessionChange={(sessionId, title) => {
              activeSessionId = sessionId;
              renderer.setTerminalTitle(`farai · ${title?.trim() || DEFAULT_SESSION_TITLE}`);
            }}>
              <App />
            </TuiStoreProvider>
          </TuiRuntimeProvider>
        </ExitProvider>
      ),
      renderer
    );

    await finished;
  } finally {
    await exitCleanly();
  }
}

export async function resolveResumeSession(runtime: TuiRuntimePort, sessionId: string) {
  try {
    const root = (await runtime.listAgentThreads(sessionId)).find((thread) => thread.role === "main");
    if (root) return await runtime.loadSession(root.sessionId);
  } catch {  }
  return await runtime.loadSession(sessionId);
}

export async function prepareExitHandoff(runtime: TuiRuntimePort, sessionId: string): Promise<string | undefined> {
  const session = await resolveResumeSession(runtime, sessionId);
  const runningTurnId = runtime.getRunningTurnId(session.id);
  if (runningTurnId) {
    try { await runtime.cancelTurn(runningTurnId, "farai exiting"); } catch {  }
  }
  const discarded = runningTurnId ? false : await runtime.discardSessionIfEmpty(session.id);
  if (discarded) return undefined;
  let usage: UsageSummary | undefined;
  try { usage = await runtime.loadUsageSummary(session.id); } catch {  }
  const resumable = (await runtime.listSessions()).some((candidate) => candidate.id === session.id);
  if (!resumable) return undefined;
  return formatResumeHint(session.id, session.title, {
    styled: terminalStylingEnabled(),
    width: process.stdout.columns,
    usage
  });
}

async function destroyRenderer(renderer: CliRenderer): Promise<void> {
  try { renderer.destroy(); } catch {  }
}

async function createManagedRenderer(onDestroy: () => void): Promise<ManagedRenderer> {
  const renderer = await createCliRenderer({
    autoFocus: false,
    backgroundColor: COLOR.bg,
    exitOnCtrlC: false,
    onDestroy
  });
  const resize = createDeferredResizeHandler(
    (width, height) => {
      renderer.resize(width, height);
    },
    () => validTerminalSize(process.stdout.columns, process.stdout.rows)
  );
  process.on("SIGWINCH", resize.onResize);
  return {
    renderer,
    disposeResize: () => {
      process.off("SIGWINCH", resize.onResize);
      resize.dispose();
    }
  };
}

export function validTerminalSize(columns: number | undefined, rows: number | undefined): { width: number; height: number } | undefined {
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || !columns || !rows || columns < 1 || rows < 1) return undefined;
  return { width: columns, height: rows };
}

export async function ensureSession(input: TuiInput): Promise<string> {
  if (input.sessionId) {
    try { return (await input.runtime.loadSession(input.sessionId)).id; }
    catch {
      const needle = input.sessionId.trim().toLowerCase();
      const sessions = await input.runtime.listSessions();
      const matches = sessions.filter((session) => (
        session.id.toLowerCase().startsWith(needle)
        || session.title?.trim().toLowerCase() === needle
      ));
      if (matches.length === 1) return matches[0]!.id;
      throw new SessionResolutionError(input.sessionId, input.workspace, sessions);
    }
  }
  const created = await input.runtime.createSession();
  return created.id;
}

export function formatResumeHint(
  sessionId: string,
  _title?: string,
  options: { styled?: boolean; width?: number; usage?: UsageSummary | undefined } = {}
): string {
  const banner = exitBanner(options.width);
  const brand = options.styled ? `\x1b[2m${banner}\x1b[22m` : banner;
  const saved = options.styled ? "\x1b[2msession saved\x1b[22m" : "session saved";
  const usage = options.usage ? formatTokenUsage(options.usage) : undefined;
  return ["", brand, "", saved, `  farai resume ${shellQuote(sessionId)}`, "", usage, ""].filter((line) => line !== undefined).join("\n");
}

export function formatTokenUsage(usage: UsageSummary): string | undefined {
  const cached = Math.max(0, Math.round(usage.cachedInputTokens));
  const cacheWrite = Math.max(0, Math.round(usage.cacheWriteInputTokens));
  const input = Math.max(0, Math.round(usage.inputTokens) - cached - cacheWrite);
  const output = Math.max(0, Math.round(usage.outputTokens));
  if (usage.requests <= 0 && input === 0 && cached === 0 && cacheWrite === 0 && output === 0) return undefined;
  const cache = [
    cached > 0 ? `${formatTokenCount(cached)} cached` : undefined,
    cacheWrite > 0 ? `${formatTokenCount(cacheWrite)} cache write` : undefined
  ].filter(Boolean).join(", ");
  return `token usage: total=${formatTokenCount(input + output)} input=${formatTokenCount(input)}${cache ? ` (+ ${cache})` : ""} output=${formatTokenCount(output)}`;
}

function formatTokenCount(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

function exitBanner(width: number | undefined): string {
  if (!width || Math.max(...FARAI_BANNER.split("\n").map((line) => line.length)) <= width) return FARAI_BANNER;
  return "farai";
}

function terminalStylingEnabled(): boolean {
  return Boolean(process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb");
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function launchOpenTui(workspace: string, sessionId: string | undefined): Promise<void> {
  const located = sessionId ? resolveSessionLocation(sessionId) : undefined;
  const effectiveWorkspace = located?.workspace ?? workspace;
  const effectiveSessionId = located?.id ?? sessionId;
  const runtime = new AgentRuntime(effectiveWorkspace);
  let port: TuiRuntimePort | undefined;
  try {
    await runtime.recover();
    port = createRuntimePort(runtime);
    await runOpenTui({
      workspace: effectiveWorkspace,
      sessionId: effectiveSessionId,
      runtime: port,
      capabilities: { compact: true, cancel: true }
    });
  } finally {
    if (port) await port.dispose();
    else await runtime.shutdown();
  }
}

export class SessionResolutionError extends Error {
  constructor(query: string, workspace: string, sessions: Array<{ id: string; title?: string }>) {
    const recent = sessions.slice(0, 5).map((session) => `  ${session.id}  ${session.title?.trim() || DEFAULT_SESSION_TITLE}`).join("\n");
    super(`session not found: ${query}\nworkspace: ${workspace}${recent ? `\nrecent sessions:\n${recent}` : "\nno sessions are available in this workspace"}`);
    this.name = "SessionResolutionError";
  }
}
