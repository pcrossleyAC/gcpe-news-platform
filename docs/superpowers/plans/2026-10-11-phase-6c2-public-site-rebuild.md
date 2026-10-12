# Phase 6c-2: The Public Site — Rebuild Queue, Change-Feed Consumer, Search Page and Carousel Image URLs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the public site's rebuilds durable and incremental: a `rebuild_queue` in the site's database drained a batch per tick, a consumer of the News API's `GET /api/v2/changes` feed with a stored cursor (a `410` queues a full rebuild), `site:rebuild-all`, the static search page over `/api/v2/search`, and carousel images that travel as URLs instead of base64 bytes (C42 retired).

**Architecture:**
- **One queue, four priorities.** `rebuild_queue (page_id PK, priority, seq bigserial, queued_at, attempts)`. A live post change is priority 0, its dependents and live aggregate changes 1, bulk post pages (rebuild-all, a category rename's release pages, a feed backlog) 2, their dependents 3. Enqueueing keeps the lower priority and takes a fresh `seq`. The drain takes the lowest `(priority, seq)` first and deletes a row only if its `seq` is unchanged, so a page re-queued while it was being rendered renders again. A failing page goes to the back of its priority with `attempts + 1`; it never blocks the others.
- **The change feed is the source of truth; events are a doorbell.** `syncSite` (one serialised turn per process) checks the chrome marker, reads `/api/v2/changes` from the stored cursor (enqueueing each change's pages and saving the cursor in the same transaction), then drains up to `SITE_REBUILD_BATCH` pages. It runs on the stack's `site.sync` tick step, on a standalone loop, and on every `site.rebuild_requested` event (which first enqueues the event's own pages at live priority, so a publish jumps any backlog). A first run, or a `410`, fast-forwards the cursor and queues a full rebuild.
- **Authentication to the feed** uses `@gcpe/auth`'s `serviceTokenProvider` with the service role `NewsApi.ChangesRead`: Entra client credentials (`NEWS_API_TOKEN_URL`, `…_CLIENT_ID`, `…_CLIENT_SECRET`, `…_SCOPE`) in standalone OpenShift, and a locally minted token from the shared `LOCAL_AUTH_SECRET` on the stack, where the News API already accepts local tokens. With neither, the public site refuses to start.
- **Carousel images are content-addressed files.** NRMS writes each slide or pin image to its public file store as `slides/<sha256>.<png|jpg>` when it's uploaded (and backfills existing images at start), and slide events carry `imageUrl`, `imageKey` and `imageSha256` with `imageBase64: null`. The News API fetches the bytes once when it projects the event (verifying the hash) so v1 `/api/Slides` stays byte-for-byte the same for BC's webapp, and a new `GET /api/v2/slides` gives the public site the URLs and which slides are pinned emergency slides.

**Tech Stack:** Node 24, TypeScript 5.9, Express 5, Drizzle 0.45 / drizzle-kit 0.31 on Postgres 14, zod 3.25, Vitest 4.1, jsdom 30.1.2, Playwright 1.63.

**Spec:** `docs/superpowers/specs/2026-10-11-public-site-ai-design.md`:
- §6.1's search page;
- §6.2 (the queue, the cursor, the change-feed consumer, `site:rebuild-all`, 100/200 per tick, the startup self-heal);
- §6.4 (carousel images as URLs; `SLIDES_EVENT_BUDGET_BYTES` retired);
- §8's "the change feed: `410 resync` triggers a full rebuild through the queue" and the `site:rebuild-all` runbook line;
- §9's 6c lines not done in 6c-1: "the search page returns results" (E2E).

**Builds on:** `docs/superpowers/plans/2026-10-11-phase-6c1-public-site-pages.md` (run first). Its names used here: `SiteBuilder` (`renderPage`, `rebuild`, `buildAll`, `allPostKeys`, `aggregatePageIds`), `RunCache`, `createSiteBuilder`, `PostIndex` (`inCategory`), `parsePageId`, `formatPageId`, `pageFiles`, `categoryPageId`, `POST_KEY`, `chromeChanged`, `writeSiteState`, `stateAndBanner`, `tryHome`, `enqueueSiteWrite`, `memoryStorage`, `expectAccessibleStructure`, the fake News API in `apps/public-site/test/fake-news-api.ts`, and the `## Phase 6c — The public site` running-notes and `## The public site (Phase 6c)` runbook headings.

**Not in 6c-2:** axe-core, Lighthouse and the search spot-check (6e); the staff "Similar releases" panel (6d); CORS on `/api/v2/search` (Q81).

---

## Decisions made in planning

Each ruling was made against the code at `ef532f5` plus 6c-1's interfaces. Spec conflicts are marked. The queue SQL was dry-run on local Postgres 14.17 in scratch databases, dropped afterwards.

1. **Where the queue and cursor live:** the public site's own Postgres database (`SITE_DATABASE_URL`), which already exists for its event inbox, as §6.2 says. Not `DATA_DIR` files: the queue needs atomic "enqueue these pages and move the cursor" and a guarded delete, which files can't give safely across SiteGround's idle restarts.
2. **Spec conflict, §6.2 "100 per tick" (category release pages) and "200 per tick" (rebuild-all).** One drain budget, `SITE_REBUILD_BATCH` (default 200 pages per run), shared by everything, ordered by priority. Category-triggered release pages and rebuild-all pages are both bulk (priority 2), so a publish (priority 0) and its list pages (1) always go first, and the bulk work is paced by the same budget.
3. **Dry-run results (verified):**
   - An `INSERT … ON CONFLICT DO UPDATE` whose input repeats a `page_id` fails ("ON CONFLICT DO UPDATE command cannot affect row a second time"). `enqueuePages` collapses its input with `DISTINCT ON (page_id)`, keeping the lowest priority.
   - `ROWS FROM (jsonb_to_recordset($1) AS (page_id text, priority smallint)) WITH ORDINALITY` with an outer `ORDER BY ord` assigns `seq` in input order: rebuild-all's keys (newest first from v1 `Posts/Keys`) drain newest first. 100,000 page ids in one statement took 1.45 s.
   - The guarded delete (`WHERE page_id = $1 AND seq = $2`) leaves a row whose `seq` changed during the render.
   - A plain timestamp guard was rejected: two `clock_timestamp()` reads can be equal (also verified), a sequence can't.
4. **Events stay, as a doorbell.** News API still sends `site.rebuild_requested` with `["home", "post:<key>"]`. The handler enqueues those pages at live priority and runs `syncSite`. The feed then adds the same pages again, which the queue collapses. Without the event, a fresh publish would wait behind a backlog (a legacy re-import writes about 100,000 `post.upserted` changes, Q78); with it, the publish renders first.
5. **A feed backlog is bulk.** In one `syncSite` run, the first 100 post changes read from the feed are live (priority 0); the rest are bulk (2). A re-import therefore can't starve live work; Q78's "collapses repeats of a key" is the queue's primary key.
6. **First run and `410`.** With no stored cursor (the first start after this deploy), `syncSite` reads the feed to its head without enqueueing, then queues a full rebuild and saves the head in one transaction. Reading first and enumerating second means a change committed in between is read by the next sync, never lost. A `410 { resync: true, next }` queues a full rebuild and moves the cursor to `next` in one transaction.
7. **Spec conflict, §6.2 "Templates change (a deploy) → `site:rebuild-all`".** The chrome marker (`RENDER_CHROME_VERSION`, Blue Bridge, test flag, base URL) already detects a layout change at start; it now queues a full rebuild instead of running one. `site:rebuild-all` is the manual trigger (a CLI). A Blue Bridge switch queues one too: home renders on the same run (it's queued at priority 1), older release pages follow at 200 per tick, newest first. At 100,000 posts and one tick a minute that's about eight hours; recorded as C207 and Q84.
8. **Feed credentials are required.** `serviceTokenProvider` throws at startup without Entra client credentials or `LOCAL_ADMIN_ENABLED=true`. On the stack (boxs.ca, CI, E2E) `LOCAL_ADMIN_ENABLED=true` is shared with every app and the News API's `changesBearerFromEnv` already accepts local tokens with the `NewsApi.ChangesRead` role (6b). Standalone OpenShift needs an Entra app registration for the site builder with that app role, and `NEWSAPI_AUTH_AUDIENCE` on the News API; there are no OpenShift manifests in the repo yet, so the runbook records it. The local branch is derived from a view of the environment without `ENTRA_TENANT_ID`/`AUTH_AUDIENCE`, so the stack's shared tenant id (without a site audience) can't make `authFromEnv` refuse to start.
9. **A feed failure doesn't stop the drain.** `syncSite` logs a feed error (`safeErrorLabel`, never the token) and still drains what's queued; the cursor doesn't move, so nothing is skipped. A `home()` failure still fails the turn (the chrome can't be decided), and the event is retried.
10. **Spec conflict, §6.4 vs "News API v1 must not change".** v1 `/api/Slides` returns each slide's image as base64, and BC's `gcpe-news-webapp` reads v1 at cutover (D1). Ruling: slide events carry URLs (§6.4), and the News API fetches the bytes once while projecting the event, checks their SHA-256 against the event, and stores them, so v1 is unchanged. A fetch failure or hash mismatch fails the projection, and NRMS's outbox retries the event. Old envelopes and the legacy importer still carry base64 and keep working.
11. **Where NRMS serves slide images:** its existing public file store (`/files/…`, `PUBLIC_FILES_BASE`), under content-addressed keys `slides/<sha256>.<ext>`. No new public route on NRMS. Like release files (C38, Q17), a next-carousel image is reachable before it goes live, but only by its 256-bit hash. Files are never deleted (they're small and content-addressed; a later clean-up can list unreferenced ones).
12. **How the News API reaches the file on the stack:** SiteGround blocks loopback networking, so `https://boxs.ca/files/…` can't be fetched from inside the stack. `NEWSAPI_SLIDE_IMAGES_FETCH_BASE` (stack default `self:/files`, resolved in-process like `NOD_BASE_URL`) is joined with `imageKey`; without it the News API fetches `imageUrl` as given (standalone; assumed reachable from the News API's pod — Q85).
13. **The emergency banner** (§6.1's home row) is the pinned emergency slides (NRMS's two pins, `sortIndex` −2 and −1). v1's slide DTO has no `sortIndex`, so `GET /api/v2/slides` returns `emergency: true` for them; the home page shows them first in a labelled "Emergency information" region. The Blue Bridge banner stays as it is.
14. **The search page** is static: a labelled form (query and a ministry filter), a script that calls `/api/v2/search` and builds results with `textContent` only, two live regions (status and alert, as the subscribe pages do), pagination, and a `<noscript>` message with archive links. The API base is `SEARCH_API_URL` (default: the page's own origin, as on the stack; Q81). It's page id `search`, rebuilt when a ministry changes.

## Global Constraints

Carried over verbatim from Phase 6b:

- **Worktree and commits:**
  - Work on `feat/phase-6` in `/Users/paul/gcpe-news-platform-p6`. Commit locally after each task, with a plain message. Don't push until the branch is reviewed.
  - **Never add `Co-Authored-By` or any AI attribution** to a commit. Never commit `CLAUDE.md`.
  - **No task, decision or round labels in code comments** ("Task 3", "ruling 5", "fix round 1"). Spec row ids (C201, Q70) and spec section numbers are fine.
- **Node 24 for everything:**
  - Tests: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run <paths>`.
  - Type-checks: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`.
  - Packages: `npx -y -p node@24 -- npm install --ignore-scripts`. The worktree has no `node_modules` yet, so run `npx -y -p node@24 -- npm ci --ignore-scripts` first.
  - Tests need the local Postgres (`TEST_DATABASE_ADMIN_URL`, default `postgres://localhost:5432/postgres`).
- **Every behaviour change starts with a real RED run:** run the new test, see it fail for the stated reason, then implement.
- **No debug logging.** Logs carry `safeErrorLabel` plus the route, command or provider id only. Never a search term, a query string, a headline or an embedding input.
- **Migrations only through drizzle-kit,** from the app folder: `cd apps/news-api && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name <name>`. Never hand-edit generated DDL. The generated column is drizzle-kit's own output (verified while planning).
- **News API v1 behaviour and responses must not change.** These suites stay green, unedited:
  - `apps/news-api/test/compat.test.ts` ("News API v1 compatibility with recorded live responses");
  - `apps/news-api/test/e2e-core.test.ts`;
  - `apps/news-api/src/http/v1/*.test.ts`;
  - `apps/news-api/src/app.test.ts`.
- **Privacy:** `example.test` addresses and fictional names only. No legacy data enters the repo.
- **Parity lists:**
  - `docs/parity/changes-from-legacy.md` gets C201–C204 exactly as spec §11 (the highest today is C200).
  - `docs/parity/open-questions.md` gets Q70–Q73 exactly as spec §12 (the highest today is Q69).
  - Check that no number is duplicated: `grep -oE "^\| C2[0-9]{2}" docs/parity/changes-from-legacy.md | sort | uniq -d` and `grep -oE "^\| Q[0-9]+" docs/parity/open-questions.md | sort | uniq -d` both print nothing.
- **Running notes:** each task adds role-tagged lines to `docs/manuals/running-notes.md` under `## Phase 6a — Search foundations`. The tags are the legend's: Editor, Site editor, Viewer, Administrator, Operations, Developer.
- **Runbook:** `docs/deploy/siteground.md` gets a `## Search and embeddings (Phase 6a)` section, inserted just before `## Troubleshooting`. Tasks 2, 4 and 5 each add their own subsection.

**6b additions and overrides** (where a line above names 6a's branch, numbers or headings, these win):

- **Worktree:** work on `feat/phase-6b` in `/Users/paul/gcpe-news-platform-p6b` (base `a216006`). `node_modules` is already installed there.
- **Parity lists:** C201–C204 and Q70–Q77 are already in place from 6a. 6b adds **no C rows** and **Q78–Q80** (Task 5), and updates **Q74's working assumption** to ruling 10 (Task 4). The duplicate checks above still apply.
- **Running notes:** 6b lines go under a new `## Phase 6b — Semantic search, related posts and the change feed`, directly after the Phase 6a list (Task 1 creates the heading).
- **Runbook:** 6b's subsections go in a new `## Semantic search, related posts and the change feed (Phase 6b)`, inserted just before `## Troubleshooting` (after the 6a section). Task 1 creates the heading; Tasks 1–5 each add their own subsection.
- **The custom migration `0005_pgvector_optional.sql` is the one hand-written SQL file,** created empty by `drizzle-kit generate --custom` and filled with exactly the text in Task 1. Its journal entry and snapshot stay drizzle-kit's.
- **No `vector` type anywhere in `src/db/schema.ts`.** Every `vector` reference is a cast in SQL (`::vector(1536)`), and only on paths that run in semantic mode.
- **Tests that need a role without `CREATE EXTENSION`** use `createRestrictedNewsTestDb()` (Task 1). Every other News API test database is created by the admin role (a superuser locally and in CI), so it has pgvector and the HNSW index.
- **Bulk key lists travel as one JSON parameter** (`jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb)` or `jsonb_to_recordset`), never as `inArray` over an unbounded list: the legacy importer can touch tens of thousands of posts in one statement.
- **Lock order in a projection transaction:** `lockIdentity` (advisory), then rows of `posts` or `categories`, then `post_embeddings`/`post_related`, then the change-feed advisory lock (`recordChanges`). The only thing after it is what already followed the projection write: the release handlers' outbox enqueue (`requestRebuild`, an `aggregate_sequences` upsert), which every path reaches after `recordChanges`. Keep that order everywhere. The worker's write transactions lock `posts` rows first, too.

**6c additions and overrides** (where a line above names 6a's or 6b's branch, numbers or headings, these win; they apply to both 6c plans):

- **Worktree:** work on `feat/phase-6c` in `/Users/paul/gcpe-news-platform-p6c` (base `ef532f5`, main with 6a and 6b merged). `node_modules` is already installed there.
- **Migrations for the public site** run from its own folder: `cd apps/public-site && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name <name>`. Never hand-edit generated DDL.
- **Every page is valid, accessible HTML** (WCAG 2.2 AA by construction): `<html lang>`, one `<h1>`, a skip link to `#main` as the first focusable element, one each of `header`, `main` and `footer`, a labelled site `nav` in the header (any other `nav` also labelled), alt text on every `<img>` (`alt=""` when decorative), no positive `tabindex`, visible focus (theme CSS). Every page type's test runs `expectAccessibleStructure(html)` from `apps/public-site/test/structure.ts` (Task 1).
- **All user-supplied text is escaped with the existing `escapeHtml`** (`@gcpe/http-kit`, aliased `e` in `render.ts`): headlines, summaries, names, labels, URLs in attributes, feed and sitemap text. The only unescaped HTML is the release body (`detailsHtml`) and the minister's `details`, both staff-authored in NRMS, as today. JSON inside a `<script>` escapes `<` as `\u003c`.
- **Storage writes go through the hardened `SiteStorage`** (`apps/public-site/src/storage.ts`: no `..`, no absolute paths, symlink checks, atomic rename). Every output path comes from `pageFiles()` in `site-paths.ts`, which only accepts validated page ids. No other module joins output paths or calls `node:fs` for output.
- **Test sites keep `noindex`:** `<meta name="robots" content="noindex, nofollow">` on every HTML page and `Disallow: /` in `robots.txt` whenever `isTestSite(env)` is true.
- **Log lines** may name a page id (post keys and category keys are public); never a headline or body text.
- **Parity lists (6c):** C201–C204 and Q70–Q80 are in place. 6c-1 adds **C205–C206** and **Q81–Q83**, and updates **Q76's working assumption** (Task 5). 6c-2 adds **C207–C208** and **Q84–Q85**, and marks **C42** Reversed (its Tasks 1 and 5). The duplicate checks above still apply.
- **Running notes:** 6c lines go under a new `## Phase 6c — The public site`, directly after the Phase 6b list (6c-1 Task 1 creates the heading).
- **Runbook:** 6c's subsections go in a new `## The public site (Phase 6c)`, inserted just before `## Troubleshooting` (after the 6b section). 6c-1 Task 1 creates the heading.

## Review Focus

The five inputs most likely to bite a person, which the spec implies but no task's main tests exercise. Each has a test in the task named.

1. **A page re-queued while it is being rendered** (a second change to the same post lands mid-render). It must render again, not be deleted by the first render's completion. Task 1: "a page re-queued during its render stays queued".
2. **A crash or error between "enqueue the change's pages" and "save the cursor".** Neither may happen without the other, or changes are lost (cursor moved, pages not queued) — Task 2: "enqueue and cursor commit together: a failing enqueue leaves the cursor where it was". A `410` likewise: Task 2: "a 410 queues a full rebuild and moves the cursor to next in one transaction".
3. **A backlog of 100,000 post changes** (a legacy re-import, Q78) followed by a live publish. The publish must render on the next run, not after the backlog. Task 2: "a publish during a backlog renders first".
4. **A page that always fails** (the News API returns 500 for one key). It must not block the queue or loop within one run. Task 1: "a failing page goes to the back and is tried once per run".
5. **A slide image that doesn't match its event:** the fetched bytes have a different SHA-256, the file is missing (404), or it is larger than NRMS's 2 MB limit. The projection must fail (the event is retried), and v1 must never serve the wrong bytes. Task 5: the `it.each` table in `slide-images.test.ts`.

## File structure

**Created:**
- `apps/public-site/src/queue.ts`: `PRIORITY`, `dependentPriority`, `enqueuePages`, `nextBatch`, `completePage`, `deferPage`, `queueDepth`.
- `apps/public-site/src/drain.ts`: `drainQueue`.
- `apps/public-site/src/rebuild-all.ts`: `rebuildAllItems`, `enqueueRebuildAll`.
- `apps/public-site/src/sync.ts`: `syncSite`, `SyncDeps`, `SyncResult`.
- `apps/public-site/src/cursor.ts`: `readCursor`, `saveCursor`.
- `apps/public-site/src/change-feed.ts`: `ChangeRow`, `ChangesPage`, `ChangesClient`, `changesClient`, `pagesForChange`, `syncChanges`.
- `apps/public-site/src/loop.ts`: `every`.
- `apps/public-site/src/cli/rebuild-all.ts`.
- `apps/public-site/src/pages/search.ts`, `pages/search.test.ts`.
- Tests: `queue.test.ts`, `drain.test.ts`, `rebuild-all.test.ts`, `sync.test.ts`, `change-feed.test.ts`, `cursor.test.ts`.
- `apps/public-site/migrations/0002_rebuild_queue.sql` (generated) and its snapshot and journal entry.
- `apps/nrms/src/website/slide-images.ts`, `slide-images.test.ts`.
- `apps/news-api/src/slide-images.ts`, `slide-images.test.ts`.
- `apps/news-api/migrations/0006_slide_image_urls.sql` (generated; check the next free number with `ls apps/news-api/migrations`) and its snapshot and journal entry.
- `apps/news-api/src/http/v2/slides.test.ts`.

**Modified:**
- `apps/public-site/src/db/schema.ts` (`rebuildQueue`, `siteState`), `rebuild.ts` (handler → `syncSite`), `self-heal.ts`, `start.ts`, `env.ts`, `news-api-client.ts` (`slidesV2`), `site-paths.ts` (`search` page id), `builder.ts` (`search`; `sitemap:pages` lists it), `pages/home.ts` (images and the emergency region), `dto.ts`, `package.json` (`@gcpe/auth`; `site:rebuild-all` script).
- `apps/stack/src/stack.ts`, `stack.test.ts` (the `site.sync` tick step), `apps/stack/src/env.ts` (`STACK_APP_DEFAULTS.NEWSAPI.SLIDE_IMAGES_FETCH_BASE`).
- Root `package.json` (`site:rebuild-all`).
- `packages/events/src/catalogue.ts` (`slideRecordSchema`: `imageUrl`, `imageKey`, `imageSha256`).
- `apps/nrms/src/website/carousel.ts`, `events.ts`, `http/site-routes.ts`, `start.ts` and their tests.
- `apps/news-api/src/db/schema.ts` (`slides.imageUrl`, `imageKey`, `imageSha256`), `projections.ts`, `app.ts`, `start.ts`, `env.ts`, `read.ts` (`listSlidesV2`), `http/v2/routes.ts`.
- `tests/e2e/public-site.spec.ts`, `tests/e2e/website.spec.ts` (if it asserts the 700 KB refusal).
- Docs: `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`, `docs/parity/changes-from-legacy.md`, `docs/parity/open-questions.md`.

---

### Task 1: The rebuild queue, the drain and `site:rebuild-all`

**Review:** full (the rebuild queue; storage writes now driven from it).

**Files:**
- Modify: `apps/public-site/src/db/schema.ts`
- Create (generated): `apps/public-site/migrations/0002_rebuild_queue.sql`, `meta/0002_snapshot.json`, journal entry
- Create: `apps/public-site/src/queue.ts`, `queue.test.ts`, `drain.ts`, `drain.test.ts`, `rebuild-all.ts`, `rebuild-all.test.ts`, `sync.ts`, `sync.test.ts`, `loop.ts`, `cli/rebuild-all.ts`
- Modify: `apps/public-site/src/rebuild.ts`, `rebuild.test.ts`, `self-heal.ts`, `self-heal.test.ts`, `start.ts`, `start.test.ts`, `env.ts`, `env.test.ts`, `package.json`
- Modify: `apps/stack/src/stack.ts`, `apps/stack/src/stack.test.ts`; root `package.json`
- Docs: running notes, runbook, `docs/parity/changes-from-legacy.md` (C207), `docs/parity/open-questions.md` (Q84)

**Interfaces:**
- Consumes (6c-1): `SiteBuilder`, `RunCache`, `chromeChanged`, `writeSiteState`, `stateAndBanner`, `tryHome`, `enqueueSiteWrite`, `writeSubscribePages`, `PageOptions`.
- Produces:
  - `db/schema.ts`: `rebuildQueue` (`pageId`, `priority`, `seq`, `queuedAt`, `attempts`); `siteState` (`id`, `changeCursor: number | null`, `updatedAt`).
  - `queue.ts`: `PRIORITY = { livePost: 0, liveAggregate: 1, bulkPost: 2, bulkAggregate: 3 } as const`; `dependentPriority(p: number): number`; `interface QueueItem { pageId: string; priority: number; seq: number; attempts: number }`; `enqueuePages(db: DbOrTx, items: { pageId: string; priority: number }[]): Promise<void>`; `nextBatch(db: DbOrTx, limit: number, skip: string[]): Promise<QueueItem[]>`; `completePage(db: DbOrTx, item: QueueItem): Promise<boolean>`; `deferPage(db: DbOrTx, item: QueueItem): Promise<void>`; `queueDepth(db: DbOrTx): Promise<number>`.
  - `drain.ts`: `drainQueue(deps: { db: Db; builder: SiteBuilder }, opts: { budget: number; pageOpts: PageOptions }): Promise<{ rendered: number; deferred: number; remaining: number }>`.
  - `rebuild-all.ts`: `rebuildAllItems(builder: SiteBuilder): Promise<{ pageId: string; priority: number }[]>`; `enqueueRebuildAll(db: Db, builder: SiteBuilder): Promise<{ pages: number }>`.
  - `sync.ts`: `interface SyncDeps { db: Db; builder: SiteBuilder; index: PostIndex; newsApi: NewsApiClient; storage: SiteStorage; site: SiteInfo; test: boolean; batch: number; feed?: () => Promise<unknown> }`; `interface SyncResult { rendered: number; deferred: number; remaining: number }`; `syncSite(deps: SyncDeps, extra?: { pages?: string[] }): Promise<SyncResult>`; `createRebuildHandler(deps: SyncDeps): EventHandler` (moved here from `rebuild.ts`, which `sync.ts` imports; `start.ts` imports it from `sync.ts`).
  - `loop.ts`: `every(intervalMs: number, label: string, fn: () => Promise<unknown>): () => void`.
  - `env.ts`: `SITE_REBUILD_BATCH` (int 1–1000, default 200), `SYNC_INTERVAL_MS` (int, default 30000).
  - `AppHandle.workers.sync`; tick step `site.sync`; npm script `site:rebuild-all`.

- [ ] **Step 1: Add the tables and generate the migration**

In `apps/public-site/src/db/schema.ts` (add `bigint`, `bigserial`, `check`, `integer`, `smallint` to the `drizzle-orm/pg-core` import):

```ts
/**
 * spec §6.2: pages waiting to be rendered. One row per page; enqueueing again keeps the lower
 * priority and takes a fresh seq, which moves the page to the back of its priority and tells a
 * render already in progress that it must not delete the row (queue.ts).
 */
export const rebuildQueue = pgTable(
  "rebuild_queue",
  {
    pageId: text("page_id").primaryKey(),
    priority: smallint("priority").notNull(),
    seq: bigserial("seq", { mode: "number" }).notNull(),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().default(sql`now()`),
    attempts: integer("attempts").notNull().default(0),
  },
  (t) => [index("rebuild_queue_order_idx").on(t.priority, t.seq)],
);

/** One row (id 1): the change-feed cursor (spec §6.2), null until the first sync. */
export const siteState = pgTable(
  "site_state",
  {
    id: integer("id").primaryKey(),
    changeCursor: bigint("change_cursor", { mode: "number" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [check("site_state_single_row", sql`${t.id} = 1`)],
);
```

Run: `cd apps/public-site && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name rebuild_queue`
Expected: `0002_rebuild_queue.sql` with `CREATE TABLE "rebuild_queue"` (`"seq" bigserial NOT NULL`), `CREATE TABLE "site_state"` with its check, and the index. Don't edit it.

- [ ] **Step 2: Write the failing queue tests**

Create `apps/public-site/src/queue.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createPublicSiteTestDb } from "../test/helpers";
import { completePage, deferPage, dependentPriority, enqueuePages, nextBatch, PRIORITY, queueDepth } from "./queue";

describe("rebuild queue", () => {
  let tdb: TestDatabase;
  beforeAll(async () => { tdb = await createPublicSiteTestDb(); });
  afterAll(async () => { await tdb.drop(); });
  beforeEach(async () => { await tdb.pool.query("TRUNCATE rebuild_queue RESTART IDENTITY"); });
  const ids = async () => (await nextBatch(tdb.db, 100, [])).map((i) => `${i.pageId}@${i.priority}`);

  it("orders by priority, then by when it was queued", async () => {
    await enqueuePages(tdb.db, [{ pageId: "post:B", priority: PRIORITY.bulkPost }, { pageId: "home", priority: PRIORITY.liveAggregate }, { pageId: "post:A", priority: PRIORITY.bulkPost }]);
    await enqueuePages(tdb.db, [{ pageId: "post:L", priority: PRIORITY.livePost }]);
    expect(await ids()).toEqual(["post:L@0", "home@1", "post:B@2", "post:A@2"]);
  });

  it("a repeated page id in one call keeps the lowest priority (no ON CONFLICT error)", async () => {
    await enqueuePages(tdb.db, [{ pageId: "home", priority: 3 }, { pageId: "home", priority: 1 }, { pageId: "home", priority: 2 }]);
    expect(await ids()).toEqual(["home@1"]);
  });

  it("re-enqueueing keeps the lower priority and moves the page to the back of it", async () => {
    await enqueuePages(tdb.db, [{ pageId: "a", priority: 1 }, { pageId: "b", priority: 1 }]);
    await enqueuePages(tdb.db, [{ pageId: "a", priority: 3 }]);
    expect(await ids()).toEqual(["b@1", "a@1"]);
  });

  it("a page re-queued during its render stays queued", async () => {
    await enqueuePages(tdb.db, [{ pageId: "post:K", priority: 0 }]);
    const [item] = await nextBatch(tdb.db, 1, []);
    await enqueuePages(tdb.db, [{ pageId: "post:K", priority: 0 }]); // a second change lands mid-render
    expect(await completePage(tdb.db, item!)).toBe(false);
    expect(await queueDepth(tdb.db)).toBe(1);
    const [again] = await nextBatch(tdb.db, 1, []);
    expect(await completePage(tdb.db, again!)).toBe(true);
    expect(await queueDepth(tdb.db)).toBe(0);
  });

  it("deferPage moves a page to the back of its priority and counts the attempt", async () => {
    await enqueuePages(tdb.db, [{ pageId: "x", priority: 2 }, { pageId: "y", priority: 2 }]);
    const [x] = await nextBatch(tdb.db, 1, []);
    await deferPage(tdb.db, x!);
    const batch = await nextBatch(tdb.db, 10, []);
    expect(batch.map((i) => [i.pageId, i.attempts])).toEqual([["y", 0], ["x", 1]]);
  });

  it("nextBatch skips the given ids", async () => {
    await enqueuePages(tdb.db, [{ pageId: "x", priority: 2 }, { pageId: "y", priority: 2 }]);
    expect((await nextBatch(tdb.db, 10, ["x"])).map((i) => i.pageId)).toEqual(["y"]);
  });

  it("takes 100,000 pages in one call, in input order", async () => {
    const items = Array.from({ length: 100_000 }, (_, i) => ({ pageId: `post:K${100_000 - i}`, priority: 2 }));
    await enqueuePages(tdb.db, items);
    expect(await queueDepth(tdb.db)).toBe(100_000);
    expect((await nextBatch(tdb.db, 2, [])).map((i) => i.pageId)).toEqual(["post:K100000", "post:K99999"]);
  });

  it("dependents of a post go one priority later", () => {
    expect(dependentPriority(PRIORITY.livePost)).toBe(PRIORITY.liveAggregate);
    expect(dependentPriority(PRIORITY.bulkPost)).toBe(PRIORITY.bulkAggregate);
    expect(dependentPriority(PRIORITY.liveAggregate)).toBe(PRIORITY.liveAggregate);
  });
});
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/public-site/src/queue.test.ts`
Expected: FAIL — `Failed to resolve import "./queue"`.

- [ ] **Step 3: Implement `queue.ts`**

```ts
import { sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";

/** Lower drains first. A post's dependents go one step later (dependentPriority). */
export const PRIORITY = { livePost: 0, liveAggregate: 1, bulkPost: 2, bulkAggregate: 3 } as const;

export const dependentPriority = (p: number): number => (p === PRIORITY.livePost ? PRIORITY.liveAggregate : p === PRIORITY.bulkPost ? PRIORITY.bulkAggregate : p);

export interface QueueItem {
  pageId: string;
  priority: number;
  seq: number;
  attempts: number;
}

/** Rows per statement: one JSON parameter each (Global Constraints). */
const CHUNK = 20_000;

/**
 * Queues pages. A repeated id (in the input or already queued) keeps the lowest priority and
 * takes a fresh seq; input order decides seq order (WITH ORDINALITY), so a caller can queue
 * newest first.
 */
export async function enqueuePages(db: DbOrTx, items: { pageId: string; priority: number }[]): Promise<void> {
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK).map((x) => ({ page_id: x.pageId, priority: x.priority }));
    await db.execute(sql`
      INSERT INTO rebuild_queue (page_id, priority)
      SELECT d.page_id, d.priority FROM (
        SELECT DISTINCT ON (x.page_id) x.page_id, x.priority, x.ord
        FROM ROWS FROM (jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb) AS (page_id text, priority smallint)) WITH ORDINALITY AS x(page_id, priority, ord)
        ORDER BY x.page_id, x.priority, x.ord
      ) d
      ORDER BY d.ord
      ON CONFLICT (page_id) DO UPDATE SET
        priority = least(rebuild_queue.priority, excluded.priority),
        seq = nextval(pg_get_serial_sequence('rebuild_queue', 'seq')),
        queued_at = now()`);
  }
}

export async function nextBatch(db: DbOrTx, limit: number, skip: string[]): Promise<QueueItem[]> {
  const { rows } = await db.execute<{ page_id: string; priority: number; seq: string; attempts: number }>(sql`
    SELECT page_id, priority, seq, attempts FROM rebuild_queue
    WHERE NOT (page_id = ANY (SELECT jsonb_array_elements_text(${JSON.stringify(skip)}::jsonb)))
    ORDER BY priority, seq
    LIMIT ${limit}`);
  return rows.map((r) => ({ pageId: r.page_id, priority: Number(r.priority), seq: Number(r.seq), attempts: Number(r.attempts) }));
}

/** Deletes the row only if nobody re-queued it since it was read. */
export async function completePage(db: DbOrTx, item: QueueItem): Promise<boolean> {
  const { rows } = await db.execute(sql`DELETE FROM rebuild_queue WHERE page_id = ${item.pageId} AND seq = ${item.seq} RETURNING page_id`);
  return rows.length > 0;
}

export async function deferPage(db: DbOrTx, item: QueueItem): Promise<void> {
  await db.execute(sql`
    UPDATE rebuild_queue SET attempts = attempts + 1, seq = nextval(pg_get_serial_sequence('rebuild_queue', 'seq'))
    WHERE page_id = ${item.pageId} AND seq = ${item.seq}`);
}

export async function queueDepth(db: DbOrTx): Promise<number> {
  const { rows } = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM rebuild_queue`);
  return rows[0]?.n ?? 0;
}
```

Run the queue tests: PASS.

- [ ] **Step 4: Write the failing drain and rebuild-all tests**

`apps/public-site/src/drain.test.ts` uses a real test database (the queue and the index), `memoryStorage()` and the fake News API (`test/fake-news-api.ts`), and a real `createSiteBuilder`:

```ts
it("renders a live post, then its dependents in the same run", async () => {
  api.posts.set("K1", post({ key: "K1" }));
  await enqueuePages(tdb.db, [{ pageId: "post:K1", priority: PRIORITY.livePost }]);
  const r = await drainQueue({ db: tdb.db, builder }, { budget: 200, pageOpts: {} });
  expect(r.remaining).toBe(0);
  expect(storage.files.has("releases/K1/index.html")).toBe(true);
  expect(storage.files.has("ministries/health/index.html")).toBe(true);
  expect(storage.files.has("archive/2026/10/index.html")).toBe(true);
});

it("stops at the budget and leaves the rest queued", async () => {
  for (let i = 0; i < 5; i++) api.posts.set(`K${i}`, post({ key: `K${i}` }));
  await enqueuePages(tdb.db, [...api.posts.keys()].map((k) => ({ pageId: `post:${k}`, priority: PRIORITY.bulkPost })));
  const r = await drainQueue({ db: tdb.db, builder }, { budget: 3, pageOpts: {} });
  expect(r.rendered).toBe(3);
  expect(r.remaining).toBeGreaterThan(0);
});

it("bulk posts' dependents wait behind every bulk post", async () => {
  for (let i = 0; i < 3; i++) api.posts.set(`K${i}`, post({ key: `K${i}` }));
  await enqueuePages(tdb.db, [...api.posts.keys()].map((k) => ({ pageId: `post:${k}`, priority: PRIORITY.bulkPost })));
  await drainQueue({ db: tdb.db, builder }, { budget: 3, pageOpts: {} });
  expect(storage.files.has("index.html")).toBe(false); // home is priority 3, behind the three posts
});

it("a failing page goes to the back and is tried once per run", async () => {
  api.posts.set("OK", post({ key: "OK" }));
  let calls = 0;
  const getPost = api.getPost;
  api.getPost = async (key) => { if (key === "BAD") { calls++; throw new Error("News API 500"); } return getPost(key); };
  await enqueuePages(tdb.db, [{ pageId: "post:BAD", priority: 0 }, { pageId: "post:OK", priority: 0 }]);
  const r = await drainQueue({ db: tdb.db, builder }, { budget: 200, pageOpts: {} });
  expect(calls).toBe(1);
  expect(r.deferred).toBe(1);
  expect(storage.files.has("releases/OK/index.html")).toBe(true);
  const { rows } = await tdb.pool.query("SELECT attempts FROM rebuild_queue WHERE page_id = 'post:BAD'");
  expect(rows[0].attempts).toBe(1);
});

it("an invalid page id is dropped from the queue without writing anything", async () => {
  await enqueuePages(tdb.db, [{ pageId: "post:../../etc", priority: 0 }]);
  await drainQueue({ db: tdb.db, builder }, { budget: 10, pageOpts: {} });
  expect(await queueDepth(tdb.db)).toBe(0);
  expect(storage.files.size).toBe(0);
});
```

`apps/public-site/src/rebuild-all.test.ts`:

```ts
it("queues home, static and the indexes live, every post bulk (newest first), then every aggregate", async () => {
  api.posts.set("OLD", post({ key: "OLD", publishDate: "2026-01-01T09:00:00-08:00" }));
  api.posts.set("NEW", post({ key: "NEW", publishDate: "2026-10-01T09:00:00-07:00" }));
  await enqueueRebuildAll(tdb.db, builder);
  const batch = await nextBatch(tdb.db, 1000, []);
  const at = (p: number) => batch.filter((i) => i.priority === p).map((i) => i.pageId);
  expect(at(PRIORITY.liveAggregate)).toEqual(["static", "home", "ministries", "archive", "sitemap"]);
  expect(at(PRIORITY.bulkPost)).toEqual(["post:NEW", "post:OLD"]);
  expect(at(PRIORITY.bulkAggregate)).toContain("sitemap:pages");
  expect(at(PRIORITY.bulkAggregate)).toContain("category:ministries:health");
});
```

(The fake News API's `postKeys` must return keys newest first, as v1 does.)

Run both: FAIL (unresolved imports).

- [ ] **Step 5: Implement `drain.ts` and `rebuild-all.ts`**

```ts
// drain.ts
import type { Db } from "@gcpe/db-kit";
import { safeErrorLabel } from "@gcpe/http-kit";
import type { RunCache, SiteBuilder } from "./builder";
import { completePage, deferPage, dependentPriority, enqueuePages, nextBatch, queueDepth } from "./queue";
import type { PageOptions } from "./render";

const BATCH = 50;

/** spec §6.2: render up to `budget` queued pages, lowest priority first. Never throws for a page. */
export async function drainQueue(deps: { db: Db; builder: SiteBuilder }, opts: { budget: number; pageOpts: PageOptions }): Promise<{ rendered: number; deferred: number; remaining: number }> {
  const run: RunCache = {};
  const failed: string[] = [];
  let rendered = 0;
  while (rendered + failed.length < opts.budget) {
    const batch = await nextBatch(deps.db, Math.min(BATCH, opts.budget - rendered - failed.length), failed);
    if (batch.length === 0) break;
    for (const item of batch) {
      try {
        const dependents = await deps.builder.renderPage(item.pageId, opts.pageOpts, run);
        await deps.db.transaction(async (tx) => {
          if (dependents.length) await enqueuePages(tx, dependents.map((pageId) => ({ pageId, priority: dependentPriority(item.priority) })));
          await completePage(tx, item);
        });
        rendered++;
      } catch (err) {
        failed.push(item.pageId);
        console.error(`[public-site] rebuild of ${item.pageId} failed (attempt ${item.attempts + 1}); queued again ${safeErrorLabel(err)}`);
        await deferPage(deps.db, item);
      }
    }
  }
  return { rendered, deferred: failed.length, remaining: await queueDepth(deps.db) };
}
```

```ts
// rebuild-all.ts
import type { Db } from "@gcpe/db-kit";
import type { SiteBuilder } from "./builder";
import { enqueuePages, PRIORITY } from "./queue";

/** Rendered on the same run as the trigger, so a layout or Blue Bridge change shows on home at once. */
const FIRST = ["static", "home", "ministries", "archive", "sitemap"];

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
```

(`enqueuePages`' `DISTINCT ON` keeps `home` at priority 1 although `aggregatePageIds()` lists it again at 3.)

Run: PASS.

- [ ] **Step 6: `syncSite`, the handler, self-heal, the loop and startup — failing tests first**

`apps/public-site/src/sync.test.ts`:
- "an event's pages are queued live and rendered in the same turn" (`syncSite(deps, { pages: ["home", "post:K1"] })` → both written; queue empty).
- "a chrome change queues a full rebuild, writes the marker, and renders home on the same run": a marker with `chrome: 2` on disk; `syncSite(deps)` with `batch: 5` → `index.html` exists with the new chrome, the marker says `chrome: 3`, the queue still has bulk pages.
- "a home() failure rejects and queues nothing".
- "turning Blue Bridge on puts the banner on home now and on every release page as the queue drains" (two calls with a large batch; every `releases/*/index.html` contains the banner text).

Rewrite `rebuild.test.ts`'s handler tests to call through `createRebuildHandler` → `syncSite` (same expectations as `sync.test.ts`'s first two, via the event envelope); keep the `enqueueSiteWrite` tests. Rewrite `self-heal.test.ts`: empty output → queues a rebuild-all and drains one batch (home exists, returns `{ rebuilt: n }` with `n > 0`); News API outage → `null`, subscribe pages written; current marker and `index.html` present → drains whatever is queued, returns `null` when nothing was rendered.

Run them: FAIL.

Implement `sync.ts`:

```ts
import type { Db } from "@gcpe/db-kit";
import { safeErrorLabel } from "@gcpe/http-kit";
import type { SiteBuilder } from "./builder";
import { drainQueue } from "./drain";
import type { NewsApiClient } from "./news-api-client";
import type { PostIndex } from "./post-index";
import { enqueuePages, PRIORITY } from "./queue";
import { chromeChanged, enqueueSiteWrite, stateAndBanner, writeSiteState } from "./rebuild";
import { enqueueRebuildAll } from "./rebuild-all";
import type { PageOptions, SiteInfo } from "./render";
import type { SiteStorage } from "./storage";

export interface SyncDeps {
  db: Db;
  builder: SiteBuilder;
  index: PostIndex;
  newsApi: NewsApiClient;
  storage: SiteStorage;
  site: SiteInfo;
  test: boolean;
  /** Pages per run (SITE_REBUILD_BATCH). */
  batch: number;
  /** Reads the change feed into the queue (change-feed.ts); absent in tests that don't need it. */
  feed?: () => Promise<unknown>;
}

export interface SyncResult {
  rendered: number;
  deferred: number;
  remaining: number;
}

const livePriority = (pageId: string) => (pageId.startsWith("post:") ? PRIORITY.livePost : PRIORITY.liveAggregate);

/**
 * One serialised turn (per SiteStorage, like every other site write): queue the caller's pages,
 * decide the chrome (a home() failure rejects the turn), read the change feed, render a batch.
 */
export function syncSite(deps: SyncDeps, extra: { pages?: string[] } = {}): Promise<SyncResult> {
  return enqueueSiteWrite(deps.storage, async () => {
    const { granville } = await deps.newsApi.home();
    const { state, banner } = stateAndBanner(granville, deps.test, new Date());
    const pageOpts: PageOptions = { test: deps.test, banner };
    if (extra.pages?.length) await enqueuePages(deps.db, extra.pages.map((pageId) => ({ pageId, priority: livePriority(pageId) })));
    if (await chromeChanged(deps.storage, state, deps.site)) {
      await enqueueRebuildAll(deps.db, deps.builder);
      await writeSiteState(deps.storage, state, deps.site);
    }
    if (deps.feed) {
      try {
        await deps.feed();
      } catch (err) {
        console.error(`[public-site] change feed unavailable; draining what is queued ${safeErrorLabel(err)}`);
      }
    }
    return drainQueue({ db: deps.db, builder: deps.builder }, { budget: deps.batch, pageOpts });
  });
}
```

`createRebuildHandler` moves from `rebuild.ts` to `sync.ts` (keeping it in `rebuild.ts` would make the two files import each other):

```ts
export function createRebuildHandler(deps: SyncDeps): EventHandler {
  return async (_tx, event) => {
    const { pages } = event.data as { pages: string[] };
    await syncSite(deps, { pages: Array.isArray(pages) ? pages.filter((p): p is string => typeof p === "string") : [] });
  };
}
```

`self-heal.ts`:

```ts
export function selfHeal(deps: SyncDeps): Promise<{ rebuilt: number } | null> {
  const { newsApi, storage, site, test } = deps;
  return enqueueSiteWrite(storage, async () => {
    const home = await tryHome(newsApi);
    const computed = home ? stateAndBanner(home.granville, test, new Date()) : null;
    const pageOpts = { test, banner: computed?.banner ?? null };
    await writeSubscribePages(storage, site, pageOpts);
    if (!computed) return null;
    if ((await chromeChanged(storage, computed.state, site)) || !(await storage.exists("index.html"))) {
      await enqueueRebuildAll(deps.db, deps.builder);
      await writeSiteState(storage, computed.state, site);
    }
    const r = await drainQueue({ db: deps.db, builder: deps.builder }, { budget: deps.batch, pageOpts });
    return r.rendered > 0 ? { rebuilt: r.rendered } : null;
  });
}
```

`loop.ts` (the News API's `every`, with this app's log prefix):

```ts
import { safeErrorLabel } from "@gcpe/http-kit";

/** Runs `fn` every `intervalMs`, never two at once; a failure is logged with a safe label. */
export function every(intervalMs: number, label: string, fn: () => Promise<unknown>): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    fn()
      .catch((e) => console.error(`[public-site] ${label} failed ${safeErrorLabel(e)}`))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
```

`env.ts`: `SITE_REBUILD_BATCH: z.coerce.number().int().min(1).max(1000).default(200)`, `SYNC_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000)`; `env.test.ts` cases for both defaults and the bounds.

`start.ts`: build `syncDeps` once (`{ db, builder, index, newsApi, storage, site, test, batch: parsed.SITE_REBUILD_BATCH }`), pass it to `createRebuildHandler` and `selfHeal`; `workers: { sync: () => syncSite(syncDeps) }`; `startLoops()` starts `every(parsed.SYNC_INTERVAL_MS, "site.sync", () => syncSite(syncDeps))` and keeps its stop function; `closeBeforeServer: [{ name: "background loops", close: async () => stop?.() }]`. Update `start.test.ts` for `workers.sync` and the closer.

`apps/stack/src/stack.ts`: add after `news-api.changes-prune`:

```ts
        // Reads the change feed into the site's rebuild queue and renders up to
        // SITE_SITE_REBUILD_BATCH pages (spec §6.2). After the News API's own steps, so this
        // tick's changes are already in the feed.
        { name: "site.sync", run: worker(siteBuilder, "sync") },
