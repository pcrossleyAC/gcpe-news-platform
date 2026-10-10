# Phase 5c-1: Calendar Activity Rules and the Activity API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Calendar gains its activity API (create, read, update, clone, delete, review, review selected, Clear LA Status, edit locks and field history), with legacy's rules enforced on the server. Those rules are: one `visible()` rule written in TypeScript and in SQL, which agree on a generated matrix; one validation schema shared with the future editor; the 23 needs-review flags, tested row by row from legacy's trigger table; Look Ahead section inference; the 16:00–17:00 BC change freeze, correct across BC's switch to permanent UTC−7 on 2026-11-01; edit locks that lapse after 15 idle minutes; a version check on every write; and an `activity.*` event in the outbox with every write.

**Architecture:**
- **`@gcpe/calendar-contract`** (new, zod only, browser-safe like `@gcpe/nrms-contract`). It holds the rules both the server and the 5e editor run:
  - the activity input schema and `checkActivity` (spec §7.2, C156);
  - Look Ahead inference and `sectionToStore` (§7.6);
  - the freeze window and its message (§7.4);
  - the enums, the history field labels and the view types.
- **Tenant config:** `packages/config` gains the `calendar` section (§5.1), with BC's values in `config/tenants/bc.json`. The Calendar refuses to start without it.
- **`apps/calendar` server modules:**
  - `visibility.ts`: `visible()` and `visibleSql()`.
  - `capabilities.ts`: the §6 capability table.
  - `time.ts`: the database clock and BC wall-clock conversion through Node 24's tzdata.
  - `freeze.ts`.
  - `activities/`: the store, reference resolution, history, events, needs-review rules, and one file per action.
  - `http/activity-routes.ts` and `http/config-routes.ts`.
- **Write path, the same for every action:**
  1. the activity's advisory lock (`calendar-activity:<id>`);
  2. the row `FOR UPDATE`;
  3. re-check visibility (404), the capability (403), the freeze (423), someone else's live edit lock (423) and the version (409);
  4. validate (422);
  5. write the row and its joins, bump `version`, write history, enqueue `activity.*`;
  6. commit, all in one transaction.

  Bulk actions run in sorted-id batches of 100 activities per transaction.
- **Stack:**
  - a Calendar → NRMS event route for `activity.*`, which NRMS ignores until 5h;
  - a `calendar.lock-sweep` tick step.

**Tech Stack:** Node 24 (tzdata ≥ 2026b), TypeScript 5.9 strict, Express 5, Drizzle 0.45, zod 3.25, Vitest 4.1, supertest, real Postgres through `@gcpe/db-kit`'s `createTestDatabase`.

**Spec:** `docs/superpowers/specs/2026-10-07-calendar-parity-design.md`. The parts this plan uses:
- §3, row 5c, and its exit check:
  - rule tests generated from the trigger table;
  - lock and concurrency tests on real Postgres;
  - freeze-clock tests across 2026-11-01;
  - `visible()` and its SQL predicate agreeing on a generated matrix.
- §5.1, the tenant config, the lock sweep and the dead-letter page. The dead-letter page is 5c-2's.
- §5.4, the `activity.*` payloads.
- §6, visibility and capabilities.
- All of §7.
- §8.3, the history read API only; the screen is 5e's.
- §13 for volumes, and §14–§16.

The plan also takes these other documents into account:
- **The carry-forward.** `docs/superpowers/plans/phase-5-carry-forward.md`, § 5c. "Carry-forward items taken" below says which items this plan takes and which it leaves for 5c-2.
- **The 5b plans.** They hold the app, schema, projections, actor, lookups and users that this plan builds on:
  - `docs/superpowers/plans/2026-10-08-phase-5b-calendar-skeleton.md`;
  - `docs/superpowers/plans/2026-10-08-phase-5b2-calendar-users-and-report-spike.md`.
- **Legacy sources.** These were read for structure and rules only. No legacy data is copied.
  - `Calendar/Activity.aspx.cs` and `Activity.aspx`;
  - `ActivityManager.cs`, `ActivityWebService.cs` and `ActivityHandler.ashx.cs`;
  - `ChangeFreezeWindowHandler.ashx.cs` and `Admin/Transfer.aspx.cs`.

**Companion plan:** `docs/superpowers/plans/2026-10-08-phase-5c2-transfer-and-dead-letters.md` (5c-2). It covers Transfer, the deactivation preview, the dead-letter page and their staff-web screens. **This plan (5c-1) comes first.** 5c-2 needs this plan's store, history, events, `visibleSql` and batching.

**Base:**
- **Branch:** `feat/phase-5c` in `/Users/paul/gcpe-news-platform-p5c`. It is stacked on `feat/phase-5b` (5a, 5b-1 and 5b-2 finished) at `0be0d2b`. Every path below is repo-relative.
- **Line numbers** are against `0be0d2b`. If anything has moved, find it again by symbol.
- **Migrations:** the Calendar's last migration is `0000_init`. **This plan adds none.** Every table it writes exists already. Task 1 Step 6 proves that the moved constants change no DDL.

**What the code does today** (`0be0d2b`, verified by reading):
- **The schema.** `apps/calendar/src/db/schema.ts` holds every §5.2 table, including:
  - `activities` with `version` and `needs_review` (a text array with a `<@` CHECK against the 23 keys, but no de-duplication);
  - the nine join tables, `activity_changes`, `activity_change_fields` and `activity_locks` (activity, user, tab, acquired, last active).

  The enums `ACTIVITY_STATUSES`, `HQ_STATUSES`, `HQ_SECTIONS`, `NEEDS_REVIEW_KEYS` and `CHANGE_ACTIONS` are defined there (`:16-35`).
- **Activities.** Nothing reads or writes an activity yet. `apiRoutes(db)` mounts `/me`, `lookupRoutes(db)` and `userRoutes(db)` (`apps/calendar/src/http/routes.ts`).
- **The app and its dispatcher.**
  - `createApp({ db, auth, eventSecrets })` mounts `/api` behind `requireBearer` and `requireCalendarActor` (`apps/calendar/src/app.ts`).
  - `startCalendar` loads the tenant config only for `assertTimeZoneRules`. It wires `dispatchOnce` with `parseSubscribers(EVENT_SUBSCRIBERS)` (`apps/calendar/src/start.ts`).
