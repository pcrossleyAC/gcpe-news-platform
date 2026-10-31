import type { HubManualsData as ManualsData } from "../../../../scripts/manuals-lib.mjs";
import type { SessionValue } from "../session/SessionContext";
import { canEditReleases } from "../screens/release/access";
import { canEditWebsite } from "../screens/website/access";
import { MANUALS_DATA, visiblePages } from "./visible-pages";

/** The How do I… anchor for the area you're in (the whole Help page otherwise). */
const HELP_AREAS: [RegExp, string][] = [
  [/^\/(releases|search)(\/|$)/, "releases"],
  [/^\/website(\/|$)/, "website"],
  [/^\/subscribers(\/|$)/, "subscribers"],
  [/^\/calendar(\/|$)/, "calendar"],
];
export function helpFor(pathname: string): string {
  const area = HELP_AREAS.find(([pattern]) => pattern.test(pathname))?.[1];
  return area ? `/help#how-${area}` : "/help";
}

/** How many characters of the path a page route covers, matching whole segments; -1 if it doesn't. */
function covers(route: string, pathname: string): number {
  const r = route.length > 1 ? route.replace(/\/+$/, "") : route;
  if (pathname === r) return r.length;
  return pathname.startsWith(r.endsWith("/") ? r : `${r}/`) ? r.length : -1;
}

/**
 * Pages written for work this reader can't do on a route. Help skips them there, so the reader
 * lands on a page that fits (or on How do I…) instead.
 */
const DOES_NOT_FIT: { manual: string; page?: string; when: (s: SessionValue, route: string) => boolean }[] = [
  // The release editor's pages are about changing releases; site editors and viewers only read them.
  { manual: "nrms-editor", when: (s) => !canEditReleases(s) },
  // This page says Website is view-only for a Core administrator, which isn't so for one who is
  // also a site editor: the Site editor's pages fit them, except on the Blue Bridge switch.
  { manual: "core-admin", page: "website-project-blue-bridge", when: (s, route) => canEditWebsite(s) && route !== "/website/blue-bridge" },
];

function fits(page: { manual: string; id: string }, route: string, s: SessionValue): boolean {
  return !DOES_NOT_FIT.some((rule) => rule.manual === page.manual && (rule.page === undefined || rule.page === page.id) && rule.when(s, route));
}

/**
 * Where the header's Help opens: the manual page this reader may open whose `routes` match the
 * longest prefix of the path (their own manual first on a tie), leaving out routes on pages that
 * don't fit the reader's work there; otherwise the area's How do I…; otherwise the Help page.
 */
export function helpTargetFor(pathname: string, s: SessionValue, data: ManualsData = MANUALS_DATA): string {
  let best: { page: { manual: string; id: string }; length: number } | null = null;
  for (const page of visiblePages(data, s)) {
    const length = Math.max(-1, ...page.routes.filter((r) => fits(page, r, s)).map((r) => covers(r, pathname)));
    // Strictly longer wins, so on a tie the earlier page (own manual first) stays.
    if (length >= 0 && (!best || length > best.length)) best = { page, length };
  }
  return best ? `/help/manuals/${best.page.manual}/${best.page.id}` : helpFor(pathname);
}
