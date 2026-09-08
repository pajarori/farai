import type { MouseEvent, ScrollBoxRenderable } from "@opentui/core";
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, type JSX } from "solid-js";
import type { Finding } from "../../types";
import { useTuiDimensions } from "../context/terminal";
import { useTuiStore } from "../context/store";
import { MarkdownView } from "../markdown";
import { COLOR } from "../theme";
import { fitTerminalPair, terminalWidth, truncateTerminal } from "../terminal-text";
import { isPrimaryClick } from "../input/mouse";
import { isOpenFinding, sameFinding } from "./model";

const SEVERITY_ORDER: Record<Finding["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4
};

const FINDINGS_MIN_LIST_WIDTH = 36;
const FINDINGS_MIN_DETAIL_WIDTH = 44;
const FINDINGS_SEVERITY_WIDTH = 12;
const FINDINGS_ROW_HEIGHT = 5;

export function findingsListWidthFromDrag(startWidth: number, startX: number, pointerX: number): number {
  return startWidth + pointerX - startX;
}

export function clampFindingsListWidth(width: number, terminalWidth: number): number {
  const available = Math.max(1, Math.floor(terminalWidth) - 1);
  const minimum = Math.min(FINDINGS_MIN_LIST_WIDTH, available);
  const maximum = Math.max(minimum, available - FINDINGS_MIN_DETAIL_WIDTH);
  return Math.max(minimum, Math.min(maximum, Math.floor(width)));
}

