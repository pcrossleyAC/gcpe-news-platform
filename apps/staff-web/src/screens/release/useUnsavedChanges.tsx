import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useBlocker, type Blocker } from "react-router";

type DirtyRegistration = (key: string, dirty: boolean) => void;

const DirtyContext = createContext<DirtyRegistration>(() => {});

/**
 * Called by a section whenever its own "has this section got unsaved edits" flag changes —
 * registers/unregisters that section's key with the page's {@link useUnsavedChangesGuard}
 * aggregator. Unregisters automatically on unmount, so a section that saves (or is replaced by
 * a 409 reload) never leaves a stale dirty flag behind.
 */
export function useRegisterDirty(key: string, dirty: boolean): void {
  const register = useContext(DirtyContext);
  useEffect(() => {
    register(key, dirty);
    return () => register(key, false);
  }, [key, dirty, register]);
}

export interface UnsavedChangesGuard {
  /** Wraps the page's sections — {@link useRegisterDirty} calls inside them reach this guard. */
  Provider: (props: { children: ReactNode }) => React.JSX.Element;
  anyDirty: boolean;
  /** react-router v7's blocker: `state === "blocked"` means an in-app navigation is paused —
   * render a confirmation UI that calls `blocker.proceed()` or `blocker.reset()`. */
  blocker: Blocker;
}

/**
 * Aggregates every section's dirty flag (via {@link useRegisterDirty}) and guards navigation
 * away from the release editor while any section has unsaved edits: react-router's `useBlocker`
 * for in-app navigation (the caller renders a confirmation UI off `blocker.state`), and
 * `beforeunload` for closing/reloading the tab itself.
 */
export function useUnsavedChangesGuard(): UnsavedChangesGuard {
  const dirtyKeys = useRef(new Set<string>());
  const [anyDirty, setAnyDirty] = useState(false);

  const register = useCallback<DirtyRegistration>((key, dirty) => {
    if (dirty) dirtyKeys.current.add(key);
    else dirtyKeys.current.delete(key);
    setAnyDirty(dirtyKeys.current.size > 0);
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

  const Provider = useMemo(
    () =>
      function DirtyProvider({ children }: { children: ReactNode }) {
        return <DirtyContext.Provider value={register}>{children}</DirtyContext.Provider>;
      },
    [register],
  );

  return { Provider, anyDirty, blocker };
}
