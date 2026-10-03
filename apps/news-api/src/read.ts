import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import type { CategoryKind } from "@gcpe/events";
import { categories, categoryFeatures, home, resourceLinks, slides, type CategoryRow, type FeatureRow } from "./db/schema";
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
  const [row] = await db
    .select({ key: categories.key })
    .from(categories)
    .where(and(eq(categories.kind, kind), lowerEq(categories.key, key)));
  return row?.key ?? null;
}

function activeChildKey(key: string, all: CategoryRow[]): string | null {
  const child = all.find((r) => r.isActive && r.ministry?.parentKey?.toLowerCase() === key.toLowerCase());
  return child?.key ?? null;
}

async function allMinistries(db: Db): Promise<CategoryRow[]> {
  return db.select().from(categories).where(eq(categories.kind, "ministries")).orderBy(asc(categories.sortOrder), asc(categories.key));
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

export async function getMinister(db: Db, key: string, tz: string) {
  const [row] = await db.select().from(categories).where(and(eq(categories.kind, "ministries"), lowerEq(categories.key, key)));
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

export async function getSlide(db: Db, id: string, tz: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const [row] = await db.select().from(slides).where(eq(slides.id, id.toLowerCase()));
  return row ? toSlideDto(row, tz) : null;
}

export async function listResourceLinks(db: Db, tz: string) {
  return (await db.select().from(resourceLinks).orderBy(asc(resourceLinks.sortIndex))).map((l) => toResourceLinkDto(l, tz));
}
