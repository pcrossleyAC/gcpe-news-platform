import { eq, sql } from "drizzle-orm";
import { sqlInterval, sqlNow, type Db, type TestClock, type Tx } from "@gcpe/db-kit";
import { enqueueEvent, type EmailAgain, type SubscriberConfig } from "@gcpe/events";
import { publishProblems, type ReleaseView } from "@gcpe/nrms-contract";
import { governmentTerms, newsReleases, releasePublications, type SentEmailAgain } from "./db/schema";
import { DeferPublish } from "./media/flickr-jobs";
import { ReleaseRuleError } from "./releases/errors";
import { emitLinkChange, linkStateOf } from "./releases/link-events";
import { toReleaseRecord } from "./releases/record";
import { loadView, SYSTEM_ACTOR, writeLog } from "./releases/store";
import { emailAgainOffer, emailAgainWho } from "./releases/workflow";
import { clearFeaturesFor } from "./website/features";

export interface PublisherOptions {
  db: Db;
  subscribers: SubscriberConfig[];
  /** Test hook: stands in for SQL `now()` in every statement (due check and stamps). */
  now?: TestClock;
  limit?: number;
  /**
   * Phase 3c seam: make the photo public etc. Returns the asset URL to publish. Throwing
   * {@link DeferPublish} leaves the release as it is (scheduled/publishing) for a later run —
   * not a failure. It's called before the release row is touched, so the deferring run commits
   * only what `prepareMedia` itself wrote (e.g. a Flickr job).
   */
  prepareMedia?: (tx: Tx, view: ReleaseView) => Promise<{ assetUrl: string | null }>;
  /** PUBLIC_FILES_BASE: origin prefixed to `/files/…` in the record's translations/assets. */
  filesBase?: string;
  /** Tenant time zone, for the media copy's CP-style release date (toReleaseRecord's
   * `rendition.timeZone`, via `renderTextBody`). Defaults to "UTC" -- only releases with
   * `publishFlags.toMediaLists` set are affected by this. */
  timeZone?: string;
}

export interface PublishResult {
  published: string[];
  updated: string[];
  unpublished: string[];
  failed: string[];
  /** Waiting on media (e.g. a Flickr photo being made public): left as they were, retried next run. */
  deferred: string[];
}

const MAX_LAST_ERROR = 500;

function destinations(v: ReleaseView): string {
  return [v.publishOptions.toWeb && "BC Gov News", v.publishOptions.toSubscribers && "News On Demand", v.publishOptions.toMediaLists && "Media Distribution Lists"]
    .filter(Boolean)
    .join(" and ");
}

type Outcome = { kind: keyof PublishResult; key: string } | null;

