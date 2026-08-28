import type { Command } from "./command-registry";
import type { DialogOption } from "./dialog/fuzzy";
import { filterOptions } from "./dialog/fuzzy";

export function slashMatches(options: readonly DialogOption<Command>[], value: string, limit = 8): DialogOption<Command>[] {
  if (!value.startsWith("/") || value.slice(1).includes(" ")) return [];
  return filterOptions(options, value.slice(1)).slice(0, limit).map((match) => match.option);
}


export function slashCompletionOption(options: readonly DialogOption<Command>[], value: string, index = 0): DialogOption<Command> | undefined {
  return slashMatches(options, value)[index];
}
