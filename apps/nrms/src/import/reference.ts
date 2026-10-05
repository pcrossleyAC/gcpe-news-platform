/**
 * Phase 3e (NRMS legacy importer, spec §8, task 2): imports NRMS's own reference tables —
 * page images (with bytes), their per-language alt text, page types, media lists and
 * government terms. None of this goes through the Core event bus; it's purely local to
 * NRMS's own schema, so each table is matched to its existing row by legacy id (or, for page
 * types, by their own natural key — legacy's own PK) and only rewritten when its content
 * actually changed, so a re-run with unchanged legacy data is a no-op.
 */
import { and, eq } from "drizzle-orm";
import type { Db, Tx } from "@gcpe/db-kit";
import type { LegacySource } from "@gcpe/legacy-import";
import { governmentTerms, mediaLists, pageImageLanguages, pageImages, pageTypes } from "../db/schema";
import { layoutFromLegacy, newestTerm, releaseTypeFromLegacy } from "./map";
import { Q_COLLECTIONS, Q_MEDIA_LISTS, Q_PAGE_IMAGE_LANGUAGES, Q_PAGE_IMAGES, Q_PAGE_TYPES } from "./queries";
import type { ImportReport } from "./report";

/**
 * The two page images legacy's own picker UI hides (Q11) — see
 * Hub.Legacy/Gcpe.Hub.Legacy.Website/News/ReleaseManagement/Controls/ReleaseImagePicker.ascx.cs,
 * the `Images` getter: legacy has no inactive flag on NewsReleaseImage, so it hard-codes these
 * two ids and removes them from the picker's dictionary instead of filtering on a column.
 * Imported here as `isActive = false` rather than left out, since the rows (and anything that
 * already points at them, e.g. an old page type) still need to exist.
 */
export const HIDDEN_PAGE_IMAGE_LEGACY_IDS: ReadonlySet<string> = new Set([
  "677d1038-ec69-47c8-ad5e-b2a4a333e774",
  "bb8d51f8-5726-4a5f-9275-d08f67b29cf6",
]);

export interface LegacyPageImageRow extends Record<string, unknown> {
  Id: string;
  SortOrder: number;
  Name: string;
  MimeType: string;
  Bytes: Buffer;
}

export interface LegacyPageImageLanguageRow extends Record<string, unknown> {
  ImageId: string;
  LanguageId: number;
  AlternateName: string | null;
}

export interface LegacyPageTypeRow extends Record<string, unknown> {
  PageTitle: string;
  LanguageId: number;
  ReleaseType: number;
  SortOrder: number;
  PageLayout: number;
  PageImageId: string | null;
}

export interface LegacyMediaListRow extends Record<string, unknown> {
  Id: string;
  Key: string;
  DisplayName: string;
  SortOrder: number;
  IsActive: boolean;
}

export interface LegacyCollectionRow extends Record<string, unknown> {
  Id: string;
  Name: string;
}

async function importPageImages(tx: Tx, rows: LegacyPageImageRow[], report: ImportReport): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const row of rows) {
    report.count("page_images", "legacy");
    const legacyId = row.Id.toLowerCase();
    const values = {
      name: row.Name,
      sortOrder: row.SortOrder,
      mimeType: row.MimeType,
      bytes: row.Bytes,
      isActive: !HIDDEN_PAGE_IMAGE_LEGACY_IDS.has(legacyId),
      legacyId,
    };
    const [existing] = await tx.select().from(pageImages).where(eq(pageImages.legacyId, legacyId));
    const unchanged =
      existing !== undefined &&
      existing.name === values.name &&
      existing.sortOrder === values.sortOrder &&
      existing.mimeType === values.mimeType &&
      existing.isActive === values.isActive &&
      Buffer.compare(existing.bytes, values.bytes) === 0;
    if (unchanged) {
      ids.set(legacyId, existing.id);
    } else if (existing) {
      const [updated] = await tx.update(pageImages).set(values).where(eq(pageImages.id, existing.id)).returning();
      ids.set(legacyId, updated!.id);
    } else {
      const [inserted] = await tx.insert(pageImages).values(values).returning();
      ids.set(legacyId, inserted!.id);
    }
    report.count("page_images", "imported");
  }
  return ids;
}

async function importPageImageLanguages(
  tx: Tx,
  rows: LegacyPageImageLanguageRow[],
  pageImageIds: Map<string, string>,
  report: ImportReport,
): Promise<void> {
  for (const row of rows) {
    report.count("page_image_languages", "legacy");
    const legacyImageId = row.ImageId.toLowerCase();
    const imageId = pageImageIds.get(legacyImageId);
    if (!imageId) {
      report.skip("page_image_languages", legacyImageId, "unknown page image");
      continue;
    }
    const altText = row.AlternateName ?? "";
    const [existing] = await tx
      .select()
      .from(pageImageLanguages)
      .where(and(eq(pageImageLanguages.imageId, imageId), eq(pageImageLanguages.languageId, row.LanguageId)));
    if (existing && existing.altText === altText) {
      report.count("page_image_languages", "imported");
      continue;
    }
    if (existing) {
      await tx
        .update(pageImageLanguages)
        .set({ altText })
        .where(and(eq(pageImageLanguages.imageId, imageId), eq(pageImageLanguages.languageId, row.LanguageId)));
    } else {
      await tx.insert(pageImageLanguages).values({ imageId, languageId: row.LanguageId, altText });
    }
    report.count("page_image_languages", "imported");
  }
}

