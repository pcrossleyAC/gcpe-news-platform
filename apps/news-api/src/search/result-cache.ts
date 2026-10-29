/** Defaults for the public search result cache (see docs/deploy/siteground.md, "Search result cache"). */
export const SEARCH_CACHE_DEFAULT_TTL_SECONDS = 60;
export const SEARCH_CACHE_DEFAULT_MAX_ENTRIES = 500;
export const SEARCH_CACHE_DEFAULT_MAX_MB = 32;

export interface ResultCacheOptions {
  ttlMs: number;
  maxEntries: number;
  maxBytes: number;
  now?: () => number;
}

interface Entry<V> {
  value: V;
  at: number;
  bytes: number;
}

/**
 * A small in-process LRU with a TTL, bounded by entry count and by bytes (the serialised size of
 * what it holds). Values are the public, anonymous search responses only; it holds visitors'
 * normalised queries in memory and never logs them. A value bigger than the byte budget on its
 * own is not stored. Map insertion order is the recency order: a hit re-inserts its key.
 */
export class ResultCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly o: Required<ResultCacheOptions>;
  private bytes = 0;

  constructor(o: ResultCacheOptions) {
    this.o = { now: Date.now, ...o };
  }

  get size(): number {
    return this.entries.size;
  }

  get byteSize(): number {
    return this.bytes;
  }

  get(key: string): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (this.o.now() - hit.at >= this.o.ttlMs) {
      this.remove(key, hit);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V, bytes: number): void {
    const old = this.entries.get(key);
    if (old) this.remove(key, old);
    if (bytes > this.o.maxBytes) return;
    this.entries.set(key, { value, at: this.o.now(), bytes });
    this.bytes += bytes;
    while (this.entries.size > this.o.maxEntries || this.bytes > this.o.maxBytes) {
      const oldest = this.entries.entries().next().value;
      if (!oldest) break;
      this.remove(oldest[0], oldest[1]);
    }
  }

  private remove(key: string, e: Entry<V>): void {
    this.entries.delete(key);
    this.bytes -= e.bytes;
  }
}
