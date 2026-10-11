# Public Site and AI (Phase 6) — Design Addendum

**Status:** decisions approved by Paul, 2026-10-11 (§2), design sections approved the same day. This document awaits written review.
**Parent spec:** `docs/superpowers/specs/2026-10-02-gcpe-news-platform-design.md`. The relevant parts are §3.3 (packages), §3.5 (tenant config), §5.5 (site fan-out), §6.2–6.3 (v2 API, embeddings), §10.1 (staff AI flag) and §11 (roadmap). Where this addendum and the parent disagree, this addendum wins for Phase 6. §13 lists what it supersedes.
**Companion lists (kept current as work proceeds):**
- `docs/parity/changes-from-legacy.md`: this phase adds C201 onward (§11).
- `docs/parity/open-questions.md`: this phase adds Q70 onward (§12).
- `docs/manuals/running-notes.md`: each sub-plan adds role-tagged lines.

**Reference implementation:** Media Hub 2.0, `~/media-hub-app/server/semantic/`:
- `embedding.ts`, `circuit-breaker.ts`, `hash.ts`, `query.ts`, `settings.ts` and `worker.ts`;
- the hybrid query in `server/storage.ts:1527-1570`.
Phase 6 copies its patterns, not its code.

## 1. Goal and scope

Give the platform a complete, accessible public site of its own, and add search, related posts and staff "similar item" help. BC's public site does not change at cutover (§2, D1).

**In scope:**
- tenant feature flags and a site theme in tenant config (§3);
- `packages/embeddings`: the provider interface, an Azure OpenAI provider, a stand-in provider and a circuit breaker (§4);
- News API: full-text search columns, an embeddings table, an embedding worker, and the v2 `search`, `posts/{key}/related` and `changes` routes (§5);
- the public site: every page type, a theme, monthly archives, feeds, a search page, incremental rebuilds, and carousel images as URLs (§6);
- staff help: a "Similar published releases" panel in the release editor, behind the staff-AI flag (§7);
- the exit check: axe-core, Lighthouse, and a search spot-check script (§9).

**Out of scope:**
- replacing BC's `gcpe-news-webapp`, and with it legacy URL redirects for news.gov.bc.ca. That is a later sub-phase if BC moves to the static site;
- French versions of public pages;
- AI on unpublished content except the explicit staff action in §7;
- AI-written text of any kind;
- AI on Calendar activities;
- chunked embeddings (one vector per post).

## 2. Decisions (Paul, 2026-10-11)

| # | Decision |
|---|---|
| D1 | **At cutover, BC keeps `gcpe-news-webapp`, repointed at the new News API.** The new static site is the product's default site, and BC's option later. No legacy database is needed after cutover: the webapp reads only the News API, whose posts come from the Phase 1 importer. |
| D2 | **Embeddings are built against a pluggable provider.** Tests and boxs.ca use a stand-in provider. Azure OpenAI (`text-embedding-3-small`, 1536 dimensions, Canada region) is connected later through configuration. A full-text fallback is always available. |
| D3 | **The site design is neutral, accessible and branded from tenant config.** Its page structure is familiar from news.gov.bc.ca. It is not a visual copy of it. |
| D4 | **Staff help is behind the staff-AI flag, off by default.** It runs on an explicit click, and falls back to full-text matching when the flag is off. The flag stays off until a privacy impact assessment approves it. |
| D5 | **Rendering extends `apps/public-site`'s existing template functions.** No templating engine and no static-site generator; pages are rebuilt incrementally. |

## 3. Tenant config (`packages/config`)

**Feature flags:** add `features: { semanticSearch: boolean, staffAi: boolean }` to `tenantConfigSchema`.
- Both default to `false`.
- Semantic search runs only when all three hold:
  - the flag is on;
  - a provider is configured;
  - the database has pgvector (§5.3).
- Staff AI is the same, plus D4's explicit action.

