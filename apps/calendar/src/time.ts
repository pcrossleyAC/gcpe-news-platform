import { sql } from "drizzle-orm";
import { wallClockToInstant } from "@gcpe/config";
import type { DbOrTx, TestClock } from "@gcpe/db-kit";

export interface WallClock {
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM, 24-hour */
  time: string;
  secondsOfDay: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    formatters.set(timeZone, f);
  }
  return f;
}

/** What a clock in `timeZone` shows at `at`, by this runtime's tzdata (Node 24: BC is UTC−7 all
 * year from 2026-11-01). */
export function wallClock(at: Date, timeZone: string): WallClock {
  const parts = formatter(timeZone).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const [h, m, s] = [Number(get("hour")), Number(get("minute")), Number(get("second"))];
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}`, secondsOfDay: h * 3600 + m * 60 + s };
}

/** The instant a BC date and time name. */
export function instantOf(date: string, time: string, timeZone: string): Date {
  return wallClockToInstant(new Date(`${date}T${time}:00Z`), timeZone);
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function bcMidnight(date: string, timeZone: string): Date {
  return instantOf(date, "00:00", timeZone);
}

/** The database's clock, the platform's one clock (packages/db-kit/src/claim.ts), or a test's. */
export async function dbNow(db: DbOrTx, clock?: TestClock): Promise<Date> {
  if (clock) return clock();
  const r = await db.execute<{ ms: number }>(sql`SELECT (extract(epoch FROM now()) * 1000)::float8 AS ms`);
  return new Date(Number(r.rows[0]!.ms));
}
