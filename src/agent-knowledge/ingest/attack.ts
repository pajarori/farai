import { writeTaxonomy } from "./taxonomy-pack";
import type { KnowledgeEdge, KnowledgeNode } from "../types";
import { fetchKnowledgeJson } from "./http";

const INDEX_URL = "https://raw.githubusercontent.com/mitre-attack/attack-stix-data/master/index.json";
const ATTACK_INDEX_MAX_BYTES = 2 * 1024 * 1024;
const ATTACK_BUNDLE_MAX_BYTES = 128 * 1024 * 1024;

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
  const latest = latestAttackVersion(await fetchKnowledgeJson(INDEX_URL, ATTACK_INDEX_MAX_BYTES, "attack index"));
  const objects = attackObjects(await fetchKnowledgeJson(latest.url, ATTACK_BUNDLE_MAX_BYTES, "attack bundle"));

  const nodes: KnowledgeNode[] = [];
  const edges: KnowledgeEdge[] = [];
  const stixToAttackId = new Map<string, string>();
  const tacticShortToId = new Map<string, string>();

  for (const object of objects) {
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

  for (const object of objects) {
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

  for (const object of objects) {
    if (object.type !== "relationship" || object.relationship_type !== "subtechnique-of") continue;
    const child = stixToAttackId.get(object.source_ref ?? "");
    const parent = stixToAttackId.get(object.target_ref ?? "");
    if (child && parent) edges.push({ src: child, rel: "sub_technique_of", dst: parent, authoritative: true });
  }

  const uniqueNodes = dedupeNodes(nodes);
  if (uniqueNodes.length === 0) throw new Error("attack bundle contained no usable taxonomy nodes");
  const dir = writeTaxonomy({
    id: "attack",
    sourceUrl: "https://github.com/mitre-attack/attack-stix-data",
    pin: latest.version,
    license: "MITRE ATT&CK Terms of Use",
    attribution: "© The MITRE Corporation",
    retrievedAt: new Date().toISOString()
  }, uniqueNodes, edges);
  return { dir, nodes: uniqueNodes.length, edges: edges.length };
}

function latestAttackVersion(value: unknown): { version: string; url: string } {
  const index = recordValue(value);
  const collections = Array.isArray(index?.collections) ? index.collections : [];
  const collection = recordValue(collections[0]);
  const versions = Array.isArray(collection?.versions) ? collection.versions : [];
  const latest = recordValue(versions[0]);
  const version = typeof latest?.version === "string" ? latest.version.trim() : "";
  const url = typeof latest?.url === "string" ? latest.url.trim() : "";
  if (!version || version.length > 64 || !url) throw new Error("attack index returned no usable latest version");
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("attack index returned an invalid bundle url"); }
  if (parsed.protocol !== "https:" || parsed.hostname !== "raw.githubusercontent.com") throw new Error("attack index returned an untrusted bundle url");
  return { version, url: parsed.toString() };
}

function attackObjects(value: unknown): StixObject[] {
  const bundle = recordValue(value);
  if (!Array.isArray(bundle?.objects) || bundle.objects.length === 0 || bundle.objects.length > 250_000) throw new Error("attack bundle returned an invalid object catalog");
  return bundle.objects.flatMap((value): StixObject[] => {
    const object = recordValue(value);
    if (!object || typeof object.type !== "string" || typeof object.id !== "string") return [];
    const externalReferences = arrayRecords(object.external_references).flatMap((item) => {
      const sourceName = typeof item.source_name === "string" ? item.source_name : undefined;
      const externalId = typeof item.external_id === "string" ? item.external_id : undefined;
      return sourceName || externalId ? [{ ...(sourceName ? { source_name: sourceName } : {}), ...(externalId ? { external_id: externalId } : {}) }] : [];
    });
    const phases = arrayRecords(object.kill_chain_phases).flatMap((item) => {
      const chain = typeof item.kill_chain_name === "string" ? item.kill_chain_name : undefined;
      const phase = typeof item.phase_name === "string" ? item.phase_name : undefined;
      return chain || phase ? [{ ...(chain ? { kill_chain_name: chain } : {}), ...(phase ? { phase_name: phase } : {}) }] : [];
    });
    return [{
      type: object.type,
      id: object.id,
      ...(typeof object.name === "string" ? { name: object.name } : {}),
      ...(typeof object.description === "string" ? { description: object.description } : {}),
      ...(object.revoked === true ? { revoked: true } : {}),
      ...(object.x_mitre_deprecated === true ? { x_mitre_deprecated: true } : {}),
      ...(externalReferences.length ? { external_references: externalReferences } : {}),
      ...(phases.length ? { kill_chain_phases: phases } : {}),
      ...(typeof object.relationship_type === "string" ? { relationship_type: object.relationship_type } : {}),
      ...(typeof object.source_ref === "string" ? { source_ref: object.source_ref } : {}),
      ...(typeof object.target_ref === "string" ? { target_ref: object.target_ref } : {})
    }];
  });
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

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.flatMap((entry) => {
    const record = recordValue(entry);
    return record ? [record] : [];
  }) : [];
}
