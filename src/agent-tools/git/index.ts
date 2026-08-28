import type { ToolDefinition } from "../../types";
import { gitStatusTool } from "./status";
import { gitDiffTool } from "./diff";

export const gitTools: ToolDefinition[] = [gitStatusTool, gitDiffTool];
