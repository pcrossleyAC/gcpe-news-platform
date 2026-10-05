import { and, eq, ne, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "@gcpe/db-kit";
import { indexKeysFor } from "@gcpe/events";
import { wallClockToInstant } from "@gcpe/config";
import { approveProblems, publishProblems, TYPE_LABEL, typeRules, type ReleaseView, type ScheduleInput } from "@gcpe/nrms-contract";
import { flickrJobs, governmentTerms, newsReleases } from "../db/schema";
import { ministryAbbreviation } from "../taxonomy";
import { ReleaseRuleError, ReleaseStateError } from "./errors";
import { bcYear, nextCounter, pad } from "./numbering";
import { assertPublishable, toReleaseRecord } from "./record";
import { loadView, mutateRelease, type Actor } from "./store";

export interface WorkflowDeps {
  timeZone: string;
  countSubscribers?: (listKeys: string[]) => Promise<number>;
  /** PUBLIC_FILES_BASE — only affects the size check here (absolute file URLs are longer). */
  filesBase?: string;
}

const PAST_LIMIT_MS = 5 * 60_000;
/** A live release in one of these can be taken down (a failed correction, or one re-scheduled, is still live). */
const UNPUBLISHABLE_STATUSES = new Set(["published", "publishing", "failed", "scheduled"]);

/**
 * `s` ("YYYY-MM-DDTHH:mm", `scheduleSchema`'s `publishAtLocal` — no offset, already validated
 * by that schema) as a Date whose *UTC* fields hold those wall-clock values, exactly the input
 * {@link wallClockToInstant} expects.
 */
function parseLocalDateTime(s: string): Date {
  const [datePart, timePart] = s.split("T");
  const [year, month, day] = datePart!.split("-").map(Number);
  const [hour, minute] = timePart!.split(":").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!, 0, 0));
}

/** "January 15, 2030 at 10:30 a.m." in BC time. */
export function formatBcDateTime(at: Date, timeZone: string): string {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone, month: "long", day: "numeric", year: "numeric" }).format(at);
  const time = new Intl.DateTimeFormat("en-CA", { timeZone, hour: "numeric", minute: "2-digit", hour12: true })
    .format(at)
    .replace(/[\s ]+/g, " ")
    .replace(/\s?(a\.?m\.?)$/i, " a.m.")
    .replace(/\s?(p\.?m\.?)$/i, " p.m.");
  return `${date} at ${time}`;
}

/** The database clock: never compare a JS Date against stored timestamps. */
async function dbClock(tx: DbOrTx): Promise<{ now: Date; minute: Date }> {
  const r = await tx.execute<{ now: string | Date; minute: string | Date }>(sql`SELECT now() AS now, date_trunc('minute', now()) AS minute`);
  const row = r.rows[0]!;
  return { now: new Date(row.now), minute: new Date(row.minute) };
}

const NUMBER_INDEXES = new Set(["news_releases_reference_idx", "news_releases_key_idx"]);

/** A unique violation on the reference or key index (drizzle wraps the pg error in `cause`). */
function isNumberCollision(e: unknown): boolean {
  for (let err = e as { code?: string; constraint?: string; cause?: unknown } | undefined; err; err = err.cause as typeof err) {
    if (err.code === "23505") return NUMBER_INDEXES.has(err.constraint ?? "");
  }
  return false;
}

export async function approve(db: Db, id: string, version: number, actor: Actor, deps: WorkflowDeps): Promise<ReleaseView> {
  return mutateRelease(
    db, id, version, actor,
    async (tx, row) => {
      if (row.reference) throw new ReleaseStateError("This has already been approved.");
      if (row.status !== "draft") throw new ReleaseStateError("Only a draft can be approved.");
      const view = (await loadView(tx, id))!;
      const lead = row.leadMinistryKey ?? (view.ministries.length === 1 ? view.ministries[0]! : null);
      const problems = approveProblems({ ...view, leadMinistryKey: lead });
      if (problems.length) throw new ReleaseRuleError(problems);

      const reference = `NEWS-${pad(await nextCounter(tx, "news", 0, ""), 5)}`;
      let numbering: { key: string; year: number; yearRelease: number; ministryRelease: number } | null = null;
      if (typeRules(row.type).generatesKey) {
        const year = bcYear((await dbClock(tx)).now, deps.timeZone);
        const abbr = lead ? await ministryAbbreviation(tx, lead) : null;
        if (lead && !abbr) throw new ReleaseRuleError(["The lead ministry has no abbreviation in Core; add one before approving."]);
        const n = await nextCounter(tx, "ministry", year, lead ?? "");
        const m = await nextCounter(tx, "year", year, "");
        numbering = { key: `${year}${(abbr ?? "ADVIS").toUpperCase()}${pad(n, 4)}-${pad(m, 6)}`, year, yearRelease: m, ministryRelease: n };
      }
      const [term] = await tx.select({ id: governmentTerms.id }).from(governmentTerms).where(eq(governmentTerms.isCurrent, true));
      try {
        await tx
          .update(newsReleases)
          .set({ status: "approved", reference, leadMinistryKey: lead, termId: term?.id ?? null, ...(numbering ?? {}) })
          .where(eq(newsReleases.id, id));
      } catch (e) {
        if (isNumberCollision(e)) throw new ReleaseStateError("That number is already in use — try again.");
        throw e;
      }
      return `Approved ${TYPE_LABEL[row.type]}`;
    },
    { correction: false },
  );
}

