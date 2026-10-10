# Phase 5f: The Corporate Calendar's Updates Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff open Calendar → Updates and see who changed which activity and when: today's updates by default, the latest five, a date range narrowed by kind of update and by words, or one activity's updates. Every entry is limited to activities the user can see now, under the one visibility rule. No entry carries an email, a Look Ahead value or any field value. Each entry links to the activity, and Save or Cancel there comes back to the feed.

**Architecture:**
- **One reader over history.** `readFeed` (`apps/calendar/src/feed.ts`) selects `activity_changes` rows with source `calendar` and one of five actions. It joins `activities` and filters with `visibleSql` inside `inReadSnapshot`, newest first, capped at 1,000. Each item's activity facts (title, summary, dates, ministry, deleted) are the activity's **current** values. The actor's name is the one stored at the time. No field values are read.
- **The Look Ahead rule is View changes' rule.** An `updated` entry that recorded only Look Ahead fields is dropped for a viewer who doesn't see that fieldset on the activity. The SQL form of that rule already exists as `executiveSummaryShown` (`apps/calendar/src/list/query.ts`).
- **One route.** `GET /calendar/api/updates?mode=latest|today|range|activity…` takes a strict, mode-discriminated query (`feedQuerySchema` in `@gcpe/calendar-contract`). Errors go through `runList`, so a bad value is 400, an activity the user can't see is 404, and nothing is a 500.
- **One screen.** `/hub/calendar/updates` (`UpdatesScreen`) gets an "Updates" tab in the Calendar section's tab row. Two quick views and legacy's "Filter by date range" form sit above the result. The view is kept in the address. Each entry's `MIN-Id` link is the list's own `TitleLink`, so the editor returns to the feed (C149).

**Tech Stack:** Node 24, Express 5, Drizzle on Postgres, zod, React 19, react-router 7, `@bcgov/design-system-react-components`, Vitest 4.1 (supertest; jsdom with Testing Library and axe-core), Playwright 1.63 with `@axe-core/playwright`.

**Spec:** `docs/superpowers/specs/2026-10-07-calendar-parity-design.md`:
- §3 row 5f. Exit check: "Feed visibility tests for each role, including confidential and deleted items. Each mode returns the expected items from a fixture."
- §6: one visibility rule; not visible is 404; the updates feed is one of the readers; the Look Ahead fieldset's rule.
- §5.2 (`activity_changes`, `activity_change_fields`) and §7.1 (which actions write history).
- §8.3: View changes, whose Look Ahead filtering the feed matches.
- §9.1: the updates feed.
- §14: C127, C135, C149. §16: acceptance 2 (the feed part), 9 and 18. §17: no "since last visit".

The plan also takes these into account:
- `docs/superpowers/plans/phase-5-carry-forward.md` § 5f, which is binding. Task 4 takes its one item, and Task 5 deletes the section.
- The 5e plans (`2026-10-09-phase-5e-activity-editor.md`, `2026-10-09-phase-5e2-activity-editor-screen.md`) for house style. Their decisions E1–E26 hold. This plan adds F1–F13.
- Legacy:
  - `Calendar/History.aspx` and `Calendar/CorporateCalendarUpdateWebService.asmx.cs`.
  - The stored procedures `GetCorpCalendarUpdates`, `GetCorpCalendarUpdatesToday` and `GetCorpCalendarUpdatesBetweenDates` (`Gcpe.Hub.Database/calendar/Stored Procedures`).
  - The `NewsFeed` writers: `Activity.aspx.cs:1051,1450,1469,1553,1567,1594-1625` and `ActivityHandler.ashx.cs:231-253,299-321`.

**Order:** Tasks 1–5 in order. Task 2 needs Task 1, and Task 3 extends Task 2's reader. Task 4 needs Task 1's types and Task 2's route. Task 5 needs all of them.

**Base:**
- **Branch:** `feat/phase-5f` in `/Users/paul/gcpe-news-platform-p5f`, from `main` at `9e3dc5b` (5a–5e merged). Every path is repo-relative.
- **Parallel work:** a usability pass on `fix/staff-usability` (worktree `/Users/paul/gcpe-news-platform-p5e`) is landing in parallel. It moves sign-in into the header, turns section sub-menus into a tab row, and gives form controls and checkbox grids one shared size. This plan touches two of its files: `CalendarSection.tsx` gets one `<li>`, and `styles/global.css` gets a few appended rules. Whichever branch merges second resolves the conflict by keeping both.
- **Facts this plan relies on (verified by reading the code at `9e3dc5b`):**
  - **History:**
    - `activity_changes` (`apps/calendar/src/db/schema.ts`) has `id`, `activity_id`, `at`, `actor_id` (nullable), `actor_name`, `action`, `source` and `contact_ministry_key`.
    - Its indexes are `(activity_id, at)` and `(at)`.
    - `activity_change_fields` is keyed `(change_id, field_key)`.
    - `CHANGE_ACTIONS` is `created | updated | cloned | reviewed | deleted | transferred | la_status_cleared`, and `CHANGE_SOURCES` is `calendar | legacy_log` (`packages/calendar-contract/src/enums.ts`).
    - **No migration is needed.**
  - **Who writes history:**
    - create writes `created`; update writes `updated`, only when a field changed; clone writes `cloned` on the **new** activity, with `cloned_from`; delete writes `deleted`.
    - Review and Review selected write `reviewed` (`applyReview`).
    - Clear LA Status writes `la_status_cleared` (`bulk.ts`), and Transfer writes `transferred` (`transfer.ts`).
    - Adding or removing a file writes `updated` with the `files` key (`activities/files.ts`).
    - Writes take `at` from `dbNow(tx, deps.now)`, so every write in a Vitest app is at `FIXED_NOW`.
  - **Visibility and the Look Ahead fieldset:**
    - `visibleSql(u)` (`apps/calendar/src/visibility.ts`) is a predicate over the unaliased `activities` table.
    - `readChanges` (`apps/calendar/src/activities/view.ts`) hides `LOOK_AHEAD_HISTORY_FIELDS` from a viewer without the fieldset, and drops an `updated`/`la_status_cleared` entry left with no fields.
    - `executiveSummaryShown(scope)` (`list/query.ts`) is `can.seeLookAheadFieldset` as SQL: `true` for HQ at Editor and above, `null` for nobody, otherwise a predicate (not deleted, own contact ministry).
  - **List helpers this plan reuses** (all in `apps/calendar/src/list/query.ts`):
    - `scopeOf(db, deps, actor)` returns `{ actor, rules, today, consultationsKeys }`, with `today` the BC date by `dbNow`.
    - `idSearchOf(term)` returns the id for "ABBR-123" at any size, or for a bare number above `ID_SEARCH_FLOOR` (10,000, **not exported**).
    - `containsPattern(term)` escapes `\`, `%` and `_` for `ILIKE`.
  - `bcMidnight(date, tz)` and `addDays(date, n)` are in `apps/calendar/src/time.ts`.
  - **Routes and errors:**
    - `runList` (`http/list-errors.ts`) maps `ZodError` to 400 `{ error: "invalid request", issues }` and `ActivityNotFoundError` to 404 `{ error: "not found" }`.
    - `apiRoutes` (`http/routes.ts`) mounts each router. Express 5's query parser gives an array for a repeated key.
  - **Vitest helpers:**
    - `createTestApp`, `TEST_RULES` (`showHqCommentsField: false`) and `FIXED_NOW` (2026-11-03 11:00 BC) are in `apps/calendar/test/helpers.ts`.
    - `seedWorld` (organizations health/finance/gcpe-hq, nine people), `insertRaw` (takes an explicit `id`) and `call` are in `test/world.ts`.
    - The people's names include "Robin Staff" (editor), "Kim Finance" (financeEditor) and "Sample HQ Admin".
  - **BC time:** BC is UTC−7 from 2026-11-01 on (permanent). It is UTC−8 in January 2026.
  - **Staff app:**
    - `CalendarSection` renders `<nav aria-label="Calendar sections"><ul>…NavLink…</ul></nav>` (the usability branch adds `className="gcpe-section-tabs"` to it).
    - `router.tsx` lists the Calendar's children under `path: "calendar"`.
    - `TitleLink({ id })` (`screens/calendar/list/cells.tsx`) links to `activityPath(id, here.pathname + here.search)`, which carries `?return=`.
    - `minIdOf({ id, ministryAbbreviation })` is in `activity/form.ts`.
    - `dateTimeText`, `todayIn`, `addDaysTo` and `isValidBcDate` are in `list/dates.ts`. `friendlyDateRange` is in `@gcpe/calendar-contract`.
    - `listApi.config()` returns `{ timeZone, … }`.
    - The list's `FilterPanel` uses `form.gcpe-calendar-filter`, `div.gcpe-field`, `p.gcpe-hint`, `<p role="alert">` and the message "From must be on or before To.".
    - `stubFetch`, `never`, `Call` and `ME` are in `list/fixtures.tsx`, and `jsonResponse` is in `apps/staff-web/test/jsonResponse.ts`.
    - `.gcpe-changes` (`styles/global.css`) styles View changes' list.
  - **E2E:**
    - `listFixture()` (`tests/e2e/calendar-support.ts`) builds six activities titled "Vis <key> <tag>", each created by "Test Calendar HQ Administrator": A Health; B Health confidential; C Finance; D Finance confidential; E Finance confidential shared with Health; F Health, deleted after creation.
    - The seeded users and their ministries: cal-editor Health Editor, cal-readonly Finance Read Only, cal-hq-editor HQ Editor, cal-hq-admin HQ Administrator.
    - Abbreviations: Health is `HLTH`, Finance is `FIN`.
    - The editor's Cancel goes to `return`.
    - `workers: 1`.
  - **Legacy (read for this plan):**
    - **Modes:**
      - Latest 5 is `TOP 5 … ORDER BY CreatedDateTime DESC`.
      - Today is `datediff(day, CreatedDateTime, getdate()) = 0`, the web server's day.
      - The range is inclusive days on both ends, either optional, with an exact `Description` match for the type. It is capped at 1,000. Today and per-activity are uncapped.
      - All are scoped by ministry and shared-with only: no confidential filter and no deleted filter. HQ ("app owners") get everything.
    - **The keyword:**
      - Every match is loaded into memory, then filtered with `Text.ToLower().Contains(keyword)`.
      - `Text` is the stored HTML: the actor's name and `mailto` email, the verb, the ministry abbreviation and id, the time and date, and the title as a `title` attribute.
      - The comment "Search Id, Title, Details, City" is wrong: details and city are not in `Text`.
      - A keyword whose part after the last `-` is a number above 10,000 calls `GetUpdatesForActivity`, with no visibility check.
    - **Kinds of entry:** add, change, review, delete and clone. Clone's entry is on the new activity, worded "added new clone". There is none for Transfer or Clear LA Status.
    - **The page (`History.aspx`):**
      - It opens on Today's updates, or on one activity's updates with `?ActivityID=`.
      - From defaults to yesterday.
      - The Update type list is All, Changed, Added, Deleted, Reviewed, Cloned.
      - The result says "Total N items".
      - The menu link is "Recent Activity/Updates" (`Site.Master:41`).

---

## Decisions made in planning

Each says why and what it costs if wrong. Task 5 writes the parity rows and the questions.

- **F1. The feed shows five kinds of entry: `created`, `updated`, `reviewed`, `deleted`, `cloned`.** They are legacy's add, change, review, delete and clone. It does not show `transferred` or `la_status_cleared`. It shows only source `calendar`, so imported legacy log entries never appear and the feed starts empty at cutover (C135).
  - *Why:* legacy wrote no feed entry for Transfer or Clear LA Status. One Clear LA Status click writes an entry per activity and would bury everything else.
  - *Cost if wrong:* those actions are still on each activity's View changes; adding them is one array entry. Q60.
- **F2. Visibility is the activity's current state, through `visibleSql` on the joined `activities` row.**
  - An activity made confidential, moved to another ministry, unshared or deleted takes its older entries with it.
  - A deleted activity's entries, its deletion included, show only to HQ Administrators. Legacy showed the deletion to the owning ministry.
  - *Why:* R2 (one rule for every reader), and §6 makes deleted activities HQ Administrators' to review.
  - *Cost if wrong:* a ministry no longer sees in the feed that its activity was deleted; the activity leaves its list either way. C181, Q61.
- **F3. An `updated` entry that recorded only Look Ahead fields is left out for a viewer who doesn't see the Look Ahead fieldset on that activity.** This is the rule View changes already applies (`readChanges`). It reuses `executiveSummaryShown` as the SQL form of `can.seeLookAheadFieldset`.
  - *Why:* otherwise "changed activity" would tell a ministry that HQ touched its Executive Summary or LA status.
  - *Cost if wrong:* one fewer line for ministry users.
- **F4. Items carry no field values at all**, so no history text (Look Ahead or otherwise) can leak through the feed.
  - An item holds the change's id, time, action and actor name, plus the activity's id, current ministry abbreviation, current title, current summary, dates and deleted flag.
  - Legacy's stored text held the title and ministry as they were at the time. Here they are the current ones.
  - *Why:* one source of truth, and the visible-now rule already gates the row.
  - *Cost if wrong:* an entry made before a title change shows the new title; the old one is on View changes. C182.
- **F5. The keyword matches the activity's current title and summary, and the name of who made the change.** The match is case-insensitive and literal (`containsPattern`). It runs in SQL inside `visibleSql`.
  - The spec says "title and details". Legacy actually matched the stored text, which held the actor's name and the title but not the details. Both are kept.
  - *Cost if wrong:* a search for a person's name also finds titles containing it, and the reverse. C183.
- **F6. A keyword naming an activity number above 10,000 switches to that activity's feed and ignores the dates and type**, as legacy did.
  - The number may be bare or follow "ABBR-". This is `idSearchOf` plus the 10,000 floor, so "COVID-19" and "2026" stay words.
  - The list's own quick search treats "ABBR-123" as an id at any size (C173). The feed keeps legacy's floor because its keyword box is mostly used for words.
  - An activity the user can't see, or one that doesn't exist, is the same 404 "not found". `ID_SEARCH_FLOOR` gets exported for this.
  - *Cost if wrong:* on boxs.ca, where new ids are small, an id search needs `?mode=activity&activity=<id>`. Production ids are legacy-sized.
- **F7. Days are BC calendar days of the entry's time, in the tenant's zone.**
  - From and To are both included, and either may be blank. From after To is 400 on the server and a message in the browser.
  - "Today" is the BC date by the database's clock (`scopeOf`).
  - Legacy used the web server's local day.
- **F8. Every mode answers at most 1,000 entries, newest first by time then id. `truncated` says when there were more. Latest 5 is five.**
  - Legacy capped only the date range. The spec caps every request.
  - There is no paging, as legacy had none.
- **F9. API: `GET /calendar/api/updates`.**
  - `mode` is required and is one of `latest`, `today`, `range` (`from`, `to`, `type`, `keyword`) or `activity` (`activity`).
  - Each mode refuses any other parameter.
  - `keyword` is at most 200 characters with no NUL. `activity` is 1–9 digits and positive. Dates are `bcDateSchema`.
  - The answer is `{ mode, activityId, items, truncated }`. Its `mode` is `"activity"` when a keyword switched it.
- **F10. The screen is `/hub/calendar/updates`, with an "Updates" tab for every Calendar user** after "Calendar" in the Calendar section's tab row.
  - It opens on Today's updates, as legacy's page did.
  - "Latest 5 updates" and "Today's updates" are links above legacy's "Filter by date range" form: From (defaults to yesterday, BC), To, Update type (legacy's list and order), Search for.
  - The view lives in the address (`?mode=…`). One activity's updates open with `?mode=activity&activity=<id>`.
  - It follows the Calendar section's tab row and the shared form styles in `global.css`, using the same field markup as the list's filter panel.
  - *Cost if wrong:* a label or two.
- **F11. Each entry reads:** "<time> — <actor> <legacy verb> <MIN-Id link>: <title> (<dates>)".
  - The verbs are legacy's: "added activity", "changed activity", "reviewed activity", "deleted activity", "added new clone".
  - The dates are `friendlyDateRange`, as on the list.
  - The summary is the title's tooltip, as legacy's was and as the list shows significance.
  - A deleted activity is marked "(deleted)".
  - The link is the list's `TitleLink`, so `?return=` brings Save and Cancel back to this exact feed address (carry-forward, C149).
- **F12. No "since last visit" and no export.** Legacy had neither (§17).
- **F13. Nothing in the editor links to one activity's feed.** View changes already shows that activity's history with field values. The per-activity feed is reached from the keyword box or the address, as legacy's was from `?ActivityID=`.

## Carry-forward items taken

From `docs/superpowers/plans/phase-5-carry-forward.md` § 5f. Task 5 deletes the section.

| Item | Where |
|---|---|
| The feed's `MIN-Id` links open the activity page at `/hub/calendar/activities/:id`, with `?return=` set to the feed's own address (`activityPath`), so Save comes back to the feed (C149) | Task 4 (`TitleLink` in each entry; test "opens on Today's updates…" checks the `href`), Task 5 (e2e "an entry's link opens the activity, and Cancel comes back") |

## Global Constraints

- **Worktree and commits:**
  - Work on `feat/phase-5f` in `/Users/paul/gcpe-news-platform-p5f`. Commit locally after each task, with a plain message.
  - **Never add `Co-Authored-By` or any AI attribution** to a commit. Never commit `CLAUDE.md`.
  - **No task, decision or round labels in code comments** ("Task 3", "F4", "fix round 1"). Spec row ids (C181, Q60) and legacy file references are fine.
- **Node 24 for everything:**
  - Tests: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run <paths>`.
  - Type-checks: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json` and `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p apps/staff-web/tsconfig.json`.
  - E2E: `npx -y -p node@24 -- npm run test:e2e` (a single spec: append `-- tests/e2e/<file>`).
  - Run `npm ci` first if `node_modules` is missing.
- **Every behaviour change starts with a real RED run:** run the new test, see it fail for the stated reason, then implement.
- **Core keys are byte-exact; user ids are canonical.**
- **Bearer tokens get no Calendar access.** The new route sits behind `requireBearer` and `requireCalendarActor`, as every `/api` route does.
- **Reads use `visibleSql` inside `inReadSnapshot`.** The feed never loads rows and filters them in memory. Not visible is 404, never 403.
- **The feed never leaks what a role can't see**, including through history text:
  - no entry of a confidential activity outside the viewer's reach;
  - no entry of a deleted activity below HQ Administrator;
  - no `updated` entry that records only Look Ahead fields for a viewer without that fieldset;
  - no field value of any kind;
  - no email.
- **No input produces a 500.** Every string is bounded and passes through `safeString`, ids are 1–9 digits (int4), class 22 is 400 and class 23 is 409 (`sendActivityError`).
- **Logs:** `safeErrorLabel` plus the route only; no debug logging. The query string, which carries the keyword, is never logged.
- **Privacy:** `example.test` addresses, fictional GUIDs and fictional names only. No legacy data is copied.
- **Migrations:** drizzle-kit only. This plan adds none.
- **Staff-web patterns:**
  - Calls go through `apiFetch` with same-origin paths, and load failures show a danger `InlineAlert`.
  - `useDocumentTitle` takes the `h1` text.
  - Messages use `role="status"` and errors `role="alert"`.
  - Every state has an axe test, and browser code never imports `@gcpe/auth`.
  - Controls are at least 24 by 24 CSS pixels.
  - Follow the Calendar section's tab row and the shared form styles in `global.css`. Don't hard-code classes the usability pass may rename. Reuse the field markup the list's `FilterPanel` uses at the time you implement.
- **UI tasks run the affected e2e specs:** `calendar-updates.spec.ts`, `axe-sweep.spec.ts`, and `calendar-list.spec.ts`, because the tab row changes. The full suite stays green. Seeded users use sessions minted in global-setup (`sessionOf`), never a real login, because the login limiter allows 10 a minute.
- **Parity lists:**
  - New rows go in `docs/parity/changes-from-legacy.md`, from C181 (the highest at `9e3dc5b` is C180, and PR #21's `docs/boxs-calendar-setup` adds none).
  - New questions go in `docs/parity/open-questions.md`, from Q60 (the highest is Q59).
  - Running-notes lines carry role tags (`docs/manuals/running-notes.md`).

## Review Focus

1. **A keyword built to break a search:** `%`, `_`, a backslash, an apostrophe, `x%y`, a 200- and a 201-character string, a NUL. Expected:
   - each character matches literally, and `%` alone finds only text containing `%`;
   - 200 characters are accepted;
   - 201 characters or a NUL is 400, never a 500.

   Pinned in Task 3 ("wildcards, quotes and backslashes match literally", "every value is bounded").
2. **A keyword that looks like an id:** `HLTH-20007`, ` 20007 `, `hlth-20007`, `COVID-19`, `2026`, `10000`, an invisible activity's number, a number nobody has. Expected:
   - above 10,000 switches to that activity's updates, ignoring dates and type;
   - the others are searched as words;
   - an invisible activity and a missing one give the same 404.

   Pinned in Task 3 ("a keyword naming an activity above 10,000…", "…is not found, the same either way", "small numbers and hyphenated words…").
3. **Day edges:** an entry at 23:59:59 BC and one at 00:00:00 BC the next day, in January (UTC−8) and in November (UTC−7). Also a single-day range, and only From or only To. Expected: whole BC days with both ends included; "today" is BC's today. Pinned in Task 2 ("days are whole BC days…", "a date range…").
4. **A hand-edited or stale feed address:** `mode=bogus`, `from=2026-02-30`, From after To, `type=transferred`, `activity=abc`. Expected: a message naming the problem, the form still usable, no request with bad values. Pinned in Task 4 ("a hand-edited address is explained, not sent"; `url.test.ts`).
5. **An activity whose visibility changes after its entries were written** (made confidential, moved to another ministry, shared back, deleted). Expected: its entries follow its current visibility, in one activity's view and in a date range alike. Pinned in Task 2 ("entries follow their activity's current visibility").

---

## File structure

| File | Responsibility |
|---|---|
| `packages/calendar-contract/src/feed.ts` (+ `feed.test.ts`), `src/index.ts` | `FEED_ACTIONS`, `FEED_MODES`, the limits, `feedQuerySchema`, `FeedQuery`, `FeedItem`, `FeedPage` |
| `apps/calendar/src/feed.ts` | `readFeed`: the reader, its visibility, Look Ahead and mode predicates, keyword and id switch |
| `apps/calendar/src/list/query.ts` | `ID_SEARCH_FLOOR` exported (one word) |
| `apps/calendar/src/http/feed-routes.ts`, `src/http/routes.ts` | `GET /updates` |
| `apps/calendar/test/feed-world.ts` | The feed fixture: `seedFeed`, `addEntry`, `bcAt`, `FEED_IDS`, `feedKeyOf` |
| `apps/calendar/src/http/feed-routes.test.ts` | Modes, the role matrix, one activity, exclusions, the Look Ahead rule, item shape, day edges, visibility changes |
| `apps/calendar/src/http/feed-search.test.ts` | Keyword, id switch, the 1,000 cap, input bounds |
| `apps/staff-web/src/screens/calendar/updates/url.ts` (+ `url.test.ts`), `api.ts` | Address ↔ query; the one call |
| `apps/staff-web/src/screens/calendar/updates/UpdatesScreen.tsx`, `fixtures.tsx`, `UpdatesScreen.test.tsx`, `a11y.test.tsx` | The screen |
| `apps/staff-web/src/screens/calendar/CalendarSection.tsx`, `apps/staff-web/src/router.tsx`, `apps/staff-web/src/styles/global.css` | The tab, the route, three style rules |
| `tests/e2e/calendar-updates.spec.ts`, `tests/e2e/axe-sweep.spec.ts` | End to end |
| `docs/parity/changes-from-legacy.md`, `docs/parity/open-questions.md`, `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`, `docs/superpowers/plans/phase-5-carry-forward.md` | Docs |

---

### Task 1: The feed's contract: kinds, modes, limits and the query schema

Covers: spec §9.1 (the four modes; the type filter; the keyword; at most 1,000 rows; no "since last visit"), §17. Decisions F1, F8, F9, F12. Review Focus 1 (the bounds half).

**Files:**
- Create: `packages/calendar-contract/src/feed.ts`, `packages/calendar-contract/src/feed.test.ts`.
- Modify: `packages/calendar-contract/src/index.ts`.

**Interfaces:**
- Consumes: `ChangeAction` (`./enums`), `bcDateSchema`, `safeString` (`./input`).
- Produces:
  - `FEED_ACTIONS: readonly ["created", "updated", "reviewed", "deleted", "cloned"]`; `type FeedAction`.
  - `FEED_MODES: readonly ["latest", "today", "range", "activity"]`; `type FeedMode`.
  - `FEED_LATEST_COUNT = 5`, `FEED_MAX_ITEMS = 1000`, `FEED_KEYWORD_MAX = 200`.
  - `feedQuerySchema` (zod; parses a query-string object), `type FeedQuery = z.infer<typeof feedQuerySchema>`:
    - `{ mode: "latest" }`, `{ mode: "today" }`, `{ mode: "activity"; activity: number }`;
    - `{ mode: "range"; from?: string; to?: string; type?: FeedAction; keyword?: string }`, with `keyword` trimmed.
  - `interface FeedItem { id; at; action: FeedAction; actorName; activityId; ministryAbbreviation: string | null; title; details; startAt: string | null; endAt: string | null; isAllDay; isConfirmed; potentialDates: string | null; isDeleted }`.
  - `interface FeedPage { mode: FeedMode; activityId: number | null; items: FeedItem[]; truncated: boolean }`.

- [ ] **Step 1: Write the failing test**

Create `packages/calendar-contract/src/feed.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CHANGE_ACTIONS } from "./enums";
import { FEED_ACTIONS, FEED_KEYWORD_MAX, feedQuerySchema } from "./feed";

