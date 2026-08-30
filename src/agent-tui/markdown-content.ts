import { createTextAttributes, parseColor, type TextChunk } from "@opentui/core";
import { COLOR } from "./theme";

const checkedTaskColor = parseColor(COLOR.success);
const uncheckedTaskColor = parseColor(COLOR.dim);
const mermaidKeywordAttributes = createTextAttributes({ bold: true });
const mermaidCommentAttributes = createTextAttributes({ italic: true, dim: true });
const mermaidDimColor = parseColor(COLOR.dim);
const mermaidAccentColor = parseColor(COLOR.accent);
const mermaidWarningColor = parseColor(COLOR.warning);
const mermaidEdgeColor = parseColor(COLOR.success);

export function normalizeTaskListMarkers(content: string): string {
  let fence: { marker: string; length: number } | undefined;
  return content.split("\n").map((line) => {
    const fenceMatch = line.match(/^(?:[ \t]*>[ \t]?)*[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]!;
      const length = fenceMatch[1]!.length;
      const suffix = fenceMatch[2]!.trim();
      if (!fence) fence = { marker, length };
      else if (marker === fence.marker && length >= fence.length && suffix.length === 0) fence = undefined;
      return line;
    }
    if (fence) return line;
    return line.replace(
      /^((?:[ \t]*>[ \t]?)*[ \t]*[-+*][ \t]+)\[([ xX])\](?=[ \t]|$)/,
      (_match, prefix: string, state: string) => `${prefix}${state === " " ? "□" : "✓"}`
    );
  }).join("\n");
}

export function styleTaskGlyphs(chunks: TextChunk[]): TextChunk[] {
  return chunks.flatMap((chunk) => {
    if (!/[✓□]/.test(chunk.text)) return chunk;
    return chunk.text.split(/([✓□])/).filter(Boolean).map((text) => text === "✓"
      ? { ...chunk, text, fg: checkedTaskColor }
      : text === "□"
        ? { ...chunk, text, fg: uncheckedTaskColor }
        : { ...chunk, text });
  });
}

function mermaidLineStyle(line: string): Pick<TextChunk, "fg" | "attributes"> | undefined {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("%%")) return { fg: mermaidDimColor, attributes: mermaidCommentAttributes };
  if (/^(?:graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|quadrantChart|requirementDiagram|C4\w*)\b/.test(trimmed)) {
    return { fg: mermaidAccentColor, attributes: mermaidKeywordAttributes };
  }
  if (/^(?:subgraph|end|participant|actor|class|state|section|title|dateFormat|axisFormat)\b/.test(trimmed)) {
    return { fg: mermaidWarningColor, attributes: mermaidKeywordAttributes };
  }
  if (/(?:-->|---|-.->|==>|--x|--o|<-->|<==>)/.test(line)) return { fg: mermaidEdgeColor };
  return undefined;
}

export function styleMermaidContent(chunks: TextChunk[], content: string): TextChunk[] {
  const styles = content.split("\n").map(mermaidLineStyle);
  let lineIndex = 0;
  return chunks.flatMap((chunk) => chunk.text.split(/(\n)/).filter(Boolean).map((text) => {
    const style = styles[lineIndex];
    const transformed = style ? { ...chunk, text, ...style } : { ...chunk, text };
    if (text === "\n") lineIndex += 1;
    return transformed;
  }));
}
