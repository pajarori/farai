import { For, Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import type { DialogOption, FuzzyMatch } from "../dialog/fuzzy";
import { filterOptions, groupByCategory } from "../dialog/fuzzy";
import { displayRows, scrollWindowStart, selectableIndex, selectedOptionId } from "../dialog/list-selection";
import { overlayTitle } from "../overlay-options";
import { truncateLine } from "../renderers";
import { COLOR } from "../theme";
import type { OverlayFrame } from "../store";
import type { AgentThreadSummary } from "../runtime-port";
import { useTuiStore } from "../context/store";
import { createPrimaryClickGesture, isPrimaryClick } from "../input/mouse";
import { SelectionMenuHint, SelectionRow, selectionDescriptionColumn } from "./selection-row";
import { fitTerminalPair, terminalWidth } from "../terminal-text";

type ListOverlayProps = {
  frame: OverlayFrame;
  options: DialogOption<unknown>[];
  docked?: boolean;
};

export function ListOverlay(props: ListOverlayProps): JSX.Element {
  const tui = useTuiStore();
  const dims = useTerminalDimensions();
  const matches = createMemo(() => filterOptions(props.options, props.frame.query));
  const selectableCount = createMemo(() => matches().filter((match) => !match.option.disabled).length);
  const selectedIndex = createMemo(() => selectableIndex(matches(), props.frame.index));
  const groups = createMemo(() => groupByCategory(matches(), props.frame.query.trim() !== ""));
  const selectedId = createMemo(() => selectedOptionId(matches(), props.frame.index));
  const rows = createMemo(() => selectionRows(groups(), selectedId()));
  const allRows = createMemo(() => selectionRows(groupByCategory(filterOptions(props.options, ""), false), undefined));
  const width = () => Math.max(1, dims().width);
  const maxRows = () => overlayMaxRows(props.frame.kind, dims().height);
  const visibleRows = createMemo(() => {
    const all = rows();
    const cap = maxRows();
    const selectedIndex = all.findIndex((row) => row.kind === "option" && (row as OptionOverlayRow).selected);
    const start = scrollWindowStart(all.length, cap, selectedIndex);
    return all.slice(start, start + cap);
  });
  const standardHeight = () => Math.max(1, Math.min(dims().height - 1, maxRows() + 5));
  const left = () => 0;
  const standardTop = () => Math.max(0, dims().height - standardHeight() - 1);
  const descCol = () => descriptionColumn(allRows(), width());
  const subtitle = () => overlaySubtitle(props.frame.kind);
  const status = () => props.frame.kind === "model" ? tui.store.ui.statusDetail : undefined;
  const notice = () => tui.store.ui.lastError;
  const statusLeft = () => notice()
    ? `  error · ${notice()}`
    : props.frame.query
      ? `  filter: ${props.frame.query}`
      : status()
        ? `  ${status()}`
        : "";
  const statusRight = () => props.frame.query
    ? `${matches().length}/${props.options.length}`
    : selectedIndex() >= 0
      ? `${selectedIndex() + 1}/${selectableCount()}`
      : "";
  const statusLine = () => fitTerminalPair(statusLeft(), statusRight(), width(), 1, 1);
  const selectOption = (id: string): void => {
    const enabled = matches().filter((match) => !match.option.disabled);
    const index = enabled.findIndex((match) => match.option.id === id);
    if (index >= 0) tui.actions.overlaySetIndex(index, enabled.length);
  };

  createEffect(() => {
    const count = selectableCount();
    const current = props.frame.index;
    const next = count > 0 ? Math.max(0, Math.min(current, count - 1)) : 0;
    if (next !== current && tui.store.ui.overlayStack.at(-1) === props.frame) {
      tui.actions.overlaySetIndex(next, count);
    }
  });

  if (props.frame.kind === "mcp") {
    const optionRows = () => rows().filter((row): row is OptionOverlayRow => row.kind === "option");
    const optionLimit = () => mcpOverlayMaxItems(dims().height);
    const optionCapacity = () => Math.max(1, Math.min(
      optionLimit(),
      allRows().filter((row): row is OptionOverlayRow => row.kind === "option").length
    ));
    const selectedIndex = () => optionRows().findIndex((row) => row.selected);
    const optionStart = () => scrollWindowStart(optionRows().length, optionCapacity(), selectedIndex());
    const visibleOptionRows = () => optionRows().slice(optionStart(), optionStart() + optionCapacity());
    const overlayHeight = () => mcpOverlayHeight(dims().height, optionCapacity());
    return (
      <McpOverlay
        docked={props.docked}
        width={width()}
        height={overlayHeight()}
        left={left()}
        top={Math.max(0, dims().height - overlayHeight() - 1)}
        rows={visibleOptionRows()}
        summaryRows={rows()}
        onSelect={selectOption}
      />
    );
  }

  if (props.frame.kind === "agents") {
    return (
      <AgentsOverlay
        frame={props.frame}
        docked={props.docked}
        width={width()}
        left={left()}
        terminalHeight={dims().height}
        totalCount={filterOptions(props.options, "").length}
        matches={matches()}
        selectedId={selectedId()}
      />
    );
  }

  return (
    <box style={{
      ...(props.docked ? {} : { position: "absolute", zIndex: 3000, left: left(), top: standardTop() }),
      width: width(),
      height: standardHeight(),
      flexDirection: "column",
      flexShrink: 0,
      overflow: "hidden"
    }}>
      <text fg={COLOR.text}>{`  ${truncateLine(overlayTitle(props.frame.kind as never), Math.max(1, width() - 4))}`}</text>
      <Show when={subtitle()}>
        <text fg={COLOR.dim}>{`  ${truncateLine(subtitle(), Math.max(1, width() - 4))}`}</text>
      </Show>
      <box style={{ flexDirection: "row", justifyContent: "space-between", height: 1 }}>
        <text fg={notice() ? COLOR.error : COLOR.dim}>{statusLine().left || " "}</text>
        <text fg={COLOR.dim}>{statusLine().right}</text>
      </box>
      <box style={{ height: maxRows(), flexDirection: "column", overflow: "hidden" }}>
        <Show when={matches().length > 0} fallback={<text fg={COLOR.dim}>{"  no results"}</text>}>
          <For each={visibleRows()}>{(row) => {
            if (row.kind === "category") return <CategoryRow row={row} />;
            if (row.kind === "spacer") return <box style={{ height: 1 }} />;
            return <OptionRow row={row} descCol={descCol()} width={width()} onSelect={selectOption} />;
          }}</For>
        </Show>
      </box>
      <SelectionMenuHint text={overlayHint(props.frame, matches(), tui.store.ui.modelProviders)} />
    </box>
  );
}

type CategoryOverlayRow = { kind: "category"; category: string };
type SpacerOverlayRow = { kind: "spacer" };
type OptionOverlayRow = ReturnType<typeof displayRows<unknown>>[number] & { kind: "option"; number?: number };
type OverlayRow = CategoryOverlayRow | SpacerOverlayRow | OptionOverlayRow;
type CategoryRowProps = { row: CategoryOverlayRow };
type OptionRowProps = { row: OptionOverlayRow; descCol: number; width: number; onSelect: (id: string) => void };

type McpOverlayProps = {
  docked: boolean | undefined;
  width: number;
  height: number;
  left: number;
  top: number;
  rows: OverlayRow[];
  summaryRows: OverlayRow[];
  onSelect: (id: string) => void;
};

type AgentsOverlayProps = {
  frame: Extract<OverlayFrame, { kind: "agents" }>;
  docked: boolean | undefined;
  width: number;
  left: number;
  terminalHeight: number;
  totalCount: number;
  matches: FuzzyMatch<unknown>[];
  selectedId: string | undefined;
};

function selectionRows(groups: Array<{ category: string | undefined; matches: FuzzyMatch<unknown>[] }>, selectedId: string | undefined): OverlayRow[] {
  const rows: OverlayRow[] = [];
  let number = 1;
  for (const group of groups) {
    if (group.category) rows.push({ kind: "category", category: titleCase(group.category) });
    for (const row of displayRows(group.matches, selectedId)) {
      if (row.option.separatorBefore && rows.length > 0) rows.push({ kind: "spacer" });
      rows.push({
        ...row,
        kind: "option",
        ...(row.option.numbered === false ? {} : { number: number++ })
      });
    }
  }
  return rows;
}

function CategoryRow(props: CategoryRowProps): JSX.Element {
  return <text fg={COLOR.dim}>{`  ${props.row.category}`}</text>;
}

function OptionRow(props: OptionRowProps): JSX.Element {
  const option = () => props.row.option;
  return (
    <SelectionRow
      {...(props.row.number === undefined ? {} : { number: props.row.number })}
      title={option().title}
      description={option().description}
      current={option().footer === "current"}
      selected={props.row.selected}
      disabled={props.row.disabled}
      width={props.width}
      descriptionColumn={props.descCol}
      onSelect={() => props.onSelect(option().id)}
    />
  );
}

function McpOverlay(props: McpOverlayProps): JSX.Element {
  const tui = useTuiStore();
  const optionRows = () => props.rows.filter((row): row is OptionOverlayRow => row.kind === "option");
  const summaryOptionRows = () => props.summaryRows.filter((row): row is OptionOverlayRow => row.kind === "option");
  const readyCount = () => summaryOptionRows().filter((row) => row.option.category === "running").length;
  const failedCount = () => summaryOptionRows().filter((row) => row.option.category === "stopped").length;
  const startingCount = () => summaryOptionRows().filter((row) => row.option.category === "starting").length;
  const summary = () => {
    const total = summaryOptionRows().length;
    if (total === 0) return "no configured mcp servers";
    return `${readyCount()}/${total} ready${startingCount() ? ` · ${startingCount()} starting` : ""}${failedCount() ? ` · ${failedCount()} failed` : ""}`;
  };
  return (
    <box style={{
      ...(props.docked ? {} : { position: "absolute", zIndex: 3000, left: props.left, top: props.top }),
      width: props.width,
      height: props.height,
      flexDirection: "column",
      flexShrink: 0,
      overflow: "hidden"
    }}>
      <text fg={COLOR.text}>{"  mcp servers"}</text>
      <text fg={tui.store.ui.lastError ? COLOR.error : COLOR.dim}>{`  ${truncateLine(tui.store.ui.lastError ? `error · ${tui.store.ui.lastError}` : summary(), Math.max(1, props.width - 4))}`}</text>
      <box style={{ height: Math.max(1, props.height - 5), flexShrink: 0, flexDirection: "column", marginTop: 1, overflow: "hidden" }}>
        <Show when={optionRows().length > 0} fallback={<text fg={COLOR.dim}>{"  no mcp servers configured."}</text>}>
          <For each={optionRows()}>{(row) => <McpServerRow row={row} width={props.width} onSelect={props.onSelect} />}</For>
        </Show>
      </box>
      <SelectionMenuHint text="press esc to go back" />
    </box>
  );
}

function McpServerRow(props: { row: OptionOverlayRow; width: number; onSelect: (id: string) => void }): JSX.Element {
  const option = () => props.row.option;
  const selected = () => props.row.selected;
  const state = () => String(option().category ?? "stopped");
  const color = () => {
    if (option().id === "mcp-error" || state() === "stopped") return COLOR.error;
    if (state() === "running") return COLOR.success;
    if (state() === "starting") return COLOR.accent;
    if (state() === "disabled") return COLOR.dim;
    return COLOR.accent;
  };
  const statusText = () => {
    if (option().id === "mcp-error") return "failed";
    if (state() === "running") return "ready";
    if (state() === "starting") return "starting";
    if (state() === "disabled") return "disabled";
    return "stopped";
  };
  const footer = () => option().footer ? ` · ${option().footer}` : "";
  const status = () => `${statusText()}${footer()}`;
  const headline = () => fitTerminalPair(option().title, status(), Math.max(1, props.width - 4), 3, 1);
  const detail = () => truncateLine(option().description ?? "", Math.max(1, props.width - 4));
  return (
    <box
      style={{ height: 2, flexShrink: 0, flexDirection: "column", overflow: "hidden" }}
      onMouseUp={(event) => {
        if (!isPrimaryClick(event) || props.row.disabled) return;
        props.onSelect(props.row.option.id);
      }}
    >
      <box style={{ flexDirection: "row" }}>
        <text selectable={false} fg={selected() ? COLOR.accent : COLOR.dim}>{selected() ? "› " : "  "}</text>
        <text selectable={false} fg={color()}>{statusGlyph(statusText())}</text>
        <text selectable={false} fg={COLOR.text}>{` ${headline().left}`}</text>
        <Show when={headline().right}><text selectable={false} fg={COLOR.dim}>{` ${headline().right}`}</text></Show>
      </box>
      <Show when={detail()}>
        <text selectable={false} fg={option().id === "mcp-error" || detail().startsWith("error:") ? COLOR.error : COLOR.dim}>{`    ${detail()}`}</text>
      </Show>
    </box>
  );
}

function AgentsOverlay(props: AgentsOverlayProps): JSX.Element {
  const tui = useTuiStore();
  const [now, setNow] = createSignal(Date.now());
  const rows = createMemo(() => displayRows(props.matches, props.selectedId));
  const expandedItem = createMemo(() => {
    if (!props.frame.expandedId) return undefined;
    return rows().find((row) => row.option.id === props.frame.expandedId)?.option.value as AgentThreadSummary | undefined;
  });
  const expandedDetailLines = createMemo(() => expandedItem()
    ? visibleAgentDetailLines(expandedItem()!, props.terminalHeight)
    : []);
  const rowLimit = createMemo(() => agentOverlayMaxItems(
    props.terminalHeight,
    expandedDetailLines().length > 0 ? expandedDetailLines().length + 2 : 0
  ));
  const reservedRows = createMemo(() => Math.max(1, Math.min(rowLimit(), props.totalCount)));
  const visibleRows = createMemo(() => {
    const all = rows();
    const selected = all.findIndex((row) => row.selected);
    const start = scrollWindowStart(all.length, rowLimit(), selected);
    return all.slice(start, start + reservedRows());
  });
  const activeCount = () => tui.store.ui.agentThreads.filter((item) => {
    return item.role === "subagent" && ["created", "starting", "running", "cancelling"].includes(item.status);
  }).length;
  const agentCount = () => tui.store.ui.agentThreads.filter((item) => item.role === "subagent").length;
  const doneCount = () => agentCount() - activeCount();
  const expandedRows = () => expandedDetailLines().length > 0 ? expandedDetailLines().length + 2 : 0;
  const rowViewportHeight = () => reservedRows() * 2 + expandedRows();
  const renderedHeight = () => 5 + rowViewportHeight();
  const height = () => Math.max(1, Math.min(Math.max(1, props.terminalHeight - 1), renderedHeight()));
  const top = () => Math.max(0, props.terminalHeight - height() - 1);

  createEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
      void tui.refreshAgentThreads();
    }, 1_000);
    onCleanup(() => clearInterval(timer));
  });

  return (
    <box style={{
      ...(props.docked ? {} : { position: "absolute", zIndex: 3000, left: props.left, top: top() }),
      width: props.width,
      height: height(),
      flexDirection: "column",
      flexShrink: 0,
      overflow: "hidden"
    }}>
      <text fg={COLOR.text}>{"  agents"}</text>
      <text fg={tui.store.ui.lastError ? COLOR.error : COLOR.dim}>{`  ${truncateLine(tui.store.ui.lastError ? `error · ${tui.store.ui.lastError}` : `${activeCount()} active · ${doneCount()} done`, Math.max(1, props.width - 4))}`}</text>
      <text fg={COLOR.dim}>{props.frame.query ? `  filter: ${truncateLine(props.frame.query, Math.max(1, props.width - 12))}` : " "}</text>
      <box style={{ height: rowViewportHeight(), flexShrink: 0, flexDirection: "column", overflow: "hidden" }}>
        <Show when={visibleRows().length > 0} fallback={<text fg={COLOR.dim}>{"  no agents yet"}</text>}>
          <For each={visibleRows()}>{(row) => {
            const item = () => row.option.value as AgentThreadSummary;
            const expanded = () => props.frame.expandedId === row.option.id;
            const detailLines = () => visibleAgentDetailLines(item(), props.terminalHeight);
            const current = () => item().sessionId === tui.store.activeSessionId;
            const status = () => agentStatusLine(item(), current(), now());
            const headline = () => fitTerminalPair(item().title, status(), Math.max(1, props.width - 6), 4, 2);
            const metadata = () => item().role === "main"
              ? ["main thread", item().model].filter(Boolean).join(" · ")
              : [
                `${"  ".repeat(Math.max(0, item().depth - 1))}${item().lane ?? "general"}`,
                item().mode === "detached" ? "background" : "attached",
                item().model
              ].filter(Boolean).join(" · ");
            const select = () => {
              const enabled = props.matches.filter((match) => !match.option.disabled);
              const index = enabled.findIndex((match) => match.option.id === row.option.id);
              if (props.frame.expandedId === row.option.id) {
                tui.actions.agentDetailToggle(row.option.id);
                return;
              }
              tui.actions.overlaySetIndex(index, enabled.length);
              tui.actions.agentDetailToggle(row.option.id);
            };
            const selectClick = createPrimaryClickGesture(select);
            return (
              <box
                style={{
                  width: "100%",
                  flexDirection: "column",
                  paddingLeft: 1,
                  paddingRight: 1,
                  backgroundColor: row.selected ? COLOR.panelActive : COLOR.panel
                }}
                {...selectClick}
              >
                <box style={{ width: "100%", flexDirection: "row" }}>
                  <text selectable={false} fg={row.selected ? COLOR.accent : COLOR.dim}>{row.selected ? "› " : "  "}</text>
                  <text selectable={false} fg={agentColor(item())}>{`${agentGlyph(item())} `}</text>
                  <text selectable={false} fg={COLOR.text}>{headline().left}</text>
                  <Show when={headline().right}><text selectable={false} fg={COLOR.dim}>{`  ${headline().right}`}</text></Show>
                </box>
                <text selectable={false} fg={COLOR.dim}>{`    ${truncateLine(metadata(), Math.max(1, props.width - 6))}`}</text>
                <Show when={expanded() && detailLines().length > 0}>
                  <box style={{ flexDirection: "column", paddingLeft: 3, paddingTop: 1, paddingBottom: 1 }}>
                    <For each={detailLines()}>
                      {(line, index) => <text fg={item().error ? COLOR.error : index() === 0 ? COLOR.text : COLOR.dim}>{truncateLine(`${index() === 0 ? "└ " : "  "}${line}`, Math.max(1, props.width - 8))}</text>}
                    </For>
                  </box>
                </Show>
              </box>
            );
          }}</For>
        </Show>
      </box>
      <SelectionMenuHint text="enter open thread · space/click preview · esc close" />
    </box>
  );
}