/** Subscriber count for a first publish — best effort, outside the transaction, never blocks scheduling. */
async function subscriberCount(v: ReleaseView, deps: WorkflowDeps): Promise<{ count: number | null } | null> {
  if (v.releasedAt !== null || !v.publishOptions.toSubscribers || !deps.countSubscribers) return null;
  try {
    const keys = indexKeysFor({ ministryKeys: v.ministries, sectorKeys: v.sectors, tagKeys: v.tags, themeKeys: v.themes });
    return { count: await deps.countSubscribers(keys) };
  } catch {
    console.error("[nrms] subscriber count unavailable");
    return { count: null };
  }
}

export async function schedule(db: Db, id: string, input: ScheduleInput, actor: Actor, deps: WorkflowDeps): Promise<ReleaseView> {
  const before = await loadView(db, id);
  const subscribers = before ? await subscriberCount(before, deps) : null;
  return mutateRelease(
    db, id, input.version, actor,
    async (tx, row) => {
      if (row.status !== "approved" && row.status !== "failed") throw new ReleaseStateError("Only an approved release can be scheduled.");
      if (!row.key) throw new ReleaseStateError("Approve this release before scheduling it.");
      const view = (await loadView(tx, id))!;
      const problems = publishProblems(view);
      if (problems.length) throw new ReleaseRuleError(problems);

      const clock = await dbClock(tx);
      let publishAt: Date;
      let immediate: boolean;
      if (input.publishAt === "now") {
        publishAt = clock.minute;
        immediate = true;
      } else {
        // Fix round 1, finding 3: `publishAtLocal` (a BC wall-clock time, no offset) is
        // converted here, with the *server's* tzdata — never the browser's, which may be
        // stale. `scheduleSchema` guarantees exactly one of the two is present.
        const t = input.publishAt ? new Date(input.publishAt) : wallClockToInstant(parseLocalDateTime(input.publishAtLocal!), deps.timeZone);
        if (t.getTime() < clock.now.getTime() - PAST_LIMIT_MS) throw new ReleaseRuleError(["The publish time is more than 5 minutes in the past."]);
        immediate = t.getTime() <= clock.now.getTime();
        publishAt = immediate ? clock.minute : t;
      }
      if (row.live && !immediate) throw new ReleaseRuleError(["A live release's correction goes out immediately — choose Publish now."]);
      assertPublishable(toReleaseRecord(view, { publishDate: publishAt.toISOString(), timestamp: clock.now.toISOString() }, { filesBase: deps.filesBase }));

      await tx
        .update(newsReleases)
        .set({
          status: "scheduled", publishAt, lastError: null,
          ...(subscribers && row.releasedAt === null ? { nodSubscribers: subscribers.count } : {}),
        })
        .where(eq(newsReleases.id, id));
      await dropUnfinishedFlickrJob(tx, id);
      return immediate ? "Scheduled for Immediate Release" : `Scheduled for Release on ${formatBcDateTime(publishAt, deps.timeZone)}`;
    },
    { correction: false },
  );
}

/**
 * A Flickr job from an earlier go-live (pending or gave_up) must not decide this one: its
 * first_attempt_at would skip the grace period. Scheduling or cancelling starts over; a done job
 * (the photo is already public) is kept.
 */
async function dropUnfinishedFlickrJob(tx: DbOrTx, id: string): Promise<void> {
  await tx.delete(flickrJobs).where(and(eq(flickrJobs.releaseId, id), ne(flickrJobs.status, "done")));
}

export async function cancel(db: Db, id: string, version: number, actor: Actor): Promise<ReleaseView> {
  return mutateRelease(
    db, id, version, actor,
    async (tx, row) => {
      if (row.status !== "scheduled") throw new ReleaseStateError("Only a scheduled release can be cancelled.");
      if (row.live) throw new ReleaseStateError("This release is live — save a correction or unpublish it instead.");
      await tx.update(newsReleases).set({ status: row.reference ? "approved" : "draft" }).where(eq(newsReleases.id, id));
      await dropUnfinishedFlickrJob(tx, id);
      return "Cancelled Release";
    },
    { correction: false },
  );
}

export async function unpublish(db: Db, id: string, version: number, actor: Actor): Promise<ReleaseView> {
  return mutateRelease(
    db, id, version, actor,
    async (tx, row) => {
      if (!row.live || !UNPUBLISHABLE_STATUSES.has(row.status)) throw new ReleaseStateError("Only a published release can be unpublished.");
      if (!typeRules(row.type).unpublishable) throw new ReleaseStateError(`A sent ${TYPE_LABEL[row.type]} can't be unpublished.`);
      await tx.update(newsReleases).set({ status: "unpublishing" }).where(eq(newsReleases.id, id));
      return "Unpublished Release";
    },
    { correction: false },
  );
}
