import type { SessionValue } from "../session/SessionContext";
import { isCoreAdmin } from "../screens/admin/organizations/access";
import { canAdminSubscribers, canEditSubscribers, canReadSubscribers } from "../screens/subscribers/access";
import { hasCalendarRole } from "../screens/calendar/access";

export type ManualId =
  | "core-admin"
  | "nrms-site-editor"
  | "nrms-editor"
  | "nrms-viewer"
  | "nod-admin"
  | "nod-editor"
  | "nod-viewer"
  | "calendar-admin"
  | "calendar-advanced"
  | "calendar-editor"
  | "calendar-readonly";

export type ManualApp = "core" | "nrms" | "nod" | "calendar";

export interface ManualInfo {
  id: ManualId;
  title: string;
  /** Who it is for, in plain words (no role ids). */
  forRoles: string;
  app: ManualApp;
  /** Rank within the app: 0 is the top role; a higher number is a lower role. */
  level: number;
  /** Does the signed-in user hold exactly this manual's role? (Lower manuals are added by visibleManuals.) */
  heldBy(s: SessionValue): boolean;
}

/** The user's highest Subscribers level from the app's own predicates: 0 admin, 1 editor, 2 viewer, null none. */
function nodLevel(s: SessionValue): number | null {
  if (canAdminSubscribers(s)) return 0;
  if (canEditSubscribers(s)) return 1;
  return canReadSubscribers(s) ? 2 : null;
}

/** In display order: Core admin, then each app from its top role down. */
export const MANUALS: ManualInfo[] = [
  { id: "core-admin", title: "Core administrator manual", forRoles: "Core administrators", app: "core", level: 0, heldBy: isCoreAdmin },
  { id: "nrms-site-editor", title: "Site editor manual", forRoles: "Site editors", app: "nrms", level: 0, heldBy: (s) => s.has("NRMS.SiteEditor") /* no shared predicate exists for this exact role */ },
  { id: "nrms-editor", title: "Releases editor manual", forRoles: "Release editors", app: "nrms", level: 1, heldBy: (s) => s.has("NRMS.Editor") /* no shared predicate exists for this exact role */ },
  { id: "nrms-viewer", title: "Releases viewer manual", forRoles: "Release viewers", app: "nrms", level: 2, heldBy: (s) => s.has("NRMS.Viewer") /* no shared predicate exists for this exact role */ },
  { id: "nod-admin", title: "Subscribers administrator manual", forRoles: "Subscribers administrators", app: "nod", level: 0, heldBy: (s) => nodLevel(s) === 0 },
  { id: "nod-editor", title: "Subscribers editor manual", forRoles: "Subscribers editors", app: "nod", level: 1, heldBy: (s) => nodLevel(s) === 1 },
  { id: "nod-viewer", title: "Subscribers viewer manual", forRoles: "Subscribers viewers", app: "nod", level: 2, heldBy: (s) => nodLevel(s) === 2 },
  {
    id: "calendar-admin",
    title: "Calendar administrator manual",
    forRoles: "Calendar administrators and system administrators",
    app: "calendar",
    level: 0,
    // hasCalendarRole guards the block; no shared predicate exists for each exact Calendar role.
    heldBy: (s) => hasCalendarRole(s) && (s.has("Calendar.SysAdmin") || s.has("Calendar.Administrator")),
  },
  { id: "calendar-advanced", title: "Calendar advanced user manual", forRoles: "Calendar advanced users", app: "calendar", level: 1, heldBy: (s) => hasCalendarRole(s) && s.has("Calendar.Advanced") /* no shared predicate exists for this exact role */ },
  { id: "calendar-editor", title: "Calendar editor manual", forRoles: "Calendar editors", app: "calendar", level: 2, heldBy: (s) => hasCalendarRole(s) && s.has("Calendar.Editor") /* no shared predicate exists for this exact role */ },
  { id: "calendar-readonly", title: "Calendar read-only manual", forRoles: "Calendar read-only users", app: "calendar", level: 3, heldBy: (s) => hasCalendarRole(s) && s.has("Calendar.ReadOnly") /* no shared predicate exists for this exact role */ },
];

/**
 * The manuals this user may open, in display order. A Core administrator sees all of them. Anyone
 * else sees the manuals for the roles they hold (by app, in the order above), then the manuals for
 * the lower roles in those same apps. Nobody sees a manual above their role or for an app they
 * have no role in.
 */
export function visibleManuals(s: SessionValue): ManualId[] {
  if (s.has("Core.Admin")) return MANUALS.map((m) => m.id);
  const own = MANUALS.filter((m) => m.heldBy(s));
  const topLevel = new Map<ManualApp, number>();
  for (const m of own) topLevel.set(m.app, Math.min(topLevel.get(m.app) ?? Infinity, m.level));
  const ownIds = new Set(own.map((m) => m.id));
  const lower = MANUALS.filter((m) => !ownIds.has(m.id) && m.level > (topLevel.get(m.app) ?? Infinity));
  return [...own, ...lower].map((m) => m.id);
}
