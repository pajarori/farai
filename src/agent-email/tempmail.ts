import { randomBytes } from "node:crypto";
import type { Session } from "../types";
import { id } from "../utils";
import { extractOtpCandidates, extractUrls, normalizeAttachmentName } from "./message";
import { emailMessageRegistry } from "./resources";
import type { DisposableInboxActivity, EmailMessageDetail, EmailMessageSummary } from "./types";

type TempMailProvider = {
  name: DisposableInboxActivity["provider"];
  baseUrl: string;
};

type TempMailRequestOptions = {
  method?: string;
  body?: unknown;
  token?: string;
  signal?: AbortSignal;
  allowEmpty?: boolean;
  attempts?: number;
  timeoutMs?: number;
};

type TempInboxEntry = DisposableInboxActivity & {
  sessionId: string;
  accountId: string;
  token: string;
  password: string;
  api: TempMailProvider;
};

type TempMailListener = (inboxes: DisposableInboxActivity[]) => void;

const PROVIDERS: TempMailProvider[] = [
  { name: "mail.tm", baseUrl: "https://api.mail.tm" },
  { name: "mail.gw", baseUrl: "https://api.mail.gw" }
];
const REQUEST_TIMEOUT_MS = 15_000;
const REQUEST_ATTEMPTS = 3;
const ADDRESS_ATTEMPTS = 3;

class TempMailHttpError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterMs?: number) {
    super(message);
  }
}

export class DisposableInboxManager {
  private readonly sessions = new Map<string, Map<string, TempInboxEntry>>();
  private readonly listeners = new Map<string, Set<TempMailListener>>();

  constructor(private readonly options: { shutdownCleanupTimeoutMs?: number } = {}) {}

