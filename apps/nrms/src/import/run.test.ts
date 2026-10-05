import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createFakeSource, type LegacySource } from "@gcpe/legacy-import";
import { createCoreTestDb } from "../../../core/test/helpers";
import { createNrmsTestDb } from "../../test/helpers";
import { newsReleases } from "../db/schema";
import { ImportAlreadyRunningError, IMPORT_LOCK, runImport, runImportCli } from "./run";

const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
const tsxBin = fileURLToPath(new URL("../../../../node_modules/.bin/tsx", import.meta.url));

const USER_ID = "99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PUBLISHED_ID = "a1111111-1111-4111-8111-111111111111";
const DRAFT_ID = "a2222222-2222-4222-8222-222222222222";

function emptyTables(): Record<string, Record<string, unknown>[]> {
  return {
    users: [],
    pageImages: [],
    pageImageLanguages: [],
    pageTypes: [],
    mediaLists: [],
    collections: [],
    releaseYears: [],
    historyCount: [],
    appSettings: [],
    categoryFeatures: [],
    carousels: [],
    carouselSlides: [],
    resourceLinks: [],
  };
}

/** A minimal but complete fixture: one published release, one draft, one legacy user who
 * logged against the published one. Exercises every stage's wiring, not every mapping edge
 * case (those are Tasks 2-4's own tests). */
function fullFixtureSource(): LegacySource {
  const tables = emptyTables();
  tables.users = [{ Id: USER_ID, DisplayName: "Jane Doe", EmailAddress: "jane.doe@gov.bc.ca", IsActive: true }];
  tables.releaseYears = [{ Year: 2024 }];
  tables["releases:2024"] = [
    {
      Id: PUBLISHED_ID, Key: "run-test-published", ReleaseType: 1, Reference: "NEWS-00001", AtomId: "",
      Year: 2024, YearRelease: 1, MinistryRelease: null, ActivityId: null,
      // ReleaseDateTime is a legacy DATETIME (no offset): tedious hands it back with its UTC
      // fields holding the wall-clock value, so this is "Z" even though the wall-clock is PDT.
      ReleaseDateTime: new Date("2024-06-01T09:00:00Z"), PublishDateTime: new Date("2024-06-01T09:00:00-07:00"),
      IsCommitted: true, IsPublished: true, PublishOptions: 0, IsActive: true,
      HasMediaAssets: false, HasTranslations: false, NodSubscribers: null, MediaSubscribers: null,
      Keywords: "", AssetUrl: "", RedirectUrl: "", CollectionId: null, LeadMinistryKey: null,
    },
    {
      Id: DRAFT_ID, Key: "run-test-draft", ReleaseType: 1, Reference: null, AtomId: "",
      Year: 2024, YearRelease: null, MinistryRelease: null, ActivityId: null,
      ReleaseDateTime: null, PublishDateTime: null,
      IsCommitted: false, IsPublished: false, PublishOptions: 0, IsActive: true,
      HasMediaAssets: false, HasTranslations: false, NodSubscribers: null, MediaSubscribers: null,
      Keywords: "", AssetUrl: "", RedirectUrl: "", CollectionId: null, LeadMinistryKey: null,
    },
  ];
  tables["releaseLanguages:2024"] = [];
  tables["documents:2024"] = [];
  tables["documentLanguages:2024"] = [];
  tables["documentContacts:2024"] = [];
  tables["releaseCategories:2024"] = [];
  tables["releaseMediaLists:2024"] = [];
  tables["releaseLog:2024"] = [
    { Id: 1, ReleaseId: PUBLISHED_ID, DateTime: new Date("2024-06-01T08:00:00-07:00"), UserId: USER_ID, Description: "Approved", EmailAddress: "jane.doe@gov.bc.ca", DisplayName: "Jane Doe" },
  ];
  return createFakeSource(tables);
}

const TIME_ZONE = "America/Vancouver";

