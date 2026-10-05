import { useCallback, useState } from "react";
import { ApiError } from "../../api/client";

/** Same wording as release/useReleaseSection.ts's RELOAD_MESSAGE (constraints.md: one shared
 * copy of the 409 message) — re-exported here so every Website screen can import it from one
 * place without reaching into the release folder. */
export const RELOAD_MESSAGE = "Someone else changed this — reload to see their changes.";

export interface VersionedSaveState {
  saving: boolean;
  /** 422 problems (release shape's `problems`, or the Website section's own `errors` —
   * apiFetch normalises both into this one field; see api/client.ts). */
  problems: string[] | null;
  /** 409 — constraints.md: show the reload message, never retry automatically. */
  conflict: boolean;
  error: string | null;
}

export interface VersionedSave<T> extends VersionedSaveState {
  /** Runs `action` (an apiFetch call) under the shared saving/409/422/error state machine.
   * Returns the action's result on success, or `null` on any failure (the caller decides what
   * to do with its own local form state either way — this never touches it). */
  run(action: () => Promise<T>): Promise<T | null>;
  /** Clears problems/conflict/error without touching anything else. */
  clear(): void;
}

const INITIAL: VersionedSaveState = { saving: false, problems: null, conflict: false, error: null };

/**
 * The Website section's generalisation of release/useReleaseSection.ts's save/409/422 pattern
 * (task-5-brief.md's design note: "generalise ... into a small useVersionedSave helper"). Unlike
 * that hook, this one isn't tied to one release id/URL shape — every Website endpoint (carousels,
 * pins, live feed, Blue Bridge, links, files) has its own URL and payload, so the caller supplies
 * the whole `apiFetch` call as a thunk and this just wraps it with the shared state machine.
 */
export function useVersionedSave<T = unknown>(): VersionedSave<T> {
  const [state, setState] = useState<VersionedSaveState>(INITIAL);

  const run = useCallback(async (action: () => Promise<T>): Promise<T | null> => {
    setState({ saving: true, problems: null, conflict: false, error: null });
    try {
      const result = await action();
      setState(INITIAL);
      return result;
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        setState({ saving: false, problems: null, conflict: true, error: null });
      } else if (caught instanceof ApiError && caught.status === 422) {
        setState({ saving: false, problems: caught.problems ?? [caught.message], conflict: false, error: null });
      } else {
        setState({ saving: false, problems: null, conflict: false, error: caught instanceof ApiError ? caught.message : "Save failed." });
      }
      return null;
    }
  }, []);

  const clear = useCallback(() => setState(INITIAL), []);

  return { ...state, run, clear };
}
