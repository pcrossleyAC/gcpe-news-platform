# Phase 6d–6e: Staff "Similar Published Releases" and the Phase 6 Exit Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the release editor's "Similar published releases" panel (NRMS → the News API's service-only `POST /api/v2/internal/similar`, behind two independent staff-AI flag checks, draft text never stored, cached or logged), then close Phase 6 with axe-core, Lighthouse, a search spot-check script and the exit docs.

**Architecture:**
- **News API:** a `SimilarService` (`apps/news-api/src/search/similar.ts`) answers with up to 10 published posts. In AI mode it embeds the draft with its own guarded embedder (no query-vector cache), takes the nearest published posts within `SEARCH_SEMANTIC_THRESHOLD` labelled `ai`, then fills to 10 with full-text matches labelled `text`. AI mode is honoured only when the News API's own `features.staffAi`, a provider and pgvector are all present (`resolveSearchMode` with the staff-AI flag); otherwise it answers `mode: "text"`. The route sits behind the same service bearer as the change feed, with a new service role `NewsApi.Similar`.
- **NRMS:** `POST /api/releases/:id/similar` (NRMS.Editor) builds the text from the *saved* release, sends `mode: "ai"` only when NRMS's own tenant `features.staffAi` is on, maps lead-ministry keys to names, and returns the list. Nothing is written: no release-log entry, no row, no log line with text. `GET /api/config` gains `similarAvailable` and `staffAi`.
- **Staff web:** `SimilarReleasesPanel` in the release editor (editors only). Nothing is fetched until **Find similar** is pressed.
- **Exit:** a fictional fixture site (no database: an in-memory post index) built by the real `createSiteBuilder`; `npm run site:quality` runs axe (zero violations) and Lighthouse (thresholds) on every page type, locally and in a new CI job. `npm run search:spot-check` runs 20 query → expected-key pairs over a fictional corpus in a throwaway database.

**Tech Stack:** Node 24, TypeScript 5.9, Express 5, Drizzle 0.45 on Postgres 14 (+ pgvector where present), zod 3.25, Vitest 4.1, React 19 + `@bcgov/design-system-react-components` 0.8.1, Playwright 1.63, `@axe-core/playwright` 4.13.0, `lighthouse` 13.5.0 + `chrome-launcher` 1.x.

**Spec:** `docs/superpowers/specs/2026-10-11-public-site-ai-design.md`:
- §7 (staff help) in full;
- §3's staff-AI flag rule ("Staff AI is the same, plus D4's explicit action");
- §8's runbook lines "turning flags on" and "the PIA gate for staff AI";
- §9's "Staff-AI flag enforcement" test, the E2E line "the staff panel works in text mode, and in AI mode with the stand-in provider", and **Exit (6e)** in full;
- §10's 6d and 6e rows.

**Builds on:** 6a, 6b (merged), 6c-1 and 6c-2 (`feat/phase-6c`, PR pending; this branch is stacked on it). Names used here: `resolveSearchMode`, `hasPgvector`, `VECTOR_DIMENSIONS` (`embeddings/pgvector.ts`); `textSearch`, `searchRowsByKeys`, `READ_SNAPSHOT` (`search/text-search.ts`); `searchResultMapper` (`search/service.ts`); `changesBearerFromEnv` (`http/v2/changes-auth.ts`); `createGuardedEmbedder`, `standInProvider`, `createEmbeddingProvider`, `embeddingsEnvSchema` (`@gcpe/embeddings`); `runEmbeddingTick` (`embeddings/worker.ts`); `applyRelease`, `unpublishRelease` (`projections.ts`); `createSiteBuilder`, `fsStorage`, `PostIndex`, `IndexedPost` (public site); `fakeNewsApi`, `post` (`apps/public-site/test/`).

---

## Decisions made in planning

