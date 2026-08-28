import { createHash } from "node:crypto";

export function browserObservationSignature(operation: string, output: string, contextId?: string): string {
  const normalizedOperation = operation === "browser_navigate" || operation.endsWith("_browser_navigate")
    ? "browser_navigate"
    : operation;
  const pageUrl = lastBrowserField(output, "Page URL");
  const pageTitle = lastBrowserField(output, "Page Title");
  const httpStatus = lastBrowserField(output, "HTTP status");
  const identity = normalizedOperation === "browser_navigate" && pageUrl
      ? {
        operation: normalizedOperation,
        ...(contextId ? { contextId } : {}),
        pageUrl: canonicalBrowserUrl(pageUrl),
        pageTitle: normalizeObservationText(pageTitle ?? ""),
        httpStatus: normalizeObservationText(httpStatus ?? "")
      }
      : {
        operation: normalizedOperation,
        ...(contextId ? { contextId } : {}),
        output: stableBrowserObservation(output)
      };
  return `browser:${createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 24)}`;
}

export function browserHumanOutput(output: string): string {
  const pageUrl = lastBrowserField(output, "Page URL");
  const pageTitle = lastBrowserField(output, "Page Title");
  const httpStatus = lastBrowserField(output, "HTTP status");
  const lead = [httpStatus ? normalizeHttpStatus(httpStatus) : undefined, pageTitle]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
  const body = output
    .replace(/### Ran Playwright code\s*```[\s\S]*?```/gi, "")
    .replace(/^###\s+(?:Page|Snapshot|Inline Snapshot|Snapshot Status)\s*$/gim, "")
    .replace(/^###\s+(.+)$/gm, "$1")
    .replace(/^-\s+(?:Page URL|Page Title|HTTP status):\s*.*$/gim, "")
    .replace(/^\s*-\s+Snapshot is managed internally by the browser backend\.\s*$/gim, "")
    .replace(/^\s*\[internal browser artifact\]\s*$/gim, "")
    .replace(/^\s*```(?:yaml|yml|json|js|javascript)?\s*$/gim, "")
    .replace(/\s*\[ref=[^\]]+\]/gi, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .filter((line) => line.trim().length > 0);
  return [lead || undefined, pageUrl ? `Final URL: ${pageUrl}` : undefined, ...body]
    .filter((line): line is string => Boolean(line))
    .join("\n")
    .trim();
}

export function browserProtocolWarning(operation: string, args: Record<string, unknown>, output: string): string | undefined {
  if (operation !== "browser_navigate" || typeof args.url !== "string" || !hasExactPathSemantics(args.url)) return undefined;
  const finalUrl = lastBrowserField(output, "Page URL");
  return `The requested URL contains path or encoding semantics that browser automation may normalize before transmission${finalUrl ? `; the observed page URL is ${finalUrl}` : ""}. This browser result cannot prove how the server handles the original request target. If exact verification is necessary, use http_request with mode=protocol_test and pathAsIs=true.`;
}

function lastBrowserField(output: string, field: string): string | undefined {
  const pattern = new RegExp(`^- ${field}:\\s*(.+)$`, "gim");
  const matches = [...output.matchAll(pattern)];
  return matches.at(-1)?.[1]?.trim();
}

function canonicalBrowserUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    const entries = [...url.searchParams.entries()]
      .filter(([key]) => !isBrowserCacheKey(key))
      .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
    url.search = "";
    for (const [key, child] of entries) url.searchParams.append(key, child);
    return url.toString();
  } catch {
    return normalizeObservationText(value);
  }
}

function isBrowserCacheKey(key: string): boolean {
  return ["_", "_rsc", "cachebust", "cache_bust", "timestamp", "ts"].includes(key.toLowerCase());
}

function normalizeObservationText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeHttpStatus(value: string): string {
  return /^http\b/i.test(value) ? value : `HTTP ${value}`;
}

function stableBrowserObservation(output: string): string {
  return output
    .replace(/### Ran Playwright code\s*```[\s\S]*?```/gi, "")
    .replace(/\s*\[ref=[^\]]+\]/gi, "")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27}\b/gi, "<uuid>")
    .replace(/\b[a-z]{3}\d?::[a-z0-9:-]+\b/gi, "<request-id>")
    .replace(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z\b/gi, "<timestamp>")
    .replace(/\s+/g, " ")
    .trim();
}

function hasExactPathSemantics(value: string): boolean {
  return /(?:^|[/:])\.\.(?:[/?#]|$)|%(?:00|0a|0d|25|2e|2f|5c)/i.test(value);
}
