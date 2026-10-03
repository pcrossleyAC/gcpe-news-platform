import { describe, expect, it } from "vitest";
import type { CategoryRow, HomeRow, PostRow, ResourceLinkRow } from "./db/schema";
import { ministerEmailHtml, toCategoryDto, toHomeDto, toKeyValue, toMinisterDto, toMinistryDto, toPostDto, toResourceLinkDto, toSlideDto } from "./dto";

const tz = "America/Vancouver";

const post: PostRow = {
  key: "2026TT0103-001121", kind: "releases", reference: "NEWS-34336", atomId: "uuid:9af8cc16-0ae5-4ec6-ad58-fdb081d44e37",
  publishDate: new Date("2026-10-01T22:10:00Z"), leadMinistryKey: "transportation-and-transit", summary: "s", socialMediaSummary: null,
  socialMediaHeadline: null, keywords: "", location: "Abbotsford", hasMediaAssets: false, hasTranslations: false, isNewsOnDemand: true,
  assetUrl: "", redirectUri: null, documents: [], ministryKeys: ["transportation-and-transit"], sectorKeys: [], tagKeys: [], themeKeys: [],
  indexKeys: [], assets: null, translations: null, isPublished: true, timestamp: new Date("2026-10-01T22:10:28.037Z"),
};

const ministry: CategoryRow = {
  kind: "ministries", key: "health", name: "Health", sortOrder: 0, isActive: true,
  social: { twitterUsername: "", flickrUrl: "https://flickr", youtubeUrl: null, audioUrl: null },
  ministry: {
    parentKey: null, url: "http://gov.bc.ca/health", displayAdditionalName: null,
    minister: { name: "Honourable Sam Placeholder", summary: "Honourable Sam Placeholder", detailsHtml: "<p>bio</p>", email: "SP.Minister@gov.bc.ca", photoUrl: "https://photo", address: "PO BOX 9050" },
    contact: { fullName: "Alex Example", phoneNumber: "1", mobileNumber: "2", emailAddress: "k@gov.bc.ca" }, secondContact: null,
    weekendContactNumber: "", topicLinks: [{ text: "Get immunized", url: "https://x" }], serviceLinks: [],
  },
  timestamp: new Date("2026-10-02T23:46:05.527Z"),
};

