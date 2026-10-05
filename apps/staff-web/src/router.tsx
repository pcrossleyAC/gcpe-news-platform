import { createBrowserRouter, Navigate, type RouteObject } from "react-router";
import { SignIn } from "./screens/SignIn";
import { AppShell } from "./shell/AppShell";
import { RequireAuth } from "./session/RequireAuth";
import { ReleaseListScreen } from "./screens/releases/ReleaseListScreen";
import { ReleasePlaceholder } from "./screens/releases/ReleasePlaceholder";
import { SearchScreen } from "./screens/search/SearchScreen";

/**
 * Library-mode react-router v7, basename "/hub" (the stack hosts the staff app there — see
 * apps/stack/src/stack.ts). Everything except /sign-in requires a session.
 *
 * `releases/drafts|scheduled|published` are three *static* sibling routes rather than one
 * `:folder` param — that's what lets `releases/:id` sit alongside them unambiguously (a UUID,
 * or "new" from the New release button, simply isn't one of those three literal segments) and
 * still fall through to {@link ReleasePlaceholder} (the real editor is Task 3's job) without
 * any custom matching logic. The remaining `*` keeps any other deep link (Website/Users/the
 * error log — later tasks) resolving to the shell instead of a 404 inside the client router
 * (the stack's own /hub fallback already serves index.html for any such path).
 */
export const routes: RouteObject[] = [
  { path: "sign-in", element: <SignIn /> },
  {
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <Navigate to="/releases/drafts" replace /> },
      {
        path: "releases",
        children: [
          { index: true, element: <Navigate to="/releases/drafts" replace /> },
          { path: "drafts", element: <ReleaseListScreen folder="drafts" /> },
          { path: "scheduled", element: <ReleaseListScreen folder="scheduled" /> },
          { path: "published", element: <ReleaseListScreen folder="published" /> },
          { path: ":id", element: <ReleasePlaceholder /> },
        ],
      },
      { path: "search", element: <SearchScreen /> },
      { path: "*", element: null },
    ],
  },
];

export function createAppRouter() {
  return createBrowserRouter(routes, { basename: "/hub" });
}
