import type { EmailProviderID } from "./types";

export type OAuthProviderConfig = {
  authorizeUrl: string;
  tokenUrl: string;
  deviceCodeUrl?: string;
  defaultScopes: string[];
  needsClientSecret: boolean;
  authorizeExtraParams?: Record<string, string>;
};

export const EMAIL_OAUTH_PROVIDERS: Partial<Record<EmailProviderID, OAuthProviderConfig>> = {
  gmail: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    deviceCodeUrl: "https://oauth2.googleapis.com/device/code",
    defaultScopes: ["https://mail.google.com/"],
    needsClientSecret: true,
    authorizeExtraParams: { access_type: "offline", prompt: "consent" }
  },
  outlook: {
    authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    deviceCodeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/devicecode",
    defaultScopes: ["https://outlook.office.com/IMAP.AccessAsUser.All", "offline_access"],
    needsClientSecret: false
  },
  yahoo: {
    authorizeUrl: "https://api.login.yahoo.com/oauth2/request_auth",
    tokenUrl: "https://api.login.yahoo.com/oauth2/get_token",
    defaultScopes: ["mail-w"],
    needsClientSecret: true
  }
};

export function emailOAuthProvider(provider: EmailProviderID): OAuthProviderConfig | undefined {
  return EMAIL_OAUTH_PROVIDERS[provider];
}
