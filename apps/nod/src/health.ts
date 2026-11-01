import { sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";

/**
 * Suite review O2.1 (owner 2026-10-31): what NoD tells `/stack/health` about its background
 * work, as minutes since each last went right. The stack decides what is too long.
 *
 * The digest, the emergency feed and the Media Hub sync already record when they ran, so those
 * come from NoD's own settings by the database's clock. The send loop records nothing, so the
 * last successful send is kept in this process's memory (`sendLastOkAt`) and starts unknown
 * after every restart.
 */
export interface NodHealth {
  /** Minutes since the last daily digest ran; null when none has. */
  digestMinutesAgo: number | null;
  /** Off when no feed address is set (or the feed is switched off). */
  emergencyFeed: { on: boolean; minutesSinceLastCheck: number | null; lastCheckOk: boolean | null };
  /** Off when no Media Hub is configured. */
  mediaSync: { on: boolean; minutesSinceLastSuccess: number | null; lastRunFailed: boolean };
  /** Minutes since this process's send loop last finished a run without failing; null when it hasn't yet. */
  sendLoopMinutesAgo: number | null;
}

export interface NodHealthOptions {
  emergencyFeedOn: boolean;
  mediaSyncOn: boolean;
  /** When the send loop last finished a run (epoch ms), from this process's memory. */
  sendLastOkAt: () => number | null;
}

const minutes = (v: unknown): number | null => (v === null || v === undefined ? null : Math.max(0, Number(v)));

export async function nodHealth(db: Db, opts: NodHealthOptions): Promise<NodHealth> {
  const { rows } = await db.execute<{ digest: number | null; feed_checked: number | null; feed_ok: boolean | null; media_ok: number | null; media_failed: boolean | null }>(sql`
    SELECT floor(extract(epoch from (now() - (SELECT max(ran_at) FROM digest_runs))) / 60)::int AS digest,
           floor(extract(epoch from (now() - s.emergency_feed_checked_at)) / 60)::int AS feed_checked,
           (s.emergency_feed_result ->> 'ok')::boolean AS feed_ok,
           floor(extract(epoch from (now() - s.media_sync_since)) / 60)::int AS media_ok,
           (s.media_sync_result ? 'error') AS media_failed
      FROM nod_settings s
     WHERE s.id = 1`);
  const r = rows[0];
  const sentAt = opts.sendLastOkAt();
  return {
    digestMinutesAgo: minutes(r?.digest),
    emergencyFeed: { on: opts.emergencyFeedOn, minutesSinceLastCheck: minutes(r?.feed_checked), lastCheckOk: r?.feed_ok ?? null },
    mediaSync: { on: opts.mediaSyncOn, minutesSinceLastSuccess: minutes(r?.media_ok), lastRunFailed: r?.media_failed === true },
    sendLoopMinutesAgo: sentAt === null ? null : Math.max(0, Math.floor((Date.now() - sentAt) / 60_000)),
  };
}