export function FindingsView(props: { active?: boolean } = {}): JSX.Element {
  const tui = useTuiStore();
  const dims = useTuiDimensions();
  let listScroll!: ScrollBoxRenderable;
  let detailScroll!: ScrollBoxRenderable;
  let lastScrollSequence = 0;
  const [listWidthOverride, setListWidthOverride] = createSignal<number | undefined>();
  const [dividerDragging, setDividerDragging] = createSignal(false);
  let dividerDragStart: { pointerX: number; listWidth: number } | undefined;
  let suppressFindingsRowMouseUp = false;
  let dividerGestureGeneration = 0;
  let selectionScrollGeneration = 0;
  let disposed = false;
  const active = () => props.active ?? true;
  const horizontal = () => dims().width >= 100;
  const query = () => tui.store.ui.findingsQuery.trim().toLowerCase();
  const findingCache = new Map<string, Finding>();
  const findings = createMemo(() => filteredFindings(tui.store.ui.findingsCatalog, query()).map((finding) => {
    const cached = findingCache.get(finding.id);
    if (cached && sameFinding(cached, finding)) return cached;
    findingCache.set(finding.id, finding);
    return finding;
  }));
  const selected = createMemo(() => {
    const rows = findings();
    const selectedId = tui.store.ui.findingsSelectedId;
    return rows.find((finding) => finding.id === selectedId) ?? rows[0];
  });
  const selectedId = () => selected()?.id;
  const openCount = createMemo(() => tui.store.ui.findingsCatalog.filter((finding) => isOpenFinding(finding)).length);
  const listHeight = () => Math.max(6, Math.min(15, Math.floor(dims().height * 0.34)));
  const paneWidth = () => Math.max(1, dims().width);
  const listWidth = () => horizontal()
    ? clampFindingsListWidth(listWidthOverride() ?? Math.floor(paneWidth() * 0.42), paneWidth())
    : paneWidth();
  const detailWidth = () => horizontal()
    ? Math.max(1, paneWidth() - listWidth() - 3)
    : paneWidth();

  const beginListResize = (event: MouseEvent): void => {
    if (!horizontal() || event.button !== 0) return;
    dividerDragStart = { pointerX: event.x, listWidth: listWidth() };
    dividerGestureGeneration += 1;
    suppressFindingsRowMouseUp = true;
    setDividerDragging(true);
    event.preventDefault();
    event.stopPropagation();
  };

  const resizeList = (event: MouseEvent): void => {
    if (!dividerDragStart || !horizontal()) return;
    setListWidthOverride(clampFindingsListWidth(
      findingsListWidthFromDrag(dividerDragStart.listWidth, dividerDragStart.pointerX, event.x),
      paneWidth()
    ));
    event.preventDefault();
    event.stopPropagation();
  };

  const finishListResize = (event: MouseEvent): void => {
    if (!dividerDragStart) return;
    resizeList(event);
    const generation = dividerGestureGeneration;
    dividerDragStart = undefined;
    setDividerDragging(false);
    queueMicrotask(() => {
      if (!disposed && generation === dividerGestureGeneration) suppressFindingsRowMouseUp = false;
    });
  };

  createEffect(() => {
    const id = selectedId();
    if (id && id !== tui.store.ui.findingsSelectedId) tui.actions.findingsSelectedSet(id);
  });

  createEffect(on(() => tui.store.ui.findingsDetailScroll.sequence, () => {
    const request = tui.store.ui.findingsDetailScroll;
    if (!active() || request.sequence === 0 || request.sequence === lastScrollSequence || !detailScroll || detailScroll.isDestroyed) return;
    lastScrollSequence = request.sequence;
    applyScroll(detailScroll, request.action);
  }));

  createEffect(on(selectedId, () => {
    const id = selectedId();
    const generation = ++selectionScrollGeneration;
    queueMicrotask(() => {
      if (!active() || generation !== selectionScrollGeneration || !id || !listScroll || listScroll.isDestroyed) return;
      try { listScroll.scrollChildIntoView(`finding-row-${id}`); } catch {}
    });
    if (!detailScroll || detailScroll.isDestroyed) return;
    lastScrollSequence = tui.store.ui.findingsDetailScroll.sequence;
    detailScroll.scrollTo(0);
  }));

  createEffect(() => {
    if (active() && horizontal()) return;
    dividerGestureGeneration += 1;
    dividerDragStart = undefined;
    suppressFindingsRowMouseUp = false;
    setDividerDragging(false);
  });

  onCleanup(() => {
    disposed = true;
    dividerGestureGeneration += 1;
    dividerDragStart = undefined;
    suppressFindingsRowMouseUp = false;
    selectionScrollGeneration += 1;
  });

  const select = (finding: Finding): void => {
    tui.actions.findingsSelectedSet(finding.id);
    tui.actions.findingsFocusSet("list");
  };

  const list = () => (
    <box id="findings-list" style={{
      width: listWidth(),
      maxWidth: listWidth(),
      height: horizontal() ? "100%" : listHeight(),
      flexShrink: 0,
      minWidth: 0,
      flexDirection: "column",
      minHeight: 0,
      overflow: "hidden",
      paddingRight: horizontal() ? 1 : 0
    }}>
      <scrollbox
        ref={listScroll}
        viewportCulling
        scrollbarOptions={{ visible: false }}
        style={{ flexGrow: 1, minHeight: 0, flexDirection: "column" }}
      >
        <Show when={findings().length > 0} fallback={<FindingsEmpty query={query()} />}>
          <For each={findings()}>{(finding) => <FindingListRow
            finding={finding}
            width={Math.max(1, listWidth() - (horizontal() ? 1 : 0))}
            selected={finding.id === selectedId()}
            onSelect={() => { if (!suppressFindingsRowMouseUp) select(finding); }}
          />}</For>
        </Show>
      </scrollbox>
    </box>
  );

  const detail = () => (
    <box id="findings-detail" style={{ flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0, minHeight: 0, overflow: "hidden", flexDirection: "column", paddingLeft: horizontal() ? 2 : 0, paddingTop: horizontal() ? 0 : 1 }}>
      <Show when={selectedId()} fallback={<FindingsEmpty query="" />}>
        <FindingDetail width={detailWidth()} finding={() => selected()} scrollRef={(value) => { detailScroll = value; }} />
      </Show>
    </box>
  );

  return (
    <box
      id="findings-surface"
      style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, flexDirection: "column", paddingTop: 0, paddingBottom: 1, paddingLeft: 0, paddingRight: 0 }}
      onMouseDrag={resizeList}
      onMouseDragEnd={finishListResize}
      onMouseUp={finishListResize}
    >
      <box style={{ height: 1, flexShrink: 0, flexDirection: "row", justifyContent: "space-between" }}>
        <text fg={COLOR.text}>findings</text>
        <FindingsHeaderMeta
          width={Math.max(1, dims().width - 10)}
          filter={tui.store.ui.findingsFiltering ? `filter: ${tui.store.ui.findingsQuery || "_"}` : query() ? `filter: ${tui.store.ui.findingsQuery}` : "filter: all"}
          count={tui.store.ui.findingsLoading && tui.store.ui.findingsCatalog.length === 0 ? "refreshing" : `${tui.store.ui.findingsCatalog.length} total · ${openCount()} open`}
          findingId={selectedId()}
        />
      </box>
      <box style={{ width: "100%", flexGrow: 1, flexShrink: 1, minWidth: 0, minHeight: 0, marginTop: 1, flexDirection: horizontal() ? "row" : "column" }}>
        {list()}
        <Show when={horizontal()}>
          <box
            id="findings-divider"
            style={{ width: 1, height: "100%", flexShrink: 0, overflow: "hidden", alignItems: "center" }}
            onMouseDown={beginListResize}
          >
            <text selectable={false} fg={dividerDragging() ? COLOR.accent : COLOR.border}>{findingsDividerGlyphs(Math.max(1, dims().height))}</text>
          </box>
        </Show>
        {detail()}
      </box>
    </box>
  );
}

