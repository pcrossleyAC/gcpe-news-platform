import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCalendarTestDb } from "../test/helpers";
import { createLookupRow, DuplicateLookupNameError, listLookupRows, LOOKUPS, lookupInputSchema, reorderLookup, StaleLookupOrderError, updateLookupRow } from "./lookups";

describe("lookup service", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCalendarTestDb();
  });
  afterAll(() => tdb.drop());
  const keywords = LOOKUPS.keywords;
  const planners = LOOKUPS["event-planners"];

  it("legacy's lock-down: seven lookups are SysAdmin-only, four are Administrator and above (spec addendum §5.3)", () => {
    const by = (role: string) => Object.values(LOOKUPS).filter((d) => d.minRole === role).map((d) => d.name).sort();
    expect(by("Calendar.SysAdmin")).toEqual(["categories", "cities", "comm-materials", "government-representatives", "nr-distributions", "nr-origins", "premier-requested"]);
    expect(by("Calendar.Administrator")).toEqual(["event-planners", "initiatives", "keywords", "videographers"]);
  });

  it("creates rows at the end of the order, trims, and keeps extra fields", async () => {
    const a = await createLookupRow(tdb.db, keywords, lookupInputSchema(keywords).parse({ name: "  Sample keyword  " }));
    const b = await createLookupRow(tdb.db, keywords, lookupInputSchema(keywords).parse({ name: "Second keyword" }));
    expect(a).toMatchObject({ name: "Sample keyword", isActive: true });
    expect(b.sortOrder).toBe(a.sortOrder + 1);
    const p = await createLookupRow(tdb.db, planners, lookupInputSchema(planners).parse({ name: "Sample Planner", extras: { phone: "250-555-0101", jobTitle: "" } }));
    expect(p.extras).toEqual({ phone: "250-555-0101", jobTitle: null });
  });

  it("refuses an active duplicate name in the same lookup, case-insensitively, but allows it once the other is inactive", async () => {
    const first = await createLookupRow(tdb.db, keywords, lookupInputSchema(keywords).parse({ name: "Duplicate me" }));
    await expect(createLookupRow(tdb.db, keywords, lookupInputSchema(keywords).parse({ name: "DUPLICATE ME" }))).rejects.toBeInstanceOf(DuplicateLookupNameError);
    await updateLookupRow(tdb.db, keywords, first.id, lookupInputSchema(keywords).parse({ name: "Duplicate me", isActive: false }));
    await createLookupRow(tdb.db, keywords, lookupInputSchema(keywords).parse({ name: "duplicate me" }));
    // Reactivating the first would now duplicate an active name.
    await expect(updateLookupRow(tdb.db, keywords, first.id, lookupInputSchema(keywords).parse({ name: "Duplicate me", isActive: true }))).rejects.toBeInstanceOf(DuplicateLookupNameError);
  });

  it("two concurrent creates of one name: exactly one wins", async () => {
    const input = lookupInputSchema(keywords).parse({ name: "Race keyword" });
    const results = await Promise.allSettled([createLookupRow(tdb.db, keywords, input), createLookupRow(tdb.db, keywords, input)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(DuplicateLookupNameError);
  });

  it("reorders by the full id list", async () => {
    const rows = await listLookupRows(tdb.db, keywords);
    const reversed = rows.map((r) => r.id).reverse();
    const after = await reorderLookup(tdb.db, keywords, reversed);
    expect(after.map((r) => r.id)).toEqual(reversed);
    expect(after.map((r) => r.sortOrder)).toEqual(reversed.map((_, i) => i + 1));
  });

  it("a reorder whose id set is stale is refused and changes nothing", async () => {
    const before = await listLookupRows(tdb.db, keywords);
    const stale = before.map((r) => r.id).slice(1); // missing one row, as if it were added after the page loaded
    await expect(reorderLookup(tdb.db, keywords, stale.reverse())).rejects.toBeInstanceOf(StaleLookupOrderError);
    expect(await listLookupRows(tdb.db, keywords)).toEqual(before);
  });

  it("validates names and extras against legacy's column sizes", () => {
    expect(() => lookupInputSchema(LOOKUPS.categories).parse({ name: "x".repeat(51) })).toThrow();
    expect(() => lookupInputSchema(LOOKUPS.categories).parse({ name: "   " })).toThrow();
    expect(() => lookupInputSchema(LOOKUPS["government-representatives"]).parse({ name: "Sample", extras: { description: "x".repeat(85) } })).toThrow();
    expect(() => lookupInputSchema(LOOKUPS.categories).parse({ name: "Sample", extras: { phone: "1" } })).toThrow(); // categories have no extras
  });
});
