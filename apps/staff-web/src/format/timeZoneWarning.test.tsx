import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useTimeZoneWarning } from "./timeZoneWarning";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const TZ_CHECK_AT = "2026-12-15T20:00:00Z";
const VANCOUVER_OFFSET_MINUTES = -420; // UTC-7, permanent BC time from 2026-11-01

describe("useTimeZoneWarning (fix round 1, finding 3; fix round 2, bug 2)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    cleanup();
  });

  it("no warning when GET /config has no tzCheck", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { timeZone: "America/Vancouver" })));
    const { result } = renderHook(() => useTimeZoneWarning());
    await act(async () => {});
    expect(result.current).toBe(false);
  });

  it("no warning when GET /config has no timeZone", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { tzCheck: { at: TZ_CHECK_AT, offsetMinutes: VANCOUVER_OFFSET_MINUTES } })));
    const { result } = renderHook(() => useTimeZoneWarning());
    await act(async () => {});
    expect(result.current).toBe(false);
  });

  // Fix round 2, bug 2: this is the regression test for the original bug — the test
  // environment's own zone (vitest.config.ts sets TZ=UTC) is itself "a device in another
  // zone" relative to Vancouver. The fix must compare the browser's *Vancouver-specific*
  // answer (via Intl with an explicit timeZone), never the device's own default-zone offset
  // (Date.prototype.getTimezoneOffset, which this test deliberately never touches) — so a
  // UTC-zoned device with otherwise-correct tzdata must see no banner.
  it("no false warning for a device in a different zone, when its tzdata for the tenant zone is correct", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { timeZone: "America/Vancouver", tzCheck: { at: TZ_CHECK_AT, offsetMinutes: VANCOUVER_OFFSET_MINUTES } })),
    );
    const { result } = renderHook(() => useTimeZoneWarning());
    await act(async () => {});
    expect(result.current).toBe(false);
  });

  it("warns when the browser's own Intl answer for the tenant zone disagrees with the server's (stale tzdata, e.g. still -8h for a post-switch Vancouver date)", async () => {
    const RealDateTimeFormat = Intl.DateTimeFormat;
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (this: unknown, locale?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
      if (options?.timeZone === "America/Vancouver" && options.timeZoneName === "longOffset") {
        return { formatToParts: () => [{ type: "timeZoneName", value: "GMT-08:00" }] } as unknown as Intl.DateTimeFormat;
      }
      return new RealDateTimeFormat(locale, options);
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { timeZone: "America/Vancouver", tzCheck: { at: TZ_CHECK_AT, offsetMinutes: VANCOUVER_OFFSET_MINUTES } })),
    );
    const { result } = renderHook(() => useTimeZoneWarning());
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("fails safe (no warning) if the config fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, { error: "nope" })));
    const { result } = renderHook(() => useTimeZoneWarning());
    await act(async () => {});
    expect(result.current).toBe(false);
  });
});
