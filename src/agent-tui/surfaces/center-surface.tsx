import type { ScrollBoxRenderable } from "@opentui/core";
import { For, Show, createEffect, createMemo, createSignal, untrack, type JSX } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import type {
  ProxyDnsMessage,
  ProxyFlowDetail,
  ProxyHttpFlowDetail,
  ProxyHttpMessage,
  ProxyStreamMessage,
  ProxyWebSocketFlowDetail
} from "../../agent-tools/services/mitmproxy/flows";
import { useTuiStore } from "../context/store";
import { useTuiRuntime } from "../context/runtime";
import type { CenterSurfaceFrame } from "../store";
import { inferFiletype } from "../filetype";
import { truncateLine } from "../renderers";
import { syntax } from "../syntax";
import { COLOR } from "../theme";

type CenterSurfaceViewProps = {
  frame: CenterSurfaceFrame;
};

export function CenterSurfaceView(props: CenterSurfaceViewProps): JSX.Element {
  const tui = useTuiStore();
  const loader = createSurfaceLoader(() => props.frame);
  const title = () => surfaceTitle(props.frame);
  const kindLabel = () => props.frame.kind;
  let scrollRef!: ScrollBoxRenderable;
  let lastScrollSequence = 0;

  createEffect(() => {
    const request = tui.store.ui.centerScroll;
    if (request.sequence === 0 || request.sequence === lastScrollSequence) return;
    lastScrollSequence = request.sequence;
    if (!scrollRef || untrack(() => props.frame.kind) === "proxy_flow") return;
    applyScroll(scrollRef, request.action);
  });

  return (
    <box
      style={{
        flexGrow: 1,
        minHeight: 0,
        flexDirection: "column",
        paddingTop: 1,
        paddingBottom: 1,
        paddingLeft: 2,
        paddingRight: 2
      }}
    >
      <box style={{ height: 1, flexDirection: "row", justifyContent: "space-between" }}>
        <box style={{ flexDirection: "row", minWidth: 0 }}>
          <text fg={COLOR.accent}>{"› "}</text>
          <text fg={COLOR.text}>{truncateLine(title(), 96)}</text>
        </box>
        <text fg={COLOR.dim}>{kindLabel()}</text>
      </box>
      <box style={{ height: 1 }}>
        <text fg={COLOR.dim}>{surfaceSubtitle(props.frame)}</text>
      </box>
      <Show when={props.frame.kind === "proxy_flow"} fallback={
        <scrollbox ref={scrollRef} scrollbarOptions={{ visible: false }} style={{ flexGrow: 1, minHeight: 0, paddingTop: 1, paddingBottom: 1 }}>
          <Show when={loader.filetype() === "markdown"} fallback={
            <code content={loader.body()} filetype={loader.filetype()} syntaxStyle={syntax()} fg={COLOR.text} />
          }>
            <markdown content={loader.body()} streaming={false} syntaxStyle={syntax()} tableOptions={{ style: "grid" }} fg={COLOR.markdownText} />
          </Show>
        </scrollbox>
      }>
        <ProxyFlowSplitView flow={(props.frame as Extract<CenterSurfaceFrame, { kind: "proxy_flow" }>).flow} />
      </Show>
    </box>
  );
}

export function centerSurfaceFooter(frame: CenterSurfaceFrame): string {
  switch (frame.kind) {
    case "report":
      return "s save · esc back";
    case "container":
      return "t toggle · r refresh · esc back";
    case "confirm":
      return `${frame.confirmLabel ?? "enter ok"} · ${frame.cancelLabel ?? "esc cancel"}`;
    case "proxy_flow":
      return frame.flow.kind === "websocket"
        ? "h handshake · m messages · [ ]/tab pane · p/n message · esc back"
        : `[ ]/tab pane · ${flowPanelLabels(frame.flow)} · esc back`;
    case "alert":
    case "detail":
      return "esc back";
  }
}

