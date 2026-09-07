import type { EmailCredential, EmailOAuthCredential } from "./types";

export function parseEmailCredential(raw: string): EmailCredential {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as {
        kind?: string;
        secret?: string;
        accessToken?: string;
        refreshToken?: string;
        expiresAt?: string;
        clientId?: string;
        clientSecret?: string;
        scopes?: unknown;
        authorizeUrl?: string;
        tokenUrl?: string;
        deviceCodeUrl?: string;
      };
      if (parsed.kind === "oauth" && typeof parsed.accessToken === "string") {
        return {
          kind: "oauth",
          accessToken: parsed.accessToken,
          ...(parsed.refreshToken ? { refreshToken: parsed.refreshToken } : {}),
          ...(parsed.expiresAt ? { expiresAt: parsed.expiresAt } : {}),
          clientId: String(parsed.clientId ?? ""),
          ...(parsed.clientSecret ? { clientSecret: parsed.clientSecret } : {}),
          scopes: Array.isArray(parsed.scopes) ? parsed.scopes.map(String) : [],
          authorizeUrl: String(parsed.authorizeUrl ?? ""),
          tokenUrl: String(parsed.tokenUrl ?? ""),
          ...(parsed.deviceCodeUrl ? { deviceCodeUrl: parsed.deviceCodeUrl } : {})
        };
      }
      if (parsed.kind === "password" && typeof parsed.secret === "string") {
        return { kind: "password", secret: parsed.secret };
      }
    } catch {
    }
  }
  return { kind: "password", secret: raw };
}

export function serializeEmailCredential(credential: EmailCredential): string {
  return credential.kind === "password" ? credential.secret : JSON.stringify(credential);
}

export function oauthCredentialExpired(credential: EmailOAuthCredential, skewMs = 60_000, now = Date.now()): boolean {
  if (!credential.expiresAt) return false;
  const expiresAt = Date.parse(credential.expiresAt);
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt - skewMs <= now;
}
