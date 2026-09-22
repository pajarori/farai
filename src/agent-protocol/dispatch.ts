import type { AgentRuntime } from "../agent-core/runtime";
import type { Session } from "../types";
import { FARAI_VERSION } from "../version";
import { CURRENT_CONFIG_VERSION, loadConfig } from "../agent-core/config";
import { loadModelProfiles } from "../agent-core/model-profiles";
import { resolveDefaultModel } from "../agent-core/model-registry";
import { resolveDefaultCatalogModel } from "../agent-core/model-catalog";
import { DEFAULT_KALI_IMAGE } from "../agent-container/kali";
import { contentStatus } from "../agent-content";
import { validateAgainstSchema } from "../agent-core/tool-input-validation";
import { EVENT_PAYLOADS, OPERATIONS, PROTOCOL_VERSION, isOperationName, type OperationName, type ProtocolDescription } from "./contract";

export type SubscriptionSink = {
  subscribe(sessionId: string, cursor: number): { cursor: number };
  unsubscribe(sessionId: string): boolean;
};

export type DispatchContext = {
  runtime: AgentRuntime;
  workspace: string;
  subscriptions?: SubscriptionSink;
};

type Args = Record<string, unknown>;
type Handler = (args: Args, context: DispatchContext) => Promise<unknown> | unknown;

function sessionOf(context: DispatchContext, args: Args): Session {
  return context.runtime.loadSession(String(args.sessionId));
}

function requireSubscriptions(context: DispatchContext): SubscriptionSink {
  if (!context.subscriptions) throw new Error("this transport does not support event subscriptions");
  return context.subscriptions;
}

