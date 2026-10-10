# Phase 5e-2: The Activity Editor Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff open any activity from the list or the calendar view, or start a new one, and get legacy's activity page: its fieldsets in legacy's order, the same validation the server runs, Look Ahead inference with HQ's override, needs-review markup for HQ, the freeze and edit-lock states, Save, Cancel, Review, Delete, Clone, the watchlist star, "BC Gov News", Records and "View changes", returning to where they came from. End-to-end tests drive the editor as every role, prove a lock lapses after 15 idle minutes, and prove another ministry's confidential file is a 404.

**Architecture:**
- **5e-1 first.** This plan consumes `docs/superpowers/plans/2026-10-09-phase-5e-activity-editor.md` (5e-1): `/config`'s `rules` and `editor`, `GET /editor-options`, the view's `ministryAbbreviation`, `watch`, `files` and `releases`, and the file routes.
- **One screen, two halves.** `ActivityScreen` loads the config, the options and the activity (or nothing, for a new one) and shows "not found" or an error; once loaded it renders `ActivityEditor`, which owns the form state, the lock and the actions. A route wrapper keys the screen by id, so moving to a clone starts fresh.
- **The browser runs the server's rules.** `form.ts` holds pure functions: new-activity defaults, the choices each control offers (active rows plus the activity's current value), the Release fieldset's hiding, the Look Ahead section following `inferLookAhead` until overridden, the save body, and which fields carry which needs-review flag. `checkActivity` and `warningsFor` come straight from `@gcpe/calendar-contract`.
- **The lock is a hook.** `useEditLock` takes the lock on the first change, sends a heartbeat at most once a minute, lapses after 15 idle minutes, polls every 30 seconds while someone else holds it, and releases with a `keepalive` fetch that carries the CSRF header (C169).
- **Read-only is the same form, disabled**, with one sentence saying why.

**Tech Stack:** React 19, react-router 7 (data router: `useBlocker`), `@bcgov/design-system-react-components`, Vitest 4.1 with jsdom and Testing Library, axe-core, Playwright 1.63 (`page.clock`) with `@axe-core/playwright`, Node 24.

**Spec:** `docs/superpowers/specs/2026-10-07-calendar-parity-design.md`:
- §3 row 5e (exit: an editor e2e for each role; attachment authorisation tests; a lock-expiry e2e);
- §6 (visibility and capabilities: who edits, deletes, reviews, sees the Look Ahead fieldset and the markup; not visible is 404);
- §7.1–§7.6 (the rules the editor respects: actions, validation, needs-review, the freeze, locks and versions, Look Ahead inference);
- §8.1 "Watchlist", §8.2 (the editor), §8.3 (View changes), §8.4 (attachments);
- §11 (release status on the activity), §14 (C128, C129, C133, C136, C149, C176), §16 (acceptance 2, 4, 7, 8, 11, 18).

The plan also takes these into account:
- `docs/superpowers/plans/phase-5-carry-forward.md` § 5e: the items 5e-1 left; Task 6 deletes the section.
- The 5d-2 plan (`2026-10-08-phase-5d2-list-screen-ui.md`) for the staff-web and e2e conventions; 5e-1 for E1–E13. This plan adds E14–E26.

**Order:** after 5e-1, Tasks 1–6 in order. Tasks 1 and 2 are independent; Task 3 needs both; Tasks 4 and 5 extend Task 3's screen; Task 6 needs all.

