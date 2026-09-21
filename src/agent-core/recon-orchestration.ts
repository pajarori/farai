type ReconAction = {
  tool: string;
  args: unknown;
};

type ReconObservation = {
  tool: string;
  metadata: Record<string, unknown>;
};

const RECON_STAGES: Record<string, number> = {
  asset_subdomains: 0,
  dns_resolve: 1,
  service_probe: 2,
  tls_inspect: 2,
  network_scan: 2
};

export function reconExecutionStage(tool: string): number {
  return RECON_STAGES[tool] ?? 0;
}

export function reconExecutionWaves<T extends ReconAction>(actions: T[]): T[][] {
  const stages = new Map<number, T[]>();
  for (const action of actions) {
    const stage = reconExecutionStage(action.tool);
    const wave = stages.get(stage) ?? [];
    wave.push(action);
    stages.set(stage, wave);
  }
  return [...stages.entries()].sort(([left], [right]) => left - right).map(([, wave]) => wave);
}

export function hydrateReconAction<T extends ReconAction>(action: T, observations: ReconObservation[]): T {
  if (!action.args || typeof action.args !== "object" || Array.isArray(action.args)) return action;
  const args = action.args as Record<string, unknown>;
  if (action.tool === "dns_resolve") {
    const discovered = observationStrings(observations, "asset_subdomains", "discoveredSubdomains");
    const current = stringValues(args.names);
    if (discovered.length > 0 && current.length <= 1) return { ...action, args: { ...args, names: uniqueStrings([...current, ...discovered]) } };
  }
  if (action.tool === "service_probe" || action.tool === "tls_inspect") {
    const resolved = resolvedDnsNames(observations);
    const current = stringValues(args.targets);
    if (resolved.length > 0 && current.length <= 1) return { ...action, args: { ...args, targets: uniqueStrings([...current, ...resolved]) } };
  }
  return action;
}

function observationStrings(observations: ReconObservation[], tool: string, field: string): string[] {
  return uniqueStrings(observations.flatMap((observation) => {
    if (observation.tool !== tool) return [];
    return stringValues(observation.metadata[field]);
  }));
}

function resolvedDnsNames(observations: ReconObservation[]): string[] {
  return uniqueStrings(observations.flatMap((observation) => {
    if (observation.tool !== "dns_resolve") return [];
    const records = Array.isArray(observation.metadata.records) ? observation.metadata.records : [];
    return records.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const record = value as Record<string, unknown>;
      return record.status === "resolved" && record.wildcard !== true && typeof record.name === "string" ? [record.name] : [];
    });
  }));
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim()] : []);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
