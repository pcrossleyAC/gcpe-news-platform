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

describe("0008 backfill", () => {
  let tdb: TestDatabase | undefined;
  afterEach(async () => tdb?.drop());

  it("0008 moves Phase 2 send state onto the new model", async () => {
    tdb = await createTestDatabase({ migrationsFolder: nodMigrations, upTo: "0006_drop_subscription_timing" });
    await tdb.db.execute(sql`
      INSERT INTO subscribers (id, email, manage_token, status) VALUES
        ('00000000-0000-0000-0000-000000000011', 'a@example.test', 't11', 'active'),
        ('00000000-0000-0000-0000-000000000012', 'b@example.test', 't12', 'active');
      INSERT INTO send_jobs (id, release_key, kind, subject, status, chunks_assigned) VALUES
        ('00000000-0000-0000-0000-0000000000f1', 'K1', 'as_it_happens', 'S', 'sent', true);
      INSERT INTO deliveries (release_key, subscriber_id, chunk_index) VALUES
        ('K1', '00000000-0000-0000-0000-000000000011', 0),
        ('K1', '00000000-0000-0000-0000-000000000012', 0);`);
    await tdb.migrate();
    const d = await tdb.db.execute<{ item_key: string; mode: string; job_id: string }>(sql`SELECT item_key, mode, job_id FROM deliveries ORDER BY subscriber_id`);
    expect(d.rows).toEqual([
      { item_key: "K1", mode: "as_it_happens", job_id: "00000000-0000-0000-0000-0000000000f1" },
      { item_key: "K1", mode: "as_it_happens", job_id: "00000000-0000-0000-0000-0000000000f1" },
    ]);
    const r = await tdb.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM job_recipients WHERE job_id = '00000000-0000-0000-0000-0000000000f1' AND chunk_index = 0`);
    expect(r.rows[0]!.n).toBe(2);
    const j = await tdb.db.execute<{ job_key: string; priority: string; item_key: string }>(sql`SELECT job_key, priority, item_key FROM send_jobs`);
    expect(j.rows[0]).toEqual({ job_key: "as_it_happens:K1", priority: "immediate", item_key: "K1" });
    const s = await tdb.db.execute<{ paused: boolean }>(sql`SELECT paused FROM nod_settings WHERE id = 1`);
    expect(s.rows[0]!.paused).toBe(false);
    const cols = await tdb.db.execute<{ column_name: string }>(sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'subscribers' AND column_name = 'manage_token'`);
    expect(cols.rows).toHaveLength(0);
  });
});

describe("0033 corrected copies", () => {
  let tdb: TestDatabase | undefined;
  afterEach(async () => tdb?.drop());

  // Review I1 (fix round 1): no primary-key rebuild and no full-table check scan on deliveries,
  // so the migration takes its lock for milliseconds. A corrected copy's mode carries its number.
  it("leaves the primary key and first sends alone, allows only 'correction:<n>' modes, without scanning the table", async () => {
    tdb = await createTestDatabase({ migrationsFolder: nodMigrations, upTo: "0032_items_link_identity_index" });
    await tdb.db.execute(sql`
      INSERT INTO subscribers (id, email, status) VALUES ('00000000-0000-0000-0000-000000000021', 'a@example.test', 'active');
      INSERT INTO items (key, kind, title, url, published_at) VALUES ('K1', 'release', 'T', 'https://x.test', now());
      INSERT INTO deliveries (item_key, subscriber_id, mode) VALUES ('K1', '00000000-0000-0000-0000-000000000021', 'media');`);
    await tdb.migrate();
    const pk = await tdb.db.execute<{ conname: string }>(sql`SELECT conname FROM pg_constraint WHERE conrelid = 'deliveries'::regclass AND contype = 'p'`);
    expect(pk.rows).toEqual([{ conname: "deliveries_item_key_subscriber_id_mode_pk" }]);
    const check = await tdb.db.execute<{ convalidated: boolean }>(sql`SELECT convalidated FROM pg_constraint WHERE conname = 'deliveries_mode_check'`);
    expect(check.rows).toEqual([{ convalidated: false }]);
    const cols = await tdb.db.execute<{ column_name: string }>(sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'deliveries' AND column_name = 'correction'`);
    expect(cols.rows).toHaveLength(0);
    const sid = "00000000-0000-0000-0000-000000000021";
    // First-send dedupe is exactly as before.
    expect((await tdb.db.execute(sql`INSERT INTO deliveries (item_key, subscriber_id, mode) VALUES ('K1', ${sid}, 'media') ON CONFLICT DO NOTHING RETURNING 1`)).rows).toHaveLength(0);
    await tdb.db.execute(sql`INSERT INTO deliveries (item_key, subscriber_id, mode) VALUES ('K1', ${sid}, 'correction:1'), ('K1', ${sid}, 'correction:2')`);
    for (const bad of ["correction", "correction:0", "correction:01", "corrections:1", "bogus"]) {
      await expect(tdb.db.execute(sql`INSERT INTO deliveries (item_key, subscriber_id, mode) VALUES ('K1', ${sid}, ${bad})`)).rejects.toThrow();
    }
    const items = await tdb.db.execute<{ corrections_sent: number }>(sql`SELECT corrections_sent FROM items`);
    expect(items.rows).toEqual([{ corrections_sent: 0 }]);
    const idx = await tdb.db.execute<{ indexname: string }>(sql`SELECT indexname FROM pg_indexes WHERE tablename = 'send_jobs' AND indexname = 'send_jobs_item_key_idx'`);
    expect(idx.rows).toHaveLength(1);
  });
});