**Base:**
- **Branch:** `feat/phase-5e` in `/Users/paul/gcpe-news-platform-p5e`, after 5e-1's last commit. Every path is repo-relative.
- **Facts this plan relies on (verified by reading the code at `a12b8f7`):**
  - The staff app is a data router (`createBrowserRouter(routes, { basename: "/hub" })`, `apps/staff-web/src/router.tsx`), so `useBlocker` works there; tests that render the editor must use `createMemoryRouter` + `RouterProvider` (as `ReleaseEditorPage.test.tsx` does), not `MemoryRouter`.
  - `CalendarSection` passes `CalendarMe` (`userId`, `displayName`, `level`, `ministryKeys`, `isHq`) through `useCalendarContext()`; the Calendar's routes are children of `calendar` in `router.tsx`.
  - `apiFetch` adds `X-GCPE-Request: 1` on every non-GET, passes other `RequestInit` keys (so `keepalive`) through to `fetch`, sends `raw` bodies untouched, and throws `ApiError` with `status`, `message` (the body's `error`), `code` and `body`.
  - `listApi.config()` (`apps/staff-web/src/screens/calendar/list/api.ts`) reads `/calendar/api/config` into `CalendarConfigView` (`list/types.ts`); `list/fixtures.tsx` holds `CONFIG`, `HQ_ADMIN_CONFIG`, `ME`, `HQ_ADMIN_ME` and `stubFetch`, which throws on any URL it doesn't know.
  - `RANK_OPTIONS` (`screens/calendar/users/types.ts`) labels comm-contact ranks 1–6 as legacy did.
  - `WatchStar` (`list/WatchStar.tsx`) takes a `ListRow`; the list's Title cell renders `<strong className="gcpe-activity-title">`, which the e2e specs read by class; the calendar grid's items are `<li>` text that `calendar-list.spec.ts` reads in full.
  - `TYPE_LABEL` (`@gcpe/nrms-contract`) names release types; `--gcpe-type-<type>` CSS variables colour them (`styles/global.css`).
  - E2E: `tests/e2e/global-setup.ts` builds the env for `startStack`; `CALENDAR_<KEY>` reaches the Calendar as `<KEY>` (`envFor`). `E2E_CALENDAR_DATABASE_URL` is set for workers. `calendar-support.ts` gives `listFixture()` (activities A–F on 2031-05-14, the category, city and the Health and Finance comm-contact ids), `activityInput`, `sessionOf`, `useCookie`, `listUrl`. The seeded users' display names are "Test Calendar Editor", "Test Calendar Administrator", "Test Calendar System Administrator", "Test Calendar HQ Administrator", "Test Calendar Read Only", "Test Calendar Advanced", and the two HQ users from 5d-2.

---

## Decisions made in planning

E1–E13 are 5e-1's. Task 6 writes the parity rows.

- **E14. Routes:** `/hub/calendar/activities/new`, `/hub/calendar/activities/:id` and `/hub/calendar/activities/:id/changes`. Where to go back to travels as `?return=`, accepted only when it is a `/calendar…` path inside the app; anything else falls back to the list. *Why:* a query parameter survives reload and a shared link; the list already keeps its filter in its own URL (5d-2's D24). *Cost if wrong:* links from 5f's feed and 5g's reports add `?return=` or land back on the list.
- **E15. After Save, Review and Delete the editor goes back to `return`** with a one-line notice ("Saved HLTH-123."). **After Create it opens the new activity** (legacy redirected there, `Activity.aspx.cs:1066`), so files can be added; **after Clone it opens the clone.** A save the writer can't see (`activity: null`) goes back to `return` with the server's message. *Cost if wrong:* one `navigate` target each.
- **E16. One page views and edits.** Read-only is the same form with every control disabled and one sentence saying why: no edit rights, a shared ministry's view-only access, deleted, the freeze, or someone else's lock. Download links stay usable. *Cost if wrong:* disabled controls are harder to read than text; a separate read view can come later.
- **E17. The Look Ahead section follows the inference until the user picks another.** A stored section that differs from the inferred one loads as an override, marked "Override (inferred: …)"; "Use the inferred section" undoes it. *Why:* the server keeps a fieldset user's choice as sent (`sectionToStore`), so the browser must send the inferred section unless the user chose otherwise, as legacy's page did. *Cost if wrong:* an HQ user's save could pin a stale section.
- **E18. The lock in the browser:** a tab id per page; the first change takes the lock; a heartbeat at most once a minute while the user types or clicks; a 15-minute idle timer shows the lapse; while someone else (or this user's other tab) holds it the page re-reads the activity every 30 seconds and opens for editing when the lock has gone; release on leaving the page and on `pagehide`, by `fetch` with `keepalive` and the CSRF header. If the first change can't take the lock, it is undone and the page goes read-only. *Cost if wrong:* a 30-second wait before a lapsed lock opens.
- **E19. Review and Clone are disabled while there are unsaved changes**, because both act on the stored activity; Delete asks to confirm and discards them. *Cost if wrong:* one more click for an HQ user mid-edit.
- **E20. Needs-review markup is a described-by note ("Changed: needs review") on each flagged field**, plus a highlight, so a screen reader hears it and the field's accessible name stays its label. Legacy's mapping (`Markup()` calls in `Activity.aspx`) decides which fields carry which flag.
- **E21. "BC Gov News"** lists each linked release's type (with its colour), reference, status and date. The link to the release in the staff app shows only when the session holds an NRMS role; NRMS still guards the release itself.
- **E22. The list gets a "New activity" button** for users who may create (`/config`'s `editor.create`), and shows the notice the editor leaves.
- **E23. The watch star is one component** for the list row and the activity page (C176: the activity page is where legacy had it).
- **E24. The e2e suite's tenant moves the 4pm-5pm freeze to start 12 hours after setup.** *Why:* editor journeys by non-exempt users must run at any hour; the freeze itself is covered by 5c's clock tests and this plan's component tests. *Cost if wrong:* the e2e suite never sees a live freeze; it never did.
- **E25. The lock-expiry e2e ages the lock row through a direct database connection** (`E2E_CALENDAR_DATABASE_URL`) and moves the browsers' clocks with Playwright's `page.clock`. *Why:* the stack's tick has no clock hook, and waiting 15 real minutes is not a test.
- **E26. Records for a new activity:** hidden; with `ShowRecordsSection` on, a note says to save first (files need an id, E2).

## Carry-forward items taken

From `docs/superpowers/plans/phase-5-carry-forward.md` § 5e (what 5e-1 left). Task 6 deletes the section.

| Item | Where |
|---|---|
| The editor round-trips `ActivityView.fields`, runs `checkActivity` and `inferLookAhead`, and sends `lookAhead` only when it sees the fieldset | Tasks 1, 3 |
| Lock release on tab close uses `fetch(…, { keepalive: true })` with the `X-GCPE-Request` header, not `sendBeacon` (C169) | Task 2 |
| "View changes" reads `GET /calendar/api/activities/:id/changes` | Task 4 |
| Titles link to the activity page from the list's Title cell and the calendar view; return to the list's own URL after save (C149) | Task 3 |
| The activity page's watchlist star (`PUT`/`DELETE …/watch`) with the watchers' names (C176) | Task 4 |

## Global Constraints

- **Worktree and commits:** work on `feat/phase-5e` in `/Users/paul/gcpe-news-platform-p5e`; commit after each task; **never add `Co-Authored-By` or any AI attribution**; never commit `CLAUDE.md`; **no task, decision or round labels in code comments**.
- **Node 24 for everything:** tests `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run <paths>`; type-checks `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json` and `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p apps/staff-web/tsconfig.json`; E2E `npx -y -p node@24 -- npm run test:e2e` (a single spec: append `-- tests/e2e/<file>`). Show each new test failing before implementing it.
- **Core keys are byte-exact; user ids are canonical.** Ministry keys are compared as received.
- **Bearer tokens get no Calendar access.** The staff app only ever calls with the session cookie.
- **Reads use `visibleSql` inside `inReadSnapshot`** (server side, 5e-1). The browser never decides visibility: a 404 is "not found".
- **No input produces a 500.** The editor sends only what the strict schemas accept; a 4xx is shown, never retried blindly.
- **Logs:** no `console.log` in staff-web; the error boundary logs nothing.
- **Privacy:** `example.test` addresses, fictional GUIDs and fictional names; no legacy data.
- **Migrations:** drizzle-kit only. This plan adds none.
- **Confidential text never leaves the Calendar.** Nothing here sends activity text anywhere but the Calendar's API.
- **Attachments:** downloads go through `GET /calendar/api/activities/:id/files/:fileId`, which authorises with visibility; another ministry's confidential file is a 404; the browser never builds a storage path.
- **UI tasks run the affected e2e specs.** Affected by every task here: `calendar-list.spec.ts` (titles become links, the toolbar gains a button), `axe-sweep.spec.ts`, and from Task 6 `calendar-editor.spec.ts`. The full suite stays green at the end; seeded users use minted sessions (`sessionOf`).
- **Staff-web patterns:** calls through `apiFetch` with same-origin paths; load failures show a danger `InlineAlert`; `useDocumentTitle` with the `h1` text; messages `role="status"`, errors `role="alert"`; every state has an axe test; browser code never imports `@gcpe/auth`; controls at least 24 by 24 CSS pixels.

## Review Focus

1. **Leaving with unsaved changes:** a link, Back, Cancel, or closing the tab. Expected: an in-app navigation asks "Leave anyway?"; closing the tab gets the browser's prompt; either way the lock is released when the page goes. Pinned in Task 3 ("leaving with unsaved changes asks first") and Task 2 ("releases … when the tab goes").
2. **The server refuses what the form accepted:** an inactive comm contact, a ministry deactivated since the page loaded, a stale version, someone else's lock taken between load and save, the freeze starting mid-edit. Expected: the message shows against the field or at the top, the changes stay, nothing navigates. Pinned in Task 3 ("the server's 422 shows against its field", "a 409 keeps the changes", "a 423 on save keeps the changes") and Task 6's lock-expiry journey.
3. **A pasted, stale or hand-edited activity URL:** a non-number, an id that doesn't exist, an activity the user can't see, a `return` pointing outside the app. Expected: "Activity not found" with a way back, and `return` falls back to the list. Pinned in Task 1 ("only Calendar paths come back") and Task 3 ("an unknown, invisible or malformed id").
4. **Network failure mid-save or mid-upload.** Expected: "Couldn't save. Your changes are still here" (or the file's own message), the form stays as typed, the button can be pressed again. Pinned in Task 3 ("a network failure keeps the changes") and Task 5 ("one bad file doesn't stop the others").
5. **Keyboard and screen-reader use:** the error summary takes focus and links to each field; needs-review and lock states are announced in words; the disabled read-only form says why; the delete and remove confirmations trap focus. Pinned in Task 3 ("the form's own check … linked to their fields", "needs-review markup is in each field's description"), Task 2 (the banners' roles), Tasks 3–5's axe tests.

---

## File structure

| File | Responsibility |
|---|---|
| `apps/staff-web/src/screens/calendar/list/types.ts`, `list/fixtures.tsx` | `CalendarConfigView` gains `rules`, `editor`, `lookAheadFieldset`, `showRecordsSection` |
| `apps/staff-web/src/screens/calendar/activity/paths.ts` (+ test) | `activityPath`, `changesPath`, `safeCalendarReturn` |
| `apps/staff-web/src/screens/calendar/activity/form.ts` (+ test) | The form model: defaults, choices, inference, hiding, body, markup map |
| `apps/staff-web/src/screens/calendar/activity/api.ts` | Every editor call |
| `apps/staff-web/src/screens/calendar/activity/useEditLock.ts` (+ test), `LockBanner.tsx` | The edit lock |
| `apps/staff-web/src/screens/calendar/activity/fields.tsx`, `ActivityForm.tsx`, `ActivityScreen.tsx` (+ test), `fixtures.tsx`, `a11y.test.tsx` | The editor |
| `apps/staff-web/src/screens/calendar/activity/ActivityActions.tsx`, `ReleasesList.tsx`, `ChangesScreen.tsx` (+ test) | Review, Delete, Clone, Watch, BC Gov News, View changes |
| `apps/staff-web/src/screens/calendar/activity/RecordsSection.tsx` (+ test) | Attachments |
| `apps/staff-web/src/screens/calendar/list/cells.tsx`, `CalendarGrid.tsx`, `ActivityListScreen.tsx`, `WatchStar.tsx` | Title links, New activity, the notice, the shared star |
| `apps/staff-web/src/router.tsx`, `apps/staff-web/src/styles/global.css` | Routes, styles |
| `tests/e2e/global-setup.ts`, `tests/e2e/playwright-support.ts`, `tests/e2e/calendar-editor.spec.ts`, `tests/e2e/axe-sweep.spec.ts` | End to end |
| `docs/parity/changes-from-legacy.md`, `docs/manuals/running-notes.md`, `docs/superpowers/plans/phase-5-carry-forward.md` | Docs |

---

### Task 1: The form model, the paths and the editor's API module

Covers: spec §8.2 (fieldset contents, default 8:00 AM–6:00 PM, Shared With "every active ministry minus the excludes", Release fieldset hidden for legacy's categories), §7.2 (the shared validation), §7.6 (inference; the override), §6 (Look Ahead fields only from the fieldset's users), §8.2 Markup. Decisions E14, E17, E20. Carry-forward: round-tripping `fields`, `checkActivity`, `inferLookAhead`, `lookAhead` only with the fieldset. Review Focus 3.

**Files:**
- Modify: `apps/staff-web/src/screens/calendar/list/types.ts`, `apps/staff-web/src/screens/calendar/list/fixtures.tsx`.
- Create: `apps/staff-web/src/screens/calendar/activity/paths.ts`, `paths.test.ts`, `form.ts`, `form.test.ts`, `api.ts`.

**Interfaces:**
- Consumes: 5e-1's `EditorRules`, `EditorOptions`, `EditorTerm`, `EditorCommContact`, `ActivityFileView`, `releaseFieldsetHidden`; the contract's `ActivityFields`, `ActivityView`, `ActivityChangeView`, `UpdateActivityInput`, `WriteResponse`, `FieldError`, `HqSection`, `LookAheadInference`, `NeedsReviewKey`, `inferLookAhead`; `RANK_OPTIONS`; `safeReturnTo`; `apiFetch`.
- Produces:
  - `CalendarConfigView` adds `lookAheadFieldset: boolean; showRecordsSection: boolean; rules: EditorRules; editor: { create: boolean; relaxRequired: boolean; useHqPlaceholder: boolean }`.
  - `paths.ts`: `activityPath(id: number | "new", returnTo?: string): string`, `changesPath(id: number, returnTo?: string): string`, `safeCalendarReturn(value: string | null): string`.
  - `form.ts`: `interface Choice { value: string; label: string }`; `newActivityFields(me, lookAheadFieldset): ActivityFields`; `minIdOf(v)`; `fieldId(field)`; `errorsByField(errors)`; `lookupChoices(rows, keep)`; `categoryChoices(o, rules, useHqPlaceholder, current)`; `leadMinistryChoices(o, rules, me, current)`; `sharedWithChoices(o, rules, current)`; `commContactChoices(o, ministryKey, current)`; `contactLabel(c)`; `termChoices(rows, current)`; `translationChoices(defaults, current)`; `lookAheadInputOf(f, o, currentSection)`; `withInferredSection(f, overridden, o, rules, currentSection)`; `withCategory(f, id, o, rules)`; `withMinistry(f, key, o)`; `withAllDay(f, on)`; `bodyOf(f, lookAheadFieldset)`; `REVIEW_FLAG_OF`; `needsReviewOf(field, flags)`; `SECTION_LABELS`; `inferredLabel(i)`; `initialOverride(stored, inferred)`.
  - `api.ts`: `activityApi` with `get(id)`, `changes(id)`, `options()`, `create(fields)`, `update(id, body)`, `clone(id)`, `remove(id, version)`, `review(id, version)`, `lock(id, tabId, takeOver?)`, `release(id, tabId)`, `addFile(id, file)`, `removeFile(id, fileId)`, `fileUrl(id, fileId)`.

- [ ] **Step 1: Extend the config type and its fixtures**

`apps/staff-web/src/screens/calendar/list/types.ts`: import `type EditorRules` from `@gcpe/calendar-contract` and add to `CalendarConfigView`:

```ts
  /** The caller sees the Look Ahead fieldset on a new activity; an existing one says so through its view's `lookAhead`. */
  lookAheadFieldset: boolean;
  /** Records shows on every activity, not only those that already have files (spec addendum §8.2; Q51). */
  showRecordsSection: boolean;
  /** The rules the editor runs in the browser (spec addendum §7.2, §7.6). */
  rules: EditorRules;
  editor: { create: boolean; relaxRequired: boolean; useHqPlaceholder: boolean };
```

`apps/staff-web/src/screens/calendar/list/fixtures.tsx`: give `CONFIG` the new keys and let the HQ config follow:

```ts
export const CONFIG: CalendarConfigView = {
  timeZone: "America/Vancouver",
  freeze: { start: "16:00", end: "17:00", timeZone: "America/Vancouver", active: false, appliesToYou: false, message: "You cannot make content changes between 4pm-5pm. Contact the Corp Cal Manager to have emerging or urgent updates made for you during this time." },
  list: { markup: false, corporateQueries: false, lookAheadFilter: false, reviewSelected: false, clearLaStatus: false },
  lookAheadFieldset: false,
  showRecordsSection: false,
  rules: {
    timeZone: "America/Vancouver",
    releaseCategoryIds: [12, 58],
    required: { significance: true, scheduling: true, strategy: false },
    awarenessCategoryIds: [2],
    consultationsMinistryAbbreviation: "CONSULT",
    issueExemptCategoryNames: ["Sample approved event"],
    eventsCategoryNames: ["Sample approved event"],
    unconfirmedIssueCommMaterialId: 61,
    hqPlaceholderCategoryName: "Sample HQ placeholder",
    contactMinistryExcludedAbbreviations: ["EXCL"],
    sharedWithExcludedAbbreviations: ["EXCL"],
    releaseHiddenCategoryNames: ["Sample awareness"],
    otherCityId: 311,
    translationsDefault: ["Sample language A", "Sample language B"],
  },
  editor: { create: true, relaxRequired: false, useHqPlaceholder: false },
};
export const HQ_ADMIN_CONFIG: CalendarConfigView = {
  ...CONFIG,
  list: { markup: true, corporateQueries: true, lookAheadFilter: true, reviewSelected: true, clearLaStatus: true },
  lookAheadFieldset: true,
  editor: { create: true, relaxRequired: true, useHqPlaceholder: true },
};
```

- [ ] **Step 2: Write the failing tests**

Create `apps/staff-web/src/screens/calendar/activity/paths.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { activityPath, changesPath, safeCalendarReturn } from "./paths";

describe("the editor's paths (C149)", () => {
  it("carry where to come back to", () => {
    expect(activityPath(20001)).toBe("/calendar/activities/20001");
    expect(activityPath("new", "/calendar?q=%7B%7D")).toBe("/calendar/activities/new?return=%2Fcalendar%3Fq%3D%257B%257D");
    expect(changesPath(20001, "/calendar")).toBe("/calendar/activities/20001/changes?return=%2Fcalendar");
  });

  it("only Calendar paths come back; anything else is the list", () => {
    expect(safeCalendarReturn("/calendar?q=%7B%7D&view=month")).toBe("/calendar?q=%7B%7D&view=month");
    expect(safeCalendarReturn("/calendar/activities/20001")).toBe("/calendar/activities/20001");
    for (const bad of [null, "", "https://example.test/", "//example.test/calendar", "/releases/1", "/calendarx", "calendar"]) {
      expect(safeCalendarReturn(bad)).toBe("/calendar");
    }
  });
});
```

Create `apps/staff-web/src/screens/calendar/activity/form.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { checkActivity, inferLookAhead, type ActivityFields, type EditorOptions } from "@gcpe/calendar-contract";
import { CONFIG, HQ_ADMIN_ME, ME } from "../list/fixtures";
import {
  bodyOf, categoryChoices, commContactChoices, errorsByField, fieldId, initialOverride, inferredLabel, leadMinistryChoices, lookAheadInputOf, lookupChoices,
  needsReviewOf, newActivityFields, sharedWithChoices, translationChoices, withAllDay, withCategory, withInferredSection, withMinistry,
} from "./form";

const RULES = CONFIG.rules;
const O: EditorOptions = {
  categories: [
    { id: 32, name: "Sample category", isActive: true }, { id: 2, name: "Sample awareness", isActive: true },
    { id: 33, name: "Sample HQ placeholder", isActive: false }, { id: 34, name: "Sample retired category", isActive: false },
  ],
  cities: [{ id: 1, name: "Sample City", isActive: true }, { id: 9, name: "Sample Old City", isActive: false }],
  commMaterials: [], eventPlanners: [], representatives: [], initiatives: [], keywords: [], distributions: [], origins: [], premierRequested: [], videographers: [],
  ministries: [
    { key: "health", abbreviation: "HLTH", name: "Sample Health", isActive: true }, { key: "finance", abbreviation: "FIN", name: "Sample Finance", isActive: true },
    { key: "excluded", abbreviation: "EXCL", name: "Sample Excluded", isActive: true }, { key: "retired", abbreviation: "RET", name: "Sample Retired", isActive: false },
  ],
  commContacts: [
    { id: 11, ministryKey: "health", name: "Robin Staff", rank: 4, isActive: true },
    { id: 12, ministryKey: "finance", name: "Kim Finance", rank: 1, isActive: true },
    { id: 13, ministryKey: "health", name: "Sample Former", rank: null, isActive: false },
  ],
  sectors: [], themes: [], tags: [],
};
const base = (over: Partial<ActivityFields> = {}): ActivityFields => ({ ...newActivityFields(ME, false), categoryId: 32, title: "Sample", startDate: "2031-11-10", endDate: "2031-11-10", ...over });

describe("the editor's form model", () => {
  it("starts a new activity at legacy's 8:00 AM to 6:00 PM, in the user's only ministry", () => {
    const f = newActivityFields(ME, false);
    expect(f).toMatchObject({ startTime: "08:00", endTime: "18:00", contactMinistryKey: "health", isAllDay: false, categoryId: null });
    expect(f).not.toHaveProperty("lookAhead");
    expect(newActivityFields(HQ_ADMIN_ME, true)).toMatchObject({ contactMinistryKey: null, lookAhead: { hqComments: "", hqStatus: null, hqSection: "not_on_la", longTermOutlook: false } });
  });

  it("offers active rows, plus the inactive value the activity already holds, marked", () => {
    expect(lookupChoices(O.cities, [null])).toEqual([{ value: "1", label: "Sample City" }]);
    expect(lookupChoices(O.cities, [9])).toEqual([{ value: "1", label: "Sample City" }, { value: "9", label: "Sample Old City (no longer in use)" }]);
  });

  it("offers HQ Placeholder to HQ only, and keeps a retired category the activity has", () => {
    expect(categoryChoices(O, RULES, false, null).map((c) => c.label)).toEqual(["Sample category", "Sample awareness"]);
    expect(categoryChoices(O, RULES, true, null).map((c) => c.label)).toEqual(["Sample category", "Sample awareness", "Sample HQ placeholder"]);
    expect(categoryChoices(O, RULES, false, 34).map((c) => c.label)).toContain("Sample retired category (no longer in use)");
  });

  it("lead ministry: one's own for a ministry user, every active one but the excluded for HQ (Activity.aspx.cs:390-410)", () => {
    expect(leadMinistryChoices(O, RULES, ME, null).map((c) => c.value)).toEqual(["health"]);
    expect(leadMinistryChoices(O, RULES, HQ_ADMIN_ME, null).map((c) => c.value)).toEqual(["health", "finance"]);
    expect(leadMinistryChoices(O, RULES, ME, "retired").map((c) => c.label)).toContain("Sample Retired (RET) (no longer in use)");
  });

  it("shared with: every active ministry but the excluded, plus what is already shared", () => {
    expect(sharedWithChoices(O, RULES, []).map((c) => c.value)).toEqual(["health", "finance"]);
    expect(sharedWithChoices(O, RULES, ["retired"]).map((c) => c.value)).toEqual(["health", "finance", "retired"]);
  });

  it("comm contacts: the lead ministry's active ones, named with their rank, plus the current one", () => {
    expect(commContactChoices(O, "health", null)).toEqual([{ value: "11", label: "Robin Staff (PAO)" }]);
    expect(commContactChoices(O, "health", 13).map((c) => c.label)).toEqual(["Robin Staff (PAO)", "Sample Former (no longer in use)"]);
    expect(commContactChoices(O, null, null)).toEqual([]);
  });

  it("translations: the tenant's list, plus any other the activity has", () => {
    expect(translationChoices(RULES.translationsDefault, ["Sample other language"]).map((c) => c.value)).toEqual(["Sample language A", "Sample language B", "Sample other language"]);
  });

  it("a category that hides the Release fieldset clears the release time (activityhelper.ts:170-196)", () => {
    expect(withCategory(base({ nrDate: "2031-11-10", nrTime: "09:00" }), 2, O, RULES)).toMatchObject({ categoryId: 2, nrDate: null, nrTime: null });
    expect(withCategory(base({ nrDate: "2031-11-10", nrTime: "09:00" }), 32, O, RULES)).toMatchObject({ nrDate: "2031-11-10", nrTime: "09:00" });
  });

  it("a new lead ministry drops another ministry's comm contact", () => {
    expect(withMinistry(base({ commContactId: 11 }), "finance", O).commContactId).toBeNull();
    expect(withMinistry(base({ commContactId: 12 }), "finance", O).commContactId).toBe(12);
  });

  it("turning All Day off brings the default times back where they were empty", () => {
    expect(withAllDay(base({ isAllDay: true, startTime: null, endTime: null }), false)).toMatchObject({ isAllDay: false, startTime: "08:00", endTime: "18:00" });
  });

  it("the Look Ahead section follows the inference until it is overridden (spec addendum §7.6)", () => {
    const f = { ...base({ isConfirmed: true }), lookAhead: { hqComments: "", hqStatus: null, hqSection: "not_on_la" as const, longTermOutlook: false } };
    expect(withInferredSection(f, false, O, RULES, null).lookAhead!.hqSection).toBe("in_the_news");
    expect(withInferredSection({ ...f, isIssue: true }, false, O, RULES, null).lookAhead!.hqSection).toBe("issues_and_reports");
    expect(withInferredSection(f, true, O, RULES, null).lookAhead!.hqSection).toBe("not_on_la");
    const awareness = { ...f, categoryId: 2 };
    expect(inferLookAhead(lookAheadInputOf(awareness, O, "in_the_news"), RULES)).toEqual({ kind: "awareness" });
    expect(withInferredSection(awareness, false, O, RULES, "in_the_news").lookAhead!.hqSection).toBe("not_on_la");
    expect(inferredLabel({ kind: "awareness" })).toBe("Awareness Dates");
    expect(initialOverride("not_on_la", { kind: "section", section: "in_the_news" })).toBe(true);
    expect(initialOverride("in_the_news", { kind: "section", section: "in_the_news" })).toBe(false);
    expect(initialOverride("in_the_news", { kind: "awareness" })).toBe(false);
  });

  it("sends the Look Ahead fields only from someone who sees them (spec addendum §6)", () => {
    const f = { ...base(), lookAhead: { hqComments: "x", hqStatus: null, hqSection: "not_on_la" as const, longTermOutlook: false } };
    expect(bodyOf(f, false)).not.toHaveProperty("lookAhead");
    expect(bodyOf(f, true).lookAhead).toEqual(f.lookAhead);
  });

  it("marks fields by legacy's needs-review flags", () => {
    expect(needsReviewOf("potentialDates", ["start_date"])).toBe(true);
    expect(needsReviewOf("otherCity", ["city"])).toBe(true);
    expect(needsReviewOf("keywordNames", ["tags"])).toBe(true);
    expect(needsReviewOf("title", ["details"])).toBe(false);
  });

  it("runs the server's own rules, and groups their messages by field for the form", () => {
    const errors = checkActivity(base({ title: " ", categoryId: 12 }), { rules: RULES, relaxRequired: false, lookAheadFieldset: false, previous: null, inferredSection: null });
    const byField = errorsByField(errors);
    expect(byField.get("title")).toEqual(["Enter a title"]);
    expect(byField.get("nrOriginId")).toEqual(["Choose the origin: this category is a release"]);
    expect(fieldId("lookAhead.hqComments")).toBe("activity-lookAhead-hqComments");
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/calendar/activity`
Expected: FAIL. `./paths` and `./form` don't exist.

- [ ] **Step 4: Implement**

Create `apps/staff-web/src/screens/calendar/activity/paths.ts`:

```ts
import { safeReturnTo } from "../../../session/safeReturnTo";

const withReturn = (path: string, returnTo?: string) => (returnTo ? `${path}?return=${encodeURIComponent(returnTo)}` : path);

/** The editor's address inside the router (basename /hub). `returnTo` is where Save, Review, Delete and Cancel go back to (C149). */
export const activityPath = (id: number | "new", returnTo?: string): string => withReturn(`/calendar/activities/${id}`, returnTo);
export const changesPath = (id: number, returnTo?: string): string => withReturn(`/calendar/activities/${id}/changes`, returnTo);

/** Only a Calendar page of this app comes back; anything else is the list. */
export function safeCalendarReturn(value: string | null): string {
  const v = safeReturnTo(value);
  return v === "/calendar" || v.startsWith("/calendar?") || v.startsWith("/calendar/") ? v : "/calendar";
}
```

Create `apps/staff-web/src/screens/calendar/activity/form.ts`:

```ts
import {
  inferLookAhead, releaseFieldsetHidden,
  type ActivityFields, type ActivityView, type EditorCommContact, type EditorMinistry, type EditorOptions, type EditorRules, type EditorTerm,
  type FieldError, type HqSection, type LookAheadInference, type LookAheadInput, type NeedsReviewKey,
} from "@gcpe/calendar-contract";
import { RANK_OPTIONS } from "../users/types";

export interface Choice {
  value: string;
  label: string;
}
type Me = { ministryKeys: readonly string[]; isHq: boolean };

/** A new activity: legacy's 8:00 AM–6:00 PM (spec addendum §8.2), the user's only ministry when they have one. */
export function newActivityFields(me: Me, lookAheadFieldset: boolean): ActivityFields {
  return {
    categoryId: null, title: "", details: "", significance: "", strategy: "", schedule: "", comments: "", leadOrganization: "", venue: "", otherCity: "", potentialDates: "",
    isIssue: false, isConfidential: false, isMilestone: false, isCrossGovernment: false, isAtLegislature: false, isAllDay: false, isConfirmed: false,
    startDate: null, startTime: "08:00", endDate: null, endTime: "18:00", nrDate: null, nrTime: null,
    contactMinistryKey: !me.isHq && me.ministryKeys.length === 1 ? me.ministryKeys[0]! : null,
    commContactId: null, governmentRepresentativeId: null, cityId: null, premierRequestedId: null, nrDistributionId: null, eventPlannerId: null, videographerId: null, nrOriginId: null,
    commMaterialIds: [], initiativeIds: [], keywordNames: [], sectorKeys: [], themeKeys: [], tagKeys: [], sharedWithKeys: [], translations: [],
    ...(lookAheadFieldset ? { lookAhead: { hqComments: "", hqStatus: null, hqSection: "not_on_la" as const, longTermOutlook: false } } : {}),
  };
}

/** Legacy's "MIN-Id". */
export const minIdOf = (v: Pick<ActivityView, "id" | "ministryAbbreviation">) => `${v.ministryAbbreviation ?? "—"}-${v.id}`;
/** The input a field error points at; "lookAhead.hqComments" becomes "activity-lookAhead-hqComments". */
export const fieldId = (field: string) => `activity-${field.replace(/\./g, "-")}`;

export function errorsByField(errors: readonly FieldError[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const e of errors) m.set(e.field, [...(m.get(e.field) ?? []), e.message]);
  return m;
}

const named = (name: string, isActive: boolean) => (isActive ? name : `${name} (no longer in use)`);

/** Active rows, plus any value the activity already holds (DropDownListManager.cs:297). */
export function lookupChoices(rows: readonly { id: number; name: string; isActive: boolean }[], keep: readonly (number | null)[]): Choice[] {
  return rows.filter((r) => r.isActive || keep.includes(r.id)).map((r) => ({ value: String(r.id), label: named(r.name, r.isActive) }));
}

/** HQ Placeholder, inactive in legacy, is offered to HQ only (DropDownListManager.cs:297). */
export function categoryChoices(o: EditorOptions, rules: Pick<EditorRules, "hqPlaceholderCategoryName">, useHqPlaceholder: boolean, current: number | null): Choice[] {
  const placeholder = (name: string) => name === rules.hqPlaceholderCategoryName;
  return o.categories
    .filter((c) => c.id === current || (placeholder(c.name) ? useHqPlaceholder : c.isActive))
    .map((c) => ({ value: String(c.id), label: c.isActive || placeholder(c.name) ? c.name : named(c.name, false) }));
}

const ministryLabel = (m: EditorMinistry) => named(`${m.name}${m.abbreviation ? ` (${m.abbreviation})` : ""}`, m.isActive);
const excluded = (m: EditorMinistry, list: readonly string[]) => m.abbreviation !== null && list.includes(m.abbreviation);

/** Their own ministries, or every active ministry for HQ, less the tenant's exclusions (Activity.aspx.cs:390-410). */
export function leadMinistryChoices(o: EditorOptions, rules: Pick<EditorRules, "contactMinistryExcludedAbbreviations">, me: Me, current: string | null): Choice[] {
  return o.ministries
    .filter((m) => m.key === current || (m.isActive && !excluded(m, rules.contactMinistryExcludedAbbreviations) && (me.isHq || me.ministryKeys.includes(m.key))))
    .map((m) => ({ value: m.key, label: ministryLabel(m) }));
}

/** Every active ministry less the tenant's exclusions, plus what the activity already shares with (spec addendum §8.2). */
export function sharedWithChoices(o: EditorOptions, rules: Pick<EditorRules, "sharedWithExcludedAbbreviations">, current: readonly string[]): Choice[] {
  return o.ministries
    .filter((m) => current.includes(m.key) || (m.isActive && !excluded(m, rules.sharedWithExcludedAbbreviations)))
    .map((m) => ({ value: m.key, label: ministryLabel(m) }));
}

export function contactLabel(c: EditorCommContact): string {
  const rank = RANK_OPTIONS.find((r) => r.value !== "" && r.value === String(c.rank))?.label;
  return named(`${c.name}${rank ? ` (${rank})` : ""}`, c.isActive);
}

/** The lead ministry's active comm contacts, plus the one the activity has. */
export function commContactChoices(o: EditorOptions, ministryKey: string | null, current: number | null): Choice[] {
  return o.commContacts.filter((c) => c.id === current || (c.isActive && c.ministryKey === ministryKey)).map((c) => ({ value: String(c.id), label: contactLabel(c) }));
}

export function termChoices(rows: readonly EditorTerm[], current: readonly string[]): Choice[] {
  return rows.filter((t) => t.isActive || current.includes(t.key)).map((t) => ({ value: t.key, label: named(t.name, t.isActive) }));
}

/** The tenant's languages (Activity.aspx.cs:372), plus any other the activity already has. */
export function translationChoices(defaults: readonly string[], current: readonly string[]): Choice[] {
  return [...defaults, ...current.filter((t) => !defaults.includes(t))].map((t) => ({ value: t, label: t }));
}

/** The inference's inputs, from the form and the options; the server builds the same from its tables. */
export function lookAheadInputOf(f: ActivityFields, o: EditorOptions, currentSection: HqSection | null): LookAheadInput {
  const categoryIds = f.categoryId === null ? [] : [f.categoryId];
  return {
    categoryIds,
    categoryNames: o.categories.filter((c) => categoryIds.includes(c.id)).map((c) => c.name),
    contactMinistryAbbreviation: o.ministries.find((m) => m.key === f.contactMinistryKey)?.abbreviation ?? null,
    isConfidential: f.isConfidential, isIssue: f.isIssue, isConfirmed: f.isConfirmed, commMaterialIds: f.commMaterialIds,
    startDate: f.startDate, endDate: f.endDate, currentSection,
  };
}

/** The section follows the inference until the user chooses another; a fixed section (Awareness, consultations) stays as stored (spec addendum §7.6). */
export function withInferredSection(f: ActivityFields, overridden: boolean, o: EditorOptions, rules: EditorRules, currentSection: HqSection | null): ActivityFields {
  if (!f.lookAhead || overridden) return f;
  const inferred = inferLookAhead(lookAheadInputOf(f, o, currentSection), rules);
  if (inferred.kind !== "section" || inferred.section === f.lookAhead.hqSection) return f;
  return { ...f, lookAhead: { ...f.lookAhead, hqSection: inferred.section } };
}

/** A category that hides the Release fieldset also clears the release time, as legacy did (Scripts/activityhelper.ts:170-196). */
export function withCategory(f: ActivityFields, categoryId: number | null, o: EditorOptions, rules: Pick<EditorRules, "releaseHiddenCategoryNames">): ActivityFields {
  const name = o.categories.find((c) => c.id === categoryId)?.name ?? null;
  return releaseFieldsetHidden(name, rules) ? { ...f, categoryId, nrDate: null, nrTime: null } : { ...f, categoryId };
}

/** A new lead ministry drops a comm contact of another ministry. */
export function withMinistry(f: ActivityFields, key: string | null, o: EditorOptions): ActivityFields {
  const contact = o.commContacts.find((c) => c.id === f.commContactId);
  return { ...f, contactMinistryKey: key, commContactId: contact && contact.ministryKey === key ? f.commContactId : null };
}

/** All Day hides the times; turning it off brings legacy's defaults back where they were empty. */
export function withAllDay(f: ActivityFields, on: boolean): ActivityFields {
  return on ? { ...f, isAllDay: true } : { ...f, isAllDay: false, startTime: f.startTime ?? "08:00", endTime: f.endTime ?? "18:00" };
}

/** What a save sends: the Look Ahead fields only from someone who sees the fieldset (spec addendum §6). */
export function bodyOf(f: ActivityFields, lookAheadFieldset: boolean): ActivityFields {
  if (lookAheadFieldset) return f;
  const { lookAhead: _hidden, ...rest } = f;
  return rest;
}

/** Which fields carry which needs-review flag (Activity.aspx's Markup calls; spec addendum §7.3). */
export const REVIEW_FLAG_OF: Partial<Record<keyof ActivityFields, NeedsReviewKey>> = {
  title: "title", details: "details", governmentRepresentativeId: "representative", cityId: "city", otherCity: "city",
  startDate: "start_date", startTime: "start_date", potentialDates: "start_date", endDate: "end_date", endTime: "end_date",
  categoryId: "categories", isIssue: "categories", isConfidential: "categories", commMaterialIds: "comm_materials",
  significance: "significance", comments: "internal_notes", schedule: "scheduling_considerations", strategy: "strategy",
  leadOrganization: "lead_organization", venue: "venue", initiativeIds: "initiatives", keywordNames: "tags", nrOriginId: "origin",
  nrDistributionId: "distribution", translations: "translations_required", premierRequestedId: "premier_requested",
  eventPlannerId: "event_planner", videographerId: "digital",
};
export function needsReviewOf(field: keyof ActivityFields, flags: readonly NeedsReviewKey[]): boolean {
  const k = REVIEW_FLAG_OF[field];
  return k !== undefined && flags.includes(k);
}

export const SECTION_LABELS: Readonly<Record<HqSection, string>> = {
  issues_and_reports: "Issues & Reports", events_and_speeches: "Events & Speeches", in_the_news: "In the News", not_on_la: "Not on LA",
};
export function inferredLabel(i: LookAheadInference): string {
  return i.kind === "awareness" ? "Awareness Dates" : i.kind === "consultations" ? "Consultations and Dialogues" : SECTION_LABELS[i.section];
}
/** A stored section the inference doesn't give is an HQ override, shown as one (Activity.aspx:2544-2546). */
export function initialOverride(stored: HqSection, inferred: LookAheadInference): boolean {
  return inferred.kind === "section" && inferred.section !== stored;
}
```

Create `apps/staff-web/src/screens/calendar/activity/api.ts`:

```ts
import type { ActivityChangeView, ActivityFields, ActivityFileView, ActivityView, EditorOptions, UpdateActivityInput, WriteResponse } from "@gcpe/calendar-contract";
import { apiFetch } from "../../../api/client";

const a = (id: number) => `/calendar/api/activities/${id}`;

/** Every call the activity editor makes (spec addendum §7, §8.2–§8.4), through apiFetch. */
export const activityApi = {
  get: (id: number) => apiFetch<ActivityView>(a(id)),
  changes: (id: number) => apiFetch<ActivityChangeView[]>(`${a(id)}/changes`),
  options: () => apiFetch<EditorOptions>("/calendar/api/editor-options"),
  create: (fields: ActivityFields) => apiFetch<WriteResponse>("/calendar/api/activities", { method: "POST", body: fields }),
  update: (id: number, body: UpdateActivityInput) => apiFetch<WriteResponse>(a(id), { method: "PUT", body }),
  clone: (id: number) => apiFetch<WriteResponse>(`${a(id)}/clone`, { method: "POST", body: {} }),
  remove: (id: number, version: number) => apiFetch<void>(a(id), { method: "DELETE", body: { version } }),
  review: (id: number, version: number) => apiFetch<ActivityView>(`${a(id)}/review`, { method: "POST", body: { version } }),
  lock: (id: number, tabId: string, takeOver = false) =>
    apiFetch<{ holderName: string; since: string; mine: true; tabId: string }>(`${a(id)}/lock`, { method: "PUT", body: takeOver ? { tabId, takeOver } : { tabId } }),
  /** keepalive lets the request finish as the page goes, and apiFetch adds the X-GCPE-Request header the server requires (C169), which navigator.sendBeacon can't. */
  release: (id: number, tabId: string) => apiFetch<void>(`${a(id)}/lock/release`, { method: "POST", body: { tabId }, keepalive: true }),
  // Never ?name=: a query string lands in every proxy's access logs, including a confidential
  // activity's file name (the server refuses it with 400 — apps/calendar/src/http/file-routes.ts).
  // apiFetch already passes `headers` through to `fetch` (RequestInit), so no client change is needed.
  addFile: (id: number, file: File) => apiFetch<ActivityFileView[]>(`${a(id)}/files`, { method: "POST", raw: file, headers: { "X-GCPE-File-Name": encodeURIComponent(file.name) } }),
  removeFile: (id: number, fileId: number) => apiFetch<ActivityFileView[]>(`${a(id)}/files/${fileId}`, { method: "DELETE" }),
  fileUrl: (id: number, fileId: number) => `${a(id)}/files/${fileId}`,
};
```

- [ ] **Step 5: Run them to see them pass, then the staff-web suite and its type-check**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web`
Expected: PASS (the list's tests read the extended `CONFIG` unchanged).
Run: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p apps/staff-web/tsconfig.json`. Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/staff-web/src/screens/calendar/list/types.ts apps/staff-web/src/screens/calendar/list/fixtures.tsx apps/staff-web/src/screens/calendar/activity
git commit -m "feat(staff-web): the activity editor's form model, paths and API module"
```

---

### Task 2: The edit lock in the browser

Covers: spec §7.5 (take on the first change, heartbeat at most once a minute, lapse after 15 idle minutes, someone else's name and since when, read-only without closing the tab, editing available without a reload when the lock lapses, "Continue here", release on save, cancel and tab close), C128, C169. Decision E18. Carry-forward: the keepalive release with the CSRF header. Review Focus 1, 5.

**Files:**
- Modify: `apps/staff-web/src/screens/calendar/list/dates.ts`, `apps/staff-web/src/screens/calendar/list/CalendarGrid.tsx` (move `timeText` to `dates.ts`, exported).
- Create: `apps/staff-web/src/screens/calendar/activity/useEditLock.ts`, `useEditLock.test.tsx`, `LockBanner.tsx`.

**Interfaces:**
- Consumes: `activityApi.lock`, `activityApi.release` (Task 1); `ApiError`.
- Produces:
  - `HEARTBEAT_MS = 60_000`, `IDLE_MS = 15 * 60_000`, `POLL_MS = 30_000`.
  - `type LockState = { kind: "none" } | { kind: "mine" } | { kind: "elsewhere" } | { kind: "other"; holderName: string; since: string } | { kind: "lapsed" }`.
  - `lockStateOf(lock: ActivityView["lock"]): LockState`.
  - `interface EditLock { tabId: string; state: LockState; problem: string | null; touch(): Promise<boolean>; continueHere(): Promise<void>; refused(e: unknown): void }`.
  - `useEditLock(o: { activityId: number | null; initial: ActivityView["lock"]; enabled: boolean; reload: () => Promise<ActivityView | null> }): EditLock`.
  - `LockBanner({ lock, timeZone }: { lock: EditLock; timeZone: string })`.
  - `timeText(iso: string, timeZone: string): string` exported from `list/dates.ts` ("9:00 AM", with a plain space, built from `formatToParts` so ICU's narrow no-break space never reaches the page or a test).

- [ ] **Step 1: Write the failing tests**

Create `apps/staff-web/src/screens/calendar/activity/useEditLock.test.tsx`:

```tsx
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityView } from "@gcpe/calendar-contract";
import { jsonResponse } from "../../../../test/jsonResponse";
import { HEARTBEAT_MS, IDLE_MS, POLL_MS, useEditLock } from "./useEditLock";

type Call = { url: string; init?: RequestInit };
const LOCK = "/calendar/api/activities/7/lock";
const RELEASE = "/calendar/api/activities/7/lock/release";
const lockCalls = (calls: Call[]) => calls.filter((c) => c.url === LOCK);
const ok = () => jsonResponse(200, { holderName: "Robin Staff", since: "2026-11-03T18:00:00.000Z", mine: true, tabId: "x" });
const lockedBy = (name: string) => jsonResponse(423, { code: "locked", error: `${name} is editing this activity (since 11:00)`, holder: { displayName: name, since: "2026-11-03T18:00:00.000Z" } });
function stub(calls: Call[], answer: (url: string, init?: RequestInit) => Response) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return answer(url, init);
  }));
}
const mount = (o: Partial<Parameters<typeof useEditLock>[0]> = {}) =>
  renderHook(() => useEditLock({ activityId: 7, initial: null, enabled: true, reload: async () => null, ...o }));

describe("useEditLock (spec addendum §7.5)", () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date("2026-11-03T18:00:00Z") }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("takes the lock on the first change, then sends a heartbeat at most once a minute", async () => {
    const calls: Call[] = [];
    stub(calls, ok);
    const { result } = mount();
    expect(result.current.state).toEqual({ kind: "none" });
    await act(async () => void expect(await result.current.touch()).toBe(true));
    expect(result.current.state).toEqual({ kind: "mine" });
    await act(async () => void (await result.current.touch()));
    expect(lockCalls(calls)).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      await result.current.touch();
    });
    expect(lockCalls(calls)).toHaveLength(2);
    expect(JSON.parse(String(lockCalls(calls)[0]!.init!.body))).toEqual({ tabId: result.current.tabId });
  });

  it("someone else's lock: refuses, names them, and opens without a reload once it has gone", async () => {
    const calls: Call[] = [];
    stub(calls, () => lockedBy("Sample Admin"));
    let lock: ActivityView["lock"] = { holderName: "Sample Admin", since: "2026-11-03T17:55:00.000Z", mine: false, tabId: null };
    const reload = vi.fn(async () => ({ lock }) as ActivityView);
    const { result } = mount({ initial: lock, reload });
    expect(result.current.state).toEqual({ kind: "other", holderName: "Sample Admin", since: "2026-11-03T17:55:00.000Z" });
    await act(async () => void expect(await result.current.touch()).toBe(false));
    expect(lockCalls(calls)).toHaveLength(0);
    lock = null;
    await act(async () => void (await vi.advanceTimersByTimeAsync(POLL_MS)));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(result.current.state).toEqual({ kind: "none" });
  });

  it("someone taking it first: the 423 names them", async () => {
    stub([], () => lockedBy("Sample Admin"));
    const { result } = mount();
    await act(async () => void expect(await result.current.touch()).toBe(false));
    expect(result.current.state).toMatchObject({ kind: "other", holderName: "Sample Admin" });
  });

  it("lapses after 15 minutes without input; the next change takes it again", async () => {
    const calls: Call[] = [];
    stub(calls, ok);
    const { result } = mount();
    await act(async () => void (await result.current.touch()));
    await act(async () => void (await vi.advanceTimersByTimeAsync(IDLE_MS)));
    expect(result.current.state).toEqual({ kind: "lapsed" });
    await act(async () => void expect(await result.current.touch()).toBe(true));
    expect(result.current.state).toEqual({ kind: "mine" });
    expect(lockCalls(calls)).toHaveLength(2);
  });

  it("the same user's other tab: Continue here moves the lock with takeOver", async () => {
    const calls: Call[] = [];
    stub(calls, ok);
    const { result } = mount({ initial: { holderName: "Robin Staff", since: "2026-11-03T17:55:00.000Z", mine: true, tabId: "another-tab" } });
    expect(result.current.state).toEqual({ kind: "elsewhere" });
    await act(async () => void (await result.current.continueHere()));
    expect(JSON.parse(String(lockCalls(calls)[0]!.init!.body))).toEqual({ tabId: result.current.tabId, takeOver: true });
    expect(result.current.state).toEqual({ kind: "mine" });
  });

  it("releases with keepalive and the CSRF header when the tab goes, and on leaving the page (C169)", async () => {
    const calls: Call[] = [];
    stub(calls, (url) => (url === RELEASE ? new Response(null, { status: 204 }) : ok()));
    const { result, unmount } = mount();
    await act(async () => void (await result.current.touch()));
    act(() => void window.dispatchEvent(new Event("pagehide")));
    const release = calls.find((c) => c.url === RELEASE)!;
    expect(release.init).toMatchObject({ method: "POST", keepalive: true });
    expect(new Headers(release.init!.headers).get("X-GCPE-Request")).toBe("1");
    expect(JSON.parse(String(release.init!.body))).toEqual({ tabId: result.current.tabId });
    await act(async () => void (await result.current.touch()));
    unmount();
    expect(calls.filter((c) => c.url === RELEASE)).toHaveLength(2);
  });

  it("a new activity has no lock to take", async () => {
    const calls: Call[] = [];
    stub(calls, ok);
    const { result } = mount({ activityId: null });
    await act(async () => void expect(await result.current.touch()).toBe(true));
    expect(calls).toEqual([]);
  });

  it("the freeze is a message to show, not someone's lock", async () => {
    stub([], () => jsonResponse(423, { code: "freeze", error: "You cannot make content changes between 4pm-5pm." }));
    const { result } = mount();
    await act(async () => void expect(await result.current.touch()).toBe(false));
    expect(result.current.state).toEqual({ kind: "none" });
    expect(result.current.problem).toBe("You cannot make content changes between 4pm-5pm.");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/calendar/activity/useEditLock.test.tsx`
Expected: FAIL. `./useEditLock` doesn't exist.

- [ ] **Step 3: Implement**

Create `apps/staff-web/src/screens/calendar/activity/useEditLock.ts`:

```ts
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActivityView } from "@gcpe/calendar-contract";
import { ApiError } from "../../../api/client";
import { activityApi } from "./api";

export const HEARTBEAT_MS = 60_000;
export const IDLE_MS = 15 * 60_000;
export const POLL_MS = 30_000;

export type LockState =
  | { kind: "none" }
  | { kind: "mine" }
  | { kind: "elsewhere" }
  | { kind: "other"; holderName: string; since: string }
  | { kind: "lapsed" };

/** A page that has just opened holds no lock of its own: one that is "mine" belongs to another tab. */
export function lockStateOf(lock: ActivityView["lock"]): LockState {
  if (!lock) return { kind: "none" };
  return lock.mine ? { kind: "elsewhere" } : { kind: "other", holderName: lock.holderName, since: lock.since };
}

export interface EditLock {
  tabId: string;
  state: LockState;
  /** A refusal that isn't a lock: the freeze, or the server out of reach. */
  problem: string | null;
  /** Call on every change: takes the lock, or keeps it alive. False means the change may not stand. */
  touch(): Promise<boolean>;
  /** "Continue here": moves this user's lock from another tab to this one. */
  continueHere(): Promise<void>;
  /** A save's 423, so the page shows who holds the lock. */
  refused(e: unknown): void;
}

/** The editor's side of the edit lock (spec addendum §7.5; C128, C169). */
export function useEditLock(o: { activityId: number | null; initial: ActivityView["lock"]; enabled: boolean; reload: () => Promise<ActivityView | null> }): EditLock {
  const tabId = useMemo(() => crypto.randomUUID(), []);
  const [state, setLockState] = useState<LockState>(() => lockStateOf(o.initial));
  const [problem, setProblem] = useState<string | null>(null);
  const current = useRef(state);
  const set = useCallback((s: LockState) => {
    current.current = s;
    setLockState(s);
  }, []);
  const lastBeat = useRef(0);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reload = useRef(o.reload);
  reload.current = o.reload;
  const id = o.activityId;
  const active = o.enabled && id !== null;

  const refused = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 423) {
      const body = e.body as { code?: string; holder?: { displayName: string; since: string } | null } | undefined;
      if (body?.code === "locked" && body.holder) set({ kind: "other", holderName: body.holder.displayName, since: body.holder.since });
      else if (body?.code === "locked_elsewhere") set({ kind: "elsewhere" });
      else setProblem(e.message);
    } else if (e instanceof ApiError && e.status === 404) {
      setProblem("This activity is no longer available to you.");
    } else {
      setProblem("Couldn't reach the server to start editing. Try again.");
    }
  }, [set]);

  const armIdle = useCallback(() => {
    if (idle.current) clearTimeout(idle.current);
    idle.current = setTimeout(() => {
      if (current.current.kind === "mine") set({ kind: "lapsed" });
    }, IDLE_MS);
  }, [set]);

  const take = useCallback(async (takeOver: boolean): Promise<boolean> => {
    try {
      await activityApi.lock(id!, tabId, takeOver);
      lastBeat.current = Date.now();
      setProblem(null);
      set({ kind: "mine" });
      armIdle();
      return true;
    } catch (e) {
      refused(e);
      return false;
    }
  }, [id, tabId, set, armIdle, refused]);

  const touch = useCallback(async (): Promise<boolean> => {
    if (!active) return true;
    const s = current.current;
    if (s.kind === "other" || s.kind === "elsewhere") return false;
    if (s.kind !== "mine") return take(false);
    armIdle();
    if (Date.now() - lastBeat.current >= HEARTBEAT_MS) {
      lastBeat.current = Date.now();
      void activityApi.lock(id!, tabId).catch(refused);
    }
    return true;
  }, [active, id, tabId, take, armIdle, refused]);

  const continueHere = useCallback(async () => {
    if (active) await take(true);
  }, [active, take]);

  // While someone else, or this user's other tab, holds it: look again every 30 seconds, so
  // editing opens without a reload once the lock has gone (spec addendum §7.5).
  useEffect(() => {
    if (!active || (state.kind !== "other" && state.kind !== "elsewhere")) return;
    const t = setInterval(() => {
      void reload.current().then(
        (v) => {
          if (v) set(lockStateOf(v.lock));
        },
        () => undefined,
      );
    }, POLL_MS);
    return () => clearInterval(t);
  }, [active, state.kind, set]);

  // This tab's own lock goes when the page does: leaving it, and closing or reloading the tab.
  useEffect(() => {
    if (!active) return;
    const release = () => {
      const k = current.current.kind;
      if (k !== "mine" && k !== "lapsed") return;
      void activityApi.release(id!, tabId).catch(() => undefined);
      set({ kind: "none" });
    };
    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("pagehide", release);
      if (idle.current) clearTimeout(idle.current);
      release();
    };
  }, [active, id, tabId, set]);

  return { tabId, state, problem, touch, continueHere, refused };
}
```

Move `timeText` out of `apps/staff-web/src/screens/calendar/list/CalendarGrid.tsx` into `list/dates.ts`, unchanged except for `export`, and import it back into `CalendarGrid.tsx` from `./dates`:

```ts
/** "9:00 AM" in the tenant's zone, with a plain space: formatToParts keeps ICU's narrow no-break space out. */
export function timeText(iso: string, timeZone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]),
  );
  return `${p.hour}:${p.minute} ${p.dayPeriod}`;
}
```

Create `apps/staff-web/src/screens/calendar/activity/LockBanner.tsx`:

```tsx
import { Button, InlineAlert } from "@bcgov/design-system-react-components";
import { timeText } from "../list/dates";
import type { EditLock } from "./useEditLock";

