import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { useSession } from "./SessionContext";

/**
 * Wraps the authenticated shell: while signed out (never signed in, signed out, or a 401 just
 * fired elsewhere), redirects to /hub/sign-in, carrying the current path+search as `return` so
 * sign-in can send them straight back (constraints.md Review Focus 1 — a session expiring
 * mid-edit still returns the user to the same place once they sign in again).
 */
export function RequireAuth({ children }: { children: ReactNode }): React.JSX.Element | null {
  const { user, loading } = useSession();
  const location = useLocation();

  if (loading) return null;
  if (!user) {
    const returnTo = `${location.pathname}${location.search}`;
    return <Navigate to={`/sign-in?return=${encodeURIComponent(returnTo)}`} replace />;
  }
  return <>{children}</>;
}
