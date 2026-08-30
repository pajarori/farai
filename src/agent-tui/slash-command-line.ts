import type { CommandInvocation } from "./command-registry";

export function slashCommandInvocation(value: string): CommandInvocation {
  const raw = value.trim();
  const separator = raw.search(/\s/);
  const argsText = separator < 0 ? "" : raw.slice(separator).trimStart();
  return { raw, args: parseCommandArguments(argsText) };
}

export function parseCommandArguments(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;
  let started = false;
  for (const character of value) {
    if (escaping) {
      current += character;
      escaping = false;
      started = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaping = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (escaping) current += "\\";
  if (quote) throw new Error(`unterminated ${quote === "'" ? "single" : "double"} quote`);
  if (started) args.push(current);
  return args;
}
