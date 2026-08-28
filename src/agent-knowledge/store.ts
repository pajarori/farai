import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { KNOWLEDGE_SCHEMA_VERSION, migrateKnowledge, rebuildFtsIndexes } from "./schema";
import type {
  KnowledgeEdge,
  KnowledgeEntity,
  KnowledgeHit,
  KnowledgeIntegrity,
  KnowledgeNeighbor,
  KnowledgeNode,
  KnowledgePackMeta,
  KnowledgeQuery,
  KnowledgeReadResult,
  KnowledgeSearchOptions,
  KnowledgeStatus
} from "./types";

const RRF_K = 60;
const QUERY_ALIASES: Record<string, string[]> = {
  sqli: ["sql", "injection"],
  xss: ["cross", "site", "scripting"],
  ssrf: ["server", "side", "request", "forgery"],
  ssti: ["server", "side", "template", "injection"],
  lfi: ["local", "file", "inclusion"],
  rfi: ["remote", "file", "inclusion"],
  privesc: ["privilege", "escalation"],
  deserialization: ["deserialization", "serialization"]
};

type Row = Record<string, unknown>;
type RankedRow = { rowid: number; score: number; reasons: Set<string> };
type RankedList = { rows: number[]; reason: string; weight: number };

export class KnowledgeStore implements KnowledgeQuery {
  private db: Database | undefined;

  constructor(private readonly path: string, private readonly create = false) {}

  static openIfExists(path: string): KnowledgeStore | undefined {
    if (!existsSync(path)) return undefined;
    const store = new KnowledgeStore(path);
    try {
      if (!store.compatible()) {
        store.close();
        return undefined;
      }
      return store;
    } catch {
      store.close();
      return undefined;
    }
  }

  private database(): Database {
    if (this.db) return this.db;
    this.db = this.create ? new Database(this.path, { create: true, readwrite: true }) : new Database(this.path, { readonly: true });
    this.db.exec("pragma busy_timeout = 5000;");
    if (this.create) {
      this.db.exec("pragma journal_mode = WAL;");
      this.db.exec("pragma foreign_keys = ON;");
      migrateKnowledge(this.db);
    } else if (!this.compatible()) {
      throw new Error("knowledge database schema is stale; rebuild with `farai setup --no-docker`");
    }
    return this.db;
  }

