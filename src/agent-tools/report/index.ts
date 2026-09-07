import type { ToolDefinition } from "../../types";
import { reportAddFindingTool } from "./add-finding";
import { cvssCalculateTool } from "./cvss-calculate";

export const reportTools: ToolDefinition[] = [cvssCalculateTool, reportAddFindingTool];
