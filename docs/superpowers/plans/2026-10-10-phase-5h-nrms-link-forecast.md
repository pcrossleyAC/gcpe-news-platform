# Phase 5h: The NRMS Link and the Forecast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Calendar activity appears on NRMS's new Forecast tab for the staff who may see it in the Calendar. An NRMS Editor starts a release from it, pre-filled as legacy's New release page did. Every settled status of that release (draft, approved, scheduled, published, failed, deleted) then shows on the activity's "BC Gov News", within one dispatch. No confidential activity text, and no `activity.*` or `release.status_changed` event, ever reaches the News API or the public site.

**Architecture:**
- **Two projections, each fed by the other app's events, both ordered by the receiver's per-aggregate sequence.**
  - NRMS keeps `calendar_activities` from the Calendar's existing `activity.*` outbox (5c). A confidential activity is its id, the flag and its deletion only, and a CHECK constraint keeps it that way.
  - The Calendar keeps its existing `release_links` from NRMS's new `release.status_changed`: one row per release, removed when the release is deleted, unlinked, or linked to an activity the Calendar doesn't hold.
- **NRMS applies the Calendar's own visibility rule.**
  - `visible()` moves from `apps/calendar/src/visibility.ts` to `@gcpe/calendar-contract`. The Calendar re-exports it beside its `visibleSql`, and NRMS imports the same function.
  - NRMS learns each user's Calendar role and ministries from Core's `user.upserted`, now routed to NRMS too (it keeps no email or name), and the HQ flag from `org.upserted`.
  - Only a staff session gets Calendar visibility in NRMS. A bearer token sees no activity.
- **NRMS sends `release.status_changed` from the write's own transaction**, at each point a release's settled status, link, times, reference or type change: create, publish settings, approve, schedule, cancel, delete, and the publisher's publish, unpublish and failure. A correction or an unpublish in progress reads as published, so the Calendar never sees `publishing` or `unpublishing`.
- **Read-time rules in NRMS:**
  - `GET /nrms/api/forecast?page=`: future releases plus eligible, visible activities, by time, 25 a page.
  - `GET /nrms/api/calendar-activities/:id`: the release editor's lookup. It returns one of four states, and for an eligible activity, legacy's pre-fill.
  - Saving a release's activity id refuses an unknown or deleted new id. An unchanged id stands.
- **Event routes (`apps/stack/src/env.ts`):**
  - NRMS → News API names its types, derived from the News API's handlers. It never carries `release.status_changed` or `activity.*`.
  - NRMS → Calendar carries `release.status_changed` only.
  - Core → NRMS gains `user.upserted`.
- **Staff app:**
  - A Forecast tab leads the release folders.
  - New release gains Activity ID (looked up as typed, with "Fill in from activity N", automatic when started from the Forecast) and Location.
  - Publish settings shows what the saved id names.
- **Backfills:** `npm run calendar:replay-to-nrms` and `npm run nrms:replay-activity-links`, dry run by default.

**Tech Stack:** Node 24, TypeScript 5.9, Express 5, Drizzle 0.45 / drizzle-kit 0.31 on Postgres, zod 3.25, React 19 with react-router 7, `@bcgov/design-system-react-components`, Vitest 4.1 (supertest; jsdom with Testing Library and axe-core), Playwright 1.63 with `@axe-core/playwright`.

**Spec:** `docs/superpowers/specs/2026-10-07-calendar-parity-design.md`:
- §3 row 5h. Exit check: "Parent §10.2 e2e: Calendar activity → Forecast → draft → approve → schedule → publish → release status shown on the activity".
- §11 (NRMS link and Forecast; R11), §5.2 (`release_links`), §5.4 (the events), §6 (the one visibility rule), §2 R2 and R11.
- §14: C127, C142, C143, C158. §1's "This closes C15 except its iCal feed".
- §16: the event-contract line; acceptance 13 and 14.
- The parent spec, `docs/superpowers/specs/2026-10-02-gcpe-news-platform-design.md`: §10.2's E2E row, §5 step 2 ("Staff create release from a Forecast item (sets `activityId`)"), §4.1 ordering and §3.1 rules 2 and 3.

The plan also takes these into account:
- `docs/superpowers/plans/phase-5-carry-forward.md`, the "## 5h and later" section. It is binding. Each item maps to a task below, and Task 11 rewrites the section.
- Legacy, read while planning:
  - `Hub.Legacy/Gcpe.Hub.Legacy.Website/News/Services.asmx.cs:76-140` (`FindCalendarActivity`);
  - `News/ReleaseManagement/New.aspx:159-168, 618-700, 765-772` (the Activity ID field, the lookup and the pre-fill);
  - `ReleasesModel.cs:144-230` (`GetFutureActivitiesAndNR`), `Releases.aspx:13-21, 133-190` and `Releases.aspx.cs:133-140, 182-199` (the Forecast folder and its rows), `ReleaseManagement.master.cs:21-27` (the menu);
  - `ReleaseModel.cs:530-541` (`RequiredTranslations`), `Release.aspx.cs:59-67, 108-117` and `Release.aspx:1141-1200` (Has Translations and Required Translations);
  - the Calendar side's release display: `Calendar/ActivityListProvider.ashx.cs:595-620` and `Calendar/Activity.aspx.cs:848` (active releases only).
- The 5f and 5g plans for house style. Their decisions F1–F13 and G1–G22 hold. This plan adds H1–H20.

**Order:**
- Task 1 is the shared contract.
- Task 2 is the event routes.
- Tasks 3–5 are the two projections and the producer between them.
- Tasks 6–7 are NRMS's read rules.
- Task 8 is the backfills.
- Tasks 9–10 are the screens.
- Task 11 is end to end and the docs.

Each task needs the ones before it, except as follows:
- Task 5 needs only Tasks 1 and 2.
- Task 9 needs only Tasks 1 and 7.
- Task 10 needs only Tasks 1 and 6.

**Base:**
- **Branch:** `feat/phase-5h` in `/Users/paul/gcpe-news-platform-p5h`, from `main` at `8639f26` (5a–5g merged). Every path is repo-relative.
- **Facts this plan relies on (verified by reading the code at `8639f26`):**
  - **Events** (`packages/events/src/catalogue.ts`):
    - `activityEventSchema` is `activityRecordSchema` or the strict id-only `confidentialActivitySchema`. `activityDeletedSchema` is `{ id }`.
    - `releaseStatusChangedSchema` is `{ releaseId, key, reference, type, activityId, previousActivityId, status, publishAt, releasedAt, headline }`.
    - `ReleaseStatusChanged`, `ActivityEvent`, `ActivityRecord`, `UserRecord` and `OrgRecord` (with `isHq`) are exported.
    - The receiver (`receiver.ts`) applies an event only when its `sequence` is past the last applied for `(source, aggregateId)`. Otherwise it records `stale`, and a repeated event id is `duplicate`. An unhandled type is `ignored`, but it still advances the position.
    - `enqueueEvent` writes the outbox row even with no subscribers.
  - **Routes** (`apps/stack/src/env.ts`):
    - `INTERNAL_EVENT_ROUTES` has CALENDAR → NRMS `activity.*`, NRMS → NEWSAPI `types: ["*"]`, and Core → NRMS with taxonomy types only.
    - `eventRoutesFor` drops every route from or to CALENDAR when the Calendar isn't configured. `newsApiEventTypesFromCore` derives Core's News API types from `createProjectionHandlers()`.
    - The News API's `SOURCE_EVENT_TYPES.nrms` accepts every `release.*`, so the `"*"` route would carry `release.status_changed` (an unpublished headline and its activity id) to the public-facing News API.
    - `env.test.ts` pins the current lists, including `["news-api", ["*"]]` and "user.upserted reaches only the Calendar".
  - **The Calendar:**
    - `projectionHandler` (`apps/calendar/src/projections.ts`) takes `core` only.
    - `release_links` (5b) is keyed by `release_id`, with `activity_id` referencing `activities` and `last_sequence`.
    - `view.ts` lists a release's links without status `deleted`. `list/rows.ts`'s `hasRelease` counts any row.
    - `emitActivity` and `activityEventData` (`activities/events.ts`) send the §5.4 payload: confidential as its id only, and `cityName` already resolves "Other…" to the typed city.
    - `test/helpers.ts`'s `EVENT_SECRETS` already includes `nrms`. `insertRaw` and `seedWorld` are in `test/world.ts`.
  - **NRMS:**
    - The receiver's handler is `taxonomyHandler` (Core only). `organizations` keys are stored lowercased, with no `is_hq`.
    - `news_releases.activity_id` is a nullable int.
    - The `activityId` schema (`packages/nrms-contract/src/schemas.ts`) is any positive integer, so `2147483648` reaches Postgres's int4 and fails as a 500.
    - Statuses are written in `releases/workflow.ts` (`approve`, `schedule`, `cancel`, `unpublish`), `publisher.ts` (publish, the unpublish completion, failure), `releases/service.ts` (`deleteRelease`) and `releases/store.ts` (`mutateRelease`'s correction, published → publishing).
    - `WorkflowDeps` has no subscribers. `apiRoutes` has `deps.subscribers`.
    - `startNrms` loads the tenant, whose `calendar` section is optional. `test/helpers.ts` has `seedTaxonomy`, `sampleCreate`, `editor` and `createScheduledRelease`.
  - **Staff app:**
    - `NewReleaseScreen` sends `activityId: null`, `location: ""` and `publishAt: null`, and has no activity field.
    - `SettingsSection` has the "Calendar activity ID" `NumberField`, and `ReferenceBlock` shows the id.
    - `ReleaseListScreen` draws its Drafts/Scheduled/Published tabs inline. `ReleaseRow`, `Pagination`, `formatWhen`, `dateTimeText`, `activityPath` and `useTenantTimeZone` exist.
    - `ReleasesList` (5e) already shows "BC Gov News" with a link for NRMS read roles only.
  - **E2E:**
    - global-setup mints a session for every `TEST_USER_PASSWORDS` user.
    - `listFixture`, `activityInput`, `sessionOf` and `useCookie` are in `calendar-support.ts`. `apiCall`, `tick`, `nrmsDb`, `expectNoSeriousA11yViolations` and `baseUrl` are in `playwright-support.ts`.
    - The suite runs with `workers: 1`.
  - **Parity lists:**
    - The highest change row in `docs/parity/changes-from-legacy.md` is C190, and the highest question in `docs/parity/open-questions.md` is Q64 (checked with `grep -o "^| C[0-9]*"` and `"^| Q[0-9]*"`).
    - C142, C143 and C158 are spec rows not yet in the changes file. C15 still reads "Not built yet".

## Decisions made in planning

Each says why and what it costs if wrong. Task 11 writes the parity rows and the questions.

- **H1. NRMS holds a confidential activity as its id only.**
  - `calendar_activities` keeps the id, `is_confidential` and `is_deleted`. Every other column is empty, and the CHECK `calendar_activities_confidential_id_only` refuses anything else, whatever writes the row.
  - An activity made confidential is wiped, because the id-only event replaces the whole row.
  - NRMS never describes one: the lookup says `hidden`, and the Forecast never lists it.
  - *Why:* C127 and spec §5.4. The CHECK also guards a future importer or replay.
  - *Cost if wrong:* an HQ Advanced user, who can read the activity in the Calendar, sees no title in NRMS for it. They open it in the Calendar.
- **H2. NRMS learns who can see what from Core, and applies the Calendar's own `visible()`.**
  - Core's `user.upserted` is now routed to NRMS too. `calendar_viewers` keeps the user id, the Calendar role, the ministries (Core keys exactly as sent) and active, and drops the email and name.
  - `org.upserted` stores `is_hq` on NRMS's organizations.
  - `visible()`, `Viewer`, `VisibilityFacts` and `isOwnMinistry` move to `@gcpe/calendar-contract`. `apps/calendar/src/visibility.ts` re-exports them and keeps `visibleSql`, so the generated-matrix agreement test is unchanged.
  - `calendarViewerOf(db, req)` returns null for any caller that isn't a staff session (`claims.via !== "session"`), as the Calendar's `requireCalendarActor` does.
  - *Why:* the brief requires the Calendar's visibility rules, and Core owns the facts. There is no per-request call to the Calendar, so NRMS serves with the Calendar absent (parent §3.1 rule 3).
  - *Rejected:* forwarding the session cookie to the Calendar (it couples Forecast to the Calendar's uptime and makes NRMS carry credentials); filtering in the browser (not enforcement); legacy's "every NRMS user sees every non-confidential activity" (C191).
  - *Cost if wrong:* a revoked grant takes effect in NRMS when its `user.upserted` arrives (seconds), as in the Calendar. NRMS holds staff ids, roles and ministries, but no personal details.
- **H3. An NRMS user without Calendar access sees the Forecast's releases only, with a note saying why.**
  - In the lookup, any id resolves to one of `unknown`, `deleted` or `hidden`. They learn that an id exists and whether it was deleted, never its detail.
  - Saving a link needs no Calendar access, as legacy's free number didn't.
  - *Why:* an id's existence is not activity content, and spec §11 keeps typed ids resolving.
  - *Cost if wrong:* Q66. If the business wants NRMS-only staff to see activities, that is one route grant.
- **H4. Saving an activity id (C142, C158):**
  - A new id must be in NRMS's projection and not deleted. A confidential one can be linked.
  - An unchanged id stands, whatever it is, so a release imported linked to an activity that wasn't migrated keeps it.
  - The schema caps the id at 2,147,483,647, so a larger one is a 400.
  - `assertActivityLinkable` runs in `createRelease` and `saveSettings`. Five existing tests that link arbitrary ids now seed them first.
  - *Cost if wrong:* where the Calendar isn't configured (boxs.ca today), no new link can be saved. Stored ones stand.
- **H5. Event routes, so no route says `"*"`:**
  - NRMS → News API is `newsApiEventTypesFromNrms()`: the News API's own handled `nrms` types, never `release.status_changed` or `activity.*`, even if the News API grew a handler for one.
  - NRMS → Calendar carries `release.status_changed` alone. It is dropped with the Calendar's other routes when the Calendar isn't configured.
  - Core → NRMS adds `user.upserted`.
  - Pinned in `env.test.ts`.
  - *Cost if wrong:* a new NRMS event type the News API should get is routed only when the News API has a handler for it. That is the right default.
- **H6. Ordering, duplicates and late events.**
  - The receiver's per-aggregate sequence (`activity:<id>`, `release:<id>`, `user:<id>`) decides. An older event is `stale`, a repeated one `duplicate`, and a dead letter replayed after a newer event is `stale`.
  - Every event carries the whole current state, so each handler replaces the row.
  - NRMS's `activity.deleted` keeps the row and marks it deleted. For an id never seen, it inserts an id-only deleted row, the most restrictive form.
  - `activity.updated` with `isDeleted: true` (Review, Clear LA Status after deletion) stays deleted.
  - The Calendar has no undelete, so following its current state is right. The replays enqueue fresh sequences holding the current state, read under the row's lock.
  - *Cost if wrong:* if the Calendar ever gains undelete, NRMS follows it, which would be correct.
- **H7. The Calendar is told settled statuses only.**
  - `publishing` and `unpublishing` read as `published`, so a correction's round trip sends nothing.
  - An event goes when the activity, the settled status, the publish or release time, the reference or the type changes, and the release has an activity before or after.
  - The key and the English headline travel with each event but don't cause one.
  - *Why:* "at every status write" (§11) would make the Calendar flicker through statuses that mean "still on the site". Legacy read `IsPublished`, which stayed true through a correction.
  - *Cost if wrong:* a headline edited after the last status change shows its old text in `release_links.headline`. The Calendar doesn't display the headline (5e).
- **H8. Where NRMS sends it. Every send is in the write's own transaction, through the outbox:**
  - `createRelease` (a new last parameter, `subscribers`);
  - `saveSettings`, `approve` and `schedule`, through `WorkflowDeps.subscribers`, which `apiRoutes` fills from the app's subscribers;
  - `cancel` (a new last parameter);
  - `deleteRelease`, both the hidden and the hard delete;
  - the publisher's publish, its unpublish completion (back to approved or draft) and a failed publish.
  - The unpublish request itself sends nothing, because the release reads as published until the publisher takes it down.
  - *Cost if wrong:* any new status-writing path must call `emitLinkChange`. The `link-events.test.ts` route test lists them.
- **H9. The Calendar's release projection has one row per release id.**
  - A deleted release, a cleared link and a link to an activity the Calendar doesn't hold (not imported, R13) remove the row and are otherwise ignored.
  - The list's release icon and the page then agree, as legacy's `IsActive` filter had them (`ActivityListProvider.ashx.cs:598`).
  - Only `nrms` may send it.
- **H10. Pre-fill follows legacy's New.aspx:**
  - the publish time comes from the start (as the planned `publishAt`), and the location from the city without ", BC", at most 50 characters;
  - the ministries are the lead then the shared ones, the lead ministry is the contact ministry, and sectors, themes and tags follow the activity;
  - only active NRMS ministries and terms are filled in, in NRMS's lowercase keys.
  - Not filled in: legacy's Organizations text (ministry names plus the activity's Lead Organization, which `activity.*` doesn't carry; C194, Q67), and initiatives (commented out in legacy).
  - Offered only on New release, as legacy's Release.aspx had no lookup:
    - a "Fill in from activity N" button;
    - automatically when started from the Forecast (`/releases/new?activity=N`).
  - Publish settings shows what the saved id names, with no pre-fill.
- **H11. Eligibility for pre-fill (News/Services.asmx.cs:87):**
  - visible, not deleted, not confidential;
  - its end's BC date is today or later (legacy compared `EndDateTime >= DateTime.Today` in server time), and an activity with no end isn't eligible;
  - a category starting with the tenant's `calendar.forecastCategoryPrefix` ("Approved" for BC), ignoring case and stray whitespace (SQL Server's default collation; legacy category names carry stray spaces);
  - confirmation isn't required, as legacy's lookup didn't require it.
  - A visible activity that isn't eligible still shows its title, with the reason (C192).
- **H12. The Forecast.**
  - **Lists:**
    - every non-deleted release with `publish_at ≥ now()` (the database clock);
    - every confirmed, non-confidential, non-deleted activity starting from now on, with an "Approved" category, not linked to one of those releases, and visible to the caller.
  - **Order:** each activity sits at its NR time, else its start. By time; at the same instant a release comes before an activity (legacy concatenated releases first), then by id.
  - **Paging:** 25 a page.
  - **Filters:** none. Legacy hid the type filter on Forecast (`Releases.aspx:20-21`).
  - **Who sees it:** NRMS's read roles (Viewer, Editor, Site Editor), as every legacy NRMS user had it.
  - **Rows:** an activity's title links to the Calendar. "Start a release" is for NRMS Editors (parent §5 step 2). The tab leads the folders (`ReleaseManagement.master.cs:21-27`).
  - **Bounds:** at most 5,000 candidate releases and 5,000 candidate activities are read, years of legacy volume (spec §13).
  - With no `calendar` section in the tenant, the Forecast lists releases only.
  - An activity linked only to a release already out is listed again, as in legacy (Q65).
- **H13. Translations.** The lookup shows "Translations required: …" on New release and in Publish settings (ReleaseModel.cs:530-541). Has Translations still follows the uploaded translation files (C193). Legacy set it from the activity on every page load, which would announce translations not yet uploaded to the public site.
- **H14. Backfills (§11, §12.1):**
  - `npm run calendar:replay-to-nrms` sends every activity's current state as `activity.updated`, confidential as its id and deleted as deleted.
  - `npm run nrms:replay-activity-links` sends every non-deleted linked release's status, and reports how many name an activity NRMS doesn't hold: the "counts it in the replay's report" of §11.
  - Both:
    - are a dry run unless `--confirm`;
    - read each row under its lock, in a savepoint per row;
    - report failures with `safeErrorLabel` only.
  - Run the Calendar's first.
- **H15. The stack's reference-data backfill also covers NRMS.** When the Calendar is mounted and NRMS has no Calendar viewers, the stack asks Core to republish once. That carries the users and the organizations' HQ flags.
- **H16. End to end:**
  - A new seeded user, `planner@example.test` ("Test Release Planner": `NRMS.Editor` and `Calendar.ReadOnly` at GCPE Headquarters), with a session minted in global-setup.
  - The activity is on 2031-06-11 at 10:00 BC.
  - "Publish" moves the scheduled time into the past through `nrmsDb()`, so nothing waits on the clock and nothing depends on the hour.
  - Statuses are polled with `tick()`, and the Forecast page holding the row is found through the API, so other specs' releases can't push it off page 1.
- **H17. No per-field caps on the activity event's strings.** The envelope's `MAX_EVENT_BYTES` bounds them. Imported over-length values must still travel (C156), and a cap would make their saves fail in the Calendar's own outbox write.
- **H18. One migration, NRMS's `0015_calendar_link`, generated by drizzle-kit:** `calendar_activities` (with its CHECK and a partial index on `start_at`), `calendar_viewers`, `organizations.is_hq`, and `news_releases_publish_at_idx` for the Forecast's release read. The Calendar's schema doesn't change.
- **H19. Keys.**
  - Visibility compares Core keys byte for byte, as the Calendar does, so the new tables keep them verbatim.
  - NRMS's own keys (pre-fill, ministry names, the HQ lookup) are their lowercase.
  - *Cost if wrong:* two Core organizations whose keys differ only in case would share NRMS's HQ flag. Core's keys are slugs or uppercase GUIDs.
- **H20. A new dependency, of a workspace package only.** `apps/nrms` depends on `@gcpe/calendar-contract` (zod only). `package-lock.json` gains one line. No npm package is added.

## Carry-forward items taken

From `docs/superpowers/plans/phase-5-carry-forward.md` § "5h and later". Task 11 rewrites the section.

| Item | Where |
|---|---|
| The News API must never gain an `activity.*` handler; only the id-only confidential form crosses | H1, H5; Task 2 (no route to the News API names `activity.*` or `release.status_changed`, even if a handler appeared), Task 3 (the CHECK) |
| NRMS's `activity.*` handler must not bring a deleted activity back | H6; Task 3 ("a deleted activity stays deleted…", "an older event arriving late…") |
| The NRMS → News API route is `"*"`: list its types or exclude `release.status_changed`; the Calendar's `projectionHandler` must accept `nrms` for `release.status_changed` | H5, H9; Task 2 (`newsApiEventTypesFromNrms`), Task 5 (`projectionHandler`) |
| Core's `actorIsHq` for session callers only, if service tokens ever carry Calendar roles | Not 5h's: no service token gains a Calendar role here. NRMS's own Calendar viewer is session-only (H2, Task 6). Task 11 moves the item to "Platform hardening". |
| Re-check NRMS "email me a copy" if service tokens ever carry NRMS roles | Not 5h's. Task 11 moves the item to "Platform hardening". |

## Global Constraints

- **Worktree and commits:**
  - Work on `feat/phase-5h` in `/Users/paul/gcpe-news-platform-p5h`. Commit locally after each task, with a plain message. Don't push until the branch is reviewed.
  - **Never add `Co-Authored-By` or any AI attribution** to a commit. Never commit `CLAUDE.md`.
  - **No task, decision or round labels in code comments** ("Task 3", "H4", "fix round 1"). Spec row ids (C142, Q65) and legacy file references are fine.
- **Node 24 for everything:**
  - Tests: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run <paths>`.
  - Type-checks: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json` and `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p apps/staff-web/tsconfig.json`.
  - E2E: `npx -y -p node@24 -- npm run test:e2e` (a single spec: append `-- tests/e2e/<file>`).
  - Packages: `npx -y -p node@24 -- npm install --ignore-scripts`. Run `npm ci` first if `node_modules` is missing.
- **Every behaviour change starts with a real RED run:** run the new test, see it fail for the stated reason, then implement.
- **No debug logging.** Logs carry `safeErrorLabel` and the route or command only: never a title, a headline, an email or an event's data.
- **Confidentiality:**
  - No confidential activity text reaches NRMS. `calendar_activities`' CHECK enforces it.
  - No `activity.*` or `release.status_changed` reaches the News API. No route says `"*"`.
  - NRMS describes an activity only to a staff session the Calendar's `visible()` admits.
  - Not visible, deleted and unknown are states of the lookup, never a 403 or a 500.
- **Events:** every send is in the write's own transaction (`enqueueEvent`). Ordering is the receiver's per-aggregate sequence, and handlers replace rows with the state they carry.
- **Privacy:** `example.test` addresses, fictional GUIDs and fictional names only. No legacy data enters the repo.
- **Migrations:** drizzle-kit only, from the app folder: `cd apps/nrms && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name calendar_link`. Never hand-edit generated DDL. The Calendar gets none.
- **Bounded ids and strings:**
  - activity ids are 1–2,147,483,647 (schema and route), and the Forecast page is 1–1000;
  - the location pre-fill is at most 50 characters;
  - each Forecast read is at most 5,000 releases and 5,000 activities;
  - malformed ids are 404, a bad page a 400.
- **Staff-web patterns:**
  - Calls go through `apiFetch` with same-origin paths. Errors use `role="alert"`; the lookup panel is a `role="status"` live region.
  - Every screen state has an axe test, and browser code never imports `@gcpe/auth`.
- **E2E:**
  - Seeded users only, with sessions minted in global-setup (`sessionOf`), never a real login.
  - Fixed dates in 2031. Nothing depends on the time of day: publishing moves `publish_at` into the past rather than waiting.
- **Parity lists:**
  - New change rows go in `docs/parity/changes-from-legacy.md` from C191 (the highest at `8639f26` is C190). C142, C143 and C158 are added as built, and C15's status is updated.
  - New questions go in `docs/parity/open-questions.md` from Q65 (the highest is Q64).
  - Running-notes lines carry the legend's role tags (`docs/manuals/running-notes.md`: Editor, Site editor, Viewer, Administrator, Operations, Developer; All Calendar users, Calendar editors, HQ, HQ Editor and above, HQ Advanced and above, HQ Administrator, System Administrator).

## Review Focus

1. **A confidential activity, or one made confidential after NRMS has its text.** Expected: NRMS's row holds the id, the flag and deletion only, with every text, date, key and list emptied. The lookup says `hidden` even to an HQ Administrator. The Forecast never lists it. A direct insert with text fails. Pinned in Task 3 ("holds a confidential activity as its id only, and wipes…", "the database refuses text on a confidential row…") and Task 6 ("a confidential activity is hidden even from an HQ Administrator…").
2. **Events arriving late, twice, out of order, or replayed from a dead letter:** an `activity.created` after its `activity.deleted`, a Review's `activity.updated` with `isDeleted` after the deletion, an old `scheduled` after `published`. Expected: the newest state stands, a deleted activity never comes back, and a duplicate is acknowledged and ignored. Pinned in Task 3 ("a deleted activity stays deleted…", "an older event arriving late, a duplicate, and a dead letter replayed…") and Task 5 ("an older status arriving late…").
3. **A typed activity id that is huge, zero, negative, non-numeric, or a legacy one that wasn't migrated.** Expected: the lookup route answers 404 (never a 500) and the save schema 400. A new unknown or deleted id is refused with its message at the field. A stored unmigrated id stands and reads "Legacy activity N, not migrated". Pinned in Task 1 (the schema's int4 cap), Task 6 ("a malformed or out-of-range id is not found…", "saving: a new id must be known…") and Task 10 ("a saved id the Calendar doesn't hold…").
4. **Someone opens the Forecast or the lookup without Calendar access, from another ministry, or with a bearer token.** Expected: only what the Calendar would show them. Releases only, with a note, for no Calendar access. Own and shared ministries' activities for a ministry user, everything non-confidential for HQ, and nothing for a bearer token. Pinned in Task 6 ("follows the Calendar's visibility…", "someone with no Calendar access learns only that the id exists", "only a staff session has Calendar visibility…"), Task 7 ("shows activities only as the Calendar would…") and Task 11 (e2e "an NRMS Editor without Calendar access…").
5. **A release moved to another activity, unlinked, hidden, hard-deleted, or linked to an activity the Calendar doesn't hold.** Expected: the old activity loses it, the new one gains it, a deleted one disappears from page and list, and the Calendar ignores an unknown activity. Pinned in Task 4 ("moving the link sends the old activity as previousActivityId…", "cancel, a failed publish, a hidden delete and a hard delete…") and Task 5 ("moving the release to another activity…", "a deleted release leaves its activity…", "a release linked to an activity the Calendar doesn't hold…").

---

## File structure

