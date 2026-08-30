import type { McpPromptDescriptor } from "../agent-tools/mcp-adapter";
import type { UserInputAnswer, UserInputRequest } from "../types";

export async function resolveMcpPromptArguments(
  server: string,
  prompt: string,
  descriptor: McpPromptDescriptor,
  positionals: readonly string[],
  request: (input: UserInputRequest) => Promise<UserInputAnswer>
): Promise<Record<string, string>> {
  if (positionals.length > descriptor.arguments.length) {
    throw new Error(`MCP prompt ${server}:${prompt} accepts at most ${descriptor.arguments.length} argument${descriptor.arguments.length === 1 ? "" : "s"}`);
  }
  const args: Record<string, string> = {};
  descriptor.arguments.forEach((argument, index) => {
    const value = positionals[index]?.trim();
    if (value) args[argument.name] = value;
  });
  const missing = descriptor.arguments
    .map((argument, index) => ({ argument, index }))
    .filter(({ argument }) => argument.required && !args[argument.name]);
  if (!missing.length) return args;
  const answer = await request({
    questions: missing.map(({ argument, index }) => ({
      id: `mcp_arg_${index + 1}`,
      header: argument.name.slice(0, 64),
      question: argument.description?.trim() || `enter ${argument.name} for ${server}:${prompt}`
    }))
  });
  for (const { argument, index } of missing) args[argument.name] = answer.answers[`mcp_arg_${index + 1}`]!;
  return args;
}
