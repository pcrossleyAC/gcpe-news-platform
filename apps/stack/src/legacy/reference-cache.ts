/**
 * A small in-process negative cache for the NEWS-n reference lookup (url-compat T5): a bare
 * `/<digits>` is one DB query, and bots walk number ranges. A reference that resolves to no
 * published post is remembered for `ttlMs`; a found post never is (it can be unpublished, and
 * the rule must stop redirecting to it at once), nor is a failed lookup. At most `max` misses
 * are held, the oldest dropped first. A post published within `ttlMs` of a miss for its number
 * is found once the entry expires.
 */
export function cacheMisses(
  lookup: (reference: string) => Promise<string | null>,
  opts: { max?: number; ttlMs?: number; now?: () => number } = {},
): (reference: string) => Promise<string | null> {
  const max = opts.max ?? 1_000;
  const ttlMs = opts.ttlMs ?? 60_000;
  const now = opts.now ?? Date.now;
  /** Lowercased reference → when the miss expires, in insertion order (oldest first). */
  const misses = new Map<string, number>();
  return async (reference) => {
    const k = reference.toLowerCase();
    const until = misses.get(k);
    if (until !== undefined) {
      if (now() < until) return null;
      misses.delete(k);
    }
    const key = await lookup(reference);
    if (key === null) {
      if (misses.size >= max) misses.delete(misses.keys().next().value!);
      misses.set(k, now() + ttlMs);
    }
    return key;
  };
}
