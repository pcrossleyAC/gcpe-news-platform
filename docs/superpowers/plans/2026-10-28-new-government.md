# New Government Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a new government into one Hub form ("Start new government term") plus one guided ministry hand-over (later, one staged cabinet change). The public archive by term and the redirects follow by themselves.

**Architecture:**
- **Terms.** NRMS owns dated government terms. A tick-driven rollover publishes a `government_terms.published` snapshot. News API stores and serves it, and the static public site renders `/archive/terms/…` from it, with posts placed by their BC publish day.
- **Succession.** Core owns ministry succession. One transaction sets `successorKeys`, moves staff and the abbreviation, and emits `org.succeeded`. NoD, Calendar and NRMS then move their own rows idempotently. The public site writes a successor map that a stack middleware turns into 301s.
- **Cabinet change.** The staged cabinet change (last group) is a Core draft that replays the same service functions in one transaction.

**Tech Stack:** TypeScript, Express + zod, drizzle-orm + drizzle-kit migrations (Postgres), React + `@bcgov/design-system-react-components` (staff-web), vitest + supertest + Testing Library, `@gcpe/events` outbox/dispatcher.

**Spec:** `docs/superpowers/specs/2026-10-28-new-government-design.md`

## Global Constraints

- Term boundary rule: a post belongs to the term with the latest `startDate` ≤ its BC calendar day (`substr(publish_date,1,10)` on the site, `(publish_at AT TIME ZONE tz)::date` in NRMS). `endDate(prev) = startDate(next) − 1 day`. No overlap.
- Range copy, exact: open term `"{Month D, YYYY} to current date"`; closed term `"{start} to {end}"`, e.g. `"November 26, 2020 to November 17, 2024"`.
- New term slug = ISO start date. Imported slugs are unchanged. Slug regex `/^[a-z0-9-]{1,40}$/`. `current` is reserved.
- Scheduled (future) terms never appear in the public payload.
- Government terms: NRMS routes require `Core.Admin`; the Hub nav item is shown only to `Core.Admin`. Succession and cabinet-change routes: `Core.Admin`.
- Event names: `government_terms.published` (source `nrms`) and `org.succeeded` (source `core`). Never use bare `term.*`; that family is sectors, themes and tags.
- No changes to `apps/public-site/src/render.ts`, the header, the footer, theme CSS or `RENDER_CHROME_VERSION` (parity owns them).
- No `window.confirm`/`alert`. Confirmations are in-page, following the Organizations screen.
- Default timezone for tests: `America/Vancouver`. Use `TestClock` (`@gcpe/db-kit`) for "now".
- Test command: `npx vitest run <path>`. For a migration: `npm --workspace @gcpe/<app> run db:generate`, then hand-add any data `UPDATE`s to the generated SQL.

## Review Focus

1. **A release published at 23:59 Pacific on the eve of the swearing-in, and one at 00:00, in a DST month.** Expected: the first lists under the old term and the second under the new, on the site and in NRMS's `term_id`. Pinned in Task 2 (`stamps the term by BC day at first publish`) and Task 6 (`places boundary posts by BC day`).
2. **The term date is entered weeks ahead, and nothing is published on swearing-in day.** Expected: the archive index, the `current` alias and the sitemap still roll over after midnight, with no human action. Pinned in Task 2 (`tick emits once when a scheduled term starts`) and Task 6 (`a government_terms change queues every term page`).
3. **`org.succeeded` is delivered twice, and a subscriber is on both A and B.** Expected: exactly one B subscription and one history line, and the second delivery is a no-op. Pinned in Task 9.
4. **Chained or cyclic succession (A→B, later B→C; or A→B→A by mistake).** Expected: `/ministries/a/` 301s straight to C, and a cycle produces no redirect and no hang. Core refuses to create a cycle in the first place. Pinned in Task 8 and Task 12.
5. **A brand-new term on its first morning (0 posts), and a 5-week term like `2017-2017`.** Expected: the term page renders "Nothing has been published in this term yet." (200, not 404), `current` exists, and short terms list correctly. Pinned in Task 6.

---

## Group A: Government terms (C2)

### Task 1: NRMS dated terms model, backfill and spans

**Files:**
- Modify: `apps/nrms/src/db/schema.ts` (`governmentTerms`: add `startDate: date("start_date", { mode: "string" })`, `label: text("label")`, `legacyArchiveUrl: text("legacy_archive_url")`, `createdAt`; unique index `government_terms_start_date_idx` on `start_date` where not null; new single-row table `governmentTermsPublished(id int pk default 1 check id=1, hash text not null, publishedAt tz not null)`)
- Create: `apps/nrms/migrations/0017_government_term_dates.sql` (generated, plus the backfill `UPDATE … FROM (VALUES …)` with the 9 rows from spec §2 and the `legacy_archive_url` values)
- Create: `apps/nrms/src/government-terms.ts`, `apps/nrms/src/government-terms.test.ts`
- Modify: `apps/nrms/src/import/reference.ts` (remove the `is_current` winner block from `importTerms`; keep the upsert by legacy id), `apps/nrms/src/import/reference.test.ts` (replace the three "current" assertions with `importer leaves is_current alone`), `apps/nrms/src/db/migrations.test.ts`

