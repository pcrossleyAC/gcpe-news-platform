import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import type { OrgRecord } from "@gcpe/events";
import { createNewsTestDb } from "../test/helpers";
import { applyOrg } from "./projections";
import { getMinister, getMinistry, listMinistries } from "./read";

const org = (key: string, over: Partial<OrgRecord> = {}): OrgRecord => ({
  key,
  displayName: key,
  abbreviation: null,
  sortOrder: 0,
  isActive: true,
  parentKey: null,
  url: null,
  displayAdditionalName: null,
  minister: { name: null, summary: null, detailsHtml: null, email: null, photoUrl: null, address: null },
  contact: null,
  secondContact: null,
  weekendContactNumber: null,
  social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null },
  topicLinks: [],
  serviceLinks: [],
  sectorKeys: [],
  isHq: false,
  isPublic: true,
  updatedAt: "2026-10-08T17:00:00Z",
  ...over,
});

describe("non-public ministries (Q54)", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNewsTestDb();
    await tdb.db.transaction((tx) => applyOrg(tx, org("health")));
    await tdb.db.transaction((tx) => applyOrg(tx, org("office-of-the-premier", { isHq: true })));
    await tdb.db.transaction((tx) => applyOrg(tx, org("gcpe-headquarters", { isHq: true, isPublic: false })));
  });
  afterAll(() => tdb.drop());

  it("are left out of the ministry list; an HQ but public ministry stays", async () => {
    const keys = (await listMinistries(tdb.db, "America/Vancouver")).map((m) => (m as { key: string }).key);
    expect(keys).toContain("health");
    expect(keys).toContain("office-of-the-premier");
    expect(keys).not.toContain("gcpe-headquarters");
  });

  it("are not found by key, as ministry or minister", async () => {
    expect(await getMinistry(tdb.db, "gcpe-headquarters", "America/Vancouver")).toBeNull();
    expect(await getMinister(tdb.db, "gcpe-headquarters", "America/Vancouver")).toBeNull();
    expect(await getMinistry(tdb.db, "health", "America/Vancouver")).not.toBeNull();
  });

  it("become listed again when Core makes them public, and a replayed old envelope keeps the ministry listed", async () => {
    await tdb.db.transaction((tx) => applyOrg(tx, org("gcpe-headquarters", { isHq: true, isPublic: true })));
    expect(await getMinistry(tdb.db, "gcpe-headquarters", "America/Vancouver")).not.toBeNull();
    // An envelope stored before isPublic existed parses with the default (Q54), so it is public.
    await tdb.db.transaction((tx) => applyOrg(tx, org("health", { isPublic: true })));
    expect(await getMinistry(tdb.db, "health", "America/Vancouver")).not.toBeNull();
  });
});
