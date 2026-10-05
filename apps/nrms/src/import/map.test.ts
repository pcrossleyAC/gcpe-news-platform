import { describe, expect, it } from "vitest";
import { RELEASE_TYPE_TO_KIND } from "@gcpe/legacy-import";
import {
  imageTypeFromBytes,
  justifyFromLegacy,
  layoutFromLegacy,
  legacyUserMap,
  mapContact,
  mapDocument,
  mapDocumentLanguage,
  mapRelease,
  mapReleaseLanguage,
  newestTerm,
  releaseTypeFromLegacy,
  statusFromLegacy,
  type LegacyContactRow,
  type LegacyDocumentLanguageRow,
  type LegacyDocumentRow,
  type LegacyReleaseLanguageRow,
  type LegacyReleaseRow,
} from "./map";

const baseRelease: LegacyReleaseRow = {
  Id: "9AF8CC16-0AE5-4EC6-AD58-FDB081D44E37",
  ReleaseType: 1,
  Key: "2026HLTH0001-000001",
  Reference: "NEWS-00001",
  Year: 2026,
  YearRelease: 1,
  MinistryRelease: 1,
  ActivityId: null,
  ReleaseDateTime: new Date("2026-10-01T22:10:00.000Z"),
  PublishDateTime: new Date("2026-10-01T22:10:00.000Z"),
  IsCommitted: true,
  IsPublished: true,
  PublishOptions: 7,
  IsActive: true,
  HasMediaAssets: false,
  HasTranslations: false,
  NodSubscribers: null,
  MediaSubscribers: null,
  AtomId: "",
  Keywords: "",
  AssetUrl: "",
  RedirectUrl: "",
  LeadMinistryKey: "health",
};

describe("releaseTypeFromLegacy", () => {
  it("maps 1..5 to release/story/factsheet/update/advisory (fails if RELEASE_TYPE_TO_KIND changes)", () => {
    expect([1, 2, 3, 4, 5].map(releaseTypeFromLegacy)).toEqual(["release", "story", "factsheet", "update", "advisory"]);
    // Pinned against the shared legacy map, not a private copy.
    expect(RELEASE_TYPE_TO_KIND[1]).toBe("releases");
  });

  it("throws on an unknown ReleaseType", () => {
    expect(() => releaseTypeFromLegacy(0)).toThrow();
    expect(() => releaseTypeFromLegacy(6)).toThrow();
  });
});

describe("statusFromLegacy", () => {
  it("inactive wins even when committed and published", () => {
    expect(statusFromLegacy({ IsActive: false, IsCommitted: true, IsPublished: true, Reference: "NEWS-00001" })).toEqual({
      status: "deleted", live: false, onHold: false, note: null,
    });
  });

  it("committed and published → published, live", () => {
    expect(statusFromLegacy({ IsActive: true, IsCommitted: true, IsPublished: true, Reference: "NEWS-00001" })).toEqual({
      status: "published", live: true, onHold: false, note: null,
    });
  });

  it("committed only → scheduled, on hold", () => {
    expect(statusFromLegacy({ IsActive: true, IsCommitted: true, IsPublished: false, Reference: "NEWS-00001" })).toEqual({
      status: "scheduled", live: false, onHold: true, note: null,
    });
  });

  it("reference set but not committed → approved", () => {
    expect(statusFromLegacy({ IsActive: true, IsCommitted: false, IsPublished: false, Reference: "NEWS-00001" })).toEqual({
      status: "approved", live: false, onHold: false, note: null,
    });
  });

  it("published but not committed, no reference → draft with a log note", () => {
    expect(statusFromLegacy({ IsActive: true, IsCommitted: false, IsPublished: true, Reference: "" })).toEqual({
      status: "draft", live: false, onHold: false, note: "Imported as a draft: legacy marked it published but not committed",
    });
  });

  it("nothing set → draft, no note", () => {
    expect(statusFromLegacy({ IsActive: true, IsCommitted: false, IsPublished: false, Reference: "" })).toEqual({
      status: "draft", live: false, onHold: false, note: null,
    });
  });
});

describe("mapRelease", () => {
  it("PublishOptions 7 sets toWeb/toSubscribers/toMediaLists all true", () => {
    const r = mapRelease(baseRelease, { governmentTermId: null });
    expect(r).toMatchObject({ toWeb: true, toSubscribers: true, toMediaLists: true });
  });

  it("PublishOptions 1 sets web only", () => {
    const r = mapRelease({ ...baseRelease, PublishOptions: 1 }, { governmentTermId: null });
    expect(r).toMatchObject({ toWeb: true, toSubscribers: false, toMediaLists: false });
  });

  it("an advisory is never toWeb, even with every PublishOptions bit set (legacy NewModel.cs: advisories never publish to the website)", () => {
    const r = mapRelease({ ...baseRelease, ReleaseType: 5, PublishOptions: 7 }, { governmentTermId: null });
    expect(r).toMatchObject({ toWeb: false, toSubscribers: true, toMediaLists: true });
  });

  it("a non-advisory is toWeb even with no PublishOptions bits set", () => {
    const r = mapRelease({ ...baseRelease, PublishOptions: 0 }, { governmentTermId: null });
    expect(r).toMatchObject({ toWeb: true, toSubscribers: false, toMediaLists: false });
  });

  it("lower-cases the legacy GUID", () => {
    const r = mapRelease(baseRelease, { governmentTermId: null });
    expect(r.legacyId).toBe("9af8cc16-0ae5-4ec6-ad58-fdb081d44e37");
  });

  it("keeps the DATETIMEOFFSET instant", () => {
    const r = mapRelease(baseRelease, { governmentTermId: null });
    expect(r.publishAt?.toISOString()).toBe("2026-10-01T22:10:00.000Z");
    expect(r.releasedAt?.toISOString()).toBe("2026-10-01T22:10:00.000Z");
  });

  it("sets status/live/onHold from the status map and version/importedVersion to 1", () => {
    const r = mapRelease(baseRelease, { governmentTermId: null });
    expect(r).toMatchObject({ status: "published", live: true, onHold: false, version: 1, importedVersion: 1 });
  });

  it("carries the lead ministry key and the resolved government term id", () => {
    const r = mapRelease(baseRelease, { governmentTermId: "11111111-1111-1111-1111-111111111111" });
    expect(r).toMatchObject({ leadMinistryKey: "health", termId: "11111111-1111-1111-1111-111111111111" });
  });

  it("carries key/reference/year/yearRelease/ministryRelease/activityId straight through", () => {
    const r = mapRelease({ ...baseRelease, ActivityId: 4521 }, { governmentTermId: null });
    expect(r).toMatchObject({ key: "2026HLTH0001-000001", reference: "NEWS-00001", year: 2026, yearRelease: 1, ministryRelease: 1, activityId: 4521 });
  });
});

