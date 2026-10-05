/**
 * Phase 3e (NRMS legacy importer, spec §8, task 3): every legacy release, in every status,
 * with its languages, documents (and their languages/contacts), categories, media lists and
 * log — plus Top/Feature slots and the approve-time number counters.
 *
 * Re-run safety (controller ruling): the NRMS row is locked by `legacy_id` FOR UPDATE. If its
 * `version` is already ahead of `imported_version`, someone edited it in NRMS since the last
 * import — it's left alone and reported. Otherwise the mapped release + all its children are
 * hashed (sha256 of a stable JSON form); an unchanged hash means no writes at all; a changed
 * (or brand new) hash writes the release row, bumps `version`, and replaces every child table
 * wholesale. The status-map note (§8's "Imported as a draft…" log line) is folded into that
 * same wholesale child set, so it's written exactly once per change and never duplicated by a
 * later no-op re-run.
 *
 * No outbox events, no flickr_jobs rows: everything here is a direct write to NRMS's own
 * tables, never through `mutateRelease`/the workflow functions (controller ruling).
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db, DbOrTx, Tx } from "@gcpe/db-kit";
import type { LegacySource } from "@gcpe/legacy-import";
import { publishProblems, type CategoryKind, type FeatureKind, type ReleaseStatus, type ReleaseType, type ReleaseView } from "@gcpe/nrms-contract";
import {
  categoryFeatures,
  categoryTerms,
  documentContacts,
  documentLanguages,
  newsReleases,
  organizations,
  releaseCategories,
  releaseDocuments,
  releaseLanguages,
  releaseLog,
  releaseMediaLists,
} from "../db/schema";
import { SYSTEM_ACTOR } from "../releases/store";
import {
  mapContact,
  mapDocument,
  mapDocumentLanguage,
  mapRelease,
  mapReleaseLanguage,
  statusFromLegacy,
  type LegacyContactRow,
  type LegacyDocumentLanguageRow,
  type LegacyDocumentRow,
  type LegacyReleaseLanguageRow,
  type LegacyReleaseRow,
} from "./map";
import {
  Q_APP_SETTINGS,
  Q_CATEGORY_FEATURES,
  Q_HISTORY_COUNT,
  Q_RELEASE_YEARS,
  documentContacts as qDocumentContacts,
  documentLanguages as qDocumentLanguages,
  documents as qDocuments,
  releaseCategories as qReleaseCategories,
  releaseLanguages as qReleaseLanguages,
  releaseLog as qReleaseLog,
  releaseMediaLists as qReleaseMediaLists,
  releases as qReleases,
} from "./queries";
import type { ImportReport } from "./report";

export interface ImportReleasesContext {
  pageImageIds: Map<string, string>;
  mediaListIds: Map<string, string>;
  termIds: Map<string, string>;
  users: Map<string, { id: string; displayName: string }>;
  report: ImportReport;
  timeZone: string;
}

// --- Raw legacy row shapes (beyond what map.ts's interfaces already declare). ---
interface RawReleaseRow extends LegacyReleaseRow {
  CollectionId: string | null;
}
interface RawCategoryRow extends Record<string, unknown> {
  ReleaseId: string;
  Kind: CategoryKind;
  Key: string;
}
interface RawMediaListRow extends Record<string, unknown> {
  ReleaseId: string;
  MediaDistributionListId: string;
}
interface RawLogRow extends Record<string, unknown> {
  Id: number;
  ReleaseId: string;
  DateTime: Date;
  UserId: string | null;
  Description: string;
}
interface RawHistoryRow extends Record<string, unknown> {
  ReleaseId: string;
  Count: number;
}
interface RawFeatureRow extends Record<string, unknown> {
  Kind: "ministries" | "sectors" | "themes";
  Key: string;
  TopReleaseId: string | null;
  FeatureReleaseId: string | null;
}
interface RawAppSettingRow extends Record<string, unknown> {
  SettingName: string;
  SettingValue: string;
}

const SINGULAR: Record<CategoryKind, string> = { ministries: "ministry", sectors: "sector", themes: "theme", tags: "tag" };

function groupBy<T>(rows: T[], keyOf: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row).toLowerCase();
    const bucket = out.get(key);
    if (bucket) bucket.push(row);
    else out.set(key, [row]);
  }
  return out;
}

/** Deterministic across key order; array order is meaningful and must already be normalised by the caller. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

interface GroupedChildren {
  languages: LegacyReleaseLanguageRow[];
  documents: LegacyDocumentRow[];
  docLangsByDoc: Map<string, LegacyDocumentLanguageRow[]>;
  contactsByDoc: Map<string, LegacyContactRow[]>;
  categories: RawCategoryRow[];
  mediaLists: RawMediaListRow[];
  logs: RawLogRow[];
}

function legacyChildCounts(g: GroupedChildren): Record<string, number> {
  const documentLanguageCount = g.documents.reduce((n, d) => n + (g.docLangsByDoc.get(d.Id.toLowerCase())?.length ?? 0), 0);
  const documentContactCount = g.documents.reduce((n, d) => n + (g.contactsByDoc.get(d.Id.toLowerCase())?.length ?? 0), 0);
  return {
    release_languages: g.languages.length,
    release_documents: g.documents.length,
    document_languages: documentLanguageCount,
    document_contacts: documentContactCount,
    release_categories: g.categories.length,
    release_media_lists: g.mediaLists.length,
    release_log: g.logs.length,
  };
}

function countLegacyChildren(report: ImportReport, g: GroupedChildren): void {
  for (const [table, n] of Object.entries(legacyChildCounts(g))) report.count(table, "legacy", n);
}

/**
 * Counts every child row as imported, except `release_categories`/`release_media_lists`
 * whose *dropped* rows were already counted "skipped" inside `buildBundle` (category/media-
 * list validation runs there unconditionally, before the hash check, so it must not be
 * double-counted here on the no-op path too).
 */
