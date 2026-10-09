import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq, inArray } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { EMPTY_LIST_FILTER } from "@gcpe/calendar-contract";
import { createCalendarTestDb, createTestApp } from "../../test/helpers";
import { HEALTH_GUID, LEGACY_OWNER_A, LEGACY_RESOLVER, LEGACY_SAVED_FILTERS, OWNER_A, OWNER_B } from "../../test/fixtures/legacy-saved-filters";
import { seedWorld } from "../../test/world";
import { savedFilters } from "../db/schema";
import { convertLegacyQuery, legacyDisplay, legacyHiddenColumns, migrateLegacySavedFilters, type LegacyFilterResolver } from "./legacy-filters";
import { SAVED_FILTER_LIMIT } from "./saved-filters";

const NOT_APPLIED = "legacy never applied it to a saved query";

describe("converting a legacy saved query (spec addendum §12.1 step 5)", () => {
  it("maps every parameter legacy's SetFilter applied", () => {
    const out = convertLegacyQuery(LEGACY_SAVED_FILTERS[0]!.queryString!, LEGACY_RESOLVER);
    expect(out.filter).toEqual({
      ...EMPTY_LIST_FILTER, status: "changed", categoryId: 12, ministryKey: "health", from: "2026-10-01", to: "2026-10-31",
      keywordIds: [1, 2], isIssue: true, dateConfirmed: false, quickSearch: "sample launch",
    });
    expect(out.dropped).toEqual([
      { key: "display", value: "2", reason: NOT_APPLIED },
      { key: "thisdayonly", value: "false", reason: NOT_APPLIED },
      { key: "lookahead", value: "true", reason: NOT_APPLIED },
    ]);
  });

  it("reads a stale ActivityListProvider.aspx? query string", () => {
    expect(convertLegacyQuery(LEGACY_SAVED_FILTERS[1]!.queryString!, LEGACY_RESOLVER).filter).toEqual({
      ...EMPTY_LIST_FILTER, commContactUserId: OWNER_A, representativeId: 1, premierRequestedId: 2, distributionId: 1, initiativeId: 1,
    });
  });

  it("drops what it can't read, with a reason, and keeps the rest", () => {
    const out = convertLegacyQuery(LEGACY_SAVED_FILTERS[4]!.queryString!, LEGACY_RESOLVER);
    expect(out.filter).toEqual({ ...EMPTY_LIST_FILTER, keywordIds: [1] });
    expect(out.dropped).toEqual([
      { key: "status", value: "5", reason: "unknown status" },
      { key: "category", value: "-2", reason: "an exclusion, which a saved query can't hold" },
      { key: "ministry", value: "FFFFFFFF-0000-4000-8000-00000000000F", reason: "no Core ministry for this id" },
      { key: "datefrom", value: "13/45/2026", reason: "not a date" },
      { key: "keywords", value: "1~x", reason: "a keyword id that isn't a number" },
      { key: "colour", value: "blue", reason: "unknown parameter" },
    ]);
  });

  it("keeps everything after the first = in a value, and drops a To before the From", () => {
    expect(convertLegacyQuery("quickSearch=a=b", LEGACY_RESOLVER).filter!.quickSearch).toBe("a=b");
    const out = convertLegacyQuery("datefrom=12/01/2026|dateto=11/01/2026", LEGACY_RESOLVER);
    expect(out.filter).toMatchObject({ from: "2026-12-01", to: null });
    expect(out.dropped).toEqual([{ key: "dateto", value: "2026-11-01", reason: "before the From date" }]);
    expect(convertLegacyQuery(`ministry=${HEALTH_GUID.toLowerCase()}`, LEGACY_RESOLVER).dropped).toHaveLength(1);
  });

  it("converts legacy's hidden columns and display", () => {
    expect(legacyHiddenColumns(null)).toEqual(["keywords", "ministry", "status", "translations"]);
    expect(legacyHiddenColumns("0,11,10,99,x")).toEqual(["city", "translations"]);
    expect(legacyHiddenColumns("")).toEqual([]);
    expect([3, 2, 4, 10, 7, null].map(legacyDisplay)).toEqual(["all", "my_ministries", "my_activities", "my_watchlist", "all", "all"]);
  });

  it("drops a ministry key the resolver returned that is too long, instead of crashing", () => {
    const badResolver: LegacyFilterResolver = { ...LEGACY_RESOLVER, ministryKeyOf: () => "x".repeat(201) };
    const out = convertLegacyQuery(`ministry=${HEALTH_GUID}|status=2`, badResolver);
    expect(out.filter).toEqual({ ...EMPTY_LIST_FILTER, status: "reviewed" });
    expect(out.dropped).toEqual([{ key: "ministry", value: HEALTH_GUID, reason: "not a valid Core ministry key" }]);
  });

  it("drops a ministry key the resolver returned that contains NUL, instead of crashing", () => {
    const badResolver: LegacyFilterResolver = { ...LEGACY_RESOLVER, ministryKeyOf: () => "bad\u0000key" };
    const out = convertLegacyQuery(`ministry=${HEALTH_GUID}|status=2`, badResolver);
    expect(out.filter).toEqual({ ...EMPTY_LIST_FILTER, status: "reviewed" });
    expect(out.dropped).toEqual([{ key: "ministry", value: HEALTH_GUID, reason: "not a valid Core ministry key" }]);
  });

  it("drops a contact id the resolver resolved to something other than a UUID, instead of crashing", () => {
    const badResolver: LegacyFilterResolver = { ...LEGACY_RESOLVER, userIdOf: () => "not-a-uuid" };
    const out = convertLegacyQuery("contact=7001|status=2", badResolver);
    expect(out.filter).toEqual({ ...EMPTY_LIST_FILTER, status: "reviewed" });
    expect(out.dropped).toEqual([{ key: "contact", value: "7001", reason: "not a valid Core user id" }]);
  });

  it('reports a bare token with no "=", separately from a deliberate empty value', () => {
    const out = convertLegacyQuery("status=2|categ|representative=*|initiative=", LEGACY_RESOLVER);
    expect(out.filter).toEqual({ ...EMPTY_LIST_FILTER, status: "reviewed" });
    expect(out.dropped).toEqual([{ key: "categ", value: "", reason: "not a key=value pair" }]);
  });
});

