import { z } from "zod";
import type { Db } from "@gcpe/db-kit";
import type { SiteBuilder } from "./builder";
import { readCursor, saveCursor } from "./cursor";
import type { PostIndex } from "./post-index";
import { enqueuePages, PRIORITY } from "./queue";
import { rebuildAllItems } from "./rebuild-all";
import { categoryPageId, CATEGORY_INDEX_IDS, LISTING_KINDS, POST_KEY, type CategoryKind } from "./site-paths";

export type ChangeKind = "post.upserted" | "post.unpublished" | "home" | "slides" | "resource_links" | "ministry" | "sector" | "theme" | "tag" | "site_settings" | "government_terms";
export interface ChangeRow { id: number; kind: ChangeKind; key: string | null }
export type ChangesPage = { resync: false; changes: ChangeRow[]; next: number } | { resync: true; next: number };
export interface ChangesClient { read(after: number, limit: number): Promise<ChangesPage> }

/** Every per-kind listing page (they show the home top post and the Resources box). */
const kindPages = (priority: number) => LISTING_KINDS.map((k) => ({ pageId: `kind:${k}`, priority }));

/** The four category indexes at bulk priority: each render fetches every category's latest posts. */
const indexPages = () => CATEGORY_INDEX_IDS.map((pageId) => ({ pageId, priority: PRIORITY.bulkAggregate }));

export const CATEGORY_CHANGE: Record<"ministry" | "sector" | "theme" | "tag", CategoryKind> = { ministry: "ministries", sector: "sectors", theme: "themes", tag: "tags" };

/**
 * A named error carrying only the HTTP status — never the URL, token or body. `safeErrorLabel`
 * (`@gcpe/http-kit`) logs `.code` if present, else `.name`; this has no `.code`, so giving it a
 * status-bearing `.name` is what makes a 401/403 (misconfigured credentials, needs a human)
 * read differently in the log from a 503 (a transient outage, self-heals next tick) at the one
 * place a feed failure is logged (`sync.ts`) — a plain `Error` would log as the bare word
 * "Error" either way.
 */
export class ChangeFeedError extends Error {
  constructor(status: number) {
    super(`News API changes ${status}`);
    this.name = `ChangeFeedError ${status}`;
  }
}

/**
 * The wire shape this client trusts. Deliberately doesn't restrict `kind` to the known
 * `ChangeKind` union: a kind this build doesn't recognise is a forward-compatibility signal
 * (`pagesForChange` below ignores it safely), not a malformed response. Anything that fails
 * this — a missing field, the wrong type — *is* a malformed response, and is thrown the same
 * way a network failure is, so the caller's cursor never advances past it.
 */
const changeRowSchema = z.object({ id: z.number(), kind: z.string(), key: z.string().nullable() });
const changesBodySchema = z.object({ changes: z.array(changeRowSchema), next: z.number() });
const resyncBodySchema = z.object({ next: z.number() });

