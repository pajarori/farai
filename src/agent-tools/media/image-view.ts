import { readFileSync, statSync } from "node:fs";
import { basename, relative } from "node:path";
import type { ToolAttachment, ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { safeExistingWorkspacePath } from "../filesystem/shared";
import { backend } from "../shared/backend";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export const imageViewTool: ToolDefinition = {
  name: "image_view",
  description: "Inspect a local workspace image with the active multimodal model. Returns dimensions, MIME information, OCR text when available, and the image itself.",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: { path: { type: "string" }, detail: { type: "string", enum: ["auto", "low", "high"] } },
    additionalProperties: false
  },
  mutates: false,
  timeoutMs: 30_000,
  parallel: true,
  renderHuman: (result) => result.output ?? result.summary,
  renderModel: (result) => [result.summary, result.output].filter(Boolean).join("\n"),
  run: async (args, context) => {
    assertObject(args, "args");
    const requested = asString(args.path, "path");
    const path = safeExistingWorkspacePath(context.workspace, requested, "read");
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error(`not a file: ${requested}`);
    if (stat.size > MAX_IMAGE_BYTES) throw new Error(`image exceeds ${MAX_IMAGE_BYTES} bytes`);
    const data = readFileSync(path);
    const mediaType = detectImage(data);
    if (!mediaType) throw new Error("unsupported image format; use PNG, JPEG, GIF, or WebP");
    const workspaceRelative = relative(context.workspace, path).split(/[\\/]+/).join("/");
    const backendPath = context.executionBackend?.kind === "host" ? path : `/workspace/${workspaceRelative}`;
    const command = `identify -format '%m %wx%h' -- ${quote(backendPath)} 2>/dev/null; printf '\n'; tesseract ${quote(backendPath)} stdout 2>/dev/null | head -200`;
    const inspected = await backend(context).exec(command, 25_000, context.signal, 30_000);
    const [identity = "", ...ocrLines] = inspected.stdout.split("\n");
    const ocr = ocrLines.join("\n").trim();
    const detail = args.detail === "low" || args.detail === "high" || args.detail === "auto" ? args.detail : "auto";
    const attachment: ToolAttachment = { kind: "image", mediaType, data: data.toString("base64"), name: basename(path), detail };
    return {
      ok: true,
      summary: `image ${basename(path)}${identity.trim() ? ` · ${identity.trim()}` : ""}`,
      output: ocr ? `OCR text:\n${ocr}` : "image attached for visual inspection",
      attachments: [attachment],
      metadata: { path, mediaType, bytes: stat.size, ...(identity.trim() ? { identity: identity.trim() } : {}) }
    };
  }
};

function detectImage(data: Buffer): ToolAttachment["mediaType"] | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}
