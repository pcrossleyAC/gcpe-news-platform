import { hasPublishOption, imageTypeFromBytes, justifyFromLegacy, PUBLISH_OPTIONS, RELEASE_TYPE_TO_KIND, wallClockToInstant } from "@gcpe/legacy-import";
import { POST_KIND, type Layout, type ReleaseStatus, type ReleaseType } from "@gcpe/nrms-contract";
import type { documentContacts, documentLanguages, newsReleases, releaseDocuments, releaseLanguages } from "../db/schema";

export { imageTypeFromBytes, justifyFromLegacy };

// --- Type map (spec §8): legacy ReleaseType 1..5 → release/story/factsheet/update/advisory. ---
// Derived from the single source of truth in @gcpe/legacy-import (RELEASE_TYPE_TO_KIND) rather
// than a private copy, via nrms-contract's own singular→plural map (POST_KIND) — so a change to
// either map breaks this (and the pinning test in map.test.ts), instead of silently drifting.
const KIND_TO_RELEASE_TYPE: Record<string, ReleaseType> = Object.fromEntries(
  (Object.entries(POST_KIND) as [ReleaseType, string][]).map(([type, kind]) => [kind, type]),
);

export function releaseTypeFromLegacy(value: number): ReleaseType {
  const kind = (RELEASE_TYPE_TO_KIND as Record<number, string>)[value];
  const type = kind ? KIND_TO_RELEASE_TYPE[kind] : undefined;
  if (!type) throw new Error(`Unknown legacy ReleaseType ${value}`);
  return type;
}

// Legacy: Gcpe.Hub.Data_Legacy/Entity/PageLayout.cs — Formal = 1, Informal = 2.
export function layoutFromLegacy(value: number): Layout {
  if (value === 1) return "formal";
  if (value === 2) return "informal";
  throw new Error(`Unknown legacy PageLayout ${value}`);
}

/**
 * The collection (NewsReleaseCollection.Name) whose name's last 4-digit year is the highest —
 * e.g. `'2017-2021'` beats `'2013-2017'`. Ties are broken by name; a name with no 4-digit year
 * at all sorts last (never preferred over a dated name).
 */
export function newestTerm(names: string[]): string {
  const yearOf = (name: string): number => {
    const years = name.match(/\d{4}/g);
    return years ? Math.max(...years.map(Number)) : -Infinity;
  };
  const [first] = [...names].sort((a, b) => {
    const byYear = yearOf(b) - yearOf(a);
    return byYear !== 0 ? byYear : a.localeCompare(b);
  });
  if (first === undefined) throw new Error("newestTerm requires at least one name");
  return first;
}

// --- Status map (Global Constraints / spec §8), checked in this order. ---
export interface LegacyStatusRow {
  IsActive: boolean;
  IsCommitted: boolean;
  IsPublished: boolean;
  Reference: string | null;
}

export function statusFromLegacy(row: LegacyStatusRow): { status: ReleaseStatus; live: boolean; onHold: boolean; note: string | null } {
  if (!row.IsActive) return { status: "deleted", live: false, onHold: false, note: null };
  if (row.IsCommitted && row.IsPublished) return { status: "published", live: true, onHold: false, note: null };
  if (row.IsCommitted && !row.IsPublished) return { status: "scheduled", live: false, onHold: true, note: null };
  if (row.Reference) return { status: "approved", live: false, onHold: false, note: null };
  if (row.IsPublished && !row.IsCommitted) {
    return { status: "draft", live: false, onHold: false, note: "Imported as a draft: legacy marked it published but not committed" };
  }
  return { status: "draft", live: false, onHold: false, note: null };
}

// --- dbo.NewsRelease → news_releases ---
export interface LegacyReleaseRow extends Record<string, unknown> {
  Id: string;
  ReleaseType: number;
  Key: string;
  Reference: string | null;
  Year: number | null;
  YearRelease: number | null;
  MinistryRelease: number | null;
  ActivityId: number | null;
  ReleaseDateTime: Date | null;
  PublishDateTime: Date | null;
  IsCommitted: boolean;
  IsPublished: boolean;
  PublishOptions: number;
  IsActive: boolean;
  HasMediaAssets: boolean;
  HasTranslations: boolean;
  NodSubscribers: number | null;
  MediaSubscribers: number | null;
  AtomId: string | null;
  Keywords: string | null;
  AssetUrl: string | null;
  RedirectUrl: string | null;
  /** Joined from dbo.Ministry via NewsRelease.MinistryId, in the releases(year) query itself. */
  LeadMinistryKey: string | null;
}

export interface MapReleaseContext {
  /** Resolved from NewsRelease.CollectionId → NewsReleaseCollection.Name → newestTerm() → government_terms, by the caller. */
  governmentTermId: string | null;
  /** The tenant's time zone (e.g. "America/Vancouver") — C1: `ReleaseDateTime` is a legacy
   * `DATETIME` (no offset), set by legacy as server-local wall-clock time and decoded by
   * tedious as UTC, so it must be converted back to a real instant through this before use. */
  timeZone: string;
}

export type NewNewsReleaseRow = typeof newsReleases.$inferInsert;

