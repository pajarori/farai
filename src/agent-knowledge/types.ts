export type KnowledgePackKind = "prose" | "qa";

export type KnowledgeEntityType = "cve" | "cwe" | "capec" | "attack" | "cpe";

export type KnowledgePackMeta = {
  id: string;
  sourceUrl: string;
  pin: string;
  license: string;
  attribution: string;
  signed: boolean;
  signer?: string;
  category: string;
  kind: KnowledgePackKind;
  builderVersion: number;
  retrievedAt: string;
  fields: { query: string; answer: string; context?: string };
};

export type KnowledgeProseRecord = {
  id: string;
  docPath: string;
  headingPath: string[];
  body: string;
  charStart: number;
  charEnd: number;
  sourceHash: string;
  langHints?: string[];
};

export type KnowledgeQaRecord = {
  id: string;
  query: string;
  answer: string;
  context?: string;
  category?: string;
  source?: string;
};

export type KnowledgeEntity = {
  recordId: string;
  type: KnowledgeEntityType;
  value: string;
};

export type KnowledgeNode = {
  id: string;
  kind: KnowledgeEntityType;
  name: string;
  summary: string;
  pin: string;
};

export type KnowledgeEdge = {
  src: string;
  rel: string;
  dst: string;
  authoritative: boolean;
};

export type KnowledgeSearchOptions = {
  category?: string;
  packs?: string[];
  mustTerms?: string[];
  limit?: number;
};

export type KnowledgeHit = {
  recordId: string;
  pack: string;
  pin: string;
  license: string;
  sourceUrl: string;
  category: string;
  heading: string;
  snippet: string;
  score: number;
  matchedBy: string[];
  docPath?: string;
  sourceHash?: string;
};

export type KnowledgeReadResult = {
  recordId: string;
  pack: string;
  pin: string;
  license: string;
  attribution: string;
  sourceUrl: string;
  category: string;
  heading: string;
  body: string;
  docPath?: string;
  sourceHash?: string;
};

export type KnowledgeNeighbor = {
  node: KnowledgeNode;
  rel: string;
  direction: "out" | "in";
  authoritative: boolean;
};

export type KnowledgeStatus = {
  path: string;
  schemaVersion: number;
  packs: Array<{
    id: string;
    pin: string;
    kind: KnowledgePackKind;
    records: number;
    license: string;
    signed: boolean;
    signer?: string;
    retrievedAt: string;
    builtAt: string;
  }>;
  records: number;
  nodes: number;
  edges: number;
  taxonomies: Array<{ kind: KnowledgeEntityType; pin: string; nodes: number }>;
  enrichment: { records: number; kevListed: number; epssScored: number; asOf?: string };
};

export type KnowledgeIntegrity = {
  ok: boolean;
  issues: Array<{ kind: string; count: number }>;
};

export type KnowledgeQuery = {
  search: (query: string, options?: KnowledgeSearchOptions) => KnowledgeHit[];
  read: (recordId: string) => KnowledgeReadResult | undefined;
  resolve: (name: string) => KnowledgeNode[];
  neighbors: (nodeId: string, options?: { rel?: string; direction?: "out" | "in" }) => KnowledgeNeighbor[];
  prioritize: (cve: string) => { cve: string; kevListed: boolean; kevDate?: string; ransomware?: string; epss?: number; epssPercentile?: number; asOf?: string } | undefined;
};
