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
});
