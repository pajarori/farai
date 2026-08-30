import { SyntaxStyle, type StyleDefinitionInput } from "@opentui/core";
import { COLOR } from "./theme";

let shared: SyntaxStyle | undefined;
const markdownStyles = new Map<string, SyntaxStyle>();
export const markdownStrikethroughSentinel = "#010203";

const sourceStyles: Record<string, StyleDefinitionInput> = {
  keyword: { fg: COLOR.accent },
  "keyword.return": { fg: COLOR.accent, italic: true },
  "keyword.conditional": { fg: COLOR.accent, italic: true },
  "keyword.repeat": { fg: COLOR.accent, italic: true },
  "keyword.coroutine": { fg: COLOR.accent, italic: true },
  "keyword.type": { fg: COLOR.muted },
  "keyword.function": { fg: COLOR.accent },
  "keyword.import": { fg: COLOR.accent },
  string: { fg: COLOR.success },
  symbol: { fg: COLOR.success },
  "string.escape": { fg: COLOR.accent },
  "string.regexp": { fg: COLOR.accent },
  number: { fg: COLOR.warning },
  boolean: { fg: COLOR.warning },
  comment: { fg: COLOR.dim, italic: true },
  "comment.documentation": { fg: COLOR.dim, italic: true },
  function: { fg: COLOR.accent },
  "function.call": { fg: COLOR.accent },
  "function.method": { fg: COLOR.accent },
  "function.method.call": { fg: COLOR.accent },
  constructor: { fg: COLOR.accent },
  type: { fg: COLOR.muted },
  class: { fg: COLOR.muted },
  module: { fg: COLOR.muted },
  variable: { fg: COLOR.text },
  "variable.parameter": { fg: COLOR.text },
  property: { fg: COLOR.text },
  constant: { fg: COLOR.warning },
  operator: { fg: COLOR.muted },
  "keyword.operator": { fg: COLOR.muted },
  punctuation: { fg: COLOR.text },
  "punctuation.bracket": { fg: COLOR.text },
  "punctuation.delimiter": { fg: COLOR.muted },
  tag: { fg: COLOR.accent },
  attribute: { fg: COLOR.warning },
  annotation: { fg: COLOR.warning },
  label: { fg: COLOR.muted },
  "diff.plus": { fg: COLOR.success },
  "diff.minus": { fg: COLOR.error }
};

const richMarkdownStyles: Record<string, StyleDefinitionInput> = {
  conceal: { fg: COLOR.dim },
  "punctuation.special": { fg: COLOR.dim },
  "markup.heading": { fg: COLOR.text, bold: true },
  "markup.heading.1": { fg: COLOR.text, bold: true, underline: true },
  "markup.heading.2": { fg: COLOR.text, bold: true },
  "markup.heading.3": { fg: COLOR.text, bold: true, italic: true },
  "markup.heading.4": { fg: COLOR.text, italic: true },
  "markup.heading.5": { fg: COLOR.text, italic: true },
  "markup.heading.6": { fg: COLOR.text, italic: true },
  "markup.bold": { fg: COLOR.text, bold: true },
  "markup.strong": { fg: COLOR.text, bold: true },
  "markup.italic": { fg: COLOR.text, italic: true },
  "markup.strikethrough": { fg: markdownStrikethroughSentinel },
  "markup.list": { fg: COLOR.muted },
  "markup.list.checked": { fg: COLOR.success },
  "markup.list.unchecked": { fg: COLOR.dim },
  "markup.quote": { fg: COLOR.dim, italic: true },
  "markup.raw": { fg: COLOR.muted },
  "markup.raw.block": { fg: COLOR.text },
  "markup.raw.inline": { fg: COLOR.muted },
  "markup.link": { fg: COLOR.accent, underline: true },
  "markup.link.label": { fg: COLOR.accent, underline: true },
  "markup.link.url": { fg: COLOR.muted, underline: true }
};

function tonedMarkdownStyles(fg: string): Record<string, StyleDefinitionInput> {
  return {
    default: { fg },
    conceal: { fg },
    "punctuation.special": { fg },
    "markup.heading": { fg, bold: true },
    "markup.heading.1": { fg, bold: true, underline: true },
    "markup.heading.2": { fg, bold: true },
    "markup.heading.3": { fg, bold: true },
    "markup.heading.4": { fg, bold: true },
    "markup.heading.5": { fg, bold: true },
    "markup.heading.6": { fg, bold: true },
    "markup.bold": { fg, bold: true },
    "markup.strong": { fg, bold: true },
    "markup.italic": { fg, italic: true },
    "markup.strikethrough": { fg: markdownStrikethroughSentinel },
    "markup.list": { fg },
    "markup.list.checked": { fg },
    "markup.list.unchecked": { fg, dim: true },
    "markup.quote": { fg, italic: true },
    "markup.raw": { fg },
    "markup.raw.block": { fg },
    "markup.raw.inline": { fg },
    "markup.link": { fg, underline: true },
    "markup.link.label": { fg, underline: true },
    "markup.link.url": { fg, underline: true }
  };
}

export function syntax(): SyntaxStyle {
  shared ??= SyntaxStyle.fromStyles(sourceStyles);
  return shared;
}

export function markdownSyntax(fg: string = COLOR.markdownText): SyntaxStyle {
  const cached = markdownStyles.get(fg);
  if (cached) return cached;
  const styles = fg === COLOR.markdownText || fg === COLOR.text
    ? { ...sourceStyles, default: { fg }, ...richMarkdownStyles }
    : { ...sourceStyles, ...tonedMarkdownStyles(fg) };
  const created = SyntaxStyle.fromStyles(styles);
  markdownStyles.set(fg, created);
  return created;
}
