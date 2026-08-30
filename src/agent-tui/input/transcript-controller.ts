import type { TuiStoreValue } from "../context/store";
import { projectMessagesToRows, type TimelineRow } from "../renderers";
import type { TuiRuntimePort } from "../runtime-port";
import type { SessionOwner } from "./center-surface-controller";
import { createControllerOperations } from "./controller-operation";

type TranscriptControllerInput = {
  tui: TuiStoreValue;
  port: TuiRuntimePort;
  captureOwner(): SessionOwner | undefined;
  owns(owner: SessionOwner): boolean;
};

export function createTranscriptController(input: TranscriptControllerInput) {
  const { tui, port } = input;
  const operations = createControllerOperations(tui);

  function reset(): void {
    operations.invalidate();
  }

  async function open(): Promise<void> {
    const owner = input.captureOwner();
    if (!owner) return;
    const sourceTab = tui.store.ui.activeMainTab;
    const status = "loading transcript";
    const operation = operations.begin(status);
    try {
      const messages = await port.loadFullMessages(owner.sessionId);
      if (!ownsRequest(operation, owner, sourceTab)) return;
      tui.actions.centerSurfacePush({ kind: "detail", title: "transcript", body: transcriptMarkdown(tui, messages) });
    } catch (error) {
      if (ownsRequest(operation, owner, sourceTab)) {
        tui.actions.errorSet(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (input.owns(owner)) operations.finish(operation);
    }
  }

  function ownsRequest(operation: number, owner: SessionOwner, sourceTab: "chat" | "proxy"): boolean {
    return operations.owns(operation)
      && input.owns(owner)
      && tui.store.ui.activeMainTab === sourceTab
      && tui.store.ui.overlayStack.length === 0
      && tui.store.ui.centerSurfaceStack.length === 0
      && !tui.store.ui.modelProviderWizard
      && !tui.store.ui.modelProviderRemoval
      && !(tui.store.snapshot.pendingUserInput && !tui.store.ui.requestUserInput?.dismissed);
  }

  return { reset, open };
}

function transcriptMarkdown(tui: TuiStoreValue, messages = tui.store.snapshot.messages): string {
  const rows = projectMessagesToRows(
    messages,
    160,
    tui.store.snapshot.runningTurnId,
    tui.store.snapshot.toolCalls,
    tui.store.snapshot.toolInputPreviews,
    { fullToolResults: true }
  );
  return rows.length ? rows.map(transcriptRowMarkdown).join("\n\n") : "no transcript yet.";
}

function transcriptRowMarkdown(row: TimelineRow): string {
  switch (row.kind) {
    case "user":
      return `## user\n\n${row.text}`;
    case "assistant":
      return `## assistant\n\n${row.text}`;
    case "thinking":
      return `## thinking\n\n${row.title}${row.body.trim() ? `\n\n${row.body}` : ""}`;
    case "tool": {
      const header = `## tool: ${row.tool}\n\nstatus: ${row.status}${row.argsSummary ? `\ninput: ${row.argsSummary}` : ""}`;
      const result = row.fullResult ?? row.result;
      return result ? `${header}\n\n### output\n\n${result}` : header;
    }
    case "exploration":
      return [
        `## ${row.status === "running" ? "exploring" : "explored"}`,
        "",
        ...row.items.flatMap((item) => [
          `### ${item.verb} ${item.target}`,
          "",
          item.fullResult ?? item.result ?? "no output"
        ])
      ].join("\n");
    case "plan":
      return [
        `## ${row.title}`,
        "",
        row.explanation ?? "",
        ...row.items.map((item) => `- [${item.status === "completed" ? "x" : " "}] ${item.step}`),
        row.markdown ?? ""
      ].filter((line) => line.length > 0).join("\n");
    case "mcp_inventory":
      return row.text;
    case "todo_list":
      return [
        `## ${row.title}`,
        "",
        ...row.items.map((item) => `- [${item.status === "completed" ? "x" : " "}] ${item.text}${item.priority ? ` (${item.priority})` : ""}`)
      ].join("\n");
    case "artifact":
      return `## ${row.title}\n\n${row.detail}${row.body ? `\n\n${row.body}` : ""}`;
    case "finding":
      return `## finding: ${row.title}\n\nseverity: ${row.severity}\ntarget: ${row.target}\n${row.body ?? row.detail}`;
    case "progress":
      return `## ${row.title}\n\n${row.detail}`;
    case "phase":
      return `## phase changed\n\n${row.phase}\n${row.detail}`;
    case "loop_stop":
      return `## ${row.reason}\n\n${row.text}`;
    case "compaction":
      return `## compacted context\n\n${row.text}`;
    case "error":
      return `## error\n\n${row.body ?? row.text}`;
    case "notice":
      return `## ${row.title}\n\n${row.body ?? row.detail ?? ""}`;
  }
}
