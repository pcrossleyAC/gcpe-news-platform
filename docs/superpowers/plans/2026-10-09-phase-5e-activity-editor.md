# Phase 5e-1: The Activity Editor's API, Storage and Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the activity editor everything it needs from the server: the browser's share of the activity rules, every lookup the form offers, an activity view that carries its files, watchers, release links and ministry abbreviation, and attachments (Records) that are uploaded, replaced, removed and downloaded only by the people the visibility rule and the capability table allow, stored under `CALENDAR_STORAGE_DIR` outside every public folder.

**Architecture:**
- **Two plans.** 5e is fourteen right-sized tasks, so it is split. **This plan (5e-1) comes first**: server, contract and storage only, seven tasks. `docs/superpowers/plans/2026-10-09-phase-5e2-activity-editor-screen.md` (5e-2) builds the staff-web screens and the end-to-end tests on top of it.
- **The browser runs the same rules as the server.** `GET /calendar/api/config` gains `rules` (the slice of `CalendarRules` that `checkActivity`, `inferLookAhead` and the Release fieldset read) and `editor` (what this user may do). `GET /calendar/api/editor-options` lists every lookup row with its active flag, so the form can offer active rows plus whatever inactive value an activity already holds, as legacy's dropdowns did.
- **Attachments are their own writes.** `POST /activities/:id/files?name=…` (raw body), `DELETE /activities/:id/files/:fileId` and `GET /activities/:id/files/:fileId`. A router mounted before the JSON parser checks visibility, edit rights, deletion, the freeze and other users' locks *before* reading a byte; the transaction re-checks them under the activity's lock. Bytes go to the object store first and are deleted again if the transaction fails. Downloads are authorised by `visibleSql` inside `inReadSnapshot`, so another ministry's confidential file is a 404.
- **File types are checked by content.** `packages/storage` gains an attachment allowlist: each extension maps to one served content type and one magic-byte family; legacy's extension blocklist is kept on top. The served type always comes from that table, never from the uploader.

**Tech Stack:** Node 24, Express 5, Drizzle on Postgres, zod, Vitest 4.1 with supertest, `@gcpe/storage`'s `localStore`.

