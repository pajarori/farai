import { For, Index, Show, type JSX } from "solid-js";
import type { TimelineRow, ToolTimelineRow } from "../../renderers";
import { truncateLine } from "../../renderers";
import { inferFiletype } from "../../filetype";
import { syntax } from "../../syntax";
import { COLOR } from "../../theme";
import { useTuiDimensions } from "../../context/terminal";
import { parseDirectoryResults, parseNmap, splitHttpResponse, unifiedEditDiff } from "../../tool-renderers";
import { useTuiStore } from "../../context/store";
import { args, tailLines } from "./text-utils";
import {
  isActiveToolStatus,
  shortToolName,
  toolInputKind
} from "../../tool-presentation";
import { formatActivityDuration, presentToolActivity } from "../../tool-activity";
import { titleFromPrompt } from "../../../session-title";
import { ExpandedPanel } from "./expanded-panel";
import { TranscriptMarker } from "./transcript-marker";
import { createPrimaryClickGesture } from "../../input/mouse";
import { fitTerminalPair } from "../../terminal-text";

const TOOL_OUTPUT_PREVIEW_LINES = 5;

type ToolRowProps = {
  row: Extract<TimelineRow, { kind: "tool" }>;
  animated?: boolean | undefined;
};

type ActivityRowProps = {
  row: Extract<TimelineRow, { kind: "activity" }>;
  animated?: boolean | undefined;
};

type ToolInputProps = {
  tool: string;
  input: Record<string, unknown>;
};

type ToolResultProps = ToolInputProps & {
  text: string;
  width: number;
};

export function ToolRow(props: ToolRowProps): JSX.Element {
  return (
    <Show
      when={["agent_task", "agent_spawn", "agent_followup"].includes(props.row.tool)}
      fallback={<StandardToolRow row={props.row} animated={props.animated} />}
    >
      <AgentTaskRow row={props.row} animated={props.animated} />
    </Show>
  );
}

