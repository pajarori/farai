import type { ToolDefinition } from "../../types";
import { assertObject, asString } from "../../utils";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { sessionManager } from "../shared/session-manager";
import { serviceRegistry } from "../services/registry";

export const callbackStopTool: ToolDefinition = {
  name: "callback_stop",
  description: "Stop a host-side TCP listener previously created by callback_listen using its returned service name, such as callback-4444. Use session_stop instead when only a background jobId or processId is available.",
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