Each ruling was made against the code at `ed22717` (this branch's base). The risky parts were dry-run; results are marked **verified**.

1. **Spec conflict, §7 request body `{ text, mode }`.** The body is `{ text, terms, mode, excludeKey? }`. §7 says AI mode compares the whole text, but text mode uses "the draft's headline and keywords", which the News API can't recover from one blob. `terms` is the headline plus keywords (≤ 1,000 characters). `excludeKey` is the release's own key, so a correction to a published release doesn't list itself. Both are draft text and get the same privacy rules.
2. **Text mode ORs the words.** `websearch_to_tsquery` ANDs a query's words, so a whole headline would almost never match another post. The News API lower-cases `terms`, keeps up to 32 distinct letter/digit runs (dropping the operator word `or`), and joins them with ` or `. Results are ranked by `ts_rank_cd`, then newest first; this is `textSearch` unchanged. **Verified** on Postgres 14: `websearch_to_tsquery('english', 'rural or clinics or the or b.c. or 2026')` gives `'rural' | 'clinic' | 'b.c' | '2026'`, and stop words alone give an empty query. An empty `terms` skips the text query.
3. **AI mode** returns the nearest published posts (exact cosine distance, at or below `SEARCH_SEMANTIC_THRESHOLD`, at most 10), labelled `ai`. Text matches not among them then fill up to 10, labelled `text`. The response says `mode: "ai"` when the draft was embedded. A provider failure, an open breaker, a wrong-size vector or the flag check all give `mode: "text"` and text matches only. The vector SQL is `semantic.ts`'s `MATERIALIZED` query without the search filters.
4. **The News API's own check** is `resolveSearchMode({ flag: tenant.features.staffAi, provider, pgvector })`. When it resolves to semantic, the similar service gets its own `createGuardedEmbedder({ provider })`, with its own breaker. No `QueryVectorCache` is involved. Otherwise the embedder is `null`, and the service can't call a provider whatever `mode` says.
5. **The embedding worker runs when either flag resolves.** Today it runs only in semantic-search mode, but AI matching needs post vectors. With `staffAi` on and `semanticSearch` off, the worker embeds *published* posts (never drafts). Search and related posts stay in text mode. Q71's working assumption says published content needs no PIA; Q88 asks Paul to confirm.
6. **NRMS uses the saved release, not unsaved edits.** `POST /api/releases/:id/similar` takes no body; NRMS loads the view and builds the text itself, so no draft text crosses from the browser in a new path. The panel says "Compares the last saved version of this release" (Q86).
   - **Text:** headline, summary, keywords, then every document's English body as plain text, collapsed and capped at 8,000 code points.
   - **Who:** `NRMS.Editor` only ("roles that can edit releases").
   - **Nothing is written:** no release-log entry, no row.
   - **Errors:** a blank draft gets a 422 without calling the News API; a News API failure gets a 502 with a generic message.
7. **NRMS's flag** is its own tenant config's `features.staffAi`. `GET /api/config` adds `similarAvailable` (NRMS has a News API URL) and `staffAi`. Without `NEWS_API_URL` the route answers 503 and the panel doesn't render.
8. **Auth.**
   - New service role `NewsApi.Similar` (`NEWS_API_SIMILAR_ROLE`), not a staff role.
   - The News API reuses `changesBearerFromEnv(env)`, which never carries the session secret, so a staff cookie can't open the route. No bearer configuration means 503.
   - NRMS env: `NEWS_API_URL`, plus `NEWS_API_TOKEN_URL`, `NEWS_API_CLIENT_ID`, `NEWS_API_CLIENT_SECRET` and `NEWS_API_SCOPE`. All four or none, with the local-token fallback, exactly like `NOD_*`.
   - The stack defaults `NRMS_NEWS_API_URL` to `self:/`. **Verified:** `resolveSelfUrls` rewrites any `*_URL` whose value starts with `self:/`, and the public site already reaches the News API at `self:/`.
9. **The 8,000 cap is counted in code points.** NRMS truncates. The News API refuses more with a 400 (`terms`: 1,000). A body over 64 KB gets a 413 from `express.json`. Validation errors name the parameter only, never echo input. A NUL in any string is a 400, not a Postgres error.
10. **The button text.** While the flag is on, the sentence "Sends this draft's text to the AI service to compare." is shown under **Find similar** and tied to it with `aria-describedby`. The button's own name stays "Find similar".
11. **Spec §9 E2E line, split.**
    - The E2E suite runs **AI mode** with the stand-in provider. Its tenant file turns `staffAi` on for every app, and `semanticSearch` stays off so the search specs don't change.
    - **Text mode** is covered by the News API service tests, the NRMS route tests and the component tests. A second stack per mode would double the suite's start-up cost for one assertion.
12. **Public-page axe runs on a fixture site, not the E2E stack.** `scripts/fixture-site.ts` builds every page type from fictional posts with the real builder, an in-memory `PostIndex` and BC's theme, and serves it from a tiny static server. Coverage is deterministic: every page type, sectors and themes included. It needs no Postgres, so it runs in CI. **Verified:** all 11 page types gave zero axe violations under `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa` and `best-practice`.
13. **Lighthouse.**
    - **Tools:** the `lighthouse` 13.5.0 npm package plus `chrome-launcher`, driving Playwright's Chromium (`chromium.executablePath()`). Not `@lhci/cli`: it adds a server and upload model we don't need.
    - **Settings:** Lighthouse defaults (mobile, simulated throttling) on one production-config build (`test: false`, indexable), checking all four categories on every page.
    - **Verified** on six pages: performance 100, accessibility 100, best practices 96–100, SEO 92–100. Best practices loses points on `errors-in-console`: fixture images point at a non-existent host. SEO loses points on `meta-description` for list pages. Both are above the thresholds.
14. **CI.** A new `site-quality` job in `.github/workflows/ci.yml` (`npm ci`, `npx playwright install --with-deps chromium`, `npm run site:quality`), with no Postgres service. It's a separate job, so it can fail without hiding unit-test results. It can't be run on GitHub from here overnight, so it stays a non-required check until it has run green there (Q87). The E2E suite stays local-only, as today.
15. **Search spot-check.**
    - **Text mode** must put every expected key in the top 5, and the script exits 1 otherwise. Postgres full-text relevance is real, so that part is a genuine check.
    - **Semantic column:** reported only, with a banner saying the stand-in proves only the plumbing and that real relevance waits for Azure (Q70). The script also exits 1 if semantic mode was never reached, because then the plumbing failed.
    - **Run:** it uses a throwaway test database (`TEST_DATABASE_ADMIN_URL`), dropped at the end. `EMBEDDINGS_PROVIDER=azure-openai` plus the Azure settings run the same check against Azure once Q70 lands.
16. **Parity.** No new C rows; C203 already describes the feature. Q86–Q88 are added (Task 5).
17. **The exit note** is `docs/superpowers/plans/phase-6-exit.md`, next to the phase-4 and phase-5 carry-forward notes.

## Global Constraints

Carried over verbatim from Phase 6c-2:

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
- **All user-supplied text is escaped with the existing `escapeHtml`** (`@gcpe/http-kit`, aliased `e` in `render.ts`): headlines, summaries, names, labels, URLs in attributes, feed and sitemap text. The only unescaped HTML is the release body (`detailsHtml`) and the minister's `details`, both staff-authored in NRMS, as today. JSON inside a `<script>` escapes `<` as `<`.
- **Storage writes go through the hardened `SiteStorage`** (`apps/public-site/src/storage.ts`: no `..`, no absolute paths, symlink checks, atomic rename). Every output path comes from `pageFiles()` in `site-paths.ts`, which only accepts validated page ids. No other module joins output paths or calls `node:fs` for output.
- **Test sites keep `noindex`:** `<meta name="robots" content="noindex, nofollow">` on every HTML page and `Disallow: /` in `robots.txt` whenever `isTestSite(env)` is true.
- **Log lines** may name a page id (post keys and category keys are public); never a headline or body text.
- **Parity lists (6c):** C201–C204 and Q70–Q80 are in place. 6c-1 adds **C205–C206** and **Q81–Q83**, and updates **Q76's working assumption** (Task 5). 6c-2 adds **C207–C208** and **Q84–Q85**, and marks **C42** Reversed (its Tasks 1 and 5). The duplicate checks above still apply.
- **Running notes:** 6c lines go under a new `## Phase 6c — The public site`, directly after the Phase 6b list (6c-1 Task 1 creates the heading).
- **Runbook:** 6c's subsections go in a new `## The public site (Phase 6c)`, inserted just before `## Troubleshooting` (after the 6b section). 6c-1 Task 1 creates the heading.

**6d–6e additions and overrides** (where a line above names an earlier branch, numbers or headings, these win):

- **Worktree:** work on `feat/phase-6de` in `/Users/paul/gcpe-news-platform-p6de` (base `ed22717`, stacked on `feat/phase-6c`). `node_modules` is already installed there; new packages go in with `npx -y -p node@24 -- npm install --ignore-scripts`.
- **The draft text is never stored, cached or logged by NRMS or the News API.**
  - No `console.*` call anywhere on the similar path may include `text`, `terms`, a headline, a vector or a request body; errors log `safeErrorLabel(e)` plus a fixed prefix.
  - No row is written on either side: no release log, no audit, no table, no query-vector cache.
  - Validation errors name the parameter only.
  - Each side has a test that spies on `console.log/warn/error`, runs the path (including a failure), and asserts no captured line contains the draft's marker word.
- **Results are published posts only.** Both the vector and text branches filter `posts.is_published = true`, and `searchRowsByKeys` filters it again.
- **Two independent checks.** NRMS sends `mode: "ai"` only when its own `tenant.features.staffAi` is true. The News API calls a provider only when its own `tenant.features.staffAi`, a provider of `VECTOR_DIMENSIONS` and pgvector are all present. Neither side trusts the other's flag.
- **E2E runs** with `npx -y -p node@24 -- node node_modules/@playwright/test/cli.js test <spec>` (local Postgres; the global setup starts the whole stack).
- **New dev dependencies are pinned exactly** in the root `package.json`: `lighthouse` `13.5.0` and `chrome-launcher` (whatever `^1.2.1` resolves to, written exact).
- **Parity lists (6d–6e):** the highest rows today are **C209** and **Q85**. 6d–6e adds **no C rows** and **Q86–Q88** (Task 5). The duplicate checks above still apply.
- **Running notes:** 6d–6e lines go under a new `## Phase 6d–6e — Staff help and the exit checks`, directly after the Phase 6c list (Task 1 creates the heading).
- **Runbook:** 6d–6e's subsections go in a new `## Staff help and the exit checks (Phases 6d–6e)`, inserted just before `## Troubleshooting` (after the 6c section). Task 1 creates the heading.

## Review Focus

Five inputs the spec implies, which a person would hit and the main path doesn't cover. Each has a pinned test in the task named.

1. **NRMS's flag on, the News API's off** (the PIA hasn't been signed, but someone flipped one config). A spy provider must record zero calls for the draft, and the answer must say `mode: "text"`. Task 1: `similar-flag.test.ts`.
2. **The AI service fails or its breaker is open** mid-click. Staff get text matches with `mode: "text"`, never an error. No log line carries the draft. Task 1: "a failing provider gives text mode and logs no draft text".
3. **A blank draft** (no headline, summary, keywords or body yet). NRMS answers 422 without calling the News API. Task 2: "a blank draft is refused without a call".
4. **An unpublished post that matches the draft word for word.** It must never be listed in either mode. Task 1: "never lists an unpublished post, in either mode".
5. **A correction to an already-published release.** The release itself must not be listed as its own best match. Task 1: "excludeKey leaves the release itself out, in both branches". Task 2 checks that NRMS sends `excludeKey: view.key`.

## File structure

**Created:**
- `apps/news-api/src/search/similar.ts`: `SIMILAR_LIMIT`, `SIMILAR_MAX_TEXT_CHARS`, `SIMILAR_MAX_TERMS_CHARS`, `similarRequestSchema`, `SimilarRequest`, `SimilarResult`, `SimilarResponse`, `SimilarService`, `orTerms`, `createSimilarService`.
- `apps/news-api/src/search/similar.test.ts`, `apps/news-api/src/search/similar-flag.test.ts`.
- `apps/nrms/src/releases/similar.ts`: `similarSource`, `findSimilar`, `SimilarDeps`, `SimilarOutcome`.
- `apps/nrms/src/releases/similar.test.ts`, `apps/nrms/src/http/similar-route.test.ts`.
- `apps/staff-web/src/screens/release/SimilarReleasesPanel.tsx`, `SimilarReleasesPanel.test.tsx`.
- `tests/e2e/staff-similar.spec.ts`.
- `scripts/fixture-site.ts`, `scripts/site-quality.ts`, `scripts/search-spot-check.ts`.
- `tests/fixture-site.test.ts`, `tests/search-spot-check.test.ts`.
- `docs/superpowers/plans/phase-6-exit.md`.

**Modified:**
- `packages/auth/src/roles.ts`, `packages/auth/src/index.ts` (`NEWS_API_SIMILAR_ROLE`).
- `apps/news-api/src/http/v2/routes.ts`, `app.ts`, `start.ts`.
- `apps/nrms/src/clients.ts`, `clients.test.ts`, `start.ts`, `start.test.ts`, `app.ts`, `http/routes.ts`.
- `apps/stack/src/env.ts`, `env.test.ts` (`NRMS.NEWS_API_URL: "self:/"`).
- `apps/staff-web/src/screens/release/ReleaseEditorPage.tsx`, `apps/staff-web/src/styles/global.css`.
- `tests/e2e/global-setup.ts`.
- Root `package.json`, `package-lock.json`, `.github/workflows/ci.yml`.
- Docs: `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`, `docs/parity/open-questions.md`.

---

### Task 1: The News API's internal similar route and its staff-AI check

**Review:** full (internal route, flag enforcement, privacy).

**Files:**
- Modify: `packages/auth/src/roles.ts`, `packages/auth/src/index.ts`
- Create: `apps/news-api/src/search/similar.ts`
- Modify: `apps/news-api/src/http/v2/routes.ts`, `apps/news-api/src/app.ts`, `apps/news-api/src/start.ts`
- Test: `apps/news-api/src/search/similar.test.ts`, `apps/news-api/src/search/similar-flag.test.ts`
- Docs: `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`

**Interfaces:**
- Consumes: `textSearch(db, query, { language, defaultLanguageId, excludeKeys, window })`, `searchRowsByKeys(db, keys, defaultLanguageId)`, `READ_SNAPSHOT`, `searchResultMapper(publicSiteUrl, timeZone)`, `resolveSearchMode({ flag, provider, pgvector })`, `hasPgvector(db)`, `VECTOR_DIMENSIONS`, `changesBearerFromEnv(env)`, `createGuardedEmbedder({ provider, log? })`, `GuardedEmbedder`.
- Produces:
  - `NEWS_API_SIMILAR_ROLE = "NewsApi.Similar"` (`@gcpe/auth`).
  - `POST /api/v2/internal/similar`:
    - Request body: `{ text: string; terms: string; mode: "ai" | "text"; excludeKey?: string }`.
    - 200 response: `{ mode: "ai" | "text"; results: { key: string; headline: string | null; publishDate: string; leadMinistryKey: string | null; url: string; match: "ai" | "text" }[] }`.
    - Errors: 400 `{ error: { code: "InvalidParameter", parameter } }`, 401, 403, 413, 503.
  - `createSimilarService(opts): SimilarService`; `orTerms(terms): string`.

- [ ] **Step 1: Add the role**

In `packages/auth/src/roles.ts`, after `NEWS_API_CHANGES_ROLE`:

```ts
/** Phase 6d: the service role that may call the News API's `POST /api/v2/internal/similar`
 * (spec addendum §7). NRMS holds it. Not a staff role. */
export const NEWS_API_SIMILAR_ROLE = "NewsApi.Similar";
```

In `packages/auth/src/index.ts`, add `NEWS_API_SIMILAR_ROLE` to the `./roles` export list, alphabetically after `NEWS_API_CHANGES_ROLE`.

- [ ] **Step 2: Write the failing service and route tests**

Create `apps/news-api/src/search/similar.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { mintLocalToken, NEWS_API_CHANGES_ROLE, NEWS_API_SIMILAR_ROLE } from "@gcpe/auth";
import type { TestDatabase } from "@gcpe/db-kit";
import { createGuardedEmbedder, EmbeddingError, standInProvider, type EmbeddingProvider } from "@gcpe/embeddings";
import type { ReleaseRecord } from "@gcpe/events";
import { sampleRelease } from "@gcpe/events/testing";
import { jsonErrorHandler } from "@gcpe/http-kit";
import { createNewsTestDb, TZ } from "../../test/helpers";
import { runEmbeddingTick } from "../embeddings/worker";
import { v2Routes } from "../http/v2/routes";
import { applyRelease, unpublishRelease } from "../projections";
import { createSimilarService, orTerms, similarRequestSchema, SIMILAR_LIMIT, type SimilarRequest } from "./similar";

const SECRET = "s".repeat(40);
const MARKER = "quokkadraftmarker";

function release(key: string, headline: string, o: { body?: string; publishDate?: string } = {}): ReleaseRecord {
  return {
    ...sampleRelease,
    key,
    reference: null,
    summary: null,
    keywords: null,
    location: null,
    publishDate: o.publishDate ?? "2026-10-01T10:00:00-07:00",
    leadMinistryKey: "health",
    ministryKeys: ["health"],
    sectorKeys: [],
    documents: [{ ...sampleRelease.documents[0]!, headline, subheadline: "", detailsHtml: o.body ? `<p>${o.body}</p>` : "" }],
  };
}

describe("orTerms", () => {
  it.each([
    ["Clinics open: B.C.'s rural-health plan", "clinics or open or b or c or s or rural or health or plan"],
    ["or OR Or", ""],
    ["", ""],
    ["Salmon salmon SALMON hatchery", "salmon or hatchery"],
    ['"quoted" -minus (paren)', "quoted or minus or paren"],
  ])("%j → %j", (input, expected) => expect(orTerms(input)).toBe(expected));

  it("keeps at most 32 distinct words", () => {
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    expect(orTerms(words).split(" or ")).toHaveLength(32);
  });
});

describe("similarRequestSchema", () => {
  const ok = { text: "a", terms: "a", mode: "text" };
  it("accepts 8,000 code points of text and 1,000 of terms", () => {
    expect(similarRequestSchema.safeParse({ ...ok, text: "é".repeat(8000), terms: "a".repeat(1000) }).success).toBe(true);
  });
  it.each([
    [{ ...ok, text: "a".repeat(8001) }, "text"],
    [{ ...ok, terms: "a".repeat(1001) }, "terms"],
    [{ ...ok, mode: "semantic" }, "mode"],
    [{ ...ok, text: "a\u0000b" }, "text"],
    [{ ...ok, excludeKey: "" }, "excludeKey"],
    [{ ...ok, extra: 1 }, undefined],
  ])("refuses %j", (body, parameter) => {
    const r = similarRequestSchema.safeParse(body);
    expect(r.success).toBe(false);
    if (!r.success && parameter) expect(r.error.issues[0]?.path[0]).toBe(parameter);
  });
});

describe("createSimilarService (spec §7)", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNewsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE posts CASCADE");
  });
  afterEach(() => vi.restoreAllMocks());

  const seed = async (...rs: ReleaseRecord[]) => {
    for (const r of rs) await tdb.db.transaction((tx) => applyRelease(tx, r, { notify: false }));
    const embedder = createGuardedEmbedder({ provider: standInProvider(), log: () => {} });
    while ((await runEmbeddingTick({ db: tdb.db, embedder })).embedded > 0);
  };
  const service = (provider: EmbeddingProvider | null, log: (l: string) => void = () => {}) =>
    createSimilarService({
      db: tdb.db,
      timeZone: TZ,
      language: "english",
      defaultLanguageId: 4105,
      publicSiteUrl: "https://site.example.test",
      threshold: 0.5,
      embedder: provider ? createGuardedEmbedder({ provider, log }) : null,
    });
  const req = (over: Partial<SimilarRequest> = {}): SimilarRequest => ({ text: "salmon habitat restoration", terms: "salmon habitat", mode: "text", ...over });

  it("text mode: published posts sharing any headline word, ranked, labelled text", async () => {
    await seed(release("T-BOTH", "salmon habitat grants"), release("T-ONE", "habitat survey"), release("T-NONE", "ferry schedule"));
    const res = await service(standInProvider()).similar(req());
    expect(res.mode).toBe("text");
    expect(res.results.map((r) => r.key)).toEqual(["T-BOTH", "T-ONE"]);
    expect(res.results[0]).toMatchObject({ match: "text", headline: "salmon habitat grants", leadMinistryKey: "health", url: "https://site.example.test/releases/T-BOTH" });
  });

  it("ai mode with the stand-in: the nearest post first, labelled ai, then text matches", async () => {
    await seed(release("A-EXACT", "salmon habitat restoration"), release("A-NEAR", "salmon count down"), release("A-FAR", "habitat"));
    const res = await service(standInProvider()).similar(req({ mode: "ai" }));
    expect(res.mode).toBe("ai");
    expect(res.results[0]).toMatchObject({ key: "A-EXACT", match: "ai" });
    // Every AI match comes before every text match ("ai" sorts before "text"), and no post twice.
    const matches = res.results.map((r) => r.match);
    expect(matches).toEqual([...matches].sort());
    expect(new Set(res.results.map((r) => r.key)).size).toBe(res.results.length);
    expect(res.results.map((r) => r.key).sort()).toEqual(["A-EXACT", "A-FAR", "A-NEAR"]);
  });

  it("ai requested without an embedder (the flag check said no): text mode, no provider", async () => {
    await seed(release("N-1", "salmon habitat restoration"));
    const res = await service(null).similar(req({ mode: "ai" }));
    expect(res).toMatchObject({ mode: "text", results: [{ key: "N-1", match: "text" }] });
  });

  it("a failing provider gives text mode and logs no draft text", async () => {
    await seed(release("F-1", "salmon habitat restoration"));
    const failing: EmbeddingProvider = { ...standInProvider(), async embed() { throw new EmbeddingError("boom"); } };
    const lines: string[] = [];
    const capture = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "warn").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
    const res = await service(failing, (l) => lines.push(l)).similar(req({ mode: "ai", text: `${MARKER} salmon`, terms: `${MARKER} salmon` }));
    expect(res.mode).toBe("text");
    expect(res.results.map((r) => r.key)).toEqual(["F-1"]);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(MARKER);
  });

  it("never lists an unpublished post, in either mode", async () => {
    await seed(release("U-LIVE", "salmon habitat restoration"), release("U-GONE", "salmon habitat restoration"));
    await tdb.db.transaction((tx) => unpublishRelease(tx, "U-GONE"));
    for (const mode of ["ai", "text"] as const) {
      const keys = (await service(standInProvider()).similar(req({ mode }))).results.map((r) => r.key);
      expect(keys, mode).toContain("U-LIVE");
      expect(keys, mode).not.toContain("U-GONE");
    }
  });

  it("excludeKey leaves the release itself out, in both branches", async () => {
    await seed(release("E-SELF", "salmon habitat restoration"), release("E-OTHER", "salmon habitat restoration"));
    for (const mode of ["ai", "text"] as const) {
      const keys = (await service(standInProvider()).similar(req({ mode, excludeKey: "e-self" }))).results.map((r) => r.key);
      expect(keys, mode).toEqual(["E-OTHER"]);
    }
  });

  it(`returns at most ${SIMILAR_LIMIT}`, async () => {
    await seed(...Array.from({ length: 12 }, (_, i) => release(`L-${i}`, `salmon habitat ${i}`)));
    for (const mode of ["ai", "text"] as const) expect((await service(standInProvider()).similar(req({ mode }))).results).toHaveLength(SIMILAR_LIMIT);
  });

  it("empty terms and an unembeddable text give an empty text answer", async () => {
    await seed(release("Z-1", "salmon"));
    expect(await service(standInProvider()).similar(req({ mode: "ai", text: "   ", terms: "or the" }))).toEqual({ mode: "text", results: [] });
  });

  it("stores nothing: row counts are unchanged", async () => {
    await seed(release("S-1", "salmon habitat restoration"));
    const count = async () => (await tdb.pool.query("SELECT (SELECT count(*) FROM posts) p, (SELECT count(*) FROM post_embeddings) e, (SELECT count(*) FROM changes) c")).rows[0];
    const before = await count();
    await service(standInProvider()).similar(req({ mode: "ai" }));
    expect(await count()).toEqual(before);
  });
});

describe("POST /api/v2/internal/similar", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNewsTestDb();
    await tdb.db.transaction((tx) => applyRelease(tx, release("R-1", "salmon habitat restoration"), { notify: false }));
  });
  afterAll(async () => {
    await tdb.drop();
  });
  afterEach(() => vi.restoreAllMocks());

  const app = (bearer: { local: { secret: string } } | null) => {
    const service = createSimilarService({ db: tdb.db, timeZone: TZ, language: "english", defaultLanguageId: 4105, publicSiteUrl: "https://site.example.test", threshold: 0.5, embedder: null });
    const a = express();
    a.use("/api/v2", v2Routes({ similar: { service, bearer } }));
    a.use(jsonErrorHandler({ logPrefix: "[news-api]" }));
    return a;
  };
  const body = { text: `${MARKER} salmon habitat`, terms: "salmon habitat", mode: "ai" };
  const token = (roles: string[]) => mintLocalToken({ secret: SECRET, subject: "nrms", roles });

  it("answers with the service's result for a NewsApi.Similar token, no-store", async () => {
    const res = await request(app({ local: { secret: SECRET } })).post("/api/v2/internal/similar").set("authorization", `Bearer ${await token([NEWS_API_SIMILAR_ROLE])}`).send(body);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toMatchObject({ mode: "text", results: [{ key: "R-1", match: "text" }] });
  });

  it("401 without a token, 403 with another service role, 503 when no bearer can be verified", async () => {
    const a = app({ local: { secret: SECRET } });
    expect((await request(a).post("/api/v2/internal/similar").send(body)).status).toBe(401);
    expect((await request(a).post("/api/v2/internal/similar").set("authorization", `Bearer ${await token([NEWS_API_CHANGES_ROLE])}`).send(body)).status).toBe(403);
    expect((await request(app(null)).post("/api/v2/internal/similar").send(body)).status).toBe(503);
  });

  it("400 names the parameter and never echoes the draft; nothing logs it", async () => {
    const lines: string[] = [];
    const capture = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
    const auth = `Bearer ${await token([NEWS_API_SIMILAR_ROLE])}`;
    const a = app({ local: { secret: SECRET } });
    const long = await request(a).post("/api/v2/internal/similar").set("authorization", auth).send({ ...body, text: `${MARKER} ${"x".repeat(8001)}` });
    expect(long.status).toBe(400);
    expect(long.body).toEqual({ error: { code: "InvalidParameter", parameter: "text" } });
    const broken = await request(a).post("/api/v2/internal/similar").set("authorization", auth).set("content-type", "application/json").send(`{"text":"${MARKER}`);
    expect(broken.status).toBe(400);
    expect(JSON.stringify(long.body) + JSON.stringify(broken.body) + lines.join("\n")).not.toContain(MARKER);
  });
});
```

- [ ] **Step 3: Write the failing flag-enforcement test (spec §9)**

Create `apps/news-api/src/search/similar-flag.test.ts`. It goes through the real `startNewsApi` wiring, with a spy wrapped around every provider `createEmbeddingProvider` makes:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { hashPassword, mintLocalToken, NEWS_API_SIMILAR_ROLE } from "@gcpe/auth";
import type { EmbeddingProvider } from "@gcpe/embeddings";
import { sampleRelease } from "@gcpe/events/testing";
import { closeHandle, createNewsTestDb, EVENT_SECRETS, writeTenantConfig } from "../../test/helpers";
import { applyRelease } from "../projections";
import { startNewsApi } from "../start";

const MARKER = "quokkadraftmarker";
const draftCalls = vi.hoisted(() => ({ n: 0 }));

vi.mock("@gcpe/embeddings", async (importOriginal) => {
  const real = await importOriginal<typeof import("@gcpe/embeddings")>();
  const spy = (p: EmbeddingProvider): EmbeddingProvider => ({
    ...p,
    async embed(texts, signal) {
      if (texts.some((t) => t.includes(MARKER))) draftCalls.n++;
      return p.embed(texts, signal);
    },
  });
  return { ...real, createEmbeddingProvider: (...args: Parameters<typeof real.createEmbeddingProvider>) => { const p = real.createEmbeddingProvider(...args); return p && spy(p); } };
});

const SECRET = "f".repeat(40);

describe("staff-AI flag enforcement (spec §9)", () => {
  afterEach(() => {
    draftCalls.n = 0;
  });

  it.each([
    [false, "text", 0],
    [true, "ai", 1],
  ] as const)("News API staffAi=%s: mode %s, %i provider call(s) for the draft, though the caller asked for ai", async (staffAi, mode, calls) => {
    const own = await createNewsTestDb();
    const handle = await startNewsApi(
      {
        DATABASE_URL: own.url,
        EVENT_SECRETS: JSON.stringify(EVENT_SECRETS),
        // semanticSearch on, so the worker embeds posts and the provider is live: only staffAi differs.
        TENANT_CONFIG: writeTenantConfig({ features: { semanticSearch: true, staffAi } }),
        EMBEDDINGS_PROVIDER: "stand-in",
        SLIDE_IMAGES_FETCH_BASE: "http://files.internal.test",
        LOCAL_ADMIN_ENABLED: "true",
        LOCAL_ADMIN_PASSWORD_HASH: await hashPassword("pw-for-tests-only"),
        LOCAL_AUTH_SECRET: SECRET,
      },
      { hub: false },
    );
    try {
      await own.db.transaction((tx) =>
        applyRelease(tx, { ...sampleRelease, key: "FLAG-1", documents: [{ ...sampleRelease.documents[0]!, headline: "salmon habitat restoration" }] }, { notify: false }),
      );
      await handle.workers.embed!();
      const token = await mintLocalToken({ secret: SECRET, subject: "nrms", roles: [NEWS_API_SIMILAR_ROLE] });
      const res = await request(handle.app)
        .post("/api/v2/internal/similar")
        .set("authorization", `Bearer ${token}`)
        .send({ text: `${MARKER} salmon habitat restoration`, terms: "salmon habitat restoration", mode: "ai" });
      expect(res.status).toBe(200);
      expect(res.body.mode).toBe(mode);
      expect(draftCalls.n).toBe(calls);
    } finally {
      await closeHandle(handle);
      await own.drop();
    }
  });
});
```

