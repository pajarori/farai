import type { ToolDefinition, ToolResult } from "../types";
import { assertObject, asString } from "../utils";

type DelegateMap = Record<string, ToolDefinition>;
type FacadeOptions = { mutates?: boolean; visibility?: ToolDefinition["visibility"] };

function render(result: ToolResult): string {
  return result.output ?? result.summary;
}

export function facadeDelegates(tools: readonly ToolDefinition[], prefix: RegExp): DelegateMap {
  return Object.fromEntries(tools.map((tool) => [tool.name.replace(prefix, ""), tool]));
}

export function facadeTool(name: string, description: string, delegates: DelegateMap, options: FacadeOptions = {}): ToolDefinition {
  const operations = Object.keys(delegates);
  const inputSchema = {
    type: "object",
    required: ["operation", "args"],
    properties: {
      operation: {
        type: "string",
        enum: operations,
        description: `select one operation: ${operations.join(", ")}. Required args by operation: ${operations.map((operation) => `${operation}(${requiredFields(delegates[operation]?.inputSchema)})`).join(", ")}`
      },
      args: {
        type: "object",
        description: "operation-specific arguments; see the selected operation shape"
      }
    },
    additionalProperties: false,
    oneOf: operations.map((operation) => ({
      type: "object",
      description: delegates[operation]?.description,
      required: ["operation", "args"],
      properties: {
        operation: { const: operation },
        args: delegates[operation]?.inputSchema ?? { type: "object" }
      },
      additionalProperties: false
    }))
  } as Record<string, unknown>;
  return {
    name,
    description,
    inputSchema,
    mutates: options.mutates ?? true,
    timeoutMs: Math.max(...Object.values(delegates).map((tool) => tool.timeoutMs)),
    parallel: Object.values(delegates).every((tool) => tool.parallel),
    ...(options.visibility ? { visibility: options.visibility } : {}),
    renderHuman: render,
    renderModel: render,
    run: async (input, context) => {
      assertObject(input, "args");
      const operation = asString(input.operation, "operation");
      const delegate = delegates[operation];
      if (!delegate) throw new Error(`unsupported ${name} operation: ${operation}; use one of: ${operations.join(", ")}`);
      const args = facadeArguments(input);
      return delegate.run(args, context);
    }
  };
}

function requiredFields(schema: Record<string, unknown> | undefined): string {
  if (!schema) return "none";
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  if (required.length) return required.join(", ");
  if (!Array.isArray(schema.oneOf)) return "none";
  const variants = schema.oneOf
    .filter((branch): branch is Record<string, unknown> => Boolean(branch) && typeof branch === "object" && !Array.isArray(branch))
    .map((branch) => Array.isArray(branch.required) ? branch.required.map(String).join(", ") : "none");
  return variants.length ? variants.join(" or ") : "none";
}

function facadeArguments(input: Record<string, unknown>): Record<string, unknown> {
  if (input.args && typeof input.args === "object" && !Array.isArray(input.args)) return input.args as Record<string, unknown>;
  return Object.fromEntries(Object.entries(input).filter(([key]) => key !== "operation"));
}
