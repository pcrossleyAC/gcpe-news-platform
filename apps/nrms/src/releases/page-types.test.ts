import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNrmsTestDb, createScheduledRelease } from "../../test/helpers";
import { documentLanguages } from "../db/schema";
import { listPageTypes } from "./queries";
import {
  createPageType, deletePageType, PAGE_TITLE_MAX, PageTypeConflictError, PageTypeNotFoundError, PageTypeRuleError, pageTypeInputSchema, updatePageType,
} from "./page-types";

const base = { languageId: 4105 as const, sortOrder: 1, layout: "formal" as const, pageImageId: null };

describe("page types (write rules)", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNrmsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE page_types CASCADE");
    await tdb.pool.query(`INSERT INTO page_types (page_title, language_id, release_type, sort_order, layout) VALUES
      ('News Release', 4105, 'release', 1, 'formal'), ('Information Bulletin', 4105, 'release', 2, 'formal'),
      ('Story', 4105, 'story', 1, 'informal'), ('Factsheet', 4105, 'factsheet', 1, 'informal'), ('Media Advisory', 4105, 'advisory', 1, 'formal')`);
  });

  it("createPageType adds 'Joint Statement' (release, English, sort 6, formal); listPageTypes returns it", async () => {
    const row = await createPageType(tdb.db, { ...base, pageTitle: "Joint Statement", releaseType: "release", sortOrder: 6 });
    expect(row).toEqual({ pageTitle: "Joint Statement", languageId: 4105, releaseType: "release", sortOrder: 6, layout: "formal", pageImageId: null });
    expect(await listPageTypes(tdb.db)).toContainEqual(row);
  });

  it("createPageType refuses 'news release' in English when 'News Release' exists (case-insensitive); allows it in French", async () => {
    await expect(createPageType(tdb.db, { ...base, pageTitle: "news release", releaseType: "release" })).rejects.toThrow(
      new PageTypeConflictError("A page title with that name already exists in that language."),
    );
    await expect(createPageType(tdb.db, { ...base, pageTitle: "news release", releaseType: "release", languageId: 3084 })).resolves.toBeTruthy();
  });

  it("updatePageType renames 'Information Bulletin' to 'Info Bulletin'; a release document holding 'Information Bulletin' keeps its text", async () => {
    await createScheduledRelease(tdb.db, { pageTitle: "Information Bulletin" });
    const textOf = async () => (await tdb.db.select({ t: documentLanguages.pageTitle }).from(documentLanguages)).map((r) => r.t);
    expect(await textOf()).toContain("Information Bulletin");
    const row = await updatePageType(tdb.db, { pageTitle: "Information Bulletin", languageId: 4105 }, { ...base, pageTitle: "Info Bulletin", releaseType: "release", sortOrder: 2 });
    expect(row.pageTitle).toBe("Info Bulletin");
    expect((await listPageTypes(tdb.db)).map((p) => p.pageTitle)).not.toContain("Information Bulletin");
    expect(await textOf()).toContain("Information Bulletin");
    // deleting the renamed type leaves the release's copy alone too
    await deletePageType(tdb.db, { pageTitle: "Info Bulletin", languageId: 4105 });
    expect(await textOf()).toContain("Information Bulletin");
  });

  it("updatePageType can keep its own title (case change allowed); unknown key is not found", async () => {
    await expect(updatePageType(tdb.db, { pageTitle: "News Release", languageId: 4105 }, { ...base, pageTitle: "NEWS RELEASE", releaseType: "release" })).resolves.toBeTruthy();
    await expect(updatePageType(tdb.db, { pageTitle: "Nope", languageId: 4105 }, { ...base, pageTitle: "X", releaseType: "release" })).rejects.toBeInstanceOf(PageTypeNotFoundError);
    await expect(deletePageType(tdb.db, { pageTitle: "Nope", languageId: 4105 })).rejects.toBeInstanceOf(PageTypeNotFoundError);
  });

  it("deletePageType refuses the only English story title; succeeds once a second English story title exists", async () => {
    await expect(deletePageType(tdb.db, { pageTitle: "Story", languageId: 4105 })).rejects.toThrow(
      "This is the only English page title for Story. Add another first.",
    );
    expect((await listPageTypes(tdb.db)).map((p) => p.pageTitle)).toContain("Story");
    await createPageType(tdb.db, { ...base, pageTitle: "Feature", releaseType: "story", layout: "informal" });
    await expect(deletePageType(tdb.db, { pageTitle: "Story", languageId: 4105 })).resolves.toBeUndefined();
  });

  it("updatePageType refuses moving the only English factsheet title to French or to release type 'story'", async () => {
    const key = { pageTitle: "Factsheet", languageId: 4105 };
    const msg = "This is the only English page title for Factsheet. Add another first.";
    await expect(updatePageType(tdb.db, key, { ...base, pageTitle: "Factsheet", releaseType: "factsheet", languageId: 3084 })).rejects.toThrow(msg);
    await expect(updatePageType(tdb.db, key, { ...base, pageTitle: "Factsheet", releaseType: "story" })).rejects.toThrow(msg);
    expect(await listPageTypes(tdb.db)).toContainEqual(expect.objectContaining({ pageTitle: "Factsheet", languageId: 4105, releaseType: "factsheet" }));
  });

  it("renaming onto an existing title in the same language, or moving to French onto an existing French title, is a conflict and stores nothing", async () => {
    await tdb.pool.query("INSERT INTO page_types (page_title, language_id, release_type, sort_order) VALUES ('Story', 3084, 'story', 1)");
    const before = await listPageTypes(tdb.db);
    await expect(updatePageType(tdb.db, { pageTitle: "Information Bulletin", languageId: 4105 }, { ...base, pageTitle: "news release", releaseType: "release" })).rejects.toBeInstanceOf(PageTypeConflictError);
    await expect(updatePageType(tdb.db, { pageTitle: "Story", languageId: 4105 }, { ...base, pageTitle: "story", releaseType: "story", languageId: 3084 })).rejects.toBeInstanceOf(PageTypeConflictError);
    expect(await listPageTypes(tdb.db)).toEqual(before);
  });

  it("an unrelated edit is not blocked by a creatable type that already has no English title", async () => {
    await tdb.pool.query("DELETE FROM page_types WHERE release_type = 'advisory'");
    await expect(updatePageType(tdb.db, { pageTitle: "News Release", languageId: 4105 }, { ...base, pageTitle: "News Release 2", releaseType: "release" })).resolves.toBeTruthy();
  });

  it("an unknown pageImageId is refused; null is accepted", async () => {
    await expect(createPageType(tdb.db, { ...base, pageTitle: "Pic", releaseType: "release", pageImageId: "00000000-0000-4000-8000-000000000001" })).rejects.toBeInstanceOf(PageTypeRuleError);
    await expect(createPageType(tdb.db, { ...base, pageTitle: "NoPic", releaseType: "release", pageImageId: null })).resolves.toBeTruthy();
    const [{ id }] = (await tdb.pool.query("INSERT INTO page_images (name, mime_type, bytes) VALUES ('L', 'image/png', '\\x00'::bytea) RETURNING id")).rows;
    await expect(createPageType(tdb.db, { ...base, pageTitle: "WithPic", releaseType: "release", pageImageId: id })).resolves.toMatchObject({ pageImageId: id });
  });

  it("a title of 51 characters, '' and '<b>x</b>' are refused by pageTypeInputSchema", () => {
    const ok = { ...base, pageTitle: "x".repeat(PAGE_TITLE_MAX), releaseType: "release" };
    expect(pageTypeInputSchema.safeParse(ok).success).toBe(true);
    for (const pageTitle of ["x".repeat(PAGE_TITLE_MAX + 1), "", "   ", "<b>x</b>"]) expect(pageTypeInputSchema.safeParse({ ...ok, pageTitle }).success).toBe(false);
  });
});
