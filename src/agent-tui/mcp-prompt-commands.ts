import type { McpServerRuntimeStatus } from "../agent-tools/mcp-manager";
import type { Command } from "./command-registry";

export function defineMcpPromptCommands(statuses: readonly McpServerRuntimeStatus[]): Command[] {
  const commands: Command[] = [];
  const names = new Set<string>();
  for (const status of statuses) {
    if (!status.enabled) continue;
    for (const prompt of status.prompts) {
      let slashName = `${commandPart(status.name)}:${commandPart(prompt.name)}`;
      if (names.has(slashName)) slashName = `${slashName}:${Bun.hash(`${status.name}\0${prompt.name}`).toString(36).slice(-6)}`;
      names.add(slashName);
      const signature = prompt.arguments.map((argument) => `${argument.name}${argument.required ? "" : "?"}`).join(" ");
      commands.push({
        name: `mcp.prompt.${status.name}.${prompt.name}`,
        title: `/${slashName}`,
        desc: [prompt.description, signature ? `args: ${signature}` : undefined].filter(Boolean).join(" · ") || `run ${prompt.title ?? prompt.name} from ${status.name}`,
        category: "slash",
        slashName,
        slashBehavior: "local",
        run: async ({ tui }, invocation) => {
          await tui.submitMcpPrompt(status.name, prompt.name, invocation?.args ?? []);
        }
      });
    }
  }
  return commands;
}

function commandPart(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "mcp";
}
