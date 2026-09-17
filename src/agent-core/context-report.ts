import type { ContextManifest } from "./context-engine";

export type ContextTone =
  | "system"
  | "tools"
  | "instructions"
  | "capabilities"
  | "working"
  | "retrieved"
  | "ephemeral"
  | "messages"
  | "free";

export type ContextSlice = { tone: ContextTone; label: string; tokens: number; ratio: number };

export type ContextReport = {
  model: string;
  window: number;
  used: number;
  free: number;
  ratio: number;
  slices: ContextSlice[];
  grid: ContextTone[];
  columns: number;
};

const CATEGORIES: Array<{ key: string; tone: ContextTone; label: string }> = [
  { key: "kernel", tone: "system", label: "system prompt" },
  { key: "capability_schemas", tone: "tools", label: "tools" },
  { key: "instructions", tone: "instructions", label: "instructions" },
  { key: "capabilities", tone: "capabilities", label: "skills & capabilities" },
  { key: "working_set", tone: "working", label: "working set" },
  { key: "retrieved", tone: "retrieved", label: "retrieved" },
  { key: "ephemeral", tone: "ephemeral", label: "ephemeral" },
  { key: "history", tone: "messages", label: "messages" }
];

export function buildContextReport(manifest: ContextManifest, model: string, columns = 20, rows = 5): ContextReport {
  const window = Math.max(1, manifest.contextWindow);
  const used = Math.min(window, Math.max(0, Math.round(manifest.estimatedTokens)));
  const slices: ContextSlice[] = [];
  for (const category of CATEGORIES) {
    const tokens = Math.max(0, Math.round(manifest.breakdown[category.key] ?? 0));
    if (tokens > 0) slices.push({ tone: category.tone, label: category.label, tokens, ratio: tokens / window });
  }
  const free = Math.max(0, window - used);
  const totalCells = Math.max(1, columns * rows);
  const usedCells = Math.min(totalCells, Math.round((used / window) * totalCells));
  const grid: ContextTone[] = [];
  for (const slice of slices) {
    const cells = Math.round(slice.ratio * totalCells);
    for (let index = 0; index < cells && grid.length < usedCells; index += 1) grid.push(slice.tone);
  }
  while (grid.length < usedCells) grid.push(slices.at(-1)?.tone ?? "messages");
  while (grid.length < totalCells) grid.push("free");
  return { model, window, used, free, ratio: used / window, slices, grid, columns };
}