function StandardToolRow(props: ToolRowProps): JSX.Element {
  const tui = useTuiStore();
  const dims = useTuiDimensions();
  const contentWidth = () => Math.max(1, dims().width - 6);
  const input = () => args(props.row.args);
  const expanded = () => Boolean(tui.store.ui.expandedCells[props.row.id]);
  const result = () => props.row.result ?? "";
  const fullResult = () => props.row.fullResult ?? result();
  const mcpInvocation = () => props.row.mcp
    ? `${props.row.mcp.server}.${props.row.mcp.tool}${props.row.argsSummary ? ` · ${props.row.argsSummary}` : ""}`
    : "";
  const mcpResult = () => props.row.mcp ? mcpContentLines(props.row.mcp.result) : [];
  const isMcp = () => Boolean(props.row.mcp);
  const active = () => isActiveToolStatus(props.row.status);
  const presentation = () => props.row.presentation ?? presentToolActivity(props.row);
  const visibleOutput = () => active() ? props.row.liveOutput ?? "" : result();
  const detailOutput = () => {
    if (isMcp() && mcpResult().length > 0) return mcpResult().join("\n");
    if (active()) return props.row.liveOutput ?? "";
    return fullResult();
  };
  const hasInput = () => Object.keys(input()).length > 0;
  const header = () => {
    const title = isMcp() ? `${active() ? "calling" : "called"} ${mcpInvocation()}` : presentation().title;
    const right = [presentation().outcome, formatActivityDuration(props.row.durationMs)].filter(Boolean).join(" · ");
    return fitTerminalPair(title, right, Math.max(1, dims().width - 4), 8, 2);
  };
  const headerColor = () => active() ? COLOR.accent : toolColor(props.row.status);
  const toggleClick = createPrimaryClickGesture(() => tui.actions.cellExpandedToggle(props.row.id));
  const previewClick = createPrimaryClickGesture(() => tui.actions.cellExpandedToggle(props.row.id));
  const semanticPreview = () => presentation().preview.filter((line) => line.trim() !== presentation().outcome?.trim());
  const visibleOutputLines = () => presentation().preview.length > 0
    ? semanticPreview()
    : active()
      ? tailLines(visibleOutput(), 3)
      : previewOutputLines(visibleOutput(), TOOL_OUTPUT_PREVIEW_LINES);
  return (
    <box style={{ flexDirection: "column", marginBottom: 1 }}>
      <box style={{ flexDirection: "row" }} {...toggleClick}>
        <TranscriptMarker color={headerColor()} spinning={active()} animated={props.animated} />
        <text fg={headerColor()}>{header().left}</text>
        <Show when={header().right}><text fg={presentation().warning ? COLOR.warning : COLOR.dim}>{`  ${header().right}`}</text></Show>
      </box>

      <Show when={!expanded() && !isMcp() && visibleOutput()}>
        <box style={{ flexDirection: "column", paddingLeft: 2 }} {...previewClick}>
          <Index each={visibleOutputLines()}>
            {(line, index) => <text fg={COLOR.dim}>{`${active() ? "│ " : index === 0 ? "└ " : "  "}${truncateLine(line(), contentWidth())}`}</text>}
          </Index>
        </box>
      </Show>

      <Show when={!expanded() && isMcp() && mcpResult().length > 0}>
        <box style={{ flexDirection: "column", paddingLeft: 2 }} {...previewClick}>
          <For each={previewOutputLines(mcpResult().join("\n"), TOOL_OUTPUT_PREVIEW_LINES)}>
            {(line, index) => <text fg={COLOR.dim}>{`${index() === 0 ? "└ " : "  "}${truncateLine(line, contentWidth())}`}</text>}
          </For>
        </box>
      </Show>

      <Show when={props.row.processId && props.row.status === "running_background"}>
        <box style={{ flexDirection: "column", paddingLeft: 2 }}>
          <text fg={COLOR.dim}>{"└ running in background"}</text>
        </box>
      </Show>

      <Show when={expanded()}>
        <ExpandedPanel>
          <text fg={COLOR.dim}>{active() ? "live output" : "result"}</text>
          <Show when={detailOutput()} fallback={<text fg={COLOR.dim}>{toolEmptyState(props.row.status)}</text>}>
            {(output) => <ToolResult tool={props.row.tool} input={input()} text={output()} width={dims().width} />}
          </Show>
          <Show when={hasInput()}>
            <box style={{ flexDirection: "column", marginTop: 1 }}>
              <text fg={COLOR.dim}>{"input"}</text>
              <ToolInput tool={props.row.tool} input={input()} />
            </box>
          </Show>
          <ToolResultContext row={props.row} />
        </ExpandedPanel>
      </Show>
    </box>
  );
}

export function ActivityRow(props: ActivityRowProps): JSX.Element {
  const tui = useTuiStore();
  const dims = useTuiDimensions();
  const expanded = () => Boolean(tui.store.ui.expandedCells[props.row.id]);
  const active = () => props.row.status === "running";
  const color = () => props.row.status === "error" ? COLOR.error : active() ? COLOR.accent : COLOR.text;
  const duration = () => formatActivityDuration(props.row.durationMs);
  const headline = () => fitTerminalPair(props.row.label, duration() ?? "", Math.max(1, dims().width - 4), 8, 2);
  const width = () => Math.max(1, dims().width - 8);
  const toggleClick = createPrimaryClickGesture(() => tui.actions.cellExpandedToggle(props.row.id));
  return (
    <box style={{ flexDirection: "column", marginBottom: 1 }}>
      <box style={{ flexDirection: "row" }} {...toggleClick}>
        <TranscriptMarker color={color()} spinning={active()} animated={props.animated} />
        <text fg={color()}>{headline().left}</text>
        <Show when={headline().right}><text fg={COLOR.dim}>{`  ${headline().right}`}</text></Show>
      </box>
      <Show when={!expanded()}>
        <box style={{ flexDirection: "column", paddingLeft: 2 }} {...toggleClick}>
          <For each={props.row.items}>{(item, index) => {
            const presentation = () => item.presentation ?? presentToolActivity(item);
            const pair = () => fitTerminalPair(presentation().compact, presentation().outcome ?? "", width(), 8, 3);
            return (
              <box style={{ flexDirection: "row" }}>
                <text fg={COLOR.dim}>{index() === 0 ? "└ " : "  "}</text>
                <text fg={COLOR.dim}>{pair().left}</text>
                <Show when={pair().right}><text fg={presentation().warning ? COLOR.warning : COLOR.dim}>{` → ${pair().right}`}</text></Show>
              </box>
            );
          }}</For>
        </box>
      </Show>
      <Show when={expanded()}>
        <ExpandedPanel>
          <For each={props.row.items}>{(item, index) => {
            const itemInput = () => args(item.args);
            const output = () => item.fullResult ?? item.result ?? item.liveOutput ?? "";
            const presentation = () => item.presentation ?? presentToolActivity(item);
            return (
              <box style={{ flexDirection: "column", marginTop: index() === 0 ? 0 : 1 }}>
                <text fg={COLOR.text}>{presentation().compact}</text>
                <Show when={presentation().outcome}><text fg={presentation().warning ? COLOR.warning : COLOR.dim}>{presentation().outcome}</text></Show>
                <Show when={output()} fallback={<text fg={COLOR.dim}>{toolEmptyState(item.status)}</text>}>
                  {(value) => <ToolResult tool={item.tool} input={itemInput()} text={value()} width={dims().width} />}
                </Show>
                <Show when={Object.keys(itemInput()).length > 0}>
                  <box style={{ flexDirection: "column", marginTop: 1 }}>
                    <text fg={COLOR.dim}>input</text>
                    <ToolInput tool={item.tool} input={itemInput()} />
                  </box>
                </Show>
                <ToolResultContext row={item} />
              </box>
            );
          }}</For>
        </ExpandedPanel>
      </Show>
    </box>
  );
}

