import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { outboxEvents } from "@gcpe/events";
import { createFakeSource, type LegacySource } from "@gcpe/legacy-import";
import { createNrmsTestDb, editor, seedTaxonomy } from "../../test/helpers";
import { categoryFeatures, categoryTerms, mediaLists, newsReleases, organizations, releaseCategories, releaseLog, releaseMediaLists } from "../db/schema";
import { bcYear } from "../releases/numbering";
import { toReleaseRecord } from "../releases/record";
import { createRelease, saveMeta } from "../releases/service";
import { loadView } from "../releases/store";
import { approve } from "../releases/workflow";
import { publishDue } from "../publisher";
import { replayToNewsApi } from "../cli/replay-to-news-api";
import { importReleases, type ImportReleasesContext } from "./releases";
import { ImportReport } from "./report";

import fictionalFixture from "../../test/fixtures/legacy/fictional.json";
import fiveTypesFixture from "../../test/fixtures/legacy/five-types.json";
import apiFixture from "../../test/fixtures/legacy/api-releases.json";
import apiPostTT from "../../test/fixtures/legacy/api-raw/post-2026TT0103-001121.json";
import apiPostAG from "../../test/fixtures/legacy/api-raw/post-2026AG0068-001112.json";
import apiPostMCM from "../../test/fixtures/legacy/api-raw/post-2026MCM0031-001120.json";

type FixtureTables = Record<string, Record<string, unknown>[]>;
interface YearFixture {
  years: Record<string, FixtureTables>;
  historyCount?: Record<string, unknown>[];
  appSettings?: Record<string, unknown>[];
  categoryFeatures?: Record<string, unknown>[];
}

const YEAR_TABLES = ["releases", "releaseLanguages", "documents", "documentLanguages", "documentContacts", "releaseCategories", "releaseMediaLists", "releaseLog"];

const toDate = (v: unknown): unknown => (typeof v === "string" ? new Date(v) : v);

/** Mirrors what the mssql driver actually hands back: real `Date` objects for datetime columns. */
function withDates(rows: Record<string, unknown>[], fields: string[]): Record<string, unknown>[] {
  return rows.map((r) => {
    const out = { ...r };
    for (const f of fields) out[f] = toDate(r[f]);
    return out;
  });
}

function buildFakeSource(fixture: YearFixture): LegacySource {
  const tables: FixtureTables = {};
  const years = Object.keys(fixture.years).map(Number);
  tables.releaseYears = years.map((Year) => ({ Year }));
  for (const y of years) {
    const bucket = fixture.years[String(y)]!;
    for (const name of YEAR_TABLES) {
      let rows = bucket[name] ?? [];
      if (name === "releases") rows = withDates(rows, ["ReleaseDateTime", "PublishDateTime"]);
      if (name === "releaseLog") rows = withDates(rows, ["DateTime"]);
      tables[`${name}:${y}`] = rows;
    }
  }
  tables.historyCount = fixture.historyCount ?? [];
  tables.appSettings = fixture.appSettings ?? [];
  tables.categoryFeatures = fixture.categoryFeatures ?? [];
  return createFakeSource(tables);
}

interface FixtureIds {
  R1: string;
  R2: string;
  R3: string;
  R4: string;
  R5: string;
  R6: string;
  R7: string;
  R8: string;
  UNKNOWN_RELEASE: string;
  MEDIA_LIST_REGIONAL_LEGACY: string;
  MEDIA_LIST_UNKNOWN_LEGACY: string;
  USER_KNOWN: string;
  USER_UNKNOWN: string;
  R9: string;
  R10: string;
  R11: string;
  R12: string;
  SHARED_KEY: string;
}
const fx = fictionalFixture as unknown as YearFixture & { ids: FixtureIds };
const CORE_USER_ID = "99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CORE_USER_NAME = "Jane Doe";

// Fix round 1 follow-up: approve()'s key/numbering uses the real BC clock (bcYear(now, tz)),
// not an injectable one — WorkflowDeps/approve() have no test-clock hook (only the publisher
// does, via TestClock). So R12 — the release that seeds the "year"/"ministry" counters the
// real approve() test continues from — is patched to *today's* BC year here, at module load
// time (before any test's import runs), instead of a year hardcoded in the fixture file. This
// keeps the test passing regardless of which calendar year it happens to run in.
const BC_YEAR = bcYear(new Date(), "America/Vancouver");
const R12_KEY = `r12-${BC_YEAR}-seed`;
{
  const r12 = fx.years["2025"]!.releases!.find((r) => r.Id === fx.ids.R12)!;
  r12.Year = BC_YEAR;
  r12.Key = R12_KEY;
}