/** The lock as the person at this page needs to know it (spec addendum §7.5). Nothing shows while it is theirs. */
export function LockBanner({ lock, timeZone }: { lock: EditLock; timeZone: string }): React.JSX.Element | null {
  const s = lock.state;
  if (s.kind === "other") {
    return (
      <div role="status">
        <InlineAlert
          variant="info"
          title="Someone else is editing"
          description={`${s.holderName} is editing this activity (since ${timeText(s.since, timeZone)}). It opens for editing when they save or cancel, or after 15 minutes without input.`}
        />
      </div>
    );
  }
  if (s.kind === "elsewhere") {
    return (
      <InlineAlert
        variant="warning"
        title="Open in another tab"
        description="You're editing this activity in another tab."
        buttons={<Button onPress={() => void lock.continueHere()}>Continue here</Button>}
      />
    );
  }
  if (s.kind === "lapsed") {
    return (
      <div role="status">
        <InlineAlert
          variant="warning"
          title="Edit lock lapsed"
          description="Your edit lock lapsed after 15 minutes without input. Your changes are still here, and Save still works if no one else has changed the activity."
        />
      </div>
    );
  }
  return lock.problem ? <InlineAlert variant="danger" role="alert" description={lock.problem} /> : null;
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/calendar`
Expected: PASS (the calendar grid's tests prove the moved `timeText` unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/staff-web/src/screens/calendar/activity/useEditLock.ts apps/staff-web/src/screens/calendar/activity/useEditLock.test.tsx apps/staff-web/src/screens/calendar/activity/LockBanner.tsx apps/staff-web/src/screens/calendar/list/dates.ts apps/staff-web/src/screens/calendar/list/CalendarGrid.tsx
git commit -m "feat(staff-web): the activity editor's edit lock: heartbeat, idle lapse, polling, Continue here, keepalive release"
```

---
### Task 3: The editor screen: fieldsets, validation, read-only states, save, and the way in from the list

Covers: spec §8.2 (fieldsets in legacy's order; Potential Dates shown, C136; Other City only with "Other…"; Release fieldset hidden; Look Ahead fieldset per §6 with inferred value and gold override; Markup for HQ; freeze and lock states; the shared validation with server errors against their fields), §7.2 (warnings for past dates), §7.4 (read-only during the freeze for non-exempt users), §7.5 (read-only while someone else holds the lock; 409 "reload"; returning after save, C149), §6 (not visible is "not found"). Decisions E14, E15, E16, E17, E20, E22. Carry-forward: titles link to the activity page; return to the list's own URL. Review Focus 1, 2, 3, 4, 5.

**Files:**
- Modify: `apps/staff-web/src/router.tsx`, `apps/staff-web/src/styles/global.css`, `apps/staff-web/src/screens/calendar/list/cells.tsx`, `list/CalendarGrid.tsx`, `list/ActivityListScreen.tsx`, `list/ActivityListScreen.test.tsx`.
- Create: `apps/staff-web/src/screens/calendar/activity/fields.tsx`, `ActivityForm.tsx`, `ActivityScreen.tsx`, `fixtures.tsx`, `ActivityScreen.test.tsx`, `a11y.test.tsx`.

**Interfaces:**
- Consumes: Task 1's `form.ts`, `paths.ts`, `activityApi`; Task 2's `useEditLock`, `LockBanner`, `timeText`; `listApi.config`, `todayIn`; `checkActivity`, `inferLookAhead`, `friendlySpan`, `warningsFor`, `releaseFieldsetHidden`.
- Produces:
  - `fields.tsx`: `TextField`, `SelectField`, `CheckField`, `CheckList`, `TagField`, `DateTimeField` (each takes `id`, `label`, and optional `error: string[]`, `review: boolean`, `hint: string`, `required: boolean`).
  - `ActivityForm(props: ActivityFormProps)` with `release: ReactNode` and `records: ReactNode` slots (Tasks 4 and 5 fill them).
  - `ActivityRoute`, `ActivityScreen({ idParam })`, and the internal `ActivityEditor`, which exposes to Tasks 4 and 5: `leave(to: string, notice: string, replace?: boolean)`, `view`/`setView`, `dirty`, `readOnly`, `lock`.
  - `fixtures.tsx`: `FIELDS`, `view(over)`, `EDITOR_OPTIONS`, `type Call`, `stubActivity(calls, stub)`, `ListStub`, `renderActivity(path)`.
  - `TitleLink({ id, children })` exported from `list/cells.tsx`.

- [ ] **Step 1: The test fixtures**

Create `apps/staff-web/src/screens/calendar/activity/fixtures.tsx`:

```tsx
import { render } from "@testing-library/react";
import { vi } from "vitest";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import type { ActivityFields, ActivityView, EditorOptions } from "@gcpe/calendar-contract";
import { jsonResponse } from "../../../../test/jsonResponse";
import { RequireAuth } from "../../../session/RequireAuth";
import { SessionProvider } from "../../../session/SessionContext";
import { CalendarSection } from "../CalendarSection";
import { CONFIG, ME } from "../list/fixtures";
import type { CalendarConfigView } from "../list/types";
import { ActivityRoute } from "./ActivityScreen";

export const FIELDS: ActivityFields = {
  categoryId: 32, title: "Sample activity", details: "Sample summary", significance: "Sample significance", strategy: "", schedule: "Sample scheduling",
  comments: "", leadOrganization: "", venue: "", otherCity: "", potentialDates: "",
  isIssue: false, isConfidential: false, isMilestone: false, isCrossGovernment: false, isAtLegislature: false, isAllDay: false, isConfirmed: true,
  startDate: "2031-11-10", startTime: "09:00", endDate: "2031-11-10", endTime: "10:00", nrDate: null, nrTime: null,
  contactMinistryKey: "health", commContactId: 11, governmentRepresentativeId: null, cityId: 1, premierRequestedId: null, nrDistributionId: null,
  eventPlannerId: null, videographerId: null, nrOriginId: null,
  commMaterialIds: [], initiativeIds: [], keywordNames: [], sectorKeys: [], themeKeys: [], tagKeys: [], sharedWithKeys: [], translations: [],
};

export function view(over: Partial<ActivityView> = {}): ActivityView {
  return {
    id: 20001, ministryAbbreviation: "HLTH", version: 3, status: "new", isDeleted: false, fields: FIELDS,
    startAt: "2031-11-10T17:00:00.000Z", endAt: "2031-11-10T18:00:00.000Z", nrAt: null, lookAhead: null, needsReview: [],
    createdAt: "2026-11-01T17:00:00.000Z", lastUpdatedAt: "2026-11-02T17:00:00.000Z", lastUpdatedByName: "Robin Staff", lock: null,
    can: { edit: true, clone: true, delete: false, review: false }, watch: { isWatched: false, watcherNames: [] }, files: [], releases: [],
    ...over,
  };
}

const opt = (id: number, name: string, isActive = true) => ({ id, name, isActive });
export const EDITOR_OPTIONS: EditorOptions = {
  categories: [opt(32, "Sample category"), opt(2, "Sample awareness"), opt(12, "Sample proposed release"), opt(33, "Sample HQ placeholder", false), opt(34, "Sample retired category", false)],
  cities: [opt(1, "Sample City"), opt(311, "Other...")],
  commMaterials: [opt(1, "Sample news release")],
  eventPlanners: [opt(1, "Sample Planner")],
  representatives: [opt(1, "Sample Representative")],
  initiatives: [{ ...opt(1, "Sample initiative"), shortName: "SI" }],
  keywords: [opt(1, "Sample tag")],
  distributions: [opt(1, "Sample distribution")],
  origins: [opt(1, "Sample origin")],
  premierRequested: [opt(1, "Sample yes")],
  videographers: [opt(1, "Sample Videographer")],
  ministries: [
    { key: "health", abbreviation: "HLTH", name: "Sample Health", isActive: true },
    { key: "finance", abbreviation: "FIN", name: "Sample Finance", isActive: true },
    { key: "gcpe-hq", abbreviation: "HQ", name: "Sample HQ", isActive: true },
  ],
  commContacts: [{ id: 11, ministryKey: "health", name: "Robin Staff", rank: 4, isActive: true }, { id: 12, ministryKey: "finance", name: "Kim Finance", rank: 1, isActive: true }],
  sectors: [{ key: "sample-sector", name: "Sample sector", isActive: true }],
  themes: [{ key: "sample-theme", name: "Sample theme", isActive: true }],
  tags: [{ key: "sample-tag", name: "Sample news tag", isActive: true }],
};

export interface Call {
  url: string;
  init?: RequestInit;
}
export interface ActivityStub {
  me?: object;
  config?: CalendarConfigView;
  roles?: string[];
  /** The activity GET answers this; a function sees the id, and may answer a Response (a 404). */
  view?: ActivityView | ((id: number) => ActivityView | Response);
  /** Answers first; return undefined to fall through. May throw, as a network failure does. */
  other?: (url: string, init?: RequestInit) => Response | undefined;
}

export function stubActivity(calls: Call[], s: ActivityStub = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const custom = s.other?.(url, init);
      if (custom) return custom;
      const method = init?.method ?? "GET";
      if (url === "/core/auth/session") {
        return jsonResponse(200, { user: { id: "u1", name: "Robin Staff", email: "robin.staff@example.test", roles: s.roles ?? ["Calendar.Editor"] }, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
      }
      if (url === "/calendar/api/me") return jsonResponse(200, s.me ?? ME);
      if (url === "/calendar/api/config") return jsonResponse(200, s.config ?? CONFIG);
      if (url === "/calendar/api/editor-options") return jsonResponse(200, EDITOR_OPTIONS);
      const m = /^\/calendar\/api\/activities\/(\d+)$/.exec(url);
      if (m && method === "GET") {
        const v = typeof s.view === "function" ? s.view(Number(m[1])) : (s.view ?? view());
        return v instanceof Response ? v : jsonResponse(200, v);
      }
      if (/\/lock$/.test(url) && method === "PUT") return jsonResponse(200, { holderName: "Robin Staff", since: "2026-11-03T18:00:00.000Z", mine: true, tabId: "t" });
      if (/\/lock\/release$/.test(url)) return new Response(null, { status: 204 });
      throw new Error(`unhandled: ${method} ${url}`);
    }),
  );
}

/** Stands in for the list: shows the notice the editor leaves. */
export function ListStub(): React.JSX.Element {
  const state = useLocation().state as { calendarNotice?: string } | null;
  return (
    <>
      <h1>Sample list</h1>
      {state?.calendarNotice && <p role="status">{state.calendarNotice}</p>}
    </>
  );
}

/** A data router (the editor's leave-page guard needs one), with the Calendar section around the editor. */
export function renderActivity(path: string) {
  const router = createMemoryRouter(
    [
      {
        path: "/calendar",
        element: (
          <RequireAuth>
            <CalendarSection />
          </RequireAuth>
        ),
        children: [
          { index: true, element: <ListStub /> },
          { path: "activities/new", element: <ActivityRoute /> },
          { path: "activities/:id", element: <ActivityRoute /> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  const rendered = render(
    <SessionProvider>
      <RouterProvider router={router} />
    </SessionProvider>,
  );
  return { router, ...rendered };
}
```

- [ ] **Step 2: Write the failing tests**

Create `apps/staff-web/src/screens/calendar/activity/ActivityScreen.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { jsonResponse } from "../../../../test/jsonResponse";
import { CONFIG, HQ_ADMIN_CONFIG, HQ_ADMIN_ME, ME } from "../list/fixtures";
import { FIELDS, renderActivity, stubActivity, view, type Call } from "./fixtures";

const ACTIVITY = "/calendar/api/activities/20001";
const isPut = (c: Call) => c.init?.method === "PUT" && c.url === ACTIVITY;
const putBody = (calls: Call[]) => JSON.parse(String(calls.find(isPut)!.init!.body)) as Record<string, unknown>;
const savedOk = (url: string, init?: RequestInit) => (url === ACTIVITY && init?.method === "PUT" ? jsonResponse(200, { id: 20001, activity: view({ version: 4 }), warnings: [] }) : undefined);
const title = () => screen.findByRole("textbox", { name: "Title" });
const NOT_EDITABLE = { edit: false, clone: false, delete: false, review: false };

describe("the activity editor (spec addendum §8.2)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opens an activity with legacy's fieldsets, in legacy's order, holding the stored values", async () => {
    stubActivity([]);
    const { container } = renderActivity("/calendar/activities/20001");
    expect(await screen.findByRole("heading", { level: 1, name: "Activity HLTH-20001" })).toBeInTheDocument();
    expect([...container.querySelectorAll(".gcpe-fieldset > legend")].map((l) => l.textContent)).toEqual(["Overview", "Planning", "Ministry", "Schedule", "Release", "Event"]);
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Sample activity");
    expect(screen.getByRole("combobox", { name: "Comm Contact" })).toHaveValue("11");
    expect(screen.getByRole("combobox", { name: "Start time" })).toHaveValue("09:00");
    expect(screen.getByRole("textbox", { name: "Potential Dates" })).toHaveValue("");
    expect(screen.queryByRole("textbox", { name: "Other City" })).toBeNull();
  });

  it("Save sends the fields with the change, the version and this tab's id, and no Look Ahead fields, then goes back where the user came from (C149)", async () => {
    const calls: Call[] = [];
    stubActivity(calls, { other: savedOk });
    const back = "/calendar?q=%7B%22filter%22%3A%7B%7D%7D";
    const { router } = renderActivity(`/calendar/activities/20001?return=${encodeURIComponent(back)}`);
    const t = await title();
    await userEvent.clear(t);
    await userEvent.type(t, "Sample renamed");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Sample list" })).toBeInTheDocument();
    expect(`${router.state.location.pathname}${router.state.location.search}`).toBe(back);
    expect(screen.getByText("Saved HLTH-20001.")).toBeInTheDocument();
    const body = putBody(calls);
    expect(body).toMatchObject({ ...FIELDS, title: "Sample renamed", version: 3 });
    expect(typeof body.tabId).toBe("string");
    expect(body).not.toHaveProperty("lookAhead");
    expect(calls.filter((c) => c.url.endsWith("/lock") && c.init?.method === "PUT")).toHaveLength(1);
  });

  it("the form's own check stops a save and lists each problem, linked to its field", async () => {
    const calls: Call[] = [];
    stubActivity(calls);
    renderActivity("/calendar/activities/20001");
    const t = await title();
    await userEvent.clear(t);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const summary = await screen.findByRole("alert");
    expect(summary).toHaveTextContent("Fix these to save");
    expect(within(summary).getByRole("link", { name: "Enter a title" })).toHaveAttribute("href", "#activity-title");
    await waitFor(() => expect(summary).toHaveFocus());
    expect(t).toHaveAttribute("aria-invalid", "true");
    expect(t).toHaveAccessibleDescription(/Enter a title/);
    expect(calls.some(isPut)).toBe(false);
  });

  it("the server's 422 shows against its field and keeps the changes", async () => {
    stubActivity([], {
      other: (url, init) =>
        url === ACTIVITY && init?.method === "PUT" ? jsonResponse(422, { error: "Fix the fields named", errors: [{ field: "commContactId", message: "That comm contact is no longer active" }] }) : undefined,
    });
    renderActivity("/calendar/activities/20001");
    const venue = await screen.findByRole("textbox", { name: "Venue" });
    await userEvent.type(venue, "Sample hall");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("link", { name: "That comm contact is no longer active" })).toHaveAttribute("href", "#activity-commContactId");
    expect(screen.getByRole("combobox", { name: "Comm Contact" })).toHaveAttribute("aria-invalid", "true");
    expect(venue).toHaveValue("Sample hall");
  });

  it("a 409 keeps the changes, says someone else changed it, and Reload shows theirs", async () => {
    let current = view();
    stubActivity([], {
      view: () => current,
      other: (url, init) =>
        url === ACTIVITY && init?.method === "PUT" ? jsonResponse(409, { code: "version_conflict", error: "Someone else changed this activity — reload to see their changes" }) : undefined,
    });
    renderActivity("/calendar/activities/20001");
    await userEvent.type(await screen.findByRole("textbox", { name: "Venue" }), "Sample hall");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Someone else changed this activity — reload to see their changes")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Venue" })).toHaveValue("Sample hall");
    current = view({ version: 5, fields: { ...FIELDS, title: "Sample theirs" } });
    await userEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Sample theirs"));
    expect(screen.getByRole("textbox", { name: "Venue" })).toHaveValue("");
  });

  it("a 423 on save keeps the changes and names who holds the lock", async () => {
    stubActivity([], {
      other: (url, init) =>
        url === ACTIVITY && init?.method === "PUT"
          ? jsonResponse(423, { code: "locked", error: "Sample Admin is editing this activity (since 11:00)", holder: { displayName: "Sample Admin", since: "2026-11-03T18:00:00.000Z" } })
          : undefined,
    });
    renderActivity("/calendar/activities/20001");
    await userEvent.type(await screen.findByRole("textbox", { name: "Venue" }), "Sample hall");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Sample Admin is editing this activity (since 11:00 AM)", { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Venue" })).toHaveValue("Sample hall");
  });

  it("a network failure keeps the changes and says so", async () => {
    stubActivity([], {
      other: (url, init) => {
        if (url === ACTIVITY && init?.method === "PUT") throw new TypeError("Failed to fetch");
        return undefined;
      },
    });
    renderActivity("/calendar/activities/20001");
    await userEvent.type(await screen.findByRole("textbox", { name: "Venue" }), "Sample hall");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Couldn't save. Your changes are still here; try again.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Venue" })).toHaveValue("Sample hall");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it.each([
    ["a Read Only user", { me: { ...ME, role: "Calendar.ReadOnly", level: 1 }, view: view({ can: NOT_EDITABLE }) }, "You can view this activity but not change it."],
    ["a shared ministry", { me: { ...ME, ministryKeys: ["finance"] }, view: view({ can: NOT_EDITABLE, fields: { ...FIELDS, sharedWithKeys: ["finance"] } }) }, "Your ministry is shared on this activity: you can view it but not change it."],
    ["the freeze", { config: { ...CONFIG, freeze: { ...CONFIG.freeze, active: true, appliesToYou: true } } }, "You cannot make content changes between 4pm-5pm."],
    ["a deleted activity", { view: view({ isDeleted: true, can: NOT_EDITABLE }) }, "This activity is deleted."],
    ["someone else's lock", { view: view({ lock: { holderName: "Sample Admin", since: "2026-11-03T18:00:00.000Z", mine: false, tabId: null } }) }, "Sample Admin is editing this activity (since 11:00 AM)."],
  ])("%s sees the form read-only, saying why", async (_who, stub, why) => {
    stubActivity([], stub);
    renderActivity("/calendar/activities/20001");
    expect(await screen.findByText(why, { exact: false })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Title" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("a first change that can't take the lock is undone, and the page says who holds it", async () => {
    stubActivity([], {
      other: (url, init) =>
        url.endsWith("/lock") && init?.method === "PUT"
          ? jsonResponse(423, { code: "locked", error: "Sample Admin is editing this activity (since 11:00)", holder: { displayName: "Sample Admin", since: "2026-11-03T18:00:00.000Z" } })
          : undefined,
    });
    renderActivity("/calendar/activities/20001");
    const venue = await screen.findByRole("textbox", { name: "Venue" });
    await userEvent.type(venue, "X");
    expect(await screen.findByText("Sample Admin is editing this activity", { exact: false })).toBeInTheDocument();
    await waitFor(() => expect(venue).toHaveValue(""));
    expect(venue).toBeDisabled();
  });

  it("HQ sees the Look Ahead fieldset; the section follows the inference until chosen, and the choice is sent (spec addendum §7.6)", async () => {
    const calls: Call[] = [];
    const la = { hqComments: "", hqStatus: null, hqSection: "in_the_news" as const, longTermOutlook: false };
    stubActivity(calls, {
      me: HQ_ADMIN_ME,
      config: HQ_ADMIN_CONFIG,
      view: view({ fields: { ...FIELDS, lookAhead: la }, lookAhead: { ...la, inferred: { kind: "section", section: "in_the_news" } } }),
      other: savedOk,
    });
    renderActivity("/calendar/activities/20001");
    const section = await screen.findByRole("combobox", { name: "LA Section" });
    expect(section).toHaveValue("in_the_news");
    await userEvent.click(screen.getByRole("checkbox", { name: "Issue" }));
    expect(section).toHaveValue("issues_and_reports");
    await userEvent.selectOptions(section, "not_on_la");
    expect(section).toHaveAccessibleDescription("Override (inferred: Issues & Reports)");
    await userEvent.click(screen.getByRole("checkbox", { name: "Dates Confirmed" }));
    expect(section).toHaveValue("not_on_la");
    await userEvent.click(screen.getByRole("button", { name: "Use the inferred section" }));
    expect(section).toHaveValue("issues_and_reports");
    await userEvent.selectOptions(section, "events_and_speeches");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("heading", { level: 1, name: "Sample list" });
    expect(putBody(calls).lookAhead).toEqual({ ...la, hqSection: "events_and_speeches" });
  });

  it("needs-review markup is in each flagged field's description, for HQ (Activity.aspx.cs:1071-1074)", async () => {
    stubActivity([], { me: HQ_ADMIN_ME, config: HQ_ADMIN_CONFIG, view: view({ needsReview: ["title", "start_date"] }) });
    renderActivity("/calendar/activities/20001");
    expect(await title()).toHaveAccessibleDescription(/Changed: needs review/);
    expect(screen.getByRole("textbox", { name: "Potential Dates" })).toHaveAccessibleDescription(/Changed: needs review/);
    expect(screen.getByRole("textbox", { name: "Summary" })).not.toHaveAccessibleDescription(/needs review/);
  });

  it("a category that hides the Release fieldset hides it and sends no release time", async () => {
    const calls: Call[] = [];
    stubActivity(calls, { view: view({ fields: { ...FIELDS, nrDate: "2031-11-10", nrTime: "08:00" } }), other: savedOk });
    renderActivity("/calendar/activities/20001");
    expect(await screen.findByRole("group", { name: "Release" })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Category" }), "2");
    expect(screen.queryByRole("group", { name: "Release" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("heading", { level: 1, name: "Sample list" });
    expect(putBody(calls)).toMatchObject({ categoryId: 2, nrDate: null, nrTime: null });
  });

  it("Other City shows only with the city 'Other…'", async () => {
    stubActivity([]);
    renderActivity("/calendar/activities/20001");
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "City" }), "311");
    expect(screen.getByRole("textbox", { name: "Other City" })).toBeInTheDocument();
  });

  it("a past start date is a warning, not a stop", async () => {
    stubActivity([], { view: view({ fields: { ...FIELDS, startDate: "2020-01-06", endDate: "2020-01-06" } }) });
    renderActivity("/calendar/activities/20001");
    expect(await screen.findByText("The start date is in the past.")).toBeInTheDocument();
  });

  it("a new activity starts at 8:00 AM to 6:00 PM in the user's only ministry; saving opens it (Activity.aspx.cs:1066)", async () => {
    const calls: Call[] = [];
    stubActivity(calls, {
      view: () => view({ id: 20002 }),
      other: (url, init) => (url === "/calendar/api/activities" && init?.method === "POST" ? jsonResponse(201, { id: 20002, activity: view({ id: 20002 }), warnings: [] }) : undefined),
    });
    const { router } = renderActivity(`/calendar/activities/new?return=${encodeURIComponent("/calendar")}`);
    expect(await screen.findByRole("heading", { level: 1, name: "New activity" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Start time" })).toHaveValue("08:00");
    expect(screen.getByRole("combobox", { name: "End time" })).toHaveValue("18:00");
    expect(screen.getByRole("combobox", { name: "Lead Ministry" })).toHaveValue("health");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Category" }), "32");
    await userEvent.type(screen.getByRole("textbox", { name: "Title" }), "Sample new");
    await userEvent.type(screen.getByRole("textbox", { name: "Summary" }), "Sample summary");
    await userEvent.type(screen.getByRole("textbox", { name: "Significance" }), "Sample significance");
    await userEvent.type(screen.getByRole("textbox", { name: "Scheduling considerations" }), "Sample scheduling");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Comm Contact" }), "11");
    fireEvent.change(screen.getByLabelText(/^Start date/), { target: { value: "2031-11-10" } });
    fireEvent.change(screen.getByLabelText(/^End date/), { target: { value: "2031-11-10" } });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Activity HLTH-20002" })).toBeInTheDocument();
    expect(screen.getByText("Created HLTH-20002.")).toBeInTheDocument();
    expect(`${router.state.location.pathname}${router.state.location.search}`).toBe("/calendar/activities/20002?return=%2Fcalendar");
    const post = JSON.parse(String(calls.find((c) => c.init?.method === "POST")!.init!.body));
    expect(post).toMatchObject({ title: "Sample new", startDate: "2031-11-10", startTime: "08:00", endTime: "18:00", contactMinistryKey: "health", commContactId: 11 });
    expect(calls.filter((c) => c.url.endsWith("/lock"))).toHaveLength(0);
  });

  it("a save the writer can't see goes back with the server's message", async () => {
    stubActivity([], {
      other: (url, init) =>
        url === ACTIVITY && init?.method === "PUT" ? jsonResponse(200, { id: 20001, activity: null, warnings: ["Saved. You can't view confidential activities for this ministry."] }) : undefined,
    });
    renderActivity("/calendar/activities/20001");
    await userEvent.click(await screen.findByRole("checkbox", { name: "Not for Look Ahead" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved. You can't view confidential activities for this ministry.")).toBeInTheDocument();
  });

  it.each([
    ["a malformed id", "/calendar/activities/abc", undefined],
    ["an id the user can't see", "/calendar/activities/20001", jsonResponse(404, { error: "not found" })],
  ])("%s is 'Activity not found'", async (_what, path, answer) => {
    const calls: Call[] = [];
    stubActivity(calls, answer ? { view: () => answer } : {});
    renderActivity(path);
    expect(await screen.findByRole("heading", { level: 1, name: "Activity not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to the Calendar" })).toHaveAttribute("href", "/calendar");
    if (!answer) expect(calls.some((c) => c.url.startsWith("/calendar/api/activities/"))).toBe(false);
  });

  it("leaving with unsaved changes asks first; Stay keeps them, Leave goes", async () => {
    stubActivity([]);
    renderActivity("/calendar/activities/20001?return=%2Fcalendar");
    await userEvent.type(await screen.findByRole("textbox", { name: "Venue" }), "Sample hall");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Unsaved changes" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Stay" }));
    expect(screen.getByRole("textbox", { name: "Venue" })).toHaveValue("Sample hall");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Leave" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Sample list" })).toBeInTheDocument();
  });
});
```

Create `apps/staff-web/src/screens/calendar/activity/a11y.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { HQ_ADMIN_CONFIG, HQ_ADMIN_ME } from "../list/fixtures";
import { FIELDS, renderActivity, stubActivity, view } from "./fixtures";

async function seriousViolations(container: Element) {
  const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}

describe("accessibility: the activity editor in every state", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("editing", async () => {
    stubActivity([]);
    const { container } = renderActivity("/calendar/activities/20001");
    await screen.findByRole("textbox", { name: "Title" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("HQ, with the Look Ahead fieldset overridden and review markup", async () => {
    const la = { hqComments: "", hqStatus: "new" as const, hqSection: "not_on_la" as const, longTermOutlook: true };
    stubActivity([], { me: HQ_ADMIN_ME, config: HQ_ADMIN_CONFIG, view: view({ needsReview: ["title"], fields: { ...FIELDS, lookAhead: la }, lookAhead: { ...la, inferred: { kind: "section", section: "in_the_news" } } }) });
    const { container } = renderActivity("/calendar/activities/20001");
    await screen.findByRole("button", { name: "Use the inferred section" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("read-only under someone else's lock", async () => {
    stubActivity([], { view: view({ lock: { holderName: "Sample Admin", since: "2026-11-03T18:00:00.000Z", mine: false, tabId: null } }) });
    const { container } = renderActivity("/calendar/activities/20001");
    await screen.findByText("Sample Admin is editing this activity", { exact: false });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("the error summary", async () => {
    stubActivity([]);
    const { container } = renderActivity("/calendar/activities/20001");
    await userEvent.clear(await screen.findByRole("textbox", { name: "Title" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Fix these to save");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("a new activity", async () => {
    stubActivity([]);
    const { container } = renderActivity("/calendar/activities/new");
    await screen.findByRole("heading", { level: 1, name: "New activity" });
    expect(await seriousViolations(container)).toEqual([]);
  });
});
```

Append to `apps/staff-web/src/screens/calendar/list/ActivityListScreen.test.tsx`, inside its top-level `describe` (it already imports `renderList`, `stubFetch`, `CONFIG`, `screen`, `cleanup` and `vi`; add any of those it doesn't):

```tsx
  it("titles open the activity, carrying this list's address back; New activity shows for creators", async () => {
    stubFetch([]);
    const path = `/calendar?q=${encodeURIComponent(JSON.stringify({ filter: { quickSearch: "Sample" } }))}`;
    renderList(path);
    expect(await screen.findByRole("link", { name: "Sample listed" })).toHaveAttribute("href", `/calendar/activities/20001?return=${encodeURIComponent(path)}`);
    expect(screen.getByRole("link", { name: "New activity" })).toHaveAttribute("href", `/calendar/activities/new?return=${encodeURIComponent(path)}`);
  });

  it("no New activity for a user who can't create", async () => {
    stubFetch([], { config: { ...CONFIG, editor: { ...CONFIG.editor, create: false } } });
    renderList();
    await screen.findByRole("link", { name: "Sample listed" });
    expect(screen.queryByRole("link", { name: "New activity" })).toBeNull();
  });
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/calendar`
Expected: FAIL. `./ActivityScreen` doesn't exist, and the list has no links.

- [ ] **Step 4: The field components**

Create `apps/staff-web/src/screens/calendar/activity/fields.tsx`:

```tsx
import { useState } from "react";
import type { Choice } from "./form";

interface Common {
  id: string;
  label: string;
  error?: string[];
  /** HQ's needs-review markup (spec addendum §8.2 "Markup"). */
  review?: boolean;
  hint?: string;
  required?: boolean;
}

function describedBy(id: string, p: Pick<Common, "error" | "review" | "hint">): string | undefined {
  const ids = [p.review && `${id}-review`, p.hint && `${id}-hint`, p.error?.length && `${id}-error`].filter(Boolean);
  return ids.length ? ids.join(" ") : undefined;
}

function Notes({ id, p }: { id: string; p: Pick<Common, "error" | "review" | "hint"> }) {
  return (
    <>
      {p.review && (
        <span id={`${id}-review`} className="gcpe-review-mark">
          Changed: needs review
        </span>
      )}
      {p.hint && (
        <span id={`${id}-hint`} className="gcpe-hint">
          {p.hint}
        </span>
      )}
      {p.error?.length ? (
        <span id={`${id}-error`} className="gcpe-field-error">
          {p.error.join(" ")}
        </span>
      ) : null}
    </>
  );
}

function Label({ id, label, required }: { id: string; label: string; required?: boolean }) {
  return (
    <label htmlFor={id}>
      {label}
      {required && <span aria-hidden="true"> *</span>}
    </label>
  );
}

const wrap = (p: Pick<Common, "review">, base = "gcpe-field") => `${base}${p.review ? " gcpe-needs-review" : ""}`;
const invalid = (p: Pick<Common, "error">) => (p.error?.length ? true : undefined);

export function TextField(p: Common & { value: string; onChange: (v: string) => void; multiline?: boolean; rows?: number }): React.JSX.Element {
  const attrs = {
    id: p.id,
    value: p.value,
    "aria-invalid": invalid(p),
    "aria-describedby": describedBy(p.id, p),
    "aria-required": p.required || undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => p.onChange(e.target.value),
  };
  return (
    <div className={wrap(p)}>
      <Label id={p.id} label={p.label} required={p.required} />
      {p.multiline ? <textarea rows={p.rows ?? 3} {...attrs} /> : <input type="text" {...attrs} />}
      <Notes id={p.id} p={p} />
    </div>
  );
}

export function SelectField(p: Common & { value: string; onChange: (v: string) => void; options: Choice[]; empty?: string }): React.JSX.Element {
  return (
    <div className={wrap(p)}>
      <Label id={p.id} label={p.label} required={p.required} />
      <select id={p.id} value={p.value} onChange={(e) => p.onChange(e.target.value)} aria-invalid={invalid(p)} aria-describedby={describedBy(p.id, p)} aria-required={p.required || undefined}>
        {p.empty !== undefined && <option value="">{p.empty}</option>}
        {p.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Notes id={p.id} p={p} />
    </div>
  );
}

export function CheckField(p: Common & { checked: boolean; onChange: (v: boolean) => void }): React.JSX.Element {
  return (
    <div className={wrap(p, "gcpe-check")}>
      <input type="checkbox" id={p.id} checked={p.checked} onChange={(e) => p.onChange(e.target.checked)} aria-describedby={describedBy(p.id, p)} />
      <label htmlFor={p.id}>{p.label}</label>
      <Notes id={p.id} p={p} />
    </div>
  );
}

/** A set of checkboxes in its own fieldset: the multi-value fields (comm materials, shared-with, terms, translations). */
export function CheckList(p: Common & { values: readonly string[]; onChange: (v: string[]) => void; options: Choice[] }): React.JSX.Element {
  const toggle = (v: string, on: boolean) => p.onChange(on ? [...p.values, v] : p.values.filter((x) => x !== v));
  return (
    <fieldset id={p.id} className={wrap(p, "gcpe-checklist")} aria-describedby={describedBy(p.id, p)}>
      <legend>
        {p.label}
        {p.required && <span aria-hidden="true"> *</span>}
      </legend>
      {p.options.length === 0 ? (
        <p className="gcpe-hint">None to choose from.</p>
      ) : (
        <ul>
          {p.options.map((o, i) => (
            <li key={o.value}>
              <input type="checkbox" id={`${p.id}-${i}`} checked={p.values.includes(o.value)} onChange={(e) => toggle(o.value, e.target.checked)} />
              <label htmlFor={`${p.id}-${i}`}>{o.label}</label>
            </li>
          ))}
        </ul>
      )}
      <Notes id={p.id} p={p} />
    </fieldset>
  );
}

/** HQ Tags: free text, a new one is created on save (C146), with the active ones suggested. */
export function TagField(p: Common & { values: readonly string[]; onChange: (v: string[]) => void; suggestions: readonly string[] }): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (v && !p.values.some((x) => x.toLowerCase() === v.toLowerCase())) p.onChange([...p.values, v]);
    setDraft("");
  };
  return (
    <div className={wrap(p)}>
      <Label id={p.id} label={p.label} />
      <div className="gcpe-tag-input">
        <input
          type="text"
          id={p.id}
          list={`${p.id}-suggestions`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          aria-invalid={invalid(p)}
          aria-describedby={describedBy(p.id, p)}
        />
        <button type="button" className="gcpe-small-button" onClick={add}>
          Add tag
        </button>
      </div>
      <datalist id={`${p.id}-suggestions`}>
        {p.suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      {p.values.length > 0 && (
        <ul className="gcpe-tags" aria-label={`${p.label} chosen`}>
          {p.values.map((v) => (
            <li key={v}>
              {v}{" "}
              <button type="button" className="gcpe-small-button" aria-label={`Remove ${p.label} ${v}`} onClick={() => p.onChange(p.values.filter((x) => x !== v))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <Notes id={p.id} p={p} />
    </div>
  );
}

const TIMES: Choice[] = Array.from({ length: 288 }, (_, i) => {
  const h = Math.floor(i / 12);
  const m = String((i % 12) * 5).padStart(2, "0");
  return { value: `${String(h).padStart(2, "0")}:${m}`, label: `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? "AM" : "PM"}` };
});

/** A date, and a time in 5-minute steps (spec addendum §7.2), unless the activity is all day. */
export function DateTimeField(p: {
  idDate: string;
  idTime: string;
  label: string;
  date: string | null;
  time: string | null;
  onDate: (v: string | null) => void;
  onTime: (v: string | null) => void;
  showTime: boolean;
  required?: boolean;
  dateError?: string[];
  timeError?: string[];
  review?: boolean;
  timeEmpty?: string;
}): React.JSX.Element {
  const dateNotes = { error: p.dateError, review: p.review };
  return (
    <div className="gcpe-datetime">
      <div className={wrap(p)}>
        <Label id={p.idDate} label={`${p.label} date`} required={p.required} />
        <input type="date" id={p.idDate} value={p.date ?? ""} onChange={(e) => p.onDate(e.target.value || null)} aria-invalid={invalid({ error: p.dateError })} aria-describedby={describedBy(p.idDate, dateNotes)} aria-required={p.required || undefined} />
        <Notes id={p.idDate} p={dateNotes} />
      </div>
      {p.showTime && (
        <SelectField id={p.idTime} label={`${p.label} time`} value={p.time ?? ""} onChange={(v) => p.onTime(v || null)} options={TIMES} empty={p.timeEmpty ?? "Choose a time"} required={p.required} error={p.timeError} />
      )}
    </div>
  );
}
```

- [ ] **Step 5: The form**

Create `apps/staff-web/src/screens/calendar/activity/ActivityForm.tsx`:

```tsx
import type { ReactNode } from "react";
import { releaseFieldsetHidden, warningsFor, type ActivityFields, type EditorOptions, type HqSection, type HqStatus, type LookAheadInference, type NeedsReviewKey } from "@gcpe/calendar-contract";
import type { CalendarMe } from "../access";
import type { CalendarConfigView } from "../list/types";
import { CheckField, CheckList, DateTimeField, SelectField, TagField, TextField } from "./fields";
import {
  categoryChoices, commContactChoices, fieldId, inferredLabel, leadMinistryChoices, lookupChoices, needsReviewOf, SECTION_LABELS, sharedWithChoices,
  termChoices, translationChoices, withAllDay, withCategory, withMinistry,
} from "./form";

export type Change = (patch: Partial<ActivityFields> | ((f: ActivityFields) => ActivityFields)) => void;
export interface ActivityFormProps {
  fields: ActivityFields;
  /** The stored values: an inactive value the activity already holds stays offered. */
  stored: ActivityFields | null;
  change: Change;
  options: EditorOptions;
  config: CalendarConfigView;
  me: CalendarMe;
  errors: Map<string, string[]>;
  needsReview: readonly NeedsReviewKey[];
  lookAhead: { visible: boolean; inferred: LookAheadInference; overridden: boolean; choose: (s: HqSection) => void; reset: () => void };
  today: string;
  /** "BC Gov News", at the end of the Release fieldset. */
  release: ReactNode;
  /** Records, after Event. */
  records: ReactNode;
}

const str = (v: number | string | null) => (v === null ? "" : String(v));
const num = (v: string) => (v === "" ? null : Number(v));
const SECTIONS = (Object.keys(SECTION_LABELS) as HqSection[]).map((k) => ({ value: k, label: SECTION_LABELS[k] }));

/** Legacy's fieldsets in legacy's order (spec addendum §8.2; Activity.aspx). */
export function ActivityForm(p: ActivityFormProps): React.JSX.Element {
  const { fields: f, stored: s, change, options: o, config } = p;
  const rules = config.rules;
  const relax = config.editor.relaxRequired;
  const err = (k: string) => p.errors.get(k);
  const rev = (k: keyof ActivityFields) => needsReviewOf(k, p.needsReview);
  const id = fieldId;
  const categoryName = o.categories.find((c) => c.id === f.categoryId)?.name ?? null;
  const isRelease = f.categoryId !== null && rules.releaseCategoryIds.includes(f.categoryId);
  const la = f.lookAhead;
  const setLa = (patch: Partial<NonNullable<ActivityFields["lookAhead"]>>) => change((x) => ({ ...x, lookAhead: { ...x.lookAhead!, ...patch } }));
  const warnings = warningsFor(f, p.today);
  const one = (key: keyof ActivityFields) => [s ? (s[key] as number | null) : null];

  return (
    <>
      <fieldset className="gcpe-fieldset">
        <legend>Overview</legend>
        <SelectField id={id("categoryId")} label="Category" required value={str(f.categoryId)} onChange={(v) => change((x) => withCategory(x, num(v), o, rules))} options={categoryChoices(o, rules, config.editor.useHqPlaceholder, s?.categoryId ?? null)} empty="Choose a category" error={err("categoryId")} review={rev("categoryId")} />
        <CheckField id={id("isConfidential")} label="Not for Look Ahead" checked={f.isConfidential} onChange={(v) => change({ isConfidential: v })} review={rev("isConfidential")} />
        <TextField id={id("title")} label="Title" required value={f.title} onChange={(v) => change({ title: v })} error={err("title")} review={rev("title")} hint="At most 100 characters." />
        <TextField id={id("details")} label="Summary" multiline required={!relax} value={f.details} onChange={(v) => change({ details: v })} error={err("details")} review={rev("details")} hint="At most 700 characters." />
        <CheckField id={id("isIssue")} label="Issue" checked={f.isIssue} onChange={(v) => change({ isIssue: v })} review={rev("isIssue")} />
        <TextField id={id("significance")} label="Significance" multiline required={rules.required.significance && !relax} value={f.significance} onChange={(v) => change({ significance: v })} error={err("significance")} review={rev("significance")} />
        <TextField id={id("leadOrganization")} label="Lead Organization" value={f.leadOrganization} onChange={(v) => change({ leadOrganization: v })} error={err("leadOrganization")} review={rev("leadOrganization")} />
        <CheckList id={id("initiativeIds")} label="HQ Initiatives & Leads" values={f.initiativeIds.map(String)} onChange={(v) => change({ initiativeIds: v.map(Number) })} options={lookupChoices(o.initiatives, s?.initiativeIds ?? [])} error={err("initiativeIds")} review={rev("initiativeIds")} />
        <TagField id={id("keywordNames")} label="HQ Tags" values={f.keywordNames} onChange={(v) => change({ keywordNames: v })} suggestions={o.keywords.filter((k) => k.isActive).map((k) => k.name)} error={err("keywordNames")} review={rev("keywordNames")} />
      </fieldset>

      <fieldset className="gcpe-fieldset">
        <legend>Planning</legend>
        <SelectField id={id("commContactId")} label="Comm Contact" required value={str(f.commContactId)} onChange={(v) => change({ commContactId: num(v) })} options={commContactChoices(o, f.contactMinistryKey, s?.commContactId ?? null)} empty={f.contactMinistryKey ? "Choose a comm contact" : "Choose the lead ministry first"} error={err("commContactId")} />
        <CheckField id={id("isMilestone")} label="Key activity" checked={f.isMilestone} onChange={(v) => change({ isMilestone: v })} />
        <TextField id={id("strategy")} label="Strategy" multiline required={rules.required.strategy} value={f.strategy} onChange={(v) => change({ strategy: v })} error={err("strategy")} review={rev("strategy")} />
        <CheckList id={id("commMaterialIds")} label="Comm Materials" required={isRelease} values={f.commMaterialIds.map(String)} onChange={(v) => change({ commMaterialIds: v.map(Number) })} options={lookupChoices(o.commMaterials, s?.commMaterialIds ?? [])} error={err("commMaterialIds")} review={rev("commMaterialIds")} />
        <TextField id={id("comments")} label="Internal notes" multiline value={f.comments} onChange={(v) => change({ comments: v })} error={err("comments")} review={rev("comments")} />
      </fieldset>

      <fieldset className="gcpe-fieldset">
        <legend>Ministry</legend>
        <SelectField id={id("contactMinistryKey")} label="Lead Ministry" required value={f.contactMinistryKey ?? ""} onChange={(v) => change((x) => withMinistry(x, v || null, o))} options={leadMinistryChoices(o, rules, p.me, s?.contactMinistryKey ?? null)} empty="Choose the lead ministry" error={err("contactMinistryKey")} />
        <CheckField id={id("isCrossGovernment")} label="Cross-Government" checked={f.isCrossGovernment} onChange={(v) => change({ isCrossGovernment: v })} />
        <CheckList id={id("sharedWithKeys")} label="Shared With" values={f.sharedWithKeys} onChange={(v) => change({ sharedWithKeys: v })} options={sharedWithChoices(o, rules, s?.sharedWithKeys ?? [])} error={err("sharedWithKeys")} />
      </fieldset>

      {p.lookAhead.visible && la && (
        <fieldset className="gcpe-fieldset">
          <legend>Look Ahead</legend>
          <TextField id={id("lookAhead.hqComments")} label="Executive Summary" multiline value={la.hqComments} onChange={(v) => setLa({ hqComments: v })} error={err("lookAhead.hqComments")} hint="At most 2000 characters." />
          <SelectField id={id("lookAhead.hqStatus")} label="LA Status" value={la.hqStatus ?? ""} onChange={(v) => setLa({ hqStatus: (v || null) as HqStatus | null })} options={[{ value: "new", label: "New" }, { value: "changed", label: "Changed" }]} empty="None" />
          {p.lookAhead.inferred.kind === "section" ? (
            <div className={p.lookAhead.overridden ? "gcpe-override" : undefined}>
              <SelectField id={id("lookAhead.hqSection")} label="LA Section" value={la.hqSection} onChange={(v) => p.lookAhead.choose(v as HqSection)} options={SECTIONS} hint={p.lookAhead.overridden ? `Override (inferred: ${inferredLabel(p.lookAhead.inferred)})` : "Inferred from the activity"} />
              {p.lookAhead.overridden && (
                <button type="button" className="gcpe-small-button" onClick={p.lookAhead.reset}>
                  Use the inferred section
                </button>
              )}
            </div>
          ) : (
            <p id={id("lookAhead.hqSection")}>{`LA Section: ${inferredLabel(p.lookAhead.inferred)}. Set by the category or the ministry; it can't be overridden.`}</p>
          )}
          <CheckField id={id("lookAhead.longTermOutlook")} label="Long Term Outlook" checked={la.longTermOutlook} onChange={(v) => setLa({ longTermOutlook: v })} />
        </fieldset>
      )}

      <fieldset className="gcpe-fieldset">
        <legend>Schedule</legend>
        <DateTimeField idDate={id("startDate")} idTime={id("startTime")} label="Start" required date={f.startDate} time={f.startTime} onDate={(v) => change({ startDate: v })} onTime={(v) => change({ startTime: v })} showTime={!f.isAllDay} dateError={err("startDate")} timeError={err("startTime")} review={rev("startDate")} />
        <DateTimeField idDate={id("endDate")} idTime={id("endTime")} label="End" required date={f.endDate} time={f.endTime} onDate={(v) => change({ endDate: v })} onTime={(v) => change({ endTime: v })} showTime={!f.isAllDay} dateError={err("endDate")} timeError={err("endTime")} review={rev("endDate")} />
        <CheckField id={id("isAllDay")} label="All Day" checked={f.isAllDay} onChange={(v) => change((x) => withAllDay(x, v))} />
        <CheckField id={id("isConfirmed")} label="Dates Confirmed" checked={f.isConfirmed} onChange={(v) => change({ isConfirmed: v })} />
        <TextField id={id("potentialDates")} label="Potential Dates" value={f.potentialDates} onChange={(v) => change({ potentialDates: v })} error={err("potentialDates")} review={rev("potentialDates")} hint="A general timeline, like winter or late June: no numbers, TBC or TBD." />
        <TextField id={id("schedule")} label="Scheduling considerations" multiline required={rules.required.scheduling && !relax} value={f.schedule} onChange={(v) => change({ schedule: v })} error={err("schedule")} review={rev("schedule")} />
        {warnings.length > 0 && (
          <ul className="gcpe-warnings">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
      </fieldset>

      {!releaseFieldsetHidden(categoryName, rules) && (
        <fieldset className="gcpe-fieldset">
          <legend>Release</legend>
          <DateTimeField idDate={id("nrDate")} idTime={id("nrTime")} label="Release" date={f.nrDate} time={f.nrTime} onDate={(v) => change({ nrDate: v })} onTime={(v) => change({ nrTime: v })} showTime timeEmpty="No release time" dateError={err("nrDate")} timeError={err("nrTime")} />
          <SelectField id={id("nrOriginId")} label="Origin" required={isRelease} value={str(f.nrOriginId)} onChange={(v) => change({ nrOriginId: num(v) })} options={lookupChoices(o.origins, one("nrOriginId"))} empty="None" error={err("nrOriginId")} review={rev("nrOriginId")} />
          <SelectField id={id("nrDistributionId")} label="Distribution" required={isRelease} value={str(f.nrDistributionId)} onChange={(v) => change({ nrDistributionId: num(v) })} options={lookupChoices(o.distributions, one("nrDistributionId"))} empty="None" error={err("nrDistributionId")} review={rev("nrDistributionId")} />
          <CheckList id={id("translations")} label="Translations Required" values={f.translations} onChange={(v) => change({ translations: v })} options={translationChoices(rules.translationsDefault, s?.translations ?? f.translations)} error={err("translations")} review={rev("translations")} />
          <CheckList id={id("sectorKeys")} label="Sectors" values={f.sectorKeys} onChange={(v) => change({ sectorKeys: v })} options={termChoices(o.sectors, s?.sectorKeys ?? [])} error={err("sectorKeys")} />
          <CheckList id={id("themeKeys")} label="Themes" values={f.themeKeys} onChange={(v) => change({ themeKeys: v })} options={termChoices(o.themes, s?.themeKeys ?? [])} error={err("themeKeys")} />
          <CheckList id={id("tagKeys")} label="News Subscribe" values={f.tagKeys} onChange={(v) => change({ tagKeys: v })} options={termChoices(o.tags, s?.tagKeys ?? [])} error={err("tagKeys")} />
          {p.release}
        </fieldset>
      )}

      <fieldset className="gcpe-fieldset">
        <legend>Event</legend>
        <SelectField id={id("premierRequestedId")} label="Premier Requested" value={str(f.premierRequestedId)} onChange={(v) => change({ premierRequestedId: num(v) })} options={lookupChoices(o.premierRequested, one("premierRequestedId"))} empty="None" error={err("premierRequestedId")} review={rev("premierRequestedId")} />
        <SelectField id={id("governmentRepresentativeId")} label="Representative" value={str(f.governmentRepresentativeId)} onChange={(v) => change({ governmentRepresentativeId: num(v) })} options={lookupChoices(o.representatives, one("governmentRepresentativeId"))} empty="None" error={err("governmentRepresentativeId")} review={rev("governmentRepresentativeId")} />
        <CheckField id={id("isAtLegislature")} label="At BC Legislature" checked={f.isAtLegislature} onChange={(v) => change({ isAtLegislature: v })} />
        <SelectField id={id("cityId")} label="City" value={str(f.cityId)} onChange={(v) => change({ cityId: num(v) })} options={lookupChoices(o.cities, one("cityId"))} empty="None" error={err("cityId")} review={rev("cityId")} />
        {f.cityId === rules.otherCityId && (
          <TextField id={id("otherCity")} label="Other City" value={f.otherCity} onChange={(v) => change({ otherCity: v })} error={err("otherCity")} review={rev("otherCity")} />
        )}
        <TextField id={id("venue")} label="Venue" value={f.venue} onChange={(v) => change({ venue: v })} error={err("venue")} review={rev("venue")} />
        <SelectField id={id("eventPlannerId")} label="Event Planner" value={str(f.eventPlannerId)} onChange={(v) => change({ eventPlannerId: num(v) })} options={lookupChoices(o.eventPlanners, one("eventPlannerId"))} empty="None" error={err("eventPlannerId")} review={rev("eventPlannerId")} />
        <SelectField id={id("videographerId")} label="Digital" value={str(f.videographerId)} onChange={(v) => change({ videographerId: num(v) })} options={lookupChoices(o.videographers, one("videographerId"))} empty="None" error={err("videographerId")} review={rev("videographerId")} />
      </fieldset>

      {p.records}
    </>
  );
}
```

- [ ] **Step 6: The screen**

Create `apps/staff-web/src/screens/calendar/activity/ActivityScreen.tsx`:

```tsx
import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useBlocker, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { AlertDialog, Button, InlineAlert, Modal } from "@bcgov/design-system-react-components";
import { checkActivity, friendlySpan, inferLookAhead, type ActivityFields, type ActivityView, type EditorOptions, type FieldError, type HqSection } from "@gcpe/calendar-contract";
import { ApiError } from "../../../api/client";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import type { CalendarMe } from "../access";
import { useCalendarContext } from "../CalendarSection";
import { listApi } from "../list/api";
import { todayIn } from "../list/dates";
import type { CalendarConfigView } from "../list/types";
import { ActivityForm, type Change } from "./ActivityForm";
import { activityApi } from "./api";
import { bodyOf, errorsByField, fieldId, initialOverride, lookAheadInputOf, minIdOf, newActivityFields, withInferredSection } from "./form";
import { LockBanner } from "./LockBanner";
import { activityPath, safeCalendarReturn } from "./paths";
import { useEditLock } from "./useEditLock";

