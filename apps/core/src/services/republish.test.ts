import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import type { Db, TestDatabase } from "@gcpe/db-kit";
import { outboxEvents, type EventEnvelope, type OrgRecord, type SubscriberConfig } from "@gcpe/events";
import { createCoreTestDb, healthOrg } from "../../test/helpers";
import { upsertOrganization } from "./organizations";
import { republishAll } from "./republish";
import { upsertTerm } from "./terms";

const subs: SubscriberConfig[] = [{ name: "news-api", url: "http://x/events", secret: "s", types: ["*"] }];

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("republishAll", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCoreTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE organizations, terms, outbox_events, aggregate_sequences CASCADE");
  });

  it("enqueues one upserted event per organization and term", async () => {
    await upsertOrganization(tdb.db, healthOrg, subs);
    await upsertTerm(tdb.db, { kind: "tag", key: "t", displayName: "T", sortOrder: 0, isActive: true, social: healthOrg.social }, subs);
    expect(await republishAll(tdb.db, subs)).toBe(2);
    const types = (await tdb.db.select().from(outboxEvents)).map((e) => `${e.type}@${e.aggregateId}#${e.sequence}`).sort();
    expect(types).toEqual(["org.upserted@org:health#1", "org.upserted@org:health#2", "tag.upserted@tag:t#1", "tag.upserted@tag:t#2"]);
  });

  it("an upsert committing while republish runs never leaves stale data as the newest event", async () => {
    await upsertOrganization(tdb.db, healthOrg, subs);

    // Hold an upsert open (its locks stay held until the outer transaction commits).
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let upserted!: () => void;
    const upsertDone = new Promise<void>((r) => (upserted = r));
    const writer = tdb.db.transaction(async (tx) => {
      // tx.transaction() nests as a savepoint, so upsertOrganization runs inside our open transaction.
      await upsertOrganization(tx as unknown as Db, { ...healthOrg, displayName: "Health and Wellness" }, subs);
      upserted();
      await gate;
    });
    await upsertDone;

    const republish = republishAll(tdb.db, subs);
    // Wait until republish is blocked behind the writer's locks, then let the writer commit.
    await waitFor(async () => {
      const { rows } = await tdb.pool.query(
        `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE NOT l.granted AND a.datname = current_database()`,
      );
      return rows[0].n > 0;
    });
    release();
    await writer;
    expect(await republish).toBe(1);

    const [latest] = await tdb.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, "org:health"))
      .orderBy(desc(outboxEvents.sequence))
      .limit(1);
    expect(latest!.sequence).toBe(3);
    expect((latest!.envelope as EventEnvelope<OrgRecord>).data.displayName).toBe("Health and Wellness");
  });
});