async function processOne(tx: Tx, opts: PublisherOptions, id: string, status: string, live: boolean): Promise<Outcome> {
  const now = sqlNow(opts.now);
  const timeZone = opts.timeZone ?? "UTC";
  const view = (await loadView(tx, id))!;
  const key = view.key ?? id;
  const before = await linkStateOf(tx, id);
  if (status === "unpublishing") {
    await enqueueEvent(tx, { type: "release.unpublished", source: "nrms", aggregateId: key, data: { key } }, opts.subscribers);
    // Off the site, so no longer "live without its Flickr photo", and no longer Top/Feature
    // anywhere (the home page must never point at a release that isn't on the site).
    await tx
      .update(newsReleases)
      .set({ status: view.reference ? "approved" : "draft", live: false, flickrAlert: null, version: view.version + 1, updatedAt: now })
      .where(eq(newsReleases.id, id));
    await clearFeaturesFor(tx, id, opts.subscribers);
    await writeLog(tx, id, SYSTEM_ACTOR, "Unpublished from BC Gov News");
    await emitLinkChange(tx, before, await linkStateOf(tx, id), opts.subscribers);
    return { kind: "unpublished", key };
  }
  const problems = publishProblems(view);
  if (problems.length) throw new ReleaseRuleError(problems);
  let assetUrl = view.assetUrl;
  if (opts.prepareMedia) {
    try {
      ({ assetUrl } = await opts.prepareMedia(tx, view));
    } catch (e) {
      if (e instanceof DeferPublish) return { kind: "deferred", key };
      throw e;
    }
  }
  const first = view.releasedAt === null;
  // Go-live (release.published) whenever the release isn't on the site: the first release, or a
  // re-publish after an unpublish. A correction of a live release — claimed as `publishing`, or
  // a failed correction re-scheduled — is release.updated.
  const goLive = !live;
  const stamp = sql`date_trunc('milliseconds', ${now})`;
  const [row] = await tx
    .update(newsReleases)
    .set({
      status: "published",
      live: true,
      releasedAt: first ? sql`${newsReleases.publishAt}` : sql`${newsReleases.releasedAt}`,
      // The term is fixed at first publish, by the BC calendar day of publishAt (spec N13): the
      // term with the latest start on or before that day. Corrections and re-publishes keep it.
      // An imported release keeps the term its legacy collection gave it: one imported without a
      // ReleaseDateTime has no releasedAt, so its first correction counts as `first` here.
      ...(first
        ? {
            termId: sql`CASE WHEN ${newsReleases.legacyId} IS NOT NULL AND ${newsReleases.termId} IS NOT NULL THEN ${newsReleases.termId}
              ELSE (SELECT id FROM ${governmentTerms} WHERE start_date <= (${newsReleases.publishAt} AT TIME ZONE ${timeZone})::date ORDER BY start_date DESC LIMIT 1) END`,
          }
        : {}),
      atomId: sql`coalesce(${newsReleases.atomId}, ${`uuid:${id}`})`,
      lastError: null,
      version: view.version + 1,
      updatedAt: stamp,
    })
    .where(eq(newsReleases.id, id))
    .returning({ releasedAt: newsReleases.releasedAt, atomId: newsReleases.atomId, updatedAt: newsReleases.updatedAt });
  const rendition = { timeZone, nowMs: opts.now ? opts.now().getTime() : Date.now() };
  const record = toReleaseRecord(
    { ...view, assetUrl, atomId: row!.atomId },
    { publishDate: row!.releasedAt!.toISOString(), timestamp: row!.updatedAt.toISOString() },
    { filesBase: opts.filesBase, rendition },
  );
  const emailAgain = await takeEmailAgain(tx, id, view);
  const extra = emailAgain.send ? { emailAgain: toEvent(emailAgain.send) } : {};
  let eventId: string;
  if (goLive) {
    eventId = (await enqueueEvent(tx, { type: "release.published", source: "nrms", aggregateId: record.key, data: { ...record, ...extra } }, opts.subscribers)).id;
    await writeLog(tx, id, SYSTEM_ACTOR, "Released for Publishing");
    await writeLog(tx, id, SYSTEM_ACTOR, `Published to ${destinations(view)}`);
  } else {
    eventId = (await enqueueEvent(tx, { type: "release.updated", source: "nrms", aggregateId: record.key, data: { ...record, notify: true, ...extra } }, opts.subscribers)).id;
    await writeLog(tx, id, SYSTEM_ACTOR, `Republished to ${destinations(view)}`);
  }
  if (emailAgain.send) {
    // Which events carried it, so the release can show whether NoD got it (newest kept).
    const eventIds = [...emailAgain.send.eventIds, eventId].slice(-MAX_TRACKED_EVENTS);
    await tx.update(newsReleases).set({ lastEmailAgain: { ...emailAgain.send, eventIds } }).where(eq(newsReleases.id, id));
  }
  if (emailAgain.line) await writeLog(tx, id, SYSTEM_ACTOR, emailAgain.line);
  await tx.insert(releasePublications).values({ releaseId: id, publishedAt: row!.updatedAt, actorId: SYSTEM_ACTOR.id, actorName: SYSTEM_ACTOR.name, record });
  await emitLinkChange(tx, before, await linkStateOf(tx, id), opts.subscribers);
  return { kind: goLive ? "published" : "updated", key: record.key };
}

/** How many carrying events a release remembers for "did NoD get it". */
const MAX_TRACKED_EVENTS = 20;

const toEvent = ({ eventIds: _ids, ...e }: SentEmailAgain): EmailAgain => e;

/**
 * Owner decision 2026-10-31: the "Also email it again?" this republish carries. A request waiting
 * on the row is taken off it: what it can still offer as it goes out is passed on — a ticked
 * audience it no longer goes to is left out, and said so — under the release's next correction
 * number, so NoD makes it a send of its own. Review I2: with nothing new, the last request passed
 * on is repeated (until an unpublish drops it), so an earlier event that NoD never applied —
 * overtaken by a later one, or given up on — can't lose it; NoD acts on each number once.
 */
async function takeEmailAgain(tx: Tx, id: string, view: ReleaseView): Promise<{ send: SentEmailAgain | null; line: string | null }> {
  const [row] = await tx
    .select({ request: newsReleases.emailAgain, done: newsReleases.correctionsEmailed, last: newsReleases.lastEmailAgain })
    .from(newsReleases)
    .where(eq(newsReleases.id, id));
  const request = row?.request;
  const last = row?.last ?? null;
  if (!request) return { send: last, line: null };
  const offer = emailAgainOffer({ ...view, everPublished: true })!;
  const go = { subscribers: request.subscribers && offer.subscribers, mediaLists: request.mediaLists && offer.mediaLists };
  if (!go.subscribers && !go.mediaLists) {
    await tx.update(newsReleases).set({ emailAgain: null }).where(eq(newsReleases.id, id));
    return { send: last, line: `Not emailed again: it no longer goes to ${emailAgainWho(request)}` };
  }
  const seq = row!.done + 1;
  await tx.update(newsReleases).set({ emailAgain: null, correctionsEmailed: seq }).where(eq(newsReleases.id, id));
  const name = request.actorName.slice(0, 200) || "Unknown"; // the event allows up to 200 characters
  return {
    send: { seq, ...go, requestedBy: name, requestedAt: request.at, eventIds: [] },
    // What NRMS knows: it passed the request on. NoD's log records the copies it made; the
    // release shows whether NoD received it (store.ts lastCorrection).
    line: `Passed to News On Demand: email it again with "Corrected:" to ${emailAgainWho(go)} who got it (correction ${seq}, as ${name} asked)`,
  };
}

