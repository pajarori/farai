import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";

export type ProxyFlowKind = "http" | "websocket" | "tcp" | "udp" | "dns";

type ProxyFlowBase = {
  id: string;
  kind: ProxyFlowKind;
  timestamp: string;
  method: string;
  url: string;
  host: string;
  path: string;
  status?: number;
  contentType?: string;
  requestBytes?: number;
  responseBytes?: number;
  durationMs?: number;
  error?: string;
};

export type ProxyHttpFlowSummary = ProxyFlowBase & { kind: "http" };
export type ProxyWebSocketFlowSummary = ProxyFlowBase & {
  kind: "websocket";
  messageCount: number;
  closeCode?: number;
  closeReason?: string;
  closedByClient?: boolean;
};
export type ProxyTcpFlowSummary = ProxyFlowBase & { kind: "tcp"; messageCount: number; tls?: boolean };
export type ProxyUdpFlowSummary = ProxyFlowBase & { kind: "udp"; messageCount: number; dtls?: boolean };
export type ProxyDnsFlowSummary = ProxyFlowBase & {
  kind: "dns";
  queryName: string;
  queryType?: string;
  responseCode?: number;
  answerCount: number;
};

export type ProxyFlowSummary =
  | ProxyHttpFlowSummary
  | ProxyWebSocketFlowSummary
  | ProxyTcpFlowSummary
  | ProxyUdpFlowSummary
  | ProxyDnsFlowSummary;

export type ProxyHttpMessage = {
  httpVersion?: string;
  headers: Array<{ name: string; value: string }>;
  bodyText?: string;
  bodyBase64?: string;
  bodyTruncated?: boolean;
  bodyBytes?: number;
};

export type ProxyEndpoint = { host: string; port?: number; label: string };

export type ProxyStreamMessage = {
  direction: "client" | "server";
  timestamp: string;
  messageType?: string;
  contentText?: string;
  contentBase64?: string;
  contentBytes: number;
  truncated?: boolean;
  dropped?: boolean;
  injected?: boolean;
};

export type ProxyDnsQuestion = { name: string; type?: string; class?: string };
export type ProxyDnsRecord = { name: string; type?: string; class?: string; ttl?: number; data?: string };
export type ProxyDnsMessage = {
  id?: number;
  query: boolean;
  responseCode?: number;
  questions: ProxyDnsQuestion[];
  answers: ProxyDnsRecord[];
  authorities: ProxyDnsRecord[];
  additionals: ProxyDnsRecord[];
};

export type ProxyHttpFlowDetail = ProxyHttpFlowSummary & {
  request: ProxyHttpMessage;
  response?: ProxyHttpMessage & { status?: number; reason?: string };
};
export type ProxyWebSocketFlowDetail = ProxyWebSocketFlowSummary & {
  handshake: {
    request: ProxyHttpMessage;
    response?: ProxyHttpMessage & { status?: number; reason?: string };
  };
  messages: ProxyStreamMessage[];
};
export type ProxyTcpFlowDetail = ProxyTcpFlowSummary & {
  client?: ProxyEndpoint;
  server?: ProxyEndpoint;
  messages: ProxyStreamMessage[];
};
export type ProxyUdpFlowDetail = ProxyUdpFlowSummary & {
  client?: ProxyEndpoint;
  server?: ProxyEndpoint;
  messages: ProxyStreamMessage[];
};
export type ProxyDnsFlowDetail = ProxyDnsFlowSummary & {
  client?: ProxyEndpoint;
  server?: ProxyEndpoint;
  request: ProxyDnsMessage;
  response?: ProxyDnsMessage;
};

export type ProxyFlowDetail =
  | ProxyHttpFlowDetail
  | ProxyWebSocketFlowDetail
  | ProxyTcpFlowDetail
  | ProxyUdpFlowDetail
  | ProxyDnsFlowDetail;

export type ProxyFlowQuery = {
  serviceName?: string;
  sinceId?: string;
  limit?: number;
  filter?: string;
  kind?: ProxyFlowKind;
  method?: string;
  statusClass?: number;
};

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1_000;