export function mapRelease(row: LegacyReleaseRow, ctx: MapReleaseContext): NewNewsReleaseRow {
  const { status, live, onHold } = statusFromLegacy(row);
  const type = releaseTypeFromLegacy(row.ReleaseType);
  return {
    legacyId: row.Id.toLowerCase(),
    type,
    key: row.Key,
    reference: row.Reference ? row.Reference : null,
    year: row.Year,
    yearRelease: row.YearRelease,
    ministryRelease: row.MinistryRelease,
    termId: ctx.governmentTermId,
    leadMinistryKey: row.LeadMinistryKey,
    activityId: row.ActivityId,
    status,
    // PublishDateTime is DATETIMEOFFSET — already a real instant. ReleaseDateTime is DATETIME —
    // legacy wall-clock time decoded as UTC by tedious — so it must be converted (C1).
    publishAt: row.PublishDateTime,
    releasedAt: row.ReleaseDateTime ? wallClockToInstant(row.ReleaseDateTime, ctx.timeZone) : null,
    onHold,
    live,
    // Legacy NewModel.cs: Advisories are never published to the website, regardless of
    // PublishOptions (nrms-contract's own rule, packages/nrms-contract/src/rules.ts:39).
    toWeb: type !== "advisory",
    toSubscribers: hasPublishOption(row.PublishOptions, PUBLISH_OPTIONS.NewsOnDemand),
    toMediaLists: hasPublishOption(row.PublishOptions, PUBLISH_OPTIONS.MediaContacts),
    assetUrl: row.AssetUrl ? row.AssetUrl : null,
    hasMediaAssets: Boolean(row.HasMediaAssets),
    hasTranslations: Boolean(row.HasTranslations),
    redirectUrl: row.RedirectUrl ? row.RedirectUrl : null,
    keywords: row.Keywords ? row.Keywords : null,
    atomId: row.AtomId ? row.AtomId : null,
    nodSubscribers: row.NodSubscribers,
    mediaSubscribers: row.MediaSubscribers,
    version: 1,
    importedVersion: 1,
  };
}

// --- dbo.NewsReleaseLanguage → release_languages ---
export interface LegacyReleaseLanguageRow extends Record<string, unknown> {
  ReleaseId: string;
  LanguageId: number;
  Location: string | null;
  Summary: string | null;
  SocialMediaSummary: string | null;
}

export type NewReleaseLanguageRow = typeof releaseLanguages.$inferInsert;

/** `summaryEdited` is always true: legacy has no such flag, and an imported summary must never be auto-regenerated. */
export function mapReleaseLanguage(row: LegacyReleaseLanguageRow, releaseId: string): NewReleaseLanguageRow {
  return {
    releaseId,
    languageId: row.LanguageId,
    location: row.Location ?? "",
    summary: row.Summary ?? "",
    summaryEdited: true,
    socialMediaSummary: row.SocialMediaSummary,
  };
}

// --- dbo.NewsReleaseDocument → release_documents ---
export interface LegacyDocumentRow extends Record<string, unknown> {
  Id: string;
  ReleaseId: string;
  SortIndex: number;
  PageLayout: number;
}

export type NewReleaseDocumentRow = typeof releaseDocuments.$inferInsert;

export function mapDocument(row: LegacyDocumentRow, releaseId: string): NewReleaseDocumentRow {
  return { releaseId, sortIndex: row.SortIndex, layout: layoutFromLegacy(row.PageLayout) };
}

// --- dbo.NewsReleaseDocumentLanguage → document_languages ---
export interface LegacyDocumentLanguageRow extends Record<string, unknown> {
  DocumentId: string;
  LanguageId: number;
  PageImageId: string | null;
  PageTitle: string | null;
  Organizations: string | null;
  Headline: string | null;
  Subheadline: string | null;
  Byline: string | null;
  BodyHtml: string | null;
}

export type NewDocumentLanguageRow = typeof documentLanguages.$inferInsert;

/** `pageImageId` is the already-resolved NRMS page_images.id (via that table's legacy_id), supplied by the caller. */
export function mapDocumentLanguage(row: LegacyDocumentLanguageRow, documentId: string, pageImageId: string | null): NewDocumentLanguageRow {
  return {
    documentId,
    languageId: row.LanguageId,
    pageTitle: row.PageTitle ?? "",
    headline: row.Headline ?? "",
    subheadline: row.Subheadline,
    organizations: row.Organizations,
    byline: row.Byline,
    bodyHtml: row.BodyHtml ?? "",
    pageImageId,
  };
}

// --- dbo.[User] → legacy user id → Core user (spec §8; Core's own importLegacyUsers does the
// matching/creation). This purely joins legacy User rows to the email map Core's importer
// returns, for Task 5's orchestrator to resolve release_log actors by legacy user id. ---
export interface LegacyUserRow extends Record<string, unknown> {
  Id: string;
  DisplayName: string | null;
  EmailAddress: string | null;
}

export function legacyUserMap(
  rows: LegacyUserRow[],
  emailMap: Map<string, { id: string; displayName: string }>,
): Map<string, { id: string; displayName: string }> {
  const result = new Map<string, { id: string; displayName: string }>();
  for (const row of rows) {
    const email = row.EmailAddress?.trim().toLowerCase();
    if (!email) continue;
    const core = emailMap.get(email);
    if (!core) continue;
    result.set(row.Id.toLowerCase(), core);
  }
  return result;
}

// --- dbo.NewsReleaseDocumentContact → document_contacts ---
export interface LegacyContactRow extends Record<string, unknown> {
  DocumentId: string;
  LanguageId: number;
  SortIndex: number;
  Information: string;
}

export type NewDocumentContactRow = typeof documentContacts.$inferInsert;

/** The raw `Information` string is copied as is — NRMS splits it into title/details at render time, not at import. */
export function mapContact(row: LegacyContactRow, documentId: string): NewDocumentContactRow {
  return { documentId, languageId: row.LanguageId, sortIndex: row.SortIndex, information: row.Information };
}
