export const GLYPH = {
  user: "› ",
  assistantIndent: "  ",
  thinking: "• thinking",
  toolShell: "•",
  toolRead: "•",
  toolWrite: "•",
  toolSearch: "•",
  toolWeb: "•",
  toolDefault: "•",
  toolResultIndent: "    └ ",
  toolIndent: "  ",
  markerDash: "•"
} as const;

export const COLOR = {
  dim: "#8a8a8a",
  muted: "#a8a8a8",
  text: "#d7d7d7",
  accent: "#5fd7ff",
  warning: "#d7af5f",
  error: "#ff5f5f",
  success: "#87d75f",
  bg: "transparent",
  backdrop: "rgba(0,0,0,0.5)",
  panel: "#101010",
  userMessageBg: "#1f1f1f",
  panelActive: "#262626",
  border: "#5f5f5f",
  borderActive: "#5fd7ff",
  markdownText: "#d7d7d7",
  backgroundMenu: "#262626",
  diffAddedBg: "#17351f",
  diffRemovedBg: "#3b1d22",
  diffContextBg: "#1a1a1a",
  http: { GET: "#7CB7FF", POST: "#98C379", PUT: "#E5C07B", PATCH: "#E5C07B", DELETE: "#E06C75" },
  memory: {
    credential: "#E5C07B", service: "#7CB7FF", endpoint: "#56B6C2",
    hypothesis: "#C678DD", failed_attempt: "#E06C75", fact: "#98C379"
  }
} as const;

export { shortToolName } from "./tool-presentation";

export function glyphForTool(tool: string): string {
  void tool;
  return GLYPH.toolDefault;
}