```

and add `"site.sync"` to the step list `stack.test.ts` asserts (after `"news-api.changes-prune"`).

- [ ] **Step 7: The `site:rebuild-all` CLI**

`apps/public-site/src/cli/rebuild-all.ts`:

```ts
// Queues every page of the public site for rebuilding (spec §6.2, runbook "site:rebuild-all").
// The queue drains on the next ticks; nothing is rendered here.
import { parseEnv } from "@gcpe/config";
import { createDb } from "@gcpe/db-kit";
import { safeErrorLabel } from "@gcpe/http-kit";
import { z } from "zod";
import { createSiteBuilder } from "../builder";
import { newsApiClient } from "../news-api-client";
import { postIndex } from "../post-index";
import { enqueueRebuildAll } from "../rebuild-all";
import { fsStorage } from "../storage";

const env = parseEnv(z.object({ DATABASE_URL: z.string().url(), NEWS_API_URL: z.string().url(), OUTPUT_DIR: z.string().min(1), PUBLIC_SITE_URL: z.string().url(), SITE_NAME: z.string().default("site") }), process.env);
const { db, pool } = createDb(env.DATABASE_URL);
try {
  const builder = createSiteBuilder({ newsApi: newsApiClient(env.NEWS_API_URL), storage: fsStorage(env.OUTPUT_DIR), index: postIndex(db), site: { name: env.SITE_NAME, baseUrl: env.PUBLIC_SITE_URL }, assetsDir: null });
  const { pages } = await enqueueRebuildAll(db, builder);
  console.log(`[public-site] queued ${pages} pages; they render over the next ticks`);
} catch (err) {
  console.error(`[public-site] site:rebuild-all failed ${safeErrorLabel(err)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
```

`apps/public-site/package.json` script: `"site:rebuild-all": "tsx src/cli/rebuild-all.ts"`; root `package.json`: `"site:rebuild-all": "npm --workspace @gcpe/public-site run site:rebuild-all --"`. Like the other CLIs, it runs from a full checkout against the site's database and the News API's URL (a public v1 base URL works: it only reads v1).

- [ ] **Step 8: Run everything; type-check**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/public-site apps/stack/src/stack.test.ts` and `tsc`.
Expected: PASS; clean. Then `npx -y -p node@24 -- node node_modules/@playwright/test/cli.js test tests/e2e/public-site.spec.ts tests/e2e/unpublish.spec.ts` — PASS (the event path now enqueues and drains in the same turn).

- [ ] **Step 9: Docs**

Running notes (Phase 6c): `- **Operations** — Site rebuilds now go through a queue in the site's database and run on each tick (200 pages at a time). A publish, change or unpublish shows on the site at the next tick. A layout change or a Blue Bridge switch updates the home page at once and older pages over the following ticks, newest first.` and `- **Developer** — \`npm run site:rebuild-all\` (with the site's DATABASE_URL, NEWS_API_URL, OUTPUT_DIR and PUBLIC_SITE_URL) queues every page.`

Runbook `### The rebuild queue`: what's queued and in what order; `SELECT priority, count(*) FROM rebuild_queue GROUP BY 1` to watch it drain; `SELECT page_id, attempts FROM rebuild_queue WHERE attempts > 3` for stuck pages and that they're retried each run; `SITE_SITE_REBUILD_BATCH`; `site:rebuild-all`; the standalone loop (`SYNC_INTERVAL_MS`).

`changes-from-legacy.md`: `| C207 | — | A layout change or a Blue Bridge switch updates the platform site's home page at once and every older page over the following ticks (200 pages a tick, newest first), not all at once. | A full rebuild of about 100,000 pages can't finish in one request; the queue survives restarts. | Proposed |`

`open-questions.md`: `| Q84 | Is a Blue Bridge switch that reaches older release pages over hours (about eight at 100,000 posts and one tick a minute) acceptable on the platform's own site? | The home page and every new page show the banner at once; older pages lag. | Yes for the platform's site; BC's webapp is unaffected (D1). A larger batch or a faster tick shortens it. | 2026-10-11 |`

- [ ] **Step 10: Commit**

```bash
git add apps/public-site apps/stack package.json package-lock.json docs
git commit -m "public-site: persistent rebuild queue drained on tick, full rebuild through the queue, site:rebuild-all"
```

---

### Task 2: The change-feed consumer

**Review:** full (the change-feed consumer; the service token).

**Files:**
- Create: `apps/public-site/src/cursor.ts`, `cursor.test.ts`, `change-feed.ts`, `change-feed.test.ts`
- Modify: `apps/public-site/src/env.ts`, `env.test.ts`, `start.ts`, `start.test.ts`, `sync.ts`, `sync.test.ts`, `package.json` (`@gcpe/auth`)
- Docs: running notes, runbook

**Interfaces:**
- Consumes: Task 1's `enqueuePages`, `PRIORITY`, `rebuildAllItems`, `SyncDeps.feed`; 6c-1's `PostIndex.inCategory`, `categoryPageId`, `POST_KEY`, `isCategoryKind`; `serviceTokenProvider`, `authFromEnv`, `NEWS_API_CHANGES_ROLE`, `type ServiceTokenOptions`, `type LocalAuthConfig` from `@gcpe/auth`.
- Produces:
  - `cursor.ts`: `readCursor(db: DbOrTx): Promise<number | null>`; `saveCursor(db: DbOrTx, cursor: number): Promise<void>`.
  - `change-feed.ts`: `type ChangeKind = "post.upserted" | "post.unpublished" | "home" | "slides" | "resource_links" | "ministry" | "sector" | "theme" | "tag"`; `interface ChangeRow { id: number; kind: ChangeKind; key: string | null }`; `type ChangesPage = { resync: false; changes: ChangeRow[]; next: number } | { resync: true; next: number }`; `interface ChangesClient { read(after: number, limit: number): Promise<ChangesPage> }`; `changesClient(opts: { baseUrl: string; getToken: () => Promise<string>; fetchImpl?: typeof fetch }): ChangesClient`; `pagesForChange(c: ChangeRow, postPriority: number): { pageId: string; priority: number }[]`; `CATEGORY_CHANGE: Record<"ministry" | "sector" | "theme" | "tag", CategoryKind>`; `syncChanges(deps: { db: Db; client: ChangesClient; builder: SiteBuilder; index: PostIndex }, opts?: { pageLimit?: number; maxPages?: number; livePostLimit?: number }): Promise<{ changes: number; resynced: boolean }>`.
  - `env.ts`: `NEWS_API_TOKEN_URL`, `NEWS_API_CLIENT_ID`, `NEWS_API_CLIENT_SECRET`, `NEWS_API_SCOPE` (optional); `newsApiTokenOptions(parsed, env: NodeJS.ProcessEnv): ServiceTokenOptions`.

- [ ] **Step 1: Write the failing tests**

`cursor.test.ts`: `readCursor` is `null` on a fresh database; `saveCursor(db, 42)` then `readCursor` → 42; saving again overwrites; the check constraint keeps one row.

`change-feed.test.ts`, the pure mapping:

```ts
describe("pagesForChange", () => {
  it.each([
    [{ id: 1, kind: "post.upserted", key: "K1" }, [{ pageId: "post:K1", priority: 0 }]],
    [{ id: 2, kind: "post.unpublished", key: "K1" }, [{ pageId: "post:K1", priority: 0 }]],
    [{ id: 3, kind: "home", key: null }, [{ pageId: "home", priority: 1 }]],
    [{ id: 4, kind: "slides", key: null }, [{ pageId: "home", priority: 1 }]],
    [{ id: 5, kind: "resource_links", key: null }, [{ pageId: "home", priority: 1 }]],
    [{ id: 6, kind: "ministry", key: "Health" }, [{ pageId: "category:ministries:health", priority: 1 }, { pageId: "ministries", priority: 1 }, { pageId: "sitemap:pages", priority: 1 }]],
    [{ id: 7, kind: "tag", key: "covid-19" }, [{ pageId: "category:tags:covid-19", priority: 1 }, { pageId: "sitemap:pages", priority: 1 }]],
    [{ id: 8, kind: "post.upserted", key: "../x" }, []],
    [{ id: 9, kind: "ministry", key: null }, []],
    [{ id: 10, kind: "sector", key: "a b" }, []],
  ] as const)("%j", (change, expected) => {
    expect(pagesForChange(change as ChangeRow, 0)).toEqual(expected);
  });
  it("a post change takes the priority it's given", () => {
    expect(pagesForChange({ id: 1, kind: "post.upserted", key: "K1" }, 2)).toEqual([{ pageId: "post:K1", priority: 2 }]);
  });
});
```

The client, against a stubbed `fetch`:
- sends `Authorization: Bearer <token>` to `<base>/api/v2/changes?after=7&limit=500` (base with and without a trailing slash, and with a path like `http://host/news/`);
- `200` → `{ resync: false, changes, next }`;
- `410` with `{ resync: true, next: 99 }` → `{ resync: true, next: 99 }`;
- `401`, `403`, `503`, `500` → rejects with `News API changes <status>`, and the error message never contains the token.

`syncChanges` against a real test database and a scripted fake `ChangesClient` (an array of pages served in order; it records the `after` values it was called with):
- "first run: reads to the head without enqueueing changes, then queues a full rebuild and saves the head" (pages `[ {changes:[1,2]}, {changes:[3]}, {changes:[]} ]` → cursor 3; the queue holds rebuild-all's items and no item from the changes' own pages beyond what rebuild-all already lists);
- "applies changes after the cursor, enqueues their pages and saves the cursor" (cursor 3; a page with a `post.upserted K9` and a `home` → `post:K9@0`, `home@1`, cursor = next);
- "a ministry change also queues its posts' release pages as bulk" (index has K1 and K2 in `ministries:health`; change `ministry Health` → `post:K1@2`, `post:K2@2`);
- "a publish during a backlog renders first": 150 post changes in one page, `livePostLimit: 100` → the first 100 at 0, the rest at 2; then `syncSite` with an event's `post:LIVE` → `nextBatch` returns `post:LIVE` among the first 101;
- "a 410 queues a full rebuild and moves the cursor to next in one transaction";
- "enqueue and cursor commit together: a failing enqueue leaves the cursor where it was" (stub `builder.allPostKeys` or make the index's `inCategory` throw for a category change → `syncChanges` rejects; cursor unchanged; queue has no row from that page);
- "stops after maxPages pages" (the client is called at most `maxPages` times per run).

`env.test.ts`: `newsApiTokenOptions` — all four Entra fields → `tokenUrl`…`scope` set, subject `site-builder`, roles `["NewsApi.ChangesRead"]`, `envPrefix: "NEWS_API"`; `LOCAL_ADMIN_ENABLED=true` with a valid hash and secret plus `ENTRA_TENANT_ID` set but no `AUTH_AUDIENCE` → `local` is set (no throw); neither → `local: null` and `serviceTokenProvider(newsApiTokenOptions(…))` throws mentioning `NEWS_API_TOKEN_URL`.

`start.test.ts`: `startPublicSite` with neither Entra nor local admin rejects; with local admin it starts.

Run them: FAIL.

- [ ] **Step 2: Implement**

`cursor.ts`:

```ts
import { eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import { siteState } from "./db/schema";

export async function readCursor(db: DbOrTx): Promise<number | null> {
  const [row] = await db.select({ c: siteState.changeCursor }).from(siteState).where(eq(siteState.id, 1));
  return row?.c ?? null;
}

export async function saveCursor(db: DbOrTx, cursor: number): Promise<void> {
  await db
    .insert(siteState)
    .values({ id: 1, changeCursor: cursor })
    .onConflictDoUpdate({ target: siteState.id, set: { changeCursor: cursor, updatedAt: sql`now()` } });
}
```

`change-feed.ts`:

```ts
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

/** GET /api/v2/changes with the site builder's service token (spec §5.4). */
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
      return [{ pageId: id, priority: live }, ...(kind === "ministries" ? [{ pageId: "ministries", priority: live }] : []), { pageId: "sitemap:pages", priority: live }];
    }
  }
}

/**
 * Reads the feed from the stored cursor into the queue. Each page of changes and the cursor
 * move commit in one transaction. No cursor yet: read to the head first, then queue a full
 * rebuild (a change committed in between is read next time). 410: full rebuild, cursor = next.
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
    const items = await rebuildAllItems(deps.builder);
    await deps.db.transaction(async (tx) => {
      await enqueuePages(tx, items);
      await saveCursor(tx, next);
    });
    resynced = true;
    cursor = next;
  };

  if (cursor === null) {
    let head = 0;
    for (;;) {
      const page = await deps.client.read(head, pageLimit);
      if (page.resync) { head = page.next; continue; }
      if (page.changes.length === 0) break;
      head = page.next;
    }
    await fullRebuild(head);
  }

  for (let i = 0; i < maxPages; i++) {
    const page = await deps.client.read(cursor!, pageLimit);
    if (page.resync) { await fullRebuild(page.next); continue; }
    if (page.changes.length === 0) break;
    const items: { pageId: string; priority: number }[] = [];
    for (const c of page.changes) {
      const isPost = c.kind === "post.upserted" || c.kind === "post.unpublished";
      const priority = isPost && livePosts > 0 ? (livePosts--, PRIORITY.livePost) : PRIORITY.bulkPost;
      items.push(...pagesForChange(c, priority));
      if (!isPost && c.kind in CATEGORY_CHANGE && c.key) {
        const id = categoryPageId(CATEGORY_CHANGE[c.kind as keyof typeof CATEGORY_CHANGE], c.key);
        if (id) for (const key of await deps.index.inCategory(id.slice("category:".length))) items.push({ pageId: `post:${key}`, priority: PRIORITY.bulkPost });
      }
    }
    await deps.db.transaction(async (tx) => {
      await enqueuePages(tx, items);
      await saveCursor(tx, page.next);
    });
    applied += page.changes.length;
    cursor = page.next;
  }
  return { changes: applied, resynced };
}
```

(A first-run fast-forward that hits `410` at `after=0` jumps to `next` and keeps reading. The loop is bounded by the feed's length, 90 days of changes at 500 a request.)

`env.ts` adds the four optional fields (`z.string().url().optional()` for the token URL, `z.string().optional()` for the others, `""` treated as unset like NRMS's `optionalSetting`) and:

```ts
/**
 * The site builder's token for GET /api/v2/changes (spec §5.4): Entra client credentials when
 * NEWS_API_TOKEN_URL/CLIENT_ID/CLIENT_SECRET/SCOPE are set, else a locally minted token on a
 * test deployment. The local branch reads a view without ENTRA_TENANT_ID/AUTH_AUDIENCE: on the
 * stack the tenant id is shared but this app has no audience, and authFromEnv would refuse it.
 */
export function newsApiTokenOptions(parsed: Pick<z.infer<ReturnType<typeof publicSiteEnvSchema>>, "NEWS_API_TOKEN_URL" | "NEWS_API_CLIENT_ID" | "NEWS_API_CLIENT_SECRET" | "NEWS_API_SCOPE">, env: NodeJS.ProcessEnv): ServiceTokenOptions {
  const local: LocalAuthConfig | null = env.LOCAL_ADMIN_ENABLED === "true" ? authFromEnv({ ...env, ENTRA_TENANT_ID: undefined, AUTH_AUDIENCE: undefined, SESSION_SECRET: undefined }).local : null;
  return {
    tokenUrl: parsed.NEWS_API_TOKEN_URL,
    clientId: parsed.NEWS_API_CLIENT_ID,
    clientSecret: parsed.NEWS_API_CLIENT_SECRET,
    scope: parsed.NEWS_API_SCOPE,
    local,
    subject: "site-builder",
    roles: [NEWS_API_CHANGES_ROLE],
    envPrefix: "NEWS_API",
  };
}
```

Add `"@gcpe/auth": "0.0.0"` to `apps/public-site/package.json` dependencies and run `npm install --ignore-scripts` (workspace link only).

`start.ts`: `const getToken = serviceTokenProvider(newsApiTokenOptions(parsed, env));` (throws at startup without credentials, ruling 8); `const client = changesClient({ baseUrl: parsed.NEWS_API_URL, getToken });` and `syncDeps.feed = () => syncChanges({ db, client, builder, index })`.

On the stack, the stack prefixes: `SITE_NEWS_API_TOKEN_URL` etc. would be the Entra settings; unset on boxs.ca, where the shared `LOCAL_ADMIN_ENABLED=true` gives the local token. No `scripts/siteground-env.ts` change.

Run the tests: PASS. Then `apps/stack/src/stack.test.ts` and the E2E specs from Task 1 Step 8: PASS (on the stack the feed now runs on every sync).

- [ ] **Step 3: An integration check against the real News API route**

Add to `apps/stack/src/stack.test.ts` (it already boots the whole stack with local admin):

```ts
it("the site builder reads the News API change feed with its own service token", async () => {
  const res = await fetch(`${instance.stackUrl}/stack/tick`, { method: "POST", headers: { authorization: `Bearer ${instance.tickToken}` } });
  expect(res.status).toBe(200);
  const { rows } = await instance.siteDbPool.query("SELECT change_cursor FROM site_state WHERE id = 1");
  expect(rows[0]?.change_cursor).not.toBeNull();
});
```

(Expose the site database pool on the test's `instance` the way the file already exposes others; if it doesn't, query through `pg` with the site database URL the setup created.)

- [ ] **Step 4: Docs**

Running notes: `- **Operations** — If the site builder was stopped, it catches up from the News API's change feed when it starts again; if it was stopped for more than 90 days it rebuilds the whole site.` and `- **Administrator** — Standalone (OpenShift): the site builder needs an Entra app registration with the News API's \`NewsApi.ChangesRead\` app role (NEWS_API_TOKEN_URL, NEWS_API_CLIENT_ID, NEWS_API_CLIENT_SECRET, NEWS_API_SCOPE), and the News API needs AUTH_AUDIENCE. It won't start without them.`

Runbook `### The change feed`: the cursor (`SELECT change_cursor FROM site_state`), what `410` does, the first-start full rebuild after this deploy, the credentials per deployment (stack: local admin; OpenShift: Entra), and that a feed error is logged and retried on the next tick while queued pages still render.

- [ ] **Step 5: Commit**

```bash
git add apps/public-site apps/stack package-lock.json docs
git commit -m "public-site: consume the News API change feed with a stored cursor; events become a doorbell"
```

---

### Task 3: The search page

**Review:** shared (template and script; pairs with nothing else in this plan, so the reviewer checks escaping and the script's DOM building together).

**Files:**
- Create: `apps/public-site/src/pages/search.ts`, `pages/search.test.ts`
- Modify: `apps/public-site/src/site-paths.ts`, `site-paths.test.ts` (`search`), `builder.ts`, `builder.test.ts`, `change-feed.ts`, `change-feed.test.ts`, `rebuild-all.ts`, `env.ts`, `env.test.ts`, `start.ts`
- Modify: `tests/e2e/public-site.spec.ts`
- Docs: running notes, runbook

**Interfaces:**
- Consumes: `renderPage`, `e`, `basePath` (6c-1); `MinistryDto`; `categoryPageId`.
- Produces: page id `search` (`pageFiles` → `["search/index.html"]`, `pageUrl` → `<base>/search/`); `renderSearchPage(ministries: MinistryDto[], site: SiteInfo, opts: PageOptions, apiBase: string): string`; `SEARCH_SCRIPT: string`; env `SEARCH_API_URL` (optional URL); `createSiteBuilder` deps gain `searchApiBase?: string` (`""`, same origin, when unset).

- [ ] **Step 1: Write the failing tests**

`pages/search.test.ts`:

```ts
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { expectAccessibleStructure } from "../../test/structure";
import { ministry, site } from "../../test/fixtures";
import { renderSearchPage } from "./search";

const page = (apiBase = "") => renderSearchPage([ministry({ key: "health", name: "Health & <Care>" }), ministry({ key: "gone", name: "Gone", isActive: false })], { ...site, baseUrl: "https://boxs.example/site" }, {}, apiBase);

describe("search page", () => {
  it("is accessible: a labelled search form, one h1, live regions, a noscript fallback", () => {
    const doc = expectAccessibleStructure(page());
    expect(doc.querySelector("h1")?.textContent).toBe("Search news");
    const form = doc.querySelector('form[role="search"]')!;
    expect(form.getAttribute("action")).toBe("/site/search/");
    expect(form.querySelector('label[for="q"]')?.textContent).toBe("Search for");
    expect(form.querySelector("#q")?.getAttribute("maxlength")).toBe("200");
    expect([...form.querySelectorAll("#ministry option")].map((o) => o.textContent)).toEqual(["All ministries", "Health & <Care>"]);
    expect(doc.querySelector('[role="status"]')).not.toBeNull();
    expect(doc.querySelector('[role="alert"]')).not.toBeNull();
    expect(doc.querySelector("noscript")?.innerHTML).toContain("/site/archive/");
  });

  it("escapes ministry names and the API base", () => {
    expect(page('https://api.example/"x')).toContain('data-api-base="https://api.example/&quot;x"');
    expect(page()).toContain("Health &amp; &lt;Care&gt;");
  });

  it("the script fetches /api/v2/search and builds results with text only", async () => {
    const dom = new JSDOM(page(), { url: "https://boxs.example/site/search/?q=clinic%20%3Cb%3E&ministry=health&page=2", runScripts: "dangerously" });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ mode: "text", page: 2, total: 41, results: [{ key: "K1", kind: "releases", headline: "<img src=x onerror=alert(1)>", summary: "S", publishDate: "2026-10-03T10:00:00-07:00", leadMinistryKey: "health", url: "https://evil.example/" }] }), { status: 200 }));
    dom.window.fetch = fetchMock as unknown as typeof fetch;
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
    await vi.waitFor(() => expect(dom.window.document.querySelector("#results li")).not.toBeNull());
    expect(fetchMock.mock.calls[0]![0]).toBe("https://boxs.example/api/v2/search?q=clinic+%3Cb%3E&ministry=health&page=2");
    const link = dom.window.document.querySelector("#results li a")!;
    expect(link.getAttribute("href")).toBe("/site/releases/K1/");
    expect(link.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(dom.window.document.querySelector("#results img")).toBeNull();
    expect(dom.window.document.querySelector('[role="status"]')?.textContent).toBe("Results 21 to 21 of 41.");
    expect(dom.window.document.querySelector('nav[aria-label="Search results pages"] a[rel="prev"]')?.getAttribute("href")).toContain("page=1");
    expect((dom.window.document.querySelector("#q") as HTMLInputElement).value).toBe("clinic <b>");
  });

  it.each([
    [400, "Enter between 1 and 200 characters to search."],
    [429, "Too many searches. Wait a minute and try again."],
    [500, "Search isn't available right now. You can browse the archive instead."],
  ])("a %i answer shows a message in the alert region", async (status, message) => {
    const dom = new JSDOM(page(), { url: "https://boxs.example/site/search/?q=x", runScripts: "dangerously" });
    dom.window.fetch = (async () => new Response("{}", { status })) as unknown as typeof fetch;
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
    await vi.waitFor(() => expect(dom.window.document.querySelector('[role="alert"]')?.textContent).toBe(message));
  });

  it("no query: no request", () => {
    const dom = new JSDOM(page(), { url: "https://boxs.example/site/search/", runScripts: "dangerously" });
    const fetchMock = vi.fn();
    dom.window.fetch = fetchMock as unknown as typeof fetch;
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

Also: `site-paths.test.ts` gains `["search", ["search/index.html"]]`; `change-feed.test.ts`'s ministry row gains `{ pageId: "search", priority: 1 }` (the ministry list in the filter); `builder.test.ts` "buildAll …" expects `search/index.html`, and `sitemaps/pages.xml` lists `/search/`; `rebuild-all.test.ts`'s live list gains `"search"`.

Run: FAIL.

- [ ] **Step 2: Implement**

`pages/search.ts` — the page body:

```ts
export function renderSearchPage(ministries: MinistryDto[], site: SiteInfo, opts: PageOptions, apiBase: string): string {
  const base = basePath(site);
  const options = ministries
    .filter((m) => m.isActive && categoryPageId("ministries", m.key))
    .map((m) => `<option value="${e(m.key.toLowerCase())}">${e(m.name)}</option>`)
    .join("\n");
  const body = `<h1>Search news</h1>
<form role="search" action="${e(base)}/search/" method="get" id="search-form" data-api-base="${e(apiBase)}" data-site-base="${e(base)}">
<p><label for="q">Search for</label><br><input type="search" id="q" name="q" maxlength="200" required></p>
<p><label for="ministry">Ministry</label><br><select id="ministry" name="ministry"><option value="">All ministries</option>
${options}
</select></p>
<p><button type="submit">Search</button></p>
</form>
<noscript><p>Search needs JavaScript. You can <a href="${e(base)}/archive/">browse the archive by month</a> or <a href="${e(base)}/ministries/">news by ministry</a> instead.</p></noscript>
<div id="search-status" role="status"></div>
<div id="search-alert" role="alert"></div>
<h2 id="results-heading" hidden>Results</h2>
<ol id="results" aria-labelledby="results-heading"></ol>
<div id="pages"></div>
<script>${SEARCH_SCRIPT}</script>`;
  return renderPage("Search news", site, `${base}/search/`, body, opts);
}
```

`SEARCH_SCRIPT` (one inline script; `textContent` and `createElement` only; no `innerHTML`; runs on `DOMContentLoaded` or immediately if the document is already parsed):

```js
(() => {
  const run = () => {
    const form = document.getElementById("search-form");
    const params = new URLSearchParams(location.search);
    const q = (params.get("q") || "").trim();
    const ministry = params.get("ministry") || "";
    const sector = params.get("sector") || "";
    const page = Math.max(1, Math.min(50, parseInt(params.get("page") || "1", 10) || 1));
    const status = document.getElementById("search-status");
    const alertEl = document.getElementById("search-alert");
    const list = document.getElementById("results");
    const heading = document.getElementById("results-heading");
    const pages = document.getElementById("pages");
    const siteBase = form.dataset.siteBase;
    const apiBase = form.dataset.apiBase || location.origin;
    document.getElementById("q").value = q;
    document.getElementById("ministry").value = ministry;
    if (!q) return;
    const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const date = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ""); return m ? MONTHS[+m[2] - 1] + " " + (+m[3]) + ", " + m[1] : ""; };
    const query = new URLSearchParams({ q });
    if (ministry) query.set("ministry", ministry);
    if (sector) query.set("sector", sector);
    query.set("page", String(page));
    status.textContent = "Searching…";
    fetch(apiBase.replace(/\/+$/, "") + "/api/v2/search?" + query.toString())
      .then((r) => {
        if (r.status === 400) throw new Error("Enter between 1 and 200 characters to search.");
        if (r.status === 429) throw new Error("Too many searches. Wait a minute and try again.");
        if (!r.ok) throw new Error("Search isn't available right now. You can browse the archive instead.");
        return r.json();
      })
      .then((data) => {
        const results = Array.isArray(data.results) ? data.results : [];
        const total = Number(data.total) || 0;
        heading.hidden = false;
        if (results.length === 0) { status.textContent = "No results."; return; }
        const first = (page - 1) * 20 + 1;
        status.textContent = "Results " + first + " to " + (first + results.length - 1) + " of " + total + ".";
        for (const r of results) {
          const li = document.createElement("li");
          const a = document.createElement("a");
          a.href = siteBase + "/releases/" + encodeURIComponent(String(r.key)) + "/";
          a.textContent = String(r.headline || r.key);
          li.appendChild(a);
          const t = document.createElement("time");
          t.dateTime = String(r.publishDate || "");
          t.textContent = " " + date(r.publishDate);
          li.appendChild(t);
          if (r.summary) { const p = document.createElement("p"); p.textContent = String(r.summary); li.appendChild(p); }
          list.appendChild(li);
        }
        const nav = document.createElement("nav");
        nav.setAttribute("aria-label", "Search results pages");
        const link = (n, rel, text) => { const p = new URLSearchParams(location.search); p.set("page", String(n)); const a = document.createElement("a"); a.href = "?" + p.toString(); a.rel = rel; a.textContent = text; nav.appendChild(a); nav.appendChild(document.createTextNode(" ")); };
        if (page > 1) link(page - 1, "prev", "Previous page");
        if (first + results.length - 1 < total && page < 50) link(page + 1, "next", "Next page");
        if (nav.childNodes.length) pages.appendChild(nav);
      })
      .catch((err) => { status.textContent = ""; alertEl.textContent = err instanceof Error && err.message ? err.message : "Search isn't available right now. You can browse the archive instead."; });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run); else run();
})();
```

(A network failure's `TypeError` message would leak into the alert; the `catch` should show the fixed sentence unless the error came from one of the three `throw new Error(…)` lines. Implement by throwing a tagged `{ userMessage }` object instead of `Error` and checking for it.)

The test's first URL expects `location.origin` + `/api/v2/search` when `SEARCH_API_URL` is unset: on boxs.ca the site is at `/site` and the API at the root of the same origin.

Builder: `case "search": await storage.write("search/index.html", renderSearchPage(await ministries(run), site, opts, deps.searchApiBase ?? "")); return [];` (`createSiteBuilder` deps gain an optional `searchApiBase?: string`, so the `site:rebuild-all` CLI, which never renders, needn't pass it); `aggregatePageIds()` and `FIRST` in `rebuild-all.ts` include `"search"`; `sitemap:pages` lists `pageUrl(site, { type: "search" })`; `pagesForChange` adds `search` for a ministry change. `env.ts`: `SEARCH_API_URL: z.string().url().optional()`; `start.ts` passes `parsed.SEARCH_API_URL ?? ""`.

- [ ] **Step 3: E2E**

Add to `tests/e2e/public-site.spec.ts`:

```ts
test("the search page finds a just-published release", async ({ page }) => {
  const cookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
  const word = `zebrafinch${Date.now().toString(36)}`;
  const published = await createApprovedAndPublished(cookie, { headline: `Search check ${word}` });
  await page.goto(`${baseUrl()}/site/search/?q=${word}`);
  await expect(page.getByRole("status")).toContainText("Results 1 to 1 of 1.");
  await expect(page.getByRole("link", { name: new RegExp(word) })).toHaveAttribute("href", `/site/releases/${published.key}/`);
  await page.getByRole("link", { name: new RegExp(word) }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(word);
});
```

(If `createPublishableRelease`'s `headline` override is shadowed by the helper's own suffix, search for the suffix-free word anyway: the helper appends to `sampleCreate.headline` only when `headline` isn't overridden — check `playwright-support.ts` and adjust.)

Run the public-site tests and the spec: PASS.

- [ ] **Step 4: Docs and commit**

Running notes: `- **Viewer** — The site's Search page searches every published post, optionally within one ministry. Ministry and sector pages link to it. Without JavaScript it points to the archive instead.` Runbook `### Search page`: `SITE_SEARCH_API_URL` (unset on the stack: same origin), Q81 for split hosts, the 30-per-minute-per-IP limit on `/api/v2/search` (6b) and what a visitor sees when it's hit.

```bash
git add apps/public-site tests/e2e/public-site.spec.ts docs
git commit -m "public-site: static search page over /api/v2/search"
```

---

### Task 4: NRMS sends carousel images as URLs

**Review:** full (carousel URL serving; retiring the event-size budget).

**Files:**
- Create: `apps/nrms/src/website/slide-images.ts`, `slide-images.test.ts`
- Modify: `packages/events/src/catalogue.ts` and its test
- Modify: `apps/nrms/src/website/events.ts`, `carousel.ts`, `carousel.test.ts`, `apps/nrms/src/http/site-routes.ts`, `site-routes.test.ts`, `apps/nrms/src/start.ts`
- Modify: any test that asserts the 700 KB refusal (`grep -rn "too large together\|SLIDES_EVENT_BUDGET_BYTES" apps tests`)

**Interfaces:**
- Consumes: `ObjectStore`, `localStore` from `@gcpe/storage`; `checkImageBytes` (already in `carousel.ts`: returns `"image/png" | "image/jpeg"`).
- Produces:
  - `catalogue.ts`: `slideRecordSchema` gains `imageUrl: z.string().nullable().default(null)`, `imageKey: z.string().regex(SLIDE_IMAGE_KEY).nullable().default(null)`, `imageSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null)`; exported `SLIDE_IMAGE_KEY = /^slides\/[0-9a-f]{64}\.(png|jpg)$/`.
  - `slide-images.ts`: `interface SlideImageFiles { store: ObjectStore; filesBase: string }`; `slideImageRef(files: SlideImageFiles, bytes: Buffer, mimeType: string): { imageKey: string; imageUrl: string; imageSha256: string }`; `publishSlideImage(files: SlideImageFiles, bytes: Buffer, mimeType: string): Promise<void>`; `ensureSlideImageFiles(db: DbOrTx, files: SlideImageFiles): Promise<number>`.
  - `events.ts`: `emitSite(tx, subscribers, which, files?: SlideImageFiles)` (throws when `which === "slides"` and `files` is missing); `slidesSnapshot(tx, files)`, `slidesSnapshotFor(tx, carouselId, files)`.
  - `carousel.ts`: `saveCarousel`, `setSlideImage`, `setPinImage`, `makeNextLive`, `switchCarousels`, `savePin`, `setPinned` and `startSiteLoop` take `files: SlideImageFiles` as their last parameter (`startSiteLoop`'s options object gains `files`). `SLIDES_EVENT_BUDGET_BYTES`, `assertSlidesFit` and `slidesEventBytes` are deleted.
  - `SiteRouteDeps.slideFiles: SlideImageFiles`.

- [ ] **Step 1: Write the failing tests**

`slide-images.test.ts` (real `localStore` in a temp dir; real NRMS test database for the backfill):

```ts
it("slideImageRef: a content-addressed key, the public URL and the hash", () => {
  const bytes = Buffer.from("png-bytes");
  const sha = createHash("sha256").update(bytes).digest("hex");
  expect(slideImageRef({ store, filesBase: "https://boxs.example" }, bytes, "image/png")).toEqual({ imageKey: `slides/${sha}.png`, imageUrl: `https://boxs.example/files/slides/${sha}.png`, imageSha256: sha });
  expect(slideImageRef({ store, filesBase: "" }, bytes, "image/jpeg").imageUrl).toBe(`/files/slides/${sha}.jpg`);
});
it("refuses a type that isn't PNG or JPEG", () => {
  expect(() => slideImageRef({ store, filesBase: "" }, Buffer.from("x"), "image/gif")).toThrow();
});
it("publishSlideImage writes the bytes once under that key", async () => {
  await publishSlideImage(files, ONE_PX_PNG, "image/png");
  const { imageKey } = slideImageRef(files, ONE_PX_PNG, "image/png");
  expect((await store.get(imageKey))!.bytes.equals(ONE_PX_PNG)).toBe(true);
});
it("ensureSlideImageFiles writes a file for every stored slide and pin image that lacks one, and nothing twice", async () => {
  // insert a carousel with two slides (one with an image), set the primary pin's image directly in the DB
  expect(await ensureSlideImageFiles(tdb.db, files)).toBe(2);
  expect(await ensureSlideImageFiles(tdb.db, files)).toBe(0);
});
```

In `carousel.test.ts`, replace the budget tests (the ones using `SLIDES_EVENT_BUDGET_BYTES`/`bigEnoughAlone`/`oversized`) with:
- "ten 2 MB slide images save, and the slides event stays small": set ten slides' images of `MAX_SITE_IMAGE_BYTES` bytes (valid PNG header + padding, as the old test built them) on the live carousel; each save succeeds; the newest `site.content.changed` `slides` envelope in `outbox_events` is under 10 KB; every slide record has `imageBase64: null` and an `imageUrl` ending `/files/slides/<sha>.png`; the file exists in the store.
- "two slides with the same image share one file" (same bytes → same `imageKey`; `store.list("slides/")` has one entry).
- "switching carousels emits URLs for the new live carousel's images" (`switchCarousels(db, subs, files, …)`).

In `packages/events`' catalogue test: an envelope without the three new fields still parses (defaults `null`); a bad `imageKey` (`slides/../x.png`) or `imageSha256` (`XYZ`) is refused.

Run: FAIL.

- [ ] **Step 2: Implement**

`slide-images.ts`:

```ts
import { createHash } from "node:crypto";
import { isNotNull } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import type { ObjectStore } from "@gcpe/storage";
import { emergencyPins, websiteSlides } from "../db/schema";

/** spec §6.4: slide images are served from NRMS's public file store under content-addressed keys. */
export interface SlideImageFiles {
  store: ObjectStore;
  /** NRMS's PUBLIC_FILES_BASE (no trailing slash; "" for same-origin paths), as release files use. */
  filesBase: string;
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg" };

export function slideImageRef(files: SlideImageFiles, bytes: Buffer, mimeType: string): { imageKey: string; imageUrl: string; imageSha256: string } {
  const ext = EXT[mimeType];
  if (!ext) throw new Error(`unsupported slide image type ${mimeType}`);
  const imageSha256 = createHash("sha256").update(bytes).digest("hex");
  const imageKey = `slides/${imageSha256}.${ext}`;
  return { imageKey, imageUrl: `${files.filesBase}${files.store.publicPath(imageKey)}`, imageSha256 };
}

export async function publishSlideImage(files: SlideImageFiles, bytes: Buffer, mimeType: string): Promise<void> {
  const { imageKey } = slideImageRef(files, bytes, mimeType);
  await files.store.put(imageKey, bytes, mimeType);
}

/** Writes the file for every stored slide and pin image that has none yet. Returns how many. */
export async function ensureSlideImageFiles(db: DbOrTx, files: SlideImageFiles): Promise<number> {
  const have = new Set((await files.store.list("slides/")).map((o) => o.key));
  const rows = [
    ...(await db.select({ image: websiteSlides.image, imageType: websiteSlides.imageType }).from(websiteSlides).where(isNotNull(websiteSlides.image))),
    ...(await db.select({ image: emergencyPins.image, imageType: emergencyPins.imageType }).from(emergencyPins).where(isNotNull(emergencyPins.image))),
  ];
  let written = 0;
  for (const r of rows) {
    if (!r.image || !r.imageType || !EXT[r.imageType]) continue;
    const { imageKey } = slideImageRef(files, r.image, r.imageType);
    if (have.has(imageKey)) continue;
    await files.store.put(imageKey, r.image, r.imageType);
    have.add(imageKey);
    written++;
  }
  return written;
}
```

(Check `localStore.list(prefix)`'s returned `key` format against `packages/storage/src/local.ts` — the tests pin it.)

`events.ts`: `toSlideRecord(s, files)` sets `imageBase64: null` and spreads `s.image && s.imageType ? slideImageRef(files, s.image, s.imageType) : { imageKey: null, imageUrl: null, imageSha256: null }`; thread `files` through `pinnedSlides`, `slidesSnapshotFor`, `slidesSnapshot` and `emitSite` (throw `new Error("emitSite(\"slides\") needs the slide image files")` when absent).

`carousel.ts`: delete `SLIDES_EVENT_BUDGET_BYTES`, `slidesEventBytes`, `assertSlidesFit` and each call to it (and the now-unused imports `envelopeByteLength`, `MAX_EVENT_BYTES`, `sizingEnvelope`; keep `EventTooLargeError` only if `switchCarousels` still uses it — its comment's "I4 backstop" text goes, the catch stays as a plain guard). In `setSlideImage` and `setPinImage`, call `await publishSlideImage(files, bytes, mimeType)` after `checkImageBytes` and before the transaction (the file must exist before any event names it; a rolled-back transaction leaves a harmless orphan). Add the `files` parameter to the seven functions and pass it to every `emitSite(tx, subs, "slides", files)`.

`site-routes.ts`: `SiteRouteDeps.slideFiles`; pass it to those calls. `start.ts`: `const slideFiles = { store, filesBase };` → `siteRoutes`, `switchCarousels(db, subscribers, slideFiles)`, `startSiteLoop({ db, subscribers, files: slideFiles, … })`; once at startup, after migrations: `const n = await ensureSlideImageFiles(db, slideFiles); if (n) console.log(\`[nrms] published ${n} slide image files\`);`.

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nrms packages/events` — PASS. `tsc` — clean.

Note: until Task 5 lands, the News API would store `image: null` for new slide events (it reads `imageBase64` only). Don't deploy between Task 4 and Task 5.

- [ ] **Step 3: Commit**

```bash
git add packages/events apps/nrms
git commit -m "nrms: slide events carry content-addressed image URLs; the carousel image budget is retired (C42)"
```

---

### Task 5: The News API keeps v1 slide bytes from those URLs; the site shows slide images and the emergency banner

**Review:** full (carousel URL serving; a network fetch inside a projection; v1 must not change).

**Files:**
- Create: `apps/news-api/src/slide-images.ts`, `slide-images.test.ts`, `apps/news-api/src/http/v2/slides.test.ts`
- Modify: `apps/news-api/src/db/schema.ts`; generate the migration
- Modify: `apps/news-api/src/projections.ts`, `projections.test.ts`, `app.ts`, `start.ts`, `env.ts`, `env.test.ts`, `read.ts`, `http/v2/routes.ts`
- Modify: `apps/stack/src/env.ts`, `apps/stack/src/env.test.ts` (`STACK_APP_DEFAULTS.NEWSAPI.SLIDE_IMAGES_FETCH_BASE`)
- Modify: `apps/public-site/src/news-api-client.ts`, `dto.ts`, `builder.ts`, `pages/home.ts`, `pages/home.test.ts`, `test/fake-news-api.ts`
- Docs: running notes, runbook, `changes-from-legacy.md` (C42, C204, C208), `open-questions.md` (Q85)

**Interfaces:**
- Consumes: Task 4's record fields and `SLIDE_IMAGE_KEY`.
- Produces:
  - `slide-images.ts` (News API): `SLIDE_IMAGE_MAX_BYTES = 2 * 1024 * 1024`; `interface SlideImageFetcher { fetch(s: { imageUrl: string | null; imageKey: string | null; imageSha256: string | null }): Promise<Buffer> }`; `slideImageFetcher(opts: { fetchBase?: string; fetchImpl?: typeof fetch; timeoutMs?: number }): SlideImageFetcher`; `class SlideImageError extends Error`.
  - `applySiteContent(tx: Tx, c: SiteContentChanged, slideImages?: SlideImageFetcher): Promise<void>`; `ProjectionOptions.slideImages?: SlideImageFetcher`; `AppDeps.slideImages?`.
  - `schema.ts`: `slides.imageUrl`, `slides.imageKey`, `slides.imageSha256` (nullable text).
  - `read.ts`: `listSlidesV2(db): Promise<{ id: string; sortIndex: number; emergency: boolean; headline: string | null; summary: string | null; actionUri: string | null; actionLabel: string | null; imageUrl: string | null; justify: string | null }[]>`; route `GET /api/v2/slides` → `{ slides: [...] }`, `no-store`, public.
  - env `SLIDE_IMAGES_FETCH_BASE` (optional URL).
  - Public site: `NewsApiClient.slides(): Promise<SlideDto[]>` now reads `/api/v2/slides`; `SlideDto` gains `emergency: boolean`, `imageUrl: string | null`.

- [ ] **Step 1: Write the failing tests**

`apps/news-api/src/slide-images.test.ts`:

```ts
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(100)]);
const sha = createHash("sha256").update(png).digest("hex");
const ref = { imageUrl: `https://files.example/files/slides/${sha}.png`, imageKey: `slides/${sha}.png`, imageSha256: sha };

it("fetches imageUrl and returns the bytes when the hash matches", async () => {
  const f = vi.fn(async () => new Response(png));
  expect((await slideImageFetcher({ fetchImpl: f as unknown as typeof fetch }).fetch(ref)).equals(png)).toBe(true);
  expect(f.mock.calls[0]![0].toString()).toBe(ref.imageUrl);
});
it("joins fetchBase and imageKey when a fetch base is set", async () => {
  const f = vi.fn(async () => new Response(png));
  await slideImageFetcher({ fetchBase: "http://stack.internal/files/", fetchImpl: f as unknown as typeof fetch }).fetch(ref);
  expect(f.mock.calls[0]![0].toString()).toBe(`http://stack.internal/files/slides/${sha}.png`);
});
it.each([
  ["a different hash", async () => new Response(Buffer.from("other"))],
  ["a 404", async () => new Response("nope", { status: 404 })],
  ["a body over 2 MB", async () => new Response(Buffer.alloc(2 * 1024 * 1024 + 1))],
  ["a declared length over 2 MB", async () => new Response(png, { headers: { "content-length": String(3 * 1024 * 1024) } })],
])("refuses %s", async (_name, impl) => {
  await expect(slideImageFetcher({ fetchImpl: impl as unknown as typeof fetch }).fetch(ref)).rejects.toBeInstanceOf(SlideImageError);
});
it("refuses an imageKey outside slides/ before fetching", async () => {
  const f = vi.fn();
  await expect(slideImageFetcher({ fetchBase: "http://x/files", fetchImpl: f as unknown as typeof fetch }).fetch({ ...ref, imageKey: "../etc/passwd" })).rejects.toBeInstanceOf(SlideImageError);
  expect(f).not.toHaveBeenCalled();
});
```

`projections.test.ts` (inside the existing describe, with the real test database):
- "a slides event with URLs stores the fetched bytes, so v1 /api/Slides is unchanged": apply a `site.content.changed` `slides` event whose slide has `imageBase64: null` + `ref`, through `createProjectionHandlers({ slideImages: fakeFetcher(png) })`; `GET /api/Slides?api-version=1.0` returns `image` = `png.toString("base64")` and `imageType: "image/png"` — the exact v1 shape the compat suite records;
- "a fetch failure fails the projection and changes no slide": the existing slides stay; the handler rejects;
- "an old envelope with base64 still works without a fetcher";
- "a URL slide without a fetcher configured fails loudly".

`http/v2/slides.test.ts`: `GET /api/v2/slides` → `200`, `Cache-Control: no-store`, slides ordered by `sortIndex`, `emergency` true for negative `sortIndex`, `imageUrl` as stored, no `image` bytes in the body.

Public site `pages/home.test.ts`: with an emergency slide and a normal slide, the page has `section[aria-labelledby="emergency-heading"]` (`h2` "Emergency information") before "Highlights"; slide images render as `<img src="<imageUrl>" alt="">` (decorative: the headline beside it says the same; §6.3); a slide without `imageUrl` has no `img`; still no `<script>`; `expectAccessibleStructure` passes.

Run: FAIL.

- [ ] **Step 2: Implement the News API side**

Schema: add to `slides`: `imageUrl: text("image_url")`, `imageKey: text("image_key")`, `imageSha256: text("image_sha256")`. Generate: `cd apps/news-api && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name slide_image_urls` — expect three `ALTER TABLE "slides" ADD COLUMN …` statements only.

`slide-images.ts`:

```ts
import { createHash } from "node:crypto";

export const SLIDE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const KEY = /^slides\/[0-9a-f]{64}\.(png|jpg)$/;

export class SlideImageError extends Error {}

export interface SlideImageFetcher {
  fetch(s: { imageUrl: string | null; imageKey: string | null; imageSha256: string | null }): Promise<Buffer>;
}

/**
 * spec §6.4 with v1 kept: the bytes behind a slide event's URL, checked against its SHA-256.
 * fetchBase (the stack: self:/files) replaces the public origin, which SiteGround can't loop back to.
 */
export function slideImageFetcher(opts: { fetchBase?: string; fetchImpl?: typeof fetch; timeoutMs?: number }): SlideImageFetcher {
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async fetch(s) {
      if (!s.imageSha256 || !s.imageKey || !KEY.test(s.imageKey)) throw new SlideImageError("slide image reference is incomplete");
      const url = opts.fetchBase ? `${opts.fetchBase.replace(/\/+$/, "")}/${s.imageKey}` : s.imageUrl;
      if (!url) throw new SlideImageError("slide image has no URL");
      const res = await doFetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000) });
      if (!res.ok) throw new SlideImageError(`slide image fetch failed: HTTP ${res.status}`);
      if (Number(res.headers.get("content-length") ?? 0) > SLIDE_IMAGE_MAX_BYTES) throw new SlideImageError("slide image too large");
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > SLIDE_IMAGE_MAX_BYTES) throw new SlideImageError("slide image too large");
      if (createHash("sha256").update(bytes).digest("hex") !== s.imageSha256) throw new SlideImageError("slide image does not match its hash");
      return bytes;
    },
  };
}
```

(`arrayBuffer()` reads the whole body before the size check; the content-length check catches honest servers first, and NRMS's file store is the only source. Note this in the review rather than streaming.)

`projections.ts`, `case "slides"`: before `tx.delete(slides)`, resolve each slide's bytes:

```ts
const rows = [];
for (const s of c.slides) {
  let image: Buffer | null = null;
  if (s.imageBase64 !== null) image = Buffer.from(s.imageBase64, "base64");
  else if (s.imageKey !== null) {
    if (!slideImages) throw new Error("slide images need a fetcher (SLIDE_IMAGES_FETCH_BASE / slideImages)");
    image = await slideImages.fetch(s);
  }
  rows.push({ id: s.id, sortIndex: s.sortIndex, headline: s.headline, summary: s.summary, actionLabel: s.actionLabel, actionUri: s.actionUri, image, imageType: s.imageType, imageUrl: s.imageUrl, imageKey: s.imageKey, imageSha256: s.imageSha256, facebookPostUri: s.facebookPostUri, justify: s.justify, timestamp: parseOffsetDateTime(s.timestamp) });
}
```

then the existing delete/insert with `rows`. Fetching first means a failure throws before any write. Thread `slideImages` from `ProjectionOptions` → `createProjectionHandlers` → the `"site.content.changed"` handler, and `AppDeps.slideImages` → `createSourceRestrictedHandlers`. `toSlideDto` and v1 routes are untouched.

`env.ts`: `SLIDE_IMAGES_FETCH_BASE: z.string().url().optional()`. `start.ts`: `slideImages: slideImageFetcher({ fetchBase: parsed.SLIDE_IMAGES_FETCH_BASE })`. `apps/stack/src/env.ts`: `NEWSAPI: { NOD_BASE_URL: "self:/nod", SLIDE_IMAGES_FETCH_BASE: "self:/files" }` with a one-line comment (SiteGround can't loop back to its public origin; NRMS's file store is mounted at /files in this same process). `env.test.ts` in the stack: the News API's view resolves it to `http://stack.internal/files`.

