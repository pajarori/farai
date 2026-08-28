import { Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js";
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
import { isAgentBusy, type CenterSurfaceFrame } from "../store";
import { COLOR } from "../theme";
import { truncateLine } from "../renderers";
import { activityStatusVisible, bottomPaneSlot, isFooterStatusDetail, isTranscriptActivityDetail, transcriptOwnsActivity } from "./footer-state";

export function BottomPane(): JSX.Element {
  const tui = useTuiStore();
  const exit = useExit();
  const composer = useComposerControl();
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
    const text = composer.text();
    return text.startsWith("/")
      && !text.slice(1).includes(" ")
      && !text.includes("\n")
      && tui.store.ui.slashSuppressedText !== text
      && tui.store.ui.overlayStack.length === 0
      && tui.store.ui.centerSurfaceStack.length === 0;
  };
  const slot = () => bottomPaneSlot({
    hasListFrame: Boolean(listFrame()),
    hasCenterFrame: Boolean(centerFrame()),
    activeMainTab: tui.store.ui.activeMainTab
  });
  const proxyTabActive = () => slot() === "proxy_tab";
  const footerHidden = () => Boolean(frame()) || Boolean(centerFrame()) || slashPanelActive() || proxyTabActive();
  const inlineStatusDetail = () => {
    const detail = tui.store.ui.statusDetail;
    if (!detail || isFooterStatusDetail(detail)) return undefined;
    if (transcriptOwnsActivity(tui.timelineRows()) && isTranscriptActivityDetail(detail)) return undefined;
    return detail;
  };
  const statusActivity = () => {
    if (tui.store.ui.compacting) return "compacting context" as const;
    if (isAgentBusy(tui.store) && !transcriptOwnsActivity(tui.timelineRows())) return "working" as const;
    return undefined;
  };

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
    <box style={{ flexShrink: 0, flexDirection: "column" }}>
      <Show when={activityStatusVisible(tui.store.ui.activeMainTab) && (statusActivity() || inlineStatusDetail())}>
        <StatusIndicator elapsed={elapsed()} activity={statusActivity()} />
      </Show>
      <Show when={tui.store.ui.lastError}>
        {(error) => <text fg={COLOR.error}>{`• error · ${truncateLine(error(), 160)}`}</text>}
      </Show>
      <PendingInputPreview />
      <Show when={listFrame()} fallback={
        <Show when={centerFrame()} fallback={
          <Show when={proxyTabActive()} fallback={<Composer />}>
            <ProxyTabFooter />
          </Show>
        }>
          {(surface) => <CenterSurfaceFooter frame={surface()} />}
        </Show>
      }>
        {(top) => <ListOverlay frame={top()} options={overlayOptions(top(), tui, ctx())} docked />}
      </Show>
      <Show when={!footerHidden()}>
        <Footer elapsed={elapsed()} />
      </Show>
    </box>
  );
}

function ProxyTabFooter(): JSX.Element {
  const tui = useTuiStore();
  return (
    <box style={{ height: 1, flexDirection: "row", justifyContent: "space-between", paddingLeft: 1, paddingRight: 1 }}>
      <text fg={COLOR.dim}>{"↑↓ flow · tab detail · p/n ws msg · ←→ filter · a/h/w tabs · ctrl+1 chat"}</text>
      <text fg={COLOR.dim}>{`proxy · ${tui.store.ui.proxyFilter}`}</text>
    </box>
  );
}

function CenterSurfaceFooter(props: { frame: CenterSurfaceFrame }): JSX.Element {
  return (
    <box style={{ height: 1, flexDirection: "row", justifyContent: "space-between", paddingLeft: 1, paddingRight: 1 }}>
      <text fg={COLOR.dim}>{centerSurfaceFooter(props.frame).toLowerCase()}</text>
      <text fg={COLOR.dim}>{props.frame.kind.toLowerCase()}</text>
    </box>
  );
}
