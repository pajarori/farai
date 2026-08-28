export type MarkdownChunk = {
  headingPath: string[];
  body: string;
  charStart: number;
  charEnd: number;
};

const INCLUDE_MACRO = /^[ \t]*\{\{#include\s+[^}]*\}\}[ \t]*$/gm;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

export function chunkMarkdownByHeading(source: string, options: { minBytes?: number; maxBytes?: number } = {}): MarkdownChunk[] {
  const minBytes = options.minBytes ?? 200;
  const maxBytes = options.maxBytes ?? 3500;
  const text = source.replace(/\r\n/g, "\n").replace(INCLUDE_MACRO, "");
  const lines = text.split("\n");
  const chunks: MarkdownChunk[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  let offset = 0;
  let sectionStart = 0;
  let sectionLines: string[] = [];
  let sectionHeadingPath: string[] = [];

  const flush = (endOffset: number) => {
    const body = sectionLines.join("\n").trim();
    if (body) appendChunk(chunks, sectionHeadingPath, body, sectionStart, endOffset, minBytes, maxBytes);
    sectionLines = [];
  };

  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    const heading = HEADING.exec(line);
    if (heading) {
      flush(offset);
      const level = heading[1]!.length;
      const title = heading[2]!.trim();
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, title });
      sectionHeadingPath = stack.map((item) => item.title);
      sectionStart = offset;
      sectionLines = [line];
    } else {
      if (sectionLines.length === 0) sectionStart = offset;
      sectionLines.push(line);
    }
    offset += lineBytes;
  }
  flush(offset);
  return chunks;
}

function appendChunk(chunks: MarkdownChunk[], headingPath: string[], body: string, start: number, end: number, minBytes: number, maxBytes: number): void {
  if (Buffer.byteLength(body, "utf8") <= maxBytes) {
    mergeOrPush(chunks, { headingPath, body, charStart: start, charEnd: end }, minBytes);
    return;
  }
  for (const part of splitOversized(body, maxBytes)) {
    mergeOrPush(chunks, { headingPath, body: part, charStart: start, charEnd: end }, minBytes);
  }
}

function mergeOrPush(chunks: MarkdownChunk[], chunk: MarkdownChunk, minBytes: number): void {
  const previous = chunks[chunks.length - 1];
  if (previous && Buffer.byteLength(previous.body, "utf8") < minBytes && sameHeading(previous.headingPath, chunk.headingPath)) {
    previous.body = `${previous.body}\n${chunk.body}`.trim();
    previous.charEnd = chunk.charEnd;
    return;
  }
  chunks.push(chunk);
}

function sameHeading(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function splitOversized(body: string, maxBytes: number): string[] {
  const paragraphs = body.split(/\n{2,}/);
  const out: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (Buffer.byteLength(candidate, "utf8") > maxBytes && current) {
      out.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) out.push(current);
  return out.length ? out : [body];
}
