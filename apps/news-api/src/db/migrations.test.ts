import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";
import { sampleRelease } from "@gcpe/events/testing";
import pg from "pg";
import { newsMigrations, waitUntilBlockedOnLock } from "../../test/helpers";
import { CHANGES_LOCK } from "../changes";
import { applyRelease } from "../projections";

describe("0012 unpublish advisories", () => {
  let tdb: TestDatabase | undefined;
  afterEach(async () => tdb?.drop());

  // Suite review R1: Advisories an older build stored as public come off the site on deploy.
  it("takes every stored Advisory off the site, records the change for the public site, and leaves other posts alone", async () => {
    tdb = await createTestDatabase({ migrationsFolder: newsMigrations, upTo: "0011_public_import_posts" });
    const db = tdb.db;
    // What an older build stored: an Advisory written as a public post, from either pipeline.
    const asPublic = { ...sampleRelease.publishFlags, toWeb: true };
    await db.transaction((tx) => applyRelease(tx, { ...sampleRelease, key: "2026FIN0001-000006", kind: "advisories", publishFlags: asPublic }));
    await db.transaction((tx) => applyRelease(tx, { ...sampleRelease, key: "2019ENV0002-000123", kind: "advisories", publishFlags: asPublic }, { origin: "legacy" }));
    await db.transaction((tx) => applyRelease(tx, { ...sampleRelease, key: "2026FIN0002-000007" }));
    // Fix round 1 (review M1): a post whose semantic related list names the Advisory is re-rendered.
    await db.execute(sql`INSERT INTO post_related (post_key, related_keys) VALUES ('2026FIN0002-000007', ARRAY['2026fin0001-000006'])`);
    await db.execute(sql`TRUNCATE changes RESTART IDENTITY`);
    await tdb.migrate();
    const rows = await db.execute<{ key: string; is_published: boolean }>(sql`SELECT key, is_published FROM posts ORDER BY key`);
    expect(rows.rows).toEqual([
      { key: "2019ENV0002-000123", is_published: false },
      { key: "2026FIN0001-000006", is_published: false },
      { key: "2026FIN0002-000007", is_published: true },
    ]);
    const changes = await db.execute<{ kind: string; key: string }>(sql`SELECT kind, key FROM changes ORDER BY id`);
    expect(changes.rows).toEqual([
      { kind: "post.unpublished", key: "2019ENV0002-000123" },
      { kind: "post.unpublished", key: "2026FIN0001-000006" },
      { kind: "post.upserted", key: "2026FIN0002-000007" },
    ]);
  });

  // Fix round 1 (review I1): a feed reader's cursor must never pass the migration's change rows
  // before they commit, so the migration takes the feed's lock as every writer does.
  it("waits for the change feed's lock, so its change rows come after any committed before it", async () => {
    tdb = await createTestDatabase({ migrationsFolder: newsMigrations, upTo: "0011_public_import_posts" });
    const db = tdb.db;
    await db.transaction((tx) => applyRelease(tx, { ...sampleRelease, key: "ADV-LOCK", kind: "advisories", publishFlags: { ...sampleRelease.publishFlags, toWeb: true } }));
    await db.execute(sql`TRUNCATE changes RESTART IDENTITY`);
    expect(CHANGES_LOCK).toEqual([1734570085, 4]);
    const other = new pg.Client({ connectionString: tdb.url });
    await other.connect();
    try {
      await other.query("BEGIN");
      await other.query("SELECT pg_advisory_xact_lock($1, $2)", [...CHANGES_LOCK]);
      let migrated = false;
      const migrating = tdb.migrate().then(() => void (migrated = true));
      await waitUntilBlockedOnLock(tdb.pool);
      expect(migrated).toBe(false);
      await other.query("INSERT INTO changes (kind, key) VALUES ('home', NULL)");
      await other.query("COMMIT");
      await migrating;
    } finally {
      await other.end();
    }
    const changes = await db.execute<{ kind: string; key: string | null }>(sql`SELECT kind, key FROM changes ORDER BY id`);
    expect(changes.rows).toEqual([{ kind: "home", key: null }, { kind: "post.unpublished", key: "ADV-LOCK" }]);
  });
});
