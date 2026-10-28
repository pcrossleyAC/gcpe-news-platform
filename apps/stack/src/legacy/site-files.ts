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

/** A directory's entry names, cached until its mtime changes. */
interface Listing {
  mtimeMs: number;
  names: Promise<Set<string>>;
}
const listings = new Map<string, Listing>();

/**
 * The names in directory `dir`, or null when it is not a readable directory. One stat per call;
 * the readdir runs again only when the directory's mtime changes (an entry added, removed or
 * renamed — a build that only rewrites a file in place leaves the names, and so the answer, alone).
 * Concurrent callers share one readdir. Only directories that exist are cached, so the cache is
 * bounded by the site's own directory count.
 */
async function entryNames(dir: string): Promise<Set<string> | null> {
  let mtimeMs: number;
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) return null;
    mtimeMs = s.mtimeMs;
  } catch {
    listings.delete(dir);
    return null;
  }
  let hit = listings.get(dir);
  if (hit?.mtimeMs !== mtimeMs) {
    hit = { mtimeMs, names: readdir(dir).then((names) => new Set(names)) };
    listings.set(dir, hit);
    // A failed readdir is not cached: the next call tries again.
    hit.names.catch(() => listings.get(dir) === hit && listings.delete(dir));
  }
  try {
    return await hit.names;
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

/** Per OUTPUT_DIR: `releases/`'s post-key directory names by lowercase, and the mtime they were read at. */
const postKeys = new Map<string, { mtimeMs: number; byLower: Promise<Map<string, string>> }>();

/**
 * The on-disk post directory name under `releases/` whose lowercase equals `key.toLowerCase()`,
 * or null (parity plan 3, url-compat T2). Built from one `readdir(releases)` keeping only names
 * that match `POST_KEY`, cached per `outputDir` and re-read when `releases/`'s mtime changes —
 * a post the builder adds or deletes changes it. It never stats the requested name, so the
 * answer is the same on case-insensitive NTFS and APFS as on Linux. The caller still checks the
 * page exists (`pagePath`): a directory emptied by a delete is listed but is not a page.
 */
export async function resolvePostKey(outputDir: string, key: string): Promise<string | null> {
  if (!POST_KEY.test(key)) return null;
  const releases = join(outputDir, "releases");
  let mtimeMs: number;
  try {
    const s = await stat(releases);
    if (!s.isDirectory()) return null;
    mtimeMs = s.mtimeMs;
  } catch {
    postKeys.delete(outputDir);
    return null;
  }
  let hit = postKeys.get(outputDir);
  if (hit?.mtimeMs !== mtimeMs) {
    const byLower = readdir(releases).then((names) => {
      const map = new Map<string, string>();
      for (const name of names) if (POST_KEY.test(name) && !map.has(name.toLowerCase())) map.set(name.toLowerCase(), name);
      return map;
    });
    hit = { mtimeMs, byLower };
    postKeys.set(outputDir, hit);
    byLower.catch(() => postKeys.get(outputDir) === hit && postKeys.delete(outputDir));
  }
  try {
    return (await hit.byLower).get(key.toLowerCase()) ?? null;
  } catch {
    return null;
  }
}
