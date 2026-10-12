# Phase 6c-1: The Public Site — Theme, Page Types, Archives, Feeds and Sitemaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `apps/public-site` from a two-template builder (home and release) into the platform's complete, accessible default public site: a theme generated from tenant config, every §6.1 page type, monthly archives, RSS feeds, sitemaps, `robots.txt` and `404.html`. It also keeps a small local index of the posts it has rendered, so every change to a post rebuilds exactly the pages that list it, before and after the change.

**Architecture:**
- **Templates stay hand-written functions** (D5). `render.ts` keeps `renderPage` (the page chrome) and gains the skip link, landmarks, nav, footer and theme link. Each page type is a pure function in `src/pages/*.ts` from DTOs to an HTML string. Every interpolated value goes through `escapeHtml`. The only raw HTML is the release body and the minister's biography, both staff-authored in NRMS, as today.
- **A local post index (`site_posts`) in the public site's own database** records, for each post page on disk, its headline, date, month and category keys. Archives and sitemaps are rendered from it (the News API has no by-month query), and the **rebuild-set function** `dependentPages(before, after)` uses the index row from *before* a change and the News API's post *after* it. A post that moves ministry or month therefore rebuilds both the old and the new pages, and an unpublished post (which the News API no longer returns) still rebuilds every page that listed it.
- **Page ids are the unit of work.** `site-paths.ts` parses a page id (`home`, `post:<key>`, `category:<kind>:<key>`, `archive:<yyyy-mm>`, …) into a typed value, validating every key, and maps it to the relative output files. Nothing else builds an output path. The builder (`builder.ts`) renders one page id and returns the ids that now depend on it.
- **In 6c-1 the rebuild runs synchronously**, inside the existing `site.rebuild_requested` handler and the startup self-heal. A post change renders the post page, then its dependents. A chrome change (Blue Bridge, test flag, `RENDER_CHROME_VERSION`, base URL) runs `buildAll`: every published key from the News API, then every aggregate page. 6c-2 moves both onto a persistent queue and the change feed; the builder's interface doesn't change.

**Tech Stack:** Node 24, TypeScript 5.9, Express 5, Drizzle 0.45 / drizzle-kit 0.31 on Postgres 14, zod 3.25, Vitest 4.1, jsdom 30.1.2 (dev, for structure tests), Playwright 1.63 (E2E).

**Spec:** `docs/superpowers/specs/2026-10-11-public-site-ai-design.md` (the Phase 6 addendum):
- §6.1 (every page type, feeds, sitemap, `robots.txt`, `404.html`);
- §6.2 (the rebuild set; the queue, the cursor and the change feed are 6c-2);
- §6.3 (theme and accessibility);
- §9's 6c lines: the rebuild-set unit tests, and the E2E "publish → release, ministry, archive, home and feed pages exist; unpublishing removes the release page and its entries".
- Paul's decisions D1 (the static site is the product's default; no legacy redirects), D3 (neutral, accessible, branded from tenant config) and D5 (extend the existing template functions; no templating engine, no SSG).

**Companion plan:** `docs/superpowers/plans/2026-10-11-phase-6c2-public-site-rebuild.md` (the rebuild queue, the change-feed consumer, the search page and carousel image URLs). It runs straight after this one. Each plan deploys cleanly on its own.

