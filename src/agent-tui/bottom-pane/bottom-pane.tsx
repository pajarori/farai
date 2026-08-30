import { Match, Show, Switch, createEffect, createSignal, onCleanup, type JSX } from "solid-js";
import { useTuiStore } from "../context/store";
import { useExit } from "../context/exit";
import { useComposerControl } from "../context/composer";
import { Composer } from "./composer";
import { Footer } from "./footer";
import { PendingInputPreview } from "./pending-input-preview";
import { StatusIndicator } from "./status-indicator";
import { ListOverlay } from "../overlays/list-overlay";
import { overlayOptions } from "../overlay-options";
import { centerSurfaceFooter } from "../surfaces/center-surface";
import { isAgentBusy, type CenterSurfaceBusy, type CenterSurfaceFrame } from "../store";
import { COLOR } from "../theme";
import { activityStatusVisible, bottomPaneSurface, fitFooterLine } from "./footer-state";
import { RequestUserInput } from "./request-user-input";
import { ModelProviderWizard } from "./model-provider-wizard";
import { ModelProviderRemoval } from "./model-provider-removal";
import { slashCommandOptions, slashMatches, slashPopupRowLimit, slashPopupVisible } from "../slash-autocomplete";
import { truncateLine } from "../renderers";
import { useTuiDimensions } from "../context/terminal";

export function BottomPane(): JSX.Element {
  const tui = useTuiStore();
  const exit = useExit();
  const composer = useComposerControl();
  const dims = useTuiDimensions();
  const [elapsed, setElapsed] = createSignal(0);
  let tick: ReturnType<typeof setInterval> | undefined;
  const frame = () => tui.store.ui.overlayStack.at(-1);
  const listFrame = () => {
    const top = frame();
    return top && "query" in top ? top : undefined;
  };
  const centerFrame = () => tui.store.ui.centerSurfaceStack.at(-1);
  const dialog = {
    push: () => Symbol("unused-dialog"),
    pop: () => { tui.actions.overlayPop(); },
    replace: () => Symbol("unused-dialog"),
    clear: () => { tui.actions.overlayClear(); },
    isTop: () => false,
    stack: () => tui.store.ui.overlayStack
  };
  const ctx = () => ({ tui, dialog, exit });
  const slashPanelActive = () => {
    if (tui.store.ui.activeMainTab !== "chat") return false;
    const text = composer.text();
    return slashPopupVisible(
      text,
      tui.store.ui.slashSuppressedText === text,
      slashMatches(slashCommandOptions(), text, slashPopupRowLimit(dims().height)).length,
      tui.store.ui.overlayStack.length > 0 || tui.store.ui.centerSurfaceStack.length > 0
    );
  };
  const surface = () => bottomPaneSurface({
    hasModelProviderRemoval: providerRemovalActive(),
    hasModelProviderWizard: providerWizardActive(),
    hasRequestUserInput: inputRequestActive(),
    hasListFrame: Boolean(listFrame()),
    hasCenterFrame: Boolean(centerFrame()),
    activeMainTab: tui.store.ui.activeMainTab
  });
  const providerWizardActive = () => Boolean(tui.store.ui.modelProviderWizard);
  const providerRemovalActive = () => Boolean(tui.store.ui.modelProviderRemoval);
  const inputRequestActive = () => Boolean(tui.store.snapshot.pendingUserInput && !tui.store.ui.requestUserInput?.dismissed);
  const inputRequestPending = () => Boolean(tui.store.snapshot.pendingUserInput);
  const composerSurfaceVisible = () => surface() === "composer";
  const composerChromeVisible = () => composerSurfaceVisible() && !slashPanelActive();
  const footerHidden = () => surface() !== "composer" || slashPanelActive();
  const statusActivity = () => {
    if (tui.store.ui.compacting) return "compacting context" as const;
    if (isAgentBusy(tui.store)) return "working" as const;
    return undefined;
  };
  const statusVisible = () => Boolean(composerChromeVisible() && activityStatusVisible(tui.store.ui.activeMainTab) && statusActivity());
  const pendingPreviewVisible = () => composerChromeVisible()
    && (tui.store.snapshot.pendingSteers.length > 0 || tui.store.snapshot.queuedPrompts.length > 0);
  const questionNoticeVisible = () => composerChromeVisible() && inputRequestPending();
  const questionNotice = () => truncateLine(
    dims().width >= 64
      ? "• question pending · ctrl+q answer · chat input remains available"
      : "• question pending · ctrl+q answer",
    Math.max(1, dims().width)
  );
  const previewMaxRows = () => {
    const fixedRows = 5 + composer.height()
      + (statusVisible() ? 1 : 0)
      + (questionNoticeVisible() ? 1 : 0)
      + (statusVisible() && (pendingPreviewVisible() || questionNoticeVisible()) ? 1 : 0)
      + (pendingPreviewVisible() && questionNoticeVisible() ? 1 : 0);
    return Math.min(10, Math.max(0, dims().height - fixedRows));
  };
  const previewRendered = () => pendingPreviewVisible() && previewMaxRows() > 0;

  createEffect(() => {
    const started = tui.store.ui.runningSince;
    if (tick) { clearInterval(tick); tick = undefined; }
    if (!started) {
      setElapsed(0);
      return;
    }
    setElapsed(Math.max(0, Math.floor((Date.now() - started) / 1000)));
    tick = setInterval(() => setElapsed(Math.max(0, Math.floor((Date.now() - started) / 1000))), 1000);
  });

  onCleanup(() => { if (tick) clearInterval(tick); });

  return (
    <box id="bottom-pane" style={{ flexShrink: 0, flexDirection: "column" }}>
      <Show when={statusVisible()}>
        <StatusIndicator elapsed={elapsed()} activity={statusActivity()} />
      </Show>
      <Show when={statusVisible() && (previewRendered() || questionNoticeVisible())}>
        <box style={{ height: 1, flexShrink: 0 }} />
      </Show>
      <Show when={previewRendered()}>
        <PendingInputPreview maxRows={previewMaxRows()} />
      </Show>
      <Show when={previewRendered() && questionNoticeVisible()}>
        <box style={{ height: 1, flexShrink: 0 }} />
      </Show>
      <Show when={questionNoticeVisible()}>
        <text fg={COLOR.warning}>{questionNotice()}</text>
      </Show>
      <Switch>
        <Match when={surface() === "model_provider_removal"}>
          <ModelProviderRemoval />
        </Match>
        <Match when={surface() === "model_provider_wizard"}>
          <ModelProviderWizard />
        </Match>
        <Match when={surface() === "request_user_input"}>
          <Show when={tui.store.snapshot.pendingUserInput} keyed>
            {(request) => <RequestUserInput request={request} />}
          </Show>
        </Match>
        <Match when={surface() === "list_overlay"}>
          <Show when={listFrame()} keyed>
            {(top) => <ListOverlay frame={top} options={overlayOptions(top, tui, ctx())} docked />}
          </Show>
        </Match>
        <Match when={surface() === "center_surface"}>
          <Show when={centerFrame()}>
            {(current) => <CenterSurfaceFooter frame={current()} />}
          </Show>
        </Match>
        <Match when={surface() === "proxy_tab"}>
          <ProxyTabFooter />
        </Match>
      </Switch>
      <Composer visible={composerSurfaceVisible()} active={composerSurfaceVisible()} />
      <Show when={!footerHidden()}>
        <Footer elapsed={elapsed()} />
      </Show>
    </box>
  );
}

