import { Dynamic } from "@opentui/solid";
import type { Component, JSX } from "solid-js";
import type { TimelineRow } from "../renderers";
import { UserPrompt } from "./cells/user-cell";
import { AssistantMessage } from "./cells/assistant-cell";
import { ReasoningRow } from "./cells/reasoning-cell";
import { ActivityRow, ToolRow } from "./cells/tool-cell";
import { NoticeRow } from "./cells/notice-cell";
import { ArtifactRow, FindingRow, McpInventoryRow } from "./cells/artifact-cell";
import { PlanRow } from "./cells/plan-cell";
import { TodoListRow } from "./cells/todo-list-cell";
import { PhaseRow, ProgressRow } from "./cells/progress-cell";

type FaraiRowProps = {
  row: TimelineRow;
  streamedText?: string | undefined;
  streamedReasoning?: string | undefined;
  animated?: boolean | undefined;
};

type RowComponent = Component<FaraiRowProps>;

const ROW_COMPONENTS = {
  user: ((props) => <UserPrompt row={props.row as Extract<TimelineRow, { kind: "user" }>} />),
  assistant: ((props) => <AssistantMessage row={props.row as Extract<TimelineRow, { kind: "assistant" }>} streamedText={props.streamedText} />),
  thinking: ((props) => <ReasoningRow row={props.row as Extract<TimelineRow, { kind: "thinking" }>} streamedReasoning={props.streamedReasoning} animated={props.animated} />),
  tool: ((props) => <ToolRow row={props.row as Extract<TimelineRow, { kind: "tool" }>} animated={props.animated} />),
  activity: ((props) => <ActivityRow row={props.row as Extract<TimelineRow, { kind: "activity" }>} animated={props.animated} />),
  plan: ((props) => <PlanRow row={props.row as Extract<TimelineRow, { kind: "plan" }>} animated={props.animated} />),
  todo_list: ((props) => <TodoListRow row={props.row as Extract<TimelineRow, { kind: "todo_list" }>} />),
  mcp_inventory: ((props) => <McpInventoryRow row={props.row as Extract<TimelineRow, { kind: "mcp_inventory" }>} />),
  artifact: ((props) => <ArtifactRow row={props.row as Extract<TimelineRow, { kind: "artifact" }>} />),
  finding: ((props) => <FindingRow row={props.row as Extract<TimelineRow, { kind: "finding" }>} />),
  progress: ((props) => <ProgressRow row={props.row as Extract<TimelineRow, { kind: "progress" }>} animated={props.animated} />),
  phase: ((props) => <PhaseRow row={props.row as Extract<TimelineRow, { kind: "phase" }>} />),
  loop_stop: ((props) => <NoticeRow row={props.row as Extract<TimelineRow, { kind: "loop_stop" }>} />),
  compaction: ((props) => <NoticeRow row={props.row as Extract<TimelineRow, { kind: "compaction" }>} />),
  error: ((props) => <NoticeRow row={props.row as Extract<TimelineRow, { kind: "error" }>} />),
  notice: ((props) => <NoticeRow row={props.row as Extract<TimelineRow, { kind: "notice" }>} />)
} satisfies Record<TimelineRow["kind"], RowComponent>;

export function FaraiRow(props: FaraiRowProps): JSX.Element {
  return <Dynamic component={ROW_COMPONENTS[props.row.kind]} {...props} />;
}
