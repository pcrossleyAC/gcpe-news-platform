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

// Two-int advisory keys live in a different lock space from the single-bigint keys used
// for per-aggregate locks, so this can never collide with hashtext(aggregateId).
const MIGRATION_LOCK = [0x67637065 /* "gcpe" */, 1] as const;

/**
 * Applies pending migrations while holding a session-level advisory lock on a dedicated
 * connection, so replicas booting at the same time migrate one after another instead of
 * racing on the same DDL. Later lock holders find nothing left to apply.
 */
export async function runMigrations(db: Db, migrationsFolder: string): Promise<void> {
  const client = (db as Db & { $client: pg.Pool | pg.Client }).$client;
  const conn = client instanceof pg.Pool ? await client.connect() : client;
  let broken = false;
  try {
    await conn.query("SELECT pg_advisory_lock($1, $2)", [...MIGRATION_LOCK]);
    try {
      await migrate(drizzle(conn), { migrationsFolder });
    } finally {
      await conn.query("SELECT pg_advisory_unlock($1, $2)", [...MIGRATION_LOCK]).catch(() => {
        broken = true; // closing the connection releases the lock
      });
    }
  } finally {
    if ("release" in conn && typeof conn.release === "function") conn.release(broken);
  }
}
