import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import { countBouncedEmails, THRESHOLD_WINDOW_DAYS } from "../bounces";
import { listCategories, lists, subscriberHistory, subscribers, subscriptions, SUBSCRIBER_STATUSES, type SubscriberStatus } from "../db/schema";
import { MEDIA_CATEGORY, PUBLIC_CATEGORIES } from "../lists";

export const STATUS_FILTERS = ["all", ...SUBSCRIBER_STATUSES] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];
/** Fixed, like legacy's paginator: staff page through results, they don't choose a size. */
export const PAGE_SIZE = 50;
/** A subscriber with more history than this is vanishingly rare; the screen shows the newest. */
export const HISTORY_LIMIT = 500;

export interface SubscriberSummary {
  id: string;
  email: string;
  status: SubscriberStatus;
  source: string;
  asItHappens: boolean;
  digest: boolean;
  createdAt: Date;
  needsAttention: string | null;
}
export interface SubscriberPage { total: number; page: number; pageSize: number; items: SubscriberSummary[] }
export interface SubscriberDetail extends SubscriberSummary {
  verifiedAt: Date | null;
  endedAt: Date | null;
  attentionAt: Date | null;
  allNews: boolean;
  /** Public list keys (`<category>:<key>`), never `*` (see allNews) or a media key. */
  listKeys: string[];
  mediaLists: { listKey: string; name: string }[];
  /** Why a `disabled` subscriber is disabled — the latest of bounce-disabled / staff-deactivated in their history; null when not disabled or unexplained (e.g. imported that way). */
  disabledReason: "bounces" | "staff" | null;
  /** Hard-bounced emails counted toward the threshold right now (bounces.ts's own count). */
  bouncedEmails: number;
  bounceWindowDays: number;
}
export interface HistoryEntry { at: Date; actor: string; action: string; detail: string }
export interface ListOptions { categories: { key: string; name: string; lists: { listKey: string; name: string }[] }[] }

/** Escapes LIKE's metacharacters so a staff search for `pat_smith` or `100%` matches those
 * characters literally; paired with `ESCAPE '\'` below. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const summaryColumns = {
  id: subscribers.id,
  email: subscribers.email,
  status: subscribers.status,
  source: subscribers.source,
  asItHappens: subscribers.asItHappens,
  digest: subscribers.digest,
  createdAt: subscribers.createdAt,
  needsAttention: subscribers.needsAttention,
};

export async function searchSubscribers(db: DbOrTx, input: { q: string; status: StatusFilter; page: number }): Promise<SubscriberPage> {
  const term = input.q.trim().toLowerCase();
  const conds: SQL[] = [];
  if (term) conds.push(sql`lower(${subscribers.email}) LIKE ${`%${escapeLike(term)}%`} ESCAPE '\\'`);
  if (input.status !== "all") conds.push(eq(subscribers.status, input.status));
  const where = conds.length ? and(...conds) : undefined;
  const page = Math.max(1, input.page);
  const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(subscribers).where(where)) as [{ n: number }];
  const items = await db
    .select(summaryColumns)
    .from(subscribers)
    .where(where)
    .orderBy(sql`lower(${subscribers.email})`, asc(subscribers.id))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);
  return { total: n, page, pageSize: PAGE_SIZE, items };
}

export async function getSubscriberDetail(db: DbOrTx, id: string): Promise<SubscriberDetail | null> {
  const [s] = await db.select().from(subscribers).where(eq(subscribers.id, id));
  if (!s) return null;
  const subs = await db
    .select({ listKey: subscriptions.listKey, name: lists.name })
    .from(subscriptions)
    .leftJoin(lists, eq(lists.listKey, subscriptions.listKey))
    .where(eq(subscriptions.subscriberId, id))
    .orderBy(asc(subscriptions.listKey));
  const isMedia = (k: string) => k.startsWith(`${MEDIA_CATEGORY}:`);
  let disabledReason: SubscriberDetail["disabledReason"] = null;
  if (s.status === "disabled") {
    const [last] = await db
      .select({ action: subscriberHistory.action })
      .from(subscriberHistory)
      .where(and(eq(subscriberHistory.subscriberId, id), inArray(subscriberHistory.action, ["bounce-disabled", "staff-deactivated"])))
      // `at` ties happen: Postgres's `now()` is stable for a whole transaction, so two history
      // rows written in the same transaction share the exact same default. `id` (a random
      // uuid) breaks the tie deterministically across repeated calls, but which of the two
      // "wins" is arbitrary — there's no sequence or other ordering column on this table to
      // resolve it chronologically instead.
      .orderBy(desc(subscriberHistory.at), desc(subscriberHistory.id))
      .limit(1);
    disabledReason = last ? (last.action === "bounce-disabled" ? "bounces" : "staff") : null;
  }
  return {
    id: s.id, email: s.email, status: s.status, source: s.source, asItHappens: s.asItHappens, digest: s.digest,
    createdAt: s.createdAt, needsAttention: s.needsAttention, verifiedAt: s.verifiedAt, endedAt: s.endedAt, attentionAt: s.attentionAt,
    allNews: subs.some((r) => r.listKey === "*"),
    listKeys: subs.filter((r) => r.listKey !== "*" && !isMedia(r.listKey)).map((r) => r.listKey),
    mediaLists: subs.filter((r) => isMedia(r.listKey)).map((r) => ({ listKey: r.listKey, name: r.name ?? r.listKey })),
    disabledReason,
    bouncedEmails: await countBouncedEmails(db, id),
    bounceWindowDays: THRESHOLD_WINDOW_DAYS,
  };
}

export async function listHistory(db: DbOrTx, id: string): Promise<HistoryEntry[] | null> {
  const [s] = await db.select({ id: subscribers.id }).from(subscribers).where(eq(subscribers.id, id));
  if (!s) return null;
  return db
    .select({ at: subscriberHistory.at, actor: subscriberHistory.actor, action: subscriberHistory.action, detail: subscriberHistory.detail })
    .from(subscriberHistory)
    .where(eq(subscriberHistory.subscriberId, id))
    // `id` only breaks a tie on `at` (see the same tiebreaker in getSubscriberDetail above);
    // it isn't chronological, just deterministic, since `subscriber_history` has no sequence
    // column and two rows written in the same transaction can share an identical `at`.
    .orderBy(desc(subscriberHistory.at), desc(subscriberHistory.id))
    .limit(HISTORY_LIMIT);
}

/** What the staff preferences form offers: active lists in enabled public categories (the
 * same set the public Subscribe API accepts, lists.ts's activeListKeys), grouped by category
 * in display order. Media lists are never offered here — they're managed per list. */
export async function listOptions(db: DbOrTx): Promise<ListOptions> {
  const rows = await db
    .select({ category: listCategories.key, categoryName: listCategories.name, listKey: lists.listKey, name: lists.name })
    .from(lists)
    .innerJoin(listCategories, eq(listCategories.key, lists.category))
    .where(and(inArray(lists.category, [...PUBLIC_CATEGORIES]), eq(lists.active, true), eq(listCategories.enabled, true)))
    .orderBy(asc(listCategories.sortOrder), asc(lists.sortOrder), asc(lists.name));
  const categories: ListOptions["categories"] = [];
  for (const r of rows) {
    let c = categories.at(-1);
    if (!c || c.key !== r.category) categories.push((c = { key: r.category, name: r.categoryName, lists: [] }));
    c.lists.push({ listKey: r.listKey, name: r.name });
  }
  return { categories };
}
