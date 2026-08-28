import type { ToolDefinition } from "../../types";
import { sessionRenameTool } from "./rename";
import { agentTaskTool } from "./task";

export const agentTools: ToolDefinition[] = [agentTaskTool, sessionRenameTool];
