/**
 * BC-local date/time <-> UTC instant conversion for the schedule picker (task-3-brief.md:
 * "input a BC local date+time ... and convert to an ISO instant DST-correctly").
 *
 * The zone math itself lives in format/bcTime.ts, the Hub's one BC-time path (owner decision
 * 2026-10-31), so these agree with every time the Hub shows — and are right on a browser whose
 * tzdata predates BC's permanent UTC-7. Saving never depends on them: Schedule and the planned
 * publish date send the typed BC wall-clock string, and the server converts it.
 */
import { offsetMinutesAt, wallClockToInstant, zonedDateTime } from "../../format/bcTime";

export { wallClockToInstant };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

/**
 * Combines a BC-local `YYYY-MM-DD` date and `HH:MM` time (as typed into the schedule picker)
 * into the real UTC instant they represent in `timeZone`, DST-correctly. This instant is no
 * longer sent to the server for scheduling (fix round 1, finding 3 and its follow-up: the
 * Schedule action and Settings' planned date both send the raw local string instead, and the
 * server converts it) — it now backs only local comparisons (e.g. an unsaved-changes dirty
 * check) and an optional preview.
 */
export function bcLocalToInstant(date: string, time: string, timeZone: string): string {
  const dateMatch = DATE_RE.exec(date);
  const timeMatch = TIME_RE.exec(time);
  if (!dateMatch || !timeMatch) throw new Error(`invalid BC local date/time: ${date} ${time}`);
  const [, year, month, day] = dateMatch;
  const [, hour, minute] = timeMatch;
  const wallAsUtc = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), 0, 0));
  return wallClockToInstant(wallAsUtc, timeZone).toISOString();
}

/** The inverse of {@link bcLocalToInstant}: the BC-local date/time an ISO instant shows as, for
 * pre-filling the picker when editing an existing scheduled/planned time. */
export function instantToBcLocal(iso: string, timeZone: string): { date: string; time: string } {
  return zonedDateTime(iso, timeZone);
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Now, as a "YYYY-MM-DDTHH:mm" wall-clock minute in `timeZone` — comparable as a string with a
 * picker's `local` value. For Schedule's "is this time still in the future" check, which has to
 * agree with the server (it converts `publishAtLocal` with its own tzdata and publishes a time
 * at or before now at once).
 *
 * The offset is format/bcTime.ts's, so already corrected on an old-tzdata browser once AppShell
 * has the server's rule. `serverOffsetMinutes` (`GET /nrms/api/config`'s `tzCheck.offsetMinutes`,
 * UTC-7 for BC) stays as a second guard for the moment before that: when both answers are known
 * the later wall clock wins, so a time is only "in the future" if it is by both reckonings.
 */
export function wallClockNowMinute(
  nowMs: number,
  timeZone: string,
  serverOffsetMinutes: number | null,
  browserOffset: (epochMs: number, timeZone: string) => number = offsetMinutesAt,
): string {
  const offsets = [browserOffset(nowMs, timeZone), ...(serverOffsetMinutes === null ? [] : [serverOffsetMinutes])];
  const wall = new Date(nowMs + Math.max(...offsets) * 60_000);
  return `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}T${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}`;
}
