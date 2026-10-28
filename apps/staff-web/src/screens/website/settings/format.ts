/** A publish time as the history and publish bar show it, in the tenant time zone: "Oct 27, 2026, 11:00 AM". */
export function formatPublishedAt(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}
