import type { ToolDefinition } from "../../types";
import { assertObject } from "../../utils";
import { HostProcessBackend } from "../backends/host-process";
import { backgroundToolResult } from "../shared/background-result";
import { clampYieldMs, sessionManager } from "../shared/session-manager";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { serviceRegistry } from "../services/registry";

function asPort(value: unknown): number {
  const port = typeof value === "number" ? value : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`port must be an integer between 1 and 65535, got: ${JSON.stringify(value)}`);
  }
  return port;
}

export const callbackListenTool: ToolDefinition = {
  name: "callback_listen",
  description:
    "Start a raw TCP listener on the HOST machine (not the Kali container) using nc -l <port> — for receiving reverse shells/callbacks when the lab/CTF VPN runs on the host. Call callback_host_info first to pick a real reachable LHOST. Returns a processId pollable with session_poll (send commands via its input once a shell connects) and stoppable with callback_stop or session_stop.",
  inputSchema: {
    type: "object",
    required: ["port"],
    properties: { port: { type: "number" }, yieldMs: { type: "number" } }
  },
  mutates: true,
  timeoutMs: 10_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const port = asPort(args.port);
    const backend = new HostProcessBackend(context.workspace);
    const started = await sessionManager.start(backend, "callback_listen", `nc -l ${port}`, clampYieldMs(args.yieldMs), context.signal, {
      kind: "reverse_shell",
      pty: true
    });
    serviceRegistry.register({ name: `callback-${port}`, kind: "callback", sessionId: started.sessionId, startedAt: Date.now(), detail: `port ${port}` });
    return backgroundToolResult("callback_listen", started, "reverse_shell");
  }
};
