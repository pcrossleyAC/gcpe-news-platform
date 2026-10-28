import { bcSettings, prePlan4Settings, prePlan5Settings } from "../../site-settings/src/fixtures";
import { describe, expect, it } from "vitest";
import { orgRecordSchema, parseEvent, termEventType, type MediaListRecord, type OrgRecord, type OrgSucceeded } from "./index";

const org: OrgRecord = {
  key: "health",
  displayName: "Health",
  abbreviation: "HLTH",
  sortOrder: 10,
  isActive: true,
  parentKey: null,
  url: "http://gov.bc.ca/health",
  displayAdditionalName: null,
  minister: { name: "Honourable Sam Placeholder", summary: "Honourable Sam Placeholder", detailsHtml: "<p>x</p>", email: "SP.Minister@gov.bc.ca", photoUrl: null, address: "PO BOX 9050" },
  contact: { fullName: "Alex Example", phoneNumber: "250-555-0100", mobileNumber: "250-555-0100", emailAddress: "alex.example@gov.bc.ca" },
  secondContact: null,
  weekendContactNumber: "",
  social: { twitterUsername: "", flickrUrl: null, youtubeUrl: null, audioUrl: null },
  topicLinks: [{ text: "Get immunized", url: "https://www2.gov.bc.ca/x" }],
  serviceLinks: [],
  sectorKeys: ["health"],
  isHq: false,
  isPublic: true,
  successorKeys: [],
  updatedAt: "2026-10-02T16:46:05.527-07:00",
};

function envelope(type: string, data: unknown) {
  return {
    id: "6f0d7f4e-8a51-4d39-9f42-2a4f4c1c0b11",
    type,
    version: 1,
    source: "core",
    aggregateId: "org:health",
    sequence: 1,
    occurredAt: "2026-10-02T17:00:00Z",
    correlationId: "0b8f3f86-2d1e-4b59-9e0c-5d6f1b1c2a33",
    data,
  };
}

describe("parseEvent", () => {
  it("accepts a valid org.upserted event", () => {
    expect(parseEvent(envelope("org.upserted", org)).data).toEqual(org);
  });

  it("rejects org.upserted with a missing minister block", () => {
    const { minister: _m, ...bad } = org;
    expect(() => parseEvent(envelope("org.upserted", bad))).toThrow();
  });

  it("rejects an envelope with a non-positive sequence", () => {
    expect(() => parseEvent({ ...envelope("org.upserted", org), sequence: 0 })).toThrow();
  });

  it("passes unknown event types through without validating data", () => {
    expect(parseEvent(envelope("future.thing", { anything: 1 })).type).toBe("future.thing");
  });

  it("maps term kinds to event types", () => {
    expect(termEventType("sector", "upserted")).toBe("sector.upserted");
    expect(termEventType("service", "deactivated")).toBe("service.deactivated");
  });

  it("org.upserted carries isHq; an older envelope without it parses as not HQ", () => {
    expect(parseEvent(envelope("org.upserted", { ...org, isHq: true })).data).toMatchObject({ isHq: true });
    const { isHq: _h, ...older } = org;
    expect(parseEvent(envelope("org.upserted", older)).data).toMatchObject({ isHq: false });
    expect(() => parseEvent(envelope("org.upserted", { ...org, isHq: "yes" }))).toThrow();
  });

  it("an org.upserted without isPublic parses as public, so a replayed old envelope never hides an organization", () => {
    const { isPublic: _p, ...old } = org;
    const parsed = parseEvent(envelope("org.upserted", old)).data as OrgRecord;
    expect(parsed.isPublic).toBe(true);
  });

  it("an org.upserted carries isPublic false through", () => {
    expect((parseEvent(envelope("org.upserted", { ...org, isPublic: false })).data as OrgRecord).isPublic).toBe(false);
  });

  it("a record and an envelope without teamLinks still parse (orgRecordSchema); teamLinks carries through when present", () => {
    expect("teamLinks" in org).toBe(false);
    expect(orgRecordSchema.parse(org)).toEqual(org);
    expect(parseEvent(envelope("org.upserted", org)).data).toEqual(org);
    const teamLinks = [{ text: "Premier David Eby", url: "/office-of-the-premier/biography" }];
    expect((parseEvent(envelope("org.upserted", { ...org, teamLinks })).data as OrgRecord).teamLinks).toEqual(teamLinks);
    expect(() => parseEvent(envelope("org.upserted", { ...org, teamLinks: [{ text: "x" }] }))).toThrow();
  });
});

const mediaList: MediaListRecord = { key: "regional", displayName: "Regional media", sortOrder: 1, isActive: true };

describe("media_list.* events", () => {
  it("accepts a valid media_list.created envelope", () => {
    expect(parseEvent(envelope("media_list.created", mediaList)).data).toEqual(mediaList);
  });

  it("accepts a valid media_list.updated envelope", () => {
    expect(parseEvent(envelope("media_list.updated", mediaList)).data).toEqual(mediaList);
  });

  it("accepts a valid media_list.deactivated envelope", () => {
    expect(parseEvent(envelope("media_list.deactivated", { key: "regional" })).data).toEqual({ key: "regional" });
  });

  it("rejects media_list.created, media_list.updated and media_list.deactivated with a missing key", () => {
    const { key: _k, ...bad } = mediaList;
    expect(() => parseEvent(envelope("media_list.created", bad))).toThrow();
    expect(() => parseEvent(envelope("media_list.updated", bad))).toThrow();
    expect(() => parseEvent(envelope("media_list.deactivated", {}))).toThrow();
  });
});

