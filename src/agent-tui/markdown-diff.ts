import { CodeRenderable, parseColor, type TextChunk } from "@opentui/core";
import { highlightCodeAutoFallback, highlightCodeFallback } from "./code-highlighter";
import { COLOR } from "./theme";

type DiffLineKind = "added" | "removed" | "context" | "hunk" | "metadata" | "plain";

const diffHighlightMaxBytes = 65_536;
const diffHighlightMaxLines = 1_000;
const diffMetadataColor = parseColor(COLOR.muted);
const diffHunkColor = parseColor(COLOR.accent);
const addedDiffBackground = parseColor(COLOR.diffAddedBg);
const removedDiffBackground = parseColor(COLOR.diffRemovedBg);
const diffTextColor = parseColor(COLOR.markdownText);
const decoratedDiffRenderables = new WeakSet<CodeRenderable>();

function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (/^(?:diff |index |--- |\+\+\+ |new file |deleted file |similarity |rename from |rename to )/.test(line)) return "metadata";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  if (line.startsWith(" ")) return "context";
  return "plain";
}

function diffPathLanguage(path: string): string | undefined {
  const normalized = path.trim().replace(/^"|"$/g, "").replace(/^[ab]\//, "");
  if (!normalized || normalized === "/dev/null") return undefined;
  const filename = normalized.split("/").at(-1)?.toLowerCase() ?? "";
  if (filename === "dockerfile") return "dockerfile";
  if (filename === "makefile") return "makefile";
  const extension = filename.includes(".") ? filename.split(".").at(-1) : undefined;
  if (!extension) return undefined;
  const aliases: Record<string, string> = {
    cjs: "javascript",
    htm: "html",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    py: "python",
    rs: "rust",
    sh: "bash",
    ts: "typescript",
    tsx: "typescript",
    yml: "yaml"
  };
  return aliases[extension] ?? extension;
}

function diffLanguageFromHeader(line: string): string | undefined {
  if (line.startsWith("diff --git ")) {
    const path = line.trim().split(/\s+/).at(-1) ?? "";
    return diffPathLanguage(path);
  }
  if (!line.startsWith("+++ ") && !line.startsWith("--- ")) return undefined;
  const path = line.slice(4).split("\t", 1)[0] ?? "";
  return diffPathLanguage(path);
}

function splitHighlightedLines(chunks: TextChunk[]): TextChunk[][] {
  const lines: TextChunk[][] = [[]];
  for (const chunk of chunks) {
    for (const part of chunk.text.split(/(\n)/).filter(Boolean)) {
      if (part === "\n") lines.push([]);
      else lines.at(-1)!.push({ ...chunk, text: part });
    }
  }
  return lines;
}

async function diffSyntaxLines(content: string): Promise<Map<number, TextChunk[]>> {
  const lines = content.split("\n");
  const eligible = lines.filter((line) => {
    const kind = diffLineKind(line);
    return kind === "added" || kind === "removed" || kind === "context";
  });
  if (eligible.length > diffHighlightMaxLines || eligible.reduce((sum, line) => sum + line.length, 0) > diffHighlightMaxBytes) {
    return new Map();
  }

  const highlighted = new Map<number, TextChunk[]>();
  let language: string | undefined;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.startsWith("diff --git ") || line.startsWith("+++ ") || line.startsWith("--- ")) {
      language = diffLanguageFromHeader(line);
    }
    const kind = diffLineKind(line);
    if (kind !== "added" && kind !== "removed" && kind !== "context") {
      index += 1;
      continue;
    }

    const sourceIndexes: number[] = [];
    const sourceLines: string[] = [];
    let cursor = index;
    while (cursor < lines.length) {
      const sourceKind = diffLineKind(lines[cursor]!);
      if (sourceKind !== "added" && sourceKind !== "removed" && sourceKind !== "context") break;
      sourceIndexes.push(cursor);
      sourceLines.push(lines[cursor]!.slice(1));
      cursor += 1;
    }
    const source = sourceLines.join("\n");
    const chunks = language
      ? await highlightCodeFallback(source, language)
      : await highlightCodeAutoFallback(source);
    if (chunks) {
      const syntaxLines = splitHighlightedLines(chunks);
      if (syntaxLines.length === sourceLines.length) {
        for (let lineIndex = 0; lineIndex < sourceIndexes.length; lineIndex += 1) {
          highlighted.set(sourceIndexes[lineIndex]!, syntaxLines[lineIndex]!);
        }
      }
    }
    index = cursor;
  }
  return highlighted;
}

function diffPlainChunk(text: string, fg = diffTextColor): TextChunk {
  return { __isChunk: true, text, fg };
}

export async function styleDiffContent(content: string): Promise<TextChunk[]> {
  const lines = content.split("\n");
  const syntaxLines = await diffSyntaxLines(content);
  const output: TextChunk[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const kind = diffLineKind(line);
    if (kind === "metadata") {
      output.push(diffPlainChunk(line, diffMetadataColor));
    } else if (kind === "hunk") {
      output.push(diffPlainChunk(line, diffHunkColor));
    } else if (kind === "added" || kind === "removed" || kind === "context") {
      const background = kind === "added" ? addedDiffBackground : kind === "removed" ? removedDiffBackground : undefined;
      const prefix = diffPlainChunk(line[0] ?? "", diffTextColor);
      const body = syntaxLines.get(index) ?? [diffPlainChunk(line.slice(1))];
      output.push(background ? { ...prefix, bg: background } : prefix);
      output.push(...body.map((chunk) => background ? { ...chunk, bg: background } : chunk));
    } else {
      output.push(diffPlainChunk(line));
    }
    if (index < lines.length - 1) output.push(diffPlainChunk("\n"));
  }
  return output;
}

export function decorateDiffBackground(renderable: CodeRenderable): void {
  if (decoratedDiffRenderables.has(renderable)) return;
  decoratedDiffRenderables.add(renderable);
  const originalRender = renderable.render.bind(renderable);
  renderable.render = (buffer, deltaTime) => {
    const lines = renderable.content.split("\n");
    const lineInfo = renderable.lineInfo;
    const sources = lineInfo.lineSources;
    for (let offset = 0; offset < renderable.height; offset += 1) {
      const visualLine = renderable.scrollY + offset;
      const source = sources[visualLine];
      if (source === undefined) break;
      const kind = diffLineKind(lines[source] ?? "");
      const background = kind === "added" ? addedDiffBackground : kind === "removed" ? removedDiffBackground : undefined;
      if (background) buffer.fillRect(renderable.screenX, renderable.screenY + offset, renderable.width, 1, background);
    }
    originalRender(buffer, deltaTime);
  };
}
