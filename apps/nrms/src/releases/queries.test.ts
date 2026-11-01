import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import type { CreateReleaseInput, ListQuery } from "@gcpe/nrms-contract";
import { createNrmsTestDb, createScheduledRelease, editor, sampleCreate, seedActivity, seedTaxonomy } from "../../test/helpers";
import { LEVEL, type Viewer } from "@gcpe/calendar-contract";
import { goTo, listFolder, releaseLog, searchReleases, startOfTomorrow } from "./queries";
import type { SearchQuery } from "@gcpe/nrms-contract";
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
    // The release links below name these Calendar activities; NRMS refuses an id it doesn't know (C142).
    for (const id of [4521, 99]) await seedActivity(tdb.db, id);
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

    it("carries each release's latest history line as lastEdited (when, and by whom); none without history", async () => {
      const v = await create();
      await tdb.db.execute(sql`INSERT INTO release_log (release_id, at, actor_id, actor_name, text) VALUES
        (${v.id}, '2099-10-01T17:00:00Z', 'a', 'Older Person', 'Edited headline'),
        (${v.id}, '2099-10-02T17:00:00Z', 'b', 'Latest Person', 'Edited summary')`);
      const bare = await create({ headline: "No history" });
      await tdb.db.execute(sql`DELETE FROM release_log WHERE release_id = ${bare.id}`);
      const items = (await list({ folder: "drafts" })).items;
      expect(items.find((i) => i.id === v.id)!.lastEdited).toEqual({ at: "2099-10-02T17:00:00.000Z", by: "Latest Person" });
      expect(items.find((i) => i.id === bare.id)!.lastEdited).toBeNull();
    });

    it("lead organization falls back to the first organizations line without 'Ministry of '", async () => {
      await create({ ministries: ["health", "finance"], leadMinistryKey: null, organizations: "Ministry of Finance\nTreasury Board" });
      const [item] = (await list({ folder: "drafts" })).items;
      expect(item!.leadOrganization).toBe("Finance");
    });
  });

  describe("searchReleases", () => {
    /** A Calendar reader in Health, who sees the seeded activities (their contact ministry is Health). */
    const healthReader: Viewer = { level: LEVEL.readOnly, isHq: false, ministryKeys: ["health"] };
    const search = (q: Partial<{ q: string; ministry: string; sector: string; page: number; type: SearchQuery["type"]; from: string; to: string }>, viewer: Viewer | null = healthReader) =>
      searchReleases(tdb.db, { q: "", page: 1, ...q }, { timeZone: TZ, nowMs: Date.now() }, viewer);

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

    it("an activity-shaped query that matches no activity falls back to the headline search (COVID-19)", async () => {
      const covid = await create({ headline: "New COVID-19 clinics open" });
      await create({ headline: "Something else", activityId: 4521 });
      expect((await search({ q: "COVID-19" })).items.map((i) => i.id)).toEqual([covid.id]);
      expect((await search({ q: "covid-19" })).total).toBe(1);
      // An activity match still wins over headlines: ABC-4521 is not in any headline, and a
      // headline that happens to contain the query isn't added to the activity's results.
      await create({ headline: "About ABC-4521" });
      expect((await search({ q: "ABC-4521" })).items.map((i) => i.headline)).toEqual(["Something else"]);
    });

    it("an activity the user can't see in the Calendar doesn't take over the search: its releases and headline matches both appear", async () => {
      await create({ headline: "Linked", activityId: 4521 });
      await create({ headline: "About ABC-4521" });
      const headlines = async (viewer: Viewer | null) => (await search({ q: "ABC-4521" }, viewer)).items.map((i) => i.headline).sort();
      expect(await headlines(null)).toEqual(["About ABC-4521", "Linked"]);
      expect(await headlines({ level: LEVEL.readOnly, isHq: false, ministryKeys: ["finance"] })).toEqual(["About ABC-4521", "Linked"]);
      expect(await headlines(healthReader)).toEqual(["Linked"]);
    });

    it("ministry and sector filters AND together", async () => {
      const both = await create({ headline: "Both match", ministries: ["finance"], leadMinistryKey: "finance", sectors: ["education"] });
      await create({ headline: "Ministry only", ministries: ["finance"], leadMinistryKey: "finance", sectors: ["health"] });
      await create({ headline: "Sector only", ministries: ["health"], leadMinistryKey: "health", sectors: ["education"] });
      expect((await search({ ministry: "finance" })).total).toBe(2);
      expect((await search({ sector: "education" })).total).toBe(2);
      expect((await search({ ministry: "finance", sector: "education" })).items.map((i) => i.id)).toEqual([both.id]);
    });

    // Suite review R9: Type and a From/To range on the release date (when it went out, or else
    // its planned or scheduled time), BC days, both ends included, ANDed with the rest.
    it("filters by type and by release date range, in BC days, ANDed with the other filters", async () => {
      const story = await create({ headline: "Story on Sep 1", type: "story", publishAt: "2026-09-01T17:00:00.000Z" });
      const late = await create({ headline: "Release late Sep 2 BC", publishAt: "2026-09-03T06:30:00.000Z" }); // 23:30 PDT Sep 2
      const out = await create({ headline: "Release that went out Sep 5", publishAt: "2026-09-01T17:00:00.000Z" });
      await markPublished(out.id, "2026-09-05T17:00:00.000Z");
      await create({ headline: "Undated release" });
      const ids = async (q: Parameters<typeof search>[0]) => (await search(q)).items.map((i) => i.id).sort();

      expect(await ids({ type: "story" })).toEqual([story.id]);
      expect((await search({ type: "release" })).total).toBe(3);
      expect((await search({ type: "all" })).total).toBe(4);
      expect(await ids({ from: "2026-09-02", to: "2026-09-02" })).toEqual([late.id]);
      expect(await ids({ from: "2026-09-02" })).toEqual([late.id, out.id].sort());
      expect(await ids({ to: "2026-09-01" })).toEqual([story.id]);
      expect(await ids({ type: "release", to: "2026-09-04" })).toEqual([late.id]);
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