function ProxyTabFooter(): JSX.Element {
  const tui = useTuiStore();
  const dims = useTuiDimensions();
  const error = () => tui.store.ui.lastError;
  const layout = () => proxyTabFooterLayout(dims().width, tui.store.ui.proxyFilter, error() ?? tui.store.ui.statusDetail);
  return (
    <box style={{ height: 1, flexDirection: "row", justifyContent: "space-between" }}>
      <text fg={COLOR.dim}>{layout().left}</text>
      <text fg={error() ? COLOR.error : COLOR.dim}>{layout().right}</text>
    </box>
  );
}

function CenterSurfaceFooter(props: { frame: CenterSurfaceFrame }): JSX.Element {
  const tui = useTuiStore();
  const dims = useTuiDimensions();
  const error = () => tui.store.ui.lastError;
  const layout = () => centerSurfaceFooterLayout(props.frame, dims().width, error(), tui.store.ui.centerSurfaceBusy);
  return (
    <box style={{ height: 1, flexDirection: "row", justifyContent: "space-between", paddingLeft: 1, paddingRight: 1 }}>
      <text fg={COLOR.dim}>{layout().left}</text>
      <text fg={error() ? COLOR.error : COLOR.dim}>{layout().right}</text>
    </box>
  );
}

export function proxyTabFooterLayout(width: number, filter: string, status?: string): { left: string; right: string } {
  const hint = width >= 88
    ? "↑↓ flow · tab detail · p/n ws msg · ←→ filter · a/h/w tabs · alt+1 chat"
    : width >= 56
      ? "alt+1 chat · ↑↓ flow · tab detail · ←→ filter"
      : width >= 32
        ? "alt+1 chat · ↑↓ flow"
        : "alt+1 chat";
  return fitFooterLine(hint, [
    ...(status ? [{ id: "status", kind: "message" as const, text: status }] : []),
    { id: "proxy", kind: "message", text: `proxy · ${filter}` }
  ], Math.max(0, width));
}

export function centerSurfaceFooterLayout(
  frame: CenterSurfaceFrame,
  width: number,
  error?: string,
  busy?: CenterSurfaceBusy
): { left: string; right: string } {
  const hint = busy
    ? "esc back"
    : width >= 64
      ? centerSurfaceFooter(frame).toLowerCase()
      : compactCenterSurfaceFooter(frame);
  const status = error ? `error · ${error}` : centerSurfaceStatus(frame, busy);
  return fitFooterLine(hint, [{ id: "surface", kind: "message", text: status }], Math.max(0, width - 2));
}

function centerSurfaceStatus(
  frame: CenterSurfaceFrame,
  busy: CenterSurfaceBusy | undefined
): string {
  if (busy === "report_save") return "saving report";
  if (busy === "container_toggle") return "toggling container";
  if (busy === "container_refresh") return "refreshing container";
  return frame.kind.toLowerCase();
}

function compactCenterSurfaceFooter(frame: CenterSurfaceFrame): string {
  switch (frame.kind) {
    case "report": return "esc back · s save";
    case "container": return "esc back · t toggle · r refresh";
    case "confirm": return "esc cancel · enter confirm";
    case "proxy_flow": return "esc back · tab pane";
    case "alert":
    case "detail":
      return "esc back";
  }
}
