import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { sessionManager } from "../shared/session-manager";
import { serviceRegistry } from "../services/registry";

export const callbackStopTool: ToolDefinition = {
  name: "callback_stop",
  description: "Stop a running callback_listen host listener by service name (e.g. callback-4444).",
  inputSchema: {
    type: "object",
    required: ["name"],
    properties: { name: { type: "string" } }
  },
  mutates: true,
  timeoutMs: 5_000,
  parallel: true,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args) => {
    assertObject(args, "args");
    const name = asString(args.name, "name");
    const status = serviceRegistry.get(name);
    if (!status) return { ok: true, summary: `no running callback listener named ${name}`, output: name };
    await sessionManager.stop(status.sessionId);
    serviceRegistry.unregister(name);
    return { ok: true, summary: `callback listener stopped: ${name}`, output: name, processId: status.sessionId };
  }
};
