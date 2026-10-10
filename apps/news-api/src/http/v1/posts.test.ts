import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import type { ReleaseRecord } from "@gcpe/events";
import { sampleRelease } from "@gcpe/events/testing";
import { createApp } from "../../app";
import { createNewsTestDb, envelope, EVENT_SECRETS, sendEvent, TZ } from "../../../test/helpers";

const V = "api-version=1.0";
const rel = (key: string, publishDate: string, extra: Partial<ReleaseRecord> = {}): ReleaseRecord => ({
  ...sampleRelease, key, reference: `NEWS-${key}`, publishDate, ministryKeys: ["health"], sectorKeys: [], ...extra,
});

describe("posts endpoints", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    tdb = await createNewsTestDb();
    app = createApp({ db: tdb.db, timeZone: TZ, eventSecrets: EVENT_SECRETS });
    await sendEvent(app, envelope("core", "org.upserted", "org:health", {
      key: "health", displayName: "Health", abbreviation: null, sortOrder: 0, isActive: true, parentKey: null, url: null, displayAdditionalName: null,
      minister: { name: null, summary: null, detailsHtml: null, email: null, photoUrl: null, address: null }, contact: null, secondContact: null,
      weekendContactNumber: null, social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null }, topicLinks: [], serviceLinks: [],
      sectorKeys: [], updatedAt: "2026-10-01T00:00:00Z",
    }));
    const releases = [
      rel("R1", "2026-10-01T10:00:00-07:00"),
      rel("R2", "2026-10-02T10:00:00-07:00"),
      rel("R3", "2026-10-03T10:00:00-07:00"),
      rel("S1", "2026-10-04T10:00:00-07:00", { kind: "stories" }),
      rel("F1", "2026-10-05T10:00:00-07:00", { kind: "factsheets" }),
      rel("Y1", "2026-09-01T10:00:00-07:00", { assetUrl: "https://www.youtube.com/watch?v=abc", hasMediaAssets: true }),
      rel("GONE", "2026-10-06T10:00:00-07:00"),
    ];
    for (const r of releases) await sendEvent(app, envelope("nrms", "release.published", `release:${r.key}`, r));
    await sendEvent(app, envelope("nrms", "release.unpublished", "release:GONE", { key: "GONE" }));
    await sendEvent(app, envelope("nrms", "site.content.changed", "site:home", { entity: "home", topPostKey: "S1", featurePostKey: "R3", liveWebcastFlashMediaManifestUrl: null, liveWebcastM3uPlaylist: null, granville: null, timestamp: "2026-10-01T00:00:00Z" }));
    await sendEvent(app, envelope("nrms", "site.content.changed", "site:feature:ministries:health", { entity: "categoryFeatures", kind: "ministries", key: "health", topPostKey: "R2", featurePostKey: null }));
  });
  afterAll(async () => {
    await tdb.drop();
  });

  const keys = (body: { key: string }[]) => body.map((p) => p.key);

  it("Latest excludes the index's top and feature posts; Keys does not", async () => {
    expect(keys((await request(app).get(`/api/Posts/Latest/home/default?${V}`)).body)).toEqual(["R2", "R1", "Y1"]);
    expect(keys((await request(app).get(`/api/Posts/Keys/home/default?${V}`)).body)).toEqual(["S1", "R3", "R2", "R1", "Y1"]);
    expect(keys((await request(app).get(`/api/Posts/Latest/ministries/health?${V}`)).body)).toEqual(["S1", "R3", "R1", "Y1"]);
  });

  it("Latest without count returns all posts, ordered; count and skip page", async () => {
    expect(keys((await request(app).get(`/api/Posts/Keys/home/default?count=2&skip=1&${V}`)).body)).toEqual(["R3", "R2"]);
  });

  it("filters by postKind and returns key/value pairs", async () => {
    expect((await request(app).get(`/api/Posts/Keys/home/default?postKind=factsheets&${V}`)).body).toEqual([{ key: "F1", value: "factsheets" }]);
    expect((await request(app).get(`/api/Posts/Keys/home/default?postKind=advisories&${V}`)).body).toEqual([]);
  });

  it("index lookups: case-insensitive key, 404 problem for unknown key, 404 problem for unknown kind", async () => {
    expect(keys((await request(app).get(`/api/Posts/Keys/ministries/HEALTH?count=1&${V}`)).body)).toEqual(["S1"]);
    const nf = await request(app).get(`/api/Posts/Keys/ministries/zz?${V}`);
    expect(nf.status).toBe(404);
    expect(nf.body).toMatchObject({ title: "Not Found", status: 404 });
    const uk = await request(app).get(`/api/Posts/Keys/services/zz?${V}`);
    expect(uk.status).toBe(404);
    expect(uk.body).toMatchObject({ title: "Not Found", status: 404 });
    expect((await request(app).get(`/api/Posts/Keys/home/other?${V}`)).status).toBe(404);
  });

  it("single post: case-insensitive, empty 200 when missing", async () => {
    expect((await request(app).get(`/api/Posts/r1?${V}`)).body.key).toBe("R1");
    expect((await request(app).get(`/api/Posts/zz?${V}`)).text).toBe("");
  });

  it("postKeys is comma-separated, in request order, unknown skipped, first repeated param only", async () => {
    expect(keys((await request(app).get(`/api/Posts?postKeys=r3,zz,R1&${V}`)).body)).toEqual(["R3", "R1"]);
    expect(keys((await request(app).get(`/api/Posts?postKeys=R2&postKeys=R1&${V}`)).body)).toEqual(["R2"]);
    expect((await request(app).get(`/api/Posts?${V}`)).body).toEqual([]);
  });

  it("Keys/{reference} is case-insensitive and returns one pair", async () => {
    expect((await request(app).get(`/api/Posts/Keys/news-r2?${V}`)).body).toEqual({ key: "R2", value: "releases" });
    expect((await request(app).get(`/api/Posts/Keys/NEWS-zz?${V}`)).text).toBe("");
  });

  it("LatestMediaUri returns the newest matching asset URL, 204 otherwise", async () => {
    expect((await request(app).get(`/api/Posts/LatestMediaUri/video?${V}`)).body).toBe("https://www.youtube.com/watch?v=abc");
    expect((await request(app).get(`/api/Posts/LatestMediaUri/image?${V}`)).status).toBe(204);
    expect((await request(app).get(`/api/Posts/LatestMediaUri/podcast?${V}`)).status).toBe(204);
  });

  it("unpublished post is invisible everywhere", async () => {
    expect((await request(app).get(`/api/Posts/GONE?${V}`)).text).toBe("");
    expect((await request(app).get(`/api/Posts/Keys/NEWS-GONE?${V}`)).text).toBe("");
    expect((await request(app).get(`/api/Posts?postKeys=GONE&${V}`)).body).toEqual([]);
    expect(keys((await request(app).get(`/api/Posts/Keys/home/default?${V}`)).body)).not.toContain("GONE");
  });

  it("400 for non-integer count", async () => {
    expect((await request(app).get(`/api/Posts/Keys/home/default?count=abc&${V}`)).status).toBe(400);
  });

  it("400 for a count larger than int32", async () => {
    expect((await request(app).get(`/api/Posts/Keys/home/default?count=3000000000&${V}`)).status).toBe(400);
  });

  it("Latest without count returns all matching (non-featured) posts, ordered", async () => {
    expect(keys((await request(app).get(`/api/Posts/Latest/home/default?${V}`)).body)).toEqual(["R2", "R1", "Y1"]);
  });

  it("count=0 returns an empty page", async () => {
    expect((await request(app).get(`/api/Posts/Latest/home/default?count=0&${V}`)).body).toEqual([]);
  });

  it("skip without count returns the tail", async () => {
    expect(keys((await request(app).get(`/api/Posts/Keys/home/default?skip=3&${V}`)).body)).toEqual(["R1", "Y1"]);
  });

  it("postKind is case-insensitive", async () => {
    expect((await request(app).get(`/api/Posts/Keys/home/default?postKind=FACTSHEETS&${V}`)).body).toEqual([{ key: "F1", value: "factsheets" }]);
  });

  it("a duplicated key in postKeys is echoed twice", async () => {
    expect(keys((await request(app).get(`/api/Posts?postKeys=R1,R1&${V}`)).body)).toEqual(["R1", "R1"]);
  });

  it("excludes the index's top/feature post even when its stored case differs", async () => {
    await sendEvent(app, envelope("core", "theme.upserted", "theme:wellness", {
      kind: "theme", key: "wellness", displayName: "Wellness", sortOrder: 0, isActive: true,
      social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null }, updatedAt: "2026-10-01T00:00:00Z",
    }));
    await sendEvent(app, envelope("nrms", "release.published", "release:MX1", rel("MX1", "2026-10-07T10:00:00-07:00", { ministryKeys: [], themeKeys: ["wellness"] })));
    await sendEvent(app, envelope("nrms", "release.published", "release:MX2", rel("MX2", "2026-10-08T10:00:00-07:00", { ministryKeys: [], themeKeys: ["wellness"] })));
    await sendEvent(app, envelope("nrms", "site.content.changed", "site:feature:themes:WELLNESS", {
      entity: "categoryFeatures", kind: "themes", key: "WELLNESS", topPostKey: "mx1", featurePostKey: null,
    }));
    expect(keys((await request(app).get(`/api/Posts/Latest/themes/wellness?${V}`)).body)).toEqual(["MX2"]);
  });
});

