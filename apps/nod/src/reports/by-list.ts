/**
 * Active subscribers by list (spec §8): a snapshot of who receives each list now. It replaces
 * legacy's ActiveSubscribers (everyone), AsItHappens and DailyDigest (by timing) and
 * SubscriberListReport (per list); see C99.
 */
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import { lists, subscribers, subscriptions, type SubscriberSource } from "../db/schema";
import { staffListsView } from "../staff-lists";
import { localDateTime } from "./range";
import type { CsvCell } from "./csv";

export const ALL_SUBSCRIBERS = "all";
export const ALL_NEWS = "*";
export const TIMING_FILTERS = ["any", "as-it-happens", "digest"] as const;
export type TimingFilter = (typeof TIMING_FILTERS)[number];
export const MEMBERS_PAGE_SIZE = 50;

export class ReportListNotFoundError extends Error {
  constructor() {
    super("not found");
    this.name = "ReportListNotFoundError";
  }
}

export interface TimingCounts {
  subscribers: number;
  asItHappens: number;
  digest: number;
}
export interface ByListList extends TimingCounts {
  listKey: string;
  name: string;
  active: boolean;
}
export interface ByListCategory {
  key: string;
  name: string;
  lists: ByListList[];
}
export interface SubscribersByListReport {
  all: TimingCounts;
  allNews: TimingCounts;
  categories: ByListCategory[];
}
export interface ReportMember {
  id: string;
  email: string;
  asItHappens: boolean;
  digest: boolean;
  source: SubscriberSource;
  createdAt: string;
}
export interface MembersPage {
  list: string;
  listName: string;
  timing: TimingFilter;
  total: number;
  page: number;
  pageSize: number;
  items: ReportMember[];
}

const ZERO: TimingCounts = { subscribers: 0, asItHappens: 0, digest: 0 };

export async function subscribersByList(db: DbOrTx): Promise<SubscribersByListReport> {
  const view = await staffListsView(db);
  const { rows } = await db.execute<{ list_key: string; subscribers: number; as_it_happens: number; digest: number }>(sql`
    SELECT sub.list_key, count(*)::int AS subscribers,
           count(*) FILTER (WHERE s.as_it_happens)::int AS as_it_happens,
           count(*) FILTER (WHERE s.digest)::int AS digest
      FROM subscriptions sub
      JOIN subscribers s ON s.id = sub.subscriber_id
     WHERE s.status = 'active'
     GROUP BY sub.list_key`);
  const { rows: everyone } = await db.execute<{ subscribers: number; as_it_happens: number; digest: number }>(sql`
    SELECT count(*)::int AS subscribers,
           count(*) FILTER (WHERE as_it_happens)::int AS as_it_happens,
           count(*) FILTER (WHERE digest)::int AS digest
      FROM subscribers WHERE status = 'active'`);
  const by = new Map(rows.map((r) => [r.list_key, { subscribers: r.subscribers, asItHappens: r.as_it_happens, digest: r.digest }]));
  const all = everyone[0]!;
  return {
    all: { subscribers: all.subscribers, asItHappens: all.as_it_happens, digest: all.digest },
    allNews: by.get(ALL_NEWS) ?? ZERO,
    categories: view.categories.map((c) => ({
      key: c.key,
      name: c.name,
      lists: c.lists.map((l) => ({ listKey: l.listKey, name: l.name, active: l.active, ...(by.get(l.listKey) ?? ZERO) })),
    })),
  };
}

/** "All active subscribers", "All news", or the list's own name; unknown keys are 404. */
export async function listLabel(db: DbOrTx, list: string): Promise<string> {
  if (list === ALL_SUBSCRIBERS) return "All active subscribers";
  if (list === ALL_NEWS) return "All news";
  const [row] = await db.select({ name: lists.name }).from(lists).where(eq(lists.listKey, list));
  if (!row) throw new ReportListNotFoundError();
  return row.name;
}

