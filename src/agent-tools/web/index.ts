import type { ToolDefinition } from "../../types";
import { internetFetchTool } from "./web-fetch";
import { internetSearchTool } from "./web-search";

export const webTools: ToolDefinition[] = [internetSearchTool, internetFetchTool];
