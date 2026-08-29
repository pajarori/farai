import { createCliRenderer, RGBA, type CliRenderer } from "@opentui/core";
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
      try {
        const session = await resolveResumeSession(input.runtime, activeSessionId);
        const resumable = (await input.runtime.listSessions()).some((candidate) => candidate.id === session.id);
        if (resumable) resumeHint = formatResumeHint(session.id, session.title);
      } catch {  }
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
      renderer.currentRenderBuffer.clear(RGBA.fromInts(1, 1, 1, 255));
      renderer.requestRender();
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

export function formatResumeHint(sessionId: string, _title?: string): string {
  return ["", "to continue this session, run:", `  farai resume ${shellQuote(sessionId)}`].join("\n");
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
