import { and, arrayContains, asc, desc, eq, getTableColumns, inArray, lte, sql, type SQL } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import type { CategoryKind } from "@gcpe/events";
import { home, posts, type CategoryRow, type PostRow } from "./db/schema";
import { activeCategoriesWithFeatures, findCategoryKey, getFeatures } from "./read";

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
/** Every latest list's order: newest first, then key. */
const LATEST_ORDER = [desc(posts.publishDate), KEY_DESC];

// Every posts column v1 renders: search_text and search_vector are large and never part of a v1 response.
const { searchText: _searchText, searchVector: _searchVector, embeddingTextHash: _embeddingTextHash, ...postReadColumns } = getTableColumns(posts);

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

/** The token `indexKeysFor` stores for a post in a category. */
const indexToken = (kind: string, key: string) => `${kind}:${key}`.toLowerCase();

/**
 * Which posts a latest list may show, shared by v1's Latest and Keys and v2's per-category batch so
 * they can never disagree: published posts of the requested post kind (default releases and
 * stories), in the index whose token is given (null: home, every post).
 */
function visibleIn(token: SQL | null, opts: PostQueryOptions): SQL[] {
  const conds: SQL[] = [eq(posts.isPublished, true)];
  conds.push(
    !opts.postKind || opts.postKind.toLowerCase() === "default"
      ? inArray(posts.kind, ["releases", "stories"])
      : eq(posts.kind, opts.postKind.toLowerCase()),
  );
  if (token) conds.push(arrayContains(posts.indexKeys, sql`ARRAY[${token}]::text[]`));
  return conds;
}

/** Leaves out an index's top and feature posts, matched case-insensitively; a null slot leaves out nothing. */
function notFeatured(top: SQL, feature: SQL): SQL {
  return sql`(lower(${posts.key}) IS DISTINCT FROM lower(${top}) AND lower(${posts.key}) IS DISTINCT FROM lower(${feature}))`;
}

function conditions(idx: ResolvedIndex, opts: PostQueryOptions, excludeFeatured: boolean): SQL {
  const conds = visibleIn(idx.kind === "home" ? null : sql`${indexToken(idx.kind, idx.key)}`, opts);
  if (excludeFeatured) conds.push(notFeatured(sql`${idx.topPostKey}::text`, sql`${idx.featurePostKey}::text`));
  return and(...conds)!;
}

export async function latestPosts(db: Db, idx: ResolvedIndex, opts: PostQueryOptions): Promise<PostRow[]> {
  let q = db.select(postReadColumns).from(posts).where(conditions(idx, opts, true)).orderBy(...LATEST_ORDER).$dynamic();
  if (opts.count !== undefined) q = q.limit(opts.count);
  if (opts.skip) q = q.offset(opts.skip);
  return q;
}

export async function postKeys(db: Db, idx: ResolvedIndex, opts: PostQueryOptions): Promise<{ key: string; kind: string }[]> {
  let q = db
    .select({ key: posts.key, kind: posts.kind })
    .from(posts)
    .where(conditions(idx, opts, false))
    .orderBy(...LATEST_ORDER)
    .$dynamic();
  if (opts.count !== undefined) q = q.limit(opts.count);
  if (opts.skip) q = q.offset(opts.skip);
  return q;
}

/** The most latest posts per category `latestPerCategory` returns (a sector index shows three). */
export const MAX_LATEST_PER_CATEGORY = 3;

export interface CategoryLatest {
  category: CategoryRow;
  topPost: PostRow | null;
  featurePost: PostRow | null;
  /** What v1's Latest answers for this category with the same count: top and feature left out. */
  latest: PostRow[];
}

/**
 * `GET /api/v2/categories/{kind}/latest` (P4-R11): every active category of a kind (as
 * `activeCategoriesWithFeatures` lists them) with its newest `count` posts and its top and feature
 * posts. Three queries whatever the number of categories: the categories, one windowed query over
 * the posts of all of them (`latestPosts`' own visibility, exclusion and order), and one
 * `getPostsByKeys` for every top and feature post (published only, any kind, as v1's /api/Posts).
 */
export async function latestPerCategory(db: Db, kind: CategoryKind, count: number): Promise<CategoryLatest[]> {
  const cats = await activeCategoriesWithFeatures(db, kind);
  if (cats.length === 0) return [];
  const textArray = (values: (string | null)[]) => sql`ARRAY[${sql.join(values.map((v) => sql`${v}`), sql`, `)}]::text[]`;
  const tokens = textArray(cats.map((x) => indexToken(kind, x.row.key)));
  const tops = textArray(cats.map((x) => x.feature?.topPostKey ?? null));
  const features = textArray(cats.map((x) => x.feature?.featurePostKey ?? null));
  // The window ranks narrow rows (key, category) only; the full rows of the few that rank within
  // `count` are joined back by primary key, so a ministry with thousands of posts never sorts its
  // documents.
  const ranked = db
    .select({
      key: posts.key,
      token: sql<string>`c.token`.as("category_token"),
      rank: sql<number>`row_number() OVER (PARTITION BY c.token ORDER BY ${sql.join(LATEST_ORDER, sql`, `)})`.mapWith(Number).as("category_rank"),
    })
    .from(posts)
    .innerJoin(sql`unnest(${tokens}, ${tops}, ${features}) AS c(token, top_key, feature_key)`, sql`true`)
    .where(and(...visibleIn(sql`c.token`, {}), notFeatured(sql`c.top_key`, sql`c.feature_key`)))
    .as("ranked");
  const rows = await db
    .select({ post: postReadColumns, categoryToken: ranked.token })
    .from(posts)
    .innerJoin(ranked, eq(posts.key, ranked.key))
    .where(lte(ranked.rank, count))
    .orderBy(asc(ranked.token), asc(ranked.rank));
  const latestByToken = new Map<string, PostRow[]>();
  for (const { post, categoryToken } of rows) {
    const list = latestByToken.get(categoryToken) ?? [];
    list.push(post);
    latestByToken.set(categoryToken, list);
  }
  const featuredKeys = [...new Set(cats.flatMap((x) => [x.feature?.topPostKey, x.feature?.featurePostKey]).filter((k): k is string => !!k).map((k) => k.toLowerCase()))];
  const found = new Map((await getPostsByKeys(db, featuredKeys)).map((p) => [p.key.toLowerCase(), p]));
  const pick = (k: string | null | undefined) => (k ? (found.get(k.toLowerCase()) ?? null) : null);
  return cats.map((x) => ({
    category: x.row,
    topPost: pick(x.feature?.topPostKey),
    featurePost: pick(x.feature?.featurePostKey),
    latest: latestByToken.get(indexToken(kind, x.row.key)) ?? [],
  }));
}

export async function getPost(db: Db, key: string): Promise<PostRow | undefined> {
  const [row] = await db.select(postReadColumns).from(posts).where(and(eq(posts.isPublished, true), sql`lower(${posts.key}) = lower(${key})`));
  return row;
}

export async function getPostsByKeys(db: Db, keys: string[]): Promise<PostRow[]> {
  if (keys.length === 0) return [];
  const lowered = keys.map((k) => k.toLowerCase());
  const rows = await db
    .select(postReadColumns)
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
