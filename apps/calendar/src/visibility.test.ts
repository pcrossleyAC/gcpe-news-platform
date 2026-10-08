import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCalendarTestDb } from "../test/helpers";
import { activities, activitySharedWith } from "./db/schema";
import { visible, visibleSql, type Viewer, type VisibilityFacts } from "./visibility";

// The generated matrix of spec addendum §16: role × HQ × own/shared/other × confidential × deleted.
// "M-OWN" pins that ministry keys are byte-exact: it is a different ministry from "m-own".
const LEVELS = [0, 1, 2, 3, 4, 5];
const MINISTRY_SETS: string[][] = [[], ["m-own"], ["M-OWN"]];
const viewers: Viewer[] = LEVELS.flatMap((level) => [false, true].flatMap((isHq) => MINISTRY_SETS.map((ministryKeys) => ({ level, isHq, ministryKeys }))));
const CONTACTS = ["m-own", "m-other", null];
const SHARED: string[][] = [[], ["m-own"], ["m-other"]];
const targets: VisibilityFacts[] = CONTACTS.flatMap((contactMinistryKey) =>
  SHARED.flatMap((sharedMinistryKeys) => [false, true].flatMap((isConfidential) => [false, true].map((isDeleted) => ({ contactMinistryKey, sharedMinistryKeys, isConfidential, isDeleted })))),
);

describe("visible() and visibleSql() agree", () => {
  let tdb: TestDatabase;
  const idOf = new Map<number, VisibilityFacts>();

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    for (const t of targets) {
      const [row] = await tdb.db
        .insert(activities)
        .values({ title: "Sample", contactMinistryKey: t.contactMinistryKey, isConfidential: t.isConfidential, deletedAt: t.isDeleted ? new Date("2026-10-01T00:00:00Z") : null })
        .returning({ id: activities.id });
      idOf.set(row!.id, t);
      for (const k of t.sharedMinistryKeys) await tdb.db.insert(activitySharedWith).values({ activityId: row!.id, ministryKey: k });
    }
  });
  afterAll(() => tdb.drop());

  it(`on all ${viewers.length} × ${targets.length} combinations`, async () => {
    expect(viewers).toHaveLength(36);
    expect(targets).toHaveLength(36);
    for (const u of viewers) {
      const rows = await tdb.db.select({ id: activities.id }).from(activities).where(visibleSql(u)).orderBy(asc(activities.id));
      const fromSql = rows.map((r) => r.id);
      const fromTs = [...idOf].filter(([, t]) => visible(u, t)).map(([id]) => id).sort((a, b) => a - b);
      expect({ viewer: u, ids: fromSql }).toEqual({ viewer: u, ids: fromTs });
    }
  });
});

describe("visible() is legacy's list rule (spec addendum §6)", () => {
  const live = (over: Partial<VisibilityFacts> = {}): VisibilityFacts => ({ contactMinistryKey: "m-other", sharedMinistryKeys: [], isConfidential: false, isDeleted: false, ...over });
  const u = (level: number, isHq: boolean, ministryKeys: string[] = []): Viewer => ({ level, isHq, ministryKeys });

  it("needs a Calendar level", () => expect(visible(u(0, true), live())).toBe(false));
  it("a ministry user sees their own and shared ministries, not others", () => {
    expect(visible(u(1, false, ["m-own"]), live({ contactMinistryKey: "m-own" }))).toBe(true);
    expect(visible(u(1, false, ["m-own"]), live({ sharedMinistryKeys: ["m-own"] }))).toBe(true);
    expect(visible(u(5, false, ["m-own"]), live())).toBe(false);
  });
  it("HQ sees every ministry's non-confidential activities at any level", () => expect(visible(u(1, true), live())).toBe(true));
  it("an HQ Editor doesn't see another ministry's confidential activity; HQ Advanced does", () => {
    expect(visible(u(2, true), live({ isConfidential: true }))).toBe(false);
    expect(visible(u(3, true), live({ isConfidential: true }))).toBe(true);
  });
  it("the owning and shared ministries see a confidential activity at any level", () => {
    expect(visible(u(1, false, ["m-own"]), live({ isConfidential: true, sharedMinistryKeys: ["m-own"] }))).toBe(true);
  });
  it("a deleted activity is visible to HQ Administrators only", () => {
    expect(visible(u(5, false, ["m-other"]), live({ contactMinistryKey: "m-other", isDeleted: true }))).toBe(false);
    expect(visible(u(3, true), live({ isDeleted: true }))).toBe(false);
    expect(visible(u(4, true), live({ isDeleted: true }))).toBe(true);
  });
  it("ministry keys are byte-exact", () => expect(visible(u(1, false, ["M-OWN"]), live({ contactMinistryKey: "m-own" }))).toBe(false));
});
