import type { ToolDefinition, ToolResult } from "../types";
import { assertObject, asString } from "../utils";
import { validateToolArgs } from "../agent-core/tool-input-validation";

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
  const fields: Record<string, Record<string, unknown>> = {};
  for (const operation of operations) {
    for (const [field, schema] of Object.entries(delegateProperties(delegates[operation]?.inputSchema))) {
      fields[field] = field in fields ? mergeFieldSchema(fields[field]!, schema) : schema;
    }
  }
  const inputSchema = {
    type: "object",
    required: ["operation"],
    additionalProperties: false,
    properties: {
      operation: {
        type: "string",
        enum: operations,
        description: `select one operation, then pass that operation's fields directly (flat, alongside operation). fields by operation: ${operations.map((operation) => `${operation}(${operationFields(delegates[operation]?.inputSchema)})`).join(", ")}`
      },
      ...fields,
      args: { type: "object", description: "optional: the selected operation's fields as a nested object, instead of passing them flat" }
    }
  } as Record<string, unknown>;
  return {
    name,
    description,
    inputSchema,
    facadeOperations: Object.fromEntries(Object.entries(delegates).map(([operation, delegate]) => [operation, delegate.name])),
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
      const invalid = validateToolArgs(delegate.inputSchema, args);
      if (invalid) throw new Error(`invalid arguments for ${name} operation "${operation}": ${invalid}. Re-issue the call with corrected arguments.`);
      return delegate.run(args, context);
    }
  };
}

function delegateProperties(schema: Record<string, unknown> | undefined): Record<string, Record<string, unknown>> {
  if (!schema || typeof schema !== "object") return {};
  const collected: Record<string, Record<string, unknown>> = {};
  const properties = schema.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    for (const [field, value] of Object.entries(properties as Record<string, unknown>)) {
      if (value && typeof value === "object" && !Array.isArray(value)) collected[field] = collected[field] ? mergeFieldSchema(collected[field]!, value as Record<string, unknown>) : (value as Record<string, unknown>);
    }
  }
  for (const key of ["oneOf", "anyOf", "allOf"]) {
    const branches = schema[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      for (const [field, value] of Object.entries(delegateProperties(branch as Record<string, unknown>))) {
        collected[field] = collected[field] ? mergeFieldSchema(collected[field]!, value) : value;
      }
    }
  }
  return collected;
}

function schemaBranches(schema: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(schema.oneOf)) return (schema.oneOf as Record<string, unknown>[]).flatMap(schemaBranches);
  if (Array.isArray(schema.anyOf)) return (schema.anyOf as Record<string, unknown>[]).flatMap(schemaBranches);
  return [schema];
}

function simplifyBranch(branch: Record<string, unknown>): Record<string, unknown> {
  const type = typeof branch.type === "string" ? branch.type : undefined;
  if (!type) return {};
  const simplified: Record<string, unknown> = { type };
  if (Array.isArray(branch.enum)) simplified.enum = branch.enum;
  if (type === "array" && branch.items && typeof branch.items === "object" && !Array.isArray(branch.items)) {
    const itemBranches = dedupeBranches(schemaBranches(branch.items as Record<string, unknown>).map(simplifyBranch).filter((item) => Object.keys(item).length > 0));
    if (itemBranches.length === 1) simplified.items = itemBranches[0];
    else if (itemBranches.length > 1) simplified.items = { oneOf: itemBranches };
  }
  return simplified;
}

function canonicalKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalKey).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${key}:${canonicalKey(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function dedupeBranches(branches: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Map<string, Record<string, unknown>>();
  for (const branch of branches) {
    const key = canonicalKey(branch);
    if (!seen.has(key)) seen.set(key, branch);
  }
  return [...seen.values()];
}

function mergeFieldSchema(existing: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  if (JSON.stringify(existing) === JSON.stringify(incoming)) return existing;
  const branches = dedupeBranches([...schemaBranches(existing), ...schemaBranches(incoming)].map(simplifyBranch).filter((branch) => Object.keys(branch).length > 0));
  const description = typeof existing.description === "string" ? existing.description : typeof incoming.description === "string" ? incoming.description : undefined;
  if (branches.length === 0) return description ? { description } : {};
  if (branches.length === 1) return description ? { ...branches[0], description } : branches[0]!;
  return description ? { oneOf: branches, description } : { oneOf: branches };
}

function operationFields(schema: Record<string, unknown> | undefined): string {
  const properties = delegateProperties(schema);
  const names = Object.keys(properties);
  if (!names.length) return "no fields";
  const required = new Set(Array.isArray(schema?.required) ? schema!.required.map(String) : []);
  return names.map((field) => {
    const spec = properties[field];
    const values = spec && Array.isArray(spec.enum) ? `=${(spec.enum as unknown[]).map(String).join("|")}` : "";
    return `${field}${required.has(field) ? "*" : ""}${values}`;
  }).join(", ");
}

function facadeArguments(input: Record<string, unknown>): Record<string, unknown> {
  const { operation: _operation, args, ...flat } = input;
  if (args && typeof args === "object" && !Array.isArray(args)) return { ...flat, ...(args as Record<string, unknown>) };
  return flat;
}
