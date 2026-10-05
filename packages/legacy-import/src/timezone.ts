/**
 * Legacy `DATETIME` columns (no offset, e.g. `NewsRelease.ReleaseDateTime`) were set by the
 * legacy app as server-local wall-clock time, and the mssql/tedious driver decodes `DATETIME` as
 * UTC (`useUTC: true`) — so a Date read from one of those columns has its *UTC* fields holding
 * the wall-clock value, not a real instant. This converts such a Date back to the real instant
 * it represents in `timeZone`, DST-aware:
 *
 *  - an ordinary wall-clock time has exactly one matching instant — returned directly.
 *  - the repeated "fall back" hour (e.g. 1:00-1:59 happening twice) has two matching instants —
 *    the earlier (pre-fall-back, DST) one is picked.
 *  - the skipped "spring forward" hour (e.g. 2:00-2:59 never happening) has no matching instant —
 *    the wall-clock time is shifted forward by the size of the gap (into the DST side) first.
 *
 * `DATETIMEOFFSET` columns (e.g. `NewsRelease.PublishDateTime`, `NewsReleaseLog.DateTime`) are
 * already real instants and must never be passed through this function.
 */

interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** The wall-clock fields `timeZone` shows for the real instant `epochMs`. */
function zonedPartsAt(epochMs: number, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(epochMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** `instant`'s wall-clock fields in `timeZone`, re-interpreted as if they were themselves UTC. */
function localAsUtcMs(epochMs: number, timeZone: string): number {
  const p = zonedPartsAt(epochMs, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, new Date(epochMs).getUTCMilliseconds());
}

/** How far ahead of local wall-clock time `timeZone`'s real instant `epochMs` is, in ms (e.g. +7h for PDT). */
function offsetAt(epochMs: number, timeZone: string): number {
  return epochMs - localAsUtcMs(epochMs, timeZone);
}

/**
 * `d`'s UTC fields hold a wall-clock time meant for `timeZone` (as tedious decodes legacy
 * `DATETIME` columns). Returns the real instant that wall-clock time represents in `timeZone`.
 */
export function wallClockToInstant(d: Date, timeZone: string): Date {
  const wallMs = d.getTime();

  const offset1 = offsetAt(wallMs, timeZone);
  const instant1 = wallMs + offset1;
  const offset2 = offsetAt(instant1, timeZone);

  if (offset2 === offset1) return new Date(instant1); // unambiguous — the common case

  const instant2 = wallMs + offset2;
  const roundTrips = (instant: number) => localAsUtcMs(instant, timeZone) === wallMs;

  const valid = [instant1, instant2].filter(roundTrips);
  if (valid.length > 0) {
    // Overlap (fall-back): both instants map back to the same wall-clock time. Pick the earlier
    // one (the controller ruling: the earlier, DST instant wins the ambiguous hour).
    return new Date(Math.min(...valid));
  }

  // Gap (spring-forward): no instant maps back to this wall-clock time at all. Shift the
  // wall-clock time forward by the size of the gap (into the DST side) and resolve from there.
  const gap = Math.abs(offset1 - offset2);
  const dstOffset = Math.min(offset1, offset2);
  return new Date(wallMs + gap + dstOffset);
}