- **The actor.** `CalendarActor` is `{ userId, displayName, role, level, ministryKeys, isHq }`, re-read from the projection on every request (`apps/calendar/src/actor.ts`).
  - Ministry keys are byte-exact (`projections.ts` doesn't case-fold them).
  - User ids are lowercased.
- **Keywords.** `lookups.ts` creates rows under `pg_advisory_xact_lock(hashtext('calendar-lookup:<name>'))`. That lock function, `lockLookup`, is private (`:118-120`).
- **The stack.**
  - Core → Calendar is the only Calendar route (`apps/stack/src/env.ts:284-288`).
  - The tick runs `calendar.dispatch` when the Calendar is configured (`apps/stack/src/stack.ts:462`).
  - The NRMS → News API route is `"*"` (`env.ts:289`). It is NRMS's own route; this plan adds no route to the News API.
- **Contracts.** `packages/events/src/catalogue.ts:225-262` defines `activityRecordSchema` (strict), the strict id-only `confidentialActivitySchema`, and `activityDeletedSchema` (`{ id }`).
- **Time.** `packages/config/src/timezone.ts` has `wallClockToInstant`. `config/tenants/bc.json` pins `timeZoneCheck` at `2027-01-15T19:00:00Z → -07:00`, so a Node with stale tzdata refuses to start.
- **No dead-letter page exists** anywhere. A grep for `dead-letter|deadLetter` finds only `packages/events` and the README.
- **Legacy facts the rules come from:**
  - **Needs-review and status.**
    - **Flags:** `Activity.aspx.cs:1129-1265` and `ActivityManager.cs:97-254`. Premier Requested, Distribution, Event planner and Digital flag only on a new non-empty value.
    - **Status:** set by `Activity.aspx.cs:1179-1196` on changes to Confirmed, All Day, Cross-Government, Premier Requested, Distribution and Origin.
    - **Review** clears 22 flags (`ActivityManager.cs:21-75`); on a deleted activity it clears only `IsActiveNeedsReview`.
  - **Look Ahead inference** (`Activity.aspx:2427-2546`). For a confidential activity, legacy keeps the section if one is already checked. A section that differs from the inference when the page loads is an override, and later inference never replaces it.
  - **Clone** (`ActivityWebService.cs:72-140`) copies a fixed field list. That list leaves out Event planner, Digital and Translations.
  - **Clear LA Status** (`ActivityHandler.ashx.cs:1258-1274`) clears `HqStatusId` where `StartDateTime <= DateTime.Today.AddDays(N)`.
  - **Transfer** (`Admin/Transfer.aspx.cs:29-90`) moves every `IsActive` activity of contact A, past ones included. It is 5c-2's.
  - **All-day times.** `GetDateTime` (`Activity.aspx.cs:921-938`) stores an all-day start at 00:00 and an all-day end at 23:45.
  - **The freeze message** (`UCFlexiGrid.ascx:124`): "You cannot make content changes between 4pm-5pm. Contact the Corp Cal Manager to have emerging or urgent updates made for you during this time."

---

## Decisions made in planning

Paul is unavailable and authorised autonomous work. Each decision says why it was made and what it costs if it is wrong. Task 11 writes the parity rows they create.

- **F1. 5c is split in two, and 5c-1 comes first.**
  - **Why:** 5c's scope is about 17 right-sized tasks.
  - **The split:** 5c-1 takes the rules and the activity API, which is the whole §3 exit check. 5c-2 takes Transfer, the deactivation preview and the dead-letter page, with their screens.
  - **If wrong:** one extra plan review. 5c-2 only consumes 5c-1's modules.
- **F2. The shared rules live in a new package, `@gcpe/calendar-contract`.**
  - **What it is:** zod only and browser-safe, as `@gcpe/nrms-contract` is for NRMS.
  - **What moves there:** the enums, now re-exported from `schema.ts`, so the DDL is unchanged. Staff-web can import the package; it can't import `@gcpe/auth` or `@gcpe/config`.
  - **If wrong:** moving a file later. The package has no runtime dependencies beyond zod.
- **F3. The tenant `calendar` section lives in `packages/config`.**
  - **In the schema:** optional, so other tenants and apps are unaffected.
  - **The Calendar:** refuses to start without it.
  - **The freeze zone:** the tenant's own `timeZone`, so there is one source.
  - **Ids and names:**
    - **By id:** release categories, awareness categories, City "Other…" and comm material 61, as the spec gives them.
    - **By name:** the event-like categories and "HQ Placeholder", because legacy matched those by name (`Activity.aspx:2491-2517`, `DropDownListManager.cs:297`) and their production ids are unknown.
  - **Also in config:** the clone's kept keyword ("30-60-90").
  - **The Look Ahead cover image:** `null` until 5g, so no legacy image is copied.
  - **If wrong:** a config edit, not a code change.
- **F4. One clock.**
  - **The rule:** freeze checks, lock liveness and "today" use the database's `now()`, the platform's single clock (`packages/db-kit/src/claim.ts`). Converting to BC wall-clock uses Node 24's `Intl` (tzdata ≥ 2026b).
  - **Tests:**
    - they inject a `TestClock` through the app's deps;
    - the default test clock is fixed at `2026-11-03T18:00:00Z` (11:00 BC), so a test run between 16:00 and 17:00 BC never trips the freeze.
  - **If wrong:** none. It matches the dispatcher's existing rule.
- **F5. The freeze.**
  - **The window:** a refused write answers HTTP 423 with `code: "freeze"` and legacy's message, built from the configured times ("4pm-5pm"). The window is `[start, end)`; equal times turn it off; a start after the end wraps past midnight.
  - **Exempt:** HQ users at Editor and above.
  - **What it covers:** create, update, clone, delete and taking an edit lock (attachments are 5e's).
  - **Not frozen:** Review, Review selected, Clear LA Status and Transfer.
  - **If wrong:** one function changes.
- **F6. Look Ahead inference follows legacy's script exactly.**
  - **The refinements:** three of them sharpen spec §7.6:
    - a confidential activity keeps the section it already has; only one with no section yet gets `not_on_la`;
    - for a user who doesn't see the Look Ahead fieldset, a stored section that differs from what the stored fields infer is an HQ override, and it is kept;
    - Awareness and the consultations ministry keep the stored section, and a new one stores `not_on_la`. Reports place these by category and ministry, not by section.
  - **Why:** the 5i report-parity check compares against legacy's output. The spec's simpler wording would drop confidential activities from the Look Ahead, where legacy shows them with "Not for Look Ahead".
  - **If wrong:** two lines in `sectionToStore`. New row C168 (Proposed).
- **F7. Clone copies the stored activity on the server.** Legacy cloned from the page.
  - **What is copied:** every field except what spec §7.1 names:
    - `nr_at` is cleared, `comments` is empty and `hq_comments` is `**`;
    - News Subscribe tags are dropped, and only the configured keywords are kept.
  - **What else is not copied:** LA status, attachments, favourites, locks, history and release links.
  - **The difference from legacy:** legacy's fixed list also dropped Event planner, Digital and Translations. Translations being dropped is the same class of bug as C145. We copy all three.
  - **History:** a `cloned` entry with a `cloned_from` field row (carry-forward).
  - **If wrong:** users clear three fields on a clone. New row C167 (Proposed).
- **F8. How changes are compared.**
  - **Text:** compared trimmed (spec §7.3).
  - **Lists:** translations, keywords and every id list are compared as sets.
  - **The four single-value rules:** "to a new non-empty value" for Premier Requested, Distribution, Event planner and Digital exactly as legacy has it.
  - **If wrong:** reordering translations flags nothing; legacy compared the comma-joined string.
- **F9. Reference rules.** Legacy offered inactive options only when they were already on the activity (`DropDownListManager.cs:297`).
  - **Inactive values:** an inactive lookup value, term, ministry, shared ministry or comm contact is accepted only when the activity already has it.
  - **HQ Placeholder:** only HQ Editors and above may choose it.
  - **Keywords:** a keyword name matches an existing keyword case-insensitively, preferring an active one; otherwise it is created under the keyword lookup's lock.
  - **Changing the contact ministry:** the new ministry must be one of the user's ministries, unless the user is HQ (legacy's dropdown).
  - **The comm contact** must belong to the contact ministry.
  - **If wrong:** a 422 a user can read and fix.
- **F10. Limits the spec doesn't list.** Each one keeps a database CHECK from ever being what refuses a value.
  - Potential Dates: 50 characters (legacy's `MaxLength="50"`, `Activity.aspx:789`).
  - Translations: at most 30, each 1–50 characters, with no comma (legacy stored them comma-joined).
  - HQ Tags: at most 20 names, each up to 255 characters.
  - An NR time needs an NR date, and an NR date needs a time.
  - **If wrong:** a 422 on rare input.
- **F11. Look Ahead fields.**
  - **Users who don't see the fieldset** (§6):
    - the fields aren't in their view;
    - if they send them, the server refuses with 422.
  - **Fieldset users who leave them out:** on create they get legacy's defaults (Executive Summary `**`, no LA status, the inferred section, no Long Term Outlook); on update the stored values are kept.
  - **If wrong:** the 5e form omits the block.
- **F12. Needs-review flags appear in the view only for HQ Editors and above.** That is the activity-page markup rule (§6). Everyone else gets `[]`.
- **F13. Edit locks.**
  - **Taking:** one `PUT /activities/:id/lock` takes, refreshes, or with `takeOver` moves the caller's own lock to this tab ("Continue here"). It never takes another user's live lock.
  - **Releasing:** only the same user and tab can release (`POST …/lock/release`). On tab close, the 5e editor uses `fetch` with `keepalive: true` and the CSRF header, because `navigator.sendBeacon` can't send the `X-GCPE-Request` header that `requireBearer` requires on every cookie POST.
  - **What a live lock blocks:** update and delete are refused under another user's live lock.
  - **What ignores locks:** clone, review, review selected and Clear LA Status. Spec §7.5 says bulk actions ignore locks.
  - **On save:** a save releases the saver's locks on that activity.
  - **If wrong:** 5e uses `sendBeacon` and the lock lapses after 15 minutes instead of at once.
- **F14. Last updated.**
  - **Who sets it:** only create, update and clone set `last_updated_at`/`by`. Update follows legacy's HQ Administrator rule (C129).
  - **Who doesn't:** delete, review, Clear LA Status and Transfer leave it alone, as legacy did. Every one of them still bumps `version`.
  - **If wrong:** "updated X ago" shows the last content edit, not the last review.
- **F15. Clear LA Status.**
  - **The cutoff:** `start_at ≤ 00:00 BC on (today + N days)`, legacy's literal `DateTime.Today.AddDays(N)`.
  - **N:** 0 to 366.
  - **Which activities:** only those `visible()` to the caller (§7.1). Deleted ones are included only where visible.
  - **If wrong:** activities starting during day N itself aren't cleared, as in legacy.
- **F16. Bulk actions.**
  - **Batches:** review selected and Clear LA Status (and Transfer in 5c-2) run in transactions of at most 100 activities, with ids sorted.
  - **Why:** each activity takes an advisory lock, and Postgres's shared lock table holds about 6,400 locks by default (64 × 100 connections).
  - **Review selected:** takes at most 500 items per request.
  - **If wrong:** a failed batch leaves earlier batches applied. Each activity's change is independent and is reported.
- **F17. The Calendar → NRMS route for `activity.*` is wired now** (`activity.created`, `activity.updated`, `activity.deleted`).
  - **Why:** NRMS's receiver records unknown types as `ignored` until 5h adds its handler, so deliveries succeed and the 5c-2 dead-letter page has a real subscriber.
  - **Pinned by a test:** no route carries any `activity.*` type to the News API (C127; carry-forward "never gains an `activity.*` handler").
  - **If wrong:** NRMS's inbox gains rows it ignores. 5h's replay re-sends everything with new sequences anyway.
- **F18. Events.**
  - **Delete** emits `activity.deleted` (`{ id }`).
  - **Create and clone** emit `activity.created`. Every other write emits `activity.updated`.
  - **The payload:** `cityName` is the Other City text when the city is the configured "Other…". A confidential activity is always the strict id-only form.
- **F19. A constraint-error safety net.**
  - **The mapping:** the activity routes map any Postgres `23xxx` error to 409 `{ code: "conflict" }`, logged with `safeErrorLabel` only.
  - **Why:** validation already makes every CHECK, foreign key and primary key unreachable, so this only catches a race the validation missed. A constraint error never reaches a 500.
- **F20. History.**
  - **Field keys:** snake_case, labelled in the contract.
  - **Values:** the display value, a name rather than an id, and BC time for dates.
  - **What each entry records:**
    - `created` and `cloned` list every field that is set; `cloned` also gets `cloned_from`;
    - `updated` lists every changed field;
    - `reviewed`, `la_status_cleared` and `transferred` record the fields they change;
    - `deleted` has no field rows.
  - **A save that changes nothing:** it still bumps the version and emits `activity.updated`, and writes no history entry.
- **F21. The history read API** (`GET /activities/:id/changes`) is built here, because this plan writes the history and its tests read it. 5e builds the "View changes" screen on it. **No migration.**

## Carry-forward items taken

From `docs/superpowers/plans/phase-5-carry-forward.md` § 5c. Task 11 deletes the items this plan takes and leaves the rest for 5c-2.

| Item | Where |
|---|---|
| Lock-expiry sweep on the stack tick | Task 7 |
| Tenant `calendar` config section | Task 1 (F3) |
| A cloned activity's history records its source id | Task 9 (`cloned_from`, F7) |
| `needs_review` writers de-duplicate keys | Task 5 (`mergeNeedsReview`), pinned through the API in Task 8 |
| The News API never gains an `activity.*` handler (§ 5h and later) | Task 6 (route test, F17); the item itself stays for 5h |

Left for 5c-2: the dead-letter page, Transfer and the deactivation preview.

## Global Constraints

- **Worktree and commits:**
  - Work on `feat/phase-5c` in `/Users/paul/gcpe-news-platform-p5c`. Commit locally after each task.
  - **Never add `Co-Authored-By` or any AI attribution** to a commit (project rule). Never commit `CLAUDE.md`.
  - **Code comments never carry task, decision, round or ruling labels** ("Task 3", "F6", "fix round 1"). Comments say *why*, not *when*.
    - Spec row ids such as C127 and Q51 are fine in comments.
    - The spec's R-decisions are cited by section ("spec addendum §7.4"), never as "R1".
- **Node 24 for everything.** The default `node` is v22, whose tzdata predates BC's permanent UTC−7 from 2026-11-01. The freeze-clock tests fail on it, which is the point.
  - Tests: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run <paths>`.
  - Type-checks: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json` and `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p apps/staff-web/tsconfig.json`.
  - E2E: `npx -y -p node@24 -- npm run test:e2e`.
  - Show each new test failing before implementing it (a real RED run).
- **Migrations:** drizzle-kit only, run from the app folder: `cd apps/calendar && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name <name>`. Never hand-edit generated DDL. This plan adds no migration (F21).
- **Keys and ids:**
  - Core keys (ministries, sectors, themes, tags) are byte-exact and never case-folded.
  - User ids are compared canonically (trim and lowercase). The projection already stores them lowercased.
- **Access:**
  - Bearer tokens get no Calendar access.
  - The Calendar actor is read per request from the projection (`req.calendar`). Cookie roles are ignored.
  - A not-visible activity is 404, never 403. 403 is only for a visible activity the caller may not act on (§6).
- **Lock order:**
  1. the aggregate's advisory lock (`lockActivity`, `pg_advisory_xact_lock(hashtext('calendar-activity:<id>'))`);
  2. then the row `FOR UPDATE`;
  3. then re-check what was read before the lock;
  4. write and emit in the same transaction.
  - When a write also creates keywords, it takes the keyword lookup's lock *after* the activity's.
  - Bulk actions lock activities in ascending id order.
- **Errors:**
  - No constraint error may reach a 500.
  - Request bodies are strict zod objects: an unknown key is a 400.
  - Logs carry `safeErrorLabel(e)` only, never an error message, a bound parameter or activity text. No debug logging is added.
- **Events:**
  - Subscriber lists name their types explicitly.
  - `enqueueEvent` validates every payload through `parseEvent`.
  - **The News API never gets an `activity.*` route or handler (C127).**
  - **Confidential activity text never leaves the Calendar.** It goes out only in the strict id-only form.
- **Privacy:** no real names or emails anywhere: code, tests, fixtures, docs or commits.
  - Test data uses `example.test` addresses, fictional GUIDs (`00000000-0000-4000-8000-…`) and fictional names ("Sample approved event", "Robin Staff").
  - **Never copy a row of legacy data**, including lookup values. Tests run on `TEST_RULES` with fictional category names. Only `config/tenants/bc.json` carries BC's configured values, as spec §5.1 lists them.
- **The server is the authority** (C138–C141). Every capability is checked in the route's service function, never only in staff-web.

## Review Focus

1. **A double-clicked Save.** Two identical `PUT`s with the same version: exactly one is 200, the other is 409, and there is one `updated` history entry and one event, not two. Pinned in Task 8 ("a double-clicked save: one 200, one 409, one history entry").
2. **An HQ Tag typed with different case or spacing from an existing one** (" Sample Tag " when "sample tag" exists). The existing keyword is reused, no second keyword row is created, and re-saving the same set raises no `tags` flag. Pinned in Task 8 ("a keyword typed in another case or with spaces reuses the existing one").
3. **A comm contact deactivated after the activity was saved** (by the users screen, or by a 5c-2 Transfer). The editor's next save, which leaves the contact unchanged, is accepted. Choosing an inactive contact is refused with a field error, never a 500. Pinned in Task 8 ("an unchanged inactive comm contact is accepted; choosing one is refused").
4. **A client sending fields the server owns** (`status`, `needsReview`, `version` on create, `createdBy`). Each is 400 by the strict body, and nothing is written. Pinned in Task 6 ("the server owns status, flags and versions: a body that sets them is 400").
5. **An all-day activity on 2026-11-01, the day BC stops changing clocks.** It is stored at 00:00 and 23:45 BC (07:00Z and 06:45Z the next day) and reads back as 2026-11-01 for both start and end. Pinned in Task 6 ("an all-day activity on 2026-11-01 stores and reads back BC's dates").

---

## File structure

| File | Responsibility |
|---|---|
| `packages/calendar-contract/package.json`, `src/index.ts` | New browser-safe package |
| `packages/calendar-contract/src/enums.ts` | Statuses, sections, the 23 needs-review keys, change actions (moved from `schema.ts`) |
| `packages/calendar-contract/src/levels.ts` | `LEVEL` (mirrors `CALENDAR_LEVELS`) |
| `packages/calendar-contract/src/rules.ts` | `CalendarRules` (what the rules read from the tenant section) |
| `packages/calendar-contract/src/freeze.ts` (+ test) | `inFreezeWindow`, `clockLabel`, `freezeMessage` |
| `packages/calendar-contract/src/input.ts` | `activityFieldsSchema`, `createActivitySchema`, `updateActivitySchema`, `ActivityFields` |
| `packages/calendar-contract/src/clean.ts` (+ test) | `cleanTitle`, `replaceSpecialCharacters` |
| `packages/calendar-contract/src/look-ahead.ts` (+ test) | `inferLookAhead`, `sectionToStore` |
| `packages/calendar-contract/src/validate.ts` (+ test) | `checkActivity`, `warningsFor` |
| `packages/calendar-contract/src/view.ts` | `ActivityView`, `ActivityChangeView`, `HISTORY_FIELDS` |
| `packages/config/src/calendar.ts` (+ test), `src/tenant.ts`, `src/index.ts` | The tenant `calendar` section |
| `config/tenants/bc.json` | BC's `calendar` values |
| `apps/calendar/src/rules.ts` (+ test) | `rulesFromTenant` |
| `apps/calendar/src/visibility.ts` (+ test) | `visible`, `visibleSql`, and the generated matrix test |
| `apps/calendar/src/capabilities.ts` (+ test) | The §6 capability table |
| `apps/calendar/src/time.ts` (+ test) | `dbNow`, `wallClock`, `instantOf`, `addDays`, `bcMidnight` |
| `apps/calendar/src/freeze.ts` (+ test) | `freezeStateAt`, `assertNotFrozen`, `FreezeError` |
| `apps/calendar/src/activities/errors.ts` | Typed errors |
| `apps/calendar/src/activities/store.ts` | Lock, load, field mapping, row values, joins |
| `apps/calendar/src/activities/resolve.ts` | Reference checks, keyword resolution and creation |
| `apps/calendar/src/activities/review-rules.ts` (+ test) | `reviewChanges`, `mergeNeedsReview`, the trigger-table test |
| `apps/calendar/src/activities/history.ts` | Display values, diff, `writeChange` |
| `apps/calendar/src/activities/events.ts` | `emitActivity`, `emitActivityDeleted` |
| `apps/calendar/src/activities/view.ts` | `readActivity`, `readChanges` |
| `apps/calendar/src/activities/create.ts`, `update.ts`, `clone.ts`, `delete.ts`, `review.ts`, `bulk.ts`, `locks.ts` | One action each |
| `apps/calendar/src/http/errors.ts` (+ test), `http/activity-routes.ts` (+ tests), `http/config-routes.ts` | Routes |
| `apps/calendar/src/app.ts`, `start.ts`, `http/routes.ts`, `lookups.ts`, `db/schema.ts` | Wiring |
| `apps/calendar/test/helpers.ts`, `test/world.ts` | `TEST_RULES`, `FIXED_NOW`, `createTestApp(db, over)`, `seedWorld`, `validInput`, `waitForLockWaiter` |
| `apps/stack/src/env.ts`, `stack.ts` (+ `env.test.ts`, `stack.test.ts`) | Calendar → NRMS route, `calendar.lock-sweep` |
| `docs/parity/*`, `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`, carry-forward | Docs |

---

### Task 1: `@gcpe/calendar-contract` and the tenant `calendar` section

Covers: spec §5.1 (tenant config) and the carry-forward item "Tenant `calendar` config section". Decisions F2 and F3.

**Files:**
- Create: `packages/calendar-contract/package.json`, `src/index.ts`, `src/enums.ts`, `src/levels.ts`, `src/rules.ts`.
- Create: `packages/config/src/calendar.ts` (+ `calendar.test.ts`).
- Modify: `packages/config/src/tenant.ts`, `packages/config/src/index.ts`, `config/tenants/bc.json`.
- Modify: `apps/calendar/src/db/schema.ts` (the enums come from the contract), `apps/calendar/package.json`.
- Create: `apps/calendar/src/rules.ts` (+ `rules.test.ts`).
- Modify: `package-lock.json` (workspace link, from `npm install`).

**Interfaces:**
- Consumes: `tenantConfigSchema`, `loadTenantConfig` (`@gcpe/config`); `CALENDAR_LEVELS` (`@gcpe/auth`, test only).
- Produces:
  - `@gcpe/calendar-contract`:
    - `ACTIVITY_STATUSES`, `ActivityStatus`;
    - `HQ_STATUSES`, `HqStatus`;
    - `HQ_SECTIONS`, `HqSection`;
    - `NEEDS_REVIEW_KEYS`, `NeedsReviewKey`;
    - `CHANGE_ACTIONS`, `ChangeAction`;
    - `CHANGE_SOURCES`, `ChangeSource`;
    - `LEVEL: { readOnly: 1; editor: 2; advanced: 3; administrator: 4; sysAdmin: 5 }`;
    - `interface CalendarRules` (below).
  - `@gcpe/config`: `calendarTenantSchema`, `type CalendarTenantConfig`, and `TenantConfig.calendar?: CalendarTenantConfig`.
  - `apps/calendar/src/rules.ts`: `rulesFromTenant(t: TenantConfig): CalendarRules`.

- [ ] **Step 1: Write the failing tests**

`packages/config/src/calendar.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { calendarTenantSchema } from "./calendar";
import { loadTenantConfig } from "./tenant";

const bc = () => loadTenantConfig(fileURLToPath(new URL("../../../config/tenants/bc.json", import.meta.url)));

describe("the tenant calendar section", () => {
  it("BC carries legacy's values (spec addendum §5.1)", () => {
    const c = bc().calendar!;
    expect(c.freeze).toEqual({ start: "16:00", end: "17:00" });
    expect(c.releaseCategoryIds).toEqual([12, 58]);
    expect(c.awarenessCategoryIds).toEqual([2]);
    expect(c.otherCityId).toBe(311);
    expect(c.unconfirmedIssueCommMaterialId).toBe(61);
    expect(c.consultationsMinistryAbbreviation).toBe("CITENG");
    expect(c.contactMinistryExcludedAbbreviations).toEqual(["UNK", "BCWS"]);
    expect(c.translationsDefault).toHaveLength(25);
    expect(c.required).toEqual({ significance: true, scheduling: true, strategy: false });
    expect(c.showHqCommentsField).toBe(false);
    expect(c.showRecordsSection).toBe(false);
    expect(c.cloneKeptKeywordNames).toEqual(["30-60-90"]);
    expect(c.lookAheadCoverImage).toBeNull();
  });

  it("is optional: a tenant without it still loads", () => {
    const nb = loadTenantConfig(fileURLToPath(new URL("../../../config/tenants/nb.json", import.meta.url)));
    expect(nb.calendar).toBeUndefined();
  });

  it("refuses a malformed time and an unknown key", () => {
    const c = bc().calendar!;
    expect(calendarTenantSchema.safeParse({ ...c, freeze: { start: "4pm", end: "17:00" } }).success).toBe(false);
    expect(calendarTenantSchema.safeParse({ ...c, freezeZone: "UTC" }).success).toBe(false);
  });
});
```

`apps/calendar/src/rules.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { CALENDAR_LEVELS } from "@gcpe/auth";
import { loadTenantConfig } from "@gcpe/config";
import { LEVEL } from "@gcpe/calendar-contract";
import { rulesFromTenant } from "./rules";

const tenant = (name: string) => loadTenantConfig(fileURLToPath(new URL(`../../../config/tenants/${name}.json`, import.meta.url)));

describe("rulesFromTenant", () => {
  it("joins the tenant's time zone to its calendar section", () => {
    const rules = rulesFromTenant(tenant("bc"));
    expect(rules.timeZone).toBe("America/Vancouver");
    expect(rules.freeze).toEqual({ start: "16:00", end: "17:00" });
  });

  it("refuses a tenant with no calendar section, naming it", () => {
    expect(() => rulesFromTenant(tenant("nb"))).toThrow(/tenant "nb" has no "calendar" section/);
  });

  it("the contract's levels mirror the auth package's", () => {
    expect(LEVEL).toEqual({
      readOnly: CALENDAR_LEVELS["Calendar.ReadOnly"],
      editor: CALENDAR_LEVELS["Calendar.Editor"],
      advanced: CALENDAR_LEVELS["Calendar.Advanced"],
      administrator: CALENDAR_LEVELS["Calendar.Administrator"],
      sysAdmin: CALENDAR_LEVELS["Calendar.SysAdmin"],
    });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/config/src/calendar.test.ts apps/calendar/src/rules.test.ts`
Expected: FAIL. `./calendar` and `./rules` can't be resolved, and `@gcpe/calendar-contract` isn't installed.

- [ ] **Step 3: The contract package**

`packages/calendar-contract/package.json`:

```json
{
  "name": "@gcpe/calendar-contract",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "zod": "^3.25.76" }
}
```

`packages/calendar-contract/src/enums.ts`. These are moved verbatim from `apps/calendar/src/db/schema.ts:16-35`; keep their doc comments:

```ts
export const ACTIVITY_STATUSES = ["new", "changed", "reviewed"] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];
export const HQ_STATUSES = ["new", "changed"] as const;
export type HqStatus = (typeof HQ_STATUSES)[number];
/** Legacy HqSection 1–4 in order (spec addendum §7.6). */
export const HQ_SECTIONS = ["issues_and_reports", "events_and_speeches", "in_the_news", "not_on_la"] as const;
export type HqSection = (typeof HQ_SECTIONS)[number];
/** The 23 needs-review flags (spec addendum §7.3). */
export const NEEDS_REVIEW_KEYS = [
  "title", "details", "representative", "city", "start_date", "end_date", "categories", "comm_materials", "active",
  "significance", "strategy", "scheduling_considerations", "internal_notes", "lead_organization", "initiatives", "tags",
  "origin", "distribution", "translations_required", "premier_requested", "venue", "event_planner", "digital",
] as const;
export type NeedsReviewKey = (typeof NEEDS_REVIEW_KEYS)[number];
export const CHANGE_ACTIONS = ["created", "updated", "cloned", "reviewed", "deleted", "transferred", "la_status_cleared"] as const;
export type ChangeAction = (typeof CHANGE_ACTIONS)[number];
export const CHANGE_SOURCES = ["calendar", "legacy_log"] as const;
export type ChangeSource = (typeof CHANGE_SOURCES)[number];
```

`packages/calendar-contract/src/levels.ts`:

```ts
/** Calendar levels, as legacy's SecurityRole enum. Every check is "level ≥ n" (spec addendum §4).
 * A mirror of @gcpe/auth's CALENDAR_LEVELS, which browser code can't import; a test keeps them equal. */
export const LEVEL = { readOnly: 1, editor: 2, advanced: 3, administrator: 4, sysAdmin: 5 } as const;
```

`packages/calendar-contract/src/rules.ts`:

```ts
/** What the activity rules read from the tenant's calendar section, plus the tenant's time zone
 * (spec addendum §5.1). The server builds it from @gcpe/config; the browser gets it from GET /calendar/api/config. */
export interface CalendarRules {
  timeZone: string;
  freeze: { start: string; end: string };
  /** Categories that require Origin, Distribution and Comm Materials (legacy 12 and 58). */
  releaseCategoryIds: readonly number[];
  /** Categories whose activities are Awareness Dates (legacy 2; Q52). */
  awarenessCategoryIds: readonly number[];
  /** City "Other…": the Other City text applies only with it. */
  otherCityId: number;
  /** The comm material that marks an unconfirmed issue for the Look Ahead (legacy 61). */
  unconfirmedIssueCommMaterialId: number;
  hqPlaceholderCategoryName: string;
  confidentialCategoryName: string;
  /** Categories an Issue doesn't move to Issues & Reports (Activity.aspx:2493-2497). */
  issueExemptCategoryNames: readonly string[];
  /** Categories that go to Events & Speeches rather than In the News (Activity.aspx:2509-2517). */
  eventsCategoryNames: readonly string[];
  consultationsMinistryAbbreviation: string;
  contactMinistryExcludedAbbreviations: readonly string[];
  sharedWithExcludedAbbreviations: readonly string[];
  translationsDefault: readonly string[];
  required: { significance: boolean; scheduling: boolean; strategy: boolean };
  showHqCommentsField: boolean;
  showRecordsSection: boolean;
  /** Keywords a clone keeps; every other keyword is dropped (ActivityWebService.cs:430). */
  cloneKeptKeywordNames: readonly string[];
  lookAheadCoverImage: string | null;
  reportBanner: { province: string; confidentiality: string };
}
```

`packages/calendar-contract/src/index.ts`:

```ts
export * from "./enums";
export * from "./levels";
export * from "./rules";
```

(Tasks 3 and 4 add `./freeze`, `./input`, `./clean`, `./look-ahead`, `./validate` and `./view` here.)

- [ ] **Step 4: The tenant section**

`packages/config/src/calendar.ts`:

```ts
import { z } from "zod";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM, 24-hour");
const id = z.number().int().positive();
const names = z.array(z.string().min(1));

/**
 * The tenant's Corporate Calendar settings (spec addendum §5.1). BC's values come from legacy and
 * live in config/tenants/bc.json, so no legacy id or category name is written into a rule. The
 * freeze is evaluated in the tenant's own timeZone.
 */
export const calendarTenantSchema = z
  .object({
    freeze: z.object({ start: hhmm, end: hhmm }).strict(),
    releaseCategoryIds: z.array(id),
    awarenessCategoryIds: z.array(id),
    otherCityId: id,
    unconfirmedIssueCommMaterialId: id,
    hqPlaceholderCategoryName: z.string().min(1),
    confidentialCategoryName: z.string().min(1),
    issueExemptCategoryNames: names,
    eventsCategoryNames: names,
    consultationsMinistryAbbreviation: z.string().min(1),
    contactMinistryExcludedAbbreviations: names,
    sharedWithExcludedAbbreviations: names,
    translationsDefault: names,
    required: z.object({ significance: z.boolean(), scheduling: z.boolean(), strategy: z.boolean() }).strict(),
    showHqCommentsField: z.boolean(),
    showRecordsSection: z.boolean(),
    cloneKeptKeywordNames: names,
    lookAheadCoverImage: z.string().min(1).nullable(),
    reportBanner: z.object({ province: z.string().min(1), confidentiality: z.string().min(1) }).strict(),
  })
  .strict();

export type CalendarTenantConfig = z.infer<typeof calendarTenantSchema>;
```

In `packages/config/src/tenant.ts`, import it and add one key to `tenantConfigSchema`'s object, after `timeZoneCheck`:

```ts
  /** Optional: only tenants that run the Corporate Calendar need it; the Calendar refuses to start without it. */
  calendar: calendarTenantSchema.optional(),
```

In `packages/config/src/index.ts`, add:

```ts
export { calendarTenantSchema, type CalendarTenantConfig } from "./calendar";
```

`config/tenants/bc.json`: add a `"calendar"` key after `"timeZoneCheck"`. These are legacy's configured values, as spec §5.1 lists them:
- the Translations list is `defaultTranslations` (`Activity.aspx.cs:372`);
- the category names are those legacy's scripts match on (`Activity.aspx:2471,2493-2517`, `DropDownListManager.cs:297`);
- `SharedWithExcludes` is empty in legacy's template (Q51).

```json
  "calendar": {
    "freeze": { "start": "16:00", "end": "17:00" },
    "releaseCategoryIds": [12, 58],
    "awarenessCategoryIds": [2],
    "otherCityId": 311,
    "unconfirmedIssueCommMaterialId": 61,
    "hqPlaceholderCategoryName": "HQ Placeholder",
    "confidentialCategoryName": "CONFIDENTIAL or EMBARGOED",
    "issueExemptCategoryNames": ["Approved Event or Activity", "Approved Release", "Proposed Event or Activity", "Proposed Release", "Speech / Remarks"],
    "eventsCategoryNames": ["Approved Release", "Proposed Release", "Approved Event or Activity", "Proposed Event or Activity", "Speech", "Speech / Remarks", "HQ Placeholder"],
    "consultationsMinistryAbbreviation": "CITENG",
    "contactMinistryExcludedAbbreviations": ["UNK", "BCWS"],
    "sharedWithExcludedAbbreviations": [],
    "translationsDefault": ["TBD", "None", "Arabic", "Chinese (Simplified)", "Chinese (Traditional)", "Dutch", "Farsi", "Finnish", "French", "Gujarati", "Hebrew", "Hindi", "Indonesian", "Japanese", "Korean", "Portuguese", "Punjabi", "Russian", "Somali", "Spanish", "Swahili", "Tagalog", "Ukrainian", "Urdu", "Vietnamese"],
    "required": { "significance": true, "scheduling": true, "strategy": false },
    "showHqCommentsField": false,
    "showRecordsSection": false,
    "cloneKeptKeywordNames": ["30-60-90"],
    "lookAheadCoverImage": null,
    "reportBanner": { "province": "Province of BC", "confidentiality": "DRAFT AND CONFIDENTIAL" }
  }
```

- [ ] **Step 5: The Calendar uses the contract**

`apps/calendar/package.json`: add `"@gcpe/calendar-contract": "0.0.0"` to `dependencies`. Then run `npx -y -p node@24 -- npm install` from the repo root. It links the workspace and updates `package-lock.json`.

`apps/calendar/src/db/schema.ts`: delete the local definitions of `ACTIVITY_STATUSES`, `ActivityStatus`, `HQ_STATUSES`, `HqStatus`, `HQ_SECTIONS`, `HqSection`, `NEEDS_REVIEW_KEYS`, `NeedsReviewKey`, `CHANGE_ACTIONS`, `ChangeAction`, `CHANGE_SOURCES` and `ChangeSource` (`:16-35`). In their place:

```ts
import {
  ACTIVITY_STATUSES, CHANGE_ACTIONS, CHANGE_SOURCES, HQ_SECTIONS, HQ_STATUSES, NEEDS_REVIEW_KEYS,
  type ActivityStatus, type ChangeAction, type ChangeSource, type HqSection, type HqStatus, type NeedsReviewKey,
} from "@gcpe/calendar-contract";

// The activity enums are shared with the staff app, so they live in the contract package.
export { ACTIVITY_STATUSES, CHANGE_ACTIONS, CHANGE_SOURCES, HQ_SECTIONS, HQ_STATUSES, NEEDS_REVIEW_KEYS };
export type { ActivityStatus, ChangeAction, ChangeSource, HqSection, HqStatus, NeedsReviewKey };
```

`apps/calendar/src/rules.ts`:

```ts
import type { TenantConfig } from "@gcpe/config";
import type { CalendarRules } from "@gcpe/calendar-contract";

/** The activity rules' settings: the tenant's calendar section and its time zone (spec addendum §5.1). */
export function rulesFromTenant(t: TenantConfig): CalendarRules {
  if (!t.calendar) throw new Error(`tenant "${t.tenantId}" has no "calendar" section; the Corporate Calendar needs one (spec addendum §5.1)`);
  return { timeZone: t.timeZone, ...t.calendar };
}
```

- [ ] **Step 6: Run the tests, the type-check and drizzle-kit**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/config apps/calendar`
Expected: PASS, including the existing `schema.test.ts` (the 23 keys are unchanged).

Run: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: no errors.

Run: `cd apps/calendar && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name noop`
Expected: `No schema changes, nothing to migrate`, and no new file under `apps/calendar/migrations`. If a file appears, the moved enums changed the DDL: delete the file and compare the constants character for character.

- [ ] **Step 7: Commit**

```bash
git add packages/calendar-contract packages/config config/tenants/bc.json apps/calendar/package.json apps/calendar/src/db/schema.ts apps/calendar/src/rules.ts apps/calendar/src/rules.test.ts package-lock.json
git commit -m "feat(calendar): calendar-contract package and the tenant calendar section"
```

---

### Task 2: `visible()`, its SQL predicate, and the capability table

Covers: spec §6 (definitions, the matrix, "one implementation, two forms", 404 not 403, the capability table) and the §3 exit check ("the visibility function and its SQL predicate agree on a generated matrix").

**Files:**
- Create: `apps/calendar/src/visibility.ts` (+ `visibility.test.ts`).
- Create: `apps/calendar/src/capabilities.ts` (+ `capabilities.test.ts`).

**Interfaces:**
- Consumes: `LEVEL`, `CalendarRules` (Task 1); `activities`, `activitySharedWith` (`schema.ts`).
- Produces:
  - `interface Viewer { level: number; isHq: boolean; ministryKeys: readonly string[] }`. `CalendarActor` satisfies it.
  - `interface VisibilityFacts { contactMinistryKey: string | null; sharedMinistryKeys: readonly string[]; isConfidential: boolean; isDeleted: boolean }`.
  - `visible(u: Viewer, a: VisibilityFacts): boolean`.
  - `visibleSql(u: Viewer): SQL`. A predicate over the unaliased `activities` table.
  - `can`, an object of predicates:
    - `can.create(u, ministryKey)`;
    - `can.edit(u, a)`, `can.clone(u, a)`, `can.delete(u, a)` and `can.review(u, a)`;
    - `can.reviewSelected(u)`, `can.clearLaStatus(u)` and `can.transfer(u)`;
    - `can.seeLookAheadFieldset(u, rules, a?)` and `can.seeNeedsReviewMarkup(u)`;
    - `can.relaxRequiredFields(u)` and `can.useHqPlaceholder(u)`;
    - `can.skipFreeze(u)`.

- [ ] **Step 1: Write the failing tests**

`apps/calendar/src/visibility.test.ts`. It runs on real Postgres: one activity per target combination, one SQL query per viewer combination, compared with the TypeScript function.

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCalendarTestDb } from "../test/helpers";
import { activities, activitySharedWith } from "./db/schema";
import { visible, visibleSql, type Viewer, type VisibilityFacts } from "./visibility";

// The generated matrix of spec addendum §16: role × HQ × own/shared/other × confidential × deleted.
// "M-OWN" pins that ministry keys are byte-exact: it is a different ministry from "m-own".
const LEVELS = [0, 1, 2, 3, 4, 5];
const MINISTRY_SETS: string[][] = [[], ["m-own"], ["M-OWN"]];
const viewers: Viewer[] = LEVELS.flatMap((level) => [false, true].flatMap((isHq) => MINISTRY_SETS.map((ministryKeys) => ({ level, isHq, ministryKeys }))));
const CONTACTS = ["m-own", "m-other", null];
const SHARED: string[][] = [[], ["m-own"], ["m-other"]];
const targets: VisibilityFacts[] = CONTACTS.flatMap((contactMinistryKey) =>
  SHARED.flatMap((sharedMinistryKeys) => [false, true].flatMap((isConfidential) => [false, true].map((isDeleted) => ({ contactMinistryKey, sharedMinistryKeys, isConfidential, isDeleted })))),
);

describe("visible() and visibleSql() agree", () => {
  let tdb: TestDatabase;
  const idOf = new Map<number, VisibilityFacts>();

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    for (const t of targets) {
      const [row] = await tdb.db
        .insert(activities)
        .values({ title: "Sample", contactMinistryKey: t.contactMinistryKey, isConfidential: t.isConfidential, deletedAt: t.isDeleted ? new Date("2026-10-01T00:00:00Z") : null })
        .returning({ id: activities.id });
      idOf.set(row!.id, t);
      for (const k of t.sharedMinistryKeys) await tdb.db.insert(activitySharedWith).values({ activityId: row!.id, ministryKey: k });
    }
  });
  afterAll(() => tdb.drop());

  it(`on all ${viewers.length} × ${targets.length} combinations`, async () => {
    expect(viewers).toHaveLength(36);
    expect(targets).toHaveLength(36);
    for (const u of viewers) {
      const rows = await tdb.db.select({ id: activities.id }).from(activities).where(visibleSql(u)).orderBy(asc(activities.id));
      const fromSql = rows.map((r) => r.id);
      const fromTs = [...idOf].filter(([, t]) => visible(u, t)).map(([id]) => id).sort((a, b) => a - b);
      expect({ viewer: u, ids: fromSql }).toEqual({ viewer: u, ids: fromTs });
    }
  });
});

describe("visible() is legacy's list rule (spec addendum §6)", () => {
  const live = (over: Partial<VisibilityFacts> = {}): VisibilityFacts => ({ contactMinistryKey: "m-other", sharedMinistryKeys: [], isConfidential: false, isDeleted: false, ...over });
  const u = (level: number, isHq: boolean, ministryKeys: string[] = []): Viewer => ({ level, isHq, ministryKeys });

  it("needs a Calendar level", () => expect(visible(u(0, true), live())).toBe(false));
  it("a ministry user sees their own and shared ministries, not others", () => {
    expect(visible(u(1, false, ["m-own"]), live({ contactMinistryKey: "m-own" }))).toBe(true);
    expect(visible(u(1, false, ["m-own"]), live({ sharedMinistryKeys: ["m-own"] }))).toBe(true);
    expect(visible(u(5, false, ["m-own"]), live())).toBe(false);
  });
  it("HQ sees every ministry's non-confidential activities at any level", () => expect(visible(u(1, true), live())).toBe(true));
  it("an HQ Editor doesn't see another ministry's confidential activity; HQ Advanced does", () => {
    expect(visible(u(2, true), live({ isConfidential: true }))).toBe(false);
    expect(visible(u(3, true), live({ isConfidential: true }))).toBe(true);
  });
  it("the owning and shared ministries see a confidential activity at any level", () => {
    expect(visible(u(1, false, ["m-own"]), live({ isConfidential: true, sharedMinistryKeys: ["m-own"] }))).toBe(true);
  });
  it("a deleted activity is visible to HQ Administrators only", () => {
    expect(visible(u(5, false, ["m-other"]), live({ contactMinistryKey: "m-other", isDeleted: true }))).toBe(false);
    expect(visible(u(3, true), live({ isDeleted: true }))).toBe(false);
    expect(visible(u(4, true), live({ isDeleted: true }))).toBe(true);
  });
  it("ministry keys are byte-exact", () => expect(visible(u(1, false, ["M-OWN"]), live({ contactMinistryKey: "m-own" }))).toBe(false));
});
```

`apps/calendar/src/capabilities.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { can } from "./capabilities";
import type { VisibilityFacts } from "./visibility";

const own: VisibilityFacts = { contactMinistryKey: "health", sharedMinistryKeys: [], isConfidential: false, isDeleted: false };
const shared: VisibilityFacts = { contactMinistryKey: "finance", sharedMinistryKeys: ["health"], isConfidential: false, isDeleted: false };
const other: VisibilityFacts = { contactMinistryKey: "finance", sharedMinistryKeys: [], isConfidential: false, isDeleted: false };
const u = (level: number, isHq = false) => ({ level, isHq, ministryKeys: ["health"] });
const rules = { showHqCommentsField: false };

describe("the capability table (spec addendum §6)", () => {
  it("create: Editor and above, in their ministries; HQ in any", () => {
    expect(can.create(u(1), "health")).toBe(false);
    expect(can.create(u(2), "health")).toBe(true);
    expect(can.create(u(5), "finance")).toBe(false);
    expect(can.create(u(2, true), "finance")).toBe(true);
  });
  it("edit and clone: Editor and above, contact ministry theirs or HQ; shared-with ministries only view", () => {
    expect(can.edit(u(2), own)).toBe(true);
    expect(can.edit(u(5), shared)).toBe(false);
    expect(can.clone(u(5), shared)).toBe(false);
    expect(can.edit(u(2, true), other)).toBe(true);
    expect(can.edit(u(1, true), other)).toBe(false);
    expect(can.edit(u(5, true), { ...own, isDeleted: true })).toBe(false);
  });
  it("edit needs visibility: an HQ Editor can't edit another ministry's confidential activity", () => {
    expect(can.edit(u(2, true), { ...other, isConfidential: true })).toBe(false);
    expect(can.edit(u(3, true), { ...other, isConfidential: true })).toBe(true);
  });
  it("delete: Administrator with edit rights", () => {
    expect(can.delete(u(3), own)).toBe(false);
    expect(can.delete(u(4), own)).toBe(true);
    expect(can.delete(u(4), other)).toBe(false);
  });
  it("review: HQ Advanced; review selected: HQ Administrator; Clear LA Status: HQ Editor", () => {
    expect(can.review(u(5), own)).toBe(false);
    expect(can.review(u(2, true), own)).toBe(false);
    expect(can.review(u(3, true), own)).toBe(true);
    expect(can.reviewSelected(u(3, true))).toBe(false);
    expect(can.reviewSelected(u(4, true))).toBe(true);
    expect(can.clearLaStatus(u(5))).toBe(false);
    expect(can.clearLaStatus(u(2, true))).toBe(true);
  });
  it("the Look Ahead fieldset: HQ Editor, or anyone with edit rights when ShowHqCommentsField is on", () => {
    expect(can.seeLookAheadFieldset(u(2, true), rules)).toBe(true);
    expect(can.seeLookAheadFieldset(u(1, true), rules)).toBe(false);
    expect(can.seeLookAheadFieldset(u(5), rules)).toBe(false);
    expect(can.seeLookAheadFieldset(u(2), { showHqCommentsField: true }, own)).toBe(true);
    expect(can.seeLookAheadFieldset(u(2), { showHqCommentsField: true }, other)).toBe(false);
  });
  it("HQ privileges at Editor and above: freeze exemption, relaxed fields, HQ Placeholder, review markup", () => {
    for (const f of [can.skipFreeze, can.relaxRequiredFields, can.useHqPlaceholder, can.seeNeedsReviewMarkup]) {
      expect(f(u(2, true))).toBe(true);
      expect(f(u(1, true))).toBe(false);
      expect(f(u(5))).toBe(false);
    }
  });
  it("Transfer: Administrator and above", () => {
    expect(can.transfer(u(3))).toBe(false);
    expect(can.transfer(u(4))).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/visibility.test.ts apps/calendar/src/capabilities.test.ts`
Expected: FAIL. `./visibility` and `./capabilities` can't be resolved.

- [ ] **Step 3: Implement**

`apps/calendar/src/visibility.ts`:

```ts
import { inArray, sql, type SQL } from "drizzle-orm";
import { LEVEL } from "@gcpe/calendar-contract";
import { activities, activitySharedWith } from "./db/schema";

/** M(u), HQ(u) and L(u) of spec addendum §6. A CalendarActor is one. */
export interface Viewer {
  level: number;
  isHq: boolean;
  ministryKeys: readonly string[];
}
export interface VisibilityFacts {
  contactMinistryKey: string | null;
  sharedMinistryKeys: readonly string[];
  isConfidential: boolean;
  isDeleted: boolean;
}

// Legacy's list rule (ActivityListProvider.ashx.cs:214-244, ActivityDAO.cs:261-291). Deleted
// activities are for HQ Administrators to review (ActivityDAO.cs:176-193). Cross-government
// doesn't widen it. Keys compare byte for byte.
const seesConfidentialEverywhere = (u: Viewer) => u.isHq && u.level >= LEVEL.advanced;
const seesDeleted = (u: Viewer) => u.isHq && u.level >= LEVEL.administrator;

export function visible(u: Viewer, a: VisibilityFacts): boolean {
  if (u.level < LEVEL.readOnly) return false;
  const mine = (a.contactMinistryKey !== null && u.ministryKeys.includes(a.contactMinistryKey)) || a.sharedMinistryKeys.some((k) => u.ministryKeys.includes(k));
  const inScope = u.isHq || mine;
  const seesConfidential = seesConfidentialEverywhere(u) || mine;
  return inScope && (!a.isConfidential || seesConfidential) && (!a.isDeleted || seesDeleted(u));
}

/**
 * The same rule as a predicate over the `activities` table, unaliased: every reader filters in SQL,
 * never in memory after paging (spec addendum §6). The viewer's facts are constants, so each
 * branch is decided here and only the activity's facts are left to Postgres.
 */
export function visibleSql(u: Viewer): SQL {
  if (u.level < LEVEL.readOnly) return sql`false`;
  const keys = [...u.ministryKeys];
  const mine =
    keys.length === 0
      ? sql`false`
      : sql`(${inArray(activities.contactMinistryKey, keys)} OR EXISTS (SELECT 1 FROM ${activitySharedWith} WHERE ${activitySharedWith.activityId} = ${activities.id} AND ${inArray(activitySharedWith.ministryKey, keys)}))`;
  const inScope = u.isHq ? sql`true` : mine;
  const seesConfidential = seesConfidentialEverywhere(u) ? sql`true` : mine;
  const deletedOk = seesDeleted(u) ? sql`true` : sql`false`;
  return sql`(${inScope} AND (NOT ${activities.isConfidential} OR ${seesConfidential}) AND (${activities.deletedAt} IS NULL OR ${deletedOk}))`;
}
```

`apps/calendar/src/capabilities.ts`:

```ts
import { LEVEL, type CalendarRules } from "@gcpe/calendar-contract";
import { visible, type Viewer, type VisibilityFacts } from "./visibility";

const owns = (u: Viewer, a: VisibilityFacts) => a.contactMinistryKey !== null && u.ministryKeys.includes(a.contactMinistryKey);
/** Legacy's "HQAdmin ministry at Editor and above" privileges, now the HQ flag (C124). */
const hqEditor = (u: Viewer) => u.isHq && u.level >= LEVEL.editor;

/** Spec addendum §6's capability table. Every route checks these on the server (C138–C141). */
export const can = {
  /** Activity.aspx.cs:390-410: their ministries, or any active ministry for HQ. */
  create: (u: Viewer, ministryKey: string) => u.level >= LEVEL.editor && (u.isHq || u.ministryKeys.includes(ministryKey)),
  /** Activity.aspx.cs:1651-1683: shared-with ministries view only. A deleted activity is read-only. */
  edit: (u: Viewer, a: VisibilityFacts) => !a.isDeleted && visible(u, a) && u.level >= LEVEL.editor && (u.isHq || owns(u, a)),
  clone: (u: Viewer, a: VisibilityFacts) => can.edit(u, a),
  /** Activity.aspx.cs:1537-1544. */
  delete: (u: Viewer, a: VisibilityFacts) => can.edit(u, a) && u.level >= LEVEL.administrator,
  /** Activity.aspx.cs:1685-1686. */
  review: (u: Viewer, a: VisibilityFacts) => visible(u, a) && u.isHq && u.level >= LEVEL.advanced,
  /** UCFlexiGrid.ascx.cs:21-27 (C139). */
  reviewSelected: (u: Viewer) => u.isHq && u.level >= LEVEL.administrator,
  /** Default.aspx.cs:44-53 (C139). */
  clearLaStatus: (u: Viewer) => hqEditor(u),
  transfer: (u: Viewer) => u.level >= LEVEL.administrator,
  seeLookAheadFieldset: (u: Viewer, rules: Pick<CalendarRules, "showHqCommentsField">, a?: VisibilityFacts) =>
    hqEditor(u) || (rules.showHqCommentsField && (a ? can.edit(u, a) : u.level >= LEVEL.editor)),
  seeNeedsReviewMarkup: (u: Viewer) => hqEditor(u),
  /** Details, Significance and Scheduling aren't required of HQ (Activity.aspx.cs:224-230). */
  relaxRequiredFields: (u: Viewer) => hqEditor(u),
  /** The inactive "HQ Placeholder" category is offered to HQ (DropDownListManager.cs:297). */
  useHqPlaceholder: (u: Viewer) => hqEditor(u),
  /** Spec addendum §7.4: HQ at Editor and above. */
  skipFreeze: (u: Viewer) => hqEditor(u),
} as const;
```

- [ ] **Step 4: Run them to see them pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/visibility.test.ts apps/calendar/src/capabilities.test.ts`
Expected: PASS, with 1,296 viewer × target comparisons agreeing.

- [ ] **Step 5: Commit**

```bash
git add apps/calendar/src/visibility.ts apps/calendar/src/visibility.test.ts apps/calendar/src/capabilities.ts apps/calendar/src/capabilities.test.ts
git commit -m "feat(calendar): one visibility rule in TypeScript and SQL, agreeing on a generated matrix; the capability table"
```

---

### Task 3: The BC clock, the change freeze, and `GET /api/config`

Covers: spec §7.4 (the freeze, its window, the time zone, the exemption, "checked when saving") and the §3 exit check ("freeze clock tests, including the BC switch to permanent UTC−7 on 2026-11-01"). Decisions F4 and F5. It also wires the rules, subscribers and test clock into `createApp`.

**Files:**
- Create: `packages/calendar-contract/src/freeze.ts` (+ `freeze.test.ts`); modify `src/index.ts`.
- Create: `apps/calendar/src/time.ts` (+ `time.test.ts`).
- Create: `apps/calendar/src/freeze.ts` (+ `freeze.test.ts`).
- Create: `apps/calendar/src/http/config-routes.ts` (+ `config-routes.test.ts`).
- Modify: `apps/calendar/src/app.ts`, `src/http/routes.ts`, `src/start.ts`, `test/helpers.ts`.

**Interfaces:**
- Consumes: `can.skipFreeze`, `can.seeLookAheadFieldset` (Task 2); `rulesFromTenant` (Task 1); `wallClockToInstant` (`@gcpe/config`); `TestClock` (`@gcpe/db-kit`).
- Produces:
  - **Contract:**
    - `inFreezeWindow(secondsOfDay: number, start: string, end: string): boolean`;
    - `clockLabel(hhmm: string): string`;
    - `freezeMessage(start: string, end: string): string`.
  - **`time.ts`:**
    - `interface WallClock { date: string; time: string; secondsOfDay: number }`;
    - `wallClock(at: Date, timeZone: string): WallClock`;
    - `instantOf(date: string, time: string, timeZone: string): Date`;
    - `addDays(date: string, n: number): string`;
    - `bcMidnight(date: string, timeZone: string): Date`;
    - `dbNow(db: DbOrTx, clock?: TestClock): Promise<Date>`.
  - **`freeze.ts`:**
    - `class FreezeError`;
    - `interface FreezeState { start: string; end: string; timeZone: string; active: boolean; appliesToYou: boolean; message: string }`;
    - `freezeStateAt(now: Date, u: Viewer, rules: CalendarRules): FreezeState`;
    - `assertNotFrozen(now: Date, u: Viewer, rules: CalendarRules): void`.
  - **The app:**
    - `interface AppDeps { db: Db; auth: BearerOptions; eventSecrets: Record<string, string>; rules: CalendarRules; subscribers?: SubscriberConfig[]; now?: TestClock }`;
    - `interface ApiDeps { db: Db; rules: CalendarRules; subscribers: SubscriberConfig[]; now?: TestClock }`;
    - `apiRoutes(deps: ApiDeps): Router`;
    - `GET /api/config` → `{ timeZone, freeze: FreezeState, translationsDefault, otherCityId, releaseCategoryIds, required, showHqCommentsField, showRecordsSection, lookAheadFieldset: boolean }`.
  - **Test helpers:** `TEST_RULES: CalendarRules`, `FIXED_NOW: Date`, and `createTestApp(db: Db, over?: Partial<AppDeps>)`.

- [ ] **Step 1: Write the failing tests**

`packages/calendar-contract/src/freeze.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { clockLabel, freezeMessage, inFreezeWindow } from "./freeze";

const s = (hms: string) => hms.split(":").map(Number).reduce((acc, v) => acc * 60 + v, 0);

describe("the freeze window [start, end)", () => {
  it("is in force from the start's first second to just before the end", () => {
    expect(inFreezeWindow(s("15:59:59"), "16:00", "17:00")).toBe(false);
    expect(inFreezeWindow(s("16:00:00"), "16:00", "17:00")).toBe(true);
    expect(inFreezeWindow(s("16:59:59"), "16:00", "17:00")).toBe(true);
    expect(inFreezeWindow(s("17:00:00"), "16:00", "17:00")).toBe(false);
  });
  it("is off when start and end are equal", () => expect(inFreezeWindow(s("16:00:00"), "16:00", "16:00")).toBe(false));
  it("wraps past midnight when the start is after the end", () => {
    expect(inFreezeWindow(s("23:30:00"), "23:00", "01:00")).toBe(true);
    expect(inFreezeWindow(s("00:30:00"), "23:00", "01:00")).toBe(true);
    expect(inFreezeWindow(s("01:00:00"), "23:00", "01:00")).toBe(false);
  });
});

describe("the freeze message (UCFlexiGrid.ascx:124), from the configured times", () => {
  it("labels times as legacy does", () => {
    expect(clockLabel("16:00")).toBe("4pm");
    expect(clockLabel("16:30")).toBe("4:30pm");
    expect(clockLabel("00:00")).toBe("12am");
    expect(clockLabel("12:00")).toBe("12pm");
  });
  it("names the window", () => {
    expect(freezeMessage("16:00", "17:00")).toBe(
      "You cannot make content changes between 4pm-5pm. Contact the Corp Cal Manager to have emerging or urgent updates made for you during this time.",
    );
  });
});
```

`apps/calendar/src/time.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { addDays, bcMidnight, instantOf, wallClock } from "./time";

const BC = "America/Vancouver";

describe("BC wall-clock time (Node 24's tzdata; spec addendum §7.4)", () => {
  it("BC is UTC−7 on both sides of 2026-11-01: the clocks don't fall back", () => {
    // With tzdata older than 2026b this reads 15:00 (PST): run the suite under Node 24.
    expect(wallClock(new Date("2026-11-02T23:00:00Z"), BC)).toEqual({ date: "2026-11-02", time: "16:00", secondsOfDay: 16 * 3600 });
    expect(wallClock(new Date("2026-10-31T23:00:00Z"), BC).time).toBe("16:00");
    expect(wallClock(new Date("2026-11-01T09:30:00Z"), BC).time).toBe("02:30");
    expect(wallClock(new Date("2027-07-15T23:00:00Z"), BC).time).toBe("16:00");
  });
  it("converts a BC date and time to the instant, and back", () => {
    expect(instantOf("2026-11-01", "00:00", BC).toISOString()).toBe("2026-11-01T07:00:00.000Z");
    expect(instantOf("2026-11-01", "23:45", BC).toISOString()).toBe("2026-11-02T06:45:00.000Z");
    expect(instantOf("2026-03-08", "02:30", BC).toISOString()).toBe("2026-03-08T10:30:00.000Z");
  });
  it("adds days to a date and finds BC midnight", () => {
    expect(addDays("2026-10-31", 2)).toBe("2026-11-02");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(bcMidnight("2026-11-02", BC).toISOString()).toBe("2026-11-02T07:00:00.000Z");
  });
});
```

`apps/calendar/src/freeze.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { TEST_RULES } from "../test/helpers";
import { assertNotFrozen, FreezeError, freezeStateAt } from "./freeze";

const editor = { level: 2, isHq: false, ministryKeys: ["health"] };
const hqEditor = { level: 2, isHq: true, ministryKeys: ["gcpe-hq"] };
const hqReadOnly = { level: 1, isHq: true, ministryKeys: ["gcpe-hq"] };
const at = (iso: string) => new Date(iso);

// Instants either side of every boundary, on 2026-10-31 (PDT), on 2026-11-01 and 2026-11-02
// (BC's first days of permanent UTC−7), and in mid-winter and mid-summer 2027.
const CASES: [string, boolean][] = [
  ["2026-10-31T22:59:59Z", false], // 15:59:59
  ["2026-10-31T23:00:00Z", true], //  16:00:00
  ["2026-10-31T23:59:59Z", true], //  16:59:59
  ["2026-11-01T00:00:00Z", false], // 17:00:00
  ["2026-11-01T22:59:59Z", false],
  ["2026-11-01T23:00:00Z", true], //  old tzdata reads 15:00 PST here
  ["2026-11-02T22:59:59Z", false],
  ["2026-11-02T23:00:00Z", true],
  ["2026-11-02T23:59:59Z", true],
  ["2026-11-03T00:00:00Z", false],
  ["2027-01-15T23:30:00Z", true],
  ["2027-07-15T23:30:00Z", true],
];

describe("the change freeze in BC time (spec addendum §7.4)", () => {
  it.each(CASES)("at %s a non-exempt user is frozen: %s", (iso, frozen) => {
    expect(freezeStateAt(at(iso), editor, TEST_RULES).active).toBe(frozen);
    if (frozen) expect(() => assertNotFrozen(at(iso), editor, TEST_RULES)).toThrow(FreezeError);
    else expect(() => assertNotFrozen(at(iso), editor, TEST_RULES)).not.toThrow();
  });

  it("an HQ Editor is exempt; HQ Read Only is not", () => {
    expect(() => assertNotFrozen(at("2026-11-02T23:30:00Z"), hqEditor, TEST_RULES)).not.toThrow();
    expect(freezeStateAt(at("2026-11-02T23:30:00Z"), hqEditor, TEST_RULES)).toMatchObject({ active: true, appliesToYou: false });
    expect(() => assertNotFrozen(at("2026-11-02T23:30:00Z"), hqReadOnly, TEST_RULES)).toThrow(FreezeError);
  });

  it("uses the configured window and says so", () => {
    const rules = { ...TEST_RULES, freeze: { start: "09:00", end: "09:30" } };
    expect(freezeStateAt(at("2026-11-02T16:15:00Z"), editor, rules)).toMatchObject({ active: true, start: "09:00", end: "09:30", message: expect.stringContaining("9am-9:30am") });
    expect(() => assertNotFrozen(at("2026-11-02T16:15:00Z"), editor, rules)).toThrow("You cannot make content changes between 9am-9:30am.");
  });
});
```

`apps/calendar/src/http/config-routes.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCalendarTestDb, createTestApp, projectOrg, projectUser, sessionCookie, TEST_RULES } from "../../test/helpers";

const ED = "00000000-0000-4000-8000-000000000301";
const HQ = "00000000-0000-4000-8000-000000000302";

describe("GET /api/config", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    const app = createTestApp(tdb.db);
    await projectOrg(app, "health");
    await projectOrg(app, "gcpe-hq", { isHq: true });
    await projectUser(app, { id: ED, email: "ed@example.test", displayName: "Sample Editor", isActive: true, calendarRole: "Calendar.Editor", organizationKeys: ["health"] });
    await projectUser(app, { id: HQ, email: "hq@example.test", displayName: "Sample HQ Editor", isActive: true, calendarRole: "Calendar.Editor", organizationKeys: ["gcpe-hq"] });
  });
  afterAll(() => tdb.drop());

  it("gives the form its tenant lists and the freeze as it stands for the caller", async () => {
    const frozenApp = createTestApp(tdb.db, { now: () => new Date("2026-11-02T23:30:00Z") });
    const res = await request(frozenApp).get("/api/config").set("cookie", await sessionCookie(ED));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      timeZone: "America/Vancouver",
      freeze: { start: "16:00", end: "17:00", active: true, appliesToYou: true },
      translationsDefault: TEST_RULES.translationsDefault,
      otherCityId: 311,
      releaseCategoryIds: [12, 58],
      lookAheadFieldset: false,
    });
    const hq = await request(frozenApp).get("/api/config").set("cookie", await sessionCookie(HQ));
    expect(hq.body).toMatchObject({ freeze: { active: true, appliesToYou: false }, lookAheadFieldset: true });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/calendar-contract apps/calendar/src/time.test.ts apps/calendar/src/freeze.test.ts apps/calendar/src/http/config-routes.test.ts`
Expected: FAIL. The modules don't exist, and `TEST_RULES` isn't exported.

- [ ] **Step 3: The contract's freeze helpers**

`packages/calendar-contract/src/freeze.ts`:

```ts
const secondsOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return h * 3600 + m * 60;
};

/** Whether a BC wall-clock second of the day is in [start, end). Equal start and end turn the
 * freeze off; a start after the end wraps past midnight. Every day alike: legacy had no weekday
 * or holiday rules (spec addendum §7.4). */
export function inFreezeWindow(secondsOfDay: number, start: string, end: string): boolean {
  const s = secondsOf(start);
  const e = secondsOf(end);
  if (s === e) return false;
  return s < e ? secondsOfDay >= s && secondsOfDay < e : secondsOfDay >= s || secondsOfDay < e;
}

/** "16:00" → "4pm", "16:30" → "4:30pm", as legacy's message wrote its fixed times. */
export function clockLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${m === 0 ? "" : `:${String(m).padStart(2, "0")}`}${h < 12 ? "am" : "pm"}`;
}

/** Legacy's message (UCFlexiGrid.ascx:124), with the configured window. */
export function freezeMessage(start: string, end: string): string {
  return `You cannot make content changes between ${clockLabel(start)}-${clockLabel(end)}. Contact the Corp Cal Manager to have emerging or urgent updates made for you during this time.`;
}
```

Add `export * from "./freeze";` to `packages/calendar-contract/src/index.ts`.

- [ ] **Step 4: Time and the freeze on the server**

`apps/calendar/src/time.ts`:

