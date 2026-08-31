import { ImapFlow, type FetchMessageObject, type MessageAddressObject, type SearchObject } from "imapflow";
import type { EmailAccountInfo, EmailMessageDetail, EmailMessageSummary } from "./types";
import { mergeMessageState, parseEmailSource } from "./message";

const MAX_MESSAGE_SOURCE_BYTES = 2 * 1024 * 1024;
const IMAP_LOGOUT_TIMEOUT_MS = 2_000;

export async function probeImapAccount(account: EmailAccountInfo, credential: string, signal?: AbortSignal): Promise<{ mailbox: string; messages: number }> {
  return await withImapConnection(account, credential, true, signal, async (client) => {
    const inbox = await withAbort(client.mailboxOpen("INBOX", { readOnly: true }), signal);
    return { mailbox: inbox.path, messages: inbox.exists };
  });
}

export async function listImapMessages(
  account: EmailAccountInfo,
  credential: string,
  options: { limit: number; unreadOnly?: boolean; since?: Date },
  signal?: AbortSignal
): Promise<EmailMessageSummary[]> {
  return await withImapConnection(account, credential, false, signal, async (client) => {
    const lock = await withAbort(client.getMailboxLock("INBOX", { readOnly: true, acquireTimeout: 10_000 }), signal);
    try {
      return await listOpenMailbox(client, options, signal);
    } finally {
      lock.release();
    }
  });
}

export async function readImapMessage(
  account: EmailAccountInfo,
  credential: string,
  messageId: string,
  includeRaw: boolean,
  signal?: AbortSignal
): Promise<EmailMessageDetail> {
  const uid = numericMessageId(messageId);
  return await withImapConnection(account, credential, false, signal, async (client) => {
    const lock = await withAbort(client.getMailboxLock("INBOX", { readOnly: true, acquireTimeout: 10_000 }), signal);
    try {
      const message = await withAbort(client.fetchOne(String(uid), {
        uid: true,
        flags: true,
        envelope: true,
        internalDate: true,
        size: true,
        source: { maxLength: MAX_MESSAGE_SOURCE_BYTES }
      }, { uid: true }), signal);
      if (!message || !message.source) throw new Error(`email message ${messageId} was not found`);
      if ((message.size ?? message.source.byteLength) > MAX_MESSAGE_SOURCE_BYTES) {
        throw new Error(`email message ${messageId} is larger than the ${MAX_MESSAGE_SOURCE_BYTES} byte read limit`);
      }
      const detail = await parseEmailSource(String(message.uid), message.source, includeRaw);
      return mergeMessageState(detail, summaryFromFetch(message));
    } finally {
      lock.release();
    }
  });
}

export async function waitForImapMessage(
  account: EmailAccountInfo,
  credential: string,
  options: {
    timeoutMs: number;
    from?: string;
    subject?: string;
    body?: string;
    unreadOnly?: boolean;
  },
  signal?: AbortSignal
): Promise<EmailMessageDetail | undefined> {
  const started = Date.now();
  return await withImapConnection(account, credential, false, signal, async (client) => {
    const lock = await withAbort(client.getMailboxLock("INBOX", { readOnly: true, acquireTimeout: 10_000 }), signal);
    try {
      while (Date.now() - started < options.timeoutMs) {
        signal?.throwIfAborted();
        const summaries = await listOpenMailbox(client, {
          limit: 30,
          ...(options.unreadOnly !== undefined ? { unreadOnly: options.unreadOnly } : {})
        }, signal);
        for (const summary of summaries) {
          if (!summaryMatches(summary, options)) continue;
          const detail = await readOpenMailboxMessage(client, summary.id, false, signal);
          if (detailMatches(detail, options)) return detail;
        }
        const remaining = options.timeoutMs - (Date.now() - started);
        if (remaining <= 0) break;
        await waitForMailboxChange(client, Math.min(15_000, remaining), signal);
      }
      return undefined;
    } finally {
      lock.release();
    }
  });
}

async function listOpenMailbox(
  client: ImapFlow,
  options: { limit: number; unreadOnly?: boolean; since?: Date },
  signal?: AbortSignal
): Promise<EmailMessageSummary[]> {
  const query: SearchObject = {
    ...(!options.unreadOnly && !options.since ? { all: true } : {}),
    ...(options.unreadOnly ? { seen: false } : {}),
    ...(options.since ? { since: options.since } : {})
  };
  const searched = await withAbort(client.search(query, { uid: true }), signal);
  const uids = (searched || []).slice(-options.limit).reverse();
  if (uids.length === 0) return [];
  const byUid = new Map<number, EmailMessageSummary>();
  for await (const message of client.fetch(uids, { uid: true, flags: true, envelope: true, internalDate: true, size: true }, { uid: true })) {
    signal?.throwIfAborted();
    byUid.set(message.uid, summaryFromFetch(message));
  }
  return uids.flatMap((uid) => byUid.get(uid) ?? []);
}

