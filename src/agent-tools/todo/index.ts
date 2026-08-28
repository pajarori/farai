import type { ToolDefinition } from "../../types";
import { todoAddTool } from "./add";
import { todoUpdateTool } from "./update";
import { todoListTool } from "./list";

export const todoTools: ToolDefinition[] = [todoAddTool, todoUpdateTool, todoListTool];
