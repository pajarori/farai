import {
  CodeRenderable,
  createTextAttributes,
  parseColor,
  type BaseRenderable,
  type ChunkRenderContext,
  type MarkdownOptions,
  type MarkdownRenderable,
  type MarkdownTableOptions,
  type TextChunk
} from "@opentui/core";
import { createEffect, onCleanup, onMount, type JSX } from "solid-js";
import { highlightCodeFallback } from "./code-highlighter";
import { normalizeTaskListMarkers, styleMermaidContent, styleTaskGlyphs, styleUnorderedListGlyphs } from "./markdown-content";
import { decorateDiffBackground, styleDiffContent } from "./markdown-diff";
import { decorateMarkdownLayout } from "./markdown-layout";
import { markdownStrikethroughSentinel, markdownSyntax } from "./syntax";
import { COLOR } from "./theme";

type MarkdownViewProps = {
  content: string;
  streaming?: boolean;
  fg?: string;
  id?: string;
};

const markdownTableOptions: MarkdownTableOptions = {
  style: "columns",
  widthMode: "content",
  columnFitter: "balanced",
  wrapMode: "word",
  cellPaddingX: 1,
  cellPaddingY: 0,
  borders: false,
  outerBorder: false,
  selectable: true
};

const markdownRenderNode = Object.assign(((token, context) => {
  const renderable = context.defaultRender();
  if (token.type === "code" && renderable instanceof CodeRenderable && renderable.filetype === "diff") {
    diffCodeRenderables.add(renderable);
    decorateDiffBackground(renderable);
    renderable.conceal = false;
    renderable.filetype = "markdown";
  }
  if (token.type === "code" && renderable instanceof CodeRenderable && renderable.filetype === "mermaid") {
    mermaidCodeRenderables.add(renderable);
    renderable.conceal = false;
    renderable.filetype = "markdown";
  }
  if (renderable instanceof CodeRenderable) enhanceMarkdownChunks(renderable);
  return renderable;
}) satisfies NonNullable<MarkdownOptions["renderNode"]>, { codeBlockOnly: true });

const strikethroughColor = parseColor(markdownStrikethroughSentinel);
const strikethroughAttributes = createTextAttributes({ strikethrough: true });
const enhancedCodeRenderables = new WeakSet<CodeRenderable>();
const diffCodeRenderables = new WeakSet<CodeRenderable>();
const mermaidCodeRenderables = new WeakSet<CodeRenderable>();

function enhanceMarkdownChunks(renderable: CodeRenderable): void {
  if (enhancedCodeRenderables.has(renderable)) return;
  enhancedCodeRenderables.add(renderable);
  const previous = renderable.onChunks;
  renderable.onChunks = async (chunks: TextChunk[], context: ChunkRenderContext) => {
    const transformed = await previous?.(chunks, context) ?? chunks;
    if (diffCodeRenderables.has(renderable)) return styleDiffContent(context.content);
    if (mermaidCodeRenderables.has(renderable)) return styleMermaidContent(transformed, context.content);
    if (context.highlights.length === 0) {
      const fallback = await highlightCodeFallback(context.content, context.filetype);
      if (fallback) return fallback;
    }
    const struck = transformed.map((chunk) => chunk.fg?.equals(strikethroughColor)
      ? { ...chunk, fg: renderable.fg, attributes: (chunk.attributes ?? 0) | strikethroughAttributes }
      : chunk);
    const tasks = styleTaskGlyphs(struck);
    return context.filetype === "markdown" ? styleUnorderedListGlyphs(tasks) : tasks;
  };
}

function enableTextFallback(renderable: BaseRenderable | null | undefined): void {
  if (renderable instanceof CodeRenderable) {
    enhanceMarkdownChunks(renderable);
    const resetStreaming = renderable.streaming && !renderable.drawUnstyledText;
    renderable.drawUnstyledText = true;
    if (resetStreaming) {
      renderable.streaming = false;
      renderable.streaming = true;
      renderable.requestRender();
    }
    return;
  }
  if (!renderable) return;
  if (decorateMarkdownLayout(renderable)) return;
  for (const child of renderable.getChildren()) enableTextFallback(child);
}

export function MarkdownView(props: MarkdownViewProps): JSX.Element {
  let markdownRef: MarkdownRenderable | undefined;
  let fallbackGeneration = 0;
  const renderStreaming = () => props.streaming === true;

  createEffect(() => {
    void props.content;
    void renderStreaming();
    const generation = ++fallbackGeneration;
    queueMicrotask(() => {
      if (generation !== fallbackGeneration || !markdownRef || markdownRef.isDestroyed) return;
      enableTextFallback(markdownRef);
    });
  });

  onMount(() => {
    if (!markdownRef || markdownRef.isDestroyed) return;
    markdownRef.refreshStyles();
  });

  onCleanup(() => {
    fallbackGeneration += 1;
  });

  return (
    <markdown
      ref={(renderable) => {
        markdownRef = renderable;
      }}
      {...(props.id ? { id: props.id } : {})}
      width="100%"
      internalBlockMode="coalesced"
      conceal={true}
      concealCode={false}
      syntaxStyle={markdownSyntax(props.fg ?? COLOR.markdownText)}
      tableOptions={markdownTableOptions}
      renderNode={markdownRenderNode}
      fg={props.fg ?? COLOR.markdownText}
      content={normalizeTaskListMarkers(props.content)}
      streaming={renderStreaming()}
    />
  );
}
