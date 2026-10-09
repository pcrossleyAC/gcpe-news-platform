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