**Search language:** `search: { language: "english" | "french" | "simple" }`, a Postgres text-search configuration. BC uses `english`.

**Site theme:** `site.theme`:
- `colors`:
  - `primary`, `primaryText`, `accent`, `text`, `mutedText`, `surface`, `background` and `border`, all hex;
- `font`:
  - a family name and fallback stack;
  - an optional stylesheet URL;
- `logo`:
  - a path under the site's assets, with alt text;
- `siteName`;
- `footerLinks`:
  - a label and URL each.

**Contrast check:** the config loader refuses a theme where `text` on `background`, `text` on `surface` or `primaryText` on `primary` is below WCAG AA (4.5:1). The error names the failing pair.

**Example configs:**
- BC's config: BC Sans, BC blue `#013366` and gold `#FCBA19`, and BC's logo.
- New Brunswick's example config gets its own theme.

## 4. `packages/embeddings`

**Interface:** `EmbeddingProvider { id: string; model: string; dimensions: number; embed(texts: string[], signal): Promise<number[][]> }`.

**Providers:**
- `azureOpenAi`:
  - settings: endpoint, deployment, API key and API version, all from env;
  - `dimensions: 1536`, pinned in the request;
  - each call times out (default 1,000 ms, clamped to 200–5,000).
- `standIn`:
  - turns a SHA-256 hash of normalised text into a unit vector;
  - fixed output, so tests are repeatable;
  - texts that share words get closer vectors, so ranking tests mean something;
  - enabled with `EMBEDDINGS_PROVIDER=stand-in`. The deploy check refuses `stand-in` when `NODE_ENV=production`.
- No provider configured: `null`, which means full-text only.

**Circuit breaker:**
- states: closed, open and half-open;
- opens after 3 consecutive failures;
- 60-second cooldown;
- only one probe call at a time in half-open;
- `BreakerOpenError` lets callers fall back without calling the provider.

**Logging:** a provider call is never logged with its input text. Failures log `safeErrorLabel` and the provider id only.

## 5. News API (6a, 6b)

### 5.1 Full-text search (6a)

**New `posts` columns:**
- `search_text` (text): headline, summary, keywords, location and the body, HTML stripped and whitespace collapsed. The News API writes it on every post write (event intake and the legacy importer).
- `search_vector`: a generated `tsvector` column, `to_tsvector(<language>, search_text)`, with a GIN index.
  - The language is fixed per database at migration time. The migration uses `english`.
  - A tenant that needs another language changes it with its own migration; this is noted in the runbook.
  - Queries use the same configuration. At startup the News API checks that `search.language` (§3) matches the column's configuration and refuses to start if they differ.

**Backfill:** `news-api:search-backfill` fills `search_text` for existing rows. It is a dry run unless given `--confirm`, works in batches, and is safe to re-run.

### 5.2 Embeddings and the worker (6b)

**Table `post_embeddings`:**
- `post_key` (PK, FK → posts, cascade on delete);
- `provider`, `model`, `dimensions`;
- `text_hash` (SHA-256 of the source text);
- `embedding real[]`;
- `embedded_at`.

**Source text:** headline, summary and keywords, then the body, capped at 8,000 characters.

**The worker** runs on `/stack/tick`. It only works when the semantic-search flag is on and a provider is configured. Each tick it:
1. takes up to 50 **published** posts with no embedding, or whose `text_hash`, `model` or `dimensions` differ;
2. embeds them in one provider call;
3. upserts them;
4. recomputes their related posts (§5.4).
It stops for the tick when the breaker is open.

**Unpublishing:** in the same transaction that unpublishes a post, its `post_embeddings` and `post_related` rows are deleted.

**Drafts:** never embedded by the worker.

### 5.3 pgvector is optional