```ts
import { sql } from "drizzle-orm";
import { wallClockToInstant } from "@gcpe/config";
import type { DbOrTx, TestClock } from "@gcpe/db-kit";

export interface WallClock {
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM, 24-hour */
  time: string;
  secondsOfDay: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    formatters.set(timeZone, f);
  }
  return f;
}

/** What a clock in `timeZone` shows at `at`, by this runtime's tzdata (Node 24: BC is UTC−7 all
 * year from 2026-11-01). */
export function wallClock(at: Date, timeZone: string): WallClock {
  const parts = formatter(timeZone).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const [h, m, s] = [Number(get("hour")), Number(get("minute")), Number(get("second"))];
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}`, secondsOfDay: h * 3600 + m * 60 + s };
}

/** The instant a BC date and time name. */
export function instantOf(date: string, time: string, timeZone: string): Date {
  return wallClockToInstant(new Date(`${date}T${time}:00Z`), timeZone);
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function bcMidnight(date: string, timeZone: string): Date {
  return instantOf(date, "00:00", timeZone);
}

/** The database's clock, the platform's one clock (packages/db-kit/src/claim.ts), or a test's. */
export async function dbNow(db: DbOrTx, clock?: TestClock): Promise<Date> {
  if (clock) return clock();
  const r = await db.execute<{ ms: number }>(sql`SELECT (extract(epoch FROM now()) * 1000)::float8 AS ms`);
  return new Date(Number(r.rows[0]!.ms));
}
```

`apps/calendar/src/freeze.ts`:

```ts
import { freezeMessage, inFreezeWindow, type CalendarRules } from "@gcpe/calendar-contract";
import { can } from "./capabilities";
import { wallClock } from "./time";
import type { Viewer } from "./visibility";

/** HTTP 423 with legacy's message. */
export class FreezeError extends Error {
  override name = "FreezeError";
}

export interface FreezeState {
  start: string;
  end: string;
  timeZone: string;
  /** The window is in force now. */
  active: boolean;
  /** …and this viewer is not exempt. */
  appliesToYou: boolean;
  message: string;
}

export function freezeStateAt(now: Date, u: Viewer, rules: CalendarRules): FreezeState {
  const { start, end } = rules.freeze;
  const active = inFreezeWindow(wallClock(now, rules.timeZone).secondsOfDay, start, end);
  return { start, end, timeZone: rules.timeZone, active, appliesToYou: active && !can.skipFreeze(u), message: freezeMessage(start, end) };
}

/** Every content write calls this with the write's own database time, so an edit started before
 * the window and saved inside it is refused (spec addendum §7.4; legacy only checked page loads). */
export function assertNotFrozen(now: Date, u: Viewer, rules: CalendarRules): void {
  const state = freezeStateAt(now, u, rules);
  if (state.appliesToYou) throw new FreezeError(state.message);
}
```

- [ ] **Step 5: Wire rules, subscribers and the clock into the app**

`apps/calendar/src/app.ts`:
- Extend `AppDeps` with `rules: CalendarRules; subscribers?: SubscriberConfig[]; now?: TestClock;`.
- Change the `/api` mount's last handler to `apiRoutes({ db: deps.db, rules: deps.rules, subscribers: deps.subscribers ?? [], now: deps.now })`.

`apps/calendar/src/http/routes.ts`:

```ts
import { Router } from "express";
import type { Db, TestClock } from "@gcpe/db-kit";
import type { CalendarRules } from "@gcpe/calendar-contract";
import type { SubscriberConfig } from "@gcpe/events";
import { configRoutes } from "./config-routes";
import { lookupRoutes } from "./lookup-routes";
import { userRoutes } from "./user-routes";

export interface ApiDeps {
  db: Db;
  rules: CalendarRules;
  subscribers: SubscriberConfig[];
  /** A test hook standing in for the database's now() (packages/db-kit/src/claim.ts). */
  now?: TestClock;
}

/** The Calendar's /api, mounted behind requireBearer and requireCalendarActor. */
export function apiRoutes(deps: ApiDeps): Router {
  const r = Router();
  // What the staff app shows comes from here, never from the session's roles.
  r.get("/me", (req, res) => void res.json(req.calendar));
  r.use(configRoutes(deps));
  r.use(lookupRoutes(deps.db));
  r.use(userRoutes(deps.db));
  return r;
}
```

`apps/calendar/src/http/config-routes.ts`:

```ts
import { Router } from "express";
import { can } from "../capabilities";
import { freezeStateAt } from "../freeze";
import { dbNow } from "../time";
import type { ApiDeps } from "./routes";

/** What the list and the editor need from the tenant's calendar section, and the freeze as it
 * stands for the caller (spec addendum §7.4: the standing banner and the read-only editor). */
export function configRoutes(deps: ApiDeps): Router {
  const r = Router();
  r.get("/config", async (req, res, next) => {
    try {
      const actor = req.calendar!;
      const { rules } = deps;
      res.json({
        timeZone: rules.timeZone,
        freeze: freezeStateAt(await dbNow(deps.db, deps.now), actor, rules),
        translationsDefault: rules.translationsDefault,
        otherCityId: rules.otherCityId,
        releaseCategoryIds: rules.releaseCategoryIds,
        required: rules.required,
        showHqCommentsField: rules.showHqCommentsField,
        showRecordsSection: rules.showRecordsSection,
        lookAheadFieldset: can.seeLookAheadFieldset(actor, rules),
      });
    } catch (e) {
      next(e);
    }
  });
  return r;
}
```

`apps/calendar/src/start.ts`:
- Keep the loaded tenant: `const tenant = loadTenantConfig(parsed.TENANT_CONFIG); assertTimeZoneRules(tenant); const rules = rulesFromTenant(tenant);`.
- Pass `rules` and `subscribers` to `createApp`: `createApp({ db, auth: auth.bearer, eventSecrets: parsed.EVENT_SECRETS, rules, subscribers })`.
- In the `dispatch` worker's comment, replace "Nothing emits yet; activity.* arrives with the activity rules." with "Delivers activity.* to NRMS."

`apps/calendar/test/helpers.ts`. Add these, and change `createTestApp`:

```ts
import type { CalendarRules } from "@gcpe/calendar-contract";
import type { AppDeps } from "../src/app";

/** Fictional names only: never a legacy category name or value. */
export const TEST_RULES: CalendarRules = {
  timeZone: "America/Vancouver",
  freeze: { start: "16:00", end: "17:00" },
  releaseCategoryIds: [12, 58],
  awarenessCategoryIds: [2],
  otherCityId: 311,
  unconfirmedIssueCommMaterialId: 61,
  hqPlaceholderCategoryName: "Sample HQ placeholder",
  confidentialCategoryName: "Sample confidential category",
  issueExemptCategoryNames: ["Sample approved event", "Sample proposed release", "Sample approved release"],
  eventsCategoryNames: ["Sample approved event", "Sample proposed release", "Sample approved release", "Sample speech", "Sample HQ placeholder"],
  consultationsMinistryAbbreviation: "CONSULT",
  contactMinistryExcludedAbbreviations: ["EXCL"],
  sharedWithExcludedAbbreviations: ["EXCL"],
  translationsDefault: ["Sample language A", "Sample language B"],
  required: { significance: true, scheduling: true, strategy: false },
  showHqCommentsField: false,
  showRecordsSection: false,
  cloneKeptKeywordNames: ["Sample kept keyword"],
  lookAheadCoverImage: null,
  reportBanner: { province: "Sample Province", confidentiality: "DRAFT AND CONFIDENTIAL" },
};

/** 11:00 BC on 2026-11-03: outside the freeze, so a test run at 16:30 BC behaves like any other. */
export const FIXED_NOW = new Date("2026-11-03T18:00:00Z");

export function createTestApp(db: Db, over: Partial<AppDeps> = {}): express.Express {
  return createApp({ db, auth: { session: { secret: SESSION_SECRET } }, eventSecrets: EVENT_SECRETS, rules: TEST_RULES, subscribers: [], now: () => FIXED_NOW, ...over });
}
```

Also move `waitForLockWaiter` from `apps/calendar/src/http/user-routes.test.ts` into `test/helpers.ts`, exported unchanged. `user-routes.test.ts` imports it from there.

- [ ] **Step 6: Run the tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/calendar-contract apps/calendar apps/stack/src/stack.test.ts`
Expected: PASS. The existing Calendar and stack tests still pass, because the stack starts the Calendar with bc.json's section.

Then run `time.test.ts` once under the default Node 22 (`node node_modules/vitest/vitest.mjs run apps/calendar/src/time.test.ts`). Expected: FAIL on "BC is UTC−7 on both sides of 2026-11-01". That proves the test discriminates stale tzdata. Note the result in the commit message body.

- [ ] **Step 7: Commit**

```bash
git add packages/calendar-contract apps/calendar
git commit -m "feat(calendar): BC wall clock on the database's time; the change freeze across 2026-11-01; GET /api/config"
```

---
### Task 4: The shared validation schema and Look Ahead inference

Covers: spec §7.2 (validation, one schema shared with the form, C156; the required fields, the cross-field rules, the lengths on new values only, imported data, the warnings, the text clean-up, C145) and §7.6 (Look Ahead inference). Decisions F6, F10 and F11. Everything here is pure and runs in the browser too.

**Files:**
- Create in `packages/calendar-contract/src/`: `input.ts`, `clean.ts` (+ `clean.test.ts`), `look-ahead.ts` (+ `look-ahead.test.ts`), `validate.ts` (+ `validate.test.ts`).
- Modify: `packages/calendar-contract/src/index.ts`.

**Interfaces:**
- Consumes: `HQ_SECTIONS`, `HQ_STATUSES`, `HqSection`, `CalendarRules` (Task 1).
- Produces:
  - **The schemas:**
    - `activityFieldsSchema` and `type ActivityFields` (the fields below);
    - `lookAheadFieldsSchema` and `type LookAheadFields = { hqComments: string; hqStatus: HqStatus | null; hqSection: HqSection; longTermOutlook: boolean }`;
    - `createActivitySchema`, which is `activityFieldsSchema`;
    - `updateActivitySchema`: `ActivityFields & { version: number; tabId: string | null }`, strict. `type UpdateActivityInput`.
  - **The clean-up:** `replaceSpecialCharacters(s)`, `cleanTitle(s)` and `cleanDetails(s)`.
  - **Inference:**
    - `interface LookAheadInput { categoryIds; categoryNames; contactMinistryAbbreviation; isConfidential; isIssue; isConfirmed; commMaterialIds; startDate; endDate; currentSection: HqSection | null }`;
    - `type LookAheadInference = { kind: "awareness" } | { kind: "consultations" } | { kind: "section"; section: HqSection }`;
    - `inferLookAhead(i, rules): LookAheadInference`;
    - `sectionToStore({ before, after, chosen }, rules): HqSection`.
  - **Validation:**
    - `interface FieldError { field: string; message: string }`;
    - `interface CheckContext { rules; relaxRequired; lookAheadFieldset; previous: ActivityFields | null; inferredSection: HqSection | null }`;
    - `checkActivity(i, ctx): FieldError[]`;
    - `warningsFor(i, todayBc: string): string[]`;
    - `LIMITS` and `LIST_LIMITS`.

`ActivityFields` holds these groups:
- **Category:** `categoryId: number | null`.
- **Text:** `title`, `details`, `significance`, `strategy`, `schedule`, `comments`, `leadOrganization`, `venue`, `otherCity` and `potentialDates`, all strings.
- **Flags:** `isIssue`, `isConfidential`, `isMilestone`, `isCrossGovernment`, `isAtLegislature`, `isAllDay` and `isConfirmed`.
- **Dates and times:** `startDate`/`endDate`/`nrDate` as `YYYY-MM-DD | null`, and `startTime`/`endTime`/`nrTime` as `HH:MM | null`, all in BC wall-clock time.
- **Ministry and single references:** `contactMinistryKey`, plus the ids `commContactId`, `governmentRepresentativeId`, `cityId`, `premierRequestedId`, `nrDistributionId`, `eventPlannerId`, `videographerId` and `nrOriginId`.
- **Lists:** `commMaterialIds`, `initiativeIds`, `keywordNames`, `sectorKeys`, `themeKeys`, `tagKeys`, `sharedWithKeys` and `translations`.
- **Look Ahead:** `lookAhead?: LookAheadFields`.

- [ ] **Step 1: Write the failing tests**

`packages/calendar-contract/src/clean.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { cleanDetails, cleanTitle } from "./clean";

describe("legacy's text clean-up (C145: on create as on update)", () => {
  it("a title: trimmed, line breaks as spaces, special characters replaced", () => {
    expect(cleanTitle("  “Sample”\r\ntitle — one… ")).toBe('"Sample"  title - one...');
  });
  it("details: trimmed and special characters replaced, line breaks kept", () => {
    expect(cleanDetails(" It’s\nhere now ")).toBe("It's\nhere now");
  });
});
```

`packages/calendar-contract/src/look-ahead.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { inferLookAhead, sectionToStore, type LookAheadInput } from "./look-ahead";

const rules = {
  awarenessCategoryIds: [2],
  consultationsMinistryAbbreviation: "CONSULT",
  issueExemptCategoryNames: ["Sample approved event"],
  eventsCategoryNames: ["Sample approved event", "Sample speech"],
  unconfirmedIssueCommMaterialId: 61,
};
const base: LookAheadInput = {
  categoryIds: [32], categoryNames: ["Sample plain category"], contactMinistryAbbreviation: "HLTH",
  isConfidential: false, isIssue: false, isConfirmed: false, commMaterialIds: [],
  startDate: "2026-11-10", endDate: "2026-11-20", currentSection: null,
};
const infer = (over: Partial<LookAheadInput>) => inferLookAhead({ ...base, ...over }, rules);

describe("Look Ahead inference, in legacy's order (Activity.aspx:2466-2521)", () => {
  it("1. Awareness category: fixed, whatever else is set", () => expect(infer({ categoryIds: [2], isIssue: true, isConfirmed: true })).toEqual({ kind: "awareness" }));
  it("2. the consultations ministry: fixed", () => expect(infer({ contactMinistryAbbreviation: "CONSULT", isConfirmed: true })).toEqual({ kind: "consultations" }));
  it("3. confidential: keeps the section it has; a new one is Not on LA", () => {
    expect(infer({ isConfidential: true, isConfirmed: true, currentSection: "in_the_news" })).toEqual({ kind: "section", section: "in_the_news" });
    expect(infer({ isConfidential: true, isConfirmed: true })).toEqual({ kind: "section", section: "not_on_la" });
  });
  it("4. an issue → Issues & Reports, unless an event-like category", () => {
    expect(infer({ isIssue: true })).toEqual({ kind: "section", section: "issues_and_reports" });
    expect(infer({ isIssue: true, isConfirmed: true, categoryNames: ["Sample approved event"] })).toEqual({ kind: "section", section: "events_and_speeches" });
  });
  it("5. unconfirmed with the marker comm material → Issues & Reports", () => {
    expect(infer({ commMaterialIds: [61] })).toEqual({ kind: "section", section: "issues_and_reports" });
    expect(infer({ commMaterialIds: [61], isConfirmed: true })).toEqual({ kind: "section", section: "in_the_news" });
  });
  it("6. confirmed, or ending within 2 days → In the News; event categories → Events & Speeches", () => {
    expect(infer({ isConfirmed: true })).toEqual({ kind: "section", section: "in_the_news" });
    expect(infer({ endDate: "2026-11-11" })).toEqual({ kind: "section", section: "in_the_news" });
    expect(infer({ endDate: "2026-11-12" })).toEqual({ kind: "section", section: "not_on_la" });
    expect(infer({ isConfirmed: true, categoryNames: ["Sample speech"] })).toEqual({ kind: "section", section: "events_and_speeches" });
  });
  it("otherwise Not on LA; with no dates, never 'within 2 days'", () => {
    expect(infer({})).toEqual({ kind: "section", section: "not_on_la" });
    expect(infer({ startDate: null, endDate: null })).toEqual({ kind: "section", section: "not_on_la" });
  });
});

describe("the section the server stores (spec addendum §7.6)", () => {
  const stored = (over: Partial<LookAheadInput>): LookAheadInput => ({ ...base, ...over });
  it("a Look Ahead fieldset user's choice wins", () => {
    expect(sectionToStore({ before: null, after: base, chosen: "events_and_speeches" }, rules)).toBe("events_and_speeches");
  });
  it("on create, the inference", () => {
    expect(sectionToStore({ before: null, after: { ...base, isConfirmed: true }, chosen: undefined }, rules)).toBe("in_the_news");
  });
  it("on update, the new inference when the stored section was inferred", () => {
    const before = stored({ isConfirmed: true, currentSection: "in_the_news" });
    expect(sectionToStore({ before, after: { ...before, isIssue: true }, chosen: undefined }, rules)).toBe("issues_and_reports");
  });
  it("an HQ override (a stored section the stored fields don't infer) stays through a ministry user's save", () => {
    const before = stored({ isConfirmed: true, currentSection: "events_and_speeches" });
    expect(sectionToStore({ before, after: { ...before, isIssue: true }, chosen: undefined }, rules)).toBe("events_and_speeches");
  });
  it("awareness and consultations keep the stored section; a new one stores Not on LA", () => {
    expect(sectionToStore({ before: null, after: { ...base, categoryIds: [2] }, chosen: undefined }, rules)).toBe("not_on_la");
    const before = stored({ categoryIds: [2], currentSection: "in_the_news" });
    expect(sectionToStore({ before, after: before, chosen: undefined }, rules)).toBe("in_the_news");
  });
});
```

`packages/calendar-contract/src/validate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ActivityFields } from "./input";
import { checkActivity, warningsFor, type CheckContext } from "./validate";

const ok: ActivityFields = {
  categoryId: 32, title: "Sample activity", details: "Sample summary", significance: "Sample significance", strategy: "", schedule: "Sample scheduling",
  comments: "", leadOrganization: "", venue: "", otherCity: "", potentialDates: "",
  isIssue: false, isConfidential: false, isMilestone: false, isCrossGovernment: false, isAtLegislature: false, isAllDay: false, isConfirmed: true,
  startDate: "2026-11-10", startTime: "09:00", endDate: "2026-11-10", endTime: "10:00", nrDate: null, nrTime: null,
  contactMinistryKey: "health", commContactId: 1, governmentRepresentativeId: null, cityId: 1, premierRequestedId: null,
  nrDistributionId: null, eventPlannerId: null, videographerId: null, nrOriginId: null,
  commMaterialIds: [], initiativeIds: [], keywordNames: [], sectorKeys: [], themeKeys: [], tagKeys: [], sharedWithKeys: [], translations: [],
};
const ctx: CheckContext = { rules: { releaseCategoryIds: [12, 58], required: { significance: true, scheduling: true, strategy: false } }, relaxRequired: false, lookAheadFieldset: false, previous: null, inferredSection: "in_the_news" };
const fields = (over: Partial<ActivityFields>, c: Partial<CheckContext> = {}) => checkActivity({ ...ok, ...over }, { ...ctx, ...c }).map((e) => e.field);

describe("the editor's rules, on the server too (spec addendum §7.2, C156)", () => {
  it("a complete activity passes", () => expect(fields({})).toEqual([]));

  it.each<[string, Partial<ActivityFields>, string[]]>([
    ["no category", { categoryId: null }, ["categoryId"]],
    ["no lead ministry", { contactMinistryKey: null }, ["contactMinistryKey"]],
    ["a blank title", { title: "   " }, ["title"]],
    ["no comm contact (19 imported activities lack one)", { commContactId: null }, ["commContactId"]],
    ["no dates", { startDate: null, endDate: null }, ["startDate", "endDate"]],
    ["no times, not all day", { startTime: null, endTime: null }, ["startTime", "endTime"]],
    ["all day needs no times", { isAllDay: true, startTime: null, endTime: null }, []],
    ["no summary", { details: "" }, ["details"]],
    ["no significance or scheduling", { significance: "", schedule: "" }, ["significance", "schedule"]],
    ["a release category without origin, distribution or comm materials", { categoryId: 58 }, ["nrOriginId", "nrDistributionId", "commMaterialIds"]],
    ["a release category with all three", { categoryId: 12, nrOriginId: 1, nrDistributionId: 1, commMaterialIds: [1] }, []],
    ["ending before it starts (108 imported activities do)", { endDate: "2026-11-09" }, ["endDate"]],
    ["a single day whose start time is after its end time", { startTime: "11:00", endTime: "10:00" }, ["endTime"]],
    ["a single day with equal times", { startTime: "10:00", endTime: "10:00" }, []],
    ["a release date after the end date", { nrDate: "2026-11-11", nrTime: "09:00" }, ["nrDate"]],
    ["a release date without a time, and a time without a date", { nrDate: "2026-11-10" }, ["nrTime"]],
    ["times off the 5-minute steps", { startTime: "09:03", endTime: "10:01" }, ["startTime", "endTime"]],
    ["Potential Dates with TBD", { potentialDates: "late june, tbd" }, ["potentialDates"]],
    ["Potential Dates with a digit", { potentialDates: "June 2027" }, ["potentialDates"]],
    ["Potential Dates as a timeline", { potentialDates: "late June" }, []],
    ["a 101-character title", { title: "x".repeat(101) }, ["title"]],
    ["a 56-character venue", { venue: "x".repeat(56) }, ["venue"]],
    ["an 81-character lead organization", { leadOrganization: "x".repeat(81) }, ["leadOrganization"]],
    ["a 51-character Potential Dates", { potentialDates: "x".repeat(51) }, ["potentialDates"]],
    ["31 translations", { translations: Array.from({ length: 31 }, (_, n) => `Language ${"abcdefghijklmnopqrstuvwxyzABCDE"[n]}`) }, ["translations"]],
    ["a translation with a comma", { translations: ["One, two"] }, ["translations"]],
    ["21 HQ tags", { keywordNames: Array.from({ length: 21 }, (_, n) => `Tag ${n}`) }, ["keywordNames"]],
    ["a blank HQ tag", { keywordNames: [" "] }, ["keywordNames"]],
  ])("%s", (_name, over, expected) => expect(fields(over)).toEqual(expected));

  it("HQ isn't required to give Details, Significance or Scheduling; Strategy follows its switch", () => {
    expect(fields({ details: "", significance: "", schedule: "" }, { relaxRequired: true })).toEqual([]);
    expect(fields({}, { rules: { ...ctx.rules, required: { significance: false, scheduling: false, strategy: true } } })).toEqual(["strategy"]);
  });

  it("a limit applies only to a changed value: an imported over-long title saves unchanged, and is refused once edited", () => {
    const long = "x".repeat(150);
    expect(fields({ title: long }, { previous: { ...ok, title: long } })).toEqual([]);
    expect(fields({ title: `${long}y` }, { previous: { ...ok, title: long } })).toEqual(["title"]);
  });

  it("Look Ahead fields from someone without the fieldset are refused", () => {
    expect(fields({ lookAhead: { hqComments: "", hqStatus: null, hqSection: "in_the_news", longTermOutlook: false } })).toEqual(["lookAhead"]);
  });

  it("a confidential activity whose section is overridden needs an Executive Summary (Activity.aspx:2419-2421)", () => {
    const lookAhead = { hqComments: "", hqStatus: null, hqSection: "events_and_speeches" as const, longTermOutlook: false };
    expect(fields({ isConfidential: true, lookAhead }, { lookAheadFieldset: true })).toEqual(["lookAhead.hqComments"]);
    expect(fields({ isConfidential: true, lookAhead: { ...lookAhead, hqComments: "Sample summary" } }, { lookAheadFieldset: true })).toEqual([]);
    expect(fields({ isConfidential: true, lookAhead: { ...lookAhead, hqSection: "in_the_news" } }, { lookAheadFieldset: true })).toEqual([]);
  });

  it("dates in the past are a warning, not an error (Activity.aspx:731)", () => {
    expect(warningsFor({ ...ok, startDate: "2026-11-01", endDate: "2026-11-02" }, "2026-11-03")).toEqual(["The start date is in the past.", "The end date is in the past."]);
    expect(warningsFor(ok, "2026-11-03")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/calendar-contract`
Expected: FAIL. The modules don't exist.

- [ ] **Step 3: Implement the input schema and the clean-up**

`packages/calendar-contract/src/input.ts`:

```ts
import { z } from "zod";
import { HQ_SECTIONS, HQ_STATUSES } from "./enums";

const id = z.number().int().positive();
const realDate = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
};
/** A BC calendar date. */
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD").refine(realDate, "not a real date");
/** A BC wall-clock time, 24-hour. */
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM, 24-hour");
// These caps only bound the request. The editor's own limits are checkActivity's, on changed values.
const text = z.string().max(10_000);
const keys = z.array(z.string().min(1).max(200)).max(200);
const ids = z.array(id).max(200);

export const lookAheadFieldsSchema = z
  .object({ hqComments: text, hqStatus: z.enum(HQ_STATUSES).nullable(), hqSection: z.enum(HQ_SECTIONS), longTermOutlook: z.boolean() })
  .strict();
export type LookAheadFields = z.infer<typeof lookAheadFieldsSchema>;

/**
 * Everything the editor saves (spec addendum §8.2). Status, needs-review flags, versions and
 * bookkeeping are the server's: strict, so a body that sets them is refused.
 */
export const activityFieldsSchema = z
  .object({
    /** The editor's single category; an imported activity can hold two, kept while this is unchanged. */
    categoryId: id.nullable(),
    title: text,
    details: text,
    significance: text,
    strategy: text,
    schedule: text,
    comments: text,
    leadOrganization: text,
    venue: text,
    otherCity: text,
    potentialDates: text,
    isIssue: z.boolean(),
    isConfidential: z.boolean(),
    isMilestone: z.boolean(),
    isCrossGovernment: z.boolean(),
    isAtLegislature: z.boolean(),
    isAllDay: z.boolean(),
    isConfirmed: z.boolean(),
    startDate: date.nullable(),
    startTime: time.nullable(),
    endDate: date.nullable(),
    endTime: time.nullable(),
    nrDate: date.nullable(),
    nrTime: time.nullable(),
    contactMinistryKey: z.string().min(1).max(200).nullable(),
    commContactId: id.nullable(),
    governmentRepresentativeId: id.nullable(),
    cityId: id.nullable(),
    premierRequestedId: id.nullable(),
    nrDistributionId: id.nullable(),
    eventPlannerId: id.nullable(),
    videographerId: id.nullable(),
    /** Single-select in the editor; an imported activity's several origins are kept while this is unchanged. */
    nrOriginId: id.nullable(),
    commMaterialIds: ids,
    initiativeIds: ids,
    /** HQ Tags, by name: a new name creates the keyword (C146). */
    keywordNames: z.array(z.string().max(1000)).max(200),
    sectorKeys: keys,
    themeKeys: keys,
    /** News Subscribe. */
    tagKeys: keys,
    sharedWithKeys: keys,
    translations: z.array(z.string().max(1000)).max(200),
    /** Only from users who see the Look Ahead fieldset (spec addendum §6). */
    lookAhead: lookAheadFieldsSchema.optional(),
  })
  .strict();
export type ActivityFields = z.infer<typeof activityFieldsSchema>;

export const createActivitySchema = activityFieldsSchema;
export const updateActivitySchema = activityFieldsSchema.extend({ version: z.number().int().positive(), tabId: z.string().min(1).max(100).nullable() }).strict();
export type UpdateActivityInput = z.infer<typeof updateActivitySchema>;
```

`packages/calendar-contract/src/clean.ts`:

```ts
/** Legacy's ReplaceSpecialCharacters (Activity.aspx.cs:1076-1087). */
export function replaceSpecialCharacters(text: string): string {
  return text
    .replace(/[‘’‚]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/…/g, "...")
    .replace(/[–—]/g, "-")
    .replace(/ˆ/g, "^")
    .replace(/‹/g, "<")
    .replace(/›/g, ">")
    .replace(/[˜ ]/g, " ");
}

/** The title as legacy saved it: trimmed, each line break a space, special characters replaced. */
export function cleanTitle(title: string): string {
  return replaceSpecialCharacters(title.trim().replace(/\r/g, " ").replace(/\n/g, " "));
}

export function cleanDetails(details: string): string {
  return replaceSpecialCharacters(details.trim());
}
```

- [ ] **Step 4: Implement inference and validation**

`packages/calendar-contract/src/look-ahead.ts`:

```ts
import type { HqSection } from "./enums";
import type { CalendarRules } from "./rules";

export interface LookAheadInput {
  categoryIds: readonly number[];
  categoryNames: readonly string[];
  contactMinistryAbbreviation: string | null;
  isConfidential: boolean;
  isIssue: boolean;
  isConfirmed: boolean;
  commMaterialIds: readonly number[];
  /** BC dates. */
  startDate: string | null;
  endDate: string | null;
  /** The section the activity has now; null for a new one. */
  currentSection: HqSection | null;
}

export type LookAheadInference = { kind: "awareness" } | { kind: "consultations" } | { kind: "section"; section: HqSection };

type Rules = Pick<CalendarRules, "awarenessCategoryIds" | "consultationsMinistryAbbreviation" | "issueExemptCategoryNames" | "eventsCategoryNames" | "unconfirmedIssueCommMaterialId">;

const plusDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Legacy's InferLASection (Activity.aspx:2466-2521), in its order. */
export function inferLookAhead(i: LookAheadInput, rules: Rules): LookAheadInference {
  if (i.categoryIds.some((c) => rules.awarenessCategoryIds.includes(c))) return { kind: "awareness" };
  if (i.contactMinistryAbbreviation === rules.consultationsMinistryAbbreviation) return { kind: "consultations" };
  // Ticking "Not for Look Ahead" never unassigns a section the activity already has (Activity.aspx:2488-2489).
  if (i.isConfidential) return { kind: "section", section: i.currentSection ?? "not_on_la" };
  const named = (list: readonly string[]) => i.categoryNames.some((n) => list.includes(n));
  if (i.isIssue && !named(rules.issueExemptCategoryNames)) return { kind: "section", section: "issues_and_reports" };
  if (!i.isConfirmed && i.commMaterialIds.includes(rules.unconfirmedIssueCommMaterialId)) return { kind: "section", section: "issues_and_reports" };
  const endsWithinTwoDays = i.startDate !== null && i.endDate !== null && i.endDate < plusDays(i.startDate, 2);
  if (i.isConfirmed || endsWithinTwoDays) return { kind: "section", section: named(rules.eventsCategoryNames) ? "events_and_speeches" : "in_the_news" };
  return { kind: "section", section: "not_on_la" };
}

export interface SectionChoice {
  /** The stored activity's inputs, its stored section as currentSection; null on create. */
  before: LookAheadInput | null;
  /** The saved inputs, with currentSection still the stored section (null on create). */
  after: LookAheadInput;
  /** A Look Ahead fieldset user's own choice, when they sent one. */
  chosen: HqSection | undefined;
}

/**
 * The section the server stores (spec addendum §7.6). For everyone without the fieldset it is
 * re-inferred on every save, as legacy's hidden fieldset was, except that a stored section the
 * stored fields don't infer is an HQ override, which the page never re-inferred (Activity.aspx:2544-2546).
 */
export function sectionToStore(c: SectionChoice, rules: Rules): HqSection {
  if (c.chosen !== undefined) return c.chosen;
  const stored = c.before?.currentSection ?? null;
  if (c.before && stored !== null) {
    const was = inferLookAhead(c.before, rules);
    if (was.kind === "section" && was.section !== stored) return stored;
  }
  const now = inferLookAhead(c.after, rules);
  return now.kind === "section" ? now.section : (stored ?? "not_on_la");
}
```

`packages/calendar-contract/src/validate.ts`:

```ts
import { cleanTitle } from "./clean";
import type { HqSection } from "./enums";
import type { ActivityFields } from "./input";
import type { CalendarRules } from "./rules";

export interface FieldError {
  /** The input property, or "lookAhead.hqComments" for the Executive Summary. */
  field: string;
  message: string;
}

export interface CheckContext {
  rules: Pick<CalendarRules, "releaseCategoryIds" | "required">;
  /** HQ at Editor and above: Details, Significance and Scheduling aren't required (Activity.aspx.cs:224-230). */
  relaxRequired: boolean;
  /** The caller sees the Look Ahead fieldset (spec addendum §6). */
  lookAheadFieldset: boolean;
  /** The stored values, on an update: limits apply to changed values only. */
  previous: ActivityFields | null;
  /** The inferred section for the saved values, or null when it is fixed (awareness, consultations). */
  inferredSection: HqSection | null;
}

/** Legacy's limits (Activity.aspx:2630-2668,2788-2798; Potential Dates Activity.aspx:789). */
export const LIMITS = {
  title: 100, details: 700, significance: 500, schedule: 500, strategy: 500, comments: 4000,
  venue: 55, otherCity: 55, leadOrganization: 80, potentialDates: 50, hqComments: 2000,
} as const;
export const LIST_LIMITS = { translations: 30, translationLength: 50, keywords: 20, keywordLength: 255 } as const;

const blank = (s: string) => s.trim() === "";
const offStep = (t: string | null) => t !== null && Number(t.slice(3)) % 5 !== 0;

export function checkActivity(i: ActivityFields, ctx: CheckContext): FieldError[] {
  const errors: FieldError[] = [];
  const add = (field: string, message: string) => errors.push({ field, message });

  // Required on every save: an imported activity that breaks one is read as it is, and its next save fixes it.
  if (i.categoryId === null) add("categoryId", "Choose a category");
  if (i.contactMinistryKey === null) add("contactMinistryKey", "Choose the lead ministry");
  if (blank(i.title)) add("title", "Enter a title");
  if (i.commContactId === null) add("commContactId", "Choose a comm contact");
  if (i.startDate === null) add("startDate", "Enter a start date");
  if (i.endDate === null) add("endDate", "Enter an end date");
  if (!i.isAllDay && i.startTime === null) add("startTime", "Enter a start time, or tick All Day");
  if (!i.isAllDay && i.endTime === null) add("endTime", "Enter an end time, or tick All Day");
  if (!ctx.relaxRequired) {
    if (blank(i.details)) add("details", "Enter a summary");
    if (ctx.rules.required.significance && blank(i.significance)) add("significance", "Enter the significance");
    if (ctx.rules.required.scheduling && blank(i.schedule)) add("schedule", "Enter the scheduling considerations");
  }
  if (ctx.rules.required.strategy && blank(i.strategy)) add("strategy", "Enter the strategy");

  // Proposed and Approved Release (Activity.aspx:144-186).
  if (i.categoryId !== null && ctx.rules.releaseCategoryIds.includes(i.categoryId)) {
    if (i.nrOriginId === null) add("nrOriginId", "Choose the origin: this category is a release");
    if (i.nrDistributionId === null) add("nrDistributionId", "Choose the distribution: this category is a release");
    if (i.commMaterialIds.length === 0) add("commMaterialIds", "Choose the comm materials: this category is a release");
  }

  if (i.startDate && i.endDate) {
    if (i.endDate < i.startDate) add("endDate", "The end date can't be before the start date");
    else if (i.endDate === i.startDate && !i.isAllDay && i.startTime && i.endTime && i.startTime > i.endTime) add("endTime", "The start time can't be after the end time");
  }
  if (i.nrDate !== null && i.nrTime === null) add("nrTime", "Enter the release time");
  if (i.nrDate === null && i.nrTime !== null) add("nrDate", "Enter the release date");
  if (i.nrDate && i.endDate && i.nrDate > i.endDate) add("nrDate", "The release date can't be after the end date");
  if (!i.isAllDay && offStep(i.startTime)) add("startTime", "Use 5-minute steps");
  if (!i.isAllDay && offStep(i.endTime)) add("endTime", "Use 5-minute steps");
  if (offStep(i.nrTime)) add("nrTime", "Use 5-minute steps");
  // Activity.aspx:302-307
  if (/TBC|TBD/i.test(i.potentialDates) || /\d/.test(i.potentialDates)) {
    add("potentialDates", "Potential dates can't use TBC, TBD or numbers. Use a general timeline, like winter or late June.");
  }

  if (i.lookAhead && !ctx.lookAheadFieldset) add("lookAhead", "Only HQ can change the Look Ahead fields");
  if (i.lookAhead && ctx.lookAheadFieldset && i.isConfidential && ctx.inferredSection !== null && i.lookAhead.hqSection !== ctx.inferredSection && blank(i.lookAhead.hqComments)) {
    // Activity.aspx:2419-2421
    add("lookAhead.hqComments", "Enter an Executive Summary: this Not-for-Look-Ahead activity's section is overridden");
  }

  // Lengths apply to new values only: imported titles reach 217 characters (SV 4.5).
  const prev = ctx.previous;
  const limit = (field: keyof typeof LIMITS, value: string, before: string | undefined, name: string = field) => {
    if (value.length > LIMITS[field] && value !== before) add(name, `At most ${LIMITS[field]} characters`);
  };
  limit("title", cleanTitle(i.title), prev ? cleanTitle(prev.title) : undefined);
  for (const f of ["details", "significance", "schedule", "strategy", "comments", "venue", "otherCity", "leadOrganization", "potentialDates"] as const) {
    limit(f, i[f].trim(), prev?.[f].trim());
  }
  if (i.lookAhead) limit("hqComments", i.lookAhead.hqComments.trim(), prev?.lookAhead?.hqComments.trim(), "lookAhead.hqComments");

  const translations = [...new Set(i.translations.map((t) => t.trim()))];
  if (translations.length > LIST_LIMITS.translations) add("translations", `At most ${LIST_LIMITS.translations} languages`);
  else if (translations.some((t) => t === "" || t.length > LIST_LIMITS.translationLength || t.includes(","))) {
    add("translations", `Each language: 1 to ${LIST_LIMITS.translationLength} characters, with no comma`);
  }
  const keywords = [...new Set(i.keywordNames.map((k) => k.trim().toLowerCase()))];
  if (keywords.length > LIST_LIMITS.keywords) add("keywordNames", `At most ${LIST_LIMITS.keywords} HQ tags`);
  else if (keywords.some((k) => k === "" || k.length > LIST_LIMITS.keywordLength)) add("keywordNames", `Each HQ tag: 1 to ${LIST_LIMITS.keywordLength} characters`);

  return errors;
}

/** Saved anyway, with a warning (Activity.aspx:731). `todayBc` is BC's date now. */
export function warningsFor(i: ActivityFields, todayBc: string): string[] {
  const w: string[] = [];
  if (i.startDate && i.startDate < todayBc) w.push("The start date is in the past.");
  if (i.endDate && i.endDate < todayBc) w.push("The end date is in the past.");
  return w;
}
```

Add to `packages/calendar-contract/src/index.ts`:

```ts
export * from "./input";
export * from "./clean";
export * from "./look-ahead";
export * from "./validate";
```

- [ ] **Step 5: Run the tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/calendar-contract`
Expected: PASS.

Run: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/calendar-contract
git commit -m "feat(calendar-contract): the shared activity schema, validation and Look Ahead inference"
```

---

### Task 5: Needs-review and status, generated from legacy's trigger table

Covers: spec §7.3 (every row a test case; the 23 keys; keywords compared as sets, C130; trimmed text; create sets nothing), the §3 exit check ("rule tests generated from the legacy trigger table"), and the carry-forward item "`needs_review` writers de-duplicate". Decision F8.

**Files:**
- Create: `apps/calendar/src/activities/review-rules.ts` (+ `review-rules.test.ts`).

**Interfaces:**
- Consumes: `NEEDS_REVIEW_KEYS`, `NeedsReviewKey` (Task 1).
- Produces:
  - `interface ReviewSnapshot`, holding:
    - text: `title`, `details`, `otherCity`, `potentialDates`, `significance`, `comments`, `schedule`, `strategy`, `leadOrganization` and `venue`;
    - ids: `governmentRepresentativeId`, `cityId`, `premierRequestedId`, `nrDistributionId`, `eventPlannerId` and `videographerId`;
    - instants: `startAt` and `endAt`, as `number | null` (epoch ms);
    - id lists: `categoryIds`, `commMaterialIds`, `initiativeIds`, `keywordIds` and `nrOriginIds`;
    - `translations: string[]`;
    - flags: `isIssue`, `isConfidential`, `isConfirmed`, `isAllDay` and `isCrossGovernment`.
  - `reviewChanges(before: ReviewSnapshot, after: ReviewSnapshot): { flags: NeedsReviewKey[]; statusChanged: boolean }`.
  - `mergeNeedsReview(current: readonly string[], add: readonly NeedsReviewKey[]): NeedsReviewKey[]`. A de-duplicated union in `NEEDS_REVIEW_KEYS` order.
  - `REVIEW_CLEARED_KEYS`: the 22 keys Review clears, every key but `active`.

- [ ] **Step 1: Write the failing test, generated from the table**

`apps/calendar/src/activities/review-rules.test.ts`. The table is spec §7.3, row for row. Each row is one mutation of a base snapshot with every field set. Its expected result is exactly the row's flag (or none) and status.

```ts
import { describe, expect, it } from "vitest";
import { NEEDS_REVIEW_KEYS, type NeedsReviewKey } from "@gcpe/calendar-contract";
import { mergeNeedsReview, REVIEW_CLEARED_KEYS, reviewChanges, type ReviewSnapshot } from "./review-rules";

const base: ReviewSnapshot = {
  title: "Sample title", details: "Sample details", governmentRepresentativeId: 1, cityId: 1, otherCity: "",
  startAt: Date.UTC(2026, 10, 10, 17), endAt: Date.UTC(2026, 10, 10, 18), potentialDates: "",
  categoryIds: [32], isIssue: false, isConfidential: false, commMaterialIds: [1],
  significance: "Sample significance", comments: "Sample notes", schedule: "Sample schedule", strategy: "Sample strategy",
  leadOrganization: "Sample org", venue: "Sample venue", initiativeIds: [1], keywordIds: [1, 2], nrOriginIds: [1],
  translations: ["Sample language A"], premierRequestedId: 1, nrDistributionId: 1, eventPlannerId: 1, videographerId: 1,
  isConfirmed: true, isAllDay: false, isCrossGovernment: false,
};

/** Spec addendum §7.3, one row per change. `flag: null` is "none". */
const TRIGGER_TABLE: { change: string; apply: (s: ReviewSnapshot) => Partial<ReviewSnapshot>; flag: NeedsReviewKey | null; status: boolean }[] = [
  { change: "Title", apply: (s) => ({ title: `${s.title} changed` }), flag: "title", status: true },
  { change: "Details", apply: () => ({ details: "Other details" }), flag: "details", status: true },
  { change: "Representative", apply: () => ({ governmentRepresentativeId: 2 }), flag: "representative", status: true },
  { change: "Representative cleared", apply: () => ({ governmentRepresentativeId: null }), flag: "representative", status: true },
  { change: "City", apply: () => ({ cityId: 2 }), flag: "city", status: true },
  { change: "Other City", apply: () => ({ otherCity: "Sample place" }), flag: "city", status: true },
  { change: "Start", apply: (s) => ({ startAt: s.startAt! + 3_600_000 }), flag: "start_date", status: true },
  { change: "Potential Dates", apply: () => ({ potentialDates: "late spring" }), flag: "start_date", status: true },
  { change: "End", apply: (s) => ({ endAt: s.endAt! + 3_600_000 }), flag: "end_date", status: true },
  { change: "Category", apply: () => ({ categoryIds: [30] }), flag: "categories", status: true },
  { change: "Issue", apply: () => ({ isIssue: true }), flag: "categories", status: true },
  { change: "Confidential", apply: () => ({ isConfidential: true }), flag: "categories", status: true },
  { change: "Comm materials", apply: () => ({ commMaterialIds: [1, 61] }), flag: "comm_materials", status: true },
  { change: "Significance", apply: () => ({ significance: "Other significance" }), flag: "significance", status: true },
  { change: "Internal notes", apply: () => ({ comments: "Other notes" }), flag: "internal_notes", status: true },
  { change: "Scheduling", apply: () => ({ schedule: "Other schedule" }), flag: "scheduling_considerations", status: true },
  { change: "Strategy", apply: () => ({ strategy: "Other strategy" }), flag: "strategy", status: true },
  { change: "Lead organization", apply: () => ({ leadOrganization: "Other org" }), flag: "lead_organization", status: true },
  { change: "Venue", apply: () => ({ venue: "Other venue" }), flag: "venue", status: true },
  { change: "Initiatives", apply: () => ({ initiativeIds: [] }), flag: "initiatives", status: true },
  { change: "HQ Tags: the set changes, count unchanged (C130)", apply: () => ({ keywordIds: [1, 3] }), flag: "tags", status: true },
  { change: "HQ Tags: one added", apply: () => ({ keywordIds: [1, 2, 3] }), flag: "tags", status: true },
  { change: "NR Origin", apply: () => ({ nrOriginIds: [2] }), flag: "origin", status: true },
  { change: "NR Origin to empty", apply: () => ({ nrOriginIds: [] }), flag: "origin", status: true },
  { change: "Translations", apply: () => ({ translations: ["Sample language A", "Sample language B"] }), flag: "translations_required", status: true },
  { change: "Premier Requested to a new non-empty value", apply: () => ({ premierRequestedId: 2 }), flag: "premier_requested", status: true },
  { change: "Premier Requested cleared", apply: () => ({ premierRequestedId: null }), flag: null, status: true },
  { change: "NR Distribution to a new non-empty value", apply: () => ({ nrDistributionId: 2 }), flag: "distribution", status: true },
  { change: "NR Distribution cleared", apply: () => ({ nrDistributionId: null }), flag: null, status: true },
  { change: "Event planner to a new non-empty value", apply: () => ({ eventPlannerId: 2 }), flag: "event_planner", status: true },
  { change: "Digital to a new non-empty value", apply: () => ({ videographerId: 2 }), flag: "digital", status: true },
  { change: "Event planner cleared", apply: () => ({ eventPlannerId: null }), flag: null, status: false },
  { change: "Digital cleared", apply: () => ({ videographerId: null }), flag: null, status: false },
  { change: "Dates Confirmed", apply: () => ({ isConfirmed: false }), flag: null, status: true },
  { change: "All Day", apply: () => ({ isAllDay: true }), flag: null, status: true },
  { change: "Cross-Government", apply: () => ({ isCrossGovernment: true }), flag: null, status: true },
];
// The table's last two rows (the fields that set nothing, and Delete) aren't snapshot fields: the
// update and delete route tests pin them through the API.

describe("needs-review and status, legacy's trigger table row by row (spec addendum §7.3)", () => {
  it.each(TRIGGER_TABLE)("$change → flag $flag, status changed: $status", ({ apply, flag, status }) => {
    const after = { ...base, ...apply(base) };
    expect(reviewChanges(base, after)).toEqual({ flags: flag ? [flag] : [], statusChanged: status });
  });

  it("covers every flag a save can raise: all 23 but active", () => {
    const raised = new Set(TRIGGER_TABLE.map((r) => r.flag).filter(Boolean));
    expect([...raised].sort()).toEqual(NEEDS_REVIEW_KEYS.filter((k) => k !== "active").sort());
  });

  it("a save that changes nothing raises nothing", () => expect(reviewChanges(base, { ...base })).toEqual({ flags: [], statusChanged: false }));

  it("text compares trimmed; lists compare as sets", () => {
    const after = { ...base, title: ` ${base.title} `, significance: `${base.significance}\n`, keywordIds: [2, 1], translations: [...base.translations] };
    expect(reviewChanges(base, after)).toEqual({ flags: [], statusChanged: false });
  });

  it("any combination of rows raises exactly the union of their flags (seeded generator, 300 cases)", () => {
    let seed = 20261101;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let n = 0; n < 300; n++) {
      const rows = TRIGGER_TABLE.filter(() => rand() < 0.2);
      const after = rows.reduce((s, r) => ({ ...s, ...r.apply(base) }), { ...base });
      // Two rows can write one field ("Premier Requested cleared" after "…to a new value"): only the
      // rows whose values are the ones finally saved count.
      const effective = rows.filter((r) => Object.entries(r.apply(base)).every(([k, v]) => JSON.stringify((after as Record<string, unknown>)[k]) === JSON.stringify(v)));
      const result = reviewChanges(base, after);
      expect([...result.flags].sort()).toEqual([...new Set(effective.map((r) => r.flag).filter((f): f is NeedsReviewKey => f !== null))].sort());
      expect(result.statusChanged).toBe(effective.some((r) => r.status));
    }
  });
});

describe("the needs_review set", () => {
  it("never holds a key twice, and keeps the 23-key order", () => {
    expect(mergeNeedsReview(["title", "details"], ["details", "title", "tags", "tags"])).toEqual(["title", "details", "tags"]);
    expect(mergeNeedsReview(["active", "title"], ["active"])).toEqual(["title", "active"]);
  });
  it("Review clears 22 keys, never active", () => {
    expect(REVIEW_CLEARED_KEYS).toHaveLength(22);
    expect(REVIEW_CLEARED_KEYS).not.toContain("active");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/activities/review-rules.test.ts`
Expected: FAIL. `./review-rules` can't be resolved.

- [ ] **Step 3: Implement**

`apps/calendar/src/activities/review-rules.ts`:

```ts
import { NEEDS_REVIEW_KEYS, type NeedsReviewKey } from "@gcpe/calendar-contract";

/** The values legacy's save compared (Activity.aspx.cs:1129-1265, ActivityManager.cs:97-254). */
export interface ReviewSnapshot {
  title: string;
  details: string;
  governmentRepresentativeId: number | null;
  cityId: number | null;
  otherCity: string;
  startAt: number | null;
  endAt: number | null;
  potentialDates: string;
  categoryIds: number[];
  isIssue: boolean;
  isConfidential: boolean;
  commMaterialIds: number[];
  significance: string;
  comments: string;
  schedule: string;
  strategy: string;
  leadOrganization: string;
  venue: string;
  initiativeIds: number[];
  keywordIds: number[];
  nrOriginIds: number[];
  translations: string[];
  premierRequestedId: number | null;
  nrDistributionId: number | null;
  eventPlannerId: number | null;
  videographerId: number | null;
  isConfirmed: boolean;
  isAllDay: boolean;
  isCrossGovernment: boolean;
}

const sameText = (a: string, b: string) => a.trim() === b.trim();
const sameSet = <T>(a: readonly T[], b: readonly T[]) => {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
};
/** "To a new non-empty value": legacy compared only when the dropdown had a value (Activity.aspx.cs:1153-1167). */
const newValue = (before: number | null, after: number | null) => after !== null && after !== before;

/** Which flags a save raises, and whether the status becomes `changed`. Any saving user, HQ included. */
export function reviewChanges(b: ReviewSnapshot, a: ReviewSnapshot): { flags: NeedsReviewKey[]; statusChanged: boolean } {
  const flags = new Set<NeedsReviewKey>();
  let status = false;
  const raise = (changed: boolean, flag: NeedsReviewKey | null, setsStatus = true) => {
    if (!changed) return;
    if (flag) flags.add(flag);
    if (setsStatus) status = true;
  };
  raise(!sameText(b.title, a.title), "title");
  raise(!sameText(b.details, a.details), "details");
  raise(b.governmentRepresentativeId !== a.governmentRepresentativeId, "representative");
  raise(b.cityId !== a.cityId || !sameText(b.otherCity, a.otherCity), "city");
  raise(b.startAt !== a.startAt, "start_date");
  raise(!sameText(b.potentialDates, a.potentialDates), "start_date");
  raise(b.endAt !== a.endAt, "end_date");
  raise(!sameSet(b.categoryIds, a.categoryIds) || b.isIssue !== a.isIssue || b.isConfidential !== a.isConfidential, "categories");
  raise(!sameSet(b.commMaterialIds, a.commMaterialIds), "comm_materials");
  raise(!sameText(b.significance, a.significance), "significance");
  raise(!sameText(b.comments, a.comments), "internal_notes");
  raise(!sameText(b.schedule, a.schedule), "scheduling_considerations");
  raise(!sameText(b.strategy, a.strategy), "strategy");
  raise(!sameText(b.leadOrganization, a.leadOrganization), "lead_organization");
  raise(!sameText(b.venue, a.venue), "venue");
  raise(!sameSet(b.initiativeIds, a.initiativeIds), "initiatives");
  // Legacy compared only the counts (Activity.aspx.cs:1178), so swapping one tag raised nothing (C130).
  raise(!sameSet(b.keywordIds, a.keywordIds), "tags");
  raise(!sameSet(b.nrOriginIds, a.nrOriginIds), "origin");
  raise(!sameSet(b.translations.map((t) => t.trim()), a.translations.map((t) => t.trim())), "translations_required");
  raise(newValue(b.premierRequestedId, a.premierRequestedId), "premier_requested");
  raise(b.premierRequestedId !== a.premierRequestedId, null);
  raise(newValue(b.nrDistributionId, a.nrDistributionId), "distribution");
  raise(b.nrDistributionId !== a.nrDistributionId, null);
  // Event planner and Digital: a new value flags and changes status; clearing does neither.
  raise(newValue(b.eventPlannerId, a.eventPlannerId), "event_planner");
  raise(newValue(b.videographerId, a.videographerId), "digital");
  raise(b.isConfirmed !== a.isConfirmed || b.isAllDay !== a.isAllDay || b.isCrossGovernment !== a.isCrossGovernment, null);
  return { flags: NEEDS_REVIEW_KEYS.filter((k) => flags.has(k)), statusChanged: status };
}

/** The union, each key once, in the 23-key order: the column's CHECK bounds the set but doesn't de-duplicate it. */
export function mergeNeedsReview(current: readonly string[], add: readonly NeedsReviewKey[]): NeedsReviewKey[] {
  const all = new Set<string>([...current, ...add]);
  return NEEDS_REVIEW_KEYS.filter((k) => all.has(k));
}

/** Review clears every flag but `active`, which only a Review of a deleted activity clears (ActivityManager.cs:21-75). */
export const REVIEW_CLEARED_KEYS: readonly NeedsReviewKey[] = NEEDS_REVIEW_KEYS.filter((k) => k !== "active");
```

Note that `mergeNeedsReview` returns keys in `NEEDS_REVIEW_KEYS` order (`title`, `details`, …, `active`, …). The test expects `["title", "active"]` for `["active", "title"]` plus `["active"]`, which is that order: `title` comes before `active` in the 23-key list. Keep the expectation and the implementation as written.

- [ ] **Step 4: Run it to see it pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/activities/review-rules.test.ts`
Expected: PASS: 36 table rows, the coverage check, the no-op, trimming and sets, 300 combinations, and the set tests.

- [ ] **Step 5: Commit**

```bash
git add apps/calendar/src/activities/review-rules.ts apps/calendar/src/activities/review-rules.test.ts
git commit -m "feat(calendar): needs-review and status from legacy's trigger table, keywords as sets (C130)"
```

---
### Task 6: Create and read. The activity store, history, events, and the Calendar → NRMS route

Covers:
- spec §7.1 Create:
  - status `new` and no flags;
  - every field saved, NR date and Translations included (C145);
  - `**` for a non-HQ, non-Administrator creator;
  - a `created` history entry listing every set field.
- §7.2 on create; §7.1 "Events" (the outbox in the same transaction); §5.4 (the payloads, the id-only confidential form).
- §6 for reads (404, not 403); §8.3's read API (C133).
- The carry-forward item "the News API never gains an `activity.*` handler".
- Review Focus 4 and 5.
- Decisions F9, F11, F12, F17, F18, F19, F20 and F21.

**Files:**
- Create in `packages/calendar-contract/src/`: `view.ts`. Modify `index.ts`.
- Create in `apps/calendar/src/activities/`: `errors.ts`, `store.ts`, `resolve.ts`, `history.ts`, `events.ts`, `view.ts` and `create.ts`.
- Create in `apps/calendar/src/http/`: `errors.ts` (+ `errors.test.ts`) and `activity-routes.ts`. Modify `routes.ts`.
- Modify: `apps/calendar/src/lookups.ts`, which exports `lockLookup`.
- Create: `apps/calendar/test/world.ts`.
- Create: `apps/calendar/src/http/activity-create.test.ts`.
- Modify: `apps/stack/src/env.ts` and `env.test.ts`.

**Interfaces:**
- Consumes:
  - Tasks 1–5: everything they produce;
  - `enqueueEvent`, `SubscriberConfig` and `ActivityEvent` (`@gcpe/events`);
  - `LOOKUPS` (`lookups.ts`).
- Produces:
  - **The contract's view types:**
    - `HISTORY_FIELDS` and `type HistoryFieldKey`;
    - `interface ActivityView`;
    - `interface ActivityChangeView`;
    - `interface WriteResponse { activity: ActivityView; warnings: string[] }`.
  - **Errors** (`activities/errors.ts`):
    - `ActivityNotFoundError` and `ActivityForbiddenError`;
    - `ActivityDeletedError` and `VersionConflictError`;
    - `ActivityLockedError(code: "locked" | "locked_elsewhere", message, holder)`;
    - `ActivityValidationError(errors: FieldError[])`.
  - **The store** (`activities/store.ts`):
    - types: `ActivityRow`, `JoinIds`, `StoredActivity { row; joins; keywordNames }`, `Content` and `LookAheadValues`;
    - locking and loading: `lockActivity(tx, id)` and `loadStored(db, id, { forUpdate? })`;
    - views of a stored activity: `factsOf(s)`, `fieldsOf(s, timeZone)`, `contentOf(row)`, `lookAheadOf(row)` and `snapshotOf(content, joins)`;
    - `contentFrom(fields, rules)`;
    - writes: `insertActivity(tx, v)`, `replaceJoins(tx, id, joins)` and `columnsOf(content)`;
    - Look Ahead: `lookAheadInputOf(db, fields, categoryIds, currentSection)`;
    - locks: `LOCK_IDLE_MS` and `liveLockOf(db, id, now)`;
    - helpers: `uniqNum` and `uniqStr`.
  - **References** (`activities/resolve.ts`):
    - `interface Resolution { errors; categoryNames; contactMinistryAbbreviation; keywordIds; keywordsToCreate }`;
    - `resolveReferences(tx, input, ctx)`;
    - `createKeywords(tx, names): Promise<number[]>`.
  - **History** (`activities/history.ts`):
    - `type Display`;
    - `displayOf(db, content, lookAhead, joins, keywordNames)`;
    - `diffDisplay(before, after)` and `setFields(after)`;
    - `writeChange(tx, change)`.
  - **Events** (`activities/events.ts`): `activityEventData(db, id, rules)`, `emitActivity(tx, deps, id, type)` and `emitActivityDeleted(tx, deps, id)`.
  - **Reads** (`activities/view.ts`): `readActivity(deps, actor, id): Promise<ActivityView>` and `readChanges(deps, actor, id): Promise<ActivityChangeView[]>`.
  - **Create** (`activities/create.ts`): `createActivity(deps, actor, input): Promise<{ id: number; warnings: string[] }>`.
  - **Routes:**
    - `sendActivityError(e, res): boolean` (`http/errors.ts`);
    - `activityRoutes(deps: ApiDeps): Router`, which serves `POST /activities`, `GET /activities/:id` and `GET /activities/:id/changes`.
  - **`lookups.ts`:** `lockLookup` is exported. The keyword-creation path takes it after the activity's lock.
  - **Test fixtures** (`test/world.ts`):
    - `interface World` and `seedWorld(app, db): Promise<World>`;
    - `validInput(w, over?): ActivityFields`;
    - `call(app, method, path, cookie, body?)`;
    - `projectTerm(app, kind, key, over?)`;
    - `outboxOf(db, aggregateId)`.

- [ ] **Step 1: The test world**

`apps/calendar/test/world.ts`:

```ts
import type express from "express";
import request from "supertest";
import { asc, eq, sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import type { CalendarRole } from "@gcpe/auth";
import type { ActivityFields } from "@gcpe/calendar-contract";
import { outboxEvents } from "@gcpe/events";
import {
  categories, cities, commContacts, commMaterials, eventPlanners, governmentRepresentatives, initiatives, keywords,
  nrDistributions, nrOrigins, premierRequested, videographers,
} from "../src/db/schema";
import { envelope, projectOrg, projectUser, sendEvent, sessionCookie } from "./helpers";

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export type Who = "readOnly" | "editor" | "financeEditor" | "advanced" | "admin" | "hqReadOnly" | "hqEditor" | "hqAdvanced" | "hqAdmin";
const PEOPLE: Record<Who, { n: number; role: CalendarRole; org: string; name: string }> = {
  readOnly: { n: 401, role: "Calendar.ReadOnly", org: "health", name: "Sample Reader" },
  editor: { n: 402, role: "Calendar.Editor", org: "health", name: "Robin Staff" },
  financeEditor: { n: 403, role: "Calendar.Editor", org: "finance", name: "Kim Finance" },
  advanced: { n: 404, role: "Calendar.Advanced", org: "health", name: "Sample Advanced" },
  admin: { n: 405, role: "Calendar.Administrator", org: "health", name: "Sample Admin" },
  hqReadOnly: { n: 406, role: "Calendar.ReadOnly", org: "gcpe-hq", name: "Sample HQ Reader" },
  hqEditor: { n: 407, role: "Calendar.Editor", org: "gcpe-hq", name: "Sample HQ Editor" },
  hqAdvanced: { n: 408, role: "Calendar.Advanced", org: "gcpe-hq", name: "Sample HQ Advanced" },
  hqAdmin: { n: 409, role: "Calendar.Administrator", org: "gcpe-hq", name: "Sample HQ Admin" },
};

export interface World {
  as: Record<Who, { id: string; cookie: string; name: string }>;
  cat: { proposedRelease: 12; approvedRelease: 58; awareness: 2; event: 30; speech: 31; plain: 32; hqPlaceholder: 33; retired: 34 };
  city: { sample: 1; other: 311; retired: 2 };
  commMaterial: { newsRelease: 1; unconfirmedMarker: 61; retired: 3 };
  ids: { origin: 1; distribution: 1; premierYes: 1; premierMaybe: 2; planner: 1; planner2: 2; videographer: 1; videographer2: 2; representative: 1; representative2: 2; initiative: 1; keptKeyword: 1; sampleTag: 2 };
  contact: { editorHealth: number; adminHealth: number; financeEditor: number; retiredHealth: number };
}

export function projectTerm(app: express.Express, kind: "sector" | "theme" | "tag", key: string, over: { isActive?: boolean } = {}) {
  const record = { kind, key, displayName: `Sample ${kind} ${key}`, sortOrder: 0, isActive: over.isActive ?? true, social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null }, updatedAt: "2026-10-08T17:00:00Z" };
  return sendEvent(app, envelope("core", `${kind}.upserted`, record, `${kind}:${key}`));
}

/** Organizations, terms, people at every level, every lookup and four comm contacts. Fictional values only. */
export async function seedWorld(app: express.Express, db: Db): Promise<World> {
  await projectOrg(app, "health", { abbreviation: "HLTH", displayName: "Sample Health" });
  await projectOrg(app, "finance", { abbreviation: "FIN", displayName: "Sample Finance" });
  await projectOrg(app, "gcpe-hq", { abbreviation: "HQ", displayName: "Sample HQ", isHq: true });
  await projectOrg(app, "consult", { abbreviation: "CONSULT", displayName: "Sample Consultations" });
  await projectOrg(app, "excluded", { abbreviation: "EXCL", displayName: "Sample Excluded" });
  await projectOrg(app, "retired", { abbreviation: "RET", displayName: "Sample Retired", isActive: false });
  await projectTerm(app, "sector", "sample-sector");
  await projectTerm(app, "theme", "sample-theme");
  await projectTerm(app, "tag", "sample-tag");
  await projectTerm(app, "tag", "retired-tag", { isActive: false });

  const as = {} as World["as"];
  for (const [who, p] of Object.entries(PEOPLE) as [Who, (typeof PEOPLE)[Who]][]) {
    await projectUser(app, { id: uid(p.n), email: `${who}@example.test`, displayName: p.name, isActive: true, calendarRole: p.role, organizationKeys: [p.org] });
    as[who] = { id: uid(p.n), cookie: await sessionCookie(uid(p.n)), name: p.name };
  }

  await db.insert(categories).values([
    { id: 12, name: "Sample proposed release" }, { id: 58, name: "Sample approved release" }, { id: 2, name: "Sample awareness day" },
    { id: 30, name: "Sample approved event" }, { id: 31, name: "Sample speech" }, { id: 32, name: "Sample plain category" },
    { id: 33, name: "Sample HQ placeholder", isActive: false }, { id: 34, name: "Sample retired category", isActive: false },
  ]);
  await db.insert(cities).values([{ id: 1, name: "Sample City" }, { id: 311, name: "Other..." }, { id: 2, name: "Sample Retired City", isActive: false }]);
  await db.insert(commMaterials).values([{ id: 1, name: "Sample news release" }, { id: 61, name: "Sample unconfirmed marker" }, { id: 3, name: "Sample retired material", isActive: false }]);
  await db.insert(nrOrigins).values([{ id: 1, name: "Sample origin" }, { id: 2, name: "Sample joint origin" }]);
  await db.insert(nrDistributions).values([{ id: 1, name: "Sample distribution" }, { id: 2, name: "Sample wide distribution" }]);
  await db.insert(premierRequested).values([{ id: 1, name: "Sample yes" }, { id: 2, name: "Sample maybe" }]);
  await db.insert(eventPlanners).values([{ id: 1, name: "Sample Planner" }, { id: 2, name: "Sample Planner Two" }]);
  await db.insert(videographers).values([{ id: 1, name: "Sample Videographer" }, { id: 2, name: "Sample Videographer Two" }]);
  await db.insert(governmentRepresentatives).values([{ id: 1, name: "Sample Representative" }, { id: 2, name: "Sample Representative Two" }]);
  await db.insert(initiatives).values([{ id: 1, name: "Sample initiative", shortName: "SI" }]);
  await db.insert(keywords).values([{ id: 1, name: "Sample kept keyword" }, { id: 2, name: "sample tag" }]);
  // Explicit ids above leave the identities behind them, as the importer's will; re-base them.
  for (const t of ["categories", "cities", "comm_materials", "nr_origins", "nr_distributions", "premier_requested", "event_planners", "videographers", "government_representatives", "initiatives", "keywords"]) {
    await db.execute(sql`SELECT setval(pg_get_serial_sequence(${t}, 'id'), (SELECT max(id) FROM ${sql.identifier(t)}))`);
  }

  const contact = async (who: Who, ministryKey: string, isActive = true) =>
    (await db.insert(commContacts).values({ userId: as[who].id, ministryKey, rank: 4, isActive }).returning({ id: commContacts.id }))[0]!.id;
  return {
    as,
    cat: { proposedRelease: 12, approvedRelease: 58, awareness: 2, event: 30, speech: 31, plain: 32, hqPlaceholder: 33, retired: 34 },
    city: { sample: 1, other: 311, retired: 2 },
    commMaterial: { newsRelease: 1, unconfirmedMarker: 61, retired: 3 },
    ids: { origin: 1, distribution: 1, premierYes: 1, premierMaybe: 2, planner: 1, planner2: 2, videographer: 1, videographer2: 2, representative: 1, representative2: 2, initiative: 1, keptKeyword: 1, sampleTag: 2 },
    contact: { editorHealth: await contact("editor", "health"), adminHealth: await contact("admin", "health"), financeEditor: await contact("financeEditor", "finance"), retiredHealth: await contact("advanced", "health", false) },
  };
}

export function validInput(w: World, over: Partial<ActivityFields> = {}): ActivityFields {
  return {
    categoryId: w.cat.plain, title: "Sample activity", details: "Sample summary", significance: "Sample significance", strategy: "",
    schedule: "Sample scheduling", comments: "", leadOrganization: "", venue: "", otherCity: "", potentialDates: "",
    isIssue: false, isConfidential: false, isMilestone: false, isCrossGovernment: false, isAtLegislature: false, isAllDay: false, isConfirmed: true,
    startDate: "2026-11-10", startTime: "09:00", endDate: "2026-11-10", endTime: "10:00", nrDate: null, nrTime: null,
    contactMinistryKey: "health", commContactId: w.contact.editorHealth, governmentRepresentativeId: null, cityId: w.city.sample,
    premierRequestedId: null, nrDistributionId: null, eventPlannerId: null, videographerId: null, nrOriginId: null,
    commMaterialIds: [], initiativeIds: [], keywordNames: [], sectorKeys: [], themeKeys: [], tagKeys: [], sharedWithKeys: [], translations: [],
    ...over,
  };
}

export function call(app: express.Express, method: "get" | "post" | "put" | "delete", path: string, cookie: string, body?: object) {
  const r = request(app)[method](path).set("cookie", cookie);
  if (method !== "get") r.set("x-gcpe-request", "1");
  return body === undefined ? r : r.send(body);
}

/** The envelopes the Calendar queued for one activity, oldest first. */
export async function outboxOf(db: Db, activityId: number) {
  const rows = await db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, `activity:${activityId}`)).orderBy(asc(outboxEvents.sequence));
  return rows.map((r) => r.envelope as { type: string; data: Record<string, unknown> });
}
```

- [ ] **Step 2: Write the failing tests**

`apps/calendar/src/http/activity-create.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCalendarTestDb, createTestApp } from "../../test/helpers";
import { call, outboxOf, seedWorld, validInput, type World } from "../../test/world";
import { activities, activityChangeFields, activityChanges, keywords } from "../db/schema";

