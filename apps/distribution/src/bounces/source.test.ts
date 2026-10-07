import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createDistributionTestDb } from "../../test/helpers";
import { bounceInbox } from "../db/schema";
import { fakeBounceSource } from "./source";

describe("fakeBounceSource", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createDistributionTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.db.execute(sql`TRUNCATE TABLE bounce_inbox`);
  });

  it("fetches only unprocessed rows, oldest first, up to the given limit", async () => {
    const [a] = await tdb.db.insert(bounceInbox).values({ raw: "raw-a", receivedAt: new Date(Date.now() - 3000) }).returning({ id: bounceInbox.id });
    const [b] = await tdb.db.insert(bounceInbox).values({ raw: "raw-b", receivedAt: new Date(Date.now() - 2000) }).returning({ id: bounceInbox.id });
    const [c] = await tdb.db.insert(bounceInbox).values({ raw: "raw-c", receivedAt: new Date(Date.now() - 1000) }).returning({ id: bounceInbox.id });
    await tdb.db.update(bounceInbox).set({ processedAt: sql`now()` }).where(sql`id = ${b!.id}`);

    const source = fakeBounceSource(tdb.db);
    const fetched = await source.fetchNew(10);

    expect(fetched).toEqual([
      { id: a!.id, raw: "raw-a" },
      { id: c!.id, raw: "raw-c" },
    ]);
  });

  it("respects the limit", async () => {
    for (let i = 0; i < 5; i++) await tdb.db.insert(bounceInbox).values({ raw: `raw-${i}` });
    const source = fakeBounceSource(tdb.db);
    expect(await source.fetchNew(2)).toHaveLength(2);
  });

  it("markProcessed removes rows from future fetchNew results", async () => {
    const [row] = await tdb.db.insert(bounceInbox).values({ raw: "raw-x" }).returning({ id: bounceInbox.id });
    const source = fakeBounceSource(tdb.db);

    expect(await source.fetchNew(10)).toEqual([{ id: row!.id, raw: "raw-x" }]);
    await source.markProcessed([row!.id]);
    expect(await source.fetchNew(10)).toEqual([]);

    const [dbRow] = await tdb.db.select().from(bounceInbox).where(sql`id = ${row!.id}`);
    expect(dbRow?.processedAt).not.toBeNull();
  });

  it("markProcessed with an empty array is a no-op", async () => {
    const source = fakeBounceSource(tdb.db);
    await expect(source.markProcessed([])).resolves.toBeUndefined();
  });
});