- No drizzle schema column uses the `vector` type, so every migration runs on a database without pgvector, SiteGround included (`docs/deploy/siteground.md:17-19`).
- One custom drizzle-kit migration (`drizzle-kit generate --custom`) runs a `DO` block. The block tries `CREATE EXTENSION IF NOT EXISTS vector` and an HNSW index on `(embedding::vector(1536)) vector_cosine_ops`, and catches `insufficient_privilege` and `undefined_file` to skip both.
- Where the extension appears later, a DBA can run the same statements, documented in the runbook.
- At startup the News API checks `pg_extension` for `vector`.
- `/stack/health` gains `newsApiSearch: "semantic" | "text"`. It is `semantic` only when the flag, the provider and pgvector are all present.

### 5.4 Routes

**`GET /api/v2/search?q=&ministry=&sector=&type=&from=&to=&page=`**

*Inputs:*
- `q` is 1–200 characters, trimmed;
- `page` runs from 1 to 50, with 20 per page;
- the dates are BC dates.

*Text mode:*
- `websearch_to_tsquery` against `search_vector`;
- ranked by `ts_rank_cd`, then newest first;
- filters apply in SQL.

*Semantic mode:*
1. Embed `q`. The vector is cached for 5 minutes per normalised query, at most 5,000 entries, oldest dropped first.
2. Vector branch: published posts whose cosine distance is at or below the threshold (default 0.6, from env), nearest first.
3. Text branch: posts not already matched, as in text mode.
4. The vector branch comes first, then the text branch. This follows Media Hub's two-group order.

*Fallback:* if the provider fails or the breaker is open, the route serves text mode. The response says which: `"mode": "text"`.

*Response:* `{ mode, page, total, results: [{ key, kind, headline, summary, publishDate, leadMinistryKey, url }] }`.

*Logging and caching:* the access log records the route only, never the query string. `Cache-Control: no-store`, as on every dynamic route.

**`GET /api/v2/posts/{key}/related`:**
- up to 5 posts from `post_related`;
- unknown or unpublished key → 404;
- no row yet → the text fallback: newest published posts that share the lead ministry and at least one tag, excluding itself.
- **Table `post_related`:** `post_key` (PK), `related_keys text[]`, `computed_at`.
  - Computed by the worker as the 5 nearest published neighbours.
  - Recomputed when the post is re-embedded.
  - Other posts' lists are not recomputed on each publish. Their lists refresh when they are re-embedded.

**`GET /api/v2/changes?after=<cursor>&limit=`:**
- **Table `changes`:** a `bigserial` id, `kind`, `key`, `at`. The kind is one of:
  - `post.upserted`, `post.unpublished`;
  - `home`, `slides`, `resource_links`;
  - `ministry`, `sector`, `theme` or `tag`.
- **Writing it:** a row is written in the same transaction as each projection write.
- **Reading it:**
  - ordered by id, with a limit of up to 500;
  - `after` is the last id seen;
  - the response includes `next`.
- **Retention:** rows older than 90 days are pruned on tick. A cursor older than the oldest row gets `410` with `{ "resync": true }`.
- **Authentication:** service token only. It is for the site builder, not the public.

**`POST /api/v2/internal/similar`:** §7.

## 6. Public site (6c)

### 6.1 Pages

| Page | Path | Content |
|---|---|---|
| Home | `/` | Emergency banner, carousel, top and feature posts, latest 20, resource links |
| Release | `/releases/<key>/` | As today, plus related posts (from the API), media assets, translation links |
| Ministries | `/ministries/` | Every active ministry with its minister |
| Ministry | `/ministries/<key>/` | Details, minister, contacts, latest 20, links to monthly archives |
| Sector, theme, tag | `/sectors/<key>/`, `/themes/<key>/`, `/tags/<key>/` | Latest 20, links to monthly archives |
| Monthly archive | `/archive/<yyyy>/<mm>/` | Every published post that month, newest first |
| Archive index | `/archive/` | Year and month links with counts |
| Search | `/search/` | A form plus a script calling `/api/v2/search`. Without JavaScript, a short message and links to the archives |
| Feeds | `feed.xml` on home, each ministry, sector, theme and tag | RSS 2.0, latest 20 |
| Sitemap | `/sitemap.xml` (an index) and `/sitemaps/<yyyy>-<mm>.xml` | Published posts and index pages |
| robots.txt, 404 | `/robots.txt`, `/404.html` | Test sites keep `noindex` and `Disallow: /` |