describe("creating an activity (spec addendum §7.1)", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createTestApp>;
  let w: World;
  const create = (who: keyof World["as"], over = {}) => call(app, "post", "/api/activities", w.as[who].cookie, validInput(w, over));

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    w = await seedWorld(app, tdb.db);
  });
  afterAll(() => tdb.drop());

  it("an Editor creates in their ministry: status new, no flags, version 1, every field kept (C145)", async () => {
    const res = await create("editor", {
      title: "  “Sample”\nlaunch ", nrDate: "2026-11-10", nrTime: "08:00", translations: ["Sample language A"],
      keywordNames: ["Brand new tag"], sectorKeys: ["sample-sector"], tagKeys: ["sample-tag"], sharedWithKeys: ["finance"],
    });
    expect(res.status).toBe(201);
    const a = res.body.activity;
    expect(a).toMatchObject({ version: 1, status: "new", isDeleted: false, needsReview: [], lookAhead: null });
    expect(a.fields).toMatchObject({ title: '"Sample" launch', nrDate: "2026-11-10", nrTime: "08:00", translations: ["Sample language A"], keywordNames: ["Brand new tag"], sharedWithKeys: ["finance"] });
    expect(a.startAt).toBe("2026-11-10T16:00:00.000Z");
    expect((await tdb.db.select().from(keywords).where(eq(keywords.name, "Brand new tag"))).length).toBe(1);
  });

  it("a non-HQ, non-Administrator creator's Executive Summary is ** (Activity.aspx.cs:1098-1102); an Administrator's is empty", async () => {
    const ed = (await create("editor")).body.activity.id as number;
    const ad = (await create("admin", { commContactId: w.contact.adminHealth })).body.activity.id as number;
    const rows = await tdb.db.select({ id: activities.id, hq: activities.hqComments }).from(activities);
    expect(rows.find((r) => r.id === ed)!.hq).toBe("**");
    expect(rows.find((r) => r.id === ad)!.hq).toBeNull();
  });

  it("an HQ Editor sees and sets the Look Ahead fields; leaving them out gives legacy's defaults", async () => {
    const chosen = await create("hqEditor", { contactMinistryKey: "finance", commContactId: w.contact.financeEditor, details: "", lookAhead: { hqComments: "Sample summary", hqStatus: "new", hqSection: "events_and_speeches", longTermOutlook: true } });
    expect(chosen.status).toBe(201);
    expect(chosen.body.activity.lookAhead).toMatchObject({ hqComments: "Sample summary", hqStatus: "new", hqSection: "events_and_speeches", longTermOutlook: true, inferred: { kind: "section", section: "in_the_news" } });
    const defaults = await create("hqEditor", { contactMinistryKey: "finance", commContactId: w.contact.financeEditor });
    expect(defaults.body.activity.lookAhead).toMatchObject({ hqComments: "**", hqStatus: null, hqSection: "in_the_news", longTermOutlook: false });
  });

  it("who may create where (spec addendum §6)", async () => {
    expect((await create("readOnly")).status).toBe(403);
    const otherMinistry = await create("editor", { contactMinistryKey: "finance", commContactId: w.contact.financeEditor });
    expect(otherMinistry.status).toBe(422);
    expect(otherMinistry.body.errors).toContainEqual({ field: "contactMinistryKey", message: "You can only choose one of your ministries" });
    expect((await create("hqEditor", { contactMinistryKey: "retired" })).body.errors.map((e: { field: string }) => e.field)).toContain("contactMinistryKey");
    expect((await create("hqEditor", { contactMinistryKey: "excluded" })).body.errors.map((e: { field: string }) => e.field)).toContain("contactMinistryKey");
  });

  it.each<[string, (w: World) => object, string]>([
    ["a release category without origin", (w) => ({ categoryId: w.cat.approvedRelease, nrDistributionId: 1, commMaterialIds: [1] }), "nrOriginId"],
    ["an end before the start", () => ({ endDate: "2026-11-09" }), "endDate"],
    ["a time off the 5-minute steps", () => ({ startTime: "09:02" }), "startTime"],
    ["Potential Dates with TBD", () => ({ potentialDates: "TBD" }), "potentialDates"],
    ["a 101-character title", () => ({ title: "x".repeat(101) }), "title"],
    ["an unknown category", () => ({ categoryId: 9999 }), "categoryId"],
    ["an inactive category", (w) => ({ categoryId: w.cat.retired }), "categoryId"],
    ["the HQ Placeholder category, by a ministry user", (w) => ({ categoryId: w.cat.hqPlaceholder }), "categoryId"],
    ["an inactive city", (w) => ({ cityId: w.city.retired }), "cityId"],
    ["an inactive comm material", (w) => ({ commMaterialIds: [w.commMaterial.retired] }), "commMaterialIds"],
    ["an inactive comm contact", (w) => ({ commContactId: w.contact.retiredHealth }), "commContactId"],
    ["another ministry's comm contact", (w) => ({ commContactId: w.contact.financeEditor }), "commContactId"],
    ["an unknown sector", () => ({ sectorKeys: ["no-such-sector"] }), "sectorKeys"],
    ["an inactive News Subscribe tag", () => ({ tagKeys: ["retired-tag"] }), "tagKeys"],
    ["an excluded shared-with ministry", () => ({ sharedWithKeys: ["excluded"] }), "sharedWithKeys"],
    ["Look Ahead fields from a ministry user", () => ({ lookAhead: { hqComments: "", hqStatus: null, hqSection: "in_the_news", longTermOutlook: false } }), "lookAhead"],
  ])("refuses %s with a field error, through the API (acceptance 7)", async (_name, over, field) => {
    const res = await create("editor", over(w));
    expect(res.status).toBe(422);
    expect(res.body.errors.map((e: { field: string }) => e.field)).toContain(field);
  });

  it("HQ may use the HQ Placeholder category", async () => {
    expect((await create("hqEditor", { categoryId: w.cat.hqPlaceholder })).status).toBe(201);
  });

  it("the server owns status, flags and versions: a body that sets them is 400", async () => {
    for (const extra of [{ status: "reviewed" }, { needsReview: ["title"] }, { version: 3 }, { createdBy: w.as.editor.id }]) {
      const res = await call(app, "post", "/api/activities", w.as.editor.cookie, { ...validInput(w), ...extra });
      expect(res.status).toBe(400);
    }
  });

  it("an all-day activity on 2026-11-01 stores and reads back BC's dates", async () => {
    const res = await create("editor", { isAllDay: true, startDate: "2026-11-01", endDate: "2026-11-01", startTime: null, endTime: null });
    expect(res.status).toBe(201);
    expect(res.body.activity).toMatchObject({ startAt: "2026-11-01T07:00:00.000Z", endAt: "2026-11-02T06:45:00.000Z" });
    expect(res.body.activity.fields).toMatchObject({ startDate: "2026-11-01", endDate: "2026-11-01", startTime: null, endTime: null });
  });

  it("a date in the past is saved with a warning", async () => {
    const res = await create("editor", { startDate: "2026-11-02", endDate: "2026-11-02" });
    expect(res.status).toBe(201);
    expect(res.body.warnings).toEqual(["The start date is in the past.", "The end date is in the past."]);
  });

  it("writes a created history entry listing every set field, with the actor", async () => {
    const id = (await create("editor", { venue: "Sample hall", initiativeIds: [w.ids.initiative] })).body.activity.id as number;
    const [change] = await tdb.db.select().from(activityChanges).where(eq(activityChanges.activityId, id));
    expect(change).toMatchObject({ action: "created", actorId: w.as.editor.id, actorName: "Robin Staff", source: "calendar", contactMinistryKey: "health" });
    const fields = await tdb.db.select().from(activityChangeFields).where(eq(activityChangeFields.changeId, change!.id));
    expect(Object.fromEntries(fields.map((f) => [f.fieldKey, f.newValue]))).toMatchObject({
      title: "Sample activity", venue: "Sample hall", initiatives: "Sample initiative", contact_ministry: "Sample Health", comm_contact: "Robin Staff (HLTH)", city: "Sample City", start: "2026-11-10 09:00",
    });
    expect(fields.every((f) => f.oldValue === null)).toBe(true);
    const history = await call(app, "get", `/api/activities/${id}/changes`, w.as.readOnly.cookie);
    expect(history.status).toBe(200);
    expect(history.body[0]).toMatchObject({ action: "created", actorName: "Robin Staff", source: "calendar" });
    expect(history.body[0].fields).toContainEqual({ key: "venue", label: "Venue", old: null, new: "Sample hall" });
  });

  it("queues activity.created in the same transaction; a confidential activity leaves as its id only (spec addendum §5.4)", async () => {
    const open = (await create("editor", { sharedWithKeys: ["finance"], themeKeys: ["sample-theme"] })).body.activity.id as number;
    const [e] = await outboxOf(tdb.db, open);
    expect(e).toMatchObject({ type: "activity.created", data: { id: open, isConfidential: false, isDeleted: false, title: "Sample activity", contactMinistryKey: "health", sharedMinistryKeys: ["finance"], categoryNames: ["Sample plain category"], cityName: "Sample City", themeKeys: ["sample-theme"] } });
    const secret = (await create("editor", { isConfidential: true, title: "Sample secret" })).body.activity.id as number;
    const [c] = await outboxOf(tdb.db, secret);
    expect(c!.data).toEqual({ id: secret, isConfidential: true, isDeleted: false });
  });

  it("City Other… sends the Other City text as the city name; another city clears Other City", async () => {
    const other = (await create("editor", { cityId: w.city.other, otherCity: "Sample Bay" })).body.activity;
    expect(other.fields.otherCity).toBe("Sample Bay");
    expect((await outboxOf(tdb.db, other.id))[0]!.data.cityName).toBe("Sample Bay");
    expect((await create("editor", { cityId: w.city.sample, otherCity: "Ignored" })).body.activity.fields.otherCity).toBe("");
  });

  it("the freeze refuses a ministry Editor's create at 16:30 BC; an HQ Editor's goes through (spec addendum §7.4)", async () => {
    const frozen = createTestApp(tdb.db, { now: () => new Date("2026-11-03T23:30:00Z") });
    const refused = await call(frozen, "post", "/api/activities", w.as.editor.cookie, validInput(w));
    expect(refused.status).toBe(423);
    expect(refused.body).toEqual({ code: "freeze", error: expect.stringContaining("You cannot make content changes between 4pm-5pm.") });
    expect((await call(frozen, "post", "/api/activities", w.as.hqEditor.cookie, validInput(w, { contactMinistryKey: "finance", commContactId: w.contact.financeEditor }))).status).toBe(201);
  });

  describe("reading", () => {
    let secret: number;
    beforeAll(async () => {
      secret = (await create("editor", { isConfidential: true, title: "Sample confidential" })).body.activity.id as number;
    });

    it("not visible is 404, never 403 (spec addendum §6)", async () => {
      expect((await call(app, "get", `/api/activities/${secret}`, w.as.financeEditor.cookie)).status).toBe(404);
      expect((await call(app, "get", `/api/activities/${secret}`, w.as.hqEditor.cookie)).status).toBe(404);
      expect((await call(app, "get", `/api/activities/${secret}/changes`, w.as.hqEditor.cookie)).status).toBe(404);
      expect((await call(app, "get", "/api/activities/abc", w.as.editor.cookie)).status).toBe(404);
      expect((await call(app, "get", "/api/activities/99999999", w.as.editor.cookie)).status).toBe(404);
    });

    it("HQ Advanced and the owning ministry's Read Only see it; only HQ Editors see the needs-review markup", async () => {
      expect((await call(app, "get", `/api/activities/${secret}`, w.as.hqAdvanced.cookie)).status).toBe(200);
      const ro = await call(app, "get", `/api/activities/${secret}`, w.as.readOnly.cookie);
      expect(ro.status).toBe(200);
      expect(ro.body).toMatchObject({ can: { edit: false, clone: false, delete: false, review: false }, lookAhead: null, needsReview: [] });
      expect(ro.body.fields.lookAhead).toBeUndefined();
    });
  });
});
```

`apps/calendar/src/http/errors.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import { sendActivityError } from "./errors";

