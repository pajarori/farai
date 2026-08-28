

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
  | { kind: "transcript.open" };

export type RouteResult =
  | { type: "consumed"; actions: RouterAction[] }
  | { type: "passthrough" };

export type RouterContext = {

  overlayKind: OverlayKind | undefined;

  centerSurfaceKind?: CenterSurfaceKind | undefined;

  running: boolean;
  cancelable?: boolean;

  composerText: string;
  composerCursor?: number;

  slashSuppressed: boolean;
  historySearchActive?: boolean;
  queuedCount?: number;
  activeMainTab?: "chat" | "proxy";
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
  if (ctx.overlayKind || ctx.centerSurfaceKind || ctx.slashSuppressed) return false;
  const text = ctx.composerText;
  return text.startsWith("/") && !text.includes(" ") && !text.includes("\n");
}

export function routeKey(key: KeyToken, ctx: RouterContext): RouteResult {
  if (ctx.overlayKind) return routeOverlay(key, ctx.overlayKind);
  if (ctx.centerSurfaceKind) return routeCenterSurface(key, ctx.centerSurfaceKind);
  if (ctx.historySearchActive) return routeHistorySearch(key);
  if (slashActive(ctx)) {
    const slash = routeSlash(key);
    if (slash) return slash;

  }
  return routeBase(key, ctx);
}

function routeOverlay(key: KeyToken, kind: OverlayKind): RouteResult {
  if (key.ctrl && key.name === "c") return consumed({ kind: "overlay.pop" });
  if (key.name === "escape") return consumed({ kind: "overlay.pop" });

  if (isListOverlay(kind)) {
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

function routeCenterSurface(key: KeyToken, kind: CenterSurfaceKind): RouteResult {
  if (key.ctrl && key.name === "c") return consumed({ kind: "center.pop" });
  if (key.name === "escape") return consumed({ kind: "center.pop" });
  if (kind === "proxy_flow") {
    if (key.name === "left" || key.name === "[") return consumed({ kind: "proxy.detailPaneMove", delta: -1 });
    if (key.name === "right" || key.name === "]") return consumed({ kind: "proxy.detailPaneMove", delta: 1 });
    if (key.name === "tab") return consumed({ kind: "proxy.detailPaneMove", delta: 1 });
    if (key.name === "h") return consumed({ kind: "proxy.detailPaneSet", pane: 0 });
    if (key.name === "m") return consumed({ kind: "proxy.detailPaneSet", pane: 1 });
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
  switch (key.name) {
    case "up": return consumed({ kind: "slash.move", delta: -1 });
    case "down": return consumed({ kind: "slash.move", delta: 1 });
    case "return": return consumed({ kind: "slash.dispatch" });
    case "tab": case "/": return consumed({ kind: "slash.complete" });
    case "escape": return consumed({ kind: "slash.dismiss" });
    default: return undefined;
  }
}

function routeBase(key: KeyToken, ctx: RouterContext): RouteResult {
  if (key.ctrl) {
    switch (key.name) {
      case "1": return consumed({ kind: "mainTab.set", tab: "chat" });
      case "2": return consumed({ kind: "mainTab.set", tab: "proxy" });
      case "c": return consumed({ kind: "composer.clearOrExit" });
      case "r": return consumed({ kind: "composer.historySearchStart" });
      case "g": return consumed({ kind: "composer.externalEditor" });
      case "t": return consumed({ kind: "transcript.open" });
      case "o": return consumed({ kind: "composer.copyLast" });
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
    if (ctx.composerText.trimStart().startsWith("!")) return PASSTHROUGH;
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
  if (key.ctrl && key.name === "s") return consumed({ kind: "history.searchMove", delta: 1 });
  if (key.name === "escape") return consumed({ kind: "history.searchCancel" });
  if (key.name === "return") return consumed({ kind: "history.searchAccept" });
  if (key.name === "up") return consumed({ kind: "history.searchMove", delta: -1 });
  if (key.name === "down") return consumed({ kind: "history.searchMove", delta: 1 });
  if (key.name === "backspace") return consumed({ kind: "history.searchBackspace" });
  if (key.char !== undefined) return consumed({ kind: "history.searchAppend", char: key.char });
  return consumed();
}
