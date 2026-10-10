import { NavLink, Outlet, useNavigate } from "react-router";
import { Button, Header, InlineAlert } from "@bcgov/design-system-react-components";
import { useSession, type SessionValue } from "../session/SessionContext";
import { useTimeZoneWarning } from "../format/timeZoneWarning";
import { AnnouncerProvider } from "../shared/Announcer";
import { useFocusH1OnRouteChange } from "../shared/useFocusH1OnRouteChange";
import { canReadWebsite } from "../screens/website/access";
import { canReadSubscribers } from "../screens/subscribers/access";
import { canManageCalendarAccess } from "../screens/admin/calendar-access/calendar-roles";
import { hasCalendarRole } from "../screens/calendar/access";

interface NavItem {
  to: string;
  label: string;
  show(session: SessionValue): boolean;
}

const hasAnyReadRole = (s: SessionValue) => s.has("NRMS.Viewer") || s.has("NRMS.Editor") || s.has("NRMS.SiteEditor");

/**
 * Sections shown only when the signed-in user's roles allow them (constraints.md: "roles
 * decide what's shown, but the server is the authority"). Website is visible to every read
 * role (minors: Featured/the log are read-only for all of them; canReadWebsite) — WebsiteScreen
 * itself (and each manage-only sub-screen) still restricts the other six sections to
 * NRMS.SiteEditor/Core.Admin; Users, Media list names and the error log are Core.Admin only.
 * Subscribers is visible to any NoD role (canReadSubscribers) — an NRMS-only user never sees
 * it, and vice versa. Calendar is visible to any Calendar role (hasCalendarRole). Calendar
 * access is visible to Core.Admin, Calendar.Administrator and Calendar.SysAdmin; Organizations
 * to Core.Admin.
 */
const NAV_ITEMS: NavItem[] = [
  { to: "/releases", label: "Releases", show: hasAnyReadRole },
  { to: "/search", label: "Search", show: hasAnyReadRole },
  { to: "/website", label: "Website", show: canReadWebsite },
  { to: "/subscribers", label: "Subscribers", show: canReadSubscribers },
  { to: "/calendar", label: "Calendar", show: hasCalendarRole },
  { to: "/users", label: "Users", show: (s) => s.has("Core.Admin") },
  { to: "/calendar-access", label: "Calendar access", show: canManageCalendarAccess },
  { to: "/organizations", label: "Organizations", show: (s) => s.has("Core.Admin") },
  { to: "/media-list-names", label: "Media list names", show: (s) => s.has("Core.Admin") },
  { to: "/error-log", label: "Error log", show: (s) => s.has("Core.Admin") },
];

export function AppShell(): React.JSX.Element {
  const session = useSession();
  const navigate = useNavigate();
  const tzMismatch = useTimeZoneWarning();
  // I5 (WCAG 2.4.2): move focus to the new screen's h1 on every route change.
  const mainRef = useFocusH1OnRouteChange<HTMLElement>();

  const onSignOut = async () => {
    await session.signOut();
    navigate("/sign-in", { replace: true });
  };

  return (
    <AnnouncerProvider>
      <div className="gcpe-shell">
        <Header title="GCPE News — Staff" />
        <nav className="gcpe-shell__nav" aria-label="Sections">
          <ul>
            {NAV_ITEMS.filter((item) => item.show(session)).map((item) => (
              <li key={item.to}>
                <NavLink to={item.to}>{item.label}</NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <main className="gcpe-shell__main" ref={mainRef}>
          {/* Each routed screen owns its own single h1 (constraints.md); the shell itself has none. */}
          {session.user && <p>Signed in as {session.user.name}</p>}
          <Button onPress={onSignOut}>Sign out</Button>
          {/* Fix round 1, finding 3: persistent — not closeable — since it stays true for the
           * whole session; the only real fix is updating the browser. */}
          {tzMismatch && (
            <InlineAlert
              variant="warning"
              role="alert"
              isCloseable={false}
              description="Your browser's time-zone information is out of date, so times shown here may be off by an hour. Update your browser."
            />
          )}
          <Outlet />
        </main>
      </div>
    </AnnouncerProvider>
  );
}
