import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createFakeSource } from "@gcpe/legacy-import";
import { sampleRelease } from "@gcpe/events/testing";
import { createApp } from "../app";
import { applyRelease } from "../projections";
import { listenForUpdates, notifyUpdate, type UpdateTarget } from "../updates/notify";
import { createNewsTestDb, EVENT_SECRETS, TZ } from "../../test/helpers";
import { importLegacyNews } from "./run";

const RID = "9af8cc16-0ae5-4ec6-ad58-fdb081d44e37";
const source = createFakeSource({
  releaseYears: [{ Year: 2026 }],
  "releases:2026": [{
    Id: RID.toUpperCase(), Key: "2026TT0103-001121", ReleaseType: 1, Reference: "NEWS-34336", AtomId: "", PublishDateTime: new Date("2026-10-01T22:10:00Z"),
    LeadMinistryKey: "transportation-and-transit", Keywords: "", AssetUrl: "", RedirectUrl: "", HasMediaAssets: false, PublishOptions: 2,
    Timestamp: new Date("2026-10-01T22:10:28Z"), Location: "Abbotsford", Summary: "s", SocialMediaHeadline: null, SocialMediaSummary: null,
  }],
  "documents:2026": [{ ReleaseId: RID, DocumentId: "D1", SortIndex: 0, LanguageId: 4105, PageTitle: "News Release", Headline: "H", Subheadline: "", Byline: "", BodyHtml: "<p>b</p>" }],
  "contacts:2026": [],
  "releaseIndexes:2026": [{ ReleaseId: RID, IndexKind: "ministries", IndexKey: "transportation-and-transit" }],
  releaseKeysById: [{ Id: RID.toUpperCase(), Key: "2026TT0103-001121" }],
  appSettings: [{ SettingName: "HomeFeatureReleaseId", SettingValue: RID }, { SettingName: "granville", SettingValue: "off" }],
  categoryFeatures: [{ Kind: "ministries", Key: "transportation-and-transit", TopReleaseId: RID.toUpperCase(), FeatureReleaseId: null }],
  currentSlides: [{ Id: "F9ADFDC2-5933-4C38-A390-A18077ACB213", SortIndex: 0, Headline: "Get vaccinated", Summary: "s", ActionUrl: "https://x", Image: Buffer.from("89504e470d0a1a0a", "hex"), FacebookPostUrl: null, Justify: 1, Timestamp: new Date("2026-09-09T23:31:07Z") }],
  resourceLinks: [{ SortIndex: 0, LinkText: "Factsheets", LinkUrl: "/factsheets" }],
});

describe("importLegacyNews", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNewsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("imports posts and site content that the API then serves; re-running is idempotent", async () => {
    expect(await importLegacyNews(tdb.db, source)).toEqual({ releases: 1, slides: 1, resourceLinks: 1, features: 1, unpublished: 0 });
    expect(await importLegacyNews(tdb.db, source)).toEqual({ releases: 1, slides: 1, resourceLinks: 1, features: 1, unpublished: 0 });
    const app = createApp({ db: tdb.db, timeZone: TZ, eventSecrets: EVENT_SECRETS });
    const V = "api-version=1.0";
    expect((await request(app).get(`/api/Posts/2026TT0103-001121?${V}`)).body).toMatchObject({ publishDate: "2026-10-01T15:10:00-07:00", isNewsOnDemand: true });
    expect((await request(app).get(`/api/Home?${V}`)).body).toMatchObject({ featurePostKey: "2026TT0103-001121", topPostKey: null, granville: "off" });
    expect((await request(app).get(`/api/Slides?${V}`)).body[0]).toMatchObject({ justify: "right", imageType: "image/png", key: "f9adfdc2-5933-4c38-a390-a18077acb213" });
    const { rows } = await tdb.pool.query("SELECT count(*)::int AS n FROM posts");
    expect(rows[0].n).toBe(1);
  });
});

describe("importLegacyNews: stale category feature pointers", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNewsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  const minimal = { releaseYears: [], appSettings: [], currentSlides: [], resourceLinks: [] };

  it("clears a category's top/feature post keys once legacy's pointer is removed", async () => {
    const withPointer = createFakeSource({
      ...minimal,
      releaseKeysById: [{ Id: RID.toUpperCase(), Key: "2026TT0103-001121" }],
      categoryFeatures: [{ Kind: "ministries", Key: "transportation-and-transit", TopReleaseId: RID.toUpperCase(), FeatureReleaseId: null }],
    });
    expect((await importLegacyNews(tdb.db, withPointer)).features).toBe(1);
    const row1 = (
      await tdb.pool.query("SELECT top_post_key, feature_post_key FROM category_features WHERE kind = 'ministries' AND key = 'transportation-and-transit'")
    ).rows[0];
    expect(row1).toMatchObject({ top_post_key: "2026TT0103-001121", feature_post_key: null });

    // Legacy still lists the ministry, but its TopReleaseId/FeatureReleaseId pointers
    // are now null (the release was un-featured). The row must follow — not stay stuck
    // pointing at a key legacy no longer features.
    const cleared = createFakeSource({
      ...minimal,
      releaseKeysById: [],
      categoryFeatures: [{ Kind: "ministries", Key: "transportation-and-transit", TopReleaseId: null, FeatureReleaseId: null }],
    });
    expect((await importLegacyNews(tdb.db, cleared)).features).toBe(0);
    const row2 = (
      await tdb.pool.query("SELECT top_post_key, feature_post_key FROM category_features WHERE kind = 'ministries' AND key = 'transportation-and-transit'")
    ).rows[0];
    expect(row2).toMatchObject({ top_post_key: null, feature_post_key: null });
  });
});

