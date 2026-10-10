/** Every role a staff user can hold (spec addendum §2; NoD.Viewer/NoD.Editor from the NoD
 * parity spec §8 — Viewer reads the Subscribers section, Editor also changes subscribers and
 * media lists, Admin adds Operations and categories). No ministry scope — legacy has none. */
export const STAFF_ROLES = ["Core.Admin", "NRMS.Editor", "NRMS.SiteEditor", "NRMS.Viewer", "NoD.Viewer", "NoD.Editor", "NoD.Admin", "Distribution.Send"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/**
 * Plan 3d task 4: a dedicated, read-only service role for NRMS's own calls to Core's admin
 * directory (so it can email every Core.Admin when Project Blue Bridge is switched) — not added
 * to STAFF_ROLES: no human ever holds it, same pattern as NoD.SubscriberCount
 * (apps/nrms/src/start.ts).
 */
export const CORE_ADMIN_DIRECTORY_ROLE = "Core.AdminDirectory";

/** Phase 4a: the News API's service role for proxying the public Subscribe API to NoD (legacy
 * "SubscribeApiUser"). Not a staff role. */
export const NOD_SUBSCRIBE_API_ROLE = "NoD.SubscribeApi";

/** Distribution's own admin surface (its pause/resume settings routes) — a service role
 * NoD's Distribution client carries, not a staff role (staff control it through NoD's own
 * `NoD.Admin`-gated routes, never by calling Distribution directly). */
export const DISTRIBUTION_OPERATE_ROLE = "Distribution.Operate";

/**
 * The Corporate Calendar's ministry-scoped roles, lowest to highest: legacy's SecurityRole 1–5
 * (Gcpe.Calendar.Library/Security/CustomPrincipal.cs:14). A user holds at most one, so they are
 * kept apart from the flat STAFF_ROLES and granted only through Core's Calendar access routes.
 */
export const CALENDAR_ROLES = ["Calendar.ReadOnly", "Calendar.Editor", "Calendar.Advanced", "Calendar.Administrator", "Calendar.SysAdmin"] as const;
export type CalendarRole = (typeof CALENDAR_ROLES)[number];
