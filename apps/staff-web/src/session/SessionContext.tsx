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
}

export interface SessionValue {
  user: SessionUser | null;
  roles: string[];
  loading: boolean;
  has(role: string): boolean;
  signIn(username: string, password: string): Promise<void>;
  signOut(): Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

/** Renewal happens server-side (GET /core/auth/session re-issues the cookie near expiry); this
 * is just how often the staff app checks in while the tab is visible (task-1-brief.md). */
const RENEW_INTERVAL_MS = 10 * 60_000;

interface LoginResponse {
  user: SessionUser;
  expiresAt: string;
}

export function SessionProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, setState] = useState<SessionState>({ user: null, loading: true });

  const loadSession = useCallback(async () => {
    try {
      const { user } = await apiFetch<LoginResponse>("/core/auth/session");
      setState((s) => ({ ...s, user, loading: false }));
    } catch {
      setState((s) => ({ ...s, user: null, loading: false }));
    }
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  // Coming back to the tab (a laptop waking, say) checks in at once rather than at the next
  // interval, so an expired session is found before the user types into a page that can no
  // longer save. A 401 signs them out through apiFetch's own listener (below); any other failure,
  // a network still waking up, changes nothing.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      apiFetch<LoginResponse>("/core/auth/session").then(
        ({ user }) => setState((s) => ({ ...s, user, loading: false })),
        () => undefined,
      );
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void loadSession();
    }, RENEW_INTERVAL_MS);
    return () => clearInterval(id);
  }, [loadSession]);

  // Any apiFetch 401, anywhere in the app, signs the user out here. Where they were — and
  // getting back there after they sign in again — is RequireAuth's job alone, via the
  // /hub/sign-in?return=<path> it redirects to (constraints.md Review Focus 1): this context
  // doesn't duplicate that as its own state.
  useEffect(() => onUnauthorized(() => setState((s) => ({ ...s, user: null }))), []);

  const signIn = useCallback(async (username: string, password: string) => {
    const { user } = await apiFetch<LoginResponse>("/core/auth/login", { method: "POST", body: { username, password } });
    setState((s) => ({ ...s, user, loading: false }));
  }, []);

  const signOut = useCallback(async () => {
    try {
      await apiFetch("/core/auth/logout", { method: "POST" });
    } finally {
      setState((s) => ({ ...s, user: null }));
      // Fix round 1 (3f Task 4), finding 1: an *explicit* sign-out wipes every unsaved document
      // draft (documents/unsavedDocumentStorage.ts) — unlike a 401 (handled by the
      // onUnauthorized listener below, which deliberately leaves drafts alone so the same user
      // signing back in gets theirs back), there's no guarantee the next sign-in on this shared
      // tab/machine is the same person.
      clearAllDrafts();
      clearAllActivityDrafts();
    }
  }, []);

  const value = useMemo<SessionValue>(
    () => ({
      user: state.user,
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

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within a SessionProvider");
  return ctx;
}
