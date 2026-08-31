import type { ToolAttachment } from "../../types";
import { toolAttachmentBytes } from "../../tool-attachment";
import type { ProviderMessage } from "./protocol";

const KIB = 1024;
const MIB = 1024 * KIB;

export const OPENAI_REQUEST_LIMITS = Object.freeze({
  bodyBytes: 64 * MIB,
  attachmentBytes: 48 * MIB,
  attachments: 16
});

export const ANTHROPIC_REQUEST_LIMITS = Object.freeze({
  bodyBytes: 30 * MIB,
  attachmentBytes: 18 * MIB,
  attachments: 12
});

export type ProviderRequestLimits = {
  bodyBytes: number;
  attachmentBytes: number;
  attachments: number;
};

export function prepareProviderMessages(messages: ProviderMessage[], limits: ProviderRequestLimits): ProviderMessage[] {
  const selected = new Map<number, Set<number>>();
  let selectedAttachments = 0;
  let selectedBytes = 0;
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]!;
    if ((message.role !== "user" && message.role !== "tool") || !message.attachments?.length) continue;
    for (let attachmentIndex = 0; attachmentIndex < message.attachments.length; attachmentIndex += 1) {
      const attachment = message.attachments[attachmentIndex]!;
      const bytes = encodedAttachmentBytes(attachment);
      if (selectedAttachments >= limits.attachments || selectedBytes + bytes > limits.attachmentBytes) continue;
      const indexes = selected.get(messageIndex) ?? new Set<number>();
      indexes.add(attachmentIndex);
      selected.set(messageIndex, indexes);
      selectedAttachments += 1;
      selectedBytes += bytes;
    }
  }
  return messages.map((message, messageIndex): ProviderMessage => {
    if (message.role !== "user" && message.role !== "tool") return message;
    const attachments = message.attachments ?? [];
    if (!attachments.length) return message;
    const indexes = selected.get(messageIndex);
    const retained = indexes ? attachments.filter((_, index) => indexes.has(index)) : [];
    const omitted = attachments.length - retained.length;
    const text = omitted > 0
      ? `${message.text}\n\n[${omitted} image attachment${omitted === 1 ? "" : "s"} omitted from this request to keep it within provider limits]`
      : message.text;
    if (message.role === "user") return { role: "user", text, ...(retained.length ? { attachments: retained } : {}) };
    return {
      role: "tool",
      toolCallId: message.toolCallId,
      name: message.name,
      text,
      ...(retained.length ? { attachments: retained } : {})
    };
  });
}

export function serializeProviderRequestBody(value: unknown, maxBytes: number, label: string): string {
  const serialized = JSON.stringify(value);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > maxBytes) throw new Error(`${label} exceeded the ${maxBytes}-byte request limit`);
  return serialized;
}

function encodedAttachmentBytes(attachment: ToolAttachment): number {
  if (attachment.data !== undefined) return Buffer.byteLength(attachment.data, "utf8") + 128;
  return Math.ceil(toolAttachmentBytes(attachment) / 3) * 4 + 128;
}
