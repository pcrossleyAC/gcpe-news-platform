import { sql, type SQL } from "drizzle-orm";
import { sqlInterval, sqlNow, sqlNowPlus, type Db, type TestClock, type Tx } from "@gcpe/db-kit";
import { LANG_EN, type ReleaseView } from "@gcpe/nrms-contract";
import { flickrJobs, newsReleases } from "../db/schema";
import { SYSTEM_ACTOR, writeLog } from "../releases/store";
import { FlickrError, isFlickrUrl, photoIdFromUrl, type FlickrClient } from "./flickr-client";

/**
 * Making a release's Flickr photo public (verified) before it goes live.
 *
 * The publisher's `prepareMedia` ({@link flickrPrepareMedia}) never calls Flickr: it reads the
 * release's job and either defers the release (job pending, within the grace period), publishes
 * with the photo's static URL (job done), or publishes without the photo and raises the release's
 * `flickr_alert` (grace over, or the job gave up). The worker ({@link processFlickrJobs}) does the
 * Flickr calls outside any transaction, sends alerts, and — once a photo that a live release went
 * out without becomes public — moves that release back to `publishing` so it's republished
 * (a correction) with the photo. Every time comparison uses the database clock.
 */

/** Thrown by `prepareMedia` to leave a release as it is (scheduled/publishing) until a later run. */
export class DeferPublish extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeferPublish";
  }
}

/** How long after the first failed attempt the release waits for its photo. */
export const GRACE_MS = 120_000;
export const RETRY_MS_IN_GRACE = 30_000;
export const RETRY_MS = 300_000;
/**
 * Backstop margin added on top of {@link GRACE_MS} for a job the worker has never attempted at
 * all (`first_attempt_at IS NULL`): `in_grace` alone is unconditionally true in that case, so
 * without this a release would be deferred forever if the worker never runs (crashed, disabled).
 * Measured from the release's `publish_at` — the only time reference available before any
 * attempt exists — with enough margin that a normally-running worker is never caught by it.
 */
export const GRACE_BACKSTOP_MARGIN_MS = 300_000;
/** After this long since the first failed attempt the job stops retrying. */
export const GIVE_UP_MS = 86_400_000;
/** The claim's lease: a crashed worker's job becomes claimable again after this. */
const LEASE_MS = 60_000;
const MAX_ERROR = 300;

export const outWithoutPhotoAlert = (lastError: string | null) =>
  `The Flickr photo couldn't be made public (${lastError ?? "unknown error"}). The release went out without it; NRMS keeps trying for 24 hours.`;
export const gaveUpAlert = (lastError: string | null) =>
  `The Flickr photo couldn't be made public after 24 hours (${lastError ?? "unknown error"}). The release is live without it — re-add or replace the photo.`;

