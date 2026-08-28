import type { Database } from "bun:sqlite";

export const KNOWLEDGE_SCHEMA_VERSION = 2;

export function migrateKnowledge(db: Database): void {
  const version = Number((db.query("pragma user_version").get() as { user_version?: number } | null)?.user_version ?? 0);
  if (version > KNOWLEDGE_SCHEMA_VERSION) throw new Error(`unsupported knowledge db version: ${version}`);
  db.transaction(() => {
    if (version === 0) createBaseline(db);
    if (version === 1) migrateV1ToV2(db);
    db.exec(`pragma user_version = ${KNOWLEDGE_SCHEMA_VERSION}`);
  })();
}

function createBaseline(db: Database): void {
  db.exec(`
    create table if not exists kb_packs (
      id text primary key,
      pin text not null,
      license text not null,
      attribution text not null,
      signed integer not null default 0,
      signer text,
      source_url text not null,
      category text not null,
      kind text not null,
      builder_version integer not null,
      retrieved_at text not null,
      built_at text not null
    );
    create table if not exists kb_records (
      id text primary key,
      pack text not null references kb_packs(id),
      query text not null,
      answer text not null,
      context text,
      category text,
      source text,
      doc_path text,
      heading_path_json text,
      char_start integer,
      char_end integer,
      source_hash text
    );
    create index if not exists kb_records_pack_idx on kb_records(pack);
    create index if not exists kb_records_category_idx on kb_records(category, pack);
    create virtual table if not exists kb_records_fts using fts5(
      query, answer, context,
      content='kb_records', content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2', prefix='2 3 4'
    );
    create virtual table if not exists kb_records_tri using fts5(
      answer, content='kb_records', content_rowid='rowid', tokenize='trigram'
    );
    create table if not exists kb_entities (
      record_id text not null references kb_records(id),
      type text not null,
      value text not null,
      unique(record_id, type, value)
    );
    create index if not exists kb_entities_value_idx on kb_entities(type, value);
    create index if not exists kb_entities_record_idx on kb_entities(record_id);
    create table if not exists kb_nodes (
      id text primary key,
      kind text not null,
      name text not null,
      summary text not null,
      pin text not null
    );
    create index if not exists kb_nodes_name_idx on kb_nodes(name);
    create table if not exists kb_edges (
      src text not null,
      rel text not null,
      dst text not null,
      authoritative integer not null default 1,
      unique(src, rel, dst)
    );
    create index if not exists kb_edges_src_idx on kb_edges(src, rel);
    create index if not exists kb_edges_dst_idx on kb_edges(dst, rel);
    create table if not exists kb_enrichment (
      cve text primary key,
      kev_listed integer not null default 0,
      kev_date text,
      ransomware text,
      epss real,
      epss_pct real,
      as_of text
    );
    create table if not exists kb_dupe_groups (
      group_id text not null,
      record_id text not null unique references kb_records(id)
    );
    create index if not exists kb_dupe_group_idx on kb_dupe_groups(group_id);
  `);
}

function migrateV1ToV2(db: Database): void {
  db.exec(`
    alter table kb_packs add column signer text;
    alter table kb_packs add column retrieved_at text not null default '';
    delete from kb_entities where rowid not in (select min(rowid) from kb_entities group by record_id, type, value);
    delete from kb_edges where rowid not in (select min(rowid) from kb_edges group by src, rel, dst);
    delete from kb_dupe_groups where rowid not in (select min(rowid) from kb_dupe_groups group by record_id);
    create unique index if not exists kb_entities_unique_idx on kb_entities(record_id, type, value);
    create unique index if not exists kb_edges_unique_idx on kb_edges(src, rel, dst);
    create unique index if not exists kb_dupe_record_unique_idx on kb_dupe_groups(record_id);
    create index if not exists kb_records_category_idx on kb_records(category, pack);
    drop table if exists kb_records_fts;
    drop table if exists kb_records_tri;
    create virtual table kb_records_fts using fts5(
      query, answer, context,
      content='kb_records', content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2', prefix='2 3 4'
    );
    create virtual table kb_records_tri using fts5(
      answer, content='kb_records', content_rowid='rowid', tokenize='trigram'
    );
  `);
}

export function rebuildFtsIndexes(db: Database): void {
  db.exec(`
    insert into kb_records_fts(kb_records_fts) values('rebuild');
    insert into kb_records_tri(kb_records_tri) values('rebuild');
  `);
}
