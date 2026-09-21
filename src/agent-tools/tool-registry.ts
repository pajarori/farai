import type { Session, ToolContext, ToolDefinition, ToolProvenance, ToolResult } from "../types";
import { assertCanonicalToolName, canonicalToolName } from "../tool-names";

export type ToolName = string;

export type ToolSpec = Readonly<{
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  facadeOperations?: Readonly<Record<string, string>>;
  outputSchema: Record<string, unknown>;
  provenance: ToolProvenance;
  mutates: boolean;
  timeoutMs: number;
  parallel: boolean;
  concurrencyScope?: ToolDefinition["concurrencyScope"];
  visibility?: ToolDefinition["visibility"];
}>;

export type ToolRegistration = Readonly<{
  spec: ToolSpec;
  run: (args: unknown, context: ToolContext) => Promise<ToolResult>;
  renderHuman: ToolDefinition["renderHuman"];
  renderModel: ToolDefinition["renderModel"];
}>;

export type ToolPlan = Readonly<{
  tools: readonly ToolName[];
  overlays?: readonly ToolRegistration[];
}>;

export type ToolSearchQuery = Readonly<{
  text: string;
  limit?: number;
}>;

export function toolSpec(tool: ToolDefinition): ToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.facadeOperations ? { facadeOperations: tool.facadeOperations } : {}),
    outputSchema: tool.outputSchema ?? defaultOutputSchema(),
    provenance: tool.provenance ?? defaultToolProvenance(tool.name),
    mutates: tool.mutates,
    timeoutMs: tool.timeoutMs,
    parallel: tool.parallel,
    ...(tool.concurrencyScope ? { concurrencyScope: tool.concurrencyScope } : {}),
    ...(tool.visibility ? { visibility: tool.visibility } : {})
  };
}

export function toolRegistration(tool: ToolDefinition): ToolRegistration {
  return {
    spec: toolSpec(tool),
    run: tool.run,
    renderHuman: tool.renderHuman,
    renderModel: tool.renderModel
  };
}

export function toolDefinition(registration: ToolRegistration): ToolDefinition {
  return {
    name: registration.spec.name,
    description: registration.spec.description,
    inputSchema: registration.spec.inputSchema,
    ...(registration.spec.facadeOperations ? { facadeOperations: registration.spec.facadeOperations } : {}),
    outputSchema: registration.spec.outputSchema,
    provenance: registration.spec.provenance,
    mutates: registration.spec.mutates,
    timeoutMs: registration.spec.timeoutMs,
    parallel: registration.spec.parallel,
    ...(registration.spec.concurrencyScope ? { concurrencyScope: registration.spec.concurrencyScope } : {}),
    ...(registration.spec.visibility ? { visibility: registration.spec.visibility } : {}),
    run: registration.run,
    renderHuman: registration.renderHuman,
    renderModel: registration.renderModel
  };
}

function defaultOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      summary: { type: "string" },
      output: { type: "string" },
      status: { type: "string" },
      outputArtifactId: { type: "string" },
      jobId: { type: "string" },
      processId: { type: "string" }
    },
    required: ["ok", "summary"],
    additionalProperties: true
  };
}

function defaultToolProvenance(name: string): ToolProvenance {
  return name.startsWith("mcp__") ? { source: "mcp" } : { source: "builtin", provider: "farai" };
}

export class ToolRegistry {
  private readonly registrations: ReadonlyMap<ToolName, ToolRegistration>;

  constructor(registrations: Iterable<ToolRegistration> = []) {
    const map = new Map<ToolName, ToolRegistration>();
    for (const registration of registrations) {
      assertCanonicalToolName(registration.spec.name);
      if (map.has(registration.spec.name)) throw new Error(`Duplicate tool name: ${registration.spec.name}`);
      map.set(registration.spec.name, registration);
    }
    this.registrations = map;
  }

  register(registration: ToolRegistration): ToolRegistry {
    assertCanonicalToolName(registration.spec.name);
    if (this.registrations.has(registration.spec.name)) throw new Error(`Tool already registered: ${registration.spec.name}`);
    return new ToolRegistry([...this.registrations.values(), registration]);
  }

  unregister(name: ToolName): ToolRegistry {
    const canonical = canonicalToolName(name);
    return new ToolRegistry([...this.registrations].filter(([key]) => key !== canonical).map(([, value]) => value));
  }

  get(name: ToolName): ToolRegistration | undefined {
    return this.registrations.get(canonicalToolName(name));
  }

  list(): readonly ToolRegistration[] {
    return [...this.registrations.values()];
  }

  search(query: ToolSearchQuery): readonly ToolSpec[] {
    const text = query.text.trim().toLowerCase();
    const limit = Math.max(1, Math.min(50, query.limit ?? 10));
    return this.list()
      .map((registration) => ({ spec: registration.spec, score: registryScore(registration.spec, text) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.spec.name.localeCompare(right.spec.name))
      .slice(0, limit)
      .map((item) => item.spec);
  }

  plan(tools?: readonly ToolName[], overlays?: readonly ToolRegistration[]): ToolPlan {
    const overlayNames = (overlays ?? []).map((registration) => registration.spec.name);
    const names = tools
      ? [...new Set(tools.map(canonicalToolName))]
      : [...new Set([...this.list().map((registration) => registration.spec.name), ...overlayNames])];
    const visible = new Map<string, ToolRegistration>(this.list().map((registration) => [registration.spec.name, registration]));
    for (const overlay of overlays ?? []) visible.set(overlay.spec.name, overlay);
    return {
      tools: names.filter((name) => visible.has(name)),
      ...(overlays?.length ? { overlays: [...overlays] } : {})
    };
  }
}

function registryScore(spec: ToolSpec, text: string): number {
  if (!text) return 1;
  const name = spec.name.toLowerCase();
  const description = spec.description.toLowerCase();
  if (name === text) return 100;
  if (name.startsWith(text)) return 80;
  if (name.includes(text)) return 60;
  if (description.includes(text)) return 30;
  return text.split(/\s+/).every((term) => name.includes(term) || description.includes(term)) ? 20 : 0;
}

export class ToolRuntime {
  readonly router: ToolRouter;

  constructor(readonly registry: ToolRegistry) {
    this.router = new ToolRouter(registry);
  }

  async execute(name: ToolName, args: unknown, context: ToolContext, plan?: ToolPlan): Promise<ToolResult> {
    return this.router.execute(name, args, context, plan);
  }
}

export class ToolRouter {
  constructor(readonly registry: ToolRegistry) {}

  resolve(name: ToolName, plan?: ToolPlan): ToolRegistration | undefined {
    const canonical = canonicalToolName(name);
    const overlay = plan?.overlays?.find((registration) => registration.spec.name === canonical);
    if (overlay) return overlay;
    if (plan && !plan.tools.includes(canonical)) return undefined;
    return this.registry.get(canonical);
  }

  async execute(name: ToolName, args: unknown, context: ToolContext, plan?: ToolPlan): Promise<ToolResult> {
    const registration = this.resolve(name, plan);
    if (!registration) throw new Error(`Tool is not available: ${canonicalToolName(name)}`);
    return registration.run(args, context);
  }

  planForSession(session: Session, overlays: readonly ToolRegistration[] = []): ToolPlan {
    const scope = session.toolScope?.length ? session.toolScope.map(canonicalToolName) : undefined;
    return this.registry.plan(scope, overlays);
  }
}
