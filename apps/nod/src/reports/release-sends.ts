/**
 * Sends per release (spec §8): each release or emergency item published in the range that went to
 * anyone as-it-happens or by media list, with recipients, handed off and not bounced, bounced and
 * not sent per mode. Digest deliveries belong to the digest-run report. Handed off = given to
 * Distribution, which is not delivery: Distribution may still hold the email in its queue, or fail
 * to send it, and neither shows here (its own report does). Bounced = any bounce recorded, hard or
 * soft (legacy counted both).
 */
import { sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import type { CsvCell } from "./csv";
import { localDateTime, type ReportRange } from "./range";

export const RELEASE_SENDS_PAGE_SIZE = 25;

export interface ModeCounts {
  recipients: number;
  handedOffNotBounced: number;
  bounced: number;
  notSent: number;
}
export interface ReleaseSendRow {
  itemKey: string;
  title: string;
  type: string;
  publishedAt: string;
  asItHappens: ModeCounts;
  media: ModeCounts;
}
export interface RangedPage<T> {
  from: string;
  to: string;
  total: number;
  page: number;
  pageSize: number;
  items: T[];
}

const POST_KIND_LABELS: Record<string, string> = {
  releases: "News release",
  stories: "Story",
  factsheets: "Factsheet",
  updates: "Update",
  advisories: "Media advisory",
};
export function itemTypeLabel(kind: string, postKind: string | null): string {
  if (kind === "emergency") return "Emergency alert";
  return (postKind ? POST_KIND_LABELS[postKind] : undefined) ?? "Release";
}

/** Where a CSV batch left off: the last row's publish time, exactly as Postgres returned it (to
 * the microsecond), and its key. */
type After = { publishedAt: string; key: string };

/** Newest first. For each item published in the range (walked down items_published_at_idx), the
 * LATERAL subquery counts its as-it-happens and media deliveries from deliveries_item_mode_idx
 * alone, an index-only scan. A page uses LIMIT/OFFSET; a CSV batch starts strictly after the
 * previous batch's last row (`after`), so a release published mid-export can't shift rows into a
 * batch twice. */
export function releaseSendsSql(range: ReportRange, limit: number, offset: number, after: After | null = null): SQL {
  const resume = after ? sql`AND (i.published_at, i.key) < (${after.publishedAt}::timestamptz, ${after.key})` : sql``;
  return sql`
    SELECT i.key, i.title, i.kind, i.post_kind, i.published_at, c.*
      FROM items i
      JOIN LATERAL (
        SELECT count(*) FILTER (WHERE d.mode = 'as_it_happens')::int AS aih_recipients,
               count(*) FILTER (WHERE d.mode = 'as_it_happens' AND d.distribution_batch_id IS NOT NULL)::int AS aih_sent,
               count(*) FILTER (WHERE d.mode = 'as_it_happens' AND d.bounce_status IS NOT NULL)::int AS aih_bounced,
               count(*) FILTER (WHERE d.mode = 'media')::int AS media_recipients,
               count(*) FILTER (WHERE d.mode = 'media' AND d.distribution_batch_id IS NOT NULL)::int AS media_sent,
               count(*) FILTER (WHERE d.mode = 'media' AND d.bounce_status IS NOT NULL)::int AS media_bounced
          FROM deliveries d
         WHERE d.item_key = i.key AND d.mode IN ('as_it_happens', 'media')) c ON c.aih_recipients + c.media_recipients > 0
     WHERE i.published_at >= ${range.start} AND i.published_at < ${range.end} ${resume}
     ORDER BY i.published_at DESC, i.key DESC
     LIMIT ${limit} OFFSET ${offset}`;
}

type RawRow = {
  key: string;
  title: string;
  kind: string;
  post_kind: string | null;
  published_at: string;
  aih_recipients: number;
  aih_sent: number;
  aih_bounced: number;
  media_recipients: number;
  media_sent: number;
  media_bounced: number;
};
const counts = (recipients: number, sent: number, bounced: number): ModeCounts => ({ recipients, handedOffNotBounced: sent - bounced, bounced, notSent: recipients - sent });
const toRow = (r: RawRow): ReleaseSendRow => ({
  itemKey: r.key,
  title: r.title,
  type: itemTypeLabel(r.kind, r.post_kind),
  publishedAt: new Date(r.published_at).toISOString(),
  asItHappens: counts(r.aih_recipients, r.aih_sent, r.aih_bounced),
  media: counts(r.media_recipients, r.media_sent, r.media_bounced),
});

export async function releaseSendsPage(db: DbOrTx, range: ReportRange, page: number): Promise<RangedPage<ReleaseSendRow>> {
  const { rows } = await db.execute<RawRow>(releaseSendsSql(range, RELEASE_SENDS_PAGE_SIZE, (page - 1) * RELEASE_SENDS_PAGE_SIZE));
  const { rows: total } = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM items i
     WHERE i.published_at >= ${range.start} AND i.published_at < ${range.end}
       AND EXISTS (SELECT 1 FROM deliveries d WHERE d.item_key = i.key AND d.mode IN ('as_it_happens', 'media'))`);
  return { from: range.from, to: range.to, total: total[0]!.n, page, pageSize: RELEASE_SENDS_PAGE_SIZE, items: rows.map(toRow) };
}

export async function* releaseSendBatches(db: DbOrTx, range: ReportRange, batchSize = 500): AsyncGenerator<ReleaseSendRow[]> {
  let after: After | null = null;
  for (;;) {
    const rows: RawRow[] = (await db.execute<RawRow>(releaseSendsSql(range, batchSize, 0, after))).rows;
    if (rows.length > 0) yield rows.map(toRow);
    if (rows.length < batchSize) return;
    const last: RawRow = rows[rows.length - 1]!;
    after = { publishedAt: last.published_at, key: last.key };
  }
}

export const RELEASE_SENDS_CSV_HEADER = [
  "Published (BC time)", "Title", "Type",
  "As it happens: recipients", "As it happens: handed off, not bounced", "As it happens: bounced", "As it happens: not sent",
  "Media: recipients", "Media: handed off, not bounced", "Media: bounced", "Media: not sent",
];
export function releaseSendCsvRow(r: ReleaseSendRow, timeZone: string): CsvCell[] {
  const m = (c: ModeCounts): CsvCell[] => [c.recipients, c.handedOffNotBounced, c.bounced, c.notSent];
  return [localDateTime(new Date(r.publishedAt), timeZone), r.title, r.type, ...m(r.asItHappens), ...m(r.media)];
}
