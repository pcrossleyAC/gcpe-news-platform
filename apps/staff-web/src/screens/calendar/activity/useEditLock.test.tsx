import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityView } from "@gcpe/calendar-contract";
import { jsonResponse } from "../../../../test/jsonResponse";
import { onUnauthorized } from "../../../api/client";
import { HEARTBEAT_MS, IDLE_MS, POLL_MS, useEditLock } from "./useEditLock";

type Call = { url: string; init?: RequestInit };
const LOCK = "/calendar/api/activities/7/lock";
const RELEASE = "/calendar/api/activities/7/lock/release";
const lockCalls = (calls: Call[]) => calls.filter((c) => c.url === LOCK);
const ok = () => jsonResponse(200, { holderName: "Robin Staff", since: "2026-11-03T18:00:00.000Z", mine: true, tabId: "x" });
const lockedBy = (name: string) => jsonResponse(423, { code: "locked", error: `${name} is editing this activity (since 11:00)`, holder: { displayName: name, since: "2026-11-03T18:00:00.000Z" } });
function stub(calls: Call[], answer: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return answer(url, init);
  }));
}
const mount = (o: Partial<Parameters<typeof useEditLock>[0]> = {}) =>
  renderHook(() => useEditLock({ activityId: 7, initial: null, enabled: true, reload: async () => null, ...o }));

