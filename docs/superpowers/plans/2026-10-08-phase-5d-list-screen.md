# Phase 5d-1: The Calendar List API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Calendar app answers everything the activity list needs, on the server and inside `visible()`: the filtered, sorted, paged list with legacy's filters, display modes, quick search (by text and by id), corporate queries and the Look Ahead admin filter; the filter panel's options; each user's display and column choices; the watchlist; saved filters ("My Queries"), owner only; a converter that migrates legacy saved queries with a report; a month or week range for the calendar view; and an Excel export that respects visibility and neutralises formula-like cells. The list query is measured under 500 ms on a 50,000-activity fixture.

**Architecture:**
- **One filter model, shared.** `@gcpe/calendar-contract` gains `list.ts` (the zod filter and query schemas, column keys, row and page types) and `format.ts` (legacy's friendly date range, used by the export now and by the staff app in 5d-2). Saved filters store that model as JSON.
- **One where-builder.** `apps/calendar/src/list/query.ts` turns a `ListQuery` into one SQL predicate over the unaliased `activities` table, always `AND`ed with `visibleSql(actor)`. The page, the calendar range and the export all use it, each inside `inReadSnapshot`. Paging is offset-based, 30 rows, with `count(*) OVER ()` for the total.
- **Rows are hydrated in batches** (`list/rows.ts`) by id with joins and grouped lookups, still filtered by `visibleSql`, so no reader holds an invisible row.
- **Routes** (`http/list-routes.ts`, `http/saved-filter-routes.ts`) take the query as JSON in a `q` parameter, parsed strictly. Every route sits behind `requireBearer` and `requireCalendarActor`, so bearer tokens get nothing.
- **Excel** is written by a small, dependency-free `.xlsx` writer (`list/xlsx.ts`, `node:zlib`'s `deflateRawSync` and `crc32`), inline strings only, with every cell made inert before it is written.

**Tech Stack:** Node 24, TypeScript 5.9 strict, Express 5, Drizzle 0.45, zod 3.25, Vitest 4.1, supertest, real Postgres through `@gcpe/db-kit`'s `createTestDatabase`.

**Spec:** `docs/superpowers/specs/2026-10-07-calendar-parity-design.md`:
- §3 row 5d (the exit check: axe on every state, a visibility e2e per role, a legacy saved-filter fixture that migrates with a report, the list query under 500 ms on 50,000 activities);
- §6 (one visibility rule, the capability table: corporate queries and the Look Ahead admin filter at HQ and L ≥ Advanced, list markup at HQ and L ≥ Administrator, saved filters owner only, favourites and the Excel export for any role);
- §7.4 (favourites, saved filters and column preferences aren't frozen);
- §8.1 (the list);
- §12.1 step 5 (saved filters converted with a report);
- §13 (data volumes);
- §14 (C127, C139, C141, C151, C154), §15, §16.

The plan also takes these other documents into account:
- `docs/superpowers/plans/phase-5-carry-forward.md`, § 5d (every item; see "Carry-forward items taken").
- The 5c plans, `docs/superpowers/plans/2026-10-08-phase-5c-activity-api.md` and `docs/superpowers/plans/2026-10-08-phase-5c2-transfer-and-dead-letters.md`. Their store, `visibleSql`, `inReadSnapshot`, `can`, bulk actions and test world are what this plan uses.
- Legacy `Default.aspx` (filters, display, My Queries, Corporate Queries, Admin Settings), `Default.aspx.cs`, `ActivityListProvider.ashx.cs`, `UCFlexiGrid.ascx(.cs)`, `ActivityFilter.asmx.cs`, `ActivityHandler.ashx.cs:20-53,392-541` (Excel) and `Gcpe.Calendar.Library/Data/ActivityDAO.cs:60-368`, read for behaviour only. No legacy data, names or values are copied.

**Order:** **5d-1 (this plan) first**, all of it, then **5d-2** (`docs/superpowers/plans/2026-10-08-phase-5d2-list-screen-ui.md`: the staff-web list screen, the end-to-end visibility tests, the docs and the deploy). Within this plan, Tasks 1–9 in order; Task 1 is independent of the rest, and Tasks 3–9 consume Task 2's contract.

**Base:**
- **Branch:** `feat/phase-5d` in `/Users/paul/gcpe-news-platform-p5d`, stacked on `feat/phase-5c` (5a, 5b and 5c finished). Every path is repo-relative.
- **What exists:**
  - `apps/calendar/src/visibility.ts`: `visible`, `visibleSql(u)` (over the unaliased `activities`), `isOwnMinistry`, `Viewer`.
  - `apps/calendar/src/capabilities.ts`: `can.*` (this plan adds three).
  - `apps/calendar/src/activities/store.ts`: `inReadSnapshot(db, read)`, `loadStored`, `factsOf`.
  - `apps/calendar/src/activities/bulk.ts`: `reviewSelected`, `clearLaStatus` (207 with `failed: true` after a partial commit).
  - `apps/calendar/src/actor.ts`: `CalendarActor`, `loadCalendarActor(db, subject)`, `requireCalendarActor`.
  - `apps/calendar/src/time.ts`: `wallClock`, `instantOf`, `addDays`, `bcMidnight`, `dbNow`.
  - `apps/calendar/src/lookups.ts`: `LOOKUPS`, `listLookupRows(db, def)`.
  - `apps/calendar/src/http/errors.ts`: `sendActivityError(e, res)`; `http/activity-routes.ts`: `idOf(req)`.
  - `apps/calendar/src/db/schema.ts`: `user_profiles.list_display` (nullable) and `hidden_columns` (`text[] NOT NULL DEFAULT '{}'`), `saved_filters` (id, owner, name ≤ 200, `filter jsonb`, sort order, active), `favourites` (user × activity), indexes on `activities` start, end, contact ministry and comm contact, and on `activity_shared_with.ministry_key`.
  - `apps/calendar/test/helpers.ts` (`TEST_RULES`, `FIXED_NOW` = 2026-11-03 11:00 BC, `createTestApp`, `projectUser`, `projectOrg`, `sessionCookie`, `waitForLockWaiter`) and `test/world.ts` (`seedWorld`, `Who`, `World`, `validInput`, `call`, `insertRaw`, `historyOf`, `outboxOf`).
- **Facts this plan relies on (each verified by reading the file named):**
  - `seedWorld` makes orgs `health` (HLTH), `finance` (FIN), `gcpe-hq` (HQ, `isHq`), `consult` (CONSULT, the tenant's consultations abbreviation in `TEST_RULES`), `excluded`, `retired`; categories 2 (awareness), 12, 58, 30–34; cities 1, 2 and 311 ("Other..."); keywords 1 and 2; comm contacts `editorHealth`, `adminHealth`, `financeEditor`, and `retiredHealth` (inactive, the `advanced` user's). It creates no activities.
  - `insertRaw(db, over)` inserts one activity (health, 2026-11-10 09:00–10:00 BC, `status: "reviewed"`) and takes any column, including an explicit `id`.
  - `apiFetch` in staff-web treats 207 as success, so 5d-2 reads `failed` from the body.
  - Express 5's default query parser is "simple": a repeated `q` arrives as an array.

**Measured before planning** (*verified*, 2026-10-08, local Postgres, raw SQL shaped like this plan's queries on a 50,000-row fixture built as Task 5 builds it): a ministry editor's default first page 26 ms; HQ, all years, sorted by title, offset 1,500, 31 ms; a quick search that matches nothing over every year 90 ms; keywords OR 22 ms; watchlist under 1 ms; **HQ, all years, sorted by categories, offset 900: 232 ms**, the slowest. These were raw SQL without row hydration or HTTP; Task 5 measures the real service.

---

## Decisions made in planning

Paul is unavailable and authorised autonomous work. Each decision says why and what it costs if wrong. 5d-2's last task writes the parity rows they create.

- **D1. Split into two plans.** 5d-1 is the server (9 tasks), 5d-2 the staff app, the end-to-end tests, the docs and the deploy (5 tasks). *Why:* 14 right-sized tasks; the server half is testable on its own. *If wrong:* nothing is lost; the second plan only consumes the first's routes.
- **D2. The wire format.** `GET /api/list?q=<JSON ListQuery>&offset=<n>`, `q` at most 8,000 characters, parsed strictly; 30 rows a page, offset paging with `count(*) OVER ()` for the total, as legacy's grid paged. *Why:* one filter model for the list, the calendar range, the export and later the reports (5g); a GET link works for the export download. *If wrong:* deep offsets get slower (Task 5 measures offset 1,500); a keyset cursor can replace the offset behind the same route.
- **D3. The filter model.** `listFilterSchema` holds the dates, This day only, quick search, HQ Tags, Issue, Date Confirmed, Status, Category, Lead Ministry, Comm Contact (a person), Representative, Initiative, Premier Requested and Distribution. Display, the Look Ahead admin filter, a corporate query and the sort sit beside it in `ListQuery`, not in a saved filter, because legacy's saved queries never applied display or the Look Ahead filter (`Default.aspx:432-488`'s `SetFilter` ignores them). *If wrong:* a field moves into the saved model; old saved filters parse with its default.
- **D4. Dates.** From defaults to today in BC; a From before 2011-01-01 is clamped to it (`ActivityDAO.cs:172-173`). An activity is in range when it overlaps it: it ends on or after From and starts before the day after To (`ActivityDAO.cs:243`). This day only means it starts and ends that day. An activity with no dates at all is found only by id. *If wrong:* an undated imported activity is invisible to the default list; Q-row if the business needs them listed.
- **D5. Default hides.** The Awareness category and the consultations ministry are hidden unless the filter names that category or that ministry (spec §8.1), in every display except My Watchlist (you chose to watch it), and never in a corporate query or an id search. A user whose only ministry is the consultations ministry sees it (`ActivityListProvider.ashx.cs:91`). *Why:* the spec's wording; legacy actually stopped hiding as soon as any parameter was sent, which is an accident of its query string. *If wrong:* staff miss awareness dates in a filtered search until they name the category.
- **D6. Quick search.** A whole number above 10,000, or `ABBR-<number>` at any size (the list's own `MIN-Id` form), finds that one activity, inside `visible()`, ignoring the other filters and the dates, as legacy (`ActivityDAO.cs:68-76`). Smaller bare numbers are words (a year, "2026"). Otherwise the eleven legacy fields are searched case-insensitively, `%`, `_` and `\` literal. **The Executive Summary is searched only for users who see the Look Ahead fieldset** (new row C172, Proposed). *Why:* the field is HQ-only on screen and in history; a search hit would reveal it. *If wrong:* a ministry user misses a hit only the Executive Summary holds.
- **D7. Deleted activities in the list.** Only HQ Administrators see deleted activities (`visibleSql`), and in the list only while they await review (their `active` flag is set); the Changed status filter includes them, New and Reviewed don't (`ActivityDAO.cs:176-193`). Corporate queries' Deleted status brings every deletion. *If wrong:* an HQ Administrator can't find an already-reviewed deletion except by a corporate query.
- **D8. Display modes.** All; My Ministries (the lead ministry is one of mine, or the chosen Lead Ministry; shared-only items left out); My Activities (the comm contact's person is me, or the chosen Comm Contact person); My Watchlist. *Why:* legacy's display 4 silently also became display 2; the spec says "as comm contact". *If wrong:* a person who is comm contact for a ministry they've left sees those items under My Activities.
- **D9. Comm Contact filter by person.** It matches every comm contact row of that person, **inactive ones included** (legacy matched active ones). *Why:* finding a departed contact's work is when the filter matters most. Part of new row C173 (Proposed).
- **D10. Corporate queries and the Look Ahead admin filter** are refused with 403 below HQ and L ≥ Advanced (C127: legacy honoured the Look Ahead parameter from anyone). Corporate: "show all" or the next 0–366 days, statuses New, Changed, Reviewed, Deleted, LA New, LA Changed, as legacy (`ActivityDAO.cs:306-368`). Legacy's undocumented `-1` days branch (created yesterday) isn't ported. *If wrong:* someone typed -1; Q-row then.
- **D11. Sorting.** Every column legacy could sort, plus the Activity Id column (ministry abbreviation then id, as legacy); Premier isn't sortable, as legacy. Then start, then id, so pages never overlap. Empty values sort last in both directions.
- **D12. Column and display preferences, no migration.** `user_profiles.list_display` being null means "never chosen": both then default (Show All; HQ Tags, Ministry, Status and Translations hidden, legacy's `HiddenByDefault`). `PUT /api/list/preferences` always writes both. The Activity Id column can't be hidden (it holds the row's checkbox and star). Choices are saved when the user changes them, not as a side effect of every list load as legacy did. *Why:* no schema change, and the user admin screen's profile rows (`hidden_columns = '{}'`) keep the defaults. *If wrong:* a later migration makes `hidden_columns` nullable. 5i writes both columns for every imported user.
- **D13. The watchlist.** Watching needs the activity to be visible (404 otherwise); unwatching never 404s. Each row carries its watchers' display names (the star tooltip, `Activity.aspx.cs:1519-1535`). The list's star toggles it (5d-2), because the activity page arrives only in 5e (new row C176, Proposed). Not frozen (§7.4).
- **D14. Saved filters.** Owner only; another owner's id is 404. Delete deactivates, as legacy (`ActivityFilter.asmx.cs:82-90`). Names are trimmed, 1–200 characters, duplicates allowed (legacy allowed them). At most 200 active per owner (422 beyond; legacy's busiest owner is unsurveyed but its 682 active filters across 1,018 suggest small per-user counts). Reorder must name exactly the owner's active ids (409 otherwise). A stored filter that no longer parses comes back as `filter: null` rather than breaking the list. Not frozen.
- **D15. The legacy saved-query converter is built here** (the 5d exit check), and 5i calls it with real resolvers. It applies what legacy's `SetFilter` applied; drops `display`, `thisdayonly` and `lookahead` ("legacy never applied it to a saved query"); drops unreadable or unmappable values with a reason; reads dates as `M/D/YYYY` (jQuery UI's default) or `YYYY-MM-DD`; strips the stale `ActivityListProvider.aspx?` prefix; skips inactive filters and those whose owner has no Core user; keeps legacy ids; re-runs idempotently. New row C175 (Proposed). It also converts legacy `HiddenColumns` and `FilterDisplayValue` for 5i.
- **D16. Excel export.** A real `.xlsx`, legacy's three header cells, 16 columns and red footer (`ActivityHandler.ashx.cs:392-527`), rows in legacy's order (start date, end date, start time; `ActivityHandler.ashx.cs:36-53`), plain text (no HTML), at most 10,000 rows (422 beyond, new row C174, Proposed). **Every cell whose first character, after invalid XML characters are removed, is `=`, `+`, `-`, `@`, tab or carriage return gets a leading apostrophe** (OWASP CSV injection), so a re-save as CSV stays inert. Written without a new dependency: inline strings, `node:zlib`. *Why:* SiteGround's build bundles every dependency, and a spreadsheet library's dynamic requires are a bundling risk; inline strings can't be formulas in the first place. *If wrong:* Excel refuses the file; Task 9 checks it with `openpyxl` locally and 5d-2's hand check opens it in Excel.
- **D17. The calendar range.** `GET /api/list/calendar?q=&start=&end=` returns the query's activities overlapping at most 42 days (a month view's six weeks), at most 1,000 with `truncated`, using the query's filters but the view's dates.
- **D18. Performance is measured, not assumed.** Task 5's Vitest test builds 50,000 activities shaped by §13 (2016–2027, about 4,500 a year, 3% confidential, 12.5% deleted, shared, keywords, favourites) and asserts the 95th percentile of 10 runs of each of eight list shapes under 500 ms through the real service, rows hydrated. No index is added unless a shape fails. *If wrong:* production hardware is slower than a laptop; the numbers are recorded so 5d-2's boxs.ca check can compare.
- **D19. `GET /api/list/options`** gives the filter panel its choices in one call: active lookups; ministries (all active for HQ, the user's own otherwise, as legacy's two dropdown sources); and comm-contact people (with an active comm contact in those ministries).
- **D20. Transfer re-checks its target per batch** (carry-forward): a target that can no longer receive stops the run before the next batch, which answers 207 `failed: true` with what moved (the staff app already says so).
- **D21. Error logs name the route.** `sendActivityError`'s class 22/23 and race lines add the method and the route path, never the query string (it can hold search text).
- **D22. The friendly date range** is legacy's `FriendlyDateTimeRange` (`ActivityListProvider.ashx.cs:769-840`) in the tenant's time zone with plain spaces: "Tue Nov 10 9:00-10:00 AM", "Nov 10-12", "Dec 30 2026-Jan 2 2027", "… TBC", "… Time TBD", Potential Dates when unconfirmed. Legacy's "Premier, " prefix on the representative and "Premier Reqstd" wording depend on legacy lookup values and aren't reproduced (part of C173).

## Carry-forward items taken

From `docs/superpowers/plans/phase-5-carry-forward.md` § 5d. 5d-2's last task deletes them.

| Item | Where |
|---|---|
| Pin the tenant-config start-up refusal with an integration test | Task 1 |
| A barrier for the concurrent-lock race test | Task 1 |
| History on an imported dirty title: isolate the All-Day status-only row | Task 1 (read as: an imported activity already 00:00–23:45 whose only change is All Day gets status Changed, no flag, and history without Start or End) |
| Class 22/23 log lines carry no method or path | Task 1 (D21) |
| Accepted Transfer race: re-check the target per batch | Task 1 (D20) |
| The list reads through `visibleSql(actor)` on the unaliased `activities`; never in memory after paging | Tasks 3, 4, 9 |
| Review selected posts `{ items: [{ id, version }] }` ≤ 500 and shows `skipped`; Clear LA Status posts `{ days }` | 5d-2 Task 3 (the routes exist since 5c-1) |
| The freeze banner reads `GET /api/config`'s `freeze` | 5d-2 Task 1 |
| Review selected and Clear LA Status can answer 207 `{ failed: true }`: staff-web checks `body.failed` | 5d-2 Task 3 |

## Global Constraints

- **Worktree and commits:**
  - Work on `feat/phase-5d` in `/Users/paul/gcpe-news-platform-p5d`. Commit locally after each task.
  - **Never add `Co-Authored-By` or any AI attribution** to a commit. Never commit `CLAUDE.md`.
  - **No task, decision or round labels in code comments** ("Task 3", "D6", "fix round 1"). Spec row ids (C172, Q51) and legacy file references are fine.
- **Node 24 for everything** (BC's permanent UTC−7 from 2026-11-01 needs tzdata ≥ 2026b):
  - Tests: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run <paths>`.
  - Type-checks: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json` and `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p apps/staff-web/tsconfig.json`.
  - E2E: `npx -y -p node@24 -- npm run test:e2e`.
  - Show each new test failing before implementing it (a real RED run). A test that pins behaviour that already exists is shown failing by breaking the code on purpose, then restoring it.
- **Keys and ids:** Core keys are byte-exact, never case-folded. User ids are canonical (trimmed, lowercase).
- **Access:**
  - The Calendar actor comes from the per-request projection (`requireCalendarActor`); bearer tokens get no Calendar access.
  - Reads use `visibleSql(actor)` on the unaliased `activities` table, inside `inReadSnapshot`. Never filter in memory after paging. Not visible means 404, never 403.
- **Errors:**
  - No request body or query may produce a 500. Use `safeString` and int4-bounded ids (`idSchema`, at most 2,147,483,647; URL ids `^\d{1,9}$`).
  - SQLSTATE class 22 maps to 400, class 23 to 409 (`sendActivityError`).
- **Logs:** `safeErrorLabel(e)` only. No debug logging.
- **Privacy:** `example.test` addresses, fictional GUIDs and fictional names only. No legacy data is copied.
- **Migrations:** drizzle-kit only. This plan adds none (D12).
- **Confidential text never leaves the Calendar.** No list route emits an event.
- **Excel export** respects visibility and confidentiality exactly as the list does, and neutralises cells starting with `=`, `+`, `-` or `@` (and tab or carriage return).
- **Performance target:** the list query takes under 500 ms on a 50,000-activity fixture. Measure it (Task 5); don't assume it.
- **Tasks that change staff-web screens must run the affected e2e specs.** This plan changes none; 5d-2's tasks do.

## Review Focus

1. **A quick search with LIKE metacharacters or a backslash** ("50%", "a_b", `c\d`). A reasonable person expects those characters matched literally and no error. Pinned in Task 3 ("%, _ and \ in a search are literal characters").
2. **A hand-edited or stale list URL**: `q` that isn't JSON, is over 8,000 characters, has an unknown key or an id past int4, a NUL, a year outside 1900–2199, From after To, `q` given twice, or a negative or non-numeric offset. Each is a 400, never a 500. Pinned in Task 4 ("a malformed list request is 400, never 500").
3. **Scrolling past the end, or rows deleted between page loads.** An offset beyond the total gives no rows and the true total, not an error or a repeat. Pinned in Task 3 ("pages 30 at a time with the total; an offset past the end gives no rows and the true total").
4. **An exported cell that starts with `=`, `+`, `-`, `@`, a tab or carriage return, or hides one behind a control character** (`"\u0001=1+1"`), and text with `<`, `&` or invalid XML characters. The cell opens as text, and the file still opens. Pinned in Task 9 ("cells that start like a formula are inert, even behind a control character").
5. **A saved filter whose category was since deactivated, or whose stored JSON no longer parses.** The list still loads, the filter still applies (an inactive lookup id still matches), and an unreadable one comes back as `filter: null` instead of a 500. Pinned in Task 7 ("a saved filter naming a deactivated category still applies; an unreadable one is null, not a 500").

---

## File structure

| File | Responsibility |
|---|---|
| `packages/calendar-contract/src/input.ts` | Export `idSchema` and `bcDateSchema` |
| `packages/calendar-contract/src/list.ts` (+ `list.test.ts`) | Filter and query schemas, columns, sorts, row and page types |
| `packages/calendar-contract/src/format.ts` (+ `format.test.ts`) | `friendlyDateRange`, `friendlySpan` |
| `packages/calendar-contract/src/index.ts` | Export both |
| `apps/calendar/src/db/schema.ts` | `LIST_DISPLAYS` now from the contract |
| `apps/calendar/src/capabilities.ts` (+ test) | `corporateQueries`, `lookAheadFilter`, `seeListMarkup` |
| `apps/calendar/src/list/query.ts` (+ `query.test.ts`) | Scope, where-builder, order, ids and total |
| `apps/calendar/src/list/rows.ts`, `list/page.ts`, `list/options.ts` | Row hydration, the page, the filter options |
| `apps/calendar/src/list/preferences.ts`, `list/watch.ts` | Display and columns; the watchlist |
| `apps/calendar/src/list/saved-filters.ts` | My Queries |
| `apps/calendar/src/list/legacy-filters.ts` (+ test) | Legacy saved-query, hidden-column and display conversion, migration report |
| `apps/calendar/src/list/xlsx.ts` (+ test), `list/export.ts`, `list/calendar-range.ts` | The workbook writer, the export, the calendar range |
| `apps/calendar/src/http/list-routes.ts`, `http/list-errors.ts`, `http/saved-filter-routes.ts`, `http/routes.ts`, `http/config-routes.ts` | Routes |
| `apps/calendar/src/http/list-routes.test.ts`, `http/list-preferences.test.ts`, `http/saved-filter-routes.test.ts`, `http/export-routes.test.ts` | Route tests |
| `apps/calendar/src/list/list-perf.test.ts`, `apps/calendar/test/volume.ts` | The 50,000-activity measurement |
| `apps/calendar/test/xlsx-read.ts`, `apps/calendar/test/fixtures/legacy-saved-filters.ts` | Test readers and fixtures |
| `apps/calendar/test/helpers.ts` | `waitForLockWaiters` |
| `apps/calendar/src/start.test.ts`, `http/activity-locks.test.ts`, `http/activity-update.test.ts`, `http/errors.ts` (+ test), `http/activity-routes.ts`, `http/transfer-routes.ts` (+ test), `transfer.ts` | Carry-forward |
| `docs/superpowers/plans/2026-10-08-phase-5d-list-performance.md` | The measured numbers |

---

### Task 1: Carry-forward hardening

Covers: the five carry-forward hardening items (§5.1 start-up, §7.5 lock race, §7.3 All Day row, error logging, the Transfer race). Decisions D20, D21.

**Files:**
- Modify: `apps/calendar/test/helpers.ts`, `apps/calendar/src/start.test.ts`, `apps/calendar/src/http/activity-locks.test.ts`, `apps/calendar/src/http/activity-update.test.ts`.
- Modify: `apps/calendar/src/http/errors.ts`, `apps/calendar/src/http/errors.test.ts`, `apps/calendar/src/http/activity-routes.ts`, `apps/calendar/src/http/transfer-routes.ts`.
- Modify: `apps/calendar/src/transfer.ts`, `apps/calendar/src/http/transfer-routes.test.ts`.

**Interfaces:**
- Consumes: `startCalendar`, `takeLock`'s advisory lock key `calendar-activity:<id>`, `insertRaw`, `historyOf`, `runTransfer`, `receiveRefusal` (private in `transfer.ts`).
- Produces:
  - `waitForLockWaiters(tdb: TestDatabase, count: number, timeoutMs?: number): Promise<void>` in `test/helpers.ts`; `waitForLockWaiter(tdb, timeoutMs?)` becomes `waitForLockWaiters(tdb, 1, timeoutMs)`.
  - `sendActivityError(e: unknown, res: Response, req?: RouteOf): boolean` with `type RouteOf = { method: string; baseUrl: string; path: string }`.

- [ ] **Step 1: The start-up refusal test**

Add to `apps/calendar/src/start.test.ts` (new imports at the top: `mkdtemp`, `readFile`, `writeFile` from `node:fs/promises`; `tmpdir` from `node:os`; `join` from `node:path`; `fileURLToPath` from `node:url`):

```ts
  it("refuses to start when the tenant file has no calendar section (spec addendum §5.1)", async () => {
    const bc = JSON.parse(await readFile(fileURLToPath(new URL("../../../config/tenants/bc.json", import.meta.url)), "utf8")) as Record<string, unknown>;
    delete bc.calendar;
    const dir = await mkdtemp(join(tmpdir(), "calendar-tenant-"));
    const file = join(dir, "no-calendar.json");
    await writeFile(file, JSON.stringify(bc));
    await expect(
      startCalendar({
        DATABASE_URL: tdb.url,
        NODE_ENV: "test",
        LOCAL_ADMIN_ENABLED: "true",
        LOCAL_ADMIN_PASSWORD_HASH: await hashPassword("fixture-password-for-start-tests"),
        LOCAL_AUTH_SECRET: "x".repeat(32),
        SESSION_SECRET,
        TENANT_CONFIG: file,
      }),
    ).rejects.toThrow(/has no "calendar" section/);
  });
```

- [ ] **Step 2: Run it, then prove it can fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/start.test.ts`
Expected: PASS (it pins existing behaviour). Then comment out the `if (!t.calendar) throw …` line in `apps/calendar/src/rules.ts`, run again, expect FAIL ("Cannot read properties of undefined" or a resolved promise), and restore the line.

- [ ] **Step 3: The lock race barrier**

In `apps/calendar/test/helpers.ts`, replace `waitForLockWaiter` with:

```ts
/** Resolves once at least `count` sessions are blocked on a lock. */
export async function waitForLockWaiters(tdb: TestDatabase, count: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await tdb.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
    if (r.rows[0]!.n >= count) return;
    if (Date.now() > deadline) throw new Error(`fewer than ${count} sessions started waiting for a lock`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Resolves once some session is blocked on a lock. */
export function waitForLockWaiter(tdb: TestDatabase, timeoutMs = 5000): Promise<void> {
  return waitForLockWaiters(tdb, 1, timeoutMs);
}
```

In `apps/calendar/src/http/transfer-routes.test.ts`, delete the file-local `waitForLockWaiters(n, timeoutMs)` function at the end of the `describe`, import `waitForLockWaiters` from `../../test/helpers`, and change its one call to `await waitForLockWaiters(tdb, 2);`.

In `apps/calendar/src/http/activity-locks.test.ts`, add `sql` to the `drizzle-orm` import and `waitForLockWaiters` to the helpers import, and replace the "two people taking it at once" test with:

```ts
  it("two people taking it at once: exactly one wins", async () => {
    // Hold the activity's lock until both requests are provably waiting on it, then let them race.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const blocker = tdb.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`calendar-activity:${id}`}))`);
      locked();
      await held;
    });
    await isLocked;
    const both = Promise.all([lock("editor", "tab-a"), lock("admin", "tab-b")]);
    await waitForLockWaiters(tdb, 2);
    release();
    await blocker;
    const [a, b] = await both;
    expect([a.status, b.status].sort()).toEqual([200, 423]);
  });
```

- [ ] **Step 4: Run them**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/http/activity-locks.test.ts apps/calendar/src/http/transfer-routes.test.ts`
Expected: PASS. To see the barrier bite, change `waitForLockWaiters(tdb, 2)` to `waitForLockWaiters(tdb, 3, 500)`: FAIL with "fewer than 3 sessions started waiting for a lock". Restore it.

- [ ] **Step 5: The All Day status-only test**

Add to `apps/calendar/src/http/activity-update.test.ts`, after "an imported title and summary that clean-up would rewrite raise no flag when saved unchanged":

```ts
  it("an imported activity whose only change is All Day: status Changed, no flag, and no Start or End in its history", async () => {
    // Already 00:00–23:45 BC, so ticking All Day moves neither time (contentFrom's all-day bounds).
    const id = await insertRaw(tdb.db, {
      title: "Sample ‘quoted’ title", details: "Sample “summary”…", commContactId: w.contact.editorHealth,
      startAt: new Date("2026-11-10T07:00:00Z"), endAt: new Date("2026-11-11T06:45:00Z"), isAllDay: false,
    });
    await tdb.db.execute(sql`INSERT INTO activity_categories (activity_id, category_id) VALUES (${id}, ${w.cat.plain})`);
    const a = (await call(app, "get", `/api/activities/${id}`, w.as.editor.cookie)).body;
    expect((await save("editor", a, { isAllDay: true })).status).toBe(200);
    expect(await row(id)).toMatchObject({
      isAllDay: true, needsReview: [], status: "changed",
      startAt: new Date("2026-11-10T07:00:00Z"), endAt: new Date("2026-11-11T06:45:00Z"),
    });
    const updated = (await historyOf(tdb.db, id)).find((h) => h.action === "updated")!;
    expect(updated.fields).toHaveProperty("is_all_day");
    expect(updated.fields).not.toHaveProperty("start");
    expect(updated.fields).not.toHaveProperty("end");
  });
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/http/activity-update.test.ts`
Expected: PASS (existing behaviour). Prove it can fail: change the test's expected status to `"reviewed"`, see FAIL, restore `"changed"`.

- [ ] **Step 6: The error-log test (RED)**

Add to `apps/calendar/src/http/errors.test.ts`:

```ts
  it("names the method and route path in its log lines, never the query string", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const req = { method: "GET", baseUrl: "/api", path: "/list", originalUrl: "/api/list?q=%7B%22quickSearch%22%3A%22Sample%20secret%22%7D" };
    for (const code of ["23505", "22021", "40001"]) sendActivityError(Object.assign(new Error("x"), { cause: { code } }), fakeRes(), req);
    const lines = log.mock.calls.map((c) => c.join(" "));
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toContain("GET /api/list");
      expect(line).not.toContain("q=");
      expect(line).not.toContain("secret");
    }
    log.mockRestore();
  });
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/http/errors.test.ts`
Expected: FAIL ("expected … to contain 'GET /api/list'").

- [ ] **Step 7: Log the route**

In `apps/calendar/src/http/errors.ts`:

```ts
/** The parts of a request a log line may name: never the query string, which can hold search text. */
export type RouteOf = { method: string; baseUrl: string; path: string };
const routeOf = (req?: RouteOf) => (req ? `${req.method} ${req.baseUrl}${req.path}` : "");

/** Maps the activity service's typed errors to a response; false leaves the error to the generic 500. */
export function sendActivityError(e: unknown, res: Response, req?: RouteOf): boolean {
```

and change the three `console.error` calls to append `routeOf(req)`:

```ts
    console.error("[calendar] activity write hit a constraint", label, routeOf(req));
    …
    console.error("[calendar] activity write lost a race", label, routeOf(req));
    …
    console.error("[calendar] activity request hit an invalid value", label, routeOf(req));
```

In `apps/calendar/src/http/activity-routes.ts` and `apps/calendar/src/http/transfer-routes.ts`, pass the request: `if (!sendActivityError(e, res, req)) next(e);`.

Run the errors test again. Expected: PASS.

- [ ] **Step 8: The Transfer per-batch test (RED)**

Add to `apps/calendar/src/http/transfer-routes.test.ts`, before "two transfers at once…":

```ts
  it("a target that can't receive by the next batch stops the run there, and says what moved", async () => {
    const from = await fresh(w.as.hqAdvanced.id);
    const to = await fresh(w.as.hqAdmin.id);
    for (let n = 0; n < 150; n++) await insertRaw(tdb.db, { commContactId: from });
    // Retires the target as soon as it holds 100 activities: inside the first batch's transaction.
    await tdb.db.execute(sql`CREATE FUNCTION retire_target() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF (SELECT count(*) FROM activities WHERE comm_contact_id = NEW.comm_contact_id) >= 100 THEN
        UPDATE comm_contacts SET is_active = false WHERE id = NEW.comm_contact_id;
      END IF;
      RETURN NEW;
    END $$`);
    await tdb.db.execute(sql`CREATE TRIGGER retire_target AFTER UPDATE OF comm_contact_id ON activities FOR EACH ROW EXECUTE FUNCTION retire_target()`);
    try {
      const res = await transfer("hqAdmin", from, to);
      expect(res.status).toBe(207);
      expect(res.body).toEqual({ transferred: 100, failed: true });
    } finally {
      await tdb.db.execute(sql`DROP TRIGGER retire_target ON activities`);
      await tdb.db.execute(sql`DROP FUNCTION retire_target()`);
    }
    const moved = await tdb.db.select({ id: activities.id }).from(activities).where(eq(activities.commContactId, to));
    expect(moved).toHaveLength(100);
  });
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/http/transfer-routes.test.ts -t "can't receive by the next batch"`
Expected: FAIL (`{ transferred: 150 }` with status 200).

- [ ] **Step 9: Re-check the target per batch**

In `apps/calendar/src/transfer.ts`, add (beside `receiveRefusal`; `Tx` from `@gcpe/db-kit`):

```ts
/** The target as it stands inside a batch's transaction: deactivated mid-run, it receives no more. */
async function targetRefusal(tx: Tx, toId: number, rules: CalendarRules): Promise<string | null> {
  const [c] = await tx
    .select({ isActive: commContacts.isActive, userIsActive: users.isActive, ministryIsActive: orgs.isActive, abbreviation: orgs.abbreviation })
    .from(commContacts)
    .leftJoin(users, eq(users.id, commContacts.userId))
    .leftJoin(orgs, eq(orgs.key, commContacts.ministryKey))
    .where(eq(commContacts.id, toId));
  return c ? receiveRefusal(c, rules) : "Choose an active comm contact to transfer to";
}
```

In `runTransfer`'s batch transaction, first thing after `const now = await dbNow(tx, deps.now);`:

```ts
        const refusal = await targetRefusal(tx, to.id, deps.rules);
        if (refusal) throw new TransferError(refusal);
```

The existing `catch` already rethrows on the first batch (422 through `transfer-routes.ts`) and returns `{ transferred, failed: true }` after it. Update the function's doc comment: "The target is re-checked at the start of each batch; one that can no longer receive ends the run there."

Delete the carry-forward note about the accepted race only in 5d-2's last task.

- [ ] **Step 10: Run the calendar suite**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add apps/calendar
git commit -m "test(calendar),fix(calendar): pin the tenant start-up refusal, barrier the lock race, isolate the All Day row; logs name the route; Transfer re-checks its target per batch"
```

---

### Task 2: The list contract: filter model, columns, rows and the friendly date range

Covers: spec §8.1 (filters, display, columns, sorting, corporate queries, the Look Ahead filter), §6 (who sees what is decided on the server; the contract only shapes requests). Decisions D2, D3, D4 (the From ≤ To rule), D11, D12, D22.

**Files:**
- Modify: `packages/calendar-contract/src/input.ts`, `packages/calendar-contract/src/index.ts`, `apps/calendar/src/db/schema.ts`.
- Create: `packages/calendar-contract/src/list.ts`, `packages/calendar-contract/src/list.test.ts`.
- Create: `packages/calendar-contract/src/format.ts`, `packages/calendar-contract/src/format.test.ts`.

**Interfaces:**
- Consumes: `ACTIVITY_STATUSES`, `ActivityStatus`, `HqStatus`, `NeedsReviewKey` (`enums.ts`), `safeString` (`input.ts`).
- Produces (all exported from `@gcpe/calendar-contract`):
  - `idSchema` (int, 1–2,147,483,647) and `bcDateSchema` (`YYYY-MM-DD`, a real date in 1900–2199).
  - Constants: `LIST_DISPLAYS`, `LIST_COLUMNS`, `LIST_COLUMN_LABELS`, `DEFAULT_HIDDEN_COLUMNS`, `HIDEABLE_COLUMNS`, `LIST_SORTS`, `LOOK_AHEAD_FILTERS`, `CORPORATE_STATUSES`, `LIST_PAGE_SIZE` (30), `LIST_QUERY_MAX_CHARS` (8,000), `CALENDAR_RANGE_MAX_DAYS` (42).
  - Types: `ListDisplay`, `ListColumn`, `HideableColumn`, `ListSort`, `LookAheadFilter`, `CorporateStatus`.
  - Schemas and types: `listFilterSchema` → `ListFilter`; `EMPTY_LIST_FILTER`; `corporateQuerySchema` → `CorporateQuery`; `listQuerySchema` → `ListQuery` (input `ListQueryInput`); `DEFAULT_LIST_QUERY`; `listPreferencesSchema` → `ListPreferences`; `savedFilterCreateSchema`, `savedFilterRenameSchema`, `savedFilterOrderSchema`.
  - `checkCalendarRange(start: string, end: string): string | null`.
  - Interfaces: `ListRow`, `ListPage`, `ListOption`, `ListOptions`, `SavedFilterView`, `CalendarItem`, `CalendarRangeView`.
  - `friendlyDateRange(a: DatedActivity, o: { timeZone: string; today: string; weekday?: boolean }): string` and `friendlySpan(at: Date, now: Date, timeZone: string): string`, with `interface DatedActivity { startAt: string | Date | null; endAt: string | Date | null; isAllDay: boolean; isConfirmed: boolean; potentialDates?: string | null }`.

- [ ] **Step 1: Write the failing tests**

`packages/calendar-contract/src/list.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  checkCalendarRange, DEFAULT_HIDDEN_COLUMNS, DEFAULT_LIST_QUERY, EMPTY_LIST_FILTER, HIDEABLE_COLUMNS, LIST_COLUMNS, LIST_SORTS,
  listFilterSchema, listPreferencesSchema, listQuerySchema, savedFilterCreateSchema, savedFilterOrderSchema,
} from "./list";

describe("the list filter model (spec addendum §8.1)", () => {
  it("fills every field from an empty object", () => {
    expect(EMPTY_LIST_FILTER).toEqual({
      from: null, to: null, thisDayOnly: false, quickSearch: "", keywordIds: [], isIssue: null, dateConfirmed: null, status: null,
      categoryId: null, ministryKey: null, commContactUserId: null, representativeId: null, initiativeId: null, premierRequestedId: null, distributionId: null,
    });
    expect(DEFAULT_LIST_QUERY).toEqual({ filter: EMPTY_LIST_FILTER, corporate: null, display: "all", lookAhead: "all", sort: "dateTime", dir: "asc" });
  });

  it("trims the quick search, lowercases a person's id, keeps a ministry key byte for byte", () => {
    const f = listFilterSchema.parse({ quickSearch: "  Sample  ", commContactUserId: "00000000-0000-4000-8000-0000000000AB", ministryKey: "M-OWN" });
    expect(f).toMatchObject({ quickSearch: "Sample", commContactUserId: "00000000-0000-4000-8000-0000000000ab", ministryKey: "M-OWN" });
  });

  it("refuses what the database can't hold or the list can't mean", () => {
    const bad = [
      { from: "2026-02-30" }, { from: "1899-12-31" }, { to: "2200-01-01" }, { from: "2026-11-05", to: "2026-11-04" },
      { categoryId: 2_147_483_648 }, { categoryId: 0 }, { keywordIds: Array.from({ length: 51 }, (_, i) => i + 1) },
      { quickSearch: "x".repeat(201) }, { quickSearch: "a\u0000b" }, { ministryKey: "" }, { commContactUserId: "not-a-uuid" },
      { status: "deleted" }, { extra: true },
    ];
    for (const f of bad) expect(listFilterSchema.safeParse(f).success, JSON.stringify(f)).toBe(false);
  });

  it("a query refuses an unknown sort, a sort on Premier, and a corporate query with no status or a day count past a year", () => {
    expect(LIST_SORTS).not.toContain("premier");
    expect(listQuerySchema.safeParse({ sort: "premier" }).success).toBe(false);
    expect(listQuerySchema.safeParse({ corporate: { days: 8, statuses: [] } }).success).toBe(false);
    expect(listQuerySchema.safeParse({ corporate: { days: 367, statuses: ["new"] } }).success).toBe(false);
    expect(listQuerySchema.safeParse({ corporate: { days: null, statuses: ["new", "new"] } }).success).toBe(false);
    expect(listQuerySchema.parse({ corporate: { days: null, statuses: ["la_new", "deleted"] } }).corporate).toEqual({ days: null, statuses: ["la_new", "deleted"] });
  });

  it("columns: legacy's order and default hidden set; the Activity Id column can't be hidden", () => {
    expect(LIST_COLUMNS[0]).toBe("activity");
    expect(DEFAULT_HIDDEN_COLUMNS).toEqual(["keywords", "ministry", "status", "translations"]);
    expect(HIDEABLE_COLUMNS).not.toContain("activity");
    expect(listPreferencesSchema.safeParse({ display: "all", hiddenColumns: ["activity"] }).success).toBe(false);
    expect(listPreferencesSchema.safeParse({ display: "all", hiddenColumns: ["city", "city"] }).success).toBe(false);
    expect(listPreferencesSchema.parse({ display: "my_watchlist", hiddenColumns: ["city"] })).toEqual({ display: "my_watchlist", hiddenColumns: ["city"] });
  });

  it("saved filters: a trimmed name of 1–200 characters and a valid filter; an order names each id once", () => {
    expect(savedFilterCreateSchema.parse({ name: "  Sample query ", filter: {} })).toEqual({ name: "Sample query", filter: EMPTY_LIST_FILTER });
    expect(savedFilterCreateSchema.safeParse({ name: "   ", filter: {} }).success).toBe(false);
    expect(savedFilterCreateSchema.safeParse({ name: "x".repeat(201), filter: {} }).success).toBe(false);
    expect(savedFilterOrderSchema.safeParse({ ids: [1, 1] }).success).toBe(false);
  });

  it("a calendar range is at most 42 days and ends on or after it starts", () => {
    expect(checkCalendarRange("2026-11-01", "2026-12-12")).toBeNull();
    expect(checkCalendarRange("2026-11-01", "2026-12-13")).toMatch(/42 days/);
    expect(checkCalendarRange("2026-11-02", "2026-11-01")).toMatch(/end/);
  });
});
```

`packages/calendar-contract/src/format.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { friendlyDateRange, friendlySpan } from "./format";

const tz = "America/Vancouver";
// BC is UTC−7 from 2026-11-01, so 09:00 BC is 16:00Z.
const at = (iso: string) => new Date(iso);
const o = { timeZone: tz, today: "2026-11-03" };

describe("friendlyDateRange (ActivityListProvider.ashx.cs:769-840)", () => {
  const timed = (start: string, end: string, more: object = {}) => ({ startAt: at(start), endAt: at(end), isAllDay: false, isConfirmed: true, ...more });
  it("one timed day: weekday, month, day, and the times with AM/PM once when both share it", () => {
    expect(friendlyDateRange(timed("2026-11-10T16:00:00Z", "2026-11-10T17:00:00Z"), o)).toBe("Tue Nov 10 9:00-10:00 AM");
    expect(friendlyDateRange(timed("2026-11-10T18:00:00Z", "2026-11-10T20:00:00Z"), o)).toBe("Tue Nov 10 11:00 AM-1:00 PM");
  });
  it("all day: the date alone; another year shows the year", () => {
    expect(friendlyDateRange({ ...timed("2026-11-10T07:00:00Z", "2026-11-11T06:45:00Z"), isAllDay: true }, o)).toBe("Tue Nov 10");
    expect(friendlyDateRange(timed("2027-01-06T16:00:00Z", "2027-01-06T17:00:00Z"), o)).toBe("Wed Jan 6 2027 9:00-10:00 AM");
  });
  it("several days: no weekday, the month once when it doesn't change, years when they differ", () => {
    expect(friendlyDateRange(timed("2026-11-10T16:00:00Z", "2026-11-12T17:00:00Z"), o)).toBe("Nov 10-12");
    expect(friendlyDateRange(timed("2026-11-30T16:00:00Z", "2026-12-02T17:00:00Z"), o)).toBe("Nov 30-Dec 2");
    expect(friendlyDateRange(timed("2026-12-30T16:00:00Z", "2027-01-02T17:00:00Z"), o)).toBe("Dec 30 2026-Jan 2 2027");
  });
  it("unconfirmed: TBC, Time TBD for legacy's 8 AM to 6 PM placeholder, Potential Dates in place of the dates", () => {
    expect(friendlyDateRange(timed("2026-11-10T16:00:00Z", "2026-11-10T17:00:00Z", { isConfirmed: false }), o)).toBe("Tue Nov 10 9:00-10:00 AM TBC");
    expect(friendlyDateRange(timed("2026-11-10T15:00:00Z", "2026-11-11T01:00:00Z", { isConfirmed: false }), o)).toBe("Tue Nov 10 Time TBD");
    expect(friendlyDateRange(timed("2026-11-10T16:00:00Z", "2026-11-10T17:00:00Z", { isConfirmed: false, potentialDates: "Late November" }), o)).toBe("Late November TBC");
  });
  it("no dates: the Potential Dates, or a dash", () => {
    expect(friendlyDateRange({ startAt: null, endAt: null, isAllDay: false, isConfirmed: false, potentialDates: "Spring" }, o)).toBe("Spring");
    expect(friendlyDateRange({ startAt: null, endAt: null, isAllDay: false, isConfirmed: false }, o)).toBe("—");
  });
});

describe("friendlySpan (ActivityListProvider.ashx.cs:850-876)", () => {
  const now = at("2026-11-03T18:00:00Z");
  it("months, weeks, days, then hours or minutes the same day", () => {
    expect(friendlySpan(at("2026-09-01T18:00:00Z"), now, tz)).toBe("2 Months");
    expect(friendlySpan(at("2026-10-20T18:00:00Z"), now, tz)).toBe("2 Weeks");
    expect(friendlySpan(at("2026-11-01T18:00:00Z"), now, tz)).toBe("2 Days");
    expect(friendlySpan(at("2026-11-03T15:00:00Z"), now, tz)).toBe("3 Hours");
    expect(friendlySpan(at("2026-11-03T17:59:00Z"), now, tz)).toBe("1 Minute");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/calendar-contract/src/list.test.ts packages/calendar-contract/src/format.test.ts`
Expected: FAIL ("Failed to resolve import ./list" and "./format").

- [ ] **Step 3: Export the two input schemas**

In `packages/calendar-contract/src/input.ts`:
- replace `const id = z.number().int().positive().max(2_147_483_647);` with
  ```ts
  /** An id the database's int4 columns can hold. */
  export const idSchema = z.number().int().positive().max(2_147_483_647);
  const id = idSchema;
  ```
- replace `const date = z.string()…` (the line starting `const date =`) with the same expression assigned to `export const bcDateSchema`, followed by `const date = bcDateSchema;`, and give it the doc comment `/** A BC calendar date, YYYY-MM-DD, between 1900 and 2199. */`.

- [ ] **Step 4: Write `list.ts`**

`packages/calendar-contract/src/list.ts`:

```ts
import { z } from "zod";
import { ACTIVITY_STATUSES, type ActivityStatus, type HqStatus, type NeedsReviewKey } from "./enums";
import { bcDateSchema, idSchema, safeString } from "./input";

/** The list's "Display" choice (spec addendum §8.1; legacy FilterDisplayValue 3, 2, 4 and 10). */
export const LIST_DISPLAYS = ["all", "my_ministries", "my_activities", "my_watchlist"] as const;
export type ListDisplay = (typeof LIST_DISPLAYS)[number];

/** The list's columns in legacy's order (UCFlexiGrid.ascx.cs:255-274). */
export const LIST_COLUMNS = [
  "activity", "keywords", "ministry", "status", "dateTime", "title", "categories", "commMaterials", "premier", "leadOrg", "translations", "city", "commContact", "governmentRep",
] as const;
export type ListColumn = (typeof LIST_COLUMNS)[number];
export const LIST_COLUMN_LABELS: Readonly<Record<ListColumn, string>> = {
  activity: "Activity Id", keywords: "HQ Tags", ministry: "Ministry", status: "Status", dateTime: "Date & Time", title: "Title & Summary",
  categories: "Categories", commMaterials: "Comm. Materials", premier: "Premier", leadOrg: "Lead Org.", translations: "Translations", city: "City",
  commContact: "Comm. Contact", governmentRep: "Govt Rep.",
};
/** The Activity Id cell holds the row's checkbox and watch star, so it always shows. */
export type HideableColumn = Exclude<ListColumn, "activity">;
export const HIDEABLE_COLUMNS = LIST_COLUMNS.filter((c): c is HideableColumn => c !== "activity");
/** Legacy's ColumnModel.HiddenByDefault: HQ Tags, Ministry, Status and Translations. */
export const DEFAULT_HIDDEN_COLUMNS: readonly HideableColumn[] = ["keywords", "ministry", "status", "translations"];

/** Every column legacy could sort by; Premier couldn't. */
export const LIST_SORTS = [
  "activity", "keywords", "ministry", "status", "dateTime", "title", "categories", "commMaterials", "leadOrg", "translations", "city", "commContact", "governmentRep",
] as const;
export type ListSort = (typeof LIST_SORTS)[number];

/** The Admin Settings' Look Ahead filter (Default.aspx:684-698): HQ Advanced and above. */
export const LOOK_AHEAD_FILTERS = ["all", "look_ahead_only", "not_for_look_ahead_only"] as const;
export type LookAheadFilter = (typeof LOOK_AHEAD_FILTERS)[number];

/** Corporate Queries' statuses (Default.aspx:628-660, Default.aspx.cs:44-49). */
export const CORPORATE_STATUSES = ["new", "changed", "reviewed", "deleted", "la_new", "la_changed"] as const;
export type CorporateStatus = (typeof CORPORATE_STATUSES)[number];

/** Rows per page, as legacy's grid (UCFlexiGrid.ascx.cs RecordsPerPage). */
export const LIST_PAGE_SIZE = 30;
/** The longest `q` parameter the list routes accept. */
export const LIST_QUERY_MAX_CHARS = 8000;
/** A month view's six weeks. */
export const CALENDAR_RANGE_MAX_DAYS = 42;

const unique = <T>(xs: readonly T[]) => new Set(xs).size === xs.length;
const optionalId = idSchema.nullable().default(null);

/** What a saved filter holds (spec addendum §8.1). Display, the Look Ahead filter and the sort sit beside it in ListQuery. */
export const listFilterSchema = z
  .object({
    from: bcDateSchema.nullable().default(null),
    to: bcDateSchema.nullable().default(null),
    thisDayOnly: z.boolean().default(false),
    quickSearch: safeString().max(200).default("").transform((s) => s.trim()),
    /** HQ Tags, matched with OR. */
    keywordIds: z.array(idSchema).max(50).default([]),
    isIssue: z.boolean().nullable().default(null),
    dateConfirmed: z.boolean().nullable().default(null),
    status: z.enum(ACTIVITY_STATUSES).nullable().default(null),
    categoryId: optionalId,
    /** Lead Ministry: a Core organization key, byte for byte. */
    ministryKey: safeString().min(1).max(200).nullable().default(null),
    /** Comm Contact: the person (a Core user id), whichever of their comm contact rows the activity holds. */
    commContactUserId: z.string().uuid().transform((s) => s.toLowerCase()).nullable().default(null),
    representativeId: optionalId,
    initiativeId: optionalId,
    premierRequestedId: optionalId,
    distributionId: optionalId,
  })
  .strict()
  .refine((f) => !f.from || !f.to || f.from <= f.to, { message: "From must be on or before To", path: ["to"] });
export type ListFilter = z.output<typeof listFilterSchema>;
export const EMPTY_LIST_FILTER: ListFilter = listFilterSchema.parse({});

export const corporateQuerySchema = z
  .object({
    /** Null is "Show all" upcoming; otherwise the next N days. */
    days: z.number().int().min(0).max(366).nullable(),
    statuses: z.array(z.enum(CORPORATE_STATUSES)).min(1).max(CORPORATE_STATUSES.length).refine(unique, "each status once"),
  })
  .strict();
export type CorporateQuery = z.output<typeof corporateQuerySchema>;

export const listQuerySchema = z
  .object({
    filter: listFilterSchema.default({}),
    /** A corporate query replaces the filter and the display. */
    corporate: corporateQuerySchema.nullable().default(null),
    display: z.enum(LIST_DISPLAYS).default("all"),
    lookAhead: z.enum(LOOK_AHEAD_FILTERS).default("all"),
    sort: z.enum(LIST_SORTS).default("dateTime"),
    dir: z.enum(["asc", "desc"]).default("asc"),
  })
  .strict();
export type ListQuery = z.output<typeof listQuerySchema>;
export type ListQueryInput = z.input<typeof listQuerySchema>;
export const DEFAULT_LIST_QUERY: ListQuery = listQuerySchema.parse({});

export const listPreferencesSchema = z
  .object({
    display: z.enum(LIST_DISPLAYS),
    hiddenColumns: z.array(z.enum(HIDEABLE_COLUMNS as [HideableColumn, ...HideableColumn[]])).max(HIDEABLE_COLUMNS.length).refine(unique, "each column once"),
  })
  .strict();
export type ListPreferences = z.output<typeof listPreferencesSchema>;

const savedFilterName = safeString().trim().min(1, "Enter a name").max(200, "At most 200 characters");
export const savedFilterCreateSchema = z.object({ name: savedFilterName, filter: listFilterSchema }).strict();
export const savedFilterRenameSchema = z.object({ name: savedFilterName }).strict();
export const savedFilterOrderSchema = z.object({ ids: z.array(idSchema).max(200).refine(unique, "each query once") }).strict();

/** Why a calendar range is refused, or null. */
export function checkCalendarRange(start: string, end: string): string | null {
  if (end < start) return "The range must end on or after it starts";
  const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000 + 1;
  return days > CALENDAR_RANGE_MAX_DAYS ? `A calendar range is at most ${CALENDAR_RANGE_MAX_DAYS} days` : null;
}

/** One row of the list (UCFlexiGrid's columns, plus what the Excel export and the tooltips need). */
export interface ListRow {
  id: number;
  version: number;
  ministryKey: string | null;
  ministryAbbreviation: string | null;
  status: ActivityStatus;
  hqStatus: HqStatus | null;
  isDeleted: boolean;
  isWatched: boolean;
  /** The star's tooltip (Activity.aspx.cs:1519-1535). */
  watcherNames: string[];
  isShared: boolean;
  hasRelease: boolean;
  createdAt: string;
  lastUpdatedAt: string;
  lastUpdatedByName: string | null;
  /** HQ Tags. */
  keywords: string[];
  startAt: string | null;
  endAt: string | null;
  isAllDay: boolean;
  isConfirmed: boolean;
  potentialDates: string;
  title: string;
  details: string;
  significance: string;
  strategy: string;
  schedule: string;
  categories: string[];
  isIssue: boolean;
  isConfidential: boolean;
  commMaterials: string[];
  nrOrigins: string[];
  nrDistribution: string | null;
  premierRequested: string | null;
  leadOrganization: string;
  translations: string[];
  /** The city's name, or Other City when the city is "Other…". */
  city: string | null;
  venue: string;
  commContact: { name: string; phone: string | null } | null;
  governmentRepresentative: string | null;
  eventPlanner: string | null;
  /** The list's review markup: empty unless the viewer is HQ at Administrator and above (spec addendum §6). */
  needsReview: NeedsReviewKey[];
}

export interface ListPage {
  rows: ListRow[];
  total: number;
  offset: number;
}

export interface ListOption {
  id: number;
  name: string;
}

/** The filter panel's choices (Default.aspx.cs:55-140). */
export interface ListOptions {
  categories: ListOption[];
  keywords: ListOption[];
  representatives: ListOption[];
  initiatives: ListOption[];
  premierRequested: ListOption[];
  distributions: ListOption[];
  ministries: { key: string; abbreviation: string | null; name: string }[];
  commContacts: { userId: string; name: string }[];
}

export interface SavedFilterView {
  id: number;
  name: string;
  sortOrder: number;
  /** Null when what is stored no longer reads as a filter. */
  filter: ListFilter | null;
}

export interface CalendarItem {
  id: number;
  title: string;
  startAt: string | null;
  endAt: string | null;
  isAllDay: boolean;
  isConfirmed: boolean;
  isConfidential: boolean;
  ministryAbbreviation: string | null;
}

export interface CalendarRangeView {
  items: CalendarItem[];
  truncated: boolean;
}
```

- [ ] **Step 5: Write `format.ts`**

`packages/calendar-contract/src/format.ts`:

```ts
interface Wall {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  /** 0 is Sunday. */
  dow: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function wall(at: Date, timeZone: string): Wall {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formatters.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  const [y, m, d] = [Number(p.year), Number(p.month), Number(p.day)];
  return { y, m, d, hh: Number(p.hour), mm: Number(p.minute), dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const sameDay = (a: Wall, b: { y: number; m: number; d: number }) => a.y === b.y && a.m === b.m && a.d === b.d;
const dateText = (w: Wall, year: boolean, weekday: boolean) => `${weekday ? `${DAYS[w.dow]} ` : ""}${MONTHS[w.m - 1]} ${w.d}${year ? ` ${w.y}` : ""}`;
const timeText = (w: Wall, ampm: boolean) => `${w.hh % 12 === 0 ? 12 : w.hh % 12}:${String(w.mm).padStart(2, "0")}${ampm ? (w.hh < 12 ? " AM" : " PM") : ""}`;

export interface DatedActivity {
  startAt: string | Date | null;
  endAt: string | Date | null;
  isAllDay: boolean;
  isConfirmed: boolean;
  potentialDates?: string | null;
}

/**
 * Legacy's FriendlyDateTimeRange (ActivityListProvider.ashx.cs:769-840), in the tenant's time
 * zone, with plain spaces. `today` is the BC date (YYYY-MM-DD) that decides when a year shows.
 */
export function friendlyDateRange(a: DatedActivity, o: { timeZone: string; today: string; weekday?: boolean }): string {
  if (!a.startAt || !a.endAt) return a.potentialDates || "—";
  const s = wall(new Date(a.startAt), o.timeZone);
  const e = wall(new Date(a.endAt), o.timeZone);
  const [ty, tm, td] = o.today.split("-").map(Number) as [number, number, number];
  const today = { y: ty, m: tm, d: td };
  // An unconfirmed 8 AM to 6 PM day is legacy's "time to be decided" placeholder (IsTimeTBD).
  const timeTbd = sameDay(s, e) && !a.isConfirmed && s.hh === 8 && s.mm === 0 && e.hh === 18 && e.mm === 0;
  let value = "";
  if (sameDay(s, e)) {
    const isToday = sameDay(s, today);
    value = dateText(s, !isToday && s.y !== today.y, isToday || (o.weekday ?? true));
    if (!a.isAllDay && !timeTbd) value += ` ${timeText(s, s.hh >= 12 !== e.hh >= 12)}-${timeText(e, true)}`;
  } else {
    const year = s.y !== e.y || s.y !== today.y;
    value = `${dateText(s, year, false)}-${year || s.m !== e.m ? dateText(e, year, false) : String(e.d)}`;
  }
  if (a.isConfirmed) return value;
  return `${a.potentialDates || value} ${timeTbd ? "Time TBD" : "TBC"}`;
}

const count = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** Legacy's FriendlyTimeSpan ("updated 3 Days ago by …"; ActivityListProvider.ashx.cs:850-876). */
export function friendlySpan(at: Date, now: Date, timeZone: string): string {
  const ms = Math.max(0, now.getTime() - at.getTime());
  const days = Math.floor(ms / 86_400_000);
  if (days >= 30) return count(Math.floor(days / 30), "Month");
  if (days >= 7) return count(Math.floor(days / 7), "Week");
  const a = wall(at, timeZone);
  const b = wall(now, timeZone);
  if (sameDay(a, b)) {
    const hours = Math.floor(ms / 3_600_000);
    return hours > 0 ? count(hours, "Hour") : count(Math.floor(ms / 60_000), "Minute");
  }
  return count(Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000), "Day");
}
```

In `packages/calendar-contract/src/index.ts`, add `export * from "./format";` and `export * from "./list";`.

In `apps/calendar/src/db/schema.ts`, delete the local `LIST_DISPLAYS`/`ListDisplay` definitions, import them from `@gcpe/calendar-contract` (add to the existing import), and re-export them in the existing `export { … }` and `export type { … }` lines so other imports keep working.

- [ ] **Step 6: Run the tests and both type-checks**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/calendar-contract apps/calendar/src/db`
Then both `tsc` commands.
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/calendar-contract apps/calendar/src/db/schema.ts
git commit -m "feat(calendar-contract): the list's filter model, columns, rows and legacy's friendly date range"
```

---

### Task 3: The list query: which activities, in which order

Covers: spec §8.1 (dates, quick search, HQ Tags, Issue, Date Confirmed, Status, Category, Lead Ministry, Comm Contact, Representative, Initiative, Premier Requested, Distribution, the default hides, display modes, corporate queries, the Look Ahead admin filter, sorting, 30 a page), §6 (`visible()` in SQL; corporate queries and the Look Ahead filter at HQ and L ≥ Advanced; list markup at HQ Administrator), C127. Decisions D4–D11. Review Focus 1 and 3.

**Files:**
- Modify: `apps/calendar/src/capabilities.ts`, `apps/calendar/src/capabilities.test.ts`.
- Create: `apps/calendar/src/list/query.ts`, `apps/calendar/src/list/query.test.ts`.

**Interfaces:**
- Consumes: Task 2's `ListQuery`, `ListFilter`, `CorporateQuery`, `ListDisplay`, `ListSort`, `LIST_PAGE_SIZE`, `ACTIVITY_STATUSES`; `visibleSql`; `ActivityForbiddenError`; `inReadSnapshot`; `wallClock`, `bcMidnight`, `addDays`, `dbNow`; `ApiDeps`; `CalendarActor`.
- Produces:
  - `can.corporateQueries(u)`, `can.lookAheadFilter(u)` (HQ and L ≥ Advanced) and `can.seeListMarkup(u)` (HQ and L ≥ Administrator).
  - `interface ListScope { actor: CalendarActor; rules: CalendarRules; today: string; consultationsKeys: string[] }`.
  - `scopeOf(db: DbOrTx, deps: ApiDeps, actor: CalendarActor): Promise<ListScope>`.
  - `idSearchOf(term: string): number | null`; `containsPattern(term: string): string`.
  - `listWhere(scope: ListScope, q: ListQuery): SQL` (throws `ActivityForbiddenError` for a corporate query or a Look Ahead filter the caller may not use).
  - `listOrder(sort: ListSort, dir: "asc" | "desc", rules: CalendarRules): SQL[]`.
  - `listIds(tx: DbOrTx, scope: ListScope, q: ListQuery, offset: number): Promise<{ ids: number[]; total: number }>`.
  - `listPageIds(deps: ApiDeps, actor: CalendarActor, q: ListQuery, offset: number): Promise<{ ids: number[]; total: number }>` (in one read snapshot).

- [ ] **Step 1: Write the failing capability test**

Add to `apps/calendar/src/capabilities.test.ts`:

```ts
  it("the list's HQ tools: corporate queries and the Look Ahead filter at HQ Advanced, markup at HQ Administrator", () => {
    const v = (level: number, isHq: boolean) => ({ level, isHq, ministryKeys: ["m-own"] });
    for (const f of [can.corporateQueries, can.lookAheadFilter]) {
      expect(f(v(3, true))).toBe(true);
      expect(f(v(2, true))).toBe(false);
      expect(f(v(5, false))).toBe(false);
    }
    expect(can.seeListMarkup(v(4, true))).toBe(true);
    expect(can.seeListMarkup(v(3, true))).toBe(false);
    expect(can.seeListMarkup(v(5, false))).toBe(false);
  });
```

- [ ] **Step 2: Write the failing query tests**

`apps/calendar/src/list/query.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { listQuerySchema, type ListQueryInput } from "@gcpe/calendar-contract";
import { createCalendarTestDb, createTestApp, FIXED_NOW, projectUser, TEST_RULES } from "../../test/helpers";
import { insertRaw, seedWorld, type Who, type World } from "../../test/world";
import { loadCalendarActor } from "../actor";
import { ActivityForbiddenError } from "../activities/errors";
import { activities, activityCategories, activityInitiatives, activityKeywords, activitySharedWith, cities, favourites } from "../db/schema";
import type { ApiDeps } from "../http/routes";
import { instantOf } from "../time";
import { containsPattern, idSearchOf, listPageIds } from "./query";

const bc = (date: string, time = "09:00") => instantOf(date, time, TEST_RULES.timeZone);
/** Each test works in a year of its own, so no test sees another's activities. */
const year = (y: number) => ({ from: `${y}-01-01`, to: `${y}-12-31` });
const CONSULT_USER = "00000000-0000-4000-8000-000000000611";

describe("the list query (spec addendum §8.1)", () => {
  let tdb: TestDatabase;
  let w: World;
  let app: ReturnType<typeof createTestApp>;
  let deps: ApiDeps;

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    w = await seedWorld(app, tdb.db);
    deps = { db: tdb.db, rules: TEST_RULES, subscribers: [], now: () => FIXED_NOW };
  });
  afterAll(() => tdb.drop());

  async function idsAs(userId: string, q: ListQueryInput, offset = 0) {
    const actor = (await loadCalendarActor(tdb.db, userId))!;
    return listPageIds(deps, actor, listQuerySchema.parse(q), offset);
  }
  const ids = (who: Who, q: ListQueryInput, offset = 0) => idsAs(w.as[who].id, q, offset);
  const only = async (who: Who, q: ListQueryInput) => (await ids(who, q)).ids;

  /** One activity on `date` (BC), 09:00–10:00 unless told otherwise, reviewed, with its join rows. */
  async function act(date: string, o: { end?: string; endTime?: string; cats?: number[]; keywords?: number[]; shared?: string[]; initiatives?: number[]; row?: Partial<typeof activities.$inferInsert> } = {}) {
    const id = await insertRaw(tdb.db, { startAt: bc(date), endAt: bc(o.end ?? date, o.endTime ?? "10:00"), status: "reviewed", ...o.row });
    for (const c of o.cats ?? [w.cat.plain]) await tdb.db.insert(activityCategories).values({ activityId: id, categoryId: c });
    for (const k of o.keywords ?? []) await tdb.db.insert(activityKeywords).values({ activityId: id, keywordId: k });
    for (const m of o.shared ?? []) await tdb.db.insert(activitySharedWith).values({ activityId: id, ministryKey: m });
    for (const i of o.initiatives ?? []) await tdb.db.insert(activityInitiatives).values({ activityId: id, initiativeId: i });
    return id;
  }

  it("starts at today by default and lists what overlaps the range: ongoing activities count, yesterday's don't", async () => {
    await act("2026-11-02");
    const ongoing = await act("2026-10-20", { end: "2026-11-04" });
    const today = await act("2026-11-03");
    const later = await act("2026-11-05");
    await act("2026-11-07");
    expect(await only("hqAdmin", { filter: { to: "2026-11-05" } })).toEqual([ongoing, today, later]);
  });

  it("clamps a From before 2011 to 2011-01-01", async () => {
    await act("2010-06-01");
    const kept = await act("2011-02-01");
    expect(await only("hqAdmin", { filter: { from: "1990-01-01", to: "2011-12-31" } })).toEqual([kept]);
  });

  it("This day only lists activities that start and end that day", async () => {
    const one = await act("2032-03-10");
    await act("2032-03-10", { end: "2032-03-11" });
    await act("2032-03-09", { end: "2032-03-10" });
    expect(await only("hqAdmin", { filter: { from: "2032-03-10", thisDayOnly: true } })).toEqual([one]);
  });

  it("quick search finds a word in any of the eleven fields legacy searched, whatever its case", async () => {
    // No term is part of another, so each search can only find its own activity.
    const cases: [string, Partial<typeof activities.$inferInsert>][] = [
      ["apricotx", { title: "Sample apricotx title" }],
      ["bananax", { details: "Sample bananax details" }],
      ["cherryx", { cityId: w.city.other, otherCity: "Cherryx Bay" }],
      ["damsonx", { translations: ["Damsonx"] }],
      ["elderx", { significance: "Sample elderx" }],
      ["figx", { comments: "Sample figx" }],
      ["guavax", { leadOrganization: "Guavax Society" }],
      ["hucklex", { strategy: "Sample hucklex" }],
      ["jujubex", { schedule: "Sample jujubex" }],
      ["kiwix", { venue: "Kiwix Hall" }],
    ];
    for (const [term, row] of cases) {
      const id = await act("2033-02-01", { row });
      expect(await only("hqAdmin", { filter: { ...year(2033), quickSearch: term.toUpperCase() } }), term).toEqual([id]);
    }
    await tdb.db.insert(cities).values({ id: 900, name: "Sample Lemonx" });
    const c = await act("2033-02-02", { row: { cityId: 900 } });
    expect(await only("hqAdmin", { filter: { ...year(2033), quickSearch: "lemonx" } })).toEqual([c]);
  });

  it("the Executive Summary is searched only for those who see the Look Ahead fieldset (C172)", async () => {
    const id = await act("2033-03-01", { row: { hqComments: "Sample mangox summary" } });
    expect(await only("hqEditor", { filter: { ...year(2033), quickSearch: "mangox" } })).toEqual([id]);
    expect(await only("editor", { filter: { ...year(2033), quickSearch: "mangox" } })).toEqual([]);
  });

  it("%, _ and \\ in a search are literal characters", async () => {
    const pct = await act("2033-04-01", { row: { title: "Sample 50% off" } });
    await act("2033-04-01", { row: { title: "Sample 500 off" } });
    const under = await act("2033-04-01", { row: { title: "Sample a_b" } });
    await act("2033-04-01", { row: { title: "Sample axb" } });
    const slash = await act("2033-04-01", { row: { title: "Sample c\\d" } });
    const day = { from: "2033-04-01", to: "2033-04-01" };
    expect(await only("hqAdmin", { filter: { ...day, quickSearch: "50%" } })).toEqual([pct]);
    expect(await only("hqAdmin", { filter: { ...day, quickSearch: "a_b" } })).toEqual([under]);
    expect(await only("hqAdmin", { filter: { ...day, quickSearch: "c\\d" } })).toEqual([slash]);
    expect(containsPattern("5%_\\")).toBe("%5\\%\\_\\\\%");
  });

  it("a number above 10,000, or ABBR-number at any size, finds that activity alone, ignoring the other filters and the dates", async () => {
    const big = await act("2020-05-05", { row: { id: 20_001 } });
    const small = await act("2034-01-01", { row: { title: "Sample 2034 report" } });
    expect(await only("hqAdmin", { filter: { quickSearch: "20001", categoryId: w.cat.speech } })).toEqual([big]);
    expect(await only("hqAdmin", { filter: { quickSearch: `HLTH-${small}` } })).toEqual([small]);
    // A bare number up to 10,000 is a word, such as a year.
    expect(await only("hqAdmin", { filter: { ...year(2034), quickSearch: "2034" } })).toEqual([small]);
    expect(idSearchOf("12")).toBeNull();
    expect(idSearchOf("FIN-12")).toBe(12);
    expect(idSearchOf("FIN-0")).toBeNull();
    expect(idSearchOf("99999999999")).toBeNull();
  });

  it("an id search stays inside visibility: another ministry's confidential activity isn't found", async () => {
    const secret = await act("2034-02-01", { row: { id: 20_002, contactMinistryKey: "finance", isConfidential: true } });
    expect(await only("hqEditor", { filter: { quickSearch: "20002" } })).toEqual([]);
    expect(await only("financeEditor", { filter: { quickSearch: "20002" } })).toEqual([secret]);
  });

  it("each filter narrows as legacy's did", async () => {
    const y = year(2035);
    await act("2035-01-10");
    const kw1 = await act("2035-01-11", { keywords: [w.ids.keptKeyword] });
    const kw2 = await act("2035-01-12", { keywords: [w.ids.sampleTag] });
    const issue = await act("2035-01-13", { row: { isIssue: true } });
    const unconfirmedMultiDay = await act("2035-01-14", { end: "2035-01-15", row: { isConfirmed: false } });
    await act("2035-01-16", { row: { isConfirmed: false } });
    const unconfirmedAllDay = await act("2035-01-17", { row: { isConfirmed: false, isAllDay: true } });
    const changed = await act("2035-01-18", { row: { status: "changed" } });
    const event = await act("2035-01-19", { cats: [w.cat.event] });
    const rep = await act("2035-01-20", { row: { governmentRepresentativeId: w.ids.representative } });
    const premier = await act("2035-01-21", { row: { premierRequestedId: w.ids.premierYes } });
    const dist = await act("2035-01-22", { row: { nrDistributionId: w.ids.distribution } });
    const init = await act("2035-01-23", { initiatives: [w.ids.initiative] });
    const q = (filter: object) => only("hqAdmin", { filter: { ...y, ...filter } });
    const all = await q({});
    expect(all).toHaveLength(13);
    expect(await q({ keywordIds: [w.ids.keptKeyword, w.ids.sampleTag] })).toEqual([kw1, kw2]);
    expect(await q({ isIssue: true })).toEqual([issue]);
    // Legacy always counts a timed single-day activity as matching Date Confirmed (ActivityDAO.cs:198).
    expect(await q({ dateConfirmed: true })).toEqual(all.filter((id) => id !== unconfirmedMultiDay && id !== unconfirmedAllDay));
    expect(await q({ status: "changed" })).toEqual([changed]);
    expect(await q({ categoryId: w.cat.event })).toEqual([event]);
    expect(await q({ representativeId: w.ids.representative })).toEqual([rep]);
    expect(await q({ premierRequestedId: w.ids.premierYes })).toEqual([premier]);
    expect(await q({ distributionId: w.ids.distribution })).toEqual([dist]);
    expect(await q({ initiativeId: w.ids.initiative })).toEqual([init]);
  });

  it("Lead Ministry matches the lead or a shared-with ministry; Comm Contact matches the person, inactive contacts included", async () => {
    const y = year(2036);
    const health = await act("2036-01-10");
    const finance = await act("2036-01-11", { row: { contactMinistryKey: "finance" } });
    const sharedToHealth = await act("2036-01-12", { row: { contactMinistryKey: "finance" }, shared: ["health"] });
    const byEditor = await act("2036-01-13", { row: { commContactId: w.contact.editorHealth } });
    const byRetired = await act("2036-01-14", { row: { commContactId: w.contact.retiredHealth } });
    const q = (filter: object) => only("hqAdmin", { filter: { ...y, ...filter } });
    expect(await q({ ministryKey: "health" })).toEqual([health, sharedToHealth, byEditor, byRetired]);
    expect(await q({ ministryKey: "finance" })).toEqual([finance, sharedToHealth]);
    expect(await q({ commContactUserId: w.as.editor.id })).toEqual([byEditor]);
    expect(await q({ commContactUserId: w.as.advanced.id })).toEqual([byRetired]);
  });

  it("My Ministries leaves out what is only shared; My Activities is mine as comm contact; My Watchlist is what I watch", async () => {
    const y = year(2037);
    const own = await act("2037-01-10", { row: { commContactId: w.contact.editorHealth } });
    const shared = await act("2037-01-11", { row: { contactMinistryKey: "finance" }, shared: ["health"] });
    const other = await act("2037-01-12", { row: { commContactId: w.contact.adminHealth } });
    const awareness = await act("2037-01-13", { cats: [w.cat.awareness] });
    await tdb.db.insert(favourites).values([{ userId: w.as.editor.id, activityId: shared }, { userId: w.as.editor.id, activityId: awareness }]);
    const q = (display: ListQueryInput["display"], filter: object = {}) => only("editor", { filter: { ...y, ...filter }, display });
    expect(await q("all")).toEqual([own, shared, other]);
    expect(await q("my_ministries")).toEqual([own, other]);
    expect(await q("my_activities")).toEqual([own]);
    expect(await q("my_activities", { commContactUserId: w.as.admin.id })).toEqual([other]);
    // The default hides don't apply to what you chose to watch.
    expect(await q("my_watchlist")).toEqual([shared, awareness]);
  });

  it("hides Awareness dates and the consultations ministry unless the filter names them", async () => {
    const y = year(2038);
    const plain = await act("2038-01-10");
    const awareness = await act("2038-01-11", { cats: [w.cat.awareness] });
    const consult = await act("2038-01-12", { row: { contactMinistryKey: "consult" } });
    expect(await only("hqAdmin", { filter: y })).toEqual([plain]);
    expect(await only("hqAdmin", { filter: { ...y, categoryId: w.cat.awareness } })).toEqual([awareness]);
    expect(await only("hqAdmin", { filter: { ...y, ministryKey: "consult" } })).toEqual([consult]);
    // Someone whose only ministry is the consultations ministry sees its activities (ActivityListProvider.ashx.cs:91).
    await projectUser(app, { id: CONSULT_USER, email: "consult@example.test", displayName: "Sample Consultations Editor", isActive: true, calendarRole: "Calendar.Editor", organizationKeys: ["consult"] });
    expect((await idsAs(CONSULT_USER, { filter: y })).ids).toEqual([consult]);
  });

  it("deleted activities: HQ Administrators see those awaiting review, also under Changed; nobody else does", async () => {
    const y = year(2039);
    const live = await act("2039-01-10");
    const awaiting = await act("2039-01-11", { row: { deletedAt: FIXED_NOW, needsReview: ["active"] } });
    await act("2039-01-12", { row: { deletedAt: FIXED_NOW } });
    expect(await only("hqAdmin", { filter: y })).toEqual([live, awaiting]);
    expect(await only("hqAdmin", { filter: { ...y, status: "changed" } })).toEqual([awaiting]);
    expect(await only("hqAdmin", { filter: { ...y, status: "reviewed" } })).toEqual([live]);
    expect(await only("hqAdvanced", { filter: y })).toEqual([live]);
    expect(await only("admin", { filter: y })).toEqual([live]);
  });

  it("corporate queries: HQ Advanced and above only; upcoming by days and status; deletions by Changed or Deleted", async () => {
    for (const who of ["hqEditor", "advanced", "admin"] as const) {
      await expect(ids(who, { corporate: { days: 8, statuses: ["new"] } })).rejects.toBeInstanceOf(ActivityForbiddenError);
    }
    // Today is 2026-11-03 in BC; eight days reach the end of 2026-11-11.
    const fresh = await act("2026-11-06", { row: { status: "new" } });
    const changed = await act("2026-11-08", { row: { status: "changed" } });
    const far = await act("2026-11-20", { row: { status: "new" } });
    const laNew = await act("2026-11-09", { row: { hqStatus: "new" } });
    const awaiting = await act("2026-11-10", { row: { deletedAt: FIXED_NOW, needsReview: ["active"] } });
    const done = await act("2026-11-11", { row: { deletedAt: FIXED_NOW } });
    const c = (who: Who, statuses: ("new" | "changed" | "reviewed" | "deleted" | "la_new" | "la_changed")[], days: number | null = 8) => only(who, { corporate: { days, statuses } });
    expect(await c("hqAdvanced", ["new", "changed"])).toEqual([fresh, changed]);
    expect(await c("hqAdmin", ["new", "changed"])).toEqual([fresh, changed, awaiting]);
    expect(await c("hqAdmin", ["deleted"])).toEqual([awaiting, done]);
    expect(await c("hqAdmin", ["la_new"])).toEqual([laNew]);
    expect(await c("hqAdvanced", ["new"], null)).toEqual([fresh, far]);
  });

  it("the Look Ahead filter: HQ Advanced and above only; Look Ahead only drops Not for Look Ahead items, and the reverse", async () => {
    const y = year(2040);
    const open = await act("2040-01-10");
    const secret = await act("2040-01-11", { row: { isConfidential: true } });
    await expect(ids("hqEditor", { filter: y, lookAhead: "look_ahead_only" })).rejects.toBeInstanceOf(ActivityForbiddenError);
    expect(await only("hqAdvanced", { filter: y, lookAhead: "look_ahead_only" })).toEqual([open]);
    expect(await only("hqAdvanced", { filter: y, lookAhead: "not_for_look_ahead_only" })).toEqual([secret]);
    // Visibility still decides: an HQ Editor doesn't see another ministry's confidential item.
    expect(await only("hqEditor", { filter: y })).toEqual([open]);
  });

  it("sorts by each column, then by start and id; empty values last", async () => {
    const y = year(2041);
    const b = await act("2041-01-10", {
      cats: [w.cat.speech],
      row: { title: "Sample Bravo", leadOrganization: "Zed Org", commContactId: w.contact.adminHealth, governmentRepresentativeId: w.ids.representative2 },
    });
    const a = await act("2041-01-11", {
      cats: [w.cat.event],
      row: { title: "sample alpha", leadOrganization: "Alpha Org", commContactId: w.contact.editorHealth, governmentRepresentativeId: w.ids.representative, cityId: w.city.other, otherCity: "Aardvark Cove" },
    });
    const c = await act("2041-01-12", { cats: [w.cat.plain], row: { title: "Sample Charlie", cityId: w.city.sample } });
    const s = (sort: ListQueryInput["sort"], dir: "asc" | "desc" = "asc") => only("hqAdmin", { filter: y, sort, dir });
    expect(await s("title")).toEqual([a, b, c]);
    expect(await s("title", "desc")).toEqual([c, b, a]);
    expect(await s("dateTime", "desc")).toEqual([c, a, b]);
    expect(await s("leadOrg")).toEqual([a, b, c]);
    expect(await s("leadOrg", "desc")).toEqual([b, a, c]);
    // Robin Staff, then Sample Admin; c has no comm contact.
    expect(await s("commContact")).toEqual([a, b, c]);
    expect(await s("governmentRep")).toEqual([a, b, c]);
    // Other City "Aardvark Cove", then "Sample City"; b has no city.
    expect(await s("city")).toEqual([a, c, b]);
    // "Sample approved event", "Sample plain category", "Sample speech".
    expect(await s("categories")).toEqual([a, c, b]);
  });

  it("pages 30 at a time with the total; an offset past the end gives no rows and the true total", async () => {
    const y = year(2042);
    const made: number[] = [];
    for (let n = 0; n < 65; n++) made.push(await act("2042-01-10"));
    expect(await ids("hqAdmin", { filter: y })).toEqual({ ids: made.slice(0, 30), total: 65 });
    expect(await ids("hqAdmin", { filter: y }, 60)).toEqual({ ids: made.slice(60), total: 65 });
    expect(await ids("hqAdmin", { filter: y }, 90)).toEqual({ ids: [], total: 65 });
    expect(await ids("hqAdmin", { filter: year(2043) })).toEqual({ ids: [], total: 0 });
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/capabilities.test.ts apps/calendar/src/list/query.test.ts`
Expected: FAIL ("can.corporateQueries is not a function"; "Failed to resolve import ./query").

- [ ] **Step 4: Add the capabilities**

In `apps/calendar/src/capabilities.ts`, inside `can`, after `clearLaStatus`:

```ts
  /** Default.aspx.cs:28-32: the Corporate Queries panel. Checked on the server (C127). */
  corporateQueries: (u: Viewer) => u.isHq && u.level >= LEVEL.advanced,
  /** Default.aspx.cs:28-32: the Admin Settings' Look Ahead filter; legacy honoured its parameter from anyone (C127). */
  lookAheadFilter: (u: Viewer) => u.isHq && u.level >= LEVEL.advanced,
  /** ActivityListProvider.ashx.cs:47-50: the list's needs-review markup. */
  seeListMarkup: (u: Viewer) => u.isHq && u.level >= LEVEL.administrator,
```

- [ ] **Step 5: Write `list/query.ts`**

`apps/calendar/src/list/query.ts`:

```ts
import { and, eq, inArray, notInArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import {
  ACTIVITY_STATUSES, LIST_PAGE_SIZE, type CalendarRules, type CorporateQuery, type HqStatus, type ListDisplay, type ListFilter, type ListQuery, type ListSort,
} from "@gcpe/calendar-contract";
import type { CalendarActor } from "../actor";
import { ActivityForbiddenError } from "../activities/errors";
import { inReadSnapshot } from "../activities/store";
import { can } from "../capabilities";
import {
  activities, activityCategories, activityCommMaterials, activityInitiatives, activityKeywords, activitySharedWith,
  categories, cities, commContacts, commMaterials, favourites, governmentRepresentatives, keywords, orgs, users,
} from "../db/schema";
import type { ApiDeps } from "../http/routes";
import { addDays, bcMidnight, dbNow, wallClock } from "../time";
import { visibleSql } from "../visibility";

/** What every list reader needs besides the query. */
export interface ListScope {
  actor: CalendarActor;
  rules: CalendarRules;
  /** Today's BC date (YYYY-MM-DD) by the database's clock. */
  today: string;
  /** Keys of the organizations carrying the tenant's consultations abbreviation. */
  consultationsKeys: string[];
}

export async function scopeOf(db: DbOrTx, deps: ApiDeps, actor: CalendarActor): Promise<ListScope> {
  const today = wallClock(await dbNow(db, deps.now), deps.rules.timeZone).date;
  const consult = await db.select({ key: orgs.key }).from(orgs).where(eq(orgs.abbreviation, deps.rules.consultationsMinistryAbbreviation));
  return { actor, rules: deps.rules, today, consultationsKeys: consult.map((o) => o.key) };
}

/** Legacy clamps earlier dates (ActivityDAO.cs:172-173). */
const EARLIEST = "2011-01-01";
/** Legacy searched by id only above this; a smaller number is a word, such as a year (ActivityDAO.cs:68-76). */
const ID_SEARCH_FLOOR = 10_000;
const INT4_MAX = 2_147_483_647;

/** The activity a quick search names: a bare number above 10,000, or the list's "ABBR-123" at any size. */
export function idSearchOf(term: string): number | null {
  const m = /^(?:([A-Za-z][A-Za-z0-9]*)-)?(\d{1,10})$/.exec(term.trim());
  if (!m) return null;
  const n = Number(m[2]);
  if (n < 1 || n > INT4_MAX) return null;
  return m[1] !== undefined || n > ID_SEARCH_FLOOR ? n : null;
}

/** A LIKE pattern that matches `term` literally: backslash is Postgres's default LIKE escape. */
export const containsPattern = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const contains = (value: SQLWrapper, pattern: string) => sql`coalesce(${value}, '') ILIKE ${pattern}`;
const later = (a: string, b: string) => (a > b ? a : b);

/** The eleven fields legacy searched (ActivityDAO.cs:101-117). */
function textSearch(scope: ListScope, term: string): SQL {
  const p = containsPattern(term);
  const fields: SQL[] = [
    contains(activities.title, p),
    contains(activities.details, p),
    sql`EXISTS (SELECT 1 FROM ${cities} WHERE ${cities.id} = ${activities.cityId} AND ${cities.name} ILIKE ${p})`,
    contains(activities.otherCity, p),
    contains(sql`array_to_string(${activities.translations}, ', ')`, p),
    contains(activities.significance, p),
    contains(activities.comments, p),
    contains(activities.leadOrganization, p),
    contains(activities.strategy, p),
    contains(activities.schedule, p),
    contains(activities.venue, p),
  ];
  // The Executive Summary is a Look Ahead field: only those who see that fieldset find by it (C172).
  if (can.seeLookAheadFieldset(scope.actor, scope.rules)) fields.push(contains(activities.hqComments, p));
  return sql`(${sql.join(fields, sql` OR `)})`;
}

/** A deleted activity waiting for HQ to review its deletion. Only HQ Administrators can see one at all. */
const awaitingReview = sql`(${activities.deletedAt} IS NOT NULL AND 'active' = ANY(${activities.needsReview}))`;

/** ActivityDAO.cs:176-193: deletions awaiting review show with no status chosen and under Changed. */
function statusWhere(status: ListFilter["status"]): SQL {
  if (status === null) return sql`(${activities.deletedAt} IS NULL OR ${awaitingReview})`;
  if (status === "changed") return sql`((${activities.deletedAt} IS NULL AND ${activities.status} = 'changed') OR ${awaitingReview})`;
  return sql`(${activities.deletedAt} IS NULL AND ${activities.status} = ${status})`;
}

const sharedWith = (key: string) =>
  sql`EXISTS (SELECT 1 FROM ${activitySharedWith} WHERE ${activitySharedWith.activityId} = ${activities.id} AND ${activitySharedWith.ministryKey} = ${key})`;

/** The default list hides Awareness dates and the consultations ministry unless the filter names them (ActivityListProvider.ashx.cs:90-91). */
function defaultHides(scope: ListScope, f: ListFilter): SQL[] {
  const out: SQL[] = [];
  const awareness = [...scope.rules.awarenessCategoryIds];
  if (f.categoryId === null && awareness.length) {
    out.push(sql`NOT EXISTS (SELECT 1 FROM ${activityCategories} WHERE ${activityCategories.activityId} = ${activities.id} AND ${inArray(activityCategories.categoryId, awareness)})`);
  }
  const consult = scope.consultationsKeys;
  const onlyConsultations = scope.actor.ministryKeys.length === 1 && consult.includes(scope.actor.ministryKeys[0]!);
  if (f.ministryKey === null && consult.length && !onlyConsultations) {
    out.push(sql`(${activities.contactMinistryKey} IS NULL OR ${notInArray(activities.contactMinistryKey, consult)})`);
  }
  return out;
}

/** The filter panel and the display (spec addendum §8.1; ActivityDAO.cs:150-258). */
export function filterWhere(scope: ListScope, f: ListFilter, display: ListDisplay): SQL {
  const { actor, rules } = scope;
  const tz = rules.timeZone;
  const parts: SQL[] = [statusWhere(f.status)];
  if (f.quickSearch) parts.push(textSearch(scope, f.quickSearch));
  const from = later(f.from ?? scope.today, EARLIEST);
  if (f.thisDayOnly) {
    parts.push(sql`${activities.startAt} >= ${bcMidnight(from, tz)}`, sql`${activities.endAt} < ${bcMidnight(addDays(from, 1), tz)}`);
  } else {
    // Overlapping the range: ending on or after From, starting before the day after To (ActivityDAO.cs:243).
    parts.push(sql`coalesce(${activities.endAt}, ${activities.startAt}) >= ${bcMidnight(from, tz)}`);
    if (f.to) parts.push(sql`coalesce(${activities.startAt}, ${activities.endAt}) < ${bcMidnight(addDays(f.to, 1), tz)}`);
  }
  if (f.keywordIds.length) {
    parts.push(sql`EXISTS (SELECT 1 FROM ${activityKeywords} WHERE ${activityKeywords.activityId} = ${activities.id} AND ${inArray(activityKeywords.keywordId, f.keywordIds)})`);
  }
  if (f.isIssue !== null) parts.push(eq(activities.isIssue, f.isIssue));
  if (f.dateConfirmed !== null) {
    // Legacy always counts a timed single-day activity as matching (ActivityDAO.cs:198).
    parts.push(sql`(${activities.isConfirmed} = ${f.dateConfirmed} OR (NOT ${activities.isAllDay} AND (${activities.startAt} AT TIME ZONE ${tz})::date = (${activities.endAt} AT TIME ZONE ${tz})::date))`);
  }
  if (f.categoryId !== null) {
    parts.push(sql`EXISTS (SELECT 1 FROM ${activityCategories} WHERE ${activityCategories.activityId} = ${activities.id} AND ${activityCategories.categoryId} = ${f.categoryId})`);
  }
  if (f.initiativeId !== null) {
    parts.push(sql`EXISTS (SELECT 1 FROM ${activityInitiatives} WHERE ${activityInitiatives.activityId} = ${activities.id} AND ${activityInitiatives.initiativeId} = ${f.initiativeId})`);
  }
  if (f.representativeId !== null) parts.push(eq(activities.governmentRepresentativeId, f.representativeId));
  if (f.premierRequestedId !== null) parts.push(eq(activities.premierRequestedId, f.premierRequestedId));
  if (f.distributionId !== null) parts.push(eq(activities.nrDistributionId, f.distributionId));
  if (display === "my_ministries") {
    // Their own ministries' activities, not those only shared with them (ActivityDAO.cs:216-236).
    const keys = f.ministryKey !== null ? [f.ministryKey] : actor.ministryKeys;
    parts.push(keys.length ? inArray(activities.contactMinistryKey, keys) : sql`false`);
  } else if (f.ministryKey !== null) {
    parts.push(sql`(${activities.contactMinistryKey} = ${f.ministryKey} OR ${sharedWith(f.ministryKey)})`);
  }
  // A person, whichever of their comm contact rows the activity holds, inactive ones included.
  const person = display === "my_activities" ? (f.commContactUserId ?? actor.userId) : f.commContactUserId;
  if (person !== null) {
    parts.push(sql`EXISTS (SELECT 1 FROM ${commContacts} WHERE ${commContacts.id} = ${activities.commContactId} AND ${commContacts.userId} = ${person})`);
  }
  if (display === "my_watchlist") {
    parts.push(sql`EXISTS (SELECT 1 FROM ${favourites} WHERE ${favourites.activityId} = ${activities.id} AND ${favourites.userId} = ${actor.userId})`);
  } else {
    parts.push(...defaultHides(scope, f));
  }
  return and(...parts)!;
}

/** Corporate Queries (ActivityDAO.cs:306-368): upcoming activities by status and LA status. */
export function corporateWhere(scope: ListScope, c: CorporateQuery): SQL {
  const tz = scope.rules.timeZone;
  const parts: SQL[] = [sql`${activities.endAt} > ${bcMidnight(scope.today, tz)}`];
  if (c.days !== null) parts.push(sql`${activities.startAt} <= ${bcMidnight(addDays(scope.today, c.days + 1), tz)}`);
  const s = new Set(c.statuses);
  const live = ACTIVITY_STATUSES.filter((x) => s.has(x));
  const la: HqStatus[] = [];
  if (s.has("la_new")) la.push("new");
  if (s.has("la_changed")) la.push("changed");
  const any: SQL[] = [];
  if (live.length) any.push(sql`(${activities.deletedAt} IS NULL AND ${inArray(activities.status, live)})`);
  if (la.length) any.push(inArray(activities.hqStatus, la));
  // "Changed" brings deletions awaiting review; "Deleted" brings every deletion.
  if (s.has("changed")) any.push(awaitingReview);
  if (s.has("deleted")) any.push(sql`${activities.deletedAt} IS NOT NULL`);
  parts.push(sql`(${sql.join(any, sql` OR `)})`);
  return and(...parts)!;
}

function lookAheadWhere(f: ListQuery["lookAhead"]): SQL | undefined {
  if (f === "look_ahead_only") return sql`NOT ${activities.isConfidential}`;
  if (f === "not_for_look_ahead_only") return sql`${activities.isConfidential}`;
  return undefined;
}

/** The whole predicate: always inside visibleSql, over the unaliased activities table. */
export function listWhere(scope: ListScope, q: ListQuery): SQL {
  if (q.corporate && !can.corporateQueries(scope.actor)) throw new ActivityForbiddenError("Corporate queries are for HQ Advanced users and above");
  if (q.lookAhead !== "all" && !can.lookAheadFilter(scope.actor)) throw new ActivityForbiddenError("The Look Ahead filter is for HQ Advanced users and above");
  const parts: SQL[] = [visibleSql(scope.actor)];
  const id = q.corporate ? null : idSearchOf(q.filter.quickSearch);
  // An id search ignores the other filters and the dates, as legacy (ActivityDAO.cs:68-76).
  if (id !== null) parts.push(eq(activities.id, id));
  else parts.push(q.corporate ? corporateWhere(scope, q.corporate) : filterWhere(scope, q.filter, q.display));
  const la = lookAheadWhere(q.lookAhead);
  if (la) parts.push(la);
  return and(...parts)!;
}

const ministryAbbreviation = sql`(SELECT ${orgs.abbreviation} FROM ${orgs} WHERE ${orgs.key} = ${activities.contactMinistryKey})`;
const categoryNames = sql`(SELECT string_agg(${categories.name}, ', ' ORDER BY ${categories.name}) FROM ${activityCategories} JOIN ${categories} ON ${categories.id} = ${activityCategories.categoryId} WHERE ${activityCategories.activityId} = ${activities.id})`;
const keywordNames = sql`(SELECT string_agg(${keywords.name}, ', ' ORDER BY ${keywords.name}) FROM ${activityKeywords} JOIN ${keywords} ON ${keywords.id} = ${activityKeywords.keywordId} WHERE ${activityKeywords.activityId} = ${activities.id})`;
const commMaterialNames = sql`(SELECT string_agg(${commMaterials.name}, ', ' ORDER BY ${commMaterials.name}) FROM ${activityCommMaterials} JOIN ${commMaterials} ON ${commMaterials.id} = ${activityCommMaterials.commMaterialId} WHERE ${activityCommMaterials.activityId} = ${activities.id})`;
const contactName = sql`(SELECT ${users.displayName} FROM ${commContacts} JOIN ${users} ON ${users.id} = ${commContacts.userId} WHERE ${commContacts.id} = ${activities.commContactId})`;
const representativeName = sql`(SELECT ${governmentRepresentatives.name} FROM ${governmentRepresentatives} WHERE ${governmentRepresentatives.id} = ${activities.governmentRepresentativeId})`;

function sortKeys(sort: ListSort, rules: CalendarRules): SQL[] {
  switch (sort) {
    case "activity":
      return [ministryAbbreviation, sql`${activities.id}`];
    case "keywords":
      return [keywordNames];
    case "ministry":
      return [ministryAbbreviation];
    case "status":
      return [sql`${activities.status}`];
    case "dateTime":
      return [sql`${activities.startAt}`, sql`${activities.endAt}`];
    case "title":
      return [sql`lower(${activities.title})`];
    case "categories":
      return [categoryNames];
    case "commMaterials":
      return [commMaterialNames];
    case "leadOrg":
      return [sql`lower(nullif(${activities.leadOrganization}, ''))`];
    case "translations":
      return [sql`nullif(array_to_string(${activities.translations}, ', '), '')`];
    case "city":
      return [sql`lower(CASE WHEN ${activities.cityId} = ${rules.otherCityId} THEN nullif(${activities.otherCity}, '') ELSE (SELECT ${cities.name} FROM ${cities} WHERE ${cities.id} = ${activities.cityId}) END)`];
    case "commContact":
      return [sql`lower(${contactName})`];
    case "governmentRep":
      return [sql`lower(${representativeName})`];
  }
}

/** The chosen column, then start and id so pages never overlap; empty values last both ways. */
export function listOrder(sort: ListSort, dir: "asc" | "desc", rules: CalendarRules): SQL[] {
  const d = dir === "desc" ? sql`DESC NULLS LAST` : sql`ASC NULLS LAST`;
  return [...sortKeys(sort, rules).map((k) => sql`${k} ${d}`), sql`${activities.startAt} ASC NULLS LAST`, sql`${activities.id} ASC`];
}

/** One page of ids and the total, 30 at a time as legacy's grid. */
export async function listIds(tx: DbOrTx, scope: ListScope, q: ListQuery, offset: number): Promise<{ ids: number[]; total: number }> {
  const where = listWhere(scope, q);
  const rows = await tx
    .select({ id: activities.id, total: sql<number>`count(*) OVER ()`.mapWith(Number) })
    .from(activities)
    .where(where)
    .orderBy(...listOrder(q.sort, q.dir, scope.rules))
    .limit(LIST_PAGE_SIZE)
    .offset(offset);
  if (rows.length) return { ids: rows.map((r) => r.id), total: rows[0]!.total };
  if (offset === 0) return { ids: [], total: 0 };
  // Past the end: no window row to read the total from.
  const [c] = await tx.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(activities).where(where);
  return { ids: [], total: c!.n };
}

export function listPageIds(deps: ApiDeps, actor: CalendarActor, q: ListQuery, offset: number): Promise<{ ids: number[]; total: number }> {
  return inReadSnapshot(deps.db, async (tx) => listIds(tx, await scopeOf(tx, deps, actor), q, offset));
}
```

- [ ] **Step 6: Run the tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/capabilities.test.ts apps/calendar/src/list/query.test.ts apps/calendar/src/visibility.test.ts`
Expected: PASS. If a sort expectation fails, print the generated SQL with `tx.select(...).toSQL()` before changing the expectation: the expectations follow legacy's documented order, so the SQL is the suspect.

- [ ] **Step 7: Commit**

```bash
git add apps/calendar/src/capabilities.ts apps/calendar/src/capabilities.test.ts apps/calendar/src/list
git commit -m "feat(calendar): the list query inside visible(): legacy's filters, displays, id and text search, corporate queries, the Look Ahead filter, sorting and paging"
```

---

### Task 4: List rows, the list and options routes, and the config flags

Covers: spec §8.1 (the Activity Id cell's watched, reviewed, shared and release icons, `MIN-Id`, "updated X ago by", "created"; the other columns), §6 (markup at HQ Administrator; bearer tokens refused), C127. Decisions D2, D13 (watcher names), D19. Review Focus 2.

**Files:**
- Create: `apps/calendar/src/list/rows.ts`, `apps/calendar/src/list/page.ts`, `apps/calendar/src/list/options.ts`.
- Create: `apps/calendar/src/http/list-routes.ts`, `apps/calendar/src/http/list-errors.ts`, `apps/calendar/src/http/list-routes.test.ts`.
- Modify: `apps/calendar/src/http/routes.ts`, `apps/calendar/src/http/config-routes.ts`, `apps/calendar/src/http/config-routes.test.ts`.

**Interfaces:**
- Consumes: Task 3's `ListScope`, `scopeOf`, `listIds`; Task 2's `ListRow`, `ListPage`, `ListOptions`, `listQuerySchema`, `LIST_QUERY_MAX_CHARS`; `LOOKUPS`, `listLookupRows`; `inReadSnapshot`; `sendActivityError(e, res, req)`.
- Produces:
  - `rowsOf(tx: DbOrTx, scope: ListScope, ids: readonly number[]): Promise<ListRow[]>` (in the given order; batches of 1,000; still `visibleSql`).
  - `listPage(deps: ApiDeps, actor: CalendarActor, q: ListQuery, offset: number): Promise<ListPage>`.
  - `listOptions(db: DbOrTx, actor: CalendarActor): Promise<ListOptions>`.
  - `listQueryParam`: a zod schema turning the `q` string into a `ListQuery` (400 on bad JSON).
  - `runList(handler)` and `sendListError(e, res, req): boolean` (later tasks add their error classes to it).
  - Routes: `GET /api/list?q=&offset=`, `GET /api/list/options`.
  - `GET /api/config` gains `list: { markup, corporateQueries, lookAheadFilter, reviewSelected, clearLaStatus }`.

- [ ] **Step 1: Write the failing route tests**

`apps/calendar/src/http/list-routes.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { mintLocalToken } from "@gcpe/auth";
import { createCalendarTestDb, createTestApp, EVENT_SECRETS, SESSION_SECRET, TEST_RULES } from "../../test/helpers";
import { call, insertRaw, seedWorld, validInput, type World } from "../../test/world";
import { createApp } from "../app";
import { activityCategories, favourites, userProfiles } from "../db/schema";

const listUrl = (q: object | string, offset?: string) =>
  `/api/list?q=${encodeURIComponent(typeof q === "string" ? q : JSON.stringify(q))}${offset === undefined ? "" : `&offset=${offset}`}`;

describe("GET /api/list and /api/list/options (spec addendum §8.1)", () => {
  let tdb: TestDatabase;
  let w: World;
  let app: ReturnType<typeof createTestApp>;

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    w = await seedWorld(app, tdb.db);
  });
  afterAll(() => tdb.drop());

  it("returns the page's rows with every column the list and the export show", async () => {
    await tdb.db.insert(userProfiles).values({ userId: w.as.editor.id, phone: "250-555-0101" });
    const created = await call(app, "post", "/api/activities", w.as.hqAdmin.cookie, validInput(w, {
      title: "Sample listed", startDate: "2044-02-03", endDate: "2044-02-03", keywordNames: ["Sample kept keyword"], commMaterialIds: [w.commMaterial.newsRelease],
      premierRequestedId: w.ids.premierYes, governmentRepresentativeId: w.ids.representative, eventPlannerId: w.ids.planner, leadOrganization: "Sample Org",
      venue: "Sample Hall", translations: ["Sample language A"], sharedWithKeys: ["finance"],
    }));
    expect(created.status).toBe(201);
    const id = created.body.id as number;
    await tdb.db.insert(favourites).values([{ userId: w.as.editor.id, activityId: id }, { userId: w.as.admin.id, activityId: id }]);
    const res = await call(app, "get", listUrl({ filter: { from: "2044-02-01", to: "2044-02-28" } }), w.as.editor.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1, offset: 0 });
    expect(res.body.rows[0]).toMatchObject({
      id, version: 1, ministryKey: "health", ministryAbbreviation: "HLTH", status: "new", hqStatus: null, isDeleted: false,
      isWatched: true, watcherNames: ["Robin Staff", "Sample Admin"], isShared: true, hasRelease: false,
      lastUpdatedByName: "Sample HQ Admin", keywords: ["Sample kept keyword"], isAllDay: false, isConfirmed: true,
      title: "Sample listed", details: "Sample summary", significance: "Sample significance", schedule: "Sample scheduling",
      categories: ["Sample plain category"], isIssue: false, isConfidential: false, commMaterials: ["Sample news release"],
      premierRequested: "Sample yes", leadOrganization: "Sample Org", translations: ["Sample language A"], city: "Sample City", venue: "Sample Hall",
      commContact: { name: "Robin Staff", phone: "250-555-0101" }, governmentRepresentative: "Sample Representative", eventPlanner: "Sample Planner",
      needsReview: [],
    });
  });

  it("shows Other City for the city \"Other…\", and the review markup only to HQ Administrators", async () => {
    const id = await insertRaw(tdb.db, { startAt: new Date("2044-03-03T17:00:00Z"), endAt: new Date("2044-03-03T18:00:00Z"), cityId: w.city.other, otherCity: "Sample Cove", needsReview: ["title"], status: "changed" });
    await tdb.db.insert(activityCategories).values({ activityId: id, categoryId: w.cat.plain });
    const q = { filter: { from: "2044-03-01", to: "2044-03-31" } };
    const admin = await call(app, "get", listUrl(q), w.as.hqAdmin.cookie);
    expect(admin.body.rows[0]).toMatchObject({ id, city: "Sample Cove", needsReview: ["title"] });
    const advanced = await call(app, "get", listUrl(q), w.as.hqAdvanced.cookie);
    expect(advanced.body.rows[0]).toMatchObject({ id, needsReview: [] });
  });

  it("a malformed list request is 400, never 500", async () => {
    const bad = [
      "/api/list",
      listUrl("{not json"),
      listUrl("x".repeat(8001)),
      listUrl({ filter: { extra: 1 } }),
      listUrl({ filter: { categoryId: 2_147_483_648 } }),
      listUrl({ filter: { quickSearch: "a\u0000b" } }),
      listUrl({ filter: { from: "2300-01-01" } }),
      listUrl({ filter: { from: "2026-11-05", to: "2026-11-01" } }),
      listUrl({ sort: "premier" }),
      listUrl({}, "-1"),
      listUrl({}, "1e3"),
      listUrl({}, "abc"),
      listUrl({}, "99999999"),
      `${listUrl({})}&q=${encodeURIComponent("{}")}`,
      `${listUrl({})}&extra=1`,
      `/api/list?q[filter]=1`,
    ];
    for (const url of bad) expect((await call(app, "get", url, w.as.editor.cookie)).status, url).toBe(400);
  });

  it("refuses a corporate query or the Look Ahead filter below HQ Advanced with 403", async () => {
    expect((await call(app, "get", listUrl({ corporate: { days: 8, statuses: ["new"] } }), w.as.hqEditor.cookie)).status).toBe(403);
    expect((await call(app, "get", listUrl({ lookAhead: "look_ahead_only" }), w.as.admin.cookie)).status).toBe(403);
    expect((await call(app, "get", listUrl({ corporate: { days: 8, statuses: ["new"] } }), w.as.hqAdvanced.cookie)).status).toBe(200);
  });

  it("gives a bearer token nothing, even one for a projected user", async () => {
    const local = "calendar-local-bearer-secret-0123456789ab";
    const withLocal = createApp({ db: tdb.db, auth: { session: { secret: SESSION_SECRET }, local: { secret: local } }, eventSecrets: EVENT_SECRETS, rules: TEST_RULES });
    const token = await mintLocalToken({ secret: local, subject: w.as.hqAdmin.id, roles: ["Calendar.SysAdmin"] });
    for (const path of [listUrl({}), "/api/list/options"]) {
      expect((await request(withLocal).get(path).set("authorization", `Bearer ${token}`)).status).toBe(403);
    }
  });

  it("options: active lookups; a ministry user's own ministries and comm-contact people, every active one for HQ", async () => {
    const mine = (await call(app, "get", "/api/list/options", w.as.editor.cookie)).body;
    expect(mine.ministries).toEqual([{ key: "health", abbreviation: "HLTH", name: "Sample Health" }]);
    expect(mine.commContacts).toEqual([{ userId: w.as.editor.id, name: "Robin Staff" }, { userId: w.as.admin.id, name: "Sample Admin" }]);
    expect(mine.categories.map((c: { id: number }) => c.id)).not.toContain(w.cat.retired);
    expect(mine.categories.map((c: { id: number }) => c.id)).toContain(w.cat.awareness);
    expect(mine.keywords).toEqual(expect.arrayContaining([{ id: w.ids.keptKeyword, name: "Sample kept keyword" }]));
    for (const k of ["representatives", "initiatives", "premierRequested", "distributions"]) expect(mine[k].length).toBeGreaterThan(0);
    const hq = (await call(app, "get", "/api/list/options", w.as.hqEditor.cookie)).body;
    expect(hq.ministries.map((m: { key: string }) => m.key)).toEqual(expect.arrayContaining(["health", "finance", "gcpe-hq"]));
    expect(hq.ministries.map((m: { key: string }) => m.key)).not.toContain("retired");
    expect(hq.commContacts.map((c: { userId: string }) => c.userId)).toEqual(expect.arrayContaining([w.as.financeEditor.id]));
    // The inactive comm contact's person isn't offered.
    expect(hq.commContacts.map((c: { userId: string }) => c.userId)).not.toContain(w.as.advanced.id);
  });
});
```

Add to `apps/calendar/src/http/config-routes.test.ts`'s test (after the HQ assertion):

```ts
    expect(res.body.list).toEqual({ markup: false, corporateQueries: false, lookAheadFilter: false, reviewSelected: false, clearLaStatus: false });
    expect(hq.body.list).toEqual({ markup: false, corporateQueries: false, lookAheadFilter: false, reviewSelected: false, clearLaStatus: true });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/http/list-routes.test.ts apps/calendar/src/http/config-routes.test.ts`
Expected: FAIL (404 for `/api/list`; `list` undefined in the config body).

- [ ] **Step 3: Write `list/rows.ts`**

```ts
import { and, asc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DbOrTx } from "@gcpe/db-kit";
import type { ListRow } from "@gcpe/calendar-contract";
import { can } from "../capabilities";
import {
  activities, activityCategories, activityCommMaterials, activityKeywords, activityNrOrigins, activitySharedWith, categories, cities, commContacts, commMaterials,
  eventPlanners, favourites, governmentRepresentatives, keywords, nrDistributions, nrOrigins, orgs, premierRequested, releaseLinks, userProfiles, users,
} from "../db/schema";
import { visibleSql } from "../visibility";
import type { ListScope } from "./query";

const contactUser = alias(users, "contact_user");
const updater = alias(users, "updater");
/** Ids per round trip: far below Postgres's parameter limit. */
const CHUNK = 1000;

async function grouped(q: Promise<{ id: number; v: string }[]>): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  for (const r of await q) out.set(r.id, [...(out.get(r.id) ?? []), r.v]);
  return out;
}
const iso = (d: Date | null) => d?.toISOString() ?? null;

/** The list's rows for these ids, in this order. Still filtered by visibleSql: a row never carries an activity the caller can't see. */
export async function rowsOf(tx: DbOrTx, scope: ListScope, ids: readonly number[]): Promise<ListRow[]> {
  const out: ListRow[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(...(await chunk(tx, scope, ids.slice(i, i + CHUNK))));
  return out;
}

async function chunk(tx: DbOrTx, scope: ListScope, ids: number[]): Promise<ListRow[]> {
  if (ids.length === 0) return [];
  const { actor, rules } = scope;
  const base = await tx
    .select({
      a: activities,
      ministryAbbreviation: orgs.abbreviation,
      cityName: cities.name,
      representative: governmentRepresentatives.name,
      premier: premierRequested.name,
      distribution: nrDistributions.name,
      eventPlanner: eventPlanners.name,
      contactName: contactUser.displayName,
      contactPhone: userProfiles.phone,
      updaterName: updater.displayName,
    })
    .from(activities)
    .leftJoin(orgs, eq(orgs.key, activities.contactMinistryKey))
    .leftJoin(cities, eq(cities.id, activities.cityId))
    .leftJoin(governmentRepresentatives, eq(governmentRepresentatives.id, activities.governmentRepresentativeId))
    .leftJoin(premierRequested, eq(premierRequested.id, activities.premierRequestedId))
    .leftJoin(nrDistributions, eq(nrDistributions.id, activities.nrDistributionId))
    .leftJoin(eventPlanners, eq(eventPlanners.id, activities.eventPlannerId))
    .leftJoin(commContacts, eq(commContacts.id, activities.commContactId))
    .leftJoin(contactUser, eq(contactUser.id, commContacts.userId))
    .leftJoin(userProfiles, eq(userProfiles.userId, commContacts.userId))
    .leftJoin(updater, eq(updater.id, activities.lastUpdatedBy))
    .where(and(inArray(activities.id, ids), visibleSql(actor)));
  const cats = await grouped(tx.select({ id: activityCategories.activityId, v: categories.name }).from(activityCategories).innerJoin(categories, eq(categories.id, activityCategories.categoryId)).where(inArray(activityCategories.activityId, ids)).orderBy(asc(categories.name)));
  const materials = await grouped(tx.select({ id: activityCommMaterials.activityId, v: commMaterials.name }).from(activityCommMaterials).innerJoin(commMaterials, eq(commMaterials.id, activityCommMaterials.commMaterialId)).where(inArray(activityCommMaterials.activityId, ids)).orderBy(asc(commMaterials.name)));
  const kws = await grouped(tx.select({ id: activityKeywords.activityId, v: keywords.name }).from(activityKeywords).innerJoin(keywords, eq(keywords.id, activityKeywords.keywordId)).where(inArray(activityKeywords.activityId, ids)).orderBy(asc(keywords.name)));
  const origins = await grouped(tx.select({ id: activityNrOrigins.activityId, v: nrOrigins.name }).from(activityNrOrigins).innerJoin(nrOrigins, eq(nrOrigins.id, activityNrOrigins.nrOriginId)).where(inArray(activityNrOrigins.activityId, ids)).orderBy(asc(nrOrigins.name)));
  const watchers = await grouped(tx.select({ id: favourites.activityId, v: users.displayName }).from(favourites).innerJoin(users, eq(users.id, favourites.userId)).where(inArray(favourites.activityId, ids)).orderBy(asc(users.displayName)));
  const shared = new Set((await tx.selectDistinct({ id: activitySharedWith.activityId }).from(activitySharedWith).where(inArray(activitySharedWith.activityId, ids))).map((r) => r.id));
  const released = new Set((await tx.selectDistinct({ id: releaseLinks.activityId }).from(releaseLinks).where(inArray(releaseLinks.activityId, ids))).map((r) => r.id));
  const mine = new Set((await tx.select({ id: favourites.activityId }).from(favourites).where(and(inArray(favourites.activityId, ids), eq(favourites.userId, actor.userId)))).map((r) => r.id));
  const markup = can.seeListMarkup(actor);
  const byId = new Map(base.map((r) => [r.a.id, r]));
  return ids.flatMap((id): ListRow[] => {
    const r = byId.get(id);
    if (!r) return [];
    const a = r.a;
    return [{
      id: a.id, version: a.version, ministryKey: a.contactMinistryKey, ministryAbbreviation: r.ministryAbbreviation,
      status: a.status, hqStatus: a.hqStatus, isDeleted: a.deletedAt !== null,
      isWatched: mine.has(id), watcherNames: watchers.get(id) ?? [], isShared: shared.has(id), hasRelease: released.has(id),
      createdAt: a.createdAt.toISOString(), lastUpdatedAt: a.lastUpdatedAt.toISOString(), lastUpdatedByName: r.updaterName,
      keywords: kws.get(id) ?? [], startAt: iso(a.startAt), endAt: iso(a.endAt), isAllDay: a.isAllDay, isConfirmed: a.isConfirmed, potentialDates: a.potentialDates ?? "",
      title: a.title, details: a.details, significance: a.significance, strategy: a.strategy ?? "", schedule: a.schedule,
      categories: cats.get(id) ?? [], isIssue: a.isIssue, isConfidential: a.isConfidential,
      commMaterials: materials.get(id) ?? [], nrOrigins: origins.get(id) ?? [], nrDistribution: r.distribution,
      premierRequested: r.premier, leadOrganization: a.leadOrganization ?? "", translations: a.translations,
      // Legacy's CityOrOther: the Other City text when the city is "Other…".
      city: a.cityId === rules.otherCityId ? a.otherCity : r.cityName, venue: a.venue ?? "",
      commContact: a.commContactId === null ? null : { name: r.contactName ?? "Unknown", phone: r.contactPhone },
      governmentRepresentative: r.representative, eventPlanner: r.eventPlanner,
      needsReview: markup ? a.needsReview : [],
    }];
  });
}
```

`list/page.ts`:

```ts
import type { ListPage, ListQuery } from "@gcpe/calendar-contract";
import type { CalendarActor } from "../actor";
import { inReadSnapshot } from "../activities/store";
import type { ApiDeps } from "../http/routes";
import { listIds, scopeOf } from "./query";
import { rowsOf } from "./rows";

/** One page of the list, ids and rows from one snapshot. */
export function listPage(deps: ApiDeps, actor: CalendarActor, q: ListQuery, offset: number): Promise<ListPage> {
  return inReadSnapshot(deps.db, async (tx) => {
    const scope = await scopeOf(tx, deps, actor);
    const { ids, total } = await listIds(tx, scope, q, offset);
    return { rows: await rowsOf(tx, scope, ids), total, offset };
  });
}
```

`list/options.ts`:

```ts
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import type { ListOption, ListOptions } from "@gcpe/calendar-contract";
import type { CalendarActor } from "../actor";
import { commContacts, orgs, users } from "../db/schema";
import { listLookupRows, LOOKUPS, type LookupDef } from "../lookups";

const activeOf = async (db: DbOrTx, def: LookupDef): Promise<ListOption[]> =>
  (await listLookupRows(db, def)).filter((r) => r.isActive).map((r) => ({ id: r.id, name: r.name }));

/** The filter panel's choices (Default.aspx.cs:55-140): HQ chooses among every active ministry, others among their own. */
export async function listOptions(db: DbOrTx, actor: CalendarActor): Promise<ListOptions> {
  const keys = actor.ministryKeys;
  const scope = actor.isHq ? undefined : keys.length ? inArray(commContacts.ministryKey, keys) : sql`false`;
  return {
    categories: await activeOf(db, LOOKUPS.categories),
    keywords: await activeOf(db, LOOKUPS.keywords),
    representatives: await activeOf(db, LOOKUPS["government-representatives"]),
    initiatives: await activeOf(db, LOOKUPS.initiatives),
    premierRequested: await activeOf(db, LOOKUPS["premier-requested"]),
    distributions: await activeOf(db, LOOKUPS["nr-distributions"]),
    ministries: (
      await db
        .select({ key: orgs.key, abbreviation: orgs.abbreviation, name: orgs.displayName })
        .from(orgs)
        .where(actor.isHq ? eq(orgs.isActive, true) : keys.length ? inArray(orgs.key, keys) : sql`false`)
        .orderBy(asc(orgs.abbreviation), asc(orgs.key))
    ),
    commContacts: await db
      .selectDistinct({ userId: commContacts.userId, name: users.displayName })
      .from(commContacts)
      .innerJoin(users, eq(users.id, commContacts.userId))
      .where(and(eq(commContacts.isActive, true), eq(users.isActive, true), scope))
      .orderBy(asc(users.displayName), asc(commContacts.userId)),
  };
}
```

- [ ] **Step 4: Write the routes**

`apps/calendar/src/http/list-errors.ts`:

```ts
import type { NextFunction, Request, Response } from "express";
import { sendActivityError } from "./errors";

/** The list routes' errors; anything else falls through to the activity error mapping. */
export function sendListError(e: unknown, res: Response, req: Request): boolean {
  return sendActivityError(e, res, req);
}

export const runList = (h: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
  h(req, res).catch((e: unknown) => {
    if (!sendListError(e, res, req)) next(e);
  });
```

`apps/calendar/src/http/list-routes.ts`:

```ts
import { Router } from "express";
import { z } from "zod";
import { LIST_QUERY_MAX_CHARS, listQuerySchema } from "@gcpe/calendar-contract";
import { listOptions } from "../list/options";
import { listPage } from "../list/page";
import { runList } from "./list-errors";
import type { ApiDeps } from "./routes";

/** The list query, as JSON in `q` (spec addendum §8.1's filter model). Bad JSON is a 400 like any other bad value. */
export const listQueryParam = z
  .string()
  .max(LIST_QUERY_MAX_CHARS)
  .transform((s, ctx) => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "q must be JSON" });
      return z.NEVER;
    }
  })
  .pipe(listQuerySchema);
const offset = z.string().regex(/^\d{1,7}$/, "offset is a whole number").transform(Number);
const pageParams = z.object({ q: listQueryParam, offset: offset.optional() }).strict();

/** The activity list (spec addendum §8.1). Every reader filters inside visibleSql. */
export function listRoutes(deps: ApiDeps): Router {
  const r = Router();
  r.get("/list", runList(async (req, res) => {
    const p = pageParams.parse(req.query);
    res.json(await listPage(deps, req.calendar!, p.q, p.offset ?? 0));
  }));
  r.get("/list/options", runList(async (req, res) => void res.json(await listOptions(deps.db, req.calendar!))));
  return r;
}
```

In `apps/calendar/src/http/routes.ts`, import `listRoutes` and add `r.use(listRoutes(deps));` after `r.use(configRoutes(deps));`.

In `apps/calendar/src/http/config-routes.ts`, add to the response object:

```ts
        list: {
          markup: can.seeListMarkup(actor),
          corporateQueries: can.corporateQueries(actor),
          lookAheadFilter: can.lookAheadFilter(actor),
          reviewSelected: can.reviewSelected(actor),
          clearLaStatus: can.clearLaStatus(actor),
        },
```

- [ ] **Step 5: Run the tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/http/list-routes.test.ts apps/calendar/src/http/config-routes.test.ts apps/calendar/src/list`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/calendar/src/list apps/calendar/src/http
git commit -m "feat(calendar): GET /api/list with legacy's columns and HQ markup, the filter options, and the list flags in /api/config"
```

---

### Task 5: The list query on 50,000 activities

Covers: spec §3 row 5d ("under 500 ms on a 50,000-activity fixture … measured in 5d"), §13 (growth of about 4,500 a year, 3% confidential, multi-value fields), §16. Decision D18.

**Files:**
- Create: `apps/calendar/test/volume.ts`, `apps/calendar/src/list/list-perf.test.ts`.
- Create: `docs/superpowers/plans/2026-10-08-phase-5d-list-performance.md`.

**Interfaces:**
- Consumes: Task 4's `listPage`; `seedWorld`, `loadCalendarActor`, `listQuerySchema`.
- Produces: `seedVolume(db: Db, n?: number): Promise<void>` (inserts `n` activities, default 50,000, with lookups, ministries, contacts, joins and favourites, then `ANALYZE`).

- [ ] **Step 1: Write the fixture**

`apps/calendar/test/volume.ts`:

```ts
import { sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";

/**
 * A list-sized Calendar: `n` activities from 2016 on, about 4,500 a year (spec addendum §13), in 30
 * ministries (health and finance among them), 3% Not for Look Ahead, 12.5% deleted (half awaiting
 * review), a sixth with an LA status, one or two categories, keywords on half, shared with a
 * fifth, and favourites. Ids start at 100,001; lookups at 1,001. Fictional values only.
 */
export async function seedVolume(db: Db, n = 50_000): Promise<void> {
  await db.execute(sql`INSERT INTO orgs (key, display_name, abbreviation, is_active) SELECT 'vol-' || g, 'Sample Volume Ministry ' || g, 'VOL' || g, true FROM generate_series(2, 29) g ON CONFLICT DO NOTHING`);
  await db.execute(sql`INSERT INTO categories (id, name) OVERRIDING SYSTEM VALUE SELECT 1000 + g, 'Sample volume category ' || g FROM generate_series(1, 50) g`);
  await db.execute(sql`INSERT INTO cities (id, name) OVERRIDING SYSTEM VALUE SELECT 1000 + g, 'Sample Volume City ' || g FROM generate_series(1, 330) g`);
  await db.execute(sql`INSERT INTO keywords (id, name) OVERRIDING SYSTEM VALUE SELECT 1000 + g, 'Sample volume tag ' || g FROM generate_series(1, 330) g`);
  await db.execute(sql`INSERT INTO government_representatives (id, name) OVERRIDING SYSTEM VALUE SELECT 1000 + g, 'Sample Volume Representative ' || g FROM generate_series(1, 300) g`);
  await db.execute(sql`INSERT INTO users (id, display_name, is_active, organization_keys) SELECT ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid, 'Sample Volume Person ' || g, true, '{}' FROM generate_series(1, 300) g`);
  await db.execute(sql`INSERT INTO comm_contacts (id, user_id, ministry_key) OVERRIDING SYSTEM VALUE SELECT 1000 + g, ('00000000-0000-4000-9000-' || lpad(g::text, 12, '0'))::uuid, CASE g % 30 WHEN 0 THEN 'health' WHEN 1 THEN 'finance' ELSE 'vol-' || (g % 30) END FROM generate_series(1, 300) g`);
  await db.execute(sql`
    INSERT INTO activities (id, start_at, end_at, title, details, significance, schedule, comments, hq_comments, venue, translations, contact_ministry_key, comm_contact_id,
      city_id, government_representative_id, is_confidential, is_issue, is_confirmed, status, hq_status, deleted_at, needs_review, created_at, last_updated_at)
    OVERRIDING SYSTEM VALUE
    SELECT 100000 + g,
      timestamptz '2016-01-01 08:00-08' + g * interval '126 minutes',
      timestamptz '2016-01-01 08:00-08' + g * interval '126 minutes' + interval '2 hours',
      'Sample volume activity ' || g || ' ' || md5(g::text), 'Sample details ' || md5((g * 7)::text), 'Sample significance ' || md5((g * 3)::text),
      'Sample schedule ' || g, 'Sample notes ' || md5((g * 5)::text), CASE WHEN g % 5 = 0 THEN 'Sample summary ' || md5(g::text) END, 'Sample Venue ' || (g % 400),
      CASE WHEN g % 7 = 0 THEN ARRAY['Sample language A'] ELSE '{}'::text[] END,
      CASE g % 30 WHEN 0 THEN 'health' WHEN 1 THEN 'finance' ELSE 'vol-' || (g % 30) END, 1001 + g % 300,
      1001 + g % 330, 1001 + g % 300, g % 33 = 0, g % 9 = 0, g % 3 <> 0, (ARRAY['new', 'changed', 'reviewed'])[1 + g % 3],
      CASE WHEN g % 6 = 0 THEN 'new' END, CASE WHEN g % 8 = 0 THEN now() END, CASE WHEN g % 16 = 0 THEN ARRAY['active'] ELSE '{}'::text[] END, now(), now()
    FROM generate_series(1, ${n}::int) g`);
  await db.execute(sql`INSERT INTO activity_categories (activity_id, category_id) SELECT 100000 + g, 1001 + g % 50 FROM generate_series(1, ${n}::int) g`);
  await db.execute(sql`INSERT INTO activity_categories (activity_id, category_id) SELECT 100000 + g, 2 FROM generate_series(40, ${n}::int, 40) g`);
  await db.execute(sql`INSERT INTO activity_keywords (activity_id, keyword_id) SELECT 100000 + g, 1001 + g % 330 FROM generate_series(1, ${n}::int, 2) g`);
  await db.execute(sql`INSERT INTO activity_shared_with (activity_id, ministry_key) SELECT 100000 + g, CASE (g * 11) % 30 WHEN 0 THEN 'health' WHEN 1 THEN 'finance' ELSE 'vol-' || ((g * 11) % 30) END FROM generate_series(1, ${n}::int, 5) g ON CONFLICT DO NOTHING`);
  await db.execute(sql`INSERT INTO favourites (user_id, activity_id) SELECT u.id, 100000 + g FROM generate_series(1, ${n}::int, 13) g CROSS JOIN (SELECT id FROM users WHERE display_name = 'Robin Staff') u`);
  await db.execute(sql`ANALYZE`);
}
```

- [ ] **Step 2: Write the measurement**

`apps/calendar/src/list/list-perf.test.ts`:

```ts
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { listQuerySchema, type ListQueryInput } from "@gcpe/calendar-contract";
import { createCalendarTestDb, createTestApp, FIXED_NOW, TEST_RULES } from "../../test/helpers";
import { seedVolume } from "../../test/volume";
import { seedWorld, type Who, type World } from "../../test/world";
import { loadCalendarActor } from "../actor";
import type { ApiDeps } from "../http/routes";
import { listPage } from "./page";

/** Spec addendum §3 row 5d: the list query under 500 ms on 50,000 activities. */
const BUDGET_MS = 500;
const RUNS = 10;
const SHAPES: { name: string; who: Who; q: ListQueryInput; offset?: number }[] = [
  { name: "a ministry editor's default list, first page", who: "editor", q: {} },
  { name: "a ministry editor's default list, tenth page", who: "editor", q: {}, offset: 270 },
  { name: "HQ, every year since 2011, by title descending, offset 1,500", who: "hqEditor", q: { filter: { from: "2011-01-01" }, sort: "title", dir: "desc" }, offset: 1500 },
  { name: "HQ Administrator, every year, by categories, offset 900", who: "hqAdmin", q: { filter: { from: "2011-01-01" }, sort: "categories" }, offset: 900 },
  { name: "HQ, a quick search that matches nothing, every year", who: "hqEditor", q: { filter: { from: "2011-01-01", quickSearch: "zzqx none" } } },
  { name: "HQ, three HQ Tags and a Lead Ministry, every year", who: "hqEditor", q: { filter: { from: "2011-01-01", keywordIds: [1001, 1002, 1003], ministryKey: "health" } } },
  { name: "HQ Advanced, a corporate query, show all", who: "hqAdvanced", q: { corporate: { days: null, statuses: ["new", "changed", "la_new"] } } },
  { name: "a ministry editor's watchlist, every year", who: "editor", q: { display: "my_watchlist", filter: { from: "2011-01-01" } } },
];

describe("the list on 50,000 activities", () => {
  let tdb: TestDatabase;
  let w: World;
  let deps: ApiDeps;
  const results: { name: string; p95: number; max: number; total: number }[] = [];

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    w = await seedWorld(createTestApp(tdb.db), tdb.db);
    await seedVolume(tdb.db, 50_000);
    deps = { db: tdb.db, rules: TEST_RULES, subscribers: [], now: () => FIXED_NOW };
  }, 180_000);
  afterAll(async () => {
    // The measured table, for the performance record.
    console.info(results.map((r) => `${r.p95.toFixed(0).padStart(5)} ms p95 ${r.max.toFixed(0).padStart(5)} ms max ${String(r.total).padStart(6)} rows  ${r.name}`).join("\n"));
    await tdb.drop();
  });

  for (const shape of SHAPES) {
    it(`${shape.name}: p95 of ${RUNS} runs under ${BUDGET_MS} ms`, async () => {
      const actor = (await loadCalendarActor(tdb.db, w.as[shape.who].id))!;
      const q = listQuerySchema.parse(shape.q);
      const first = await listPage(deps, actor, q, shape.offset ?? 0);
      const times: number[] = [];
      for (let n = 0; n < RUNS; n++) {
        const t0 = performance.now();
        await listPage(deps, actor, q, shape.offset ?? 0);
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      const p95 = times[Math.ceil(0.95 * RUNS) - 1]!;
      results.push({ name: shape.name, p95, max: times[RUNS - 1]!, total: first.total });
      expect(first.total).toBeGreaterThan(0);
      expect(p95).toBeLessThan(BUDGET_MS);
    }, 60_000);
  }
});
```

- [ ] **Step 3: Run it**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/list/list-perf.test.ts`
Expected: PASS, with the table printed after the tests. This test is new code over existing behaviour, so its RED run is the budget itself: change `BUDGET_MS` to `1` once, see every shape FAIL, restore `500`.

If a shape fails the real budget:
1. Print its SQL: `tx.select(...)….toSQL()` from `listIds`, then `EXPLAIN (ANALYZE, BUFFERS)` it in `psql` against the test database (keep it alive by skipping `tdb.drop()` for that run).
2. Add the index the plan calls for to `apps/calendar/src/db/schema.ts` (for example, `index("activities_deleted_start_idx").on(t.deletedAt, t.startAt)` or `index("activity_categories_category_idx").on(t.categoryId)`), generate the migration with `npx -y -p node@24 -- npm --workspace @gcpe/calendar run db:generate -- --name list_index`, and re-run.
3. Never raise the budget.

- [ ] **Step 4: Record the numbers**

`docs/superpowers/plans/2026-10-08-phase-5d-list-performance.md`: a short record with the date, the machine (`uname -m`, CPU model from `sysctl -n machdep.cpu.brand_string`), Postgres version (`psql -Atc 'select version()'`), the fixture's shape (Step 1's comment), and the printed table pasted verbatim. Add one line: "boxs.ca and production hardware weren't measured; 5d-2's hand check times the list there."

- [ ] **Step 5: Commit**

```bash
git add apps/calendar/test/volume.ts apps/calendar/src/list/list-perf.test.ts docs/superpowers/plans/2026-10-08-phase-5d-list-performance.md
git commit -m "test(calendar): the list query measured on 50,000 activities, every shape under 500 ms at p95"
```

---

### Task 6: Display and column preferences, and the watchlist

Covers: spec §8.1 ("The choice is saved per user", "Each user's column choice is saved", the watchlist and its tooltip), §6 (favourites: any role, limited by `visible()`), §7.4 (not frozen). Decisions D12, D13.

**Files:**
- Create: `apps/calendar/src/list/preferences.ts`, `apps/calendar/src/list/watch.ts`, `apps/calendar/src/http/list-preferences.test.ts`.
- Modify: `apps/calendar/src/http/list-routes.ts`.

**Interfaces:**
- Consumes: `userProfiles`, `favourites`, `visibleSql`, `ActivityNotFoundError`, `idOf` (`activity-routes.ts`), Task 2's `listPreferencesSchema`, `DEFAULT_HIDDEN_COLUMNS`, `HIDEABLE_COLUMNS`.
- Produces:
  - `readPreferences(db: DbOrTx, userId: string): Promise<ListPreferences>`, `writePreferences(db: DbOrTx, userId: string, p: ListPreferences): Promise<ListPreferences>`.
  - `watchActivity(db: Db, actor: CalendarActor, id: number): Promise<void>` (404 when not visible), `unwatchActivity(db: DbOrTx, actor: CalendarActor, id: number): Promise<void>`.
  - Routes: `GET /api/list/preferences`, `PUT /api/list/preferences` (`{ display, hiddenColumns }`), `PUT /api/activities/:id/watch`, `DELETE /api/activities/:id/watch` (both 204).

- [ ] **Step 1: Write the failing tests**

`apps/calendar/src/http/list-preferences.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCalendarTestDb, createTestApp } from "../../test/helpers";
import { call, insertRaw, seedWorld, type World } from "../../test/world";
import { favourites, userProfiles } from "../db/schema";

describe("list preferences and the watchlist (spec addendum §8.1)", () => {
  let tdb: TestDatabase;
  let w: World;
  let app: ReturnType<typeof createTestApp>;
  let frozen: ReturnType<typeof createTestApp>;

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    // 16:30 BC: inside the freeze, which doesn't apply to either.
    frozen = createTestApp(tdb.db, { now: () => new Date("2026-11-02T23:30:00Z") });
    w = await seedWorld(app, tdb.db);
  });
  afterAll(() => tdb.drop());

  it("defaults to legacy's: Show All, with HQ Tags, Ministry, Status and Translations hidden", async () => {
    const res = await call(app, "get", "/api/list/preferences", w.as.editor.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ display: "all", hiddenColumns: ["keywords", "ministry", "status", "translations"] });
  });

  it("a contact-details profile with no list choice still gets the defaults", async () => {
    await tdb.db.insert(userProfiles).values({ userId: w.as.admin.id, phone: "250-555-0102" });
    expect((await call(app, "get", "/api/list/preferences", w.as.admin.cookie)).body.hiddenColumns).toEqual(["keywords", "ministry", "status", "translations"]);
  });

  it("saves both together, during the freeze too, and keeps the profile's contact details", async () => {
    await tdb.db.insert(userProfiles).values({ userId: w.as.readOnly.id, phone: "250-555-0103" });
    const res = await call(frozen, "put", "/api/list/preferences", w.as.readOnly.cookie, { display: "my_watchlist", hiddenColumns: ["translations", "city"] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ display: "my_watchlist", hiddenColumns: ["city", "translations"] });
    expect((await call(app, "get", "/api/list/preferences", w.as.readOnly.cookie)).body).toEqual({ display: "my_watchlist", hiddenColumns: ["city", "translations"] });
    const [p] = await tdb.db.select().from(userProfiles).where(eq(userProfiles.userId, w.as.readOnly.id));
    expect(p!.phone).toBe("250-555-0103");
    // Showing every column is a choice too.
    expect((await call(app, "put", "/api/list/preferences", w.as.readOnly.cookie, { display: "all", hiddenColumns: [] })).body).toEqual({ display: "all", hiddenColumns: [] });
  });

  it("refuses hiding the Activity Id column, a repeat, an unknown column or display, and extra keys", async () => {
    for (const body of [
      { display: "all", hiddenColumns: ["activity"] }, { display: "all", hiddenColumns: ["city", "city"] }, { display: "all", hiddenColumns: ["colour"] },
      { display: "everything", hiddenColumns: [] }, { display: "all", hiddenColumns: [], extra: 1 }, { display: "all" },
    ]) expect((await call(app, "put", "/api/list/preferences", w.as.editor.cookie, body)).status, JSON.stringify(body)).toBe(400);
  });

  it("watching needs a visible activity; it is idempotent and not frozen; unwatching never 404s", async () => {
    const own = await insertRaw(tdb.db, {});
    const secret = await insertRaw(tdb.db, { contactMinistryKey: "finance", isConfidential: true });
    const watch = (id: number | string, method: "put" | "delete" = "put", via = app) => call(via, method, `/api/activities/${id}/watch`, w.as.editor.cookie);
    expect((await watch(own, "put", frozen)).status).toBe(204);
    expect((await watch(own)).status).toBe(204);
    expect(await tdb.db.select().from(favourites).where(and(eq(favourites.userId, w.as.editor.id), eq(favourites.activityId, own)))).toHaveLength(1);
    expect((await watch(secret)).status).toBe(404);
    expect((await watch("abc")).status).toBe(404);
    expect((await watch("9999999999")).status).toBe(404);
    expect(await tdb.db.select().from(favourites).where(eq(favourites.activityId, secret))).toHaveLength(0);
    expect((await watch(own, "delete")).status).toBe(204);
    expect((await watch(secret, "delete")).status).toBe(204);
    expect(await tdb.db.select().from(favourites).where(eq(favourites.activityId, own))).toHaveLength(0);
    expect((await call(app, "put", `/api/activities/${own}/watch`, w.as.editor.cookie, { extra: 1 })).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/http/list-preferences.test.ts`
Expected: FAIL (404s from missing routes).

- [ ] **Step 3: Implement**

`apps/calendar/src/list/preferences.ts`:

```ts
import { eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import { DEFAULT_HIDDEN_COLUMNS, HIDEABLE_COLUMNS, type HideableColumn, type ListPreferences } from "@gcpe/calendar-contract";
import { userProfiles } from "../db/schema";

const isHideable = (c: string): c is HideableColumn => (HIDEABLE_COLUMNS as readonly string[]).includes(c);

/**
 * The user's list display and hidden columns. Both are written together, so a null display means
 * no choice yet: legacy's defaults for both (a contact-details profile holds '{}' for the columns).
 */
export async function readPreferences(db: DbOrTx, userId: string): Promise<ListPreferences> {
  const [p] = await db.select({ display: userProfiles.listDisplay, hidden: userProfiles.hiddenColumns }).from(userProfiles).where(eq(userProfiles.userId, userId));
  if (!p || p.display === null) return { display: "all", hiddenColumns: [...DEFAULT_HIDDEN_COLUMNS] };
  return { display: p.display, hiddenColumns: p.hidden.filter(isHideable) };
}

/** Not frozen (spec addendum §7.4). */
export async function writePreferences(db: DbOrTx, userId: string, p: ListPreferences): Promise<ListPreferences> {
  const values = { listDisplay: p.display, hiddenColumns: [...p.hiddenColumns].sort(), updatedAt: sql`now()` };
  await db.insert(userProfiles).values({ userId, ...values }).onConflictDoUpdate({ target: userProfiles.userId, set: values });
  return readPreferences(db, userId);
}
```

`apps/calendar/src/list/watch.ts`:

```ts
import { and, eq } from "drizzle-orm";
import type { Db, DbOrTx } from "@gcpe/db-kit";
import type { CalendarActor } from "../actor";
import { ActivityNotFoundError } from "../activities/errors";
import { activities, favourites } from "../db/schema";
import { visibleSql } from "../visibility";

/** Adds to My Watchlist (legacy FavoriteActivity). Only an activity the caller can see; not frozen. */
export async function watchActivity(db: Db, actor: CalendarActor, id: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [a] = await tx.select({ id: activities.id }).from(activities).where(and(eq(activities.id, id), visibleSql(actor)));
    if (!a) throw new ActivityNotFoundError();
    await tx.insert(favourites).values({ userId: actor.userId, activityId: id }).onConflictDoNothing();
  });
}

/** Removes from My Watchlist, whether or not the activity is still visible: never a 404, which would say whether it exists. */
export async function unwatchActivity(db: DbOrTx, actor: CalendarActor, id: number): Promise<void> {
  await db.delete(favourites).where(and(eq(favourites.userId, actor.userId), eq(favourites.activityId, id)));
}
```

In `apps/calendar/src/http/list-routes.ts`, add imports (`listPreferencesSchema` from the contract; `readPreferences`, `writePreferences`; `watchActivity`, `unwatchActivity`; `idOf` from `./activity-routes`) and, inside `listRoutes`:

```ts
  r.get("/list/preferences", runList(async (req, res) => void res.json(await readPreferences(deps.db, req.calendar!.userId))));
  r.put("/list/preferences", runList(async (req, res) => {
    res.json(await writePreferences(deps.db, req.calendar!.userId, listPreferencesSchema.parse(req.body)));
  }));
  r.put("/activities/:id/watch", runList(async (req, res) => {
    emptyBody.parse(req.body ?? {});
    await watchActivity(deps.db, req.calendar!, idOf(req as Request<{ id: string }>));
    res.status(204).end();
  }));
  r.delete("/activities/:id/watch", runList(async (req, res) => {
    emptyBody.parse(req.body ?? {});
    await unwatchActivity(deps.db, req.calendar!, idOf(req as Request<{ id: string }>));
    res.status(204).end();
  }));
```

with `const emptyBody = z.object({}).strict();` at module level and `import { Router, type Request } from "express";`.

- [ ] **Step 4: Run the tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/http/list-preferences.test.ts apps/calendar/src/http/list-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/calendar/src/list apps/calendar/src/http
git commit -m "feat(calendar): saved list display and columns with legacy's defaults; the watchlist, visible activities only"
```

---

### Task 7: Saved filters ("My Queries"), owner only

Covers: spec §8.1 ("save, apply, rename, reorder and delete, by the owner only"), §6 (saved filters: owner only), §7.4 (not frozen), C141. Decision D14. Review Focus 5.

**Files:**
- Create: `apps/calendar/src/list/saved-filters.ts`, `apps/calendar/src/http/saved-filter-routes.ts`, `apps/calendar/src/http/saved-filter-routes.test.ts`.
- Modify: `apps/calendar/src/http/list-errors.ts`, `apps/calendar/src/http/routes.ts`.

**Interfaces:**
- Consumes: `savedFilters`, Task 2's `listFilterSchema`, `savedFilterCreateSchema`, `savedFilterRenameSchema`, `savedFilterOrderSchema`, `SavedFilterView`, `ListFilter`; Task 4's `runList`, `sendListError`.
- Produces:
  - `SAVED_FILTER_LIMIT = 200`; `SavedFilterNotFoundError` (404), `SavedFilterOrderError` (409), `SavedFilterLimitError` (422).
  - `listSavedFilters(db: DbOrTx, ownerId: string): Promise<SavedFilterView[]>`, `createSavedFilter(db: Db, ownerId: string, input: { name: string; filter: ListFilter }): Promise<SavedFilterView>`, `renameSavedFilter(db: DbOrTx, ownerId: string, id: number, name: string): Promise<SavedFilterView>`, `deleteSavedFilter(db: DbOrTx, ownerId: string, id: number): Promise<void>`, `reorderSavedFilters(db: Db, ownerId: string, ids: number[]): Promise<SavedFilterView[]>`.
  - Routes: `GET /api/saved-filters`, `POST /api/saved-filters` (201), `PUT /api/saved-filters/order`, `PUT /api/saved-filters/:id`, `DELETE /api/saved-filters/:id` (204).

- [ ] **Step 1: Write the failing tests**

`apps/calendar/src/http/saved-filter-routes.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { EMPTY_LIST_FILTER } from "@gcpe/calendar-contract";
import { createCalendarTestDb, createTestApp } from "../../test/helpers";
import { call, insertRaw, seedWorld, type World } from "../../test/world";
import { activityCategories, savedFilters } from "../db/schema";

describe("saved filters, \"My Queries\" (spec addendum §8.1, C141)", () => {
  let tdb: TestDatabase;
  let w: World;
  let app: ReturnType<typeof createTestApp>;
  let frozen: ReturnType<typeof createTestApp>;
  const user = (who: keyof World["as"]) => ({
    list: () => call(app, "get", "/api/saved-filters", w.as[who].cookie),
    create: (body: object, via = app) => call(via, "post", "/api/saved-filters", w.as[who].cookie, body),
    rename: (id: number | string, name: string) => call(app, "put", `/api/saved-filters/${id}`, w.as[who].cookie, { name }),
    remove: (id: number | string) => call(app, "delete", `/api/saved-filters/${id}`, w.as[who].cookie),
    order: (ids: number[]) => call(app, "put", "/api/saved-filters/order", w.as[who].cookie, { ids }),
  });

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    frozen = createTestApp(tdb.db, { now: () => new Date("2026-11-02T23:30:00Z") });
    w = await seedWorld(app, tdb.db);
  });
  afterAll(() => tdb.drop());

  it("saves (during the freeze too), lists in order, renames, reorders and deletes; delete keeps the row, inactive", async () => {
    const me = user("editor");
    const a = await me.create({ name: " Sample one ", filter: { categoryId: w.cat.event } }, frozen);
    expect(a.status).toBe(201);
    expect(a.body).toEqual({ id: expect.any(Number), name: "Sample one", sortOrder: 1, filter: { ...EMPTY_LIST_FILTER, categoryId: w.cat.event } });
    const b = (await me.create({ name: "Sample two", filter: {} })).body;
    expect((await me.list()).body.map((f: { name: string }) => f.name)).toEqual(["Sample one", "Sample two"]);
    expect((await me.rename(b.id, "Sample second")).body).toMatchObject({ id: b.id, name: "Sample second" });
    expect((await me.order([b.id, a.body.id])).body.map((f: { id: number }) => f.id)).toEqual([b.id, a.body.id]);
    expect((await me.remove(a.body.id)).status).toBe(204);
    expect((await me.list()).body.map((f: { id: number }) => f.id)).toEqual([b.id]);
    const [row] = await tdb.db.select().from(savedFilters).where(eq(savedFilters.id, a.body.id));
    expect(row!.isActive).toBe(false);
  });

  it("is owner only: another user's query is 404 to rename or delete and absent from their list", async () => {
    const mine = (await user("admin").create({ name: "Sample private", filter: {} })).body;
    expect((await user("editor").rename(mine.id, "Taken")).status).toBe(404);
    expect((await user("editor").remove(mine.id)).status).toBe(404);
    expect((await user("editor").list()).body.map((f: { id: number }) => f.id)).not.toContain(mine.id);
    expect((await user("admin").list()).body.map((f: { name: string }) => f.name)).toContain("Sample private");
  });

  it("reorder names exactly the owner's active queries, or it is 409", async () => {
    const me = user("readOnly");
    const x = (await me.create({ name: "Sample x", filter: {} })).body;
    const y = (await me.create({ name: "Sample y", filter: {} })).body;
    const other = (await user("hqEditor").create({ name: "Sample other", filter: {} })).body;
    expect((await me.order([x.id])).status).toBe(409);
    expect((await me.order([x.id, y.id, other.id])).status).toBe(409);
    expect((await me.order([y.id, x.id])).status).toBe(200);
  });

  it("refuses a blank or over-long name, a bad filter, an unknown key, and bad ids", async () => {
    const me = user("financeEditor");
    for (const body of [{ name: "  ", filter: {} }, { name: "x".repeat(201), filter: {} }, { name: "Sample", filter: { categoryId: -1 } }, { name: "Sample", filter: {}, extra: 1 }, { name: "Sample" }]) {
      expect((await me.create(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await me.rename("abc", "Sample")).status).toBe(404);
    expect((await me.rename("9999999999", "Sample")).status).toBe(404);
    expect((await me.order([2_147_483_648])).status).toBe(400);
  });

  it("keeps at most 200 active queries per owner", async () => {
    await tdb.db.insert(savedFilters).values(Array.from({ length: 200 }, (_, n) => ({ ownerId: w.as.hqAdvanced.id, name: `Sample ${n}`, filter: EMPTY_LIST_FILTER, sortOrder: n + 1 })));
    const res = await user("hqAdvanced").create({ name: "Sample 201", filter: {} });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/200/);
  });

  it("a saved filter naming a deactivated category still applies; an unreadable one is null, not a 500", async () => {
    const saved = (await user("hqAdmin").create({ name: "Sample retired", filter: { categoryId: w.cat.retired, from: "2045-01-01", to: "2045-12-31" } })).body;
    const id = await insertRaw(tdb.db, { startAt: new Date("2045-01-10T17:00:00Z"), endAt: new Date("2045-01-10T18:00:00Z") });
    await tdb.db.insert(activityCategories).values({ activityId: id, categoryId: w.cat.retired });
    const q = encodeURIComponent(JSON.stringify({ filter: saved.filter }));
    expect((await call(app, "get", `/api/list?q=${q}`, w.as.hqAdmin.cookie)).body.rows.map((r: { id: number }) => r.id)).toEqual([id]);
    const broken = (await user("hqAdmin").create({ name: "Sample broken", filter: {} })).body;
    await tdb.db.execute(sql`UPDATE saved_filters SET filter = '{"colour":"blue"}'::jsonb WHERE id = ${broken.id}`);
    const list = await user("hqAdmin").list();
    expect(list.status).toBe(200);
    expect(list.body.find((f: { id: number }) => f.id === broken.id)).toEqual({ id: broken.id, name: "Sample broken", sortOrder: expect.any(Number), filter: null });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/http/saved-filter-routes.test.ts`
Expected: FAIL (404s).

- [ ] **Step 3: Implement the service**

`apps/calendar/src/list/saved-filters.ts`:

```ts
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db, DbOrTx, Tx } from "@gcpe/db-kit";
import { listFilterSchema, type ListFilter, type SavedFilterView } from "@gcpe/calendar-contract";
import { savedFilters } from "../db/schema";

export const SAVED_FILTER_LIMIT = 200;

export class SavedFilterNotFoundError extends Error {
  override name = "SavedFilterNotFoundError";
}
export class SavedFilterOrderError extends Error {
  override name = "SavedFilterOrderError";
  constructor() {
    super("Your queries changed since you loaded them: reload and try again");
  }
}
export class SavedFilterLimitError extends Error {
  override name = "SavedFilterLimitError";
  constructor() {
    super(`You can keep up to ${SAVED_FILTER_LIMIT} queries: delete one first`);
  }
}

/** A stored filter that no longer reads as one comes back null, so the list of queries still loads. */
const viewOf = (r: typeof savedFilters.$inferSelect): SavedFilterView => {
  const parsed = listFilterSchema.safeParse(r.filter);
  return { id: r.id, name: r.name, sortOrder: r.sortOrder, filter: parsed.success ? parsed.data : null };
};
const mine = (ownerId: string) => and(eq(savedFilters.ownerId, ownerId), eq(savedFilters.isActive, true));
/** One owner's writes queue behind each other: a count or an order check can't interleave with another tab's. */
const lockOwner = (tx: Tx, ownerId: string) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`calendar-saved-filters:${ownerId}`}))`);

export async function listSavedFilters(db: DbOrTx, ownerId: string): Promise<SavedFilterView[]> {
  return (await db.select().from(savedFilters).where(mine(ownerId)).orderBy(asc(savedFilters.sortOrder), asc(savedFilters.id))).map(viewOf);
}

export function createSavedFilter(db: Db, ownerId: string, input: { name: string; filter: ListFilter }): Promise<SavedFilterView> {
  return db.transaction(async (tx) => {
    await lockOwner(tx, ownerId);
    const [c] = await tx
      .select({ n: sql<number>`count(*)`.mapWith(Number), max: sql<number>`coalesce(max(${savedFilters.sortOrder}), 0)`.mapWith(Number) })
      .from(savedFilters)
      .where(mine(ownerId));
    if (c!.n >= SAVED_FILTER_LIMIT) throw new SavedFilterLimitError();
    const [row] = await tx.insert(savedFilters).values({ ownerId, name: input.name, filter: input.filter, sortOrder: c!.max + 1 }).returning();
    return viewOf(row!);
  });
}

export async function renameSavedFilter(db: DbOrTx, ownerId: string, id: number, name: string): Promise<SavedFilterView> {
  const [row] = await db.update(savedFilters).set({ name }).where(and(eq(savedFilters.id, id), mine(ownerId))).returning();
  if (!row) throw new SavedFilterNotFoundError();
  return viewOf(row);
}

/** Legacy kept a deleted query, inactive (ActivityFilter.asmx.cs:82-90). */
export async function deleteSavedFilter(db: DbOrTx, ownerId: string, id: number): Promise<void> {
  const rows = await db.update(savedFilters).set({ isActive: false }).where(and(eq(savedFilters.id, id), mine(ownerId))).returning({ id: savedFilters.id });
  if (rows.length === 0) throw new SavedFilterNotFoundError();
}

/** Sets the order 1..n. The ids must be exactly the owner's active queries. */
export function reorderSavedFilters(db: Db, ownerId: string, ids: number[]): Promise<SavedFilterView[]> {
  return db.transaction(async (tx) => {
    await lockOwner(tx, ownerId);
    const have = (await tx.select({ id: savedFilters.id }).from(savedFilters).where(mine(ownerId))).map((r) => r.id).sort((a, b) => a - b);
    const want = [...ids].sort((a, b) => a - b);
    if (have.length !== want.length || have.some((v, i) => v !== want[i])) throw new SavedFilterOrderError();
    for (const [n, id] of ids.entries()) await tx.update(savedFilters).set({ sortOrder: n + 1 }).where(eq(savedFilters.id, id));
    return listSavedFilters(tx, ownerId);
  });
}
```

- [ ] **Step 4: The routes and their errors**

`apps/calendar/src/http/saved-filter-routes.ts`:

```ts
import { Router, type Request } from "express";
import { savedFilterCreateSchema, savedFilterOrderSchema, savedFilterRenameSchema } from "@gcpe/calendar-contract";
import { createSavedFilter, deleteSavedFilter, listSavedFilters, renameSavedFilter, reorderSavedFilters, SavedFilterNotFoundError } from "../list/saved-filters";
import { runList } from "./list-errors";
import type { ApiDeps } from "./routes";

/** An id the saved_filters int4 column can hold; anything else is simply not one of yours. */
function filterIdOf(req: Request): number {
  const raw = req.params.id ?? "";
  if (!/^\d{1,9}$/.test(raw)) throw new SavedFilterNotFoundError();
  return Number(raw);
}

/** My Queries (spec addendum §8.1): the owner's only (C141); not frozen (§7.4). */
export function savedFilterRoutes(deps: ApiDeps): Router {
  const r = Router();
  r.get("/saved-filters", runList(async (req, res) => void res.json(await listSavedFilters(deps.db, req.calendar!.userId))));
  r.post("/saved-filters", runList(async (req, res) => {
    res.status(201).json(await createSavedFilter(deps.db, req.calendar!.userId, savedFilterCreateSchema.parse(req.body)));
  }));
  // Before "/saved-filters/:id", which would otherwise take "order" as an id.
  r.put("/saved-filters/order", runList(async (req, res) => {
    res.json(await reorderSavedFilters(deps.db, req.calendar!.userId, savedFilterOrderSchema.parse(req.body).ids));
  }));
  r.put("/saved-filters/:id", runList(async (req, res) => {
    res.json(await renameSavedFilter(deps.db, req.calendar!.userId, filterIdOf(req), savedFilterRenameSchema.parse(req.body).name));
  }));
  r.delete("/saved-filters/:id", runList(async (req, res) => {
    await deleteSavedFilter(deps.db, req.calendar!.userId, filterIdOf(req));
    res.status(204).end();
  }));
  return r;
}
```

In `apps/calendar/src/http/list-errors.ts`, import the three error classes and make `sendListError`:

```ts
export function sendListError(e: unknown, res: Response, req: Request): boolean {
  if (e instanceof SavedFilterNotFoundError) return void res.status(404).json({ error: "not found" }), true;
  if (e instanceof SavedFilterOrderError) return void res.status(409).json({ code: "stale", error: e.message }), true;
  if (e instanceof SavedFilterLimitError) return void res.status(422).json({ error: e.message }), true;
  return sendActivityError(e, res, req);
}
```

In `apps/calendar/src/http/routes.ts`, add `r.use(savedFilterRoutes(deps));` after `r.use(listRoutes(deps));`.

- [ ] **Step 5: Run the tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/http/saved-filter-routes.test.ts apps/calendar/src/http/list-routes.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/calendar/src/list apps/calendar/src/http
git commit -m "feat(calendar): My Queries: save, rename, reorder and delete saved filters, owner only (C141)"
```

---

### Task 8: Migrating legacy saved queries, with a report

Covers: spec §3 row 5d ("a legacy saved-filter fixture migrates with a report"), §8.1 ("Imported legacy query strings are converted"), §12.1 step 5 (stale prefix stripped; an unmappable parameter dropped, the filter kept and reported), §16 (the saved-filter converter). Decision D15.

**Files:**
- Create: `apps/calendar/src/list/legacy-filters.ts`, `apps/calendar/src/list/legacy-filters.test.ts`.
- Create: `apps/calendar/test/fixtures/legacy-saved-filters.ts`.

**Interfaces:**
- Consumes: Task 2's `listFilterSchema`, `bcDateSchema`, `LIST_DISPLAYS`, `DEFAULT_HIDDEN_COLUMNS`, `HideableColumn`; `savedFilters` and the lookup tables.
- Produces (5i calls these):
  - `interface LegacySavedFilterRow { id: number; createdBy: number | null; name: string | null; queryString: string | null; sortOrder: number | null; isActive: boolean | null }`.
  - `interface LegacyFilterResolver { ministryKeyOf(legacyGuid: string): string | null; userIdOf(legacyUserId: number): string | null }`.
  - `interface DroppedParam { key: string; value: string; reason: string }`, `interface ConvertedFilter { filter: ListFilter; dropped: DroppedParam[] }`.
  - `convertLegacyQuery(queryString: string, resolve: LegacyFilterResolver): ConvertedFilter`.
  - `interface SavedFilterMigrationReport { read: number; migrated: number; skippedInactive: number; skippedNoOwner: { id: number; legacyOwner: number | null }[]; strippedPrefix: number; dropped: ({ id: number } & DroppedParam)[] }`.
  - `migrateLegacySavedFilters(db: Db, rows: LegacySavedFilterRow[], resolve: LegacyFilterResolver): Promise<SavedFilterMigrationReport>` (keeps legacy ids; a re-run updates in place).
  - `legacyHiddenColumns(csv: string | null): HideableColumn[]`, `legacyDisplay(value: number | null): ListDisplay`.

- [ ] **Step 1: Write the fixture**

`apps/calendar/test/fixtures/legacy-saved-filters.ts`:

```ts
import type { LegacyFilterResolver, LegacySavedFilterRow } from "../../src/list/legacy-filters";

/** Fictional legacy users and a fictional ministry GUID; no legacy data. */
export const LEGACY_OWNER_A = 7001;
export const LEGACY_OWNER_B = 7002;
export const OWNER_A = "00000000-0000-4000-8000-000000000701";
export const OWNER_B = "00000000-0000-4000-8000-000000000702";
export const HEALTH_GUID = "1C6D5A10-0000-4000-8000-00000000000A";

export const LEGACY_SAVED_FILTERS: LegacySavedFilterRow[] = [
  { id: 501, createdBy: LEGACY_OWNER_A, name: "Sample health this month", sortOrder: 1, isActive: true,
    queryString: `status=1|category=12|ministry=${HEALTH_GUID}|datefrom=10/01/2026|dateto=10/31/2026|keywords=1~2|isissue=true|dateConfirmed=false|display=2|thisdayonly=false|lookahead=true|quickSearch=sample launch` },
  { id: 502, createdBy: LEGACY_OWNER_B, name: "Sample stale", sortOrder: 1, isActive: true,
    queryString: "ActivityListProvider.aspx?contact=7001&representative=1&premierRequested=2&distribution=1&initiative=1" },
  { id: 503, createdBy: LEGACY_OWNER_A, name: "Sample deleted", sortOrder: 2, isActive: false, queryString: "status=7" },
  { id: 504, createdBy: 9999, name: "Sample orphan", sortOrder: 1, isActive: true, queryString: "status=2" },
  { id: 505, createdBy: LEGACY_OWNER_B, name: "Sample odd one", sortOrder: 2, isActive: true,
    queryString: "status=5|category=-2|ministry=FFFFFFFF-0000-4000-8000-00000000000F|datefrom=13/45/2026|keywords=1~x|colour=blue|representative=*|initiative=" },
  { id: 506, createdBy: LEGACY_OWNER_A, name: null, sortOrder: null, isActive: true, queryString: "" },
  { id: 507, createdBy: LEGACY_OWNER_B, name: "Sample backwards", sortOrder: 3, isActive: true, queryString: "datefrom=12/01/2026|dateto=11/01/2026|category=999" },
  { id: 508, createdBy: LEGACY_OWNER_A, name: "Sample equals", sortOrder: 3, isActive: true, queryString: "quickSearch=a=b|status=2" },
];

export const LEGACY_RESOLVER: LegacyFilterResolver = {
  ministryKeyOf: (guid) => (guid === HEALTH_GUID ? "health" : null),
  userIdOf: (legacyId) => (legacyId === LEGACY_OWNER_A ? OWNER_A : legacyId === LEGACY_OWNER_B ? OWNER_B : null),
};
```

- [ ] **Step 2: Write the failing tests**

`apps/calendar/src/list/legacy-filters.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { EMPTY_LIST_FILTER } from "@gcpe/calendar-contract";
import { createCalendarTestDb, createTestApp } from "../../test/helpers";
import { HEALTH_GUID, LEGACY_RESOLVER, LEGACY_SAVED_FILTERS, OWNER_A, OWNER_B } from "../../test/fixtures/legacy-saved-filters";
import { seedWorld } from "../../test/world";
import { savedFilters } from "../db/schema";
import { convertLegacyQuery, legacyDisplay, legacyHiddenColumns, migrateLegacySavedFilters } from "./legacy-filters";

const NOT_APPLIED = "legacy never applied it to a saved query";

describe("converting a legacy saved query (spec addendum §12.1 step 5)", () => {
  it("maps every parameter legacy's SetFilter applied", () => {
    const out = convertLegacyQuery(LEGACY_SAVED_FILTERS[0]!.queryString!, LEGACY_RESOLVER);
    expect(out.filter).toEqual({
      ...EMPTY_LIST_FILTER, status: "changed", categoryId: 12, ministryKey: "health", from: "2026-10-01", to: "2026-10-31",
      keywordIds: [1, 2], isIssue: true, dateConfirmed: false, quickSearch: "sample launch",
    });
    expect(out.dropped).toEqual([
      { key: "display", value: "2", reason: NOT_APPLIED },
      { key: "thisdayonly", value: "false", reason: NOT_APPLIED },
      { key: "lookahead", value: "true", reason: NOT_APPLIED },
    ]);
  });

  it("reads a stale ActivityListProvider.aspx? query string", () => {
    expect(convertLegacyQuery(LEGACY_SAVED_FILTERS[1]!.queryString!, LEGACY_RESOLVER).filter).toEqual({
      ...EMPTY_LIST_FILTER, commContactUserId: OWNER_A, representativeId: 1, premierRequestedId: 2, distributionId: 1, initiativeId: 1,
    });
  });

  it("drops what it can't read, with a reason, and keeps the rest", () => {
    const out = convertLegacyQuery(LEGACY_SAVED_FILTERS[4]!.queryString!, LEGACY_RESOLVER);
    expect(out.filter).toEqual({ ...EMPTY_LIST_FILTER, keywordIds: [1] });
    expect(out.dropped).toEqual([
      { key: "status", value: "5", reason: "unknown status" },
      { key: "category", value: "-2", reason: "an exclusion, which a saved query can't hold" },
      { key: "ministry", value: "FFFFFFFF-0000-4000-8000-00000000000F", reason: "no Core ministry for this id" },
      { key: "datefrom", value: "13/45/2026", reason: "not a date" },
      { key: "keywords", value: "1~x", reason: "a keyword id that isn't a number" },
      { key: "colour", value: "blue", reason: "unknown parameter" },
    ]);
  });

  it("keeps everything after the first = in a value, and drops a To before the From", () => {
    expect(convertLegacyQuery("quickSearch=a=b", LEGACY_RESOLVER).filter.quickSearch).toBe("a=b");
    const out = convertLegacyQuery("datefrom=12/01/2026|dateto=11/01/2026", LEGACY_RESOLVER);
    expect(out.filter).toMatchObject({ from: "2026-12-01", to: null });
    expect(out.dropped).toEqual([{ key: "dateto", value: "2026-11-01", reason: "before the From date" }]);
    expect(convertLegacyQuery(`ministry=${HEALTH_GUID.toLowerCase()}`, LEGACY_RESOLVER).dropped).toHaveLength(1);
  });

  it("converts legacy's hidden columns and display", () => {
    expect(legacyHiddenColumns(null)).toEqual(["keywords", "ministry", "status", "translations"]);
    expect(legacyHiddenColumns("0,11,10,99,x")).toEqual(["city", "translations"]);
    expect(legacyHiddenColumns("")).toEqual([]);
    expect([3, 2, 4, 10, 7, null].map(legacyDisplay)).toEqual(["all", "my_ministries", "my_activities", "my_watchlist", "all", "all"]);
  });
});

describe("migrating the legacy saved-filter fixture", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    await seedWorld(createTestApp(tdb.db), tdb.db);
  });
  afterAll(() => tdb.drop());

  it("migrates the active ones with their owners and legacy ids, reports every skip and drop, and a re-run changes nothing", async () => {
    const report = await migrateLegacySavedFilters(tdb.db, LEGACY_SAVED_FILTERS, LEGACY_RESOLVER);
    expect(report).toEqual({
      read: 8, migrated: 6, skippedInactive: 1, skippedNoOwner: [{ id: 504, legacyOwner: 9999 }], strippedPrefix: 1,
      dropped: [
        { id: 501, key: "display", value: "2", reason: NOT_APPLIED },
        { id: 501, key: "thisdayonly", value: "false", reason: NOT_APPLIED },
        { id: 501, key: "lookahead", value: "true", reason: NOT_APPLIED },
        { id: 505, key: "status", value: "5", reason: "unknown status" },
        { id: 505, key: "category", value: "-2", reason: "an exclusion, which a saved query can't hold" },
        { id: 505, key: "ministry", value: "FFFFFFFF-0000-4000-8000-00000000000F", reason: "no Core ministry for this id" },
        { id: 505, key: "datefrom", value: "13/45/2026", reason: "not a date" },
        { id: 505, key: "keywords", value: "1~x", reason: "a keyword id that isn't a number" },
        { id: 505, key: "colour", value: "blue", reason: "unknown parameter" },
        { id: 507, key: "dateto", value: "2026-11-01", reason: "before the From date" },
        { id: 507, key: "category", value: "999", reason: "no such category in the Calendar" },
      ],
    });
    const rows = await tdb.db.select().from(savedFilters).orderBy(asc(savedFilters.id));
    expect(rows.map((r) => [r.id, r.ownerId, r.name, r.sortOrder, r.isActive])).toEqual([
      [501, OWNER_A, "Sample health this month", 1, true],
      [502, OWNER_B, "Sample stale", 1, true],
      [505, OWNER_B, "Sample odd one", 2, true],
      [506, OWNER_A, "My Query", 0, true],
      [507, OWNER_B, "Sample backwards", 3, true],
      [508, OWNER_A, "Sample equals", 3, true],
    ]);
    expect(rows.find((r) => r.id === 507)!.filter).toEqual({ ...EMPTY_LIST_FILTER, from: "2026-12-01" });
    expect(await migrateLegacySavedFilters(tdb.db, LEGACY_SAVED_FILTERS, LEGACY_RESOLVER)).toEqual(report);
    expect(await tdb.db.select().from(savedFilters)).toHaveLength(6);
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/list/legacy-filters.test.ts`
Expected: FAIL ("Failed to resolve import ./legacy-filters").

- [ ] **Step 4: Implement**

`apps/calendar/src/list/legacy-filters.ts`:

```ts
import type { Db } from "@gcpe/db-kit";
import {
  bcDateSchema, DEFAULT_HIDDEN_COLUMNS, listFilterSchema, type ActivityStatus, type HideableColumn, type ListDisplay, type ListFilter,
} from "@gcpe/calendar-contract";
import { categories, governmentRepresentatives, initiatives, keywords, nrDistributions, premierRequested, savedFilters } from "../db/schema";

/** A legacy calendar.ActivityFilter row, as the importer reads it. */
export interface LegacySavedFilterRow {
  id: number;
  createdBy: number | null;
  name: string | null;
  queryString: string | null;
  sortOrder: number | null;
  isActive: boolean | null;
}
/** How legacy ids become Core's: 5i supplies these from Core's tables. */
export interface LegacyFilterResolver {
  ministryKeyOf(legacyGuid: string): string | null;
  userIdOf(legacyUserId: number): string | null;
}
export interface DroppedParam {
  key: string;
  value: string;
  reason: string;
}
export interface ConvertedFilter {
  filter: ListFilter;
  dropped: DroppedParam[];
}

/** The 91 stale keys carry this prefix (spec addendum §12.1); legacy's SetFilter stripped it (Default.aspx:429). */
const STALE_PREFIX = "ActivityListProvider.aspx?";
const NOT_APPLIED = "legacy never applied it to a saved query";
/** Legacy StatusId: 1 Changed, 2 Reviewed, 7 New (spec addendum §5.2). */
const LEGACY_STATUS: Record<string, ActivityStatus> = { "1": "changed", "2": "reviewed", "7": "new" };
const INT4_MAX = 2_147_483_647;

const intOf = (s: string): number | null => {
  if (!/^-?\d{1,10}$/.test(s)) return null;
  const n = Number(s);
  return Math.abs(n) <= INT4_MAX ? n : null;
};
const boolOf = (s: string): boolean | null => (/^true$/i.test(s) ? true : /^false$/i.test(s) ? false : null);
/** jQuery UI's datepicker wrote M/D/YYYY; accept ISO too. */
function dateOf(s: string): string | null {
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  const iso = us ? `${us[3]}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}` : s;
  return bcDateSchema.safeParse(iso).success ? iso : null;
}
const decoded = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * One legacy query string as the list's filter. It applies what legacy's SetFilter applied
 * (Default.aspx:426-488); display, This day only and the Look Ahead setting were saved but never
 * applied, so they are dropped. Anything unreadable is dropped with a reason; the rest is kept.
 */
export function convertLegacyQuery(queryString: string, resolve: LegacyFilterResolver): ConvertedFilter {
  const stale = queryString.startsWith(STALE_PREFIX);
  const body = stale ? queryString.slice(STALE_PREFIX.length) : queryString;
  // Current keys join with "|" (Default.aspx's GetQuery for a post); the stale URL form joined with "&".
  const parts = body.split(stale && !body.includes("|") ? "&" : "|").filter(Boolean);
  const f: Record<string, unknown> = {};
  const dropped: DroppedParam[] = [];
  const drop = (key: string, value: string, reason: string) => dropped.push({ key, value, reason });
  const idInto = (field: string, key: string, value: string, what: string) => {
    const n = intOf(value);
    if (n !== null && n > 0) f[field] = n;
    else drop(key, value, `not a ${what} id`);
  };
  for (const part of parts) {
    const at = part.indexOf("=");
    const key = at < 0 ? part : part.slice(0, at);
    // Everything after the first "=": legacy's split("=")[1] cut a value at a second one.
    const value = stale ? decoded(at < 0 ? "" : part.slice(at + 1)) : at < 0 ? "" : part.slice(at + 1);
    if (value === "" || value === "*") continue;
    switch (key) {
      case "status": {
        const s = LEGACY_STATUS[value];
        if (s) f.status = s;
        else drop(key, value, "unknown status");
        break;
      }
      case "category": {
        const n = intOf(value);
        if (n !== null && n > 0) f.categoryId = n;
        else drop(key, value, n !== null && n < 0 ? "an exclusion, which a saved query can't hold" : "not a category id");
        break;
      }
      case "ministry": {
        const k = resolve.ministryKeyOf(value);
        if (k !== null) f.ministryKey = k;
        else drop(key, value, "no Core ministry for this id");
        break;
      }
      case "contact": {
        const n = intOf(value);
        const u = n === null ? null : resolve.userIdOf(n);
        if (u !== null) f.commContactUserId = u;
        else drop(key, value, "no Core user for this legacy user");
        break;
      }
      case "representative":
        idInto("representativeId", key, value, "representative");
        break;
      case "initiative":
        idInto("initiativeId", key, value, "initiative");
        break;
      case "premierRequested":
        idInto("premierRequestedId", key, value, "Premier requested");
        break;
      case "distribution":
        idInto("distributionId", key, value, "distribution");
        break;
      case "keywords": {
        const ids = value.split("~").map(intOf);
        const good = [...new Set(ids.filter((n): n is number => n !== null && n > 0))];
        if (good.length) f.keywordIds = good.slice(0, 50);
        if (good.length !== ids.length) drop(key, value, "a keyword id that isn't a number");
        else if (good.length > 50) drop(key, value, "more than 50 HQ Tags; the first 50 kept");
        break;
      }
      case "isissue":
      case "dateConfirmed": {
        const b = boolOf(value);
        if (b !== null) f[key === "isissue" ? "isIssue" : "dateConfirmed"] = b;
        else drop(key, value, "not true or false");
        break;
      }
      case "datefrom":
      case "dateto": {
        const d = dateOf(value);
        if (d !== null) f[key === "datefrom" ? "from" : "to"] = d;
        else drop(key, value, "not a date");
        break;
      }
      case "quickSearch": {
        const t = value.replace(/\u0000/g, "").trim();
        if (t.length <= 200) f.quickSearch = t;
        else drop(key, value, "longer than 200 characters");
        break;
      }
      case "display":
      case "thisdayonly":
      case "lookahead":
        drop(key, value, NOT_APPLIED);
        break;
      default:
        drop(key, value, "unknown parameter");
    }
  }
  if (typeof f.from === "string" && typeof f.to === "string" && f.from > f.to) {
    drop("dateto", f.to, "before the From date");
    delete f.to;
  }
  return { filter: listFilterSchema.parse(f), dropped };
}

export interface SavedFilterMigrationReport {
  read: number;
  migrated: number;
  skippedInactive: number;
  skippedNoOwner: { id: number; legacyOwner: number | null }[];
  strippedPrefix: number;
  dropped: ({ id: number } & DroppedParam)[];
}

/** Ids in the filter that no Calendar lookup holds are dropped too, so a saved query never names a missing row. */
const LOOKUP_FIELDS = [
  { field: "categoryId", key: "category", what: "category" },
  { field: "representativeId", key: "representative", what: "government representative" },
  { field: "initiativeId", key: "initiative", what: "initiative" },
  { field: "premierRequestedId", key: "premierRequested", what: "Premier requested value" },
  { field: "distributionId", key: "distribution", what: "NR distribution" },
] as const;
type LookupField = (typeof LOOKUP_FIELDS)[number]["field"];
const idSet = async (q: Promise<{ id: number }[]>) => new Set((await q).map((r) => r.id));

/**
 * Writes the active legacy saved queries whose owner is a Core user, keeping legacy ids; a re-run
 * updates them in place. 5i re-bases the saved_filters identity afterwards.
 */
export async function migrateLegacySavedFilters(db: Db, rows: LegacySavedFilterRow[], resolve: LegacyFilterResolver): Promise<SavedFilterMigrationReport> {
  const report: SavedFilterMigrationReport = { read: rows.length, migrated: 0, skippedInactive: 0, skippedNoOwner: [], strippedPrefix: 0, dropped: [] };
  const known: Record<LookupField, Set<number>> = {
    categoryId: await idSet(db.select({ id: categories.id }).from(categories)),
    representativeId: await idSet(db.select({ id: governmentRepresentatives.id }).from(governmentRepresentatives)),
    initiativeId: await idSet(db.select({ id: initiatives.id }).from(initiatives)),
    premierRequestedId: await idSet(db.select({ id: premierRequested.id }).from(premierRequested)),
    distributionId: await idSet(db.select({ id: nrDistributions.id }).from(nrDistributions)),
  };
  const knownKeywords = await idSet(db.select({ id: keywords.id }).from(keywords));
  for (const row of rows) {
    if (row.isActive !== true) {
      report.skippedInactive++;
      continue;
    }
    const ownerId = row.createdBy === null ? null : resolve.userIdOf(row.createdBy);
    if (!ownerId) {
      report.skippedNoOwner.push({ id: row.id, legacyOwner: row.createdBy });
      continue;
    }
    const qs = row.queryString ?? "";
    if (qs.startsWith(STALE_PREFIX)) report.strippedPrefix++;
    const { filter, dropped } = convertLegacyQuery(qs, resolve);
    for (const l of LOOKUP_FIELDS) {
      const v = filter[l.field];
      if (v !== null && !known[l.field].has(v)) {
        dropped.push({ key: l.key, value: String(v), reason: `no such ${l.what} in the Calendar` });
        filter[l.field] = null;
      }
    }
    const missing = filter.keywordIds.filter((k) => !knownKeywords.has(k));
    if (missing.length) {
      dropped.push({ key: "keywords", value: missing.join("~"), reason: "no such HQ Tag in the Calendar" });
      filter.keywordIds = filter.keywordIds.filter((k) => knownKeywords.has(k));
    }
    report.dropped.push(...dropped.map((d) => ({ id: row.id, ...d })));
    const values = { ownerId, name: (row.name ?? "").trim().slice(0, 200) || "My Query", filter, sortOrder: row.sortOrder ?? 0, isActive: true };
    await db.insert(savedFilters).values({ id: row.id, ...values }).onConflictDoUpdate({ target: savedFilters.id, set: values });
    report.migrated++;
  }
  return report;
}

/** Legacy HiddenColumns held grid column indexes (UCFlexiGrid.ascx.cs's ColumnModel); null meant HiddenByDefault. */
const LEGACY_COLUMNS: Record<string, HideableColumn> = {
  "1": "keywords", "2": "ministry", "3": "status", "4": "dateTime", "5": "title", "6": "categories", "7": "commMaterials",
  "8": "premier", "9": "leadOrg", "10": "translations", "11": "city", "12": "commContact", "13": "governmentRep",
};
export function legacyHiddenColumns(csv: string | null): HideableColumn[] {
  if (csv === null) return [...DEFAULT_HIDDEN_COLUMNS];
  const mapped = csv.split(",").map((c) => LEGACY_COLUMNS[c.trim()]).filter((c): c is HideableColumn => c !== undefined);
  return [...new Set(mapped)].sort();
}

/** Legacy FilterDisplayValue (Default.aspx:608-613): 3 Show All, 2 My Ministries, 4 My Activities, 10 My Watchlist. */
export function legacyDisplay(value: number | null): ListDisplay {
  return value === 2 ? "my_ministries" : value === 4 ? "my_activities" : value === 10 ? "my_watchlist" : "all";
}
```

- [ ] **Step 5: Run the tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/list/legacy-filters.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/calendar/src/list/legacy-filters.ts apps/calendar/src/list/legacy-filters.test.ts apps/calendar/test/fixtures
git commit -m "feat(calendar): convert legacy saved queries, hidden columns and display, and migrate the saved-filter fixture with a report"
```

---

### Task 9: The calendar range and the Excel export

Covers: spec §8.1 (the calendar view of the current filter; the Excel export's header lines, 16 columns, red footer, visible rows only, formula-like cells inert), §6 (the export limited by `visible()`), C127, C151. Decisions D16, D17. Review Focus 4.

**Files:**
- Create: `apps/calendar/src/list/xlsx.ts`, `apps/calendar/src/list/xlsx.test.ts`, `apps/calendar/test/xlsx-read.ts`.
- Create: `apps/calendar/src/list/export.ts`, `apps/calendar/src/list/calendar-range.ts`, `apps/calendar/src/http/export-routes.test.ts`.
- Modify: `apps/calendar/src/http/list-routes.ts`, `apps/calendar/src/http/list-errors.ts`.

**Interfaces:**
- Consumes: Task 3's `scopeOf`, `listWhere`; Task 4's `rowsOf`, `listQueryParam`; Task 2's `friendlyDateRange`, `checkCalendarRange`, `bcDateSchema`, `CalendarRangeView`.
- Produces:
  - `xlsx.ts`: `interface Run { text: string; bold?: boolean; italic?: boolean; color?: string }`, `type CellStyle = "cell" | "boldCell" | "header" | "banner" | "heading" | "notice"`, `interface SheetCell { runs: Run[]; style: CellStyle; span?: number }`, `interface SheetRow { cells: SheetCell[]; height?: number }`, `interface Sheet { name: string; widths: number[]; rows: SheetRow[] }`, `inert(text: string): string`, `xlsxOf(sheet: Sheet): Buffer`, `XLSX_CONTENT_TYPE`.
  - `export.ts`: `EXPORT_ROW_LIMIT = 10_000`, `ExportTooLargeError` (422), `EXPORT_HEADERS`, `CONFIDENTIALITY_NOTICE`, `exportWorkbook(deps: ApiDeps, actor: CalendarActor, q: ListQuery): Promise<Buffer>`.
  - `calendar-range.ts`: `CALENDAR_ITEM_LIMIT = 1000`, `calendarRange(deps: ApiDeps, actor: CalendarActor, q: ListQuery, start: string, end: string): Promise<CalendarRangeView>`.
  - Routes: `GET /api/list/calendar?q=&start=&end=`, `GET /api/list/export.xlsx?q=`.
  - Test reader `readXlsx(buf: Buffer): { files: Map<string, string>; cells: Map<string, string> }`.

- [ ] **Step 1: Write the test reader**

`apps/calendar/test/xlsx-read.ts`:

```ts
import { inflateRawSync } from "node:zlib";

/** Every entry of a zip, by name, as text. Reads the central directory, as Excel does. */
export function unzip(buf: Buffer): Map<string, string> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("not a zip: no end of central directory");
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    out.set(name, (method === 8 ? inflateRawSync(data) : data).toString("utf8"));
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

/** Each cell's text by reference ("A1"), runs joined, XML entities undone. */
export function cellsOf(sheetXml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of sheetXml.matchAll(/<c r="([A-Z]+\d+)"[^>]*>(.*?)<\/c>/gs)) {
    const text = [...m[2]!.matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((t) => t[1]!).join("");
    out.set(m[1]!, text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
  }
  return out;
}

export function readXlsx(buf: Buffer): { files: Map<string, string>; cells: Map<string, string> } {
  const files = unzip(buf);
  return { files, cells: cellsOf(files.get("xl/worksheets/sheet1.xml") ?? "") };
}
```

- [ ] **Step 2: Write the failing writer tests**

`apps/calendar/src/list/xlsx.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readXlsx } from "../../test/xlsx-read";
import { inert, xlsxOf, type SheetCell } from "./xlsx";

const cell = (text: string): SheetCell => ({ runs: [{ text }], style: "cell" });

describe("the .xlsx writer", () => {
  it("writes a package Excel can open: content types, workbook, styles and one sheet", () => {
    const { files, cells } = readXlsx(xlsxOf({ name: "Activities", widths: [10, 20], rows: [{ cells: [cell("Sample"), cell("Two")] }] }));
    expect([...files.keys()].sort()).toEqual(["[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]);
    expect(cells.get("A1")).toBe("Sample");
    expect(cells.get("B1")).toBe("Two");
    expect(files.get("xl/worksheets/sheet1.xml")).toContain('t="inlineStr"');
  });

  it("cells that start like a formula are inert, even behind a control character", () => {
    for (const t of ["=1+1", "+1", "-1", "@SUM(A1)", "\t=1", "\r=1"]) expect(inert(t)).toBe(`'${t}`);
    for (const t of ["Sample", " =1", "", "a=b"]) expect(inert(t)).toBe(t);
    const { cells } = readXlsx(xlsxOf({ name: "S", widths: [10], rows: [
      { cells: [cell("=HYPERLINK(\"http://example.test\")")] },
      { cells: [cell("\u0001=1+1")] },
      { cells: [{ runs: [{ text: "" }, { text: "@cmd", bold: true }], style: "cell" }] },
    ] }));
    expect(cells.get("A1")).toBe("'=HYPERLINK(\"http://example.test\")");
    expect(cells.get("A2")).toBe("'=1+1");
    expect(cells.get("A3")).toBe("'@cmd");
  });

  it("escapes XML, drops characters XML can't carry, keeps line breaks, and merges spans", () => {
    const { files, cells } = readXlsx(xlsxOf({ name: "S", widths: [10, 10, 10], rows: [
      { cells: [{ runs: [{ text: "a <b> & \"c\"\u0007\nd\uD800" }], style: "cell", span: 2 }, cell("e")] },
    ] }));
    expect(cells.get("A1")).toBe("a <b> & \"c\"\nd");
    expect(cells.get("C1")).toBe("e");
    expect(files.get("xl/worksheets/sheet1.xml")).toContain('<mergeCell ref="A1:B1"/>');
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/list/xlsx.test.ts`
Expected: FAIL ("Failed to resolve import ./xlsx").

- [ ] **Step 4: Write the writer**

`apps/calendar/src/list/xlsx.ts`:

```ts
import { crc32, deflateRawSync } from "node:zlib";

export const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  /** ARGB, such as FF8B0000. */
  color?: string;
}
export type CellStyle = "cell" | "boldCell" | "header" | "banner" | "heading" | "notice";
export interface SheetCell {
  runs: Run[];
  style: CellStyle;
  /** Columns this cell covers, merged; 1 when absent. */
  span?: number;
}
export interface SheetRow {
  cells: SheetCell[];
  /** Points; Excel doesn't grow a merged cell's row to fit. */
  height?: number;
}
export interface Sheet {
  name: string;
  widths: number[];
  rows: SheetRow[];
}

const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const STYLE_INDEX: Record<CellStyle, number> = { cell: 1, boldCell: 2, header: 3, banner: 4, heading: 5, notice: 6 };

/** What Excel, or a CSV re-save, would read as a formula (OWASP CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;
/** A cell that starts like a formula gets a leading apostrophe, so it stays text wherever it goes. */
export const inert = (text: string) => (FORMULA_START.test(text) ? `'${text}` : text);
/** XML 1.0 can't carry most control characters or a lone surrogate. */
const xmlSafe = (s: string) =>
  s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const colName = (i: number) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

function runsXml(runs: Run[]): string {
  // Clean first, then make inert: a control character can't hide a leading "=".
  const clean = runs.map((r) => ({ ...r, text: xmlSafe(r.text) }));
  const first = clean.findIndex((r) => r.text.length > 0);
  if (first >= 0) clean[first] = { ...clean[first]!, text: inert(clean[first]!.text) };
  if (clean.every((r) => !r.bold && !r.italic && !r.color)) return `<is><t xml:space="preserve">${escape(clean.map((r) => r.text).join(""))}</t></is>`;
  const rPr = (r: Run) => `<rPr>${r.bold ? "<b/>" : ""}${r.italic ? "<i/>" : ""}${r.color ? `<color rgb="${r.color}"/>` : ""}<sz val="10"/><rFont val="Calibri"/></rPr>`;
  return `<is>${clean.map((r) => `<r>${rPr(r)}<t xml:space="preserve">${escape(r.text)}</t></r>`).join("")}</is>`;
}

function sheetXml(sheet: Sheet): string {
  const merges: string[] = [];
  const rows = sheet.rows
    .map((row, r) => {
      let col = 0;
      const cells = row.cells
        .map((c) => {
          const ref = `${colName(col)}${r + 1}`;
          const span = c.span ?? 1;
          if (span > 1) merges.push(`${ref}:${colName(col + span - 1)}${r + 1}`);
          col += span;
          return `<c r="${ref}" s="${STYLE_INDEX[c.style]}" t="inlineStr">${runsXml(c.runs)}</c>`;
        })
        .join("");
      const height = row.height ? ` ht="${row.height}" customHeight="1"` : "";
      return `<row r="${r + 1}"${height}>${cells}</row>`;
    })
    .join("");
  const cols = sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
  const mergeXml = merges.length ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` : "";
  return `${HEAD}<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><cols>${cols}</cols><sheetData>${rows}</sheetData>${mergeXml}</worksheet>`;
}

const align = '<alignment vertical="top" wrapText="1"/>';
const STYLES = `${HEAD}<styleSheet xmlns="${MAIN_NS}">
<fonts count="4"><font><sz val="10"/><name val="Calibri"/></font><font><b/><sz val="10"/><name val="Calibri"/></font><font><sz val="10"/><color rgb="FFFF0000"/><name val="Calibri"/></font><font><b/><sz val="10"/><color rgb="FFFF0000"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9D9D9"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right><top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">${align}</xf><xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1">${align}</xf><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${align}</xf><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1">${align}</xf></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/** A zip with deflated entries, a fixed 1980-01-01 timestamp and UTF-8 names. */
function zip(files: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const body = deflateRawSync(f.data);
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    central.push(cd, name);
    offset += 30 + name.length + body.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

/** One sheet as an .xlsx package: inline strings only, so no cell can be a formula. */
export function xlsxOf(sheet: Sheet): Buffer {
  const text = (name: string, xml: string) => ({ name, data: Buffer.from(xml, "utf8") });
  return zip([
    text("[Content_Types].xml", `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`),
    text("_rels/.rels", `${HEAD}<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    text("xl/workbook.xml", `${HEAD}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets><sheet name="${escape(sheet.name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    text("xl/_rels/workbook.xml.rels", `${HEAD}<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`),
    text("xl/styles.xml", STYLES),
    text("xl/worksheets/sheet1.xml", sheetXml(sheet)),
  ]);
}
```

Run the writer test. Expected: PASS.

- [ ] **Step 5: Check the file with a real reader (dev check, not CI)**

```bash
npx -y -p node@24 -- npx tsx -e 'import { writeFileSync } from "node:fs"; import { xlsxOf } from "./apps/calendar/src/list/xlsx.ts"; writeFileSync(process.env.TMPDIR + "/sample.xlsx", xlsxOf({ name: "Activities", widths: [10, 30], rows: [{ cells: [{ runs: [{ text: "Sample" }], style: "banner", span: 2 }] }, { cells: [{ runs: [{ text: "=1+1" }], style: "cell" }, { runs: [{ text: "Not for Look Ahead ", color: "FF8B0000" }, { text: "Sample" }], style: "cell" }] }] }));'
python3 -c 'import openpyxl, os; ws = openpyxl.load_workbook(os.environ["TMPDIR"] + "/sample.xlsx").active; print(ws["A1"].value, "|", ws["A2"].value, "|", ws["B2"].value, "|", ws.merged_cells.ranges)'
```

Expected output: `Sample | '=1+1 | Not for Look Ahead Sample | {<MergedCellRange A1:B1>}`. If `openpyxl` refuses the file, fix the writer before going on.

- [ ] **Step 6: Write the failing export and range tests**

`apps/calendar/src/http/export-routes.test.ts`:

```ts
import type { IncomingMessage } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCalendarTestDb, createTestApp } from "../../test/helpers";
import { readXlsx } from "../../test/xlsx-read";
import { insertRaw, seedWorld, type World } from "../../test/world";
import { activityCategories } from "../db/schema";
import { CONFIDENTIALITY_NOTICE, EXPORT_HEADERS } from "../list/export";

const q = (o: object) => encodeURIComponent(JSON.stringify(o));
const binary = (res: IncomingMessage, cb: (e: Error | null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

describe("the calendar range and the Excel export (spec addendum §8.1, C151)", () => {
  let tdb: TestDatabase;
  let w: World;
  let app: ReturnType<typeof createTestApp>;
  const exportAs = (who: keyof World["as"], query: object) =>
    request(app).get(`/api/list/export.xlsx?q=${q(query)}`).set("cookie", w.as[who].cookie).buffer(true).parse(binary);

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    w = await seedWorld(app, tdb.db);
  });
  afterAll(() => tdb.drop());

  async function act(start: string, end: string, row: object = {}) {
    const id = await insertRaw(tdb.db, { startAt: new Date(start), endAt: new Date(end), ...row });
    await tdb.db.insert(activityCategories).values({ activityId: id, categoryId: w.cat.plain });
    return id;
  }

  it("exports the visible rows in legacy's order, with its header cells, 16 columns and red footer, every cell inert", async () => {
    // 2046-03-10 09:00 BC is 16:00Z; BC stays at UTC−7.
    const later = await act("2046-03-11T16:00:00Z", "2046-03-11T17:00:00Z", { title: "=HYPERLINK(\"http://example.test\")" });
    const early = await act("2046-03-10T18:00:00Z", "2046-03-10T19:00:00Z", { title: "Sample early", details: "Sample <b>details</b>", strategy: "Sample strategy" });
    const morning = await act("2046-03-10T16:00:00Z", "2046-03-10T17:00:00Z", { title: "Sample morning", isConfidential: true });
    const secret = await act("2046-03-10T16:30:00Z", "2046-03-10T17:00:00Z", { title: "Sample other ministry secret", contactMinistryKey: "finance", isConfidential: true });
    const res = await exportAs("hqAdvanced", { filter: { from: "2046-03-01", to: "2046-03-31" }, sort: "title", dir: "desc" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="BCGovernmentActivities.xlsx"');
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    const { cells } = readXlsx(res.body as Buffer);
    expect(cells.get("A1")).toBe("Sample Province. Corporate Calendar DRAFT & CONFIDENTIAL");
    expect(cells.get("F1")).toBe("Date Range Selected: Mar 01, 2046 to Mar 31, 2046");
    // FIXED_NOW is 11:00 BC on Tuesday 2026-11-03.
    expect(cells.get("K1")).toBe("Printed: Tue, Nov 3 11:00 AM");
    expect(EXPORT_HEADERS.map((_, i) => cells.get(`${String.fromCharCode(65 + i)}2`))).toEqual([...EXPORT_HEADERS]);
    // HQ Advanced sees every confidential item. Order: start date, end date, start time; the list's sort is ignored.
    expect([3, 4, 5, 6].map((r) => cells.get(`A${r}`))).toEqual([morning, secret, early, later].map(String));
    expect(cells.get("E6")).toBe("'=HYPERLINK(\"http://example.test\")");
    expect(cells.get("F5")).toBe("Sample <b>details</b>");
    expect(cells.get("G5")).toBe("Sample significance\n\nStrategy: Sample strategy");
    expect(cells.get("F3")).toBe("Not for Look Ahead Sample details");
    expect(cells.get("A7")).toBe(CONFIDENTIALITY_NOTICE);
  });

  it("an HQ Editor's export leaves out what the list leaves out", async () => {
    await act("2047-01-10T17:00:00Z", "2047-01-10T18:00:00Z", { title: "Sample open" });
    await act("2047-01-10T17:00:00Z", "2047-01-10T18:00:00Z", { title: "Sample secret", contactMinistryKey: "finance", isConfidential: true });
    const { cells } = readXlsx((await exportAs("hqEditor", { filter: { from: "2047-01-01", to: "2047-01-31" } })).body as Buffer);
    const titles = [...cells.entries()].filter(([ref]) => /^E\d+$/.test(ref) && ref !== "E2").map(([, v]) => v);
    expect(titles).toEqual(["Sample open"]);
  });

  it("refuses more than 10,000 rows with 422, a corporate query below HQ Advanced with 403, and a bad q with 400", async () => {
    await tdb.db.execute(sql`INSERT INTO activities (title, start_at, end_at, contact_ministry_key) SELECT 'Sample bulk ' || g, timestamptz '2048-01-01 17:00Z' + g * interval '1 minute', timestamptz '2048-01-01 18:00Z' + g * interval '1 minute', 'health' FROM generate_series(1, 10001) g`);
    const big = await exportAs("hqAdmin", { filter: { from: "2048-01-01", to: "2048-12-31" } });
    expect(big.status).toBe(422);
    expect(JSON.parse((big.body as Buffer).toString("utf8")).error).toMatch(/10,000/);
    expect((await exportAs("hqEditor", { corporate: { days: 8, statuses: ["new"] } })).status).toBe(403);
    expect((await request(app).get("/api/list/export.xlsx?q=nope").set("cookie", w.as.editor.cookie)).status).toBe(400);
  });

  it("the calendar range: the query's activities overlapping at most 42 days, 1,000 at most", async () => {
    const inside = await act("2049-02-10T17:00:00Z", "2049-02-10T18:00:00Z", { title: "Sample inside" });
    const spanning = await act("2049-01-30T17:00:00Z", "2049-02-02T18:00:00Z", { title: "Sample spanning" });
    await act("2049-03-20T17:00:00Z", "2049-03-20T18:00:00Z", { title: "Sample outside" });
    const range = (query: object, start: string, end: string) => request(app).get(`/api/list/calendar?q=${q(query)}&start=${start}&end=${end}`).set("cookie", w.as.editor.cookie);
    const res = await range({ filter: { quickSearch: "Sample" } }, "2049-02-01", "2049-03-14");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      truncated: false,
      items: [
        { id: spanning, title: "Sample spanning", startAt: "2049-01-30T17:00:00.000Z", endAt: "2049-02-02T18:00:00.000Z", isAllDay: false, isConfirmed: true, isConfidential: false, ministryAbbreviation: "HLTH" },
        { id: inside, title: "Sample inside", startAt: "2049-02-10T17:00:00.000Z", endAt: "2049-02-10T18:00:00.000Z", isAllDay: false, isConfirmed: true, isConfidential: false, ministryAbbreviation: "HLTH" },
      ],
    });
    expect((await range({}, "2049-02-01", "2049-03-15")).status).toBe(400);
    expect((await range({}, "2049-02-02", "2049-02-01")).status).toBe(400);
    expect((await range({}, "2049-02-30", "2049-03-01")).status).toBe(400);
    await tdb.db.execute(sql`INSERT INTO activities (title, start_at, end_at, contact_ministry_key) SELECT 'Sample busy ' || g, timestamptz '2050-01-05 17:00Z' + g * interval '1 minute', timestamptz '2050-01-05 18:00Z' + g * interval '1 minute', 'health' FROM generate_series(1, 1001) g`);
    const busy = await range({}, "2050-01-01", "2050-01-31");
    expect(busy.body.items).toHaveLength(1000);
    expect(busy.body.truncated).toBe(true);
  });
});
```

`insertRaw` stores `isConfirmed: true` unless told otherwise (`test/world.ts`). The bulk inserts use the table's own defaults, which these tests don't assert on.

- [ ] **Step 7: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/http/export-routes.test.ts`
Expected: FAIL (404s).

- [ ] **Step 8: Write `calendar-range.ts` and `export.ts`**

`apps/calendar/src/list/calendar-range.ts`:

```ts
import { and, asc, eq, sql } from "drizzle-orm";
import type { CalendarRangeView, ListQuery } from "@gcpe/calendar-contract";
import type { CalendarActor } from "../actor";
import { inReadSnapshot } from "../activities/store";
import { activities, orgs } from "../db/schema";
import type { ApiDeps } from "../http/routes";
import { addDays, bcMidnight } from "../time";
import { listWhere, scopeOf } from "./query";

export const CALENDAR_ITEM_LIMIT = 1000;

/** The month or week view (spec addendum §8.1): the query's filters, the view's dates. */
export function calendarRange(deps: ApiDeps, actor: CalendarActor, q: ListQuery, start: string, end: string): Promise<CalendarRangeView> {
  return inReadSnapshot(deps.db, async (tx) => {
    const scope = await scopeOf(tx, deps, actor);
    const tz = deps.rules.timeZone;
    const inView: ListQuery = { ...q, filter: { ...q.filter, from: start, to: end, thisDayOnly: false } };
    const where = and(
      listWhere(scope, inView),
      // Also for a corporate query or an id search, which don't read the filter's dates.
      sql`coalesce(${activities.endAt}, ${activities.startAt}) >= ${bcMidnight(start, tz)}`,
      sql`coalesce(${activities.startAt}, ${activities.endAt}) < ${bcMidnight(addDays(end, 1), tz)}`,
    );
    const rows = await tx
      .select({
        id: activities.id, title: activities.title, startAt: activities.startAt, endAt: activities.endAt, isAllDay: activities.isAllDay,
        isConfirmed: activities.isConfirmed, isConfidential: activities.isConfidential, ministryAbbreviation: orgs.abbreviation,
      })
      .from(activities)
      .leftJoin(orgs, eq(orgs.key, activities.contactMinistryKey))
      .where(where)
      .orderBy(asc(activities.startAt), asc(activities.id))
      .limit(CALENDAR_ITEM_LIMIT + 1);
    return {
      truncated: rows.length > CALENDAR_ITEM_LIMIT,
      items: rows.slice(0, CALENDAR_ITEM_LIMIT).map((r) => ({ ...r, startAt: r.startAt?.toISOString() ?? null, endAt: r.endAt?.toISOString() ?? null })),
    };
  });
}
```

`apps/calendar/src/list/export.ts`:

```ts
import { asc, sql } from "drizzle-orm";
import { friendlyDateRange, type ListQuery, type ListRow } from "@gcpe/calendar-contract";
import type { CalendarActor } from "../actor";
import { inReadSnapshot } from "../activities/store";
import { activities } from "../db/schema";
import type { ApiDeps } from "../http/routes";
import { dbNow } from "../time";
import { listWhere, scopeOf, type ListScope } from "./query";
import { rowsOf } from "./rows";
import { xlsxOf, type Run, type Sheet, type SheetCell } from "./xlsx";

export const EXPORT_ROW_LIMIT = 10_000;
export class ExportTooLargeError extends Error {
  override name = "ExportTooLargeError";
  constructor() {
    super("More than 10,000 activities match: narrow the filter and export again");
  }
}

/** Legacy's 16 columns (ActivityHandler.ashx.cs:496-511). */
export const EXPORT_HEADERS = [
  "ID", "Ministry", "Categories", "Date & Time", "Title", "Summary", "Significance and Strategy", "Event Planner", "Scheduling Notes",
  "Comm. Materials", "Lead Org", "Comm. Contact", "Govt Rep.", "City", "Tags", "Premier Requested",
] as const;
const WIDTHS = [8, 10, 16, 20, 24, 48, 36, 16, 24, 18, 16, 20, 14, 16, 16, 14];
/** Legacy's footer (ActivityHandler.ashx.cs:513). */
export const CONFIDENTIALITY_NOTICE =
  "CONFIDENTIALITY NOTICE:  This information, including any attachments, is confidential.  It is intended only for the use of the person or persons to whom it is addressed or shared with, unless I have expressly authorized otherwise.  If you have received this data extract in error, please discard the document, including any related information or attachments, and notify the Corporate Calendar Administrator immediately by email or telephone.";
const DARK_RED = "FF8B0000";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const plain = (text: string): SheetCell => ({ runs: [{ text }], style: "cell" });
const bold = (text: string): SheetCell => ({ runs: [{ text }], style: "boldCell" });
/** Legacy's "MMM dd, yyyy" (ActivityHandler.ashx.cs:528-541). */
const headingDate = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(8, 10)}, ${d.slice(0, 4)}`;

function dateRangeHeading(q: ListQuery, today: string): string {
  const from = q.corporate ? today : (q.filter.from ?? today);
  const to = q.corporate ? null : q.filter.thisDayOnly ? from : q.filter.to;
  return `Date Range Selected: ${headingDate(from)}${to ? ` to ${headingDate(to)}` : " date-forward"}`;
}

/** Legacy's "ddd, MMM d h:mm tt", in BC time. */
function printed(now: Date, timeZone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  return `Printed: ${p.weekday}, ${p.month} ${p.day} ${p.hour}:${p.minute} ${p.dayPeriod}`;
}

function rowCells(r: ListRow, scope: ListScope): SheetCell[] {
  const summary: Run[] = r.isConfidential ? [{ text: "Not for Look Ahead ", color: DARK_RED }, { text: r.details }] : [{ text: r.details }];
  const significance: Run[] = r.strategy ? [{ text: r.significance }, { text: "\n\nStrategy: ", italic: true }, { text: r.strategy }] : [{ text: r.significance }];
  return [
    plain(String(r.id)),
    bold(r.ministryAbbreviation ?? ""),
    bold([...(r.isIssue ? ["Issue"] : []), ...r.categories].join(", ")),
    plain(friendlyDateRange(r, { timeZone: scope.rules.timeZone, today: scope.today, weekday: true })),
    bold(r.title),
    { runs: summary, style: "cell" },
    { runs: significance, style: "cell" },
    plain(r.eventPlanner ?? ""),
    plain(r.schedule),
    plain(r.commMaterials.join(", ")),
    plain(r.leadOrganization),
    plain(r.commContact ? [r.commContact.name, r.commContact.phone].filter(Boolean).join("\n") : ""),
    plain(r.governmentRepresentative ?? ""),
    plain([r.city ?? "", r.venue].filter(Boolean).join("\n")),
    plain(r.keywords.join(", ")),
    plain(r.premierRequested ?? ""),
  ];
}

export function exportSheet(rows: ListRow[], q: ListQuery, scope: ListScope, now: Date): Sheet {
  const banner = scope.rules.reportBanner.province;
  return {
    name: "Activities",
    widths: WIDTHS,
    rows: [
      {
        cells: [
          { runs: [{ text: `${banner}. Corporate Calendar DRAFT & CONFIDENTIAL` }], style: "banner", span: 5 },
          { runs: [{ text: dateRangeHeading(q, scope.today) }], style: "heading", span: 5 },
          { runs: [{ text: printed(now, scope.rules.timeZone) }], style: "heading", span: 4 },
        ],
      },
      { cells: EXPORT_HEADERS.map((h) => ({ runs: [{ text: h }], style: "header" as const })) },
      ...rows.map((r) => ({ cells: rowCells(r, scope) })),
      { cells: [{ runs: [{ text: CONFIDENTIALITY_NOTICE }], style: "notice", span: 10 }], height: 60 },
    ],
  };
}

/** The Excel export (spec addendum §8.1, C151): the list's visible rows, in legacy's order, as an .xlsx. */
export function exportWorkbook(deps: ApiDeps, actor: CalendarActor, q: ListQuery): Promise<Buffer> {
  return inReadSnapshot(deps.db, async (tx) => {
    const scope = await scopeOf(tx, deps, actor);
    const tz = deps.rules.timeZone;
    // Legacy orders by start date, end date, then start time (ActivityHandler.ashx.cs:46-48), whatever the list's sort.
    const ids = (
      await tx
        .select({ id: activities.id })
        .from(activities)
        .where(listWhere(scope, q))
        .orderBy(
          sql`(${activities.startAt} AT TIME ZONE ${tz})::date ASC NULLS LAST`,
          sql`(${activities.endAt} AT TIME ZONE ${tz})::date ASC NULLS LAST`,
          sql`to_char(${activities.startAt} AT TIME ZONE ${tz}, 'HH24:MI') ASC NULLS LAST`,
          asc(activities.id),
        )
        .limit(EXPORT_ROW_LIMIT + 1)
    ).map((r) => r.id);
    if (ids.length > EXPORT_ROW_LIMIT) throw new ExportTooLargeError();
    return xlsxOf(exportSheet(await rowsOf(tx, scope, ids), q, scope, await dbNow(tx, deps.now)));
  });
}
```

- [ ] **Step 9: The routes**

In `apps/calendar/src/http/list-routes.ts`, add (imports: `bcDateSchema`, `checkCalendarRange` from the contract; `calendarRange`; `exportWorkbook`; `XLSX_CONTENT_TYPE`):

```ts
const rangeParams = z
  .object({ q: listQueryParam, start: bcDateSchema, end: bcDateSchema })
  .strict()
  .superRefine((p, ctx) => {
    const problem = checkCalendarRange(p.start, p.end);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem, path: ["end"] });
  });
const exportParams = z.object({ q: listQueryParam }).strict();
```

and inside `listRoutes`:

```ts
  r.get("/list/calendar", runList(async (req, res) => {
    const p = rangeParams.parse(req.query);
    res.json(await calendarRange(deps, req.calendar!, p.q, p.start, p.end));
  }));
  r.get("/list/export.xlsx", runList(async (req, res) => {
    const body = await exportWorkbook(deps, req.calendar!, exportParams.parse(req.query).q);
    res.set({
      "Content-Type": XLSX_CONTENT_TYPE,
      "Content-Disposition": 'attachment; filename="BCGovernmentActivities.xlsx"',
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    });
    res.send(body);
  }));
```

In `apps/calendar/src/http/list-errors.ts`, add before the fallback: `if (e instanceof ExportTooLargeError) return void res.status(422).json({ error: e.message }), true;`.

- [ ] **Step 10: Run the tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/list apps/calendar/src/http/export-routes.test.ts apps/calendar/src/http/list-routes.test.ts`
Expected: PASS. Then repeat Step 5's `openpyxl` check on a real export: save a response body from the first export test to `$TMPDIR/export.xlsx` once (a temporary `writeFileSync` you delete afterwards) and load it with `openpyxl`; `ws.max_column` is 16 and `ws["A1"].value` is the banner.

- [ ] **Step 11: Final verification**

Run, under Node 24:
- the whole Vitest suite: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run`;
- both `tsc` commands.

Then:
- `git diff feat/phase-5c -- apps packages | grep -oE "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+" | sort -u` shows only `example.test` or `x.invalid` addresses.
- `git diff feat/phase-5c -- apps packages scripts tests | grep -nE "Task [0-9]|\bD[0-9]+\b|fix round"` prints nothing.
- `git diff feat/phase-5c -- apps/calendar/src | grep -n "console\.\(log\|debug\)"` prints nothing.

- [ ] **Step 12: Commit**

```bash
git add apps/calendar
git commit -m "feat(calendar): the calendar range and the Excel export as a real .xlsx: visible rows only, legacy's header, columns and footer, every cell inert (C151)"
```

---

## Risks and things to watch

- **The Excel file's validity rests on a hand-written package.** *Verified* only by `openpyxl` in Task 9 Steps 5 and 10; Excel itself is checked by hand in 5d-2's boxs.ca step. If Excel repairs the file, the likely culprits are the styles part's element order or a merged range; `openpyxl` is more forgiving than Excel.
- **Hydration cost on the export.** 10,000 rows hydrate in ten batches of eight queries each. *Assumed* to stay within an HTTP timeout (the list's 30-row page is measured; the 10,000-row export isn't). Task 9's 10,001-row test only checks the refusal. If it proves slow on boxs.ca, lower `EXPORT_ROW_LIMIT`.
- **`count(*) OVER ()` reads every matching row.** *Verified* on the probe at 232 ms for the widest HQ sort; Task 5 measures it through the service. A future index-only "has more" check could replace the exact total if growth outpaces §13.
- **`notInArray` with an empty list.** `defaultHides` skips the clause when there are no consultations keys, so drizzle never renders `NOT IN ()`. *Inferred* from the guard; Task 3's default-hide test runs with a key present.
- **The All Day carry-forward item is read, not quoted.** The note says "isolate the All-Day status-only row in its own test"; Task 1 reads it as the §7.3 row "All Day → no flag, status Changed" on an imported activity whose times don't move. If the author meant something else, the new test still pins true behaviour and costs nothing.

## Self-review (done while writing)

- **Spec coverage (5d, server half):**
  - **§8.1 Filters:** dates with the 2011 clamp and This day only (Task 3), quick search by text and id (Task 3), HQ Tags OR, Issue, Date Confirmed with the timed single-day quirk, Status, Category, Lead Ministry, Comm Contact, Representative, Initiative, Premier Requested, Distribution (Task 3), the default hides (Task 3).
  - **§8.1 Display:** the four modes (Task 3), saved per user (Task 6).
  - **§8.1 Columns:** every column's data (Task 4), legacy's default hidden set and saved choices (Tasks 2, 6).
  - **§8.1 Sorting and loading:** every sortable column with start as the secondary sort, 30 a page, visibility in SQL (Task 3).
  - **§8.1 Saved filters:** save, apply (the filter round-trips into `GET /api/list`), rename, reorder, delete, owner only (Task 7); legacy conversion with a report (Task 8).
  - **§8.1 Watchlist** and its tooltip names (Tasks 4, 6). **Calendar view** data (Task 9). **Corporate queries** and the **Look Ahead admin filter** (Task 3). **Toolbar:** Review selected and Clear LA Status exist since 5c-1; their screen is 5d-2; the reports are 5g. **Excel export** (Task 9).
  - **§6:** `visibleSql` in every reader (Tasks 3, 4, 9); corporate queries and the Look Ahead filter at HQ Advanced (Task 3); list markup at HQ Administrator (Task 4); saved filters owner only (Task 7); favourites and the export for any role, limited by `visible()` (Tasks 6, 9); bearer tokens refused (Task 4).
  - **§7.4:** favourites, saved filters and preferences not frozen (Tasks 6, 7).
  - **§3 row 5d exit:** the saved-filter fixture migrates with a report (Task 8); the list under 500 ms on 50,000 activities (Task 5). Axe on every state and the per-role visibility e2e are 5d-2's.
  - **§13:** the fixture's shape (Task 5). **§16:** the saved-filter converter unit test (Task 8).
  - **Carry-forward:** every § 5d item (Task 1 and the table above).
- **Placeholders:** none. Two steps describe an edit by rule and say exactly what changes: Task 2 Step 3 (exporting two existing schemas) and Task 2 Step 5's `LIST_DISPLAYS` move into the contract.
- **Type consistency:**
  - `ListScope`, `scopeOf`, `listWhere`, `listIds` (Task 3) are what `rowsOf`, `listPage` (Task 4), `calendarRange` and `exportWorkbook` (Task 9) call.
  - `listQueryParam` and `runList` (Task 4) are reused by Tasks 6, 7 and 9; `sendListError` gains Task 7's and Task 9's classes.
  - `ListRow` (Task 2) is what `rowsOf` returns and `exportSheet` reads (`strategy`, `schedule`, `eventPlanner`, `potentialDates` included).
  - `SavedFilterView`, `ListPreferences`, `CalendarRangeView` match between the contract and the services.
- **Review Focus:** each line names the test that pins it, and each test is in its task's code: Task 3 (1, 3), Task 4 (2), Task 9 (4), Task 7 (5).
