export function mergeMcpHeaders(...sources: Array<Record<string, string> | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const source of sources) {
    for (const [rawName, value] of Object.entries(source ?? {})) {
      const name = rawName.trim();
      if (!name) continue;
      deleteMcpHeader(result, name);
      result[name] = value;
    }
  }
  return result;
}

export function normalizeMcpHeaderNames(names: string[]): string[] {
  const result: string[] = [];
  for (const rawName of names) {
    const name = rawName.trim();
    if (!name) continue;
    const normalized = name.toLowerCase();
    const index = result.findIndex((existing) => existing.toLowerCase() === normalized);
    if (index >= 0) result.splice(index, 1);
    result.push(name);
  }
  return result;
}

export function deleteMcpHeader(headers: Record<string, string>, name: string): void {
  const normalized = name.toLowerCase();
  for (const key of Object.keys(headers)) if (key.toLowerCase() === normalized) delete headers[key];
}

export function getMcpHeader(headers: Record<string, string>, name: string): string | undefined {
  const normalized = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === normalized)?.[1];
}