**Not in 6c-1:**
- the `rebuild_queue` table, the cursor, the change-feed consumer, `site:rebuild-all` and the tick step (6c-2 Tasks 1–2);
- the search page (6c-2 Task 3; the nav links to `/search/` from 6c-1, and the page appears in 6c-2);
- carousel images and the emergency banner (6c-2 Tasks 4–5: v1 `/api/Slides` can't say which slide is a pinned emergency slide, and its images are base64);
- axe-core and Lighthouse (6e). 6c keeps the HTML WCAG 2.2 AA-correct by construction and tests its structure.

---

## Decisions made in planning

Each ruling was made against the code at `ef532f5`. Spec conflicts are marked.

1. **The public site already has a database.** `apps/public-site` runs migrations (`migrations/0000_init.sql`: the event inbox and outbox tables) against `SITE_DATABASE_URL`, which `scripts/siteground-env.ts` already generates. The post index (here) and the queue and cursor (6c-2) go there, as §6.2 says. No new database, no `DATA_DIR` files.
2. **Spec gap, §6.2 "a post is published, updated or unpublished → its ministry, sector, theme and tag pages … its month's archive".** The change feed carries only the post key, and after an unpublish the News API no longer returns the post. Ruling: the public site keeps `site_posts` (one row per post page on disk: key, kind, headline, summary, BC publish date, month, categories). Each post render compares the stored row (before) with the News API's post (after), and the union of both decides the dependents. The archives and sitemaps are rendered from the same table, because v1 has no "posts in a month" query.
3. **Spec gap, §6.1 "links to monthly archives" on ministry, sector, theme and tag pages.** There is one archive (`/archive/<yyyy>/<mm>/`, every post that month); §6.2's rebuild table rebuilds only "its month's archive", so per-category archives aren't intended. Ruling: a category page links to the archive index and, for ministries and sectors (the two filters `/api/v2/search` has), to the search page with that filter (`/search/?ministry=<key>`). Q82 asks whether per-category archives are wanted.
4. **Every post kind gets a page at `/releases/<key>/`.** That is today's path for every kind (`postPath` in `rebuild.ts`), §6.1 names it, and keys are unique across kinds. Legacy uses `/releases/`, `/stories/`, `/factsheets/` and so on; D1 means nothing redirects. Recorded as C206. Home and category "latest 20" lists use v1's default kinds (releases and stories), as v1 does; the monthly archive and the sitemap list every kind.
5. **The carousel is a non-rotating list of slides** (WCAG 2.2.2: no auto-advancing content without a pause control, and no JavaScript needed). Recorded as C205. In 6c-1 slides show headline, summary and action link only; images come in 6c-2.
6. **Spec conflict, Q76's working assumption** ("6c serves BC's logo and BC Sans from the site's own assets"). An agent must not copy a government's logo into the repo while Q76 (brand and licence) is open. Ruling: the site copies whatever is under `config/site/assets/` into `<OUTPUT_DIR>/assets/`; the header shows the logo when `site.theme.logo.path` exists there, and the site name as a text wordmark otherwise. The font is linked only when `font.stylesheetUrl` is configured (§6.3); otherwise the fallback stack renders. Q76's working assumption is updated to say so; Paul adds the files once Q76 is answered.
7. **Headings in the release body.** NRMS bodies can contain `<h1>`, which would give the page two. The release template demotes body headings by one level (`h1`→`h2` … `h5`→`h6`) with a tag-name regex; the body is staff-authored HTML from NRMS's editor, so the regex only sees well-formed tags.
8. **Release pages show related posts as of their last render.** Related lists change when the News API re-embeds a post, which writes no change-feed row. A release page is re-rendered whenever its post changes, a category it's in changes (6c-2) or the chrome changes. Q83 asks whether that staleness is acceptable.
9. **A failing related-posts call never blocks a release page.** `/api/v2/posts/{key}/related` failing is logged with `safeErrorLabel` and the page renders without the section. Any other News API failure propagates (the event is retried), as today.
10. **`buildAll` is synchronous in 6c-1** and runs at startup or on an event only when the chrome marker differs. On boxs.ca (a few dozen posts) that's seconds. At BC's volume (about 100,000 posts) it would not finish in one event; 6c-2 replaces it with the queue before any large site exists. `RENDER_CHROME_VERSION` goes from 2 to 3 so every existing site rebuilds once on deploy.
11. **Category directories are lowercased.** v1 looks categories up case-insensitively; one directory per category avoids `ministries/Health/` and `ministries/health/` both existing on a case-sensitive disk. Post directories keep the requested key, as today.
12. **Inactive ministries keep their page** (their old posts still link to it) but are left out of `/ministries/`. A category the News API no longer returns (`emptyOk`) has its page and feed removed.

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

1. **A post whose ministry (or publish month) changes on update.** The old ministry page and the old month's archive must stop listing it, not only the new ones gain it. Task 2: "a post that moves ministry and month rebuilds both old and new pages"; Task 5: "an update that moves a post to another ministry takes it off the old ministry page".
2. **The last post of a month is unpublished.** Its month archive and month sitemap must disappear (not render an empty page), and the archive index and sitemap index must stop listing the month. Task 5: "unpublishing removes the release page and its entries".
3. **Hostile or odd ids and keys:** a post key `..` or `a/b`, a category key `../../etc`, `Health` vs `health`, a month `2026-13`, a page id with extra colons. Each must parse to `null` (and be skipped with a warning) or to the lowercased canonical form, never to a path outside the output folder. Task 2: the `it.each` table in `site-paths.test.ts`.
4. **A release body that contains `<h1>`** (NRMS's editor allows it). The page must still have exactly one `<h1>`. Task 3: "demotes body headings so the page keeps one h1".
5. **Text that looks like markup in places other than the headline:** a slide headline, a resource-link label, a ministry or minister name, a footer label, a feed item title, an asset label (`<script>`, `"`, `&`). Each must be escaped in HTML, RSS and sitemap XML. Task 3: "escapes every interpolated field"; Task 4: "escapes feed and sitemap text".

## File structure

**Created:**
- `apps/public-site/src/theme-css.ts`: `themeCss`, `DEFAULT_THEME`.
- `apps/public-site/src/static-pages.ts`: `renderNotFoundPage`, `renderRobots`, `writeStaticPages`.
- `apps/public-site/src/site-paths.ts`: page ids, key patterns, `parsePageId`, `formatPageId`, `pageFiles`, `pageUrl`, `feedUrl`, `absoluteUrl`.
- `apps/public-site/src/rebuild-set.ts`: `Membership`, `membershipOf`, `dependentPages`.
- `apps/public-site/src/post-index.ts`: `IndexedPost`, `PostIndex`, `postIndex`, `indexEntryOf`, `membershipOfEntry`.
- `apps/public-site/src/dto.ts`: the v1/v2 DTO types the site reads (moved out of `render.ts`, extended).
- `apps/public-site/src/pages/release.ts`, `pages/home.ts`, `pages/categories.ts`, `pages/archive.ts`, `pages/format.ts`.
- `apps/public-site/src/feeds.ts`: `renderRssFeed`.
- `apps/public-site/src/sitemaps.ts`: `renderSitemapIndex`, `renderUrlSet`.
- `apps/public-site/src/builder.ts`: `createSiteBuilder`, `SiteBuilder`.
- Tests beside each (`*.test.ts`), plus `apps/public-site/test/structure.ts` (`expectAccessibleStructure`), `apps/public-site/test/memory-storage.ts` (`memoryStorage`), `apps/public-site/test/fixtures.ts` (DTO fixtures).
- `apps/public-site/migrations/0001_site_posts.sql` and its snapshot and journal entry (generated).
- `config/site/assets/.gitkeep` (the tenant asset folder; empty until Q76 is answered).
- `tests/e2e/public-site.spec.ts`.

**Modified:**
- `apps/public-site/src/render.ts`: `SiteInfo`, `PageOptions`, `renderPage` chrome; the old `renderPostPage`/`renderHomePage` move to `pages/`.
- `apps/public-site/src/storage.ts`: `write` accepts `string | Uint8Array`.
- `apps/public-site/src/news-api-client.ts`: the v1 and v2 reads the pages need.
- `apps/public-site/src/rebuild.ts`: the handler drives the builder; the chrome marker stays; `resyncPostPages`, `renderExistingPost` and `HOME_COUNT` go.
- `apps/public-site/src/self-heal.ts`: startup runs `buildAll` when the marker differs or `index.html` is missing.
- `apps/public-site/src/start.ts`, `env.ts`: the post index, the builder, `SITE_ASSETS_DIR`, the theme and logo.
- `apps/public-site/src/db/schema.ts`: `sitePosts`.
- `apps/public-site/package.json`: dev `jsdom` and `@types/jsdom` (the versions already in the lockfile).
- `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`, `docs/parity/changes-from-legacy.md`, `docs/parity/open-questions.md`.

---

### Task 1: Theme, page chrome, static pages and the structure check

**Review:** shared (template work; pairs with nothing, but it sets the chrome every later page uses).

**Files:**
- Create: `apps/public-site/src/theme-css.ts`, `apps/public-site/src/theme-css.test.ts`
- Create: `apps/public-site/src/static-pages.ts`, `apps/public-site/src/static-pages.test.ts`
- Create: `apps/public-site/test/structure.ts`, `apps/public-site/test/memory-storage.ts`
- Create: `config/site/assets/.gitkeep`
- Modify: `apps/public-site/src/render.ts`, `apps/public-site/src/render.test.ts`
- Modify: `apps/public-site/src/storage.ts`, `apps/public-site/src/storage.test.ts`
- Modify: `apps/public-site/src/env.ts`, `apps/public-site/src/env.test.ts`, `apps/public-site/src/start.ts`
- Modify: `apps/public-site/src/subscribe-pages.test.ts` (structure check on the three subscribe pages)
- Modify: `apps/public-site/package.json`
- Docs: `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`

**Interfaces:**
- Consumes: `SiteTheme`, `siteThemeSchema` from `@gcpe/config`; `escapeHtml` from `@gcpe/http-kit`.
- Produces:
  - `render.ts`: `interface SiteInfo { name: string; baseUrl: string; theme?: SiteTheme; logo?: { src: string; alt: string } | null }`; `interface PageOptions { test?: boolean; banner?: string | null; description?: string | null; feed?: { href: string; title: string } | null }`; `renderPage(title: string, site: SiteInfo, canonicalPath: string, body: string, opts?: PageOptions, bodyAttr?: string): string`; `e(s: string | null | undefined): string`; `basePath(site: SiteInfo): string`.
  - `theme-css.ts`: `DEFAULT_THEME: SiteTheme`; `themeCss(theme: SiteTheme): string`.
  - `static-pages.ts`: `renderNotFoundPage(site: SiteInfo, opts: PageOptions): string`; `renderRobots(site: SiteInfo, test: boolean): string`; `writeStaticPages(storage: SiteStorage, site: SiteInfo, opts: PageOptions, assetsDir: string | null): Promise<void>`; `logoFor(theme: SiteTheme, assetsDir: string | null, site: Pick<SiteInfo, "baseUrl">): { src: string; alt: string } | null`.
  - `storage.ts`: `SiteStorage.write(relPath: string, content: string | Uint8Array): Promise<void>`.
  - `env.ts`: `SITE_ASSETS_DIR` (string, default `<repo>/config/site`), `defaultSiteAssetsDir`.
  - `test/structure.ts`: `expectAccessibleStructure(html: string): Document`.
  - `test/memory-storage.ts`: `memoryStorage(): SiteStorage & { files: Map<string, string | Uint8Array> }`.

- [ ] **Step 1: Add the dev dependency and the shared test helpers**

In `apps/public-site/package.json` add to `devDependencies` (same versions NRMS uses, already in the lockfile): `"@types/jsdom": "^30.0.0"`, `"jsdom": "30.1.2"`. Run `npx -y -p node@24 -- npm install --ignore-scripts` and check `git diff package-lock.json` only adds the workspace's dev entries (no new package downloads).

Create `apps/public-site/test/structure.ts`:

```ts
import { JSDOM } from "jsdom";
import { expect } from "vitest";

/**
 * The structural half of WCAG 2.2 AA that a static check can prove (spec §6.3): language,
 * one h1, a skip link to #main as the first focusable element, the four landmarks, alt on
 * every image, no positive tabindex, a non-empty title. axe-core and Lighthouse run in 6e.
 */
export function expectAccessibleStructure(html: string): Document {
  const { document } = new JSDOM(html).window;
  expect(document.documentElement.getAttribute("lang")).toMatch(/^[a-z]{2}(-[A-Z]{2})?$/);
  expect(document.title.trim()).not.toBe("");
  expect(document.querySelectorAll("h1")).toHaveLength(1);
  for (const tag of ["header", "main", "footer"]) expect(document.querySelectorAll(tag), tag).toHaveLength(1);
  // More than one nav is allowed (e.g. pagination), but each needs its own label.
  expect(document.querySelectorAll("header nav")).toHaveLength(1);
  for (const nav of document.querySelectorAll("nav")) expect(nav.getAttribute("aria-label"), nav.outerHTML.slice(0, 80)).toBeTruthy();
  const main = document.querySelector("main")!;
  expect(main.id).toBe("main");
  const firstFocusable = document.querySelector("a[href], button, input, select, textarea, [tabindex]");
  expect(firstFocusable?.getAttribute("href")).toBe("#main");
  for (const img of document.querySelectorAll("img")) expect(img.hasAttribute("alt"), img.outerHTML).toBe(true);
  for (const el of document.querySelectorAll("[tabindex]")) expect(Number(el.getAttribute("tabindex"))).toBeLessThanOrEqual(0);
  return document;
}
```

Create `apps/public-site/test/memory-storage.ts` (the `memoryStorage` already inside `rebuild.test.ts`, moved and widened to bytes):

```ts
import type { SiteStorage } from "../src/storage";

export function memoryStorage(): SiteStorage & { files: Map<string, string | Uint8Array> } {
  const files = new Map<string, string | Uint8Array>();
  return {
    files,
    async write(relPath, content) {
      files.set(relPath, content);
    },
    async remove(relPath) {
      files.delete(relPath);
    },
    async exists(relPath) {
      return files.has(relPath);
    },
    async read(relPath) {
      const v = files.get(relPath);
      return v === undefined ? null : typeof v === "string" ? v : Buffer.from(v).toString("utf8");
    },
    async listDirs(relPath) {
      const prefix = `${relPath}/`;
      const names = new Set<string>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const seg = key.slice(prefix.length).split("/")[0];
        if (seg && key.slice(prefix.length).includes("/")) names.add(seg);
      }
      return [...names];
    },
  };
}
```

Replace the local `memoryStorage` in `rebuild.test.ts` and `self-heal.test.ts` (if present) with an import of this one.

- [ ] **Step 2: Write the failing chrome tests**

Add to `apps/public-site/src/render.test.ts` (keep the existing tests; their expectations on `renderPostPage`/`renderHomePage` move to Task 3, so delete only those two `it`s that call them once Task 3 lands — in this task, leave them):

```ts
import { renderPage } from "./render";
import { expectAccessibleStructure } from "../test/structure";
import { DEFAULT_THEME } from "./theme-css";

describe("renderPage chrome", () => {
  const themed = { name: "BC Gov News", baseUrl: "https://boxs.example/site", theme: { ...DEFAULT_THEME, footerLinks: [{ label: 'Privacy & "you"', url: "https://example.test/privacy?a=1&b=2" }] } };

  it("has the skip link, the four landmarks, one h1 and lang", () => {
    const html = renderPage("Title", themed, "/site/x/", "<h1>Heading</h1><p>x</p>");
    const doc = expectAccessibleStructure(html);
    expect(doc.querySelector("a.skip-link")?.textContent).toBe("Skip to main content");
    expect(doc.querySelector("main")?.getAttribute("tabindex")).toBe("-1");
    expect(doc.querySelector('link[rel="stylesheet"]')?.getAttribute("href")).toBe("/site/assets/theme.css");
  });

  it("nav links carry the base path", () => {
    const doc = expectAccessibleStructure(renderPage("T", themed, "/site/", "<h1>H</h1>"));
    expect([...doc.querySelectorAll("nav a")].map((a) => a.getAttribute("href"))).toEqual(["/site/", "/site/ministries/", "/site/archive/", "/site/search/"]);
  });

  it("escapes footer labels and URLs", () => {
    const html = renderPage("T", themed, "/site/", "<h1>H</h1>");
    expect(html).toContain('Privacy &amp; &quot;you&quot;');
    expect(html).toContain('href="https://example.test/privacy?a=1&amp;b=2"');
  });

  it("shows the logo when one is set, the wordmark otherwise", () => {
    const withLogo = expectAccessibleStructure(renderPage("T", { ...themed, logo: { src: "/site/assets/logo.svg", alt: "Example <Gov>" } }, "/site/", "<h1>H</h1>"));
    expect(withLogo.querySelector("header img")?.getAttribute("alt")).toBe("Example <Gov>");
    const without = expectAccessibleStructure(renderPage("T", themed, "/site/", "<h1>H</h1>"));
    expect(without.querySelector("header img")).toBeNull();
    expect(without.querySelector("header .wordmark")?.textContent).toBe("BC Gov News");
  });

  it("links the font stylesheet only when configured", () => {
    expect(renderPage("T", themed, "/site/", "<h1>H</h1>")).not.toContain("fonts.example");
    const font = { ...themed, theme: { ...themed.theme, font: { ...themed.theme.font, stylesheetUrl: "https://fonts.example/a.css" } } };
    expect(renderPage("T", font, "/site/", "<h1>H</h1>")).toContain('<link rel="stylesheet" href="https://fonts.example/a.css">');
  });

  it("adds the feed alternate link and description when given", () => {
    const html = renderPage("T", themed, "/site/", "<h1>H</h1>", { feed: { href: "/site/feed.xml", title: "Latest <news>" }, description: "A & B" });
    expect(html).toContain('<link rel="alternate" type="application/rss+xml" title="Latest &lt;news&gt;" href="/site/feed.xml">');
    expect(html).toContain('<meta name="description" content="A &amp; B">');
  });

  it("keeps the test noindex and the banner, and the skip link stays first", () => {
    const html = renderPage("T", themed, "/site/", "<h1>H</h1>", { test: true, banner: "TEST — ALERT" });
    const doc = expectAccessibleStructure(html);
    expect(doc.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe("noindex, nofollow");
    expect(doc.querySelector('[role="alert"]')?.textContent).toBe("TEST — ALERT");
  });
});
```

Create `apps/public-site/src/theme-css.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { siteThemeSchema } from "@gcpe/config";
import { DEFAULT_THEME, themeCss } from "./theme-css";

describe("themeCss", () => {
  it("emits every colour as a CSS variable and the font stack", () => {
    const css = themeCss(DEFAULT_THEME);
    for (const [name, value] of Object.entries(DEFAULT_THEME.colors)) {
      const kebab = name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      expect(css).toContain(`--color-${kebab}: ${value};`);
    }
    expect(css).toContain(`--font-family: "${DEFAULT_THEME.font.family}", ${DEFAULT_THEME.font.fallback};`);
  });
  it("uses only variables for colours outside :root", () => {
    const body = themeCss(DEFAULT_THEME).split("}").slice(1).join("}");
    expect(body).not.toMatch(/#[0-9a-fA-F]{6}/);
  });
  it("has a visible focus style and a skip link that appears on focus", () => {
    const css = themeCss(DEFAULT_THEME);
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--color-accent\)/);
    expect(css).toMatch(/\.skip-link:focus\s*\{/);
  });
  it("refuses to quote a font family that could break out of the declaration", () => {
    const evil = { ...DEFAULT_THEME, font: { family: 'X"; } body { color: red', fallback: "serif" } };
    expect(themeCss(evil)).not.toContain("color: red");
  });
  it("the default theme passes the tenant schema's contrast check", () => {
    expect(siteThemeSchema.safeParse(DEFAULT_THEME).success).toBe(true);
  });
});
```

Create `apps/public-site/src/static-pages.test.ts`:

```ts
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expectAccessibleStructure } from "../test/structure";
import { memoryStorage } from "../test/memory-storage";
import { logoFor, renderNotFoundPage, renderRobots, writeStaticPages } from "./static-pages";
import { DEFAULT_THEME } from "./theme-css";

const site = { name: "BC Gov News", baseUrl: "https://news.example", theme: DEFAULT_THEME };

describe("static pages", () => {
  it("404 is an accessible page with a way home", () => {
    const doc = expectAccessibleStructure(renderNotFoundPage(site, {}));
    expect(doc.querySelector("h1")?.textContent).toBe("Page not found");
    expect(doc.querySelector('main a[href="/"]')).not.toBeNull();
  });
  it("robots.txt: a test site disallows everything; production names the sitemap", () => {
    expect(renderRobots(site, true)).toBe("User-agent: *\nDisallow: /\n");
    expect(renderRobots({ ...site, baseUrl: "https://news.example/site" }, false)).toBe("User-agent: *\nAllow: /\nSitemap: https://news.example/site/sitemap.xml\n");
  });
  it("writes theme.css, 404.html, robots.txt and copies the assets folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "site-assets-"));
    await mkdir(join(dir, "assets", "img"), { recursive: true });
    await writeFile(join(dir, "assets", "logo.svg"), "<svg/>");
    await writeFile(join(dir, "assets", "img", "a.png"), Buffer.from([0x89, 0x50]));
    await writeFile(join(dir, "assets", ".hidden"), "x");
    const storage = memoryStorage();
    await writeStaticPages(storage, site, { test: true }, dir);
    expect([...storage.files.keys()].sort()).toEqual(["404.html", "assets/img/a.png", "assets/logo.svg", "assets/theme.css", "robots.txt"]);
    expect(storage.files.get("assets/img/a.png")).toBeInstanceOf(Uint8Array);
  });
  it("a missing assets folder is not an error", async () => {
    const storage = memoryStorage();
    await writeStaticPages(storage, site, {}, "/nonexistent/folder");
    expect(storage.files.has("assets/theme.css")).toBe(true);
  });
  it("logoFor: the logo only when the file exists under the assets folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "site-assets-"));
    const theme = { ...DEFAULT_THEME, logo: { path: "assets/logo.svg", alt: "Example" } };
    expect(logoFor(theme, dir, { baseUrl: "https://x.example/site" })).toBeNull();
    await mkdir(join(dir, "assets"));
    await writeFile(join(dir, "assets", "logo.svg"), "<svg/>");
    expect(logoFor(theme, dir, { baseUrl: "https://x.example/site" })).toEqual({ src: "/site/assets/logo.svg", alt: "Example" });
    expect(logoFor(theme, null, { baseUrl: "https://x.example/site" })).toBeNull();
  });
});
```

Add to `apps/public-site/src/storage.test.ts`, in the existing `fsStorage` describe:

```ts
it("writes bytes as well as text", async () => {
  const s = fsStorage(root);
  await s.write("assets/a.png", new Uint8Array([1, 2, 3]));
  expect([...(await readFile(join(root, "assets/a.png")))]).toEqual([1, 2, 3]);
});
```

(use the file's existing `root` temp-dir fixture and imports).

Add to `apps/public-site/src/subscribe-pages.test.ts`: for each of the three pages written by `writeSubscribePages`, `expectAccessibleStructure(html)`.

- [ ] **Step 3: Run the tests and see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/public-site/src/render.test.ts apps/public-site/src/theme-css.test.ts apps/public-site/src/static-pages.test.ts apps/public-site/src/storage.test.ts apps/public-site/src/subscribe-pages.test.ts`
Expected: FAIL — `theme-css` and `static-pages` don't exist; the chrome tests fail on the missing skip link (`expected null to be '#main'`).

- [ ] **Step 4: Implement the theme**

Create `apps/public-site/src/theme-css.ts`:

```ts
import type { SiteTheme } from "@gcpe/config";

/** Used when no tenant config loaded (TENANT_CONFIG unset and the default missing). Neutral,
 * and passes the same contrast check the tenant loader applies. */
export const DEFAULT_THEME: SiteTheme = {
  colors: {
    primary: "#1F3A5F",
    primaryText: "#FFFFFF",
    accent: "#C77700",
    text: "#1A1A1A",
    mutedText: "#4D4D4D",
    surface: "#F4F4F4",
    background: "#FFFFFF",
    border: "#CCCCCC",
  },
  font: { family: "Noto Sans", fallback: "Verdana, Arial, sans-serif" },
  logo: { path: "assets/logo.svg", alt: "Home" },
  footerLinks: [],
};

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
/** A CSS string literal: quotes, backslashes and anything that could end the rule are dropped. */
const cssString = (s: string) => `"${s.replace(/["\\;{}<>\n\r]/g, "")}"`;
/** The fallback stack: family names, quotes, commas, spaces and hyphens only. */
const cssStack = (s: string) => s.replace(/[^A-Za-z0-9 ,"'-]/g, "");

/** spec §6.3: theme.css from site.theme, as CSS variables; every rule below uses only them. */
export function themeCss(theme: SiteTheme): string {
  const vars = Object.entries(theme.colors)
    .map(([name, value]) => `  --color-${kebab(name)}: ${value};`)
    .join("\n");
  return `:root {
${vars}
  --font-family: ${cssString(theme.font.family)}, ${cssStack(theme.font.fallback)};
}
*, *::before, *::after { box-sizing: border-box; }
html { font-family: var(--font-family); color: var(--color-text); background: var(--color-background); line-height: 1.5; }
body { margin: 0; }
a { color: var(--color-primary); }
:focus-visible { outline: 3px solid var(--color-accent); outline-offset: 2px; }
.skip-link { position: absolute; left: -9999px; top: 0; background: var(--color-primary); color: var(--color-primary-text); padding: 0.5rem 1rem; z-index: 10; }
.skip-link:focus { left: 0.5rem; }
.site-header { background: var(--color-primary); color: var(--color-primary-text); padding: 0.75rem 1rem; display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; justify-content: space-between; }
.site-header a { color: var(--color-primary-text); }
.site-header .brand { display: inline-flex; gap: 0.75rem; align-items: center; text-decoration: none; font-weight: 700; }
.site-header .logo { height: 3rem; width: auto; }
.site-header nav ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 1rem; }
.blue-bridge-banner { background: var(--color-text); color: var(--color-background); padding: 0.75rem 1rem; font-weight: 700; }
main { max-width: 70rem; margin: 0 auto; padding: 1rem; }
main:focus { outline: none; }
.muted, time { color: var(--color-muted-text); }
.card { background: var(--color-surface); border: 1px solid var(--color-border); padding: 1rem; margin: 0 0 1rem; }
.post-list { list-style: none; padding: 0; }
.post-list li { border-bottom: 1px solid var(--color-border); padding: 0.75rem 0; }
.site-footer { border-top: 4px solid var(--color-accent); background: var(--color-surface); padding: 1rem; }
.site-footer ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 1rem; }
figure { margin: 1rem 0; }
img { max-width: 100%; height: auto; }
`;
}
```

- [ ] **Step 5: Implement the chrome**

In `apps/public-site/src/render.ts`, keep `PostDocument`/`PostDto` (they move to `dto.ts` in Task 3) and replace `SiteInfo`, `PageOptions`, `basePath`, `e` and `renderPage` with:

```ts
import type { SiteTheme } from "@gcpe/config";
import { escapeHtml } from "@gcpe/http-kit";
import { DEFAULT_THEME } from "./theme-css";

export interface SiteInfo {
  name: string;
  baseUrl: string;
  /** Tenant `site.theme`; DEFAULT_THEME when absent. */
  theme?: SiteTheme;
  /** Set by start.ts only when the logo file exists under SITE_ASSETS_DIR (static-pages.ts's logoFor). */
  logo?: { src: string; alt: string } | null;
}

export interface PageOptions {
  /** A test site gets `<meta name="robots" content="noindex, nofollow">` (site-env.ts's isTestSite). */
  test?: boolean;
  /** Project Blue Bridge's banner text (site-env.ts's blueBridgeBanner), or null/absent for none. */
  banner?: string | null;
  description?: string | null;
  /** The page's RSS feed, linked as an alternate. */
  feed?: { href: string; title: string } | null;
}

export const e = (s: string | null | undefined): string => escapeHtml(s ?? "");

/** The base URL's path with no trailing slash: "" at a root base, "/site" on boxs.ca. */
export function basePath(site: Pick<SiteInfo, "baseUrl">): string {
  return new URL(site.baseUrl).pathname.replace(/\/+$/, "");
}

/** Every page's chrome (spec §6.3): skip link, header with brand and nav, main, footer. */
export function renderPage(title: string, site: SiteInfo, canonicalPath: string, body: string, opts: PageOptions = {}, bodyAttr = ""): string {
  const base = basePath(site);
  const theme = site.theme ?? DEFAULT_THEME;
  const robots = opts.test ? `\n<meta name="robots" content="noindex, nofollow">` : "";
  const description = opts.description ? `\n<meta name="description" content="${e(opts.description)}">` : "";
  const font = theme.font.stylesheetUrl ? `\n<link rel="stylesheet" href="${e(theme.font.stylesheetUrl)}">` : "";
  const feed = opts.feed ? `\n<link rel="alternate" type="application/rss+xml" title="${e(opts.feed.title)}" href="${e(opts.feed.href)}">` : "";
  const banner = opts.banner ? `\n<div class="blue-bridge-banner" role="alert">${e(opts.banner)}</div>` : "";
  const brand = site.logo
    ? `<img class="logo" src="${e(site.logo.src)}" alt="${e(site.logo.alt)}"><span class="wordmark">${e(site.name)}</span>`
    : `<span class="wordmark">${e(site.name)}</span>`;
  const footerLinks = theme.footerLinks.map((l) => `<li><a href="${e(l.url)}">${e(l.label)}</a></li>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)} | ${e(site.name)}</title>
<link rel="canonical" href="${e(new URL(site.baseUrl).origin + canonicalPath)}">${robots}${description}
<link rel="stylesheet" href="${e(base)}/assets/theme.css">${font}${feed}
</head>
<body${bodyAttr}>
<a class="skip-link" href="#main">Skip to main content</a>${banner}
<header class="site-header">
<a class="brand" href="${e(base)}/">${brand}</a>
<nav aria-label="Site">
<ul>
<li><a href="${e(base)}/">Home</a></li>
<li><a href="${e(base)}/ministries/">Ministries</a></li>
<li><a href="${e(base)}/archive/">Archive</a></li>
<li><a href="${e(base)}/search/">Search</a></li>
</ul>
</nav>
</header>
<main id="main" tabindex="-1">
${body}
</main>
<footer class="site-footer">
<ul>
${footerLinks}
</ul>
<p class="muted">${e(site.name)}</p>
</footer>
</body>
</html>
`;
}
```

`renderPostPage` and `renderHomePage` keep working (they call `renderPage`) until Task 3 replaces them. `subscribe-pages.ts` keeps its own `basePath` copy; switch it to import `basePath` from `render.ts`.

- [ ] **Step 6: Implement bytes in storage and the static pages**

In `apps/public-site/src/storage.ts`, change the interface line and the write signature only:

```ts
  write(relPath: string, content: string | Uint8Array): Promise<void>;
```

and in `fsStorage`'s `write(relPath, content)`: `await writeFile(tmp, content);` (drop the `"utf8"` argument; `writeFile` writes a string as UTF-8 by default). No other change to the path checks.

Create `apps/public-site/src/static-pages.ts`:

```ts
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { SiteTheme } from "@gcpe/config";
import { basePath, e, renderPage, type PageOptions, type SiteInfo } from "./render";
import type { SiteStorage } from "./storage";
import { DEFAULT_THEME, themeCss } from "./theme-css";

export function renderNotFoundPage(site: SiteInfo, opts: PageOptions): string {
  const base = basePath(site);
  return renderPage("Page not found", site, `${base}/404.html`, `<h1>Page not found</h1>
<p>The page you asked for isn't here. It may have moved or been removed.</p>
<p><a href="${e(base)}/">Go to the home page</a> or <a href="${e(base)}/archive/">browse the archive</a>.</p>`, opts);
}

/** spec §6.1: test sites keep Disallow: / (constraints.md's test-site rule). */
export function renderRobots(site: SiteInfo, test: boolean): string {
  if (test) return "User-agent: *\nDisallow: /\n";
  return `User-agent: *\nAllow: /\nSitemap: ${new URL(site.baseUrl).origin}${basePath(site)}/sitemap.xml\n`;
}

/** The logo is shown only once its file exists under SITE_ASSETS_DIR (Q76). */
export function logoFor(theme: SiteTheme, assetsDir: string | null, site: Pick<SiteInfo, "baseUrl">): { src: string; alt: string } | null {
  if (!assetsDir || !existsSync(join(assetsDir, theme.logo.path))) return null;
  return { src: `${basePath(site)}/${theme.logo.path}`, alt: theme.logo.alt };
}

/** Every file under `<assetsDir>/assets`, as paths relative to assetsDir; dotfiles skipped. */
async function assetFiles(assetsDir: string): Promise<string[]> {
  const root = join(assetsDir, "assets");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    out.push(relative(assetsDir, join(entry.parentPath, entry.name)).split(sep).join("/"));
  }
  return out.sort();
}

/** theme.css, the tenant's asset files, 404.html and robots.txt — cheap, so written on every build. */
export async function writeStaticPages(storage: SiteStorage, site: SiteInfo, opts: PageOptions, assetsDir: string | null): Promise<void> {
  if (assetsDir) {
    for (const rel of await assetFiles(assetsDir)) await storage.write(rel, new Uint8Array(await readFile(join(assetsDir, rel))));
  }
  await storage.write("assets/theme.css", themeCss(site.theme ?? DEFAULT_THEME));
  await storage.write("404.html", renderNotFoundPage(site, opts));
  await storage.write("robots.txt", renderRobots(site, opts.test === true));
}
```

(`readdir`'s `recursive` and `Dirent.parentPath` are Node 20.12+/22; the project runs Node 24.)

- [ ] **Step 7: Wire the assets folder and theme into startup**

In `apps/public-site/src/env.ts` add:

```ts
export const defaultSiteAssetsDir = fileURLToPath(new URL("../../../config/site", import.meta.url));
```

and in `publicSiteEnvSchema`'s object: `SITE_ASSETS_DIR: z.string().min(1).default(defaultSiteAssetsDir),`. Add an `env.test.ts` case: unset → the default; set → the value.

On the SiteGround bundle, `config/` is copied next to `stack.js` (`scripts/build-siteground.mjs` "copying config"), so `config/site` resolves the same way `config/tenants/bc.json` already does; no build change. In `start.ts`, build the site info:

```ts
const theme = tenantConfig?.site.theme ?? DEFAULT_THEME;
const site: SiteInfo = { name: parsed.SITE_NAME, baseUrl: parsed.PUBLIC_SITE_URL, theme };
site.logo = logoFor(theme, parsed.SITE_ASSETS_DIR, site);
```

Create `config/site/assets/.gitkeep` (empty).

- [ ] **Step 8: Run the tests and see them pass; type-check**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/public-site`
Expected: PASS. Then `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json` — no errors.

- [ ] **Step 9: Docs**

`docs/manuals/running-notes.md`: add `## Phase 6c — The public site` directly after the Phase 6b list, with:
- `- **Site editor** — The public site now has a header with the site's name (and logo, once one is supplied), a menu (Home, Ministries, Archive, Search) and a footer with the tenant's footer links. A "Skip to main content" link appears when you press Tab.`
- `- **Operations** — The site's colours and font come from the tenant config's \`site.theme\`. Logo and font files go in \`config/site/assets/\`; the site copies them on every start. Until a logo file exists the header shows the site name as text.`

`docs/deploy/siteground.md`: insert `## The public site (Phase 6c)` just before `## Troubleshooting` (after the 6b section), with a `### Theme and assets` subsection: `site.theme` in `config/tenants/<tenant>.json`; files under `config/site/assets/` are published at `<site>/assets/…`; `SITE_SITE_ASSETS_DIR` overrides the folder (the stack prefixes every public-site variable with `SITE_`); test sites serve `robots.txt` with `Disallow: /`.

- [ ] **Step 10: Commit**

```bash
git add apps/public-site config/site docs/manuals/running-notes.md docs/deploy/siteground.md package-lock.json
git commit -m "public-site: theme.css from site.theme, accessible page chrome, 404, robots and tenant assets"
```

---

### Task 2: Page ids, the post index and the rebuild-set function

**Review:** full (storage and path handling; the rebuild set).

**Files:**
- Create: `apps/public-site/src/site-paths.ts`, `apps/public-site/src/site-paths.test.ts`
- Create: `apps/public-site/src/rebuild-set.ts`, `apps/public-site/src/rebuild-set.test.ts`
- Create: `apps/public-site/src/post-index.ts`, `apps/public-site/src/post-index.test.ts`
- Create: `apps/public-site/src/dto.ts` (types only)
- Modify: `apps/public-site/src/db/schema.ts`
- Create (generated): `apps/public-site/migrations/0001_site_posts.sql`, `migrations/meta/0001_snapshot.json`, the journal entry
- Modify: `apps/public-site/src/render.ts` (import `PostDto` from `dto.ts`; re-export it so existing imports keep compiling)

**Interfaces:**
- Consumes: `SiteInfo`, `basePath` (Task 1); `Db`, `DbOrTx` from `@gcpe/db-kit`.
- Produces:
  - `dto.ts`: `PostDocument`, `PostDto` (adds optional `sectorKeys`, `themeKeys`, `tagKeys`, `leadMinistryKey`, `azureAssets`, `azureTranslations`; see Step 4), `AssetDto { key: string | null; label: string | null; length: number | null }`.
  - `site-paths.ts`: `POST_KEY: RegExp`; `CATEGORY_KEY: RegExp`; `MONTH: RegExp`; `CATEGORY_KINDS: readonly ["ministries", "sectors", "themes", "tags"]`; `type CategoryKind`; `isCategoryKind(s: string): s is CategoryKind`; `type PageId = { type: "home" } | { type: "post"; key: string } | { type: "ministries" } | { type: "category"; kind: CategoryKind; key: string } | { type: "archive" } | { type: "archive-month"; month: string } | { type: "sitemap" } | { type: "sitemap-month"; month: string } | { type: "sitemap-pages" } | { type: "static" }`; `parsePageId(id: string): PageId | null`; `formatPageId(p: PageId): string`; `categoryPageId(kind: CategoryKind, key: string): string | null`; `pageFiles(p: PageId): string[]`; `pageUrl(site, p: PageId): string`; `feedUrl(site, p: { type: "home" } | { type: "category"; kind: CategoryKind; key: string }): string`; `absoluteUrl(site, path: string): string`; `postPath(key: string): string`.
  - `rebuild-set.ts`: `interface Membership { month: string; categories: string[] }` (category tokens `"<kind>:<lowercased key>"`); `membershipOf(post: Pick<PostDto, "publishDate" | "ministryKeys" | "sectorKeys" | "themeKeys" | "tagKeys">): Membership | null`; `dependentPages(before: Membership | null, after: Membership | null): string[]`.
  - `post-index.ts`: `interface IndexedPost { key: string; kind: string; headline: string; summary: string | null; publishDate: string; month: string; categories: string[] }`; `indexEntryOf(key: string, post: PostDto): IndexedPost | null`; `membershipOfEntry(p: IndexedPost): Membership`; `interface PostIndex { get(key): Promise<IndexedPost | null>; put(p: IndexedPost): Promise<void>; remove(key): Promise<void>; inMonth(month): Promise<IndexedPost[]>; months(): Promise<{ month: string; count: number }[]>; keys(): Promise<string[]>; categories(): Promise<string[]>; inCategory(token: string): Promise<string[]> }`; `postIndex(db: DbOrTx): PostIndex`.
  - `db/schema.ts`: `sitePosts`.

- [ ] **Step 1: Write the failing page-id and path tests**

Create `apps/public-site/src/site-paths.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { absoluteUrl, categoryPageId, feedUrl, formatPageId, pageFiles, pageUrl, parsePageId } from "./site-paths";

const site = { name: "N", baseUrl: "https://boxs.example/site" };

describe("parsePageId", () => {
  it.each([
    ["home", { type: "home" }],
    ["post:2026HLTH0001-000001", { type: "post", key: "2026HLTH0001-000001" }],
    ["ministries", { type: "ministries" }],
    ["category:ministries:health", { type: "category", kind: "ministries", key: "health" }],
    ["category:tags:covid-19", { type: "category", kind: "tags", key: "covid-19" }],
    ["archive", { type: "archive" }],
    ["archive:2026-10", { type: "archive-month", month: "2026-10" }],
    ["sitemap", { type: "sitemap" }],
    ["sitemap:2026-01", { type: "sitemap-month", month: "2026-01" }],
    ["sitemap:pages", { type: "sitemap-pages" }],
    ["static", { type: "static" }],
  ])("%s", (id, expected) => {
    expect(parsePageId(id)).toEqual(expected);
    expect(formatPageId(parsePageId(id)!)).toBe(id);
  });

  it.each([
    "", "post:", "post:..", "post:a/b", "post:a.b", "post:../etc", `post:${"a".repeat(101)}`, "post:a:b",
    "category:ministries:Health", "category:ministries:../../etc", "category:ministries:a/b", "category:people:x", "category:ministries", "category:ministries:x:y",
    "archive:2026-13", "archive:2026-00", "archive:26-10", "archive:2026-10:x", "sitemap:2026-1", "nope", "home:x",
  ])("refuses %j", (id) => {
    expect(parsePageId(id)).toBeNull();
  });
});

describe("categoryPageId", () => {
  it("lowercases a valid key and refuses an unsafe one", () => {
    expect(categoryPageId("ministries", "Health")).toBe("category:ministries:health");
    expect(categoryPageId("ministries", "56429306-8C3E-4991-AEB2-1CC86F20BFDD")).toBe("category:ministries:56429306-8c3e-4991-aeb2-1cc86f20bfdd");
    expect(categoryPageId("tags", "a b")).toBeNull();
    expect(categoryPageId("tags", "..")).toBeNull();
  });
});

describe("pageFiles", () => {
  it.each([
    ["home", ["index.html", "feed.xml"]],
    ["post:K1", ["releases/K1/index.html"]],
    ["ministries", ["ministries/index.html"]],
    ["category:sectors:economy", ["sectors/economy/index.html", "sectors/economy/feed.xml"]],
    ["archive", ["archive/index.html"]],
    ["archive:2026-10", ["archive/2026/10/index.html"]],
    ["sitemap", ["sitemap.xml"]],
    ["sitemap:2026-10", ["sitemaps/2026-10.xml"]],
    ["sitemap:pages", ["sitemaps/pages.xml"]],
    ["static", ["assets/theme.css", "404.html", "robots.txt"]],
  ])("%s", (id, files) => {
    expect(pageFiles(parsePageId(id)!)).toEqual(files);
  });
});

describe("urls", () => {
  it("carry the base path and a trailing slash for directory pages", () => {
    expect(pageUrl(site, { type: "home" })).toBe("/site/");
    expect(pageUrl(site, { type: "post", key: "K1" })).toBe("/site/releases/K1/");
    expect(pageUrl(site, { type: "category", kind: "themes", key: "health" })).toBe("/site/themes/health/");
    expect(pageUrl(site, { type: "archive-month", month: "2026-10" })).toBe("/site/archive/2026/10/");
    expect(feedUrl(site, { type: "home" })).toBe("/site/feed.xml");
    expect(feedUrl(site, { type: "category", kind: "tags", key: "covid-19" })).toBe("/site/tags/covid-19/feed.xml");
    expect(absoluteUrl(site, "/site/x/")).toBe("https://boxs.example/site/x/");
  });
});
```

- [ ] **Step 2: Write the failing rebuild-set tests**

Create `apps/public-site/src/rebuild-set.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { dependentPages, membershipOf } from "./rebuild-set";

const post = { publishDate: "2026-10-03T10:00:00-07:00", ministryKeys: ["Health"], sectorKeys: ["economy"], themeKeys: [], tagKeys: ["covid-19", "bad key"] };

describe("membershipOf", () => {
  it("takes the BC month from the offset date and lowercased, valid category tokens", () => {
    expect(membershipOf(post)).toEqual({ month: "2026-10", categories: ["ministries:health", "sectors:economy", "tags:covid-19"] });
  });
  it("dedupes case variants and tolerates missing arrays", () => {
    expect(membershipOf({ publishDate: "2026-01-31T23:30:00-08:00", ministryKeys: ["health", "HEALTH"] })).toEqual({ month: "2026-01", categories: ["ministries:health"] });
  });
  it("null for an unusable date", () => {
    expect(membershipOf({ ...post, publishDate: "garbage" })).toBeNull();
  });
});

describe("dependentPages (spec §6.2's post row)", () => {
  const m = (month: string, ...categories: string[]) => ({ month, categories });

  it("a new post: home, its categories, its month's archive and sitemap, the archive index and the sitemap index", () => {
    expect(dependentPages(null, m("2026-10", "ministries:health", "tags:covid-19"))).toEqual([
      "archive", "archive:2026-10", "category:ministries:health", "category:tags:covid-19", "home", "sitemap", "sitemap:2026-10",
    ]);
  });

  it("an unpublished post rebuilds the same pages from the stored row", () => {
    expect(dependentPages(m("2026-10", "ministries:health"), null)).toEqual(["archive", "archive:2026-10", "category:ministries:health", "home", "sitemap", "sitemap:2026-10"]);
  });

  it("a post that moves ministry and month rebuilds both old and new pages", () => {
    expect(dependentPages(m("2026-09", "ministries:health"), m("2026-10", "ministries:finance"))).toEqual([
      "archive", "archive:2026-09", "archive:2026-10", "category:ministries:finance", "category:ministries:health", "home", "sitemap", "sitemap:2026-09", "sitemap:2026-10",
    ]);
  });

  it("nothing before and nothing after: nothing", () => {
    expect(dependentPages(null, null)).toEqual([]);
  });

  it("never names the post page itself", () => {
    expect(dependentPages(null, m("2026-10")).some((id) => id.startsWith("post:"))).toBe(false);
  });
});
```

- [ ] **Step 3: Run them and see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/public-site/src/site-paths.test.ts apps/public-site/src/rebuild-set.test.ts`
Expected: FAIL — `Failed to resolve import "./site-paths"`.

- [ ] **Step 4: Implement `dto.ts`, `site-paths.ts` and `rebuild-set.ts`**

Create `apps/public-site/src/dto.ts` (types the public site reads; the shapes are News API v1's `toPostDto` and friends in `apps/news-api/src/dto.ts`, and v2's search result):

```ts
export interface PostDocument {
  languageId: number;
  headline: string | null;
  subheadline: string | null;
  detailsHtml: string | null;
  contacts: { title: string | null; details: string | null }[];
}
export interface AssetDto {
  /** An absolute file URL (NRMS's PUBLIC_FILES_BASE + /files/…). */
  key: string | null;
  label: string | null;
  length: number | null;
}
export interface PostDto {
  key: string;
  kind: string;
  /** BC-local ISO date with offset, e.g. 2026-10-03T10:00:00-07:00 (News API formatOffsetDateTime). */
  publishDate: string;
  summary: string | null;
  location: string | null;
  leadMinistryKey?: string | null;
  ministryKeys: string[];
  sectorKeys?: string[];
  themeKeys?: string[];
  tagKeys?: string[];
  documents: PostDocument[];
  azureAssets?: AssetDto[] | null;
  azureTranslations?: AssetDto[] | null;
}
```

In `render.ts`, delete the two interfaces there and add `export type { PostDocument, PostDto } from "./dto";` plus `import type { PostDto } from "./dto";`.

Create `apps/public-site/src/site-paths.ts`:

```ts
import { basePath, type SiteInfo } from "./render";

/** A post key as NRMS and the News API produce it. Also the on-disk directory name. */
export const POST_KEY = /^[A-Za-z0-9-]{1,100}$/;
/** A category key (ministry, sector, theme, tag) in its lowercased on-disk form. */
export const CATEGORY_KEY = /^[a-z0-9-]{1,100}$/;
/** A BC calendar month. */
export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export const CATEGORY_KINDS = ["ministries", "sectors", "themes", "tags"] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];
export const isCategoryKind = (s: string): s is CategoryKind => (CATEGORY_KINDS as readonly string[]).includes(s);

export type PageId =
  | { type: "home" }
  | { type: "post"; key: string }
  | { type: "ministries" }
  | { type: "category"; kind: CategoryKind; key: string }
  | { type: "archive" }
  | { type: "archive-month"; month: string }
  | { type: "sitemap" }
  | { type: "sitemap-month"; month: string }
  | { type: "sitemap-pages" }
  | { type: "static" };

const SINGLE: Record<string, PageId> = {
  home: { type: "home" },
  ministries: { type: "ministries" },
  archive: { type: "archive" },
  sitemap: { type: "sitemap" },
  "sitemap:pages": { type: "sitemap-pages" },
  static: { type: "static" },
};

/** The one gate between a page id (from an event, the change feed or the queue) and a path. */
export function parsePageId(id: string): PageId | null {
  if (Object.hasOwn(SINGLE, id)) return SINGLE[id]!;
  const parts = id.split(":");
  const [head] = parts;
  if (head === "post" && parts.length === 2 && POST_KEY.test(parts[1]!)) return { type: "post", key: parts[1]! };
  if (head === "category" && parts.length === 3 && isCategoryKind(parts[1]!) && CATEGORY_KEY.test(parts[2]!)) return { type: "category", kind: parts[1] as CategoryKind, key: parts[2]! };
  if (head === "archive" && parts.length === 2 && MONTH.test(parts[1]!)) return { type: "archive-month", month: parts[1]! };
  if (head === "sitemap" && parts.length === 2 && MONTH.test(parts[1]!)) return { type: "sitemap-month", month: parts[1]! };
  return null;
}

export function formatPageId(p: PageId): string {
  switch (p.type) {
    case "post": return `post:${p.key}`;
    case "category": return `category:${p.kind}:${p.key}`;
    case "archive-month": return `archive:${p.month}`;
    case "sitemap-month": return `sitemap:${p.month}`;
    case "sitemap-pages": return "sitemap:pages";
    default: return p.type;
  }
}

/** The page id for a category key as the News API spells it; null when the key isn't safe. */
export function categoryPageId(kind: CategoryKind, key: string): string | null {
  const lower = key.toLowerCase();
  return CATEGORY_KEY.test(lower) ? `category:${kind}:${lower}` : null;
}

export const postPath = (key: string) => `releases/${key}/index.html`;

/** Relative output files for a page. Only ever called with a parsed (validated) PageId. */
export function pageFiles(p: PageId): string[] {
  switch (p.type) {
    case "home": return ["index.html", "feed.xml"];
    case "post": return [postPath(p.key)];
    case "ministries": return ["ministries/index.html"];
    case "category": return [`${p.kind}/${p.key}/index.html`, `${p.kind}/${p.key}/feed.xml`];
    case "archive": return ["archive/index.html"];
    case "archive-month": return [`archive/${p.month.slice(0, 4)}/${p.month.slice(5)}/index.html`];
    case "sitemap": return ["sitemap.xml"];
    case "sitemap-month": return [`sitemaps/${p.month}.xml`];
    case "sitemap-pages": return ["sitemaps/pages.xml"];
    case "static": return ["assets/theme.css", "404.html", "robots.txt"];
  }
}

/** The in-site link to a page (directory pages end in "/"). */
export function pageUrl(site: Pick<SiteInfo, "baseUrl">, p: PageId): string {
  const base = basePath(site);
  switch (p.type) {
    case "home": return `${base}/`;
    case "post": return `${base}/releases/${encodeURIComponent(p.key)}/`;
    case "ministries": return `${base}/ministries/`;
    case "category": return `${base}/${p.kind}/${p.key}/`;
    case "archive": return `${base}/archive/`;
    case "archive-month": return `${base}/archive/${p.month.slice(0, 4)}/${p.month.slice(5)}/`;
    case "sitemap": return `${base}/sitemap.xml`;
    case "sitemap-month": return `${base}/sitemaps/${p.month}.xml`;
    case "sitemap-pages": return `${base}/sitemaps/pages.xml`;
    case "static": return `${base}/404.html`;
  }
}

export function feedUrl(site: Pick<SiteInfo, "baseUrl">, p: { type: "home" } | { type: "category"; kind: CategoryKind; key: string }): string {
  return p.type === "home" ? `${basePath(site)}/feed.xml` : `${basePath(site)}/${p.kind}/${p.key}/feed.xml`;
}

export const absoluteUrl = (site: Pick<SiteInfo, "baseUrl">, path: string) => new URL(site.baseUrl).origin + path;
```

Create `apps/public-site/src/rebuild-set.ts`:

```ts
import type { PostDto } from "./dto";
import { categoryPageId, CATEGORY_KINDS, MONTH, type CategoryKind } from "./site-paths";

/** What a post contributes to list pages: its BC month and its category tokens ("ministries:health"). */
export interface Membership {
  month: string;
  categories: string[];
}

const KEYS_FIELD: Record<CategoryKind, "ministryKeys" | "sectorKeys" | "themeKeys" | "tagKeys"> = {
  ministries: "ministryKeys",
  sectors: "sectorKeys",
  themes: "themeKeys",
  tags: "tagKeys",
};

/** null when the publish date has no usable month (the post then lists nowhere by month). */
export function membershipOf(post: Pick<PostDto, "publishDate" | "ministryKeys" | "sectorKeys" | "themeKeys" | "tagKeys">): Membership | null {
  const month = post.publishDate.slice(0, 7);
  if (!MONTH.test(month)) return null;
  const categories = new Set<string>();
  for (const kind of CATEGORY_KINDS) {
    for (const key of post[KEYS_FIELD[kind]] ?? []) {
      const id = categoryPageId(kind, key);
      if (id) categories.add(id.slice("category:".length));
    }
  }
  return { month, categories: [...categories].sort() };
}

/**
 * spec §6.2's first row: the pages a post change rebuilds besides the post page itself. The
 * union of before (the index row) and after (the News API's post), so a post that leaves a
 * ministry or a month is taken off the old pages too. Sorted, no duplicates.
 */
export function dependentPages(before: Membership | null, after: Membership | null): string[] {
  if (!before && !after) return [];
  const ids = new Set<string>(["home", "archive", "sitemap"]);
  for (const m of [before, after]) {
    if (!m) continue;
    ids.add(`archive:${m.month}`);
    ids.add(`sitemap:${m.month}`);
    for (const c of m.categories) ids.add(`category:${c}`);
  }
  return [...ids].sort();
}
```

- [ ] **Step 5: Run the pure tests and see them pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/public-site/src/site-paths.test.ts apps/public-site/src/rebuild-set.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the `site_posts` table and generate the migration**

In `apps/public-site/src/db/schema.ts`:

```ts
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
export * from "@gcpe/events/tables";

/**
 * One row per post page on disk (spec §6.2): what the public site last rendered for the post.
 * The rebuild set compares it with the News API's current post, and the archives and sitemaps
 * are rendered from it (the News API has no by-month query).
 */
export const sitePosts = pgTable(
  "site_posts",
  {
    key: text("key").primaryKey(),
    kind: text("kind").notNull(),
    headline: text("headline").notNull(),
    summary: text("summary"),
    /** As the News API formats it: BC-local with its offset. Shown, and used for the month. */
    publishDate: text("publish_date").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    month: text("month").notNull(),
    categories: text("categories").array().notNull(),
    indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [index("site_posts_month_idx").on(t.month, t.publishedAt), index("site_posts_categories_idx").using("gin", t.categories)],
);
```

Run: `cd apps/public-site && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name site_posts`
Expected: `migrations/0001_site_posts.sql` with `CREATE TABLE "site_posts"` and the two `CREATE INDEX` statements (the second `USING gin ("categories")`); nothing touching the events tables. Don't edit it.

- [ ] **Step 7: Write the failing post-index tests**

Create `apps/public-site/src/post-index.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createPublicSiteTestDb } from "../test/helpers";
import { indexEntryOf, membershipOfEntry, postIndex } from "./post-index";
import type { PostDto } from "./dto";

const dto = (over: Partial<PostDto>): PostDto => ({
  key: "K1", kind: "releases", publishDate: "2026-10-03T10:00:00-07:00", summary: "S", location: null, ministryKeys: ["Health"], tagKeys: ["covid-19"],
  documents: [{ languageId: 4105, headline: "Clinics open", subheadline: null, detailsHtml: "<p>x</p>", contacts: [] }], ...over,
});

describe("post index", () => {
  let tdb: TestDatabase;
  beforeAll(async () => { tdb = await createPublicSiteTestDb(); });
  afterAll(async () => { await tdb.drop(); });
  beforeEach(async () => { await tdb.pool.query("TRUNCATE site_posts"); });

  it("indexEntryOf takes the English headline, the BC month and category tokens", () => {
    expect(indexEntryOf("K1", dto({}))).toEqual({ key: "K1", kind: "releases", headline: "Clinics open", summary: "S", publishDate: "2026-10-03T10:00:00-07:00", month: "2026-10", categories: ["ministries:health", "tags:covid-19"] });
    expect(indexEntryOf("K1", dto({ documents: [] }))!.headline).toBe("K1");
    expect(indexEntryOf("K1", dto({ publishDate: "x" }))).toBeNull();
  });

  it("put, get, replace and remove", async () => {
    const idx = postIndex(tdb.db);
    await idx.put(indexEntryOf("K1", dto({}))!);
    expect(membershipOfEntry((await idx.get("K1"))!)).toEqual({ month: "2026-10", categories: ["ministries:health", "tags:covid-19"] });
    await idx.put(indexEntryOf("K1", dto({ ministryKeys: ["finance"], tagKeys: [] }))!);
    expect((await idx.get("K1"))!.categories).toEqual(["ministries:finance"]);
    await idx.remove("K1");
    expect(await idx.get("K1")).toBeNull();
  });

  it("a month lists newest first, across a DST change; months count newest first", async () => {
    const idx = postIndex(tdb.db);
    await idx.put(indexEntryOf("A", dto({ key: "A", publishDate: "2026-03-07T09:00:00-08:00" }))!);
    await idx.put(indexEntryOf("B", dto({ key: "B", publishDate: "2026-03-08T08:30:00-07:00" }))!);
    await idx.put(indexEntryOf("C", dto({ key: "C", publishDate: "2026-02-01T00:00:00-08:00" }))!);
    expect((await idx.inMonth("2026-03")).map((p) => p.key)).toEqual(["B", "A"]);
    expect(await idx.months()).toEqual([{ month: "2026-03", count: 2 }, { month: "2026-02", count: 1 }]);
    expect((await idx.keys()).sort()).toEqual(["A", "B", "C"]);
    expect(await idx.categories()).toEqual(["ministries:health", "tags:covid-19"]);
    expect((await idx.inCategory("tags:covid-19")).sort()).toEqual(["A", "B", "C"]);
  });
});
```

- [ ] **Step 8: Run it and see it fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/public-site/src/post-index.test.ts`
Expected: FAIL — `Failed to resolve import "./post-index"`.

- [ ] **Step 9: Implement `post-index.ts`**

```ts
import { arrayContains, asc, desc, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import { sitePosts } from "./db/schema";
import type { PostDto } from "./dto";
import { membershipOf, type Membership } from "./rebuild-set";

const ENGLISH = 4105;

export interface IndexedPost {
  key: string;
  kind: string;
  headline: string;
  summary: string | null;
  publishDate: string;
  month: string;
  categories: string[];
}

/** The English headline (or the first document's, or the key), as the release page shows it. */
export function headlineOf(post: PostDto): string {
  const d = post.documents.find((x) => x.languageId === ENGLISH) ?? post.documents[0];
  return d?.headline?.trim() || post.key;
}

/** null when the post has no usable publish month. */
export function indexEntryOf(key: string, post: PostDto): IndexedPost | null {
  const m = membershipOf(post);
  if (!m) return null;
  return { key, kind: post.kind, headline: headlineOf(post), summary: post.summary, publishDate: post.publishDate, month: m.month, categories: m.categories };
}

export const membershipOfEntry = (p: IndexedPost): Membership => ({ month: p.month, categories: p.categories });

export interface PostIndex {
  get(key: string): Promise<IndexedPost | null>;
  put(p: IndexedPost): Promise<void>;
  remove(key: string): Promise<void>;
  inMonth(month: string): Promise<IndexedPost[]>;
  months(): Promise<{ month: string; count: number }[]>;
  keys(): Promise<string[]>;
  categories(): Promise<string[]>;
  inCategory(token: string): Promise<string[]>;
}

const columns = {
  key: sitePosts.key,
  kind: sitePosts.kind,
  headline: sitePosts.headline,
  summary: sitePosts.summary,
  publishDate: sitePosts.publishDate,
  month: sitePosts.month,
  categories: sitePosts.categories,
};

export function postIndex(db: DbOrTx): PostIndex {
  return {
    async get(key) {
      const [row] = await db.select(columns).from(sitePosts).where(eq(sitePosts.key, key));
      return row ?? null;
    },
    async put(p) {
      const values = { ...p, publishedAt: new Date(p.publishDate), indexedAt: sql`now()` };
      await db.insert(sitePosts).values(values).onConflictDoUpdate({ target: sitePosts.key, set: values });
    },
    async remove(key) {
      await db.delete(sitePosts).where(eq(sitePosts.key, key));
    },
    async inMonth(month) {
      return db.select(columns).from(sitePosts).where(eq(sitePosts.month, month)).orderBy(desc(sitePosts.publishedAt), sql`${sitePosts.key} collate "C" desc`);
    },
    async months() {
      return db
        .select({ month: sitePosts.month, count: sql<number>`count(*)::int` })
        .from(sitePosts)
        .groupBy(sitePosts.month)
        .orderBy(desc(sitePosts.month));
    },
    async keys() {
      return (await db.select({ key: sitePosts.key }).from(sitePosts)).map((r) => r.key);
    },
    async categories() {
      const { rows } = await db.execute<{ c: string }>(sql`SELECT DISTINCT unnest(categories) AS c FROM site_posts ORDER BY 1`);
      return rows.map((r) => r.c);
    },
    async inCategory(token) {
      return (await db.select({ key: sitePosts.key }).from(sitePosts).where(arrayContains(sitePosts.categories, [token])).orderBy(asc(sitePosts.key))).map((r) => r.key);
    },
  };
}
```

- [ ] **Step 10: Run every public-site test; type-check**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/public-site` then the `tsc` command.
Expected: PASS; no type errors.

- [ ] **Step 11: Commit**

```bash
git add apps/public-site
git commit -m "public-site: validated page ids and output paths, the site_posts index and the rebuild-set function"
```

---

### Task 3: News API reads, the release page, home, ministries and category pages

**Review:** shared, paired with Task 4 (template work).

**Files:**
- Modify: `apps/public-site/src/news-api-client.ts`, `apps/public-site/src/news-api-client.test.ts`
- Create: `apps/public-site/src/pages/format.ts`, `pages/release.ts`, `pages/home.ts`, `pages/categories.ts`
- Create: `apps/public-site/src/pages/release.test.ts`, `pages/home.test.ts`, `pages/categories.test.ts`
- Create: `apps/public-site/test/fixtures.ts`
- Modify: `apps/public-site/src/dto.ts` (the category, home, slide, link and related DTOs)
- Modify: `apps/public-site/src/render.ts` (delete `renderPostPage`/`renderHomePage`), `apps/public-site/src/render.test.ts` (delete their tests; the new page tests cover them)

**Interfaces:**
- Consumes: `renderPage`, `e`, `SiteInfo`, `PageOptions` (Task 1); `pageUrl`, `feedUrl`, `categoryPageId`, `parsePageId`, `CategoryKind` (Task 2); `headlineOf` (Task 2).
- Produces:
  - `dto.ts`: `HomeDto { granville: string | null; topPostKey: string | null; featurePostKey: string | null }`; `MinistryDto { key: string; name: string; isActive: boolean; ministerName: string | null; ministryUrl: string | null; contactUser: unknown; secondContactUser: unknown; weekendContactNumber: string | null; topPostKey: string | null; featurePostKey: string | null }`; `MinisterDto { headline: string | null; summary: string | null; details: string | null; photo: string | null }`; `CategoryDto { key: string; kind: string; name: string; isActive: boolean; topPostKey: string | null; featurePostKey: string | null }`; `SlideDto { key: string; headline: string | null; summary: string | null; actionUri: string | null; actionLabel: string | null }`; `ResourceLinkDto { uri: string; key: string }`; `RelatedPost { key: string; headline: string; publishDate: string }`.
  - `news-api-client.ts`: `NewsApiClient` with `getPost`, `latestHome(count)`, `latest(kind: CategoryKind, key: string, count: number): Promise<PostDto[]>`, `home(): Promise<HomeDto>`, `postsByKeys(keys: string[]): Promise<PostDto[]>`, `ministries(): Promise<MinistryDto[]>`, `ministry(key): Promise<MinistryDto | null>`, `minister(key): Promise<MinisterDto | null>`, `categories(kind: Exclude<CategoryKind, "ministries">): Promise<CategoryDto[]>`, `category(kind, key): Promise<CategoryDto | null>`, `slides(): Promise<SlideDto[]>`, `resourceLinks(): Promise<ResourceLinkDto[]>`, `related(key): Promise<RelatedPost[]>`, `postKeys(postKind: string): Promise<string[]>`.
  - `pages/format.ts`: `displayDate(publishDate: string): string`; `postListItem(site, p: { key: string; headline: string; publishDate: string; summary?: string | null }): string`; `demoteHeadings(html: string): string`.
  - `pages/release.ts`: `renderReleasePage(post: PostDto, site: SiteInfo, opts: PageOptions, ctx: { ministryNames: Map<string, string>; related: RelatedPost[] }): string`.
  - `pages/home.ts`: `interface HomeView { top: PostDto | null; feature: PostDto | null; latest: PostDto[]; slides: SlideDto[]; links: ResourceLinkDto[] }`; `renderHomePage(view: HomeView, site, opts): string`.
  - `pages/categories.ts`: `renderMinistriesPage(ministries: MinistryDto[], site, opts): string`; `renderMinistryPage(m: MinistryDto, minister: MinisterDto | null, posts: { top: PostDto | null; feature: PostDto | null; latest: PostDto[] }, site, opts): string`; `renderCategoryPage(kind: Exclude<CategoryKind, "ministries">, c: CategoryDto, posts: { top: PostDto | null; feature: PostDto | null; latest: PostDto[] }, site, opts): string`.
  - Constant `LATEST_COUNT = 20` in `pages/format.ts`.

- [ ] **Step 1: Write the failing client tests**

Extend `apps/public-site/src/news-api-client.test.ts` (it already stubs `fetchImpl`). Add one test per new method asserting the exact URL requested and the parsed result, plus:

```ts
it("latest: an unknown category (404 problem JSON) is an empty list, not an error", async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 404 }), { status: 404 }));
  const c = newsApiClient("http://api.example/", fetchImpl as unknown as typeof fetch);
  expect(await c.latest("ministries", "gone", 20)).toEqual([]);
  expect(fetchImpl.mock.calls[0]![0].toString()).toBe("http://api.example/api/Posts/Latest/ministries/gone?api-version=1.0&count=20");
});