function createSurfaceLoader(frame: () => CenterSurfaceFrame): { body: () => string; filetype: () => string } {
  const tui = useTuiStore();
  const { port } = useTuiRuntime();
  const [body, setBody] = createSignal("");
  const [filetype, setFiletype] = createSignal("markdown");
  let loadId = 0;

  createEffect(() => {
    const current = frame();
    const id = ++loadId;
    setFiletype(current.kind === "container" ? "json" : "markdown");

    if (current.kind === "proxy_flow") {
      setBody("");
      return;
    }

    if (current.kind === "report") {
      const sessionId = tui.store.activeSessionId;
      if (!sessionId) {
        setBody("no active session");
        return;
      }
      setBody("loading report…");
      void port.exportReport(sessionId)
        .then((result) => { if (id === loadId) setBody(result.markdown); })
        .catch((error) => { if (id === loadId) setBody(error instanceof Error ? error.message : String(error)); });
      return;
    }

    if (current.kind === "container") {
      void current.refreshToken;
      setBody("loading container status…");
      void port.containerStatus()
        .then((status) => { if (id === loadId) setBody(JSON.stringify(status, null, 2)); })
        .catch((error) => { if (id === loadId) setBody(error instanceof Error ? error.message : String(error)); });
      return;
    }

    setBody("body" in current ? current.body : "");
  });

  return { body, filetype };
}

function surfaceTitle(frame: CenterSurfaceFrame): string {
  switch (frame.kind) {
    case "detail":
    case "alert":
    case "confirm":
      return frame.title;
    case "proxy_flow":
      return `${frame.flow.method} ${frame.flow.status ?? "-"} ${frame.flow.host}`;
    case "report":
      return "report preview";
    case "container":
      return "runtime container";
  }
}

function surfaceSubtitle(frame: CenterSurfaceFrame): string {
  switch (frame.kind) {
    case "report":
      return "markdown report for the active session";
    case "container":
      return "live docker/container status";
    case "confirm":
      return "confirm the pending action";
    case "proxy_flow":
      return frame.flow.url;
    case "alert":
      return "attention required";
    case "detail":
      return "";
  }
}

export function ProxyFlowSplitView(props: { flow: ProxyFlowDetail; compact?: boolean }): JSX.Element {
  return (
    <Show
      when={props.flow.kind === "websocket"}
      fallback={<ProxyPanelPair flow={props.flow} {...(props.compact === undefined ? {} : { compact: props.compact })} />}
    >
      <WebSocketFlowView flow={props.flow as ProxyWebSocketFlowDetail} {...(props.compact === undefined ? {} : { compact: props.compact })} />
    </Show>
  );
}

function ProxyPanelPair(props: { flow: ProxyFlowDetail; compact?: boolean }): JSX.Element {
  const tui = useTuiStore();
  const dims = useTerminalDimensions();
  const horizontal = () => dims().width >= 112;
  const panels = () => proxyFlowPanels(props.flow);
  let requestScroll!: ScrollBoxRenderable;
  let responseScroll!: ScrollBoxRenderable;
  let lastScrollSequence = 0;

  createEffect(() => {
    const request = tui.store.ui.centerScroll;
    if (request.sequence === 0 || request.sequence === lastScrollSequence) return;
    lastScrollSequence = request.sequence;
    const activeScroll = untrack(() => tui.store.ui.proxyDetailPane) === 0 ? requestScroll : responseScroll;
    if (activeScroll) applyScroll(activeScroll, request.action);
  });

  return (
    <box style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, flexDirection: horizontal() ? "row" : "column", paddingTop: props.compact ? 0 : 1 }}>
      <FlowMessagePanel
        panel={panels()[0]}
        active={tui.store.ui.proxyDetailPane === 0}
        flexGrow={proxyPanelWeight(props.flow, 0)}
        rightPadding={horizontal()}
        bottomPadding={!horizontal()}
        compact={props.compact === true}
        onActivate={() => tui.actions.proxyDetailPaneSet(0)}
        setScrollRef={(ref) => { requestScroll = ref; }}
      />
      <FlowMessagePanel
        panel={panels()[1]}
        active={tui.store.ui.proxyDetailPane === 1}
        flexGrow={proxyPanelWeight(props.flow, 1)}
        rightPadding={false}
        bottomPadding={false}
        compact={props.compact === true}
        onActivate={() => tui.actions.proxyDetailPaneSet(1)}
        setScrollRef={(ref) => { responseScroll = ref; }}
      />
    </box>
  );
}

