import type { Evidence, ToolContext } from "../../types";
import { id, nowIso } from "../../utils";

function stringField(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key]) return value[key] as string;
  }
  return undefined;
}

export function parseOastEvents(raw: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const event = value as Record<string, unknown>;
      if (stringField(event, "correlation-id", "correlation_id", "correlationId", "protocol", "type", "interaction-type", "interaction_type")) events.push(event);
    } catch {

    }
  }
  return events;
}

export function oastEvidence(context: ToolContext, events: Record<string, unknown>[]): Evidence[] {
  return oastEvidenceForSession(context.session.id, events);
}

export function oastEvidenceForSession(sessionId: string, events: Record<string, unknown>[]): Evidence[] {
  return events.map((event) => {
    const protocol = stringField(event, "protocol", "type", "interaction-type", "interaction_type") ?? "unknown";
    const correlation = stringField(event, "correlation-id", "correlation_id", "correlationId") ?? "unknown";
    return {
      id: id(),
      sessionId,
      source: "tool",
      title: `OAST ${protocol} interaction`,
      summary: `Interactsh callback received for correlation ${correlation}: ${JSON.stringify(event).slice(0, 1_000)}`,
      createdAt: nowIso()
    };
  });
}
