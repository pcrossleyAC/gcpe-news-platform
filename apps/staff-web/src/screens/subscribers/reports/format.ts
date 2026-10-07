/** Report dates and times as the CSVs show them: "YYYY-MM-DD" and "YYYY-MM-DD HH:mm", BC time. */
const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(iso: string, timeZone: string): Record<string, string> {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formatters.set(timeZone, f);
  }
  return Object.fromEntries(f.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
}
export function bcDate(iso: string, timeZone: string): string {
  const p = parts(iso, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}
export function bcDateTime(iso: string, timeZone: string): string {
  const p = parts(iso, timeZone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
