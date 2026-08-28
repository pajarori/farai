import type { JSX } from "solid-js";
import type { TimelineRow } from "../../renderers";
import { syntax } from "../../syntax";
import { COLOR } from "../../theme";

type AssistantMessageProps = {
  row: Extract<TimelineRow, { kind: "assistant" }>;
};

export function AssistantMessage(props: AssistantMessageProps): JSX.Element {
  return (
    <box style={{ flexDirection: "column", marginBottom: 1 }}>
      <box style={{ flexDirection: "row", minWidth: 0 }}>
        <text fg={COLOR.dim}>{"• "}</text>
        <box style={{ flexDirection: "column", flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
          <markdown width="100%" content={props.row.text} streaming={props.row.streaming} internalBlockMode="top-level" syntaxStyle={syntax()} tableOptions={{ style: "columns", widthMode: "content", cellPaddingX: 1 }} fg={COLOR.markdownText} />
        </box>
      </box>
    </box>
  );
}
