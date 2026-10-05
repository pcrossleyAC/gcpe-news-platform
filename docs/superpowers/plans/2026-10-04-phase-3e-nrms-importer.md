# Phase 3e — NRMS Legacy Importer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm run nrms:import` copies every legacy NRMS release (all statuses) and its documents, contacts, categories, media lists, log, Top/Feature slots, page types and images, media lists, government terms and website data from the legacy SQL Server into NRMS. It's re-runnable, sends no events, starts no Flickr jobs, keeps imported scheduled releases on hold, and writes a balancing report. `nrms:release-holds` releases the holds at cutover. `nrms:replay-to-news-api` re-sends published releases to the News API as `release.updated` with `notify: false`, so no subscriber gets an email.

**Architecture:** Follows the Core and News API importers: raw `-- name:` SQL queries (`queries.ts`), pure row mappers (`map.ts`), a `run.ts` orchestrator taking a `LegacySource` (`createMssqlSource` in production, `createFakeSource` in tests), a `cli.ts` with `LEGACY_SQL_*` env. NRMS writes its own tables directly inside per-release transactions (not through `mutateRelease`, so no outbox rows, no Flickr jobs, no log noise). Legacy staff users become inactive Core users through Core's own service code, called from the NRMS import CLI with a second database connection (`CORE_DATABASE_URL`) — an ops-only coupling, never at runtime.

**Tech Stack:** Node 24, TypeScript 5.9 strict, Drizzle 0.45, zod 3.25, Vitest 4.1, `@gcpe/legacy-import` (`mssql`). No new third-party dependencies.

**Spec:** `docs/superpowers/specs/2026-10-03-nrms-parity-design.md` §8 (importer), §9 acceptance item 15. Code map used to write this plan: session scratchpad `plan3e-codemap.md` (facts carried into the tasks below). Phase overview: `docs/superpowers/plans/2026-10-03-phase-3-overview.md`.

## Global Constraints

- Worktree `/Users/paul/gcpe-news-platform-p3`, branch `feat/phase-3`. Commit after each task. Never add a `Co-Authored-By` trailer or any AI attribution. Never commit `CLAUDE.md`.
- Tests: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run <paths>`; type-check: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`. Migrations: `cd apps/nrms && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name <name>` (next is `0013`).
- **Tests never use a real SQL Server.** Use `createFakeSource({ <queryName>: rows })` with real Postgres (`createNrmsTestDb`, `createCoreTestDb`). Every query string starts with `-- name: <queryName>`.
- **Legacy values:** GUIDs compared lower-cased; LCIDs `4105` = en, `3084` = fr (`LANGUAGE_BY_LCID`); release type map 1→release, 2→story, 3→factsheet, 4→update, 5→advisory (`RELEASE_TYPE_TO_KIND` in `@gcpe/legacy-import` — pin with a test that fails if the map changes); `PublishOptions` bits via `hasPublishOption`; `DATETIMEOFFSET` values keep their instant.
- **Status map (spec §8), in this order:** `IsActive = 0` → `deleted`; `IsCommitted = 1 AND IsPublished = 1` → `published` (`live = true`); `IsCommitted = 1 AND IsPublished = 0` → `scheduled` with `on_hold = true`; `Reference <> ''` → `approved`; `IsPublished = 1 AND IsCommitted = 0` → `draft` plus a log entry `Imported as a draft: legacy marked it published but not committed`; otherwise `draft`.
- **Safety (spec §8):** the import writes **no** `outbox_events` rows and **no** `flickr_jobs` rows (tests assert both counts stay 0); imported scheduled releases stay `on_hold`; nothing is published.
- **Re-runs:** a release whose NRMS `version` is greater than its `imported_version` was edited in NRMS since the last import — skip it and list it in the report. Otherwise replace the release and all its children wholesale in one transaction. Website data follows the same rule (Task 4).
- **Secrets:** `LEGACY_SQL_PASSWORD` and database URLs are never logged or written to the report.
- **Not in 3e:** `nrms:import-files` (translations, media assets, general files — waits for Q13); `NewsReleaseHistory` frozen copies (legacy stores rendered blobs, not structured records — counted and reported, not imported, pending Q12).

## Review Focus