**Why monthly archives:** numbered pages ("page 2, 3, …") would shift with every publish. A month's archive changes only when one of its posts does.

### 6.2 Incremental rebuild

| Trigger | Rebuilds |
|---|---|
| A post is published, updated or unpublished | the post's page (written or removed); its ministry, sector, theme and tag pages and feeds; its month's archive and the archive index; home and the home feed; its month's sitemap |
| Home, slides or resource links change | Home |
| A ministry, sector, theme or tag changes | That index page and its feed now. Its release pages are queued, 100 per tick |
| Templates change (a deploy) | `site:rebuild-all`, which queues every page and drains 200 per tick |
| The site builder was down | It reads `/api/v2/changes` from its stored cursor and maps each change to the triggers above. A `410` queues a full rebuild |

- **The queue:** a `rebuild_queue` table in the public site's database, holding a page id and when it was queued. Each page appears at most once. It is drained on tick.
- **The cursor:** stored in the same database.
- **Startup:** the existing self-heal at startup stays.

### 6.3 Theme and accessibility

- `theme.css` is generated from `site.theme` as CSS variables. The templates use only those variables.
- The theme's font stylesheet is linked only when configured.
- **The standard is WCAG 2.2 AA:**
  - a skip link;
  - `header`, `nav`, `main` and `footer` landmarks;
  - one H1 per page;
  - visible focus;
  - `lang` set on every page;
  - alt text from asset data; an asset without any becomes decorative (`alt=""`) with its caption as text;
  - the contrast check in §3.

### 6.4 Carousel images (C42)

- Slide events carry image URLs served by NRMS, instead of base64 bytes.
- `SLIDES_EVENT_BUDGET_BYTES` is retired.
- The public site links the image URL. It does not copy the bytes.

## 7. Staff help (6d)

**Where:** a "Similar published releases" panel in the staff app's release editor, for roles that can edit releases.

**Behaviour:**
- Nothing runs until **Find similar** is clicked.
- Results: up to 10 published posts, with headline, date, lead ministry, a public link and a *Text match* or *AI match* label.
- While the staff-AI flag is on, the button reads: "Sends this draft's text to the AI service to compare."

**Route:** NRMS calls `POST /api/v2/internal/similar` with `{ text, mode: "ai" | "text" }`.
- **Authentication:** a bearer service token, the same pattern as NRMS's calls to NoD, Core and Distribution (`apps/nrms/src/clients.ts`). It is never public.
- **Text:** headline, summary, keywords and the body with HTML stripped, capped at 8,000 characters.

**Matching:**
- `mode: "ai"` is honoured only when the News API's own tenant config has `staffAi` on, a provider is configured and pgvector is present. Otherwise the route answers in text mode and says so.
- NRMS also refuses to send `ai` when its own flag is off. That makes two independent checks.
- Text mode: `websearch_to_tsquery` over the draft's headline and keywords.

**Privacy:**
- The draft text is never stored, cached or logged by either app. The query-vector cache in §5.4 is not used for this route.
- Results contain only published posts.

## 8. Error handling and operations

- **Provider and breaker:** a failure or open breaker gives text mode, never an error to the visitor. The worker skips the tick.
- **Missing pgvector:** text mode, reported in health.
- **v2 route errors:** `safeErrorLabel` plus the route.
- **The change feed:** `410 resync` triggers a full rebuild through the queue.
- **Runbook additions:**
  - the search backfill;
  - `site:rebuild-all`;
  - enabling pgvector;
  - the Azure settings;
  - turning flags on;
  - the PIA gate for staff AI.

## 9. Testing and exit