export async function readProxyFlows(file: string, query: ProxyFlowQuery = {}): Promise<ProxyFlowSummary[]> {
  if (!existsSync(file)) return [];
  const text = await readFile(file, "utf8");
  const flows: ProxyFlowSummary[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = normalizeFlow(JSON.parse(trimmed));
      if (parsed) flows.push(parsed);
    } catch {
    }
  }
  return filterProxyFlows(flows, query);
}

export async function readProxyFlowDetail(file: string, id: string): Promise<ProxyFlowDetail | undefined> {
  if (!existsSync(file)) return undefined;
  const text = await readFile(file, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = normalizeFlowDetail(JSON.parse(trimmed));
      if (parsed?.id === id) return parsed;
    } catch {
    }
  }
  return undefined;
}

export function filterProxyFlows(flows: ProxyFlowSummary[], query: ProxyFlowQuery = {}): ProxyFlowSummary[] {
  let selected = flows;
  if (query.sinceId) {
    const index = selected.findIndex((flow) => flow.id === query.sinceId);
    if (index !== -1) selected = selected.slice(index + 1);
  }
  if (query.kind) selected = selected.filter((flow) => flow.kind === query.kind);
  if (query.method) {
    const method = query.method.toUpperCase();
    selected = selected.filter((flow) => flow.method.toUpperCase() === method);
  }
  if (query.statusClass) {
    selected = selected.filter((flow) => flow.kind === "http" && typeof flow.status === "number" && Math.floor(flow.status / 100) === query.statusClass);
  }
  if (query.filter?.trim()) {
    const needle = query.filter.toLowerCase();
    selected = selected.filter((flow) => flowSearchText(flow).includes(needle));
  }
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT)));
  return selected.slice(-limit);
}

export function proxyFlowsFromMcpTrafficSummary(result: unknown, query: ProxyFlowQuery = {}): ProxyFlowSummary[] {
  const parsed = parseMcpJson(result);
  if (!Array.isArray(parsed)) return [];
  const flows = parsed.map(normalizeFlow).filter((flow): flow is ProxyFlowSummary => Boolean(flow));
  return filterProxyFlows(flows.reverse(), query);
}

export function proxyFlowDetailFromSummary(summary: ProxyFlowSummary): ProxyFlowDetail {
  if (summary.kind === "http") {
    return {
      ...summary,
      request: { headers: [{ name: "Host", value: summary.host }], bodyText: "", bodyBytes: summary.requestBytes ?? 0 },
      ...(summary.status !== undefined || summary.contentType || summary.responseBytes !== undefined ? {
        response: {
          ...(summary.status !== undefined ? { status: summary.status } : {}),
          headers: summary.contentType ? [{ name: "Content-Type", value: summary.contentType }] : [],
          bodyText: "",
          bodyBytes: summary.responseBytes ?? 0
        }
      } : {})
    };
  }
  if (summary.kind === "websocket") {
    return {
      ...summary,
      handshake: {
        request: { headers: [{ name: "Host", value: summary.host }], bodyText: "", bodyBytes: summary.requestBytes ?? 0 },
        response: { status: summary.status ?? 101, headers: [], bodyText: "", bodyBytes: summary.responseBytes ?? 0 }
      },
      messages: []
    };
  }
  if (summary.kind === "tcp") return { ...summary, messages: [] };
  if (summary.kind === "udp") return { ...summary, messages: [] };
  return {
    ...summary,
    request: {
      query: true,
      questions: [{ name: summary.queryName, ...(summary.queryType ? { type: summary.queryType } : {}) }],
      answers: [],
      authorities: [],
      additionals: []
    }
  };
}

export function proxyFlowDetailFromMcpInspect(result: unknown, fallback?: ProxyFlowSummary): ProxyFlowDetail | undefined {
  const parsed = parseMcpJson(result);
  const detail = normalizeFlowDetail(parsed, fallback);
  return detail?.id ? detail : undefined;
}

function normalizeFlow(value: unknown): ProxyFlowSummary | undefined {
  const obj = record(value);
  if (!obj) return undefined;
  const kind = flowKind(obj);
  if (kind === "http") return normalizeHttpSummary(obj);
  if (kind === "websocket") return normalizeWebSocketSummary(obj);
  if (kind === "tcp" || kind === "udp") return normalizeStreamSummary(obj, kind);
  return normalizeDnsSummary(obj);
}

