import { sql, type SQL } from "drizzle-orm";

/** Spec: a subscription matches an item when its list key is one of the item's keys, or it is
 * "all news" (`*`) and the item carries a ministry key (legacy DistributionProvider.cs:296). */
export function matchesItem(listKeyCol: SQL, itemListKeys: SQL): SQL {
  return sql`(${listKeyCol} = ANY(${itemListKeys}) OR (${listKeyCol} = '*' AND EXISTS (SELECT 1 FROM unnest(${itemListKeys}) AS k WHERE k LIKE 'ministries:%')))`;
}
