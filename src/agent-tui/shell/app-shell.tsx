import { Show, onCleanup, type JSX } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
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

export function AppShell(): JSX.Element {
  const tui = useTuiStore();
  const exit = useExit();
  const dims = useTerminalDimensions();

  const disposeCommands = registerCommands(defineDefaultCommands({
    palette: () => tui.actions.overlayOpen("palette"),
    sessions: () => {
      tui.actions.overlayOpen("sessions");
      void tui.refreshSessions().catch((error) => {
        tui.actions.errorSet(error instanceof Error ? error.message : String(error));
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
          <Show when={tui.store.ui.centerSurfaceStack.at(-1)} fallback={
            <Show when={tui.store.ui.activeMainTab === "proxy"} fallback={<Transcript />}>
              <ProxyLogView />
            </Show>
          }>
            {(surface) => <CenterSurfaceView frame={surface()} />}
          </Show>
        </box>
        <BottomPane />
      </box>
    </ComposerProvider>
  );
}

function MainTabs(): JSX.Element {
  const tui = useTuiStore();
  const active = () => tui.store.ui.activeMainTab;
  const proxyCount = () => tui.store.ui.proxyFlows.length;
  const openChat = () => { tui.actions.mainTabSet("chat"); };
  const openProxy = () => {
    tui.actions.mainTabSet("proxy");
    void tui.refreshProxyFlows();
  };
  return (
    <box style={{ height: 1, flexShrink: 0, flexDirection: "row", paddingLeft: 1, paddingRight: 1 }}>
      <text selectable={false} fg={active() === "chat" ? COLOR.accent : COLOR.dim} onMouseUp={(event) => { if (isPrimaryClick(event)) openChat(); }}>{"[1] chat"}</text>
      <text fg={COLOR.dim}>{"  "}</text>
      <text selectable={false} fg={active() === "proxy" ? COLOR.accent : COLOR.dim} onMouseUp={(event) => { if (isPrimaryClick(event)) openProxy(); }}>{`[2] proxy${proxyCount() ? ` (${proxyCount()})` : ""}`}</text>
    </box>
  );
}