it("related: maps v2 results; a 404 (unpublished meanwhile) is an empty list", async () => {
  const ok = vi.fn(async () => Response.json({ mode: "text", results: [{ key: "K2", kind: "releases", headline: "H", summary: null, publishDate: "2026-10-01T09:00:00-07:00", leadMinistryKey: null, url: "x" }] }));
  expect(await newsApiClient("http://api.example", ok as unknown as typeof fetch).related("K1")).toEqual([{ key: "K2", headline: "H", publishDate: "2026-10-01T09:00:00-07:00" }]);
  expect(ok.mock.calls[0]![0].toString()).toBe("http://api.example/api/v2/posts/K1/related");
  const gone = vi.fn(async () => new Response("{}", { status: 404 }));
  expect(await newsApiClient("http://api.example", gone as unknown as typeof fetch).related("K1")).toEqual([]);
});

it("postKeys: every published key of one kind", async () => {
  const f = vi.fn(async () => Response.json([{ key: "A", value: "stories" }, { key: "B", value: "stories" }]));
  expect(await newsApiClient("http://api.example", f as unknown as typeof fetch).postKeys("stories")).toEqual(["A", "B"]);
  expect(f.mock.calls[0]![0].toString()).toBe("http://api.example/api/Posts/Keys/home/default?api-version=1.0&postKind=stories");
});

