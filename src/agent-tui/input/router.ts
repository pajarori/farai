import { slashPopupVisible } from "../slash-autocomplete";

export type OverlayKind =
  | "palette"
  | "sessions"
  | "evidence"
  | "findings"
  | "memory"
  | "agents"
  | "model"
  | "mcp"
  | "detail"
  | "report"
  | "container";

export type CenterSurfaceKind = "detail" | "alert" | "confirm" | "proxy_flow" | "report" | "container";

const LIST_OVERLAYS: ReadonlySet<OverlayKind> = new Set([
  "palette",
  "sessions",
  "evidence",
  "findings",
  "memory",
  "agents",
  "model",
  "mcp"
]);

export function isListOverlay(kind: OverlayKind): boolean {
  return LIST_OVERLAYS.has(kind);
}

export type RouterAction =
  | { kind: "composer.submit" }
  | { kind: "composer.queue" }
  | { kind: "composer.newline" }
  | { kind: "composer.clearOrExit" }
  | { kind: "composer.historySearchStart" }
  | { kind: "composer.historyNavigate"; direction: "older" | "newer" }
  | { kind: "composer.externalEditor" }
  | { kind: "composer.copyLast" }
  | { kind: "transcript.clear" }
  | { kind: "transcript.rawToggle" }
  | { kind: "mainTab.set"; tab: "chat" | "proxy" }
  | { kind: "proxy.filterSet"; filter: "all" | "http" | "websocket" }
  | { kind: "proxy.filterCycle"; delta: number }
  | { kind: "proxy.move"; delta: number }
  | { kind: "proxy.openSelected" }
  | { kind: "proxy.detailPaneSet"; pane: 0 | 1 }
  | { kind: "proxy.detailPaneMove"; delta: number }
  | { kind: "proxy.websocketSectionSet"; section: 0 | 1 }
  | { kind: "proxy.websocketMessageMove"; delta: number }
  | { kind: "queued.editLast" }
  | { kind: "turn.cancel" }
  | { kind: "overlay.open"; overlay: OverlayKind }
  | { kind: "overlay.pop" }
  | { kind: "overlay.select" }
  | { kind: "overlay.move"; delta: number }
  | { kind: "overlay.setIndex"; index: number }
  | { kind: "overlay.agentPreview" }
  | { kind: "overlay.appendQuery"; char: string }
  | { kind: "overlay.backspaceQuery" }
  | { kind: "center.pop" }
  | { kind: "center.scroll"; action: "up" | "down" | "pageUp" | "pageDown" | "home" | "end" }
  | { kind: "center.action"; action: string }
  | { kind: "slash.move"; delta: number }
  | { kind: "slash.complete" }
  | { kind: "slash.dispatch" }
  | { kind: "slash.dismiss" }
  | { kind: "history.searchAppend"; char: string }
  | { kind: "history.searchBackspace" }
  | { kind: "history.searchMove"; delta: number }
  | { kind: "history.searchAccept" }
  | { kind: "history.searchCancel" }
  | { kind: "message.nav"; direction: "next" | "prev" }
  | { kind: "footer.shortcutsToggle" }
  | { kind: "footer.escHint" }
  | { kind: "transcript.open" }
  | { kind: "requestUserInput.optionMove"; delta: number }
  | { kind: "requestUserInput.choose"; index?: number }
  | { kind: "requestUserInput.questionMove"; delta: number }
  | { kind: "requestUserInput.textModeEnter" }
  | { kind: "requestUserInput.textModeExit" }
  | { kind: "requestUserInput.commitText" }
  | { kind: "requestUserInput.dismiss" }
  | { kind: "requestUserInput.show" }
  | { kind: "requestUserInput.cancel" }
  | { kind: "modelProvider.next"; test?: boolean }
  | { kind: "modelProvider.back" }
  | { kind: "modelProvider.protocolMove"; delta: number }
  | { kind: "modelProvider.secretBackspace" }
  | { kind: "modelProvider.credentialRemove" }
  | { kind: "modelProviderRemoval.confirm" }
  | { kind: "modelProviderRemoval.cancel" }
  | { kind: "model.addProvider" }
  | { kind: "model.editProvider" }
  | { kind: "model.testProvider" }
  | { kind: "model.removeProvider" };

export type RouteResult =
  | { type: "consumed"; actions: RouterAction[] }
  | { type: "passthrough" };