const ID = /^\d{1,9}$/;
const STATUS = { new: "New", changed: "Changed", reviewed: "Reviewed" } as const;
interface Loaded {
  config: CalendarConfigView;
  options: EditorOptions;
  view: ActivityView | null;
}

/** The route element, keyed by id, so moving to a clone or to a just-created activity starts afresh. */
export function ActivityRoute(): React.JSX.Element {
  const { id } = useParams();
  return <ActivityScreen key={id ?? "new"} idParam={id ?? null} />;
}

/** `/hub/calendar/activities/:id` and `/new` (spec addendum §8.2): loads, then hands over to the editor. Not visible is "not found" (§6). */
export function ActivityScreen({ idParam }: { idParam: string | null }): React.JSX.Element {
  const me = useCalendarContext();
  const [params] = useSearchParams();
  const location = useLocation();
  const returnTo = safeCalendarReturn(params.get("return"));
  const id = idParam !== null && ID.test(idParam) ? Number(idParam) : null;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<"not_found" | "error" | null>(idParam !== null && id === null ? "not_found" : null);
  useDocumentTitle(failure === "not_found" ? "Activity not found" : failure ? "Activity" : null);

  useEffect(() => {
    if (idParam !== null && id === null) return;
    let live = true;
    Promise.all([listApi.config(), activityApi.options(), id === null ? Promise.resolve(null) : activityApi.get(id)]).then(
      ([config, options, view]) => {
        if (live) setLoaded({ config, options, view });
      },
      (e: unknown) => {
        if (live) setFailure(e instanceof ApiError && e.status === 404 ? "not_found" : "error");
      },
    );
    return () => {
      live = false;
    };
  }, [id, idParam]);

  if (failure === "not_found") {
    return (
      <div>
        <h1>Activity not found</h1>
        <p>It doesn&rsquo;t exist, or you can&rsquo;t see it.</p>
        <p>
          <Link to={returnTo}>Back to the Calendar</Link>
        </p>
      </div>
    );
  }
  if (failure) {
    return (
      <div>
        <h1>Activity</h1>
        <InlineAlert variant="danger" role="alert" description="Couldn't load this activity." />
      </div>
    );
  }
  if (!loaded) {
    return (
      <div>
        <h1>{idParam === null ? "New activity" : "Activity"}</h1>
        <p>Loading…</p>
      </div>
    );
  }
  const notice = (location.state as { calendarNotice?: string } | null)?.calendarNotice ?? null;
  return <ActivityEditor me={me} {...loaded} returnTo={returnTo} notice={notice} />;
}

