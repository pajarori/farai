export type CommandCategory =
  | "session"
  | "composer"
  | "overlay"
  | "runtime"
  | "slash"
  | "agent";

export type SlashVisibility = "visible" | "hidden";
export type SlashBehavior = "prompt" | "local";
export type CommandInvocation = { raw: string; args: string[] };

export type Command = {
  name: string;
  title: string;
  desc?: string;
  category: CommandCategory;
  keybind?: string;
  slashName?: string;
  slashAliases?: string[];
  slashVisibility?: SlashVisibility;
  slashBehavior?: SlashBehavior;

  when?: (ctx: CommandContext) => boolean;
  run: (ctx: CommandContext, invocation?: CommandInvocation) => void | Promise<void>;
};

export type CommandContext = {
  tui: import("./context/store").TuiStoreValue;
  dialog: {
    push(element: unknown, onClose?: () => void): symbol;
    pop(id?: symbol): void;
    replace(element: unknown, onClose?: () => void): symbol;
    clear(): void;
    isTop(id: symbol): boolean;
    stack(): unknown[];
  };
  exit: () => Promise<void> | void;
};

type CommandRegistration = { command: Command };

const commands = new Map<string, CommandRegistration[]>();
const listeners = new Set<() => void>();

export function registerCommand(command: Command): () => void {
  const registration: CommandRegistration = { command };
  const registrations = commands.get(command.name) ?? [];
  registrations.push(registration);
  commands.set(command.name, registrations);
  emitChanged();
  return () => {
    const current = commands.get(command.name);
    if (!current) return;
    const index = current.indexOf(registration);
    if (index < 0) return;
    current.splice(index, 1);
    if (current.length === 0) commands.delete(command.name);
    emitChanged();
  };
}

export function registerCommands(defs: readonly Command[]): () => void {
  const dispose = defs.map(registerCommand);
  return () => {
    for (let index = dispose.length - 1; index >= 0; index -= 1) dispose[index]!();
  };
}

export function listCommands(filter?: { category?: CommandCategory; ctx?: CommandContext }): Command[] {
  const all = [...commands.values()].flatMap((registrations) => registrations.at(-1)?.command ?? []);
  if (!filter) return all;
  return all.filter((cmd) => {
    if (filter.category && cmd.category !== filter.category) return false;
    if (cmd.when && filter.ctx && !cmd.when(filter.ctx)) return false;
    return true;
  });
}

export function findCommand(name: string): Command | undefined {
  return commands.get(name)?.at(-1)?.command;
}

export function findSlashCommand(slash: string): Command | undefined {
  const token = slash.startsWith("/")
    ? slash.slice(1).trimStart().split(/\s+/, 1)[0] ?? ""
    : slash.trimStart().split(/\s+/, 1)[0] ?? "";
  for (const registrations of commands.values()) {
    const command = registrations.at(-1)?.command;
    if (!command) continue;
    if (command.slashName === token) return command;
    if (command.slashAliases?.includes(token)) return command;
  }
  return undefined;
}

export function isVisibleSlashCommand(command: Command): boolean {
  return Boolean(command.slashName) && command.slashVisibility !== "hidden";
}

export function clearCommands(): void {
  commands.clear();
  emitChanged();
}

export function subscribeCommands(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emitChanged(): void {
  for (const listener of listeners) listener();
}
