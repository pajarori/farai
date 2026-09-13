import type { ToolDefinition } from "../../types";
import { todoAddTool } from "./add";
import { todoUpdateTool } from "./update";
import { todoListTool } from "./list";
import { updatePlanTool } from "./update-plan";

export const todoTools: ToolDefinition[] = [todoAddTool, todoUpdateTool, todoListTool, updatePlanTool];