**Interfaces:**
- Produces: `type TermStatus = "past" | "current" | "scheduled" | "undated"`.
- Produces: `interface TermSpan { id: string; slug: string; label: string | null; startDate: string | null; endDate: string | null; status: TermStatus; legacyArchiveUrl: string | null; legacyId: string | null }`.
- Produces: `termSpans(rows: (typeof governmentTerms.$inferSelect)[], today: string): TermSpan[]`. Pure. Dated rows come first, oldest → newest; undated rows come last. `endDate` is computed against the next *dated* row, including scheduled ones (Hub view).
- Produces: `publicTerms(spans: TermSpan[]): GovernmentTermsPayload["terms"]`. Only `past`/`current`, newest first; the newest has `endDate: null`.
- Produces: `addDays(isoDate: string, n: number): string` (UTC date arithmetic on `YYYY-MM-DD`).

- [ ] **Step 1: Write failing tests** in `government-terms.test.ts`:
  - `computes non-overlapping ranges`: rows starting `2020-11-26`, `2024-11-18`, today `2026-10-28` → `[{startDate:"2020-11-26", endDate:"2024-11-17", status:"past"}, {startDate:"2024-11-18", endDate:null, status:"current"}]`.
  - `a future term is scheduled and closes the current one in the Hub view only`: add `2028-11-20` → the current row has `endDate === "2028-11-19"`; `publicTerms(...)` has 2 entries, and the newest has `endDate === null`.
  - `undated rows are listed last and never current`.
  - `the day of the start date is current`: today `2028-11-20` → that row is `current`.
  - In `migrations.test.ts`, `backfills legacy start dates`: insert the 9 legacy names before migrating forward (or run the backfill SQL against seeded rows) → `2017-2021` has `start_date = '2017-07-18'`, and `2024-2028` has `legacy_archive_url` ending `index_current.htm`.
- [ ] **Step 2: Run** `npx vitest run apps/nrms/src/government-terms.test.ts apps/nrms/src/db/migrations.test.ts`. Expected: FAIL (module/columns missing).
- [ ] **Step 3: Implement** the schema, the migration (generate, then append the backfill), the functions, and the importer change.
- [ ] **Step 4: Run** the same tests plus `npx vitest run apps/nrms/src/import`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(nrms): dated government terms with generated spans`

### Task 2: Rollover, event and publish-time stamping

**Files:**
- Modify: `packages/events/src/catalogue.ts` (add `governmentTermsPublishedSchema` and register `"government_terms.published"`), `packages/events/src/catalogue.test.ts`
- Modify: `apps/nrms/src/government-terms.ts` (add `syncGovernmentTerms`), `apps/nrms/src/website/carousel.ts` (`startSiteLoop` opts gain `timeZone: string`; each tick also calls `syncGovernmentTerms` in its own transaction, logging and swallowing errors like the carousel switch), `apps/nrms/src/start.ts` (`workers.governmentTerms`)
- Modify: `apps/nrms/src/releases/workflow.ts` (remove the `termId` stamp at lines 98-102), `apps/nrms/src/publisher.ts` (set `termId` on first go-live), and the tests `workflow.test.ts` and `publisher.test.ts`
- Modify: `apps/news-api/src/projections.ts` `SOURCE_EVENT_TYPES.nrms` to accept `government_terms.published`. This routes the event automatically via `newsApiEventTypesFromNrms` once Task 5 adds the handler.

**Interfaces:**
- Produces (events): `governmentTermsPublishedSchema = z.object({ publishedAt: offsetDateTime, currentSlug: z.string().nullable(), terms: z.array(z.object({ slug: z.string().min(1), label: z.string().nullable(), startDate: isoDate, endDate: isoDate.nullable(), legacyArchiveUrl: z.string().nullable() })) })`, where `isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)`. Also `type GovernmentTermsPayload`.
- Produces: `GOVERNMENT_TERMS_LOCK = [0x67637065, 8] as const`.
- Produces: `syncGovernmentTerms(tx: Tx, opts: { timeZone: string; subscribers: SubscriberConfig[]; now?: TestClock }): Promise<{ emitted: boolean }>`. It takes the lock, computes `today` (the BC date of the DB `now()`), sets `is_current` to the derived current term (clearing others first), builds the payload, and compares `sha256(JSON of currentSlug+terms)` with `government_terms_published.hash`. When they differ, it upserts the row and enqueues the event (`aggregateId: "government-terms"`).

- [ ] **Step 1: Write failing tests:**
  - `tick emits once when a scheduled term starts`: terms `2024-11-18` and `2028-11-20`. With the clock at `2028-11-20T07:59:00Z` (23:59 PST), the first call returns `{emitted:true}` (first publish) and the second `{emitted:false}`. With the clock at `2028-11-20T08:00:00Z`, the call returns `{emitted:true}`, the outbox event has `currentSlug === "2028-11-20"`, and `is_current` is on that row only.
  - `scheduled terms are not in the payload`.
  - `stamps the term by BC day at first publish` (`publisher.test.ts`): `publishAt = 2028-11-20T07:59:00Z` → `term_id` = the old term; `08:00:00Z` → the new one. A correction republish does not change `term_id`.
  - `approval leaves term_id null` (`workflow.test.ts`, replacing the existing non-null assertion at line 40-41).
  - The catalogue round-trips a sample payload and rejects `startDate: "2028-11-20T00:00"`.
- [ ] **Step 2: Run** `npx vitest run apps/nrms/src/government-terms.test.ts apps/nrms/src/publisher.test.ts apps/nrms/src/releases/workflow.test.ts packages/events`. Expected: FAIL.
- [ ] **Step 3: Implement.** In the publisher, inside the existing go-live `UPDATE`, when `first`: `termId: sql\`(SELECT id FROM government_terms WHERE start_date <= (${newsReleases.publishAt} AT TIME ZONE ${timeZone})::date ORDER BY start_date DESC LIMIT 1)\``.
- [ ] **Step 4: Run** the same tests. Expected: PASS. Then run `npx vitest run apps/nrms`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(nrms): government term rollover publishes a snapshot; stamp term at publish`

### Task 3: NRMS government-term routes

**Files:**
- Modify: `apps/nrms/src/government-terms.ts` (`listGovernmentTerms`, `createGovernmentTerm`, `updateGovernmentTerm`, `deleteGovernmentTerm`, each calling `syncGovernmentTerms` in the same transaction)
- Create: `apps/nrms/src/http/government-term-routes.ts`, `apps/nrms/src/http/government-term-routes.test.ts`
- Modify: `apps/nrms/src/app.ts` (mount next to `siteRoutes`, before `express.json`; give the router its own `express.json({ limit: "10kb" })`)
- Modify: `packages/nrms-contract/src/` (add `GovernmentTermView` and `GovernmentTermInput` types for staff-web)

**Interfaces:**
- Produces: `GovernmentTermView = TermSpan & { releaseCount: number }` (count of `news_releases.term_id`).
- Routes, all `requireRole("Core.Admin")`:
  - `GET /api/government-terms` → `{ today: string; terms: GovernmentTermView[] }`, newest first.
  - `POST /api/government-terms` with `{ startDate: string; label?: string | null }` → 201 `GovernmentTermView`. The slug is `startDate`.
  - `PATCH /api/government-terms/:id` with `{ startDate?, label?, legacyArchiveUrl? }` → 200. `legacyArchiveUrl` must be `https:` or null. For a scheduled term without a `legacyId`, the slug follows `startDate`.
  - `DELETE /api/government-terms/:id` → 204 when scheduled.
- Errors are `409 { error: string }` with exact copy:
  - `"A new term must start after {Month D, YYYY}."`
  - `"Must be after {prev} and before {next}."` (when a neighbour is missing, the clause is dropped: `"Must be after {prev}."`)
  - `"Only a term that hasn't started can be deleted."`
  - `"Another term already starts on that date."`
- Produces: `formatLongDate(iso: string): string` → `"November 18, 2024"`, exported from `packages/nrms-contract` so staff-web reuses it.

- [ ] **Step 1: Write failing route tests:**
  - `lists terms with status and range` (an admin token; the today date comes from the TestClock).
  - `creates a scheduled term and publishes nothing yet`: the outbox has no new `government_terms.published` (the payload is unchanged).
  - `creates a term dated today and publishes`: an outbox event with the new `currentSlug`.
  - `refuses a start not after the latest` → 409 with the exact copy.
  - `refuses a date equal to another term's`.
  - `bounds an edit between neighbours`: editing `2020-2024` to `2024-11-18` → 409 `"Must be after July 18, 2017 and before November 18, 2024."`
  - `slug follows date while scheduled; frozen after start`.
  - `deletes only scheduled terms`.
  - `403 for NRMS.SiteEditor, 401 without a token`.
  - `400 for http legacy URL`.
