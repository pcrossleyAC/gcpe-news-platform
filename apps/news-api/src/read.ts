import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import type { CategoryKind, GovernmentTermsPayload } from "@gcpe/events";
import { categories, categoryFeatures, governmentTerms, home, resourceLinks, siteSettings, slides, type CategoryRow, type FeatureRow } from "./db/schema";
import { toCategoryDto, toHomeDto, toMinisterDto, toMinistryDto, toResourceLinkDto, toSlideDto } from "./dto";

const lowerEq = (col: typeof categories.key, value: string) => sql`lower(${col}) = lower(${value})`;

async function featureMap(db: Db, kind: CategoryKind): Promise<Map<string, FeatureRow>> {
  const rows = await db.select().from(categoryFeatures).where(eq(categoryFeatures.kind, kind));
  return new Map(rows.map((r) => [r.key, r]));
}

export async function getFeatures(db: Db, kind: CategoryKind, key: string): Promise<FeatureRow | undefined> {
  const [row] = await db
    .select()
    .from(categoryFeatures)
    .where(and(eq(categoryFeatures.kind, kind), eq(categoryFeatures.key, key.toLowerCase())));
  return row;
}

export async function findCategoryKey(db: Db, kind: CategoryKind, key: string): Promise<string | null> {
  const conds = [eq(categories.kind, kind), lowerEq(categories.key, key)];
  // A non-public ministry (Q54) resolves the same as an unknown key: sectors, themes and tags
  // are always public, so they carry no such filter.
  if (kind === "ministries") conds.push(eq(categories.isPublic, true));
  const [row] = await db
    .select({ key: categories.key })
    .from(categories)
    .where(and(...conds));
  return row?.key ?? null;
}

function activeChildKey(key: string, all: CategoryRow[]): string | null {
  const child = all.find((r) => r.isActive && r.ministry?.parentKey?.toLowerCase() === key.toLowerCase());
  return child?.key ?? null;
}

async function allMinistries(db: Db): Promise<CategoryRow[]> {
  return db
    .select()
    .from(categories)
    .where(and(eq(categories.kind, "ministries"), eq(categories.isPublic, true)))
    .orderBy(asc(categories.sortOrder), asc(categories.key));
}

export async function listMinistries(db: Db, tz: string) {
  const rows = await allMinistries(db);
  const features = await featureMap(db, "ministries");
  return rows.map((r) => toMinistryDto(r, features.get(r.key.toLowerCase()), activeChildKey(r.key, rows), tz));
}

export async function getMinistry(db: Db, key: string, tz: string) {
  const rows = await allMinistries(db);
  const row = rows.find((r) => r.key.toLowerCase() === key.toLowerCase());
  if (!row) return null;
  return toMinistryDto(row, await getFeatures(db, "ministries", row.key), activeChildKey(row.key, rows), tz);
}

/** How far `resolveSuccessors` follows a chain before giving up on it. */
const MAX_SUCCESSOR_HOPS = 20;

/**
 * Each handed-over ministry → the active ministry its URLs should 301 to (new-government §4).
 * Follows the first successor (N7) until it reaches a key in `active`; a cycle, a successor that
 * is neither active nor itself handed over (a dead end), or more than 20 hops gives no entry.
 * A key that is itself active never redirects. Keys are compared as given: pass them lowercased.
 */
export function resolveSuccessors(raw: Record<string, string[]>, active: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [from, successors] of Object.entries(raw)) {
    if (active.has(from) || !successors.length) continue;
    const seen = new Set([from]);
    let cur = successors[0]!;
    for (let hop = 1; hop <= MAX_SUCCESSOR_HOPS; hop++) {
      if (active.has(cur)) {
        out[from] = cur;
        break;
      }
      const next = Object.hasOwn(raw, cur) ? raw[cur]![0] : undefined;
      if (next === undefined || seen.has(cur)) break;
      seen.add(cur);
      cur = next;
    }
  }
  return out;
}

/** `GET /api/v2/ministry-successors`: every inactive ministry's final active, public successor,
 * keys lowercased. An active ministry's (stale) list is ignored; reactivating clears it anyway (N12). */
