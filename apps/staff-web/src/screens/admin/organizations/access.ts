import type { SessionValue } from "../../../session/SessionContext";

/** Core.Admin alone sets the HQ/public flags (and, in later tasks, adds or deactivates organizations). */
export function isCoreAdmin(session: SessionValue): boolean {
  return session.has("Core.Admin");
}

/** The public-facing profile (ministry and minister names) is editable by Core.Admin and NRMS.SiteEditor. */
export function canEditOrgProfile(session: SessionValue): boolean {
  return isCoreAdmin(session) || session.has("NRMS.SiteEditor");
}