  list(session: Session | string): DisposableInboxActivity[] {
    const sessionId = typeof session === "string" ? session : session.id;
    return [...(this.sessions.get(sessionId)?.values() ?? [])]
      .map(toActivity)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  subscribe(session: Session | string, listener: TempMailListener): () => void {
    const sessionId = typeof session === "string" ? session : session.id;
    let listeners = this.listeners.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(sessionId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.listeners.delete(sessionId);
    };
  }

  async create(session: Session, options: { label?: string; provider?: DisposableInboxActivity["provider"] } = {}, signal?: AbortSignal): Promise<DisposableInboxActivity> {
    const entries = this.sessionEntries(session.id);
    const failures: string[] = [];
    const providers = options.provider
      ? PROVIDERS.filter((provider) => provider.name === options.provider)
      : PROVIDERS;
    for (const provider of providers) {
      try {
        const created = await createProviderInbox(provider, options.label, signal);
        const entry: TempInboxEntry = {
          id: id(),
          ...(options.label?.trim() ? { label: options.label.trim().slice(0, 80) } : {}),
          address: created.address,
          provider: provider.name,
          status: "ready",
          createdAt: new Date().toISOString(),
          sessionId: session.id,
          accountId: created.accountId,
          token: created.token,
          password: created.password,
          api: provider
        };
        entries.set(entry.id, entry);
        this.emit(session.id);
        return toActivity(entry);
      } catch (error) {
        if (signal?.aborted) throw error;
        failures.push(`${provider.name}: ${errorMessage(error)}`);
      }
    }
    throw new Error(`disposable email creation failed: ${failures.join("; ")}`);
  }

  async delete(session: Session | string, selector: string, signal?: AbortSignal): Promise<DisposableInboxActivity> {
    const sessionId = typeof session === "string" ? session : session.id;
    const entry = this.resolve(sessionId, selector);
    entry.status = "closing";
    this.emit(sessionId);
    try {
      await requestJsonWithRetry(entry.api, `/accounts/${encodeURIComponent(entry.accountId)}`, {
        method: "DELETE",
        token: entry.token,
        ...(signal ? { signal } : {}),
        allowEmpty: true,
        attempts: 2,
        timeoutMs: 5_000
      });
    } finally {
      this.sessions.get(sessionId)?.delete(entry.id);
      if (this.sessions.get(sessionId)?.size === 0) this.sessions.delete(sessionId);
      this.emit(sessionId);
    }
    return toActivity(entry);
  }

  async listMessages(session: Session | string, selector: string, limit: number, signal?: AbortSignal): Promise<EmailMessageSummary[]> {
    const sessionId = typeof session === "string" ? session : session.id;
    const entry = this.resolve(sessionId, selector);
    entry.lastUsedAt = new Date().toISOString();
    const response = await requestJsonWithRetry(entry.api, "/messages?page=1", { token: entry.token, ...(signal ? { signal } : {}) });
    this.emit(sessionId);
    return collection(response).slice(0, limit).flatMap((value) => {
      const message = recordValue(value);
      const id = stringValue(message?.id);
      if (!message || !id) return [];
      return [tempMessageSummary(message, id)];
    });
  }

  async readMessage(session: Session | string, selector: string, messageId: string, includeRaw: boolean, signal?: AbortSignal): Promise<EmailMessageDetail> {
    const sessionId = typeof session === "string" ? session : session.id;
    const entry = this.resolve(sessionId, selector);
    const message = recordValue(await requestJsonWithRetry(entry.api, `/messages/${encodeURIComponent(messageId)}`, { token: entry.token, ...(signal ? { signal } : {}) }));
    if (!message) throw new Error(`email message ${messageId} was not found`);
    const summary = tempMessageSummary(message, messageId);
    const text = stringValue(message.text) ?? htmlText(message.html);
    const html = htmlValue(message.html);
    let raw: string | undefined;
    if (includeRaw) {
      const source = recordValue(await requestJsonWithRetry(entry.api, `/sources/${encodeURIComponent(messageId)}`, { token: entry.token, ...(signal ? { signal } : {}) }));
      raw = boundedRaw(stringValue(source?.data) ?? "");
    }
    entry.lastUsedAt = new Date().toISOString();
    this.emit(sessionId);
    return {
      ...summary,
      text: boundedText(text ?? ""),
      ...(html ? { html: boundedText(html) } : {}),
      urls: extractUrls([text ?? "", html ?? ""].join("\n")),
      otpCandidates: extractOtpCandidates([summary.subject, text ?? ""].join("\n")),
      attachments: arrayValue(message.attachments).flatMap((value) => {
        const attachment = recordValue(value);
        if (!attachment) return [];
        return [{
          filename: normalizeAttachmentName(stringValue(attachment.filename)),
          contentType: stringValue(attachment.contentType) ?? "application/octet-stream",
          size: numberValue(attachment.size) ?? 0
        }];
      }),
      ...(raw ? { raw } : {})
    };
  }

  async waitForMessage(
    session: Session | string,
    selector: string,
    options: { timeoutMs: number; from?: string; subject?: string; body?: string },
    signal?: AbortSignal
  ): Promise<EmailMessageDetail | undefined> {
    const sessionId = typeof session === "string" ? session : session.id;
    const entry = this.resolve(sessionId, selector);
    const started = Date.now();
    entry.status = "waiting";
    this.emit(sessionId);
    try {
      while (Date.now() - started < options.timeoutMs) {
        signal?.throwIfAborted();
        const messages = await this.listMessages(sessionId, entry.id, 30, signal);
        for (const summary of messages) {
          if (options.from && !summary.from.toLowerCase().includes(options.from.toLowerCase())) continue;
          if (options.subject && !summary.subject.toLowerCase().includes(options.subject.toLowerCase())) continue;
          const detail = await this.readMessage(sessionId, entry.id, summary.id, false, signal);
          if (options.body && !detail.text.toLowerCase().includes(options.body.toLowerCase())) continue;
          return detail;
        }
        const remaining = options.timeoutMs - (Date.now() - started);
        if (remaining <= 0) break;
        await delay(Math.min(3_000, remaining), signal);
      }
      return undefined;
    } finally {
      if (this.sessions.get(sessionId)?.has(entry.id)) {
        entry.status = "ready";
        entry.lastUsedAt = new Date().toISOString();
        this.emit(sessionId);
      }
    }
  }

  async stopSession(session: Session | string): Promise<void> {
    const sessionId = typeof session === "string" ? session : session.id;
    const entries = [...(this.sessions.get(sessionId)?.values() ?? [])];
    this.sessions.delete(sessionId);
    emailMessageRegistry.clearSession(sessionId);
    this.emit(sessionId);
    await Promise.allSettled(entries.map((entry) => requestJsonWithRetry(entry.api, `/accounts/${encodeURIComponent(entry.accountId)}`, {
      method: "DELETE",
      token: entry.token,
      allowEmpty: true,
      attempts: 1,
      timeoutMs: this.options.shutdownCleanupTimeoutMs ?? 1_000
    })));
  }

  private resolve(sessionId: string, selector: string): TempInboxEntry {
    const normalized = selector.trim().toLowerCase();
    const entries = [...(this.sessions.get(sessionId)?.values() ?? [])];
    const entry = entries.find((item) => item.id.toLowerCase() === normalized);
    if (!entry) {
      const available = entries.map((item) => `${item.address} (${item.id})`).join(", ");
      throw new Error(`disposable inbox not found: ${selector}${available ? `. available: ${available}` : ". create one with email_create"}`);
    }
    return entry;
  }

  private sessionEntries(sessionId: string): Map<string, TempInboxEntry> {
    let entries = this.sessions.get(sessionId);
    if (!entries) {
      entries = new Map();
      this.sessions.set(sessionId, entries);
    }
    return entries;
  }

  private emit(sessionId: string): void {
    const snapshot = this.list(sessionId);
    for (const listener of this.listeners.get(sessionId) ?? []) {
      try { listener(snapshot); } catch { }
    }
  }
}

export const disposableInboxManager = new DisposableInboxManager();

export async function stopDisposableInboxesForSession(session: Session | string): Promise<void> {
  await disposableInboxManager.stopSession(session);
}

function tempMessageSummary(message: Record<string, unknown>, id: string): EmailMessageSummary {
  const from = recordValue(message.from);
  const recipients = arrayValue(message.to).flatMap((value) => {
    const recipient = recordValue(value);
    const address = stringValue(recipient?.address);
    return address ? [formatMailbox(stringValue(recipient?.name), address)] : [];
  });
  return {
    id,
    from: formatMailbox(stringValue(from?.name), stringValue(from?.address) ?? "unknown sender"),
    to: recipients,
    subject: stringValue(message.subject)?.trim() || "(no subject)",
    ...(stringValue(message.intro) ? { intro: boundedText(stringValue(message.intro)!) } : {}),
    seen: message.seen === true,
    hasAttachments: message.hasAttachments === true || arrayValue(message.attachments).length > 0,
    ...(numberValue(message.size) !== undefined ? { size: numberValue(message.size)! } : {}),
    ...(stringValue(message.createdAt) ? { receivedAt: stringValue(message.createdAt)! } : {})
  };
}

async function createProviderInbox(
  provider: TempMailProvider,
  requestedLabel: string | undefined,
  signal?: AbortSignal
): Promise<{ address: string; accountId: string; token: string; password: string }> {
  const domains = await requestJsonWithRetry(provider, "/domains?page=1", signal ? { signal } : {});
  const activeDomains = collection(domains)
    .map(recordValue)
    .filter((item): item is Record<string, unknown> => Boolean(item && item.isActive !== false && typeof item.domain === "string"))
    .map((item) => item.domain as string);
  if (!activeDomains.length) throw new Error("provider returned no active domains");
  const label = normalizeLocalPart(requestedLabel) ?? "inbox";
  let lastConflict: unknown;
  for (let attempt = 0; attempt < ADDRESS_ATTEMPTS; attempt += 1) {
    const domain = activeDomains[attempt % activeDomains.length]!;
    const address = `farai-${label.slice(0, 48)}-${randomLetters(4)}@${domain}`;
    const password = randomBytes(32).toString("base64url");
    try {
      return await createOrRecoverProviderAccount(provider, address, password, signal);
    } catch (error) {
      if (!isAddressConflict(error) || attempt === ADDRESS_ATTEMPTS - 1) throw error;
      lastConflict = error;
    }
  }
  throw lastConflict ?? new Error("provider could not allocate a disposable address");
}

async function createOrRecoverProviderAccount(
  provider: TempMailProvider,
  address: string,
  password: string,
  signal?: AbortSignal
): Promise<{ address: string; accountId: string; token: string; password: string }> {
  let failure: unknown;
  for (let attempt = 0; attempt < REQUEST_ATTEMPTS; attempt += 1) {
    try {
      const account = recordValue(await requestJson(provider, "/accounts", {
        method: "POST",
        body: { address, password },
        ...(signal ? { signal } : {})
      }));
      const accountId = stringValue(account?.id);
      if (!accountId) throw new Error("provider did not return an account id");
      return await loginProviderAccount(provider, address, password, accountId, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      failure = error;
      if (!isAddressConflict(error) && !retryableRequestError(error)) throw error;
      const recovered = await recoverProviderAccount(provider, address, password, signal);
      if (recovered) return recovered;
      if (isAddressConflict(error) || attempt === REQUEST_ATTEMPTS - 1) throw error;
      await delay(retryDelay(error, attempt), signal);
    }
  }
  throw failure ?? new Error("provider account creation failed");
}

async function recoverProviderAccount(
  provider: TempMailProvider,
  address: string,
  password: string,
  signal?: AbortSignal
): Promise<{ address: string; accountId: string; token: string; password: string } | undefined> {
  try {
    return await loginProviderAccount(provider, address, password, undefined, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof TempMailHttpError && error.status >= 400 && error.status < 500 && error.status !== 429) return undefined;
    if (retryableRequestError(error)) return undefined;
    throw error;
  }
}

async function loginProviderAccount(
  provider: TempMailProvider,
  address: string,
  password: string,
  knownAccountId?: string,
  signal?: AbortSignal
): Promise<{ address: string; accountId: string; token: string; password: string }> {
  const tokenResponse = recordValue(await requestJsonWithRetry(provider, "/token", {
    method: "POST",
    body: { address, password },
    ...(signal ? { signal } : {})
  }));
  const token = stringValue(tokenResponse?.token);
  if (!token) throw new Error("provider did not return an access token");
  let accountId = stringValue(tokenResponse?.id) ?? knownAccountId;
  if (!accountId) {
    const account = recordValue(await requestJsonWithRetry(provider, "/me", { token, ...(signal ? { signal } : {}) }));
    accountId = stringValue(account?.id);
  }
  if (!accountId) throw new Error("provider did not return an account id");
  return { address, accountId, token, password };
}

async function requestJsonWithRetry(
  provider: TempMailProvider,
  path: string,
  options: TempMailRequestOptions = {}
): Promise<unknown> {
  let failure: unknown;
  const attempts = Math.max(1, Math.min(REQUEST_ATTEMPTS, options.attempts ?? REQUEST_ATTEMPTS));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await requestJson(provider, path, options);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      failure = error;
      if (!retryableRequestError(error) || attempt === attempts - 1) throw error;
      await delay(retryDelay(error, attempt), options.signal);
    }
  }
  throw failure ?? new Error("temporary email request failed");
}

