import type { TuiStoreValue } from "../context/store";

export function createControllerOperations(tui: TuiStoreValue) {
  let generation = 0;
  let pendingStatus: string | undefined;

  function clearPendingStatus(): void {
    if (pendingStatus !== undefined && tui.store.ui.statusDetail === pendingStatus) {
      tui.setStatusDetail(undefined);
    }
    pendingStatus = undefined;
  }

  function invalidate(): void {
    generation += 1;
    clearPendingStatus();
  }

  function begin(status?: string): number {
    invalidate();
    if (status !== undefined) {
      pendingStatus = status;
      tui.setStatusDetail(status);
    }
    return generation;
  }

  function owns(operation: number): boolean {
    return operation === generation;
  }

  function finish(operation: number, detail?: string, timeoutMs?: number): boolean {
    if (!owns(operation)) return false;
    clearPendingStatus();
    if (detail !== undefined) tui.setStatusDetail(detail, timeoutMs);
    return true;
  }

  return { invalidate, begin, owns, finish };
}
