import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useTimeZoneWarning } from "./timeZoneWarning";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("useTimeZoneWarning (fix round 1, finding 3)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    cleanup();
  });

  it("no warning when GET /config has no tzCheck", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, {})));
    const { result } = renderHook(() => useTimeZoneWarning());
    await act(async () => {});
    expect(result.current).toBe(false);
  });

  it("no warning when the browser's own offset agrees with the server's", async () => {
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(420); // browser thinks UTC-7
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { tzCheck: { at: "2026-12-15T20:00:00Z", offsetMinutes: -420 } })));
    const { result } = renderHook(() => useTimeZoneWarning());
    await act(async () => {});
    expect(result.current).toBe(false);
  });

  it("warns when the browser's own offset disagrees with the server's (stale browser tzdata)", async () => {
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(480); // browser stuck on UTC-8
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { tzCheck: { at: "2026-12-15T20:00:00Z", offsetMinutes: -420 } })));
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
