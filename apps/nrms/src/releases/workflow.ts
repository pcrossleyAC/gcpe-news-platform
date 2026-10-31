import { and, eq, ne, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "@gcpe/db-kit";
import { indexKeysFor, type SubscriberConfig } from "@gcpe/events";
import { wallClockToInstant } from "@gcpe/config";
import { approveProblems, POST_KIND, publishProblems, TYPE_LABEL, typeRules, type ReleaseView, type ScheduleInput } from "@gcpe/nrms-contract";
import { flickrJobs, newsReleases, organizations, releasePublications } from "../db/schema";
import { ministryAbbreviation } from "../taxonomy";
import { ReleaseRuleError, ReleaseStateError } from "./errors";
import { emitLinkChange, linkStateOf } from "./link-events";
import { bcYear, nextCounter, pad } from "./numbering";
import { assertPublishable, toReleaseRecord } from "./record";
import { loadView, mutateRelease, type Actor } from "./store";

export interface WorkflowDeps {
  timeZone: string;
  countSubscribers?: (listKeys: string[]) => Promise<number>;
  countMediaContacts?: (listKeys: string[]) => Promise<number>;
  /** NoD's breakdown of who a first publish reaches (suite review R6; clients.ts releaseAudience). */
  releaseAudience?: (q: { listKeys: string[]; mediaListKeys: string[]; toSubscribers: boolean; postKind: string }) => Promise<{ asItHappens: number; digest: number; mediaContacts: number }>;
  /** PUBLIC_FILES_BASE — only affects the size check here (absolute file URLs are longer). */
  filesBase?: string;
  /** Who gets release.status_changed (the Calendar); unset → enqueued for no one. */
  subscribers?: SubscriberConfig[];
}

/** A media list's NoD list key: `media-distribution-lists:<key>`, lowercased. Mirrors
 * apps/nod/src/lists.ts's `mediaListKey` (deliberately duplicated — apps never import another
 * app's src, only shared packages). */
function mediaListKey(key: string): string {
  return `media-distribution-lists:${key.toLowerCase()}`;
}

const PAST_LIMIT_MS = 5 * 60_000;
/** A live release in one of these can be taken down (a failed correction, or one re-scheduled, is still live). */
const UNPUBLISHABLE_STATUSES = new Set(["published", "publishing", "failed", "scheduled"]);
/** Approved and not yet gone out: what Return to draft accepts (see {@link returnToDraft}). */
const RETURNABLE_STATUSES = new Set(["approved", "scheduled"]);

/**
 * `s` ("YYYY-MM-DDTHH:mm", `scheduleSchema`'s `publishAtLocal`/`settingsSchema`'s
 * `plannedPublishAtLocal` — no offset, already validated by those schemas) as a Date whose
 * *UTC* fields hold those wall-clock values, exactly the input {@link wallClockToInstant}
 * expects. Exported for `./service.ts`'s `saveSettings`, which needs the same conversion.
 */
export function parseLocalDateTime(s: string): Date {
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
      const before = await linkStateOf(tx, id);
      const view = (await loadView(tx, id))!;
      const lead = row.leadMinistryKey ?? (view.ministries.length === 1 ? view.ministries[0]! : null);
      // Lower-cased like ministryAbbreviation, so the guard and the numbering read the same row.
      const [leadOrg] = lead ? await tx.select({ isActive: organizations.isActive }).from(organizations).where(eq(organizations.key, lead.toLowerCase())) : [];
      // A succeeded ministry keeps its abbreviation locally, so it must not be allowed to number new releases.
      const problems = approveProblems({ ...view, leadMinistryKey: lead }, leadOrg && !leadOrg.isActive ? [lead!] : []);
      if (problems.length) throw new ReleaseRuleError(problems);

      const reference = `NEWS-${pad(await nextCounter(tx, "news", 0, ""), 5)}`;
      let numbering: { key: string; year: number; yearRelease: number; ministryRelease: number } | null = null;
      if (typeRules(row.type).generatesKey) {
        const year = bcYear((await dbClock(tx)).now, deps.timeZone);
        const abbr = lead ? await ministryAbbreviation(tx, lead) : null;
        if (lead && !abbr) throw new ReleaseRuleError(["The lead ministry has no abbreviation yet. Ask an administrator to add one, then approve again."]);
        // Counted per printed abbreviation, so two ministries sharing one over time can never issue the same number.
        const n = await nextCounter(tx, "ministry", year, (abbr ?? "").toUpperCase());
        const m = await nextCounter(tx, "year", year, "");
        numbering = { key: `${year}${(abbr ?? "ADVIS").toUpperCase()}${pad(n, 4)}-${pad(m, 6)}`, year, yearRelease: m, ministryRelease: n };
      }
      try {
        await tx
          .update(newsReleases)
          .set({ status: "approved", reference, leadMinistryKey: lead, ...(numbering ?? {}) })
          .where(eq(newsReleases.id, id));
      } catch (e) {
        if (isNumberCollision(e)) throw new ReleaseStateError("That number is already in use — try again.");
        throw e;
      }
      await emitLinkChange(tx, before, await linkStateOf(tx, id), deps.subscribers ?? []);
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

/** Media contact count for a first publish — best effort, outside the transaction, never blocks scheduling. */
async function mediaContactCount(v: ReleaseView, deps: WorkflowDeps): Promise<{ count: number | null } | null> {
  if (v.releasedAt !== null || !v.publishOptions.toMediaLists || v.mediaListKeys.length === 0 || !deps.countMediaContacts) return null;
  try {
    return { count: await deps.countMediaContacts(v.mediaListKeys.map(mediaListKey)) };
  } catch {
    console.error("[nrms] media contact count unavailable");
    return { count: null };
  }
}

/** One audience's count for the publish dialogs: `count` null when it couldn't be worked out. */
export interface AudienceCount {
  count: number | null;
}

/** Who a first publish reaches. Each is null when this publish doesn't email that audience. */
export interface AudiencePreview {
  /** News on Demand subscribers emailed As it happens when it goes out (anyone also on one of
   * its media lists gets the media email instead). */
  asItHappens: AudienceCount | null;
  /** Daily digest subscribers who get it in the next 5 pm digest after it goes out. */
  digest: AudienceCount | null;
  /** Media contacts on its media lists. */
  mediaContacts: AudienceCount | null;
}

/**
 * Suite review R6 (fix round 1): who a first publish of this release reaches, from NoD's own
 * send rules (apps/nod/src/audience.ts, pinned there against real sends), for the Publish now
 * and Schedule dialogs before anything is sent. Read-only: nothing stored, no history line.
 * `{ count: null }` when NoD isn't set up here or doesn't answer. Null overall for an unknown
 * release.
 */
export async function audiencePreview(db: Db, id: string, deps: WorkflowDeps): Promise<AudiencePreview | null> {
  const v = await loadView(db, id);
  if (!v) return null;
  const rules = typeRules(v.type);
  const firstPublish = v.releasedAt === null;
  const subscribersOn = firstPublish && rules.nodAllowed && v.publishOptions.toSubscribers;
  const listsOn = firstPublish && rules.mediaListsAllowed && v.publishOptions.toMediaLists && v.mediaListKeys.length > 0;
  if (!subscribersOn && !listsOn) return { asItHappens: null, digest: null, mediaContacts: null };
  let counts: { asItHappens: number; digest: number; mediaContacts: number } | null = null;
  if (deps.releaseAudience) {
    try {
      counts = await deps.releaseAudience({
        listKeys: indexKeysFor({ ministryKeys: v.ministries, sectorKeys: v.sectors, tagKeys: v.tags, themeKeys: v.themes }),
        mediaListKeys: listsOn ? v.mediaListKeys.map(mediaListKey) : [],
        toSubscribers: subscribersOn,
        postKind: POST_KIND[v.type],
      });
    } catch {
      console.error("[nrms] release audience unavailable");
    }
  }
  const of = (n: number | undefined): AudienceCount => ({ count: counts && typeof n === "number" ? n : null });
  return {
    asItHappens: subscribersOn ? of(counts?.asItHappens) : null,
    digest: subscribersOn ? of(counts?.digest) : null,
    mediaContacts: listsOn ? of(counts?.mediaContacts) : null,
  };
}

export async function schedule(db: Db, id: string, input: ScheduleInput, actor: Actor, deps: WorkflowDeps): Promise<ReleaseView> {
  const before = await loadView(db, id);
  const subscribers = before ? await subscriberCount(before, deps) : null;
  const mediaContacts = before ? await mediaContactCount(before, deps) : null;
  return mutateRelease(
    db, id, input.version, actor,
    async (tx, row) => {
      if (row.status !== "approved" && row.status !== "failed") throw new ReleaseStateError("Only an approved release can be scheduled.");
      if (!row.key) throw new ReleaseStateError("Approve this release before scheduling it.");
      const before = await linkStateOf(tx, id);
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
      // Controller ruling: this pre-check must count mediaText too (same rendition shape as
      // publisher.ts's own record build) -- otherwise a media release that fits here without it
      // can still exceed MAX_EVENT_BYTES once actually published, and this schedule-time check
      // would have missed it.
      const rendition = { timeZone: deps.timeZone, nowMs: clock.now.getTime() };
      assertPublishable(toReleaseRecord(view, { publishDate: publishAt.toISOString(), timestamp: clock.now.toISOString() }, { filesBase: deps.filesBase, rendition }));

      await tx
        .update(newsReleases)
        .set({
          status: "scheduled", publishAt, lastError: null,
          ...(subscribers && row.releasedAt === null ? { nodSubscribers: subscribers.count } : {}),
          ...(mediaContacts && row.releasedAt === null ? { mediaSubscribers: mediaContacts.count } : {}),
        })
        .where(eq(newsReleases.id, id));
      await dropUnfinishedFlickrJob(tx, id);
      await emitLinkChange(tx, before, await linkStateOf(tx, id), deps.subscribers ?? []);
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

export async function cancel(db: Db, id: string, version: number, actor: Actor, subscribers: SubscriberConfig[] = []): Promise<ReleaseView> {
  return mutateRelease(
    db, id, version, actor,
    async (tx, row) => {
      if (row.status !== "scheduled") throw new ReleaseStateError("Only a scheduled release can be cancelled.");
      if (row.live) throw new ReleaseStateError("This release is live — save a correction or unpublish it instead.");
      const before = await linkStateOf(tx, id);
      await tx.update(newsReleases).set({ status: row.reference ? "approved" : "draft" }).where(eq(newsReleases.id, id));
      await dropUnfinishedFlickrJob(tx, id);
      await emitLinkChange(tx, before, await linkStateOf(tx, id), subscribers);
      return "Cancelled Release";
    },
    { correction: false },
  );
}

/**
 * Owner decision 2026-10-29: an approved release that has never been published (approved, or
 * scheduled and not yet gone out) can go back to draft. Same role rule as Approve (the route's
 * `edit`). "Approved" is having a reference throughout (statusText, Cancel schedule, the
 * publisher's unpublish), so the reference is cleared; a Release/Advisory/Update's generated key
 * and numbers go too — they carry the lead ministry's abbreviation, which may change before the
 * next approval issues fresh ones. A story/factsheet key is the editor's own and stays. The old
 * numbers are kept in the history line. A scheduled one stops being scheduled: status is no
 * longer 'scheduled', which is all the publisher's claim looks at; its time stays as a plan, as
 * Cancel schedule leaves it.
 */
export async function returnToDraft(db: Db, id: string, version: number, actor: Actor, subscribers: SubscriberConfig[] = []): Promise<ReleaseView> {
  return mutateRelease(
    db, id, version, actor,
    async (tx, row) => {
      // Ever public: releasedAt, or (a legacy import with no ReleaseDateTime) an atomId — stamped on
      // every publish and carried by imports — or a publication row. Its key is then a public URL.
      const published = row.releasedAt !== null || row.atomId !== null ||
        (await tx.select({ id: releasePublications.id }).from(releasePublications).where(eq(releasePublications.releaseId, id)).limit(1)).length > 0;
      if (!row.reference || !RETURNABLE_STATUSES.has(row.status) || row.live || published) {
        throw new ReleaseStateError("Only an approved release that hasn't been published can go back to draft.");
      }
      const before = await linkStateOf(tx, id);
      const generated = typeRules(row.type).generatesKey;
      await tx
        .update(newsReleases)
        .set({ status: "draft", reference: null, ...(generated ? { key: null, year: null, yearRelease: null, ministryRelease: null } : {}) })
        .where(eq(newsReleases.id, id));
      await dropUnfinishedFlickrJob(tx, id);
      await emitLinkChange(tx, before, await linkStateOf(tx, id), subscribers);
      const was = [row.reference, generated ? row.key : null].filter(Boolean).join(", ");
      return `Returned to Draft (was ${was})`;
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
