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