describe("importLegacyNews: an empty carousel never wipes slides", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNewsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  const minimal = { releaseYears: [], releaseKeysById: [], appSettings: [], categoryFeatures: [], resourceLinks: [] };
  const SLIDE_ID = "F9ADFDC2-5933-4C38-A390-A18077ACB213";
  const withSlide = createFakeSource({
    ...minimal,
    currentSlides: [{ Id: SLIDE_ID, SortIndex: 0, Headline: "Get vaccinated", Summary: "s", ActionUrl: "https://x", Image: null, FacebookPostUrl: null, Justify: null, Timestamp: new Date("2026-09-09T23:31:07Z") }],
  });
  const emptyCarousel = createFakeSource({ ...minimal, currentSlides: [] });

  it("keeps existing slides on an empty result, and only clears them with allowEmptySlides", async () => {
    expect((await importLegacyNews(tdb.db, withSlide)).slides).toBe(1);

    const logs: string[] = [];
    expect((await importLegacyNews(tdb.db, emptyCarousel, { log: (m) => logs.push(m) })).slides).toBe(0);
    expect(logs).toContain("[import] no current carousel slides found; existing slides kept");
    expect((await tdb.pool.query("SELECT count(*)::int AS n FROM slides")).rows[0].n).toBe(1);

    expect((await importLegacyNews(tdb.db, emptyCarousel, { allowEmptySlides: true })).slides).toBe(0);
    expect((await tdb.pool.query("SELECT count(*)::int AS n FROM slides")).rows[0].n).toBe(0);
  });
});

// Final review M7(a): a full import makes the store match legacy's published set — a post
// still published here but no longer published in legacy (unpublished/deactivated there
// since the last import) is unpublished.
describe("importLegacyNews: unpublishes posts missing from legacy's published set", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNewsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE posts");
    await tdb.db.transaction((tx) => applyRelease(tx, { ...sampleRelease, key: "STALE-1", reference: "NEWS-STALE" }));
  });

  const published = async () =>
    (await tdb.pool.query<{ key: string }>("SELECT key FROM posts WHERE is_published ORDER BY key")).rows.map((r) => r.key);

  it("unpublishes them by default, keeping every imported post (matched case-insensitively) published", async () => {
    await tdb.db.transaction((tx) => applyRelease(tx, { ...sampleRelease, key: "2026tt0103-001121", reference: "NEWS-X" }));
    const result = await importLegacyNews(tdb.db, source);
    expect(result.unpublished).toBe(1);
    expect(await published()).toEqual(["2026tt0103-001121"]);
    const { rows } = await tdb.pool.query("SELECT key, is_published FROM posts WHERE key = 'STALE-1'");
    expect(rows).toEqual([{ key: "STALE-1", is_published: false }]);
  });

  it("leaves them alone with unpublishMissing: false", async () => {
    const result = await importLegacyNews(tdb.db, source, { unpublishMissing: false });
    expect(result.unpublished).toBe(0);
    expect(await published()).toEqual(["2026TT0103-001121", "STALE-1"]);
  });

  it("never mass-unpublishes when legacy returned no published releases at all", async () => {
    const logs: string[] = [];
    const empty = createFakeSource({ releaseYears: [], releaseKeysById: [], appSettings: [], categoryFeatures: [], currentSlides: [], resourceLinks: [] });
    const result = await importLegacyNews(tdb.db, empty, { log: (m) => logs.push(m) });
    expect(result.unpublished).toBe(0);
    expect(await published()).toEqual(["STALE-1"]);
    expect(logs).toContain("[import] legacy returned no published releases; skipping unpublish of missing posts");
  });
});

// Final review M7(b): an import of ~100k releases must not fire a PostUpdate NOTIFY (and
// so a SignalR broadcast to every webapp client) per release.
describe("importLegacyNews: no per-release notifications", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNewsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("emits no PostUpdate notifications, for imported or unpublished posts", async () => {
    await tdb.db.transaction((tx) => applyRelease(tx, { ...sampleRelease, key: "STALE-1", reference: "NEWS-STALE" }));
    const got: [UpdateTarget, string[]][] = [];
    const { stop } = await listenForUpdates(tdb.pool, (t, k) => got.push([t, k]));
    try {
      const result = await importLegacyNews(tdb.db, source);
      expect(result).toMatchObject({ releases: 1, unpublished: 1 });
      // NOTIFYs arrive in commit order: once this sentinel is in, everything before it is too.
      await tdb.db.transaction((tx) => notifyUpdate(tx, "HomeUpdate", ["__sentinel"]));
      await vi.waitFor(() => expect(got.at(-1)).toEqual(["HomeUpdate", ["__sentinel"]]));
    } finally {
      await stop();
    }
    expect(got.filter(([t]) => t === "PostUpdate")).toEqual([]);
    // Site content is still announced (one notification per entity, not per release).
    expect(got.map(([t]) => t)).toContain("HomeUpdate");
  });
});
