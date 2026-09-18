import type { LaneDefinition } from "./lanes";
import { BUILTIN_LANES, laneConfigPaths, laneWriteTarget, loadLanes, readLaneFile, writeLaneFile } from "./lanes";

export type LaneSource = "builtin" | "global" | "workspace";

export type LaneInfo = LaneDefinition & { source: LaneSource; editable: boolean };

const LANE_ID = /^[a-z0-9][a-z0-9_-]*$/;

export type SaveLaneInput = {
  id: string;
  description?: string;
  prompt?: string;
  tools?: string[];
  model?: string;
};

export function listLanes(workspace: string): LaneInfo[] {
  const paths = laneConfigPaths(workspace);
  const writeTarget = laneWriteTarget(workspace);
  const globalIds = new Set(readLaneFile(writeTarget).map((lane) => lane.id));
  const overrideIds = new Set(paths.filter((path) => path !== writeTarget).flatMap((path) => readLaneFile(path).map((lane) => lane.id)));
  const builtinIds = new Set(BUILTIN_LANES.map((lane) => lane.id));
  return loadLanes(workspace).map((lane) => {
    const source: LaneSource = overrideIds.has(lane.id) ? "workspace" : globalIds.has(lane.id) ? "global" : builtinIds.has(lane.id) ? "builtin" : "global";
    return { ...lane, source, editable: source !== "workspace" };
  });
}

export function saveLane(workspace: string, input: SaveLaneInput): LaneInfo {
  const id = input.id.trim();
  if (!LANE_ID.test(id)) throw new Error("lane id must match ^[a-z0-9][a-z0-9_-]*$");
  const tools = input.tools
    ? [...new Set(input.tools.map((tool) => tool.trim()).filter(Boolean))]
    : undefined;
  if (input.tools && !tools?.length) throw new Error("tools must contain at least one non-empty tool name");
  const definition: LaneDefinition = {
    id,
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    ...(input.prompt?.trim() ? { prompt: input.prompt.trim() } : {}),
    ...(tools?.length ? { tools } : {}),
    ...(input.model?.trim() ? { model: input.model.trim() } : {})
  };
  const target = laneWriteTarget(workspace);
  const current = readLaneFile(target).filter((lane) => lane.id !== id);
  writeLaneFile(target, [...current, definition]);
  return { ...definition, source: "global", editable: true };
}

export function removeLane(workspace: string, id: string): void {
  const target = laneWriteTarget(workspace);
  const current = readLaneFile(target);
  if (!current.some((lane) => lane.id === id)) throw new Error(`no custom lane to remove: ${id}`);
  writeLaneFile(target, current.filter((lane) => lane.id !== id));
}