it("ministry/category/minister: v1's empty 200 is null", async () => {
  const empty = vi.fn(async () => new Response("", { status: 200 }));
  const c = newsApiClient("http://api.example", empty as unknown as typeof fetch);
  expect(await c.ministry("x")).toBeNull();
  expect(await c.minister("x")).toBeNull();
  expect(await c.category("tags", "x")).toBeNull();
});
```

- [ ] **Step 2: Implement the client**

In `news-api-client.ts`, keep the `get` helper and add a `getOr404` variant that returns `null` on 404; then:

```ts
const v1 = "api-version=1.0";
const enc = encodeURIComponent;
const LATEST_PATH: Record<CategoryKind | "home", string> = { home: "home", ministries: "ministries", sectors: "sectors", themes: "themes", tags: "tags" };
const LIST_PATH = { sectors: "Sectors", themes: "Themes", tags: "Tags" } as const;
return {
  getPost: async (key) => (await get(`api/Posts/${enc(key)}?${v1}`)) as PostDto | null,
  latestHome: async (count) => ((await get(`api/Posts/Latest/home/default?${v1}&count=${count}`)) as PostDto[] | null) ?? [],
  latest: async (kind, key, count) => ((await getOr404(`api/Posts/Latest/${LATEST_PATH[kind]}/${enc(key)}?${v1}&count=${count}`)) as PostDto[] | null) ?? [],
  home: async () => (await get(`api/Home?${v1}`)) as HomeDto,
  postsByKeys: async (keys) => (keys.length ? (((await get(`api/Posts?${v1}&postKeys=${enc(keys.join(","))}`)) as PostDto[] | null) ?? []) : []),
  ministries: async () => ((await get(`api/Ministries?${v1}`)) as MinistryDto[] | null) ?? [],
  ministry: async (key) => (await get(`api/Ministries/${enc(key)}?${v1}`)) as MinistryDto | null,
  minister: async (key) => (await get(`api/Ministries/${enc(key)}/Minister?${v1}`)) as MinisterDto | null,
  categories: async (kind) => ((await get(`api/${LIST_PATH[kind]}?${v1}`)) as CategoryDto[] | null) ?? [],
  category: async (kind, key) => (await get(`api/${LIST_PATH[kind]}/${enc(key)}?${v1}`)) as CategoryDto | null,
  slides: async () => ((await get(`api/Slides?${v1}`)) as SlideDto[] | null) ?? [],
  resourceLinks: async () => ((await get(`api/ResourceLinks?${v1}`)) as ResourceLinkDto[] | null) ?? [],
  related: async (key) => {
    const body = (await getOr404(`api/v2/posts/${enc(key)}/related`)) as { results: { key: string; headline: string; publishDate: string }[] } | null;
    return (body?.results ?? []).map((r) => ({ key: r.key, headline: r.headline, publishDate: r.publishDate }));
  },
  postKeys: async (postKind) => (((await get(`api/Posts/Keys/home/default?${v1}&postKind=${enc(postKind)}`)) as { key: string }[] | null) ?? []).map((r) => r.key),
};
```

`home()`'s type widens from `{ granville }` to `HomeDto`; `rebuild.ts` and `self-heal.ts` only read `granville`, so they still compile. `SlideDto` ignores v1's base64 `image` on purpose (6c-2 Task 5 brings URLs). Run the client tests: PASS.

- [ ] **Step 3: Write the failing page tests**

Create `apps/public-site/test/fixtures.ts` with `site` (`{ name: "BC Gov News", baseUrl: "https://news.example", theme: DEFAULT_THEME }`), a `post(over)` factory (English and French documents, contacts, `ministryKeys: ["health"]`, `tagKeys: ["covid-19"]`, one PNG asset `{ key: "https://files.example/files/a.png", label: "Clinic <photo>", length: 1234 }`, one PDF asset `{ key: "https://files.example/files/doc.pdf", label: "Backgrounder", length: 1229 }`, one translation `{ key: "https://files.example/files/fr.pdf", label: "Français", length: 999 }`), and `ministry(over)`, `category(over)`, `slide(over)`, `link(over)` factories with fictional names (`Minister Alex Example`).

Create `apps/public-site/src/pages/release.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { expectAccessibleStructure } from "../../test/structure";
import { post, site } from "../../test/fixtures";
import { renderReleasePage } from "./release";

