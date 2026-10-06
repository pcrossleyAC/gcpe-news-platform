import type { ReleaseRecord } from "@gcpe/events";
import { hasPublishOption, imageTypeFromBytes, justifyFromLegacy, PUBLISH_OPTIONS, releaseKindFromLegacy } from "@gcpe/legacy-import";

export { imageTypeFromBytes, justifyFromLegacy };

export interface LegacyReleaseRow extends Record<string, unknown> {
  Id: string;
  Key: string;
  ReleaseType: number;
  Reference: string | null;
  AtomId: string | null;
  PublishDateTime: Date;
  LeadMinistryKey: string | null;
  Keywords: string | null;
  AssetUrl: string | null;
  RedirectUrl: string | null;
  HasMediaAssets: boolean;
  PublishOptions: number;
  Timestamp: Date;
  Location: string | null;
  Summary: string | null;
  SocialMediaHeadline: string | null;
  SocialMediaSummary: string | null;
}

export interface LegacyDocumentRow extends Record<string, unknown> {
  ReleaseId: string;
  DocumentId: string;
  SortIndex: number;
  LanguageId: number;
  PageTitle: string | null;
  Headline: string | null;
  Subheadline: string | null;
  Byline: string | null;
  BodyHtml: string | null;
}

export interface LegacyContactRow extends Record<string, unknown> {
  DocumentId: string;
  LanguageId: number;
  SortIndex: number;
  Information: string;
}

export interface LegacyIndexRow extends Record<string, unknown> {
  ReleaseId: string;
  IndexKind: "ministries" | "sectors" | "tags" | "themes";
  IndexKey: string;
}

export function splitContact(information: string): { title: string; details: string } {
  const [title = "", ...rest] = information.split(/\r?\n/);
  return { title, details: rest.join("\n") };
}

const languageOrder = (id: number) => (id === 4105 ? 0 : 1);

export function mapLegacyRelease(
  row: LegacyReleaseRow,
  docs: LegacyDocumentRow[],
  contacts: LegacyContactRow[],
  indexes: LegacyIndexRow[],
): ReleaseRecord {
  const kind = releaseKindFromLegacy(row.ReleaseType) as ReleaseRecord["kind"];
  const keysOf = (k: LegacyIndexRow["IndexKind"]) => indexes.filter((i) => i.IndexKind === k).map((i) => i.IndexKey).sort();
  const documents = [...docs]
    .sort((a, b) => a.SortIndex - b.SortIndex || languageOrder(a.LanguageId) - languageOrder(b.LanguageId) || a.LanguageId - b.LanguageId)
    .map((d) => ({
      pageTitle: d.PageTitle,
      languageId: d.LanguageId,
      headline: d.Headline,
      subheadline: d.Subheadline,
      detailsHtml: d.BodyHtml,
      byline: d.Byline,
      contacts: contacts
        .filter((c) => c.DocumentId.toLowerCase() === d.DocumentId.toLowerCase() && c.LanguageId === d.LanguageId)
        .sort((a, b) => a.SortIndex - b.SortIndex)
        .map((c) => splitContact(c.Information)),
    }));
  const isNewsOnDemand = hasPublishOption(row.PublishOptions, PUBLISH_OPTIONS.NewsOnDemand);
  return {
    key: row.Key,
    kind,
    reference: row.Reference,
    atomId: row.AtomId ? row.AtomId : `uuid:${row.Id.toLowerCase()}`,
    publishDate: row.PublishDateTime.toISOString(),
    leadMinistryKey: row.LeadMinistryKey,
    summary: row.Summary,
    socialMediaSummary: row.SocialMediaSummary,
    socialMediaHeadline: row.SocialMediaHeadline,
    keywords: row.Keywords,
    location: row.Location,
    hasMediaAssets: Boolean(row.HasMediaAssets),
    hasTranslations: false,
    isNewsOnDemand,
    assetUrl: row.AssetUrl,
    redirectUri: row.RedirectUrl ? row.RedirectUrl : null,
    documents,
    ministryKeys: keysOf("ministries"),
    sectorKeys: keysOf("sectors"),
    tagKeys: keysOf("tags"),
    themeKeys: keysOf("themes"),
    assets: null,
    translations: null,
    publishFlags: { toWeb: true, toSubscribers: isNewsOnDemand, toMediaLists: hasPublishOption(row.PublishOptions, PUBLISH_OPTIONS.MediaContacts) },
    mediaListKeys: [],
    renditions: null,
    timestamp: row.Timestamp.toISOString(),
  };
}
