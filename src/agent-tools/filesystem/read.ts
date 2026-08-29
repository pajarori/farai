import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { containerListDir, containerPathKind, containerReadFile, containerRelativePath, containerStatMtime, resolveContainerPath } from "./container-fs";
import { page } from "./shared";

export const fsReadTool: ToolDefinition = {
  name: "fs_read",
  description: "Read a workspace file or list a workspace directory with bounded output. Runs inside the Kali container.",
  inputSchema: {
    type: "object",
    required: ["path"],
    properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" }, pages: { type: "string", description: "PDF page or inclusive range, for example 1 or 2-8" } }
  },
  mutates: false,
  timeoutMs: 10_000,
  parallel: true,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const path = asString(args.path, "path");
    const kind = await containerPathKind(context, path);
    if (kind === "missing") throw new Error(`no such file or directory: ${path}`);
    if (kind === "dir") {
      const entries = await containerListDir(context, path);
      const paged = page(entries, args.offset, args.limit);
      return { ok: true, summary: `directory ${containerRelativePath(path)}: ${paged.items.length}/${entries.length}`, output: paged.items.join("\n") };
    }
    const resolved = resolveContainerPath(path);
    if (path.toLowerCase().endsWith(".pdf")) return await readPdf(context, path, args.pages);
    const offset = typeof args.offset === "number" ? args.offset : undefined;
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    const cache = context.fileState;
    const mtime = cache ? await containerStatMtime(context, path) : undefined;
    if (cache && mtime !== undefined) {
      const existing = cache.get(context.session.id, resolved);
      if (existing && existing.mtime === mtime && existing.offset === offset && existing.limit === limit) {
        return {
          ok: true,
          summary: `file ${containerRelativePath(path)} unchanged since your last read`,
          output: "This file is unchanged since your last read; its current content is available in the Active Working Files block. Re-read only to view a different line range."
        };
      }
    }
    const text = await containerReadFile(context, path);
    const lines = text.split("\n");
    const paged = page(lines, args.offset, args.limit);
    if (cache) cache.set(context.session.id, { path: resolved, content: text, mtime: mtime ?? Date.now(), ...(offset !== undefined ? { offset } : {}), ...(limit !== undefined ? { limit } : {}) });
    return { ok: true, summary: `file ${containerRelativePath(path)} lines ${paged.start}-${paged.end}/${lines.length}`, output: paged.items.join("\n") };
  }
};

async function readPdf(context: import("../../types").ToolContext, path: string, pages: unknown): Promise<import("../../types").ToolResult> {
  const range = typeof pages === "string" ? pages.match(/^(\d+)(?:-(\d+))?$/) : undefined;
  if (typeof pages === "string" && !range) throw new Error("pages must be a page number or inclusive range such as 2-8");
  const first = range ? Number(range[1]) : 1;
  const last = range ? Number(range[2] ?? range[1]) : undefined;
  if (last !== undefined && last < first) throw new Error("PDF page range is reversed");
  const target = resolveContainerPath(path);
  const flags = [`-f ${first}`, ...(last !== undefined ? [`-l ${last}`] : [])].join(" ");
  const command = `pdftotext -layout ${flags} -- '${target.replaceAll("'", `'\"'\"'`)}' -`;
  const result = await (await import("../shared/backend")).backend(context).exec(command, 30_000, context.signal, 4_000_000);
  if (result.exitCode !== 0) throw new Error(result.stderr || "failed to extract PDF text");
  return { ok: true, summary: `PDF ${containerRelativePath(path)} pages ${first}${last ? `-${last}` : "+"}`, output: result.stdout };
}
