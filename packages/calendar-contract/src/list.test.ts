import { describe, expect, it } from "vitest";
import {
  checkCalendarRange, DEFAULT_HIDDEN_COLUMNS, DEFAULT_LIST_QUERY, EMPTY_LIST_FILTER, HIDEABLE_COLUMNS, LIST_COLUMNS, LIST_SORTS,
  listFilterSchema, listPreferencesSchema, listQuerySchema, savedFilterCreateSchema, savedFilterOrderSchema,
} from "./list";

describe("the list filter model (spec addendum §8.1)", () => {
  it("fills every field from an empty object", () => {
    expect(EMPTY_LIST_FILTER).toEqual({
      from: null, to: null, thisDayOnly: false, quickSearch: "", keywordIds: [], isIssue: null, dateConfirmed: null, status: null,
      categoryId: null, ministryKey: null, commContactUserId: null, representativeId: null, initiativeId: null, premierRequestedId: null, distributionId: null,
    });
    expect(DEFAULT_LIST_QUERY).toEqual({ filter: EMPTY_LIST_FILTER, corporate: null, display: "all", lookAhead: "all", sort: "dateTime", dir: "asc" });
  });

  it("trims the quick search, lowercases a person's id, keeps a ministry key byte for byte", () => {
    const f = listFilterSchema.parse({ quickSearch: "  Sample  ", commContactUserId: "00000000-0000-4000-8000-0000000000AB", ministryKey: "M-OWN" });
    expect(f).toMatchObject({ quickSearch: "Sample", commContactUserId: "00000000-0000-4000-8000-0000000000ab", ministryKey: "M-OWN" });
  });

  it("refuses what the database can't hold or the list can't mean", () => {
    const bad = [
      { from: "2026-02-30" }, { from: "1899-12-31" }, { to: "2200-01-01" }, { from: "2026-11-05", to: "2026-11-04" },
      { categoryId: 2_147_483_648 }, { categoryId: 0 }, { keywordIds: Array.from({ length: 51 }, (_, i) => i + 1) },
      { quickSearch: "x".repeat(201) }, { quickSearch: "a\u0000b" }, { ministryKey: "" }, { commContactUserId: "not-a-uuid" },
      { status: "deleted" }, { extra: true },
    ];
    for (const f of bad) expect(listFilterSchema.safeParse(f).success, JSON.stringify(f)).toBe(false);
  });

  it("a query refuses an unknown sort, a sort on Premier, and a corporate query with no status or a day count past a year", () => {
    expect(LIST_SORTS).not.toContain("premier");
    expect(listQuerySchema.safeParse({ sort: "premier" }).success).toBe(false);
    expect(listQuerySchema.safeParse({ corporate: { days: 8, statuses: [] } }).success).toBe(false);
    expect(listQuerySchema.safeParse({ corporate: { days: 367, statuses: ["new"] } }).success).toBe(false);
    expect(listQuerySchema.safeParse({ corporate: { days: null, statuses: ["new", "new"] } }).success).toBe(false);
    expect(listQuerySchema.parse({ corporate: { days: null, statuses: ["la_new", "deleted"] } }).corporate).toEqual({ days: null, statuses: ["la_new", "deleted"] });
  });

  it("columns: legacy's order and default hidden set; the Activity Id column can't be hidden", () => {
    expect(LIST_COLUMNS[0]).toBe("activity");
    expect(DEFAULT_HIDDEN_COLUMNS).toEqual(["keywords", "ministry", "status", "translations"]);
    expect(HIDEABLE_COLUMNS).not.toContain("activity");
    expect(listPreferencesSchema.safeParse({ display: "all", hiddenColumns: ["activity"] }).success).toBe(false);
    expect(listPreferencesSchema.safeParse({ display: "all", hiddenColumns: ["city", "city"] }).success).toBe(false);
    expect(listPreferencesSchema.parse({ display: "my_watchlist", hiddenColumns: ["city"] })).toEqual({ display: "my_watchlist", hiddenColumns: ["city"] });
  });

  it("saved filters: a trimmed name of 1–200 characters and a valid filter; an order names each id once", () => {
    expect(savedFilterCreateSchema.parse({ name: "  Sample query ", filter: {} })).toEqual({ name: "Sample query", filter: EMPTY_LIST_FILTER });
    expect(savedFilterCreateSchema.safeParse({ name: "   ", filter: {} }).success).toBe(false);
    expect(savedFilterCreateSchema.safeParse({ name: "x".repeat(201), filter: {} }).success).toBe(false);
    expect(savedFilterOrderSchema.safeParse({ ids: [1, 1] }).success).toBe(false);
  });

  it("a calendar range is at most 42 days and ends on or after it starts", () => {
    expect(checkCalendarRange("2026-11-01", "2026-12-12")).toBeNull();
    expect(checkCalendarRange("2026-11-01", "2026-12-13")).toMatch(/42 days/);
    expect(checkCalendarRange("2026-11-02", "2026-11-01")).toMatch(/end/);
  });
});