describe("dto", () => {
  it("serializes a post with legacy field names and key order", () => {
    const dto = toPostDto(post, tz);
    expect(Object.keys(dto)).toEqual([
      "kind", "atomId", "summary", "socialMediaSummary", "socialMediaHeadline", "keywords", "publishDate", "leadMinistryKey", "hasMediaAssets",
      "hasTranslations", "isNewsOnDemand", "assetUrl", "location", "documents", "reference", "redirectUri", "ministryKeys", "sectorKeys",
      "tagKeys", "themeKeys", "azureAssets", "azureTranslations", "key", "timestamp",
    ]);
    expect(dto.publishDate).toBe("2026-10-01T15:10:00-07:00");
    expect(dto.timestamp).toBe("2026-10-01T15:10:28.037-07:00");
    expect(dto).not.toHaveProperty("memoryCachable");
  });

  it("serializes a ministry with features, child key, links and empty newsletterLinks", () => {
    const dto = toMinistryDto(ministry, { kind: "ministries", key: "health", topPostKey: "t", featurePostKey: "f" }, "child", tz);
    expect(dto).toMatchObject({
      childMinistryKey: "child", parentMinistryKey: null, ministryUrl: "http://gov.bc.ca/health", newsletterLinks: [],
      ministerName: "Honourable Sam Placeholder", contactUser: { fullName: "Alex Example" }, flickrUri: "https://flickr", kind: "ministries",
      name: "Health", topPostKey: "t", featurePostKey: "f", key: "health",
    });
    expect(dto.topicLinks).toEqual([{ uri: "https://x", key: "Get immunized", timestamp: "2026-10-02T16:46:05.527-07:00" }]);
  });

  it("serializes the minister", () => {
    expect(toMinisterDto(ministry, tz)).toEqual({
      headline: "Honourable Sam Placeholder", summary: "Honourable Sam Placeholder", details: "<p>bio</p>",
      emailHtml: '<a href="mailto: SP.Minister@gov.bc.ca">SP.Minister@gov.bc.ca</a>', photo: "https://photo", post: "PO BOX 9050",
      key: "health", timestamp: "2026-10-02T16:46:05.527-07:00",
    });
    expect(ministerEmailHtml("")).toBe("");
    expect(ministerEmailHtml(null)).toBeNull();
  });

  it("serializes a term category without features as null keys", () => {
    const dto = toCategoryDto({ ...ministry, kind: "sectors", key: "economy", name: "Economy", ministry: null }, undefined, tz);
    expect(dto).toEqual({
      twitterFeedUsername: "", flickrUri: "https://flickr", youtubeUri: null, audioUri: null, isActive: true, kind: "sectors", name: "Economy",
      topPostKey: null, featurePostKey: null, key: "economy", timestamp: "2026-10-02T16:46:05.527-07:00",
    });
  });

  it("serializes a slide image as base64 and key as the id", () => {
    const dto = toSlideDto(
      { id: "f9adfdc2-5933-4c38-a390-a18077acb213", sortIndex: 0, headline: "h", summary: "s", actionLabel: "READ MORE", actionUri: "u", image: Buffer.from("iVBORw0KGgo=", "base64"), imageType: "image/png", facebookPostUri: null, justify: "right", timestamp: new Date("2026-09-09T23:31:07.521Z") },
      tz,
    );
    expect(dto.image).toBe("iVBORw0KGgo=");
    expect(dto.key).toBe("f9adfdc2-5933-4c38-a390-a18077acb213");
  });

  it("serializes a slide with a null image as null", () => {
    const dto = toSlideDto(
      { id: "f9adfdc2-5933-4c38-a390-a18077acb213", sortIndex: 0, headline: "h", summary: "s", actionLabel: "READ MORE", actionUri: "u", image: null, imageType: null, facebookPostUri: null, justify: "right", timestamp: new Date("2026-09-09T23:31:07.521Z") },
      tz,
    );
    expect(dto.image).toBeNull();
  });

  it("serializes an absent home row as an all-null home at the epoch", () => {
    expect(toHomeDto(undefined, tz)).toEqual({
      liveWebcastFlashMediaManifestUrl: null,
      liveWebcastM3uPlaylist: null,
      granville: null,
      kind: "home",
      name: null,
      topPostKey: null,
      featurePostKey: null,
      key: "default",
      timestamp: "1969-12-31T16:00:00-08:00",
    });
  });

  it("serializes a home row, mapping every field", () => {
    const row: HomeRow = {
      key: "default",
      topPostKey: "2026WLRS0034-001107",
      featurePostKey: "2026HLTH0085-001117",
      liveWebcastFlashMediaManifestUrl: "https://stream/manifest.m3u8",
      liveWebcastM3uPlaylist: "https://stream/playlist.m3u8",
      granville: "g",
      timestamp: new Date("2026-10-02T17:34:49.085Z"),
    };
    expect(toHomeDto(row, tz)).toEqual({
      liveWebcastFlashMediaManifestUrl: "https://stream/manifest.m3u8",
      liveWebcastM3uPlaylist: "https://stream/playlist.m3u8",
      granville: "g",
      kind: "home",
      name: null,
      topPostKey: "2026WLRS0034-001107",
      featurePostKey: "2026HLTH0085-001117",
      key: "default",
      timestamp: "2026-10-02T10:34:49.085-07:00",
    });
  });

  it("maps a post to a key/value pair in key order", () => {
    const kv = toKeyValue({ key: "K", kind: "stories" });
    expect(Object.keys(kv)).toEqual(["key", "value"]);
    expect(kv).toEqual({ key: "K", value: "stories" });
  });

  it("serializes a resource link in key order", () => {
    const row: ResourceLinkRow = { sortIndex: 0, text: "Office of the Premier", uri: "/office-of-the-premier", timestamp: new Date("2026-10-03T08:27:16.941Z") };
    const dto = toResourceLinkDto(row, tz);
    expect(Object.keys(dto)).toEqual(["uri", "key", "timestamp"]);
    expect(dto).toEqual({ uri: "/office-of-the-premier", key: "Office of the Premier", timestamp: "2026-10-03T01:27:16.941-07:00" });
  });
});
