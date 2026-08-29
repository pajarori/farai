import type { JSX } from "solid-js";
import type { TimelineRow } from "../../renderers";
import { syntax } from "../../syntax";
import { COLOR } from "../../theme";
import { TranscriptMarker } from "./transcript-marker";

type AssistantMessageProps = {
  row: Extract<TimelineRow, { kind: "assistant" }>;
};

export function AssistantMessage(props: AssistantMessageProps): JSX.Element {
  return (
    <box style={{ flexDirection: "column", marginBottom: 1 }}>
      <box style={{ flexDirection: "row", minWidth: 0 }}>
        <TranscriptMarker color={COLOR.dim} />
        <box style={{ flexDirection: "column", flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
          <markdown width="100%" content={props.row.text} streaming={props.row.streaming} syntaxStyle={syntax()} tableOptions={{ style: "columns", widthMode: "content", cellPaddingX: 1 }} fg={COLOR.markdownText} />
        </box>
      </box>
    </box>
  );
}