function FindingListRow(props: { finding: Finding; width: number; selected: boolean; onSelect: () => void }): JSX.Element {
  const severity = () => props.finding.severity.toLowerCase();
  const contentWidth = () => Math.max(1, props.width - FINDINGS_SEVERITY_WIDTH - 2);
  const title = () => truncateTerminal(props.finding.title, contentWidth());
  const target = () => truncateTerminal(props.finding.target || "unknown target", contentWidth());
  const metadata = () => truncateTerminal([
    displayStatus(props.finding.status),
    props.finding.cvssScore === undefined ? "" : `cvss ${props.finding.cvssScore.toFixed(1)}`
  ].filter(Boolean).join(" · "), contentWidth());
  return (
    <box
      id={`finding-row-${props.finding.id}`}
      style={{ width: "100%", height: FINDINGS_ROW_HEIGHT, flexDirection: "row", alignItems: "stretch", backgroundColor: props.selected ? COLOR.panelActive : COLOR.bg, overflow: "hidden" }}
      onMouseUp={(event) => { if (isPrimaryClick(event)) props.onSelect(); }}
    >
      <box style={{ width: FINDINGS_SEVERITY_WIDTH, height: "100%", flexShrink: 0, flexDirection: "column", alignItems: "center", justifyContent: "center", backgroundColor: severityBackgroundColor(props.finding.severity) }}>
        <text selectable={false} fg="#ffffff">{centerTerminalText(severity(), FINDINGS_SEVERITY_WIDTH)}</text>
      </box>
      <box style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, height: "100%", flexDirection: "column", paddingTop: 1, paddingBottom: 1, paddingLeft: 1, paddingRight: 1 }}>
        <text selectable={false} fg={props.selected ? COLOR.accent : COLOR.text}>{title()}</text>
        <text selectable={false} fg={COLOR.dim}>{target()}</text>
        <text selectable={false} fg={COLOR.dim}>{metadata()}</text>
      </box>
    </box>
  );
}

function centerTerminalText(value: string, width: number): string {
  const text = truncateTerminal(value, width);
  const remaining = Math.max(0, width - terminalWidth(text));
  const left = Math.ceil(remaining / 2);
  return `${" ".repeat(left)}${text}${" ".repeat(remaining - left)}`;
}

function FindingsHeaderMeta(props: { width: number; filter: string; count: string; findingId?: string | undefined }): JSX.Element {
  const right = () => [props.count, props.findingId ? `id ${compactFindingId(props.findingId)}` : ""].filter(Boolean).join(" · ");
  const pair = () => fitTerminalPair(props.filter, right(), props.width, 1, 2);
  return (
    <box style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, flexDirection: "row", justifyContent: "flex-end" }}>
      <text fg={COLOR.dim}>{pair().left}</text>
      <text fg={COLOR.border}>  </text>
      <text fg={COLOR.dim}>{pair().right}</text>
    </box>
  );
}

