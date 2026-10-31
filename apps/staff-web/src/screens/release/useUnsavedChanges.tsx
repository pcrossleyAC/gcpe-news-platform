import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Blocker } from "react-router";
import { useAnnouncer } from "../../shared/Announcer";
import { useLeaveBlocker } from "../../shared/LeaveGuard";

export interface DirtySectionInfo {
  /** "Save " plus what the page calls this section (e.g. "Save English content (Document 1)",
   * "Save page details") — the bar and the "save first" blockers name the section by the words
   * after "Save ". It disambiguates (which document) since the bar lists every section. */
  label: string;
  /** This section's own save — its request, its 409/422 handling and messages (useReleaseSection)
   * — resolving true once saved, false if it wasn't (the section shows why). The page's one Save
   * ({@link UnsavedChangesGuard.saveAll}) only calls it, never duplicates it. */
  save(): Promise<boolean>;
}

/** One section with unsaved edits that's also offered the sticky save bar a label/save
 * callback — what the bar actually renders a button from. */
export interface DirtySection extends DirtySectionInfo {
  key: string;
}

type DirtyRegistration = (key: string, dirty: boolean, info?: DirtySectionInfo) => void;

const DirtyContext = createContext<DirtyRegistration>(() => {});
const DirtyKeysContext = createContext<ReadonlySet<string>>(new Set());
const SaveAllContext = createContext<() => void>(() => {});

/** The keys of every section with unsaved edits right now (for "Unsaved" markers). */
export function useDirtyKeys(): ReadonlySet<string> {
  return useContext(DirtyKeysContext);
}

/** The page's one Save, for a section form's own submit (Enter in a field) and Ctrl/⌘+S. */
export function useSaveAll(): () => void {
  return useContext(SaveAllContext);
}

/** Where a section comes in the page's one Save: page order (documents first, Publish settings
 * last), so a failure report reads top to bottom. Each section saves to its own endpoint with
 * the release's version; none depends on another having saved first. */
function saveRank(key: string): number {
  if (key.startsWith("document-")) return 0;
  const rank: Record<string, number> = { "page-details": 1, categories: 2, asset: 3, settings: 4 };
  return rank[key] ?? 5;
}

/** Where the page's one Save is up to. `failed` is the section that stopped it (it shows its own
 * message); `notSaved` are the ones after it that were never sent and still hold their edits. */
export interface SaveAllState {
  status: "idle" | "saving" | "saved" | "failed";
  failed?: { key: string; label: string };
  notSaved?: { key: string; label: string }[];
}

/** How long "All changes saved" stays in the bar after the page's one Save. */
export const SAVED_NOTE_MS = 4_000;

/**
 * Called by a section whenever its own "has this section got unsaved edits" flag changes —
 * registers/unregisters that section's key with the page's {@link useUnsavedChangesGuard}
 * aggregator. Unregisters automatically on unmount, so a section that saves (or is replaced by
 * a 409 reload) never leaves a stale dirty flag behind.
 *
 * `info` (optional — e.g. `useRegisterDirty(key, dirty, { label, save })`) additionally offers
 * this section up to the sticky save bar (ReleaseEditorPage). The `save` given here is captured
 * via a ref and kept fresh on every render (so a bar click always saves the section's *current*
 * field values, never a stale closure) without re-running the registration effect on every
 * keystroke — that effect only re-fires when `dirty` or the label text itself changes, which
 * matters for the guard's one-time "just appeared" announcement below.
 */
export function useRegisterDirty(key: string, dirty: boolean, info?: DirtySectionInfo): void {
  const register = useContext(DirtyContext);
  const infoRef = useRef(info);
  infoRef.current = info;
  const save = useCallback(() => infoRef.current?.save() ?? Promise.resolve(false), []);
  const label = info?.label;

  useEffect(() => {
    register(key, dirty, label !== undefined ? { label, save } : undefined);
    return () => register(key, false);
  }, [key, dirty, label, register, save]);
}

export interface UnsavedChangesGuard {
  /** Wraps the page's sections — {@link useRegisterDirty} calls inside them reach this guard. */
  Provider: (props: { children: ReactNode }) => React.JSX.Element;
  anyDirty: boolean;
  /** Every currently-dirty section that registered a label/save, in registration order — the
   * sticky save bar (ReleaseEditorPage) names each, and the page's one Save saves each. A section that's merely
   * dirty for navigation-blocking purposes (e.g. ActionsSection's open scheduler) but registered
   * no `info` is counted in `anyDirty` but never appears here. */
  dirtySections: DirtySection[];
  /** react-router v7's blocker: `state === "blocked"` means an in-app navigation is paused —
   * render a confirmation UI that calls `blocker.proceed()` or `blocker.reset()`. */
  blocker: Blocker;
  /** The page's one Save: saves every dirty section, one at a time in page order, each sent only
   * once the one before it has saved (and the page has re-rendered with what it returned). Stops
   * at the first section that doesn't save — that section shows why; the ones after it are not
   * sent and keep their edits — so nothing is lost or overwritten silently. Announces "Saved"
   * once when everything saved. A second call while one is running does nothing. */
  saveAll(): Promise<void>;
  saveState: SaveAllState;
  /** Every dirty section's key — give it to {@link DirtyKeysProvider} for "Unsaved" markers. */
  dirtyKeys: ReadonlySet<string>;
}

