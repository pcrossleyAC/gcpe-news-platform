import { useEffect, useId, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { Button, Header, InlineAlert } from "@bcgov/design-system-react-components";
import { useSession, type SessionValue } from "../session/SessionContext";
import { useTimeZoneWarning } from "../format/timeZoneWarning";
import { AnnouncerProvider } from "../shared/Announcer";
import { useFocusH1OnRouteChange } from "../shared/useFocusH1OnRouteChange";
import { canReadWebsite } from "../screens/website/access";
import { canReadSubscribers } from "../screens/subscribers/access";
import { canManageCalendarAccess } from "../screens/admin/calendar-access/calendar-roles";
import { canEditOrgProfile, isCoreAdmin } from "../screens/admin/organizations/access";
import { hasCalendarRole } from "../screens/calendar/access";

interface NavItem {
  to: string;
  label: string;
  show(session: SessionValue): boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
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
 * to Core.Admin and NRMS.SiteEditor (canEditOrgProfile); Government terms to Core.Admin.
 *
 * Two groups: the day-to-day work, then the administration screens. A group with nothing the
 * user may see is left out altogether, heading and all.
 */
const NAV_GROUPS: NavGroup[] = [
  {
    label: "Work",
    items: [
      { to: "/releases", label: "Releases", show: hasAnyReadRole },
      { to: "/search", label: "Search", show: hasAnyReadRole },
      { to: "/website", label: "Website", show: canReadWebsite },
      { to: "/subscribers", label: "Subscribers", show: canReadSubscribers },
      { to: "/calendar", label: "Calendar", show: hasCalendarRole },
    ],
  },
  {
    label: "Administration",
    items: [
      { to: "/users", label: "Users", show: (s) => s.has("Core.Admin") },
      { to: "/calendar-access", label: "Calendar access", show: canManageCalendarAccess },
      { to: "/organizations", label: "Organizations", show: canEditOrgProfile },
      { to: "/government-terms", label: "Government terms", show: isCoreAdmin },
      { to: "/categories", label: "Sectors, themes and tags", show: isCoreAdmin },
      { to: "/release-page-titles", label: "Release page titles", show: isCoreAdmin },
      { to: "/media-list-names", label: "Media list names", show: (s) => s.has("Core.Admin") },
      { to: "/error-log", label: "Error log", show: (s) => s.has("Core.Admin") },
    ],
  },
];

export function AppShell(): React.JSX.Element {
  const session = useSession();
  const navigate = useNavigate();
  const tzMismatch = useTimeZoneWarning();
  // I5 (WCAG 2.4.2): move focus to the new screen's h1 on every route change.
  const mainRef = useFocusH1OnRouteChange<HTMLElement>();
  const uid = useId();
  const { pathname } = useLocation();
  // On narrow screens the section menu folds away behind a "Menu" button (the CSS hides the
  // button, and shows the menu regardless, on wider ones). Choosing a section closes it again.
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [pathname]);
  const groups = NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((item) => item.show(session)) })).filter((g) => g.items.length > 0);

  const onSignOut = async () => {
    await session.signOut();
    navigate("/sign-in", { replace: true });
  };

  return (
    <AnnouncerProvider>
      <div className="gcpe-shell">
        <a className="gcpe-skip-link" href="#main-content">
          Skip to main content
        </a>
        <Header title="GCPE News — Staff">
          <div className="gcpe-shell__user">
            {session.user && <span>Signed in as {session.user.name}</span>}
            <Button size="small" variant="secondary" onPress={onSignOut}>
              Sign out
            </Button>
          </div>
        </Header>
        <nav className="gcpe-shell__nav" aria-label="Sections">
          <div className="gcpe-shell__menu-toggle">
            <Button size="small" variant="secondary" aria-expanded={menuOpen} aria-controls={`${uid}-menu`} onPress={() => setMenuOpen((open) => !open)}>
              Menu
            </Button>
          </div>
          <div id={`${uid}-menu`} className="gcpe-shell__menu" data-open={menuOpen || undefined}>
            {groups.map((group) => (
              <div key={group.label} className="gcpe-shell__nav-group">
                <p id={`${uid}-${group.label}`} className="gcpe-shell__nav-heading">
                  {group.label}
                </p>
                <ul aria-labelledby={`${uid}-${group.label}`}>
                  {group.items.map((item) => (
                    <li key={item.to}>
                      <NavLink to={item.to}>{item.label}</NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </nav>
        <main id="main-content" tabIndex={-1} className="gcpe-shell__main" ref={mainRef}>
          {/* Each routed screen owns its own single h1 (constraints.md); the shell itself has none. */}
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