function agentOverlayMaxItems(terminalHeight: number, expandedRows: number): number {
  return Math.min(8, Math.max(1, Math.floor((terminalHeight - 6 - expandedRows) / 2)));
}

function mcpOverlayMaxItems(terminalHeight: number): number {
  return Math.min(8, Math.max(1, Math.floor((terminalHeight - 6) / 2)));
}

function mcpOverlayHeight(terminalHeight: number, itemLimit: number): number {
  return Math.min(Math.max(1, terminalHeight - 1), 5 + itemLimit * 2);
}

function agentDetailLines(item: AgentThreadSummary): string[] {
  if (item.role === "main") return ["main coordination thread"];
  const detail = item.error ?? item.summary;
  if (!detail?.trim()) return [item.status === "running" ? "work is still in progress" : "no result preview available"];
  const lines = detail.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length <= 3) return lines;
  return [...lines.slice(0, 2), `... +${lines.length - 2} lines`];
}

function visibleAgentDetailLines(item: AgentThreadSummary, terminalHeight: number): string[] {
  return agentDetailLines(item).slice(0, Math.max(0, terminalHeight - 10));
}

function agentStatus(item: AgentThreadSummary): string {
  if (item.status === "created") return "queued";
  if (item.status === "succeeded") return "completed";
  return item.status;
}

