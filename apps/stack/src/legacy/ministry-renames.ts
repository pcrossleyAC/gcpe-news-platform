import { CATEGORY_KEY, type CategoryKind } from "../../../public-site/src/site-paths";
import { exactPagePath } from "./site-files";
import { resolveMinistrySuccessor } from "../ministry-successors";
import renamesJson from "./ministry-renames.json" with { type: "json" };

/**
 * news.gov's ministry (and sector) rename redirects as data (parity plan 3, url-compat T4):
 * the direct edges from the legacy `RedirectMiddleware` (`Redirect()`, `RedirectFromNewsroom`,
 * `RedirectFromConfig`), matched on whole segments (legacy matched prefixes, so `environment`
 * also caught `environment-assessment-…`). A key is one segment, or two ("a/b") for a nested
 * legacy path. Each value is one segment.
 */

export interface Renames {
  ministries: ReadonlyMap<string, string>;
  sectors: ReadonlyMap<string, string>;
}

function close(section: string, raw: unknown): ReadonlyMap<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`renames: "${section}" is not an object`);
  const edges = new Map<string, string>();
  for (const [key, value] of Object.entries(raw)) {
    const segments = key.split("/");
    if (segments.length > 2 || !segments.every((s) => CATEGORY_KEY.test(s))) throw new Error(`renames: bad ${section} key "${key}"`);
    if (typeof value !== "string" || !CATEGORY_KEY.test(value)) throw new Error(`renames: bad ${section} value for "${key}"`);
    edges.set(key, value);
  }
  const closed = new Map<string, string>();
  for (const [key, first] of edges) {
    // Follow single-segment keys only: a two-segment key is a path, never a value. The loop ends on a
    // value that is not a key, so every closed value is final (and `a → a` is caught as a cycle).
    const seen = new Set([key]);
    let value = first;
    while (edges.has(value)) {
      if (seen.has(value)) throw new Error(`renames: cycle in ${section} at "${value}"`);
      seen.add(value);
      value = edges.get(value)!;
    }
    closed.set(key, value);
  }
  return closed;
}

/** Validates the table and closes it transitively: every value is a final, single-segment key. */
export function loadRenames(json: unknown): Renames {
  if (typeof json !== "object" || json === null) throw new Error("renames: not an object");
  const body = json as { ministries?: unknown; sectors?: unknown };
  return { ministries: close("ministries", body.ministries), sectors: close("sectors", body.sectors) };
}

const RENAMES = loadRenames(renamesJson);

/** Words that are page parts under a category, never a nested ministry key. */
const RESERVED = new Set(["biography", "feed", "atom", "embed", "more-news", "morearticles", "archive", "releases", "stories", "factsheets", "updates", "top", "feature"]);

export interface ResolvedCategory {
  /** The final key (lowercase). */
  key: string;
  /** How many of the request's segments after the category it used. */
  consumed: 1 | 2;
  /** The request named some other page than this key's (a rename, successor or nested path). */
  moved: boolean;
}

/**
 * The category page a legacy `/<cat>/<segments…>` path now belongs to, or null (the site 404).
 * `segments` are the one or two path segments after the category (more are ignored); keys are
 * lowercased. "Has a page" is `exactPagePath` on `<cat>/<key>/`, which uses the shared cached
 * directory listings. Ministries, in order:
 * 1. a two-segment rename `a/b` → its value (consumed 2);
 * 2. `a` has a page → `a`; no page and `a` is renamed → the value (moved);
 * 3. nested: `b` is not reserved and has a page → `b` (consumed 2, moved);
 * then the successor table maps that key (moved). The final key must have a page; if it has none,
 * the key before it (the successor's source, or a two-segment rename's first segment) is used if it does.
 * `news-subscribe` is `tags`; sectors use only the sectors rename map.
 */
export async function resolveCategory(outputDir: string, cat: CategoryKind, segments: string[]): Promise<ResolvedCategory | null> {
  const [a, b] = segments.map((s) => s.toLowerCase());
  if (a === undefined || !CATEGORY_KEY.test(a)) return null;
  const hasPage = async (key: string) => (await exactPagePath(outputDir, `/${cat}/${key}/`)) !== null;

  if (cat === "sectors") {
    if (await hasPage(a)) return { key: a, consumed: 1, moved: false };
    const to = RENAMES.sectors.get(a);
    return to !== undefined && (await hasPage(to)) ? { key: to, consumed: 1, moved: true } : null;
  }
  if (cat !== "ministries") return (await hasPage(a)) ? { key: a, consumed: 1, moved: false } : null;

  let found: ResolvedCategory | null = null;
  // Where to fall back when the renamed / successor key has no page: the keys before it, nearest first.
  const earlier: ResolvedCategory[] = [];
  const pair = b !== undefined && CATEGORY_KEY.test(b) ? RENAMES.ministries.get(`${a}/${b}`) : undefined;
  if (pair !== undefined) {
    found = { key: pair, consumed: 2, moved: true };
    earlier.push({ key: a, consumed: 1, moved: true });
  } else if (await hasPage(a)) found = { key: a, consumed: 1, moved: false };
  else if (RENAMES.ministries.has(a)) found = { key: RENAMES.ministries.get(a)!, consumed: 1, moved: true };
  else if (b !== undefined && CATEGORY_KEY.test(b) && !RESERVED.has(b) && (await hasPage(b))) found = { key: b, consumed: 2, moved: true };
  if (found === null) {
    // Nothing named: the plan-2 successor behaviour still applies to the first segment.
    found = { key: a, consumed: 1, moved: false };
  }
  const successor = await resolveMinistrySuccessor(outputDir, found.key);
  const chosen = successor !== null ? { ...found, key: successor, moved: true } : found;
  // The final key has no page (a rename or successor to a page that is not built): use the nearest earlier key that has one.
  for (const candidate of successor !== null ? [chosen, found, ...earlier] : [chosen, ...earlier]) {
    if (await hasPage(candidate.key)) return candidate;
  }
  return null;
}
