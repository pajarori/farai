const KIB = 1024;
const MIB = 1024 * KIB;

export const PERSISTENCE_LIMITS = Object.freeze({
  partJsonBytes: 16 * MIB,
  eventJsonBytes: 4 * MIB,
  toolArgsJsonBytes: 4 * MIB,
  mailboxJsonBytes: 4 * MIB,
  backgroundResultJsonBytes: 4 * MIB,
  structuredJsonBytes: MIB,
  evidenceContentBytes: 16 * MIB,
  outputArtifactBytes: 64 * MIB,
  userInputBytes: 4 * MIB,
  summaryBytes: 4 * MIB,
  documentTextBytes: 2 * MIB,
  shortTextBytes: 64 * KIB
});

export function stringifyPersistedJson(value: unknown, maxBytes: number, label: string): string {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); }
  catch (error) { throw new Error(`${label} is not serializable: ${error instanceof Error ? error.message : String(error)}`); }
  if (serialized === undefined) throw new Error(`${label} is not serializable`);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > maxBytes) throw new Error(`${label} exceeded ${maxBytes} bytes`);
  return serialized;
}

export function assertPersistedText(value: string, maxBytes: number, label: string): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maxBytes) throw new Error(`${label} exceeded ${maxBytes} bytes`);
  return value;
}
