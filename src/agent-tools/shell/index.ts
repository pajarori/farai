import type { ToolDefinition } from "../../types";
import { execTool } from "./exec";
import { sessionPollTool } from "./session-poll";
import { sessionStopTool } from "./session-stop";

export const shellTools: ToolDefinition[] = [execTool, sessionPollTool, sessionStopTool];
