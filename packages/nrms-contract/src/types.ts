export const RELEASE_TYPES = ["release", "story", "factsheet", "update", "advisory"] as const;
export type ReleaseType = (typeof RELEASE_TYPES)[number];
/** Update can't be created (legacy New.aspx has it commented out); imported Updates stay editable. */
export const CREATABLE_TYPES = ["release", "story", "factsheet", "advisory"] as const;
export const RELEASE_STATUSES = ["draft", "approved", "scheduled", "publishing", "published", "unpublishing", "failed", "deleted"] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];
export const LANG_EN = 4105;
export const LANG_FR = 3084;
export type LanguageId = typeof LANG_EN | typeof LANG_FR;
export const LANGUAGE_NAME: Record<LanguageId, string> = { 4105: "English", 3084: "French" };
export const LAYOUTS = ["formal", "informal"] as const;
export type Layout = (typeof LAYOUTS)[number];
export const CATEGORY_KINDS = ["ministries", "sectors", "themes", "tags"] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export const POST_KIND = { release: "releases", story: "stories", factsheet: "factsheets", update: "updates", advisory: "advisories" } as const satisfies Record<ReleaseType, string>;
export const TYPE_LABEL: Record<ReleaseType, string> = { release: "Release", story: "Story", factsheet: "Factsheet", update: "Update", advisory: "Advisory" };

export interface PublishOptions {
  toWeb: boolean;
  toSubscribers: boolean;
  toMediaLists: boolean;
}

export interface ReleaseLanguageView {
  languageId: LanguageId;
  location: string;
  summary: string;
  summaryEdited: boolean;
  socialMediaSummary: string | null;
}

export interface DocumentLanguageView {
  languageId: LanguageId;
  pageTitle: string;
  headline: string;
  subheadline: string | null;
  organizations: string | null;
  byline: string | null;
  bodyHtml: string;
  pageImageId: string | null;
  /** Ordered contact blocks; first line is the title (as the News API splits them). */
  contacts: string[];
}

export interface DocumentView {
  id: string;
  sortIndex: number;
  layout: Layout;
  languages: DocumentLanguageView[];
}

/** An uploaded translation PDF or media asset file. `url` is the public path, `/files/<key>`. */
export interface ReleaseFileView {
  id: string;
  kind: "translation" | "asset";
  /** The original file name, for display only (never used as a path). */
  label: string;
  url: string;
  contentType: string;
  size: number;
}

export interface ReleaseView {
  id: string;
  type: ReleaseType;
  key: string | null;
  reference: string | null;
  status: ReleaseStatus;
  onHold: boolean;
  version: number;
  leadMinistryKey: string | null;
  activityId: number | null;
  /** ISO 8601; planned (draft/approved) or committed (scheduled+) publish time. */
  publishAt: string | null;
  releasedAt: string | null;
  publishOptions: PublishOptions;
  assetUrl: string | null;
  assetAltText: string | null;
  hasMediaAssets: boolean;
  hasTranslations: boolean;
  redirectUrl: string | null;
  keywords: string | null;
  atomId: string | null;
  nodSubscribers: number | null;
  mediaSubscribers: number | null;
  lastError: string | null;
  languages: ReleaseLanguageView[];
  documents: DocumentView[];
  ministries: string[];
  sectors: string[];
  themes: string[];
  tags: string[];
  mediaListKeys: string[];
  /** Uploaded translations and media files, oldest first. */
  files: ReleaseFileView[];
  createdAt: string;
  updatedAt: string;
}

export interface ReleaseListItem {
  id: string;
  type: ReleaseType;
  key: string | null;
  reference: string | null;
  status: ReleaseStatus;
  statusText: string;
  leadOrganization: string;
  pageTitle: string;
  headline: string;
  location: string;
  summary: string;
  publishAt: string | null;
  releasedAt: string | null;
  activityId: number | null;
  approved: boolean;
}

export interface ReleasePage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** GET /api/releases/:id/asset-status — what the release's media asset is and, for a Flickr
 * photo, whether it's public, private, gone, or can't be checked right now. */
export type AssetStatus =
  | { kind: "none" }
  | { kind: "youtube" }
  | { kind: "live" }
  | { kind: "flickr"; photoId: string; state: "public" | "private" | "missing" | "unavailable"; message: string };