const ctx = { ministryNames: new Map([["health", "Health"]]), related: [{ key: "K2", headline: "Other <news>", publishDate: "2026-10-01T09:00:00-07:00" }] };

describe("release page", () => {
  it("is accessible: one h1 (the headline), escaped, with the trusted body", () => {
    const html = renderReleasePage(post({ documents: [{ languageId: 4105, headline: "Clinics <script>x</script>", subheadline: "Sub & more", detailsHtml: "<p>Body.</p>", contacts: [] }] }), site, {}, ctx);
    const doc = expectAccessibleStructure(html);
    expect(doc.querySelector("h1")?.textContent).toBe("Clinics <script>x</script>");
    expect(html).not.toContain("<script>x</script>");
    expect(doc.querySelector("main p.subheadline")?.textContent).toBe("Sub & more");
    expect(html).toContain("<p>Body.</p>");
  });

  it("demotes body headings so the page keeps one h1", () => {
    const html = renderReleasePage(post({ documents: [{ languageId: 4105, headline: "H", subheadline: null, detailsHtml: "<H1 class=\"x\">Inner</H1><h2>Two</h2><h6>Six</h6>", contacts: [] }] }), site, {}, ctx);
    const doc = expectAccessibleStructure(html);
    expect(doc.querySelectorAll("h1")).toHaveLength(1);
    expect(html).toContain('<h2 class="x">Inner</h2>');
    expect(html).toContain("<h3>Two</h3>");
    expect(html).toContain("<h6>Six</h6>");
  });

  it("shows the date, location, ministry link, contacts, assets, translations and related posts", () => {
    const doc = expectAccessibleStructure(renderReleasePage(post({}), site, {}, ctx));
    expect(doc.querySelector("main time")?.getAttribute("datetime")).toBe("2026-10-03T10:00:00-07:00");
    expect(doc.querySelector("main time")?.textContent).toBe("October 3, 2026");
    expect(doc.querySelector('a[href="/ministries/health/"]')?.textContent).toBe("Health");
    const img = doc.querySelector("figure img")!;
    expect(img.getAttribute("alt")).toBe("");
    expect(doc.querySelector("figure figcaption")?.textContent).toBe("Clinic <photo>");
    expect(doc.querySelector('a[href="https://files.example/files/doc.pdf"]')?.textContent).toContain("PDF");
    expect(doc.querySelector('a[href="https://files.example/files/fr.pdf"]')?.textContent).toContain("Français");
    expect([...doc.querySelectorAll("section h2")].map((h) => h.textContent)).toEqual(["Contacts", "Media assets", "Translations", "Related news"]);
    expect(doc.querySelector('a[href="/releases/K2/"]')?.textContent).toBe("Other <news>");
  });

  it("leaves out empty sections and an unknown ministry", () => {
    const doc = expectAccessibleStructure(renderReleasePage(post({ ministryKeys: ["nope"], azureAssets: null, azureTranslations: null, documents: [{ languageId: 4105, headline: "H", subheadline: null, detailsHtml: null, contacts: [] }] }), site, {}, { ministryNames: new Map(), related: [] }));
    expect(doc.querySelectorAll("section")).toHaveLength(0);
    expect(doc.querySelector('main a[href^="/ministries/"]')).toBeNull();
  });

  it("escapes every interpolated field (asset labels, contacts, location)", () => {
    const html = renderReleasePage(post({ location: "A & <B>", documents: [{ languageId: 4105, headline: "H", subheadline: null, detailsHtml: null, contacts: [{ title: "<b>T</b>", details: "x\n<y>" }] }] }), site, {}, ctx);
    expect(html).toContain("A &amp; &lt;B&gt;");
    expect(html).toContain("&lt;b&gt;T&lt;/b&gt;");
    expect(html).toContain("x<br>&lt;y&gt;");
    expect(html).toContain("Clinic &lt;photo&gt;");
  });
});
```

Create `apps/public-site/src/pages/home.test.ts` with tests that: the page is accessible with `h1` "Latest news" (visually the site name sits in the header); top and feature posts appear first under "Top story" and "Featured" `h2`s; `latest` renders as `ul.post-list` with links `/releases/<key>/`; slides render as `section[aria-labelledby]` "Highlights" with one `article` per slide, the headline as `h3`, the action link only when `actionUri` is set (link text `actionLabel` or "Learn more"); no `<script>` anywhere on the page (the carousel doesn't rotate, C205); resource links list escaped; a slide headline `<img src=x onerror=alert(1)>` is escaped; the feed alternate link is `/feed.xml`.

Create `apps/public-site/src/pages/categories.test.ts` with tests that:
- `renderMinistriesPage` lists only `isActive` ministries in the API's order, each with its minister's name, linking `/ministries/<lowercased key>/`; a ministry whose key fails `categoryPageId` is left out; h1 "Ministries".
- `renderMinistryPage`: h1 is the ministry name; minister section with `summary` text escaped and `details` HTML trusted, through `demoteHeadings`; the photo `img` alt is the minister's name; ministry URL link; top/feature/latest posts; links to `/archive/` and `/search/?ministry=<key>`; feed alternate `/ministries/<key>/feed.xml`.
- `renderCategoryPage("sectors", …)`: h1 name; latest list; archive link; search link `/search/?sector=<key>`; `renderCategoryPage("tags", …)` has the archive link and no search link.
- Each page passes `expectAccessibleStructure`; a ministry name `A & <B>` is escaped.

- [ ] **Step 4: Run them and see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/public-site/src/pages`
Expected: FAIL — `Failed to resolve import "./release"`.

