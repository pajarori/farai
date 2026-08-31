import { createReadStream, existsSync } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { createGunzip } from "node:zlib";
import { join } from "node:path";
import { knowledgeRoot } from "../paths";
import { downloadKnowledgeFile, fetchKnowledgeJson } from "./http";
import { forEachFileLineSync } from "../../file-read";
import { ensurePrivateDirectory } from "../../agent-core/private-path";

const KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";
const EPSS_URL = "https://epss.empiricalsecurity.com/epss_scores-current.csv.gz";
const KEV_MAX_BYTES = 16 * 1024 * 1024;
const EPSS_GZIP_MAX_BYTES = 16 * 1024 * 1024;
const EPSS_CSV_MAX_BYTES = 128 * 1024 * 1024;
const EPSS_LINE_MAX_BYTES = 1024 * 1024;
const OUTPUT_CHUNK_BYTES = 1024 * 1024;
const ENRICHMENT_FILE_MAX_BYTES = 256 * 1024 * 1024;
const KEV_ENTRY_MAX_COUNT = 100_000;
const ENRICHMENT_ROW_MAX_COUNT = 1_000_000;

export type EnrichmentRow = {
  cve: string;
  kevListed: boolean;
  kevDate?: string;
  ransomware?: string;
  epss?: number;
  epssPct?: number;
  asOf?: string;
};

function enrichmentDir(): string {
  return join(knowledgeRoot(), "enrichment");
}

export async function ingestEnrichment(): Promise<{ dir: string; rows: number }> {
  const map = new Map<string, EnrichmentRow>();

  const kev = recordValue(await fetchKnowledgeJson(KEV_URL, KEV_MAX_BYTES, "kev catalog"));
  if (!kev || !Array.isArray(kev.vulnerabilities) || kev.vulnerabilities.length > KEV_ENTRY_MAX_COUNT) throw new Error("kev catalog returned an invalid vulnerability list");
  const asOf = boundedText(kev.dateReleased, 64);
  for (const value of kev.vulnerabilities) {
    const item = recordValue(value);
    const cve = typeof item?.cveID === "string" ? item.cveID.toUpperCase() : undefined;
    if (!cve || !/^CVE-\d{4}-\d{4,7}$/.test(cve)) continue;
    map.set(cve, {
      cve,
      kevListed: true,
      ...(boundedText(item?.dateAdded, 64) ? { kevDate: boundedText(item?.dateAdded, 64)! } : {}),
      ...(boundedText(item?.knownRansomwareCampaignUse, 256) ? { ransomware: boundedText(item?.knownRansomwareCampaignUse, 256)! } : {}),
      ...(asOf ? { asOf } : {})
    });
  }

  const dir = enrichmentDir();
  ensurePrivateDirectory(dir, "knowledge enrichment directory");
  let epssRows = 0;
  await forEachEpssLine(dir, (line) => {
    if (!line || line.startsWith("#") || line.startsWith("cve")) return;
    const [cveRaw, epssRaw, pctRaw] = line.split(",");
    const cve = cveRaw?.trim().toUpperCase();
    if (!cve || !/^CVE-\d{4}-\d{4,7}$/.test(cve)) return;
    const epss = Number(epssRaw);
    const pct = Number(pctRaw);
    const existing = map.get(cve) ?? { cve, kevListed: false, ...(asOf ? { asOf } : {}) };
    if (Number.isFinite(epss)) existing.epss = epss;
    if (Number.isFinite(pct)) existing.epssPct = pct;
    map.set(cve, existing);
    if (map.size > ENRICHMENT_ROW_MAX_COUNT) throw new Error(`enrichment data exceeded ${ENRICHMENT_ROW_MAX_COUNT} rows`);
    epssRows += 1;
  });
  if (epssRows === 0) throw new Error("epss feed contained no usable score rows");

  await writeEnrichmentRows(dir, map.values());
  return { dir, rows: map.size };
}

