import type { JSX } from "solid-js";
import type { TimelineRow } from "../../renderers";
import { syntax } from "../../syntax";
import { COLOR } from "../../theme";
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
          <markdown
            width="100%"
            content={props.streamedText ?? props.row.text}
            streaming={true}
            internalBlockMode="top-level"
            syntaxStyle={syntax()}
            tableOptions={{ style: "columns", widthMode: "content", cellPaddingX: 1 }}
            fg={COLOR.markdownText}
          />
        </box>
      </box>
    </box>
  );
}