function WebSocketFlowView(props: { flow: ProxyWebSocketFlowDetail; compact?: boolean }): JSX.Element {
  const tui = useTuiStore();
  const dims = useTerminalDimensions();
  let requestScroll!: ScrollBoxRenderable;
  let responseScroll!: ScrollBoxRenderable;
  let messageScroll!: ScrollBoxRenderable;
  let payloadScroll!: ScrollBoxRenderable;
  let activeFlowId = "";
  let lastScrollSequence = 0;
  const selectedIndex = createMemo(() => Math.min(
    Math.max(0, tui.store.ui.proxyWebSocketMessageIndex),
    Math.max(0, props.flow.messages.length - 1)
  ));
  const selectedMessage = createMemo(() => props.flow.messages[selectedIndex()]);
  const contentWidth = () => Math.max(36, dims().width - (props.compact ? 4 : 8));
  const inspectorGap = () => dims().height >= 22 ? 1 : 0;

  createEffect(() => {
    const flowId = props.flow.id;
    const maxIndex = Math.max(0, props.flow.messages.length - 1);
    if (flowId !== activeFlowId) {
      activeFlowId = flowId;
      tui.actions.proxyWebSocketMessageSet(0);
      return;
    }
    if (tui.store.ui.proxyWebSocketMessageIndex > maxIndex) tui.actions.proxyWebSocketMessageSet(maxIndex);
  });

  createEffect(() => {
    const request = tui.store.ui.centerScroll;
    if (request.sequence === 0 || request.sequence === lastScrollSequence) return;
    lastScrollSequence = request.sequence;
    const section = untrack(() => tui.store.ui.proxyWebSocketSection);
    const pane = untrack(() => tui.store.ui.proxyDetailPane);
    const activeScroll = section === 0
      ? pane === 0 ? requestScroll : responseScroll
      : pane === 0 ? messageScroll : payloadScroll;
    if (activeScroll) applyScroll(activeScroll, request.action);
  });

  createEffect(() => {
    const index = selectedIndex();
    const flowId = props.flow.id;
    queueMicrotask(() => {
      if (!messageScroll) return;
      try { messageScroll.scrollChildIntoView(`ws-frame-${flowId}-${index}`); } catch {}
    });
  });

  return (
    <box style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, flexDirection: "column", paddingTop: props.compact ? 0 : 1 }}>
      <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
        <text
          fg={tui.store.ui.proxyWebSocketSection === 0 ? COLOR.accent : COLOR.dim}
          onMouseUp={() => tui.actions.proxyWebSocketSectionSet(0)}
        >{tui.store.ui.proxyWebSocketSection === 0 ? "› [h] handshake" : "  [h] handshake"}</text>
        <text fg={COLOR.dim}>{"   "}</text>
        <text
          fg={tui.store.ui.proxyWebSocketSection === 1 ? COLOR.accent : COLOR.dim}
          onMouseUp={() => tui.actions.proxyWebSocketSectionSet(1)}
        >{`${tui.store.ui.proxyWebSocketSection === 1 ? "›" : " "} [m] messages (${props.flow.messages.length})`}</text>
      </box>
      <Show when={tui.store.ui.proxyWebSocketSection === 0} fallback={
        <box style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, flexDirection: "column", paddingTop: 1 }}>
          <box style={{ height: 1, flexShrink: 0 }} onMouseUp={() => tui.actions.proxyDetailPaneSet(0)}>
            <text fg={COLOR.dim}>{webSocketFrameHeader(contentWidth())}</text>
          </box>
          <scrollbox
            ref={messageScroll}
            scrollbarOptions={{ visible: false }}
            style={{ flexGrow: 2, flexShrink: 1, flexBasis: 0, minHeight: 3, flexDirection: "column" }}
          >
            <Show when={props.flow.messages.length > 0} fallback={<text fg={COLOR.dim}>No WebSocket messages captured.</text>}>
              <For each={props.flow.messages}>{(message, index) => (
                <box
                  id={`ws-frame-${props.flow.id}-${index()}`}
                  style={{ height: 1, flexShrink: 0 }}
                  onMouseUp={() => tui.actions.proxyWebSocketMessageSet(index())}
                >
                  <text fg={index() === selectedIndex() ? COLOR.accent : COLOR.text}>
                    {webSocketFrameRow(message, index(), index() === selectedIndex(), contentWidth())}
                  </text>
                </box>
              )}</For>
            </Show>
          </scrollbox>
          <Show when={inspectorGap() > 0}>
            <box style={{ height: 1, flexShrink: 0 }} />
          </Show>
          <box style={{ height: 1, flexShrink: 0, alignItems: "center" }}>
            <text fg={COLOR.border}>{"─".repeat(contentWidth())}</text>
          </box>
          <Show when={inspectorGap() > 0}>
            <box style={{ height: 1, flexShrink: 0 }} />
          </Show>
          <box style={{ height: 1, flexShrink: 0, flexDirection: "row", justifyContent: "space-between" }} onMouseUp={() => tui.actions.proxyDetailPaneSet(1)}>
            <text fg={tui.store.ui.proxyDetailPane === 1 ? COLOR.accent : COLOR.text}>{truncateLine(webSocketMessageTitle(selectedMessage(), selectedIndex()), Math.max(12, contentWidth() - 12))}</text>
            <text fg={COLOR.dim}>{webSocketMessageFiletype(selectedMessage())}</text>
          </box>
          <scrollbox
            ref={payloadScroll}
            scrollbarOptions={{ visible: false }}
            style={{ flexGrow: 3, flexShrink: 1, flexBasis: 0, minHeight: 2, paddingTop: 1 }}
          >
            <code
              content={webSocketFramePayload(selectedMessage())}
              filetype={webSocketMessageFiletype(selectedMessage())}
              syntaxStyle={syntax()}
              fg={COLOR.text}
            />
          </scrollbox>
        </box>
      }>
        <box style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, flexDirection: dims().width >= 112 ? "row" : "column", paddingTop: 1 }}>
          <FlowMessagePanel
            panel={{ title: "request", content: renderWebSocketRequest(props.flow), filetype: "http" }}
            active={tui.store.ui.proxyDetailPane === 0}
            flexGrow={1}
            rightPadding={dims().width >= 112}
            bottomPadding={dims().width < 112}
            compact={props.compact === true}
            onActivate={() => tui.actions.proxyDetailPaneSet(0)}
            setScrollRef={(ref) => { requestScroll = ref; }}
          />
          <FlowMessagePanel
            panel={{ title: "response", content: renderWebSocketResponse(props.flow), filetype: "http" }}
            active={tui.store.ui.proxyDetailPane === 1}
            flexGrow={1}
            rightPadding={false}
            bottomPadding={false}
            compact={props.compact === true}
            onActivate={() => tui.actions.proxyDetailPaneSet(1)}
            setScrollRef={(ref) => { responseScroll = ref; }}
          />
        </box>
      </Show>
    </box>
  );
}

