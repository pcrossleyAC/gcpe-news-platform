import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";
import { sampleRelease } from "@gcpe/events/testing";
import { newsMigrations } from "../../test/helpers";
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
    ]);
  });
});