export type RouterContext = {

  overlayKind: OverlayKind | undefined;

  centerSurfaceKind?: CenterSurfaceKind | undefined;
  centerProxyFlowKind?: "http" | "websocket" | "tcp" | "udp" | "dns" | undefined;
  centerSurfaceBusy?: boolean;

  running: boolean;
  cancelable?: boolean;

  composerText: string;
  composerCursor?: number;

  slashSuppressed: boolean;
  slashOptionCount?: number;
  historySearchActive?: boolean;
  queuedCount?: number;
  activeMainTab?: "chat" | "proxy";
  requestUserInput?: {
    textMode: boolean;
    canExitTextMode: boolean;
    optionCount: number;
    submitting: boolean;
  };
  pendingUserInput?: boolean;
  modelProviderWizard?: {
    field: "id" | "protocol" | "baseUrl" | "apiKey" | "model" | "review";
    busy: boolean;
    cancellable?: boolean;
  };
  modelProviderRemoval?: {
    busy: boolean;
  };
  modelOverlay?: {
    providerID?: string;
    removable: boolean;
  };
};

export type KeyToken = {

  name: string;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;

  char?: string;
};

const NAME_ALIASES: Record<string, string> = {
  enter: "return",
  esc: "escape",
  pgup: "pageup",
  pgdn: "pagedown",
  pgdown: "pagedown"
};

export function toKeyToken(e: {
  name: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  option?: boolean;
  sequence?: string;
}): KeyToken {
  const ctrl = Boolean(e.ctrl);
  const meta = Boolean(e.meta || e.option);
  let shift = Boolean(e.shift);
  const rawName = (e.name ?? "").toLowerCase();
  const name = rawName === "backtab" ? "tab" : NAME_ALIASES[rawName] ?? rawName;
  if (rawName === "backtab") shift = true;
  const token: KeyToken = { name, ctrl, shift, meta };

  const seq = e.sequence ?? "";
  if (!ctrl && !meta && seq.length === 1 && seq >= " ") {
    token.char = seq;
  } else if (!ctrl && !meta && name.length === 1 && name >= " ") {
    token.char = name;
  }
  return token;
}

const PASSTHROUGH: RouteResult = { type: "passthrough" };

function consumed(...actions: RouterAction[]): RouteResult {
  return { type: "consumed", actions };
}

export function slashActive(ctx: RouterContext): boolean {
  return slashPopupVisible(
    ctx.composerText,
    ctx.slashSuppressed,
    ctx.slashOptionCount ?? 1,
    Boolean(ctx.overlayKind || ctx.centerSurfaceKind)
  );
}

export function routeKey(key: KeyToken, ctx: RouterContext): RouteResult {
  if (ctx.modelProviderRemoval) return routeModelProviderRemoval(key, ctx.modelProviderRemoval);
  if (ctx.modelProviderWizard) return routeModelProviderWizard(key, ctx.modelProviderWizard);
  if (ctx.pendingUserInput && key.ctrl && key.name === "q") return consumed({ kind: "requestUserInput.show" });
  if (ctx.requestUserInput) return routeRequestUserInput(key, ctx.requestUserInput);
  if (ctx.overlayKind) return routeOverlay(key, ctx.overlayKind, ctx.modelOverlay);
  if (ctx.centerSurfaceKind) return routeCenterSurface(key, ctx.centerSurfaceKind, ctx.centerProxyFlowKind, ctx.centerSurfaceBusy);
  if (ctx.historySearchActive) return routeHistorySearch(key);
  if (slashActive(ctx)) {
    const slash = routeSlash(key);
    if (slash) return slash;

  }
  return routeBase(key, ctx);
}

function routeModelProviderRemoval(key: KeyToken, state: NonNullable<RouterContext["modelProviderRemoval"]>): RouteResult {
  if (state.busy) return consumed();
  if (key.name === "return") return consumed({ kind: "modelProviderRemoval.confirm" });
  if (key.name === "escape" || (key.ctrl && key.name === "c")) return consumed({ kind: "modelProviderRemoval.cancel" });
  return consumed();
}

