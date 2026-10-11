# Phase 6b: Semantic Search, Related Posts and the Change Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the News API an optional pgvector layer (`post_embeddings`, an HNSW index created only where the role may), an embedding worker on `/stack/tick` that keeps published posts embedded and their related posts computed, semantic mode for `GET /api/v2/search` with a text fallback, `GET /api/v2/posts/{key}/related`, and a service-token `GET /api/v2/changes` feed written in the same transaction as every projection write. Every migration must still run where pgvector can't be enabled (SiteGround), and News API v1 must not change.

**Architecture:**
- **pgvector is detected, never required.** `0004_semantic_tables` (drizzle-kit) adds `post_embeddings` (`embedding real[]`), `post_related`, `changes`, `change_feed_state` and `posts.embedding_text_hash`. `0005_pgvector_optional` (drizzle-kit `--custom`) is one `DO` block: it tries `CREATE EXTENSION vector` and the HNSW expression index, and skips both on `insufficient_privilege` or `undefined_file`. At startup `resolveSearchMode` combines the tenant flag, the provider and `pg_extension`; the result is fixed for the process and reported as `/stack/health`'s `newsApiSearch`.
- **The change feed is written by the projection.** `recordChanges(tx, …)` is called from every projection write (`applyRelease`, `unpublishRelease`, `applyOrg`, `applyTerm`, `deactivateCategory`, `applySiteContent`) and from the legacy importer's unpublish step. It takes one transaction-scoped advisory lock first, so change ids become visible in id order and a reader's cursor can never skip a row that commits late. Pruning records `pruned_through`; a cursor below it gets `410 { resync: true, next }`.
- **The worker keeps `post_embeddings ⊆ published posts`.** It selects up to 50 published posts whose `embedding_text_hash` differs from their embedding (or whose provider, model or dimensions differ), embeds them in one call, and writes only rows still published with unchanged text, under a row lock. Unpublishing deletes a post's `post_embeddings` and `post_related` rows in its own transaction. Related posts are the 5 nearest embeddings (HNSW-served).
- **Semantic search is an exact scan, composed with text.** The query is normalised, embedded once (5-minute, 5,000-entry cache) and compared with every filtered post's vector in a materialised CTE (no index, so filters and the threshold are exact). Up to 1,000 vector keys (50 pages × 20) come first, nearest first; text matches not among them follow. Count and page run in one read-only repeatable-read transaction. Any embed failure, an open breaker or an empty normalised query falls back to text without a log line; only a genuine provider failure is logged, once, by the guarded embedder.

**Tech Stack:** Node 24, TypeScript 5.9, Express 5, Drizzle 0.45 / drizzle-kit 0.31 on Postgres (14.17 locally, `pgvector/pgvector:pg16` in CI; pgvector 0.8.0 locally), express-rate-limit 8, zod 3.25, Vitest 4.1, supertest.

**Spec:** `docs/superpowers/specs/2026-10-11-public-site-ai-design.md` (the Phase 6 addendum), §10's 6b row:
- §5.2 (the `post_embeddings` table and the worker);
- §5.3 (pgvector optional: no `vector` column, the custom `DO`-block migration, the startup check, `/stack/health`'s `newsApiSearch`);
- §5.4: semantic mode for `/api/v2/search` (vector first above the threshold, then text; the query-vector cache; the fallback), `GET /api/v2/posts/{key}/related` with `post_related` and its text fallback, and `GET /api/v2/changes` (table, same-transaction writes, 90-day pruning, `410` resync, service token);
- §8 (error handling and the runbook lines for enabling pgvector and turning the flag on);
- §9's 6b lines: semantic-plus-text ordering with the stand-in, related posts and their fallback, change-feed order, pruning and `410`, unpublishing removes embeddings and related posts, and the migrations with and without pgvector.

**Carried forward from 6a's final review** (`.superpowers/sdd/2026-10-11-phase-6a-search-foundations/final-review.md` in the 6a worktree): M2 (log flood while the breaker is open), M5 (count and rows from two statements), the AbortSignal seam (already wired from the request's `close` to `SearchService.search` and `SemanticSearch.search`), and Q74 (rate limiting). Rulings 10–12 below.

**Not in 6b:** the public site pages, the rebuild queue and the change-feed consumer (6c); `POST /api/v2/internal/similar` and the staff panel (6d); the exit checks (6e).

---

## Decisions made in planning

Each ruling was made against the code at `a216006`. Spec conflicts are marked. The dry runs named here were run on local Postgres 14.17 with pgvector 0.8.0, in scratch databases that were dropped afterwards.

