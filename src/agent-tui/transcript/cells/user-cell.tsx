import { For, createMemo, type JSX } from "solid-js";
import type { TimelineRow } from "../../renderers";
import { COLOR } from "../../theme";
import { sanitizeText, stripOuterBlankLines } from "./text-utils";

type UserPromptProps = {
  row: Extract<TimelineRow, { kind: "user" }>;
};

export function UserPrompt(props: UserPromptProps): JSX.Element {
  const lines = createMemo(() => stripOuterBlankLines(sanitizeText(props.row.text)).split("\n"));
  return (
    <box style={{ width: "100%", minWidth: 0, flexDirection: "column", marginBottom: 1, backgroundColor: COLOR.userMessageBg, paddingRight: 1 }}>
      <For each={lines()}>{(line, index) => (
        <box style={{ width: "100%", minWidth: 0, flexDirection: "row", backgroundColor: COLOR.userMessageBg }}>
          <text fg={index() === 0 ? COLOR.accent : COLOR.dim}>{index() === 0 ? "› " : "  "}</text>
          <text fg={COLOR.text}>{line || " "}</text>
        </box>
      )}</For>
    </box>
  );
}