  private compatible(): boolean {
    const db = this.db ?? new Database(this.path, { readonly: true });
    const version = Number((db.query("pragma user_version").get() as { user_version?: number } | null)?.user_version ?? 0);
    if (!this.db) db.close();
    return version === KNOWLEDGE_SCHEMA_VERSION;
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  search(query: string, options: KnowledgeSearchOptions = {}): KnowledgeHit[] {
    const plan = searchPlan(query);
    if (!plan.terms.length && !plan.identifiers.length) return [];
    const limit = Math.max(1, Math.min(20, options.limit ?? 5));
    const pool = Math.max(limit * 10, 40);
    const lists: RankedList[] = [];
    if (plan.identifiers.length) {
      lists.push({ rows: this.entityRows(plan.identifiers, options, pool), reason: "exact identifier", weight: 8 });
    }
    if (plan.phrase) {
      lists.push({ rows: this.headingRows(plan.phrase, options, pool), reason: "heading", weight: 6 });
      lists.push({ rows: this.matchRows("kb_records_fts", phraseMatch(plan.phrase), options, pool), reason: "exact phrase", weight: 4 });
    }
    const lexical = ftsMatch(plan.terms);
    if (lexical) lists.push({ rows: this.matchRows("kb_records_fts", lexical, options, pool), reason: "lexical", weight: 2 });
    const trigram = triMatch(plan.raw);
    if (trigram) lists.push({ rows: this.matchRows("kb_records_tri", trigram, options, pool), reason: "trigram", weight: 1 });
    const ranked = fuse(lists);
    const db = this.database();
    const mustTerms = options.mustTerms?.map((term) => term.toLowerCase().trim()).filter(Boolean) ?? [];
    const duplicateGroups = new Set<string>();
    const hits: KnowledgeHit[] = [];
    for (const item of ranked) {
      if (hits.length >= limit) break;
      const row = db.query(
        `select r.*, p.pin as pack_pin, p.license as pack_license, p.source_url as pack_url,
          (select group_id from kb_dupe_groups d where d.record_id = r.id) as dupe_group
         from kb_records r join kb_packs p on p.id = r.pack where r.rowid = $rowid`
      ).get({ $rowid: item.rowid }) as Row | null;
      if (!row) continue;
      const haystack = `${String(row.query ?? "")} ${headingOf(row)} ${String(row.answer ?? "")} ${String(row.context ?? "")}`.toLowerCase();
      if (mustTerms.length && !mustTerms.every((term) => haystack.includes(term))) continue;
      const duplicateGroup = typeof row.dupe_group === "string" ? row.dupe_group : undefined;
      if (duplicateGroup && duplicateGroups.has(duplicateGroup)) continue;
      if (duplicateGroup) duplicateGroups.add(duplicateGroup);
      hits.push({
        recordId: String(row.id),
        pack: String(row.pack),
        pin: String(row.pack_pin),
        license: String(row.pack_license ?? "unknown"),
        sourceUrl: String(row.pack_url ?? ""),
        category: String(row.category ?? ""),
        heading: headingOf(row),
        snippet: snippet(String(row.answer ?? ""), 320),
        score: item.score,
        matchedBy: [...item.reasons].sort(),
        ...(typeof row.doc_path === "string" ? { docPath: row.doc_path } : {}),
        ...(typeof row.source_hash === "string" ? { sourceHash: row.source_hash } : {})
      });
    }
    return hits;
  }

  read(recordId: string): KnowledgeReadResult | undefined {
    const row = this.database().query(
      `select r.*, p.pin as pack_pin, p.license as pack_license, p.attribution as pack_attr, p.source_url as pack_url
       from kb_records r join kb_packs p on p.id = r.pack where r.id = $id`
    ).get({ $id: recordId }) as Row | null;
    if (!row) return undefined;
    return {
      recordId: String(row.id),
      pack: String(row.pack),
      pin: String(row.pack_pin),
      license: String(row.pack_license ?? "unknown"),
      attribution: String(row.pack_attr ?? ""),
      sourceUrl: String(row.pack_url ?? ""),
      category: String(row.category ?? ""),
      heading: headingOf(row),
      body: String(row.answer ?? ""),
      ...(typeof row.doc_path === "string" ? { docPath: row.doc_path } : {}),
      ...(typeof row.source_hash === "string" ? { sourceHash: row.source_hash } : {})
    };
  }

  resolve(name: string): KnowledgeNode[] {
    const needle = name.trim();
    if (!needle) return [];
    const db = this.database();
    const byId = db.query("select * from kb_nodes where id = $id").all({ $id: needle.toUpperCase() }) as Row[];
    if (byId.length) return byId.map(nodeFromRow);
    const like = `%${needle.toLowerCase()}%`;
    const rows = db.query(
      `select * from kb_nodes where lower(name) like $like or lower(id) like $like
       order by case when lower(name) = $exact then 0 else 1 end, length(name), id limit 20`
    ).all({ $like: like, $exact: needle.toLowerCase() }) as Row[];
    return rows.map(nodeFromRow);
  }

  neighbors(nodeId: string, options: { rel?: string; direction?: "out" | "in" } = {}): KnowledgeNeighbor[] {
    const db = this.database();
    const id = nodeId.toUpperCase();
    const output: KnowledgeNeighbor[] = [];
    if (options.direction !== "in") {
      const rows = db.query(
        `select e.rel, e.authoritative, n.* from kb_edges e join kb_nodes n on n.id = e.dst
         where e.src = $id ${options.rel ? "and e.rel = $rel" : ""} order by e.rel, n.id limit 100`
      ).all(options.rel ? { $id: id, $rel: options.rel } : { $id: id }) as Row[];
      for (const row of rows) output.push({ node: nodeFromRow(row), rel: String(row.rel), direction: "out", authoritative: Number(row.authoritative) === 1 });
    }
    if (options.direction !== "out") {
      const rows = db.query(
        `select e.rel, e.authoritative, n.* from kb_edges e join kb_nodes n on n.id = e.src
         where e.dst = $id ${options.rel ? "and e.rel = $rel" : ""} order by e.rel, n.id limit 100`
      ).all(options.rel ? { $id: id, $rel: options.rel } : { $id: id }) as Row[];
      for (const row of rows) output.push({ node: nodeFromRow(row), rel: String(row.rel), direction: "in", authoritative: Number(row.authoritative) === 1 });
    }
    return output;
  }

  prioritize(cve: string): { cve: string; kevListed: boolean; kevDate?: string; ransomware?: string; epss?: number; epssPercentile?: number; asOf?: string } | undefined {
    const row = this.database().query("select * from kb_enrichment where cve = $cve").get({ $cve: cve.toUpperCase() }) as Row | null;
    if (!row) return undefined;
    return {
      cve: String(row.cve),
      kevListed: Number(row.kev_listed) === 1,
      ...(typeof row.kev_date === "string" ? { kevDate: row.kev_date } : {}),
      ...(typeof row.ransomware === "string" ? { ransomware: row.ransomware } : {}),
      ...(typeof row.epss === "number" ? { epss: row.epss } : {}),
      ...(typeof row.epss_pct === "number" ? { epssPercentile: row.epss_pct } : {}),
      ...(typeof row.as_of === "string" ? { asOf: row.as_of } : {})
    };
  }

  status(): KnowledgeStatus {
    const db = this.database();
    const packs = (db.query(
      "select p.*, (select count(*) from kb_records r where r.pack = p.id) as record_count from kb_packs p order by p.id"
    ).all() as Row[]).map((row) => ({
      id: String(row.id),
      pin: String(row.pin),
      kind: row.kind as KnowledgePackMeta["kind"],
      records: Number(row.record_count),
      license: String(row.license),
      signed: Number(row.signed) === 1,
      ...(typeof row.signer === "string" && row.signer ? { signer: row.signer } : {}),
      retrievedAt: String(row.retrieved_at ?? ""),
      builtAt: String(row.built_at)
    }));
    const records = count(db, "select count(*) as c from kb_records");
    const nodes = count(db, "select count(*) as c from kb_nodes");
    const edges = count(db, "select count(*) as c from kb_edges");
    const taxonomies = (db.query(
      "select kind, pin, count(*) as node_count from kb_nodes group by kind, pin order by kind, pin"
    ).all() as Row[]).map((row) => ({
      kind: row.kind as KnowledgeNode["kind"],
      pin: String(row.pin),
      nodes: Number(row.node_count)
    }));
    const enrichmentRow = db.query(
      "select count(*) as records, sum(case when kev_listed = 1 then 1 else 0 end) as kev_listed, count(epss) as epss_scored, max(as_of) as as_of from kb_enrichment"
    ).get() as Row | null;
    const enrichment = {
      records: Number(enrichmentRow?.records ?? 0),
      kevListed: Number(enrichmentRow?.kev_listed ?? 0),
      epssScored: Number(enrichmentRow?.epss_scored ?? 0),
      ...(typeof enrichmentRow?.as_of === "string" && enrichmentRow.as_of ? { asOf: enrichmentRow.as_of } : {})
    };
    return { path: this.path, schemaVersion: KNOWLEDGE_SCHEMA_VERSION, packs, records, nodes, edges, taxonomies, enrichment };
  }

  verifyIntegrity(): KnowledgeIntegrity {
    const db = this.database();
    const checks: Array<{ kind: string; sql: string }> = [
      { kind: "orphan_edges", sql: "select count(*) as c from kb_edges e where not exists (select 1 from kb_nodes n where n.id = e.src) or not exists (select 1 from kb_nodes n where n.id = e.dst)" },
      { kind: "orphan_entities", sql: "select count(*) as c from kb_entities e where not exists (select 1 from kb_records r where r.id = e.record_id)" },
      { kind: "orphan_records", sql: "select count(*) as c from kb_records r where not exists (select 1 from kb_packs p where p.id = r.pack)" },
      { kind: "missing_source_hash", sql: "select count(*) as c from kb_records where source_hash is null or source_hash = ''" },
      { kind: "fts_count_mismatch", sql: "select abs((select count(*) from kb_records) - (select count(*) from kb_records_fts)) as c" }
    ];
    const issues = checks.map((check) => ({ kind: check.kind, count: count(db, check.sql) })).filter((item) => item.count > 0);
    return { ok: issues.length === 0, issues };
  }

  writable(): Database {
    if (!this.create) throw new Error("knowledge store is read-only");
    return this.database();
  }

  upsertPack(meta: KnowledgePackMeta, builtAt: string): void {
    this.writable().query(
      `insert into kb_packs (id, pin, license, attribution, signed, signer, source_url, category, kind, builder_version, retrieved_at, built_at)
       values ($id, $pin, $license, $attribution, $signed, $signer, $source_url, $category, $kind, $builder_version, $retrieved_at, $built_at)
       on conflict(id) do update set pin=excluded.pin, license=excluded.license, attribution=excluded.attribution,
         signed=excluded.signed, signer=excluded.signer, source_url=excluded.source_url, category=excluded.category,
         kind=excluded.kind, builder_version=excluded.builder_version, retrieved_at=excluded.retrieved_at, built_at=excluded.built_at`
    ).run({
      $id: meta.id,
      $pin: meta.pin,
      $license: meta.license,
      $attribution: meta.attribution,
      $signed: meta.signed ? 1 : 0,
      $signer: meta.signer ?? null,
      $source_url: meta.sourceUrl,
      $category: meta.category,
      $kind: meta.kind,
      $builder_version: meta.builderVersion,
      $retrieved_at: meta.retrievedAt,
      $built_at: builtAt
    });
  }

  deletePackRows(packId: string): void {
    const db = this.writable();
    db.query("delete from kb_dupe_groups where record_id in (select id from kb_records where pack = $pack)").run({ $pack: packId });
    db.query("delete from kb_entities where record_id in (select id from kb_records where pack = $pack)").run({ $pack: packId });
    db.query("delete from kb_records where pack = $pack").run({ $pack: packId });
  }

  insertRecord(pack: string, record: { id: string; query: string; answer: string; context?: string; category?: string; source?: string; docPath?: string; headingPath?: string[]; charStart?: number; charEnd?: number; sourceHash?: string }): void {
    this.writable().query(
      `insert into kb_records (id, pack, query, answer, context, category, source, doc_path, heading_path_json, char_start, char_end, source_hash)
       values ($id, $pack, $query, $answer, $context, $category, $source, $doc_path, $heading_path_json, $char_start, $char_end, $source_hash)
       on conflict(id) do update set pack=excluded.pack, query=excluded.query, answer=excluded.answer, context=excluded.context,
         category=excluded.category, source=excluded.source, doc_path=excluded.doc_path, heading_path_json=excluded.heading_path_json,
         char_start=excluded.char_start, char_end=excluded.char_end, source_hash=excluded.source_hash`
    ).run({
      $id: record.id,
      $pack: pack,
      $query: record.query,
      $answer: record.answer,
      $context: record.context ?? null,
      $category: record.category ?? null,
      $source: record.source ?? null,
      $doc_path: record.docPath ?? null,
      $heading_path_json: record.headingPath ? JSON.stringify(record.headingPath) : null,
      $char_start: record.charStart ?? null,
      $char_end: record.charEnd ?? null,
      $source_hash: record.sourceHash ?? null
    });
  }

  insertEntities(entities: KnowledgeEntity[]): void {
    const insert = this.writable().query("insert into kb_entities (record_id, type, value) values ($record_id, $type, $value) on conflict do nothing");
    for (const entity of entities) insert.run({ $record_id: entity.recordId, $type: entity.type, $value: entity.value });
  }

  upsertNode(node: KnowledgeNode): void {
    this.writable().query(
      `insert into kb_nodes (id, kind, name, summary, pin) values ($id, $kind, $name, $summary, $pin)
       on conflict(id) do update set kind=excluded.kind, name=excluded.name, summary=excluded.summary, pin=excluded.pin`
    ).run({ $id: node.id, $kind: node.kind, $name: node.name, $summary: node.summary, $pin: node.pin });
  }

  insertEdge(edge: KnowledgeEdge): void {
    this.writable().query("insert into kb_edges (src, rel, dst, authoritative) values ($src, $rel, $dst, $authoritative) on conflict do nothing")
      .run({ $src: edge.src, $rel: edge.rel, $dst: edge.dst, $authoritative: edge.authoritative ? 1 : 0 });
  }

  upsertEnrichment(row: { cve: string; kevListed: boolean; kevDate?: string; ransomware?: string; epss?: number; epssPct?: number; asOf?: string }): void {
    this.writable().query(
      `insert into kb_enrichment (cve, kev_listed, kev_date, ransomware, epss, epss_pct, as_of)
       values ($cve, $kev_listed, $kev_date, $ransomware, $epss, $epss_pct, $as_of)
       on conflict(cve) do update set kev_listed=excluded.kev_listed, kev_date=excluded.kev_date,
         ransomware=excluded.ransomware, epss=excluded.epss, epss_pct=excluded.epss_pct, as_of=excluded.as_of`
    ).run({
      $cve: row.cve.toUpperCase(),
      $kev_listed: row.kevListed ? 1 : 0,
      $kev_date: row.kevDate ?? null,
      $ransomware: row.ransomware ?? null,
      $epss: row.epss ?? null,
      $epss_pct: row.epssPct ?? null,
      $as_of: row.asOf ?? null
    });
  }

  finalizeIndexes(): void {
    const db = this.writable();
    rebuildFtsIndexes(db);
    db.exec("pragma wal_checkpoint(TRUNCATE);");
    db.exec("pragma optimize;");
  }

  private entityRows(identifiers: string[], options: KnowledgeSearchOptions, limit: number): number[] {
    if (!identifiers.length) return [];
    const params: Record<string, string | number> = { $limit: limit };
    const placeholders = identifiers.map((identifier, index) => {
      params[`$id${index}`] = identifier;
      return `$id${index}`;
    });
    const filters = [`e.value in (${placeholders.join(", ")})`, ...recordFilters(options, params)];
    const rows = this.database().query(
      `select distinct r.rowid as rowid from kb_entities e join kb_records r on r.id = e.record_id
       where ${filters.join(" and ")} order by r.rowid limit $limit`
    ).all(params) as Row[];
    return rows.map((row) => Number(row.rowid));
  }

  private headingRows(phrase: string, options: KnowledgeSearchOptions, limit: number): number[] {
    const params: Record<string, string | number> = { $exact: phrase.toLowerCase(), $like: `%${phrase.toLowerCase()}%`, $limit: limit };
    const filters = ["lower(r.query) like $like", ...recordFilters(options, params)];
    const rows = this.database().query(
      `select r.rowid as rowid from kb_records r where ${filters.join(" and ")}
       order by case when lower(r.query) = $exact then 0 else 1 end, length(r.query), r.rowid limit $limit`
    ).all(params) as Row[];
    return rows.map((row) => Number(row.rowid));
  }

  private matchRows(table: "kb_records_fts" | "kb_records_tri", match: string, options: KnowledgeSearchOptions, limit: number): number[] {
    const params: Record<string, string | number> = { $match: match, $limit: limit };
    const filters = [`${table} match $match`, ...recordFilters(options, params)];
    const rank = table === "kb_records_fts" ? `bm25(${table}, 8.0, 1.0, 4.0)` : `bm25(${table})`;
    const rows = this.database().query(
      `select f.rowid as rowid, ${rank} as rank from ${table} f join kb_records r on r.rowid = f.rowid
       where ${filters.join(" and ")} order by rank, f.rowid limit $limit`
    ).all(params) as Row[];
    return rows.map((row) => Number(row.rowid));
  }
}

function recordFilters(options: KnowledgeSearchOptions, params: Record<string, string | number>): string[] {
  const filters: string[] = [];
  if (options.category) {
    params.$category = options.category;
    filters.push("r.category = $category");
  }
  const packs = options.packs?.map((pack) => pack.trim()).filter(Boolean) ?? [];
  if (packs.length) {
    const placeholders = packs.map((pack, index) => {
      params[`$pack${index}`] = pack;
      return `$pack${index}`;
    });
    filters.push(`r.pack in (${placeholders.join(", ")})`);
  }
  return filters;
}

function searchPlan(query: string): { raw: string; terms: string[]; identifiers: string[]; phrase?: string } {
  const raw = query.trim();
  const base = raw.toLowerCase().match(/[a-z0-9_.:/-]{2,}/g) ?? [];
  const terms = new Set(base);
  for (const token of base) for (const expanded of QUERY_ALIASES[token] ?? []) terms.add(expanded);
  const identifiers = [...new Set(raw.toUpperCase().match(/(?:CVE-\d{4}-\d{4,7}|CWE-\d{1,5}|CAPEC-\d{1,5}|\bT\d{4}(?:\.\d{3})?\b)/g) ?? [])];
  const phraseTerms = base.filter((term) => !/^https?$/.test(term)).slice(0, 8);
  return {
    raw,
    terms: [...terms].slice(0, 24),
    identifiers,
    ...(phraseTerms.length >= 2 ? { phrase: phraseTerms.join(" ") } : {})
  };
}

function fuse(lists: RankedList[]): RankedRow[] {
  const ranked = new Map<number, RankedRow>();
  for (const list of lists) {
    list.rows.forEach((rowid, index) => {
      const contribution = list.weight / (RRF_K + index + 1);
      const existing = ranked.get(rowid);
      if (existing) {
        existing.score += contribution;
        existing.reasons.add(list.reason);
      } else {
        ranked.set(rowid, { rowid, score: contribution, reasons: new Set([list.reason]) });
      }
    });
  }
  return [...ranked.values()].sort((a, b) => b.score - a.score || a.rowid - b.rowid);
}

function ftsMatch(terms: string[]): string | undefined {
  const unique = [...new Set(terms)].filter((term) => term.length >= 2).slice(0, 24);
  if (!unique.length) return undefined;
  return unique.map(quoteFts).join(" OR ");
}

function phraseMatch(phrase: string): string {
  return quoteFts(phrase);
}

function triMatch(text: string): string | undefined {
  const tokens = [...new Set(text.toLowerCase().match(/[a-z0-9_.:/-]{4,}/g) ?? [])].slice(0, 12);
  return tokens.length ? tokens.map(quoteFts).join(" OR ") : undefined;
}

function quoteFts(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function headingOf(row: Row): string {
  if (typeof row.heading_path_json === "string") {
    try {
      const parts = JSON.parse(row.heading_path_json) as string[];
      if (Array.isArray(parts) && parts.length) return parts.join(" > ");
    } catch {}
  }
  return typeof row.query === "string" ? row.query : String(row.doc_path ?? row.id ?? "");
}

function snippet(body: string, max: number): string {
  const clean = body.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function nodeFromRow(row: Row): KnowledgeNode {
  return {
    id: String(row.id),
    kind: row.kind as KnowledgeNode["kind"],
    name: String(row.name),
    summary: String(row.summary),
    pin: String(row.pin)
  };
}

function count(db: Database, sql: string): number {
  return Number((db.query(sql).get() as { c?: number } | null)?.c ?? 0);
}
