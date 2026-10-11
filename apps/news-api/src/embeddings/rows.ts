import { sql } from "drizzle-orm";
import type { Tx } from "@gcpe/db-kit";

/**
 * Deletes the embeddings and related-posts rows of `keys` (stored keys) in the caller's
 * transaction: the unpublish that calls this commits with it (spec §5.2). One JSON parameter,
 * however many keys: the legacy importer can unpublish tens of thousands at once.
 */
export async function deleteSemanticRows(tx: Tx, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const json = JSON.stringify(keys);
  await tx.execute(sql`DELETE FROM post_embeddings WHERE post_key IN (SELECT value FROM jsonb_array_elements_text(${json}::jsonb))`);
  await tx.execute(sql`DELETE FROM post_related WHERE post_key IN (SELECT value FROM jsonb_array_elements_text(${json}::jsonb))`);
}
