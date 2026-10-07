import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNrmsTestDb } from "../../../nrms/test/helpers";
import { newsReleases } from "../../../nrms/src/db/schema";
import { createNodTestDb } from "../../test/helpers";
import { FIXTURE_GUIDS as G, legacyNodSource, legacyNodTables, seedNodListsForImport } from "../../test/legacy-nod-fixture";
import { emergencyItemKey } from "../as-it-happens";
import { deliveries, items, nodSettings } from "../db/schema";
import { LEGACY_BATCH_ID } from "./articles";
import { NOD_IMPORT_LOCK, redactMessage, runNodImport, runNodImportCli } from "./run";

const OPTS = { timeZone: "America/Vancouver", sinceDays: 30, publicSiteUrl: "https://news.example.test" };
const RELEASE_KEY = "2026HLTH0001-000001";

describe("nod:import on the synthetic legacy database", () => {
  let nod: TestDatabase;
  let nrms: TestDatabase;
  const counts = async () =>
    (
      await nod.db.execute<Record<string, number>>(sql`
        SELECT (SELECT count(*)::int FROM subscribers) AS subscribers, (SELECT count(*)::int FROM subscriptions) AS subscriptions,
               (SELECT count(*)::int FROM subscriber_history) AS history, (SELECT count(*)::int FROM items) AS items,
               (SELECT count(*)::int FROM deliveries) AS deliveries`)
    ).rows[0];
  const reportDir = async () => join(await mkdtemp(join(tmpdir(), "nod-import-")), "report.json");

  beforeAll(async () => {
    nod = await createNodTestDb();
    nrms = await createNrmsTestDb();
    await nrms.db.insert(newsReleases).values({ type: "release", key: RELEASE_KEY, legacyId: G.nrmsRelease.toLowerCase() });
  });
  afterAll(async () => {
    await nod.drop();
    await nrms.drop();
  });
  beforeEach(async () => {
    await nod.db.execute(sql`DELETE FROM deliveries; DELETE FROM items; DELETE FROM subscriber_history; DELETE FROM subscriptions; DELETE FROM subscribers; DELETE FROM legacy_subscriber_imports;`);
    await nod.db.update(nodSettings).set({ lastDigestCutoff: null }).where(eq(nodSettings.id, 1));
    await seedNodListsForImport(nod.db);
  });

  it("imports with a balanced report: items, recent sends by mode, and the digest carries on from legacy's last", async () => {
    const json = (await runNodImport(nod.db, nrms.db, legacyNodSource(), OPTS)).toJSON();
    expect(json.balanced).toBe(true);
    expect(json.tables).toMatchObject({
      Article: { legacy: 4, imported: 2, skipped: 2 },
      SubscriberArticle: { legacy: 7, imported: 5, skipped: 2 },
    });
    expect(json.skipped.map((s) => [s.table, s.reason])).toEqual(
      expect.arrayContaining([
        ["Article", "newsletter or programs-and-services item: not carried over"],
        ["Article", "release not found in NRMS (import NRMS first)"],
        ["SubscriberArticle", "subscriber not imported"],
        ["SubscriberArticle", "no send for this subscriber's timing"],
      ]),
    );
    expect(json.notes.join("\n")).toContain("26 signups were waiting for confirmation in legacy");

    const [release] = await nod.db.select().from(items).where(eq(items.key, RELEASE_KEY));
    expect(release).toMatchObject({
      kind: "release", postKind: "releases", listKeys: ["ministries:health"], mediaListKeys: ["media-distribution-lists:000-0-victoria"],
      title: "Sample release", url: `https://news.example.test/releases/${RELEASE_KEY}`, publishedAt: new Date("2026-10-01T17:00:00Z"),
    });
    const [alert] = await nod.db.select().from(items).where(eq(items.key, emergencyItemKey("https://emergency.example.test/?p=77")));
    expect(alert).toMatchObject({ kind: "emergency", listKeys: ["emergency:alerts"], url: "https://emergency.example.test/alerts/77" });

    const sent = await nod.db.select().from(deliveries);
    const of = (g: string) =>
      sent
        .filter((d) => d.subscriberId === g.toLowerCase())
        .map((d) => [d.itemKey === RELEASE_KEY ? "release" : "alert", d.mode, d.bounceStatus])
        .sort();
    expect(of(G.subActive)).toEqual([["release", "as_it_happens", null]]);
    expect(of(G.subDigest)).toEqual([["alert", "as_it_happens", null], ["release", "digest", null]]);
    expect(of(G.subMedia)).toEqual([["release", "media", null]]);
    expect(of(G.subLeftMedia)).toEqual([["release", "as_it_happens", "legacy"]]);
    expect(sent.every((d) => d.distributionBatchId === LEGACY_BATCH_ID && d.attemptedAt !== null)).toBe(true);
    expect(sent.find((d) => d.bounceStatus === "legacy")?.hardBouncedAt).toEqual(new Date("2026-10-01T17:00:00Z"));

    const [s] = await nod.db.select({ cutoff: nodSettings.lastDigestCutoff }).from(nodSettings).where(eq(nodSettings.id, 1));
    expect(s!.cutoff).toEqual(new Date("2026-10-06T00:02:41.847Z"));
  });

  it("a second full run changes nothing", async () => {
    await runNodImport(nod.db, nrms.db, legacyNodSource(), OPTS);
    const before = await counts();
    const again = (await runNodImport(nod.db, nrms.db, legacyNodSource(), OPTS)).toJSON();
    expect(await counts()).toEqual(before);
    expect(again.balanced).toBe(true);
  });

  it("the digest cutoff only moves forward", async () => {
    const later = new Date("2026-10-20T00:00:00Z");
    await nod.db.update(nodSettings).set({ lastDigestCutoff: later }).where(eq(nodSettings.id, 1));
    await runNodImport(nod.db, nrms.db, legacyNodSource(), OPTS);
    const [s] = await nod.db.select({ cutoff: nodSettings.lastDigestCutoff }).from(nodSettings).where(eq(nodSettings.id, 1));
    expect(s!.cutoff).toEqual(later);
  });

  it("the CLI writes JSON and text reports with no address in either, logs none, and exits 0", async () => {
    const reportPath = await reportDir();
    const lines: string[] = [];
    expect(await runNodImportCli({ db: nod.db, nrms: nrms.db, source: legacyNodSource(), ...OPTS, reportPath, log: (m) => lines.push(m) })).toBe(0);
    const json = await readFile(reportPath, "utf8");
    const text = await readFile(reportPath.replace(/\.json$/, ".txt"), "utf8");
    for (const out of [json, text, lines.join("\n")]) expect(out).not.toContain("@");
  });

  it("a stage failing part-way exits 1, with a partial report naming the stage", async () => {
    const tables = legacyNodTables();
    delete tables.articles;
    const reportPath = await reportDir();
    expect(await runNodImportCli({ db: nod.db, nrms: nrms.db, source: legacyNodSource(tables), ...OPTS, reportPath })).toBe(1);
    const json = JSON.parse(await readFile(reportPath, "utf8"));
    expect(json).toMatchObject({ balanced: false, failed: { stage: "articles" }, tables: { Subscriber: { legacy: 9 } } });
  });

  it("refuses to run while another import holds the lock, and writes nothing", async () => {
    const client = await nod.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1, $2)", [...NOD_IMPORT_LOCK]);
      const lines: string[] = [];
      expect(await runNodImportCli({ db: nod.db, nrms: nrms.db, source: legacyNodSource(), ...OPTS, reportPath: await reportDir(), log: (m) => lines.push(m) })).toBe(1);
      expect(lines).toContain("another nod:import is already running");
      expect((await counts())!.subscribers).toBe(0);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1, $2)", [...NOD_IMPORT_LOCK]);
      client.release();
    }
  });

  it("failure messages lose bound values and anything shaped like an address", () => {
    expect(redactMessage("Failed query: insert into subscribers\nparams: someone@example.test,x\nduplicate key someone@example.test")).toBe(
      "Failed query: insert into subscribers\nduplicate key (address)",
    );
  });
});