type FlowPanel = { title: string; content: string; filetype: string };

function FlowMessagePanel(props: {
  panel: FlowPanel;
  active: boolean;
  flexGrow: number;
  rightPadding: boolean;
  bottomPadding: boolean;
  compact?: boolean;
  onActivate: () => void;
  setScrollRef: (ref: ScrollBoxRenderable) => void;
}): JSX.Element {
  return (
    <box style={{ flexGrow: props.flexGrow, flexShrink: 1, flexBasis: 0, minWidth: 0, minHeight: 0, flexDirection: "column", paddingRight: props.rightPadding ? props.compact ? 3 : 4 : 0, paddingBottom: props.bottomPadding ? props.compact ? 1 : 2 : 0 }}>
      <box style={{ height: 1, flexShrink: 0, flexDirection: "row", justifyContent: "space-between" }} onMouseUp={props.onActivate}>
        <text fg={props.active ? COLOR.accent : COLOR.text}>{props.active ? `› ${props.panel.title}` : `  ${props.panel.title}`}</text>
        <text fg={COLOR.dim}>{props.panel.filetype}</text>
      </box>
      <scrollbox ref={props.setScrollRef} scrollbarOptions={{ visible: false }} style={{ flexGrow: 1, minHeight: 0, paddingTop: 1 }}>
        <code content={props.panel.content} filetype={props.panel.filetype} syntaxStyle={syntax()} fg={COLOR.text} />
      </scrollbox>
    </box>
  );
}

