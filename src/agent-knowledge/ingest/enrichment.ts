import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { knowledgeRoot } from "../paths";

const KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";
const EPSS_URL = "https://epss.empiricalsecurity.com/epss_scores-current.csv.gz";

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

  const kev = (await fetchJson(KEV_URL)) as { dateReleased?: string; vulnerabilities?: Array<{ cveID?: string; dateAdded?: string; knownRansomwareCampaignUse?: string }> };
  const asOf = kev.dateReleased;
  for (const item of kev.vulnerabilities ?? []) {
    const cve = item.cveID?.toUpperCase();
    if (!cve) continue;
    map.set(cve, {
      cve,
      kevListed: true,
      ...(item.dateAdded ? { kevDate: item.dateAdded } : {}),
      ...(item.knownRansomwareCampaignUse ? { ransomware: item.knownRansomwareCampaignUse } : {}),
      ...(asOf ? { asOf } : {})
    });
  }

  const epssCsv = await fetchGzipText(EPSS_URL);
  for (const line of epssCsv.split("\n")) {
    if (!line || line.startsWith("#") || line.startsWith("cve")) continue;
    const [cveRaw, epssRaw, pctRaw] = line.split(",");
    const cve = cveRaw?.trim().toUpperCase();
    if (!cve || !cve.startsWith("CVE-")) continue;
    const epss = Number(epssRaw);
    const pct = Number(pctRaw);
    const existing = map.get(cve) ?? { cve, kevListed: false, ...(asOf ? { asOf } : {}) };
    if (Number.isFinite(epss)) existing.epss = epss;
    if (Number.isFinite(pct)) existing.epssPct = pct;
    map.set(cve, existing);
  }

  const dir = enrichmentDir();
  mkdirSync(dir, { recursive: true });
  const rows = [...map.values()];
  writeFileSync(join(dir, "enrichment.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
  return { dir, rows: rows.length };
}

export function readEnrichment(): EnrichmentRow[] {
  const path = join(enrichmentDir(), "enrichment.jsonl");
  if (!existsSync(path)) return [];
  const out: EnrichmentRow[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as EnrichmentRow);
    } catch {
      continue;
    }
  }
  return out;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch failed ${response.status}: ${url}`);
  return response.json();
}

async function fetchGzipText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch failed ${response.status}: ${url}`);
  return gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8");
}
