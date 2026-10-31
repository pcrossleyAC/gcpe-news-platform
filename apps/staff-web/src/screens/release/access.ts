import type { SessionValue } from "../../session/SessionContext";

/** Can change releases: start, edit, approve, publish, schedule, correct, feature and unpublish
 * them (the server's `edit` guard in apps/nrms/src/http/routes.ts). Viewers and site editors read only. */
export function canEditReleases(s: SessionValue): boolean {
  return s.has("NRMS.Editor");
}
