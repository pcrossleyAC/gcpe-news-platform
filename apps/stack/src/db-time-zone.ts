import type { TenantConfig } from "@gcpe/config";
import { queryOnce } from "@gcpe/db-kit";
import { safeErrorLabel } from "@gcpe/http-kit";

/**
 * "unchecked" when the tenant config sets no `timeZoneCheck`; "unreachable" when the query
 * failed. Only a warning: the stack keeps running and `--check` still passes.
 */
export type DbTimeZoneStatus = "ok" | "stale" | "unreachable" | "unchecked";

export const STALE_DB_TIME_ZONE_MESSAGE =
  "[stack] the Calendar database's time-zone data predates BC's permanent UTC−7 (tzdata 2026b); list, export and report ordering after 2026-11-01 will be off by an hour";

/** The database's UTC offset for `timeZone` at the instant `at`, as "±HH:MM". */
export type OffsetQuery = (timeZone: string, at: string) => Promise<string>;

/** Asks Postgres itself, over one short-lived connection: its tzdata, not Node's. */
export function pgOffsetOf(databaseUrl: string): OffsetQuery {
  return async (timeZone, at) => {
    const [row] = await queryOnce<{ minutes: number }>(
      databaseUrl,
      "SELECT (extract(epoch FROM ($1::timestamptz AT TIME ZONE $2) - ($1::timestamptz AT TIME ZONE 'UTC')) / 60)::int AS minutes",
      [at, timeZone],
    );
    const m = row!.minutes;
    const abs = Math.abs(m);
    return `${m < 0 ? "-" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  };
}

/**
 * Postgres's tzdata decides the day a row falls on in the Calendar's list, export and reports
 * (`AT TIME ZONE`), separately from Node's, which `assertTimeZoneRules` checks. This asks the
 * Calendar's database the tenant's own `timeZoneCheck` question. Never throws: a mismatch or a
 * failed query is logged (the failure by its safe label only) and reported.
 */
export async function checkCalendarDbTimeZone(tenant: Pick<TenantConfig, "tenantId" | "timeZone" | "timeZoneCheck">, offsetOf: OffsetQuery): Promise<DbTimeZoneStatus> {
  if (!tenant.timeZoneCheck) return "unchecked";
  const { at, expectedOffset } = tenant.timeZoneCheck;
  try {
    const actual = await offsetOf(tenant.timeZone, at);
    if (actual === expectedOffset) return "ok";
    console.error(`${STALE_DB_TIME_ZONE_MESSAGE} (${tenant.timeZone} at ${at}: the database says ${actual}, expected ${expectedOffset})`);
    return "stale";
  } catch (e) {
    console.error("[stack] the Calendar database's time-zone check failed", safeErrorLabel(e));
    return "unreachable";
  }
}
