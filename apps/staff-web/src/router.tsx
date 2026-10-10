import { createBrowserRouter, Navigate, type RouteObject } from "react-router";
import { SignIn } from "./screens/SignIn";
import { AppShell } from "./shell/AppShell";
import { HomeRedirect } from "./shell/HomeRedirect";
import { RequireAuth } from "./session/RequireAuth";
import { ReleaseListScreen } from "./screens/releases/ReleaseListScreen";
import { SearchScreen } from "./screens/search/SearchScreen";
import { NewReleaseScreen } from "./screens/release/NewReleaseScreen";
import { ReleaseEditorPage } from "./screens/release/ReleaseEditorPage";
import { WebsiteIndexRedirect, WebsiteScreen } from "./screens/website/WebsiteScreen";
import { CarouselScreen } from "./screens/website/CarouselScreen";
import { PinsScreen } from "./screens/website/PinsScreen";
import { LiveFeedScreen } from "./screens/website/LiveFeedScreen";
import { BlueBridgeScreen } from "./screens/website/BlueBridgeScreen";
import { LinksScreen } from "./screens/website/LinksScreen";
import { FilesScreen } from "./screens/website/FilesScreen";
import { FeaturedScreen } from "./screens/website/FeaturedScreen";
import { LogScreen } from "./screens/website/LogScreen";
import { CalendarSection } from "./screens/calendar/CalendarSection";
import { CalendarHome } from "./screens/calendar/CalendarHome";
import { LookupsScreen } from "./screens/calendar/lookups/LookupsScreen";
import { LookupScreen } from "./screens/calendar/lookups/LookupScreen";
import { CalendarUsersScreen } from "./screens/calendar/users/CalendarUsersScreen";
import { CalendarUserScreen } from "./screens/calendar/users/CalendarUserScreen";
import { TransferScreen } from "./screens/calendar/transfer/TransferScreen";
import { DeadLettersScreen } from "./screens/calendar/dead-letters/DeadLettersScreen";
import { UsersScreen } from "./screens/admin/users/UsersScreen";
import { CalendarAccessScreen } from "./screens/admin/calendar-access/CalendarAccessScreen";
import { OrganizationsScreen } from "./screens/admin/organizations/OrganizationsScreen";
import { MediaListNamesScreen } from "./screens/admin/media-lists/MediaListNamesScreen";
import { ErrorLogScreen } from "./screens/admin/errors/ErrorLogScreen";
import { SubscribersSection } from "./screens/subscribers/SubscribersSection";
import { SubscribersScreen } from "./screens/subscribers/SubscribersScreen";
import { AddSubscriberScreen } from "./screens/subscribers/AddSubscriberScreen";
import { SubscriberScreen } from "./screens/subscribers/SubscriberScreen";
import { HistoryScreen } from "./screens/subscribers/HistoryScreen";
import { ListsScreen } from "./screens/subscribers/ListsScreen";
import { MediaListsScreen } from "./screens/subscribers/MediaListsScreen";
import { MediaListScreen } from "./screens/subscribers/MediaListScreen";
import { OperationsScreen } from "./screens/subscribers/OperationsScreen";
import { ReportsScreen } from "./screens/subscribers/reports/ReportsScreen";
import { SubscribersByListReportScreen } from "./screens/subscribers/reports/SubscribersByListReportScreen";
import { UnsubscribesReportScreen } from "./screens/subscribers/reports/UnsubscribesReportScreen";
import { ReleaseSendsReportScreen } from "./screens/subscribers/reports/ReleaseSendsReportScreen";
import { DigestRunsReportScreen } from "./screens/subscribers/reports/DigestRunsReportScreen";
import { DistributionReportScreen } from "./screens/subscribers/reports/DistributionReportScreen";

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
      { index: true, element: <HomeRedirect /> },
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
          { index: true, element: <WebsiteIndexRedirect /> },
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
      {
        path: "subscribers",
        element: <SubscribersSection />,
        children: [
          { index: true, element: <SubscribersScreen /> },
          { path: "new", element: <AddSubscriberScreen /> },
          { path: "lists", element: <ListsScreen /> },
          { path: "media-lists", element: <MediaListsScreen /> },
          { path: "media-lists/:key", element: <MediaListScreen /> },
          { path: "operations", element: <OperationsScreen /> },
          { path: "reports", element: <ReportsScreen /> },
          { path: "reports/subscribers-by-list", element: <SubscribersByListReportScreen /> },
          { path: "reports/unsubscribes", element: <UnsubscribesReportScreen /> },
          { path: "reports/release-sends", element: <ReleaseSendsReportScreen /> },
          { path: "reports/digest-runs", element: <DigestRunsReportScreen /> },
          { path: "reports/distribution", element: <DistributionReportScreen /> },
          { path: ":id", element: <SubscriberScreen /> },
          { path: ":id/history", element: <HistoryScreen /> },
        ],
      },
      {
        path: "calendar",
        element: <CalendarSection />,
        children: [
          { index: true, element: <CalendarHome /> },
          { path: "lookups", element: <LookupsScreen /> },
          { path: "lookups/:name", element: <LookupScreen /> },
          { path: "users", element: <CalendarUsersScreen /> },
          { path: "users/:id", element: <CalendarUserScreen /> },
          { path: "transfer", element: <TransferScreen /> },
          { path: "dead-letters", element: <DeadLettersScreen /> },
        ],
      },
      { path: "users", element: <UsersScreen /> },
      { path: "calendar-access", element: <CalendarAccessScreen /> },
      { path: "organizations", element: <OrganizationsScreen /> },
      { path: "media-list-names", element: <MediaListNamesScreen /> },
      { path: "error-log", element: <ErrorLogScreen /> },
      { path: "*", element: null },
    ],
  },
];

export function createAppRouter() {
  return createBrowserRouter(routes, { basename: "/hub" });
}
