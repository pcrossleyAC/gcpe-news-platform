import { and, eq, isNull, or, sql } from "drizzle-orm";
import { sqlInterval, type Db } from "@gcpe/db-kit";
import { distributionSettings } from "../db/schema";
import { parseBounce } from "./parse";
import { recordBounce } from "./store";
import type { BounceSource } from "./source";

// Global Constraints "Schedule": every 15 minutes from the tick.
const GATE_INTERVAL_MS = 15 * 60_000;
// Spec: a run is bounded to at most this many messages.
const DEFAULT_LIMIT = 200;

export interface RunBouncesResult {
  ran: boolean;
  fetched: number;
  bounces: number;
  matched: number;
  ignored: number;
}

/**
 * Claims the 15-minute gate with one atomic UPDATE, inside its own short transaction: the
 * `WHERE` only matches the settings row when it's actually due (never checked, or checked
 * long enough ago), and the `SET` stamps it checked right there, by the database's own clock.
 * Postgres's row lock on the matched row is what makes two concurrent callers resolve to
 * exactly one claim -- the second blocks behind the first's lock, then re-evaluates its WHERE
 * clause against the now-committed row and matches nothing. No explicit lease is needed (unlike
 * NoD's media sync): a run here is always bounded to DEFAULT_LIMIT messages, so nothing needs
 * to survive longer than this one claim.
 */
async function claimBounceGate(db: Db): Promise<boolean> {
  return db.transaction(async (tx) => {
    const claimed = await tx
      .update(distributionSettings)
      .set({ bouncesCheckedAt: sql`now()` })
      .where(
        and(
          eq(distributionSettings.id, 1),
          or(isNull(distributionSettings.bouncesCheckedAt), sql`${distributionSettings.bouncesCheckedAt} <= now() - ${sqlInterval(GATE_INTERVAL_MS)}`),
        ),
      )
      .returning({ id: distributionSettings.id });
    return claimed.length > 0;
  });
}

/**
 * The 15-minute bounce run (Global Constraints "Schedule"/"Bounce source"): claims the gate,
 * then -- entirely outside that transaction, so the claim itself is never held open across
 * network I/O or per-message work -- fetches up to `limit` reports from `source`, parses and
 * records each in its own transaction (one bad message can't roll back its siblings), and
 * marks every fetched report processed, whether or not it was recognisable as a bounce or
 * matched anything. The source is polled, not drained: nothing fetched is ever left for a
 * retry that would just read it again (Global Constraints "Parsing": "every fetched message
 * is marked processed, as legacy did").
 */
export async function runBouncesIfDue(db: Db, source: BounceSource, opts: { limit?: number } = {}): Promise<RunBouncesResult> {
  const due = await claimBounceGate(db);
  if (!due) return { ran: false, fetched: 0, bounces: 0, matched: 0, ignored: 0 };

  const fetched = await source.fetchNew(opts.limit ?? DEFAULT_LIMIT);
  let bounces = 0;
  let matched = 0;
  let ignored = 0;
  const processedIds: string[] = [];

  for (const message of fetched) {
    processedIds.push(message.id);
    try {
      const parsed = await parseBounce(message.raw);
      const result = await db.transaction((tx) => recordBounce(tx, message.id, message.raw, parsed));
      if (parsed.kind === "bounce") bounces++;
      else ignored++;
      if (result.matched) matched++;
    } catch (e) {
      // Per-message errors are counted (this message contributes to `fetched` but not to
      // `bounces`/`ignored`) and never stop the run -- the rest of `fetched` still gets
      // processed below. The raw content is never logged (Global Constraints "Logs"), only
      // the error's own message.
      console.error(`[distribution] bounce ${message.id} failed to process:`, e instanceof Error ? e.message : e);
    }
  }

  if (processedIds.length > 0) await source.markProcessed(processedIds);

  return { ran: true, fetched: fetched.length, bounces, matched, ignored };
}

/**
 * Runs {@link runBouncesIfDue} every `intervalMs` (default once a minute), one run at a time --
 * the gate itself is what actually spaces real runs 15 minutes apart; this loop just has to
 * call often enough that the gate is never missed by much. Mirrors
 * apps/nod/src/digest.ts's startDigestLoop.
 */
export function startBounceLoop(opts: { db: Db; source: BounceSource; limit?: number; intervalMs?: number }): () => Promise<void> {
  let stopped = false;
  let running: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = runBouncesIfDue(opts.db, opts.source, { limit: opts.limit })
      .catch((e) => console.error("[distribution] bounce run failed:", e instanceof Error ? e.message : e))
      .finally(() => {
        running = null;
      });
  }, opts.intervalMs ?? 60_000);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