function normalizeFlowDetail(value: unknown, fallback?: ProxyFlowSummary): ProxyFlowDetail | undefined {
  const obj = record(value);
  if (!obj) return undefined;
  const kind = flowKind(obj, fallback?.kind);
  if (kind === "http") return normalizeHttpDetail(obj, fallback?.kind === "http" ? fallback : undefined);
  if (kind === "websocket") return normalizeWebSocketDetail(obj, fallback?.kind === "websocket" ? fallback : undefined);
  if (kind === "tcp" || kind === "udp") return normalizeStreamDetail(obj, kind, fallback?.kind === kind ? fallback : undefined);
  return normalizeDnsDetail(obj, fallback?.kind === "dns" ? fallback : undefined);
}

function normalizeHttpDetail(obj: Record<string, unknown>, fallback?: ProxyHttpFlowSummary): ProxyHttpFlowDetail | undefined {
  const summary = normalizeHttpSummary(obj, fallback);
  if (!summary) return undefined;
  const request = normalizeHttpMessage(obj.request) ?? {
    headers: [{ name: "Host", value: summary.host }],
    bodyText: "",
    bodyBytes: summary.requestBytes ?? 0
  };
  const responseObj = record(obj.response);
  const response = normalizeHttpMessage(responseObj);
  const reason = stringFields(responseObj, "reason");
  return {
    ...summary,
    request,
    ...(response ? { response: { ...response, ...(summary.status !== undefined ? { status: summary.status } : {}), ...(reason ? { reason } : {}) } } : {})
  };
}

function normalizeWebSocketDetail(obj: Record<string, unknown>, fallback?: ProxyWebSocketFlowSummary): ProxyWebSocketFlowDetail | undefined {
  const summary = normalizeWebSocketSummary(obj, fallback);
  if (!summary) return undefined;
  const handshakeObj = record(obj.handshake);
  const requestObj = record(handshakeObj?.request) ?? record(obj.request);
  const responseObj = record(handshakeObj?.response) ?? record(obj.response);
  const response = normalizeHttpMessage(responseObj);
  const reason = stringFields(responseObj, "reason");
  return {
    ...summary,
    handshake: {
      request: normalizeHttpMessage(requestObj) ?? { headers: [{ name: "Host", value: summary.host }], bodyText: "" },
      ...(response ? { response: { ...response, ...(summary.status !== undefined ? { status: summary.status } : {}), ...(reason ? { reason } : {}) } } : {})
    },
    messages: arrayField(obj.messages).map(normalizeStreamMessage).filter((message): message is ProxyStreamMessage => Boolean(message))
  };
}

function normalizeStreamDetail(
  obj: Record<string, unknown>,
  kind: "tcp" | "udp",
  fallback?: ProxyTcpFlowSummary | ProxyUdpFlowSummary
): ProxyTcpFlowDetail | ProxyUdpFlowDetail | undefined {
  const summary = normalizeStreamSummary(obj, kind, fallback);
  if (!summary) return undefined;
  const client = normalizeEndpoint(obj.client);
  const server = normalizeEndpoint(obj.server);
  const messages = arrayField(obj.messages).map(normalizeStreamMessage).filter((message): message is ProxyStreamMessage => Boolean(message));
  return { ...summary, ...(client ? { client } : {}), ...(server ? { server } : {}), messages };
}

function normalizeDnsDetail(obj: Record<string, unknown>, fallback?: ProxyDnsFlowSummary): ProxyDnsFlowDetail | undefined {
  const summary = normalizeDnsSummary(obj, fallback);
  const request = normalizeDnsMessage(obj.request);
  if (!summary || !request) return undefined;
  const client = normalizeEndpoint(obj.client);
  const server = normalizeEndpoint(obj.server);
  const response = normalizeDnsMessage(obj.response);
  return { ...summary, ...(client ? { client } : {}), ...(server ? { server } : {}), request, ...(response ? { response } : {}) };
}

