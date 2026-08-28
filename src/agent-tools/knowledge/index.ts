import type { ToolDefinition } from "../../types";
import { notesAddTool } from "./notes-add";
import { evidenceSaveTool } from "./evidence-save";
import { memoryAddHypothesisTool } from "./memory-add-hypothesis";
import { memoryMarkFailedTool } from "./memory-mark-failed";
import { skillLoadTool } from "./skill-load";
import { knowledgeSearchTool } from "./knowledge-search";
import { knowledgeReadTool } from "./knowledge-read";
import { knowledgeResolveTool } from "./knowledge-resolve";
import { knowledgeNeighborsTool } from "./knowledge-neighbors";
import { knowledgePrioritizeTool } from "./knowledge-prioritize";

export const knowledgeTools: ToolDefinition[] = [notesAddTool, evidenceSaveTool, memoryAddHypothesisTool, memoryMarkFailedTool, skillLoadTool, knowledgeSearchTool, knowledgeReadTool, knowledgeResolveTool, knowledgeNeighborsTool, knowledgePrioritizeTool];
