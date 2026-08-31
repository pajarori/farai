import type { ToolDefinition } from "../../types";
import { loadConfig } from "../../agent-core/config";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { takeBytes } from "../shared/output-bound";
import { boundedLimit, cleanHtml, collapse, decodeBody, readBoundedBody, stripTags } from "./shared";
import { decodeHTML } from "entities";
import { discardResponseBody } from "../../http-response";

type SearchHit = { title: string; url: string; snippet: string; source: string };
type SearchProvider = "searxng" | "duckduckgo" | "yahoo" | "bing";
type ProviderAttempt = { provider: SearchProvider; search: () => Promise<SearchHit[]> };
const MAX_SEARCH_RESPONSE_BYTES = 4 * 1024 * 1024;
const SEARCH_HEADERS = { "user-agent": "Mozilla/5.0 (compatible; Farai/0.1; +https://github.com/pajarori/farai)", accept: "text/html" };

export const internetSearchTool: ToolDefinition = {
  name: "internet_search",
  description: "Search the current public internet for a query and return ranked result titles, URLs, snippets, and source attribution. Use this for discovery and time-sensitive research; select a result and call internet_fetch to read it, rather than constructing search-engine result URLs manually.",
  inputSchema: {
    type: "object",
    required: ["query"],
    properties: { query: { type: "string" }, limit: { type: "number", minimum: 1, maximum: 20 } },
    additionalProperties: false
  },
  mutates: false,
  timeoutMs: 30_000,
  parallel: true,
  visibility: "external",
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const query = asString(args.query, "query").trim();
    if (!query) throw new Error("query must not be empty");
    const limit = boundedLimit(args.limit);
    const searchLimit = Math.min(20, Math.max(10, limit * 3));
    const config = loadConfig(context.rootWorkspace ?? context.workspace).web;
    const backend = config?.searchBackend ?? "auto";
    const attempts: ProviderAttempt[] = [];
    if (backend === "searxng" && !config?.searxngUrl) throw new Error("web.search_backend=searxng requires web.searxng_url");
    if ((backend === "auto" || backend === "searxng") && config?.searxngUrl) {
      attempts.push({ provider: "searxng", search: () => searxng(config.searxngUrl!, query, searchLimit, context.signal) });
    }
    if (backend === "auto" || backend === "duckduckgo") {
      attempts.push({ provider: "duckduckgo", search: () => duckduckgo(query, searchLimit, context.signal) });
    }
    if (backend === "auto" || backend === "yahoo") {
      attempts.push({ provider: "yahoo", search: () => yahoo(query, searchLimit, context.signal) });
    }
    if (backend === "auto" || backend === "bing") {
      attempts.push({ provider: "bing", search: () => bing(query, searchLimit, context.signal) });
    }

    const failures: Array<{ provider: SearchProvider; error: string }> = [];
    const emptyProviders: SearchProvider[] = [];
    for (const attempt of attempts) {
      try {
        const hits = rankHits((await attempt.search()).map(boundSearchHit), query).slice(0, limit);
        if (hits.length === 0) {
          emptyProviders.push(attempt.provider);
          continue;
        }
        const output = hits.map((hit, index) => `${index + 1}. ${hit.title}\n   ${hit.url}\n   ${hit.snippet}\n   source: ${hit.source}`).join("\n\n");
        return {
          ok: true,
          summary: `${hits.length} web results via ${attempt.provider}`,
          output,
          metadata: { provider: attempt.provider, results: hits, failures, emptyProviders }
        };
      } catch (error) {
        if (context.signal?.aborted) throw error;
        failures.push({ provider: attempt.provider, error: errorMessage(error) });
      }
    }

    if (emptyProviders.length > 0) {
      return {
        ok: true,
        summary: `0 web results after ${attempts.length} provider${attempts.length === 1 ? "" : "s"}`,
        output: "no results",
        metadata: { results: [], failures, emptyProviders }
      };
    }
    const detail = failures.map((failure) => `${failure.provider}: ${failure.error}`).join("; ");
    throw new Error(`web search failed after ${failures.length} provider${failures.length === 1 ? "" : "s"}: ${detail}`);
  }
};

