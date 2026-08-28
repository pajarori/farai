import type { ToolDefinition } from "../../types";
import { writeScriptTool } from "./write-script";

export const codegenTools: ToolDefinition[] = [writeScriptTool];
