import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { UNSAFE_DataRouterContext, useBlocker, type Blocker } from "react-router";
import { AlertDialog, Button, Modal } from "@bcgov/design-system-react-components";

/**
 * The Hub's one "You have unsaved changes" rule (suite review H2/W9, owner 2026-10-31), first
 * built for the release editor and the Calendar activity: while a screen has unsaved changes,
 * leaving it through the side menu, a link or the browser's Back asks first (a dialog: Stay /
 * Leave), and closing or reloading the tab gets the browser's own prompt.
 *
 * A screen says it has unsaved changes with one line, `<LeavePageGuard dirty={…} />`. The release
 * editor and the Calendar activity, which have their own dialog wording and drafts to forget on
 * Leave, use the two halves ({@link useLeaveBlocker} and {@link LeavePageDialog}) directly.
 *
 * A screen has at most one guard: react-router honours only one blocker at a time, so a screen
 * with several forms passes their combined "anything unsaved" to one guard.
 *
 * Every guard on screen also reports to the shell's {@link UnsavedChangesProvider} (when there is
 * one: a screen tested on its own has none), so **Sign out** can ask first and a session that ends
 * doesn't take the screen away while it holds unsaved changes (H1).
 */

export const LEAVE_MESSAGE = "You have unsaved changes on this page. Leave anyway and discard them?";

interface Registration {
  /** The screen keeps its unsaved changes on this computer when the session ends, and gives them
   * back after the same person signs in again (the release documents, the Calendar activity). */
  keepsDraft: boolean;
}

interface UnsavedChangesValue {
  /** Some screen on show has unsaved changes. */
  anyDirty: boolean;
  /** Every screen with unsaved changes keeps them through a sign-in (see {@link Registration}). */
  allKeepDrafts: boolean;
  register(id: string, registration: Registration | null): void;
  /** Runs `go` (a navigation) without any guard asking: the caller has already asked, or there's no
   * session left to save with. */
  leaveWithoutAsking(go: () => void): void;
  bypass: MutableRefObject<boolean>;
}

const UnsavedChangesContext = createContext<UnsavedChangesValue | null>(null);

/** What the shell knows about unsaved changes on screen; null outside the shell (a screen's own test). */
export function useUnsavedChangesState(): UnsavedChangesValue | null {
  return useContext(UnsavedChangesContext);
}

/** Wraps the signed-in shell (RequireAuth): every {@link useLeaveBlocker} below reports to it. */
export function UnsavedChangesProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const registry = useRef(new Map<string, Registration>());
  const [summary, setSummary] = useState({ anyDirty: false, allKeepDrafts: false });
  const bypass = useRef(false);

  const register = useCallback((id: string, registration: Registration | null) => {
    if (registration) registry.current.set(id, registration);
    else registry.current.delete(id);
    const all = [...registry.current.values()];
    const next = { anyDirty: all.length > 0, allKeepDrafts: all.length > 0 && all.every((r) => r.keepsDraft) };
    setSummary((s) => (s.anyDirty === next.anyDirty && s.allKeepDrafts === next.allKeepDrafts ? s : next));
  }, []);

  const leaveWithoutAsking = useCallback((go: () => void) => {
    bypass.current = true;
    try {
      go();
    } finally {
      // The blocker is consulted synchronously as the navigation starts; after that, guards ask again.
      setTimeout(() => {
        bypass.current = false;
      }, 0);
    }
  }, []);

  const value = useMemo<UnsavedChangesValue>(
    () => ({ ...summary, register, leaveWithoutAsking, bypass }),
    [summary, register, leaveWithoutAsking],
  );
  return <UnsavedChangesContext.Provider value={value}>{children}</UnsavedChangesContext.Provider>;
}

const IDLE_BLOCKER: Blocker = { state: "unblocked", proceed: undefined, reset: undefined, location: undefined };

export interface LeaveBlockerOptions {
  /** See {@link Registration.keepsDraft}. */
  keepsDraft?: boolean;
  /** True while the screen itself is navigating away on purpose (after a save or a delete). */
  leaving?: MutableRefObject<boolean>;
  /** The screen's own up-to-the-moment answer, when it knows before React re-renders (a save that
   * has just finished and navigates at once). Defaults to the last rendered `dirty`. */
  isDirty?: () => boolean;
}

