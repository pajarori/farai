import type { Command, CommandContext, SlashBehavior, SlashVisibility } from "./command-registry";
import { isAgentCancelable } from "./store";

export type CommandOpeners = {
  palette?: () => void;
  sessions?: () => void;
  evidence?: () => void;
  findings?: () => void;
  memory?: () => void;
  model?: () => void;
  report?: () => void;
  compact?: () => void;
  todos?: () => void;
  notes?: () => void;
  container?: () => void;
  proxy?: () => void;
  mcp?: () => void;
  email?: () => void;
  agents?: () => void;
};

export function defineDefaultCommands(openers: CommandOpeners = {}): Command[] {
  return [
    opener("overlay.palette", "open command palette", "search every action by name", "ctrl+p", openers.palette),
    opener("overlay.sessions", "switch session", "pick from recent, running, or archived sessions", undefined, openers.sessions),
    opener("overlay.evidence", "browse evidence", "search captured evidence", undefined, openers.evidence),
    opener("overlay.findings", "browse findings", "review security findings", undefined, openers.findings),
    opener("overlay.memory", "browse memory", "credentials, services, endpoints, and hypotheses", undefined, openers.memory),
    opener("overlay.model", "switch model", "change provider or model", undefined, openers.model),
    opener("overlay.report", "preview report", "render and save the current security report", undefined, openers.report),
    opener("overlay.todos", "browse todos", "review durable task state", undefined, openers.todos),
    opener("overlay.notes", "browse notes", "review session notes", undefined, openers.notes),
    opener("overlay.container", "show runtime container", "inspect and control the managed container", undefined, openers.container),
    {
      name: "tab.proxy",
      title: "show proxy tab",
      desc: "switch to the protocol-aware mitmproxy traffic log",
      category: "runtime",
      run: ({ tui }) => {
        tui.actions.mainTabSet("proxy");
        void tui.refreshProxyFlows();
        openers.proxy?.();
      }
    },
    {
      name: "tab.chat",
      title: "show chat tab",
      desc: "switch back to the agent chat transcript",
      category: "runtime",
      run: ({ tui }) => tui.actions.mainTabSet("chat")
    },
    {
      name: "overlay.agents",
      title: "show agents",
      desc: "inspect active and recent subagent sessions",
      category: "runtime",
      slashName: "agent",
      slashAliases: ["agents"],
      slashBehavior: "local",
      run: () => openers.agents?.()
    },
    {
      name: "session.new",
      title: "new session",
      desc: "start a new chat",
      category: "session",
      slashName: "new",
      slashBehavior: "local",
      run: ({ tui }) => { void tui.createSession(); }
    },
    {
      name: "session.resume",
      title: "resume session",
      desc: "resume a saved chat",
      category: "session",
      slashName: "resume",
      slashBehavior: "local",
      run: () => openers.sessions?.()
    },
    {
      name: "session.fork",
      title: "fork session",
      desc: "fork current chat",
      category: "session",
      run: ({ tui }) => { void tui.forkCurrentSession(); }
    },
    {
      name: "session.compact",
      title: "compact context",
      desc: "summarize conversation to prevent hitting the context limit",
      category: "session",
      slashName: "compact",
      slashBehavior: "local",
      run: () => openers.compact?.()
    },
    {
      name: "session.clear",
      title: "clear conversation",
      desc: "clear chat context and keep durable pentest work",
      category: "session",
      slashName: "clear",
      slashBehavior: "local",
      run: ({ tui }) => { void tui.clearCurrentSession(); }
    },
    {
      name: "session.cancel-turn",
      title: "cancel running turn",
      desc: "interrupt the current agent step",
      category: "session",
      keybind: "escape",
      when: hasRunningTurn,
      run: ({ tui }) => { void tui.cancelCurrentTurn(); }
    },
    {
      name: "container.toggle",
      title: "start or stop runtime container",
      desc: "toggle the managed persistent container",
      category: "runtime",
      run: ({ tui }) => { void tui.toggleContainer(); }
    },
    messageNavigation("next", undefined),
    messageNavigation("prev", undefined),
    slashPrompt("context", "inspect context", "show stored versus projected context and token budget"),
    slashLocal("model", "switch model", "choose a model or add a provider", () => openers.model?.(), "visible", ["models"]),
    slashLocal("mcp", "mcp servers", "show configured mcp server status", () => openers.mcp?.()),
    slashLocal("email", "email inboxes", "choose primary or secondary email and add imap accounts", () => openers.email?.()),
    slashLocal("exit", "exit", "exit farai", ({ exit }) => { void exit(); }),
    slashLocal("quit", "quit", "exit farai", ({ exit }) => { void exit(); }, "hidden")
  ];
}

function slashPrompt(name: string, title: string, desc: string): Command {
  return {
    name: `slash.${name}`,
    title,
    desc,
    category: "slash",
    slashName: name,
    slashBehavior: "prompt",
    run: () => {}
  };
}

function opener(
  name: string,
  title: string,
  desc: string,
  keybind: string | undefined,
  open: (() => void) | undefined
): Command {
  return {
    name,
    title,
    desc,
    category: "overlay",
    ...(keybind ? { keybind } : {}),
    run: () => open?.()
  };
}

function messageNavigation(direction: "next" | "prev", keybind: string | undefined): Command {
  return {
    name: `message.${direction}`,
    title: `${direction === "next" ? "next" : "previous"} user message`,
    desc: `jump to the ${direction} user-message boundary`,
    category: "composer",
    ...(keybind ? { keybind } : {}),
    run: ({ tui }) => tui.actions.messageNavigationRequested(direction)
  };
}

function hasRunningTurn({ tui }: CommandContext): boolean {
  return isAgentCancelable(tui.store);
}

function slashLocal(
  name: string,
  title: string,
  desc: string,
  run: (ctx: CommandContext) => void | Promise<void>,
  visibility: SlashVisibility = "visible",
  aliases: string[] = []
): Command {
  return {
    name: `slash.${name}`,
    title,
    desc,
    category: "slash",
    slashName: name,
    ...(aliases.length ? { slashAliases: aliases } : {}),
    slashVisibility: visibility,
    slashBehavior: "local" satisfies SlashBehavior,
    run
  };
}

export type { Command, CommandContext };
