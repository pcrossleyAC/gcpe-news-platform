/** A lock is live while its holder was active in the last 15 minutes (spec addendum §7.5).
 * Shared by the server (apps/calendar/src/activities/store.ts, which lapses the row at
 * `lastActiveAt + LOCK_IDLE_MS`) and the browser (useEditLock.ts, which must lapse on the same
 * clock the server enforces), so the two can never drift apart. */
export const LOCK_IDLE_MS = 15 * 60_000;