function scope(list: string, timing: TimingFilter): SQL {
  const conds: SQL[] = [eq(subscribers.status, "active")];
  if (list !== ALL_SUBSCRIBERS) {
    conds.push(sql`EXISTS (SELECT 1 FROM ${subscriptions} WHERE ${subscriptions.subscriberId} = ${subscribers.id} AND ${subscriptions.listKey} = ${list})`);
  }
  if (timing === "as-it-happens") conds.push(eq(subscribers.asItHappens, true));
  if (timing === "digest") conds.push(eq(subscribers.digest, true));
  return and(...conds)!;
}

const memberColumns = {
  id: subscribers.id,
  email: subscribers.email,
  sortKey: sql<string>`lower(${subscribers.email})`,
  asItHappens: subscribers.asItHappens,
  digest: subscribers.digest,
  source: subscribers.source,
  createdAt: subscribers.createdAt,
};
type MemberRow = { id: string; email: string; sortKey: string; asItHappens: boolean; digest: boolean; source: SubscriberSource; createdAt: Date };
const toMember = (r: MemberRow): ReportMember => ({
  id: r.id,
  email: r.email,
  asItHappens: r.asItHappens,
  digest: r.digest,
  source: r.source,
  createdAt: r.createdAt.toISOString(),
});

export async function membersPage(db: DbOrTx, q: { list: string; timing: TimingFilter; page: number }): Promise<MembersPage> {
  const listName = await listLabel(db, q.list);
  const where = scope(q.list, q.timing);
  const rows = await db
    .select(memberColumns)
    .from(subscribers)
    .where(where)
    .orderBy(sql`lower(${subscribers.email})`, subscribers.id)
    .limit(MEMBERS_PAGE_SIZE)
    .offset((q.page - 1) * MEMBERS_PAGE_SIZE);
  const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(subscribers).where(where)) as [{ n: number }];
  return { list: q.list, listName, timing: q.timing, total: n, page: q.page, pageSize: MEMBERS_PAGE_SIZE, items: rows.map(toMember) };
}

/** Every member in address order, `batchSize` at a time (keyset, so a long export never rescans). */
export async function* memberBatches(db: DbOrTx, list: string, timing: TimingFilter, batchSize = 1000): AsyncGenerator<ReportMember[]> {
  let after: { sortKey: string; id: string } | null = null;
  for (;;) {
    const where: SQL = after
      ? and(scope(list, timing), sql`(lower(${subscribers.email}), ${subscribers.id}) > (${after.sortKey}, ${after.id}::uuid)`)!
      : scope(list, timing);
    const rows = await db.select(memberColumns).from(subscribers).where(where).orderBy(sql`lower(${subscribers.email})`, subscribers.id).limit(batchSize);
    if (rows.length > 0) yield rows.map(toMember);
    if (rows.length < batchSize) return;
    const last = rows[rows.length - 1]!;
    after = { sortKey: last.sortKey, id: last.id };
  }
}

export function timingText(m: { asItHappens: boolean; digest: boolean }): string {
  if (m.asItHappens && m.digest) return "As it happens and daily digest";
  if (m.asItHappens) return "As it happens";
  if (m.digest) return "Daily digest";
  return "None (media lists only)";
}

const SOURCE_TEXT: Record<SubscriberSource, string> = { self: "Signed up", admin: "Added by staff", "media-hub": "Media Hub", "manual-media": "Added by hand" };
export function sourceText(source: SubscriberSource): string {
  return SOURCE_TEXT[source] ?? source;
}

export const BY_LIST_CSV_HEADER = ["Category", "List", "Subscribers", "As it happens", "Daily digest"];
export function byListCsvRows(r: SubscribersByListReport): CsvCell[][] {
  const counts = (c: TimingCounts): CsvCell[] => [c.subscribers, c.asItHappens, c.digest];
  return [
    ["All active subscribers", "", ...counts(r.all)],
    ["All news", "", ...counts(r.allNews)],
    ...r.categories.flatMap((c) => c.lists.map((l): CsvCell[] => [c.name, l.active ? l.name : `${l.name} (retired)`, ...counts(l)])),
  ];
}

export const MEMBER_CSV_HEADER = ["Email", "Timing", "Source", "Registered (BC time)"];
export function memberCsvRow(m: ReportMember, timeZone: string): CsvCell[] {
  return [m.email, timingText(m), sourceText(m.source), localDateTime(new Date(m.createdAt), timeZone)];
}
