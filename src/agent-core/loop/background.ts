import type { ToolCallRecord } from "../../types";
import { takeBytes } from "../../agent-tools/shared/output-bound";
import { canonicalToolName } from "../../tool-names";

export type ActiveBackgroundJob = {
  processId: string;
  toolCallId: string;
  tool: string;
  args: unknown;
};

export function activeBackgroundJobs(calls: ToolCallRecord[]): ActiveBackgroundJob[] {
  const groups = new Map<string, { latest: ToolCallRecord; origin?: ToolCallRecord }>();
  for (const call of calls) {
    const processId = call.processId ?? processIdFromArgs(call.args);
    if (!processId) continue;
    const group = groups.get(processId);
    if (!group) groups.set(processId, { latest: call, ...(call.status === "running_background" ? { origin: call } : {}) });
    else if (call.status === "running_background") group.origin = call;
  }
  const jobs: ActiveBackgroundJob[] = [];
  for (const [processId, group] of groups) {
    if (group.latest.status !== "running_background" || !group.origin) continue;
    jobs.push({ processId, toolCallId: group.origin.id, tool: canonicalToolName(group.origin.tool), args: group.origin.args });
  }
  return jobs;
}

export function findEquivalentBackgroundJob(jobs: ActiveBackgroundJob[], tool: string, args: unknown): ActiveBackgroundJob | undefined {
  const fingerprint = stableValue(args);
  const canonical = canonicalToolName(tool);
  return jobs.find((job) => job.tool === canonical && stableValue(job.args) === fingerprint);
}

export function processIdFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const processId = (args as Record<string, unknown>).processId;
  return typeof processId === "string" && processId ? processId : undefined;
}

export function renderBackgroundJobs(jobs: ActiveBackgroundJob[]): string[] {
  if (jobs.length === 0) return ["- none"];
  return jobs.map((job) => {
    const args = takeBytes(stableValue(job.args), 480, "head");
    return `- processId=${job.processId} tool=${job.tool} toolCallId=${job.toolCallId} args=${args}`;
  });
}

export function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableValue(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}
