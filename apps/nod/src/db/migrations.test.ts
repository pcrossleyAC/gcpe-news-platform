import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";
import { nodMigrations } from "../../test/helpers";

describe("0005 backfill", () => {
  let tdb: TestDatabase | undefined;
  afterEach(async () => tdb?.drop());

  it("activates verified Phase 2 subscribers, keeps unverified ones pending, and lifts timing to the subscriber", async () => {
    tdb = await createTestDatabase({ migrationsFolder: nodMigrations, upTo: "0003_freeze_chunks" });
    await tdb.db.execute(sql`
      INSERT INTO subscribers (id, email, manage_token, verified_at) VALUES
        ('00000000-0000-0000-0000-000000000001', 'a@example.test', 't1', now()),
        ('00000000-0000-0000-0000-000000000002', 'b@example.test', 't2', NULL);
      INSERT INTO subscriptions (subscriber_id, list_key, as_it_happens) VALUES
        ('00000000-0000-0000-0000-000000000001', '*', false),
        ('00000000-0000-0000-0000-000000000002', 'ministries:health', true);`);
    await tdb.migrate();
    const rows = await tdb.db.execute<{ email: string; status: string; as_it_happens: boolean }>(
      sql`SELECT email, status, as_it_happens FROM subscribers ORDER BY email`);
    expect(rows.rows).toEqual([
      { email: "a@example.test", status: "active", as_it_happens: false },
      { email: "b@example.test", status: "pending", as_it_happens: true },
    ]);
    const cats = await tdb.db.execute<{ key: string }>(sql`SELECT key FROM list_categories ORDER BY sort_order`);
    expect(cats.rows.map((r) => r.key)).toEqual(["ministries", "sectors", "themes", "tags", "emergency", "media-distribution-lists"]);
  });
});
