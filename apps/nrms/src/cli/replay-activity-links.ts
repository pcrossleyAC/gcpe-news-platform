/**
 * `npm run nrms:replay-activity-links -- --confirm` (spec addendum §11 backfill): sends
 * `release.status_changed` for every non-deleted release with a Calendar activity id, through the
 * normal outbox, so the Calendar's activities show their releases. Run it after
 * `calendar:replay-to-nrms`, so NRMS's projection says which activities the Calendar holds: the
 * report counts the releases linked to one it doesn't (not migrated, C158), which the Calendar
 * ignores. Dry run by default; `--confirm` to enqueue. Each release is read under its row lock.
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { and, asc, eq, isNotNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { parseEnv } from "@gcpe/config";
import { createDb, type Db } from "@gcpe/db-kit";
import { parseSubscribers, subscribersFor, type SubscriberConfig } from "@gcpe/events";
import { safeErrorLabel } from "@gcpe/http-kit";
import { calendarActivities, newsReleases } from "../db/schema";
import { linkStateOf, sendStatusChanged, statusChangedData } from "../releases/link-events";

const BATCH_SIZE = 200;
const LINKED = and(isNotNull(newsReleases.activityId), ne(newsReleases.status, "deleted"));
const EVENT_TYPE = "release.status_changed";

export interface ReplayActivityLinksOptions {
  confirm: boolean;
  subscribers: SubscriberConfig[];
}

export interface ReplayActivityLinksResult {
  confirmed: boolean;
  count: number;
  /** Linked to an activity NRMS's projection doesn't hold: the Calendar ignores these. */
  notInProjection: number;
  /** Names (never url/secret) of the configured subscribers that would receive `release.status_changed`. */
  subscriberNames: string[];
  /** True when `--confirm` was requested but no configured subscriber accepts `release.status_changed`:
   * nothing was enqueued. */
  refused: boolean;
  failures: { id: string; reason: string }[];
}

export async function replayActivityLinks(db: Db, opts: ReplayActivityLinksOptions): Promise<ReplayActivityLinksResult> {
  const ids = (await db.select({ id: newsReleases.id }).from(newsReleases).where(LINKED).orderBy(asc(newsReleases.id))).map((r) => r.id);
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(newsReleases)
    .where(and(LINKED, sql`NOT EXISTS (SELECT 1 FROM ${calendarActivities} WHERE ${calendarActivities.id} = ${newsReleases.activityId})`));
  const subscriberNames = subscribersFor(EVENT_TYPE, opts.subscribers).map((s) => s.name);
  const base = { count: ids.length, notInProjection: n, subscriberNames };
  if (!opts.confirm) return { confirmed: false, ...base, refused: false, failures: [] };
  if (subscriberNames.length === 0) return { confirmed: true, ...base, refused: true, failures: [] };
  const failures: ReplayActivityLinksResult["failures"] = [];
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    await db.transaction(async (tx) => {
      for (const id of ids.slice(i, i + BATCH_SIZE)) {
        try {
          await tx.transaction(async (savepoint) => {
            await savepoint.select({ id: newsReleases.id }).from(newsReleases).where(eq(newsReleases.id, id)).for("update");
            const state = await linkStateOf(savepoint, id);
            if (state?.activityId != null && state.status !== "deleted") await sendStatusChanged(savepoint, statusChangedData(state, null), opts.subscribers);
          });
        } catch (e) {
          failures.push({ id, reason: safeErrorLabel(e) });
        }
      }
    });
  }
  return { confirmed: true, ...base, refused: false, failures };
}

export function printResult(r: ReplayActivityLinksResult, log: (s: string) => void = console.log): void {
  const names = r.subscriberNames.length > 0 ? r.subscriberNames.join(", ") : "(none)";
  if (r.refused) {
    log(`Refusing --confirm: no configured subscriber accepts ${EVENT_TYPE}. Set EVENT_SUBSCRIBERS so at least one subscriber's "types" include "${EVENT_TYPE}". Matching subscriber(s): ${names}.`);
    return;
  }
  const verb = r.confirmed ? "Sent" : "Would send";
  log(`${verb} the status of ${r.count - r.failures.length} of ${r.count} linked release(s) to the Calendar. Matching subscriber(s): ${names}.`);
  log(`${r.notInProjection} of them name an activity NRMS doesn't hold (not migrated): the Calendar ignores those.`);
  if (!r.confirmed) log("Dry run: nothing enqueued. Re-run with --confirm to send.");
  for (const f of r.failures) log(`  release ${f.id}: ${f.reason}`);
}

async function main(): Promise<void> {
  const env = parseEnv(z.object({ DATABASE_URL: z.string().url(), EVENT_SUBSCRIBERS: z.string().optional() }));
  const confirm = process.argv.slice(2).includes("--confirm");
  const { db, pool } = createDb(env.DATABASE_URL);
  try {
    const result = await replayActivityLinks(db, { confirm, subscribers: parseSubscribers(env.EVENT_SUBSCRIBERS) });
    printResult(result);
    if (result.refused || result.failures.length > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (pathToFileURL(realpathSync(process.argv[1]!)).href === import.meta.url) {
  main().catch((e) => {
    console.error(safeErrorLabel(e));
    process.exitCode = 1;
  });
}