- [ ] **Step 5: Implement the formatting helpers and pages**

`apps/public-site/src/pages/format.ts`:

```ts
import { e, type SiteInfo } from "../render";
import { pageUrl } from "../site-paths";

export const LATEST_COUNT = 20;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "October 3, 2026" from the News API's BC-local date: the calendar date as written, no time-zone maths. */
export function displayDate(publishDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(publishDate);
  if (!m) return publishDate;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

export const monthName = (month: string) => `${MONTHS[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}`;

export function postListItem(site: Pick<SiteInfo, "baseUrl">, p: { key: string; headline: string; publishDate: string; summary?: string | null }): string {
  const summary = p.summary ? `<p>${e(p.summary)}</p>` : "";
  return `<li><a href="${e(pageUrl(site, { type: "post", key: p.key }))}">${e(p.headline)}</a> <time datetime="${e(p.publishDate)}">${e(displayDate(p.publishDate))}</time>${summary}</li>`;
}

/** h1→h2 … h5→h6 (h6 stays), so staff HTML inside a page never adds a second h1. */
export function demoteHeadings(html: string): string {
  return html.replace(/<(\/?)h([1-6])(?=[\s>])/gi, (_m, slash: string, level: string) => `<${slash}h${Math.min(Number(level) + 1, 6)}`);
}
```

`pages/release.ts` renders, in order: `<article>` with `<h1>` headline, optional `<p class="subheadline">`, a meta line (`<time datetime=… >displayDate</time>`, location, lead ministry name linked when `ministryNames` has it — the lead is `leadMinistryKey ?? ministryKeys[0]`, matched case-insensitively, and the link comes from `categoryPageId`), the body through `demoteHeadings`, then `<section>`s only when non-empty: "Contacts" (existing contact markup, escaped, `\n`→`<br>`), "Media assets" (an asset whose URL ends `.png`, `.jpg` or `.jpeg` is a `<figure><img src alt=""><figcaption>label</figcaption></figure>` — §6.3: the asset data has no alt text, so the image is decorative and its label is the caption; any other asset is a link `label (PDF, 1.2 KB)` with the type from the extension), "Translations" (links with the label), "Related news" (`ul.post-list` of `postListItem`). Description meta: the post summary. Canonical: `pageUrl(site, { type: "post", key })`. Title: the headline.

`pages/home.ts`: `<h1>Latest news</h1>`; "Top story" and "Featured" (`h2`, each one `.card` with the headline link, date and summary) when present; "Highlights" `section` with `aria-labelledby="highlights-heading"` and one `<article class="card">` per slide (`h3` headline, summary `p`, optional action link) — no images in 6c-1; "More news" `ul.post-list` from `latest`; "Resources" `ul` of resource links (`uri`, `key` as the label). Feed: `{ href: feedUrl(site, { type: "home" }), title: \`${site.name}: latest news\` }`.

`pages/categories.ts`: as the tests describe. The archive and search links:

```ts
const SEARCH_FILTER: Partial<Record<CategoryKind, string>> = { ministries: "ministry", sectors: "sector" };
// …
const filter = SEARCH_FILTER[kind];
const more = `<p><a href="${e(basePath(site))}/archive/">Browse the archive by month</a>${filter ? ` or <a href="${e(basePath(site))}/search/?${filter}=${e(encodeURIComponent(key))}">search ${e(name)} news</a>` : ""}.</p>`;
```

Ministry contacts (`contactUser`, `secondContactUser`) are objects whose shape comes from Core's org record; render only their string fields `name`, `title`, `phone`, `email` when present, each escaped, in a "Media contacts" section, and leave the section out when neither has any.

Delete `renderPostPage` and `renderHomePage` from `render.ts`, and their tests in `render.test.ts`. `rebuild.ts` and `self-heal.ts` still import them until Task 5; to keep this task's commit compiling, change those two imports to the new functions with the smallest shim: in `rebuild.ts` and `self-heal.ts`, call `renderReleasePage(post, site, opts, { ministryNames: new Map(), related: [] })` and `renderHomePage({ top: null, feature: null, latest: posts, slides: [], links: [] }, site, opts)`. Task 5 replaces both files' rendering with the builder.

- [ ] **Step 6: Run the tests; type-check**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/public-site` and `tsc`.
Expected: PASS (the existing `rebuild.test.ts`/`self-heal.test.ts` expectations on page markup may need their string checks updated from `href="/releases/K1"` to `href="/releases/K1/"`; change only those strings).

- [ ] **Step 7: Commit**

```bash
git add apps/public-site
git commit -m "public-site: release, home, ministries and category pages from the News API"
```

---

### Task 4: Monthly archives, RSS feeds and sitemaps

**Review:** shared, paired with Task 3 (template work).

**Files:**
- Create: `apps/public-site/src/pages/archive.ts`, `pages/archive.test.ts`
- Create: `apps/public-site/src/feeds.ts`, `feeds.test.ts`
- Create: `apps/public-site/src/sitemaps.ts`, `sitemaps.test.ts`

**Interfaces:**
- Consumes: `IndexedPost` (Task 2); `PostDto`, `headlineOf` (Task 2); `displayDate`, `monthName`, `postListItem` (Task 3); `pageUrl`, `absoluteUrl` (Task 2).
- Produces:
  - `pages/archive.ts`: `renderArchiveIndex(months: { month: string; count: number }[], site, opts): string`; `renderArchiveMonth(month: string, posts: IndexedPost[], site, opts): string`.
  - `feeds.ts`: `renderRssFeed(channel: { title: string; pagePath: string; feedPath: string; description: string }, posts: PostDto[], site: SiteInfo): string`.
  - `sitemaps.ts`: `renderSitemapIndex(sitemapPaths: string[], site): string`; `renderUrlSet(entries: { path: string; lastmod?: string }[], site): string`.

- [ ] **Step 1: Write the failing tests**

`pages/archive.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { expectAccessibleStructure } from "../../test/structure";
import { site } from "../../test/fixtures";
import { renderArchiveIndex, renderArchiveMonth } from "./archive";

describe("archives", () => {
  it("the index groups months by year, newest first, with counts", () => {
    const doc = expectAccessibleStructure(renderArchiveIndex([{ month: "2026-10", count: 12 }, { month: "2026-09", count: 1 }, { month: "2025-12", count: 3 }], site, {}));
    expect(doc.querySelector("h1")?.textContent).toBe("News archive");
    expect([...doc.querySelectorAll("h2")].map((h) => h.textContent)).toEqual(["2026", "2025"]);
    expect([...doc.querySelectorAll("main li")].map((li) => li.textContent)).toEqual(["October 2026 (12 posts)", "September 2026 (1 post)", "December 2025 (3 posts)"]);
    expect(doc.querySelector('a[href="/archive/2026/10/"]')).not.toBeNull();
  });
  it("an empty index says so", () => {
    expect(expectAccessibleStructure(renderArchiveIndex([], site, {})).querySelector("main p")?.textContent).toBe("Nothing has been published yet.");
  });
  it("a month lists its posts in the given order, escaped", () => {
    const doc = expectAccessibleStructure(renderArchiveMonth("2026-10", [
      { key: "B", kind: "releases", headline: "B <i>", summary: null, publishDate: "2026-10-05T09:00:00-07:00", month: "2026-10", categories: [] },
      { key: "A", kind: "stories", headline: "A", summary: "S", publishDate: "2026-10-01T09:00:00-07:00", month: "2026-10", categories: [] },
    ], site, {}));
    expect(doc.querySelector("h1")?.textContent).toBe("News from October 2026");
    expect([...doc.querySelectorAll("main ul.post-list a")].map((a) => a.textContent)).toEqual(["B <i>", "A"]);
    expect(doc.querySelector('a[href="/archive/"]')?.textContent).toBe("All months");
  });
});
```

`feeds.test.ts`:

```ts
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { post, site } from "../test/fixtures";
import { renderRssFeed } from "./feeds";

describe("RSS 2.0 feeds", () => {
  const xml = renderRssFeed({ title: "Health & <news>", pagePath: "/ministries/health/", feedPath: "/ministries/health/feed.xml", description: "Latest" }, [
    post({ key: "K1", summary: "S & <b>", documents: [{ languageId: 4105, headline: "Clinics <open>", subheadline: null, detailsHtml: null, contacts: [] }] }),
  ], site);

  it("is well-formed RSS 2.0 with absolute links and RFC 822 dates", () => {
    const doc = new JSDOM(xml, { contentType: "application/xml" }).window.document;
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.documentElement.getAttribute("version")).toBe("2.0");
    expect(doc.querySelector("channel > title")?.textContent).toBe("Health & <news>");
    expect(doc.querySelector("channel > link")?.textContent).toBe("https://news.example/ministries/health/");
    const item = doc.querySelector("item")!;
    expect(item.querySelector("title")?.textContent).toBe("Clinics <open>");
    expect(item.querySelector("link")?.textContent).toBe("https://news.example/releases/K1/");
    expect(item.querySelector("guid")?.getAttribute("isPermaLink")).toBe("true");
    expect(item.querySelector("pubDate")?.textContent).toBe("Sat, 03 Oct 2026 17:00:00 GMT");
    expect(item.querySelector("description")?.textContent).toBe("S & <b>");
  });
  it("escapes feed and sitemap text: no raw markup in the XML", () => {
    expect(xml).not.toContain("<open>");
    expect(xml).not.toContain("<b>");
  });
  it("caps at 20 items", () => {
    const many = Array.from({ length: 25 }, (_, i) => post({ key: `K${i}` }));
    expect(renderRssFeed({ title: "t", pagePath: "/", feedPath: "/feed.xml", description: "d" }, many, site).match(/<item>/g)).toHaveLength(20);
  });
});
```

`sitemaps.test.ts`: `renderSitemapIndex(["/sitemaps/pages.xml", "/sitemaps/2026-10.xml"], site)` parses as XML with `sitemapindex` root (namespace `http://www.sitemaps.org/schemas/sitemap/0.9`) and two absolute `loc`s; `renderUrlSet([{ path: "/releases/K1/", lastmod: "2026-10-03T10:00:00-07:00" }, { path: "/a&b/" }], site)` has `urlset`, absolute escaped `loc` (`https://news.example/a&amp;b/` in the raw text), `lastmod` `2026-10-03` (date only, W3C format), and no `lastmod` on the second.

- [ ] **Step 2: Run them and see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/public-site/src/pages/archive.test.ts apps/public-site/src/feeds.test.ts apps/public-site/src/sitemaps.test.ts`
Expected: FAIL — unresolved imports.

- [ ] **Step 3: Implement**

`feeds.ts`:

```ts
import type { PostDto } from "./dto";
import { headlineOf } from "./post-index";
import { e, type SiteInfo } from "./render";
import { absoluteUrl, pageUrl } from "./site-paths";
import { LATEST_COUNT } from "./pages/format";

/** spec §6.1: RSS 2.0, the latest 20. escapeHtml's five entities are all valid XML. */
export function renderRssFeed(channel: { title: string; pagePath: string; feedPath: string; description: string }, posts: PostDto[], site: SiteInfo): string {
  const items = posts.slice(0, LATEST_COUNT).map((p) => {
    const link = absoluteUrl(site, pageUrl(site, { type: "post", key: p.key }));
    const date = new Date(p.publishDate);
    const pubDate = Number.isNaN(date.getTime()) ? "" : `\n<pubDate>${date.toUTCString()}</pubDate>`;
    const description = p.summary ? `\n<description>${e(p.summary)}</description>` : "";
    return `<item>\n<title>${e(headlineOf(p))}</title>\n<link>${e(link)}</link>\n<guid isPermaLink="true">${e(link)}</guid>${pubDate}${description}\n</item>`;
  });
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>${e(channel.title)}</title>
<link>${e(absoluteUrl(site, channel.pagePath))}</link>
<description>${e(channel.description)}</description>
<language>en-ca</language>
<atom:link href="${e(absoluteUrl(site, channel.feedPath))}" rel="self" type="application/rss+xml"/>
${items.join("\n")}
</channel>
</rss>
`;
}
```

`sitemaps.ts`:

```ts
import { e, type SiteInfo } from "./render";
import { absoluteUrl } from "./site-paths";

const NS = "http://www.sitemaps.org/schemas/sitemap/0.9";

export function renderSitemapIndex(sitemapPaths: string[], site: SiteInfo): string {
  const entries = sitemapPaths.map((p) => `<sitemap><loc>${e(absoluteUrl(site, p))}</loc></sitemap>`).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>\n<sitemapindex xmlns="${NS}">\n${entries}\n</sitemapindex>\n`;
}

