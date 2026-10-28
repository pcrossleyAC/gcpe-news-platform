import { createHash } from "node:crypto";
import { and, count, eq, ne, sql } from "drizzle-orm";
import { sqlNow, type TestClock, type Tx } from "@gcpe/db-kit";
import { enqueueEvent, type GovernmentTermsPayload, type SubscriberConfig } from "@gcpe/events";
import { formatLongDate } from "@gcpe/nrms-contract";
import { governmentTerms, governmentTermsPublished, newsReleases } from "./db/schema";

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

/** The BC calendar date and the UTC instant (ISO, ms) of the database clock (or the test clock). */
async function bcClock(tx: Tx, opts: { timeZone: string; now?: TestClock }): Promise<{ today: string; publishedAt: string }> {
  const now = sqlNow(opts.now);
  // Raw execute returns timestamptz as session-timezone text, so format the instant in SQL.
  const clock = await tx.execute<{ today: string; published_at: string }>(sql`
    SELECT ((${now}) AT TIME ZONE ${opts.timeZone})::date::text AS today,
           to_char((${now}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS published_at`);
  return { today: clock.rows[0]!.today, publishedAt: clock.rows[0]!.published_at };
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
  const { today, publishedAt } = await bcClock(tx, opts);

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

export type GovernmentTermView = TermSpan & { releaseCount: number };
export interface TermWriteOpts {
  timeZone: string;
  subscribers: SubscriberConfig[];
  now?: TestClock;
}

/** A refused term write (→ HTTP 409, `{ error: message }`). */
export class GovernmentTermConflictError extends Error {}
/** → HTTP 404. */
export class GovernmentTermNotFoundError extends Error {}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export function isIsoDate(s: string): boolean {
  return ISO_DATE.test(s) && addDays(s, 0) === s;
}

const DUPLICATE = "Another term already starts on that date.";

async function lock(tx: Tx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${GOVERNMENT_TERMS_LOCK[0]}, ${GOVERNMENT_TERMS_LOCK[1]})`);
}

async function views(tx: Tx, today: string): Promise<GovernmentTermView[]> {
  const spans = termSpans(await tx.select().from(governmentTerms), today);
  const counts = await tx.select({ termId: newsReleases.termId, n: count() }).from(newsReleases).groupBy(newsReleases.termId);
  const byTerm = new Map(counts.map((c) => [c.termId, c.n]));
  return spans.map((s) => ({ ...s, releaseCount: byTerm.get(s.id) ?? 0 }));
}

/** Newest first (dated rows by start descending, undated rows last). */
export async function listGovernmentTerms(tx: Tx, opts: { timeZone: string; now?: TestClock }): Promise<{ today: string; terms: GovernmentTermView[] }> {
  const { today } = await bcClock(tx, opts);
  const all = await views(tx, today);
  return { today, terms: [...all.filter((t) => t.startDate !== null).reverse(), ...all.filter((t) => t.startDate === null)] };
}

async function viewOf(tx: Tx, id: string, today: string): Promise<GovernmentTermView> {
  const v = (await views(tx, today)).find((t) => t.id === id);
  if (!v) throw new GovernmentTermNotFoundError();
  return v;
}

/** Unique-violation on the start-date or slug indexes → the duplicate-date refusal. */
function asDuplicate(e: unknown): never {
  for (let err = e as { code?: string; cause?: unknown } | undefined; err; err = err.cause as typeof err) {
    if (err.code === "23505") throw new GovernmentTermConflictError(DUPLICATE);
  }
  throw e;
}

export async function createGovernmentTerm(tx: Tx, input: { startDate: string; label?: string | null }, opts: TermWriteOpts): Promise<GovernmentTermView> {
  await lock(tx);
  const { today } = await bcClock(tx, opts);
  const dates = (await tx.select({ d: governmentTerms.startDate }).from(governmentTerms)).map((r) => r.d).filter((d): d is string => d !== null);
  if (dates.includes(input.startDate)) throw new GovernmentTermConflictError(DUPLICATE);
  const latest = dates.reduce<string | null>((m, d) => (m === null || d > m ? d : m), null);
  if (latest !== null && input.startDate <= latest) throw new GovernmentTermConflictError(`A new term must start after ${formatLongDate(latest)}.`);
  let id: string;
  try {
    [{ id }] = (await tx.insert(governmentTerms).values({ name: input.startDate, startDate: input.startDate, label: input.label ?? null }).returning({ id: governmentTerms.id })) as [{ id: string }];
  } catch (e) {
    asDuplicate(e);
  }
  await syncGovernmentTerms(tx, opts);
  return viewOf(tx, id, today);
}

export async function updateGovernmentTerm(
  tx: Tx,
  id: string,
  patch: { startDate?: string; label?: string | null; legacyArchiveUrl?: string | null },
  opts: TermWriteOpts,
): Promise<GovernmentTermView> {
  await lock(tx);
  const { today } = await bcClock(tx, opts);
  const rows = await tx.select().from(governmentTerms);
  const row = rows.find((r) => r.id === id);
  if (!row) throw new GovernmentTermNotFoundError();
  const set: Partial<typeof governmentTerms.$inferInsert> = {};
  if (patch.label !== undefined) set.label = patch.label;
  if (patch.legacyArchiveUrl !== undefined) set.legacyArchiveUrl = patch.legacyArchiveUrl;
  if (patch.startDate !== undefined && patch.startDate !== row.startDate) {
    const others = rows.filter((r) => r.id !== id && r.startDate !== null).map((r) => r.startDate!);
    // Neighbours of the term's current position bound the edit; an undated term has none, so any free date will do.
    const own = row.startDate;
    const lo = own === null ? null : others.filter((d) => d < own).reduce<string | null>((m, d) => (m === null || d > m ? d : m), null);
    const hi = own === null ? null : others.filter((d) => d > own).reduce<string | null>((m, d) => (m === null || d < m ? d : m), null);
    if ((lo !== null && patch.startDate <= lo) || (hi !== null && patch.startDate >= hi)) {
      const parts = [lo !== null && `after ${formatLongDate(lo)}`, hi !== null && `before ${formatLongDate(hi)}`].filter(Boolean);
      throw new GovernmentTermConflictError(`Must be ${parts.join(" and ")}.`);
    }
    if (others.includes(patch.startDate)) throw new GovernmentTermConflictError(DUPLICATE);
    set.startDate = patch.startDate;
    // A Hub-created term's slug follows its date until it starts; imported terms keep their legacy name.
    const scheduled = termSpans(rows, today).find((s) => s.id === id)?.status === "scheduled";
    if (scheduled && row.legacyId === null) set.name = patch.startDate;
  }
  if (Object.keys(set).length > 0) {
    try {
      await tx.update(governmentTerms).set(set).where(eq(governmentTerms.id, id));
    } catch (e) {
      asDuplicate(e);
    }
  }
  await syncGovernmentTerms(tx, opts);
  return viewOf(tx, id, today);
}

export async function deleteGovernmentTerm(tx: Tx, id: string, opts: TermWriteOpts): Promise<void> {
  await lock(tx);
  const { today } = await bcClock(tx, opts);
  const rows = await tx.select().from(governmentTerms);
  const span = termSpans(rows, today).find((s) => s.id === id);
  if (!span) throw new GovernmentTermNotFoundError();
  if (span.status !== "scheduled") throw new GovernmentTermConflictError("Only a term that hasn't started can be deleted.");
  await tx.delete(governmentTerms).where(eq(governmentTerms.id, id));
  await syncGovernmentTerms(tx, opts);
}