describe("migrating the legacy saved-filter fixture", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    await seedWorld(createTestApp(tdb.db), tdb.db);
  });
  afterAll(() => tdb.drop());

  it("migrates the active ones with their owners and legacy ids, reports every skip and drop, and a re-run changes nothing", async () => {
    const report = await migrateLegacySavedFilters(tdb.db, LEGACY_SAVED_FILTERS, LEGACY_RESOLVER);
    expect(report).toEqual({
      read: 8, migrated: 6, skippedInactive: 1, skippedNoOwner: [{ id: 504, legacyOwner: 9999 }], strippedPrefix: 1,
      dropped: [
        { id: 501, key: "display", value: "2", reason: NOT_APPLIED },
        { id: 501, key: "thisdayonly", value: "false", reason: NOT_APPLIED },
        { id: 501, key: "lookahead", value: "true", reason: NOT_APPLIED },
        { id: 505, key: "status", value: "5", reason: "unknown status" },
        { id: 505, key: "category", value: "-2", reason: "an exclusion, which a saved query can't hold" },
        { id: 505, key: "ministry", value: "FFFFFFFF-0000-4000-8000-00000000000F", reason: "no Core ministry for this id" },
        { id: 505, key: "datefrom", value: "13/45/2026", reason: "not a date" },
        { id: 505, key: "keywords", value: "1~x", reason: "a keyword id that isn't a number" },
        { id: 505, key: "colour", value: "blue", reason: "unknown parameter" },
        { id: 507, key: "dateto", value: "2026-11-01", reason: "before the From date" },
        { id: 507, key: "category", value: "999", reason: "no such category in the Calendar" },
      ],
    });
    const rows = await tdb.db.select().from(savedFilters).orderBy(asc(savedFilters.id));
    expect(rows.map((r) => [r.id, r.ownerId, r.name, r.sortOrder, r.isActive])).toEqual([
      [501, OWNER_A, "Sample health this month", 1, true],
      [502, OWNER_B, "Sample stale", 1, true],
      [505, OWNER_B, "Sample odd one", 2, true],
      [506, OWNER_A, "My Query", 0, true],
      [507, OWNER_B, "Sample backwards", 3, true],
      [508, OWNER_A, "Sample equals", 3, true],
    ]);
    expect(rows.find((r) => r.id === 507)!.filter).toEqual({ ...EMPTY_LIST_FILTER, from: "2026-12-01" });
    expect(await migrateLegacySavedFilters(tdb.db, LEGACY_SAVED_FILTERS, LEGACY_RESOLVER)).toEqual(report);
    expect(await tdb.db.select().from(savedFilters)).toHaveLength(6);
  });
});

