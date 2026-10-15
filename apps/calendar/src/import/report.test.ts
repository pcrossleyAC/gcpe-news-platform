import { describe, expect, it } from "vitest";
import { CalendarImportReport } from "./report";

describe("the import report", () => {
  it("balances when every legacy row is out of scope, written, unchanged or skipped with a reason", () => {
    const r = new CalendarImportReport("confirmed", "2027-01-15");
    r.legacy("activities", 4);
    r.count("activities", "outOfScope", 1);
    r.count("activities", "inserted", 2);
    r.skip("activities", "1013", "a date's year is outside 1900–2199");
    expect(r.balanced()).toBe(true);
    r.legacy("activities", 1);
    expect(r.balanced()).toBe(false);
  });
  it("is never balanced after a failure, and records the cutoff and mode", () => {
    const r = new CalendarImportReport("dry-run", "2027-01-15");
    r.markFailed("activities", "connection lost");
    expect(r.toJSON()).toMatchObject({ mode: "dry-run", cutoff: "2027-01-15", balanced: false, failed: { stage: "activities" } });
    expect(r.toText()).toContain("NOT BALANCED");
  });

  it("lists tables the snapshot didn't provide, and leaves them out of the counts and the balance", () => {
    const r = new CalendarImportReport("confirmed", "2031-03-01");
    r.legacy("favourites", 0);
    r.count("favourites", "planned", 0);
    r.legacy("activities", 2);
    r.count("activities", "inserted", 2);
    r.notProvided("favourites", "not in the snapshot");
    r.legacy("favourites", 3);
    expect(r.balanced()).toBe(true);
    expect(Object.keys(r.toJSON().tables)).toEqual(["activities"]);
    expect(r.toJSON().notProvided).toEqual([{ table: "favourites", note: "not in the snapshot" }]);
    expect(r.toText()).toContain("Not provided: favourites (not in the snapshot)");
  });
});