const ErrorSummary = forwardRef<HTMLDivElement, { errors: FieldError[] }>(function ErrorSummary({ errors }, ref) {
  return (
    <div ref={ref} tabIndex={-1} role="alert" className="gcpe-error-summary" aria-labelledby="activity-errors-heading">
      <h2 id="activity-errors-heading">Fix these to save</h2>
      <ul>
        {errors.map((e, i) => (
          <li key={`${e.field}-${i}`}>{e.field ? <a href={`#${fieldId(e.field)}`}>{e.message}</a> : e.message}</li>
        ))}
      </ul>
    </div>
  );
});

interface EditorProps extends Loaded {
  me: CalendarMe;
  returnTo: string;
  notice: string | null;
}

function ActivityEditor({ me, config, options, view: initial, returnTo, notice }: EditorProps): React.JSX.Element {
  const navigate = useNavigate();
  const isNew = initial === null;
  const [view, setView] = useState(initial);
  const start = useMemo(
    () => initial?.fields ?? withInferredSection(newActivityFields(me, config.lookAheadFieldset), false, options, config.rules, null),
    [initial, me, config, options],
  );
  const [fields, setFields] = useState<ActivityFields>(start);
  const original = useRef(start);
  const [overridden, setOverriddenState] = useState(() => (initial?.lookAhead ? initialOverride(initial.lookAhead.hqSection, initial.lookAhead.inferred) : false));
  const overriddenRef = useRef(overridden);
  const setOverridden = (v: boolean) => {
    overriddenRef.current = v;
    setOverriddenState(v);
  };
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [failure, setFailure] = useState<{ text: string; conflict: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirtyState] = useState(false);
  const dirtyRef = useRef(false);
  const setDirty = (v: boolean) => {
    dirtyRef.current = v;
    setDirtyState(v);
  };
  const leaving = useRef(false);
  const summary = useRef<HTMLDivElement>(null);

  const storedSection: HqSection | null = view?.fields.lookAhead?.hqSection ?? null;
  const fieldset = isNew ? config.lookAheadFieldset : view!.lookAhead !== null;
  const canEdit = isNew ? config.editor.create : view!.can.edit;

  const reload = useCallback(async (): Promise<ActivityView | null> => {
    if (!initial) return null;
    try {
      const v = await activityApi.get(initial.id);
      setView(v);
      if (!dirtyRef.current) {
        setFields(v.fields);
        original.current = v.fields;
      }
      return v;
    } catch {
      return null;
    }
  }, [initial]);
  const lock = useEditLock({ activityId: initial?.id ?? null, initial: initial?.lock ?? null, enabled: canEdit && !initial?.isDeleted, reload });
  const frozen = config.freeze.appliesToYou;
  const lockedOut = lock.state.kind === "other" || lock.state.kind === "elsewhere";
  const readOnly = !canEdit || frozen || lockedOut || !!view?.isDeleted;
  const inferred = inferLookAhead(lookAheadInputOf(fields, options, storedSection), config.rules);

  const title = isNew ? "New activity" : `Activity ${minIdOf(view!)}`;
  useDocumentTitle(title);

  const change: Change = (patch) => {
    if (readOnly) return;
    const first = !dirtyRef.current;
    setFields((f) => withInferredSection(typeof patch === "function" ? patch(f) : { ...f, ...patch }, overriddenRef.current, options, config.rules, storedSection));
    setDirty(true);
    void lock.touch().then((ok) => {
      if (!ok && first) {
        setFields(original.current);
        setDirty(false);
      }
    });
  };
  const lookAhead = {
    visible: fieldset,
    inferred,
    overridden,
    choose: (section: HqSection) => {
      setOverridden(inferred.kind === "section" && section !== inferred.section);
      change((x) => ({ ...x, lookAhead: { ...x.lookAhead!, hqSection: section } }));
    },
    reset: () => {
      setOverridden(false);
      change((x) => x);
    },
  };

  // In-app navigation with unsaved changes asks first; closing or reloading the tab gets the browser's own prompt.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirtyRef.current && !leaving.current && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search),
  );
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const leave = (to: string, calendarNotice: string, replace = false) => {
    leaving.current = true;
    navigate(to, { state: { calendarNotice }, replace });
  };
  const showErrors = (es: FieldError[]) => {
    setErrors(es);
    setTimeout(() => summary.current?.focus(), 0);
  };
  const writeFailed = (e: unknown) => {
    if (e instanceof ApiError && e.status === 422) return showErrors((e.body as { errors?: FieldError[] } | undefined)?.errors ?? [{ field: "", message: e.message }]);
    if (e instanceof ApiError && e.status === 409 && e.code === "version_conflict") return setFailure({ text: e.message, conflict: true });
    if (e instanceof ApiError && e.status === 423) {
      lock.refused(e);
      return setFailure({ text: e.message, conflict: false });
    }
    if (e instanceof ApiError && e.status === 404) return setFailure({ text: "This activity is no longer available to you.", conflict: false });
    setFailure({ text: e instanceof ApiError && e.status < 500 ? e.message : "Couldn't save. Your changes are still here; try again.", conflict: false });
  };
  const extra = (warnings: string[]) => (warnings.length ? ` ${warnings.join(" ")}` : "");

  const save = async () => {
    setFailure(null);
    const problems = checkActivity(fields, {
      rules: config.rules,
      relaxRequired: config.editor.relaxRequired,
      lookAheadFieldset: fieldset,
      previous: view?.fields ?? null,
      inferredSection: inferred.kind === "section" ? inferred.section : null,
    });
    if (problems.length) return showErrors(problems);
    setErrors([]);
    setSaving(true);
    try {
      const body = bodyOf(fields, fieldset);
      if (isNew) {
        const r = await activityApi.create(body);
        if (r.activity) leave(activityPath(r.id, returnTo), `Created ${minIdOf(r.activity)}.${extra(r.warnings)}`, true);
        else leave(returnTo, r.warnings.join(" "));
      } else {
        const r = await activityApi.update(view!.id, { ...body, version: view!.version, tabId: lock.tabId });
        leave(returnTo, r.activity ? `Saved ${minIdOf(r.activity)}.${extra(r.warnings)}` : r.warnings.join(" "));
      }
    } catch (e) {
      writeFailed(e);
    } finally {
      setSaving(false);
    }
  };

  const discardAndReload = async () => {
    setDirty(false);
    setFailure(null);
    setErrors([]);
    const v = await reload();
    if (v) setOverridden(v.lookAhead ? initialOverride(v.lookAhead.hqSection, v.lookAhead.inferred) : false);
  };

  const stamp =
    view &&
    `${view.isDeleted ? "Deleted" : STATUS[view.status]} · updated ${friendlySpan(new Date(view.lastUpdatedAt), new Date(), config.timeZone)} ago${view.lastUpdatedByName ? ` by ${view.lastUpdatedByName}` : ""}`;
  const contact = view?.fields.contactMinistryKey ?? null;
  const shared = !!view && me.ministryKeys.some((k) => view.fields.sharedWithKeys.includes(k)) && contact !== null && !me.ministryKeys.includes(contact);
  const viewOnly = !canEdit && !view?.isDeleted ? (shared && me.level >= 2 ? "Your ministry is shared on this activity: you can view it but not change it." : "You can view this activity but not change it.") : null;

  return (
    <div className="gcpe-activity">
      <h1>{title}</h1>
      {notice && (
        <p role="status" className="gcpe-notice">
          {notice}
        </p>
      )}
      {stamp && <p className="gcpe-hint">{stamp}</p>}
      {view?.isDeleted && <InlineAlert variant="info" description="This activity is deleted. HQ Administrators can review the deletion; nothing else can change it." />}
      {canEdit && frozen && !view?.isDeleted && <InlineAlert variant="warning" title="Change freeze" description={config.freeze.message} />}
      {viewOnly && <p>{viewOnly}</p>}
      <LockBanner lock={lock} timeZone={config.timeZone} />
      {failure && (
        <InlineAlert
          variant="danger"
          role="alert"
          description={failure.text}
          buttons={
            failure.conflict ? (
              <Button variant="secondary" onPress={() => void discardAndReload()}>
                Reload
              </Button>
            ) : undefined
          }
        />
      )}
      {errors.length > 0 && <ErrorSummary ref={summary} errors={errors} />}
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset className="gcpe-activity-form" disabled={readOnly}>
          <legend className="gcpe-visually-hidden">{title}</legend>
          <ActivityForm
            fields={fields}
            stored={view?.fields ?? null}
            change={change}
            options={options}
            config={config}
            me={me}
            errors={errorsByField(errors)}
            needsReview={view?.needsReview ?? []}
            lookAhead={lookAhead}
            today={todayIn(config.timeZone)}
            release={null}
            records={null}
          />
        </fieldset>
        <div className="gcpe-actions">
          {!readOnly && (
            <Button type="submit" isDisabled={saving}>
              Save
            </Button>
          )}
          <Button variant="secondary" onPress={() => navigate(returnTo)}>
            {readOnly ? "Back" : "Cancel"}
          </Button>
        </div>
      </form>
      <Modal isOpen={blocker.state === "blocked"} onOpenChange={(open) => { if (!open) blocker.reset?.(); }} isDismissable>
        <AlertDialog
          variant="warning"
          title="Unsaved changes"
          buttons={
            <>
              <Button onPress={() => blocker.reset?.()}>Stay</Button>
              <Button danger onPress={() => blocker.proceed?.()}>
                Leave
              </Button>
            </>
          }
        >
          <p>You have unsaved changes to this activity. Leave anyway and discard them?</p>
        </AlertDialog>
      </Modal>
    </div>
  );
}
```

- [ ] **Step 7: The routes, the list's links and New activity, and the styles**

`apps/staff-web/src/router.tsx`: import `ActivityRoute` from `./screens/calendar/activity/ActivityScreen`, and add to the `calendar` children, after the index route:

```tsx
          { path: "activities/new", element: <ActivityRoute /> },
          { path: "activities/:id", element: <ActivityRoute /> },
