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