async function searxng(base: string, query: string, limit: number, signal?: AbortSignal): Promise<SearchHit[]> {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/search`;
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  const response = await fetch(url, { headers: { accept: "application/json" }, ...(signal ? { signal } : {}) });
  if (!response.ok) {
    await discardResponseBody(response);
    throw new Error(`searxng search failed: HTTP ${response.status}`);
  }
  const body = JSON.parse(decodeBody(await readBoundedBody(response, MAX_SEARCH_RESPONSE_BYTES))) as { results?: Array<Record<string, unknown>> };
  return (body.results ?? []).flatMap((item) => {
    const url = typeof item.url === "string" ? item.url : undefined;
    if (!url) return [];
    return [{ title: String(item.title ?? url), url, snippet: collapse(String(item.content ?? "")), source: "searxng" }];
  }).slice(0, limit);
}

async function duckduckgo(query: string, limit: number, signal?: AbortSignal): Promise<SearchHit[]> {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);
  const response = await fetch(url, { headers: SEARCH_HEADERS, ...(signal ? { signal } : {}) });
  if (!response.ok) {
    await discardResponseBody(response);
    throw new Error(`duckduckgo search failed: HTTP ${response.status}`);
  }
  const html = decodeBody(await readBoundedBody(response, MAX_SEARCH_RESPONSE_BYTES));
  return parseDuckDuckGoResults(html, limit);
}

export function parseDuckDuckGoResults(html: string, limit: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const anchors = [...html.matchAll(/<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index]!;
    let target = decodeHTML(anchor[1] ?? "");
    try {
      const parsed = new URL(target, "https://duckduckgo.com");
      target = parsed.searchParams.get("uddg") ?? parsed.toString();
    } catch { continue; }
    const start = anchor.index ?? 0;
    const end = anchors[index + 1]?.index ?? html.length;
    const block = html.slice(start, end);
    const snippet = block.match(/<(a|div)\b[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/\1>/i)?.[2] ?? "";
    hits.push({ title: htmlText(anchor[2] ?? target), url: target, snippet: htmlText(snippet), source: "duckduckgo" });
    if (hits.length >= limit) break;
  }
  if (hits.length) return hits;
  const text = cleanHtml(html).text.toLowerCase();
  if (text.includes("no results") || text.includes("did not match any documents")) return [];
  if (isBlockedSearchPage(text)) throw new Error("duckduckgo returned a block or verification page");
  throw new Error("duckduckgo returned no parseable search results");
}

async function yahoo(query: string, limit: number, signal?: AbortSignal): Promise<SearchHit[]> {
  const url = new URL("https://search.yahoo.com/search");
  url.searchParams.set("p", query);
  url.searchParams.set("nojs", "1");
  const response = await fetch(url, { headers: SEARCH_HEADERS, ...(signal ? { signal } : {}) });
  if (!response.ok) {
    await discardResponseBody(response);
    throw new Error(`yahoo search failed: HTTP ${response.status}`);
  }
  const html = decodeBody(await readBoundedBody(response, MAX_SEARCH_RESPONSE_BYTES));
  return parseYahooResults(html, limit);
}

export function parseYahooResults(html: string, limit: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const matches = [...html.matchAll(/<a\b([^>]*href="https:\/\/r\.search\.yahoo\.com\/[^"]+"[^>]*)>[\s\S]*?<h3\b[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<\/a>/gi)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const rawHref = match[1]?.match(/\bhref="([^"]+)"/i)?.[1];
    const target = rawHref ? decodeYahooTarget(decodeHTML(rawHref)) : undefined;
    if (!target) continue;
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? html.length;
    const block = html.slice(start, end);
    const snippet = block.match(/<div[^>]*class="[^"]*\bcompText\b[^"]*"[^>]*>[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "";
    const title = htmlText(match[2] ?? target);
    if (/^(including results for|search instead for)\b/i.test(title)) continue;
    hits.push({ title, url: target, snippet: htmlText(snippet), source: "yahoo" });
    if (hits.length >= limit) break;
  }
  if (hits.length) return hits;
  const text = cleanHtml(html).text.toLowerCase();
  if (text.includes("we did not find results for") || text.includes("no results found for")) return [];
  if (isBlockedSearchPage(text) || text.includes("search temporarily unavailable")) throw new Error("yahoo returned a block or temporary failure page");
  throw new Error("yahoo returned no parseable search results");
}

async function bing(query: string, limit: number, signal?: AbortSignal): Promise<SearchHit[]> {
  const url = new URL("https://www.bing.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(limit));
  const response = await fetch(url, { headers: SEARCH_HEADERS, ...(signal ? { signal } : {}) });
  if (!response.ok) {
    await discardResponseBody(response);
    throw new Error(`bing search failed: HTTP ${response.status}`);
  }
  const html = decodeBody(await readBoundedBody(response, MAX_SEARCH_RESPONSE_BYTES));
  return parseBingResults(html, limit);
}

export function parseBingResults(html: string, limit: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const blocks = html.match(/<li[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>[\s\S]*?<\/li>/gi) ?? [];
  for (const block of blocks) {
    const heading = block.match(/<h2\b[^>]*>[\s\S]*?<a\b([^>]*)>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/i);
    const rawHref = heading?.[1]?.match(/\bhref="([^"]+)"/i)?.[1];
    if (!heading || !rawHref) continue;
    const target = decodeBingTarget(decodeHTML(rawHref));
    if (!target) continue;
    const snippet = block.match(/<div[^>]*class="[^"]*\bb_caption\b[^"]*"[^>]*>[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "";
    hits.push({
      title: htmlText(heading[2] ?? target),
      url: target,
      snippet: htmlText(snippet),
      source: "bing"
    });
    if (hits.length >= limit) break;
  }
  if (hits.length) return hits;
  const text = cleanHtml(html).text.toLowerCase();
  if (text.includes("there are no results for") || text.includes("no results found for")) return [];
  if (isBlockedSearchPage(text)) throw new Error("bing returned a block or verification page");
  throw new Error("bing returned no parseable search results");
}

function decodeBingTarget(value: string): string | undefined {
  try {
    const parsed = new URL(value, "https://www.bing.com");
    const encoded = parsed.hostname.endsWith("bing.com") && parsed.pathname === "/ck/a" ? parsed.searchParams.get("u") : undefined;
    if (encoded?.startsWith("a1")) {
      const base64 = encoded.slice(2).replace(/-/g, "+").replace(/_/g, "/");
      const decoded = Buffer.from(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="), "base64").toString("utf8");
      const target = new URL(decoded);
      if (target.protocol === "http:" || target.protocol === "https:") return target.toString();
    }
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.toString();
  } catch {}
  return undefined;
}

function decodeYahooTarget(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    const encoded = parsed.pathname.match(/\/RU=([^/]+)\/RK=/)?.[1];
    if (!encoded) return undefined;
    const target = new URL(decodeURIComponent(encoded));
    if (target.protocol === "http:" || target.protocol === "https:") return target.toString();
  } catch {}
  return undefined;
}

function isBlockedSearchPage(text: string): boolean {
  return ["captcha", "verify you are human", "verify you're human", "unusual traffic", "access denied", "temporarily blocked"].some((marker) => text.includes(marker));
}

function htmlText(value: string): string {
  return collapse(decodeHTML(stripTags(value))).replace(/\s+([,.;:!?])/g, "$1");
}

function rankHits(hits: SearchHit[], query: string): SearchHit[] {
  const phrase = query.toLowerCase();
  const terms = phrase.match(/[\p{L}\p{N}_.-]+/gu) ?? [];
  return hits
    .map((hit, index) => {
      const title = hit.title.toLowerCase();
      const url = decodeURIComponentSafe(hit.url).toLowerCase();
      const snippet = hit.snippet.toLowerCase();
      let score = (title.includes(phrase) ? 12 : 0) + (url.includes(phrase) ? 10 : 0) + (snippet.includes(phrase) ? 3 : 0);
      for (const term of terms) score += (title.includes(term) ? 4 : 0) + (url.includes(term) ? 3 : 0) + (snippet.includes(term) ? 1 : 0);
      return { hit, index, score };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ hit }) => hit);
}

function decodeURIComponentSafe(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function boundSearchHit(hit: SearchHit): SearchHit {
  return {
    title: takeBytes(hit.title, 500, "head"),
    url: takeBytes(hit.url, 4_000, "head"),
    snippet: takeBytes(hit.snippet, 2_000, "head"),
    source: takeBytes(hit.source, 100, "head")
  };
}