export function renderUrlSet(entries: { path: string; lastmod?: string }[], site: SiteInfo): string {
  const urls = entries
    .map((u) => `<url><loc>${e(absoluteUrl(site, u.path))}</loc>${u.lastmod && /^\d{4}-\d{2}-\d{2}/.test(u.lastmod) ? `<lastmod>${u.lastmod.slice(0, 10)}</lastmod>` : ""}</url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>\n<urlset xmlns="${NS}">\n${urls}\n</urlset>\n`;
}
```

`pages/archive.ts`: as the tests describe; months grouped by `month.slice(0, 4)` under `h2`; `1 post` / `n posts`; the month page uses `postListItem` with the indexed headline and summary and a link back "All months". Canonicals: `pageUrl(site, { type: "archive" })` and `{ type: "archive-month", month }`.

- [ ] **Step 4: Run them; type-check; commit**

Run the three test files: PASS. `tsc`: clean.

```bash
git add apps/public-site
git commit -m "public-site: monthly archives, RSS 2.0 feeds and sitemaps"
```

---

### Task 5: The builder — rendering by page id, the rebuild on events and at startup, and the E2E check

**Review:** full (storage writes and removals; the rebuild set wired to real data).

**Files:**
- Create: `apps/public-site/src/builder.ts`, `apps/public-site/src/builder.test.ts`
- Modify: `apps/public-site/src/rebuild.ts`, `apps/public-site/src/rebuild.test.ts`
- Modify: `apps/public-site/src/self-heal.ts`, `apps/public-site/src/self-heal.test.ts`
- Modify: `apps/public-site/src/start.ts`, `apps/public-site/src/start.test.ts`
- Create: `tests/e2e/public-site.spec.ts`
- Docs: `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`, `docs/parity/changes-from-legacy.md`, `docs/parity/open-questions.md`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces (6c-2 builds on these exact names):
  - `builder.ts`: `interface SiteBuilder { renderPage(pageId: string, opts: PageOptions, run?: RunCache): Promise<string[]>; rebuild(pageIds: string[], opts: PageOptions): Promise<void>; buildAll(opts: PageOptions): Promise<{ posts: number; failures: number }>; allPostKeys(): Promise<string[]>; aggregatePageIds(): Promise<string[]> }`; `interface RunCache { ministries?: Promise<MinistryDto[]> }`; `createSiteBuilder(deps: { newsApi: NewsApiClient; storage: SiteStorage; index: PostIndex; site: SiteInfo; assetsDir: string | null }): SiteBuilder`; `POST_KINDS = ["releases", "stories", "factsheets", "updates", "advisories"] as const` (the News API's `postKindSchema`).
  - `rebuild.ts` keeps: `SITE_STATE_PATH`, `RENDER_CHROME_VERSION` (now 3), `SiteRenderState`, `stateAndBanner`, `tryHome`, `enqueueSiteWrite`; adds `chromeChanged(storage: SiteStorage, state: SiteRenderState, site: SiteInfo): Promise<boolean>` and `writeSiteState(storage, state, site): Promise<void>` (exported); `createRebuildHandler(deps: { builder: SiteBuilder; newsApi: NewsApiClient; storage: SiteStorage; site: SiteInfo; test: boolean }): EventHandler`. Removes `resyncPostPages`, `renderExistingPost`, `HOME_COUNT`, and `POST_KEY`/`postPath` (now in `site-paths.ts`).
  - `self-heal.ts`: `selfHeal(deps: { builder: SiteBuilder; newsApi: NewsApiClient; storage: SiteStorage; site: SiteInfo; test: boolean }): Promise<{ rebuilt: number } | null>`.

- [ ] **Step 1: Write the failing builder tests**

Create `apps/public-site/src/builder.test.ts`. It uses a real test database for the index (`createPublicSiteTestDb`), `memoryStorage()`, and a fake `NewsApiClient` built from an in-memory map of posts and categories:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createPublicSiteTestDb } from "../test/helpers";
import { memoryStorage } from "../test/memory-storage";
import { ministry, post, site } from "../test/fixtures";
import { createSiteBuilder } from "./builder";
import type { PostDto } from "./dto";
import type { NewsApiClient } from "./news-api-client";
import { postIndex } from "./post-index";

function fakeApi(posts: Map<string, PostDto>): NewsApiClient & { calls: string[] } {
  const calls: string[] = [];
  const published = () => [...posts.values()].sort((a, b) => b.publishDate.localeCompare(a.publishDate));
  const inCat = (field: "ministryKeys" | "sectorKeys" | "themeKeys" | "tagKeys", key: string) => published().filter((p) => (p[field] ?? []).some((k) => k.toLowerCase() === key.toLowerCase()));
  return {
    calls,
    getPost: async (key) => { calls.push(`getPost:${key}`); return posts.get(key) ?? null; },
    latestHome: async (n) => published().slice(0, n),
    latest: async (kind, key, n) => inCat(({ ministries: "ministryKeys", sectors: "sectorKeys", themes: "themeKeys", tags: "tagKeys" } as const)[kind], key).slice(0, n),
    home: async () => ({ granville: null, topPostKey: null, featurePostKey: null }),
    postsByKeys: async (keys) => keys.map((k) => posts.get(k)).filter((p): p is PostDto => !!p),
    ministries: async () => [ministry({ key: "health", name: "Health" }), ministry({ key: "finance", name: "Finance" })],
    ministry: async (key) => (["health", "finance"].includes(key.toLowerCase()) ? ministry({ key: key.toLowerCase(), name: key }) : null),
    minister: async () => null,
    categories: async () => [],
    category: async (_kind, key) => (key === "covid-19" ? { key, kind: "tags", name: "COVID-19", isActive: true, topPostKey: null, featurePostKey: null } : null),
    slides: async () => [],
    resourceLinks: async () => [],
    related: async () => [],
    postKeys: async (kind) => [...posts.values()].filter((p) => p.kind === kind).map((p) => p.key),
  };
}

describe("site builder", () => {
  let tdb: TestDatabase;
  beforeAll(async () => { tdb = await createPublicSiteTestDb(); });
  afterAll(async () => { await tdb.drop(); });
  beforeEach(async () => { await tdb.pool.query("TRUNCATE site_posts"); });

  const setup = (posts: Map<string, PostDto>) => {
    const storage = memoryStorage();
    const api = fakeApi(posts);
    const builder = createSiteBuilder({ newsApi: api, storage, index: postIndex(tdb.db), site, assetsDir: null });
    return { storage, api, builder };
  };
  const html = (s: ReturnType<typeof memoryStorage>, path: string) => String(s.files.get(path) ?? "");

  it("a published post: its page, then home, ministry, tag, month archive, archive index and sitemaps", async () => {
    const { storage, builder } = setup(new Map([["K1", post({ key: "K1", ministryKeys: ["Health"], tagKeys: ["covid-19"] })]]));
    await builder.rebuild(["home", "post:K1"], {});
    for (const f of ["releases/K1/index.html", "index.html", "feed.xml", "ministries/health/index.html", "ministries/health/feed.xml", "tags/covid-19/index.html", "archive/index.html", "archive/2026/10/index.html", "sitemap.xml", "sitemaps/2026-10.xml"]) {
      expect(storage.files.has(f), f).toBe(true);
    }
    expect(html(storage, "ministries/health/index.html")).toContain('href="/releases/K1/"');
    expect(html(storage, "archive/2026/10/index.html")).toContain('href="/releases/K1/"');
    expect(html(storage, "sitemaps/2026-10.xml")).toContain("https://news.example/releases/K1/");
  });

  it("an update that moves a post to another ministry takes it off the old ministry page", async () => {
    const posts = new Map([["K1", post({ key: "K1", ministryKeys: ["health"] })]]);
    const { storage, builder } = setup(posts);
    await builder.rebuild(["post:K1"], {});
    posts.set("K1", post({ key: "K1", ministryKeys: ["finance"], publishDate: "2026-11-02T10:00:00-07:00" }));
    await builder.rebuild(["post:K1"], {});
    expect(html(storage, "ministries/health/index.html")).not.toContain("/releases/K1/");
    expect(html(storage, "ministries/finance/index.html")).toContain("/releases/K1/");
    expect(storage.files.has("archive/2026/10/index.html")).toBe(false);
    expect(html(storage, "archive/2026/11/index.html")).toContain("/releases/K1/");
  });

  it("unpublishing removes the release page and its entries", async () => {
    const posts = new Map([["K1", post({ key: "K1" })], ["K2", post({ key: "K2", publishDate: "2026-09-01T10:00:00-07:00" })]]);
    const { storage, builder } = setup(posts);
    await builder.rebuild(["post:K1", "post:K2"], {});
    posts.delete("K1");
    await builder.rebuild(["post:K1"], {});
    expect(storage.files.has("releases/K1/index.html")).toBe(false);
    expect(storage.files.has("archive/2026/10/index.html")).toBe(false);
    expect(storage.files.has("sitemaps/2026-10.xml")).toBe(false);
    expect(html(storage, "archive/index.html")).not.toContain("October 2026");
    expect(html(storage, "index.html")).not.toContain("/releases/K1/");
    expect(html(storage, "ministries/health/index.html")).not.toContain("/releases/K1/");
    expect(html(storage, "sitemap.xml")).not.toContain("2026-10.xml");
  });

  it("a category the News API no longer has loses its page and feed", async () => {
    const { storage, builder } = setup(new Map());
    await storage.write("tags/gone/index.html", "x");
    await storage.write("tags/gone/feed.xml", "x");
    await builder.rebuild(["category:tags:gone"], {});
    expect(storage.files.has("tags/gone/index.html")).toBe(false);
    expect(storage.files.has("tags/gone/feed.xml")).toBe(false);
  });

  it("skips (and never writes for) an invalid page id", async () => {
    const { storage, builder } = setup(new Map());
    await builder.rebuild(["post:../../etc", "category:ministries:../x", "bogus"], {});
    expect(storage.files.size).toBe(0);
  });

  it("a News API key that differs from the requested one is skipped, not written", async () => {
    const { storage, builder } = setup(new Map([["K1", post({ key: ".." })]]));
    await builder.rebuild(["post:K1"], {});
    expect(storage.files.has("releases/K1/index.html")).toBe(false);
  });

  it("a related-posts failure doesn't block the release page", async () => {
    const { storage, api, builder } = setup(new Map([["K1", post({ key: "K1" })]]));
    api.related = async () => { throw new Error("News API 500"); };
    await builder.rebuild(["post:K1"], {});
    expect(storage.files.has("releases/K1/index.html")).toBe(true);
  });

  it("buildAll renders every published key, removes pages for keys no longer published, then every aggregate", async () => {
    const { storage, builder } = setup(new Map([["K1", post({ key: "K1" })], ["S1", post({ key: "S1", kind: "stories" })]]));
    await storage.write("releases/OLD/index.html", "stale");
    const r = await builder.buildAll({});
    expect(r).toEqual({ posts: 3, failures: 0 });
    expect(storage.files.has("releases/OLD/index.html")).toBe(false);
    for (const f of ["releases/K1/index.html", "releases/S1/index.html", "index.html", "ministries/index.html", "ministries/health/index.html", "ministries/finance/index.html", "archive/index.html", "sitemap.xml", "sitemaps/pages.xml", "assets/theme.css", "robots.txt", "404.html"]) {
      expect(storage.files.has(f), f).toBe(true);
    }
  });

  it("every generated HTML page passes the structure check", async () => {
    const { storage, builder } = setup(new Map([["K1", post({ key: "K1" })]]));
    await builder.buildAll({ test: true });
    const { expectAccessibleStructure } = await import("../test/structure");
    for (const [path, content] of storage.files) {
      if (path.endsWith(".html")) {
        expectAccessibleStructure(String(content));
        expect(String(content), path).toContain('<meta name="robots" content="noindex, nofollow">');
      }
    }
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/public-site/src/builder.test.ts`
Expected: FAIL — `Failed to resolve import "./builder"`.

- [ ] **Step 3: Implement the builder**

Create `apps/public-site/src/builder.ts`:

```ts
import { safeErrorLabel } from "@gcpe/http-kit";
import type { MinistryDto, PostDto } from "./dto";
import { renderRssFeed } from "./feeds";
import type { NewsApiClient } from "./news-api-client";
import { renderArchiveIndex, renderArchiveMonth } from "./pages/archive";
import { renderCategoryPage, renderMinistriesPage, renderMinistryPage } from "./pages/categories";
import { LATEST_COUNT } from "./pages/format";
import { renderHomePage } from "./pages/home";
import { renderReleasePage } from "./pages/release";
import { indexEntryOf, membershipOfEntry, type PostIndex } from "./post-index";
import { dependentPages, membershipOf } from "./rebuild-set";
import type { PageOptions, SiteInfo } from "./render";
import { categoryPageId, CATEGORY_KINDS, feedUrl, formatPageId, pageFiles, pageUrl, parsePageId, POST_KEY, type CategoryKind, type PageId } from "./site-paths";
import { renderSitemapIndex, renderUrlSet } from "./sitemaps";
import { writeStaticPages } from "./static-pages";
import type { SiteStorage } from "./storage";

/** The News API's post kinds (packages/events postKindSchema). */
export const POST_KINDS = ["releases", "stories", "factsheets", "updates", "advisories"] as const;

/** Per-run memo, so a run rendering many pages fetches the ministry list once. */
export interface RunCache {
  ministries?: Promise<MinistryDto[]>;
}

export interface SiteBuilder {
  /** Renders (or removes) one page; returns the ids that now need rebuilding because of it. */
  renderPage(pageId: string, opts: PageOptions, run?: RunCache): Promise<string[]>;
  /** Renders the given pages, then their dependents. The first failure is logged and rethrown. */
  rebuild(pageIds: string[], opts: PageOptions): Promise<void>;
  /** Every post page, then every aggregate page (spec §6.2's "templates change" row). */
  buildAll(opts: PageOptions): Promise<{ posts: number; failures: number }>;
  /** Every key with a page today or due one: the News API's published keys, the index and the disk. */
  allPostKeys(): Promise<string[]>;
  /** Every non-post page id the site has (home, indexes, categories, months, sitemaps, static). */
  aggregatePageIds(): Promise<string[]>;
}

export function createSiteBuilder(deps: { newsApi: NewsApiClient; storage: SiteStorage; index: PostIndex; site: SiteInfo; assetsDir: string | null }): SiteBuilder {
  const { newsApi, storage, index, site } = deps;
  const ministries = (run: RunCache) => (run.ministries ??= newsApi.ministries());
  const removeAll = async (p: PageId) => {
    for (const f of pageFiles(p)) await storage.remove(f);
  };
  const featured = async (top: string | null, feature: string | null) => {
    const found = await newsApi.postsByKeys([top, feature].filter((k): k is string => !!k));
    const pick = (k: string | null) => (k ? (found.find((p) => p.key.toLowerCase() === k.toLowerCase()) ?? null) : null);
    return { top: pick(top), feature: pick(feature) };
  };

  async function renderPost(key: string, opts: PageOptions, run: RunCache): Promise<string[]> {
    const p: PageId = { type: "post", key };
    const before = await index.get(key);
    const post = await newsApi.getPost(key);
    if (!post) {
      await removeAll(p);
      await index.remove(key);
      return dependentPages(before ? membershipOfEntry(before) : null, null);
    }
    // The output path always uses the requested key; a News API key that differs other than by
    // case (e.g. "..") is skipped, never trusted.
    if (post.key.toLowerCase() !== key.toLowerCase()) {
      console.warn(`[public-site] skipping page post:${key}: the News API returned a different key`);
      return [];
    }
    let related: Awaited<ReturnType<NewsApiClient["related"]>> = [];
    try {
      related = await newsApi.related(key);
    } catch (err) {
      console.error(`[public-site] related posts unavailable for post:${key} ${safeErrorLabel(err)}`);
    }
    const ministryNames = new Map((await ministries(run)).map((m) => [m.key.toLowerCase(), m.name]));
    await storage.write(pageFiles(p)[0]!, renderReleasePage(post, site, opts, { ministryNames, related }));
    const entry = indexEntryOf(key, post);
    if (entry) await index.put(entry);
    else await index.remove(key);
    return dependentPages(before ? membershipOfEntry(before) : null, membershipOf(post));
  }

  async function renderCategory(kind: CategoryKind, key: string, opts: PageOptions): Promise<void> {
    const p: PageId = { type: "category", kind, key };
    const [page, feed] = pageFiles(p) as [string, string];
    const feedRef = { href: feedUrl(site, p), title: "" };
    if (kind === "ministries") {
      const m = await newsApi.ministry(key);
      if (!m) return removeAll(p);
      const [minister, latest, f] = await Promise.all([newsApi.minister(key), newsApi.latest(kind, key, LATEST_COUNT), featured(m.topPostKey, m.featurePostKey)]);
      feedRef.title = `${m.name}: latest news`;
      await storage.write(page, renderMinistryPage(m, minister, { ...f, latest }, site, { ...opts, feed: feedRef }));
      await storage.write(feed, renderRssFeed({ title: feedRef.title, pagePath: pageUrl(site, p), feedPath: feedRef.href, description: `News from ${m.name}` }, sortNewest([f.top, f.feature, ...latest]), site));
      return;
    }
    const c = await newsApi.category(kind, key);
    if (!c) return removeAll(p);
    const [latest, f] = await Promise.all([newsApi.latest(kind, key, LATEST_COUNT), featured(c.topPostKey, c.featurePostKey)]);
    feedRef.title = `${c.name}: latest news`;
    await storage.write(page, renderCategoryPage(kind, c, { ...f, latest }, site, { ...opts, feed: feedRef }));
    await storage.write(feed, renderRssFeed({ title: feedRef.title, pagePath: pageUrl(site, p), feedPath: feedRef.href, description: `News about ${c.name}` }, sortNewest([f.top, f.feature, ...latest]), site));
  }

  async function categoryIds(run: RunCache): Promise<string[]> {
    const ids = new Set<string>();
    for (const m of await ministries(run)) {
      const id = categoryPageId("ministries", m.key);
      if (id) ids.add(id);
    }
    for (const kind of CATEGORY_KINDS) {
      if (kind === "ministries") continue;
      for (const c of await newsApi.categories(kind)) {
        const id = categoryPageId(kind, c.key);
        if (id) ids.add(id);
      }
    }
    for (const token of await index.categories()) ids.add(`category:${token}`);
    return [...ids].sort();
  }

  const builder: SiteBuilder = {
    async renderPage(pageId, opts, run = {}) {
      const p = parsePageId(pageId);
      if (!p) {
        console.warn(`[public-site] skipping unknown page id ${JSON.stringify(pageId)}`);
        return [];
      }
      switch (p.type) {
        case "post":
          return renderPost(p.key, opts, run);
        case "home": {
          const home = await newsApi.home();
          const [f, latest, slides, links] = await Promise.all([featured(home.topPostKey, home.featurePostKey), newsApi.latestHome(LATEST_COUNT), newsApi.slides(), newsApi.resourceLinks()]);
          const feedRef = { href: feedUrl(site, p), title: `${site.name}: latest news` };
          await storage.write("index.html", renderHomePage({ ...f, latest, slides, links }, site, { ...opts, feed: feedRef }));
          await storage.write("feed.xml", renderRssFeed({ title: feedRef.title, pagePath: pageUrl(site, p), feedPath: feedRef.href, description: `The latest news from ${site.name}` }, sortNewest([f.top, f.feature, ...latest]), site));
          return [];
        }
        case "ministries":
          await storage.write(pageFiles(p)[0]!, renderMinistriesPage(await ministries(run), site, opts));
          return [];
        case "category":
          await renderCategory(p.kind, p.key, opts);
          return [];
        case "archive":
          await storage.write(pageFiles(p)[0]!, renderArchiveIndex(await index.months(), site, opts));
          return [];
        case "archive-month": {
          const posts = await index.inMonth(p.month);
          if (posts.length === 0) await removeAll(p);
          else await storage.write(pageFiles(p)[0]!, renderArchiveMonth(p.month, posts, site, opts));
          return [];
        }
        case "sitemap": {
          const months = await index.months();
          await storage.write("sitemap.xml", renderSitemapIndex([pageUrl(site, { type: "sitemap-pages" }), ...months.map((m) => pageUrl(site, { type: "sitemap-month", month: m.month }))], site));
          return [];
        }
        case "sitemap-month": {
          const posts = await index.inMonth(p.month);
          if (posts.length === 0) await removeAll(p);
          else await storage.write(pageFiles(p)[0]!, renderUrlSet(posts.map((x) => ({ path: pageUrl(site, { type: "post", key: x.key }), lastmod: x.publishDate })), site));
          return [];
        }
        case "sitemap-pages": {
          const paths = [pageUrl(site, { type: "home" }), pageUrl(site, { type: "ministries" }), pageUrl(site, { type: "archive" })];
          for (const id of await categoryIds(run)) paths.push(pageUrl(site, parsePageId(id)!));
          for (const m of await index.months()) paths.push(pageUrl(site, { type: "archive-month", month: m.month }));
          await storage.write(pageFiles(p)[0]!, renderUrlSet(paths.map((path) => ({ path })), site));
          return [];
        }
        case "static":
          await writeStaticPages(storage, site, opts, deps.assetsDir);
          return [];
      }
    },

    async rebuild(pageIds, opts) {
      const run: RunCache = {};
      const unique = [...new Set(pageIds)];
      const rest = new Set(unique.filter((id) => !id.startsWith("post:")));
      // Post pages first: their dependents (and the index the aggregates read) depend on them.
      for (const id of unique.filter((x) => x.startsWith("post:"))) {
        for (const dep of await builder.renderPage(id, opts, run)) rest.add(dep);
      }
      for (const id of rest) await builder.renderPage(id, opts, run);
    },

    async allPostKeys() {
      const keys = new Set<string>();
      for (const kind of POST_KINDS) for (const k of await newsApi.postKeys(kind)) if (POST_KEY.test(k)) keys.add(k);
      for (const k of await index.keys()) keys.add(k);
      for (const k of await storage.listDirs("releases")) if (POST_KEY.test(k)) keys.add(k);
      return [...keys];
    },

    async aggregatePageIds() {
      const run: RunCache = {};
      const ids = ["static", "home", "ministries", "archive", "sitemap", "sitemap:pages", ...(await categoryIds(run))];
      for (const m of await index.months()) ids.push(formatPageId({ type: "archive-month", month: m.month }), formatPageId({ type: "sitemap-month", month: m.month }));
      return ids;
    },

    async buildAll(opts) {
      const run: RunCache = {};
      let failures = 0;
      const keys = await builder.allPostKeys();
      for (const key of keys) {
        try {
          await builder.renderPage(`post:${key}`, opts, run);
        } catch (err) {
          failures++;
          console.error(`[public-site] build: skipping post:${key} this run ${safeErrorLabel(err)}`);
        }
      }
      for (const id of await builder.aggregatePageIds()) await builder.renderPage(id, opts, run);
      return { posts: keys.length, failures };
    },
  };
  return builder;
}

function sortNewest(posts: (PostDto | null)[]): PostDto[] {
  const seen = new Set<string>();
  return posts
    .filter((p): p is PostDto => !!p && !seen.has(p.key.toLowerCase()) && !!seen.add(p.key.toLowerCase()))
    .sort((a, b) => new Date(b.publishDate).getTime() - new Date(a.publishDate).getTime());
}
```

Notes for the implementer:
- `rebuild` lets any failure propagate, so the event receiver answers 500 (and logs it with `safeErrorLabel`) and the dispatcher retries, as today. `buildAll` instead skips and counts, so one bad post never blocks the others; its caller withholds the chrome marker when `failures > 0`, so the next run retries.
- The aggregate pages run after every post page in both paths, so they see the updated index.
- The test "a published post: … then home, …" passes `"home"` and `"post:K1"`; the post's dependents include `home` too. The `Set` renders it once.

- [ ] **Step 4: Run the builder tests and see them pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/public-site/src/builder.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewrite the handler and self-heal around the builder, with failing tests first**

Rewrite `rebuild.test.ts` around the new handler. Keep (adapting setup to `createSiteBuilder` + `memoryStorage` + the fake API from `builder.test.ts`, moved to `apps/public-site/test/fake-news-api.ts` as `fakeNewsApi(posts = new Map<string, PostDto>())`, returning the client plus its `posts` map and `calls` list, so later tests can add or remove posts through `api.posts`) these existing behaviours as tests:
- "a home() failure propagates: the handler rejects and writes nothing" (the event is retried).
- "turning Blue Bridge on re-renders every existing page with the banner" — now via `buildAll`: the marker differs → every post page on disk, home, category and archive pages carry the banner; the marker is written with `chrome: 3`.
- "turning it off again removes the banner everywhere".
- "a marker from the old chrome (2) triggers one full build, then events rebuild only their pages" (the second event renders `post:K2` and its dependents only: assert via the fake API's `calls` that `getPost:K1` isn't called again).
- "a full build with a failing post withholds the marker" (next event retries the full build).
- the `enqueueSiteWrite` serialisation tests, unchanged.

Rewrite `self-heal.test.ts`:
- empty output folder → `buildAll` (every page exists; returns `{ rebuilt: <posts> }`); subscribe pages written;
- existing site with the current marker → returns `null`, writes only the subscribe pages and the static pages;
- a News API outage → logs, never throws, returns `null`, still writes the subscribe pages;
- a marker from chrome 2 → full build.

Run them: FAIL (old implementation).

- [ ] **Step 6: Implement the handler and self-heal**

In `rebuild.ts`: delete `resyncPostPages`, `renderExistingPost`, `HOME_COUNT`, `POST_KEY` and `postPath` (import `POST_KEY` from `site-paths.ts` where still needed); set `RENDER_CHROME_VERSION = 3` with the comment line `3: the full site (theme, every page type, archives, feeds, sitemaps; spec §6).`; export `writeSiteState` and add:

```ts
/** True when the chrome every page bakes in differs from the marker the last full build left. */
export async function chromeChanged(storage: SiteStorage, state: SiteRenderState, site: SiteInfo): Promise<boolean> {
  const previous = await readSiteState(storage);
  return !(previous && previous.granvilleOn === state.granvilleOn && previous.test === state.test && previous.chrome === RENDER_CHROME_VERSION && previous.baseUrl === site.baseUrl);
}

export function createRebuildHandler(deps: { builder: SiteBuilder; newsApi: NewsApiClient; storage: SiteStorage; site: SiteInfo; test: boolean }): EventHandler {
  return (_tx, event) =>
    enqueueSiteWrite(deps.storage, async () => {
      const { pages } = event.data as { pages: string[] };
      // A home() failure propagates: the receiver answers 500 and the dispatcher retries.
      const { granville } = await deps.newsApi.home();
      const { state, banner } = stateAndBanner(granville, deps.test, new Date());
      const opts: PageOptions = { test: deps.test, banner };
      if (await chromeChanged(deps.storage, state, deps.site)) {
        const r = await deps.builder.buildAll(opts);
        if (r.failures === 0) await writeSiteState(deps.storage, state, deps.site);
        return;
      }
      await deps.builder.rebuild(pages, opts);
    });
}
```

In `self-heal.ts`:

```ts
export function selfHeal(deps: { builder: SiteBuilder; newsApi: NewsApiClient; storage: SiteStorage; site: SiteInfo; test: boolean }): Promise<{ rebuilt: number } | null> {
  const { builder, newsApi, storage, site, test } = deps;
  return enqueueSiteWrite(storage, async () => {
    const home = await tryHome(newsApi);
    const computed = home ? stateAndBanner(home.granville, test, new Date()) : null;
    const opts = { test, banner: computed?.banner ?? null };
    await writeSubscribePages(storage, site, opts);
    if (!computed) return null; // News API unreachable: nothing more can be rendered correctly now
    const needsBuild = (await chromeChanged(storage, computed.state, site)) || !(await storage.exists("index.html"));
    if (!needsBuild) {
      await builder.renderPage("static", opts);
      return null;
    }
    const r = await builder.buildAll(opts);
    if (r.failures === 0) await writeSiteState(storage, computed.state, site);
    return { rebuilt: r.posts };
  });
}
```

In `start.ts`: `const index = postIndex(db); const builder = createSiteBuilder({ newsApi, storage, index, site, assetsDir: parsed.SITE_ASSETS_DIR });`, pass `builder` to `createRebuildHandler` and `selfHeal`. Update `start.test.ts` if it asserts on the old deps.

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/public-site apps/stack/src/stack.test.ts` — PASS. `tsc` — clean.

- [ ] **Step 7: The E2E check**

Create `tests/e2e/public-site.spec.ts`:

```ts
// Spec §9 (E2E): publish → release, ministry, archive, home and feed pages exist; unpublishing
// removes the release page and its entries.
import { test, expect } from "@playwright/test";
import { EDITOR_EMAIL, TEST_USER_PASSWORDS } from "./constants";
import { apiCall, baseUrl, createApprovedAndPublished, loginForCookie, tickTwice } from "./playwright-support";
import type { ReleaseView } from "@gcpe/nrms-contract";

const text = async (path: string) => {
  const res = await fetch(`${baseUrl()}/site${path}`);
  return { status: res.status, body: res.status === 200 ? await res.text() : "" };
};

test("a published release appears on every page that lists it, and leaves them all when unpublished", async () => {
  const cookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
  const published = await createApprovedAndPublished(cookie);
  const key = published.key!;
  const post = (await (await fetch(`${baseUrl()}/api/Posts/${key}?api-version=1.0`)).json()) as { publishDate: string; ministryKeys: string[] };
  const month = post.publishDate.slice(0, 7);
  const ministry = post.ministryKeys[0]!.toLowerCase();
  const link = `/releases/${key}/`;

  expect(month).toMatch(/^\d{4}-\d{2}$/);
  expect((await text(link)).status).toBe(200);
  for (const path of ["/", `/ministries/${ministry}/`, `/archive/${month.slice(0, 4)}/${month.slice(5)}/`]) {
    expect((await text(path)).body, path).toContain(link);
  }
  expect((await text("/feed.xml")).body).toContain(link);
  expect((await text(`/ministries/${ministry}/feed.xml`)).body).toContain(link);
  expect((await text(`/sitemaps/${month}.xml`)).body).toContain(link);
  const releasePage = (await text(link)).body;
  expect(releasePage).toContain('<a class="skip-link" href="#main">');
  expect(releasePage).toContain('<meta name="robots" content="noindex, nofollow">');

  const current = await apiCall<ReleaseView>(cookie, `/nrms/api/releases/${published.id}`);
  await apiCall(cookie, `/nrms/api/releases/${published.id}/unpublish`, { method: "POST", body: { version: current.version } });
  await tickTwice();

  expect((await text(link)).status).toBe(404);
  for (const path of ["/", `/ministries/${ministry}/`, "/feed.xml", `/sitemaps/${month}.xml`]) {
    expect((await text(path)).body, path).not.toContain(link);
  }
});
```

Run: `npx -y -p node@24 -- node node_modules/@playwright/test/cli.js test tests/e2e/public-site.spec.ts tests/e2e/unpublish.spec.ts tests/e2e/website.spec.ts tests/e2e/subscribe-journey.spec.ts`
Expected: PASS (`unpublish.spec.ts` and `subscribe-journey.spec.ts` already fetch `/site/...` pages and must still pass).

- [ ] **Step 8: Docs and parity rows**

`docs/manuals/running-notes.md` (Phase 6c list):
- `- **Viewer** — The public site has a page for every ministry (with its minister and media contacts), sector, theme and tag, each with its latest 20 posts and an RSS feed (\`feed.xml\`). Older news is in the archive, one page per month.`
- `- **Site editor** — The home page shows the Top and Featured posts, the carousel's slides as a list (they no longer rotate), the latest 20 posts and the resource links. Slide images arrive in a later update.`
- `- **Operations** — The site rebuilds every page a post appears on when it's published, changed or unpublished. A deploy that changes the page layout rebuilds the whole site once, on start.`

`docs/deploy/siteground.md` (`## The public site (Phase 6c)`): `### Pages and rebuilds` — the page list with paths; the local post index (`site_posts` in the site database); a layout change or a Blue Bridge switch rebuilds every page on the next event or start (in 6c-1, synchronously; fine for boxs.ca's volume); how to force one (delete `<OUTPUT_DIR>/.site-state.json` and restart).

`docs/parity/changes-from-legacy.md`, after C204:
- `| C205 | news.gov.bc.ca's home-page carousel rotates. | The platform's own site shows the carousel's slides as a list that doesn't move. | WCAG 2.2.2 (no moving content without a pause control) and no script needed (D3). BC's own site is unaffected (D1). | Proposed |`
- `| C206 | news.gov.bc.ca uses a path per kind (/releases/, /stories/, /factsheets/ …). | The platform's own site puts every post at /releases/<key>/. | One scheme, keys are unique across kinds, and no legacy redirects are needed (D1). | Proposed |`

`docs/parity/open-questions.md`, after Q80:
- `| Q81 | When the platform's site and the News API are on different hosts, how should the search page reach \`/api/v2/search\`? | The browser blocks cross-origin calls unless the API sends CORS headers; the stack serves both on one origin, production may not. | Same origin (a reverse proxy routes \`/api/v2/search\` on the site's host); \`SEARCH_API_URL\` points elsewhere only once CORS is decided. | 2026-10-11 |`
- `| Q82 | Should ministry, sector, theme and tag pages have their own monthly archives, or is the site-wide archive plus filtered search enough? | §6.1 says category pages link to "monthly archives"; §6.2 only rebuilds one site-wide month archive per post. | Site-wide archive, plus search filtered by ministry or sector. | 2026-10-11 |`
- `| Q83 | Is it acceptable that a release page's "Related news" is fixed at its last rebuild? | Related lists change when other posts are embedded, which doesn't trigger a rebuild; a page can show a related post that was later unpublished until something rebuilds it. | Yes: unpublished targets 404 and the page refreshes on its next rebuild; a client-side fetch is the alternative. | 2026-10-11 |`

Update Q76's working assumption to: `The site copies files under \`config/site/assets/\`; the header shows the logo only once its file is there, and BC Sans only once a stylesheet URL is configured. No BC logo or font file is committed until this is answered.`

Run the duplicate checks from the Global Constraints (both print nothing).

- [ ] **Step 9: Full check and commit**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/public-site apps/stack apps/news-api/test/compat.test.ts` and `tsc`. Expected: PASS, clean.

```bash
git add apps/public-site tests/e2e/public-site.spec.ts docs
git commit -m "public-site: build pages by id, rebuild every page a post change touches, full build on chrome change"
```

---

## Deploy (after the 6c-1 final review)

Push and deploy to boxs.ca as usual (`npm run deploy:siteground`). After the first start, check: `/site/` has the new chrome; `/site/ministries/`, `/site/archive/`, `/site/feed.xml`, `/site/sitemap.xml` and `/site/robots.txt` (`Disallow: /`) exist; `/stack/health` is `ok`. Publish one release on boxs.ca and confirm its ministry page and month archive list it after the next tick.
