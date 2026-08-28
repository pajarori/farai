import type { SessionKind } from "../backends/types";

export type SessionKindProfile = {
  kind: SessionKind;
  looksReady(lastChunk: string): boolean;
  hint(state: { ready: boolean }): string;
};

const SHELL_PROMPT_RE = /[^\r\n]{0,80}[$#>]\s*$/;

const PROFILES: Record<SessionKind, SessionKindProfile> = {
  generic: {
    kind: "generic",
    looksReady: () => true,
    hint: () => ""
  },
  shell: {
    kind: "shell",
    looksReady: (chunk) => SHELL_PROMPT_RE.test(chunk),
    hint: ({ ready }) =>
      ready
        ? "[session: shell, prompt detected] Send one shell command per session_poll call, terminated with \\n."
        : "[session: shell, no prompt detected yet] Command may still be running; poll again before sending new input."
  },
  reverse_shell: {
    kind: "reverse_shell",
    looksReady: (chunk) => SHELL_PROMPT_RE.test(chunk),
    hint: ({ ready }) =>
      ready
        ? "[session: reverse_shell, prompt detected] This is an interactive remote shell. Send one command per call via session_poll(input=...), each terminated with \\n. Avoid commands that themselves expect further interactive input (e.g. another sub-shell) unless you plan to follow up."
        : "[session: reverse_shell, no prompt detected] Target shell may still be initializing, or the previous command is still running. Poll again (optionally with empty input) before sending a new command."
  },
  repl: {
    kind: "repl",
    looksReady: () => true,
    hint: () => "[session: repl] Send one REPL statement per session_poll call."
  },
  ssh: {
    kind: "ssh",
    looksReady: (chunk) => SHELL_PROMPT_RE.test(chunk),
    hint: ({ ready }) =>
      ready
        ? "[session: ssh, prompt detected] Send one remote command per session_poll call, terminated with \\n."
        : "[session: ssh, no prompt detected] Remote command may still be running; poll again before sending new input."
  },
  oast: {
    kind: "oast",
    looksReady: () => true,
    hint: () => "[session: oast] Use session_poll with no input to check for new DNS/HTTP/SMTP/LDAP interactions. Stop it with session_stop when the test is complete."
  }
};

export function profileFor(kind: SessionKind | undefined): SessionKindProfile {
  return PROFILES[kind ?? "generic"];
}