const HANDLERS: Record<OperationName, Handler> = {
  "describe": () => describeProtocol(),
  "health": async (_args, context) => {
    const configured = resolveDefaultModel();
    const resolved = await resolveDefaultCatalogModel(context.workspace).catch(() => undefined);
    const config = loadConfig(context.workspace);
    const content = contentStatus().active?.version ?? null;
    return {
      faraiVersion: FARAI_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      configVersion: CURRENT_CONFIG_VERSION,
      workspace: context.workspace,
      model: resolved?.model ?? configured.model ?? "auto",
      baseUrl: resolved?.baseUrl ?? configured.baseUrl,
      modelProviders: loadModelProfiles(context.workspace).map((profile) => profile.name),
      mcpServers: Object.keys(config.mcpServers ?? {}),
      kaliImage: DEFAULT_KALI_IMAGE,
      contentVersion: content
    };
  },
  "session.list": (args, context) => {
    const sessions = context.runtime.listSessions(args.includeArchived === true);
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    return { sessions: limit === undefined ? sessions : sessions.slice(0, limit) };
  },
  "session.get": (args, context) => ({ session: sessionOf(context, args) }),
  "session.create": async (args, context) => ({
    session: await context.runtime.createSession({
      ...(typeof args.title === "string" ? { title: args.title } : {}),
      ...(typeof args.model === "string" ? { model: args.model } : {})
    })
  }),
  "session.update": (args, context) => {
    const { sessionId, ...patch } = args;
    return { session: context.runtime.updateSession(String(sessionId), patch as never) };
  },
  "session.fork": async (args, context) => ({
    session: await context.runtime.forkSession(String(args.sessionId), typeof args.title === "string" ? args.title : undefined)
  }),
  "session.archive": async (args, context) => ({ session: await context.runtime.archiveSession(String(args.sessionId)) }),
  "session.usage": (args, context) => ({ usage: context.runtime.store.usageSummaryTree(String(args.sessionId)) }),
  "session.events": (args, context) => {
    const cursor = typeof args.cursor === "number" ? args.cursor : 0;
    const limit = typeof args.limit === "number" ? args.limit : 1000;
    const events = context.runtime.store.listEventsAfter(String(args.sessionId), cursor, limit);
    return { events, cursor: events.at(-1)?.sequence ?? cursor };
  },
  "session.subscribe": (args, context) => {
    const cursor = typeof args.cursor === "number" ? args.cursor : 0;
    return requireSubscriptions(context).subscribe(String(args.sessionId), cursor);
  },
  "session.unsubscribe": (args, context) => ({ stopped: requireSubscriptions(context).unsubscribe(String(args.sessionId)) }),
  "session.compact": async (args, context) => ({
    session: await context.runtime.compactSession(sessionOf(context, args), typeof args.instructions === "string" ? args.instructions : undefined)
  }),
  "session.context": async (args, context) => ({
    context: await context.runtime.inspectContext(sessionOf(context, args), typeof args.hypotheticalInput === "string" ? args.hypotheticalInput : undefined)
  }),
  "turn.prompt": async (args, context) => {
    const session = sessionOf(context, args);
    const text = String(args.text);
    if (args.async === true) {
      void context.runtime.prompt(session, text).catch(() => undefined);
      return { sessionId: session.id, started: true };
    }
    const result = await context.runtime.prompt(session, text);
    return { sessionId: result.session.id, response: result.response };
  },
  "turn.cancel": (args, context) => {
    const sessionId = String(args.sessionId);
    const running = context.runtime.store.listTurns(sessionId, 10).find((turn) => turn.status === "running");
    if (!running) return { cancelled: false };
    const reason = typeof args.reason === "string" ? args.reason : "cancelled by client";
    return { cancelled: true, turn: context.runtime.cancelTurn(running.id, reason) };
  },
  "turn.steer": (args, context) => ({ steered: context.runtime.injectUserInput(String(args.sessionId), String(args.text)) }),
  "userInput.pending": (args, context) => ({ pending: context.runtime.pendingUserInput(String(args.sessionId)) }),
  "userInput.answer": (args, context) => {
    const sessionId = String(args.sessionId);
    if (args.answers && typeof args.answers === "object" && !Array.isArray(args.answers)) {
      return { answer: context.runtime.answerUserInputStructured(sessionId, { answers: args.answers as Record<string, string> }) };
    }
    if (typeof args.text !== "string") throw new Error("answer requires text or answers");
    return { answer: context.runtime.answerUserInput(sessionId, args.text) };
  },
  "userInput.cancel": (args, context) => ({ cancelled: context.runtime.cancelUserInput(String(args.sessionId)) }),
  "container.status": async (args, context) => ({ status: await context.runtime.containerStatus(String(args.sessionId)) }),
  "container.start": async (args, context) => {
    await context.runtime.startContainer(String(args.sessionId));
    return { started: true };
  },
  "container.stop": async (args, context) => {
    await context.runtime.stopContainer(String(args.sessionId));
    return { stopped: true };
  },
  "report.export": (args, context) => context.runtime.exportReport(String(args.sessionId), { write: args.write === true }),
  "agent.threads": (args, context) => ({ threads: context.runtime.listAgentLifecycleEntries(String(args.sessionId)) })
};

export function describeProtocol(): ProtocolDescription {
  return {
    protocolVersion: PROTOCOL_VERSION,
    faraiVersion: FARAI_VERSION,
    configVersion: CURRENT_CONFIG_VERSION,
    operations: Object.entries(OPERATIONS).map(([name, spec]) => ({ name, summary: spec.summary, input: spec.input })),
    events: EVENT_PAYLOADS
  };
}

export async function dispatch(operation: string, rawArgs: unknown, context: DispatchContext): Promise<unknown> {
  if (!isOperationName(operation)) throw new Error(`unknown operation: ${operation}`);
  const args = rawArgs === undefined || rawArgs === null ? {} : rawArgs;
  const invalid = validateAgainstSchema(OPERATIONS[operation].input as Record<string, unknown>, args, "operation input");
  if (invalid) throw new Error(invalid);
  return await HANDLERS[operation](args as Args, context);
}