1. **Spec conflict, §5.2 source text.** The spec says "headline, summary and keywords, then the body, capped at 8,000 characters". The embedding source text is **the first 8,000 code points of `posts.search_text`** (6a's text: headlines, summary, keywords, location, subheadlines, bodies). One text builder instead of two, and subheadlines were already ruled part of the visible release in 6a.
   - `text_hash` is the SHA-256 (hex) of that source text. It is also stored on the post as `posts.embedding_text_hash`, written by `applyRelease` and by the search backfill, so the worker can find changed posts with a plain comparison instead of hashing every post each tick.
   - A generated column can't do it: `convert_to` is `STABLE` and `text::bytea` parses backslash escapes (both verified: "generation expression is not immutable" and "invalid input syntax for type bytea").
   - Posts written before 6b have a `NULL` hash. The worker treats them as candidates, computes the hash, and only calls the provider when the embedding is missing or differs.
2. **Spec conflict, §5.2 "only works when the semantic-search flag is on and a provider is configured".** The worker also needs pgvector, because it computes related posts with `<=>`. It runs only when `resolveSearchMode` says `semantic` (flag, provider, pgvector, and 1,536 dimensions). Otherwise its tick is a no-op.
3. **Semantic search scans exactly; the HNSW index serves related posts.**
   - With default `hnsw.ef_search` (40) an index-ordered `LIMIT 1000` returns at most about 40 rows, and post-filtering by ministry, sector, type and dates drops more. Search results would then depend on the plan the planner happened to pick.
   - So the vector branch computes distances in a `MATERIALIZED` CTE over the filtered posts (no `ORDER BY` inside it, so the index can't be chosen), then keeps distance ≤ threshold, nearest first, at most 1,000 keys. 1,000 is the deepest result a visitor can reach (`SEARCH_MAX_PAGE` 50 × 20).
   - *Measured* on 20,000 random 1,536-dimension vectors: the exact scan took 120–170 ms; the index-served "5 nearest excluding itself" query took about 2 ms warm (21 ms cold). *Inferred* (linear): about 0.6–0.8 s per uncached semantic query at 100,000 posts. Q79 asks whether that is acceptable.
   - Media Hub's hybrid query (`server/storage.ts:1527-1570`) also scans exactly; its pattern is copied, not its code.
4. **Two guarded embedders.** Search uses `EMBEDDINGS_TIMEOUT_MS` (default 1 s). The worker uses its own provider instance at 5,000 ms (§4's ceiling) and its own `CircuitBreaker`. A slow 50-post batch therefore never pushes visitors into text mode, and an Azure outage still trips each breaker after three failures. §5.2's "stops for the tick when the breaker is open" refers to the worker's breaker.
5. **The search mode is fixed at startup.** `pg_extension` is read once. A DBA who enables pgvector later restarts the News API (SiteGround restarts it on its own after 30–60 s idle). `/stack/health`'s `newsApiSearch` reports this startup mode; an open breaker doesn't change it, because each search response already says `mode`.
6. **`semantic` also needs a 1,536-dimension provider.** The index expression is `embedding::vector(1536)`: once the index exists, inserting any other length fails ("expected 1536 dimensions, not 3", verified). Both real providers are 1,536; a stand-in built with other dimensions resolves to `text`.
7. **Change feed details** (spec §5.4 leaves them open):
   - `key` is nullable: `home`, `slides` and `resource_links` rows carry `null`. `post.*` rows carry the post's stored key; category rows the category's stored key.
   - A `categoryFeatures` write (a category's top or feature post) records that category's kind (`ministry`, `sector`, `theme` or `tag`). `applyOrg` records `ministry` for the same keys it notifies (the ministry and its old and new parents).
   - **Ordering:** `recordChanges` first takes `pg_advisory_xact_lock(0x67637065, 4)`. Without it, a transaction that took id 10 and commits after the one that took id 11 would be skipped by a reader whose cursor already passed 11. With it, ids commit in order. The lock is always the last one a projection transaction takes, so it can't deadlock against `lockIdentity`.
   - **`410`:** `change_feed_state.pruned_through` holds the highest id ever pruned. `after < pruned_through` (an omitted `after` counts as 0) gets `410 { "resync": true, "next": <highest id now> }`. `min(id)` can't be used, because a rolled-back transaction leaves gaps in a `bigserial`. `next` is an addition to the spec's body: after its full rebuild, the consumer resumes from there.
   - `at` defaults to `clock_timestamp()` (taken under the lock), not `now()` (the transaction's start), so pruning by age follows id order closely.
   - Ids are JSON numbers. `after` is 1–15 digits; `limit` is 1–500, default 100.
   - Every write is recorded, including the legacy importer's re-imports (Q78).
8. **Changes authentication.** The News API has no inbound auth today.
   - `changesBearerFromEnv` builds bearer options only from Entra (`ENTRA_TENANT_ID` **and** `AUTH_AUDIENCE`) and/or `LOCAL_ADMIN_ENABLED=true`. It never passes a session secret, so a staff cookie is never accepted. On the stack `ENTRA_TENANT_ID` is shared but `NEWSAPI_AUTH_AUDIENCE` isn't set; the helper ignores half an Entra configuration instead of letting `authFromEnv` refuse to start the News API.
   - With neither, `/api/v2/changes` answers `503 { "error": "changes feed not configured" }`.
   - Allowed roles: the new service role `NewsApi.ChangesRead` (`NEWS_API_CHANGES_ROLE` in `@gcpe/auth`), or `Core.Admin`, so an operator can inspect the feed with a local admin token, as `/stack/errors` allows.
9. **Related posts.**
   - The route serves `post_related` only while the search mode is `semantic`; otherwise, and when there's no row, it uses the text fallback. Turning the flag off stops AI-derived output at once.
   - Related keys are filtered to currently published posts at read time, in the stored order. Other posts' lists only refresh when they are re-embedded (spec §13), so this filter is what keeps an unpublished post off them. If the filtered list is empty, the fallback runs.
   - The fallback: up to 5 newest published posts with the same lead ministry (case-insensitive) and at least one shared tag (`index_keys && ARRAY['tags:…']`), excluding the post itself. A post with no lead ministry or no tags gets `results: []`.
   - Response: `{ mode: "semantic" | "text", results: SearchResult[] }`, the same result shape as search, `no-store`.
   - A key over 200 characters or containing NUL is a 404 without a query. A malformed percent-encoding is Express's own 400.
10. **Q74 ruling: 6b adds a per-IP limit to `/api/v2/search`.**
    - `SEARCH_RATE_LIMIT_PER_MIN`, default 60, keyed exactly as Subscribe (`SUBSCRIBE_CLIENT_IP_HEADER`, else `req.ip`, IPv6 grouped by `ipKeyGenerator`). The key function moves to `src/http/client-ip.ts` and Subscribe imports it unchanged.
    - Why: an uncached semantic query costs an Azure call and an exact vector scan (ruling 3); a broad text query already costs about 0.3 s at 50,000 posts (Q74's measurement).
    - The store is per process. On OpenShift each replica counts separately; on SiteGround there is one process.
    - A 429 is `{ "error": "too many requests" }` with `no-store`. `related` (one key lookup) and `changes` (a service token) are not limited.
11. **M2 ruling.** `SemanticSearch.search` catches every embed failure and returns `null`. The guarded embedder already logged a real provider failure, once. An open breaker (`BreakerOpenError`) and a caller abort are never logged: `createGuardedEmbedder` now skips its log when the caller's signal is aborted. The service still logs, once per request, a failure of the semantic branch's own SQL. While the breaker is open, a search therefore logs nothing.
12. **M5 ruling: fixed.** Text mode's count and page, and semantic mode's vector keys, text count and page, each run in one `REPEATABLE READ READ ONLY` transaction. Semantic mode computes the distances once per request, because the vector keys are read once and then sliced in code.
13. **The query vector cache** is keyed by `normaliseForEmbedding(q)`, and that normalised text is what gets embedded, so the key and the input always match. A query that normalises to nothing (`!!!`) skips the vector branch: text mode, no provider call.
14. **6a ruling 7 reversed.** `siteground:env` does **not** add `NEWSAPI_EMBEDDINGS_PROVIDER=stand-in`. boxs.ca's Postgres role can't enable pgvector (`docs/deploy/siteground.md:17-19`), so semantic mode can't turn on there, and the stand-in would do nothing. boxs.ca verifies text mode, `newsApiSearch: "text"`, related posts' text fallback and the changes feed. Semantic mode is verified locally and in CI (Q80).
15. **The legacy importer's unpublish-missing step** now runs in one transaction that also deletes those posts' embeddings and related rows and records their `post.unpublished` changes. Keys travel as one JSON parameter, as the step already does, because tens of thousands of keys would exceed Postgres's 65,535 bind parameters.
16. **`post_embeddings` and `post_related` reference `posts(key)`** with `ON DELETE CASCADE ON UPDATE CASCADE`. `TRUNCATE posts` then fails ("cannot truncate a table referenced in a foreign key constraint"), so the four test files that truncate `posts` add `CASCADE`. None of them is a protected v1 suite.

---

## Global Constraints

Carried over verbatim from Phase 6a:

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

## Review Focus

These are the five inputs most likely to bite a person, which the spec implies but doesn't spell out. Each has a test in the task named.

1. **A post unpublished while the worker is embedding it** (after the candidate read, before the write) must end with no `post_embeddings` and no `post_related` row, not a vector for a post the public can't see. Task 3: "a post unpublished during the provider call gets no embedding or related row".
2. **Two projection transactions committing out of id order.** A reader polling `/api/v2/changes` must never be handed a higher id while a lower one is still uncommitted, or its cursor skips that change forever and the site never rebuilds the page. Task 2: "a change waits for an earlier uncommitted change, so a reader never sees ids out of order".
3. **A legacy import that unpublishes tens of thousands of posts at once.** Cleanup and change rows must go in one statement each with one JSON parameter, not one bind parameter per key (Postgres refuses more than 65,535). Task 2: "records 70,000 changes in one call"; Task 3: "deleteSemanticRows takes 70,000 keys in one call".
4. **A related list that names a post since unpublished.** The other post's stored list isn't recomputed until it is re-embedded, so the route must drop the unpublished key at read time, and fall back to text when nothing is left. Task 5: "drops related keys that are no longer published, and falls back when none is left".
5. **Hostile `{key}` in `/api/v2/posts/{key}/related`:** a NUL (`%00`), 201+ characters, malformed percent-encoding (`%E0%A4%A`). Each must be a 404 or 400, never a 500 and never an `/stack/errors` entry. Task 5: the `it.each` table in `related.test.ts`.

## File structure

**Created:**
- `apps/news-api/migrations/0004_semantic_tables.sql`, `meta/0004_snapshot.json` and the journal entry (generated).
- `apps/news-api/migrations/0005_pgvector_optional.sql` (custom), `meta/0005_snapshot.json` and the journal entry (generated).
- `apps/news-api/src/embeddings/pgvector.ts`: `VECTOR_DIMENSIONS`, `HNSW_INDEX_NAME`, `hasPgvector`, `hasHnswIndex`, `resolveSearchMode`.
- `apps/news-api/src/embeddings/pgvector.test.ts`: the §9 migration tests.
- `apps/news-api/src/embeddings/source-text.ts`: `EMBEDDING_SOURCE_MAX_CHARS`, `embeddingSourceText`, `embeddingTextHash`.
- `apps/news-api/src/embeddings/rows.ts`: `deleteSemanticRows`.
- `apps/news-api/src/embeddings/worker.ts`: `runEmbeddingTick`, `EMBEDDING_BATCH_SIZE`, `RELATED_LIMIT`.
- `apps/news-api/src/embeddings/source-text.test.ts`, `worker.test.ts`.
- `apps/news-api/src/changes.ts`: `recordChanges`, `readChanges`, `pruneChanges`, `CATEGORY_CHANGE_KIND`, the limits.
- `apps/news-api/src/changes.test.ts`.
- `apps/news-api/src/loop.ts`: `every` (the standalone process's interval loop).
- `apps/news-api/src/http/client-ip.ts`: `clientIpKey`.
- `apps/news-api/src/http/v2/changes.ts`: `changesRoutes`, `parseChangesQuery`, `ChangesRouteOptions`.
- `apps/news-api/src/http/v2/changes-auth.ts`: `changesBearerFromEnv`.
- `apps/news-api/src/http/v2/changes.test.ts`.
- `apps/news-api/src/search/vector-cache.ts`: `QueryVectorCache`.
- `apps/news-api/src/search/semantic.ts`: `createSemanticSearch`, `pageWindow`, `VECTOR_CANDIDATE_LIMIT`.
- `apps/news-api/src/search/related.ts`: `createRelatedService`, `RelatedService`, `RelatedResponse`.
- `apps/news-api/src/search/vector-cache.test.ts`, `semantic.test.ts`, `related.test.ts`.

**Modified:**
- `apps/news-api/src/db/schema.ts`: the new tables, `posts.embeddingTextHash`, `CHANGE_KINDS`, `ChangeKind`, `PostRow`'s `Omit`.
- `apps/news-api/src/posts.ts`: v1 reads leave out `embeddingTextHash` too.
- `apps/news-api/src/projections.ts`: change rows, the hash on every post write, unpublish cleanup.
- `apps/news-api/src/import/run.ts`: unpublish-missing in one transaction with cleanup and change rows.
- `apps/news-api/src/cli/search-backfill.ts`: writes `embedding_text_hash` with `search_text`.
- `apps/news-api/src/search/text-search.ts`: `DbOrTx`, `window`, `READ_SNAPSHOT`, `searchRowColumns`, `searchRowsByKeys`.
- `apps/news-api/src/search/service.ts`: `searchResultMapper`, the snapshot transaction, logging.
- `apps/news-api/src/http/v2/routes.ts`, `apps/news-api/src/http/v1/subscribe.ts` (imports `clientIpKey`), `apps/news-api/src/app.ts`, `env.ts`, `start.ts`.
- Tests: `apps/news-api/test/helpers.ts` (`createRestrictedNewsTestDb`, `writeTenantConfig`, `waitUntilBlockedOnLock`, `closeHandle`); `projections.test.ts`, `search/search.test.ts`, `cli/search-backfill.test.ts`, `import/run.test.ts` (`TRUNCATE … CASCADE` plus new cases); `start.test.ts`; `env.test.ts`; `http/v2/search.test.ts`.
- `packages/auth/src/roles.ts` and `index.ts`: `NEWS_API_CHANGES_ROLE`.
- `packages/embeddings/src/guarded.ts` and `guarded.test.ts`: no log for a caller abort.
- `apps/stack/src/stack.ts` and `stack.test.ts`: `newsApiSearch` in `/stack/health`; the `news-api.embed` and `news-api.changes-prune` tick steps.
- Docs: `docs/parity/open-questions.md`, `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`.

---

### Task 1: The semantic tables, the optional-pgvector migration, the startup mode and `newsApiSearch`

**Review:** full (migrations).

**Files:**
- Modify: `apps/news-api/src/db/schema.ts` (imports; `posts.embeddingTextHash`; four new tables; `CHANGE_KINDS`; `PostRow`)
- Modify: `apps/news-api/src/posts.ts:32` (v1 reads leave out the new column)
- Create (generated): `apps/news-api/migrations/0004_semantic_tables.sql`, `meta/0004_snapshot.json`, journal entry
- Create (custom, generated empty): `apps/news-api/migrations/0005_pgvector_optional.sql`, `meta/0005_snapshot.json`, journal entry
- Create: `apps/news-api/src/embeddings/pgvector.ts`, `apps/news-api/src/embeddings/pgvector.test.ts`
- Modify: `apps/news-api/src/start.ts`, `apps/news-api/test/helpers.ts`
- Modify: `apps/stack/src/stack.ts` (`healthRouter`), `apps/stack/src/stack.test.ts:274-280`
- Modify (`TRUNCATE … CASCADE`): `apps/news-api/src/projections.test.ts:50`, `apps/news-api/src/search/search.test.ts:45`, `apps/news-api/src/cli/search-backfill.test.ts:24`, `apps/news-api/src/import/run.test.ts:156`
- Docs: `docs/deploy/siteground.md`, `docs/manuals/running-notes.md`

**Interfaces:**
- Consumes (6a, unchanged): `createEmbeddingProvider(env): EmbeddingProvider | null` and `type EmbeddingProvider` from `@gcpe/embeddings`; `tenant.features.semanticSearch: boolean`; `type SearchMode = "text" | "semantic"` from `src/search/service.ts`; `createDb`, `runMigrations`, `type TestDatabase`, `type DbOrTx` from `@gcpe/db-kit`.
- Produces:
  - `schema.ts`: `postEmbeddings` (`postKey`, `provider`, `model`, `dimensions`, `textHash`, `embedding: number[]`, `embeddedAt`), `postRelated` (`postKey`, `relatedKeys: string[]`, `computedAt`), `changes` (`id: number`, `kind: ChangeKind`, `key: string | null`, `at: Date`), `changeFeedState` (`id`, `prunedThrough: number`), `posts.embeddingTextHash: string | null`, `CHANGE_KINDS`, `type ChangeKind`.
  - `pgvector.ts`: `VECTOR_DIMENSIONS = 1536`; `HNSW_INDEX_NAME = "post_embeddings_embedding_hnsw_idx"`; `hasPgvector(db: DbOrTx): Promise<boolean>`; `hasHnswIndex(db: DbOrTx): Promise<boolean>`; `resolveSearchMode(i: { flag: boolean; provider: EmbeddingProvider | null; pgvector: boolean }): { mode: SearchMode; missing: string[] }`.
  - `AppHandle.searchMode: SearchMode` (fixed for the process).
  - `test/helpers.ts`: `createRestrictedNewsTestDb(): Promise<TestDatabase>`, `writeTenantConfig(patch: Record<string, unknown>): string`, `closeHandle(h: { closeBeforeServer: Closer[]; closers: Closer[] }): Promise<void>`, `newsMigrationCount(): number`, `waitFor(check: () => Promise<boolean>, timeoutMs?: number): Promise<void>`, `waitUntilBlockedOnLock(pool: pg.Pool, timeoutMs?: number): Promise<void>` (moved from `projections.test.ts`).
  - `/stack/health` body gains `newsApiSearch: "semantic" | "text"`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/news-api/test/helpers.ts` (new imports at the top; keep everything already there):

```ts
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { createDb, runMigrations } from "@gcpe/db-kit";
import type { Closer } from "@gcpe/http-kit";

const adminUrl = () => process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://localhost:5432/postgres";

async function asAdmin(statements: string[]): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    for (const s of statements) await client.query(s);
  } finally {
    await client.end();
  }
}

/**
 * A database owned by a fresh LOGIN role that is not a superuser, so it cannot CREATE EXTENSION
 * vector (the SiteGround case, spec §9), with every News API migration applied as that role.
 */
export async function createRestrictedNewsTestDb(): Promise<TestDatabase> {
  const id = randomUUID().replace(/-/g, "").slice(0, 16);
  const role = `nr_${id}`;
  const name = `test_nr_${id}`;
  const password = `pw_${id}`;
  await asAdmin([
    `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}'`,
    `CREATE DATABASE "${name}" OWNER "${role}"`,
  ]);
  const url = new URL(adminUrl());
  url.username = role;
  url.password = password;
  url.pathname = `/${name}`;
  const { pool, db } = createDb(url.toString(), { max: 5 });
  const drop = async () => {
    await pool.end().catch(() => {});
    await asAdmin([`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`, `DROP ROLE IF EXISTS "${role}"`]);
  };
  try {
    await runMigrations(db, newsMigrations);
  } catch (e) {
    await drop();
    throw e;
  }
  return { pool, db, url: url.toString(), migrate: () => runMigrations(db, newsMigrations), drop };
}

export function newsMigrationCount(): number {
  return (JSON.parse(readFileSync(join(newsMigrations, "meta", "_journal.json"), "utf8")) as { entries: unknown[] }).entries.length;
}

const bcTenantPath = fileURLToPath(new URL("../../../config/tenants/bc.json", import.meta.url));

/** BC's tenant config with `patch` merged over its top level, written to a temp file. */
export function writeTenantConfig(patch: Record<string, unknown>): string {
  const bc = JSON.parse(readFileSync(bcTenantPath, "utf8")) as Record<string, unknown>;
  const file = join(mkdtempSync(join(tmpdir(), "tenant-")), "tenant.json");
  writeFileSync(file, JSON.stringify({ ...bc, ...patch }));
  return file;
}

export async function closeHandle(h: { closeBeforeServer: Closer[]; closers: Closer[] }): Promise<void> {
  await Promise.all([...h.closeBeforeServer, ...h.closers].map((c) => c.close()));
}

export async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}
```

Move `waitUntilBlockedOnLock` (with its doc comment) from `apps/news-api/src/projections.test.ts:14-30` into `helpers.ts` as an `export async function`, and import it in `projections.test.ts` from `"../test/helpers"`. Its body doesn't change.

Create `apps/news-api/src/embeddings/pgvector.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { standInProvider } from "@gcpe/embeddings";
import { closeHandle, createNewsTestDb, createRestrictedNewsTestDb, EVENT_SECRETS, newsMigrationCount, writeTenantConfig } from "../../test/helpers";
import { startNewsApi } from "../start";
import { hasHnswIndex, hasPgvector, resolveSearchMode } from "./pgvector";

describe("resolveSearchMode", () => {
  const p = standInProvider();
  it.each([
    [{ flag: true, provider: p, pgvector: true }, "semantic", []],
    [{ flag: false, provider: p, pgvector: true }, "text", ["the semanticSearch flag"]],
    [{ flag: true, provider: null, pgvector: true }, "text", ["an embeddings provider"]],
    [{ flag: true, provider: p, pgvector: false }, "text", ["pgvector"]],
    [{ flag: true, provider: standInProvider({ dimensions: 8 }), pgvector: true }, "text", ["a 1536-dimension provider"]],
    [{ flag: false, provider: null, pgvector: false }, "text", ["the semanticSearch flag", "an embeddings provider", "pgvector"]],
  ] as const)("%o -> %s", (inputs, mode, missing) => {
    expect(resolveSearchMode(inputs)).toEqual({ mode, missing });
  });
});

describe("migrations with and without pgvector (spec §9)", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    vi.restoreAllMocks();
  });
  const env = (url: string, extra: Record<string, string> = {}) => ({
    DATABASE_URL: url,
    EVENT_SECRETS: JSON.stringify(EVENT_SECRETS),
    TENANT_CONFIG: writeTenantConfig({ features: { semanticSearch: true, staffAi: false } }),
    EMBEDDINGS_PROVIDER: "stand-in",
    ...extra,
  });

  it("every migration succeeds as a role that cannot CREATE EXTENSION, and search stays in text mode", async () => {
    const tdb = await createRestrictedNewsTestDb();
    cleanups.push(() => tdb.drop());
    const { rows } = await tdb.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations");
    expect(rows[0]!.n).toBe(newsMigrationCount());
    expect(await hasPgvector(tdb.db)).toBe(false);
    expect(await hasHnswIndex(tdb.db)).toBe(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handle = await startNewsApi(env(tdb.url), { hub: false });
    cleanups.push(() => closeHandle(handle));
    expect(handle.searchMode).toBe("text");
    expect(warn).toHaveBeenCalledWith("[news-api] semantic search is off: missing pgvector");
  });

  it("as a role that can, pgvector and the HNSW index are created and semantic search turns on", async () => {
    const tdb = await createNewsTestDb();
    cleanups.push(() => tdb.drop());
    expect(await hasPgvector(tdb.db)).toBe(true);
    expect(await hasHnswIndex(tdb.db)).toBe(true);
    const handle = await startNewsApi(env(tdb.url), { hub: false });
    cleanups.push(() => closeHandle(handle));
    expect(handle.searchMode).toBe("semantic");
  });

  it("stays in text mode, and says why, when the flag is on but no provider is configured", async () => {
    const tdb = await createNewsTestDb();
    cleanups.push(() => tdb.drop());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handle = await startNewsApi(env(tdb.url, { EMBEDDINGS_PROVIDER: "" }), { hub: false });
    cleanups.push(() => closeHandle(handle));
    expect(handle.searchMode).toBe("text");
    expect(warn).toHaveBeenCalledWith("[news-api] semantic search is off: missing an embeddings provider");
  });

  it("is text mode with the flag off, without a warning", async () => {
    const tdb = await createNewsTestDb();
    cleanups.push(() => tdb.drop());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handle = await startNewsApi({ ...env(tdb.url), TENANT_CONFIG: writeTenantConfig({}) }, { hub: false });
    cleanups.push(() => closeHandle(handle));
    expect(handle.searchMode).toBe("text");
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/semantic search is off/);
  });
});
```

In `apps/stack/src/stack.test.ts`, extend "GET /stack/health aggregates every app's own readiness" (line 274): widen the body type to `{ status: string; apps: Record<string, boolean>; newsApiSearch: string }` and add, after the `apps` assertion:

```ts
    // The stack's tenant has semanticSearch off, so the News API reports text mode.
    expect(body.newsApiSearch).toBe("text");
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/news-api/src/embeddings/pgvector.test.ts apps/stack/src/stack.test.ts -t "pgvector|resolveSearchMode|aggregates every app"`
Expected: FAIL. `pgvector.test.ts` can't resolve `./pgvector`; the stack test gets `undefined` for `newsApiSearch`.

- [ ] **Step 3: Add the schema**

In `apps/news-api/src/db/schema.ts`, change the `pg-core` import to:

```ts
import { bigint, bigserial, boolean, check, customType, index, integer, jsonb, pgTable, primaryKey, real, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
```

Add to `posts`, after `searchVector`:

```ts
    /**
     * SHA-256 (hex) of the embedding source text (src/embeddings/source-text.ts), written with
     * search_text. The worker compares it with post_embeddings.text_hash. NULL until written.
     */
    embeddingTextHash: text("embedding_text_hash"),
```

Add after the `posts` table:

```ts
/**
 * One vector per published post (spec §5.2). `embedding` is a plain real[] so every migration runs
 * without pgvector; where pgvector exists, migrations/0005 indexes `embedding::vector(1536)`.
 * Rows exist only for published posts: unpublishing deletes them in the same transaction.
 */
export const postEmbeddings = pgTable("post_embeddings", {
  postKey: text("post_key").primaryKey().references(() => posts.key, { onDelete: "cascade", onUpdate: "cascade" }),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  dimensions: integer("dimensions").notNull(),
  textHash: text("text_hash").notNull(),
  embedding: real("embedding").array().notNull(),
  embeddedAt: timestamp("embedded_at", { withTimezone: true }).notNull().defaultNow(),
});

/** The 5 nearest published neighbours, computed when the post is embedded (spec §5.4). */
export const postRelated = pgTable("post_related", {
  postKey: text("post_key").primaryKey().references(() => posts.key, { onDelete: "cascade", onUpdate: "cascade" }),
  relatedKeys: text("related_keys").array().notNull(),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const CHANGE_KINDS = ["post.upserted", "post.unpublished", "home", "slides", "resource_links", "ministry", "sector", "theme", "tag"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/**
 * The change feed (spec §5.4): one row per projection write, in the same transaction. `key` is
 * null for home, slides and resource_links. `at` is clock_timestamp(), taken under the feed's
 * advisory lock (src/changes.ts), so it follows id order.
 */
export const changes = pgTable(
  "changes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    kind: text("kind").notNull().$type<ChangeKind>(),
    key: text("key"),
    at: timestamp("at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  (t) => [
    index("changes_at_idx").on(t.at),
    check("changes_kind_check", sql`${t.kind} IN ('post.upserted', 'post.unpublished', 'home', 'slides', 'resource_links', 'ministry', 'sector', 'theme', 'tag')`),
  ],
);

/** One row: the highest change id ever pruned. A cursor below it has missed changes (410). */
export const changeFeedState = pgTable(
  "change_feed_state",
  {
    id: integer("id").primaryKey().default(1),
    prunedThrough: bigint("pruned_through", { mode: "number" }).notNull().default(0),
  },
  (t) => [check("change_feed_state_single_row", sql`${t.id} = 1`)],
);
```

Change `PostRow` to:

```ts
/** A post as v1 reads it: the search columns stay in the database (src/posts.ts selects without them). */
export type PostRow = Omit<typeof posts.$inferSelect, "searchText" | "searchVector" | "embeddingTextHash">;
```

In `apps/news-api/src/posts.ts:32`:

```ts
const { searchText: _searchText, searchVector: _searchVector, embeddingTextHash: _embeddingTextHash, ...postReadColumns } = getTableColumns(posts);
```

- [ ] **Step 4: Generate the migrations**

```bash
cd apps/news-api
npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name semantic_tables
npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --custom --name pgvector_optional
cd ../..
```

Check `apps/news-api/migrations/0004_semantic_tables.sql`. When planning, drizzle-kit 0.31 produced exactly these statements (with `DEFAULT now()` for `changes.at`; yours says `DEFAULT clock_timestamp()`): `CREATE TABLE "change_feed_state"` (with its check), `CREATE TABLE "changes"` (with its check), `CREATE TABLE "post_embeddings"` (`"embedding" real[] NOT NULL`), `CREATE TABLE "post_related"`, `ALTER TABLE "posts" ADD COLUMN "embedding_text_hash" text`, the two foreign keys `ON DELETE cascade ON UPDATE cascade`, and `CREATE INDEX "changes_at_idx"`. No `vector` anywhere. Don't edit it.

`0005_pgvector_optional.sql` is created holding one comment line. Replace its whole content with:

```sql
-- pgvector is optional (spec §5.3). Where this database role may create the extension, enable it
-- and index post_embeddings for cosine distance. Where it may not (SiteGround: insufficient_privilege)
-- or the extension isn't installed (undefined_file), skip both and leave search in text mode.
-- A DBA can run the same two statements later: docs/deploy/siteground.md, "pgvector and the search mode".
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
  CREATE INDEX IF NOT EXISTS post_embeddings_embedding_hnsw_idx
    ON post_embeddings USING hnsw ((embedding::vector(1536)) vector_cosine_ops);
EXCEPTION
  WHEN insufficient_privilege OR undefined_file THEN
    RAISE NOTICE 'pgvector unavailable (%): semantic search stays off', SQLSTATE;
END
$$;
```

Verified while planning, through the real `runMigrations` on Postgres 14.17 with pgvector 0.8.0:
- as a non-superuser owner, all six migrations applied, with no extension and no HNSW index (`42501` caught);
- as a superuser, the extension and `post_embeddings_embedding_hnsw_idx` were created;
- `CREATE EXTENSION no_such_ext` raises `58P01`, which `undefined_file` catches;
- a non-superuser whose DBA already created the extension gets the index (`IF NOT EXISTS` skips the privilege check);
- the exception handler's subtransaction leaves drizzle's surrounding migration transaction usable.

- [ ] **Step 5: Write `pgvector.ts`**

Create `apps/news-api/src/embeddings/pgvector.ts`:

```ts
import { sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import type { EmbeddingProvider } from "@gcpe/embeddings";
import type { SearchMode } from "../search/service";

/** The dimension in migrations/0005's index expression: every stored embedding must have it. */
export const VECTOR_DIMENSIONS = 1536;
export const HNSW_INDEX_NAME = "post_embeddings_embedding_hnsw_idx";

export async function hasPgvector(db: DbOrTx): Promise<boolean> {
  const { rows } = await db.execute<{ present: boolean }>(sql`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS present`);
  return rows[0]?.present === true;
}

export async function hasHnswIndex(db: DbOrTx): Promise<boolean> {
  const { rows } = await db.execute<{ present: boolean }>(
    sql`SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ${HNSW_INDEX_NAME}) AS present`,
  );
  return rows[0]?.present === true;
}

/**
 * Spec §5.3: semantic only when the tenant flag, a provider and pgvector are all present. The
 * provider must also produce VECTOR_DIMENSIONS, or the index expression would refuse its rows.
 * `missing` names what's absent, for the startup warning.
 */
export function resolveSearchMode(i: { flag: boolean; provider: EmbeddingProvider | null; pgvector: boolean }): { mode: SearchMode; missing: string[] } {
  const missing: string[] = [];
  if (!i.flag) missing.push("the semanticSearch flag");
  if (!i.provider) missing.push("an embeddings provider");
  else if (i.provider.dimensions !== VECTOR_DIMENSIONS) missing.push(`a ${VECTOR_DIMENSIONS}-dimension provider`);
  if (!i.pgvector) missing.push("pgvector");
  return { mode: missing.length === 0 ? "semantic" : "text", missing };
}
```

- [ ] **Step 6: Wire the mode into `startNewsApi`**

In `apps/news-api/src/start.ts`, add imports:

```ts
import { createEmbeddingProvider } from "@gcpe/embeddings";
import { hasHnswIndex, hasPgvector, resolveSearchMode } from "./embeddings/pgvector";
import type { SearchMode } from "./search/service";
```

Add to `AppHandle`:

```ts
  /** "semantic" only when the flag, a provider and pgvector are all present (spec §5.3). Read
   * once at startup: enabling pgvector later needs a restart. Reported by /stack/health. */
  searchMode: SearchMode;
```

Replace the `try { await assertSearchLanguage(…) } catch …` block with:

```ts
  const provider = createEmbeddingProvider(parsed);
  let searchMode: SearchMode;
  try {
    await assertSearchLanguage(db, tenant.search.language);
    const resolved = resolveSearchMode({ flag: tenant.features.semanticSearch, provider, pgvector: await hasPgvector(db) });
    searchMode = resolved.mode;
    if (tenant.features.semanticSearch && searchMode === "text") console.warn(`[news-api] semantic search is off: missing ${resolved.missing.join(", ")}`);
    if (searchMode === "semantic" && !(await hasHnswIndex(db))) {
      console.warn("[news-api] post_embeddings has no HNSW index: related posts scan every embedding (see the runbook, pgvector and the search mode)");
    }
  } catch (e) {
    await pool.end();
    throw e;
  }
```

Add `searchMode,` to the returned handle (after `timeZone`).

- [ ] **Step 7: Report it in `/stack/health`**

In `apps/stack/src/stack.ts`:
- Add a parameter: `function healthRouter(startedAt: string, withCalendar: boolean, newsApiSearch: "semantic" | "text"): Router`. Extend the doc comment: "`newsApiSearch` (spec §5.3) is the News API's startup search mode; like `startedAt`, it is constant for the process, so it sits outside the cache."
- In both `res.status(…).json(…)` calls, change `{ ...cached.body, startedAt, pid: process.pid }` / `{ ...body, startedAt, pid: process.pid }` to include `newsApiSearch` before `startedAt`.
- At the mount (line 466): `app.use("/stack", healthRouter(new Date(startedAt).toISOString(), calendar !== null, newsApi.searchMode));`

- [ ] **Step 8: Add `CASCADE` where tests truncate `posts`**

The new foreign keys make a bare `TRUNCATE posts` fail. Change exactly these strings:
- `apps/news-api/src/projections.test.ts:50`: `"TRUNCATE posts, categories, category_features, home, slides, resource_links CASCADE"`
- `apps/news-api/src/search/search.test.ts:45`: `"TRUNCATE posts CASCADE"`
- `apps/news-api/src/cli/search-backfill.test.ts:24`: `"TRUNCATE posts CASCADE"`
- `apps/news-api/src/import/run.test.ts:156`: `"TRUNCATE posts CASCADE"`

Then confirm nothing else truncates `posts` without it: `grep -rn "TRUNCATE" apps/news-api apps/stack/src tests | grep -i posts`. Every hit must end in `CASCADE`.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/news-api apps/stack/src/stack.test.ts`
Expected: PASS, including `compat.test.ts`, `e2e-core.test.ts`, `http/v1/*.test.ts` and `app.test.ts`, unedited.

Type-check: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`. Expected: exit 0.

- [ ] **Step 10: Runbook and running notes**

In `docs/deploy/siteground.md`, insert just before `## Troubleshooting`:

````markdown
## Semantic search, related posts and the change feed (Phase 6b)

### pgvector and the search mode

**Migrations:** `0004_semantic_tables` adds `post_embeddings`, `post_related`, `changes`, `change_feed_state` and `posts.embedding_text_hash`. `0005_pgvector_optional` then tries to enable pgvector and index the embeddings. On SiteGround the database user may not create extensions, so that step is skipped with a notice and every migration still succeeds. No setting is needed.

**The search mode** is decided once, when the News API starts. It is `semantic` only when all of these hold:
- the tenant config has `"features": { "semanticSearch": true }`;
- `NEWSAPI_EMBEDDINGS_PROVIDER` is set (`azure-openai`, or `stand-in` on a test site);
- the News API's database has the `vector` extension.

Otherwise it is `text`. `/stack/health` reports it as `"newsApiSearch": "semantic"` or `"text"`. When the flag is on but something is missing, the News API logs one line at startup, for example `[news-api] semantic search is off: missing pgvector`.

On boxs.ca it is always `text`: SiteGround's Postgres user can't enable pgvector.

**Enabling pgvector later** (OpenShift or any Postgres where a DBA can): connect to the News API's database as a role allowed to create extensions, and run:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE INDEX CONCURRENTLY IF NOT EXISTS post_embeddings_embedding_hnsw_idx
  ON post_embeddings USING hnsw ((embedding::vector(1536)) vector_cosine_ops);
```

Then restart the News API. `CONCURRENTLY` keeps the table writable while the index builds; it can't run inside a transaction block. Without the index, semantic search still works, but each related-posts computation scans every embedding, and the News API logs `post_embeddings has no HNSW index` at startup.
````

In `docs/manuals/running-notes.md`, add after the Phase 6a list:

```markdown
## Phase 6b — Semantic search, related posts and the change feed

- **Operations** — The News API's migrations add the embeddings, related-posts and change-feed tables, and try to enable pgvector. Where the database user can't (SiteGround), that step is skipped and everything else still runs. `/stack/health` now says `"newsApiSearch": "semantic"` or `"text"`. It is `semantic` only when the tenant's `semanticSearch` flag is on, an embeddings provider is configured, and the database has pgvector; the News API logs which one is missing at startup. boxs.ca always says `text`.
- **Developer** — No drizzle schema column uses the `vector` type. `post_embeddings.embedding` is `real[]`; the one custom migration (`0005_pgvector_optional`) wraps `CREATE EXTENSION vector` and the HNSW expression index on `embedding::vector(1536)` in a `DO` block that skips both on `insufficient_privilege` or `undefined_file`. `resolveSearchMode` (`src/embeddings/pgvector.ts`) decides the mode once at startup. Tests that need the SiteGround case use `createRestrictedNewsTestDb()`.
```

- [ ] **Step 11: Commit**

```bash
git add apps/news-api apps/stack/src/stack.ts apps/stack/src/stack.test.ts docs/deploy/siteground.md docs/manuals/running-notes.md
git commit -m "feat(news-api): semantic tables, optional pgvector migration and the startup search mode"
```

---

### Task 2: The change feed: rows in every projection transaction, pruning, and the service-token `GET /api/v2/changes`

**Review:** full (change feed, service-token route).

**Files:**
- Create: `apps/news-api/src/changes.ts`, `apps/news-api/src/changes.test.ts`
- Create: `apps/news-api/src/loop.ts`
- Create: `apps/news-api/src/http/v2/changes.ts`, `apps/news-api/src/http/v2/changes-auth.ts`, `apps/news-api/src/http/v2/changes.test.ts`
- Modify: `apps/news-api/src/projections.ts` (every write), `apps/news-api/src/projections.test.ts`
- Modify: `apps/news-api/src/import/run.ts:76-92` (unpublish-missing), `apps/news-api/src/import/run.test.ts`
- Modify: `apps/news-api/src/http/v2/routes.ts`, `apps/news-api/src/app.ts`, `apps/news-api/src/start.ts`
- Modify: `packages/auth/src/roles.ts`, `packages/auth/src/index.ts`
- Modify: `apps/stack/src/stack.ts` (tick step)
- Docs: `docs/deploy/siteground.md`, `docs/manuals/running-notes.md`

**Interfaces:**
- Consumes (Task 1): `changes`, `changeFeedState`, `type ChangeKind` from `src/db/schema.ts`; `waitFor`, `waitUntilBlockedOnLock`, `createNewsTestDb` from `test/helpers.ts`.
- Consumes (existing): `requireBearer`, `requireAnyRole`, `authFromEnv`, `mintLocalToken`, `type BearerOptions` from `@gcpe/auth`; `formatOffsetDateTime(date, timeZone)` from `src/time.ts`; `type CategoryKind` from `@gcpe/events`; `safeErrorLabel` from `@gcpe/http-kit`.
- Produces:
  - `changes.ts`: `CHANGES_LOCK = [0x67637065, 4] as const`; `CHANGES_RETENTION_DAYS = 90`; `CHANGES_MAX_LIMIT = 500`; `CHANGES_DEFAULT_LIMIT = 100`; `CATEGORY_CHANGE_KIND: Record<CategoryKind, ChangeKind>`; `interface Change { kind: ChangeKind; key: string | null }`; `recordChanges(tx: Tx, rows: Change[]): Promise<void>`; `type ChangesRead = { resync: false; changes: { id: number; kind: ChangeKind; key: string | null; at: Date }[]; next: number } | { resync: true; next: number }`; `readChanges(db: Db, after: number, limit: number): Promise<ChangesRead>`; `pruneChanges(db: Db, retentionDays?: number): Promise<number>`.
  - `loop.ts`: `every(intervalMs: number, label: string, fn: () => Promise<unknown>): () => void`.
  - `http/v2/changes.ts`: `interface ChangesRouteOptions { db: Db; timeZone: string; bearer: BearerOptions | null }`; `parseChangesQuery(raw: Record<string, unknown>): { ok: true; after: number; limit: number } | { ok: false; parameter: string; message: string }`; `changesRoutes(o: ChangesRouteOptions): express.Router`.
  - `http/v2/changes-auth.ts`: `changesBearerFromEnv(env: NodeJS.ProcessEnv): BearerOptions | null`.
  - `v2Routes(deps: { search?: SearchService; changes?: ChangesRouteOptions })`; `AppDeps.changes?: ChangesRouteOptions`.
  - `@gcpe/auth`: `NEWS_API_CHANGES_ROLE = "NewsApi.ChangesRead"`.
  - `AppHandle.workers.changesPrune`; the closer `"background loops"`; the stack tick step `news-api.changes-prune`.

- [ ] **Step 1: Write the failing tests for the feed itself**

Create `apps/news-api/src/changes.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNewsTestDb, waitFor, waitUntilBlockedOnLock } from "../test/helpers";
import { pruneChanges, readChanges, recordChanges, type Change } from "./changes";

describe("the change feed (spec §5.4)", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNewsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE changes RESTART IDENTITY");
    await tdb.pool.query("TRUNCATE change_feed_state");
  });
  const record = (rows: Change[]) => tdb.db.transaction((tx) => recordChanges(tx, rows));
  const ids = async () => (await tdb.pool.query<{ id: string }>("SELECT id FROM changes ORDER BY id")).rows.map((r) => Number(r.id));

  it("reads changes after a cursor, in id order, up to the limit, and says where to resume", async () => {
    await record([{ kind: "post.upserted", key: "R-1" }, { kind: "home", key: null }]);
    await record([{ kind: "ministry", key: "health" }]);
    expect(await readChanges(tdb.db, 0, 2)).toMatchObject({
      resync: false,
      next: 2,
      changes: [{ id: 1, kind: "post.upserted", key: "R-1" }, { id: 2, kind: "home", key: null }],
    });
    expect(await readChanges(tdb.db, 2, 2)).toMatchObject({ resync: false, next: 3, changes: [{ id: 3, kind: "ministry", key: "health" }] });
    expect(await readChanges(tdb.db, 3, 2)).toEqual({ resync: false, next: 3, changes: [] });
    expect(await readChanges(tdb.db, 99, 2)).toEqual({ resync: false, next: 99, changes: [] });
  });

  it("records nothing for an empty list, and takes no lock for it", async () => {
    await record([]);
    expect(await ids()).toEqual([]);
  });

  it("a change waits for an earlier uncommitted change, so a reader never sees ids out of order", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = tdb.db.transaction(async (tx) => {
      await recordChanges(tx, [{ kind: "post.upserted", key: "FIRST" }]);
      await gate;
    });
    // The sequence advances outside the transaction: once it has, FIRST holds id 1, uncommitted.
    await waitFor(async () => (await tdb.pool.query<{ is_called: boolean }>("SELECT is_called FROM changes_id_seq")).rows[0]!.is_called);
    const second = tdb.db.transaction((tx) => recordChanges(tx, [{ kind: "post.upserted", key: "SECOND" }]));
    await Promise.race([waitUntilBlockedOnLock(tdb.pool).catch(() => {}), second]);
    // Without the feed's lock, SECOND (id 2) would already be committed and visible here, and a
    // reader that moved its cursor to 2 would never see FIRST.
    expect((await readChanges(tdb.db, 0, 10)).changes).toEqual([]);
    release();
    await Promise.all([first, second]);
    expect((await readChanges(tdb.db, 0, 10)).changes.map((c) => [c.id, c.key])).toEqual([[1, "FIRST"], [2, "SECOND"]]);
  });

  it("records 70,000 changes in one call", async () => {
    const rows = Array.from({ length: 70_000 }, (_, i) => ({ kind: "post.unpublished" as const, key: `K-${i}` }));
    await tdb.db.transaction((tx) => recordChanges(tx, rows));
    expect((await tdb.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM changes")).rows[0]!.n).toBe(70_000);
  });

  it("prunes rows older than 90 days, and answers resync with the head for a cursor below what was pruned", async () => {
    await record([{ kind: "home", key: null }]);
    await record([{ kind: "slides", key: null }]);
    await record([{ kind: "tag", key: "fires" }]);
    await tdb.pool.query("UPDATE changes SET at = now() - interval '91 days' WHERE id <= 2");
    expect(await pruneChanges(tdb.db)).toBe(2);
    expect(await ids()).toEqual([3]);
    expect(await readChanges(tdb.db, 0, 10)).toEqual({ resync: true, next: 3 });
    expect(await readChanges(tdb.db, 1, 10)).toEqual({ resync: true, next: 3 });
    expect(await readChanges(tdb.db, 2, 10)).toMatchObject({ resync: false, next: 3, changes: [{ id: 3 }] });
    // A prune that deletes nothing keeps the watermark.
    expect(await pruneChanges(tdb.db)).toBe(0);
    expect(await readChanges(tdb.db, 1, 10)).toEqual({ resync: true, next: 3 });
  });

  it("keeps a row 89 days old, and with every row pruned answers resync with the watermark as next", async () => {
    await record([{ kind: "home", key: null }]);
    await record([{ kind: "home", key: null }]);
    await tdb.pool.query("UPDATE changes SET at = now() - interval '89 days' WHERE id = 2");
    await tdb.pool.query("UPDATE changes SET at = now() - interval '91 days' WHERE id = 1");
    expect(await pruneChanges(tdb.db)).toBe(1);
    await tdb.pool.query("UPDATE changes SET at = now() - interval '91 days'");
    expect(await pruneChanges(tdb.db)).toBe(1);
    expect(await ids()).toEqual([]);
    expect(await readChanges(tdb.db, 0, 10)).toEqual({ resync: true, next: 2 });
    expect(await readChanges(tdb.db, 2, 10)).toEqual({ resync: false, next: 2, changes: [] });
  });
});
```

In `apps/news-api/src/projections.test.ts`, inside the main `describe("projections", …)`, add this block. The file's `TRUNCATE … CASCADE` doesn't reach `changes` (no foreign key), so the block clears it itself:

```ts
  describe("change rows (spec §5.4)", () => {
    beforeEach(async () => {
      await tdb.pool.query("TRUNCATE changes RESTART IDENTITY");
    });
    const changeRows = async () => (await tdb.pool.query<{ kind: string; key: string | null }>("SELECT kind, key FROM changes ORDER BY id")).rows;
    const term: TermRecord = { kind: "tag", key: "Fires", displayName: "Fires", sortOrder: 0, isActive: true, social: org.social, updatedAt: org.updatedAt };

    it("writes one change row in the same transaction as each projection write, with the stored key", async () => {
      await tdb.db.transaction((tx) => applyRelease(tx, { ...sampleRelease, key: "R-CH" }));
      await tdb.db.transaction((tx) => unpublishRelease(tx, "r-ch"));
      await tdb.db.transaction((tx) => applyOrg(tx, org));
      await tdb.db.transaction((tx) => applyTerm(tx, term));
      await tdb.db.transaction((tx) => deactivateCategory(tx, "tags", "FIRES"));
      await tdb.db.transaction(async (tx) => {
        await applySiteContent(tx, { entity: "home", topPostKey: null, featurePostKey: null, liveWebcastFlashMediaManifestUrl: null, liveWebcastM3uPlaylist: null, granville: null, timestamp: org.updatedAt });
        await applySiteContent(tx, { entity: "categoryFeatures", kind: "ministries", key: "HEALTH", topPostKey: null, featurePostKey: null });
        await applySiteContent(tx, { entity: "slides", slides: [] });
        await applySiteContent(tx, { entity: "resourceLinks", links: [], timestamp: org.updatedAt });
      });
      expect(await changeRows()).toEqual([
        { kind: "post.upserted", key: "R-CH" },
        { kind: "post.unpublished", key: "R-CH" },
        { kind: "ministry", key: "health" },
        { kind: "tag", key: "Fires" },
        { kind: "tag", key: "Fires" },
        { kind: "home", key: null },
        { kind: "ministry", key: "health" },
        { kind: "slides", key: null },
        { kind: "resource_links", key: null },
      ]);
    });

    it("writes nothing when the transaction rolls back", async () => {
      await expect(
        tdb.db.transaction(async (tx) => {
          await applyRelease(tx, { ...sampleRelease, key: "R-RB" });
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(await changeRows()).toEqual([]);
    });

    it("writes nothing for a legacy write refused because NRMS owns the key", async () => {
      await tdb.db.transaction((tx) => applyRelease(tx, { ...sampleRelease, key: "R-OWN" }));
      await tdb.pool.query("TRUNCATE changes");
      await tdb.db.transaction((tx) => applyRelease(tx, { ...sampleRelease, key: "R-OWN" }, { origin: "legacy" }));
      expect(await changeRows()).toEqual([]);
    });

    it("records a ministry change for the ministry and its parent", async () => {
      await tdb.db.transaction((tx) => applyOrg(tx, { ...org, key: "parent-min", parentKey: null }));
      await tdb.pool.query("TRUNCATE changes");
      await tdb.db.transaction((tx) => applyOrg(tx, { ...org, key: "child-min", parentKey: "parent-min" }));
      expect(await changeRows()).toEqual([
        { kind: "ministry", key: "child-min" },
        { kind: "ministry", key: "parent-min" },
      ]);
    });
  });
```

`TermRecord` is already imported in that file. If `deactivateCategory`'s second argument type is `CategoryKind`, `"tags"` is valid.

In `apps/news-api/src/import/run.test.ts`, in `describe("importLegacyNews: unpublishes posts missing from legacy's published set", …)`, add:

```ts
  it("records post.unpublished for each post it unpublishes, in the same transaction", async () => {
    await tdb.pool.query("TRUNCATE changes RESTART IDENTITY");
    await importLegacyNews(tdb.db, source);
    const { rows } = await tdb.pool.query<{ kind: string; key: string }>("SELECT kind, key FROM changes WHERE kind = 'post.unpublished'");
    expect(rows).toEqual([{ kind: "post.unpublished", key: "STALE-1" }]);
  });
```

- [ ] **Step 2: Write the failing HTTP tests**

Create `apps/news-api/src/http/v2/changes.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { mintLocalToken, NEWS_API_CHANGES_ROLE } from "@gcpe/auth";
import type { TestDatabase } from "@gcpe/db-kit";
import { jsonErrorHandler } from "@gcpe/http-kit";
import { createNewsTestDb, TZ } from "../../../test/helpers";
import { pruneChanges, recordChanges } from "../../changes";
import { changesBearerFromEnv } from "./changes-auth";
import { parseChangesQuery } from "./changes";
import { v2Routes } from "./routes";

const SECRET = "c".repeat(40);
const token = (roles: string[]) => mintLocalToken({ secret: SECRET, subject: "site-builder", roles });

describe("parseChangesQuery", () => {
  it.each([
    [{}, { ok: true, after: 0, limit: 100 }],
    [{ after: "7", limit: "500" }, { ok: true, after: 7, limit: 500 }],
    [{ after: "007" }, { ok: true, after: 7, limit: 100 }],
  ])("accepts %o", (raw, expected) => expect(parseChangesQuery(raw)).toEqual(expected));

  it.each([
    [{ after: "-1" }, "after"],
    [{ after: "1.5" }, "after"],
    [{ after: "1234567890123456" }, "after"],
    [{ after: "" }, "after"],
    [{ after: ["1", "2"] }, "after"],
    [{ limit: "0" }, "limit"],
    [{ limit: "501" }, "limit"],
    [{ limit: "ten" }, "limit"],
    [{ limit: ["1", "2"] }, "limit"],
  ])("refuses %o, naming %s", (raw, parameter) => {
    expect(parseChangesQuery(raw as Record<string, unknown>)).toMatchObject({ ok: false, parameter });
  });
});

describe("changesBearerFromEnv", () => {
  const local = { LOCAL_ADMIN_ENABLED: "true", LOCAL_ADMIN_PASSWORD_HASH: "", LOCAL_AUTH_SECRET: SECRET };
  it("is null with neither Entra nor local admin", () => {
    expect(changesBearerFromEnv({})).toBeNull();
    expect(changesBearerFromEnv({ ENTRA_TENANT_ID: "t" })).toBeNull();
  });
  it("ignores half an Entra setup and never carries a session secret", async () => {
    const { hashPassword } = await import("@gcpe/auth");
    const env = { ...local, LOCAL_ADMIN_PASSWORD_HASH: await hashPassword("pw-for-tests-only"), ENTRA_TENANT_ID: "t", SESSION_SECRET: "s".repeat(40) };
    const bearer = changesBearerFromEnv(env);
    expect(bearer?.local).toEqual({ secret: SECRET });
    expect(bearer?.issuer).toBeUndefined();
    expect(bearer?.session).toBeUndefined();
  });
});

describe("GET /api/v2/changes", () => {
  let tdb: TestDatabase;
  const app = (bearer: { local: { secret: string } } | null) => {
    const a = express();
    a.use("/api/v2", v2Routes({ changes: { db: tdb.db, timeZone: TZ, bearer } }));
    a.use(jsonErrorHandler({ logPrefix: "[news-api]" }));
    return a;
  };
  beforeAll(async () => {
    tdb = await createNewsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE changes RESTART IDENTITY");
    await tdb.pool.query("TRUNCATE change_feed_state");
    await tdb.db.transaction((tx) => recordChanges(tx, [{ kind: "post.upserted", key: "R-1" }, { kind: "home", key: null }]));
  });

  it("answers the service role with changes, next, BC-offset times and no-store", async () => {
    const res = await request(app({ local: { secret: SECRET } })).get("/api/v2/changes?after=0&limit=1").set("authorization", `Bearer ${await token([NEWS_API_CHANGES_ROLE])}`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({ changes: [{ id: 1, kind: "post.upserted", key: "R-1", at: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?-0[78]:00$/) }], next: 1 });
  });

  it("lets a Core.Admin token read it too", async () => {
    const res = await request(app({ local: { secret: SECRET } })).get("/api/v2/changes").set("authorization", `Bearer ${await token(["Core.Admin"])}`);
    expect(res.status).toBe(200);
    expect(res.body.next).toBe(2);
  });

  it.each([
    ["no token", undefined, 401],
    ["a token without the role", ["NRMS.Editor"], 403],
  ] as const)("refuses %s with no-store", async (_label, roles, status) => {
    const req = request(app({ local: { secret: SECRET } })).get("/api/v2/changes");
    const res = roles ? await req.set("authorization", `Bearer ${await token([...roles])}`) : await req;
    expect(res.status).toBe(status);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(res.body)).not.toContain("R-1");
  });

  it("refuses a staff session cookie (no bearer token)", async () => {
    const res = await request(app({ local: { secret: SECRET } })).get("/api/v2/changes").set("cookie", "gcpe_session=anything");
    expect(res.status).toBe(401);
  });

  it("answers 503 when the News API has no auth configured", async () => {
    const res = await request(app(null)).get("/api/v2/changes");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "changes feed not configured" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("answers 400 naming the parameter, without echoing it", async () => {
    const res = await request(app({ local: { secret: SECRET } })).get("/api/v2/changes?after=zqxmarker").set("authorization", `Bearer ${await token([NEWS_API_CHANGES_ROLE])}`);
    expect(res.status).toBe(400);
    expect(res.body.error.parameter).toBe("after");
    expect(JSON.stringify(res.body)).not.toContain("zqxmarker");
  });

  it("answers 410 resync with the head when the cursor is older than the oldest kept change", async () => {
    await tdb.pool.query("UPDATE changes SET at = now() - interval '91 days' WHERE id = 1");
    await pruneChanges(tdb.db);
    const res = await request(app({ local: { secret: SECRET } })).get("/api/v2/changes?after=0").set("authorization", `Bearer ${await token([NEWS_API_CHANGES_ROLE])}`);
    expect(res.status).toBe(410);
    expect(res.body).toEqual({ resync: true, next: 2 });
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});
```

`changesBearerFromEnv` with local admin needs a valid password hash because `authFromEnv` checks it; the test hashes one. If `hashPassword` is slow (scrypt), that one test takes about a second; that's fine.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/news-api/src/changes.test.ts apps/news-api/src/http/v2/changes.test.ts apps/news-api/src/projections.test.ts apps/news-api/src/import/run.test.ts`
Expected: FAIL: `./changes`, `./changes-auth` and `NEWS_API_CHANGES_ROLE` don't exist; the projection and importer tests find no change rows.

- [ ] **Step 4: Add the role**

In `packages/auth/src/roles.ts`:

```ts
/** Phase 6b: the service role that may read the News API's change feed (`GET /api/v2/changes`).
 * The public site's builder holds it. Not a staff role. */
export const NEWS_API_CHANGES_ROLE = "NewsApi.ChangesRead";
```

Add `NEWS_API_CHANGES_ROLE` to the roles export line in `packages/auth/src/index.ts`.

- [ ] **Step 5: Write `changes.ts`**

Create `apps/news-api/src/changes.ts`:

```ts
import { asc, gt, sql } from "drizzle-orm";
import type { Db, Tx } from "@gcpe/db-kit";
import type { CategoryKind } from "@gcpe/events";
import { changeFeedState, changes, type ChangeKind } from "./db/schema";

/** Two-int advisory key (the "gcpe" space db-kit's migration lock uses); 4 is this feed's. */
export const CHANGES_LOCK = [0x67637065, 4] as const;
export const CHANGES_RETENTION_DAYS = 90;
export const CHANGES_MAX_LIMIT = 500;
export const CHANGES_DEFAULT_LIMIT = 100;

export const CATEGORY_CHANGE_KIND: Record<CategoryKind, ChangeKind> = { ministries: "ministry", sectors: "sector", themes: "theme", tags: "tag" };

export interface Change {
  kind: ChangeKind;
  key: string | null;
}

/**
 * Writes `rows` to the change feed in the caller's transaction (spec §5.4). The advisory lock,
 * held until commit, serialises every writer from this point on, so ids become visible in id
 * order: a reader whose cursor has passed id N can never later find an id below N commit. It is
 * always the last lock a projection transaction takes. One JSON parameter, whatever the count.
 */
export async function recordChanges(tx: Tx, rows: Change[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${CHANGES_LOCK[0]}, ${CHANGES_LOCK[1]})`);
  await tx.execute(sql`
    INSERT INTO changes (kind, key)
    SELECT c.kind, c.key FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS c(kind text, key text)`);
}

export type ChangesRead =
  | { resync: false; changes: { id: number; kind: ChangeKind; key: string | null; at: Date }[]; next: number }
  | { resync: true; next: number };

/**
 * Changes with id > `after`, oldest first, at most `limit`. A cursor below the highest pruned id
 * has missed changes: resync, with the current head as the place to resume after a full rebuild.
 */
export async function readChanges(db: Db, after: number, limit: number): Promise<ChangesRead> {
  return db.transaction(
    async (tx) => {
      const [state] = await tx.select({ prunedThrough: changeFeedState.prunedThrough }).from(changeFeedState);
      const prunedThrough = state?.prunedThrough ?? 0;
      if (after < prunedThrough) {
        const [{ head } = { head: null }] = await tx.select({ head: sql<string | null>`max(${changes.id})` }).from(changes);
        return { resync: true as const, next: head === null ? prunedThrough : Number(head) };
      }
      const rows = await tx.select().from(changes).where(gt(changes.id, after)).orderBy(asc(changes.id)).limit(limit);
      return { resync: false as const, changes: rows, next: rows.length > 0 ? rows[rows.length - 1]!.id : after };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/** Deletes changes older than `retentionDays` and raises the pruned-through watermark. */
export async function pruneChanges(db: Db, retentionDays = CHANGES_RETENTION_DAYS): Promise<number> {
  const { rows } = await db.execute<{ n: number }>(sql`
    WITH deleted AS (
      DELETE FROM changes WHERE at < now() - make_interval(days => ${retentionDays}) RETURNING id
    ), watermark AS (
      INSERT INTO change_feed_state (id, pruned_through)
      SELECT 1, max(id) FROM deleted HAVING max(id) IS NOT NULL
      ON CONFLICT (id) DO UPDATE SET pruned_through = greatest(change_feed_state.pruned_through, excluded.pruned_through)
    )
    SELECT count(*)::int AS n FROM deleted`);
  return rows[0]?.n ?? 0;
}
```

- [ ] **Step 6: Record changes in every projection write**

In `apps/news-api/src/projections.ts`, import `{ CATEGORY_CHANGE_KIND, recordChanges } from "./changes"`, then:

- `applyRelease`: a refused legacy write has already returned inside the `if (origin === "legacy")` branch, so it records nothing. Make the end of the function:
  ```ts
    if (opts.notify !== false) await notifyUpdate(tx, "PostUpdate", [key]);
    await recordChanges(tx, [{ kind: "post.upserted", key }]);
    return { skippedEventOwned: false };
  ```
- `unpublishRelease`:
  ```ts
  export async function unpublishRelease(tx: Tx, key: string): Promise<void> {
    const rows = await tx
      .update(posts)
      .set({ isPublished: false })
      .where(sql`lower(${posts.key}) = lower(${key})`)
      .returning({ key: posts.key });
    if (rows.length === 0) return;
    const keys = rows.map((r) => r.key);
    await notifyUpdate(tx, "PostUpdate", keys);
    await recordChanges(tx, keys.map((k) => ({ kind: "post.unpublished" as const, key: k })));
  }
  ```
- `applyOrg`: replace the two notifies with:
  ```ts
    const ministryKeys = await withStoredParentKeys(tx, key, parents);
    await notifyUpdate(tx, "MinistryUpdate", ministryKeys);
    await notifyUpdate(tx, "MinisterUpdate", [key]);
    await recordChanges(tx, ministryKeys.map((k) => ({ kind: "ministry" as const, key: k })));
  ```
- `applyTerm`, after its `notifyUpdate`: `await recordChanges(tx, [{ kind: CATEGORY_CHANGE_KIND[kind], key }]);`
- `deactivateCategory`, after its `notifyUpdate`: `await recordChanges(tx, keys.map((k) => ({ kind: CATEGORY_CHANGE_KIND[kind], key: k })));`
- `applySiteContent`, after each case's `notifyUpdate` and before its `return`:
  - `home`: `await recordChanges(tx, [{ kind: "home", key: null }]);`
  - `categoryFeatures`: resolve the key once and reuse it:
    ```ts
      const stored = await resolveCategoryKey(tx, c.kind, c.key);
      await notifyUpdate(tx, CATEGORY_TARGET[c.kind], [stored]);
      await recordChanges(tx, [{ kind: CATEGORY_CHANGE_KIND[c.kind], key: stored }]);
    ```
  - `slides`: `await recordChanges(tx, [{ kind: "slides", key: null }]);`
  - `resourceLinks`: `await recordChanges(tx, [{ kind: "resource_links", key: null }]);`

- [ ] **Step 7: The importer's unpublish-missing step in one transaction**

In `apps/news-api/src/import/run.ts`, import `{ recordChanges } from "../changes"` and replace the `const { rows } = await db.execute<{ key: string }>(sql\`UPDATE posts …\`); result.unpublished = rows.length;` lines with:

```ts
      // One transaction: the unpublish and its change rows commit together. Keys travel as one
      // JSON parameter, never one bind parameter each.
      const unpublished = await db.transaction(async (tx) => {
        const { rows } = await tx.execute<{ key: string }>(sql`
          UPDATE posts SET is_published = false
          WHERE is_published
            AND origin = 'legacy'
            AND lower(key) NOT IN (SELECT lower(value) FROM jsonb_array_elements_text(${JSON.stringify(importedKeys)}::jsonb))
          RETURNING key`);
        const keys = rows.map((r) => r.key);
        await recordChanges(tx, keys.map((key) => ({ kind: "post.unpublished" as const, key })));
        return keys;
      });
      result.unpublished = unpublished.length;
      log(`[import] unpublished ${unpublished.length} post(s) no longer published in legacy`);
```

Keep the comment block above it.

- [ ] **Step 8: The route, its auth, and the app wiring**

Create `apps/news-api/src/http/v2/changes-auth.ts`:

```ts
import { authFromEnv, type BearerOptions } from "@gcpe/auth";

/**
 * Bearer options for `GET /api/v2/changes`, or null when this News API has no way to verify a
 * token (the route then answers 503). Entra counts only when both ENTRA_TENANT_ID and
 * AUTH_AUDIENCE are set: on the stack ENTRA_TENANT_ID is shared by every app, but the News API
 * has no audience of its own unless NEWSAPI_AUTH_AUDIENCE is set. The session secret is never
 * passed: a staff cookie must not open a service feed.
 */
export function changesBearerFromEnv(env: NodeJS.ProcessEnv): BearerOptions | null {
  const entra = Boolean(env.ENTRA_TENANT_ID && env.AUTH_AUDIENCE);
  const local = env.LOCAL_ADMIN_ENABLED === "true";
  if (!entra && !local) return null;
  const view: NodeJS.ProcessEnv = { ...env, SESSION_SECRET: undefined };
  if (!entra) {
    view.ENTRA_TENANT_ID = undefined;
    view.AUTH_AUDIENCE = undefined;
  }
  const { bearer } = authFromEnv(view);
  return { issuer: bearer.issuer, audience: bearer.audience, keys: bearer.keys, local: bearer.local };
}
```

Create `apps/news-api/src/http/v2/changes.ts`:

```ts
import express from "express";
import { NEWS_API_CHANGES_ROLE, requireAnyRole, requireBearer, type BearerOptions } from "@gcpe/auth";
import type { Db } from "@gcpe/db-kit";
import { CHANGES_DEFAULT_LIMIT, CHANGES_MAX_LIMIT, readChanges } from "../../changes";
import { formatOffsetDateTime } from "../../time";

export interface ChangesRouteOptions {
  db: Db;
  timeZone: string;
  /** null: no token can be verified here, so the feed answers 503. */
  bearer: BearerOptions | null;
}

export type ParsedChangesQuery = { ok: true; after: number; limit: number } | { ok: false; parameter: string; message: string };

export function parseChangesQuery(raw: Record<string, unknown>): ParsedChangesQuery {
  for (const name of ["after", "limit"]) {
    if (raw[name] !== undefined && typeof raw[name] !== "string") return { ok: false, parameter: name, message: `${name} must be given once` };
  }
  const after = raw.after as string | undefined;
  const limit = raw.limit as string | undefined;
  if (after !== undefined && !/^\d{1,15}$/.test(after)) return { ok: false, parameter: "after", message: "after must be a change id (a whole number)" };
  if (limit !== undefined && !(/^\d{1,3}$/.test(limit) && Number(limit) >= 1 && Number(limit) <= CHANGES_MAX_LIMIT)) {
    return { ok: false, parameter: "limit", message: `limit must be a whole number from 1 to ${CHANGES_MAX_LIMIT}` };
  }
  return { ok: true, after: after === undefined ? 0 : Number(after), limit: limit === undefined ? CHANGES_DEFAULT_LIMIT : Number(limit) };
}

/** `GET /changes` (spec §5.4): for the site builder's service token, or an operator's Core.Admin token. */
export function changesRoutes(o: ChangesRouteOptions): express.Router {
  const r = express.Router();
  if (!o.bearer) {
    r.get("/changes", (_req, res) => void res.status(503).json({ error: "changes feed not configured" }));
    return r;
  }
  r.get("/changes", requireBearer(o.bearer), requireAnyRole(NEWS_API_CHANGES_ROLE, "Core.Admin"), async (req, res) => {
    const parsed = parseChangesQuery(req.query as Record<string, unknown>);
    if (!parsed.ok) {
      return void res.status(400).json({ error: { code: "InvalidParameter", parameter: parsed.parameter, message: parsed.message } });
    }
    const page = await readChanges(o.db, parsed.after, parsed.limit);
    if (page.resync) return void res.status(410).json({ resync: true, next: page.next });
    res.json({
      changes: page.changes.map((c) => ({ id: c.id, kind: c.kind, key: c.key, at: formatOffsetDateTime(c.at, o.timeZone) })),
      next: page.next,
    });
  });
  return r;
}
```

In `apps/news-api/src/http/v2/routes.ts`: change the signature to `export function v2Routes(deps: { search?: SearchService; changes?: ChangesRouteOptions }): express.Router`, import `{ changesRoutes, type ChangesRouteOptions } from "./changes"`, and mount `if (deps.changes) r.use(changesRoutes(deps.changes));` after the search block, before the 404.

In `apps/news-api/src/app.ts`: add to `AppDeps`:

```ts
  /** `GET /api/v2/changes`. Absent (most tests): that path answers v2's 404. */
  changes?: ChangesRouteOptions;
```

and mount `app.use("/api/v2", v2Routes({ search: deps.search, changes: deps.changes }));`.

- [ ] **Step 9: Pruning on tick, and the standalone loop**

Create `apps/news-api/src/loop.ts`:

```ts
import { safeErrorLabel } from "@gcpe/http-kit";

/** Runs `fn` every `intervalMs`, never two at once; a failure is logged as the label and a safe label. */
export function every(intervalMs: number, label: string, fn: () => Promise<unknown>): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    fn()
      .catch((e) => console.error(`[news-api] ${label} failed ${safeErrorLabel(e)}`))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
```

In `apps/news-api/src/start.ts`:
- import `{ pruneChanges } from "./changes"`, `{ every } from "./loop"`, `{ changesBearerFromEnv } from "./http/v2/changes-auth"`;
- pass `changes: { db, timeZone: tenant.timeZone, bearer: changesBearerFromEnv(env) },` to `createApp`;
- add `changesPrune: () => pruneChanges(db),` to `workers`;
- declare `const stopLoops: Array<() => void> = [];` next to `stopDispatcher`; in `startLoops()` add `stopLoops.push(every(60_000, "changes prune", () => pruneChanges(db)));`;
- add `{ name: "background loops", close: async () => { for (const stop of stopLoops.splice(0)) stop(); } },` to `closers`, just before `"event dispatcher"`.

In `apps/stack/src/stack.ts`, after the `news-api.dispatch` step:

```ts
        // Deletes change-feed rows older than 90 days (spec §5.4); cheap when there are none.
        { name: "news-api.changes-prune", run: worker(newsApi, "changesPrune") },
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/news-api packages/auth apps/stack/src/stack.test.ts apps/stack/src/tick.test.ts`
Expected: PASS, the v1 suites unedited and green.

Type-check: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`. Expected: exit 0.

- [ ] **Step 11: Runbook and running notes**

Append to `## Semantic search, related posts and the change feed (Phase 6b)` in `docs/deploy/siteground.md`:

````markdown
### The change feed

`GET /api/v2/changes?after=<id>&limit=<1-500>` lists what changed in the News API, oldest first, for the public site's builder (6c). Every post write, unpublish, ministry, sector, theme and tag change, and every home, slides and resource-links change adds one row, in the same transaction as the change itself.

- **Access:** a bearer token with the `NewsApi.ChangesRead` service role, or an operator's `Core.Admin` token. Staff sign-in cookies don't work here. With no Entra audience (`NEWSAPI_AUTH_AUDIENCE` with `ENTRA_TENANT_ID`) and no local admin, the route answers `503 changes feed not configured`. On boxs.ca local admin is on, so it works with a local token.
- **Reading it:** start with `after=0`; each response has `next`, the `after` to send next time. A response with `"changes": []` means nothing new.
- **Retention:** rows older than 90 days are deleted on every `/stack/tick` (the `news-api.changes-prune` step). A cursor older than that gets `410` with `{ "resync": true, "next": <id> }`: rebuild everything, then continue from `next`.
- **Volume:** a full legacy import writes one row per release it applies (Q78), about 100,000 rows. They are pruned after 90 days like any other.

**Hand check on boxs.ca:** `curl -si https://boxs.ca/api/v2/changes` is a `401` with `cache-control: no-store`.
````

Append to the Phase 6b list in `docs/manuals/running-notes.md`:

```markdown
- **Operations** — The News API keeps a change feed, `GET /api/v2/changes`, for the public site's builder: one row per change to a post, a ministry, sector, theme or tag, home, slides or resource links. It needs a service token (role `NewsApi.ChangesRead`) or a `Core.Admin` token, answers `503` where the News API can verify neither, and keeps 90 days. An older cursor gets `410 { "resync": true, "next": … }`.
- **Developer** — Every projection write calls `recordChanges(tx, …)` (`src/changes.ts`) in its own transaction, as does the legacy importer's unpublish step. `recordChanges` takes one advisory lock (`[0x67637065, 4]`) before inserting, so change ids commit in order and a reader's cursor can't skip a late commit; it must stay the last lock a projection transaction takes. `410` is decided by `change_feed_state.pruned_through`, not `min(id)`, because rolled-back inserts leave gaps.
```

- [ ] **Step 12: Commit**

```bash
git add apps/news-api packages/auth apps/stack/src/stack.ts docs/deploy/siteground.md docs/manuals/running-notes.md
git commit -m "feat(news-api): change feed written with every projection write, pruning, and GET /api/v2/changes"
```

---

### Task 3: The embedding worker, related posts, and unpublish cleanup

**Review:** full (the worker's unpublish cleanup).

**Files:**
- Create: `apps/news-api/src/embeddings/source-text.ts`, `source-text.test.ts`
- Create: `apps/news-api/src/embeddings/rows.ts`
- Create: `apps/news-api/src/embeddings/worker.ts`, `worker.test.ts`
- Modify: `apps/news-api/src/projections.ts` (`applyRelease` writes the hash; `unpublishRelease` cleans up), `apps/news-api/src/projections.test.ts`
- Modify: `apps/news-api/src/import/run.ts` (cleanup in the unpublish transaction), `apps/news-api/src/import/run.test.ts`
- Modify: `apps/news-api/src/cli/search-backfill.ts` (writes the hash), `apps/news-api/src/cli/search-backfill.test.ts`
- Modify: `apps/news-api/src/start.ts` (the worker's embedder, `workers.embed`, the loop)
- Modify: `apps/stack/src/stack.ts` (tick step)
- Docs: `docs/deploy/siteground.md`, `docs/manuals/running-notes.md`

**Interfaces:**
- Consumes (Task 1): `postEmbeddings`, `postRelated`, `posts.embeddingTextHash`; `VECTOR_DIMENSIONS`; `AppHandle.searchMode`; `writeTenantConfig`, `closeHandle`, `createNewsTestDb` from `test/helpers.ts`.
- Consumes (Task 2): `recordChanges`; `every`; the `stopLoops` array in `start.ts`; the importer's unpublish transaction.
- Consumes (6a): `createGuardedEmbedder({ provider, breaker?, log? }): GuardedEmbedder` (`.provider`, `.breaker.state`, `.embed(texts, signal?)`), `CircuitBreaker`, `BreakerOpenError`, `standInProvider`, `STAND_IN_MODEL`, `createEmbeddingProvider` from `@gcpe/embeddings`; `searchTextFor` from `src/search/search-text.ts`.
- Produces:
  - `source-text.ts`: `EMBEDDING_SOURCE_MAX_CHARS = 8000`; `embeddingSourceText(searchText: string): string`; `embeddingTextHash(searchText: string): string` (SHA-256 hex of the source text).
  - `rows.ts`: `deleteSemanticRows(tx: Tx, keys: string[]): Promise<void>` (stored keys; one JSON parameter).
  - `worker.ts`: `EMBEDDING_BATCH_SIZE = 50`; `RELATED_LIMIT = 5`; `WORKER_EMBED_TIMEOUT_MS = 5000`; `interface EmbeddingTickResult { embedded: number; rehashed: number; related: number; skipped: "breaker-open" | "provider-failed" | null }`; `runEmbeddingTick(o: { db: Db; embedder: GuardedEmbedder; batchSize?: number; log?: (line: string) => void }): Promise<EmbeddingTickResult>`.
  - `AppHandle.workers.embed` (resolves `null` in text mode); the stack tick step `news-api.embed`.
  - Invariant later tasks rely on: **every `post_embeddings` row belongs to a published post.**

- [ ] **Step 1: Write the failing unit tests**

Create `apps/news-api/src/embeddings/source-text.test.ts`:

```ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EMBEDDING_SOURCE_MAX_CHARS, embeddingSourceText, embeddingTextHash } from "./source-text";

describe("embedding source text (spec §5.2)", () => {
  it("is the search text itself up to 8,000 characters", () => {
    const text = "a".repeat(EMBEDDING_SOURCE_MAX_CHARS);
    expect(embeddingSourceText(text)).toBe(text);
  });

  it("keeps the first 8,000 code points, never half a surrogate pair", () => {
    expect(embeddingSourceText("a".repeat(8001))).toBe("a".repeat(8000));
    const astral = "a".repeat(7999) + "😀😀";
    expect(embeddingSourceText(astral)).toBe("a".repeat(7999) + "😀");
  });

  it("hashes the source text with SHA-256, so text past 8,000 characters doesn't change it", () => {
    const base = "b".repeat(8000);
    expect(embeddingTextHash(base)).toBe(createHash("sha256").update(base, "utf8").digest("hex"));
    expect(embeddingTextHash(base + "more")).toBe(embeddingTextHash(base));
    expect(embeddingTextHash("c" + base.slice(1))).not.toBe(embeddingTextHash(base));
  });
});
```

In `apps/news-api/src/projections.test.ts`, add (import `embeddingTextHash` from `"./embeddings/source-text"`):

```ts
  it("writes posts.embedding_text_hash from the search text on every post write", async () => {
    const r = { ...sampleRelease, key: "R-HASH" };
    await tdb.db.transaction((tx) => applyRelease(tx, r));
    const [row] = await tdb.db.select({ h: posts.embeddingTextHash }).from(posts).where(eq(posts.key, "R-HASH"));
    expect(row?.h).toBe(embeddingTextHash(searchTextFor(r)));
  });
```

In `apps/news-api/src/cli/search-backfill.test.ts`, add (import `embeddingTextHash` from `"../embeddings/source-text"`):

```ts
  it("--confirm writes embedding_text_hash with search_text", async () => {
    await tdb.pool.query("UPDATE posts SET embedding_text_hash = NULL");
    await searchBackfill(tdb.db, { confirm: true, all: false });
    const [row] = await tdb.db.select({ t: posts.searchText, h: posts.embeddingTextHash }).from(posts).where(eq(posts.key, "a-1"));
    expect(row?.h).toBe(embeddingTextHash(row!.t!));
  });
```

- [ ] **Step 2: Write the failing worker tests**

Create `apps/news-api/src/embeddings/worker.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createGuardedEmbedder, EmbeddingError, standInProvider, STAND_IN_MODEL, type EmbeddingProvider } from "@gcpe/embeddings";
import type { ReleaseRecord } from "@gcpe/events";
import { sampleRelease } from "@gcpe/events/testing";
import { closeHandle, createNewsTestDb, EVENT_SECRETS, writeTenantConfig } from "../../test/helpers";
import { applyRelease, unpublishRelease } from "../projections";
import { searchTextFor } from "../search/search-text";
import { startNewsApi } from "../start";
import { deleteSemanticRows } from "./rows";
import { embeddingTextHash } from "./source-text";
import { runEmbeddingTick } from "./worker";

function release(key: string, headline: string, publishDate = "2026-10-01T10:00:00-07:00", body = ""): ReleaseRecord {
  return {
    ...sampleRelease,
    key,
    reference: null,
    summary: null,
    keywords: null,
    location: null,
    publishDate,
    documents: [{ ...sampleRelease.documents[0]!, headline, subheadline: "", detailsHtml: body ? `<p>${body}</p>` : "" }],
  };
}

function spy(base: EmbeddingProvider = standInProvider()) {
  const calls: string[][] = [];
  const provider: EmbeddingProvider = {
    id: base.id,
    model: base.model,
    dimensions: base.dimensions,
    async embed(texts, signal) {
      calls.push(texts);
      return base.embed(texts, signal);
    },
  };
  return { provider, calls, embedder: createGuardedEmbedder({ provider, log: () => {} }) };
}

describe("runEmbeddingTick (spec §5.2)", () => {
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
  const seed = async (...rs: ReleaseRecord[]) => {
    for (const r of rs) await tdb.db.transaction((tx) => applyRelease(tx, r, { notify: false }));
  };
  const embedded = async () => (await tdb.pool.query<{ post_key: string }>("SELECT post_key FROM post_embeddings ORDER BY post_key")).rows.map((r) => r.post_key);
  const relatedOf = async (key: string) =>
    (await tdb.pool.query<{ related_keys: string[] }>("SELECT related_keys FROM post_related WHERE post_key = $1", [key])).rows[0]?.related_keys;

  it("embeds published posts newest first, in batches, and never an unpublished one", async () => {
    await seed(release("A", "alpha", "2026-10-01T10:00:00-07:00"), release("B", "beta", "2026-10-02T10:00:00-07:00"), release("C", "gamma", "2026-10-03T10:00:00-07:00"), release("D", "delta", "2026-10-04T10:00:00-07:00"));
    await tdb.db.transaction((tx) => unpublishRelease(tx, "D"));
    const s = spy();
    expect(await runEmbeddingTick({ db: tdb.db, embedder: s.embedder, batchSize: 2 })).toMatchObject({ embedded: 2, skipped: null });
    expect(await embedded()).toEqual(["B", "C"]);
    expect(await runEmbeddingTick({ db: tdb.db, embedder: s.embedder, batchSize: 2 })).toMatchObject({ embedded: 1 });
    expect(await embedded()).toEqual(["A", "B", "C"]);
    expect(await runEmbeddingTick({ db: tdb.db, embedder: s.embedder, batchSize: 2 })).toEqual({ embedded: 0, rehashed: 0, related: 0, skipped: null });
    expect(s.calls.map((c) => c.length)).toEqual([2, 1]);
  });

  it("stores the provider, model, dimensions and text hash, and the post's own hash", async () => {
    const r = release("A", "salmon habitat");
    await seed(r);
    await runEmbeddingTick({ db: tdb.db, embedder: spy().embedder });
    const { rows } = await tdb.pool.query("SELECT provider, model, dimensions, text_hash, array_length(embedding, 1) AS n FROM post_embeddings");
    const hash = embeddingTextHash(searchTextFor(r));
    expect(rows).toEqual([{ provider: "stand-in", model: STAND_IN_MODEL, dimensions: 1536, text_hash: hash, n: 1536 }]);
    expect((await tdb.pool.query("SELECT embedding_text_hash FROM posts")).rows).toEqual([{ embedding_text_hash: hash }]);
  });

  it("re-embeds a post whose text changed, and leaves the others alone", async () => {
    await seed(release("A", "alpha"), release("B", "beta"));
    const s = spy();
    await runEmbeddingTick({ db: tdb.db, embedder: s.embedder });
    await seed(release("A", "alpha", undefined, "now with a body"));
    expect(await runEmbeddingTick({ db: tdb.db, embedder: s.embedder })).toMatchObject({ embedded: 1 });
    expect(s.calls[1]).toEqual(["alpha now with a body"]);
  });

  it("re-embeds every post when the provider's model changes", async () => {
    await seed(release("A", "alpha"), release("B", "beta"));
    await runEmbeddingTick({ db: tdb.db, embedder: spy().embedder });
    const next = spy({ ...standInProvider(), model: "stand-in-sha256-v2", embed: standInProvider().embed });
    expect(await runEmbeddingTick({ db: tdb.db, embedder: next.embedder })).toMatchObject({ embedded: 2 });
  });

  it("only rehashes a post written before 6b whose embedding is current, without calling the provider", async () => {
    await seed(release("A", "alpha"));
    const s = spy();
    await runEmbeddingTick({ db: tdb.db, embedder: s.embedder });
    await tdb.pool.query("UPDATE posts SET embedding_text_hash = NULL");
    expect(await runEmbeddingTick({ db: tdb.db, embedder: s.embedder })).toEqual({ embedded: 0, rehashed: 1, related: 0, skipped: null });
    expect(s.calls).toHaveLength(1);
    expect((await tdb.pool.query("SELECT embedding_text_hash IS NOT NULL AS ok FROM posts")).rows).toEqual([{ ok: true }]);
  });

  it("stops for the tick, without calling the provider, while the breaker is open", async () => {
    await seed(release("A", "alpha"));
    let calls = 0;
    const failing: EmbeddingProvider = { id: "failing", model: "m", dimensions: 1536, async embed() { calls++; throw new EmbeddingError("embedding_http_503"); } };
    const embedder = createGuardedEmbedder({ provider: failing, log: () => {} });
    for (let i = 0; i < 3; i++) expect(await runEmbeddingTick({ db: tdb.db, embedder })).toMatchObject({ skipped: "provider-failed" });
    expect(await runEmbeddingTick({ db: tdb.db, embedder })).toMatchObject({ skipped: "breaker-open" });
    expect(calls).toBe(3);
    expect(await embedded()).toEqual([]);
  });

  it("computes the 5 nearest published neighbours, nearest first, excluding the post itself", async () => {
    await seed(
      release("P0", "salmon river habitat"),
      release("P1", "salmon river habitat work"),
      release("P2", "salmon river"),
      release("P3", "salmon"),
      release("P4", "budget forecast"),
      release("P5", "school bus routes"),
      release("P6", "hospital beds"),
    );
    expect(await runEmbeddingTick({ db: tdb.db, embedder: spy().embedder })).toMatchObject({ embedded: 7, related: 7 });
    const related = await relatedOf("P0");
    expect(related).toHaveLength(5);
    expect(related!.slice(0, 3)).toEqual(["P1", "P2", "P3"]);
    expect(related).not.toContain("P0");
  });

  it("a post unpublished during the provider call gets no embedding or related row", async () => {
    await seed(release("RACE", "alpha"), release("KEEP", "beta"));
    const base = standInProvider();
    const racing: EmbeddingProvider = {
      ...base,
      async embed(texts, signal) {
        await tdb.db.transaction((tx) => unpublishRelease(tx, "RACE"));
        return base.embed(texts, signal);
      },
    };
    await runEmbeddingTick({ db: tdb.db, embedder: createGuardedEmbedder({ provider: racing, log: () => {} }) });
    expect(await embedded()).toEqual(["KEEP"]);
    expect(await relatedOf("RACE")).toBeUndefined();
  });

  it("a post rewritten during the provider call is left for the next tick, which embeds the new text", async () => {
    await seed(release("A", "alpha"));
    const base = standInProvider();
    let rewrite = true;
    const rewriting: EmbeddingProvider = {
      ...base,
      async embed(texts, signal) {
        if (rewrite) {
          rewrite = false;
          await tdb.db.transaction((tx) => applyRelease(tx, release("A", "alpha rewritten"), { notify: false }));
        }
        return base.embed(texts, signal);
      },
    };
    const embedder = createGuardedEmbedder({ provider: rewriting, log: () => {} });
    expect(await runEmbeddingTick({ db: tdb.db, embedder })).toMatchObject({ embedded: 0 });
    expect(await runEmbeddingTick({ db: tdb.db, embedder })).toMatchObject({ embedded: 1 });
    const { rows } = await tdb.pool.query("SELECT text_hash FROM post_embeddings");
    expect(rows).toEqual([{ text_hash: embeddingTextHash("alpha rewritten") }]);
  });

  it("unpublishing deletes the post's embedding and related row in the same transaction", async () => {
    await seed(release("A", "alpha"), release("B", "beta"));
    await runEmbeddingTick({ db: tdb.db, embedder: spy().embedder });
    await expect(
      tdb.db.transaction(async (tx) => {
        await unpublishRelease(tx, "a");
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await embedded()).toEqual(["A", "B"]);
    expect(await relatedOf("A")).toEqual(["B"]);
    await tdb.db.transaction((tx) => unpublishRelease(tx, "a"));
    expect(await embedded()).toEqual(["B"]);
    expect(await relatedOf("A")).toBeUndefined();
    expect(await relatedOf("B")).toEqual(["A"]);
  });

  it("deleteSemanticRows takes 70,000 keys in one call", async () => {
    const keys = Array.from({ length: 70_000 }, (_, i) => `K-${i}`);
    await expect(tdb.db.transaction((tx) => deleteSemanticRows(tx, keys))).resolves.toBeUndefined();
  });
});

describe("startNewsApi's embedding worker", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  it.each([
    [true, 1],
    [false, 0],
  ])("with semanticSearch %s, workers.embed embeds %i post(s)", async (flag, count) => {
    const tdb = await createNewsTestDb();
    cleanups.push(() => tdb.drop());
    const handle = await startNewsApi(
      {
        DATABASE_URL: tdb.url,
        EVENT_SECRETS: JSON.stringify(EVENT_SECRETS),
        TENANT_CONFIG: writeTenantConfig({ features: { semanticSearch: flag, staffAi: false } }),
        EMBEDDINGS_PROVIDER: "stand-in",
      },
      { hub: false },
    );
    cleanups.push(() => closeHandle(handle));
    await tdb.db.transaction((tx) => applyRelease(tx, release("A", "alpha"), { notify: false }));
    await handle.workers.embed!();
    expect((await tdb.pool.query("SELECT count(*)::int AS n FROM post_embeddings")).rows[0].n).toBe(count);
    expect((await request(handle.app).get("/health/live")).status).toBe(200);
  });
});
```

`"alpha now with a body"`: `searchTextFor` joins the headline and the stripped body with one space (6a's `search-text.ts`), and `normaliseForEmbedding` isn't applied to stored source text. If `searchTextFor`'s output for that record differs, assert against `embeddingSourceText(searchTextFor(release("A", "alpha", undefined, "now with a body")))` instead; the point is that only A is sent.

In `apps/news-api/src/import/run.test.ts`, in the unpublish-missing `describe`, add:

```ts
  it("deletes the embeddings and related rows of the posts it unpublishes, in the same transaction", async () => {
    await tdb.pool.query(`
      INSERT INTO post_embeddings (post_key, provider, model, dimensions, text_hash, embedding)
      VALUES ('STALE-1', 'stand-in', 'm', 1536, 'h', array_fill(0.5::real, ARRAY[1536]))`);
    await tdb.pool.query("INSERT INTO post_related (post_key, related_keys) VALUES ('STALE-1', '{}')");
    await importLegacyNews(tdb.db, source);
    expect((await tdb.pool.query("SELECT 1 FROM post_embeddings WHERE post_key = 'STALE-1'")).rows).toEqual([]);
    expect((await tdb.pool.query("SELECT 1 FROM post_related WHERE post_key = 'STALE-1'")).rows).toEqual([]);
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/news-api/src/embeddings apps/news-api/src/projections.test.ts apps/news-api/src/cli/search-backfill.test.ts apps/news-api/src/import/run.test.ts`
Expected: FAIL. `./source-text`, `./rows` and `./worker` don't exist; the hash is `NULL`; the importer leaves the rows.

- [ ] **Step 4: Source text, the hash on every write, and cleanup**

Create `apps/news-api/src/embeddings/source-text.ts`:

```ts
import { createHash } from "node:crypto";

export const EMBEDDING_SOURCE_MAX_CHARS = 8000;

/**
 * Spec §5.2's source text: the first 8,000 characters (code points) of posts.search_text, which
 * already holds the headlines, summary, keywords, location, subheadlines and bodies, HTML-free.
 */
export function embeddingSourceText(searchText: string): string {
  if (searchText.length <= EMBEDDING_SOURCE_MAX_CHARS) return searchText;
  return Array.from(searchText).slice(0, EMBEDDING_SOURCE_MAX_CHARS).join("");
}

/** post_embeddings.text_hash and posts.embedding_text_hash: SHA-256 (hex) of the source text. */
export function embeddingTextHash(searchText: string): string {
  return createHash("sha256").update(embeddingSourceText(searchText), "utf8").digest("hex");
}
```

Create `apps/news-api/src/embeddings/rows.ts`:

```ts
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
```

In `apps/news-api/src/projections.ts`:
- import `{ embeddingTextHash } from "./embeddings/source-text"` and `{ deleteSemanticRows } from "./embeddings/rows"`;
- in `applyRelease`, compute `const searchText = searchTextFor(r);` before `values`, and set `searchText,` and `embeddingTextHash: embeddingTextHash(searchText),` in `values`;
- in `unpublishRelease`, after `const keys = …`: `await deleteSemanticRows(tx, keys);` (before `notifyUpdate`; `recordChanges` stays last).

In `apps/news-api/src/import/run.ts`, inside the unpublish transaction from Task 2, after `const keys = rows.map(…)`: `await deleteSemanticRows(tx, keys);` (import it from `"../embeddings/rows"`).

In `apps/news-api/src/cli/search-backfill.ts` (import `embeddingTextHash` from `"../embeddings/source-text"`):

```ts
        const values = rows.map((r) => {
          const text = searchTextFor(r);
          return { key: r.key, text, hash: embeddingTextHash(text) };
        });
        await tx.execute(sql`
          UPDATE posts SET search_text = v.text, embedding_text_hash = v.hash
          FROM jsonb_to_recordset(${JSON.stringify(values)}::jsonb) AS v(key text, text text, hash text)
          WHERE posts.key = v.key`);
```

- [ ] **Step 5: Write the worker**

Create `apps/news-api/src/embeddings/worker.ts`:

```ts
import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { BreakerOpenError, type GuardedEmbedder } from "@gcpe/embeddings";
import { postEmbeddings, posts } from "../db/schema";
import { VECTOR_DIMENSIONS } from "./pgvector";
import { embeddingSourceText, embeddingTextHash } from "./source-text";

export const EMBEDDING_BATCH_SIZE = 50;
export const RELATED_LIMIT = 5;
/** The worker's own provider timeout: spec §4's ceiling, since a batch is up to 50 long texts. */
export const WORKER_EMBED_TIMEOUT_MS = 5000;

export interface EmbeddingTickResult {
  embedded: number;
  rehashed: number;
  related: number;
  skipped: "breaker-open" | "provider-failed" | null;
}

interface Candidate {
  key: string;
  searchText: string;
  postHash: string | null;
  embeddedHash: string | null;
  provider: string | null;
  model: string | null;
  dimensions: number | null;
}

/**
 * One tick of spec §5.2's worker: up to `batchSize` published posts with no embedding, or whose
 * text hash, provider, model or dimensions differ, newest first; one provider call; then each
 * post's related list. Only for semantic mode (the caller decides). Drafts never reach the News
 * API, and unpublished posts are never selected, so post_embeddings holds published posts only.
 */
export async function runEmbeddingTick(o: { db: Db; embedder: GuardedEmbedder; batchSize?: number; log?: (line: string) => void }): Promise<EmbeddingTickResult> {
  const { provider, breaker } = o.embedder;
  const log = o.log ?? ((line: string) => console.error(line));
  const none = { embedded: 0, rehashed: 0, related: 0 };
  if (breaker.state === "open") return { ...none, skipped: "breaker-open" };

  const { rows } = await o.db.execute<Candidate>(sql`
    SELECT p.key, p.search_text AS "searchText", p.embedding_text_hash AS "postHash",
           e.text_hash AS "embeddedHash", e.provider, e.model, e.dimensions
    FROM posts p LEFT JOIN post_embeddings e ON e.post_key = p.key
    WHERE p.is_published AND p.search_text IS NOT NULL AND p.search_text <> ''
      AND (e.post_key IS NULL OR p.embedding_text_hash IS NULL OR e.text_hash <> p.embedding_text_hash
           OR e.provider <> ${provider.id} OR e.model <> ${provider.model} OR e.dimensions <> ${provider.dimensions})
    ORDER BY p.publish_date DESC, p.key COLLATE "C" DESC
    LIMIT ${o.batchSize ?? EMBEDDING_BATCH_SIZE}`);
  if (rows.length === 0) return { ...none, skipped: null };

  const work = rows.map((r) => ({ ...r, source: embeddingSourceText(r.searchText), hash: embeddingTextHash(r.searchText) }));
  const current = (w: (typeof work)[number]) =>
    w.embeddedHash === w.hash && w.provider === provider.id && w.model === provider.model && w.dimensions === provider.dimensions;
  const toEmbed = work.filter((w) => !current(w));

  let vectors: number[][] = [];
  if (toEmbed.length > 0) {
    try {
      vectors = await o.embedder.embed(toEmbed.map((w) => w.source));
    } catch (e) {
      // The guarded embedder logged a real provider failure, once, without the texts.
      return { ...none, skipped: e instanceof BreakerOpenError ? "breaker-open" : "provider-failed" };
    }
    if (vectors.length !== toEmbed.length || vectors.some((v) => v.length !== VECTOR_DIMENSIONS)) {
      log(`[news-api] embedding batch from ${provider.id} had the wrong shape; skipped`);
      return { ...none, skipped: "provider-failed" };
    }
  }

  const written = await o.db.transaction(async (tx) => {
    // Lock the posts first, as an unpublish does, then re-check: a post unpublished or rewritten
    // while the provider was working is left for the next tick, never given a stale vector.
    const locked = await tx
      .select({ key: posts.key, isPublished: posts.isPublished, searchText: posts.searchText })
      .from(posts)
      .where(inArray(posts.key, work.map((w) => w.key)))
      .for("update");
    const byKey = new Map(locked.map((r) => [r.key, r]));
    const fresh = (w: (typeof work)[number]) => {
      const r = byKey.get(w.key);
      return !!r && r.isPublished && r.searchText !== null && embeddingTextHash(r.searchText) === w.hash;
    };
    const keys: string[] = [];
    for (const [i, w] of toEmbed.entries()) {
      if (!fresh(w)) continue;
      const values = { postKey: w.key, provider: provider.id, model: provider.model, dimensions: provider.dimensions, textHash: w.hash, embedding: vectors[i]! };
      await tx.insert(postEmbeddings).values(values).onConflictDoUpdate({ target: postEmbeddings.postKey, set: { ...values, embeddedAt: sql`now()` } });
      keys.push(w.key);
    }
    let rehashed = 0;
    for (const w of work) {
      if (!fresh(w) || w.postHash === w.hash) continue;
      await tx.update(posts).set({ embeddingTextHash: w.hash }).where(eq(posts.key, w.key));
      if (current(w)) rehashed++;
    }
    return { keys, rehashed };
  });

  let related = 0;
  for (const key of written.keys) if (await computeRelated(o.db, key)) related++;
  return { embedded: written.keys.length, rehashed: written.rehashed, related, skipped: null };
}

/**
 * post_related for `key`: the RELATED_LIMIT nearest other embeddings (all published, see above),
 * served by the HNSW index where it exists. The post row is share-locked and re-checked, so an
 * unpublish can't slip between the check and the write.
 */
async function computeRelated(db: Db, key: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [post] = await tx.select({ isPublished: posts.isPublished }).from(posts).where(eq(posts.key, key)).for("share");
    if (!post?.isPublished) return false;
    const target = sql`(SELECT embedding::vector(1536) FROM post_embeddings WHERE post_key = ${key}::text)`;
    const { rowCount } = await tx.execute(sql`
      INSERT INTO post_related (post_key, related_keys, computed_at)
      SELECT ${key}::text, coalesce(array_agg(n.post_key ORDER BY n.distance, n.post_key), '{}'), now()
      FROM (
        SELECT post_key, (embedding::vector(1536)) <=> ${target} AS distance
        FROM post_embeddings
        WHERE post_key <> ${key}::text
        ORDER BY (embedding::vector(1536)) <=> ${target}
        LIMIT ${RELATED_LIMIT}
      ) n
      WHERE EXISTS (SELECT 1 FROM post_embeddings WHERE post_key = ${key}::text)
      ON CONFLICT (post_key) DO UPDATE SET related_keys = excluded.related_keys, computed_at = excluded.computed_at`);
    return (rowCount ?? 0) > 0;
  });
}
```

The neighbour query's shape (`ORDER BY expr <=> (SELECT …) LIMIT 5` with `post_key <> …`) was checked while planning: on 20,000 vectors Postgres used `post_embeddings_embedding_hnsw_idx`, about 2 ms warm.

- [ ] **Step 6: Wire it into the News API and the tick**

In `apps/news-api/src/start.ts` (import `CircuitBreaker`, `createGuardedEmbedder` from `@gcpe/embeddings`, and `runEmbeddingTick`, `WORKER_EMBED_TIMEOUT_MS` from `./embeddings/worker`), after `searchMode` is known:

```ts
  // The worker's own provider instance (a longer timeout for a 50-post batch) and its own
  // breaker, so a slow batch never pushes visitors into text mode.
  const workerProvider = searchMode === "semantic" ? createEmbeddingProvider({ ...parsed, EMBEDDINGS_TIMEOUT_MS: WORKER_EMBED_TIMEOUT_MS }) : null;
  const workerEmbedder = workerProvider ? createGuardedEmbedder({ provider: workerProvider, breaker: new CircuitBreaker() }) : null;
  const embed = () => (workerEmbedder ? runEmbeddingTick({ db, embedder: workerEmbedder }) : Promise.resolve(null));
```

Add `embed,` to `workers`, and in `startLoops()`: `if (workerEmbedder) stopLoops.push(every(60_000, "embedding worker", embed));`.

In `apps/stack/src/stack.ts`, before `news-api.changes-prune`:

```ts
        // Embeds up to 50 published posts and recomputes their related posts (spec §5.2). A
        // no-op unless the News API's search mode is semantic; it skips the tick while its
        // breaker is open.
        { name: "news-api.embed", run: worker(newsApi, "embed") },
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/news-api apps/stack/src/stack.test.ts`
Expected: PASS, v1 suites unedited and green.

Type-check: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`. Expected: exit 0.

- [ ] **Step 8: Runbook and running notes**

Append to the Phase 6b section of `docs/deploy/siteground.md`:

````markdown
### The embedding worker

In semantic mode, each `/stack/tick` (the `news-api.embed` step) embeds up to 50 published posts that have no embedding, or whose text, provider or model changed, newest first, in one provider call, and then recomputes each one's 5 related posts. In text mode the step does nothing.

- **Backlog:** at one tick a minute, 50 posts a tick, about 100,000 posts take about 33 hours to embed the first time. Until a post is embedded, search still finds it through the text half of a semantic search, and its related posts use the text fallback.
- **Changing provider or model** re-embeds every post, at the same pace.
- **Failures:** a provider failure is logged as `[embeddings] <provider> call failed <label>` and the posts are retried on the next tick. After three failures in a row the worker's breaker opens and the step skips its ticks for 60 seconds. Search has its own breaker, so a failing batch doesn't turn search off.
- **Unpublishing** deletes the post's embedding and related posts in the same transaction, so it disappears from semantic results and related lists at once. That includes a legacy import's unpublish step.
- **After the first 6b deploy**, the search backfill (`npm run news-api:search-backfill`) also fills each post's embedding text hash. Running it isn't required for embeddings: the worker fills missing hashes itself.
````

Append to the Phase 6b list in `docs/manuals/running-notes.md`:

```markdown
- **Operations** — In semantic mode the tick embeds up to 50 published posts a minute (about 33 hours for 100,000 posts the first time) and recomputes their related posts. Unpublishing a post removes its embedding and related posts in the same transaction. The worker has its own 5-second provider timeout and its own breaker, separate from search's.
- **Developer** — `runEmbeddingTick` (`src/embeddings/worker.ts`) keeps `post_embeddings` to published posts only: it re-reads and row-locks the posts before writing, and skips any that were unpublished or rewritten during the provider call. The embedding source text is the first 8,000 characters of `posts.search_text`; its SHA-256 is stored as `posts.embedding_text_hash` on every post write, so finding changed posts is a plain comparison. `deleteSemanticRows` (`src/embeddings/rows.ts`) runs inside every unpublish.
```

- [ ] **Step 9: Commit**

```bash
git add apps/news-api apps/stack/src/stack.ts docs/deploy/siteground.md docs/manuals/running-notes.md
git commit -m "feat(news-api): embedding worker with related posts, and unpublish removes embeddings in the same transaction"
```

---

### Task 4: Semantic mode for `GET /api/v2/search`: the query-vector cache, vector-then-text pages, quiet fallback, one snapshot, and the per-IP limit

**Review:** shared with Task 5 (review D).

**Files:**
- Create: `apps/news-api/src/search/vector-cache.ts`, `vector-cache.test.ts`
- Create: `apps/news-api/src/search/semantic.ts`, `semantic.test.ts`
- Create: `apps/news-api/src/http/client-ip.ts`
- Modify: `apps/news-api/src/search/text-search.ts`, `apps/news-api/src/search/service.ts`
- Modify: `apps/news-api/src/http/v2/routes.ts`, `apps/news-api/src/http/v2/search.test.ts`
- Modify: `apps/news-api/src/http/v1/subscribe.ts:76-83` (uses `clientIpKey`; behaviour unchanged)
- Modify: `apps/news-api/src/app.ts`, `apps/news-api/src/env.ts`, `apps/news-api/src/env.test.ts`, `apps/news-api/src/start.ts`
- Modify: `packages/embeddings/src/guarded.ts`, `packages/embeddings/src/guarded.test.ts`
- Docs: `docs/parity/open-questions.md` (Q74), `docs/deploy/siteground.md`, `docs/manuals/running-notes.md`

**Interfaces:**
- Consumes (Task 1): `postEmbeddings`, `VECTOR_DIMENSIONS`, `AppHandle.searchMode`, `writeTenantConfig`, `closeHandle`.
- Consumes (Task 3): `runEmbeddingTick({ db, embedder })` to embed test posts; the invariant that `post_embeddings` holds only published posts.
- Consumes (6a): `SearchQuery`, `SEARCH_PAGE_SIZE`, `SEARCH_MAX_PAGE` (`query.ts`); `searchFilters`, `textSearch`, `SearchRow`, `SearchPage` (`text-search.ts`); `SemanticSearch`, `createSearchService` (`service.ts`); `normaliseForEmbedding`, `createGuardedEmbedder`, `BreakerOpenError`, `standInProvider` (`@gcpe/embeddings`).
- Produces:
  - `vector-cache.ts`: `QUERY_VECTOR_TTL_MS = 300_000`; `QUERY_VECTOR_MAX_ENTRIES = 5_000`; `class QueryVectorCache { constructor(opts?: { ttlMs?: number; maxEntries?: number; now?: () => number }); readonly size: number; get(key: string): number[] | undefined; set(key: string, vector: number[]): void }`.
  - `semantic.ts`: `VECTOR_CANDIDATE_LIMIT = 1000`; `pageWindow(page: number, vectorCount: number): { vectorStart: number; vectorEnd: number; textOffset: number; textLimit: number }`; `createSemanticSearch(o: { db: Db; embedder: GuardedEmbedder; cache: QueryVectorCache; language: SearchLanguage; defaultLanguageId: number; threshold: number }): SemanticSearch`.
  - `text-search.ts`: `READ_SNAPSHOT`; `textSearch(db: DbOrTx, query, opts: TextSearchOptions & { window?: { offset: number; limit: number } })`; `searchRowColumns(defaultLanguageId: number)`; `searchRowsByKeys(db: DbOrTx, keys: string[], defaultLanguageId: number): Promise<SearchRow[]>` (published only, input order, short lists only).
  - `service.ts`: `searchResultMapper(publicSiteUrl: string, timeZone: string): (r: SearchRow) => SearchResult`.
  - `client-ip.ts`: `clientIpKey(header: string | undefined): (req: Request) => string`.
  - `v2Routes(deps: { search?: SearchService; searchRateLimit?: { perMinute: number; clientIpHeader?: string }; changes?: ChangesRouteOptions })`; `AppDeps.searchRateLimit?`.
  - env: `SEARCH_SEMANTIC_THRESHOLD` (0–2, default 0.6), `SEARCH_RATE_LIMIT_PER_MIN` (default 60).

- [ ] **Step 1: Write the failing unit tests**

Create `apps/news-api/src/search/vector-cache.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { QueryVectorCache } from "./vector-cache";

describe("QueryVectorCache (spec §5.4)", () => {
  it("keeps a vector for five minutes", () => {
    let now = 0;
    const cache = new QueryVectorCache({ now: () => now });
    cache.set("salmon", [1, 2]);
    now = 299_999;
    expect(cache.get("salmon")).toEqual([1, 2]);
    now = 300_000;
    expect(cache.get("salmon")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("drops the oldest entry first at the cap", () => {
    const cache = new QueryVectorCache({ maxEntries: 3 });
    for (const k of ["a", "b", "c", "d"]) cache.set(k, [k.charCodeAt(0)]);
    expect(cache.size).toBe(3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("d")).toEqual([100]);
  });

  it("treats a re-set entry as the newest", () => {
    const cache = new QueryVectorCache({ maxEntries: 3 });
    for (const k of ["a", "b", "c"]) cache.set(k, [1]);
    cache.set("a", [2]);
    cache.set("d", [3]);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toEqual([2]);
  });

  it("defaults to 5,000 entries", () => {
    const cache = new QueryVectorCache();
    for (let i = 0; i < 5_001; i++) cache.set(`q${i}`, [i]);
    expect(cache.size).toBe(5_000);
    expect(cache.get("q0")).toBeUndefined();
  });
});
```

Add to `packages/embeddings/src/guarded.test.ts` (follow the file's existing imports; it already builds providers and a `log` spy):

```ts
  it("doesn't log a call the caller aborted", async () => {
    const lines: string[] = [];
    const provider = {
      id: "p",
      model: "m",
      dimensions: 2,
      embed: (_texts: string[], signal?: AbortSignal) =>
        new Promise<number[][]>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
    };
    const guarded = createGuardedEmbedder({ provider, log: (l) => lines.push(l) });
    const controller = new AbortController();
    const pending = guarded.embed(["x"], controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(lines).toEqual([]);
  });
```

In `apps/news-api/src/search/semantic.test.ts`, start with the pure page arithmetic:

```ts
import { describe, expect, it } from "vitest";
import { pageWindow } from "./semantic";

describe("pageWindow", () => {
  it.each([
    [1, 0, { vectorStart: 0, vectorEnd: 0, textOffset: 0, textLimit: 20 }],
    [1, 5, { vectorStart: 0, vectorEnd: 5, textOffset: 0, textLimit: 15 }],
    [1, 25, { vectorStart: 0, vectorEnd: 20, textOffset: 0, textLimit: 0 }],
    [2, 25, { vectorStart: 20, vectorEnd: 25, textOffset: 0, textLimit: 15 }],
    [3, 25, { vectorStart: 25, vectorEnd: 25, textOffset: 15, textLimit: 20 }],
    [2, 20, { vectorStart: 20, vectorEnd: 20, textOffset: 0, textLimit: 20 }],
    [50, 1000, { vectorStart: 980, vectorEnd: 1000, textOffset: 0, textLimit: 0 }],
  ])("page %i with %i vector keys", (page, count, expected) => {
    expect(pageWindow(page, count)).toEqual(expected);
  });
});
```

Add to `apps/news-api/src/env.test.ts` (it already has `BASE` and imports `parseEnv`):

```ts
describe("newsApiEnvSchema search settings", () => {
  it("defaults the semantic threshold to 0.6 and the search rate limit to 60 a minute", () => {
    const env = parseEnv(newsApiEnvSchema, BASE as unknown as NodeJS.ProcessEnv);
    expect(env.SEARCH_SEMANTIC_THRESHOLD).toBe(0.6);
    expect(env.SEARCH_RATE_LIMIT_PER_MIN).toBe(60);
  });

  it.each([
    ["SEARCH_SEMANTIC_THRESHOLD", "2.5"],
    ["SEARCH_SEMANTIC_THRESHOLD", "-0.1"],
    ["SEARCH_RATE_LIMIT_PER_MIN", "0"],
  ])("refuses %s=%s", (name, value) => {
    expect(newsApiEnvSchema.safeParse({ ...BASE, [name]: value }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Write the failing integration and HTTP tests**

Append to `apps/news-api/src/search/semantic.test.ts`, merging these imports into the ones at the top of the file:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createGuardedEmbedder, EmbeddingError, standInProvider, type EmbeddingProvider } from "@gcpe/embeddings";
import type { ReleaseRecord } from "@gcpe/events";
import { sampleRelease } from "@gcpe/events/testing";
import { closeHandle, createNewsTestDb, EVENT_SECRETS, TZ, writeTenantConfig } from "../../test/helpers";
import { runEmbeddingTick } from "../embeddings/worker";
import { applyRelease, unpublishRelease } from "../projections";
import { startNewsApi } from "../start";
import type { SearchQuery } from "./query";
import { createSemanticSearch } from "./semantic";
import { createSearchService } from "./service";
import { QueryVectorCache } from "./vector-cache";

const FILLER = Array.from({ length: 60 }, (_, i) => `filler${i}`).join(" ");

function release(key: string, headline: string, o: { body?: string; publishDate?: string; ministryKeys?: string[] } = {}): ReleaseRecord {
  return {
    ...sampleRelease,
    key,
    reference: null,
    summary: null,
    keywords: null,
    location: null,
    publishDate: o.publishDate ?? "2026-10-01T10:00:00-07:00",
    leadMinistryKey: o.ministryKeys?.[0] ?? null,
    ministryKeys: o.ministryKeys ?? [],
    sectorKeys: [],
    documents: [{ ...sampleRelease.documents[0]!, headline, subheadline: "", detailsHtml: o.body ? `<p>${o.body}</p>` : "" }],
  };
}

describe("semantic mode (spec §5.4)", () => {
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
  function service(provider: EmbeddingProvider = standInProvider(), logs: { guarded: string[]; service: string[] } = { guarded: [], service: [] }) {
    const embedder = createGuardedEmbedder({ provider, log: (l) => logs.guarded.push(l) });
    const semantic = createSemanticSearch({ db: tdb.db, embedder, cache: new QueryVectorCache(), language: "english", defaultLanguageId: 4105, threshold: 0.5 });
    return createSearchService({ db: tdb.db, timeZone: TZ, language: "english", defaultLanguageId: 4105, publicSiteUrl: "https://site.example.test", semantic, log: (l) => logs.service.push(l) });
  }
  const q = (over: Partial<SearchQuery> = {}): SearchQuery => ({ q: "salmon habitat restoration", page: 1, ...over });
  const counting = () => {
    const base = standInProvider();
    const calls: string[][] = [];
    const provider: EmbeddingProvider = { ...base, async embed(texts, signal) { calls.push(texts); return base.embed(texts, signal); } };
    return { provider, calls };
  };

  it("puts vector matches first, nearest first, then text matches not already listed", async () => {
    await seed(
      release("V-EXACT", "salmon habitat restoration"),
      release("V-NEAR", "salmon habitat"),
      // Has all three words, so it is a text match, but among 60 other words it is far in vector terms.
      release("T-ONLY", "Budget notes", { body: `salmon habitat restoration ${FILLER}` }),
      release("NONE", "School bus routes"),
    );
    const res = await service().search(q());
    expect(res.mode).toBe("semantic");
    expect(res.total).toBe(3);
    expect(res.results.map((r) => r.key)).toEqual(["V-EXACT", "V-NEAR", "T-ONLY"]);
    expect(res.results[0]!.url).toBe("https://site.example.test/releases/V-EXACT");
  });

  it("pages across the vector and text groups without repeating a post", async () => {
    const vectors = Array.from({ length: 22 }, (_, i) => release(`V-${String(i).padStart(2, "0")}`, `salmon habitat restoration n${i}`));
    const texts = [1, 2, 3].map((d) => release(`T-${d}`, "Budget notes", { body: `salmon habitat restoration ${FILLER}`, publishDate: `2026-10-0${d}T10:00:00-07:00` }));
    await seed(...vectors, ...texts);
    const svc = service();
    const p1 = await svc.search(q({ page: 1 }));
    const p2 = await svc.search(q({ page: 2 }));
    expect(p1.total).toBe(25);
    expect(p2.total).toBe(25);
    const k1 = p1.results.map((r) => r.key);
    const k2 = p2.results.map((r) => r.key);
    expect(k1).toHaveLength(20);
    expect(k1.every((k) => k.startsWith("V-"))).toBe(true);
    expect(k2.slice(0, 2).every((k) => k.startsWith("V-"))).toBe(true);
    expect(k2.slice(2)).toEqual(["T-3", "T-2", "T-1"]);
    expect(new Set([...k1, ...k2]).size).toBe(25);
  });

  it("applies the filters to the vector branch too", async () => {
    await seed(release("V-HEALTH", "salmon habitat restoration", { ministryKeys: ["health"] }), release("V-OTHER", "salmon habitat restoration", { ministryKeys: ["finance"] }));
    const res = await service().search(q({ ministry: "Health" }));
    expect(res.results.map((r) => r.key)).toEqual(["V-HEALTH"]);
  });

  it("never returns an unpublished post", async () => {
    await seed(release("V-GONE", "salmon habitat restoration"), release("V-STAY", "salmon habitat"));
    await tdb.db.transaction((tx) => unpublishRelease(tx, "V-GONE"));
    expect((await service().search(q())).results.map((r) => r.key)).toEqual(["V-STAY"]);
  });

  it("embeds each normalised query once within five minutes", async () => {
    await seed(release("V-EXACT", "salmon habitat restoration"));
    const { provider, calls } = counting();
    const svc = service(provider);
    await svc.search(q({ q: "Salmon habitat restoration!" }));
    await svc.search(q({ q: "  salmon   HABITAT restoration " }));
    expect(calls).toEqual([["salmon habitat restoration"]]);
  });

  it("answers text mode without calling the provider when the query normalises to nothing", async () => {
    const { provider, calls } = counting();
    const res = await service(provider).search(q({ q: "!!!" }));
    expect(res.mode).toBe("text");
    expect(calls).toEqual([]);
  });

  it("falls back to text mode when the provider fails, with one log line, from the guarded embedder", async () => {
    await seed(release("T-ONLY", "Budget notes", { body: "salmon habitat restoration" }));
    const failing: EmbeddingProvider = { id: "failing", model: "m", dimensions: 1536, embed: async () => { throw new EmbeddingError("embedding_http_503"); } };
    const logs = { guarded: [] as string[], service: [] as string[] };
    const res = await service(failing, logs).search(q());
    expect(res).toMatchObject({ mode: "text", total: 1 });
    expect(logs.guarded).toEqual(["[embeddings] failing call failed embedding_http_503"]);
    expect(logs.service).toEqual([]);
  });

  it("logs nothing, and calls nothing, while the breaker is open", async () => {
    let calls = 0;
    const failing: EmbeddingProvider = { id: "failing", model: "m", dimensions: 1536, embed: async () => { calls++; throw new EmbeddingError("embedding_http_503"); } };
    const logs = { guarded: [] as string[], service: [] as string[] };
    const svc = service(failing, logs);
    for (let i = 0; i < 3; i++) await svc.search(q({ q: `query ${i}` }));
    for (let i = 0; i < 5; i++) expect((await svc.search(q({ q: `open ${i}` }))).mode).toBe("text");
    expect(calls).toBe(3);
    expect(logs.guarded).toHaveLength(3);
    expect(logs.service).toEqual([]);
  });

  it("startNewsApi serves semantic mode once posts are embedded, and text mode with the flag off", async () => {
    for (const [flag, mode] of [[true, "semantic"], [false, "text"]] as const) {
      const own = await createNewsTestDb();
      const handle = await startNewsApi(
        { DATABASE_URL: own.url, EVENT_SECRETS: JSON.stringify(EVENT_SECRETS), TENANT_CONFIG: writeTenantConfig({ features: { semanticSearch: flag, staffAi: false } }), EMBEDDINGS_PROVIDER: "stand-in" },
        { hub: false },
      );
      try {
        await own.db.transaction((tx) => applyRelease(tx, release("V-EXACT", "salmon habitat restoration"), { notify: false }));
        await handle.workers.embed!();
        const res = await request(handle.app).get("/api/v2/search?q=salmon%20habitat%20restoration");
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ mode, total: 1, results: [{ key: "V-EXACT" }] });
      } finally {
        await closeHandle(handle);
        await own.drop();
      }
    }
  });
});
```

The stand-in distances behind these expectations (*inferred* from the stand-in's design, not measured; each word sets 4 of 1,536 slots): "salmon habitat restoration" against itself is 0; against "salmon habitat" about 0.18; against `salmon habitat restoration n<i>` about 0.13; against the same three words among 60 filler words about 0.78. With `threshold: 0.5` the first three groups are vector matches and the filler posts are not. If a test fails on ordering, print the distances (`SELECT post_key, (embedding::vector(1536)) <=> …`) before changing anything; only the threshold in this test file may move, never the order expected.

In `apps/news-api/src/http/v2/search.test.ts`, inside `describe("GET /api/v2/search (HTTP)", …)`, add:

```ts
  it("limits each client IP per minute, answering 429 with no-store (Q74)", async () => {
    const app = express();
    app.use("/api/v2", v2Routes({ search: stub, searchRateLimit: { perMinute: 2, clientIpHeader: "x-client-ip" } }));
    const get = (ip: string) => request(app).get("/api/v2/search?q=x").set("x-client-ip", ip);
    expect((await get("203.0.113.1")).status).toBe(200);
    expect((await get("203.0.113.1")).status).toBe(200);
    const limited = await get("203.0.113.1");
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: "too many requests" });
    expect(limited.headers["cache-control"]).toBe("no-store");
    expect((await get("203.0.113.2")).status).toBe(200);
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/news-api/src/search apps/news-api/src/http/v2/search.test.ts apps/news-api/src/env.test.ts packages/embeddings/src/guarded.test.ts`
Expected: FAIL. `./vector-cache` and `./semantic` don't exist; the env defaults are `undefined`; there is no 429; the guarded embedder logs the aborted call.

- [ ] **Step 4: Quiet aborts in the guarded embedder**

In `packages/embeddings/src/guarded.ts`, change the catch to:

```ts
      } catch (e) {
        // An open breaker isn't a call, and a caller's own abort isn't a provider failure.
        if (!(e instanceof BreakerOpenError) && !signal?.aborted) log(`[embeddings] ${provider.id} call failed ${safeErrorLabel(e)}`);
        throw e;
      }
```

Update its doc comment: "…An open breaker and a call the caller aborted aren't logged."

- [ ] **Step 5: The cache**

Create `apps/news-api/src/search/vector-cache.ts`:

```ts
export const QUERY_VECTOR_TTL_MS = 5 * 60_000;
export const QUERY_VECTOR_MAX_ENTRIES = 5_000;

/**
 * Query vectors by normalised query (spec §5.4): each kept 5 minutes, at most 5,000, oldest
 * dropped first. It holds visitors' normalised queries in memory only, and is never logged.
 */
export class QueryVectorCache {
  private readonly entries = new Map<string, { vector: number[]; at: number }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? QUERY_VECTOR_TTL_MS;
    this.maxEntries = opts.maxEntries ?? QUERY_VECTOR_MAX_ENTRIES;
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): number[] | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.vector;
  }

  set(key: string, vector: number[]): void {
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { vector, at: this.now() });
  }
}
```

- [ ] **Step 6: Text search: a window, a snapshot, and rows by key**

In `apps/news-api/src/search/text-search.ts`:
- import `type DbOrTx` (instead of `Db`) from `@gcpe/db-kit`, and `inArray` from `drizzle-orm`;
- add:
  ```ts
  /** Count and page from one snapshot (6a's final review, M5): a publish between them can't skew total. */
  export const READ_SNAPSHOT = { isolationLevel: "repeatable read", accessMode: "read only" } as const;

  /** The columns of a SearchRow. The headline is the default-language document's, else the first,
   * picked in SQL so a page never detoasts every result's full `documents` jsonb. */
  export function searchRowColumns(defaultLanguageId: number) {
    return {
      key: posts.key,
      kind: posts.kind,
      headline: sql<string | null>`coalesce(
        (select doc->>'headline' from jsonb_array_elements(${posts.documents}) with ordinality as t(doc, ord)
          where (doc->>'languageId')::int = ${defaultLanguageId} order by ord limit 1),
        ${posts.documents}->0->>'headline'
      )`,
      summary: posts.summary,
      publishDate: posts.publishDate,
      leadMinistryKey: posts.leadMinistryKey,
    };
  }

  /** Published posts with these stored keys, in the given order. For short lists (a page, a related list). */
  export async function searchRowsByKeys(db: DbOrTx, keys: string[], defaultLanguageId: number): Promise<SearchRow[]> {
    if (keys.length === 0) return [];
    const rows = await db.select(searchRowColumns(defaultLanguageId)).from(posts).where(and(inArray(posts.key, keys), eq(posts.isPublished, true)));
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return keys.map((k) => byKey.get(k)).filter((r): r is SearchRow => r !== undefined);
  }
  ```
- add to `TextSearchOptions`:
  ```ts
    /** Which matches to return; default: the query's page. Semantic mode passes what's left of a page. */
    window?: { offset: number; limit: number };
  ```
- change `textSearch` to take `db: DbOrTx`, replace its inline `headline` and `.select({…})` with `.select(searchRowColumns(opts.defaultLanguageId))`, and use the window:
  ```ts
    const window = opts.window ?? { offset: (query.page - 1) * SEARCH_PAGE_SIZE, limit: SEARCH_PAGE_SIZE };
    const [{ total } = { total: 0 }] = await db.select({ total: sql<number>`count(*)::int` }).from(posts).where(where);
    if (total === 0 || window.limit === 0) return { total, rows: [] };
    const rows = await db
      .select(searchRowColumns(opts.defaultLanguageId))
      .from(posts)
      .where(where)
      .orderBy(sql`ts_rank_cd(${posts.searchVector}, ${tsquery}) desc`, desc(posts.publishDate), KEY_DESC)
      .limit(window.limit)
      .offset(window.offset);
    return { total, rows };
  ```

- [ ] **Step 7: The semantic branch**

Create `apps/news-api/src/search/semantic.ts`:

```ts
import { and, sql } from "drizzle-orm";
import type { SearchLanguage } from "@gcpe/config";
import type { Db, Tx } from "@gcpe/db-kit";
import { normaliseForEmbedding, type GuardedEmbedder } from "@gcpe/embeddings";
import { postEmbeddings, posts } from "../db/schema";
import { VECTOR_DIMENSIONS } from "../embeddings/pgvector";
import { SEARCH_MAX_PAGE, SEARCH_PAGE_SIZE, type SearchQuery } from "./query";
import type { SemanticSearch } from "./service";
import { READ_SNAPSHOT, searchFilters, searchRowsByKeys, textSearch } from "./text-search";
import type { QueryVectorCache } from "./vector-cache";

/** The deepest result a visitor can reach (50 pages of 20): the vector branch never needs more. */
export const VECTOR_CANDIDATE_LIMIT = SEARCH_MAX_PAGE * SEARCH_PAGE_SIZE;

/** Which slice of the vector keys, and which window of text matches, make up `page`. */
export function pageWindow(page: number, vectorCount: number): { vectorStart: number; vectorEnd: number; textOffset: number; textLimit: number } {
  const start = (page - 1) * SEARCH_PAGE_SIZE;
  const vectorStart = Math.min(start, vectorCount);
  const vectorEnd = Math.min(start + SEARCH_PAGE_SIZE, vectorCount);
  return { vectorStart, vectorEnd, textOffset: Math.max(0, start - vectorCount), textLimit: SEARCH_PAGE_SIZE - (vectorEnd - vectorStart) };
}

export interface SemanticSearchOptions {
  db: Db;
  embedder: GuardedEmbedder;
  cache: QueryVectorCache;
  language: SearchLanguage;
  defaultLanguageId: number;
  /** Cosine distance at or below which a post is a vector match (SEARCH_SEMANTIC_THRESHOLD). */
  threshold: number;
}

/**
 * Spec §5.4 semantic mode: vector matches (distance ≤ threshold, nearest first) then text matches
 * not among them, as Media Hub orders its two groups. Returns null, never throws, when the query
 * can't be embedded: the guarded embedder has already logged a real provider failure once, and
 * an open breaker or a visitor's abort isn't worth a line. The service then serves text mode.
 */
export function createSemanticSearch(o: SemanticSearchOptions): SemanticSearch {
  return {
    async search(query, signal) {
      const text = normaliseForEmbedding(query.q);
      if (text === "") return null;
      let vector = o.cache.get(text);
      if (!vector) {
        try {
          vector = (await o.embedder.embed([text], signal))[0];
        } catch {
          return null;
        }
        if (!vector || vector.length !== VECTOR_DIMENSIONS) return null;
        o.cache.set(text, vector);
      }
      const literal = `[${vector.join(",")}]`;
      return o.db.transaction(async (tx) => {
        const keys = await vectorKeys(tx, query, literal, o.threshold);
        const w = pageWindow(query.page, keys.length);
        const vectorRows = await searchRowsByKeys(tx, keys.slice(w.vectorStart, w.vectorEnd), o.defaultLanguageId);
        const textPage = await textSearch(tx, query, {
          language: o.language,
          defaultLanguageId: o.defaultLanguageId,
          excludeKeys: keys,
          window: { offset: w.textOffset, limit: w.textLimit },
        });
        return { total: keys.length + textPage.total, rows: [...vectorRows, ...textPage.rows] };
      }, READ_SNAPSHOT);
    },
  };
}

/**
 * Exact cosine distance for every post the filters allow. The MATERIALIZED CTE has no ORDER BY,
 * so the planner can't swap in the approximate HNSW index (which returns at most hnsw.ef_search
 * rows, before the filters): results never depend on the plan. post_embeddings holds published
 * posts only; searchFilters also requires is_published.
 */
async function vectorKeys(tx: Tx, query: SearchQuery, literal: string, threshold: number): Promise<string[]> {
  const { rows } = await tx.execute<{ key: string }>(sql`
    WITH scored AS MATERIALIZED (
      SELECT ${posts.key} AS key, (${postEmbeddings.embedding}::vector(1536)) <=> ${literal}::vector(1536) AS distance
      FROM ${postEmbeddings} JOIN ${posts} ON ${posts.key} = ${postEmbeddings.postKey}
      WHERE ${and(...searchFilters(query))}
    )
    SELECT key FROM scored
    WHERE distance <= ${threshold}
    ORDER BY distance, key COLLATE "C"
    LIMIT ${VECTOR_CANDIDATE_LIMIT}`);
  return rows.map((r) => r.key);
}
```

Measured while planning (20,000 random vectors, Postgres 14.17): this exact scan takes 120–170 ms. Keep the `MATERIALIZED` CTE; don't "optimise" it into an `ORDER BY … LIMIT` the index could serve.

- [ ] **Step 8: The service: one snapshot, and quiet on an open breaker**

In `apps/news-api/src/search/service.ts`:
- import `{ BreakerOpenError } from "@gcpe/embeddings"` and `READ_SNAPSHOT` from `./text-search`;
- extract the mapper:
  ```ts
  export function searchResultMapper(publicSiteUrl: string, timeZone: string): (r: SearchRow) => SearchResult {
    const base = publicSiteUrl.replace(/\/+$/, "");
    return (r) => ({
      key: r.key,
      kind: r.kind,
      headline: r.headline,
      summary: r.summary,
      publishDate: formatOffsetDateTime(r.publishDate, timeZone),
      leadMinistryKey: r.leadMinistryKey,
      url: `${base}/releases/${encodeURIComponent(r.key)}`,
    });
  }
  ```
  and use `const toResult = searchResultMapper(o.publicSiteUrl, o.timeZone);` inside `createSearchService`;
- in `search`:
  ```ts
        if (o.semantic) {
          try {
            semantic = await o.semantic.search(query, signal);
          } catch (e) {
            if (!(e instanceof BreakerOpenError)) log(`[news-api] search semantic branch failed ${safeErrorLabel(e)}`);
          }
        }
        const page =
          semantic ??
          (await o.db.transaction((tx) => textSearch(tx, query, { language: o.language, defaultLanguageId: o.defaultLanguageId }), READ_SNAPSHOT));
  ```
- update `SemanticSearch`'s doc comment: "Semantic mode: the whole page, or null to fall back to text. It catches its own embed failures; a throw means its SQL failed, which the service logs once."

- [ ] **Step 9: The per-IP limit**

Create `apps/news-api/src/http/client-ip.ts`:

```ts
import { isIP } from "node:net";
import type { Request } from "express";
import { ipKeyGenerator } from "express-rate-limit";

/**
 * A rate-limit key for the client: `header`'s first address when it's a valid IP, else req.ip.
 * ipKeyGenerator groups IPv6 by subnet, so one host can't rotate through its /64 for fresh buckets.
 */
export function clientIpKey(header: string | undefined): (req: Request) => string {
  return (req) => {
    const forwarded = header ? req.get(header)?.split(",")[0]?.trim() : undefined;
    const ip = forwarded && isIP(forwarded) ? forwarded : (req.ip ?? "");
    return ipKeyGenerator(ip);
  };
}
```

In `apps/news-api/src/http/v1/subscribe.ts`, replace the local `keyGenerator` function (lines 77-83, with its comment) by `const keyGenerator = clientIpKey(clientIpHeader);` (import from `"../client-ip"`), and remove imports that become unused (`isIP`, `ipKeyGenerator`). Behaviour is unchanged; the v1 subscribe tests prove it.

In `apps/news-api/src/http/v2/routes.ts`:

```ts
import { rateLimit } from "express-rate-limit";
import { clientIpKey } from "../client-ip";
// …
export function v2Routes(deps: {
  search?: SearchService;
  /** Per client IP on /search (Q74). Absent: no limit (tests). */
  searchRateLimit?: { perMinute: number; clientIpHeader?: string };
  changes?: ChangesRouteOptions;
}): express.Router {
```

and in the search block, before the handler:

```ts
    const limiter = deps.searchRateLimit
      ? [
          rateLimit({
            windowMs: 60_000,
            limit: deps.searchRateLimit.perMinute,
            standardHeaders: "draft-8",
            legacyHeaders: false,
            keyGenerator: clientIpKey(deps.searchRateLimit.clientIpHeader),
            handler: (_req, res) => void res.status(429).json({ error: "too many requests" }),
          }),
        ]
      : [];
    r.get("/search", ...limiter, async (req, res) => {
```

In `apps/news-api/src/app.ts`, add `searchRateLimit?: { perMinute: number; clientIpHeader?: string };` to `AppDeps` (doc: "Per client IP on `/api/v2/search` (Q74)") and pass it to `v2Routes`.

In `apps/news-api/src/env.ts`, add before `...embeddingsEnvShape`:

```ts
    /** Cosine distance at or below which a post is a semantic match (spec §5.4). */
    SEARCH_SEMANTIC_THRESHOLD: z.coerce.number().min(0).max(2).default(0.6),
    /** Requests a minute per client IP on /api/v2/search (Q74), keyed like Subscribe. */
    SEARCH_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(60),
```

- [ ] **Step 10: Wire semantic mode into `startNewsApi`**

In `apps/news-api/src/start.ts` (import `createSemanticSearch` from `./search/semantic`, `QueryVectorCache` from `./search/vector-cache`):

```ts
  // Search's own guarded provider (EMBEDDINGS_TIMEOUT_MS) and breaker, apart from the worker's.
  const semantic =
    searchMode === "semantic" && provider
      ? createSemanticSearch({
          db,
          embedder: createGuardedEmbedder({ provider }),
          cache: new QueryVectorCache(),
          language: tenant.search.language,
          defaultLanguageId: tenant.defaultLanguageId,
          threshold: parsed.SEARCH_SEMANTIC_THRESHOLD,
        })
      : null;
```

Pass `semantic` to `createSearchService({ … })`, and `searchRateLimit: { perMinute: parsed.SEARCH_RATE_LIMIT_PER_MIN, clientIpHeader: parsed.SUBSCRIBE_CLIENT_IP_HEADER }` to `createApp`.

- [ ] **Step 11: Run the tests to verify they pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/news-api packages/embeddings apps/stack/src/stack-check.test.ts`
Expected: PASS, the v1 suites (including the Subscribe tests in `http/v1/`) unedited and green.

Type-check: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`. Expected: exit 0.

- [ ] **Step 12: Q74, runbook and running notes**

In `docs/parity/open-questions.md`, replace Q74's working-assumption cell (`No limit in 6a; revisit in 6b.`) with:

```markdown
6b limits it to 60 requests a minute per client IP (`SEARCH_RATE_LIMIT_PER_MIN`), keyed like Subscribe. An uncached semantic query also costs an Azure call and an exact vector scan of every filtered post (120–170 ms at 20,000 posts, measured locally). The limit is per process, so each OpenShift replica counts separately.
```

Append to the Phase 6b section of `docs/deploy/siteground.md`:

```markdown
### Semantic search

In semantic mode, `GET /api/v2/search` embeds the query (each distinct query once per 5 minutes; up to 5,000 kept) and lists posts whose meaning is close to it first, nearest first, then the full-text matches not already listed. Responses say `"mode": "semantic"`. If the provider fails or its breaker is open, the same request answers in text mode and says `"mode": "text"`; while the breaker is open nothing is logged per request.

| Variable | Meaning |
|---|---|
| `NEWSAPI_SEARCH_SEMANTIC_THRESHOLD` | Cosine distance at or below which a post counts as a semantic match. Default `0.6`; 0–2. Lower is stricter. |
| `NEWSAPI_SEARCH_RATE_LIMIT_PER_MIN` | Search requests a minute per client IP (Q74). Default `60`. A client over it gets `429 {"error":"too many requests"}`. Uses `NEWSAPI_SUBSCRIBE_CLIENT_IP_HEADER` to find the client's address, as Subscribe does. |

**Cost:** an uncached semantic query compares the query with every published post's vector that the filters allow: 120–170 ms at 20,000 posts on a laptop, growing in proportion (Q79).

**Hand check on boxs.ca** (text mode there): after 61 quick `curl -s -o /dev/null -w '%{http_code}\n' 'https://boxs.ca/api/v2/search?q=x'` calls from one machine within a minute, the last is `429`.
```

Append to the Phase 6b list in `docs/manuals/running-notes.md`:

```markdown
- **Operations** — In semantic mode, search lists posts close in meaning to the query first, then ordinary full-text matches. Each response says which mode answered. Search now allows 60 requests a minute per visitor IP (`NEWSAPI_SEARCH_RATE_LIMIT_PER_MIN`); the threshold for a semantic match is `NEWSAPI_SEARCH_SEMANTIC_THRESHOLD` (default 0.6). An open breaker no longer writes a log line per search.
- **Developer** — `createSemanticSearch` (`src/search/semantic.ts`) embeds `normaliseForEmbedding(q)` through `QueryVectorCache`, then, in one read-only repeatable-read transaction, reads up to 1,000 vector keys by exact cosine distance (a `MATERIALIZED` CTE, so the HNSW index is never used for search) and fills the rest of the page with `textSearch(…, { excludeKeys, window })`. It returns null instead of throwing on any embed failure. Text mode's count and page now share one snapshot too.
```

- [ ] **Step 13: Commit**

```bash
git add apps/news-api packages/embeddings docs/parity/open-questions.md docs/deploy/siteground.md docs/manuals/running-notes.md
git commit -m "feat(news-api): semantic mode for v2 search, with a query cache, quiet fallback and a per-IP limit"
```

---

### Task 5: `GET /api/v2/posts/{key}/related`, its text fallback, and the parity questions

**Review:** shared with Task 4 (review D).

**Files:**
- Create: `apps/news-api/src/search/related.ts`, `apps/news-api/src/search/related.test.ts`
- Modify: `apps/news-api/src/http/v2/routes.ts`, `apps/news-api/src/app.ts`, `apps/news-api/src/start.ts`
- Docs: `docs/parity/open-questions.md` (Q78–Q80), `docs/deploy/siteground.md`, `docs/manuals/running-notes.md`

**Interfaces:**
- Consumes (Task 1): `postRelated`, `AppHandle.searchMode`.
- Consumes (Task 3): `RELATED_LIMIT`, `runEmbeddingTick` (tests), the published-only invariant.
- Consumes (Task 4): `searchRowColumns(defaultLanguageId)`, `searchRowsByKeys(db, keys, defaultLanguageId)`, `searchResultMapper(publicSiteUrl, timeZone)`; `v2Routes`'s deps object.
- Produces:
  - `related.ts`: `RELATED_MAX_KEY_CHARS = 200`; `interface RelatedResponse { mode: SearchMode; results: SearchResult[] }`; `interface RelatedService { related(key: string): Promise<RelatedResponse | null> }` (`null` = 404); `createRelatedService(o: { db: Db; timeZone: string; defaultLanguageId: number; publicSiteUrl: string; semantic: boolean }): RelatedService`.
  - `v2Routes(deps: { search?; searchRateLimit?; related?: RelatedService; changes? })`; `AppDeps.related?: RelatedService`.
  - v2's decode-error handler: a malformed percent-encoding in a v2 path is `400 { "error": "bad request" }`, not logged.

- [ ] **Step 1: Write the failing tests**

Create `apps/news-api/src/search/related.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createGuardedEmbedder, standInProvider } from "@gcpe/embeddings";
import type { ReleaseRecord } from "@gcpe/events";
import { sampleRelease } from "@gcpe/events/testing";
import { jsonErrorHandler } from "@gcpe/http-kit";
import { createNewsTestDb, TZ } from "../../test/helpers";
import { runEmbeddingTick } from "../embeddings/worker";
import { v2Routes } from "../http/v2/routes";
import { applyRelease, unpublishRelease } from "../projections";
import { createRelatedService, type RelatedService } from "./related";

function release(key: string, headline: string, o: { lead?: string | null; tags?: string[]; publishDate?: string } = {}): ReleaseRecord {
  const lead = o.lead === undefined ? "health" : o.lead;
  return {
    ...sampleRelease,
    key,
    reference: null,
    summary: null,
    keywords: null,
    location: null,
    publishDate: o.publishDate ?? "2026-10-01T10:00:00-07:00",
    leadMinistryKey: lead,
    ministryKeys: lead ? [lead] : [],
    sectorKeys: [],
    tagKeys: o.tags ?? ["fish"],
    documents: [{ ...sampleRelease.documents[0]!, headline, subheadline: "", detailsHtml: "" }],
  };
}

describe("related posts (spec §5.4)", () => {
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
  const seed = async (...rs: ReleaseRecord[]) => {
    for (const r of rs) await tdb.db.transaction((tx) => applyRelease(tx, r, { notify: false }));
  };
  const embedAll = async () => {
    const embedder = createGuardedEmbedder({ provider: standInProvider(), log: () => {} });
    while ((await runEmbeddingTick({ db: tdb.db, embedder })).embedded > 0);
  };
  const svc = (semantic = true) =>
    createRelatedService({ db: tdb.db, timeZone: TZ, defaultLanguageId: 4105, publicSiteUrl: "https://site.example.test", semantic });
  const keys = (r: Awaited<ReturnType<RelatedService["related"]>>) => r?.results.map((x) => x.key);

  it("lists the stored nearest neighbours in semantic mode, nearest first, in the search result shape", async () => {
    await seed(release("P0", "salmon river habitat"), release("P1", "salmon river habitat work"), release("P2", "salmon river"), release("P3", "salmon"));
    await embedAll();
    const res = await svc().related("p0");
    expect(res?.mode).toBe("semantic");
    expect(keys(res)).toEqual(["P1", "P2", "P3"]);
    expect(res?.results[0]).toEqual({
      key: "P1",
      kind: "releases",
      headline: "salmon river habitat work",
      summary: null,
      publishDate: "2026-10-01T10:00:00-07:00",
      leadMinistryKey: "health",
      url: "https://site.example.test/releases/P1",
    });
  });

  it("drops related keys that are no longer published, and falls back when none is left", async () => {
    await seed(release("P0", "salmon river habitat"), release("P1", "salmon river habitat work"), release("P2", "salmon river"));
    await embedAll();
    // Published after P0's list was computed, so only the text fallback can find it.
    await seed(release("P3", "budget notes", { publishDate: "2026-10-05T10:00:00-07:00" }));
    await tdb.db.transaction((tx) => unpublishRelease(tx, "P1"));
    expect(keys(await svc().related("P0"))).toEqual(["P2"]);
    await tdb.db.transaction((tx) => unpublishRelease(tx, "P2"));
    expect(await svc().related("P0")).toMatchObject({ mode: "text", results: [{ key: "P3" }] });
  });

  it("without a stored list, falls back to the newest published posts sharing the lead ministry and a tag", async () => {
    await seed(
      release("X", "anchor", { lead: "Health", tags: ["Fish"] }),
      release("A", "a", { lead: "HEALTH", tags: ["fish"], publishDate: "2026-10-03T10:00:00-07:00" }),
      release("D", "d", { tags: ["fish", "rivers"], publishDate: "2026-10-02T10:00:00-07:00" }),
      release("NO-TAG", "b", { tags: ["other"] }),
      release("OTHER-MIN", "c", { lead: "finance", tags: ["fish"] }),
      release("GONE", "e", { tags: ["fish"], publishDate: "2026-10-04T10:00:00-07:00" }),
    );
    await tdb.db.transaction((tx) => unpublishRelease(tx, "GONE"));
    const res = await svc().related("x");
    expect(res?.mode).toBe("text");
    expect(keys(res)).toEqual(["A", "D"]);
  });

  it("uses the fallback while semantic mode is off, even with a stored list", async () => {
    await seed(release("P0", "salmon river habitat"), release("P1", "salmon river habitat work"));
    await embedAll();
    expect(await svc(false).related("P0")).toMatchObject({ mode: "text", results: [{ key: "P1" }] });
  });

  it("answers an empty list for a post with no lead ministry or no tags", async () => {
    await seed(release("NOLEAD", "a", { lead: null }), release("NOTAGS", "b", { tags: [] }), release("PEER", "c"));
    expect(await svc(false).related("NOLEAD")).toEqual({ mode: "text", results: [] });
    expect(await svc(false).related("NOTAGS")).toEqual({ mode: "text", results: [] });
  });

  it("is null for an unknown or an unpublished key", async () => {
    await seed(release("GONE", "a"));
    await tdb.db.transaction((tx) => unpublishRelease(tx, "GONE"));
    expect(await svc().related("nope")).toBeNull();
    expect(await svc().related("GONE")).toBeNull();
  });
});

describe("GET /api/v2/posts/{key}/related (HTTP)", () => {
  const calls: string[] = [];
  const stub: RelatedService = {
    async related(key) {
      calls.push(key);
      return key === "known" ? { mode: "text", results: [] } : null;
    },
  };
  const app = () => {
    const a = express();
    a.use("/api/v2", v2Routes({ related: stub }));
    a.use(jsonErrorHandler({ logPrefix: "[news-api]" }));
    return a;
  };
  afterEach(() => {
    calls.length = 0;
    vi.restoreAllMocks();
  });

  it("answers 200 with the service's response and no-store", async () => {
    const res = await request(app()).get("/api/v2/posts/known/related");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: "text", results: [] });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("passes a 200-character key through", async () => {
    await request(app()).get(`/api/v2/posts/${"k".repeat(200)}/related`);
    expect(calls).toEqual(["k".repeat(200)]);
  });

  it.each([
    ["an unknown key", "/api/v2/posts/unknown/related", 404, ["unknown"]],
    ["a NUL", "/api/v2/posts/a%00b/related", 404, []],
    ["201 characters", `/api/v2/posts/${"k".repeat(201)}/related`, 404, []],
    ["malformed percent-encoding", "/api/v2/posts/%E0%A4%A/related", 400, []],
  ])("%s: %s -> %i, no-store, nothing logged, never a 500", async (_label, path, status, called) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(app()).get(path);
    expect(res.status).toBe(status);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(calls).toEqual(called);
    expect(error).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/news-api/src/search/related.test.ts`
Expected: FAIL: `./related` doesn't exist, and `v2Routes` has no `related`.

- [ ] **Step 3: Write the related service**

Create `apps/news-api/src/search/related.ts`:

```ts
import { and, arrayOverlaps, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { postRelated, posts } from "../db/schema";
import { RELATED_LIMIT } from "../embeddings/worker";
import { searchResultMapper, type SearchMode, type SearchResult } from "./service";
import { searchRowColumns, searchRowsByKeys } from "./text-search";

export const RELATED_MAX_KEY_CHARS = 200;

export interface RelatedResponse {
  mode: SearchMode;
  results: SearchResult[];
}

export interface RelatedService {
  /** null: no published post has this key (case-insensitive). */
  related(key: string): Promise<RelatedResponse | null>;
}

export interface RelatedServiceOptions {
  db: Db;
  timeZone: string;
  defaultLanguageId: number;
  publicSiteUrl: string;
  /** The startup search mode is semantic: only then are stored lists served. */
  semantic: boolean;
}

/**
 * Spec §5.4: up to 5 posts from post_related, filtered to what is published now (another post's
 * list is only recomputed when that post is re-embedded). With no list, an emptied list, or
 * semantic mode off: the newest published posts sharing the lead ministry and at least one tag.
 */
export function createRelatedService(o: RelatedServiceOptions): RelatedService {
  const toResult = searchResultMapper(o.publicSiteUrl, o.timeZone);
  return {
    async related(key) {
      const [post] = await o.db
        .select({ key: posts.key, lead: posts.leadMinistryKey, tagKeys: posts.tagKeys })
        .from(posts)
        .where(and(sql`lower(${posts.key}) = lower(${key})`, eq(posts.isPublished, true)));
      if (!post) return null;
      if (o.semantic) {
        const [row] = await o.db.select({ keys: postRelated.relatedKeys }).from(postRelated).where(eq(postRelated.postKey, post.key));
        if (row) {
          const rows = (await searchRowsByKeys(o.db, row.keys, o.defaultLanguageId)).slice(0, RELATED_LIMIT);
          if (rows.length > 0) return { mode: "semantic", results: rows.map(toResult) };
        }
      }
      if (!post.lead || post.tagKeys.length === 0) return { mode: "text", results: [] };
      const rows = await o.db
        .select(searchRowColumns(o.defaultLanguageId))
        .from(posts)
        .where(
          and(
            eq(posts.isPublished, true),
            sql`lower(${posts.key}) <> lower(${post.key})`,
            sql`lower(${posts.leadMinistryKey}) = lower(${post.lead})`,
            arrayOverlaps(posts.indexKeys, post.tagKeys.map((t) => `tags:${t.toLowerCase()}`)),
          ),
        )
        .orderBy(desc(posts.publishDate), sql`${posts.key} collate "C" desc`)
        .limit(RELATED_LIMIT);
      return { mode: "text", results: rows.map(toResult) };
    },
  };
}
```

- [ ] **Step 4: The route and the wiring**

In `apps/news-api/src/http/v2/routes.ts` (import `RELATED_MAX_KEY_CHARS`, `type RelatedService` from `"../../search/related"`): add `related?: RelatedService;` to the deps type, and before the 404:

```ts
  const { related } = deps;
  if (related) {
    r.get("/posts/:key/related", async (req, res) => {
      const key = req.params.key;
      // No stored key is this long or holds a NUL, and Postgres refuses NUL in text: answer
      // without a query.
      if (key.length > RELATED_MAX_KEY_CHARS || key.includes("\u0000")) return void res.status(404).json({ error: "not found" });
      const result = await related.related(key);
      if (!result) return void res.status(404).json({ error: "not found" });
      res.json(result);
    });
  }
```

After the 404 middleware, add v2's own decode-error handler:

```ts
  // A path segment that isn't valid percent-encoding: Express raises a URIError with status 400
  // before any v2 handler runs. Answered here, without the app's error log, so a scanner can't
  // fill /stack/errors with it.
  const decodeErrors: express.ErrorRequestHandler = (err, _req, res, next) =>
    err instanceof URIError ? void res.status(400).json({ error: "bad request" }) : next(err);
  r.use(decodeErrors);
```

Checked while planning with Express 5 in this repo: `/posts/%E0%A4%A/related` raises `URIError` with `status: 400` before the handler; `%00` decodes to a NUL and reaches it; `%2F` decodes to `/` inside the one segment.

In `apps/news-api/src/app.ts`: add `/** GET /api/v2/posts/{key}/related. Absent: v2's 404. */ related?: RelatedService;` to `AppDeps` and pass `related: deps.related` to `v2Routes`.

In `apps/news-api/src/start.ts` (import `createRelatedService` from `./search/related`), pass to `createApp`:

```ts
    related: createRelatedService({
      db,
      timeZone: tenant.timeZone,
      defaultLanguageId: tenant.defaultLanguageId,
      publicSiteUrl: parsed.PUBLIC_SITE_URL ?? tenant.publicSiteBaseUrl,
      semantic: searchMode === "semantic",
    }),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/news-api apps/stack/src packages/embeddings packages/auth`
Expected: PASS, v1 suites unedited and green.

Type-check: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`. Expected: exit 0.

Full unit suite (as 6a did before review): `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run`. Expected: PASS (skips as before).

- [ ] **Step 6: Parity questions, runbook and running notes**

In `docs/parity/open-questions.md`, append to the end of the `## Open` table (after Q77):

```markdown
| Q78 | Should a legacy re-import write a change-feed row for every release it re-applies, even an unchanged one? | Each import re-applies every legacy release (about 100,000), and each becomes a `post.upserted` change, so the public site's builder (6c) would rebuild every release page after every re-import. | Yes in 6b: every applied write is recorded, as the spec says. 6c's consumer collapses repeats of a key; if re-imports continue after cutover, revisit with a content check in `applyRelease`. | 2026-10-11 |
| Q79 | Is an exact vector scan per uncached semantic search acceptable at BC's volume, or should search use the approximate HNSW index? | Exact keeps filters and the threshold correct whatever the query plan, but costs 120–170 ms at 20,000 posts (measured locally) and about 0.6–0.8 s at 100,000 (inferred). The index answers in about 2 ms but returns at most `hnsw.ef_search` rows before filters, so a filtered search could miss matches. | Exact scan, behind the per-IP limit and the 5-minute query cache; re-measure at Phase 7's import rehearsal with real Azure vectors. | 2026-10-11 |
| Q80 | Where can Paul and BC try semantic search and related posts before Phase 7? | boxs.ca's SiteGround Postgres can't enable pgvector, so it always answers in text mode; semantic mode is verified only locally and in CI. | Local and CI only until a pgvector-capable test environment (such as OpenShift) exists; relevance also waits for Azure (Q70). | 2026-10-11 |
```

Check for duplicates: `grep -oE "^\| Q[0-9]+" docs/parity/open-questions.md | sort | uniq -d` prints nothing.

Append to the Phase 6b section of `docs/deploy/siteground.md`:

```markdown
### Related posts

`GET /api/v2/posts/<key>/related` lists up to 5 published posts related to a published post, in the same shape as search results, `no-store`.

- In semantic mode it serves the post's 5 nearest posts by meaning, computed when the post was embedded (`"mode": "semantic"`). A post unpublished since is left out at once.
- Otherwise, and before a post is embedded, it serves the newest published posts with the same lead ministry and at least one shared tag (`"mode": "text"`). A post with neither gets an empty list.
- An unknown or unpublished key is a `404`.

**Hand checks on boxs.ca:**
1. `curl -s https://boxs.ca/api/v2/posts/<a published key>/related` answers `"mode":"text"`.
2. `curl -si https://boxs.ca/api/v2/posts/no-such-key/related` is a `404` with `cache-control: no-store`.
3. `curl -s https://boxs.ca/stack/health` includes `"newsApiSearch":"text"`.
```

Append to the Phase 6b list in `docs/manuals/running-notes.md`:

```markdown
- **Site editor** — A published release now has related posts available to the platform's own public site (6c): in semantic mode, the releases closest in meaning; otherwise the newest releases from the same lead ministry that share a tag. An unpublished release drops out of every related list straight away.
- **Developer** — `createRelatedService` (`src/search/related.ts`) serves `post_related` only while the startup search mode is semantic, filtered to published posts at read time, and otherwise the lead-ministry-and-tag fallback. v2 answers a malformed percent-encoded path with its own 400, unlogged.
```

- [ ] **Step 7: Commit**

```bash
git add apps/news-api docs/parity/open-questions.md docs/deploy/siteground.md docs/manuals/running-notes.md
git commit -m "feat(news-api): GET /api/v2/posts/{key}/related with its text fallback; parity Q78-Q80"
```

---

## Phase 6b at a glance

| Task | Delivers | Exit evidence |
|---|---|---|
| 1 | Tables, the optional-pgvector migration, the startup mode, `newsApiSearch` | `pgvector.test.ts` (both roles, 6 mode cases, 2 warnings); `stack.test.ts` health; v1 suites unchanged |
| 2 | Change rows in every projection write, pruning, `410`, the service-token route | `changes.test.ts` (ordering under concurrency, 70,000 rows, pruning); projections and importer change rows; `http/v2/changes.test.ts` |
| 3 | The worker, related posts, unpublish cleanup, the hash on every write | `worker.test.ts` (batches, re-embed rules, breaker, both races, rollback, 70,000 keys); importer cleanup |
| 4 | Semantic search, the cache, quiet fallback, one snapshot, the per-IP limit | `semantic.test.ts`, `vector-cache.test.ts`, `guarded.test.ts`, the 429 test, env defaults |
| 5 | Related route and fallback; Q78–Q80 | `related.test.ts` (semantic, stale-key filter, fallback, hostile keys); the whole suite |

## Risks and things to watch

- **The stand-in distances in Tasks 4 and 5 are inferred from its design, not measured.** If an ordering assertion fails, print the distances first; the threshold in the test may move, the expected order may not.
- **A 50-post Azure batch within 5 seconds is not measured** (Q70). If real batches time out, the worker's breaker opens and embedding stalls while search keeps working. The fix would be a smaller batch, not a longer timeout (§4 caps it at 5,000 ms).
- **pgvector older than 0.5.0 has no HNSW.** There `CREATE INDEX … USING hnsw` raises `undefined_object`, which the `DO` block doesn't catch, so the migration fails and the News API won't start. Every current pgvector has HNSW; this matters only for a very old DBA-installed extension. The runbook's manual statements are the way round it.
- **The restricted-role test assumes the database owner may create in `public`.** True on Postgres 14 (verified) and on 15+, where `public` belongs to `pg_database_owner` (*inferred*; CI's `pgvector/pgvector:pg16` is the first real run).
- **The search mode is fixed at startup.** A DBA who enables pgvector must restart the News API; until then health keeps saying `text`.
- **The rate limit is per process.** OpenShift replicas each allow 60 a minute.
- **Not checked here:**
  - relevance with real embeddings (Q70; 6e's spot-check);
  - the exact scan at 100,000 real vectors (Q79);
  - the HNSW build time on a populated table (the runbook uses `CONCURRENTLY`).

## Self-review (done while writing)

1. **Spec coverage.**
   - §5.2: table (Task 1); source text and hash (Task 3, ruling 1); worker on tick, flag and provider gate, 50 per tick, one call, upsert, related recompute, stop when the breaker is open (Task 3); unpublish deletes both rows in the same transaction (Task 3, plus the importer); drafts never embedded (the worker selects published posts only; drafts never reach the News API).
   - §5.3: no `vector` column (Task 1 schema; Global Constraints); the custom `DO`-block migration catching both codes (Task 1); the DBA statements in the runbook (Task 1); the startup `pg_extension` check (Task 1); `newsApiSearch` (Task 1).
   - §5.4 search: embed and cache 5 minutes / 5,000 / oldest first (Task 4); vector branch at or below the threshold from env, nearest first (Task 4); text branch excluding vector matches (Task 4); vector first (Task 4); fallback with `"mode": "text"` (Task 4); route-only logging and `no-store` (unchanged from 6a, plus the 429).
   - §5.4 related: up to 5 from `post_related`, 404 for unknown or unpublished, the text fallback, the table, computed by the worker and recomputed on re-embed (Tasks 3 and 5).
   - §5.4 changes: the table and kinds, same-transaction writes, order by id with `after`, `limit` ≤ 500 and `next`, 90-day pruning on tick, `410 { resync: true }`, service token only (Task 2, rulings 7 and 8).
   - §8: provider or breaker failure gives text mode, never an error (Task 4); the worker skips the tick (Task 3); missing pgvector is text mode reported in health (Task 1); v2 route errors stay `safeErrorLabel` plus the route (6a's handler; Task 5 adds the unlogged 400). Runbook: enabling pgvector and turning the flag on (Task 1), the worker (Task 3), semantic search (Task 4), related posts (Task 5), the change feed (Task 2). The backfill and Azure settings were 6a's; the PIA gate is 6d's.
   - §9: semantic-plus-text ordering with the stand-in (Task 4); related posts and the fallback (Task 5); change-feed order, pruning and `410` (Task 2); unpublishing removes embeddings and related posts (Task 3); migrations as a role without `CREATE EXTENSION` with health `text`, and with it turning semantic on (Task 1, `handle.searchMode`; the stack test pins that health reports it).
   - 6a carry-forward: M2 (ruling 11, Task 4 test "logs nothing … while the breaker is open"); M5 (ruling 12, Task 4); the AbortSignal seam (consumed in Task 4; the guarded embedder now ignores aborts in its log); Q74 (ruling 10, Task 4).
2. **Placeholder scan.** Every code step has its code and every docs step its text. Two tests name a fallback assertion in prose (Task 3's "alpha now with a body", Task 4's distances), with the exact replacement given.
3. **Type consistency.**
   - `ChangeKind` and `CHANGE_KINDS` (Task 1) are used by `recordChanges` and `CATEGORY_CHANGE_KIND` (Task 2).
   - `VECTOR_DIMENSIONS` (Task 1) is used by the worker (Task 3) and `createSemanticSearch` (Task 4).
   - `AppHandle.searchMode` (Task 1) gates the worker (Task 3), the semantic branch (Task 4) and related lists (Task 5).
   - `stopLoops` and `every` (Task 2) are reused by the worker loop (Task 3).
   - `RELATED_LIMIT` (Task 3) is used by `createRelatedService` (Task 5).
   - `searchRowColumns`, `searchRowsByKeys` and `searchResultMapper` (Task 4) are used by Task 5.
   - `v2Routes`'s deps grow one key per task: `changes` (2), `searchRateLimit` (4), `related` (5); `AppDeps` matches.
4. **Review Focus.** Each of the five has its named test: 1 and 3 (Task 3), 2 and 3 (Task 2), 4 and 5 (Task 5).
5. **Checked against the code at `a216006` while planning** (scratch databases, dropped afterwards; the worktree was restored with `git checkout` and `git clean`):
   - drizzle-kit 0.31 generated `0004` from exactly Task 1's schema (with `now()` in place of `clock_timestamp()` for `changes.at`), and `generate --custom` created an empty `0005` with its journal entry.
   - Through the real `runMigrations`, all six migrations applied as a non-superuser owner (no extension, no index) and as a superuser (pgvector 0.8.0 and `post_embeddings_embedding_hnsw_idx`).
   - `CREATE EXTENSION` of a missing extension raises `58P01`; a non-superuser gets the index when the extension already exists.
   - With the index, inserting a 3-element embedding fails with "expected 1536 dimensions, not 3".
   - On 20,000 random 1,536-dimension vectors: exact scan 120–170 ms; HNSW "5 nearest" about 2 ms warm; index-ordered `LIMIT 1000` with `ef_search` 1000 was planned as a sequential scan anyway.
   - `convert_to` is `STABLE`, so a generated hash column is refused; `text::bytea` misreads backslashes.
   - Express 5's handling of `%E0%A4%A`, `%00` and `%2F` in a path parameter.
   - The whole plan was *not* applied and run end to end. The first full run is the implementers'.

## Execution

Execution method: subagent-driven. A fresh implementer per task, then a whole-branch review. Reviews follow the lighter policy: four full reviews where the spec asked for them, one shared review for the two lower-risk tasks.

| Review | Tasks | Kind | Why |
|---|---|---|---|
| A | 1 | full | Migrations, including the one hand-written SQL file, and the startup mode |
| B | 2 | full | The change feed's ordering and pruning, and a service-token route |
| C | 3 | full | The worker's writes and unpublish cleanup: silent if wrong, visible to the public |
| D | 4, 5 | shared | Public read routes on top of verified tables: semantic ordering, the cache, the limit, related lists |

Order: Task 1 → 2 → 3 → 4 → 5. Each task builds on the previous one's tables or functions. Review A can run while Task 2 is built, B while Task 3 is, and C while Task 4 is.