function fakeRes() {
  const res = { statusCode: 0, body: undefined as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

describe("sendActivityError", () => {
  it("turns a constraint error into a 409 and logs only its code, never its message", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = fakeRes();
    const e = Object.assign(new Error("duplicate key value violates … (title)=(Sample secret)"), { cause: { code: "23505" } });
    expect(sendActivityError(e, res)).toBe(true);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ code: "conflict", error: "That change conflicts with another one: reload and try again" });
    expect(JSON.stringify(log.mock.calls)).toContain("23505");
    expect(JSON.stringify(log.mock.calls)).not.toContain("Sample secret");
    log.mockRestore();
  });
  it("leaves anything else to the generic 500 handler", () => expect(sendActivityError(new Error("boom"), fakeRes())).toBe(false));
});
```

In `apps/stack/src/env.test.ts`, in the `describe("Calendar routing", …)` block, add:

```ts
  it("routes the Calendar's activity.* to NRMS by explicit type, and never to the News API (C127)", () => {
    const env = { CALENDAR_DATABASE_URL: "postgres://x/cal", STACK_EVENT_SECRET: SECRET };
    const calendarSubs = JSON.parse(envFor(env, "CALENDAR").EVENT_SUBSCRIBERS!) as { name: string; types: string[] }[];
    expect(calendarSubs).toEqual([expect.objectContaining({ name: "nrms", types: ["activity.created", "activity.updated", "activity.deleted"] })]);
    expect(JSON.parse(envFor(env, "NRMS").EVENT_SECRETS!)).toHaveProperty("calendar");
    expect(INTERNAL_EVENT_ROUTES.some((r) => r.from === "CALENDAR" && r.to === "NEWSAPI")).toBe(false);
    for (const route of INTERNAL_EVENT_ROUTES.filter((r) => r.to === "NEWSAPI")) {
      expect((route.types as readonly string[]).some((t) => t.startsWith("activity."))).toBe(false);
    }
  });

  it("no Calendar → NRMS route when the Calendar isn't configured", () => {
    expect(JSON.parse(envFor({ STACK_EVENT_SECRET: SECRET }, "CALENDAR").EVENT_SUBSCRIBERS ?? "[]")).toEqual([]);
  });
```

Import `INTERNAL_EVENT_ROUTES` if the file doesn't already. The existing whole-map assertion near `:270-300` that lists NRMS's `EVENT_SECRETS` runs without `CALENDAR_DATABASE_URL`, so it is unchanged. If any assertion there sets the Calendar's URL, add `calendar: expect.any(String)` to its NRMS secrets.

- [ ] **Step 3: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/http/activity-create.test.ts apps/calendar/src/http/errors.test.ts apps/stack/src/env.test.ts`
Expected: FAIL. The routes and modules don't exist, and there is no Calendar → NRMS route.

- [ ] **Step 4: The contract's view types**

`packages/calendar-contract/src/view.ts`:

```ts
import type { ActivityStatus, ChangeAction, ChangeSource, NeedsReviewKey } from "./enums";
import type { ActivityFields, LookAheadFields } from "./input";
import type { LookAheadInference } from "./look-ahead";

/** History field keys (activity_change_fields.field_key) and their labels on "View changes" (spec addendum §8.3). */
export const HISTORY_FIELDS = {
  category: "Category", is_confidential: "Not for Look Ahead", title: "Title", details: "Summary", is_issue: "Issue",
  significance: "Significance", lead_organization: "Lead Organization", initiatives: "HQ Initiatives & Leads", keywords: "HQ Tags",
  comm_contact: "Comm Contact", is_milestone: "Key activity", strategy: "Strategy", comm_materials: "Comm Materials",
  comments: "Internal notes", contact_ministry: "Lead Ministry", is_cross_government: "Cross-Government", shared_with: "Shared With",
  hq_comments: "Executive Summary", hq_status: "LA Status", hq_section: "LA Section", long_term_outlook: "Long Term Outlook",
  start: "Start", end: "End", is_all_day: "All Day", is_confirmed: "Dates Confirmed", potential_dates: "Potential Dates",
  schedule: "Scheduling considerations", nr_at: "Release Time", nr_origins: "Origin", nr_distribution: "Distribution",
  translations: "Translations Required", sectors: "Sectors", themes: "Themes", tags: "News Subscribe",
  premier_requested: "Premier Requested", representative: "Representative", is_at_legislature: "At BC Legislature", city: "City",
  other_city: "Other City", venue: "Venue", event_planner: "Event Planner", videographer: "Digital", status: "Status",
  cloned_from: "Cloned from",
} as const;
export type HistoryFieldKey = keyof typeof HISTORY_FIELDS;

export interface ActivityView {
  id: number;
  version: number;
  status: ActivityStatus;
  isDeleted: boolean;
  /** What the editor shows and sends back. `lookAhead` is present only for users who see that fieldset. */
  fields: ActivityFields;
  startAt: string | null;
  endAt: string | null;
  nrAt: string | null;
  lookAhead: (LookAheadFields & { inferred: LookAheadInference }) | null;
  /** The review markup; empty unless the viewer is HQ at Editor and above (spec addendum §6). */
  needsReview: NeedsReviewKey[];
  createdAt: string;
  lastUpdatedAt: string;
  lastUpdatedByName: string | null;
  /** A live edit lock (spec addendum §7.5). */
  lock: { holderName: string; since: string; mine: boolean; tabId: string | null } | null;
  can: { edit: boolean; clone: boolean; delete: boolean; review: boolean };
}

export interface ActivityChangeView {
  id: number;
  at: string;
  actorName: string;
  action: ChangeAction;
  source: ChangeSource;
  fields: { key: string; label: string; old: string | null; new: string | null }[];
}

export interface WriteResponse {
  activity: ActivityView;
  warnings: string[];
}
```

Add `export * from "./view";` to the contract's `index.ts`.

- [ ] **Step 5: Errors, the store and reference resolution**

In `apps/calendar/src/lookups.ts`, export the existing lock function: change `async function lockLookup` to `export async function lockLookup`.

`apps/calendar/src/activities/errors.ts`:

```ts
import type { FieldError } from "@gcpe/calendar-contract";

export class ActivityNotFoundError extends Error {
  override name = "ActivityNotFoundError";
}
/** A visible activity the caller may not act on. Not visible is ActivityNotFoundError (spec addendum §6). */
export class ActivityForbiddenError extends Error {
  override name = "ActivityForbiddenError";
}
/** A deleted activity is read-only; Review is its only action (spec addendum §6). */
export class ActivityDeletedError extends Error {
  override name = "ActivityDeletedError";
  constructor() {
    super("This activity is deleted");
  }
}
export class VersionConflictError extends Error {
  override name = "VersionConflictError";
  constructor() {
    super("Someone else changed this activity — reload to see their changes");
  }
}
export class ActivityLockedError extends Error {
  override name = "ActivityLockedError";
  constructor(
    readonly code: "locked" | "locked_elsewhere",
    message: string,
    readonly holder: { displayName: string; since: string } | null,
  ) {
    super(message);
  }
}
export class ActivityValidationError extends Error {
  override name = "ActivityValidationError";
  constructor(readonly errors: FieldError[]) {
    super("fix the fields named");
  }
}
```

`apps/calendar/src/activities/store.ts`:

```ts
import { asc, eq, inArray, sql } from "drizzle-orm";
import { sqlNow, type DbOrTx, type TestClock, type Tx } from "@gcpe/db-kit";
import { cleanDetails, cleanTitle, type ActivityFields, type CalendarRules, type HqSection, type HqStatus, type LookAheadInput } from "@gcpe/calendar-contract";
import {
  activities, activityCategories, activityCommMaterials, activityInitiatives, activityKeywords, activityLocks, activityNrOrigins,
  activitySectors, activitySharedWith, activityTags, activityThemes, categories, keywords, orgs, users,
} from "../db/schema";
import { instantOf, wallClock } from "../time";
import type { VisibilityFacts } from "../visibility";
import type { ReviewSnapshot } from "./review-rules";

export type ActivityRow = typeof activities.$inferSelect;
export interface JoinIds {
  categoryIds: number[];
  commMaterialIds: number[];
  initiativeIds: number[];
  keywordIds: number[];
  nrOriginIds: number[];
  sectorKeys: string[];
  themeKeys: string[];
  tagKeys: string[];
  sharedWithKeys: string[];
}
export interface StoredActivity {
  row: ActivityRow;
  joins: JoinIds;
  keywordNames: string[];
}
/** The content a save writes: everything but status, flags, the Look Ahead fields and bookkeeping. */
export interface Content {
  startAt: Date | null;
  endAt: Date | null;
  nrAt: Date | null;
  potentialDates: string;
  isAllDay: boolean;
  isConfirmed: boolean;
  title: string;
  details: string;
  schedule: string;
  significance: string;
  strategy: string;
  comments: string;
  leadOrganization: string;
  venue: string;
  otherCity: string;
  translations: string[];
  nrDistributionId: number | null;
  premierRequestedId: number | null;
  contactMinistryKey: string | null;
  governmentRepresentativeId: number | null;
  commContactId: number | null;
  eventPlannerId: number | null;
  videographerId: number | null;
  cityId: number | null;
  isIssue: boolean;
  isAtLegislature: boolean;
  isConfidential: boolean;
  isCrossGovernment: boolean;
  isMilestone: boolean;
}
export interface LookAheadValues {
  hqComments: string;
  hqStatus: HqStatus | null;
  hqSection: HqSection;
  longTermOutlook: boolean;
}

export const uniqNum = (xs: readonly number[]) => [...new Set(xs)].sort((a, b) => a - b);
export const uniqStr = (xs: readonly string[]) => [...new Set(xs)].sort();

/** Every write to one activity takes this first, then reads the row FOR UPDATE and re-checks it. */
export async function lockActivity(tx: Tx, id: number): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`calendar-activity:${id}`}))`);
}

export async function loadStored(db: DbOrTx, id: number, opts: { forUpdate?: boolean } = {}): Promise<StoredActivity | null> {
  const q = db.select().from(activities).where(eq(activities.id, id));
  const [row] = opts.forUpdate ? await q.for("update") : await q;
  if (!row) return null;
  const nums = (rows: { v: number }[]) => uniqNum(rows.map((r) => r.v));
  const strs = (rows: { v: string }[]) => uniqStr(rows.map((r) => r.v));
  const kw = await db.select({ id: keywords.id, name: keywords.name }).from(activityKeywords).innerJoin(keywords, eq(keywords.id, activityKeywords.keywordId)).where(eq(activityKeywords.activityId, id)).orderBy(asc(keywords.name));
  return {
    row,
    keywordNames: kw.map((k) => k.name),
    joins: {
      categoryIds: nums(await db.select({ v: activityCategories.categoryId }).from(activityCategories).where(eq(activityCategories.activityId, id))),
      commMaterialIds: nums(await db.select({ v: activityCommMaterials.commMaterialId }).from(activityCommMaterials).where(eq(activityCommMaterials.activityId, id))),
      initiativeIds: nums(await db.select({ v: activityInitiatives.initiativeId }).from(activityInitiatives).where(eq(activityInitiatives.activityId, id))),
      keywordIds: uniqNum(kw.map((k) => k.id)),
      nrOriginIds: nums(await db.select({ v: activityNrOrigins.nrOriginId }).from(activityNrOrigins).where(eq(activityNrOrigins.activityId, id))),
      sectorKeys: strs(await db.select({ v: activitySectors.termKey }).from(activitySectors).where(eq(activitySectors.activityId, id))),
      themeKeys: strs(await db.select({ v: activityThemes.termKey }).from(activityThemes).where(eq(activityThemes.activityId, id))),
      tagKeys: strs(await db.select({ v: activityTags.termKey }).from(activityTags).where(eq(activityTags.activityId, id))),
      sharedWithKeys: strs(await db.select({ v: activitySharedWith.ministryKey }).from(activitySharedWith).where(eq(activitySharedWith.activityId, id))),
    },
  };
}

export function factsOf(s: StoredActivity): VisibilityFacts {
  return { contactMinistryKey: s.row.contactMinistryKey, sharedMinistryKeys: s.joins.sharedWithKeys, isConfidential: s.row.isConfidential, isDeleted: s.row.deletedAt !== null };
}

export function contentOf(r: ActivityRow): Content {
  return {
    startAt: r.startAt, endAt: r.endAt, nrAt: r.nrAt, potentialDates: r.potentialDates ?? "", isAllDay: r.isAllDay, isConfirmed: r.isConfirmed,
    title: r.title, details: r.details, schedule: r.schedule, significance: r.significance, strategy: r.strategy ?? "", comments: r.comments ?? "",
    leadOrganization: r.leadOrganization ?? "", venue: r.venue ?? "", otherCity: r.otherCity ?? "", translations: r.translations,
    nrDistributionId: r.nrDistributionId, premierRequestedId: r.premierRequestedId, contactMinistryKey: r.contactMinistryKey,
    governmentRepresentativeId: r.governmentRepresentativeId, commContactId: r.commContactId, eventPlannerId: r.eventPlannerId,
    videographerId: r.videographerId, cityId: r.cityId, isIssue: r.isIssue, isAtLegislature: r.isAtLegislature, isConfidential: r.isConfidential,
    isCrossGovernment: r.isCrossGovernment, isMilestone: r.isMilestone,
  };
}

export function lookAheadOf(r: ActivityRow): LookAheadValues {
  return { hqComments: r.hqComments ?? "", hqStatus: r.hqStatus, hqSection: r.hqSection, longTermOutlook: r.longTermOutlook };
}

/** The stored activity as the editor's fields, in BC wall-clock time. An all-day activity has no times. */
export function fieldsOf(s: StoredActivity, timeZone: string): ActivityFields {
  const r = s.row;
  const local = (d: Date | null) => (d ? wallClock(d, timeZone) : null);
  const [start, end, nr] = [local(r.startAt), local(r.endAt), local(r.nrAt)];
  const c = contentOf(r);
  return {
    categoryId: s.joins.categoryIds[0] ?? null,
    title: c.title, details: c.details, significance: c.significance, strategy: c.strategy, schedule: c.schedule, comments: c.comments,
    leadOrganization: c.leadOrganization, venue: c.venue, otherCity: c.otherCity, potentialDates: c.potentialDates,
    isIssue: c.isIssue, isConfidential: c.isConfidential, isMilestone: c.isMilestone, isCrossGovernment: c.isCrossGovernment,
    isAtLegislature: c.isAtLegislature, isAllDay: c.isAllDay, isConfirmed: c.isConfirmed,
    startDate: start?.date ?? null, startTime: c.isAllDay ? null : (start?.time ?? null),
    endDate: end?.date ?? null, endTime: c.isAllDay ? null : (end?.time ?? null),
    nrDate: nr?.date ?? null, nrTime: nr?.time ?? null,
    contactMinistryKey: c.contactMinistryKey, commContactId: c.commContactId, governmentRepresentativeId: c.governmentRepresentativeId,
    cityId: c.cityId, premierRequestedId: c.premierRequestedId, nrDistributionId: c.nrDistributionId, eventPlannerId: c.eventPlannerId,
    videographerId: c.videographerId, nrOriginId: s.joins.nrOriginIds[0] ?? null,
    commMaterialIds: s.joins.commMaterialIds, initiativeIds: s.joins.initiativeIds, keywordNames: s.keywordNames,
    sectorKeys: s.joins.sectorKeys, themeKeys: s.joins.themeKeys, tagKeys: s.joins.tagKeys, sharedWithKeys: s.joins.sharedWithKeys,
    translations: c.translations,
    lookAhead: lookAheadOf(r),
  };
}

/** The editor's fields as columns. All-day starts at 00:00 and ends at 23:45 BC, as legacy's GetDateTime (Activity.aspx.cs:921-938). */
export function contentFrom(i: ActivityFields, rules: CalendarRules): Content {
  const tz = rules.timeZone;
  return {
    startAt: i.startDate ? instantOf(i.startDate, i.isAllDay || !i.startTime ? "00:00" : i.startTime, tz) : null,
    endAt: i.endDate ? instantOf(i.endDate, i.isAllDay || !i.endTime ? "23:45" : i.endTime, tz) : null,
    nrAt: i.nrDate && i.nrTime ? instantOf(i.nrDate, i.nrTime, tz) : null,
    potentialDates: i.potentialDates.trim(),
    isAllDay: i.isAllDay,
    isConfirmed: i.isConfirmed,
    title: cleanTitle(i.title),
    details: cleanDetails(i.details),
    schedule: i.schedule.trim(),
    significance: i.significance.trim(),
    strategy: i.strategy.trim(),
    comments: i.comments.trim(),
    leadOrganization: i.leadOrganization.trim(),
    venue: i.venue.trim(),
    // Legacy clears Other City unless the city is "Other…" (Activity.aspx.cs:1213-1214).
    otherCity: i.cityId === rules.otherCityId ? i.otherCity.trim() : "",
    translations: uniqStr(i.translations.map((t) => t.trim()).filter(Boolean)),
    nrDistributionId: i.nrDistributionId,
    premierRequestedId: i.premierRequestedId,
    contactMinistryKey: i.contactMinistryKey,
    governmentRepresentativeId: i.governmentRepresentativeId,
    commContactId: i.commContactId,
    eventPlannerId: i.eventPlannerId,
    videographerId: i.videographerId,
    cityId: i.cityId,
    isIssue: i.isIssue,
    isAtLegislature: i.isAtLegislature,
    isConfidential: i.isConfidential,
    isCrossGovernment: i.isCrossGovernment,
    isMilestone: i.isMilestone,
  };
}

/** Empty optional text is stored null, as imported legacy rows hold it. */
export function columnsOf(c: Content) {
  return { ...c, strategy: c.strategy || null, comments: c.comments || null, leadOrganization: c.leadOrganization || null, venue: c.venue || null, otherCity: c.otherCity || null, potentialDates: c.potentialDates || null };
}

export function snapshotOf(c: Content, j: JoinIds): ReviewSnapshot {
  return {
    title: c.title, details: c.details, governmentRepresentativeId: c.governmentRepresentativeId, cityId: c.cityId, otherCity: c.otherCity,
    startAt: c.startAt?.getTime() ?? null, endAt: c.endAt?.getTime() ?? null, potentialDates: c.potentialDates,
    categoryIds: j.categoryIds, isIssue: c.isIssue, isConfidential: c.isConfidential, commMaterialIds: j.commMaterialIds,
    significance: c.significance, comments: c.comments, schedule: c.schedule, strategy: c.strategy, leadOrganization: c.leadOrganization,
    venue: c.venue, initiativeIds: j.initiativeIds, keywordIds: j.keywordIds, nrOriginIds: j.nrOriginIds, translations: c.translations,
    premierRequestedId: c.premierRequestedId, nrDistributionId: c.nrDistributionId, eventPlannerId: c.eventPlannerId,
    videographerId: c.videographerId, isConfirmed: c.isConfirmed, isAllDay: c.isAllDay, isCrossGovernment: c.isCrossGovernment,
  };
}

export async function insertActivity(tx: Tx, v: { content: Content; lookAhead: LookAheadValues; actorId: string; at: Date }): Promise<number> {
  const [row] = await tx
    .insert(activities)
    .values({
      ...columnsOf(v.content),
      hqComments: v.lookAhead.hqComments || null, hqStatus: v.lookAhead.hqStatus, hqSection: v.lookAhead.hqSection, longTermOutlook: v.lookAhead.longTermOutlook,
      status: "new", needsReview: [], createdAt: v.at, createdBy: v.actorId, lastUpdatedAt: v.at, lastUpdatedBy: v.actorId, version: 1,
    })
    .returning({ id: activities.id });
  return row!.id;
}

/** Replaces every join row: saving replaces each whole set, as legacy's UpdateLinkingTables did. */
export async function replaceJoins(tx: Tx, id: number, j: JoinIds): Promise<void> {
  await tx.delete(activityCategories).where(eq(activityCategories.activityId, id));
  await tx.delete(activityCommMaterials).where(eq(activityCommMaterials.activityId, id));
  await tx.delete(activityInitiatives).where(eq(activityInitiatives.activityId, id));
  await tx.delete(activityKeywords).where(eq(activityKeywords.activityId, id));
  await tx.delete(activityNrOrigins).where(eq(activityNrOrigins.activityId, id));
  await tx.delete(activitySectors).where(eq(activitySectors.activityId, id));
  await tx.delete(activityThemes).where(eq(activityThemes.activityId, id));
  await tx.delete(activityTags).where(eq(activityTags.activityId, id));
  await tx.delete(activitySharedWith).where(eq(activitySharedWith.activityId, id));
  const cats = uniqNum(j.categoryIds);
  if (cats.length) await tx.insert(activityCategories).values(cats.map((categoryId) => ({ activityId: id, categoryId })));
  const materials = uniqNum(j.commMaterialIds);
  if (materials.length) await tx.insert(activityCommMaterials).values(materials.map((commMaterialId) => ({ activityId: id, commMaterialId })));
  const inits = uniqNum(j.initiativeIds);
  if (inits.length) await tx.insert(activityInitiatives).values(inits.map((initiativeId) => ({ activityId: id, initiativeId })));
  const kws = uniqNum(j.keywordIds);
  if (kws.length) await tx.insert(activityKeywords).values(kws.map((keywordId) => ({ activityId: id, keywordId })));
  const origins = uniqNum(j.nrOriginIds);
  if (origins.length) await tx.insert(activityNrOrigins).values(origins.map((nrOriginId) => ({ activityId: id, nrOriginId })));
  const sectors = uniqStr(j.sectorKeys);
  if (sectors.length) await tx.insert(activitySectors).values(sectors.map((termKey) => ({ activityId: id, termKey })));
  const themes = uniqStr(j.themeKeys);
  if (themes.length) await tx.insert(activityThemes).values(themes.map((termKey) => ({ activityId: id, termKey })));
  const tags = uniqStr(j.tagKeys);
  if (tags.length) await tx.insert(activityTags).values(tags.map((termKey) => ({ activityId: id, termKey })));
  const shared = uniqStr(j.sharedWithKeys);
  if (shared.length) await tx.insert(activitySharedWith).values(shared.map((ministryKey) => ({ activityId: id, ministryKey })));
}

/** The inference's inputs for some fields: category names and the ministry's abbreviation come from the database. */
export async function lookAheadInputOf(db: DbOrTx, f: ActivityFields, categoryIds: number[], currentSection: HqSection | null): Promise<LookAheadInput> {
  const names = categoryIds.length ? (await db.select({ name: categories.name }).from(categories).where(inArray(categories.id, categoryIds))).map((c) => c.name) : [];
  const [org] = f.contactMinistryKey ? await db.select({ abbreviation: orgs.abbreviation }).from(orgs).where(eq(orgs.key, f.contactMinistryKey)) : [];
  return {
    categoryIds, categoryNames: names, contactMinistryAbbreviation: org?.abbreviation ?? null, isConfidential: f.isConfidential,
    isIssue: f.isIssue, isConfirmed: f.isConfirmed, commMaterialIds: f.commMaterialIds, startDate: f.startDate, endDate: f.endDate, currentSection,
  };
}

/** A lock is live while its holder was active in the last 15 minutes (spec addendum §7.5). */
export const LOCK_IDLE_MS = 15 * 60_000;

export interface LiveLock {
  userId: string;
  tabId: string;
  acquiredAt: Date;
  holderName: string;
}

export async function liveLockOf(db: DbOrTx, activityId: number, clock?: TestClock, opts: { forUpdate?: boolean } = {}): Promise<LiveLock | null> {
  const q = db
    .select({ userId: activityLocks.userId, tabId: activityLocks.tabId, acquiredAt: activityLocks.acquiredAt, lastActiveAt: activityLocks.lastActiveAt, live: sql<boolean>`${activityLocks.lastActiveAt} > ${sqlNow(clock)} - interval '15 minutes'` })
    .from(activityLocks)
    .where(eq(activityLocks.activityId, activityId));
  const [lock] = opts.forUpdate ? await q.for("update") : await q;
  if (!lock || !lock.live) return null;
  const [holder] = await db.select({ name: users.displayName }).from(users).where(eq(users.id, lock.userId));
  return { userId: lock.userId, tabId: lock.tabId, acquiredAt: lock.acquiredAt, holderName: holder?.name ?? "Someone" };
}
```

`apps/calendar/src/activities/resolve.ts`:

```ts
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@gcpe/db-kit";
import type { ActivityFields, CalendarRules, FieldError } from "@gcpe/calendar-contract";
import { can } from "../capabilities";
import { commContacts, keywords, orgs, terms } from "../db/schema";
import type { Viewer } from "../visibility";
import type { StoredActivity } from "./store";

export interface Resolution {
  errors: FieldError[];
  categoryNames: string[];
  contactMinistryAbbreviation: string | null;
  /** Existing keywords, matched case-insensitively (active first). */
  keywordIds: number[];
  /** Names no keyword has yet; created on save (C146). */
  keywordsToCreate: string[];
}

interface Ctx {
  actor: Viewer;
  rules: CalendarRules;
  /** The stored activity and its fields, on an update or clone: an inactive value it already has stays allowed. */
  previous: { stored: StoredActivity; fields: ActivityFields } | null;
}

const SINGLE = [
  ["cityId", "cities", "city"],
  ["governmentRepresentativeId", "government_representatives", "representative"],
  ["premierRequestedId", "premier_requested", "Premier Requested value"],
  ["nrDistributionId", "nr_distributions", "distribution"],
  ["eventPlannerId", "event_planners", "event planner"],
  ["videographerId", "videographers", "Digital contact"],
  ["nrOriginId", "nr_origins", "origin"],
] as const;

async function lookupRows(tx: Tx, table: string, ids: number[]): Promise<Map<number, { name: string; isActive: boolean }>> {
  if (ids.length === 0) return new Map();
  const r = await tx.execute<{ id: number; name: string; is_active: boolean }>(sql`SELECT id, name, is_active FROM ${sql.identifier(table)} WHERE id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
  return new Map(r.rows.map((x) => [Number(x.id), { name: x.name, isActive: x.is_active }]));
}

/**
 * Checks every reference the save names (spec addendum §7.2, C156) and resolves HQ Tags by name.
 * An inactive value is allowed only when the activity already has it, as legacy's dropdowns
 * offered inactive rows only when selected (DropDownListManager.cs:297).
 */
export async function resolveReferences(tx: Tx, i: ActivityFields, ctx: Ctx): Promise<Resolution> {
  const errors: FieldError[] = [];
  const add = (field: string, message: string) => errors.push({ field, message });
  const prev = ctx.previous;

  for (const [field, table, label] of SINGLE) {
    const v = i[field];
    if (v === null) continue;
    const row = (await lookupRows(tx, table, [v])).get(v);
    if (!row) add(field, `That ${label} doesn't exist`);
    else if (!row.isActive && prev?.fields[field] !== v) add(field, `That ${label} is no longer in use`);
  }

  let categoryNames: string[] = [];
  if (i.categoryId !== null) {
    const unchanged = prev?.fields.categoryId === i.categoryId;
    const ids = unchanged ? prev!.stored.joins.categoryIds : [i.categoryId];
    const rows = await lookupRows(tx, "categories", ids);
    const row = rows.get(i.categoryId);
    categoryNames = [...rows.values()].map((r) => r.name);
    if (!row) add("categoryId", "That category doesn't exist");
    else if (!unchanged && row.name === ctx.rules.hqPlaceholderCategoryName) {
      if (!can.useHqPlaceholder(ctx.actor)) add("categoryId", "Only HQ can use this category");
    } else if (!unchanged && !row.isActive) add("categoryId", "That category is no longer in use");
  }

  for (const [field, table, label] of [["commMaterialIds", "comm_materials", "comm material"], ["initiativeIds", "initiatives", "initiative"]] as const) {
    const rows = await lookupRows(tx, table, i[field]);
    const had = new Set(prev?.fields[field] ?? []);
    for (const v of i[field]) {
      const row = rows.get(v);
      if (!row) add(field, `A chosen ${label} doesn't exist`);
      else if (!row.isActive && !had.has(v)) add(field, `${row.name}: no longer in use`);
    }
  }

  let contactMinistryAbbreviation: string | null = null;
  if (i.contactMinistryKey !== null) {
    const [org] = await tx.select().from(orgs).where(eq(orgs.key, i.contactMinistryKey));
    contactMinistryAbbreviation = org?.abbreviation ?? null;
    const changed = prev?.fields.contactMinistryKey !== i.contactMinistryKey;
    if (!org) add("contactMinistryKey", "That ministry doesn't exist");
    else if (changed) {
      if (!org.isActive) add("contactMinistryKey", "That ministry is no longer active");
      else if (org.abbreviation && ctx.rules.contactMinistryExcludedAbbreviations.includes(org.abbreviation)) add("contactMinistryKey", "That ministry can't lead an activity");
      else if (!ctx.actor.isHq && !ctx.actor.ministryKeys.includes(i.contactMinistryKey)) add("contactMinistryKey", "You can only choose one of your ministries");
    }
  }

  if (i.commContactId !== null) {
    const [c] = await tx.select().from(commContacts).where(eq(commContacts.id, i.commContactId));
    if (!c) add("commContactId", "That comm contact doesn't exist");
    else if (c.ministryKey !== i.contactMinistryKey) add("commContactId", "Choose a comm contact of the lead ministry");
    else if (!c.isActive && prev?.fields.commContactId !== i.commContactId) add("commContactId", "That comm contact is no longer active");
  }

  for (const [field, kind] of [["sectorKeys", "sector"], ["themeKeys", "theme"], ["tagKeys", "tag"]] as const) {
    const wanted = [...new Set(i[field])];
    if (wanted.length === 0) continue;
    const rows = await tx.select().from(terms).where(and(eq(terms.kind, kind), inArray(terms.key, wanted)));
    const had = new Set(prev?.fields[field] ?? []);
    for (const k of wanted) {
      const t = rows.find((r) => r.key === k);
      if (!t) add(field, `Unknown ${kind}: ${k}`);
      else if (!t.isActive && !had.has(k)) add(field, `${t.displayName}: no longer in use`);
    }
  }

  const shared = [...new Set(i.sharedWithKeys)];
  if (shared.length) {
    const rows = await tx.select().from(orgs).where(inArray(orgs.key, shared));
    const had = new Set(prev?.fields.sharedWithKeys ?? []);
    for (const k of shared) {
      const o = rows.find((r) => r.key === k);
      if (!o) add("sharedWithKeys", `Unknown ministry: ${k}`);
      else if (!had.has(k) && !o.isActive) add("sharedWithKeys", `${o.displayName}: no longer active`);
      else if (!had.has(k) && o.abbreviation && ctx.rules.sharedWithExcludedAbbreviations.includes(o.abbreviation)) add("sharedWithKeys", `${o.displayName} can't be shared with`);
    }
  }

  // HQ Tags by name, case-insensitively, each once. Legacy matched names under SQL Server's
  // case-insensitive collation, inactive keywords included.
  const byLower = new Map<string, string>();
  for (const raw of i.keywordNames) {
    const name = raw.trim();
    if (name && !byLower.has(name.toLowerCase())) byLower.set(name.toLowerCase(), name);
  }
  const keywordIds: number[] = [];
  const keywordsToCreate: string[] = [];
  if (byLower.size) {
    const rows = await tx
      .select({ id: keywords.id, lower: sql<string>`lower(${keywords.name})`, isActive: keywords.isActive })
      .from(keywords)
      .where(inArray(sql`lower(${keywords.name})`, [...byLower.keys()]))
      .orderBy(sql`${keywords.isActive} DESC`, keywords.id);
    for (const [lower, name] of byLower) {
      const match = rows.find((r) => r.lower === lower);
      if (match) keywordIds.push(match.id);
      else keywordsToCreate.push(name);
    }
  }

  return { errors, categoryNames, contactMinistryAbbreviation, keywordIds, keywordsToCreate };
}

