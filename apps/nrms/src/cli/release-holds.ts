/**
 * Phase 3e cutover (spec §8 safety point 2): `npm run nrms:release-holds -- --confirm` clears
 * `on_hold` on every imported scheduled release once legacy's own publisher is switched off, so
 * NRMS's publisher can take over. Without `--confirm` it only reports what it would do -- the
 * exact dry-run-by-default / `--confirm`-to-act shape every cutover command in this phase uses.
 */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { parseEnv } from "@gcpe/config";
import { createDb, type Db } from "@gcpe/db-kit";
import { newsReleases } from "../db/schema";
import { SYSTEM_ACTOR, writeLog } from "../releases/store";

const HELD = and(eq(newsReleases.status, "scheduled"), eq(newsReleases.onHold, true));

export interface HeldRelease {
  key: string | null;
  publishAt: string | null;
  /** `publishAt` has already passed -- the publisher will claim it on its very next tick. */
  publishesImmediately: boolean;
}

export interface ReleaseHoldsDryRun {
  confirmed: false;
  count: number;
  releases: HeldRelease[];
}

export interface ReleaseHoldsResult {
  confirmed: true;
  count: number;
}

async function dbNow(db: Db): Promise<Date> {
  const r = await db.execute<{ now: string | Date }>(sql`SELECT now() AS now`);
  return new Date(r.rows[0]!.now);
}

/**
 * Dry run (default): lists every held release and changes nothing. With `confirm: true`: in one
 * transaction, clears `on_hold` on every scheduled release, bumps its version, and writes one
 * system log entry per release -- "Hold released at cutover" -- mirroring how every other
 * workflow write bumps version and logs (releases/store.ts's `writeLog`/`mutateRelease`).
 */
export async function releaseHolds(db: Db, opts: { confirm: boolean }): Promise<ReleaseHoldsDryRun | ReleaseHoldsResult> {
  if (!opts.confirm) {
    const now = await dbNow(db);
    const rows = await db.select({ key: newsReleases.key, publishAt: newsReleases.publishAt }).from(newsReleases).where(HELD);
    const releases: HeldRelease[] = rows.map((r) => ({
      key: r.key,
      publishAt: r.publishAt ? r.publishAt.toISOString() : null,
      publishesImmediately: r.publishAt !== null && r.publishAt <= now,
    }));
    return { confirmed: false, count: releases.length, releases };
  }

  return db.transaction(async (tx) => {
    const rows = await tx.select({ id: newsReleases.id }).from(newsReleases).where(HELD).for("update");
    if (rows.length > 0) {
      await tx.update(newsReleases).set({ onHold: false, version: sql`${newsReleases.version} + 1`, updatedAt: sql`now()` }).where(HELD);
      for (const r of rows) await writeLog(tx, r.id, SYSTEM_ACTOR, "Hold released at cutover");
    }
    return { confirmed: true, count: rows.length };
  });
}

export function printDryRun(result: ReleaseHoldsDryRun, log: (s: string) => void = console.log): void {
  log(`${result.count} release(s) on hold:`);
  for (const r of result.releases) {
    const flag = r.publishesImmediately ? " (will publish immediately)" : "";
    log(`  ${r.key ?? "(no key)"} -- publish_at=${r.publishAt ?? "null"}${flag}`);
  }
  log("Dry run: nothing changed. Re-run with --confirm to clear the holds.");
}

async function main(): Promise<void> {
  const env = parseEnv(z.object({ DATABASE_URL: z.string().url() }));
  const confirm = process.argv.slice(2).includes("--confirm");
  const { db, pool } = createDb(env.DATABASE_URL);
  try {
    const result = await releaseHolds(db, { confirm });
    if (!result.confirmed) {
      printDryRun(result);
    } else {
      console.log(`Released ${result.count} hold(s).`);
    }
  } finally {
    await pool.end();
  }
}

// Runs only when this file is the process's entry point (e.g. `npm run nrms:release-holds`) --
// never when it's imported for its exported functions, such as from release-holds.test.ts.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
