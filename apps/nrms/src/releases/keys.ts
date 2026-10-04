import { randomUUID } from "node:crypto";
import { and, eq, ne, sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import type { ReleaseType } from "@gcpe/nrms-contract";
import { newsReleases } from "../db/schema";

/** `base`, else `base-1`, `base-2`, … — unique per type, case-insensitively. Blank → `release-<8 hex>`. */
export async function uniqueKey(tx: DbOrTx, type: ReleaseType, base: string, excludeId: string | null): Promise<string> {
  const stem = base || `release-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  for (let n = 0; ; n++) {
    const candidate = n === 0 ? stem : `${stem}-${n}`;
    const [hit] = await tx
      .select({ id: newsReleases.id })
      .from(newsReleases)
      .where(and(eq(newsReleases.type, type), sql`lower(${newsReleases.key}) = lower(${candidate})`, excludeId ? ne(newsReleases.id, excludeId) : undefined));
    if (!hit) return candidate;
  }
}
