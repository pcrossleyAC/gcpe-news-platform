import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

/**
 * A node-postgres drizzle instance. The schema parameter defaults to `any` so that both
 * schemaless instances (`createDb`) and apps' schema-typed ones (`drizzle(pool, { schema })`)
 * can be passed to shared helpers such as the events outbox, dispatcher and receiver.
 */
export type Db<TSchema extends Record<string, unknown> = any> = NodePgDatabase<TSchema>;
export type Tx<TSchema extends Record<string, unknown> = any> = Parameters<Parameters<Db<TSchema>["transaction"]>[0]>[0];
export type DbOrTx<TSchema extends Record<string, unknown> = any> = Db<TSchema> | Tx<TSchema>;

export function createDb(url: string, opts: { max?: number } = {}): { pool: pg.Pool; db: Db } {
  const pool = new pg.Pool({ connectionString: url, max: opts.max ?? 10 });
  const db: Db = drizzle(pool);
  return { pool, db };
}

export async function runMigrations(db: Db, migrationsFolder: string): Promise<void> {
  await migrate(db, { migrationsFolder });
}
