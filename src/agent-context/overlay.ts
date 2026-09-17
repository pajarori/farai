import type { ContextSummaryChunk } from "../types";

export type OverlayEntry = { chunkId: string; lane: string; anchor: boolean; summary: string };

export function buildOverlayMap(chunks: ContextSummaryChunk[]): Map<string, OverlayEntry> {
  const overlay = new Map<string, OverlayEntry>();
  for (const chunk of chunks) {
    for (const nodeId of chunk.coveredNodeIds) {
      const anchor = nodeId === chunk.anchorNodeId;
      overlay.set(nodeId, { chunkId: chunk.id, lane: chunk.lane, anchor, summary: anchor ? chunk.summary : "" });
    }
  }
  return overlay;
}