export function proxyPanelWeight(flow: ProxyFlowDetail, pane: 0 | 1): number {
  if (flow.kind !== "websocket") return 1;
  return pane === 0 ? 2 : 3;
}

function applyScroll(scroll: ScrollBoxRenderable, action: "up" | "down" | "pageUp" | "pageDown" | "home" | "end"): void {
  switch (action) {
    case "up": scroll.scrollBy(-1, "step"); break;
    case "down": scroll.scrollBy(1, "step"); break;
    case "pageUp": scroll.scrollBy(-1, "viewport"); break;
    case "pageDown": scroll.scrollBy(1, "viewport"); break;
    case "home": scroll.scrollTo(0); break;
    case "end": scroll.scrollTo(scroll.scrollHeight); break;
  }
}

function proxyFlowPanels(flow: ProxyFlowDetail): [FlowPanel, FlowPanel] {
  if (flow.kind === "http") {
    return [
      { title: "request", content: renderHttpRequest(flow), filetype: inferMessageFiletype(flow.request) },
      { title: "response", content: renderHttpResponse(flow), filetype: inferMessageFiletype(flow.response) }
    ];
  }
  if (flow.kind === "websocket") {
    return [
      { title: "request", content: renderWebSocketRequest(flow), filetype: "http" },
      { title: "response", content: renderWebSocketResponse(flow), filetype: "http" }
    ];
  }
  if (flow.kind === "tcp" || flow.kind === "udp") {
    const route = `${flow.client?.label ?? "client"} -> ${flow.server?.label ?? flow.host}`;
    const reverseRoute = `${flow.server?.label ?? flow.host} -> ${flow.client?.label ?? "client"}`;
    return [
      { title: route, content: renderDirectionalMessages(flow.messages, "client"), filetype: "text" },
      { title: reverseRoute, content: renderDirectionalMessages(flow.messages, "server"), filetype: "text" }
    ];
  }
  return [
    { title: "query", content: renderDnsMessage(flow.request), filetype: "text" },
    { title: "response", content: flow.response ? renderDnsMessage(flow.response) : flow.error ?? "no DNS response captured.", filetype: "text" }
  ];
}

function flowPanelLabels(flow: ProxyFlowDetail): string {
  if (flow.kind === "http") return "request / response";
  if (flow.kind === "websocket") return "handshake / message timeline";
  if (flow.kind === "tcp" || flow.kind === "udp") return "client→server / server→client";
  return "DNS query / records";
}

function renderHttpRequest(flow: ProxyHttpFlowDetail): string {
  return [
    `${flow.method} ${flow.path || "/"} ${flow.request.httpVersion ?? "HTTP/1.1"}`,
    ...headerLines(flow.request),
    "",
    messageBody(flow.request)
  ].join("\n");
}

