import type { TuiStoreValue } from "../context/store";
import type { TuiRuntimePort } from "../runtime-port";
import { filteredToolNames, laneWizardFieldMove } from "../lane-state";
import { createControllerOperations } from "./controller-operation";
import type { OverlaySelection } from "./overlay-selection";

type LaneControllerInput = {
  tui: TuiStoreValue;
  port: TuiRuntimePort;
  selection: OverlaySelection;
  isDisposed(): boolean;
};

const LANE_ID = /^[a-z0-9][a-z0-9_-]*$/;

export function createLaneController(input: LaneControllerInput) {
  const { tui, port, selection } = input;
  const operations = createControllerOperations(tui);

  function overlayOpen(): boolean {
    return tui.store.ui.overlayStack.at(-1)?.kind === "subagents";
  }

  function reopen(): void {
    tui.actions.overlayClear();
    tui.actions.overlayPush({ kind: "subagents", query: "", index: 0 });
  }

  function openAdd(): void {
    operations.invalidate();
    tui.actions.laneWizardOpen();
  }

  function openEdit(): void {
    const lane = selection.lane();
    if (!lane?.editable) return;
    operations.invalidate();
    tui.actions.laneWizardOpen(lane);
  }

  function requestRemoval(): void {
    const lane = selection.lane();
    if (lane && lane.source === "global") tui.actions.laneRemovalOpen(lane);
  }

  async function confirmRemoval(): Promise<void> {
    const removalState = tui.store.ui.laneRemoval;
    if (!removalState || removalState.busy) return;
    const operation = operations.begin();
    tui.actions.laneRemovalPatch({ busy: true, error: undefined });
    let lanes: Awaited<ReturnType<typeof port.removeLane>>;
    try {
      lanes = await port.removeLane(removalState.lane.id);
    } catch (error) {
      if (!operations.owns(operation) || input.isDisposed()) return;
      if (tui.store.ui.laneRemoval?.lane.id !== removalState.lane.id) return;
      tui.actions.laneRemovalPatch({ busy: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (!operations.owns(operation) || input.isDisposed() || tui.store.ui.laneRemoval?.lane.id !== removalState.lane.id) return;
    tui.actions.laneRemovalClose();
    tui.actions.lanesSet(lanes);
    reopen();
    tui.setStatusDetail(`removed lane ${removalState.lane.id}`, 3_000);
  }

  function cancelRemoval(): void {
    operations.invalidate();
    tui.actions.laneRemovalClose();
  }

  async function next(): Promise<void> {
    const wizard = tui.store.ui.laneWizard;
    if (!wizard || wizard.busy) return;
    tui.actions.laneWizardPatch({ error: undefined });
    if (wizard.field === "id") {
      const normalized = wizard.id.trim().toLowerCase();
      if (!LANE_ID.test(normalized)) {
        tui.actions.laneWizardPatch({ error: "lane id must match a-z 0-9 _ - and start alphanumeric" });
        return;
      }
      if (wizard.mode === "add" && tui.store.ui.lanes.some((lane) => lane.id === normalized && lane.source !== "builtin")) {
        tui.actions.laneWizardPatch({ error: `${normalized} already exists · select it and press ctrl+e to edit` });
        return;
      }
      tui.actions.laneWizardPatch({ id: normalized, field: "description" });
      return;
    }
    if (wizard.field === "description") { tui.actions.laneWizardPatch({ field: "prompt" }); return; }
    if (wizard.field === "prompt") { tui.actions.laneWizardPatch({ field: "tools", toolFilter: "", toolCursor: 0 }); return; }
    if (wizard.field === "tools") { tui.actions.laneWizardPatch({ field: "model" }); return; }
    if (wizard.field === "model") { tui.actions.laneWizardPatch({ field: "review" }); return; }

    const operation = operations.begin();
    tui.actions.laneWizardPatch({ busy: true, error: undefined });
    try {
      const lanes = await port.saveLane({
        id: wizard.id,
        ...(wizard.description.trim() ? { description: wizard.description.trim() } : {}),
        ...(wizard.prompt.trim() ? { prompt: wizard.prompt.trim() } : {}),
        ...(wizard.tools.length ? { tools: wizard.tools } : {}),
        ...(wizard.model.trim() ? { model: wizard.model.trim() } : {})
      });
      if (!operations.owns(operation) || input.isDisposed() || !tui.store.ui.laneWizard) return;
      tui.actions.lanesSet(lanes);
      tui.actions.laneWizardClose();
      if (overlayOpen()) reopen();
      tui.setStatusDetail(`lane ${wizard.id} saved`, 3_000);
    } catch (error) {
      if (!operations.owns(operation) || input.isDisposed() || !tui.store.ui.laneWizard) return;
      tui.actions.laneWizardPatch({ busy: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  function visibleTools(): string[] {
    const wizard = tui.store.ui.laneWizard;
    return wizard ? filteredToolNames(tui.store.ui.toolNames, wizard.toolFilter) : [];
  }

  function moveTool(delta: number): void {
    const wizard = tui.store.ui.laneWizard;
    if (!wizard) return;
    const count = visibleTools().length;
    if (count === 0) return;
    tui.actions.laneWizardPatch({ toolCursor: Math.max(0, Math.min(count - 1, wizard.toolCursor + delta)) });
  }

  function toggleTool(): void {
    const wizard = tui.store.ui.laneWizard;
    if (!wizard) return;
    const tools = visibleTools();
    const name = tools[Math.max(0, Math.min(tools.length - 1, wizard.toolCursor))];
    if (!name) return;
    const next = wizard.tools.includes(name) ? wizard.tools.filter((tool) => tool !== name) : [...wizard.tools, name];
    tui.actions.laneWizardPatch({ tools: next });
  }

  function selectAllTools(): void {
    const wizard = tui.store.ui.laneWizard;
    if (!wizard) return;
    const visible = visibleTools();
    if (visible.length === 0) return;
    const allSelected = visible.every((name) => wizard.tools.includes(name));
    const next = allSelected
      ? wizard.tools.filter((name) => !visible.includes(name))
      : [...new Set([...wizard.tools, ...visible])];
    tui.actions.laneWizardPatch({ tools: next });
  }

  function filterAppend(char: string): void {
    const wizard = tui.store.ui.laneWizard;
    if (!wizard) return;
    tui.actions.laneWizardPatch({ toolFilter: `${wizard.toolFilter}${char}`, toolCursor: 0 });
  }

  function filterBackspace(): void {
    const wizard = tui.store.ui.laneWizard;
    if (!wizard?.toolFilter) return;
    tui.actions.laneWizardPatch({ toolFilter: [...wizard.toolFilter].slice(0, -1).join(""), toolCursor: 0 });
  }

  function back(): void {
    const wizard = tui.store.ui.laneWizard;
    if (!wizard || wizard.busy) return;
    if ((wizard.mode === "add" && wizard.field === "id") || (wizard.mode === "edit" && wizard.field === "description")) {
      operations.invalidate();
      tui.actions.laneWizardClose();
      return;
    }
    tui.actions.laneWizardPatch({ field: laneWizardFieldMove(wizard.field, -1), error: undefined });
  }

  return {
    dispose: () => operations.invalidate(),
    openAdd,
    openEdit,
    requestRemoval,
    confirmRemoval,
    cancelRemoval,
    next,
    back,
    moveTool,
    toggleTool,
    selectAllTools,
    filterAppend,
    filterBackspace
  };
}