function countChildrenImported(report: ImportReport, g: GroupedChildren, bundle: Bundle): void {
  const counts = legacyChildCounts(g);
  const overrides: Partial<Record<string, number>> = {
    release_categories: bundle.categories.length,
    release_media_lists: bundle.mediaListIds.length,
  };
  for (const [table, legacy] of Object.entries(counts)) {
    const imported = overrides[table] ?? legacy;
    if (imported > 0) report.count(table, "imported", imported);
  }
}

function skipChildrenEntirely(report: ImportReport, legacyId: string, g: GroupedChildren, reason: string): void {
  for (const [table, n] of Object.entries(legacyChildCounts(g))) for (let i = 0; i < n; i++) report.skip(table, legacyId, reason);
}

interface MappedDocument {
  sortIndex: number;
  layout: "formal" | "informal";
  languages: ReturnType<typeof mapDocumentLanguage>[];
  contacts: ReturnType<typeof mapContact>[];
}

interface Bundle {
  release: ReturnType<typeof mapRelease>;
  status: ReleaseStatus;
  statusNote: string | null;
  languages: ReturnType<typeof mapReleaseLanguage>[];
  documents: MappedDocument[];
  categories: { kind: CategoryKind; key: string }[];
  mediaListIds: string[];
  logEntries: { at: Date; actorId: string; actorName: string; text: string }[];
  hash: string;
}

/** Legacy user ids resolve through ctx.users (built by legacyUserMap in Task 5's orchestrator); anything else is SYSTEM_ACTOR. */
function actorOf(userId: string | null, ctx: ImportReleasesContext): { id: string; name: string } {
  if (!userId) return SYSTEM_ACTOR;
  const core = ctx.users.get(userId.toLowerCase());
  return core ? { id: core.id, name: core.displayName } : SYSTEM_ACTOR;
}