/** Creates HQ Tags under the keyword lookup's lock, which the caller already holds. */
export async function createKeywords(tx: Tx, names: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const name of names) {
    const r = await tx.execute<{ id: number }>(sql`INSERT INTO keywords (name, sort_order) VALUES (${name}, (SELECT coalesce(max(sort_order), 0) + 1 FROM keywords)) RETURNING id`);
    ids.push(Number(r.rows[0]!.id));
  }
  return ids;
}
```

- [ ] **Step 6: History, events and reads**

`apps/calendar/src/activities/history.ts`:

```ts
import { eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "@gcpe/db-kit";
import { HISTORY_FIELDS, type CalendarRules, type ChangeAction, type HistoryFieldKey } from "@gcpe/calendar-contract";
import { activityChangeFields, activityChanges, commContacts, orgs, terms, users } from "../db/schema";
import { wallClock } from "../time";
import type { Content, JoinIds, LookAheadValues } from "./store";

export type Display = Record<HistoryFieldKey, string | null>;
export interface FieldChange {
  key: HistoryFieldKey;
  old: string | null;
  new: string | null;
}

const SECTION_LABELS = { issues_and_reports: "Issues & Reports", events_and_speeches: "Events & Speeches", in_the_news: "In the News", not_on_la: "Not on LA" } as const;
const yesNo = (b: boolean) => (b ? "Yes" : "No");
const text = (s: string) => (s.trim() === "" ? null : s.trim());
const list = (xs: string[]) => (xs.length ? [...xs].sort((a, b) => a.localeCompare(b)).join(", ") : null);

async function names(db: DbOrTx, table: string, ids: number[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const r = await db.execute<{ name: string }>(sql`SELECT name FROM ${sql.identifier(table)} WHERE id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
  return r.rows.map((x) => x.name);
}
async function one(db: DbOrTx, table: string, id: number | null): Promise<string | null> {
  return id === null ? null : ((await names(db, table, [id]))[0] ?? String(id));
}

/** What "View changes" shows for each field (spec addendum §8.3): names, not ids; BC times. */
export async function displayOf(db: DbOrTx, c: Content, la: LookAheadValues, j: JoinIds, keywordNames: string[], rules: CalendarRules): Promise<Display> {
  const when = (d: Date | null, dateOnly: boolean) => {
    if (!d) return null;
    const w = wallClock(d, rules.timeZone);
    return dateOnly ? w.date : `${w.date} ${w.time}`;
  };
  const orgName = async (keys: string[]) => {
    if (keys.length === 0) return [];
    const rows = await db.select({ key: orgs.key, name: orgs.displayName }).from(orgs).where(inArray(orgs.key, keys));
    return keys.map((k) => rows.find((r) => r.key === k)?.name ?? k);
  };
  const termNames = async (kind: string, keys: string[]) => {
    if (keys.length === 0) return [];
    const rows = await db.select({ key: terms.key, name: terms.displayName }).from(terms).where(inArray(terms.key, keys));
    return keys.map((k) => rows.find((r) => r.key === k)?.name ?? `${kind} ${k}`);
  };
  let commContact: string | null = null;
  if (c.commContactId !== null) {
    const [cc] = await db.select({ name: users.displayName, abbr: orgs.abbreviation }).from(commContacts).leftJoin(users, eq(users.id, commContacts.userId)).leftJoin(orgs, eq(orgs.key, commContacts.ministryKey)).where(eq(commContacts.id, c.commContactId));
    commContact = cc ? `${cc.name ?? "Unknown"}${cc.abbr ? ` (${cc.abbr})` : ""}` : String(c.commContactId);
  }
  return {
    category: list(await names(db, "categories", j.categoryIds)),
    is_confidential: yesNo(c.isConfidential),
    title: text(c.title),
    details: text(c.details),
    is_issue: yesNo(c.isIssue),
    significance: text(c.significance),
    lead_organization: text(c.leadOrganization),
    initiatives: list(await names(db, "initiatives", j.initiativeIds)),
    keywords: list(keywordNames),
    comm_contact: commContact,
    is_milestone: yesNo(c.isMilestone),
    strategy: text(c.strategy),
    comm_materials: list(await names(db, "comm_materials", j.commMaterialIds)),
    comments: text(c.comments),
    contact_ministry: c.contactMinistryKey ? ((await orgName([c.contactMinistryKey]))[0] ?? null) : null,
    is_cross_government: yesNo(c.isCrossGovernment),
    shared_with: list(await orgName(j.sharedWithKeys)),
    hq_comments: text(la.hqComments),
    hq_status: la.hqStatus === null ? null : la.hqStatus === "new" ? "New" : "Changed",
    hq_section: SECTION_LABELS[la.hqSection],
    long_term_outlook: yesNo(la.longTermOutlook),
    start: when(c.startAt, c.isAllDay),
    end: when(c.endAt, c.isAllDay),
    is_all_day: yesNo(c.isAllDay),
    is_confirmed: yesNo(c.isConfirmed),
    potential_dates: text(c.potentialDates),
    schedule: text(c.schedule),
    nr_at: when(c.nrAt, false),
    nr_origins: list(await names(db, "nr_origins", j.nrOriginIds)),
    nr_distribution: await one(db, "nr_distributions", c.nrDistributionId),
    translations: list(c.translations),
    sectors: list(await termNames("sector", j.sectorKeys)),
    themes: list(await termNames("theme", j.themeKeys)),
    tags: list(await termNames("tag", j.tagKeys)),
    premier_requested: await one(db, "premier_requested", c.premierRequestedId),
    representative: await one(db, "government_representatives", c.governmentRepresentativeId),
    is_at_legislature: yesNo(c.isAtLegislature),
    city: await one(db, "cities", c.cityId),
    other_city: text(c.otherCity),
    venue: text(c.venue),
    event_planner: await one(db, "event_planners", c.eventPlannerId),
    videographer: await one(db, "videographers", c.videographerId),
    status: null,
    cloned_from: null,
  };
}

export function diffDisplay(before: Display, after: Display): FieldChange[] {
  return (Object.keys(HISTORY_FIELDS) as HistoryFieldKey[]).filter((k) => before[k] !== after[k]).map((k) => ({ key: k, old: before[k], new: after[k] }));
}

/** Every field with a value, for `created` and `cloned` (spec addendum §7.1). "No" flags aren't "set". */
export function setFields(after: Display): FieldChange[] {
  return (Object.keys(HISTORY_FIELDS) as HistoryFieldKey[]).filter((k) => after[k] !== null && after[k] !== "No").map((k) => ({ key: k, old: null, new: after[k] }));
}

export async function writeChange(
  tx: Tx,
  c: { activityId: number; actor: { userId: string; displayName: string }; action: ChangeAction; contactMinistryKey: string | null; at: Date; fields: FieldChange[] },
): Promise<void> {
  const [row] = await tx
    .insert(activityChanges)
    .values({ activityId: c.activityId, at: c.at, actorId: c.actor.userId, actorName: c.actor.displayName, action: c.action, source: "calendar", contactMinistryKey: c.contactMinistryKey })
    .returning({ id: activityChanges.id });
  if (c.fields.length) {
    await tx.insert(activityChangeFields).values(c.fields.map((f) => ({ changeId: row!.id, fieldKey: f.key, oldValue: f.old, newValue: f.new })));
  }
}
```

`apps/calendar/src/activities/events.ts`:

```ts
import { inArray } from "drizzle-orm";
import type { DbOrTx, Tx } from "@gcpe/db-kit";
import type { CalendarRules } from "@gcpe/calendar-contract";
import { enqueueEvent, type ActivityEvent, type SubscriberConfig } from "@gcpe/events";
import { categories, cities } from "../db/schema";
import { loadStored } from "./store";

const aggregateId = (id: number) => `activity:${id}`;

/** The §5.4 payload. A confidential activity leaves as its id only: no text leaves the Calendar (C127). */
export async function activityEventData(db: DbOrTx, id: number, rules: CalendarRules): Promise<ActivityEvent> {
  const s = (await loadStored(db, id))!;
  const r = s.row;
  const isDeleted = r.deletedAt !== null;
  if (r.isConfidential) return { id, isConfidential: true, isDeleted };
  const categoryNames = s.joins.categoryIds.length ? (await db.select({ name: categories.name }).from(categories).where(inArray(categories.id, s.joins.categoryIds))).map((c) => c.name) : [];
  const cityName = r.cityId === null ? null : r.cityId === rules.otherCityId ? (r.otherCity || null) : ((await db.select({ name: cities.name }).from(cities).where(inArray(cities.id, [r.cityId])))[0]?.name ?? null);
  return {
    id, isConfidential: false, isDeleted, title: r.title, details: r.details,
    startAt: r.startAt?.toISOString() ?? null, endAt: r.endAt?.toISOString() ?? null, nrAt: r.nrAt?.toISOString() ?? null,
    isAllDay: r.isAllDay, isConfirmed: r.isConfirmed, contactMinistryKey: r.contactMinistryKey, sharedMinistryKeys: s.joins.sharedWithKeys,
    categoryNames, cityName, themeKeys: s.joins.themeKeys, tagKeys: s.joins.tagKeys, sectorKeys: s.joins.sectorKeys, translations: r.translations,
  };
}

/** In the write's own transaction (spec addendum §7.1 "Events"). */
export async function emitActivity(tx: Tx, deps: { rules: CalendarRules; subscribers: SubscriberConfig[] }, id: number, type: "activity.created" | "activity.updated"): Promise<void> {
  await enqueueEvent(tx, { type, source: "calendar", aggregateId: aggregateId(id), data: await activityEventData(tx, id, deps.rules) }, deps.subscribers);
}

export async function emitActivityDeleted(tx: Tx, deps: { subscribers: SubscriberConfig[] }, id: number): Promise<void> {
  await enqueueEvent(tx, { type: "activity.deleted", source: "calendar", aggregateId: aggregateId(id), data: { id } }, deps.subscribers);
}
```

`apps/calendar/src/activities/view.ts`:

```ts
import { desc, eq, inArray } from "drizzle-orm";
import { HISTORY_FIELDS, inferLookAhead, type ActivityChangeView, type ActivityView, type HistoryFieldKey } from "@gcpe/calendar-contract";
import type { CalendarActor } from "../actor";
import { can } from "../capabilities";
import { activityChangeFields, activityChanges, users } from "../db/schema";
import type { ApiDeps } from "../http/routes";
import { visible } from "../visibility";
import { ActivityNotFoundError } from "./errors";
import { factsOf, fieldsOf, liveLockOf, loadStored, lookAheadInputOf, type StoredActivity } from "./store";

export async function readActivity(deps: ApiDeps, actor: CalendarActor, id: number): Promise<ActivityView> {
  const s = await loadStored(deps.db, id);
  if (!s || !visible(actor, factsOf(s))) throw new ActivityNotFoundError();
  return viewOf(deps, actor, s);
}

async function viewOf(deps: ApiDeps, actor: CalendarActor, s: StoredActivity): Promise<ActivityView> {
  const { db, rules } = deps;
  const facts = factsOf(s);
  const fields = fieldsOf(s, rules.timeZone);
  const fieldset = can.seeLookAheadFieldset(actor, rules, facts);
  const lock = await liveLockOf(db, s.row.id, deps.now);
  const [updater] = s.row.lastUpdatedBy ? await db.select({ name: users.displayName }).from(users).where(eq(users.id, s.row.lastUpdatedBy)) : [];
  const lookAhead = fields.lookAhead!;
  if (!fieldset) delete fields.lookAhead;
  return {
    id: s.row.id,
    version: s.row.version,
    status: s.row.status,
    isDeleted: facts.isDeleted,
    fields,
    startAt: s.row.startAt?.toISOString() ?? null,
    endAt: s.row.endAt?.toISOString() ?? null,
    nrAt: s.row.nrAt?.toISOString() ?? null,
    lookAhead: fieldset ? { ...lookAhead, inferred: inferLookAhead(await lookAheadInputOf(db, fields, s.joins.categoryIds, s.row.hqSection), rules) } : null,
    needsReview: can.seeNeedsReviewMarkup(actor) ? s.row.needsReview : [],
    createdAt: s.row.createdAt.toISOString(),
    lastUpdatedAt: s.row.lastUpdatedAt.toISOString(),
    lastUpdatedByName: updater?.name ?? null,
    lock: lock ? { holderName: lock.holderName, since: lock.acquiredAt.toISOString(), mine: lock.userId === actor.userId, tabId: lock.userId === actor.userId ? lock.tabId : null } : null,
    can: { edit: can.edit(actor, facts), clone: can.clone(actor, facts), delete: can.delete(actor, facts), review: can.review(actor, facts) },
  };
}

/** "View changes" (spec addendum §8.3): newest first, for anyone who can see the activity. */
export async function readChanges(deps: ApiDeps, actor: CalendarActor, id: number): Promise<ActivityChangeView[]> {
  const s = await loadStored(deps.db, id);
  if (!s || !visible(actor, factsOf(s))) throw new ActivityNotFoundError();
  const changes = await deps.db.select().from(activityChanges).where(eq(activityChanges.activityId, id)).orderBy(desc(activityChanges.at), desc(activityChanges.id));
  const fields = changes.length ? await deps.db.select().from(activityChangeFields).where(inArray(activityChangeFields.changeId, changes.map((c) => c.id))) : [];
  const order = Object.keys(HISTORY_FIELDS);
  return changes.map((c) => ({
    id: c.id,
    at: c.at.toISOString(),
    actorName: c.actorName,
    action: c.action,
    source: c.source,
    fields: fields
      .filter((f) => f.changeId === c.id)
      .sort((a, b) => order.indexOf(a.fieldKey) - order.indexOf(b.fieldKey))
      .map((f) => ({ key: f.fieldKey, label: HISTORY_FIELDS[f.fieldKey as HistoryFieldKey] ?? f.fieldKey, old: f.oldValue, new: f.newValue })),
  }));
}
```

- [ ] **Step 7: Create**

`apps/calendar/src/activities/create.ts`:

```ts
import { inArray } from "drizzle-orm";
import { checkActivity, inferLookAhead, LEVEL, sectionToStore, warningsFor, type ActivityFields } from "@gcpe/calendar-contract";
import type { CalendarActor } from "../actor";
import { can } from "../capabilities";
import { keywords } from "../db/schema";
import { assertNotFrozen } from "../freeze";
import type { ApiDeps } from "../http/routes";
import { lockLookup, LOOKUPS } from "../lookups";
import { dbNow, wallClock } from "../time";
import { ActivityForbiddenError, ActivityValidationError } from "./errors";
import { emitActivity } from "./events";
import { displayOf, setFields, writeChange } from "./history";
import { createKeywords, resolveReferences } from "./resolve";
import { contentFrom, insertActivity, lookAheadInputOf, replaceJoins, uniqNum, type JoinIds, type LookAheadValues } from "./store";

/** Spec addendum §7.1 Create: status new, no flags, every field saved (C145), history and an event in one transaction. */
export async function createActivity(deps: ApiDeps, actor: CalendarActor, input: ActivityFields): Promise<{ id: number; warnings: string[] }> {
  if (actor.level < LEVEL.editor) throw new ActivityForbiddenError("Editors and above create activities");
  return deps.db.transaction(async (tx) => {
    const now = await dbNow(tx, deps.now);
    assertNotFrozen(now, actor, deps.rules);
    // Before reading keywords, so a concurrent save can't create the same new keyword twice.
    if (input.keywordNames.length) await lockLookup(tx, LOOKUPS.keywords);
    const refs = await resolveReferences(tx, input, { actor, rules: deps.rules, previous: null });
    const fieldset = can.seeLookAheadFieldset(actor, deps.rules);
    const categoryIds = input.categoryId === null ? [] : [input.categoryId];
    const laInput = await lookAheadInputOf(tx, input, categoryIds, null);
    const inferred = inferLookAhead(laInput, deps.rules);
    const errors = [
      ...checkActivity(input, {
        rules: deps.rules,
        relaxRequired: can.relaxRequiredFields(actor),
        lookAheadFieldset: fieldset,
        previous: null,
        inferredSection: inferred.kind === "section" ? inferred.section : null,
      }),
      ...refs.errors,
    ];
    if (errors.length) throw new ActivityValidationError(errors);

    const section = sectionToStore({ before: null, after: laInput, chosen: fieldset ? input.lookAhead?.hqSection : undefined }, deps.rules);
    const la = input.lookAhead;
    const lookAhead: LookAheadValues = fieldset
      ? { hqComments: la ? la.hqComments.trim() : "**", hqStatus: la?.hqStatus ?? null, hqSection: section, longTermOutlook: la?.longTermOutlook ?? false }
      : // Draws HQ's attention to a ministry's new activity (Activity.aspx.cs:1098-1102).
        { hqComments: actor.level < LEVEL.administrator ? "**" : "", hqStatus: null, hqSection: section, longTermOutlook: false };
    const content = contentFrom(input, deps.rules);
    const id = await insertActivity(tx, { content, lookAhead, actorId: actor.userId, at: now });
    const created = await createKeywords(tx, refs.keywordsToCreate);
    const joins: JoinIds = {
      categoryIds,
      commMaterialIds: uniqNum(input.commMaterialIds),
      initiativeIds: uniqNum(input.initiativeIds),
      keywordIds: uniqNum([...refs.keywordIds, ...created]),
      nrOriginIds: input.nrOriginId === null ? [] : [input.nrOriginId],
      sectorKeys: input.sectorKeys,
      themeKeys: input.themeKeys,
      tagKeys: input.tagKeys,
      sharedWithKeys: input.sharedWithKeys,
    };
    await replaceJoins(tx, id, joins);
    // The keywords as stored: a reused keyword keeps its own spelling.
    const keywordNames = joins.keywordIds.length ? (await tx.select({ name: keywords.name }).from(keywords).where(inArray(keywords.id, joins.keywordIds))).map((k) => k.name) : [];
    const display = await displayOf(tx, content, lookAhead, joins, keywordNames, deps.rules);
    await writeChange(tx, { activityId: id, actor, action: "created", contactMinistryKey: content.contactMinistryKey, at: now, fields: setFields(display) });
    await emitActivity(tx, deps, id, "activity.created");
    return { id, warnings: warningsFor(input, wallClock(now, deps.rules.timeZone).date) };
  });
}
```

- [ ] **Step 8: Error mapping and routes**

`apps/calendar/src/http/errors.ts`:

```ts
import type { Response } from "express";
import { ZodError } from "zod";
import {
  ActivityDeletedError, ActivityForbiddenError, ActivityLockedError, ActivityNotFoundError, ActivityValidationError, VersionConflictError,
} from "../activities/errors";
import { FreezeError } from "../freeze";

const constraintCode = (e: unknown): string | null => {
  const code = (e as { cause?: { code?: unknown } })?.cause?.code ?? (e as { code?: unknown })?.code;
  return typeof code === "string" && code.startsWith("23") ? code : null;
};

/** Maps the activity service's typed errors to a response; false leaves the error to the generic 500. */
export function sendActivityError(e: unknown, res: Response): boolean {
  if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues }), true;
  if (e instanceof ActivityNotFoundError) return void res.status(404).json({ error: "not found" }), true;
  if (e instanceof ActivityForbiddenError) return void res.status(403).json({ error: e.message }), true;
  if (e instanceof FreezeError) return void res.status(423).json({ code: "freeze", error: e.message }), true;
  if (e instanceof ActivityLockedError) return void res.status(423).json({ code: e.code, error: e.message, holder: e.holder }), true;
  if (e instanceof VersionConflictError) return void res.status(409).json({ code: "version_conflict", error: e.message }), true;
  if (e instanceof ActivityDeletedError) return void res.status(409).json({ code: "deleted", error: e.message }), true;
  if (e instanceof ActivityValidationError) return void res.status(422).json({ error: "Fix the fields named", errors: e.errors }), true;
  const code = constraintCode(e);
  if (code) {
    // Validation makes every constraint unreachable; this catches a race it missed, never a 500.
    console.error("[calendar] activity write hit a constraint", code);
    return void res.status(409).json({ code: "conflict", error: "That change conflicts with another one: reload and try again" }), true;
  }
  return false;
}
```

`apps/calendar/src/http/activity-routes.ts`:

```ts
import { Router, type NextFunction, type Request, type Response } from "express";
import { createActivitySchema, type WriteResponse } from "@gcpe/calendar-contract";
import { createActivity } from "../activities/create";
import { ActivityNotFoundError } from "../activities/errors";
import { readActivity, readChanges } from "../activities/view";
import { sendActivityError } from "./errors";
import type { ApiDeps } from "./routes";

type Params = { id: string };
type Handler = (req: Request<Params>, res: Response) => Promise<void>;
const run = (h: Handler) => (req: Request<Params>, res: Response, next: NextFunction) =>
  h(req, res).catch((e: unknown) => {
    if (!sendActivityError(e, res)) next(e);
  });

export function idOf(req: Request<Params>): number {
  if (!/^\d{1,9}$/.test(req.params.id)) throw new ActivityNotFoundError();
  return Number(req.params.id);
}

/** The activity API (spec addendum §7). Every capability is checked in the service functions (C138–C141). */
export function activityRoutes(deps: ApiDeps): Router {
  const r = Router();
  r.post("/activities", run(async (req, res) => {
    const out = await createActivity(deps, req.calendar!, createActivitySchema.parse(req.body));
    const body: WriteResponse = { activity: await readActivity(deps, req.calendar!, out.id), warnings: out.warnings };
    res.status(201).json(body);
  }));
  r.get("/activities/:id", run(async (req, res) => void res.json(await readActivity(deps, req.calendar!, idOf(req)))));
  r.get("/activities/:id/changes", run(async (req, res) => void res.json(await readChanges(deps, req.calendar!, idOf(req)))));
  return r;
}
```

`apps/calendar/src/http/routes.ts`: add `r.use(activityRoutes(deps));` after `configRoutes`.

- [ ] **Step 9: The Calendar → NRMS route**

`apps/stack/src/env.ts`, in `INTERNAL_EVENT_ROUTES`, after the Core → Calendar route:

```ts
  {
    // The Calendar's activities, for NRMS's activity projection and Forecast (spec addendum §11).
    // Never to the News API: confidential text stays in the Calendar (C127).
    from: "CALENDAR", source: "calendar", to: "NRMS", name: "nrms", url: "self:/nrms/events",
    types: ["activity.created", "activity.updated", "activity.deleted"],
  },
```

`eventRoutesFor` already drops every route from or to `CALENDAR` when the Calendar isn't configured.

- [ ] **Step 10: Run the tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar apps/stack/src/env.test.ts packages/calendar-contract`
Expected: PASS.

Run both `tsc` commands.
Expected: no errors.

Then run `apps/stack/src/stack.test.ts`.
Expected: PASS. NRMS's receiver records `activity.*` from the Calendar as `ignored`.

- [ ] **Step 11: Commit**

```bash
git add packages/calendar-contract apps/calendar apps/stack/src/env.ts apps/stack/src/env.test.ts
git commit -m "feat(calendar): create and read activities with validation, history and activity.* to NRMS (never the News API)"
```

---
### Task 7: Edit locks and the lock-expiry sweep

Covers:
- spec §7.5:
  - taking a lock, and what makes a lock live;
  - heartbeat, release by the holder only, and "Continue here";
  - "<name> is editing this activity (since hh:mm)";
  - the tick deleting lapsed rows.
- §7.4: taking a lock is frozen.
- §5.1 (the lock-expiry sweep) and the carry-forward item "Lock-expiry sweep on the stack tick".
- The §3 exit check ("lock and concurrency tests on real Postgres").
- Decision F13.

**Files:**
- Create: `apps/calendar/src/activities/locks.ts`.
- Create: `apps/calendar/src/http/activity-locks.test.ts`.
- Modify: `apps/calendar/src/http/activity-routes.ts`, `apps/calendar/src/start.ts` (+ `start.test.ts`).
- Modify: `apps/stack/src/stack.ts` (+ `stack.test.ts`).

**Interfaces:**
- Consumes:
  - from `store.ts`: `lockActivity`, `loadStored`, `factsOf`, `liveLockOf` and `LOCK_IDLE_MS`;
  - `can.edit` and `assertNotFrozen`;
  - `sqlNow` (`@gcpe/db-kit`).
- Produces:
  - **Taking and releasing:**
    - `takeLock(deps, actor, id, tabId: string, takeOver: boolean): Promise<LockView>`, where `LockView = { holderName: string; since: string; mine: true; tabId: string }`;
    - `releaseLock(deps, actor, id, tabId): Promise<void>`.
  - **For the write paths:**
    - `assertNotLockedByOther(tx, deps, actor, id): Promise<void>`. Update and delete call it; it throws `ActivityLockedError("locked", …)`.
    - `releaseOwnLocks(tx, userId, id): Promise<void>`. Update calls it.
    - `clearLocks(tx, id): Promise<void>`. Delete calls it.
  - **The sweep:** `sweepLocks(db: Db, clock?: TestClock): Promise<{ deleted: number }>`.
  - **Routes:** `PUT /api/activities/:id/lock` with `{ tabId, takeOver? }`, and `POST /api/activities/:id/lock/release` with `{ tabId }`, which answers 204.
  - **Workers:** `workers.lockSweep` on the Calendar's `AppHandle`. Stack tick step `calendar.lock-sweep`, right after `calendar.dispatch`.

- [ ] **Step 1: Write the failing tests**

`apps/calendar/src/http/activity-locks.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCalendarTestDb, createTestApp, FIXED_NOW } from "../../test/helpers";
import { call, seedWorld, validInput, type World } from "../../test/world";
import { activities, activityLocks } from "../db/schema";
import { sweepLocks } from "../activities/locks";

const minutes = (n: number) => new Date(FIXED_NOW.getTime() + n * 60_000);

describe("edit locks (spec addendum §7.5)", () => {
  let tdb: TestDatabase;
  let w: World;
  let clock = FIXED_NOW;
  let app: ReturnType<typeof createTestApp>;
  let id: number;
  const lock = (who: keyof World["as"], tabId: string, takeOver?: boolean) => call(app, "put", `/api/activities/${id}/lock`, w.as[who].cookie, { tabId, ...(takeOver ? { takeOver } : {}) });
  const release = (who: keyof World["as"], tabId: string) => call(app, "post", `/api/activities/${id}/lock/release`, w.as[who].cookie, { tabId });

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db, { now: () => clock });
    w = await seedWorld(app, tdb.db);
  });
  beforeEach(async () => {
    clock = FIXED_NOW;
    id = (await call(app, "post", "/api/activities", w.as.editor.cookie, validInput(w))).body.activity.id;
  });
  afterAll(() => tdb.drop());

  it("the first taker gets it; the view shows it as theirs", async () => {
    const res = await lock("editor", "tab-a");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ holderName: "Robin Staff", mine: true, tabId: "tab-a" });
    expect((await call(app, "get", `/api/activities/${id}`, w.as.editor.cookie)).body.lock).toMatchObject({ holderName: "Robin Staff", mine: true, tabId: "tab-a" });
  });

  it("someone else gets 423 naming the holder and since when, in BC time", async () => {
    await lock("editor", "tab-a");
    const res = await lock("admin", "tab-b");
    expect(res.status).toBe(423);
    expect(res.body).toEqual({ code: "locked", error: "Robin Staff is editing this activity (since 11:00)", holder: { displayName: "Robin Staff", since: FIXED_NOW.toISOString() } });
    expect((await call(app, "get", `/api/activities/${id}`, w.as.admin.cookie)).body.lock).toMatchObject({ holderName: "Robin Staff", mine: false, tabId: null });
  });

  it("the same user in another tab is offered Continue here, which moves the lock", async () => {
    await lock("editor", "tab-a");
    expect((await lock("editor", "tab-b")).body).toMatchObject({ code: "locked_elsewhere" });
    expect((await lock("editor", "tab-b", true)).status).toBe(200);
    expect((await tdb.db.select().from(activityLocks).where(eq(activityLocks.activityId, id)))[0]).toMatchObject({ tabId: "tab-b", acquiredAt: FIXED_NOW });
  });

  it("only the holder's own tab releases it (legacy's cancel deleted anyone's lock)", async () => {
    await lock("editor", "tab-a");
    expect((await release("admin", "tab-a")).status).toBe(204);
    expect((await release("editor", "tab-z")).status).toBe(204);
    expect((await lock("admin", "tab-b")).status).toBe(423);
    await release("editor", "tab-a");
    expect((await lock("admin", "tab-b")).status).toBe(200);
  });

  it("lapses after 15 idle minutes; a heartbeat keeps it live", async () => {
    await lock("editor", "tab-a");
    clock = minutes(10);
    expect((await lock("editor", "tab-a")).status).toBe(200);
    clock = minutes(24);
    expect((await lock("admin", "tab-b")).status).toBe(423);
    clock = minutes(25);
    expect((await lock("admin", "tab-b")).status).toBe(200);
  });

  it("the sweep deletes lapsed locks and leaves live ones", async () => {
    await lock("editor", "tab-a");
    const other = (await call(app, "post", "/api/activities", w.as.editor.cookie, validInput(w))).body.activity.id as number;
    clock = minutes(10);
    await call(app, "put", `/api/activities/${other}/lock`, w.as.editor.cookie, { tabId: "tab-c" });
    expect(await sweepLocks(tdb.db, () => minutes(16))).toMatchObject({ deleted: expect.any(Number) });
    const left = await tdb.db.select().from(activityLocks);
    expect(left.map((l) => l.activityId)).toContain(other);
    expect(left.map((l) => l.activityId)).not.toContain(id);
  });

  it("is a content write: frozen for a ministry Editor, not for an HQ Editor (spec addendum §7.4)", async () => {
    clock = new Date("2026-11-03T23:30:00Z");
    expect((await lock("editor", "tab-a")).body).toMatchObject({ code: "freeze" });
    expect((await lock("hqEditor", "tab-h")).status).toBe(200);
  });

  it("needs edit rights on a live, visible activity", async () => {
    expect((await lock("readOnly", "tab-r")).status).toBe(403);
    expect((await lock("financeEditor", "tab-f")).status).toBe(404);
    await tdb.db.update(activities).set({ deletedAt: FIXED_NOW }).where(eq(activities.id, id));
    expect((await lock("hqAdmin", "tab-q")).body).toMatchObject({ code: "deleted" });
  });

  it("two people taking it at once: exactly one wins", async () => {
    const [a, b] = await Promise.all([lock("editor", "tab-a"), lock("admin", "tab-b")]);
    expect([a.status, b.status].sort()).toEqual([200, 423]);
  });

  it("a malformed body is 400", async () => {
    expect((await call(app, "put", `/api/activities/${id}/lock`, w.as.editor.cookie, { tabId: "" })).status).toBe(400);
    expect((await call(app, "put", `/api/activities/${id}/lock`, w.as.editor.cookie, { tabId: "a", extra: 1 })).status).toBe(400);
  });
});
```

In `apps/calendar/src/start.test.ts`, extend the existing start test:

```ts
      expect(await handle.workers.lockSweep!()).toEqual({ deleted: 0 });
```

In `apps/stack/src/stack.test.ts`'s `/stack/tick` test, insert `"calendar.lock-sweep"` right after `"calendar.dispatch"` in the expected step list, and add one more `"ok"` to the expected values (17 in all).

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/http/activity-locks.test.ts apps/calendar/src/start.test.ts`
Expected: FAIL. `../activities/locks` can't be resolved; the lock route is 404; there's no `lockSweep` worker.

- [ ] **Step 3: Implement**

`apps/calendar/src/activities/locks.ts`:

```ts
import { and, eq, sql } from "drizzle-orm";
import { sqlNow, type Db, type TestClock, type Tx } from "@gcpe/db-kit";
import type { CalendarRules } from "@gcpe/calendar-contract";
import type { CalendarActor } from "../actor";
import { can } from "../capabilities";
import { activityLocks } from "../db/schema";
import { assertNotFrozen } from "../freeze";
import type { ApiDeps } from "../http/routes";
import { dbNow, wallClock } from "../time";
import { visible } from "../visibility";
import { ActivityDeletedError, ActivityForbiddenError, ActivityLockedError, ActivityNotFoundError } from "./errors";
import { factsOf, liveLockOf, loadStored, lockActivity, LOCK_IDLE_MS, type LiveLock } from "./store";

export interface LockView {
  holderName: string;
  since: string;
  mine: true;
  tabId: string;
}

function lockedBy(l: LiveLock, rules: CalendarRules): ActivityLockedError {
  return new ActivityLockedError("locked", `${l.holderName} is editing this activity (since ${wallClock(l.acquiredAt, rules.timeZone).time})`, {
    displayName: l.holderName,
    since: l.acquiredAt.toISOString(),
  });
}

/**
 * Takes the lock, refreshes it (the editor's heartbeat), or with takeOver moves the caller's own
 * lock to this tab ("Continue here"). Never takes another user's live lock (spec addendum §7.5).
 */
export async function takeLock(deps: ApiDeps, actor: CalendarActor, id: number, tabId: string, takeOver: boolean): Promise<LockView> {
  return deps.db.transaction(async (tx) => {
    await lockActivity(tx, id);
    const s = await loadStored(tx, id, { forUpdate: true });
    if (!s || !visible(actor, factsOf(s))) throw new ActivityNotFoundError();
    if (s.row.deletedAt) throw new ActivityDeletedError();
    if (!can.edit(actor, factsOf(s))) throw new ActivityForbiddenError("You can't edit this activity");
    assertNotFrozen(await dbNow(tx, deps.now), actor, deps.rules);
    const live = await liveLockOf(tx, id, deps.now, { forUpdate: true });
    if (live && live.userId !== actor.userId) throw lockedBy(live, deps.rules);
    if (live && live.tabId !== tabId && !takeOver) {
      throw new ActivityLockedError("locked_elsewhere", "You're editing this activity in another tab", { displayName: live.holderName, since: live.acquiredAt.toISOString() });
    }
    const at = sqlNow(deps.now);
    if (live) {
      await tx.update(activityLocks).set({ tabId, lastActiveAt: at }).where(eq(activityLocks.activityId, id));
    } else {
      // No row, or a lapsed one the sweep hasn't reached yet.
      const fresh = { userId: actor.userId, tabId, acquiredAt: at, lastActiveAt: at };
      await tx.insert(activityLocks).values({ activityId: id, ...fresh }).onConflictDoUpdate({ target: activityLocks.activityId, set: fresh });
    }
    const [row] = await tx.select().from(activityLocks).where(eq(activityLocks.activityId, id));
    return { holderName: actor.displayName, since: row!.acquiredAt.toISOString(), mine: true, tabId };
  });
}

/** Only the holder's own tab releases: legacy's cancel deleted whoever's lock it found (C128). */
export async function releaseLock(deps: ApiDeps, actor: CalendarActor, id: number, tabId: string): Promise<void> {
  await deps.db.delete(activityLocks).where(and(eq(activityLocks.activityId, id), eq(activityLocks.userId, actor.userId), eq(activityLocks.tabId, tabId)));
}

/** Saving or deleting while someone else holds a live lock is refused (spec addendum §7.5). */
export async function assertNotLockedByOther(tx: Tx, deps: ApiDeps, actor: CalendarActor, id: number): Promise<void> {
  const live = await liveLockOf(tx, id, deps.now, { forUpdate: true });
  if (live && live.userId !== actor.userId) throw lockedBy(live, deps.rules);
}

/** A save releases the saver's lock, whichever tab holds it. */
export async function releaseOwnLocks(tx: Tx, userId: string, id: number): Promise<void> {
  await tx.delete(activityLocks).where(and(eq(activityLocks.activityId, id), eq(activityLocks.userId, userId)));
}

export async function clearLocks(tx: Tx, id: number): Promise<void> {
  await tx.delete(activityLocks).where(eq(activityLocks.activityId, id));
}

/** The tick's sweep: deletes every lock idle for 15 minutes or more. */
export async function sweepLocks(db: Db, clock?: TestClock): Promise<{ deleted: number }> {
  const r = await db.execute(sql`DELETE FROM ${activityLocks} WHERE ${activityLocks.lastActiveAt} <= ${sqlNow(clock)} - ${sql.raw(`interval '${LOCK_IDLE_MS / 60_000} minutes'`)}`);
  return { deleted: r.rowCount ?? 0 };
}
```