/**
 * Blocks leaving the screen while `dirty`: react-router's blocker for in-app navigation (render
 * {@link LeavePageDialog} with it), `beforeunload` for closing or reloading the tab. A navigation
 * that stays on the same address (only its state or #anchor changes) isn't leaving, so it never asks.
 */
export function useLeaveBlocker(dirty: boolean, options: LeaveBlockerOptions = {}): Blocker {
  const shell = useUnsavedChangesState();
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const leaving = options.leaving;
  const isDirtyRef = useRef(options.isDirty);
  isDirtyRef.current = options.isDirty;
  const bypass = shell?.bypass;
  // The Hub always runs under a data router (createBrowserRouter), which blocking needs. A screen's
  // own test may mount it under a plain <MemoryRouter>: there, in-app navigation simply isn't
  // guarded. Whether there is a data router never changes for a mounted screen, so the hook order
  // is stable.
  const inDataRouter = useContext(UNSAFE_DataRouterContext) !== null;
  const blocker = inDataRouter
    ? // eslint-disable-next-line react-hooks/rules-of-hooks
      useBlocker(
        ({ currentLocation, nextLocation }) =>
          (isDirtyRef.current ? isDirtyRef.current() : dirtyRef.current) &&
          !leaving?.current &&
          !bypass?.current &&
          (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search),
      )
    : IDLE_BLOCKER;

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const id = useId();
  const register = shell?.register;
  const keepsDraft = options.keepsDraft === true;
  useEffect(() => {
    if (!register) return;
    register(id, dirty ? { keepsDraft } : null);
    return () => register(id, null);
  }, [register, id, dirty, keepsDraft]);

  return blocker;
}

/** The leave-page question, while `blocker` holds a navigation. Escape or closing is Stay. */
export function LeavePageDialog({
  blocker,
  message = LEAVE_MESSAGE,
  onLeave,
  plainDialog = false,
}: {
  blocker: Blocker;
  /** The release editor's dialog has always been announced as a plain dialog; every other
   * screen's is an alert dialog, as the Calendar activity's was. */
  plainDialog?: boolean;
  message?: string;
  /** Before the navigation goes ahead: what Leave throws away besides the screen (a kept draft). */
  onLeave?: () => void;
}): React.JSX.Element {
  return (
    <Modal isOpen={blocker.state === "blocked"} onOpenChange={(open) => { if (!open) blocker.reset?.(); }} isDismissable>
      <AlertDialog
        {...(plainDialog ? {} : { role: "alertdialog", "aria-label": "Unsaved changes" })}
        variant="warning"
        title="Unsaved changes"
        buttons={
          <>
            <Button onPress={() => blocker.reset?.()}>Stay</Button>
            <Button
              danger
              onPress={() => {
                onLeave?.();
                blocker.proceed?.();
              }}
            >
              Leave
            </Button>
          </>
        }
      >
        <p>{message}</p>
      </AlertDialog>
    </Modal>
  );
}

/** One line per edit screen: asks before leaving while `dirty`. Renders nothing until it asks.
 * `leaving` is for a screen that goes somewhere itself once its work is saved (see
 * {@link LeaveBlockerOptions.leaving}). */
export function LeavePageGuard({
  dirty,
  message,
  onLeave,
  leaving,
}: {
  dirty: boolean;
  message?: string;
  onLeave?: () => void;
  leaving?: MutableRefObject<boolean>;
}): React.JSX.Element {
  const blocker = useLeaveBlocker(dirty, { leaving });
  return <LeavePageDialog blocker={blocker} message={message} onLeave={onLeave} />;
}

export type ReportDirty = (key: string, dirty: boolean) => void;

/** For a screen whose unsaved changes sit in several parts (cards, rows, panels): each part
 * reports with {@link useReportDirty}, and the screen's one guard asks while any part is dirty. */
export function useDirtyParts(): { anyDirty: boolean; report: ReportDirty } {
  const parts = useRef(new Set<string>());
  const [anyDirty, setAnyDirty] = useState(false);
  const report = useCallback<ReportDirty>((key, dirty) => {
    if (dirty) parts.current.add(key);
    else parts.current.delete(key);
    setAnyDirty(parts.current.size > 0);
  }, []);
  return { anyDirty, report };
}

/** One part's share of {@link useDirtyParts}; it stops counting when the part goes away. */
export function useReportDirty(report: ReportDirty | undefined, key: string, dirty: boolean): void {
  useEffect(() => {
    if (!report) return;
    report(key, dirty);
    return () => report(key, false);
  }, [report, key, dirty]);
}