/**
 * Pure (DB reads aside, for category/media-list validation): builds the release + every child
 * row from legacy data, plus the content hash used to decide whether a re-run is a no-op.
 * Unknown category keys are dropped (and warned); unknown media list ids are dropped (and
 * warned); an unresolvable document page image is nulled (and warned). None of those three
 * participate in the content hash as anything other than their *validated* result, since a
 * dropped reference is the actual imported content, not a transient error.
 */
async function buildBundle(
  tx: DbOrTx,
  raw: RawReleaseRow,
  g: GroupedChildren,
  ctx: ImportReleasesContext,
): Promise<Bundle> {
  const legacyId = raw.Id.toLowerCase();
  const governmentTermId = raw.CollectionId ? ctx.termIds.get(raw.CollectionId.toLowerCase()) ?? null : null;
  const leadMinistryKey = raw.LeadMinistryKey ? raw.LeadMinistryKey.toLowerCase() : null;
  const { status, note } = statusFromLegacy(raw);
  const release = mapRelease({ ...raw, LeadMinistryKey: leadMinistryKey }, { governmentTermId });

  const languages = [...g.languages]
    .sort((a, b) => a.LanguageId - b.LanguageId)
    .map((l) => mapReleaseLanguage(l, ""));

  const documents: MappedDocument[] = [...g.documents]
    .sort((a, b) => a.SortIndex - b.SortIndex)
    .map((d) => {
      const docId = d.Id.toLowerCase();
      const dls = [...(g.docLangsByDoc.get(docId) ?? [])]
        .sort((a, b) => a.LanguageId - b.LanguageId)
        .map((dl) => {
          let pageImageId: string | null = null;
          if (dl.PageImageId) {
            pageImageId = ctx.pageImageIds.get(dl.PageImageId.toLowerCase()) ?? null;
            if (!pageImageId) {
              ctx.report.warn(legacyId, raw.Key, [`Document references an unknown page image '${dl.PageImageId.toLowerCase()}'`]);
            }
          }
          return mapDocumentLanguage(dl, "", pageImageId);
        });
      const contacts = [...(g.contactsByDoc.get(docId) ?? [])]
        .sort((a, b) => a.SortIndex - b.SortIndex)
        .map((c) => mapContact(c, ""));
      const layout = mapDocument(d, "").layout ?? "formal";
      return { sortIndex: d.SortIndex, layout, languages: dls, contacts };
    });

  const categories = await validateCategories(tx, g.categories, ctx.report, legacyId, raw.Key);

  const mediaListIds: string[] = [];
  for (const m of g.mediaLists) {
    const id = ctx.mediaListIds.get(m.MediaDistributionListId.toLowerCase());
    if (id) mediaListIds.push(id);
    else {
      ctx.report.skip("release_media_lists", legacyId, `Unknown media distribution list '${m.MediaDistributionListId.toLowerCase()}'`);
      ctx.report.warn(legacyId, raw.Key, [`Unknown media distribution list '${m.MediaDistributionListId.toLowerCase()}'`]);
    }
  }

  const logEntries = [...g.logs]
    .sort((a, b) => a.Id - b.Id)
    .map((l) => {
      const actor = actorOf(l.UserId, ctx);
      return { at: l.DateTime, actorId: actor.id, actorName: actor.name, text: l.Description };
    });
  // The status-map note is an NRMS-synthesised entry, not a legacy log row — it never
  // participates in legacy/imported/skipped child counts, only the hash and the write.
  // Its timestamp is derived from legacy data (never wall-clock), so re-imports of unchanged
  // legacy data hash identically.
  if (note) {
    logEntries.push({ at: raw.ReleaseDateTime ?? raw.PublishDateTime ?? new Date(0), actorId: SYSTEM_ACTOR.id, actorName: SYSTEM_ACTOR.name, text: note });
  }

  const { version: _v, importedVersion: _iv, legacyId: _lid, ...releaseContent } = release;
  const content = {
    release: releaseContent,
    languages: languages.map(({ releaseId: _r, ...rest }) => rest),
    documents: documents.map((d) => ({
      sortIndex: d.sortIndex,
      layout: d.layout,
      languages: d.languages.map(({ documentId: _d, ...rest }) => rest),
      contacts: d.contacts.map(({ documentId: _d, ...rest }) => rest),
    })),
    categories: [...categories].sort((a, b) => (a.kind === b.kind ? a.key.localeCompare(b.key) : a.kind.localeCompare(b.kind))),
    mediaListIds: [...mediaListIds].sort(),
    logEntries: logEntries.map((e) => ({ ...e, at: e.at.toISOString() })).sort((a, b) => a.at.localeCompare(b.at) || a.text.localeCompare(b.text)),
  };

  return { release, status, statusNote: note, languages, documents, categories, mediaListIds, logEntries, hash: sha256(content) };
}

