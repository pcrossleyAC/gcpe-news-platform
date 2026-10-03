import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createFakeSource } from "@gcpe/legacy-import";
import { createApp } from "../app";
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
    expect(await importLegacyNews(tdb.db, source)).toEqual({ releases: 1, slides: 1, resourceLinks: 1, features: 1 });
    expect(await importLegacyNews(tdb.db, source)).toEqual({ releases: 1, slides: 1, resourceLinks: 1, features: 1 });
    const app = createApp({ db: tdb.db, timeZone: TZ, eventSecrets: EVENT_SECRETS });
    const V = "api-version=1.0";
    expect((await request(app).get(`/api/Posts/2026TT0103-001121?${V}`)).body).toMatchObject({ publishDate: "2026-10-01T15:10:00-07:00", isNewsOnDemand: true });
    expect((await request(app).get(`/api/Home?${V}`)).body).toMatchObject({ featurePostKey: "2026TT0103-001121", topPostKey: null, granville: "off" });
    expect((await request(app).get(`/api/Slides?${V}`)).body[0]).toMatchObject({ justify: "right", imageType: "image/png", key: "f9adfdc2-5933-4c38-a390-a18077acb213" });
    const { rows } = await tdb.pool.query("SELECT count(*)::int AS n FROM posts");
    expect(rows[0].n).toBe(1);
  });
});
