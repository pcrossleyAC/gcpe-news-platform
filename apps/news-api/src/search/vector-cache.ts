export const QUERY_VECTOR_TTL_MS = 5 * 60_000;
export const QUERY_VECTOR_MAX_ENTRIES = 5_000;

/**
 * Query vectors by normalised query (spec §5.4): each kept 5 minutes, at most 5,000, oldest
 * dropped first. It holds visitors' normalised queries in memory only, and is never logged.
 */
export class QueryVectorCache {
  private readonly entries = new Map<string, { vector: number[]; at: number }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? QUERY_VECTOR_TTL_MS;
    this.maxEntries = opts.maxEntries ?? QUERY_VECTOR_MAX_ENTRIES;
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): number[] | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.vector;
  }

  set(key: string, vector: number[]): void {
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { vector, at: this.now() });
  }
}