/** `GET /api/v2/changes` with the site builder's own service token (spec §5.4). */
export function changesClient(opts: { baseUrl: string; getToken: () => Promise<string>; fetchImpl?: typeof fetch }): ChangesClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.endsWith("/") ? opts.baseUrl : `${opts.baseUrl}/`;
  return {
    async read(after, limit) {
      const res = await doFetch(new URL(`api/v2/changes?after=${after}&limit=${limit}`, base), {
        headers: { authorization: `Bearer ${await opts.getToken()}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 410) {
        const body = resyncBodySchema.parse(await res.json());
        return { resync: true, next: body.next };
      }
      if (!res.ok) throw new ChangeFeedError(res.status);
      const body = changesBodySchema.parse(await res.json());
      return { resync: false, changes: body.changes as ChangeRow[], next: body.next };
    },
  };
}

/**
 * spec §6.2's table, for one change. A category change's release pages are added by
 * `syncChanges`. A `kind` outside the known union — a News API change kind this build predates
 * — falls to `default` and is ignored (`[]`) rather than guessed at: no `category:undefined:…`
 * page, no stray `sitemap:pages` rebuild.
 */
export function pagesForChange(c: ChangeRow, postPriority: number): { pageId: string; priority: number }[] {
  const live = PRIORITY.liveAggregate;
  switch (c.kind) {
    case "post.upserted":
    case "post.unpublished":
      return c.key && POST_KEY.test(c.key) ? [{ pageId: `post:${c.key}`, priority: postPriority }] : [];
    // A home settings change may switch the webcast on or off: /live/ reads the same settings.
    case "home":
      return [{ pageId: "home", priority: live }, { pageId: "live", priority: live }, ...kindPages(live)];
    case "slides":
      return [{ pageId: "home", priority: live }];
    // /connect/ has the same Resources box as home.
    case "resource_links":
      return [{ pageId: "home", priority: live }, { pageId: "connect", priority: live }, ...kindPages(live), ...indexPages()];
    case "ministry":
    case "sector":
    case "theme":
    case "tag": {
      const kind = CATEGORY_CHANGE[c.kind];
      const id = c.key ? categoryPageId(kind, c.key) : null;
      if (!id) return [];
      // A ministry change can start (a hand-over) or stop (a reactivation) a successor redirect.
      // The table goes one priority lower than the category pages, so a hand-over to a brand-new
      // ministry has that ministry's page on disk before anything 301s to it.
      // /contacts/ lists every ministry's name, minister and media contacts.
      // /connect/'s RSS Feeds list names every active ministry, sector and tag.
      const ministryPages = kind === "ministries" ? ["search", "contacts", "connect"] : [];
      const redirects = kind === "ministries" ? [{ pageId: "legacy-redirects", priority: PRIORITY.bulkPost }] : [];
      return [
        { pageId: id, priority: live },
        ...ministryPages.map((pageId) => ({ pageId, priority: live })),
        ...redirects,
        // Home's News by Sector box names each active sector.
        ...(kind === "sectors" ? [{ pageId: "home", priority: live }] : []),
        ...(kind === "sectors" || kind === "tags" ? [{ pageId: "connect", priority: live }] : []),
        // /search/'s Sector filter lists every active sector.
        ...(kind === "sectors" ? [{ pageId: "search", priority: live }] : []),
        // The kind's index lists this category (a ministry's is `ministries`); bulk, like every index
        // render, so a rename never puts one ahead of the pages being watched. The category's own
        // pages above stay live.
        { pageId: kind === "ministries" ? "ministries" : `index:${kind}`, priority: PRIORITY.bulkAggregate },
        { pageId: "sitemap:pages", priority: live },
      ];
    }
    // Queues nothing itself: every sync turn fetches the settings and queues what each changed
    // section needs (sync.ts), so the change only has to wake the site up.
    case "site_settings":
      return [];
    // A term started, or a term's dates, label or legacy link changed (new-government spec §3).
    // Every term page is added by `syncChanges`, from the builder's terms.
    case "government_terms":
      // /search/'s Date filter lists every public term.
      return [{ pageId: "archive-terms", priority: live }, { pageId: "archive-term:current", priority: live }, { pageId: "sitemap:pages", priority: live }, { pageId: "search", priority: live }];
    default:
      return [];
  }
}

/**
 * Reads the change feed from the stored cursor into the queue (spec §6.2): events become a
 * doorbell, this is the job that actually catches up. Each page of changes and the cursor
 * move commit in one transaction, so the cursor only ever advances past pages whose pages are
 * already queued.
 *
 * No cursor yet (first run): read to the head first, without enqueueing anything for the
 * changes themselves, then queue a full rebuild and save the head as the cursor — a change
 * committed on the News API in between is read again next time, since the cursor only moves to
 * the head as it stood when this run started reading.
 *
 * A 410 (the cursor is behind the feed's pruning watermark) queues a full rebuild and moves the
 * cursor straight to `next`, in the same loop — including on the very first read, if the feed
 * has already been pruned past id 0.
 *
 * Only the first `livePostLimit` post changes in one run render at live priority; the rest (and
 * every category change's release pages) are bulk, so a backlog never starves a page actually
 * being watched in a browser.
 */
export async function syncChanges(
  deps: { db: Db; client: ChangesClient; builder: SiteBuilder; index: PostIndex },
  opts: { pageLimit?: number; maxPages?: number; livePostLimit?: number } = {},
): Promise<{ changes: number; resynced: boolean }> {
  const pageLimit = opts.pageLimit ?? 500;
  const maxPages = opts.maxPages ?? 20;
  let livePosts = opts.livePostLimit ?? 100;
  let cursor = await readCursor(deps.db);
  let applied = 0;
  let resynced = false;

  const fullRebuild = async (next: number) => {
    const rebuildItems = await rebuildAllItems(deps.builder);
    await deps.db.transaction(async (tx) => {
      await enqueuePages(tx, rebuildItems);
      await saveCursor(tx, next);
    });
    resynced = true;
    cursor = next;
  };

  if (cursor === null) {
    let head = 0;
    for (;;) {
      const page = await deps.client.read(head, pageLimit);
      if (page.resync) {
        head = page.next;
        continue;
      }
      if (page.changes.length === 0) break;
      head = page.next;
    }
    await fullRebuild(head);
  }

  for (let i = 0; i < maxPages; i++) {
    const page = await deps.client.read(cursor!, pageLimit);
    if (page.resync) {
      await fullRebuild(page.next);
      continue;
    }
    if (page.changes.length === 0) break;
    const changeItems: { pageId: string; priority: number }[] = [];
    // Every sector, theme and tag page id: fetched once per page of changes, and only if one of
    // them is a resource_links change.
    let listingQueued = false;
    for (const c of page.changes) {
      const isPost = c.kind === "post.upserted" || c.kind === "post.unpublished";
      const priority = isPost && livePosts > 0 ? (livePosts--, PRIORITY.livePost) : PRIORITY.bulkPost;
      changeItems.push(...pagesForChange(c, priority));
      if (!isPost && c.key && Object.hasOwn(CATEGORY_CHANGE, c.kind)) {
        const kind = CATEGORY_CHANGE[c.kind as keyof typeof CATEGORY_CHANGE];
        const id = categoryPageId(kind, c.key);
        if (id) for (const key of await deps.index.inCategory(id.slice("category:".length))) changeItems.push({ pageId: `post:${key}`, priority: PRIORITY.bulkPost });
        // A release page bakes in its lead ministry (name, active state, website, Flickr, YouTube,
        // topic and service links, successor link), and a lead is not always one of the post's
        // ministries (90 of 34,895 legacy releases), so those pages are found by the indexed
        // lead_ministry column too. enqueuePages de-duplicates the overlap.
        if (id && c.kind === "ministry") for (const key of await deps.index.withLeadMinistry(c.key)) changeItems.push({ pageId: `post:${key}`, priority: PRIORITY.bulkPost });
      }
      // Every sector, theme and tag page shows the Resources box: bulk, behind home and /connect/.
      if (c.kind === "resource_links" && !listingQueued) {
        listingQueued = true;
        for (const pageId of await deps.builder.categoryListingPageIds()) changeItems.push({ pageId, priority: PRIORITY.bulkAggregate });
      }
      // Rare (an election, a corrected date or label): every term page, at live priority, so the
      // old current term closes and the new one appears together.
      if (c.kind === "government_terms") for (const pageId of await deps.builder.termPageIds()) changeItems.push({ pageId, priority: PRIORITY.liveAggregate });
    }
    await deps.db.transaction(async (tx) => {
      await enqueuePages(tx, changeItems);
      await saveCursor(tx, page.next);
    });
    applied += page.changes.length;
    cursor = page.next;
  }
  return { changes: applied, resynced };
}
