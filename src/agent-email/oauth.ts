import { createHash, randomBytes } from "node:crypto";
import { openLoopbackAuthCallback, withDeadline } from "../agent-core/oauth-loopback";
import type { OAuthProviderConfig } from "./oauth-providers";
import type { EmailOAuthCredential } from "./types";

export type EmailOAuthClient = {
  provider: OAuthProviderConfig;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  loginHint?: string;
};

export type DeviceCodePrompt = {
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
};

const LOOPBACK_TIMEOUT_MS = 300_000;

export async function authorizeEmailOAuthLoopback(client: EmailOAuthClient, signal: AbortSignal): Promise<EmailOAuthCredential> {
  const callback = await openLoopbackAuthCallback(undefined);
  try {
    const verifier = randomBase64Url(32);
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    const state = randomBase64Url(32);
    callback.expectState(state);
    const authorizeUrl = new URL(client.provider.authorizeUrl);
    setSearchParams(authorizeUrl, {
      client_id: client.clientId,
      redirect_uri: callback.url.toString(),
      response_type: "code",
      scope: client.scopes.join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      ...(client.loginHint ? { login_hint: client.loginHint } : {}),
      ...(client.provider.authorizeExtraParams ?? {})
    });
    callback.authorize(authorizeUrl);
    const code = await callback.waitForCode(signal, LOOPBACK_TIMEOUT_MS);
    const response = await postToken(client, {
      grant_type: "authorization_code",
      code,
      redirect_uri: callback.url.toString(),
      code_verifier: verifier
    }, signal);
    return credentialFromToken(client, response);
  } finally {
    await callback.close(signal.reason instanceof Error ? signal.reason : undefined);
  }
}

export async function authorizeEmailOAuthDeviceCode(
  client: EmailOAuthClient,
  onPrompt: (prompt: DeviceCodePrompt) => void,
  signal: AbortSignal
): Promise<EmailOAuthCredential> {
  if (!client.provider.deviceCodeUrl) throw new Error("this provider does not support device-code sign-in");
  const start = await postForm(client.provider.deviceCodeUrl, {
    client_id: client.clientId,
    scope: client.scopes.join(" ")
  }, signal);
  const deviceCode = String(start.device_code ?? "");
  const userCode = String(start.user_code ?? "");
  const verificationUri = String(start.verification_uri ?? start.verification_url ?? start.verification_uri_complete ?? "");
  if (!deviceCode || !userCode || !verificationUri) throw new Error("device-code response was incomplete");
  const expiresInSeconds = toPositiveInt(start.expires_in, 900);
  onPrompt({ userCode, verificationUri, expiresInSeconds });
  let intervalSeconds = toPositiveInt(start.interval, 5);
  const deadline = Date.now() + expiresInSeconds * 1_000;
  for (;;) {
    signal.throwIfAborted();
    await sleep(intervalSeconds * 1_000, signal);
    if (Date.now() > deadline) throw new Error("device-code sign-in expired before it was approved");
    const response = await postToken(client, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode
    }, signal, true);
    if (response.error) {
      const error = String(response.error);
      if (error === "authorization_pending") continue;
      if (error === "slow_down") { intervalSeconds += 5; continue; }
      throw new Error(deviceErrorMessage(error));
    }
    return credentialFromToken(client, response);
  }
}

export async function refreshEmailOAuth(credential: EmailOAuthCredential, signal?: AbortSignal): Promise<EmailOAuthCredential> {
  if (!credential.refreshToken) throw new Error("this account has no refresh token · reconnect it from /email");
  const client: EmailOAuthClient = {
    provider: {
      authorizeUrl: credential.authorizeUrl,
      tokenUrl: credential.tokenUrl,
      defaultScopes: credential.scopes,
      needsClientSecret: Boolean(credential.clientSecret),
      ...(credential.deviceCodeUrl ? { deviceCodeUrl: credential.deviceCodeUrl } : {})
    },
    clientId: credential.clientId,
    ...(credential.clientSecret ? { clientSecret: credential.clientSecret } : {}),
    scopes: credential.scopes
  };
  const response = await postToken(client, {
    grant_type: "refresh_token",
    refresh_token: credential.refreshToken
  }, signal);
  return credentialFromToken(client, response, credential.refreshToken);
}

async function postToken(
  client: EmailOAuthClient,
  params: Record<string, string>,
  signal: AbortSignal | undefined,
  tolerateError = false
): Promise<Record<string, unknown>> {
  const body: Record<string, string> = { client_id: client.clientId, ...params };
  if (client.clientSecret) body.client_secret = client.clientSecret;
  return await postForm(client.provider.tokenUrl, body, signal, tolerateError);
}

async function postForm(
  url: string,
  params: Record<string, string>,
  signal: AbortSignal | undefined,
  tolerateError = false
): Promise<Record<string, unknown>> {
  const response = await withDeadline(fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(params).toString(),
    ...(signal ? { signal } : {})
  }), 30_000, "oauth token request", signal);
  const text = await response.text();
  let json: Record<string, unknown>;
  try {
    json = text ? JSON.parse(text) as Record<string, unknown> : {};
  } catch {
    throw new Error(`oauth endpoint returned an unreadable response (${response.status})`);
  }
  if (!response.ok && !tolerateError) {
    const detail = String(json.error_description ?? json.error ?? `http ${response.status}`);
    throw new Error(`oauth request failed: ${detail}`);
  }
  return json;
}

function credentialFromToken(client: EmailOAuthClient, response: Record<string, unknown>, previousRefresh?: string): EmailOAuthCredential {
  const accessToken = String(response.access_token ?? "");
  if (!accessToken) throw new Error("oauth response did not include an access token");
  const refreshToken = typeof response.refresh_token === "string" && response.refresh_token ? response.refresh_token : previousRefresh;
  const expiresIn = Number(response.expires_in);
  return {
    kind: "oauth",
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: new Date(Date.now() + expiresIn * 1_000).toISOString() } : {}),
    clientId: client.clientId,
    ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
    scopes: client.scopes,
    authorizeUrl: client.provider.authorizeUrl,
    tokenUrl: client.provider.tokenUrl,
    ...(client.provider.deviceCodeUrl ? { deviceCodeUrl: client.provider.deviceCodeUrl } : {})
  };
}

function deviceErrorMessage(error: string): string {
  if (error === "expired_token") return "device-code sign-in expired before it was approved";
  if (error === "access_denied") return "sign-in was denied";
  return `device-code sign-in failed: ${error}`;
}

function setSearchParams(url: URL, params: Record<string, string>): void {
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
}

function randomBase64Url(bytes: number): string {
  return base64Url(randomBytes(bytes));
}

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function toPositiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("oauth sign-in cancelled"));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}
