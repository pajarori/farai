import { createSignal, onCleanup, Show, type JSX } from "solid-js";
import { COLOR } from "../theme";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type FaraiSpinnerProps = {
  label?: string;
  color?: string;
  animated?: boolean;
};

export function FaraiSpinner(props: FaraiSpinnerProps): JSX.Element {
  const color = () => props.color ?? COLOR.accent;
  const [frame, setFrame] = createSignal(0);
  const timer = setInterval(() => setFrame((value) => (value + 1) % FRAMES.length), 90);
  onCleanup(() => clearInterval(timer));
  return (
    <Show
      when={props.animated !== false}
      fallback={<text fg={color()}>{`${FRAMES[0]}${props.label ? ` ${props.label}` : ""}`}</text>}
    >
      <text fg={color()}>{`${FRAMES[frame()]}${props.label ? ` ${props.label}` : ""}`}</text>
    </Show>
  );
}
