import type { ToolDefinition } from "../../types";
import { fsReadTool } from "./read";
import { fsListTool } from "./list";
import { fsGrepTool } from "./grep";
import { fsWriteTool } from "./write";
import { fsEditTool } from "./edit";
import { patchApplyTool } from "./patch-apply";

export const filesystemTools: ToolDefinition[] = [fsReadTool, fsListTool, fsGrepTool, fsWriteTool, fsEditTool, patchApplyTool];
