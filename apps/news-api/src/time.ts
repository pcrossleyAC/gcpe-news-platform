export function formatOffsetDateTime(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const zone = parts.timeZoneName ?? "GMT";
  const offset = zone === "GMT" ? "+00:00" : zone.replace("GMT", "");
  const ms = date.getUTCMilliseconds();
  const fraction = ms === 0 ? "" : `.${String(ms).padStart(3, "0")}`;
  const year = parts.year!.padStart(4, "0");
  return `${year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${fraction}${offset}`;
}

// A time (HH:MM, optional :SS and fraction) immediately followed by an offset in any of the
// forms the event catalogue's z.string().datetime({ offset: true }) accepts — Z, ±HH:MM,
// ±HHMM — plus ±HH. Anchoring the offset to a time keeps a date-only "2026-10-01" from
// having its "-01" misread as an offset.
const WITH_OFFSET = /^(.*T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(?:Z|([+-])(\d{2})(?::?(\d{2}))?)$/;

export function parseOffsetDateTime(value: string): Date {
  const truncated = value.replace(/(\.\d{3})\d+/, "$1");
  const m = WITH_OFFSET.exec(truncated);
  if (!m) throw new Error(`Invalid date: ${value}`);
  const [, local, sign, hh, mm] = m;
  // Normalise to ±HH:MM (or Z), the one offset form Date parsing is specified to accept.
  const date = new Date(`${local}${sign ? `${sign}${hh}:${mm ?? "00"}` : "Z"}`);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}
