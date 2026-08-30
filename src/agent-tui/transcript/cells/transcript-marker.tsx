import { Show, type JSX } from "solid-js";
import { FaraiSpinner } from "../../common/spinner";

type TranscriptMarkerProps = {
  glyph?: string;
  color: string;
  spinning?: boolean;
  animated?: boolean | undefined;
};

export function TranscriptMarker(props: TranscriptMarkerProps): JSX.Element {
  return (
    <box style={{ width: 2, flexShrink: 0 }}>
      <Show when={props.spinning} fallback={<text selectable={false} fg={props.color}>{props.glyph ?? "•"}</text>}>
        <FaraiSpinner color={props.color} selectable={false} animated={props.animated} />
      </Show>
    </box>
  );
}
