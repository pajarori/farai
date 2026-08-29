import type { BackgroundActivitySummary, SubagentActivity } from "../runtime-port";
import type { BrowserContextActivity } from "../../agent-tools/browser/context-manager";
import type { ContextUsage } from "../store";
import type { TimelineRow } from "../renderers";
import { terminalWidth, truncateTerminal } from "../terminal-text";

export type FooterMode =
  | "history_search"
  | "shortcut_overlay"
  | "quit_hint"
  | "esc_hint"
  | "composer_empty"
  | "composer_has_draft"
  | "running";

export type FooterState = {
  mode: FooterMode;
  draft: string;
  isRunning: boolean;
  queueSize: number;
  elapsed: string;
  historyQuery?: string;
  historyMatches?: number;
  context: string;
};

export type FooterItem = {
  id: string;
  kind: "context" | "agents" | "browsers" | "background" | "queue" | "message";
  text: string;
  count?: number;
};

export type BottomPaneSlot = "list_overlay" | "center_surface" | "proxy_tab" | "composer";

export function activityStatusVisible(activeMainTab: "chat" | "proxy"): boolean {
  return activeMainTab === "chat";
}

export function transcriptOwnsActivity(rows: readonly TimelineRow[]): boolean {
  let lastUserIndex = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.kind !== "user") continue;
    lastUserIndex = index;
    break;
  }
  return rows.slice(lastUserIndex + 1).some((row) => {
    if (row.kind === "assistant" || row.kind === "thinking" || row.kind === "plan") return row.streaming;
    if (row.kind === "tool") return row.status === "running" || row.status === "pending";
    if (row.kind === "exploration") return row.status === "running";
    if (row.kind === "progress") return row.status === "running";
    return false;
  });
}

export function isTranscriptActivityDetail(detail: string | undefined): boolean {
  return detail === "thinking"
    || detail === "planning"
    || detail === "reading tool result"
    || detail === "running tool"
    || Boolean(detail?.startsWith("running "));
}

export function bottomPaneSlot(input: {
  hasListFrame: boolean;
  hasCenterFrame: boolean;
  activeMainTab: "chat" | "proxy";
}): BottomPaneSlot {
  if (input.hasListFrame) return "list_overlay";
  if (input.hasCenterFrame) return "center_surface";
  if (input.activeMainTab === "proxy") return "proxy_tab";
  return "composer";
}

export function instructionalFooterLines(state: FooterState): string[] {
  switch (state.mode) {
    case "history_search":
      return [`reverse-i-search: ${state.historyQuery ?? ""} (${state.historyMatches ?? 0} matches)`];
    case "shortcut_overlay":
      return [
        "ctrl+r history   ctrl+g editor   ctrl+t transcript   ctrl+o copy"
      ];
    case "quit_hint":
      return ["press ctrl+c again to quit"];
    case "esc_hint":
      return ["press esc again to interrupt, or ctrl+c to quit when the composer is empty"];
    case "running":
      return [""];
    case "composer_has_draft":
      return [""];
    case "composer_empty":
      return [""];
  }
}

export function contextualFooter(state: FooterState): string {
  return state.context;
}

export function footerRightItems(
  backgroundActivities: BackgroundActivitySummary[],
  subagents: SubagentActivity[],
  browserContexts: BrowserContextActivity[],
  queueSize: number,
  statusDetail: string | undefined,
  contextUsage?: ContextUsage
): FooterItem[] {
  const items: FooterItem[] = [];
  if (contextUsage && contextUsage.tokens >= 0) {
    items.push({
      id: "context",
      kind: "context",
      text: contextUsage.budget
        ? `ctx ${shortTokens(contextUsage.tokens)}/${shortTokens(contextUsage.budget)}`
        : `ctx ${shortTokens(contextUsage.tokens)}`
    });
  }
  const activeAgents = subagents.filter((item) => ["created", "starting", "running", "cancelling"].includes(item.status)).length;
  if (activeAgents > 0) {
    items.push({
      id: "agents",
      kind: "agents",
      text: `${activeAgents} agent${activeAgents === 1 ? "" : "s"}`,
      count: activeAgents
    });
  }
  const activeBrowsers = browserContexts.filter((item) => ["starting", "ready", "busy", "closing"].includes(item.status)).length;
  if (activeBrowsers > 0) {
    items.push({
      id: "browsers",
      kind: "browsers",
      text: `${activeBrowsers} browser${activeBrowsers === 1 ? "" : "s"}`,
      count: activeBrowsers
    });
  }
  items.push(...backgroundActivities
    .filter((activity) => activity.count > 0 && activity.label.trim())
    .map((activity) => ({
      id: `background-${activity.label}`,
      kind: "background" as const,
      text: `${activity.count} ${activity.label.toLowerCase()}`,
      count: activity.count
    })));
  if (queueSize > 0) items.push({ id: "queue", kind: "queue", text: `${queueSize} queued`, count: queueSize });
  if (isFooterStatusDetail(statusDetail)) items.push({ id: "message", kind: "message", text: statusDetail! });
  return items;
}

export function isFooterStatusDetail(detail: string | undefined): detail is string {
  if (!detail) return false;
  if (detail.startsWith("large paste captured (")) return true;
  return FOOTER_STATUS_DETAILS.has(detail);
}

export function fitFooterLine(left: string, sourceItems: FooterItem[], width: number): { left: string; right: string } {
  if (width <= 0) return { left: "", right: "" };
  let items = sourceItems.filter((item) => item.text.trim());
  let right = joinItems(items);

  if (terminalWidth(right) > width) {
    const backgrounds = items.filter((item) => item.kind === "background");
    if (backgrounds.length > 1) {
      const total = backgrounds.reduce((sum, item) => sum + (item.count ?? 0), 0);
      const firstBackground = items.findIndex((item) => item.kind === "background");
      items = items.filter((item) => item.kind !== "background");
      items.splice(firstBackground, 0, { id: "background-total", kind: "background", text: `${total} bg`, count: total });
      right = joinItems(items);
    }
  }

  if (terminalWidth(right) > width) {
    const messageIndex = items.findIndex((item) => item.kind === "message");
    if (messageIndex >= 0) {
      const withoutMessage = items.filter((_, index) => index !== messageIndex);
      const fixed = joinItems(withoutMessage);
      const available = Math.max(0, width - terminalWidth(fixed) - (fixed ? 3 : 0));
      if (available > 0) items[messageIndex] = { ...items[messageIndex]!, text: truncateToWidth(items[messageIndex]!.text, available) };
      else items.splice(messageIndex, 1);
      right = joinItems(items);
    }
  }

  if (terminalWidth(right) > width) right = truncateToWidth(right, width);
  if (!right) return { left: truncateToWidth(left, width), right: "" };

  const availableLeft = Math.max(0, width - terminalWidth(right) - 3);
  return {
    left: truncateToWidth(left, availableLeft),
    right
  };
}

const FOOTER_STATUS_DETAILS = new Set([
  "conversation cleared",
  "loading proxy flow",
  "loading transcript",
  "copied selection",
  "copied last response",
  "nothing to copy",
  "copy failed"
]);

function joinItems(items: FooterItem[]): string {
  return items.map((item) => item.text).filter(Boolean).join(" · ");
}

function truncateToWidth(value: string, width: number): string {
  return truncateTerminal(value, width);
}

function shortTokens(value: number): string {
  if (value < 1_000) return String(Math.max(0, Math.round(value)));
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}m`;
  return `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2).replace(/\.0$/, "")}k`;
}
