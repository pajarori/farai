import type { ToolDefinition } from "../../types";
import { assertObject } from "../../utils";
import { backend } from "../shared/backend";
import { backgroundToolResult, withSessionHint } from "../shared/background-result";
import { clampYieldMs, sessionManager } from "../shared/session-manager";
import { defaultHumanRenderer, defaultModelRenderer } from "../shared/renderers";
import { serviceRegistry } from "../services/registry";

const PUBLIC_SERVERS = "oast.pro,oast.live,oast.site,oast.online,oast.fun,oast.me";

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function payloadFrom(value: string): string | undefined {
  return value.match(/[a-z0-9]{3,}\.(?:oast\.pro|oast\.live|oast\.site|oast\.online|oast\.fun|oast\.me)/i)?.[0];
}

export const callbackOastTool: ToolDefinition = {
  name: "callback_oast",
  description: "Start a public Interactsh out-of-band session and return unique callback domains for authorized blind SSRF, XXE, command-injection, or similar interaction tests. Trigger the payload on the target, then poll the returned process with session_poll for DNS or HTTP interactions.",
  inputSchema: { type: "object", properties: { yieldMs: { type: "number" } } },
  mutates: true,
  timeoutMs: 15_000,
  parallel: false,
  renderHuman: defaultHumanRenderer,
  renderModel: defaultModelRenderer,
  run: async (args, context) => {
    assertObject(args, "args");
    const dir = `/tmp/farai-oast-${context.toolCallId ?? context.session.id}`;
    const sessionFile = `${dir}/session.json`;
    const payloadFile = `${dir}/payload.txt`;
    const command = [
      `mkdir -p ${shQuote(dir)}`,
      `exec interactsh-client -server ${shQuote(PUBLIC_SERVERS)} -json -disable-update-check -session-file ${shQuote(sessionFile)} -payload-store -payload-store-file ${shQuote(payloadFile)}`
    ].join(" && ");
    const started = await sessionManager.start(backend(context), "callback_oast", command, clampYieldMs(args.yieldMs ?? 1_000), context.signal, { kind: "oast", pty: false });
    const serviceName = `oast-${started.sessionId}`;
    serviceRegistry.register({
      name: serviceName,
      kind: "oast",
      sessionId: started.sessionId,
      startedAt: Date.now(),
      detail: "public Interactsh session",
      metadata: { servers: PUBLIC_SERVERS.split(",") }
    });

    let payload = payloadFrom(started.output);
    if (!payload) {
      const payloadResult = await backend(context).exec(`for i in $(seq 1 10); do test -s ${shQuote(payloadFile)} && cat ${shQuote(payloadFile)} && exit 0; sleep 0.2; done`);
      payload = payloadFrom(payloadResult.stdout);
    }
    const base = backgroundToolResult("callback_oast", started, "oast");
    const output = [payload ? `payload: ${payload}` : "payload is still being generated; poll the session once", base.output ?? ""].filter(Boolean).join("\n\n");
    return {
      ...base,
      output: withSessionHint("oast", output),
      metadata: { ...(base.metadata ?? {}), payload: payload ?? null, servers: PUBLIC_SERVERS.split(",") }
    };
  }
};