In `apps/calendar/src/http/activity-routes.ts`, add these imports and routes:

```ts
import { z } from "zod";
import { releaseLock, takeLock } from "../activities/locks";

const lockSchema = z.object({ tabId: z.string().min(1).max(100), takeOver: z.boolean().optional() }).strict();
const releaseSchema = z.object({ tabId: z.string().min(1).max(100) }).strict();
```

```ts
  r.put("/activities/:id/lock", run(async (req, res) => {
    const body = lockSchema.parse(req.body);
    res.json(await takeLock(deps, req.calendar!, idOf(req), body.tabId, body.takeOver ?? false));
  }));
  // The editor calls this on save, cancel and tab close (fetch with keepalive, which can send the CSRF header).
  r.post("/activities/:id/lock/release", run(async (req, res) => {
    await releaseLock(deps, req.calendar!, idOf(req), releaseSchema.parse(req.body).tabId);
    res.status(204).end();
  }));
```

`apps/calendar/src/start.ts`:
- Add `lockSweep: () => sweepLocks(db)` to `workers`.
- In `startLoops`, also start `const sweep = setInterval(() => void sweepLocks(db).catch((e) => console.error("[calendar] lock sweep failed", safeErrorLabel(e))), 60_000); sweep.unref();`.
- Add a closer `{ name: "lock sweep", close: async () => clearInterval(sweep) }`. Keep `sweep` in a `let` beside `stopDispatcher`, and import `safeErrorLabel` from `@gcpe/http-kit`.

`apps/stack/src/stack.ts`: after the `calendar.dispatch` entry, add:

```ts
        // Deletes edit locks idle for 15 minutes (spec addendum §7.5); a no-op most ticks.
        ...(calendar ? [{ name: "calendar.lock-sweep", run: worker(calendar, "lockSweep") }] : []),
```

- [ ] **Step 4: Run the tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar apps/stack/src/stack.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/calendar apps/stack/src/stack.ts apps/stack/src/stack.test.ts
git commit -m "feat(calendar): edit locks that lapse after 15 idle minutes, released only by their holder, swept by the tick"
```

---

### Task 8: Update. Version, lock, freeze, needs-review, Look Ahead and history

Covers:
- spec §7.1 Update:
  - the needs-review rules;
  - one `updated` change listing every changed field (C133).
- §7.2, the rules about changed values and imported data.
- §7.3, the rows that set nothing, through the API.
- §7.4, "checked when saving".
- §7.5:
  - 409 on a stale version;
  - 423 under another user's live lock;
  - a lapsed lock still saves;
  - the HQ Administrator "last updated" rule (C129).
- §7.6, the stored section.
- The §3 exit check ("version conflicts on every write path", update's share).
- Review Focus 1–3.
- Decisions F6, F8, F9, F14 and F20.

**Files:**
- Create: `apps/calendar/src/activities/update.ts`.
- Create: `apps/calendar/src/http/activity-update.test.ts`.
- Modify: `apps/calendar/src/activities/store.ts` (add `keywordNamesOf`), `src/activities/create.ts` (use it), `src/http/activity-routes.ts`, `test/world.ts` (add `insertRaw`, `historyOf`).

**Interfaces:**
- Consumes: everything from Tasks 4–7, including `reviewChanges`, `mergeNeedsReview`, `sectionToStore`, `assertNotLockedByOther` and `releaseOwnLocks`.
- Produces:
  - `updateActivity(deps, actor, id, input: UpdateActivityInput): Promise<{ warnings: string[] }>`;
  - `keywordNamesOf(db, ids): Promise<string[]>`;
  - `PUT /api/activities/:id` → `WriteResponse`;
  - test helpers `insertRaw(db, over?): Promise<number>` and `historyOf(db, id)`.

- [ ] **Step 1: Test helpers**

Append to `apps/calendar/test/world.ts`:

```ts
import { activities, activityChangeFields, activityChanges } from "../src/db/schema";

/** An activity as the importer will write it: whatever legacy held, rules or not. */
export async function insertRaw(db: Db, over: Partial<typeof activities.$inferInsert> = {}): Promise<number> {
  const [row] = await db
    .insert(activities)
    .values({
      title: "Sample imported", details: "Sample details", significance: "Sample significance", schedule: "Sample schedule",
      contactMinistryKey: "health", startAt: new Date("2026-11-10T17:00:00Z"), endAt: new Date("2026-11-10T18:00:00Z"),
      isConfirmed: true, status: "reviewed", hqSection: "in_the_news", ...over,
    })
    .returning({ id: activities.id });
  return row!.id;
}

export async function historyOf(db: Db, id: number) {
  const changes = await db.select().from(activityChanges).where(eq(activityChanges.activityId, id)).orderBy(asc(activityChanges.id));
  const fields = await db.select().from(activityChangeFields);
  return changes.map((c) => ({ action: c.action, actorName: c.actorName, fields: Object.fromEntries(fields.filter((f) => f.changeId === c.id).map((f) => [f.fieldKey, [f.oldValue, f.newValue]])) }));
}
```

(Merge the `activities` import with the existing schema import at the top of the file.)

- [ ] **Step 2: Write the failing tests**

`apps/calendar/src/http/activity-update.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import type { ActivityFields } from "@gcpe/calendar-contract";
import { createCalendarTestDb, createTestApp, FIXED_NOW, waitForLockWaiter } from "../../test/helpers";
import { call, historyOf, insertRaw, outboxOf, seedWorld, validInput, type World } from "../../test/world";
import { activities, commContacts, keywords } from "../db/schema";

describe("updating an activity (spec addendum §7.1, §7.5)", () => {
  let tdb: TestDatabase;
  let w: World;
  let clock = FIXED_NOW;
  let app: ReturnType<typeof createTestApp>;
  const make = async (over: Partial<ActivityFields> = {}, who: keyof World["as"] = "editor") => {
    const res = await call(app, "post", "/api/activities", w.as[who].cookie, validInput(w, over));
    expect(res.status).toBe(201);
    return res.body.activity as { id: number; version: number; fields: ActivityFields };
  };
  const save = (who: keyof World["as"], a: { id: number; version: number; fields: ActivityFields }, over: Partial<ActivityFields> = {}, tabId: string | null = null) =>
    call(app, "put", `/api/activities/${a.id}`, w.as[who].cookie, { ...a.fields, ...over, version: a.version, tabId });
  const row = async (id: number) => (await tdb.db.select().from(activities).where(eq(activities.id, id)))[0]!;

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db, { now: () => clock });
    w = await seedWorld(app, tdb.db);
  });
  afterAll(() => tdb.drop());

  it("a stale version is 409 with the reload message", async () => {
    const a = await make();
    expect((await save("editor", a, { title: "First" })).status).toBe(200);
    const stale = await save("editor", a, { title: "Second" });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ code: "version_conflict", error: "Someone else changed this activity — reload to see their changes" });
  });

  it("a double-clicked save: one 200, one 409, one history entry", async () => {
    const a = await make();
    const [x, y] = await Promise.all([save("editor", a, { title: "Clicked twice" }), save("editor", a, { title: "Clicked twice" })]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect((await historyOf(tdb.db, a.id)).filter((h) => h.action === "updated")).toHaveLength(1);
    expect((await outboxOf(tdb.db, a.id)).filter((e) => e.type === "activity.updated")).toHaveLength(1);
  });

  it("a save waits for a concurrent writer's lock, then sees its version", async () => {
    const a = await make();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const writer = tdb.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`calendar-activity:${a.id}`}))`);
      await tx.update(activities).set({ version: a.version + 1 }).where(eq(activities.id, a.id));
      await held;
    });
    const pending = save("editor", a, { title: "Late" }).then((r) => r);
    await waitForLockWaiter(tdb);
    release();
    await writer;
    expect((await pending).status).toBe(409);
  });

  it("another user's live lock refuses the save (423); once it lapses, the save goes through", async () => {
    clock = FIXED_NOW;
    const a = await make();
    expect((await call(app, "put", `/api/activities/${a.id}/lock`, w.as.admin.cookie, { tabId: "admin-tab" })).status).toBe(200);
    expect((await save("editor", a, { title: "Blocked" })).body).toMatchObject({ code: "locked", error: "Sample Admin is editing this activity (since 11:00)" });
    clock = new Date(FIXED_NOW.getTime() + 15 * 60_000);
    expect((await save("editor", a, { title: "After the lapse" })).status).toBe(200);
    clock = FIXED_NOW;
  });

  it("an idle editor's own lapsed lock doesn't stop the save, and saving releases the saver's lock", async () => {
    const a = await make();
    await call(app, "put", `/api/activities/${a.id}/lock`, w.as.editor.cookie, { tabId: "tab-a" });
    expect((await save("editor", a, { title: "Saved" }, "tab-a")).status).toBe(200);
    expect((await call(app, "get", `/api/activities/${a.id}`, w.as.editor.cookie)).body.lock).toBeNull();
  });

  it("an edit started before the freeze and saved during it is refused; at 17:00 it saves (spec addendum §7.4)", async () => {
    clock = new Date("2026-11-03T22:58:00Z"); // 15:58 BC
    const a = await make();
    await call(app, "put", `/api/activities/${a.id}/lock`, w.as.editor.cookie, { tabId: "tab-a" });
    clock = new Date("2026-11-03T23:01:00Z"); // 16:01 BC
    expect((await save("editor", a, { title: "Too late" }, "tab-a")).body).toMatchObject({ code: "freeze" });
    clock = new Date("2026-11-04T00:00:00Z"); // 17:00 BC
    expect((await save("editor", a, { title: "On time" }, "tab-a")).status).toBe(200);
    clock = FIXED_NOW;
  });

  it("the changes that set nothing leave flags and status alone (spec addendum §7.3)", async () => {
    const a = await make();
    const res = await save("hqEditor", a, {
      contactMinistryKey: "finance", commContactId: w.contact.financeEditor, nrDate: "2026-11-10", nrTime: "08:00", isAtLegislature: true,
      isMilestone: true, sectorKeys: ["sample-sector"], themeKeys: ["sample-theme"], tagKeys: ["sample-tag"], sharedWithKeys: ["health"],
      lookAhead: { hqComments: "Sample summary", hqStatus: "changed", hqSection: "events_and_speeches", longTermOutlook: true },
    });
    expect(res.status).toBe(200);
    expect(await row(a.id)).toMatchObject({ needsReview: [], status: "new" });
  });

  it("a flagged change raises its flag and sets status changed; a second one doesn't repeat a key", async () => {
    const a = await make();
    const once = await save("editor", a, { title: "Renamed" });
    await save("editor", once.body.activity, { title: "Renamed again", venue: "Sample hall" });
    expect(await row(a.id)).toMatchObject({ needsReview: ["title", "venue"], status: "changed" });
  });

  it("swapping one HQ tag for another raises tags (C130)", async () => {
    const a = await make({ keywordNames: ["sample tag", "Sample kept keyword"] });
    await save("editor", a, { keywordNames: ["sample tag", "Swapped in"] });
    expect((await row(a.id)).needsReview).toEqual(["tags"]);
  });

  it("a keyword typed in another case or with spaces reuses the existing one", async () => {
    const a = await make({ keywordNames: [" Sample Tag "] });
    const r = await tdb.db.select().from(keywords).where(sql`lower(${keywords.name}) = 'sample tag'`);
    expect(r).toHaveLength(1);
    expect(a.fields.keywordNames).toEqual(["sample tag"]);
    await save("editor", a, { keywordNames: ["SAMPLE TAG"] });
    expect((await row(a.id)).needsReview).toEqual([]);
  });

  it("an unchanged inactive comm contact is accepted; choosing one is refused", async () => {
    const a = await make();
    await tdb.db.update(commContacts).set({ isActive: false }).where(eq(commContacts.id, w.contact.editorHealth));
    expect((await save("editor", a, { details: "Still fine" })).status).toBe(200);
    const fresh = (await call(app, "get", `/api/activities/${a.id}`, w.as.editor.cookie)).body;
    const refused = await save("editor", fresh, { commContactId: w.contact.retiredHealth });
    expect(refused.status).toBe(422);
    expect(refused.body.errors).toContainEqual({ field: "commContactId", message: "That comm contact is no longer active" });
    await tdb.db.update(commContacts).set({ isActive: true }).where(eq(commContacts.id, w.contact.editorHealth));
  });

  it("an HQ Administrator's edit to another ministry's activity leaves 'last updated' alone but moves the version (C129)", async () => {
    const a = await make();
    const before = await row(a.id);
    clock = new Date(FIXED_NOW.getTime() + 60_000);
    const res = await save("hqAdmin", a, { title: "HQ edit" });
    clock = FIXED_NOW;
    expect(res.status).toBe(200);
    expect(await row(a.id)).toMatchObject({ version: 2, lastUpdatedAt: before.lastUpdatedAt, lastUpdatedBy: w.as.editor.id, needsReview: ["title"] });
    expect((await save("editor", a, { title: "Ministry edit" })).status).toBe(409);
  });

  it("limits apply to changed values: an imported over-long title saves unchanged and is refused once edited", async () => {
    const id = await insertRaw(tdb.db, { title: "x".repeat(150), commContactId: w.contact.editorHealth, cityId: w.city.sample });
    await tdb.db.execute(sql`INSERT INTO activity_categories (activity_id, category_id) VALUES (${id}, ${w.cat.plain})`);
    const a = (await call(app, "get", `/api/activities/${id}`, w.as.editor.cookie)).body;
    const ok = await save("editor", a, {});
    expect(ok.status).toBe(200);
    expect((await save("editor", ok.body.activity, { title: `${"x".repeat(150)}y` })).body.errors).toContainEqual({ field: "title", message: "At most 100 characters" });
  });

  it("an imported activity with no comm contact opens, and its next save must choose one (C147)", async () => {
    const id = await insertRaw(tdb.db, { commContactId: null });
    await tdb.db.execute(sql`INSERT INTO activity_categories (activity_id, category_id) VALUES (${id}, ${w.cat.plain})`);
    const a = (await call(app, "get", `/api/activities/${id}`, w.as.editor.cookie)).body;
    expect((await save("editor", a, {})).body.errors).toContainEqual({ field: "commContactId", message: "Choose a comm contact" });
  });

  it("an imported activity's second category stays while the editor's category is unchanged", async () => {
    const id = await insertRaw(tdb.db, { commContactId: w.contact.editorHealth });
    await tdb.db.execute(sql`INSERT INTO activity_categories (activity_id, category_id) VALUES (${id}, ${w.cat.plain}), (${id}, ${w.cat.speech})`);
    const a = (await call(app, "get", `/api/activities/${id}`, w.as.editor.cookie)).body;
    expect((await save("editor", a, { details: "Edited" })).status).toBe(200);
    expect((await row(id)).needsReview).toEqual(["details"]);
  });

  describe("the Look Ahead section (spec addendum §7.6)", () => {
    it("a ministry user's save re-infers it", async () => {
      const a = await make();
      expect((await row(a.id)).hqSection).toBe("in_the_news");
      await save("editor", a, { isIssue: true });
      expect((await row(a.id)).hqSection).toBe("issues_and_reports");
    });
    it("an HQ override survives a ministry user's save", async () => {
      const a = await make();
      expect((await save("hqEditor", a, { lookAhead: { hqComments: "**", hqStatus: null, hqSection: "events_and_speeches", longTermOutlook: false } })).status).toBe(200);
      // The ministry user's own view: it carries no Look Ahead fields to send back.
      const mine = (await call(app, "get", `/api/activities/${a.id}`, w.as.editor.cookie)).body;
      expect((await save("editor", mine, { isIssue: true })).status).toBe(200);
      expect((await row(a.id)).hqSection).toBe("events_and_speeches");
    });
    it("marking it Not for Look Ahead keeps its section", async () => {
      const a = await make();
      await save("editor", a, { isConfidential: true });
      expect((await row(a.id)).hqSection).toBe("in_the_news");
    });
  });

  it("refuses: a deleted activity (409), a shared-with ministry (403), an invisible one (404)", async () => {
    const shared = await make({ sharedWithKeys: ["finance"] });
    expect((await save("financeEditor", shared, { title: "Not mine" })).status).toBe(403);
    const secret = await make({ isConfidential: true });
    expect((await save("financeEditor", secret)).status).toBe(404);
    const gone = await make();
    await tdb.db.update(activities).set({ deletedAt: FIXED_NOW }).where(eq(activities.id, gone.id));
    expect((await save("hqAdmin", gone)).body).toMatchObject({ code: "deleted" });
    expect((await save("editor", gone)).status).toBe(404);
  });

  it("queues activity.updated; making it confidential sends only its id from then on", async () => {
    const a = await make();
    await save("editor", a, { isConfidential: true });
    const events = await outboxOf(tdb.db, a.id);
    expect(events.map((e) => e.type)).toEqual(["activity.created", "activity.updated"]);
    expect(events[1]!.data).toEqual({ id: a.id, isConfidential: true, isDeleted: false });
  });

  it("history lists each changed field with old and new values", async () => {
    const a = await make();
    await save("editor", a, { title: "New title", cityId: w.city.other, otherCity: "Sample Bay" });
    const updated = (await historyOf(tdb.db, a.id)).find((h) => h.action === "updated")!;
    expect(updated.fields).toEqual({ title: ["Sample activity", "New title"], city: ["Sample City", "Other..."], other_city: [null, "Sample Bay"] });
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/http/activity-update.test.ts`
Expected: FAIL. `PUT /api/activities/:id` is 404.

- [ ] **Step 4: Implement**

Add to `apps/calendar/src/activities/store.ts`:

```ts
export async function keywordNamesOf(db: DbOrTx, ids: readonly number[]): Promise<string[]> {
  if (ids.length === 0) return [];
  return (await db.select({ name: keywords.name }).from(keywords).where(inArray(keywords.id, [...ids])).orderBy(asc(keywords.name))).map((k) => k.name);
}
```

In `create.ts`, replace the inline keyword-name query with `const keywordNames = await keywordNamesOf(tx, joins.keywordIds);`, and drop the now-unused `inArray` and `keywords` imports.

`apps/calendar/src/activities/update.ts`:

```ts
import { eq } from "drizzle-orm";
import { checkActivity, inferLookAhead, LEVEL, sectionToStore, warningsFor, type UpdateActivityInput } from "@gcpe/calendar-contract";
import type { CalendarActor } from "../actor";
import { can } from "../capabilities";
import { activities } from "../db/schema";
import { assertNotFrozen } from "../freeze";
import type { ApiDeps } from "../http/routes";
import { lockLookup, LOOKUPS } from "../lookups";
import { dbNow, wallClock } from "../time";
import { visible } from "../visibility";
import { ActivityDeletedError, ActivityForbiddenError, ActivityNotFoundError, ActivityValidationError, VersionConflictError } from "./errors";
import { emitActivity } from "./events";
import { diffDisplay, displayOf, writeChange } from "./history";
import { assertNotLockedByOther, releaseOwnLocks } from "./locks";
import { createKeywords, resolveReferences } from "./resolve";
import { mergeNeedsReview, reviewChanges } from "./review-rules";
import {
  columnsOf, contentFrom, contentOf, factsOf, fieldsOf, keywordNamesOf, loadStored, lockActivity, lookAheadInputOf, lookAheadOf,
  replaceJoins, snapshotOf, uniqNum, type JoinIds, type LookAheadValues,
} from "./store";

/** Spec addendum §7.1 Update, under the activity's lock: checks, then one write, one history entry, one event. */
export async function updateActivity(deps: ApiDeps, actor: CalendarActor, id: number, input: UpdateActivityInput): Promise<{ warnings: string[] }> {
  const { version, tabId: _tabId, ...fields } = input;
  const { rules } = deps;
  return deps.db.transaction(async (tx) => {
    await lockActivity(tx, id);
    const s = await loadStored(tx, id, { forUpdate: true });
    if (!s || !visible(actor, factsOf(s))) throw new ActivityNotFoundError();
    if (s.row.deletedAt) throw new ActivityDeletedError();
    if (!can.edit(actor, factsOf(s))) throw new ActivityForbiddenError("Only the lead ministry and HQ edit this activity");
    const now = await dbNow(tx, deps.now);
    assertNotFrozen(now, actor, rules);
    await assertNotLockedByOther(tx, deps, actor, id);
    if (s.row.version !== version) throw new VersionConflictError();
    if (fields.keywordNames.length) await lockLookup(tx, LOOKUPS.keywords);

    const previous = fieldsOf(s, rules.timeZone);
    const refs = await resolveReferences(tx, fields, { actor, rules, previous: { stored: s, fields: previous } });
    const fieldset = can.seeLookAheadFieldset(actor, rules, factsOf(s));
    // An imported activity's second category, or several origins, stay while the editor's single choice is unchanged.
    const categoryIds = fields.categoryId === previous.categoryId ? s.joins.categoryIds : fields.categoryId === null ? [] : [fields.categoryId];
    const nrOriginIds = fields.nrOriginId === previous.nrOriginId ? s.joins.nrOriginIds : fields.nrOriginId === null ? [] : [fields.nrOriginId];
    const before = await lookAheadInputOf(tx, previous, s.joins.categoryIds, s.row.hqSection);
    const after = await lookAheadInputOf(tx, fields, categoryIds, s.row.hqSection);
    const inferred = inferLookAhead(after, rules);
    const errors = [
      ...checkActivity(fields, { rules, relaxRequired: can.relaxRequiredFields(actor), lookAheadFieldset: fieldset, previous, inferredSection: inferred.kind === "section" ? inferred.section : null }),
      ...refs.errors,
    ];
    if (errors.length) throw new ActivityValidationError(errors);

    const created = await createKeywords(tx, refs.keywordsToCreate);
    const joins: JoinIds = {
      categoryIds,
      commMaterialIds: uniqNum(fields.commMaterialIds),
      initiativeIds: uniqNum(fields.initiativeIds),
      keywordIds: uniqNum([...refs.keywordIds, ...created]),
      nrOriginIds,
      sectorKeys: fields.sectorKeys,
      themeKeys: fields.themeKeys,
      tagKeys: fields.tagKeys,
      sharedWithKeys: fields.sharedWithKeys,
    };
    const content = contentFrom(fields, rules);
    const oldContent = contentOf(s.row);
    const oldLookAhead = lookAheadOf(s.row);
    const la = fields.lookAhead;
    const lookAhead: LookAheadValues = fieldset
      ? la
        ? { hqComments: la.hqComments.trim(), hqStatus: la.hqStatus, hqSection: la.hqSection, longTermOutlook: la.longTermOutlook }
        : oldLookAhead
      : { ...oldLookAhead, hqSection: sectionToStore({ before, after, chosen: undefined }, rules) };
    const { flags, statusChanged } = reviewChanges(snapshotOf(oldContent, s.joins), snapshotOf(content, joins));
    // Legacy (Activity.aspx.cs:1246-1252): an HQ Administrator's edit to another ministry's activity leaves
    // "last updated" alone. The version still moves, so it can't be overwritten silently (C129).
    const keepLastUpdated = actor.isHq && actor.level >= LEVEL.administrator && !(s.row.contactMinistryKey !== null && actor.ministryKeys.includes(s.row.contactMinistryKey));
    await tx
      .update(activities)
      .set({
        ...columnsOf(content),
        hqComments: lookAhead.hqComments || null,
        hqStatus: lookAhead.hqStatus,
        hqSection: lookAhead.hqSection,
        longTermOutlook: lookAhead.longTermOutlook,
        needsReview: mergeNeedsReview(s.row.needsReview, flags),
        ...(statusChanged ? { status: "changed" as const } : {}),
        ...(keepLastUpdated ? {} : { lastUpdatedAt: now, lastUpdatedBy: actor.userId }),
        version: s.row.version + 1,
      })
      .where(eq(activities.id, id));
    await replaceJoins(tx, id, joins);

    const diff = diffDisplay(
      await displayOf(tx, oldContent, oldLookAhead, s.joins, s.keywordNames, rules),
      await displayOf(tx, content, lookAhead, joins, await keywordNamesOf(tx, joins.keywordIds), rules),
    );
    if (diff.length) await writeChange(tx, { activityId: id, actor, action: "updated", contactMinistryKey: content.contactMinistryKey, at: now, fields: diff });
    await releaseOwnLocks(tx, actor.userId, id);
    await emitActivity(tx, deps, id, "activity.updated");
    return { warnings: warningsFor(fields, wallClock(now, rules.timeZone).date) };
  });
}
```

In `apps/calendar/src/http/activity-routes.ts`, add:

```ts
import { updateActivitySchema } from "@gcpe/calendar-contract";
import { updateActivity } from "../activities/update";
```

```ts
  r.put("/activities/:id", run(async (req, res) => {
    const id = idOf(req);
    const out = await updateActivity(deps, req.calendar!, id, updateActivitySchema.parse(req.body));
    const body: WriteResponse = { activity: await readActivity(deps, req.calendar!, id), warnings: out.warnings };
    res.json(body);
  }));
```

- [ ] **Step 5: Run the tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/calendar
git commit -m "feat(calendar): activity update with versions, edit locks, the freeze, legacy's needs-review rules and field history"
```

---
### Task 9: Clone and delete

Covers:
- spec §7.1 Clone:
  - the copy, with `nr_at` cleared, `comments` empty and `**`;
  - News Subscribe dropped; only the kept keyword;
  - status `new`; C146; history naming the source.
- §7.1 Delete: `deleted_at`, the `active` flag and history.
- §6: Delete needs Administrator with edit rights; a deleted activity is visible to HQ Administrators only.
- §7.4 (both are frozen) and §7.5 (delete is refused under another user's live lock; versions).
- §5.4 `activity.deleted`.
- Acceptance 6 ("Cloning with a new keyword succeeds").
- The carry-forward item "a cloned activity's history records its source id".
- Decisions F7 and F18.

**Files:**
- Create: `apps/calendar/src/activities/clone.ts` and `delete.ts`.
- Create: `apps/calendar/src/http/activity-clone-delete.test.ts`.
- Modify: `apps/calendar/src/http/activity-routes.ts`.

**Interfaces:**
- Consumes: `loadStored`, `contentOf`, `insertActivity`, `replaceJoins`, `keywordNamesOf`, `displayOf`, `setFields`, `writeChange`, `emitActivity`, `emitActivityDeleted`, `assertNotLockedByOther`, `clearLocks` and `mergeNeedsReview`.
- Produces:
  - `cloneActivity(deps, actor, sourceId): Promise<{ id: number }>`;
  - `deleteActivity(deps, actor, id, version: number): Promise<void>`;
  - `POST /api/activities/:id/clone`, which answers 201 `WriteResponse`;
  - `DELETE /api/activities/:id` with `{ version }`, which answers 204.

- [ ] **Step 1: Write the failing tests**

`apps/calendar/src/http/activity-clone-delete.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import type { ActivityFields } from "@gcpe/calendar-contract";
import { createCalendarTestDb, createTestApp, FIXED_NOW } from "../../test/helpers";
import { call, historyOf, outboxOf, seedWorld, validInput, type World } from "../../test/world";
import { activities, activityLocks } from "../db/schema";

