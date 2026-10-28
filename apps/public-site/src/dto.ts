import type { OrgRecord } from "@gcpe/events";
import type { SiteSettings } from "@gcpe/site-settings";

export interface PostDocument {
  languageId: number;
  headline: string | null;
  subheadline: string | null;
  detailsHtml: string | null;
  contacts: { title: string | null; details: string | null }[];
  /** v1 `Post.documents[].pageTitle`; optional, so an older News API's answer still fits. */
  pageTitle?: string | null;
  /** v1 `Post.documents[].byline`. */
  byline?: string | null;
}
export interface AssetDto {
  /** An absolute file URL (NRMS's PUBLIC_FILES_BASE + /files/…). */
  key: string | null;
  label: string | null;
  length: number | null;
}
export interface PostDto {
  key: string;
  kind: string;
  /** BC-local ISO date with offset, e.g. 2026-10-03T10:00:00-07:00 (News API formatOffsetDateTime). */
  publishDate: string;
  summary: string | null;
  location: string | null;
  leadMinistryKey?: string | null;
  ministryKeys: string[];
  sectorKeys?: string[];
  themeKeys?: string[];
  tagKeys?: string[];
  documents: PostDocument[];
  azureAssets?: AssetDto[] | null;
  azureTranslations?: AssetDto[] | null;
  /** v1 flags for PostCard's Media Assets and Translations links; absent ⇒ neither shows. */
  hasMediaAssets?: boolean | null;
  hasTranslations?: boolean | null;
  /** v1 lead media URL (a Flickr photo, a YouTube video, the live webcast): pages/media.ts's leadMedia. */
  assetUrl?: string | null;
}

export interface HomeDto {
  granville: string | null;
  topPostKey: string | null;
  featurePostKey: string | null;
}

/** A ministry media contact as the News API's v1 Ministries endpoints carry it: Core's own
 * contact record (packages/events contactSchema), passed through unchanged by toMinistryDto. */
export type MinistryContactDto = NonNullable<OrgRecord["contact"]>;

export interface MinistryDto {
  key: string;
  name: string;
  isActive: boolean;
  /** The parent ministry's key; null or absent for a top-level ministry. */
  parentMinistryKey?: string | null;
  ministerName: string | null;
  ministryUrl: string | null;
  contactUser: MinistryContactDto | null;
  secondContactUser: MinistryContactDto | null;
  weekendContactNumber: string | null;
  /** Featured links; the News API's ResourceLink is `{ key: text, uri: url, timestamp }`. */
  topicLinks: ResourceLinkDto[];
  serviceLinks: ResourceLinkDto[];
  flickrUri: string | null;
  youtubeUri: string | null;
  topPostKey: string | null;
  featurePostKey: string | null;
}

export interface MinisterDto {
  headline: string | null;
  summary: string | null;
  details: string | null;
  photo: string | null;
}

export interface CategoryDto {
  key: string;
  kind: string;
  name: string;
  isActive: boolean;
  topPostKey: string | null;
  featurePostKey: string | null;
}

export interface SlideDto {
  key: string;
  headline: string | null;
  summary: string | null;
  actionUri: string | null;
  actionLabel: string | null;
  /** True for one of NRMS's two pinned emergency slides (addendum §6.4); shown in the home
   * page's "Emergency information" region, above the ordinary Highlights. */
  emergency: boolean;
  /** The slide's content-addressed image URL, or null when it has none. */
  imageUrl: string | null;
  sortIndex: number;
  /** v2 slide text alignment; optional, so an older News API's answer still fits. */
  justify?: string | null;
}

/** `GET /api/v2/ministries`: minister email, Meet the Team links and active child ministries. */
export interface MinistryProfileDto {
  key: string;
  ministerEmail: string | null;
  teamLinks: { text: string; url: string }[];
  childKeys: string[];
}

export interface ResourceLinkDto {
  uri: string;
  key: string;
}

export interface RelatedPost {
  key: string;
  headline: string;
  publishDate: string;
}

/** `GET /api/v2/site-settings` (the News API's newest published revision), less `publishedAt`. */
export interface SiteSettingsDto {
  revision: number;
  document: SiteSettings;
}

/** One public government term (`GET /api/v2/government-terms`). Newest first in the payload; the newest has no end date. */
export interface GovernmentTermDto {
  slug: string;
  label: string | null;
  /** BC calendar date, `YYYY-MM-DD`. */
  startDate: string;
  endDate: string | null;
  legacyArchiveUrl: string | null;
}

/** `GET /api/v2/government-terms`: NRMS's published snapshot (past and current terms only). */
export interface GovernmentTermsDto {
  publishedAt: string;
  currentSlug: string | null;
  terms: GovernmentTermDto[];
}