export function readEnrichment(): EnrichmentRow[] {
  const path = join(enrichmentDir(), "enrichment.jsonl");
  if (!existsSync(path)) return [];
  const out: EnrichmentRow[] = [];
  forEachFileLineSync(path, { label: "enrichment data", maxBytes: ENRICHMENT_FILE_MAX_BYTES, maxLineBytes: EPSS_LINE_MAX_BYTES, noFollow: true }, (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (out.length >= ENRICHMENT_ROW_MAX_COUNT) throw new Error(`enrichment data exceeded ${ENRICHMENT_ROW_MAX_COUNT} rows`);
    try {
      out.push(JSON.parse(trimmed) as EnrichmentRow);
    } catch {
    }
  });
  return out;
}

async function forEachEpssLine(dir: string, consume: (line: string) => void): Promise<void> {
  const archive = join(dir, `.epss-${randomUUID()}.csv.gz`);
  try {
    await downloadKnowledgeFile(EPSS_URL, archive, EPSS_GZIP_MAX_BYTES, "epss archive");
    await pipeline(
      createReadStream(archive),
      createGunzip(),
      new BoundedLineSink(EPSS_CSV_MAX_BYTES, EPSS_LINE_MAX_BYTES, consume)
    );
  } finally {
    try { await unlink(archive); } catch {}
  }
}

async function writeEnrichmentRows(dir: string, rows: Iterable<EnrichmentRow>): Promise<void> {
  const output = join(dir, "enrichment.jsonl");
  const temporary = join(dir, `.enrichment-${randomUUID()}.jsonl`);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(temporary, "wx", 0o600);
    let position = 0;
    let buffered = "";
    for (const row of rows) {
      const line = `${JSON.stringify(row)}\n`;
      if (Buffer.byteLength(line, "utf8") > EPSS_LINE_MAX_BYTES) throw new Error(`enrichment row exceeded ${EPSS_LINE_MAX_BYTES} bytes`);
      buffered += line;
      if (Buffer.byteLength(buffered, "utf8") < OUTPUT_CHUNK_BYTES) continue;
      const bytes = Buffer.from(buffered, "utf8");
      if (position + bytes.byteLength > ENRICHMENT_FILE_MAX_BYTES) throw new Error(`enrichment data exceeded ${ENRICHMENT_FILE_MAX_BYTES} bytes`);
      position += await writeAll(file, bytes, position);
      buffered = "";
    }
    if (buffered) {
      const bytes = Buffer.from(buffered, "utf8");
      if (position + bytes.byteLength > ENRICHMENT_FILE_MAX_BYTES) throw new Error(`enrichment data exceeded ${ENRICHMENT_FILE_MAX_BYTES} bytes`);
      position += await writeAll(file, bytes, position);
    }
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, output);
  } catch (error) {
    try { await file?.close(); } catch {}
    try { await unlink(temporary); } catch {}
    throw error;
  }
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : undefined;
}

async function writeAll(file: Awaited<ReturnType<typeof open>>, bytes: Buffer, position: number): Promise<number> {
  let offset = 0;
  while (offset < bytes.length) {
    const written = await file.write(bytes, offset, bytes.length - offset, position + offset);
    if (written.bytesWritten <= 0) throw new Error("failed to write enrichment output");
    offset += written.bytesWritten;
  }
  return offset;
}

class BoundedLineSink extends Writable {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";
  private bytes = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly maxLineBytes: number,
    private readonly consume: (line: string) => void
  ) {
    super();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      this.bytes += chunk.length;
      if (this.bytes > this.maxBytes) throw new Error(`epss csv exceeded the ${this.maxBytes}-byte expanded limit`);
      this.pushText(this.decoder.write(chunk));
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    try {
      this.pushText(this.decoder.end());
      if (this.pending) this.consume(this.pending.replace(/\r$/, ""));
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private pushText(value: string): void {
    this.pending += value;
    let newline: number;
    while ((newline = this.pending.indexOf("\n")) !== -1) {
      const line = this.pending.slice(0, newline).replace(/\r$/, "");
      this.pending = this.pending.slice(newline + 1);
      this.consume(line);
    }
    if (Buffer.byteLength(this.pending, "utf8") > this.maxLineBytes) throw new Error(`epss csv line exceeded the ${this.maxLineBytes}-byte limit`);
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
