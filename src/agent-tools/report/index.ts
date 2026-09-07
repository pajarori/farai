import type { ToolDefinition } from "../../types";
import { reportAddFindingTool } from "./add-finding";
import { cvssCalculateTool } from "./cvss-calculate";
import { reportUpdateFindingTool } from "./update-finding";

export const reportTools: ToolDefinition[] = [cvssCalculateTool, reportAddFindingTool, reportUpdateFindingTool];