- [ ] **Step 4: Run both test files and see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/news-api/src/search/similar.test.ts apps/news-api/src/search/similar-flag.test.ts`
Expected: FAIL. `./similar` can't be resolved, and `v2Routes` has no `similar` option, so the flag test's POST gets v2's 404.

- [ ] **Step 5: Implement `search/similar.ts`**

Create `apps/news-api/src/search/similar.ts`:

```ts
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { SearchLanguage } from "@gcpe/config";
import type { Db, Tx } from "@gcpe/db-kit";
import type { GuardedEmbedder } from "@gcpe/embeddings";
import { postEmbeddings, posts } from "../db/schema";
import { VECTOR_DIMENSIONS } from "../embeddings/pgvector";
import { searchResultMapper } from "./service";
import { READ_SNAPSHOT, searchRowsByKeys, textSearch, type SearchRow } from "./text-search";

export const SIMILAR_LIMIT = 10;
export const SIMILAR_MAX_TEXT_CHARS = 8000;
export const SIMILAR_MAX_TERMS_CHARS = 1000;
const SIMILAR_MAX_TERMS = 32;

const codePoints = (s: string) => Array.from(s).length;
const noNul = (s: string) => !s.includes("\u0000");

/** Spec §7's body, plus `terms` (headline and keywords, for text mode) and `excludeKey` (the
 * release's own key). Every string is draft text: never logged, stored or echoed. */
export const similarRequestSchema = z
  .object({
    text: z.string().refine((s) => codePoints(s) <= SIMILAR_MAX_TEXT_CHARS && noNul(s)),
    terms: z.string().refine((s) => codePoints(s) <= SIMILAR_MAX_TERMS_CHARS && noNul(s)),
    mode: z.enum(["ai", "text"]),
    excludeKey: z.string().min(1).max(100).refine(noNul).optional(),
  })
  .strict();
export type SimilarRequest = z.infer<typeof similarRequestSchema>;

export type SimilarMatch = "ai" | "text";
export interface SimilarResult {
  key: string;
  headline: string | null;
  publishDate: string;
  leadMinistryKey: string | null;
  url: string;
  match: SimilarMatch;
}
export interface SimilarResponse {
  mode: SimilarMatch;
  results: SimilarResult[];
}
export interface SimilarService {
  similar(req: SimilarRequest, signal?: AbortSignal): Promise<SimilarResponse>;
}

/** The distinct words of `terms` joined with websearch_to_tsquery's `or`: a post sharing any of
 * them matches, and ts_rank_cd ranks posts sharing more of them higher. */
export function orTerms(terms: string): string {
  const words = terms.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words)].filter((w) => w !== "or").slice(0, SIMILAR_MAX_TERMS).join(" or ");
}

export interface SimilarServiceOptions {
  db: Db;
  timeZone: string;
  language: SearchLanguage;
  defaultLanguageId: number;
  publicSiteUrl: string;
  /** Cosine distance at or below which a post is an AI match (SEARCH_SEMANTIC_THRESHOLD). */
  threshold: number;
  /** Non-null only when this News API's staffAi flag, a provider and pgvector are all present
   * (start.ts). Null: no provider is ever called, whatever the request's mode. */
  embedder: GuardedEmbedder | null;
}

/**
 * Spec §7: up to 10 published posts like a draft. AI mode: the nearest posts within the
 * threshold, then text matches not among them. Nothing is cached or stored, and nothing here
 * logs; the guarded embedder logs a provider failure with its id and a safe label only.
 */
export function createSimilarService(o: SimilarServiceOptions): SimilarService {
  const toResult = searchResultMapper(o.publicSiteUrl, o.timeZone);
  const shape = (row: SearchRow, match: SimilarMatch): SimilarResult => {
    const { key, headline, publishDate, leadMinistryKey, url } = toResult(row);
    return { key, headline, publishDate, leadMinistryKey, url, match };
  };
  return {
    async similar(req, signal) {
      const vector = req.mode === "ai" && o.embedder ? await embedDraft(o.embedder, req.text, signal) : null;
      const mode: SimilarMatch = vector ? "ai" : "text";
      const q = orTerms(req.terms);
      return o.db.transaction(async (tx) => {
        const aiKeys = vector ? await nearestKeys(tx, `[${vector.join(",")}]`, o.threshold, req.excludeKey) : [];
        const aiRows = await searchRowsByKeys(tx, aiKeys, o.defaultLanguageId);
        const room = SIMILAR_LIMIT - aiRows.length;
        const textRows =
          q === "" || room === 0
            ? []
            : (
                await textSearch(tx, { q, page: 1 }, {
                  language: o.language,
                  defaultLanguageId: o.defaultLanguageId,
                  excludeKeys: [...aiKeys, ...(req.excludeKey ? [req.excludeKey] : [])],
                  window: { offset: 0, limit: room },
                })
              ).rows;
        return { mode, results: [...aiRows.map((r) => shape(r, "ai")), ...textRows.map((r) => shape(r, "text"))] };
      }, READ_SNAPSHOT);
    },
  };
}

/** The draft's vector, or null (blank text, a failed or refused call, a wrong-size vector). */
async function embedDraft(embedder: GuardedEmbedder, text: string, signal?: AbortSignal): Promise<number[] | null> {
  const input = text.replace(/\s+/g, " ").trim();
  if (input === "") return null;
  try {
    const [v] = await embedder.embed([input], signal);
    return v && v.length === VECTOR_DIMENSIONS ? v : null;
  } catch {
    return null;
  }
}

/** Exact cosine distance over published posts' embeddings, nearest first (as semantic.ts:
 * MATERIALIZED, so the approximate HNSW index never changes the answer). */
async function nearestKeys(tx: Tx, literal: string, threshold: number, excludeKey: string | undefined): Promise<string[]> {
  const exclude = excludeKey ? sql`AND lower(${posts.key}) <> ${excludeKey.toLowerCase()}` : sql``;
  const { rows } = await tx.execute<{ key: string }>(sql`
    WITH scored AS MATERIALIZED (
      SELECT ${posts.key} AS key, (${postEmbeddings.embedding}::vector(1536)) <=> ${literal}::vector(1536) AS distance
      FROM ${postEmbeddings} JOIN ${posts} ON ${posts.key} = ${postEmbeddings.postKey}
      WHERE ${posts.isPublished} = true ${exclude}
    )
    SELECT key FROM scored
    WHERE distance <= ${threshold}
    ORDER BY distance, key COLLATE "C"
    LIMIT ${SIMILAR_LIMIT}`);
  return rows.map((r) => r.key);
}
```

If `SearchRow` isn't exported from `text-search.ts` under that name, it is (`export interface SearchRow`). If `Tx` isn't exported from `@gcpe/db-kit`, `semantic.ts` already imports it from there.

- [ ] **Step 6: Mount the route**

In `apps/news-api/src/http/v2/routes.ts`:

- imports: add `NEWS_API_SIMILAR_ROLE, requireAnyRole, requireBearer, type BearerOptions` from `@gcpe/auth`, and `similarRequestSchema, type SimilarService` from `../../search/similar`.
- `deps` gains:

```ts
  /** POST /internal/similar (addendum §7): NRMS's service token only; bearer null → 503. */
  similar?: { service: SimilarService; bearer: BearerOptions | null };
```

- After the `related` block and before the final `r.use((_req, res) => … 404 …)`:

```ts
  if (deps.similar) {
    const { service, bearer } = deps.similar;
    if (!bearer) {
      r.post("/internal/similar", (_req, res) => void res.status(503).json({ error: "similar not configured" }));
    } else {
      // Authenticated before the body is parsed. The body is draft text: a validation error names
      // the parameter only, and the app's error handler logs the path and a safe label, never it.
      r.post("/internal/similar", requireBearer(bearer), requireAnyRole(NEWS_API_SIMILAR_ROLE), express.json({ limit: "64kb" }), async (req, res) => {
        const parsed = similarRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          return void res.status(400).json({ error: { code: "InvalidParameter", parameter: String(parsed.error.issues[0]?.path[0] ?? "body") } });
        }
        const controller = new AbortController();
        const onClose = () => {
          if (!res.writableEnded) controller.abort();
        };
        req.on("close", onClose);
        try {
          res.json(await service.similar(parsed.data, controller.signal));
        } finally {
          req.off("close", onClose);
        }
      });
    }
  }