describe("runImport (orchestrator)", () => {
  let tdb: TestDatabase;
  let coreTdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    coreTdb = await createCoreTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
    await coreTdb.drop();
  });

  it("imports users, reference, releases and website in order; the report balances; writes no outbox or flickr rows (acceptance 15)", async () => {
    const source = fullFixtureSource();
    const report = await runImport(tdb.db, coreTdb.db, source, { force: false, timeZone: TIME_ZONE });

    expect(report.balanced()).toBe(true);
    const json = report.toJSON();
    expect(json.tables.users).toEqual({ legacy: 1, imported: 1, skipped: 0 });
    expect(json.tables.news_releases).toEqual({ legacy: 2, imported: 2, skipped: 0 });

    const published = await tdb.db.select().from(newsReleases).where(eq(newsReleases.legacyId, PUBLISHED_ID));
    expect(published[0]).toMatchObject({ status: "published", live: true, key: "run-test-published" });
    const draft = await tdb.db.select().from(newsReleases).where(eq(newsReleases.legacyId, DRAFT_ID));
    expect(draft[0]).toMatchObject({ status: "draft", live: false });

    // Core: the legacy user became one inactive Core user, matched by email.
    const coreUsers = (await coreTdb.pool.query("SELECT email, is_active FROM users WHERE lower(email) = 'jane.doe@gov.bc.ca'")).rows;
    expect(coreUsers).toHaveLength(1);
    expect(coreUsers[0].is_active).toBe(false);

    // Safety (spec §8): the import writes no outbox events and starts no Flickr jobs.
    expect((await tdb.pool.query("SELECT count(*)::int AS n FROM outbox_events")).rows[0].n).toBe(0);
    expect((await tdb.pool.query("SELECT count(*)::int AS n FROM flickr_jobs")).rows[0].n).toBe(0);

    // Re-run: a second import of unchanged legacy data changes nothing (acceptance 15).
    const secondReport = await runImport(tdb.db, coreTdb.db, source, { force: false, timeZone: TIME_ZONE });
    expect(secondReport.balanced()).toBe(true);
    expect(secondReport.toJSON().tables).toEqual(json.tables);

    const publishedAgain = await tdb.db.select().from(newsReleases).where(eq(newsReleases.legacyId, PUBLISHED_ID));
    expect(publishedAgain[0]!.version).toBe(published[0]!.version); // no version bump
    const coreUsersAgain = (await coreTdb.pool.query("SELECT count(*)::int AS n FROM users WHERE lower(email) = 'jane.doe@gov.bc.ca'")).rows;
    expect(coreUsersAgain[0].n).toBe(1); // not duplicated
  });

  it("a stage failure stops the run but still throws with the partial report attached", async () => {
    // "users" succeeds (empty), but the fixture has no "pageImages" entry at all, so the
    // reference stage's very first query throws -- a realistic stand-in for a legacy query
    // failing partway through a real run.
    const source = createFakeSource({ users: [] });
    await expect(runImport(tdb.db, coreTdb.db, source, { force: false, timeZone: TIME_ZONE })).rejects.toMatchObject({
      stage: "reference",
      report: expect.objectContaining({}),
    });
  });

  it("runImportCli writes a partial report and returns exit code 1 when a stage fails", async () => {
    const source = createFakeSource({ users: [] });
    const dir = await mkdtemp(join(tmpdir(), "nrms-import-test-"));
    const reportPath = join(dir, "report.json");

    const code = await runImportCli({ db: tdb.db, coreDb: coreTdb.db, source, force: false, timeZone: TIME_ZONE, reportPath });
    expect(code).toBe(1);

    const written = JSON.parse(await readFile(reportPath, "utf8"));
    expect(written.tables.users).toEqual({ legacy: 0, imported: 0, skipped: 0 });
    const text = await readFile(join(dir, "report.txt"), "utf8");
    expect(text).toMatch(/Import report/);
  });

  it("refuses a concurrent run: another session already holding the advisory lock throws ImportAlreadyRunningError and writes nothing", async () => {
    const client = await tdb.pool.connect();
    try {
      const { rows } = await client.query("SELECT pg_try_advisory_lock($1, $2) AS locked", [...IMPORT_LOCK]);
      expect(rows[0].locked).toBe(true);

      const before = (await tdb.pool.query("SELECT count(*)::int AS n FROM news_releases")).rows[0].n as number;
      await expect(runImport(tdb.db, coreTdb.db, fullFixtureSource(), { force: false, timeZone: TIME_ZONE })).rejects.toBeInstanceOf(
        ImportAlreadyRunningError,
      );
      const after = (await tdb.pool.query("SELECT count(*)::int AS n FROM news_releases")).rows[0].n as number;
      expect(after).toBe(before);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1, $2)", [...IMPORT_LOCK]);
      client.release();
    }
  });
});

function spawnCli(env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin, [cliPath], { stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

describe("nrms:import CLI env validation", () => {
  it(
    "a missing LEGACY_SQL_PASSWORD exits 1, names the variable, and never touches a real database or SQL Server",
    async () => {
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        DATABASE_URL: "postgres://user:secret-db-pass@localhost:5432/nrms",
        CORE_DATABASE_URL: "postgres://user:secret-db-pass@localhost:5432/core",
        LEGACY_SQL_SERVER: "legacy.example.internal",
        LEGACY_SQL_USER: "svc_import",
        // LEGACY_SQL_PASSWORD deliberately omitted.
      };
      const { stderr, code } = await spawnCli(env);
      expect(code).toBe(1);
      expect(stderr).toMatch(/LEGACY_SQL_PASSWORD/);
      expect(stderr).not.toContain("secret-db-pass");
    },
    20_000,
  );
});
