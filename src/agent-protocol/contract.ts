export const PROTOCOL_VERSION = 1;

export type OperationSpec = {
  summary: string;
  input: Record<string, unknown>;
  long?: boolean;
};

export type ErrorCode = "unknown_operation" | "invalid_input" | "not_found" | "conflict" | "internal";

export class ProtocolError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export function errorCodeFor(error: unknown): ErrorCode {
  if (error instanceof ProtocolError) return error.code;
  const message = error instanceof Error ? error.message : String(error);
  if (/not found/i.test(message)) return "not_found";
  if (/already has|already running|is already|no pending/i.test(message)) return "conflict";
  return "internal";
}

const sessionIdInput = {
  type: "object",
  required: ["sessionId"],
  properties: { sessionId: { type: "string" } },
  additionalProperties: false
} as const;

const emptyInput = { type: "object", properties: {}, additionalProperties: false } as const;

export const OPERATIONS = {
  "describe": {
    summary: "return the protocol version, every operation with its input schema, and the event payload schemas",
    input: emptyInput
  },
  "health": {
    summary: "report runtime health: resolved model, providers, mcp servers, kali image, content version",
    input: emptyInput
  },
  "session.list": {
    summary: "list sessions known to this workspace",
    input: {
      type: "object",
      properties: { includeArchived: { type: "boolean" }, limit: { type: "integer", minimum: 1, maximum: 10000 } },
      additionalProperties: false
    }
  },
  "session.get": {
    summary: "load one session by id",
    input: sessionIdInput
  },
  "session.create": {
    summary: "create a session in this workspace",
    input: {
      type: "object",
      properties: { title: { type: "string" }, model: { type: "string" } },
      additionalProperties: false
    }
  },
  "session.update": {
    summary: "patch a session's title, model, phase, or workspace",
    input: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" },
        title: { type: "string" },
        model: { type: "string" },
        phase: { type: "string" }
      },
      additionalProperties: false
    }
  },
  "session.fork": {
    summary: "fork a session into a new child session",
    input: {
      type: "object",
      required: ["sessionId"],
      properties: { sessionId: { type: "string" }, title: { type: "string" } },
      additionalProperties: false
    }
  },
  "session.archive": {
    summary: "archive a session",
    input: sessionIdInput
  },
  "session.usage": {
    summary: "return token and cost usage for a session",
    input: sessionIdInput
  },
  "session.events": {
    summary: "read persisted session events after a cursor",
    input: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" },
        cursor: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 10000 }
      },
      additionalProperties: false
    }
  },
  "session.subscribe": {
    summary: "stream events for a session from a cursor; replays persisted events then tails live ones",
    input: {
      type: "object",
      required: ["sessionId"],
      properties: { sessionId: { type: "string" }, cursor: { type: "integer", minimum: 0 } },
      additionalProperties: false
    }
  },
  "session.unsubscribe": {
    summary: "stop streaming events for a session",
    input: sessionIdInput
  },
  "session.compact": {
    summary: "compact a session's context",
    input: {
      type: "object",
      required: ["sessionId"],
      properties: { sessionId: { type: "string" }, instructions: { type: "string" } },
      additionalProperties: false
    }
  },
  "session.context": {
    summary: "inspect what the next turn would send to the model",
    input: {
      type: "object",
      required: ["sessionId"],
      properties: { sessionId: { type: "string" }, hypotheticalInput: { type: "string" } },
      additionalProperties: false
    }
  },
  "turn.prompt": {
    summary: "run a turn; events stream while it runs when subscribed",
    input: {
      type: "object",
      required: ["sessionId", "text"],
      properties: { sessionId: { type: "string" }, text: { type: "string" } },
      additionalProperties: false
    }
  },
  "turn.cancel": {
    summary: "cancel the running turn of a session without ending the process",
    input: {
      type: "object",
      required: ["sessionId"],
      properties: { sessionId: { type: "string" }, reason: { type: "string" } },
      additionalProperties: false
    }
  },
  "turn.steer": {
    summary: "inject steering text into a running turn",
    input: {
      type: "object",
      required: ["sessionId", "text"],
      properties: { sessionId: { type: "string" }, text: { type: "string" } },
      additionalProperties: false
    }
  },
  "userInput.pending": {
    summary: "return the pending user question for a session, if any",
    input: sessionIdInput
  },
  "userInput.answer": {
    summary: "answer the pending user question",
    input: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" },
        text: { type: "string" },
        answers: { type: "object", additionalProperties: { type: "string" } }
      },
      additionalProperties: false
    }
  },
  "userInput.cancel": {
    summary: "cancel the pending user question",
    input: sessionIdInput
  },
  "container.status": {
    summary: "report the container environment status for a session",
    input: sessionIdInput
  },
  "container.start": {
    summary: "start the container environment for a session",
    input: sessionIdInput
  },
  "container.stop": {
    summary: "stop the container environment for a session",
    input: sessionIdInput
  },
  "report.export": {
    summary: "render the session report as markdown, optionally writing it to disk",
    input: {
      type: "object",
      required: ["sessionId"],
      properties: { sessionId: { type: "string" }, write: { type: "boolean" } },
      additionalProperties: false
    }
  },
  "agent.threads": {
    summary: "list agent threads owned by a session",
    input: sessionIdInput
  }
} as const satisfies Record<string, OperationSpec>;

export type OperationName = keyof typeof OPERATIONS;

export function isOperationName(value: string): value is OperationName {
  return Object.hasOwn(OPERATIONS, value);
}

export const EVENT_PAYLOADS: Record<string, Record<string, unknown>> = {
  text: {
    type: "object",
    required: ["text"],
    properties: {
      role: { type: "string", enum: ["user", "assistant"], description: "user marks the prompt the user sent, not model output" },
      text: { type: "string" }
    }
  },
  reasoning_summary: {
    type: "object",
    required: ["rationale"],
    properties: { planner: { type: "string" }, rationale: { type: "string" } }
  },
  control: {
    type: "object",
    required: ["kind"],
    properties: {
      kind: { type: "string", enum: ["user_input_requested", "user_input_answered", "user_input_cancelled"] },
      request: { type: "object" },
      requestId: { type: "string" },
      answer: { type: "object" }
    }
  },
  tool_call: {
    type: "object",
    properties: { record: { type: "object" } }
  },
  tool_result: {
    type: "object",
    properties: { toolCallId: { type: "string" }, tool: { type: "string" }, result: { type: "string" } }
  }
};

export type ProtocolDescription = {
  protocolVersion: number;
  faraiVersion: string;
  configVersion: number;
  operations: Array<{ name: string; summary: string; input: Record<string, unknown> }>;
  events: Record<string, Record<string, unknown>>;
};
