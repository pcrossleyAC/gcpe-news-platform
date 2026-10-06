import { and, arrayContains, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import type { CategoryKind } from "@gcpe/events";
import { home, posts, type PostRow } from "./db/schema";
import { findCategoryKey, getFeatures } from "./read";

export const INDEX_KINDS = ["home", "ministries", "sectors", "tags", "themes"] as const;
type IndexKind = (typeof INDEX_KINDS)[number];

export interface ResolvedIndex {
  kind: IndexKind;
  key: string;
  topPostKey: string | null;
  featurePostKey: string | null;
}

export interface PostQueryOptions {
  postKind?: string;
  count?: number;
  skip?: number;
}

export const MEDIA_TYPE_PATTERNS: Record<string, RegExp> = {
  video: /youtube\.com|youtu\.be/i,
  image: /flickr\.com|flic\.kr/i,
};

// Collated explicitly so the tie-break order doesn't depend on the DB's default collation.
const KEY_DESC = sql`${posts.key} collate "C" desc`;

export async function resolveIndex(db: Db, kind: string, key: string): Promise<ResolvedIndex | "unknown-kind" | "not-found"> {
  const k = kind.toLowerCase();
  if (!(INDEX_KINDS as readonly string[]).includes(k)) return "unknown-kind";
  const indexKind = k as IndexKind;
  if (indexKind === "home") {
    if (key.toLowerCase() !== "default") return "not-found";
    const [h] = await db.select().from(home).where(eq(home.key, "default"));
    return { kind: indexKind, key: "default", topPostKey: h?.topPostKey ?? null, featurePostKey: h?.featurePostKey ?? null };
  }
  const categoryKind = indexKind as CategoryKind;
  const canonical = await findCategoryKey(db, categoryKind, key);
  if (!canonical) return "not-found";
  const f = await getFeatures(db, categoryKind, canonical);
  return { kind: indexKind, key: canonical, topPostKey: f?.topPostKey ?? null, featurePostKey: f?.featurePostKey ?? null };
}

function conditions(idx: ResolvedIndex, opts: PostQueryOptions, excludeFeatured: boolean): SQL {
  const conds: SQL[] = [eq(posts.isPublished, true)];
  conds.push(
    !opts.postKind || opts.postKind.toLowerCase() === "default"
      ? inArray(posts.kind, ["releases", "stories"])
      : eq(posts.kind, opts.postKind.toLowerCase()),
  );
  if (idx.kind !== "home") conds.push(arrayContains(posts.indexKeys, [`${idx.kind}:${idx.key}`.toLowerCase()]));
  if (excludeFeatured) {
    const excluded = [idx.topPostKey, idx.featurePostKey].filter((k): k is string => !!k).map((k) => k.toLowerCase());
    if (excluded.length) conds.push(sql`lower(${posts.key}) NOT IN (${sql.join(excluded.map((e) => sql`${e}`), sql`, `)})`);
  }
  return and(...conds)!;
}

export async function latestPosts(db: Db, idx: ResolvedIndex, opts: PostQueryOptions): Promise<PostRow[]> {
  let q = db.select().from(posts).where(conditions(idx, opts, true)).orderBy(desc(posts.publishDate), KEY_DESC).$dynamic();
  if (opts.count !== undefined) q = q.limit(opts.count);
  if (opts.skip) q = q.offset(opts.skip);
  return q;
}

export async function postKeys(db: Db, idx: ResolvedIndex, opts: PostQueryOptions): Promise<{ key: string; kind: string }[]> {
  let q = db
    .select({ key: posts.key, kind: posts.kind })
    .from(posts)
    .where(conditions(idx, opts, false))
    .orderBy(desc(posts.publishDate), KEY_DESC)
    .$dynamic();
  if (opts.count !== undefined) q = q.limit(opts.count);
  if (opts.skip) q = q.offset(opts.skip);
  return q;
}

export async function getPost(db: Db, key: string): Promise<PostRow | undefined> {
  const [row] = await db.select().from(posts).where(and(eq(posts.isPublished, true), sql`lower(${posts.key}) = lower(${key})`));
  return row;
}

export async function getPostsByKeys(db: Db, keys: string[]): Promise<PostRow[]> {
  if (keys.length === 0) return [];
  const lowered = keys.map((k) => k.toLowerCase());
  const rows = await db
    .select()
    .from(posts)
    .where(and(eq(posts.isPublished, true), inArray(sql`lower(${posts.key})`, lowered)));
  const byKey = new Map(rows.map((r) => [r.key.toLowerCase(), r]));
  return lowered.map((k) => byKey.get(k)).filter((r): r is PostRow => r !== undefined);
}

export async function getPostByReference(db: Db, reference: string): Promise<{ key: string; kind: string } | undefined> {
  const [row] = await db
    .select({ key: posts.key, kind: posts.kind })
    .from(posts)
    .where(and(eq(posts.isPublished, true), sql`lower(${posts.reference}) = lower(${reference})`))
    .orderBy(desc(posts.publishDate), KEY_DESC)
    .limit(1);
  return row;
}

export async function latestMediaUri(db: Db, mediaType: string): Promise<string | null> {
  const pattern = MEDIA_TYPE_PATTERNS[mediaType.toLowerCase()];
  if (!pattern) return null;
  const rows = await db
    .select({ assetUrl: posts.assetUrl })
    .from(posts)
    .where(and(eq(posts.isPublished, true), eq(posts.hasMediaAssets, true), sql`${posts.assetUrl} ~* ${pattern.source}`))
    .orderBy(desc(posts.publishDate), KEY_DESC)
    .limit(1);
  return rows[0]?.assetUrl ?? null;
}
