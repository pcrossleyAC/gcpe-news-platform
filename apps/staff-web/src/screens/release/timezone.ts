/**
 * BC-local date/time <-> UTC instant conversion for the schedule picker (task-3-brief.md:
 * "input a BC local date+time ... and convert to an ISO instant DST-correctly").
 *
 * `wallClockToInstant` below is ported verbatim from packages/legacy-import/src/timezone.ts
 * (same zone-math pattern the importer uses for legacy `DATETIME` columns) rather than imported
 * from that package: @gcpe/legacy-import's package.json depends on `mssql`, a Node-only
 * dependency, and browser code must never import a Node-only module (constraints.md) even
 * transitively. This file and its own test below have no such dependency.
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
 * `d`'s UTC fields hold a wall-clock time meant for `timeZone`. Returns the real instant that
 * wall-clock time represents in `timeZone`.
 *
 *  - an ordinary wall-clock time has exactly one matching instant — returned directly.
 *  - the repeated "fall back" hour (e.g. 1:00-1:59 happening twice) has two matching instants —
 *    the earlier (pre-fall-back, DST) one is picked.
 *  - the skipped "spring forward" hour (e.g. 2:00-2:59 never happening) has no matching instant —
 *    the wall-clock time is shifted forward by the size of the gap (into the DST side) first.
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

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

/**
 * Combines a BC-local `YYYY-MM-DD` date and `HH:MM` time (as typed into the schedule picker)
 * into the real UTC instant they represent in `timeZone`, DST-correctly — what
 * `scheduleSchema`'s `publishAt` and `settingsSchema`'s `plannedPublishAt` both expect
 * (an ISO 8601 string with an explicit offset).
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
  const parts = formatterFor(timeZone).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}
