import type { MinistryPageLabels } from "@gcpe/site-settings";
import type { MinistryDto } from "../dto";
import { e, safeHref, type SiteInfo } from "../render";
import { settingsHref } from "../settings";
import { factsheetsPath } from "../site-paths";

export interface SideLink {
  text: string;
  url: string | null | undefined;
}

export interface SideLinkGroup {
  heading: string;
  links: SideLink[];
}

/** A side-column link list's items. Links whose URL is not safe (absolute http/https, or
 * site-relative; no javascript:/data:) are dropped; "/..." resolves under the base path (the
 * settings rule) and anything else goes through safeHref. */
export function sideLinkItems(site: Pick<SiteInfo, "baseUrl">, links: SideLink[]): string[] {
  return links.flatMap((l) => {
    const href = l.url?.startsWith("/") ? settingsHref(l.url, site) : safeHref(l.url);
    return href ? [`<li><a href="${e(href)}">${e(l.text)}</a></li>`] : [];
  });
}

/** A side-column group in legacy's `div.resource-links` (its h3, one level up as h2); empty → "". */
export function resourceLinks(site: Pick<SiteInfo, "baseUrl">, heading: string, links: SideLink[]): string {
  const items = sideLinkItems(site, links);
  return items.length ? `<div class="resource-links">\n<h2>${e(heading)}</h2>\n<ul>\n${items.join("\n")}\n</ul>\n</div>` : "";
}

/** A ministry's More from this Ministry (Factsheets, website, photos, videos — legacy MoreFromThis;
 * "Factsheets" is legacy's own hardcoded text, not a setting), Featured Topics and Featured Services (legacy PopularTopics and
 * Resources), headed with the settings labels. */
export function ministryLinkGroups(site: Pick<SiteInfo, "baseUrl">, m: MinistryDto, labels: MinistryPageLabels): SideLinkGroup[] {
  return [
    {
      heading: labels.moreFromMinistry,
      links: [
        // Site-relative: sideLinkItems adds the base path.
        { text: "Factsheets", url: factsheetsPath(m.key) },
        { text: labels.ministryWebsite, url: m.ministryUrl },
        { text: labels.ministryPhotos, url: m.flickrUri },
        { text: labels.ministryVideos, url: m.youtubeUri },
      ],
    },
    { heading: labels.featuredTopics, links: (m.topicLinks ?? []).map((l) => ({ text: l.key, url: l.uri })) },
    { heading: labels.featuredServices, links: (m.serviceLinks ?? []).map((l) => ({ text: l.key, url: l.uri })) },
  ];
}
