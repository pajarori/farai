import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { cleanHtml, decodeBody, normalizeText, readBoundedBody } from "./shared";
import { backend } from "../shared/backend";

const MAX_FETCH_BYTES = 8 * 1024 * 1024;

export const internetFetchTool: ToolDefinition = {
  name: "internet_fetch",
  description: "Retrieve one public URL and extract bounded readable content from HTML, plain text, JSON, or PDF responses. Use this to read research sources found with internet_search; it does not execute page JavaScript, preserve browser state, or replace exact protocol testing with http_request.",
  inputSchema: {
    type: "object",
    required: ["url"],
    properties: { url: { type: "string" }, maxChars: { type: "number", minimum: 1000, maximum: 200000 } },
    additionalProperties: false
  },
  mutates: false,
  timeoutMs: 45_000,
  parallel: true,
  visibility: "external",
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const requested = asString(args.url, "url");
    const response = await fetch(requested, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0 Farai/0.1", accept: "text/html,application/json,text/plain,application/pdf,*/*;q=0.1" }, ...(context.signal ? { signal: context.signal } : {}) });
    if (!response.ok) throw new Error(`web fetch failed: HTTP ${response.status} ${response.statusText}`);
    const bytes = await readBoundedBody(response, MAX_FETCH_BYTES);
    const contentType = (response.headers.get("content-type") ?? "application/octet-stream").toLowerCase();
    let text: string;
    let title: string | undefined;
    if (isPdf(bytes, contentType, requested, response.url)) {
      text = await extractPdf(context, bytes);
    } else {
      const decoded = decodeBody(bytes, charset(contentType));
      if (contentType.includes("html") || /<html\b|<!doctype html/i.test(decoded.slice(0, 1000))) {
        const extracted = cleanHtml(decoded);
        text = extracted.text;
        title = extracted.title;
      } else if (contentType.includes("json")) {
        try { text = JSON.stringify(JSON.parse(decoded), null, 2); } catch { text = normalizeText(decoded); }
      } else text = normalizeText(decoded);
    }
    const maxChars = typeof args.maxChars === "number" ? Math.max(1000, Math.min(200000, Math.floor(args.maxChars))) : 30000;
    const output = text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[content truncated; ${text.length - maxChars} characters omitted]` : text;
    return {
      ok: true,
      summary: `${title ? `${title} · ` : ""}${response.url}`,
      output: output || "page contained no readable text",
      metadata: { requestedUrl: requested, finalUrl: response.url, contentType, bytes: bytes.byteLength, ...(title ? { title } : {}) }
    };
  }
};

async function extractPdf(context: Parameters<ToolDefinition["run"]>[1], bytes: Uint8Array): Promise<string> {
  const directory = join(context.workspace, ".farai", "tmp");
  mkdirSync(directory, { recursive: true });
  const name = `web-fetch-${randomUUID()}.pdf`;
  const path = join(directory, name);
  writeFileSync(path, bytes);
  try {
    const backendPath = context.executionBackend?.kind === "host" ? path : `/workspace/.farai/tmp/${name}`;
    const result = await backend(context).exec(`pdftotext -layout -- '${backendPath.replaceAll("'", `'"'"'`)}' -`, 30_000, context.signal, 4_000_000);
    if (result.exitCode !== 0) throw new Error(result.stderr || "failed to extract fetched PDF text");
    return normalizeText(result.stdout);
  } finally {
    try { unlinkSync(path); } catch { }
  }
}

function isPdf(bytes: Uint8Array, contentType: string, requestedUrl: string, finalUrl: string): boolean {
  return contentType.includes("application/pdf")
    || requestedUrl.toLowerCase().split(/[?#]/, 1)[0]?.endsWith(".pdf") === true
    || finalUrl.toLowerCase().split(/[?#]/, 1)[0]?.endsWith(".pdf") === true
    || Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "%PDF-";
}

function charset(contentType: string): string {
  return contentType.match(/charset=([^;\s]+)/i)?.[1]?.replace(/["']/g, "") || "utf-8";
}
