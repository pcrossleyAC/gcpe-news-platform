import type { Db } from "@gcpe/db-kit";
import type { SiteBuilder } from "./builder";
import { enqueuePages, PRIORITY } from "./queue";
import { LISTING_KINDS } from "./site-paths";
import type { SectionPages } from "./rebuild";

/** Rendered on the same run as the trigger, so a layout or Blue Bridge change shows on home at once. */
const FIRST = ["static", "home", "ministries", "archive", "search", "sitemap"];

/** The settings sections a release page bakes in (pages/release.ts). */
const RELEASE_SECTIONS: ReadonlySet<SectionPages> = new Set(["releaseShare", "ministryPages", "releaseLicence"]);

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

/** Queues what `chromeChanges` (rebuild.ts) found: every page, or only the pages the changed
 * settings sections reach. */
export async function enqueueChromeChanges(db: Db, builder: SiteBuilder, changes: { all: boolean; sections: SectionPages[] }): Promise<void> {
  if (changes.all) {
    await enqueueRebuildAll(db, builder);
    return;
  }
  const items: { pageId: string; priority: number }[] = [];
  for (const section of changes.sections) {
    // Home's Connect With Us icons come from the connect settings too; "contacts" is its own page id.
    // A labels edit reaches the aggregate pages (home, listings, ministry pages), never a post.
    const ids = section === "labels" ? await builder.aggregatePageIds() : section === "ministryPages" ? await builder.ministryPageIds() : section === "connect" ? ["connect", "home", ...LISTING_KINDS.map((k) => `kind:${k}`)] : section === "releaseShare" || section === "releaseLicence" ? [] : [section];
    items.push(...ids.map((pageId) => ({ pageId, priority: section === "labels" ? PRIORITY.bulkAggregate : PRIORITY.liveAggregate })));
  }
  // Every release page bakes in the ministryPages labels (Media Contacts, More from this
  // Ministry, the side column's headings) and the connect section's Share → Instagram account
  // (releaseShare), so either change re-renders every post, at rebuild-all's bulk priority (settings
  // changes are rare; the queue drains them in batches behind live work).
  if (changes.sections.some((s) => RELEASE_SECTIONS.has(s))) items.push(...(await builder.allPostKeys()).map((k) => ({ pageId: `post:${k}`, priority: PRIORITY.bulkPost })));
  if (items.length) await enqueuePages(db, items);
}
