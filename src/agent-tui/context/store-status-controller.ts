import type { FaraiTuiStore, StoreActions } from "../store";

type StoreStatusControllerInput = {
  store: FaraiTuiStore;
  actions: StoreActions;
  isDisposed(): boolean;
};

export function createStoreStatusController(input: StoreStatusControllerInput) {
  let timer: ReturnType<typeof setTimeout> | undefined;

  function set(detail: string | undefined, timeoutMs?: number): void {
    if (input.isDisposed()) return;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    input.actions.statusDetailSet(detail);
    if (!detail || !timeoutMs) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (input.isDisposed()) return;
      if (input.store.ui.statusDetail === detail) input.actions.statusDetailSet(undefined);
    }, timeoutMs);
  }

  function dispose(): void {
    if (timer) clearTimeout(timer);
    timer = undefined;
  }

  return { set, dispose };
}