/**
 * One transaction per release, claimed FOR UPDATE SKIP LOCKED so replicas never double-publish.
 * A failure after the claim marks only that release failed when it was publishing (status
 * scheduled/publishing); an `unpublishing` failure is only logged and retried next run. Either way
 * the release isn't claimed again in the same run, so it never wedges the queue. A failure of the
 * claim itself propagates. Every due/now comparison uses the database clock.
 */
export async function publishDue(opts: PublisherOptions): Promise<PublishResult> {
  const limit = opts.limit ?? 50;
  const out: PublishResult = { published: [], updated: [], unpublished: [], failed: [], deferred: [] };
  // Releases already attempted in this run: a release whose processing keeps failing (an
  // `unpublishing` one stays claimable) must not be re-claimed ahead of everything behind it.
  const tried: string[] = [];
  for (let i = 0; i < limit; i++) {
    let claimed: { id: string; key: string | null; status: string; live: boolean } | null = null;
    let outcome: Outcome;
    try {
      outcome = await opts.db.transaction(async (tx) => {
        const now = sqlNow(opts.now);
        const r = await tx.execute<{ id: string; key: string | null; status: string; live: boolean }>(sql`
          SELECT id, key, status, live FROM ${newsReleases}
          WHERE ((status = 'scheduled' AND publish_at <= ${now} AND NOT on_hold) OR status IN ('publishing', 'unpublishing'))
            AND id <> ALL(${`{${tried.join(",")}}`}::uuid[])
          ORDER BY publish_at, id
          FOR UPDATE SKIP LOCKED LIMIT 1`);
        claimed = r.rows[0] ?? null;
        if (!claimed) return null;
        tried.push(claimed.id);
        return processOne(tx, opts, claimed.id, claimed.status, claimed.live);
      });
    } catch (e) {
      const c = claimed as { id: string; key: string | null } | null;
      if (!c) throw e;
      const message = (e instanceof ReleaseRuleError ? e.problems.join(" ") : e instanceof Error ? e.message : String(e)).slice(0, MAX_LAST_ERROR);
      const markedFailed = await opts.db.transaction(async (tx) => {
        const before = await linkStateOf(tx, c.id);
        const updated = await tx
          .update(newsReleases)
          .set({ status: "failed", lastError: message, updatedAt: sqlNow(opts.now), version: sql`${newsReleases.version} + 1` })
          .where(sql`${newsReleases.id} = ${c.id} AND ${newsReleases.status} IN ('scheduled', 'publishing')`)
          .returning({ id: newsReleases.id });
        if (updated.length) {
          await writeLog(tx, c.id, SYSTEM_ACTOR, `Publishing failed: ${message}`);
          await emitLinkChange(tx, before, await linkStateOf(tx, c.id), opts.subscribers);
        }
        return updated.length > 0;
      });
      console.error(`[nrms] publish failed for ${c.key ?? c.id}: ${message}`);
      // Only a release actually marked failed is reported; an unpublish (or a row that changed
      // meanwhile) is retried next run.
      if (markedFailed) out.failed.push(c.key ?? c.id);
      continue;
    }
    if (!outcome) break;
    out[outcome.kind].push(outcome.key);
  }
  return out;
}

export function startPublisher(opts: PublisherOptions & { intervalMs?: number }): () => Promise<void> {
  let running: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (running) return;
    running = publishDue(opts)
      .then((r) => {
        for (const [kind, keys] of Object.entries(r)) if ((keys as string[]).length) console.log(`[nrms] ${kind}: ${(keys as string[]).join(", ")}`);
      })
      .catch((e) => console.error("[nrms] publish failed", e))
      .finally(() => {
        running = null;
      });
  }, opts.intervalMs ?? 60_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await running;
  };
}

/**
 * Suite review O2.1: releases whose publish time passed more than `graceMs` ago and that are
 * still scheduled (or stuck publishing), leaving out ones on hold. `/stack/health` reports them,
 * since the publisher otherwise fails silently from the operator's point of view.
 */
export async function overdueScheduled(db: Db, opts: { graceMs: number; now?: TestClock }): Promise<{ count: number; oldestMinutes: number | null }> {
  const now = sqlNow(opts.now);
  const { rows } = await db.execute<{ n: number; oldest: number | null }>(sql`
    SELECT count(*)::int AS n, floor(extract(epoch from (${now} - min(publish_at))) / 60)::int AS oldest
      FROM ${newsReleases}
     WHERE status IN ('scheduled', 'publishing') AND NOT on_hold AND publish_at <= ${now} - ${sqlInterval(opts.graceMs)}`);
  const r = rows[0];
  const count = Number(r?.n ?? 0);
  return { count, oldestMinutes: count === 0 || r?.oldest === null || r?.oldest === undefined ? null : Number(r.oldest) };
}
