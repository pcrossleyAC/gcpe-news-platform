import { describe, expect, it } from "vitest";
import { parseEvent } from "./index";
import { sampleRelease } from "./testing";

function env(type: string, data: unknown) {
  return {
    id: "6f0d7f4e-8a51-4d39-9f42-2a4f4c1c0b11",
    type,
    version: 1,
    source: "nrms",
    aggregateId: "release:x",
    sequence: 1,
    occurredAt: "2026-10-02T17:00:00Z",
    correlationId: "0b8f3f86-2d1e-4b59-9e0c-5d6f1b1c2a33",
    data,
  };
}

describe("release and site events", () => {
  it("accepts release.published, including 7-digit fractional timestamps", () => {
    expect(parseEvent(env("release.published", sampleRelease)).data).toEqual(sampleRelease);
  });

  it("rejects an unknown post kind", () => {
    expect(() => parseEvent(env("release.published", { ...sampleRelease, kind: "news" }))).toThrow();
  });

  it("requires notify on release.updated", () => {
    expect(() => parseEvent(env("release.updated", sampleRelease))).toThrow();
    expect(parseEvent(env("release.updated", { ...sampleRelease, notify: false })).type).toBe("release.updated");
  });

  // Owner decision 2026-10-31: a republish can ask NoD to email a corrected copy again.
  it("release.published and release.updated may carry an email-again request, checked", () => {
    const emailAgain = { seq: 1, subscribers: true, mediaLists: false, requestedBy: "Pat Editor", requestedAt: "2026-10-31T21:15:00.000Z" };
    expect(parseEvent(env("release.updated", { ...sampleRelease, notify: true, emailAgain })).data).toMatchObject({ emailAgain });
    expect(parseEvent(env("release.published", { ...sampleRelease, emailAgain })).data).toMatchObject({ emailAgain });
    expect(() => parseEvent(env("release.updated", { ...sampleRelease, notify: true, emailAgain: { ...emailAgain, seq: 0 } }))).toThrow();
    expect(() => parseEvent(env("release.published", { ...sampleRelease, emailAgain: { ...emailAgain, requestedBy: "" } }))).toThrow();
  });

  it("a record without mediaText (an older stored envelope) parses with mediaText null", () => {
    const { mediaText, ...withoutMediaText } = sampleRelease;
    expect(mediaText).toBeNull(); // sanity: the fixture itself carries the field
    expect(parseEvent(env("release.published", withoutMediaText)).data).toMatchObject({ mediaText: null });
  });

  it("validates site.content.changed by entity", () => {
    expect(
      parseEvent(env("site.content.changed", { entity: "categoryFeatures", kind: "ministries", key: "health", topPostKey: "a", featurePostKey: null })).data,
    ).toMatchObject({ entity: "categoryFeatures" });
    expect(() => parseEvent(env("site.content.changed", { entity: "banner" }))).toThrow();
    expect(() =>
      parseEvent(env("site.content.changed", { entity: "slides", slides: [{ id: "not-a-uuid", sortIndex: 0 }] })),
    ).toThrow();
  });
});
