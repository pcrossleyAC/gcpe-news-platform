import { randomUUID } from "node:crypto";
import { and, ne, sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import { newsReleases } from "../db/schema";

/**
 * `base`, else `base-1`, `base-2`, … — unique across all types, case-insensitively (the News API
 * addresses posts by key alone). Blank → `release-<8 hex>`.
 */
export async function uniqueKey(tx: DbOrTx, base: string, excludeId: string | null): Promise<string> {
  const stem = base || `release-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  for (let n = 0; ; n++) {
    const candidate = n === 0 ? stem : `${stem}-${n}`;
    const [hit] = await tx
      .select({ id: newsReleases.id })
      .from(newsReleases)
      .where(and(sql`lower(${newsReleases.key}) = lower(${candidate})`, excludeId ? ne(newsReleases.id, excludeId) : undefined));
    if (!hit) return candidate;
  }
}
