import type { TuiStoreValue } from "../context/store";
import type { TuiRuntimePort } from "../runtime-port";
import { proxyFlowsForFilter } from "../store";
import type { SessionOwner } from "./center-surface-controller";
import { createControllerOperations } from "./controller-operation";

type ProxyControllerInput = {
  tui: TuiStoreValue;
  port: TuiRuntimePort;
  captureOwner(): SessionOwner | undefined;
  owns(owner: SessionOwner): boolean;
};

export function createProxyController(input: ProxyControllerInput) {
  const { tui, port } = input;
  const operations = createControllerOperations(tui);

  function reset(): void {
    operations.invalidate();
  }

  async function setMainTab(tab: "chat" | "proxy"): Promise<void> {
    if (tab !== "proxy") reset();
    tui.actions.mainTabSet(tab);
    if (tab === "proxy") await tui.refreshProxyFlows();
  }

  async function openSelected(): Promise<void> {
    const owner = input.captureOwner();
    if (!owner) return;
    const flow = proxyFlowsForFilter(tui.store.ui.proxyFlows, tui.store.ui.proxyFilter)[tui.store.ui.proxySelectedIndex];
    if (!flow) return;
    const status = "loading proxy flow";
    const operation = operations.begin(status);
    try {
      const detail = await port.getProxyFlow(flow.id);
      if (!ownsRequest(operation, owner, flow.id)) return;
      if (detail) {
        tui.actions.centerSurfacePush({ kind: "proxy_flow", flow: detail });
        return;
      }
      tui.actions.centerSurfacePush({
        kind: "detail",
        title: `${flow.method} ${flow.status ?? "-"} ${flow.host}`,
        body: `No stored detail for flow ${flow.id}.`
      });
    } catch (error) {
      if (ownsRequest(operation, owner, flow.id)) {
        tui.actions.errorSet(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (input.owns(owner)) operations.finish(operation);
    }
  }

  function ownsRequest(operation: number, owner: SessionOwner, flowId: string): boolean {
    return operations.owns(operation)
      && input.owns(owner)
      && tui.store.ui.activeMainTab === "proxy"
      && proxyFlowsForFilter(tui.store.ui.proxyFlows, tui.store.ui.proxyFilter)[tui.store.ui.proxySelectedIndex]?.id === flowId
      && tui.store.ui.overlayStack.length === 0
      && tui.store.ui.centerSurfaceStack.length === 0;
  }

  function setWebSocketSection(section: 0 | 1): void {
    const frame = tui.store.ui.centerSurfaceStack.at(-1);
    if (frame?.kind === "proxy_flow" && frame.flow.kind === "websocket") {
      tui.actions.proxyWebSocketSectionSet(section);
    } else {
      tui.actions.proxyDetailPaneSet(section);
    }
  }

  return {
    reset,
    setMainTab,
    setFilter: (filter: "all" | "http" | "websocket") => tui.actions.proxyFilterSet(filter),
    cycleFilter: (delta: number) => tui.actions.proxyFilterCycle(delta),
    move: (delta: number) => tui.actions.proxySelectedMove(delta),
    openSelected,
    setDetailPane: (pane: 0 | 1) => tui.actions.proxyDetailPaneSet(pane),
    moveDetailPane: (delta: number) => tui.actions.proxyDetailPaneMove(delta),
    setWebSocketSection,
    moveWebSocketMessage: (delta: number) => tui.actions.proxyWebSocketMessageMove(delta)
  };
}
