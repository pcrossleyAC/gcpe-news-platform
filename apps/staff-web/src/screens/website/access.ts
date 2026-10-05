import type { SessionValue } from "../../session/SessionContext";

/**
 * Minors: every signed-in staff role can read "What's featured where" and the Website log
 * (they're read-only everywhere already); every *other* Website screen (Carousel, Pins, Live
 * Feed, Blue Bridge, Resource links, Files) stays `NRMS.SiteEditor` + `Core.Admin` only, same
 * as before this opened up. `canReadWebsite` gates the section as a whole (AppShell's nav item,
 * WebsiteScreen's own outer check, and the default `/website` redirect); `canManageWebsite`
 * gates everything that isn't Featured/Log — each of those screens checks it itself too
 * (defense in depth: WebsiteScreen's own gate no longer blocks a Viewer/Editor's direct deep
 * link to e.g. `/hub/website/carousel` once it allows them through for Featured/Log).
 */
export function canReadWebsite(session: SessionValue): boolean {
  return session.has("NRMS.Viewer") || session.has("NRMS.Editor") || session.has("NRMS.SiteEditor") || session.has("Core.Admin");
}

export function canManageWebsite(session: SessionValue): boolean {
  return session.has("NRMS.SiteEditor") || session.has("Core.Admin");
}
