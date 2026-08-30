import { Show, onCleanup, type JSX } from "solid-js";
import { useTuiStore } from "../context/store";
import { useExit } from "../context/exit";
import { ComposerProvider } from "../context/composer";
import { registerCommands } from "../command-registry";
import { defineDefaultCommands } from "../commands";
import { KeyboardController } from "../input/keyboard-controller";
import { Transcript } from "../transcript/transcript";
import { ProxyLogView } from "../proxy/proxy-log-view";
import { BottomPane } from "../bottom-pane/bottom-pane";
import { CenterSurfaceView } from "../surfaces/center-surface";
import { COLOR } from "../theme";
import { isPrimaryClick } from "../input/mouse";
import { useTuiDimensions } from "../context/terminal";

export function AppShell(): JSX.Element {
  const tui = useTuiStore();
  const exit = useExit();
  const dims = useTuiDimensions();
  const centerFrame = () => tui.store.ui.centerSurfaceStack.at(-1);
  const chatActive = () => !centerFrame() && tui.store.ui.activeMainTab === "chat";
  const proxyActive = () => !centerFrame() && tui.store.ui.activeMainTab === "proxy";

  const disposeCommands = registerCommands(defineDefaultCommands({
    palette: () => tui.actions.overlayOpen("palette"),
    sessions: () => {
      tui.actions.overlayOpen("sessions");
      void tui.refreshSessions().catch((error) => {
        if (tui.store.ui.overlayStack.at(-1)?.kind === "sessions") {
          tui.actions.errorSet(error instanceof Error ? error.message : String(error));
        }
      });
    },
    evidence: () => tui.actions.overlayOpen("evidence"),
    findings: () => tui.actions.overlayOpen("findings"),
    memory: () => tui.actions.overlayOpen("memory"),
    agents: () => { void tui.openAgentsOverlay(); },
    model: () => { void tui.openModelsOverlay(); },
    report: () => tui.actions.centerSurfacePush({ kind: "report" }),
    compact: () => { void tui.compact(); },
    todos: () => tui.actions.centerSurfacePush({
      kind: "detail",
      title: "todos",
      body: tui.store.snapshot.todos.length
        ? tui.store.snapshot.todos.map((todo) => `- [${todo.status}] ${todo.priority}: ${todo.text}`).join("\n")
        : "no todos."
    }),
    notes: () => tui.actions.centerSurfacePush({
      kind: "detail",
      title: "notes",
      body: tui.store.snapshot.notes.length
        ? tui.store.snapshot.notes.map((note) => `## ${note.text.split("\n")[0] ?? "note"}\n${note.text}`).join("\n\n")
        : "no notes."
    }),
    container: () => tui.actions.centerSurfacePush({ kind: "container" }),
    proxy: () => {},
    mcp: () => { void tui.openMcpOverlay(); }
  }));
  onCleanup(disposeCommands);

  return (
    <ComposerProvider>
      <KeyboardController />
      <box
        width={dims().width}
        height={dims().height}
        minHeight={0}
        overflow="hidden"
        flexDirection="column"
        backgroundColor={COLOR.bg}
      >
        <MainTabs />
        <box id="main-surface-viewport" style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, overflow: "hidden", flexDirection: "column" }}>
          <box id="chat-surface" visible={chatActive()} style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, flexDirection: "column" }}>
            <Transcript active={chatActive()} />
          </box>
          <box id="proxy-surface" visible={proxyActive()} style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, flexDirection: "column" }}>
            <ProxyLogView active={proxyActive()} />
          </box>
          <Show when={centerFrame()} keyed>
            {(surface) => <CenterSurfaceView frame={surface} />}
          </Show>
        </box>
        <BottomPane />
      </box>
    </ComposerProvider>
  );
}

function MainTabs(): JSX.Element {
  const tui = useTuiStore();
  const dims = useTuiDimensions();
  const active = () => tui.store.ui.activeMainTab;
  const proxyCount = () => tui.store.ui.proxyFlows.length;
  const labels = () => mainTabLabels(dims().width, proxyCount());
  const tabSwitchBlocked = () => Boolean(
    tui.store.ui.overlayStack.length
    || tui.store.ui.centerSurfaceStack.length
    || tui.store.ui.modelProviderWizard
    || tui.store.ui.modelProviderRemoval
    || (tui.store.snapshot.pendingUserInput && !tui.store.ui.requestUserInput?.dismissed)
  );
  const openChat = () => {
    if (!tabSwitchBlocked()) tui.actions.mainTabSet("chat");
  };
  const openProxy = () => {
    if (tabSwitchBlocked()) return;
    tui.actions.mainTabSet("proxy");
    void tui.refreshProxyFlows();
  };
  return (
    <box id="main-tabs" style={{ height: 2, flexShrink: 0, flexDirection: "row" }}>
      <text selectable={false} fg={active() === "chat" ? COLOR.accent : COLOR.dim} onMouseUp={(event) => { if (isPrimaryClick(event)) openChat(); }}>{labels().chat}</text>
      <text fg={COLOR.dim}>{labels().gap}</text>
      <text selectable={false} fg={active() === "proxy" ? COLOR.accent : COLOR.dim} onMouseUp={(event) => { if (isPrimaryClick(event)) openProxy(); }}>{labels().proxy}</text>
    </box>
  );
}

export function mainTabLabels(width: number, proxyCount: number): { chat: string; gap: string; proxy: string } {
  const proxy = `[2] proxy${proxyCount ? ` (${proxyCount})` : ""}`;
  if (width >= "[1] chat".length + 2 + proxy.length + 2) {
    return {
      chat: "[1] chat",
      gap: "  ",
      proxy
    };
  }
  if (width >= 17) return { chat: "1 chat", gap: "  ", proxy: "2 proxy" };
  return { chat: "1", gap: "  ", proxy: "2" };
}
