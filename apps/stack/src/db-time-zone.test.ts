// The Calendar database's time-zone self-check: Postgres's own tzdata buckets the list's, the
// export's and the reports' days (`AT TIME ZONE`), separately from Node's.
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";
import { checkCalendarDbTimeZone, pgOffsetOf, STALE_DB_TIME_ZONE_MESSAGE } from "./db-time-zone";

const BC = { tenantId: "bc", timeZone: "America/Vancouver", timeZoneCheck: { at: "2027-01-15T19:00:00Z", expectedOffset: "-07:00" } };

describe("checkCalendarDbTimeZone", () => {
  afterEach(() => vi.restoreAllMocks());

  it("stale tzdata (BC still at UTC−8 after 2026-11-01) logs the warning and reports stale, without throwing", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const query = vi.fn(async () => "-08:00");
    await expect(checkCalendarDbTimeZone(BC, query)).resolves.toBe("stale");
    expect(query).toHaveBeenCalledWith("America/Vancouver", "2027-01-15T19:00:00Z");
    expect(errors).toHaveBeenCalledTimes(1);
    const logged = errors.mock.calls[0]!.map(String).join(" ");
    expect(logged).toContain(STALE_DB_TIME_ZONE_MESSAGE);
    expect(logged).toContain("-08:00");
  });

  it("current tzdata reports ok and logs nothing", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(checkCalendarDbTimeZone(BC, async () => "-07:00")).resolves.toBe("ok");
    expect(errors).not.toHaveBeenCalled();
  });

  it("a failing query logs only its safe label and reports unreachable, without throwing", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = Object.assign(new Error("connect ECONNREFUSED postgres://user:secret@db.example.invalid/calendar"), { code: "ECONNREFUSED" });
    await expect(checkCalendarDbTimeZone(BC, async () => Promise.reject(failure))).resolves.toBe("unreachable");
    expect(errors).toHaveBeenCalledTimes(1);
    const logged = errors.mock.calls[0]!.map(String).join(" ");
    expect(logged).toContain("ECONNREFUSED");
    expect(logged).not.toContain("secret");
    expect(logged).not.toContain("db.example.invalid");
  });

  it("a tenant without a time-zone check is not checked", async () => {
    const query = vi.fn(async () => "-08:00");
    await expect(checkCalendarDbTimeZone({ tenantId: "x", timeZone: "America/Vancouver" }, query)).resolves.toBe("unchecked");
    expect(query).not.toHaveBeenCalled();
  });
});

describe("pgOffsetOf, against a real Postgres", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase({ migrationsFolder: fileURLToPath(new URL("../../core/migrations", import.meta.url)), namePrefix: "test_tzcheck_" });
  });
  afterAll(() => tdb.drop());

  it("reads the database's own UTC offset for a zone at an instant, as ±HH:MM", async () => {
    // Instants before 2026-11-01, so every tzdata version agrees.
    const offset = pgOffsetOf(tdb.url);
    expect(await offset("America/Vancouver", "2025-01-15T19:00:00Z")).toBe("-08:00");
    expect(await offset("America/Vancouver", "2025-07-15T19:00:00Z")).toBe("-07:00");
    expect(await offset("Asia/Kolkata", "2025-01-15T19:00:00Z")).toBe("+05:30");
    expect(await offset("UTC", "2025-01-15T19:00:00Z")).toBe("+00:00");
  });
});