function agentStatusLine(item: AgentThreadSummary, current: boolean, now: number): string {
  const parts = [current ? "current" : undefined, current && item.status === "idle" ? undefined : agentStatus(item)];
  if (item.startedAt || item.completedAt) parts.push(agentElapsed(item, now));
  return parts.filter(Boolean).join(" · ");
}

function agentGlyph(item: AgentThreadSummary): string {
  const status = agentStatus(item);
  if (status === "completed") return "✓";
  if (status === "failed" || status === "lost") return "×";
  if (status === "cancelled") return "−";
  if (status === "running") return "●";
  return "○";
}

function agentColor(item: AgentThreadSummary): string {
  const status = agentStatus(item);
  if (status === "completed") return COLOR.success;
  if (status === "failed" || status === "lost") return COLOR.error;
  if (["queued", "starting", "running", "cancelling"].includes(status)) return COLOR.accent;
  return COLOR.dim;
}

function agentElapsed(item: AgentThreadSummary, now: number): string {
  const start = Date.parse(item.startedAt ?? item.createdAt);
  const end = item.completedAt ? Date.parse(item.completedAt) : now;
  const seconds = Math.max(0, Math.floor((end - start) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function statusGlyph(status: string): string {
  if (status === "ready") return "✓";
  if (status === "starting") return "•";
  if (status === "failed" || status === "stopped") return "×";
  if (status === "disabled") return "-";
  return "•";
}

function overlayMaxRows(kind: string, terminalHeight: number): number {
  let cap = 8;
  switch (kind) {
    case "model":
      cap = 10;
      break;
    case "sessions":
      cap = 12;
      break;
    case "agents":
      cap = 8;
      break;
  }
  return Math.min(cap, Math.max(1, terminalHeight - 6));
}

function descriptionColumn(rows: OverlayRow[], width: number): number {
  return selectionDescriptionColumn(rows
    .filter((row): row is OptionOverlayRow => row.kind === "option")
    .map((row) => ({
      ...(row.number === undefined ? {} : { number: row.number }),
      title: row.option.title,
      current: row.option.footer === "current"
    })), width);
}

function overlaySubtitle(kind: string): string {
  if (kind === "model") return "choose what model to use";
  if (kind === "mcp") return "review configured mcp servers";
  if (kind === "sessions") return "resume a saved chat";
  if (kind === "agents") return "inspect subagent sessions and background work";
  if (kind === "palette") return "run a tui action";
  if (kind === "evidence") return "open captured evidence";
  if (kind === "findings") return "review security findings";
  if (kind === "memory") return "inspect durable memory";
  return "";
}

function overlayHint(
  frame: OverlayFrame,
  matches: FuzzyMatch<unknown>[],
  providers: Array<{ id: string; removable: boolean }>
): string {
  if (frame.kind !== "model") return "press enter to confirm or esc to go back";
  const enabled = matches.filter((match) => !match.option.disabled);
  const index = selectableIndex(matches, frame.index);
  const selected = index >= 0 ? enabled[index]?.option.value as { kind?: string; providerID?: string } | undefined : undefined;
  if (selected?.kind === "model_action") return "enter add provider · ctrl+a add · esc back";
  const providerID = frame.providerID ?? (selected?.kind === "model_provider" ? selected.providerID : undefined);
  if (!providerID) return "ctrl+a add provider · esc back";
  const removable = providers.find((provider) => provider.id === providerID)?.removable ?? false;
  const primary = frame.providerID ? "enter select" : "enter models";
  return removable
    ? `${primary} · ctrl+a add · ctrl+e edit · ctrl+t test · ctrl+d remove · esc back`
    : `${primary} · ctrl+a add · ctrl+t test · esc back`;
}

function titleCase(value: string): string {
  return value.replace(/[_-]+/g, " ").toLowerCase();
}
