import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { For, Show, createEffect, createMemo, createSignal, onCleanup, untrack, type JSX } from "solid-js";
import { DEFAULT_MITMPROXY_PORT } from "../../agent-tools/mcp-adapter";
import type { ProxyFlowDetail, ProxyFlowSummary } from "../../agent-tools/services/mitmproxy/flows";
import { proxyFlowDetailFromSummary } from "../../agent-tools/services/mitmproxy/flows";
import { useTuiRuntime } from "../context/runtime";
import { useTuiStore } from "../context/store";
import { proxyFlowsForFilter, type ProxyViewFilter } from "../store";
import { ProxyFlowSplitView } from "../surfaces/center-surface";
import { COLOR } from "../theme";

export function proxyListHeightFromDrag(startHeight: number, startY: number, pointerY: number): number {
  return startHeight + pointerY - startY;
}

export function clampProxyListHeight(height: number, terminalHeight: number): number {
  return Math.max(5, Math.min(Math.max(5, terminalHeight - 14), height));
}

export function ProxyLogView(): JSX.Element {
  const tui = useTuiStore();
  const { port } = useTuiRuntime();
  const dims = useTerminalDimensions();
  let scrollRef!: ScrollBoxRenderable;
  const [detail, setDetail] = createSignal<ProxyFlowDetail | undefined>();
  const [detailLoading, setDetailLoading] = createSignal(false);
  const [detailError, setDetailError] = createSignal<string | undefined>();
  const [listHeightOverride, setListHeightOverride] = createSignal<number | undefined>();
  const [dividerDragging, setDividerDragging] = createSignal(false);
  let dividerDragStart: { pointerY: number; listHeight: number } | undefined;
  let suppressProxyRowMouseUp = false;
  let detailRequestId = 0;
  let detailLoadingTimer: ReturnType<typeof setTimeout> | undefined;
  const detailCache = new Map<string, ProxyFlowDetail>();
  const detailRequests = new Map<string, Promise<ProxyFlowDetail>>();
  const mitmServices = createMemo(() => tui.store.ui.services.filter((service) => service.kind === "mitmproxy" || service.kind === "mitmproxy-mcp"));
  const rows = createMemo(() => proxyFlowsForFilter(tui.store.ui.proxyFlows, tui.store.ui.proxyFilter));
  const selectedFlow = createMemo(() => rows()[tui.store.ui.proxySelectedIndex]);
  const selectedPresentation = createMemo(() => {
    const flow = selectedFlow();
    return flow ? proxyFlowTablePresentation(flow, tui.store.ui.proxyFilter) : undefined;
  });
  const selectedId = createMemo(() => selectedFlow()?.id);
  const selectedSignature = createMemo(() => {
    const flow = selectedFlow();
    if (!flow) return undefined;
    return [
      flow.id,
      flow.status ?? "",
      flow.requestBytes ?? "",
      flow.responseBytes ?? "",
      flow.contentType ?? "",
      "messageCount" in flow ? flow.messageCount : "",
      "closeCode" in flow ? flow.closeCode ?? "" : "",
      flow.durationMs ?? "",
      flow.error ?? ""
    ].join("|");
  });
  const defaultListHeight = () => Math.max(7, Math.min(14, Math.floor(dims().height * 0.34)));
  const listHeight = () => clampProxyListHeight(listHeightOverride() ?? defaultListHeight(), dims().height);
  const tableWidth = () => Math.max(30, dims().width - 4);
  const beginListResize = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    dividerDragStart = { pointerY: event.y, listHeight: listHeight() };
    suppressProxyRowMouseUp = true;
    setDividerDragging(true);
    event.preventDefault();
    event.stopPropagation();
  };
  const resizeList = (event: MouseEvent): void => {
    if (!dividerDragStart) return;
    setListHeightOverride(proxyListHeightFromDrag(
      dividerDragStart.listHeight,
      dividerDragStart.pointerY,
      event.y
    ));
    event.preventDefault();
    event.stopPropagation();
  };
  const finishListResize = (event: MouseEvent): void => {
    if (!dividerDragStart) return;
    resizeList(event);
    dividerDragStart = undefined;
    setDividerDragging(false);
    queueMicrotask(() => { suppressProxyRowMouseUp = false; });
  };
  const proxyHint = createMemo(() => {
    const service = mitmServices()[0];
    const port = proxyPort(service?.metadata);
    return `mitmproxy-mcp starts with the session; browse through 127.0.0.1:${port}.`;
  });

  createEffect(() => {
    const signature = selectedSignature();
    const requestId = ++detailRequestId;
    const flow = untrack(selectedFlow);
    if (detailLoadingTimer) {
      clearTimeout(detailLoadingTimer);
      detailLoadingTimer = undefined;
    }
    if (!flow) {
      setDetail(undefined);
      setDetailError(undefined);
      setDetailLoading(false);
      return;
    }
    const cacheKey = signature ?? flow.id;
    const cached = detailCache.get(cacheKey);
    if (cached) {
      setDetail(cached);
      setDetailError(undefined);
      setDetailLoading(false);
      return;
    }
    setDetailLoading(false);
    setDetailError(undefined);
    const summary = proxyFlowDetailFromSummary(flow);
    setDetail(summary);
    detailLoadingTimer = setTimeout(() => {
      if (requestId === detailRequestId) setDetailLoading(true);
    }, 250);
    const pending = detailRequests.get(cacheKey) ?? port.getProxyFlow(flow.id)
      .then((next) => {
        const resolved = next ?? summary;
        cacheProxyDetail(detailCache, cacheKey, resolved);
        return resolved;
      })
      .finally(() => {
        detailRequests.delete(cacheKey);
      });
    detailRequests.set(cacheKey, pending);
    void pending
      .then((resolved) => {
        if (requestId === detailRequestId) setDetail(resolved);
      })
      .catch((error) => {
        if (requestId !== detailRequestId) return;
        setDetailError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (requestId !== detailRequestId) return;
        if (detailLoadingTimer) {
          clearTimeout(detailLoadingTimer);
          detailLoadingTimer = undefined;
        }
        setDetailLoading(false);
      });
  });

  onCleanup(() => {
    detailRequestId += 1;
    if (detailLoadingTimer) clearTimeout(detailLoadingTimer);
  });

  createEffect(() => {
    const id = selectedId();
    if (!id) return;
    queueMicrotask(() => {
      if (!scrollRef) return;
      try { scrollRef.scrollChildIntoView(id); } catch {}
    });
  });

  return (
    <box
      style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, flexDirection: "column", paddingTop: 1, paddingBottom: 1, paddingLeft: 2, paddingRight: 2 }}
      onMouseDrag={resizeList}
      onMouseDragEnd={finishListResize}
      onMouseUp={finishListResize}
    >
      <box style={{ height: 1, flexDirection: "row", justifyContent: "space-between" }}>
        <text fg={COLOR.text}>proxy traffic</text>
      </box>
      <ProxySubTabs flows={tui.store.ui.proxyFlows} active={tui.store.ui.proxyFilter} width={tableWidth()} onSelect={tui.actions.proxyFilterSet} />
      <box style={{ height: listHeight(), flexShrink: 0, flexDirection: "column", marginTop: 1 }}>
        <box style={{ height: 1, flexDirection: "row" }}>
          <text fg={COLOR.dim}>{proxyHeaderLine(tableWidth())}</text>
        </box>
        <scrollbox
          ref={scrollRef}
          scrollbarOptions={{ visible: false }}
          style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, flexDirection: "column" }}
        >
          <Show
            when={rows().length > 0}
            fallback={
              <box style={{ flexDirection: "column", marginTop: 1 }}>
                <text fg={COLOR.dim}>{`no ${tui.store.ui.proxyFilter === "all" ? "captured proxy" : tui.store.ui.proxyFilter} flows yet`}</text>
                <text fg={COLOR.dim}>{proxyHint().toLowerCase()}</text>
              </box>
            }
          >
            <For each={rows()}>{(flow, index) => (
              <box
                id={flow.id}
                style={{ height: 1, flexDirection: "row" }}
                onMouseUp={(event) => {
                  if (suppressProxyRowMouseUp) {
                    event.preventDefault();
                    return;
                  }
                  tui.actions.proxySelectedSet(index());
                }}
              >
                <ProxyRow flow={flow} filter={tui.store.ui.proxyFilter} selected={index() === tui.store.ui.proxySelectedIndex} width={tableWidth()} />
              </box>
            )}</For>
          </Show>
        </scrollbox>
      </box>
      <box style={{ height: 1, flexShrink: 0, flexDirection: "row", justifyContent: "space-between", marginTop: 1 }}>
        <text fg={COLOR.dim}>{truncate(selectedFlow() && selectedPresentation() ? `${selectedPresentation()!.kind} · ${selectedPresentation()!.method} ${selectedFlow()!.url}` : "no flow selected", Math.max(8, tableWidth() - 20))}</text>
        <text fg={detailLoading() ? COLOR.accent : detailError() ? COLOR.error : COLOR.dim}>{truncate(detailLoading() ? "loading detail" : detailError() ?? "", 18)}</text>
      </box>
      <box
        style={{ height: 1, flexShrink: 0, alignItems: "center", justifyContent: "flex-start" }}
        onMouseDown={beginListResize}
      >
        <text selectable={false} fg={dividerDragging() ? COLOR.accent : COLOR.border}>{"─".repeat(Math.max(1, dims().width - 4))}</text>
      </box>
      <box style={{ flexGrow: 1, minHeight: 0, flexDirection: "column", paddingTop: 1 }}>
        <Show when={detail()} fallback={
          <box style={{ flexDirection: "column" }}>
            <text fg={COLOR.dim}>{"select a flow to inspect protocol-aware details"}</text>
          </box>
        }>
          {(flow) => (
            <box style={{ flexGrow: 1, minHeight: 0, flexDirection: "column" }}>
              <Show when={isSummaryOnly(flow())}>
                <box style={{ height: 1, flexShrink: 0, marginBottom: 1 }}>
                  <text fg={COLOR.warning}>{"full body unavailable; showing captured metadata"}</text>
                </box>
              </Show>
              <ProxyFlowSplitView flow={flow()} compact />
            </box>
          )}
        </Show>
      </box>
    </box>
  );
}