function normalizeHttpSummary(obj: Record<string, unknown>, fallback?: ProxyHttpFlowSummary): ProxyHttpFlowSummary | undefined {
  const request = record(obj.request);
  const response = record(obj.response);
  const method = stringFields(obj, "method") ?? stringFields(request, "method") ?? fallback?.method;
  const url = stringFields(obj, "url") ?? stringFields(request, "url", "pretty_url") ?? fallback?.url;
  if (!method || !url) return undefined;
  const location = urlLocation(url, fallback?.host, fallback?.path);
  const host = preferredHttpHost(requestAuthority(request), location.host, stringFields(obj, "host"), fallback?.host);
  return {
    id: stringFields(obj, "id") ?? fallback?.id ?? "",
    kind: "http",
    timestamp: timestampField(obj.timestamp ?? obj.timestamp_start ?? request?.timestamp ?? request?.timestamp_start) ?? fallback?.timestamp ?? new Date(0).toISOString(),
    method,
    url,
    host,
    path: stringFields(obj, "path") ?? location.path,
    ...summaryMetrics(obj, response, fallback)
  };
}

function normalizeWebSocketSummary(obj: Record<string, unknown>, fallback?: ProxyWebSocketFlowSummary): ProxyWebSocketFlowSummary | undefined {
  const handshake = record(obj.handshake);
  const request = record(handshake?.request) ?? record(obj.request);
  const response = record(handshake?.response) ?? record(obj.response);
  const url = stringFields(obj, "url") ?? stringFields(request, "url", "pretty_url") ?? fallback?.url;
  if (!url) return undefined;
  const messages = arrayField(obj.messages);
  const messageCount = numberFields(obj, "messageCount", "message_count")
    ?? (Object.hasOwn(obj, "messages") ? messages.length : fallback?.messageCount)
    ?? 0;
  const location = urlLocation(url, fallback?.host, fallback?.path);
  const closeCode = numberFields(obj, "closeCode", "close_code") ?? fallback?.closeCode;
  const closeReason = stringFields(obj, "closeReason", "close_reason") ?? fallback?.closeReason;
  const closedByClient = booleanFields(obj, "closedByClient", "closed_by_client") ?? fallback?.closedByClient;
  const host = preferredHttpHost(requestAuthority(request), location.host, stringFields(obj, "host"), fallback?.host);
  return {
    id: stringFields(obj, "id") ?? fallback?.id ?? "",
    kind: "websocket",
    timestamp: timestampField(obj.timestamp ?? obj.timestamp_start ?? request?.timestamp ?? request?.timestamp_start) ?? fallback?.timestamp ?? new Date(0).toISOString(),
    method: "WS",
    url,
    host,
    path: stringFields(obj, "path") ?? location.path,
    messageCount,
    ...(closeCode !== undefined ? { closeCode } : {}),
    ...(closeReason ? { closeReason } : {}),
    ...(closedByClient !== undefined ? { closedByClient } : {}),
    ...summaryMetrics(obj, response, fallback)
  };
}

function normalizeStreamSummary(
  obj: Record<string, unknown>,
  kind: "tcp" | "udp",
  fallback?: ProxyTcpFlowSummary | ProxyUdpFlowSummary
): ProxyTcpFlowSummary | ProxyUdpFlowSummary | undefined {
  const client = normalizeEndpoint(obj.client);
  const server = normalizeEndpoint(obj.server);
  const host = stringFields(obj, "host") ?? server?.host ?? fallback?.host;
  if (!host) return undefined;
  const messages = arrayField(obj.messages);
  const messageCount = numberFields(obj, "messageCount", "message_count")
    ?? (Object.hasOwn(obj, "messages") ? messages.length : fallback?.messageCount)
    ?? 0;
  const base = {
    id: stringFields(obj, "id") ?? fallback?.id ?? "",
    timestamp: timestampField(obj.timestamp ?? obj.timestamp_start) ?? fallback?.timestamp ?? new Date(0).toISOString(),
    method: kind.toUpperCase(),
    url: stringFields(obj, "url") ?? `${kind}://${server?.label ?? host}`,
    host,
    path: stringFields(obj, "path") ?? `${client?.label ?? "client"} -> ${server?.label ?? host}`,
    messageCount,
    ...summaryMetrics(obj, undefined, fallback)
  };
  if (kind === "tcp") {
    const tls = booleanFields(obj, "tls") ?? (fallback?.kind === "tcp" ? fallback.tls : undefined);
    return { ...base, kind: "tcp", ...(tls !== undefined ? { tls } : {}) };
  }
  const dtls = booleanFields(obj, "dtls") ?? (fallback?.kind === "udp" ? fallback.dtls : undefined);
  return { ...base, kind: "udp", ...(dtls !== undefined ? { dtls } : {}) };
}