function ToolResultContext(props: { row: ToolTimelineRow }): JSX.Element {
  const dims = useTuiDimensions();
  const result = () => props.row.toolResult;
  const evidence = () => result()?.evidence ?? [];
  const attachments = () => result()?.attachments ?? [];
  const metadata = () => result()?.metadata ?? {};
  const artifact = () => {
    const value = metadata().outputArtifact;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  };
  return (
    <Show when={result()}>
      <box style={{ flexDirection: "column" }}>
        <Show when={evidence().length > 0}>
          <box style={{ flexDirection: "column", marginTop: 1 }}>
            <text fg={COLOR.dim}>evidence</text>
            <For each={evidence()}>{(item) => (
              <text fg={COLOR.text}>{[item.id, item.title, item.summary, item.path].filter(Boolean).join(" · ")}</text>
            )}</For>
          </box>
        </Show>
        <Show when={result()?.outputArtifactId || artifact()}>
          <box style={{ flexDirection: "column", marginTop: 1 }}>
            <text fg={COLOR.dim}>artifact</text>
            <For each={toolInputDetailLines({
              ...(result()?.outputArtifactId ? { id: result()?.outputArtifactId } : {}),
              ...(artifact() ?? {})
            })}>{(line) => <text fg={COLOR.text}>{line}</text>}</For>
          </box>
        </Show>
        <Show when={attachments().length > 0}>
          <box style={{ flexDirection: "column", marginTop: 1 }}>
            <text fg={COLOR.dim}>attachments</text>
            <For each={attachments()}>{(item) => (
              <box style={{ flexDirection: "column" }}>
                <text fg={COLOR.text}>{[item.name ?? "image", item.mediaType, item.detail].filter(Boolean).join(" · ")}</text>
                <image source={attachmentBytes(item.data)} fit="fit" protocol="auto" style={{ width: Math.max(1, dims().width - 10), height: Math.max(3, Math.min(12, Math.floor(dims().height / 3))) }} />
              </box>
            )}</For>
          </box>
        </Show>
        <Show when={Object.keys(metadata()).length > 0}>
          <box style={{ flexDirection: "column", marginTop: 1 }}>
            <text fg={COLOR.dim}>metadata</text>
            <For each={toolInputDetailLines(metadata())}>{(line) => <text fg={COLOR.text}>{line}</text>}</For>
          </box>
        </Show>
      </box>
    </Show>
  );
}