function ProxySubTabs(props: {
  flows: readonly ProxyFlowSummary[];
  active: ProxyViewFilter;
  width: number;
  onSelect: (filter: ProxyViewFilter) => void;
}): JSX.Element {
  const count = (filter: ProxyViewFilter) => proxyFlowsForFilter(props.flows, filter).length;
  const tabs: Array<{ filter: ProxyViewFilter; key: string; label: string }> = [
    { filter: "all", key: "a", label: "all" },
    { filter: "http", key: "h", label: "http" },
    { filter: "websocket", key: "w", label: "websocket" }
  ];
  const gap = () => props.width < 38 ? " " : "  ";
  return (
    <box style={{ height: 1, flexShrink: 0, flexDirection: "row", marginTop: 1 }}>
      <For each={tabs}>{(tab, index) => (
        <>
          <Show when={index() > 0}><text fg={COLOR.border}>{gap()}</text></Show>
          <text
            fg={props.active === tab.filter ? COLOR.accent : COLOR.dim}
            onMouseUp={() => props.onSelect(tab.filter)}
          >{proxySubTabLabel(tab.filter, count(tab.filter), props.width)}</text>
        </>
      )}</For>
    </box>
  );
}

export function proxySubTabLabel(filter: ProxyViewFilter, count: number, width: number): string {
  const key = filter === "all" ? "a" : filter === "http" ? "h" : "w";
  const label = filter === "websocket" ? "ws" : filter;
  if (width < 38) return `${key}:${label}`;
  if (width < 60) return `${key}:${label} ${count}`;
  return `[${key}] ${filter} (${count})`;
}

