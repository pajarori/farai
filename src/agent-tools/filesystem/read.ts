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
    properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }
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
