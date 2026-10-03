import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { adminUrl, createTestDatabase, type TestDatabase } from "./test-db";
import { fileURLToPath } from "node:url";

const migrationsFolder = fileURLToPath(new URL("../test/migrations", import.meta.url));
const badMigrationsFolder = fileURLToPath(new URL("../test/bad-migrations", import.meta.url));

async function countDatabasesWithPrefix(prefix: string): Promise<number> {
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE position($1 in datname) = 1", [prefix]);
    return rowCount ?? 0;
  } finally {
    await admin.end();
  }
}

describe("createTestDatabase", () => {
  let tdb: TestDatabase;
  afterAll(async () => {
    await tdb?.drop();
  });

  it("creates a fresh database, runs migrations and enables extensions", async () => {
    tdb = await createTestDatabase({ migrationsFolder, extensions: ["vector"] });
    await tdb.pool.query("INSERT INTO widgets (name) VALUES ('a')");
    const { rows } = await tdb.pool.query("SELECT count(*)::int AS n FROM widgets");
    expect(rows[0].n).toBe(1);
    const ext = await tdb.pool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
    expect(ext.rowCount).toBe(1);
  });

  it("drop() removes the database", async () => {
    const other = await createTestDatabase({ migrationsFolder });
    const name = new URL(other.url).pathname.slice(1);
    await other.drop();
    const admin = new pg.Client({ connectionString: adminUrl() });
    await admin.connect();
    const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    await admin.end();
    expect(rowCount).toBe(0);
  });

  it("cleans up the database if migrations fail", async () => {
    const namePrefix = `leak_${randomUUID().replace(/-/g, "").slice(0, 8)}_`;
    const before = await countDatabasesWithPrefix(namePrefix);
    await expect(createTestDatabase({ migrationsFolder: badMigrationsFolder, namePrefix })).rejects.toThrow();
    const after = await countDatabasesWithPrefix(namePrefix);
    expect(after).toBe(before);
  });
});