describe("useEditLock (spec addendum §7.5)", () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date("2026-11-03T18:00:00Z") }));
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("takes the lock on the first change, then sends a heartbeat at most once a minute", async () => {
    const calls: Call[] = [];
    stub(calls, ok);
    const { result } = mount();
    expect(result.current.state).toEqual({ kind: "none" });
    await act(async () => void expect(await result.current.touch()).toBe(true));
    expect(result.current.state).toEqual({ kind: "mine" });
    await act(async () => void (await result.current.touch()));
    expect(lockCalls(calls)).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      await result.current.touch();
    });
    expect(lockCalls(calls)).toHaveLength(2);
    expect(JSON.parse(String(lockCalls(calls)[0]!.init!.body))).toEqual({ tabId: result.current.tabId });
  });

  it("someone else's lock: refuses, names them, and opens without a reload once it has gone", async () => {
    const calls: Call[] = [];
    stub(calls, () => lockedBy("Sample Admin"));
    let lock: ActivityView["lock"] = { holderName: "Sample Admin", since: "2026-11-03T17:55:00.000Z", mine: false, tabId: null };
    const reload = vi.fn(async () => ({ lock }) as ActivityView);
    const { result } = mount({ initial: lock, reload });
    expect(result.current.state).toEqual({ kind: "other", holderName: "Sample Admin", since: "2026-11-03T17:55:00.000Z" });
    await act(async () => void expect(await result.current.touch()).toBe(false));
    expect(lockCalls(calls)).toHaveLength(0);
    lock = null;
    await act(async () => void (await vi.advanceTimersByTimeAsync(POLL_MS)));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(result.current.state).toEqual({ kind: "none" });
  });

  it("someone taking it first: the 423 names them", async () => {
    stub([], () => lockedBy("Sample Admin"));
    const { result } = mount();
    await act(async () => void expect(await result.current.touch()).toBe(false));
    expect(result.current.state).toMatchObject({ kind: "other", holderName: "Sample Admin" });
  });

  it("lapses after 15 minutes without input; the next change takes it again", async () => {
    const calls: Call[] = [];
    stub(calls, ok);
    const { result } = mount();
    await act(async () => void (await result.current.touch()));
    await act(async () => void (await vi.advanceTimersByTimeAsync(IDLE_MS)));
    expect(result.current.state).toEqual({ kind: "lapsed" });
    await act(async () => void expect(await result.current.touch()).toBe(true));
    expect(result.current.state).toEqual({ kind: "mine" });
    expect(lockCalls(calls)).toHaveLength(2);
  });

  it("the same user's other tab: Continue here moves the lock with takeOver", async () => {
    const calls: Call[] = [];
    stub(calls, ok);
    const { result } = mount({ initial: { holderName: "Robin Staff", since: "2026-11-03T17:55:00.000Z", mine: true, tabId: "another-tab" } });
    expect(result.current.state).toEqual({ kind: "elsewhere" });
    await act(async () => void (await result.current.continueHere()));
    expect(JSON.parse(String(lockCalls(calls)[0]!.init!.body))).toEqual({ tabId: result.current.tabId, takeOver: true });
    expect(result.current.state).toEqual({ kind: "mine" });
  });

  it("releases with keepalive and the CSRF header when the tab goes, and on leaving the page (C169)", async () => {
    const calls: Call[] = [];
    stub(calls, (url) => (url === RELEASE ? new Response(null, { status: 204 }) : ok()));
    const { result, unmount } = mount();
    await act(async () => void (await result.current.touch()));
    act(() => void window.dispatchEvent(new Event("pagehide")));
    const release = calls.find((c) => c.url === RELEASE)!;
    expect(release.init).toMatchObject({ method: "POST", keepalive: true });
    expect(new Headers(release.init!.headers).get("X-GCPE-Request")).toBe("1");
    expect(JSON.parse(String(release.init!.body))).toEqual({ tabId: result.current.tabId });
    await act(async () => void (await result.current.touch()));
    unmount();
    expect(calls.filter((c) => c.url === RELEASE)).toHaveLength(2);
  });

  it("a new activity has no lock to take", async () => {
    const calls: Call[] = [];
    stub(calls, ok);
    const { result } = mount({ activityId: null });
    await act(async () => void expect(await result.current.touch()).toBe(true));
    expect(calls).toEqual([]);
  });

  it("the freeze is a message to show, not someone's lock", async () => {
    stub([], () => jsonResponse(423, { code: "freeze", error: "You cannot make content changes between 4pm-5pm." }));
    const { result } = mount();
    await act(async () => void expect(await result.current.touch()).toBe(false));
    expect(result.current.state).toEqual({ kind: "none" });
    expect(result.current.problem).toBe("You cannot make content changes between 4pm-5pm.");
  });

  it("a 404 means the activity is gone: touch refuses, and stays refused", async () => {
    stub([], () => jsonResponse(404, { error: "Not found" }));
    const { result } = mount();
    await act(async () => void expect(await result.current.touch()).toBe(false));
    expect(result.current.state).toEqual({ kind: "gone" });
    await act(async () => void expect(await result.current.touch()).toBe(false));
  });

  it("a 401 defers to the sign-in redirect; no banner of its own", async () => {
    stub([], () => jsonResponse(401, { error: "unauthenticated" }));
    let notified = 0;
    const off = onUnauthorized(() => { notified += 1; });
    const { result } = mount();
    await act(async () => void expect(await result.current.touch()).toBe(false));
    expect(notified).toBe(1);
    expect(result.current.state).toEqual({ kind: "none" });
    expect(result.current.problem).toBeNull();
    off();
  });

  it("a real network failure gets the generic message; any other 4xx shows the server's own", async () => {
    stub([], () => { throw new TypeError("Failed to fetch"); });
    const { result: net } = mount();
    await act(async () => void expect(await net.current.touch()).toBe(false));
    expect(net.current.problem).toBe("Couldn't reach the server to start editing. Try again.");

    stub([], () => jsonResponse(403, { error: "You can't edit this activity" }));
    const { result: forbidden } = mount();
    await act(async () => void expect(await forbidden.current.touch()).toBe(false));
    expect(forbidden.current.problem).toBe("You can't edit this activity");
  });

  it("locked_elsewhere on a heartbeat (not just on the first take) moves the state to elsewhere", async () => {
    const calls: Call[] = [];
    let first = true;
    stub(calls, () => {
      if (first) { first = false; return ok(); }
      return jsonResponse(423, { code: "locked_elsewhere", error: "You're editing this activity in another tab", holder: { displayName: "Robin Staff", since: "x" } });
    });
    const { result } = mount();
    await act(async () => void (await result.current.touch()));
    expect(result.current.state).toEqual({ kind: "mine" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      await result.current.touch();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.state).toEqual({ kind: "elsewhere" });
  });

  it("unmounting while the first take() is in flight releases immediately, with no state update and no timer left behind", async () => {
    const calls: Call[] = [];
    let resolveLock!: (r: Response) => void;
    stub(calls, (url) => (url === LOCK ? new Promise<Response>((r) => { resolveLock = r; }) : new Response(null, { status: 204 })));
    const { result, unmount } = mount();
    let p!: Promise<boolean>;
    act(() => { p = result.current.touch(); });
    unmount();
    resolveLock(ok());
    await act(async () => void (await p));
    expect(calls.filter((c) => c.url === RELEASE)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a failed heartbeat shows a problem; the next good heartbeat clears it", async () => {
    let n = 0;
    stub([], () => {
      n += 1;
      if (n === 2) throw new TypeError("Failed to fetch");
      return ok();
    });
    const { result } = mount();
    await act(async () => void (await result.current.touch()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      await result.current.touch();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.problem).toBe("Couldn't reach the server to start editing. Try again.");
    expect(result.current.state).toEqual({ kind: "mine" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      await result.current.touch();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.problem).toBeNull();
  });

  it("lapses from the last heartbeat, not from a later touch that owed no heartbeat yet", async () => {
    const calls: Call[] = [];
    stub(calls, ok);
    const { result } = mount();
    await act(async () => void (await result.current.touch())); // beat at t=0
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_000); // no heartbeat due yet (< HEARTBEAT_MS)
      await result.current.touch();
    });
    expect(lockCalls(calls)).toHaveLength(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(IDLE_MS - 59_000))); // t = IDLE_MS from the one real beat
    expect(result.current.state).toEqual({ kind: "lapsed" });
  });

  it("a backgrounded tab's throttled timer is corrected on visibilitychange: past the window lapses immediately", async () => {
    stub([], ok);
    const { result } = mount();
    await act(async () => void (await result.current.touch())); // beat at t=0
    vi.setSystemTime(new Date("2026-11-03T18:20:00Z")); // 20 min later; the setTimeout never ran
    expect(result.current.state).toEqual({ kind: "mine" });
    act(() => {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current.state).toEqual({ kind: "lapsed" });
  });

  it("a backgrounded tab within the window sends a heartbeat on visibilitychange instead of waiting", async () => {
    const calls: Call[] = [];
    stub(calls, ok);
    const { result } = mount();
    await act(async () => void (await result.current.touch())); // beat at t=0
    vi.setSystemTime(new Date("2026-11-03T18:05:00Z")); // well inside the window
    await act(async () => {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(lockCalls(calls)).toHaveLength(2);
    expect(result.current.state).toEqual({ kind: "mine" });
  });
});