```

The malformed-JSON case in the test reaches `jsonErrorHandler`, which answers 400 `{ error: <body-parser's exposed message> }` and logs `request failed POST /internal/similar entity.parse.failed`. Neither carries the body; the test pins that.

In `apps/news-api/src/app.ts`:
- `AppDeps` gains `similar?: { service: SimilarService; bearer: BearerOptions | null };`, importing `type BearerOptions` from `@gcpe/auth` and `type SimilarService` from `./search/similar`.
- The `v2Routes({...})` call passes `similar: deps.similar`.

- [ ] **Step 7: Wire the flag check and the worker in `start.ts`**

In `apps/news-api/src/start.ts`:
- Import `createSimilarService` from `./search/similar`.
- Replace the block from `let searchMode: SearchMode;` through the end of its `try … catch` with:

```ts
  let searchMode: SearchMode;
  // Spec §7: staff AI needs this News API's own staffAi flag, a provider and pgvector, whatever
  // NRMS's flag says.
  let similarAi = false;
  try {
    await assertSearchLanguage(db, tenant.search.language);
    const pgvector = await hasPgvector(db);
    const resolved = resolveSearchMode({ flag: tenant.features.semanticSearch, provider, pgvector });
    searchMode = resolved.mode;
    if (tenant.features.semanticSearch && searchMode === "text") console.warn(`[news-api] semantic search is off: missing ${resolved.missing.join(", ")}`);
    const staffAi = resolveSearchMode({ flag: tenant.features.staffAi, provider, pgvector });
    similarAi = staffAi.mode === "semantic";
    if (tenant.features.staffAi && !similarAi) console.warn(`[news-api] staff AI is off: missing ${staffAi.missing.join(", ")}`);
    if ((searchMode === "semantic" || similarAi) && !(await hasHnswIndex(db))) {
      console.warn("[news-api] post_embeddings has no HNSW index: related posts scan every embedding (see the runbook, pgvector and the search mode)");
    }
  } catch (e) {
    await pool.end();
    throw e;
  }
```

- Change the worker gate so AI matching has post vectors (published posts only, as the worker always does):

```ts
  // The worker runs for semantic search or staff AI: AI matching compares drafts with published
  // posts' vectors. Its own provider instance (a longer timeout for a 50-post batch) and breaker.
  const workerProvider = searchMode === "semantic" || similarAi ? createEmbeddingProvider({ ...parsed, EMBEDDINGS_TIMEOUT_MS: WORKER_EMBED_TIMEOUT_MS }) : null;
```

- Compute the bearer once, `const serviceBearer = changesBearerFromEnv(env);`, just before `const app = createApp({`.
- In `createApp({...})`, change `changes: { db, timeZone: tenant.timeZone, bearer: changesBearerFromEnv(env) }` to use `bearer: serviceBearer`, and add:

```ts
    similar: {
      bearer: serviceBearer,
      service: createSimilarService({
        db,
        timeZone: tenant.timeZone,
        language: tenant.search.language,
        defaultLanguageId: tenant.defaultLanguageId,
        publicSiteUrl: parsed.PUBLIC_SITE_URL ?? tenant.publicSiteBaseUrl,
        threshold: parsed.SEARCH_SEMANTIC_THRESHOLD,
        // Its own breaker; never the search route's query-vector cache.
        embedder: similarAi && provider ? createGuardedEmbedder({ provider }) : null,
      }),
    },
```

- [ ] **Step 8: Run the tests and see them pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/news-api/src/search/ apps/news-api/src/http/v2/ apps/news-api/src/start.test.ts apps/news-api/src/app.test.ts packages/auth`
Expected: PASS. If the `[true, "ai", 1]` row reports more than 1 call, a second path is embedding the draft: find it before going on, don't loosen the assertion.

- [ ] **Step 9: Type-check**

Run: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: no errors.

- [ ] **Step 10: Docs (running notes and runbook headings)**

In `docs/manuals/running-notes.md`, directly after the `## Phase 6c — The public site` list, add:

```markdown
## Phase 6d–6e — Staff help and the exit checks

- **Developer** — The News API has a service-only `POST /api/v2/internal/similar` for NRMS (role `NewsApi.Similar`). It never stores, caches or logs the draft text it is sent, and only ever returns published posts.
- **Operations** — With the staff-AI flag on (and a provider and pgvector), the News API's embedding worker runs even when semantic search is off: AI matching compares drafts with published posts' vectors. Search and related posts stay in text mode until `semanticSearch` is also on.
```

In `docs/deploy/siteground.md`, just before `## Troubleshooting` (after the Phase 6c section), add:

```markdown
## Staff help and the exit checks (Phases 6d–6e)

### The internal similar route

`POST /api/v2/internal/similar` answers NRMS's "Similar published releases" panel. It accepts only a bearer token with the `NewsApi.Similar` role, verified the same way as the change feed (Entra with `NEWSAPI_AUTH_AUDIENCE`, or local tokens where `LOCAL_ADMIN_ENABLED=true`); with neither it answers 503. A staff session cookie never opens it. It uses AI matching only when this News API's own tenant config has `features.staffAi: true`, an embeddings provider is configured and pgvector is present; otherwise it answers in text mode and says so (`"mode": "text"`). At start the News API logs `staff AI is off: missing …` when the flag is on but something else is missing.
```

- [ ] **Step 11: Commit**

```bash
git add packages/auth/src/roles.ts packages/auth/src/index.ts apps/news-api/src/search/similar.ts apps/news-api/src/search/similar.test.ts apps/news-api/src/search/similar-flag.test.ts apps/news-api/src/http/v2/routes.ts apps/news-api/src/app.ts apps/news-api/src/start.ts docs/manuals/running-notes.md docs/deploy/siteground.md
git commit -m "news-api: service-only POST /api/v2/internal/similar with its own staff-AI check (addendum §7, §9)"
```

---

### Task 2: NRMS asks the News API, with its own flag check

**Review:** full (flag enforcement, privacy).

**Files:**
- Create: `apps/nrms/src/releases/similar.ts`
- Modify: `apps/nrms/src/clients.ts`, `apps/nrms/src/start.ts`, `apps/nrms/src/app.ts`, `apps/nrms/src/http/routes.ts`, `apps/stack/src/env.ts`
- Test: `apps/nrms/src/releases/similar.test.ts`, `apps/nrms/src/http/similar-route.test.ts`, `apps/nrms/src/clients.test.ts`, `apps/nrms/src/start.test.ts`, `apps/stack/src/env.test.ts`
- Docs: `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`

**Interfaces:**
- Consumes:
  - Task 1's route and body.
  - `NEWS_API_SIMILAR_ROLE`.
  - `serviceTokenProvider`, `ServiceTokenOptions`, `LocalAuthConfig` (`@gcpe/auth`).
  - `loadView`, `ReleaseView`, `LANG_EN`.
  - `htmlToText` (`apps/nrms/src/text/html-to-text.ts`).
  - `organizations` (`apps/nrms/src/db/schema.ts`).
- Produces:
  - `newsApiSimilarClient({ baseUrl, getToken, fetchImpl? }): NewsApiSimilarClient`, with `similar(req: SimilarRequestBody): Promise<SimilarFound>`.
  - `newsApiServiceTokenOptions(parsed, local)`.
  - `POST /nrms/api/releases/:id/similar` (NRMS.Editor). 200 response: `{ mode: "ai" | "text"; results: { key: string; headline: string | null; publishDate: string; leadMinistry: string | null; url: string; match: "ai" | "text" }[] }`. Errors: 404, 422 `{ error }`, 502 `{ error }`, 503 `{ error }`.
  - `GET /nrms/api/config` adds `similarAvailable: boolean` and `staffAi: boolean`.

- [ ] **Step 1: Write the failing client test**

Append to `apps/nrms/src/clients.test.ts` (and add `newsApiSimilarClient` to its import from `./clients`):

```ts
describe("newsApiSimilarClient", () => {
  const body = { text: "quokkadraftmarker draft", terms: "draft", mode: "text" as const };

  it("posts the body as JSON to /api/v2/internal/similar with bearer auth", async () => {
    const found = { mode: "text", results: [] };
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(found), { status: 200 }));
    const client = newsApiSimilarClient({ baseUrl: "http://stack.internal/", getToken: async () => "tok", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.similar(body)).resolves.toEqual(found);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("http://stack.internal/api/v2/internal/similar");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ authorization: "Bearer tok", "content-type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual(body);
  });

  it("rejects with the status only, never the text or the token", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const client = newsApiSimilarClient({ baseUrl: "http://news.example", getToken: async () => "secret-token", fetchImpl: fetchImpl as unknown as typeof fetch });
    const err: unknown = await client.similar(body).catch((e: unknown) => e);
    expect(String(err)).toMatch(/News API similar failed: HTTP 500/);
    expect(String(err)).not.toContain("quokkadraftmarker");
    expect(String(err)).not.toContain("secret-token");
  });
});
```

- [ ] **Step 2: Write the failing source and outcome tests**

Create `apps/nrms/src/releases/similar.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { view } from "@gcpe/nrms-contract/testing";
import type { Db } from "@gcpe/db-kit";
import type { NewsApiSimilarClient, SimilarRequestBody } from "../clients";
import { findSimilar, similarSource } from "./similar";

const MARKER = "quokkadraftmarker";
const noDb = undefined as unknown as Db;

describe("similarSource", () => {
  it("is the English headline, summary, keywords and every document's body as one line; terms are headline and keywords", () => {
    const v = view({
      keywords: "clinics, weekends",
      documents: [
        { ...view().documents[0]!, sortIndex: 1, languages: [{ ...view().documents[0]!.languages[0]!, headline: "Second doc", bodyHtml: "<p>Backgrounder&nbsp;text.</p>" }] },
        { ...view().documents[0]!, id: "d0", sortIndex: 0, languages: [{ ...view().documents[0]!.languages[0]!, headline: "Clinics open", bodyHtml: "<p>Clinics will open.</p>\n<p>More.</p>" }] },
      ],
    });
    expect(similarSource(v)).toEqual({ text: "Clinics open Clinics open. clinics, weekends Clinics will open. More. Backgrounder text.", terms: "Clinics open clinics, weekends" });
  });

  it("caps the text at 8,000 code points and the terms at 1,000", () => {
    const long = "é".repeat(9000);
    const v = view({ keywords: long, languages: [{ ...view().languages[0]!, summary: "" }], documents: [] });
    const s = similarSource(v);
    expect(Array.from(s.text)).toHaveLength(8000);
    expect(Array.from(s.terms)).toHaveLength(1000);
  });
});

describe("findSimilar", () => {
  afterEach(() => vi.restoreAllMocks());
  const client = (impl: NewsApiSimilarClient["similar"]) => {
    const calls: SimilarRequestBody[] = [];
    return { calls, client: { similar: async (b: SimilarRequestBody) => (calls.push(b), impl(b)) } };
  };

  it("a blank draft is refused without a call", async () => {
    const c = client(async () => ({ mode: "text", results: [] }));
    const blank = view({ keywords: null, languages: [{ ...view().languages[0]!, summary: "" }], documents: [] });
    expect(await findSimilar(noDb, blank, { client: c.client, staffAi: true })).toEqual({ kind: "empty" });
    expect(c.calls).toEqual([]);
  });

  it.each([
    [false, "text"],
    [true, "ai"],
  ] as const)("NRMS staffAi=%s sends mode %s, and excludeKey is the release's key", async (staffAi, mode) => {
    const c = client(async () => ({ mode: "text", results: [] }));
    await findSimilar(noDb, view({ key: "2026HLTH0001-000001" }), { client: c.client, staffAi });
    expect(c.calls[0]).toMatchObject({ mode, excludeKey: "2026HLTH0001-000001" });
    expect(c.calls[0]?.text).toContain("Clinics open");
  });

  it("a News API failure is 'failed', and nothing logs the draft", async () => {
    const lines: string[] = [];
    const capture = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
    const c = client(async () => {
      throw new Error(`boom ${MARKER}`);
    });
    const v = view({ keywords: MARKER });
    expect(await findSimilar(noDb, v, { client: c.client, staffAi: false })).toEqual({ kind: "failed" });
    expect(lines.length).toBe(1);
    expect(lines.join("\n")).not.toContain(MARKER);
    expect(lines.join("\n")).not.toContain("Clinics open");
  });
});
```

The `similarSource` expectation is built from the testing `view()`: summary "Clinics open.", the headline, the keywords, then the bodies in `sortIndex` order. If `htmlToText` renders `&nbsp;` or the paragraph break differently, fix the *expected string* to what it really produces, after checking the output is one collapsed line. The order and the content are what this test pins.

- [ ] **Step 3: Write the failing route test**

Create `apps/nrms/src/http/similar-route.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { mintSession } from "@gcpe/auth";
import { createNrmsTestDb, sampleCreate, seedTaxonomy } from "../../test/helpers";
import { createApp } from "../app";
import type { NewsApiSimilarClient, SimilarRequestBody } from "../clients";

const SECRET = "y".repeat(40) + "-nrms-similar-test";

describe("POST /api/releases/:id/similar", () => {
  let tdb: TestDatabase;
  let editor: string;
  let viewer: string;
  const sent: SimilarRequestBody[] = [];
  const client: NewsApiSimilarClient = {
    async similar(b) {
      sent.push(b);
      return {
        mode: b.mode,
        results: [{ key: "2026FIN0002-000002", headline: "Clinics budget", publishDate: "2026-10-03T10:00:00-07:00", leadMinistryKey: "FINANCE", url: "https://site.example.test/releases/2026FIN0002-000002", match: b.mode }],
      };
    },
  };
  const app = (similar?: { client: NewsApiSimilarClient; staffAi: boolean }) =>
    createApp({ db: tdb.db, auth: { session: { secret: SECRET } }, eventSecrets: {}, workflow: { timeZone: "America/Vancouver" }, similar });
  const cookie = async (roles: string[]) => `gcpe_session=${(await mintSession(SECRET, { id: "00000000-0000-4000-8000-00000000000b", name: "Pat", email: "pat@example.invalid", roles })).token}`;
  const create = async () => {
    const res = await request(app()).post("/api/releases").set("cookie", editor).set("x-gcpe-request", "1").send(sampleCreate);
    expect(res.status).toBe(201);
    return res.body as { id: string };
  };
  const find = (a: ReturnType<typeof app>, id: string, c = editor) => request(a).post(`/api/releases/${id}/similar`).set("cookie", c).set("x-gcpe-request", "1");

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    await seedTaxonomy(tdb.db);
    editor = await cookie(["NRMS.Editor"]);
    viewer = await cookie(["NRMS.Viewer"]);
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it.each([
    [false, "text"],
    [true, "ai"],
  ] as const)("staffAi=%s: sends mode %s and answers with lead-ministry names", async (staffAi, mode) => {
    const { id } = await create();
    const res = await find(app({ client, staffAi }), id);
    expect(res.status).toBe(200);
    expect(sent.at(-1)).toMatchObject({ mode });
    expect(sent.at(-1)?.text).toContain("Weekend clinics open across B.C.");
    expect(res.body).toEqual({
      mode,
      results: [{ key: "2026FIN0002-000002", headline: "Clinics budget", publishDate: "2026-10-03T10:00:00-07:00", leadMinistry: "Finance", url: "https://site.example.test/releases/2026FIN0002-000002", match: mode }],
    });
  });

  it("writes nothing to the release's history", async () => {
    const { id } = await create();
    const log = async () => (await request(app()).get(`/api/releases/${id}/log?all=true`).set("cookie", editor)).body as unknown[];
    const before = await log();
    await find(app({ client, staffAi: true }), id);
    expect(await log()).toEqual(before);
  });

  it("403 for a viewer, 404 for an unknown release, 503 without a News API", async () => {
    const { id } = await create();
    expect((await find(app({ client, staffAi: false }), id, viewer)).status).toBe(403);
    expect((await find(app({ client, staffAi: false }), "00000000-0000-4000-8000-0000000000ff")).status).toBe(404);
    expect((await find(app(), id)).status).toBe(503);
  });

  it("502 with a generic message when the News API fails", async () => {
    const { id } = await create();
    const res = await find(app({ client: { similar: async () => { throw new Error("down"); } }, staffAi: false }), id);
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Couldn't look for similar releases — try again." });
  });

  it("GET /config says whether the panel is available and whether staff AI is on", async () => {
    expect((await request(app()).get("/api/config").set("cookie", viewer)).body).toMatchObject({ similarAvailable: false, staffAi: false });
    expect((await request(app({ client, staffAi: true })).get("/api/config").set("cookie", viewer)).body).toMatchObject({ similarAvailable: true, staffAi: true });
  });
});
```

- [ ] **Step 4: Write the failing wiring tests**

In `apps/nrms/src/start.test.ts`, next to the existing `nodServiceTokenOptions` test (add `newsApiServiceTokenOptions` to its import from `./start`, and `NEWS_API_SIMILAR_ROLE` from `@gcpe/auth`):

```ts
it("newsApiServiceTokenOptions: subject nrms, only the NewsApi.Similar role, NEWS_API_* env names", () => {
  const o = newsApiServiceTokenOptions({ NEWS_API_TOKEN_URL: undefined, NEWS_API_CLIENT_ID: undefined, NEWS_API_CLIENT_SECRET: undefined, NEWS_API_SCOPE: undefined }, { secret: "x".repeat(40) });
  expect(o).toMatchObject({ subject: "nrms", roles: [NEWS_API_SIMILAR_ROLE], envPrefix: "NEWS_API" });
});
```

In `apps/stack/src/env.test.ts`, change the "applies STACK_APP_DEFAULTS …" expectation to also include `NEWS_API_URL: "self:/"`:

```ts
    expect(envFor({}, "NRMS")).toMatchObject({ NOD_URL: "self:/nod", DISTRIBUTION_URL: "self:/distribution", CORE_URL: "self:/core", NEWS_API_URL: "self:/" });
```

- [ ] **Step 5: Run them and see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nrms/src/clients.test.ts apps/nrms/src/releases/similar.test.ts apps/nrms/src/http/similar-route.test.ts apps/nrms/src/start.test.ts apps/stack/src/env.test.ts`
Expected: FAIL. `newsApiSimilarClient`, `./similar` and `newsApiServiceTokenOptions` don't exist, `createApp` has no `similar`, and the stack default is missing.

- [ ] **Step 6: The client**

Append to `apps/nrms/src/clients.ts`:

```ts
// Embedding the draft (about 1s at most) plus two short queries.
const NEWS_API_SIMILAR_TIMEOUT_MS = 10_000;

/** The body of the News API's `POST /api/v2/internal/similar` (addendum §7). Draft text: never logged. */
export interface SimilarRequestBody {
  text: string;
  terms: string;
  mode: "ai" | "text";
  excludeKey?: string;
}

export interface SimilarFound {
  mode: "ai" | "text";
  results: { key: string; headline: string | null; publishDate: string; leadMinistryKey: string | null; url: string; match: "ai" | "text" }[];
}

export interface NewsApiSimilarClientOptions {
  baseUrl: string;
  getToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
}

export interface NewsApiSimilarClient {
  similar(body: SimilarRequestBody): Promise<SimilarFound>;
}

/** NRMS's client for the News API's similar route. A non-2xx rejects with the status only. */
export function newsApiSimilarClient(opts: NewsApiSimilarClientOptions): NewsApiSimilarClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/api/v2/internal/similar`;
  return {
    async similar(body) {
      const token = await opts.getToken();
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(NEWS_API_SIMILAR_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`News API similar failed: HTTP ${res.status}`);
      return (await res.json()) as SimilarFound;
    },
  };
}
```

- [ ] **Step 7: The source and outcome**

Create `apps/nrms/src/releases/similar.ts`:

```ts
import { inArray } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { safeErrorLabel } from "@gcpe/http-kit";
import { LANG_EN, type ReleaseView } from "@gcpe/nrms-contract";
import type { NewsApiSimilarClient } from "../clients";
import { organizations } from "../db/schema";
import { htmlToText } from "../text/html-to-text";

export const SIMILAR_TEXT_MAX_CHARS = 8000;
export const SIMILAR_TERMS_MAX_CHARS = 1000;

const oneLine = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const cap = (s: string, n: number) => {
  const cps = Array.from(s);
  return cps.length <= n ? s : cps.slice(0, n).join("");
};
const english = <T extends { languageId: number }>(langs: T[]): T | undefined => langs.find((l) => l.languageId === LANG_EN) ?? langs[0];

/** Spec §7's text: headline, summary, keywords and the body as plain text, capped at 8,000
 * characters; `terms` (headline and keywords) drives text-mode matching. From the saved release. */
export function similarSource(view: ReleaseView): { text: string; terms: string } {
  const docs = [...view.documents].sort((a, b) => a.sortIndex - b.sortIndex);
  const headline = oneLine(english(docs[0]?.languages ?? [])?.headline);
  const summary = oneLine(english(view.languages)?.summary);
  const keywords = oneLine(view.keywords);
  const bodies = docs.map((d) => oneLine(htmlToText(english(d.languages)?.bodyHtml ?? "")));
  const join = (parts: string[]) => parts.filter((p) => p !== "").join(" ");
  return { text: cap(join([headline, summary, keywords, ...bodies]), SIMILAR_TEXT_MAX_CHARS), terms: cap(join([headline, keywords]), SIMILAR_TERMS_MAX_CHARS) };
}

export interface SimilarDeps {
  client: NewsApiSimilarClient;
  /** NRMS's own tenant features.staffAi: off means NRMS never asks for AI matching. */
  staffAi: boolean;
}

export interface SimilarRelease {
  key: string;
  headline: string | null;
  publishDate: string;
  leadMinistry: string | null;
  url: string;
  match: "ai" | "text";
}

export type SimilarOutcome = { kind: "found"; found: { mode: "ai" | "text"; results: SimilarRelease[] } } | { kind: "empty" } | { kind: "failed" };

/** Asks the News API for published releases like this one. Writes nothing; a failure logs a safe
 * label only, never the draft. */
export async function findSimilar(db: Db, view: ReleaseView, deps: SimilarDeps): Promise<SimilarOutcome> {
  const { text, terms } = similarSource(view);
  if (text === "") return { kind: "empty" };
  let found;
  try {
    found = await deps.client.similar({ text, terms, mode: deps.staffAi ? "ai" : "text", ...(view.key ? { excludeKey: view.key } : {}) });
  } catch (e) {
    console.error(`[nrms] similar releases failed ${safeErrorLabel(e)}`);
    return { kind: "failed" };
  }
  const keys = [...new Set(found.results.map((r) => r.leadMinistryKey?.toLowerCase()).filter((k): k is string => !!k))];
  const rows = keys.length ? await db.select({ key: organizations.key, name: organizations.displayName }).from(organizations).where(inArray(organizations.key, keys)) : [];
  const names = new Map(rows.map((r) => [r.key.toLowerCase(), r.name]));
  return {
    kind: "found",
    found: {
      mode: found.mode,
      results: found.results.map((r) => ({
        key: r.key,
        headline: r.headline,
        publishDate: r.publishDate,
        leadMinistry: r.leadMinistryKey ? (names.get(r.leadMinistryKey.toLowerCase()) ?? null) : null,
        url: r.url,
        match: r.match,
      })),
    },
  };
}
```

If NRMS's `organizations.key` holds mixed case for some rows, the lower-casing above still matches the ones stored lower-case (as `ministryName` assumes). The seed is lower-case.

- [ ] **Step 8: The route and `/config`**

In `apps/nrms/src/http/routes.ts`:

- imports: `import { findSimilar, type SimilarDeps } from "../releases/similar";`
- `RouteDeps` gains:

```ts
  /** "Similar published releases" (addendum §7): the News API client and NRMS's own staffAi flag; unset → 503. */
  similar?: SimilarDeps;
```

- In `GET /config`'s JSON, add after `isTestSite`:

```ts
        similarAvailable: deps.similar !== undefined,
        staffAi: deps.similar?.staffAi ?? false,
```

- Directly after the `"/releases/:id/email-copy"` route:

```ts
  // "Similar published releases" (addendum §7): editors only, on an explicit click. Read-only:
  // no history entry, nothing stored, and the draft text never reaches a log line.
  r.post(
    "/releases/:id/similar",
    edit,
    run(async (req, res) => {
      if (!deps.similar) return void res.status(503).json({ error: "Similar releases aren't set up here." });
      const view = await visibleView(req.params.id);
      if (!view) return notFound(res);
      const outcome = await findSimilar(db, view, deps.similar);
      if (outcome.kind === "empty") return void res.status(422).json({ error: "Add a headline or some body text first." });
      if (outcome.kind === "failed") return void res.status(502).json({ error: "Couldn't look for similar releases — try again." });
      res.json(outcome.found);
    }),
  );
```

In `apps/nrms/src/app.ts`:
- `createApp`'s deps gain `similar?: SimilarDeps;`, importing `type SimilarDeps` from `./releases/similar`, with a one-line doc comment like its neighbours.
- `apiRoutes({...})` passes `similar: deps.similar`.

- [ ] **Step 9: Env, token options and start wiring**

In `apps/nrms/src/start.ts`:

- `nrmsEnvSchema`, after the `CORE_*` block:

```ts
  // Addendum §7: the News API, for "Similar published releases". Optional (the route answers 503
  // and the panel hides when unset); the stack defaults it to self:/. Same all-or-none Entra
  // fields and local-token fallback as NOD_*.
  NEWS_API_URL: z.string().url().optional(),
  NEWS_API_TOKEN_URL: z.string().url().optional(),
  NEWS_API_CLIENT_ID: z.string().optional(),
  NEWS_API_CLIENT_SECRET: z.string().optional(),
  NEWS_API_SCOPE: z.string().optional(),
```

- After `coreServiceTokenOptions` (import `NEWS_API_SIMILAR_ROLE` from `@gcpe/auth`):

```ts
/** {@link ServiceTokenOptions} for NRMS's calls to the News API's similar route: only the
 * `NewsApi.Similar` service role (not a staff role). */
export function newsApiServiceTokenOptions(
  parsed: Pick<z.infer<typeof nrmsEnvSchema>, "NEWS_API_TOKEN_URL" | "NEWS_API_CLIENT_ID" | "NEWS_API_CLIENT_SECRET" | "NEWS_API_SCOPE">,
  local: LocalAuthConfig | null,
): ServiceTokenOptions {
  return {
    tokenUrl: parsed.NEWS_API_TOKEN_URL,
    clientId: parsed.NEWS_API_CLIENT_ID,
    clientSecret: parsed.NEWS_API_CLIENT_SECRET,
    scope: parsed.NEWS_API_SCOPE,
    local,
    subject: "nrms",
    roles: [NEWS_API_SIMILAR_ROLE],
    envPrefix: "NEWS_API",
  };
}
```

- In `startNrms`, after `const core = …` (import `newsApiSimilarClient` from `./clients`):

```ts
  const similar = parsed.NEWS_API_URL
    ? {
        client: newsApiSimilarClient({ baseUrl: parsed.NEWS_API_URL, getToken: serviceTokenProvider(newsApiServiceTokenOptions(parsed, auth.local)) }),
        staffAi: tenant.features.staffAi,
      }
    : undefined;
  // The flag only, never a URL or token.
  console.log(`[nrms] similar releases: ${similar ? (similar.staffAi ? "AI and text" : "text only") : "not configured"}`);
```

  and pass `similar,` into `createApp({...})`.

In `apps/stack/src/env.ts`, change the `NRMS` entry of `STACK_APP_DEFAULTS` to:

```ts
  NRMS: { NOD_URL: "self:/nod", DISTRIBUTION_URL: "self:/distribution", CORE_URL: "self:/core", NEWS_API_URL: "self:/" },
```

and add one sentence to the comment above it: "NEWS_API_URL (addendum §7): the News API is mounted at the stack's root."

- [ ] **Step 10: Run the tests and see them pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nrms apps/stack`
Expected: PASS. NRMS's existing `routes.test.ts` "GET /config" test uses `toMatchObject`, so the two new fields don't break it.

- [ ] **Step 11: Type-check**

Run: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: no errors.

- [ ] **Step 12: Docs**

Running notes, under `## Phase 6d–6e — Staff help and the exit checks`:

```markdown
- **Administrator** — Standalone (OpenShift): NRMS needs `NEWS_API_URL` and an Entra app registration holding the News API's `NewsApi.Similar` app role (`NEWS_API_TOKEN_URL`, `NEWS_API_CLIENT_ID`, `NEWS_API_CLIENT_SECRET`, `NEWS_API_SCOPE`) for "Similar published releases". Without `NEWS_API_URL` the panel doesn't appear. On the stack it's wired automatically.
```

Runbook, in `## Staff help and the exit checks (Phases 6d–6e)`, after "The internal similar route":

```markdown
### Turning the flags on, and the PIA gate for staff AI

Both flags live in the tenant config (`config/tenants/<tenant>.json`), under `"features"`, and both are off by default. Changing one needs a restart (the stack reads the file at start).

- **`semanticSearch`** (public search and related posts). Safe to turn on once an embeddings provider is configured (`NEWSAPI_EMBEDDINGS_PROVIDER` plus the Azure settings, Q70) and the News API's database has pgvector (see "pgvector and the search mode"). `/stack/health` then reports `"newsApiSearch": "semantic"`; it stays `text` on boxs.ca, whose Postgres has no pgvector (Q80).
- **`staffAi`** (AI matching in "Similar published releases") **sends unpublished draft text to the AI service. Do not turn it on in any environment that holds real drafts until the privacy impact assessment approves it (D4, Q71).** NRMS and the News API each check their own copy of the flag: NRMS only asks for AI matching when its flag is on, and the News API only calls the provider when its own flag, a provider and pgvector are all present. On the stack both read the same `TENANT_CONFIG`; standalone, set it in both apps' tenant files. With it off, the panel still works with text matching, and nothing is sent anywhere but the News API.
- After turning `staffAi` on, check the News API's start log has no `staff AI is off: missing …` line, then press **Find similar** on a draft: results labelled *AI match* mean the whole path works.
```

- [ ] **Step 13: Commit**

```bash
git add apps/nrms/src/clients.ts apps/nrms/src/clients.test.ts apps/nrms/src/releases/similar.ts apps/nrms/src/releases/similar.test.ts apps/nrms/src/http/similar-route.test.ts apps/nrms/src/http/routes.ts apps/nrms/src/app.ts apps/nrms/src/start.ts apps/nrms/src/start.test.ts apps/stack/src/env.ts apps/stack/src/env.test.ts docs/manuals/running-notes.md docs/deploy/siteground.md
git commit -m "nrms: POST /api/releases/:id/similar asks the News API, sending ai only with its own staffAi flag (addendum §7)"
```

---

### Task 3: The "Similar published releases" panel, and its E2E and axe check

**Review:** shared (UI).

**Files:**
- Create: `apps/staff-web/src/screens/release/SimilarReleasesPanel.tsx`, `SimilarReleasesPanel.test.tsx`
- Modify: `apps/staff-web/src/screens/release/ReleaseEditorPage.tsx`, `apps/staff-web/src/styles/global.css`
- Create: `tests/e2e/staff-similar.spec.ts`
- Modify: `tests/e2e/global-setup.ts`
- Docs: `docs/manuals/running-notes.md`

**Interfaces:**
- Consumes: Task 2's `POST /nrms/api/releases/:id/similar` and `GET /nrms/api/config` (`similarAvailable`, `staffAi`); `apiFetch`, `ApiError`.
- Produces: `SimilarReleasesPanel({ view, timeZone })`, a `<section id="similar-releases">` region named "Similar published releases"; `AI_NOTE`.

- [ ] **Step 1: Write the failing component tests**

Create `apps/staff-web/src/screens/release/SimilarReleasesPanel.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { view as releaseView } from "@gcpe/nrms-contract/testing";
import { jsonResponse } from "../../../test/jsonResponse";
import { AI_NOTE, SimilarReleasesPanel } from "./SimilarReleasesPanel";

const VIEW = releaseView();
const RESULT = { key: "2026FIN0002-000002", headline: "Clinics budget", publishDate: "2026-10-03T10:00:00-07:00", leadMinistry: "Finance", url: "https://site.example.test/releases/2026FIN0002-000002", match: "ai" };

function stub(config: object, similar: () => Response): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      return url === "/nrms/api/config" ? jsonResponse(200, config) : similar();
    }),
  );
  return calls;
}
const renderPanel = () => render(<SimilarReleasesPanel view={VIEW} timeZone="America/Vancouver" />);

describe("SimilarReleasesPanel (addendum §7)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders nothing when NRMS has no News API", async () => {
    const calls = stub({ similarAvailable: false, staffAi: false }, () => jsonResponse(500, {}));
    const { container } = renderPanel();
    await waitFor(() => expect(calls).toEqual(["/nrms/api/config"]));
    expect(container).toBeEmptyDOMElement();
  });

  it("runs nothing until Find similar is pressed; with the flag on, the button is described by the AI note", async () => {
    const calls = stub({ similarAvailable: true, staffAi: true }, () => jsonResponse(200, { mode: "ai", results: [RESULT] }));
    renderPanel();
    const button = await screen.findByRole("button", { name: "Find similar" });
    expect(button).toHaveAccessibleDescription(AI_NOTE);
    expect(calls).toEqual(["/nrms/api/config"]);
    await userEvent.setup().click(button);
    expect(await screen.findByRole("link", { name: /Clinics budget/ })).toHaveAttribute("href", RESULT.url);
    expect(screen.getByText("AI match")).toBeInTheDocument();
    expect(screen.getByText(/Oct 3, 2026 · Finance/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Found 1 similar published release.");
    expect(calls).toEqual(["/nrms/api/config", `/nrms/api/releases/${VIEW.id}/similar`]);
  });

  it("with the flag off: no AI note, text matches", async () => {
    stub({ similarAvailable: true, staffAi: false }, () => jsonResponse(200, { mode: "text", results: [{ ...RESULT, match: "text" }] }));
    renderPanel();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Find similar" }));
    expect(await screen.findByText("Text match")).toBeInTheDocument();
    expect(screen.queryByText(AI_NOTE)).not.toBeInTheDocument();
  });

  it("says when AI was asked for but the answer is text matches", async () => {
    stub({ similarAvailable: true, staffAi: true }, () => jsonResponse(200, { mode: "text", results: [{ ...RESULT, match: "text" }] }));
    renderPanel();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Find similar" }));
    expect(await screen.findByText(/The AI service wasn.t available, so these are text matches\./)).toBeInTheDocument();
  });

  it("says so when nothing is similar", async () => {
    stub({ similarAvailable: true, staffAi: false }, () => jsonResponse(200, { mode: "text", results: [] }));
    renderPanel();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Find similar" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("No similar published releases found."));
  });

  it("shows the server's message on a failure", async () => {
    stub({ similarAvailable: true, staffAi: false }, () => jsonResponse(422, { error: "Add a headline or some body text first." }));
    renderPanel();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Find similar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Add a headline or some body text first.");
  });

  it("has no serious or critical axe violations with results shown", async () => {
    stub({ similarAvailable: true, staffAi: true }, () => jsonResponse(200, { mode: "ai", results: [RESULT, { ...RESULT, key: "K2", headline: null, leadMinistry: null, match: "text" }] }));
    const { container } = renderPanel();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Find similar" }));
    await screen.findByText("Text match");
    const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/release/SimilarReleasesPanel.test.tsx`
Expected: FAIL, because `./SimilarReleasesPanel` can't be resolved.

- [ ] **Step 3: The component**

Create `apps/staff-web/src/screens/release/SimilarReleasesPanel.tsx`:

```tsx
import { useEffect, useId, useState } from "react";
import { Button, InlineAlert } from "@bcgov/design-system-react-components";
import type { ReleaseView } from "@gcpe/nrms-contract";
import { apiFetch, ApiError } from "../../api/client";

/** Shown under the button while the staff-AI flag is on (addendum §7). */
export const AI_NOTE = "Sends this draft's text to the AI service to compare.";

export interface SimilarRelease {
  key: string;
  headline: string | null;
  publishDate: string;
  leadMinistry: string | null;
  url: string;
  match: "ai" | "text";
}
export interface SimilarResponse {
  mode: "ai" | "text";
  results: SimilarRelease[];
}
interface SimilarConfig {
  similarAvailable?: boolean;
  staffAi?: boolean;
}

const dateText = (iso: string, timeZone: string) => new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));

function statusText(found: SimilarResponse | null): string {
  if (!found) return "";
  const n = found.results.length;
  return n === 0 ? "No similar published releases found." : `Found ${n} similar published release${n === 1 ? "" : "s"}.`;
}

/**
 * "Similar published releases" (addendum §7): nothing runs until Find similar is pressed. NRMS
 * compares the release as last saved and returns up to 10 published posts, each labelled AI or
 * Text match. Hidden when NRMS has no News API to ask (`GET /config`'s similarAvailable).
 */
export function SimilarReleasesPanel({ view, timeZone }: { view: ReleaseView; timeZone: string }): React.JSX.Element | null {
  const headingId = useId();
  const noteId = useId();
  const [config, setConfig] = useState<SimilarConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<SimilarResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    apiFetch<SimilarConfig>("/nrms/api/config").then(
      (c) => {
        if (active) setConfig(c);
      },
      () => {
        if (active) setConfig({});
      },
    );
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    setFound(null);
    setError(null);
  }, [view.id]);

  if (!config?.similarAvailable) return null;
  const ai = config.staffAi === true;

  const find = async () => {
    setBusy(true);
    setError(null);
    setFound(null);
    try {
      setFound(await apiFetch<SimilarResponse>(`/nrms/api/releases/${view.id}/similar`, { method: "POST" }));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Couldn't look for similar releases — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="similar-releases" className="gcpe-release-editor__similar" aria-labelledby={headingId}>
      <h2 id={headingId}>Similar published releases</h2>
      <p className="gcpe-similar__hint">Compares the last saved version of this release with published posts.</p>
      <Button onPress={() => void find()} isDisabled={busy} aria-describedby={ai ? noteId : undefined}>
        Find similar
      </Button>
      {ai && (
        <p id={noteId} className="gcpe-similar__note">
          {AI_NOTE}
        </p>
      )}
      <div role="status">{busy ? "Looking for similar releases…" : statusText(found)}</div>
      {ai && found?.mode === "text" && <p>The AI service wasn&rsquo;t available, so these are text matches.</p>}
      {error && <InlineAlert variant="danger" role="alert" description={error} />}
      {found && found.results.length > 0 && (
        <ol className="gcpe-similar__results">
          {found.results.map((r) => (
            <li key={r.key}>
              <a href={r.url} target="_blank" rel="noreferrer">
                {r.headline || r.key}
                <span className="gcpe-visually-hidden"> (opens in a new tab)</span>
              </a>
              <span className="gcpe-similar__meta">
                {" "}
                {dateText(r.publishDate, timeZone)} · {r.leadMinistry ?? "No lead ministry"}
              </span>
              <span className={`gcpe-similar__match gcpe-similar__match--${r.match}`}>{r.match === "ai" ? "AI match" : "Text match"}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
```

Append to `apps/staff-web/src/styles/global.css`:

```css
/* "Similar published releases" (release editor) */
.gcpe-similar__results {
  padding-left: 1.5rem;
}
.gcpe-similar__results li {
  margin-bottom: 0.5rem;
}
.gcpe-similar__match {
  display: inline-block;
  margin-left: 0.5rem;
  padding: 0 0.375rem;
  border: 1px solid currentColor;
  border-radius: 4px;
  font-size: 0.875rem;
}
```

- [ ] **Step 4: Put it in the editor**

In `apps/staff-web/src/screens/release/ReleaseEditorPage.tsx`, import `SimilarReleasesPanel` from `./SimilarReleasesPanel`. Between `<FilesSection … />` and `<SideBar … />`, add:

```tsx
          {canEdit && <SimilarReleasesPanel view={view} timeZone={timeZone} />}
```

- [ ] **Step 5: Run the staff-web suite**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run --project staff-web`
Expected: PASS. If an existing `ReleaseEditorPage` test fails because its fetch stub refuses or counts the panel's extra `/nrms/api/config` call, change only that stub so it answers `/nrms/api/config` (any JSON without `similarAvailable` keeps the panel hidden). Don't change what those tests assert about the editor itself.

Then type-check the staff app: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p apps/staff-web/tsconfig.json`. Expected: no errors.

- [ ] **Step 6: Turn staff AI on for the E2E stack**

In `tests/e2e/global-setup.ts`, after the `calendarTenant` file is written:

```ts
  // Every app's tenant file for the suite: BC's, with staff AI on (addendum §7), so the
  // "Similar published releases" E2E runs AI matching with the stand-in provider. Semantic
  // search stays off, so the search specs see text mode as before.
  const staffAiTenantConfig = JSON.parse(await readFile(join(repoRoot, "config/tenants/bc.json"), "utf8")) as { features: { semanticSearch: boolean; staffAi: boolean } };
  staffAiTenantConfig.features = { semanticSearch: false, staffAi: true };
  const staffAiTenant = join(tenantDir, "bc-e2e-staff-ai.json");
  await writeFile(staffAiTenant, JSON.stringify(staffAiTenantConfig));
```

In the `env` object, after `CALENDAR_TENANT_CONFIG: calendarTenant,`:

```ts
    TENANT_CONFIG: staffAiTenant,
```

and after `NEWSAPI_DATABASE_URL: newsApi.url,`:

```ts
    NEWSAPI_EMBEDDINGS_PROVIDER: "stand-in",
```

- [ ] **Step 7: The E2E spec**

Create `tests/e2e/staff-similar.spec.ts`:

```ts
// Addendum §7 and §9: the staff panel works in AI mode with the stand-in provider (the suite's
// tenant has staffAi on), and the panel has no axe violations at all (6e exit).
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { EDITOR_EMAIL, TEST_USER_PASSWORDS } from "./constants";
import { baseUrl, createApprovedAndPublished, createPublishableRelease, loginForCookie, signInAs, tick } from "./playwright-support";

test("Find similar lists a matching published release as an AI match, and the panel has zero axe violations", async ({ page, context }) => {
  const cookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
  const word = `quokkaferry${Date.now().toString(36)}`;
  const headline = `Similar check ${word} ferry terminal upgrade`;
  const published = await createApprovedAndPublished(cookie, { headline });
  await tick(); // the News API's embedding worker runs on the stack tick
  const draft = await createPublishableRelease(cookie, { headline });

  await signInAs(context, "editor");
  await page.goto(`${baseUrl()}/hub/releases/${draft.id}`);
  const panel = page.getByRole("region", { name: "Similar published releases" });
  await expect(panel.getByText("Sends this draft's text to the AI service to compare.")).toBeVisible();
  await panel.getByRole("button", { name: "Find similar" }).click();

  const item = panel.getByRole("listitem").filter({ hasText: word });
  await expect(item).toContainText("AI match");
  await expect(item.getByRole("link")).toHaveAttribute("href", new RegExp(`/releases/${published.key}$`));

  const results = await new AxeBuilder({ page }).include("#similar-releases").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations).toEqual([]);
});
```

- [ ] **Step 8: Run the E2E specs that this touches**

Run: `npx -y -p node@24 -- node node_modules/@playwright/test/cli.js test tests/e2e/staff-similar.spec.ts tests/e2e/search.spec.ts tests/e2e/public-site.spec.ts tests/e2e/axe-sweep.spec.ts`
Expected: PASS.
- **No AI match:** if the item shows "Text match", the worker didn't embed the post before the click. Check `/stack/health` and the News API's start log for `staff AI is off: missing …` (pgvector or the provider). Don't weaken the assertion.
- **axe violations:** if axe reports any, fix the panel's markup or CSS, never the tags.

- [ ] **Step 9: Docs**

Running notes, under `## Phase 6d–6e — Staff help and the exit checks`:

```markdown
- **Editor** — The release editor has a "Similar published releases" panel. Press **Find similar** to see up to 10 published posts like this release, each with its date, lead ministry, a link to the public page (it opens in a new tab) and whether it's an *AI match* or a *Text match*. It compares the release as last saved, so save first. Nothing is sent until you press the button.
- **Editor** — While staff AI is on, the panel says "Sends this draft's text to the AI service to compare." If the AI service is unavailable, the panel says so and shows text matches instead.
- **Viewer** — The panel is for editors only; viewers don't see it.
```

- [ ] **Step 10: Commit**

```bash
git add apps/staff-web/src/screens/release/SimilarReleasesPanel.tsx apps/staff-web/src/screens/release/SimilarReleasesPanel.test.tsx apps/staff-web/src/screens/release/ReleaseEditorPage.tsx apps/staff-web/src/styles/global.css tests/e2e/staff-similar.spec.ts tests/e2e/global-setup.ts docs/manuals/running-notes.md
git add -u apps/staff-web/src/screens/release
git commit -m "staff-web: Similar published releases panel in the release editor (addendum §7)"
```

---

### Task 4: The exit scripts: the fixture site, axe and Lighthouse, and the search spot-check

**Review:** controller self-check (scripts, CI).

**Files:**
- Create: `scripts/fixture-site.ts`, `scripts/site-quality.ts`, `scripts/search-spot-check.ts`
- Test: `tests/fixture-site.test.ts`, `tests/search-spot-check.test.ts`
- Modify: root `package.json`, `package-lock.json`, `.github/workflows/ci.yml`
- Docs: `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`

**Interfaces:**
- Consumes:
  - `createSiteBuilder({ newsApi, storage, index, site, assetsDir })` and `buildAll({ test })`.
  - `fsStorage(dir)`, `PostIndex`, `IndexedPost`, `CategoryDto`, `PostDto`, `SiteInfo`.
  - `fakeNewsApi(posts)` and `post(over)` (`apps/public-site/test/`).
  - `createNewsTestDb()` (`apps/news-api/test/helpers.ts`), `applyRelease`, `runEmbeddingTick`, `createSearchService`, `createSemanticSearch`, `QueryVectorCache`.
  - `createEmbeddingProvider`, `embeddingsEnvSchema`, `standInProvider`, `createGuardedEmbedder`.
- Produces:
  - `buildFixtureSite(outDir, { baseUrl, test })`, `serveStatic(dir)` and `FIXTURE_PAGES`.
  - `npm run site:quality`.
  - `runSpotCheck({ provider?, log? })`, `SPOT_CORPUS`, `SPOT_QUERIES` and `npm run search:spot-check`.

- [ ] **Step 1: Add the dependencies**

Run: `npx -y -p node@24 -- npm install --ignore-scripts --save-dev --save-exact lighthouse@13.5.0 chrome-launcher@^1.2.1`
Then make sure root `package.json` lists both with exact versions (`"lighthouse": "13.5.0"`, `"chrome-launcher": "1.x.y"` as resolved), and add to `"scripts"`:

```json
    "site:quality": "tsx scripts/site-quality.ts",
    "search:spot-check": "tsx scripts/search-spot-check.ts",
```

- [ ] **Step 2: Write the failing tests**

Create `tests/fixture-site.test.ts`:

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFixtureSite, FIXTURE_PAGES, serveStatic } from "../scripts/fixture-site";

