import type { SessionValue } from "../session/SessionContext";
import { canReadWebsite } from "../screens/website/access";
import { canReadSubscribers } from "../screens/subscribers/access";
import { canManageCalendarAccess } from "../screens/admin/calendar-access/calendar-roles";
import { canEditOrgProfile, isCoreAdmin } from "../screens/admin/organizations/access";
import { hasCalendarRole } from "../screens/calendar/access";

export interface NavItem {
  to: string;
  label: string;
  show(session: SessionValue): boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const hasAnyReadRole = (s: SessionValue) => s.has("NRMS.Viewer") || s.has("NRMS.Editor") || s.has("NRMS.SiteEditor");

/**
 * Sections shown only when the signed-in user's roles allow them (constraints.md: "roles
 * decide what's shown, but the server is the authority"). Website is visible to every read
 * role (minors: Featured/the log are read-only for all of them; canReadWebsite) — WebsiteScreen
 * itself (and each manage-only sub-screen) still restricts the other six sections to
 * NRMS.SiteEditor/Core.Admin; Users, Media list names, the error log and Admin history are Core.Admin only.
 * Subscribers is visible to any NoD role (canReadSubscribers) — an NRMS-only user never sees
 * it, and vice versa. Calendar is visible to any Calendar role (hasCalendarRole). Calendar
 * access is visible to Core.Admin, Calendar.Administrator and Calendar.SysAdmin; Organizations
 * to Core.Admin and NRMS.SiteEditor (canEditOrgProfile); Government terms to Core.Admin.
 *
 * Two groups: the day-to-day work, then the administration screens. A group with nothing the
 * user may see is left out altogether, heading and all.
 */
export const NAV_GROUPS: NavGroup[] = [
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
      { to: "/admin-history", label: "Admin history", show: (s) => s.has("Core.Admin") },
    ],
  },
];