describe("the updates feed's query (spec addendum §9.1)", () => {
  it("has legacy's views: latest 5, today, a date range, one activity", () => {
    expect(feedQuerySchema.parse({ mode: "latest" })).toEqual({ mode: "latest" });
    expect(feedQuerySchema.parse({ mode: "today" })).toEqual({ mode: "today" });
    expect(feedQuerySchema.parse({ mode: "range", from: "2026-11-01", to: "2026-11-03", type: "updated", keyword: "  Sample words " })).toEqual({
      mode: "range", from: "2026-11-01", to: "2026-11-03", type: "updated", keyword: "Sample words",
    });
    expect(feedQuerySchema.parse({ mode: "activity", activity: "20001" })).toEqual({ mode: "activity", activity: 20001 });
  });

  it("a date range may leave out either end, or be a single day", () => {
    expect(feedQuerySchema.parse({ mode: "range" })).toEqual({ mode: "range" });
    expect(feedQuerySchema.parse({ mode: "range", to: "2026-11-01" })).toEqual({ mode: "range", to: "2026-11-01" });
    expect(feedQuerySchema.safeParse({ mode: "range", from: "2026-11-01", to: "2026-11-01" }).success).toBe(true);
  });

  it("refuses From after To", () => {
    const r = feedQuerySchema.safeParse({ mode: "range", from: "2026-11-05", to: "2026-11-01" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]).toMatchObject({ path: ["to"], message: "From must be on or before To" });
  });

  it("offers legacy's five kinds of update, all of them history actions, and no others", () => {
    expect(FEED_ACTIONS.every((a) => (CHANGE_ACTIONS as readonly string[]).includes(a))).toBe(true);
    for (const type of ["transferred", "la_status_cleared", "added", "changed"]) expect(feedQuerySchema.safeParse({ mode: "range", type }).success, type).toBe(false);
  });

  it("refuses unknown views, stray parameters and unbounded values", () => {
    const bad: object[] = [
      {},
      { mode: "since_last_visit" },
      { mode: "latest", from: "2026-11-01" },
      { mode: "today", keyword: "sample" },
      { mode: "range", keyword: "x".repeat(FEED_KEYWORD_MAX + 1) },
      { mode: "range", keyword: "a\u0000b" },
      { mode: "range", from: "2026-02-30" },
      { mode: "range", from: "1899-12-31" },
      { mode: "range", from: ["2026-11-01", "2026-11-02"] },
      { mode: "range", sort: "at" },
      { mode: "activity" },
      { mode: "activity", activity: "0" },
      { mode: "activity", activity: "1234567890" },
      { mode: "activity", activity: "12a" },
    ];
    for (const q of bad) expect(feedQuerySchema.safeParse(q).success, JSON.stringify(q)).toBe(false);
    expect(feedQuerySchema.safeParse({ mode: "range", keyword: "x".repeat(FEED_KEYWORD_MAX) }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/calendar-contract/src/feed.test.ts`
Expected: FAIL, "Failed to resolve import "./feed"".

- [ ] **Step 3: Implement**

Create `packages/calendar-contract/src/feed.ts`:

```ts
import { z } from "zod";
import type { ChangeAction } from "./enums";
import { bcDateSchema, safeString } from "./input";

/**
 * The history actions the updates feed shows: legacy's NewsFeed kinds add, change, review, delete
 * and clone (Activity.aspx.cs:1051-1567). Legacy wrote no feed entry for Transfer or Clear LA Status.
 */
export const FEED_ACTIONS = ["created", "updated", "reviewed", "deleted", "cloned"] as const satisfies readonly ChangeAction[];
export type FeedAction = (typeof FEED_ACTIONS)[number];

/** History.aspx's views; legacy had no "since last visit" (spec addendum §17). */
export const FEED_MODES = ["latest", "today", "range", "activity"] as const;
export type FeedMode = (typeof FEED_MODES)[number];

/** "Latest 5 updates" (GetCorpCalendarUpdates: TOP 5). */
export const FEED_LATEST_COUNT = 5;
/** Every view answers at most this many entries (spec addendum §9.1; legacy capped the date range at 1,000). */
export const FEED_MAX_ITEMS = 1000;
export const FEED_KEYWORD_MAX = 200;

const activityParam = z
  .string()
  .regex(/^\d{1,9}$/, "a whole number")
  .transform(Number)
  .pipe(z.number().int().positive());

/** `GET /calendar/api/updates`'s query string. Each view takes only its own parameters. */
export const feedQuerySchema = z
  .discriminatedUnion("mode", [
    z.object({ mode: z.literal("latest") }).strict(),
    z.object({ mode: z.literal("today") }).strict(),
    z
      .object({
        mode: z.literal("range"),
        from: bcDateSchema.optional(),
        to: bcDateSchema.optional(),
        type: z.enum(FEED_ACTIONS).optional(),
        keyword: safeString()
          .max(FEED_KEYWORD_MAX)
          .transform((s) => s.trim())
          .optional(),
      })
      .strict(),
    z.object({ mode: z.literal("activity"), activity: activityParam }).strict(),
  ])
  .superRefine((q, ctx) => {
    if (q.mode === "range" && q.from && q.to && q.to < q.from) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "From must be on or before To", path: ["to"] });
    }
  });
export type FeedQuery = z.infer<typeof feedQuerySchema>;

/**
 * One entry (spec addendum §9.1). The activity's facts are its current values; the actor's name is
 * the one stored when the change was made. No field values and no email, ever (C135).
 */
export interface FeedItem {
  /** The history entry's id. */
  id: number;
  at: string;
  action: FeedAction;
  actorName: string;
  activityId: number;
  ministryAbbreviation: string | null;
  title: string;
  details: string;
  startAt: string | null;
  endAt: string | null;
  isAllDay: boolean;
  isConfirmed: boolean;
  potentialDates: string | null;
  isDeleted: boolean;
}

export interface FeedPage {
  /** "activity" also when a date range's keyword named an activity (CorporateCalendarUpdateWebService.asmx.cs:191-199). */
  mode: FeedMode;
  activityId: number | null;
  items: FeedItem[];
  /** More entries matched than FEED_MAX_ITEMS. */
  truncated: boolean;
}
```

`packages/calendar-contract/src/index.ts`, after `export * from "./enums";`:

```ts
export * from "./feed";
```

- [ ] **Step 4: Run it to see it pass, and type-check**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/calendar-contract/src/feed.test.ts`
Expected: PASS (5 tests).
Run: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/calendar-contract/src/feed.ts packages/calendar-contract/src/feed.test.ts packages/calendar-contract/src/index.ts
git commit -m "feat(calendar-contract): the updates feed's views, kinds, limits and query schema"
```

---

### Task 2: The feed reader and `GET /calendar/api/updates`: views, visibility and the Look Ahead rule

Covers: spec §3 row 5f's exit check ("feed visibility tests for each role, including confidential and deleted items. Each mode returns the expected items from a fixture"), §6 (the feed is a `visible()` reader; not visible is 404; the Look Ahead fieldset's rule), §9.1 (source, the latest 5, today, the date range with a type, one activity, no email, the scope), §16 acceptance 2 (the feed part) and 9. Decisions F1–F4, F7–F9. Review Focus 3, 5.

**Files:**
- Create: `apps/calendar/src/feed.ts`, `apps/calendar/src/http/feed-routes.ts`, `apps/calendar/test/feed-world.ts`, `apps/calendar/src/http/feed-routes.test.ts`.
- Modify: `apps/calendar/src/http/routes.ts`.

**Interfaces:**
- Consumes: Task 1's `FEED_ACTIONS`, `FEED_LATEST_COUNT`, `FEED_MAX_ITEMS`, `feedQuerySchema`, `FeedAction`, `FeedItem`, `FeedPage`, `FeedQuery`. From the calendar app: `LOOK_AHEAD_HISTORY_FIELDS`, `visibleSql`, `inReadSnapshot`, `scopeOf`, `executiveSummaryShown`, `ListScope`, `bcMidnight`, `addDays`, `ActivityNotFoundError`, `runList`. From its tests: `insertRaw`, `seedWorld`, `call`, `Who`, `World`.
- Produces:
  - `readFeed(deps: ApiDeps, actor: CalendarActor, q: FeedQuery): Promise<FeedPage>` (`apps/calendar/src/feed.ts`).
  - `feedRoutes(deps: ApiDeps): Router` serving `GET /updates`, mounted in `apiRoutes`.
  - Test fixture (`apps/calendar/test/feed-world.ts`): `bcAt(date, time, offset?)`, `FeedKey`, `FEED_IDS`, `feedKeyOf(id)`, `addEntry(db, activityId, action, at, o?)`, `seedFeed(db)`.

- [ ] **Step 1: Write the fixture**

Create `apps/calendar/test/feed-world.ts`:

```ts
import type { Db } from "@gcpe/db-kit";
import type { ChangeAction, ChangeSource } from "@gcpe/calendar-contract";
import { activities, activityChangeFields, activityChanges, activitySharedWith } from "../src/db/schema";
import { insertRaw } from "./world";

/** A BC wall-clock instant. BC is UTC−7 from 2026-11-01 on, and was UTC−8 in winter before that. */
export const bcAt = (date: string, time: string, offset = "-07:00") => new Date(`${date}T${time}:00${offset}`);

export type FeedKey = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H";
/** Legacy-sized ids: a keyword names an activity only above 10,000. */
export const FEED_IDS: Record<FeedKey, number> = { A: 20001, B: 20002, C: 20003, D: 20004, E: 20005, F: 20006, G: 20007, H: 20008 };
export const feedKeyOf = (id: number): string => (Object.keys(FEED_IDS) as FeedKey[]).find((k) => FEED_IDS[k] === id) ?? String(id);

/** One history entry as the Calendar writes it, at a chosen time. */
export async function addEntry(
  db: Db,
  activityId: number,
  action: ChangeAction,
  at: Date,
  o: { actor?: string; source?: ChangeSource; fields?: [string, string | null, string | null][] } = {},
): Promise<void> {
  const [row] = await db
    .insert(activityChanges)
    .values({ activityId, at, actorId: null, actorName: o.actor ?? "Sample Writer", action, source: o.source ?? "calendar", contactMinistryKey: null })
    .returning({ id: activityChanges.id });
  if (o.fields?.length) {
    await db.insert(activityChangeFields).values(o.fields.map(([fieldKey, oldValue, newValue]) => ({ changeId: row!.id, fieldKey, oldValue, newValue })));
  }
}

/**
 * Eight activities and their history over 2026-11-01..03; under FIXED_NOW, today is 2026-11-03.
 * A Health; B Health confidential; C Finance; D Finance confidential; E Finance confidential shared
 * with Health; F Health, deleted; G Health, with an entry that changed only a Look Ahead field and
 * one that changed a Look Ahead field and the title; H Finance, a clone. Plus three entries the feed
 * never shows: a transfer, an LA status clear and an imported legacy log entry.
 */
export async function seedFeed(db: Db): Promise<void> {
  const make = (k: FeedKey, over: Partial<typeof activities.$inferInsert> = {}) => insertRaw(db, { id: FEED_IDS[k], title: `Feed ${k}`, details: `Sample details ${k}`, ...over });
  await make("A");
  await make("B", { isConfidential: true });
  await make("C", { contactMinistryKey: "finance" });
  await make("D", { contactMinistryKey: "finance", isConfidential: true });
  await make("E", { contactMinistryKey: "finance", isConfidential: true });
  await db.insert(activitySharedWith).values({ activityId: FEED_IDS.E, ministryKey: "health" });
  await make("F", { deletedAt: bcAt("2026-11-03", "09:00"), needsReview: ["active"] });
  await make("G");
  await make("H", { contactMinistryKey: "finance" });

  const e = (k: FeedKey, action: ChangeAction, date: string, time: string, o: Parameters<typeof addEntry>[4] = {}) => addEntry(db, FEED_IDS[k], action, bcAt(date, time), o);
  await e("A", "updated", "2019-05-01", "09:00", { source: "legacy_log", fields: [["title", "Feed A older", "Feed A old"]] });
  await e("A", "created", "2026-11-01", "09:00");
  await e("C", "created", "2026-11-01", "09:05");
  await e("B", "created", "2026-11-02", "09:00");
  await e("D", "created", "2026-11-02", "09:10");
  await e("E", "created", "2026-11-02", "09:20");
  await e("A", "updated", "2026-11-02", "14:00", { fields: [["title", "Feed A old", "Feed A"]] });
  await e("F", "created", "2026-11-03", "08:00");
  await e("F", "deleted", "2026-11-03", "09:00");
  await e("A", "reviewed", "2026-11-03", "09:30", { actor: "Sample Reviewer", fields: [["status", "Changed", "Reviewed"]] });
  await e("H", "cloned", "2026-11-03", "09:45", { fields: [["cloned_from", null, String(FEED_IDS.C)]] });
  await e("G", "created", "2026-11-03", "10:00");
  await e("G", "updated", "2026-11-03", "10:30", { fields: [["hq_comments", null, "Sample executive summary"]] });
  await e("C", "transferred", "2026-11-03", "10:40", { fields: [["comm_contact", "Kim Finance (FIN)", "Sample Admin (HLTH)"]] });
  await e("A", "la_status_cleared", "2026-11-03", "10:50", { fields: [["hq_status", "Changed", null]] });
  await e("G", "updated", "2026-11-03", "10:55", { fields: [["title", "Feed G old", "Feed G"], ["hq_status", null, "New"]] });
}
```

- [ ] **Step 2: Write the failing tests**

Create `apps/calendar/src/http/feed-routes.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import type { FeedPage } from "@gcpe/calendar-contract";
import { activities, activitySharedWith } from "../db/schema";
import { createCalendarTestDb, createTestApp, TEST_RULES } from "../../test/helpers";
import { addEntry, bcAt, FEED_IDS, feedKeyOf, seedFeed } from "../../test/feed-world";
import { call, insertRaw, seedWorld, type Who, type World } from "../../test/world";

// Each list is newest first, as "<activity> <action>" (feed-world.ts). The matrix comes from spec
// addendum §6: own and shared-with ministries; HQ sees every ministry, confidential ones from
// Advanced; deleted activities only HQ Administrators; Look-Ahead-only changes only HQ Editor and above.
const HEALTH = ["G updated", "G created", "A reviewed", "A updated", "E created", "B created", "A created"];
const FINANCE = ["H cloned", "E created", "D created", "C created"];
const HQ_READ = ["G updated", "G created", "H cloned", "A reviewed", "A updated", "C created", "A created"];
const HQ_EDIT = ["G updated", "G updated", "G created", "H cloned", "A reviewed", "A updated", "C created", "A created"];
const HQ_ADVANCED = ["G updated", "G updated", "G created", "H cloned", "A reviewed", "A updated", "E created", "D created", "B created", "C created", "A created"];
const HQ_ADMIN = ["G updated", "G updated", "G created", "H cloned", "A reviewed", "F deleted", "F created", "A updated", "E created", "D created", "B created", "C created", "A created"];
const EXPECTED: Record<Who, string[]> = {
  readOnly: HEALTH, editor: HEALTH, advanced: HEALTH, admin: HEALTH, financeEditor: FINANCE,
  hqReadOnly: HQ_READ, hqEditor: HQ_EDIT, hqAdvanced: HQ_ADVANCED, hqAdmin: HQ_ADMIN,
};

describe("the updates feed (spec addendum §9.1)", () => {
  let tdb: TestDatabase;
  let w: World;
  let app: ReturnType<typeof createTestApp>;
  const feed = (who: Who, query: string, on = app) => call(on, "get", `/api/updates?${query}`, w.as[who].cookie);
  const labels = async (who: Who, query: string, on = app) => {
    const res = await feed(who, query, on);
    expect(res.status, `${who} ${query}`).toBe(200);
    return (res.body as FeedPage).items.map((i) => `${feedKeyOf(i.activityId)} ${i.action}`);
  };

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    w = await seedWorld(app, tdb.db);
    await seedFeed(tdb.db);
  });
  afterAll(() => tdb.drop());

  it("every role sees exactly the entries of the activities it can see, confidential and deleted ones included", async () => {
    for (const who of Object.keys(EXPECTED) as Who[]) {
      expect(await labels(who, "mode=range&from=2026-11-01&to=2026-11-03"), who).toEqual(EXPECTED[who]);
    }
  });

  it("Latest 5 updates: the five newest the user can see", async () => {
    expect(await labels("editor", "mode=latest")).toEqual(HEALTH.slice(0, 5));
    expect(await labels("hqAdmin", "mode=latest")).toEqual(HQ_ADMIN.slice(0, 5));
    expect(await labels("financeEditor", "mode=latest")).toEqual(FINANCE);
    const res = await feed("editor", "mode=latest");
    expect(res.body).toMatchObject({ mode: "latest", activityId: null, truncated: false });
  });

  it("Today's updates: BC's today by the database's clock", async () => {
    expect(await labels("editor", "mode=today")).toEqual(["G updated", "G created", "A reviewed"]);
    expect(await labels("hqAdmin", "mode=today")).toEqual(HQ_ADMIN.slice(0, 7));
  });

  it("a date range: whole BC days, From and To included, either left out; one kind of update", async () => {
    expect(await labels("hqAdmin", "mode=range&from=2026-11-01&to=2026-11-01")).toEqual(["C created", "A created"]);
    expect(await labels("hqAdmin", "mode=range&from=2026-11-03&to=2026-11-03")).toEqual(HQ_ADMIN.slice(0, 7));
    expect(await labels("financeEditor", "mode=range&from=2026-11-02")).toEqual(["H cloned", "E created", "D created"]);
    expect(await labels("hqAdmin", "mode=range&to=2026-11-01")).toEqual(["C created", "A created"]);
    expect(await labels("financeEditor", "mode=range")).toEqual(FINANCE);
    expect(await labels("financeEditor", "mode=range&from=2026-11-01&to=2026-11-03&type=created")).toEqual(["E created", "D created", "C created"]);
    expect(await labels("admin", "mode=range&type=deleted")).toEqual([]);
    expect(await labels("hqAdmin", "mode=range&type=deleted")).toEqual(["F deleted"]);
  });

  it("one activity's updates, newest first; one the user can't see, or that doesn't exist, is not found", async () => {
    expect(await labels("editor", `mode=activity&activity=${FEED_IDS.G}`)).toEqual(["G updated", "G created"]);
    expect(await labels("hqEditor", `mode=activity&activity=${FEED_IDS.G}`)).toEqual(["G updated", "G updated", "G created"]);
    expect(await labels("hqAdmin", `mode=activity&activity=${FEED_IDS.F}`)).toEqual(["F deleted", "F created"]);
    expect((await feed("editor", `mode=activity&activity=${FEED_IDS.G}`)).body).toMatchObject({ mode: "activity", activityId: FEED_IDS.G });
    const notFound = [
      await feed("financeEditor", `mode=activity&activity=${FEED_IDS.A}`),
      await feed("editor", `mode=activity&activity=${FEED_IDS.F}`),
      await feed("hqEditor", `mode=activity&activity=${FEED_IDS.B}`),
      await feed("editor", "mode=activity&activity=99999"),
    ];
    for (const res of notFound) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "not found" });
    }
  });

  it("leaves out transfers, LA status clears and imported legacy log entries", async () => {
    expect(await labels("hqAdmin", `mode=activity&activity=${FEED_IDS.C}`)).toEqual(["C created"]);
    expect(await labels("hqAdmin", `mode=activity&activity=${FEED_IDS.A}`)).toEqual(["A reviewed", "A updated", "A created"]);
  });

  it("an entry that changed only Look Ahead fields shows only to those who see that fieldset on the activity", async () => {
    expect(await labels("editor", `mode=activity&activity=${FEED_IDS.G}`)).toEqual(["G updated", "G created"]);
    expect(await labels("hqReadOnly", `mode=activity&activity=${FEED_IDS.G}`)).toEqual(["G updated", "G created"]);
    expect(await labels("hqEditor", `mode=activity&activity=${FEED_IDS.G}`)).toEqual(["G updated", "G updated", "G created"]);
    // With the tenant's ShowHqCommentsField on, whoever may edit the activity sees the fieldset too.
    const shown = createTestApp(tdb.db, { rules: { ...TEST_RULES, showHqCommentsField: true } });
    expect(await labels("editor", `mode=activity&activity=${FEED_IDS.G}`, shown)).toEqual(["G updated", "G updated", "G created"]);
    expect(await labels("readOnly", `mode=activity&activity=${FEED_IDS.G}`, shown)).toEqual(["G updated", "G created"]);
  });

  it("each item carries the activity as it is now and who made the change; never an email or a field's value", async () => {
    const res = await feed("hqAdmin", `mode=activity&activity=${FEED_IDS.G}`);
    expect(res.body).toMatchObject({ mode: "activity", activityId: FEED_IDS.G, truncated: false });
    expect((res.body as FeedPage).items[0]).toEqual({
      id: expect.any(Number), at: "2026-11-03T17:55:00.000Z", action: "updated", actorName: "Sample Writer",
      activityId: FEED_IDS.G, ministryAbbreviation: "HLTH", title: "Feed G", details: "Sample details G",
      startAt: "2026-11-10T17:00:00.000Z", endAt: "2026-11-10T18:00:00.000Z", isAllDay: false, isConfirmed: true, potentialDates: null, isDeleted: false,
    });
    const deleted = await feed("hqAdmin", `mode=activity&activity=${FEED_IDS.F}`);
    expect((deleted.body as FeedPage).items.every((i) => i.isDeleted)).toBe(true);
    const everything = JSON.stringify((await feed("hqAdmin", "mode=range")).body);
    for (const never of ["@", "Sample executive summary", "Feed G old", "Kim Finance (FIN)"]) expect(everything).not.toContain(never);
  });
});