// Final review M2: zod's datetime({ offset: true }) accepts "-0700"; the projection must too,
// or a valid release event 500s at apply time.
describe("release offsets", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => {
    tdb = await createNewsTestDb();
    app = createApp({ db: tdb.db, timeZone: TZ, eventSecrets: EVENT_SECRETS });
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("applies a release whose publishDate/timestamp use the ±HHMM offset form", async () => {
    const r = rel("HHMM1", "2026-10-01T10:00:00-0700", { timestamp: "2026-10-01T10:05:00.1234567-0700" });
    expect((await sendEvent(app, envelope("nrms", "release.published", "release:HHMM1", r))).outcome).toBe("applied");
    const res = await request(app).get(`/api/Posts/HHMM1?${V}`);
    expect(res.status).toBe(200);
    expect(res.body.publishDate).toBe("2026-10-01T10:00:00-07:00");
  });
});

// Final review D4: ordering ties (same publishDate) and a reference shared by several posts
// must resolve deterministically, independent of the database's default collation.
//
// Local test DBs on this machine are created with datcollate "C" (and macOS libc's en_US
// collation is effectively byte order too), so an un-collated `ORDER BY key` would happen to
// match `collate "C"` here and the tests below couldn't tell them apart. To make them
// discriminating anyway, posts.key is switched to the ICU en-US collation in this throwaway
// DB, where "TIE-B" sorts after "tie-a" (C puts uppercase first).
describe("deterministic ordering", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  const PD = "2026-10-01T10:00:00-07:00";
  beforeAll(async () => {
    tdb = await createNewsTestDb();
    await tdb.pool.query(`ALTER TABLE posts ALTER COLUMN key TYPE text COLLATE "en-US-x-icu"`);
    app = createApp({ db: tdb.db, timeZone: TZ, eventSecrets: EVENT_SECRETS });
    for (const r of [
      rel("tie-a", PD),
      rel("TIE-B", PD),
      rel("tie-c", PD),
      rel("ref-a", "2026-09-01T10:00:00-07:00", { reference: "NEWS-SHARED" }),
      rel("REF-B", "2026-09-01T10:00:00-07:00", { reference: "NEWS-SHARED" }),
      rel("ref-old", "2026-08-01T10:00:00-07:00", { reference: "NEWS-SHARED" }),
    ]) {
      await sendEvent(app, envelope("nrms", "release.published", `release:${r.key}`, r));
    }
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("the ICU collation really does order these keys differently from C", async () => {
    const { rows } = await tdb.pool.query<{ key: string }>("SELECT key FROM posts WHERE key ILIKE 'tie-%' ORDER BY key DESC");
    expect(rows.map((r) => r.key)).toEqual(["tie-c", "TIE-B", "tie-a"]);
  });

  it("breaks same-publishDate ties by key, byte order (collate C) descending", async () => {
    const res = await request(app).get(`/api/Posts/Keys/home/default?count=3&${V}`);
    expect(res.body.map((p: { key: string }) => p.key)).toEqual(["tie-c", "tie-a", "TIE-B"]);
    const latest = await request(app).get(`/api/Posts/Latest/home/default?count=3&${V}`);
    expect(latest.body.map((p: { key: string }) => p.key)).toEqual(["tie-c", "tie-a", "TIE-B"]);
  });

  it("resolves a shared reference to the newest post, then the same key tie-break, every time", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await request(app).get(`/api/Posts/Keys/news-shared?${V}`)).body).toEqual({ key: "ref-a", value: "releases" });
    }
  });
});

