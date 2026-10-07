/**
 * Report date ranges in BC calendar days. Boundaries are computed here, from the runtime's own
 * tzdata (Node 24: 2026b+, which knows BC stays on UTC−7 from 2026-11-01), and handed to SQL as
 * instants. SQL never converts zones itself: Postgres's tzdata can lag (local 14.17 does), and
 * Distribution has no tenant zone at all.
 */
import { sql } from "drizzle-orm";
import { wallClockToInstant } from "@gcpe/config";
import type { DbOrTx } from "@gcpe/db-kit";

/** A calendar quarter; at legacy volume (Q21) that's about 2 M delivery rows per report. */
export const MAX_RANGE_DAYS = 92;
export const DEFAULT_RANGE_DAYS = 30;

export type RangeErrorCode = "invalid-date" | "range-reversed" | "range-too-long";
export class ReportRangeError extends Error {
  constructor(readonly code: RangeErrorCode) {
    super(code);
    this.name = "ReportRangeError";
  }
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(date: string): { y: number; m: number; d: number } {
  const match = ISO_DATE.exec(date);
  if (!match) throw new ReportRangeError("invalid-date");
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) throw new ReportRangeError("invalid-date");
  return { y, m, d };
}

/** `date` plus `n` calendar days; plain date arithmetic, no zone involved. */
export function addDays(date: string, n: number): string {
  const { y, m, d } = parts(date);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const a = parts(from);
  const b = parts(to);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
}

/** Midnight (in `timeZone`) at the start of each of `days` days from `from`, plus the midnight that
 * closes the last one: `days + 1` instants. Day i is [bounds[i], bounds[i + 1]). */
export function dayBounds(from: string, days: number, timeZone: string): Date[] {
  const { y, m, d } = parts(from);
  return Array.from({ length: days + 1 }, (_, i) => wallClockToInstant(new Date(Date.UTC(y, m - 1, d + i)), timeZone));
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function zoned(instant: Date, timeZone: string): Record<string, string> {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formatters.set(timeZone, f);
  }
  return Object.fromEntries(f.formatToParts(instant).map((p) => [p.type, p.value]));
}

/** The tenant-local calendar date of `instant`: "YYYY-MM-DD". */
export function localDate(instant: Date, timeZone: string): string {
  const p = zoned(instant, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** The tenant-local "YYYY-MM-DD HH:mm" of `instant`, as CSVs show times. */
export function localDateTime(instant: Date, timeZone: string): string {
  const p = zoned(instant, timeZone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** Today's BC date by the database clock (raw `execute` returns timestamptz as text). */
export async function bcToday(db: DbOrTx, timeZone: string): Promise<string> {
  const { rows } = await db.execute<{ now: string }>(sql`SELECT now() AS now`);
  return localDate(new Date(rows[0]!.now), timeZone);
}

export interface ReportRange {
  from: string;
  to: string;
  days: number;
  bounds: Date[];
  start: Date;
  end: Date;
}

/** `from`..`to` inclusive (BC dates). Missing `to` is today; missing `from` makes a 30-day range. */
export function resolveRange(input: { from?: string; to?: string }, today: string, timeZone: string): ReportRange {
  const to = input.to ?? today;
  const from = input.from ?? addDays(to, -(DEFAULT_RANGE_DAYS - 1));
  const days = daysBetween(from, to) + 1;
  if (days < 1) throw new ReportRangeError("range-reversed");
  if (days > MAX_RANGE_DAYS) throw new ReportRangeError("range-too-long");
  const bounds = dayBounds(from, days, timeZone);
  return { from, to, days, bounds, start: bounds[0]!, end: bounds[days]! };
}