function routeModelProviderWizard(key: KeyToken, state: NonNullable<RouterContext["modelProviderWizard"]>): RouteResult {
  if (state.busy) return key.name === "escape" && state.cancellable ? consumed({ kind: "modelProvider.back" }) : consumed();
  if (key.name === "escape") return consumed({ kind: "modelProvider.back" });
  if (state.field === "protocol") {
    if (key.name === "up" || key.name === "left") return consumed({ kind: "modelProvider.protocolMove", delta: -1 });
    if (key.name === "down" || key.name === "right") return consumed({ kind: "modelProvider.protocolMove", delta: 1 });
    if (key.name === "return") return consumed({ kind: "modelProvider.next" });
    return consumed();
  }
  if (state.field === "apiKey") {
    if (key.ctrl && key.name === "r") return consumed({ kind: "modelProvider.credentialRemove" });
    if (key.name === "backspace") return consumed({ kind: "modelProvider.secretBackspace" });
    if (key.name === "return") return consumed({ kind: "modelProvider.next" });
    return PASSTHROUGH;
  }
  if (state.field === "review") {
    if (key.ctrl && key.name === "s") return consumed({ kind: "modelProvider.next", test: false });
    if (key.name === "return") return consumed({ kind: "modelProvider.next", test: true });
    return consumed();
  }
  if (key.name === "return") return consumed({ kind: "modelProvider.next" });
  return PASSTHROUGH;
}

function routeRequestUserInput(key: KeyToken, state: NonNullable<RouterContext["requestUserInput"]>): RouteResult {
  if (state.submitting) return consumed();
  if (key.ctrl && key.name === "c") return consumed({ kind: "requestUserInput.dismiss" });
  if (key.ctrl && key.name === "x") return consumed({ kind: "requestUserInput.cancel" });
  if ((key.ctrl && key.name === "p") || key.name === "pageup") {
    return consumed({ kind: "requestUserInput.questionMove", delta: -1 });
  }
  if ((key.ctrl && key.name === "n") || key.name === "pagedown") {
    return consumed({ kind: "requestUserInput.questionMove", delta: 1 });
  }
  if (state.textMode) {
    if (key.name === "escape") return consumed({
      kind: state.canExitTextMode ? "requestUserInput.textModeExit" : "requestUserInput.dismiss"
    });
    if (key.name === "tab" && state.canExitTextMode) return consumed({ kind: "requestUserInput.textModeExit" });
    if (key.name === "return") return consumed({ kind: "requestUserInput.commitText" });
    return PASSTHROUGH;
  }
  switch (key.name) {
    case "escape": return consumed({ kind: "requestUserInput.dismiss" });
    case "up": return consumed({ kind: "requestUserInput.optionMove", delta: -1 });
    case "down": return consumed({ kind: "requestUserInput.optionMove", delta: 1 });
    case "left": return consumed({ kind: "requestUserInput.questionMove", delta: -1 });
    case "right": return consumed({ kind: "requestUserInput.questionMove", delta: 1 });
    case "tab":
    case "o": return consumed({ kind: "requestUserInput.textModeEnter" });
    case "return": return consumed({ kind: "requestUserInput.choose" });
    default: {
      const numeric = key.char && /^[1-9]$/.test(key.char) ? Number.parseInt(key.char, 10) - 1 : -1;
      if (numeric >= 0 && numeric < state.optionCount) return consumed({ kind: "requestUserInput.choose", index: numeric });
      return consumed();
    }
  }
}

function routeOverlay(key: KeyToken, kind: OverlayKind, model?: RouterContext["modelOverlay"]): RouteResult {
  if (key.ctrl && key.name === "c") return consumed({ kind: "overlay.pop" });
  if (key.name === "escape") return consumed({ kind: "overlay.pop" });

  if (isListOverlay(kind)) {
    if (kind === "model" && key.ctrl) {
      if (key.name === "a") return consumed({ kind: "model.addProvider" });
      if (key.name === "t" && model?.providerID) return consumed({ kind: "model.testProvider" });
      if (key.name === "e" && model?.providerID && model.removable) return consumed({ kind: "model.editProvider" });
      if (key.name === "d" && model?.providerID && model.removable) return consumed({ kind: "model.removeProvider" });
    }
    if (kind === "agents" && (key.name === "space" || key.char === " ")) {
      return consumed({ kind: "overlay.agentPreview" });
    }
    switch (key.name) {
      case "up": return consumed({ kind: "overlay.move", delta: -1 });
      case "down": return consumed({ kind: "overlay.move", delta: 1 });
      case "pageup": return consumed({ kind: "overlay.move", delta: -10 });
      case "pagedown": return consumed({ kind: "overlay.move", delta: 10 });
      case "home": return consumed({ kind: "overlay.setIndex", index: 0 });
      case "end": return consumed({ kind: "overlay.setIndex", index: Number.MAX_SAFE_INTEGER });
      case "return": return consumed({ kind: "overlay.select" });
      case "backspace": return consumed({ kind: "overlay.backspaceQuery" });
      default:
        if (key.char !== undefined) return consumed({ kind: "overlay.appendQuery", char: key.char });
        return consumed();
    }
  }

  return consumed();
}

