import { wallClock } from "../time";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const parts = (date: string) => date.split("-").map(Number) as [number, number, number];

/** 0 is Sunday, for a BC date (YYYY-MM-DD). */
export function weekdayOf(date: string): number {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** .NET's "dddd, MMMM d, yyyy": "Tuesday, November 3, 2026" (a day's heading; "No Activities for …"). */
export function longDay(date: string): string {
  const [y, m, d] = parts(date);
  return `${DAYS[weekdayOf(date)]}, ${MONTHS[m - 1]} ${d}, ${y}`;
}

/** .NET's "ddd MMM d": "Tue Nov 3" (a day table's first header cell). */
export function shortDay(date: string): string {
  const [, m, d] = parts(date);
  return `${DAYS[weekdayOf(date)]!.slice(0, 3)} ${MONTHS[m - 1]!.slice(0, 3)} ${d}`;
}

/** .NET's "dddd, MMM. d[, yyyy]" (the Look Ahead's title, ActivityHandler.ashx.cs:668-673). */
export function titleDay(date: string, withYear: boolean): string {
  const [y, m, d] = parts(date);
  return `${DAYS[weekdayOf(date)]}, ${MONTHS[m - 1]!.slice(0, 3)}. ${d}${withYear ? `, ${y}` : ""}`;
}

/** "November 2026" (a 30/60/90 month's heading). */
export function monthHeading(date: string): string {
  const [y, m] = parts(date);
  return `${MONTHS[m - 1]} ${y}`;
}

export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** .NET's AddMonths: the same day of the month, or the month's last day when it has fewer. */
export function addMonths(date: string, n: number): string {
  const [y, m, d] = parts(date);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}

const twelve = (hh: number) => (hh % 12 === 0 ? 12 : hh % 12);

/** "h:mm tt": "1:15 PM". */
export function clockTime(at: Date, timeZone: string): string {
  const [hh, mm] = wallClock(at, timeZone).time.split(":").map(Number) as [number, number];
  return `${twelve(hh)}:${String(mm).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}`;
}

/** The Look Ahead's and 30/60/90's "Updated dddd, MMM d, yyyy h:mm tt". */
export function updatedLong(now: Date, timeZone: string): string {
  const { date } = wallClock(now, timeZone);
  const [y, m, d] = parts(date);
  return `Updated ${DAYS[weekdayOf(date)]}, ${MONTHS[m - 1]!.slice(0, 3)} ${d}, ${y} ${clockTime(now, timeZone)}`;
}

/** Planning's "Updated M/d/yyyy h:mm:ss tt". */
export function updatedNumeric(now: Date, timeZone: string): string {
  const w = wallClock(now, timeZone);
  const [y, m, d] = parts(w.date);
  const hh = Math.floor(w.secondsOfDay / 3600);
  const mm = Math.floor((w.secondsOfDay % 3600) / 60);
  const ss = w.secondsOfDay % 60;
  return `Updated ${m}/${d}/${y} ${twelve(hh)}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}`;
}
