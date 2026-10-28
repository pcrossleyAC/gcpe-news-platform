import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { POST_KEY } from "../../../public-site/src/site-paths";

/** A segment `pagePath` and `exactPagePath` never touch the filesystem for. */
const unsafeSegment = (s: string) => s.startsWith(".") || s.includes("\\") || s.includes(":") || s.includes("\0");

/**
 * Whether a decoded URL path names something the static mount would serve as a page, and its
 * canonical URL path if so (parity plan 3: "one hop" and "a page on disk wins over a fallback
 * rule"):
 * - a file → `urlPath` itself (null when it ends in "/": static would not serve that);
 * - a directory holding `index.html` → the path with exactly one trailing slash;
 * - anything else → null.
 *
 * Never stats anything outside `outputDir` or under a dot-segment: a segment that starts with
 * "." (".", "..", ".site-state.json" — express.static denies dotfiles anyway), or contains "\",
 * ":" (a Windows drive or stream name) or NUL, makes the answer null before any filesystem call.
 * Any stat error (missing, ENOTDIR, a file Windows has locked mid-replace) is also null: the
 * caller then falls through or picks the next candidate.
 */
export async function pagePath(outputDir: string, urlPath: string): Promise<string | null> {
  if (!urlPath.startsWith("/")) return null;
  const trailing = urlPath.endsWith("/");
  const segments = urlPath.split("/").filter((s) => s !== "");
  if (segments.some(unsafeSegment)) return null;
  const fsPath = join(outputDir, ...segments);
  try {
    const s = await stat(fsPath);
    if (s.isFile()) return trailing ? null : urlPath;
    if (!s.isDirectory()) return null;
    if (!(await stat(join(fsPath, "index.html"))).isFile()) return null;
    return segments.length === 0 ? "/" : `/${segments.join("/")}/`;
  } catch {
    return null;
  }
}

/** A directory is re-checked (stat, then readdir if it changed) at most this often. */
export const LISTING_MIN_REREAD_MS = 5_000;
/**
 * A listing read while the directory's mtime was this recent is "unsettled": re-read at the next
 * check even when the mtime is unchanged. Covers coarse mtime ticks (an entry added in the same
 * tick as the read leaves the mtime as it was).
 */
export const LISTING_SETTLE_MS = 2_000;

/** One directory's entry names, shared by `exactPagePath` and `resolvePostKey`. */
interface Listing {
  /** When the directory was last stat'ed (Date.now()). */
  checkedAt: number;
  mtimeMs: number;
  settled: boolean;
  names: Promise<Set<string>>;
  /** `releases/` only, built on first use: POST_KEY names by lowercase. */
  postKeys?: Promise<Map<string, string>>;
}
const listings = new Map<string, Listing>();
const refreshing = new Map<string, Promise<Listing | null>>();

/**
 * Directory `dir`'s cached listing, or null when it is not a readable directory. Within
 * `LISTING_MIN_REREAD_MS` of the last check the cache answers with no filesystem call at all, so
 * a rebuild-all that changes `releases/`'s mtime continuously costs at most one ~35k-entry
 * readdir per interval, not one per request. After the interval: one stat, and a readdir only
 * when the mtime changed or the listing was unsettled. Concurrent refreshes share one stat and
 * readdir. Only directories that exist are cached (bounded by the site's own directory count);
 * a failed readdir is dropped so the next call tries again.
 */
function listing(dir: string): Promise<Listing | null> {
  const hit = listings.get(dir);
  if (hit && Date.now() - hit.checkedAt < LISTING_MIN_REREAD_MS) return Promise.resolve(hit);
  let pending = refreshing.get(dir);
  if (!pending) {
    pending = refresh(dir, hit).finally(() => refreshing.delete(dir));
    refreshing.set(dir, pending);
  }
  return pending;
}

async function refresh(dir: string, hit: Listing | undefined): Promise<Listing | null> {
  const now = Date.now();
  let mtimeMs: number;
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) throw new Error("not a directory");
    mtimeMs = s.mtimeMs;
  } catch {
    listings.delete(dir);
    return null;
  }
  if (hit && hit.settled && hit.mtimeMs === mtimeMs && listings.get(dir) === hit) {
    hit.checkedAt = now;
    return hit;
  }
  const fresh: Listing = { checkedAt: now, mtimeMs, settled: now - mtimeMs >= LISTING_SETTLE_MS, names: readdir(dir).then((names) => new Set(names)) };
  listings.set(dir, fresh);
  fresh.names.catch(() => listings.get(dir) === fresh && listings.delete(dir));
  return fresh;
}

/** The names in directory `dir` (cached, see `listing`), or null when it is not a readable directory. */
async function entryNames(dir: string): Promise<Set<string> | null> {
  try {
    return (await (await listing(dir))?.names) ?? null;
  } catch {
    return null;
  }
}

/**
 * `pagePath`, but only when every segment of `urlPath` is an on-disk name in exactly that case
 * (compared against directory listings, never by stat'ing the asked-for name). So the answer is
 * the same on a case-sensitive filesystem (Linux) and a case-insensitive one (NTFS, APFS), where
 * `pagePath("/Ministries/Health")` alone would find `ministries/health/`.
 */
export async function exactPagePath(outputDir: string, urlPath: string): Promise<string | null> {
  if (!urlPath.startsWith("/")) return null;
  const segments = urlPath.split("/").filter((s) => s !== "");
  if (segments.some(unsafeSegment)) return null;
  let dir = outputDir;
  for (const segment of segments) {
    if (!(await entryNames(dir))?.has(segment)) return null;
    dir = join(dir, segment);
  }
  return pagePath(outputDir, urlPath);
}

/**
 * The on-disk post directory name under `releases/` whose lowercase equals `key.toLowerCase()`,
 * or null (parity plan 3, url-compat T2). Built from `releases/`'s one shared listing (the same
 * one `exactPagePath` uses), keeping only names that match `POST_KEY`, refreshed as `listing`
 * says (at most every `LISTING_MIN_REREAD_MS`, re-read when the mtime changes) — a post the
 * builder adds or deletes changes it. It never stats the requested name, so the answer is the
 * same on case-insensitive NTFS and APFS as on Linux. The caller still checks the page exists
 * (`pagePath`): a directory emptied by a delete is listed but is not a page.
 */
export async function resolvePostKey(outputDir: string, key: string): Promise<string | null> {
  if (!POST_KEY.test(key)) return null;
  try {
    const releases = await listing(join(outputDir, "releases"));
    if (!releases) return null;
    releases.postKeys ??= releases.names.then((names) => {
      const map = new Map<string, string>();
      for (const name of names) if (POST_KEY.test(name) && !map.has(name.toLowerCase())) map.set(name.toLowerCase(), name);
      return map;
    });
    return (await releases.postKeys).get(key.toLowerCase()) ?? null;
  } catch {
    return null;
  }
}
