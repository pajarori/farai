import { writeTaxonomy } from "./taxonomy-pack";
import type { KnowledgeEdge, KnowledgeNode } from "../types";

const URL = "https://capec.mitre.org/data/xml/capec_latest.xml";

export async function ingestCapec(): Promise<{ dir: string; nodes: number; edges: number }> {
  const response = await fetch(URL);
  if (!response.ok) throw new Error(`fetch failed ${response.status}: ${URL}`);
  const xml = await response.text();
  const version = /Version="([\d.]+)"/.exec(xml)?.[1] ?? "unknown";
  const nodes: KnowledgeNode[] = [];
  const edges: KnowledgeEdge[] = [];

  for (const block of attackPatternBlocks(xml)) {
    const id = `CAPEC-${block.id}`;
    nodes.push({ id, kind: "capec", name: block.name, summary: block.description, pin: version });
    for (const cwe of unique(relatedCwe(block.body))) edges.push({ src: id, rel: "exploits_weakness", dst: `CWE-${cwe}`, authoritative: true });
    for (const technique of unique(attackTechniques(block.body))) edges.push({ src: id, rel: "maps_to_technique", dst: technique, authoritative: true });
  }

  const dir = writeTaxonomy({
    id: "capec",
    sourceUrl: "https://capec.mitre.org",
    pin: version,
    license: "MITRE CAPEC Terms of Use",
    attribution: "© The MITRE Corporation",
    retrievedAt: new Date().toISOString()
  }, nodes, edges);
  return { dir, nodes: nodes.length, edges: edges.length };
}

function attackPatternBlocks(xml: string): Array<{ id: string; name: string; description: string; body: string }> {
  const out: Array<{ id: string; name: string; description: string; body: string }> = [];
  const re = /<Attack_Pattern ID="(\d+)"[^>]*Name="([^"]+)"[^>]*>([\s\S]*?)<\/Attack_Pattern>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const body = match[3] ?? "";
    const description = decode((/<Description>([\s\S]*?)<\/Description>/.exec(body)?.[1] ?? "").trim());
    out.push({ id: match[1]!, name: decode(match[2]!), description: description.length <= 400 ? description : `${description.slice(0, 400)}…`, body });
  }
  return out;
}

function relatedCwe(body: string): string[] {
  return [...body.matchAll(/<Related_Weakness CWE_ID="(\d+)"/g)].map((match) => match[1]!);
}

function attackTechniques(body: string): string[] {
  return [...body.matchAll(/Taxonomy_Name="ATTACK">\s*<Entry_ID>([^<]+)<\/Entry_ID>/g)].map((match) => `T${match[1]!.trim()}`);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function decode(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
