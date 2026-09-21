export type HttpResponseBlock = {
  statusLine: string;
  statusCode?: number;
  headers: string;
  body: string;
  start: number;
  kind: "proxy_connect" | "origin";
};

export type HttpResponseChain = {
  blocks: HttpResponseBlock[];
  proxyHandshake?: HttpResponseBlock;
  origin?: HttpResponseBlock;
  originText: string;
};

const STATUS_LINE_RE = /^HTTP\/\S+\s+\d{3}(?:\s+[^\r\n]*)?/gm;

export function parseHttpResponseChain(value: string): HttpResponseChain {
  const starts = [...value.matchAll(STATUS_LINE_RE)].map((match) => match.index ?? 0);
  if (starts.length === 0) return { blocks: [], originText: value };
  const blocks = starts.map((start, index) => httpResponseBlock(value, start, starts[index + 1] ?? value.length));
  const proxyHandshake = blocks.find((block) => block.kind === "proxy_connect");
  const origin = [...blocks].reverse().find((block) => block.kind === "origin");
  return {
    blocks,
    ...(proxyHandshake ? { proxyHandshake } : {}),
    ...(origin ? { origin } : {}),
    originText: origin ? value.slice(origin.start) : value
  };
}

function httpResponseBlock(value: string, start: number, end: number): HttpResponseBlock {
  const segment = value.slice(start, end);
  const normalized = segment.replaceAll("\r\n", "\n");
  const boundary = normalized.indexOf("\n\n");
  const headers = boundary === -1 ? normalized.trimEnd() : normalized.slice(0, boundary).trimEnd();
  const body = boundary === -1 ? "" : normalized.slice(boundary + 2);
  const statusLine = headers.split("\n", 1)[0] ?? "";
  const statusCode = Number(statusLine.match(/^HTTP\/\S+\s+(\d{3})/)?.[1]);
  const kind = /\s200\s+connection established\s*$/i.test(statusLine) ? "proxy_connect" : "origin";
  return {
    statusLine,
    ...(Number.isFinite(statusCode) ? { statusCode } : {}),
    headers,
    body,
    start,
    kind
  };
}