```

`apps/staff-web/src/screens/calendar/list/cells.tsx`: import `Link` and `useLocation` from `react-router` and `activityPath` from `../activity/paths`; add, after `minId`:

```tsx
/** The activity's title opens it, coming back to this list as it stands (C149). */
export function TitleLink({ id, children }: { id: number; children: React.ReactNode }): React.JSX.Element {
  const here = useLocation();
  return <Link to={activityPath(id, `${here.pathname}${here.search}`)}>{children}</Link>;
}
```

  and in the `title` case wrap the title: `<strong className="gcpe-activity-title"><TitleLink id={r.id}>{r.title}</TitleLink></strong>`.

`apps/staff-web/src/screens/calendar/list/CalendarGrid.tsx`: import `TitleLink` from `./cells` and render each item as `<li key={i.id}><TitleLink id={i.id}>{itemText(i, d)}</TitleLink></li>`.

`apps/staff-web/src/screens/calendar/list/ActivityListScreen.tsx`:
- Import `Link` and `useLocation` from `react-router` and `activityPath` from `../activity/paths`.
- At the top of the component: `const here = useLocation();` and `const notice = (here.state as { calendarNotice?: string } | null)?.calendarNotice ?? null;`.
- After the list's `<h1>Corporate Calendar</h1>` in the loaded return: `{notice && <p role="status" className="gcpe-notice">{notice}</p>}`.
- First inside `<section aria-label="List actions" …>`:

```tsx
        {config.editor.create && (
          <Link className="gcpe-button-link" to={activityPath("new", `${here.pathname}${here.search}`)}>
            New activity
          </Link>
        )}
```

Append to `apps/staff-web/src/styles/global.css`:

```css
/* The activity editor (spec addendum §8.2). Every control is at least 24px (WCAG 2.5.8). */
.gcpe-activity .gcpe-activity-form {
  border: none;
  margin: 0;
  padding: 0;
}
.gcpe-activity .gcpe-fieldset {
  border: 1px solid #d8d8d8;
  border-radius: 4px;
  margin: 0 0 1rem;
  padding: 0.75rem 1rem;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
  gap: 0.75rem;
}
.gcpe-activity .gcpe-fieldset > legend {
  font-weight: 700;
  padding: 0 0.25rem;
}
.gcpe-activity .gcpe-field,
.gcpe-activity .gcpe-check,
.gcpe-activity .gcpe-datetime {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.gcpe-activity .gcpe-check {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
}
.gcpe-activity input[type="checkbox"] {
  width: 24px;
  height: 24px;
  margin: 0 0.4rem 0 0;
}
.gcpe-activity select,
.gcpe-activity input[type="date"],
.gcpe-activity input[type="text"],
.gcpe-activity textarea {
  min-height: 32px;
  font: inherit;
}
.gcpe-activity .gcpe-checklist {
  border: 1px solid #d8d8d8;
  padding: 0.5rem;
  max-height: 14rem;
  overflow-y: auto;
}
.gcpe-activity .gcpe-checklist ul,
.gcpe-activity .gcpe-tags {
  list-style: none;
  margin: 0;
  padding: 0;
}
.gcpe-activity .gcpe-checklist li {
  display: flex;
  align-items: center;
  min-height: 28px;
}
.gcpe-activity .gcpe-tags li {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  margin: 0 0.5rem 0.25rem 0;
  border: 1px solid #5a5a5a;
  border-radius: 3px;
  padding: 0 0.25rem;
}
.gcpe-small-button,
.gcpe-button-link {
  min-height: 24px;
  min-width: 24px;
  padding: 0.2rem 0.5rem;
  font: inherit;
  cursor: pointer;
}
.gcpe-button-link {
  display: inline-flex;
  align-items: center;
  border: 2px solid #013366;
  border-radius: 4px;
  color: #013366;
  text-decoration: none;
}
.gcpe-review-mark {
  font-size: 0.8rem;
  font-weight: 700;
  color: #6b4a00;
}
.gcpe-activity .gcpe-needs-review {
  background: #fef0d8;
}
.gcpe-override {
  background: #fcefc0;
  border-left: 4px solid #b8860b;
  padding-left: 0.5rem;
}
.gcpe-field-error {
  color: #ce3e39;
  font-weight: 700;
}
.gcpe-error-summary {
  border: 3px solid #ce3e39;
  padding: 0.75rem 1rem;
  margin-bottom: 1rem;
}
.gcpe-warnings {
  color: #6b4a00;
  grid-column: 1 / -1;
}
.gcpe-notice {
  border-left: 4px solid #2e8540;
  padding-left: 0.5rem;
}
```

- [ ] **Step 8: Run the tests to see them pass, then the staff-web suite, both type-checks and the affected e2e specs**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web`
Expected: PASS.
Run both `tsc` commands. Expected: no errors.
Run: `npx -y -p node@24 -- npm run test:e2e -- tests/e2e/calendar-list.spec.ts tests/e2e/axe-sweep.spec.ts`
Expected: PASS. The list's titles are links now; the specs read `.gcpe-activity-title`'s text and the calendar items' text, both unchanged.

- [ ] **Step 9: Commit**

```bash
git add apps/staff-web/src/router.tsx apps/staff-web/src/styles/global.css apps/staff-web/src/screens/calendar
git commit -m "feat(staff-web): the activity editor: legacy's fieldsets, the shared validation, read-only states, save and return; titles open it"
```

---

### Task 4: Review, Delete, Clone, the watch star, "BC Gov News" and View changes

Covers: spec §8.2 Actions (Save, Review, Delete, Clone, Watchlist, Cancel, View changes), §8.1 Watchlist (the star's tooltip names the watchers), §8.3 (View changes: newest first, when, who, action, each field's old → new, "from legacy log", visible to anyone who sees the activity), §11 ("BC Gov News": type colour, document type, status, date; release links only for NRMS roles), §6 (Review: HQ Advanced; Delete: Administrator with edit rights; deleted activities: Review only), §7.1 (Clone; Delete). Decisions E15, E19, E21, E23. Carry-forward: "View changes" reads `/changes`; the activity page's watchlist star (C176). Review Focus 5.

**Files:**
- Modify: `apps/staff-web/src/screens/calendar/list/WatchStar.tsx`, `list/ActivityListScreen.tsx`, `activity/ActivityScreen.tsx`, `activity/fixtures.tsx`, `activity/a11y.test.tsx`, `apps/staff-web/src/router.tsx`, `apps/staff-web/src/styles/global.css`.
- Create: `apps/staff-web/src/screens/calendar/activity/ActivityActions.tsx`, `ActivityActions.test.tsx`, `ReleasesList.tsx`, `ChangesScreen.tsx`, `ChangesScreen.test.tsx`.

**Interfaces:**
- Consumes: Task 3's `leave`, `view`/`setView`, `dirty`; `activityApi.review`, `remove`, `clone`, `changes`; `listApi.watch`; `TYPE_LABEL`; `useSession`.
- Produces:
  - `WatchStar({ id, label, watch, myName, onChange })` with `interface WatchState { isWatched: boolean; watcherNames: string[] }` (the list passes its row's two fields).
  - `ActivityActions({ view, myName, dirty, returnTo, leave, onWatch })`.
  - `ReleasesList({ releases, timeZone, canOpen })`.
  - `ChangesRoute`, `ChangesScreen({ idParam })` at `/hub/calendar/activities/:id/changes`.

- [ ] **Step 1: Write the failing tests**

In `apps/staff-web/src/screens/calendar/activity/fixtures.tsx`, import `ChangesRoute` from `./ChangesScreen` and add to `renderActivity`'s children, after `activities/:id`:

```tsx
          { path: "activities/:id/changes", element: <ChangesRoute /> },
```

Create `apps/staff-web/src/screens/calendar/activity/ActivityActions.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { jsonResponse } from "../../../../test/jsonResponse";
import { HQ_ADMIN_CONFIG, HQ_ADMIN_ME } from "../list/fixtures";
import { renderActivity, stubActivity, view, type Call } from "./fixtures";

const ACTIVITY = "/calendar/api/activities/20001";

describe("the activity's actions (spec addendum §8.2)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("offers only what the server says this user may do", async () => {
    stubActivity([]);
    renderActivity("/calendar/activities/20001");
    await screen.findByRole("region", { name: "Activity actions" });
    expect(screen.getByRole("button", { name: "Clone" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.getByRole("link", { name: "View changes" })).toHaveAttribute("href", "/calendar/activities/20001/changes?return=%2Fcalendar");
  });

  const reviewable = (calls: Call[]) =>
    stubActivity(calls, {
      me: HQ_ADMIN_ME, config: HQ_ADMIN_CONFIG, view: view({ can: { edit: true, clone: true, delete: true, review: true } }),
      other: (url, init) => (url === `${ACTIVITY}/review` && init?.method === "POST" ? jsonResponse(200, view({ status: "reviewed", version: 4 })) : undefined),
    });

  it("Review and Clone wait while there are unsaved changes", async () => {
    reviewable([]);
    renderActivity("/calendar/activities/20001?return=%2Fcalendar");
    await userEvent.type(await screen.findByRole("textbox", { name: "Venue" }), "x");
    expect(screen.getByRole("button", { name: "Review" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clone" })).toBeDisabled();
    expect(screen.getByText("Save or cancel your changes to review or clone.")).toBeInTheDocument();
  });

  it("Review sends the version and goes back", async () => {
    const calls: Call[] = [];
    reviewable(calls);
    renderActivity("/calendar/activities/20001?return=%2Fcalendar");
    await userEvent.click(await screen.findByRole("button", { name: "Review" }));
    expect(await screen.findByText("Reviewed HLTH-20001.")).toBeInTheDocument();
    expect(JSON.parse(String(calls.find((c) => c.url === `${ACTIVITY}/review`)!.init!.body))).toEqual({ version: 3 });
  });

  it("Delete asks first, then sends the version and goes back", async () => {
    const calls: Call[] = [];
    stubActivity(calls, {
      view: view({ can: { edit: true, clone: true, delete: true, review: false } }),
      other: (url, init) => (url === ACTIVITY && init?.method === "DELETE" ? new Response(null, { status: 204 }) : undefined),
    });
    renderActivity("/calendar/activities/20001?return=%2Fcalendar");
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete HLTH-20001?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Deleted HLTH-20001.")).toBeInTheDocument();
    expect(JSON.parse(String(calls.find((c) => c.init?.method === "DELETE")!.init!.body))).toEqual({ version: 3 });
  });

  it("Clone opens the clone", async () => {
    stubActivity([], {
      view: (id) => view({ id }),
      other: (url, init) => (url === `${ACTIVITY}/clone` && init?.method === "POST" ? jsonResponse(201, { id: 20009, activity: view({ id: 20009 }), warnings: [] }) : undefined),
    });
    renderActivity("/calendar/activities/20001");
    await userEvent.click(await screen.findByRole("button", { name: "Clone" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Activity HLTH-20009" })).toBeInTheDocument();
    expect(screen.getByText("Cloned HLTH-20001 as HLTH-20009.")).toBeInTheDocument();
  });

  it("a deleted activity offers HQ only Review", async () => {
    stubActivity([], { me: HQ_ADMIN_ME, config: HQ_ADMIN_CONFIG, view: view({ isDeleted: true, can: { edit: false, clone: false, delete: false, review: true } }) });
    renderActivity("/calendar/activities/20001");
    expect(await screen.findByRole("button", { name: "Review" })).toBeEnabled();
    for (const name of ["Save", "Clone", "Delete"]) expect(screen.queryByRole("button", { name })).toBeNull();
  });

  it("the watch star toggles and names who watches (Activity.aspx.cs:1519-1535; C176)", async () => {
    stubActivity([], {
      view: view({ watch: { isWatched: false, watcherNames: ["Sample Admin"] } }),
      other: (url, init) => (url === `${ACTIVITY}/watch` && init?.method === "PUT" ? new Response(null, { status: 204 }) : undefined),
    });
    renderActivity("/calendar/activities/20001");
    const star = await screen.findByRole("button", { name: "Watch HLTH-20001" });
    expect(star).toHaveAttribute("aria-pressed", "false");
    expect(star).toHaveAccessibleDescription("Watched by Sample Admin");
    await userEvent.click(star);
    expect(star).toHaveAttribute("aria-pressed", "true");
    expect(star).toHaveAccessibleDescription("Watched by Robin Staff, Sample Admin");
  });

  it("BC Gov News lists linked releases; only an NRMS role gets the link (spec addendum §11)", async () => {
    const releases = [{ releaseId: "8a7f3c1e-2b4d-4e6f-9a0b-1c2d3e4f5a01", type: "release", status: "scheduled", reference: "NEWS-00001", publishAt: "2031-11-10T17:00:00.000Z", releasedAt: null }];
    stubActivity([], { view: view({ releases }) });
    renderActivity("/calendar/activities/20001");
    const news = await screen.findByRole("region", { name: "BC Gov News" });
    expect(news).toHaveTextContent("Release NEWS-00001: Scheduled, Nov 10, 2031 10:00 AM");
    expect(within(news).queryByRole("link")).toBeNull();
    cleanup();
    stubActivity([], { view: view({ releases }), roles: ["Calendar.Editor", "NRMS.Viewer"] });
    renderActivity("/calendar/activities/20001");
    expect(await within(await screen.findByRole("region", { name: "BC Gov News" })).findByRole("link")).toHaveAttribute("href", "/releases/8a7f3c1e-2b4d-4e6f-9a0b-1c2d3e4f5a01");
  });
});
```

Create `apps/staff-web/src/screens/calendar/activity/ChangesScreen.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ActivityChangeView } from "@gcpe/calendar-contract";
import { jsonResponse } from "../../../../test/jsonResponse";
import { renderActivity, stubActivity, view } from "./fixtures";

const CHANGES: ActivityChangeView[] = [
  { id: 3, at: "2026-11-03T18:00:00.000Z", actorName: "Robin Staff", action: "updated", source: "calendar", fields: [{ key: "title", label: "Title", old: "Sample old", new: "Sample new" }, { key: "venue", label: "Venue", old: null, new: "Sample hall" }] },
  { id: 1, at: "2019-05-01T17:00:00.000Z", actorName: "Sample Former Staff", action: "updated", source: "legacy_log", fields: [{ key: "start", label: "Start", old: "2019-05-02 09:00", new: "2019-05-03 09:00" }] },
];
const answer = (changes: ActivityChangeView[] | Response) => (url: string) => (url === "/calendar/api/activities/20001/changes" ? (changes instanceof Response ? changes : jsonResponse(200, changes)) : undefined);

describe("View changes (spec addendum §8.3; C133)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists each change newest first: when, who, what, and each field's old and new value; legacy entries marked", async () => {
    stubActivity([], { other: answer(CHANGES) });
    renderActivity("/calendar/activities/20001/changes?return=%2Fcalendar");
    expect(await screen.findByRole("heading", { level: 1, name: "Changes to HLTH-20001" })).toBeInTheDocument();
    const entries = [...document.querySelectorAll<HTMLElement>(".gcpe-changes > li")];
    expect(within(entries[0]!).getByRole("heading", { level: 2 })).toHaveTextContent("Nov 3, 2026 11:00 AM: Robin Staff changed it");
    expect(within(entries[0]!).getByRole("row", { name: "Title Sample old Sample new" })).toBeInTheDocument();
    expect(within(entries[0]!).getByRole("row", { name: "Venue — Sample hall" })).toBeInTheDocument();
    expect(entries[1]).toHaveTextContent("from legacy log");
    expect(screen.getByRole("link", { name: "Back to the activity" })).toHaveAttribute("href", "/calendar/activities/20001?return=%2Fcalendar");
  });

  it("says when nothing is recorded yet", async () => {
    stubActivity([], { other: answer([]) });
    renderActivity("/calendar/activities/20001/changes");
    expect(await screen.findByText("No changes are recorded yet.")).toBeInTheDocument();
  });

  it("an activity the user can't see is 'not found'", async () => {
    stubActivity([], { view: () => jsonResponse(404, { error: "not found" }), other: answer(jsonResponse(404, { error: "not found" })) });
    renderActivity("/calendar/activities/20001/changes");
    expect(await screen.findByRole("heading", { level: 1, name: "Activity not found" })).toBeInTheDocument();
  });

  it("opens from the editor", async () => {
    stubActivity([], { view: view(), other: answer(CHANGES) });
    renderActivity("/calendar/activities/20001");
    await userEvent.click(await screen.findByRole("link", { name: "View changes" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Changes to HLTH-20001" })).toBeInTheDocument();
  });
});
```

Append to `apps/staff-web/src/screens/calendar/activity/a11y.test.tsx`, inside its `describe` (import `within` and `jsonResponse`):

```tsx
  it("the delete confirmation", async () => {
    stubActivity([], { view: view({ can: { edit: true, clone: true, delete: true, review: false } }) });
    renderActivity("/calendar/activities/20001");
    await userEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(await seriousViolations(dialog)).toEqual([]);
  });

  it("View changes", async () => {
    stubActivity([], {
      other: (url) =>
        url === "/calendar/api/activities/20001/changes"
          ? jsonResponse(200, [{ id: 1, at: "2026-11-03T18:00:00.000Z", actorName: "Robin Staff", action: "updated", source: "legacy_log", fields: [{ key: "title", label: "Title", old: "Sample old", new: "Sample new" }] }])
          : undefined,
    });
    const { container } = renderActivity("/calendar/activities/20001/changes");
    await screen.findByRole("heading", { level: 1, name: "Changes to HLTH-20001" });
    expect(await seriousViolations(container)).toEqual([]);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/calendar/activity`
Expected: FAIL. `./ChangesScreen` doesn't exist and the editor has no actions region.

- [ ] **Step 3: The shared watch star**

Replace `apps/staff-web/src/screens/calendar/list/WatchStar.tsx`:

```tsx
import { useState } from "react";
import { listApi } from "./api";

export interface WatchState {
  isWatched: boolean;
  watcherNames: string[];
}

/** The watchlist star (Activity.aspx.cs:1519-1535; C176): a toggle naming who watches, on the activity page and the list. Not frozen. */
export function WatchStar({ id, label, watch, myName, onChange }: { id: number; label: string; watch: WatchState; myName: string; onChange: (w: WatchState) => void }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tip = watch.watcherNames.length ? `Watched by ${watch.watcherNames.join(", ")}` : "Nobody watches this yet";
  const toggle = async () => {
    const on = !watch.isWatched;
    setBusy(true);
    setError(null);
    try {
      await listApi.watch(id, on);
      const others = watch.watcherNames.filter((n) => n !== myName);
      onChange({ isWatched: on, watcherNames: on ? [...others, myName].sort((a, b) => a.localeCompare(b)) : others });
    } catch {
      setError("Couldn't change your watchlist.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <span>
      <button type="button" className="gcpe-star" aria-label={`Watch ${label}`} aria-pressed={watch.isWatched} aria-describedby={`watchers-${id}`} title={tip} disabled={busy} onClick={() => void toggle()}>
        {watch.isWatched ? "★" : "☆"}
      </button>
      <span id={`watchers-${id}`} className="gcpe-visually-hidden">
        {tip}
      </span>
      {error && <span role="alert">{error}</span>}
    </span>
  );
}
```

In `apps/staff-web/src/screens/calendar/list/ActivityListScreen.tsx`, change the star to:

```tsx
    renderStar: (r, update) => <WatchStar id={r.id} label={minId(r)} watch={{ isWatched: r.isWatched, watcherNames: r.watcherNames }} myName={me.displayName} onChange={update} />,
```

- [ ] **Step 4: The actions, BC Gov News and View changes**

Create `apps/staff-web/src/screens/calendar/activity/ReleasesList.tsx`:

```tsx
import { Link } from "react-router";
import { TYPE_LABEL, type ReleaseType } from "@gcpe/nrms-contract";
import type { ReleaseLinkView } from "@gcpe/calendar-contract";
import { timeText } from "../list/dates";

const STATUS: Record<string, string> = {
  draft: "Draft", approved: "Approved", scheduled: "Scheduled", publishing: "Publishing", published: "Published", unpublishing: "Unpublishing", failed: "Failed",
};
const when = (iso: string, timeZone: string) => `${new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(new Date(iso))} ${timeText(iso, timeZone)}`;

/** "BC Gov News" (spec addendum §8.2, §11): the releases linked to this activity. The link is for NRMS users; NRMS guards the release itself. */
export function ReleasesList({ releases, timeZone, canOpen }: { releases: readonly ReleaseLinkView[]; timeZone: string; canOpen: boolean }): React.JSX.Element {
  return (
    <section aria-labelledby="bc-gov-news" className="gcpe-release-links">
      <h3 id="bc-gov-news">BC Gov News</h3>
      {releases.length === 0 ? (
        <p>No releases are linked to this activity.</p>
      ) : (
        <ul>
          {releases.map((r) => {
            const at = r.releasedAt ?? r.publishAt;
            const label = `${TYPE_LABEL[r.type as ReleaseType] ?? r.type}${r.reference ? ` ${r.reference}` : ""}: ${STATUS[r.status] ?? r.status}${at ? `, ${when(at, timeZone)}` : ""}`;
            return (
              <li key={r.releaseId}>
                <span className={`gcpe-release-swatch gcpe-release-swatch--${r.type}`} aria-hidden="true" />
                {canOpen ? <Link to={`/releases/${r.releaseId}`}>{label}</Link> : label}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
```

Create `apps/staff-web/src/screens/calendar/activity/ActivityActions.tsx`:

```tsx
import { useState } from "react";
import { Link } from "react-router";
import { AlertDialog, Button, InlineAlert, Modal } from "@bcgov/design-system-react-components";
import type { ActivityView } from "@gcpe/calendar-contract";
import { ApiError } from "../../../api/client";
import { WatchStar, type WatchState } from "../list/WatchStar";
import { activityApi } from "./api";
import { minIdOf } from "./form";
import { activityPath, changesPath } from "./paths";

/**
 * Review, Clone, Delete, the watch star and View changes (spec addendum §8.2), each offered only as
 * the view's `can` allows. Review and Clone act on the stored activity, so they wait for unsaved
 * changes to be saved or cancelled; Delete asks first and discards them.
 */
export function ActivityActions({ view, myName, dirty, returnTo, leave, onWatch }: {
  view: ActivityView;
  myName: string;
  dirty: boolean;
  returnTo: string;
  leave: (to: string, notice: string, replace?: boolean) => void;
  onWatch: (w: WatchState) => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const ref = minIdOf(view);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Activity actions" className="gcpe-actions gcpe-activity-actions">
      <WatchStar id={view.id} label={ref} watch={view.watch} myName={myName} onChange={onWatch} />
      <Link to={changesPath(view.id, returnTo)}>View changes</Link>
      {view.can.review && (
        <Button variant="secondary" isDisabled={busy || dirty} onPress={() => void act(async () => { await activityApi.review(view.id, view.version); leave(returnTo, `Reviewed ${ref}.`); })}>
          Review
        </Button>
      )}
      {view.can.clone && (
        <Button
          variant="secondary"
          isDisabled={busy || dirty}
          onPress={() =>
            void act(async () => {
              const r = await activityApi.clone(view.id);
              leave(activityPath(r.id, returnTo), `Cloned ${ref} as ${r.activity ? minIdOf(r.activity) : String(r.id)}.`);
            })
          }
        >
          Clone
        </Button>
      )}
      {view.can.delete && (
        <Button variant="secondary" danger isDisabled={busy} onPress={() => setConfirmDelete(true)}>
          Delete
        </Button>
      )}
      {dirty && (view.can.review || view.can.clone) && <p className="gcpe-hint">Save or cancel your changes to review or clone.</p>}
      {error && <InlineAlert variant="danger" role="alert" description={error} />}
      <Modal isOpen={confirmDelete} onOpenChange={setConfirmDelete} isDismissable>
        <AlertDialog
          variant="destructive"
          title={`Delete ${ref}?`}
          buttons={
            <>
              <Button variant="secondary" onPress={() => setConfirmDelete(false)}>
                Cancel
              </Button>
              <Button
                danger
                onPress={() => {
                  setConfirmDelete(false);
                  void act(async () => {
                    await activityApi.remove(view.id, view.version);
                    leave(returnTo, `Deleted ${ref}.`);
                  });
                }}
              >
                Delete
              </Button>
            </>
          }
        >
          <p>It leaves the list for everyone but HQ Administrators, who can review the deletion. Any unsaved changes are discarded.</p>
        </AlertDialog>
      </Modal>
    </section>
  );
}
```

Create `apps/staff-web/src/screens/calendar/activity/ChangesScreen.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { InlineAlert } from "@bcgov/design-system-react-components";
import type { ActivityChangeView, ActivityView, ChangeAction } from "@gcpe/calendar-contract";
import { ApiError } from "../../../api/client";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { listApi } from "../list/api";
import { timeText } from "../list/dates";
import { activityApi } from "./api";
import { minIdOf } from "./form";
import { activityPath, safeCalendarReturn } from "./paths";

const ACTIONS: Record<ChangeAction, string> = {
  created: "created it", updated: "changed it", cloned: "created it as a clone", reviewed: "reviewed it", deleted: "deleted it",
  transferred: "transferred it", la_status_cleared: "cleared its LA status",
};
const when = (iso: string, timeZone: string) => `${new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(new Date(iso))} ${timeText(iso, timeZone)}`;

export function ChangesRoute(): React.JSX.Element {
  const { id } = useParams();
  return <ChangesScreen key={id} idParam={id ?? ""} />;
}

/** "View changes" (spec addendum §8.3; C133): the activity's history, newest first, for anyone who can see it. */
export function ChangesScreen({ idParam }: { idParam: string }): React.JSX.Element {
  const [params] = useSearchParams();
  const ret = params.get("return");
  const id = /^\d{1,9}$/.test(idParam) ? Number(idParam) : null;
  const [data, setData] = useState<{ view: ActivityView; changes: ActivityChangeView[]; timeZone: string } | null>(null);
  const [failure, setFailure] = useState<"not_found" | "error" | null>(id === null ? "not_found" : null);
  const heading = data ? `Changes to ${minIdOf(data.view)}` : failure === "not_found" ? "Activity not found" : "Changes";
  useDocumentTitle(heading);

  useEffect(() => {
    if (id === null) return;
    let live = true;
    Promise.all([activityApi.get(id), activityApi.changes(id), listApi.config()]).then(
      ([view, changes, config]) => {
        if (live) setData({ view, changes, timeZone: config.timeZone });
      },
      (e: unknown) => {
        if (live) setFailure(e instanceof ApiError && e.status === 404 ? "not_found" : "error");
      },
    );
    return () => {
      live = false;
    };
  }, [id]);

  const back = failure === "not_found" || id === null ? safeCalendarReturn(ret) : activityPath(id, ret ? safeCalendarReturn(ret) : undefined);
  return (
    <div className="gcpe-changes-page">
      <h1>{heading}</h1>
      <p>
        <Link to={back}>{failure === "not_found" ? "Back to the Calendar" : "Back to the activity"}</Link>
      </p>
      {failure === "not_found" && <p>It doesn&rsquo;t exist, or you can&rsquo;t see it.</p>}
      {failure === "error" && <InlineAlert variant="danger" role="alert" description="Couldn't load the changes." />}
      {!data && !failure && <p>Loading…</p>}
      {data &&
        (data.changes.length === 0 ? (
          <p>No changes are recorded yet.</p>
        ) : (
          <ol className="gcpe-changes">
            {data.changes.map((c) => (
              <li key={c.id}>
                <h2>{`${when(c.at, data.timeZone)}: ${c.actorName} ${ACTIONS[c.action]}`}</h2>
                {c.source === "legacy_log" && <p className="gcpe-badge">from legacy log</p>}
                {c.fields.length > 0 && (
                  <table className="gcpe-calendar-table">
                    <caption className="gcpe-visually-hidden">Fields changed</caption>
                    <thead>
                      <tr>
                        <th scope="col">Field</th>
                        <th scope="col">Before</th>
                        <th scope="col">After</th>
                      </tr>
                    </thead>
                    <tbody>
                      {c.fields.map((f) => (
                        <tr key={f.key}>
                          <th scope="row">{f.label}</th>
                          <td>{f.old ?? "—"}</td>
                          <td>{f.new ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </li>
            ))}
          </ol>
        ))}
    </div>
  );
}
```

- [ ] **Step 5: Wire them into the editor and the router**

In `apps/staff-web/src/screens/calendar/activity/ActivityScreen.tsx`:
- Import `ActivityActions` from `./ActivityActions`, `ReleasesList` from `./ReleasesList`, and `useSession` from `../../../session/SessionContext`.
- In `ActivityEditor`, after `const navigate = useNavigate();`: `const session = useSession();`.
- Replace `release={null}` with:

```tsx
            release={<ReleasesList releases={view?.releases ?? []} timeZone={config.timeZone} canOpen={session.roles.some((r) => r.startsWith("NRMS."))} />}
```

- After the closing `</form>`, before the `<Modal …>`:

```tsx
      {view && (
        <ActivityActions view={view} myName={me.displayName} dirty={dirty} returnTo={returnTo} leave={leave} onWatch={(watch) => setView((v) => (v ? { ...v, watch } : v))} />
      )}
```

`apps/staff-web/src/router.tsx`: import `ChangesRoute` from `./screens/calendar/activity/ChangesScreen` and add after the two activity routes:

```tsx
          { path: "activities/:id/changes", element: <ChangesRoute /> },
```

Append to `apps/staff-web/src/styles/global.css`:

```css
.gcpe-activity-actions {
  flex-wrap: wrap;
  align-items: center;
  margin-top: 1rem;
}
.gcpe-release-links {
  grid-column: 1 / -1;
}
.gcpe-release-links ul {
  list-style: none;
  padding: 0;
}
.gcpe-release-swatch {
  display: inline-block;
  width: 0.75rem;
  height: 0.75rem;
  margin-right: 0.4rem;
  border-radius: 2px;
}
.gcpe-release-swatch--release { background: var(--gcpe-type-release); }
.gcpe-release-swatch--story { background: var(--gcpe-type-story); }
.gcpe-release-swatch--update { background: var(--gcpe-type-update); }
.gcpe-release-swatch--advisory { background: var(--gcpe-type-advisory); }
.gcpe-release-swatch--factsheet { background: var(--gcpe-type-factsheet); }
.gcpe-changes {
  list-style: none;
  padding: 0;
}
.gcpe-changes > li {
  border-top: 1px solid #d8d8d8;
  padding: 0.5rem 0;
}
.gcpe-changes h2 {
  font-size: 1rem;
}
```

- [ ] **Step 6: Run them to see them pass, then the staff-web suite, both type-checks and the affected e2e specs**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web`
Expected: PASS, the list's watch-star tests included (the list passes the row's two fields).
Run both `tsc` commands.
Run: `npx -y -p node@24 -- npm run test:e2e -- tests/e2e/calendar-list.spec.ts tests/e2e/axe-sweep.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/staff-web/src
git commit -m "feat(staff-web): Review, Delete, Clone, the watch star, BC Gov News and View changes on the activity page"
```

---

### Task 5: Records: attachments on the activity page

Covers: spec §8.2 Records (shown when `ShowRecordsSection` is on or the activity already has files), §8.4 (several files, empty and blocked refused, 25 MB, same-name replace, remove from the list, download through the authorised route), §7.4/§7.5 (a file change is a content write: the lock is taken first). Decisions E2, E26. Review Focus 4, 5.

**Files:**
- Modify: `apps/staff-web/src/screens/calendar/activity/ActivityScreen.tsx`, `activity/a11y.test.tsx`.
- Create: `apps/staff-web/src/screens/calendar/activity/RecordsSection.tsx`, `RecordsSection.test.tsx`.

**Interfaces:**
- Consumes: 5e-1's file routes and `ATTACHMENT_ACCEPT`, `ATTACHMENT_MAX_BYTES`, `ActivityFileView`; `activityApi.addFile`, `removeFile`, `fileUrl`; the editor's `lock.touch`, `readOnly`, `setView`.
- Produces: `RecordsSection({ activityId, files, canChange, beforeChange, onFiles, timeZone })`.

- [ ] **Step 1: Write the failing tests**

Create `apps/staff-web/src/screens/calendar/activity/RecordsSection.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ActivityFileView } from "@gcpe/calendar-contract";
import { jsonResponse } from "../../../../test/jsonResponse";
import { CONFIG } from "../list/fixtures";
import { renderActivity, stubActivity, view, type Call } from "./fixtures";

const FILE: ActivityFileView = { id: 5, fileName: "Sample brief.pdf", contentType: "application/pdf", length: 2048, uploadedAt: "2026-11-02T17:00:00.000Z", uploadedByName: "Robin Staff" };
const FILES = "/calendar/api/activities/20001/files";

describe("Records (spec addendum §8.2, §8.4)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("is hidden when the tenant hides it and the activity has no files (Q51)", async () => {
    stubActivity([]);
    renderActivity("/calendar/activities/20001");
    await screen.findByRole("textbox", { name: "Title" });
    expect(screen.queryByRole("group", { name: "Records" })).toBeNull();
  });

  it("shows an activity's files, each downloaded through the authorised route", async () => {
    stubActivity([], { view: view({ files: [FILE] }) });
    renderActivity("/calendar/activities/20001");
    const records = await screen.findByRole("group", { name: "Records" });
    expect(within(records).getByRole("link", { name: "Sample brief.pdf" })).toHaveAttribute("href", `${FILES}/5`);
    expect(records).toHaveTextContent("2 KB, added Nov 2, 2026 by Robin Staff");
  });

  it("adds several files one by one, taking the lock first; one refused file doesn't stop the others", async () => {
    const calls: Call[] = [];
    stubActivity(calls, {
      config: { ...CONFIG, showRecordsSection: true },
      other: (url, init) => {
        if (url !== FILES || init?.method !== "POST") return undefined;
        const name = decodeURIComponent(new Headers(init.headers).get("X-GCPE-File-Name") ?? "");
        if (name === "Sample.exe") return jsonResponse(422, { error: "Fix the fields named", errors: [{ field: "files", message: "This type of file can't be attached." }] });
        return jsonResponse(201, [FILE, { ...FILE, id: 6, fileName: "Sample notes.txt", contentType: "text/plain", length: 12 }]);
      },
    });
    renderActivity("/calendar/activities/20001");
    const input = await screen.findByLabelText("Add files");
    // The picker's accept attribute would hide the .exe; a user can still choose "All files", and the server decides.
    await userEvent.setup({ applyAccept: false }).upload(input, [new File(["notes"], "Sample notes.txt", { type: "text/plain" }), new File(["MZ"], "Sample.exe")]);
    const records = screen.getByRole("group", { name: "Records" });
    expect(await within(records).findByRole("link", { name: "Sample notes.txt" })).toBeInTheDocument();
    expect(within(records).getByRole("alert")).toHaveTextContent("Sample.exe: This type of file can't be attached.");
    expect(within(records).getByRole("status")).toHaveTextContent("Added 1 file.");
    const lockAt = calls.findIndex((c) => c.url.endsWith("/lock"));
    const firstUpload = calls.findIndex((c) => c.url === FILES);
    expect(lockAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(firstUpload);
    expect(calls[firstUpload]!.init!.body).toBeInstanceOf(File);
    expect(new Headers(calls[firstUpload]!.init!.headers).get("X-GCPE-File-Name")).toBe(encodeURIComponent("Sample notes.txt"));
  });

  it("refuses a file over 25 MB without sending it", async () => {
    const calls: Call[] = [];
    stubActivity(calls, { config: { ...CONFIG, showRecordsSection: true } });
    renderActivity("/calendar/activities/20001");
    const big = new File(["x"], "Sample big.pdf");
    Object.defineProperty(big, "size", { value: 26 * 1024 * 1024 });
    await userEvent.upload(await screen.findByLabelText("Add files"), big);
    expect(await screen.findByText("Sample big.pdf: A file can be at most 25 MB.")).toBeInTheDocument();
    expect(calls.some((c) => c.url === FILES)).toBe(false);
  });

  it("removes a file after asking", async () => {
    stubActivity([], {
      view: view({ files: [FILE] }),
      other: (url, init) => (url === `${FILES}/5` && init?.method === "DELETE" ? jsonResponse(200, []) : undefined),
    });
    renderActivity("/calendar/activities/20001");
    await userEvent.click(await screen.findByRole("button", { name: "Remove Sample brief.pdf" }));
    await userEvent.click(within(await screen.findByRole("alertdialog", { name: "Remove Sample brief.pdf?" })).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Removed Sample brief.pdf.")).toBeInTheDocument();
    expect(screen.getByText("No files yet.")).toBeInTheDocument();
  });

  it("a read-only viewer can download but not add or remove", async () => {
    stubActivity([], { view: view({ files: [FILE], can: { edit: false, clone: false, delete: false, review: false } }) });
    renderActivity("/calendar/activities/20001");
    const records = await screen.findByRole("group", { name: "Records" });
    expect(within(records).getByRole("link", { name: "Sample brief.pdf" })).toBeInTheDocument();
    expect(within(records).queryByLabelText("Add files")).toBeNull();
    expect(within(records).queryByRole("button", { name: "Remove Sample brief.pdf" })).toBeNull();
  });

  it("a new activity says to save first when Records is on", async () => {
    stubActivity([], { config: { ...CONFIG, showRecordsSection: true } });
    renderActivity("/calendar/activities/new");
    expect(await screen.findByText("Save the activity first to add files.")).toBeInTheDocument();
  });
});
```

Append to `apps/staff-web/src/screens/calendar/activity/a11y.test.tsx`:

```tsx
  it("Records with files and a refused upload", async () => {
    stubActivity([], {
      view: view({ files: [{ id: 5, fileName: "Sample brief.pdf", contentType: "application/pdf", length: 2048, uploadedAt: "2026-11-02T17:00:00.000Z", uploadedByName: "Robin Staff" }] }),
      other: (url, init) => (url.endsWith("/files") && init?.method === "POST" ? jsonResponse(422, { error: "Fix the fields named", errors: [{ field: "files", message: "The file is empty." }] }) : undefined),
    });
    const { container } = renderActivity("/calendar/activities/20001");
    await userEvent.upload(await screen.findByLabelText("Add files"), new File([""], "Sample empty.pdf"));
    await screen.findByText("Sample empty.pdf: The file is empty.");
    expect(await seriousViolations(container)).toEqual([]);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/calendar/activity`
Expected: FAIL: no Records group.

- [ ] **Step 3: Implement**

Create `apps/staff-web/src/screens/calendar/activity/RecordsSection.tsx`:

```tsx
import { useState } from "react";
import { AlertDialog, Button, Modal } from "@bcgov/design-system-react-components";
import { ATTACHMENT_ACCEPT, ATTACHMENT_MAX_BYTES, type ActivityFileView, type FieldError } from "@gcpe/calendar-contract";
import { ApiError } from "../../../api/client";
import { activityApi } from "./api";

const TOO_BIG = "A file can be at most 25 MB.";
const size = (n: number) => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const day = (iso: string, timeZone: string) => new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));
function messageOf(e: unknown): string {
  if (e instanceof ApiError && e.status === 422) return (e.body as { errors?: FieldError[] } | undefined)?.errors?.[0]?.message ?? e.message;
  if (e instanceof ApiError && e.status === 413) return TOO_BIG;
  if (e instanceof ApiError) return e.message;
  return "Couldn't reach the server. Try again.";
}

