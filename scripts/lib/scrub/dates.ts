export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;

export function wallClockOf(instant: Date, timeZone: string): Date {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(instant).map((p) => [p.type, p.value]));
  return new Date(Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!, instant.getUTCMilliseconds()));
}

export function weekOffset(latestEndWall: Date, runWall: Date, leadDays = 14): number {
  return Math.max(0, Math.round((runWall.getTime() + leadDays * DAY_MS - latestEndWall.getTime()) / WEEK_MS));
}

/** Wall-clock values carry no zone, so whole weeks keep weekday and time of day exactly. */
export function shiftWall(d: Date, weeks: number): Date {
  return new Date(d.getTime() + weeks * WEEK_MS);
}

const US = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) ([AP]M)$/i;
const ISO = /^(\d{4})-(\d{2})-(\d{2})([ T])(\d{2}):(\d{2})(?::(\d{2}))?(\.\d{1,7})?$/;
const p2 = (n: number) => String(n).padStart(2, "0");

/** A legacy log's date text, moved by whole weeks in the same format; null when it isn't one of legacy's formats. */
export function shiftDateText(raw: string, weeks: number): string | null {
  const s = raw.trim();
  let m = US.exec(s);
  if (m) {
    const h = (+m[4]! % 12) + (m[7]!.toUpperCase() === "PM" ? 12 : 0);
    const d = shiftWall(new Date(Date.UTC(+m[3]!, +m[1]! - 1, +m[2]!, h, +m[5]!, +m[6]!)), weeks);
    const h12 = d.getUTCHours() % 12 === 0 ? 12 : d.getUTCHours() % 12;
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()} ${h12}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${d.getUTCHours() < 12 ? "AM" : "PM"}`;
  }
  m = ISO.exec(s);
  if (m) {
    const d = shiftWall(new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[5]!, +m[6]!, m[7] ? +m[7] : 0)), weeks);
    return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}${m[4]}${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}${m[7] !== undefined ? `:${p2(d.getUTCSeconds())}` : ""}${m[8] ?? ""}`;
  }
  return null;
}

export function bcToday(now = new Date()): string {
  return wallClockOf(now, "America/Vancouver").toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Caps a stamp the shift pushed past the run's reference time; returns the same instant untouched otherwise. Which columns this applies to is a later step's call. */
export function clampToReference(d: Date, reference: Date): Date {
  return d.getTime() > reference.getTime() ? reference : d;
}
