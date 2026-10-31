import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiFetch, onUnauthorized } from "../api/client";
import { clearAllActivityDrafts } from "../screens/calendar/activity/draft";
import { clearAllDrafts } from "../screens/release/documents/unsavedDocumentStorage";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  roles: string[];
}

interface SessionState {
  user: SessionUser | null;
  /** Still loading the initial GET /core/auth/session on first mount. */
  loading: boolean;
  /** The server stopped accepting this person's session (a 401) after they had signed in. */
  ended: boolean;
  /** How many 401s there have been since: each new one brings the explanation back. */
  endedCount: number;
}

export interface SessionValue {
  /** Who is signed in. Stays set after the session has {@link ended}, so the screen on show (which
   * may hold unsaved changes) keeps working as it was until they sign in again or leave it. */
  user: SessionUser | null;
  /** Suite review H1: the session ended (it ran out while the computer was asleep or offline, they
   * signed out in another tab, an administrator changed their account, 12 hours passed since
   * sign-in) and nothing can be saved
   * until they sign in again. RequireAuth and the shell explain it. A later check-in that finds
   * the session good again (signed in in another tab) clears it. */
  ended: boolean;
  /** Goes up with every 401 after sign-in (fix round 1, I1), so RequireAuth explains again each time. */
  endedCount: number;
  roles: string[];
  loading: boolean;
  has(role: string): boolean;
  signIn(username: string, password: string): Promise<void>;
  signOut(): Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

/** Renewal happens server-side (GET /core/auth/session re-issues the cookie in the last 15 of its
 * 60 minutes); this is how often the staff app checks in. Suite review H1 (owner 2026-10-31): it
 * checks in whether or not the tab is visible, so a Hub tab left open behind Outlook stays signed
 * in. Browsers slow a hidden tab's timers to about once a minute at most, which is well inside
 * this. Renewal stops 12 hours after sign-in (owner decision 2026-10-31, SESSION_MAX_HOURS): the
 * next check-in or request is then a 401, and the session-ended flow takes over. */
const RENEW_INTERVAL_MS = 10 * 60_000;

interface LoginResponse {
  user: SessionUser;
  expiresAt: string;
}

export function SessionProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, setState] = useState<SessionState>({ user: null, loading: true, ended: false, endedCount: 0 });

  const loadSession = useCallback(async () => {
    try {
      const { user } = await apiFetch<LoginResponse>("/core/auth/session");
      setState((s) => ({ ...s, user, loading: false, ended: false }));
    } catch {
      setState((s) => ({ ...s, user: null, loading: false, ended: false }));
    }
  }, []);

  /** A check-in once signed in. Only a 401 signs the user out, through apiFetch's own broadcast
   * (the onUnauthorized listener below), so a page with unsaved changes keeps them first. A network
   * failure or a 5xx changes nothing: the next check-in tries again. */
  const checkIn = useCallback(() => {
    apiFetch<LoginResponse>("/core/auth/session").then(
      // Fix round 1 (M2): someone else signing in in another tab doesn't take over a screen kept
      // from an ended session with the first person's typing on it: it stays ended.
      ({ user }) => setState((s) => (s.ended && s.user && s.user.id !== user.id ? s : { ...s, user, loading: false, ended: false })),
      () => undefined,
    );
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  // Coming back to the tab (a laptop waking, say) checks in at once rather than at the next
  // interval, so an expired session is found before the user types into a page that can no
  // longer save.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") checkIn();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [checkIn]);

  useEffect(() => {
    const id = setInterval(checkIn, RENEW_INTERVAL_MS);
    return () => clearInterval(id);
  }, [checkIn]);

  // Any apiFetch 401, anywhere in the app, ends the session here. Where they were — and getting
  // back there after they sign in again — is RequireAuth's job alone, via the
  // /hub/sign-in?return=<path> it redirects to (constraints.md Review Focus 1). The person isn't
  // forgotten (H1): a screen with unsaved changes stays as it was while RequireAuth explains.
  // Each refused save (not a background read, which would bring the dialog back every few
  // seconds on a polling screen) counts, so RequireAuth explains again (fix round 1, I1).
  useEffect(
    () => onUnauthorized((_returnTo, { byUser }) => setState((s) => (s.user ? { ...s, ended: true, endedCount: s.endedCount + (byUser || !s.ended ? 1 : 0) } : s))),
    [],
  );

  const signIn = useCallback(async (username: string, password: string) => {
    const { user } = await apiFetch<LoginResponse>("/core/auth/login", { method: "POST", body: { username, password } });
    setState((s) => ({ ...s, user, loading: false, ended: false }));
  }, []);

  const signOut = useCallback(async () => {
    try {
      await apiFetch("/core/auth/logout", { method: "POST" });
    } finally {
      setState((s) => ({ ...s, user: null, ended: false }));
      // An *explicit* sign-out wipes every unsaved document draft
      // (documents/unsavedDocumentStorage.ts) — unlike a 401 (handled by the onUnauthorized
      // listener below, which deliberately leaves drafts alone so the same user signing back in
      // gets theirs back), there's no guarantee the next sign-in on this shared tab/machine is
      // the same person.
      clearAllDrafts();
      clearAllActivityDrafts();
    }
  }, []);

  const value = useMemo<SessionValue>(
    () => ({
      user: state.user,
      ended: state.ended,
      endedCount: state.endedCount,
      roles: state.user?.roles ?? [],
      loading: state.loading,
      has: (role: string) => state.user?.roles.includes(role) ?? false,
      signIn,
      signOut,
    }),
    [state, signIn, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** The session when there is one, or null outside a SessionProvider: for shared hooks that only
 * adjust what they do by role and must keep working where no session is set up. */
export function useOptionalSession(): SessionValue | null {
  return useContext(SessionContext);
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within a SessionProvider");
  return ctx;
}
