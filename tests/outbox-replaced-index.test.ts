// Suite review fix round 2, I2 (controller ruling 2026-11-01): the "replaced" check
// (packages/events undelivered.ts) looks up newer events for the same record by
// (aggregate_id, sequence). Without an index that is a full scan of outbox_events per undelivered
// row, and /stack/health took seconds on a large outbox. Every app with an outbox must carry it.
import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";

const root = join(__dirname, "..");
const APPS = ["core", "nrms", "distribution", "news-api", "calendar"];

describe("every outbox app indexes outbox_events by record and sequence", () => {
  const made: TestDatabase[] = [];
  afterAll(async () => {
    for (const t of made) await t.drop();
  });

  it.each(APPS)("%s", async (app) => {
    const tdb = await createTestDatabase({ migrationsFolder: join(root, "apps", app, "migrations") });
    made.push(tdb);
    const { rows } = await tdb.pool.query("SELECT indexdef FROM pg_indexes WHERE tablename = 'outbox_events' AND indexname = 'outbox_events_aggregate_seq_idx'");
    expect(rows.map((r) => r.indexdef)).toEqual([expect.stringMatching(/\(aggregate_id, sequence\)/)]);
  });
});
