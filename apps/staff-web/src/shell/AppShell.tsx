import { NavLink, Outlet, useNavigate } from "react-router";
import { Button, Header } from "@bcgov/design-system-react-components";
import { useSession, type SessionValue } from "../session/SessionContext";

interface NavItem {
  to: string;
  label: string;
  show(session: SessionValue): boolean;
}

const hasAnyReadRole = (s: SessionValue) => s.has("NRMS.Viewer") || s.has("NRMS.Editor") || s.has("NRMS.SiteEditor");

/**
 * Sections shown only when the signed-in user's roles allow them (constraints.md: "roles
 * decide what's shown, but the server is the authority"). Website is visible to NRMS.SiteEditor
 * (who edits it) and to Core.Admin (who needs it to reach Project Blue Bridge's switch —
 * constraints.md Review Focus 4); Users and the error log are Core.Admin only.
 */
const NAV_ITEMS: NavItem[] = [
  { to: "/releases", label: "Releases", show: hasAnyReadRole },
  { to: "/search", label: "Search", show: hasAnyReadRole },
  { to: "/website", label: "Website", show: (s) => s.has("NRMS.SiteEditor") || s.has("Core.Admin") },
  { to: "/users", label: "Users", show: (s) => s.has("Core.Admin") },
  { to: "/error-log", label: "Error log", show: (s) => s.has("Core.Admin") },
];

export function AppShell(): React.JSX.Element {
  const session = useSession();
  const navigate = useNavigate();

  const onSignOut = async () => {
    await session.signOut();
    navigate("/sign-in", { replace: true });
  };

  return (
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
      <main className="gcpe-shell__main">
        {/* Each routed screen owns its own single h1 (constraints.md); the shell itself has none. */}
        {session.user && <p>Signed in as {session.user.name}</p>}
        <Button onPress={onSignOut}>Sign out</Button>
        <Outlet />
      </main>
    </div>
  );
}