1. Re-running the import on unchanged legacy data changes nothing: same row counts, no version bumps, no new log entries. (Task 3 test.)
2. A release edited in NRMS after import is never overwritten by a re-run, and is listed in the report. (Task 3 test.)
3. An imported scheduled release whose publish time has passed is **not** published by the next tick. (Task 3 test with the publisher.)
4. `nrms:replay-to-news-api` causes no NoD email: NoD ignores `release.updated`. (Task 5 test in NoD.)
5. The report balances: for each table, legacy rows = imported + skipped (with reasons). (Task 5 test.)

---

## File structure

| File | Responsibility |
|---|---|
| `apps/nrms/src/db/schema.ts` (+ `0013_import_tracking`) | `news_releases.imported_version`, `imported_at`; `site_settings.website_imported_at` |
| `apps/nrms/src/import/queries.ts` | Legacy SQL (`-- name:` first line) |
| `apps/nrms/src/import/map.ts` | Pure row → NRMS row mappers; status and type maps |
| `apps/nrms/src/import/reference.ts` | Page images (+ Blob bytes), page image languages, page types, media lists, government terms |
| `apps/nrms/src/import/releases.ts` | Releases with children, log, Top/Feature, counters |
| `apps/nrms/src/import/website.ts` | Carousels, slides, pins, Live Feed, Blue Bridge, resource links |
| `apps/nrms/src/import/report.ts` | Report accumulator + JSON/text writer |
| `apps/nrms/src/import/run.ts`, `cli.ts` | Orchestrator and `nrms:import` CLI |
| `apps/nrms/src/cli/release-holds.ts`, `replay-to-news-api.ts` | Cutover commands |
| `apps/core/src/import/users.ts` | Legacy users → inactive Core users (matched by email) |

---

### Task 1: Import tracking, queries and pure mappers

**Files:**
- Modify: `apps/nrms/src/db/schema.ts` (+ generated `0013_import_tracking`)
- Create: `apps/nrms/src/import/queries.ts`, `apps/nrms/src/import/map.ts`, `apps/nrms/src/import/map.test.ts`, `apps/nrms/src/import/report.ts`, `apps/nrms/src/import/report.test.ts`

