import { useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation, useNavigate, type Location } from "react-router";
import { AlertDialog, Button, Modal } from "@bcgov/design-system-react-components";
import { reportUnauthorized } from "../api/client";
import { UnsavedChangesProvider, useUnsavedChangesState } from "../shared/LeaveGuard";
import { useSession } from "./SessionContext";

/** The sign-in page, carrying where the user is now so sign-in can send them straight back. */
export function signInPath(location: Pick<Location, "pathname" | "search">): string {
  return `/sign-in?return=${encodeURIComponent(`${location.pathname}${location.search}`)}`;
}

/**
 * Wraps the authenticated shell: while signed out (never signed in, or signed out), redirects to
 * /hub/sign-in, carrying the current path+search as `return` so sign-in can send them straight
 * back (constraints.md Review Focus 1 — a session expiring mid-edit still returns the user to the
 * same place once they sign in again).
 *
 * Suite review H1 (owner 2026-10-31): when the session *ends* (a 401 after signing in), a screen
 * with unsaved changes isn't taken away: it stays, and a dialog explains and offers Sign in again
 * (the shell also keeps a notice up). With nothing unsaved, it goes to sign-in at once, which
 * says why.
 */
export function RequireAuth({ children }: { children: ReactNode }): React.JSX.Element | null {
  const { user, loading } = useSession();
  const location = useLocation();

  if (loading) return null;
  if (!user) return <Navigate to={signInPath(location)} replace />;
  return (
    <UnsavedChangesProvider>
      <SessionEndedGate>{children}</SessionEndedGate>
    </UnsavedChangesProvider>
  );
}

/** Sign in again after the session ended, coming back to this screen. */
export function useSignInAgain(): () => void {
  const unsaved = useUnsavedChangesState();
  const navigate = useNavigate();
  const location = useLocation();
  return () => {
    // Screens that keep unsaved changes through a sign-in (release documents, the Calendar
    // activity) keep them as they are now, not as they were when the session ended.
    reportUnauthorized(false);
    const go = () => void navigate(signInPath(location), { replace: true });
    if (unsaved) unsaved.leaveWithoutAsking(go);
    else go();
  };
}

function SessionEndedGate({ children }: { children: ReactNode }): React.JSX.Element {
  const { ended, endedCount } = useSession();
  const unsaved = useUnsavedChangesState();
  const location = useLocation();
  const signInAgain = useSignInAgain();
  // Explained again on each new refusal (fix round 1, I1: a Save that can't go through, including
  // the Calendar's, which say nothing of their own); the shell's notice stays after "Stay on this page".
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    setSeen(false);
  }, [ended, endedCount]);

  if (ended && !unsaved?.anyDirty) return <Navigate to={signInPath(location)} replace />;
  return (
    <>
      {children}
      <Modal isOpen={ended && !seen} onOpenChange={(open) => { if (!open) setSeen(true); }} isDismissable>
        <AlertDialog
          role="alertdialog"
          aria-label="Your session has ended"
          variant="warning"
          title="Your session has ended"
          buttons={
            <>
              <Button variant="secondary" onPress={() => setSeen(true)}>
                Stay on this page
              </Button>
              <Button onPress={signInAgain}>Sign in again</Button>
            </>
          }
        >
          <p>
            You were signed out, so the changes on this page can&rsquo;t be saved until you sign in again. This happens when you sign out in another tab or window,
            when your computer has been asleep or offline for a while, or when an administrator changes your account. Sessions last 12 hours.
          </p>
          <p>
            {unsaved?.allKeepDrafts
              ? "Your unsaved changes are kept on this computer and come back after you sign in again."
              : "Unsaved changes on this page are lost when you sign in again here, so copy anything you need first."}
          </p>
          <p>If you sign in again in another tab, come back to this one and you can save as usual.</p>
        </AlertDialog>
      </Modal>
    </>
  );
}
