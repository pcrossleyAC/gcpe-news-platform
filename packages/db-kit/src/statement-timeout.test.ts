import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { createTestDatabase, type TestDatabase } from "./test-db";
import { isStatementTimeout, withStatementTimeout } from "./statement-timeout";

// Suite review fix round 2, I2: /stack/health's queries run under a short statement timeout.
describe("withStatementTimeout", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase({ migrationsFolder: fileURLToPath(new URL("../../events/test/migrations", import.meta.url)) });
  });
  afterAll(async () => tdb.drop());

  it("answers as usual within the limit", async () => {
    const r = await withStatementTimeout(tdb.db, 2_000, (tx) => tx.execute<{ n: number }>(sql`SELECT 1 AS n`));
    expect(r.rows[0]!.n).toBe(1);
  });

  it("cancels a statement past the limit, recognisably, and leaves the pool's other queries untouched", async () => {
    const caught = await withStatementTimeout(tdb.db, 100, (tx) => tx.execute(sql`SELECT pg_sleep(1)`)).catch((e: unknown) => e);
    expect(isStatementTimeout(caught)).toBe(true);
    expect(isStatementTimeout(new Error("other"))).toBe(false);
    // SET LOCAL: the next statement on that connection has no limit.
    const r = await tdb.db.execute<{ statement_timeout: string }>(sql`SHOW statement_timeout`);
    expect(r.rows[0]!.statement_timeout).toBe("0");
  });
});