function AgentTaskRow(props: ToolRowProps): JSX.Element {
  const tui = useTuiStore();
  const dims = useTuiDimensions();
  const input = () => args(props.row.args);
  const metadata = () => props.row.toolResult?.metadata ?? {};
  const activity = () => props.row.jobId ? tui.store.snapshot.subagents.find((item) => item.id === props.row.jobId) : undefined;
  const expanded = () => Boolean(tui.store.ui.expandedCells[props.row.id]);
  const title = () => {
    const value = metadata().title ?? input().title;
    if (typeof value === "string" && value.trim()) return value.trim();
    return titleFromPrompt(String(input().prompt ?? ""), typeof input().lane === "string" ? `${input().lane} task` : "subagent task");
  };
  const lane = () => typeof metadata().lane === "string"
    ? metadata().lane as string
    : typeof input().lane === "string"
      ? input().lane
      : "general";
  const mode = () => metadata().mode === "detached" || input().mode === "detached" ? "background" : "attached";
  const lifecycleStatus = () => activity()?.status ?? metadata().status;
  const status = () => delegationStatus(props.row.status, lifecycleStatus(), mode());
  const active = () => status() === "starting" || status() === "running";
  const prompt = () => String(input().prompt ?? "").trim();
  const result = () => activity()?.summary ?? activity()?.error ?? props.row.fullResult ?? props.row.toolResult?.output ?? "";
  const duration = () => agentDuration(activity()?.startedAt ?? activity()?.createdAt, activity()?.completedAt);
  const width = () => Math.max(1, dims().width - 4);
  const headline = () => fitTerminalPair(title(), status(), width(), 6, 2);
  const toggle = () => tui.actions.cellExpandedToggle(props.row.id);
  const toggleClick = createPrimaryClickGesture(toggle);
  return (
    <box
      style={{
        flexDirection: "column",
        marginBottom: 1
      }}
    >
      <box style={{ flexDirection: "row" }} {...toggleClick}>
        <TranscriptMarker color={delegationColor(status())} glyph={delegationGlyph(status())} spinning={active()} animated={props.animated} />
        <text fg={delegationColor(status())}>{headline().left}</text>
        <Show when={headline().right}><text fg={delegationColor(status())}>{`  ${headline().right}`}</text></Show>
      </box>
      <box style={{ paddingLeft: 2 }}>
        <text fg={COLOR.dim}>{truncateLine([lane(), mode(), duration()].filter(Boolean).join(" · "), width())}</text>
      </box>
      <Show when={expanded()}>
        <ExpandedPanel>
          <text fg={COLOR.dim}>{active() ? "live result" : "result"}</text>
          <Show when={result()} fallback={<text fg={COLOR.dim}>{active() ? "work is still in progress" : "no result available"}</text>}>
            {(value) => (
              <For each={value().split("\n")}>
                {(line) => <text fg={activity()?.error ? COLOR.error : COLOR.text}>{line || " "}</text>}
              </For>
            )}
          </Show>
          <Show when={prompt()}>
            {(value) => (
              <box style={{ flexDirection: "column", paddingTop: 1 }}>
                <text fg={COLOR.dim}>{"task"}</text>
                <For each={value().split("\n")}>
                  {(line) => <text fg={COLOR.dim}>{line || " "}</text>}
                </For>
              </box>
            )}
          </Show>
        </ExpandedPanel>
      </Show>
    </box>
  );
}

function delegationStatus(status: string, metadataStatus: unknown, mode: string): string {
  if (metadataStatus === "cancelled") return "cancelled";
  if (metadataStatus === "lost") return "failed";
  if (metadataStatus === "failed") return "failed";
  if (metadataStatus === "returned" || metadataStatus === "succeeded") return mode === "background" ? "completed" : "returned";
  if (status === "failed" || status === "error" || status === "denied") return "failed";
  if (status === "running_background") return "running";
  if (status === "pending" || status === "running") return "starting";
  if (status === "done") return mode === "background" ? "completed" : "returned";
  return status;
}

function delegationGlyph(status: string): string {
  if (status === "completed" || status === "returned") return "✓";
  if (status === "failed") return "×";
  if (status === "cancelled") return "-";
  return "•";
}

