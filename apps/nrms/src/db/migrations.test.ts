import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, runMigrations, type TestDatabase } from "@gcpe/db-kit";
import { editor, nrmsMigrations, sampleCreate, seedTaxonomy } from "../../test/helpers";
import { bcYear } from "../releases/numbering";
import { createRelease } from "../releases/service";
import { approve } from "../releases/workflow";
import { governmentTerms } from "./schema";

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
      reference: "NEWS-00001", leadMinistryKey: "HEALTH", summary: "Clinics open.", socialMediaSummary: null, socialMediaHeadline: null,
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
    expect(await q(`SELECT type, key, reference, lead_ministry_key, status, to_subscribers, live FROM news_releases`)).toEqual([
      { type: "release", key: "2026HLTH0001-000001", reference: "NEWS-00001", lead_ministry_key: "health", status: "published", to_subscribers: true, live: true },
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

describe("number counters seeded from copied releases", () => {
  let tdb: TestDatabase;
  let partial: string;
  const TZ = "America/Vancouver";
  const year = bcYear(new Date(), TZ);
  beforeAll(async () => {
    partial = await partialMigrations("0007_backfill_live");
    tdb = await createTestDatabase({ migrationsFolder: partial });
  });
  afterAll(async () => {
    await tdb.drop();
    await rm(partial, { recursive: true, force: true });
  });

  it("continues numbering after the copied references and keys, and re-seeding never lowers a counter", async () => {
    await tdb.pool.query(
      `INSERT INTO news_releases (type, key, reference, lead_ministry_key, status, publish_at, released_at) VALUES
        ('release', $1, 'NEWS-00003', 'health', 'published', now(), now()),
        ('advisory', $2, 'NEWS-00001', NULL, 'published', now(), now()),
        ('story', 'some-story', 'NEWS-00002', 'health', 'published', now(), now()),
        ('release', '2019HLTH0042-000099', NULL, 'health', 'published', now(), now())`,
      [`${year}HLTH0004-000007`, `${year}ADVIS0002-000003`],
    );
    await runMigrations(tdb.db, nrmsMigrations);
    await seedTaxonomy(tdb.db);
    await tdb.db.insert(governmentTerms).values({ name: "2024-2028", isCurrent: true });

    const r = await createRelease(tdb.db, sampleCreate, editor);
    const a = await approve(tdb.db, r.id, r.version, editor, { timeZone: TZ });
    expect([a.reference, a.key]).toEqual(["NEWS-00004", `${year}HLTH0005-000008`]);
    const adv = await createRelease(tdb.db, { ...sampleCreate, type: "advisory", ministries: [], leadMinistryKey: null, sectors: [], mediaListKeys: ["regional"] }, editor);
    const b = await approve(tdb.db, adv.id, adv.version, editor, { timeZone: TZ });
    expect([b.reference, b.key]).toEqual(["NEWS-00005", `${year}ADVIS0003-000009`]);

    const seed = await readFile(join(nrmsMigrations, "0008_seed_counters.sql"), "utf8");
    for (const stmt of seed.split("--> statement-breakpoint")) await tdb.pool.query(stmt);
    const q = async (text: string) => (await tdb.pool.query(text)).rows;
    expect(await q(`SELECT scope, year, ministry, last_value FROM number_counters ORDER BY scope, year, ministry`)).toEqual([
      { scope: "ministry", year: 2019, ministry: "health", last_value: 42 },
      { scope: "ministry", year, ministry: "", last_value: 3 },
      { scope: "ministry", year, ministry: "health", last_value: 5 },
      { scope: "news", year: 0, ministry: "", last_value: 5 },
      { scope: "year", year: 2019, ministry: "", last_value: 99 },
      { scope: "year", year, ministry: "", last_value: 9 },
    ]);
  });
});