/** The publisher's `prepareMedia` for Flickr photos. Only touches the DB (inside the publisher's transaction). */
export function flickrPrepareMedia(opts: { now?: TestClock } = {}): (tx: Tx, view: ReleaseView) => Promise<{ assetUrl: string | null }> {
  return async (tx, view) => {
    const clearAlert = async () => {
      if (view.flickrAlert !== null) await tx.update(newsReleases).set({ flickrAlert: null }).where(sql`${newsReleases.id} = ${view.id}`);
    };
    const url = view.assetUrl;
    const photoId = url && isFlickrUrl(url) ? photoIdFromUrl(url) : null;
    // Not a Flickr photo (none, YouTube, the live page — or a Flickr link that isn't a photo, which
    // saveAsset refuses): nothing to make public.
    if (!url || !photoId) {
      await clearAlert();
      return { assetUrl: url };
    }
    const now = sqlNow(opts.now);
    // publish_at is NOT NULL for every status prepareMedia runs against (the DB check
    // constraint); the `view.publishAt ? … : false` guard is only to satisfy the JS type.
    const pastBackstop = view.publishAt
      ? sql`(first_attempt_at IS NULL AND ${now} - ${view.publishAt}::timestamptz > ${sqlInterval(GRACE_MS + GRACE_BACKSTOP_MARGIN_MS)})`
      : sql`false`;
    const r = await tx.execute<{ photo_id: string; status: "pending" | "done" | "gave_up"; static_url: string | null; last_error: string | null; in_grace: boolean; past_backstop: boolean }>(sql`
      SELECT photo_id, status, static_url, last_error,
             (first_attempt_at IS NULL OR ${now} - first_attempt_at < ${sqlInterval(GRACE_MS)}) AS in_grace,
             ${pastBackstop} AS past_backstop
      FROM ${flickrJobs} WHERE release_id = ${view.id} FOR UPDATE`);
    const job = r.rows[0];
    if (!job || job.photo_id !== photoId) {
      await tx.execute(sql`
        INSERT INTO ${flickrJobs} (release_id, photo_id, status, attempts, first_attempt_at, next_attempt_at, last_error, static_url, alerted_at, updated_at)
        VALUES (${view.id}, ${photoId}, 'pending', 0, NULL, ${now}, NULL, NULL, NULL, ${now})
        ON CONFLICT (release_id) DO UPDATE SET
          photo_id = excluded.photo_id, status = 'pending', attempts = 0, first_attempt_at = NULL, next_attempt_at = excluded.next_attempt_at,
          last_error = NULL, static_url = NULL, alerted_at = NULL, updated_at = excluded.updated_at`);
      throw new DeferPublish("waiting for Flickr");
    }
    if (job.status === "done") {
      await clearAlert();
      return { assetUrl: job.static_url };
    }
    if (job.status === "pending" && job.in_grace && !job.past_backstop) throw new DeferPublish("waiting for Flickr");
    const alert = job.status === "gave_up" ? gaveUpAlert(job.last_error) : outWithoutPhotoAlert(job.last_error);
    await tx.update(newsReleases).set({ flickrAlert: alert }).where(sql`${newsReleases.id} = ${view.id}`);
    return { assetUrl: null };
  };
}

export interface FlickrJobsOptions {
  db: Db;
  flickr: FlickrClient | null;
  alert: (subject: string, text: string) => Promise<void>;
  now?: TestClock;
  limit?: number;
}

export interface FlickrJobsResult {
  done: string[];
  retried: string[];
  gaveUp: string[];
  alerted: string[];
  republished: string[];
}

type Claimed = {
  release_id: string;
  key: string | null;
  photo_id: string;
  asset_url: string | null;
};

/**
 * A release whose photo may be made public (alias `r`): due to go live, a correction in flight, or
 * live without its photo (recovery).
 */
const goingOut = (now: SQL) => sql`(
  (r.status = 'scheduled' AND NOT r.on_hold AND r.publish_at <= ${now})
  OR r.status = 'publishing'
  OR (r.status = 'published' AND r.live AND r.flickr_alert IS NOT NULL))`;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, MAX_ERROR);

/** One Flickr attempt for a claimed job, outside any transaction. */
async function attempt(flickr: FlickrClient | null, photoId: string, pageUrl: string): Promise<{ ok: true; staticUrl: string } | { ok: false; gaveUp: boolean; error: string }> {
  if (!flickr) return { ok: false, gaveUp: false, error: "Flickr isn't configured" };
  try {
    if ((await flickr.getVisibility(photoId)) === "private") await flickr.makePublic(photoId);
    if (!(await flickr.confirmPublic(photoId))) return { ok: false, gaveUp: false, error: "Flickr still reports the photo as private" };
  } catch (e) {
    if (e instanceof FlickrError && e.kind === "not-found") return { ok: false, gaveUp: true, error: "photo not found" };
    return { ok: false, gaveUp: false, error: errorText(e) };
  }
  try {
    return { ok: true, staticUrl: await flickr.staticImageUrl(pageUrl) };
  } catch (e) {
    // oEmbed answers 404 for a photo that's only just been made public too: retry, don't give up.
    return { ok: false, gaveUp: false, error: errorText(e) };
  }
}