async function requestJson(
  provider: TempMailProvider,
  path: string,
  options: TempMailRequestOptions = {}
): Promise<unknown> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetch(`${provider.baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {})
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    signal
  });
  if (!response.ok) {
    const detail = compactErrorDetail(await response.text().catch(() => ""));
    throw new TempMailHttpError(
      response.status,
      [`HTTP ${response.status} ${response.statusText}`, detail].filter(Boolean).join(" · "),
      retryAfterMilliseconds(response.headers.get("retry-after"))
    );
  }
  if (options.allowEmpty || response.status === 204) return {};
  return await response.json();
}

function retryableRequestError(error: unknown): boolean {
  if (error instanceof TempMailHttpError) return error.status === 429 || error.status >= 500;
  return error instanceof TypeError || error instanceof DOMException;
}

function isAddressConflict(error: unknown): boolean {
  return error instanceof TempMailHttpError && (error.status === 409 || error.status === 422);
}

function retryDelay(error: unknown, attempt: number): number {
  if (error instanceof TempMailHttpError && error.retryAfterMs !== undefined) {
    const guided = Math.min(5_000, error.retryAfterMs);
    return error.status === 429 ? Math.max(125, guided) : guided;
  }
  return [250, 750][attempt] ?? 1_500;
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function compactErrorDetail(value: string): string {
  const detail = value.replace(/\s+/g, " ").trim();
  return detail.length > 240 ? `${detail.slice(0, 237)}...` : detail;
}

function collection(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = recordValue(value);
  return arrayValue(record?.["hydra:member"] ?? record?.members ?? record?.items);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function htmlValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").join("\n");
  return undefined;
}

function htmlText(value: unknown): string | undefined {
  return htmlValue(value)?.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeLocalPart(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const local = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, 48);
  if (!local) throw new Error("disposable inbox name contains no usable characters");
  return local;
}

function randomLetters(length: number): string {
  return [...randomBytes(length)].map((value) => String.fromCharCode(97 + (value % 26))).join("");
}

function formatMailbox(name: string | undefined, address: string): string {
  return name ? `${name} <${address}>` : address;
}

function boundedText(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  const limit = 40_000;
  return normalized.length > limit ? `${normalized.slice(0, limit)}\n\n[message body truncated; ${normalized.length - limit} characters omitted]` : normalized;
}

function boundedRaw(value: string): string {
  const limit = 120_000;
  return value.length > limit ? `${value.slice(0, limit)}\n\n[raw message truncated; ${value.length - limit} characters omitted]` : value;
}

function toActivity(entry: TempInboxEntry): DisposableInboxActivity {
  return {
    id: entry.id,
    ...(entry.label ? { label: entry.label } : {}),
    address: entry.address,
    provider: entry.provider,
    status: entry.status,
    createdAt: entry.createdAt,
    ...(entry.lastUsedAt ? { lastUsedAt: entry.lastUsedAt } : {})
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(signal?.reason ?? new Error("email wait cancelled"));
    const timer = setTimeout(() => finish(), ms);
    if (!signal) return;
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
