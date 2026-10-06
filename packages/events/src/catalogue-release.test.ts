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