export async function processFlickrJobs(opts: FlickrJobsOptions): Promise<FlickrJobsResult> {
  const out: FlickrJobsResult = { done: [], retried: [], gaveUp: [], alerted: [], republished: [] };
  const limit = opts.limit ?? 10;
  const label = (j: { key: string | null; release_id: string }) => j.key ?? j.release_id;

  // 1. Claim due jobs: a short transaction that only takes a lease. Only a release that is going
  // out may have its photo made public (an embargoed photo must stay private): a job of any
  // other release — cancelled, on hold, unpublished, failed — is dropped without calling Flickr.
  const claimed = await opts.db.transaction(async (tx) => {
    const now = sqlNow(opts.now);
    await tx.execute(sql`
      DELETE FROM ${flickrJobs} j USING ${newsReleases} r
      WHERE r.id = j.release_id AND j.status IN ('pending', 'gave_up') AND NOT ${goingOut(now)}`);
    const r = await tx.execute<Claimed>(sql`
      WITH due AS (
        SELECT j.release_id FROM ${flickrJobs} j JOIN ${newsReleases} r ON r.id = j.release_id
        WHERE j.status = 'pending' AND j.next_attempt_at <= ${now} AND ${goingOut(now)}
        ORDER BY j.next_attempt_at, j.release_id
        FOR UPDATE OF j SKIP LOCKED LIMIT ${limit}
      )
      UPDATE ${flickrJobs} j SET next_attempt_at = ${sqlNowPlus(LEASE_MS, opts.now)}
      FROM due, ${newsReleases} r
      WHERE j.release_id = due.release_id AND r.id = j.release_id
      RETURNING j.release_id, r.key, j.photo_id, r.asset_url`);
    return r.rows;
  });

  // 2. Work each job outside any transaction; every write is guarded by the claimed photo and
  // `pending`, so a job the publisher replaced meanwhile (new photo) is left alone.
  for (const job of claimed) {
    const guard = sql`release_id = ${job.release_id} AND photo_id = ${job.photo_id} AND status = 'pending'`;
    const current = job.asset_url && isFlickrUrl(job.asset_url) ? photoIdFromUrl(job.asset_url) : null;
    if (current !== job.photo_id) {
      // The release no longer uses this photo: never make it public.
      await opts.db.execute(sql`DELETE FROM ${flickrJobs} WHERE ${guard}`);
      continue;
    }
    const result = await attempt(opts.flickr, job.photo_id, job.asset_url!);
    if (result.ok) {
      const r = await opts.db.execute(sql`
        UPDATE ${flickrJobs} SET status = 'done', static_url = ${result.staticUrl}, last_error = NULL, updated_at = ${sqlNow(opts.now)}
        WHERE ${guard} RETURNING release_id`);
      if (r.rows.length) out.done.push(label(job));
      continue;
    }
    const status = await opts.db.transaction(async (tx) => {
      const now = sqlNow(opts.now);
      const since = sql`(${now} - coalesce(first_attempt_at, ${now}))`;
      const r = await tx.execute<{ status: string; last_error: string | null }>(
        result.gaveUp
          ? sql`
            UPDATE ${flickrJobs} SET status = 'gave_up', attempts = attempts + 1, first_attempt_at = coalesce(first_attempt_at, ${now}),
              last_error = ${result.error}, updated_at = ${now}
            WHERE ${guard} RETURNING status, last_error`
          : sql`
            UPDATE ${flickrJobs} SET attempts = attempts + 1, first_attempt_at = coalesce(first_attempt_at, ${now}), last_error = ${result.error},
              next_attempt_at = ${now} + CASE WHEN ${since} < ${sqlInterval(GRACE_MS)} THEN ${sqlInterval(RETRY_MS_IN_GRACE)} ELSE ${sqlInterval(RETRY_MS)} END,
              status = CASE WHEN ${since} >= ${sqlInterval(GIVE_UP_MS)} THEN 'gave_up' ELSE 'pending' END,
              updated_at = ${now}
            WHERE ${guard} RETURNING status, last_error`,
      );
      const row = r.rows[0];
      // A release that already went out without the photo now carries the gave-up message (one
      // still waiting gets it from the publisher).
      if (row?.status === "gave_up") {
        await tx.execute(sql`UPDATE ${newsReleases} SET flickr_alert = ${gaveUpAlert(row.last_error)} WHERE id = ${job.release_id} AND flickr_alert IS NOT NULL`);
      }
      return row?.status;
    });
    if (status === "gave_up") out.gaveUp.push(label(job));
    else if (status === "pending") out.retried.push(label(job));
  }

  // 3. Alerts, for a live release that went out without its photo: once, and again when its job
  // gives up. Claimed first (alerted_at set in one guarded UPDATE) so concurrent runs can't both
  // send; a failed send releases the claim for the next run.
  {
    const now = sqlNow(opts.now);
    const r = await opts.db.execute<{ release_id: string; key: string | null; status: string; flickr_alert: string; asset_url: string | null; headline: string | null }>(sql`
      UPDATE ${flickrJobs} j SET alerted_at = ${now}
      FROM ${newsReleases} r
      WHERE r.id = j.release_id AND r.live AND r.flickr_alert IS NOT NULL
        AND (j.status = 'gave_up' OR (j.status = 'pending' AND j.first_attempt_at <= ${now} - ${sqlInterval(GRACE_MS)}))
        AND (j.alerted_at IS NULL OR (j.status = 'gave_up' AND j.alerted_at < j.updated_at))
      RETURNING r.id AS release_id, r.key, r.status, r.flickr_alert, r.asset_url,
        (SELECT dl.headline FROM release_documents d JOIN document_languages dl ON dl.document_id = d.id AND dl.language_id = ${LANG_EN}
         WHERE d.release_id = r.id ORDER BY d.sort_index LIMIT 1) AS headline`);
    for (const a of [...r.rows].sort((x, y) => (x.release_id < y.release_id ? -1 : 1))) {
      const headline = a.headline || "(no headline)";
      const subject = `Flickr photo not public: ${headline}`;
      const text = [
        `Release: ${headline}`,
        `Key: ${a.key ?? "(none)"}`,
        `Status: ${a.status}`,
        `Photo: ${a.asset_url ?? "(none)"}`,
        "",
        a.flickr_alert,
      ].join("\n");
      try {
        await opts.alert(subject, text);
      } catch (e) {
        console.error(`[nrms] flickr alert for ${a.key ?? a.release_id} failed: ${errorText(e)}`);
        await opts.db.execute(sql`UPDATE ${flickrJobs} SET alerted_at = NULL WHERE release_id = ${a.release_id}`);
        continue;
      }
      out.alerted.push(a.key ?? a.release_id);
    }
  }

  // 4. Recovery: a live release that went out without its now-public photo is republished with it.
  const candidates = await opts.db.execute<{ id: string }>(sql`
    SELECT r.id FROM ${flickrJobs} j JOIN ${newsReleases} r ON r.id = j.release_id
    WHERE j.status = 'done' AND r.flickr_alert IS NOT NULL AND r.live AND r.status = 'published' ORDER BY r.id`);
  for (const { id } of candidates.rows) {
    const key = await opts.db.transaction(async (tx) => {
      const r = await tx.execute<{ key: string | null }>(sql`
        UPDATE ${newsReleases} SET status = 'publishing', version = version + 1, updated_at = ${sqlNow(opts.now)}
        WHERE id = ${id} AND flickr_alert IS NOT NULL AND live AND status = 'published'
          AND EXISTS (SELECT 1 FROM ${flickrJobs} WHERE release_id = ${id} AND status = 'done')
        RETURNING key`);
      if (!r.rows.length) return undefined;
      await writeLog(tx, id, SYSTEM_ACTOR, "Flickr photo is now public — republishing with the photo");
      return r.rows[0]!.key ?? id;
    });
    if (key !== undefined) out.republished.push(key);
  }
  return out;
}

/** Runs {@link processFlickrJobs} every `intervalMs` (default 30 s); returns a stopper. */
export function startFlickrJobs(opts: FlickrJobsOptions & { intervalMs?: number }): () => Promise<void> {
  let running: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (running) return;
    running = processFlickrJobs(opts)
      .then((r) => {
        for (const [kind, keys] of Object.entries(r)) if (keys.length) console.log(`[nrms] flickr ${kind}: ${keys.join(", ")}`);
      })
      .catch((e) => console.error(`[nrms] flickr jobs failed: ${errorText(e)}`))
      .finally(() => {
        running = null;
      });
  }, opts.intervalMs ?? 30_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await running;
  };
}
