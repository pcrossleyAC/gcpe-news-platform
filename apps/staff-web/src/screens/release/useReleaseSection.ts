import { useCallback, useRef, useState } from "react";
import type { ReleaseView } from "@gcpe/nrms-contract";
import { apiFetch, ApiError } from "../../api/client";
import { useAnnouncer } from "../../shared/Announcer";
import { useSaveQueue, withVersion } from "./saveQueue";

/** Fix round 1 (3f Task 3), minor 4: one shared copy of the 409 message, used by every section
 * (and the page-level unsaved-changes dialog) instead of each defining its own. Minors: the
 * literal itself lives in shared/reloadMessage.ts — this re-export keeps every existing
 * `from "../useReleaseSection"` import working unchanged. */
export { RELOAD_MESSAGE } from "../../shared/reloadMessage";

export interface ReleaseSectionState {
  /** True from the moment a save is requested until it (and any later save of this same
   * section) has settled — including the time spent waiting behind other sections' saves. */
  saving: boolean;
  /** True while this section's save is queued behind another save that hasn't settled yet
   * (saveQueue.tsx) — `saving` is also true then; the request itself hasn't been sent. */
  waiting: boolean;
  /** 422 `problems`, scoped to whatever this section just tried to save — the section is the
   * one place that knows which fields they're about (constraints.md: "422 problems are shown
   * next to the form"). */
  problems: string[] | null;
  /** 409 — constraints.md: show the reload message, never retry automatically. */
  conflict: boolean;
  error: string | null;
}

export interface ReleaseSection extends ReleaseSectionState {
  /**
   * `PUT`/`POST`s `/nrms/api/releases/<id><path>` with `body`, once every save queued before it
   * on this page has settled (saveQueue.tsx). `body.version`, if present, is replaced with the
   * latest version the page knows at the moment the request is actually sent — so a save
   * requested while another is still in flight sends the version that save returned. On success, replaces the whole
   * page's `view` with the response (every section's `version` field of the current release
   * stays current, not just this section's own slice) and returns it. On failure, `view` is
   * left untouched and the caller's own form state is never touched either way — only the
   * caller decides whether to keep or discard what the user typed.
   */
  save(path: string, body: unknown, method?: "PUT" | "POST"): Promise<ReleaseView | null>;
  /** Re-fetches the release, replaces the page's `view` with it, and returns it — the 409
   * "Reload" button. Returning the fresh value (not just `void`) lets a section re-seed its own
   * local form state from exactly what was reloaded, rather than reacting to `view` prop changes
   * (which would also fire — and wrongly clobber unsaved edits — whenever any *other* section's
   * save replaces the whole page's view). */
  reload(): Promise<ReleaseView>;
  /** Clears problems/conflict/error without touching anything else (e.g. once the user edits a
   * field again after a failed save). */
  clear(): void;
}

const INITIAL: ReleaseSectionState = { saving: false, waiting: false, problems: null, conflict: false, error: null };

/**
 * Shared save/409/422 behaviour for every release-editor section (task-3-brief.md's design
 * note): `save -> apiFetch -> setView(response) | 409 message | 422 problems`. Task 4's
 * Documents/Translations/History sections call this exact same hook.
 */
export function useReleaseSection(view: ReleaseView, setView: (v: ReleaseView) => void): ReleaseSection {
  const [state, setState] = useState<ReleaseSectionState>(INITIAL);
  const { announce } = useAnnouncer();
  const queue = useSaveQueue();
  const id = view.id;
  // This section's saves that haven't settled yet (queued or sent), and whether one of them is
  // the one being sent right now. Refs, not state: they're read together at whichever moment a
  // save starts or settles, and the queue may start the next save before this one's own
  // continuation runs — `busy()` gives the same answer in either order.
  const pending = useRef(0);
  const sending = useRef(false);
  const busy = useCallback(
    (): Pick<ReleaseSectionState, "saving" | "waiting"> => ({ saving: pending.current > 0, waiting: pending.current > 0 && !sending.current }),
    [],
  );

  const save = useCallback(
    async (path: string, body: unknown, method: "PUT" | "POST" = "PUT"): Promise<ReleaseView | null> => {
      pending.current += 1;
      setState({ ...busy(), problems: null, conflict: false, error: null });
      try {
        const next = await queue.run(async (version) => {
          sending.current = true;
          setState((s) => ({ ...s, ...busy() }));
          try {
            return await apiFetch<ReleaseView>(`/nrms/api/releases/${id}${path}`, { method, body: withVersion(body, version) });
          } finally {
            sending.current = false;
          }
        });
        pending.current -= 1;
        setView(next);
        setState({ ...INITIAL, ...busy() });
        // I4: one shared announcement for every section save, instead of each screen wiring
        // its own aria-live region.
        announce("Saved");
        return next;
      } catch (caught) {
        pending.current -= 1;
        // I2: a 409 is "someone else changed this — reload" (version_conflict) only when the
        // server says so; a ReleaseStateError is also a 409 but means "this action isn't
        // allowed right now" — reloading won't fix it, so it falls through to the generic
        // error branch below, which shows the server's own message instead of RELOAD_MESSAGE.
        // Queued saves always send the latest version this page has seen, so a version 409 here
        // is never one of our own saves overtaking another — someone else changed the release.
        if (caught instanceof ApiError && caught.status === 409 && caught.code !== "state") {
          setState({ ...busy(), problems: null, conflict: true, error: null });
        } else if (caught instanceof ApiError && caught.status === 422) {
          setState({ ...busy(), problems: caught.problems ?? [caught.message], conflict: false, error: null });
        } else {
          setState({ ...busy(), problems: null, conflict: false, error: caught instanceof ApiError ? caught.message : "Save failed." });
        }
        return null;
      }
    },
    [id, setView, announce, queue, busy],
  );

  const reload = useCallback(async (): Promise<ReleaseView> => {
    const fresh = await apiFetch<ReleaseView>(`/nrms/api/releases/${id}`);
    setView(fresh);
    setState({ ...INITIAL, ...busy() });
    return fresh;
  }, [id, setView, busy]);

  const clear = useCallback(() => setState({ ...INITIAL, ...busy() }), [busy]);

  return { ...state, save, reload, clear };
}
