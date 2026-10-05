import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createFakeSource } from "@gcpe/legacy-import";
import { createNrmsTestDb } from "../../test/helpers";
import { governmentTerms, mediaLists, pageImageLanguages, pageImages, pageTypes } from "../db/schema";
import { HIDDEN_PAGE_IMAGE_LEGACY_IDS, importReference } from "./reference";
import { ImportReport } from "./report";

const IMAGE_ID = "11111111-1111-1111-1111-111111111111";
const [HIDDEN_1, HIDDEN_2] = [...HIDDEN_PAGE_IMAGE_LEGACY_IDS] as [string, string];

function source(overrides: Partial<Record<string, Record<string, unknown>[]>> = {}) {
  return createFakeSource({
    pageImages: [
      { Id: IMAGE_ID, SortOrder: 1, Name: "Ribbon", MimeType: "image/png", Bytes: Buffer.from("89504e47", "hex") },
      { Id: HIDDEN_1, SortOrder: 2, Name: "Hidden One", MimeType: "image/png", Bytes: Buffer.from("89504e47", "hex") },
      { Id: HIDDEN_2, SortOrder: 3, Name: "Hidden Two", MimeType: "image/png", Bytes: Buffer.from("89504e47", "hex") },
    ],
    pageImageLanguages: [
      { ImageId: IMAGE_ID, LanguageId: 4105, AlternateName: "Ribbon (EN)" },
      { ImageId: IMAGE_ID, LanguageId: 3084, AlternateName: "Ruban (FR)" },
    ],
    pageTypes: [{ PageTitle: "News Release", LanguageId: 4105, ReleaseType: 1, SortOrder: 1, PageLayout: 1, PageImageId: IMAGE_ID }],
    mediaLists: [
      { Id: "22222222-2222-2222-2222-222222222222", Key: "regional", DisplayName: "Regional media", SortOrder: 1, IsActive: true },
      { Id: "33333333-3333-3333-3333-333333333333", Key: "national", DisplayName: "National media", SortOrder: 2, IsActive: true },
    ],
    collections: [
      { Id: "44444444-4444-4444-4444-444444444444", Name: "2009-2013" },
      { Id: "55555555-5555-5555-5555-555555555555", Name: "2017-2021" },
      { Id: "66666666-6666-6666-6666-666666666666", Name: "2013-2017" },
      { Id: "77777777-7777-7777-7777-777777777777", Name: "2017-2017" },
    ],
    ...overrides,
  });
}

describe("importReference — page images, languages and types", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNrmsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("imports page images with bytes and fr/en alt text, hides the Q11 pair, and resolves the page type's image", async () => {
    const report = new ImportReport();
    const result = await importReference(tdb.db, source(), report);
    expect(result.pageImageIds.get(IMAGE_ID)).toBeDefined();

    const [ribbon] = await tdb.db.select().from(pageImages).where(eq(pageImages.legacyId, IMAGE_ID));
    expect(ribbon).toMatchObject({ name: "Ribbon", isActive: true, mimeType: "image/png", sortOrder: 1 });
    expect(Buffer.compare(ribbon!.bytes, Buffer.from("89504e47", "hex"))).toBe(0);

    const [hidden1] = await tdb.db.select().from(pageImages).where(eq(pageImages.legacyId, HIDDEN_1));
    const [hidden2] = await tdb.db.select().from(pageImages).where(eq(pageImages.legacyId, HIDDEN_2));
    expect(hidden1!.isActive).toBe(false);
    expect(hidden2!.isActive).toBe(false);

    const langs = await tdb.db.select().from(pageImageLanguages).where(eq(pageImageLanguages.imageId, ribbon!.id));
    expect(langs.map((l) => ({ languageId: l.languageId, altText: l.altText })).sort((a, b) => a.languageId - b.languageId)).toEqual([
      { languageId: 3084, altText: "Ruban (FR)" },
      { languageId: 4105, altText: "Ribbon (EN)" },
    ]);

    const [pt] = await tdb.db.select().from(pageTypes).where(eq(pageTypes.pageTitle, "News Release"));
    expect(pt!.pageImageId).toBe(ribbon!.id);
    expect(pt!.releaseType).toBe("release");
    expect(pt!.layout).toBe("formal");

    expect(report.toJSON().tables.page_images).toEqual({ legacy: 3, imported: 3, skipped: 0 });
    expect(report.toJSON().tables.page_image_languages).toEqual({ legacy: 2, imported: 2, skipped: 0 });
    expect(report.toJSON().tables.page_types).toEqual({ legacy: 1, imported: 1, skipped: 0 });
  });

  it("re-running with unchanged legacy data changes no rows (still counted as imported, not skipped)", async () => {
    const before = await tdb.db.select().from(pageImages).orderBy(pageImages.legacyId);
    const report = new ImportReport();
    await importReference(tdb.db, source(), report);
    const after = await tdb.db.select().from(pageImages).orderBy(pageImages.legacyId);
    expect(after).toEqual(before);
    expect(report.toJSON().tables.page_images).toEqual({ legacy: 3, imported: 3, skipped: 0 });
  });
});

describe("importReference — media lists", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNrmsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("upserts media lists by legacy id", async () => {
    const report = new ImportReport();
    const result = await importReference(tdb.db, source(), report);
    expect(result.mediaListIds.size).toBe(2);
    const rows = await tdb.db.select().from(mediaLists).orderBy(mediaLists.key);
    expect(rows.map((r) => r.displayName)).toEqual(["National media", "Regional media"]);
  });

  it("a rename in legacy updates the row on re-run, matched by legacy id not name", async () => {
    const report = new ImportReport();
    await importReference(
      tdb.db,
      source({
        mediaLists: [
          { Id: "22222222-2222-2222-2222-222222222222", Key: "regional", DisplayName: "Regional Media Outlets", SortOrder: 1, IsActive: true },
          { Id: "33333333-3333-3333-3333-333333333333", Key: "national", DisplayName: "National media", SortOrder: 2, IsActive: true },
        ],
      }),
      report,
    );
    const [renamed] = await tdb.db.select().from(mediaLists).where(eq(mediaLists.legacyId, "22222222-2222-2222-2222-222222222222"));
    expect(renamed!.displayName).toBe("Regional Media Outlets");
    expect(report.toJSON().tables.media_lists).toEqual({ legacy: 2, imported: 2, skipped: 0 });
  });
});

describe("importReference — government terms", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNrmsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("exactly one term is current: the one with the highest year in its name", async () => {
    const report = new ImportReport();
    await importReference(tdb.db, source(), report);
    const current = await tdb.db.select().from(governmentTerms).where(eq(governmentTerms.isCurrent, true));
    expect(current).toHaveLength(1);
    expect(current[0]!.name).toBe("2017-2021");
    expect(report.toJSON().tables.government_terms).toEqual({ legacy: 4, imported: 4, skipped: 0 });
  });

  it("re-running keeps exactly one current term", async () => {
    const report = new ImportReport();
    await importReference(tdb.db, source(), report);
    const current = await tdb.db.select().from(governmentTerms).where(eq(governmentTerms.isCurrent, true));
    expect(current).toHaveLength(1);
    expect(current[0]!.name).toBe("2017-2021");
    expect(report.toJSON().tables.government_terms).toEqual({ legacy: 4, imported: 4, skipped: 0 });
  });
});
