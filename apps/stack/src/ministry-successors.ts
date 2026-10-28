import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RequestHandler } from "express";
import { CATEGORY_KEY as KEY, MINISTRY_SUCCESSORS_FILE } from "../../public-site/src/site-paths";

/**
 * Successor redirects (new-government spec §4): an old ministry's URLs 301 to its successor's.
 * The public site writes the table (`legacy/ministry-successors.json`, page id
 * `legacy-redirects`) from News API's `/api/v2/ministry-successors`, chains already resolved to
 * the final active ministry. Parity url-compat (plan 3 T4) composes its static rename table with
 * `resolveMinistrySuccessor`: renames first, then successors, one hop.
 */

/** `/ministries/<segment>` and anything beneath it (whole segment; any case, as Express routes). */
const PATH = /^\/ministries\/([^/]+)(\/.*)?$/i;

type Table = ReadonlyMap<string, string>;
const EMPTY: Table = new Map();
/** Per output dir: the table and the file's mtime+size it was read at. */
const cache = new Map<string, { stamp: string; table: Table }>();

function parseTable(text: string): Table {
  const body = JSON.parse(text) as { successors?: unknown };
  const table = new Map<string, string>();
  if (!body || typeof body.successors !== "object" || body.successors === null || Array.isArray(body.successors)) throw new Error("no successors object");
  for (const [from, to] of Object.entries(body.successors as Record<string, unknown>)) {
    // Only two different lowercased keys: `to` becomes a path segment of the Location.
    if (KEY.test(from) && typeof to === "string" && KEY.test(to) && from !== to) table.set(from, to);
  }
  return table;
}

/** The stat error last logged per output folder, so a persistent one logs once. */
const unreadable = new Map<string, string>();

/** The table at `outputDir`, re-read whenever the file's mtime or size changes. A missing or
 * unreadable file is an empty table: the site then serves whatever page is on disk. */
async function loadTable(outputDir: string): Promise<Table> {
  const path = join(outputDir, MINISTRY_SUCCESSORS_FILE);
  let stamp: string;
  try {
    const s = await stat(path);
    stamp = `${s.mtimeMs}:${s.size}`;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "error";
    // Logged once per folder and error code (EACCES/EBUSY while Windows replaces the file), not per request.
    if (code !== "ENOENT" && unreadable.get(outputDir) !== code) console.warn(`[stack] ministry successors unreadable: ${code}`);
    if (code === "ENOENT") unreadable.delete(outputDir);
    else unreadable.set(outputDir, code);
    cache.delete(outputDir);
    return EMPTY;
  }
  unreadable.delete(outputDir);
  const hit = cache.get(outputDir);
  if (hit?.stamp === stamp) return hit.table;
  let table = EMPTY;
  try {
    table = parseTable(await readFile(path, "utf8"));
  } catch {
    // Cached as empty for this stamp, so a bad file is reported once, not on every request.
    console.warn(`[stack] ignoring malformed ${MINISTRY_SUCCESSORS_FILE}`);
  }
  cache.set(outputDir, { stamp, table });
  return table;
}

/** The active ministry `key`'s URLs now belong to (case-insensitive), or null. */
export async function resolveMinistrySuccessor(outputDir: string, key: string): Promise<string | null> {
  return (await loadTable(outputDir)).get(key.toLowerCase()) ?? null;
}

/**
 * `/ministries/<old>[/<rest>][?query]` → `301 {basePath}/ministries/<new>/<rest>[?query]` for every
 * `<old>` in the table (whole segment, any case); anything else falls through. `basePath` is the
 * prefix this handler is mounted under ("" at the root, "/site" under /site), so the Location is
 * always a root-relative path on this site. The query is carried byte for byte. GET/HEAD only;
 * no-store, so a proxy never pins a redirect that a reactivation (N12) later removes.
 * Mount before express.static: an inactive ministry's page still builds.
 */
export function ministrySuccessorRedirects(outputDir: string, basePath: string): RequestHandler {
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const m = PATH.exec(req.path);
    if (!m) return next();
    let segment: string;
    try {
      segment = decodeURIComponent(m[1]!); // express.static decodes too: /ministries/%61/ is a's page
    } catch {
      return next();
    }
    resolveMinistrySuccessor(outputDir, segment).then((to) => {
      if (!to) return next();
      const q = req.url.indexOf("?");
      const query = q === -1 ? "" : req.url.slice(q);
      res.setHeader("Cache-Control", "no-store");
      res.redirect(301, `${basePath}/ministries/${to}${m[2] ?? "/"}${query}`);
    }, next);
  };
}
