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

/**
 * Legacy's FriendlyDateTimeRange (ActivityListProvider.ashx.cs:769-840), in the tenant's time
 * zone, with plain spaces. `today` is the BC date (YYYY-MM-DD) that decides when a year shows.
 */
export function friendlyDateRange(a: DatedActivity, o: { timeZone: string; today: string; weekday?: boolean }): string {
  if (!a.startAt || !a.endAt) return a.potentialDates || "—";
  const s = wall(new Date(a.startAt), o.timeZone);
  const e = wall(new Date(a.endAt), o.timeZone);
  const [ty, tm, td] = o.today.split("-").map(Number) as [number, number, number];
  const today = { y: ty, m: tm, d: td };
  // An unconfirmed 8 AM to 6 PM day is legacy's "time to be decided" placeholder (IsTimeTBD).
  const timeTbd = sameDay(s, e) && !a.isConfirmed && s.hh === 8 && s.mm === 0 && e.hh === 18 && e.mm === 0;
  let value = "";
  if (sameDay(s, e)) {
    const isToday = sameDay(s, today);
    value = dateText(s, !isToday && s.y !== today.y, isToday || (o.weekday ?? true));
    if (!a.isAllDay && !timeTbd) value += ` ${timeText(s, s.hh >= 12 !== e.hh >= 12)}-${timeText(e, true)}`;
  } else {
    const year = s.y !== e.y || s.y !== today.y;
    value = `${dateText(s, year, false)}-${year || s.m !== e.m ? dateText(e, year, false) : String(e.d)}`;
  }
  if (a.isConfirmed) return value;
  return `${a.potentialDates || value} ${timeTbd ? "Time TBD" : "TBC"}`;
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