async function validateCategories(
  tx: DbOrTx,
  rows: RawCategoryRow[],
  report: ImportReport,
  legacyId: string,
  releaseKey: string,
): Promise<{ kind: CategoryKind; key: string }[]> {
  const byKind = new Map<CategoryKind, string[]>();
  for (const r of rows) {
    const key = r.Key.toLowerCase();
    byKind.set(r.Kind, [...(byKind.get(r.Kind) ?? []), key]);
  }
  const valid: { kind: CategoryKind; key: string }[] = [];
  for (const [kind, keysWithDupes] of byKind) {
    const keys = [...new Set(keysWithDupes)];
    const found =
      kind === "ministries"
        ? new Set((await tx.select({ k: organizations.key }).from(organizations).where(inArray(organizations.key, keys))).map((r) => r.k))
        : new Set(
            (await tx.select({ k: categoryTerms.key }).from(categoryTerms).where(and(eq(categoryTerms.kind, kind), inArray(categoryTerms.key, keys)))).map(
              (r) => r.k,
            ),
          );
    for (const key of keys) {
      if (found.has(key)) {
        valid.push({ kind, key });
      } else {
        report.skip("release_categories", legacyId, `Unknown ${SINGULAR[kind]} key '${key}'`);
        report.warn(legacyId, releaseKey, [`Unknown ${SINGULAR[kind]} key '${key}'`]);
      }
    }
  }
  return valid;
}

