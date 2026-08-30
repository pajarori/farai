import { batch, createEffect, createSignal, onCleanup, Show, type JSX } from "solid-js";
import { COLOR } from "../theme";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const listeners = new Set<(frame: number) => void>();
let schedulerFrame = 0;
let schedulerTimer: ReturnType<typeof setInterval> | undefined;

type FaraiSpinnerProps = {
  label?: string;
  color?: string;
  animated?: boolean | undefined;
  selectable?: boolean;
};

export function FaraiSpinner(props: FaraiSpinnerProps): JSX.Element {
  const color = () => props.color ?? COLOR.accent;
  const [frame, setFrame] = createSignal(0);
  let unsubscribe: (() => void) | undefined;
  createEffect(() => {
    unsubscribe?.();
    unsubscribe = undefined;
    if (props.animated === false) {
      setFrame(0);
      return;
    }
    unsubscribe = subscribeSpinner(setFrame);
  });
  onCleanup(() => {
    unsubscribe?.();
  });
  return (
    <Show
      when={props.animated !== false}
      fallback={<text {...(props.selectable === undefined ? {} : { selectable: props.selectable })} fg={color()}>{`${FRAMES[0]}${props.label ? ` ${props.label}` : ""}`}</text>}
    >
      <text {...(props.selectable === undefined ? {} : { selectable: props.selectable })} fg={color()}>{`${FRAMES[frame()]}${props.label ? ` ${props.label}` : ""}`}</text>
    </Show>
  );
}

function subscribeSpinner(listener: (frame: number) => void): () => void {
  listeners.add(listener);
  listener(schedulerFrame);
  if (!schedulerTimer) {
    schedulerTimer = setInterval(() => {
      schedulerFrame = (schedulerFrame + 1) % FRAMES.length;
      batch(() => {
        for (const notify of listeners) notify(schedulerFrame);
      });
    }, 90);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0 || !schedulerTimer) return;
    clearInterval(schedulerTimer);
    schedulerTimer = undefined;
  };
}
