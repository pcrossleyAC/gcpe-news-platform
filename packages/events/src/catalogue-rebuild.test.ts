import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { indexKeysFor, parseEvent } from "./catalogue";

const envelope = (data: unknown) => ({
  id: randomUUID(), type: "site.rebuild_requested", version: 1, source: "news-api", aggregateId: "post:k1",
  sequence: 1, occurredAt: "2026-10-03T17:00:00Z", correlationId: randomUUID(), data,
});

describe("site.rebuild_requested", () => {
  it("accepts a non-empty page list", () => {
    expect(parseEvent(envelope({ pages: ["home", "post:2026HLTH0001-000001"] })).data).toEqual({ pages: ["home", "post:2026HLTH0001-000001"] });
  });
  it("rejects an empty page list and empty identifiers", () => {
    expect(() => parseEvent(envelope({ pages: [] }))).toThrow();
    expect(() => parseEvent(envelope({ pages: [""] }))).toThrow();
  });
});

describe("indexKeysFor", () => {
  it("prefixes and lowercases every category key", () => {
    expect(indexKeysFor({ ministryKeys: ["Health"], sectorKeys: ["Mining"], tagKeys: [], themeKeys: ["Economy"] })).toEqual([
      "ministries:health", "sectors:mining", "themes:economy",
    ]);
  });
});
