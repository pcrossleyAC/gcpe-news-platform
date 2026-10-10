import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LOCK_IDLE_MS, type ActivityView } from "@gcpe/calendar-contract";
import { ApiError } from "../../../api/client";
import { messagesOf } from "../../admin/messages";
import { activityApi } from "./api";

export const HEARTBEAT_MS = 60_000;
/** Give up on a heartbeat that hasn't replied: a hung request must never block the next one,
 * or the release that has to wait for it. */
const HEARTBEAT_TIMEOUT_MS = 20_000;
/** The server's own lock window (apps/calendar/src/activities/store.ts, via
 * @gcpe/calendar-contract's `LOCK_IDLE_MS`), re-exported under this hook's own name so existing
 * importers (this file's tests) don't need to change. */
export const IDLE_MS = LOCK_IDLE_MS;
export const POLL_MS = 30_000;

export type LockState =
  | { kind: "none" }
  | { kind: "mine" }
  | { kind: "elsewhere" }
  | { kind: "other"; holderName: string; since: string }
  | { kind: "lapsed" }
  /** The activity itself is gone: deleted, or no longer visible to this user (a 404 on the
   * heartbeat or the poll). */
  | { kind: "gone" };

/** A page that has just opened holds no lock of its own: one that is "mine" belongs to another tab. */
export function lockStateOf(lock: ActivityView["lock"]): LockState {
  if (!lock) return { kind: "none" };
  return lock.mine ? { kind: "elsewhere" } : { kind: "other", holderName: lock.holderName, since: lock.since };
}

export interface EditLock {
  tabId: string;
  state: LockState;
  /** A refusal that isn't a lock: the freeze, another status the server sent, or the server out of reach. */
  problem: string | null;
  /** Call on every change: takes the lock, or keeps it alive. False means the change may not stand. */
  touch(): Promise<boolean>;
  /** "Continue here": moves this user's lock from another tab to this one. */
  continueHere(): Promise<void>;
  /** A save's 423, so the page shows who holds the lock. */
  refused(e: unknown): void;
}

