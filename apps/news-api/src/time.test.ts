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

  // Final review M2: accept every offset form the event catalogue's
  // z.string().datetime({ offset: true }) lets through (±HH:MM, ±HHMM, Z), plus ±HH,
  // normalised to ±HH:MM before parsing.
  it.each([
    ["±HH:MM", "2026-10-01T15:10:00-07:00"],
    ["±HHMM", "2026-10-01T15:10:00-0700"],
    ["±HH", "2026-10-01T15:10:00-07"],
    ["Z", "2026-10-01T22:10:00Z"],
    ["+00:00", "2026-10-01T22:10:00+00:00"],
    ["+0000", "2026-10-01T22:10:00+0000"],
  ])("parses a %s offset", (_form, value) => {
    expect(parseOffsetDateTime(value).toISOString()).toBe("2026-10-01T22:10:00.000Z");
  });

  it("parses ±HHMM and ±HH with .NET 7-digit fractions and positive offsets", () => {
    expect(parseOffsetDateTime("2026-10-02T03:40:28.0375661+0530").toISOString()).toBe("2026-10-01T22:10:28.037Z");
    expect(parseOffsetDateTime("2026-10-02T00:10:28.5+02").toISOString()).toBe("2026-10-01T22:10:28.500Z");
  });

  it("still rejects a date-only value, whose trailing -DD must not be read as an offset", () => {
    expect(() => parseOffsetDateTime("2026-10-01")).toThrow(/Invalid date/);
  });
});
