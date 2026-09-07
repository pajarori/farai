import type { TuiStoreValue } from "../context/store";
import type { Finding } from "../../types";

const SEVERITY_ORDER: Record<Finding["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4
};

type FindingsControllerInput = {
  tui: TuiStoreValue;
};

export function createFindingsController(input: FindingsControllerInput) {
  const { tui } = input;

  function visibleIds(): string[] {
    const query = tui.store.ui.findingsQuery.trim().toLowerCase();
    return tui.store.ui.findingsCatalog
      .slice()
      .reverse()
      .filter((finding) => {
        if (!query) return true;
        return [finding.title, finding.target, finding.severity, finding.status ?? "candidate", finding.impact, finding.reproduction, finding.remediation]
          .join(" ")
          .toLowerCase()
          .includes(query);
      })
      .sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity])
      .map((finding) => finding.id);
  }

  function move(delta: number): void {
    tui.actions.findingsSelectionMove(visibleIds(), delta);
  }

  function focus(focus: "list" | "detail"): void {
    tui.actions.findingsFocusSet(focus);
  }

  function startFilter(): void {
    tui.actions.findingsFilteringSet(true);
  }

  function appendFilter(char: string): void {
    tui.actions.findingsQueryAppend(char);
  }

  function backspaceFilter(): void {
    tui.actions.findingsQueryBackspace();
  }

  function cancelFilter(): void {
    tui.actions.findingsFilteringSet(false);
  }

  async function refresh(): Promise<void> {
    try {
      await tui.refreshFindings();
    } catch (error) {
      tui.actions.errorSet(error instanceof Error ? error.message : String(error));
    }
  }

  return { move, focus, startFilter, appendFilter, backspaceFilter, cancelFilter, refresh };
}
