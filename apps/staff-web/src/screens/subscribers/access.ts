import type { SessionValue } from "../../session/SessionContext";

/** Spec §8: NoD.Viewer reads the Subscribers section; NoD.Editor and NoD.Admin also change it.
 * The NoD API enforces the same split (NOD_READ_ROLES/NOD_WRITE_ROLES); this only decides
 * what's shown. */
export function canReadSubscribers(s: SessionValue): boolean {
  return s.has("NoD.Viewer") || s.has("NoD.Editor") || s.has("NoD.Admin");
}
export function canEditSubscribers(s: SessionValue): boolean {
  return s.has("NoD.Editor") || s.has("NoD.Admin");
}

/** Spec §8: NoD.Admin alone changes lists and categories and uses Operations. */
export function canAdminSubscribers(s: SessionValue): boolean {
  return s.has("NoD.Admin");
}
