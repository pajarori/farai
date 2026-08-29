import type { ToolDefinition } from "../../types";
import { sessionRenameTool } from "./rename";
import { agentLifecycleTools } from "./lifecycle";

export const agentTools: ToolDefinition[] = [...agentLifecycleTools, sessionRenameTool];