`read.ts` + `http/v2/routes.ts`: `listSlidesV2` (ordered by `sortIndex`) and `r.get("/slides", …)` → `{ slides }` (the v2 router already sets `no-store`).

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/news-api apps/stack` — PASS, including `apps/news-api/test/compat.test.ts`, `test/e2e-core.test.ts`, `src/http/v1/*.test.ts` and `src/app.test.ts` unedited.

- [ ] **Step 3: Implement the public site side**

`news-api-client.ts`: `slides: async () => (((await get("api/v2/slides")) as { slides: SlideDto[] } | null)?.slides ?? [])`. `dto.ts`: `SlideDto` gains `emergency: boolean`, `imageUrl: string | null`, `sortIndex: number`. `pages/home.ts`: emergency slides (`emergency: true`) in their own region first, the rest under "Highlights"; each with `<img src="${e(s.imageUrl)}" alt="" loading="lazy" width…>` when `imageUrl` is set (no width/height known: omit them; the CSS keeps it fluid). Update `test/fake-news-api.ts`.

Run the public-site tests: PASS.

- [ ] **Step 4: End-to-end through the stack**

Run: `npx -y -p node@24 -- node node_modules/@playwright/test/cli.js test tests/e2e/website.spec.ts tests/e2e/axe-sweep.spec.ts tests/e2e/public-site.spec.ts`. If `website.spec.ts` asserted the 700 KB refusal, replace that check with: upload a slide image on the live carousel, tick twice, then `/api/Slides?api-version=1.0`'s slide `image` equals the uploaded bytes in base64, and `/site/` has an `img` whose `src` ends `/files/slides/<sha>.png` and that URL answers 200.

- [ ] **Step 5: Docs and parity**

`changes-from-legacy.md`: C42's status → **Reversed**, with its "New" column appended: `(Reversed in 6c: slide events carry image URLs, so there is no combined size limit; each image keeps NRMS's 2 MB upload limit.)`; C204 unchanged (it already says "Slide events carry image URLs"); add `| C208 | — | The platform's site shows pinned emergency slides in an "Emergency information" region at the top of the home page, above the other slides. | §6.1's "emergency banner"; v2 slides say which slides are pinned. | Proposed |`

`open-questions.md`: `| Q85 | In a standalone deployment, can the News API reach NRMS's public file URLs (PUBLIC_FILES_BASE) to fetch slide images? | The News API keeps v1 /api/Slides byte-identical by fetching each new slide image once; if it can't reach the URL, slide changes retry until it can. | Yes, or NEWSAPI_SLIDE_IMAGES_FETCH_BASE points at an internal route to the same files (the stack uses self:/files). | 2026-10-11 |`

Running notes: `- **Site editor** — Carousel images no longer have a combined size limit (each image is still limited to 2 MB). Pinned emergency slides show at the top of the platform site's home page.` Runbook `### Carousel images`: where the files live (`<NRMS STORAGE_DIR>/slides/<sha>.<ext>`, served at `/files/slides/…`), the startup backfill line in the log, `NEWSAPI_SLIDE_IMAGES_FETCH_BASE`, and what a stuck slide event looks like (`nrms` outbox retries; `/stack/errors` shows `SlideImageError`).

Run the duplicate checks (Global Constraints).

- [ ] **Step 6: Full check and commit**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run` (everything) and `tsc`. Expected: PASS, clean.

```bash
git add apps packages docs tests
git commit -m "news-api: keep v1 slide bytes by fetching event image URLs; public site shows slide images and the emergency region"
```

---

## Deploy (after the 6c-2 final review)

Deploy to boxs.ca. On the first start: the public site's migration adds `rebuild_queue` and `site_state`; the first `site.sync` fast-forwards the cursor and queues a full rebuild (watch `SELECT priority, count(*) FROM rebuild_queue GROUP BY 1` fall to zero over a few ticks); NRMS logs how many slide image files it published. Then: publish a release and see it on `/site/` after one tick; `/site/search/?q=<a word from it>` finds it; change a carousel image and see `/api/Slides?api-version=1.0` still return base64 and `/site/` show the image by URL.
