import { createHash } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import { sqlNow, type TestClock, type Tx } from "@gcpe/db-kit";
import { enqueueEvent, type GovernmentTermsPayload, type SubscriberConfig } from "@gcpe/events";
import { governmentTerms, governmentTermsPublished } from "./db/schema";

/** Serialises rollovers and term writes (`pg_advisory_xact_lock`). */
export const GOVERNMENT_TERMS_LOCK = [0x67637065, 8] as const;

export type TermStatus = "past" | "current" | "scheduled" | "undated";

export interface TermSpan {
  id: string;
  slug: string;
  label: string | null;
  startDate: string | null;
  endDate: string | null;
  status: TermStatus;
  legacyArchiveUrl: string | null;
  legacyId: string | null;
}

/** UTC date arithmetic on `YYYY-MM-DD`. */
export function addDays(isoDate: string, n: number): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * The one place term ranges are computed. Dated rows come first, oldest to newest, then undated rows.
 * `endDate` is the next dated row's start minus one day, scheduled rows included (the Hub view);
 * `publicTerms` hides scheduled terms and reopens the newest public one.
 * `today` is the BC calendar date: the latest start on or before it is current.
 */
export function termSpans(rows: (typeof governmentTerms.$inferSelect)[], today: string): TermSpan[] {
  const dated = rows.filter((r) => r.startDate !== null).sort((a, b) => (a.startDate! < b.startDate! ? -1 : a.startDate! > b.startDate! ? 1 : 0));
  const undated = rows.filter((r) => r.startDate === null);
  let currentIdx = -1;
  dated.forEach((r, i) => {
    if (r.startDate! <= today) currentIdx = i;
  });
  const span = (r: (typeof dated)[number], endDate: string | null, status: TermStatus): TermSpan => ({
    id: r.id,
    slug: r.name,
    label: r.label,
    startDate: r.startDate,
    endDate,
    status,
    legacyArchiveUrl: r.legacyArchiveUrl,
    legacyId: r.legacyId,
  });
  return [
    ...dated.map((r, i) => {
      const next = dated[i + 1];
      const status: TermStatus = i < currentIdx ? "past" : i === currentIdx ? "current" : "scheduled";
      return span(r, next ? addDays(next.startDate!, -1) : null, status);
    }),
    ...undated.map((r) => span(r, null, "undated")),
  ];
}

/** Only past and current terms, newest first; the newest has no end date (scheduled terms must not close it). */
export function publicTerms(spans: TermSpan[]): GovernmentTermsPayload["terms"] {
  return spans
    .filter((s) => s.status === "past" || s.status === "current")
    .reverse()
    .map((s, i) => ({
      slug: s.slug,
      label: s.label,
      startDate: s.startDate!,
      endDate: i === 0 ? null : s.endDate,
      legacyArchiveUrl: s.legacyArchiveUrl,
    }));
}

/**
 * The rollover (spec §2). Under {@link GOVERNMENT_TERMS_LOCK}: derives the current term from the
 * BC date of the database clock, makes `is_current` say exactly that (clearing any other flag
 * first, which also corrects a stale importer-era flag), and, when the public snapshot's hash
 * differs from the last one published, records the hash and enqueues `government_terms.published`
 * in the caller's transaction. Runs on every site-loop tick, so a term entered weeks ahead goes
 * live at the first tick after 00:00 Pacific on its date.
 */
export async function syncGovernmentTerms(
  tx: Tx,
  opts: { timeZone: string; subscribers: SubscriberConfig[]; now?: TestClock },
): Promise<{ emitted: boolean }> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${GOVERNMENT_TERMS_LOCK[0]}, ${GOVERNMENT_TERMS_LOCK[1]})`);
  const now = sqlNow(opts.now);
  // Raw execute returns timestamptz as session-timezone text, so format the instant in SQL.
  const clock = await tx.execute<{ today: string; published_at: string }>(sql`
    SELECT ((${now}) AT TIME ZONE ${opts.timeZone})::date::text AS today,
           to_char((${now}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS published_at`);
  const { today, published_at: publishedAt } = clock.rows[0]!;

  const rows = await tx.select().from(governmentTerms);
  const spans = termSpans(rows, today);
  const current = spans.find((s) => s.status === "current") ?? null;

  // Clear first: the partial unique index allows only one flagged row at a time.
  await tx
    .update(governmentTerms)
    .set({ isCurrent: false })
    .where(current ? and(eq(governmentTerms.isCurrent, true), ne(governmentTerms.id, current.id)) : eq(governmentTerms.isCurrent, true));
  if (current) await tx.update(governmentTerms).set({ isCurrent: true }).where(and(eq(governmentTerms.id, current.id), eq(governmentTerms.isCurrent, false)));

  const snapshot = { currentSlug: current?.slug ?? null, terms: publicTerms(spans) };
  const hash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  const [stored] = await tx.select({ hash: governmentTermsPublished.hash }).from(governmentTermsPublished).where(eq(governmentTermsPublished.id, 1));
  if (stored?.hash === hash) return { emitted: false };

  await tx
    .insert(governmentTermsPublished)
    .values({ id: 1, hash, publishedAt: new Date(publishedAt) })
    .onConflictDoUpdate({ target: governmentTermsPublished.id, set: { hash, publishedAt: new Date(publishedAt) } });
  const data: GovernmentTermsPayload = { publishedAt, ...snapshot };
  await enqueueEvent(tx, { type: "government_terms.published", source: "nrms", aggregateId: "government-terms", data }, opts.subscribers);
  return { emitted: true };
}