**Spec:** `docs/superpowers/specs/2026-10-07-calendar-parity-design.md`:
- §3 row 5e (exit: attachment authorisation tests, another ministry's confidential file gives 404);
- §5.1 (attachments under `CALENDAR_STORAGE_DIR`, outside the deploy folder, never under a public path), §5.2 (`activity_files`);
- §6 (one visibility rule; not visible is 404; "Edit, clone, add or remove attachments");
- §7.2 (the rules the browser will run), §7.4 (adding or removing an attachment is a content write), §7.5 (another user's live lock refuses a write), §7.6 (Look Ahead inference in a shared module);
- §8.2 (the editor's fieldsets, the Release fieldset hidden for some categories, "BC Gov News"), §8.3 (View changes), §8.4 (attachments);
- §11 (release links on the activity), §13 (attachments: 12 files, 2.0 MB, largest 0.58 MB), §14 (C138, C153), §16 (acceptance 2 and 11).

The plan also takes these into account:
- `docs/superpowers/plans/phase-5-carry-forward.md` § 5e. This plan takes the server items; 5e-2 takes the rest and deletes the section.
- The 5c and 5d plans (`2026-10-08-phase-5c-activity-api.md`, `2026-10-08-phase-5c2-transfer-and-dead-letters.md`, `2026-10-08-phase-5d-list-screen.md`, `2026-10-08-phase-5d2-list-screen-ui.md`) for house style. Their decisions hold; this plan adds E1–E13, 5e-2 adds E14–E26.

**Order:** Tasks 1–7 in order. Tasks 1–3 are independent of 4–5; Task 6 needs 3, 4 and 5; Task 7 needs 6.

**Base:**
- **Branch:** `feat/phase-5e` in `/Users/paul/gcpe-news-platform-p5e`, stacked on `feat/phase-5d` at `a12b8f7` (5a, 5b, 5c, 5d-1 and most of 5d-2). 5d-2's last fix wave will be rebased in underneath; nothing here edits a file that wave is expected to touch except `docs/parity/*`, `docs/manuals/running-notes.md` and the carry-forward, where the rows are appended. Every path is repo-relative.
- **Facts this plan relies on (verified by reading the code at `a12b8f7`):**
  - `apps/calendar/src/app.ts` mounts `/api` as `requireBearer`, `requireCalendarActor`, `express.json({ limit: "100kb" })`, `apiRoutes(...)`. `requireCalendarActor` refuses every bearer token (`via` must be `"session"`).
  - `ApiDeps` (`apps/calendar/src/http/routes.ts`) is `{ db, rules, subscribers, now? }`. `createTestApp(db, over: Partial<AppDeps>)` (`apps/calendar/test/helpers.ts`) builds the app with `TEST_RULES` and `FIXED_NOW` (11:00 BC on 2026-11-03).
  - `activity_files` exists (`apps/calendar/src/db/schema.ts`): `id` identity, `activity_id` (no cascade, on purpose), `file_name`, `content_type`, `length`, `sha256`, `storage_key`, `uploaded_at`, `uploaded_by`, and a **case-sensitive** unique index on `(activity_id, file_name)`. No migration is needed.
  - `release_links` exists and is empty until 5h fills it from `release.status_changed`.
  - `readActivity`/`viewOf` (`apps/calendar/src/activities/view.ts`) run in `inReadSnapshot` and load the row through `loadStored(..., { visibleTo })`, which filters with `visibleSql`.
  - `sendActivityError` (`apps/calendar/src/http/errors.ts`) maps `ActivityNotFoundError` → 404, `ActivityForbiddenError` → 403, `FreezeError` → 423 `{ code: "freeze" }`, `ActivityLockedError` → 423 `{ code: "locked" | "locked_elsewhere", holder }`, `VersionConflictError` → 409, `ActivityDeletedError` → 409 `{ code: "deleted" }`, `ActivityValidationError` → 422 `{ error, errors: FieldError[] }`.
  - `HISTORY_FIELDS` (`packages/calendar-contract/src/view.ts`) is the closed set of history keys; `displayOf` (`apps/calendar/src/activities/history.ts`) returns a value for every key.
  - `@gcpe/storage` exports `localStore(root, publicPrefix?)`, `randomFileKey(prefix, original)` (`<prefix>/<16 hex>-<safeFileName>`), `assertSafeKey`, `sniff` (PDF, PNG, JPEG only). NRMS's `STORAGE_DIR` defaults to `<DATA_DIR>/storage` and the stack serves it publicly at `/files` (`apps/stack/src/stack.ts`, `envFor` in `apps/stack/src/env.ts`).
  - The tenant's calendar section is a strict zod object (`packages/config/src/calendar.ts`); `TEST_RULES` is the only other full `CalendarRules` literal.
  - Legacy: `SaveDocuments` (`Activity.aspx.cs:1274-1437`) refused an empty file and any name ending in a blocklisted extension, kept `Path.GetFileName`, replaced a same-name file comparing `ToLower()`, and stored the browser's `ContentType`. `ActivityFile.ashx.cs:11-26` served any file by id with no check (C138). The Release fieldset is hidden for eight category names (`Scripts/activityhelper.ts:170-196`), which also clears the release time.

---

## Decisions made in planning

Each says why and what it costs if wrong. Paul is asleep and authorised overnight work; nothing here waits on him. Task 7 writes the parity rows.

- **E1. 5e is split in two; 5e-1 (this plan) comes first.** *Why:* fourteen tasks, and every 5e-2 screen task consumes this plan's routes. *If wrong:* nothing; the order is forced by the dependency anyway.
- **E2. Attachments are saved on their own, the moment a file is picked or removed, one file per request; not as part of Save.** Legacy posted files with the form. *Why:* the activity API's bodies are strict JSON, and a 25 MB file inside a JSON save would make every save heavy and every failure lose the upload. *Cost if wrong:* a user who cancels the editor has still added the file; the Records list says so and Remove undoes it. C180 (Proposed).
- **E3. Adding, replacing or removing a file writes history (key `files`, label "Records") but does not bump `version`, touch "last updated", raise a needs-review flag or emit `activity.*`.** It does obey the freeze, edit rights, deletion and another user's live lock, as every content write does. *Why:* files are their own rows; bumping the version would make the uploader's own open editor 409 on its next save. Legacy raised no flag for files (§7.3). NRMS's `activity.*` payload has no files. *Cost if wrong:* another user's open editor doesn't learn of a new file until it reloads; no field data is lost. Part of C180.
- **E4. File types: an allowlist checked by content, plus legacy's blocklist.** `pdf`, `png`, `jpg`/`jpeg`, `gif`, `doc`, `docx`, `xls`, `xlsx`, `ppt`, `pptx`, `msg`, `rtf`, `txt`, `csv`. Each extension must match its magic bytes (OOXML: a ZIP holding `[Content_Types].xml`; legacy Office and Outlook: the OLE header; text: no NUL byte). The served `Content-Type` comes from this table. *Why:* the spec asks for content checked against the claimed type, and legacy's blocklist alone would accept `.html` and `.svg`. *Cost if wrong:* staff can't attach some other type they used to (legacy holds 12 files; their types aren't surveyed). Imported files of other types still download, as `application/octet-stream`. C179 and Q59 (Proposed).
- **E5. At most 50 files per activity, 25 MiB each** (C153's 25 MB, counted as NRMS counts it). *Why:* bound the disk an activity can fill. *Cost if wrong:* an activity with more than 50 records needs old ones removed first; legacy's largest activity is far below.
- **E6. Same-name replace compares names case-insensitively** (legacy's `ToLower()`), under the activity's advisory lock, deleting the old row before inserting the new one; the new upload's spelling is kept. The replaced bytes are deleted after the commit. *Cost if wrong:* none known.
- **E7. The server does not enforce `ShowRecordsSection`.** It is a display switch, as legacy's was; legacy's server saved any posted file. *Why:* BC has it off, and the end-to-end tests attach files through the API to make the section appear. *Cost if wrong:* a direct API caller with edit rights can attach to an activity whose Records section is hidden; the section then shows, as it does for any activity with files.
- **E8. `CALENDAR_STORAGE_DIR` defaults to `<DATA_DIR>/calendar-files` in the stack** (`data/calendar-files` when the Calendar runs alone). The stack refuses to start, and `--check` fails, when it is inside, equal to or contains NRMS's `/files` folder, the site output or the staff-web build. *Cost if wrong:* an operator who wanted the files under one of those folders must pick another.
- **E9. Download headers:** `Content-Disposition: attachment` with Express's RFC 6266 encoding (`filename` plus `filename*=UTF-8''…`), `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`, `Content-Security-Policy: default-src 'none'; sandbox`. A stored file whose bytes are missing is a 404 and one log line (label and route, never the key, which carries the file name).
- **E10. Stored names:** the last segment of what the browser sends (both `/` and `\` split, as `Path.GetFileName`), control characters replaced by a space, at most 255 characters keeping the extension. The storage key is `activities/<id>/<16 hex>-<safeFileName>`: no character of it comes from the user except through `safeFileName`'s `[a-z0-9._-]` flattening.
- **E11. The activity view gains `ministryAbbreviation`, `watch` (`isWatched`, `watcherNames`), `files` and `releases`.** Releases leave out `deleted` ones and carry no headline: type, status, reference and dates only (§11 "type colour, document type, status and its date"). *Cost if wrong:* a headline is a one-line addition.
- **E12. `GET /calendar/api/editor-options` sends every lookup row (active flag included), every ministry and term, and every comm contact** (name, rank, ministry, active). The browser offers active rows plus the activity's current value. *Why:* one call, and a read-only viewer of a shared activity still needs the current comm contact's name. Comm contacts' names and ranks are already shown on every visible list row; no activity text is in it. *Cost if wrong:* about 200 KB at legacy volumes; it can be scoped later.
- **E13. A new tenant setting, `releaseHiddenCategoryNames`**, holds legacy's eight names, so no category name is written into a rule. `/config`'s `rules` also carries the inference's settings and the exclusion lists the form needs.

## Carry-forward items taken

From `docs/superpowers/plans/phase-5-carry-forward.md` § 5e. 5e-2 takes the rest and deletes the section.

| Item | Where |
|---|---|
| `CALENDAR_STORAGE_DIR` for attachments, outside the deploy folder (§5.1, §8.4) | Task 5 (E8) |
| Attachments are content writes: `assertNotFrozen` and `can.edit` (§7.4, §8.4) | Task 6 |
| The editor runs `checkActivity` and `inferLookAhead` itself (the server half: the rules it needs) | Task 1 |
| The activity page's watchlist star shows the watchers' names (the server half: the view carries them) | Task 3 |

## Global Constraints

- **Worktree and commits:**
  - Work on `feat/phase-5e` in `/Users/paul/gcpe-news-platform-p5e`. Commit locally after each task.
  - **Never add `Co-Authored-By` or any AI attribution** to a commit. Never commit `CLAUDE.md`.
  - **No task, decision or round labels in code comments** ("Task 3", "E4", "fix round 1"). Spec row ids (C138, Q59) and legacy file references are fine.
- **Node 24 for everything:**
  - Tests: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run <paths>`.
  - Type-checks: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json` and `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p apps/staff-web/tsconfig.json`.
  - E2E: `npx -y -p node@24 -- npm run test:e2e`.
  - Show each new test failing before implementing it (a real RED run).
- **Core keys are byte-exact; user ids are canonical.** Ministry keys are compared as stored, never case-folded.
- **Bearer tokens get no Calendar access.** Every new route sits behind `requireBearer` and `requireCalendarActor`.
- **Reads use `visibleSql` inside `inReadSnapshot`.** The download and the activity view never load a row and filter it in memory afterwards. Not visible is 404, never 403.
- **No input produces a 500.** Strings through `safeString`, ids bounded to 9 digits (`idOf`), class 22 is 400, class 23 is 409.
- **Logs:** `safeErrorLabel` plus the route only; no debug logging; never a file name, storage key or activity text.
- **Privacy:** `example.test` addresses, fictional GUIDs and fictional names only. No legacy data is copied.
- **Migrations:** drizzle-kit only. This plan adds none.
- **Confidential text never leaves the Calendar.** No new event carries activity or file data.
- **Attachments:**
  - authorise every download with `visible()` (as `visibleSql`) plus the activity's confidentiality;
  - another ministry's confidential file returns 404;
  - store outside the web root (`CALENDAR_STORAGE_DIR`, never under `/files`, `/site` or `/hub`);
  - no user-supplied path segments in a storage key;
  - content-type and size limits (E4, E5);
  - `Content-Disposition: attachment` with a safe filename;
  - `X-Content-Type-Options: nosniff`.
- **UI tasks run the affected e2e specs; the full e2e suite stays green; seeded users use minted sessions.** This plan changes no screen, but Task 1 changes `/config` and Task 3 the activity view, which staff-web reads: run `calendar-list.spec.ts` and `axe-sweep.spec.ts` after Task 3, and the full suite after Task 7.

## Review Focus

1. **A file name built to escape or to inject:** `..\..\sample.pdf`, `a/b/sample.pdf`, `"; filename=x.pdf`, a CR/LF in the name, a 400-character name, a name that is only `.pdf`, or accented letters. Expected: the stored name is the last segment with control characters gone and at most 255 characters; the storage key is flat; the download header is well-formed with no raw quote or line break; an empty name is a 422. Pinned in Task 6 ("keeps only the file's own name") and Task 7 ("a name with quotes and accents gives a safe header").
2. **A file whose name and contents disagree:** HTML renamed `.pdf`, an executable renamed `.docx`, a ZIP that isn't an Office file, a text file holding NUL bytes. Expected: 422 with a message naming the problem, nothing stored, and never served as HTML. Pinned in Task 4 (the check, row by row) and Task 6 ("refuses … contents that don't match the name").
3. **A double click: two uploads of the same name at once.** Expected: both succeed, one row remains, the other's bytes are deleted, no 500 from the unique index. Pinned in Task 6 ("two uploads of one name at once").
4. **A download link kept after the activity changed:** the activity is made confidential or deleted after the page loaded, or a file id from another activity is pasted under this one. Expected: 404 for whoever can no longer see it; 404 for the mismatched id. Pinned in Task 7 ("a link kept after the activity became confidential", "a file id from another activity").
5. **An upload the server must refuse without reading it:** to an activity the caller can't see, can only view, that is deleted, during the freeze, or while someone else holds the lock, including a body over 25 MB. Expected: 404, 403, 409, 423 or 423 before the body is read (an oversized body to an invisible activity is a 404, not a 413). Pinned in Task 6 ("refused before the body is read").

---

## File structure

| File | Responsibility |
|---|---|
| `packages/config/src/calendar.ts` (+ test), `config/tenants/bc.json` | The `releaseHiddenCategoryNames` tenant setting |
| `packages/calendar-contract/src/rules.ts`, `src/editor.ts` (+ `editor.test.ts`), `src/view.ts`, `src/index.ts` | `EditorRules`, `editorRulesOf`, `releaseFieldsetHidden`, `EditorOptions`, attachment limits; the view's new parts; the `files` history key |
| `apps/calendar/test/helpers.ts` | `TEST_RULES` gains the new setting |
| `apps/calendar/src/http/config-routes.ts` (+ test) | `/config`'s `rules` and `editor`; `GET /editor-options` |
| `apps/calendar/src/activities/editor-options.ts`, `src/http/editor-options.test.ts` | Every lookup, ministry, term and comm contact for the form |
| `apps/calendar/src/activities/view.ts`, `src/activities/history.ts`, `src/activities/files.ts`, `src/http/activity-view.test.ts` | The view's abbreviation, watchers, files and releases |
| `packages/storage/src/attachments.ts` (+ test), `src/index.ts`; `apps/calendar/src/attachment-types.test.ts` | The attachment allowlist, blocklist and content check |
| `apps/calendar/src/start.ts` (+ test), `src/app.ts`, `src/http/routes.ts` | `STORAGE_DIR` (the stack's `CALENDAR_STORAGE_DIR`) and the store |
| `apps/stack/src/env.ts` (+ test), `src/stack.ts`, `src/stack-check.test.ts` | The default under `DATA_DIR`; refusing a public folder |
| `apps/calendar/src/activities/files.ts`, `src/http/file-routes.ts`, `src/http/activity-routes.ts`, `src/http/activity-files.test.ts` | Upload, replace, remove |
| `apps/calendar/src/http/activity-file-download.test.ts` | Download and its authorisation matrix |
| `docs/parity/changes-from-legacy.md`, `docs/parity/open-questions.md`, `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`, `docs/superpowers/plans/phase-5-carry-forward.md` | Docs |

---

### Task 1: The browser's rules: `releaseHiddenCategoryNames` and `/config`'s `rules` and `editor`

Covers: spec §7.2 (one rule set for the form and the API, C156), §7.6 (inference in a shared module), §8.2 (the Release fieldset hidden for legacy's categories; HQ Placeholder and relaxed required fields for HQ). Decision E13. Carry-forward: "the editor runs `checkActivity` and `inferLookAhead` itself".

**Files:**
- Modify: `packages/config/src/calendar.ts`, `packages/config/src/calendar.test.ts`, `config/tenants/bc.json`, `packages/calendar-contract/src/rules.ts`, `packages/calendar-contract/src/index.ts`, `apps/calendar/test/helpers.ts`, `apps/calendar/src/http/config-routes.ts`, `apps/calendar/src/http/config-routes.test.ts`.
- Create: `packages/calendar-contract/src/editor.ts`, `packages/calendar-contract/src/editor.test.ts`.

**Interfaces:**
- Consumes: `CalendarRules`, `can.create`, `can.relaxRequiredFields`, `can.useHqPlaceholder`.
- Produces:
  - `CalendarRules.releaseHiddenCategoryNames: readonly string[]`.
  - `EDITOR_RULE_KEYS` and `type EditorRules = Pick<CalendarRules, (typeof EDITOR_RULE_KEYS)[number]>`; `editorRulesOf(rules: CalendarRules): EditorRules`.
  - `releaseFieldsetHidden(categoryName: string | null, rules: Pick<CalendarRules, "releaseHiddenCategoryNames">): boolean`.
  - `GET /calendar/api/config` adds `rules: EditorRules` and `editor: { create: boolean; relaxRequired: boolean; useHqPlaceholder: boolean }`; every existing key stays.

- [ ] **Step 1: Write the failing tests**

Append to `packages/config/src/calendar.test.ts`, inside the first `it` ("BC carries legacy's values"), after the `cloneKeptKeywordNames` line:

```ts
    // Scripts/activityhelper.ts:170-196: the categories that hide the Release fieldset.
    expect(c.releaseHiddenCategoryNames).toHaveLength(8);
    expect(c.releaseHiddenCategoryNames).toContain("Awareness Day / Week / Month");
```

Create `packages/calendar-contract/src/editor.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { EDITOR_RULE_KEYS, editorRulesOf, releaseFieldsetHidden } from "./editor";
import type { CalendarRules } from "./rules";

const RULES: CalendarRules = {
  timeZone: "America/Vancouver",
  freeze: { start: "16:00", end: "17:00" },
  releaseCategoryIds: [12, 58],
  awarenessCategoryIds: [2],
  otherCityId: 311,
  unconfirmedIssueCommMaterialId: 61,
  hqPlaceholderCategoryName: "Sample HQ placeholder",
  confidentialCategoryName: "Sample confidential category",
  issueExemptCategoryNames: ["Sample approved event"],
  eventsCategoryNames: ["Sample approved event"],
  releaseHiddenCategoryNames: ["Sample no-release category"],
  consultationsMinistryAbbreviation: "CONSULT",
  contactMinistryExcludedAbbreviations: ["EXCL"],
  sharedWithExcludedAbbreviations: ["EXCL"],
  translationsDefault: ["Sample language A"],
  required: { significance: true, scheduling: true, strategy: false },
  showHqCommentsField: false,
  showRecordsSection: false,
  cloneKeptKeywordNames: ["Sample kept keyword"],
  lookAheadCoverImage: null,
  reportBanner: { province: "Sample Province", confidentiality: "DRAFT AND CONFIDENTIAL" },
};

describe("the editor's rules", () => {
  it("are exactly the keys the browser reads, nothing the reports or the server alone use", () => {
    const r = editorRulesOf(RULES);
    expect(Object.keys(r).sort()).toEqual([...EDITOR_RULE_KEYS].sort());
    expect(r).not.toHaveProperty("freeze");
    expect(r).not.toHaveProperty("reportBanner");
    expect(r).not.toHaveProperty("cloneKeptKeywordNames");
    expect(r.releaseHiddenCategoryNames).toEqual(["Sample no-release category"]);
  });

  it("hide the Release fieldset for the tenant's named categories only (activityhelper.ts:170-196)", () => {
    expect(releaseFieldsetHidden("Sample no-release category", RULES)).toBe(true);
    expect(releaseFieldsetHidden("Sample approved event", RULES)).toBe(false);
    expect(releaseFieldsetHidden(null, RULES)).toBe(false);
  });
});
```

Append to `apps/calendar/src/http/config-routes.test.ts`, inside the `describe`, a third user and two tests. Add next to `ED` and `HQ`:

```ts
const RO = "00000000-0000-4000-8000-000000000303";
```

In `beforeAll`, after the two `projectUser` calls:

```ts
    await projectUser(app, { id: RO, email: "ro@example.test", displayName: "Sample Reader", isActive: true, calendarRole: "Calendar.ReadOnly", organizationKeys: ["health"] });
```

Add the import `import { editorRulesOf } from "@gcpe/calendar-contract";` and these tests:

```ts
  it("gives the editor its slice of the rules, and nothing the browser doesn't need", async () => {
    const app = createTestApp(tdb.db);
    const res = await request(app).get("/api/config").set("cookie", await sessionCookie(ED));
    expect(res.body.rules).toEqual(editorRulesOf(TEST_RULES));
    expect(res.body.rules).not.toHaveProperty("reportBanner");
    expect(res.body.rules).not.toHaveProperty("freeze");
  });

  it("says what this user may do in the editor", async () => {
    const app = createTestApp(tdb.db);
    const get = async (id: string) => (await request(app).get("/api/config").set("cookie", await sessionCookie(id))).body.editor;
    expect(await get(ED)).toEqual({ create: true, relaxRequired: false, useHqPlaceholder: false });
    expect(await get(HQ)).toEqual({ create: true, relaxRequired: true, useHqPlaceholder: true });
    expect(await get(RO)).toEqual({ create: false, relaxRequired: false, useHqPlaceholder: false });
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/config/src/calendar.test.ts packages/calendar-contract/src/editor.test.ts apps/calendar/src/http/config-routes.test.ts`
Expected: FAIL. `releaseHiddenCategoryNames` is undefined, `./editor` doesn't exist, and `/config` has no `rules` or `editor`.

- [ ] **Step 3: Implement**

`packages/config/src/calendar.ts`, after `eventsCategoryNames: names,`:

```ts
    /** Categories whose activities hide the editor's Release fieldset (Scripts/activityhelper.ts:170-196). */
    releaseHiddenCategoryNames: names,
```

`config/tenants/bc.json`, after the `eventsCategoryNames` line:

```json
    "releaseHiddenCategoryNames": ["Marketing / Advertising", "Conference / AGM / Forum", "TV / Radio", "Event (3rd Party) - No Release", "Awareness Day / Week / Month", "IGRS use: Half-Masting", "IGRS use: National Day", "IGRS use: Visit"],
```

`packages/calendar-contract/src/rules.ts`, after `eventsCategoryNames`:

```ts
  /** Categories whose activities hide the editor's Release fieldset (Scripts/activityhelper.ts:170-196). */
  releaseHiddenCategoryNames: readonly string[];
```

`apps/calendar/test/helpers.ts`, in `TEST_RULES` after `eventsCategoryNames`:

```ts
  releaseHiddenCategoryNames: ["Sample awareness day"],
```

Create `packages/calendar-contract/src/editor.ts`:

```ts
import type { CalendarRules } from "./rules";

/** What the editor reads from the rules in the browser: checkActivity, inferLookAhead, the offered lists and the Release fieldset. */
export const EDITOR_RULE_KEYS = [
  "timeZone", "releaseCategoryIds", "required", "awarenessCategoryIds", "consultationsMinistryAbbreviation", "issueExemptCategoryNames",
  "eventsCategoryNames", "unconfirmedIssueCommMaterialId", "hqPlaceholderCategoryName", "contactMinistryExcludedAbbreviations",
  "sharedWithExcludedAbbreviations", "releaseHiddenCategoryNames", "otherCityId", "translationsDefault",
] as const satisfies readonly (keyof CalendarRules)[];
export type EditorRules = Pick<CalendarRules, (typeof EDITOR_RULE_KEYS)[number]>;

export function editorRulesOf(rules: CalendarRules): EditorRules {
  return Object.fromEntries(EDITOR_RULE_KEYS.map((k) => [k, rules[k]])) as EditorRules;
}

/** Legacy hid the Release fieldset, and cleared the release time, for these categories (Scripts/activityhelper.ts:170-196). */
export function releaseFieldsetHidden(categoryName: string | null, rules: Pick<CalendarRules, "releaseHiddenCategoryNames">): boolean {
  return categoryName !== null && rules.releaseHiddenCategoryNames.includes(categoryName);
}
```

`packages/calendar-contract/src/index.ts`: add `export * from "./editor";` in alphabetical order (after `./clean`).

`apps/calendar/src/http/config-routes.ts`: import `editorRulesOf` from `@gcpe/calendar-contract`, and add to the JSON object, after `lookAheadFieldset`:

```ts
        rules: editorRulesOf(rules),
        editor: {
          create: actor.ministryKeys.some((k) => can.create(actor, k)),
          relaxRequired: can.relaxRequiredFields(actor),
          useHqPlaceholder: can.useHqPlaceholder(actor),
        },
```

- [ ] **Step 4: Run them to see them pass, then the Calendar and config suites and both type-checks**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/config packages/calendar-contract apps/calendar`
Expected: PASS.
Run both `tsc` commands. Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/config config/tenants/bc.json packages/calendar-contract apps/calendar/test/helpers.ts apps/calendar/src/http/config-routes.ts apps/calendar/src/http/config-routes.test.ts
git commit -m "feat(calendar): the editor's rules in /config, and the tenant's categories that hide the Release fieldset"
```

---

### Task 2: `GET /calendar/api/editor-options`

Covers: spec §8.2 (every fieldset's choices), §7.2 (an inactive value is allowed only where the activity already has it: the browser needs the inactive rows to show it). Decision E12.

**Files:**
- Modify: `packages/calendar-contract/src/editor.ts`, `apps/calendar/src/http/config-routes.ts`.
- Create: `apps/calendar/src/activities/editor-options.ts`, `apps/calendar/src/http/editor-options.test.ts`.

**Interfaces:**
- Consumes: `listLookupRows(db, def)`, `LOOKUPS` (`apps/calendar/src/lookups.ts`); the `orgs`, `terms`, `commContacts`, `users` tables.
- Produces:
  - Contract: `interface EditorOption { id: number; name: string; isActive: boolean }`, `interface EditorTerm { key: string; name: string; isActive: boolean }`, `interface EditorMinistry { key: string; abbreviation: string | null; name: string; isActive: boolean }`, `interface EditorCommContact { id: number; ministryKey: string; name: string; rank: number | null; isActive: boolean }`, `interface EditorOptions { categories, cities, commMaterials, eventPlanners, representatives, keywords, distributions, origins, premierRequested, videographers: EditorOption[]; initiatives: (EditorOption & { shortName: string | null })[]; ministries: EditorMinistry[]; commContacts: EditorCommContact[]; sectors, themes, tags: EditorTerm[] }`.
  - `editorOptions(db: DbOrTx): Promise<EditorOptions>`.
  - `GET /calendar/api/editor-options` for any Calendar role.

- [ ] **Step 1: Write the failing tests**

Create `apps/calendar/src/http/editor-options.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCalendarTestDb, createTestApp, projectUser, sessionCookie } from "../../test/helpers";
import { call, seedWorld, type World } from "../../test/world";

describe("GET /api/editor-options (spec addendum §8.2)", () => {
  let tdb: TestDatabase;
  let w: World;
  let app: ReturnType<typeof createTestApp>;
  const get = (cookie: string) => call(app, "get", "/api/editor-options", cookie);

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    w = await seedWorld(app, tdb.db);
  });
  afterAll(() => tdb.drop());

  it("lists every lookup row with its active flag, so an activity's inactive value can still be shown", async () => {
    const res = await get(w.as.editor.cookie);
    expect(res.status).toBe(200);
    expect(res.body.categories).toContainEqual({ id: w.cat.hqPlaceholder, name: "Sample HQ placeholder", isActive: false });
    expect(res.body.categories).toContainEqual({ id: w.cat.plain, name: "Sample plain category", isActive: true });
    expect(res.body.cities).toContainEqual({ id: w.city.retired, name: "Sample Retired City", isActive: false });
    expect(res.body.commMaterials).toContainEqual({ id: w.commMaterial.retired, name: "Sample retired material", isActive: false });
    expect(res.body.initiatives).toEqual([{ id: 1, name: "Sample initiative", isActive: true, shortName: "SI" }]);
    for (const k of ["eventPlanners", "representatives", "keywords", "distributions", "origins", "premierRequested", "videographers"]) {
      expect(res.body[k].length, k).toBeGreaterThan(0);
    }
  });

  it("lists every ministry and every term, inactive ones flagged", async () => {
    const res = await get(w.as.editor.cookie);
    expect(res.body.ministries).toContainEqual({ key: "health", abbreviation: "HLTH", name: "Sample Health", isActive: true });
    expect(res.body.ministries).toContainEqual({ key: "retired", abbreviation: "RET", name: "Sample Retired", isActive: false });
    expect(res.body.tags).toEqual(expect.arrayContaining([
      { key: "sample-tag", name: "Sample tag sample-tag", isActive: true },
      { key: "retired-tag", name: "Sample tag retired-tag", isActive: false },
    ]));
    expect(res.body.sectors).toEqual([{ key: "sample-sector", name: "Sample sector sample-sector", isActive: true }]);
    expect(res.body.themes).toEqual([{ key: "sample-theme", name: "Sample theme sample-theme", isActive: true }]);
  });

  it("lists every comm contact; one is inactive when the contact or its person is", async () => {
    const res = await get(w.as.editor.cookie);
    expect(res.body.commContacts).toContainEqual({ id: w.contact.editorHealth, ministryKey: "health", name: "Robin Staff", rank: 4, isActive: true });
    expect(res.body.commContacts).toContainEqual({ id: w.contact.retiredHealth, ministryKey: "health", name: "Sample Advanced", rank: 4, isActive: false });
    await projectUser(app, { id: w.as.financeEditor.id, email: "financeEditor@example.test", displayName: "Kim Finance", isActive: false, calendarRole: "Calendar.Editor", organizationKeys: ["finance"] });
    const after = await get(w.as.editor.cookie);
    expect(after.body.commContacts).toContainEqual({ id: w.contact.financeEditor, ministryKey: "finance", name: "Kim Finance", rank: 4, isActive: false });
  });

  it("any Calendar role reads it; a user without one is refused", async () => {
    expect((await get(w.as.readOnly.cookie)).status).toBe(200);
    const none = "00000000-0000-4000-8000-000000000499";
    await projectUser(app, { id: none, email: "none@example.test", displayName: "Sample Nobody", isActive: true, calendarRole: null, organizationKeys: ["health"] });
    expect((await get(await sessionCookie(none))).status).toBe(403);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/http/editor-options.test.ts`
Expected: FAIL with 404 from every call.

- [ ] **Step 3: Implement**

Append to `packages/calendar-contract/src/editor.ts`:

```ts
export interface EditorOption {
  id: number;
  name: string;
  isActive: boolean;
}
export interface EditorTerm {
  key: string;
  name: string;
  isActive: boolean;
}
export interface EditorMinistry {
  key: string;
  abbreviation: string | null;
  name: string;
  isActive: boolean;
}
/** Inactive when the contact row or its person is: such a contact stays only on activities that already have it. */
export interface EditorCommContact {
  id: number;
  ministryKey: string;
  name: string;
  rank: number | null;
  isActive: boolean;
}
/** Every choice the editor offers (spec addendum §8.2), inactive rows included and flagged. */
export interface EditorOptions {
  categories: EditorOption[];
  cities: EditorOption[];
  commMaterials: EditorOption[];
  eventPlanners: EditorOption[];
  representatives: EditorOption[];
  initiatives: (EditorOption & { shortName: string | null })[];
  keywords: EditorOption[];
  distributions: EditorOption[];
  origins: EditorOption[];
  premierRequested: EditorOption[];
  videographers: EditorOption[];
  ministries: EditorMinistry[];
  commContacts: EditorCommContact[];
  sectors: EditorTerm[];
  themes: EditorTerm[];
  tags: EditorTerm[];
}

```

The editor labels ranks with staff-web's existing `RANK_OPTIONS` (`apps/staff-web/src/screens/calendar/users/types.ts`, legacy's `Admin/User.aspx.cs:16-25`), so the contract carries only the number.

Create `apps/calendar/src/activities/editor-options.ts`:

```ts
import { asc, eq } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import type { EditorOption, EditorOptions, EditorTerm } from "@gcpe/calendar-contract";
import { commContacts, orgs, terms, users, type TermKind } from "../db/schema";
import { listLookupRows, LOOKUPS, type LookupDef } from "../lookups";

const rowsOf = async (db: DbOrTx, def: LookupDef): Promise<EditorOption[]> =>
  (await listLookupRows(db, def)).map((r) => ({ id: r.id, name: r.name, isActive: r.isActive }));

/** Every lookup, ministry, term and comm contact, inactive ones flagged (spec addendum §8.2; DropDownListManager.cs:297). */
export async function editorOptions(db: DbOrTx): Promise<EditorOptions> {
  const termRows = await db.select().from(terms).orderBy(asc(terms.sortOrder), asc(terms.displayName), asc(terms.key));
  const termsOf = (kind: TermKind): EditorTerm[] => termRows.filter((t) => t.kind === kind).map((t) => ({ key: t.key, name: t.displayName, isActive: t.isActive }));
  const contacts = await db
    .select({ id: commContacts.id, ministryKey: commContacts.ministryKey, name: users.displayName, rank: commContacts.rank, contactActive: commContacts.isActive, userActive: users.isActive })
    .from(commContacts)
    .leftJoin(users, eq(users.id, commContacts.userId))
    .orderBy(asc(commContacts.sortOrder), asc(users.displayName), asc(commContacts.id));
  return {
    categories: await rowsOf(db, LOOKUPS.categories),
    cities: await rowsOf(db, LOOKUPS.cities),
    commMaterials: await rowsOf(db, LOOKUPS["comm-materials"]),
    eventPlanners: await rowsOf(db, LOOKUPS["event-planners"]),
    representatives: await rowsOf(db, LOOKUPS["government-representatives"]),
    initiatives: (await listLookupRows(db, LOOKUPS.initiatives)).map((r) => ({ id: r.id, name: r.name, isActive: r.isActive, shortName: r.extras.shortName ?? null })),
    keywords: await rowsOf(db, LOOKUPS.keywords),
    distributions: await rowsOf(db, LOOKUPS["nr-distributions"]),
    origins: await rowsOf(db, LOOKUPS["nr-origins"]),
    premierRequested: await rowsOf(db, LOOKUPS["premier-requested"]),
    videographers: await rowsOf(db, LOOKUPS.videographers),
    ministries: await db
      .select({ key: orgs.key, abbreviation: orgs.abbreviation, name: orgs.displayName, isActive: orgs.isActive })
      .from(orgs)
      .orderBy(asc(orgs.abbreviation), asc(orgs.key)),
    commContacts: contacts.map((c) => ({ id: c.id, ministryKey: c.ministryKey, name: c.name ?? "Unknown", rank: c.rank, isActive: c.contactActive && c.userActive === true })),
    sectors: termsOf("sector"),
    themes: termsOf("theme"),
    tags: termsOf("tag"),
  };
}
```

`apps/calendar/src/http/config-routes.ts`: import `editorOptions` and add, after the `/config` route:

```ts
  // Any Calendar role: a read-only viewer still needs the names of the values an activity holds.
  r.get("/editor-options", async (_req, res, next) => {
    try {
      res.json(await editorOptions(deps.db));
    } catch (e) {
      next(e);
    }
  });
```

- [ ] **Step 4: Run them to see them pass, then the Calendar suite**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/calendar-contract/src/editor.ts apps/calendar/src/activities/editor-options.ts apps/calendar/src/http/config-routes.ts apps/calendar/src/http/editor-options.test.ts
git commit -m "feat(calendar): GET /api/editor-options, every lookup, ministry, term and comm contact for the editor"
```

---

### Task 3: The activity view: ministry abbreviation, watchers, files and release links

Covers: spec §8.1 "Watchlist" (add or remove from the activity page; watchers' names), §8.2 ("BC Gov News", Records), §8.4 (the file list), §11 (release links on the activity), §6 (visible to whoever sees the activity). Decision E11. Carry-forward: the watchers' names (server half).

**Files:**
- Modify: `packages/calendar-contract/src/view.ts`, `apps/calendar/src/activities/view.ts`, `apps/calendar/src/activities/history.ts`.
- Create: `apps/calendar/src/activities/files.ts`, `apps/calendar/src/http/activity-view.test.ts`.

**Interfaces:**
- Consumes: `inReadSnapshot`, `viewOf` (`view.ts`), the `favourites`, `activityFiles`, `releaseLinks`, `orgs`, `users` tables.
- Produces:
  - Contract: `interface ActivityFileView { id: number; fileName: string; contentType: string; length: number; uploadedAt: string; uploadedByName: string | null }`; `interface ReleaseLinkView { releaseId: string; type: string; status: string; reference: string | null; publishAt: string | null; releasedAt: string | null }`.
  - `ActivityView` gains `ministryAbbreviation: string | null`, `watch: { isWatched: boolean; watcherNames: string[] }`, `files: ActivityFileView[]`, `releases: ReleaseLinkView[]`.
  - `HISTORY_FIELDS.files = "Records"`.
  - `filesOf(db: DbOrTx, activityId: number): Promise<ActivityFileView[]>` in `apps/calendar/src/activities/files.ts`, sorted by lower-cased name then id.

- [ ] **Step 1: Write the failing tests**

Create `apps/calendar/src/http/activity-view.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { activityFiles, releaseLinks } from "../db/schema";
import { createCalendarTestDb, createTestApp, FIXED_NOW } from "../../test/helpers";
import { call, seedWorld, validInput, type World } from "../../test/world";

describe("the activity view's ministry, watchers, files and release links", () => {
  let tdb: TestDatabase;
  let w: World;
  let app: ReturnType<typeof createTestApp>;
  const view = (who: keyof World["as"], id: number) => call(app, "get", `/api/activities/${id}`, w.as[who].cookie);
  const create = async (over = {}) => (await call(app, "post", "/api/activities", w.as.editor.cookie, validInput(w, over))).body.id as number;

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    w = await seedWorld(app, tdb.db);
  });
  afterAll(() => tdb.drop());

  it("names the lead ministry's abbreviation, for MIN-Id", async () => {
    const id = await create();
    expect((await view("editor", id)).body.ministryAbbreviation).toBe("HLTH");
  });

  it("says whether the viewer watches it and who does, by name", async () => {
    const id = await create();
    expect((await view("editor", id)).body.watch).toEqual({ isWatched: false, watcherNames: [] });
    await call(app, "put", `/api/activities/${id}/watch`, w.as.admin.cookie, {});
    await call(app, "put", `/api/activities/${id}/watch`, w.as.editor.cookie, {});
    expect((await view("editor", id)).body.watch).toEqual({ isWatched: true, watcherNames: ["Robin Staff", "Sample Admin"] });
    expect((await view("readOnly", id)).body.watch).toEqual({ isWatched: false, watcherNames: ["Robin Staff", "Sample Admin"] });
  });

  it("lists its files by name, with who uploaded them", async () => {
    const id = await create();
    await tdb.db.insert(activityFiles).values([
      { activityId: id, fileName: "b-sample.pdf", contentType: "application/pdf", length: 10, sha256: "0".repeat(64), storageKey: `activities/${id}/aaaaaaaaaaaaaaaa-b-sample.pdf`, uploadedAt: FIXED_NOW, uploadedBy: w.as.editor.id },
      { activityId: id, fileName: "A-sample.txt", contentType: "text/plain", length: 4, sha256: "1".repeat(64), storageKey: `activities/${id}/bbbbbbbbbbbbbbbb-a-sample.txt`, uploadedAt: FIXED_NOW, uploadedBy: null },
    ]);
    const files = (await view("readOnly", id)).body.files;
    expect(files.map((f: { fileName: string }) => f.fileName)).toEqual(["A-sample.txt", "b-sample.pdf"]);
    expect(files[1]).toMatchObject({ contentType: "application/pdf", length: 10, uploadedAt: FIXED_NOW.toISOString(), uploadedByName: "Robin Staff" });
    expect(files[0].uploadedByName).toBeNull();
    expect(files[0]).not.toHaveProperty("storageKey");
    expect(files[0]).not.toHaveProperty("sha256");
  });

  it("lists its release links without deleted releases, and without headlines", async () => {
    const id = await create();
    await tdb.db.insert(releaseLinks).values([
      { releaseId: "8a7f3c1e-2b4d-4e6f-9a0b-1c2d3e4f5a01", activityId: id, key: null, type: "release", status: "scheduled", publishAt: new Date("2026-11-12T17:00:00Z"), releasedAt: null, reference: "NEWS-00001", headline: "Sample headline", lastSequence: 1 },
      { releaseId: "8a7f3c1e-2b4d-4e6f-9a0b-1c2d3e4f5a02", activityId: id, key: null, type: "advisory", status: "deleted", publishAt: null, releasedAt: null, reference: null, headline: "Sample gone", lastSequence: 1 },
    ]);
    expect((await view("editor", id)).body.releases).toEqual([
      { releaseId: "8a7f3c1e-2b4d-4e6f-9a0b-1c2d3e4f5a01", type: "release", status: "scheduled", reference: "NEWS-00001", publishAt: "2026-11-12T17:00:00.000Z", releasedAt: null },
    ]);
  });

  it("labels file history as Records on View changes", async () => {
    const { HISTORY_FIELDS } = await import("@gcpe/calendar-contract");
    expect(HISTORY_FIELDS.files).toBe("Records");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/http/activity-view.test.ts`
Expected: FAIL. The view has no `ministryAbbreviation`, `watch`, `files` or `releases`, and `HISTORY_FIELDS.files` is undefined.

- [ ] **Step 3: Implement**

`packages/calendar-contract/src/view.ts`:
- In `HISTORY_FIELDS`, after `cloned_from: "Cloned from",` add `files: "Records",`.
- Add, before `ActivityView`:

```ts
/** One attachment (spec addendum §8.4). The storage key and checksum stay on the server. */
export interface ActivityFileView {
  id: number;
  fileName: string;
  contentType: string;
  length: number;
  uploadedAt: string;
  uploadedByName: string | null;
}

/** A release linked to the activity, from NRMS's release.status_changed (spec addendum §11). */
export interface ReleaseLinkView {
  releaseId: string;
  type: string;
  status: string;
  reference: string | null;
  publishAt: string | null;
  releasedAt: string | null;
}
```

- In `ActivityView`, after `id: number;` add `ministryAbbreviation: string | null;`, and after `can: …` add:

```ts
  /** The watchlist star (Activity.aspx.cs:1519-1535). */
  watch: { isWatched: boolean; watcherNames: string[] };
  files: ActivityFileView[];
  /** "BC Gov News" (spec addendum §8.2, §11); deleted releases are left out. */
  releases: ReleaseLinkView[];
```

`apps/calendar/src/activities/history.ts`: in `displayOf`'s returned object, after `cloned_from: null,` add `files: null,`.

Create `apps/calendar/src/activities/files.ts`:

```ts
import { asc, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import type { ActivityFileView } from "@gcpe/calendar-contract";
import { activityFiles, users } from "../db/schema";

/** The activity's files, by name as people read it. Callers check visibility first. */
export async function filesOf(db: DbOrTx, activityId: number): Promise<ActivityFileView[]> {
  const rows = await db
    .select({
      id: activityFiles.id, fileName: activityFiles.fileName, contentType: activityFiles.contentType, length: activityFiles.length,
      uploadedAt: activityFiles.uploadedAt, uploadedByName: users.displayName,
    })
    .from(activityFiles)
    .leftJoin(users, eq(users.id, activityFiles.uploadedBy))
    .where(eq(activityFiles.activityId, activityId))
    .orderBy(asc(sql`lower(${activityFiles.fileName})`), asc(activityFiles.id));
  return rows.map((r) => ({ ...r, uploadedAt: r.uploadedAt.toISOString(), uploadedByName: r.uploadedByName ?? null }));
}
```

`apps/calendar/src/activities/view.ts`:
- Imports: add `and`, `asc`, `ne`, `sql` from `drizzle-orm`; `favourites`, `orgs`, `releaseLinks` from `../db/schema`; `filesOf` from `./files`.
- In `viewOf`, before `return {`:

```ts
  const [org] = s.row.contactMinistryKey ? await tx.select({ abbreviation: orgs.abbreviation }).from(orgs).where(eq(orgs.key, s.row.contactMinistryKey)) : [];
  const watchers = await tx
    .select({ userId: favourites.userId, name: users.displayName })
    .from(favourites)
    .innerJoin(users, eq(users.id, favourites.userId))
    .where(eq(favourites.activityId, s.row.id))
    .orderBy(asc(users.displayName));
  const releases = await tx
    .select()
    .from(releaseLinks)
    .where(and(eq(releaseLinks.activityId, s.row.id), ne(releaseLinks.status, "deleted")))
    .orderBy(sql`${releaseLinks.publishAt} ASC NULLS LAST`, asc(releaseLinks.releaseId));
```

- In the returned object, after `id: s.row.id,` add `ministryAbbreviation: org?.abbreviation ?? null,` and after `can: {…},` add:

```ts
    watch: { isWatched: watchers.some((x) => x.userId === actor.userId), watcherNames: watchers.map((x) => x.name) },
    files: await filesOf(tx, s.row.id),
    releases: releases.map((r) => ({
      releaseId: r.releaseId, type: r.type, status: r.status, reference: r.reference,
      publishAt: r.publishAt?.toISOString() ?? null, releasedAt: r.releasedAt?.toISOString() ?? null,
    })),
```

- [ ] **Step 4: Run them to see them pass, then the whole Calendar suite**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar packages/calendar-contract`
Expected: PASS. A 5c test that compares a whole view with `toEqual` fails on the new keys: change it to `toMatchObject`, or add the four keys with their expected values; never delete an assertion.
Run both `tsc` commands. The staff-web check catches fixtures that build an `ActivityView` (there are none at `a12b8f7`; if 5d-2's fix wave adds one, give it `ministryAbbreviation: "HLTH", watch: { isWatched: false, watcherNames: [] }, files: [], releases: []`).
Run the affected e2e specs: `npx -y -p node@24 -- npm run test:e2e -- tests/e2e/calendar-list.spec.ts tests/e2e/axe-sweep.spec.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/calendar-contract/src/view.ts apps/calendar/src/activities/view.ts apps/calendar/src/activities/history.ts apps/calendar/src/activities/files.ts apps/calendar/src/http/activity-view.test.ts
git commit -m "feat(calendar): the activity view carries its ministry abbreviation, watchers, files and release links"
```

---
### Task 4: The attachment allowlist and content check

Covers: spec §8.4 (legacy's extension blocklist kept; content checked against the claimed type, with `packages/storage` sniffing as NRMS does; 25 MB per file), §14 C153. Decisions E4, E5. Review Focus 2.

**Files:**
- Modify: `packages/storage/src/index.ts`, `packages/calendar-contract/src/editor.ts`, `apps/calendar/package.json`.
- Create: `packages/storage/src/attachments.ts`, `packages/storage/src/attachments.test.ts`, `apps/calendar/src/attachment-types.test.ts`.

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `@gcpe/storage`: `ATTACHMENT_TYPES` (extension → `{ contentType, family }`), `type AttachmentExtension`, `BLOCKED_EXTENSIONS: ReadonlySet<string>`, `type AttachmentProblem = "empty" | "blocked" | "unsupported" | "mismatch"`, `extensionOf(fileName: string): string | null`, `checkAttachment(fileName: string, bytes: Buffer): { ok: true; extension: AttachmentExtension; contentType: string } | { ok: false; problem: AttachmentProblem }`, `downloadContentType(stored: string): string`.
  - `@gcpe/calendar-contract`: `ATTACHMENT_MAX_BYTES` (25 MiB), `ATTACHMENT_MAX_FILES` (50), `ATTACHMENT_EXTENSIONS`, `ATTACHMENT_ACCEPT` (the `accept` attribute's value).

- [ ] **Step 1: Write the failing tests**

Create `packages/storage/src/attachments.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ATTACHMENT_TYPES, BLOCKED_EXTENSIONS, checkAttachment, downloadContentType, extensionOf } from "./attachments";

const PDF = Buffer.from("%PDF-1.7\n%%EOF\n", "latin1");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = Buffer.from("GIF89a\x01\x00", "latin1");
const OOXML = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("\x14\x00[Content_Types].xml<Types/>", "latin1")]);
const PLAIN_ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("\x14\x00word.txt", "latin1")]);
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
const RTF = Buffer.from("{\\rtf1\\ansi sample}", "latin1");
const TEXT = Buffer.from("Sample notes, line one\r\nline two\n", "utf8");
const HTML = Buffer.from("<html><script>alert(1)</script></html>", "utf8");

describe("checkAttachment (spec addendum §8.4)", () => {
  it.each([
    ["Sample.pdf", PDF, "application/pdf"],
    ["SAMPLE.PDF", PDF, "application/pdf"],
    ["Sample.png", PNG, "image/png"],
    ["Sample.jpg", JPEG, "image/jpeg"],
    ["Sample.jpeg", JPEG, "image/jpeg"],
    ["Sample.gif", GIF, "image/gif"],
    ["Sample.docx", OOXML, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["Sample.xlsx", OOXML, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["Sample.pptx", OOXML, "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ["Sample.doc", OLE, "application/msword"],
    ["Sample.xls", OLE, "application/vnd.ms-excel"],
    ["Sample.ppt", OLE, "application/vnd.ms-powerpoint"],
    ["Sample.msg", OLE, "application/vnd.ms-outlook"],
    ["Sample.rtf", RTF, "application/rtf"],
    ["Sample.txt", TEXT, "text/plain"],
    ["Sample.csv", TEXT, "text/csv"],
  ])("accepts %s as %s's type", (name, bytes, contentType) => {
    expect(checkAttachment(name, bytes)).toEqual({ ok: true, extension: extensionOf(name), contentType });
  });

  it.each([
    ["an empty file", "Sample.pdf", Buffer.alloc(0), "empty"],
    ["legacy's blocklist", "Sample.exe", Buffer.from("MZ"), "blocked"],
    ["legacy's blocklist, a long extension", "Sample.ps1xml", TEXT, "blocked"],
    ["legacy's blocklist, .json", "Sample.json", TEXT, "blocked"],
    ["a type outside the list", "Sample.html", HTML, "unsupported"],
    ["an SVG", "Sample.svg", Buffer.from("<svg/>"), "unsupported"],
    ["no extension", "Sample", PDF, "unsupported"],
    ["a trailing dot", "Sample.", PDF, "unsupported"],
    ["HTML named .pdf", "Sample.pdf", HTML, "mismatch"],
    ["an executable named .docx", "Sample.docx", Buffer.from("MZ\x90\x00", "latin1"), "mismatch"],
    ["a ZIP that isn't an Office file", "Sample.xlsx", PLAIN_ZIP, "mismatch"],
    ["a PNG named .jpg", "Sample.jpg", PNG, "mismatch"],
    ["text holding a NUL byte", "Sample.txt", Buffer.from("a\u0000b"), "mismatch"],
  ])("refuses %s", (_what, name, bytes, problem) => {
    expect(checkAttachment(name, bytes)).toEqual({ ok: false, problem });
  });

  it("keeps every one of legacy's blocked extensions (Activity.aspx.cs:1274-1391), and none of them is allowed", () => {
    expect(BLOCKED_EXTENSIONS.size).toBe(105);
    for (const ext of Object.keys(ATTACHMENT_TYPES)) expect(BLOCKED_EXTENSIONS.has(ext)).toBe(false);
  });

  it("serves a stored type only when it is one of the list's; anything else is a plain download", () => {
    expect(downloadContentType("application/pdf")).toBe("application/pdf");
    expect(downloadContentType("text/html")).toBe("application/octet-stream");
    expect(downloadContentType("image/svg+xml")).toBe("application/octet-stream");
  });

  it("reads the extension after the last dot, lower-cased", () => {
    expect(extensionOf("a.b.PDF")).toBe("pdf");
    expect(extensionOf("noext")).toBeNull();
    expect(extensionOf("trailing.")).toBeNull();
  });
});
```

Create `apps/calendar/src/attachment-types.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ATTACHMENT_ACCEPT, ATTACHMENT_EXTENSIONS } from "@gcpe/calendar-contract";
import { ATTACHMENT_TYPES } from "@gcpe/storage";

describe("the editor's file picker and the server's check", () => {
  it("name exactly the same extensions", () => {
    expect([...ATTACHMENT_EXTENSIONS].sort()).toEqual(Object.keys(ATTACHMENT_TYPES).sort());
    expect(ATTACHMENT_ACCEPT.split(",")).toEqual(ATTACHMENT_EXTENSIONS.map((e) => `.${e}`));
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/storage/src/attachments.test.ts apps/calendar/src/attachment-types.test.ts`
Expected: FAIL. `./attachments` and the contract constants don't exist.

- [ ] **Step 3: Implement**

Create `packages/storage/src/attachments.ts`:

```ts
type Family = "pdf" | "png" | "jpeg" | "gif" | "ooxml" | "ole" | "rtf" | "text";

/**
 * Every extension a Calendar attachment may have, the one type it is served as, and the content
 * family its first bytes must belong to (spec addendum §8.4). The served type never comes from
 * the uploader.
 */
export const ATTACHMENT_TYPES = {
  pdf: { contentType: "application/pdf", family: "pdf" },
  png: { contentType: "image/png", family: "png" },
  jpg: { contentType: "image/jpeg", family: "jpeg" },
  jpeg: { contentType: "image/jpeg", family: "jpeg" },
  gif: { contentType: "image/gif", family: "gif" },
  doc: { contentType: "application/msword", family: "ole" },
  docx: { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", family: "ooxml" },
  xls: { contentType: "application/vnd.ms-excel", family: "ole" },
  xlsx: { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", family: "ooxml" },
  ppt: { contentType: "application/vnd.ms-powerpoint", family: "ole" },
  pptx: { contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", family: "ooxml" },
  msg: { contentType: "application/vnd.ms-outlook", family: "ole" },
  rtf: { contentType: "application/rtf", family: "rtf" },
  txt: { contentType: "text/plain", family: "text" },
  csv: { contentType: "text/csv", family: "text" },
} as const satisfies Record<string, { contentType: string; family: Family }>;
export type AttachmentExtension = keyof typeof ATTACHMENT_TYPES;

/** Legacy's blocklist (Activity.aspx.cs:1274-1391), without its duplicates. Checked first, so its refusal keeps legacy's meaning. */
export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  "ashx", "asmx", "json", "soap", "svc", "xamlx", "ade", "adp", "asa", "asp", "bas", "bat", "cdx", "cer", "chm", "class", "cmd", "com",
  "config", "cnt", "cpl", "crt", "csh", "der", "dll", "exe", "fxp", "gadget", "grp", "hlp", "hpj", "hta", "htr", "htw", "ida", "idc",
  "idq", "ins", "isp", "its", "jse", "ksh", "lnk", "mad", "maf", "mag", "mam", "maq", "mar", "mas", "mat", "mau", "mav", "maw", "mcf",
  "mda", "mdb", "mde", "mdt", "mdw", "mdz", "ms-one-stub", "msc", "msh", "msh1", "msh1xml", "msh2", "msh2xml", "mshxml", "msi", "msp",
  "mst", "ops", "pcd", "pif", "pl", "prf", "prg", "printer", "ps1", "ps1xml", "ps2", "ps2xml", "psc1", "psc2", "pst", "reg", "rem",
  "scf", "scr", "sct", "shb", "shs", "shtm", "shtml", "stm", "url", "vb", "vbe", "vbs", "vsix", "ws", "wsc", "wsf", "wsh",
]);

export type AttachmentProblem = "empty" | "blocked" | "unsupported" | "mismatch";
export type AttachmentCheck = { ok: true; extension: AttachmentExtension; contentType: string } | { ok: false; problem: AttachmentProblem };

/** The text after the last dot, lower-cased; null when there is none. */
export function extensionOf(fileName: string): string | null {
  const dot = fileName.lastIndexOf(".");
  return dot < 0 || dot === fileName.length - 1 ? null : fileName.slice(dot + 1).toLowerCase();
}

const startsWith = (b: Buffer, sig: string | readonly number[]) => {
  const s = typeof sig === "string" ? Buffer.from(sig, "latin1") : Buffer.from(sig);
  return b.length >= s.length && b.subarray(0, s.length).equals(s);
};
const MATCHES: Record<Family, (b: Buffer) => boolean> = {
  pdf: (b) => startsWith(b, "%PDF-"),
  png: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpeg: (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  gif: (b) => startsWith(b, "GIF87a") || startsWith(b, "GIF89a"),
  // Word, Excel and PowerPoint since 2007: a ZIP package with a [Content_Types].xml part.
  ooxml: (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]) && b.includes("[Content_Types].xml"),
  // Word, Excel and PowerPoint before 2007, and Outlook messages: an OLE compound file.
  ole: (b) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  rtf: (b) => startsWith(b, "{\\rtf"),
  text: (b) => !b.includes(0),
};

/** Refuses an empty file, legacy's blocked extensions, any type outside the list, and bytes that aren't what the name says. */
export function checkAttachment(fileName: string, bytes: Buffer): AttachmentCheck {
  if (bytes.length === 0) return { ok: false, problem: "empty" };
  const ext = extensionOf(fileName);
  if (ext !== null && BLOCKED_EXTENSIONS.has(ext)) return { ok: false, problem: "blocked" };
  if (ext === null || !Object.hasOwn(ATTACHMENT_TYPES, ext)) return { ok: false, problem: "unsupported" };
  const type = ATTACHMENT_TYPES[ext as AttachmentExtension];
  if (!MATCHES[type.family](bytes)) return { ok: false, problem: "mismatch" };
  return { ok: true, extension: ext as AttachmentExtension, contentType: type.contentType };
}

const SERVED: ReadonlySet<string> = new Set(Object.values(ATTACHMENT_TYPES).map((t) => t.contentType));
/** The type a stored file is served as: one of the list's, or a plain download for an imported file of any other type. */
export function downloadContentType(stored: string): string {
  return SERVED.has(stored) ? stored : "application/octet-stream";
}
```

The list has the 105 distinct extensions legacy's array holds (checked against `Activity.aspx.cs:1274-1391` while planning).

`packages/storage/src/index.ts`: add

```ts
export { ATTACHMENT_TYPES, BLOCKED_EXTENSIONS, checkAttachment, downloadContentType, extensionOf } from "./attachments";
export type { AttachmentCheck, AttachmentExtension, AttachmentProblem } from "./attachments";
```

Append to `packages/calendar-contract/src/editor.ts`:

```ts
/** 25 MB per file (C153), counted as NRMS counts its uploads. */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const ATTACHMENT_MAX_FILES = 50;
/** The extensions the server accepts (packages/storage's ATTACHMENT_TYPES; a test keeps the two equal). */
export const ATTACHMENT_EXTENSIONS = ["pdf", "png", "jpg", "jpeg", "gif", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "msg", "rtf", "txt", "csv"] as const;
/** The file picker's accept attribute. */
export const ATTACHMENT_ACCEPT = ATTACHMENT_EXTENSIONS.map((e) => `.${e}`).join(",");
```

`apps/calendar/package.json`: add `"@gcpe/storage": "0.0.0"` to `dependencies` (alphabetical, after `@gcpe/http-kit`), then run `npx -y -p node@24 -- npm install` to refresh the lockfile's workspace links.

- [ ] **Step 4: Run them to see them pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/storage apps/calendar/src/attachment-types.test.ts packages/calendar-contract`
Expected: PASS, NRMS's own storage tests included.

- [ ] **Step 5: Commit**

```bash
git add packages/storage packages/calendar-contract/src/editor.ts apps/calendar/package.json apps/calendar/src/attachment-types.test.ts package-lock.json
git commit -m "feat(storage): an attachment allowlist checked against each file's first bytes, with legacy's blocklist"
```

---

### Task 5: `CALENDAR_STORAGE_DIR`, outside every public folder

Covers: spec §5.1 ("stored through `packages/storage` under `CALENDAR_STORAGE_DIR`, outside the deploy folder… never under a public path"). Decision E8. Carry-forward: `CALENDAR_STORAGE_DIR`.

**Files:**
- Modify: `apps/calendar/src/start.ts`, `apps/calendar/src/start.test.ts`, `apps/calendar/src/app.ts`, `apps/calendar/src/http/routes.ts`, `apps/stack/src/env.ts`, `apps/stack/src/env.test.ts`, `apps/stack/src/stack.ts`, `apps/stack/src/stack-check.test.ts`.

**Interfaces:**
- Consumes: `localStore`, `ObjectStore` (`@gcpe/storage`); `envFor`, `resolvedEnvFor`, `calendarConfigured`.
- Produces:
  - `calendarEnvSchema.STORAGE_DIR` (the stack's `CALENDAR_STORAGE_DIR`), default `<repo>/data/calendar-files`; `AppHandle.storageDir: string`.
  - `AppDeps.store?: ObjectStore | null`; `ApiDeps.store?: ObjectStore | null`.
  - `envFor(env, "CALENDAR", dataDir).STORAGE_DIR` defaults to `<dataDir>/calendar-files`.
  - `assertPrivateDir(name: string, dir: string, publicDirs: Record<string, string | undefined>): void` in `apps/stack/src/env.ts`.
  - `startStack` throws, and `checkStack` reports the Calendar not ok, when the folder is public.

- [ ] **Step 1: Write the failing tests**

`apps/calendar/src/start.test.ts`:
- Add `calendarEnvSchema` to the `./start` import.
- In the first test, add `STORAGE_DIR: storageDir` to the env passed to `startCalendar`, where `const storageDir = await mkdtemp(join(tmpdir(), "calendar-files-"));` is declared at the top of the test, and add `expect(handle.storageDir).toBe(storageDir);` after the health check.
- Add:

```ts
  it("keeps attachments under data/calendar-files by default, never inside the app (spec addendum §5.1)", () => {
    const parsed = calendarEnvSchema.parse({ DATABASE_URL: "postgres://user:pass@127.0.0.1:1/calendar" });
    expect(parsed.STORAGE_DIR).toBe(fileURLToPath(new URL("../../../data/calendar-files", import.meta.url)));
  });
```

Append to `apps/stack/src/env.test.ts`, next to the NRMS `STORAGE_DIR` test (import `assertPrivateDir` from `./env`):

```ts
  it("defaults the Calendar's STORAGE_DIR under the data dir, beside NRMS's public files", () => {
    expect(envFor({}, "CALENDAR", "/data").STORAGE_DIR).toBe("/data/calendar-files");
    expect(envFor({ CALENDAR_STORAGE_DIR: "/private/calendar" }, "CALENDAR", "/data").STORAGE_DIR).toBe("/private/calendar");
  });

describe("assertPrivateDir", () => {
  const pub = { "NRMS_STORAGE_DIR (served at /files)": "/data/storage", "SITE_OUTPUT_DIR (served at /site)": "/data/site-output", "STAFF_WEB_DIR (served at /hub)": "/app/staff-web", unset: undefined };
  it("accepts a folder beside the public ones", () => {
    expect(() => assertPrivateDir("CALENDAR_STORAGE_DIR", "/data/calendar-files", pub)).not.toThrow();
  });
  it.each(["/data/storage", "/data/storage/calendar", "/data/site-output/x", "/app/staff-web/assets", "/data", "/data/storage/../storage/x"])("refuses %s", (dir) => {
    expect(() => assertPrivateDir("CALENDAR_STORAGE_DIR", dir, pub)).toThrow(/must not be inside, equal to or contain/);
  });
});
```

Place the second `describe` at the file's top level, after the `envFor` describe block closes.

Append to `apps/stack/src/stack-check.test.ts`, inside its `describe`:

```ts
  it("fails the Calendar when CALENDAR_STORAGE_DIR is inside NRMS's public files", async () => {
    const result = await checkStack({ ...baseEnv(), CALENDAR_DATABASE_URL: DB("calendar"), DATA_DIR: "/tmp/gcpe-check-data", CALENDAR_STORAGE_DIR: "/tmp/gcpe-check-data/storage/calendar" });
    expect(result.ok).toBe(false);
    expect(result.apps.calendar?.ok).toBe(false);
    expect(result.apps.calendar?.error).toContain("must not be inside, equal to or contain");
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/start.test.ts apps/stack/src/env.test.ts apps/stack/src/stack-check.test.ts`
Expected: FAIL. `STORAGE_DIR` isn't in the schema, `storageDir` is undefined, `assertPrivateDir` doesn't exist.

- [ ] **Step 3: Implement**

`apps/calendar/src/start.ts`:
- Import `localStore` from `@gcpe/storage`.
- In `calendarEnvSchema`, after `TENANT_CONFIG`:

```ts
  // Attachments (spec addendum §5.1): outside the deploy folder and never under a public path. In the
  // stack this is CALENDAR_STORAGE_DIR, defaulting to <DATA_DIR>/calendar-files.
  STORAGE_DIR: z.string().min(1).default(fileURLToPath(new URL("../../../data/calendar-files", import.meta.url))),
```

- In `AppHandle`, add `storageDir: string;`.
- After `const subscribers = …`: `const store = localStore(parsed.STORAGE_DIR);` and pass `store` to `createApp({ …, store })`. Return `storageDir: parsed.STORAGE_DIR` in the handle.

`apps/calendar/src/http/routes.ts`: import `type ObjectStore` from `@gcpe/storage`; add to `ApiDeps`:

```ts
  /** Where attachments live (CALENDAR_STORAGE_DIR); null or unset answers the file routes 503. */
  store?: ObjectStore | null;
```

`apps/calendar/src/app.ts`: import `type ObjectStore`; add `store?: ObjectStore | null;` to `AppDeps`; build the API deps once and pass them on:

```ts
  const api = { db: deps.db, rules: deps.rules, subscribers: deps.subscribers ?? [], now: deps.now, store: deps.store ?? null };
  app.use("/api", requireBearer(deps.auth), requireCalendarActor(deps.db), express.json({ limit: "100kb" }), apiRoutes(api));
```

`apps/stack/src/env.ts`:
- Import `resolve`, `sep` from `node:path` alongside `join` and `isAbsolute`.
- In `envFor`, after the NRMS line: `if (dataDir && prefix === "CALENDAR") view.STORAGE_DIR = join(dataDir, "calendar-files");`
- Add:

```ts
/**
 * The Calendar's attachments are served only through its authorised route (spec addendum §5.1,
 * §8.4), so their folder must not be, sit inside, or hold any folder the stack serves to anyone.
 */
export function assertPrivateDir(name: string, dir: string, publicDirs: Record<string, string | undefined>): void {
  const target = resolve(dir);
  for (const [label, p] of Object.entries(publicDirs)) {
    if (!p) continue;
    const pub = resolve(p);
    if (target === pub || target.startsWith(pub + sep) || pub.startsWith(target + sep)) {
      throw new Error(`${name} (${target}) must not be inside, equal to or contain ${label} (${pub})`);
    }
  }
}
```

`apps/stack/src/stack.ts`:
- Import `assertPrivateDir` from `./env`.
- Add near `resolvedEnvFor`:

```ts
/** Every folder the stack serves to anyone, named by the setting that moves it. */
function publicDirs(nrmsStorage: string | undefined, siteOutput: string | undefined, staffWeb: string | undefined): Record<string, string | undefined> {
  return { "NRMS_STORAGE_DIR (served at /files)": nrmsStorage, "SITE_OUTPUT_DIR (served at /site)": siteOutput, "STAFF_WEB_DIR (served at /hub)": staffWeb };
}
```

- In `startStack`, right after `const calendarEnv = resolvedEnvFor(env, "CALENDAR", dataDir);`:

```ts
  if (calendarConfigured(env)) assertPrivateDir("CALENDAR_STORAGE_DIR", calendarEnv.STORAGE_DIR!, publicDirs(nrmsEnv.STORAGE_DIR, siteEnv.OUTPUT_DIR, stackEnv.STAFF_WEB_DIR));
```

- In `checkStack`, after `const dataDir = resolveDataDir(env);`:

```ts
  let calendarStorageError: string | null = null;
  if (calendarConfigured(env)) {
    try {
      assertPrivateDir(
        "CALENDAR_STORAGE_DIR",
        resolvedEnvFor(env, "CALENDAR", dataDir).STORAGE_DIR!,
        publicDirs(resolvedEnvFor(env, "NRMS", dataDir).STORAGE_DIR, resolvedEnvFor(env, "SITE", dataDir).OUTPUT_DIR, stackEnv.STAFF_WEB_DIR),
      );
    } catch (e) {
      calendarStorageError = e instanceof Error ? e.message : String(e);
    }
  }
```

  and inside the loop, after the `authFromEnv` try/catch: `if (c.label === "calendar" && calendarStorageError) errors.push(calendarStorageError);`.

- [ ] **Step 4: Run them to see them pass, then the stack and Calendar suites**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/stack apps/calendar`
Expected: PASS.
Run both `tsc` commands. Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/calendar/src/start.ts apps/calendar/src/start.test.ts apps/calendar/src/app.ts apps/calendar/src/http/routes.ts apps/stack/src
git commit -m "feat(calendar,stack): CALENDAR_STORAGE_DIR under DATA_DIR, refused inside any folder the stack serves"
```

---

### Task 6: Upload, replace and remove attachments

Covers: spec §8.4 Upload and Delete (several files, empty refused, blocklist, content check, 25 MB, same-name replace, removing from the list), §8.4 History, §7.4 (a content write, frozen), §7.5 (another user's live lock refuses it), §6 (edit rights; not visible is 404). Decisions E2, E3, E5, E6, E7, E10. Carry-forward: "attachments are content writes". Review Focus 1, 2, 3, 5.

**Files:**
- Modify: `apps/calendar/src/activities/files.ts`, `apps/calendar/src/app.ts`.
- Create: `apps/calendar/src/http/file-routes.ts`, `apps/calendar/src/http/activity-files.test.ts`.

**Interfaces:**
- Consumes: `checkAttachment`, `extensionOf`, `randomFileKey`, `ObjectStore` (Tasks 4–5); `filesOf` (Task 3); `lockActivity`, `loadStored`, `factsOf`, `visible`, `can.edit`, `assertNotFrozen`, `assertNotLockedByOther`, `writeChange`, `dbNow`; `idOf`, `sendActivityError`.
- Produces:
  - `attachmentName(original: string): string`.
  - `precheckFileWrite(deps: ApiDeps, actor: CalendarActor, id: number): Promise<void>`.
  - `addFile(deps: ApiDeps, store: ObjectStore, actor: CalendarActor, id: number, original: string, bytes: Buffer): Promise<ActivityFileView[]>`.
  - `removeFile(deps: ApiDeps, store: ObjectStore, actor: CalendarActor, id: number, fileId: number): Promise<ActivityFileView[]>`.
  - `class StoredFileMissingError`.
  - `fileRoutes(deps: ApiDeps): Router`: `POST /activities/:id/files?name=` (raw body, 201 with the file list), `DELETE /activities/:id/files/:fileId` (200 with the file list). Task 7 adds the `GET`.

- [ ] **Step 1: Write the failing tests**

Create `apps/calendar/src/http/activity-files.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import type express from "express";
import type { TestDatabase } from "@gcpe/db-kit";
import { localStore, type ObjectStore } from "@gcpe/storage";
import { activities, activityFiles } from "../db/schema";
import { createCalendarTestDb, createTestApp } from "../../test/helpers";
import { call, historyOf, seedWorld, validInput, type World, type Who } from "../../test/world";

const PDF = Buffer.from("%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n", "latin1");
/** 16:30 BC on 2026-11-03, inside the 4pm-5pm freeze (UTC−7 from 2026-11-01). */
const FROZEN = new Date("2026-11-03T23:30:00Z");

describe("attachments: upload, replace and remove (spec addendum §8.4)", () => {
  let tdb: TestDatabase;
  let w: World;
  let app: express.Express;
  let dir: string;
  let store: ObjectStore;
  const upload = (who: Who, id: number, name: string, bytes: Buffer = PDF, on: express.Express = app) =>
    request(on)
      .post(`/api/activities/${id}/files?name=${encodeURIComponent(name)}`)
      .set("cookie", w.as[who].cookie)
      .set("x-gcpe-request", "1")
      .set("content-type", "application/octet-stream")
      .send(bytes);
  const remove = (who: Who, id: number, fileId: number | string) => call(app, "delete", `/api/activities/${id}/files/${fileId}`, w.as[who].cookie);
  const create = async (over = {}) => (await call(app, "post", "/api/activities", w.as.editor.cookie, validInput(w, over))).body.id as number;
  const stored = async (id: number) => (await store.list(`activities/${id}`)).map((o) => o.key);
  const names = (body: { fileName: string }[]) => body.map((f) => f.fileName);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "calendar-files-"));
    store = localStore(dir);
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db, { store });
    w = await seedWorld(app, tdb.db);
  });
  afterAll(async () => {
    await tdb.drop();
    await rm(dir, { recursive: true, force: true });
  });

  it("an editor of the lead ministry uploads a PDF: listed, stored under a flat key, history written, nothing else changed", async () => {
    const id = await create();
    const [before] = await tdb.db.select().from(activities).where(eq(activities.id, id));
    const res = await upload("editor", id, "Sample briefing.pdf");
    expect(res.status).toBe(201);
    expect(res.body).toEqual([expect.objectContaining({ fileName: "Sample briefing.pdf", contentType: "application/pdf", length: PDF.length, uploadedByName: "Robin Staff" })]);
    const [row] = await tdb.db.select().from(activityFiles).where(eq(activityFiles.activityId, id));
    expect(row!.storageKey).toMatch(new RegExp(`^activities/${id}/[0-9a-f]{16}-sample-briefing\\.pdf$`));
    expect(row!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await stored(id)).toEqual([row!.storageKey]);
    const [after] = await tdb.db.select().from(activities).where(eq(activities.id, id));
    expect(after).toMatchObject({ version: before!.version, status: before!.status, needsReview: before!.needsReview, lastUpdatedAt: before!.lastUpdatedAt });
    expect((await historyOf(tdb.db, id)).at(-1)).toEqual({ action: "updated", actorName: "Robin Staff", fields: { files: [null, "Sample briefing.pdf"] } });
  });

  it("a file with the same name, in any case, replaces the old one and deletes its bytes (Activity.aspx.cs:1436-1437)", async () => {
    const id = await create();
    await upload("editor", id, "Sample.pdf");
    const first = await stored(id);
    const res = await upload("admin", id, "SAMPLE.PDF", Buffer.concat([PDF, Buffer.from("more")]));
    expect(res.status).toBe(201);
    expect(names(res.body)).toEqual(["SAMPLE.PDF"]);
    const now = await stored(id);
    expect(now).toHaveLength(1);
    expect(now).not.toEqual(first);
    expect((await historyOf(tdb.db, id)).at(-1)!.fields).toEqual({ files: ["Sample.pdf", "SAMPLE.PDF (replaced)"] });
  });

  it.each([
    ["an empty file", "Sample.pdf", Buffer.alloc(0), "The file is empty."],
    ["a blocked extension", "Sample.exe", Buffer.from("MZ"), "This type of file can't be attached."],
    ["a type outside the list", "Sample.html", Buffer.from("<html></html>"), "Attach a PDF, image (PNG, JPEG or GIF), Word, Excel, PowerPoint, Outlook message, RTF, text or CSV file."],
    ["contents that don't match the name", "Sample.pdf", Buffer.from("<html><script></script></html>"), "The file's contents aren't a .pdf file."],
    ["a name with no file in it", "..\\", PDF, "Name the file."],
  ])("refuses %s with 422 and stores nothing", async (_what, name, bytes, message) => {
    const id = await create();
    const res = await upload("editor", id, name, bytes);
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([{ field: "files", message }]);
    expect(await stored(id)).toEqual([]);
  });

  it("keeps only the file's own name: path segments and control characters go, and the length is capped keeping the extension", async () => {
    const id = await create();
    expect(names((await upload("editor", id, "..\\..\\Sample report.pdf")).body)).toEqual(["Sample report.pdf"]);
    expect(names((await upload("editor", id, "a/b/c\r\nd.pdf")).body)).toContain("c d.pdf");
    expect(names((await upload("editor", id, `${"x".repeat(400)}.pdf`)).body)).toContain(`${"x".repeat(251)}.pdf`);
    for (const k of await stored(id)) expect(k).toMatch(/^activities\/\d+\/[0-9a-f]{16}-[a-z0-9._-]+$/);
  });

  it("is refused before the body is read: invisible 404 (even over 25 MB), view-only 403, deleted 409, someone else's lock 423, the freeze 423", async () => {
    const secret = await create({ isConfidential: true });
    expect((await upload("financeEditor", secret, "Sample.pdf", Buffer.alloc(26 * 1024 * 1024, 0x25))).status).toBe(404);
    const shared = await create({ sharedWithKeys: ["finance"] });
    expect((await upload("financeEditor", shared, "Sample.pdf")).status).toBe(403);
    const gone = await create();
    const version = (await call(app, "get", `/api/activities/${gone}`, w.as.admin.cookie)).body.version;
    await call(app, "delete", `/api/activities/${gone}`, w.as.admin.cookie, { version });
    const deleted = await upload("hqAdmin", gone, "Sample.pdf");
    expect(deleted.status).toBe(409);
    expect(deleted.body.code).toBe("deleted");
    const locked = await create();
    await call(app, "put", `/api/activities/${locked}/lock`, w.as.admin.cookie, { tabId: "tab-a" });
    const l = await upload("editor", locked, "Sample.pdf");
    expect(l.status).toBe(423);
    expect(l.body).toMatchObject({ code: "locked", holder: { displayName: "Sample Admin" } });
    const frozen = createTestApp(tdb.db, { store, now: () => FROZEN });
    const f = await upload("editor", await create(), "Sample.pdf", PDF, frozen);
    expect(f.status).toBe(423);
    expect(f.body.code).toBe("freeze");
    expect((await upload("hqEditor", await create(), "Sample.pdf", PDF, frozen)).status).toBe(201);
  });

  it("a file over 25 MB is 413, and nothing is stored", async () => {
    const id = await create();
    const res = await upload("editor", id, "Sample.pdf", Buffer.concat([PDF, Buffer.alloc(25 * 1024 * 1024)]));
    expect(res.status).toBe(413);
    expect(await stored(id)).toEqual([]);
  });

  it("holds at most 50 files; the refused upload leaves no bytes behind, and replacing still works", async () => {
    const id = await create();
    await tdb.db.insert(activityFiles).values(
      Array.from({ length: 50 }, (_, i) => ({
        activityId: id, fileName: `sample-${i}.pdf`, contentType: "application/pdf", length: 1, sha256: "0".repeat(64),
        storageKey: `activities/${id}/${String(i).padStart(16, "0")}-sample-${i}.pdf`,
      })),
    );
    const res = await upload("editor", id, "One more.pdf");
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([{ field: "files", message: "An activity holds at most 50 files. Remove one first." }]);
    expect(await stored(id)).toEqual([]);
    expect((await upload("editor", id, "SAMPLE-3.pdf")).status).toBe(201);
  });

  it("removes a file: its row and bytes go and history says so; another activity's file id, or a non-number, is 404", async () => {
    const id = await create();
    const other = await create();
    const [f] = (await upload("editor", id, "Sample.pdf")).body;
    const [g] = (await upload("editor", other, "Other.pdf")).body;
    expect((await remove("editor", id, g.id)).status).toBe(404);
    expect((await remove("editor", id, "abc")).status).toBe(404);
    expect((await remove("readOnly", other, g.id)).status).toBe(403);
    const res = await remove("editor", id, f.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(await stored(id)).toEqual([]);
    expect((await historyOf(tdb.db, id)).at(-1)!.fields).toEqual({ files: ["Sample.pdf", null] });
  });

  it("two uploads of one name at once leave one row and one stored file", async () => {
    const id = await create();
    const [a, b] = await Promise.all([upload("editor", id, "Same.pdf"), upload("editor", id, "same.pdf")]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(await tdb.db.select().from(activityFiles).where(eq(activityFiles.activityId, id))).toHaveLength(1);
    expect(await stored(id)).toHaveLength(1);
  });

  it("answers 503 when no storage is configured", async () => {
    expect((await upload("editor", await create(), "Sample.pdf", PDF, createTestApp(tdb.db))).status).toBe(503);
  });
});
```

`Who` is exported from `apps/calendar/test/world.ts` already.

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/http/activity-files.test.ts`
Expected: FAIL. The routes don't exist (404 everywhere, where 201, 422, 403, 409 and 423 are expected).

- [ ] **Step 3: Implement the service**

Append to `apps/calendar/src/activities/files.ts` (merge the imports with the file's own):

```ts
import { createHash } from "node:crypto";
import { and, count, eq, sql } from "drizzle-orm";
import type { Tx } from "@gcpe/db-kit";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_FILES, type ActivityFileView } from "@gcpe/calendar-contract";
import { safeErrorLabel } from "@gcpe/http-kit";
import { checkAttachment, extensionOf, randomFileKey, type AttachmentProblem, type ObjectStore } from "@gcpe/storage";
import type { CalendarActor } from "../actor";
import { can } from "../capabilities";
import { assertNotFrozen } from "../freeze";
import type { ApiDeps } from "../http/routes";
import { dbNow } from "../time";
import { visible } from "../visibility";
import { ActivityDeletedError, ActivityForbiddenError, ActivityNotFoundError, ActivityValidationError } from "./errors";
import { writeChange } from "./history";
import { assertNotLockedByOther } from "./locks";
import { factsOf, loadStored, lockActivity, type StoredActivity } from "./store";

/** A file row whose bytes are gone from the store: a 404, and one log line. */
export class StoredFileMissingError extends Error {
  override name = "StoredFileMissingError";
}

const PROBLEMS: Record<AttachmentProblem, (ext: string | null) => string> = {
  empty: () => "The file is empty.",
  blocked: () => "This type of file can't be attached.",
  unsupported: () => "Attach a PDF, image (PNG, JPEG or GIF), Word, Excel, PowerPoint, Outlook message, RTF, text or CSV file.",
  mismatch: (ext) => `The file's contents aren't a .${ext} file.`,
};
const invalid = (message: string) => new ActivityValidationError([{ field: "files", message }]);

const MAX_NAME = 255;
/**
 * The name people see: the last segment of what the browser sent (legacy's Path.GetFileName, for
 * either slash), control characters as spaces, at most 255 characters keeping the extension.
 */
export function attachmentName(original: string): string {
  const last = original.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = last.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length <= MAX_NAME) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 && cleaned.length - dot <= 11 ? cleaned.slice(dot) : "";
  return cleaned.slice(0, MAX_NAME - ext.length) + ext;
}

/** Every file write's checks, in the order a person can act on them (spec addendum §6, §7.4, §7.5). */
async function assertCanChangeFiles(tx: Tx, deps: ApiDeps, actor: CalendarActor, s: StoredActivity | null): Promise<StoredActivity> {
  if (!s || !visible(actor, factsOf(s))) throw new ActivityNotFoundError();
  if (s.row.deletedAt) throw new ActivityDeletedError();
  if (!can.edit(actor, factsOf(s))) throw new ActivityForbiddenError("Only the lead ministry and HQ change this activity's files");
  assertNotFrozen(await dbNow(tx, deps.now), actor, deps.rules);
  await assertNotLockedByOther(tx, deps, actor, s.row.id);
  return s;
}

/** Before the body is read: a caller who couldn't save the file is refused without their bytes being buffered. */
export async function precheckFileWrite(deps: ApiDeps, actor: CalendarActor, id: number): Promise<void> {
  await deps.db.transaction(async (tx) => {
    await assertCanChangeFiles(tx, deps, actor, await loadStored(tx, id));
  });
}

async function deleteQuietly(store: ObjectStore, key: string): Promise<void> {
  try {
    await store.delete(key);
  } catch (e) {
    console.error("[calendar] could not delete a stored file", safeErrorLabel(e));
  }
}

/**
 * Adds a file, or replaces the one with the same name in any case (Activity.aspx.cs:1436-1437).
 * The bytes are stored first, so a committed row always has them, and deleted again if the
 * transaction fails. History records it; the version, "last updated" and needs-review don't change.
 */
export async function addFile(deps: ApiDeps, store: ObjectStore, actor: CalendarActor, id: number, original: string, bytes: Buffer): Promise<ActivityFileView[]> {
  const fileName = attachmentName(original);
  if (fileName === "") throw invalid("Name the file.");
  if (bytes.length > ATTACHMENT_MAX_BYTES) throw invalid("A file can be at most 25 MB.");
  const check = checkAttachment(fileName, bytes);
  if (!check.ok) throw invalid(PROBLEMS[check.problem](extensionOf(fileName)));
  const key = randomFileKey(`activities/${id}`, fileName);
  await store.put(key, bytes, check.contentType);
  let replaced: string | null;
  try {
    replaced = await deps.db.transaction(async (tx) => {
      await lockActivity(tx, id);
      const s = await assertCanChangeFiles(tx, deps, actor, await loadStored(tx, id, { forUpdate: true }));
      const now = await dbNow(tx, deps.now);
      const [old] = await tx.select().from(activityFiles).where(and(eq(activityFiles.activityId, id), sql`lower(${activityFiles.fileName}) = lower(${fileName})`));
      if (old) {
        await tx.delete(activityFiles).where(eq(activityFiles.id, old.id));
      } else {
        const [{ n }] = (await tx.select({ n: count() }).from(activityFiles).where(eq(activityFiles.activityId, id))) as [{ n: number }];
        if (n >= ATTACHMENT_MAX_FILES) throw invalid(`An activity holds at most ${ATTACHMENT_MAX_FILES} files. Remove one first.`);
      }
      await tx.insert(activityFiles).values({
        activityId: id, fileName, contentType: check.contentType, length: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"), storageKey: key, uploadedAt: now, uploadedBy: actor.userId,
      });
      await writeChange(tx, {
        activityId: id, actor, action: "updated", contactMinistryKey: s.row.contactMinistryKey, at: now,
        fields: [{ key: "files", old: old ? old.fileName : null, new: old ? `${fileName} (replaced)` : fileName }],
      });
      return old ? old.storageKey : null;
    });
  } catch (e) {
    await deleteQuietly(store, key);
    throw e;
  }
  if (replaced) await deleteQuietly(store, replaced);
  return filesOf(deps.db, id);
}

/** Removes one file; its bytes go once the change has committed. */
export async function removeFile(deps: ApiDeps, store: ObjectStore, actor: CalendarActor, id: number, fileId: number): Promise<ActivityFileView[]> {
  const removedKey = await deps.db.transaction(async (tx) => {
    await lockActivity(tx, id);
    const s = await assertCanChangeFiles(tx, deps, actor, await loadStored(tx, id, { forUpdate: true }));
    const [file] = await tx.delete(activityFiles).where(and(eq(activityFiles.id, fileId), eq(activityFiles.activityId, id))).returning();
    if (!file) throw new ActivityNotFoundError();
    await writeChange(tx, {
      activityId: id, actor, action: "updated", contactMinistryKey: s.row.contactMinistryKey, at: await dbNow(tx, deps.now),
      fields: [{ key: "files", old: file.fileName, new: null }],
    });
    return file.storageKey;
  });
  await deleteQuietly(store, removedKey);
  return filesOf(deps.db, id);
}
```

- [ ] **Step 4: Implement the routes and mount them before the JSON parser**

Create `apps/calendar/src/http/file-routes.ts`:

```ts
import express, { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { ATTACHMENT_MAX_BYTES, safeString } from "@gcpe/calendar-contract";
import { ActivityNotFoundError } from "../activities/errors";
import { addFile, precheckFileWrite, removeFile, StoredFileMissingError } from "../activities/files";
import { idOf } from "./activity-routes";
import { sendActivityError } from "./errors";
import type { ApiDeps } from "./routes";

type Params = { id: string; fileId: string };
type Handler = (req: Request<Params>, res: Response) => Promise<void>;
const nameQuery = z.object({ name: safeString().min(1).max(1000) }).strict();

export function fileIdOf(req: Request<Params>): number {
  if (!/^\d{1,9}$/.test(req.params.fileId)) throw new ActivityNotFoundError();
  return Number(req.params.fileId);
}

function fail(e: unknown, req: Request<Params>, res: Response, next: NextFunction): void {
  if (e instanceof StoredFileMissingError) {
    console.error("[calendar] a stored file is missing", `${req.method} ${req.baseUrl}${req.path}`);
    return void res.status(404).json({ error: "not found" });
  }
  if (!sendActivityError(e, res, req)) next(e);
}
/** The final handler of a route. */
const run = (h: Handler) => (req: Request<Params>, res: Response, next: NextFunction) => void h(req, res).catch((e: unknown) => fail(e, req, res, next));
/** A check that lets the request on when it passes. */
const guard = (h: Handler) => (req: Request<Params>, res: Response, next: NextFunction) => void h(req, res).then(() => next(), (e: unknown) => fail(e, req, res, next));

/**
 * Attachments (spec addendum §8.4). Mounted after requireCalendarActor and before the JSON parser,
 * so an upload's raw bytes reach express.raw untouched, and only after every check a save would
 * make has passed: a caller who can't attach the file is refused without it being buffered.
 */
export function fileRoutes(deps: ApiDeps): Router {
  const r = Router();
  const raw = express.raw({ type: () => true, limit: ATTACHMENT_MAX_BYTES });
  const needStore = (_req: Request, res: Response, next: NextFunction) =>
    deps.store ? next() : void res.status(503).json({ error: "File storage isn't configured." });

  r.post(
    "/activities/:id/files",
    needStore,
    guard(async (req, res) => {
      res.locals.fileName = nameQuery.parse(req.query).name;
      await precheckFileWrite(deps, req.calendar!, idOf(req));
    }),
    raw,
    run(async (req, res) => {
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      res.status(201).json(await addFile(deps, deps.store!, req.calendar!, idOf(req), res.locals.fileName as string, bytes));
    }),
  );
  r.delete("/activities/:id/files/:fileId", needStore, run(async (req, res) => {
    res.json(await removeFile(deps, deps.store!, req.calendar!, idOf(req), fileIdOf(req)));
  }));
  return r;
}
```

`apps/calendar/src/app.ts`: import `fileRoutes` from `./http/file-routes` and mount it between the actor check and the JSON parser:

```ts
  app.use("/api", requireBearer(deps.auth), requireCalendarActor(deps.db), fileRoutes(api), express.json({ limit: "100kb" }), apiRoutes(api));
```

`idOf` is typed for `Request<{ id: string }>`; a `Request<{ id: string; fileId: string }>` is accepted where it is passed. If the compiler disagrees, cast at the call: `idOf(req as unknown as Request<{ id: string }>)`.

- [ ] **Step 5: Run them to see them pass, then the Calendar suite and both type-checks**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar`
Expected: PASS.
Run both `tsc` commands. Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/calendar/src/activities/files.ts apps/calendar/src/http/file-routes.ts apps/calendar/src/app.ts apps/calendar/src/http/activity-files.test.ts
git commit -m "feat(calendar): attach, replace and remove an activity's files, checked before the upload is read"
```

---

### Task 7: Download, its authorisation matrix, and the docs

Covers: spec §8.4 Download (`GET /calendar/api/activities/:id/files/:fileId`, checked against `visible()`, 404 when not visible, `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`), §3 row 5e's attachment authorisation exit check, §16 acceptance 2 (an attachment URL is 404 to an HQ Editor outside the ministry) and 11 (download refused, 404). Decision E9. Review Focus 1, 4.

**Files:**
- Modify: `apps/calendar/src/activities/files.ts`, `apps/calendar/src/http/file-routes.ts`, `docs/parity/changes-from-legacy.md`, `docs/parity/open-questions.md`, `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`, `docs/superpowers/plans/phase-5-carry-forward.md`.
- Create: `apps/calendar/src/http/activity-file-download.test.ts`.

**Interfaces:**
- Consumes: `downloadContentType` (Task 4), `visibleSql`, `inReadSnapshot`, `StoredFileMissingError`, `fileIdOf` (Task 6).
- Produces: `readFile(deps: ApiDeps, store: ObjectStore, actor: CalendarActor, id: number, fileId: number): Promise<{ fileName: string; contentType: string; bytes: Buffer }>`; `GET /calendar/api/activities/:id/files/:fileId`.

- [ ] **Step 1: Write the failing tests**

Create `apps/calendar/src/http/activity-file-download.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import type express from "express";
import type { TestDatabase } from "@gcpe/db-kit";
import { localStore, type ObjectStore } from "@gcpe/storage";
import { activityFiles } from "../db/schema";
import { createCalendarTestDb, createTestApp } from "../../test/helpers";
import { call, seedWorld, validInput, type World, type Who } from "../../test/world";

const PDF = Buffer.from("%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n", "latin1");

describe("attachment downloads: visibility decides, not the file id (spec addendum §6, §8.4; C138)", () => {
  let tdb: TestDatabase;
  let w: World;
  let app: express.Express;
  let dir: string;
  let store: ObjectStore;
  const upload = async (who: Who, id: number, name: string) =>
    (await request(app).post(`/api/activities/${id}/files?name=${encodeURIComponent(name)}`).set("cookie", w.as[who].cookie).set("x-gcpe-request", "1").set("content-type", "application/pdf").send(PDF)).body as { id: number; fileName: string }[];
  const download = (who: Who, id: number | string, fileId: number | string) =>
    request(app)
      .get(`/api/activities/${id}/files/${fileId}`)
      .set("cookie", w.as[who].cookie)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
  const createAs = async (who: Who, over = {}) => (await call(app, "post", "/api/activities", w.as[who].cookie, validInput(w, over))).body.id as number;
  const fileOn = async (id: number, name = "Sample report.pdf") => (await upload("hqAdmin", id, name)).find((f) => f.fileName === name)!.id;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "calendar-files-"));
    store = localStore(dir);
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db, { store });
    w = await seedWorld(app, tdb.db);
  });
  afterAll(async () => {
    await tdb.drop();
    await rm(dir, { recursive: true, force: true });
  });

  it("another ministry's confidential file is a 404; its own ministry, a shared ministry and HQ Advanced and above get it", async () => {
    const b = await createAs("editor", { isConfidential: true });
    const fb = await fileOn(b);
    const e = await createAs("financeEditor", { contactMinistryKey: "finance", commContactId: w.contact.financeEditor, isConfidential: true, sharedWithKeys: ["health"] });
    const fe = await fileOn(e);
    const cases: [Who, number, number, number][] = [
      ["readOnly", b, fb, 200], ["editor", b, fb, 200], ["financeEditor", b, fb, 404],
      ["hqReadOnly", b, fb, 404], ["hqEditor", b, fb, 404], ["hqAdvanced", b, fb, 200], ["hqAdmin", b, fb, 200],
      ["financeEditor", e, fe, 200], ["editor", e, fe, 200], ["hqEditor", e, fe, 404],
    ];
    for (const [who, id, fileId, status] of cases) expect((await download(who, id, fileId)).status, `${who} on ${id}`).toBe(status);
  });

  it("serves it as an attachment with a safe name, nosniff, no caching and a sandbox", async () => {
    const id = await createAs("editor");
    const fileId = await fileOn(id, 'Résumé "final".pdf');
    const res = await download("editor", id, fileId);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    const cd = res.headers["content-disposition"] as string;
    expect(cd.startsWith("attachment;")).toBe(true);
    expect(cd).toContain("filename*=UTF-8''R%C3%A9sum%C3%A9%20%22final%22.pdf");
    expect(cd).not.toMatch(/[\r\n]/);
    expect((res.body as Buffer).equals(PDF)).toBe(true);
  });

  it("an imported file of a type outside the list downloads as a plain file, never as a page", async () => {
    const id = await createAs("editor");
    const key = `activities/${id}/0000000000000000-imported.html`;
    await store.put(key, Buffer.from("<html><script>alert(1)</script></html>"), "text/html");
    const [row] = await tdb.db.insert(activityFiles).values({ activityId: id, fileName: "imported.html", contentType: "text/html", length: 38, sha256: "0".repeat(64), storageKey: key }).returning();
    const res = await download("editor", id, row!.id);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["content-disposition"]).toContain("attachment");
  });

  it("a link kept after the activity became confidential, or was deleted, is a 404 for whoever can no longer see it", async () => {
    const id = await createAs("editor");
    const fileId = await fileOn(id);
    expect((await download("hqEditor", id, fileId)).status).toBe(200);
    const v = (await call(app, "get", `/api/activities/${id}`, w.as.editor.cookie)).body;
    expect((await call(app, "put", `/api/activities/${id}`, w.as.editor.cookie, { ...v.fields, isConfidential: true, version: v.version, tabId: null })).status).toBe(200);
    expect((await download("hqEditor", id, fileId)).status).toBe(404);
    expect((await download("readOnly", id, fileId)).status).toBe(200);
    const v2 = (await call(app, "get", `/api/activities/${id}`, w.as.admin.cookie)).body;
    await call(app, "delete", `/api/activities/${id}`, w.as.admin.cookie, { version: v2.version });
    expect((await download("editor", id, fileId)).status).toBe(404);
    expect((await download("hqAdmin", id, fileId)).status).toBe(200);
  });

  it("a file id from another activity, a malformed id and a missing stored file are all 404", async () => {
    const a = await createAs("editor");
    const b = await createAs("editor");
    const fa = await fileOn(a);
    expect((await download("editor", b, fa)).status).toBe(404);
    expect((await download("editor", a, "1e3")).status).toBe(404);
    expect((await download("editor", "abc", fa)).status).toBe(404);
    const [row] = await tdb.db.select().from(activityFiles).where(eq(activityFiles.id, fa));
    await store.delete(row!.storageKey);
    expect((await download("editor", a, fa)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/http/activity-file-download.test.ts`
Expected: FAIL. Every download is a 404 (no route), so the 200 cases fail.

- [ ] **Step 3: Implement**

Append to `apps/calendar/src/activities/files.ts` (add `activities` to the schema import, `InvalidKeyError` and `downloadContentType` to the storage import, `inReadSnapshot` to the store import, and `visibleSql` from `../visibility`):

```ts
/**
 * One file's bytes for a download (spec addendum §8.4). The activity is read through visibleSql in
 * one snapshot with the file row, so a file of an activity the caller can't see is a 404 (C138).
 */
export async function readFile(deps: ApiDeps, store: ObjectStore, actor: CalendarActor, id: number, fileId: number): Promise<{ fileName: string; contentType: string; bytes: Buffer }> {
  const row = await inReadSnapshot(deps.db, async (tx) => {
    const [a] = await tx.select({ id: activities.id }).from(activities).where(and(eq(activities.id, id), visibleSql(actor)));
    if (!a) throw new ActivityNotFoundError();
    const [f] = await tx
      .select({ fileName: activityFiles.fileName, contentType: activityFiles.contentType, storageKey: activityFiles.storageKey })
      .from(activityFiles)
      .where(and(eq(activityFiles.id, fileId), eq(activityFiles.activityId, id)));
    if (!f) throw new ActivityNotFoundError();
    return f;
  });
  let obj: Awaited<ReturnType<ObjectStore["get"]>>;
  try {
    obj = await store.get(row.storageKey);
  } catch (e) {
    if (e instanceof InvalidKeyError) throw new StoredFileMissingError();
    throw e;
  }
  if (!obj) throw new StoredFileMissingError();
  return { fileName: row.fileName, contentType: downloadContentType(row.contentType), bytes: obj.bytes };
}
```

In `apps/calendar/src/http/file-routes.ts`, import `readFile` and add after the `delete` route:

```ts
  r.get("/activities/:id/files/:fileId", needStore, run(async (req, res) => {
    const f = await readFile(deps, deps.store!, req.calendar!, idOf(req), fileIdOf(req));
    // res.attachment writes RFC 6266's filename and filename*; the type is then set from the list, never from the extension.
    res.attachment(f.fileName);
    res.set({
      "Content-Type": f.contentType,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
    res.send(f.bytes);
  }));
```

- [ ] **Step 4: Run them to see them pass, then the Calendar, storage and stack suites, both type-checks, and the full e2e suite**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar packages apps/stack`
Expected: PASS.
Run both `tsc` commands. Expected: no errors.
Run: `npx -y -p node@24 -- npm run test:e2e`
Expected: PASS (no screen changed; this proves the `/config`, view and mount changes broke nothing).

- [ ] **Step 5: The docs**

`docs/parity/changes-from-legacy.md`, in "Corporate Calendar (Phase 5)":
- C138's Status: `Agreed (downloads checked, built in 5e-1)`.
- C153's Status: `Agreed (built in 5e-1)`.
- Append two rows, each at the next free number (C179 and C180 at `a12b8f7`; if 5d-2's fix wave has taken them, use the next free ones and change every C179/C180 mention in this plan, 5e-2 and the running notes to match):

```markdown
| C179 | Attachments: anything not on a blocklist of about a hundred extensions, typed as the browser said, and served with that type (`Activity.aspx.cs:1274-1391`). | An allowlist: PDF, PNG, JPEG, GIF, Word, Excel, PowerPoint, Outlook message, RTF, text and CSV, each checked against the file's first bytes. Legacy's blocklist still applies. The download's type comes from the list; an imported file of another type downloads as a plain file. At most 25 MB a file and 50 an activity. | Without a content check, a page renamed `.pdf` or an SVG would be served to staff; the spec asks for contents checked against the claimed type (§8.4). See Q59. | Proposed |
| C180 | Files were added and removed with the activity's Save. | A file is added or removed at once, on its own. It writes history ("Records") but doesn't change the activity's version, "last updated" or needs-review flags. It still obeys the freeze, edit rights and another user's lock. | A large upload shouldn't ride on every save, and a user's own open editor shouldn't be told to reload because they added a file. | Proposed |
```

`docs/parity/open-questions.md`, under "Open", at the next free number (Q59 at `a12b8f7`):

```markdown
| Q59 | Which file types do staff attach to Calendar activities? | The new Calendar accepts PDF, images, Office documents, Outlook messages, RTF, text and CSV, checked by content (C179). Legacy accepted anything not on its blocklist, and the 12 legacy files' types weren't surveyed (SV 4.12). | That list. Adding a type is one line in `packages/storage/src/attachments.ts` with its first-bytes check. | 2026-10-09 |
```

`docs/manuals/running-notes.md`, append:

```markdown
## Phase 5e-1 — Activity files

- **Calendar editors** — A file attached to an activity can be a PDF, a PNG, JPEG or GIF image, a Word, Excel or PowerPoint file, an Outlook message, RTF, text or CSV, up to 25 MB, and up to 50 files an activity. A file with the same name, in any case, replaces the old one.
- **Calendar editors** — Adding or removing a file is blocked during the 4pm-5pm freeze (unless you're HQ) and while someone else is editing the activity, as saving is.
- **All Calendar users** — A file opens only for people who can see its activity. Anyone else, including someone holding an old link, gets "not found".
- **Operations** — Calendar files live in `<DATA_DIR>/calendar-files` (`CALENDAR_STORAGE_DIR`). Back that folder up with the Calendar database. The stack refuses to start if it is put inside a folder it serves publicly.
```

`docs/deploy/siteground.md`:
- In "Persistent data", after the `storage/` bullet:

```markdown
- `calendar-files/` — the Calendar's attachments (`CALENDAR_STORAGE_DIR`, overridable). Never served
  directly: the Calendar's own route checks who may see each file. The stack refuses to start if this
  folder is inside, equal to or holds `storage/`, `site-output/` or the staff-web build.
```

- After the "### Activity list (Phase 5d)" section, add "### Activity files (Phase 5e-1)" saying: nothing to configure on boxs.ca (the default is under `DATA_DIR`); include `~/gcpe-data/calendar-files` in backups; `CALENDAR_STORAGE_DIR` moves it.

`docs/superpowers/plans/phase-5-carry-forward.md`:
- In § 5e, delete the `CALENDAR_STORAGE_DIR` item and the "Attachments are content writes" item (both done here).
- In § 5i, add:

```markdown
- **Attachments:** write each legacy file through the Calendar's `ObjectStore` under `activities/<id>/<16 hex>-<safeFileName>` (`randomFileKey`), with the name through `attachmentName` (`apps/calendar/src/activities/files.ts`). Check legacy's MD5 against the bytes first. Store the content type from `ATTACHMENT_TYPES` when `checkAttachment` accepts the file; otherwise keep legacy's type, which `downloadContentType` serves as `application/octet-stream`. An import may exceed 50 files on an activity; the cap applies only to new uploads.
```

- [ ] **Step 6: Commit**

```bash
git add apps/calendar/src/activities/files.ts apps/calendar/src/http/file-routes.ts apps/calendar/src/http/activity-file-download.test.ts docs
git commit -m "feat(calendar),docs: attachment downloads authorised by visibility; parity C138 C153 C179 C180, Q59; running notes; deploy"
```

---

## Phase 5e-1 at a glance

| Task | Delivers | Exit evidence |
|---|---|---|
| 1 | `/config`'s `rules` and `editor`; `releaseHiddenCategoryNames` | `config-routes.test.ts`, `editor.test.ts` |
| 2 | `GET /editor-options` | `editor-options.test.ts` |
| 3 | The view's abbreviation, watchers, files, releases | `activity-view.test.ts`; list e2e still green |
| 4 | Attachment allowlist and content check | `attachments.test.ts`, `attachment-types.test.ts` |
| 5 | `CALENDAR_STORAGE_DIR`, private by construction | `start.test.ts`, `env.test.ts`, `stack-check.test.ts` |
| 6 | Upload, replace, remove | `activity-files.test.ts` |
| 7 | Download and its matrix; docs | `activity-file-download.test.ts`; full e2e green |

## Risks and things to watch

- **`res.attachment` and Express 5.** The download relies on Express's `content-disposition` encoding. If a future Express drops `filename*`, Task 7's header test fails loudly; it never silently sends a raw name.
- **The OOXML check reads the whole buffer** for `[Content_Types].xml`. At 25 MB that is one linear scan per upload; measured cost is negligible beside the write, but a much larger cap would need a ZIP directory read instead.
- **Text files are only checked for NUL bytes.** A `.txt` holding HTML is accepted, which is safe because it is served as `text/plain`, as an attachment, with `nosniff` and a sandbox CSP.
- **Not checked here:** antivirus. Neither NRMS nor the Calendar scans uploads; the platform has no scanner (C153 and NRMS's C20 say the same). If the business needs one, it is a storage-layer hook for both apps.
- **The rank and file names in logs.** Every new log line is a fixed label plus the route; review any change that adds a value to one.

## Self-review (done while writing)

1. **Spec coverage.** §8.4 Upload (several files: one request each, E2; empty; blocklist; content; 25 MB; same-name replace) → Tasks 4, 6. Delete → Task 6. Download (visibility, 404, attachment, nosniff) → Task 7. History, no flag → Task 6. §5.1 `CALENDAR_STORAGE_DIR` → Task 5. §7.4 freeze on attachments → Task 6. §7.5 lock refuses a write → Task 6. §6 capability "add or remove attachments" → Task 6. §3 row 5e attachment authorisation exit → Task 7. §8.2 Release fieldset hiding, Look Ahead inference and validation in the browser → Task 1 (the server half; the screen is 5e-2). §11 release badges → Task 3 (data; display is 5e-2). §8.1 watchlist from the activity page → Task 3 (data). §8.2/§8.3/§8.5 screens, the editor e2e for each role and the lock-expiry e2e → 5e-2.
2. **Placeholder scan.** None found: every code step carries its code, and every name it uses was read in the code at `a12b8f7` (`checkStack`'s `stackEnv`, drizzle's `count`, legacy's 105 blocked extensions). No "TBD", no "handle edge cases", no "similar to Task N".
3. **Type consistency.** `EditorRules`/`editorRulesOf` (Task 1) are what 5e-2 reads from `/config`. `EditorOptions` field names (Task 2) are the ones 5e-2's form uses. `ActivityFileView`, `ReleaseLinkView`, `watch`, `ministryAbbreviation` (Task 3) match 5e-2's screen. `filesOf` (Task 3) is reused by `addFile`/`removeFile` (Task 6). `fileIdOf` is defined in Task 6 and used in Task 7. `ATTACHMENT_*` (Task 4) are used by Task 6 and by 5e-2's picker.
4. **Review Focus.** Each of the five has a named test in its owning task (Tasks 4, 6, 7).

## Execution

The overnight run executes 5e-1 first (subagent-driven, as the 5c and 5d plans were), then `docs/superpowers/plans/2026-10-09-phase-5e2-activity-editor-screen.md`.