- [ ] **Step 2: Run** `npx vitest run apps/nrms/src/http/government-term-routes.test.ts`. Expected: FAIL (404).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(nrms): government term admin API`

### Task 4: Hub "Government terms" screen

**Files:**
- Create: `apps/staff-web/src/screens/admin/government-terms/GovernmentTermsScreen.tsx`, `GovernmentTermsScreen.test.tsx`, `StartTermForm.tsx`
- Modify: `apps/staff-web/src/router.tsx` (`{ path: "government-terms", element: <GovernmentTermsScreen /> }` beside `organizations`), `apps/staff-web/src/shell/AppShell.tsx` (`{ to: "/government-terms", label: "Government terms", show: isCoreAdmin }` after Organizations), `apps/staff-web/src/screens/admin/a11y.test.tsx`

**Interfaces:**
- Consumes: Task 3 routes via `/nrms/api/government-terms`, plus `GovernmentTermView` and `formatLongDate` from `@gcpe/nrms-contract`.

- [ ] **Step 1: Write failing tests:**
  - `shows generated ranges and statuses`: a row has the text "November 18, 2024 to current date" and the status "Current". A scheduled row shows "Scheduled: starts November 20, 2028".
  - `start a new term asks, confirms and saves`: fill the date `2028-11-20`. The confirmation text is "Start a new government term on November 20, 2028? The current term will end November 19, 2028. Releases published from that day are listed under the new term." Confirm → POST body `{ startDate: "2028-11-20", label: null }`, then a success status "Saved. The archive switches to the new term on November 20, 2028."
  - `shows the 409 message from the server inline`.
  - `edit label and legacy URL; delete offered only on scheduled rows`.
  - `undated rows say "Needs a start date"`.
  - The a11y test: no violations.
- [ ] **Step 2: Run** `npx vitest run apps/staff-web/src/screens/admin/government-terms`. Expected: FAIL.
- [ ] **Step 3: Implement**, following `OrganizationsScreen.tsx` patterns: in-page confirm, and focus returned to the triggering button.
- [ ] **Step 4: Run** the same tests plus `npx vitest run apps/staff-web/src/router.test.tsx apps/staff-web/src/screens/admin/a11y.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(staff-web): Government terms screen`

## Group B: Public archive by term (C3)

### Task 5: News API stores and serves the term snapshot

**Files:**
- Modify: `apps/news-api/src/db/schema.ts` (single-row `governmentTerms` table: `id int pk default 1 check id=1`, `publishedAt tz`, `document jsonb $type<GovernmentTermsPayload>`; add `'government_terms'` to `changes_kind_check` and to `ChangeKind`)
- Create: `apps/news-api/migrations/0010_government_terms.sql`
- Modify: `apps/news-api/src/projections.ts` (handler `"government_terms.published"` → `applyGovernmentTerms`), `apps/news-api/src/http/v2/routes.ts` (`GET /government-terms`)
- Create: `apps/news-api/src/http/v2/government-terms.test.ts`
- Modify: `apps/stack/src/env.test.ts` if it snapshots `newsApiEventTypesFromNrms()`

**Interfaces:**
- Produces: `applyGovernmentTerms(tx: Tx, p: GovernmentTermsPayload): Promise<void>`. It applies only when `p.publishedAt` is later than the stored value, and then records change `{ kind: "government_terms", key: null }`.
- Produces: `GET /api/v2/government-terms` → 200 `GovernmentTermsPayload`, or 404 `{ error: "not found" }`.

- [ ] **Step 1: Write failing tests:**
  - `404 before any payload`.
  - `stores and serves a payload`.
  - `an older publishedAt is ignored and records no change`.
  - `a newer one replaces and records one 'government_terms' change`.
  - `newsApiEventTypesFromNrms includes government_terms.published`.
- [ ] **Step 2: Run** `npx vitest run apps/news-api/src/http/v2/government-terms.test.ts apps/stack/src/env.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, following `applySiteSettings` (`projections.ts:276-290`).
- [ ] **Step 4: Run** the same tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(news-api): government terms snapshot and v2 endpoint`

### Task 6: Public site term pages

**Files:**
- Modify: `apps/public-site/src/site-paths.ts`:
  - `PageId` gains `{ type: "archive-terms" } | { type: "archive-term"; slug: string }` (the slug `current` included).
  - `TERM_SLUG`.
  - `parsePageId`, `formatPageId`, `pageFiles` (`archive/terms/index.html`, `archive/terms/<slug>/index.html`) and `pageUrl`.
- Modify: `apps/public-site/src/dto.ts` (`GovernmentTermsDto`), `apps/public-site/src/news-api-client.ts` (`governmentTerms(): Promise<GovernmentTermsDto | null>` via `api/v2/government-terms`, 404 → null)
- Modify: `apps/public-site/src/post-index.ts` (`inDayRange(start: string, endExclusive: string | null): Promise<IndexedPost[]>`, `countInDayRange(start, endExclusive): Promise<number>`)
- Modify: `apps/public-site/src/pages/archive.ts` (`renderTermsIndex`, `renderTermPage`, `termRangeLabel`; `renderArchiveIndex` gains the "Browse by government term" link)
- Modify: `apps/public-site/src/rebuild-set.ts` (`Membership.day`; `dependentPages(before, after, termOf?: (day: string) => { slug: string; isCurrent: boolean } | null)`), `apps/public-site/src/builder.ts` (render cases, `aggregatePageIds`, `sitemap-pages`, a per-run cached `governmentTerms()`, and passing `termOf` at lines 74 and 93), `apps/public-site/src/change-feed.ts` (`ChangeKind` gains `"government_terms"`; `pagesForChange` returns `archive-terms` and `archive-term:current` at live priority. Every term page is added by `syncChanges` through the builder's terms, like category release pages)
- Tests: `site-paths.test.ts`, `pages/archive.test.ts`, `rebuild-set.test.ts`, `builder.test.ts`, `change-feed.test.ts`

**Interfaces:**
- Consumes: `GET /api/v2/government-terms` (Task 5).
- Produces: `termRangeLabel(startDate: string, endDate: string | null): string`.
- Produces: `renderTermsIndex(rows: { term: GovernmentTermDto; count: number }[], site: SiteInfo, opts?: PageOptions): string`.
- Produces: `renderTermPage(term: GovernmentTermDto, posts: IndexedPost[], site: SiteInfo, opts: PageOptions & { canonicalSlug?: string }): string`.
- Copy (exact):
  - index h1 `"News archive by government term"`;
  - term h1 `"News from {range}"`;
  - empty term `"Nothing has been published in this term yet."`;
  - legacy-only row link text `"{range} (legacy news archive)"`;
  - mixed row note `"Earlier releases from this term are on the legacy news archive."`;
  - footer line `"Releases from before 2012 are on the legacy news archive (archive.news.gov.bc.ca)."`.

- [ ] **Step 1: Write failing tests:**
  - `termRangeLabel("2024-11-18", null) === "November 18, 2024 to current date"`; `termRangeLabel("2020-11-26","2024-11-17") === "November 26, 2020 to November 17, 2024"`.
  - `places boundary posts by BC day`: posts with `publishDate` `2028-11-19T23:59:00-08:00` and `2028-11-20T00:00:00-08:00` → one on each term page, never both.
  - `a short term lists only its weeks`: `2017-2017` (06-12 → 07-17) with posts on 07-17 and 07-18 → only 07-17.
  - `empty current term renders the empty copy and the current alias canonicalises to the slug`: the `archive/terms/current/index.html` canonical href ends `/archive/terms/2028-11-20/`.
  - `adding a term links it from the index with no other change` (the crawler property): build the index with 2 terms, then with 3, and assert that the new `href` is present and the term page exists.
  - `legacy-only terms link out and get no page`: `pre2001` with 0 posts → the row `href` is its `legacyArchiveUrl`, and `pageFiles` for it is not written.
  - `a government_terms change queues every term page` (`syncChanges`/builder): the queued ids ⊇ `archive-terms`, `archive-term:current`, and every public slug.
  - `a post change queues its term page`: `dependentPages(null, {month, day:"2024-12-01", categories:[]}, termOf)` includes `archive-term:2024-11-18`, `archive-term:current` and `archive-terms`.
  - `parsePageId rejects archive-term:../x and accepts archive-term:2017-2017`.
  - `sitemap pages list /archive/terms/ and each term page`.
- [ ] **Step 2: Run** `npx vitest run apps/public-site/src`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** Term pages use `renderPage(title, site, canonicalPath, body, opts)` with `<ul class="post-list">` items `<li><a href>{headline}</a> <time datetime>{date}</time></li>` (no summary).
- [ ] **Step 4: Run** `npx vitest run apps/public-site`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(public-site): archive by government term`

