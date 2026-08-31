import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { InlineToolAttachment, ToolAttachment } from "./types";
import { atomicWriteFile } from "./agent-core/atomic-file";
import { readBoundedFileBytesSync } from "./file-read";

export const TOOL_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

export function loadToolAttachmentBytes(attachment: ToolAttachment, maxBytes = TOOL_ATTACHMENT_MAX_BYTES): Buffer {
  const bytes = attachment.data !== undefined
    ? decodeBase64(attachment.data)
    : readBoundedFileBytesSync(attachment.path, maxBytes, "tool attachment");
  if (bytes.byteLength > maxBytes) throw new Error(`tool attachment exceeds ${maxBytes} bytes`);
  if (attachment.bytes !== undefined && attachment.bytes !== bytes.byteLength) throw new Error("tool attachment size does not match stored metadata");
  if (attachment.sha256 && attachment.sha256 !== digest(bytes)) throw new Error("tool attachment hash does not match stored metadata");
  return bytes;
}

export function persistToolAttachment(root: string, sessionId: string, attachment: ToolAttachment): ToolAttachment {
  const bytes = loadToolAttachmentBytes(attachment);
  const sha256 = digest(bytes);
  const directory = join(root, "attachments", sessionAttachmentDirectory(sessionId));
  const path = join(directory, `${sha256}.${extension(attachment.mediaType)}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    try {
      atomicWriteFile(path, bytes, 0o600);
    } catch (error) {
      if (!existsSync(path)) throw error;
    }
  }
  return {
    kind: "image",
    mediaType: attachment.mediaType,
    path,
    bytes: bytes.byteLength,
    sha256,
    ...(attachment.name ? { name: attachment.name } : {}),
    ...(attachment.detail ? { detail: attachment.detail } : {})
  };
}

export function materializeToolAttachment(attachment: ToolAttachment): InlineToolAttachment {
  if (attachment.data !== undefined) return attachment;
  return { ...attachment, data: loadToolAttachmentBytes(attachment).toString("base64") };
}

export function toolAttachmentBytes(attachment: ToolAttachment): number {
  if (attachment.bytes !== undefined) return attachment.bytes;
  if (attachment.data === undefined) return 0;
  const padding = attachment.data.endsWith("==") ? 2 : attachment.data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(attachment.data.length * 3 / 4) - padding);
}

export function sessionAttachmentDirectory(sessionId: string): string {
  return digest(Buffer.from(sessionId, "utf8")).slice(0, 32);
}

function decodeBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) throw new Error("tool attachment contains invalid base64");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) throw new Error("tool attachment contains invalid base64");
  return bytes;
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function extension(mediaType: ToolAttachment["mediaType"]): string {
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/gif") return "gif";
  if (mediaType === "image/webp") return "webp";
  return "png";
}
