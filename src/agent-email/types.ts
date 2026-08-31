import type { ConfigLocation } from "../agent-core/config";

export type EmailProviderID = "gmail" | "yahoo" | "outlook" | "icloud" | "fastmail" | "zoho" | "custom";
export type EmailAuthMode = "password" | "oauth";
export type EmailCredentialStorage = "system" | "session";
export type EmailRole = "primary" | "secondary";

export type EmailProviderPreset = {
  id: EmailProviderID;
  label: string;
  host: string;
  port: number;
  secure: boolean;
  auth: EmailAuthMode;
  credentialLabel: string;
};

export type EmailAccountInfo = {
  id: string;
  label: string;
  provider: EmailProviderID;
  address: string;
  username: string;
  host: string;
  port: number;
  secure: boolean;
  auth: EmailAuthMode;
  credentialStorage: EmailCredentialStorage;
  credentialConfigured: boolean;
  source: ConfigLocation;
  location: ConfigLocation;
  removable: true;
};

export type SaveEmailAccountInput = {
  id?: string;
  label: string;
  provider: EmailProviderID;
  address: string;
  username?: string;
  host?: string;
  port?: number;
  secure?: boolean;
  auth?: EmailAuthMode;
  credential?: string;
  credentialAction?: "keep" | "replace" | "remove";
  credentialStorage?: EmailCredentialStorage;
  location?: ConfigLocation;
};

export type EmailAccountProbe = {
  ok: boolean;
  latencyMs: number;
  mailbox?: string;
  messages?: number;
  error?: string;
};

export type ProbeEmailAccountInput = {
  emailId?: string;
  account?: SaveEmailAccountInput;
  credential?: string;
};

export type DisposableInboxActivity = {
  id: string;
  label?: string;
  address: string;
  provider: "mail.tm" | "mail.gw";
  status: "ready" | "waiting" | "closing";
  createdAt: string;
  lastUsedAt?: string;
};

export type EmailResourceInfo = {
  id: string;
  label: string;
  address: string;
  type: "imap" | "temporary";
  provider: string;
  status: "ready" | "waiting" | "closing" | "credential needed";
  roles: EmailRole[];
  createdAt?: string;
  expiresAt?: string;
};

export type EmailMessageReference = {
  id: string;
  sessionId: string;
  emailId: string;
  providerMessageId: string;
};

export type EmailMessageSummary = {
  id: string;
  from: string;
  to: string[];
  subject: string;
  intro?: string;
  seen: boolean;
  hasAttachments: boolean;
  size?: number;
  receivedAt?: string;
};

export type EmailAttachmentSummary = {
  filename: string;
  contentType: string;
  size: number;
};

export type EmailMessageDetail = EmailMessageSummary & {
  text: string;
  html?: string;
  urls: string[];
  otpCandidates: string[];
  attachments: EmailAttachmentSummary[];
  raw?: string;
};
