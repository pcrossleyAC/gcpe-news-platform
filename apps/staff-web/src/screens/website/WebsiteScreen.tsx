import { NavLink, Navigate, Outlet } from "react-router";
import { useSession } from "../../session/SessionContext";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { canManageWebsite, canReadWebsite } from "./access";

const SECTIONS: { to: string; label: string; manageOnly: boolean }[] = [
  { to: "carousel", label: "Carousel", manageOnly: true },
  { to: "pins", label: "Emergency pins", manageOnly: true },
  { to: "live-feed", label: "Live Feed", manageOnly: true },
  { to: "blue-bridge", label: "Project Blue Bridge", manageOnly: true },
  { to: "links", label: "Resource links", manageOnly: true },
  { to: "files", label: "Files", manageOnly: true },
  { to: "featured", label: "What's featured where", manageOnly: false },
  { to: "log", label: "Website log", manageOnly: false },
];

/**
 * `/hub/website/*` (task-5-brief.md): the shell for every Website sub-screen — a sub-nav plus
 * `<Outlet/>`, same shape as {@link AppShell} (no `h1` of its own; each sub-screen has exactly
 * one, constraints.md). AppShell already hides the top-level "Website" nav item from anyone who
 * can't read any of it; this is the defense-in-depth check for a direct deep link (same pattern
 * as NewReleaseScreen's own permission check).
 *
 * Minors: "What's featured where" and the Website log are read-only for every staff role
 * ({@link canReadWebsite}) — only the other six sections stay `NRMS.SiteEditor`/`Core.Admin`
 * ({@link canManageWebsite}), so the sub-nav here only lists those six when the signed-in user
 * can't manage Website; each of those six screens checks `canManageWebsite` itself too, since
 * this component no longer blocks every non-manage role from reaching their routes at all.
 */
export function WebsiteScreen(): React.JSX.Element {
  const session = useSession();
  // Only the permission-denied branch below renders an h1 of its own; every real sub-screen
  // (Carousel, Pins, ...) owns its own title via its own useDocumentTitle call.
  useDocumentTitle(!canReadWebsite(session) ? "Website" : null);
  if (!canReadWebsite(session)) {
    return (
      <div className="gcpe-website">
        <h1>Website</h1>
        <p>You don&rsquo;t have permission to view the Website section.</p>
      </div>
    );
  }

  const canManage = canManageWebsite(session);

  return (
    <div className="gcpe-website">
      <nav aria-label="Website sections">
        <ul>
          {SECTIONS.filter((s) => canManage || !s.manageOnly).map((s) => (
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

/** `/hub/website`'s index redirect (router.tsx) — a manage role lands on Carousel (the first
 * manage-only section, same as before); a read-only role lands on Featured, the first section
 * it can actually see. */
export function WebsiteIndexRedirect(): React.JSX.Element {
  const session = useSession();
  return <Navigate to={canManageWebsite(session) ? "carousel" : "featured"} replace />;
}
