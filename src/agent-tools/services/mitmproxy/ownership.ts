import { isIP } from "node:net";
import type { CampaignAsset, Session, ToolContext } from "../../../types";

export const PROXY_CAPTURE_IDENTITY_HEADER = "X-Farai-Capture-Identity";

export type ProxyCaptureIdentity = {
  rootSessionId: string;
  sessionId: string;
  browserContextId?: string;
  browserContextName?: string;
  source: string;
};

export function encodeProxyCaptureIdentity(identity: ProxyCaptureIdentity): string {
  return Buffer.from(JSON.stringify(identity), "utf8").toString("base64url");
}

export function proxyCaptureIdentity(
  context: Pick<ToolContext, "session" | "store">,
  source: string,
  browser?: { id: string; name: string }
): ProxyCaptureIdentity {
  return {
    rootSessionId: rootSessionId(context.session, context.store.loadSession),
    sessionId: context.session.id,
    ...(browser ? { browserContextId: browser.id, browserContextName: browser.name } : {}),
    source
  };
}

export function rootSessionId(session: Session, loadSession?: (sessionId: string) => Session): string {
  let current = session;
  const visited = new Set<string>();
  while (current.parentId && loadSession && !visited.has(current.id)) {
    visited.add(current.id);
    try {
      current = loadSession(current.parentId);
    } catch {
      break;
    }
  }
  return current.id;
}

export function proxyScopeDomains(context: Pick<ToolContext, "session" | "store">, candidates: unknown[] = []): string[] {
  const values = [...candidates];
  if (context.session.campaignId && context.store.listAssets) {
    values.push(...context.store.listAssets(context.session.campaignId).flatMap(assetScopeCandidates));
  }
  return [...new Set(values.map(scopeDomain).filter((value): value is string => Boolean(value)))];
}

function assetScopeCandidates(asset: CampaignAsset): unknown[] {
  if (["domain", "subdomain", "ip", "url", "endpoint", "api", "service"].includes(asset.kind)) return [asset.canonical];
  return [];
}

function scopeDomain(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || /[\s@]/.test(trimmed)) return undefined;
  const direct = trimmed.replace(/^\[/, "").replace(/\]$/, "");
  if (isIP(direct)) return direct.toLowerCase();
  try {
    const parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed.replace(/^\*\./, "")}`);
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    if (isIP(hostname) || /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(hostname)) return hostname;
  } catch {
  }
  return undefined;
}
