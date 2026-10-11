# Phase 5i (importer half): The Legacy Calendar Importer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm run calendar:import -- --cutoff <YYYY-MM-DD>` reads the legacy Corporate Calendar and, with `--confirm`, brings in exactly the activities R13 keeps, with their legacy ids: those ending (or starting) on or after the cutoff, deleted ones included, plus every non-deleted awareness date. It brings only their history, favourites and attachments, and only the users who are active or referenced. A no-email user comes in inactive and keeps their activities. Every run writes a report that balances, and a second run changes nothing.

**Architecture:**
- **Read, select, map, then write.** Each step is its own file and its own check:
  - `load.ts` reads every legacy table through `LegacySource` (`-- name:` queries; the fake source in tests). The big tables are already narrowed in SQL by the scope rule.
  - `scope.ts` is pure. It applies the scope rule again in TypeScript, so the rule is tested on the fake source, which ignores SQL. It picks the users, comm contacts, saved filters, favourites, files and log rows that follow from the in-scope activities, and counts what's left out.
  - `map.ts` and `history-map.ts` are pure. They turn legacy rows into Calendar values (statuses, sections, flags, times, keys) and group log rows into history entries.
  - Core's `calendar-users.ts` plans and then writes the users: matched by legacy id, then by email; created otherwise.
  - `apply.ts` and `apply-related.ts` write the Calendar's tables.
  - `run.ts` orders the stages under an advisory lock, writes the report, and decides the exit code.
- **Dry run by default.** Without `--confirm` the run reads, selects, maps and checks the legacy keys against Core, then writes the report. It writes nothing to either database or the file store.
- **Re-runs.** An activity is upserted by legacy id. It is skipped and listed when the Calendar has changed it since the import (`version > imported_version`), and left alone when its mapped values are unchanged. Every other row is copied only the first time it is seen (I3).
- **Seam for the parity check (§12.3, not built here).** The report records the cutoff. `scripts/calendar-report-compare.ts` (5g) stays the comparison tool.

**Tech Stack:** Node 24, TypeScript 5.9, Drizzle 0.45 / drizzle-kit 0.31 on Postgres, zod 3.25, `mssql` through `@gcpe/legacy-import`, `@gcpe/storage`, Vitest 4.1.

**Spec:** `docs/superpowers/specs/2026-10-07-calendar-parity-design.md`:
- §3, the 5i row: the importer half of its exit check.
- §12.1 (import), §12.2 (fixtures), §13 (volumes and the "not surveyed" counts), §5.2 (tables), §7.6 (the `HqSection` mapping).
- §14: C134, C144, C147, C157, C158. §15: Q50 to Q53.
- §16: the unit line "the import scope rule (cutoff boundaries, spanning activities, awareness category, deleted rows)", the real-Postgres line "importer upsert and re-run", and acceptance 15.
- Out of scope: §12.3, the report parity check, which needs Q50's inputs, and §12.4 and production data, which are Phase 7.

