import type { SqliteStore } from "../agent-store/sqlite-store";

export type ContextSearchHit = {
  id: string;
  kind: string;
  text: string;
  score: number;
};

type IndexedDocument = { id: string; kind: string; text: string; version: string };

export class ContextSearchIndex {
  private ready: boolean | undefined;
  private readonly indexedSessions = new Set<string>();
  private readonly dirtySessions = new Set<string>();

  constructor(private readonly store: SqliteStore) {
    store.subscribe("*", (change) => {
      if (["todo", "note", "memory", "evidence", "finding"].includes(change.kind)) {
        this.dirtySessions.add(change.sessionId);
      }
    });
  }

  search(sessionId: string, query: string, limit = 10): ContextSearchHit[] | undefined {
    if (!this.ensure()) return undefined;
    const match = ftsQuery(query);
    if (!match) return [];
    this.refresh(sessionId);
    try {
      const rows = this.store.database().query(
        `select id, kind, content, bm25(context_search) as rank
         from context_search
         where context_search match $query and session_id = $session
         order by rank asc, kind asc, id asc limit $limit`
      ).all({ $query: match, $session: sessionId, $limit: Math.max(1, Math.min(50, limit)) }) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        id: String(row.id),
        kind: String(row.kind),
        text: String(row.content),
        score: Math.max(0, -Number(row.rank ?? 0))
      }));
    } catch {
      return undefined;
    }
  }

  private ensure(): boolean {
    if (this.ready !== undefined) return this.ready;
    try {
      this.store.database().exec(
        "create virtual table if not exists context_search using fts5(id unindexed, session_id unindexed, kind unindexed, content)"
      );
      this.ready = true;
    } catch {
      this.ready = false;
    }
    return this.ready;
  }

  private refresh(sessionId: string): void {
    if (this.indexedSessions.has(sessionId) && !this.dirtySessions.has(sessionId)) return;
    const docs = documents(this.store, sessionId);
    const db = this.store.database();
    const transaction = db.transaction(() => {
      db.query("delete from context_search where session_id = $session").run({ $session: sessionId });
      const insert = db.query("insert into context_search (id, session_id, kind, content) values ($id, $session, $kind, $content)");
      for (const doc of docs) insert.run({ $id: doc.id, $session: sessionId, $kind: doc.kind, $content: doc.text });
    });
    try {
      transaction();
      this.indexedSessions.add(sessionId);
      this.dirtySessions.delete(sessionId);
    } catch {
      this.ready = false;
    }
  }
}

function documents(store: SqliteStore, sessionId: string): IndexedDocument[] {
  return [
    ...store.listTodos(sessionId, { limit: 10_000 }).map((item) => ({ id: item.id, kind: "todo", text: `${item.status} ${item.priority} ${item.text}`, version: item.updatedAt })),
    ...store.listNotes(sessionId).map((item) => ({ id: item.id, kind: "note", text: item.text, version: item.createdAt })),
    ...store.listMemory(sessionId).map((item) => ({ id: item.id, kind: "memory", text: `${item.kind} ${item.key} ${JSON.stringify(item.value)}`, version: item.updatedAt })),
    ...store.listEvidence(sessionId).map((item) => ({ id: item.id, kind: "evidence", text: `${item.title} ${item.summary}`, version: item.createdAt })),
    ...store.listFindings(sessionId).map((item) => ({
      id: item.id,
      kind: "finding",
      text: `${item.severity} ${item.title} ${item.target} ${item.impact} ${item.reproduction} ${item.remediation}`,
      version: `${item.status ?? "candidate"}:${item.evidenceIds.join(",")}`
    }))
  ];
}

function ftsQuery(text: string): string | undefined {
  const terms = [...new Set(text.toLowerCase().match(/[a-z0-9_.-]{3,}/g) ?? [])].slice(0, 20);
  if (!terms.length) return undefined;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}
