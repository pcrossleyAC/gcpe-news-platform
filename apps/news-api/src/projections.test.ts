import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type pg from "pg";
import type { TestDatabase } from "@gcpe/db-kit";
import type { OrgRecord, ReleaseRecord, TermRecord } from "@gcpe/events";
import { sampleRelease } from "@gcpe/events/testing";
import { createNewsTestDb } from "../test/helpers";
import { categories, categoryFeatures, home, posts, resourceLinks, slides } from "./db/schema";
import { applyOrg, applyRelease, applySiteContent, applyTerm, deactivateCategory, indexKeysFor, unpublishRelease } from "./projections";
import { listenForUpdates, notifyUpdate, type UpdateTarget } from "./updates/notify";

/**
 * Polls pg_stat_activity until some backend in this database is actually blocked waiting on a
 * lock. Used instead of an arbitrary sleep so the race test's interleaving — issue the
 * importer's write while a row lock is held, then release it — is guaranteed to occur, not
 * just likely to occur within some fixed delay. `query` in pg_stat_activity holds a
 * parameterized statement's placeholders, not its bound values, so this deliberately doesn't
 * try to match the query text — on this throwaway, single-use test database, any backend
 * blocked on a lock at this moment is the one the test is waiting for.
 */
async function waitUntilBlockedOnLock(pool: pg.Pool, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()");
    if (rows.length > 0) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for a backend to block on a lock");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const org: OrgRecord = {
  key: "health", displayName: "Health", abbreviation: "HLTH", sortOrder: 5, isActive: true, parentKey: null, url: "http://gov.bc.ca/health",
  displayAdditionalName: null,
  minister: { name: "Honourable Sam Placeholder", summary: "Honourable Sam Placeholder", detailsHtml: "<p>bio</p>", email: "SP.Minister@gov.bc.ca", photoUrl: null, address: "PO BOX 9050" },
  contact: null, secondContact: null, weekendContactNumber: "", social: { twitterUsername: "", flickrUrl: null, youtubeUrl: null, audioUrl: null },
  topicLinks: [], serviceLinks: [], sectorKeys: [], isHq: false, isPublic: true, updatedAt: "2026-10-02T16:46:05.527-07:00",
};

