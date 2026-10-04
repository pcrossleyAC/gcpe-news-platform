/** Every role a staff user can hold (spec addendum §2). No ministry scope — legacy has none. */
export const STAFF_ROLES = ["Core.Admin", "NRMS.Editor", "NRMS.SiteEditor", "NRMS.Viewer", "NoD.Admin", "Distribution.Send"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
