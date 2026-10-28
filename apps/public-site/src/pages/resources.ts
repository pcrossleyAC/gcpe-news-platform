import type { ResourceLinkDto } from "../dto";
import { e, safeHref, type SiteInfo } from "../render";
import { settingsHref } from "../settings";

/** A Resources link's href: a "/…" path is a page on this site and gets the base path (the
 * settingsHref rule, so "/contacts/" reaches our Media Contacts page wherever the site is mounted);
 * anything else goes through safeHref. Null when unsafe. */
export function resourceHref(uri: string, site: Pick<SiteInfo, "baseUrl">): string | null {
  return typeof uri === "string" && uri.startsWith("/") ? settingsHref(uri, site) : safeHref(uri);
}

/** The Resources box (home's side column and /connect/'s): a heading and the links, an unsafe one as plain text. Empty with no links. */
export function resourcesBox(site: SiteInfo, heading: string, links: ResourceLinkDto[]): string {
  if (links.length === 0) return "";
  const item = (l: ResourceLinkDto) => {
    const href = resourceHref(l.uri, site);
    return href ? `<li><a href="${e(href)}">${e(l.key)}</a></li>` : `<li>${e(l.key)}</li>`;
  };
  return `<div class="resource-links">\n<h2>${e(heading)}</h2>\n<ul>\n${links.map(item).join("\n")}\n</ul>\n</div>`;
}