async function readOpenMailboxMessage(client: ImapFlow, messageId: string, includeRaw: boolean, signal?: AbortSignal): Promise<EmailMessageDetail> {
  const message = await withAbort(client.fetchOne(messageId, {
    uid: true,
    flags: true,
    envelope: true,
    internalDate: true,
    size: true,
    source: { maxLength: MAX_MESSAGE_SOURCE_BYTES }
  }, { uid: true }), signal);
  if (!message || !message.source) throw new Error(`email message ${messageId} was not found`);
  if ((message.size ?? message.source.byteLength) > MAX_MESSAGE_SOURCE_BYTES) {
    throw new Error(`email message ${messageId} is larger than the ${MAX_MESSAGE_SOURCE_BYTES} byte read limit`);
  }
  return mergeMessageState(await parseEmailSource(String(message.uid), message.source, includeRaw), summaryFromFetch(message));
}

function imapClient(account: EmailAccountInfo, credential: string, verifyOnly = false): ImapFlow {
  return new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.secure,
    auth: account.auth === "oauth"
      ? { user: account.username, accessToken: credential }
      : { user: account.username, pass: credential },
    logger: false,
    verifyOnly,
    includeMailboxes: verifyOnly,
    autoIdleDelay: 1_000,
    maxIdleTime: 60_000,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 90_000,
    maxLiteralSize: MAX_MESSAGE_SOURCE_BYTES,
    maxResponseSize: MAX_MESSAGE_SOURCE_BYTES + 256 * 1024
  });
}

async function withImapConnection<T>(
  account: EmailAccountInfo,
  credential: string,
  verifyOnly: boolean,
  signal: AbortSignal | undefined,
  operation: (client: ImapFlow) => Promise<T>
): Promise<T> {
  const client = imapClient(account, credential, verifyOnly);
  const abort = () => client.close();
  signal?.throwIfAborted();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await withAbort(client.connect(), signal);
    return await operation(client);
  } finally {
    signal?.removeEventListener("abort", abort);
    await closeImap(client);
  }
}

function summaryFromFetch(message: FetchMessageObject): EmailMessageSummary {
  return {
    id: String(message.uid),
    from: formatAddress(message.envelope?.from?.[0]) || "unknown sender",
    to: (message.envelope?.to ?? []).map(formatAddress).filter(Boolean),
    subject: message.envelope?.subject?.trim() || "(no subject)",
    seen: message.flags?.has("\\Seen") ?? false,
    hasAttachments: false,
    ...(message.size !== undefined ? { size: message.size } : {}),
    ...(message.internalDate ? { receivedAt: new Date(message.internalDate).toISOString() } : {})
  };
}

function formatAddress(value: MessageAddressObject | undefined): string {
  if (!value) return "";
  const address = value.address?.trim() ?? "";
  const name = value.name?.trim() ?? "";
  return name && address ? `${name} <${address}>` : address || name;
}

function summaryMatches(summary: EmailMessageSummary, options: { from?: string; subject?: string }): boolean {
  if (options.from && !summary.from.toLowerCase().includes(options.from.toLowerCase())) return false;
  if (options.subject && !summary.subject.toLowerCase().includes(options.subject.toLowerCase())) return false;
  return true;
}

function detailMatches(detail: EmailMessageDetail, options: { body?: string }): boolean {
  return !options.body || detail.text.toLowerCase().includes(options.body.toLowerCase());
}

async function waitForMailboxChange(client: ImapFlow, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      client.off("exists", onExists);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(signal?.reason ?? new Error("email wait cancelled"));
    const onExists = () => finish();
    const timer = setTimeout(() => finish(), timeoutMs);
    client.once("exists", onExists);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function closeImap(client: ImapFlow): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const closed = await Promise.race([
      client.logout().then(() => true, () => false),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), IMAP_LOGOUT_TIMEOUT_MS);
        timer.unref?.();
      })
    ]);
    if (!closed) client.close();
  } catch {
    try { client.close(); } catch {}
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function numericMessageId(value: string): number {
  const uid = Number.parseInt(value.trim(), 10);
  if (!Number.isInteger(uid) || uid <= 0) throw new Error("message id must be a positive IMAP UID");
  return uid;
}

async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return await promise;
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("operation cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}
