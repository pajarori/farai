import { Show, type JSX } from "solid-js";
import { useTuiStore } from "../context/store";
import { truncateLine } from "../renderers";
import { useTuiDimensions } from "../context/terminal";
import { COLOR } from "../theme";
import { fmtElapsed } from "./time";
import { isFooterStatusDetail } from "./footer-state";

const SPINNER_FRAMES = ["·", "•", "·"];

type StatusIndicatorProps = {
  elapsed: number;
  spinnerFrame?: number;
  activity?: "working" | "compacting context" | undefined;
};

export function StatusIndicator(props: StatusIndicatorProps): JSX.Element {
  const tui = useTuiStore();
  const dims = useTuiDimensions();
  const detail = () => {
    const value = tui.store.ui.statusDetail;
    return value && value !== "working" && value !== props.activity && !isFooterStatusDetail(value) ? ` • ${value}` : "";
  };

  const glyph = () => SPINNER_FRAMES[(props.spinnerFrame ?? 0) % SPINNER_FRAMES.length]!;

  const text = () => {
    if (props.activity) {
      const value = dims().width >= 56
        ? `${props.activity} (${fmtElapsed(props.elapsed)}${detail()} • esc to interrupt)`
        : `${props.activity} ${fmtElapsed(props.elapsed)} · esc interrupt`;
      return truncateLine(value.toLowerCase(), Math.max(1, dims().width - 2));
    }
    const value = tui.store.ui.statusDetail;
    return truncateLine((value && value !== "working" && !isFooterStatusDetail(value) ? `• ${value}` : "").toLowerCase(), Math.max(1, dims().width));
  };

  return (
    <box style={{ flexDirection: "row", flexShrink: 0, paddingTop: 1 }}>
      <Show when={props.activity}>
        <text fg={COLOR.agent}>{`${glyph()} `}</text>
      </Show>
      <text fg={COLOR.text}>{text()}</text>
    </box>
  );
}
