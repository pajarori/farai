export type CommandCategory =
  | "session"
  | "composer"
  | "overlay"
  | "runtime"
  | "slash"
  | "agent";

export type SlashVisibility = "visible" | "hidden";
export type SlashBehavior = "prompt" | "local";

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
  run: (ctx: CommandContext) => void | Promise<void>;
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

const commands = new Map<string, Command>();

export function registerCommand(command: Command): () => void {
  commands.set(command.name, command);
  return () => { commands.delete(command.name); };
}

export function registerCommands(defs: readonly Command[]): () => void {
  for (const def of defs) commands.set(def.name, def);
  return () => { for (const def of defs) commands.delete(def.name); };
}

export function listCommands(filter?: { category?: CommandCategory; ctx?: CommandContext }): Command[] {
  const all = [...commands.values()];
  if (!filter) return all;
  return all.filter((cmd) => {
    if (filter.category && cmd.category !== filter.category) return false;
    if (cmd.when && filter.ctx && !cmd.when(filter.ctx)) return false;
    return true;
  });
}

export function findCommand(name: string): Command | undefined {
  return commands.get(name);
}

export function findSlashCommand(slash: string): Command | undefined {
  const token = slash.startsWith("/")
    ? slash.slice(1).trimStart().split(/\s+/, 1)[0] ?? ""
    : slash.trimStart().split(/\s+/, 1)[0] ?? "";
  for (const command of commands.values()) {
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
}
