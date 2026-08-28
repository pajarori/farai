import { SyntaxStyle } from "@opentui/core";
import { COLOR } from "./theme";

let shared: SyntaxStyle | undefined;

export function syntax(): SyntaxStyle {
  shared ??= SyntaxStyle.fromStyles({
    keyword: { fg: COLOR.accent },
    string: { fg: COLOR.success },
    number: { fg: COLOR.warning },
    comment: { fg: COLOR.dim, italic: true },
    function: { fg: COLOR.text },
    type: { fg: COLOR.accent },
    variable: { fg: COLOR.text },
    operator: { fg: COLOR.muted },
    punctuation: { fg: COLOR.muted }
  });
  return shared;
}
