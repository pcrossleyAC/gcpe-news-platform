/**
 * C324: the Hub's ministry preview. Core sends the organization record a save would store; this
 * renders the ministry page and the biography page from it, with the site's current settings and
 * the ministry's current posts, and writes nothing.
 */
import type { OrgRecord } from "@gcpe/events";
import type { MinisterDto, MinistryDto, MinistryProfileDto } from "./dto";
import { ministryMenu } from "./ministry-menu";
import { turnOptions, type SyncDeps } from "./sync";
import type { MinistryOverride } from "./builder";
import type { SiteStorage } from "./storage";
import { basePath } from "./render";

/** The record's part of a ministry, as the News API maps it (apps/news-api/src/dto.ts
 * toMinistryDto); its top and feature posts are the live ministry's, which the record doesn't hold. */
export function ministryFromOrg(org: OrgRecord, live: MinistryDto | null): MinistryDto {
  const link = (l: { text: string; url: string }) => ({ uri: l.url, key: l.text });
  return {
    key: live?.key ?? org.key,
    name: org.displayName,
    isActive: org.isActive,
    parentMinistryKey: org.parentKey,
    displayAdditionalName: org.displayAdditionalName,
    ministerName: org.minister.name,
    ministryUrl: org.url,
    contactUser: org.contact,
    secondContactUser: org.secondContact,
    weekendContactNumber: org.weekendContactNumber,
    topicLinks: org.topicLinks.map(link),
    serviceLinks: org.serviceLinks.map(link),
    flickrUri: org.social.flickrUrl,
    youtubeUri: org.social.youtubeUrl,
    topPostKey: live?.topPostKey ?? null,
    featurePostKey: live?.featurePostKey ?? null,
  };
}

/** As the News API's toMinisterDto. */
export function ministerFromOrg(org: OrgRecord): MinisterDto {
  return { headline: org.minister.name, summary: org.minister.summary, details: org.minister.detailsHtml, photo: org.minister.photoUrl };
}

/** As the News API's v2 profile; the ministries of state under it are the live ones. */
export function profileFromOrg(org: OrgRecord, live: MinistryProfileDto | null): MinistryProfileDto {
  return { key: live?.key ?? org.key, ministerEmail: org.minister.email, teamLinks: org.teamLinks ?? [], childKeys: live?.childKeys ?? [] };
}

/** The icon sprite in the output folder (site-assets.ts writes it there). */
export const ICON_SPRITE = "assets/site/icons.svg";

/**
 * A rendered page made safe to show inside the Hub: never indexed, and every link opens in a new
 * tab instead of navigating the preview's frame. The Hub's frame has an opaque origin, from which a
 * browser never follows an `<svg><use>` into another file, so the icon sprite (`sprite`, null when
 * the output folder has none yet) goes inside the page and the icons point at it there.
 */
export function previewDocument(html: string, base: string, sprite: string | null): string {
  let doc = html.replace(/<head>/i, '<head>\n<meta name="robots" content="noindex">\n<base target="_blank">');
  if (sprite !== null) {
    const file = `${base}/${ICON_SPRITE}`;
    const svg = sprite.replace(/^<\?xml[^>]*>\s*/, "").replace(/<svg\b/, '<svg style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true"');
    doc = doc.split(`"${file}#`).join('"#').split(`data-icons="${file}"`).join('data-icons=""');
    doc = doc.replace(/<body\b[^>]*>/i, (open) => `${open}\n${svg}`);
  }
  return doc;
}

export async function previewMinistry(deps: SyncDeps, org: OrgRecord): Promise<{ ministryPage: string; biographyPage: string | null }> {
  const [{ granville }, ministries] = await Promise.all([deps.newsApi.home(), deps.newsApi.ministries()]);
  // Reading the settings also caches the published document on disk; a preview leaves that to the sync.
  const readOnly: SiteStorage = Object.assign(Object.create(deps.storage) as SiteStorage, { write: async () => {} });
  const { pageOpts } = await turnOptions({ ...deps, storage: readOnly }, granville, ministryMenu(ministries));
  const override: MinistryOverride = {
    ministry: (live) => ministryFromOrg(org, live),
    minister: ministerFromOrg(org),
    profile: (live) => profileFromOrg(org, live),
  };
  const [pages, sprite] = await Promise.all([deps.builder.previewMinistry(org.key, override, pageOpts), deps.storage.read(ICON_SPRITE)]);
  const wrap = (html: string) => previewDocument(html, basePath(deps.site), sprite);
  return { ministryPage: wrap(pages.ministryPage), biographyPage: pages.biographyPage === null ? null : wrap(pages.biographyPage) };
}
