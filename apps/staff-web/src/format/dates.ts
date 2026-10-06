/**
 * BC-time date wording (constraints.md): dates are stored UTC and shown in the tenant time
 * zone with legacy wording — `Yesterday` / `Today` / `Tomorrow`, else the weekday name within
 * ±6 days, else `MMM d, yyyy`; times as `h:mm a` (e.g. `Today 2:30 PM`).
 *
 * DST safety: every comparison below is done on the *calendar* day — the Y-M-D that
 * `timeZone`'s wall clock shows for an instant — never on a raw millisecond difference.
 * Subtracting two epoch values and dividing by 86,400,000 breaks right around a DST
 * transition: a spring-forward day is only 23 real hours and a fall-back day is 25, so the
 * same two calendar days can be anywhere from 23 to 25 real hours apart depending on what
 * falls between them. Converting each instant to its zone's Y-M-D first, then doing the day
 * arithmetic with `Date.UTC` on bare Y-M-D components (a space with no DST of its own),
 * sidesteps the problem entirely — it is correct whether `timeZone` is currently observing DST
 * or (America/Vancouver from 2026-11-01) has switched to a permanent fixed offset.
 */

interface CalendarDate {
  year: number;
  month: number; // 1-12
  day: number;
}

function calendarDateOf(date: Date, timeZone: string): CalendarDate {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

/** A day index with no DST of its own — safe to subtract across any real-world transition. */
function dayNumber(date: Date, timeZone: string): number {
  const { year, month, day } = calendarDateOf(date, timeZone);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

const WEEKDAY_WINDOW_DAYS = 6;

/** The day label alone (no time): `Yesterday` / `Today` / `Tomorrow`, else the weekday name
 * within ±{@link WEEKDAY_WINDOW_DAYS} BC calendar days of `now`, else `MMM d, yyyy`. */
export function relativeDay(iso: string, now: Date, timeZone: string): string {
  const target = new Date(iso);
  const diffDays = dayNumber(target, timeZone) - dayNumber(now, timeZone);

  if (diffDays === 0) return "Today";
  if (diffDays === -1) return "Yesterday";
  if (diffDays === 1) return "Tomorrow";
  if (Math.abs(diffDays) <= WEEKDAY_WINDOW_DAYS) {
    return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(target);
  }
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(target);
}

/** {@link relativeDay}'s wording plus a `h:mm a` time, e.g. `Today 2:30 PM`. */
export function formatWhen(iso: string, now: Date, timeZone: string): string {
  const target = new Date(iso);
  const day = relativeDay(iso, now, timeZone);
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).format(target);
  return `${day} ${time}`;
}
