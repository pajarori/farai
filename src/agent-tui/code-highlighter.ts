import { createTextAttributes, parseColor, type TextChunk } from "@opentui/core";
import { COLOR } from "./theme";

type HighlightNode = string | {
  scope?: string;
  children: HighlightNode[];
};

type HighlightModule = typeof import("highlight.js");

type ChunkStyle = Pick<TextChunk, "fg" | "bg" | "attributes">;

const textColor = parseColor(COLOR.text);
const mutedColor = parseColor(COLOR.muted);
const dimColor = parseColor(COLOR.dim);
const accentColor = parseColor(COLOR.accent);
const successColor = parseColor(COLOR.success);
const warningColor = parseColor(COLOR.warning);
const errorColor = parseColor(COLOR.error);
const addedBackground = parseColor(COLOR.diffAddedBg);
const removedBackground = parseColor(COLOR.diffRemovedBg);
const italicAttributes = createTextAttributes({ italic: true });
const boldAttributes = createTextAttributes({ bold: true });
const dimItalicAttributes = createTextAttributes({ dim: true, italic: true });
const fallbackCache = new Map<string, TextChunk[]>();
let highlighterPromise: Promise<HighlightModule | null> | undefined;
const autoLanguages = [
  "typescript",
  "javascript",
  "python",
  "bash",
  "json",
  "html",
  "css",
  "yaml",
  "sql",
  "rust",
  "go",
  "c",
  "cpp",
  "csharp",
  "dockerfile",
  "java",
  "kotlin",
  "php",
  "powershell",
  "ruby",
  "swift",
  "xml"
] as const;

function loadHighlighter(): Promise<HighlightModule | null> {
  highlighterPromise ??= import("highlight.js").catch(() => null);
  return highlighterPromise;
}

function styleForScope(scope: string | undefined, inherited: ChunkStyle): ChunkStyle {
  if (!scope) return inherited;
  const names = scope.split(".");
  const primary = names[0] ?? scope;
  if (primary === "comment" || primary === "quote") return { ...inherited, fg: dimColor, attributes: dimItalicAttributes };
  if (primary === "doctag") return { ...inherited, fg: mutedColor, attributes: italicAttributes };
  if (primary === "keyword" || primary === "meta" || primary === "selector-tag") return { ...inherited, fg: accentColor };
  if (primary === "string" || primary === "regexp" || primary === "template-tag") return { ...inherited, fg: successColor };
  if (primary === "subst" || primary === "template-variable") return { ...inherited, fg: accentColor };
  if (primary === "number" || primary === "literal" || primary === "symbol" || primary === "bullet") return { ...inherited, fg: warningColor };
  if (primary === "title" || primary === "function" || primary === "section") {
    return names.includes("class")
      ? { ...inherited, fg: accentColor, attributes: boldAttributes }
      : { ...inherited, fg: accentColor };
  }
  if (primary === "type" || primary === "class" || primary === "built_in") return { ...inherited, fg: mutedColor };
  if (primary === "attr" || primary === "attribute" || primary === "property") return { ...inherited, fg: warningColor };
  if (primary === "variable" || primary === "params" || primary === "name") return { ...inherited, fg: textColor };
  if (primary === "addition") return { ...inherited, fg: successColor, bg: addedBackground };
  if (primary === "deletion") return { ...inherited, fg: errorColor, bg: removedBackground };
  return inherited;
}

function appendNodes(nodes: HighlightNode[], chunks: TextChunk[], inherited: ChunkStyle): void {
  for (const node of nodes) {
    if (typeof node === "string") {
      if (node.length > 0) chunks.push({ __isChunk: true, text: node, ...inherited });
      continue;
    }
    appendNodes(node.children, chunks, styleForScope(node.scope, inherited));
  }
}

function cacheChunks(key: string, chunks: TextChunk[], contentLength: number): void {
  if (contentLength > 65_536) return;
  if (fallbackCache.size >= 64) fallbackCache.delete(fallbackCache.keys().next().value!);
  fallbackCache.set(key, chunks);
}

function chunksFromHighlightResult(result: { _emitter?: unknown }, content: string): TextChunk[] | undefined {
  const root = (result._emitter as { root?: { children?: HighlightNode[] } } | undefined)?.root;
  if (!root?.children) return undefined;
  const chunks: TextChunk[] = [];
  appendNodes(root.children, chunks, { fg: textColor });
  if (chunks.map((chunk) => chunk.text).join("") !== content) return undefined;
  return chunks;
}

export async function highlightCodeFallback(content: string, language: string): Promise<TextChunk[] | undefined> {
  const normalized = language.trim().toLowerCase();
  if (!normalized || ["text", "txt", "plain", "plaintext", "markdown", "markdown_inline", "diff", "mermaid"].includes(normalized)) {
    return undefined;
  }
  const cacheKey = `${normalized}\0${content}`;
  const cached = fallbackCache.get(cacheKey);
  if (cached) return cached;
  const module = await loadHighlighter();
  if (!module) return undefined;
  const highlighter = module.default ?? module;
  if (!highlighter.getLanguage(normalized)) return undefined;
  const result = highlighter.highlight(content, { language: normalized, ignoreIllegals: true });
  const chunks = chunksFromHighlightResult(result, content);
  if (!chunks) return undefined;
  cacheChunks(cacheKey, chunks, content.length);
  return chunks;
}

export async function highlightCodeAutoFallback(content: string): Promise<TextChunk[] | undefined> {
  if (!content.trim()) return undefined;
  const cacheKey = `auto\0${content}`;
  const cached = fallbackCache.get(cacheKey);
  if (cached) return cached;
  const module = await loadHighlighter();
  if (!module) return undefined;
  const highlighter = module.default ?? module;
  const languages = autoLanguages.filter((language) => highlighter.getLanguage(language));
  const result = highlighter.highlightAuto(content, languages);
  if (!result.language || result.relevance < 3) return undefined;
  const chunks = chunksFromHighlightResult(result, content);
  if (!chunks) return undefined;
  cacheChunks(cacheKey, chunks, content.length);
  return chunks;
}
