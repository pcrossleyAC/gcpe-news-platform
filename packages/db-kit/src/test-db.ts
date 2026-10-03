import { randomUUID } from "node:crypto";
import pg from "pg";
import { sql } from "drizzle-orm";
import { createDb, runMigrations, type Db } from "./db";

export interface TestDatabase {
  pool: pg.Pool;
  db: Db;
  url: string;
  drop(): Promise<void>;
}

export function adminUrl(): string {
  return process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://localhost:5432/postgres";
}

export async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function createTestDatabase(opts: {
  migrationsFolder: string;
  extensions?: string[];
  namePrefix?: string;
}): Promise<TestDatabase> {
  const prefix = opts.namePrefix ?? "test_";
  const name = `${prefix}${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  await withAdmin((c) => c.query(`CREATE DATABASE "${name}"`));
  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  const { pool, db } = createDb(url.toString(), { max: 5 });
  try {
    for (const ext of opts.extensions ?? []) {
      await pool.query(`CREATE EXTENSION IF NOT EXISTS "${ext}"`);
    }
    await runMigrations(db, opts.migrationsFolder);
  } catch (err) {
    await pool.end();
    await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    throw err;
  }
  return {
    pool,
    db,
    url: url.toString(),
    async drop() {
      await pool.end();
      await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    },
  };
}

/**
 * Seeds a worker's `now` test hook from the database's clock (the workers' only clock — see
 * claim.ts), rounded *up* to the next millisecond: a JS Date can't hold Postgres's
 * microseconds, and rounding down could land before a row the database stamped a moment ago,
 * making it look "not due yet".
 */
export async function dbClock(db: Db): Promise<Date> {
  const r = await db.execute<{ ms: number }>(sql`SELECT ceil(extract(epoch from clock_timestamp()) * 1000)::float8 AS ms`);
  return new Date(Number(r.rows[0]!.ms));
}