/** Builds a minimal but complete `ReleaseView` from the bundle, just for `publishProblems()`. */
function pseudoView(raw: RawReleaseRow, bundle: Bundle): ReleaseView {
  const cat = (kind: CategoryKind) => bundle.categories.filter((c) => c.kind === kind).map((c) => c.key);
  return {
    id: raw.Id.toLowerCase(),
    type: bundle.release.type as ReleaseType,
    key: raw.Key,
    reference: bundle.release.reference ?? null,
    status: bundle.status,
    onHold: Boolean(bundle.release.onHold),
    version: 1,
    leadMinistryKey: (bundle.release.leadMinistryKey as string | null) ?? null,
    activityId: (bundle.release.activityId as number | null) ?? null,
    publishAt: null,
    releasedAt: null,
    publishOptions: { toWeb: Boolean(bundle.release.toWeb), toSubscribers: Boolean(bundle.release.toSubscribers), toMediaLists: Boolean(bundle.release.toMediaLists) },
    assetUrl: (bundle.release.assetUrl as string | null) ?? null,
    assetAltText: null,
    hasMediaAssets: Boolean(bundle.release.hasMediaAssets),
    hasTranslations: Boolean(bundle.release.hasTranslations),
    redirectUrl: (bundle.release.redirectUrl as string | null) ?? null,
    keywords: (bundle.release.keywords as string | null) ?? null,
    atomId: (bundle.release.atomId as string | null) ?? null,
    nodSubscribers: (bundle.release.nodSubscribers as number | null) ?? null,
    mediaSubscribers: (bundle.release.mediaSubscribers as number | null) ?? null,
    lastError: null,
    flickrAlert: null,
    languages: bundle.languages.map((l) => ({
      languageId: l.languageId as 4105 | 3084,
      location: l.location ?? "",
      summary: l.summary ?? "",
      summaryEdited: Boolean(l.summaryEdited),
      socialMediaSummary: l.socialMediaSummary ?? null,
    })),
    documents: bundle.documents.map((d) => ({
      id: "",
      sortIndex: d.sortIndex,
      layout: d.layout,
      languages: d.languages.map((l) => ({
        languageId: l.languageId as 4105 | 3084,
        pageTitle: l.pageTitle ?? "",
        headline: l.headline ?? "",
        subheadline: l.subheadline ?? null,
        organizations: l.organizations ?? null,
        byline: l.byline ?? null,
        bodyHtml: l.bodyHtml ?? "",
        pageImageId: l.pageImageId ?? null,
        contacts: d.contacts.filter((c) => c.languageId === l.languageId).map((c) => c.information),
      })),
    })),
    ministries: cat("ministries"),
    sectors: cat("sectors"),
    themes: cat("themes"),
    tags: cat("tags"),
    mediaListKeys: bundle.mediaListIds,
    files: [],
    features: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

interface ReleaseOutcome {
  id: string;
  status: ReleaseStatus;
}

async function importOneRelease(db: Db, raw: RawReleaseRow, g: GroupedChildren, ctx: ImportReleasesContext): Promise<ReleaseOutcome> {
  const { report } = ctx;
  const legacyId = raw.Id.toLowerCase();

  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(newsReleases).where(eq(newsReleases.legacyId, legacyId)).for("update");

    if (existing && existing.version > (existing.importedVersion ?? 0)) {
      report.skip("news_releases", legacyId, "edited in NRMS since the last import");
      skipChildrenEntirely(report, legacyId, g, "edited in NRMS since the last import");
      return { id: existing.id, status: existing.status };
    }

    const bundle = await buildBundle(tx, raw, g, ctx);
    const problems = publishProblems(pseudoView(raw, bundle));
    if (problems.length) report.warn(legacyId, raw.Key, problems);

    if (existing && existing.importHash === bundle.hash) {
      report.count("news_releases", "imported");
      countChildrenImported(report, g, bundle);
      return { id: existing.id, status: existing.status };
    }

    const now = new Date();
    const newVersion = existing ? existing.version + 1 : 1;
    const { version: _v, importedVersion: _iv, ...releaseFields } = bundle.release;
    const releaseValues = { ...releaseFields, legacyId, version: newVersion, importedVersion: newVersion, importHash: bundle.hash, importedAt: now };

    let releaseId: string;
    if (existing) {
      await tx.update(newsReleases).set(releaseValues).where(eq(newsReleases.id, existing.id));
      releaseId = existing.id;
      await tx.delete(releaseLanguages).where(eq(releaseLanguages.releaseId, releaseId));
      await tx.delete(releaseDocuments).where(eq(releaseDocuments.releaseId, releaseId));
      await tx.delete(releaseCategories).where(eq(releaseCategories.releaseId, releaseId));
      await tx.delete(releaseMediaLists).where(eq(releaseMediaLists.releaseId, releaseId));
      await tx.delete(releaseLog).where(eq(releaseLog.releaseId, releaseId));
    } else {
      const [row] = await tx.insert(newsReleases).values(releaseValues).returning({ id: newsReleases.id });
      releaseId = row!.id;
    }

    if (bundle.languages.length) await tx.insert(releaseLanguages).values(bundle.languages.map((l) => ({ ...l, releaseId })));
    for (const d of bundle.documents) {
      const [docRow] = await tx.insert(releaseDocuments).values({ releaseId, sortIndex: d.sortIndex, layout: d.layout }).returning({ id: releaseDocuments.id });
      const documentId = docRow!.id;
      if (d.languages.length) await tx.insert(documentLanguages).values(d.languages.map((l) => ({ ...l, documentId })));
      if (d.contacts.length) await tx.insert(documentContacts).values(d.contacts.map((c) => ({ ...c, documentId })));
    }
    if (bundle.categories.length) await tx.insert(releaseCategories).values(bundle.categories.map((c) => ({ releaseId, ...c })));
    if (bundle.mediaListIds.length) await tx.insert(releaseMediaLists).values(bundle.mediaListIds.map((mediaListId) => ({ releaseId, mediaListId })));
    if (bundle.logEntries.length) await tx.insert(releaseLog).values(bundle.logEntries.map((e) => ({ ...e, releaseId })));

    report.count("news_releases", "imported");
    countChildrenImported(report, g, bundle);

    return { id: releaseId, status: bundle.status };
  });
}

