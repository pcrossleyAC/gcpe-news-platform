# Developer notes

Short facts a developer needs that the code doesn't make obvious. Staff-facing material goes in the manuals (`docs/manuals/`); operations material goes in `docs/deploy/`.

## Whole repository

- Run tests under Node 24 (tzdata 2026b or later, for BC's permanent UTC−7). Under Node 22, two time-zone tests fail.
- `npm run test:clean-dbs` lists leftover test databases (`test_<20 hex>`, `test_nr_<16 hex>`) and roles (`nr_<16 hex>`); `-- --confirm` drops them. It skips anything in use or created in the last hour (`-- --min-age-minutes=N` changes that), so it is safe while another checkout's tests run.
- `FAKE_ENTRA_ENABLED=true` (tests and test sites only) mounts a fake Microsoft sign-in at `/fake-entra` with two made-up identities, `entra-staff@example.test` and `entra-unknown@example.test`. It needs `CORE_PUBLIC_BASE_URL`. It is refused in real production and alongside real Entra settings, by the same test-site rule as `CORE_LOCAL_PASSWORDS_ALLOWED` (`docs/deploy/siteground.md`).

## Core

- Core emits `user.upserted` for every user change and on republish. Ministries are named by organization key.
- Core routes `user.upserted` and the organization, sector, theme and tag upserted/deactivated events to the Calendar. No other subscriber receives `user.*`.

## NRMS

- Upload routes (release files, site files, page images) take the file name in the `X-GCPE-File-Name` header, percent-encoded, like the Calendar's. `?name=` is refused with a 400.
- NRMS never holds a confidential Calendar activity's text: a database CHECK keeps such rows to the id, the flag and deletion. No event route says "*", and none carries `activity.*` or `release.status_changed` to the News API (`apps/stack/src/env.test.ts`).

## News On Demand

- The public Subscribe API never reveals whether an address is subscribed, and takes link tokens only, never an email address in place of a token (C60).
- Besides the EMCR feed, an emergency item can be posted through `POST /api/emergency-items` (NoD.Admin only). The same guid always resolves to the same item (201 the first time, 200 after). Who it goes to is in the Subscribers administrator manual.
- An item's email summary is the release's own Summary field (`r.summary`), never the English document's subheadline, even when one is set.
- A route that binds an address or a search term uses `privateErrorsWith` (`apps/nod/src/http/private-errors.ts`): it answers unexpected errors itself and logs only an error code. Search terms go in POST bodies, never URLs.
- Report day boundaries are computed in Node (`apps/nod/src/reports/range.ts`) and passed to SQL as instants; never use `AT TIME ZONE` in a report query. CSVs go through `streamCsv` (`reports/csv.ts`), which neutralises formula cells and aborts, rather than truncates, on error. The legacy-volume probes run with `REPORT_PROBE=1`.
- `npm run nod:import` (see `docs/deploy/siteground.md`) loads legacy NoD into NoD. Run `nrms:import` first and let Core's lists reach NoD. Read the report before trusting the data: every skipped row is grouped by reason. Re-running is safe; records changed in NoD since the last import are left alone and listed. A single batch can take up to about 1,000 advisory locks; that's expected, not a sign of a stuck run.
- Re-running `nod:import`: someone who unsubscribed in legacy since the last import is unsubscribed in NoD too, even if NoD changed their record in the meantime (the report lists them as "unsubscribed in legacy since the last import"). If NoD had already purged them, their address is kept as opted out of every media list, without the address itself. The newer choice wins: if they subscribed again in NoD (or staff reactivated them) after unsubscribing in legacy, NoD keeps them and the report lists them as "unsubscribed in legacy before a newer subscribe in NoD". A media list staff removed and re-added in NoD after legacy's own removal stays.

## Distribution

- `GET /api/bounces/summary` (Distribution.Operate) replaced `/api/bounces/stats`. Its rows carry addresses in the response body only; never log them or put them in a URL. Soft rows are scoped to the calling app's token identity.

## Calendar

- The Calendar refuses a bearer token on every route, so staff always reach it through their `gcpe_session` cookie.
- The Calendar names ministries, sectors, themes and tags by Core key, not id. Its projections (`orgs`, `terms`, `users`) have no foreign keys pointing at them.
- The Calendar stores Core keys byte for byte and never case-folds them (spec §5.2). Legacy ministry keys are uppercase GUIDs and Core matches keys exactly, so `HEALTH` and `health` are two organizations, each with its own HQ flag. Only user ids, which are UUIDs, are lowercased.
- A request value the database can't hold (an id past 2,147,483,647, a NUL character, a year before 1900 or after 2199) answers 400, never a 500. A database data error the request checks miss also answers 400 `{"error":"invalid value"}`, and its code is logged.
- The report-rendering spike's code is on `spike/5b-report-rendering`, never merged; its findings are in `docs/superpowers/plans/2026-10-08-phase-5b-report-rendering-spike.md`.
- `npm run calendar:report-compare -- --legacy <pdf> --new <pdf> --out <folder outside the repo>` compares two reports' sections and activity order.
- The legacy import lives in `apps/calendar/src/import/` (`cli.ts`, `run.ts`, `scope.ts`, `map.ts`, `apply.ts`, `apply-related.ts`, `history-map.ts`, `report.ts`) and `apps/core/src/import/calendar-users.ts`. Tests run it against a fake source (`createFakeSource`, `@gcpe/legacy-import`) loaded with the synthetic fixture in `apps/calendar/test/legacy-calendar-fixture.ts`. Because the fake source ignores SQL, the scope rule runs twice for real: once in the SQL that narrows what's read, and again in `selectScope`, which is what the tests check.

## News API

- `@gcpe/embeddings` holds the provider interface, the stand-in (fixed output, so tests can pin vectors), the Azure provider (plain `fetch`, `dimensions: 1536`), the env settings and `htmlToPlainText`. Providers never log.
- `createGuardedEmbedder` puts a provider behind `CircuitBreaker`: three consecutive failures open it for 60 seconds, then one probe at a time decides. While open, `embed` rejects with `BreakerOpenError` without calling the provider; callers fall back to text search. A failure is logged once as `[embeddings] <provider id> call failed <label>`.
- `applyRelease` writes `posts.search_text` for both NRMS events and the legacy importer (`src/search/search-text.ts`: headlines, summary, keywords, location, subheadlines and bodies, capped at 100,000 characters so the generated tsvector never exceeds Postgres's 1 MB). v1 reads select every column except the two search columns.
- `GET /api/v2/search` lives in `src/http/v2/routes.ts` and `src/search/`. v2 is mounted before v1's `/api` router: no `api-version`, `no-store`, and a JSON 404 for unknown v2 paths. `createSearchService` takes an optional `semantic` branch, which returns a page or null; a null or a throw falls back to `textSearch`. The route never logs the query string, and the search handler carries an `AbortSignal` from the request to that branch, so the guarded embedder can treat a visitor closing the page as neutral to its breaker.
- No drizzle schema column uses the `vector` type. `post_embeddings.embedding` is `real[]`; the one custom migration (`0005_pgvector_optional`) wraps `CREATE EXTENSION vector` and the HNSW expression index on `embedding::vector(1536)` in a `DO` block that skips both on `insufficient_privilege` or `undefined_file`. `resolveSearchMode` (`src/embeddings/pgvector.ts`) decides the mode once at startup. Tests that need the SiteGround case use `createRestrictedNewsTestDb()`.
- Every projection write calls `recordChanges(tx, …)` (`src/changes.ts`) in its own transaction, as does the legacy importer's unpublish step. `recordChanges` takes one advisory lock (`[0x67637065, 4]`) before inserting, so change ids commit in order and a reader's cursor can't skip a late commit; it must stay the last lock a projection transaction takes. `410` is decided by `change_feed_state.pruned_through`, not `min(id)`, because rolled-back inserts leave gaps.
- `runEmbeddingTick` (`src/embeddings/worker.ts`) keeps `post_embeddings` to published posts only: it re-reads and row-locks the posts before writing, and skips any that were unpublished or rewritten during the provider call. The embedding source text is the first 8,000 characters of `posts.search_text`; its SHA-256 is stored as `posts.embedding_text_hash` on every post write, so finding changed posts is a plain comparison. `deleteSemanticRows` (`src/embeddings/rows.ts`) runs inside every unpublish.
- A batch that fails on the provider (not an open breaker) is split in half and retried, down to single posts, within the same tick, so one post a provider refuses can't hold up the others in the newest-50 window. A post that still fails alone is recorded in `post_embedding_failures` (one row per post, keyed by its `embedding_text_hash`), and the candidate query skips it until a rewrite changes that hash. The splitting is breadth-first (a FIFO queue), so the breaker's consecutive-failure count never reaches 3 from one poison post among healthy ones: a healthy sibling batch is always tried soon after a failing one, resetting the count. Provider calls per tick are capped at twice the batch size.
- The worker also looks for a published post with a current embedding but no `post_related` row (left behind by a restart between the embedding commit and the related computation) and recomputes just its related list, with no provider call, even in a tick that found nothing new to embed.
- The worker's row lock (`SELECT … FOR UPDATE`) uses `SKIP LOCKED`: a post a legacy import's bulk unpublish or `search-backfill --all` is locking is left for the next tick, so the two can never deadlock.
- `createSemanticSearch` (`src/search/semantic.ts`) embeds `normaliseForEmbedding(q)` through `QueryVectorCache`, then, in one read-only repeatable-read transaction, reads up to 1,000 vector keys by exact cosine distance (a `MATERIALIZED` CTE, so the HNSW index is never used for search) and fills the rest of the page with `textSearch(…, { excludeKeys, window })`. It returns null instead of throwing on any embed failure. Text mode's count and page share one snapshot too.
- `createRelatedService` (`src/search/related.ts`) serves `post_related` only while the startup search mode is semantic, filtered to published posts at read time, and otherwise the lead-ministry-and-tag fallback. v2 answers a malformed percent-encoded path with its own 400, unlogged.
- `POST /api/v2/internal/similar` is service-only, for NRMS (role `NewsApi.Similar`). It never stores, caches or logs the draft text it is sent, and only ever returns published posts.
- `GET /api/v2/site-settings` is public: `{ revision, publishedAt, document }`, 404 before the first publish.
- `npm run search:spot-check` runs 20 searches over a fictional corpus in a throwaway database and lists the top 5 for each. Text mode must find every expected post. With the stand-in provider the semantic column proves only that the plumbing works; set `EMBEDDINGS_PROVIDER=azure-openai` and the Azure settings to check real relevance once Azure is available (Q70).

## Public site

- Public pages are static files. When `render.ts` changes what every page bakes in, bump `RENDER_CHROME_VERSION` (`rebuild.ts`), so startup self-heal re-renders the pages already on disk.
- `npm run site:rebuild-all` (with the site's `DATABASE_URL`, `NEWS_API_URL`, `OUTPUT_DIR` and `PUBLIC_SITE_URL`) queues every page.
- `npm run site:quality` builds a fictional, production-config copy of the public site and runs axe (zero violations allowed) and Lighthouse (accessibility 95 or more; performance, best practices and SEO 90 or more) on every page type. It needs Playwright's Chromium (`npx playwright install chromium`). CI runs it as the `site-quality` job.