| File | Responsibility |
|---|---|
| `packages/calendar-contract/src/visibility.ts` (+ test), `src/category-name.ts` (+ test), `src/index.ts` | `visible()`, `Viewer`, `VisibilityFacts`, `isOwnMinistry`, `seesConfidentialEverywhere`, `seesDeleted`; `hasCategoryStartingWith` |
| `apps/calendar/src/visibility.ts` | Re-exports the rule; keeps `visibleSql` |
| `packages/config/src/calendar.ts` (+ test), `config/tenants/bc.json` | `calendar.forecastCategoryPrefix` |
| `packages/nrms-contract/src/schemas.ts` (+ test), `src/types.ts` | `MAX_ACTIVITY_ID`, the bounded `activityId`, `forecastQuerySchema`; `ReleasePrefill`, `ActivityLookup`, `ForecastActivity`, `ForecastItem`, `ForecastPage` |
| `apps/stack/src/env.ts` (+ test) | `newsApiEventTypesFromNrms`; the NRMS → Calendar route; `user.upserted` to NRMS |
| `apps/nrms/src/db/schema.ts`, `migrations/0015_calendar_link.sql` (+ meta) | `calendar_activities`, `calendar_viewers`, `organizations.is_hq`, `news_releases_publish_at_idx` |
| `apps/nrms/src/calendar/projection.ts` (+ test), `src/taxonomy.ts`, `src/app.ts`, `src/start.ts` | `calendarHandler`, `needsCalendarViewers`; HQ flag; the receiver's handlers; the worker |
| `apps/stack/src/stack.ts` (+ `stack.test.ts`) | The backfill asks for NRMS too |
| `apps/nrms/test/events.ts`, `test/helpers.ts` | Signed test events and records; `seedActivity` |
| `apps/nrms/src/releases/link-events.ts` (+ test), `releases/service.ts`, `releases/workflow.ts`, `publisher.ts`, `http/routes.ts` | `linkStateOf`, `settledStatus`, `statusChangedData`, `sendStatusChanged`, `emitLinkChange`; the send points |
| `apps/calendar/src/projections.ts`, `src/release-links.test.ts` | `release.status_changed` → `release_links` |
| `apps/nrms/src/calendar/viewer.ts`, `calendar/lookup.ts` (+ test), `releases/service.ts`, `http/routes.ts`, `app.ts`, `start.ts`, `package.json`; five existing tests | `calendarViewerOf`; `lookupActivity`, `assertActivityLinkable`, `bcDateOf`, `locationOf`, `factsOf`; `GET /calendar-activities/:activityId` |
| `apps/nrms/src/calendar/forecast.ts` (+ test), `http/routes.ts` | `forecast`; `GET /forecast` |
| `apps/calendar/src/cli/replay-to-nrms.ts` (+ test), `apps/nrms/src/cli/replay-activity-links.ts` (+ test), `package.json`, `apps/calendar/package.json`, `apps/nrms/package.json` | The backfills |
| `apps/staff-web/src/screens/releases/ForecastScreen.tsx` (+ test), `ForecastActivityRow.tsx`, `ReleaseFolderTabs.tsx`, `ReleaseListScreen.tsx`, `src/router.tsx`, `src/styles/global.css` | The Forecast tab |
| `apps/staff-web/src/screens/release/ActivityLookupPanel.tsx` (+ test), `NewReleaseScreen.tsx` (+ test), `sections/SettingsSection.tsx` (+ test) | The lookup, pre-fill, Location, and the saved id's panel |
| `apps/core/src/services/seed-test-users.ts` (+ test), `scripts/siteground-seed-users.sh`, `tests/e2e/constants.ts`, `tests/e2e/forecast.spec.ts` | The planner user; end to end |
| `docs/parity/changes-from-legacy.md`, `docs/parity/open-questions.md`, `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`, `docs/superpowers/specs/2026-10-07-calendar-parity-design.md`, `docs/superpowers/plans/phase-5-carry-forward.md` | Docs |

---
### Task 1: The shared contract: the visibility rule in the contract, the "Approved" test, the tenant's prefix, bounded activity ids, and the lookup and Forecast types

Covers: spec §6 (one rule, two apps), §11 (the "Approved" category; the lookup and Forecast shapes), §14 C142 (bounded ids). Decisions H2, H4, H11, H12.

Light review: pure functions, a config field and types.

**Files:**
- Create: `packages/calendar-contract/src/visibility.ts`, `packages/calendar-contract/src/visibility.test.ts`.
- Modify: `packages/calendar-contract/src/index.ts`, `packages/calendar-contract/src/category-name.ts`, `packages/calendar-contract/src/category-name.test.ts`, `apps/calendar/src/visibility.ts`, `packages/config/src/calendar.ts`, `packages/config/src/calendar.test.ts`, `config/tenants/bc.json`, `packages/nrms-contract/src/schemas.ts`, `packages/nrms-contract/src/schemas.test.ts`, `packages/nrms-contract/src/types.ts`.

**Interfaces:**
- Consumes: `LEVEL` (`packages/calendar-contract/src/levels.ts`), `normaliseCategoryName` (`category-name.ts`), `ReleaseListItem` and `ReleasePage<T>` (`packages/nrms-contract/src/types.ts`).
- Produces:
  - `@gcpe/calendar-contract`:
    - `interface Viewer { level: number; isHq: boolean; ministryKeys: readonly string[] }`;
    - `interface VisibilityFacts { contactMinistryKey: string | null; sharedMinistryKeys: readonly string[]; isConfidential: boolean; isDeleted: boolean }`;
    - `isOwnMinistry(u, key): boolean`, `seesConfidentialEverywhere(u): boolean`, `seesDeleted(u): boolean`, `visible(u, a): boolean`;
    - `hasCategoryStartingWith(names: readonly string[], prefix: string): boolean`.
  - `apps/calendar/src/visibility.ts` still exports `isOwnMinistry`, `visible`, `Viewer`, `VisibilityFacts` and `visibleSql`, so its 19 importers are unchanged.
  - `CalendarTenantConfig.forecastCategoryPrefix: string` (BC: `"Approved"`).
  - `@gcpe/nrms-contract`:
    - `MAX_ACTIVITY_ID = 2_147_483_647`;
    - `forecastQuerySchema` (`{ page: 1..1000 = 1 }`) and `ForecastQuery`;
    - `ReleasePrefill`, `ActivityLookup`, `ForecastActivity`, `ForecastItem`, `ForecastPage` (exact shapes below).

- [ ] **Step 1: Write the failing tests**

Create `packages/calendar-contract/src/visibility.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isOwnMinistry, visible, type Viewer, type VisibilityFacts } from "./visibility";

// The full role × HQ × own/shared/other × confidential × deleted matrix, and its agreement with
// the SQL form, is apps/calendar/src/visibility.test.ts. These pin that the rule NRMS now imports
// is the Calendar's own.
const live: VisibilityFacts = { contactMinistryKey: "health", sharedMinistryKeys: ["finance"], isConfidential: false, isDeleted: false };
const as = (over: Partial<Viewer>): Viewer => ({ level: 1, isHq: false, ministryKeys: [], ...over });

describe("visible() (spec addendum §6), shared by the Calendar and NRMS", () => {
  it("needs a Calendar role", () => {
    expect(visible(as({ level: 0, isHq: true }), live)).toBe(false);
  });

  it("a ministry user sees their own and shared ministries' activities, not another's", () => {
    expect(visible(as({ ministryKeys: ["health"] }), live)).toBe(true);
    expect(visible(as({ ministryKeys: ["finance"] }), live)).toBe(true);
    expect(visible(as({ ministryKeys: ["education"] }), live)).toBe(false);
  });

  it("HQ sees every ministry's; confidential needs HQ Advanced or the ministry itself", () => {
    expect(visible(as({ isHq: true }), live)).toBe(true);
    expect(visible(as({ isHq: true, level: 2 }), { ...live, isConfidential: true })).toBe(false);
    expect(visible(as({ isHq: true, level: 3 }), { ...live, isConfidential: true })).toBe(true);
    expect(visible(as({ ministryKeys: ["health"] }), { ...live, isConfidential: true })).toBe(true);
  });

  it("keys compare byte for byte", () => {
    expect(isOwnMinistry(as({ ministryKeys: ["Health"] }), "health")).toBe(false);
  });
});
```

Append to `packages/calendar-contract/src/category-name.test.ts`, and import `hasCategoryStartingWith` beside `sameCategoryName`:

```ts
describe("hasCategoryStartingWith (legacy's \"Approved\" test: News/Services.asmx.cs:87, ReleasesModel.cs:155)", () => {
  it("is true when any category starts with the prefix", () => {
    expect(hasCategoryStartingWith(["Sample event", "Approved Release"], "Approved")).toBe(true);
    expect(hasCategoryStartingWith(["Proposed Release"], "Approved")).toBe(false);
    expect(hasCategoryStartingWith([], "Approved")).toBe(false);
  });
  it("ignores case and stray whitespace, as legacy's SQL Server collation and markup did", () => {
    expect(hasCategoryStartingWith(["  approved  event"], "Approved event")).toBe(true);
  });
  it("matches at the start only", () => {
    expect(hasCategoryStartingWith(["Not Approved"], "Approved")).toBe(false);
  });
});
```

In `packages/config/src/calendar.test.ts`, after the "BC carries legacy's values" test, add:

```ts
  it("BC's Forecast and release lookup take categories starting \"Approved\" (News/Services.asmx.cs:87, ReleasesModel.cs:155)", () => {
    const c = bc().calendar!;
    expect(c.forecastCategoryPrefix).toBe("Approved");
    expect(calendarTenantSchema.safeParse({ ...c, forecastCategoryPrefix: "" }).success).toBe(false);
  });
```

In `packages/nrms-contract/src/schemas.test.ts`, import `forecastQuerySchema` too. In "activity id is numeric, categories are lowercased and de-duplicated", after the `"4521"` line, add:

```ts
    // The Calendar's activity ids are int4: one past it is a 400, never a database error.
    expect(settingsSchema.parse({ version: 1, activityId: 2_147_483_647, toSubscribers: true, toMediaLists: false, mediaListKeys: [] }).activityId).toBe(2_147_483_647);
    for (const activityId of [2_147_483_648, "2147483648", "99999999999999999999"]) {
      expect(settingsSchema.safeParse({ version: 1, activityId, toSubscribers: true, toMediaLists: false, mediaListKeys: [] }).success).toBe(false);
    }
```

and before the file's last `});`:

```ts
  it("forecast: a page from 1 to 1000, 1 by default", () => {
    expect(forecastQuerySchema.parse({})).toEqual({ page: 1 });
    expect(forecastQuerySchema.parse({ page: "3" })).toEqual({ page: 3 });
    for (const page of ["0", "1001", "x", "-1"]) expect(forecastQuerySchema.safeParse({ page }).success).toBe(false);
  });
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/calendar-contract/src/visibility.test.ts packages/calendar-contract/src/category-name.test.ts packages/config/src/calendar.test.ts packages/nrms-contract/src/schemas.test.ts`

Expected: FAIL.
- `visibility.test.ts` fails to load: "Cannot find module './visibility'".
- `hasCategoryStartingWith is not a function`.
- `expected undefined to be 'Approved'`.
- The activity id test fails at `expected true to be false`.
- `Cannot read properties of undefined (reading 'parse')`.

- [ ] **Step 3: Move the rule into the contract**

Create `packages/calendar-contract/src/visibility.ts`:

```ts
import { LEVEL } from "./levels";

/** M(u), HQ(u) and L(u) of spec addendum §6. The Calendar's actor is one; so is NRMS's Calendar viewer. */
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

/**
 * Whether `ministryKey` is one of the viewer's ministries, byte for byte. Visibility, create and
 * edit rights all read ministry ownership from here.
 */
export const isOwnMinistry = (u: Viewer, ministryKey: string): boolean => u.ministryKeys.includes(ministryKey);

// Legacy's list rule (ActivityListProvider.ashx.cs:214-244, ActivityDAO.cs:261-291). Deleted
// activities are for HQ Administrators to review (ActivityDAO.cs:176-193). Cross-government
// doesn't widen it. Keys compare byte for byte.
export const seesConfidentialEverywhere = (u: Viewer): boolean => u.isHq && u.level >= LEVEL.advanced;
export const seesDeleted = (u: Viewer): boolean => u.isHq && u.level >= LEVEL.administrator;

/** The one visibility rule (spec addendum §6). The Calendar's SQL form is `visibleSql` (apps/calendar/src/visibility.ts). */
export function visible(u: Viewer, a: VisibilityFacts): boolean {
  if (u.level < LEVEL.readOnly) return false;
  const mine = (a.contactMinistryKey !== null && isOwnMinistry(u, a.contactMinistryKey)) || a.sharedMinistryKeys.some((k) => isOwnMinistry(u, k));
  const inScope = u.isHq || mine;
  const seesConfidential = seesConfidentialEverywhere(u) || mine;
  return inScope && (!a.isConfidential || seesConfidential) && (!a.isDeleted || seesDeleted(u));
}
```

In `packages/calendar-contract/src/index.ts`, after `export * from "./view";`, add `export * from "./visibility";`.

In `apps/calendar/src/visibility.ts`, delete `Viewer`, `VisibilityFacts`, `isOwnMinistry`, the two `sees…` constants and `visible` (everything from the `/** M(u), HQ(u)` comment down to the `visibleSql` doc comment). Replace the imports with:

```ts
import { inArray, sql, type SQL } from "drizzle-orm";
import { LEVEL, seesConfidentialEverywhere, seesDeleted, type Viewer } from "@gcpe/calendar-contract";
import { activities, activitySharedWith } from "./db/schema";

// The rule itself is shared with NRMS (Forecast and the activity lookup), so it lives in the contract.
export { isOwnMinistry, visible, type Viewer, type VisibilityFacts } from "@gcpe/calendar-contract";
```

`visibleSql` is otherwise unchanged.

Append to `packages/calendar-contract/src/category-name.ts`:

```ts
/**
 * Whether any of `names` starts with `prefix`: legacy's Forecast and release-lookup test for an
 * "Approved" category (News/Services.asmx.cs:87, ReleasesModel.cs:155). Legacy compared in SQL
 * Server's default case-insensitive collation, so case is ignored here; whitespace is normalised
 * as {@link normaliseCategoryName} does.
 */
export function hasCategoryStartingWith(names: readonly string[], prefix: string): boolean {
  const p = normaliseCategoryName(prefix).toLowerCase();
  return names.some((n) => normaliseCategoryName(n).toLowerCase().startsWith(p));
}
```

- [ ] **Step 4: The tenant's prefix**

In `packages/config/src/calendar.ts`, after `reports: reportsSchema,` in `calendarTenantSchema`, add:

```ts
    /** NRMS's Forecast and release-editor lookup take only activities with a category starting with this (spec addendum §11). */
    forecastCategoryPrefix: z.string().min(1),
```

In `config/tenants/bc.json`, after the `"reportBanner"` line, add:

```json
    "forecastCategoryPrefix": "Approved",
```

- [ ] **Step 5: Bounded ids, the Forecast query and the types**

In `packages/nrms-contract/src/schemas.ts`, replace the `activityId` constant with:

```ts
/** The Calendar's activity ids are int4 (apps/calendar's `activities.id`, NRMS's `calendar_activities.id`). */
export const MAX_ACTIVITY_ID = 2_147_483_647;
const activityIdNumber = z.number().int().positive().max(MAX_ACTIVITY_ID, "Activity ID is too large");
const activityId = z
  .union([
    activityIdNumber,
    z
      .string()
      .max(10, "Activity ID is too large")
      .regex(/^\d+$/, "Activity ID must be numeric")
      .transform(Number)
      .pipe(activityIdNumber),
    z.null(),
  ])
  .default(null);
```

and after `export type ListQuery = z.infer<typeof listQuerySchema>;` add:

```ts
/** `GET /forecast` (spec addendum §11): one page of the merged releases and activities. */
export const forecastQuerySchema = z.object({ page: z.coerce.number().int().min(1).max(1000).default(1) });
export type ForecastQuery = z.infer<typeof forecastQuerySchema>;
```

Append to `packages/nrms-contract/src/types.ts`:

```ts
/** Legacy's pre-fill from a Calendar activity (News/ReleaseManagement/New.aspx:625-700), in NRMS's own keys. */
export interface ReleasePrefill {
  /** The activity's start, as the planned publish time. */
  publishAt: string | null;
  /** The activity's city, without ", BC", at most 50 characters. */
  location: string;
  /** The lead ministry, then the shared ones: only ministries NRMS offers. */
  ministries: string[];
  leadMinistryKey: string | null;
  sectors: string[];
  themes: string[];
  tags: string[];
}

/**
 * `GET /calendar-activities/:id` (spec addendum §11). `unknown`: NRMS's projection has no such
 * id. `hidden`: confidential, or not one the caller can see in the Calendar; no detail leaves.
 */
export type ActivityLookup =
  | { id: number; state: "unknown" | "deleted" | "hidden" }
  | {
      id: number;
      state: "found";
      title: string;
      startAt: string | null;
      endAt: string | null;
      ministryName: string | null;
      location: string;
      /** "Translations required" (ReleaseModel.cs:530-541). */
      translations: string[];
      /** Null when the activity can't be planned against; `notEligible` says why. */
      prefill: ReleasePrefill | null;
      notEligible: string | null;
    };

/** A Calendar activity on the Forecast tab (ReleasesModel.cs:196-223). */
export interface ForecastActivity {
  activityId: number;
  title: string;
  details: string;
  ministryName: string | null;
  categoryNames: string[];
  location: string;
}

export type ForecastItem = { kind: "release"; at: string; release: ReleaseListItem } | { kind: "activity"; at: string; activity: ForecastActivity };

export interface ForecastPage extends ReleasePage<ForecastItem> {
  /** False when the caller has no Calendar access, so only releases are listed. */
  calendarActivities: boolean;
}
```

- [ ] **Step 6: Run the tests and the type-check**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/calendar-contract packages/config packages/nrms-contract apps/calendar/src/visibility.test.ts`

Expected: PASS. The Calendar's generated-matrix test (`visible()` and `visibleSql()` agree on 48 × 48) still passes against the moved function.

Run both `tsc` commands. Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/calendar-contract packages/config config/tenants/bc.json packages/nrms-contract apps/calendar/src/visibility.ts
git commit -m "feat(calendar-contract,config,nrms-contract): the visibility rule shared with NRMS, the Approved-category test and prefix, bounded activity ids, lookup and Forecast types"
```

---

### Task 2: Event routes: the News API never gets activity.* or release.status_changed; release status goes to the Calendar; Calendar access goes to NRMS

Covers: carry-forward items 1 and 3; spec §5.4, §11; C127. Decisions H2, H5.

Own review (confidentiality).

**Files:**
- Modify: `apps/stack/src/env.ts`, `apps/stack/src/env.test.ts`.

**Interfaces:**
- Consumes: `createProjectionHandlers` and `SOURCE_EVENT_TYPES` (`apps/news-api/src/projections.ts`, already imported by `env.ts`).
- Produces:
  - `newsApiEventTypesFromNrms(handlers?: Record<string, unknown>): string[]`;
  - `INTERNAL_EVENT_ROUTES`:
    - NRMS → NEWSAPI with explicit types;
    - NRMS → CALENDAR (`name: "calendar"`, `url: "self:/calendar/events"`, `types: ["release.status_changed"]`);
    - Core → NRMS with `user.upserted`.
  - The Calendar's `EVENT_SECRETS` gains `nrms`, automatically.

- [ ] **Step 1: Write the failing tests**

In `apps/stack/src/env.test.ts`, add `newsApiEventTypesFromNrms` to the `./env` import list, after `newsApiEventTypesFromCore`. Then change these existing expectations.

In "wires every sender to its receivers with matching per-route secrets", the Core → NRMS entry's types become:

```ts
        types: ["org.upserted", "org.deactivated", "user.upserted", "sector.upserted", "sector.deactivated", "theme.upserted", "theme.deactivated", "tag.upserted", "tag.deactivated"],
```

and NRMS's subscribers become:

```ts
    expect(nrms.map((s: { name: string; types: string[] }) => [s.name, s.types])).toEqual([
      ["news-api", ["release.published", "release.updated", "release.unpublished", "site.content.changed"]],
      ["nod", ["release.published", "release.updated", "release.unpublished", "media_list.created", "media_list.updated", "media_list.deactivated"]],
      ["calendar", ["release.status_changed"]],
    ]);
```

In "Core → NRMS taxonomy route", `toNrms.types` becomes the same nine-type list with `user.upserted` third.

Replace the test "subscribersFor(\"user.upserted\", ...) is empty for every one of Core's subscribers except the Calendar" with:

```ts
  it("subscribersFor(\"user.upserted\", ...) is empty for every one of Core's subscribers except the Calendar and NRMS", () => {
    const wiring = internalEventEnv("e".repeat(40));
    const coreSubs = JSON.parse(wiring.CORE.EVENT_SUBSCRIBERS!) as SubscriberConfig[];
    expect(subscribersFor("user.upserted", coreSubs).map((s) => s.name)).toEqual(["nrms", "calendar"]);
    const others = coreSubs.filter((s) => s.name !== "calendar" && s.name !== "nrms");
    expect(others.map((s) => s.name)).toEqual(["news-api", "nod"]);
    expect(subscribersFor("user.upserted", others)).toEqual([]);
  });
```

In "routes the Calendar's activity.* to NRMS by explicit type, and never to the News API (C127)", replace the three lines from `// A "*" route carries activity.*` through `expect(reaching.map((r) => r.source)).toEqual(["nrms"]);` with:

```ts
    // No route to the News API names activity.* or "*"; the News API's own source restriction,
    // checked below, would keep it out besides.
    const reaching = routes.filter((r) => r.to === "NEWSAPI" && r.types.some((t) => t === "*" || t.startsWith("activity.")));
    expect(reaching).toEqual([]);
```

Append to the end of the file:

```ts
// NRMS's release.status_changed carries an unpublished release's headline and
// its activity id. It goes to the Calendar alone; the News API's route from NRMS names its types.
describe("NRMS → Calendar release.status_changed route", () => {
  const SECRET = "x".repeat(40);
  const env = { CALENDAR_DATABASE_URL: "postgres://x/cal", STACK_EVENT_SECRET: SECRET };
  const nrmsSubs = () => JSON.parse(envFor(env, "NRMS").EVENT_SUBSCRIBERS!) as SubscriberConfig[];

  it("sends release.status_changed to the Calendar and to no one else", () => {
    expect(subscribersFor("release.status_changed", nrmsSubs()).map((s) => s.name)).toEqual(["calendar"]);
    expect(JSON.parse(envFor(env, "CALENDAR").EVENT_SECRETS!)).toHaveProperty("nrms");
  });

  it("no route says \"*\", and none carries release.status_changed or activity.* to the News API", () => {
    // Widened, so a future route the compiler would otherwise rule out is still checked here.
    const routes: readonly { to: string; types: readonly string[] }[] = INTERNAL_EVENT_ROUTES;
    expect(routes.filter((r) => r.types.includes("*"))).toEqual([]);
    const toNewsApi = routes.filter((r) => r.to === "NEWSAPI").flatMap((r) => r.types);
    expect(toNewsApi.filter((t) => t === "release.status_changed" || t.startsWith("activity."))).toEqual([]);
    expect(nrmsSubs().find((s) => s.name === "news-api")!.types).toEqual(["release.published", "release.updated", "release.unpublished", "site.content.changed"]);
  });

  it("names every NRMS type the News API handles, and only those, even if it grew a handler for release.status_changed", () => {
    const handled = () => Promise.resolve();
    const handlers = { "release.published": handled, "release.status_changed": handled, "activity.created": handled, "org.upserted": handled };
    expect(newsApiEventTypesFromNrms(handlers)).toEqual(["release.published"]);
  });

  it("no NRMS → Calendar route when the Calendar isn't configured", () => {
    const subs = JSON.parse(envFor({ STACK_EVENT_SECRET: SECRET }, "NRMS").EVENT_SUBSCRIBERS!) as SubscriberConfig[];
    expect(subs.map((s) => s.name)).toEqual(["news-api", "nod"]);
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/stack/src/env.test.ts`

Expected: FAIL. The file doesn't load, because `newsApiEventTypesFromNrms` is not exported by `./env`.

- [ ] **Step 3: Implement**

In `apps/stack/src/env.ts`, after `newsApiEventTypesFromCore`, add:

```ts
/** NRMS → News API: exactly the release and site types the News API handles. Never
 * release.status_changed (an unpublished headline and its Calendar activity) or activity.*, even
 * if the News API ever grew a handler for one (C127). */
export function newsApiEventTypesFromNrms(handlers: Record<string, unknown> = createProjectionHandlers()): string[] {
  return Object.keys(handlers).filter((type) => NEWS_API_SOURCE_EVENT_TYPES.nrms!(type) && type !== "release.status_changed" && !type.startsWith("activity."));
}
```

In `INTERNAL_EVENT_ROUTES`, replace the Core → NRMS entry with:

```ts
  {
    // user.upserted: Calendar roles and ministries, so NRMS's Forecast and activity lookup show
    // only what the Calendar would (spec addendum §6, §11). NRMS keeps no email or name.
    from: "CORE", source: "core", to: "NRMS", name: "nrms", url: "self:/nrms/events",
    types: ["org.upserted", "org.deactivated", "user.upserted", "sector.upserted", "sector.deactivated", "theme.upserted", "theme.deactivated", "tag.upserted", "tag.deactivated"],
  },
```

replace the NRMS → NEWSAPI entry with:

```ts
  { from: "NRMS", source: "nrms", to: "NEWSAPI", name: "news-api", url: "self:/events", types: newsApiEventTypesFromNrms() },
```

and add, before the NEWSAPI → SITE entry:

```ts
  {
    // Release status on the Calendar's activities (spec addendum §11). Only to the Calendar.
    from: "NRMS", source: "nrms", to: "CALENDAR", name: "calendar", url: "self:/calendar/events",
    types: ["release.status_changed"],
  },
```

- [ ] **Step 4: Run the stack's tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/stack/src`

