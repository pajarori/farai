import type { CommandContext } from "../command-registry";
import type { TuiStoreValue } from "../context/store";
import type { DialogOption } from "../dialog/fuzzy";
import { filterOptions } from "../dialog/fuzzy";
import { overlayOptions, type McpChoice, type ModelChoice } from "../overlay-options";

export function createOverlaySelection(tui: TuiStoreValue, commandContext: () => CommandContext) {
  function options(): DialogOption<unknown>[] {
    const frame = tui.store.ui.overlayStack.at(-1);
    if (!frame || !("query" in frame)) return [];
    return filterOptions(overlayOptions(frame, tui, commandContext()), frame.query)
      .map((match) => match.option)
      .filter((option) => !option.disabled) as DialogOption<unknown>[];
  }

  function selectedOption(): DialogOption<unknown> | undefined {
    const frame = tui.store.ui.overlayStack.at(-1);
    if (!frame || !("index" in frame)) return undefined;
    const current = options();
    if (current.length === 0) return undefined;
    return current[Math.max(0, Math.min(frame.index, current.length - 1))];
  }

  function modelProvider() {
    const frame = tui.store.ui.overlayStack.at(-1);
    if (frame?.kind !== "model") return undefined;
    const choice = selectedOption()?.value as ModelChoice | undefined;
    const providerID = frame.providerID ?? (choice?.kind === "model_provider" ? choice.providerID : undefined);
    return providerID ? tui.store.ui.modelProviders.find((provider) => provider.id === providerID) : undefined;
  }

  function mcpServer() {
    const frame = tui.store.ui.overlayStack.at(-1);
    if (frame?.kind !== "mcp") return undefined;
    if (frame.serverID) return tui.store.ui.mcpServers.find((server) => server.id === frame.serverID);
    const choice = selectedOption()?.value as McpChoice | undefined;
    if (choice?.kind !== "mcp_server") return undefined;
    return tui.store.ui.mcpServers.find((server) => server.id === choice.serverID);
  }

  return {
    options,
    count: () => options().length,
    selectedOption,
    modelProvider,
    modelContext: () => {
      const provider = modelProvider();
      return provider ? { providerID: provider.id, removable: provider.removable } : { removable: false };
    },
    mcpServer,
    mcpContext: () => {
      const server = mcpServer();
      return server
        ? { serverID: server.id, toggleable: server.toggleable, removable: server.removable }
        : { toggleable: false, removable: false };
    }
  };
}

export type OverlaySelection = ReturnType<typeof createOverlaySelection>;
