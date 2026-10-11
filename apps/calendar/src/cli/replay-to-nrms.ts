/**
 * `npm run calendar:replay-to-nrms -- --confirm` (spec addendum §11, §12.1): sends every activity's
 * current state to NRMS as `activity.updated`, through the normal outbox, so NRMS's activity
 * projection fills: after the 5i import, or for activities the Calendar held before NRMS had a
 * handler for them. A confidential activity goes as its id only and a deleted one as deleted, as
 * on any save (C127). Dry run by default; `--confirm` to enqueue. Each activity is read under its
 * row lock, so an edit committing meanwhile can't be overtaken by an older copy.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { loadTenantConfig, parseEnv } from "@gcpe/config";
import type { CalendarRules } from "@gcpe/calendar-contract";
import { createDb, type Db } from "@gcpe/db-kit";
import { parseSubscribers, subscribersFor, type SubscriberConfig } from "@gcpe/events";
import { safeErrorLabel } from "@gcpe/http-kit";
import { emitActivity } from "../activities/events";
import { activities } from "../db/schema";
import { rulesFromTenant } from "../rules";

const BATCH_SIZE = 200;
const EVENT_TYPE = "activity.updated";

export interface ReplayToNrmsOptions {
  confirm: boolean;
  rules: CalendarRules;
  subscribers: SubscriberConfig[];
}

export interface ReplayToNrmsResult {
  confirmed: boolean;
  count: number;
  /** Names (never url/secret) of the configured subscribers that would receive `activity.updated`. */
  subscriberNames: string[];
  /** True when `--confirm` was requested but no configured subscriber accepts `activity.updated`:
   * nothing was enqueued. */
  refused: boolean;
  /** Activities that failed to replay, with a safe label; the run goes on past each. */
  failures: { id: number; reason: string }[];
}

export async function replayToNrms(db: Db, opts: ReplayToNrmsOptions): Promise<ReplayToNrmsResult> {
  const ids = (await db.select({ id: activities.id }).from(activities).orderBy(asc(activities.id))).map((r) => r.id);
  const subscriberNames = subscribersFor(EVENT_TYPE, opts.subscribers).map((s) => s.name);
  if (!opts.confirm) return { confirmed: false, count: ids.length, subscriberNames, refused: false, failures: [] };
  if (subscriberNames.length === 0) return { confirmed: true, count: ids.length, subscriberNames, refused: true, failures: [] };
  const failures: ReplayToNrmsResult["failures"] = [];
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    await db.transaction(async (tx) => {
      for (const id of ids.slice(i, i + BATCH_SIZE)) {
        try {
          await tx.transaction(async (savepoint) => {
            await savepoint.select({ id: activities.id }).from(activities).where(eq(activities.id, id)).for("update");
            await emitActivity(savepoint, opts, id, "activity.updated");
          });
        } catch (e) {
          failures.push({ id, reason: safeErrorLabel(e) });
        }
      }
    });
  }
  return { confirmed: true, count: ids.length, subscriberNames, refused: false, failures };
}

export function printResult(r: ReplayToNrmsResult, log: (s: string) => void = console.log): void {
  const names = r.subscriberNames.length > 0 ? r.subscriberNames.join(", ") : "(none)";
  if (r.refused) {
    log(`Refusing --confirm: no configured subscriber accepts ${EVENT_TYPE}. Set EVENT_SUBSCRIBERS so at least one subscriber's "types" include "${EVENT_TYPE}". Matching subscriber(s): ${names}.`);
    return;
  }
  if (!r.confirmed) {
    log(`${r.count} activit${r.count === 1 ? "y" : "ies"} would be sent to NRMS. Matching subscriber(s): ${names}. Dry run: nothing enqueued. Re-run with --confirm to send.`);
    return;
  }
  log(`Sent ${r.count - r.failures.length} of ${r.count} activities to NRMS as activity.updated. Matching subscriber(s): ${names}.`);
  for (const f of r.failures) log(`  activity ${f.id}: ${f.reason}`);
}

async function main(): Promise<void> {
  const env = parseEnv(
    z.object({
      DATABASE_URL: z.string().url(),
      EVENT_SUBSCRIBERS: z.string().optional(),
      TENANT_CONFIG: z.string().default(fileURLToPath(new URL("../../../../config/tenants/bc.json", import.meta.url))),
    }),
  );
  const confirm = process.argv.slice(2).includes("--confirm");
  const { db, pool } = createDb(env.DATABASE_URL);
  try {
    const result = await replayToNrms(db, { confirm, rules: rulesFromTenant(loadTenantConfig(env.TENANT_CONFIG)), subscribers: parseSubscribers(env.EVENT_SUBSCRIBERS) });
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
