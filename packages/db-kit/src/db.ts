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
  // An idle client losing its connection (server restart, failover, admin kill) emits
  // 'error' on the pool; unhandled, that would crash the process. The pool discards the
  // client and opens a new one on demand, so logging is enough.
  pool.on("error", (err) => console.error("[db] idle client error", err));
  const db: Db = drizzle(pool);
  return { pool, db };
}

/**
 * One read on its own short-lived connection, outside any pool, for a startup or --check probe.
 * Both the connect and the query give up after `timeoutMs`; the connection is always closed.
 */
export async function queryOnce<R extends pg.QueryResultRow>(url: string, text: string, values: unknown[], timeoutMs = 3000): Promise<R[]> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: timeoutMs, query_timeout: timeoutMs });
  // A connection lost after the query would otherwise surface as an unhandled 'error' event.
  client.on("error", () => {});
  await client.connect();
  try {
    return (await client.query<R>(text, values)).rows;
  } finally {
    await client.end().catch(() => {});
  }
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
