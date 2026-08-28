import type { JSX } from "solid-js";
import { useTuiStore } from "../context/store";
import { COLOR } from "../theme";
import { fmtElapsed } from "./time";
import { isFooterStatusDetail } from "./footer-state";

type StatusIndicatorProps = {
  elapsed: number;
  activity?: "working" | "compacting context" | undefined;
};

export function StatusIndicator(props: StatusIndicatorProps): JSX.Element {
  const tui = useTuiStore();
  const detail = () => {
    const value = tui.store.ui.statusDetail;
    return value && value !== "working" && !isFooterStatusDetail(value) ? ` • ${value}` : "";
  };

  const text = () => {
    if (props.activity) return `• ${props.activity} (${fmtElapsed(props.elapsed)}${detail()} • esc to interrupt)`.toLowerCase();
    const value = tui.store.ui.statusDetail;
    return (value && value !== "working" && !isFooterStatusDetail(value) ? `• ${value}` : "").toLowerCase();
  };

  return (
    <box style={{ flexDirection: "row", flexShrink: 0 }}>
      <text fg={COLOR.text}>{text()}</text>
    </box>
  );
}
