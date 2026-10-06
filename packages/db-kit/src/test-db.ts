import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { sql } from "drizzle-orm";
import { createDb, runMigrations, type Db } from "./db";

export interface TestDatabase {
  pool: pg.Pool;
  db: Db;
  url: string;
  drop(): Promise<void>;
  /**
   * Applies any migration in the full `migrationsFolder` (passed to {@link createTestDatabase},
   * not just the `upTo` subset the database may have been created with) not yet applied —
   * same tracking drizzle-orm's own migrator uses, so this is safe to call whether or not
   * `upTo` was given.
   */
  migrate(): Promise<void>;
}

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

/**
 * A migrations-folder copy holding only the journal entries up to and including `tag`, plus
 * each entry's own `<tag>.sql` — the only two things drizzle-orm's runtime migrator reads
 * (`readMigrationFiles` in drizzle-orm/migrator.js). Deliberately skips the `*_snapshot.json`
 * files drizzle-kit itself generates and reads back when diffing for the *next* migration;
 * the runtime migrator never opens them, so a test applying this folder doesn't need them.
 * Lets a test apply an older schema, insert legacy-shaped rows, then call the returned
 * database's `migrate()` to run the rest of the real folder against them.
 */
function truncatedMigrationsFolder(migrationsFolder: string, tag: string): string {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8")) as {
    version: string;
    dialect: string;
    entries: JournalEntry[];
  };
  const cutIdx = journal.entries.findIndex((e) => e.tag === tag);
  if (cutIdx === -1) throw new Error(`createTestDatabase: no migration tagged "${tag}" in ${migrationsFolder}`);
  const entries = journal.entries.slice(0, cutIdx + 1);

  const dir = mkdtempSync(join(tmpdir(), "db-kit-migrations-"));
  try {
    mkdirSync(join(dir, "meta"), { recursive: true });
    writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
    for (const entry of entries) {
      copyFileSync(join(migrationsFolder, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
    }
    return dir;
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
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
  /**
   * Apply only the migrations up to and including this journal tag (e.g. `"0003_freeze_chunks"`)
   * instead of the whole folder, so a test can insert rows shaped like an earlier schema before
   * applying the rest itself. Call `migrate()` on the returned database to apply the remainder
   * of `migrationsFolder`.
   */
  upTo?: string;
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
    if (opts.upTo) {
      const truncated = truncatedMigrationsFolder(opts.migrationsFolder, opts.upTo);
      try {
        await runMigrations(db, truncated);
      } finally {
        rmSync(truncated, { recursive: true, force: true });
      }
    } else {
      await runMigrations(db, opts.migrationsFolder);
    }
  } catch (err) {
    await pool.end();
    await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    throw err;
  }
  return {
    pool,
    db,
    url: url.toString(),
    async migrate() {
      await runMigrations(db, opts.migrationsFolder);
    },
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