The plan also takes these into account:
- `docs/superpowers/plans/phase-5-carry-forward.md`, section "## 5i". It is binding. Each item maps to a task below (see "Carry-forward items taken"), and Task 7 rewrites the section.
- Survey 08 aggregates (`docs/parity/legacy-survey/results/Hub/08-CalendarParity_Queries-aggregates.xlsx`):
  - Category 16 is stored as `Speech /  Remarks`, with two spaces. `sameCategoryName` (PR #23) already handles it, so the importer copies names exactly and a test pins the result.
  - About 6,700 activities at a 2026-11-01 cutoff. That is small enough to hold in memory. The log rows are narrowed in SQL.
  - The `UNK` exclusion matches no legacy ministry. The tenant setting stays; it is harmless.
  - The keyword names Excel turned into dates are an artefact of the export, not of the database. Keywords are copied as text, byte for byte, and a date-like fixture keyword pins it.
- The legacy schema: `~/HUB/gcpe-hub-develop/Hub.Legacy/Gcpe.Hub.Database/calendar/Tables/*.sql` (the `.sqlproj`), plus `dbo/Tables/NewsRelease.sql` for `ActivityId`. Legacy code read while planning:
  - `Calendar/ActivityManager.cs:291-322`: the only fields `calendar.Log` "Update" rows record;
  - `Calendar/Admin/User.aspx.cs:16-25`: comm contact rank is `SortOrder` 1 to 6;
  - `Gcpe.Calendar.Library/Security/CustomPrincipal.cs:14`: `RoleId` 1 to 5.
- The NRMS importer (`apps/nrms/src/import/`) for house style: `cli.ts`'s env and argument parsing, `run.ts`'s advisory lock, `ImportStageError`, the report files beside each other and the exit codes, and the fake-source tests. The replay CLIs (`apps/calendar/src/cli/replay-to-nrms.ts`) for dry run versus `--confirm`.

**Order:**
- Tasks 1 and 2 are pure: selection, then mapping.
- Task 3 is Core's users.
- Tasks 4 and 5 write the Calendar.
- Task 6 wires the run and the CLI, and holds acceptance 15's end-to-end test.
- Task 7 is the docs.

Each task needs the ones before it, except that Task 3 needs only Task 1's types.

**Base:**
- **Branch:** `feat/phase-5i` in `/Users/paul/gcpe-news-platform-p5i`, from `main` at `4b10dce` (5a–5h merged). Every path is repo-relative.
- **Facts this plan relies on (verified by reading the code at `4b10dce`):**
  - **`@gcpe/legacy-import`:**
    - `LegacySource.query(sqlText)` takes no parameters.
    - `createFakeSource(tables)` returns `tables[name]` for the `-- name: <name>` first line and **ignores the SQL**. A missing name throws.
    - `wallClockToInstant(d, timeZone)` reads `d`'s UTC fields as a wall-clock time. The `mssql` driver returns a `DATETIME` that way.
    - The package depends on `mssql`, so only CLI code may import it, never the server (the NRMS importer does the same). `apps/calendar/package.json` doesn't list it yet.
  - **The Calendar (`apps/calendar`):**
    - The schema is in `src/db/schema.ts`. Every lookup, `activities`, `comm_contacts`, `saved_filters` and `activity_files` use `legacyId()`, an identity with "by default", so explicit ids insert.
    - `comm_contacts` is unique on `(user_id, ministry_key)`. The rank CHECK is 1–6 or null.
    - `user_profiles.mobile` has a CHECK: empty, or 12 characters of `[0-9-]`.
    - `activity_files` is unique on `(activity_id, file_name)`, with no cascade.
    - `activity_changes.actor_name` is NOT NULL and `source` is `calendar` or `legacy_log`.
    - Only one migration exists, `0000_init`. `drizzle.config.ts` writes to `./migrations`.
    - `activities/store.ts` exports `JoinIds`, `ActivityRow`, `loadStored(db, id)`, `fieldsOf(stored, timeZone)`, `replaceJoins(tx, id, joins)`, `uniqNum` and `uniqStr`.
    - `list/legacy-filters.ts` exports `migrateLegacySavedFilters(db, rows, resolver)` (it upserts by id), `LegacySavedFilterRow`, `LegacyFilterResolver`, `legacyDisplay` and `legacyHiddenColumns`.
    - `activities/files.ts` exports `attachmentName`.
    - The `ObjectStore` is `localStore(dir)` from `@gcpe/storage`, built in `start.ts` from `CALENDAR_STORAGE_DIR`.
    - `rules.ts` has `rulesFromTenant(tenant)`. The tenant's `calendar.awarenessCategoryIds` is `[2]` (Q52).
    - `test/helpers.ts` has `createCalendarTestDb` and `TEST_RULES` (awareness `[2]`, events category names including `"Sample speech"`).
  - **`@gcpe/calendar-contract`:**
    - `HQ_SECTIONS` holds legacy 1–4 in order. `NEEDS_REVIEW_KEYS` has the 23 keys.
    - `HISTORY_FIELDS` and `LOOK_AHEAD_HISTORY_FIELDS` exist.
    - `checkActivity(fields, ctx)` returns `{ field, message }[]`.
    - `inferLookAhead` compares names with `sameCategoryName`.
  - **`@gcpe/storage`:** `checkAttachment(name, bytes)`, `randomFileKey(prefix, name)` and `downloadContentType`.
  - **Core (`apps/core`):**
    - `users.email` is nullable, with the CHECK `users_active_needs_email`. The unique index is on `lower(email)`.
    - `role_grants` allows one `Calendar.%` role per user. `user_organizations` holds `(user_id, organization_id)`. `user_legacy_ids` holds `(system 'calendar', legacy_id text, user_id)`.
    - `organizations.legacy_id` and `terms.legacy_id` are stored lowercased (`import/run.ts`'s `norm`).
    - `lockAggregate(tx, userAggregateId(id))` and `emitUserUpserted(tx, id, subscribers)` exist. `enqueueEvent` writes `outbox_deliveries` only for the matching subscribers, by name.
    - `test/helpers.ts` has `createCoreTestDb` and `healthOrg`.
    - `CALENDAR_ROLES` (from `@gcpe/auth`) runs ReadOnly to SysAdmin, as legacy's 1–5.
  - **`@gcpe/db-kit`:** `withAdvisoryLock(db, [k1, k2], busy, fn)`. NRMS's import lock is `[0x67637065, 2]`.
  - **Legacy columns** (`.sqlproj`):
    - `SystemUser` has `RoleId`, `DisplayName`, `FullName`, `EmailAddress NVARCHAR(50)`, `IsActive`, `MobileNumber`, `PhoneNumber`, `JobTitle`, `Description`, `FilterDisplayValue`, `HiddenColumns` and `LastUpdatedDateTime`.
    - `CommunicationContact` has `SystemUserId` and a nullable `MinistryId`, `SortOrder` and `IsActive`.
    - The join tables carry an `IsActive`. Sectors, themes, tags and shared-with hold GUIDs.
    - `ActivityFiles` holds `Data`, `FileName`, `FileType`, `FileLength`, `Md5` and `LastUpdatedDateTime`.
    - `Log` holds `FieldName`, `OldValue`, `NewValue`, `Operation`, a nullable `CreatedDateTime` and `CreatedBy`, and a NOT NULL `LastUpdatedDateTime`.
  - **Parity lists:**
    - The highest change row is C194 and the highest question Q67 (checked with `grep -o "^| C[0-9]*"` and `"^| Q[0-9]*"`).
    - These spec rows aren't in the files yet: C131, C134, C137, C140, C144, C152, C155 and C157 (§14), and Q50, Q52 and Q53 (§15).

## Decisions made in planning

Each says why and what it costs if wrong. Task 7 writes the parity rows and questions.

- **I1. The scope rule, exactly** (`scope.ts`, `queries.ts`):
  - **Post-cutoff:** the end, or else the start, is on or after 00:00 on the cutoff date. The test compares legacy wall-clock values with the cutoff's wall-clock midnight, which is exactly "00:00 BC time" whatever BC's offset.
  - **An activity that ends before it starts** (108 in legacy) is post-cutoff when either date is on or after the cutoff. For every other activity this is the same as the spec's rule.
  - **No dates** and not an awareness date: out.
  - **Awareness:** an active category link to one of the tenant's `awarenessCategoryIds`, on an activity that isn't deleted.
  - **The same rule twice:** SQL narrows the big reads, and `selectScope` applies the rule again. SQL dates use `'YYYYMMDD'`, the one literal SQL Server reads the same under every `DATEFORMAT`. The cutoff and the ids are validated before they go into SQL.
  - *Cost if wrong:* Q68 asks whether reversed activities should follow the spec's literal rule. It is one line.
- **I2. The cutoff is a required argument.**
  - It is validated as a real `YYYY-MM-DD` date (`bcDateSchema`) and has no default.
  - No date is hard-coded in source. Tests use the fictional `TEST_CUTOFF = "2027-01-15"`, defined in the fixture file only.
  - Q53 stays open.
- **I3. What a re-run does, table by table** (C195):
  - **Activities** are upserted by legacy id, as the spec says, with the version guard:
    - new: inserted, with `version = imported_version = 1`;
    - `version > imported_version`: skipped and listed ("changed in the Calendar since the last import");
    - a row with no `imported_version` was created in the Calendar: skipped and listed;
    - otherwise, mapped values and join sets equal to the stored ones: unchanged;
    - otherwise: updated, with both versions set to `version + 1`.
  - **Every other row is copied the first time only:** insert if absent, never overwritten. This covers lookups, comm contacts, Core users and their access, profiles, saved filters, favourites, attachments and history. The reason is that none of them has a version, so the import can't tell a Calendar edit from stale legacy data. Overwriting would undo admins' and users' changes, and re-adding would bring back favourites users had removed.
  - Favourites come across only with an activity inserted in this run.
  - History entries are keyed by `activity_changes.legacy_key` (`log:<lowest Log.Id in the group>`).
  - *Cost if wrong:* a legacy edit to a lookup, a contact or a user's profile between two runs doesn't follow. The real cutover is one final run (Phase 7). For test runs, start from an empty Calendar database.
- **I4. Core users** (Core's `import/calendar-users.ts`; C196):
  - **Order of matching:** first `user_legacy_ids` (a re-run), then the email, case-insensitive, then a new user.
  - **New user:** the legacy display name (`DisplayName`, else `FullName`, else "Legacy user <id>"). Active only when legacy `IsActive` is set and the email is valid. The role is `CALENDAR_ROLES[RoleId − 1]`. The ministries are the active `SystemUserMinistry` rows. One `user.upserted`.
  - **Matched by email:**
    - The Calendar role and ministries are set only when the user has no Calendar role and no ministries yet. Otherwise Core's grants stand and the report lists the user.
    - The active flag isn't touched, except for a role-less inactive user (a placeholder from the NRMS import), who is activated when legacy says active. Otherwise the 470 active Calendar users that the NRMS import already created as placeholders couldn't sign in.
  - **Matched by legacy id:** nothing changes, and no event goes out.
  - **Email:** trimmed and lowercased. An invalid one (it fails `z.string().email()`) counts as no email, and the report lists the legacy id.
  - **Duplicate emails:** one Core user. The role and ministries come from one row: the active row last updated, or the last updated if none is active. The user is active if any row is active.
  - **Events:** sent with `CORE_EVENT_SUBSCRIBERS` (names and types only, as the replay CLIs do). If it's unset, the runbook says to run Core's republish.
  - *Cost if wrong:* Q69 asks which account's role should win for duplicates. Admins can change any grant afterwards.
- **I5. Unknown legacy GUIDs stop the run before any write**, in both modes. This covers every GUID the in-scope data uses: contact ministries, shared-with, sectors, themes, tags, the imported comm contacts' ministries and the imported users' ministries. The report lists them by kind and GUID ("fix Core first"). §12.1 names only join rows; a dropped ministry anywhere else would lose access or a contact silently.
- **I6. Rows rejected, and what is mapped to what** (`map.ts`):
  - **Rejected:** an activity whose start, end or NR year is outside 1900–2199 is skipped and reported (carry-forward; the API refuses such years). Everything else that breaks validation is imported and listed by field (`checkActivity`, with `previous` set to itself so only the always-on rules fire).
  - **Status and section:**
    - `StatusId` 7/1/2 maps to new/changed/reviewed. Null or anything else becomes `new`, with a note.
    - `HqStatusId` 7/1 maps to new/changed. Anything else becomes null.
    - `HqSection` 1–4 maps to the four sections, and −n to section n plus Long Term Outlook. 0 or out of range becomes `not_on_la`, with a note (§13 shows none).
  - **Times:**
    - A null `CreatedDateTime` falls back to `LastUpdatedDateTime`, then the start, then the end, then 2000-01-01 00:00. The fallback is fixed, so a re-run sees no change.
    - A deleted activity (`IsActive = 0`) takes `deleted_at` and `deleted_by` from `LastUpdatedDateTime` and `LastUpdatedBy`.
  - **Text:**
    - NUL characters are stripped from all text, because Postgres text refuses them.
    - A lookup's NULL `Name` becomes `""`. A lookup's NULL `IsActive` counts as inactive.
    - Translations are the CSV split, trimmed, with blanks dropped.
    - Category and keyword names are copied byte for byte.
  - **Comm contacts:**
    - A contact with no ministry is skipped. Its activities get no comm contact and are listed (C147).
    - Two contacts that land on one Core user and one ministry merge into the active, lowest-id one, and activities are remapped to it.
- **I7. History** (`history-map.ts`; C134):
  - **Fields mapped:** legacy logs only the 13 members in `ActivityManager.cs:291-305`. They map onto history keys by an explicit table. `PriorityId` rows are skipped and counted. Any other `FieldName` is skipped as "unknown field", never passed through. None maps onto a `LOOK_AHEAD_HISTORY_FIELDS` key, and a test pins it.
  - **Values:**
    - City, comm contact and contact ministry ids become names. An unknown id keeps its raw value.
    - `IsConfirmed` becomes Yes/No.
    - Dates keep legacy's raw text, because its format depended on the server's culture.
  - **Grouping:** one `updated` entry per activity, actor and second (`CreatedDateTime`, else `LastUpdatedDateTime`). A field repeated in a group keeps its first old value and its last new value.
  - **The entry's contact ministry** is the activity's current one, because legacy didn't record the one at the time.
  - **Actors:** an actor who isn't imported keeps their legacy display name, with no user id. A null actor becomes "Unknown legacy user".
- **I8. Attachments** (carry-forward):
  - The MD5 is checked first. A mismatch skips the file and reports it.
  - The name goes through `attachmentName`, falling back to `attachment-<id>`.
  - The key is `randomFileKey("activities/<id>", name)`.
  - The content type is `checkAttachment`'s when it accepts the file, else legacy's `FileType` (served as `application/octet-stream`).
  - The bytes are stored first and deleted again if the row insert fails. Logs name ids only.
  - Files come across only for an activity the Calendar holds from an import (`imported_version` set).
- **I9. The report never holds a person's email, a title, or a saved query's typed values.**
  - Users are listed by legacy id and Core user id.
  - Validation problems are listed by field name only.
  - A dropped saved-filter parameter shows its key and reason, not its value.
  - It is written to `--report` (default `calendar-import-<UTC>.json`) plus a `.txt` beside it.
- **I10. The tables that balance:** users, comm contacts, each lookup, activities, saved filters, favourites, files and log rows. For each, `legacy = outOfScope + planned + inserted + updated + unchanged + skipped`.
  - Release links aren't imported. Legacy `dbo.NewsRelease` links to in-scope and out-of-scope activities are counted as facts (C158).
  - The report also records §13's "not surveyed" counts: users with no or an invalid email, duplicate-email groups, the lowest and highest imported activity id, comm contacts of inactive users, non-deleted awareness dates, history rows (total and most on one activity), activities with two or more categories, and validation problems per field.
- **I11. Sequences.**
  - After the writes, every legacy-id identity is set to `max(id, current value)`. The tables are `activities`, the 11 lookups, `comm_contacts`, `saved_filters` and `activity_files`. It never lowers a value.
  - *Cost if wrong:* a Calendar activity created between two test imports takes an id legacy may also use later. The second run skips that legacy activity and lists it (I3). The real cutover imports once.
- **I12. Exit codes** follow `nrms:import`: 0 when the report balances, 2 when it doesn't, 1 on any error (unknown GUIDs, a stage failure, another import running). A partial report is still written on failure.
- **I13. Lock:** `[0x67637065, 3]` on the Calendar's database, around the confirmed run only.
- **I14. Not built:** `NewsFeed`, `Priority` and `ActivityServices` (R8, R9, C137); release links (NRMS owns them, and `nrms:replay-activity-links` sends them); the report parity check (§12.3).

## Carry-forward items taken

From `docs/superpowers/plans/phase-5-carry-forward.md` § "5i". Task 7 rewrites the section, keeping what 5i doesn't do.

| Item | Where |
|---|---|
| After the import, run `calendar:replay-to-nrms` then `nrms:replay-activity-links`, and report the "not migrated" count | Task 7 runbook. The count of legacy links to activities that weren't imported is also a report fact (I10). |
| Report parity (`calendar:report-compare`, discrepancy 6, In the News empty days, page breaks, Q63) | Not this half. Stays in the section for the parity half. |
| Survey 08: `Speech /  Remarks` | Task 6 (the imported name is kept, and `inferLookAhead` still puts it in Events & Speeches) |
| Survey 08: `UNK` matches nothing; `HqStatusId` 7 → new, 1 → changed; blank Significance; query 8.20; keywords as dates | `HqStatusId`: I6, Task 2. Blank Significance: a validation-problem count (Task 2). Keywords: Task 1 fixture and Task 6. `UNK` and 8.20: nothing to build; Task 7 notes them. |
| Sequences | I11, Task 4 |
| Lookup NULL `Name` → `""` | I6, Task 2 |
| Keys, not ids (GUIDs → Core keys) | I5, Tasks 2 and 4 |
| `comm_contacts` unique on (user, ministry): merge duplicate-email users' contacts | I6, Task 4 |
| Join tables: active rows only, de-duplicated | Task 1 (`selectScope`) |
| Null `CreatedDateTime`, `LastUpdatedDateTime`, `StatusId` | I6, Task 2 |
| Null `Log.CreatedBy` → fallback actor name | I7, Task 2 |
| `SortOrder` → `rank` | I6, Task 4 |
| Empty mobile stays `""` | Task 5 |
| Look Ahead history keys: deny-list | I7, Task 2 |
| `overCap`, null `filter`, `skippedNoOwner` meaning | Task 5 |
| Years 1900–2199: reject and report | I6, Task 2 |
| Saved queries through `migrateLegacySavedFilters` | Task 5 |
| List preferences (`legacyDisplay`, `legacyHiddenColumns`, both together) | Task 5 |
| Attachments (MD5, `randomFileKey`, `attachmentName`, type, no 50 cap) | I8, Task 5 |
| Count activities with two or more categories | I10, Task 6 |
| Count values `checkActivity` refuses on every save | I6, I10, Tasks 2 and 6 |
| No sweeper for orphaned attachment bytes | Not the importer's. Stays. |

## Global Constraints

- **Worktree and commits:**
  - Work on `feat/phase-5i` in `/Users/paul/gcpe-news-platform-p5i`. Commit locally after each task, with a plain message. Don't push until the branch is reviewed.
  - **Never add `Co-Authored-By` or any AI attribution** to a commit. Never commit `CLAUDE.md`.
  - **No task, decision or round labels in code comments** ("Task 3", "I4", "fix round 1"). Spec row ids (C157, Q53) and legacy file references are fine.
- **Node 24 for everything:**
  - Tests: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run <paths>`.
  - Type-check: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`.
  - Packages: `npx -y -p node@24 -- npm install --ignore-scripts`.
- **Every behaviour change starts with a real RED run:** run the new test, see it fail for the stated reason, then implement.
- **Migrations only through drizzle-kit,** from the app folder: `cd apps/calendar && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name legacy_import`. Never hand-edit generated DDL.
- **Fixtures:** synthetic only, with fictional names, `example.test` addresses and fictional GUIDs. Never a real legacy name, address, title or other PII or confidential text. Legacy ids and enum values (status 1/2/7, `HqSection`, city 311, categories 2/12/58) are fine.
- **No debug logging.** The CLI prints the report's counts. Logs carry `safeErrorLabel` and the command or route only: never a query string, title, email or file name.
- **The cutoff is never hard-coded** outside test fixtures (Q53).
- **Server code never imports `@gcpe/legacy-import` or `src/import/*`.** Only `src/import/cli.ts` and tests do, so `mssql` stays out of the stack bundle.
- **Parity lists:**
  - New change rows go in `docs/parity/changes-from-legacy.md` from C195. New questions go in `docs/parity/open-questions.md` from Q68. Check with `grep -o "^| C[0-9]*"` that no number is reused.
  - Running-notes lines carry the legend's role tags (`docs/manuals/running-notes.md`).

## Review Focus

1. **A legacy end time exactly at midnight on the cutoff, or 3 ms before it.** Expected: in, and out. Pinned in Task 1 ("the cutoff boundary…").
2. **A confidential activity's title, a user's email or a saved query's typed text reaching the report or the console.** Expected: none appear; users by id, problems by field. Pinned in Task 6 ("the report holds no title, email or query text").
3. **Legacy NULLs in columns the Calendar holds NOT NULL** (lookup `Name`, `CreatedDateTime`, `StatusId`, `Log.CreatedBy`), and NUL characters in text. Expected: imported with the stated fallbacks, never a crash. Pinned in Task 2 ("nulls and NULs…").
4. **An attachment whose legacy name is a Windows path, a blocked type, or has a wrong MD5.** Expected: the bare name, legacy's type served as a download, and a skip with a reason. Pinned in Task 5 ("attachments…").
5. **A second run after someone edited an imported activity, removed a favourite and renamed a saved query in the Calendar.** Expected: nothing reverted. The activity is listed as changed in the Calendar. Pinned in Task 6 ("a re-run after Calendar edits reverts nothing").

---

## File structure

| File | Responsibility |
|---|---|
| `apps/calendar/src/import/legacy-rows.ts` | Typed legacy rows and the `LegacySnapshot` |
| `apps/calendar/src/import/queries.ts` | `-- name:` queries; the scope SQL |
| `apps/calendar/src/import/load.ts` | `loadLegacy(source, opts)` |
| `apps/calendar/src/import/scope.ts` | `selectScope` (pure): activities, users, contacts, filters, favourites, files, logs, joins, out-of-scope counts |
| `apps/calendar/src/import/map.ts` | Activity and lookup mapping, user candidates, the GUID check, validation problems (pure) |
| `apps/calendar/src/import/history-map.ts` | Log rows → history entries (pure) |
| `apps/calendar/src/import/report.ts` | `CalendarImportReport` |
| `apps/calendar/src/import/apply.ts` | Lookups, comm contacts, activities with joins, sequences |
| `apps/calendar/src/import/apply-related.ts` | Favourites, profiles, saved filters, attachments, history |
| `apps/calendar/src/import/run.ts` | The stages, lock, dry run, report files, exit code |
| `apps/calendar/src/import/cli.ts` | Env and argv; `npm run calendar:import` |
| `apps/calendar/test/legacy-calendar-fixture.ts` | The synthetic legacy database and its Core seed |
| `apps/core/src/import/legacy-keys.ts` | Legacy GUID → Core organization or term |
| `apps/core/src/import/calendar-users.ts` | Plan and apply Calendar users in Core |
| `apps/calendar/src/db/schema.ts`, `apps/calendar/migrations/0001_legacy_import.sql` | `activities.imported_version`, `activity_changes.legacy_key` |
| `docs/deploy/siteground.md`, `docs/parity/*`, `docs/manuals/running-notes.md`, `docs/superpowers/plans/phase-5-carry-forward.md` | Runbook and tracking |

---

### Task 1: Legacy reads, the scope rule, and the synthetic fixture

**Risk:** data-integrity (full review). This is the keystone: what's selected is what's imported.

**Files:**
- Create: `apps/calendar/src/import/legacy-rows.ts`, `apps/calendar/src/import/queries.ts`, `apps/calendar/src/import/load.ts`, `apps/calendar/src/import/scope.ts`, `apps/calendar/test/legacy-calendar-fixture.ts`
- Test: `apps/calendar/src/import/scope.test.ts`, `apps/calendar/src/import/queries.test.ts`
- Modify: `apps/calendar/package.json` (add `"@gcpe/legacy-import": "0.0.0"` to `dependencies`), `package-lock.json` (via `npm install`)

**Interfaces:**
- Produces:
  - `LegacySnapshot` and row types (`LegacyActivity`, `LegacyJoinRow`, `LegacyUser`, `LegacyUserMinistry`, `LegacyCommContact`, `LegacySavedFilter`, `LegacyFavourite`, `LegacyFile`, `LegacyLog`, `LegacyLookup`, `LegacyReleaseLink`), and `JOIN_TABLES` / `JoinTable`.
  - `activityScopeSql(cutoff: string, awarenessCategoryIds: readonly number[]): string`.
  - `loadLegacy(source: LegacySource, o: ScopeOptions): Promise<LegacySnapshot>`.
  - `selectScope(s: LegacySnapshot, o: ScopeOptions): Scope`, `isPostCutoff(a, cutoffMs): boolean` and `cutoffWallMs(cutoff): number`.
  - `ScopeOptions = { cutoff: string; awarenessCategoryIds: readonly number[] }`.
  - The fixture: `legacyCalendarTables()`, `TEST_CUTOFF`, `GUID`, `CONFIDENTIAL_MARKER`, `seedCoreForImport(coreDb)`.

- [ ] **Step 1: Write the row types** in `legacy-rows.ts`:

```ts
/** Legacy calendar.* rows as the importer reads them (Gcpe.Hub.Database/calendar/Tables). DATETIME
 * values arrive as Dates whose UTC fields hold the BC wall-clock time. */
export interface LegacyActivity {
  Id: number;
  StartDateTime: Date | null; EndDateTime: Date | null; NRDateTime: Date | null;
  PotentialDates: string | null;
  Title: string; Details: string; Schedule: string; Significance: string;
  Strategy: string | null; Comments: string | null; HqComments: string | null;
  LeadOrganization: string | null; Venue: string | null; OtherCity: string | null; Translations: string | null;
  StatusId: number | null; HqStatusId: number | null; HqSection: number;
  NRDistributionId: number | null; PremierRequestedId: number | null; ContactMinistryId: string | null;
  GovernmentRepresentativeId: number | null; CommunicationContactId: number | null;
  EventPlannerId: number | null; VideographerId: number | null; CityId: number | null;
  IsActive: boolean; IsConfirmed: boolean; IsIssue: boolean; IsAllDay: boolean; IsAtLegislature: boolean;
  IsConfidential: boolean; IsCrossGovernment: boolean; IsMilestone: boolean;
  IsTitleNeedsReview: boolean; IsDetailsNeedsReview: boolean; IsRepresentativeNeedsReview: boolean;
  IsCityNeedsReview: boolean; IsStartDateNeedsReview: boolean; IsEndDateNeedsReview: boolean;
  IsCategoriesNeedsReview: boolean; IsCommMaterialsNeedsReview: boolean; IsActiveNeedsReview: boolean;
  IsSignificanceNeedsReview: boolean; IsStrategyNeedsReview: boolean; IsSchedulingConsiderationsNeedsReview: boolean;
  IsInternalNotesNeedsReview: boolean; IsLeadOrganizationNeedsReview: boolean; IsInitiativesNeedsReview: boolean;
  IsTagsNeedsReview: boolean; IsOriginNeedsReview: boolean; IsDistributionNeedsReview: boolean;
  IsTranslationsRequiredNeedsReview: boolean; IsPremierRequestedNeedsReview: boolean; IsVenueNeedsReview: boolean;
  IsEventPlannerNeedsReview: boolean; IsDigitalNeedsReview: boolean;
  CreatedDateTime: Date | null; CreatedBy: number | null; LastUpdatedDateTime: Date | null; LastUpdatedBy: number | null;
}
/** Every activity join table, read as (ActivityId, ValueId): an int lookup id or a GUID. */
export interface LegacyJoinRow { ActivityId: number; ValueId: number | string; IsActive: boolean }
export const JOIN_TABLES = ["categories", "commMaterials", "initiatives", "keywords", "nrOrigins", "sectors", "themes", "tags", "sharedWith"] as const;
export type JoinTable = (typeof JOIN_TABLES)[number];
export interface LegacyUser {
  Id: number; RoleId: number; DisplayName: string | null; FullName: string | null; EmailAddress: string | null;
  IsActive: boolean; JobTitle: string | null; PhoneNumber: string | null; MobileNumber: string | null; Description: string | null;
  FilterDisplayValue: number | null; HiddenColumns: string | null; LastUpdatedDateTime: Date | null;
}
export interface LegacyUserMinistry { SystemUserId: number; MinistryId: string; IsActive: boolean }
export interface LegacyCommContact { Id: number; SystemUserId: number; MinistryId: string | null; SortOrder: number | null; IsActive: boolean | null }
export interface LegacySavedFilter { Id: number; CreatedBy: number | null; Name: string | null; QueryString: string | null; SortOrder: number | null; IsActive: boolean | null }
export interface LegacyFavourite { SystemUserId: number; ActivityId: number }
export interface LegacyFile { Id: number; ActivityId: number; Data: Buffer; FileName: string; FileType: string; FileLength: number; Md5: string; LastUpdatedDateTime: Date; LastUpdatedBy: number | null }
export interface LegacyLog { Id: number; ActivityId: number; FieldName: string | null; OldValue: string | null; NewValue: string | null; Operation: string; CreatedDateTime: Date | null; CreatedBy: number | null; LastUpdatedDateTime: Date }
export interface LegacyLookup { Id: number; Name: string | null; SortOrder: number | null; IsActive: boolean | null; PhoneNumber?: string | null; JobTitle?: string | null; Description?: string | null; ShortName?: string | null }
export interface LegacyReleaseLink { ActivityId: number; N: number }
export const LOOKUP_TABLES = ["categories", "cities", "commMaterials", "eventPlanners", "governmentRepresentatives", "initiatives", "keywords", "nrDistributions", "nrOrigins", "premierRequested", "videographers"] as const;
export type LookupTable = (typeof LOOKUP_TABLES)[number];

export interface LegacySnapshot {
  activities: LegacyActivity[];
  joins: Record<JoinTable, LegacyJoinRow[]>;
  users: LegacyUser[];
  userMinistries: LegacyUserMinistry[];
  commContacts: LegacyCommContact[];
  savedFilters: LegacySavedFilter[];
  favourites: LegacyFavourite[];
  files: LegacyFile[];
  logs: LegacyLog[];
  lookups: Record<LookupTable, LegacyLookup[]>;
  releaseLinks: LegacyReleaseLink[];
  /** Whole-table counts, so rows SQL already left out are still counted as out of scope. */
  totals: { activities: number; favourites: number; files: number; logs: number };
}
```

- [ ] **Step 2: Write the failing query test** (`queries.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { activityScopeSql, Q } from "./queries";

describe("legacy queries", () => {
  it("puts the cutoff in SQL Server's unambiguous YYYYMMDD form, and the awareness ids as integers", () => {
    const s = activityScopeSql("2027-01-15", [2]);
    expect(s).toContain("a.EndDateTime >= '20270115'");
    expect(s).toContain("a.StartDateTime >= '20270115'");
    expect(s).toContain("ac.CategoryId IN (2)");
    expect(s).toContain("a.IsActive = 1");
  });
  it("refuses anything that isn't a plain date or a positive integer id, so nothing reaches SQL unchecked", () => {
    expect(() => activityScopeSql("2027-01-15'; DROP TABLE x;--", [2])).toThrow();
    expect(() => activityScopeSql("15/01/2027", [2])).toThrow();
    expect(() => activityScopeSql("2027-01-15", [2.5])).toThrow();
    expect(() => activityScopeSql("2027-01-15", [-1])).toThrow();
  });
  it("matches nothing for awareness when the tenant lists no awareness category", () => {
    expect(activityScopeSql("2027-01-15", [])).toContain("1 = 0");
  });
  it("names every query on its first line, as the fake source requires", () => {
    for (const sql of Object.values(Q("2027-01-15", [2]))) expect(sql).toMatch(/^-- name: \S+\n/);
  });
});
```

- [ ] **Step 3: Run it** and see it fail because `./queries` doesn't exist: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/import/queries.test.ts`.

- [ ] **Step 4: Write `queries.ts`:**

```ts
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The scope rule (spec addendum §12.1, R13) in SQL, to narrow the big reads. scope.ts applies the
 * same rule again in TypeScript. Legacy DATETIMEs are BC wall-clock values, so comparing them with
 * the cutoff date is "on or after 00:00 BC time". 'YYYYMMDD' is the one literal SQL Server reads
 * the same under every DATEFORMAT.
 */
export function activityScopeSql(cutoff: string, awarenessCategoryIds: readonly number[]): string {
  const m = DATE.exec(cutoff);
  if (!m) throw new Error("the cutoff must be YYYY-MM-DD");
  if (awarenessCategoryIds.some((n) => !Number.isSafeInteger(n) || n <= 0)) throw new Error("awareness category ids must be positive integers");
  const day = `${m[1]}${m[2]}${m[3]}`;
  const post = `(a.EndDateTime >= '${day}' OR a.StartDateTime >= '${day}')`;
  const awareness = awarenessCategoryIds.length === 0
    ? "1 = 0"
    : `(a.IsActive = 1 AND EXISTS (SELECT 1 FROM calendar.ActivityCategories ac WHERE ac.ActivityId = a.Id AND ac.IsActive = 1 AND ac.CategoryId IN (${awarenessCategoryIds.join(",")})))`;
  return `(${post} OR ${awareness})`;
}

const inScope = (scope: string, col: string) => `${col} IN (SELECT a.Id FROM calendar.Activity a WHERE ${scope})`;
const join = (name: string, table: string, value: string, scope: string) =>
  `-- name: ${name}\nSELECT j.ActivityId, j.${value} AS ValueId, j.IsActive FROM calendar.${table} j WHERE j.IsActive = 1 AND ${inScope(scope, "j.ActivityId")}`;
const lookup = (name: string, table: string, extra = "") => `-- name: ${name}\nSELECT Id, Name, SortOrder, IsActive${extra} FROM calendar.${table}`;

/** Every query the importer runs, keyed by its `-- name:`. */
export function Q(cutoff: string, awarenessCategoryIds: readonly number[]) {
  const s = activityScopeSql(cutoff, awarenessCategoryIds);
  return {
    activities: `-- name: activities\nSELECT a.* FROM calendar.Activity a WHERE ${s}`,
    activityCount: "-- name: activityCount\nSELECT COUNT(*) AS N FROM calendar.Activity",
    categories: join("activityCategories", "ActivityCategories", "CategoryId", s),
    commMaterials: join("activityCommMaterials", "ActivityCommunicationMaterials", "CommunicationMaterialId", s),
    initiatives: join("activityInitiatives", "ActivityInitiatives", "InitiativeId", s),
    keywords: join("activityKeywords", "ActivityKeywords", "KeywordId", s),
    nrOrigins: join("activityNrOrigins", "ActivityNROrigins", "NROriginId", s),
    sectors: join("activitySectors", "ActivitySectors", "SectorId", s),
    themes: join("activityThemes", "ActivityThemes", "ThemeId", s),
    tags: join("activityTags", "ActivityTags", "TagId", s),
    sharedWith: join("activitySharedWith", "ActivitySharedWith", "MinistryId", s),
    users:
      "-- name: users\nSELECT Id, RoleId, DisplayName, FullName, EmailAddress, IsActive, JobTitle, PhoneNumber, MobileNumber, Description, FilterDisplayValue, HiddenColumns, LastUpdatedDateTime FROM calendar.SystemUser",
    userMinistries: "-- name: userMinistries\nSELECT SystemUserId, MinistryId, IsActive FROM calendar.SystemUserMinistry WHERE IsActive = 1 AND SystemUserId IS NOT NULL AND MinistryId IS NOT NULL",
    commContacts: "-- name: commContacts\nSELECT Id, SystemUserId, MinistryId, SortOrder, IsActive FROM calendar.CommunicationContact",
    savedFilters: "-- name: savedFilters\nSELECT Id, CreatedBy, Name, QueryString, SortOrder, IsActive FROM calendar.ActivityFilter",
    favourites: `-- name: favourites\nSELECT f.SystemUserId, f.ActivityId FROM calendar.FavoriteActivity f WHERE ${inScope(s, "f.ActivityId")}`,
    favouriteCount: "-- name: favouriteCount\nSELECT COUNT(*) AS N FROM calendar.FavoriteActivity",
    files: `-- name: files\nSELECT f.Id, f.ActivityId, f.Data, f.FileName, f.FileType, f.FileLength, f.Md5, f.LastUpdatedDateTime, f.LastUpdatedBy FROM calendar.ActivityFiles f WHERE ${inScope(s, "f.ActivityId")}`,
    fileCount: "-- name: fileCount\nSELECT COUNT(*) AS N FROM calendar.ActivityFiles",
    logs: `-- name: logs\nSELECT l.Id, l.ActivityId, l.FieldName, l.OldValue, l.NewValue, l.Operation, l.CreatedDateTime, l.CreatedBy, l.LastUpdatedDateTime FROM calendar.Log l WHERE ${inScope(s, "l.ActivityId")}`,
    logCount: "-- name: logCount\nSELECT COUNT(*) AS N FROM calendar.Log",
    releaseLinks: "-- name: releaseLinks\nSELECT ActivityId, COUNT(*) AS N FROM dbo.NewsRelease WHERE ActivityId IS NOT NULL GROUP BY ActivityId",
    lkCategories: lookup("categories", "Category"),
    lkCities: lookup("cities", "City"),
    lkCommMaterials: lookup("commMaterials", "CommunicationMaterial"),
    lkEventPlanners: lookup("eventPlanners", "EventPlanner", ", PhoneNumber, JobTitle"),
    lkGovernmentRepresentatives: lookup("governmentRepresentatives", "GovernmentRepresentative", ", Description"),
    lkInitiatives: lookup("initiatives", "Initiative", ", ShortName"),
    lkKeywords: lookup("keywords", "Keyword"),
    lkNrDistributions: lookup("nrDistributions", "NRDistribution"),
    lkNrOrigins: lookup("nrOrigins", "NROrigin"),
    lkPremierRequested: lookup("premierRequested", "PremierRequested"),
    lkVideographers: lookup("videographers", "Videographer", ", JobTitle"),
  };
}
```

- [ ] **Step 5: Run the query test and see it pass.**

- [ ] **Step 6: Write the fixture** (`apps/calendar/test/legacy-calendar-fixture.ts`). Every name and address is fictional. Each row's comment says which §12.2 case it stands for.

```ts
import { createHash } from "node:crypto";
import type { Db } from "@gcpe/db-kit";
import { upsertOrganization } from "../../core/src/services/organizations";
import { upsertTerm } from "../../core/src/services/terms";
import { createUser } from "../../core/src/services/users";
import { healthOrg } from "../../core/test/helpers";
import type { LegacyActivity } from "../src/import/legacy-rows";

/** A fictional cutoff, used by tests only: the real one is Q53's, passed with --cutoff. */
export const TEST_CUTOFF = "2027-01-15";
/** Fictional legacy GUIDs, uppercase as legacy stores them. */
export const GUID = {
  fin: "0F000000-0000-4000-8000-000000000001",
  hlth: "0F000000-0000-4000-8000-000000000002",
  hq: "0F000000-0000-4000-8000-000000000003",
  sector: "0F000000-0000-4000-8000-000000000004",
  theme: "0F000000-0000-4000-8000-000000000005",
  tag: "0F000000-0000-4000-8000-000000000006",
  unknown: "0F000000-0000-4000-8000-0000000000FF",
} as const;
/** Appears only in the confidential activity's title: the report must never contain it. */
export const CONFIDENTIAL_MARKER = "Sample confidential subject";
const wall = (iso: string) => new Date(`${iso}Z`);
export const PDF_BYTES = Buffer.from("%PDF-1.4\n% sample\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n");
const md5 = (b: Buffer) => createHash("md5").update(b).digest("hex").toUpperCase();

function activity(Id: number, over: Partial<LegacyActivity>): LegacyActivity {
  return {
    Id, StartDateTime: null, EndDateTime: null, NRDateTime: null, PotentialDates: null,
    Title: `Sample activity ${Id}`, Details: "Sample details", Schedule: "", Significance: "Sample significance",
    Strategy: null, Comments: null, HqComments: null, LeadOrganization: null, Venue: null, OtherCity: null, Translations: null,
    StatusId: 2, HqStatusId: null, HqSection: 2, NRDistributionId: null, PremierRequestedId: null, ContactMinistryId: GUID.fin,
    GovernmentRepresentativeId: null, CommunicationContactId: 501, EventPlannerId: null, VideographerId: null, CityId: 5,
    IsActive: true, IsConfirmed: false, IsIssue: false, IsAllDay: false, IsAtLegislature: false, IsConfidential: false,
    IsCrossGovernment: false, IsMilestone: false,
    IsTitleNeedsReview: false, IsDetailsNeedsReview: false, IsRepresentativeNeedsReview: false, IsCityNeedsReview: false,
    IsStartDateNeedsReview: false, IsEndDateNeedsReview: false, IsCategoriesNeedsReview: false, IsCommMaterialsNeedsReview: false,
    IsActiveNeedsReview: false, IsSignificanceNeedsReview: false, IsStrategyNeedsReview: false, IsSchedulingConsiderationsNeedsReview: false,
    IsInternalNotesNeedsReview: false, IsLeadOrganizationNeedsReview: false, IsInitiativesNeedsReview: false, IsTagsNeedsReview: false,
    IsOriginNeedsReview: false, IsDistributionNeedsReview: false, IsTranslationsRequiredNeedsReview: false, IsPremierRequestedNeedsReview: false,
    IsVenueNeedsReview: false, IsEventPlannerNeedsReview: false, IsDigitalNeedsReview: false,
    CreatedDateTime: wall("2026-09-01T10:00:00"), CreatedBy: 11, LastUpdatedDateTime: wall("2026-09-02T10:00:00"), LastUpdatedBy: 11,
    ...over,
  };
}
const lk = (Id: number, Name: string | null, IsActive: boolean | null = true, extra: object = {}) => ({ Id, Name, SortOrder: Id, IsActive, ...extra });
const user = (Id: number, EmailAddress: string | null, IsActive: boolean, RoleId: number, over: object = {}) => ({
  Id, RoleId, DisplayName: `Sample User ${Id}`, FullName: null, EmailAddress, IsActive, JobTitle: null, PhoneNumber: null,
  MobileNumber: "", Description: null, FilterDisplayValue: null, HiddenColumns: null, LastUpdatedDateTime: wall("2026-01-01T00:00:00"), ...over,
});
const j = (ActivityId: number, ValueId: number | string, IsActive = true) => ({ ActivityId, ValueId, IsActive });
const log = (Id: number, ActivityId: number, FieldName: string | null, Operation: string, CreatedBy: number | null, at: string, OldValue: string | null = "a", NewValue: string | null = "b") =>
  ({ Id, ActivityId, FieldName, OldValue, NewValue, Operation, CreatedDateTime: wall(at), CreatedBy, LastUpdatedDateTime: wall(at) });

/** The synthetic legacy database, keyed by query name (queries.ts). */
export function legacyCalendarTables(): Record<string, Record<string, unknown>[]> {
  const activities = [
    activity(1001, { StartDateTime: wall("2027-01-20T09:00:00"), EndDateTime: wall("2027-01-20T10:00:00"), StatusId: 7, HqSection: 2, CityId: 311, OtherCity: "Sample Bay",
      Translations: "French, Punjabi ,,", IsTitleNeedsReview: true, IsDigitalNeedsReview: true, CreatedBy: 11, LastUpdatedBy: 12 }),
    activity(1002, { StartDateTime: wall("2027-01-14T09:00:00"), EndDateTime: wall("2027-01-15T00:00:00"), HqSection: 1 }), // ends exactly at the cutoff
    activity(1003, { StartDateTime: wall("2027-01-14T09:00:00"), EndDateTime: new Date(Date.UTC(2027, 0, 14, 23, 59, 59, 997)) }), // 3 ms before: out
    activity(1004, { StartDateTime: wall("2026-12-01T09:00:00"), EndDateTime: wall("2027-02-01T17:00:00"), HqSection: 3, CommunicationContactId: 504 }), // spans the cutoff
    activity(1005, { StartDateTime: wall("2027-01-16T09:00:00"), EndDateTime: wall("2027-01-16T10:00:00"), HqSection: 4, IsActive: false, LastUpdatedBy: 12 }), // deleted, post-cutoff
    activity(1006, { StartDateTime: wall("2019-05-01T00:00:00"), EndDateTime: wall("2019-05-01T23:45:00"), IsAllDay: true, HqSection: -1 }), // awareness, before the cutoff
    activity(1007, { StartDateTime: wall("2018-05-01T00:00:00"), EndDateTime: wall("2018-05-01T23:45:00"), IsAllDay: true, IsActive: false }), // awareness, deleted: out
    activity(1008, { StartDateTime: wall("2026-06-01T09:00:00"), EndDateTime: wall("2026-06-01T10:00:00"), CreatedBy: 15, LastUpdatedBy: 15 }), // before the cutoff; has a release, log, favourite, file
    activity(1009, { StartDateTime: wall("2027-03-01T09:00:00"), EndDateTime: null, HqSection: -2, CommunicationContactId: null, CreatedBy: 16, LastUpdatedBy: 16 }), // no end; no comm contact (C147)
    activity(1010, { StartDateTime: wall("2027-02-10T09:00:00"), EndDateTime: wall("2027-01-10T09:00:00"), HqSection: -3 }), // ends before it starts
    activity(1011, { StartDateTime: wall("2027-01-18T09:00:00"), EndDateTime: wall("2027-01-18T10:00:00"), HqSection: -4, IsConfidential: true, StatusId: 1, HqStatusId: 1,
      Title: `${CONFIDENTIAL_MARKER} ${"x".repeat(217 - CONFIDENTIAL_MARKER.length - 1)}` }), // confidential, shared with HLTH, 217-character title
    activity(1012, { StartDateTime: wall("2027-01-22T09:00:00"), EndDateTime: wall("2027-01-22T10:00:00"), StatusId: null, HqStatusId: 7, HqSection: 0, IsConfirmed: true,
      CreatedDateTime: null, Details: "Sample\u0000details" }), // nulls, HqSection 0, a NUL, the two-space category
    activity(1013, { StartDateTime: wall("2027-02-01T09:00:00"), EndDateTime: wall("2250-01-01T09:00:00") }), // year out of range: rejected
    activity(1014, {}), // no dates, not awareness: out
  ];
  return {
    activities,
    activityCount: [{ N: activities.length }],
    activityCategories: [j(1001, 12), j(1001, 58), j(1002, 12), j(1004, 12), j(1005, 12), j(1006, 2), j(1007, 2), j(1008, 58), j(1009, 12), j(1010, 12), j(1011, 12), j(1012, 16), j(1013, 12), j(1001, 12) /* duplicate */, j(1002, 58, false) /* inactive */],
    activityCommMaterials: [j(1001, 3), j(1012, 61)],
    activityInitiatives: [j(1001, 7)],
    activityKeywords: [j(1001, 40), j(1001, 41)],
    activityNrOrigins: [j(1001, 8)],
    activitySectors: [j(1001, GUID.sector)],
    activityThemes: [j(1001, GUID.theme)],
    activityTags: [j(1001, GUID.tag)],
    activitySharedWith: [j(1011, GUID.hlth)],
    users: [
      user(11, "avery.sample@example.test", true, 2), // matches an active Core user with an NRMS role
      user(12, "blake.sample@example.test", true, 5), // matches a role-less inactive placeholder
      user(13, "casey.shared@example.test", true, 3, { LastUpdatedDateTime: wall("2026-01-01T00:00:00") }), // shares an email with 14
      user(14, " CASEY.shared@example.test ", false, 4, { LastUpdatedDateTime: wall("2026-06-01T00:00:00") }),
      user(15, "drew.sample@example.test", false, 1), // inactive, referenced only by an out-of-scope activity: not imported
      user(16, null, false, 1), // no email, creator of 1009: imported inactive
      user(17, "ellis.sample@example.test", false, 1), // inactive, unreferenced: not imported
      user(18, "finley.sample@example.test", false, 1, { DisplayName: "Finley Sample" }), // only a log actor: not imported
      user(19, "gray.sample@example.test", false, 2, { FilterDisplayValue: 4, HiddenColumns: "1,3" }), // owns an active saved filter
      user(20, "harper.sample@example.test", false, 2), // has a favourite on 1004
      user(21, "indy.sample@example.test", false, 2, { MobileNumber: "250-555-01" }), // an active comm contact's user; bad mobile
      user(22, "not-an-address", true, 2), // invalid email: imported inactive with none
    ],
    userMinistries: [
      { SystemUserId: 11, MinistryId: GUID.fin, IsActive: true }, { SystemUserId: 12, MinistryId: GUID.hq, IsActive: true },
      { SystemUserId: 13, MinistryId: GUID.fin, IsActive: true }, { SystemUserId: 14, MinistryId: GUID.hlth, IsActive: true },
      { SystemUserId: 17, MinistryId: GUID.unknown, IsActive: true }, // an out-of-scope user's unknown GUID never stops the run
    ],
    commContacts: [
      { Id: 501, SystemUserId: 11, MinistryId: GUID.fin, SortOrder: 1, IsActive: true },
      { Id: 502, SystemUserId: 21, MinistryId: GUID.hlth, SortOrder: 4, IsActive: true },
      { Id: 503, SystemUserId: 13, MinistryId: GUID.fin, SortOrder: 2, IsActive: true },
      { Id: 504, SystemUserId: 14, MinistryId: GUID.fin, SortOrder: 3, IsActive: false }, // same person and ministry as 503: merged
      { Id: 505, SystemUserId: 17, MinistryId: GUID.fin, SortOrder: 6, IsActive: false }, // inactive, unreferenced: out
      { Id: 506, SystemUserId: 12, MinistryId: null, SortOrder: 0, IsActive: true }, // no ministry: skipped
    ],
    savedFilters: [
      { Id: 701, CreatedBy: 11, Name: "Sample filter", QueryString: "Ministries=Sample&Status=7", SortOrder: 1, IsActive: true },
      { Id: 702, CreatedBy: 19, Name: "Sample stale filter", QueryString: "ActivityListProvider.aspx?Status=1&QuickSearch=sample%20typed%20text", SortOrder: 2, IsActive: true },
      { Id: 703, CreatedBy: 17, Name: "Sample old filter", QueryString: "Status=2", SortOrder: 3, IsActive: false },
    ],
    favourites: [{ SystemUserId: 11, ActivityId: 1001 }, { SystemUserId: 20, ActivityId: 1004 }, { SystemUserId: 15, ActivityId: 1008 }],
    favouriteCount: [{ N: 3 }],
    files: [
      { Id: 801, ActivityId: 1001, Data: PDF_BYTES, FileName: "C:\\fakepath\\briefing.pdf", FileType: "application/pdf", FileLength: PDF_BYTES.length, Md5: md5(PDF_BYTES), LastUpdatedDateTime: wall("2026-09-03T10:00:00"), LastUpdatedBy: 11 },
      { Id: 802, ActivityId: 1001, Data: PDF_BYTES, FileName: "tampered.pdf", FileType: "application/pdf", FileLength: PDF_BYTES.length, Md5: "0".repeat(32), LastUpdatedDateTime: wall("2026-09-03T10:00:00"), LastUpdatedBy: 11 },
      { Id: 803, ActivityId: 1008, Data: PDF_BYTES, FileName: "old.pdf", FileType: "application/pdf", FileLength: PDF_BYTES.length, Md5: md5(PDF_BYTES), LastUpdatedDateTime: wall("2026-05-03T10:00:00"), LastUpdatedBy: 15 },
      { Id: 804, ActivityId: 1011, Data: Buffer.from("MZsample"), FileName: "notes.exe", FileType: "application/x-msdownload", FileLength: 8, Md5: md5(Buffer.from("MZsample")), LastUpdatedDateTime: wall("2026-09-04T10:00:00"), LastUpdatedBy: 11 },
    ],
    fileCount: [{ N: 4 }],
    logs: [
      log(9001, 1001, "Title", "Update", 11, "2026-09-05T10:00:00.100", "Old sample title", "Sample activity 1001"),
      log(9002, 1001, "CityId", "Update", 11, "2026-09-05T10:00:00.500", "5", "311"), // same activity, actor and second as 9001
      log(9003, 1001, null, "Edit", 11, "2026-09-05T09:59:00"), // lock noise
      log(9004, 1001, "PriorityId", "Update", 11, "2026-09-05T10:01:00"), // dropped field
      log(9005, 1001, "ContactMinistryId", "Update", 18, "2026-09-06T10:00:00", GUID.hlth, GUID.fin), // actor not imported
      log(9006, 1001, "HqComments", "Update", 11, "2026-09-07T10:00:00"), // unknown field
      log(9007, 1008, "Title", "Update", 15, "2026-05-05T10:00:00"), // out of scope
      log(9008, 1002, "IsConfirmed", "Update", null, "2026-09-08T10:00:00", "False", "True"), // no actor
    ],
    logCount: [{ N: 8 }],
    releaseLinks: [{ ActivityId: 1008, N: 2 }, { ActivityId: 1001, N: 1 }], // a release linked before the cutoff
    categories: [lk(2, "Sample awareness day"), lk(12, "Sample approved release"), lk(16, "Sample  speech"), lk(58, "Sample proposed release"), lk(90, "--- OPTIONAL BELOW ---", false), lk(91, null, null)],
    cities: [lk(5, "Sampleton"), lk(311, "Other...")],
    commMaterials: [lk(3, "Sample news release"), lk(61, "Sample unconfirmed marker")],
    eventPlanners: [lk(1, "Sample Planner", true, { PhoneNumber: "250-555-0100", JobTitle: "Sample planner" })],
    governmentRepresentatives: [lk(1, "Sample Representative", true, { Description: "Sample description" })],
    initiatives: [lk(7, "Sample initiative", true, { ShortName: "SI" })],
    keywords: [lk(40, "3-10"), lk(41, "Sample kept keyword")], // "3-10" stays text, never a date
    nrDistributions: [lk(1, "Sample distribution")],
    nrOrigins: [lk(8, "Sample origin")],
    premierRequested: [lk(1, "Sample request")],
    videographers: [lk(1, "Sample videographer", true, { JobTitle: "Sample camera" })],
  };
}

/** The Core state the import expects: three organizations and three terms with legacy ids, and two existing users. */
export async function seedCoreForImport(coreDb: Db): Promise<void> {
  const org = (key: string, displayName: string, abbreviation: string, guid: string, isHq = false) =>
    upsertOrganization(coreDb, { ...healthOrg, key, displayName, abbreviation, sectorKeys: [] }, [], { legacyId: guid.toLowerCase(), isHqOnCreate: isHq });
  await org("finance", "Sample Finance", "FIN", GUID.fin);
  await org("health", "Sample Health", "HLTH", GUID.hlth);
  await org("gcpehq", "Sample HQ", "GCPEHQ", GUID.hq, true);
  const social = { twitterUsername: "", flickrUrl: null, youtubeUrl: null, audioUrl: null };
  await upsertTerm(coreDb, { kind: "sector", key: "sample-sector", displayName: "Sample sector", sortOrder: 0, isActive: true, social }, [], { legacyId: GUID.sector.toLowerCase() });
  await upsertTerm(coreDb, { kind: "theme", key: "sample-theme", displayName: "Sample theme", sortOrder: 0, isActive: true, social }, [], { legacyId: GUID.theme.toLowerCase() });
  await upsertTerm(coreDb, { kind: "tag", key: "sample-tag", displayName: "Sample tag", sortOrder: 0, isActive: true, social }, [], { legacyId: GUID.tag.toLowerCase() });
  await createUser(coreDb, { email: "avery.sample@example.test", displayName: "Avery Core", roles: ["NRMS.Editor"], isActive: true }, []);
  await createUser(coreDb, { email: "blake.sample@example.test", displayName: "Blake Placeholder", roles: [], isActive: false }, []);
}
```

- [ ] **Step 7: Write the failing scope test** (`scope.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { createFakeSource } from "@gcpe/legacy-import";
import { legacyCalendarTables, TEST_CUTOFF } from "../../test/legacy-calendar-fixture";
import { loadLegacy } from "./load";
import { cutoffWallMs, isPostCutoff, selectScope } from "./scope";

const opts = { cutoff: TEST_CUTOFF, awarenessCategoryIds: [2] };
const scopeOf = async (tables = legacyCalendarTables()) => selectScope(await loadLegacy(createFakeSource(tables), opts), opts);
const ids = (xs: { Id: number }[]) => xs.map((x) => x.Id).sort((a, b) => a - b);

describe("the import scope (spec addendum §12.1, R13)", () => {
  it("the cutoff boundary: an end at exactly 00:00 on the cutoff date is in, 3 ms before is out", () => {
    const cut = cutoffWallMs(TEST_CUTOFF);
    expect(isPostCutoff({ StartDateTime: null, EndDateTime: new Date(cut) }, cut)).toBe(true);
    expect(isPostCutoff({ StartDateTime: null, EndDateTime: new Date(cut - 3) }, cut)).toBe(false);
    expect(isPostCutoff({ StartDateTime: new Date(cut), EndDateTime: null }, cut)).toBe(true);
    expect(isPostCutoff({ StartDateTime: null, EndDateTime: null }, cut)).toBe(false);
  });

  it("selects post-cutoff activities (deleted, spanning and reversed ones too) and non-deleted awareness dates, nothing else", async () => {
    const s = await scopeOf();
    expect(ids(s.activities)).toEqual([1001, 1002, 1004, 1005, 1006, 1009, 1010, 1011, 1012, 1013]);
    expect(s.outOfScope.activities).toBe(4); // 1003, 1007, 1008, 1014
  });

  it("takes only the in-scope activities' favourites, files and log rows, and counts the rest", async () => {
    const s = await scopeOf();
    expect(s.favourites.map((f) => f.ActivityId).sort()).toEqual([1001, 1004]);
    expect(ids(s.files)).toEqual([801, 802, 804]);
    expect(ids(s.logs)).toEqual([9001, 9002, 9003, 9004, 9005, 9006, 9008]);
    expect(s.outOfScope).toMatchObject({ favourites: 1, files: 1, logs: 1, releaseLinks: 2, releaseLinksInScope: 1 });
  });

  it("keeps only active join rows of in-scope activities, each pair once", async () => {
    const s = await scopeOf();
    expect(s.joins.categories.filter((r) => r.ActivityId === 1001).map((r) => r.ValueId)).toEqual([12, 58]);
    expect(s.joins.categories.some((r) => r.ActivityId === 1002 && r.ValueId === 58)).toBe(false);
    expect(s.joins.categories.some((r) => r.ActivityId === 1008)).toBe(false);
  });

  it("selects users who are active or referenced by imported data, never a log actor alone", async () => {
    const s = await scopeOf();
    expect([...s.userIds].sort((a, b) => a - b)).toEqual([11, 12, 13, 14, 16, 19, 20, 21, 22]);
  });

  it("selects comm contacts that are active or referenced, and only active saved filters", async () => {
    const s = await scopeOf();
    expect(ids(s.commContacts)).toEqual([501, 502, 503, 504, 506]);
    expect(ids(s.savedFilters)).toEqual([701, 702]);
  });

  it("an awareness link that isn't active doesn't make an awareness date", async () => {
    const t = legacyCalendarTables();
    t.activityCategories = (t.activityCategories as { ActivityId: number; ValueId: number; IsActive: boolean }[]).map((r) => (r.ActivityId === 1006 ? { ...r, IsActive: false } : r));
    expect(ids((await scopeOf(t)).activities)).not.toContain(1006);
  });
});
```

- [ ] **Step 8: Run it** and see it fail because `./load` and `./scope` don't exist.

- [ ] **Step 9: Write `load.ts`:**

```ts
import type { LegacySource } from "@gcpe/legacy-import";
import { JOIN_TABLES, LOOKUP_TABLES, type LegacySnapshot, type LookupTable } from "./legacy-rows";
import { Q } from "./queries";
import type { ScopeOptions } from "./scope";

const LOOKUP_QUERY: Record<LookupTable, keyof ReturnType<typeof Q>> = {
  categories: "lkCategories", cities: "lkCities", commMaterials: "lkCommMaterials", eventPlanners: "lkEventPlanners",
  governmentRepresentatives: "lkGovernmentRepresentatives", initiatives: "lkInitiatives", keywords: "lkKeywords",
  nrDistributions: "lkNrDistributions", nrOrigins: "lkNrOrigins", premierRequested: "lkPremierRequested", videographers: "lkVideographers",
};

/** Reads everything the import needs. The big tables are narrowed by the scope SQL; scope.ts decides. */
export async function loadLegacy(source: LegacySource, o: ScopeOptions): Promise<LegacySnapshot> {
  const q = Q(o.cutoff, o.awarenessCategoryIds);
  const count = async (sqlText: string) => Number((await source.query<{ N: number }>(sqlText))[0]?.N ?? 0);
  const joins = {} as LegacySnapshot["joins"];
  for (const t of JOIN_TABLES) joins[t] = await source.query(q[t]);
  const lookups = {} as LegacySnapshot["lookups"];
  for (const t of LOOKUP_TABLES) lookups[t] = await source.query(q[LOOKUP_QUERY[t]]);
  return {
    activities: await source.query(q.activities),
    joins,
    users: await source.query(q.users),
    userMinistries: await source.query(q.userMinistries),
    commContacts: await source.query(q.commContacts),
    savedFilters: await source.query(q.savedFilters),
    favourites: await source.query(q.favourites),
    files: await source.query(q.files),
    logs: await source.query(q.logs),
    lookups,
    releaseLinks: await source.query(q.releaseLinks),
    totals: { activities: await count(q.activityCount), favourites: await count(q.favouriteCount), files: await count(q.fileCount), logs: await count(q.logCount) },
  };
}
```

- [ ] **Step 10: Write `scope.ts`:**

```ts
import { JOIN_TABLES, type JoinTable, type LegacyActivity, type LegacyCommContact, type LegacyFavourite, type LegacyFile, type LegacyJoinRow, type LegacyLog, type LegacySavedFilter, type LegacySnapshot } from "./legacy-rows";

export interface ScopeOptions { cutoff: string; awarenessCategoryIds: readonly number[] }
export interface Scope {
  /** In scope, by id. */
  activities: LegacyActivity[];
  activityIds: Set<number>;
  joins: Record<JoinTable, LegacyJoinRow[]>;
  commContacts: LegacyCommContact[];
  savedFilters: LegacySavedFilter[];
  favourites: LegacyFavourite[];
  files: LegacyFile[];
  logs: LegacyLog[];
  /** Legacy SystemUser ids to import (spec addendum §12.1 step 1). */
  userIds: Set<number>;
  outOfScope: { activities: number; favourites: number; files: number; logs: number; releaseLinks: number; releaseLinksInScope: number };
}

/** The cutoff date's 00:00 as a wall-clock instant, comparable with legacy DATETIMEs (BC wall-clock in their UTC fields). */
export function cutoffWallMs(cutoff: string): number {
  const [y, m, d] = cutoff.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

/** Ends on or after the cutoff, or starts on or after it. Either date counts, so an activity that ends before it starts still comes. */
export function isPostCutoff(a: Pick<LegacyActivity, "StartDateTime" | "EndDateTime">, cutoffMs: number): boolean {
  return (a.EndDateTime !== null && a.EndDateTime.getTime() >= cutoffMs) || (a.StartDateTime !== null && a.StartDateTime.getTime() >= cutoffMs);
}

export function selectScope(s: LegacySnapshot, o: ScopeOptions): Scope {
  const cut = cutoffWallMs(o.cutoff);
  const awareness = new Set(s.joins.categories.filter((r) => r.IsActive === true && o.awarenessCategoryIds.includes(Number(r.ValueId))).map((r) => r.ActivityId));
  const activities = s.activities
    .filter((a) => isPostCutoff(a, cut) || (a.IsActive === true && awareness.has(a.Id)))
    .sort((a, b) => a.Id - b.Id);
  const activityIds = new Set(activities.map((a) => a.Id));

  const joins = {} as Scope["joins"];
  for (const t of JOIN_TABLES) {
    const seen = new Set<string>();
    joins[t] = s.joins[t].filter((r) => {
      const key = `${r.ActivityId}|${String(r.ValueId).toLowerCase()}`;
      if (r.IsActive !== true || !activityIds.has(r.ActivityId) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const referencedContacts = new Set(activities.map((a) => a.CommunicationContactId).filter((id): id is number => id !== null));
  const commContacts = s.commContacts.filter((c) => c.IsActive === true || referencedContacts.has(c.Id)).sort((a, b) => a.Id - b.Id);
  const savedFilters = s.savedFilters.filter((f) => f.IsActive === true).sort((a, b) => a.Id - b.Id);
  const favourites = s.favourites.filter((f) => activityIds.has(f.ActivityId));
  const files = s.files.filter((f) => activityIds.has(f.ActivityId)).sort((a, b) => a.Id - b.Id);
  const logs = s.logs.filter((l) => activityIds.has(l.ActivityId)).sort((a, b) => a.Id - b.Id);

  const userIds = new Set<number>(s.users.filter((u) => u.IsActive === true).map((u) => u.Id));
  const add = (id: number | null) => void (id !== null && userIds.add(id));
  for (const a of activities) { add(a.CreatedBy); add(a.LastUpdatedBy); }
  for (const c of commContacts) add(c.SystemUserId);
  for (const f of savedFilters) add(f.CreatedBy);
  for (const f of favourites) add(f.SystemUserId);
  const known = new Set(s.users.map((u) => u.Id));
  for (const id of [...userIds]) if (!known.has(id)) userIds.delete(id);

  const inLinks = s.releaseLinks.filter((r) => activityIds.has(r.ActivityId)).reduce((n, r) => n + Number(r.N), 0);
  const allLinks = s.releaseLinks.reduce((n, r) => n + Number(r.N), 0);
  return {
    activities, activityIds, joins, commContacts, savedFilters, favourites, files, logs, userIds,
    outOfScope: {
      activities: s.totals.activities - activities.length,
      favourites: s.totals.favourites - favourites.length,
      files: s.totals.files - files.length,
      logs: s.totals.logs - logs.length,
      releaseLinks: allLinks - inLinks,
      releaseLinksInScope: inLinks,
    },
  };
}
```

- [ ] **Step 11: Add the dependency.** Add `"@gcpe/legacy-import": "0.0.0"` to `apps/calendar/package.json` `dependencies`, then run `npx -y -p node@24 -- npm install --ignore-scripts`. Run the scope and query tests and see them pass. Run the type-check.

- [ ] **Step 12: Commit.**

```bash
git add apps/calendar/src/import apps/calendar/test/legacy-calendar-fixture.ts apps/calendar/package.json package-lock.json
git commit -m "feat(calendar): legacy reads and the import scope rule, with a synthetic legacy fixture"
```

---

### Task 2: Mapping: activities, lookups, user candidates, the GUID check, validation problems and history

**Risk:** data-integrity and confidentiality (full review). The history field map is the deny-list that keeps HQ-only keys out.

**Files:**
- Create: `apps/core/src/import/legacy-keys.ts`, `apps/calendar/src/import/map.ts`, `apps/calendar/src/import/history-map.ts`
- Test: `apps/core/src/import/legacy-keys.test.ts`, `apps/calendar/src/import/map.test.ts`, `apps/calendar/src/import/history-map.test.ts`

**Interfaces:**
- Consumes: Task 1's row types, `Scope` and fixture.
- Produces:
  - Core:
    - `LegacyKeys` (`org(guid)`, `termKey(kind, guid)`) and `loadLegacyKeys(coreDb): Promise<LegacyKeys>`;
    - `CalendarUserCandidate` (defined here, in `legacy-keys.ts`, so Task 3 imports it).
  - Calendar `map.ts`:
    - the `ActivityValues` type;
    - `MappedActivity = { id; values: ActivityValues; joins: JoinIds; notes: string[] }`;
    - `mapActivity(a, joinRows, ctx): MappedActivity | { id: number; skip: string }`;
    - `joinsByActivity(scope): Map<number, Record<JoinTable, (number | string)[]>>`;
    - `mapLookup(table, row)`;
    - `userCandidates(s, scope, keys)`;
    - `unknownLegacyKeys(s, scope, keys)`;
    - `validationProblems(m, keywordNames, rules): string[]`;
    - `hqSectionOf`, `stripNul`.
  - Calendar `history-map.ts`:
    - `LEGACY_LOG_FIELDS`;
    - `HistoryEntry = { legacyKey; activityId; logIds; at: Date; actorId; actorName; fields: { key; old; new }[] }`;
    - `mapHistory(logs, ctx): { entries: HistoryEntry[]; skipped: { logId: number; reason: string }[] }`.

- [ ] **Step 1: Write the failing Core test** (`legacy-keys.test.ts`). Seed with `seedCoreForImport`, then:

```ts
it("resolves legacy GUIDs in any case to Core organizations and terms, and nothing else", async () => {
  await seedCoreForImport(tdb.db);
  const keys = await loadLegacyKeys(tdb.db);
  expect(keys.org(GUID.fin)?.key).toBe("finance");
  expect(keys.org(GUID.fin.toLowerCase())?.abbreviation).toBe("FIN");
  expect(keys.termKey("sector", GUID.sector)).toBe("sample-sector");
  expect(keys.termKey("theme", GUID.sector)).toBeNull(); // right GUID, wrong kind
  expect(keys.org(GUID.unknown)).toBeNull();
});
```

(Use the usual `beforeAll(createCoreTestDb)` / `afterAll(tdb.drop)` frame from `apps/core/src/import/users.test.ts`.)

- [ ] **Step 2: Run it** and see it fail because the module doesn't exist.

- [ ] **Step 3: Write `apps/core/src/import/legacy-keys.ts`:**

```ts
import { isNotNull } from "drizzle-orm";
import type { CalendarRole } from "@gcpe/auth";
import type { Db } from "@gcpe/db-kit";
import { organizations, terms } from "../db/schema";

export interface LegacyOrg { id: string; key: string; displayName: string; abbreviation: string | null }
/** Legacy dbo GUIDs (Ministry, Sector, Theme, Tag) as Core knows them: Core stores them lowercased. */
export interface LegacyKeys {
  org(guid: string): LegacyOrg | null;
  termKey(kind: "sector" | "theme" | "tag", guid: string): string | null;
}

export async function loadLegacyKeys(db: Db): Promise<LegacyKeys> {
  const orgRows = await db.select({ id: organizations.id, key: organizations.key, displayName: organizations.displayName, abbreviation: organizations.abbreviation, legacyId: organizations.legacyId }).from(organizations).where(isNotNull(organizations.legacyId));
  const termRows = await db.select({ kind: terms.kind, key: terms.key, legacyId: terms.legacyId }).from(terms).where(isNotNull(terms.legacyId));
  const orgs = new Map(orgRows.map((o) => [o.legacyId!.toLowerCase(), { id: o.id, key: o.key, displayName: o.displayName, abbreviation: o.abbreviation }]));
  const termMap = new Map(termRows.map((t) => [`${t.kind}:${t.legacyId!.toLowerCase()}`, t.key]));
  return {
    org: (guid) => orgs.get(guid.trim().toLowerCase()) ?? null,
    termKey: (kind, guid) => termMap.get(`${kind}:${guid.trim().toLowerCase()}`) ?? null,
  };
}

/** One legacy calendar.SystemUser, ready for Core (spec addendum §12.1 step 1). */
export interface CalendarUserCandidate {
  legacyId: number;
  /** As legacy holds it; normalised and validated by the planner. */
  email: string | null;
  displayName: string;
  /** Legacy IsActive. */
  isActive: boolean;
  calendarRole: CalendarRole | null;
  /** Core organization ids of the user's active legacy ministries. */
  organizationIds: string[];
  /** Legacy LastUpdatedDateTime in ms (0 when null): picks one row among duplicate emails. */
  lastUpdated: number;
}
```

- [ ] **Step 4: Run it and see it pass.**

- [ ] **Step 5: Write the failing mapping tests** (`map.test.ts`). The keys are built in memory, so no database is needed:

```ts
import { describe, expect, it } from "vitest";
import { createFakeSource, wallClockToInstant } from "@gcpe/legacy-import";
import type { LegacyKeys } from "../../../core/src/import/legacy-keys";
import { GUID, legacyCalendarTables, TEST_CUTOFF } from "../../test/legacy-calendar-fixture";
import { TEST_RULES } from "../../test/helpers";
import { loadLegacy } from "./load";
import { hqSectionOf, joinsByActivity, mapActivity, mapLookup, unknownLegacyKeys, userCandidates, validationProblems, type MappedActivity } from "./map";
import { selectScope } from "./scope";

const ORGS: Record<string, { id: string; key: string; displayName: string; abbreviation: string }> = {
  [GUID.fin.toLowerCase()]: { id: "00000000-0000-4000-8000-0000000000f1", key: "finance", displayName: "Sample Finance", abbreviation: "FIN" },
  [GUID.hlth.toLowerCase()]: { id: "00000000-0000-4000-8000-0000000000f2", key: "health", displayName: "Sample Health", abbreviation: "HLTH" },
  [GUID.hq.toLowerCase()]: { id: "00000000-0000-4000-8000-0000000000f3", key: "gcpehq", displayName: "Sample HQ", abbreviation: "GCPEHQ" },
};
const TERMS: Record<string, string> = { [`sector:${GUID.sector.toLowerCase()}`]: "sample-sector", [`theme:${GUID.theme.toLowerCase()}`]: "sample-theme", [`tag:${GUID.tag.toLowerCase()}`]: "sample-tag" };
const keys: LegacyKeys = { org: (g) => ORGS[g.toLowerCase()] ?? null, termKey: (k, g) => TERMS[`${k}:${g.toLowerCase()}`] ?? null };
const opts = { cutoff: TEST_CUTOFF, awarenessCategoryIds: [2] };
const TZ = "America/Vancouver";
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ctx = { timeZone: TZ, userIdOf: (id: number | null) => (id === null ? null : uid(id)), commContactIdOf: (id: number | null) => (id === 504 ? 503 : id), keys };

async function mapped() {
  const s = await loadLegacy(createFakeSource(legacyCalendarTables()), opts);
  const scope = selectScope(s, opts);
  const joins = joinsByActivity(scope);
  return { s, scope, all: scope.activities.map((a) => mapActivity(a, joins.get(a.Id)!, ctx)) };
}
const one = async (id: number) => (await mapped()).all.find((m) => m.id === id) as MappedActivity;

describe("activity mapping", () => {
  it("maps statuses, the section, flags, translations, keys, joins and times by legacy's rules", async () => {
    const m = await one(1001);
    expect(m.values).toMatchObject({
      status: "new", hqSection: "events_and_speeches", longTermOutlook: false, cityId: 311, otherCity: "Sample Bay",
      translations: ["French", "Punjabi"], needsReview: ["digital", "title"], contactMinistryKey: "finance",
      commContactId: 501, createdBy: uid(11), lastUpdatedBy: uid(12), deletedAt: null,
    });
    expect(m.values.startAt).toEqual(wallClockToInstant(new Date("2027-01-20T09:00:00Z"), TZ));
    expect(m.joins).toMatchObject({ categoryIds: [12, 58], keywordIds: [40, 41], sectorKeys: ["sample-sector"], themeKeys: ["sample-theme"], tagKeys: ["sample-tag"] });
  });

  it("maps every HqSection from −4 to 4, negatives with Long Term Outlook, 0 to Not on LA with a note", async () => {
    expect([1, 2, 3, 4].map((n) => hqSectionOf(n)?.hqSection)).toEqual(["issues_and_reports", "events_and_speeches", "in_the_news", "not_on_la"]);
    expect(hqSectionOf(-4)).toEqual({ hqSection: "not_on_la", longTermOutlook: true });
    expect(hqSectionOf(0)).toBeNull();
    const m = await one(1012);
    expect(m.values).toMatchObject({ hqSection: "not_on_la", longTermOutlook: false, hqStatus: "new" });
    expect(m.notes).toContain("HqSection 0 is not a legacy section; imported as Not on LA");
  });

  it("nulls and NULs: a null status and created time get fixed fallbacks, NUL characters are stripped", async () => {
    const m = await one(1012);
    expect(m.values.status).toBe("new");
    expect(m.values.createdAt).toEqual(m.values.lastUpdatedAt);
    expect(m.values.details).toBe("Sampledetails");
    expect(mapLookup("categories", { Id: 91, Name: null, SortOrder: null, IsActive: null })).toEqual({ id: 91, name: "", sortOrder: 0, isActive: false });
    expect(mapLookup("keywords", { Id: 40, Name: "3-10", SortOrder: 40, IsActive: true }).name).toBe("3-10");
  });

  it("a deleted activity takes its deletion from the last update; a confidential one keeps its section and flags", async () => {
    expect((await one(1005)).values).toMatchObject({ deletedBy: uid(12) });
    expect((await one(1005)).values.deletedAt).toEqual(wallClockToInstant(new Date("2026-09-02T10:00:00Z"), TZ));
    const c = await one(1011);
    expect(c.values).toMatchObject({ isConfidential: true, hqSection: "not_on_la", longTermOutlook: true, status: "changed", hqStatus: "changed" });
    expect(c.values.title).toHaveLength(217);
    expect(c.joins.sharedWithKeys).toEqual(["health"]);
  });

  it("remaps a merged comm contact, and keeps an activity with none", async () => {
    expect((await one(1004)).values.commContactId).toBe(503);
    expect((await one(1009)).values.commContactId).toBeNull();
  });

  it("rejects a year outside 1900–2199 instead of importing it", async () => {
    expect((await mapped()).all.find((m) => m.id === 1013)).toEqual({ id: 1013, skip: "a date's year is outside 1900–2199" });
  });

  it("lists the fields the shared validation refuses on every save, by name only", async () => {
    const m = await one(1009); // no end, no comm contact
    expect(validationProblems(m, [], TEST_RULES)).toEqual(expect.arrayContaining(["commContactId", "endDate"]));
  });
});

describe("users and keys", () => {
  it("builds a Core candidate per selected user, with legacy's role and active ministries", async () => {
    const { s, scope } = await mapped();
    const c = userCandidates(s, scope, keys);
    expect(c.map((u) => u.legacyId)).toEqual([11, 12, 13, 14, 16, 19, 20, 21, 22]);
    expect(c.find((u) => u.legacyId === 12)).toMatchObject({ calendarRole: "Calendar.SysAdmin", organizationIds: [ORGS[GUID.hq.toLowerCase()]!.id], isActive: true });
    expect(c.find((u) => u.legacyId === 16)).toMatchObject({ email: null, isActive: false, calendarRole: "Calendar.ReadOnly" });
  });

  it("lists every unknown GUID the in-scope data uses, and none an out-of-scope user holds", async () => {
    const t = legacyCalendarTables();
    (t.activitySharedWith as object[]).push({ ActivityId: 1001, ValueId: GUID.unknown, IsActive: true });
    const s = await loadLegacy(createFakeSource(t), opts);
    expect(unknownLegacyKeys(s, selectScope(s, opts), keys)).toEqual([{ kind: "ministry", guid: GUID.unknown.toLowerCase() }]);
    const clean = await loadLegacy(createFakeSource(legacyCalendarTables()), opts);
    expect(unknownLegacyKeys(clean, selectScope(clean, opts), keys)).toEqual([]);
  });
});
```

- [ ] **Step 6: Run them** and see them fail because `./map` doesn't exist.

- [ ] **Step 7: Write `map.ts`:**

```ts
import { CALENDAR_ROLES } from "@gcpe/auth";
import { checkActivity, HQ_SECTIONS, type ActivityStatus, type CalendarRules, type HqSection, type HqStatus, type NeedsReviewKey } from "@gcpe/calendar-contract";
import { wallClockToInstant } from "@gcpe/legacy-import";
import type { CalendarUserCandidate, LegacyKeys } from "../../../core/src/import/legacy-keys";
import { fieldsOf, uniqNum, uniqStr, type ActivityRow, type JoinIds } from "../activities/store";
import type { activities } from "../db/schema";
import { JOIN_TABLES, type JoinTable, type LegacyActivity, type LegacyLookup, type LegacySnapshot, type LookupTable } from "./legacy-rows";
import type { Scope } from "./scope";

export type ActivityValues = Required<Omit<typeof activities.$inferInsert, "id" | "version" | "importedVersion">>;
export interface MappedActivity { id: number; values: ActivityValues; joins: JoinIds; notes: string[] }
export interface ActivityMapContext {
  timeZone: string;
  userIdOf(legacyId: number | null): string | null;
  /** The surviving Calendar comm contact for a legacy one (merged duplicates), or null. */
  commContactIdOf(legacyId: number | null): number | null;
  keys: LegacyKeys;
}

export const stripNul = (s: string) => s.replace(/\u0000/g, "");
const txt = (s: string | null) => stripNul(s ?? "");
const opt = (s: string | null) => (s === null ? null : stripNul(s));
const LEGACY_STATUS: Record<number, ActivityStatus> = { 7: "new", 1: "changed", 2: "reviewed" };
const LEGACY_HQ_STATUS: Record<number, HqStatus> = { 7: "new", 1: "changed" };
/** A fixed fallback, so a re-run computes the same value. */
const FALLBACK_WALL = new Date(Date.UTC(2000, 0, 1));
const yearOk = (d: Date | null) => d === null || (d.getUTCFullYear() >= 1900 && d.getUTCFullYear() <= 2199);

/** Legacy HqSection (spec addendum §7.6): 1–4 are the sections, −n is section n with Long Term Outlook. */
export function hqSectionOf(n: number): { hqSection: HqSection; longTermOutlook: boolean } | null {
  const i = Math.abs(n);
  if (!Number.isInteger(n) || i < 1 || i > 4) return null;
  return { hqSection: HQ_SECTIONS[i - 1]!, longTermOutlook: n < 0 };
}

/** Legacy's 23 needs-review columns (spec addendum §7.3). */
export const NEEDS_REVIEW_COLUMNS: Record<NeedsReviewKey, keyof LegacyActivity> = {
  title: "IsTitleNeedsReview", details: "IsDetailsNeedsReview", representative: "IsRepresentativeNeedsReview", city: "IsCityNeedsReview",
  start_date: "IsStartDateNeedsReview", end_date: "IsEndDateNeedsReview", categories: "IsCategoriesNeedsReview",
  comm_materials: "IsCommMaterialsNeedsReview", active: "IsActiveNeedsReview", significance: "IsSignificanceNeedsReview",
  strategy: "IsStrategyNeedsReview", scheduling_considerations: "IsSchedulingConsiderationsNeedsReview", internal_notes: "IsInternalNotesNeedsReview",
  lead_organization: "IsLeadOrganizationNeedsReview", initiatives: "IsInitiativesNeedsReview", tags: "IsTagsNeedsReview",
  origin: "IsOriginNeedsReview", distribution: "IsDistributionNeedsReview", translations_required: "IsTranslationsRequiredNeedsReview",
  premier_requested: "IsPremierRequestedNeedsReview", venue: "IsVenueNeedsReview", event_planner: "IsEventPlannerNeedsReview", digital: "IsDigitalNeedsReview",
};

export function joinsByActivity(scope: Scope): Map<number, Record<JoinTable, (number | string)[]>> {
  const out = new Map<number, Record<JoinTable, (number | string)[]>>();
  for (const a of scope.activities) out.set(a.Id, Object.fromEntries(JOIN_TABLES.map((t) => [t, []])) as unknown as Record<JoinTable, (number | string)[]>);
  for (const t of JOIN_TABLES) for (const r of scope.joins[t]) out.get(r.ActivityId)?.[t].push(r.ValueId);
  return out;
}

export function mapActivity(a: LegacyActivity, j: Record<JoinTable, (number | string)[]>, ctx: ActivityMapContext): MappedActivity | { id: number; skip: string } {
  if (![a.StartDateTime, a.EndDateTime, a.NRDateTime].every(yearOk)) return { id: a.Id, skip: "a date's year is outside 1900–2199" };
  const notes: string[] = [];
  const at = (d: Date | null) => (d ? wallClockToInstant(d, ctx.timeZone) : null);
  const orgKey = (guid: string) => {
    const o = ctx.keys.org(guid);
    if (!o) throw new Error("an unknown legacy ministry reached mapping; the key check runs first");
    return o.key;
  };
  const termKey = (kind: "sector" | "theme" | "tag", guid: string) => {
    const k = ctx.keys.termKey(kind, guid);
    if (!k) throw new Error(`an unknown legacy ${kind} reached mapping; the key check runs first`);
    return k;
  };
  const section = hqSectionOf(a.HqSection);
  if (!section) notes.push(`HqSection ${a.HqSection} is not a legacy section; imported as Not on LA`);
  const status = a.StatusId === null ? undefined : LEGACY_STATUS[a.StatusId];
  if (!status) notes.push(`StatusId ${a.StatusId ?? "null"} imported as New`);
  const lastUpdatedWall = a.LastUpdatedDateTime ?? a.CreatedDateTime ?? a.StartDateTime ?? a.EndDateTime ?? FALLBACK_WALL;
  const createdWall = a.CreatedDateTime ?? a.LastUpdatedDateTime ?? a.StartDateTime ?? a.EndDateTime ?? FALLBACK_WALL;
  const commContactId = ctx.commContactIdOf(a.CommunicationContactId);
  if (a.CommunicationContactId !== null && commContactId === null) notes.push("its comm contact wasn't imported");
  const values: ActivityValues = {
    startAt: at(a.StartDateTime), endAt: at(a.EndDateTime), nrAt: at(a.NRDateTime), potentialDates: opt(a.PotentialDates),
    isAllDay: a.IsAllDay, isConfirmed: a.IsConfirmed,
    title: txt(a.Title), details: txt(a.Details), schedule: txt(a.Schedule), significance: txt(a.Significance),
    strategy: opt(a.Strategy), comments: opt(a.Comments), hqComments: opt(a.HqComments), leadOrganization: opt(a.LeadOrganization),
    venue: opt(a.Venue), otherCity: opt(a.OtherCity),
    translations: txt(a.Translations).split(",").map((t) => t.trim()).filter((t) => t !== ""),
    status: status ?? "new",
    hqStatus: a.HqStatusId === null ? null : (LEGACY_HQ_STATUS[a.HqStatusId] ?? null),
    hqSection: section?.hqSection ?? "not_on_la", longTermOutlook: section?.longTermOutlook ?? false,
    nrDistributionId: a.NRDistributionId, premierRequestedId: a.PremierRequestedId,
    contactMinistryKey: a.ContactMinistryId === null ? null : orgKey(a.ContactMinistryId),
    governmentRepresentativeId: a.GovernmentRepresentativeId, commContactId, eventPlannerId: a.EventPlannerId,
    videographerId: a.VideographerId, cityId: a.CityId,
    isIssue: a.IsIssue, isAtLegislature: a.IsAtLegislature, isConfidential: a.IsConfidential, isCrossGovernment: a.IsCrossGovernment, isMilestone: a.IsMilestone,
    deletedAt: a.IsActive ? null : wallClockToInstant(lastUpdatedWall, ctx.timeZone),
    deletedBy: a.IsActive ? null : ctx.userIdOf(a.LastUpdatedBy),
    needsReview: (Object.keys(NEEDS_REVIEW_COLUMNS) as NeedsReviewKey[]).filter((k) => a[NEEDS_REVIEW_COLUMNS[k]] === true).sort(),
    createdAt: wallClockToInstant(createdWall, ctx.timeZone), createdBy: ctx.userIdOf(a.CreatedBy),
    lastUpdatedAt: wallClockToInstant(lastUpdatedWall, ctx.timeZone), lastUpdatedBy: ctx.userIdOf(a.LastUpdatedBy),
  };
  const nums = (t: JoinTable) => uniqNum(j[t].map(Number));
  const joins: JoinIds = {
    categoryIds: nums("categories"), commMaterialIds: nums("commMaterials"), initiativeIds: nums("initiatives"),
    keywordIds: nums("keywords"), nrOriginIds: nums("nrOrigins"),
    sectorKeys: uniqStr(j.sectors.map((g) => termKey("sector", String(g)))),
    themeKeys: uniqStr(j.themes.map((g) => termKey("theme", String(g)))),
    tagKeys: uniqStr(j.tags.map((g) => termKey("tag", String(g)))),
    sharedWithKeys: uniqStr(j.sharedWith.map((g) => orgKey(String(g)))),
  };
  return { id: a.Id, values, joins, notes };
}

/** A lookup row with its legacy id; a NULL name is "", a NULL active flag is inactive. */
export function mapLookup(table: LookupTable, r: LegacyLookup) {
  const base = { id: r.Id, name: txt(r.Name), sortOrder: r.SortOrder ?? 0, isActive: r.IsActive === true };
  switch (table) {
    case "eventPlanners": return { ...base, phone: opt(r.PhoneNumber ?? null), jobTitle: opt(r.JobTitle ?? null) };
    case "governmentRepresentatives": return { ...base, description: opt(r.Description ?? null) };
    case "initiatives": return { ...base, shortName: opt(r.ShortName ?? null) };
    case "videographers": return { ...base, jobTitle: opt(r.JobTitle ?? null) };
    default: return base;
  }
}

export function userCandidates(s: LegacySnapshot, scope: Scope, keys: LegacyKeys): CalendarUserCandidate[] {
  return s.users
    .filter((u) => scope.userIds.has(u.Id))
    .sort((a, b) => a.Id - b.Id)
    .map((u) => ({
      legacyId: u.Id,
      email: u.EmailAddress,
      displayName: (txt(u.DisplayName).trim() || txt(u.FullName).trim() || `Legacy user ${u.Id}`).slice(0, 100),
      isActive: u.IsActive === true,
      calendarRole: CALENDAR_ROLES[u.RoleId - 1] ?? null,
      organizationIds: [...new Set(s.userMinistries.filter((m) => m.SystemUserId === u.Id && m.IsActive === true).map((m) => keys.org(m.MinistryId)?.id).filter((id): id is string => id !== undefined))].sort(),
      lastUpdated: u.LastUpdatedDateTime?.getTime() ?? 0,
    }));
}

export interface UnknownKey { kind: "ministry" | "sector" | "theme" | "tag"; guid: string }
/** Every legacy GUID the in-scope data uses that Core doesn't know. Any one stops the run before it writes ("fix Core first"). */
export function unknownLegacyKeys(s: LegacySnapshot, scope: Scope, keys: LegacyKeys): UnknownKey[] {
  const out = new Map<string, UnknownKey>();
  const check = (kind: UnknownKey["kind"], raw: string | number | null) => {
    if (raw === null) return;
    const guid = String(raw).trim().toLowerCase();
    const ok = kind === "ministry" ? keys.org(guid) !== null : keys.termKey(kind, guid) !== null;
    if (!ok) out.set(`${kind}:${guid}`, { kind, guid });
  };
  for (const a of scope.activities) check("ministry", a.ContactMinistryId);
  for (const r of scope.joins.sharedWith) check("ministry", r.ValueId);
  for (const r of scope.joins.sectors) check("sector", r.ValueId);
  for (const r of scope.joins.themes) check("theme", r.ValueId);
  for (const r of scope.joins.tags) check("tag", r.ValueId);
  for (const c of scope.commContacts) check("ministry", c.MinistryId);
  for (const m of s.userMinistries) if (scope.userIds.has(m.SystemUserId) && m.IsActive === true) check("ministry", m.MinistryId);
  return [...out.values()].sort((a, b) => `${a.kind}${a.guid}`.localeCompare(`${b.kind}${b.guid}`));
}

/** The fields the shared check refuses on every save, unchanged or not (imported anyway; fixed on next save). Names only. */
export function validationProblems(m: MappedActivity, keywordNames: string[], rules: CalendarRules): string[] {
  const row = { ...m.values, id: m.id, version: 1, importedVersion: 1 } as ActivityRow;
  const { lookAhead: _lookAhead, ...fields } = fieldsOf({ row, joins: m.joins, keywordNames }, rules.timeZone);
  const errors = checkActivity(fields, { rules, relaxRequired: false, lookAheadFieldset: false, previous: fields, inferredSection: null });
  return [...new Set(errors.map((e) => e.field))].sort();
}
```

`ActivityRow` gains `importedVersion` in Task 4. Until then, the cast in `validationProblems` is satisfied by the extra key, because TypeScript allows an excess property through `as`. Re-run the type-check after Task 4.

- [ ] **Step 8: Run the mapping tests and see them pass.**

- [ ] **Step 9: Write the failing history tests** (`history-map.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { HISTORY_FIELDS, LOOK_AHEAD_HISTORY_FIELDS } from "@gcpe/calendar-contract";
import { createFakeSource } from "@gcpe/legacy-import";
import { GUID, legacyCalendarTables, TEST_CUTOFF } from "../../test/legacy-calendar-fixture";
import { LEGACY_LOG_FIELDS, mapHistory } from "./history-map";
import { loadLegacy } from "./load";
import { selectScope } from "./scope";

const opts = { cutoff: TEST_CUTOFF, awarenessCategoryIds: [2] };
async function history() {
  const s = await loadLegacy(createFakeSource(legacyCalendarTables()), opts);
  const scope = selectScope(s, opts);
  return mapHistory(scope.logs, {
    timeZone: "America/Vancouver",
    userIdOf: (id) => (id === 11 ? "00000000-0000-4000-8000-000000000011" : null),
    actorNameOf: (id) => (id === null ? null : (s.users.find((u) => u.Id === id)?.DisplayName ?? null)),
    cityNameOf: (id) => s.lookups.cities.find((c) => c.Id === id)?.Name ?? null,
    commContactLabelOf: () => null,
    orgNameOf: (g) => (g.toLowerCase() === GUID.fin.toLowerCase() ? "Sample Finance" : g.toLowerCase() === GUID.hlth.toLowerCase() ? "Sample Health" : null),
    contactMinistryKeyOf: () => "finance",
  });
}

describe("legacy log → history (C134)", () => {
  it("never maps a legacy field onto a Look Ahead key, and every mapped key is a real history field", () => {
    for (const key of Object.values(LEGACY_LOG_FIELDS)) {
      expect(Object.keys(HISTORY_FIELDS)).toContain(key);
      expect(LOOK_AHEAD_HISTORY_FIELDS as readonly string[]).not.toContain(key);
    }
  });

  it("groups Update rows by activity, actor and second, and resolves ids to names", async () => {
    const { entries } = await history();
    const first = entries.find((e) => e.legacyKey === "log:9001")!;
    expect(first.logIds).toEqual([9001, 9002]);
    expect(first.actorId).toBe("00000000-0000-4000-8000-000000000011");
    expect(first.fields).toEqual([
      { key: "title", old: "Old sample title", new: "Sample activity 1001" },
      { key: "city", old: "Sampleton", new: "Other..." },
    ]);
  });

  it("keeps a non-imported actor's legacy name with no user, and names a missing actor", async () => {
    const { entries } = await history();
    expect(entries.find((e) => e.legacyKey === "log:9005")).toMatchObject({ actorId: null, actorName: "Finley Sample", fields: [{ key: "contact_ministry", old: "Sample Health", new: "Sample Finance" }] });
    expect(entries.find((e) => e.legacyKey === "log:9008")).toMatchObject({ actorId: null, actorName: "Unknown legacy user", fields: [{ key: "is_confirmed", old: "No", new: "Yes" }] });
  });

  it("skips Edit rows, PriorityId rows and unknown fields, each counted with its reason", async () => {
    const { skipped } = await history();
    expect(skipped).toEqual([
      { logId: 9003, reason: "Edit row (lock noise)" },
      { logId: 9004, reason: "PriorityId (dropped, R9)" },
      { logId: 9006, reason: "unknown field" },
    ]);
  });
});
```

- [ ] **Step 10: Run them** and see them fail because `./history-map` doesn't exist.

- [ ] **Step 11: Write `history-map.ts`:**

```ts
import { wallClockToInstant } from "@gcpe/legacy-import";
import type { HistoryFieldKey } from "@gcpe/calendar-contract";
import type { LegacyLog } from "./legacy-rows";
import { stripNul } from "./map";

/** The only members legacy logged as "Update" (Calendar/ActivityManager.cs:291-305), PriorityId aside. An explicit table:
 * a FieldName not here is skipped, never passed through, so no HQ-only key can arrive under an unexpected name. */
export const LEGACY_LOG_FIELDS: Readonly<Record<string, HistoryFieldKey>> = {
  Title: "title", StartDateTime: "start", EndDateTime: "end", CityId: "city", IsConfirmed: "is_confirmed",
  CommunicationContactId: "comm_contact", ContactMinistryId: "contact_ministry", ActivityCategoriesId: "category",
  ActivityCommunicationMaterialsId: "comm_materials", NewsReleaseOriginId: "nr_origins", NewsReleaseDistributionId: "nr_distribution",
  ActivityThemesId: "themes",
};

export interface HistoryContext {
  timeZone: string;
  userIdOf(legacyId: number | null): string | null;
  actorNameOf(legacyId: number | null): string | null;
  cityNameOf(id: number): string | null;
  commContactLabelOf(id: number): string | null;
  orgNameOf(guid: string): string | null;
  contactMinistryKeyOf(activityId: number): string | null;
}
export interface HistoryEntry {
  legacyKey: string;
  activityId: number;
  logIds: number[];
  at: Date;
  actorId: string | null;
  actorName: string;
  contactMinistryKey: string | null;
  fields: { key: HistoryFieldKey; old: string | null; new: string | null }[];
}

const asInt = (v: string) => (/^\d{1,10}$/.test(v.trim()) ? Number(v.trim()) : null);

function display(key: HistoryFieldKey, raw: string | null, ctx: HistoryContext): string | null {
  if (raw === null) return null;
  const v = stripNul(raw);
  if (v.trim() === "") return null;
  const id = asInt(v);
  switch (key) {
    case "city": return (id !== null && ctx.cityNameOf(id)) || v;
    case "comm_contact": return (id !== null && ctx.commContactLabelOf(id)) || v;
    case "contact_ministry": return ctx.orgNameOf(v) ?? v;
    case "is_confirmed": return /^true$/i.test(v) ? "Yes" : /^false$/i.test(v) ? "No" : v;
    default: return v;
  }
}

/** Legacy log rows of imported activities as history entries (spec addendum §12.1 step 7). */
export function mapHistory(logs: LegacyLog[], ctx: HistoryContext): { entries: HistoryEntry[]; skipped: { logId: number; reason: string }[] } {
  const skipped: { logId: number; reason: string }[] = [];
  const groups = new Map<string, { rows: LegacyLog[]; wall: Date }>();
  for (const l of [...logs].sort((a, b) => a.Id - b.Id)) {
    if (l.Operation === "Edit") { skipped.push({ logId: l.Id, reason: "Edit row (lock noise)" }); continue; }
    if (l.Operation !== "Update") { skipped.push({ logId: l.Id, reason: "not an Update row" }); continue; }
    if (l.FieldName === "PriorityId") { skipped.push({ logId: l.Id, reason: "PriorityId (dropped, R9)" }); continue; }
    if (l.FieldName === null || !Object.hasOwn(LEGACY_LOG_FIELDS, l.FieldName)) { skipped.push({ logId: l.Id, reason: "unknown field" }); continue; }
    const wall = l.CreatedDateTime ?? l.LastUpdatedDateTime;
    const key = `${l.ActivityId}|${l.CreatedBy ?? ""}|${Math.floor(wall.getTime() / 1000)}`;
    const g = groups.get(key) ?? { rows: [], wall: new Date(Math.floor(wall.getTime() / 1000) * 1000) };
    g.rows.push(l);
    groups.set(key, g);
  }
  const entries: HistoryEntry[] = [];
  for (const { rows, wall } of groups.values()) {
    const first = rows[0]!;
    const fields = new Map<HistoryFieldKey, { key: HistoryFieldKey; old: string | null; new: string | null }>();
    for (const r of rows) {
      const k = LEGACY_LOG_FIELDS[r.FieldName!]!;
      const prev = fields.get(k);
      fields.set(k, { key: k, old: prev ? prev.old : display(k, r.OldValue, ctx), new: display(k, r.NewValue, ctx) });
    }
    entries.push({
      legacyKey: `log:${first.Id}`,
      activityId: first.ActivityId,
      logIds: rows.map((r) => r.Id),
      at: wallClockToInstant(wall, ctx.timeZone),
      actorId: ctx.userIdOf(first.CreatedBy),
      actorName: (ctx.actorNameOf(first.CreatedBy) ?? "").trim() || "Unknown legacy user",
      contactMinistryKey: ctx.contactMinistryKeyOf(first.ActivityId),
      fields: [...fields.values()],
    });
  }
  return { entries: entries.sort((a, b) => a.logIds[0]! - b.logIds[0]!), skipped };
}
```

Use the imported user's Core display name only through `actorNameOf`. The caller (Task 5) passes the legacy display name for everyone, so imported and non-imported actors read the same way.

- [ ] **Step 12: Run every Task 2 test and see it pass. Run the type-check.**

- [ ] **Step 13: Commit.**

```bash
git add apps/core/src/import/legacy-keys.ts apps/core/src/import/legacy-keys.test.ts apps/calendar/src/import/map.ts apps/calendar/src/import/map.test.ts apps/calendar/src/import/history-map.ts apps/calendar/src/import/history-map.test.ts
git commit -m "feat(calendar): map legacy activities, lookups, users and log rows to the Calendar's model"
```

---

### Task 3: Core users: plan and apply, matching, duplicates, no-email users and Calendar access

**Risk:** confidentiality and data-integrity (full review). It grants Calendar roles, up to SysAdmin, and sets who can sign in.

**Files:**
- Create: `apps/core/src/import/calendar-users.ts`
- Test: `apps/core/src/import/calendar-users.test.ts`

**Interfaces:**
- Consumes: `CalendarUserCandidate` (Task 2, `legacy-keys.ts`).
- Produces:
  - `normaliseEmail(raw): string | null`;
  - `CalendarUserGroup`, `CalendarUserPlan = { groups; invalidEmails: number[] }`;
  - `planCalendarUsers(coreDb, candidates): Promise<CalendarUserPlan>` (read-only);
  - `applyCalendarUsers(coreDb, plan, subscribers): Promise<CalendarUsersResult>`;
  - `CalendarUsersResult = { userIdOf: Map<number, string>; created; linked; unchanged; activated: string[]; accessGranted: string[]; accessKept: string[]; groups: { userId; legacyIds; representativeLegacyId }[] }`.

- [ ] **Step 1: Write the failing tests** (`calendar-users.test.ts`):

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCoreTestDb } from "../../test/helpers";
import { seedCoreForImport } from "../../../calendar/test/legacy-calendar-fixture";
import { roleGrants, userLegacyIds, users } from "../db/schema";
import { getUser } from "../services/users";
import { applyCalendarUsers, planCalendarUsers } from "./calendar-users";
import type { CalendarUserCandidate } from "./legacy-keys";
import { loadLegacyKeys } from "./legacy-keys";

let tdb: TestDatabase;
beforeAll(async () => { tdb = await createCoreTestDb(); });
afterAll(async () => { await tdb.drop(); });
beforeEach(async () => {
  await tdb.db.execute(sql`TRUNCATE users, organizations, terms, outbox_events, outbox_deliveries, aggregate_sequences CASCADE`);
  await seedCoreForImport(tdb.db);
});
const SUBS = [{ name: "calendar", url: "https://unused.example.test", secret: "unused-000000000000000000000000000000", types: ["user.upserted"] }];
const deliveries = async () => Number((await tdb.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM outbox_deliveries WHERE subscriber = 'calendar'`)).rows[0]!.n);
const cand = (legacyId: number, email: string | null, over: Partial<CalendarUserCandidate> = {}): CalendarUserCandidate =>
  ({ legacyId, email, displayName: `Sample User ${legacyId}`, isActive: true, calendarRole: "Calendar.Editor", organizationIds: [], lastUpdated: 0, ...over });
const run = async (c: CalendarUserCandidate[]) => applyCalendarUsers(tdb.db, await planCalendarUsers(tdb.db, c), SUBS);

describe("Calendar users into Core (spec addendum §12.1 step 1, R12, C144)", () => {
  it("creates a new user with legacy's role, ministries and legacy id, and tells subscribers once", async () => {
    const fin = (await loadLegacyKeys(tdb.db)).org("0F000000-0000-4000-8000-000000000001")!;
    const r = await run([cand(31, " New.Person@Example.test ", { organizationIds: [fin.id] })]);
    const u = (await getUser(tdb.db, r.userIdOf.get(31)!))!;
    expect(u).toMatchObject({ email: "new.person@example.test", isActive: true, calendarRole: "Calendar.Editor", organizationKeys: ["finance"] });
    expect(r.created).toBe(1);
    expect(await deliveries()).toBe(1);
  });

  it("imports a user with no email, or an invalid one, as inactive with no email, keeping their role", async () => {
    const r = await run([cand(32, null), cand(33, "not-an-address")]);
    for (const id of [32, 33]) expect(await getUser(tdb.db, r.userIdOf.get(id)!)).toMatchObject({ email: null, isActive: false, calendarRole: "Calendar.Editor" });
    expect((await planCalendarUsers(tdb.db, [cand(33, "not-an-address")])).invalidEmails).toEqual([33]);
  });

  it("maps duplicate emails to one user, taking role and ministries from the active row last updated", async () => {
    const r = await run([
      cand(34, "dup@example.test", { isActive: true, calendarRole: "Calendar.Advanced", lastUpdated: 1 }),
      cand(35, "DUP@example.test", { isActive: false, calendarRole: "Calendar.Administrator", lastUpdated: 2 }),
    ]);
    expect(r.userIdOf.get(34)).toBe(r.userIdOf.get(35));
    expect(r.groups).toEqual([expect.objectContaining({ legacyIds: [34, 35], representativeLegacyId: 34 })]);
    expect(await getUser(tdb.db, r.userIdOf.get(34)!)).toMatchObject({ isActive: true, calendarRole: "Calendar.Advanced" });
  });

  it("links an existing user by email: keeps their roles and active flag, adds Calendar access only when they have none", async () => {
    const r = await run([cand(11, "avery.sample@example.test", { calendarRole: "Calendar.Editor" })]);
    expect(await getUser(tdb.db, r.userIdOf.get(11)!)).toMatchObject({ displayName: "Avery Core", isActive: true, roles: ["NRMS.Editor"], calendarRole: "Calendar.Editor" });
    expect(r.linked).toBe(1);
  });

  it("never overwrites Calendar access Core already holds", async () => {
    const first = await run([cand(11, "avery.sample@example.test", { calendarRole: "Calendar.Editor" })]);
    await tdb.db.delete(userLegacyIds);
    const again = await run([cand(11, "avery.sample@example.test", { calendarRole: "Calendar.SysAdmin" })]);
    expect(again.accessKept).toEqual([first.userIdOf.get(11)]);
    expect((await getUser(tdb.db, first.userIdOf.get(11)!))!.calendarRole).toBe("Calendar.Editor");
  });

  it("activates a role-less inactive placeholder when legacy says active, but never a user with any role", async () => {
    const r = await run([cand(12, "blake.sample@example.test", { calendarRole: "Calendar.SysAdmin" })]);
    expect(await getUser(tdb.db, r.userIdOf.get(12)!)).toMatchObject({ isActive: true, calendarRole: "Calendar.SysAdmin" });
    expect(r.activated).toEqual([r.userIdOf.get(12)]);
  });

  it("a re-run matches by legacy id and changes nothing: no row, no grant, no event", async () => {
    const c = [cand(11, "avery.sample@example.test"), cand(36, null), cand(37, "new.two@example.test")];
    await run(c);
    const before = { d: await deliveries(), u: await tdb.db.select().from(users), g: await tdb.db.select().from(roleGrants) };
    const again = await run(c);
    expect(again.unchanged).toBe(3);
    expect(await deliveries()).toBe(before.d);
    expect(await tdb.db.select().from(users)).toEqual(before.u);
    expect(await tdb.db.select().from(roleGrants)).toEqual(before.g);
  });
});
```

- [ ] **Step 2: Run it** and see it fail because the module doesn't exist.

- [ ] **Step 3: Write `calendar-users.ts`:**

```ts
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Tx } from "@gcpe/db-kit";
import type { SubscriberConfig } from "@gcpe/events";
import { roleGrants, userLegacyIds, userOrganizations, users } from "../db/schema";
import { lockAggregate, userAggregateId } from "../services/aggregate";
import { emitUserUpserted } from "../services/users";
import type { CalendarUserCandidate } from "./legacy-keys";

const emailSchema = z.string().trim().toLowerCase().email().max(254);
/** Trimmed and lowercased; null when blank or not an email (imported as no email: inactive, R12). */
export function normaliseEmail(raw: string | null): string | null {
  if (raw === null || raw.trim() === "") return null;
  const p = emailSchema.safeParse(raw);
  return p.success ? p.data : null;
}

export interface CalendarUserGroup {
  legacyIds: number[];
  email: string | null;
  /** Where the role, ministries and name come from: the active row last updated, else the last updated. */
  representative: CalendarUserCandidate;
  /** Legacy active (any row) and an email. */
  isActive: boolean;
  existingUserId: string | null;
  how: "legacy-id" | "email" | "new";
}
export interface CalendarUserPlan { groups: CalendarUserGroup[]; invalidEmails: number[] }
export interface CalendarUsersResult {
  userIdOf: Map<number, string>;
  created: number;
  linked: number;
  unchanged: number;
  activated: string[];
  accessGranted: string[];
  accessKept: string[];
  groups: { userId: string; legacyIds: number[]; representativeLegacyId: number }[];
}

function representativeOf(members: CalendarUserCandidate[]): CalendarUserCandidate {
  const active = members.filter((m) => m.isActive);
  return [...(active.length ? active : members)].sort((a, b) => b.lastUpdated - a.lastUpdated || b.legacyId - a.legacyId)[0]!;
}

/** Read-only: how each legacy user (or group sharing an email) will land in Core. */
export async function planCalendarUsers(db: Db, candidates: CalendarUserCandidate[]): Promise<CalendarUserPlan> {
  const invalidEmails = candidates.filter((c) => c.email !== null && c.email.trim() !== "" && normaliseEmail(c.email) === null).map((c) => c.legacyId).sort((a, b) => a - b);
  const byKey = new Map<string, CalendarUserCandidate[]>();
  for (const c of candidates) {
    const key = normaliseEmail(c.email) ?? `legacy:${c.legacyId}`;
    byKey.set(key, [...(byKey.get(key) ?? []), c]);
  }
  const known = new Map((await db.select().from(userLegacyIds).where(eq(userLegacyIds.system, "calendar"))).map((r) => [r.legacyId, r.userId]));
  const groups: CalendarUserGroup[] = [];
  for (const [key, members] of byKey) {
    const email = key.startsWith("legacy:") ? null : key;
    const legacyIds = members.map((m) => m.legacyId).sort((a, b) => a - b);
    const viaLegacy = legacyIds.map((id) => known.get(String(id))).find((u): u is string => u !== undefined) ?? null;
    let existingUserId = viaLegacy;
    let how: CalendarUserGroup["how"] = viaLegacy ? "legacy-id" : "new";
    if (!existingUserId && email) {
      const [u] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`);
      if (u) { existingUserId = u.id; how = "email"; }
    }
    groups.push({ legacyIds, email, representative: representativeOf(members), isActive: email !== null && members.some((m) => m.isActive), existingUserId, how });
  }
  return { groups: groups.sort((a, b) => a.legacyIds[0]! - b.legacyIds[0]!), invalidEmails };
}

async function grantAccess(tx: Tx, userId: string, rep: CalendarUserCandidate): Promise<boolean> {
  let granted = false;
  if (rep.calendarRole) { await tx.insert(roleGrants).values({ userId, role: rep.calendarRole }); granted = true; }
  if (rep.organizationIds.length) {
    const rows = await tx.insert(userOrganizations).values(rep.organizationIds.map((organizationId) => ({ userId, organizationId }))).onConflictDoNothing().returning({ userId: userOrganizations.userId });
    granted ||= rows.length > 0;
  }
  return granted;
}

/**
 * Writes the plan. A user matched by legacy id is left exactly as it is. One matched by email keeps
 * its roles, ministries and active flag, except that Calendar access is added when it has none and
 * a role-less inactive placeholder is activated when legacy says active. One user.upserted per
 * changed user, in its own transaction.
 */
export async function applyCalendarUsers(db: Db, plan: CalendarUserPlan, subscribers: SubscriberConfig[]): Promise<CalendarUsersResult> {
  const r: CalendarUsersResult = { userIdOf: new Map(), created: 0, linked: 0, unchanged: 0, activated: [], accessGranted: [], accessKept: [], groups: [] };
  for (const g of plan.groups) {
    const userId = await db.transaction(async (tx) => {
      let id = g.existingUserId;
      let changed = false;
      if (id === null) {
        const [row] = await tx.insert(users).values({ email: g.email, displayName: g.representative.displayName, isActive: g.isActive }).returning({ id: users.id });
        id = row!.id;
        await lockAggregate(tx, userAggregateId(id));
        if (await grantAccess(tx, id, g.representative)) r.accessGranted.push(id);
        changed = true;
        r.created++;
      } else {
        await lockAggregate(tx, userAggregateId(id));
        const [u] = await tx.select({ isActive: users.isActive }).from(users).where(eq(users.id, id)).for("update");
        if (!u) throw new Error("a Core user matched by the import no longer exists");
        if (g.how === "email") {
          const grants = await tx.select({ role: roleGrants.role }).from(roleGrants).where(eq(roleGrants.userId, id));
          const orgs = await tx.select({ id: userOrganizations.organizationId }).from(userOrganizations).where(eq(userOrganizations.userId, id));
          if (!u.isActive && grants.length === 0 && g.isActive) {
            await tx.update(users).set({ isActive: true, updatedAt: new Date() }).where(eq(users.id, id));
            r.activated.push(id);
            changed = true;
          }
          if (!grants.some((x) => x.role.startsWith("Calendar.")) && orgs.length === 0) {
            if (await grantAccess(tx, id, g.representative)) { r.accessGranted.push(id); changed = true; }
          } else {
            r.accessKept.push(id);
          }
          r.linked++;
        } else {
          r.unchanged++;
        }
      }
      await tx.insert(userLegacyIds).values(g.legacyIds.map((l) => ({ system: "calendar" as const, legacyId: String(l), userId: id! }))).onConflictDoNothing();
      if (changed) await emitUserUpserted(tx, id, subscribers);
      return id;
    });
    for (const l of g.legacyIds) r.userIdOf.set(l, userId);
    r.groups.push({ userId, legacyIds: g.legacyIds, representativeLegacyId: g.representative.legacyId });
  }
  return r;
}
```

- [ ] **Step 4: Run the tests and see them pass. Run the type-check.**

- [ ] **Step 5: Commit.**

```bash
git add apps/core/src/import/calendar-users.ts apps/core/src/import/calendar-users.test.ts
git commit -m "feat(core): import legacy Calendar users, matched by legacy id then email, no-email users inactive"
```

---

### Task 4: The migration, the report, and writing lookups, comm contacts, activities and sequences

**Risk:** data-integrity and irreversible (full review). It adds a migration, and it decides insert, update or skip for every activity.

**Files:**
- Modify: `apps/calendar/src/db/schema.ts` (`activities.importedVersion`, `activityChanges.legacyKey` and its unique index)
- Create (generated): `apps/calendar/migrations/0001_legacy_import.sql`, `apps/calendar/migrations/meta/*`
- Create: `apps/calendar/src/import/report.ts`, `apps/calendar/src/import/apply.ts`
- Test: `apps/calendar/src/import/report.test.ts`, `apps/calendar/src/import/apply.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2 (`Scope`, `MappedActivity`, `mapLookup`, `LegacyKeys`).
- Produces:
  - `CalendarImportReport` with:
    - `legacy(table, n)`, `count(table, outcome, n?)`, `skip(table, legacyId, reason)`;
    - `listChangedInCalendar(id)`, `warn(activityId, fields)`, `fact(name, value)`, `note(text)`;
    - `unknownKeys(list)`, `savedFilterNotes(n)`, `markFailed(stage, message)`;
    - `balanced()`, `toJSON()`, `toText()`.
  - `Outcome` and `BALANCED_TABLES`.
  - `applyLookups(db, s, report)`.
  - `applyCommContacts(db, scope, userIdOf, keys, report): Promise<Map<number, number | null>>`.
  - `applyActivities(db, list, report): Promise<{ inserted: Set<number>; present: Set<number> }>`.
  - `rebaseSequences(db)` and `fingerprintOf(values, joins)`.

- [ ] **Step 1: Change the schema.** In `activities`, after `version`:

```ts
    /** The version the last legacy import wrote (spec addendum §12.1, safety 3): a re-run skips a row whose
     * version has moved past it, because the Calendar changed it since. Null for activities created in the Calendar. */
    importedVersion: integer("imported_version"),
```

In `activityChanges`, add the column `legacyKey: text("legacy_key"),` and, in the index list, `uniqueIndex("activity_changes_legacy_key_idx").on(t.legacyKey),` with the comment `// One entry per legacy log group: a re-run of the import adds nothing.`

- [ ] **Step 2: Generate the migration:** `cd apps/calendar && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name legacy_import`. Check that `0001_legacy_import.sql` holds exactly two `ADD COLUMN` statements and one `CREATE UNIQUE INDEX`, and nothing else. Run `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/db` and see it pass.

- [ ] **Step 3: Write the failing report test** (`report.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { CalendarImportReport } from "./report";

describe("the import report", () => {
  it("balances when every legacy row is out of scope, written, unchanged or skipped with a reason", () => {
    const r = new CalendarImportReport("confirmed", "2027-01-15");
    r.legacy("activities", 4);
    r.count("activities", "outOfScope", 1);
    r.count("activities", "inserted", 2);
    r.skip("activities", "1013", "a date's year is outside 1900–2199");
    expect(r.balanced()).toBe(true);
    r.legacy("activities", 1);
    expect(r.balanced()).toBe(false);
  });
  it("is never balanced after a failure, and records the cutoff and mode", () => {
    const r = new CalendarImportReport("dry-run", "2027-01-15");
    r.markFailed("activities", "connection lost");
    expect(r.toJSON()).toMatchObject({ mode: "dry-run", cutoff: "2027-01-15", balanced: false, failed: { stage: "activities" } });
    expect(r.toText()).toContain("NOT BALANCED");
  });
});
```

- [ ] **Step 4: Run it** and see it fail because the module doesn't exist.

- [ ] **Step 5: Write `report.ts`:**

```ts
/** Rows a table's legacy count must add up to (spec addendum §12.1, safety 4). */
export type Outcome = "outOfScope" | "planned" | "inserted" | "updated" | "unchanged" | "skipped";
const OUTCOMES: readonly Outcome[] = ["outOfScope", "planned", "inserted", "updated", "unchanged", "skipped"];
export const BALANCED_TABLES = ["users", "commContacts", "activities", "savedFilters", "favourites", "files", "logRows"] as const;
type Counts = Record<Outcome | "legacy", number>;

export interface CalendarImportReportJSON {
  mode: "dry-run" | "confirmed";
  cutoff: string;
  balanced: boolean;
  tables: Record<string, Counts>;
  skipped: { table: string; legacyId: string; reason: string }[];
  changedInCalendar: number[];
  /** Activities that break the shared validation, by field name only (imported anyway; fixed on next save). */
  validation: { activityId: number; fields: string[] }[];
  unknownKeys: { kind: string; guid: string }[];
  savedFilters: { strippedPrefix: number; dropped: { id: number; key: string; reason: string }[]; overCap: { ownerId: string; count: number }[] };
  facts: Record<string, number>;
  notes: string[];
  failed: { stage: string; message: string } | null;
}

/** Holds counts, ids, field names and reasons only: never a title, an email or a saved query's typed values. */
export class CalendarImportReport {
  private readonly tables = new Map<string, Counts>();
  private readonly data: Omit<CalendarImportReportJSON, "mode" | "cutoff" | "balanced" | "tables"> = {
    skipped: [], changedInCalendar: [], validation: [], unknownKeys: [], savedFilters: { strippedPrefix: 0, dropped: [], overCap: [] }, facts: {}, notes: [], failed: null,
  };
  constructor(readonly mode: "dry-run" | "confirmed", readonly cutoff: string) {}

  private row(table: string): Counts {
    let r = this.tables.get(table);
    if (!r) { r = { legacy: 0, outOfScope: 0, planned: 0, inserted: 0, updated: 0, unchanged: 0, skipped: 0 }; this.tables.set(table, r); }
    return r;
  }
  legacy(table: string, n: number): void { this.row(table).legacy += n; }
  count(table: string, outcome: Outcome, n = 1): void { this.row(table)[outcome] += n; }
  skip(table: string, legacyId: string, reason: string): void { this.count(table, "skipped"); this.data.skipped.push({ table, legacyId, reason }); }
  listChangedInCalendar(id: number): void { this.data.changedInCalendar.push(id); }
  warn(activityId: number, fields: string[]): void { if (fields.length) this.data.validation.push({ activityId, fields }); }
  fact(name: string, value: number): void { this.data.facts[name] = value; }
  note(text: string): void { this.data.notes.push(text); }
  unknownKeys(list: { kind: string; guid: string }[]): void { this.data.unknownKeys.push(...list); }
  savedFilterNotes(n: CalendarImportReportJSON["savedFilters"]): void {
    this.data.savedFilters.strippedPrefix += n.strippedPrefix;
    this.data.savedFilters.dropped.push(...n.dropped);
    this.data.savedFilters.overCap.push(...n.overCap);
  }
  markFailed(stage: string, message: string): void { this.data.failed = { stage, message }; }
  balanced(): boolean {
    if (this.data.failed) return false;
    for (const r of this.tables.values()) if (r.legacy !== OUTCOMES.reduce((n, o) => n + r[o], 0)) return false;
    return true;
  }
  toJSON(): CalendarImportReportJSON {
    return {
      mode: this.mode, cutoff: this.cutoff, balanced: this.balanced(),
      tables: Object.fromEntries([...this.tables.entries()].sort(([a], [b]) => a.localeCompare(b))),
      ...structuredClone(this.data),
    };
  }
  toText(): string {
    const j = this.toJSON();
    const lines = [`Calendar import (${j.mode}, cutoff ${j.cutoff}): ${j.balanced ? "balanced" : "NOT BALANCED"}${j.failed ? `; failed during ${j.failed.stage}: ${j.failed.message}` : ""}`];
    for (const [t, c] of Object.entries(j.tables)) lines.push(`  ${t}: legacy=${c.legacy} outOfScope=${c.outOfScope} planned=${c.planned} inserted=${c.inserted} updated=${c.updated} unchanged=${c.unchanged} skipped=${c.skipped}`);
    if (j.unknownKeys.length) { lines.push("Unknown legacy keys (fix Core first):"); for (const k of j.unknownKeys) lines.push(`  ${k.kind} ${k.guid}`); }
    if (j.changedInCalendar.length) lines.push(`Changed in the Calendar since the last import (not overwritten): ${j.changedInCalendar.join(", ")}`);
    if (j.skipped.length) { lines.push("Skipped:"); for (const s of j.skipped) lines.push(`  [${s.table}] ${s.legacyId}: ${s.reason}`); }
    if (j.validation.length) { lines.push("Validation problems (imported; fixed on next save):"); for (const v of j.validation) lines.push(`  ${v.activityId}: ${v.fields.join(", ")}`); }
    if (Object.keys(j.facts).length) { lines.push("Facts:"); for (const [k, v] of Object.entries(j.facts)) lines.push(`  ${k}: ${v}`); }
    for (const n of j.notes) lines.push(`Note: ${n}`);
    return lines.join("\n");
  }
}
```

The importer writes no report table for the join tables, the lookups' extras or the profiles beyond their own rows. Lookups balance under their own names (`lookup:categories` and so on).

- [ ] **Step 6: Run the report test and see it pass.**

- [ ] **Step 7: Write the failing apply test** (`apply.test.ts`). It uses a Calendar test database and the fixture, mapped as Task 2's tests do. The users are fake uuids, because the Calendar holds user ids without foreign keys.

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createFakeSource } from "@gcpe/legacy-import";
import type { TestDatabase } from "@gcpe/db-kit";
import type { LegacyKeys } from "../../../core/src/import/legacy-keys";
import { createCalendarTestDb } from "../../test/helpers";
import { GUID, legacyCalendarTables, TEST_CUTOFF } from "../../test/legacy-calendar-fixture";
import { activities, categories, commContacts, keywords } from "../db/schema";
import { applyActivities, applyCommContacts, applyLookups, rebaseSequences } from "./apply";
import { loadLegacy } from "./load";
import { joinsByActivity, mapActivity, type MappedActivity } from "./map";
import { CalendarImportReport } from "./report";
import { selectScope } from "./scope";

// The same in-memory keys as map.test.ts.
const keys: LegacyKeys = { /* copy ORGS/TERMS and the two functions from map.test.ts */ } as LegacyKeys;
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** Legacy users 13 and 14 share an email, so Core gives them one user, as Task 3 does. */
const userOf = (n: number) => uid(n === 14 ? 13 : n);
const opts = { cutoff: TEST_CUTOFF, awarenessCategoryIds: [2] };
let tdb: TestDatabase;
beforeAll(async () => { tdb = await createCalendarTestDb(); });
afterAll(async () => { await tdb.drop(); });
beforeEach(async () => { await tdb.db.execute(sql`TRUNCATE activities, comm_contacts, categories, cities, comm_materials, event_planners, government_representatives, initiatives, keywords, nr_distributions, nr_origins, premier_requested, videographers RESTART IDENTITY CASCADE`); });

async function importOnce(report = new CalendarImportReport("confirmed", TEST_CUTOFF)) {
  const s = await loadLegacy(createFakeSource(legacyCalendarTables()), opts);
  const scope = selectScope(s, opts);
  await applyLookups(tdb.db, s, report);
  const remap = await applyCommContacts(tdb.db, scope, userOf, keys, report);
  const joins = joinsByActivity(scope);
  const list = scope.activities.map((a) => mapActivity(a, joins.get(a.Id)!, { timeZone: "America/Vancouver", userIdOf: (id) => (id === null ? null : userOf(id)), commContactIdOf: (id) => (id === null ? null : (remap.get(id) ?? null)), keys }))
    .filter((m): m is MappedActivity => !("skip" in m));
  const result = await applyActivities(tdb.db, list, report);
  await rebaseSequences(tdb.db);
  return { s, scope, report, result };
}

describe("writing the Calendar's own rows", () => {
  it("imports every lookup with its legacy id, a null name as empty, keyword names exactly", async () => {
    await importOnce();
    expect((await tdb.db.select().from(categories).where(eq(categories.id, 91)))[0]).toMatchObject({ name: "", isActive: false });
    expect((await tdb.db.select().from(categories).where(eq(categories.id, 16)))[0]!.name).toBe("Sample  speech");
    expect((await tdb.db.select().from(keywords).where(eq(keywords.id, 40)))[0]!.name).toBe("3-10");
  });

  it("merges two contacts of one person and ministry, skips one with no ministry, ranks by SortOrder", async () => {
    const { report } = await importOnce();
    expect((await tdb.db.select({ id: commContacts.id, rank: commContacts.rank }).from(commContacts)).sort((a, b) => a.id - b.id)).toEqual([{ id: 501, rank: 1 }, { id: 502, rank: 4 }, { id: 503, rank: 2 }]);
    expect(report.toJSON().skipped).toEqual(expect.arrayContaining([
      { table: "commContacts", legacyId: "504", reason: "merged into contact 503 (same person and ministry)" },
      { table: "commContacts", legacyId: "506", reason: "no ministry" },
    ]));
  });

  it("inserts activities with legacy ids and imported_version 1, and leaves them alone on a re-run", async () => {
    const { result } = await importOnce();
    expect([...result.inserted].sort()).toEqual([1001, 1002, 1004, 1005, 1006, 1009, 1010, 1011, 1012]);
    const again = await importOnce(new CalendarImportReport("confirmed", TEST_CUTOFF));
    expect(again.result.inserted.size).toBe(0);
    expect(again.report.toJSON().tables.activities).toMatchObject({ unchanged: 9, inserted: 0, updated: 0 });
  });

  it("skips an activity the Calendar changed since the import, and one created in the Calendar", async () => {
    await importOnce();
    await tdb.db.update(activities).set({ title: "Edited in the Calendar", version: 2 }).where(eq(activities.id, 1001));
    await tdb.db.update(activities).set({ importedVersion: null }).where(eq(activities.id, 1002));
    const { report } = await importOnce(new CalendarImportReport("confirmed", TEST_CUTOFF));
    expect((await tdb.db.select().from(activities).where(eq(activities.id, 1001)))[0]!.title).toBe("Edited in the Calendar");
    expect(report.toJSON().changedInCalendar).toEqual([1001, 1002]);
  });

  it("updates an unchanged-in-Calendar activity whose legacy values moved, bumping both versions", async () => {
    await importOnce();
    await tdb.db.update(activities).set({ title: "Stale import" }).where(eq(activities.id, 1002)); // as if legacy had changed
    const { report } = await importOnce(new CalendarImportReport("confirmed", TEST_CUTOFF));
    expect((await tdb.db.select().from(activities).where(eq(activities.id, 1002)))[0]).toMatchObject({ title: "Sample activity 1002", version: 2, importedVersion: 2 });
    expect(report.toJSON().tables.activities!.updated).toBe(1);
  });

  it("moves every legacy-id identity past the imported maximum", async () => {
    await importOnce();
    const [c] = await tdb.db.insert(categories).values({ name: "New after import" }).returning({ id: categories.id });
    expect(c!.id).toBeGreaterThan(91);
    const [a] = await tdb.db.insert(activities).values({}).returning({ id: activities.id });
    expect(a!.id).toBeGreaterThan(1012);
  });
});
```

Copy `ORGS`, `TERMS` and `keys` from `map.test.ts` in full. Don't leave the placeholder comment above; it only marks where they go.

- [ ] **Step 8: Run it** and see it fail because `./apply` doesn't exist.

- [ ] **Step 9: Write `apply.ts`:**

```ts
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import type { LegacyKeys } from "../../../core/src/import/legacy-keys";
import { loadStored, replaceJoins, type JoinIds } from "../activities/store";
import {
  activities, categories, cities, commContacts, commMaterials, eventPlanners, governmentRepresentatives, initiatives, keywords,
  nrDistributions, nrOrigins, premierRequested, videographers,
} from "../db/schema";
import { LOOKUP_TABLES, type LegacySnapshot, type LookupTable } from "./legacy-rows";
import { mapLookup, type ActivityValues, type MappedActivity } from "./map";
import type { CalendarImportReport } from "./report";
import type { Scope } from "./scope";

const LOOKUP_TARGET = {
  categories, cities, commMaterials, eventPlanners, governmentRepresentatives, initiatives, keywords, nrDistributions, nrOrigins, premierRequested, videographers,
} as const satisfies Record<LookupTable, unknown>;

/** Every lookup, keeping legacy ids. Copied the first time only: lookup admin edits are never overwritten. */
export async function applyLookups(db: Db, s: LegacySnapshot, report: CalendarImportReport): Promise<void> {
  for (const t of LOOKUP_TABLES) {
    const table = LOOKUP_TARGET[t];
    report.legacy(`lookup:${t}`, s.lookups[t].length);
    for (const r of s.lookups[t]) {
      const rows = await db.insert(table).values(mapLookup(t, r) as never).onConflictDoNothing({ target: table.id }).returning({ id: table.id });
      report.count(`lookup:${t}`, rows.length ? "inserted" : "unchanged");
    }
  }
}

const rankOf = (n: number | null) => (n !== null && n >= 1 && n <= 6 ? n : null);

/**
 * In-scope comm contacts with their legacy ids. Active first, then by id, so two contacts of one
 * Core user and ministry (duplicate legacy emails) merge into the active, lowest-id one. Returns
 * legacy id → surviving Calendar contact id, or null when it wasn't imported.
 */
export async function applyCommContacts(db: Db, scope: Scope, userIdOf: (legacyId: number) => string | null, keys: LegacyKeys, report: CalendarImportReport): Promise<Map<number, number | null>> {
  const remap = new Map<number, number | null>();
  const ordered = [...scope.commContacts].sort((a, b) => Number(b.IsActive === true) - Number(a.IsActive === true) || a.Id - b.Id);
  for (const c of ordered) {
    const userId = userIdOf(c.SystemUserId);
    if (!userId) { report.skip("commContacts", String(c.Id), "its user wasn't imported"); remap.set(c.Id, null); continue; }
    if (c.MinistryId === null) { report.skip("commContacts", String(c.Id), "no ministry"); remap.set(c.Id, null); continue; }
    const ministryKey = keys.org(c.MinistryId)!.key;
    const [byId] = await db.select().from(commContacts).where(eq(commContacts.id, c.Id));
    if (byId) {
      if (byId.userId === userId && byId.ministryKey === ministryKey) { report.count("commContacts", "unchanged"); remap.set(c.Id, c.Id); }
      else { report.skip("commContacts", String(c.Id), "its id is held by another contact"); remap.set(c.Id, null); }
      continue;
    }
    const [byPair] = await db.select({ id: commContacts.id }).from(commContacts).where(and(eq(commContacts.userId, userId), eq(commContacts.ministryKey, ministryKey)));
    if (byPair) { report.skip("commContacts", String(c.Id), `merged into contact ${byPair.id} (same person and ministry)`); remap.set(c.Id, byPair.id); continue; }
    await db.insert(commContacts).values({ id: c.Id, userId, ministryKey, rank: rankOf(c.SortOrder), sortOrder: 0, isActive: c.IsActive === true });
    report.count("commContacts", "inserted");
    remap.set(c.Id, c.Id);
  }
  return remap;
}

/** A stable comparison of the columns the import writes and the join sets. */
export function fingerprintOf(values: Partial<ActivityValues>, joins: JoinIds): string {
  const v = Object.fromEntries(Object.keys(values).sort().map((k) => [k, (values as Record<string, unknown>)[k]]));
  return JSON.stringify([v, joins]);
}

/**
 * Activities by legacy id (spec addendum §12.1, safety 3): new ones inserted with imported_version 1;
 * one the Calendar changed since (version past imported_version), or created there (no
 * imported_version), skipped and listed; otherwise updated only when its legacy values moved.
 */
export async function applyActivities(db: Db, list: MappedActivity[], report: CalendarImportReport): Promise<{ inserted: Set<number>; present: Set<number> }> {
  const inserted = new Set<number>();
  const present = new Set<number>();
  for (const m of list) {
    const outcome = await db.transaction(async (tx) => {
      const [cur] = await tx.select({ version: activities.version, importedVersion: activities.importedVersion }).from(activities).where(eq(activities.id, m.id)).for("update");
      if (!cur) {
        await tx.insert(activities).values({ id: m.id, ...m.values, version: 1, importedVersion: 1 });
        await replaceJoins(tx, m.id, m.joins);
        return "inserted" as const;
      }
      if (cur.importedVersion === null) return "calendar-owned" as const;
      if (cur.version > cur.importedVersion) return "changed" as const;
      const stored = (await loadStored(tx, m.id))!;
      const storedValues = Object.fromEntries(Object.keys(m.values).map((k) => [k, (stored.row as Record<string, unknown>)[k]]));
      if (fingerprintOf(storedValues, stored.joins) === fingerprintOf(m.values, m.joins)) return "unchanged" as const;
      const next = cur.version + 1;
      await tx.update(activities).set({ ...m.values, version: next, importedVersion: next }).where(eq(activities.id, m.id));
      await replaceJoins(tx, m.id, m.joins);
      return "updated" as const;
    });
    if (outcome === "inserted") { inserted.add(m.id); present.add(m.id); report.count("activities", "inserted"); }
    else if (outcome === "updated" || outcome === "unchanged") { present.add(m.id); report.count("activities", outcome); }
    else if (outcome === "changed") { present.add(m.id); report.skip("activities", String(m.id), "changed in the Calendar since the last import"); report.listChangedInCalendar(m.id); }
    else { report.skip("activities", String(m.id), "its id is held by an activity created in the Calendar"); report.listChangedInCalendar(m.id); }
  }
  return { inserted, present };
}

const REBASED = [
  "activities", "categories", "cities", "comm_materials", "event_planners", "government_representatives", "initiatives", "keywords",
  "nr_distributions", "nr_origins", "premier_requested", "videographers", "comm_contacts", "saved_filters", "activity_files",
] as const;

/** Moves each legacy-id identity past the highest id, never lowering it (spec addendum §12.1 "Sequences"). */
export async function rebaseSequences(db: Db): Promise<void> {
  for (const t of REBASED) {
    const r = await db.execute<{ seq: string }>(sql`SELECT pg_get_serial_sequence(${t}, 'id') AS seq`);
    const seq = r.rows[0]!.seq;
    if (!/^[a-z_.]+$/.test(seq)) throw new Error("unexpected sequence name");
    await db.execute(sql.raw(`SELECT setval('${seq}', GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${t}), (SELECT last_value FROM ${seq})), true)`));
  }
}
```

In `importOnce` (the test) and in `run.ts` (Task 6), `applyCommContacts` is called before `mapActivity`, so the merge remap is ready.

`present` holds every activity the Calendar now has from an import, changed ones included. Task 5 gives files and history to exactly those.

- [ ] **Step 10: Run the apply and report tests and see them pass. Run the type-check, which now also covers Task 2's cast.**

- [ ] **Step 11: Commit.**

```bash
git add apps/calendar/src/db/schema.ts apps/calendar/migrations apps/calendar/src/import/report.ts apps/calendar/src/import/report.test.ts apps/calendar/src/import/apply.ts apps/calendar/src/import/apply.test.ts
git commit -m "feat(calendar): import lookups, comm contacts and activities by legacy id, with a version guard and re-based sequences"
```

---

### Task 5: Favourites, profiles, saved filters, attachments and history

**Risk:** confidentiality and data-integrity (full review). It copies bytes to the store, and history entries reach "View changes".

**Files:**
- Create: `apps/calendar/src/import/apply-related.ts`
- Test: `apps/calendar/src/import/apply-related.test.ts`

**Interfaces:**
- Consumes:
  - Task 4: `applyActivities`'s `inserted` and `present`, and `CalendarImportReport`;
  - Task 2: `mapHistory` and `HistoryEntry`;
  - Task 3: `CalendarUsersResult["groups"]`.
- Produces:
  - `applyFavourites(db, scope, userIdOf, inserted, report)`;
  - `applyProfiles(db, s, groups, report)`;
  - `applySavedFilters(db, scope, userIdOf, keys, report)`;
  - `applyFiles(db, store, scope, userIdOf, present, timeZone, report)`;
  - `applyHistory(db, entries, skipped, present, report)`.

- [ ] **Step 1: Write the failing tests** (`apply-related.test.ts`). The setup is Task 4's file header, `keys`, `uid`, `userOf` and `importOnce` (copied in full; it returns `{ s, scope, report, result }`), with `activity_changes`, `favourites`, `saved_filters`, `user_profiles` and `activity_files` added to the `TRUNCATE`, plus `let store: ObjectStore` set in `beforeEach` to `localStore(await mkdtemp(join(tmpdir(), "cal-files-")))`:

```ts
it("favourites come with a newly inserted activity only, and never come back once removed", async () => {
  const { scope, result, report } = await importOnce();
  await applyFavourites(tdb.db, scope, userOf, result.inserted, report);
  expect(await tdb.db.select().from(favourites)).toEqual(expect.arrayContaining([{ userId: uid(11), activityId: 1001 }, { userId: uid(20), activityId: 1004 }]));
  await tdb.db.delete(favourites).where(eq(favourites.activityId, 1001));
  const again = await importOnce();
  await applyFavourites(tdb.db, again.scope, userOf, again.result.inserted, again.report);
  expect(await tdb.db.select().from(favourites)).toEqual([{ userId: uid(20), activityId: 1004 }]);
});

it("a profile per imported user, written once: list preferences together, an empty mobile kept, a bad one dropped", async () => {
  const { s, report } = await importOnce();
  await applyProfiles(tdb.db, s, [{ userId: uid(19), legacyIds: [19], representativeLegacyId: 19 }, { userId: uid(21), legacyIds: [21], representativeLegacyId: 21 }, { userId: uid(11), legacyIds: [11], representativeLegacyId: 11 }], report);
  expect((await tdb.db.select().from(userProfiles).where(eq(userProfiles.userId, uid(19))))[0]).toMatchObject({ listDisplay: "my_activities", hiddenColumns: ["keywords", "status"] });
  expect((await tdb.db.select().from(userProfiles).where(eq(userProfiles.userId, uid(11))))[0]!.mobile).toBe("");
  expect((await tdb.db.select().from(userProfiles).where(eq(userProfiles.userId, uid(21))))[0]!.mobile).toBeNull();
});

it("saved filters through the 5d converter, first time only; dropped values never reach the report", async () => {
  const { scope, report } = await importOnce();
  await applySavedFilters(tdb.db, scope, userOf, keys, report);
  expect((await tdb.db.select({ id: savedFilters.id }).from(savedFilters)).map((r) => r.id).sort()).toEqual([701, 702]);
  expect(report.toJSON().savedFilters.strippedPrefix).toBe(1);
  expect(JSON.stringify(report.toJSON())).not.toContain("sample typed text");
  await tdb.db.update(savedFilters).set({ name: "Renamed" }).where(eq(savedFilters.id, 701));
  await applySavedFilters(tdb.db, scope, userOf, keys, report);
  expect((await tdb.db.select().from(savedFilters).where(eq(savedFilters.id, 701)))[0]!.name).toBe("Renamed");
});

it("attachments: the bare name of a Windows path, a blocked type kept as legacy's and served as a download, a wrong MD5 skipped", async () => {
  const { scope, result, report } = await importOnce();
  await applyFiles(tdb.db, store, scope, userOf, result.present, "America/Vancouver", report);
  const rows = (await tdb.db.select().from(activityFiles)).sort((a, b) => a.id - b.id);
  expect(rows.map((r) => [r.id, r.fileName, r.contentType])).toEqual([[801, "briefing.pdf", "application/pdf"], [804, "notes.exe", "application/x-msdownload"]]);
  expect(downloadContentType(rows[1]!.contentType)).toBe("application/octet-stream");
  expect((await store.get(rows[0]!.storageKey))!.bytes.equals(PDF_BYTES)).toBe(true);
  expect(rows[0]!.storageKey).toMatch(/^activities\/1001\/[0-9a-f]{16}-briefing\.pdf$/);
  expect(report.toJSON().skipped).toContainEqual({ table: "files", legacyId: "802", reason: "MD5 doesn't match the bytes" });
});

it("history: legacy entries marked legacy_log, keyed so a re-run adds nothing", async () => {
  const { s, scope, result, report } = await importOnce();
  const h = mapHistory(scope.logs, historyContext(s)); // the same context run.ts builds
  await applyHistory(tdb.db, h.entries, h.skipped, result.present, report);
  await applyHistory(tdb.db, h.entries, h.skipped, result.present, report);
  const changes = await tdb.db.select().from(activityChanges);
  expect(changes).toHaveLength(3); // log:9001 (two fields), log:9005, log:9008
  expect(changes.every((c) => c.source === "legacy_log" && c.action === "updated")).toBe(true);
  expect(report.toJSON().tables.logRows).toMatchObject({ inserted: 4, unchanged: 4, skipped: 6 });
});
```

`historyContext(s)` in the test is a small local function with the same shape as Task 2's history test context. Task 6's `run.ts` exports the real one, `historyContextOf`. Once Task 6 lands, switch this test to it.

- [ ] **Step 2: Run them** and see them fail because `./apply-related` doesn't exist.

- [ ] **Step 3: Write `apply-related.ts`:**

```ts
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { safeErrorLabel } from "@gcpe/http-kit";
import { wallClockToInstant } from "@gcpe/legacy-import";
import { checkAttachment, randomFileKey, type ObjectStore } from "@gcpe/storage";
import type { LegacyKeys } from "../../../core/src/import/legacy-keys";
import { attachmentName } from "../activities/files";
import { activityChangeFields, activityChanges, activityFiles, favourites, savedFilters, userProfiles } from "../db/schema";
import { legacyDisplay, legacyHiddenColumns, migrateLegacySavedFilters } from "../list/legacy-filters";
import type { HistoryEntry } from "./history-map";
import type { LegacySnapshot } from "./legacy-rows";
import { stripNul } from "./map";
import type { CalendarImportReport } from "./report";
import type { Scope } from "./scope";

/** Favourites come only with an activity inserted in this run, so a re-run never re-adds one a user removed. */
export async function applyFavourites(db: Db, scope: Scope, userIdOf: (id: number) => string | null, inserted: Set<number>, report: CalendarImportReport): Promise<void> {
  for (const f of scope.favourites) {
    const userId = userIdOf(f.SystemUserId);
    if (!userId) { report.skip("favourites", `${f.SystemUserId}/${f.ActivityId}`, "its user wasn't imported"); continue; }
    if (!inserted.has(f.ActivityId)) {
      const [has] = await db.select().from(favourites).where(and(eq(favourites.userId, userId), eq(favourites.activityId, f.ActivityId)));
      if (has) report.count("favourites", "unchanged");
      else report.skip("favourites", `${f.SystemUserId}/${f.ActivityId}`, "its activity was imported before; favourites are copied with the first import only");
      continue;
    }
    const rows = await db.insert(favourites).values({ userId, activityId: f.ActivityId }).onConflictDoNothing().returning({ userId: favourites.userId });
    report.count("favourites", rows.length ? "inserted" : "unchanged");
  }
}

const MOBILE = /^[0-9-]{12}$/;
const cap = (s: string | null, n: number) => (s === null ? null : stripNul(s).trim().slice(0, n) || null);

/** One profile per imported Core user, from the legacy row chosen for that user, written once. */
export async function applyProfiles(db: Db, s: LegacySnapshot, groups: { userId: string; representativeLegacyId: number }[], report: CalendarImportReport): Promise<void> {
  for (const g of groups) {
    const u = s.users.find((x) => x.Id === g.representativeLegacyId)!;
    const mobileRaw = u.MobileNumber === null ? null : stripNul(u.MobileNumber).trim();
    const mobile = mobileRaw === null || mobileRaw === "" || MOBILE.test(mobileRaw) ? mobileRaw : null;
    if (mobileRaw !== null && mobile === null) report.note(`legacy user ${u.Id}'s mobile number didn't match legacy's own format and was left out`);
    const rows = await db.insert(userProfiles).values({
      userId: g.userId, phone: cap(u.PhoneNumber, 20), mobile, jobTitle: cap(u.JobTitle, 100), description: cap(u.Description, 2000),
      listDisplay: legacyDisplay(u.FilterDisplayValue), hiddenColumns: legacyHiddenColumns(u.HiddenColumns),
    }).onConflictDoNothing().returning({ userId: userProfiles.userId });
    report.count("profiles", rows.length ? "inserted" : "unchanged");
  }
  report.legacy("profiles", groups.length);
}

/** Active legacy saved queries not yet in the Calendar, through the list's converter (5d). */
export async function applySavedFilters(db: Db, scope: Scope, userIdOf: (id: number) => string | null, keys: LegacyKeys, report: CalendarImportReport): Promise<void> {
  const ids = scope.savedFilters.map((f) => f.Id);
  const existing = new Set(ids.length ? (await db.select({ id: savedFilters.id }).from(savedFilters).where(inArray(savedFilters.id, ids))).map((r) => r.id) : []);
  report.count("savedFilters", "unchanged", existing.size);
  const fresh = scope.savedFilters.filter((f) => !existing.has(f.Id));
  if (!fresh.length) return;
  const r = await migrateLegacySavedFilters(db, fresh.map((f) => ({ id: f.Id, createdBy: f.CreatedBy, name: f.Name, queryString: f.QueryString, sortOrder: f.SortOrder, isActive: f.IsActive })), {
    ministryKeyOf: (g) => keys.org(g)?.key ?? null,
    userIdOf: (id) => userIdOf(id),
  });
  report.count("savedFilters", "inserted", r.migrated);
  for (const n of r.skippedNoOwner) report.skip("savedFilters", String(n.id), "no imported owner, or the owner's id couldn't be resolved to a user");
  for (const n of r.skippedInvalid ?? []) report.skip("savedFilters", String(n.id), n.reason);
  report.savedFilterNotes({ strippedPrefix: r.strippedPrefix, dropped: r.dropped.map((d) => ({ id: d.id, key: d.key, reason: d.reason })), overCap: r.overCap ?? [] });
}

/**
 * Attachments of imported activities (spec addendum §12.1 step 6). The MD5 is checked against the
 * bytes; the bytes go into the store first and are removed again if the row can't be written.
 */
export async function applyFiles(db: Db, store: ObjectStore, scope: Scope, userIdOf: (id: number) => string | null, present: Set<number>, timeZone: string, report: CalendarImportReport): Promise<void> {
  for (const f of scope.files) {
    if (!present.has(f.ActivityId)) { report.skip("files", String(f.Id), "its activity wasn't imported"); continue; }
    const [has] = await db.select({ id: activityFiles.id }).from(activityFiles).where(eq(activityFiles.id, f.Id));
    if (has) { report.count("files", "unchanged"); continue; }
    if (createHash("md5").update(f.Data).digest("hex") !== f.Md5.trim().toLowerCase()) { report.skip("files", String(f.Id), "MD5 doesn't match the bytes"); continue; }
    const fileName = attachmentName(f.FileName) || `attachment-${f.Id}`;
    const check = checkAttachment(fileName, f.Data);
    const contentType = check.ok ? check.contentType : (f.FileType.trim().slice(0, 255) || "application/octet-stream");
    const key = randomFileKey(`activities/${f.ActivityId}`, fileName);
    await store.put(key, f.Data, contentType);
    try {
      const rows = await db.insert(activityFiles).values({
        id: f.Id, activityId: f.ActivityId, fileName, contentType, length: f.Data.length,
        sha256: createHash("sha256").update(f.Data).digest("hex"), storageKey: key,
        uploadedAt: wallClockToInstant(f.LastUpdatedDateTime, timeZone), uploadedBy: f.LastUpdatedBy === null ? null : userIdOf(f.LastUpdatedBy),
      }).onConflictDoNothing().returning({ id: activityFiles.id });
      if (rows.length) report.count("files", "inserted");
      else { await store.delete(key); report.skip("files", String(f.Id), "another file on the activity has this name"); }
    } catch (e) {
      await store.delete(key).catch(() => false);
      console.error("[calendar:import] could not record an attachment", f.ActivityId, f.Id, safeErrorLabel(e));
      throw e;
    }
  }
}

/** Legacy log entries of imported activities, once each (activity_changes.legacy_key). Counted per legacy log row. */
export async function applyHistory(db: Db, entries: HistoryEntry[], skipped: { logId: number; reason: string }[], present: Set<number>, report: CalendarImportReport): Promise<void> {
  for (const s of skipped) report.skip("logRows", String(s.logId), s.reason);
  for (const e of entries) {
    if (!present.has(e.activityId)) { for (const id of e.logIds) report.skip("logRows", String(id), "its activity wasn't imported"); continue; }
    const added = await db.transaction(async (tx) => {
      const [row] = await tx.insert(activityChanges).values({
        activityId: e.activityId, at: e.at, actorId: e.actorId, actorName: e.actorName, action: "updated", source: "legacy_log",
        contactMinistryKey: e.contactMinistryKey, legacyKey: e.legacyKey,
      }).onConflictDoNothing({ target: activityChanges.legacyKey }).returning({ id: activityChanges.id });
      if (!row) return false;
      await tx.insert(activityChangeFields).values(e.fields.map((f) => ({ changeId: row.id, fieldKey: f.key, oldValue: f.old, newValue: f.new })));
      return true;
    });
    report.count("logRows", added ? "inserted" : "unchanged", e.logIds.length);
  }
}
```

- [ ] **Step 4: Run the tests and see them pass. Run the type-check.**

- [ ] **Step 5: Commit.**

```bash
git add apps/calendar/src/import/apply-related.ts apps/calendar/src/import/apply-related.test.ts
git commit -m "feat(calendar): import favourites, profiles, saved filters, attachments and legacy history"
```

---

### Task 6: The run, the report, the CLI, and acceptance 15 end to end

**Risk:** data-integrity (full review). This holds the acceptance test.

**Files:**
- Create: `apps/calendar/src/import/run.ts`, `apps/calendar/src/import/cli.ts`
- Test: `apps/calendar/src/import/run.test.ts`
- Modify: `apps/calendar/package.json` (script `"import:legacy": "tsx src/import/cli.ts"`), root `package.json` (script `"calendar:import": "npm --workspace @gcpe/calendar run import:legacy --"`)

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `CALENDAR_IMPORT_LOCK = [0x67637065, 3]`;
  - `parseImportArgs(argv): { cutoff: string; confirm: boolean; reportPath?: string }`;
  - `runCalendarImport(deps, opts): Promise<CalendarImportReport>`;
  - `runCalendarImportCli(deps & { reportPath }, opts): Promise<0 | 1 | 2>`;
  - `historyContextOf(s, scope, keys, userIdOf, mappedById)`;
  - `UnknownLegacyKeysError`.
  - `CalendarImportDeps = { db: Db; coreDb: Db; source: LegacySource; store: ObjectStore; rules: CalendarRules; coreSubscribers: SubscriberConfig[]; log?: (s: string) => void }`.

- [ ] **Step 1: Write the failing acceptance test** (`run.test.ts`). It uses a Core test database seeded with `seedCoreForImport`, a Calendar test database, a temporary store and the fake source.

```ts
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { inferLookAhead } from "@gcpe/calendar-contract";
import { createFakeSource } from "@gcpe/legacy-import";
import { localStore } from "@gcpe/storage";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCoreTestDb } from "../../../core/test/helpers";
import { userLegacyIds, users as coreUsers } from "../../../core/src/db/schema";
import { createCalendarTestDb, TEST_RULES } from "../../test/helpers";
import { CONFIDENTIAL_MARKER, GUID, legacyCalendarTables, seedCoreForImport, TEST_CUTOFF } from "../../test/legacy-calendar-fixture";
import { activities, activityChanges, activityFiles, categories, favourites, savedFilters } from "../db/schema";
import { parseImportArgs, runCalendarImport, runCalendarImportCli } from "./run";

let cal: TestDatabase, core: TestDatabase;
beforeAll(async () => { [cal, core] = await Promise.all([createCalendarTestDb(), createCoreTestDb()]); });
afterAll(async () => { await Promise.all([cal.drop(), core.drop()]); });
beforeEach(async () => {
  await cal.db.execute(sql`TRUNCATE activities, comm_contacts, saved_filters, user_profiles, favourites, activity_files, activity_changes, outbox_events, categories, cities, comm_materials, event_planners, government_representatives, initiatives, keywords, nr_distributions, nr_origins, premier_requested, videographers RESTART IDENTITY CASCADE`);
  await core.db.execute(sql`TRUNCATE users, organizations, terms, outbox_events, outbox_deliveries, aggregate_sequences CASCADE`);
  await seedCoreForImport(core.db);
});
const SUBS = [{ name: "calendar", url: "https://unused.example.test", secret: "unused-000000000000000000000000000000", types: ["user.upserted"] }];
async function deps(tables = legacyCalendarTables()) {
  return { db: cal.db, coreDb: core.db, source: createFakeSource(tables), store: localStore(await mkdtemp(join(tmpdir(), "cal-import-"))), rules: TEST_RULES, coreSubscribers: SUBS };
}
const confirm = { cutoff: TEST_CUTOFF, confirm: true };
const CAL_TABLES = ["activities", "activity_categories", "activity_keywords", "activity_shared_with", "comm_contacts", "favourites", "saved_filters", "user_profiles", "activity_files", "activity_changes", "activity_change_fields", "categories", "keywords"];
const CORE_TABLES = ["users", "role_grants", "user_organizations", "user_legacy_ids", "outbox_events"];
const snapshot = async () => {
  const out: Record<string, unknown> = {};
  for (const t of CAL_TABLES) out[`cal.${t}`] = (await cal.db.execute(sql.raw(`SELECT * FROM ${t} ORDER BY 1, 2`))).rows;
  for (const t of CORE_TABLES) out[`core.${t}`] = (await core.db.execute(sql.raw(`SELECT * FROM ${t} ORDER BY 1`))).rows;
  return out;
};

describe("calendar:import (acceptance 15)", () => {
  it("parses a required, real cutoff and --confirm", () => {
    expect(parseImportArgs(["--cutoff", "2027-01-15"])).toEqual({ cutoff: "2027-01-15", confirm: false });
    expect(parseImportArgs(["--cutoff", "2027-01-15", "--confirm", "--report", "r.json"])).toEqual({ cutoff: "2027-01-15", confirm: true, reportPath: "r.json" });
    expect(() => parseImportArgs([])).toThrow(/--cutoff/);
    expect(() => parseImportArgs(["--cutoff", "2027-02-30"])).toThrow();
    expect(() => parseImportArgs(["--cutoff", "2027-01-15", "--force"])).toThrow(/Unknown argument/);
  });

  it("a dry run writes nothing anywhere, and its report balances", async () => {
    const before = await snapshot();
    const report = await runCalendarImport(await deps(), { cutoff: TEST_CUTOFF, confirm: false });
    expect(await snapshot()).toEqual(before);
    expect(report.toJSON()).toMatchObject({ mode: "dry-run", balanced: true });
    expect(report.toJSON().tables.activities).toMatchObject({ legacy: 14, outOfScope: 4, planned: 9, skipped: 1 });
  });

  it("imports exactly the in-scope activities with their legacy ids, and only their history, favourites and attachments", async () => {
    const report = await runCalendarImport(await deps(), confirm);
    expect((await cal.db.select({ id: activities.id }).from(activities).orderBy(asc(activities.id))).map((r) => r.id)).toEqual([1001, 1002, 1004, 1005, 1006, 1009, 1010, 1011, 1012]);
    expect([...new Set((await cal.db.select({ a: activityChanges.activityId }).from(activityChanges)).map((r) => r.a))].sort()).toEqual([1001, 1002]);
    expect((await cal.db.select().from(favourites)).map((f) => f.activityId).sort()).toEqual([1001, 1004]);
    expect((await cal.db.select({ id: activityFiles.id }).from(activityFiles)).map((r) => r.id).sort()).toEqual([801, 804]);
    expect(report.toJSON()).toMatchObject({ balanced: true, facts: expect.objectContaining({ releaseLinksOutOfScope: 2, releaseLinksInScope: 1 }) });
    expect(Number((await cal.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM outbox_events`)).rows[0]!.n)).toBe(0);
  });

  it("imports only active or referenced users; no-email users are inactive and keep their activities", async () => {
    await runCalendarImport(await deps(), confirm);
    const legacy = (await core.db.select().from(userLegacyIds)).map((r) => Number(r.legacyId)).sort((a, b) => a - b);
    expect(legacy).toEqual([11, 12, 13, 14, 16, 19, 20, 21, 22]);
    const id16 = (await core.db.select().from(userLegacyIds).where(eq(userLegacyIds.legacyId, "16")))[0]!.userId;
    expect((await core.db.select().from(coreUsers).where(eq(coreUsers.id, id16)))[0]).toMatchObject({ email: null, isActive: false });
    expect((await cal.db.select().from(activities).where(eq(activities.id, 1009)))[0]!.createdBy).toBe(id16);
  });

  it("a re-run changes nothing: every table identical, nothing inserted or updated, no Core event", async () => {
    await runCalendarImport(await deps(), confirm);
    const before = await snapshot();
    const again = (await runCalendarImport(await deps(), confirm)).toJSON();
    expect(await snapshot()).toEqual(before);
    for (const c of Object.values(again.tables)) expect(c.inserted + c.updated).toBe(0);
    expect(again.balanced).toBe(true);
  });

  it("a re-run after Calendar edits reverts nothing, and lists the edited activity", async () => {
    await runCalendarImport(await deps(), confirm);
    await cal.db.update(activities).set({ title: "Edited in the Calendar", version: 2 }).where(eq(activities.id, 1001));
    await cal.db.delete(favourites).where(eq(favourites.activityId, 1001));
    await cal.db.update(savedFilters).set({ name: "Renamed" }).where(eq(savedFilters.id, 701));
    const report = (await runCalendarImport(await deps(), confirm)).toJSON();
    expect((await cal.db.select().from(activities).where(eq(activities.id, 1001)))[0]!.title).toBe("Edited in the Calendar");
    expect(await cal.db.select().from(favourites).where(eq(favourites.activityId, 1001))).toEqual([]);
    expect((await cal.db.select().from(savedFilters).where(eq(savedFilters.id, 701)))[0]!.name).toBe("Renamed");
    expect(report.changedInCalendar).toEqual([1001]);
  });

  it("the report holds no title, email or query text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cal-report-"));
    const reportPath = join(dir, "r.json");
    expect(await runCalendarImportCli({ ...(await deps()), reportPath }, confirm)).toBe(0);
    for (const f of [reportPath, join(dir, "r.txt")]) {
      const text = await readFile(f, "utf8");
      for (const secret of [CONFIDENTIAL_MARKER, "example.test", "sample typed text", "Sample activity"]) expect(text).not.toContain(secret);
    }
  });

  it("an unknown legacy GUID stops the run before any write, naming it; exit 1 with a report", async () => {
    const t = legacyCalendarTables();
    (t.activitySharedWith as object[]).push({ ActivityId: 1001, ValueId: GUID.unknown, IsActive: true });
    const dir = await mkdtemp(join(tmpdir(), "cal-report-"));
    const before = await snapshot();
    expect(await runCalendarImportCli({ ...(await deps(t)), reportPath: join(dir, "r.json") }, confirm)).toBe(1);
    expect(await snapshot()).toEqual(before);
    expect(JSON.parse(await readFile(join(dir, "r.json"), "utf8")).unknownKeys).toEqual([{ kind: "ministry", guid: GUID.unknown.toLowerCase() }]);
  });

  it("keeps legacy's two-space category name, and the Look Ahead still reads it as a speech (Survey 08)", async () => {
    await runCalendarImport(await deps(), confirm);
    const [cat] = await cal.db.select().from(categories).where(eq(categories.id, 16));
    expect(cat!.name).toBe("Sample  speech");
    const r = inferLookAhead({ categoryIds: [16], categoryNames: [cat!.name], contactMinistryAbbreviation: "FIN", isConfidential: false, isIssue: false, isConfirmed: true, commMaterialIds: [], startDate: "2027-01-22", endDate: "2027-01-22", currentSection: null }, TEST_RULES);
    expect(r).toEqual({ kind: "section", section: "events_and_speeches" });
  });

  it("records the counts the legacy survey couldn't", async () => {
    const f = (await runCalendarImport(await deps(), confirm)).toJSON().facts;
    expect(f).toMatchObject({ usersWithoutEmail: 2, usersWithInvalidEmail: 1, duplicateEmailGroups: 1, activityIdMin: 1001, activityIdMax: 1012, awarenessNotDeleted: 1, activitiesWithTwoOrMoreCategories: 1, historyRows: 4, historyRowsMostOnOneActivity: 3 });
  });
});
```

- [ ] **Step 2: Run it** and see it fail because `./run` doesn't exist.

- [ ] **Step 3: Write `run.ts`:**

```ts
import { writeFile } from "node:fs/promises";
import { bcDateSchema, type CalendarRules } from "@gcpe/calendar-contract";
import { withAdvisoryLock, type Db } from "@gcpe/db-kit";
import type { SubscriberConfig } from "@gcpe/events";
import { safeErrorLabel } from "@gcpe/http-kit";
import type { LegacySource } from "@gcpe/legacy-import";
import type { ObjectStore } from "@gcpe/storage";
import { applyCalendarUsers, planCalendarUsers } from "../../../core/src/import/calendar-users";
import { loadLegacyKeys, type LegacyKeys } from "../../../core/src/import/legacy-keys";
import { commContactLabel } from "../activities/history";
import { applyActivities, applyCommContacts, applyLookups, rebaseSequences } from "./apply";
import { applyFavourites, applyFiles, applyHistory, applyProfiles, applySavedFilters } from "./apply-related";
import { mapHistory, type HistoryContext } from "./history-map";
import type { LegacySnapshot } from "./legacy-rows";
import { loadLegacy } from "./load";
import { joinsByActivity, mapActivity, unknownLegacyKeys, userCandidates, validationProblems, type MappedActivity } from "./map";
import { CalendarImportReport } from "./report";
import { selectScope, type Scope } from "./scope";

/** Its own key in the "gcpe" two-int lock space (nrms:import uses 2). */
export const CALENDAR_IMPORT_LOCK = [0x67637065, 3] as const;
/** Stands in for a user the dry run would create: nothing is written, so it never lands anywhere. */
const PLANNED_USER = "00000000-0000-4000-8000-000000000000";

export class ImportAlreadyRunningError extends Error { constructor() { super("another calendar:import is already running"); } }
export class UnknownLegacyKeysError extends Error {
  override name = "UnknownLegacyKeysError";
  constructor(n: number) { super(`${n} legacy key(s) aren't in Core; fix Core first (listed in the report)`); }
}
/** A bad command line: its message is ours, safe to print as it is. */
export class ImportArgumentError extends Error { override name = "ImportArgumentError"; }
export class ImportStageError extends Error {
  constructor(readonly stage: string, readonly report: CalendarImportReport, cause: unknown) {
    const label = safeErrorLabel(cause);
    super(`calendar:import failed during ${stage}: ${label}`);
    report.markFailed(stage, label);
  }
}

export interface CalendarImportDeps { db: Db; coreDb: Db; source: LegacySource; store: ObjectStore; rules: CalendarRules; coreSubscribers: SubscriberConfig[]; log?: (s: string) => void }
export interface CalendarImportOptions { cutoff: string; confirm: boolean }

export function parseImportArgs(argv: string[]): { cutoff: string; confirm: boolean; reportPath?: string } {
  let cutoff: string | undefined;
  let confirm = false;
  let reportPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cutoff") cutoff = argv[++i];
    else if (a === "--confirm") confirm = true;
    else if (a === "--report") reportPath = argv[++i];
    else throw new ImportArgumentError(`Unknown argument: ${a}`);
  }
  if (!cutoff) throw new ImportArgumentError("--cutoff <YYYY-MM-DD> is required: the date activities must end on or after (Q53)");
  if (!bcDateSchema.safeParse(cutoff).success) throw new ImportArgumentError("--cutoff must be a real date, YYYY-MM-DD");
  return reportPath ? { cutoff, confirm, reportPath } : { cutoff, confirm };
}

export function historyContextOf(s: LegacySnapshot, scope: Scope, keys: LegacyKeys, userIdOf: (id: number | null) => string | null, mapped: Map<number, MappedActivity>, timeZone: string): HistoryContext {
  const userName = (id: number | null) => { const u = id === null ? undefined : s.users.find((x) => x.Id === id); return u ? (u.DisplayName ?? u.FullName) : null; };
  return {
    timeZone, userIdOf,
    actorNameOf: userName,
    cityNameOf: (id) => s.lookups.cities.find((c) => c.Id === id)?.Name ?? null,
    commContactLabelOf: (id) => { const c = s.commContacts.find((x) => x.Id === id); return c ? commContactLabel(userName(c.SystemUserId), c.MinistryId ? (keys.org(c.MinistryId)?.abbreviation ?? null) : null) : null; },
    orgNameOf: (g) => keys.org(g)?.displayName ?? null,
    contactMinistryKeyOf: (id) => mapped.get(id)?.values.contactMinistryKey ?? null,
  };
}

function balanceScope(report: CalendarImportReport, s: LegacySnapshot, scope: Scope) {
  report.legacy("activities", s.totals.activities); report.count("activities", "outOfScope", scope.outOfScope.activities);
  report.legacy("users", s.users.length); report.count("users", "outOfScope", s.users.length - scope.userIds.size);
  report.legacy("commContacts", s.commContacts.length); report.count("commContacts", "outOfScope", s.commContacts.length - scope.commContacts.length);
  report.legacy("savedFilters", s.savedFilters.length); report.count("savedFilters", "outOfScope", s.savedFilters.length - scope.savedFilters.length);
  report.legacy("favourites", s.totals.favourites); report.count("favourites", "outOfScope", scope.outOfScope.favourites);
  report.legacy("files", s.totals.files); report.count("files", "outOfScope", scope.outOfScope.files);
  report.legacy("logRows", s.totals.logs); report.count("logRows", "outOfScope", scope.outOfScope.logs);
  report.fact("releaseLinksInScope", scope.outOfScope.releaseLinksInScope);
  report.fact("releaseLinksOutOfScope", scope.outOfScope.releaseLinks);
}

function recordFacts(report: CalendarImportReport, s: LegacySnapshot, scope: Scope, imported: MappedActivity[], invalidEmails: number, duplicateGroups: number, history: { activityId: number; logIds: number[] }[], awarenessIds: readonly number[]) {
  const selectedUsers = s.users.filter((u) => scope.userIds.has(u.Id));
  report.fact("usersWithoutEmail", selectedUsers.filter((u) => (u.EmailAddress ?? "").trim() === "").length + invalidEmails);
  report.fact("usersWithInvalidEmail", invalidEmails);
  report.fact("duplicateEmailGroups", duplicateGroups);
  report.fact("activityIdMin", imported.length ? Math.min(...imported.map((m) => m.id)) : 0);
  report.fact("activityIdMax", imported.length ? Math.max(...imported.map((m) => m.id)) : 0);
  const inactive = new Set(s.users.filter((u) => u.IsActive !== true).map((u) => u.Id));
  report.fact("commContactsOfInactiveUsers", scope.commContacts.filter((c) => inactive.has(c.SystemUserId)).length);
  report.fact("awarenessNotDeleted", imported.filter((m) => m.values.deletedAt === null && m.joins.categoryIds.some((c) => awarenessIds.includes(c))).length);
  report.fact("activitiesWithTwoOrMoreCategories", imported.filter((m) => m.joins.categoryIds.length >= 2).length);
  const perActivity = new Map<number, number>();
  for (const h of history) perActivity.set(h.activityId, (perActivity.get(h.activityId) ?? 0) + h.logIds.length);
  report.fact("historyRows", [...perActivity.values()].reduce((a, b) => a + b, 0));
  report.fact("historyRowsMostOnOneActivity", Math.max(0, ...perActivity.values()));
}

export async function runCalendarImport(deps: CalendarImportDeps, opts: CalendarImportOptions): Promise<CalendarImportReport> {
  const report = new CalendarImportReport(opts.confirm ? "confirmed" : "dry-run", opts.cutoff);
  const scopeOpts = { cutoff: opts.cutoff, awarenessCategoryIds: deps.rules.awarenessCategoryIds };
  const tz = deps.rules.timeZone;
  let stage = "read";
  const body = async () => {
    try {
      const s = await loadLegacy(deps.source, scopeOpts);
      const scope = selectScope(s, scopeOpts);
      balanceScope(report, s, scope);
      stage = "keys";
      const keys = await loadLegacyKeys(deps.coreDb);
      const unknown = unknownLegacyKeys(s, scope, keys);
      if (unknown.length) { report.unknownKeys(unknown); throw new UnknownLegacyKeysError(unknown.length); }
      stage = "users";
      const plan = await planCalendarUsers(deps.coreDb, userCandidates(s, scope, keys));
      const duplicateGroups = plan.groups.filter((g) => g.legacyIds.length > 1).length;
      for (const g of plan.groups) if (g.legacyIds.length > 1) report.note(`legacy users ${g.legacyIds.join(", ")} share an email and map to one Core user`);
      for (const id of plan.invalidEmails) report.note(`legacy user ${id}'s email isn't valid; imported with none (inactive)`);
      const joins = joinsByActivity(scope);
      const keywordName = (id: number) => s.lookups.keywords.find((k) => k.Id === id)?.Name ?? "";

      if (!opts.confirm) {
        report.count("users", "planned", scope.userIds.size);
        const userIdOf = (id: number | null) => { if (id === null || !scope.userIds.has(id)) return null; return plan.groups.find((g) => g.legacyIds.includes(id))?.existingUserId ?? PLANNED_USER; };
        const mapped = scope.activities.map((a) => mapActivity(a, joins.get(a.Id)!, { timeZone: tz, userIdOf, commContactIdOf: (id) => id, keys }));
        const ok = mapped.filter((m): m is MappedActivity => !("skip" in m));
        for (const m of mapped) if ("skip" in m) report.skip("activities", String(m.id), m.skip);
        for (const m of ok) report.warn(m.id, validationProblems(m, m.joins.keywordIds.map(keywordName), deps.rules));
        report.count("activities", "planned", ok.length);
        for (const t of ["commContacts", "savedFilters", "favourites", "files", "logRows"] as const) {
          const n = { commContacts: scope.commContacts.length, savedFilters: scope.savedFilters.length, favourites: scope.favourites.length, files: scope.files.length, logRows: scope.logs.length }[t];
          report.count(t, "planned", n);
        }
        const h = mapHistory(scope.logs, historyContextOf(s, scope, keys, userIdOf, new Map(ok.map((m) => [m.id, m])), tz));
        recordFacts(report, s, scope, ok, plan.invalidEmails.length, duplicateGroups, h.entries, deps.rules.awarenessCategoryIds);
        return report;
      }

      const users = await applyCalendarUsers(deps.coreDb, plan, deps.coreSubscribers);
      report.count("users", "inserted", plan.groups.filter((g) => g.how === "new").reduce((n, g) => n + g.legacyIds.length, 0));
      report.count("users", "updated", plan.groups.filter((g) => g.how === "email").reduce((n, g) => n + g.legacyIds.length, 0));
      report.count("users", "unchanged", plan.groups.filter((g) => g.how === "legacy-id").reduce((n, g) => n + g.legacyIds.length, 0));
      const userIdOf = (id: number | null) => (id === null ? null : (users.userIdOf.get(id) ?? null));
      stage = "lookups"; await applyLookups(deps.db, s, report);
      stage = "commContacts"; const remap = await applyCommContacts(deps.db, scope, (id) => userIdOf(id), keys, report);
      stage = "activities";
      const mapped = scope.activities.map((a) => mapActivity(a, joins.get(a.Id)!, { timeZone: tz, userIdOf, commContactIdOf: (id) => (id === null ? null : (remap.get(id) ?? null)), keys }));
      for (const m of mapped) if ("skip" in m) report.skip("activities", String(m.id), m.skip);
      const ok = mapped.filter((m): m is MappedActivity => !("skip" in m));
      for (const m of ok) report.warn(m.id, validationProblems(m, m.joins.keywordIds.map(keywordName), deps.rules));
      const { inserted, present } = await applyActivities(deps.db, ok, report);
      stage = "favourites"; await applyFavourites(deps.db, scope, (id) => userIdOf(id), inserted, report);
      stage = "profiles"; await applyProfiles(deps.db, s, users.groups, report);
      stage = "savedFilters"; await applySavedFilters(deps.db, scope, (id) => userIdOf(id), keys, report);
      stage = "files"; await applyFiles(deps.db, deps.store, scope, (id) => userIdOf(id), present, tz, report);
      stage = "history";
      const h = mapHistory(scope.logs, historyContextOf(s, scope, keys, userIdOf, new Map(ok.map((m) => [m.id, m])), tz));
      await applyHistory(deps.db, h.entries, h.skipped, present, report);
      stage = "sequences"; await rebaseSequences(deps.db);
      recordFacts(report, s, scope, ok, plan.invalidEmails.length, duplicateGroups, h.entries, deps.rules.awarenessCategoryIds);
      return report;
    } catch (e) {
      // Unknown keys included: stage is "keys", the report already lists them, and the CLI writes it.
      throw new ImportStageError(stage, report, e);
    }
  };
  return opts.confirm ? withAdvisoryLock(deps.db, CALENDAR_IMPORT_LOCK, () => new ImportAlreadyRunningError(), body) : body();
}

const textPath = (p: string) => (p.endsWith(".json") ? `${p.slice(0, -5)}.txt` : `${p}.txt`);
export function defaultReportPath(now = new Date()): string {
  return `calendar-import-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.json`;
}
async function writeReport(report: CalendarImportReport, path: string) {
  await writeFile(path, JSON.stringify(report.toJSON(), null, 2));
  await writeFile(textPath(path), report.toText());
}

/** Runs, writes the report (a partial one on failure), and returns 0 balanced, 2 not balanced, 1 on any error. */
export async function runCalendarImportCli(deps: CalendarImportDeps & { reportPath: string }, opts: CalendarImportOptions): Promise<0 | 1 | 2> {
  const log = deps.log ?? (() => {});
  try {
    const report = await runCalendarImport(deps, opts);
    await writeReport(report, deps.reportPath);
    log(report.toText());
    return report.balanced() ? 0 : 2;
  } catch (e) {
    const report = e instanceof ImportStageError ? e.report : null;
    if (report) await writeReport(report, deps.reportPath);
    log(e instanceof Error ? e.message : safeErrorLabel(e));
    return 1;
  }
}
```

Every failure inside the run, the unknown-key stop included, arrives as `ImportStageError` carrying the partial report, so `runCalendarImportCli` always writes one. Its message is "calendar:import failed during <stage>: <label>". `safeErrorLabel` gives a driver code or the error's name, never its message, so no GUID or legacy value reaches the console. The GUIDs are in the report only.

- [ ] **Step 4: Write `cli.ts`:**

```ts
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { assertTimeZoneRules, loadTenantConfig, parseEnv } from "@gcpe/config";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { parseSubscribers, subscribersFor } from "@gcpe/events";
import { safeErrorLabel } from "@gcpe/http-kit";
import { createMssqlSource } from "@gcpe/legacy-import";
import { localStore } from "@gcpe/storage";
import { rulesFromTenant } from "../rules";
import { defaultReportPath, ImportArgumentError, parseImportArgs, runCalendarImportCli } from "./run";

const env = parseEnv(z.object({
  DATABASE_URL: z.string().url(),
  CORE_DATABASE_URL: z.string().url(),
  CALENDAR_STORAGE_DIR: z.string().min(1),
  LEGACY_SQL_SERVER: z.string().min(1),
  LEGACY_SQL_DATABASE: z.string().default("Gcpe.Hub"),
  LEGACY_SQL_USER: z.string().min(1),
  LEGACY_SQL_PASSWORD: z.string().min(1),
  LEGACY_SQL_TRUST_CERT: z.enum(["true", "false"]).default("false"),
  TENANT_CONFIG: z.string().default(fileURLToPath(new URL("../../../../config/tenants/bc.json", import.meta.url))),
  // Names and types only: the running stack delivers Core's user.upserted by subscriber name.
  CORE_EVENT_SUBSCRIBERS: z.string().optional(),
}));

try {
  const args = parseImportArgs(process.argv.slice(2));
  const tenant = loadTenantConfig(env.TENANT_CONFIG);
  assertTimeZoneRules(tenant);
  const coreSubscribers = parseSubscribers(env.CORE_EVENT_SUBSCRIBERS);
  const names = subscribersFor("user.upserted", coreSubscribers).map((s) => s.name);
  console.log(`user.upserted goes to: ${names.length ? names.join(", ") : "(no subscriber; run Core's republish after the import)"}`);
  const { db, pool } = createDb(env.DATABASE_URL);
  const { db: coreDb, pool: corePool } = createDb(env.CORE_DATABASE_URL);
  await runMigrations(db, fileURLToPath(new URL("../../migrations", import.meta.url)));
  const source = await createMssqlSource({ server: env.LEGACY_SQL_SERVER, database: env.LEGACY_SQL_DATABASE, user: env.LEGACY_SQL_USER, password: env.LEGACY_SQL_PASSWORD, trustServerCertificate: env.LEGACY_SQL_TRUST_CERT === "true" });
  try {
    process.exitCode = await runCalendarImportCli(
      { db, coreDb, source, store: localStore(env.CALENDAR_STORAGE_DIR), rules: rulesFromTenant(tenant), coreSubscribers, reportPath: args.reportPath ?? defaultReportPath(), log: console.log },
      { cutoff: args.cutoff, confirm: args.confirm },
    );
    if (!args.confirm) console.log("Dry run: nothing written. Re-run with --confirm to import.");
  } finally {
    await source.close();
    await pool.end();
    await corePool.end();
  }
} catch (e) {
  console.error(e instanceof ImportArgumentError ? e.message : safeErrorLabel(e));
  process.exitCode = 1;
}
```

- [ ] **Step 5: Add the scripts.** In `apps/calendar/package.json`, add `"import:legacy": "tsx src/import/cli.ts"`. In the root `package.json`, add `"calendar:import": "npm --workspace @gcpe/calendar run import:legacy --"` beside `calendar:replay-to-nrms`.

- [ ] **Step 6: Run the acceptance test and see it pass.** Then run the whole Calendar and Core suites, `apps/calendar` and `apps/core`, to catch fallout from the migration. Run the type-check. Check that no server file imports `src/import`: `grep -rn "import/" apps/calendar/src --include=*.ts | grep -v "src/import/"` should list nothing from `start.ts`, `app.ts` or `http/`.

- [ ] **Step 7: Commit.**

```bash
git add apps/calendar/src/import/run.ts apps/calendar/src/import/cli.ts apps/calendar/src/import/run.test.ts apps/calendar/package.json package.json
git commit -m "feat(calendar): calendar:import CLI: dry run by default, --confirm to import, a balanced report, re-runs change nothing"
```

---

### Task 7: Runbook, parity rows, questions, running notes and carry-forward

**Risk:** low-risk (shared review).

**Files:**
- Modify: `docs/deploy/siteground.md`, `docs/parity/changes-from-legacy.md`, `docs/parity/open-questions.md`, `docs/manuals/running-notes.md`, `docs/superpowers/plans/phase-5-carry-forward.md`

- [ ] **Step 1: Write the runbook section.** Add "## Importing legacy Calendar data (Phase 5i)" to `docs/deploy/siteground.md`, after "Importing legacy NoD data (Phase 4i)". It says:
  - **What it needs:** the same networking caveat and env as `nrms:import`, plus `CALENDAR_STORAGE_DIR` and the optional `CORE_EVENT_SUBSCRIBERS` (names and types only, as the replay CLIs use, with `"types":["user.upserted"]` for `calendar` and `nrms`).
  - **Prerequisite:** Core's reference import first. An unknown legacy ministry, sector, theme or tag GUID stops the run, listed in the report.
  - **Running it:**

    ```sh
    DATABASE_URL=... CORE_DATABASE_URL=... CALENDAR_STORAGE_DIR=... LEGACY_SQL_SERVER=... LEGACY_SQL_USER=... LEGACY_SQL_PASSWORD=... \
    CORE_EVENT_SUBSCRIBERS='[{"name":"calendar","url":"https://import-cli.example.test/unused","secret":"unused-by-cli-000000000000000000000000","types":["user.upserted"]},{"name":"nrms","url":"https://import-cli.example.test/unused","secret":"unused-by-cli-000000000000000000000000","types":["user.upserted"]}]' \
      npm run calendar:import -- --cutoff <YYYY-MM-DD> --report calendar-import.json
    ```

    That is a dry run. Read the report, then run it again with `--confirm`. The cutoff has no default (Q53). At a 2026-11-01 cutoff, Survey 08 estimates about 6,700 activities.
  - **What a re-run does:** I3, in plain words. Do test imports into an empty Calendar database, because a Calendar activity created between runs can take an id a newer legacy activity needs.
  - **Reading the report:** what each column means, the balance rule, the lists, the facts, and the exit codes 0, 2 and 1.
  - **After a confirmed import, in this order:**
    1. If `CORE_EVENT_SUBSCRIBERS` wasn't set, run Core's republish (`POST /core/api/admin/republish`).
    2. Run `npm run calendar:replay-to-nrms` (dry run), then `-- --confirm`, then a tick.
    3. Run `npm run nrms:replay-activity-links` (dry run), then `-- --confirm`, then a tick. Its "name an activity NRMS doesn't hold" count is the number of releases linked to activities that weren't imported (C158). Compare it with the report's `releaseLinksOutOfScope` fact.

    Point to "NRMS link and Forecast (Phase 5h)" for their `EVENT_SUBSCRIBERS`.
  - **R14 (Phase 7):** legacy stays readable for one HQ administrator for a year. It is the only place to see activities outside the import.

- [ ] **Step 2: Update `docs/parity/changes-from-legacy.md`.** In "Corporate Calendar (Phase 5)":
  - Add the spec's missing rows verbatim from §14: C131, C134, C137, C140, C144, C152, C155 and C157 (check each isn't already present). Give C134, C137, C144 and C157 the status "Built (5i importer)". Leave the others' status as the spec has it.
  - Add the new rows:
    - **C195:** a re-run of the import never overwrites the Calendar. Activities follow the version guard; every other row is copied the first time only (I3).
    - **C196:** a matched Core user's existing access and active flag stand. Calendar access is added only when the user has none, and a role-less placeholder is activated when legacy says active (I4).
    - **C197:** an activity with a year outside 1900–2199 isn't imported, and is reported (I6).
    - **C198:** a legacy log entry's contact ministry is the activity's current one, and its dates keep legacy's text (I7).
    - **C199:** the import report names users by id and never holds emails, titles or saved-query values (I9).
  - Run `grep -o "^| C[0-9]*" docs/parity/changes-from-legacy.md | sort | uniq -d` and see that it prints nothing.

- [ ] **Step 3: Update `docs/parity/open-questions.md`.**
  - Add Q50, Q52 and Q53 from §15 verbatim, with Survey 08's notes, under "Open".
  - Q53 gains: "The importer requires `--cutoff`; nothing defaults it."
  - Q50 gains: "The importer half (5i) is built; the parity check waits for this."
  - Add the new questions:
    - **Q68:** should an activity that ends before it starts follow the spec's literal rule, its end alone? Working assumption: either date on or after the cutoff brings it in (I1).
    - **Q69:** for legacy users sharing an email, whose role and ministries should the one Core user get? Working assumption: the active row last updated (I4).
  - Check for duplicates the same way as the change rows.

- [ ] **Step 4: Add running notes.** Add "## Phase 5i — Legacy Calendar import" to `docs/manuals/running-notes.md`, with role-tagged lines:
  - **Operations:** what the command does. Dry run first. `--cutoff` is required. The report and the exit codes. The order of the follow-up commands. A re-run never overwrites Calendar changes.
  - **Operations:** an unknown legacy ministry, sector, theme or tag stops the import before it writes anything; fix Core first.
  - **All Calendar users:** activities ending before the cutoff aren't in the new Calendar, except awareness dates. Their history, favourites and files stay in legacy, which one HQ administrator can read for a year after cutover (R14).
  - **System Administrator:** legacy users without an email come in inactive. Link them on the Calendar users screen to activate them. Legacy users who shared an email are one user.
  - **All Calendar users:** "View changes" on an imported activity shows legacy's recorded changes (title, dates, city, contact, lead ministry, confirmation), marked "from legacy log".
  - **Developer:** where the import code lives, the fake-source fixture, and that the scope rule runs both in SQL and in `selectScope`.

- [ ] **Step 5: Rewrite the carry-forward.** In `docs/superpowers/plans/phase-5-carry-forward.md`, rewrite "## 5i":
  - Remove every item this plan took, as listed in "Carry-forward items taken".
  - Keep the report-parity item, under a new heading "## 5i parity check", and add: "The import report's `cutoff` is the earliest `--from` the check may use."
  - Keep the orphan-bytes sweeper under "Platform hardening".
  - Note that `UNK` matches nothing (the tenant setting stays) and that query 8.20 still needs re-running for the parity half.

- [ ] **Step 6: Run the checks.**
  - Run the full suite once: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run`. See it pass.
  - Run the type-check.
  - Run `git grep -n "Task [0-9]\|I[0-9]\+\b" -- apps/calendar/src/import apps/core/src/import` and see that it finds no labels in code.

- [ ] **Step 7: Commit.**

```bash
git add docs/deploy/siteground.md docs/parity/changes-from-legacy.md docs/parity/open-questions.md docs/manuals/running-notes.md docs/superpowers/plans/phase-5-carry-forward.md
git commit -m "docs: legacy Calendar import runbook, parity rows C195-C199, Q68-Q69, running notes and carry-forward"
```

---

## Phase 5i (importer) at a glance

| Task | Delivers | Risk tag |
|---|---|---|
| 1 | Legacy reads, scope rule, fixture | data-integrity |
| 2 | Mapping: activities, lookups, users, GUID check, validation, history | data-integrity, confidentiality |
| 3 | Core users: match, create, duplicates, no-email, access | confidentiality, data-integrity |
| 4 | Migration, report, lookups, contacts, activities, sequences | data-integrity, irreversible |
| 5 | Favourites, profiles, saved filters, attachments, history | confidentiality, data-integrity |
| 6 | Run, CLI, dry run, acceptance 15 | data-integrity |
| 7 | Runbook, parity, notes, carry-forward | low-risk |

## Risks and things to watch

- **The fake source ignores SQL,** so the SQL scope filter is checked only by `queries.test.ts`'s string checks. The TypeScript rule is the guard, and it runs on everything the SQL returns. On the first real dry run, compare the report's `activities.legacy − outOfScope` with Survey 08's count for the same cutoff (about 6,700 at 2026-11-01).
- **BC's permanent UTC−7 from 2026-11-01:** `wallClockToInstant` uses Node's tzdata, so Node 24 with tzdata 2026b or later is needed (Q64 covers Postgres's). Tests compare with `wallClockToInstant` rather than literal instants, so they hold either way. A real import must run on Node 24.
- **Core events:** if `CORE_EVENT_SUBSCRIBERS` is wrong, the Calendar's user projection stays empty until a republish. The CLI prints the matching subscribers before it runs.
- **Memory:** the in-scope set, about 6,700 activities with their log rows, plus all users and lookups, fits easily. `Log` is narrowed in SQL. The whole-table counts are `COUNT(*)` queries.

## Self-review (done while writing)

- **Spec coverage:**
  - §12.1 is all covered, in this order: scope (T1); reading (T1); the user rules (T1 selection, T3 apply); lookups and comm contacts (T4); activities (T2, T4); joins with the GUID stop (T2, T4, T6); favourites, profiles and saved filters (T5); attachments with MD5 (T5); history (T2, T5); sequences (T4); not imported (I14); no outbox (T6 test); replay instructions (T7); re-run (T4, T6); the report (T4, T6).
  - The §12.2 fixture list is all in T1.
  - Acceptance 15 is T6. §16's scope-rule unit tests are T1, and the upsert and re-run tests T4 and T6.
- **Placeholders:** `apply.test.ts` asks the implementer to copy the in-memory `keys` from `map.test.ts` in full, and `apply-related.test.ts` to copy Task 4's test helpers. Both are named and come from earlier tasks.
- **Type consistency:**
  - `userIdOf` takes `number | null` in the map and history contexts, and `number` in the apply helpers; the run adapts between them.
  - `applyActivities` returns `{ inserted, present }`, which Task 5 consumes.
  - `CalendarUsersResult.groups[].representativeLegacyId` is used by `applyProfiles`.
  - `LegacyKeys.org(guid)` returns `{ id, key, displayName, abbreviation }` everywhere.
- **Review Focus:** all five lines have tests (T1, T6, T2, T5, T6).
