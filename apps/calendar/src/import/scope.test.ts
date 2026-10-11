import { describe, expect, it } from "vitest";
import { createFakeSource } from "@gcpe/legacy-import";
import { legacyCalendarTables, TEST_CUTOFF } from "../../test/legacy-calendar-fixture";
import { loadLegacy } from "./load";
import { cutoffWallMs, isPostCutoff, selectScope } from "./scope";

const opts = { cutoff: TEST_CUTOFF, awarenessCategoryIds: [2] };
const scopeOf = async (tables = legacyCalendarTables()) => selectScope(await loadLegacy(createFakeSource(tables), opts), opts);
const ids = (xs: { Id: number }[]) => xs.map((x) => x.Id).sort((a, b) => a - b);

describe("the import scope (spec addendum §12.1, R13)", () => {
  it("the cutoff boundary: an end at exactly 00:00 on the cutoff date is in, 3 ms before is out", () => {
    const cut = cutoffWallMs(TEST_CUTOFF);
    expect(isPostCutoff({ StartDateTime: null, EndDateTime: new Date(cut) }, cut)).toBe(true);
    expect(isPostCutoff({ StartDateTime: null, EndDateTime: new Date(cut - 3) }, cut)).toBe(false);
    expect(isPostCutoff({ StartDateTime: new Date(cut), EndDateTime: null }, cut)).toBe(true);
    expect(isPostCutoff({ StartDateTime: null, EndDateTime: null }, cut)).toBe(false);
  });

  it("selects post-cutoff activities (deleted, spanning and reversed ones too) and non-deleted awareness dates, nothing else", async () => {
    const s = await scopeOf();
    expect(ids(s.activities)).toEqual([1001, 1002, 1004, 1005, 1006, 1009, 1010, 1011, 1012, 1013]);
    expect(s.outOfScope.activities).toBe(4); // 1003, 1007, 1008, 1014
  });

  it("takes only the in-scope activities' favourites, files and log rows, and counts the rest", async () => {
    const s = await scopeOf();
    expect(s.favourites.map((f) => f.ActivityId).sort()).toEqual([1001, 1004]);
    expect(ids(s.files)).toEqual([801, 802, 804]);
    expect(ids(s.logs)).toEqual([9001, 9002, 9003, 9004, 9005, 9006, 9008]);
    expect(s.outOfScope).toMatchObject({ favourites: 1, files: 1, logs: 1, releaseLinks: 2, releaseLinksInScope: 1 });
  });

  it("keeps only active join rows of in-scope activities, each pair once", async () => {
    const s = await scopeOf();
    expect(s.joins.categories.filter((r) => r.ActivityId === 1001).map((r) => r.ValueId)).toEqual([12, 58]);
    expect(s.joins.categories.some((r) => r.ActivityId === 1002 && r.ValueId === 58)).toBe(false);
    expect(s.joins.categories.some((r) => r.ActivityId === 1008)).toBe(false);
  });

  it("selects users who are active or referenced by imported data, never a log actor alone", async () => {
    const s = await scopeOf();
    expect([...s.userIds].sort((a, b) => a - b)).toEqual([11, 12, 13, 14, 16, 19, 20, 21, 22]);
  });

  it("selects comm contacts that are active or referenced, and only active saved filters", async () => {
    const s = await scopeOf();
    expect(ids(s.commContacts)).toEqual([501, 502, 503, 504, 506]);
    expect(ids(s.savedFilters)).toEqual([701, 702]);
  });

  it("an awareness link that isn't active doesn't make an awareness date", async () => {
    const t = legacyCalendarTables();
    t.activityCategories = (t.activityCategories as { ActivityId: number; ValueId: number; IsActive: boolean }[]).map((r) => (r.ActivityId === 1006 ? { ...r, IsActive: false } : r));
    expect(ids((await scopeOf(t)).activities)).not.toContain(1006);
  });
});