async function importPageTypes(tx: Tx, rows: LegacyPageTypeRow[], pageImageIds: Map<string, string>, report: ImportReport): Promise<void> {
  for (const row of rows) {
    report.count("page_types", "legacy");
    const pageImageId = row.PageImageId ? pageImageIds.get(row.PageImageId.toLowerCase()) ?? null : null;
    if (row.PageImageId && !pageImageId) {
      report.warn(row.PageImageId.toLowerCase(), `${row.PageTitle}/${row.LanguageId}`, ["Page type references an unknown page image"]);
    }
    const values = {
      pageTitle: row.PageTitle,
      languageId: row.LanguageId,
      releaseType: releaseTypeFromLegacy(row.ReleaseType),
      sortOrder: row.SortOrder,
      layout: layoutFromLegacy(row.PageLayout),
      pageImageId,
    };
    const [existing] = await tx
      .select()
      .from(pageTypes)
      .where(and(eq(pageTypes.pageTitle, values.pageTitle), eq(pageTypes.languageId, values.languageId)));
    const unchanged =
      existing !== undefined &&
      existing.releaseType === values.releaseType &&
      existing.sortOrder === values.sortOrder &&
      existing.layout === values.layout &&
      existing.pageImageId === values.pageImageId;
    if (!unchanged) {
      if (existing) {
        await tx.update(pageTypes).set(values).where(and(eq(pageTypes.pageTitle, values.pageTitle), eq(pageTypes.languageId, values.languageId)));
      } else {
        await tx.insert(pageTypes).values(values);
      }
    }
    report.count("page_types", "imported");
  }
}

async function importMediaLists(tx: Tx, rows: LegacyMediaListRow[], report: ImportReport): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const row of rows) {
    report.count("media_lists", "legacy");
    const legacyId = row.Id.toLowerCase();
    const values = { key: row.Key, displayName: row.DisplayName, sortOrder: row.SortOrder, isActive: Boolean(row.IsActive), legacyId };
    const [existing] = await tx.select().from(mediaLists).where(eq(mediaLists.legacyId, legacyId));
    const unchanged =
      existing !== undefined &&
      existing.key === values.key &&
      existing.displayName === values.displayName &&
      existing.sortOrder === values.sortOrder &&
      existing.isActive === values.isActive;
    if (unchanged) {
      ids.set(legacyId, existing.id);
    } else if (existing) {
      const [updated] = await tx.update(mediaLists).set(values).where(eq(mediaLists.id, existing.id)).returning();
      ids.set(legacyId, updated!.id);
    } else {
      const [inserted] = await tx.insert(mediaLists).values(values).returning();
      ids.set(legacyId, inserted!.id);
    }
    report.count("media_lists", "imported");
  }
  return ids;
}

/**
 * `NewsReleaseCollection` rows become `government_terms`, matched by legacy id. Exactly one
 * row is ever `is_current` (enforced by the partial unique index on `government_terms`), so
 * the winner — `newestTerm()` of all the names — is set only after every other row's flag is
 * cleared, in the same transaction, and only if it isn't already the sole current row.
 */
async function importTerms(tx: Tx, rows: LegacyCollectionRow[], report: ImportReport): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  if (rows.length === 0) return ids;
  const winnerName = newestTerm(rows.map((r) => r.Name));
  const idByName = new Map<string, string>();

  for (const row of rows) {
    report.count("government_terms", "legacy");
    const legacyId = row.Id.toLowerCase();
    const [existing] = await tx.select().from(governmentTerms).where(eq(governmentTerms.legacyId, legacyId));
    let id: string;
    if (existing && existing.name === row.Name) {
      id = existing.id;
    } else if (existing) {
      const [updated] = await tx.update(governmentTerms).set({ name: row.Name }).where(eq(governmentTerms.id, existing.id)).returning();
      id = updated!.id;
    } else {
      const [inserted] = await tx.insert(governmentTerms).values({ name: row.Name, legacyId, isCurrent: false }).returning();
      id = inserted!.id;
    }
    ids.set(legacyId, id);
    idByName.set(row.Name, id);
    report.count("government_terms", "imported");
  }

  const winnerId = idByName.get(winnerName);
  const current = await tx.select().from(governmentTerms).where(eq(governmentTerms.isCurrent, true));
  const alreadyCorrect = winnerId !== undefined && current.length === 1 && current[0]!.id === winnerId;
  if (!alreadyCorrect) {
    if (current.length > 0) await tx.update(governmentTerms).set({ isCurrent: false }).where(eq(governmentTerms.isCurrent, true));
    if (winnerId) await tx.update(governmentTerms).set({ isCurrent: true }).where(eq(governmentTerms.id, winnerId));
  }
  return ids;
}

export async function importReference(
  db: Db,
  source: LegacySource,
  report: ImportReport,
): Promise<{ pageImageIds: Map<string, string>; mediaListIds: Map<string, string>; termIds: Map<string, string> }> {
  return db.transaction(async (tx) => {
    const pageImageIds = await importPageImages(tx, await source.query<LegacyPageImageRow>(Q_PAGE_IMAGES), report);
    await importPageImageLanguages(tx, await source.query<LegacyPageImageLanguageRow>(Q_PAGE_IMAGE_LANGUAGES), pageImageIds, report);
    await importPageTypes(tx, await source.query<LegacyPageTypeRow>(Q_PAGE_TYPES), pageImageIds, report);
    const mediaListIds = await importMediaLists(tx, await source.query<LegacyMediaListRow>(Q_MEDIA_LISTS), report);
    const termIds = await importTerms(tx, await source.query<LegacyCollectionRow>(Q_COLLECTIONS), report);
    return { pageImageIds, mediaListIds, termIds };
  });
}