function compactFindingId(value: string): string {
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

function FindingDetail(props: { width: number; finding: () => Finding | undefined; scrollRef: (value: ScrollBoxRenderable) => void }): JSX.Element {
  const finding = () => props.finding()!;
  const contentWidth = () => Math.max(1, props.width - FINDINGS_SEVERITY_WIDTH - 2);
  const target = () => {
    const current = finding();
    return truncateTerminal(current.target || "target not recorded", contentWidth());
  };
  const metadata = () => {
    const current = finding();
    return truncateTerminal([
      displayStatus(current.status),
      current.cvssScore === undefined ? "" : `cvss ${current.cvssScore.toFixed(1)}`,
      `${current.evidenceIds.length} evidence`
    ].filter(Boolean).join(" · "), contentWidth());
  };
  return (
    <>
      <box style={{ width: "100%", height: 5, flexShrink: 0, flexDirection: "row", backgroundColor: COLOR.panelActive, overflow: "hidden" }}>
        <box style={{ width: FINDINGS_SEVERITY_WIDTH, height: "100%", flexShrink: 0, flexDirection: "column", alignItems: "center", justifyContent: "center", backgroundColor: severityBackgroundColor(finding().severity) }}>
          <text selectable={false} fg="#ffffff">{centerTerminalText(finding().severity.toLowerCase(), FINDINGS_SEVERITY_WIDTH)}</text>
        </box>
        <box style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, height: "100%", flexDirection: "column", paddingTop: 1, paddingBottom: 1, paddingLeft: 1, paddingRight: 1 }}>
          <text selectable={false} fg={COLOR.accent}>{truncateTerminal(finding().title, contentWidth())}</text>
          <text selectable={false} fg={COLOR.dim}>{target()}</text>
          <text selectable={false} fg={COLOR.dim}>{metadata()}</text>
        </box>
      </box>
      <scrollbox ref={props.scrollRef} scrollbarOptions={{ visible: false }} style={{ flexGrow: 1, minHeight: 0, paddingTop: 1 }}>
        <MarkdownView id="findings-markdown" content={findingMarkdown(finding())} />
      </scrollbox>
    </>
  );
}

function FindingsEmpty(props: { query: string }): JSX.Element {
  return (
    <box style={{ flexDirection: "column", paddingTop: 1 }}>
      <text fg={COLOR.dim}>{props.query ? "no findings match this filter" : "no findings in this scope"}</text>
      <Show when={!props.query}><text fg={COLOR.dim}>Farai will add findings when it records a security signal.</text></Show>
    </box>
  );
}

export function findingMarkdown(finding: Finding): string {
  const evidence = finding.evidenceIds.length > 0
    ? finding.evidenceIds.map((id) => `- \`${id}\``)
    : ["_no linked evidence._"];
  const technical = [
    finding.cvssVector ? `- CVSS 3.1 : \`${finding.cvssVector}\`` : "",
    finding.campaignId ? `- campaign : \`${finding.campaignId}\`` : "",
    finding.hypothesisId ? `- hypothesis: \`${finding.hypothesisId}\`` : "",
    finding.duplicateOf ? `- duplicate of: \`${finding.duplicateOf}\`` : ""
  ].filter(Boolean);
  return [
    ...(technical.length > 0 ? ["## technical details", "", ...technical, ""] : []),
    "## impact",
    "",
    finding.impact.trim() || "_not recorded._",
    "",
    "## reproduction",
    "",
    finding.reproduction.trim() || "_not recorded._",
    "",
    "## remediation",
    "",
    finding.remediation.trim() || "_not recorded._",
    "",
    "## evidence",
    "",
    ...evidence
  ].join("\n");
}

function filteredFindings(findings: Finding[], query: string): Finding[] {
  return findings
    .slice()
    .reverse()
    .filter((finding) => !query || [finding.title, finding.target, finding.severity, displayStatus(finding.status), finding.impact, finding.reproduction, finding.remediation].join(" ").toLowerCase().includes(query))
    .sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]);
}

function findingsDividerGlyphs(height: number): string {
  return Array.from({ length: height }, () => "│").join("\n");
}

function displayStatus(status: Finding["status"]): string {
  return (status ?? "candidate").replaceAll("_", " ");
}

function severityBackgroundColor(severity: Finding["severity"]): string {
  if (severity === "critical") return "#a8323c";
  if (severity === "high") return "#873c42";
  if (severity === "medium") return "#80652f";
  if (severity === "low") return "#356777";
  return "#555555";
}

function applyScroll(scroll: ScrollBoxRenderable, action: "up" | "down" | "pageUp" | "pageDown" | "home" | "end"): void {
  switch (action) {
    case "up": scroll.scrollBy(-1, "step"); break;
    case "down": scroll.scrollBy(1, "step"); break;
    case "pageUp": scroll.scrollBy(-1, "viewport"); break;
    case "pageDown": scroll.scrollBy(1, "viewport"); break;
    case "home": scroll.scrollTo(0); break;
    case "end": scroll.scrollTo(scroll.scrollHeight); break;
  }
}