/** Makes {@link useDirtyKeys} work below it. Separate from the guard's Provider so that one keeps
 * its identity (and its subtree its state) as sections become dirty and clean. */
export function DirtyKeysProvider({ keys, children }: { keys: ReadonlySet<string>; children: ReactNode }): React.JSX.Element {
  return <DirtyKeysContext.Provider value={keys}>{children}</DirtyKeysContext.Provider>;
}

/**
 * Aggregates every section's dirty flag (via {@link useRegisterDirty}) and guards navigation
 * away from the release editor while any section has unsaved edits: react-router's `useBlocker`
 * for in-app navigation (the caller renders a confirmation UI off `blocker.state`), and
 * `beforeunload` for closing/reloading the tab itself. Also feeds the sticky save bar
 * (`dirtySections`) and announces it once, the moment it first appears (never on every
 * keystroke after that — constraints.md: no live-region spam).
 */
export function useUnsavedChangesGuard(): UnsavedChangesGuard {
  const registry = useRef(new Map<string, DirtySectionInfo | undefined>());
  const [anyDirty, setAnyDirty] = useState(false);
  const [dirtySections, setDirtySections] = useState<DirtySection[]>([]);
  const { announce } = useAnnouncer();
  const announcedRef = useRef(false);
  const [dirtyKeys, setDirtyKeys] = useState<ReadonlySet<string>>(new Set());
  const [saveState, setSaveState] = useState<SaveAllState>({ status: "idle" });
  const saving = useRef(false);

  const register = useCallback<DirtyRegistration>((key, dirty, info) => {
    if (dirty) registry.current.set(key, info);
    else registry.current.delete(key);
    setAnyDirty(registry.current.size > 0);
    setDirtyKeys(new Set(registry.current.keys()));
    setDirtySections(
      [...registry.current.entries()]
        .filter((entry): entry is [string, DirtySectionInfo] => entry[1] !== undefined)
        .map(([k, i]) => ({ key: k, label: i.label, save: i.save })),
    );
  }, []);

  // The Hub's shared leave-page rule (shared/LeaveGuard.tsx). Only a document's changes are kept
  // through a sign-in (documents/unsavedDocumentStorage.ts), so the release says it keeps a draft
  // only when nothing else is unsaved.
  const blocker = useLeaveBlocker(anyDirty, { keepsDraft: [...dirtyKeys].every((k) => k.startsWith("document-")) });

  useEffect(() => {
    if (anyDirty && !announcedRef.current) {
      announcedRef.current = true;
      announce("You have unsaved changes");
    } else if (!anyDirty) {
      announcedRef.current = false;
    }
  }, [anyDirty, announce]);

  // Resolves after the next commit: a section's save callback (and its `staleVersion`) comes
  // from its latest render, so the next section is saved only once the page has re-rendered with
  // the view the previous save returned.
  const [, setTick] = useState(0);
  const commitWaiters = useRef<(() => void)[]>([]);
  useEffect(() => {
    if (commitWaiters.current.length === 0) return;
    const waiting = commitWaiters.current;
    commitWaiters.current = [];
    waiting.forEach((resolve) => resolve());
  });
  const nextCommit = useCallback(
    () =>
      new Promise<void>((resolve) => {
        commitWaiters.current.push(resolve);
        setTick((t) => t + 1);
      }),
    [],
  );

  const saveAll = useCallback(async () => {
    if (saving.current) return;
    const order = [...registry.current.entries()]
      .filter((entry): entry is [string, DirtySectionInfo] => entry[1] !== undefined)
      .map(([key, info], index) => ({ key, label: info.label, index }))
      .sort((a, b) => saveRank(a.key) - saveRank(b.key) || a.index - b.index);
    if (order.length === 0) return;
    saving.current = true;
    setSaveState({ status: "saving" });
    try {
      for (const [i, { key }] of order.entries()) {
        const info = registry.current.get(key);
        if (!info) continue; // no longer has anything to save
        let ok = false;
        try {
          ok = (await info.save()) === true;
        } catch {
          ok = false;
        }
        await nextCommit();
        if (!ok) {
          const notSaved = order
            .slice(i + 1)
            .filter((s) => registry.current.get(s.key))
            .map(({ key: k, label }) => ({ key: k, label }));
          setSaveState({ status: "failed", failed: { key, label: info.label }, notSaved });
          return;
        }
      }
      setSaveState({ status: "saved" });
      announce("Saved");
    } finally {
      saving.current = false;
    }
  }, [announce, nextCommit]);

  // "All changes saved" shows for a moment, then the bar goes.
  useEffect(() => {
    if (saveState.status !== "saved") return;
    const timer = setTimeout(() => setSaveState({ status: "idle" }), SAVED_NOTE_MS);
    return () => clearTimeout(timer);
  }, [saveState]);

  const saveAllRef = useRef(saveAll);
  saveAllRef.current = saveAll;
  const requestSaveAll = useCallback(() => void saveAllRef.current(), []);

  const Provider = useMemo(
    () =>
      function DirtyProvider({ children }: { children: ReactNode }) {
        return (
          <DirtyContext.Provider value={register}>
            <SaveAllContext.Provider value={requestSaveAll}>{children}</SaveAllContext.Provider>
          </DirtyContext.Provider>
        );
      },
    [register, requestSaveAll],
  );

  return { Provider, anyDirty, dirtySections, blocker, saveAll, saveState, dirtyKeys };
}
