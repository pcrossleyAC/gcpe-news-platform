import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createPublicSiteTestDb } from "../test/helpers";
import { indexEntryOf, membershipOfEntry, postIndex } from "./post-index";
import type { PostDto } from "./dto";

const dto = (over: Partial<PostDto>): PostDto => ({
  key: "K1", kind: "releases", publishDate: "2026-10-03T10:00:00-07:00", summary: "S", location: null, ministryKeys: ["Health"], tagKeys: ["covid-19"],
  documents: [{ languageId: 4105, headline: "Clinics open", subheadline: null, detailsHtml: "<p>x</p>", contacts: [] }], ...over,
});

describe("post index", () => {
  let tdb: TestDatabase;
  beforeAll(async () => { tdb = await createPublicSiteTestDb(); });
  afterAll(async () => { await tdb.drop(); });
  beforeEach(async () => { await tdb.pool.query("TRUNCATE site_posts"); });

  it("indexEntryOf takes the English headline, the BC month and category tokens", () => {
    expect(indexEntryOf("K1", dto({}))).toEqual({ key: "K1", kind: "releases", headline: "Clinics open", summary: "S", publishDate: "2026-10-03T10:00:00-07:00", month: "2026-10", categories: ["ministries:health", "tags:covid-19"] });
    expect(indexEntryOf("K1", dto({ documents: [] }))!.headline).toBe("K1");
    expect(indexEntryOf("K1", dto({ publishDate: "x" }))).toBeNull();
  });

  it("put, get, replace and remove", async () => {
    const idx = postIndex(tdb.db);
    await idx.put(indexEntryOf("K1", dto({}))!);
    expect(membershipOfEntry((await idx.get("K1"))!)).toEqual({ month: "2026-10", categories: ["ministries:health", "tags:covid-19"] });
    await idx.put(indexEntryOf("K1", dto({ ministryKeys: ["finance"], tagKeys: [] }))!);
    expect((await idx.get("K1"))!.categories).toEqual(["ministries:finance"]);
    await idx.remove("K1");
    expect(await idx.get("K1")).toBeNull();
  });

  it("a month lists newest first, across a DST change; months count newest first", async () => {
    const idx = postIndex(tdb.db);
    await idx.put(indexEntryOf("A", dto({ key: "A", publishDate: "2026-03-07T09:00:00-08:00" }))!);
    await idx.put(indexEntryOf("B", dto({ key: "B", publishDate: "2026-03-08T08:30:00-07:00" }))!);
    await idx.put(indexEntryOf("C", dto({ key: "C", publishDate: "2026-02-01T00:00:00-08:00" }))!);
    expect((await idx.inMonth("2026-03")).map((p) => p.key)).toEqual(["B", "A"]);
    expect(await idx.months()).toEqual([{ month: "2026-03", count: 2 }, { month: "2026-02", count: 1 }]);
    expect((await idx.keys()).sort()).toEqual(["A", "B", "C"]);
    expect(await idx.categories()).toEqual(["ministries:health", "tags:covid-19"]);
    expect((await idx.inCategory("tags:covid-19")).sort()).toEqual(["A", "B", "C"]);
  });
});