describe("the updates feed's day edges, and entries that follow their activity", () => {
  let tdb: TestDatabase;
  let w: World;
  let app: ReturnType<typeof createTestApp>;
  const K = 20011;
  const J = 20012;
  const actors = async (who: Who, query: string) => {
    const res = await call(app, "get", `/api/updates?${query}`, w.as[who].cookie);
    expect(res.status, `${who} ${query}`).toBe(200);
    return (res.body as FeedPage).items.map((i) => i.actorName);
  };

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    w = await seedWorld(app, tdb.db);
    await insertRaw(tdb.db, { id: K, title: "Sample edges" });
    const edges: [string, string][] = [
      ["Edge 1", "2026-01-16T07:59:59Z"], // 23:59:59 on Jan 15, PST
      ["Edge 2", "2026-01-16T08:00:00Z"], // 00:00:00 on Jan 16, PST
      ["Edge 3", "2026-11-03T06:59:59Z"], // 23:59:59 on Nov 2, permanent UTC−7
      ["Edge 4", "2026-11-03T07:00:00Z"], // 00:00:00 on Nov 3, today under FIXED_NOW
    ];
    for (const [actor, at] of edges) await addEntry(tdb.db, K, "updated", new Date(at), { actor, fields: [["title", "Sample a", "Sample b"]] });
    await insertRaw(tdb.db, { id: J, title: "Sample moving" });
    await addEntry(tdb.db, J, "created", bcAt("2026-10-20", "08:00"), { actor: "Moving" });
  });
  afterAll(() => tdb.drop());

  it("days are whole BC days, From and To included, on both sides of BC's move to UTC−7", async () => {
    expect(await actors("editor", "mode=range&from=2026-01-15&to=2026-01-15")).toEqual(["Edge 1"]);
    expect(await actors("editor", "mode=range&from=2026-01-16&to=2026-01-16")).toEqual(["Edge 2"]);
    expect(await actors("editor", "mode=range&from=2026-11-02&to=2026-11-02")).toEqual(["Edge 3"]);
    expect(await actors("editor", "mode=today")).toEqual(["Edge 4"]);
  });

  it("entries follow their activity's current visibility: made confidential, moved, shared back, deleted", async () => {
    const seen = async (who: Who) => (await call(app, "get", `/api/updates?mode=activity&activity=${J}`, w.as[who].cookie)).status;
    const inRange = (who: Who) => actors(who, "mode=range&from=2026-10-20&to=2026-10-20");
    const set = (over: Partial<typeof activities.$inferInsert>) => tdb.db.update(activities).set(over).where(eq(activities.id, J));

    expect([await seen("editor"), await seen("hqEditor"), await seen("financeEditor")]).toEqual([200, 200, 404]);
    await set({ isConfidential: true });
    expect([await seen("editor"), await seen("hqEditor"), await seen("hqAdvanced")]).toEqual([200, 404, 200]);
    expect(await inRange("hqEditor")).toEqual([]);
    expect(await inRange("editor")).toEqual(["Moving"]);
    await set({ contactMinistryKey: "finance" });
    expect([await seen("editor"), await seen("financeEditor")]).toEqual([404, 200]);
    await tdb.db.insert(activitySharedWith).values({ activityId: J, ministryKey: "health" });
    expect(await seen("editor")).toBe(200);
    await set({ deletedAt: bcAt("2026-11-03", "08:00") });
    expect([await seen("editor"), await seen("financeEditor"), await seen("hqAdvanced"), await seen("hqAdmin")]).toEqual([404, 404, 404, 200]);
    expect(await inRange("financeEditor")).toEqual([]);
    expect(await inRange("hqAdmin")).toEqual(["Moving"]);
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/http/feed-routes.test.ts`
Expected: FAIL. Every request answers 404 from Express's default handler, because `/api/updates` doesn't exist. The first assertion reads `expected 404 to be 200 // editor mode=range…` (or the role named first).

- [ ] **Step 4: Implement the reader**

Create `apps/calendar/src/feed.ts`:

```ts
import { and, desc, eq, gte, inArray, lt, notInArray, sql, type SQL } from "drizzle-orm";
import {
  FEED_ACTIONS, FEED_LATEST_COUNT, FEED_MAX_ITEMS, LOOK_AHEAD_HISTORY_FIELDS, type FeedAction, type FeedItem, type FeedPage, type FeedQuery,
} from "@gcpe/calendar-contract";
import type { CalendarActor } from "./actor";
import { ActivityNotFoundError } from "./activities/errors";
import { inReadSnapshot } from "./activities/store";
import { activities, activityChangeFields, activityChanges, orgs } from "./db/schema";
import type { ApiDeps } from "./http/routes";
import { executiveSummaryShown, scopeOf, type ListScope } from "./list/query";
import { addDays, bcMidnight } from "./time";
import { visibleSql } from "./visibility";

/** An `updated` entry whose every field (one at least) is a Look Ahead field. */
const onlyLookAheadFields = sql`(${activityChanges.action} = 'updated'
  AND EXISTS (SELECT 1 FROM ${activityChangeFields} WHERE ${activityChangeFields.changeId} = ${activityChanges.id})
  AND NOT EXISTS (SELECT 1 FROM ${activityChangeFields} WHERE ${activityChangeFields.changeId} = ${activityChanges.id} AND ${notInArray(activityChangeFields.fieldKey, [...LOOK_AHEAD_HISTORY_FIELDS])}))`;

/**
 * View changes leaves out an entry that recorded only Look Ahead fields for whoever doesn't see
 * that fieldset on the activity (activities/view.ts); so does the feed, or "changed activity" would
 * say that HQ touched them. executiveSummaryShown is that fieldset's rule as SQL.
 */
function lookAheadRule(scope: ListScope): SQL {
  const shown = executiveSummaryShown(scope);
  return shown === null ? sql`NOT ${onlyLookAheadFields}` : sql`(NOT ${onlyLookAheadFields} OR ${shown})`;
}

/** Whole BC days of the entry's time, both ends included (GetCorpCalendarUpdatesBetweenDates). */
function viewWhere(scope: ListScope, q: FeedQuery, activityId: number | null): SQL[] {
  const day = (d: string) => bcMidnight(d, scope.rules.timeZone);
  if (activityId !== null) return [eq(activityChanges.activityId, activityId)];
  switch (q.mode) {
    case "latest":
    case "activity":
      return [];
    case "today":
      return [gte(activityChanges.at, day(scope.today)), lt(activityChanges.at, day(addDays(scope.today, 1)))];
    case "range": {
      const out: SQL[] = [];
      if (q.from) out.push(gte(activityChanges.at, day(q.from)));
      if (q.to) out.push(lt(activityChanges.at, day(addDays(q.to, 1))));
      if (q.type) out.push(eq(activityChanges.action, q.type));
      return out;
    }
  }
}

/**
 * The updates feed (spec addendum §9.1): history entries written by the Calendar, of activities the
 * actor can see as they stand now, newest first. Imported legacy log entries are not in it (C135).
 */
export function readFeed(deps: ApiDeps, actor: CalendarActor, q: FeedQuery): Promise<FeedPage> {
  return inReadSnapshot(deps.db, async (tx) => {
    const scope = await scopeOf(tx, deps, actor);
    const activityId = q.mode === "activity" ? q.activity : null;
    if (activityId !== null) {
      // One activity's updates are a read of that activity: not visible is not found (spec addendum §6).
      const [seen] = await tx.select({ id: activities.id }).from(activities).where(and(eq(activities.id, activityId), visibleSql(actor)));
      if (!seen) throw new ActivityNotFoundError();
    }
    const rows = await tx
      .select({
        id: activityChanges.id,
        at: activityChanges.at,
        action: activityChanges.action,
        actorName: activityChanges.actorName,
        activityId: activities.id,
        ministryAbbreviation: sql<string | null>`(SELECT ${orgs.abbreviation} FROM ${orgs} WHERE ${orgs.key} = ${activities.contactMinistryKey})`,
        title: activities.title,
        details: activities.details,
        startAt: activities.startAt,
        endAt: activities.endAt,
        isAllDay: activities.isAllDay,
        isConfirmed: activities.isConfirmed,
        potentialDates: activities.potentialDates,
        deletedAt: activities.deletedAt,
      })
      .from(activityChanges)
      .innerJoin(activities, eq(activities.id, activityChanges.activityId))
      .where(
        and(
          eq(activityChanges.source, "calendar"),
          inArray(activityChanges.action, [...FEED_ACTIONS]),
          visibleSql(actor),
          lookAheadRule(scope),
          ...viewWhere(scope, q, activityId),
        ),
      )
      .orderBy(desc(activityChanges.at), desc(activityChanges.id))
      .limit(q.mode === "latest" ? FEED_LATEST_COUNT : FEED_MAX_ITEMS + 1);
    return {
      mode: activityId !== null ? "activity" : q.mode,
      activityId,
      items: rows.slice(0, FEED_MAX_ITEMS).map(
        (r): FeedItem => ({
          id: r.id,
          at: r.at.toISOString(),
          action: r.action as FeedAction,
          actorName: r.actorName,
          activityId: r.activityId,
          ministryAbbreviation: r.ministryAbbreviation,
          title: r.title,
          details: r.details,
          startAt: r.startAt?.toISOString() ?? null,
          endAt: r.endAt?.toISOString() ?? null,
          isAllDay: r.isAllDay,
          isConfirmed: r.isConfirmed,
          potentialDates: r.potentialDates,
          isDeleted: r.deletedAt !== null,
        }),
      ),
      truncated: rows.length > FEED_MAX_ITEMS,
    };
  });
}
```

- [ ] **Step 5: The route**

Create `apps/calendar/src/http/feed-routes.ts`:

```ts
import { Router } from "express";
import { feedQuerySchema } from "@gcpe/calendar-contract";
import { readFeed } from "../feed";
import { runList } from "./list-errors";
import type { ApiDeps } from "./routes";

/** The updates feed (spec addendum §9.1): any Calendar role, every entry inside visibleSql. */
export function feedRoutes(deps: ApiDeps): Router {
  const r = Router();
  r.get("/updates", runList(async (req, res) => void res.json(await readFeed(deps, req.calendar!, feedQuerySchema.parse(req.query)))));
  return r;
}
```

`apps/calendar/src/http/routes.ts`: add `import { feedRoutes } from "./feed-routes";` after the `deadLetterRoutes` import, and in `apiRoutes`, after `r.use(listRoutes(deps));`:

```ts
  r.use(feedRoutes(deps));
```

- [ ] **Step 6: Run the tests to see them pass, and type-check**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/http/feed-routes.test.ts`
Expected: PASS (10 tests in two describes).
Run: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: no errors.
Run the Calendar's whole suite: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/calendar/src/feed.ts apps/calendar/src/http/feed-routes.ts apps/calendar/src/http/routes.ts apps/calendar/test/feed-world.ts apps/calendar/src/http/feed-routes.test.ts
git commit -m "feat(calendar): the updates feed's reader and route, inside the visibility rule"
```

---

### Task 3: Search: the keyword, an activity's number, the 1,000 cap and the input bounds

Covers: spec §9.1 ("a keyword search over title and details. A number above 10,000 in the keyword box switches to that activity's feed, within `visible()`. At most 1,000 rows per request"). Decisions F5, F6, F8. Review Focus 1, 2.

**Files:**
- Modify: `apps/calendar/src/feed.ts`, `apps/calendar/src/list/query.ts` (export one constant).
- Create: `apps/calendar/src/http/feed-search.test.ts`.

**Interfaces:**
- Consumes: Task 2's `readFeed`, `seedFeed`, `addEntry`, `bcAt`, `FEED_IDS`, `feedKeyOf`; `containsPattern`, `idSearchOf` (`list/query.ts`).
- Produces:
  - `ID_SEARCH_FLOOR` exported from `apps/calendar/src/list/query.ts` (value unchanged, 10,000).
  - `feedActivityIdOf(keyword: string): number | null` (`apps/calendar/src/feed.ts`).
  - `readFeed` gains the keyword filter and the switch to one activity.

- [ ] **Step 1: Write the failing tests**

Create `apps/calendar/src/http/feed-search.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { FEED_MAX_ITEMS, type FeedPage } from "@gcpe/calendar-contract";
import { createCalendarTestDb, createTestApp } from "../../test/helpers";
import { addEntry, bcAt, FEED_IDS, feedKeyOf, seedFeed } from "../../test/feed-world";
import { call, insertRaw, seedWorld, type Who, type World } from "../../test/world";

const ODD = 20013;
const BULK = 20009;

describe("the updates feed's search (spec addendum §9.1)", () => {
  let tdb: TestDatabase;
  let w: World;
  let app: ReturnType<typeof createTestApp>;
  const feed = (who: Who, query: string) => call(app, "get", `/api/updates?${query}`, w.as[who].cookie);
  const search = async (who: Who, keyword: string, rest = "") => {
    const res = await feed(who, `mode=range&keyword=${encodeURIComponent(keyword)}${rest}`);
    expect(res.status, `${who} ${keyword}`).toBe(200);
    const page = res.body as FeedPage;
    return { mode: page.mode, activityId: page.activityId, labels: page.items.map((i) => `${feedKeyOf(i.activityId)} ${i.action}`) };
  };

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    w = await seedWorld(app, tdb.db);
    await seedFeed(tdb.db);
    await insertRaw(tdb.db, { id: ODD, title: "Sample 100% _done_ O'Brien \\path COVID-19 2026", details: "Sample odd details" });
    await addEntry(tdb.db, ODD, "created", bcAt("2026-11-02", "12:00"));
    // One more entry than the cap, a second apart, on a day nothing else uses.
    await insertRaw(tdb.db, { id: BULK, title: "Sample bulk", contactMinistryKey: "finance" });
    await tdb.db.execute(sql`
      INSERT INTO activity_changes (activity_id, at, actor_name, action, source)
      SELECT ${BULK}::int, ${"2026-10-01T15:00:00Z"}::timestamptz + n * interval '1 second', 'Sample Bulk', 'updated', 'calendar'
      FROM generate_series(1, ${sql.raw(String(FEED_MAX_ITEMS + 1))}) AS n`);
  });
  afterAll(() => tdb.drop());

  it("matches the activity's title and summary, and who made the change, in any case", async () => {
    expect((await search("editor", "feed b")).labels).toEqual(["B created"]);
    expect((await search("editor", "SAMPLE DETAILS E")).labels).toEqual(["E created"]);
    expect((await search("editor", "reviewer")).labels).toEqual(["A reviewed"]);
  });

  it("searches only what the user can see", async () => {
    expect((await search("financeEditor", "feed b")).labels).toEqual([]);
    expect((await search("hqEditor", "feed b")).labels).toEqual([]);
    expect((await search("hqAdvanced", "feed b")).labels).toEqual(["B created"]);
  });

  it("combines with the dates and the kind of update", async () => {
    expect((await search("hqAdmin", "feed g", "&from=2026-11-03&type=updated")).labels).toEqual(["G updated", "G updated"]);
    expect((await search("hqAdmin", "feed g", "&to=2026-11-02")).labels).toEqual([]);
  });

  it("wildcards, quotes and backslashes match literally", async () => {
    for (const k of ["100%", "%", "_done_", "_", "o'brien", "\\path"]) expect((await search("editor", k)).labels, k).toEqual([`${ODD} created`]);
    expect((await search("editor", "x%y")).labels).toEqual([]);
  });

  it("a keyword naming an activity above 10,000 opens that activity's updates, ignoring the dates and the type", async () => {
    for (const k of [`HLTH-${FEED_IDS.G}`, ` ${FEED_IDS.G} `, `hlth-${FEED_IDS.G}`]) {
      expect(await search("editor", k, "&from=2026-11-01&to=2026-11-01&type=deleted"), k).toEqual({ mode: "activity", activityId: FEED_IDS.G, labels: ["G updated", "G created"] });
    }
  });

  it("a keyword naming an activity they can't see, or none at all, is not found, the same either way", async () => {
    const hidden = await feed("financeEditor", `mode=range&keyword=${FEED_IDS.A}`);
    const missing = await feed("financeEditor", "mode=range&keyword=99999");
    expect([hidden.status, missing.status]).toEqual([404, 404]);
    expect(hidden.body).toEqual(missing.body);
  });

  it("small numbers and hyphenated words are searched as words", async () => {
    expect(await search("editor", "COVID-19")).toEqual({ mode: "range", activityId: null, labels: [`${ODD} created`] });
    expect(await search("editor", "2026")).toEqual({ mode: "range", activityId: null, labels: [`${ODD} created`] });
    expect(await search("editor", "10000")).toEqual({ mode: "range", activityId: null, labels: [] });
  });

  it("answers at most 1,000 entries, newest first, and says when there were more", async () => {
    const day = await feed("hqAdmin", "mode=range&from=2026-10-01&to=2026-10-01");
    const page = day.body as FeedPage;
    expect(page.items).toHaveLength(FEED_MAX_ITEMS);
    expect(page.truncated).toBe(true);
    expect(page.items[0]!.at).toBe("2026-10-01T15:16:41.000Z");
    expect(page.items[FEED_MAX_ITEMS - 1]!.at).toBe("2026-10-01T15:00:02.000Z");
    const one = (await feed("financeEditor", `mode=activity&activity=${BULK}`)).body as FeedPage;
    expect([one.items.length, one.truncated]).toEqual([FEED_MAX_ITEMS, true]);
    expect(((await feed("hqAdmin", "mode=range&from=2026-11-01&to=2026-11-01")).body as FeedPage).truncated).toBe(false);
  });

  it("every value is bounded; nothing is a 500", async () => {
    const bad = [
      "", "mode=since_last_visit", "mode=latest&from=2026-11-01", `mode=range&keyword=${"x".repeat(201)}`, "mode=range&keyword=a%00b",
      "mode=range&from=2026-02-30", "mode=range&from=2026-11-05&to=2026-11-01", "mode=range&type=transferred",
      "mode=activity", "mode=activity&activity=0", "mode=activity&activity=1234567890", "mode=range&from=2026-11-01&from=2026-11-02", "mode=range&sort=at",
    ];
    for (const q of bad) {
      const res = await feed("editor", q);
      expect(res.status, q).toBe(400);
      expect(res.body.error).toBe("invalid request");
    }
    expect((await feed("editor", `mode=range&keyword=${"x".repeat(200)}`)).status).toBe(200);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/http/feed-search.test.ts`
Expected: FAIL. The keyword is ignored, so "matches the activity's title…" gets every entry the editor sees instead of `["B created"]`. The id-switch test gets `mode: "range"`. "…not found…" gets 200. The cap and bounds tests already pass (Tasks 1 and 2), and that is expected.

- [ ] **Step 3: Implement**

`apps/calendar/src/list/query.ts`: change `const ID_SEARCH_FLOOR = 10_000;` to:

```ts
export const ID_SEARCH_FLOOR = 10_000;
```

`apps/calendar/src/feed.ts`:
- Change the `./list/query` import to:

```ts
import { containsPattern, executiveSummaryShown, ID_SEARCH_FLOOR, idSearchOf, scopeOf, type ListScope } from "./list/query";
```

- Add, after `lookAheadRule`:

```ts
/**
 * Legacy matched the entry's stored text, which named the actor and the title (Activity.aspx.cs:1594-1625):
 * here the actor's name and the activity's current title and summary, literally, ignoring case.
 */
function keywordWhere(term: string): SQL {
  const p = containsPattern(term);
  return sql`(${activities.title} ILIKE ${p} OR ${activities.details} ILIKE ${p} OR ${activityChanges.actorName} ILIKE ${p})`;
}

/**
 * The activity a keyword names: a number above 10,000, bare or after "ABBR-"
 * (CorporateCalendarUpdateWebService.asmx.cs:191-199). "COVID-19" and "2026" stay words.
 */
export function feedActivityIdOf(keyword: string): number | null {
  const id = idSearchOf(keyword);
  return id !== null && id > ID_SEARCH_FLOOR ? id : null;
}
```

- In `viewWhere`'s `range` case, after the `type` line:

```ts
      if (q.keyword) out.push(keywordWhere(q.keyword));
```

- In `readFeed`, replace `const activityId = q.mode === "activity" ? q.activity : null;` with:

```ts
    const activityId = q.mode === "activity" ? q.activity : q.mode === "range" && q.keyword ? feedActivityIdOf(q.keyword) : null;
```

- [ ] **Step 4: Run them to see them pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/http/feed-search.test.ts apps/calendar/src/http/feed-routes.test.ts apps/calendar/src/list/query.test.ts`
Expected: PASS.
Run: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/calendar/src/feed.ts apps/calendar/src/list/query.ts apps/calendar/src/http/feed-search.test.ts
git commit -m "feat(calendar): the updates feed's keyword search and activity-number switch"
```

---

### Task 4: The Updates screen, its tab and its route

Covers: spec §9.1 (each item: the action, the `MIN-Id` link, the title, start and end, the actor's display name, the time, the summary as a tooltip; no email), §8 (the Calendar section), §16 acceptance 18. Decisions F10, F11, F13. Carry-forward § 5f. Review Focus 4.

**Files:**
- Create: `apps/staff-web/src/screens/calendar/updates/url.ts`, `url.test.ts`, `api.ts`, `UpdatesScreen.tsx`, `fixtures.tsx`, `UpdatesScreen.test.tsx`, `a11y.test.tsx`.
- Modify: `apps/staff-web/src/screens/calendar/CalendarSection.tsx`, `apps/staff-web/src/router.tsx`, `apps/staff-web/src/styles/global.css`.

**Interfaces:**
- Consumes: Task 1's types and limits; Task 2's `GET /calendar/api/updates`; `TitleLink` (`list/cells.tsx`), `minIdOf` (`activity/form.ts`), `dateTimeText`, `todayIn`, `addDaysTo`, `isValidBcDate` (`list/dates.ts`), `friendlyDateRange`, `listApi.config`, `apiFetch`, `ApiError`, `useDocumentTitle`; test helpers `stubFetch`, `never`, `Call`, `ME`, `jsonResponse`.
- Produces:
  - `feedQueryOf(params: URLSearchParams): { query: FeedQuery } | { problem: string }` and `paramsOf(q: FeedQuery): URLSearchParams` (`updates/url.ts`).
  - `feedApi.read(q: FeedQuery): Promise<FeedPage>` (`updates/api.ts`).
  - `UpdatesScreen` at `/hub/calendar/updates`; `headingOf(q, page)`.
  - An "Updates" link in `CalendarSection`'s tab row for every Calendar user.

- [ ] **Step 1: Write the failing address tests**

Create `apps/staff-web/src/screens/calendar/updates/url.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { FeedQuery } from "@gcpe/calendar-contract";
import { feedQueryOf, paramsOf } from "./url";

const problem = (s: string) => {
  const r = feedQueryOf(new URLSearchParams(s));
  return "problem" in r ? r.problem : null;
};

describe("the Updates screen's address", () => {
  it("opens on Today's updates, as legacy's page did", () => {
    expect(feedQueryOf(new URLSearchParams(""))).toEqual({ query: { mode: "today" } });
  });

  it("reads each view back from what it writes, and writes only what is set", () => {
    const views: FeedQuery[] = [
      { mode: "latest" },
      { mode: "today" },
      { mode: "activity", activity: 20001 },
      { mode: "range", from: "2026-11-01", to: "2026-11-03", type: "created", keyword: "sample" },
      { mode: "range" },
    ];
    for (const q of views) expect(feedQueryOf(paramsOf(q))).toEqual({ query: q });
    expect(paramsOf({ mode: "range", from: "2026-11-01" }).toString()).toBe("mode=range&from=2026-11-01");
  });

  it("trims the search and drops empty values", () => {
    expect(feedQueryOf(new URLSearchParams("mode=range&from=&keyword=%20%20"))).toEqual({ query: { mode: "range" } });
  });

  it("names what is wrong with a hand-edited address", () => {
    expect(problem("mode=bogus")).toBe("That address isn't one of the updates views.");
    expect(problem("mode=range&from=2026-02-30")).toBe("Enter dates as YYYY-MM-DD.");
    expect(problem("mode=range&from=2026-11-05&to=2026-11-01")).toBe("From must be on or before To.");
    expect(problem("mode=range&type=transferred")).toBe("Choose an update type from the list.");
    expect(problem(`mode=range&keyword=${"x".repeat(201)}`)).toBe("Search for at most 200 characters.");
    expect(problem("mode=activity&activity=abc")).toBe("That address doesn't name an activity.");
    expect(problem("mode=activity&activity=0")).toBe("That address doesn't name an activity.");
  });
});
```

- [ ] **Step 2: Write the failing screen tests**

Create `apps/staff-web/src/screens/calendar/updates/fixtures.tsx`:

```tsx
import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import type { FeedItem, FeedPage } from "@gcpe/calendar-contract";
import { RequireAuth } from "../../../session/RequireAuth";
import { SessionProvider } from "../../../session/SessionContext";
import { CalendarSection } from "../CalendarSection";
import type { Call } from "../list/fixtures";
import { UpdatesScreen } from "./UpdatesScreen";

export function item(over: Partial<FeedItem> = {}): FeedItem {
  return {
    id: 1, at: "2026-11-03T18:00:00.000Z", action: "updated", actorName: "Robin Staff", activityId: 20001, ministryAbbreviation: "HLTH",
    title: "Sample title", details: "Sample summary", startAt: "2026-11-10T17:00:00.000Z", endAt: "2026-11-10T18:00:00.000Z",
    isAllDay: false, isConfirmed: true, potentialDates: null, isDeleted: false, ...over,
  };
}

export function feedPage(over: Partial<FeedPage> = {}): FeedPage {
  return { mode: "today", activityId: null, items: [item()], truncated: false, ...over };
}

/** The feed requests made, as their query strings. */
export const feedCalls = (calls: Call[]) =>
  calls.filter((c) => c.url.startsWith("/calendar/api/updates?")).map((c) => new URL(c.url, "http://staff.example.test").searchParams.toString());

/** Answers the feed's requests; anything else falls through to stubFetch's defaults. */
export const answerFeed = (fn: (params: URLSearchParams) => Response | Promise<Response>) => (url: string) =>
  url.startsWith("/calendar/api/updates?") ? fn(new URL(url, "http://staff.example.test").searchParams) : undefined;

export const renderUpdates = (path = "/calendar/updates") =>
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={[path]}>
        <RequireAuth>
          <Routes>
            <Route path="/calendar" element={<CalendarSection />}>
              <Route path="updates" element={<UpdatesScreen />} />
            </Route>
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
```

Create `apps/staff-web/src/screens/calendar/updates/UpdatesScreen.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { friendlyDateRange, type FeedPage } from "@gcpe/calendar-contract";
import { jsonResponse } from "../../../../test/jsonResponse";
import { ME, stubFetch, type Call } from "../list/fixtures";
import { todayIn } from "../list/dates";
import { answerFeed, feedCalls, feedPage, item, renderUpdates } from "./fixtures";

const TZ = "America/Vancouver";
const entries = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>(".gcpe-updates > li")];
const reset = () => {
  cleanup();
  vi.unstubAllGlobals();
};

describe("the Updates screen (spec addendum §9.1)", () => {
  afterEach(() => {
    reset();
    vi.useRealTimers();
  });

  it("opens on Today's updates: when, who, what, which activity, its title and dates; the summary on hover; no email", async () => {
    const calls: Call[] = [];
    stubFetch(calls, { other: answerFeed(() => jsonResponse(200, feedPage())) });
    const { container } = renderUpdates();
    await screen.findByText("Sample title");
    expect(screen.getByRole("heading", { level: 1, name: "Updates" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Today's updates" })).toBeInTheDocument();
    const [entry] = entries(container);
    expect(entry).toHaveTextContent(
      `Nov 3, 2026 11:00 AM — Robin Staff changed activity HLTH-20001: Sample title (${friendlyDateRange(item(), { timeZone: TZ, today: todayIn(TZ) })})`,
    );
    // The link brings Save and Cancel back to this feed (C149).
    expect(within(entry!).getByRole("link", { name: "HLTH-20001" })).toHaveAttribute("href", "/calendar/activities/20001?return=%2Fcalendar%2Fupdates");
    expect(within(entry!).getByText("Sample title")).toHaveAttribute("title", "Sample summary");
    expect(screen.getByRole("status")).toHaveTextContent("Total 1 item");
    expect(feedCalls(calls)).toEqual(["mode=today"]);
    expect(container.textContent).not.toContain("@");
    expect(document.title).toBe("Updates — GCPE News Staff");
  });

  it("Latest 5 updates and Today's updates are one click away", async () => {
    const calls: Call[] = [];
    stubFetch(calls, { other: answerFeed((p) => jsonResponse(200, feedPage({ mode: p.get("mode") as FeedPage["mode"] }))) });
    renderUpdates();
    await screen.findByText("Sample title");
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "Latest 5 updates" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Latest 5 updates" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Latest 5 updates" })).toHaveAttribute("aria-current", "page");
    await user.click(screen.getByRole("link", { name: "Today's updates" }));
    await screen.findByRole("heading", { level: 2, name: "Today's updates" });
    await waitFor(() => expect(feedCalls(calls)).toEqual(["mode=today", "mode=latest", "mode=today"]));
  });

  it("searches a date range by kind of update and words, and keeps the search in the address", async () => {
    const calls: Call[] = [];
    stubFetch(calls, { other: answerFeed((p) => jsonResponse(200, feedPage({ mode: p.get("mode") as FeedPage["mode"] }))) });
    renderUpdates();
    await screen.findByText("Sample title");
    const type = screen.getByLabelText("Update type") as HTMLSelectElement;
    expect([...type.options].map((o) => o.text)).toEqual(["All", "Changed", "Added", "Deleted", "Reviewed", "Cloned"]);
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("From"));
    await user.type(screen.getByLabelText("From"), "2026-11-01");
    await user.type(screen.getByLabelText("To"), "2026-11-03");
    await user.selectOptions(type, "Added");
    await user.type(screen.getByLabelText("Search for"), "  sample ");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("heading", { level: 2, name: 'Activities added from 2026-11-01 to 2026-11-03 matching "sample"' })).toBeInTheDocument();
    await waitFor(() => expect(feedCalls(calls).at(-1)).toBe("mode=range&from=2026-11-01&to=2026-11-03&type=created&keyword=sample"));
  });

  it("From starts at yesterday in BC time, as legacy's did", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-03T06:30:00Z")); // 23:30 on Nov 2 in BC
    stubFetch([], { other: answerFeed(() => jsonResponse(200, feedPage())) });
    renderUpdates();
    await waitFor(() => expect(screen.getByLabelText("From")).toHaveValue("2026-11-01"));
  });

  it("From after To is caught before any request", async () => {
    const calls: Call[] = [];
    stubFetch(calls, { other: answerFeed(() => jsonResponse(200, feedPage())) });
    renderUpdates();
    await screen.findByText("Sample title");
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("From"));
    await user.type(screen.getByLabelText("From"), "2026-11-20");
    await user.type(screen.getByLabelText("To"), "2026-11-10");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("From must be on or before To.");
    expect(feedCalls(calls)).toEqual(["mode=today"]);
  });

  it("a search naming an activity shows that activity's updates", async () => {
    stubFetch([], { other: answerFeed(() => jsonResponse(200, feedPage({ mode: "activity", activityId: 20001 }))) });
    renderUpdates("/calendar/updates?mode=range&keyword=HLTH-20001");
    expect(await screen.findByRole("heading", { level: 2, name: "Updates for HLTH-20001" })).toBeInTheDocument();
    expect(screen.getByLabelText("Search for")).toHaveValue("HLTH-20001");
  });

  it("one activity's updates by address; one the user can't see is not found", async () => {
    const calls: Call[] = [];
    stubFetch(calls, { other: answerFeed(() => jsonResponse(404, { error: "not found" })) });
    renderUpdates("/calendar/updates?mode=activity&activity=20001");
    expect(await screen.findByText("Activity not found: it doesn't exist, or you can't see it.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Updates for activity 20001" })).toBeInTheDocument();
    expect(feedCalls(calls)).toEqual(["mode=activity&activity=20001"]);
  });

  it("marks a deleted activity's entries", async () => {
    stubFetch([], { other: answerFeed(() => jsonResponse(200, feedPage({ items: [item({ action: "deleted", isDeleted: true })] }))) });
    const { container } = renderUpdates();
    await screen.findByText("Sample title");
    expect(entries(container)[0]).toHaveTextContent("Robin Staff deleted activity HLTH-20001 (deleted): Sample title");
  });

  it("says when nothing matched, when the answer was cut at 1,000, and when it couldn't load", async () => {
    stubFetch([], { other: answerFeed(() => jsonResponse(200, feedPage({ items: [] }))) });
    renderUpdates();
    expect(await screen.findByText("No updates.")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Total 0 items");
    reset();
    stubFetch([], { other: answerFeed(() => jsonResponse(200, feedPage({ truncated: true }))) });
    renderUpdates();
    expect(await screen.findByText("Showing the newest 1,000. Narrow the dates or the search to see older updates.")).toBeInTheDocument();
    reset();
    stubFetch([], { other: answerFeed(() => jsonResponse(500, { error: "boom" })) });
    renderUpdates();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load the updates.");
  });

  it("a hand-edited address is explained, not sent", async () => {
    const cases: [string, string][] = [
      ["?mode=bogus", "That address isn't one of the updates views."],
      ["?mode=range&from=2026-02-30", "Enter dates as YYYY-MM-DD."],
      ["?mode=range&from=2026-11-05&to=2026-11-01", "From must be on or before To."],
      ["?mode=activity&activity=abc", "That address doesn't name an activity."],
      ["?mode=range&type=transferred", "Choose an update type from the list."],
    ];
    for (const [path, message] of cases) {
      const calls: Call[] = [];
      stubFetch(calls, { other: answerFeed(() => jsonResponse(200, feedPage())) });
      renderUpdates(`/calendar/updates${path}`);
      expect(await screen.findByRole("alert"), path).toHaveTextContent(message);
      expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
      expect(feedCalls(calls), path).toEqual([]);
      reset();
    }
  });

  it("only the view asked for last is shown", async () => {
    const calls: Call[] = [];
    let releaseLatest: (r: Response) => void = () => undefined;
    stubFetch(calls, {
      other: answerFeed((p) =>
        p.get("mode") === "latest"
          ? new Promise<Response>((resolve) => {
              releaseLatest = resolve;
            })
          : jsonResponse(200, feedPage({ items: [item({ title: "Sample today" })] })),
      ),
    });
    renderUpdates("/calendar/updates?mode=latest");
    await waitFor(() => expect(feedCalls(calls)).toEqual(["mode=latest"]));
    await userEvent.setup().click(screen.getByRole("link", { name: "Today's updates" }));
    expect(await screen.findByText("Sample today")).toBeInTheDocument();
    releaseLatest(jsonResponse(200, feedPage({ mode: "latest", items: [item({ title: "Sample stale" })] })));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("Sample stale")).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Today's updates" })).toBeInTheDocument();
  });

  it("every Calendar user has an Updates tab in the Calendar's tab row", async () => {
    stubFetch([], { me: { ...ME, role: "Calendar.ReadOnly", level: 1 }, other: answerFeed(() => jsonResponse(200, feedPage())) });
    renderUpdates();
    const tabs = await screen.findByRole("navigation", { name: "Calendar sections" });
    expect(within(tabs).getByRole("link", { name: "Updates" })).toHaveAttribute("aria-current", "page");
    expect(within(tabs).getByRole("link", { name: "Calendar" })).not.toHaveAttribute("aria-current");
  });
});
```

Create `apps/staff-web/src/screens/calendar/updates/a11y.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { jsonResponse } from "../../../../test/jsonResponse";
import { stubFetch } from "../list/fixtures";
import { answerFeed, feedPage, item, renderUpdates } from "./fixtures";

async function seriousViolations(container: Element) {
  const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}

describe("accessibility: the Updates screen in every state", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("entries, a deleted one among them, cut at 1,000", async () => {
    stubFetch([], { other: answerFeed(() => jsonResponse(200, feedPage({ truncated: true, items: [item(), item({ id: 2, action: "deleted", isDeleted: true, title: "Sample gone" })] }))) });
    const { container } = renderUpdates();
    await screen.findByText("Sample gone");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("no entries", async () => {
    stubFetch([], { other: answerFeed(() => jsonResponse(200, feedPage({ items: [] }))) });
    const { container } = renderUpdates("/calendar/updates?mode=latest");
    await screen.findByText("No updates.");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("an activity not found", async () => {
    stubFetch([], { other: answerFeed(() => jsonResponse(404, { error: "not found" })) });
    const { container } = renderUpdates("/calendar/updates?mode=activity&activity=20001");
    await screen.findByText("Activity not found: it doesn't exist, or you can't see it.");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("the feed failing to load", async () => {
    stubFetch([], { other: answerFeed(() => jsonResponse(500, { error: "boom" })) });
    const { container } = renderUpdates();
    await screen.findByText("Couldn't load the updates.");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("the form's own error shown", async () => {
    stubFetch([], { other: answerFeed(() => jsonResponse(200, feedPage())) });
    const { container } = renderUpdates();
    await screen.findByText("Sample title");
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("From"));
    await user.type(screen.getByLabelText("From"), "2026-11-20");
    await user.type(screen.getByLabelText("To"), "2026-11-10");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("From must be on or before To.");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("a hand-edited address", async () => {
    stubFetch([], { other: answerFeed(() => jsonResponse(200, feedPage())) });
    const { container } = renderUpdates("/calendar/updates?mode=bogus");
    await screen.findByText("That address isn't one of the updates views.");
    expect(await seriousViolations(container)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/calendar/updates`
Expected: FAIL. `./url` and `./UpdatesScreen` don't exist ("Failed to resolve import").

- [ ] **Step 4: Implement the address and the call**

Create `apps/staff-web/src/screens/calendar/updates/url.ts`:

```ts
import { FEED_ACTIONS, FEED_KEYWORD_MAX, type FeedAction, type FeedQuery } from "@gcpe/calendar-contract";
import { isValidBcDate } from "../list/dates";

/** What the address asks for, or why it can't be read. No `mode` is Today's updates, the page's opening view (History.aspx). */
export function feedQueryOf(params: URLSearchParams): { query: FeedQuery } | { problem: string } {
  const mode = params.get("mode") ?? "today";
  if (mode === "latest" || mode === "today") return { query: { mode } };
  if (mode === "activity") {
    const a = params.get("activity") ?? "";
    return /^\d{1,9}$/.test(a) && Number(a) > 0 ? { query: { mode, activity: Number(a) } } : { problem: "That address doesn't name an activity." };
  }
  if (mode !== "range") return { problem: "That address isn't one of the updates views." };
  const from = params.get("from") || undefined;
  const to = params.get("to") || undefined;
  const type = params.get("type") || undefined;
  const keyword = (params.get("keyword") ?? "").trim() || undefined;
  if ((from && !isValidBcDate(from)) || (to && !isValidBcDate(to))) return { problem: "Enter dates as YYYY-MM-DD." };
  if (from && to && to < from) return { problem: "From must be on or before To." };
  if (type && !(FEED_ACTIONS as readonly string[]).includes(type)) return { problem: "Choose an update type from the list." };
  if (keyword && keyword.length > FEED_KEYWORD_MAX) return { problem: `Search for at most ${FEED_KEYWORD_MAX} characters.` };
  return { query: { mode, from, to, type: type as FeedAction | undefined, keyword } };
}

/** The address of a view: only what it sets. */
export function paramsOf(q: FeedQuery): URLSearchParams {
  const p = new URLSearchParams({ mode: q.mode });
  if (q.mode === "activity") p.set("activity", String(q.activity));
  if (q.mode === "range") {
    if (q.from) p.set("from", q.from);
    if (q.to) p.set("to", q.to);
    if (q.type) p.set("type", q.type);
    if (q.keyword) p.set("keyword", q.keyword);
  }
  return p;
}
```

Create `apps/staff-web/src/screens/calendar/updates/api.ts`:

```ts
import type { FeedPage, FeedQuery } from "@gcpe/calendar-contract";
import { apiFetch } from "../../../api/client";
import { paramsOf } from "./url";

/** The updates feed's one call (spec addendum §9.1). */
export const feedApi = {
  read: (q: FeedQuery) => apiFetch<FeedPage>(`/calendar/api/updates?${paramsOf(q).toString()}`),
};
```

- [ ] **Step 5: Implement the screen**

Create `apps/staff-web/src/screens/calendar/updates/UpdatesScreen.tsx`. For the form, use the field markup and classes the list's `FilterPanel` uses when you implement this. On `main` today that is `form.gcpe-calendar-filter`, `div.gcpe-field` and `p.gcpe-hint`. Once `fix/staff-usability` lands, it is whatever shared form styles it moved those to. Don't invent new form classes:

```tsx
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Button, InlineAlert } from "@bcgov/design-system-react-components";
import { FEED_KEYWORD_MAX, FEED_MAX_ITEMS, friendlyDateRange, type FeedAction, type FeedItem, type FeedPage, type FeedQuery } from "@gcpe/calendar-contract";
import { ApiError } from "../../../api/client";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { minIdOf } from "../activity/form";
import { listApi } from "../list/api";
import { TitleLink } from "../list/cells";
import { addDaysTo, dateTimeText, todayIn } from "../list/dates";
import { feedApi } from "./api";
import { feedQueryOf, paramsOf } from "./url";

/** Legacy's wording for each kind of update (Activity.aspx.cs:1051-1567). */
const VERB: Record<FeedAction, string> = {
  created: "added activity", updated: "changed activity", reviewed: "reviewed activity", deleted: "deleted activity", cloned: "added new clone",
};
const PAST: Record<FeedAction, string> = { created: "added", updated: "changed", reviewed: "reviewed", deleted: "deleted", cloned: "cloned" };
/** History.aspx's Update type list, in its order. */
const TYPE_OPTIONS: { value: FeedAction | ""; label: string }[] = [
  { value: "", label: "All" }, { value: "updated", label: "Changed" }, { value: "created", label: "Added" },
  { value: "deleted", label: "Deleted" }, { value: "reviewed", label: "Reviewed" }, { value: "cloned", label: "Cloned" },
];

interface FormState {
  from: string;
  to: string;
  type: FeedAction | "";
  keyword: string;
}
const formOf = (q: FeedQuery | null): FormState =>
  q?.mode === "range" ? { from: q.from ?? "", to: q.to ?? "", type: q.type ?? "", keyword: q.keyword ?? "" } : { from: "", to: "", type: "", keyword: "" };

/** The result's heading, as legacy's ("Today's updates:", "Activities changed from … to …", "Updates for Activity …"). */
export function headingOf(q: FeedQuery, page: FeedPage | null): string {
  if (page?.mode === "activity" && page.activityId !== null) {
    const first = page.items[0];
    return `Updates for ${first ? minIdOf({ id: page.activityId, ministryAbbreviation: first.ministryAbbreviation }) : `activity ${page.activityId}`}`;
  }
  switch (q.mode) {
    case "latest":
      return "Latest 5 updates";
    case "today":
      return "Today's updates";
    case "activity":
      return `Updates for activity ${q.activity}`;
    case "range": {
      let text = `Activities ${q.type ? PAST[q.type] : "updated"}`;
      if (q.from) text += ` from ${q.from}`;
      if (q.to) text += ` to ${q.to}`;
      if (q.keyword) text += ` matching "${q.keyword}"`;
      return text;
    }
  }
}

function FeedEntry({ item, timeZone, today }: { item: FeedItem; timeZone: string; today: string }): React.JSX.Element {
  return (
    <li>
      <time dateTime={item.at}>{dateTimeText(item.at, timeZone)}</time>
      {` — ${item.actorName} ${VERB[item.action]} `}
      <TitleLink id={item.activityId}>{minIdOf({ id: item.activityId, ministryAbbreviation: item.ministryAbbreviation })}</TitleLink>
      {item.isDeleted ? " (deleted): " : ": "}
      <span title={item.details || undefined}>{item.title}</span>
      {` (${friendlyDateRange(item, { timeZone, today })})`}
    </li>
  );
}

/** Calendar → Updates (History.aspx; spec addendum §9.1): recent changes to the activities this user can see. */
export function UpdatesScreen(): React.JSX.Element {
  useDocumentTitle("Updates");
  const [params, setParams] = useSearchParams();
  const search = params.toString();
  const parsed = feedQueryOf(params);
  const query = "query" in parsed ? parsed.query : null;
  const [startedOnRange] = useState(query?.mode === "range");
  const [timeZone, setTimeZone] = useState<string | null>(null);
  const [configFailed, setConfigFailed] = useState(false);
  const [loaded, setLoaded] = useState<{ search: string; page?: FeedPage; failure?: "not_found" | "error" } | null>(null);
  const [form, setForm] = useState<FormState>(() => formOf(query));
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    listApi.config().then(
      (c) => {
        if (!live) return;
        setTimeZone(c.timeZone);
        // Legacy's From starts at yesterday (History.aspx), unless the address already holds a range.
        if (!startedOnRange) setForm((f) => (f.from ? f : { ...f, from: addDaysTo(todayIn(c.timeZone), -1) }));
      },
      () => {
        if (live) setConfigFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [startedOnRange]);

  useEffect(() => {
    const p = feedQueryOf(new URLSearchParams(search));
    if (!("query" in p)) return;
    if (p.query.mode === "range") setForm(formOf(p.query));
    let live = true;
    feedApi.read(p.query).then(
      (page) => {
        if (live) setLoaded({ search, page });
      },
      (e: unknown) => {
        if (live) setLoaded({ search, failure: e instanceof ApiError && e.status === 404 ? "not_found" : "error" });
      },
    );
    return () => {
      live = false;
    };
  }, [search]);

  const current = loaded?.search === search ? loaded : null;
  const page = current?.page ?? null;
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (form.from && form.to && form.from > form.to) return setFormError("From must be on or before To.");
    setFormError(null);
    setParams(paramsOf({ mode: "range", from: form.from || undefined, to: form.to || undefined, type: form.type || undefined, keyword: form.keyword.trim() || undefined }));
  };

  return (
    <div className="gcpe-updates-page">
      <h1>Updates</h1>
      <nav aria-label="Updates views" className="gcpe-updates-views">
        <ul>
          <li>
            <Link to="/calendar/updates?mode=latest" aria-current={query?.mode === "latest" ? "page" : undefined}>
              Latest 5 updates
            </Link>
          </li>
          <li>
            <Link to="/calendar/updates" aria-current={query?.mode === "today" ? "page" : undefined}>
              Today&apos;s updates
            </Link>
          </li>
        </ul>
      </nav>
      <form aria-label="Filter updates" className="gcpe-calendar-filter" onSubmit={submit} noValidate>
        <fieldset>
          <legend>Filter by date range</legend>
          <div className="gcpe-field">
            <label htmlFor="updates-from">From</label>
            <input id="updates-from" type="date" value={form.from} onChange={(e) => set("from", e.target.value)} />
          </div>
          <div className="gcpe-field">
            <label htmlFor="updates-to">To</label>
            <input id="updates-to" type="date" value={form.to} onChange={(e) => set("to", e.target.value)} />
          </div>
        </fieldset>
        <div className="gcpe-field">
          <label htmlFor="updates-type">Update type</label>
          <select id="updates-type" value={form.type} onChange={(e) => set("type", e.target.value as FeedAction | "")}>
            {TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="gcpe-field">
          <label htmlFor="updates-keyword">Search for</label>
          <input
            id="updates-keyword"
            type="search"
            maxLength={FEED_KEYWORD_MAX}
            value={form.keyword}
            aria-describedby="updates-keyword-hint"
            onChange={(e) => set("keyword", e.target.value)}
          />
          <p id="updates-keyword-hint" className="gcpe-hint">
            Words in the title or summary, or the name of who made the change. An activity number above 10,000 (such as HLTH-20001) shows that activity&apos;s updates.
          </p>
        </div>
        {formError && <p role="alert">{formError}</p>}
        <Button type="submit">Search</Button>
      </form>
      <section aria-labelledby="updates-result">
        <h2 id="updates-result">{query ? headingOf(query, page) : "These updates can't be shown"}</h2>
        {"problem" in parsed && <InlineAlert variant="danger" role="alert" description={parsed.problem} />}
        {(configFailed || current?.failure === "error") && <InlineAlert variant="danger" role="alert" description="Couldn't load the updates." />}
        {current?.failure === "not_found" && <p>{"Activity not found: it doesn't exist, or you can't see it."}</p>}
        {query && !configFailed && !current?.failure && !(page && timeZone) && <p>Loading…</p>}
        {page && timeZone && !configFailed && (
          <>
            <p role="status">{`Total ${page.items.length} ${page.items.length === 1 ? "item" : "items"}`}</p>
            {page.truncated && <p>{`Showing the newest ${FEED_MAX_ITEMS.toLocaleString("en-CA")}. Narrow the dates or the search to see older updates.`}</p>}
            {page.items.length === 0 ? (
              <p>No updates.</p>
            ) : (
              <ol className="gcpe-changes gcpe-updates">
                {page.items.map((i) => (
                  <FeedEntry key={i.id} item={i} timeZone={timeZone} today={todayIn(timeZone)} />
                ))}
              </ol>
            )}
          </>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 6: The tab, the route and the styles**

`apps/staff-web/src/screens/calendar/CalendarSection.tsx`: in the tab row's `<ul>`, right after the `<li>` holding `<NavLink to="/calendar" end>Calendar</NavLink>`, add:

```tsx
          <li>
            <NavLink to="/calendar/updates">Updates</NavLink>
          </li>
```

`apps/staff-web/src/router.tsx`: add `import { UpdatesScreen } from "./screens/calendar/updates/UpdatesScreen";` after the `ChangesRoute` import, and in the `calendar` children, after `{ path: "activities/:id/changes", element: <ChangesRoute /> },`:

```tsx
          { path: "updates", element: <UpdatesScreen /> },
```

`apps/staff-web/src/styles/global.css`, after the `.gcpe-changes h2` rule:

```css
.gcpe-updates-views ul {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  list-style: none;
  padding: 0;
}
.gcpe-updates-views a {
  display: inline-block;
  min-height: 24px;
  padding: 0.25rem 0;
}
.gcpe-updates time {
  font-weight: 600;
}
```

- [ ] **Step 7: Run the tests to see them pass, type-check, and run the affected e2e specs**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/calendar`
Expected: PASS: the new `updates/*` tests and every existing Calendar screen test, including `screens/calendar/a11y.test.tsx` with the new tab.
Run both type-checks: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json` and `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p apps/staff-web/tsconfig.json`
Expected: no errors.
Run: `npx -y -p node@24 -- npm run test:e2e -- tests/e2e/calendar-list.spec.ts tests/e2e/axe-sweep.spec.ts`
Expected: PASS. The tab row gained a link, and nothing else on those pages changed.

- [ ] **Step 8: Commit**

```bash
git add apps/staff-web/src/screens/calendar/updates apps/staff-web/src/screens/calendar/CalendarSection.tsx apps/staff-web/src/router.tsx apps/staff-web/src/styles/global.css
git commit -m "feat(staff-web): Calendar → Updates: today's, the latest five, a date range, one activity"
```

---

### Task 5: End to end for each role; the axe sweep; parity, questions, running notes, deploy notes and carry-forward

Covers: spec §3 row 5f's exit check, end to end. §16 acceptance 2 (the feed: a confidential activity is invisible to an HQ Editor outside its ministries), 9 (the feed's modes, no email) and 18 (axe). Carry-forward § 5f (the link returns to the feed). Decisions F1–F13 recorded as C181–C183, Q60 and Q61.

**Files:**
- Create: `tests/e2e/calendar-updates.spec.ts`.
- Modify: `tests/e2e/axe-sweep.spec.ts`, `docs/parity/changes-from-legacy.md`, `docs/parity/open-questions.md`, `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`, `docs/superpowers/plans/phase-5-carry-forward.md`.

**Interfaces:**
- Consumes: everything above; `listFixture`, `sessionOf`, `useCookie`, `Key`, `ListFixture` (`calendar-support.ts`); `baseUrl`, `expectNoSeriousA11yViolations` (`playwright-support.ts`); the `CAL_*_EMAIL` constants.
- Produces: nothing new for code.

- [ ] **Step 1: Write the spec**

Create `tests/e2e/calendar-updates.spec.ts`:

```ts
// The 5f exit check end to end: the updates feed as several Calendar roles over the shared list
// fixture (A Health, B Health confidential, C Finance, D Finance confidential, E Finance
// confidential shared with Health, F Health deleted), each "added activity" by the HQ
// Administrator who builds it, plus F's deletion. The full role matrix runs on real Postgres in
// apps/calendar/src/http/feed-routes.test.ts.
import { test, expect, type Page } from "@playwright/test";
import { CAL_EDITOR_EMAIL, CAL_HQ_ADMIN_EMAIL, CAL_HQ_EDITOR_EMAIL, CAL_READONLY_EMAIL } from "./constants";
import { listFixture, sessionOf, useCookie, type Key, type ListFixture } from "./calendar-support";
import { baseUrl, expectNoSeriousA11yViolations } from "./playwright-support";

const updatesUrl = (q: Record<string, string> = {}) => {
  const s = new URLSearchParams(q).toString();
  return `${baseUrl()}/hub/calendar/updates${s ? `?${s}` : ""}`;
};
const entries = (page: Page) => page.locator(".gcpe-updates > li");
const ABBR: Record<Key, string> = { A: "HLTH", B: "HLTH", C: "FIN", D: "FIN", E: "FIN", F: "HLTH" };
const added = (f: ListFixture, k: Key) =>
  new RegExp(`Test Calendar HQ Administrator added activity ${ABBR[k]}-${f.ids[k]}${k === "F" ? " \\(deleted\\)" : ""}: Vis ${k} ${f.tag}`);

test.describe("the updates feed, as each role (spec addendum §3 row 5f, §9)", () => {
  const roles: [string, string, Key[]][] = [
    ["Editor (Health)", CAL_EDITOR_EMAIL, ["E", "B", "A"]],
    ["Read Only (Finance)", CAL_READONLY_EMAIL, ["E", "D", "C"]],
    ["HQ Editor", CAL_HQ_EDITOR_EMAIL, ["C", "A"]],
  ];
  for (const [who, email, keys] of roles) {
    test(`${who}: only activities they can see; confidential ones only for their own ministries; no deleted ones`, async ({ page, context }) => {
      const f = await listFixture();
      await useCookie(context, await sessionOf(email));
      await page.goto(updatesUrl({ mode: "range", keyword: f.tag }));
      await expect(entries(page)).toHaveText(keys.map((k) => added(f, k)));
      await expect(page.locator(".gcpe-updates")).not.toContainText("@");
    });
  }

  test("HQ Administrator: every activity, the deleted one marked, and its deletion", async ({ page, context }) => {
    const f = await listFixture();
    await useCookie(context, await sessionOf(CAL_HQ_ADMIN_EMAIL));
    await page.goto(updatesUrl({ mode: "range", keyword: f.tag }));
    await expect(page.getByRole("heading", { level: 2, name: `Activities updated matching "${f.tag}"` })).toBeVisible();
    await expect(entries(page)).toHaveText([
      new RegExp(`Test Calendar HQ Administrator deleted activity HLTH-${f.ids.F} \\(deleted\\): Vis F ${f.tag}`),
      ...(["F", "E", "D", "C", "B", "A"] as const).map((k) => added(f, k)),
    ]);
    await expectNoSeriousA11yViolations(page, "the updates feed, a search as an HQ Administrator");
  });

  test("Editor: an entry's link opens the activity, and Cancel comes back to the same updates (C149)", async ({ page, context }) => {
    const f = await listFixture();
    await useCookie(context, await sessionOf(CAL_EDITOR_EMAIL));
    await page.goto(updatesUrl({ mode: "range", keyword: f.tag }));
    await expect(entries(page)).toHaveCount(3);
    const here = page.url();
    await entries(page).getByRole("link", { name: `HLTH-${f.ids.A}` }).click();
    await expect(page.getByRole("heading", { level: 1, name: `Activity HLTH-${f.ids.A}` })).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page).toHaveURL(here);
    await expect(entries(page)).toHaveCount(3);
  });

  test("HQ Editor: one activity's updates by address; another ministry's confidential activity is not found", async ({ page, context }) => {
    const f = await listFixture();
    await useCookie(context, await sessionOf(CAL_HQ_EDITOR_EMAIL));
    await page.goto(updatesUrl({ mode: "activity", activity: String(f.ids.C) }));
    await expect(page.getByRole("heading", { level: 2, name: `Updates for FIN-${f.ids.C}` })).toBeVisible();
    await expect(entries(page)).toHaveText([added(f, "C")]);
    await page.goto(updatesUrl({ mode: "activity", activity: String(f.ids.B) }));
    await expect(page.getByText("Activity not found: it doesn't exist, or you can't see it.")).toBeVisible();
    await expectNoSeriousA11yViolations(page, "the updates feed, an activity not found");
  });

  test("opens on Today's updates from the tab row; Latest 5 is one click away", async ({ page, context }) => {
    await listFixture();
    await useCookie(context, await sessionOf(CAL_HQ_ADMIN_EMAIL));
    await page.goto(`${baseUrl()}/hub/calendar`);
    await page.getByRole("navigation", { name: "Calendar sections" }).getByRole("link", { name: "Updates" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Today's updates" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: /^Total \d+ items?$/ })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "Today's updates");
    await page.getByRole("link", { name: "Latest 5 updates" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Latest 5 updates" })).toBeVisible();
    await expect(entries(page)).toHaveCount(5);
  });
});
```

`tests/e2e/axe-sweep.spec.ts`, in the test "the Calendar: landing, lookups, users, Transfer, undelivered events":
- Add `"/hub/calendar/updates"` to the `for (const path of [...])` list, after `"/hub/calendar"`.
- After the existing line `if (path === "/hub/calendar") await expect(...)…;`, add:

```ts
      if (path === "/hub/calendar/updates") await expect(page.getByRole("status").filter({ hasText: /^Total \d+ items?$/ })).toBeVisible();
```

- [ ] **Step 2: See the spec fail once, then pass, then run the full suites**

The spec exercises Tasks 1–4's code, so it passes as written. To show it can fail, change the HQ Editor's expected keys `["C", "A"]` to `["C", "B", "A"]`. Run it and see that test FAIL on `toHaveText`, which proves the confidential activity B is really absent. Then restore it.
Run: `npx -y -p node@24 -- npm run test:e2e -- tests/e2e/calendar-updates.spec.ts tests/e2e/axe-sweep.spec.ts`
Expected: PASS.
Run: `npx -y -p node@24 -- npm run test:e2e`
Expected: PASS, every spec.
Run the full Vitest suite: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run`. Then run both `tsc` commands.
Expected: PASS, no errors.

- [ ] **Step 3: The parity rows and the questions**

`docs/parity/changes-from-legacy.md`, in the "Corporate Calendar (Phase 5)" section:
- C127's Status: `Agreed (rule built in 5c-1; the list, its id search and the Excel export in 5d; the activity page and attachments in 5e; the updates feed in 5f; reports in 5g)`.
- C135's Status: `Agreed (built in 5f)`.
- Append after the last Phase 5 row:

```markdown
| C181 | The updates feed showed every entry of an activity led by or shared with the user's ministries, whatever the activity now was: confidential ones (C127), and the "deleted activity" entry to the owning ministry (`GetCorpCalendarUpdates*.sql`). HQ saw everything. | An entry shows only while its activity passes `visible()` as it stands now. A deleted activity's entries, its deletion included, show only to HQ Administrators, marked "(deleted)". An activity made confidential, moved to another ministry or unshared takes its older entries with it. An entry that changed only Look Ahead fields shows only to those who see that fieldset, as on View changes. Transfers and Clear LA Status stay out of the feed, as in legacy (Q60). | R2: one visibility rule for every reader; a deleted activity is HQ Administrators' to review (spec addendum §6). | Proposed (Q61) |
| C182 | Each feed entry was HTML stored when the change was made: the actor's name as a `mailto:` link, and the ministry and title as they were then. Start and end dates were the current ones (`Activity.aspx.cs:1594-1625`, `CorporateCalendarUpdateWebService.asmx.cs:93-124`). | Built from history when shown: the time, the actor's name as stored then, and legacy's wording ("added activity", "changed activity", "reviewed activity", "deleted activity", "added new clone"). Then the `MIN-Id` link and the activity's current title and dates, with its current summary as the title's tooltip. No email and no field values. The link brings Save and Cancel back to the same feed (C149). | C135; the activity's own row is the one source of its text, and the visibility rule already gates it. | Proposed |
| C183 | The keyword was matched in memory against the stored HTML: the actor's name and email, the ministry, the id and the title at the time. The summary was not matched, despite the code's comment. A number above 10,000 after the last "-" jumped to that activity's entries with no visibility check (C127). Only the date range was capped (1,000). "Today" was the web server's day. | The keyword matches the activity's current title and summary and the name of who made the change, ignoring case and literally, inside `visible()`. A number above 10,000, bare or after "ABBR-", shows that activity's entries if the user can see it, and "not found" otherwise. "COVID-19" and "2026" are searched as words. Every view answers at most 1,000 entries, newest first, and says when it was cut. Days are whole BC days by the database's clock, From and To included. | Search runs in SQL inside the visibility rule, and the answer is bounded. The spec named title and details; the actor's name is kept because legacy's stored text held it. | Proposed |
```

`docs/parity/open-questions.md`, in "## Open", after Q59:

```markdown
| Q60 | Should **Transfer** and **Clear LA Status** appear in the Calendar's updates feed? Legacy wrote no feed entry for either. | One Clear LA Status click writes an entry for every activity it clears, possibly hundreds, and would push everything else out of "Latest 5 updates". A Transfer moves many activities at once. | No: both stay on each activity's "View changes" only (C181). Adding them is one line (`FEED_ACTIONS`, `packages/calendar-contract/src/feed.ts`). | 2026-10-10 |
| Q61 | Should a ministry still see in the updates feed that **its own activity was deleted**? Legacy showed it the "deleted activity" entry. | Under the one visibility rule (R2), a deleted activity is visible only to HQ Administrators, so the ministry loses that line and the activity's older entries. | No, as R2: HQ Administrators see deletions, marked "(deleted)". The ministry sees the activity leave its list. | 2026-10-10 |
```

- [ ] **Step 4: Running notes, deploy notes, carry-forward**

`docs/manuals/running-notes.md`, append:

```markdown
## Phase 5f — Updates feed

- **All Calendar users** — Calendar → Updates lists recent changes to the activities you can see. It opens on today's updates. "Latest 5 updates" shows the five newest.
- **All Calendar users** — "Filter by date range" finds updates between two dates. From starts at yesterday, and both dates are included; leave either blank to leave that end open. Narrow it further by Update type (Changed, Added, Deleted, Reviewed, Cloned) and by words in the activity's title or summary, or the name of who made the change.
- **All Calendar users** — Type an activity's number above 10,000 (such as HLTH-20001) in "Search for" to see just that activity's updates. Shorter numbers and words like "COVID-19" are searched as text.
- **All Calendar users** — Each line links to its activity. Save or Cancel there brings you back to the same updates.
- **All Calendar users** — Hover over an activity's title in the feed to see its summary. The title and dates shown are the activity's current ones.
- **All Calendar users** — At most 1,000 updates show at once. The page says when there were more: narrow the dates or the search.
- **All Calendar users** — The feed starts empty at cutover. Older changes are on each activity's "View changes", marked "from legacy log".
- **All Calendar users** — Transfers and Clear LA Status don't appear in the feed, as in the old Calendar. See the activity's "View changes".
- **Calendar editors** — When an activity is made confidential, moved to another ministry or deleted, its updates leave the feed for anyone who can no longer see it.
- **HQ Editor and above** — Changes to an activity's Look Ahead fields show as "changed activity" only to people who see the Look Ahead fieldset.
- **HQ Administrator** — Deleted activities' updates, the deletion included, show marked "(deleted)". The link opens the activity read-only, with Review.
```

`docs/deploy/siteground.md`, after "### Activity page (Phase 5e-2)", add:

```markdown
### Updates feed (Phase 5f)

**No migration.** Nothing to configure.

**Hand checks on boxs.ca after deploy** (spec §16 acceptance 2 and 9):

1. As cal-editor: Hub → Calendar → Updates shows "Today's updates". Change a scratch activity's title and it heads "Latest 5 updates", worded "Test Calendar Editor changed activity HLTH-<id>: …", with no email anywhere.
2. Click that entry's `HLTH-<id>`, then Cancel: you are back on the same updates.
3. As cal-hq-editor: a Health activity marked confidential by cal-editor doesn't appear in any view, and `?mode=activity&activity=<its id>` says "Activity not found".
4. As cal-hq-admin: delete a scratch activity. Its entries show "(deleted)", and the deletion is listed. As cal-editor they are gone.
5. On boxs.ca new activity ids are small, so typing one in "Search for" searches text. Use `?mode=activity&activity=<id>` instead. Production ids are legacy-sized (above 10,000).
```

`docs/superpowers/plans/phase-5-carry-forward.md`: delete the whole "## 5f" section (its one item is built in Tasks 4 and 5).

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/calendar-updates.spec.ts tests/e2e/axe-sweep.spec.ts docs/parity/changes-from-legacy.md docs/parity/open-questions.md docs/manuals/running-notes.md docs/deploy/siteground.md docs/superpowers/plans/phase-5-carry-forward.md
git commit -m "test(e2e),docs: the updates feed as each role; axe sweep; parity C181-C183, Q60, Q61; running notes"
```

---

## Phase 5f at a glance

| Task | Delivers | Exit evidence |
|---|---|---|
| 1 | The feed's contract: kinds, views, limits, query schema | `feed.test.ts` |
| 2 | `readFeed` and `GET /calendar/api/updates`: views, the role matrix, one activity, the Look Ahead rule | `feed-routes.test.ts` (every role, confidential and deleted; each view from the fixture; day edges; visibility changes) |
| 3 | Keyword, activity-number switch, the 1,000 cap, input bounds | `feed-search.test.ts` |
| 4 | Calendar → Updates: the screen, its tab and route | `url.test.ts`, `UpdatesScreen.test.tsx`, `a11y.test.tsx`; list and axe e2e green |
| 5 | E2E for each role; the axe sweep; docs | `calendar-updates.spec.ts`; full e2e green |

## Risks and things to watch

- **Merging with `fix/staff-usability`.** Both branches edit `CalendarSection.tsx`'s tab row and append to `global.css`. Keep both sides. After the rebase, re-run `screens/calendar` Vitest and `axe-sweep.spec.ts`. If the usability pass renames the list filter's `gcpe-calendar-filter`, `gcpe-field` or `gcpe-hint` classes, rename them here in the same way. The tests select by role and label, not by those classes.
- **Query cost is unmeasured.**
  - Latest 5 and Today walk `activity_changes_at_idx` newest first, with `visibleSql` and the Look Ahead subqueries per row.
  - A keyword search over all dates scans history joined to activities.
  - The feed starts empty at cutover, so its volume grows from zero. Time "Latest 5" and a no-date keyword search on boxs.ca once history has built up. If one passes about 500 ms, an index on `(source, at)` (a drizzle-kit migration) is the first remedy.
- **Case-folding of non-ASCII letters** in the keyword depends on the database locale, as for the list's quick search (Q58).
- **The title tooltip** (the summary) isn't reachable by keyboard alone, as with the list's significance tooltip. The summary is on the activity page one click away.
- **E2E "Today" near BC midnight.** The fixture's entries are made when the suite starts. The "Today's updates" test asserts only that a total is shown, and "Latest 5" always has five entries, so a run that crosses midnight still passes.
- **Not checked here:**
  - the Look Ahead rule with `ShowHqCommentsField` on, end to end (BC has it off; Task 2 covers it on Postgres);
  - screen magnification and Windows High Contrast, which axe doesn't cover;
  - the feed's speed at volume (above).

## Self-review (done while writing)

1. **Spec coverage.**
   - §9.1 Source (`calendar` only; starts empty) → Task 2 ("leaves out … imported legacy log entries").
   - Latest 5, Today, the date range with type → Task 2.
   - The keyword over title and details, plus the actor (F5) → Task 3.
   - Above 10,000 switches, within `visible()` → Task 3.
   - Per activity → Tasks 2 and 4.
   - At most 1,000 → Task 3. No "since last visit" → Task 1 (refused mode).
   - Each item's content → Tasks 2 (shape) and 4 (rendering). No email → Tasks 2, 4 and 5. Scope `visible()` → Task 2's matrix.
   - §3 row 5f's exit check → Task 2 (every role × confidential × deleted, each view from the fixture) and Task 5 (end to end).
   - §6 "not visible means 404" → Tasks 2 and 3.
   - §16 acceptance 2 (feed), 9 and 18 → Tasks 4 and 5.
   - Carry-forward § 5f → Tasks 4 and 5, deleted in Task 5.
2. **Placeholder scan.** None. Every code step carries its code, and every docs step carries its text. The one conditional instruction (follow the usability pass's renamed form classes, if any) names the exact file to copy from.
3. **Type consistency.**
   - `FeedQuery`, `FeedPage`, `FeedItem`, `FEED_ACTIONS`, `FEED_MAX_ITEMS`, `FEED_KEYWORD_MAX` and `FEED_LATEST_COUNT` (Task 1) are used with the same names in Tasks 2–4.
   - `readFeed(deps, actor, q)` (Task 2) is extended, not renamed, in Task 3.
   - `seedFeed`, `addEntry`, `bcAt`, `FEED_IDS` and `feedKeyOf` (Task 2's `feed-world.ts`) are imported unchanged in Task 3.
   - `feedQueryOf` and `paramsOf` (Task 4) are used by `api.ts` and the screen.
   - The CSS hook `.gcpe-updates > li` is the same in the screen, its tests and the e2e spec.
4. **Review Focus.** Each of the five has a named test in its owning task: 1 and 2 in Task 3, 3 and 5 in Task 2, 4 in Task 4.
5. **Dry run (2026-10-10, at `9e3dc5b`).** Every code block above was applied to the worktree, run, and then reverted. Only this plan is committed.
   - Tasks 1–2: 15 tests pass.
   - Task 3's tests against Task 2's code: 7 of 9 fail as Step 2 says. After Task 3's change, all 39 tests in the feed and `list/query` files pass.
   - Task 4: `screens/calendar` 290 tests and `updates/*` 22 tests pass.
   - Both `tsc` runs are clean.
   - `calendar-updates.spec.ts`: 7 pass against the local stack.
   - Not run in the dry run: the full e2e suite and `axe-sweep.spec.ts` with the added path.

## Execution

Execution method: subagent-driven, as the 5e plans were. A fresh implementer and reviewer per task, then a whole-branch review. Tasks 1–3 are server work with exact expectations. Tasks 4–5 depend on 1–3's interfaces.
