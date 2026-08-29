import type { ToolDefinition } from "../../types";
import { webFetchTool } from "./web-fetch";
import { webSearchTool } from "./web-search";

export const webTools: ToolDefinition[] = [webSearchTool, webFetchTool];
