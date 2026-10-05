/**
 * Shared IANA time-zone math (3f Task 3 fix round 1, finding 3 / minor 4): the server-side
 * canonical home for both of the following, which used to live only in
 * packages/legacy-import/src/timezone.ts — a package that also depends on `mssql`, so any
 * always-running server process (not just the one-off legacy importer) that imported it would
 * pull the SQL Server driver into its module graph just to get a date utility. `@gcpe/config`
 * has no such baggage (zod only) and apps/nrms already depends on it, so this is where
 * `apps/nrms/src/releases/workflow.ts`'s `schedule()` now imports {@link wallClockToInstant}
 * from. packages/legacy-import/src/timezone.ts now re-exports this same implementation, so
 * there is exactly one copy of the DST-aware conversion logic for server code.
 *
 * (apps/staff-web is browser code and can never import this file — it keeps its own
 * independently-ported, browser-safe copy at apps/staff-web/src/screens/release/timezone.ts,
 * used only for an optional client-side preview; the actual schedule request now sends the BC
 * wall-clock string as-is and lets the server — whose tzdata is the one that matters — convert it.)
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

/**
 * `timeZone`'s UTC offset at the instant `at` (an ISO 8601 UTC datetime), in minutes — negative
 * west of UTC (e.g. -420 for PDT/UTC-7), computed from the runtime's own `Intl`/tzdata, the same
 * source `assertTimeZoneRules` checks server-side at startup. `GET /nrms/api/config`'s `tzCheck`
 * uses this to give the browser a (instant, expected offset) pair to compare its own tzdata
 * against (fix round 1, finding 3).
 */
export function utcOffsetMinutes(at: string, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(new Date(at));
  const raw = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  if (raw === "GMT") return 0;
  const m = /^GMT([+-])(\d{2}):(\d{2})$/.exec(raw);
  if (!m) throw new Error(`Unexpected Intl offset format for ${timeZone} at ${at}: ${raw}`);
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}