describe("importReleases — fictional fixture (all statuses, categories, media lists, log, top/feature, counters)", () => {
  let tdb: TestDatabase;
  let ctx: ImportReleasesContext;
  let report: ImportReport;

  async function freshContext(): Promise<ImportReleasesContext> {
    const [regional] = await tdb.db.select({ id: mediaLists.id }).from(mediaLists).where(eq(mediaLists.key, "regional"));
    report = new ImportReport();
    return {
      pageImageIds: new Map(),
      mediaListIds: new Map([[fx.ids.MEDIA_LIST_REGIONAL_LEGACY.toLowerCase(), regional!.id]]),
      termIds: new Map(),
      users: new Map([[fx.ids.USER_KNOWN.toLowerCase(), { id: CORE_USER_ID, displayName: CORE_USER_NAME }]]),
      report,
      timeZone: "America/Vancouver",
    };
  }

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    await seedTaxonomy(tdb.db);
    ctx = await freshContext();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  const byLegacyId = async (legacyId: string) => {
    const [row] = await tdb.db.select().from(newsReleases).where(eq(newsReleases.legacyId, legacyId.toLowerCase()));
    return row;
  };

  it("imports every status, preserves keys/references/activity ids, writes no outbox events or flickr jobs", async () => {
    await importReleases(tdb.db, buildFakeSource(fx), ctx);

    const r1 = await byLegacyId(fx.ids.R1);
    expect(r1).toMatchObject({ status: "draft", onHold: false, live: false });
    const r2 = await byLegacyId(fx.ids.R2);
    expect(r2).toMatchObject({ status: "draft", onHold: false });
    const r3 = await byLegacyId(fx.ids.R3);
    expect(r3).toMatchObject({ status: "approved", reference: "NEWS-00010", yearRelease: 5, ministryRelease: 2 });
    const r4 = await byLegacyId(fx.ids.R4);
    expect(r4).toMatchObject({ status: "scheduled", onHold: true, reference: "NEWS-00020" });
    const r5 = await byLegacyId(fx.ids.R5.toLowerCase());
    expect(r5).toMatchObject({ status: "published", live: true, reference: "NEWS-00021" });
    const r6 = await byLegacyId(fx.ids.R6);
    expect(r6).toMatchObject({ status: "deleted" });
    const r8 = await byLegacyId(fx.ids.R8);
    expect(r8).toMatchObject({ status: "published", reference: "NEWS-00022" });

    expect((await tdb.pool.query("SELECT count(*) FROM outbox_events")).rows[0].count).toBe("0");
    expect((await tdb.pool.query("SELECT count(*) FROM flickr_jobs")).rows[0].count).toBe("0");
  });

  it("writes the status-map note once for a release marked published but not committed", async () => {
    const r2 = await byLegacyId(fx.ids.R2);
    const logs = await tdb.db.select().from(releaseLog).where(eq(releaseLog.releaseId, r2!.id));
    expect(logs.map((l) => l.text)).toContain("Imported as a draft: legacy marked it published but not committed");
    expect(logs.filter((l) => l.text.startsWith("Imported as a draft")).length).toBe(1);
  });

  it("log actors: a known legacy user resolves to their Core id/name; null and unknown users resolve to System", async () => {
    const r5 = await byLegacyId(fx.ids.R5.toLowerCase());
    const logs = await tdb.db.select().from(releaseLog).where(eq(releaseLog.releaseId, r5!.id)).orderBy(releaseLog.at);
    const byText = new Map(logs.map((l) => [l.text, l]));
    expect(byText.get("Prepared by media office")).toMatchObject({ actorId: CORE_USER_ID, actorName: CORE_USER_NAME });
    expect(byText.get("Auto-approved overnight")).toMatchObject({ actorId: "system", actorName: "System" });
    expect(byText.get("Edited by a legacy account with no Core match")).toMatchObject({ actorId: "system", actorName: "System" });
  });

  it("drops an unknown category key and an unknown media list, with a warning, but imports the release", async () => {
    const r5 = await byLegacyId(fx.ids.R5.toLowerCase());
    const cats = await tdb.db.select().from(releaseCategories).where(eq(releaseCategories.releaseId, r5!.id));
    expect(cats.map((c) => c.key)).not.toContain("climate-unknown");
    expect(cats.map((c) => c.key)).toContain("health");
    const lists = await tdb.db.select().from(releaseMediaLists).where(eq(releaseMediaLists.releaseId, r5!.id));
    expect(lists.length).toBe(1);

    const json = report.toJSON();
    const unknownSector = json.warnings.find((w) => w.problems.some((p) => p.includes("Unknown sector key 'climate-unknown'")));
    expect(unknownSector).toBeDefined();
    const unknownMediaList = json.warnings.find((w) => w.problems.some((p) => p.includes("Unknown media distribution list")));
    expect(unknownMediaList).toBeDefined();
  });

  it("a release breaking per-type rules (missing headline/body/organizations) is imported anyway and warned", async () => {
    const json = report.toJSON();
    const r1Warning = json.warnings.find((w) => w.legacyId === fx.ids.R1.toLowerCase());
    expect(r1Warning).toBeDefined();
    expect(r1Warning!.problems.some((p) => p.includes("needs a headline"))).toBe(true);
    expect(r1Warning!.problems.some((p) => p.includes("needs body text"))).toBe(true);
  });

  it("Top/Feature: home top/feature and a ministry feature land; a slot pointing at an unpublished or unknown release is skipped", async () => {
    const r5 = await byLegacyId(fx.ids.R5.toLowerCase());
    const r8 = await byLegacyId(fx.ids.R8);

    const [home] = await tdb.db.select().from(categoryFeatures).where(and(eq(categoryFeatures.kind, "home"), eq(categoryFeatures.key, "default")));
    expect(home).toMatchObject({ topReleaseId: r5!.id, featureReleaseId: r8!.id });

    const [health] = await tdb.db.select().from(categoryFeatures).where(and(eq(categoryFeatures.kind, "ministries"), eq(categoryFeatures.key, "health")));
    expect(health).toMatchObject({ featureReleaseId: r5!.id });

    const [finance] = await tdb.db.select().from(categoryFeatures).where(and(eq(categoryFeatures.kind, "ministries"), eq(categoryFeatures.key, "finance")));
    expect(finance?.topReleaseId ?? null).toBeNull();

    const json = report.toJSON();
    expect(json.skipped.some((s) => s.table === "category_features" && s.reason.includes("not imported as published"))).toBe(true);
    expect(json.skipped.some((s) => s.table === "category_features" && s.reason.includes("unknown release"))).toBe(true);
  });

  it("report balances: for every table, legacy rows = imported + skipped", () => {
    const json = report.toJSON();
    for (const [table, c] of Object.entries(json.tables)) expect(c, table).toMatchObject({ legacy: c.imported + c.skipped });
  });

  it("re-running on unchanged legacy data changes nothing: same counts, no version bumps, no new log rows", async () => {
    const before = await tdb.db.select().from(newsReleases).orderBy(newsReleases.legacyId);
    const logsBefore = (await tdb.pool.query("SELECT count(*) FROM release_log")).rows[0].count;

    const freshCtx = await freshContext();
    await importReleases(tdb.db, buildFakeSource(fx), freshCtx);

    const after = await tdb.db.select().from(newsReleases).orderBy(newsReleases.legacyId);
    expect(after.map((r) => ({ legacyId: r.legacyId, version: r.version, importHash: r.importHash }))).toEqual(
      before.map((r) => ({ legacyId: r.legacyId, version: r.version, importHash: r.importHash })),
    );
    const logsAfter = (await tdb.pool.query("SELECT count(*) FROM release_log")).rows[0].count;
    expect(logsAfter).toBe(logsBefore);

    const json = freshCtx.report.toJSON();
    // 12 legacy releases: R1-R8 plus the fix-round-1 fault-isolation fixtures (R9 imports,
    // R10 collides on key, R11 violates the committed/publish_at check, R12 imports).
    expect(json.tables.news_releases).toEqual({ legacy: 12, imported: 10, skipped: 2 });
    for (const c of Object.values(json.tables)) expect(c.legacy).toBe(c.imported + c.skipped);
  });

  it("fix round 1 — a key collision across release types (C35) skips the second release and the run continues", async () => {
    const r9 = await byLegacyId(fx.ids.R9);
    expect(r9, "R9 (imported first) should exist").toBeDefined();
    expect(r9!.key).toBe(fx.ids.SHARED_KEY);

    const r10 = await byLegacyId(fx.ids.R10);
    expect(r10, "R10 (the colliding key) should never have been written").toBeUndefined();

    const json = report.toJSON();
    const expectedReason = `key '${fx.ids.SHARED_KEY}' already used by another imported release (legacy keys are unique per type; NRMS keys are unique across types — C35)`;
    expect(json.skipped.some((s) => s.table === "news_releases" && s.legacyId === fx.ids.R10.toLowerCase() && s.reason === expectedReason)).toBe(true);
    expect(json.warnings.some((w) => w.legacyId === fx.ids.R10.toLowerCase() && w.problems.includes(expectedReason))).toBe(true);

    // The run continued past the failure: R10's own 2 legacy categories (1 valid, 1 unknown)
    // are both skipped under the *same* failure reason, not leaked individually from the
    // category validation that ran (and warned) before the insert failed and rolled back.
    const r10CategorySkips = json.skipped.filter((s) => s.table === "release_categories" && s.legacyId === fx.ids.R10.toLowerCase());
    expect(r10CategorySkips).toHaveLength(2);
    expect(r10CategorySkips.every((s) => s.reason === expectedReason)).toBe(true);
    expect(json.warnings.some((w) => w.legacyId === fx.ids.R10.toLowerCase() && w.problems.some((p) => p.includes("Unknown sector key")))).toBe(false);
  });

  it("fix round 1 — a committed release with a null publish_at is skipped (not a key collision) and the run continues", async () => {
    const r11 = await byLegacyId(fx.ids.R11);
    expect(r11, "R11 should never have been written").toBeUndefined();

    const json = report.toJSON();
    const r11Skip = json.skipped.find((s) => s.table === "news_releases" && s.legacyId === fx.ids.R11.toLowerCase());
    expect(r11Skip).toBeDefined();
    expect(r11Skip!.reason).toContain("news_releases_committed_has_time");
    expect(r11Skip!.reason).not.toContain("params:");
    expect(r11Skip!.reason).not.toContain("already used by another imported release");

    // The run continued past both R10 and R11's failures: R12 (processed right after them) imported fine.
    const r12 = await byLegacyId(fx.ids.R12);
    expect(r12, "R12, processed after both failures, should still have imported").toBeDefined();
    expect(r12!.key).toBe(R12_KEY);
  });

  it("a release edited in NRMS after import is skipped by a re-run and listed in the report", async () => {
    const r8Before = await byLegacyId(fx.ids.R8);
    await saveMeta(
      tdb.db,
      r8Before!.id,
      { version: r8Before!.version, key: null, redirectUrl: null, location: "Nanaimo", summary: "Edited directly in NRMS", socialMediaSummary: null, keywords: null },
      editor,
    );
    const r8Edited = await byLegacyId(fx.ids.R8);
    expect(r8Edited!.version).toBe(r8Before!.version + 1);

    const freshCtx = await freshContext();
    await importReleases(tdb.db, buildFakeSource(fx), freshCtx);

    const r8After = await byLegacyId(fx.ids.R8);
    expect(r8After!.version).toBe(r8Edited!.version);
    const langs = await loadView(tdb.db, r8After!.id);
    expect(langs!.languages.find((l) => l.languageId === 4105)?.summary).toBe("Edited directly in NRMS");

    const json = freshCtx.report.toJSON();
    expect(json.skipped.some((s) => s.table === "news_releases" && s.legacyId === fx.ids.R8.toLowerCase() && s.reason === "edited in NRMS since the last import")).toBe(true);
  });

  it("legacy data changed for an unedited release re-imports it: children replaced, version bumped, import_hash changed", async () => {
    const r3Before = await byLegacyId(fx.ids.R3);
    const changed: typeof fx = JSON.parse(JSON.stringify(fx));
    const doc = changed.years["2023"]!.documentLanguages!.find((d: Record<string, unknown>) => d.DocumentId === "33333333-3333-4333-8333-000000000001")!;
    (doc as Record<string, unknown>).Headline = "Approved release — headline changed in legacy";

    const freshCtx = await freshContext();
    await importReleases(tdb.db, buildFakeSource(changed), freshCtx);

    const r3After = await byLegacyId(fx.ids.R3);
    expect(r3After!.version).toBe(r3Before!.version + 1);
    expect(r3After!.importedVersion).toBe(r3After!.version);
    expect(r3After!.importHash).not.toBe(r3Before!.importHash);

    const view = await loadView(tdb.db, r3After!.id);
    expect(view!.documents[0]!.languages[0]!.headline).toBe("Approved release — headline changed in legacy");
  });

  it("a scheduled release whose publish_at is in the past is not published by publishDue()", async () => {
    const r4 = await byLegacyId(fx.ids.R4);
    expect(r4).toMatchObject({ status: "scheduled", onHold: true });
    const result = await publishDue({ db: tdb.db, subscribers: [] });
    expect(result.published).not.toContain(r4!.key);
    const r4After = await byLegacyId(fx.ids.R4);
    expect(r4After).toMatchObject({ status: "scheduled", onHold: true });
  });

  it("counters: approving a brand-new release through the real workflow gets NEWS-<max+1> and the next yearRelease/ministryRelease", async () => {
    // Legacy maxes across every release processed (including R10/R11, which failed to import
    // but still occupied these numbers historically — Reference max is 99 from R6;
    // R12 seeds year=BC_YEAR at 20 and ministry=health/BC_YEAR at 7): approve()'s bcYear() uses
    // the real clock, so R12's Year was patched to match it at module load time, above.
    const v = await createRelease(
      tdb.db,
      {
        type: "release", pageTitle: "News Release", layout: "formal", pageImageId: null,
        headline: "A brand-new release created after import", subheadline: null, organizations: "Ministry of Health", byline: null,
        bodyHtml: "<p>Content.</p>", location: "Victoria", contacts: ["Media Relations\nMinistry of Health\n250-555-0999"],
        ministries: ["health"], leadMinistryKey: "health", sectors: ["health"], themes: [], tags: [], mediaListKeys: [], activityId: null, publishAt: null,
      },
      editor,
    );
    const approved = await approve(tdb.db, v.id, v.version, editor, { timeZone: "America/Vancouver" });
    expect(approved.reference).toBe("NEWS-00100");

    const [row] = await tdb.db.select().from(newsReleases).where(eq(newsReleases.id, v.id));
    expect(row).toMatchObject({ yearRelease: 21, ministryRelease: 8 });
    expect(approved.key).toBe(`${BC_YEAR}HLTH0008-000021`);
  });
});