## Group C: Archive continuity (C1)

### Task 7: Coverage check, admin manual and decision records

**Files:**
- Create: `scripts/archive-coverage-check.ts`, `tests/archive-coverage-check.test.ts`
- Create: `docs/manuals/new-government.md` (spec §6 table, screen names, and the one-time cutover actions from spec §1)
- Modify: `docs/parity/changes-from-legacy.md`:
  - C11 → "Done: dated terms; current derived from the start date";
  - new rows: "archive by term replaces archive.news.gov.bc.ca for 2012+ (C1, pending owner)", "posts listed by publish day, not draft-time collection (N1)", "old ministry URLs 301 to successor (legacy 404s)", "abbreviation unique among active ministries only".
- Modify: `docs/parity/open-questions.md` (add Q-NG1…Q-NG7 from spec §9; cross-reference Q53 from Q-NG2)

**Interfaces:**
- Produces: `extractKeys(html: string): string[]`. Keys are taken from `href`s matching `/releases/news_releases_[^/]+/([^/]+)\.htm`, de-duplicated.
- Produces: `missingKeys(keys: string[], fetchPosts: (keys: string[]) => Promise<{ key: string }[]>, batch = 100): Promise<string[]>`. The match is case-insensitive.
- CLI: `npx tsx scripts/archive-coverage-check.ts --news-api <url> <index.htm path or URL>…`. It prints `checked N, missing M`, lists the missing keys, and exits 1 if M > 0. Fetches run at ≤ 1 req/s.

