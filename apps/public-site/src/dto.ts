import type { SiteSettings } from "@gcpe/site-settings";

export interface PostDocument {
  languageId: number;
  headline: string | null;
  subheadline: string | null;
  detailsHtml: string | null;
  contacts: { title: string | null; details: string | null }[];
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
}

export interface HomeDto {
  granville: string | null;
  topPostKey: string | null;
  featurePostKey: string | null;
}

export interface MinistryDto {
  key: string;
  name: string;
  isActive: boolean;
  ministerName: string | null;
  ministryUrl: string | null;
  contactUser: unknown;
  secondContactUser: unknown;
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
