import type { ToolDefinition } from "../../types";
import { execTool } from "./exec";
import { sessionPollTool } from "./session-poll";
import { sessionStopTool } from "./session-stop";
import { execCommandTool } from "./exec-command";
import { writeStdinTool } from "./write-stdin";

export const shellTools: ToolDefinition[] = [execTool, writeStdinTool, sessionPollTool, sessionStopTool];