function routeCenterSurface(
  key: KeyToken,
  kind: CenterSurfaceKind,
  proxyFlowKind?: RouterContext["centerProxyFlowKind"],
  busy = false
): RouteResult {
  if (key.ctrl && key.name === "c") return consumed({ kind: "center.pop" });
  if (key.name === "escape") return consumed({ kind: "center.pop" });
  if (busy) return consumed();
  if (kind === "proxy_flow") {
    if (key.name === "left" || key.name === "[") return consumed({ kind: "proxy.detailPaneMove", delta: -1 });
    if (key.name === "right" || key.name === "]") return consumed({ kind: "proxy.detailPaneMove", delta: 1 });
    if (key.name === "tab") return consumed({ kind: "proxy.detailPaneMove", delta: 1 });
    if (key.name === "h") return proxyFlowKind === "websocket"
      ? consumed({ kind: "proxy.websocketSectionSet", section: 0 })
      : consumed({ kind: "proxy.detailPaneSet", pane: 0 });
    if (key.name === "m") return proxyFlowKind === "websocket"
      ? consumed({ kind: "proxy.websocketSectionSet", section: 1 })
      : consumed({ kind: "proxy.detailPaneSet", pane: 1 });
    if (key.name === "p") return consumed({ kind: "proxy.websocketMessageMove", delta: -1 });
    if (key.name === "n") return consumed({ kind: "proxy.websocketMessageMove", delta: 1 });
  }
  switch (key.name) {
    case "up": case "k": return consumed({ kind: "center.scroll", action: "up" });
    case "down": case "j": return consumed({ kind: "center.scroll", action: "down" });
    case "pageup": return consumed({ kind: "center.scroll", action: "pageUp" });
    case "pagedown": return consumed({ kind: "center.scroll", action: "pageDown" });
    case "home": return consumed({ kind: "center.scroll", action: "home" });
    case "end": return consumed({ kind: "center.scroll", action: "end" });
  }

  switch (kind) {
    case "report":
      if (key.name === "s") return consumed({ kind: "center.action", action: "save" });
      break;
    case "container":
      if (key.name === "t") return consumed({ kind: "center.action", action: "toggle" });
      if (key.name === "r") return consumed({ kind: "center.action", action: "refresh" });
      break;
    case "confirm":
      if (key.name === "return") return consumed({ kind: "center.action", action: "confirm" });
      break;
    case "detail":
    case "alert":
    case "proxy_flow":
      break;
  }
  return consumed();
}

function routeSlash(key: KeyToken): RouteResult | undefined {
  if (key.ctrl && key.name === "p") return consumed({ kind: "slash.move", delta: -1 });
  if (key.ctrl && key.name === "n") return consumed({ kind: "slash.move", delta: 1 });
  if (key.name === "/" || key.name === "slash" || key.char === "/") return consumed({ kind: "slash.complete" });
  switch (key.name) {
    case "up": return consumed({ kind: "slash.move", delta: -1 });
    case "down": return consumed({ kind: "slash.move", delta: 1 });
    case "return": return consumed({ kind: "slash.dispatch" });
    case "tab": return consumed({ kind: "slash.complete" });
    case "escape": return consumed({ kind: "slash.dismiss" });
    default: return undefined;
  }
}