function normalizeDnsSummary(obj: Record<string, unknown>, fallback?: ProxyDnsFlowSummary): ProxyDnsFlowSummary | undefined {
  const request = normalizeDnsMessage(obj.request);
  const response = normalizeDnsMessage(obj.response);
  const firstQuestion = request?.questions[0];
  const queryName = stringFields(obj, "queryName", "query_name") ?? firstQuestion?.name ?? fallback?.queryName;
  if (!queryName) return undefined;
  const queryType = stringFields(obj, "queryType", "query_type") ?? firstQuestion?.type ?? fallback?.queryType;
  const responseCode = numberFields(obj, "responseCode", "response_code") ?? response?.responseCode ?? fallback?.responseCode;
  const answerCount = numberFields(obj, "answerCount", "answer_count") ?? response?.answers.length ?? fallback?.answerCount ?? 0;
  return {
    id: stringFields(obj, "id") ?? fallback?.id ?? "",
    kind: "dns",
    timestamp: timestampField(obj.timestamp ?? obj.timestamp_start) ?? fallback?.timestamp ?? new Date(0).toISOString(),
    method: "DNS",
    url: stringFields(obj, "url") ?? `dns://${queryName}${queryType ? `?type=${encodeURIComponent(queryType)}` : ""}`,
    host: stringFields(obj, "host") ?? queryName,
    path: stringFields(obj, "path") ?? queryType ?? "query",
    queryName,
    ...(queryType ? { queryType } : {}),
    ...(responseCode !== undefined ? { responseCode } : {}),
    answerCount,
    ...summaryMetrics(obj, undefined, fallback)
  };
}

function normalizeHttpMessage(value: unknown): ProxyHttpMessage | undefined {
  const obj = record(value);
  if (!obj) return undefined;
  const body = stringFields(obj, "body", "bodyText");
  const bodyPreview = stringFields(obj, "body_preview");
  const bodyText = body ?? bodyPreview;
  const bodyBase64 = stringFields(obj, "bodyBase64", "body_base64");
  const reportedBytes = numberFields(obj, "bodyBytes", "body_bytes", "body_size", "size");
  const httpVersion = stringFields(obj, "httpVersion", "http_version");
  const explicitTruncated = booleanFields(obj, "bodyTruncated", "body_truncated", "truncated") === true;
  const previewBytes = bodyPreview === undefined ? 0 : Buffer.byteLength(bodyPreview, "utf8");
  const bodyTruncated = explicitTruncated || (body === undefined && bodyPreview !== undefined && reportedBytes !== undefined && reportedBytes > previewBytes);
  return {
    ...(httpVersion ? { httpVersion } : {}),
    headers: headersField(obj.headers),
    ...(bodyText !== undefined ? { bodyText } : {}),
    ...(bodyBase64 !== undefined ? { bodyBase64 } : {}),
    ...(bodyTruncated ? { bodyTruncated: true } : {}),
    ...(reportedBytes !== undefined ? { bodyBytes: reportedBytes } : bodyText !== undefined ? { bodyBytes: Buffer.byteLength(bodyText, "utf8") } : bodyBase64 ? { bodyBytes: Buffer.from(bodyBase64, "base64").byteLength } : {})
  };
}

function normalizeStreamMessage(value: unknown): ProxyStreamMessage | undefined {
  const obj = record(value);
  if (!obj) return undefined;
  const directionValue = stringFields(obj, "direction");
  const fromClient = booleanFields(obj, "fromClient", "from_client");
  const direction = directionValue === "client" || directionValue === "client->server" || fromClient === true ? "client" : "server";
  const contentText = stringFields(obj, "contentText", "content_text", "text");
  const contentBase64 = stringFields(obj, "contentBase64", "content_base64", "base64");
  const messageType = stringFields(obj, "messageType", "message_type", "type");
  const contentBytes = numberFields(obj, "contentBytes", "content_bytes", "size")
    ?? (contentText !== undefined ? Buffer.byteLength(contentText, "utf8") : contentBase64 ? Buffer.from(contentBase64, "base64").byteLength : 0);
  return {
    direction,
    timestamp: timestampField(obj.timestamp) ?? new Date(0).toISOString(),
    ...(messageType ? { messageType } : {}),
    ...(contentText !== undefined ? { contentText } : {}),
    ...(contentBase64 !== undefined ? { contentBase64 } : {}),
    contentBytes,
    ...(booleanFields(obj, "truncated") ? { truncated: true } : {}),
    ...(booleanFields(obj, "dropped") ? { dropped: true } : {}),
    ...(booleanFields(obj, "injected") ? { injected: true } : {})
  };
}

