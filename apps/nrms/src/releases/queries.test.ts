import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import type { CreateReleaseInput, ListQuery } from "@gcpe/nrms-contract";
import { createNrmsTestDb, createScheduledRelease, editor, sampleCreate, seedTaxonomy } from "../../test/helpers";
import { goTo, listFolder, releaseLog, searchReleases, startOfTomorrow } from "./queries";
import { createRelease, deleteRelease, saveCategories } from "./service";
import { approve } from "./workflow";

const TZ = "America/Vancouver";
const DAY = 24 * 60 * 60_000;
const deps = { timeZone: TZ };

describe("release queries", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    await seedTaxonomy(tdb.db);
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE news_releases, release_log, release_publications, number_counters CASCADE");
  });

  const create = (over: Partial<CreateReleaseInput> = {}) => createRelease(tdb.db, { ...sampleCreate, ...over }, editor);
  const list = (q: Partial<ListQuery> & Pick<ListQuery, "folder">) =>
    listFolder(tdb.db, { type: "all", page: 1, pageSize: 25, ...q }, { timeZone: TZ, nowMs: Date.now() });
  const iso = (ms: number) => new Date(ms).toISOString();
  const markPublished = (id: string, releasedAt: string) =>
    tdb.db.execute(sql`UPDATE news_releases SET status = 'published', live = true, publish_at = ${releasedAt}::timestamptz, released_at = ${releasedAt}::timestamptz WHERE id = ${id}`);

  it("startOfTomorrow is local midnight in BC, not UTC", () => {
    // 23:30 PDT on Oct 2 → midnight Oct 3 PDT (07:00Z)
    expect(startOfTomorrow(Date.parse("2026-10-03T06:30:00Z"), TZ).toISOString()).toBe("2026-10-03T07:00:00.000Z");
    // 00:30 PDT on Oct 3 (07:30Z) → midnight Oct 4 PDT
    expect(startOfTomorrow(Date.parse("2026-10-03T07:30:00Z"), TZ).toISOString()).toBe("2026-10-04T07:00:00.000Z");
  });

  describe("listFolder", () => {
    it("drafts: due before tomorrow first, then undated, then later", async () => {
      const nextWeek = await create({ headline: "Next week", publishAt: iso(Date.now() + 7 * DAY) });
      const undated = await create({ headline: "Undated" });
      const yesterday = await create({ headline: "Yesterday", publishAt: iso(Date.now() - DAY) });
      const page = await list({ folder: "drafts" });
      expect(page.items.map((i) => i.id)).toEqual([yesterday.id, undated.id, nextWeek.id]);
      expect(page.total).toBe(3);
    });

    it("scheduled by publish time ascending; published by released_at descending", async () => {
      const later = await createScheduledRelease(tdb.db, { headline: "Later" }, new Date(Date.now() + 2 * 3600_000));
      const sooner = await createScheduledRelease(tdb.db, { headline: "Sooner" }, new Date(Date.now() + 3600_000));
      expect((await list({ folder: "scheduled" })).items.map((i) => i.id)).toEqual([sooner.id, later.id]);

      const older = await create({ headline: "Older" });
      const newer = await create({ headline: "Newer" });
      await markPublished(older.id, "2026-09-01T17:00:00.000Z");
      await markPublished(newer.id, "2026-09-02T17:00:00.000Z");
      const published = await list({ folder: "published" });
      expect(published.items.map((i) => i.id)).toEqual([newer.id, older.id]);
      expect(published.items[0]).toMatchObject({ status: "published", releasedAt: "2026-09-02T17:00:00.000Z" });
    });

    it("filters by type and pages", async () => {
      for (const h of ["Story one", "Story two", "Story three"]) await create({ type: "story", headline: h });
      await create();
      const all = await list({ folder: "drafts", type: "story" });
      expect(all.total).toBe(3);
      expect(all.items.every((i) => i.type === "story")).toBe(true);
      const p2 = await list({ folder: "drafts", type: "story", pageSize: 2, page: 2 });
      expect(p2).toMatchObject({ total: 3, page: 2, pageSize: 2 });
      expect(p2.items).toHaveLength(1);
    });

    it("a deleted release never appears in any folder", async () => {
      const v = await create();
      const a = await approve(tdb.db, v.id, v.version, editor, deps);
      expect(await deleteRelease(tdb.db, v.id, a.version, editor)).toBe("hidden");
      for (const folder of ["drafts", "scheduled", "published"] as const) {
        const page = await list({ folder });
        expect(page.items.map((i) => i.id)).not.toContain(v.id);
        expect(page.total).toBe(0);
      }
    });

    it("builds the list item for the sample release", async () => {
      const v = await create();
      const [item] = (await list({ folder: "drafts" })).items;
      expect(item).toMatchObject({
        id: v.id, type: "release", leadOrganization: "Health", pageTitle: "News Release", headline: "Weekend clinics open across B.C.",
        location: "VICTORIA", approved: false, statusText: "Draft", reference: null, key: null, publishAt: null, releasedAt: null,
      });
      expect(item!.summary).toBe(v.languages[0]!.summary);
      expect(item!.summary).not.toBe("");
    });

    it("lead organization falls back to the first organizations line without 'Ministry of '", async () => {
      await create({ ministries: ["health", "finance"], leadMinistryKey: null, organizations: "Ministry of Finance\nTreasury Board" });
      const [item] = (await list({ folder: "drafts" })).items;
      expect(item!.leadOrganization).toBe("Finance");
    });
  });

  describe("searchReleases", () => {
    const search = (q: Partial<{ q: string; ministry: string; sector: string; page: number }>) =>
      searchReleases(tdb.db, { q: "", page: 1, ...q }, { timeZone: TZ, nowMs: Date.now() });

    it("matches headlines case-insensitively, including drafts", async () => {
      const draft = await create();
      await create({ headline: "Something else" });
      const res = await search({ q: "CLINICS" });
      expect(res.items.map((i) => i.id)).toEqual([draft.id]);
      expect(res).toMatchObject({ total: 1, page: 1, pageSize: 20 });
      expect((await search({ q: "clinics" })).total).toBe(1);
      expect((await search({ q: "" })).total).toBe(2);
    });

    it("sorts by release/publish time descending (undated last), then headline", async () => {
      const bravo = await create({ headline: "Bravo" });
      const alpha = await create({ headline: "Alpha" });
      const dated = await create({ headline: "Zulu", publishAt: "2026-09-01T17:00:00.000Z" });
      const newer = await create({ headline: "Yankee", publishAt: "2026-09-02T17:00:00.000Z" });
      expect((await search({})).items.map((i) => i.id)).toEqual([newer.id, dated.id, alpha.id, bravo.id]);
    });

    it("an activity id like ABC-4521 finds the release with that activity", async () => {
      const hit = await create({ headline: "Activity one", activityId: 4521 });
      await create({ headline: "Activity two", activityId: 99 });
      expect((await search({ q: "ABC-4521" })).items.map((i) => i.id)).toEqual([hit.id]);
    });

    it("ministry and sector filters AND together", async () => {
      const both = await create({ headline: "Both match", ministries: ["finance"], leadMinistryKey: "finance", sectors: ["education"] });
      await create({ headline: "Ministry only", ministries: ["finance"], leadMinistryKey: "finance", sectors: ["health"] });
      await create({ headline: "Sector only", ministries: ["health"], leadMinistryKey: "health", sectors: ["education"] });
      expect((await search({ ministry: "finance" })).total).toBe(2);
      expect((await search({ sector: "education" })).total).toBe(2);
      expect((await search({ ministry: "finance", sector: "education" })).items.map((i) => i.id)).toEqual([both.id]);
    });

    it("excludes deleted releases", async () => {
      const v = await create();
      const a = await approve(tdb.db, v.id, v.version, editor, deps);
      await deleteRelease(tdb.db, v.id, a.version, editor);
      expect((await search({ q: "clinics" })).total).toBe(0);
    });
  });

  describe("goTo", () => {
    it("resolves paths, URLs, references and numbers; unknown → null", async () => {
      const v = await create();
      const a = await approve(tdb.db, v.id, v.version, editor, deps);
      const story = await create({ type: "story", headline: "A story to find" });
      await tdb.db.execute(sql`UPDATE news_releases SET reference = 'NEWS-01234' WHERE id = ${v.id}`);
      expect(await goTo(tdb.db, `/releases/${a.key}`)).toBe(v.id);
      expect(await goTo(tdb.db, `https://news.gov.bc.ca/stories/${story.key}`)).toBe(story.id);
      expect(await goTo(tdb.db, "01234")).toBe(v.id);
      expect(await goTo(tdb.db, "NEWS-01234")).toBe(v.id);
      expect(await goTo(tdb.db, a.key!.toLowerCase())).toBe(v.id);
      expect(await goTo(tdb.db, "no-such-thing")).toBeNull();
      expect(await goTo(tdb.db, "/stories/no-such-story")).toBeNull();
      expect(await goTo(tdb.db, `/stories/${a.key}`)).toBeNull();
    });

    it("a deleted release doesn't resolve", async () => {
      const v = await create();
      const a = await approve(tdb.db, v.id, v.version, editor, deps);
      await deleteRelease(tdb.db, v.id, a.version, editor);
      expect(await goTo(tdb.db, a.reference!)).toBeNull();
      expect(await goTo(tdb.db, a.key!)).toBeNull();
    });
  });

  describe("releaseLog", () => {
    it("newest first; all=false hides Edited/Updated lines", async () => {
      const v = await create();
      const c = await saveCategories(tdb.db, v.id, { version: v.version, leadMinistryKey: "health", ministries: ["health"], sectors: ["health"], themes: [], tags: [] }, editor);
      await approve(tdb.db, v.id, c.version, editor, deps);
      expect((await releaseLog(tdb.db, v.id, true)).map((e) => e.text)).toEqual(["Approved Release", "Updated categories", "Created Release"]);
      const short = await releaseLog(tdb.db, v.id, false);
      expect(short.map((e) => e.text)).toEqual(["Approved Release", "Created Release"]);
      expect(short[0]).toMatchObject({ actorName: "Test Editor" });
      expect(typeof short[0]!.at).toBe("string");
    });
  });
});