const fileOf = (path: string) => (path.endsWith("/") ? `${path}index.html` : path).replace(/^\//, "");

describe("the fixture site (6e exit checks)", () => {
  it.each([false, true])("builds every page type with the real builder (test site: %s)", async (test) => {
    const dir = await mkdtemp(join(tmpdir(), "fixture-site-"));
    try {
      await buildFixtureSite(dir, { baseUrl: "http://127.0.0.1:1", test });
      for (const path of FIXTURE_PAGES) {
        const html = await readFile(join(dir, fileOf(path)), "utf8");
        expect(html, path).toContain("<main");
        expect(html.includes('content="noindex, nofollow"'), path).toBe(test);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serves directory pages, files and a 404", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fixture-site-"));
    const server = await serveStatic(dir);
    try {
      await buildFixtureSite(dir, { baseUrl: server.url, test: false });
      expect((await fetch(`${server.url}/ministries/`)).status).toBe(200);
      expect((await fetch(`${server.url}/assets/theme.css`)).headers.get("content-type")).toBe("text/css; charset=utf-8");
      expect((await fetch(`${server.url}/no/such/page/`)).status).toBe(404);
      expect((await fetch(`${server.url}/..%2f..%2fetc/passwd`)).status).toBe(404);
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

Create `tests/search-spot-check.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runSpotCheck, SPOT_QUERIES } from "../scripts/search-spot-check";

describe("search spot-check (spec §9 exit)", () => {
  it("text mode puts every expected key in the top 5; the stand-in run says it proves only the plumbing", async () => {
    const lines: string[] = [];
    const r = await runSpotCheck({ log: (l) => lines.push(l) });
    expect(SPOT_QUERIES.length).toBeGreaterThanOrEqual(20);
    expect(r.textHits).toBe(SPOT_QUERIES.length);
    expect(r.semanticReached).toBe(true);
    expect(r.ok).toBe(true);
    expect(lines.join("\n")).toMatch(/stand-in provider proves only the plumbing/i);
    expect(lines.join("\n")).toContain("Q70");
  }, 60_000);
});
```

- [ ] **Step 3: Run them and see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run tests/fixture-site.test.ts tests/search-spot-check.test.ts`
Expected: FAIL. Neither script exists.

- [ ] **Step 4: The fixture site**

Create `scripts/fixture-site.ts`:

```ts
/**
 * A fictional site for the Phase 6 exit checks (spec §9): every page type, built by the public
 * site's real builder from in-memory posts, with BC's theme and no database (an in-memory post
 * index). Used by scripts/site-quality.ts (axe and Lighthouse) and tests/fixture-site.test.ts.
 */
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTenantConfig } from "@gcpe/config";
import { createSiteBuilder } from "../apps/public-site/src/builder";
import type { CategoryDto, PostDto } from "../apps/public-site/src/dto";
import type { NewsApiClient } from "../apps/public-site/src/news-api-client";
import type { IndexedPost, PostIndex } from "../apps/public-site/src/post-index";
import type { SiteInfo } from "../apps/public-site/src/render";
import { fsStorage } from "../apps/public-site/src/storage";
import { fakeNewsApi } from "../apps/public-site/test/fake-news-api";
import { post } from "../apps/public-site/test/fixtures";

const BC_TENANT = fileURLToPath(new URL("../config/tenants/bc.json", import.meta.url));

const CATEGORIES: CategoryDto[] = [
  { key: "economy", kind: "sectors", name: "Economy", isActive: true, topPostKey: null, featurePostKey: null },
  { key: "housing", kind: "themes", name: "Housing", isActive: true, topPostKey: null, featurePostKey: null },
  { key: "covid-19", kind: "tags", name: "COVID-19", isActive: true, topPostKey: null, featurePostKey: null },
];

const FIRST_KEY = "2026HLTH0001-000001";

/** One URL per page type (spec §6.1). Sector, theme and tag pages share a template; all three are checked. */
export const FIXTURE_PAGES = [
  "/",
  `/releases/${FIRST_KEY}/`,
  "/ministries/",
  "/ministries/health/",
  "/sectors/economy/",
  "/themes/housing/",
  "/tags/covid-19/",
  "/archive/",
  "/archive/2026/10/",
  "/search/",
  "/404.html",
];

function memoryIndex(): PostIndex {
  const rows = new Map<string, IndexedPost>();
  const newest = (a: IndexedPost, b: IndexedPost) => b.publishDate.localeCompare(a.publishDate) || (a.key < b.key ? 1 : -1);
  return {
    get: async (k) => rows.get(k) ?? null,
    put: async (p) => void rows.set(p.key, p),
    remove: async (k) => void rows.delete(k),
    inMonth: async (m) => [...rows.values()].filter((p) => p.month === m).sort(newest),
    months: async () => {
      const counts = new Map<string, number>();
      for (const p of rows.values()) counts.set(p.month, (counts.get(p.month) ?? 0) + 1);
      return [...counts].map(([month, count]) => ({ month, count })).sort((a, b) => b.month.localeCompare(a.month));
    },
    keys: async () => [...rows.keys()],
    categories: async () => [...new Set([...rows.values()].flatMap((p) => p.categories))].sort(),
    inCategory: async (token) => [...rows.values()].filter((p) => p.categories.includes(token)).map((p) => p.key).sort(),
  };
}

/** 24 fictional releases over two months, two ministries, one sector, theme and tag. */
export async function buildFixtureSite(outDir: string, o: { baseUrl: string; test: boolean }): Promise<void> {
  const posts = new Map<string, PostDto>();
  for (let i = 1; i <= 24; i++) {
    const key = `2026HLTH${String(i).padStart(4, "0")}-${String(i).padStart(6, "0")}`;
    const ministry = i % 2 ? "health" : "finance";
    const day = String(((i - 1) % 28) + 1).padStart(2, "0");
    posts.set(
      key,
      post({ key, publishDate: `2026-${i <= 12 ? "10" : "09"}-${day}T10:00:00-07:00`, ministryKeys: [ministry], leadMinistryKey: ministry, sectorKeys: ["economy"], themeKeys: ["housing"], tagKeys: ["covid-19"] }),
    );
  }
  const newsApi: NewsApiClient = {
    ...fakeNewsApi(posts),
    categories: async (kind) => CATEGORIES.filter((c) => c.kind === kind),
    category: async (kind, key) => CATEGORIES.find((c) => c.kind === kind && c.key === key) ?? null,
  };
  const tenant = loadTenantConfig(BC_TENANT);
  const site: SiteInfo = { name: tenant.siteName, baseUrl: o.baseUrl, theme: tenant.site.theme, logo: null };
  const builder = createSiteBuilder({ newsApi, storage: fsStorage(outDir), index: memoryIndex(), site, assetsDir: null });
  const result = await builder.buildAll({ test: o.test });
  if (result.failures > 0) throw new Error(`fixture site: ${result.failures} page(s) failed to build`);
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** A static server for the built site: "/x/" serves "x/index.html", a missing file 404.html. */
export async function serveStatic(dir: string): Promise<{ url: string; close(): Promise<void> }> {
  const root = resolve(dir);
  const server = createServer(async (req, res) => {
    let file = resolve(root, `.${decodeURIComponent(new URL(req.url ?? "/", "http://fixture.invalid").pathname)}`);
    try {
      if (relative(root, file).startsWith("..")) throw new Error("outside");
      if ((await stat(file)).isDirectory()) file = join(file, "index.html");
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": TYPES[".html"]! });
      res.end(await readFile(join(root, "404.html")).catch(() => ""));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
```

**Verified while planning:** this builder setup (with `fakeNewsApi` overridden as above) builds all 11 pages, and every one returns 200 from this server. If `NewsApiClient`'s `categories`/`category` parameter types reject the arrow functions above, annotate them as `(kind: Exclude<CategoryKind, "ministries">)` from `../apps/public-site/src/news-api-client`'s own imports. Don't widen the interface.

- [ ] **Step 5: Axe and Lighthouse**

Create `scripts/site-quality.ts`:

```ts
/**
 * Phase 6 exit (spec §9): axe-core and Lighthouse on every public page type of a fictional,
 * production-config fixture site (scripts/fixture-site.ts). Exits 1 on any axe violation or any
 * score below its threshold. Needs Playwright's Chromium (`npx playwright install chromium`).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "@playwright/test";
import * as chromeLauncher from "chrome-launcher";
import lighthouse from "lighthouse";
import { buildFixtureSite, FIXTURE_PAGES, serveStatic } from "./fixture-site";

export const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
/** Spec §9: SEO counts here because this is a production-config build (indexable). */
export const THRESHOLDS: Record<string, number> = { performance: 90, accessibility: 95, "best-practices": 90, seo: 90 };

export async function runSiteQuality(log: (line: string) => void = console.log): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "gcpe-site-quality-"));
  const server = await serveStatic(dir);
  const failures: string[] = [];
  try {
    await buildFixtureSite(dir, { baseUrl: server.url, test: false });
    log(`Fixture site (production config, fictional content) at ${server.url}`);

    const browser = await chromium.launch();
    try {
      const page = await (await browser.newContext()).newPage();
      for (const path of FIXTURE_PAGES) {
        const res = await page.goto(server.url + path);
        if (res?.status() !== 200) failures.push(`${path}: HTTP ${res?.status()}`);
        const { violations } = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
        log(`axe ${path}: ${violations.length === 0 ? "0 violations" : violations.map((v) => `${v.id} (${v.impact}, ${v.nodes.length} node(s))`).join(", ")}`);
        if (violations.length > 0) failures.push(`${path}: ${violations.length} axe violation(s)`);
      }
    } finally {
      await browser.close();
    }

    const chrome = await chromeLauncher.launch({ chromePath: chromium.executablePath(), chromeFlags: ["--headless=new", "--no-sandbox"] });
    try {
      for (const path of FIXTURE_PAGES) {
        const result = await lighthouse(server.url + path, { port: chrome.port, output: "json", logLevel: "error", onlyCategories: Object.keys(THRESHOLDS) });
        if (!result) {
          failures.push(`${path}: Lighthouse returned no result`);
          continue;
        }
        const scores = Object.fromEntries(Object.keys(THRESHOLDS).map((id) => [id, Math.round((result.lhr.categories[id]?.score ?? 0) * 100)]));
        log(`lighthouse ${path}: ${Object.entries(scores).map(([id, s]) => `${id} ${s}`).join(", ")}`);
        for (const [id, min] of Object.entries(THRESHOLDS)) if ((scores[id] ?? 0) < min) failures.push(`${path}: ${id} ${scores[id]} < ${min}`);
      }
    } finally {
      chrome.kill();
    }
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
  return failures;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runSiteQuality().then(
    (failures) => {
      if (failures.length === 0) return void console.log("site quality: every page passed axe and Lighthouse");
      console.error(`site quality: ${failures.length} failure(s)\n${failures.map((f) => `- ${f}`).join("\n")}`);
      process.exitCode = 1;
    },
    (e: unknown) => {
      console.error("site quality: failed to run", e);
      process.exitCode = 1;
    },
  );
}
```

- [ ] **Step 6: The search spot-check**

Create `scripts/search-spot-check.ts`:

```ts
/**
 * Phase 6 exit (spec §9): about 20 query → expected-key pairs over a fictional corpus, top 5
 * hits in text and semantic mode, in a throwaway database (TEST_DATABASE_ADMIN_URL). Text mode
 * must find every expected key (Postgres full-text relevance is real). The semantic column
 * means something only with a real provider: with the stand-in it proves the plumbing only, and
 * the relevance check proper waits for Azure (Q70). EMBEDDINGS_PROVIDER=azure-openai (plus the
 * Azure settings) runs the same check against Azure.
 */
import { pathToFileURL } from "node:url";
import { createEmbeddingProvider, createGuardedEmbedder, embeddingsEnvSchema, standInProvider, type EmbeddingProvider } from "@gcpe/embeddings";
import type { ReleaseRecord } from "@gcpe/events";
import { sampleRelease } from "@gcpe/events/testing";
import { createNewsTestDb } from "../apps/news-api/test/helpers";
import { runEmbeddingTick } from "../apps/news-api/src/embeddings/worker";
import { applyRelease } from "../apps/news-api/src/projections";
import { createSemanticSearch } from "../apps/news-api/src/search/semantic";
import { createSearchService } from "../apps/news-api/src/search/service";
import { QueryVectorCache } from "../apps/news-api/src/search/vector-cache";

/** Fictional releases: [key, headline, body]. */
export const SPOT_CORPUS: [string, string, string][] = [
  ["SPOT-01", "Wildfire crews contain blaze near Lytton Creek", "Firefighters contained the wildfire after three days, and evacuation orders were lifted."],
  ["SPOT-02", "New ferry terminal opens at Horseshoe Bay", "The terminal adds two berths and a covered walkway for foot passengers."],
  ["SPOT-03", "Salmon habitat restoration funding announced", "Grants will restore spawning streams along the Fraser River."],
  ["SPOT-04", "Rural clinics extend weekend hours", "Patients in small communities can see a nurse practitioner on Saturdays."],
  ["SPOT-05", "Province expands school breakfast program", "Students in 200 more schools will get a free breakfast every morning."],
  ["SPOT-06", "Highway 99 rockfall repairs complete", "Crews stabilized the slope and reopened both lanes."],
  ["SPOT-07", "Tenant protections strengthened for renters", "Landlords must give more notice before ending a tenancy."],
  ["SPOT-08", "Child care fees reduced for families", "Parents will pay less for licensed child care spaces from January."],
  ["SPOT-09", "Drought response plan for farmers", "Water restrictions come with irrigation support for ranchers and growers."],
  ["SPOT-10", "Transit pass for seniors extended", "Seniors can ride buses for free during off-peak hours."],
  ["SPOT-11", "Heat warning issued for the Interior", "Cooling centres open as temperatures reach 40 degrees."],
  ["SPOT-12", "Apprenticeship grants for skilled trades", "Electricians and welders can apply for training grants."],
  ["SPOT-13", "Caribou recovery partnership signed", "First Nations and the province will protect caribou herds together."],
  ["SPOT-14", "Flood mitigation work begins in Abbotsford", "New dikes and pump stations will protect farmland."],
  ["SPOT-15", "Mental health supports for students", "Counsellors will be available at every post-secondary campus."],
  ["SPOT-16", "Electric vehicle rebates increased", "Drivers buying an electric car can get a larger rebate."],
  ["SPOT-17", "Forest deferrals extended", "Logging stays paused in ancient forest stands."],
  ["SPOT-18", "Minimum wage rises on June 1", "Workers earning the minimum wage will get a raise."],
  ["SPOT-19", "Wildlife crossing built over Highway 3", "An overpass will help elk and bighorn sheep cross safely."],
  ["SPOT-20", "Housing project for Indigenous elders", "The building has 40 affordable homes near the friendship centre."],
];

/** [query, expected key]: every query's words appear in its expected release. */
export const SPOT_QUERIES: [string, string][] = [
  ["wildfire evacuation", "SPOT-01"],
  ["ferry terminal", "SPOT-02"],
  ["salmon spawning", "SPOT-03"],
  ["nurse practitioner", "SPOT-04"],
  ["school breakfast", "SPOT-05"],
  ["rockfall", "SPOT-06"],
  ["renters landlords", "SPOT-07"],
  ["child care fees", "SPOT-08"],
  ["drought irrigation", "SPOT-09"],
  ["seniors transit", "SPOT-10"],
  ["cooling centres", "SPOT-11"],
  ["apprenticeship welders", "SPOT-12"],
  ["caribou herds", "SPOT-13"],
  ["dikes pump", "SPOT-14"],
  ["counsellors campus", "SPOT-15"],
  ["electric rebate", "SPOT-16"],
  ["ancient forest", "SPOT-17"],
  ["minimum wage", "SPOT-18"],
  ["elk overpass", "SPOT-19"],
  ["affordable homes elders", "SPOT-20"],
];

const release = ([key, headline, body]: [string, string, string], i: number): ReleaseRecord => ({
  ...sampleRelease,
  key,
  reference: null,
  summary: null,
  keywords: null,
  location: null,
  publishDate: `2026-09-${String(i + 1).padStart(2, "0")}T10:00:00-07:00`,
  leadMinistryKey: "health",
  ministryKeys: ["health"],
  sectorKeys: [],
  documents: [{ ...sampleRelease.documents[0]!, headline, subheadline: "", detailsHtml: `<p>${body}</p>` }],
});

export interface SpotCheckResult {
  providerId: string;
  textHits: number;
  semanticHits: number;
  semanticReached: boolean;
  ok: boolean;
}

export async function runSpotCheck(o: { provider?: EmbeddingProvider | null; log?: (line: string) => void } = {}): Promise<SpotCheckResult> {
  const log = o.log ?? console.log;
  const provider = o.provider ?? createEmbeddingProvider(embeddingsEnvSchema.parse(process.env)) ?? standInProvider();
  const threshold = Number(process.env.SEARCH_SEMANTIC_THRESHOLD ?? 0.6);
  const tdb = await createNewsTestDb();
  try {
    for (const [i, r] of SPOT_CORPUS.entries()) await tdb.db.transaction((tx) => applyRelease(tx, release(r, i), { notify: false }));
    const embedder = createGuardedEmbedder({ provider });
    while ((await runEmbeddingTick({ db: tdb.db, embedder })).embedded > 0);
    const common = { db: tdb.db, timeZone: "America/Vancouver", language: "english" as const, defaultLanguageId: 4105, publicSiteUrl: "https://news.example.test" };
    const text = createSearchService(common);
    const semantic = createSearchService({
      ...common,
      semantic: createSemanticSearch({ db: tdb.db, embedder, cache: new QueryVectorCache(), language: "english", defaultLanguageId: 4105, threshold }),
    });

    log(`Search spot-check: ${SPOT_QUERIES.length} queries over ${SPOT_CORPUS.length} fictional releases. Provider: ${provider.id}.`);
    if (provider.id === "stand-in") {
      log("NOTE: the stand-in provider proves only the plumbing (embed, store, query, order); its semantic ranks say nothing about relevance. The relevance check proper waits for an Azure OpenAI deployment (Q70).");
    }
    let textHits = 0;
    let semanticHits = 0;
    let semanticReached = false;
    for (const [q, expected] of SPOT_QUERIES) {
      const t = (await text.search({ q, page: 1 })).results.slice(0, 5).map((r) => r.key);
      const sRes = await semantic.search({ q, page: 1 });
      const s = sRes.results.slice(0, 5).map((r) => r.key);
      if (sRes.mode === "semantic") semanticReached = true;
      const tRank = t.indexOf(expected) + 1;
      const sRank = s.indexOf(expected) + 1;
      if (tRank > 0) textHits++;
      if (sRank > 0) semanticHits++;
      log(`${tRank > 0 ? "ok  " : "MISS"} "${q}" → ${expected}: text #${tRank || "-"} [${t.join(", ")}]; ${sRes.mode} #${sRank || "-"} [${s.join(", ")}]`);
    }
    const ok = textHits === SPOT_QUERIES.length && semanticReached;
    log(`Text mode: ${textHits}/${SPOT_QUERIES.length} in the top 5. Semantic mode (${provider.id}): ${semanticHits}/${SPOT_QUERIES.length} in the top 5${provider.id === "stand-in" ? " (plumbing only, Q70)" : ""}.`);
    if (!semanticReached) log("FAIL: the semantic branch never answered (provider, pgvector or the vector query).");
    return { providerId: provider.id, textHits, semanticHits, semanticReached, ok };
  } finally {
    await tdb.drop();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runSpotCheck().then(
    (r) => {
      if (!r.ok) process.exitCode = 1;
    },
    (e: unknown) => {
      console.error("search spot-check: failed to run", e);
      process.exitCode = 1;
    },
  );
}
```

If one text-mode query misses (a stemming surprise), change that *query* to words that really appear in its release, and record the change in the commit message. Never change `SPOT_CORPUS` to fit a query, and never relax the pass rule.

- [ ] **Step 7: Run the tests and the scripts**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run tests/fixture-site.test.ts tests/search-spot-check.test.ts`
Expected: PASS.

Run: `npx -y -p node@24 -- npm run site:quality`
Expected: one `axe … 0 violations` line and one `lighthouse …` line per page, ending with "every page passed". The planning dry-run scored performance 100, accessibility 100, best practices 96–100 and SEO 92–100. Copy the printed lines into the exit note (Task 5).

Run: `npx -y -p node@24 -- npm run search:spot-check`
Expected: the stand-in NOTE line, 20 result lines, and "Text mode: 20/20 in the top 5". Copy the summary lines into the exit note.

Run: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: no errors.

- [ ] **Step 8: CI job**

In `.github/workflows/ci.yml`, add a second job under `jobs:` (same indentation as `test:`):

```yaml
  # Phase 6 exit (spec §9): axe and Lighthouse on a fictional fixture site. Separate from `test`
  # so a browser problem never hides unit-test results; not a required check until it has run
  # green here (Q87).
  site-quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run site:quality
```

- [ ] **Step 9: Docs**

Running notes, under `## Phase 6d–6e — Staff help and the exit checks`:

```markdown
- **Developer** — `npm run site:quality` builds a fictional, production-config copy of the public site and runs axe (zero violations allowed) and Lighthouse (accessibility ≥ 95, performance, best practices and SEO ≥ 90) on every page type. It needs Playwright's Chromium (`npx playwright install chromium`). CI runs it as the `site-quality` job.
- **Developer** — `npm run search:spot-check` runs 20 searches over a fictional corpus in a throwaway database and lists the top 5 for each. Text mode must find every expected post. With the stand-in provider the semantic column proves only that the plumbing works; set `EMBEDDINGS_PROVIDER=azure-openai` and the Azure settings to check real relevance once Azure is available (Q70).
```

Runbook, in `## Staff help and the exit checks (Phases 6d–6e)`, after the flags subsection:

```markdown
### Exit checks: site quality and the search spot-check

Both run on a developer machine (or in CI), never against boxs.ca. `npm run site:quality` needs Playwright's Chromium; `npm run search:spot-check` needs the local Postgres (`TEST_DATABASE_ADMIN_URL`) with pgvector, and creates and drops its own database. Once Azure is configured (Q70), run the spot-check with `EMBEDDINGS_PROVIDER=azure-openai`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY` and `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` set: that's the relevance check the Phase 6 exit is waiting for.
```

- [ ] **Step 10: Commit**

```bash
git add scripts/fixture-site.ts scripts/site-quality.ts scripts/search-spot-check.ts tests/fixture-site.test.ts tests/search-spot-check.test.ts package.json package-lock.json .github/workflows/ci.yml docs/manuals/running-notes.md docs/deploy/siteground.md
git commit -m "exit checks: axe and Lighthouse on a fixture site, search spot-check, CI site-quality job (spec §9)"
```

---

### Task 5: Phase 6 exit note and parity, and the final run

**Review:** controller self-check (docs), then the final whole-branch review.

**Files:**
- Create: `docs/superpowers/plans/phase-6-exit.md`
- Modify: `docs/parity/open-questions.md`

**Interfaces:**
- Consumes: the printed output of Task 4's two scripts and Task 3's E2E run.
- Produces: Q86–Q88; the exit note.

- [ ] **Step 1: Add the open questions**

Append to the open-questions table in `docs/parity/open-questions.md` (after Q85, same column layout: number, question, why it matters, working assumption, date):

```markdown
| Q86 | Should "Find similar" compare the release's unsaved edits too, not just the last saved version? | Staff may press it before saving; NRMS builds the text from the saved release so no draft text travels from the browser by a new path. | Last saved version only; the panel says so. | 2026-10-11 |
| Q87 | Should the `site-quality` CI job (axe and Lighthouse on the fixture site) become a required check? | It was verified locally but couldn't be run on GitHub's runners while being built; a flaky browser job as a required check would block merges. | Optional until it has run green on GitHub a few times; then Paul makes it required. | 2026-10-11 |
| Q88 | With `staffAi` on and `semanticSearch` off, the News API embeds every published post through the provider so AI matching has vectors. Is that covered by Q71's "published content needs no PIA"? | Turning on staff AI then also sends published releases to the AI service, not just drafts on a click. | Yes: published content is public; the PIA gate is for drafts. | 2026-10-11 |
```

Run both duplicate checks from the Global Constraints. Expected: no output.

- [ ] **Step 2: Write the exit note**

Create `docs/superpowers/plans/phase-6-exit.md`. Fill the bracketed score lines from the actual output of Task 4, Step 7 and Task 3, Step 8. Copy them verbatim; don't round or summarise.

```markdown
# Phase 6 exit (spec addendum §9, §10)

Recorded at the end of 6e on `feat/phase-6de`. Each check names the command that ran it.

| Exit check | Result | How |
|---|---|---|
| axe-core, every public page type (home, release, ministries, ministry, sector, theme, tag, archive index, monthly archive, search, 404) | Passed: zero violations (WCAG 2.0–2.2 A/AA and best-practice tags) | `npm run site:quality` on the fictional fixture site |
| axe-core, the staff release editor's "Similar published releases" panel | Passed: zero violations | `tests/e2e/staff-similar.spec.ts` |
| Lighthouse (production-config fixture build): accessibility ≥ 95, performance ≥ 90, best practices ≥ 90, SEO ≥ 90 | Passed locally; scores below | `npm run site:quality`; CI job `site-quality` (not yet a required check, Q87) |
| Search spot-check, text mode (20 queries, top 5) | Passed: 20/20 | `npm run search:spot-check` |
| Search spot-check, semantic relevance | **Waits on Q70** (Azure OpenAI). With the stand-in provider the run proves only the plumbing: embedding, storage, the vector query and the two-group order. | the same script with `EMBEDDINGS_PROVIDER=azure-openai` |
| Semantic search on a shared test environment | **Waits on Q80**: boxs.ca's Postgres has no pgvector, so it always answers in text mode. Semantic mode is verified locally and in CI only. | `/stack/health` → `newsApiSearch` |
| Staff-AI flag enforcement (News API flag off → zero provider calls for `mode: "ai"`, NRMS flag on) | Passed | `apps/news-api/src/search/similar-flag.test.ts` |
| Staff AI in production | **Off until the PIA approves it (Q71)**. The runbook's "Turning the flags on, and the PIA gate for staff AI" is the procedure. | — |

## Lighthouse scores (fixture site)

[paste the `lighthouse …` lines from `npm run site:quality`]

## Search spot-check summary

[paste the two summary lines and the stand-in NOTE line from `npm run search:spot-check`]

## Open questions this phase leaves

Q70 (Azure), Q71 (PIA), Q80 (pgvector test environment), Q86 (saved vs unsaved draft), Q87 (CI check), Q88 (embedding published posts under staff AI).
```

The two bracketed lines are instructions for this step, not text to leave in. Replace each with the pasted output in a fenced block.

- [ ] **Step 3: The final run**

Run each of these and confirm the expected result before committing:
- `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run`: the whole suite PASS (v1 compatibility suites included, unedited).
- `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json` and `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p apps/staff-web/tsconfig.json`: no errors.
- `git diff ed22717 --stat -- apps/news-api/src/http/v1 apps/news-api/test/compat.test.ts apps/news-api/test/e2e-core.test.ts apps/news-api/src/app.test.ts`: empty.
- `git grep -nE "Task [0-9]|ruling [0-9]|fix round" -- apps packages scripts tests ':!*.md'`: no line added on this branch. Compare with `git diff ed22717 -U0 | grep -E "^\+.*(Task [0-9]|ruling [0-9]|fix round)"`, which must print nothing.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/phase-6-exit.md docs/parity/open-questions.md
git commit -m "docs: Phase 6 exit note and Q86-Q88"
```

---

## Deploy (after the final review)

Deploy to boxs.ca with `npm run deploy:siteground`, as earlier phases did. boxs.ca has no pgvector and its tenant config keeps both flags off, so the panel appears and works in text mode. Hand-check on boxs.ca:
1. Open a draft as an editor and press **Find similar**: up to 10 *Text match* results, each linking to the public page.
2. The panel doesn't show the AI sentence.
3. A viewer doesn't see the panel.
4. `/stack/health` still says `"newsApiSearch": "text"`.
