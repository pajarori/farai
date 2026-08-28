import { fetchZippedXml } from "./zip-fetch";
import { writeTaxonomy } from "./taxonomy-pack";
import type { KnowledgeEdge, KnowledgeNode } from "../types";

const URL = "https://cwe.mitre.org/data/xml/cwec_latest.xml.zip";

export async function ingestCwe(): Promise<{ dir: string; nodes: number; edges: number }> {
  const { xml } = await fetchZippedXml("cwe", URL, /cwec.*\.xml$/i);
  const version = /Version="([\d.]+)"/.exec(xml)?.[1] ?? "unknown";
  const nodes: KnowledgeNode[] = [];
  const edges: KnowledgeEdge[] = [];

  for (const block of weaknessBlocks(xml)) {
    const id = `CWE-${block.id}`;
    nodes.push({ id, kind: "cwe", name: block.name, summary: block.description, pin: version });
    for (const parent of unique(childOf(block.body))) edges.push({ src: id, rel: "child_of", dst: `CWE-${parent}`, authoritative: true });
    for (const capec of unique(relatedCapec(block.body))) edges.push({ src: `CAPEC-${capec}`, rel: "exploits_weakness", dst: id, authoritative: true });
  }

  const dir = writeTaxonomy({
    id: "cwe",
    sourceUrl: "https://cwe.mitre.org",
    pin: version,
    license: "MITRE CWE Terms of Use",
    attribution: "© The MITRE Corporation",
    retrievedAt: new Date().toISOString()
  }, nodes, edges);
  return { dir, nodes: nodes.length, edges: edges.length };
}

function weaknessBlocks(xml: string): Array<{ id: string; name: string; description: string; body: string }> {
  const out: Array<{ id: string; name: string; description: string; body: string }> = [];
  const re = /<Weakness ID="(\d+)"[^>]*Name="([^"]+)"[^>]*>([\s\S]*?)<\/Weakness>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    const body = match[3] ?? "";
    const description = decode((/<Description>([\s\S]*?)<\/Description>/.exec(body)?.[1] ?? "").trim());
    out.push({ id: match[1]!, name: decode(match[2]!), description: description.length <= 400 ? description : `${description.slice(0, 400)}…`, body });
  }
  return out;
}

function childOf(body: string): string[] {
  return [...body.matchAll(/<Related_Weakness Nature="ChildOf" CWE_ID="(\d+)"/g)].map((match) => match[1]!);
}

function relatedCapec(body: string): string[] {
  return [...body.matchAll(/<Related_Attack_Pattern CAPEC_ID="(\d+)"/g)].map((match) => match[1]!);
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