function renderHttpResponse(flow: ProxyHttpFlowDetail): string {
  if (!flow.response) return flow.error ? `error: ${flow.error}` : "no response captured.";
  return [
    `${flow.response.httpVersion ?? "HTTP/1.1"} ${flow.response.status ?? flow.status ?? "-"} ${flow.response.reason ?? ""}`.trimEnd(),
    ...headerLines(flow.response),
    "",
    messageBody(flow.response)
  ].join("\n");
}

function renderWebSocketRequest(flow: ProxyWebSocketFlowDetail): string {
  return [
    `GET ${flow.path || "/"} ${flow.handshake.request.httpVersion ?? "HTTP/1.1"}`,
    ...headerLines(flow.handshake.request),
    "",
    messageBody(flow.handshake.request)
  ].join("\n").trimEnd();
}

function renderWebSocketResponse(flow: ProxyWebSocketFlowDetail): string {
  if (!flow.handshake.response) return flow.error ? `error: ${flow.error}` : "no handshake response captured.";
  return [
    `${flow.handshake.response.httpVersion ?? "HTTP/1.1"} ${flow.handshake.response.status ?? flow.status ?? 101} ${flow.handshake.response.reason ?? "Switching Protocols"}`,
    ...headerLines(flow.handshake.response),
    "",
    messageBody(flow.handshake.response)
  ].join("\n").trimEnd();
}

export function webSocketFrameHeader(width: number): string {
  const previewWidth = Math.max(8, width - (width >= 76 ? 43 : 30));
  if (width >= 76) return truncateLine(`  ${fitCell("#", 5)}${fitCell("time", 13)}${fitCell("dir", 6)}${fitCell("type", 9)}${fitCell("length", 8)}${fitCell("payload", previewWidth)}`, width);
  return truncateLine(`  ${fitCell("#", 5)}${fitCell("dir", 6)}${fitCell("type", 9)}${fitCell("length", 8)}${fitCell("payload", previewWidth)}`, width);
}

export function webSocketFrameRow(message: ProxyStreamMessage, index: number, selected: boolean, width: number): string {
  const previewWidth = Math.max(8, width - (width >= 76 ? 43 : 30));
  const marker = selected ? "> " : "  ";
  const number = fitCell(`#${index + 1}`, 5);
  const direction = fitCell(message.direction === "client" ? "C→S" : "S→C", 6);
  const type = fitCell(webSocketMessageType(message), 9);
  const length = fitCell(formatWebSocketBytes(message.contentBytes), 8);
  const preview = fitCell(webSocketMessagePreview(message), previewWidth);
  if (width >= 76) return truncateLine(`${marker}${number}${fitCell(webSocketMessageTime(message.timestamp), 13)}${direction}${type}${length}${preview}`, width);
  return truncateLine(`${marker}${number}${direction}${type}${length}${preview}`, width);
}

export function webSocketFramePayload(message: ProxyStreamMessage | undefined): string {
  if (!message) return "select a WebSocket message to inspect its payload.";
  const content = message.contentText ?? (message.contentBase64 ? `[binary base64 preview]\n${message.contentBase64}` : "[content unavailable]");
  return message.truncated ? `${content}\n\n[message truncated]` : content;
}

function webSocketMessageTitle(message: ProxyStreamMessage | undefined, index: number): string {
  if (!message) return "no message selected";
  const direction = message.direction === "client" ? "client → server" : "server → client";
  return `#${index + 1} · ${direction} · ${formatWebSocketBytes(message.contentBytes)} · ${webSocketMessageType(message)} · ${message.timestamp}`;
}

function webSocketMessageFiletype(message: ProxyStreamMessage | undefined): string {
  const text = message?.contentText?.trim();
  if (!text) return "text";
  try {
    JSON.parse(text);
    return "json";
  } catch {
    return "text";
  }
}

function webSocketMessageType(message: ProxyStreamMessage): string {
  return message.messageType ?? (message.contentBase64 ? "binary" : "text");
}

