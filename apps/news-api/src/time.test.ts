import { describe, expect, it } from "vitest";
import { formatOffsetDateTime, parseOffsetDateTime } from "./time";

describe("time", () => {
  it("formats in the tenant zone, omitting zero milliseconds (matches live publishDate)", () => {
    expect(formatOffsetDateTime(new Date("2026-10-01T22:10:00Z"), "America/Vancouver")).toBe("2026-10-01T15:10:00-07:00");
  });

  it("keeps milliseconds and switches to PST in winter", () => {
    expect(formatOffsetDateTime(new Date("2026-01-15T20:00:00.123Z"), "America/Vancouver")).toBe("2026-01-15T12:00:00.123-08:00");
  });

  it("renders UTC as +00:00", () => {
    expect(formatOffsetDateTime(new Date("2026-01-15T20:00:00Z"), "UTC")).toBe("2026-01-15T20:00:00+00:00");
  });

  it("parses .NET 7-digit fractions", () => {
    expect(parseOffsetDateTime("2026-10-01T15:10:28.0375661-07:00").toISOString()).toBe("2026-10-01T22:10:28.037Z");
  });

  it("rejects garbage", () => {
    expect(() => parseOffsetDateTime("yesterday")).toThrow(/Invalid date/);
  });

  it("zero-pads years before 1000 (.NET DateTime.MinValue sentinel)", () => {
    expect(formatOffsetDateTime(new Date("0001-01-01T00:00:00Z"), "UTC")).toBe("0001-01-01T00:00:00+00:00");
  });

  it("round-trips the zero-padded-year sentinel through format then parse", () => {
    const d = new Date("0001-01-01T00:00:00Z");
    expect(parseOffsetDateTime(formatOffsetDateTime(d, "UTC"))).toEqual(d);
  });

  it("rejects a value with no timezone offset", () => {
    expect(() => parseOffsetDateTime("2026-10-01T15:10:00.123")).toThrow(/Invalid date/);
  });
});
