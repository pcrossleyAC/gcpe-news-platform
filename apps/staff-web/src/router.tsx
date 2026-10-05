import { createBrowserRouter, type RouteObject } from "react-router";
import { SignIn } from "./screens/SignIn";
import { AppShell } from "./shell/AppShell";
import { RequireAuth } from "./session/RequireAuth";

/**
 * Library-mode react-router v7, basename "/hub" (the stack hosts the staff app there — see
 * apps/stack/src/stack.ts). Everything except /sign-in requires a session; later tasks add the
 * real Releases/Search/Website/Users/Error-log screens as children of the shell route below —
 * for now the catch-all keeps any deep link resolving to the shell instead of a 404 inside the
 * client router (the stack's own /hub fallback already serves index.html for any such path).
 */
export const routes: RouteObject[] = [
  { path: "sign-in", element: <SignIn /> },
  {
    path: "*",
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
  },
];

export function createAppRouter() {
  return createBrowserRouter(routes, { basename: "/hub" });
}
