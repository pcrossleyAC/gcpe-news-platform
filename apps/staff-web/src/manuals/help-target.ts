import type { ManualsData } from "../../../../scripts/manuals-lib.mjs";
import type { SessionValue } from "../session/SessionContext";
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
 * Where the header's Help opens: the manual page this reader may open whose `routes` match the
 * longest prefix of the path (their own manual first on a tie); otherwise the area's How do I…;
 * otherwise the Help page.
 */
export function helpTargetFor(pathname: string, s: SessionValue, data: ManualsData = MANUALS_DATA): string {
  let best: { page: { manual: string; id: string }; length: number } | null = null;
  for (const page of visiblePages(data, s)) {
    const length = Math.max(-1, ...page.routes.map((r) => covers(r, pathname)));
    // Strictly longer wins, so on a tie the earlier page (own manual first) stays.
    if (length >= 0 && (!best || length > best.length)) best = { page, length };
  }
  return best ? `/help/manuals/${best.page.manual}/${best.page.id}` : helpFor(pathname);
}