async function importFeatures(db: Db, source: LegacySource, releaseInfo: Map<string, ReleaseOutcome>, report: ImportReport): Promise<void> {
  const catRows = await source.query<RawFeatureRow>(Q_CATEGORY_FEATURES);
  const settingRows = await source.query<RawAppSettingRow>(Q_APP_SETTINGS);
  const settings = new Map(settingRows.map((r) => [r.SettingName, r.SettingValue]));

  const slots: { kind: FeatureKind; key: string; topLegacyId: string | null; featureLegacyId: string | null }[] = [
    { kind: "home", key: "default", topLegacyId: settings.get("HomeTopReleaseId") || null, featureLegacyId: settings.get("HomeFeatureReleaseId") || null },
    ...catRows
      .filter((r) => r.TopReleaseId || r.FeatureReleaseId)
      .map((r) => ({ kind: r.Kind as FeatureKind, key: r.Key.toLowerCase(), topLegacyId: r.TopReleaseId, featureLegacyId: r.FeatureReleaseId })),
  ];

  const resolve = (legacyReleaseId: string, label: string): string | null => {
    report.count("category_features", "legacy");
    const info = releaseInfo.get(legacyReleaseId.toLowerCase());
    if (!info) {
      report.skip("category_features", legacyReleaseId.toLowerCase(), `${label} slot points at an unknown release`);
      return null;
    }
    if (info.status !== "published") {
      report.skip("category_features", legacyReleaseId.toLowerCase(), `${label} slot points at a release not imported as published (status: ${info.status})`);
      return null;
    }
    report.count("category_features", "imported");
    return info.id;
  };

  for (const slot of slots) {
    if (!slot.topLegacyId && !slot.featureLegacyId) continue;
    const topReleaseId = slot.topLegacyId ? resolve(slot.topLegacyId, "Top") : null;
    const featureReleaseId = slot.featureLegacyId ? resolve(slot.featureLegacyId, "Feature") : null;
    await db
      .insert(categoryFeatures)
      .values({ kind: slot.kind, key: slot.key, topReleaseId, featureReleaseId })
      .onConflictDoUpdate({ target: [categoryFeatures.kind, categoryFeatures.key], set: { topReleaseId, featureReleaseId } });
  }
}

interface CounterAggregate {
  maxNewsRef: number;
  maxYearRelease: Map<number, number>;
  maxMinistryRelease: Map<string, { year: number; ministry: string; max: number }>;
}

function newAggregate(): CounterAggregate {
  return { maxNewsRef: 0, maxYearRelease: new Map(), maxMinistryRelease: new Map() };
}

function accumulate(agg: CounterAggregate, row: RawReleaseRow): void {
  if (row.Reference) {
    const n = Number.parseInt(row.Reference.replace(/^NEWS-/i, ""), 10);
    if (Number.isFinite(n)) agg.maxNewsRef = Math.max(agg.maxNewsRef, n);
  }
  if (row.Year !== null && row.YearRelease !== null) {
    agg.maxYearRelease.set(row.Year, Math.max(agg.maxYearRelease.get(row.Year) ?? 0, row.YearRelease));
  }
  if (row.Year !== null && row.MinistryRelease !== null) {
    const ministry = (row.LeadMinistryKey ?? "").toLowerCase();
    const mapKey = `${row.Year}\u0000${ministry}`;
    const prev = agg.maxMinistryRelease.get(mapKey);
    agg.maxMinistryRelease.set(mapKey, { year: row.Year, ministry, max: Math.max(prev?.max ?? 0, row.MinistryRelease) });
  }
}