/**
 * Records (spec addendum §8.4): each file is added or removed at once, on its own (C180), after
 * the edit lock is taken. Downloads go through the Calendar's authorised route.
 */
export function RecordsSection({ activityId, files, canChange, beforeChange, onFiles, timeZone }: {
  activityId: number;
  files: readonly ActivityFileView[];
  canChange: boolean;
  beforeChange: () => Promise<boolean>;
  onFiles: (files: ActivityFileView[]) => void;
  timeZone: string;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ActivityFileView | null>(null);

  const add = async (picked: File[]) => {
    if (picked.length === 0 || !(await beforeChange())) return;
    setBusy(true);
    setProblems([]);
    setStatus(null);
    const failed: string[] = [];
    let added = 0;
    for (const file of picked) {
      if (file.size > ATTACHMENT_MAX_BYTES) {
        failed.push(`${file.name}: ${TOO_BIG}`);
        continue;
      }
      try {
        onFiles(await activityApi.addFile(activityId, file));
        added++;
      } catch (e) {
        failed.push(`${file.name}: ${messageOf(e)}`);
      }
    }
    setBusy(false);
    setProblems(failed);
    if (added) setStatus(`Added ${added} file${added === 1 ? "" : "s"}.`);
  };

  const remove = async (file: ActivityFileView) => {
    setRemoving(null);
    if (!(await beforeChange())) return;
    setBusy(true);
    setProblems([]);
    try {
      onFiles(await activityApi.removeFile(activityId, file.id));
      setStatus(`Removed ${file.fileName}.`);
    } catch (e) {
      setProblems([`${file.fileName}: ${messageOf(e)}`]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset className="gcpe-fieldset gcpe-records">
      <legend>Records</legend>
      {files.length === 0 ? (
        <p>No files yet.</p>
      ) : (
        <ul>
          {files.map((f) => (
            <li key={f.id}>
              <a href={activityApi.fileUrl(activityId, f.id)} download={f.fileName}>
                {f.fileName}
              </a>{" "}
              <span className="gcpe-hint">{`${size(f.length)}, added ${day(f.uploadedAt, timeZone)}${f.uploadedByName ? ` by ${f.uploadedByName}` : ""}`}</span>
              {canChange && (
                <Button variant="secondary" isDisabled={busy} aria-label={`Remove ${f.fileName}`} onPress={() => setRemoving(f)}>
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canChange && (
        <div className="gcpe-field">
          <label htmlFor="activity-files">Add files</label>
          <input
            id="activity-files"
            type="file"
            multiple
            accept={ATTACHMENT_ACCEPT}
            disabled={busy}
            aria-describedby="activity-files-hint"
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              e.target.value = "";
              void add(picked);
            }}
          />
          <span id="activity-files-hint" className="gcpe-hint">
            PDF, PNG, JPEG or GIF images, Word, Excel, PowerPoint, Outlook messages, RTF, text or CSV, up to 25 MB each. A file with the same name replaces the old one.
          </span>
        </div>
      )}
      {status && <p role="status">{status}</p>}
      {problems.length > 0 && (
        <div role="alert">
          <ul>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      <Modal isOpen={removing !== null} onOpenChange={(open) => { if (!open) setRemoving(null); }} isDismissable>
        <AlertDialog
          variant="destructive"
          title={`Remove ${removing?.fileName ?? ""}?`}
          buttons={
            <>
              <Button variant="secondary" onPress={() => setRemoving(null)}>
                Cancel
              </Button>
              <Button danger onPress={() => removing && void remove(removing)}>
                Remove
              </Button>
            </>
          }
        >
          <p>The file is deleted from this activity.</p>
        </AlertDialog>
      </Modal>
    </fieldset>
  );
}
```

In `apps/staff-web/src/screens/calendar/activity/ActivityScreen.tsx`: import `RecordsSection` from `./RecordsSection`, and replace `records={null}` with:

```tsx
            records={
              isNew ? (
                config.showRecordsSection ? (
                  <fieldset className="gcpe-fieldset gcpe-records">
                    <legend>Records</legend>
                    <p>Save the activity first to add files.</p>
                  </fieldset>
                ) : null
              ) : config.showRecordsSection || view!.files.length > 0 ? (
                <RecordsSection
                  activityId={view!.id}
                  files={view!.files}
                  canChange={!readOnly}
                  beforeChange={() => lock.touch()}
                  onFiles={(files) => setView((v) => (v ? { ...v, files } : v))}
                  timeZone={config.timeZone}
                />
              ) : null
            }
```

The Records fieldset sits inside the form's disabled outer fieldset when read-only, so its controls are disabled with the rest, while its download links stay usable.

- [ ] **Step 4: Run them to see them pass, then the staff-web suite, both type-checks and the affected e2e specs**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web`
Expected: PASS.
Run both `tsc` commands.
Run: `npx -y -p node@24 -- npm run test:e2e -- tests/e2e/calendar-list.spec.ts tests/e2e/axe-sweep.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/staff-web/src/screens/calendar/activity
git commit -m "feat(staff-web): Records on the activity page: add several files, remove one, download through the authorised route"
```

---
### Task 6: End to end: every role, the lock lapsing, attachments' authorisation; the axe sweep; parity, running notes and carry-forward

Covers: spec §3 row 5e's exit checks (an editor e2e for each role; attachment authorisation tests, another ministry's confidential file gives 404; a lock-expiry e2e), §16 acceptance 2 (the attachment URL is 404 to an HQ Editor outside the ministry), 4 (two users, "<name> is editing", the 15-minute lapse, a stale save gets 409), 8 ("View changes"), 11 (upload, blocked extension refused, download refused), 18 (axe on every Calendar screen). Decisions E24, E25. Review Focus 2.

**Files:**
- Modify: `tests/e2e/global-setup.ts`, `tests/e2e/playwright-support.ts`, `tests/e2e/axe-sweep.spec.ts`, `docs/parity/changes-from-legacy.md`, `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`, `docs/superpowers/plans/phase-5-carry-forward.md`.
- Create: `tests/e2e/calendar-editor.spec.ts`.

**Interfaces:**
- Consumes: everything above; `listFixture`, `activityInput`, `sessionOf`, `useCookie`, `listUrl` (`calendar-support.ts`); `apiCall`, `baseUrl`, `expectNoSeriousA11yViolations` (`playwright-support.ts`).
- Produces: `calendarDb(): Db` in `tests/e2e/playwright-support.ts`; the suite's Calendar tenant file (freeze moved 12 hours away).

- [ ] **Step 1: The suite's tenant and the database helper**

`tests/e2e/global-setup.ts`:
- Add `readFile` to the `node:fs/promises` import.
- After `const sessionDir = await mkdtemp(…)`:

```ts
  // The Calendar's tenant file for the suite: BC's, with the 4pm-5pm freeze moved to start 12 hours
  // after setup, so editor journeys by users the freeze binds run at any hour. The freeze itself is
  // covered by the Calendar's clock tests and the editor's component tests.
  const tenantDir = await mkdtemp(join(tmpdir(), "gcpe-e2e-tenant-"));
  const bcTenant = JSON.parse(await readFile(join(repoRoot, "config/tenants/bc.json"), "utf8")) as { calendar: { freeze: { start: string; end: string } } };
  const later = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(Date.now() + 12 * 3_600_000));
  const hour = Number(later.find((p) => p.type === "hour")!.value);
  const hhmm = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;
  bcTenant.calendar.freeze = { start: hhmm(hour), end: hhmm(hour + 1) };
  const calendarTenant = join(tenantDir, "bc-e2e.json");
  await writeFile(calendarTenant, JSON.stringify(bcTenant));
```

- In `env`, after `CALENDAR_DATABASE_URL: calendar.url,`: `CALENDAR_TENANT_CONFIG: calendarTenant,`
- In the teardown, after the `sessionDir` removal: `await step(() => rm(tenantDir, { recursive: true, force: true }));`

`tests/e2e/playwright-support.ts`, after `distDb()`:

```ts
let cachedCalendarDb: Db | undefined;

/** A direct connection to the Calendar's test database: the lock-expiry spec ages a lock row, as the stack's tick has no clock hook to do it. */
export function calendarDb(): Db {
  if (!cachedCalendarDb) {
    const url = process.env.E2E_CALENDAR_DATABASE_URL;
    if (!url) throw new Error("E2E_CALENDAR_DATABASE_URL is not set — tests/e2e/global-setup.ts must run first.");
    cachedCalendarDb = createDb(url, { max: 2 }).db;
  }
  return cachedCalendarDb;
}
```

- [ ] **Step 2: Write the spec**

Create `tests/e2e/calendar-editor.spec.ts`:

```ts
// The 5e exit checks: the activity editor driven as each Calendar role, an edit lock that lapses
// after 15 idle minutes, and attachments that only those who can see the activity may download
// (another ministry's confidential file is a 404). Fixtures are written by the HQ Administrator,
// whom the freeze doesn't bind; the suite's tenant moves the freeze 12 hours away, so non-exempt
// editors save at any hour.
import { test, expect, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import {
  CAL_ADMIN_EMAIL, CAL_ADVANCED_EMAIL, CAL_EDITOR_EMAIL, CAL_HQ_ADMIN_EMAIL, CAL_HQ_ADVANCED_EMAIL, CAL_HQ_EDITOR_EMAIL, CAL_READONLY_EMAIL, CAL_SYSADMIN_EMAIL,
} from "./constants";
import { activityInput, listFixture, listUrl, sessionOf, useCookie, type ListFixture } from "./calendar-support";
import { apiCall, baseUrl, calendarDb, expectNoSeriousA11yViolations } from "./playwright-support";

const activityUrl = (id: number) => `${baseUrl()}/hub/calendar/activities/${id}`;
const PDF = Buffer.from("%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n", "latin1");
const AUGUST = { from: "2031-08-01", to: "2031-08-31" };
const titleBox = (page: Page) => page.getByRole("textbox", { name: "Title", exact: true });
const stampOf = () => `ed${Date.now()}`;

/** A Health activity in August 2031 that a ministry editor can save as it stands (Summary, Significance and Scheduling filled). */
async function scratch(f: ListFixture, title: string, o: { confidential?: boolean } = {}): Promise<number> {
  const hq = await sessionOf(CAL_HQ_ADMIN_EMAIL);
  const body = {
    ...activityInput(f, { title, ministry: "health", contact: f.health, time: "09:00", date: "2031-08-12", confidential: o.confidential }),
    details: "Sample summary", significance: "Sample significance", schedule: "Sample scheduling",
  };
  return (await apiCall<{ id: number }>(hq, "/calendar/api/activities", { method: "POST", body })).id;
}

/** A ministry editor's change to the title: it raises `title` for HQ's review and moves the status to changed. */
async function changeTitle(id: number, title: string): Promise<void> {
  const editor = await sessionOf(CAL_EDITOR_EMAIL);
  const v = await apiCall<{ version: number; fields: object }>(editor, `/calendar/api/activities/${id}`);
  await apiCall(editor, `/calendar/api/activities/${id}`, { method: "PUT", body: { ...v.fields, title, version: v.version, tabId: null } });
}

test.describe("the activity editor, as each role (spec addendum §3 row 5e, §6)", () => {
  test("Read Only: their ministry's activity opens read-only, with the star and View changes", async ({ page, context }) => {
    const f = await listFixture();
    await useCookie(context, await sessionOf(CAL_READONLY_EMAIL));
    await page.goto(activityUrl(f.ids.C));
    await expect(page.getByRole("heading", { level: 1, name: `Activity FIN-${f.ids.C}` })).toBeVisible();
    await expect(page.getByText("You can view this activity but not change it.")).toBeVisible();
    await expect(titleBox(page)).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: `Watch FIN-${f.ids.C}` })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "the editor, read-only");
    await page.getByRole("link", { name: "View changes" }).click();
    await expect(page.getByRole("heading", { level: 1, name: `Changes to FIN-${f.ids.C}` })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2 }).first()).toContainText("Test Calendar HQ Administrator created it");
    await expectNoSeriousA11yViolations(page, "View changes");
  });

  test("Editor: opens a title from the list, saves a change, comes back to the same list, and watches the activity", async ({ page, context }) => {
    const f = await listFixture();
    const stamp = stampOf();
    const id = await scratch(f, `Edit ${stamp}`);
    await useCookie(context, await sessionOf(CAL_EDITOR_EMAIL));
    await page.goto(listUrl({ filter: { ...AUGUST, quickSearch: stamp } }));
    const link = page.getByRole("link", { name: `Edit ${stamp}` });
    await expect(link).toBeVisible();
    // The list's address as the user left it, whatever the list made of the query on load.
    const list = page.url();
    await link.click();
    await expect(page.getByRole("heading", { level: 1, name: `Activity HLTH-${id}` })).toBeVisible();
    for (const name of ["Delete", "Review"]) await expect(page.getByRole("button", { name })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Look Ahead" })).toHaveCount(0);
    await expectNoSeriousA11yViolations(page, "the editor, as a ministry editor");
    await titleBox(page).fill(`Edited ${stamp}`);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page).toHaveURL(list);
    await expect(page.getByRole("status").filter({ hasText: `Saved HLTH-${id}.` })).toBeVisible();
    await expect(page.locator(".gcpe-activity-title")).toHaveText([`Edited ${stamp}`]);

    await page.goto(activityUrl(id));
    const star = page.getByRole("button", { name: `Watch HLTH-${id}` });
    await star.click();
    await expect(star).toHaveAttribute("aria-pressed", "true");
    await page.goto(listUrl({ filter: { ...AUGUST, quickSearch: stamp }, display: "my_watchlist" }));
    await expect(page.locator(".gcpe-activity-title")).toHaveText([`Edited ${stamp}`]);
  });

  test("Editor: creates an activity from New activity, after the form's own check", async ({ page, context }) => {
    const f = await listFixture();
    const stamp = stampOf();
    await useCookie(context, await sessionOf(CAL_EDITOR_EMAIL));
    await page.goto(listUrl({ filter: { ...AUGUST, quickSearch: stamp } }));
    await page.getByRole("link", { name: "New activity" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "New activity" })).toBeVisible();
    await page.getByRole("button", { name: "Save" }).click();
    const summary = page.getByRole("alert").filter({ hasText: "Fix these to save" });
    await expect(summary.getByRole("link", { name: "Enter a title" })).toBeVisible();
    await expect(summary).toBeFocused();
    await expectNoSeriousA11yViolations(page, "a new activity's error summary");
    await page.getByRole("combobox", { name: "Category" }).selectOption(String(f.category));
    await titleBox(page).fill(`Created ${stamp}`);
    await page.getByRole("textbox", { name: "Summary" }).fill("Sample summary");
    await page.getByRole("textbox", { name: "Significance" }).fill("Sample significance");
    await page.getByRole("textbox", { name: "Scheduling considerations" }).fill("Sample scheduling");
    await page.getByRole("combobox", { name: "Comm Contact" }).selectOption(String(f.health));
    await page.getByLabel("Start date").fill("2031-08-13");
    await page.getByLabel("End date").fill("2031-08-13");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/^Created HLTH-\d+\.$/)).toBeVisible();
    const id = Number(/activities\/(\d+)/.exec(page.url())![1]);
    await expect(page.getByRole("heading", { level: 1, name: `Activity HLTH-${id}` })).toBeVisible();
  });

  test("Advanced: another ministry's activity shared with theirs is view-only", async ({ page, context }) => {
    const f = await listFixture();
    await useCookie(context, await sessionOf(CAL_ADVANCED_EMAIL));
    await page.goto(activityUrl(f.ids.E));
    await expect(page.getByText("Your ministry is shared on this activity: you can view it but not change it.")).toBeVisible();
    await expect(titleBox(page)).toBeDisabled();
  });

  test("Administrator: deletes an activity after confirming; it is gone for them", async ({ page, context }) => {
    const f = await listFixture();
    const id = await scratch(f, `Delete ${stampOf()}`);
    const cookie = await sessionOf(CAL_ADMIN_EMAIL);
    await useCookie(context, cookie);
    await page.goto(activityUrl(id));
    await page.getByRole("button", { name: "Delete" }).click();
    const dialog = page.getByRole("alertdialog", { name: `Delete HLTH-${id}?` });
    await expect(dialog).toBeVisible();
    await expectNoSeriousA11yViolations(page, "the delete confirmation");
    await dialog.getByRole("button", { name: "Delete" }).click();
    await expect(page).toHaveURL(`${baseUrl()}/hub/calendar`);
    await expect(page.getByRole("status").filter({ hasText: `Deleted HLTH-${id}.` })).toBeVisible();
    expect((await fetch(`${baseUrl()}/calendar/api/activities/${id}`, { headers: { cookie } })).status).toBe(404);
  });

  test("System Administrator: clones an activity and lands on the clone", async ({ page, context }) => {
    const f = await listFixture();
    const stamp = stampOf();
    const id = await scratch(f, `Clone ${stamp}`);
    await useCookie(context, await sessionOf(CAL_SYSADMIN_EMAIL));
    await page.goto(activityUrl(id));
    await page.getByRole("button", { name: "Clone" }).click();
    await expect(page.getByText(new RegExp(`^Cloned HLTH-${id} as HLTH-\\d+\\.$`))).toBeVisible();
    expect(Number(/activities\/(\d+)/.exec(page.url())![1])).not.toBe(id);
    await expect(titleBox(page)).toHaveValue(`Clone ${stamp}`);
  });

  test("HQ Editor: the Look Ahead fieldset and the needs-review markup; another ministry's confidential activity is not found", async ({ page, context }) => {
    const f = await listFixture();
    const stamp = stampOf();
    const id = await scratch(f, `Markup ${stamp}`);
    await changeTitle(id, `Markup changed ${stamp}`);
    await useCookie(context, await sessionOf(CAL_HQ_EDITOR_EMAIL));
    await page.goto(activityUrl(id));
    await expect(page.getByRole("group", { name: "Look Ahead" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "LA Section" })).toBeVisible();
    await expect(titleBox(page)).toHaveAccessibleDescription(/Changed: needs review/);
    await expect(page.getByRole("button", { name: "Review" })).toHaveCount(0);
    await expectNoSeriousA11yViolations(page, "the editor as an HQ Editor");
    await page.goto(activityUrl(f.ids.B));
    await expect(page.getByRole("heading", { level: 1, name: "Activity not found" })).toBeVisible();
  });

  test("HQ Advanced: reviews a changed activity and returns", async ({ page, context }) => {
    const f = await listFixture();
    const stamp = stampOf();
    const id = await scratch(f, `Reviewed ${stamp}`);
    await changeTitle(id, `Reviewed changed ${stamp}`);
    const hqAdvanced = await sessionOf(CAL_HQ_ADVANCED_EMAIL);
    await useCookie(context, hqAdvanced);
    await page.goto(activityUrl(id));
    await page.getByRole("button", { name: "Review" }).click();
    await expect(page.getByRole("status").filter({ hasText: `Reviewed HLTH-${id}.` })).toBeVisible();
    expect((await apiCall<{ status: string }>(hqAdvanced, `/calendar/api/activities/${id}`)).status).toBe("reviewed");
  });

  test("HQ Administrator: a deleted activity opens read-only, with Review its only action", async ({ page, context }) => {
    const f = await listFixture();
    await useCookie(context, await sessionOf(CAL_HQ_ADMIN_EMAIL));
    await page.goto(activityUrl(f.ids.F));
    await expect(page.getByText("This activity is deleted.", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Review" })).toBeEnabled();
    for (const name of ["Save", "Clone", "Delete"]) await expect(page.getByRole("button", { name })).toHaveCount(0);
    await expect(titleBox(page)).toBeDisabled();
  });
});

test("edit locks: the second user waits read-only, the lock lapses after 15 idle minutes, and the first user's stale save is refused (spec addendum §7.5)", async ({ browser }) => {
  const f = await listFixture();
  const stamp = stampOf();
  const id = await scratch(f, `Locked ${stamp}`);
  const editorContext = await browser.newContext();
  const adminContext = await browser.newContext();
  const adminCookie = await sessionOf(CAL_ADMIN_EMAIL);
  await useCookie(editorContext, await sessionOf(CAL_EDITOR_EMAIL));
  await useCookie(adminContext, adminCookie);
  const first = await editorContext.newPage();
  const second = await adminContext.newPage();
  await first.clock.install();
  await second.clock.install();
  try {
    await first.goto(activityUrl(id));
    await titleBox(first).fill(`Mine ${stamp}`);
    await expect.poll(async () => (await apiCall<{ lock: { holderName: string } | null }>(adminCookie, `/calendar/api/activities/${id}`)).lock?.holderName).toBe("Test Calendar Editor");

    await second.goto(activityUrl(id));
    await expect(second.getByText(/^Test Calendar Editor is editing this activity \(since \d{1,2}:\d{2} [AP]M\)/)).toBeVisible();
    await expect(titleBox(second)).toBeDisabled();
    await expectNoSeriousA11yViolations(second, "the editor, locked by someone else");

    // Fifteen idle minutes: the browsers' clocks for the pages' timers, the database's for the lock row.
    await first.clock.fastForward("15:01");
    await expect(first.getByText("Your edit lock lapsed after 15 minutes without input.", { exact: false })).toBeVisible();
    await calendarDb().execute(sql`UPDATE activity_locks SET last_active_at = last_active_at - interval '16 minutes' WHERE activity_id = ${id}`);
    await second.clock.fastForward("00:31");
    await expect(titleBox(second)).toBeEnabled();

    await titleBox(second).fill(`Theirs ${stamp}`);
    await second.getByRole("button", { name: "Save" }).click();
    await expect(second).toHaveURL(`${baseUrl()}/hub/calendar`);

    await expect(titleBox(first)).toHaveValue(`Mine ${stamp}`);
    await first.getByRole("button", { name: "Save" }).click();
    await expect(first.getByText("Someone else changed this activity — reload to see their changes")).toBeVisible();
    await expect(titleBox(first)).toHaveValue(`Mine ${stamp}`);
    await expectNoSeriousA11yViolations(first, "the editor after a version conflict");
  } finally {
    await editorContext.close();
    await adminContext.close();
  }
});

test("attachments: another ministry's confidential file is a 404; the owning ministry downloads, adds and removes files (spec addendum §8.4; C138)", async ({ page, context }) => {
  const f = await listFixture();
  const stamp = stampOf();
  const id = await scratch(f, `Files ${stamp}`, { confidential: true });
  const hq = await sessionOf(CAL_HQ_ADMIN_EMAIL);
  const up = await fetch(`${baseUrl()}/calendar/api/activities/${id}/files`, {
    method: "POST",
    headers: { cookie: hq, "x-gcpe-request": "1", "content-type": "application/octet-stream", "x-gcpe-file-name": encodeURIComponent("Sample brief.pdf") },
    body: new Uint8Array(PDF),
  });
  expect(up.status).toBe(201);
  const [file] = (await up.json()) as { id: number }[];
  const download = async (email: string) => fetch(`${baseUrl()}/calendar/api/activities/${id}/files/${file!.id}`, { headers: { cookie: await sessionOf(email) } });
  expect((await download(CAL_READONLY_EMAIL)).status).toBe(404);
  expect((await download(CAL_HQ_EDITOR_EMAIL)).status).toBe(404);
  const own = await download(CAL_EDITOR_EMAIL);
  expect(own.status).toBe(200);
  expect(own.headers.get("content-disposition")).toContain("attachment");
  expect(own.headers.get("x-content-type-options")).toBe("nosniff");
  expect(Buffer.from(await own.arrayBuffer()).equals(PDF)).toBe(true);
  expect((await download(CAL_HQ_ADVANCED_EMAIL)).status).toBe(200);

  await useCookie(context, await sessionOf(CAL_EDITOR_EMAIL));
  await page.goto(activityUrl(id));
  const records = page.getByRole("group", { name: "Records" });
  const [saved] = await Promise.all([page.waitForEvent("download"), records.getByRole("link", { name: "Sample brief.pdf" }).click()]);
  expect(saved.suggestedFilename()).toBe("Sample brief.pdf");
  await records.getByLabel("Add files").setInputFiles([
    { name: "Sample notes.txt", mimeType: "text/plain", buffer: Buffer.from("Sample notes") },
    { name: "Sample.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") },
  ]);
  await expect(records.getByRole("link", { name: "Sample notes.txt" })).toBeVisible();
  await expect(records.getByRole("alert")).toHaveText("Sample.exe: This type of file can't be attached.");
  await expectNoSeriousA11yViolations(page, "Records after an upload and a refusal");
  await records.getByRole("button", { name: "Remove Sample notes.txt" }).click();
  await page.getByRole("alertdialog", { name: "Remove Sample notes.txt?" }).getByRole("button", { name: "Remove" }).click();
  await expect(records.getByRole("link", { name: "Sample notes.txt" })).toHaveCount(0);
  // Leaving the page releases the lock the uploads took.
  await page.goto(listUrl({ filter: { ...AUGUST, quickSearch: stamp } }));
});
```

Append to `tests/e2e/axe-sweep.spec.ts`, inside its Calendar `describe`, after the list test (the file already imports `listFixture`, `sessionOf`, `useCookie`; add `CAL_HQ_ADMIN_EMAIL` if it isn't imported):

```ts
  // The activity editor as an HQ Administrator (every fieldset, the Look Ahead fieldset, every
  // action), a new activity, and View changes.
  test("the Calendar activity editor, a new activity, and View changes", async ({ page, context }) => {
    const f = await listFixture();
    await useCookie(context, await sessionOf(CAL_HQ_ADMIN_EMAIL));
    await gotoAndWaitForH1(page, `/hub/calendar/activities/${f.ids.A}`);
    await expect(page.getByRole("group", { name: "Look Ahead" })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "the activity editor as an HQ Administrator");
    await gotoAndWaitForH1(page, "/hub/calendar/activities/new");
    await expect(page.getByRole("textbox", { name: "Title", exact: true })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "a new activity");
    await gotoAndWaitForH1(page, `/hub/calendar/activities/${f.ids.A}/changes`);
    await expect(page.getByRole("heading", { level: 1, name: `Changes to HLTH-${f.ids.A}` })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "View changes");
  });
```

- [ ] **Step 3: See the spec fail once, then pass, then run the full suite**

The spec exercises Tasks 1–5's code, so it passes as written. Show it can fail: change the lock test's expected holder in `toBe("Test Calendar Editor")` to `toBe("Nobody")`, run it and see that test FAIL on the poll, then restore it.
Run: `npx -y -p node@24 -- npm run test:e2e -- tests/e2e/calendar-editor.spec.ts tests/e2e/axe-sweep.spec.ts`
Expected: PASS.
Run: `npx -y -p node@24 -- npm run test:e2e`
Expected: PASS, every spec, including `calendar-list.spec.ts` and `sign-in-roles.spec.ts`.
Run the full Vitest suite and both `tsc` commands: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run`. Expected: PASS.

- [ ] **Step 4: The docs**

`docs/parity/changes-from-legacy.md`, in "Corporate Calendar (Phase 5)":
- C128's Status: `Agreed (built in 5c-1; the editor's side in 5e-2)`.
- C133's Status: `Agreed (View changes built in 5e-2)`.
- C136's Status: `Agreed (built in 5e-2)`.
- C149's Status: `Agreed (built in 5e-2)`.
- C176's "New" cell becomes: "The star toggles on the activity page, as legacy's did, and also from the list's Activity Id cell; both name who watches." Its "Why" cell: "Legacy's place for the star is back with the activity page; the list keeps one so My Watchlist can be filled from it." Status stays Proposed.
- C180's "New" cell gains, at its end: " A new activity takes files once it has been saved."

`docs/manuals/running-notes.md`, append:

```markdown
## Phase 5e-2 — The activity page

- **All Calendar users** — Click an activity's title in the list or the calendar to open it. Save, Cancel, Review and Delete bring you back to the list as you left it, filter and all.
- **All Calendar users** — "View changes" lists every change to the activity, newest first: who, when, and each field before and after. Changes from the old Calendar are marked "from legacy log".
- **All Calendar users** — The star on the activity page adds it to My Watchlist; hover or focus it to see who else watches it.
- **All Calendar users** — An activity you can't see, or that doesn't exist, says "Activity not found".
- **Calendar editors** — "New activity" on the list opens a blank activity at 8:00 AM to 6:00 PM. Saving opens it, ready for files.
- **Calendar editors** — The form checks itself before saving: a box at the top lists what to fix, each linked to its field. A start or end date in the past is a warning, not a stop.
- **Calendar editors** — Potential Dates is shown again, under Schedule. Use a general timeline, like "late June": no numbers, TBC or TBD.
- **Calendar editors** — When someone else is editing, the page says who and since when, and stays read-only. It opens for you, without a reload, once they save, cancel or leave it for 15 minutes.
- **Calendar editors** — Open in two of your own tabs? "Continue here" moves your editing to this tab.
- **Calendar editors** — Leave the page alone for 15 minutes and your edit lock lapses. Your changes stay on the page, and Save still works if nobody else changed the activity; if they did, you're told to reload.
- **Calendar editors** — Between 4pm and 5pm the page opens read-only, with the freeze message, unless you're HQ.
- **Calendar editors** — Records (files) shows on activities that have files. Add several at once; each is checked and saved straight away, and refused ones say why.
- **HQ Editor and above** — The Look Ahead fieldset follows the activity: the section is worked out from the category, Issue, confirmation and comm materials. Choose another to override it (marked "Override"); "Use the inferred section" undoes that.
- **HQ Editor and above** — Fields changed since the last review say "Changed: needs review".
- **HQ Advanced and above** — Review marks the activity reviewed and brings you back. Review and Clone wait until you've saved or cancelled your own changes.
- **HQ Administrator** — A deleted activity opens read-only, with Review as its only action.
- **NRMS users** — "BC Gov News" on an activity links to each of its releases.
```

`docs/deploy/siteground.md`: after "### Activity files (Phase 5e-1)", add "### Activity page (Phase 5e-2)": nothing to configure. The hand checks on boxs.ca after deploy, from spec §16's starred items: (1) open one activity as two users in two browsers and see "<name> is editing"; (2) between 16:00 and 17:00 BC, a ministry editor's page opens read-only with the freeze message and an HQ Editor's doesn't; (3) "View changes" shows the edit just made; (4) an attachment's link opens for its own ministry and is "not found" for another ministry's user.

`docs/superpowers/plans/phase-5-carry-forward.md`: delete the whole "## 5e" section. Add to "## 5f": "**The feed's `MIN-Id` links open the activity page** at `/hub/calendar/activities/:id`, with `?return=` set to the feed's own address (`activityPath` in `apps/staff-web/src/screens/calendar/activity/paths.ts`), so Save comes back to the feed (C149)." Add to "## 5g": "**Report rows link to the activity page** at `/hub/calendar/activities/:id` (no `return`: the editor falls back to the list)."

- [ ] **Step 5: Commit**

```bash
git add tests/e2e docs
git commit -m "test(e2e),docs: the activity editor as each role, an edit lock lapsing, attachment authorisation; axe sweep; parity C128 C133 C136 C149 C176 C180; running notes"
```

---

## Phase 5e-2 at a glance

| Task | Delivers | Exit evidence |
|---|---|---|
| 1 | Form model, paths, API module | `form.test.ts`, `paths.test.ts` |
| 2 | The edit lock in the browser | `useEditLock.test.tsx` |
| 3 | The editor: fieldsets, validation, read-only states, save, return; list links | `ActivityScreen.test.tsx`, `a11y.test.tsx`; list e2e green |
| 4 | Review, Delete, Clone, star, BC Gov News, View changes | `ActivityActions.test.tsx`, `ChangesScreen.test.tsx` |
| 5 | Records | `RecordsSection.test.tsx` |
| 6 | E2E for every role, the lock lapse, attachment authorisation; docs | `calendar-editor.spec.ts`; full e2e green |

## Risks and things to watch

- **`page.clock` and the polling interval.** The lock-expiry spec relies on Playwright 1.63's clock firing the page's `setInterval` on `fastForward`. If it doesn't, the spec's `toBeEnabled` times out: replace the second page's `fastForward("00:31")` with `runFor("00:31")`, never with a real 30-second wait.
- **ICU spacing in times.** Every time the editor shows goes through `timeText` (`formatToParts`), so it has a plain space; a new `Intl` time format elsewhere would bring back the narrow no-break space Chrome and Node now use, and break exact-text tests.
- **The comm-contact list is everyone's** (E12). Watch its size on boxs.ca; scope it by ministry if it grows past a few thousand.
- **Imported activities with two categories or several origins.** The browser infers the Look Ahead section from the one category it shows; the server uses all of them while the category is unchanged. They can differ only for imported data; the server's stored section is what counts, and the editor shows the stored one on load.
- **Not checked here:** the Look Ahead fieldset with `ShowHqCommentsField` on (BC has it off; the server's rule is tested in 5c); screen magnification and Windows High Contrast (axe doesn't cover them); the freeze starting while a page is open (the 423 path is tested; the page doesn't re-read the freeze on its own).

## Self-review (done while writing)

1. **Spec coverage.** §8.2 fieldsets and order → Task 3 (test "legacy's fieldsets, in legacy's order"); Look Ahead inference and override → Tasks 1, 3; HQ-only fields → Task 3 (config/view-driven); release badges → Task 4; Markup → Task 3; freeze and lock states → Tasks 2, 3; validation and server errors → Task 3; Actions (Save, Review, Delete, Clone, Watchlist, Cancel, View changes) → Tasks 3, 4; Records → Task 5; §8.3 → Task 4; §8.4 download through the authorised route → Task 5 (UI), 5e-1 (server); §3 row 5e exits → Task 6; §16 acceptance 2, 4, 8, 11, 18 → Task 6. Carry-forward § 5e → Tasks 1–4, deleted in Task 6.
2. **Placeholder scan.** None found. Every code step carries its code; the one conditional instruction (Task 6's `runFor` fallback) is in Risks, with the exact replacement.
3. **Type consistency.** `CalendarConfigView`'s new keys (Task 1) are read by Tasks 3–5. `EditLock` (Task 2) is used by Task 3 (`touch`, `refused`, `tabId`, `state`) and Task 5 (`touch`). `Change` is exported by `ActivityForm` and used by `ActivityScreen`. `WatchState` (Task 4) matches `ActivityView["watch"]` from 5e-1. `activityApi` method names are the same in Tasks 1–5. `leave(to, notice, replace?)` is the same in Tasks 3 and 4.
4. **Review Focus.** Each of the five has a named test in its owning task (Tasks 1, 2, 3, 5, 6).

## Execution

Both plans have an execution method already chosen by the overnight run (subagent-driven, as the 5c and 5d plans were executed). 5e-1 first, then this plan.
