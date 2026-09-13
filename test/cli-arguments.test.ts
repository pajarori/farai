import { describe, expect, test } from "bun:test";
import {
  parseBenchmarkArguments,
  parseEvalArguments,
  parseInitArguments,
  parseModelArguments,
  parseNoArguments,
  parseResumeArguments,
  parseRunArguments,
  parseSetupArguments,
  parseUpdateArguments
} from "../src/cli/command-arguments";

describe("cli argument parsing", () => {
  test("run separates harness options from prompt text", () => {
    expect(parseRunArguments(["scan", "the", "target", "--session", "session-1", "--json"])).toEqual({
      sessionId: "session-1",
      text: "scan the target",
      json: true
    });
    expect(parseRunArguments(["--", "--literal", "value"])).toEqual({ text: "--literal value", json: false });
    expect(() => parseRunArguments(["prompt", "--text", "other"])).toThrow("either positional arguments or --text");
    expect(() => parseRunArguments(["prompt", "--unknown"])).toThrow("unknown option");
  });

  test("setup accepts only documented options and keeps secrets out of argv", () => {
    expect(parseSetupArguments(["--model", "openai:gpt-5", "--no-kb", "--api-key-stdin"])).toEqual({
      skipKnowledge: true,
      model: "openai:gpt-5",
      apiKeyStdin: true
    });
    expect(() => parseSetupArguments(["extra"])).toThrow("unexpected argument");
    expect(() => parseSetupArguments(["--api-key", "argv-secret"])).toThrow("--api-key is not supported");
    expect(() => parseSetupArguments(["--api-key-env", "KEY", "--api-key-stdin"])).toThrow("choose one api key source");
    expect(() => parseSetupArguments(["--api-key-stdin"])).toThrow("require --model");
    expect(() => parseSetupArguments(["--no-kb", "--no-knowledge"])).toThrow("is an alias");
    expect(() => parseSetupArguments(["--model", "secure/model", "--api-key-env", "literal.secret"])).toThrow("valid variable name");
    expect(() => parseSetupArguments(["--model", "secure/model", "--base-url", "https://user:secret@example.com/v1"])).toThrow("must not be embedded");
  });

  test("model commands are explicit, strict, and validate token limits", () => {
    expect(parseModelArguments([])).toEqual({ kind: "list" });
    expect(parseModelArguments(["path"])).toEqual({ kind: "path" });
    expect(parseModelArguments(["add", "Secure/Model", "--context-window", "100000", "--project"])).toEqual({
      kind: "add",
      provider: "secure",
      model: "Model",
      apiKeyStdin: false,
      contextWindow: 100000,
      setDefault: false,
      project: true
    });
    expect(() => parseModelArguments(["remove"])).toThrow("unknown model command");
    expect(() => parseModelArguments(["add", "secure/model", "--context-window", "1.5"])).toThrow("positive integer");
    expect(() => parseModelArguments(["add", "secure/model", "--project", "--project"])).toThrow("only be specified once");
  });

  test("resume and init reject ambiguous or excess input", () => {
    expect(parseResumeArguments(["session-1"])).toBe("session-1");
    expect(parseResumeArguments(["--session", "session-2"])).toBe("session-2");
    expect(() => parseResumeArguments(["session-1", "--session", "session-2"])).toThrow("not both");
    expect(parseInitArguments(["--name", "lab", "--target", "example.com"])).toEqual({ name: "lab", target: "example.com" });
    expect(() => parseInitArguments(["extra"])).toThrow("unexpected argument");
  });

  test("benchmark inputs have one unambiguous source", () => {
    expect(parseBenchmarkArguments(["run", "manifest.json", "--artifacts", "artifacts"])).toEqual({
      kind: "run",
      manifestPath: "manifest.json",
      artifactsDir: "artifacts",
      stream: false
    });
    expect(parseBenchmarkArguments(["csi", "generate", "--config", "campaign.json", "--materials", ".", "--output", "suite.json"])).toEqual({
      kind: "csi-generate",
      configPath: "campaign.json",
      materialRoot: ".",
      output: "suite.json"
    });
    expect(() => parseBenchmarkArguments(["run", "one.json", "--manifest", "two.json"])).toThrow("not both");
    expect(() => parseBenchmarkArguments(["suite", "suite.json", "extra"])).toThrow("unexpected argument");
  });

  test("eval inputs are explicit and keep suite selection unambiguous", () => {
    expect(parseEvalArguments([])).toEqual({ stream: false, keepWorkspaces: false });
    expect(parseEvalArguments(["suite.json", "--output", "result.json", "--stream", "--keep-workspaces"])).toEqual({
      suitePath: "suite.json",
      output: "result.json",
      stream: true,
      keepWorkspaces: true
    });
    expect(() => parseEvalArguments(["one.json", "--suite", "two.json"])).toThrow("not both");
    expect(() => parseEvalArguments(["one.json", "extra.json"])).toThrow("unexpected argument");
  });

  test("argument-free commands reject accidental input", () => {
    expect(parseNoArguments("doctor", [])).toBeUndefined();
    expect(() => parseNoArguments("doctor", ["extra"])).toThrow("does not accept arguments");
  });

  test("content update commands default to status and remain explicit", () => {
    expect(parseUpdateArguments([])).toEqual({ kind: "status" });
    expect(parseUpdateArguments(["apply"])).toEqual({ kind: "apply" });
    expect(() => parseUpdateArguments(["apply", "extra"])).toThrow("does not accept arguments");
    expect(() => parseUpdateArguments(["auto"])).toThrow("unknown update command");
  });
});
