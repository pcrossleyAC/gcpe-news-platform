import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useBlocker, type Blocker } from "react-router";
import { useAnnouncer } from "../../shared/Announcer";

export interface DirtySectionInfo {
  /** The exact text of this section's button in the sticky save bar (e.g. "Save English
   * content (Document 1)") — the bar's own copy, which may need to disambiguate (e.g. which
   * document) in a way that section's own inline Save button, seen in context, doesn't have to. */
  label: string;
  /** Calls straight through to this section's own save — same request, same 409/422 handling
   * (useReleaseSection) — the sticky bar never duplicates that logic, only triggers it. */
  save(): unknown;
}

/** One section with unsaved edits that's also offered the sticky save bar a label/save
 * callback — what the bar actually renders a button from. */
export interface DirtySection extends DirtySectionInfo {
  key: string;
}

type DirtyRegistration = (key: string, dirty: boolean, info?: DirtySectionInfo) => void;

const DirtyContext = createContext<DirtyRegistration>(() => {});

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
  const save = useCallback(() => infoRef.current?.save(), []);
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
   * sticky save bar (ReleaseEditorPage) renders one button per entry. A section that's merely
   * dirty for navigation-blocking purposes (e.g. ActionsSection's open scheduler) but registered
   * no `info` is counted in `anyDirty` but never appears here. */
  dirtySections: DirtySection[];
  /** react-router v7's blocker: `state === "blocked"` means an in-app navigation is paused —
   * render a confirmation UI that calls `blocker.proceed()` or `blocker.reset()`. */
  blocker: Blocker;
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

  const register = useCallback<DirtyRegistration>((key, dirty, info) => {
    if (dirty) registry.current.set(key, info);
    else registry.current.delete(key);
    setAnyDirty(registry.current.size > 0);
    setDirtySections(
      [...registry.current.entries()]
        .filter((entry): entry is [string, DirtySectionInfo] => entry[1] !== undefined)
        .map(([k, i]) => ({ key: k, label: i.label, save: i.save })),
    );
  }, []);

  const blocker = useBlocker(anyDirty);

  useEffect(() => {
    if (!anyDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [anyDirty]);

  useEffect(() => {
    if (anyDirty && !announcedRef.current) {
      announcedRef.current = true;
      announce("You have unsaved changes");
    } else if (!anyDirty) {
      announcedRef.current = false;
    }
  }, [anyDirty, announce]);

  const Provider = useMemo(
    () =>
      function DirtyProvider({ children }: { children: ReactNode }) {
        return <DirtyContext.Provider value={register}>{children}</DirtyContext.Provider>;
      },
    [register],
  );

  return { Provider, anyDirty, dirtySections, blocker };
}