describe("clone and delete (spec addendum §7.1)", () => {
  let tdb: TestDatabase;
  let w: World;
  let clock = FIXED_NOW;
  let app: ReturnType<typeof createTestApp>;
  const make = async (over: Partial<ActivityFields> = {}, who: keyof World["as"] = "editor") =>
    (await call(app, "post", "/api/activities", w.as[who].cookie, validInput(w, over))).body.activity as { id: number; version: number; fields: ActivityFields };
  const row = async (id: number) => (await tdb.db.select().from(activities).where(eq(activities.id, id)))[0]!;

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db, { now: () => clock });
    w = await seedWorld(app, tdb.db);
  });
  afterAll(() => tdb.drop());

  describe("clone", () => {
    it("copies the activity: release time cleared, notes empty, **, tags dropped, only the kept keyword, status new", async () => {
      const src = await make({
        nrDate: "2026-11-10", nrTime: "08:00", comments: "Sample notes", tagKeys: ["sample-tag"], keywordNames: ["Sample kept keyword", "sample tag"],
        translations: ["Sample language A"], eventPlannerId: w.ids.planner, videographerId: w.ids.videographer, venue: "Sample hall", sharedWithKeys: ["finance"],
      });
      await call(app, "put", `/api/activities/${src.id}`, w.as.editor.cookie, { ...src.fields, title: "Changed source", version: src.version, tabId: null });
      const res = await call(app, "post", `/api/activities/${src.id}/clone`, w.as.editor.cookie, {});
      expect(res.status).toBe(201);
      const c = res.body.activity;
      expect(c.id).not.toBe(src.id);
      expect(c).toMatchObject({ version: 1, status: "new", needsReview: [] });
      expect(c.fields).toMatchObject({
        title: "Changed source", nrDate: null, nrTime: null, comments: "", tagKeys: [], keywordNames: ["Sample kept keyword"],
        translations: ["Sample language A"], eventPlannerId: w.ids.planner, videographerId: w.ids.videographer, venue: "Sample hall", sharedWithKeys: ["finance"],
      });
      expect(await row(c.id)).toMatchObject({ hqComments: "**", hqStatus: null, createdBy: w.as.editor.id });
      expect((await row(src.id)).version).toBe(2);
    });

    it("names the source in a cloned history entry, and queues activity.created", async () => {
      const src = await make();
      const id = (await call(app, "post", `/api/activities/${src.id}/clone`, w.as.editor.cookie, {})).body.activity.id as number;
      const [h] = await historyOf(tdb.db, id);
      expect(h).toMatchObject({ action: "cloned", fields: { cloned_from: [null, String(src.id)], title: [null, "Sample activity"] } });
      expect((await outboxOf(tdb.db, id))[0]!.type).toBe("activity.created");
    });

    it("cloning an activity saved with a brand-new keyword succeeds (C146)", async () => {
      const src = await make({ keywordNames: ["Brand new clone tag", "Sample kept keyword"] });
      expect((await call(app, "post", `/api/activities/${src.id}/clone`, w.as.editor.cookie, {})).status).toBe(201);
    });

    it("needs edit rights and is frozen for ministry users", async () => {
      const src = await make({ sharedWithKeys: ["finance"] });
      expect((await call(app, "post", `/api/activities/${src.id}/clone`, w.as.financeEditor.cookie, {})).status).toBe(403);
      expect((await call(app, "post", `/api/activities/${src.id}/clone`, w.as.readOnly.cookie, {})).status).toBe(403);
      const secret = await make({ isConfidential: true });
      expect((await call(app, "post", `/api/activities/${secret.id}/clone`, w.as.hqEditor.cookie, {})).status).toBe(404);
      clock = new Date("2026-11-03T23:30:00Z");
      expect((await call(app, "post", `/api/activities/${src.id}/clone`, w.as.editor.cookie, {})).body).toMatchObject({ code: "freeze" });
      expect((await call(app, "post", `/api/activities/${src.id}/clone`, w.as.hqEditor.cookie, {})).status).toBe(201);
      clock = FIXED_NOW;
    });

    it("refuses a body", async () => expect((await call(app, "post", `/api/activities/${(await make()).id}/clone`, w.as.editor.cookie, { title: "x" })).status).toBe(400));
  });

  describe("delete", () => {
    const del = (who: keyof World["as"], id: number, version: number) => call(app, "delete", `/api/activities/${id}`, w.as[who].cookie, { version });

    it("an Administrator with edit rights deletes: deleted_at, the active flag, history, activity.deleted, locks gone", async () => {
      const a = await make();
      await call(app, "put", `/api/activities/${a.id}/lock`, w.as.admin.cookie, { tabId: "admin-tab" });
      expect((await del("admin", a.id, a.version)).status).toBe(204);
      expect(await row(a.id)).toMatchObject({ deletedAt: FIXED_NOW, deletedBy: w.as.admin.id, needsReview: ["active"], version: 2, status: "new" });
      expect((await historyOf(tdb.db, a.id)).map((h) => h.action)).toEqual(["created", "deleted"]);
      const last = (await outboxOf(tdb.db, a.id)).at(-1)!;
      expect(last.type).toBe("activity.deleted");
      expect(last.data).toEqual({ id: a.id });
      expect(await tdb.db.select().from(activityLocks).where(eq(activityLocks.activityId, a.id))).toEqual([]);
    });

    it("afterwards only HQ Administrators see it (spec addendum §6)", async () => {
      const a = await make();
      await del("admin", a.id, a.version);
      expect((await call(app, "get", `/api/activities/${a.id}`, w.as.admin.cookie)).status).toBe(404);
      expect((await call(app, "get", `/api/activities/${a.id}`, w.as.hqAdvanced.cookie)).status).toBe(404);
      const seen = await call(app, "get", `/api/activities/${a.id}`, w.as.hqAdmin.cookie);
      expect(seen.body).toMatchObject({ isDeleted: true, can: { edit: false, delete: false, clone: false, review: true } });
      expect((await del("hqAdmin", a.id, 2)).body).toMatchObject({ code: "deleted" });
    });

    it("refuses an Editor (403), a stale version (409), someone else's live lock (423) and the freeze (423)", async () => {
      const a = await make();
      expect((await del("editor", a.id, a.version)).status).toBe(403);
      expect((await del("admin", a.id, a.version + 1)).body).toMatchObject({ code: "version_conflict" });
      await call(app, "put", `/api/activities/${a.id}/lock`, w.as.editor.cookie, { tabId: "tab-a" });
      expect((await del("admin", a.id, a.version)).body).toMatchObject({ code: "locked" });
      await call(app, "post", `/api/activities/${a.id}/lock/release`, w.as.editor.cookie, { tabId: "tab-a" });
      clock = new Date("2026-11-03T23:30:00Z");
      expect((await del("admin", a.id, a.version)).body).toMatchObject({ code: "freeze" });
      expect((await del("hqAdmin", a.id, a.version)).status).toBe(204);
      clock = FIXED_NOW;
    });

    it("a malformed body is 400", async () => {
      const a = await make();
      expect((await call(app, "delete", `/api/activities/${a.id}`, w.as.admin.cookie, {})).status).toBe(400);
    });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/http/activity-clone-delete.test.ts`
Expected: FAIL. The routes are 404.

- [ ] **Step 3: Implement**

`apps/calendar/src/activities/clone.ts`:

```ts
import { and, inArray, sql } from "drizzle-orm";
import type { CalendarActor } from "../actor";
import { can } from "../capabilities";
import { keywords } from "../db/schema";
import { assertNotFrozen } from "../freeze";
import type { ApiDeps } from "../http/routes";
import { dbNow } from "../time";
import { visible } from "../visibility";
import { ActivityDeletedError, ActivityForbiddenError, ActivityNotFoundError } from "./errors";
import { emitActivity } from "./events";
import { displayOf, setFields, writeChange } from "./history";
import { contentOf, factsOf, insertActivity, keywordNamesOf, loadStored, replaceJoins, type LookAheadValues } from "./store";

/**
 * Spec addendum §7.1 Clone (ActivityWebService.cs:72-140), from the stored activity: NR date cleared,
 * internal notes emptied, Executive Summary **, News Subscribe dropped, only the tenant's kept keywords,
 * status new. Event planner, Digital and Translations are copied too, which legacy's fixed list missed.
 */
export async function cloneActivity(deps: ApiDeps, actor: CalendarActor, sourceId: number): Promise<{ id: number }> {
  return deps.db.transaction(async (tx) => {
    const s = await loadStored(tx, sourceId);
    if (!s || !visible(actor, factsOf(s))) throw new ActivityNotFoundError();
    if (s.row.deletedAt) throw new ActivityDeletedError();
    if (!can.clone(actor, factsOf(s))) throw new ActivityForbiddenError("Only the lead ministry and HQ clone this activity");
    const now = await dbNow(tx, deps.now);
    assertNotFrozen(now, actor, deps.rules);

    const content = { ...contentOf(s.row), nrAt: null, comments: "" };
    const lookAhead: LookAheadValues = { hqComments: "**", hqStatus: null, hqSection: s.row.hqSection, longTermOutlook: s.row.longTermOutlook };
    const kept = deps.rules.cloneKeptKeywordNames.map((k) => k.toLowerCase());
    const keptIds =
      s.joins.keywordIds.length && kept.length
        ? (await tx.select({ id: keywords.id }).from(keywords).where(and(inArray(keywords.id, s.joins.keywordIds), inArray(sql`lower(${keywords.name})`, kept)))).map((k) => k.id)
        : [];
    const joins = { ...s.joins, keywordIds: keptIds, tagKeys: [] };
    const id = await insertActivity(tx, { content, lookAhead, actorId: actor.userId, at: now });
    await replaceJoins(tx, id, joins);
    const display = await displayOf(tx, content, lookAhead, joins, await keywordNamesOf(tx, keptIds), deps.rules);
    await writeChange(tx, {
      activityId: id, actor, action: "cloned", contactMinistryKey: content.contactMinistryKey, at: now,
      fields: [{ key: "cloned_from", old: null, new: String(sourceId) }, ...setFields(display)],
    });
    await emitActivity(tx, deps, id, "activity.created");
    return { id };
  });
}
```

`apps/calendar/src/activities/delete.ts`:

```ts
import { eq } from "drizzle-orm";
import type { CalendarActor } from "../actor";
import { can } from "../capabilities";
import { activities } from "../db/schema";
import { assertNotFrozen } from "../freeze";
import type { ApiDeps } from "../http/routes";
import { dbNow } from "../time";
import { visible } from "../visibility";
import { ActivityDeletedError, ActivityForbiddenError, ActivityNotFoundError, VersionConflictError } from "./errors";
import { emitActivityDeleted } from "./events";
import { writeChange } from "./history";
import { assertNotLockedByOther, clearLocks } from "./locks";
import { mergeNeedsReview } from "./review-rules";
import { factsOf, loadStored, lockActivity } from "./store";

/** Spec addendum §7.1 Delete (ActivityManager.cs:77-92): deleted_at and the `active` flag, for HQ to review. */
export async function deleteActivity(deps: ApiDeps, actor: CalendarActor, id: number, version: number): Promise<void> {
  await deps.db.transaction(async (tx) => {
    await lockActivity(tx, id);
    const s = await loadStored(tx, id, { forUpdate: true });
    if (!s || !visible(actor, factsOf(s))) throw new ActivityNotFoundError();
    if (s.row.deletedAt) throw new ActivityDeletedError();
    if (!can.delete(actor, factsOf(s))) throw new ActivityForbiddenError("Administrators of the lead ministry, and HQ Administrators, delete activities");
    const now = await dbNow(tx, deps.now);
    assertNotFrozen(now, actor, deps.rules);
    await assertNotLockedByOther(tx, deps, actor, id);
    if (s.row.version !== version) throw new VersionConflictError();
    await tx
      .update(activities)
      .set({ deletedAt: now, deletedBy: actor.userId, needsReview: mergeNeedsReview(s.row.needsReview, ["active"]), version: s.row.version + 1 })
      .where(eq(activities.id, id));
    await clearLocks(tx, id);
    await writeChange(tx, { activityId: id, actor, action: "deleted", contactMinistryKey: s.row.contactMinistryKey, at: now, fields: [] });
    await emitActivityDeleted(tx, deps, id);
  });
}
```

In `apps/calendar/src/http/activity-routes.ts`, add:

```ts
import { cloneActivity } from "../activities/clone";
import { deleteActivity } from "../activities/delete";

const emptySchema = z.object({}).strict();
const versionSchema = z.object({ version: z.number().int().positive() }).strict();
```

```ts
  r.post("/activities/:id/clone", run(async (req, res) => {
    emptySchema.parse(req.body ?? {});
    const out = await cloneActivity(deps, req.calendar!, idOf(req));
    const body: WriteResponse = { activity: await readActivity(deps, req.calendar!, out.id), warnings: [] };
    res.status(201).json(body);
  }));
  r.delete("/activities/:id", run(async (req, res) => {
    await deleteActivity(deps, req.calendar!, idOf(req), versionSchema.parse(req.body).version);
    res.status(204).end();
  }));
```

- [ ] **Step 4: Run the tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/calendar
git commit -m "feat(calendar): clone from the stored activity (history names its source) and delete for HQ review"
```

---

### Task 10: Review, review selected, and Clear LA Status

Covers:
- spec §7.1:
  - Review: version-checked; a live activity is set to `reviewed` with 22 flags cleared; a deleted one has only `active` cleared;
  - Review selected: rows changed since the list loaded are skipped and reported;
  - Clear LA Status;
  - history for each.
- §6: Review needs HQ Advanced, Review selected needs HQ Administrator, Clear LA Status needs HQ Editor (C139).
- §7.5: bulk actions ignore locks and bump versions.
- Acceptance 5 ("HQ Review clears them. Review on a deleted activity clears only `active`") and acceptance 12's server refusals.
- The §3 exit check ("review-selected skipping changed rows").
- Decisions F14, F15 and F16.

**Files:**
- Create: `apps/calendar/src/activities/review.ts` and `bulk.ts`.
- Create: `apps/calendar/src/http/activity-review.test.ts`.
- Modify: `apps/calendar/src/http/activity-routes.ts`.

**Interfaces:**
- Consumes: `REVIEW_CLEARED_KEYS`, `visibleSql`, `bcMidnight`, `addDays`, `wallClock`, `writeChange` and `emitActivity`.
- Produces:
  - **Review:**
    - `reviewActivity(deps, actor, id, version): Promise<void>`;
    - `applyReview(tx, deps, actor, s, now): Promise<void>`. Review selected uses it too.
  - **Bulk:**
    - `BATCH_SIZE = 100`;
    - `reviewSelected(deps, actor, items: { id: number; version: number }[]): Promise<{ reviewed: number[]; skipped: { id: number; reason: "changed" | "not_found" }[] }>`;
    - `clearLaStatus(deps, actor, days: number): Promise<{ cleared: number }>`.
  - **Routes:**
    - `POST /api/activities/:id/review` with `{ version }`, which answers `ActivityView`;
    - `POST /api/activities/review-selected` with `{ items }`;
    - `POST /api/activities/clear-la-status` with `{ days }`.

- [ ] **Step 1: Write the failing tests**

`apps/calendar/src/http/activity-review.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import type { ActivityFields } from "@gcpe/calendar-contract";
import { createCalendarTestDb, createTestApp, FIXED_NOW } from "../../test/helpers";
import { call, historyOf, insertRaw, outboxOf, seedWorld, validInput, type World } from "../../test/world";
import { activities } from "../db/schema";

describe("review, review selected and Clear LA Status (spec addendum §7.1)", () => {
  let tdb: TestDatabase;
  let w: World;
  let app: ReturnType<typeof createTestApp>;
  const make = async (over: Partial<ActivityFields> = {}) => (await call(app, "post", "/api/activities", w.as.editor.cookie, validInput(w, over))).body.activity as { id: number; version: number; fields: ActivityFields };
  const row = async (id: number) => (await tdb.db.select().from(activities).where(eq(activities.id, id)))[0]!;
  const changed = async () => {
    const a = await make();
    const res = await call(app, "put", `/api/activities/${a.id}`, w.as.editor.cookie, { ...a.fields, title: "Changed", venue: "Sample hall", version: a.version, tabId: null });
    return res.body.activity as { id: number; version: number };
  };

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    w = await seedWorld(app, tdb.db);
  });
  afterAll(() => tdb.drop());

  describe("Review", () => {
    const review = (who: keyof World["as"], id: number, version: number) => call(app, "post", `/api/activities/${id}/review`, w.as[who].cookie, { version });

    it("HQ Advanced reviews: status reviewed, flags cleared, version bumped, history and an event (acceptance 5)", async () => {
      const a = await changed();
      expect(await row(a.id)).toMatchObject({ status: "changed", needsReview: ["title", "venue"] });
      const res = await review("hqAdvanced", a.id, a.version);
      expect(res.status).toBe(200);
      expect(await row(a.id)).toMatchObject({ status: "reviewed", needsReview: [], version: a.version + 1 });
      expect((await historyOf(tdb.db, a.id)).at(-1)).toMatchObject({ action: "reviewed", actorName: "Sample HQ Advanced", fields: { status: ["Changed", "Reviewed"] } });
      expect((await outboxOf(tdb.db, a.id)).at(-1)!.type).toBe("activity.updated");
    });

    it("on a deleted activity, an HQ Administrator's Review clears only the active flag", async () => {
      const id = await insertRaw(tdb.db, { deletedAt: FIXED_NOW, needsReview: ["title", "active"], status: "changed", version: 4 });
      expect((await review("hqAdmin", id, 4)).status).toBe(200);
      expect(await row(id)).toMatchObject({ needsReview: ["title"], status: "changed", version: 5 });
    });

    it("is refused below HQ Advanced, on a stale version, and on what the reviewer can't see", async () => {
      const a = await changed();
      expect((await review("hqEditor", a.id, a.version)).status).toBe(403);
      expect((await review("admin", a.id, a.version)).status).toBe(403);
      expect((await review("hqAdvanced", a.id, a.version - 1)).body).toMatchObject({ code: "version_conflict" });
      const gone = await insertRaw(tdb.db, { deletedAt: FIXED_NOW, needsReview: ["active"] });
      expect((await review("hqAdvanced", gone, 1)).status).toBe(404);
    });

    it("ignores edit locks, and the open editor's next save gets 409 (spec addendum §7.5)", async () => {
      const a = await changed();
      await call(app, "put", `/api/activities/${a.id}/lock`, w.as.editor.cookie, { tabId: "tab-a" });
      expect((await review("hqAdvanced", a.id, a.version)).status).toBe(200);
      const fields = (await call(app, "get", `/api/activities/${a.id}`, w.as.editor.cookie)).body.fields;
      expect((await call(app, "put", `/api/activities/${a.id}`, w.as.editor.cookie, { ...fields, version: a.version, tabId: "tab-a" })).body).toMatchObject({ code: "version_conflict" });
    });
  });

  describe("Review selected", () => {
    const reviewSelected = (who: keyof World["as"], items: { id: number; version: number }[]) => call(app, "post", "/api/activities/review-selected", w.as[who].cookie, { items });

    it("reviews the rows unchanged since the list loaded and reports the rest (ActivityHandler.ashx.cs:177-193)", async () => {
      const fresh = await changed();
      const moved = await changed();
      await call(app, "post", `/api/activities/${moved.id}/review`, w.as.hqAdvanced.cookie, { version: moved.version });
      const res = await reviewSelected("hqAdmin", [{ id: moved.id, version: moved.version }, { id: fresh.id, version: fresh.version }, { id: 99_999_999, version: 1 }]);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ reviewed: [fresh.id], skipped: [{ id: moved.id, reason: "changed" }, { id: 99_999_999, reason: "not_found" }] });
      expect((await row(fresh.id)).status).toBe("reviewed");
    });

    it("an activity deleted after the list loaded is skipped as changed", async () => {
      const a = await changed();
      await call(app, "delete", `/api/activities/${a.id}`, w.as.admin.cookie, { version: a.version });
      expect((await reviewSelected("hqAdmin", [{ id: a.id, version: a.version }])).body.skipped).toEqual([{ id: a.id, reason: "changed" }]);
    });

    it("works across batches: 150 rows in one request", async () => {
      const ids: number[] = [];
      for (let n = 0; n < 150; n++) ids.push(await insertRaw(tdb.db, { status: "changed", needsReview: ["title"] }));
      const res = await reviewSelected("hqAdmin", ids.map((id) => ({ id, version: 1 })));
      expect(res.body.reviewed).toHaveLength(150);
      const rows = await tdb.db.select({ status: activities.status }).from(activities).where(inArray(activities.id, ids));
      expect(rows.every((r) => r.status === "reviewed")).toBe(true);
    });

    it("needs HQ Administrator (C139), takes at most 500 items, each once", async () => {
      const a = await changed();
      expect((await reviewSelected("hqAdvanced", [{ id: a.id, version: a.version }])).status).toBe(403);
      expect((await reviewSelected("admin", [{ id: a.id, version: a.version }])).status).toBe(403);
      expect((await reviewSelected("hqAdmin", Array.from({ length: 501 }, (_, n) => ({ id: n + 1, version: 1 })))).status).toBe(400);
      expect((await reviewSelected("hqAdmin", [{ id: a.id, version: 1 }, { id: a.id, version: 1 }])).status).toBe(400);
    });
  });

  describe("Clear LA Status", () => {
    const clear = (who: keyof World["as"], days: number) => call(app, "post", "/api/activities/clear-la-status", w.as[who].cookie, { days });

    it("clears every visible activity starting by 00:00 BC on today + N days, past ones too (ActivityHandler.ashx.cs:1258-1274)", async () => {
      // FIXED_NOW is 2026-11-03 in BC; 3 days → the cutoff is 2026-11-06 00:00 BC (07:00Z).
      const past = await insertRaw(tdb.db, { hqStatus: "new", startAt: new Date("2026-10-01T17:00:00Z") });
      const atCutoff = await insertRaw(tdb.db, { hqStatus: "changed", startAt: new Date("2026-11-06T07:00:00Z") });
      const after = await insertRaw(tdb.db, { hqStatus: "new", startAt: new Date("2026-11-06T07:01:00Z") });
      const hidden = await insertRaw(tdb.db, { hqStatus: "new", startAt: new Date("2026-11-04T17:00:00Z"), contactMinistryKey: "finance", isConfidential: true });
      const res = await clear("hqEditor", 3);
      expect(res.status).toBe(200);
      expect(res.body.cleared).toBeGreaterThanOrEqual(2);
      expect((await row(past)).hqStatus).toBeNull();
      expect(await row(atCutoff)).toMatchObject({ hqStatus: null, version: 2 });
      expect((await row(after)).hqStatus).toBe("new");
      expect((await row(hidden)).hqStatus).toBe("new");
      expect((await historyOf(tdb.db, atCutoff)).at(-1)).toMatchObject({ action: "la_status_cleared", fields: { hq_status: ["Changed", null] } });
    });

    it("needs HQ Editor (C139) and 0 to 366 days", async () => {
      expect((await clear("admin", 3)).status).toBe(403);
      expect((await clear("hqReadOnly", 3)).status).toBe(403);
      expect((await clear("hqEditor", 367)).status).toBe(400);
      expect((await clear("hqEditor", -1)).status).toBe(400);
    });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/http/activity-review.test.ts`
Expected: FAIL. The routes are 404.

- [ ] **Step 3: Implement**

`apps/calendar/src/activities/review.ts`:

```ts
import { eq } from "drizzle-orm";
import type { Tx } from "@gcpe/db-kit";
import type { ActivityStatus } from "@gcpe/calendar-contract";
import type { CalendarActor } from "../actor";
import { can } from "../capabilities";
import { activities } from "../db/schema";
import type { ApiDeps } from "../http/routes";
import { dbNow } from "../time";
import { visible } from "../visibility";
import { ActivityForbiddenError, ActivityNotFoundError, VersionConflictError } from "./errors";
import { emitActivity } from "./events";
import { writeChange } from "./history";
import { REVIEW_CLEARED_KEYS } from "./review-rules";
import { factsOf, loadStored, lockActivity, type StoredActivity } from "./store";

const STATUS_LABEL: Record<ActivityStatus, string> = { new: "New", changed: "Changed", reviewed: "Reviewed" };

/**
 * HQ's review (ActivityManager.cs:21-75): a live activity becomes `reviewed` with every flag but
 * `active` cleared; a deleted one only has `active` cleared. The caller holds the activity's lock.
 */
export async function applyReview(tx: Tx, deps: ApiDeps, actor: CalendarActor, s: StoredActivity, now: Date): Promise<void> {
  const deleted = s.row.deletedAt !== null;
  const needsReview = deleted ? s.row.needsReview.filter((k) => k !== "active") : s.row.needsReview.filter((k) => !REVIEW_CLEARED_KEYS.includes(k));
  const status: ActivityStatus = deleted ? s.row.status : "reviewed";
  await tx.update(activities).set({ needsReview, status, version: s.row.version + 1 }).where(eq(activities.id, s.row.id));
  await writeChange(tx, {
    activityId: s.row.id, actor, action: "reviewed", contactMinistryKey: s.row.contactMinistryKey, at: now,
    fields: s.row.status === status ? [] : [{ key: "status", old: STATUS_LABEL[s.row.status], new: STATUS_LABEL[status] }],
  });
  await emitActivity(tx, deps, s.row.id, "activity.updated");
}

/** Review from the activity page: HQ Advanced and above, version-checked; it ignores edit locks. */
export async function reviewActivity(deps: ApiDeps, actor: CalendarActor, id: number, version: number): Promise<void> {
  await deps.db.transaction(async (tx) => {
    await lockActivity(tx, id);
    const s = await loadStored(tx, id, { forUpdate: true });
    if (!s || !visible(actor, factsOf(s))) throw new ActivityNotFoundError();
    if (!can.review(actor, factsOf(s))) throw new ActivityForbiddenError("HQ reviews activities");
    if (s.row.version !== version) throw new VersionConflictError();
    await applyReview(tx, deps, actor, s, await dbNow(tx, deps.now));
  });
}
```

`apps/calendar/src/activities/bulk.ts`:

```ts
import { and, asc, eq, isNotNull, lte } from "drizzle-orm";
import type { CalendarActor } from "../actor";
import { can } from "../capabilities";
import { activities } from "../db/schema";
import type { ApiDeps } from "../http/routes";
import { addDays, bcMidnight, dbNow, wallClock } from "../time";
import { visible, visibleSql } from "../visibility";
import { ActivityForbiddenError } from "./errors";
import { emitActivity } from "./events";
import { writeChange } from "./history";
import { applyReview } from "./review";
import { factsOf, loadStored, lockActivity } from "./store";

/** Activities per transaction: each holds an advisory lock until commit, and Postgres's shared lock table is finite. */
export const BATCH_SIZE = 100;

async function inBatches<T>(items: readonly T[], fn: (batch: readonly T[]) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += BATCH_SIZE) await fn(items.slice(i, i + BATCH_SIZE));
}

/** The list's Review selected (spec addendum §7.1): rows changed since the list loaded are skipped and reported. */
export async function reviewSelected(
  deps: ApiDeps,
  actor: CalendarActor,
  items: { id: number; version: number }[],
): Promise<{ reviewed: number[]; skipped: { id: number; reason: "changed" | "not_found" }[] }> {
  if (!can.reviewSelected(actor)) throw new ActivityForbiddenError("HQ Administrators review selected activities");
  const reviewed: number[] = [];
  const skipped: { id: number; reason: "changed" | "not_found" }[] = [];
  // Ascending ids: two bulk actions over overlapping rows lock them in the same order.
  const sorted = [...items].sort((a, b) => a.id - b.id);
  await inBatches(sorted, (batch) =>
    deps.db.transaction(async (tx) => {
      const now = await dbNow(tx, deps.now);
      for (const item of batch) {
        await lockActivity(tx, item.id);
        const s = await loadStored(tx, item.id, { forUpdate: true });
        if (!s || !visible(actor, factsOf(s))) skipped.push({ id: item.id, reason: "not_found" });
        else if (s.row.version !== item.version) skipped.push({ id: item.id, reason: "changed" });
        else {
          await applyReview(tx, deps, actor, s, now);
          reviewed.push(item.id);
        }
      }
    }),
  );
  const order = new Map(items.map((it, n) => [it.id, n]));
  skipped.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return { reviewed, skipped };
}

/**
 * Clears the LA status of every activity the caller can see that starts by 00:00 BC on today + N
 * days, past ones included, as legacy (ActivityHandler.ashx.cs:1258-1274). One history entry each.
 */
export async function clearLaStatus(deps: ApiDeps, actor: CalendarActor, days: number): Promise<{ cleared: number }> {
  if (!can.clearLaStatus(actor)) throw new ActivityForbiddenError("HQ clears the LA status");
  const now = await dbNow(deps.db, deps.now);
  const cutoff = bcMidnight(addDays(wallClock(now, deps.rules.timeZone).date, days), deps.rules.timeZone);
  const candidates = await deps.db
    .select({ id: activities.id })
    .from(activities)
    .where(and(visibleSql(actor), isNotNull(activities.hqStatus), lte(activities.startAt, cutoff)))
    .orderBy(asc(activities.id));
  let cleared = 0;
  await inBatches(candidates.map((c) => c.id), (batch) =>
    deps.db.transaction(async (tx) => {
      for (const id of batch) {
        await lockActivity(tx, id);
        const s = await loadStored(tx, id, { forUpdate: true });
        // Re-check under the lock: someone may have changed it since the candidates were read.
        if (!s || !visible(actor, factsOf(s)) || s.row.hqStatus === null || !s.row.startAt || s.row.startAt > cutoff) continue;
        await tx.update(activities).set({ hqStatus: null, version: s.row.version + 1 }).where(eq(activities.id, id));
        await writeChange(tx, {
          activityId: id, actor, action: "la_status_cleared", contactMinistryKey: s.row.contactMinistryKey, at: now,
          fields: [{ key: "hq_status", old: s.row.hqStatus === "new" ? "New" : "Changed", new: null }],
        });
        await emitActivity(tx, deps, id, "activity.updated");
        cleared++;
      }
    }),
  );
  return { cleared };
}
```

In `apps/calendar/src/http/activity-routes.ts`, add the imports and schemas:

```ts
import { clearLaStatus, reviewSelected } from "../activities/bulk";
import { reviewActivity } from "../activities/review";

const reviewSelectedSchema = z
  .object({ items: z.array(z.object({ id: z.number().int().positive(), version: z.number().int().positive() }).strict()).min(1).max(500) })
  .strict()
  .refine((b) => new Set(b.items.map((i) => i.id)).size === b.items.length, "each activity once");
const clearLaSchema = z.object({ days: z.number().int().min(0).max(366) }).strict();
```

Register these two before every `/activities/:id…` route:

```ts
  r.post("/activities/review-selected", run(async (req, res) => void res.json(await reviewSelected(deps, req.calendar!, reviewSelectedSchema.parse(req.body).items))));
  r.post("/activities/clear-la-status", run(async (req, res) => void res.json(await clearLaStatus(deps, req.calendar!, clearLaSchema.parse(req.body).days))));
```

And with the others:

```ts
  r.post("/activities/:id/review", run(async (req, res) => {
    const id = idOf(req);
    await reviewActivity(deps, req.calendar!, id, versionSchema.parse(req.body).version);
    res.json(await readActivity(deps, req.calendar!, id));
  }));
```

- [ ] **Step 4: Run the tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/calendar
git commit -m "feat(calendar): HQ review, review selected (skipping rows changed since loading) and Clear LA Status, server-checked (C139)"
```

---

### Task 11: Parity, running notes, runbook, carry-forward, verification and deploy

Covers: the 5c-1 exit, spec §3 ("each sub-plan exits when its check passes, its parity rows and questions are updated, and its running-notes lines are written"), §14 and the boxs.ca deploy.

**Files:**
- Modify: `docs/parity/changes-from-legacy.md`, `docs/parity/open-questions.md`, `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`, `docs/superpowers/plans/phase-5-carry-forward.md`.

**Interfaces:** docs only.

- [ ] **Step 1: Parity rows**

`docs/parity/changes-from-legacy.md`, "Corporate Calendar (Phase 5)". Mark C126–C130, C133, C139, C145–C147 and C156 "Built in 5c-1" in their Status cells (keep "Agreed"). Then add:

```markdown
| C167 | Clone copied a fixed list of fields that left out Event planner, Digital and Translations (`ActivityWebService.cs:72-140`), and copied from the open page. | Clone copies the saved activity, Event planner, Digital and Translations included, with legacy's changes: NR date cleared, internal notes emptied, Executive Summary `**`, News Subscribe dropped, only the "30-60-90" HQ tag kept, status New. Its history names the activity it came from. | Dropping Translations on clone is the same loss C145 fixes on create; a clone of an unsaved page would copy edits nobody saved. | Proposed |
| C168 | The Look Ahead section was inferred in the browser (`Activity.aspx:2466-2521`), and for users without the Look Ahead fieldset the hidden field was posted as inferred. | The server stores the section on every save, by legacy's own rules: a confidential activity keeps the section it has (a new one is Not on LA); a section HQ overrode stays through a ministry user's save; Awareness and the consultations ministry keep theirs. | One rule on the server, which a direct API call can't bypass (C156); the same Look Ahead rows as legacy, so the 5i parity check compares like with like. | Proposed |
| C169 | An edit lock's release came from the closing page; anyone's cancel deleted the latest lock row. | A lock is released only by its holder's own tab: on save, cancel, tab close (a keep-alive request) or after 15 idle minutes. Review, Review selected, Clear LA Status and Clone ignore locks; every write bumps the version. | Spec addendum §7.5; a bulk action shouldn't wait on an open editor, whose next save then gets "reload". | Agreed (spec §7.5) |
```

`docs/parity/open-questions.md`: add nothing new. To Q51's row, append: "5c-1 reads these from the tenant's `calendar` section (`config/tenants/bc.json`); changing one is a config edit."

- [ ] **Step 2: Running notes**

`docs/manuals/running-notes.md`, append:

```markdown
## Phase 5c-1 — Activity rules and the activity API

- **Editor** — Between 4pm and 5pm BC time nobody outside HQ can create, change, clone or delete
  activities, or start editing one. A save begun at 3:58 and sent at 4:01 is refused with the same
  message; try again at 5pm. HQ users at Editor and above aren't affected.
- **Editor** — If someone else is editing an activity, it shows "<name> is editing this activity (since
  hh:mm)" and can't be saved until they finish or have been idle for 15 minutes.
- **Editor** — "Someone else changed this activity — reload to see their changes" means another save,
  a review or a Clear LA Status happened since you opened it. Reload, then make your change again.
- **Editor** — Every change is recorded with who made it and the old and new values. A clone's history
  starts with the activity it was cloned from.
- **HQ** — Review clears every needs-review flag and marks the activity Reviewed. On a deleted
  activity it clears only the "deleted" flag. Review selected skips rows changed since the list
  loaded and says which.
- **HQ** — Clear LA Status clears the LA status of every activity you can see that starts on or
  before the chosen number of days from today, past ones included.
- **Administrator** — Deleting an activity hides it from everyone except HQ Administrators, who
  review the deletion.
- **Operations** — The Calendar's settings (freeze window, release categories, Other city, the
  Translations list, required fields) are in the tenant file's `calendar` section.
- **Operations** — The Calendar sends `activity.*` events to NRMS from now on; NRMS ignores them until
  phase 5h. They never go to the public News API.
```

- [ ] **Step 3: Runbook**

`docs/deploy/siteground.md`, under "Corporate Calendar", add `### Activity API (Phase 5c-1)`:
- **No migration.** The Calendar refuses to start if the tenant file has no `calendar` section. `config/tenants/bc.json` carries it, and the artifact ships it.
- **New tick step:** `calendar.lock-sweep`.
- **New route:** Calendar → NRMS for `activity.*`. NRMS records these events as `ignored` until 5h.
- **Hand checks on boxs.ca**, through the API. The screens are 5d and 5e. Use `curl` with a session cookie from `POST /core/auth/login` and the `X-GCPE-Request: 1` header:
  1. As cal-editor, `POST /calendar/api/activities` needs lookups to exist. As cal-sysadmin, first add a "Sample category" and a "Sample City" on Hub → Calendar → Lookups. Set cal-editor's comm-contact rank for Health on the users screen; that creates the comm contact. The create answers 201.
  2. Between 16:00 and 17:00 BC, the same create answers 423 with "You cannot make content changes between 4pm-5pm." As cal-hq-admin it answers 201.
  3. `PUT /calendar/api/activities/<id>/lock` as cal-editor, then as cal-admin: the second answers 423 "… is editing this activity".
  4. `GET /calendar/api/activities/<id>/changes` lists the `created` entry.
  5. After one tick, NRMS's `inbox_events` has an `ignored` row of type `activity.created` from source `calendar`, and the News API's has none.

- [ ] **Step 4: Carry-forward**

In `docs/superpowers/plans/phase-5-carry-forward.md` § 5c:
- **Delete** "Lock-expiry sweep", "Tenant `calendar` config section", "A cloned activity's history must record its source id" and "`needs_review` writers must de-duplicate keys".
- **Keep** "Dead-letter page", "Transfer" and "Deactivation preview", under a heading renamed `## 5c-2`.

Add:

```markdown
## 5d

- **The list reads through `visibleSql(actor)`** (`apps/calendar/src/visibility.ts`), unaliased `activities`; never filter in memory after paging (spec addendum §6).
- **Review selected** posts `{ items: [{ id, version }] }` (≤ 500) to `POST /calendar/api/activities/review-selected` and shows the `skipped` list; **Clear LA Status** posts `{ days }` to `POST /calendar/api/activities/clear-la-status`.
- **The freeze banner** reads `GET /calendar/api/config`'s `freeze`.

## 5e

- **The editor round-trips `ActivityView.fields`** (`@gcpe/calendar-contract`) and runs `checkActivity` and `inferLookAhead` itself; it sends `lookAhead` only when `GET /calendar/api/config`'s `lookAheadFieldset` is true.
- **Lock release on tab close uses `fetch(…, { keepalive: true })` with the `X-GCPE-Request` header**, not `navigator.sendBeacon`, which can't send the header `requireBearer` demands (C169).
- **"View changes"** reads `GET /calendar/api/activities/:id/changes`.
- **Attachments are content writes:** call `assertNotFrozen` and check `can.edit` (spec addendum §7.4, §8.4).
```

Under § "5h and later", add to the existing News API item: "The Calendar → NRMS `activity.*` route exists since 5c-1 (`apps/stack/src/env.ts`); 5h adds NRMS's handler. A test in `apps/stack/src/env.test.ts` pins that no route carries `activity.*` to the News API."

- [ ] **Step 5: Final verification**

Run, all under Node 24:
- `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run`;
- both `tsc` commands;
- `npx -y -p node@24 -- npm run test:e2e`.

Then:
- `git diff 0be0d2b | grep -oE "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+" | sort -u`. Every result is at `example.test`, `example.com`, `x.invalid` or `example.gov.bc.ca`, or was already present at `0be0d2b`.
- `git diff 0be0d2b -- apps packages scripts | grep -nE "Task [0-9]|\bF[0-9]+\b|\bR[0-9]+\b|fix round"` prints nothing.
- `git diff 0be0d2b -- apps/calendar/migrations` prints nothing (no migration).

- [ ] **Step 6: Commit**

```bash
git add docs
git commit -m "docs: parity C167-C169 and built rows for 5c-1; runbook, running notes and carry-forward"
```

- [ ] **Step 7: Deploy to boxs.ca**

Paul authorised test-environment deploys without asking.
1. From a clean worktree, run `npx -y -p node@24 -- npm run deploy:siteground`, then the printed `git push --force origin deploy/siteground:deploy/siteground`.
2. Check that `https://boxs.ca/stack/health` answers 200.
3. If `gcpe_calendar` exists there (`/calendar/api/me` answers 401 rather than 503), do Step 3's hand checks as the seeded cal-* users.
4. If it doesn't exist yet, leave Paul the one Site Tools step (5b-1 D11), and mark the boxs.ca half of the hand checks as waiting on it. The exit check's automated half is the Vitest suite above.

---

## Risks and things to watch

- **drizzle's `inArray` on an SQL expression** (`lower(name)`, the shared-with `EXISTS`). *Assumed:* drizzle 0.45 accepts an `SQL` first argument; the keyword tests and the visibility matrix fail loudly if not. The fallback is `sql\`… IN (${sql.join(…)})\``, as `history.ts` does.
- **Writing `sqlNow(clock)` (an `SQL` value) into timestamp columns** in `takeLock`. *Assumed:* drizzle's insert and update accept `SQL` values. Task 7's tests prove it either way.
- **The freeze and tzdata.** Everything rests on Node 24's tzdata. bc.json's `timeZoneCheck` (2027-01-15 → −07:00) already stops a stale runtime at startup. Task 3 Step 6 shows the clock test failing under Node 22. *Verified* by reading `packages/config/src/tenant.ts:46-89`.
- **Bulk actions take one advisory lock per activity** until their batch commits. With 100 per batch and the default `max_locks_per_transaction` of 64 × `max_connections`, the shared table holds them. *Not measured* on boxs.ca's Postgres. A Clear LA Status over thousands of rows runs as several batches; that is visible in timing only.
- **An imported activity holding two categories** keeps both until the editor's category changes. Its first category, by id, is what the editor shows. *Inferred* from SV 4.9 (categories max 2); 5i's fixture should include one.
- **NRMS's inbox grows** by one `ignored` row per Calendar write until 5h. *Inferred* to be trivial at about 4,500 activities a year (§13).

## Self-review (done while writing)

- **Spec coverage (5c, first half):**
  - **§3 row 5c, exit check:**
    - trigger-table tests (Task 5, through the API in Task 8);
    - lock and concurrency tests on real Postgres (Tasks 7 and 8);
    - freeze-clock tests across 2026-11-01 (Task 3);
    - `visible()` and SQL on a generated matrix (Task 2).
  - **§6:**
    - the rule (Task 2);
    - 404 not 403 (Tasks 6, 8, 9 and 10);
    - the capability table, used by every action. Saved filters, Exec Look Ahead and attachments come in 5d, 5g and 5e. Transfer comes in 5c-2.
  - **§7.1:**
    - Create (Task 6), Update (Task 8), Clone and Delete (Task 9);
    - Review, Review selected and Clear LA Status (Task 10);
    - Transfer is 5c-2's;
    - events with every write (Tasks 6 and 8–10).
  - **§7.2:** Task 4 for the rules; Tasks 6 and 8 for references and the API.
  - **§7.3:** Tasks 5 and 8.
  - **§7.4:** Task 3 for the rule; Tasks 6–9 for the routes.
  - **§7.5:** Tasks 7 and 8. The UI is 5e's.
  - **§7.6:** Task 4, plus storage in Tasks 6 and 8.
  - **§5.1:** the tenant config (Task 1); the lock sweep (Task 7). The dead-letter page is 5c-2's.
  - **§5.4:** `activity.*` payloads (Task 6), `activity.deleted` (Task 9).
  - **§8.3:** the read API (Task 6).
  - **§14:** rows C167–C169 (Task 11).
  - **§16:** the 5c unit and real-Postgres tests above.
- **Placeholders:** none. Two steps describe edits by rule:
  - Task 6 Step 2's note on the existing env assertion, which names the exact key to add if one exists;
  - Task 7's stack-test edit, which names the step and the count.
- **Type consistency:**
  - `ActivityFields`, `UpdateActivityInput`, `LookAheadInput`, `CheckContext` and `FieldError` are defined in Task 4 and used unchanged in Tasks 6 and 8.
  - `Content`, `JoinIds`, `StoredActivity`, `LookAheadValues` and `LiveLock` are defined in Task 6's `store.ts` and used in Tasks 7–10.
  - `ReviewSnapshot` (Task 5) is built only by `snapshotOf` (Task 6).
  - `ApiDeps` (Task 3) is every service's first argument.
  - Error classes are defined in Task 6 and mapped in `http/errors.ts`.
  - `HISTORY_FIELDS` keys are the `FieldChange.key` values: `cloned_from`, `status` and `hq_status` are all in it.
- **Review Focus:** each line names its pinning test, and each test is in its task's code:
  1. Task 8;
  2. Task 8;
  3. Task 8;
  4. Task 6;
  5. Task 6.
