interface Wall {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  /** 0 is Sunday. */
  dow: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function wall(at: Date, timeZone: string): Wall {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formatters.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  const [y, m, d] = [Number(p.year), Number(p.month), Number(p.day)];
  return { y, m, d, hh: Number(p.hour), mm: Number(p.minute), dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const sameDay = (a: Wall, b: { y: number; m: number; d: number }) => a.y === b.y && a.m === b.m && a.d === b.d;
const dateText = (w: Wall, year: boolean, weekday: boolean) => `${weekday ? `${DAYS[w.dow]} ` : ""}${MONTHS[w.m - 1]} ${w.d}${year ? ` ${w.y}` : ""}`;
const timeText = (w: Wall, ampm: boolean) => `${w.hh % 12 === 0 ? 12 : w.hh % 12}:${String(w.mm).padStart(2, "0")}${ampm ? (w.hh < 12 ? " AM" : " PM") : ""}`;

export interface DatedActivity {
  startAt: string | Date | null;
  endAt: string | Date | null;
  isAllDay: boolean;
  isConfirmed: boolean;
  potentialDates?: string | null;
}

export interface FriendlyDateOptions {
  timeZone: string;
  /** Today's BC date (YYYY-MM-DD): it decides when a year shows. */
  today: string;
  /** The weekday on a single day's date; on by default. */
  weekday?: boolean;
  /**
   * The Look Ahead's day (YYYY-MM-DD), which stands in for today: a timed activity on that day
   * shows its time without the date (ActivityListProvider.ashx.cs:784-823, `referenceDay`).
   */
  referenceDay?: string;
  /** The end time after the start time; on by default. The Look Ahead shows the start time only. */
  endTime?: boolean;
}

/** A friendly date's text, and legacy's "TBC" or "Time TBD" marker, which the reports colour. */
export interface FriendlyDateParts {
  text: string;
  pending: "TBC" | "Time TBD" | null;
}

/**
 * Legacy's FriendlyDateTimeRange (ActivityListProvider.ashx.cs:769-840), in the tenant's time
 * zone, with plain spaces, as text and marker.
 */
export function friendlyDateParts(a: DatedActivity, o: FriendlyDateOptions): FriendlyDateParts {
  if (!a.startAt || !a.endAt) return { text: a.potentialDates || "—", pending: null };
  const s = wall(new Date(a.startAt), o.timeZone);
  const e = wall(new Date(a.endAt), o.timeZone);
  const [ry, rm, rd] = (o.referenceDay ?? o.today).split("-").map(Number) as [number, number, number];
  const ref = { y: ry, m: rm, d: rd };
  // An unconfirmed 8 AM to 6 PM day is legacy's "time to be decided" placeholder (IsTimeTBD).
  const timeTbd = sameDay(s, e) && !a.isConfirmed && s.hh === 8 && s.mm === 0 && e.hh === 18 && e.mm === 0;
  let value = "";
  if (sameDay(s, e)) {
    const isRef = sameDay(s, ref);
    value = isRef && o.referenceDay !== undefined && !a.isAllDay ? "" : dateText(s, !isRef && s.y !== ref.y, isRef || (o.weekday ?? true));
    if (!a.isAllDay && !timeTbd) {
      value += (o.endTime ?? true) ? ` ${timeText(s, s.hh >= 12 !== e.hh >= 12)}-${timeText(e, true)}` : ` ${timeText(s, true)}`;
    }
    value = value.trim();
  } else {
    const year = s.y !== e.y || s.y !== ref.y;
    value = `${dateText(s, year, false)}-${year || s.m !== e.m ? dateText(e, year, false) : String(e.d)}`;
  }
  if (a.isConfirmed) return { text: value, pending: null };
  return { text: a.potentialDates || value, pending: timeTbd ? "Time TBD" : "TBC" };
}

/** {@link friendlyDateParts} as one string: the list, the export and the updates feed. */
export function friendlyDateRange(a: DatedActivity, o: FriendlyDateOptions): string {
  const p = friendlyDateParts(a, o);
  return p.pending ? `${p.text} ${p.pending}`.trim() : p.text;
}

const count = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** Legacy's FriendlyTimeSpan ("updated 3 Days ago by …"; ActivityListProvider.ashx.cs:850-876). */
export function friendlySpan(at: Date, now: Date, timeZone: string): string {
  const ms = Math.max(0, now.getTime() - at.getTime());
  const days = Math.floor(ms / 86_400_000);
  if (days >= 30) return count(Math.floor(days / 30), "Month");
  if (days >= 7) return count(Math.floor(days / 7), "Week");
  const a = wall(at, timeZone);
  const b = wall(now, timeZone);
  if (sameDay(a, b)) {
    const hours = Math.floor(ms / 3_600_000);
    return hours > 0 ? count(hours, "Hour") : count(Math.floor(ms / 60_000), "Minute");
  }
  return count(Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000), "Day");
}
