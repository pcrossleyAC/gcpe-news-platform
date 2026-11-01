import { sql } from "drizzle-orm";
import type { Db, Tx } from "./db";

/**
 * Suite review fix round 2, I2: runs `run` in a transaction whose statements the server cancels
 * after `ms` (SET LOCAL, so the connection goes back to the pool without a limit). For checks that
 * must answer quickly, such as `/stack/health`'s, whatever the tables' size.
 */
export async function withStatementTimeout<T>(db: Db, ms: number, run: (tx: Tx) => Promise<T>): Promise<T> {
  const limit = Math.max(1, Math.trunc(ms));
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${limit}`));
    return run(tx);
  });
}

/** Postgres cancelled the statement for running past its statement_timeout (SQLSTATE 57014), however wrapped. */
export function isStatementTimeout(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; cur && depth < 5; depth++) {
    if (typeof cur === "object" && (cur as { code?: unknown }).code === "57014") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