function normalizeDnsMessage(value: unknown): ProxyDnsMessage | undefined {
  const obj = record(value);
  if (!obj) return undefined;
  const id = numberFields(obj, "id");
  const responseCode = numberFields(obj, "responseCode", "response_code");
  return {
    ...(id !== undefined ? { id } : {}),
    query: booleanFields(obj, "query") ?? false,
    ...(responseCode !== undefined ? { responseCode } : {}),
    questions: arrayField(obj.questions).map(normalizeDnsQuestion).filter((item): item is ProxyDnsQuestion => Boolean(item)),
    answers: arrayField(obj.answers).map(normalizeDnsRecord).filter((item): item is ProxyDnsRecord => Boolean(item)),
    authorities: arrayField(obj.authorities).map(normalizeDnsRecord).filter((item): item is ProxyDnsRecord => Boolean(item)),
    additionals: arrayField(obj.additionals).map(normalizeDnsRecord).filter((item): item is ProxyDnsRecord => Boolean(item))
  };
}

function normalizeDnsQuestion(value: unknown): ProxyDnsQuestion | undefined {
  const obj = record(value);
  const name = stringFields(obj, "name");
  if (!name) return undefined;
  const type = stringFields(obj, "type");
  const dnsClass = stringFields(obj, "class", "class_");
  return { name, ...(type ? { type } : {}), ...(dnsClass ? { class: dnsClass } : {}) };
}

function normalizeDnsRecord(value: unknown): ProxyDnsRecord | undefined {
  const obj = record(value);
  const name = stringFields(obj, "name");
  if (!name) return undefined;
  const type = stringFields(obj, "type");
  const dnsClass = stringFields(obj, "class", "class_");
  const ttl = numberFields(obj, "ttl");
  const data = stringFields(obj, "data", "text");
  return { name, ...(type ? { type } : {}), ...(dnsClass ? { class: dnsClass } : {}), ...(ttl !== undefined ? { ttl } : {}), ...(data ? { data } : {}) };
}

function normalizeEndpoint(value: unknown): ProxyEndpoint | undefined {
  if (Array.isArray(value) && typeof value[0] === "string") {
    const port = numberField(value[1]);
    return { host: value[0], ...(port !== undefined ? { port } : {}), label: port !== undefined ? `${value[0]}:${port}` : value[0] };
  }
  if (typeof value === "string" && value) return { host: value, label: value };
  const obj = record(value);
  if (!obj) return undefined;
  const host = stringFields(obj, "host", "address", "ip");
  if (!host) return undefined;
  const port = numberFields(obj, "port");
  return { host, ...(port !== undefined ? { port } : {}), label: stringFields(obj, "label") ?? (port !== undefined ? `${host}:${port}` : host) };
}