describe("projections", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNewsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE posts, categories, category_features, home, slides, resource_links");
  });

  it("builds lowercased index keys", () => {
    expect(indexKeysFor({ ministryKeys: ["Health"], sectorKeys: ["economy"], tagKeys: [], themeKeys: ["T1"] })).toEqual([
      "ministries:health",
      "sectors:economy",
      "themes:t1",
    ]);
  });

  it("upserts a release and unpublishes it", async () => {
    await tdb.db.transaction((tx) => applyRelease(tx, sampleRelease));
    await tdb.db.transaction((tx) => applyRelease(tx, { ...sampleRelease, summary: "changed" }));
    const [row] = await tdb.db.select().from(posts).where(eq(posts.key, sampleRelease.key));
    expect(row!.summary).toBe("changed");
    expect(row!.indexKeys).toContain("ministries:transportation-and-transit");
    expect(row!.timestamp.toISOString()).toBe("2026-10-01T22:10:28.037Z");
    await tdb.db.transaction((tx) => unpublishRelease(tx, sampleRelease.key.toLowerCase()));
    const [after] = await tdb.db.select().from(posts).where(eq(posts.key, sampleRelease.key));
    expect(after!.isPublished).toBe(false);
  });

  it("rejects an origin value outside 'legacy' | 'event' (posts_origin_check)", async () => {
    await tdb.db.transaction((tx) => applyRelease(tx, sampleRelease));
    await expect(tdb.pool.query("UPDATE posts SET origin = 'bogus' WHERE key = $1", [sampleRelease.key])).rejects.toThrow(/posts_origin_check/);
  });

  // Controller ruling P1-R22: findExistingPost is a plain read, so a check-then-write guard
  // in application code would race against a concurrent NRMS write that commits in between —
  // the importer would still clobber it and report success. The guard must be the SQL
  // onConflictDoUpdate `setWhere`, re-evaluated against whatever row Postgres has actually
  // locked at write time, not against this function's earlier read.
  it("closes the check-then-write race: a concurrent event-origin commit mid-upsert still wins", async () => {
    const KEY = "RACE-1";
    // Starts out legacy-owned, so the importer's write below is a genuine UPDATE (a conflict),
    // not a fresh INSERT — only the UPDATE path goes through setWhere.
    await tdb.db.transaction((tx) => applyRelease(tx, { ...sampleRelease, key: KEY, summary: "legacy content" }, { origin: "legacy" }));

    const txnA = await tdb.pool.connect();
    try {
      // 1. Transaction A applies an NRMS event for KEY (origin -> 'event', new content) and
      // row-locks it, but does not commit yet.
      await txnA.query("BEGIN");
      await txnA.query("UPDATE posts SET origin = 'event', summary = $1 WHERE key = $2", ["NRMS content", KEY]);

      // 2. Start the importer's applyRelease for KEY concurrently, on a different pool
      // connection. findExistingPost (read-committed) still sees the pre-race row (origin
      // 'legacy', uncommitted update from A is invisible to it), so it does NOT take the
      // cheap pre-check's early exit — it reaches the real onConflictDoUpdate, whose UPDATE
      // then blocks trying to acquire the row lock A is already holding.
      const importerDone = tdb.db.transaction((tx) =>
        applyRelease(tx, { ...sampleRelease, key: KEY, summary: "stale legacy content" }, { notify: false, origin: "legacy" }),
      );

      // Wait until Postgres actually reports the importer's backend blocked on a lock (never
      // an arbitrary sleep) before committing A, so the interleaving above is guaranteed, not
      // just likely.
      await waitUntilBlockedOnLock(tdb.pool);

      // 3. Commit A.
      await txnA.query("COMMIT");

      // 4. The importer's statement unblocks, re-evaluates setWhere against the now-committed
      // row (origin = 'event'), and skips its UPDATE — RETURNING yields zero rows.
      const result = await importerDone;
      expect(result).toEqual({ skippedEventOwned: true });

      // 5. NRMS's content wins; the importer never touched the row.
      const [row] = await tdb.db.select().from(posts).where(eq(posts.key, KEY));
      expect(row).toMatchObject({ origin: "event", summary: "NRMS content" });
    } finally {
      await txnA.query("ROLLBACK").catch(() => {});
      txnA.release();
    }
  });

  // Concurrent first writes of one key in two casings: without the per-identity advisory lock
  // both pre-checks see no row and the second insert raises 23505 on posts_key_lower_idx.
  it("serialises concurrent first writes of a key that differ only by case", async () => {
    let release!: () => void;
    let signalWritten!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const written = new Promise<void>((r) => (signalWritten = r));
    const first = tdb.db.transaction(async (tx) => {
      await applyRelease(tx, { ...sampleRelease, key: "CASE-1", summary: "first" }, { notify: false });
      signalWritten();
      await gate; // hold the transaction open until the second writer is provably waiting
    });
    await written;
    const second = tdb.db.transaction((tx) => applyRelease(tx, { ...sampleRelease, key: "case-1", summary: "second" }, { notify: false }));
    await waitUntilBlockedOnLock(tdb.pool);
    release();
    await first;
    await expect(second).resolves.toEqual({ skippedEventOwned: false });
    const rows = await tdb.db.select({ key: posts.key, summary: posts.summary }).from(posts).where(sql`lower(${posts.key}) = 'case-1'`);
    expect(rows).toEqual([{ key: "CASE-1", summary: "second" }]);
  });

  it("serialises concurrent first writes of a category that differ only by case", async () => {
    let release!: () => void;
    let signalWritten!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const written = new Promise<void>((r) => (signalWritten = r));
    const term: TermRecord = { kind: "sector", key: "Mining", displayName: "Mining", sortOrder: 0, isActive: true, social: org.social, updatedAt: "2026-10-02T00:00:00Z" };
    const first = tdb.db.transaction(async (tx) => {
      await applyTerm(tx, term);
      signalWritten();
      await gate;
    });
    await written;
    const second = tdb.db.transaction((tx) => applyTerm(tx, { ...term, key: "MINING", displayName: "Mining 2" }));
    await waitUntilBlockedOnLock(tdb.pool);
    release();
    await first;
    await second;
    const rows = await tdb.db.select({ key: categories.key, name: categories.name }).from(categories).where(sql`lower(${categories.key}) = 'mining'`);
    expect(rows).toEqual([{ key: "Mining", name: "Mining 2" }]);
  });

  it("upserts a release across key casing without a unique violation", async () => {
    await tdb.db.transaction((tx) => applyRelease(tx, { ...sampleRelease, key: "R1" }));
    await tdb.db.transaction((tx) => applyRelease(tx, { ...sampleRelease, key: "r1", summary: "changed" }));
    const rows = await tdb.db.select().from(posts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "R1", summary: "changed" });
  });

  it("projects an org into categories with ministry details", async () => {
    await tdb.db.transaction((tx) => applyOrg(tx, org));
    const [row] = await tdb.db.select().from(categories).where(eq(categories.key, "health"));
    expect(row).toMatchObject({ kind: "ministries", name: "Health", sortOrder: 5, isActive: true });
    expect(row!.ministry!.minister.email).toBe("SP.Minister@gov.bc.ca");
  });

  it("upserts an org across key casing without a unique violation", async () => {
    await tdb.db.transaction((tx) => applyOrg(tx, org));
    await tdb.db.transaction((tx) => applyOrg(tx, { ...org, key: "HEALTH", displayName: "Health Updated" }));
    const rows = await tdb.db.select().from(categories);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "health", name: "Health Updated" });
  });

  it("upserts a term across key casing without a unique violation", async () => {
    const term = { kind: "sector" as const, key: "economy", displayName: "Economy", sortOrder: 1, isActive: true, social: org.social, updatedAt: org.updatedAt };
    await tdb.db.transaction((tx) => applyTerm(tx, term));
    await tdb.db.transaction((tx) => applyTerm(tx, { ...term, key: "ECONOMY", displayName: "Economy Updated" }));
    const rows = await tdb.db.select().from(categories);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "sectors", key: "economy", name: "Economy Updated" });
  });

  it("ignores service terms", async () => {
    await tdb.db.transaction((tx) =>
      applyTerm(tx, { kind: "service", key: "x", displayName: "X", sortOrder: 0, isActive: true, social: org.social, updatedAt: org.updatedAt }),
    );
    expect(await tdb.db.select().from(categories)).toHaveLength(0);
  });

  it("notifies on deactivation only when a row actually changes", async () => {
    await tdb.db.transaction((tx) => applyOrg(tx, org)); // key "health", isActive: true

    const got: [UpdateTarget, string[]][] = [];
    const { stop } = await listenForUpdates(tdb.pool, (t, k) => got.push([t, k]));

    // Missing key: no row changes, so no notification.
    await tdb.db.transaction((tx) => deactivateCategory(tx, "ministries", "does-not-exist"));
    await new Promise((r) => setTimeout(r, 150));
    expect(got).toEqual([]);

    // Active -> inactive (case-insensitive match): notifies once, with the stored casing.
    await tdb.db.transaction((tx) => deactivateCategory(tx, "ministries", "HEALTH"));
    await new Promise((r) => setTimeout(r, 150));
    expect(got).toEqual([["MinistryUpdate", ["health"]]]);

    // Already inactive: no further notification.
    got.length = 0;
    await tdb.db.transaction((tx) => deactivateCategory(tx, "ministries", "health"));
    await new Promise((r) => setTimeout(r, 150));
    expect(got).toEqual([]);

    const [row] = await tdb.db.select().from(categories).where(eq(categories.key, "health"));
    expect(row!.isActive).toBe(false);

    await stop();
  });

  it("applies each site content entity", async () => {
    await tdb.db.transaction(async (tx) => {
      await applySiteContent(tx, { entity: "home", topPostKey: "a", featurePostKey: "b", liveWebcastFlashMediaManifestUrl: null, liveWebcastM3uPlaylist: null, granville: null, timestamp: "2026-10-02T10:34:49.0859062-07:00" });
      await applySiteContent(tx, { entity: "categoryFeatures", kind: "ministries", key: "Health", topPostKey: "t", featurePostKey: "f" });
      await applySiteContent(tx, {
        entity: "slides",
        slides: [{ id: "f9adfdc2-5933-4c38-a390-a18077acb213", sortIndex: 0, headline: "Get vaccinated", summary: "s", actionLabel: "READ MORE", actionUri: "https://x", imageBase64: "iVBORw0KGgo=", imageType: "image/png", facebookPostUri: null, justify: "right", timestamp: "2026-09-09T16:31:07.5216222-07:00" }],
      });
      await applySiteContent(tx, { entity: "resourceLinks", links: [{ sortIndex: 0, text: "Factsheets", uri: "/factsheets" }], timestamp: "2026-10-02T00:00:00Z" });
    });
    expect((await tdb.db.select().from(home))[0]!.featurePostKey).toBe("b");
    expect((await tdb.db.select().from(categoryFeatures))[0]).toEqual({ kind: "ministries", key: "health", topPostKey: "t", featurePostKey: "f" });
    expect((await tdb.db.select().from(slides))[0]!.image!.toString("base64")).toBe("iVBORw0KGgo=");
    expect(await tdb.db.select().from(resourceLinks)).toHaveLength(1);
  });

  it("notifies listeners only after commit", async () => {
    const got: [UpdateTarget, string[]][] = [];
    const { stop } = await listenForUpdates(tdb.pool, (t, k) => got.push([t, k]));
    await expect(
      tdb.db.transaction(async (tx) => {
        await applyRelease(tx, { ...sampleRelease, key: "rolled-back" });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    await tdb.db.transaction((tx) => applyRelease(tx, sampleRelease));
    await new Promise((r) => setTimeout(r, 200));
    await stop();
    expect(got).toEqual([["PostUpdate", [sampleRelease.key]]]);
  });

  // Final review M6: ministry notifications must reach every ministry whose rendered DTO
  // changed — including a parent whose childMinistryKey moved — using the stored key casing.
  describe("ministry notification fan-out", () => {
    /** Runs `fn` in a transaction and returns exactly the notifications it produced: a
     * sentinel is notified afterwards in its own transaction, and since NOTIFYs arrive in
     * commit order, everything from `fn` has been delivered once the sentinel shows up. */
    async function notificationsFrom(fn: Parameters<typeof tdb.db.transaction>[0]): Promise<[UpdateTarget, string[]][]> {
      const got: [UpdateTarget, string[]][] = [];
      const { stop } = await listenForUpdates(tdb.pool, (t, k) => got.push([t, k]));
      try {
        await tdb.db.transaction(fn);
        await tdb.db.transaction((tx) => notifyUpdate(tx, "HomeUpdate", ["__sentinel"]));
        await vi.waitFor(() => expect(got.at(-1)).toEqual(["HomeUpdate", ["__sentinel"]]));
        return got.slice(0, -1);
      } finally {
        await stop();
      }
    }
    const ministry = (key: string, parentKey: string | null, isActive = true): OrgRecord => ({ ...org, key, displayName: key, parentKey, isActive });

    it("applyOrg notifies the previous parent (stored casing) when parentKey changes", async () => {
      await tdb.db.transaction(async (tx) => {
        await applyOrg(tx, ministry("Premier", null));
        await applyOrg(tx, ministry("Forests", null));
        await applyOrg(tx, ministry("local-gov", "premier"));
      });
      const got = await notificationsFrom((tx) => applyOrg(tx, ministry("local-gov", "forests")));
      expect(got).toEqual([
        ["MinistryUpdate", ["local-gov", "Forests", "Premier"]],
        ["MinisterUpdate", ["local-gov"]],
      ]);
    });

    it("applyOrg with an unchanged parent notifies that parent once", async () => {
      await tdb.db.transaction(async (tx) => {
        await applyOrg(tx, ministry("Premier", null));
        await applyOrg(tx, ministry("local-gov", "Premier"));
      });
      const got = await notificationsFrom((tx) => applyOrg(tx, ministry("local-gov", "PREMIER")));
      expect(got).toEqual([
        ["MinistryUpdate", ["local-gov", "Premier"]],
        ["MinisterUpdate", ["local-gov"]],
      ]);
    });

    it("deactivating a child ministry also notifies its parent (stored casing)", async () => {
      await tdb.db.transaction(async (tx) => {
        await applyOrg(tx, ministry("Premier", null));
        await applyOrg(tx, ministry("local-gov", "premier"));
      });
      const got = await notificationsFrom((tx) => deactivateCategory(tx, "ministries", "LOCAL-GOV"));
      expect(got).toEqual([["MinistryUpdate", ["local-gov", "Premier"]]]);
    });

    it("categoryFeatures notifies with the stored category key casing", async () => {
      await tdb.db.transaction((tx) => applyOrg(tx, ministry("Health", null)));
      const got = await notificationsFrom((tx) =>
        applySiteContent(tx, { entity: "categoryFeatures", kind: "ministries", key: "HEALTH", topPostKey: "t", featurePostKey: "f" }),
      );
      expect(got).toEqual([["MinistryUpdate", ["Health"]]]);
    });
  });
});
