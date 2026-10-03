import { describe, expect, it } from "vitest";
import { imageTypeFromBytes, justifyFromLegacy, mapLegacyRelease, splitContact, type LegacyReleaseRow } from "./map";

const row: LegacyReleaseRow = {
  Id: "9AF8CC16-0AE5-4EC6-AD58-FDB081D44E37", Key: "2026TT0103-001121", ReleaseType: 1, Reference: "NEWS-34336", AtomId: "",
  PublishDateTime: new Date("2026-10-01T22:10:00Z"), LeadMinistryKey: "transportation-and-transit", Keywords: "", AssetUrl: "",
  RedirectUrl: "", HasMediaAssets: false, PublishOptions: 3, Timestamp: new Date("2026-10-01T22:10:28.037Z"),
  Location: "Abbotsford", Summary: "Drivers can expect…", SocialMediaHeadline: null, SocialMediaSummary: null,
};

describe("mapLegacyRelease", () => {
  it("maps a legacy release to the published-content record", () => {
    const r = mapLegacyRelease(
      row,
      [
        { ReleaseId: row.Id, DocumentId: "d1", SortIndex: 0, LanguageId: 3084, PageTitle: "Avis", Headline: "FR", Subheadline: "", Byline: "", BodyHtml: "<p>fr</p>" },
        { ReleaseId: row.Id, DocumentId: "d1", SortIndex: 0, LanguageId: 4105, PageTitle: "Traffic Advisory", Headline: "Traffic-pattern change", Subheadline: "", Byline: "", BodyHtml: "<p>en</p>" },
      ],
      [{ DocumentId: "d1", LanguageId: 4105, SortIndex: 0, Information: "Ministry of Transportation and Transit\r\nMedia Relations\r\n250-555-0101" }],
      [
        { ReleaseId: row.Id, IndexKind: "sectors", IndexKey: "services" },
        { ReleaseId: row.Id, IndexKind: "sectors", IndexKey: "government-operations" },
        { ReleaseId: row.Id, IndexKind: "ministries", IndexKey: "transportation-and-transit" },
      ],
    );
    expect(r).toMatchObject({
      key: "2026TT0103-001121", kind: "releases", reference: "NEWS-34336", atomId: "uuid:9af8cc16-0ae5-4ec6-ad58-fdb081d44e37",
      publishDate: "2026-10-01T22:10:00.000Z", isNewsOnDemand: true, redirectUri: null, assetUrl: "", hasTranslations: false,
      ministryKeys: ["transportation-and-transit"], sectorKeys: ["government-operations", "services"], tagKeys: [], themeKeys: [],
      publishFlags: { toWeb: true, toSubscribers: true, toMediaLists: false },
    });
    expect(r.documents.map((d) => d.languageId)).toEqual([4105, 3084]);
    expect(r.documents[0]!.contacts).toEqual([{ title: "Ministry of Transportation and Transit", details: "Media Relations\n250-555-0101" }]);
    expect(r.documents[1]!.contacts).toEqual([]);
  });

  it("uses a stored AtomId and the story kind (ReleaseType 2)", () => {
    const r = mapLegacyRelease({ ...row, ReleaseType: 2, AtomId: "tag:x" }, [], [], []);
    expect([r.kind, r.atomId]).toEqual(["stories", "tag:x"]);
  });

  it("throws on ReleaseType 0", () => {
    expect(() => mapLegacyRelease({ ...row, ReleaseType: 0 }, [], [], [])).toThrow(/ReleaseType 0/);
  });
});

describe("helpers", () => {
  it("splits contacts", () => {
    expect(splitContact("Single line")).toEqual({ title: "Single line", details: "" });
    expect(splitContact("")).toEqual({ title: "", details: "" });
  });
  it("maps justify and image types", () => {
    expect([justifyFromLegacy(0), justifyFromLegacy(1), justifyFromLegacy(7), justifyFromLegacy(null)]).toEqual(["left", "right", null, null]);
    expect(imageTypeFromBytes(Buffer.from("89504e470d0a1a0a", "hex"))).toBe("image/png");
    expect(imageTypeFromBytes(Buffer.from("ffd8ffe0", "hex"))).toBe("image/jpeg");
    expect(imageTypeFromBytes(Buffer.from("474946383961", "hex"))).toBe("image/gif");
    expect(imageTypeFromBytes(null)).toBeNull();
  });
});