- [ ] **Step 1: Write failing tests:** `extractKeys` on a fixture holding 3 links (one slug-style key, one duplicate) → 2 keys; `missingKeys` with a fake that knows `2026WLRS0042-000965` (lowercase in the fake) → reports only the other key; batching splits 250 keys into 3 calls.
- [ ] **Step 2: Run** `npx vitest run tests/archive-coverage-check.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the script and write the two doc edits and the manual.
- [ ] **Step 4: Run** the same test. Expected: PASS.
- [ ] **Step 5: Commit** `feat: archive coverage check; new-government manual and decision records`

## Group D: Successor ministry (C4)

### Task 8: Core succession service, route and abbreviation rule

**Files:**
- Modify: `packages/events/src/catalogue.ts`:
  - `orgRecordSchema.successorKeys: z.array(z.string()).default([])`;
  - `orgSucceededSchema` registered as `"org.succeeded"`.
- Modify: `apps/core/src/db/schema.ts` (`successorKeys: text("successor_keys").array().notNull().default(sql\`'{}'::text[]\`)`), plus a generated `apps/core/migrations/0006_org_successors.sql`
- Modify: `apps/core/src/services/organizations.ts`:
  - `toOrgRecord` includes `successorKeys`;
  - `assertAbbreviationFree` adds `eq(organizations.isActive, true)`;
  - reactivation (the `isActive: true` patch path) clears `successorKeys`;
  - new `succeedOrganization`, `successionPreview`.
- Modify: `apps/core/src/http/routes.ts`; tests in `apps/core/src/http/routes.test.ts` and `apps/core/src/services/organizations.test.ts`
- Modify: `apps/stack/src/env.ts` `INTERNAL_EVENT_ROUTES` (add `"org.succeeded"` to Core → NRMS, NoD and CALENDAR), `apps/stack/src/env.test.ts`
- Modify: `apps/staff-web/src/screens/admin/organizations/OrganizationEditForm.tsx` (`deactivateWarning` copy stays; the panel arrives in Task 13)

