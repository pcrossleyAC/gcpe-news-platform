import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActivityView } from "@gcpe/calendar-contract";
import { ApiError } from "../../../api/client";
import { activityApi } from "./api";

export const HEARTBEAT_MS = 60_000;
export const IDLE_MS = 15 * 60_000;
export const POLL_MS = 30_000;

export type LockState =
  | { kind: "none" }
  | { kind: "mine" }
  | { kind: "elsewhere" }
  | { kind: "other"; holderName: string; since: string }
  | { kind: "lapsed" };

/** A page that has just opened holds no lock of its own: one that is "mine" belongs to another tab. */
export function lockStateOf(lock: ActivityView["lock"]): LockState {
  if (!lock) return { kind: "none" };
  return lock.mine ? { kind: "elsewhere" } : { kind: "other", holderName: lock.holderName, since: lock.since };
}

export interface EditLock {
  tabId: string;
  state: LockState;
  /** A refusal that isn't a lock: the freeze, or the server out of reach. */
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
  const reload = useRef(o.reload);
  reload.current = o.reload;
  const id = o.activityId;
  const active = o.enabled && id !== null;

  const refused = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 423) {
      const body = e.body as { code?: string; holder?: { displayName: string; since: string } | null } | undefined;
      if (body?.code === "locked" && body.holder) set({ kind: "other", holderName: body.holder.displayName, since: body.holder.since });
      else if (body?.code === "locked_elsewhere") set({ kind: "elsewhere" });
      else setProblem(e.message);
    } else if (e instanceof ApiError && e.status === 404) {
      setProblem("This activity is no longer available to you.");
    } else {
      setProblem("Couldn't reach the server to start editing. Try again.");
    }
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
      lastBeat.current = Date.now();
      setProblem(null);
      set({ kind: "mine" });
      armIdle();
      return true;
    } catch (e) {
      refused(e);
      return false;
    }
  }, [id, tabId, set, armIdle, refused]);

  const touch = useCallback(async (): Promise<boolean> => {
    if (!active) return true;
    const s = current.current;
    if (s.kind === "other" || s.kind === "elsewhere") return false;
    if (s.kind !== "mine") return take(false);
    armIdle();
    if (Date.now() - lastBeat.current >= HEARTBEAT_MS) {
      lastBeat.current = Date.now();
      void activityApi.lock(id!, tabId).catch(refused);
    }
    return true;
  }, [active, id, tabId, take, armIdle, refused]);

  const continueHere = useCallback(async () => {
    if (active) await take(true);
  }, [active, take]);

  // While someone else, or this user's other tab, holds it: look again every 30 seconds, so
  // editing opens without a reload once the lock has gone (spec addendum §7.5).
  useEffect(() => {
    if (!active || (state.kind !== "other" && state.kind !== "elsewhere")) return;
    const t = setInterval(() => {
      void reload.current().then(
        (v) => {
          if (v) set(lockStateOf(v.lock));
        },
        () => undefined,
      );
    }, POLL_MS);
    return () => clearInterval(t);
  }, [active, state.kind, set]);

  // This tab's own lock goes when the page does: leaving it, and closing or reloading the tab.
  useEffect(() => {
    if (!active) return;
    const release = () => {
      const k = current.current.kind;
      if (k !== "mine" && k !== "lapsed") return;
      void activityApi.release(id!, tabId).catch(() => undefined);
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