function webSocketMessagePreview(message: ProxyStreamMessage): string {
  const content = message.contentText ?? (message.contentBase64 ? `[binary] ${message.contentBase64}` : "[content unavailable]");
  const preview = content.replace(/\s+/g, " ").trim();
  const flags = [message.injected ? "injected" : "", message.dropped ? "dropped" : ""].filter(Boolean);
  return flags.length > 0 ? `[${flags.join(",")}] ${preview}` : preview;
}

function webSocketMessageTime(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(11, 23);
  return timestamp;
}

function formatWebSocketBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes}b`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(bytes < 10_000 ? 1 : 0)}kb`;
  return `${(bytes / 1_000_000).toFixed(1)}mb`;
}

function fitCell(value: string, width: number): string {
  return truncateLine(value, Math.max(1, width - 1)).padEnd(width);
}

function renderDirectionalMessages(messages: ProxyStreamMessage[], direction: ProxyStreamMessage["direction"]): string {
  const selected = messages.filter((message) => message.direction === direction);
  if (selected.length === 0) return "no messages captured in this direction.";
  return selected.map((message, index) => renderStreamMessage(message, index)).join("\n\n");
}

function renderStreamMessage(message: ProxyStreamMessage, index: number): string {
  const direction = message.direction === "client" ? "client -> server" : "server -> client";
  const flags = [message.messageType, message.injected ? "injected" : undefined, message.dropped ? "dropped" : undefined]
    .filter((value): value is string => Boolean(value));
  const header = `#${index + 1} ${message.timestamp} ${direction} ${message.contentBytes} bytes${flags.length > 0 ? ` [${flags.join(", ")}]` : ""}`;
  const content = message.contentText ?? (message.contentBase64 ? `[binary base64 preview]\n${message.contentBase64}` : "[content unavailable]");
  return `${header}\n${content}${message.truncated ? "\n[message truncated]" : ""}`;
}

function renderDnsMessage(message: ProxyDnsMessage): string {
  const lines = [
    `id: ${message.id ?? "-"}`,
    `kind: ${message.query ? "query" : "response"}`,
    ...(message.responseCode !== undefined ? [`response code: ${message.responseCode}`] : []),
    "",
    "questions:",
    ...dnsQuestionLines(message),
    "",
    "answers:",
    ...dnsRecordLines(message.answers),
    "",
    "authorities:",
    ...dnsRecordLines(message.authorities),
    "",
    "additionals:",
    ...dnsRecordLines(message.additionals)
  ];
  return lines.join("\n");
}

function dnsQuestionLines(message: ProxyDnsMessage): string[] {
  if (message.questions.length === 0) return ["  (none)"];
  return message.questions.map((question) => `  ${question.name} ${question.class ?? ""} ${question.type ?? ""}`.trimEnd());
}

function dnsRecordLines(records: ProxyDnsMessage["answers"]): string[] {
  if (records.length === 0) return ["  (none)"];
  return records.map((record) => `  ${record.name} ${record.ttl ?? ""} ${record.class ?? ""} ${record.type ?? ""} ${record.data ?? ""}`.trimEnd());
}

function headerLines(message: ProxyHttpMessage): string[] {
  return message.headers.map((header) => `${header.name}: ${header.value}`);
}

function messageBody(message: ProxyHttpMessage | undefined): string {
  if (!message) return "";
  const suffix = message.bodyTruncated ? "\n\n[body truncated]" : "";
  if (message.bodyText !== undefined) return `${message.bodyText}${suffix}`;
  if (message.bodyBase64) return `[binary body base64 preview]\n${message.bodyBase64}${suffix}`;
  if (message.bodyBytes && message.bodyBytes > 0) return `[${message.bodyBytes} bytes body not available]`;
  return "";
}

function inferMessageFiletype(message: ProxyHttpMessage | undefined): string {
  if (!message) return "text";
  if (message.bodyBase64 && !message.bodyText) return "text";
  const contentType = message.headers.find((header) => header.name.toLowerCase() === "content-type")?.value;
  return inferFiletype(undefined, contentType);
}
