import { readBoundedResponseJson, readBoundedResponseText, writeBoundedResponseToFile } from "../../http-response";

const KNOWLEDGE_FETCH_TIMEOUT_MS = 5 * 60 * 1_000;
const KNOWLEDGE_USER_AGENT = "farai-knowledge-ingest";

export async function fetchKnowledgeJson(url: string, maxBytes: number, label: string): Promise<unknown> {
  const response = await fetchKnowledgeResponse(url);
  return await readBoundedResponseJson(response, maxBytes, label);
}

export async function fetchKnowledgeText(url: string, maxBytes: number, label: string): Promise<string> {
  const response = await fetchKnowledgeResponse(url);
  return await readBoundedResponseText(response, maxBytes, label);
}

export async function downloadKnowledgeFile(url: string, path: string, maxBytes: number, label: string): Promise<number> {
  const response = await fetchKnowledgeResponse(url);
  return await writeBoundedResponseToFile(response, path, maxBytes, label);
}

async function fetchKnowledgeResponse(url: string): Promise<Response> {
  const response = await fetch(url, {
    headers: { "user-agent": KNOWLEDGE_USER_AGENT },
    signal: AbortSignal.timeout(KNOWLEDGE_FETCH_TIMEOUT_MS)
  });
  if (response.ok) return response;
  try { await response.body?.cancel(); } catch {}
  throw new Error(`fetch failed ${response.status}: ${url}`);
}
