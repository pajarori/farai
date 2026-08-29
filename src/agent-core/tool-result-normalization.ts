import type { OutputArtifact, ToolAttachment, ToolResult } from "../types";
import { takeBytes } from "../agent-tools/shared/output-bound";
import { isBinaryLike, sanitizeToolOutput } from "../agent-tools/shared/output-sanitize";

export const TOOL_ATTACHMENT_LIMITS = Object.freeze({
  count: 8,
  bytes: 20 * 1024 * 1024,
  totalBytes: 40 * 1024 * 1024,
  nameBytes: 512
});

export const TOOL_OUTPUT_LIMITS = Object.freeze({
  bytes: 50 * 1024,
  headBytes: 24 * 1024,
  tailBytes: 24 * 1024
});

type OutputArtifactWriter = (input: { sessionId: string; toolCallId: string; content: string }) => OutputArtifact;

export function normalizeToolResult(
  result: ToolResult,
  input: { sessionId: string; toolCallId: string; saveOutputArtifact: OutputArtifactWriter }
): ToolResult {
  const normalized = normalizeToolAttachments(result);
  if (!normalized.output) return normalized;
  const rawOutput = normalized.output;
  const sanitizedOutput = sanitizeToolOutput(rawOutput);
  const binaryLike = isBinaryLike(rawOutput);
  if (!binaryLike && Buffer.byteLength(sanitizedOutput, "utf8") <= TOOL_OUTPUT_LIMITS.bytes) {
    return sanitizedOutput === rawOutput ? normalized : { ...normalized, output: sanitizedOutput };
  }
  const artifact = input.saveOutputArtifact({ sessionId: input.sessionId, toolCallId: input.toolCallId, content: rawOutput });
  if (binaryLike && Buffer.byteLength(sanitizedOutput, "utf8") <= TOOL_OUTPUT_LIMITS.bytes) {
    return {
      ...normalized,
      output: `${sanitizedOutput}\n\n[full raw output stored as artifact ${artifact.id}; read it with tool_output_read]`,
      outputArtifactId: artifact.id,
      metadata: { ...(normalized.metadata ?? {}), outputArtifact: artifact, binaryLike: true }
    };
  }
  const head = takeBytes(sanitizedOutput, TOOL_OUTPUT_LIMITS.headBytes, "head");
  const tail = takeBytes(sanitizedOutput, TOOL_OUTPUT_LIMITS.tailBytes, "tail");
  return {
    ...normalized,
    output: `${head}\n\n[output truncated: full ${artifact.bytes} bytes stored as artifact ${artifact.id}; read it with tool_output_read]\n\n${tail}`,
    outputArtifactId: artifact.id,
    metadata: { ...(normalized.metadata ?? {}), outputArtifact: artifact }
  };
}

export function normalizeToolAttachments(result: ToolResult): ToolResult {
  if (!result.attachments?.length) return result;
  if (result.attachments.length > TOOL_ATTACHMENT_LIMITS.count) {
    throw new Error(`tool returned more than ${TOOL_ATTACHMENT_LIMITS.count} attachments`);
  }
  let totalBytes = 0;
  const attachments = result.attachments.map((attachment, index) => {
    const bytes = decodeToolAttachment(attachment, index);
    if (bytes.byteLength > TOOL_ATTACHMENT_LIMITS.bytes) {
      throw new Error(`tool attachment ${index + 1} exceeds ${TOOL_ATTACHMENT_LIMITS.bytes} bytes`);
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > TOOL_ATTACHMENT_LIMITS.totalBytes) {
      throw new Error(`tool attachments exceed ${TOOL_ATTACHMENT_LIMITS.totalBytes} total bytes`);
    }
    assertAttachmentMagic(attachment, bytes, index);
    return {
      ...attachment,
      data: bytes.toString("base64"),
      ...(attachment.name ? { name: takeBytes(attachment.name, TOOL_ATTACHMENT_LIMITS.nameBytes, "head") } : {})
    };
  });
  return { ...result, attachments };
}

function decodeToolAttachment(attachment: ToolAttachment, index: number): Buffer {
  if (attachment.kind !== "image") throw new Error(`unsupported tool attachment kind at index ${index}`);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.data) || attachment.data.length % 4 === 1) {
    throw new Error(`tool attachment ${index + 1} contains invalid base64`);
  }
  const bytes = Buffer.from(attachment.data, "base64");
  if (bytes.toString("base64").replace(/=+$/, "") !== attachment.data.replace(/=+$/, "")) {
    throw new Error(`tool attachment ${index + 1} contains invalid base64`);
  }
  return bytes;
}

function assertAttachmentMagic(attachment: ToolAttachment, bytes: Buffer, index: number): void {
  const valid = attachment.mediaType === "image/png"
    ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : attachment.mediaType === "image/jpeg"
      ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : attachment.mediaType === "image/gif"
        ? ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))
        : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (!valid) throw new Error(`tool attachment ${index + 1} does not match ${attachment.mediaType}`);
}
