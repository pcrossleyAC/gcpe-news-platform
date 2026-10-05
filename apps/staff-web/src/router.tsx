import { createBrowserRouter, Navigate, type RouteObject } from "react-router";
import { SignIn } from "./screens/SignIn";
import { AppShell } from "./shell/AppShell";
import { RequireAuth } from "./session/RequireAuth";
import { ReleaseListScreen } from "./screens/releases/ReleaseListScreen";
import { SearchScreen } from "./screens/search/SearchScreen";
import { NewReleaseScreen } from "./screens/release/NewReleaseScreen";
import { ReleaseEditorPage } from "./screens/release/ReleaseEditorPage";
import { WebsiteScreen } from "./screens/website/WebsiteScreen";
import { CarouselScreen } from "./screens/website/CarouselScreen";
import { PinsScreen } from "./screens/website/PinsScreen";
import { LiveFeedScreen } from "./screens/website/LiveFeedScreen";
import { BlueBridgeScreen } from "./screens/website/BlueBridgeScreen";
import { LinksScreen } from "./screens/website/LinksScreen";
import { FilesScreen } from "./screens/website/FilesScreen";
import { FeaturedScreen } from "./screens/website/FeaturedScreen";
import { LogScreen } from "./screens/website/LogScreen";
import { UsersScreen } from "./screens/admin/users/UsersScreen";
import { ErrorLogScreen } from "./screens/admin/errors/ErrorLogScreen";

/**
 * Library-mode react-router v7, basename "/hub" (the stack hosts the staff app there — see
 * apps/stack/src/stack.ts). Everything except /sign-in requires a session.
 *
 * `releases/drafts|scheduled|published` are three *static* sibling routes rather than one
 * `:folder` param — that's what lets `releases/:id` sit alongside them unambiguously (a UUID
 * simply isn't one of those three literal segments) and still fall through to
 * {@link ReleaseEditorPage}. `releases/new` (Task 3) is listed *before* `releases/:id` so the
 * literal segment wins the match instead of being captured as an `:id` param. The remaining `*`
 * keeps any other deep link (Website/Users/the error log — later tasks) resolving to the shell
 * instead of a 404 inside the client router (the stack's own /hub fallback already serves
 * index.html for any such path).
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
          { path: "new", element: <NewReleaseScreen /> },
          { path: ":id", element: <ReleaseEditorPage /> },
        ],
      },
      { path: "search", element: <SearchScreen /> },
      {
        path: "website",
        element: <WebsiteScreen />,
        children: [
          { index: true, element: <Navigate to="carousel" replace /> },
          { path: "carousel", element: <CarouselScreen /> },
          { path: "pins", element: <PinsScreen /> },
          { path: "live-feed", element: <LiveFeedScreen /> },
          { path: "blue-bridge", element: <BlueBridgeScreen /> },
          { path: "links", element: <LinksScreen /> },
          { path: "files", element: <FilesScreen /> },
          { path: "featured", element: <FeaturedScreen /> },
          { path: "log", element: <LogScreen /> },
        ],
      },
      { path: "users", element: <UsersScreen /> },
      { path: "error-log", element: <ErrorLogScreen /> },
      { path: "*", element: null },
    ],
  },
];

export function createAppRouter() {
  return createBrowserRouter(routes, { basename: "/hub" });
}
