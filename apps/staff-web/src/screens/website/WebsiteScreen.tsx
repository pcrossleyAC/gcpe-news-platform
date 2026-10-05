import { NavLink, Outlet } from "react-router";
import { useSession } from "../../session/SessionContext";
import { useDocumentTitle } from "../../shared/useDocumentTitle";

const SECTIONS: { to: string; label: string }[] = [
  { to: "carousel", label: "Carousel" },
  { to: "pins", label: "Emergency pins" },
  { to: "live-feed", label: "Live Feed" },
  { to: "blue-bridge", label: "Project Blue Bridge" },
  { to: "links", label: "Resource links" },
  { to: "files", label: "Files" },
  { to: "featured", label: "What's featured where" },
  { to: "log", label: "Website log" },
];

/**
 * `/hub/website/*` (task-5-brief.md): the shell for every Website sub-screen — a sub-nav plus
 * `<Outlet/>`, same shape as {@link AppShell} (no `h1` of its own; each sub-screen has exactly
 * one, constraints.md). AppShell already hides the top-level "Website" nav item from anyone
 * without `NRMS.SiteEditor` or `Core.Admin`; this is the defense-in-depth check for a direct
 * deep link (same pattern as NewReleaseScreen's own permission check).
 */
export function WebsiteScreen(): React.JSX.Element {
  const session = useSession();
  // Only the permission-denied branch below renders an h1 of its own; every real sub-screen
  // (Carousel, Pins, ...) owns its own title via its own useDocumentTitle call.
  useDocumentTitle(!session.has("NRMS.SiteEditor") && !session.has("Core.Admin") ? "Website" : null);
  if (!session.has("NRMS.SiteEditor") && !session.has("Core.Admin")) {
    return (
      <div className="gcpe-website">
        <h1>Website</h1>
        <p>You don&rsquo;t have permission to view the Website section.</p>
      </div>
    );
  }

  return (
    <div className="gcpe-website">
      <nav aria-label="Website sections">
        <ul>
          {SECTIONS.map((s) => (
            <li key={s.to}>
              <NavLink to={s.to}>{s.label}</NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <Outlet />
    </div>
  );
}
