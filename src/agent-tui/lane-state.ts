import type { LaneInfo } from "../agent-core/subagents/lane-management";

export type LaneWizardMode = "add" | "edit";
export type LaneWizardField = "id" | "description" | "prompt" | "tools" | "model" | "review";

export type LaneWizardState = {
  mode: LaneWizardMode;
  field: LaneWizardField;
  id: string;
  originalID?: string;
  description: string;
  prompt: string;
  tools: string[];
  toolFilter: string;
  toolCursor: number;
  model: string;
  busy: boolean;
  error: string | undefined;
};

const FIELD_ORDER: LaneWizardField[] = ["id", "description", "prompt", "tools", "model", "review"];

export function createLaneWizard(lane?: LaneInfo): LaneWizardState {
  if (!lane) {
    return { mode: "add", field: "id", id: "", description: "", prompt: "", tools: [], toolFilter: "", toolCursor: 0, model: "", busy: false, error: undefined };
  }
  return {
    mode: "edit",
    field: "description",
    id: lane.id,
    originalID: lane.id,
    description: lane.description ?? "",
    prompt: lane.prompt ?? "",
    tools: [...(lane.tools ?? [])],
    toolFilter: "",
    toolCursor: 0,
    model: lane.model ?? "",
    busy: false,
    error: undefined
  };
}

export function laneWizardFieldMove(field: LaneWizardField, delta: -1 | 1): LaneWizardField {
  const index = FIELD_ORDER.indexOf(field);
  return FIELD_ORDER[Math.max(0, Math.min(FIELD_ORDER.length - 1, index + delta))] ?? field;
}

export function laneWizardStep(field: LaneWizardField): number {
  return FIELD_ORDER.indexOf(field) + 1;
}

export function laneWizardStepCount(): number {
  return FIELD_ORDER.length;
}

export function filteredToolNames(all: string[], filter: string): string[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return all;
  return all.filter((name) => name.toLowerCase().includes(needle));
}
