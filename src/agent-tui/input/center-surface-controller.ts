import type { TuiStoreValue } from "../context/store";
import type { TuiRuntimePort } from "../runtime-port";
import { createControllerOperations } from "./controller-operation";

export type SessionOwner = { sessionId: string; epoch: number };

type CenterSurfaceControllerInput = {
  tui: TuiStoreValue;
  port: TuiRuntimePort;
  captureOwner(): SessionOwner | undefined;
  owns(owner: SessionOwner): boolean;
};

export function createCenterSurfaceController(input: CenterSurfaceControllerInput) {
  const { tui, port } = input;
  const operations = createControllerOperations(tui);

  function reset(): void {
    operations.invalidate();
  }

  function pop(): void {
    reset();
    tui.actions.centerSurfacePop();
  }

  async function run(action: string): Promise<void> {
    const frame = tui.store.ui.centerSurfaceStack.at(-1);
    if (!frame || tui.store.ui.centerSurfaceBusy) return;
    if (frame.kind === "confirm" && action === "confirm") {
      pop();
      return;
    }
    if (frame.kind === "report" && action === "save") {
      const owner = input.captureOwner();
      if (!owner) return;
      const operation = operations.begin();
      tui.actions.errorSet(undefined);
      tui.actions.centerSurfaceBusySet("report_save");
      try {
        const result = await port.exportReport(owner.sessionId, { write: true });
        if (!operations.owns(operation) || !input.owns(owner) || tui.store.ui.centerSurfaceStack.at(-1) !== frame) return;
        tui.actions.centerSurfacePush({ kind: "detail", title: "report saved", body: result.path ?? "saved" });
      } catch (error) {
        if (operations.owns(operation) && input.owns(owner) && tui.store.ui.centerSurfaceStack.at(-1) === frame) {
          tui.actions.errorSet(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (operations.owns(operation) && tui.store.ui.centerSurfaceBusy === "report_save") {
          tui.actions.centerSurfaceBusySet(undefined);
        }
      }
      return;
    }
    if (frame.kind === "container" && action === "toggle") {
      const owner = input.captureOwner();
      if (!owner) return;
      const operation = operations.begin();
      tui.actions.errorSet(undefined);
      tui.actions.centerSurfaceBusySet("container_toggle");
      try {
        await tui.toggleContainer({ reportError: false });
        if (!operations.owns(operation) || !input.owns(owner) || tui.store.ui.centerSurfaceStack.at(-1) !== frame) return;
        if (tui.store.ui.lastError) return;
        tui.actions.centerSurfaceReplaceTop({ kind: "container", refreshToken: (frame.refreshToken ?? 0) + 1 });
      } catch (error) {
        if (operations.owns(operation) && input.owns(owner) && tui.store.ui.centerSurfaceStack.at(-1) === frame) {
          tui.actions.errorSet(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (operations.owns(operation) && tui.store.ui.centerSurfaceBusy === "container_toggle") {
          tui.actions.centerSurfaceBusySet(undefined);
        }
      }
      return;
    }
    if (frame.kind === "container" && action === "refresh") {
      const operation = operations.begin();
      tui.actions.errorSet(undefined);
      tui.actions.centerSurfaceBusySet("container_refresh");
      try {
        await tui.refreshContainerStatus();
        if (!operations.owns(operation) || tui.store.ui.centerSurfaceStack.at(-1) !== frame) return;
        tui.actions.centerSurfaceReplaceTop({ kind: "container", refreshToken: (frame.refreshToken ?? 0) + 1 });
      } finally {
        if (operations.owns(operation) && tui.store.ui.centerSurfaceBusy === "container_refresh") {
          tui.actions.centerSurfaceBusySet(undefined);
        }
      }
    }
  }

  return { reset, pop, run };
}
