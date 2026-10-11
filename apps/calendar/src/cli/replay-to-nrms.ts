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
import { parseSubscribers, type SubscriberConfig } from "@gcpe/events";
import { safeErrorLabel } from "@gcpe/http-kit";
import { emitActivity } from "../activities/events";
import { activities } from "../db/schema";
import { rulesFromTenant } from "../rules";

const BATCH_SIZE = 200;

export interface ReplayToNrmsOptions {
  confirm: boolean;
  rules: CalendarRules;
  subscribers: SubscriberConfig[];
}

export interface ReplayToNrmsResult {
  confirmed: boolean;
  count: number;
  /** Activities that failed to replay, with a safe label; the run goes on past each. */
  failures: { id: number; reason: string }[];
}

export async function replayToNrms(db: Db, opts: ReplayToNrmsOptions): Promise<ReplayToNrmsResult> {
  const ids = (await db.select({ id: activities.id }).from(activities).orderBy(asc(activities.id))).map((r) => r.id);
  if (!opts.confirm) return { confirmed: false, count: ids.length, failures: [] };
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
  return { confirmed: true, count: ids.length, failures };
}

export function printResult(r: ReplayToNrmsResult, log: (s: string) => void = console.log): void {
  if (!r.confirmed) {
    log(`${r.count} activit${r.count === 1 ? "y" : "ies"} would be sent to NRMS. Dry run: nothing enqueued. Re-run with --confirm to send.`);
    return;
  }
  log(`Sent ${r.count - r.failures.length} of ${r.count} activities to NRMS as activity.updated.`);
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
    if (result.failures.length > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (pathToFileURL(realpathSync(process.argv[1]!)).href === import.meta.url) {
  await main();
}