async function seedCounter(tx: Tx, scope: "news" | "year" | "ministry", year: number, ministry: string, value: number): Promise<void> {
  await tx.execute(sql`
    INSERT INTO number_counters (scope, year, ministry, last_value) VALUES (${scope}, ${year}, ${ministry}, ${value})
    ON CONFLICT (scope, year, ministry) DO UPDATE SET last_value = GREATEST(number_counters.last_value, EXCLUDED.last_value)`);
}

async function seedCounters(db: Db, agg: CounterAggregate): Promise<void> {
  await db.transaction(async (tx) => {
    if (agg.maxNewsRef > 0) await seedCounter(tx, "news", 0, "", agg.maxNewsRef);
    for (const [year, max] of agg.maxYearRelease) await seedCounter(tx, "year", year, "", max);
    for (const { year, ministry, max } of agg.maxMinistryRelease.values()) await seedCounter(tx, "ministry", year, ministry, max);
  });
}

export async function importReleases(db: Db, source: LegacySource, ctx: ImportReleasesContext): Promise<void> {
  const { report } = ctx;
  const years = (await source.query<{ Year: number }>(Q_RELEASE_YEARS)).map((r) => r.Year);
  const releaseInfo = new Map<string, ReleaseOutcome>();
  const agg = newAggregate();

  for (const year of years) {
    const releaseRows = await source.query<RawReleaseRow>(qReleases(year));
    const languagesByRelease = groupBy(await source.query<LegacyReleaseLanguageRow>(qReleaseLanguages(year)), (r) => r.ReleaseId);
    const documentsByRelease = groupBy(await source.query<LegacyDocumentRow>(qDocuments(year)), (r) => r.ReleaseId);
    const docLangsByDoc = groupBy(await source.query<LegacyDocumentLanguageRow>(qDocumentLanguages(year)), (r) => r.DocumentId);
    const contactsByDoc = groupBy(await source.query<LegacyContactRow>(qDocumentContacts(year)), (r) => r.DocumentId);
    const categoriesByRelease = groupBy(await source.query<RawCategoryRow>(qReleaseCategories(year)), (r) => r.ReleaseId);
    const mediaListsByRelease = groupBy(await source.query<RawMediaListRow>(qReleaseMediaLists(year)), (r) => r.ReleaseId);
    const logsByRelease = groupBy(await source.query<RawLogRow>(qReleaseLog(year)), (r) => r.ReleaseId);

    for (const row of releaseRows) {
      report.count("news_releases", "legacy");
      accumulate(agg, row);
      const legacyId = row.Id.toLowerCase();
      const g: GroupedChildren = {
        languages: languagesByRelease.get(legacyId) ?? [],
        documents: documentsByRelease.get(legacyId) ?? [],
        docLangsByDoc,
        contactsByDoc,
        categories: categoriesByRelease.get(legacyId) ?? [],
        mediaLists: mediaListsByRelease.get(legacyId) ?? [],
        logs: logsByRelease.get(legacyId) ?? [],
      };
      countLegacyChildren(report, g);
      const outcome = await importOneRelease(db, row, g, ctx);
      releaseInfo.set(legacyId, outcome);
    }
  }

  for (const h of await source.query<RawHistoryRow>(Q_HISTORY_COUNT)) {
    const n = Number(h.Count);
    report.count("NewsReleaseHistory", "legacy", n);
    for (let i = 0; i < n; i++) report.skip("NewsReleaseHistory", h.ReleaseId.toLowerCase(), "frozen copies not imported (Q12)");
  }

  await importFeatures(db, source, releaseInfo, report);
  await seedCounters(db, agg);
}
