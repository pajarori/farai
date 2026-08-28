import type { FileStateEntry, FileStateStore } from "../types";

const MAX_FILES_PER_SESSION = 64;

export class FileStateCache implements FileStateStore {
  private readonly sessions = new Map<string, Map<string, FileStateEntry>>();
  private seq = 0;

  private forSession(sessionId: string): Map<string, FileStateEntry> {
    let map = this.sessions.get(sessionId);
    if (!map) {
      map = new Map();
      this.sessions.set(sessionId, map);
    }
    return map;
  }

  get(sessionId: string, path: string): FileStateEntry | undefined {
    return this.sessions.get(sessionId)?.get(path);
  }

  set(sessionId: string, entry: Omit<FileStateEntry, "readSeq">): void {
    const map = this.forSession(sessionId);
    map.delete(entry.path);
    map.set(entry.path, { ...entry, readSeq: ++this.seq });
    while (map.size > MAX_FILES_PER_SESSION) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  invalidate(sessionId: string, path: string): void {
    this.sessions.get(sessionId)?.delete(path);
  }

  recent(sessionId: string, limit: number): FileStateEntry[] {
    const map = this.sessions.get(sessionId);
    if (!map) return [];
    return [...map.values()].sort((a, b) => b.readSeq - a.readSeq).slice(0, Math.max(0, limit));
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