const slide = {
  id: "11111111-1111-4111-8111-111111111111",
  sortIndex: 0,
  headline: "H",
  summary: null,
  actionLabel: null,
  actionUri: null,
  imageBase64: null,
  imageType: null,
  facebookPostUri: null,
  justify: "Left",
  timestamp: "2026-10-11T00:00:00Z",
};

describe("site.content.changed 'slides' — content-addressed image fields", () => {
  it("a slide without imageUrl/imageKey/imageSha256 still parses (an older envelope defaults them to null)", () => {
    const parsed = parseEvent(envelope("site.content.changed", { entity: "slides", slides: [slide] }));
    expect(parsed.data).toMatchObject({ entity: "slides", slides: [{ ...slide, imageUrl: null, imageKey: null, imageSha256: null }] });
  });

  it("accepts a slide with a valid imageUrl/imageKey/imageSha256", () => {
    const sha = "a".repeat(64);
    const withImage = { ...slide, imageUrl: `/files/slides/${sha}.png`, imageKey: `slides/${sha}.png`, imageSha256: sha };
    const parsed = parseEvent(envelope("site.content.changed", { entity: "slides", slides: [withImage] }));
    expect(parsed.data).toMatchObject({ entity: "slides", slides: [withImage] });
  });

  it("rejects a malformed imageKey", () => {
    const bad = { ...slide, imageKey: "slides/../x.png" };
    expect(() => parseEvent(envelope("site.content.changed", { entity: "slides", slides: [bad] }))).toThrow();
  });

  it("rejects a malformed imageSha256", () => {
    const bad = { ...slide, imageSha256: "XYZ" };
    expect(() => parseEvent(envelope("site.content.changed", { entity: "slides", slides: [bad] }))).toThrow();
  });
});

describe("site.settings.published", () => {
  const data = { revision: 1, publishedAt: "2026-10-27T12:00:00Z", document: bcSettings() };
  it("accepts a bc-defaults document at revision 1", () => {
    expect(parseEvent(envelope("site.settings.published", data)).data).toMatchObject({ revision: 1 });
  });
  it("rejects revision 0", () => {
    expect(() => parseEvent(envelope("site.settings.published", { ...data, revision: 0 }))).toThrow();
  });
  it("a site.settings.published event recorded before plan 4 still parses", () => {
    const old = { ...data, document: prePlan4Settings() };
    expect(parseEvent(envelope("site.settings.published", JSON.parse(JSON.stringify(old)))).data).toEqual(old);
  });
  it("a site.settings.published event recorded before plan 5 (no siteIdentity) still parses", () => {
    const old = { ...data, document: prePlan5Settings() };
    expect(parseEvent(envelope("site.settings.published", JSON.parse(JSON.stringify(old)))).data).toEqual(old);
  });
  it("keeps every plan-4 part of a current document", () => {
    expect(parseEvent(envelope("site.settings.published", JSON.parse(JSON.stringify(data)))).data).toEqual(data);
  });
});

describe("government_terms.published", () => {
  const data = {
    publishedAt: "2028-11-20T08:00:00.000Z",
    currentSlug: "2028-11-20",
    terms: [
      { slug: "2028-11-20", label: null, startDate: "2028-11-20", endDate: null, legacyArchiveUrl: null },
      { slug: "2024-2028", label: "41st Parliament", startDate: "2024-11-18", endDate: "2028-11-19", legacyArchiveUrl: "https://archive.news.gov.bc.ca/index_current.htm" },
    ],
  };
  it("round-trips a sample payload", () => {
    expect(parseEvent(envelope("government_terms.published", data)).data).toEqual(data);
  });
  it("accepts no current term", () => {
    expect(parseEvent(envelope("government_terms.published", { ...data, currentSlug: null, terms: [] })).data).toMatchObject({ currentSlug: null });
  });
  it("rejects a startDate that is not a bare ISO date", () => {
    expect(() => parseEvent(envelope("government_terms.published", { ...data, terms: [{ ...data.terms[0]!, startDate: "2028-11-20T00:00" }] }))).toThrow();
  });
});

describe("org succession (new-government spec §4)", () => {
  it("OrgRecord parses without successorKeys (old envelope) as no successors", () => {
    const { successorKeys: _s, ...old } = org;
    expect((parseEvent(envelope("org.upserted", old)).data as OrgRecord).successorKeys).toEqual([]);
    expect((parseEvent(envelope("org.upserted", { ...org, isActive: false, successorKeys: ["b", "c"] })).data as OrgRecord).successorKeys).toEqual(["b", "c"]);
  });

  it("org.succeeded carries the hand-over flags and needs at least one successor", () => {
    const data: OrgSucceeded = { key: "health", successorKeys: ["wellness"], moveSubscribers: true, moveCalendar: false, moveDrafts: true, takeAbbreviation: true, at: "2028-11-20T17:00:00.000Z" };
    expect(parseEvent(envelope("org.succeeded", data)).data).toEqual(data);
    expect(() => parseEvent(envelope("org.succeeded", { ...data, successorKeys: [] }))).toThrow();
    expect(() => parseEvent(envelope("org.succeeded", { ...data, successorKeys: [""] }))).toThrow();
    const { moveDrafts: _d, ...missing } = data;
    expect(() => parseEvent(envelope("org.succeeded", missing))).toThrow();
    expect(() => parseEvent(envelope("org.succeeded", { ...data, at: "2028-11-20" }))).toThrow();
  });
});
