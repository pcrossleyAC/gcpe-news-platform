import { eq, sql } from "drizzle-orm";
import { sqlNow, type Db, type TestClock, type Tx } from "@gcpe/db-kit";
import { enqueueEvent, type SubscriberConfig } from "@gcpe/events";
import { publishProblems, type ReleaseView } from "@gcpe/nrms-contract";
import { newsReleases, releasePublications } from "./db/schema";
import { ReleaseRuleError } from "./releases/errors";
import { toReleaseRecord } from "./releases/record";
import { loadView, SYSTEM_ACTOR, writeLog } from "./releases/store";

export interface PublisherOptions {
  db: Db;
  subscribers: SubscriberConfig[];
  /** Test hook: stands in for SQL `now()` in every statement (due check and stamps). */
  now?: TestClock;
  limit?: number;
  /** Phase 3c seam: make the photo public etc. Returns the asset URL to publish. */
  prepareMedia?: (tx: Tx, view: ReleaseView) => Promise<{ assetUrl: string | null }>;
}

export interface PublishResult {
  published: string[];
  updated: string[];
  unpublished: string[];
  failed: string[];
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
  const view = (await loadView(tx, id))!;
  const key = view.key ?? id;
  if (status === "unpublishing") {
    await enqueueEvent(tx, { type: "release.unpublished", source: "nrms", aggregateId: key, data: { key } }, opts.subscribers);
    await tx.update(newsReleases).set({ status: view.reference ? "approved" : "draft", live: false, version: view.version + 1, updatedAt: now }).where(eq(newsReleases.id, id));
    await writeLog(tx, id, SYSTEM_ACTOR, "Unpublished from BC Gov News");
    return { kind: "unpublished", key };
  }
  const problems = publishProblems(view);
  if (problems.length) throw new ReleaseRuleError(problems);
  const { assetUrl } = opts.prepareMedia ? await opts.prepareMedia(tx, view) : { assetUrl: view.assetUrl };
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
      atomId: sql`coalesce(${newsReleases.atomId}, ${`uuid:${id}`})`,
      lastError: null,
      version: view.version + 1,
      updatedAt: stamp,
    })
    .where(eq(newsReleases.id, id))
    .returning({ releasedAt: newsReleases.releasedAt, atomId: newsReleases.atomId, updatedAt: newsReleases.updatedAt });
  const record = toReleaseRecord({ ...view, assetUrl, atomId: row!.atomId }, { publishDate: row!.releasedAt!.toISOString(), timestamp: row!.updatedAt.toISOString() });
  if (goLive) {
    await enqueueEvent(tx, { type: "release.published", source: "nrms", aggregateId: record.key, data: record }, opts.subscribers);
    await writeLog(tx, id, SYSTEM_ACTOR, "Released for Publishing");
    await writeLog(tx, id, SYSTEM_ACTOR, `Published to ${destinations(view)}`);
  } else {
    await enqueueEvent(tx, { type: "release.updated", source: "nrms", aggregateId: record.key, data: { ...record, notify: true } }, opts.subscribers);
    await writeLog(tx, id, SYSTEM_ACTOR, `Republished to ${destinations(view)}`);
  }
  await tx.insert(releasePublications).values({ releaseId: id, publishedAt: row!.updatedAt, actorId: SYSTEM_ACTOR.id, actorName: SYSTEM_ACTOR.name, record });
  return { kind: goLive ? "published" : "updated", key: record.key };
}

/**
 * One transaction per release, claimed FOR UPDATE SKIP LOCKED so replicas never double-publish.
 * A failure after the claim marks only that release failed (never wedges the queue); a failure
 * of the claim itself propagates. Every due/now comparison uses the database clock.
 */
export async function publishDue(opts: PublisherOptions): Promise<PublishResult> {
  const limit = opts.limit ?? 50;
  const out: PublishResult = { published: [], updated: [], unpublished: [], failed: [] };
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
        const updated = await tx
          .update(newsReleases)
          .set({ status: "failed", lastError: message, updatedAt: sqlNow(opts.now), version: sql`${newsReleases.version} + 1` })
          .where(sql`${newsReleases.id} = ${c.id} AND ${newsReleases.status} IN ('scheduled', 'publishing')`)
          .returning({ id: newsReleases.id });
        if (updated.length) await writeLog(tx, c.id, SYSTEM_ACTOR, `Publishing failed: ${message}`);
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
