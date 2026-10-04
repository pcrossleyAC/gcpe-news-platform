import { sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";

export function bcYear(at: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric" }).format(at));
}

export const pad = (n: number, width: number) => String(n).padStart(width, "0");

/** Atomic increment-and-read; the upsert takes the row lock, so concurrent approvals serialise here. */
export async function nextCounter(tx: DbOrTx, scope: "news" | "year" | "ministry", year: number, ministry: string): Promise<number> {
  const r = await tx.execute<{ last_value: number }>(sql`
    INSERT INTO number_counters (scope, year, ministry, last_value) VALUES (${scope}, ${year}, ${ministry}, 1)
    ON CONFLICT (scope, year, ministry) DO UPDATE SET last_value = number_counters.last_value + 1
    RETURNING last_value`);
  return Number(r.rows[0]!.last_value);
}
