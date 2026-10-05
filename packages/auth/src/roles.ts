/** Every role a staff user can hold (spec addendum §2). No ministry scope — legacy has none. */
export const STAFF_ROLES = ["Core.Admin", "NRMS.Editor", "NRMS.SiteEditor", "NRMS.Viewer", "NoD.Admin", "Distribution.Send"] as const;
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
