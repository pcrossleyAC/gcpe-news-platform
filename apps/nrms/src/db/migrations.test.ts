import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, runMigrations, type TestDatabase } from "@gcpe/db-kit";
import { nrmsMigrations } from "../../test/helpers";

/** A copy of the migrations folder whose journal stops after `lastTag`. */
async function partialMigrations(lastTag: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nrms-mig-"));
  await cp(nrmsMigrations, dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: { tag: string }[] };
  journal.entries = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === lastTag) + 1);
  await writeFile(journalPath, JSON.stringify(journal));
  return dir;
}

describe("Phase 2 → release model data copy", () => {
  let tdb: TestDatabase;
  let partial: string;
  beforeAll(async () => {
    partial = await partialMigrations("0002_taxonomy_cache");
    tdb = await createTestDatabase({ migrationsFolder: partial });
  });
  afterAll(async () => {
    await tdb.drop();
    await rm(partial, { recursive: true, force: true });
  });

  it("copies a Phase 2 release, its document, contacts and categories", async () => {
    const content = {
      reference: "NEWS-00001", leadMinistryKey: "health", summary: "Clinics open.", socialMediaSummary: null, socialMediaHeadline: null,
      keywords: null, location: "VICTORIA", hasMediaAssets: false, hasTranslations: false, isNewsOnDemand: true, assetUrl: null, redirectUri: null,
      documents: [{ pageTitle: "Weekend clinics", languageId: 4105, headline: "Weekend clinics open", subheadline: null, detailsHtml: "<p>Body</p>", byline: null,
        contacts: [{ title: "Media Relations", details: "Alex Example\n250-555-0100" }] }],
      ministryKeys: ["health"], sectorKeys: ["Health"], tagKeys: [], themeKeys: [], assets: null, translations: null,
      publishFlags: { toWeb: true, toSubscribers: true, toMediaLists: false }, mediaListKeys: [],
    };
    await tdb.pool.query(
      `INSERT INTO releases (key, kind, status, publish_at, published_at, content) VALUES ($1, 'releases', 'published', now(), now(), $2)`,
      ["2026HLTH0001-000001", JSON.stringify(content)],
    );
    await runMigrations(tdb.db, nrmsMigrations);
    const q = async (text: string) => (await tdb.pool.query(text)).rows;
    expect(await q(`SELECT type, key, reference, status, to_subscribers FROM news_releases`)).toEqual([
      { type: "release", key: "2026HLTH0001-000001", reference: "NEWS-00001", status: "published", to_subscribers: true },
    ]);
    expect(await q(`SELECT location, summary, summary_edited FROM release_languages`)).toEqual([{ location: "VICTORIA", summary: "Clinics open.", summary_edited: true }]);
    expect(await q(`SELECT headline, body_html FROM document_languages`)).toEqual([{ headline: "Weekend clinics open", body_html: "<p>Body</p>" }]);
    expect(await q(`SELECT information FROM document_contacts`)).toEqual([{ information: "Media Relations\nAlex Example\n250-555-0100" }]);
    expect(await q(`SELECT kind, key FROM release_categories ORDER BY kind`)).toEqual([{ kind: "ministries", key: "health" }, { kind: "sectors", key: "health" }]);
  });
});

describe("Phase 2 → release model data copy: duplicate references", () => {
  let tdb: TestDatabase;
  let partial: string;
  beforeAll(async () => {
    partial = await partialMigrations("0002_taxonomy_cache");
    tdb = await createTestDatabase({ migrationsFolder: partial });
  });
  afterAll(async () => {
    await tdb.drop();
    await rm(partial, { recursive: true, force: true });
  });

  it("keeps the earliest-created row's reference and nulls out later duplicates, without aborting the migration", async () => {
    const baseContent = {
      reference: "NEWS-00007", leadMinistryKey: "health", summary: "", socialMediaSummary: null, socialMediaHeadline: null,
      keywords: null, location: "", hasMediaAssets: false, hasTranslations: false, isNewsOnDemand: true, assetUrl: null, redirectUri: null,
      documents: [], ministryKeys: [], sectorKeys: [], tagKeys: [], themeKeys: [], assets: null, translations: null,
      publishFlags: { toWeb: true, toSubscribers: false, toMediaLists: false }, mediaListKeys: [],
    };
    await tdb.pool.query(
      `INSERT INTO releases (key, kind, status, created_at, content) VALUES ($1, 'releases', 'draft', now() - interval '1 hour', $2)`,
      ["2026HLTH0002-000001", JSON.stringify(baseContent)],
    );
    await tdb.pool.query(
      `INSERT INTO releases (key, kind, status, created_at, content) VALUES ($1, 'releases', 'draft', now(), $2)`,
      ["2026HLTH0002-000002", JSON.stringify(baseContent)],
    );
    await runMigrations(tdb.db, nrmsMigrations);
    const q = async (text: string) => (await tdb.pool.query(text)).rows;
    expect(await q(`SELECT key, reference, status FROM news_releases ORDER BY key`)).toEqual([
      { key: "2026HLTH0002-000001", reference: "NEWS-00007", status: "approved" },
      { key: "2026HLTH0002-000002", reference: null, status: "draft" },
    ]);
  });
});
