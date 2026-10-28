import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import type { OrgRecord, ReleaseRecord } from "@gcpe/events";
import { sampleRelease } from "@gcpe/events/testing";
import { createApp } from "../../app";
import { createNewsTestDb, envelope, EVENT_SECRETS, sendEvent, TZ } from "../../../test/helpers";

const V = "api-version=1.0";
const social = { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null };
const org = (key: string, sortOrder: number, over: Partial<OrgRecord> = {}): OrgRecord => ({
  key, displayName: `Ministry ${key}`, abbreviation: null, sortOrder, isActive: true, parentKey: null, url: null, displayAdditionalName: null,
  minister: { name: null, summary: null, detailsHtml: null, email: null, photoUrl: null, address: null }, contact: null, secondContact: null,
  weekendContactNumber: null, social, topicLinks: [], serviceLinks: [], sectorKeys: [], isHq: false, isPublic: true, successorKeys: [], updatedAt: "2026-10-01T00:00:00Z", ...over,
});
const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}T10:00:00-07:00`;
const rel = (key: string, publishDate: string, extra: Partial<ReleaseRecord> = {}): ReleaseRecord => ({
  ...sampleRelease, key, reference: `NEWS-${key}`, publishDate, ministryKeys: [], sectorKeys: [], tagKeys: [], themeKeys: [], ...extra,
});

/**
 * GET /api/v2/categories/{kind}/latest (P4-R11): every active category of a kind with its latest
 * posts and its top and feature posts, in one call. Its lists must be exactly what the v1
 * per-category endpoints answer for the same data, so each case is checked against them.
 */
describe("GET /api/v2/categories/:kind/latest", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    tdb = await createNewsTestDb();
    app = createApp({ db: tdb.db, timeZone: TZ, eventSecrets: EVENT_SECRETS });
    // Tags in sort order b (0), c (1), a (2); "Old" is inactive.
    for (const [key, sortOrder, isActive] of [["a", 2, true], ["b", 0, true], ["c", 1, true], ["old", 3, false]] as const) {
      await sendEvent(app, envelope("core", "tag.upserted", `tag:${key}`, { kind: "tag", key, displayName: `Tag ${key}`, sortOrder, isActive, social, updatedAt: "2026-10-01T00:00:00Z" }));
    }
    for (const o of [org("health", 1), org("finance", 0), org("retired", 2, { isActive: false }), org("hidden", 3, { isPublic: false })]) {
      await sendEvent(app, envelope("core", "org.upserted", `org:${o.key}`, o));
    }
    const releases: ReleaseRecord[] = [];
    // Five releases per tag (more than the 3 a sector index shows), on distinct days.
    for (const [i, tag] of ["a", "b", "c"].entries()) {
      for (let n = 1; n <= 5; n++) releases.push(rel(`${tag.toUpperCase()}${n}`, day(i * 6 + n), { tagKeys: [tag], ministryKeys: [n % 2 ? "health" : "finance"] }));
    }
    releases.push(
      // Two posts on the same instant: the tie-break is key (collate "C") descending, as v1.
      rel("A-TIE", day(3), { tagKeys: ["a"] }),
      // A factsheet: not in the default (releases + stories) lists.
      rel("A-FACT", day(28), { tagKeys: ["a"], kind: "factsheets" }),
      // A story counts.
      rel("B-STORY", day(12), { tagKeys: ["b"], kind: "stories" }),
      // In an inactive tag and in an active one.
      rel("OLD1", day(20), { tagKeys: ["old", "c"] }),
      // The newest of all, then unpublished: it must never appear.
      rel("GONE", day(29), { tagKeys: ["a", "b", "c"], ministryKeys: ["health"] }),
      // Published but dated after every other post (a future publish date): the v1 lists carry no
      // date filter, so it shows wherever they show it.
      rel("FUTURE", "2027-01-01T10:00:00-08:00", { tagKeys: ["c"] }),
      rel("HIDDEN1", day(3), { ministryKeys: ["hidden", "retired"] }),
    );
    for (const r of releases) await sendEvent(app, envelope("nrms", "release.published", `release:${r.key}`, r));
    await sendEvent(app, envelope("nrms", "release.unpublished", "release:GONE", { key: "GONE" }));
    // Tag a: its newest two are the top and the feature, so its latest list skips them. Tag b's
    // feature is an unknown key (no post), its top a factsheet in another tag.
    await sendEvent(app, envelope("nrms", "site.content.changed", "site:feature:tags:a", { entity: "categoryFeatures", kind: "tags", key: "a", topPostKey: "a5", featurePostKey: "A4" }));
    await sendEvent(app, envelope("nrms", "site.content.changed", "site:feature:tags:b", { entity: "categoryFeatures", kind: "tags", key: "b", topPostKey: "A-FACT", featurePostKey: "NOPE" }));
    await sendEvent(app, envelope("nrms", "site.content.changed", "site:feature:ministries:health", { entity: "categoryFeatures", kind: "ministries", key: "health", topPostKey: "C5", featurePostKey: null }));
  });
  afterAll(async () => {
    await tdb.drop();
  });

  type Group = { key: string; name: string; topPost: { key: string } | null; featurePost: { key: string } | null; latest: { key: string }[] };
  const batch = async (kind: string, count: number): Promise<Group[]> => {
    const res = await request(app).get(`/api/v2/categories/${kind}/latest?count=${count}`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    return res.body.categories;
  };
  const keys = (posts: { key: string }[]) => posts.map((p) => p.key);

  it.each([1, 2, 3])("tags, count=%i: active tags in sort order, each latest list equal to v1's Latest (whole DTOs)", async (count) => {
    const groups = await batch("tags", count);
    expect(groups.map((g) => [g.key, g.name])).toEqual([["b", "Tag b"], ["c", "Tag c"], ["a", "Tag a"]]);
    for (const g of groups) {
      const v1 = await request(app).get(`/api/Posts/Latest/tags/${g.key}?count=${count}&${V}`);
      expect(g.latest, g.key).toEqual(v1.body);
      expect(g.latest.length, g.key).toBe(count);
    }
  });

  it("top and feature posts are v1's /api/Posts answers; latest leaves them out; unpublished, unknown and inactive never appear", async () => {
    const groups = await batch("tags", 3);
    const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));
    const a = byKey.a!;
    const [top, feature] = (await request(app).get(`/api/Posts?postKeys=a5,A4&${V}`)).body;
    expect(a.topPost).toEqual(top);
    expect(a.featurePost).toEqual(feature);
    expect(keys(a.latest)).toEqual(["A3", "A-TIE", "A2"]);
    expect(byKey.b!.topPost?.key).toBe("A-FACT"); // any kind, as /api/Posts
    expect(byKey.b!.featurePost).toBeNull();
    expect(keys(byKey.b!.latest)).toEqual(["B-STORY", "B5", "B4"]);
    expect(keys(byKey.c!.latest)).toEqual(["FUTURE", "OLD1", "C5"]);
    expect(byKey.c!.topPost).toBeNull();
    const all = JSON.stringify(groups);
    expect(all).not.toContain('"GONE"');
    expect(groups.map((g) => g.key)).not.toContain("old"); // OLD1 itself is in tag c, so it may appear there
  });

  it("ministries: active public ones only, in sort order, with their names and features", async () => {
    const groups = await batch("ministries", 1);
    expect(groups.map((g) => [g.key, g.name])).toEqual([["finance", "Ministry finance"], ["health", "Ministry health"]]);
    const health = groups[1]!;
    expect(health.topPost?.key).toBe("C5");
    for (const g of groups) expect(g.latest).toEqual((await request(app).get(`/api/Posts/Latest/ministries/${g.key}?count=1&${V}`)).body);
    expect(keys(health.latest)).not.toContain("C5");
  });

  it("a kind with no categories is an empty list; an unknown kind 404s; count must be 1 to 3", async () => {
    expect(await batch("sectors", 3)).toEqual([]);
    expect((await request(app).get("/api/v2/categories/home/latest?count=1")).status).toBe(404);
    expect((await request(app).get("/api/v2/categories/services/latest?count=1")).status).toBe(404);
    for (const bad of ["0", "4", "-1", "1.5", "x", ""]) {
      const res = await request(app).get(`/api/v2/categories/tags/latest?count=${bad}`);
      expect(res.status, bad).toBe(400);
      expect(res.body).toEqual({ error: { code: "InvalidParameter", parameter: "count", message: "count must be an integer from 1 to 3" } });
    }
    expect((await request(app).get("/api/v2/categories/tags/latest")).status).toBe(400);
  });

  it("the kind is case-insensitive, like v1's index kinds", async () => {
    expect((await batch("TAGS", 1)).map((g) => g.key)).toEqual(["b", "c", "a"]);
  });
});