**Interfaces:**
- Columns: `news_releases.imported_version integer null`, `news_releases.imported_at timestamptz null`, `news_releases.import_hash text null` (SHA-256 of the mapped release + children, to detect unchanged legacy data); `site_settings.website_imported_at timestamptz null`, `site_settings.website_imported_version integer null` (the `version` value after the website import — a later site edit bumps `version`, which the re-run detects).
- `queries.ts` — one constant or builder per legacy read, reading the schema in `/Users/paul/HUB/gcpe-hub-develop/Hub.Legacy/Gcpe.Hub.Database/dbo/Tables/*.sql` (authoritative) — names: `releaseYears`, `releases(year)`, `releaseLanguages(year)`, `documents(year)`, `documentLanguages(year)`, `documentContacts(year)`, `releaseCategories(year)` (UNION ALL of NewsReleaseMinistry/Sector/Theme/Tag joined to each table's `Key` column, returning `{ releaseId, kind, key }`), `releaseMediaLists(year)`, `releaseLog(year)` (joined to `dbo.User` for `EmailAddress`, `DisplayName`), `releaseLeadMinistry` via `NewsRelease.MinistryId → Ministry.Key` in `releases(year)`, `historyCount`, `pageImages` (joined to `Blob.Data`), `pageImageLanguages`, `pageTypes`, `mediaLists`, `collections`, `users`, `appSettings`, `categoryFeatures` (Ministry/Sector/Theme `TopReleaseId`/`FeatureReleaseId`), `carousels`, `carouselSlides` (joined to `Slide`), `resourceLinks`. Releases with a null `PublishDateTime` and null `ReleaseDateTime` group under year `0` in `releaseYears` (`COALESCE(YEAR(...), 0)`), so every release is covered. Reuse the year-batching shape of `apps/news-api/src/import/queries.ts`, but **without** its `IsCommitted/IsPublished/IsActive` filters.
- `map.ts`:
  - `statusFromLegacy(row): { status; live; onHold; note: string | null }` per the Global Constraints status map.
  - `mapRelease(row, ctx): NewReleaseRow` (all `news_releases` columns: `legacyId`, `type`, `key`, `reference`, `year`, `yearRelease`, `ministryRelease`, `activityId`, `publishAt`, `releasedAt`, `toWeb`/`toSubscribers`/`toMediaLists` from `PublishOptions`, `assetUrl`, `hasMediaAssets`, `hasTranslations`, `redirectUrl`, `keywords`, `atomId`, `nodSubscribers`, `mediaSubscribers`, `leadMinistryKey`, `governmentTermId` from the collection map, `status`/`live`/`onHold`, `version: 1`, `importedVersion: 1`) — read `apps/nrms/src/db/schema.ts` for the exact column names and any NOT NULL columns needing defaults.
  - `mapReleaseLanguage`, `mapDocument` (`PageLayout` int → NRMS layout; find the legacy enum in `Hub.Legacy/Gcpe.Hub.Data_Legacy/Entity/`), `mapDocumentLanguage`, `mapContact` (raw `Information` string copied as is), `summaryEdited: true` for every imported summary (legacy has no flag; never regenerate imported text).
  - `layoutFromLegacy`, `justifyFromLegacy` (reuse News API's if exported, otherwise a shared copy in `@gcpe/legacy-import` — don't duplicate), `imageTypeFromBytes` (same rule).
  - `newestTerm(names: string[]): string` — the collection whose name's last 4-digit year is highest (`'2017-2021'` → 2021), ties by name; names without a year sort last.
- `report.ts`: `class ImportReport { count(table, side: "legacy" | "imported" | "skipped", n = 1); skip(table, legacyId, reason); warn(legacyId, key, problems: string[]); toJSON(); toText(); balanced(): boolean }` — `balanced()` is true when, for every table, legacy = imported + skipped. Never accepts or prints connection details.

- [ ] **Step 1: Failing tests** (`map.test.ts`, `report.test.ts`):

```ts
// type map: 1..5 → release, story, factsheet, update, advisory (fails if RELEASE_TYPE_TO_KIND changes)
// status map: inactive → deleted (even if committed+published); committed+published → published/live; committed only → scheduled+onHold;
//   reference set (not committed) → approved; published-not-committed → draft with the note; nothing → draft
// mapRelease: PublishOptions 7 → toWeb/toSubscribers/toMediaLists all true; 1 → web only; GUIDs lower-cased; DATETIMEOFFSET instant kept
// newestTerm(['2009-2013','2017-2021','2013-2017','2017-2017']) → '2017-2021'; a name without a year sorts last
// summaryEdited is always true; contacts keep the raw Information string
// report: counts balance; a missing skip makes balanced() false; toText lists skipped rows with reasons and validation warnings; no URL/password in output
```

- [ ] **Steps 2–5:** verify failure → implement (schema + migration, queries, map, report) → run `apps/nrms/src/import packages/legacy-import` + tsc + full suite → commit `feat(nrms): import tracking columns, legacy queries, mappers and the import report`.

---

### Task 2: Reference data and legacy users

**Files:**
- Create: `apps/nrms/src/import/reference.ts` (+ test), `apps/core/src/import/users.ts` (+ test)
- Modify: `apps/core/src/services/users.ts` (`createUserSchema` accepts `isActive?: boolean`, default true) (+ test)

**Interfaces:**
- `importReference(db, source, report): Promise<{ pageImageIds: Map<legacyId, id>; mediaListIds: Map<legacyId, id>; termIds: Map<legacyId, id> }>`:
  - **Page images**: upsert by `legacy_id` (name, sort order, MIME type, bytes from `Blob.Data`); languages from `NewsReleaseImageLanguage` (alt text per LCID). The two hidden images (Q11): `isActive = false` for the legacy ids hard-coded in `Hub.Legacy/Gcpe.Hub.Legacy.Website/News/ReleaseManagement/ReleaseImagePicker.ascx.cs` — read the file for the two GUIDs and put them in a named constant with a comment pointing at Q11.
  - **Page types** (`NewsReleaseType`): upsert by `(page_title, language_id)`, page image resolved through `pageImageIds`.
  - **Media lists**: upsert by `legacy_id` (key, display name, sort order, active).
  - **Government terms** (`NewsReleaseCollection`): upsert by `legacy_id` with `name`; set `is_current` only on `newestTerm(...)` (clear the flag elsewhere first, same transaction, respecting the one-current partial unique index).
  - Re-runs: unchanged rows are not rewritten (compare content first).
- Core `importLegacyUsers(coreDb, rows: { email; displayName }[]): Promise<Map<emailLower, { id; displayName }>>`: for each legacy `dbo.User` with a non-empty email, `findUserByEmail` → reuse (never change an existing user's roles, active flag or name) or create **inactive**, no roles, no password (`createUser({ email, displayName, isActive: false })`). Rows with an empty or duplicate email are skipped (the caller reports them). Duplicate display names: Core's `display_name` uniqueness, if any — check `apps/core/src/db/schema.ts`; if unique, suffix ` (legacy)` and note it.

- [ ] **Step 1: Failing tests:**

```ts
// reference: two page images with bytes and fr/en alt text; the hidden pair imported inactive; page types resolve their image; re-run → no rows changed
// media lists upsert by legacy id; renamed in legacy → updated on re-run
// terms: four collections → exactly one is_current ('2017-2021'); re-run keeps one current
// core: legacy user with an email that matches an active Core user → reused unchanged (still active, roles kept); new email → created inactive with no roles; empty email → skipped
// createUser({ isActive: false }) creates an inactive user; default stays active
```

- [ ] **Steps 2–5:** verify failure → implement → run `apps/nrms/src/import apps/core` + tsc + full suite → commit `feat: import NRMS reference data and legacy staff as inactive Core users`.

---

### Task 3: Releases, log, Top/Feature and counters

**Files:**
- Create: `apps/nrms/src/import/releases.ts`, `apps/nrms/src/import/releases.test.ts`, `apps/nrms/test/fixtures/legacy/*.json` (fixtures)

**Interfaces:**
- `importReleases(db, source, ctx: { pageImageIds; mediaListIds; termIds; users: Map<legacyUserIdLower, { id; displayName }>; report; timeZone }): Promise<void>`:
  - Year by year (`releaseYears`), load the year's rows for every query and group by release id.
  - Per release, one transaction: `SELECT … FOR UPDATE` the NRMS row by `legacy_id`. If it exists and `version > imported_version` → `report.skip("news_releases", legacyId, "edited in NRMS since the last import")` and leave it alone. Otherwise compare the mapped content's hash with `import_hash`: equal → do nothing (no version bump, no writes). Different (or new) → upsert the release row, bump `version` (new rows start at 1) and set `imported_version = version`, `import_hash`, `imported_at`, and replace children: `release_languages`, `release_documents` → `document_languages` → `document_contacts`, `release_categories`, `release_media_lists`, `release_log`.
  - Categories: legacy keys must exist in NRMS's `organizations`/`category_terms`; unknown keys are dropped from the release and listed as warnings (`Unknown sector key 'x'`).
  - Log: each `NewsReleaseLog` row → `release_log` with the actor from `ctx.users` (Core id + display name) or `SYSTEM_ACTOR` when the user is null or unknown; the status-map note (if any) appended as one extra system entry, written once (not on every re-run).
  - Validation: run NRMS's per-type rules (the same function the API uses before approve/publish — find it in `apps/nrms/src/releases/` / `packages/nrms-contract/src/rules.ts`) and `report.warn` the problems; import anyway.
  - **Top/Feature**: after all releases, read `categoryFeatures` (Ministry/Sector/Theme) plus `appSettings` `HomeTopReleaseId`/`HomeFeatureReleaseId` → `category_features` rows (kind `home`, key `default` for home), only for releases imported as `published`; anything else is skipped with a reason.
  - **Counters**: after all releases, seed `number_counters` with `GREATEST(existing, max)`: scope `news` (year 0, ministry '') from the highest `NEWS-NNNNN` reference (parsed as a number); scope `year` per `year` from `MAX(yearRelease)`; scope `ministry` per `(year, leadMinistryKey)` from `MAX(ministryRelease)`.
  - `historyCount` → `report.count("NewsReleaseHistory", "legacy", n)` and the same number as skipped with reason `frozen copies not imported (Q12)`.
- Fixtures: (a) fictional rows using real legacy values for all five types, inactive rows, nulls, mixed-case GUIDs, en+fr documents with contacts, every status combination; (b) two or three published releases copied from `https://api.news.gov.bc.ca` (e.g. `GET /api/Posts/Latest/home/default?count=3&api-version=1.0`, then each post) and converted to legacy row shape — save the raw API JSON next to the converted rows so the conversion can be audited.

- [ ] **Step 1: Failing tests:**

```ts
// all statuses land as mapped; scheduled ones are on_hold; deleted ones are deleted; keys/references/activity ids preserved
// zero outbox_events rows and zero flickr_jobs rows after import
// re-run on unchanged data → no version bumps, no new release_log rows, same counts (Review Focus 1)
// edit an imported release through the service (version bump) → re-run skips it, report lists it (Review Focus 2)
// legacy data changed for an unedited release → re-run updates it: children replaced, version bumped, imported_version = version, import_hash changed (a staff form open on the old version then gets 409, not a silent overwrite)
// a scheduled release whose publish_at is in the past is not published by publishDue() (Review Focus 3)
// log actors: known legacy user → Core id + name; null user → System
// unknown category key → dropped + warning; a release breaking per-type rules → imported + warning
// Top/Feature: home top/feature + a ministry feature land in category_features; a slot pointing at an unpublished release is skipped with a reason
// counters: after import, approving a new release gets NEWS-<max+1> and the next yearRelease/ministryRelease
// the api.news.gov.bc.ca fixtures import and toReleaseRecord() of each matches the API's headline/summary/key
```

- [ ] **Steps 2–5:** verify failure → implement → run `apps/nrms` + tsc + full suite → commit `feat(nrms): import legacy releases with children, log, Top/Feature and counters`.

---

### Task 4: Website data

**Files:**
- Create: `apps/nrms/src/import/website.ts`, `apps/nrms/src/import/website.test.ts`

**Interfaces:**
- `importWebsite(db, source, report, opts: { force: boolean })`:
  - **Re-run rule:** if `site_settings.website_imported_version` is set and `site_settings.version` differs, or any `site_log` row exists from a non-system actor after `website_imported_at`, skip the whole website import with reason `website edited in NRMS since the last import` (unless `force`).
  - **Carousels:** legacy `Carousel` rows with slides (`CarouselSlide` + `Slide`): the newest with `PublishDateTime <= now` → `live`; one with `PublishDateTime > now` (the earliest) → `next` (any further future ones skipped with a reason); the five newest remaining past ones → `past`; older ones skipped (`more than five past carousels`). Slides copied in `SortIndex` order with image bytes and `imageTypeFromBytes`; legacy slides with `SortIndex < 0` inside a carousel are pins, not carousel slides — skip them there.
  - **Pins:** from `appSettings` `IsPinnedSlide`/`PinnedSlideId` (primary) and `IsPinnedSecondarySlide`/`SecondarySlideId` (secondary) — find the exact setting names in `Hub.Legacy/Gcpe.Hub.Legacy.Website/News/EmergencySlideManagement.aspx.cs`; copy the slide content into the seeded `emergency_pins` rows and set `pinned`.
  - **Live Feed:** `live_webcast_enabled` (`'true'` → on). URLs stay empty (legacy has none — Q1; the env defaults apply).
  - **Blue Bridge:** `granville` normalised with the same rule as the News API importer (`"true"` → `"true"`, anything else → null). Log it in `site_log` as system: `Imported Project Blue Bridge as ON` only when ON.
  - **Resource links:** `ResourceLink` rows in `SortIndex` order → `resource_links` with fresh ids.
  - Replaces NRMS's website tables wholesale in one transaction; writes `website_imported_at` / `website_imported_version`; **no events** (the News API already has this content from its own importer).

- [ ] **Step 1: Failing tests:**

```ts
// three past carousels + one live + one future → states past/live/next with slides in order and image types sniffed
// seven past carousels → five kept, two skipped with reason
// pins: primary pinned with its slide content; secondary unpinned
// live_webcast_enabled 'true' → live feed on, URLs empty; granville 'false' → null; 'TRUE' → "true"
// resource links in order
// no outbox rows; re-run unchanged → no change; after a site edit (saveLinks) → skipped with reason; force → re-imported
```

- [ ] **Steps 2–5:** verify failure → implement → run `apps/nrms/src/import` + tsc + full suite → commit `feat(nrms): import legacy website data`.

---

### Task 5: The `nrms:import` CLI, cutover commands, docs

**Files:**
- Create: `apps/nrms/src/import/run.ts`, `apps/nrms/src/import/cli.ts`, `apps/nrms/src/import/run.test.ts`, `apps/nrms/src/cli/release-holds.ts` (+ test), `apps/nrms/src/cli/replay-to-news-api.ts` (+ test), `apps/nod/src/release-updated.test.ts` (or extend an existing NoD test)
- Modify: `apps/nrms/package.json`, root `package.json`, `docs/deploy/siteground.md`, `docs/parity/open-questions.md`, `docs/parity/changes-from-legacy.md`

**Interfaces:**
- `runImport(db, coreDb, source, opts: { force: boolean; timeZone; log }): Promise<ImportReport>` — order: users (Core) → reference → releases → website. Each stage's failure stops the run and still writes the partial report.
- `cli.ts`: env `DATABASE_URL`, `CORE_DATABASE_URL`, `LEGACY_SQL_SERVER`, `LEGACY_SQL_DATABASE` (default `Gcpe.Hub`), `LEGACY_SQL_USER`, `LEGACY_SQL_PASSWORD`, `LEGACY_SQL_TRUST_CERT`; flags `--report <path>` (default `nrms-import-<UTC timestamp>.json` plus a `.txt` beside it), `--force-website`. Runs migrations first (as the Core/News API CLIs do). Exit code 0 when the report balances, 2 when it doesn't, 1 on error. Scripts: `apps/nrms` `import:legacy`; root `nrms:import`.
- `release-holds.ts` (`npm run nrms:release-holds -- --confirm`): without `--confirm` prints how many releases are on hold and their keys/publish times, changes nothing. With it, in one transaction clears `on_hold` on every `scheduled` release, bumps version, writes a system log entry `Hold released at cutover`; prints the count. Releases whose `publish_at` is already past will publish on the next tick — the dry run lists them first under "will publish immediately".
- `replay-to-news-api.ts` (`npm run nrms:replay-to-news-api -- --confirm`): for every `published` + `live` release, enqueue `release.updated` with `{ ...toReleaseRecord(view, { publishDate: releasedAt, timestamp: now }, { filesBase }), notify: false }` and `source: "nrms"` through the normal outbox (delivery by the usual dispatcher); no log entries, no `release_publications` rows; batches of 200 per transaction; dry run without `--confirm`.
- NoD test: a `release.updated` event from `nrms` with `notify: false` (and with `notify: true`) produces no NoD send (NoD only handles `release.published`, `apps/nod/src/app.ts:32`).
- Docs: `siteground.md` "Importing legacy NRMS data" (prerequisites — Core reference data imported first; env; how to read the report; cutover order: import → check report → replay → legacy publisher off → `release-holds --confirm`); parity: Q12 updated ("NewsReleaseHistory rows are counted in the import report; importing them needs a decision"), Q13 note (`nrms:import-files` still pending), a C-row for "imported summaries are treated as hand-edited" (Proposed) and one for "imported published-but-uncommitted releases become drafts with a log note" (confirm whether the spec's wording already covers it; don't duplicate).

- [ ] **Step 1: Failing tests:**

```ts
// run: the full fixture set imports end to end; report.balanced() true; a second run reports zero changes (acceptance 15)
// run: a stage failure still writes the partial report and exits 1
// release-holds: dry run changes nothing and lists past-due releases; --confirm clears holds, bumps versions, logs; then publishDue publishes the past-due one
// replay: one release.updated per published live release with notify:false, none for drafts/scheduled/deleted; dry run enqueues nothing
// NoD: release.updated (notify false or true) from nrms → no send
// cli: missing LEGACY_SQL_PASSWORD → exits 1 with a message naming the variable, never echoing values
```

- [ ] **Steps 2–5:** verify failure → implement → run `apps/nrms apps/nod apps/core` + tsc + full suite → commit `feat(nrms): nrms:import CLI with report, release-holds and replay-to-news-api; docs`.
