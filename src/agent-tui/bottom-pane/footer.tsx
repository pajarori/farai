import { createMemo, type JSX } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { useTuiStore } from "../context/store";
import { useComposerControl } from "../context/composer";
import { useTuiRuntime } from "../context/runtime";
import { COLOR } from "../theme";
import { fmtElapsed } from "./time";
import { contextualFooter, fitFooterLine, footerRightItems, instructionalFooterLines, type FooterMode } from "./footer-state";
import { displayModelSelection } from "../../agent-core/model-catalog";
import { loadConfig } from "../../agent-core/config";
import { DEFAULT_CONTEXT_WINDOW } from "../../agent-core/default-model";
import { isAgentBusy } from "../store";

type FooterProps = {
  elapsed: number;
};

type ShowShortcutLinesProps = {
  lines: string[];
};

export function Footer(props: FooterProps): JSX.Element {
  const tui = useTuiStore();
  const runtime = useTuiRuntime();
  const composer = useComposerControl();
  const dims = useTerminalDimensions();
  const session = () => tui.store.snapshot.session;
  const modelLabel = createMemo(() => displayModel(session()?.model, runtime.workspace));
  const configuredModel = createMemo(() => {
    const sessionModel = session()?.model;
    const config = loadConfig(runtime.workspace);
    return { config, selection: sessionModel ?? config.model };
  });
  const historySearch = () => tui.store.ui.historySearch;
  const historyCount = createMemo(() => {
    const search = historySearch();
    if (!search) return 0;
    if (!search.query.trim()) return tui.store.ui.promptHistory.length;
    const needle = search.query.toLowerCase();
    return tui.store.ui.promptHistory.filter((entry) => entry.text.toLowerCase().includes(needle)).length;
  });
  const context = () => {
    return `${modelLabel()} · ${runtime.workspace}`;
  };
  const mode = (): FooterMode => {
    const search = historySearch();
    if (search) return "history_search";
    if (tui.store.ui.footerMode === "shortcuts") return "shortcut_overlay";
    if (tui.store.ui.footerMode === "quit_hint") return "quit_hint";
    if (tui.store.ui.footerMode === "esc_hint") return "esc_hint";
    if (isAgentBusy(tui.store)) return "running";
    if (composer.text().trim()) return "composer_has_draft";
    return "composer_empty";
  };
  const state = () => ({
    mode: mode(),
    draft: composer.text(),
    isRunning: isAgentBusy(tui.store),
    queueSize: tui.store.snapshot.queuedPrompts.length,
    elapsed: fmtElapsed(props.elapsed),
    historyQuery: historySearch()?.query ?? "",
    historyMatches: historyCount(),
    context: context()
  });
  const lines = createMemo(() => instructionalFooterLines(state()));
  const left = () => [contextualFooter(state()), lines()[0]].filter(Boolean).join(" · ");
  const contextUsage = () => {
    const current = tui.store.ui.contextUsage;
    const { config, selection } = configuredModel();
    const budget = current?.budget
      ?? (selection ? config.modelLimits?.[selection]?.contextWindow : undefined)
      ?? config.contextWindow
      ?? DEFAULT_CONTEXT_WINDOW;
    return { tokens: current?.tokens ?? 0, budget };
  };
  const rightItems = createMemo(() => footerRightItems(
    tui.store.snapshot.backgroundActivities,
    tui.store.snapshot.subagents,
    tui.store.snapshot.queuedPrompts.length,
    tui.store.ui.statusDetail,
    contextUsage()
  ));
  const firstLine = () => fitFooterLine(left(), rightItems(), Math.max(0, dims().width - 4));

  return (
    <box style={{ flexShrink: 0, flexDirection: "column" }}>
      <box style={{ height: 1, flexDirection: "row", justifyContent: "space-between" }}>
        <text fg={historySearch() ? COLOR.accent : COLOR.dim}>{firstLine().left}</text>
        <text fg={COLOR.dim}>{firstLine().right}</text>
      </box>
      <ShowShortcutLines lines={lines().slice(1).map((line) => line.toLowerCase())} />
    </box>
  );
}

function displayModel(sessionModel: string | undefined, workspace: string): string {
  return displayModelSelection(workspace, sessionModel);
}

function ShowShortcutLines(props: ShowShortcutLinesProps): JSX.Element {
  return (
    <>
      {props.lines.map((line) => <text fg={COLOR.dim}>{line}</text>)}
    </>
  );
}
