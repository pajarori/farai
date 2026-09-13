import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createPlannerForSession, HeuristicPlanner, OpenAICompatiblePlanner } from "../src/agent-core/provider";
import { AgentRuntime } from "../src/agent-core/runtime";
import { registerTool, unregisterTool } from "../src/agent-tools/registry";
import type { ChatProvider, ChatRequest } from "../src/agent-core/provider/protocol";
import { debugLogPath } from "../src/agent-core/global-config";
import { buildSystemPrompt } from "../src/agent-core/provider/system-prompt";
import type { Session, ToolDefinition } from "../src/types";
import { loadToolAttachmentBytes } from "../src/tool-attachment";
import { logDebugEntry } from "../src/agent-core/provider/http";

test("runtime preserves tool image attachments into the next provider request", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "farai-provider-image-"));
  const requests: ChatRequest[] = [];
  const provider: ChatProvider = {
    name: "attachment-capture",
    protocol: "openai-chat",
    async *stream(request) {
      requests.push({ ...request, messages: structuredClone(request.messages) });
      if (requests.length === 1) {
        yield { type: "tool_call_complete", index: 0, id: "image-call", name: "test_image_attachment_delivery", arguments: "{}" };
        yield { type: "message_complete", finishReason: "tool_calls" };
        return;
      }
      yield { type: "text_delta", delta: "image received" };
      yield { type: "message_complete", finishReason: "stop" };
    }
  };
  const tool: ToolDefinition = {
    name: "test_image_attachment_delivery",
    description: "returns a test image",
    inputSchema: { type: "object", additionalProperties: false },
    mutates: false,
    timeoutMs: 5_000,
    parallel: true,
    renderHuman: (result) => result.output ?? result.summary,
    renderModel: (result) => result.output ?? result.summary,
    run: async () => ({
      ok: true,
      summary: "image attached",
      output: "inspect this image",
      attachments: [{
        kind: "image",
        mediaType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        detail: "high"
      }]
    })
  };
  registerTool(tool);
  const runtime = new AgentRuntime(workspace, provider, {
    enableKnowledge: false,
    enableHooks: false,
    enableMcp: false,
    enableSkills: false,
    enableProjectInstructions: false
  });
  try {
    const session = await runtime.createSession();
    const scoped = runtime.updateSession(session.id, { toolScope: [tool.name] });
    await runtime.prompt(scoped, "inspect the generated image");
    const toolMessage = requests[1]?.messages.find((entry) => entry.role === "tool");
    expect(toolMessage).toMatchObject({ role: "tool", name: "test_image_attachment_delivery" });
    if (toolMessage?.role !== "tool") throw new Error("tool message missing");
    const attachment = toolMessage.attachments?.[0];
    expect(attachment).toMatchObject({ kind: "image", mediaType: "image/png", detail: "high" });
    expect(attachment?.data).toBeUndefined();
    expect(attachment?.path).toBeString();
    expect(attachment?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(attachment!.path!)).toBe(true);
    expect(loadToolAttachmentBytes(attachment!).toString("base64")).toBe("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=");
    const durable = JSON.stringify({
      messages: runtime.store.listMessages(session.id, 100),
      events: runtime.store.listEvents(session.id, 100)
    });
    expect(durable).not.toContain("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwC");
  } finally {
    await runtime.shutdown();
    unregisterTool(tool);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("runtime rejects malformed tool attachments before persistence or provider delivery", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "farai-provider-invalid-image-"));
  const tool: ToolDefinition = {
    name: "test_invalid_image_attachment",
    description: "returns an invalid test image",
    inputSchema: { type: "object", additionalProperties: false },
    mutates: false,
    timeoutMs: 5_000,
    parallel: true,
    renderHuman: (result) => result.output ?? result.summary,
    renderModel: (result) => result.output ?? result.summary,
    run: async () => ({
      ok: true,
      summary: "invalid image",
      attachments: [{ kind: "image", mediaType: "image/png", data: Buffer.from("not a png").toString("base64") }]
    })
  };
  registerTool(tool);
  const runtime = new AgentRuntime(workspace, undefined, {
    enableKnowledge: false,
    enableHooks: false,
    enableMcp: false,
    enableSkills: false,
    enableProjectInstructions: false
  });
  try {
    const session = runtime.updateSession((await runtime.createSession()).id, { toolScope: [tool.name] });
    const call = await runtime.runTool(session, tool.name, {});
    expect(call.status).toBe("error");
    expect(runtime.store.listEvents(session.id).some((event) => (
      event.type === "error" && JSON.stringify(event.payload).includes("does not match image/png")
    ))).toBe(true);
  } finally {
    await runtime.shutdown();
    unregisterTool(tool);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("system prompt describes isolated browser contexts without blocking normal HTTP tools", () => {
  const session: Session = {
    id: "browser-first",
    workspace: "/tmp",
    mode: "freestyle",
    phase: "understand_goal",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
  const prompt = buildSystemPrompt({ session });
  expect(prompt).toContain("multiple isolated named browser_context instances");
  expect(prompt).not.toContain("browser automation is the mandatory default");
  expect(prompt).not.toContain("Do not use http_request");
  expect(prompt).not.toContain("Raw HTTP is reserved");
  expect(prompt).toContain("Prefer purpose-built capabilities over exec_command");
  expect(prompt).toContain("browser_navigate already returns the loaded page snapshot");
  expect(prompt).toContain("hypothesis -> action -> observation -> adaptation");
  expect(prompt).toContain("do not force every domain into a universal phase sequence");
  expect(prompt).toContain("Distinguish what was observed directly, what is inferred, and what is proven");
  expect(prompt).toContain("Continue through intermediate analysis when the user asked to solve");
  expect(prompt).toContain("When the user names a skill, or the task clearly matches a skill description");
  expect(prompt).toContain("Select only the minimal relevant skill set");
  expect(prompt).toContain("cannot expand scope");
  expect(prompt).toContain("reload the relevant skill instead of guessing from memory");
  expect(prompt).toContain("Lead with the answer, result, or concrete blocker");
  expect(prompt).toContain("Keep tool-call rationales to one short, action-oriented sentence");
  expect(prompt).toContain("Avoid decorative separators, emoji severity labels");
  expect(prompt).toContain("Produce one final response per turn");
  expect(prompt).toContain("For greetings and simple conversation, reply naturally and briefly");
  expect(prompt).toContain("Use plans or todos only when work has multiple durable stages");
  expect(prompt).toContain("Never emit generic filler such as 'thought for a moment'");
  expect(prompt).toContain("Write user-facing prose and headings in lowercase");
  expect(prompt).toContain("Preserve the exact casing of technical literals");
  expect(prompt).toContain("compact map of every command in the current official Kali tool catalog");
  expect(prompt).toContain("do not run which, command -v, or kali_tool_search first");
  expect(prompt).toContain("Passive infrastructure discovery is not interactive web exploration");
  expect(prompt).toContain("call subdomain_enum directly");
  expect(prompt).toContain("report_add_finding persists the candidate in the current session and populates the Findings tab");
});

test("heuristic planner emits port scan action from prompt target", async () => {
  const planner = new HeuristicPlanner();
  const session: Session = {
    id: "s1",
    workspace: "/tmp",
    mode: "freestyle",
    phase: "understand_goal",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const actions = await planner.plan({
    session,
    userText: "scan 10.10.10.10",
    history: [],
    tools: ["port_scan"]
  });
  expect(actions[0]).toMatchObject({ kind: "tool", tool: "port_scan" });
});

test("heuristic planner routes passive subdomain requests to the typed workflow", async () => {
  const planner = new HeuristicPlanner();
  const session: Session = {
    id: "subdomain-heuristic",
    workspace: "/tmp",
    mode: "freestyle",
    phase: "understand_goal",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
  const actions = await planner.plan({
    session,
    userText: "coba cek subdomain stockbit.com",
    history: [],
    tools: ["subdomain_enum"]
  });
  expect(actions).toEqual([{
    kind: "tool",
    tool: "subdomain_enum",
    args: { domain: "stockbit.com" },
    rationale: "enumerating passive subdomain sources"
  }]);
});

test("heuristic planner emits directory enum, note, report, and fallback actions", async () => {
  const planner = new HeuristicPlanner();
  const baseSession: Session = {
    id: "s1",
    workspace: "/tmp",
    mode: "freestyle",
    phase: "understand_goal",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };

  await expect(
    planner.plan({ session: baseSession, userText: "run ffuf directory enum on 10.10.10.10", history: [], tools: [] })
  ).resolves.toEqual([
    {
      kind: "tool",
      tool: "dir_enum",
      args: { url: "http://10.10.10.10/FUZZ" },
      rationale: "User requested directory enumeration."
    }
  ]);

  await expect(planner.plan({ session: baseSession, userText: "catat this", history: [], tools: [] })).resolves.toEqual([
    { kind: "tool", tool: "notes_add", args: { text: "catat this", tags: ["user"] }, rationale: "User asked to remember context." }
  ]);

  await expect(planner.plan({ session: baseSession, userText: "make report", history: [], compactedSummary: "summary", tools: [] })).resolves.toEqual([
    { kind: "respond", text: "summary" }
  ]);

  const fallback = await planner.plan({ session: baseSession, userText: "what can you do?", history: [], tools: [] });
  expect(fallback[0]).toMatchObject({ kind: "respond" });
  expect(fallback[0]?.kind === "respond" ? fallback[0].text : "").toContain("Freestyle ready");
});

test("heuristic planner creates todos for multi-step cyber requests and summarizes continuation", async () => {
  const planner = new HeuristicPlanner();
  const session: Session = {
    id: "s1",
    workspace: "/tmp",
    mode: "freestyle",
    phase: "understand_goal",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
  const actions = await planner.plan({ session, userText: "make a recon plan and scan enumerate", history: [], tools: ["todo_add"] });
  expect(actions).toHaveLength(4);
  expect(actions.every((action) => action.kind === "tool" && action.tool === "todo_add")).toBe(true);

  const continued = await planner.plan({
    session,
    history: [
      { role: "assistant", toolCalls: [{ id: "call_1", tool: "shell_exec", args: {} }] },
      { role: "tool", toolCallId: "call_1", tool: "shell_exec", text: "exit=0\neth0: inet 172.17.0.3\nlo: inet 127.0.0.1" }
    ],
    tools: []
  });
  expect(continued).toEqual([{ kind: "respond", text: "shell_exec done. exit=0" }]);
});

test("createPlannerForSession resolves session.model against a configured profile name before treating it as a bare model override", () => {
  const workspace = mkdtempSync(join(tmpdir(), "farai-provider-"));
  mkdirSync(join(workspace, ".farai"), { recursive: true });
  writeFileSync(
    join(workspace, ".farai", "config.toml"),
    '[model_providers.home-model]\nmodel = "fixture-model-a"\nbase_url = "http://home:11434/v1"\n'
  );
  try {
    const session: Session = {
      id: "s1",
      workspace,
      mode: "freestyle",
      phase: "understand_goal",
      model: "home-model",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };
    const planner = createPlannerForSession(session);
    expect(planner).toBeInstanceOf(OpenAICompatiblePlanner);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("createPlannerForSession keeps runtime-root model configuration while a session executes in a worktree", () => {
  const root = mkdtempSync(join(tmpdir(), "farai-provider-root-"));
  const worktree = mkdtempSync(join(tmpdir(), "farai-provider-worktree-"));
  mkdirSync(join(root, ".farai"), { recursive: true });
  writeFileSync(
    join(root, ".farai", "config.toml"),
    '[model_providers.worktree-model]\nmodel = "fixture-model-root"\nbase_url = "http://root:11434/v1"\ncontext_window = 12345\n'
  );
  try {
    const session: Session = {
      id: "s-worktree",
      workspace: worktree,
      mode: "freestyle",
      phase: "understand_goal",
      model: "worktree-model",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };
    const planner = createPlannerForSession(session, root);
    expect(planner).toBeInstanceOf(OpenAICompatiblePlanner);
    expect(planner.contextWindow).toBe(12345);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("createPlannerForSession falls back to a bare model-name override when session.model doesn't match any profile", () => {
  const session: Session = {
    id: "s1",
    workspace: mkdtempSync(join(tmpdir(), "farai-provider-")),
    mode: "freestyle",
    phase: "understand_goal",
    model: "heuristic",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
  try {
    const planner = createPlannerForSession(session);
    expect(planner).toBeInstanceOf(HeuristicPlanner);
  } finally {
    rmSync(session.workspace, { recursive: true, force: true });
  }
});

test("OpenAI-compatible planner keeps internal tasks in the system prompt, not user history", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: any;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "summary" }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  try {
    const planner = new OpenAICompatiblePlanner({ baseUrl: "https://example.test/v1", model: "m" });
    const session: Session = { id: "s1", workspace: "/tmp", mode: "freestyle", phase: "understand_goal", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
    await planner.plan({
      session,
      history: [{ role: "user", text: "real user message" }, { role: "user", text: "[internal compaction request]" }],
      systemInstruction: "create a detailed continuation summary",
      tools: []
    });
    expect(requestBody.messages[0].content).toContain("## Current Internal Task");
    expect(requestBody.messages[0].content).toContain("create a detailed continuation summary");
    expect(requestBody.messages.filter((message: { role: string }) => message.role === "user").map((message: { content: string }) => message.content)).toEqual(["real user message", "[internal compaction request]"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI-compatible planner sends a native tools payload and tool_choice", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: any; authorization?: string | null }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requests.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
      authorization: headers.get("authorization")
    });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok", tool_calls: [] } }]
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const planner = new OpenAICompatiblePlanner({ apiKey: "key", baseUrl: "https://example.test/v1/", model: "model-x" });
    const actions = await planner.plan({
      session: {
        id: "s1",
        workspace: "/tmp",
        mode: "freestyle",
        phase: "understand_goal",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString()
      },
      history: [{ role: "user", text: "hello" }],
      compactedSummary: "Earlier context summary.",
      contextBlocks: [
        { title: "Project Instructions", body: "Follow repo-specific AGENTS.md rules.", stable: true },
        { title: "Durable Session Context", body: "Recent evidence and todos.", stable: false }
      ],
      tools: ["notes_add"]
    });

    expect(actions).toEqual([{ kind: "respond", text: "ok" }]);
    expect(requests[0]?.url).toBe("https://example.test/v1/chat/completions");
    expect(requests[0]?.authorization).toBe("Bearer key");
    expect(requests[0]?.body.model).toBe("model-x");
    expect(requests[0]?.body.tool_choice).toBe("auto");
    expect(requests[0]?.body.tools).toEqual([
      { type: "function", function: { name: "notes_add", description: expect.any(String), parameters: expect.any(Object) } }
    ]);
    expect(requests[0]?.body.messages[0].role).toBe("system");
    const systemContent = requests[0]?.body.messages[0].content as string;
    expect(systemContent).toContain("## Identity");
    expect(systemContent).not.toContain("Earlier context summary.");
    expect(systemContent).toContain("Follow repo-specific AGENTS.md rules.");
    expect(requests[0]?.body.user).toBe("s1");
    expect(systemContent.indexOf("## Operating Model")).toBeLessThan(systemContent.indexOf("Follow repo-specific AGENTS.md rules."));
    expect(systemContent.indexOf("Follow repo-specific AGENTS.md rules.")).toBeLessThan(systemContent.indexOf("Recent evidence and todos."));
    expect(requests[0]?.body.messages[1]).toEqual({ role: "user", content: "hello" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI-compatible planner maps native tool_calls into tool actions", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      choices: [{
        message: {
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "nmap_scan", arguments: JSON.stringify({ target: "localhost", ports: "1-65535" }) } }
          ]
        }
      }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  )) as unknown as typeof fetch;

  try {
    const planner = new OpenAICompatiblePlanner({ baseUrl: "https://example.test/v1", model: "local-model" });
    const session: Session = {
      id: "s1",
      workspace: "/tmp",
      mode: "freestyle",
      phase: "understand_goal",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };
    await expect(planner.plan({ session, userText: "scan", history: [], tools: ["nmap_scan"] })).resolves.toEqual([
      { kind: "tool", tool: "nmap_scan", args: { target: "localhost", ports: "1-65535" }, rationale: "", toolCallId: "call_1" }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI-compatible planner parses Hermes-style <function=...> XML tool calls when tool_calls is empty (local model / chat-template fallback)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      choices: [{
        message: {
          content: "Let me write the exploit script.\n<tool_call>\n<function=nmap_scan>\n<parameter=target>\n10.129.39.18\n</parameter>\n</function>\n</tool_call>",
          tool_calls: []
        },
        finish_reason: "stop"
      }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  )) as unknown as typeof fetch;

  try {
    const planner = new OpenAICompatiblePlanner({ baseUrl: "https://example.test/v1", model: "local-model" });
    const session: Session = {
      id: "s1",
      workspace: "/tmp",
      mode: "freestyle",
      phase: "understand_goal",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };
    await expect(planner.plan({ session, userText: "exploit it", history: [], tools: ["nmap_scan"] })).resolves.toEqual([
      { kind: "respond", text: "Let me write the exploit script." },
      { kind: "tool", tool: "nmap_scan", args: { target: "10.129.39.18" }, rationale: "" }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI-compatible planner parses multiple XML tool calls and tolerates no prefix text", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      choices: [{
        message: {
          content: "<function=notes_add><parameter=text>found it</parameter><parameter=tags>htb</parameter></function><function=todo_add><parameter=text>exploit next</parameter></function>",
          tool_calls: []
        }
      }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  )) as unknown as typeof fetch;

  try {
    const planner = new OpenAICompatiblePlanner({ baseUrl: "https://example.test/v1", model: "local-model" });
    const session: Session = {
      id: "s1",
      workspace: "/tmp",
      mode: "freestyle",
      phase: "understand_goal",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };
    await expect(planner.plan({ session, userText: "go", history: [], tools: ["notes_add", "todo_add"] })).resolves.toEqual([
      { kind: "tool", tool: "notes_add", args: { text: "found it", tags: "htb" }, rationale: "" },
      { kind: "tool", tool: "todo_add", args: { text: "exploit next" }, rationale: "" }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI-compatible planner coerces XML tool-call scalar args to typed values", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      choices: [{
        message: {
          content: "<function=shell_exec><parameter=command>id</parameter><parameter=background>true</parameter><parameter=yieldMs>500</parameter></function>",
          tool_calls: []
        }
      }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  )) as unknown as typeof fetch;

  try {
    const planner = new OpenAICompatiblePlanner({ baseUrl: "https://example.test/v1", model: "local-model" });
    const session: Session = {
      id: "s1",
      workspace: "/tmp",
      mode: "freestyle",
      phase: "understand_goal",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };
    await expect(planner.plan({ session, userText: "run id", history: [], tools: ["shell_exec"] })).resolves.toEqual([
      { kind: "tool", tool: "shell_exec", args: { command: "id", background: true, yieldMs: 500 }, rationale: "" }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI-compatible planner emits both a respond action and tool actions from one message", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      choices: [{
        message: {
          content: "Adding a follow-up todo.",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "todo_add", arguments: JSON.stringify({ text: "Follow up", priority: "medium" }) } }
          ]
        }
      }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  )) as unknown as typeof fetch;

  try {
    const planner = new OpenAICompatiblePlanner({ baseUrl: "https://example.test/v1", model: "local-model" });
    const session: Session = {
      id: "s1",
      workspace: "/tmp",
      mode: "freestyle",
      phase: "understand_goal",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };
    await expect(planner.plan({ session, userText: "plan next step", history: [], tools: ["todo_add"] })).resolves.toEqual([
      { kind: "respond", text: "Adding a follow-up todo." },
      { kind: "tool", tool: "todo_add", args: { text: "Follow up", priority: "medium" }, rationale: "", toolCallId: "call_1" }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI-compatible planner surfaces reasoning as its own action alongside a tool call, not conflated with respond text", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      choices: [{
        message: {
          content: null,
          reasoning: "**Checking exploit conditions**\n\nThe queue name must match LPD_QUEUE before injection works.",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "nmap_scan", arguments: JSON.stringify({ target: "10.10.10.10" }) } }
          ]
        }
      }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  )) as unknown as typeof fetch;

  try {
    const planner = new OpenAICompatiblePlanner({ baseUrl: "https://example.test/v1", model: "local-model" });
    const session: Session = {
      id: "s1",
      workspace: "/tmp",
      mode: "freestyle",
      phase: "understand_goal",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };
    await expect(planner.plan({ session, userText: "exploit it", history: [], tools: ["nmap_scan"] })).resolves.toEqual([
      { kind: "reasoning", text: "**Checking exploit conditions**\n\nThe queue name must match LPD_QUEUE before injection works." },
      { kind: "tool", tool: "nmap_scan", args: { target: "10.10.10.10" }, rationale: "", toolCallId: "call_1" }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI-compatible planner bounds reasoning text so a repetitive/looping model can't grow it unbounded", async () => {
  const originalFetch = globalThis.fetch;
  const hugeReasoning = "x".repeat(20_000);
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      choices: [{ message: { content: "final answer", reasoning: hugeReasoning } }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  )) as unknown as typeof fetch;

  try {
    const planner = new OpenAICompatiblePlanner({ baseUrl: "https://example.test/v1", model: "local-model" });
    const session: Session = {
      id: "s1",
      workspace: "/tmp",
      mode: "freestyle",
      phase: "understand_goal",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };
    const actions = await planner.plan({ session, userText: "go", history: [], tools: [] });
    const reasoning = actions.find((action) => action.kind === "reasoning");
    expect(reasoning?.kind).toBe("reasoning");
    expect(Buffer.byteLength((reasoning as { text: string }).text, "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(actions).toContainEqual({ kind: "respond", text: "final answer" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI-compatible planner emits a tool_parse_error instead of throwing on malformed arguments JSON", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      choices: [{
        message: {
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "notes_add", arguments: "{not valid json" } }
          ]
        }
      }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  )) as unknown as typeof fetch;

  try {
    const planner = new OpenAICompatiblePlanner({ baseUrl: "https://example.test/v1", model: "local-model" });
    const session: Session = {
      id: "s1",
      workspace: "/tmp",
      mode: "freestyle",
      phase: "understand_goal",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };
    const actions = await planner.plan({ session, userText: "note this", history: [], tools: ["notes_add"] });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: "tool_parse_error", tool: "notes_add", toolCallId: "call_1" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI-compatible planner throws a diagnostic error (not a bland fallback) when the model returns no content and no tool_calls", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      choices: [{ message: { content: null }, finish_reason: "stop" }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  )) as unknown as typeof fetch;

  try {
    const planner = new OpenAICompatiblePlanner({ baseUrl: "https://example.test/v1", model: "local-model" });
    const session: Session = {
      id: "s1",
      workspace: "/tmp",
      mode: "freestyle",
      phase: "understand_goal",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };
    await expect(planner.plan({ session, userText: "continue", history: [], tools: [] })).rejects.toThrow(
      /Planner returned empty output.*finish_reason=stop/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI-compatible planner keeps reasoning separate when content is empty and there are no tool_calls", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      choices: [{
        message: { role: "assistant", content: "", reasoning: "Saya sudah menjalankan dua scan NMAP secara bersamaan ke target." },
        finish_reason: "stop"
      }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  )) as unknown as typeof fetch;

  try {
    const planner = new OpenAICompatiblePlanner({ baseUrl: "https://example.test/v1", model: "local-model" });
    const session: Session = {
      id: "s1",
      workspace: "/tmp",
      mode: "freestyle",
      phase: "understand_goal",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };
    await expect(planner.plan({ session, userText: "continue", history: [], tools: [] })).resolves.toEqual([
      { kind: "reasoning", text: "Saya sudah menjalankan dua scan NMAP secara bersamaan ke target." }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI-compatible planner separates embedded thinking tags from visible content", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      choices: [{
        message: { role: "assistant", content: "<think>private chain</think>final answer" },
        finish_reason: "stop"
      }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  )) as unknown as typeof fetch;

  try {
    const planner = new OpenAICompatiblePlanner({ baseUrl: "https://example.test/v1", model: "local-model" });
    const session: Session = {
      id: "s1",
      workspace: "/tmp",
      mode: "freestyle",
      phase: "understand_goal",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };
    await expect(planner.plan({ session, userText: "continue", history: [], tools: [] })).resolves.toEqual([
      { kind: "reasoning", text: "private chain" },
      { kind: "respond", text: "final answer" }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI-compatible planner does not duplicate embedded reasoning actions", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      choices: [{
        message: { role: "assistant", content: "<think>private chain</think>final answer", reasoning: "private chain" },
        finish_reason: "stop"
      }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  )) as unknown as typeof fetch;

  try {
    const planner = new OpenAICompatiblePlanner({ baseUrl: "https://example.test/v1", model: "local-model" });
    const session: Session = {
      id: "s1",
      workspace: "/tmp",
      mode: "freestyle",
      phase: "understand_goal",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };
    await expect(planner.plan({ session, userText: "continue", history: [], tools: [] })).resolves.toEqual([
      { kind: "reasoning", text: "private chain" },
      { kind: "respond", text: "final answer" }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI-compatible planner does not promote duplicated provider reasoning to visible content", async () => {
  const originalFetch = globalThis.fetch;
  const privateText = "I have enough evidence. Let me compile the final report.";
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      choices: [{
        message: { role: "assistant", content: privateText, reasoning: privateText },
        finish_reason: "stop"
      }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  )) as unknown as typeof fetch;

  try {
    const planner = new OpenAICompatiblePlanner({ baseUrl: "https://example.test/v1", model: "local-model" });
    const session: Session = {
      id: "s1",
      workspace: "/tmp",
      mode: "freestyle",
      phase: "understand_goal",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };
    await expect(planner.plan({ session, userText: "continue", history: [], tools: [] })).resolves.toEqual([
      { kind: "reasoning", text: privateText }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI-compatible planner removes a native reasoning prefix echoed into content", async () => {
  const originalFetch = globalThis.fetch;
  const privateText = "I have enough evidence. Let me compile the final report.";
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      choices: [{
        message: { role: "assistant", content: `${privateText}\n\nFinal answer: the endpoint is exposed.`, reasoning: privateText },
        finish_reason: "stop"
      }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  )) as unknown as typeof fetch;

  try {
    const planner = new OpenAICompatiblePlanner({ baseUrl: "https://example.test/v1", model: "local-model" });
    const session: Session = {
      id: "s1",
      workspace: "/tmp",
      mode: "freestyle",
      phase: "understand_goal",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };
    await expect(planner.plan({ session, userText: "continue", history: [], tools: [] })).resolves.toEqual([
      { kind: "reasoning", text: privateText },
      { kind: "respond", text: "Final answer: the endpoint is exposed." }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI-compatible planner treats an unfinished thinking block as private", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      choices: [{
        message: { role: "assistant", content: "<think>private chain cut off" },
        finish_reason: "length"
      }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  )) as unknown as typeof fetch;

  try {
    const planner = new OpenAICompatiblePlanner({ baseUrl: "https://example.test/v1", model: "local-model" });
    const session: Session = {
      id: "s1",
      workspace: "/tmp",
      mode: "freestyle",
      phase: "understand_goal",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };
    await expect(planner.plan({ session, userText: "continue", history: [], tools: [] })).resolves.toEqual([
      { kind: "reasoning", text: "private chain cut off" }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI-compatible planner hides analysis channels and preserves the final channel", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      choices: [{
        message: { content: "<|channel|>analysis<|message|>private chain<|channel|>final<|message|>visible answer<|eot_id|>" },
        finish_reason: "stop"
      }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  )) as unknown as typeof fetch;

  try {
    const planner = new OpenAICompatiblePlanner({ baseUrl: "https://example.test/v1", model: "local-model" });
    const session: Session = {
      id: "s1",
      workspace: "/tmp",
      mode: "freestyle",
      phase: "understand_goal",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };
    await expect(planner.plan({ session, userText: "continue", history: [], tools: [] })).resolves.toEqual([
      { kind: "reasoning", text: "private chain" },
      { kind: "respond", text: "visible answer" }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI-compatible planner does not promote internal narration to a final response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      choices: [{
        message: { content: "The user wants a concise status. Let me inspect the available tools first." },
        finish_reason: "stop"
      }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  )) as unknown as typeof fetch;

  try {
    const planner = new OpenAICompatiblePlanner({ baseUrl: "https://example.test/v1", model: "local-model" });
    const session: Session = {
      id: "s1",
      workspace: "/tmp",
      mode: "freestyle",
      phase: "understand_goal",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };
    await expect(planner.plan({ session, userText: "continue", history: [], tools: [] })).resolves.toEqual([
      { kind: "reasoning", text: "The user wants a concise status. Let me inspect the available tools first." }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI-compatible planner writes the raw request/response to the debug log only when FARAI_DEBUG is enabled", async () => {
  const originalFetch = globalThis.fetch;
  const previousDebug = process.env.FARAI_DEBUG;
  const previousHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "farai-debug-home-"));
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ choices: [{ message: { content: "ok", tool_calls: [] }, finish_reason: "stop" }] }),
    { status: 200, headers: { "content-type": "application/json" } }
  )) as unknown as typeof fetch;

  try {
    process.env.HOME = home;
    const session: Session = {
      id: "s1",
      workspace: "/tmp",
      mode: "freestyle",
      phase: "understand_goal",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    };

    delete process.env.FARAI_DEBUG;
    const plannerOff = new OpenAICompatiblePlanner({ baseUrl: "https://example.test/v1", model: "local-model" });
    await plannerOff.plan({ session, userText: "hi", history: [{ role: "user", text: "hi" }], tools: [] });
    expect(existsSync(debugLogPath())).toBe(false);

    process.env.FARAI_DEBUG = "1";
    const plannerOn = new OpenAICompatiblePlanner({ baseUrl: "https://example.test/v1", model: "local-model" });
    await plannerOn.plan({ session, userText: "hi", history: [{ role: "user", text: "hi" }], tools: [] });
    expect(existsSync(debugLogPath())).toBe(true);
    const lines = readFileSync(debugLogPath(), "utf8").trim().split("\n");
    const entry = JSON.parse(lines.at(-1)!);
    expect(entry.model).toBe("local-model");
    expect(entry.responseStatus).toBe(200);
    expect(JSON.parse(entry.responseText).choices[0].message.content).toBe("ok");
    expect(entry.requestBody.messages.some((m: { role: string }) => m.role === "user")).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousDebug === undefined) delete process.env.FARAI_DEBUG;
    else process.env.FARAI_DEBUG = previousDebug;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("provider debug logging omits encoded images and bounds large values", () => {
  const previousDebug = process.env.FARAI_DEBUG;
  const previousHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "farai-debug-bounds-"));
  try {
    process.env.HOME = home;
    process.env.FARAI_DEBUG = "1";
    logDebugEntry({
      model: "local-model",
      requestBody: { image: { data: "a".repeat(100_000) } },
      responseText: "x".repeat(100_000)
    });
    const raw = readFileSync(debugLogPath(), "utf8");
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThan(256 * 1024);
    const entry = JSON.parse(raw.trim());
    expect(entry.requestBody.image.data).toContain("image payload omitted");
    expect(entry.responseText).toContain("debug value truncated");
  } finally {
    if (previousDebug === undefined) delete process.env.FARAI_DEBUG;
    else process.env.FARAI_DEBUG = previousDebug;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("provider debug logging refuses a symlinked log destination", () => {
  if (process.platform === "win32") return;
  const previousDebug = process.env.FARAI_DEBUG;
  const previousHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "farai-debug-symlink-"));
  const target = join(home, "outside.log");
  try {
    process.env.HOME = home;
    process.env.FARAI_DEBUG = "1";
    mkdirSync(join(home, ".local", "pajarori", "farai"), { recursive: true });
    writeFileSync(target, "unchanged\n");
    symlinkSync(target, debugLogPath());
    logDebugEntry({ model: "local-model", responseText: "sensitive" });
    expect(readFileSync(target, "utf8")).toBe("unchanged\n");
  } finally {
    if (previousDebug === undefined) delete process.env.FARAI_DEBUG;
    else process.env.FARAI_DEBUG = previousDebug;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

function sseResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("OpenAI-compatible planner consumes an SSE stream: emits deltas and assembles text", async () => {
  const originalFetch = globalThis.fetch;
  const deltas: string[] = [];
  globalThis.fetch = (async () => sseResponse([
    JSON.stringify({ choices: [{ delta: { content: "Hello" } }] }),
    JSON.stringify({ choices: [{ delta: { content: ", world" } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })
  ])) as unknown as typeof fetch;
  try {
    const planner = new OpenAICompatiblePlanner({ baseUrl: "https://example.test/v1", model: "m" });
    const session: Session = { id: "s1", workspace: "/tmp", mode: "freestyle", phase: "understand_goal", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
    const actions = await planner.plan({ session, userText: "hi", history: [], tools: [] }, {
      onStreamEvent: (event) => { if (event.kind === "text") deltas.push(event.delta); }
    });
    expect(actions).toEqual([{ kind: "respond", text: "Hello, world" }]);
    expect(deltas).toEqual(["Hello", ", world"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI-compatible planner assembles streamed tool_call fragments by index", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => sseResponse([
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "port_scan", arguments: "{\"tar" } }] } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "get\":\"10.0.0.1\"}" } }] } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })
  ])) as unknown as typeof fetch;
  try {
    const planner = new OpenAICompatiblePlanner({ baseUrl: "https://example.test/v1", model: "m" });
    const session: Session = { id: "s1", workspace: "/tmp", mode: "freestyle", phase: "understand_goal", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
    const actions = await planner.plan({ session, userText: "scan", history: [], tools: ["port_scan"] }, { onStreamEvent: () => {} });
    expect(actions).toEqual([{ kind: "tool", tool: "port_scan", args: { target: "10.0.0.1" }, rationale: "", toolCallId: "call_1" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
