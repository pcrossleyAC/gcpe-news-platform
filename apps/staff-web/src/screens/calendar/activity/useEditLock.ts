import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActivityView } from "@gcpe/calendar-contract";
import { ApiError } from "../../../api/client";
import { messagesOf } from "../../admin/messages";
import { activityApi } from "./api";

export const HEARTBEAT_MS = 60_000;
/** Also the server's own lock window (apps/calendar/src/activities/store.ts's LOCK_IDLE_MS):
 * the two are defined independently, in packages a browser bundle can't import from, but both
 * read 15 minutes. */
export const IDLE_MS = 15 * 60_000;
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
  const lastBeat = useRef(0);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The in-flight heartbeat, if any — a release chains after it, so a late PUT can never
   * re-take the lock after the release has gone out. */
  const pendingBeat = useRef<Promise<void> | null>(null);
  /** Set once, at the real unmount: a `take()` that resolves afterwards releases straight away
   * instead of touching state or arming a timer that would outlive the component. */
  const disposed = useRef(false);
  const reload = useRef(o.reload);
  reload.current = o.reload;
  const id = o.activityId;
  const active = o.enabled && id !== null;

  useEffect(() => () => {
    disposed.current = true;
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
    setProblem("Couldn't reach the server to start editing. Try again.");
  }, [set]);

  const armIdle = useCallback(() => {
    if (idle.current) clearTimeout(idle.current);
    idle.current = setTimeout(() => {
      if (current.current.kind === "mine") set({ kind: "lapsed" });
    }, IDLE_MS);
  }, [set]);

  const take = useCallback(async (takeOver: boolean): Promise<boolean> => {
    try {
      await activityApi.lock(id!, tabId, takeOver);
      if (disposed.current) {
        void activityApi.release(id!, tabId).catch(() => undefined);
        return false;
      }
      lastBeat.current = Date.now();
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

  /** Sends the heartbeat PUT, if one isn't already in flight. On success, moves the lapse clock
   * forward from this moment (the server's own `lastActiveAt`) and clears any stale problem. */
  const sendHeartbeat = useCallback(() => {
    if (pendingBeat.current) return;
    const p: Promise<void> = activityApi.lock(id!, tabId).then(
      () => {
        if (disposed.current) return;
        lastBeat.current = Date.now();
        setProblem(null);
        armIdle();
      },
      (e: unknown) => {
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

  // A backgrounded tab's timers can run late or not at all. On return, correct the state right
  // away instead of waiting for whatever the browser gets around to: lapsed if the server's
  // window has already passed since the last heartbeat it received, otherwise a fresh heartbeat
  // now rather than whenever the throttled timer next fires.
  useEffect(() => {
    if (!active) return;
    const onVisible = () => {
      if (document.visibilityState !== "visible" || current.current.kind !== "mine") return;
      if (Date.now() - lastBeat.current >= IDLE_MS) set({ kind: "lapsed" });
      else sendHeartbeat();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [active, set, sendHeartbeat]);

  // This tab's own lock goes when the page does: leaving it, and closing or reloading the tab.
  useEffect(() => {
    if (!active) return;
    const release = () => {
      const k = current.current.kind;
      if (k !== "mine" && k !== "lapsed") return;
      // A heartbeat still in flight must settle first: otherwise a PUT that reaches the server
      // after this release re-takes the lock for a page that has already left (locks.ts:48-51).
      // With nothing in flight, release fires in this same tick rather than after an extra
      // microtask, so a release right after a bare `touch()` reaches the server immediately.
      const fire = () => void activityApi.release(id!, tabId).catch(() => undefined);
      if (pendingBeat.current) void pendingBeat.current.catch(() => undefined).then(fire);
      else fire();
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
