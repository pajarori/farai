import { id, nowIso } from "../utils";
import { takeBytes } from "../agent-tools/shared/output-bound";
import type { HarnessEvent } from "./harness";

const EVENT_PAYLOAD_MAX_BYTES = 32 * 1024;

export type EventProvenance = Readonly<{
  source: "runtime" | "tool" | "provider" | "mcp" | "user";
  name: string;
  invocationId?: string;
  server?: string;
}>;

export function createEvent(input: Omit<HarnessEvent, "id" | "createdAt" | "payload"> & { payload: unknown; provenance?: EventProvenance }): HarnessEvent {
  const payload = boundedPayload(input.payload);
  return {
    id: id(),
    sessionId: input.sessionId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    type: input.type,
    name: input.name,
    payload: input.provenance ? { data: payload, provenance: input.provenance } : payload,
    createdAt: nowIso()
  };
}

function boundedPayload(payload: unknown): unknown {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload) ?? String(payload);
  if (Buffer.byteLength(text, "utf8") <= EVENT_PAYLOAD_MAX_BYTES) return payload;
  return { truncated: true, preview: takeBytes(text, EVENT_PAYLOAD_MAX_BYTES, "head") };
}
