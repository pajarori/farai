import type { ToolDefinition } from "../../types";
import { requestUserInputTool } from "./request-user-input";

export const interactionTools: ToolDefinition[] = [requestUserInputTool];