Expected: PASS (191 tests at the dry run; `stack.test.ts`'s full stacks start with the new routes).

- [ ] **Step 5: Commit**

```bash
git add apps/stack/src/env.ts apps/stack/src/env.test.ts
git commit -m "feat(stack): NRMS's News API route names its types; release.status_changed to the Calendar only; user.upserted to NRMS"
```

---
### Task 3: NRMS's projections: the Calendar's activities (confidential as id only, deletion kept) and Core's Calendar access; the migration; the stack's backfill

Covers: carry-forward items 1 and 2; spec §11 ("NRMS's activity projection"), §5.4, §6; C127. Decisions H1, H2, H6, H15, H18, H19.

Own review (confidentiality and event handling).

**Files:**
- Create: `apps/nrms/src/calendar/projection.ts`, `apps/nrms/src/calendar/projection.test.ts`, `apps/nrms/test/events.ts`, `apps/nrms/migrations/0015_calendar_link.sql` and its `meta/0015_snapshot.json` (generated).
- Modify: `apps/nrms/src/db/schema.ts`, `apps/nrms/migrations/meta/_journal.json` (generated), `apps/nrms/src/taxonomy.ts`, `apps/nrms/src/app.ts`, `apps/nrms/src/start.ts`, `apps/stack/src/stack.ts`, `apps/stack/src/stack.test.ts`.

**Interfaces:**
- Consumes: `ActivityEvent`, `UserRecord`, `OrgRecord`, `EventHandler`, `EventEnvelope`, `signPayload` (`@gcpe/events`); `CalendarRole` (`@gcpe/auth`); `taxonomyHandler`.
- Produces:
  - schema `calendarActivities` (and `CalendarActivityRow`), `calendarViewers`, `organizations.isHq`;
  - `calendarHandler(event): EventHandler | undefined`;
  - `needsCalendarViewers(db): Promise<boolean>`;
  - the NRMS worker `needsCalendarViewers`.
  - Test helpers in `apps/nrms/test/events.ts`: `NRMS_EVENT_SECRETS`, `envelope(source, type, data, aggregateId, sequence?)`, `nextSequence()`, `sendEvent(app, event)`, `activityRecord(id, over?)`, `userRecord(id, over?)`, `orgRecord(key, over?)`.

- [ ] **Step 1: Write the test helpers and the failing tests**

Create `apps/nrms/test/events.ts`:

```ts
import { randomUUID } from "node:crypto";
import type express from "express";
import request from "supertest";
import { signPayload, type ActivityRecord, type OrgRecord, type UserRecord } from "@gcpe/events";

/** The receiver's secrets in NRMS tests: Core's reference data and users, the Calendar's activities. */
export const NRMS_EVENT_SECRETS = { core: "core-secret-for-nrms-tests", calendar: "calendar-secret-for-nrms-tests" } as const;

let seq = 0;
/** A signed-ready envelope; `sequence` defaults to the next number, so later calls are newer. */
export function envelope(source: string, type: string, data: unknown, aggregateId: string, sequence = ++seq) {
  return { id: randomUUID(), type, version: 1, source, aggregateId, sequence, occurredAt: new Date().toISOString(), correlationId: randomUUID(), data };
}
export const nextSequence = () => ++seq;

/** POSTs a signed event to the app's receiver, as a subscriber's dispatcher would. */
export function sendEvent(app: express.Express, event: ReturnType<typeof envelope>): Promise<request.Response> {
  const body = JSON.stringify(event);
  const ts = new Date().toISOString();
  const secret = NRMS_EVENT_SECRETS[event.source as keyof typeof NRMS_EVENT_SECRETS];
  return request(app)
    .post("/events")
    .set("content-type", "application/json")
    .set("x-event-source", event.source)
    .set("x-event-timestamp", ts)
    .set("x-signature", secret ? signPayload(secret, ts, body) : "bad-signature")
    .send(body);
}

/** A non-confidential activity as the Calendar sends it (spec addendum §5.4). Fictional values. */
export function activityRecord(id: number, over: Partial<ActivityRecord> = {}): ActivityRecord {
  return {
    id, isConfidential: false, isDeleted: false, title: `Sample activity ${id}`, details: "Sample details.",
    startAt: "2031-06-11T17:00:00.000Z", endAt: "2031-06-11T18:00:00.000Z", nrAt: null, isAllDay: false, isConfirmed: true,
    contactMinistryKey: "health", sharedMinistryKeys: [], categoryNames: ["Approved Event"], cityName: "Victoria, BC",
    themeKeys: [], tagKeys: [], sectorKeys: ["health"], translations: [],
    ...over,
  };
}

export function userRecord(id: string, over: Partial<UserRecord> = {}): UserRecord {
  return { id, email: "planner@example.test", displayName: "Sample Planner", isActive: true, calendarRole: "Calendar.ReadOnly", organizationKeys: ["health"], ...over };
}

export function orgRecord(key: string, over: Partial<OrgRecord> = {}): OrgRecord {
  return {
    key, displayName: key, abbreviation: key.toUpperCase().slice(0, 6), sortOrder: 0, isActive: true, parentKey: null, url: null, displayAdditionalName: null,
    minister: { name: null, summary: null, detailsHtml: null, email: null, photoUrl: null, address: null },
    contact: null, secondContact: null, weekendContactNumber: null, social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null },
    topicLinks: [], serviceLinks: [], sectorKeys: [], isHq: false, isPublic: true, updatedAt: "2026-10-08T17:00:00Z",
    ...over,
  };
}
```

Create `apps/nrms/src/calendar/projection.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNrmsTestDb } from "../../test/helpers";
import { activityRecord, envelope, NRMS_EVENT_SECRETS, nextSequence, orgRecord, sendEvent, userRecord } from "../../test/events";
import { createApp } from "../app";
import { calendarActivities, calendarViewers, organizations } from "../db/schema";
import { needsCalendarViewers } from "./projection";

const PLANNER = "8a7f3c1e-2b4d-4e6f-9a0b-1c2d3e4f5a6b";

describe("NRMS's projections of the Calendar's activities and Core's Calendar access (spec addendum §11)", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  const row = async (id: number) => (await tdb.db.select().from(calendarActivities).where(eq(calendarActivities.id, id)))[0];
  /** Sends one event; returns the receiver's outcome ("applied", "stale", "duplicate" or "ignored"). */
  const send = async (source: string, type: string, data: unknown, aggregateId: string, sequence?: number) => {
    const res = await sendEvent(app, envelope(source, type, data, aggregateId, sequence));
    expect(res.status).toBe(200);
    return res.body.outcome as string;
  };
  const activity = (type: string, data: unknown, sequence?: number) => send("calendar", type, data, `activity:${(data as { id: number }).id}`, sequence);

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    app = createApp({ db: tdb.db, auth: { session: { secret: "z".repeat(40) } }, eventSecrets: NRMS_EVENT_SECRETS, workflow: { timeZone: "America/Vancouver" } });
  });
  afterAll(() => tdb.drop());

  it("keeps a non-confidential activity's Forecast fields, with Core keys exactly as sent", async () => {
    expect(await activity("activity.created", activityRecord(4101, { contactMinistryKey: "5F3A9C2E-HEALTH", sharedMinistryKeys: ["finance"], translations: ["French"] }))).toBe("applied");
    expect(await row(4101)).toMatchObject({
      isConfidential: false, isDeleted: false, title: "Sample activity 4101", contactMinistryKey: "5F3A9C2E-HEALTH", sharedMinistryKeys: ["finance"],
      categoryNames: ["Approved Event"], cityName: "Victoria, BC", sectorKeys: ["health"], translations: ["French"], startAt: new Date("2031-06-11T17:00:00.000Z"),
    });
  });

  it("holds a confidential activity as its id only, and wipes the text of one made confidential", async () => {
    await activity("activity.created", { id: 4102, isConfidential: true, isDeleted: false });
    expect(await row(4102)).toMatchObject({ isConfidential: true, isDeleted: false, title: null, details: null, startAt: null, contactMinistryKey: null, sharedMinistryKeys: [], categoryNames: [], translations: [] });
    await activity("activity.updated", { id: 4101, isConfidential: true, isDeleted: false });
    expect(await row(4101)).toMatchObject({ isConfidential: true, title: null, details: null, cityName: null, contactMinistryKey: null, sharedMinistryKeys: [], sectorKeys: [], translations: [] });
  });

  it("the database refuses text on a confidential row, whatever writes it (C127)", async () => {
    await expect(tdb.db.insert(calendarActivities).values({ id: 4199, isConfidential: true, isDeleted: false, title: "leak" })).rejects.toThrow();
  });

  it("a deleted activity stays deleted: activity.deleted, then activity.updated with isDeleted (review, Clear LA Status)", async () => {
    await activity("activity.created", activityRecord(4103));
    await activity("activity.deleted", { id: 4103 });
    expect((await row(4103))!.isDeleted).toBe(true);
    await activity("activity.updated", activityRecord(4103, { isDeleted: true, title: "Reviewed after deletion" }));
    expect(await row(4103)).toMatchObject({ isDeleted: true, title: "Reviewed after deletion" });
  });

  it("an older event arriving late, a duplicate, and a dead letter replayed after a newer one change nothing", async () => {
    const first = nextSequence();
    const second = nextSequence();
    expect(await activity("activity.deleted", { id: 4104 }, second)).toBe("applied");
    expect(await activity("activity.created", activityRecord(4104), first)).toBe("stale");
    expect(await row(4104)).toMatchObject({ isDeleted: true, isConfidential: true, title: null });
    const again = envelope("calendar", "activity.updated", activityRecord(4104, { isDeleted: true }), "activity:4104");
    expect((await sendEvent(app, again)).body.outcome).toBe("applied");
    expect((await sendEvent(app, again)).body.outcome).toBe("duplicate");
  });

  it("activity.deleted for an activity never seen keeps an id-only deleted row, so its id still resolves", async () => {
    await activity("activity.deleted", { id: 4105 });
    expect(await row(4105)).toMatchObject({ isDeleted: true, isConfidential: true, title: null });
  });

  it("activity.* is taken only from the Calendar, user.upserted only from Core", async () => {
    expect(await send("core", "activity.created", activityRecord(4106), "activity:4106")).toBe("ignored");
    expect(await row(4106)).toBeUndefined();
  });

  it("keeps each user's Calendar role, ministries and active state, and no email or name", async () => {
    expect(await send("core", "user.upserted", userRecord(PLANNER.toUpperCase(), { organizationKeys: ["Health", "finance", "Health"] }), `user:${PLANNER}`)).toBe("applied");
    const [v] = await tdb.db.select().from(calendarViewers).where(eq(calendarViewers.userId, PLANNER));
    expect(v).toEqual({ userId: PLANNER, isActive: true, calendarRole: "Calendar.ReadOnly", organizationKeys: ["Health", "finance"] });
    await send("core", "user.upserted", userRecord(PLANNER, { calendarRole: null, isActive: false }), `user:${PLANNER}`);
    expect((await tdb.db.select().from(calendarViewers).where(eq(calendarViewers.userId, PLANNER)))[0]).toMatchObject({ isActive: false, calendarRole: null });
  });

  it("keeps an organization's HQ flag", async () => {
    await send("core", "org.upserted", orgRecord("GCPE-HQ", { isHq: true }), "org:GCPE-HQ");
    expect((await tdb.db.select().from(organizations).where(eq(organizations.key, "gcpe-hq")))[0]).toMatchObject({ isHq: true });
  });

  it("needs Calendar viewers until Core's users arrive", async () => {
    const fresh = await createNrmsTestDb();
    try {
      expect(await needsCalendarViewers(fresh.db)).toBe(true);
      expect(await needsCalendarViewers(tdb.db)).toBe(false);
    } finally {
      await fresh.drop();
    }
  });
});
```

In `apps/stack/src/stack.test.ts`, import `createUser` and `createUserSchema` from `../../core/src/services/users`. In "apps/stack: reference-data backfill (Task 2 fix round 1)", before "a NoD that already has a ministry list is left alone…", add:

```ts
  it("an NRMS with no Calendar viewers yet gets Core's users from the backfill, when the Calendar is mounted", async () => {
    const stack = await setupStack({
      fetchAdminToken: false,
      beforeStart: async (dbs) => {
        // NoD and the Calendar already have reference data, so only NRMS's need can start the backfill.
        await dbs.nod.pool.query("INSERT INTO lists (list_key, category, key, name) VALUES ('ministries:placeholder', 'ministries', 'placeholder', 'Placeholder')");
        await dbs.calendar!.pool.query("INSERT INTO orgs (key, display_name, sort_order, is_active) VALUES ('placeholder', 'Placeholder', 0, true)");
        await createUser(dbs.core.db, createUserSchema.parse({ email: "planner@example.test", displayName: "Sample Planner", roles: ["NRMS.Editor"], password: "a sample password 1" }), []);
      },
    });
    try {
      const nrmsHasViewers = async (): Promise<boolean> => {
        await fetch(`${stack.stackUrl}/stack/tick`, { method: "POST", headers: { authorization: `Bearer ${stack.tickToken}` } });
        const rows = await stack.dbs.nrms.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM calendar_viewers");
        return rows.rows[0]!.n > 0;
      };
      await expect.poll(nrmsHasViewers, { timeout: 5000 }).toBe(true);
    } finally {
      await stack.close();
    }
  });
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nrms/src/calendar/projection.test.ts`
Expected: FAIL: "Cannot find module './projection'".

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/stack/src/stack.test.ts -t "Calendar viewers"`
Expected: FAIL: the poll times out ("Matcher did not succeed in time"), its last attempt failing because NRMS has no `calendar_viewers` table yet.

- [ ] **Step 3: The schema and the migration**

In `apps/nrms/src/db/schema.ts`:
- Add `import type { CalendarRole } from "@gcpe/auth";` before the `@gcpe/events` import.
- In `organizations`, after `isActive`, add:

```ts
  /** Core's HQ flag (spec addendum §4): a member of an HQ organization sees every ministry's activities. */
  isHq: boolean("is_hq").notNull().default(false),
```

- In `newsReleases`' indexes, after `news_releases_status_idx`, add:

```ts
    // Forecast: every release planned or scheduled from now on (spec addendum §11).
    index("news_releases_publish_at_idx").on(t.publishAt),
```

- Append:

```ts
const keyList = (name: string) => text(name).array().notNull().default(sql`'{}'::text[]`);

/**
 * The Calendar's activities, from its activity.* events (spec addendum §11): what Forecast and the
 * release editor's lookup read. A confidential activity is its id, the flag and deletion only; the
 * CHECK keeps every other column empty whatever writes the row (C127). Core keys are kept exactly
 * as the Calendar sent them, for its visibility rule; NRMS's own keys are their lowercase.
 */
export const calendarActivities = pgTable(
  "calendar_activities",
  {
    id: integer("id").primaryKey(),
    isConfidential: boolean("is_confidential").notNull(),
    isDeleted: boolean("is_deleted").notNull(),
    title: text("title"),
    details: text("details"),
    startAt: tz("start_at"),
    endAt: tz("end_at"),
    nrAt: tz("nr_at"),
    isAllDay: boolean("is_all_day"),
    isConfirmed: boolean("is_confirmed"),
    contactMinistryKey: text("contact_ministry_key"),
    sharedMinistryKeys: keyList("shared_ministry_keys"),
    categoryNames: keyList("category_names"),
    cityName: text("city_name"),
    themeKeys: keyList("theme_keys"),
    tagKeys: keyList("tag_keys"),
    sectorKeys: keyList("sector_keys"),
    translations: keyList("translations"),
  },
  (t) => [
    check(
      "calendar_activities_confidential_id_only",
      sql`NOT ${t.isConfidential} OR (${t.title} IS NULL AND ${t.details} IS NULL AND ${t.startAt} IS NULL AND ${t.endAt} IS NULL AND ${t.nrAt} IS NULL
        AND ${t.isAllDay} IS NULL AND ${t.isConfirmed} IS NULL AND ${t.contactMinistryKey} IS NULL AND ${t.cityName} IS NULL
        AND cardinality(${t.sharedMinistryKeys}) = 0 AND cardinality(${t.categoryNames}) = 0 AND cardinality(${t.themeKeys}) = 0
        AND cardinality(${t.tagKeys}) = 0 AND cardinality(${t.sectorKeys}) = 0 AND cardinality(${t.translations}) = 0)`,
    ),
    index("calendar_activities_forecast_idx").on(t.startAt).where(sql`NOT ${t.isConfidential} AND NOT ${t.isDeleted}`),
  ],
);
export type CalendarActivityRow = typeof calendarActivities.$inferSelect;

/**
 * Core's users, as user.upserted carries them, for the Calendar's visibility rule (spec addendum
 * §6): role, ministries (Core keys, exactly as sent) and active. Never an email or a name.
 */
export const calendarViewers = pgTable("calendar_viewers", {
  userId: uuid("user_id").primaryKey(),
  isActive: boolean("is_active").notNull(),
  calendarRole: text("calendar_role").$type<CalendarRole>(),
  organizationKeys: text("organization_keys").array().notNull().default(sql`'{}'::text[]`),
});
```

Generate: `cd apps/nrms && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name calendar_link && cd ../..`

Expected: `migrations/0015_calendar_link.sql` with exactly these statements, in drizzle-kit's order:
- `CREATE TABLE "calendar_activities"` with the CHECK `calendar_activities_confidential_id_only`;
- `CREATE TABLE "calendar_viewers"`;
- `ALTER TABLE "organizations" ADD COLUMN "is_hq" boolean DEFAULT false NOT NULL`;
- `CREATE INDEX "calendar_activities_forecast_idx" … WHERE NOT … is_confidential AND NOT … is_deleted`;
- `CREATE INDEX "news_releases_publish_at_idx"`.

Plus `meta/0015_snapshot.json` and a `_journal.json` entry. Don't edit them.

- [ ] **Step 4: The handlers and their wiring**

Create `apps/nrms/src/calendar/projection.ts`:

```ts
import { sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import type { ActivityEvent, EventEnvelope, EventHandler, UserRecord } from "@gcpe/events";
import { calendarActivities, calendarViewers } from "../db/schema";

// Ordering and redelivery are the receiver's job (packages/events/src/receiver.ts): it applies an
// event only when its sequence is past the activity's or user's last one, and acknowledges a
// duplicate without applying it. Each event carries the whole current state, so a handler simply
// replaces the row. The Calendar has no undelete: an activity it deleted arrives as deleted from
// then on (activity.deleted, then activity.updated with isDeleted when it is reviewed).

type ActivityRow = typeof calendarActivities.$inferInsert;

/** Every content column empty: what a confidential activity, or a deletion never seen live, keeps (C127). */
function idOnly(id: number, isDeleted: boolean): ActivityRow {
  return {
    id, isConfidential: true, isDeleted, title: null, details: null, startAt: null, endAt: null, nrAt: null, isAllDay: null, isConfirmed: null,
    contactMinistryKey: null, sharedMinistryKeys: [], categoryNames: [], cityName: null, themeKeys: [], tagKeys: [], sectorKeys: [], translations: [],
  };
}

const at = (iso: string | null) => (iso === null ? null : new Date(iso));

function rowOf(a: ActivityEvent): ActivityRow {
  if (a.isConfidential) return idOnly(a.id, a.isDeleted);
  return {
    id: a.id, isConfidential: false, isDeleted: a.isDeleted, title: a.title, details: a.details,
    startAt: at(a.startAt), endAt: at(a.endAt), nrAt: at(a.nrAt), isAllDay: a.isAllDay, isConfirmed: a.isConfirmed,
    contactMinistryKey: a.contactMinistryKey, sharedMinistryKeys: a.sharedMinistryKeys, categoryNames: a.categoryNames, cityName: a.cityName,
    themeKeys: a.themeKeys, tagKeys: a.tagKeys, sectorKeys: a.sectorKeys, translations: a.translations,
  };
}

const onActivity: EventHandler = async (tx, e) => {
  const row = rowOf(e.data as ActivityEvent);
  await tx.insert(calendarActivities).values(row).onConflictDoUpdate({ target: calendarActivities.id, set: row });
};

/** Marks it deleted and keeps whatever else the row holds; an activity never seen becomes an id-only deleted row. */
const onActivityDeleted: EventHandler = async (tx, e) => {
  const { id } = e.data as { id: number };
  await tx.insert(calendarActivities).values(idOnly(id, true)).onConflictDoUpdate({ target: calendarActivities.id, set: { isDeleted: true } });
};

/** Core's user.upserted: the Calendar role, ministries and active state. The email and name are dropped. */
const onUser: EventHandler = async (tx, e) => {
  const u = e.data as UserRecord;
  const row = { userId: u.id.toLowerCase(), isActive: u.isActive, calendarRole: u.calendarRole, organizationKeys: [...new Set(u.organizationKeys)].sort() };
  await tx.insert(calendarViewers).values(row).onConflictDoUpdate({ target: calendarViewers.userId, set: row });
};

/** The Calendar's activity.* (from the Calendar only) and Core's user.upserted (from Core only). */
export function calendarHandler(event: EventEnvelope): EventHandler | undefined {
  if (event.source === "calendar") {
    if (event.type === "activity.created" || event.type === "activity.updated") return onActivity;
    if (event.type === "activity.deleted") return onActivityDeleted;
    return undefined;
  }
  if (event.source === "core" && event.type === "user.upserted") return onUser;
  return undefined;
}

/** True until Core's users have reached NRMS; the stack then asks Core to republish. */
export async function needsCalendarViewers(db: DbOrTx): Promise<boolean> {
  const r = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${calendarViewers}`);
  return r.rows[0]!.n === 0;
}
```

In `apps/nrms/src/taxonomy.ts`, `upsertOrg`'s row gains the flag:

```ts
  const row = { key: o.key.toLowerCase(), displayName: o.displayName, abbreviation: o.abbreviation, sortOrder: o.sortOrder, isActive: o.isActive, isHq: o.isHq };
```

In `apps/nrms/src/app.ts`, import `calendarHandler` from `./calendar/projection`. The receiver takes both handlers (each restricts its own sources):

```ts
  app.use(createEventReceiver({ db: deps.db, secrets: deps.eventSecrets, handlers: (e) => taxonomyHandler(e) ?? calendarHandler(e) }));
```

In `apps/nrms/src/start.ts`, import `needsCalendarViewers` from `./calendar/projection`, and add to `workers`, after `dispatch`:

```ts
      needsCalendarViewers: () => needsCalendarViewers(db),
```

In `apps/stack/src/stack.ts`, the reference-data backfill becomes:

```ts
  // NoD's lists, the Calendar's organizations, terms and users, and (with the Calendar mounted)
  // NRMS's Calendar viewers come from Core's events, which only flow on change. A fresh app with
  // no reference data yet (first deploy, or a fresh database) would otherwise stay empty until each
  // record next changed in Core, so it asks Core to republish everything once; the events reach
  // it on the next dispatch tick. Fire-and-forget, never throws.
  void (async () => {
    try {
      const nodNeeds = (await worker(nod, "needsReferenceData")()) === true;
      const calendarNeeds = calendar ? (await worker(calendar, "needsReferenceData")()) === true : false;
      const nrmsNeeds = calendar ? (await worker(nrms, "needsCalendarViewers")()) === true : false;
      if (nodNeeds || calendarNeeds || nrmsNeeds) {
        const n = await worker(core, "republish")();
        console.log(`[stack] ${[nodNeeds && "NoD", calendarNeeds && "the Calendar", nrmsNeeds && "NRMS"].filter(Boolean).join(" and ")} had no reference data; Core republished ${String(n)} records`);
```

(the `}` closing the `if`, and the `catch`, are unchanged).

- [ ] **Step 5: Run the tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nrms/src/calendar apps/nrms/src/taxonomy.test.ts`
Expected: PASS (12 tests).

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/stack/src/stack.test.ts -t "backfill"`
Expected: PASS (3 tests, the NoD ones unchanged).

Run the NRMS and stack suites (`apps/nrms apps/stack`) and both `tsc` commands.
Expected: PASS, no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/nrms/src/db/schema.ts apps/nrms/migrations apps/nrms/src/calendar apps/nrms/test/events.ts apps/nrms/src/taxonomy.ts apps/nrms/src/app.ts apps/nrms/src/start.ts apps/stack/src/stack.ts apps/stack/src/stack.test.ts
git commit -m "feat(nrms,stack): NRMS's projections of the Calendar's activities (confidential as id only, deletions kept) and of Core's Calendar access; the stack backfills them"
```

---

### Task 4: NRMS sends release.status_changed: settled statuses, every link change, in the write's transaction

Covers: spec §11 ("When NRMS emits it"), §5.4, §16 (event contract); C143. Decisions H7, H8.

Own review (event handling).

**Files:**
- Create: `apps/nrms/src/releases/link-events.ts`, `apps/nrms/src/releases/link-events.test.ts`.
- Modify: `apps/nrms/src/releases/service.ts`, `apps/nrms/src/releases/workflow.ts`, `apps/nrms/src/publisher.ts`, `apps/nrms/src/http/routes.ts`, `apps/nrms/test/helpers.ts`.

**Interfaces:**
- Consumes: `calendarActivities` (Task 3); `enqueueEvent`, `ReleaseStatusChanged`, `SubscriberConfig` (`@gcpe/events`); `mutateRelease`'s callbacks.
- Produces:
  - `interface LinkState { releaseId; key; reference; type; activityId; status; publishAt; releasedAt; headline }`;
  - `linkStateOf(tx, releaseId): Promise<LinkState | null>`;
  - `settledStatus(status): ReleaseStatus`;
  - `statusChangedData(now: LinkState, previousActivityId: number | null): ReleaseStatusChanged`;
  - `sendStatusChanged(tx, data, subscribers): Promise<void>`;
  - `emitLinkChange(tx, before: LinkState | null, after: LinkState | null, subscribers): Promise<void>`.
  - `WorkflowDeps.subscribers?: SubscriberConfig[]`.
  - New last parameters `createRelease(db, input, actor, deps?, subscribers = [])` and `cancel(db, id, version, actor, subscribers = [])`.
  - Test helper `seedActivity(db, id, over?)` in `apps/nrms/test/helpers.ts`.

- [ ] **Step 1: Write the helper and the failing tests**

Append to `apps/nrms/test/helpers.ts`, and import `calendarActivities` from `../src/db/schema` beside the others:

```ts
/** A live, non-confidential Calendar activity in NRMS's projection, as activity.* would leave it. Fictional values. */
export async function seedActivity(db: Db, id: number, over: Partial<typeof calendarActivities.$inferInsert> = {}): Promise<void> {
  const row = {
    id, isConfidential: false, isDeleted: false, title: `Sample activity ${id}`, details: "Sample details.",
    startAt: new Date("2031-06-11T17:00:00Z"), endAt: new Date("2031-06-11T18:00:00Z"), nrAt: null, isAllDay: false, isConfirmed: true,
    contactMinistryKey: "health", sharedMinistryKeys: [], categoryNames: ["Approved Event"], cityName: "Victoria, BC",
    themeKeys: [], tagKeys: [], sectorKeys: ["health"], translations: [],
    ...over,
  };
  await db.insert(calendarActivities).values(row).onConflictDoUpdate({ target: calendarActivities.id, set: row });
}
```

Create `apps/nrms/src/releases/link-events.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import { mintSession } from "@gcpe/auth";
import type { TestDatabase } from "@gcpe/db-kit";
import type { ReleaseStatusChanged, SubscriberConfig } from "@gcpe/events";
import { createNrmsTestDb, editor, sampleCreate, seedActivity, seedTaxonomy } from "../../test/helpers";
import { createApp } from "../app";
import { publishDue } from "../publisher";
import { createRelease, deleteRelease, saveDocumentLanguage, saveSettings } from "./service";
import { approve, cancel, schedule, unpublish } from "./workflow";

const subscribers: SubscriberConfig[] = [{ name: "calendar", url: "http://calendar.invalid/events", secret: "s".repeat(40), types: ["release.status_changed"] }];
const deps = { timeZone: "America/Vancouver", subscribers };
const settings = { plannedPublishAt: null, toSubscribers: false, toMediaLists: false, mediaListKeys: [] as string[] };

describe("release.status_changed (spec addendum §11): NRMS tells the Calendar each settled status and every link change", () => {
  let tdb: TestDatabase;
  const db = () => tdb.db;
  /** Every release.status_changed enqueued so far, oldest first, with its delivery targets. */
  const sent = async () =>
    (
      await tdb.pool.query(
        `SELECT e.aggregate_id, e.sequence, e.envelope, array(SELECT d.subscriber FROM outbox_deliveries d WHERE d.event_id = e.id) AS targets
         FROM outbox_events e WHERE e.type = 'release.status_changed' ORDER BY e.created_at, e.sequence`,
      )
    ).rows.map((r) => ({ aggregateId: r.aggregate_id as string, sequence: r.sequence as number, targets: r.targets as string[], data: (r.envelope as { data: ReleaseStatusChanged }).data }));

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    await seedTaxonomy(tdb.db);
    for (const id of [4101, 4102]) await seedActivity(tdb.db, id);
  });
  afterAll(() => tdb.drop());
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE news_releases, outbox_events, outbox_deliveries, aggregate_sequences CASCADE");
  });

  it("a release never linked to an activity sends nothing", async () => {
    const v = await createRelease(db(), sampleCreate, editor, undefined, subscribers);
    await approve(db(), v.id, v.version, editor, deps);
    expect(await sent()).toEqual([]);
  });

  it("draft, approved, scheduled, published, then unpublished back to approved: one event each, in order, to the Calendar", async () => {
    const created = await createRelease(db(), { ...sampleCreate, activityId: 4101 }, editor, undefined, subscribers);
    const approved = await approve(db(), created.id, created.version, editor, deps);
    const scheduled = await schedule(db(), created.id, { version: approved.version, publishAt: "now" }, editor, deps);
    await publishDue({ db: db(), subscribers });
    const live = await unpublish(db(), created.id, scheduled.version + 1, editor);
    expect(live.status).toBe("unpublishing");
    await publishDue({ db: db(), subscribers });
    const events = await sent();
    expect(events.map((e) => e.data.status)).toEqual(["draft", "approved", "scheduled", "published", "approved"]);
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(events.every((e) => e.aggregateId === `release:${created.id}` && e.targets.join() === "calendar")).toBe(true);
    expect(events[0]!.data).toEqual({
      releaseId: created.id, key: null, reference: null, type: "release", activityId: 4101, previousActivityId: null,
      status: "draft", publishAt: null, releasedAt: null, headline: sampleCreate.headline,
    });
    expect(events[1]!.data).toMatchObject({ reference: approved.reference, key: approved.key });
    expect(events[3]!.data).toMatchObject({ status: "published", releasedAt: scheduled.publishAt });
  });

  it("a correction of a live release reads as published throughout: nothing is sent for it", async () => {
    const created = await createRelease(db(), { ...sampleCreate, activityId: 4101 }, editor, undefined, subscribers);
    const approved = await approve(db(), created.id, created.version, editor, deps);
    await schedule(db(), created.id, { version: approved.version, publishAt: "now" }, editor, deps);
    await publishDue({ db: db(), subscribers });
    const before = (await sent()).length;
    const doc = approved.documents[0]!;
    const edited = await saveDocumentLanguage(db(), created.id, doc.id, 4105, {
      version: approved.version + 2, pageTitle: "News Release", layout: "formal", headline: "A corrected headline", subheadline: null,
      organizations: "Ministry of Health", byline: null, bodyHtml: "<p>Corrected.</p>", pageImageId: null, contacts: [],
    }, editor);
    expect(edited.status).toBe("publishing");
    await publishDue({ db: db(), subscribers });
    expect((await sent()).length).toBe(before);
  });

  it("moving the link sends the old activity as previousActivityId; clearing it sends no activity", async () => {
    const v = await createRelease(db(), { ...sampleCreate, activityId: 4101 }, editor, undefined, subscribers);
    const moved = await saveSettings(db(), v.id, { ...settings, version: v.version, activityId: 4102 }, editor, deps);
    await saveSettings(db(), v.id, { ...settings, version: moved.version, activityId: null }, editor, deps);
    expect((await sent()).map((e) => [e.data.activityId, e.data.previousActivityId])).toEqual([[4101, null], [4102, 4101], [null, 4102]]);
  });

  it("a planned publish time change is sent; a saved setting that changes nothing the Calendar shows isn't", async () => {
    const v = await createRelease(db(), { ...sampleCreate, activityId: 4101 }, editor, undefined, subscribers);
    const planned = await saveSettings(db(), v.id, { ...settings, version: v.version, activityId: 4101, plannedPublishAt: "2031-06-11T17:00:00Z" }, editor, deps);
    await saveSettings(db(), v.id, { ...settings, version: planned.version, activityId: 4101, plannedPublishAt: "2031-06-11T17:00:00Z", toSubscribers: true }, editor, deps);
    expect((await sent()).map((e) => e.data.publishAt)).toEqual([null, "2031-06-11T17:00:00.000Z"]);
  });

  it("cancel, a failed publish, a hidden delete and a hard delete are each sent", async () => {
    const a = await createRelease(db(), { ...sampleCreate, activityId: 4101 }, editor, undefined, subscribers);
    const aOk = await approve(db(), a.id, a.version, editor, deps);
    const aSched = await schedule(db(), a.id, { version: aOk.version, publishAt: "now" }, editor, deps);
    const aBack = await cancel(db(), a.id, aSched.version, editor, subscribers);
    // A body the publisher refuses, so the publish fails.
    const doc = aBack.documents[0]!;
    await tdb.db.execute(sql`UPDATE document_languages SET body_html = '' WHERE document_id = ${doc.id}`);
    await tdb.db.execute(sql`UPDATE news_releases SET status = 'scheduled', publish_at = now() - interval '1 minute' WHERE id = ${a.id}`);
    expect((await publishDue({ db: db(), subscribers })).failed).toHaveLength(1);
    const failed = await tdb.pool.query("SELECT version FROM news_releases WHERE id = $1", [a.id]);
    await deleteRelease(db(), a.id, failed.rows[0].version as number, editor, undefined, subscribers);
    const b = await createRelease(db(), { ...sampleCreate, activityId: 4102 }, editor, undefined, subscribers);
    expect(await deleteRelease(db(), b.id, b.version, editor, undefined, subscribers)).toBe("deleted");
    const statuses = (await sent()).map((e) => [e.data.activityId, e.data.status]);
    expect(statuses).toEqual([[4101, "draft"], [4101, "approved"], [4101, "scheduled"], [4101, "approved"], [4101, "failed"], [4101, "deleted"], [4102, "draft"], [4102, "deleted"]]);
  });

  it("the HTTP routes send it to the app's own subscribers: create, settings, approve, schedule, cancel, delete", async () => {
    const secret = "z".repeat(40);
    const app = createApp({ db: db(), auth: { session: { secret } }, eventSecrets: {}, workflow: { timeZone: "America/Vancouver" }, subscribers });
    const cookie = `gcpe_session=${(await mintSession(secret, { id: "00000000-0000-4000-8000-0000000000e1", name: "Pat Editor", email: "pat@example.test", roles: ["NRMS.Editor"] })).token}`;
    const call = async (method: "post" | "put", path: string, body: object) => {
      const res = await request(app)[method](`/api${path}`).set("cookie", cookie).set("x-gcpe-request", "1").send(body);
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      return res.body as { id: string; version: number };
    };
    const v = await call("post", "/releases", { ...sampleCreate, activityId: 4101 });
    const s = await call("put", `/releases/${v.id}/settings`, { ...settings, version: v.version, activityId: 4102 });
    const a = await call("post", `/releases/${v.id}/approve`, { version: s.version });
    const sc = await call("post", `/releases/${v.id}/schedule`, { version: a.version, publishAt: "2031-06-11T17:00:00Z" });
    const c = await call("post", `/releases/${v.id}/cancel`, { version: sc.version });
    await call("post", `/releases/${v.id}/delete`, { version: c.version });
    const events = await sent();
    expect(events.map((e) => e.data.status)).toEqual(["draft", "draft", "approved", "scheduled", "approved", "deleted"]);
    expect(events.every((e) => e.targets.join() === "calendar")).toBe(true);
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nrms/src/releases/link-events.test.ts`

Expected: FAIL. Five tests show `expected [] to deeply equal …`, because nothing is sent yet.
- "a release never linked to an activity sends nothing" passes.
- "a correction … reads as published throughout" passes as well, trivially, while nothing is sent at all. It is the guard that stays meaningful once sends exist (Step 4 re-runs it).

- [ ] **Step 3: Implement the sender**

Create `apps/nrms/src/releases/link-events.ts`:

```ts
import { and, asc, eq } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import { enqueueEvent, type ReleaseStatusChanged, type SubscriberConfig } from "@gcpe/events";
import { LANG_EN, type ReleaseStatus, type ReleaseType } from "@gcpe/nrms-contract";
import { documentLanguages, newsReleases, releaseDocuments } from "../db/schema";

/** What the Calendar keeps of a release (spec addendum §5.2 `release_links`). */
export interface LinkState {
  releaseId: string;
  key: string | null;
  reference: string | null;
  type: ReleaseType;
  activityId: number | null;
  status: ReleaseStatus;
  publishAt: string | null;
  releasedAt: string | null;
  headline: string | null;
}

export async function linkStateOf(tx: DbOrTx, releaseId: string): Promise<LinkState | null> {
  const [r] = await tx
    .select({
      key: newsReleases.key, reference: newsReleases.reference, type: newsReleases.type, activityId: newsReleases.activityId, status: newsReleases.status,
      publishAt: newsReleases.publishAt, releasedAt: newsReleases.releasedAt,
    })
    .from(newsReleases)
    .where(eq(newsReleases.id, releaseId));
  if (!r) return null;
  const [first] = await tx
    .select({ headline: documentLanguages.headline })
    .from(releaseDocuments)
    .innerJoin(documentLanguages, and(eq(documentLanguages.documentId, releaseDocuments.id), eq(documentLanguages.languageId, LANG_EN)))
    .where(eq(releaseDocuments.releaseId, releaseId))
    .orderBy(asc(releaseDocuments.sortIndex))
    .limit(1);
  return {
    releaseId, key: r.key, reference: r.reference, type: r.type, activityId: r.activityId, status: r.status,
    publishAt: r.publishAt?.toISOString() ?? null, releasedAt: r.releasedAt?.toISOString() ?? null, headline: first?.headline ?? null,
  };
}

/**
 * The status the Calendar shows. A correction (publishing) or an unpublish (unpublishing) in
 * progress is still on the site, so it reads as published until the publisher settles it.
 */
export function settledStatus(status: ReleaseStatus): ReleaseStatus {
  return status === "publishing" || status === "unpublishing" ? "published" : status;
}

/** The fields the Calendar shows. The key and headline travel with each event but don't cause one. */
const shown = (s: LinkState) => [s.activityId, settledStatus(s.status), s.publishAt, s.releasedAt, s.reference, s.type].join("|");

export function statusChangedData(now: LinkState, previousActivityId: number | null): ReleaseStatusChanged {
  return {
    releaseId: now.releaseId, key: now.key, reference: now.reference, type: now.type, activityId: now.activityId, previousActivityId,
    status: settledStatus(now.status), publishAt: now.publishAt, releasedAt: now.releasedAt, headline: now.headline,
  };
}

export async function sendStatusChanged(tx: DbOrTx, data: ReleaseStatusChanged, subscribers: SubscriberConfig[]): Promise<void> {
  await enqueueEvent(tx, { type: "release.status_changed", source: "nrms", aggregateId: `release:${data.releaseId}`, data }, subscribers);
}

/**
 * In the write's own transaction: sends release.status_changed when the write moved what the
 * Calendar shows of a release linked, before or after, to an activity. `after` null is a release
 * deleted for good. Ordering per release is the event's sequence on `release:<id>`.
 */
export async function emitLinkChange(tx: DbOrTx, before: LinkState | null, after: LinkState | null, subscribers: SubscriberConfig[]): Promise<void> {
  const now: LinkState | null = after ?? (before && { ...before, status: "deleted" });
  if (!now) return;
  const previous = before?.activityId ?? null;
  if (now.activityId === null && previous === null) return;
  if (before && shown(before) === shown(now)) return;
  await sendStatusChanged(tx, statusChangedData(now, previous !== now.activityId ? previous : null), subscribers);
}
```

- [ ] **Step 4: Call it at each status or link write**

`apps/nrms/src/releases/service.ts`: import `emitLinkChange` and `linkStateOf` from `./link-events`.
- `createRelease` gains a last parameter `subscribers: SubscriberConfig[] = []`. After `await writeLog(tx, id, actor, \`Created ${TYPE_LABEL[type]}\`);` add:

  ```ts
      await emitLinkChange(tx, null, await linkStateOf(tx, id), subscribers);
  ```

- `saveSettings`'s `deps` becomes `Pick<WorkflowDeps, "timeZone" | "subscribers">`. Its callback starts with `const before = await linkStateOf(tx, row.id);`. Just before `return "Updated publish settings";` add:

  ```ts
    await emitLinkChange(tx, before, await linkStateOf(tx, row.id), deps.subscribers ?? []);
  ```

- `deleteRelease`'s callback, right after the `DELETABLE_STATUSES` check, takes `const before = await linkStateOf(tx, row.id);`. After the hard delete (`await tx.delete(newsReleases)…`) add `await emitLinkChange(tx, before, null, subs);`. After the hide (`set({ status: "deleted" })`) add `await emitLinkChange(tx, before, await linkStateOf(tx, row.id), subs);`.

`apps/nrms/src/releases/workflow.ts`: import `type SubscriberConfig` from `@gcpe/events` (beside `indexKeysFor`), and `emitLinkChange` and `linkStateOf` from `./link-events`.
- `WorkflowDeps` gains:

  ```ts
  /** Who gets release.status_changed (the Calendar); unset → enqueued for no one. */
  subscribers?: SubscriberConfig[];
  ```

- `approve`: after the "Only a draft can be approved." check, `const before = await linkStateOf(tx, id);`. After the `try … catch` around the update, `await emitLinkChange(tx, before, await linkStateOf(tx, id), deps.subscribers ?? []);`.
- `schedule`: after the "Approve this release before scheduling it." check, `const before = await linkStateOf(tx, id);`. After `await dropUnfinishedFlickrJob(tx, id);`, the same `emitLinkChange` line.
- `cancel` becomes:

  ```ts
export async function cancel(db: Db, id: string, version: number, actor: Actor, subscribers: SubscriberConfig[] = []): Promise<ReleaseView> {
  return mutateRelease(
    db, id, version, actor,
    async (tx, row) => {
      if (row.status !== "scheduled") throw new ReleaseStateError("Only a scheduled release can be cancelled.");
      if (row.live) throw new ReleaseStateError("This release is live — save a correction or unpublish it instead.");
      const before = await linkStateOf(tx, id);
      await tx.update(newsReleases).set({ status: row.reference ? "approved" : "draft" }).where(eq(newsReleases.id, id));
      await dropUnfinishedFlickrJob(tx, id);
      await emitLinkChange(tx, before, await linkStateOf(tx, id), subscribers);
      return "Cancelled Release";
    },
    { correction: false },
  );
}
  ```

`apps/nrms/src/publisher.ts`: import `emitLinkChange` and `linkStateOf` from `./releases/link-events`.
- In `processOne`, after `const key = view.key ?? id;`, add `const before = await linkStateOf(tx, id);`.
- Before `return { kind: "unpublished", key };` and before the final `return { kind: goLive ? … };`, add `await emitLinkChange(tx, before, await linkStateOf(tx, id), opts.subscribers);`.
- In `publishDue`'s failure transaction, the first line becomes `const before = await linkStateOf(tx, c.id);`, and the log line becomes:

  ```ts
        if (updated.length) {
          await writeLog(tx, c.id, SYSTEM_ACTOR, `Publishing failed: ${message}`);
          await emitLinkChange(tx, before, await linkStateOf(tx, c.id), opts.subscribers);
        }
  ```

`apps/nrms/src/http/routes.ts` (it already imports `type WorkflowDeps`): after `withStatus`, add:

```ts
  const subscribers = deps.subscribers ?? [];
  // The workflow sends release.status_changed (the Calendar) to the app's own subscribers.
  const workflow: WorkflowDeps = { ...deps.workflow, subscribers };
```

Then:
- `createRelease(db, createReleaseSchema.parse(req.body), actorOf(req), deps.embeds, subscribers)`;
- the approve, schedule and settings routes pass `workflow` in place of `deps.workflow`;
- cancel calls `cancel(db, req.params.id, version(req), actorOf(req), subscribers)`;
- delete passes `subscribers` in place of `deps.subscribers ?? []`.

- [ ] **Step 5: Run the tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nrms/src/releases/link-events.test.ts`
Expected: PASS (7 tests).

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nrms`, and both `tsc` commands.
Expected: PASS. The publisher's own tests are unchanged: their releases have no activity, so nothing extra is enqueued.

- [ ] **Step 6: Commit**

```bash
git add apps/nrms/src/releases apps/nrms/src/publisher.ts apps/nrms/src/http/routes.ts apps/nrms/test/helpers.ts
git commit -m "feat(nrms): release.status_changed at each settled status and link change, in the write's transaction"
```

---

### Task 5: The Calendar's release projection: release.status_changed → BC Gov News and the list's icon

Covers: carry-forward item 3 (the Calendar's `projectionHandler` accepts `nrms`); spec §11 ("On the activity", "The Calendar ignores … an activity it doesn't hold"); §16 acceptance 13; C143, C158. Decisions H6, H9.

Own review (event handling).

**Files:**
- Create: `apps/calendar/src/release-links.test.ts`.
- Modify: `apps/calendar/src/projections.ts`.

**Interfaces:**
- Consumes: `releaseLinks`, `activities` (`apps/calendar/src/db/schema.ts`); `ReleaseStatusChanged`; `envelope`, `sendEvent`, `createTestApp` (`test/helpers.ts`); `insertRaw`, `seedWorld`, `call` (`test/world.ts`).
- Produces: `projectionHandler` takes `release.status_changed` from `nrms` only.

- [ ] **Step 1: Write the failing test**

Create `apps/calendar/src/release-links.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import type { ReleaseStatusChanged } from "@gcpe/events";
import { createCalendarTestDb, createTestApp, envelope, sendEvent } from "../test/helpers";
import { call, insertRaw, seedWorld, type World } from "../test/world";
import { activityCategories, releaseLinks } from "./db/schema";

const RELEASE = "8a7f3c1e-2b4d-4e6f-9a0b-1c2d3e4f5a01";
const OTHER_RELEASE = "8a7f3c1e-2b4d-4e6f-9a0b-1c2d3e4f5a02";

describe("the Calendar's release projection (spec addendum §11): release.status_changed → BC Gov News", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createTestApp>;
  let w: World;
  let a: number;
  let b: number;
  const change = (over: Partial<ReleaseStatusChanged> = {}): ReleaseStatusChanged => ({
    releaseId: RELEASE, key: null, reference: null, type: "release", activityId: a, previousActivityId: null,
    status: "draft", publishAt: "2031-06-11T17:00:00.000Z", releasedAt: null, headline: "Sample headline", ...over,
  });
  /** Sends one event from NRMS; returns the receiver's outcome. */
  const send = async (data: ReleaseStatusChanged, sequence?: number, source = "nrms") => {
    const e = envelope(source, "release.status_changed", data, `release:${data.releaseId}`);
    const res = await sendEvent(app, sequence === undefined ? e : { ...e, sequence });
    expect(res.status).toBe(200);
    return res.body.outcome as string;
  };
  const releasesOn = async (id: number) => (await call(app, "get", `/api/activities/${id}`, w.as.hqAdmin.cookie)).body.releases as { releaseId: string; status: string; reference: string | null }[];
  const links = () => tdb.db.select().from(releaseLinks);

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    w = await seedWorld(app, tdb.db);
    a = await insertRaw(tdb.db, { title: "Sample activity A" });
    b = await insertRaw(tdb.db, { title: "Sample activity B" });
  });
  afterAll(() => tdb.drop());

  it("a linked release shows on its activity, and each later status replaces the last", async () => {
    expect(await send(change())).toBe("applied");
    expect(await releasesOn(a)).toEqual([{ releaseId: RELEASE, type: "release", status: "draft", reference: null, publishAt: "2031-06-11T17:00:00.000Z", releasedAt: null }]);
    await send(change({ status: "published", reference: "NEWS-00001", key: "2031HLTH0001-000001", releasedAt: "2031-06-11T17:00:00.000Z" }));
    expect(await releasesOn(a)).toEqual([expect.objectContaining({ status: "published", reference: "NEWS-00001", releasedAt: "2031-06-11T17:00:00.000Z" })]);
    expect((await links())[0]).toMatchObject({ key: "2031HLTH0001-000001", headline: "Sample headline" });
  });

  it("the list's release icon follows it", async () => {
    await tdb.db.insert(activityCategories).values({ activityId: a, categoryId: w.cat.plain });
    const q = encodeURIComponent(JSON.stringify({ filter: { from: "2026-11-01", to: "2026-11-30", quickSearch: "Sample activity A" } }));
    const res = await call(app, "get", `/api/list?q=${q}`, w.as.hqAdmin.cookie);
    expect(res.body.rows.find((r: { id: number }) => r.id === a)).toMatchObject({ hasRelease: true });
  });

  it("an older status arriving late, or a replayed dead letter, changes nothing", async () => {
    expect(await send(change({ status: "scheduled" }), 1)).toBe("stale");
    expect((await releasesOn(a))[0]!.status).toBe("published");
  });

  it("moving the release to another activity moves it on the Calendar; clearing the link removes it", async () => {
    await send(change({ activityId: b, previousActivityId: a, status: "approved", reference: "NEWS-00001" }));
    expect(await releasesOn(a)).toEqual([]);
    expect((await releasesOn(b)).map((r) => r.releaseId)).toEqual([RELEASE]);
    await send(change({ activityId: null, previousActivityId: b }));
    expect(await releasesOn(b)).toEqual([]);
    expect(await links()).toEqual([]);
  });

  it("a deleted release leaves its activity: its row goes, and the list's icon with it (legacy showed active releases only)", async () => {
    await send(change({ releaseId: OTHER_RELEASE }));
    await send(change({ releaseId: OTHER_RELEASE, status: "deleted" }));
    expect(await releasesOn(a)).toEqual([]);
    expect(await tdb.db.select().from(releaseLinks).where(eq(releaseLinks.releaseId, OTHER_RELEASE))).toEqual([]);
  });

  it("a release linked to an activity the Calendar doesn't hold (not imported) is ignored, and drops a link it had", async () => {
    await send(change({ releaseId: OTHER_RELEASE, status: "draft" }));
    expect(await send(change({ releaseId: OTHER_RELEASE, activityId: 999_999, previousActivityId: a }))).toBe("applied");
    expect(await tdb.db.select().from(releaseLinks).where(eq(releaseLinks.releaseId, OTHER_RELEASE))).toEqual([]);
  });

  it("only NRMS may send it", async () => {
    expect(await send(change({ releaseId: OTHER_RELEASE }), undefined, "core")).toBe("ignored");
    expect(await tdb.db.select().from(releaseLinks).where(eq(releaseLinks.releaseId, OTHER_RELEASE))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/release-links.test.ts`

Expected: FAIL. Five tests fail, for example `expected 'ignored' to be 'applied'`.
- "the list's release icon follows it" fails on `hasRelease`.
- "only NRMS may send it" and "a deleted release leaves its activity…" pass already, because nothing is stored yet.

- [ ] **Step 3: Implement**

In `apps/calendar/src/projections.ts`:
- Import `ReleaseStatusChanged` from `@gcpe/events`, and `activities` and `releaseLinks` from `./db/schema`.
- Widen the file's opening comment to name the aggregates: "(a user, an organization, a term, a release)".
- Replace the doc comment and first line of `projectionHandler` with:

```ts
const at = (iso: string | null) => (iso === null ? null : new Date(iso));
```

The rest of the `switch` is unchanged.

- [ ] **Step 4: Run the Calendar's tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar`, and both `tsc` commands.
Expected: PASS (`release-links.test.ts` 7; `projections.test.ts` unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/calendar/src/projections.ts apps/calendar/src/release-links.test.ts
git commit -m "feat(calendar): NRMS's release.status_changed fills BC Gov News; a deleted, unlinked or not-imported release leaves no link"
```

---
### Task 6: The activity lookup, its visibility, and the rules for saving a release's activity id

Covers: spec §11 ("Activity lookup in the release editor": entering an id, pre-fill, translations, saving an id, "not deleted"; "Legacy activity <id>, not migrated"), §6 (one rule), §14 C142, C158; carry-forward's service-token notes (NRMS's Calendar viewer is session-only). Decisions H2, H3, H4, H10, H11, H19, H20.

Own review (confidentiality).

**Files:**
- Create: `apps/nrms/src/calendar/viewer.ts`, `apps/nrms/src/calendar/lookup.ts`, `apps/nrms/src/calendar/lookup.test.ts`.
- Modify:
  - `apps/nrms/src/releases/service.ts`, `apps/nrms/src/http/routes.ts`, `apps/nrms/src/app.ts`, `apps/nrms/src/start.ts`, `apps/nrms/package.json`, `package-lock.json`;
  - the five tests that link arbitrary ids: `apps/nrms/src/http/routes.test.ts`, `apps/nrms/src/releases/queries.test.ts`, `apps/nrms/src/releases/service.test.ts`, `apps/nrms/src/releases/service.rules.test.ts`, `tests/e2e/search.spec.ts`.

**Interfaces:**
- Consumes:
  - `visible`, `Viewer`, `VisibilityFacts`, `hasCategoryStartingWith` (Task 1);
  - `ActivityLookup`, `ReleasePrefill`, `MAX_ACTIVITY_ID` (Task 1);
  - `calendarActivities`, `calendarViewers`, `organizations.isHq` (Task 3);
  - `seedActivity` (Task 4);
  - `CALENDAR_LEVELS` (`@gcpe/auth`); `ReleaseRuleError`.
- Produces:
  - `calendarViewerOf(db, req): Promise<Viewer | null>`;
  - `interface LookupOptions { prefix: string | null; timeZone: string; nowMs: number }`;
  - `lookupActivity(db, viewer, id, options): Promise<ActivityLookup>`;
  - `assertActivityLinkable(db, next: number | null, current: number | null): Promise<void>`;
  - `bcDateOf(ms, timeZone): string`, `locationOf(cityName): string`, `factsOf(row): VisibilityFacts`;
  - `GET /nrms/api/calendar-activities/:activityId` (NRMS read roles; a malformed or out-of-range id is 404);
  - `createApp`'s and `RouteDeps`' `forecastCategoryPrefix?: string | null`, filled from the tenant by `startNrms`.

- [ ] **Step 1: Write the failing tests**

Create `apps/nrms/src/calendar/lookup.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import type { Request } from "express";
import type { TestDatabase } from "@gcpe/db-kit";
import { mintSession } from "@gcpe/auth";
import { createNrmsTestDb, sampleCreate, seedActivity, seedTaxonomy } from "../../test/helpers";
import { createApp } from "../app";
import { calendarViewers, organizations } from "../db/schema";
import { bcDateOf, lookupActivity } from "./lookup";
import { calendarViewerOf } from "./viewer";

const SECRET = "z".repeat(40) + "-calendar-lookup";
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PEOPLE = {
  hqReader: { id: uid(701), role: "Calendar.ReadOnly", orgs: ["gcpe-hq"] },
  healthEditor: { id: uid(702), role: "Calendar.Editor", orgs: ["health"] },
  financeReader: { id: uid(703), role: "Calendar.ReadOnly", orgs: ["finance"] },
  noRole: { id: uid(704), role: null, orgs: ["gcpe-hq"] },
  inactive: { id: uid(705), role: "Calendar.Administrator", orgs: ["gcpe-hq"], isActive: false },
  hqAdmin: { id: uid(706), role: "Calendar.Administrator", orgs: ["gcpe-hq"] },
} as const;
type Who = keyof typeof PEOPLE | "unknown";

describe("the release editor's activity lookup and the link it saves (spec addendum §11, C142)", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  const cookies = {} as Record<Who, string>;
  const lookup = (id: string | number, who: Who = "hqReader") => request(app).get(`/api/calendar-activities/${id}`).set("cookie", cookies[who]);
  const post = (path: string, body: object, method: "post" | "put" = "post") => request(app)[method](`/api${path}`).set("cookie", cookies.hqReader).set("x-gcpe-request", "1").send(body);

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    await seedTaxonomy(tdb.db);
    await tdb.db.insert(organizations).values({ key: "gcpe-hq", displayName: "Sample HQ", abbreviation: "HQ", isHq: true });
    await tdb.db.insert(organizations).values({ key: "retired", displayName: "Sample Retired", abbreviation: "RET", isActive: false });
    for (const p of Object.values(PEOPLE)) {
      await tdb.db.insert(calendarViewers).values({ userId: p.id, isActive: "isActive" in p ? p.isActive : true, calendarRole: p.role, organizationKeys: [...p.orgs] });
    }
    app = createApp({ db: tdb.db, auth: { session: { secret: SECRET } }, eventSecrets: {}, workflow: { timeZone: "America/Vancouver" }, forecastCategoryPrefix: "Approved" });
    const cookieOf = async (id: string) => `gcpe_session=${(await mintSession(SECRET, { id, name: "Sample Person", email: "person@example.test", roles: ["NRMS.Editor"] })).token}`;
    for (const [who, p] of Object.entries(PEOPLE)) cookies[who as Who] = await cookieOf(p.id);
    cookies.unknown = await cookieOf(uid(799));
    await seedActivity(tdb.db, 5001, {
      title: "Sample clinic opening", contactMinistryKey: "health", sharedMinistryKeys: ["finance", "retired"], cityName: "Victoria, BC",
      sectorKeys: ["health", "no-such-sector"], themeKeys: ["families"], tagKeys: ["covid-19"], translations: ["French"],
    });
    await seedActivity(tdb.db, 5002, { isConfidential: true, title: null, details: null, startAt: null, endAt: null, isAllDay: null, isConfirmed: null, contactMinistryKey: null, cityName: null, categoryNames: [], sectorKeys: [] });
    await seedActivity(tdb.db, 5003, { isDeleted: true });
    await seedActivity(tdb.db, 5004, { contactMinistryKey: "education" });
    await seedActivity(tdb.db, 5005, { categoryNames: ["Proposed Event"] });
    await seedActivity(tdb.db, 5006, { startAt: new Date("2020-06-11T17:00:00Z"), endAt: new Date("2020-06-11T18:00:00Z") });
    await seedActivity(tdb.db, 5007, { contactMinistryKey: "HEALTH" });
  });
  afterAll(() => tdb.drop());

  it("an eligible activity offers legacy's pre-fill, in NRMS's own keys, and its Translations as required", async () => {
    const res = await lookup(5001);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: 5001, state: "found", title: "Sample clinic opening", startAt: "2031-06-11T17:00:00.000Z", endAt: "2031-06-11T18:00:00.000Z",
      ministryName: "Health", location: "Victoria", translations: ["French"], notEligible: null,
      prefill: {
        publishAt: "2031-06-11T17:00:00.000Z", location: "Victoria", ministries: ["health", "finance"], leadMinistryKey: "health",
        sectors: ["health"], themes: ["families"], tags: ["covid-19"],
      },
    });
  });

  it("follows the Calendar's visibility: own or shared ministry, or HQ", async () => {
    expect((await lookup(5001, "healthEditor")).body.state).toBe("found");
    expect((await lookup(5001, "financeReader")).body.state).toBe("found");
    expect((await lookup(5004, "healthEditor")).body).toEqual({ id: 5004, state: "hidden" });
    expect((await lookup(5004, "hqReader")).body.state).toBe("found");
  });

  it("Core keys compare byte for byte, as in the Calendar; the pre-fill turns them into NRMS's lowercase keys", async () => {
    expect((await lookup(5007, "healthEditor")).body.state).toBe("hidden");
    expect((await lookup(5007, "hqReader")).body.prefill).toMatchObject({ ministries: ["health"], leadMinistryKey: "health" });
  });

  it("someone with no Calendar access learns only that the id exists", async () => {
    for (const who of ["noRole", "inactive", "unknown"] as const) expect((await lookup(5001, who)).body).toEqual({ id: 5001, state: "hidden" });
  });

  it("a confidential activity is hidden even from an HQ Administrator: NRMS holds no detail of it (C127)", async () => {
    expect((await lookup(5002, "hqAdmin")).body).toEqual({ id: 5002, state: "hidden" });
  });

  it("deleted and unknown ids say so, and pre-fill nothing", async () => {
    expect((await lookup(5003)).body).toEqual({ id: 5003, state: "deleted" });
    expect((await lookup(9999)).body).toEqual({ id: 9999, state: "unknown" });
  });

  it("a category not starting \"Approved\", or an activity that has ended, shows its details but pre-fills nothing", async () => {
    expect((await lookup(5005)).body).toMatchObject({ state: "found", prefill: null, notEligible: "Nothing is filled in: its category doesn't start with “Approved”." });
    expect((await lookup(5006)).body).toMatchObject({ state: "found", prefill: null, notEligible: "Nothing is filled in: it has ended." });
  });

  it("an activity ending today, BC time, can still be planned against; from tomorrow it can't (News/Services.asmx.cs:87)", async () => {
    const viewer = { level: 1, isHq: true, ministryKeys: ["gcpe-hq"] };
    const opts = { prefix: "Approved", timeZone: "America/Vancouver" };
    // 5001 ends 2031-06-11 11:00 BC (UTC−7).
    expect(await lookupActivity(tdb.db, viewer, 5001, { ...opts, nowMs: Date.parse("2031-06-12T06:59:00Z") })).toMatchObject({ state: "found", notEligible: null });
    expect(await lookupActivity(tdb.db, viewer, 5001, { ...opts, nowMs: Date.parse("2031-06-12T07:01:00Z") })).toMatchObject({ prefill: null, notEligible: "Nothing is filled in: it has ended." });
    expect(bcDateOf(Date.parse("2031-06-12T06:59:00Z"), "America/Vancouver")).toBe("2031-06-11");
  });

  it("a malformed or out-of-range id is not found, never a 500", async () => {
    for (const id of ["0", "abc", "-1", "2147483648", "12345678901", "1.5"]) expect((await lookup(id)).status).toBe(404);
  });

  it("only a staff session has Calendar visibility in NRMS: a bearer token sees no activity", async () => {
    const req = (via: string) => ({ auth: { subject: PEOPLE.hqReader.id, roles: ["NRMS.Editor"], claims: { via } } }) as unknown as Request;
    expect(await calendarViewerOf(tdb.db, req("session"))).toEqual({ level: 1, isHq: true, ministryKeys: ["gcpe-hq"] });
    expect(await calendarViewerOf(tdb.db, req("bearer"))).toBeNull();
  });

  it("saving: a new id must be known and not deleted; a confidential one can be linked; a stored legacy id stands until changed", async () => {
    expect((await post("/releases", { ...sampleCreate, activityId: 9999 })).body).toMatchObject({ problems: ["No Calendar activity has ID 9999."] });
    expect((await post("/releases", { ...sampleCreate, activityId: 5003 })).body).toMatchObject({ problems: ["Calendar activity 5003 has been deleted."] });
    const linked = await post("/releases", { ...sampleCreate, activityId: 5002 });
    expect(linked.status).toBe(201);
    // As the Phase 3 importer leaves a release linked to an activity that wasn't migrated (C158).
    await tdb.db.execute(sql`UPDATE news_releases SET activity_id = 777000 WHERE id = ${linked.body.id}`);
    const settings = { plannedPublishAt: null, toSubscribers: false, toMediaLists: false, mediaListKeys: [] };
    const kept = await post(`/releases/${linked.body.id}/settings`, { ...settings, version: linked.body.version, activityId: 777000 }, "put");
    expect(kept.status).toBe(200);
    const changed = await post(`/releases/${linked.body.id}/settings`, { ...settings, version: kept.body.version, activityId: 777001 }, "put");
    expect(changed.status).toBe(422);
    expect(changed.body.problems).toEqual(["No Calendar activity has ID 777001."]);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nrms/src/calendar/lookup.test.ts`
Expected: FAIL: "Cannot find module './lookup'".

- [ ] **Step 3: The dependency**

In `apps/nrms/package.json`'s `dependencies`, after `"@gcpe/auth": "0.0.0",`, add `"@gcpe/calendar-contract": "0.0.0",`.

Run `npx -y -p node@24 -- npm install --ignore-scripts`. Expected: `package-lock.json` gains that one line under `apps/nrms`, and nothing else.

- [ ] **Step 4: The viewer and the lookup**

Create `apps/nrms/src/calendar/viewer.ts`:

```ts
import type { Request } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx } from "@gcpe/db-kit";
import { CALENDAR_LEVELS } from "@gcpe/auth";
import type { Viewer } from "@gcpe/calendar-contract";
import { calendarViewers, organizations } from "../db/schema";

const isUuid = (s: string) => z.string().uuid().safeParse(s).success;

/**
 * The caller as the Calendar's visibility rule sees them (spec addendum §6), from Core's
 * user.upserted, or null for no Calendar access. Only a staff session counts: a bearer token
 * (break-glass or service) sees no activity, whatever its subject (the Calendar refuses bearer
 * tokens outright). HQ is any of the user's organizations flagged HQ, active or not, as in the
 * Calendar (Q56).
 */
export async function calendarViewerOf(db: DbOrTx, req: Request): Promise<Viewer | null> {
  if (req.auth?.claims.via !== "session" || !isUuid(req.auth.subject)) return null;
  const [v] = await db.select().from(calendarViewers).where(eq(calendarViewers.userId, req.auth.subject.toLowerCase()));
  if (!v || !v.isActive || !v.calendarRole) return null;
  const hq = v.organizationKeys.length
    ? await db.select({ key: organizations.key }).from(organizations).where(and(inArray(organizations.key, v.organizationKeys.map((k) => k.toLowerCase())), eq(organizations.isHq, true))).limit(1)
    : [];
  return { level: CALENDAR_LEVELS[v.calendarRole], isHq: hq.length > 0, ministryKeys: v.organizationKeys };
}
```

Create `apps/nrms/src/calendar/lookup.ts`:

```ts
import { and, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import { hasCategoryStartingWith, visible, type Viewer, type VisibilityFacts } from "@gcpe/calendar-contract";
import type { ActivityLookup, ReleasePrefill } from "@gcpe/nrms-contract";
import { calendarActivities, categoryTerms, organizations, type CalendarActivityRow } from "../db/schema";
import { ReleaseRuleError } from "../releases/errors";

export interface LookupOptions {
  /** The tenant's `calendar.forecastCategoryPrefix`; null when the tenant has no Calendar settings. */
  prefix: string | null;
  timeZone: string;
  nowMs: number;
}

/** "YYYY-MM-DD" in `timeZone`: the calendar day an instant falls on there. */
export function bcDateOf(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

/** Legacy's location: the city without ", BC" (News/Services.asmx.cs:118-128), within the release's 50 characters. */
export const locationOf = (cityName: string | null): string => (cityName ?? "").replaceAll(", BC", "").trim().slice(0, 50);

export const factsOf = (a: CalendarActivityRow): VisibilityFacts => ({
  contactMinistryKey: a.contactMinistryKey, sharedMinistryKeys: a.sharedMinistryKeys, isConfidential: a.isConfidential, isDeleted: a.isDeleted,
});

/** Whether a live, visible activity can be planned against (News/Services.asmx.cs:87); null when it can. */
function whyNotEligible(a: CalendarActivityRow, o: LookupOptions): string | null {
  if (o.prefix === null) return "Nothing is filled in: this site has no Calendar settings.";
  if (!hasCategoryStartingWith(a.categoryNames, o.prefix)) return `Nothing is filled in: its category doesn't start with “${o.prefix}”.`;
  if (a.endAt === null || bcDateOf(a.endAt.getTime(), o.timeZone) < bcDateOf(o.nowMs, o.timeZone)) return "Nothing is filled in: it has ended.";
  return null;
}

/** Keys NRMS offers (active), in the order given, lowercased as NRMS keeps them. */
async function activeKeys(db: DbOrTx, kind: "ministries" | "sectors" | "themes" | "tags", keys: readonly (string | null)[]): Promise<string[]> {
  const wanted = [...new Set(keys.flatMap((k) => (k ? [k.toLowerCase()] : [])))];
  if (wanted.length === 0) return [];
  const found =
    kind === "ministries"
      ? await db.select({ key: organizations.key }).from(organizations).where(and(inArray(organizations.key, wanted), eq(organizations.isActive, true)))
      : await db.select({ key: categoryTerms.key }).from(categoryTerms).where(and(eq(categoryTerms.kind, kind), inArray(categoryTerms.key, wanted), eq(categoryTerms.isActive, true)));
  const have = new Set(found.map((f) => f.key));
  return wanted.filter((k) => have.has(k));
}

/** Legacy's pre-fill (News/ReleaseManagement/New.aspx:625-700): publish time, location, ministries, sectors, themes and tags. */
async function prefillOf(db: DbOrTx, a: CalendarActivityRow): Promise<ReleasePrefill> {
  const ministries = await activeKeys(db, "ministries", [a.contactMinistryKey, ...a.sharedMinistryKeys]);
  const lead = a.contactMinistryKey?.toLowerCase() ?? null;
  return {
    publishAt: a.startAt?.toISOString() ?? null,
    location: locationOf(a.cityName),
    ministries,
    leadMinistryKey: lead !== null && ministries.includes(lead) ? lead : null,
    sectors: await activeKeys(db, "sectors", a.sectorKeys),
    themes: await activeKeys(db, "themes", a.themeKeys),
    tags: await activeKeys(db, "tags", a.tagKeys),
  };
}

/**
 * The release editor's lookup (spec addendum §11). It names an activity's state; detail leaves
 * only for an activity that isn't deleted or confidential and that `viewer` can see in the
 * Calendar (spec addendum §6).
 */
export async function lookupActivity(db: DbOrTx, viewer: Viewer | null, id: number, o: LookupOptions): Promise<ActivityLookup> {
  const [a] = await db.select().from(calendarActivities).where(eq(calendarActivities.id, id));
  if (!a) return { id, state: "unknown" };
  if (a.isDeleted) return { id, state: "deleted" };
  if (a.isConfidential || viewer === null || !visible(viewer, factsOf(a))) return { id, state: "hidden" };
  const [ministry] = a.contactMinistryKey
    ? await db.select({ name: organizations.displayName }).from(organizations).where(eq(organizations.key, a.contactMinistryKey.toLowerCase()))
    : [];
  const notEligible = whyNotEligible(a, o);
  return {
    id, state: "found", title: a.title ?? "", startAt: a.startAt?.toISOString() ?? null, endAt: a.endAt?.toISOString() ?? null,
    ministryName: ministry?.name ?? null, location: locationOf(a.cityName), translations: a.translations,
    prefill: notEligible === null ? await prefillOf(db, a) : null, notEligible,
  };
}

/**
 * Saving a release's activity id (C142): a new one must be an activity NRMS knows and that isn't
 * deleted. Confidential ids can be linked (NRMS holds them so typed ids resolve). An unchanged id
 * stands whatever it is: a release imported linked to an activity that wasn't migrated keeps it (C158).
 */
export async function assertActivityLinkable(db: DbOrTx, next: number | null, current: number | null): Promise<void> {
  if (next === null || next === current) return;
  const [a] = await db.select({ isDeleted: calendarActivities.isDeleted }).from(calendarActivities).where(eq(calendarActivities.id, next));
  if (!a) throw new ReleaseRuleError([`No Calendar activity has ID ${next}.`]);
  if (a.isDeleted) throw new ReleaseRuleError([`Calendar activity ${next} has been deleted.`]);
}
```

- [ ] **Step 5: Saving an id, and the route**

In `apps/nrms/src/releases/service.ts`, import `assertActivityLinkable` from `../calendar/lookup`.
- In `createRelease`, after `await assertKnownCategories(tx, input);`, add `await assertActivityLinkable(tx, input.activityId, null);`.
- In `saveSettings`, after `assertTypeAllows(row.type, { mediaListKeys: input.mediaListKeys });`, add `await assertActivityLinkable(tx, input.activityId, row.activityId);`.

In `apps/nrms/src/http/routes.ts`:
- Import `MAX_ACTIVITY_ID` from `@gcpe/nrms-contract`, `lookupActivity` from `../calendar/lookup`, and `calendarViewerOf` from `../calendar/viewer`.
- `Params` gains `activityId: string`.
- `RouteDeps` gains:

  ```ts
  /** The tenant's `calendar.forecastCategoryPrefix` (Forecast and the activity lookup); unset → no activity can be planned against. */
  forecastCategoryPrefix?: string | null;
  ```

- After `param("pubId", …)`, add:

  ```ts
  param("activityId", (v) => /^\d{1,10}$/.test(v) && Number(v) >= 1 && Number(v) <= MAX_ACTIVITY_ID);
  ```

- After the `/categories` route, add:

  ```ts
  // The release editor's Calendar activity lookup (spec addendum §11): detail only for an
  // activity the caller can see in the Calendar.
  r.get(
    "/calendar-activities/:activityId",
    read,
    run(async (req, res) => {
      const options = { prefix: deps.forecastCategoryPrefix ?? null, timeZone: deps.workflow.timeZone, nowMs: Date.now() };
      res.json(await lookupActivity(db, await calendarViewerOf(db, req), Number(req.params.activityId), options));
    }),
  );
  ```

In `apps/nrms/src/app.ts`, `createApp`'s deps gain the same `forecastCategoryPrefix?: string | null` (with the same doc comment), passed to `apiRoutes` as `forecastCategoryPrefix: deps.forecastCategoryPrefix ?? null`.

In `apps/nrms/src/start.ts`, `createApp({ … })` gains `forecastCategoryPrefix: tenant.calendar?.forecastCategoryPrefix ?? null,`.

- [ ] **Step 6: Run the lookup tests, then the suite, and fix the five tests that link made-up ids**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nrms/src/calendar/lookup.test.ts`
Expected: PASS (11 tests).

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nrms`

Expected: FAIL in exactly five tests, each refused with "No Calendar activity has ID …":
- `routes.test.ts` "section PUTs…" (id 77);
- `queries.test.ts` "an activity id like ABC-4521…" (4521 and 99);
- `service.rules.test.ts` "planned publish time…" (7) and "a retired media list…" (3);
- `service.test.ts` "asset, settings and media-list rules" (4521).

In each file's `beforeAll`, right after `await seedTaxonomy(tdb.db);`, add (import `seedActivity` beside `seedTaxonomy`):

```ts
    // The release links below name these Calendar activities; NRMS refuses an id it doesn't know (C142).
    for (const id of [77]) await seedActivity(tdb.db, id);
```

with the file's ids: `[77]` in `routes.test.ts`, `[4521, 99]` in `queries.test.ts`, `[7, 3]` in `service.rules.test.ts`, `[4521]` in `service.test.ts`.

`tests/e2e/search.spec.ts` links id 424242 the same way. Import `seedActivity` from `../../apps/nrms/test/helpers` and `nrmsDb` from `./playwright-support`, and after `const activityId = 424242;` add:

```ts
    // NRMS links only an activity it knows (C142): put one in its projection, as activity.* would.
    await seedActivity(nrmsDb(), activityId);
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nrms`, then both `tsc` commands, then `npx -y -p node@24 -- npm run test:e2e -- tests/e2e/search.spec.ts`.
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/nrms package-lock.json tests/e2e/search.spec.ts
git commit -m "feat(nrms): the release editor's Calendar activity lookup, under the Calendar's visibility rule; unknown and deleted new ids refused (C142)"
```

---

### Task 7: The Forecast API

Covers: spec §11 ("Forecast tab"), §16 acceptance 14 (an eligible activity appears; linking it removes it), C15, C143. Decisions H3, H12.

Own review (confidentiality).

**Files:**
- Create: `apps/nrms/src/calendar/forecast.ts`, `apps/nrms/src/calendar/forecast.test.ts`.
- Modify: `apps/nrms/src/http/routes.ts`.

**Interfaces:**
- Consumes: `listItems` (`releases/queries.ts`); `factsOf`, `locationOf`, `calendarViewerOf` (Task 6); `forecastQuerySchema`, `ForecastPage`, `ForecastItem` (Task 1).
- Produces:
  - `FORECAST_PAGE_SIZE = 25`, `FORECAST_CANDIDATE_LIMIT = 5000`;
  - `interface ForecastOptions { prefix: string | null; nowMs: number }`;
  - `forecast(db, viewer, q, options): Promise<ForecastPage>`;
  - `GET /nrms/api/forecast?page=` (NRMS read roles; a bad page is 400).

- [ ] **Step 1: Write the failing tests**

Create `apps/nrms/src/calendar/forecast.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { mintSession } from "@gcpe/auth";
import type { Viewer } from "@gcpe/calendar-contract";
import type { ForecastItem } from "@gcpe/nrms-contract";
import { createNrmsTestDb, editor, sampleCreate, seedActivity, seedTaxonomy } from "../../test/helpers";
import { createApp } from "../app";
import { calendarViewers, organizations } from "../db/schema";
import { createRelease } from "../releases/service";
import { forecast } from "./forecast";

const HQ: Viewer = { level: 1, isHq: true, ministryKeys: ["gcpe-hq"] };
const HEALTH: Viewer = { level: 2, isHq: false, ministryKeys: ["health"] };
const opts = { prefix: "Approved", nowMs: Date.now() };
/** Each item as "release:<headline>" or "activity:<id>", with its time. */
const outline = (items: ForecastItem[]) => items.map((i) => (i.kind === "release" ? `release:${i.release.headline}@${i.at}` : `activity:${i.activity.activityId}@${i.at}`));

describe("the Forecast tab (spec addendum §11, ReleasesModel.cs:144-230)", () => {
  let tdb: TestDatabase;
  /** A release planned (draft) for `at`, optionally linked to an activity. */
  const planned = async (headline: string, at: string, activityId: number | null = null, status = "draft") => {
    const v = await createRelease(tdb.db, { ...sampleCreate, headline, activityId }, editor);
    await tdb.db.execute(sql`UPDATE news_releases SET publish_at = ${at}::timestamptz, status = ${status} WHERE id = ${v.id}`);
    return v;
  };

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    await seedTaxonomy(tdb.db);
    await tdb.db.insert(organizations).values({ key: "education", displayName: "Education", abbreviation: "EDUC" });
  });
  afterAll(() => tdb.drop());
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE news_releases, calendar_activities CASCADE");
  });

  it("lists every non-deleted release from now on, and each eligible activity at its release time or else its start, by time", async () => {
    await planned("Release on the tenth", "2031-06-10T17:00:00Z", null, "scheduled");
    await planned("Release on the twelfth", "2031-06-12T17:00:00Z");
    await planned("Release in the past", "2020-06-12T17:00:00Z");
    await planned("Deleted release", "2031-06-12T18:00:00Z", null, "deleted");
    await seedActivity(tdb.db, 6001, { title: "Activity on the eleventh" });
    await seedActivity(tdb.db, 6002, { startAt: new Date("2031-06-13T17:00:00Z"), endAt: null, nrAt: new Date("2031-06-09T17:00:00Z") });
    const page = await forecast(tdb.db, HQ, { page: 1 }, opts);
    expect(outline(page.items)).toEqual([
      "activity:6002@2031-06-09T17:00:00.000Z",
      "release:Release on the tenth@2031-06-10T17:00:00.000Z",
      "activity:6001@2031-06-11T17:00:00.000Z",
      "release:Release on the twelfth@2031-06-12T17:00:00.000Z",
    ]);
    expect(page).toMatchObject({ total: 4, page: 1, pageSize: 25, calendarActivities: true });
    expect(page.items[2]).toEqual({
      kind: "activity", at: "2031-06-11T17:00:00.000Z",
      activity: { activityId: 6001, title: "Activity on the eleventh", details: "Sample details.", ministryName: "Health", categoryNames: ["Approved Event"], location: "Victoria" },
    });
    expect(page.items[1]).toMatchObject({ kind: "release", release: { status: "scheduled", statusText: expect.any(String), activityId: null } });
  });

  it("leaves out confidential, deleted, unconfirmed, started, not \"Approved\", and activities a future release is linked to", async () => {
    const confidentialRow = { isConfidential: true, title: null, details: null, startAt: null, endAt: null, isAllDay: null, isConfirmed: null, contactMinistryKey: null, cityName: null, categoryNames: [], sectorKeys: [] };
    await seedActivity(tdb.db, 6101, confidentialRow);
    await seedActivity(tdb.db, 6102, { isDeleted: true });
    await seedActivity(tdb.db, 6103, { isConfirmed: false });
    await seedActivity(tdb.db, 6104, { startAt: new Date("2020-06-11T17:00:00Z") });
    await seedActivity(tdb.db, 6105, { categoryNames: ["Proposed Event"] });
    await seedActivity(tdb.db, 6106);
    await seedActivity(tdb.db, 6107);
    await planned("Linked, in the future", "2031-06-20T17:00:00Z", 6106);
    // Legacy hides an activity only behind a future release: one already out leaves it listed (Q65).
    await planned("Linked, already out", "2020-06-20T17:00:00Z", 6107, "published");
    expect(outline((await forecast(tdb.db, HQ, { page: 1 }, opts)).items)).toEqual([
      "activity:6107@2031-06-11T17:00:00.000Z",
      "release:Linked, in the future@2031-06-20T17:00:00.000Z",
    ]);
  });

  it("shows activities only as the Calendar would: own and shared ministries, or HQ; none without Calendar access", async () => {
    await seedActivity(tdb.db, 6201, { contactMinistryKey: "health" });
    await seedActivity(tdb.db, 6202, { contactMinistryKey: "education", sharedMinistryKeys: ["health"] });
    await seedActivity(tdb.db, 6203, { contactMinistryKey: "education" });
    await planned("A release", "2031-06-30T17:00:00Z");
    const ids = async (v: Viewer | null) => (await forecast(tdb.db, v, { page: 1 }, opts)).items.map((i) => (i.kind === "activity" ? i.activity.activityId : "release"));
    expect(await ids(HEALTH)).toEqual([6201, 6202, "release"]);
    expect(await ids(HQ)).toEqual([6201, 6202, 6203, "release"]);
    const none = await forecast(tdb.db, null, { page: 1 }, opts);
    expect(none).toMatchObject({ total: 1, calendarActivities: false });
    expect(await ids({ ...HQ, level: 0 })).toEqual(["release"]);
  });

  it("a release and an activity at the same minute: the release first, as legacy's concatenation sorted", async () => {
    await seedActivity(tdb.db, 6301);
    await planned("Same minute", "2031-06-11T17:00:00Z");
    expect(outline((await forecast(tdb.db, HQ, { page: 1 }, opts)).items)).toEqual(["release:Same minute@2031-06-11T17:00:00.000Z", "activity:6301@2031-06-11T17:00:00.000Z"]);
  });

  it("pages 25 at a time", async () => {
    for (let i = 0; i < 30; i++) await seedActivity(tdb.db, 6400 + i, { startAt: new Date(Date.UTC(2031, 5, 1, 17, i)) });
    const second = await forecast(tdb.db, HQ, { page: 2 }, opts);
    expect(second).toMatchObject({ total: 30, page: 2, pageSize: 25 });
    expect(second.items.map((i) => (i.kind === "activity" ? i.activity.activityId : 0))).toEqual([6425, 6426, 6427, 6428, 6429]);
  });

  it("with no Calendar settings on the site, lists releases only", async () => {
    await seedActivity(tdb.db, 6501);
    expect((await forecast(tdb.db, HQ, { page: 1 }, { ...opts, prefix: null })).items).toEqual([]);
  });

  it("GET /forecast: any NRMS reader; the viewer is the session's; a bad page is a 400", async () => {
    const secret = "z".repeat(40) + "-forecast";
    const app = createApp({ db: tdb.db, auth: { session: { secret } }, eventSecrets: {}, workflow: { timeZone: "America/Vancouver" }, forecastCategoryPrefix: "Approved" });
    const id = "00000000-0000-4000-8000-000000000801";
    await tdb.db.insert(calendarViewers).values({ userId: id, isActive: true, calendarRole: "Calendar.ReadOnly", organizationKeys: ["health"] }).onConflictDoNothing();
    const cookie = async (roles: string[]) => `gcpe_session=${(await mintSession(secret, { id, name: "Sample Viewer", email: "viewer@example.test", roles })).token}`;
    await seedActivity(tdb.db, 6601);
    const res = await request(app).get("/api/forecast?page=1").set("cookie", await cookie(["NRMS.Viewer"]));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1, calendarActivities: true, items: [{ kind: "activity", activity: { activityId: 6601 } }] });
    expect((await request(app).get("/api/forecast?page=0").set("cookie", await cookie(["NRMS.Viewer"]))).status).toBe(400);
    expect((await request(app).get("/api/forecast").set("cookie", await cookie(["Core.Admin"]))).status).toBe(403);
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nrms/src/calendar/forecast.test.ts`
Expected: FAIL: "Cannot find module './forecast'".

- [ ] **Step 3: Implement**

Create `apps/nrms/src/calendar/forecast.ts`:

```ts
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import { hasCategoryStartingWith, visible, type Viewer } from "@gcpe/calendar-contract";
import type { ForecastItem, ForecastPage, ForecastQuery } from "@gcpe/nrms-contract";
import { calendarActivities, newsReleases, organizations, type CalendarActivityRow, type NewsReleaseRow } from "../db/schema";
import { listItems } from "../releases/queries";
import { factsOf, locationOf } from "./lookup";

export const FORECAST_PAGE_SIZE = 25;
/** At most this many releases, and this many activities, are read from now on: years of legacy's volume. */
export const FORECAST_CANDIDATE_LIMIT = 5000;

export interface ForecastOptions {
  /** The tenant's `calendar.forecastCategoryPrefix`; null lists releases only. */
  prefix: string | null;
  nowMs: number;
}

type Entry = { kind: "release"; at: Date; row: NewsReleaseRow } | { kind: "activity"; at: Date; row: CalendarActivityRow };

/** Legacy's order (ReleasesModel.cs:229): by time; at the same time a release before an activity, then by id. */
function byTime(x: Entry, y: Entry): number {
  const t = x.at.getTime() - y.at.getTime();
  if (t !== 0) return t;
  if (x.kind !== y.kind) return x.kind === "release" ? -1 : 1;
  return String(x.row.id).localeCompare(String(y.row.id), "en", { numeric: true });
}

/**
 * The Forecast tab (spec addendum §11, ReleasesModel.cs:144-230), evaluated at read time against
 * the database clock. Releases: every non-deleted one planned or scheduled from now on.
 * Activities: confirmed, not confidential or deleted, starting from now on, with a category
 * starting with the tenant's prefix, not linked to one of those releases, and visible to `viewer`
 * in the Calendar (spec addendum §6). Each is placed at its release time, or else its start.
 */
export async function forecast(db: DbOrTx, viewer: Viewer | null, q: ForecastQuery, o: ForecastOptions): Promise<ForecastPage> {
  const releases = await db
    .select()
    .from(newsReleases)
    .where(and(ne(newsReleases.status, "deleted"), sql`${newsReleases.publishAt} >= now()`))
    .orderBy(asc(newsReleases.publishAt), asc(newsReleases.id))
    .limit(FORECAST_CANDIDATE_LIMIT);
  const linked = new Set(releases.flatMap((r) => (r.activityId === null ? [] : [r.activityId])));
  const showActivities = viewer !== null && o.prefix !== null;
  const candidates = showActivities
    ? await db
        .select()
        .from(calendarActivities)
        .where(and(eq(calendarActivities.isConfidential, false), eq(calendarActivities.isDeleted, false), eq(calendarActivities.isConfirmed, true), sql`${calendarActivities.startAt} >= now()`))
        .orderBy(sql`coalesce(${calendarActivities.nrAt}, ${calendarActivities.startAt})`, asc(calendarActivities.id))
        .limit(FORECAST_CANDIDATE_LIMIT)
    : [];
  const activities = candidates.filter((a) => !linked.has(a.id) && hasCategoryStartingWith(a.categoryNames, o.prefix!) && visible(viewer!, factsOf(a)));
  const all: Entry[] = [
    ...releases.map((row): Entry => ({ kind: "release", at: row.publishAt!, row })),
    ...activities.map((row): Entry => ({ kind: "activity", at: row.nrAt ?? row.startAt!, row })),
  ].sort(byTime);

  const pageEntries = all.slice((q.page - 1) * FORECAST_PAGE_SIZE, q.page * FORECAST_PAGE_SIZE);
  const releaseItems = new Map((await listItems(db, pageEntries.flatMap((e) => (e.kind === "release" ? [e.row] : [])), o.nowMs)).map((i) => [i.id, i]));
  const ministryKeys = [...new Set(pageEntries.flatMap((e) => (e.kind === "activity" && e.row.contactMinistryKey ? [e.row.contactMinistryKey.toLowerCase()] : [])))];
  const names = new Map(
    ministryKeys.length ? (await db.select({ key: organizations.key, name: organizations.displayName }).from(organizations).where(inArray(organizations.key, ministryKeys))).map((m) => [m.key, m.name]) : [],
  );
  const items = pageEntries.map((e): ForecastItem => {
    const at = e.at.toISOString();
    if (e.kind === "release") return { kind: "release", at, release: releaseItems.get(e.row.id)! };
    const a = e.row;
    return {
      kind: "activity", at,
      activity: {
        activityId: a.id, title: a.title ?? "", details: a.details ?? "", ministryName: a.contactMinistryKey ? (names.get(a.contactMinistryKey.toLowerCase()) ?? null) : null,
        categoryNames: a.categoryNames, location: locationOf(a.cityName),
      },
    };
  });
  return { items, total: all.length, page: q.page, pageSize: FORECAST_PAGE_SIZE, calendarActivities: showActivities };
}
```

In `apps/nrms/src/http/routes.ts`, import `forecastQuerySchema` from `@gcpe/nrms-contract` and `forecast` from `../calendar/forecast`. Before the lookup route, add:

```ts
  // The Forecast tab (spec addendum §11): releases from now on, and the activities the caller can see.
  r.get(
    "/forecast",
    read,
    run(async (req, res) => {
      const q = forecastQuerySchema.parse(req.query);
      res.json(await forecast(db, await calendarViewerOf(db, req), q, { prefix: deps.forecastCategoryPrefix ?? null, nowMs: Date.now() }));
    }),
  );
```

- [ ] **Step 4: Run the tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nrms/src/calendar`, then `apps/nrms`, then both `tsc` commands.
Expected: PASS (`forecast.test.ts` 7).

- [ ] **Step 5: Commit**

```bash
git add apps/nrms/src/calendar/forecast.ts apps/nrms/src/calendar/forecast.test.ts apps/nrms/src/http/routes.ts
git commit -m "feat(nrms): GET /forecast: releases from now on and the eligible Calendar activities the caller can see, by time"
```

---

### Task 8: The backfills: calendar:replay-to-nrms and nrms:replay-activity-links

Covers: spec §11 ("Backfill", "the activity.* replay for imported data", "counts it in the replay's report"), §12.1 step 2. Decision H14.

Shares one review with Task 11 (operations scripts; they reuse Tasks 3–4's senders).

**Files:**
- Create: `apps/calendar/src/cli/replay-to-nrms.ts`, `apps/calendar/src/cli/replay-to-nrms.test.ts`, `apps/nrms/src/cli/replay-activity-links.ts`, `apps/nrms/src/cli/replay-activity-links.test.ts`.
- Modify: `package.json`, `apps/calendar/package.json`, `apps/nrms/package.json`.

**Interfaces:**
- Consumes: `emitActivity` (`apps/calendar/src/activities/events.ts`), `rulesFromTenant` (`apps/calendar/src/rules.ts`); `linkStateOf`, `statusChangedData`, `sendStatusChanged` (Task 4); `safeErrorLabel` (`@gcpe/http-kit`).
- Produces:
  - `replayToNrms(db, { confirm, rules, subscribers }): Promise<{ confirmed; count; failures }>`;
  - `replayActivityLinks(db, { confirm, subscribers }): Promise<{ confirmed; count; notInProjection; failures }>`;
  - `npm run calendar:replay-to-nrms [-- --confirm]` and `npm run nrms:replay-activity-links [-- --confirm]`.

- [ ] **Step 1: Write the failing tests**

Create `apps/calendar/src/cli/replay-to-nrms.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { outboxDeliveries, outboxEvents, type SubscriberConfig } from "@gcpe/events";
import { createCalendarTestDb, TEST_RULES } from "../../test/helpers";
import { insertRaw } from "../../test/world";
import { replayToNrms } from "./replay-to-nrms";

const subscribers: SubscriberConfig[] = [{ name: "nrms", url: "http://nrms.invalid/events", secret: "s".repeat(40), types: ["activity.created", "activity.updated", "activity.deleted"] }];

describe("npm run calendar:replay-to-nrms (spec addendum §11, §12.1)", () => {
  let tdb: TestDatabase;
  let live: number;
  let secret: number;
  let gone: number;
  const events = () => tdb.db.select().from(outboxEvents).orderBy(asc(outboxEvents.aggregateId));

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    live = await insertRaw(tdb.db, { title: "Sample live" });
    secret = await insertRaw(tdb.db, { title: "Sample confidential", isConfidential: true });
    gone = await insertRaw(tdb.db, { title: "Sample deleted", deletedAt: new Date("2026-10-01T00:00:00Z") });
  });
  afterAll(() => tdb.drop());

  it("a dry run counts and sends nothing", async () => {
    expect(await replayToNrms(tdb.db, { confirm: false, rules: TEST_RULES, subscribers })).toEqual({ confirmed: false, count: 3, failures: [] });
    expect(await events()).toEqual([]);
  });

  it("confirmed, sends each activity's current state as activity.updated to NRMS: confidential as its id only, deleted as deleted", async () => {
    expect(await replayToNrms(tdb.db, { confirm: true, rules: TEST_RULES, subscribers })).toEqual({ confirmed: true, count: 3, failures: [] });
    const sent = (await events()).map((e) => ({ type: e.type, aggregateId: e.aggregateId, data: (e.envelope as { data: Record<string, unknown> }).data }));
    expect(sent).toHaveLength(3);
    expect(sent.every((e) => e.type === "activity.updated")).toBe(true);
    expect(sent.find((e) => e.aggregateId === `activity:${live}`)!.data).toMatchObject({ id: live, isConfidential: false, isDeleted: false, title: "Sample live" });
    expect(sent.find((e) => e.aggregateId === `activity:${secret}`)!.data).toEqual({ id: secret, isConfidential: true, isDeleted: false });
    expect(sent.find((e) => e.aggregateId === `activity:${gone}`)!.data).toMatchObject({ id: gone, isDeleted: true });
    const [first] = await events();
    expect((await tdb.db.select().from(outboxDeliveries).where(eq(outboxDeliveries.eventId, first!.id))).map((d) => d.subscriber)).toEqual(["nrms"]);
  });
});
```

Create `apps/nrms/src/cli/replay-activity-links.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import type { ReleaseStatusChanged, SubscriberConfig } from "@gcpe/events";
import { createNrmsTestDb, editor, sampleCreate, seedActivity, seedTaxonomy } from "../../test/helpers";
import { createRelease } from "../releases/service";
import { replayActivityLinks } from "./replay-activity-links";

const subscribers: SubscriberConfig[] = [{ name: "calendar", url: "http://calendar.invalid/events", secret: "s".repeat(40), types: ["release.status_changed"] }];

describe("npm run nrms:replay-activity-links (spec addendum §11 backfill)", () => {
  let tdb: TestDatabase;
  const sent = async () =>
    (await tdb.pool.query("SELECT envelope FROM outbox_events WHERE type = 'release.status_changed' ORDER BY aggregate_id")).rows.map((r) => (r.envelope as { data: ReleaseStatusChanged }).data);

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    await seedTaxonomy(tdb.db);
    await seedActivity(tdb.db, 4101);
    await createRelease(tdb.db, { ...sampleCreate, headline: "Linked", activityId: 4101 }, editor);
    await createRelease(tdb.db, { ...sampleCreate, headline: "Not linked" }, editor);
    // As the Phase 3 importer leaves them: one linked to an activity that wasn't migrated, one hidden.
    const legacy = await createRelease(tdb.db, { ...sampleCreate, headline: "Legacy link" }, editor);
    await tdb.db.execute(sql`UPDATE news_releases SET activity_id = 777000 WHERE id = ${legacy.id}`);
    const hidden = await createRelease(tdb.db, { ...sampleCreate, headline: "Hidden", activityId: 4101 }, editor);
    await tdb.db.execute(sql`UPDATE news_releases SET status = 'deleted' WHERE id = ${hidden.id}`);
    // Only what the replay itself sends is under test.
    await tdb.pool.query("TRUNCATE outbox_events, outbox_deliveries CASCADE");
  });
  afterAll(() => tdb.drop());

  it("a dry run counts the linked releases, and those whose activity NRMS doesn't hold, and sends nothing", async () => {
    expect(await replayActivityLinks(tdb.db, { confirm: false, subscribers })).toEqual({ confirmed: false, count: 2, notInProjection: 1, failures: [] });
    expect(await sent()).toEqual([]);
  });

  it("confirmed, sends each linked, non-deleted release's current status to the Calendar", async () => {
    expect(await replayActivityLinks(tdb.db, { confirm: true, subscribers })).toEqual({ confirmed: true, count: 2, notInProjection: 1, failures: [] });
    expect((await sent()).map((d) => [d.headline, d.activityId, d.status, d.previousActivityId]).sort()).toEqual([["Legacy link", 777000, "draft", null], ["Linked", 4101, "draft", null]]);
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/cli apps/nrms/src/cli/replay-activity-links.test.ts`
Expected: FAIL: "Cannot find module './replay-to-nrms'" and "Cannot find module './replay-activity-links'".

- [ ] **Step 3: Implement**

Create `apps/calendar/src/cli/replay-to-nrms.ts`:

```ts
/**
 * `npm run calendar:replay-to-nrms -- --confirm` (spec addendum §11, §12.1): sends every activity's
 * current state to NRMS as `activity.updated`, through the normal outbox, so NRMS's activity
 * projection fills: after the 5i import, or for activities the Calendar held before NRMS had a
 * handler for them. A confidential activity goes as its id only and a deleted one as deleted, as
 * on any save (C127). Dry run by default; `--confirm` to enqueue. Each activity is read under its
 * row lock, so an edit committing meanwhile can't be overtaken by an older copy.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { loadTenantConfig, parseEnv } from "@gcpe/config";
import type { CalendarRules } from "@gcpe/calendar-contract";
import { createDb, type Db } from "@gcpe/db-kit";
import { parseSubscribers, type SubscriberConfig } from "@gcpe/events";
import { safeErrorLabel } from "@gcpe/http-kit";
import { emitActivity } from "../activities/events";
import { activities } from "../db/schema";
import { rulesFromTenant } from "../rules";

const BATCH_SIZE = 200;

export interface ReplayToNrmsOptions {
  confirm: boolean;
  rules: CalendarRules;
  subscribers: SubscriberConfig[];
}

export interface ReplayToNrmsResult {
  confirmed: boolean;
  count: number;
  /** Activities that failed to replay, with a safe label; the run goes on past each. */
  failures: { id: number; reason: string }[];
}

export async function replayToNrms(db: Db, opts: ReplayToNrmsOptions): Promise<ReplayToNrmsResult> {
  const ids = (await db.select({ id: activities.id }).from(activities).orderBy(asc(activities.id))).map((r) => r.id);
  if (!opts.confirm) return { confirmed: false, count: ids.length, failures: [] };
  const failures: ReplayToNrmsResult["failures"] = [];
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    await db.transaction(async (tx) => {
      for (const id of ids.slice(i, i + BATCH_SIZE)) {
        try {
          await tx.transaction(async (savepoint) => {
            await savepoint.select({ id: activities.id }).from(activities).where(eq(activities.id, id)).for("update");
            await emitActivity(savepoint, opts, id, "activity.updated");
          });
        } catch (e) {
          failures.push({ id, reason: safeErrorLabel(e) });
        }
      }
    });
  }
  return { confirmed: true, count: ids.length, failures };
}

export function printResult(r: ReplayToNrmsResult, log: (s: string) => void = console.log): void {
  if (!r.confirmed) {
    log(`${r.count} activit${r.count === 1 ? "y" : "ies"} would be sent to NRMS. Dry run: nothing enqueued. Re-run with --confirm to send.`);
    return;
  }
  log(`Sent ${r.count - r.failures.length} of ${r.count} activities to NRMS as activity.updated.`);
  for (const f of r.failures) log(`  activity ${f.id}: ${f.reason}`);
}

async function main(): Promise<void> {
  const env = parseEnv(
    z.object({
      DATABASE_URL: z.string().url(),
      EVENT_SUBSCRIBERS: z.string().optional(),
      TENANT_CONFIG: z.string().default(fileURLToPath(new URL("../../../../config/tenants/bc.json", import.meta.url))),
    }),
  );
  const confirm = process.argv.slice(2).includes("--confirm");
  const { db, pool } = createDb(env.DATABASE_URL);
  try {
    const result = await replayToNrms(db, { confirm, rules: rulesFromTenant(loadTenantConfig(env.TENANT_CONFIG)), subscribers: parseSubscribers(env.EVENT_SUBSCRIBERS) });
    printResult(result);
    if (result.failures.length > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (pathToFileURL(realpathSync(process.argv[1]!)).href === import.meta.url) {
  await main();
}
```

Create `apps/nrms/src/cli/replay-activity-links.ts`:

```ts
/**
 * `npm run nrms:replay-activity-links -- --confirm` (spec addendum §11 backfill): sends
 * `release.status_changed` for every non-deleted release with a Calendar activity id, through the
 * normal outbox, so the Calendar's activities show their releases. Run it after
 * `calendar:replay-to-nrms`, so NRMS's projection says which activities the Calendar holds: the
 * report counts the releases linked to one it doesn't (not migrated, C158), which the Calendar
 * ignores. Dry run by default; `--confirm` to enqueue. Each release is read under its row lock.
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { and, asc, eq, isNotNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { parseEnv } from "@gcpe/config";
import { createDb, type Db } from "@gcpe/db-kit";
import { parseSubscribers, type SubscriberConfig } from "@gcpe/events";
import { safeErrorLabel } from "@gcpe/http-kit";
import { calendarActivities, newsReleases } from "../db/schema";
import { linkStateOf, sendStatusChanged, statusChangedData } from "../releases/link-events";

const BATCH_SIZE = 200;
const LINKED = and(isNotNull(newsReleases.activityId), ne(newsReleases.status, "deleted"));

export interface ReplayActivityLinksOptions {
  confirm: boolean;
  subscribers: SubscriberConfig[];
}

export interface ReplayActivityLinksResult {
  confirmed: boolean;
  count: number;
  /** Linked to an activity NRMS's projection doesn't hold: the Calendar ignores these. */
  notInProjection: number;
  failures: { id: string; reason: string }[];
}

export async function replayActivityLinks(db: Db, opts: ReplayActivityLinksOptions): Promise<ReplayActivityLinksResult> {
  const ids = (await db.select({ id: newsReleases.id }).from(newsReleases).where(LINKED).orderBy(asc(newsReleases.id))).map((r) => r.id);
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(newsReleases)
    .where(and(LINKED, sql`NOT EXISTS (SELECT 1 FROM ${calendarActivities} WHERE ${calendarActivities.id} = ${newsReleases.activityId})`));
  const base = { count: ids.length, notInProjection: n };
  if (!opts.confirm) return { confirmed: false, ...base, failures: [] };
  const failures: ReplayActivityLinksResult["failures"] = [];
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    await db.transaction(async (tx) => {
      for (const id of ids.slice(i, i + BATCH_SIZE)) {
        try {
          await tx.transaction(async (savepoint) => {
            await savepoint.select({ id: newsReleases.id }).from(newsReleases).where(eq(newsReleases.id, id)).for("update");
            const state = await linkStateOf(savepoint, id);
            if (state?.activityId != null && state.status !== "deleted") await sendStatusChanged(savepoint, statusChangedData(state, null), opts.subscribers);
          });
        } catch (e) {
          failures.push({ id, reason: safeErrorLabel(e) });
        }
      }
    });
  }
  return { confirmed: true, ...base, failures };
}

export function printResult(r: ReplayActivityLinksResult, log: (s: string) => void = console.log): void {
  const verb = r.confirmed ? "Sent" : "Would send";
  log(`${verb} the status of ${r.count - r.failures.length} of ${r.count} linked release(s) to the Calendar.`);
  log(`${r.notInProjection} of them name an activity NRMS doesn't hold (not migrated): the Calendar ignores those.`);
  if (!r.confirmed) log("Dry run: nothing enqueued. Re-run with --confirm to send.");
  for (const f of r.failures) log(`  release ${f.id}: ${f.reason}`);
}

async function main(): Promise<void> {
  const env = parseEnv(z.object({ DATABASE_URL: z.string().url(), EVENT_SUBSCRIBERS: z.string().optional() }));
  const confirm = process.argv.slice(2).includes("--confirm");
  const { db, pool } = createDb(env.DATABASE_URL);
  try {
    const result = await replayActivityLinks(db, { confirm, subscribers: parseSubscribers(env.EVENT_SUBSCRIBERS) });
    printResult(result);
    if (result.failures.length > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (pathToFileURL(realpathSync(process.argv[1]!)).href === import.meta.url) {
  await main();
}
```

Scripts:
- `apps/calendar/package.json`, after `"dev"`: `"replay-to-nrms": "tsx src/cli/replay-to-nrms.ts",`.
- `apps/nrms/package.json`, after `"replay-to-news-api"`: `"replay-activity-links": "tsx src/cli/replay-activity-links.ts",`.
- The root `package.json`, after `"nrms:replay-to-news-api"`:

  ```json
      "nrms:replay-activity-links": "npm --workspace @gcpe/nrms run replay-activity-links --",
      "calendar:replay-to-nrms": "npm --workspace @gcpe/calendar run replay-to-nrms --",
  ```

- [ ] **Step 4: Run the tests and the commands**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/cli apps/nrms/src/cli`
Expected: PASS (4 new tests; the existing CLI tests unchanged).

Run: `npx -y -p node@24 -- npm run calendar:replay-to-nrms` with no `DATABASE_URL` set.
Expected: it starts and stops at "Invalid environment", which proves the script wiring.

Run both `tsc` commands.

- [ ] **Step 5: Commit**

```bash
git add apps/calendar/src/cli apps/nrms/src/cli/replay-activity-links.ts apps/nrms/src/cli/replay-activity-links.test.ts package.json apps/calendar/package.json apps/nrms/package.json
git commit -m "feat(calendar,nrms): replay every activity to NRMS and every linked release's status to the Calendar, dry run by default"
```

---
### Task 9: The Forecast tab

Covers: spec §11 ("Forecast tab": sorted by time, with the release or activity title, ministry, location and status); parent §5 step 2 (a release from a Forecast item); §16 acceptance 14 and 18. Decision H12.

Shares one review with Task 10 (screens).

**Files:**
- Create: `apps/staff-web/src/screens/releases/ForecastScreen.tsx`, `apps/staff-web/src/screens/releases/ForecastScreen.test.tsx`, `apps/staff-web/src/screens/releases/ForecastActivityRow.tsx`, `apps/staff-web/src/screens/releases/ReleaseFolderTabs.tsx`.
- Modify: `apps/staff-web/src/screens/releases/ReleaseListScreen.tsx`, `apps/staff-web/src/router.tsx`, `apps/staff-web/src/styles/global.css`.

**Interfaces:**
- Consumes: `GET /nrms/api/forecast?page=` and `ForecastPage` (Tasks 1, 7); `ReleaseRow`, `Pagination`, `formatWhen`, `activityPath`, `useTenantTimeZone`, `useSession`, `useDocumentTitle`, `apiFetch`.
- Produces:
  - the route `/releases/forecast`;
  - `ReleaseFolderTabs` (Forecast, Drafts, Scheduled, Published);
  - `ForecastActivityRow`;
  - the CSS class `gcpe-release-row__bar--activity`.

- [ ] **Step 1: Write the failing test**

Create `apps/staff-web/src/screens/releases/ForecastScreen.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ForecastItem, ForecastPage, ReleaseListItem } from "@gcpe/nrms-contract";
import { SessionProvider } from "../../session/SessionContext";
import { ForecastScreen } from "./ForecastScreen";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const release = (over: Partial<ReleaseListItem> = {}): ReleaseListItem => ({
  id: "11111111-1111-1111-1111-111111111111", type: "release", key: null, reference: "NEWS-00001", status: "scheduled", statusText: "Scheduled",
  leadOrganization: "Health", pageTitle: "News Release", headline: "Sample scheduled release", location: "VICTORIA", summary: "A summary.",
  publishAt: "2031-06-10T17:00:00.000Z", releasedAt: null, activityId: 4101, approved: true, flickrAlert: null, ...over,
});
const ITEMS: ForecastItem[] = [
  { kind: "release", at: "2031-06-10T17:00:00.000Z", release: release() },
  {
    kind: "activity", at: "2031-06-11T17:00:00.000Z",
    activity: { activityId: 4102, title: "Sample clinic opening", details: "Sample details.", ministryName: "Health", categoryNames: ["Approved Event"], location: "Victoria" },
  },
];
const page = (over: Partial<ForecastPage> = {}): ForecastPage => ({ items: ITEMS, total: 2, page: 1, pageSize: 25, calendarActivities: true, ...over });

function renderForecast(opts: { roles?: string[]; forecast?: ForecastPage | "error"; path?: string } = {}) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@x.invalid", roles: opts.roles ?? ["NRMS.Viewer"] }, expiresAt: new Date().toISOString() });
      if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: true });
      if (url.startsWith("/nrms/api/forecast")) return opts.forecast === "error" ? jsonResponse(500, { error: "internal error" }) : jsonResponse(200, opts.forecast ?? page());
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  const result = render(
    <SessionProvider>
      <MemoryRouter initialEntries={[opts.path ?? "/releases/forecast"]}>
        <Routes>
          <Route path="/releases/forecast" element={<ForecastScreen />} />
          <Route path="/releases/new" element={<p>New release screen</p>} />
          <Route path="/calendar/activities/:id" element={<p>Activity screen</p>} />
        </Routes>
      </MemoryRouter>
    </SessionProvider>,
  );
  return { calls, ...result };
}

async function seriousViolations(container: Element) {
  const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}

describe("ForecastScreen (spec addendum §11; Releases.aspx's Forecast folder)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("lists releases and Calendar activities in the server's order; an activity reads \"Planned for\" with its id, location and ministry", async () => {
    const { calls } = renderForecast();
    const rows = within((await screen.findByText("Sample scheduled release")).closest("ul")!).getAllByRole("listitem");
    expect(rows.map((r) => within(r).getByRole("link", { name: /Sample/ }).textContent)).toEqual(["Sample scheduled release", "Victoria - Sample clinic opening"]);
    expect(rows[1]).toHaveTextContent("Calendar activity · Health");
    expect(rows[1]).toHaveTextContent("Approved Event");
    expect(rows[1]).toHaveTextContent("Planned for Jun 11, 2031 10:00 AM · Activity ID 4102");
    expect(within(rows[1]!).getByRole("link", { name: "Victoria - Sample clinic opening" })).toHaveAttribute("href", "/calendar/activities/4102");
    expect(calls).toContain("/nrms/api/forecast?page=1");
    expect(screen.getByRole("heading", { level: 1, name: "Forecast" })).toBeInTheDocument();
  });

  it("an Editor can start a release from an activity; a Viewer can't", async () => {
    renderForecast({ roles: ["NRMS.Viewer"] });
    await screen.findByText("Victoria - Sample clinic opening");
    expect(screen.queryByRole("link", { name: "Start a release" })).toBeNull();
    cleanup();
    renderForecast({ roles: ["NRMS.Editor"] });
    const start = await screen.findByRole("link", { name: "Start a release" });
    expect(start).toHaveAttribute("href", "/releases/new?activity=4102");
    await userEvent.setup().click(start);
    expect(await screen.findByText("New release screen")).toBeInTheDocument();
  });

  it("without Calendar access, says why only releases are listed", async () => {
    renderForecast({ forecast: page({ items: [ITEMS[0]!], total: 1, calendarActivities: false }) });
    expect(await screen.findByText("Calendar activities are listed here for people with Calendar access. Ask a Calendar administrator if you need it.")).toBeInTheDocument();
  });

  it("asks for the page in the address, and pages on", async () => {
    const { calls } = renderForecast({ path: "/releases/forecast?page=2", forecast: page({ total: 40, page: 2 }) });
    expect(await screen.findByText("Showing 26–40 of 40")).toBeInTheDocument();
    expect(calls).toContain("/nrms/api/forecast?page=2");
  });

  it("says when nothing is planned, and when the Forecast couldn't load", async () => {
    renderForecast({ forecast: page({ items: [], total: 0 }) });
    expect(await screen.findByText("Nothing is planned from now on.")).toBeInTheDocument();
    cleanup();
    renderForecast({ forecast: "error" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load the Forecast.");
  });

  it("the folder tabs lead with Forecast, as legacy's menu did", async () => {
    renderForecast();
    const tabs = within(await screen.findByRole("navigation", { name: "Release folders" })).getAllByRole("link");
    expect(tabs.map((t) => t.textContent)).toEqual(["Forecast", "Drafts", "Scheduled", "Published"]);
  });

  it("has no serious or critical axe violations: listed, Editor, no Calendar access, empty, failed", async () => {
    for (const opts of [{}, { roles: ["NRMS.Editor"] }, { forecast: page({ items: [ITEMS[0]!], total: 1, calendarActivities: false }) }, { forecast: page({ items: [], total: 0 }) }, { forecast: "error" as const }]) {
      const { container } = renderForecast(opts);
      await screen.findByRole("heading", { level: 1, name: "Forecast" });
      await screen.findByText(/Sample scheduled release|Nothing is planned|Couldn't load/);
      expect(await seriousViolations(container)).toEqual([]);
      cleanup();
    }
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/releases/ForecastScreen.test.tsx`
Expected: FAIL: 'Failed to resolve import "./ForecastScreen"'.

- [ ] **Step 3: Implement**

Create `apps/staff-web/src/screens/releases/ReleaseFolderTabs.tsx`:

```tsx
import { NavLink } from "react-router";

/** Legacy's release menu (ReleaseManagement.master.cs:21-27): Forecast first, then the folders. */
const TABS = [
  ["forecast", "Forecast"],
  ["drafts", "Drafts"],
  ["scheduled", "Scheduled"],
  ["published", "Published"],
] as const;

export function ReleaseFolderTabs(): React.JSX.Element {
  return (
    <nav aria-label="Release folders" className="gcpe-section-tabs">
      <ul>
        {TABS.map(([path, label]) => (
          <li key={path}>
            <NavLink to={`/releases/${path}`}>{label}</NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
```

Create `apps/staff-web/src/screens/releases/ForecastActivityRow.tsx`:

```tsx
import { Link } from "react-router";
import type { ForecastActivity } from "@gcpe/nrms-contract";
import { formatWhen } from "../../format/dates";
import { activityPath } from "../calendar/activity/paths";

export interface ForecastActivityRowProps {
  activity: ForecastActivity;
  /** The activity's release time, or else its start. */
  at: string;
  now: Date;
  timeZone: string;
  /** NRMS Editors can start a release from it (parent spec §5 step 2). */
  canStartRelease: boolean;
}

/**
 * A Calendar activity on the Forecast (Releases.aspx:136-190): the green bar, its ministry and
 * categories, "Location - Title" linking to the activity, its details, "Planned for" (every Forecast
 * activity is confirmed) and its id.
 */
export function ForecastActivityRow({ activity: a, at, now, timeZone, canStartRelease }: ForecastActivityRowProps): React.JSX.Element {
  const title = `${a.location ? `${a.location} - ` : ""}${a.title || "(untitled)"}`;
  return (
    <li className="gcpe-release-row">
      <span className="gcpe-release-row__bar gcpe-release-row__bar--activity" aria-hidden="true" />
      <div className="gcpe-release-row__body">
        <p className="gcpe-release-row__meta">
          <span className="gcpe-release-row__type">Calendar activity</span>
          {a.ministryName && (
            <>
              {" "}
              &middot; <span>{a.ministryName}</span>
            </>
          )}
        </p>
        {a.categoryNames.length > 0 && <p className="gcpe-release-row__page-title">{a.categoryNames.join(", ")}</p>}
        <p className="gcpe-release-row__headline">
          <Link to={activityPath(a.activityId)}>{title}</Link>
        </p>
        {a.details && <p className="gcpe-release-row__summary">{a.details}</p>}
        <p className="gcpe-release-row__status">
          Planned for {formatWhen(at, now, timeZone)} &middot; Activity ID {a.activityId}
        </p>
        {canStartRelease && (
          <p>
            <Link to={`/releases/new?activity=${a.activityId}`}>Start a release</Link>
          </p>
        )}
      </div>
    </li>
  );
}
```

Create `apps/staff-web/src/screens/releases/ForecastScreen.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import type { ForecastPage } from "@gcpe/nrms-contract";
import { apiFetch } from "../../api/client";
import { useSession } from "../../session/SessionContext";
import { useTenantTimeZone } from "../../format/tenantTimeZone";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { ForecastActivityRow } from "./ForecastActivityRow";
import { Pagination } from "./Pagination";
import { ReleaseFolderTabs } from "./ReleaseFolderTabs";
import { ReleaseRow } from "./ReleaseRow";

/**
 * The Forecast tab (spec addendum §11): releases planned or scheduled from now on, and the Calendar
 * activities a release may be planned for, by time (`GET /nrms/api/forecast?page=`). No type filter,
 * as legacy hid it on Forecast.
 */
export function ForecastScreen(): React.JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const session = useSession();
  const timeZone = useTenantTimeZone();
  useDocumentTitle("Forecast");
  const [result, setResult] = useState<ForecastPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const page = Number(searchParams.get("page") ?? "1") || 1;

  useEffect(() => {
    let active = true;
    apiFetch<ForecastPage>(`/nrms/api/forecast?page=${page}`).then(
      (data) => {
        if (!active) return;
        setResult(data);
        setError(null);
      },
      () => {
        if (active) setError("Couldn't load the Forecast.");
      },
    );
    return () => {
      active = false;
    };
  }, [page]);

  const onPageChange = (next: number) => {
    const params = new URLSearchParams(searchParams);
    params.set("page", String(next));
    setSearchParams(params);
  };

  const now = new Date();
  const canStartRelease = session.has("NRMS.Editor");

  return (
    <div className="gcpe-release-list">
      <ReleaseFolderTabs />
      <h1>Forecast</h1>

      {result && !result.calendarActivities && <p>Calendar activities are listed here for people with Calendar access. Ask a Calendar administrator if you need it.</p>}
      {error && <p role="alert">{error}</p>}
      {!error && result && result.items.length === 0 && <p>Nothing is planned from now on.</p>}

      {!error && result && result.items.length > 0 && (
        <ul className="gcpe-release-list__rows">
          {result.items.map((i) =>
            i.kind === "release" ? (
              <ReleaseRow key={i.release.id} item={i.release} now={now} timeZone={timeZone} />
            ) : (
              <ForecastActivityRow key={`activity-${i.activity.activityId}`} activity={i.activity} at={i.at} now={now} timeZone={timeZone} canStartRelease={canStartRelease} />
            ),
          )}
        </ul>
      )}

      {!error && result && <Pagination page={result.page} pageSize={result.pageSize} total={result.total} onPageChange={onPageChange} />}
    </div>
  );
}
```

In `apps/staff-web/src/screens/releases/ReleaseListScreen.tsx`:
- Replace the inline `<nav aria-label="Release folders" …>…</nav>` with `<ReleaseFolderTabs />`.
- Delete the `FOLDERS` and `FOLDER_LABEL` constants.
- Import `ReleaseFolderTabs` from `./ReleaseFolderTabs`, and drop `NavLink` from the `react-router` import.

In `apps/staff-web/src/router.tsx`, import `ForecastScreen` from `./screens/releases/ForecastScreen`, and after the `releases` index route add:

```tsx
          { path: "forecast", element: <ForecastScreen /> },
```

In `apps/staff-web/src/styles/global.css`, after `.gcpe-release-row__bar--factsheet { … }`, add:

```css
/* A Calendar activity on the Forecast: legacy's green (Releases.aspx:157, rgb(72, 113, 72)). */
.gcpe-release-row__bar--activity {
  background: #487148;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/releases apps/staff-web/src/router.test.tsx`
Expected: PASS (`ForecastScreen.test.tsx` 7; `ReleaseListScreen.test.tsx` unchanged, its tabs now four).

Run the staff-web `tsc`.

- [ ] **Step 5: Commit**

```bash
git add apps/staff-web/src/screens/releases apps/staff-web/src/router.tsx apps/staff-web/src/styles/global.css
git commit -m "feat(staff-web): the Forecast tab: releases and Calendar activities from now on, Start a release for Editors"
```

---

### Task 10: The activity lookup on New release (with legacy's pre-fill) and in Publish settings

Covers: spec §11 ("Entering an activity id looks it up", "Pre-fill", "translations required", "Legacy activity <id>, not migrated"); §16 acceptance 13 and 14 ("The release editor's lookup pre-fills from it"), 18. Decisions H4, H10, H11, H13.

Shares one review with Task 9.

**Files:**
- Create: `apps/staff-web/src/screens/release/ActivityLookupPanel.tsx`, `apps/staff-web/src/screens/release/ActivityLookupPanel.test.tsx`.
- Modify: `apps/staff-web/src/screens/release/NewReleaseScreen.tsx` (+ test), `apps/staff-web/src/screens/release/sections/SettingsSection.tsx` (+ test).

**Interfaces:**
- Consumes: `GET /nrms/api/calendar-activities/:id` and `ActivityLookup`, `ReleasePrefill`, `MAX_ACTIVITY_ID` (Tasks 1, 6); `dateTimeText`, `activityPath`, `apiFetch`, `ApiError`, `useTenantTimeZone`.
- Produces:
  - `useActivityLookup(id: number | null): ActivityLookup | null` (a 404 reads as `unknown`; an id out of range isn't asked);
  - `ActivityLookupPanel({ lookup, storedId, timeZone })`, a `role="status"` region;
  - New release's Activity ID and Location fields, and its `?activity=` parameter.

- [ ] **Step 1: Write the failing tests**

Create `apps/staff-web/src/screens/release/ActivityLookupPanel.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { MemoryRouter } from "react-router";
import type { ActivityLookup } from "@gcpe/nrms-contract";
import { ActivityLookupPanel, useActivityLookup } from "./ActivityLookupPanel";

const FOUND: ActivityLookup = {
  id: 4102, state: "found", title: "Sample clinic opening", startAt: "2031-06-11T17:00:00.000Z", endAt: "2031-06-11T18:00:00.000Z",
  ministryName: "Health", location: "Victoria", translations: ["French", "Punjabi"], notEligible: null,
  prefill: { publishAt: "2031-06-11T17:00:00.000Z", location: "Victoria", ministries: ["health"], leadMinistryKey: "health", sectors: [], themes: [], tags: [] },
};

function renderPanel(lookup: ActivityLookup | null, storedId: number | null = null) {
  return render(
    <MemoryRouter>
      <ActivityLookupPanel lookup={lookup} storedId={storedId} timeZone="America/Vancouver" />
    </MemoryRouter>,
  );
}

describe("ActivityLookupPanel (spec addendum §11)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("a found activity: its title links to it, with its ministry, start and the translations it requires", () => {
    renderPanel(FOUND);
    const status = screen.getByRole("status");
    expect(screen.getByRole("link", { name: "Sample clinic opening" })).toHaveAttribute("href", "/calendar/activities/4102");
    expect(status).toHaveTextContent("Sample clinic opening · Health · Jun 11, 2031 10:00 AM");
    expect(status).toHaveTextContent("Translations required: French, Punjabi");
  });

  it("says why nothing is filled in", () => {
    renderPanel({ ...FOUND, prefill: null, notEligible: "Nothing is filled in: it has ended." });
    expect(screen.getByRole("status")).toHaveTextContent("Nothing is filled in: it has ended.");
  });

  it("names every other state, and a stored id that wasn't migrated (C158)", () => {
    const text = (lookup: ActivityLookup, stored: number | null = null) => {
      renderPanel(lookup, stored);
      const t = screen.getByRole("status").textContent;
      cleanup();
      return t;
    };
    expect(text({ id: 9999, state: "unknown" })).toBe("No Calendar activity has ID 9999.");
    expect(text({ id: 777000, state: "unknown" }, 777000)).toBe("Legacy activity 777000, not migrated");
    expect(text({ id: 5003, state: "deleted" })).toBe("Calendar activity 5003 has been deleted.");
    expect(text({ id: 5002, state: "hidden" })).toBe("Calendar activity 5002: its details aren’t shown to you.");
  });

  it("shows nothing before a lookup", () => {
    renderPanel(null);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("useActivityLookup asks NRMS for a valid id only, and reads a 404 as unknown", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      return url.endsWith("/4102") ? new Response(JSON.stringify(FOUND), { status: 200, headers: { "content-type": "application/json" } }) : new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
    }));
    const { result, rerender } = renderHook(({ id }) => useActivityLookup(id), { initialProps: { id: 4102 as number | null } });
    await waitFor(() => expect(result.current).toEqual(FOUND));
    rerender({ id: 2_147_483_648 });
    expect(result.current).toBeNull();
    rerender({ id: 12 });
    await waitFor(() => expect(result.current).toEqual({ id: 12, state: "unknown" }));
    expect(calls).toEqual(["/nrms/api/calendar-activities/4102", "/nrms/api/calendar-activities/12"]);
  });

  it("has no serious or critical axe violations in any state", async () => {
    for (const lookup of [FOUND, { ...FOUND, prefill: null, notEligible: "Nothing is filled in: it has ended." }, { id: 9999, state: "unknown" }, { id: 5003, state: "deleted" }, { id: 5002, state: "hidden" }] as ActivityLookup[]) {
      const { container } = renderPanel(lookup);
      const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
      expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
      cleanup();
    }
  });
});
```

In `apps/staff-web/src/screens/release/NewReleaseScreen.test.tsx`:
- Import `axe` from `axe-core`.
- `StubOptions` gains `lookups?: Record<string, unknown>`, and `stubFetch` takes `{ roles = ["NRMS.Editor"], onPost, lookups = {} }`.
- Before the `/nrms/api/releases` POST branch, add:

  ```ts
      if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver", siteUrl: "", publicSiteUrl: "", filesBase: "", isTestSite: true });
      const lookup = /^\/nrms\/api\/calendar-activities\/(\d+)$/.exec(url);
      if (lookup) return lookups[lookup[1]!] ? jsonResponse(200, lookups[lookup[1]!]) : jsonResponse(404, { error: "not found" });
  ```

- `renderScreen` takes `path = "/releases/new"` for its `initialEntries`.
- Before the file's final `});`, add:

```tsx
  const ACTIVITY = {
    id: 4102, state: "found", title: "Sample clinic opening", startAt: "2031-06-11T17:00:00.000Z", endAt: "2031-06-11T18:00:00.000Z",
    ministryName: "Health", location: "Victoria", translations: ["French"], notEligible: null,
    prefill: { publishAt: "2031-06-11T17:00:00.000Z", location: "Victoria", ministries: ["health", "education"], leadMinistryKey: "health", sectors: ["sector1"], themes: ["theme1"], tags: [] },
  };

  it("started from a Forecast activity, fills in legacy's fields from it and sends its id, location and planned time (New.aspx:625-700)", async () => {
    const calls = stubFetch({ lookups: { "4102": ACTIVITY } });
    renderScreen("/releases/new?activity=4102");
    expect(await screen.findByRole("link", { name: "Sample clinic opening" })).toHaveAttribute("href", "/calendar/activities/4102");
    expect(screen.getByLabelText("Activity ID")).toHaveValue("4102");
    await waitFor(() => expect(screen.getByLabelText("Health")).toBeChecked());
    expect(screen.getByLabelText("Education")).toBeChecked();
    expect(screen.getByLabelText("Sector One")).toBeChecked();
    expect(screen.getByLabelText("Theme One")).toBeChecked();
    expect(screen.getByLabelText("Location")).toHaveValue("Victoria");
    expect(screen.getByText("Planned publish date: Jun 11, 2031 10:00 AM, from the activity. Change it in Publish settings.")).toBeInTheDocument();
    expect(screen.getByText("Translations required: French")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Page title"), "News Release");
    await user.type(screen.getByLabelText("Headline", { exact: false }), "Clinics open");
    await user.click(screen.getByRole("button", { name: "Create release" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/nrms/api/releases")?.body).toMatchObject({
      activityId: 4102, location: "Victoria", publishAt: "2031-06-11T17:00:00.000Z", ministries: ["health", "education"], leadMinistryKey: "health", sectors: ["sector1"], themes: ["theme1"],
    }));
  });

  it("a typed id is looked up, and its fields are filled in only when asked", async () => {
    stubFetch({ lookups: { "4102": ACTIVITY } });
    renderScreen();
    await screen.findByText("Legislature");
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Activity ID"), "4102");
    expect(await screen.findByRole("link", { name: "Sample clinic opening" })).toBeInTheDocument();
    expect(screen.getByLabelText("Health")).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Fill in from activity 4102" }));
    expect(screen.getByLabelText("Health")).toBeChecked();
  });

  it("an unknown or deleted id says so, offers nothing to fill in, and the server's refusal shows at the field", async () => {
    stubFetch({ lookups: {}, onPost: () => jsonResponse(422, { error: "bad", problems: ["No Calendar activity has ID 9999."] }) });
    renderScreen("/releases/new?activity=9999");
    expect(await screen.findByText("No Calendar activity has ID 9999.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Fill in from/ })).toBeNull();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Page title"), "News Release");
    await user.type(screen.getByLabelText("Headline", { exact: false }), "A headline");
    await user.click(screen.getByRole("button", { name: "Create release" }));
    await waitFor(() => expect(screen.getByLabelText("Activity ID")).toHaveAttribute("aria-invalid", "true"));
  });

  it("has no serious or critical axe violations, filled in from an activity", async () => {
    stubFetch({ lookups: { "4102": ACTIVITY } });
    const { container } = renderScreen("/releases/new?activity=4102");
    await waitFor(() => expect(screen.getByLabelText("Health")).toBeChecked());
    const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
    expect(results.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });
```

In `apps/staff-web/src/screens/release/sections/SettingsSection.test.tsx`:
- Import `MemoryRouter` from `react-router`.
- `stubFetch` takes `lookups?: Record<string, unknown>`. After its media-lists branch, add the same two `calendar-activities` lines.
- `renderSettings` wraps `SettingsSection` in `<MemoryRouter>`, for the lookup's link.
- Before the final `});`, add:

```tsx
  it("names the saved activity: its title and the translations it requires (spec addendum §11)", async () => {
    stubFetch({
      lookups: {
        "4102": { id: 4102, state: "found", title: "Sample clinic opening", startAt: "2031-06-11T17:00:00.000Z", endAt: null, ministryName: "Health", location: "Victoria", translations: ["French"], prefill: null, notEligible: "Nothing is filled in: it has ended." },
      },
    });
    renderSettings(releaseView({ activityId: 4102 }));
    expect(await screen.findByRole("link", { name: "Sample clinic opening" })).toHaveAttribute("href", "/calendar/activities/4102");
    expect(screen.getByText("Translations required: French")).toBeInTheDocument();
  });

  it("a saved id the Calendar doesn't hold is a legacy link that wasn't migrated; a newly typed unknown one is named as unknown (C158, C142)", async () => {
    stubFetch();
    renderSettings(releaseView({ activityId: 777000 }));
    expect(await screen.findByText("Legacy activity 777000, not migrated")).toBeInTheDocument();
    const user = userEvent.setup();
    const field = screen.getByRole("textbox", { name: "Calendar activity ID" });
    await user.clear(field);
    await user.type(field, "9999");
    await user.tab();
    expect(await screen.findByText("No Calendar activity has ID 9999.")).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/release/ActivityLookupPanel.test.tsx apps/staff-web/src/screens/release/NewReleaseScreen.test.tsx apps/staff-web/src/screens/release/sections/SettingsSection.test.tsx`

Expected: FAIL.
- `ActivityLookupPanel.test.tsx` doesn't resolve "./ActivityLookupPanel".
- In `NewReleaseScreen.test.tsx`, the 4 new tests fail (no "Activity ID" field). The 13 existing ones pass.
- In `SettingsSection.test.tsx`, the 2 new tests fail.

- [ ] **Step 3: The panel**

Create `apps/staff-web/src/screens/release/ActivityLookupPanel.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { MAX_ACTIVITY_ID, type ActivityLookup } from "@gcpe/nrms-contract";
import { apiFetch, ApiError } from "../../api/client";
import { dateTimeText } from "../calendar/list/dates";
import { activityPath } from "../calendar/activity/paths";

/** Looks `id` up in NRMS's copy of the Calendar's activities (spec addendum §11); null while there's nothing to show. */
export function useActivityLookup(id: number | null): ActivityLookup | null {
  const [result, setResult] = useState<ActivityLookup | null>(null);
  useEffect(() => {
    setResult(null);
    if (id === null || !Number.isInteger(id) || id < 1 || id > MAX_ACTIVITY_ID) return;
    let active = true;
    apiFetch<ActivityLookup>(`/nrms/api/calendar-activities/${id}`).then(
      (r) => {
        if (active) setResult(r);
      },
      (e: unknown) => {
        if (active && e instanceof ApiError && e.status === 404) setResult({ id, state: "unknown" });
      },
    );
    return () => {
      active = false;
    };
  }, [id]);
  return result;
}

export interface ActivityLookupPanelProps {
  lookup: ActivityLookup | null;
  /** The release's saved activity id: an unknown one is a legacy link that wasn't migrated (C158). */
  storedId: number | null;
  timeZone: string;
}

/** What the activity id names, under the field. A polite live region, so typing an id is announced once it resolves. */
export function ActivityLookupPanel({ lookup, storedId, timeZone }: ActivityLookupPanelProps): React.JSX.Element {
  return (
    <div role="status" className="gcpe-activity-lookup">
      {lookup && <LookupText lookup={lookup} storedId={storedId} timeZone={timeZone} />}
    </div>
  );
}

function LookupText({ lookup: l, storedId, timeZone }: { lookup: ActivityLookup; storedId: number | null; timeZone: string }): React.JSX.Element {
  if (l.state !== "found") {
    if (l.state === "deleted") return <p>Calendar activity {l.id} has been deleted.</p>;
    if (l.state === "hidden") return <p>Calendar activity {l.id}: its details aren&rsquo;t shown to you.</p>;
    return <p>{l.id === storedId ? `Legacy activity ${l.id}, not migrated` : `No Calendar activity has ID ${l.id}.`}</p>;
  }
  return (
    <>
      <p>
        <Link to={activityPath(l.id)}>{l.title || "(untitled)"}</Link>
        {l.ministryName && ` · ${l.ministryName}`}
        {l.startAt && ` · ${dateTimeText(l.startAt, timeZone)}`}
      </p>
      {l.translations.length > 0 && <p>Translations required: {l.translations.join(", ")}</p>}
      {l.notEligible && <p>{l.notEligible}</p>}
    </>
  );
}
```

- [ ] **Step 4: New release: the Activity ID, the pre-fill and Location**

In `apps/staff-web/src/screens/release/NewReleaseScreen.tsx`:

- **Imports:**

  ```tsx
  import { Link, useNavigate, useSearchParams } from "react-router";
  import {
    CREATABLE_TYPES, LANG_EN, LAYOUTS, MAX_ACTIVITY_ID, TYPE_LABEL, createReleaseSchema, typeRules, type Layout, type ReleasePrefill, type ReleaseView,
  } from "@gcpe/nrms-contract";
  import { useTenantTimeZone } from "../../format/tenantTimeZone";
  import { dateTimeText } from "../calendar/list/dates";
  import { ActivityLookupPanel, useActivityLookup } from "./ActivityLookupPanel";
  ```

- **`fieldFor`:** its first line becomes `if (/calendar activity|activity id/i.test(problem)) return "activityId";`.

- **Before the component's doc comment,** add:

  ```tsx
/** A typed activity id as a number, or null while it isn't one the Calendar could have. */
function activityIdOf(text: string): number | null {
  const t = text.trim();
  return /^\d{1,10}$/.test(t) && Number(t) >= 1 && Number(t) <= MAX_ACTIVITY_ID ? Number(t) : null;
}
  ```

  and append to the doc comment: "The Calendar activity id is looked up as it's typed (spec addendum §11), and legacy's pre-fill from it is offered; started from a Forecast activity (`?activity=`), it is filled in at once."

- **After `const navigate = useNavigate();`,** add `const [searchParams] = useSearchParams();` and `const timeZone = useTenantTimeZone();`.

- **After the `mediaListKeys` state,** add:

  ```tsx
  const [activityText, setActivityText] = useState(() => searchParams.get("activity") ?? "");
  const [location, setLocation] = useState("");
  const [publishAt, setPublishAt] = useState<string | null>(null);
  // From the Forecast's "Start a release": fill in from that activity once it's looked up.
  const [fillOnLookup, setFillOnLookup] = useState(() => searchParams.has("activity"));
  const activityId = activityIdOf(activityText);
  const lookup = useActivityLookup(activityId);
  const prefill = lookup?.state === "found" ? lookup.prefill : null;
  ```

- **Before the role gate** (`// Fix round 1, finding 1: …`), so the hooks' order never changes, add:

  ```tsx
  const fillIn = (p: ReleasePrefill) => {
    setMinistries(p.ministries);
    setLeadMinistryKey(p.leadMinistryKey);
    setSectors(p.sectors);
    setThemes(p.themes);
    setTags(p.tags);
    setLocation(p.location);
    setPublishAt(p.publishAt);
  };

  useEffect(() => {
    if (!fillOnLookup || !lookup) return;
    setFillOnLookup(false);
    if (prefill) fillIn(prefill);
  }, [fillOnLookup, lookup, prefill]);
  ```

- **`buildInput`:**
  - `location: "",` becomes `location,`;
  - `activityId: null,` becomes `activityId: activityText.trim() === "" ? null : activityText.trim(),` (the schema turns digits into a number and refuses anything else, at this field);
  - `publishAt: null,` becomes `publishAt,`.

- **After the Headline field,** add:

  ```tsx
        <TextField
          label="Activity ID"
          value={activityText}
          onChange={setActivityText}
          inputMode="numeric"
          maxLength={10}
          errorMessage={fieldProblem("activityId")}
          isInvalid={!!fieldProblem("activityId")}
        />
        <ActivityLookupPanel lookup={lookup} storedId={null} timeZone={timeZone} />
        {prefill && activityId !== null && (
          <Button variant="secondary" onPress={() => fillIn(prefill)}>
            Fill in from activity {activityId}
          </Button>
        )}

        <TextField label="Location" value={location} onChange={setLocation} maxLength={50} />
        {publishAt && <p>Planned publish date: {dateTimeText(publishAt, timeZone)}, from the activity. Change it in Publish settings.</p>}
  ```

- [ ] **Step 5: Publish settings: what the saved id names**

In `apps/staff-web/src/screens/release/sections/SettingsSection.tsx`, import `ActivityLookupPanel` and `useActivityLookup` from `../ActivityLookupPanel`. After the `lists` state, add `const lookup = useActivityLookup(form.activityId);`. After the "Calendar activity ID" `NumberField`, add:

```tsx
        <ActivityLookupPanel lookup={lookup} storedId={view.activityId} timeZone={timeZone} />
```

- [ ] **Step 6: Run the tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web`, and the staff-web `tsc`.
Expected: PASS (909 at the dry run).

- [ ] **Step 7: Commit**

```bash
git add apps/staff-web/src/screens/release
git commit -m "feat(staff-web): the Calendar activity lookup on New release, with legacy's pre-fill, and in Publish settings"
```

---

### Task 11: End to end (parent §10.2's Calendar leg); the planner user; parity rows, questions, the spec, running notes, deploy notes and carry-forward

Covers: spec §3 row 5h's exit check; §16 acceptance 13, 14 and 18; carry-forward (rewritten). Decisions H16 and H1–H20 recorded as C142, C143, C158, C15 (status), C191–C194, Q65–Q67.

Shares one review with Task 8.

**Files:**
- Create: `tests/e2e/forecast.spec.ts`.
- Modify: `apps/core/src/services/seed-test-users.ts`, `apps/core/src/services/seed-test-users.test.ts`, `scripts/siteground-seed-users.sh`, `tests/e2e/constants.ts`, `docs/parity/changes-from-legacy.md`, `docs/parity/open-questions.md`, `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`, `docs/superpowers/specs/2026-10-07-calendar-parity-design.md`, `docs/superpowers/plans/phase-5-carry-forward.md`.

**Interfaces:**
- Consumes: everything above; `listFixture`, `activityInput`, `sessionOf`, `useCookie` (`calendar-support.ts`); `apiCall`, `baseUrl`, `expectNoSeriousA11yViolations`, `nrmsDb`, `tick` (`playwright-support.ts`).
- Produces: `PLANNER_EMAIL` (`tests/e2e/constants.ts`); the seeded `planner@example.test`.

- [ ] **Step 1: The planner user**

In `apps/core/src/services/seed-test-users.test.ts`, "skips Calendar access when an organization is missing, and grants it on a re-run", after the `cal-hq-advanced` expectation, add:

```ts
    expect(await findUserByEmail(tdb.db, "planner@example.test")).toMatchObject({ roles: ["NRMS.Editor"], calendarRole: "Calendar.ReadOnly", organizationKeys: ["gcpe-headquarters"] });
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/core/src/services/seed-test-users.test.ts`
Expected: FAIL: `planner@example.test` doesn't exist yet.

In `apps/core/src/services/seed-test-users.ts`, add as `TEST_USERS`' last entry:

```ts
  // Releases planned from the Calendar (spec addendum §11): an NRMS Editor who reads every ministry's activities.
  { email: "planner@example.test", displayName: "Test Release Planner", roles: ["NRMS.Editor"], calendar: { role: "Calendar.ReadOnly", organizationKeys: ["gcpe-headquarters"] } },
```

In `tests/e2e/constants.ts`:
- `TEST_USER_PASSWORDS` gains `"planner@example.test": "e2e-planner-password-1",`.
- After `CAL_HQ_ADVANCED_EMAIL`, add:

  ```ts
  /** NRMS.Editor and Calendar.ReadOnly at GCPE Headquarters: plans releases from the Forecast. */
  export const PLANNER_EMAIL = "planner@example.test";
  ```

In `scripts/siteground-seed-users.sh`:
- After `seed cal-hq-advanced@example.test …`, add `seed planner@example.test "Test Release Planner" NRMS.Editor`.
- After the last `calendar_access` line, add `calendar_access planner@example.test Calendar.ReadOnly gcpe-headquarters`.
- The header's "gives the eight cal-*@example.test users Calendar access" becomes "gives the eight cal-*@example.test users and planner@example.test Calendar access".

Run the seed test again. Expected: PASS.

- [ ] **Step 2: The spec**

Create `tests/e2e/forecast.spec.ts`:

```ts
// Parent spec §10.2's Calendar → NRMS leg, spec addendum §3 row 5h's exit check: a Calendar
// activity appears on NRMS's Forecast, a release is started from it (pre-filled), approved,
// scheduled and published, and the activity shows each status. Fixed dates in 2031, so nothing
// depends on the hour the suite runs: "publish" moves the scheduled time into the past rather
// than waiting for it. Seeded sessions only (global-setup).
import { test, expect } from "@playwright/test";
import { sql } from "drizzle-orm";
import type { ForecastPage, ReleaseView } from "@gcpe/nrms-contract";
import { CAL_HQ_ADMIN_EMAIL, CAL_SYSADMIN_EMAIL, EDITOR_EMAIL, PLANNER_EMAIL } from "./constants";
import { activityInput, listFixture, sessionOf, useCookie } from "./calendar-support";
import { apiCall, baseUrl, expectNoSeriousA11yViolations, nrmsDb, tick } from "./playwright-support";

/** The Forecast page holding `activityId`'s row (as the planner sees it), polling while the activity travels to NRMS. */
async function forecastPageOf(cookie: string, find: (p: ForecastPage) => boolean): Promise<number> {
  let found = 0;
  await expect
    .poll(
      async () => {
        await tick();
        for (let page = 1; page <= 40; page++) {
          const p = await apiCall<ForecastPage>(cookie, `/nrms/api/forecast?page=${page}`);
          if (find(p)) return (found = page);
          if (page * p.pageSize >= p.total) break;
        }
        return 0;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);
  return found;
}

/** The statuses of the releases the Calendar shows on the activity, after letting events flow. */
const calendarStatuses = (cookie: string, activityId: number) => async () => {
  await tick();
  return (await apiCall<{ releases: { status: string }[] }>(cookie, `/calendar/api/activities/${activityId}`)).releases.map((r) => r.status);
};

test.describe("parent spec §10.2: Calendar activity → Forecast → draft → approve → schedule → publish → status on the activity", () => {
  test("the planner starts a pre-filled release from the Forecast, and the activity follows it to published", async ({ page, context }) => {
    test.setTimeout(120_000);
    const f = await listFixture(); // the Health comm contact and a city
    const sys = await sessionOf(CAL_SYSADMIN_EMAIL);
    const hq = await sessionOf(CAL_HQ_ADMIN_EMAIL);
    const planner = await sessionOf(PLANNER_EMAIL);
    const stamp = Date.now();
    // Forecast takes categories starting "Approved" (BC tenant). Not 12 or 58, the release categories.
    let category = await apiCall<{ id: number }>(sys, "/calendar/api/lookups/categories", { method: "POST", body: { name: `Approved E2E forecast ${stamp}` } });
    while ([2, 12, 58].includes(category.id)) category = await apiCall<{ id: number }>(sys, "/calendar/api/lookups/categories", { method: "POST", body: { name: `Approved E2E forecast ${stamp}-${category.id}` } });
    const title = `Forecast clinic ${stamp}`;
    const activity = await apiCall<{ id: number }>(hq, "/calendar/api/activities", {
      method: "POST",
      body: { ...activityInput({ category: category.id, city: f.city }, { title, ministry: "health", contact: f.health, time: "10:00", date: "2031-06-11" }), translations: ["French"] },
    });

    // The Forecast, as the planner sees it.
    const pageNo = await forecastPageOf(planner, (p) => p.items.some((i) => i.kind === "activity" && i.activity.activityId === activity.id));
    await useCookie(context, planner);
    await page.goto(`${baseUrl()}/hub/releases/forecast?page=${pageNo}`);
    const row = page.locator("li.gcpe-release-row", { has: page.getByRole("link", { name: new RegExp(title) }) });
    await expect(row).toContainText(`Planned for Jun 11, 2031 10:00 AM · Activity ID ${activity.id}`);
    await expectNoSeriousA11yViolations(page, "the Forecast");

    // Draft: started from the activity, pre-filled.
    await row.getByRole("link", { name: "Start a release" }).click();
    await expect(page.getByLabel("Activity ID")).toHaveValue(String(activity.id));
    await expect(page.getByRole("group", { name: "Ministries" }).getByLabel("Health")).toBeChecked();
    await expect(page.getByText("Translations required: French")).toBeVisible();
    await expect(page.getByText("Planned publish date: Jun 11, 2031 10:00 AM, from the activity.", { exact: false })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "a new release filled in from an activity");
    await page.getByLabel("Page title").selectOption("News Release");
    await page.getByLabel("Headline", { exact: false }).fill(`Clinic opens ${stamp}`);
    await page.getByRole("button", { name: "Create release" }).click();
    await expect(page).toHaveURL(/\/hub\/releases\/[0-9a-f-]{36}$/);
    const releaseId = page.url().split("/").at(-1)!;
    await expect.poll(calendarStatuses(hq, activity.id), { timeout: 15_000 }).toEqual(["draft"]);
    // Linked to a release planned from now on, the activity leaves the Forecast; the release takes its place.
    const forecast = await apiCall<ForecastPage>(planner, `/nrms/api/forecast?page=${pageNo}`);
    expect(forecast.items.some((i) => i.kind === "activity" && i.activity.activityId === activity.id)).toBe(false);
    await forecastPageOf(planner, (p) => p.items.some((i) => i.kind === "release" && i.release.id === releaseId));

    // The body and sector a release needs before it can go out, then approve and schedule.
    let view = await apiCall<ReleaseView>(planner, `/nrms/api/releases/${releaseId}`);
    const doc = view.documents[0]!;
    view = await apiCall<ReleaseView>(planner, `/nrms/api/releases/${releaseId}/documents/${doc.id}/4105`, {
      method: "PUT",
      body: {
        version: view.version, pageTitle: "News Release", layout: "formal", headline: `Clinic opens ${stamp}`, subheadline: null, organizations: "Ministry of Health",
        byline: null, bodyHtml: "<p>A fictional clinic opens.</p>", pageImageId: null, contacts: ["Media Relations\n250-555-0100"],
      },
    });
    view = await apiCall<ReleaseView>(planner, `/nrms/api/releases/${releaseId}/categories`, {
      method: "PUT", body: { version: view.version, leadMinistryKey: "health", ministries: view.ministries, sectors: ["health"], themes: view.themes, tags: view.tags },
    });
    view = await apiCall<ReleaseView>(planner, `/nrms/api/releases/${releaseId}/approve`, { method: "POST", body: { version: view.version } });
    await expect.poll(calendarStatuses(hq, activity.id), { timeout: 15_000 }).toEqual(["approved"]);
    view = await apiCall<ReleaseView>(planner, `/nrms/api/releases/${releaseId}/schedule`, { method: "POST", body: { version: view.version, publishAtLocal: "2031-06-11T10:00" } });
    expect(view.status).toBe("scheduled");
    await expect.poll(calendarStatuses(hq, activity.id), { timeout: 15_000 }).toEqual(["scheduled"]);

    // Publish: the scheduled time moved into the past, so the next publisher run takes it.
    await nrmsDb().execute(sql`UPDATE news_releases SET publish_at = now() - interval '1 minute' WHERE id = ${releaseId}`);
    await expect.poll(calendarStatuses(hq, activity.id), { timeout: 20_000 }).toEqual(["published"]);

    // The activity page shows it, with a link for an NRMS user.
    await page.goto(`${baseUrl()}/hub/calendar/activities/${activity.id}`);
    const news = page.getByRole("region", { name: "BC Gov News" });
    await expect(news).toContainText(`Release ${view.reference}: Published`);
    await expect(news.getByRole("link")).toHaveAttribute("href", `/hub/releases/${releaseId}`);
    await expectNoSeriousA11yViolations(page, "the activity with its published release");
  });

  test("an NRMS Editor without Calendar access sees releases only, and is told why", async ({ page, context }) => {
    const editor = await sessionOf(EDITOR_EMAIL);
    const forecast = await apiCall<ForecastPage>(editor, "/nrms/api/forecast?page=1");
    expect(forecast.calendarActivities).toBe(false);
    expect(forecast.items.every((i) => i.kind === "release")).toBe(true);
    await useCookie(context, editor);
    await page.goto(`${baseUrl()}/hub/releases/forecast`);
    await expect(page.getByText("Calendar activities are listed here for people with Calendar access.", { exact: false })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "the Forecast without Calendar access");
  });
});
```

- [ ] **Step 3: See it fail once, then pass, then run everything**

The spec exercises Tasks 1–10, so it passes as written. To show it can fail:
- Change the final `toEqual(["published"])` to `toEqual(["scheduled"])`.
- Run it and see the poll FAIL with `Expected: ["scheduled"]`, `Received: ["published"]`. That proves the published status really reached the Calendar.
- Restore it.

Run: `npx -y -p node@24 -- npm run test:e2e -- tests/e2e/forecast.spec.ts tests/e2e/search.spec.ts`
Expected: PASS (3 tests).

Run: `npx -y -p node@24 -- npm run test:e2e`
Expected: PASS, every spec (113 passed and 1 skipped at the dry run, the skip as before).

Run the full Vitest suite (`npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run`) and both `tsc` commands.
Expected: PASS (4,280 tests at the dry run).

- [ ] **Step 4: The parity rows and the questions**

`docs/parity/changes-from-legacy.md`, "## Staff app screens": C15's row becomes:

```markdown
| C15 | Forecast tab and its calendar (iCal) feed. | The Forecast tab is built (Phase 5h): releases planned from now on and the Calendar activities a release may be planned for, by time. Its iCal feed is deferred with the Calendar's (C131). | The Calendar now exists; iCal usage is unknown (R5). | Agreed (built in 5h, except iCal) |
```

In "## Corporate Calendar (Phase 5)", after the last row (C190):

```markdown
| C142 | The release form's activity id was a free number (`New.aspx.cs:132-133`, `Release.aspx.cs:618-628`). The lookup didn't check deletion (`Services.asmx.cs:84-85`). | A new id must be an activity NRMS's copy of the Calendar knows, and not deleted; the lookup requires a non-deleted activity too. A confidential id can be linked. An id saved before stands until changed. Ids are capped at the Calendar's int4. | A link to an id that matches no activity shows nowhere in the Calendar; a deleted activity can't be planned against. | Agreed (built in 5h) |
| C143 | NRMS read the Calendar database directly. The release PDF downloaded for anyone (`ReleaseDownloadHandler.ashx.cs`). | NRMS sends `release.status_changed` at each settled status and link change, and the Calendar keeps a release list per activity from it. A correction or an unpublish in progress reads as published. Links only for users with an NRMS role. The Forecast tab is built in NRMS, closing C15 except its iCal (C131). | R11; parent §3.1 rule 2; R10. | Agreed (built in 5h) |
| C158 | Every release linked to an activity showed it, and the activity showed the release. | A release linked to an activity that wasn't imported keeps the number for search but shows it as "Legacy activity <id>, not migrated". The Calendar has no record of it, and `nrms:replay-activity-links` counts such releases. Legacy stays readable for one year (R14). | Follows from R13. | Agreed (built in 5h) |
| C191 | Every NRMS user saw every non-confidential "Approved" activity on the Forecast and in the release lookup (`ReleasesModel.cs:153-156`, `Services.asmx.cs:84-85`), whatever their Calendar access. | The Forecast and the lookup show an activity only to someone the Calendar would show it to: a Calendar role, and the activity's lead or shared ministry among theirs, or HQ. Without Calendar access, the Forecast lists releases only and says why; the lookup says an id exists, never what it is. | R2: one visibility rule wherever activities appear. | Proposed (Q66) |
| C192 | The lookup answered "No result is found." for every activity it wouldn't pre-fill from: unknown, confidential, ended, or not "Approved" (`New.aspx:641-643`). | It names the case: no such activity, deleted, not shown to you, or the activity's title with why nothing is filled in (ended, or not "Approved"). A saved id that wasn't migrated reads "Legacy activity <id>, not migrated". | Staff can tell a typo from an activity that can't be planned against. | Proposed |
| C193 | Opening a release linked to an activity set Has Translations from the activity's Translations on every page load: "None" or "TBD" cleared it, anything else set it (`Release.aspx.cs:59-67, 108-117`). | The activity's Translations are shown as "Translations required" on New release and in Publish settings. Has Translations still follows the uploaded translation files. | Has Translations goes to the public site; set from the activity, it announced translations not yet uploaded. | Proposed |
| C194 | The pre-fill also wrote the chosen ministries' names, plus the activity's Lead Organization, into the formal layout's Organizations box, and ran on every lookup, replacing what was chosen (`New.aspx:651-680`). | Organizations isn't filled in (the Calendar doesn't send Lead Organization, and New release has no Organizations box). The pre-fill runs when asked ("Fill in from activity N"), or at once when the release is started from the Forecast. | Typing an id no longer silently replaces choices. | Proposed (Q67) |
```

`docs/parity/open-questions.md`, in "## Open", after Q64:

```markdown
| Q65 | Once an activity's linked release has **gone out**, should the activity return to the Forecast? Legacy hid an activity only behind a release planned from now on (`ReleasesModel.cs:197-199`), so a release published ahead of its event puts the event back on the Forecast. | Staff may start a second release for an event already announced. | Legacy's rule: it returns. | 2026-10-10 |
| Q66 | Should **NRMS staff without a Calendar role** see the Forecast's activities and the lookup's details, as every legacy NRMS user did? | The Forecast is built to the Calendar's visibility rule (C191): without Calendar access it lists releases only. | No: grant the person a Calendar role (Read Only at an HQ organization sees every ministry's non-confidential activities). | 2026-10-10 |
| Q67 | Should the activity's **Lead Organization** travel to NRMS to fill in a formal release's Organizations, as legacy's pre-fill did? | The Calendar's `activity.*` doesn't carry it, so Organizations is typed by hand (C194). | No. | 2026-10-10 |
```

- [ ] **Step 5: The spec**

In `docs/superpowers/specs/2026-10-07-calendar-parity-design.md`:
- **§5.4,** the `user.upserted` row's producer → consumer becomes "Core → Calendar, NRMS". Its payload cell gains "; NRMS keeps the role, ministries and active only".
- **§11:**
  - After "**When NRMS emits it:** …", add: "A correction or an unpublish in progress reads as published, so only settled statuses are sent; the key and English headline travel with each event but don't cause one (5h)."
  - After the "NRMS's activity projection" bullets, add: "**Visibility in NRMS:** the Forecast and the lookup show an activity only to a staff session the Calendar's `visible()` admits, from Core's `user.upserted` (C191)."
  - In "Activity lookup in the release editor", after "**Pre-fill:** …", add: "Offered on New release, by a button or at once when started from the Forecast; Organizations isn't filled in (C194). Publish settings shows what the saved id names (C192)."
  - "The release shows the activity's Translations as 'translations required'" gains "; Has Translations is not set from them (C193)".
  - In "Forecast tab", after "Sorted by time, …", add: "25 a page, no filters (legacy hid the type filter); for NRMS's read roles, with Start a release for Editors."

- [ ] **Step 6: Running notes, deploy notes, carry-forward**

`docs/manuals/running-notes.md`, append:

```markdown
## Phase 5h — The NRMS link and the Forecast

- **Editor** — Releases has a new first tab, Forecast: releases planned or scheduled from now on, and the Calendar activities a release may be planned for (confirmed, not confidential, an "Approved…" category, starting from now on), in time order.
- **Editor** — On the Forecast, "Start a release" opens New release with the activity's id, and fills in the planned publish time (its start), the location (its city), its lead and shared ministries, sectors, themes and tags. Check them before creating.
- **Editor** — On New release, type a Calendar activity id to see what it is; "Fill in from activity N" copies its details. Nothing is filled in for an activity that has ended, or whose category doesn't start with "Approved"; the page says which.
- **Editor** — A release can be linked only to an activity the Calendar has, and not a deleted one. A release imported with an activity that wasn't migrated shows "Legacy activity N, not migrated" and keeps it until you change it.
- **Editor** — Calendar activities show on the Forecast and in the lookup only if your Calendar access lets you see them in the Calendar. Without Calendar access you see only releases; ask a Calendar administrator for access.
- **Editor** — "Translations required" under the activity id is the activity's Translations list from the Calendar. Has Translations still follows the translation files you upload.
- **All Calendar users** — An activity's "BC Gov News" shows each linked release's status (Draft, Approved, Scheduled, Published, Failed) within a minute of the change in NRMS. A release being corrected or taken down still shows Published until it's done. A deleted release disappears.
- **Operations** — The NRMS migration adds `calendar_activities`, `calendar_viewers` and `organizations.is_hq`. On first start with the Calendar mounted, the stack asks Core to republish once, so NRMS learns who has Calendar access and which organizations are HQ.
- **Operations** — `npm run calendar:replay-to-nrms` and then `npm run nrms:replay-activity-links` (each a dry run until `-- --confirm`) fill NRMS's copy of the Calendar's activities and the Calendar's release lists. The second reports how many releases name an activity that wasn't migrated.
- **Developer** — NRMS never holds a confidential activity's text: a database CHECK keeps such rows to the id, the flag and deletion. No event route says "*", and none carries `activity.*` or `release.status_changed` to the News API (`apps/stack/src/env.test.ts`).
```

`docs/deploy/siteground.md`, after the "### Reports (Phase 5g)" section, before "## Troubleshooting":

```markdown
### NRMS link and Forecast (Phase 5h)

**Migration:** NRMS's `0015_calendar_link` (`calendar_activities`, `calendar_viewers`, `organizations.is_hq`, an index on `news_releases.publish_at`). It runs at startup like the others. The Calendar's schema doesn't change.

**After deploy:**

1. With the Calendar mounted, the stack's reference-data backfill sees NRMS has no Calendar viewers and asks Core to republish once. Without the Calendar (boxs.ca until `gcpe_calendar` exists), nothing is needed yet. After `gcpe_calendar` exists, if NRMS's Forecast shows "Calendar activities are listed here for people with Calendar access" to an HQ user who has Calendar access, run Core's republish by hand (`POST /core/api/admin/republish`, as in "Smoke test").
2. Activities created before this deploy reached NRMS as `ignored` events. Fill NRMS's copy once: `npm run calendar:replay-to-nrms` (dry run), then `-- --confirm`, then a tick. Then `npm run nrms:replay-activity-links` (dry run), then `-- --confirm`, then a tick. Both run from a full checkout with the app's `DATABASE_URL` and `EVENT_SUBSCRIBERS`, like `nrms:replay-to-news-api`.
3. **Seeded users:** run `scripts/siteground-seed-users.sh https://boxs.ca` again to add `planner@example.test` ("Test Release Planner", NRMS Editor with Calendar Read Only at GCPE Headquarters).

**Hand checks on boxs.ca** (spec §16 acceptance 13 and 14; they need `gcpe_calendar`):

1. As cal-editor: create a confirmed Health activity two weeks out, with a category starting "Approved" (cal-sysadmin adds one on Calendar → Lookups) and a city.
2. As planner: Releases → Forecast lists it as "Planned for …". "Start a release" opens New release with the id, the date, the city and Health filled in. Create it.
3. As cal-editor: the activity's "BC Gov News" shows "Release: Draft, …" after a minute. Approve and schedule the release as planner; the activity follows. As editor (no Calendar role), the Forecast lists only releases and says why.
4. Make the activity confidential as cal-editor. As planner, the lookup of its id says "its details aren't shown to you", and the Forecast no longer lists it.
5. In NRMS's database, `SELECT title FROM calendar_activities WHERE is_confidential` returns only nulls; the News API's `inbox_events` has no `activity.%` or `release.status_changed` row.
```

`docs/superpowers/plans/phase-5-carry-forward.md`:
- Delete the whole "## 5h and later" section.
- Add to "## Platform hardening (no phase yet)":

```markdown
- **If service tokens with Calendar roles ever exist, Core's `actorIsHq` should apply only to session callers.** `actorIsHq` (`apps/core/src/services/calendar-access.ts`) today only ever sees a session actor; before a service token could carry a Calendar role, re-check that it still reads HQ membership only for a session caller, not for a bearer/service subject. (NRMS's own Calendar viewer, `apps/nrms/src/calendar/viewer.ts`, is session-only already.)
- **Re-check NRMS "email me a copy" if service tokens ever carry NRMS roles.** `POST /nrms/api/releases/:id/email-copy` (`apps/nrms/src/http/routes.ts`) sends to the bearer's `email` claim. A service token with an NRMS role could then send a release to whatever address its claims name.
```

- Add to "## 5i":

```markdown
- **After the import:** run `npm run calendar:replay-to-nrms -- --confirm`, a tick, then `npm run nrms:replay-activity-links -- --confirm` (spec addendum §12.1 step 2, §11). Put the second's "name an activity NRMS doesn't hold" count in the import report: it is §11's count of releases linked to activities that weren't imported.
```

- [ ] **Step 7: Commit**

```bash
git add tests/e2e/forecast.spec.ts tests/e2e/constants.ts apps/core/src/services/seed-test-users.ts apps/core/src/services/seed-test-users.test.ts scripts/siteground-seed-users.sh docs/parity/changes-from-legacy.md docs/parity/open-questions.md docs/manuals/running-notes.md docs/deploy/siteground.md docs/superpowers/specs/2026-10-07-calendar-parity-design.md docs/superpowers/plans/phase-5-carry-forward.md
git commit -m "test(e2e),docs: parent §10.2's Calendar leg end to end; the planner user; parity C15, C142, C143, C158, C191-C194, Q65-Q67; spec, running and deploy notes"
```

---

## Phase 5h at a glance

| Task | Delivers | Exit evidence |
|---|---|---|
| 1 | The shared rule, the "Approved" test and prefix, bounded ids, the types | `visibility.test.ts` (contract), `category-name.test.ts`, `calendar.test.ts`, `schemas.test.ts`; the Calendar's matrix test unchanged |
| 2 | Event routes: none says "*"; status to the Calendar only; Calendar access to NRMS | `apps/stack/src/env.test.ts` |
| 3 | NRMS's projections, the migration, the backfill | `calendar/projection.test.ts` (10, with ordering and the CHECK), `stack.test.ts` backfill |
| 4 | `release.status_changed` from every status and link write | `releases/link-events.test.ts` (7, including through the HTTP routes) |
| 5 | BC Gov News and the list icon from it | `apps/calendar/src/release-links.test.ts` (7) |
| 6 | The lookup, its visibility, the save rules | `calendar/lookup.test.ts` (11); five tests seeded; `search.spec.ts` |
| 7 | The Forecast API | `calendar/forecast.test.ts` (7) |
| 8 | The two backfills | `replay-to-nrms.test.ts`, `replay-activity-links.test.ts` |
| 9 | The Forecast tab | `ForecastScreen.test.tsx` (7, axe on five states) |
| 10 | The lookup and pre-fill on New release; Publish settings | `ActivityLookupPanel.test.tsx` (6), `NewReleaseScreen.test.tsx` (+4), `SettingsSection.test.tsx` (+2) |
| 11 | End to end; the planner; docs | `forecast.spec.ts` (2); the full e2e suite |

## Risks and things to watch

- **Time zones for "ended" and "from now on":**
  - "Ended" compares BC calendar dates with the runtime's own tzdata (`Intl`). Node 24's tzdata knows BC's permanent UTC−7 (the existing `tzCheck`).
  - "From now on" uses the database's `now()`, an instant, so no zone is involved.
- **Calendar access arrives by event.** A newly granted Calendar role shows activities in NRMS once Core's `user.upserted` reaches NRMS: one dispatch, normally seconds. The same delay applies to a revoked role, as in the Calendar.
- **The Forecast's candidate caps (5,000 releases, 5,000 activities)** are read in full on each page. At legacy volume (spec §13: 534 activities over three months, most not "Approved") a page reads a few hundred rows. Watch the Forecast's response time on boxs.ca once it has data.
- **NRMS without the Calendar (boxs.ca today)** refuses every new activity link: NRMS's projection is empty. Stored links stand. This is H4's cost, stated in the running notes.
- **A future status-writing path** in NRMS must call `emitLinkChange`, or the Calendar falls behind. The route-level test in `link-events.test.ts` exercises every route that writes one today.
- **Not checked here:**
  - the Forecast iCal (deferred, C131);
  - the backfills at legacy volume (19,046 links; 5i runs them against the fixture);
  - SiteGround's behaviour with the new route (no `gcpe_calendar` there yet).

## Self-review (done while writing)

1. **Spec coverage.**
   - **§11:**
     - "When NRMS emits it": Task 4. "Backfill": Task 8.
     - "On the activity": Task 5, plus 5e's existing `ReleasesList`.
     - "NRMS's activity projection": Task 3.
     - The lookup, pre-fill, translations, saving an id and "not deleted": Tasks 6 and 10.
     - "Forecast tab": Tasks 7 and 9. Forecast iCal: deferred (C131).
     - "Releases linked to activities that weren't imported": Task 5 (ignored, link dropped), Task 6 (stored id stands), Task 8 (counted), Task 10 ("Legacy activity N, not migrated").
   - **§5.4:** the events, used unchanged. Task 2 routes them.
   - **§6:** Task 1 (shared rule), Task 6 (viewer), Task 7 (Forecast).
   - **§3 row 5h's exit check:** Task 11.
   - **§16:** acceptance 13 → Tasks 5, 10 and 11; 14 → Tasks 7, 9, 10 and 11; 18 → Tasks 9–11 (axe); the event contract line → Tasks 3–5.
   - **C127:** Tasks 2, 3, 6 and 7. **C142:** Tasks 1 and 6. **C143:** Tasks 4 and 5. **C158:** Tasks 5, 6, 8 and 10. **C15:** Task 11.
   - **The carry-forward:** the table above.
2. **Placeholder scan.** None. Every code step carries its code or the exact lines to change, and every docs step its text.
3. **Type consistency.**
   - `Viewer` and `VisibilityFacts` (Task 1) are used by `calendarViewerOf`, `factsOf` and `forecast` (Tasks 6–7).
   - `LinkState`, `statusChangedData` and `sendStatusChanged` (Task 4) are reused by the link replay (Task 8).
   - `ActivityLookup`, `ReleasePrefill` and `ForecastPage` (Task 1) are produced by Tasks 6–7 and read by Tasks 9–10.
   - `seedActivity` (Task 4) is used by Tasks 6, 7, 8 and `search.spec.ts`.
   - `MAX_ACTIVITY_ID` (Task 1) is used by the route (Task 6) and the screen (Task 10).
4. **Review Focus.** Each of the five has its named tests in its owning tasks (listed there).
5. **Dry run (2026-10-10, on `feat/phase-5h` from `8639f26`).** Every code block above was applied to the worktree in task order, run, and then reverted. Only this plan is committed.
   - Per task:
     - Task 1: the contract, config and nrms-contract tests pass, and so does the Calendar's 48 × 48 agreement test.
     - Task 2: `apps/stack/src` passes (191).
     - Task 3: projection 12 and the backfill test pass; drizzle-kit generated exactly the five statements listed.
     - Task 4: `link-events.test.ts` passes (7). Task 5: `release-links.test.ts` passes (7).
     - Task 6: `lookup.test.ts` passes (11); the five seeded tests failed first as listed.
     - Task 7: `forecast.test.ts` passes (7). Task 8: the replay tests pass (4).
     - Tasks 9–10: staff-web passes (909).
   - Overall:
     - The full Vitest suite passes (4,280 tests, 10 skipped), as do both `tsc` runs.
     - The full e2e suite ran with everything above: 112 passed, 1 skipped (as before), 1 failed. The failure was `search.spec.ts`, which links a made-up activity id; Task 6 now seeds it, and the spec passed on its own re-run.
   - The dry run caught four faults, fixed in the code above:
     - `search.spec.ts` linked a made-up activity id (now seeded);
     - the lookup test's own ministry key was in the wrong case for byte-exact visibility (now a test of its own, 5007);
     - a staff-web union didn't narrow on three states at once;
     - the e2e's `getByLabel("Health")` also matched the Health sector.

## Execution

Execution method: subagent-driven, as the 5e–5g plans were. A fresh implementer per task, then a whole-branch review.

Reviews are lighter this phase, as Paul asked. Low-risk tasks share one; confidentiality and event handling keep their own:

| Review | Tasks | Why |
|---|---|---|
| A (light) | 1 | Contract, config and types; pure tests |
| B | 2 | Event routes: what may reach the News API |
| C | 3 | NRMS's projections: confidential id-only, ordering, the CHECK |
| D | 4 | The producer: every status and link write |
| E | 5 | The Calendar's consumer |
| F | 6 | Lookup visibility and the save rules |
| G | 7 | Forecast visibility |
| H (light) | 9, 10 | Screens, with their axe states |
| I (light) | 8, 11 | Scripts, e2e and docs |

Tasks 1–7 are a chain. Tasks 9–10 need only Tasks 1, 6 and 7, so review H can run while Task 8 is built.
