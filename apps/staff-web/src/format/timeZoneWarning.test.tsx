import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useTimeZoneWarning } from "./timeZoneWarning";
import { formatInZone, isCorrectingTimes, setServerZoneRule } from "./bcTime";
import { BC_TZ_CHECK, playOldRulesBrowser } from "./oldRulesBrowser.testkit";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const answer = (body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, body)));
const nineAm = () => formatInZone("2026-11-03T16:00:00Z", "America/Vancouver", { hour: "numeric", minute: "2-digit", hour12: true }).replace(/\s/g, " ");

describe("useTimeZoneWarning", () => {
  let undo: (() => void) | null = null;
  afterEach(() => {
    undo?.();
    undo = null;
    setServerZoneRule(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    cleanup();
  });

  it("no warning when the check has no tzCheck, and it settles", async () => {
    answer({ timeZone: "America/Vancouver" });
    const { result } = renderHook(() => useTimeZoneWarning());
    expect(result.current.settled).toBe(false);
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.warning).toBeNull();
  });

  it("no warning when the check has no timeZone", async () => {
    answer({ tzCheck: BC_TZ_CHECK });
    const { result } = renderHook(() => useTimeZoneWarning());
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.warning).toBeNull();
  });

  // The test environment's own zone (TZ=UTC) is itself "a device in another zone": the check
  // must ask the browser about Vancouver specifically, never the device's own offset.
  it("an up-to-date browser in another zone: no warning, no correction", async () => {
    answer({ timeZone: "America/Vancouver", tzCheck: BC_TZ_CHECK });
    const { result } = renderHook(() => useTimeZoneWarning());
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.warning).toBeNull();
    expect(isCorrectingTimes()).toBe(false);
  });

  it("an old-rules browser: corrects the times by the server's rule and says so", async () => {
    undo = playOldRulesBrowser();
    expect(nineAm()).toBe("8:00 AM");
    answer({ timeZone: "America/Vancouver", tzCheck: BC_TZ_CHECK });
    const { result } = renderHook(() => useTimeZoneWarning());
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current).toEqual({ settled: true, warning: "corrected", generation: 0 });
    expect(nineAm()).toBe("9:00 AM");
  });

  it("an old-rules browser and a server that can't say since when: the warning only", async () => {
    undo = playOldRulesBrowser();
    answer({ timeZone: "America/Vancouver", tzCheck: { ...BC_TZ_CHECK, fixedSince: null } });
    const { result } = renderHook(() => useTimeZoneWarning());
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.warning).toBe("stale");
    expect(isCorrectingTimes()).toBe(false);
  });

  it("a slow check: the screen shows after the wait, and redraws when the correction arrives", async () => {
    vi.useFakeTimers();
    undo = playOldRulesBrowser();
    let reply: (r: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => (reply = resolve))));
    const { result } = renderHook(() => useTimeZoneWarning());
    await act(async () => vi.advanceTimersByTime(3000));
    expect(result.current).toEqual({ settled: true, warning: null, generation: 0 });
    await act(async () => reply(jsonResponse(200, { timeZone: "America/Vancouver", tzCheck: BC_TZ_CHECK })));
    expect(result.current).toEqual({ settled: true, warning: "corrected", generation: 1 });
  });

  it("fails safe (no warning) if the check fails, and still settles", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, { error: "nope" })));
    const { result } = renderHook(() => useTimeZoneWarning());
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.warning).toBeNull();
  });
});