**Interfaces:**
- Produces: `orgSucceededSchema = z.object({ key: z.string().min(1), successorKeys: z.array(z.string().min(1)).min(1), moveSubscribers: z.boolean(), moveCalendar: z.boolean(), moveDrafts: z.boolean(), takeAbbreviation: z.boolean(), at: offsetDateTime })`. Also `type OrgSucceeded`.
- Produces: `succeedOrganization(db: Db, key: string, input: SuccessionInput, subscribers: SubscriberConfig[], tx?: Tx): Promise<OrgRecord | null>`, where `SuccessionInput = { successorKeys: string[]; moveSubscribers: boolean; moveStaff: boolean; moveCalendar: boolean; moveDrafts: boolean; takeAbbreviation: boolean }`. It uses the caller's transaction when `tx` is given (Task 14).
- Produces: `class SuccessionError extends Error` (→ 422 with message). Messages:
  - `"Choose an active ministry as successor."`
  - `"A ministry can't succeed itself."`
  - `"{B} already leads back to {A}; that would loop."`
- Produces: `successionPreview(db, key): Promise<{ staff: number; abbreviation: string | null }>`.
- Routes (`Core.Admin`):
  - `POST /organizations/:key/succeed` → 200 `OrgRecord`; 404, 409 (abbreviation) and 422 as above.
  - `GET /organizations/:key/succession-preview` → `{ staff, abbreviation }`.
- Works on an already-inactive A: no `org.deactivated` is re-emitted, but `successorKeys` are set and `org.succeeded` is emitted.

- [ ] **Step 1: Write failing tests:**
  - `hands over: A inactive with successorKeys, staff moved without duplicates, events in order` (outbox: `org.upserted` A, `org.upserted` B if the abbreviation changed, `org.succeeded`, and `user.upserted` per moved user).
  - `abbreviation can be taken from an inactive ministry but not an active one` (409 on active).
  - `refuses a cycle`: B has `successorKeys: ["a"]` → 422 with the loop copy.
  - `reactivating clears successorKeys`.
  - `moveStaff false leaves user_organizations alone`.
  - `403 for NRMS.SiteEditor`.
  - `OrgRecord parses without successorKeys` (old envelope).
  - `org.succeeded routes to nrms, nod and calendar only`.
- [ ] **Step 2: Run** `npx vitest run apps/core packages/events apps/stack/src/env.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Take `lockAggregate(orgAggregateId(key))`, then each successor's lock in key order, then the abbreviation lock (existing order rule, `organizations.ts:159-163`).
- [ ] **Step 4: Run** the same tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): ministry succession with staff and abbreviation hand-over`

### Task 9: NoD moves subscribers

**Files:**
- Modify: `apps/nod/src/lists.ts` (`case "org.succeeded": return onOrgSucceeded`), `apps/nod/src/lists.test.ts`
- Modify: `apps/nod/src/http/routes.ts:100` (add `"Core.Admin"` to the `/subscribers/count` roles), `apps/nod/src/http/routes.test.ts`

**Interfaces:**
- Consumes: `OrgSucceeded` (Task 8).
- Produces: `moveMinistrySubscribers(tx: DbOrTx, from: string, to: string[], actor: string): Promise<number>` (rows moved). History row: `action: "list-moved"`, `detail: "ministries:<from> → ministries:<to>"`, `actor: "system: ministry succession"`.

- [ ] **Step 1: Write failing tests:**
  - `moves subscribers and writes one history line each`.
  - `a subscriber already on B ends with exactly one B row`.
  - `a split adds every successor`.
  - `a second delivery moves nothing and adds no history`.
  - `moveSubscribers false is a no-op`.
  - `Core.Admin may read the count`.
- [ ] **Step 2: Run** `npx vitest run apps/nod/src/lists.test.ts apps/nod/src/http/routes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use one `INSERT … SELECT … ON CONFLICT DO NOTHING` per successor, then `DELETE` of the `from` rows, with history inserted from the deleted set (`RETURNING subscriber_id`).
- [ ] **Step 4: Run** the same tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(nod): move ministry subscribers on succession`

### Task 10: Calendar re-homes upcoming work

**Files:**
- Create: `apps/calendar/src/succession.ts`, `apps/calendar/src/succession.test.ts`, `apps/calendar/src/http/succession-routes.ts`
- Modify: `apps/calendar/src/projections.ts` (`org.succeeded` → `applySuccession`), `apps/calendar/src/app.ts` (mount `app.use("/api/succession", requireBearer(deps.auth), requireRole("Core.Admin"), successionRoutes(api))` **before** the `/api` line 35)

**Interfaces:**
- Produces: `applySuccession(tx: Tx, e: OrgSucceeded): Promise<{ activities: number; contacts: number }>`.
- Produces: `successionCounts(db: DbOrTx, key: string, at: Date): Promise<{ activities: number; contacts: number }>`.
- Route: `GET /api/succession/:key/preview` → `{ activities, contacts }`.
- Rules (N9): activities where `contact_ministry_key = from` and (`start_at >= at` or `start_at IS NULL`) move to `successorKeys[0]`. `activity_shared_with` rows of the moved activities are re-keyed (on conflict, do nothing, then delete the old row). Comm contacts move unless `(user_id, successor)` exists, in which case the old one gets `is_active = false`. Each moved activity gets one history change through `writeChange` with the field "Contact ministry" and the system actor, and is emitted with `emitActivity`.

- [ ] **Step 1: Write failing tests:**
  - `moves only upcoming and undated activities`.
  - `keeps past history`.
  - `moves a contact, or deactivates it when the person already has one on the successor`.
  - `idempotent on redelivery`.
  - `moveCalendar false is a no-op`.
  - `preview counts match what apply moves`.
  - `preview is 403 without Core.Admin`.