function summaryMetrics(
  obj: Record<string, unknown>,
  response?: Record<string, unknown>,
  fallback?: ProxyFlowSummary
): Omit<Partial<ProxyFlowBase>, "id" | "kind" | "timestamp" | "method" | "url" | "host" | "path"> {
  const status = numberFields(obj, "status", "status_code") ?? numberFields(response, "status", "status_code") ?? fallback?.status;
  const contentType = stringFields(obj, "contentType", "content_type")
    ?? headersField(response?.headers).find((header) => header.name.toLowerCase() === "content-type")?.value
    ?? fallback?.contentType;
  const requestBytes = numberFields(obj, "requestBytes", "request_bytes") ?? fallback?.requestBytes;
  const responseBytes = numberFields(obj, "responseBytes", "response_bytes", "size") ?? fallback?.responseBytes;
  const durationMs = numberFields(obj, "durationMs", "duration_ms") ?? fallback?.durationMs;
  const error = stringFields(obj, "error") ?? fallback?.error;
  return {
    ...(status !== undefined ? { status } : {}),
    ...(contentType ? { contentType } : {}),
    ...(requestBytes !== undefined ? { requestBytes } : {}),
    ...(responseBytes !== undefined ? { responseBytes } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(error ? { error } : {})
  };
}

function flowSearchText(flow: ProxyFlowSummary): string {
  const specific = flow.kind === "dns"
    ? `${flow.queryName} ${flow.queryType ?? ""} ${flow.responseCode ?? ""}`
    : flow.kind === "http"
      ? `${flow.status ?? ""} ${flow.contentType ?? ""}`
      : `${flow.messageCount}`;
  return [flow.kind, flow.method, flow.url, flow.host, flow.path, specific, flow.error ?? ""].join(" ").toLowerCase();
}

function flowKind(obj: Record<string, unknown>, fallback: ProxyFlowKind = "http"): ProxyFlowKind {
  const value = stringFields(obj, "kind", "flowType", "flow_type", "type")?.toLowerCase();
  if (value === "websocket" || value === "websocketflow" || value === "ws") return "websocket";
  if (value === "tcp" || value === "tcpflow") return "tcp";
  if (value === "udp" || value === "udpflow") return "udp";
  if (value === "dns" || value === "dnsflow") return "dns";
  return fallback;
}

function urlLocation(url: string, fallbackHost = "", fallbackPath = "/"): { host: string; path: string } {
  try {
    const parsed = new URL(url);
    return { host: parsed.hostname, path: `${parsed.pathname}${parsed.search}` };
  } catch {
    return { host: fallbackHost, path: fallbackPath };
  }
}

function requestAuthority(request: Record<string, unknown> | undefined): string | undefined {
  const direct = stringFields(request, "pretty_host", "prettyHost", "host_header", "hostHeader", "authority");
  if (direct) return authorityHost(direct);
  const authority = headersField(request?.headers).find((header) => {
    const name = header.name.toLowerCase();
    return name === ":authority" || name === "host";
  })?.value;
  return authority ? authorityHost(authority) : undefined;
}

function preferredHttpHost(...candidates: Array<string | undefined>): string {
  const normalized = candidates.map(authorityHost).filter((host): host is string => Boolean(host));
  return normalized.find((host) => isIP(host) === 0) ?? normalized[0] ?? "unknown";
}

function authorityHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(`http://${value}`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return value.replace(/^\[|\]$/g, "");
  }
}

function headersField(value: unknown): Array<{ name: string; value: string }> {
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") return { name: entry[0], value: entry[1] };
      const obj = record(entry);
      return obj && typeof obj.name === "string" && typeof obj.value === "string" ? { name: obj.name, value: obj.value } : undefined;
    }).filter((entry): entry is { name: string; value: string } => Boolean(entry));
  }
  const obj = record(value);
  if (!obj) return [];
  return Object.entries(obj).filter((entry): entry is [string, string] => typeof entry[1] === "string").map(([name, headerValue]) => ({ name, value: headerValue }));
}

function parseMcpJson(result: unknown): unknown {
  const text = renderMcpTextResult(result);
  try { return JSON.parse(text); } catch { return undefined; }
}

function renderMcpTextResult(result: unknown): string {
  const obj = record(result);
  const content = obj?.content;
  if (!Array.isArray(content)) return typeof result === "string" ? result : JSON.stringify(result);
  return content.map((part) => stringFields(record(part), "text") ?? "").filter(Boolean).join("\n");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function arrayField(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringFields(value: Record<string, unknown> | undefined, ...names: string[]): string | undefined {
  if (!value) return undefined;
  for (const name of names) {
    const field = value[name];
    if (typeof field === "string" && field.length > 0) return field;
  }
  return undefined;
}

function numberFields(value: Record<string, unknown> | undefined, ...names: string[]): number | undefined {
  if (!value) return undefined;
  for (const name of names) {
    const field = numberField(value[name]);
    if (field !== undefined) return field;
  }
  return undefined;
}

function booleanFields(value: Record<string, unknown> | undefined, ...names: string[]): boolean | undefined {
  if (!value) return undefined;
  for (const name of names) {
    const field = value[name];
    if (typeof field === "boolean") return field;
  }
  return undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestampField(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value * 1000).toISOString();
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
  }
  return undefined;
}