describe("importReleases — api.news.gov.bc.ca fixture (3 published releases)", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    await tdb.db.insert(organizations).values([
      { key: "transportation-and-transit", displayName: "Transportation and Transit" },
      { key: "attorney-general", displayName: "Attorney General" },
      { key: "mining-and-critical-minerals", displayName: "Mining and Critical Minerals" },
    ]);
    await tdb.db.insert(categoryTerms).values([
      { kind: "sectors", key: "government-operations", displayName: "Government Operations" },
      { kind: "sectors", key: "services", displayName: "Services" },
      { kind: "themes", key: "british-columbians-and-our-governments", displayName: "British Columbians and Our Governments" },
      { kind: "themes", key: "law-crime-and-justice", displayName: "Law, Crime and Justice" },
      { kind: "themes", key: "employment-business-and-economic-development", displayName: "Employment, Business and Economic Development" },
      { kind: "themes", key: "farming-natural-resources-and-industry", displayName: "Farming, Natural Resources and Industry" },
      { kind: "tags", key: "look-west-strategy", displayName: "Look West Strategy" },
    ]);
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("imports the 3 real releases and toReleaseRecord() matches the API's headline/summary/key", async () => {
    const fixture = apiFixture as unknown as { releases: Record<string, unknown>[]; releaseLanguages: Record<string, unknown>[]; documents: Record<string, unknown>[]; documentLanguages: Record<string, unknown>[]; documentContacts: Record<string, unknown>[]; releaseCategories: Record<string, unknown>[]; releaseMediaLists: Record<string, unknown>[]; releaseLog: Record<string, unknown>[] };
    const asYearFixture: YearFixture = { years: { "2026": fixture } };
    const report = new ImportReport();
    const ctx: ImportReleasesContext = { pageImageIds: new Map(), mediaListIds: new Map(), termIds: new Map(), users: new Map(), report, timeZone: "America/Vancouver" };

    await importReleases(tdb.db, buildFakeSource(asYearFixture), ctx);

    const posts = [apiPostTT, apiPostAG, apiPostMCM] as { key: string; summary: string; documents: { headline: string }[] }[];
    for (const post of posts) {
      const [row] = await tdb.db.select().from(newsReleases).where(eq(newsReleases.key, post.key));
      expect(row, post.key).toBeDefined();
      const view = (await loadView(tdb.db, row!.id))!;
      const record = toReleaseRecord(view, { publishDate: view.releasedAt ?? new Date().toISOString(), timestamp: view.updatedAt });
      expect(record.key).toBe(post.key);
      expect(record.summary).toBe(post.summary);
      expect(record.documents[0]!.headline).toBe(post.documents[0]!.headline);
    }
  });

  it("C1: a release published at 11:52 PDT imports releasedAt as that instant, and replay's publishDate matches it", async () => {
    // apiPostAG (2026AG0068-001112): legacy ReleaseDateTime "2026-09-22T11:52:00Z" (DATETIME,
    // tedious's UTC fields holding the 11:52 PDT wall-clock value) and PublishDateTime
    // "2026-09-22T11:52:00-07:00" (DATETIMEOFFSET, already the real instant) both name the same
    // real moment: 2026-09-22T18:52:00Z (PDT is UTC-7).
    const EXPECTED_INSTANT = "2026-09-22T18:52:00.000Z";
    const [row] = await tdb.db.select().from(newsReleases).where(eq(newsReleases.key, apiPostAG.key));
    expect(row!.releasedAt?.toISOString()).toBe(EXPECTED_INSTANT);
    expect(row!.publishAt?.toISOString()).toBe(EXPECTED_INSTANT);

    const result = await replayToNewsApi(tdb.db, { confirm: true, subscribers: [] });
    expect(result.keys).toContain(apiPostAG.key);

    const [event] = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, apiPostAG.key));
    const envelope = event!.envelope as { data: { publishDate: string } };
    expect(envelope.data.publishDate).toBe(EXPECTED_INSTANT);
  });
});