function cacheProxyDetail(cache: Map<string, ProxyFlowDetail>, key: string, detail: ProxyFlowDetail): void {
  cache.set(key, detail);
  if (cache.size <= 256) return;
  const oldest = cache.keys().next().value;
  if (typeof oldest === "string") cache.delete(oldest);
}

function proxyPort(metadata: Record<string, unknown> | undefined): number {
  const proxy = metadata?.proxy;
  if (proxy && typeof proxy === "object" && "port" in proxy && typeof proxy.port === "number") {
    return proxy.port;
  }
  return typeof metadata?.port === "number" ? metadata.port : DEFAULT_MITMPROXY_PORT;
}

function shortTime(value: string): string {
  const match = value.match(/T(\d\d:\d\d:\d\d)/);
  return match?.[1] ?? value.slice(0, 8);
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width - 1).padEnd(width) : value.padEnd(width);
}

function truncate(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, width - 1)}…`;
}

function methodColor(method: string): string {
  if (method === "POST" || method === "PUT" || method === "PATCH") return COLOR.accent;
  if (method === "DELETE") return COLOR.error;
  return COLOR.text;
}

function statusColor(status: number | undefined): string {
  if (!status) return COLOR.dim;
  if (status >= 500) return COLOR.error;
  if (status >= 400) return COLOR.warning;
  if (status >= 300) return COLOR.accent;
  return COLOR.success;
}

function formatBytes(value: number | undefined): string {
  if (value === undefined) return "-";
  if (value < 1024) return `${value}b`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)}kb`;
  return `${(value / 1024 / 1024).toFixed(1)}mb`;
}

