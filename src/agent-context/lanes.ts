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
  planChunks(nodes: LaneNode[], windowTokens: number): ChunkPlan[];
  prompt(nodes: LaneNode[]): string;
  fallback(nodes: LaneNode[]): string;
}

export type SummarizeLaneOptions = {
  lane?: string;
  chunkSize?: number;
  protectedTail?: number;
  triggerFraction?: number;
  triggerTokensFloor?: number;
};

export class SummarizeLanePolicy implements LanePolicy {
  readonly lane: string;
  private readonly chunkSize: number;
  private readonly protectedTail: number;
  private readonly triggerFraction: number;
  private readonly triggerTokensFloor: number;

  constructor(options: SummarizeLaneOptions = {}) {
    this.lane = options.lane ?? "tool";
    this.chunkSize = Math.max(2, options.chunkSize ?? 8);
    this.protectedTail = Math.max(0, options.protectedTail ?? 10);
    this.triggerFraction = Math.max(0, options.triggerFraction ?? 0.15);
    this.triggerTokensFloor = Math.max(0, options.triggerTokensFloor ?? 25_000);
  }

  classify(entry: ConversationEntry): boolean {
    return entry.role === "tool";
  }

  planChunks(nodes: LaneNode[], windowTokens: number): ChunkPlan[] {
    const protectedFrom = Math.max(0, nodes.length - this.protectedTail);
    const eligible = nodes.filter((node, index) => !node.covered && node.settled && index < protectedFrom);
    if (eligible.length < this.chunkSize) return [];
    const eligibleTokens = eligible.reduce((total, node) => total + Math.ceil(node.bytes / 4), 0);
    const threshold = Math.max(this.triggerTokensFloor, Math.round(windowTokens * this.triggerFraction));
    if (eligibleTokens < threshold) return [];
    const batch = eligible.slice(0, this.chunkSize);
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