describe("importReleases — one release of each of the five types", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    await seedTaxonomy(tdb.db);
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("imports release/story/factsheet/update/advisory; only the advisory has toWeb=false; activityId, key and reference are preserved", async () => {
    const fixture = fiveTypesFixture as unknown as YearFixture & { ids: Record<string, string> };
    const report = new ImportReport();
    const ctx: ImportReleasesContext = { pageImageIds: new Map(), mediaListIds: new Map(), termIds: new Map(), users: new Map(), report, timeZone: "America/Vancouver" };

    await importReleases(tdb.db, buildFakeSource(fixture), ctx);

    for (const [kind, legacyId] of Object.entries(fixture.ids)) {
      const [row] = await tdb.db.select().from(newsReleases).where(eq(newsReleases.legacyId, legacyId.toLowerCase()));
      expect(row, kind).toBeDefined();
      expect(row!.type, kind).toBe(kind);
      expect(row!.toWeb, `${kind} toWeb`).toBe(kind !== "advisory");
      expect(row!.key, kind).toBe(`five-types-${kind}`);
    }

    const [release] = await tdb.db.select().from(newsReleases).where(eq(newsReleases.legacyId, fixture.ids.release!.toLowerCase()));
    expect(release).toMatchObject({ activityId: 777000, reference: "NEWS-00050" });
    const [advisory] = await tdb.db.select().from(newsReleases).where(eq(newsReleases.legacyId, fixture.ids.advisory!.toLowerCase()));
    expect(advisory).toMatchObject({ activityId: null, reference: "NEWS-00054" });

    expect(report.toJSON().tables.news_releases).toEqual({ legacy: 5, imported: 5, skipped: 0 });
  });
});
