import type { ToolDefinition } from "../../types";
import { callbackHostInfoTool } from "./host-info";
import { callbackListenTool } from "./listen";
import { callbackStopTool } from "./stop";
import { callbackOastTool } from "./oast";

export const callbackTools: ToolDefinition[] = [callbackHostInfoTool, callbackListenTool, callbackOastTool, callbackStopTool];
