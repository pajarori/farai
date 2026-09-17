import type { ConversationEntry } from "../agent-core/provider";

export type LaneNode = {
  nodeId: string;
  lane: string;
  covered: boolean;
  settled: boolean;
  text: string;
  bytes: number;
  toolCallId?: string;
};

export type ChunkPlan = {
  lane: string;
  coveredNodeIds: string[];
  anchorNodeId: string;
  sourceBytes: number;
};

export interface LanePolicy {
  readonly lane: string;
  classify(entry: ConversationEntry): boolean;
  planChunks(nodes: LaneNode[]): ChunkPlan[];
  prompt(nodes: LaneNode[]): string;
  fallback(nodes: LaneNode[]): string;
}

export type SummarizeLaneOptions = {
  lane?: string;
  chunkSize?: number;
  triggerUncovered?: number;
  protectedTail?: number;
};

export class SummarizeLanePolicy implements LanePolicy {
  readonly lane: string;
  private readonly chunkSize: number;
  private readonly triggerUncovered: number;
  private readonly protectedTail: number;

  constructor(options: SummarizeLaneOptions = {}) {
    this.lane = options.lane ?? "tool";
    this.chunkSize = Math.max(2, options.chunkSize ?? 5);
    this.triggerUncovered = Math.max(this.chunkSize, options.triggerUncovered ?? 30);
    this.protectedTail = Math.max(0, options.protectedTail ?? 10);
  }

  classify(entry: ConversationEntry): boolean {
    return entry.role === "tool";
  }

  planChunks(nodes: LaneNode[]): ChunkPlan[] {
    const protectedFrom = Math.max(0, nodes.length - this.protectedTail);
    const eligible = nodes.filter((node, index) => !node.covered && node.settled && index < protectedFrom);
    if (eligible.length < this.triggerUncovered) return [];
    const batch = eligible.slice(0, this.chunkSize);
    if (batch.length < this.chunkSize) return [];
    return [{
      lane: this.lane,
      coveredNodeIds: batch.map((node) => node.nodeId),
      anchorNodeId: batch[batch.length - 1]!.nodeId,
      sourceBytes: batch.reduce((total, node) => total + node.bytes, 0)
    }];
  }

  prompt(nodes: LaneNode[]): string {
    return [
      `You are compacting ${nodes.length} older tool results from an autonomous security agent into ONE concise handoff note for the same agent to keep using.`,
      "Preserve exactly: concrete findings, hosts/URLs/ports/paths, credentials or tokens observed, versions, error signatures, and any value the agent still needs.",
      "Drop only redundant framing and repeated boilerplate. Do not invent anything. Do not add commentary.",
      "Output the note as plain text wrapped in <summary>...</summary>."
    ].join("\n");
  }

  fallback(nodes: LaneNode[]): string {
    return nodes.map((node) => `- ${node.toolCallId ?? node.nodeId}: ${node.text.slice(0, 600)}`).join("\n");
  }
}