- [ ] **Step 2: Run** `npx vitest run apps/calendar/src/succession.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same test plus `npx vitest run apps/calendar/src/projections.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(calendar): re-home upcoming activities on ministry succession`

### Task 11: NRMS re-points drafts and seeds the counter

**Files:**
- Create: `apps/nrms/src/succession.ts`, `apps/nrms/src/succession.test.ts`
- Modify: `apps/nrms/src/app.ts` (event handler chain: `taxonomyHandler(e) ?? successionHandler(e) ?? calendarHandler(e)`), and `apps/nrms/src/http/routes.ts` (`GET /api/ministries/:key/open-releases`, `Core.Admin`)

**Interfaces:**
- Produces: `applySuccession(tx: Tx, e: OrgSucceeded, timeZone: string): Promise<{ drafts: number }>`. When `moveDrafts`, it re-points `status = 'draft'` releases (lead and `release_categories (ministries, from)` → `successorKeys[0]`, on conflict delete the old row). When `takeAbbreviation`, it upserts `number_counters(scope 'ministry', year = bcYear(at), ministry = successorKeys[0], last_value = greatest(own, from's))`.
- Produces route → `{ drafts: { id, headline }[]; notMoved: { id, headline, status, key }[] }` (approved, scheduled and publishing releases led by `key`).

- [ ] **Step 1: Write failing tests:**
  - `re-points drafts only`: an approved release keeps its lead.
  - `seeds the successor counter so the next number continues`: A has counter 41 for 2028; after succession B's first approved release gets `ministryRelease 42`.
  - `idempotent`.
  - `open-releases lists drafts and notMoved`.
- [ ] **Step 2: Run** `npx vitest run apps/nrms/src/succession.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same test plus `npx vitest run apps/nrms/src/releases/workflow.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(nrms): re-point drafts and continue numbering on succession`

### Task 12: Successor redirects (News API → public site → stack)

Precondition: parity plan 1 (`site-mount.ts`) has merged to `main`. If it hasn't, mount at today's `/site` static block and note it in the PR.

**Files:**
- Modify: `apps/news-api/src/db/schema.ts` (`MinistryDetails` adds `"successorKeys"`), `apps/news-api/src/projections.ts` (`applyOrg` stores `successorKeys`), `apps/news-api/src/read.ts` (`ministrySuccessors(db): Promise<Record<string,string>>`), `apps/news-api/src/http/v2/routes.ts` (`GET /ministry-successors`), plus a test
- Modify: `apps/public-site/src/site-paths.ts` (`{ type: "legacy-redirects" }` → `legacy/ministry-successors.json`), `news-api-client.ts` (`ministrySuccessors()`), `builder.ts` (render case; included in `aggregatePageIds`), `change-feed.ts` (`ministry` change also queues `legacy-redirects`), plus tests
- Create: `apps/stack/src/ministry-successors.ts`, `apps/stack/src/ministry-successors.test.ts`
- Modify: `apps/stack/src/site-mount.ts` (mount `ministrySuccessorRedirects(outputDir, basePath)` before `express.static`)

**Interfaces:**
- Produces: `resolveSuccessors(raw: Record<string, string[]>, active: Set<string>): Record<string, string>`. It follows the first successor to an active key and drops cycles and dead ends (max 20 hops). It lives in news-api `read.ts` and is unit-tested.
- Produces: `ministrySuccessorRedirects(outputDir: string, basePath: string): RequestHandler`. It reads `legacy/ministry-successors.json` and re-reads it when the mtime changes. It matches `^/ministries/<seg>(/.*)?$` case-insensitively on whole segments and answers 301 `Location: {basePath}/ministries/<to>/<rest>{?query}`, root-relative.
- Produces: `resolveMinistrySuccessor(key: string): string | null`, exported for parity url-compat T4 to compose.

- [ ] **Step 1: Write failing tests:**
  - `resolveSuccessors`: `{a:["b"], b:["c"]}` with active `{c}` → `{a:"c", b:"c"}`; `{a:["b"], b:["a"]}` → `{}`.
  - The middleware: `/ministries/a/` → 301 `/ministries/c/`; `/ministries/a/feed.xml?x=1` → 301 `/ministries/c/feed.xml?x=1`; `/ministries/ab/` passes through (whole segment); `/ministries/A` → 301; a missing file → passes through; an updated file → picked up.
  - The public site: a `ministry` change queues `legacy-redirects`, and the builder writes the JSON from the client.
- [ ] **Step 2: Run** `npx vitest run apps/news-api apps/public-site apps/stack/src/ministry-successors.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat: 301 old ministry URLs to their successor`

### Task 13: Hub hand-over panel on Organizations

**Files:**
- Create: `apps/staff-web/src/screens/admin/organizations/HandOverPanel.tsx`, `HandOverPanel.test.tsx`
- Modify: `OrganizationsScreen.tsx` (an active row's Deactivate opens the panel; an inactive row gets "Set successor…"), `OrganizationsScreen.test.tsx`

**Interfaces:**
- Consumes:
  - Core `GET /core/api/organizations/:key/succession-preview` and `POST …/succeed` (Task 8);
  - NoD `GET /nod/api/subscribers/count?lists=ministries:<key>` (Task 9);
  - Calendar `GET /calendar/api/succession/:key/preview` (Task 10);
  - NRMS `GET /nrms/api/ministries/:key/open-releases` (Task 11).
- Copy (exact):
  - title `"Deactivate {A}"` / `"Set successor for {A}"`;
  - checkbox labels per spec §4;
  - a failed count `"count unavailable"`;
  - button `"Deactivate and hand over"` / `"Set successor"`;
  - success `"{A} is deactivated. Its pages now send visitors to {B}. Moves to other services finish shortly."`;
  - with no successor chosen, the panel shows today's `deactivateWarning` and button "Deactivate".

- [ ] **Step 1: Write failing tests:**
  - `shows counts from four services and posts the ticked moves` (the POST body has the exact flags).
  - `an unticked move is sent as false`.
  - `a failed count shows "count unavailable" and still allows submit`.
  - `the abbreviation line appears only when B has none or the admin opts to replace it`.
  - `without a successor it is today's deactivate`.
  - `422 copy is shown inline`.
  - The a11y test.
- [ ] **Step 2: Run** `npx vitest run apps/staff-web/src/screens/admin/organizations`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(staff-web): guided ministry hand-over`

## Group E: Staged cabinet change (C5), built last

### Task 14: Core cabinet change model, validation, publish and schedule

**Files:**
- Modify: `apps/core/src/db/schema.ts` (`cabinetChanges`: `id uuid`, `status text check in (draft,scheduled,published,cancelled)`, `scheduledFor tz`, `operations jsonb`, `createdBy text`, `publishedAt tz`, `error text`, `updatedAt tz`; partial unique index allowing one row in `draft|scheduled`), plus a generated migration
- Create: `apps/core/src/services/cabinet-changes.ts`, `cabinet-changes.test.ts`
- Modify: `apps/core/src/http/routes.ts`, `apps/core/src/start.ts` (`workers.cabinetChanges` and an interval in `startLoops`)

**Interfaces:**
- Produces: `cabinetOperationSchema`, a zod discriminated union on `op`:
  - `update { key, expectedUpdatedAt, patch: OrgProfilePatch & { abbreviation? } }`
  - `create { ref, displayName, abbreviation?, sortOrder?, minister? }`
  - `succeed { key, expectedUpdatedAt, successors: { key?: string; ref?: string }[], moves: Omit<SuccessionInput,"successorKeys"> }`
- Produces: `previewCabinetChange(db, id): Promise<{ diff: DiffRow[]; resulting: OrgRecord[]; problems: { op: number; message: string }[] }>`.
- Produces: `publishCabinetChange(db, id, subscribers, opts?: { now?: TestClock }): Promise<{ result: "published" } | { result: "invalid"; problems } | { result: "stale"; key: string }>`. One transaction. It reuses `patchOrganizationProfile`, `createOrganization` and `succeedOrganization` with `tx`, which adds an optional `tx` parameter to the first two.
- Produces: `publishDueCabinetChanges(db, subscribers, now?)`.
- Routes (`Core.Admin`):
  - `GET/PUT /cabinet-change` (the open draft);
  - `POST /cabinet-change/preview`;
  - `POST /cabinet-change/publish`;
  - `POST /cabinet-change/schedule { at }`;
  - `POST /cabinet-change/cancel`.

- [ ] **Step 1: Write failing tests:**
  - `merge A+B→C publishes atomically`: creates C, both A and B inactive with `successorKeys ["c"]`, two `org.succeeded`.
  - `one invalid op writes nothing` (an abbreviation clash in the resulting set).
  - `stale expectedUpdatedAt refuses the whole change and names the ministry`.
  - `abolish without "No successor" ticked is a problem`.
  - `scheduled change publishes when due` (TestClock), `and not before`.
  - `only one open draft`.
- [ ] **Step 2: Run** `npx vitest run apps/core/src/services/cabinet-changes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/core`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): staged cabinet change`

### Task 15: Hub "Cabinet change" screen and one-rebuild check

**Files:**
- Create: `apps/staff-web/src/screens/admin/organizations/CabinetChangeScreen.tsx`, `CabinetChangeScreen.test.tsx`
- Modify: `apps/staff-web/src/router.tsx` (`organizations/cabinet-change`), `OrganizationsScreen.tsx` (a "Cabinet change" link for Core.Admin)
- Modify: `apps/public-site/src/builder.test.ts` (the rebuild-count test)

**Interfaces:**
- Consumes: the Task 14 routes; `HandOverPanel` checkboxes are reused for `succeed` operations.
- Copy:
  - stale `"{Ministry} was changed by someone else since this draft was started. Review it and publish again."`;
  - scheduled `"Publishes on {Month D, YYYY} at {h:mm a.m./p.m.} Pacific."`.

- [ ] **Step 1: Write failing tests:**
  - `add rename, create, merge; preview shows diff and problems; publish posts once`.
  - `schedule shows the Pacific time`.
  - `stale result shows the copy`.
  - Public site: `25 org changes in one drain render ministries once` (count `renderPage("ministries")` calls in a `rebuild()` given 25 `category:ministries:*` ids plus `ministries` repeated).
- [ ] **Step 2: Run** `npx vitest run apps/staff-web/src/screens/admin/organizations apps/public-site/src/builder.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat(staff-web): staged cabinet change screen`