describe("migrating past the per-owner saved-query cap (C175)", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    await seedWorld(createTestApp(tdb.db), tdb.db);
    // Already at the cap, as if the create route (saved-filters.ts) had been used SAVED_FILTER_LIMIT times.
    await tdb.db.insert(savedFilters).values(
      Array.from({ length: SAVED_FILTER_LIMIT }, (_, i) => ({
        id: 20_000 + i, ownerId: OWNER_A, name: `Sample existing ${i}`, filter: EMPTY_LIST_FILTER, sortOrder: i, isActive: true,
      })),
    );
  });
  afterAll(() => tdb.drop());

  it("migrates every row and reports the owner over the cap instead of failing", async () => {
    const rows = [
      { id: 601, createdBy: LEGACY_OWNER_A, name: "Sample over the cap one", sortOrder: 1, isActive: true, queryString: "status=2" },
      { id: 602, createdBy: LEGACY_OWNER_A, name: "Sample over the cap two", sortOrder: 2, isActive: true, queryString: "status=1" },
    ];
    const report = await migrateLegacySavedFilters(tdb.db, rows, LEGACY_RESOLVER);
    expect(report.migrated).toBe(2);
    expect(report.overCap).toEqual([{ ownerId: OWNER_A, count: SAVED_FILTER_LIMIT + 2 }]);
    expect(await tdb.db.select({ id: savedFilters.id }).from(savedFilters).where(eq(savedFilters.id, 601))).toHaveLength(1);
  });
});

describe("migrating a batch when the resolver returns something invalid", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    await seedWorld(createTestApp(tdb.db), tdb.db);
  });
  afterAll(() => tdb.drop());

  const FLAKY_RESOLVER: LegacyFilterResolver = {
    ministryKeyOf: (guid) => (guid === "TOO-LONG" ? "x".repeat(201) : guid === "HAS-NUL" ? "bad\u0000key" : null),
    userIdOf: (legacyId) =>
      legacyId === LEGACY_OWNER_A ? OWNER_A : legacyId === 9001 ? "also-not-a-uuid" : legacyId === 9002 ? "still-not-a-uuid" : null,
  };

  it("drops the bad value or skips the row, and still migrates the rest of the batch", async () => {
    const rows = [
      { id: 701, createdBy: LEGACY_OWNER_A, name: "Sample too-long ministry", sortOrder: 1, isActive: true, queryString: "ministry=TOO-LONG|status=2" },
      { id: 702, createdBy: LEGACY_OWNER_A, name: "Sample NUL ministry", sortOrder: 2, isActive: true, queryString: "ministry=HAS-NUL|status=1" },
      { id: 703, createdBy: LEGACY_OWNER_A, name: "Sample bad contact", sortOrder: 3, isActive: true, queryString: "contact=9002|status=2" },
      { id: 704, createdBy: 9001, name: "Sample bad owner", sortOrder: 1, isActive: true, queryString: "status=1" },
      { id: 705, createdBy: LEGACY_OWNER_A, name: "Sample clean row", sortOrder: 4, isActive: true, queryString: "status=1" },
    ];
    const report = await migrateLegacySavedFilters(tdb.db, rows, FLAKY_RESOLVER);
    expect(report.migrated).toBe(4);
    expect(report.skippedNoOwner).toEqual([{ id: 704, legacyOwner: 9001 }]);
    expect(report.dropped).toEqual([
      { id: 701, key: "ministry", value: "TOO-LONG", reason: "not a valid Core ministry key" },
      { id: 702, key: "ministry", value: "HAS-NUL", reason: "not a valid Core ministry key" },
      { id: 703, key: "contact", value: "9002", reason: "not a valid Core user id" },
    ]);
    const rowsOut = await tdb.db.select({ id: savedFilters.id }).from(savedFilters).where(inArray(savedFilters.id, [701, 702, 703, 704, 705]));
    expect(rowsOut.map((r) => r.id).sort((a, b) => a - b)).toEqual([701, 702, 703, 705]);
  });
});
