import type { JSX } from "solid-js";
import type { TimelineRow } from "../renderers";
import { UserPrompt } from "./cells/user-cell";
import { AssistantMessage } from "./cells/assistant-cell";
import { ReasoningRow } from "./cells/reasoning-cell";
import { ExplorationRow, ToolRow } from "./cells/tool-cell";
import { NoticeRow } from "./cells/notice-cell";
import { ArtifactRow, FindingRow, McpInventoryRow } from "./cells/artifact-cell";
import { PlanRow } from "./cells/plan-cell";
import { TodoListRow } from "./cells/todo-list-cell";
import { PhaseRow, ProgressRow } from "./cells/progress-cell";

type FaraiRowProps = {
  row: TimelineRow;
};

export function FaraiRow(props: FaraiRowProps): JSX.Element {
  switch (props.row.kind) {
    case "user": return <UserPrompt row={props.row} />;
    case "assistant": return <AssistantMessage row={props.row} />;
    case "thinking": return <ReasoningRow row={props.row} />;
    case "tool": return <ToolRow row={props.row} />;
    case "exploration": return <ExplorationRow row={props.row} />;
    case "plan": return <PlanRow row={props.row} />;
    case "todo_list": return <TodoListRow row={props.row} />;
    case "mcp_inventory": return <McpInventoryRow row={props.row} />;
    case "artifact": return <ArtifactRow row={props.row} />;
    case "finding": return <FindingRow row={props.row} />;
    case "progress": return <ProgressRow row={props.row} />;
    case "phase": return <PhaseRow row={props.row} />;
    case "loop_stop":
    case "compaction":
    case "error":
    case "notice":
      return <NoticeRow row={props.row} />;
  }
}