// Q54: a non-public ministry's post index is treated exactly like an unknown key (404) — but
// the release itself, and the other indexes it belongs to, are unaffected.
describe("non-public ministry indexes (Q54)", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  const keys = (body: { key: string }[]) => body.map((p) => p.key);

  beforeAll(async () => {
    tdb = await createNewsTestDb();
    app = createApp({ db: tdb.db, timeZone: TZ, eventSecrets: EVENT_SECRETS });
    const org = (key: string, isPublic: boolean) => ({
      key, displayName: key, abbreviation: null, sortOrder: 0, isActive: true, parentKey: null, url: null, displayAdditionalName: null,
      minister: { name: null, summary: null, detailsHtml: null, email: null, photoUrl: null, address: null }, contact: null, secondContact: null,
      weekendContactNumber: null, social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null }, topicLinks: [], serviceLinks: [],
      sectorKeys: [], isHq: true, isPublic, updatedAt: "2026-10-01T00:00:00Z",
    });
    await sendEvent(app, envelope("core", "org.upserted", "org:health", org("health", true)));
    await sendEvent(app, envelope("core", "org.upserted", "org:gcpe-headquarters", org("gcpe-headquarters", false)));
    await sendEvent(
      app,
      envelope("nrms", "release.published", "release:HQ1", rel("HQ1", "2026-10-01T10:00:00-07:00", { ministryKeys: ["health", "gcpe-headquarters"] })),
    );
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("Latest and Keys 404 for a non-public ministry, exactly like an unknown key", async () => {
    const latest = await request(app).get(`/api/Posts/Latest/ministries/gcpe-headquarters?${V}`);
    expect(latest.status).toBe(404);
    expect(latest.body).toMatchObject({ title: "Not Found", status: 404 });
    const listing = await request(app).get(`/api/Posts/Keys/ministries/gcpe-headquarters?${V}`);
    expect(listing.status).toBe(404);
    expect(listing.body).toMatchObject({ title: "Not Found", status: 404 });
  });

  it("the release stays visible by its own key and through the public ministry it also belongs to", async () => {
    expect((await request(app).get(`/api/Posts/HQ1?${V}`)).body.key).toBe("HQ1");
    expect(keys((await request(app).get(`/api/Posts/Latest/ministries/health?${V}`)).body)).toContain("HQ1");
    expect(keys((await request(app).get(`/api/Posts/Keys/ministries/health?${V}`)).body)).toContain("HQ1");
  });
});