**Unit:**
- the provider contract;
- the stand-in's fixed output;
- breaker state changes;
- HTML stripping;
- the contrast check;
- the rebuild-set function, i.e. which pages each change rebuilds.

**Integration (real Postgres):**
- full-text ranking and filters;
- semantic-plus-text ordering with the stand-in provider;
- related posts and their fallback;
- change-feed order, pruning and `410`;
- unpublishing removes embeddings and related posts.

**Migrations without pgvector:**
- Run every migration as a role that cannot `CREATE EXTENSION` (the SiteGround case). They succeed and health says `text`.
- Run as a role that has it: vector search turns on.

**Staff-AI flag enforcement:** with the flag off on the News API, a spy provider records zero calls for `mode: "ai"`, even when NRMS's flag is on.

**E2E (Playwright):**
- publish → release, ministry, archive, home and feed pages exist;
- the search page returns results;
- unpublishing removes the release page and its entries;
- the staff panel works in text mode, and in AI mode with the stand-in provider.

**Exit (6e):**
- **axe-core** (`@axe-core/playwright`, a development dependency): zero violations on each page type.
- **Lighthouse,** run locally and in CI against a built fixture site:
  - accessibility ≥ 95;
  - performance ≥ 90;
  - best practices ≥ 90;
  - SEO ≥ 90 on a production-config build only.
- **Search spot-check:** `scripts/search-spot-check.ts` runs about 20 query → expected-key pairs and reports top-5 hits.
  - With the stand-in provider it proves only the plumbing.
  - **The relevance check proper waits for an Azure key** (Q70). The exit notes say so.

## 10. Sub-phases

| Sub-phase | Delivers | Depends on | Review |
|---|---|---|---|
| 6a | §3, §4, §5.1, and v2 `search` in text mode | — | full: search route, logging |
| 6b | §5.2–5.4 (worker, pgvector option, semantic search, related, changes) | 6a | full: migrations, change feed, unpublish cleanup |
| 6c | §6 | 6a, 6b | shared for templates; full for the rebuild queue |
| 6d | §7 | 6a, 6b | full: internal route, flag enforcement, privacy |
| 6e | §9 exit and docs | all | controller check plus the final review |

Each sub-phase deploys to boxs.ca and opens a PR for Paul to merge.

## 11. Changes from legacy (C201 onward)

| # | Legacy | New |
|---|---|---|
| C201 | news.gov.bc.ca had no API search or related-posts endpoint. | v2 search, related posts and a change feed beside v1. v1 is unchanged. |
| C202 | — | The platform's own static site uses monthly archives, not numbered pages, and has no legacy URL redirects (BC keeps its webapp, D1). |
| C203 | — | Staff "Similar published releases", behind a flag that is off until a PIA. |
| C204 | Carousel images travelled inline (C42's budget). | Slide events carry image URLs. |

## 12. Open questions (Q70 onward)

| # | Question | Working assumption |
|---|---|---|
| Q70 | Who provides the Azure OpenAI deployment (`text-embedding-3-small`, Canada region), and when? | Stand-in provider until then; relevance spot-checks wait. |
| Q71 | Who owns the PIA for staff AI on drafts, and is one also needed for embedding *published* releases? | Published content needs none; drafts need one; flag stays off. |
| Q72 | Do old release pages link straight to Azure Blob storage (Q13), and will the importers copy and rewrite those links? | To be checked in Phase 7; it affects cutover under any option. |
| Q73 | Does BC want its webapp to show v2 search or related posts before any move to the static site? | No. That needs a change to `gcpe-news-webapp`, outside this platform. |

## 13. What this addendum supersedes

- Parent §3.3 calls the app `public-site` in one place and "site builder" elsewhere. This addendum uses `apps/public-site`.
- Parent §6.2: related posts are "precomputed on publish". Here they are computed when the post is embedded (§5.4), so other posts' lists refresh only on re-embedding.
- Parent §3.4: pgvector is optional at runtime (§5.3), not a hard requirement.