export async function ministrySuccessors(db: Db): Promise<Record<string, string>> {
  const rows = await db
    .select({ key: categories.key, isActive: categories.isActive, isPublic: categories.isPublic, ministry: categories.ministry })
    .from(categories)
    .where(eq(categories.kind, "ministries"));
  const raw: Record<string, string[]> = {};
  const active = new Set<string>();
  for (const r of rows) {
    const key = r.key.toLowerCase();
    if (r.isActive) {
      if (r.isPublic) active.add(key);
      continue;
    }
    const successors = (r.ministry?.successorKeys ?? []).map((k) => k.toLowerCase());
    if (successors.length) raw[key] = successors;
  }
  return resolveSuccessors(raw, active);
}

export async function getMinister(db: Db, key: string, tz: string) {
  const [row] = await db
    .select()
    .from(categories)
    .where(and(eq(categories.kind, "ministries"), lowerEq(categories.key, key), eq(categories.isPublic, true)));
  return row ? toMinisterDto(row, tz) : null;
}

export async function listCategories(db: Db, kind: Exclude<CategoryKind, "ministries">, tz: string) {
  const rows = await db.select().from(categories).where(eq(categories.kind, kind)).orderBy(asc(categories.sortOrder), asc(categories.key));
  const features = await featureMap(db, kind);
  return rows.map((r) => toCategoryDto(r, features.get(r.key.toLowerCase()), tz));
}

export async function getCategory(db: Db, kind: Exclude<CategoryKind, "ministries">, key: string, tz: string) {
  const [row] = await db.select().from(categories).where(and(eq(categories.kind, kind), lowerEq(categories.key, key)));
  return row ? toCategoryDto(row, await getFeatures(db, kind, row.key), tz) : null;
}

export async function getHome(db: Db, tz: string) {
  const [row] = await db.select().from(home).where(eq(home.key, "default"));
  return toHomeDto(row, tz);
}

export async function listSlides(db: Db, tz: string) {
  return (await db.select().from(slides).orderBy(asc(slides.sortIndex))).map((s) => toSlideDto(s, tz));
}

/**
 * `GET /api/v2/slides` (addendum §6.4): the public site's own shape, with the content's image
 * URL instead of base64 bytes, and `emergency` — true for NRMS's two pinned emergency slides
 * (sortIndex -2 and -1) — since v1's slide DTO has no sortIndex to derive it from.
 */
export async function listSlidesV2(db: Db) {
  return (await db.select().from(slides).orderBy(asc(slides.sortIndex))).map((s) => ({
    id: s.id,
    sortIndex: s.sortIndex,
    emergency: s.sortIndex < 0,
    headline: s.headline,
    summary: s.summary,
    actionUri: s.actionUri,
    actionLabel: s.actionLabel,
    imageUrl: s.imageUrl,
    justify: s.justify,
  }));
}

export async function getSlide(db: Db, id: string, tz: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const [row] = await db.select().from(slides).where(eq(slides.id, id.toLowerCase()));
  return row ? toSlideDto(row, tz) : null;
}

export async function listResourceLinks(db: Db, tz: string) {
  return (await db.select().from(resourceLinks).orderBy(asc(resourceLinks.sortIndex))).map((l) => toResourceLinkDto(l, tz));
}

/** The stored site settings, or null before the first published revision. */
export async function getSiteSettings(db: Db) {
  const [row] = await db.select().from(siteSettings).where(eq(siteSettings.id, 1));
  return row ? { revision: row.revision, publishedAt: row.publishedAt.toISOString(), document: row.document } : null;
}

/**
 * The stored government-terms snapshot, or null before the first one is published. Projects the
 * public fields explicitly rather than trusting what was stored (defence in depth).
 */
export async function getGovernmentTerms(db: Db): Promise<GovernmentTermsPayload | null> {
  const [row] = await db.select().from(governmentTerms).where(eq(governmentTerms.id, 1));
  if (!row) return null;
  const d = row.document;
  return {
    publishedAt: d.publishedAt,
    currentSlug: d.currentSlug,
    terms: d.terms.map((t) => ({ slug: t.slug, label: t.label, startDate: t.startDate, endDate: t.endDate, legacyArchiveUrl: t.legacyArchiveUrl })),
  };
}