describe("mapReleaseLanguage", () => {
  const row: LegacyReleaseLanguageRow = { ReleaseId: baseRelease.Id, LanguageId: 4105, Location: "Victoria", Summary: "A summary.", SocialMediaSummary: null };

  it("summaryEdited is always true (legacy has no flag)", () => {
    const l = mapReleaseLanguage(row, "release-uuid");
    expect(l.summaryEdited).toBe(true);
  });

  it("copies location/summary/socialMediaSummary", () => {
    const l = mapReleaseLanguage({ ...row, SocialMediaSummary: "social" }, "release-uuid");
    expect(l).toMatchObject({ releaseId: "release-uuid", languageId: 4105, location: "Victoria", summary: "A summary.", socialMediaSummary: "social" });
  });
});

describe("mapDocument / layoutFromLegacy", () => {
  const row: LegacyDocumentRow = { Id: "doc-1", ReleaseId: baseRelease.Id, SortIndex: 0, PageLayout: 1 };

  it("maps PageLayout 1/2 to formal/informal", () => {
    expect(layoutFromLegacy(1)).toBe("formal");
    expect(layoutFromLegacy(2)).toBe("informal");
  });

  it("throws on an unknown PageLayout", () => {
    expect(() => layoutFromLegacy(0)).toThrow();
  });

  it("maps sortIndex and layout for a release's internal id", () => {
    const d = mapDocument(row, "release-uuid");
    expect(d).toEqual({ releaseId: "release-uuid", sortIndex: 0, layout: "formal" });
  });
});

describe("mapDocumentLanguage", () => {
  const row: LegacyDocumentLanguageRow = {
    DocumentId: "doc-1", LanguageId: 4105, PageImageId: null, PageTitle: "News Release", Organizations: "Ministry of Health",
    Headline: "Headline", Subheadline: "Sub", Byline: null, BodyHtml: "<p>Body</p>",
  };

  it("copies the document language fields through, resolving the document and image ids", () => {
    const l = mapDocumentLanguage(row, "document-uuid", "image-uuid");
    expect(l).toEqual({
      documentId: "document-uuid", languageId: 4105, pageTitle: "News Release", headline: "Headline", subheadline: "Sub",
      organizations: "Ministry of Health", byline: null, bodyHtml: "<p>Body</p>", pageImageId: "image-uuid",
    });
  });
});

describe("mapContact", () => {
  it("keeps the raw Information string as is", () => {
    const row: LegacyContactRow = { DocumentId: "doc-1", LanguageId: 4105, SortIndex: 0, Information: "Ministry of Health\r\nMedia Relations\r\n250-555-0100" };
    const c = mapContact(row, "document-uuid");
    expect(c).toEqual({ documentId: "document-uuid", languageId: 4105, sortIndex: 0, information: "Ministry of Health\r\nMedia Relations\r\n250-555-0100" });
  });
});

describe("newestTerm", () => {
  it("picks the collection whose name's last 4-digit year is highest", () => {
    expect(newestTerm(["2009-2013", "2017-2021", "2013-2017", "2017-2017"])).toBe("2017-2021");
  });

  it("sorts a name without a year last", () => {
    expect(newestTerm(["No Year", "2017-2021"])).toBe("2017-2021");
  });
});

describe("legacyUserMap", () => {
  it("joins legacy User rows to Core's email map, keyed by lower-cased legacy user id", () => {
    const emailMap = new Map([["editor@example.test", { id: "core-id-1", displayName: "Existing Editor" }]]);
    const rows = [
      { Id: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", EmailAddress: "Editor@Example.TEST", DisplayName: "Legacy Editor" },
      { Id: "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB", EmailAddress: "", DisplayName: "No Email" },
      { Id: "CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC", EmailAddress: "unknown@example.test", DisplayName: "Unknown" },
    ];
    expect(legacyUserMap(rows, emailMap)).toEqual(
      new Map([["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", { id: "core-id-1", displayName: "Existing Editor" }]]),
    );
  });

  it("skips a row with no email", () => {
    expect(legacyUserMap([{ Id: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", EmailAddress: null, DisplayName: "No Email" }], new Map())).toEqual(new Map());
  });
});

describe("re-exported legacy-import helpers", () => {
  it("re-exports justifyFromLegacy and imageTypeFromBytes rather than duplicating them", () => {
    expect(justifyFromLegacy(0)).toBe("left");
    expect(imageTypeFromBytes(null)).toBeNull();
  });
});