function delegationColor(status: string): string {
  if (status === "failed") return COLOR.error;
  if (status === "cancelled") return COLOR.dim;
  if (status === "completed" || status === "returned") return COLOR.success;
  return COLOR.accent;
}

function agentDuration(startedAt: string | undefined, completedAt: string | undefined): string | undefined {
  if (!startedAt || !completedAt) return undefined;
  const durationMs = Date.parse(completedAt) - Date.parse(startedAt);
  if (!Number.isFinite(durationMs) || durationMs < 0) return undefined;
  if (durationMs < 60_000) {
    const seconds = durationMs / 1_000;
    return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  }
  const totalSeconds = Math.round(durationMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function ToolInput(props: ToolInputProps): JSX.Element {
  const path = String(props.input.path ?? props.input.file ?? props.input.filename ?? "");
  const kind = toolInputKind(props.tool, props.input);
  let body: JSX.Element;
  if (kind === "shell") {
    body = <code content={String(props.input.command ?? props.input.cmd ?? "")} filetype="bash" syntaxStyle={syntax()} fg={COLOR.text} />;
  } else if (kind === "edit") {
    body = <diff diff={unifiedEditDiff(path, String(props.input.oldString ?? ""), String(props.input.newString ?? ""))} filetype={inferFiletype(path)} view="unified" showLineNumbers syntaxStyle={syntax()} addedBg={COLOR.diffAddedBg} removedBg={COLOR.diffRemovedBg} contextBg={COLOR.diffContextBg} />;
  } else if (kind === "write") {
    body = <code content={String(props.input.content ?? "")} filetype={inferFiletype(path)} syntaxStyle={syntax()} fg={COLOR.text} />;
  } else if (kind === "patch") {
    body = <code content={String(props.input.patch ?? "")} filetype="diff" syntaxStyle={syntax()} fg={COLOR.text} />;
  } else {
    body = (
      <box style={{ flexDirection: "column" }}>
        <For each={toolInputDetailLines(props.input)}>
          {(line) => <text fg={COLOR.text}>{line}</text>}
        </For>
      </box>
    );
  }
  return <box style={{ flexDirection: "column" }}>{body}</box>;
}

function ToolResult(props: ToolResultProps): JSX.Element {
  const nmap = () => parseNmap(props.text);
  const dirs = () => parseDirectoryResults(props.text);
  const http = () => splitHttpResponse(props.text);
  const path = () => String(props.input.path ?? props.input.file ?? props.input.filename ?? "");
  const hasNmap = () => nmap().length > 0;
  const hasDirs = () => dirs().length > 0;
  const hasHttp = () => Boolean(http().status);
  const hasDiff = () => !hasNmap() && !hasDirs() && !hasHttp() && (looksLikeDiff(props.text) || shortToolName(props.tool).endsWith("diff"));
  const fallback = () => !hasNmap() && !hasDirs() && !hasHttp() && !hasDiff();
  return (
    <box style={{ flexDirection: "column" }}>
      <Show when={hasNmap()}>
        <code content={props.text} filetype="text" syntaxStyle={syntax()} fg={COLOR.text} />
      </Show>
      <Show when={hasDirs()}>
        <For each={dirs()}>{(row) => <text fg={row.status < 400 ? COLOR.success : COLOR.warning}>{`${String(row.status).padEnd(5)} ${String(row.size).padStart(8)}  ${row.url}`}</text>}</For>
      </Show>
      <Show when={hasHttp()}>
        <text fg={COLOR.text}>{http().status ?? "HTTP response"}</text>
        <code content={http().headers} filetype="text" syntaxStyle={syntax()} fg={COLOR.dim} />
        <code content={http().body} filetype={inferFiletype(undefined, http().contentType)} syntaxStyle={syntax()} fg={COLOR.text} />
      </Show>
      <Show when={hasDiff()}>
        <diff diff={props.text.replace(/^```diff\n?|```$/g, "")} filetype={inferFiletype(path())} view={props.width > 120 ? "split" : "unified"} showLineNumbers syntaxStyle={syntax()} addedBg={COLOR.diffAddedBg} removedBg={COLOR.diffRemovedBg} contextBg={COLOR.diffContextBg} />
      </Show>
      <Show when={fallback()}>
        <code content={props.text} filetype={resultFiletype(props.text, path())} syntaxStyle={syntax()} fg={COLOR.text} />
      </Show>
    </box>
  );
}

function previewOutputLines(text: string, limit: number): string[] {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return ["(no output)"];
  if (lines.length <= limit) return lines;
  const head = Math.max(1, Math.floor(limit / 2));
  const tail = Math.max(1, limit - head - 1);
  return [
    ...lines.slice(0, head),
    `… +${lines.length - head - tail} lines (ctrl+t for full transcript)`,
    ...lines.slice(lines.length - tail)
  ];
}

function toolColor(status: string): string {
  if (status === "failed" || status === "error" || status === "denied") return COLOR.error;
  if (status === "done") return COLOR.text;
  return COLOR.dim;
}

function looksLikeDiff(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("--- ") || trimmed.startsWith("diff --git") || /^@@\s/m.test(trimmed);
}

function toolEmptyState(status: string): string {
  if (status === "pending" || status === "running") return "waiting for output";
  if (status === "running_background") return "running in background";
  return "no output";
}

function toolInputDetailLines(input: Record<string, unknown>): string[] {
  return Object.entries(input).flatMap(([key, value]) => semanticValueLines(key, value, 0));
}

function semanticValueLines(key: string, value: unknown, depth: number): string[] {
  const indent = "  ".repeat(depth);
  if (typeof value === "string") {
    const lines = value.split("\n");
    if (lines.length === 1) return [`${indent}${key}: ${value}`];
    return [`${indent}${key}:`, ...lines.map((line) => `${indent}  ${line}`)];
  }
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
    return [`${indent}${key}: ${String(value)}`];
  }
  if (depth >= 3) return [`${indent}${key}: structured value`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}${key}: none`];
    if (value.every(isScalarValue)) return [`${indent}${key}: ${value.map(String).join(", ")}`];
    return [
      `${indent}${key}:`,
      ...value.flatMap((item, index) => semanticValueLines(String(index + 1), item, depth + 1))
    ];
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [`${indent}${key}: none`];
    return [`${indent}${key}:`, ...entries.flatMap(([child, childValue]) => semanticValueLines(child, childValue, depth + 1))];
  }
  return [`${indent}${key}: ${String(value)}`];
}

function isScalarValue(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function resultFiletype(text: string, path: string): string {
  try {
    JSON.parse(text);
    return "json";
  } catch {
    return inferFiletype(path);
  }
}

function mcpContentLines(result: unknown): string[] {
  if (!result || typeof result !== "object") return [];
  const record = result as Record<string, unknown>;
  const content = record.content;
  const contentLines = Array.isArray(content) ? content.map(mcpContentLine).filter((line) => line.trim().length > 0) : [];
  const structured = record.structuredContent;
  const structuredLines = structured === undefined ? [] : semanticValueLines("structured content", structured, 0);
  const errorLine = record.isError === true ? ["mcp result reported an error"] : [];
  if (contentLines.length || structuredLines.length || errorLine.length) return [...errorLine, ...contentLines, ...structuredLines];
  return Object.entries(record).flatMap(([key, value]) => semanticValueLines(key, value, 0));
}

function mcpContentLine(part: unknown): string {
  if (!part || typeof part !== "object" || Array.isArray(part)) return "";
  const record = part as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (record.type === "image") return "<image content>";
  if (record.type === "audio") return "<audio content>";
  if (typeof record.data === "string") return `[${String(record.type ?? "data")} ${record.data.length} chars]`;
  if (record.type === "resource") {
    const resource = record.resource;
    if (resource && typeof resource === "object" && !Array.isArray(resource)) {
      const uri = (resource as Record<string, unknown>).uri;
      return typeof uri === "string" ? `embedded resource: ${uri}` : "embedded resource";
    }
    return "embedded resource";
  }
  if (record.type === "resource_link" || record.type === "resourceLink") {
    return typeof record.uri === "string" ? `link: ${record.uri}` : "link";
  }
  try { return JSON.stringify(record); }
  catch { return String(record); }
}

function attachmentBytes(data: string): Uint8Array {
  return Uint8Array.from(Buffer.from(data, "base64"));
}
