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

/** A rendered page made safe to show inside the Hub: never indexed, and every link opens in a new
 * tab instead of navigating the preview's frame. */
export function previewDocument(html: string): string {
  return html.replace(/<head>/i, '<head>\n<meta name="robots" content="noindex">\n<base target="_blank">');
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
  const pages = await deps.builder.previewMinistry(org.key, override, pageOpts);
  return { ministryPage: previewDocument(pages.ministryPage), biographyPage: pages.biographyPage === null ? null : previewDocument(pages.biographyPage) };
}