function formatDuration(value: number | undefined): string {
  if (value === undefined) return "-";
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function isSummaryOnly(flow: ProxyFlowDetail): boolean {
  if (flow.kind === "http") {
    return !flow.request.bodyText && !flow.request.bodyBase64 && !flow.response?.bodyText && !flow.response?.bodyBase64;
  }
  if (flow.kind === "websocket") return flow.messages.length === 0;
  if (flow.kind === "tcp" || flow.kind === "udp") return flow.messages.length === 0;
  return !flow.response && flow.answerCount > 0;
}

function proxyHeaderLine(width: number): string {
  if (width < 96) {
    return truncate([
      pad("", 2),
      pad("proto", 7),
      pad("method", 8),
      pad("sts", 5),
      "host / path"
    ].join(""), width);
  }
  return truncate([
    pad("", 2),
    pad("time", 9),
    pad("proto", 7),
    pad("method", 8),
    pad("sts", 5),
    pad("host", 30),
    pad("path", Math.max(18, width - 98)),
    pad("type", 16),
    pad("size", 8),
    "dur"
  ].join(""), width);
}

type ProxyRowFlow = {
  kind: ProxyFlowDetail["kind"];
  timestamp: string;
  method: string;
  status?: number;
  host: string;
  path: string;
  contentType?: string;
  responseBytes?: number;
  requestBytes?: number;
  durationMs?: number;
};

export function proxyFlowTablePresentation(flow: Pick<ProxyRowFlow, "kind" | "method">, filter: ProxyViewFilter): { kind: ProxyRowFlow["kind"]; method: string } {
  if (filter === "http" && flow.kind === "websocket") return { kind: "http", method: "GET" };
  return { kind: flow.kind, method: flow.method };
}

function ProxyRow(props: { flow: ProxyRowFlow; filter: ProxyViewFilter; selected: boolean; width: number }): JSX.Element {
  const pathWidth = () => Math.max(18, props.width - 98);
  const compactTarget = () => truncate(`${props.flow.host}${props.flow.path || "/"}`, Math.max(8, props.width - 22));
  const presentation = () => proxyFlowTablePresentation(props.flow, props.filter);
  return (
    <Show when={props.width >= 96} fallback={
      <>
        <text fg={props.selected ? COLOR.accent : COLOR.dim}>{pad(props.selected ? ">" : "", 2)}</text>
        <text fg={COLOR.dim}>{pad(presentation().kind, 7)}</text>
        <text fg={methodColor(presentation().method)}>{pad(presentation().method, 8)}</text>
        <text fg={statusColor(props.flow.status)}>{pad(String(props.flow.status ?? "-"), 5)}</text>
        <text fg={props.selected ? COLOR.accent : COLOR.text}>{compactTarget()}</text>
      </>
    }>
      <text fg={props.selected ? COLOR.accent : COLOR.dim}>{pad(props.selected ? ">" : "", 2)}</text>
      <text fg={COLOR.dim}>{pad(shortTime(props.flow.timestamp), 9)}</text>
      <text fg={COLOR.dim}>{pad(presentation().kind, 7)}</text>
      <text fg={methodColor(presentation().method)}>{pad(presentation().method, 8)}</text>
      <text fg={statusColor(props.flow.status)}>{pad(String(props.flow.status ?? "-"), 5)}</text>
      <text fg={props.selected ? COLOR.accent : COLOR.text}>{pad(truncate(props.flow.host, 29), 30)}</text>
      <text fg={props.selected ? COLOR.accent : COLOR.text}>{pad(truncate(props.flow.path || "/", pathWidth() - 1), pathWidth())}</text>
      <text fg={COLOR.dim}>{pad(truncate(normalizeContentType(props.flow.contentType), 15), 16)}</text>
      <text fg={COLOR.dim}>{pad(formatBytes(props.flow.responseBytes ?? props.flow.requestBytes), 8)}</text>
      <text fg={COLOR.dim}>{formatDuration(props.flow.durationMs)}</text>
    </Show>
  );
}

function normalizeContentType(value: string | undefined): string {
  if (!value) return "-";
  return value.split(";")[0]?.trim() || value;
}