/** The editor's side of the edit lock (spec addendum §7.5; C128, C169). */
export function useEditLock(o: { activityId: number | null; initial: ActivityView["lock"]; enabled: boolean; reload: () => Promise<ActivityView | null> }): EditLock {
  const tabId = useMemo(() => crypto.randomUUID(), []);
  const [state, setLockState] = useState<LockState>(() => lockStateOf(o.initial));
  const [problem, setProblem] = useState<string | null>(null);
  const current = useRef(state);
  const set = useCallback((s: LockState) => {
    current.current = s;
    setLockState(s);
  }, []);
  /** When the PUT was sent, not when its reply arrived: the server stamps `lastActiveAt` before
   * it replies (locks.ts:45-47), so the client's clock must start from the same moment. */
  const lastBeat = useRef(0);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The in-flight heartbeat, if any — a release waits for it (and fires again once it settles),
   * so a late PUT can never re-take the lock after the release has gone out. */
  const pendingBeat = useRef<Promise<void> | null>(null);
  /** True between the real unmount and (under StrictMode) the remount that follows: a `take()`
   * that resolves while disposed releases straight away instead of touching state or arming a
   * timer that would outlive the component. */
  const disposed = useRef(false);
  const reload = useRef(o.reload);
  reload.current = o.reload;
  const id = o.activityId;
  const active = o.enabled && id !== null;

  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
    };
  }, []);

  const refused = useCallback((e: unknown) => {
    if (e instanceof ApiError) {
      if (e.status === 423) {
        const body = e.body as { code?: string; holder?: { displayName: string; since: string } | null } | undefined;
        if (body?.code === "locked" && body.holder) set({ kind: "other", holderName: body.holder.displayName, since: body.holder.since });
        else if (body?.code === "locked_elsewhere") set({ kind: "elsewhere" });
        else setProblem(e.message);
        return;
      }
      if (e.status === 404) {
        set({ kind: "gone" });
        return;
      }
      // A 401 is handled by apiFetch's own sign-in redirect (client.ts) — nothing to show here.
      if (e.status === 401) return;
      setProblem(messagesOf(e).join(" "));
      return;
    }
    // Includes an aborted heartbeat (HEARTBEAT_TIMEOUT_MS): the browser has no reply either way.
    setProblem("Couldn't reach the server to start editing. Try again.");
  }, [set]);

  /** Arms (or re-arms) the lapse timer for whatever time remains until `lastBeat.current +
   * IDLE_MS` — not always a flat `IDLE_MS` from now, so a late call (the tab becoming visible
   * again, say) doesn't push the deadline out past what the server will actually honour. */
  const armIdle = useCallback(() => {
    if (idle.current) clearTimeout(idle.current);
    const remaining = Math.max(0, IDLE_MS - (Date.now() - lastBeat.current));
    idle.current = setTimeout(() => {
      if (current.current.kind === "mine") set({ kind: "lapsed" });
    }, remaining);
  }, [set]);

  const take = useCallback(async (takeOver: boolean): Promise<boolean> => {
    const sentAt = Date.now();
    try {
      await activityApi.lock(id!, tabId, takeOver);
      if (disposed.current) {
        void activityApi.release(id!, tabId).catch(() => undefined);
        return false;
      }
      lastBeat.current = sentAt;
      setProblem(null);
      set({ kind: "mine" });
      armIdle();
      return true;
    } catch (e) {
      if (disposed.current) return false;
      refused(e);
      return false;
    }
  }, [id, tabId, set, armIdle, refused]);

  /** Sends the heartbeat PUT, if one isn't already in flight, giving up on it after
   * {@link HEARTBEAT_TIMEOUT_MS}. On success, moves the lapse clock forward from the moment it
   * was sent and clears any stale problem. */
  const sendHeartbeat = useCallback(() => {
    if (pendingBeat.current) return;
    const sentAt = Date.now();
    const controller = new AbortController();
    const giveUp = setTimeout(() => controller.abort(), HEARTBEAT_TIMEOUT_MS);
    const p: Promise<void> = activityApi.lock(id!, tabId, false, controller.signal).then(
      () => {
        clearTimeout(giveUp);
        if (disposed.current) return;
        lastBeat.current = sentAt;
        setProblem(null);
        armIdle();
      },
      (e: unknown) => {
        clearTimeout(giveUp);
        if (disposed.current) return;
        refused(e);
      },
    );
    pendingBeat.current = p;
    void p.finally(() => {
      if (pendingBeat.current === p) pendingBeat.current = null;
    });
  }, [id, tabId, armIdle, refused]);

  const touch = useCallback(async (): Promise<boolean> => {
    if (!active) return true;
    const s = current.current;
    if (s.kind === "other" || s.kind === "elsewhere" || s.kind === "gone") return false;
    if (s.kind !== "mine") return take(false);
    if (Date.now() - lastBeat.current >= HEARTBEAT_MS) sendHeartbeat();
    return true;
  }, [active, id, take, sendHeartbeat]);

  const continueHere = useCallback(async () => {
    if (active) await take(true);
  }, [active, take]);

  // While someone else, or this user's other tab, holds it: look again every 30 seconds, so
  // editing opens without a reload once the lock has gone (spec addendum §7.5). A null reload
  // means the activity itself is gone (deleted, or no longer visible).
  useEffect(() => {
    if (!active || (state.kind !== "other" && state.kind !== "elsewhere")) return;
    const t = setInterval(() => {
      void reload.current().then(
        (v) => {
          if (disposed.current) return;
          set(v ? lockStateOf(v.lock) : { kind: "gone" });
        },
        () => undefined,
      );
    }, POLL_MS);
    return () => clearInterval(t);
  }, [active, state.kind, set]);

  // Only the user's own input may keep the lock alive (C128): returning to the tab is not
  // input. On return, correct the state against the server's own clock without sending a
  // heartbeat — lapsed if its window has already passed, otherwise just re-armed for whatever
  // time is left, in case a background tab's own timer ran late or not at all.
  useEffect(() => {
    if (!active) return;
    const onVisible = () => {
      if (document.visibilityState !== "visible" || current.current.kind !== "mine") return;
      if (Date.now() - lastBeat.current >= IDLE_MS) set({ kind: "lapsed" });
      else armIdle();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [active, set, armIdle]);

  // This tab's own lock goes when the page does: leaving it, and closing or reloading the tab.
  useEffect(() => {
    if (!active) return;
    const release = () => {
      const k = current.current.kind;
      if (k !== "mine" && k !== "lapsed") return;
      // Always fires at once — the page may be gone before any microtask after this handler
      // runs. A heartbeat still in flight gets a second, idempotent release once it settles, in
      // case its PUT reaches the server after this one and re-takes the lock (locks.ts:48-51).
      const fire = () => void activityApi.release(id!, tabId).catch(() => undefined);
      fire();
      if (pendingBeat.current) void pendingBeat.current.catch(() => undefined).then(fire);
      set({ kind: "none" });
    };
    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("pagehide", release);
      if (idle.current) clearTimeout(idle.current);
      release();
    };
  }, [active, id, tabId, set]);

  return { tabId, state, problem, touch, continueHere, refused };
}
