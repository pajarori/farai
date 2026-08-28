export type NmapRow = { port: string; proto: string; state: string; service: string; version: string };

export function parseNmap(text: string): NmapRow[] {
  const rows: NmapRow[] = [];
  for (const line of text.split("\n")) {
    const match = line.trim().match(/^(\d+)\/(tcp|udp)\s+(open|closed|filtered|open\|filtered)\s+(\S+)(?:\s+(.*))?$/i);
    if (!match) continue;
    rows.push({ port: match[1]!, proto: match[2]!, state: match[3]!, service: match[4]!, version: match[5] ?? "" });
  }
  return rows;
}

export type DirRow = { url: string; status: number; size: number };

export function parseDirectoryResults(text: string): DirRow[] {
  try {
    const parsed = JSON.parse(text) as { results?: Array<Record<string, unknown>> };
    return (parsed.results ?? []).map((item) => ({
      url: String(item.url ?? item.input ?? ""),
      status: Number(item.status ?? 0),
      size: Number(item.length ?? item.size ?? 0)
    })).filter((row) => row.url).sort((a, b) => a.status - b.status || b.size - a.size);
  } catch { return []; }
}

export function splitHttpResponse(text: string): { status?: string; headers: string; body: string; contentType?: string } {
  const normalized = text.replaceAll("\r\n", "\n");
  const boundary = normalized.indexOf("\n\n");
  if (boundary < 0 || !normalized.startsWith("HTTP/")) return { headers: "", body: text };
  const headers = normalized.slice(0, boundary);
  const status = headers.split("\n")[0];
  const contentTypeLine = headers.split("\n").find((line) => /^content-type:/i.test(line));
  const contentType = contentTypeLine?.slice(contentTypeLine.indexOf(":") + 1).trim();
  return {
    headers,
    body: normalized.slice(boundary + 2),
    ...(status ? { status } : {}),
    ...(contentType ? { contentType } : {})
  };
}

export function unifiedEditDiff(path: string, oldText: string, newText: string): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`)
  ].join("\n");
}
