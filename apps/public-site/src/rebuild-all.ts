import type { Db } from "@gcpe/db-kit";
import type { SiteBuilder } from "./builder";
import { enqueuePages, PRIORITY } from "./queue";

/** Rendered on the same run as the trigger, so a layout or Blue Bridge change shows on home at once. */
const FIRST = ["static", "home", "ministries", "archive", "search", "sitemap"];

/** spec §6.2 "templates change": every page. Network reads only; the caller enqueues. */
export async function rebuildAllItems(builder: SiteBuilder): Promise<{ pageId: string; priority: number }[]> {
  const keys = await builder.allPostKeys();
  const aggregates = await builder.aggregatePageIds();
  return [
    ...FIRST.map((pageId) => ({ pageId, priority: PRIORITY.liveAggregate })),
    ...keys.map((k) => ({ pageId: `post:${k}`, priority: PRIORITY.bulkPost })),
    ...aggregates.map((pageId) => ({ pageId, priority: PRIORITY.bulkAggregate })),
  ];
}

export async function enqueueRebuildAll(db: Db, builder: SiteBuilder): Promise<{ pages: number }> {
  const items = await rebuildAllItems(builder);
  await enqueuePages(db, items);
  return { pages: items.length };
}
