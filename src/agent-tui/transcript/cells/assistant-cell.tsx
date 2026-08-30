import type { JSX } from "solid-js";
import type { TimelineRow } from "../../renderers";
import { COLOR } from "../../theme";
import { MarkdownView } from "../../markdown";
import { TranscriptMarker } from "./transcript-marker";

type AssistantMessageProps = {
  row: Extract<TimelineRow, { kind: "assistant" }>;
  streamedText?: string | undefined;
};

export function AssistantMessage(props: AssistantMessageProps): JSX.Element {
  return (
    <box style={{ flexDirection: "column", flexShrink: 0, marginBottom: 1 }}>
      <box style={{ flexDirection: "row", flexShrink: 0, minWidth: 0 }}>
        <TranscriptMarker color={COLOR.dim} />
        <box style={{ flexDirection: "column", flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
          <MarkdownView
            id={`${props.row.id}:markdown`}
            content={props.streamedText ?? props.row.text}
            streaming={props.row.streaming}
            fg={COLOR.markdownText}
          />
        </box>
      </box>
    </box>
  );
}
