const formatters = new Map<string, Intl.DateTimeFormat>();
/** The BC calendar date (YYYY-MM-DD) of an instant, by the browser's tzdata. */
export function bcDateOf(at: string | Date, timeZone: string): string {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
export const todayIn = (timeZone: string, now: Date = new Date()) => bcDateOf(now, timeZone);
/** Calendar arithmetic on a bare date: no time zone, no DST. */
export function addDaysTo(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** 0 is Sunday. */
export const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** A real calendar date, not just three number-shaped groups: the shape regex alone lets
 * through `2026-13-99` (an invalid month/day, `Date` silently gives `Invalid Date`) and
 * `2026-02-30` (a valid-looking but non-existent day, `Date` silently rolls it over to March 2).
 * Round-tripping through `Date` and comparing catches both; the year bound keeps a wildly
 * out-of-range but otherwise well-formed value (`9999-99-99` fails this too, `0001-01-01` would
 * pass the round trip but not the bound) from reaching calendar arithmetic that assumes a
 * plausible year. */
export function isValidBcDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  if (year < 1900 || year > 2199) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const lastOfMonth = (first: string) => addDaysTo(shiftMonth(first, 1), -1);

/** The first of the month `delta` months from `anchor`'s. */
export function shiftMonth(anchor: string, delta: number): string {
  const d = new Date(`${anchor.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + delta);
  return d.toISOString().slice(0, 10);
}

/** Whole Sunday-first weeks covering `anchor`'s month: at most 42 days. */
export function monthRange(anchor: string): { start: string; end: string } {
  const first = shiftMonth(anchor, 0);
  const last = lastOfMonth(first);
  return { start: addDaysTo(first, -weekdayOf(first)), end: addDaysTo(last, 6 - weekdayOf(last)) };
}

export function weekRange(anchor: string): { start: string; end: string } {
  const start = addDaysTo(anchor, -weekdayOf(anchor));
  return { start, end: addDaysTo(start, 6) };
}

/** "9:00 AM" in the tenant's zone, with a plain space: formatToParts keeps ICU's narrow no-break space out. */
export function timeText(iso: string, timeZone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]),
  );
  return `${p.hour}:${p.minute} ${p.dayPeriod}`;
}
