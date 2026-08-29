import { isVisibleSlashCommand, listCommands, type Command } from "./command-registry";
import type { DialogOption } from "./dialog/fuzzy";
import { filterOptions } from "./dialog/fuzzy";

export function slashCommandOptions(): DialogOption<Command>[] {
  return listCommands()
    .filter((command) => command.slashName && isVisibleSlashCommand(command))
    .map((command) => ({
      id: command.name,
      title: `/${command.slashName ?? command.name}`,
      ...(command.desc ? { description: command.desc } : {}),
      value: command
    }));
}

export function slashMatches(options: readonly DialogOption<Command>[], value: string, limit = 8): DialogOption<Command>[] {
  if (!value.startsWith("/") || value.slice(1).includes(" ")) return [];
  return filterOptions(options, value.slice(1)).slice(0, limit).map((match) => match.option);
}

export function slashPopupVisible(value: string, suppressed: boolean, optionCount: number, blocked: boolean): boolean {
  return !blocked
    && !suppressed
    && optionCount > 0
    && value.startsWith("/")
    && !value.slice(1).includes(" ")
    && !value.includes("\n");
}

export function slashPopupRowLimit(terminalHeight: number): number {
  return Math.min(8, Math.max(1, terminalHeight - 6));
}

export function slashCompletionOption(options: readonly DialogOption<Command>[], value: string, index = 0): DialogOption<Command> | undefined {
  return slashMatches(options, value)[index];
}
