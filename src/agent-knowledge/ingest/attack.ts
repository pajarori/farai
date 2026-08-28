import { writeTaxonomy } from "./taxonomy-pack";
import type { KnowledgeEdge, KnowledgeNode } from "../types";

const INDEX_URL = "https://raw.githubusercontent.com/mitre-attack/attack-stix-data/master/index.json";

type StixObject = {
  type: string;
  id: string;
  name?: string;
  description?: string;
  revoked?: boolean;
  x_mitre_deprecated?: boolean;
  external_references?: Array<{ source_name?: string; external_id?: string }>;
  kill_chain_phases?: Array<{ kill_chain_name?: string; phase_name?: string }>;
  relationship_type?: string;
  source_ref?: string;
  target_ref?: string;
};

export async function ingestAttack(): Promise<{ dir: string; nodes: number; edges: number }> {
  const index = (await fetchJson(INDEX_URL)) as { collections: Array<{ versions: Array<{ version: string; url: string }> }> };
  const latest = index.collections[0]!.versions[0]!;
  const bundle = (await fetchJson(latest.url)) as { objects: StixObject[] };

  const nodes: KnowledgeNode[] = [];
  const edges: KnowledgeEdge[] = [];
  const stixToAttackId = new Map<string, string>();
  const tacticShortToId = new Map<string, string>();

  for (const object of bundle.objects) {
    if (object.revoked || object.x_mitre_deprecated) continue;
    if (object.type === "x-mitre-tactic") {
      const id = attackId(object);
      if (!id) continue;
      const shortName = shortNameOf(object);
      tacticShortToId.set(shortName, id);
      stixToAttackId.set(object.id, id);
      nodes.push({ id, kind: "attack", name: object.name ?? id, summary: summary(object.description), pin: latest.version });
    }
  }

  for (const object of bundle.objects) {
    if (object.type !== "attack-pattern" || object.revoked || object.x_mitre_deprecated) continue;
    const id = attackId(object);
    if (!id) continue;
    stixToAttackId.set(object.id, id);
    nodes.push({ id, kind: "attack", name: object.name ?? id, summary: summary(object.description), pin: latest.version });
    for (const phase of object.kill_chain_phases ?? []) {
      if (phase.kill_chain_name !== "mitre-attack") continue;
      const tacticId = tacticShortToId.get(phase.phase_name ?? "");
      if (tacticId) edges.push({ src: id, rel: "in_tactic", dst: tacticId, authoritative: true });
    }
  }

  for (const object of bundle.objects) {
    if (object.type !== "relationship" || object.relationship_type !== "subtechnique-of") continue;
    const child = stixToAttackId.get(object.source_ref ?? "");
    const parent = stixToAttackId.get(object.target_ref ?? "");
    if (child && parent) edges.push({ src: child, rel: "sub_technique_of", dst: parent, authoritative: true });
  }

  const dir = writeTaxonomy({
    id: "attack",
    sourceUrl: "https://github.com/mitre-attack/attack-stix-data",
    pin: latest.version,
    license: "MITRE ATT&CK Terms of Use",
    attribution: "© The MITRE Corporation",
    retrievedAt: new Date().toISOString()
  }, dedupeNodes(nodes), edges);
  return { dir, nodes: nodes.length, edges: edges.length };
}

function attackId(object: StixObject): string | undefined {
  const ref = object.external_references?.find((item) => item.source_name === "mitre-attack" && item.external_id);
  return ref?.external_id?.toUpperCase();
}

function shortNameOf(object: StixObject): string {
  const raw = object.external_references?.find((item) => item.source_name === "mitre-attack")?.external_id;
  if (raw) return (object.name ?? raw).toLowerCase().replace(/\s+/g, "-");
  return (object.name ?? "").toLowerCase().replace(/\s+/g, "-");
}

function summary(description: string | undefined): string {
  if (!description) return "";
  const firstLine = description.split("\n")[0]!.trim();
  return firstLine.length <= 400 ? firstLine : `${firstLine.slice(0, 400)}…`;
}

function dedupeNodes(nodes: KnowledgeNode[]): KnowledgeNode[] {
  const seen = new Map<string, KnowledgeNode>();
  for (const node of nodes) if (!seen.has(node.id)) seen.set(node.id, node);
  return [...seen.values()];
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`fetch failed ${response.status}: ${url}`);
  return response.json();
}
