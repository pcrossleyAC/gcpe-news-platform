import { describe, expect, it } from "vitest";
import { parseEvent, termEventType, type OrgRecord } from "./index";

const org: OrgRecord = {
  key: "health",
  displayName: "Health",
  abbreviation: "HLTH",
  sortOrder: 10,
  isActive: true,
  parentKey: null,
  url: "http://gov.bc.ca/health",
  displayAdditionalName: null,
  minister: { name: "Honourable Ravi Kahlon", summary: "Honourable Ravi Kahlon", detailsHtml: "<p>x</p>", email: "HLTH.Minister@gov.bc.ca", photoUrl: null, address: "PO BOX 9050" },
  contact: { fullName: "Alex Example", phoneNumber: "250-555-0100", mobileNumber: "250-555-0100", emailAddress: "alex.example@gov.bc.ca" },
  secondContact: null,
  weekendContactNumber: "",
  social: { twitterUsername: "", flickrUrl: null, youtubeUrl: null, audioUrl: null },
  topicLinks: [{ text: "Get immunized", url: "https://www2.gov.bc.ca/x" }],
  serviceLinks: [],
  sectorKeys: ["health"],
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
});
