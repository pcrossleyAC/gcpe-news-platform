import { Link, NavLink, Navigate, Outlet, useLocation } from "react-router";
import type { SectionKey } from "@gcpe/site-settings";
import { useSession } from "../../session/SessionContext";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { canManageWebsite, canReadWebsite } from "./access";

/** The daily items: one tab each. */
const SECTIONS: { to: string; label: string; manageOnly: boolean }[] = [
  { to: "carousel", label: "Carousel", manageOnly: true },
  { to: "pins", label: "Emergency pins", manageOnly: true },
  { to: "live-feed", label: "Live Feed", manageOnly: true },
  { to: "featured", label: "What's featured where", manageOnly: false },
  { to: "links", label: "Resource links", manageOnly: true },
  { to: "files", label: "Files", manageOnly: true },
  { to: "address-check", label: "Hub address check", manageOnly: true },
  { to: "log", label: "Website log", manageOnly: false },
];

/** The site settings (spec "Hub screens"), behind one "Site settings" tab whose index lists them. */
export const SITE_SETTINGS: { to: string; label: string; description: string; section?: SectionKey }[] = [
  { to: "banner", label: "Site banner", description: "The notice shown across the top of the public site.", section: "banner" },
  { to: "footer", label: "Footer links", description: "The links in the public site's footer.", section: "footer" },
  { to: "social", label: "Social links", description: "The social media accounts the public site links to.", section: "connect" },
  { to: "theme", label: "Theme colours", description: "The public site's colours.", section: "theme" },
  { to: "ministry-pages", label: "Ministry page headings", description: "The headings on each ministry's page.", section: "ministryPages" },
  { to: "media-contacts", label: "Media contacts page", description: "The media contacts page and the contacts listed on it.", section: "contactsPage" },
  { to: "page-text", label: "Page text", description: "Text on the public site's own pages, such as its not-found and empty messages.", section: "pageText" },
  { to: "navigation", label: "Navigation and labels", description: "The public site's menu, and the labels on its links and buttons.", section: "navigation" },
  { to: "identity", label: "Site identity", description: "The site description, the X account and the Project Blue Bridge banner wording.", section: "siteIdentity" },
  { to: "settings-history", label: "Settings history", description: "Every published revision of these settings, and restoring an earlier one." },
];

/** The settings screen that edits `section`: its on-screen name and its address. */
export function settingsScreenFor(section: SectionKey): { label: string; path: string } {
  const screen = SITE_SETTINGS.find((s) => s.section === section)!;
  return { label: screen.label, path: `/website/${screen.to}` };
}

/** Listed under "Restricted" on the Site settings index (and last in its page list). */
export const BLUE_BRIDGE = { to: "blue-bridge", label: "Project Blue Bridge", description: "Its current state. Only Core administrators can turn it on or off, with a confirmation phrase." };

const SETTINGS_PATHS = new Set(["settings", BLUE_BRIDGE.to, ...SITE_SETTINGS.map((s) => s.to)]);

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
  const here = useLocation();
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
  const page = here.pathname.replace(/\/+$/, "").split("/").at(-1) ?? "";
  const inSettings = canManage && SETTINGS_PATHS.has(page);

  return (
    <div className="gcpe-website">
      <nav aria-label="Website sections" className="gcpe-section-tabs">
        <ul>
          {SECTIONS.filter((s) => canManage || !s.manageOnly).map((s) => (
            <li key={s.to}>
              <NavLink to={s.to}>{s.label}</NavLink>
            </li>
          ))}
          {canManage && (
            <li>
              {/* Current on the index ("page") and on every settings page under it ("true"). */}
              <Link to="settings" aria-current={inSettings ? (page === "settings" ? "page" : "true") : undefined}>
                Site settings
              </Link>
            </li>
          )}
        </ul>
      </nav>
      {inSettings && page !== "settings" && (
        <nav aria-label="Site settings pages" className="gcpe-subnav">
          <ul>
            <li>
              <NavLink to="settings" end>
                All site settings
              </NavLink>
            </li>
            {[...SITE_SETTINGS, BLUE_BRIDGE].map((s) => (
              <li key={s.to}>
                <NavLink to={s.to}>{s.label}</NavLink>
              </li>
            ))}
          </ul>
        </nav>
      )}
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

/**
 * `/hub/website/settings`: the Site settings tab's landing page, every settings screen with a
 * line on what it changes, and Project Blue Bridge under its own "Restricted" heading. Every
 * settings screen keeps its own route, so deep links work as before.
 */
export function SiteSettingsIndex(): React.JSX.Element {
  const session = useSession();
  const canManage = canManageWebsite(session);
  useDocumentTitle("Site settings");
  if (!canManage) {
    return (
      <div className="gcpe-site-settings-index">
        <h1>Site settings</h1>
        <p>You don&rsquo;t have permission to view the site settings.</p>
      </div>
    );
  }
  return (
    <div className="gcpe-site-settings-index">
      <h1>Site settings</h1>
      <p>How the public site looks and reads.</p>
      <ul className="gcpe-link-cards">
        {SITE_SETTINGS.map((s) => (
          <li key={s.to}>
            <NavLink to={`../${s.to}`} relative="path">{s.label}</NavLink>
            <p>{s.description}</p>
          </li>
        ))}
      </ul>
      <h2>Restricted</h2>
      <ul className="gcpe-link-cards">
        <li>
          <NavLink to={`../${BLUE_BRIDGE.to}`} relative="path">{BLUE_BRIDGE.label}</NavLink>
          <p>{BLUE_BRIDGE.description}</p>
        </li>
      </ul>
    </div>
  );
}
