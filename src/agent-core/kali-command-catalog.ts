import { KALI_TOOL_MANIFEST } from "../agent-container/kali-tool-manifest";

const commands = [...new Set(Object.values(KALI_TOOL_MANIFEST.workflows).flat())].sort((left, right) => left.localeCompare(right));

export const KALI_CURATED_COMMAND_COUNT = commands.length;

export function renderKaliCommandCatalog(): string {
  return [
    `curated Kali capability map: ${commands.length} exact commands from ${KALI_TOOL_MANIFEST.aptPackages.length} selected packages and Farai runtime extras`,
    ...Object.entries(KALI_TOOL_MANIFEST.workflows).map(([workflow, workflowCommands]) => `recommended-${workflow}: ${workflowCommands.join(", ")}`),
    `available-commands: ${commands.join(", ")}`
  ].join("\n");
}
