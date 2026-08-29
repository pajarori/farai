import type { ToolAttachment, ToolDefinition, ToolResult } from "../types";
import { assertObject, asString } from "../utils";
import { listMcpResources, readMcpResource } from "./mcp-manager";
import { takeBytes } from "./shared/output-bound";

const render = (result: ToolResult): string => result.output ?? result.summary;
const MAX_RESOURCE_LIST = 500;
const MAX_RESOURCE_TEXT_BYTES = 256 * 1024;
const MAX_RESOURCE_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_RESOURCE_IMAGES = 8;

export const mcpResourceListTool: ToolDefinition = {
  name: "mcp_resource_list",
  description: "List resources exposed by configured MCP servers for this session.",
  inputSchema: { type: "object", properties: { server: { type: "string" } }, additionalProperties: false },
  mutates: false,
  timeoutMs: 90_000,
  parallel: true,
  renderHuman: render,
  renderModel: render,
  run: async (args, context) => {
    assertObject(args, "args");
    const server = typeof args.server === "string" ? args.server : undefined;
    const allResources = (await listMcpResources({
      workspace: context.workspace,
      ...(context.rootWorkspace ? { configWorkspace: context.rootWorkspace } : {}),
      session: context.session,
      ...(context.signal ? { signal: context.signal } : {})
    }))
      .filter((resource) => !server || resource.server === server);
    const resources = allResources.slice(0, MAX_RESOURCE_LIST).map((resource) => ({
      server: takeBytes(resource.server, 200, "head"),
      name: takeBytes(resource.name, 500, "head"),
      ...(resource.title ? { title: takeBytes(resource.title, 500, "head") } : {}),
      uri: takeBytes(resource.uri, 2_000, "head"),
      ...(resource.mimeType ? { mimeType: takeBytes(resource.mimeType, 200, "head") } : {}),
      ...(resource.description ? { description: takeBytes(resource.description, 1_000, "head") } : {})
    }));
    const output = resources.length
      ? takeBytes(resources.map((resource) => `${resource.server}: ${resource.title ?? resource.name}\n  ${resource.uri}${resource.mimeType ? `\n  ${resource.mimeType}` : ""}${resource.description ? `\n  ${resource.description}` : ""}`).join("\n\n"), MAX_RESOURCE_TEXT_BYTES, "head")
      : "no MCP resources";
    return {
      ok: true,
      summary: `${allResources.length} MCP resources`,
      output,
      metadata: {
        count: allResources.length,
        returned: resources.length,
        truncated: allResources.length > resources.length,
        ...(server ? { server: takeBytes(server, 200, "head") } : {})
      }
    };
  }
};

export const mcpResourceReadTool: ToolDefinition = {
  name: "mcp_resource_read",
  description: "Read one resource from a configured MCP server by exact URI.",
  inputSchema: { type: "object", required: ["server", "uri"], properties: { server: { type: "string" }, uri: { type: "string" } }, additionalProperties: false },
  mutates: false,
  timeoutMs: 90_000,
  parallel: true,
  renderHuman: render,
  renderModel: render,
  run: async (args, context) => {
    assertObject(args, "args");
    const server = asString(args.server, "server");
    const uri = asString(args.uri, "uri");
    const raw = await readMcpResource({
      workspace: context.workspace,
      ...(context.rootWorkspace ? { configWorkspace: context.rootWorkspace } : {}),
      session: context.session,
      ...(context.signal ? { signal: context.signal } : {}),
      server,
      uri
    });
    const rendered = renderMcpResource(raw);
    return { ok: true, summary: `read ${server} resource ${uri}`, output: rendered.output || "resource contained no text", ...(rendered.attachments.length ? { attachments: rendered.attachments } : {}), metadata: { server, uri } };
  }
};

export function renderMcpResource(raw: unknown): { output: string; attachments: ToolAttachment[] } {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  const contents = Array.isArray(record?.contents) ? record.contents : [];
  const text: string[] = [];
  const attachments: ToolAttachment[] = [];
  let textBytes = 0;
  const appendText = (value: string): void => {
    const remaining = MAX_RESOURCE_TEXT_BYTES - textBytes;
    if (remaining <= 0 || !value) return;
    const bounded = takeBytes(value, remaining, "head");
    text.push(bounded);
    textBytes += Buffer.byteLength(bounded, "utf8");
  };
  for (const item of contents) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const content = item as Record<string, unknown>;
    if (typeof content.text === "string") appendText(content.text);
    if (typeof content.blob === "string" && typeof content.mimeType === "string" && isImageMime(content.mimeType)) {
      if (attachments.length >= MAX_RESOURCE_IMAGES) throw new Error(`MCP resource contains more than ${MAX_RESOURCE_IMAGES} images`);
      const bytes = validateBase64Image(content.blob);
      if (bytes > MAX_RESOURCE_IMAGE_BYTES) throw new Error(`MCP resource image exceeds ${MAX_RESOURCE_IMAGE_BYTES} bytes`);
      attachments.push({ kind: "image", mediaType: content.mimeType, data: content.blob, ...(typeof content.uri === "string" ? { name: content.uri } : {}) });
    } else if (typeof content.blob === "string") {
      appendText(`[binary MCP resource${typeof content.mimeType === "string" ? `: ${content.mimeType}` : ""}, ${content.blob.length} base64 characters]`);
    }
  }
  if (!contents.length) appendText(typeof raw === "string" ? raw : JSON.stringify(raw, null, 2));
  return { output: takeBytes(text.filter(Boolean).join("\n\n"), MAX_RESOURCE_TEXT_BYTES, "head"), attachments };
}

function validateBase64Image(value: string): number {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) throw new Error("MCP resource image contains invalid base64");
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) throw new Error("MCP resource image contains invalid base64");
  return decoded.byteLength;
}

function isImageMime(value: string): value is ToolAttachment["mediaType"] {
  return value === "image/png" || value === "image/jpeg" || value === "image/gif" || value === "image/webp";
}

export const mcpResourceTools: ToolDefinition[] = [mcpResourceListTool, mcpResourceReadTool];
