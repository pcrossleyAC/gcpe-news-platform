import type { Db } from "@gcpe/db-kit";
import type { SiteBuilder } from "./builder";
import { readCursor, saveCursor } from "./cursor";
import type { PostIndex } from "./post-index";
import { enqueuePages, PRIORITY } from "./queue";
import { rebuildAllItems } from "./rebuild-all";
import { categoryPageId, POST_KEY, type CategoryKind } from "./site-paths";

export type ChangeKind = "post.upserted" | "post.unpublished" | "home" | "slides" | "resource_links" | "ministry" | "sector" | "theme" | "tag";
export interface ChangeRow { id: number; kind: ChangeKind; key: string | null }
export type ChangesPage = { resync: false; changes: ChangeRow[]; next: number } | { resync: true; next: number };
export interface ChangesClient { read(after: number, limit: number): Promise<ChangesPage> }

export const CATEGORY_CHANGE: Record<"ministry" | "sector" | "theme" | "tag", CategoryKind> = { ministry: "ministries", sector: "sectors", theme: "themes", tag: "tags" };

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
        const body = (await res.json()) as { next: number };
        return { resync: true, next: Number(body.next) };
      }
      if (!res.ok) throw new Error(`News API changes ${res.status}`);
      const body = (await res.json()) as { changes: ChangeRow[]; next: number };
      return { resync: false, changes: body.changes, next: Number(body.next) };
    },
  };
}

/** spec §6.2's table, for one change. A category change's release pages are added by syncChanges. */
export function pagesForChange(c: ChangeRow, postPriority: number): { pageId: string; priority: number }[] {
  const live = PRIORITY.liveAggregate;
  switch (c.kind) {
    case "post.upserted":
    case "post.unpublished":
      return c.key && POST_KEY.test(c.key) ? [{ pageId: `post:${c.key}`, priority: postPriority }] : [];
    case "home":
    case "slides":
    case "resource_links":
      return [{ pageId: "home", priority: live }];
    default: {
      const kind = CATEGORY_CHANGE[c.kind];
      const id = c.key ? categoryPageId(kind, c.key) : null;
      if (!id) return [];
      return [{ pageId: id, priority: live }, ...(kind === "ministries" ? [{ pageId: "ministries", priority: live }, { pageId: "search", priority: live }] : []), { pageId: "sitemap:pages", priority: live }];
    }
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
    for (const c of page.changes) {
      const isPost = c.kind === "post.upserted" || c.kind === "post.unpublished";
      const priority = isPost && livePosts > 0 ? (livePosts--, PRIORITY.livePost) : PRIORITY.bulkPost;
      changeItems.push(...pagesForChange(c, priority));
      if (!isPost && c.key && c.kind in CATEGORY_CHANGE) {
        const kind = CATEGORY_CHANGE[c.kind as keyof typeof CATEGORY_CHANGE];
        const id = categoryPageId(kind, c.key);
        if (id) for (const key of await deps.index.inCategory(id.slice("category:".length))) changeItems.push({ pageId: `post:${key}`, priority: PRIORITY.bulkPost });
      }
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
