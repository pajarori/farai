export function id(): string {
  return Bun.randomUUIDv7();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function assertObject(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
}

export function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

export function maybeString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function truncate(value: string, max = 8_000): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n\n[truncated ${value.length - max} chars]`;
}
