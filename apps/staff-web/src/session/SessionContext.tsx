import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiFetch, onUnauthorized } from "../api/client";

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
  /** Where a 401 (or an expired session) interrupted the user — RequireAuth/SignIn use this to
   * send them back where they were once they sign in again (constraints.md Review Focus 1). */
  returnTo: string | null;
}

export interface SessionValue {
  user: SessionUser | null;
  roles: string[];
  loading: boolean;
  returnTo: string | null;
  has(role: string): boolean;
  signIn(username: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  clearReturnTo(): void;
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
  const [state, setState] = useState<SessionState>({ user: null, loading: true, returnTo: null });

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

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void loadSession();
    }, RENEW_INTERVAL_MS);
    return () => clearInterval(id);
  }, [loadSession]);

  // Any apiFetch 401, anywhere in the app, signs the user out here and remembers where they
  // were so RequireAuth can send them back after they sign in again.
  useEffect(() => onUnauthorized((returnTo) => setState((s) => ({ ...s, user: null, returnTo }))), []);

  const signIn = useCallback(async (username: string, password: string) => {
    const { user } = await apiFetch<LoginResponse>("/core/auth/login", { method: "POST", body: { username, password } });
    setState((s) => ({ ...s, user, loading: false }));
  }, []);

  const signOut = useCallback(async () => {
    try {
      await apiFetch("/core/auth/logout", { method: "POST" });
    } finally {
      setState((s) => ({ ...s, user: null }));
    }
  }, []);

  const clearReturnTo = useCallback(() => setState((s) => ({ ...s, returnTo: null })), []);

  const value = useMemo<SessionValue>(
    () => ({
      user: state.user,
      roles: state.user?.roles ?? [],
      loading: state.loading,
      returnTo: state.returnTo,
      has: (role: string) => state.user?.roles.includes(role) ?? false,
      signIn,
      signOut,
      clearReturnTo,
    }),
    [state, signIn, signOut, clearReturnTo],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within a SessionProvider");
  return ctx;
}
