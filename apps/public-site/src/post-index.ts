import { arrayContains, asc, desc, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import { sitePosts, siteState } from "./db/schema";
import type { PostDto } from "./dto";
import { membershipOf, type Membership } from "./rebuild-set";

const ENGLISH = 4105;

export interface IndexedPost {
  key: string;
  kind: string;
  headline: string;
  summary: string | null;
  publishDate: string;
  month: string;
  categories: string[];
  /** leadMinistryOf(post); absent reads as null (no lead). */
  leadMinistry?: string | null;
}

/** The lead ministry key the release page shows, lower-cased: `leadMinistryKey ?? ministryKeys[0]`
 * (the builder matches it against the ministries case-insensitively). */
export function leadMinistryOf(post: Pick<PostDto, "leadMinistryKey" | "ministryKeys">): string | null {
  return (post.leadMinistryKey ?? post.ministryKeys[0])?.toLowerCase() || null;
}

/** The English headline (or the first document's, or the key), as the release page shows it. */
export function headlineOf(post: PostDto): string {
  const d = post.documents.find((x) => x.languageId === ENGLISH) ?? post.documents[0];
  return d?.headline?.trim() || post.key;
}

/** null when the post has no usable publish month. */
export function indexEntryOf(key: string, post: PostDto): IndexedPost | null {
  const m = membershipOf(post);
  if (!m) return null;
  return { key, kind: post.kind, headline: headlineOf(post), summary: post.summary, publishDate: post.publishDate, month: m.month, categories: m.categories, leadMinistry: leadMinistryOf(post) };
}

export const membershipOfEntry = (p: IndexedPost): Membership => ({ month: p.month, day: p.publishDate.slice(0, 10), categories: p.categories });

export interface PostIndex {
  get(key: string): Promise<IndexedPost | null>;
  put(p: IndexedPost): Promise<void>;
  remove(key: string): Promise<void>;
  inMonth(month: string): Promise<IndexedPost[]>;
  months(): Promise<{ month: string; count: number }[]>;
  keys(): Promise<string[]>;
  categories(): Promise<string[]>;
  inCategory(token: string): Promise<string[]>;
  /** Keys of the posts whose lead ministry (leadMinistryOf) is `key`, any case. Indexed. */
  withLeadMinistry(key: string): Promise<string[]>;
  /** Posts whose BC calendar day (the publish date as written) is in [start, endExclusive), newest
   * first; a null end is open. The government-term rule (new-government spec N1). */
  inDayRange(start: string, endExclusive: string | null): Promise<IndexedPost[]>;
  countInDayRange(start: string, endExclusive: string | null): Promise<number>;
  /** NG-R18: the hash of the terms snapshot the term pages were last queued for (site_state). */
  appliedTermsHash(): Promise<string | null>;
  setAppliedTermsHash(hash: string | null): Promise<void>;
}

const columns = {
  key: sitePosts.key,
  kind: sitePosts.kind,
  headline: sitePosts.headline,
  summary: sitePosts.summary,
  publishDate: sitePosts.publishDate,
  month: sitePosts.month,
  categories: sitePosts.categories,
  leadMinistry: sitePosts.leadMinistry,
};

/** The BC day is the publish date's own calendar date (no time-zone maths), like `month`. */
const inDays = (start: string, endExclusive: string | null) => {
  const day = sql`substr(${sitePosts.publishDate}, 1, 10)`;
  return endExclusive === null ? sql`${day} >= ${start}` : sql`${day} >= ${start} AND ${day} < ${endExclusive}`;
};

export function postIndex(db: DbOrTx): PostIndex {
  return {
    async get(key) {
      const [row] = await db.select(columns).from(sitePosts).where(eq(sitePosts.key, key));
      return row ?? null;
    },
    async put(p) {
      const values = { ...p, leadMinistry: p.leadMinistry ?? null, publishedAt: new Date(p.publishDate), indexedAt: sql`now()` };
      await db.insert(sitePosts).values(values).onConflictDoUpdate({ target: sitePosts.key, set: values });
    },
    async remove(key) {
      await db.delete(sitePosts).where(eq(sitePosts.key, key));
    },
    async inMonth(month) {
      return db.select(columns).from(sitePosts).where(eq(sitePosts.month, month)).orderBy(desc(sitePosts.publishedAt), sql`${sitePosts.key} collate "C" desc`);
    },
    async months() {
      return db
        .select({ month: sitePosts.month, count: sql<number>`count(*)::int` })
        .from(sitePosts)
        .groupBy(sitePosts.month)
        .orderBy(desc(sitePosts.month));
    },
    async keys() {
      return (await db.select({ key: sitePosts.key }).from(sitePosts)).map((r) => r.key);
    },
    async categories() {
      const { rows } = await db.execute<{ c: string }>(sql`SELECT DISTINCT unnest(categories) AS c FROM site_posts ORDER BY 1`);
      return rows.map((r) => r.c);
    },
    async inDayRange(start, endExclusive) {
      return db.select(columns).from(sitePosts).where(inDays(start, endExclusive)).orderBy(desc(sitePosts.publishedAt), sql`${sitePosts.key} collate "C" desc`);
    },
    async countInDayRange(start, endExclusive) {
      const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(sitePosts).where(inDays(start, endExclusive));
      return row?.n ?? 0;
    },
    async appliedTermsHash() {
      const [row] = await db.select({ h: siteState.termsHash }).from(siteState).where(eq(siteState.id, 1));
      return row?.h ?? null;
    },
    async setAppliedTermsHash(hash) {
      await db.insert(siteState).values({ id: 1, termsHash: hash }).onConflictDoUpdate({ target: siteState.id, set: { termsHash: hash, updatedAt: sql`now()` } });
    },
    async inCategory(token) {
      return (await db.select({ key: sitePosts.key }).from(sitePosts).where(arrayContains(sitePosts.categories, [token])).orderBy(asc(sitePosts.key))).map((r) => r.key);
    },
    async withLeadMinistry(key) {
      return (await db.select({ key: sitePosts.key }).from(sitePosts).where(eq(sitePosts.leadMinistry, key.toLowerCase())).orderBy(asc(sitePosts.key))).map((r) => r.key);
    },
  };
}