function routeBase(key: KeyToken, ctx: RouterContext): RouteResult {
  if (key.meta) {
    if (key.name === "1") return consumed({ kind: "mainTab.set", tab: "chat" });
    if (key.name === "2") return consumed({ kind: "mainTab.set", tab: "proxy" });
  }
  if (key.ctrl) {
    switch (key.name) {
      case "1": return consumed({ kind: "mainTab.set", tab: "chat" });
      case "2": return consumed({ kind: "mainTab.set", tab: "proxy" });
      case "c": return consumed({ kind: "composer.clearOrExit" });
      case "p": return consumed({ kind: "overlay.open", overlay: "palette" });
      case "r": return consumed({ kind: "composer.historySearchStart" });
      case "g": return consumed({ kind: "composer.externalEditor" });
      case "t": return consumed({ kind: "transcript.open" });
      case "o": return consumed({ kind: "composer.copyLast" });
      case "q": return PASSTHROUGH;
      case "l": return consumed({ kind: "transcript.clear" });
      default: return PASSTHROUGH;
    }
  }

  if (ctx.activeMainTab === "proxy") {
    switch (key.name) {
      case "left": case "[": return consumed({ kind: "proxy.filterCycle", delta: -1 });
      case "right": case "]": return consumed({ kind: "proxy.filterCycle", delta: 1 });
      case "a": return consumed({ kind: "proxy.filterSet", filter: "all" });
      case "h": return consumed({ kind: "proxy.filterSet", filter: "http" });
      case "w": return consumed({ kind: "proxy.filterSet", filter: "websocket" });
      case "up": case "k": return consumed({ kind: "proxy.move", delta: -1 });
      case "down": case "j": return consumed({ kind: "proxy.move", delta: 1 });
      case "return": return consumed({ kind: "proxy.openSelected" });
      case "tab": return consumed({ kind: "proxy.detailPaneMove", delta: 1 });
      case "p": return consumed({ kind: "proxy.websocketMessageMove", delta: -1 });
      case "n": return consumed({ kind: "proxy.websocketMessageMove", delta: 1 });
      default: break;
    }
  }

  if (key.meta) {
    if (key.name === "r") return consumed({ kind: "transcript.rawToggle" });
    if (key.name === "up") return consumed({ kind: "queued.editLast" });
    return PASSTHROUGH;
  }

  if (key.shift && key.name === "left") return consumed({ kind: "queued.editLast" });

  if (key.name === "return") {
    return key.shift
      ? consumed({ kind: "composer.newline" })
      : consumed({ kind: "composer.submit" });
  }
  if (key.name === "tab") {
    return consumed(ctx.running ? { kind: "composer.queue" } : { kind: "composer.submit" });
  }
  if (key.name === "up" && ctx.composerText.length === 0 && (ctx.queuedCount ?? 0) > 0) {
    return consumed({ kind: "queued.editLast" });
  }
  if (key.name === "up" && shouldHistoryNavigate(ctx, "older")) {
    return consumed({ kind: "composer.historyNavigate", direction: "older" });
  }
  if (key.name === "down" && shouldHistoryNavigate(ctx, "newer")) {
    return consumed({ kind: "composer.historyNavigate", direction: "newer" });
  }
  if (key.name === "escape") {
    if (ctx.cancelable ?? ctx.running) return consumed({ kind: "turn.cancel" });
    return consumed({ kind: "footer.escHint" });
  }
  if ((key.name === "?" || key.char === "?") && ctx.composerText.trim().length === 0) {
    return consumed({ kind: "footer.shortcutsToggle" });
  }
  return PASSTHROUGH;
}

function shouldHistoryNavigate(ctx: RouterContext, direction: "older" | "newer"): boolean {
  const text = ctx.composerText;
  const cursor = ctx.composerCursor ?? text.length;
  if (!text.includes("\n")) return true;
  return direction === "older" ? cursor === 0 : cursor >= text.length;
}

function routeHistorySearch(key: KeyToken): RouteResult {
  if (key.ctrl && key.name === "c") return consumed({ kind: "history.searchCancel" });
  if (key.ctrl && key.name === "r") return consumed({ kind: "history.searchMove", delta: 1 });
  if (key.ctrl && key.name === "s") return consumed({ kind: "history.searchMove", delta: -1 });
  if (key.name === "escape") return consumed({ kind: "history.searchCancel" });
  if (key.name === "return") return consumed({ kind: "history.searchAccept" });
  if (key.name === "up") return consumed({ kind: "history.searchMove", delta: 1 });
  if (key.name === "down") return consumed({ kind: "history.searchMove", delta: -1 });
  if (key.name === "backspace") return consumed({ kind: "history.searchBackspace" });
  if (key.char !== undefined) return consumed({ kind: "history.searchAppend", char: key.char });
  return consumed();
}
