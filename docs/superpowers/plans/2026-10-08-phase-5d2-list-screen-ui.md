# Phase 5d-2: The Calendar List Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff open `/hub/calendar` and get legacy's activity list: the filter panel, display modes, quick search, sortable columns that load 30 at a time as they scroll, their own column choice, the standing freeze notice, My Queries, the watchlist star, and, for HQ, Review selected, Clear LA Status, Corporate Queries and the Look Ahead filter; an Excel export for everyone; and month and week views of the same filter. End-to-end tests prove each role sees exactly what §6 allows, and axe passes on every state.

**Architecture:**
- **One screen, state in the URL.** `ActivityListScreen` replaces `CalendarHome` at `/hub/calendar`. The `ListQuery` lives in `?q=` (JSON), the view in `?view=` and the calendar's anchor date in `?on=`, so Back, reload and a shared link keep them. With no `?q=`, the user's saved display applies.
- **Small components, one API module.** `list/api.ts` wraps every 5d-1 route through `apiFetch` (the export uses `fetch` for a binary download). `FilterPanel`, `ActivityTable` (with `cells.tsx`), `ColumnChooser`, `MyQueries`, `WatchStar`, `HqTools` and `CalendarGrid` each own one part.
- **The browser imports `@gcpe/calendar-contract`** (zod and pure functions only) for the filter model, column labels and the friendly date range, so the list and the export word dates the same way.
- **End to end:** three seeded Calendar users are added so every role and HQ combination the visibility rule distinguishes has its own visibility test; journeys cover every list feature; the stack-wide axe sweep gains the HQ list and the month view.

**Tech Stack:** React 19, react-router 7, `@bcgov/design-system-react-components`, Vitest 4.1 with jsdom and Testing Library, axe-core, Playwright with `@axe-core/playwright`, Node 24.

**Spec:** `docs/superpowers/specs/2026-10-07-calendar-parity-design.md`:
- §3 row 5d (axe on every state; a visibility e2e for each role);
- §6 (who sees what; the tools' thresholds);
- §7.4 (the list's standing freeze banner; favourites, saved filters and columns not frozen);
- §8 and §8.1 (the list screen);
- §14 (C127, C139, C141, C151, C154), §15, §16 (axe on every Calendar screen; Playwright against the full stack).

The plan also takes these other documents into account:
- **5d-1, `docs/superpowers/plans/2026-10-08-phase-5d-list-screen.md`**, which must be finished first. Its decisions D1–D22 hold here; this plan adds D23–D30.
- `docs/superpowers/plans/phase-5-carry-forward.md` § 5d (the staff-web items; this plan's last task deletes the whole section).
- The 5c-2 plan for the staff-web and e2e conventions it set (`useDocumentTitle`, `latest` refs, `role="status"`, minted sessions, `loginForCookie`).

**Order:** after 5d-1, Tasks 1–5 in order. Tasks 2–4 each extend Task 1's screen.

**Base:**
- **Branch:** `feat/phase-5d` in `/Users/paul/gcpe-news-platform-p5d`, after 5d-1's last commit. Every path is repo-relative.
- **What exists after 5d-1:** the routes `GET /calendar/api/list`, `/list/options`, `/list/preferences` (and `PUT`), `/list/calendar`, `/list/export.xlsx`, `PUT|DELETE /activities/:id/watch`, `/saved-filters` (and `/order`, `/:id`); `GET /calendar/api/config`'s `freeze` and `list` flags; `POST /activities/review-selected` and `/activities/clear-la-status` (5c-1), which answer 207 with `failed: true` after a partial commit; the contract's `ListQuery`, `ListRow`, `ListOptions`, `SavedFilterView`, `CalendarRangeView`, `friendlyDateRange`, `friendlySpan`, `LIST_COLUMNS`, `LIST_COLUMN_LABELS`, `HIDEABLE_COLUMNS`, `LIST_SORTS`, `LIST_DISPLAYS`, `CORPORATE_STATUSES`; `apps/calendar/test/xlsx-read.ts`'s `readXlsx`.
- **Facts this plan relies on (verified by reading):**
  - `apiFetch` (`apps/staff-web/src/api/client.ts`) returns the body for any 2xx, 207 included, and throws `ApiError` (with `status`, `message`, `issues`) otherwise.
  - `CalendarSection` passes `CalendarMe` (`userId`, `displayName`, `level`, `ministryKeys`, `isHq`) through `useCalendarContext()`.
  - `apps/staff-web/src/screens/calendar/a11y.test.tsx` stubs `fetch` and answers `{}` to any URL it doesn't name; it renders `CalendarHome` at the index route.
  - `tests/e2e/global-setup.ts` mints a session for every address in `TEST_USER_PASSWORDS`, after `seedTestUsers` gives the `cal-*` users their Calendar access; `loginForCookie` returns those minted sessions without a real login.
  - The e2e stack uses `config/tenants/bc.json`: Awareness is category 2, release categories 12 and 58. Lookup ids start at 1.
  - The e2e axe helper checks `wcag2a`, `wcag2aa`, `wcag21aa` and `wcag22aa`, so WCAG 2.5.8's 24-pixel target size applies.

---

## Decisions made in planning

Each says why and what it costs if wrong. D1–D22 are 5d-1's. Task 5 writes the parity rows.

- **D23. The list replaces the Calendar home page** at `/hub/calendar`, with the same `h1`, "Corporate Calendar"; the admin links stay in the sub-nav. *If wrong:* a landing page comes back as its own route.
- **D24. The query lives in the URL** (`?q=`, `?view=`, `?on=`), not in memory. *Why:* 5e's editor returns "to where the user came from" (C149); a URL does that for free, and a link to a filtered list can be shared. *If wrong:* very long filters approach the 8,000-character limit; the screen then falls back to the defaults, never an error.
- **D25. Titles aren't links yet.** The activity page is 5e's; until then the list and the calendar view show titles as text, and 5e makes them links (carry-forward). *If wrong:* nothing breaks; staff wait one sub-plan.
- **D26. The watchlist star toggles from the list** (C176, Proposed) because the activity page doesn't exist yet. It is a toggle button with `aria-pressed`, its watchers' names in a tooltip and in screen-reader text.
- **D27. The toolbar holds Review selected (HQ Administrator), Clear LA Status (HQ Editor and above) and Excel export (everyone).** The four report buttons are 5g's, built on the same `?q=`. Review selected sends at most 500 rows, as the API allows; the screen says so.
- **D28. Partial bulk results are reported plainly.** A 207 with `failed: true` from Review selected or Clear LA Status shows an alert with what did commit and asks the user to run it again; it never reads as success.
- **D29. The month and week views** are simple tables built from `GET /api/list/calendar`, Sunday-first like legacy's FullCalendar, with Previous, Today and Next. Multi-day activities appear on each of their days.
- **D30. Three seeded Calendar users are added** for the end-to-end tests: `cal-advanced@example.test` (Advanced, Health), `cal-hq-editor@example.test` and `cal-hq-advanced@example.test` (Editor and Advanced, GCPE Headquarters). With the existing five, every combination the rule tells apart has a visibility test: each level, ministry against HQ, Editor against Advanced for HQ confidential items, Administrator for deletions. *Cost:* the boxs.ca seed script prompts for three more passwords.

## Carry-forward items taken

From `docs/superpowers/plans/phase-5-carry-forward.md` § 5d (the rest of that section is 5d-1's). Task 5 deletes the whole § 5d.

| Item | Where |
|---|---|
| Review selected posts `{ items: [{ id, version }] }` (≤ 500) and shows the `skipped` list; Clear LA Status posts `{ days }` | Task 3 |
| The freeze banner reads `GET /calendar/api/config`'s `freeze` | Task 1 |
| Review selected and Clear LA Status can answer 207 `{ failed: true }`: check `body.failed`, say what did and didn't commit | Task 3 (D28) |

## Global Constraints

- **Worktree and commits:**
  - Work on `feat/phase-5d` in `/Users/paul/gcpe-news-platform-p5d`. Commit locally after each task.
  - **Never add `Co-Authored-By` or any AI attribution** to a commit. Never commit `CLAUDE.md`.
  - **No task, decision or round labels in code comments** ("Task 3", "D26", "fix round 1"). Spec row ids and legacy file references are fine.
- **Node 24 for everything:**
  - Tests: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run <paths>`.
  - Type-checks: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json` and `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p apps/staff-web/tsconfig.json`.
  - E2E: `npx -y -p node@24 -- npm run test:e2e`.
  - Show each new test failing before implementing it (a real RED run).
- **Core keys are byte-exact; user ids are canonical.**
- **Access:** the Calendar actor comes from the per-request projection, and bearer tokens get no Calendar access. Every list read is the server's `visibleSql` on the unaliased `activities`, inside `inReadSnapshot`; the staff app never filters rows itself.
- **No request body or query may produce a 500.** `safeString` and int4-bounded ids on the server; class 22 is 400, class 23 is 409.
- **Logs:** `safeErrorLabel` only, no debug logging (no `console.log` in staff-web either).
- **Privacy:** `example.test` addresses, fictional GUIDs and fictional names only. No legacy data is copied.
- **Migrations:** drizzle-kit only. This plan adds none.
- **Confidential text never leaves the Calendar.**
- **Excel export** respects visibility and confidentiality exactly as the list does; cells starting with `=`, `+`, `-` or `@` are neutralised (5d-1 Task 9; Task 5 checks it end to end).
- **Performance:** the list query is under 500 ms on 50,000 activities (measured in 5d-1 Task 5); Task 5 times the list on boxs.ca by hand.
- **Tasks that change staff-web screens run the affected e2e specs.** Every task here does. The affected specs are `axe-sweep.spec.ts`, `sign-in-roles.spec.ts` and every `calendar-*.spec.ts`, because the Calendar's landing route changes.
- **Staff-web patterns (unchanged):** calls go through `apiFetch` with same-origin paths; a load failure shows a danger `InlineAlert`; loads are guarded by a `latest` ref; each screen calls `useDocumentTitle` with its `h1` text; messages use `role="status"`, errors `role="alert"`; every state has an axe test; browser code never imports `@gcpe/auth`; controls are at least 24 by 24 CSS pixels.

## Review Focus

1. **A pasted or stale list URL whose `q` no longer parses** (an old filter shape, a hand edit). The list opens with the defaults rather than an error page. Pinned in Task 1 ("an unreadable q falls back to the defaults").
2. **Ticking rows, then one changes before Review selected.** The changed row is skipped and named; the rest are reviewed; the list reloads. A 207 partial commit says what committed. Pinned in Task 3 ("reports skipped rows by MIN-Id and reloads"; "a 207 partial commit is an alert, not a success") and Task 5's HQ journey.
3. **Scrolling a long list with a slow network: "Show more" pressed twice, or the filter changed while a page is in flight.** No duplicate rows, and a stale page never lands in a newer list. Pinned in Task 1 ("loads 30 more at a time without duplicates, and drops a page from an older query").
4. **Keyboard-only and screen-reader use of the table:** the sort state, the watch star's state and its watchers, and needs-review cells are announced, not only coloured. Pinned in Task 1 ("sort state is announced"; "marks a field that needs review in words") and Task 2 ("the star is a toggle button that names its watchers").
5. **An export the server refuses** (more than 10,000 rows, or an HQ tool the user can't use). The user sees the server's reason, not a silent nothing or a downloaded error file. Pinned in Task 3 ("an export the server refuses shows its reason").

---

## File structure

| File | Responsibility |
|---|---|
| `apps/staff-web/package.json` | Depend on `@gcpe/calendar-contract` |
| `apps/staff-web/src/screens/calendar/list/types.ts`, `api.ts`, `dates.ts` | Response types the contract doesn't hold; every list call; BC date helpers |
| `apps/staff-web/src/screens/calendar/list/ActivityListScreen.tsx` (+ test) | The screen: loads, URL state, layout |
| `apps/staff-web/src/screens/calendar/list/FilterPanel.tsx`, `ActivityTable.tsx`, `cells.tsx`, `ColumnChooser.tsx` | Filter, table, cells, columns |
| `apps/staff-web/src/screens/calendar/list/MyQueries.tsx`, `WatchStar.tsx` (+ `MyQueries.test.tsx`) | Saved filters, the watchlist star |
| `apps/staff-web/src/screens/calendar/list/HqTools.tsx` (+ test) | Review selected, Clear LA Status, Corporate Queries, Look Ahead filter, Excel export |
| `apps/staff-web/src/screens/calendar/list/CalendarGrid.tsx` (+ test) | Month and week views |
| `apps/staff-web/src/screens/calendar/list/fixtures.tsx`, `list/a11y.test.tsx` | Test fixtures; axe on every state |
| `apps/staff-web/src/router.tsx`, `screens/calendar/a11y.test.tsx`; delete `screens/calendar/CalendarHome.tsx` | Routing |
| `apps/staff-web/src/styles/global.css` | List, table and grid styles |
| `apps/core/src/services/seed-test-users.ts` (+ test), `tests/e2e/constants.ts`, `scripts/siteground-seed-users.sh` | Three seeded users |
| `tests/e2e/calendar-list.spec.ts`, `tests/e2e/axe-sweep.spec.ts` | End to end |
| `docs/parity/changes-from-legacy.md`, `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`, `docs/superpowers/plans/phase-5-carry-forward.md` | Docs |

---

### Task 1: The list screen: filters, table, sorting, loading, columns and the freeze notice

Covers: spec §8.1 (Filters, Display, Columns, Sorting and loading), §7.4 (the standing banner), §8 (the section's shell and axe standard). Decisions D23, D24, D25. Carry-forward: the freeze banner. Review Focus 1, 3, 4.

**Files:**
- Modify: `apps/staff-web/package.json`, `apps/staff-web/src/router.tsx`, `apps/staff-web/src/screens/calendar/a11y.test.tsx`, `apps/staff-web/src/styles/global.css`.
- Delete: `apps/staff-web/src/screens/calendar/CalendarHome.tsx`.
- Create: `apps/staff-web/src/screens/calendar/list/types.ts`, `api.ts`, `dates.ts`, `ActivityListScreen.tsx`, `FilterPanel.tsx`, `ActivityTable.tsx`, `cells.tsx`, `ColumnChooser.tsx`, `fixtures.tsx`, `ActivityListScreen.test.tsx`, `a11y.test.tsx`.

**Interfaces:**
- Consumes: 5d-1's routes and contract (see Base).
- Produces:
  - `types.ts`: `CalendarConfigView`, `ReviewSelectedResult`, `ClearLaStatusResult`, `ListView = "list" | "month" | "week"`.
  - `api.ts`: `listApi` with `page(q, offset)`, `options()`, `config()`, `preferences()`, `savePreferences(p)`, `watch(id, on)`, `savedFilters()`, `saveFilter(name, filter)`, `renameFilter(id, name)`, `reorderFilters(ids)`, `deleteFilter(id)`, `reviewSelected(items)`, `clearLaStatus(days)`, `calendar(q, start, end)`, `exportUrl(q)`; and `downloadExport(q): Promise<void>`.
  - `dates.ts`: `todayIn(timeZone, now?)`, `bcDateOf(iso, timeZone)`, `addDaysTo(date, n)`, `weekdayOf(date)`.
  - `cells.tsx`: `minId(row)`, `needsReviewOf(column, row)`, `CellContent`, and `interface TableTools { selected?: Map<number, { version: number; label: string }>; onSelect?: (row: ListRow, on: boolean) => void; renderStar?: (row: ListRow, update: (patch: Partial<ListRow>) => void) => React.ReactNode }`.
  - `ActivityTable` props: `{ query: ListQuery; hidden: readonly HideableColumn[]; timeZone: string; reloadToken: number; onSort: (sort: ListSort, dir: "asc" | "desc") => void; tools?: TableTools }`.
  - `ActivityListScreen` and `queryFromParams(params: URLSearchParams): ListQuery | null`.
  - `fixtures.tsx`: `ME`, `HQ_ADMIN_ME`, `CONFIG`, `HQ_ADMIN_CONFIG`, `OPTIONS`, `PREFS`, `row(over)`, `type Call`, `stubFetch(calls, stub)`, `qOf(url)`, `renderList(path?)`.

- [ ] **Step 1: The dependency and the fixtures**

In `apps/staff-web/package.json`, add `"@gcpe/calendar-contract": "0.0.0"` to `dependencies` (the workspace link exists). Run `npx -y -p node@24 -- npm install` to refresh the lockfile.

`apps/staff-web/src/screens/calendar/list/types.ts`:

```ts
/** GET /calendar/api/config, the parts the list reads. */
export interface CalendarConfigView {
  timeZone: string;
  freeze: { start: string; end: string; timeZone: string; active: boolean; appliesToYou: boolean; message: string };
  list: { markup: boolean; corporateQueries: boolean; lookAheadFilter: boolean; reviewSelected: boolean; clearLaStatus: boolean };
}

/** apps/calendar/src/activities/bulk.ts. A 207 carries `failed: true`: a later batch rolled back after earlier ones committed. */
export interface ReviewSelectedResult {
  reviewed: number[];
  skipped: { id: number; reason: "changed" | "not_found" }[];
  failed?: true;
}
export interface ClearLaStatusResult {
  cleared: number;
  failed?: true;
}

export type ListView = "list" | "month" | "week";
```

`apps/staff-web/src/screens/calendar/list/fixtures.tsx`:

```tsx
import { render } from "@testing-library/react";
import { vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router";
import type { CalendarRangeView, ListOptions, ListPage, ListPreferences, ListRow, SavedFilterView } from "@gcpe/calendar-contract";
import { jsonResponse } from "../../../../test/jsonResponse";
import { RequireAuth } from "../../../session/RequireAuth";
import { SessionProvider } from "../../../session/SessionContext";
import { CalendarSection } from "../CalendarSection";
import { ActivityListScreen } from "./ActivityListScreen";
import type { CalendarConfigView } from "./types";

export const ME = { userId: "u1", displayName: "Robin Staff", role: "Calendar.Editor", level: 2, ministryKeys: ["health"], isHq: false };
export const HQ_ADMIN_ME = { userId: "u9", displayName: "Sample HQ Admin", role: "Calendar.Administrator", level: 4, ministryKeys: ["gcpe-hq"], isHq: true };
export const CONFIG: CalendarConfigView = {
  timeZone: "America/Vancouver",
  freeze: { start: "16:00", end: "17:00", timeZone: "America/Vancouver", active: false, appliesToYou: false, message: "You cannot make content changes between 4pm-5pm. Contact the Corp Cal Manager to have emerging or urgent updates made for you during this time." },
  list: { markup: false, corporateQueries: false, lookAheadFilter: false, reviewSelected: false, clearLaStatus: false },
};
export const HQ_ADMIN_CONFIG: CalendarConfigView = { ...CONFIG, list: { markup: true, corporateQueries: true, lookAheadFilter: true, reviewSelected: true, clearLaStatus: true } };
export const OPTIONS: ListOptions = {
  categories: [{ id: 32, name: "Sample category" }],
  keywords: [{ id: 1, name: "Sample tag" }, { id: 2, name: "Sample other tag" }],
  representatives: [{ id: 1, name: "Sample Representative" }],
  initiatives: [{ id: 1, name: "Sample initiative" }],
  premierRequested: [{ id: 1, name: "Sample yes" }],
  distributions: [{ id: 1, name: "Sample distribution" }],
  ministries: [{ key: "health", abbreviation: "HLTH", name: "Sample Health" }],
  commContacts: [{ userId: "u1", name: "Robin Staff" }],
};
export const PREFS: ListPreferences = { display: "all", hiddenColumns: ["keywords", "ministry", "status", "translations"] };

export function row(over: Partial<ListRow> = {}): ListRow {
  return {
    id: 20001, version: 1, ministryKey: "health", ministryAbbreviation: "HLTH", status: "new", hqStatus: null, isDeleted: false,
    isWatched: false, watcherNames: [], isShared: false, hasRelease: false,
    createdAt: "2026-11-01T17:00:00.000Z", lastUpdatedAt: "2026-11-02T17:00:00.000Z", lastUpdatedByName: "Robin Staff",
    keywords: [], startAt: "2026-11-10T17:00:00.000Z", endAt: "2026-11-10T18:00:00.000Z", isAllDay: false, isConfirmed: true, potentialDates: "",
    title: "Sample listed", details: "Sample summary", significance: "Sample significance", strategy: "", schedule: "",
    categories: ["Sample category"], isIssue: false, isConfidential: false, commMaterials: [], nrOrigins: [], nrDistribution: null,
    premierRequested: null, leadOrganization: "", translations: [], city: "Sample City", venue: "",
    commContact: { name: "Robin Staff", phone: "250-555-0101" }, governmentRepresentative: null, eventPlanner: null, needsReview: [],
    ...over,
  };
}

export interface Call {
  url: string;
  init?: RequestInit;
}
export interface Stub {
  me?: object;
  config?: CalendarConfigView;
  preferences?: ListPreferences;
  page?: (offset: number, q: Record<string, unknown>) => ListPage | Promise<ListPage>;
  saved?: SavedFilterView[];
  calendar?: CalendarRangeView;
  /** Answers first; return undefined to fall through to the defaults. */
  other?: (url: string, init?: RequestInit) => Response | undefined;
}

export const qOf = (url: string) => JSON.parse(new URL(url, "http://staff.example.test").searchParams.get("q")!) as Record<string, unknown>;
export const listCalls = (calls: Call[]) => calls.filter((c) => c.url.startsWith("/calendar/api/list?"));

export function stubFetch(calls: Call[], s: Stub = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const custom = s.other?.(url, init);
      if (custom) return custom;
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u1", name: "Robin Staff", email: "robin.staff@example.test", roles: ["Calendar.Editor"] }, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
      if (url === "/calendar/api/me") return jsonResponse(200, s.me ?? ME);
      if (url === "/calendar/api/config") return jsonResponse(200, s.config ?? CONFIG);
      if (url === "/calendar/api/list/options") return jsonResponse(200, OPTIONS);
      if (url === "/calendar/api/list/preferences") return jsonResponse(200, init?.method === "PUT" ? JSON.parse(String(init.body)) : (s.preferences ?? PREFS));
      if (url.startsWith("/calendar/api/list/calendar?")) return jsonResponse(200, s.calendar ?? { items: [], truncated: false });
      if (url.startsWith("/calendar/api/list?")) {
        const offset = Number(new URL(url, "http://staff.example.test").searchParams.get("offset") ?? 0);
        return jsonResponse(200, await (s.page ?? (() => ({ rows: [row()], total: 1, offset: 0 })))(offset, qOf(url)));
      }
      if (url === "/calendar/api/saved-filters") return jsonResponse(200, s.saved ?? []);
      throw new Error(`unhandled: ${init?.method ?? "GET"} ${url}`);
    }),
  );
}

export const renderList = (path = "/calendar") =>
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={[path]}>
        <RequireAuth>
          <Routes>
            <Route path="/calendar" element={<CalendarSection />}>
              <Route index element={<ActivityListScreen />} />
            </Route>
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
```

- [ ] **Step 2: Write the failing screen tests**

`apps/staff-web/src/screens/calendar/list/ActivityListScreen.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ListPage } from "@gcpe/calendar-contract";
import { listCalls, qOf, renderList, row, stubFetch, CONFIG, type Call } from "./fixtures";

describe("ActivityListScreen (spec addendum §8.1)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("loads the first page with the saved display and hides the saved columns", async () => {
    const calls: Call[] = [];
    stubFetch(calls, { preferences: { display: "my_ministries", hiddenColumns: ["keywords", "ministry", "status", "translations"] } });
    renderList();
    expect(await screen.findByRole("heading", { level: 1, name: "Corporate Calendar" })).toBeInTheDocument();
    expect(await screen.findByText("Sample listed")).toBeInTheDocument();
    expect(qOf(listCalls(calls)[0]!.url)).toMatchObject({ display: "my_ministries", sort: "dateTime", dir: "asc", corporate: null });
    expect(screen.queryByRole("columnheader", { name: "HQ Tags" })).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Title & Summary" })).toBeInTheDocument();
    expect(screen.getByText("Showing 1 of 1 activity.")).toBeInTheDocument();
    expect(screen.getByText("HLTH-20001")).toBeInTheDocument();
    // The year shows only when it isn't this year's.
    expect(screen.getByText(/^Tue Nov 10( 2026)? 9:00-10:00 AM$/)).toBeInTheDocument();
  });

  it("an unreadable q falls back to the defaults", async () => {
    const calls: Call[] = [];
    stubFetch(calls);
    renderList(`/calendar?q=${encodeURIComponent('{"filter":{"colour":"blue"}}')}`);
    await screen.findByText("Sample listed");
    expect(qOf(listCalls(calls)[0]!.url)).toMatchObject({ display: "all", filter: { quickSearch: "" } });
  });

  it("searches with the filter and display chosen, and saves a new display", async () => {
    const calls: Call[] = [];
    stubFetch(calls);
    renderList();
    await screen.findByText("Sample listed");
    const user = userEvent.setup();
    const form = screen.getByRole("form", { name: "Filter activities" });
    await user.type(within(form).getByLabelText("Search for"), "launch");
    await user.selectOptions(within(form).getByLabelText("Category"), "Sample category");
    await user.selectOptions(within(form).getByLabelText("HQ Tags"), ["Sample tag", "Sample other tag"]);
    await user.click(within(form).getByLabelText("My Watchlist Only"));
    await user.click(within(form).getByRole("button", { name: "Search" }));
    await waitFor(() => expect(listCalls(calls)).toHaveLength(2));
    expect(qOf(listCalls(calls)[1]!.url)).toMatchObject({ display: "my_watchlist", corporate: null, filter: { quickSearch: "launch", categoryId: 32, keywordIds: [1, 2] } });
    const put = calls.find((c) => c.url === "/calendar/api/list/preferences" && c.init?.method === "PUT")!;
    expect(JSON.parse(String(put.init!.body))).toEqual({ display: "my_watchlist", hiddenColumns: ["keywords", "ministry", "status", "translations"] });
  });

  it("refuses a From after the To without asking the server", async () => {
    const calls: Call[] = [];
    stubFetch(calls);
    renderList();
    await screen.findByText("Sample listed");
    const user = userEvent.setup();
    const form = screen.getByRole("form", { name: "Filter activities" });
    await user.type(within(form).getByLabelText("From"), "2026-11-20");
    await user.type(within(form).getByLabelText("To"), "2026-11-10");
    await user.click(within(form).getByRole("button", { name: "Search" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("From must be on or before To.");
    expect(listCalls(calls)).toHaveLength(1);
  });

  it("sorts by a column, then the other way; the sort state is announced", async () => {
    const calls: Call[] = [];
    stubFetch(calls);
    renderList();
    await screen.findByText("Sample listed");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Title & Summary" }));
    await waitFor(() => expect(qOf(listCalls(calls).at(-1)!.url)).toMatchObject({ sort: "title", dir: "asc" }));
    expect(await screen.findByRole("columnheader", { name: "Title & Summary" })).toHaveAttribute("aria-sort", "ascending");
    await user.click(screen.getByRole("button", { name: "Title & Summary" }));
    await waitFor(() => expect(qOf(listCalls(calls).at(-1)!.url)).toMatchObject({ sort: "title", dir: "desc" }));
    expect(screen.queryByRole("button", { name: "Premier" })).toBeNull();
  });

  it("loads 30 more at a time without duplicates, and drops a page from an older query", async () => {
    const calls: Call[] = [];
    const many = Array.from({ length: 45 }, (_, n) => row({ id: 30000 + n, title: `Sample ${n}` }));
    stubFetch(calls, { page: (offset): ListPage => ({ rows: many.slice(offset, offset + 30), total: 45, offset }) });
    renderList();
    await screen.findByText("Sample 0");
    expect(screen.getByText("Showing 30 of 45 activities.")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Show 15 more" }));
    expect(await screen.findByText("Showing 45 of 45 activities.")).toBeInTheDocument();
    expect(new URL(listCalls(calls).at(-1)!.url, "http://x").searchParams.get("offset")).toBe("30");
    expect(screen.getAllByText(/^Sample \d+$/)).toHaveLength(45);
    expect(screen.queryByRole("button", { name: /more$/ })).toBeNull();
  });

  it("hides and shows columns, saving the choice", async () => {
    const calls: Call[] = [];
    stubFetch(calls);
    renderList();
    await screen.findByText("Sample listed");
    const user = userEvent.setup();
    await user.click(screen.getByText("Columns"));
    await user.click(screen.getByRole("checkbox", { name: "City" }));
    await waitFor(() => expect(screen.queryByRole("columnheader", { name: "City" })).toBeNull());
    const put = calls.filter((c) => c.url === "/calendar/api/list/preferences" && c.init?.method === "PUT").at(-1)!;
    expect(JSON.parse(String(put.init!.body)).hiddenColumns).toContain("city");
    expect(screen.queryByRole("checkbox", { name: "Activity Id" })).toBeNull();
  });

  it("always shows the freeze window, and an alert while it applies to you", async () => {
    stubFetch([]);
    renderList();
    expect(await screen.findByText(CONFIG.freeze.message)).toBeInTheDocument();
    cleanup();
    vi.unstubAllGlobals();
    stubFetch([], { config: { ...CONFIG, freeze: { ...CONFIG.freeze, active: true, appliesToYou: true } } });
    renderList();
    expect(await screen.findByText("Change freeze")).toBeInTheDocument();
  });

  it("says so when nothing matches, and when the list can't load", async () => {
    stubFetch([], { page: () => ({ rows: [], total: 0, offset: 0 }) });
    renderList();
    expect(await screen.findByText("No activities match.")).toBeInTheDocument();
    cleanup();
    vi.unstubAllGlobals();
    stubFetch([], { other: (url) => (url.startsWith("/calendar/api/list?") ? new Response("{}", { status: 503 }) : undefined) });
    renderList();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load activities.");
  });

  it("marks a field that needs review in words, not only colour", async () => {
    stubFetch([], { page: () => ({ rows: [row({ needsReview: ["title"] })], total: 1, offset: 0 }) });
    renderList();
    await screen.findByText("Sample listed");
    expect(screen.getAllByText("(changed, needs review)")).toHaveLength(1);
  });
});
```

`apps/staff-web/src/screens/calendar/list/a11y.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { CONFIG, renderList, row, stubFetch } from "./fixtures";

async function seriousViolations(container: Element) {
  const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}

describe("accessibility: the activity list in every state", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("rows, with review markup", async () => {
    stubFetch([], { page: () => ({ rows: [row({ needsReview: ["title"], isShared: true, hasRelease: true, keywords: ["Sample tag"] })], total: 1, offset: 0 }) });
    const { container } = renderList();
    await screen.findByText("Sample listed");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("no rows, and the freeze in force", async () => {
    stubFetch([], { page: () => ({ rows: [], total: 0, offset: 0 }), config: { ...CONFIG, freeze: { ...CONFIG.freeze, active: true, appliesToYou: true } } });
    const { container } = renderList();
    await screen.findByText("No activities match.");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("the list failing to load", async () => {
    stubFetch([], { other: (url) => (url.startsWith("/calendar/api/list?") ? new Response("{}", { status: 503 }) : undefined) });
    const { container } = renderList();
    await screen.findByText("Couldn't load activities.");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("the column chooser open, and a filter error shown", async () => {
    stubFetch([]);
    const { container } = renderList();
    await screen.findByText("Sample listed");
    const user = userEvent.setup();
    await user.click(screen.getByText("Columns"));
    await user.type(screen.getByLabelText("From"), "2026-11-20");
    await user.type(screen.getByLabelText("To"), "2026-11-10");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("From must be on or before To.");
    expect(await seriousViolations(container)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/calendar/list`
Expected: FAIL ("Failed to resolve import ./ActivityListScreen").

- [ ] **Step 4: The API module and date helpers**

`apps/staff-web/src/screens/calendar/list/api.ts`:

```ts
import type { CalendarRangeView, ListFilter, ListOptions, ListPage, ListPreferences, ListQuery, SavedFilterView } from "@gcpe/calendar-contract";
import { apiFetch } from "../../../api/client";
import type { CalendarConfigView, ClearLaStatusResult, ReviewSelectedResult } from "./types";

const q = (query: ListQuery) => encodeURIComponent(JSON.stringify(query));

/** Every call the activity list makes (spec addendum §8.1), through apiFetch. */
export const listApi = {
  page: (query: ListQuery, offset: number) => apiFetch<ListPage>(`/calendar/api/list?q=${q(query)}&offset=${offset}`),
  options: () => apiFetch<ListOptions>("/calendar/api/list/options"),
  config: () => apiFetch<CalendarConfigView>("/calendar/api/config"),
  preferences: () => apiFetch<ListPreferences>("/calendar/api/list/preferences"),
  savePreferences: (p: ListPreferences) => apiFetch<ListPreferences>("/calendar/api/list/preferences", { method: "PUT", body: p }),
  watch: (id: number, on: boolean) => apiFetch<void>(`/calendar/api/activities/${id}/watch`, { method: on ? "PUT" : "DELETE" }),
  savedFilters: () => apiFetch<SavedFilterView[]>("/calendar/api/saved-filters"),
  saveFilter: (name: string, filter: ListFilter) => apiFetch<SavedFilterView>("/calendar/api/saved-filters", { method: "POST", body: { name, filter } }),
  renameFilter: (id: number, name: string) => apiFetch<SavedFilterView>(`/calendar/api/saved-filters/${id}`, { method: "PUT", body: { name } }),
  reorderFilters: (ids: number[]) => apiFetch<SavedFilterView[]>("/calendar/api/saved-filters/order", { method: "PUT", body: { ids } }),
  deleteFilter: (id: number) => apiFetch<void>(`/calendar/api/saved-filters/${id}`, { method: "DELETE" }),
  reviewSelected: (items: { id: number; version: number }[]) => apiFetch<ReviewSelectedResult>("/calendar/api/activities/review-selected", { method: "POST", body: { items } }),
  clearLaStatus: (days: number) => apiFetch<ClearLaStatusResult>("/calendar/api/activities/clear-la-status", { method: "POST", body: { days } }),
  calendar: (query: ListQuery, start: string, end: string) => apiFetch<CalendarRangeView>(`/calendar/api/list/calendar?q=${q(query)}&start=${start}&end=${end}`),
  exportUrl: (query: ListQuery) => `/calendar/api/list/export.xlsx?q=${q(query)}`,
};

/** The Excel export as a download. A refusal comes back as an Error carrying the server's own message. */
export async function downloadExport(query: ListQuery): Promise<void> {
  const res = await fetch(listApi.exportUrl(query), { credentials: "same-origin" });
  if (!res.ok) {
    let message = "Couldn't export the list.";
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string") message = body.error;
    } catch {
      // Not JSON: keep the general message.
    }
    throw new Error(message);
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = "BCGovernmentActivities.xlsx";
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
```

`apps/staff-web/src/screens/calendar/list/dates.ts`:

```ts
const formatters = new Map<string, Intl.DateTimeFormat>();
/** The BC calendar date (YYYY-MM-DD) of an instant, by the browser's tzdata. */
export function bcDateOf(at: string | Date, timeZone: string): string {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    formatters.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
export const todayIn = (timeZone: string, now: Date = new Date()) => bcDateOf(now, timeZone);
/** Calendar arithmetic on a bare date: no time zone, no DST. */
export function addDaysTo(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** 0 is Sunday. */
export const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
```

- [ ] **Step 5: Cells, table, columns and filter panel**

`apps/staff-web/src/screens/calendar/list/cells.tsx`:

```tsx
import { friendlyDateRange, friendlySpan, type ListColumn, type ListRow, type NeedsReviewKey } from "@gcpe/calendar-contract";

/** Which needs-review flags mark which column (ActivityListProvider.ashx.cs's ApplyMarkup calls). */
const FLAGS: Partial<Record<ListColumn, NeedsReviewKey[]>> = {
  keywords: ["tags"], status: ["active"], dateTime: ["start_date", "end_date"], title: ["title", "details"], categories: ["categories"],
  commMaterials: ["comm_materials"], premier: ["premier_requested"], leadOrg: ["lead_organization"], translations: ["translations_required"],
  city: ["city", "venue"], governmentRep: ["representative"],
};
export const needsReviewOf = (c: ListColumn, r: ListRow) => (FLAGS[c] ?? []).some((k) => r.needsReview.includes(k));
/** The list's "MIN-Id". */
export const minId = (r: Pick<ListRow, "id" | "ministryAbbreviation">) => `${r.ministryAbbreviation ?? "—"}-${r.id}`;

const STATUS = { new: "New", changed: "Changed", reviewed: "Reviewed" } as const;
const shortDate = (iso: string, timeZone: string) => new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));

export interface TableTools {
  /** Rows ticked for Review selected, by id. */
  selected?: Map<number, { version: number; label: string }>;
  onSelect?: (row: ListRow, on: boolean) => void;
  renderStar?: (row: ListRow, update: (patch: Partial<ListRow>) => void) => React.ReactNode;
}

export function CellContent({ column, row: r, today, timeZone, tools, update }: { column: ListColumn; row: ListRow; today: string; timeZone: string; tools?: TableTools; update: (patch: Partial<ListRow>) => void }): React.JSX.Element {
  switch (column) {
    case "activity": {
      // Legacy's eye icon: reviewed and live, or a deletion already reviewed.
      const reviewed = r.isDeleted ? !r.needsReview.includes("active") : r.status === "reviewed";
      return (
        <div className="gcpe-activity-cell">
          {tools?.onSelect && (
            <input type="checkbox" aria-label={`Select ${minId(r)}`} checked={tools.selected?.has(r.id) ?? false} onChange={(e) => tools.onSelect!(r, e.target.checked)} />
          )}
          {tools?.renderStar?.(r, update)}
          <span>
            {reviewed && <span className="gcpe-badge">Reviewed</span>}
            {r.isShared && <span className="gcpe-badge">Shared</span>}
            {r.hasRelease && <span className="gcpe-badge">Release</span>}
          </span>
          <strong>{minId(r)}</strong>
          <span className="gcpe-hint">{`updated ${friendlySpan(new Date(r.lastUpdatedAt), new Date(), timeZone)} ago${r.lastUpdatedByName ? ` by ${r.lastUpdatedByName}` : ""}`}</span>
          <span className="gcpe-hint">{`created ${shortDate(r.createdAt, timeZone)}`}</span>
        </div>
      );
    }
    case "keywords":
      return <>{r.keywords.join(", ")}</>;
    case "ministry":
      return <>{r.ministryAbbreviation ?? ""}</>;
    case "status":
      return (
        <>
          {r.isDeleted ? "Deleted" : STATUS[r.status]}
          {r.hqStatus && (
            <>
              <br />
              <small>{`LA ${STATUS[r.hqStatus]}`}</small>
            </>
          )}
        </>
      );
    case "dateTime":
      return <span title={r.schedule ? `Considerations: ${r.schedule}` : undefined}>{friendlyDateRange(r, { timeZone, today, weekday: true })}</span>;
    case "title":
      return (
        <div title={r.significance || undefined}>
          <strong className="gcpe-activity-title">{r.title}</strong>
          {r.details && <div>{r.details}</div>}
        </div>
      );
    case "categories":
      return (
        <>
          {[...(r.isIssue ? ["Issue"] : []), ...r.categories].join(", ")}
          {r.isConfidential && (
            <>
              <br />
              <small className="gcpe-not-la">Not for Look Ahead</small>
            </>
          )}
        </>
      );
    case "commMaterials": {
      const hover = [r.nrOrigins.join(", "), r.nrDistribution ?? ""].filter(Boolean).join("\n");
      return <span title={hover || undefined}>{r.commMaterials.join(", ")}</span>;
    }
    case "premier":
      return <>{r.premierRequested ?? ""}</>;
    case "leadOrg":
      return <>{r.leadOrganization}</>;
    case "translations":
      return <>{r.translations.join(", ")}</>;
    case "city":
      return (
        <>
          {r.city ?? ""}
          {r.venue && (
            <>
              <br />
              {r.venue}
            </>
          )}
        </>
      );
    case "commContact":
      return r.commContact ? (
        <>
          {r.commContact.name}
          {r.commContact.phone && (
            <>
              <br />
              {r.commContact.phone}
            </>
          )}
        </>
      ) : (
        <></>
      );
    case "governmentRep":
      return <>{r.governmentRepresentative ?? ""}</>;
  }
}
```

`apps/staff-web/src/screens/calendar/list/ActivityTable.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, InlineAlert } from "@bcgov/design-system-react-components";
import { LIST_COLUMN_LABELS, LIST_COLUMNS, LIST_PAGE_SIZE, LIST_SORTS, type HideableColumn, type ListColumn, type ListQuery, type ListRow, type ListSort } from "@gcpe/calendar-contract";
import { listApi } from "./api";
import { CellContent, needsReviewOf, type TableTools } from "./cells";
import { todayIn } from "./dates";

const isSortable = (c: ListColumn): c is ListSort => (LIST_SORTS as readonly string[]).includes(c);
const plural = (n: number) => `${n} ${n === 1 ? "activity" : "activities"}`;

/** The grid (UCFlexiGrid): 30 rows at a time as the end scrolls into view, as legacy's did. */
export function ActivityTable({ query, hidden, timeZone, reloadToken, onSort, tools }: {
  query: ListQuery;
  hidden: readonly HideableColumn[];
  timeZone: string;
  reloadToken: number;
  onSort: (sort: ListSort, dir: "asc" | "desc") => void;
  tools?: TableTools;
}): React.JSX.Element {
  const [rows, setRows] = useState<ListRow[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);
  const key = JSON.stringify(query);

  useEffect(() => {
    const call = ++latest.current;
    setRows([]);
    setTotal(null);
    setError(null);
    setLoading(true);
    listApi.page(query, 0).then(
      (p) => {
        if (call !== latest.current) return;
        setRows(p.rows);
        setTotal(p.total);
        setLoading(false);
      },
      () => {
        if (call !== latest.current) return;
        setError("Couldn't load activities.");
        setLoading(false);
      },
    );
    // `key` stands for `query`: a new object with the same content mustn't reload.
  }, [key, reloadToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const more = useCallback(() => {
    if (loading || total === null || rows.length >= total) return;
    // A page from an older query is dropped: `latest` moves on when the query does.
    const call = latest.current;
    setLoading(true);
    listApi.page(query, rows.length).then(
      (p) => {
        if (call !== latest.current) return;
        setRows((r) => [...r, ...p.rows.filter((x) => !r.some((y) => y.id === x.id))]);
        setTotal(p.total);
        setLoading(false);
      },
      () => {
        if (call !== latest.current) return;
        setError("Couldn't load more activities.");
        setLoading(false);
      },
    );
  }, [loading, total, rows.length, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const o = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) more();
    });
    o.observe(el);
    return () => o.disconnect();
  }, [more]);

  const update = (id: number) => (patch: Partial<ListRow>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const columns = LIST_COLUMNS.filter((c) => c === "activity" || !(hidden as readonly string[]).includes(c));
  const today = todayIn(timeZone);

  if (error && rows.length === 0) return <InlineAlert variant="danger" role="alert" description={error} />;
  return (
    <section aria-labelledby="list-results-heading">
      <h2 id="list-results-heading">Activities</h2>
      <p role="status">{total === null ? "Loading activities…" : total === 0 ? "No activities match." : `Showing ${rows.length} of ${plural(total)}.`}</p>
      {rows.length > 0 && (
        <div className="gcpe-calendar-table-wrap">
          <table className="gcpe-calendar-table">
            <caption className="gcpe-visually-hidden">{`Activities, sorted by ${LIST_COLUMN_LABELS[query.sort]}, ${query.dir === "asc" ? "ascending" : "descending"}`}</caption>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c} scope="col" aria-sort={query.sort === c ? (query.dir === "asc" ? "ascending" : "descending") : undefined}>
                    {isSortable(c) ? (
                      <button type="button" className="gcpe-sort" onClick={() => onSort(c, query.sort === c && query.dir === "asc" ? "desc" : "asc")}>
                        {LIST_COLUMN_LABELS[c]}
                      </button>
                    ) : (
                      LIST_COLUMN_LABELS[c]
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.isDeleted ? "gcpe-deleted" : undefined}>
                  {columns.map((c) => {
                    const flagged = needsReviewOf(c, r);
                    return (
                      <td key={c} className={flagged ? "gcpe-needs-review" : undefined}>
                        <CellContent column={c} row={r} today={today} timeZone={timeZone} tools={tools} update={update(r.id)} />
                        {flagged && <span className="gcpe-visually-hidden"> (changed, needs review)</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error && rows.length > 0 && <p role="alert">{error}</p>}
      {total !== null && rows.length < total && (
        <>
          <div ref={sentinel} />
          <Button variant="secondary" isDisabled={loading} onPress={more}>{`Show ${Math.min(LIST_PAGE_SIZE, total - rows.length)} more`}</Button>
        </>
      )}
    </section>
  );
}
```

The `eslint-disable` comments follow the existing screens' convention (`LinksScreen.tsx`, `CarouselScreen.tsx`).

The screen-reader text " (changed, needs review)" appears in the DOM; the test `getAllByText("(changed, needs review)")` matches its trimmed text.

`apps/staff-web/src/screens/calendar/list/ColumnChooser.tsx`:

```tsx
import { HIDEABLE_COLUMNS, LIST_COLUMN_LABELS, type HideableColumn } from "@gcpe/calendar-contract";

/** Each user's column choice (spec addendum §8.1). The Activity Id column always shows. */
export function ColumnChooser({ hidden, onChange }: { hidden: readonly HideableColumn[]; onChange: (hidden: HideableColumn[]) => void }): React.JSX.Element {
  return (
    <details className="gcpe-columns">
      <summary>Columns</summary>
      <fieldset>
        <legend>Show these columns</legend>
        {HIDEABLE_COLUMNS.map((c) => (
          <div key={c}>
            <input
              type="checkbox"
              id={`list-col-${c}`}
              checked={!hidden.includes(c)}
              onChange={(e) => onChange(e.target.checked ? hidden.filter((h) => h !== c) : [...hidden, c])}
            />
            <label htmlFor={`list-col-${c}`}>{LIST_COLUMN_LABELS[c]}</label>
          </div>
        ))}
      </fieldset>
    </details>
  );
}
```

`apps/staff-web/src/screens/calendar/list/FilterPanel.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Button } from "@bcgov/design-system-react-components";
import { ACTIVITY_STATUSES, EMPTY_LIST_FILTER, LIST_DISPLAYS, type ListDisplay, type ListFilter, type ListOptions, type ListQuery } from "@gcpe/calendar-contract";

const DISPLAY_LABELS: Record<ListDisplay, string> = {
  all: "Show All", my_ministries: "My Ministries' Activities Only", my_activities: "My Activities Only", my_watchlist: "My Watchlist Only",
};
const STATUS_LABELS = { new: "New", changed: "Changed", reviewed: "Reviewed" } as const;
const tri = (v: boolean | null) => (v === null ? "" : String(v));
const fromTri = (s: string) => (s === "" ? null : s === "true");
const num = (v: number | null) => (v === null ? "" : String(v));
const fromNum = (s: string) => (s === "" ? null : Number(s));
const choices = (xs: { id: number; name: string }[]) => xs.map((x) => ({ value: String(x.id), label: x.name }));

function Choice({ id, label, value, onChange, options, any }: { id: string; label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; any: string }) {
  return (
    <div className="gcpe-field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{any}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The Filter panel (Default.aspx:524-622). Search runs it; the display chosen here is also saved for next time. */
export function FilterPanel({ query, options, onSearch }: { query: ListQuery; options: ListOptions; onSearch: (q: ListQuery) => void }): React.JSX.Element {
  const [filter, setFilter] = useState<ListFilter>(query.filter);
  const [display, setDisplay] = useState<ListDisplay>(query.display);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify([query.filter, query.display]);
  useEffect(() => {
    setFilter(query.filter);
    setDisplay(query.display);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = <K extends keyof ListFilter>(k: K, v: ListFilter[K]) => setFilter((f) => ({ ...f, [k]: v }));
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (filter.from && filter.to && filter.from > filter.to && !filter.thisDayOnly) return setError("From must be on or before To.");
    setError(null);
    onSearch({ ...query, corporate: null, display, filter: { ...filter, quickSearch: filter.quickSearch.trim(), to: filter.thisDayOnly ? null : filter.to } });
  };
  return (
    <form aria-label="Filter activities" className="gcpe-calendar-filter" onSubmit={submit}>
      <fieldset>
        <legend>Dates</legend>
        <div className="gcpe-field">
          <label htmlFor="list-from">From</label>
          <input id="list-from" type="date" value={filter.from ?? ""} onChange={(e) => set("from", e.target.value || null)} />
        </div>
        <div className="gcpe-field">
          <label htmlFor="list-to">To</label>
          <input id="list-to" type="date" value={filter.to ?? ""} disabled={filter.thisDayOnly} onChange={(e) => set("to", e.target.value || null)} />
        </div>
        <div>
          <input id="list-this-day" type="checkbox" checked={filter.thisDayOnly} onChange={(e) => set("thisDayOnly", e.target.checked)} />
          <label htmlFor="list-this-day">This day only</label>
        </div>
      </fieldset>
      <div className="gcpe-field">
        <label htmlFor="list-search">Search for</label>
        <input id="list-search" type="search" maxLength={200} value={filter.quickSearch} aria-describedby="list-search-hint" onChange={(e) => set("quickSearch", e.target.value)} />
        <p id="list-search-hint" className="gcpe-hint">An activity number (such as HLTH-12345), or words in the title, summary, city and other text.</p>
      </div>
      <div className="gcpe-field">
        <label htmlFor="list-tags">HQ Tags</label>
        <select id="list-tags" multiple value={filter.keywordIds.map(String)} onChange={(e) => set("keywordIds", [...e.target.selectedOptions].map((o) => Number(o.value)))}>
          {options.keywords.map((k) => (
            <option key={k.id} value={String(k.id)}>
              {k.name}
            </option>
          ))}
        </select>
      </div>
      <Choice id="list-issue" label="Issue" value={tri(filter.isIssue)} onChange={(v) => set("isIssue", fromTri(v))} options={[{ value: "true", label: "Is an Issue" }, { value: "false", label: "Not an Issue" }]} any="Any" />
      <Choice id="list-confirmed" label="Date Confirmed" value={tri(filter.dateConfirmed)} onChange={(v) => set("dateConfirmed", fromTri(v))} options={[{ value: "true", label: "Date is Confirmed" }, { value: "false", label: "Date is not Confirmed" }]} any="Any" />
      <Choice id="list-status" label="Status" value={filter.status ?? ""} onChange={(v) => set("status", v === "" ? null : (v as ListFilter["status"]))} options={ACTIVITY_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] }))} any="Any status" />
      <Choice id="list-category" label="Category" value={num(filter.categoryId)} onChange={(v) => set("categoryId", fromNum(v))} options={choices(options.categories)} any="Any category" />
      <Choice id="list-ministry" label="Lead Ministry" value={filter.ministryKey ?? ""} onChange={(v) => set("ministryKey", v || null)} options={options.ministries.map((m) => ({ value: m.key, label: m.abbreviation ?? m.name }))} any="Any ministry" />
      <Choice id="list-contact" label="Comm Contact" value={filter.commContactUserId ?? ""} onChange={(v) => set("commContactUserId", v || null)} options={options.commContacts.map((c) => ({ value: c.userId, label: c.name }))} any="Any comm contact" />
      <Choice id="list-representative" label="Representative" value={num(filter.representativeId)} onChange={(v) => set("representativeId", fromNum(v))} options={choices(options.representatives)} any="Any representative" />
      <Choice id="list-initiative" label="Initiative" value={num(filter.initiativeId)} onChange={(v) => set("initiativeId", fromNum(v))} options={choices(options.initiatives)} any="Any initiative" />
      <Choice id="list-premier" label="Premier Requested" value={num(filter.premierRequestedId)} onChange={(v) => set("premierRequestedId", fromNum(v))} options={choices(options.premierRequested)} any="Any" />
      <Choice id="list-distribution" label="Distribution" value={num(filter.distributionId)} onChange={(v) => set("distributionId", fromNum(v))} options={choices(options.distributions)} any="Any distribution" />
      <fieldset>
        <legend>Display</legend>
        {LIST_DISPLAYS.map((d) => (
          <div key={d}>
            <input type="radio" id={`list-display-${d}`} name="list-display" checked={display === d} onChange={() => setDisplay(d)} />
            <label htmlFor={`list-display-${d}`}>{DISPLAY_LABELS[d]}</label>
          </div>
        ))}
      </fieldset>
      {error && <p role="alert">{error}</p>}
      <div className="gcpe-actions">
        <Button type="submit">Search</Button>
        <Button type="button" variant="secondary" onPress={() => setFilter(EMPTY_LIST_FILTER)}>
          Reset
        </Button>
      </div>
    </form>
  );
}
```

- [ ] **Step 6: The screen**

`apps/staff-web/src/screens/calendar/list/ActivityListScreen.tsx`:

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { InlineAlert } from "@bcgov/design-system-react-components";
import { DEFAULT_LIST_QUERY, listQuerySchema, type ListOptions, type ListPreferences, type ListQuery } from "@gcpe/calendar-contract";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { ActivityTable } from "./ActivityTable";
import { listApi } from "./api";
import { ColumnChooser } from "./ColumnChooser";
import { FilterPanel } from "./FilterPanel";
import type { CalendarConfigView } from "./types";

/** The list query, from `?q=`. Anything that no longer parses gives way to the defaults. */
export function queryFromParams(params: URLSearchParams): ListQuery | null {
  const raw = params.get("q");
  if (!raw) return null;
  try {
    const parsed = listQuerySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Legacy's standing note (UCFlexiGrid.ascx:124), and an alert while the freeze applies to this user (spec addendum §7.4). */
function FreezeNotice({ freeze }: { freeze: CalendarConfigView["freeze"] }) {
  if (freeze.start === freeze.end) return null;
  return freeze.appliesToYou ? <InlineAlert variant="warning" title="Change freeze" description={freeze.message} /> : <p className="gcpe-hint">{freeze.message}</p>;
}

/** `/hub/calendar` (spec addendum §8.1): the activity list. */
export function ActivityListScreen(): React.JSX.Element {
  useDocumentTitle("Corporate Calendar");
  const [params, setParams] = useSearchParams();
  const [config, setConfig] = useState<CalendarConfigView | null>(null);
  const [options, setOptions] = useState<ListOptions | null>(null);
  const [prefs, setPrefs] = useState<ListPreferences | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [prefsError, setPrefsError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    const call = ++latest.current;
    Promise.all([listApi.config(), listApi.options(), listApi.preferences()]).then(
      ([c, o, p]) => {
        if (call !== latest.current) return;
        setConfig(c);
        setOptions(o);
        setPrefs(p);
      },
      () => call === latest.current && setLoadError("Couldn't load the Calendar list."),
    );
  }, []);

  const fromUrl = useMemo(() => queryFromParams(params), [params]);
  const query = useMemo<ListQuery | null>(() => fromUrl ?? (prefs ? { ...DEFAULT_LIST_QUERY, display: prefs.display } : null), [fromUrl, prefs]);
  const setQuery = (next: ListQuery) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      n.set("q", JSON.stringify(next));
      return n;
    });
  const savePrefs = async (next: ListPreferences) => {
    setPrefs(next);
    setPrefsError(null);
    try {
      setPrefs(await listApi.savePreferences(next));
    } catch {
      setPrefsError("Couldn't save your list settings.");
    }
  };

  if (loadError) {
    return (
      <div>
        <h1>Corporate Calendar</h1>
        <InlineAlert variant="danger" role="alert" description={loadError} />
      </div>
    );
  }
  if (!config || !options || !prefs || !query) {
    return (
      <div>
        <h1>Corporate Calendar</h1>
        <p>Loading…</p>
      </div>
    );
  }
  return (
    <div className="gcpe-calendar-list">
      <h1>Corporate Calendar</h1>
      <FreezeNotice freeze={config.freeze} />
      <FilterPanel
        query={query}
        options={options}
        onSearch={(q) => {
          setQuery(q);
          if (q.display !== prefs.display) void savePrefs({ ...prefs, display: q.display });
        }}
      />
      <ColumnChooser hidden={prefs.hiddenColumns} onChange={(hiddenColumns) => void savePrefs({ ...prefs, hiddenColumns })} />
      {prefsError && <p role="alert">{prefsError}</p>}
      <ActivityTable query={query} hidden={prefs.hiddenColumns} timeZone={config.timeZone} reloadToken={reloadToken} onSort={(sort, dir) => setQuery({ ...query, sort, dir })} />
    </div>
  );
}
```

`setReloadToken` is used by Task 3; until then, TypeScript accepts an unused setter from `useState`.

- [ ] **Step 7: Routing and the section's axe test**

In `apps/staff-web/src/router.tsx`, replace the `CalendarHome` import and its index route with `ActivityListScreen` from `./screens/calendar/list/ActivityListScreen`. Delete `apps/staff-web/src/screens/calendar/CalendarHome.tsx`.

In `apps/staff-web/src/screens/calendar/a11y.test.tsx`:
- import `ActivityListScreen` instead of `CalendarHome` and use it at the index route;
- in `stub()`, before the final `return jsonResponse(200, {})`, add:
  ```ts
      if (url === "/calendar/api/config") return jsonResponse(200, CONFIG);
      if (url === "/calendar/api/list/options") return jsonResponse(200, OPTIONS);
      if (url === "/calendar/api/list/preferences") return jsonResponse(200, PREFS);
      if (url.startsWith("/calendar/api/list?")) return jsonResponse(200, { rows: [row()], total: 1, offset: 0 });
      if (url === "/calendar/api/saved-filters") return jsonResponse(200, []);
  ```
  with `CONFIG`, `OPTIONS`, `PREFS` and `row` imported from `./list/fixtures`;
- rename the test "Calendar home" to "the activity list" and wait for `await screen.findByText("Sample listed")` before running axe.

- [ ] **Step 8: Styles**

Append to `apps/staff-web/src/styles/global.css`:

```css
/* The Calendar's activity list (spec addendum §8.1). Every control is at least 24px (WCAG 2.5.8). */
.gcpe-calendar-list .gcpe-calendar-filter {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
  gap: 0.75rem;
  align-items: end;
  margin-bottom: 1rem;
}
.gcpe-calendar-list .gcpe-field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.gcpe-calendar-list input[type="checkbox"],
.gcpe-calendar-list input[type="radio"] {
  width: 24px;
  height: 24px;
  margin: 0 0.4rem 0 0;
  vertical-align: middle;
}
.gcpe-calendar-list select,
.gcpe-calendar-list input[type="date"],
.gcpe-calendar-list input[type="search"],
.gcpe-calendar-list input[type="number"],
.gcpe-calendar-list input[type="text"] {
  min-height: 32px;
}
.gcpe-calendar-list .gcpe-actions {
  display: flex;
  gap: 0.5rem;
}
.gcpe-calendar-table-wrap {
  overflow-x: auto;
}
.gcpe-calendar-table {
  border-collapse: collapse;
  width: 100%;
  font-size: 0.875rem;
}
.gcpe-calendar-table th,
.gcpe-calendar-table td {
  border: 1px solid #d8d8d8;
  padding: 0.35rem;
  vertical-align: top;
  text-align: left;
}
.gcpe-sort,
.gcpe-star,
.gcpe-view-button {
  min-height: 24px;
  min-width: 24px;
  padding: 0.2rem 0.35rem;
  font: inherit;
  cursor: pointer;
}
.gcpe-sort {
  background: none;
  border: none;
  font-weight: 700;
  text-decoration: underline;
  text-align: left;
}
.gcpe-activity-cell {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.gcpe-needs-review {
  background: #fef0d8;
}
.gcpe-deleted td {
  text-decoration: line-through;
}
.gcpe-badge {
  display: inline-block;
  border: 1px solid #5a5a5a;
  border-radius: 3px;
  padding: 0 0.25rem;
  margin-right: 0.25rem;
  font-size: 0.75rem;
}
.gcpe-hint {
  color: #474543;
  font-size: 0.8rem;
}
.gcpe-not-la {
  color: #8b0000;
}
```

- [ ] **Step 9: Run the unit tests and both type-checks**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web`
Then both `tsc` commands.
Expected: PASS.

- [ ] **Step 10: Run the affected e2e specs**

Run: `npx -y -p node@24 -- npm run test:e2e -- tests/e2e/axe-sweep.spec.ts tests/e2e/sign-in-roles.spec.ts tests/e2e/calendar-access.spec.ts tests/e2e/calendar-lookups.spec.ts tests/e2e/calendar-transfer.spec.ts tests/e2e/calendar-users.spec.ts`
Expected: PASS. The axe sweep's existing Calendar test now scans the list at `/hub/calendar`; a target-size or contrast failure there is this task's to fix in `global.css`.

- [ ] **Step 11: Commit**

```bash
git add apps/staff-web package-lock.json
git commit -m "feat(staff-web): the Calendar activity list: legacy's filters, display, sortable columns loading 30 at a time, column choice and the freeze notice"
```

---

### Task 2: My Queries and the watchlist star

Covers: spec §8.1 (Saved filters, "My Queries": save, apply, rename, reorder and delete, by the owner only; Watchlist and its tooltip), §7.4 (not frozen). Decision D26. Review Focus 4.

**Files:**
- Create: `apps/staff-web/src/screens/calendar/list/MyQueries.tsx`, `apps/staff-web/src/screens/calendar/list/WatchStar.tsx`, `apps/staff-web/src/screens/calendar/list/MyQueries.test.tsx`.
- Modify: `apps/staff-web/src/screens/calendar/list/ActivityListScreen.tsx`, `apps/staff-web/src/screens/calendar/list/a11y.test.tsx`.

**Interfaces:**
- Consumes: Task 1's `listApi`, `TableTools.renderStar`, `minId`, `useCalendarContext()`; `messagesOf` (`screens/admin/messages.ts`).
- Produces: `MyQueries({ current: ListFilter; onRun: (filter: ListFilter) => void })` and `WatchStar({ row: ListRow; myName: string; update: (patch: Partial<ListRow>) => void })`.

- [ ] **Step 1: Write the failing tests**

`apps/staff-web/src/screens/calendar/list/MyQueries.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EMPTY_LIST_FILTER } from "@gcpe/calendar-contract";
import { jsonResponse } from "../../../../test/jsonResponse";
import { listCalls, qOf, renderList, row, stubFetch, type Call } from "./fixtures";

const SAVED = [
  { id: 7, name: "Sample one", sortOrder: 1, filter: { ...EMPTY_LIST_FILTER, categoryId: 32 } },
  { id: 8, name: "Sample two", sortOrder: 2, filter: null },
];

describe("My Queries and the watchlist (spec addendum §8.1)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("saves the current filter, runs a query, renames, moves and deletes, and can't run one it can't read", async () => {
    const calls: Call[] = [];
    stubFetch(calls, {
      saved: SAVED,
      other: (url, init) => {
        if (url === "/calendar/api/saved-filters" && init?.method === "POST") return jsonResponse(201, { id: 9, name: "Sample new", sortOrder: 3, filter: EMPTY_LIST_FILTER });
        if (url === "/calendar/api/saved-filters/7" && init?.method === "PUT") return jsonResponse(200, { ...SAVED[0], name: "Sample renamed" });
        if (url === "/calendar/api/saved-filters/order") return jsonResponse(200, [SAVED[1], { ...SAVED[0], name: "Sample renamed" }]);
        if (url === "/calendar/api/saved-filters/8" && init?.method === "DELETE") return new Response(null, { status: 204 });
        return undefined;
      },
    });
    renderList();
    const region = await screen.findByRole("region", { name: "My Queries" });
    const user = userEvent.setup();
    await user.click(await within(region).findByRole("button", { name: "Sample one" }));
    await waitFor(() => expect(qOf(listCalls(calls).at(-1)!.url)).toMatchObject({ filter: { categoryId: 32 }, corporate: null }));
    expect(within(region).getByRole("button", { name: "Sample two" })).toBeDisabled();
    expect(within(region).getByText("This query can no longer be read. Delete it.")).toBeInTheDocument();

    await user.type(within(region).getByLabelText("Name for this filter"), "Sample new");
    await user.click(within(region).getByRole("button", { name: "Save query" }));
    expect(await within(region).findByRole("status")).toHaveTextContent("Saved the query “Sample new”.");
    const post = calls.find((c) => c.url === "/calendar/api/saved-filters" && c.init?.method === "POST")!;
    expect(JSON.parse(String(post.init!.body))).toMatchObject({ name: "Sample new", filter: { categoryId: 32 } });

    await user.click(within(region).getByRole("button", { name: "Rename Sample one" }));
    const rename = within(region).getByRole("form", { name: "Rename Sample one" });
    await user.clear(within(rename).getByLabelText("New name"));
    await user.type(within(rename).getByLabelText("New name"), "Sample renamed");
    await user.click(within(rename).getByRole("button", { name: "Save name" }));
    expect(await within(region).findByRole("status")).toHaveTextContent("Renamed to “Sample renamed”.");

    await user.click(within(region).getByRole("button", { name: "Move Sample two up" }));
    expect(JSON.parse(String(calls.find((c) => c.url === "/calendar/api/saved-filters/order")!.init!.body))).toEqual({ ids: [8, 7, 9] });

    await user.click(await within(region).findByRole("button", { name: "Delete Sample two" }));
    expect(await within(region).findByRole("status")).toHaveTextContent("Deleted the query “Sample two”.");
  });

  it("a stale order reloads the queries and says why", async () => {
    stubFetch([], {
      saved: [SAVED[0]!, { ...SAVED[0]!, id: 10, name: "Sample ten" }],
      other: (url) => (url === "/calendar/api/saved-filters/order" ? jsonResponse(409, { code: "stale", error: "Your queries changed since you loaded them: reload and try again" }) : undefined),
    });
    renderList();
    const region = await screen.findByRole("region", { name: "My Queries" });
    await userEvent.setup().click(await within(region).findByRole("button", { name: "Move Sample ten up" }));
    expect(await within(region).findByRole("alert")).toHaveTextContent("Your queries changed in another tab, so they were reloaded.");
  });

  it("the star is a toggle button that names its watchers, and watching updates it", async () => {
    const calls: Call[] = [];
    stubFetch(calls, {
      page: () => ({ rows: [row({ watcherNames: ["Sample Admin"] })], total: 1, offset: 0 }),
      other: (url, init) => (url === "/calendar/api/activities/20001/watch" ? (init?.method === "PUT" ? new Response(null, { status: 204 }) : undefined) : undefined),
    });
    renderList();
    const star = await screen.findByRole("button", { name: "Watch HLTH-20001" });
    expect(star).toHaveAttribute("aria-pressed", "false");
    expect(star).toHaveAccessibleDescription("Watched by Sample Admin");
    await userEvent.setup().click(star);
    await waitFor(() => expect(star).toHaveAttribute("aria-pressed", "true"));
    expect(star).toHaveAccessibleDescription("Watched by Robin Staff, Sample Admin");
    expect(calls.some((c) => c.url === "/calendar/api/activities/20001/watch" && c.init?.method === "PUT")).toBe(true);
  });
});
```

Add to `apps/staff-web/src/screens/calendar/list/a11y.test.tsx`:

```tsx
  it("My Queries with one being renamed, and a watched row", async () => {
    stubFetch([], {
      saved: [{ id: 7, name: "Sample one", sortOrder: 1, filter: null }],
      page: () => ({ rows: [row({ isWatched: true, watcherNames: ["Robin Staff"] })], total: 1, offset: 0 }),
    });
    const { container } = renderList();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Rename Sample one" }));
    await screen.findByLabelText("New name");
    expect(await seriousViolations(container)).toEqual([]);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/calendar/list`
Expected: FAIL (no "My Queries" region; no star).

- [ ] **Step 3: Implement**

`apps/staff-web/src/screens/calendar/list/MyQueries.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { Button, InlineAlert } from "@bcgov/design-system-react-components";
import type { ListFilter, SavedFilterView } from "@gcpe/calendar-contract";
import { ApiError } from "../../../api/client";
import { messagesOf } from "../../admin/messages";
import { listApi } from "./api";

/** "My Queries" (Default.aspx:663-681): your own saved filters. Saving isn't frozen. */
export function MyQueries({ current, onRun }: { current: ListFilter; onRun: (filter: ListFilter) => void }): React.JSX.Element {
  const [filters, setFilters] = useState<SavedFilterView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const latest = useRef(0);

  const load = () => {
    const call = ++latest.current;
    listApi.savedFilters().then(
      (f) => call === latest.current && setFilters(f),
      () => call === latest.current && setLoadError("Couldn't load your queries."),
    );
  };
  useEffect(load, []);

  const act = async (work: () => Promise<string>) => {
    setErrors([]);
    setStatus(null);
    try {
      setStatus(await work());
    } catch (caught) {
      const stale = caught instanceof ApiError && (caught.status === 409 || caught.status === 404);
      setErrors(stale ? ["Your queries changed in another tab, so they were reloaded."] : messagesOf(caught));
      if (stale) load();
    }
  };
  const save = () =>
    act(async () => {
      const f = await listApi.saveFilter(name.trim(), current);
      setFilters((xs) => [...(xs ?? []), f]);
      setName("");
      return `Saved the query “${f.name}”.`;
    });
  const rename = (f: SavedFilterView) =>
    act(async () => {
      const r = await listApi.renameFilter(f.id, editName.trim());
      setFilters((xs) => (xs ?? []).map((x) => (x.id === r.id ? r : x)));
      setEditing(null);
      return `Renamed to “${r.name}”.`;
    });
  const move = (index: number, delta: -1 | 1) =>
    act(async () => {
      const list = filters ?? [];
      const ids = list.map((f) => f.id);
      [ids[index], ids[index + delta]] = [ids[index + delta]!, ids[index]!];
      setFilters(await listApi.reorderFilters(ids));
      return `Moved “${list[index]!.name}” ${delta < 0 ? "up" : "down"}.`;
    });
  const remove = (f: SavedFilterView) =>
    act(async () => {
      await listApi.deleteFilter(f.id);
      setFilters((xs) => (xs ?? []).filter((x) => x.id !== f.id));
      return `Deleted the query “${f.name}”.`;
    });

  return (
    <section aria-labelledby="my-queries-heading" className="gcpe-my-queries">
      <h2 id="my-queries-heading">My Queries</h2>
      {status && <p role="status">{status}</p>}
      {errors.map((m) => (
        <p role="alert" key={m}>
          {m}
        </p>
      ))}
      {loadError ? (
        <InlineAlert variant="danger" role="alert" description={loadError} />
      ) : filters === null ? (
        <p>Loading…</p>
      ) : filters.length === 0 ? (
        <p>Use the filter above, then save it here.</p>
      ) : (
        <ul>
          {filters.map((f, i) => (
            <li key={f.id}>
              {editing === f.id ? (
                <form
                  aria-label={`Rename ${f.name}`}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void rename(f);
                  }}
                >
                  <label htmlFor={`query-name-${f.id}`}>New name</label>
                  <input id={`query-name-${f.id}`} maxLength={200} value={editName} onChange={(e) => setEditName(e.target.value)} />
                  <Button type="submit" isDisabled={!editName.trim()}>
                    Save name
                  </Button>
                  <Button variant="tertiary" onPress={() => setEditing(null)}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <>
                  <Button variant="tertiary" isDisabled={f.filter === null} onPress={() => f.filter && onRun(f.filter)}>
                    {f.name}
                  </Button>
                  {f.filter === null && <span className="gcpe-hint">This query can no longer be read. Delete it.</span>}
                  <Button variant="tertiary" aria-label={`Rename ${f.name}`} onPress={() => { setEditing(f.id); setEditName(f.name); }}>
                    Rename
                  </Button>
                  <Button variant="tertiary" aria-label={`Move ${f.name} up`} isDisabled={i === 0} onPress={() => void move(i, -1)}>
                    Up
                  </Button>
                  <Button variant="tertiary" aria-label={`Move ${f.name} down`} isDisabled={i === filters.length - 1} onPress={() => void move(i, 1)}>
                    Down
                  </Button>
                  <Button variant="tertiary" aria-label={`Delete ${f.name}`} onPress={() => void remove(f)}>
                    Delete
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        aria-label="Save this filter"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label htmlFor="query-name">Name for this filter</label>
        <input id="query-name" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" isDisabled={!name.trim()}>
          Save query
        </Button>
      </form>
    </section>
  );
}
```

`apps/staff-web/src/screens/calendar/list/WatchStar.tsx`:

```tsx
import { useState } from "react";
import type { ListRow } from "@gcpe/calendar-contract";
import { listApi } from "./api";
import { minId } from "./cells";

/** The watchlist star (Activity.aspx.cs:1519-1535): a toggle, naming who watches. Not frozen. */
export function WatchStar({ row, myName, update }: { row: ListRow; myName: string; update: (patch: Partial<ListRow>) => void }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tip = row.watcherNames.length ? `Watched by ${row.watcherNames.join(", ")}` : "Nobody watches this yet";
  const toggle = async () => {
    const on = !row.isWatched;
    setBusy(true);
    setError(null);
    try {
      await listApi.watch(row.id, on);
      const others = row.watcherNames.filter((n) => n !== myName);
      update({ isWatched: on, watcherNames: on ? [...others, myName].sort((a, b) => a.localeCompare(b)) : others });
    } catch {
      setError("Couldn't change your watchlist.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <span>
      <button type="button" className="gcpe-star" aria-label={`Watch ${minId(row)}`} aria-pressed={row.isWatched} aria-describedby={`watchers-${row.id}`} title={tip} disabled={busy} onClick={() => void toggle()}>
        {row.isWatched ? "★" : "☆"}
      </button>
      <span id={`watchers-${row.id}`} className="gcpe-visually-hidden">
        {tip}
      </span>
      {error && <span role="alert">{error}</span>}
    </span>
  );
}
```

In `ActivityListScreen.tsx`: import `useCalendarContext` from `../CalendarSection`, `MyQueries` and `WatchStar`; add `const me = useCalendarContext();` at the top of the component; add `tools={{ renderStar: (r, update) => <WatchStar row={r} myName={me.displayName} update={update} /> }}` to `ActivityTable`; and, after `FilterPanel`, add:

```tsx
      <MyQueries current={query.filter} onRun={(filter) => setQuery({ ...query, corporate: null, filter })} />
```

- [ ] **Step 4: Run the tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/calendar`
Expected: PASS.

- [ ] **Step 5: Run the affected e2e specs**

Run the Task 1 Step 10 command. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/staff-web
git commit -m "feat(staff-web): My Queries (save, run, rename, reorder, delete) and the watchlist star with its watchers"
```

---

### Task 3: HQ tools and the Excel export

Covers: spec §8.1 (Corporate queries; Look Ahead admin filter; Toolbar: Review selected, Clear LA Status, Excel Export), §6 (each tool's threshold, from `GET /api/config`'s `list` flags), §7.1 (Review selected skips rows changed since the list loaded), C127, C139, C151. Decisions D27, D28. Carry-forward: Review selected and Clear LA Status payloads; the 207 `failed` body. Review Focus 2, 5.

**Files:**
- Create: `apps/staff-web/src/screens/calendar/list/HqTools.tsx`, `apps/staff-web/src/screens/calendar/list/HqTools.test.tsx`.
- Modify: `apps/staff-web/src/screens/calendar/list/ActivityListScreen.tsx`, `apps/staff-web/src/screens/calendar/list/a11y.test.tsx`.

**Interfaces:**
- Consumes: `listApi.reviewSelected`, `listApi.clearLaStatus`, `downloadExport`, `CalendarConfigView.list`, `TableTools.selected`/`onSelect`.
- Produces: `ReviewSelected({ selected, onDone })`, `ClearLaStatus({ onDone })`, `CorporateQueries({ active, onRun, onClear })`, `LookAheadFilterChoice({ value, onChange })`, `ExportButton({ query })`, and `REVIEW_SELECTED_MAX = 500`.

- [ ] **Step 1: Write the failing tests**

`apps/staff-web/src/screens/calendar/list/HqTools.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { jsonResponse } from "../../../../test/jsonResponse";
import { HQ_ADMIN_CONFIG, HQ_ADMIN_ME, listCalls, qOf, renderList, row, stubFetch, type Call } from "./fixtures";

const ROWS = [row({ id: 20001, version: 3 }), row({ id: 20002, version: 5, title: "Sample second" })];
const hq = (calls: Call[], other?: (url: string, init?: RequestInit) => Response | undefined) =>
  stubFetch(calls, { me: HQ_ADMIN_ME, config: HQ_ADMIN_CONFIG, page: () => ({ rows: ROWS, total: 2, offset: 0 }), other });

describe("the list's HQ tools and the export (spec addendum §8.1)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("an Editor gets the export and none of the HQ tools", async () => {
    stubFetch([]);
    renderList();
    await screen.findByText("Sample listed");
    expect(screen.getByRole("button", { name: "Excel export" })).toBeInTheDocument();
    for (const name of [/^Review selected/, "Clear LA Status"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.queryByRole("region", { name: "Corporate Queries" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Look Ahead filter" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Select HLTH-20001" })).toBeNull();
  });

  it("reviews the ticked rows with their versions, reports skipped rows by MIN-Id and reloads", async () => {
    const calls: Call[] = [];
    hq(calls, (url) => (url === "/calendar/api/activities/review-selected" ? jsonResponse(200, { reviewed: [20001], skipped: [{ id: 20002, reason: "changed" }] }) : undefined));
    renderList();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: "Select HLTH-20001" }));
    await user.click(screen.getByRole("checkbox", { name: "Select HLTH-20002" }));
    await user.click(screen.getByRole("button", { name: "Review selected (2)" }));
    expect(await screen.findByText("Reviewed 1 activity. 1 skipped because it changed since the list loaded: HLTH-20002.")).toBeInTheDocument();
    const post = calls.find((c) => c.url === "/calendar/api/activities/review-selected")!;
    expect(JSON.parse(String(post.init!.body))).toEqual({ items: [{ id: 20001, version: 3 }, { id: 20002, version: 5 }] });
    await waitFor(() => expect(listCalls(calls)).toHaveLength(2));
    expect(screen.getByRole("button", { name: "Review selected (0)" })).toBeDisabled();
  });

  it("a 207 partial commit is an alert, not a success", async () => {
    hq([], (url) => (url === "/calendar/api/activities/review-selected" ? jsonResponse(207, { reviewed: [20001], skipped: [], failed: true }) : url === "/calendar/api/activities/clear-la-status" ? jsonResponse(207, { cleared: 100, failed: true }) : undefined));
    renderList();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: "Select HLTH-20001" }));
    await user.click(screen.getByRole("checkbox", { name: "Select HLTH-20002" }));
    await user.click(screen.getByRole("button", { name: "Review selected (2)" }));
    expect(await screen.findByText("Only 1 of 2 activities were reviewed before a later batch failed. Select the rest and review them again.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear LA Status" }));
    expect(await screen.findByText("The LA status of 100 activities was cleared before a later batch failed. Run Clear LA Status again to finish.")).toBeInTheDocument();
  });

  it("clears the LA status for the days chosen", async () => {
    const calls: Call[] = [];
    hq(calls, (url) => (url === "/calendar/api/activities/clear-la-status" ? jsonResponse(200, { cleared: 3 }) : undefined));
    renderList();
    const user = userEvent.setup();
    const days = await screen.findByLabelText("Days ahead");
    expect(days).toHaveValue(8);
    await user.clear(days);
    await user.type(days, "14");
    await user.click(screen.getByRole("button", { name: "Clear LA Status" }));
    expect(await screen.findByText("Cleared the LA status of 3 activities.")).toBeInTheDocument();
    expect(JSON.parse(String(calls.find((c) => c.url === "/calendar/api/activities/clear-la-status")!.init!.body))).toEqual({ days: 14 });
  });

  it("runs a corporate query and goes back to the filter; sets the Look Ahead filter", async () => {
    const calls: Call[] = [];
    hq(calls);
    renderList();
    const user = userEvent.setup();
    const corp = await screen.findByRole("region", { name: "Corporate Queries" });
    await user.click(within(corp).getByLabelText("Show all"));
    await user.click(within(corp).getByLabelText("Reviewed"));
    await user.click(within(corp).getByRole("button", { name: "Search" }));
    await waitFor(() => expect(qOf(listCalls(calls).at(-1)!.url)).toMatchObject({ corporate: { days: null, statuses: ["new", "changed", "reviewed"] } }));
    await user.click(await screen.findByRole("button", { name: "Back to the filter" }));
    await waitFor(() => expect(qOf(listCalls(calls).at(-1)!.url)).toMatchObject({ corporate: null }));
    await user.click(within(screen.getByRole("group", { name: "Look Ahead filter" })).getByLabelText("Not for Look Ahead Only"));
    await waitFor(() => expect(qOf(listCalls(calls).at(-1)!.url)).toMatchObject({ lookAhead: "not_for_look_ahead_only" }));
  });

  it("an export the server refuses shows its reason", async () => {
    stubFetch([], { other: (url) => (url.startsWith("/calendar/api/list/export.xlsx") ? jsonResponse(422, { error: "More than 10,000 activities match: narrow the filter and export again" }) : undefined) });
    renderList();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Excel export" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("More than 10,000 activities match: narrow the filter and export again");
  });

  it("an export downloads the workbook for the current query", async () => {
    const calls: Call[] = [];
    // jsdom has no object URLs.
    const createObjectURL = vi.fn(() => "blob:sample");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    stubFetch(calls, { other: (url) => (url.startsWith("/calendar/api/list/export.xlsx") ? new Response(new Blob(["PK"]), { status: 200 }) : undefined) });
    renderList();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Excel export" }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    expect(qOf(calls.find((c) => c.url.startsWith("/calendar/api/list/export.xlsx"))!.url)).toMatchObject({ sort: "dateTime" });
  });
});
```

Add to `apps/staff-web/src/screens/calendar/list/a11y.test.tsx` (import `HQ_ADMIN_CONFIG`, `HQ_ADMIN_ME` and `jsonResponse`):

```tsx
  it("an HQ Administrator's tools, after a partial review", async () => {
    stubFetch([], {
      me: HQ_ADMIN_ME,
      config: HQ_ADMIN_CONFIG,
      other: (url) => (url === "/calendar/api/activities/review-selected" ? jsonResponse(207, { reviewed: [], skipped: [{ id: 20001, reason: "changed" }], failed: true }) : undefined),
    });
    const { container } = renderList();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: "Select HLTH-20001" }));
    await user.click(screen.getByRole("button", { name: "Review selected (1)" }));
    await screen.findByText(/before a later batch failed/);
    expect(await seriousViolations(container)).toEqual([]);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/calendar/list`
Expected: FAIL (no "Excel export" button; no HQ tools).

- [ ] **Step 3: Implement the tools**

`apps/staff-web/src/screens/calendar/list/HqTools.tsx`:

```tsx
import { useState } from "react";
import { Button } from "@bcgov/design-system-react-components";
import { CORPORATE_STATUSES, type CorporateQuery, type CorporateStatus, type ListQuery, type LookAheadFilter } from "@gcpe/calendar-contract";
import { messagesOf } from "../../admin/messages";
import { downloadExport, listApi } from "./api";

/** POST /activities/review-selected takes at most this many. */
export const REVIEW_SELECTED_MAX = 500;
const plural = (n: number) => `${n} ${n === 1 ? "activity" : "activities"}`;

function Result({ status, error }: { status: string | null; error: string | null }) {
  return (
    <>
      {status && <p role="status">{status}</p>}
      {error && <p role="alert">{error}</p>}
    </>
  );
}

/** Review selected (UCFlexiGrid.ascx.cs:21-27; HQ Administrators). Rows changed since the list loaded are skipped. */
export function ReviewSelected({ selected, onDone }: { selected: Map<number, { version: number; label: string }>; onDone: () => void }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    const items = [...selected].map(([id, s]) => ({ id, version: s.version }));
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const out = await listApi.reviewSelected(items);
      // A 207: a later batch rolled back after earlier ones committed; only `reviewed` is real.
      if (out.failed) {
        setError(`Only ${out.reviewed.length} of ${plural(items.length)} were reviewed before a later batch failed. Select the rest and review them again.`);
      } else {
        const label = (id: number) => selected.get(id)?.label ?? String(id);
        const changed = out.skipped.filter((s) => s.reason === "changed").map((s) => label(s.id));
        const gone = out.skipped.filter((s) => s.reason === "not_found").map((s) => label(s.id));
        setStatus(
          [
            `Reviewed ${plural(out.reviewed.length)}.`,
            changed.length ? `${changed.length} skipped because ${changed.length === 1 ? "it" : "they"} changed since the list loaded: ${changed.join(", ")}.` : "",
            gone.length ? `${gone.length} skipped because ${gone.length === 1 ? "it is" : "they are"} no longer visible: ${gone.join(", ")}.` : "",
          ].filter(Boolean).join(" "),
        );
      }
      onDone();
    } catch (caught) {
      setError(messagesOf(caught).join(" "));
    } finally {
      setBusy(false);
    }
  };
  const tooMany = selected.size > REVIEW_SELECTED_MAX;
  return (
    <div>
      <Button isDisabled={busy || selected.size === 0 || tooMany} onPress={() => void run()}>{`Review selected (${selected.size})`}</Button>
      {tooMany && <p className="gcpe-hint">{`Select at most ${REVIEW_SELECTED_MAX} at a time.`}</p>}
      <Result status={status} error={error} />
    </div>
  );
}

/** Clear LA Status (Default.aspx.cs:44-53; HQ Editors and above): every visible activity starting within the days given. */
export function ClearLaStatus({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [days, setDays] = useState("8");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const valid = /^\d{1,3}$/.test(days) && Number(days) <= 366;
  const run = async () => {
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const out = await listApi.clearLaStatus(Number(days));
      if (out.failed) setError(`The LA status of ${plural(out.cleared)} was cleared before a later batch failed. Run Clear LA Status again to finish.`);
      else setStatus(`Cleared the LA status of ${plural(out.cleared)}.`);
      onDone();
    } catch (caught) {
      setError(messagesOf(caught).join(" "));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <label htmlFor="la-days">Days ahead</label>
      <input id="la-days" type="number" min={0} max={366} value={days} aria-invalid={!valid} onChange={(e) => setDays(e.target.value)} />
      <Button variant="secondary" isDisabled={busy || !valid} onPress={() => void run()}>
        Clear LA Status
      </Button>
      <Result status={status} error={error} />
    </div>
  );
}

const CORPORATE_LABELS: Record<CorporateStatus, string> = { new: "New", changed: "Changed", reviewed: "Reviewed", deleted: "Deleted", la_new: "LA New", la_changed: "LA Changed" };

/** Corporate Queries (Default.aspx:628-660; HQ Advanced and above): every ministry's upcoming activities by status. */
export function CorporateQueries({ active, onRun, onClear }: { active: CorporateQuery | null; onRun: (c: CorporateQuery) => void; onClear: () => void }): React.JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const [days, setDays] = useState("8");
  const [statuses, setStatuses] = useState<CorporateStatus[]>(["new", "changed"]);
  const valid = statuses.length > 0 && (showAll || (/^\d{1,3}$/.test(days) && Number(days) <= 366));
  return (
    <section aria-labelledby="corporate-heading">
      <h2 id="corporate-heading">Corporate Queries</h2>
      {active && (
        <p role="status">
          Showing a corporate query.{" "}
          <Button variant="tertiary" onPress={onClear}>
            Back to the filter
          </Button>
        </p>
      )}
      <form
        aria-label="Corporate query"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onRun({ days: showAll ? null : Number(days), statuses: CORPORATE_STATUSES.filter((s) => statuses.includes(s)) });
        }}
      >
        <fieldset>
          <legend>Upcoming activities to show</legend>
          <div>
            <input type="radio" id="corp-all" name="corp-range" checked={showAll} onChange={() => setShowAll(true)} />
            <label htmlFor="corp-all">Show all</label>
          </div>
          <div>
            <input type="radio" id="corp-days" name="corp-range" checked={!showAll} onChange={() => setShowAll(false)} />
            <label htmlFor="corp-days">For the next</label> <input aria-label="Number of days" type="number" min={0} max={366} value={days} disabled={showAll} onChange={(e) => setDays(e.target.value)} /> days
          </div>
        </fieldset>
        <fieldset>
          <legend>With status of</legend>
          {CORPORATE_STATUSES.map((s) => (
            <div key={s}>
              <input type="checkbox" id={`corp-${s}`} checked={statuses.includes(s)} onChange={(e) => setStatuses((xs) => (e.target.checked ? [...xs, s] : xs.filter((x) => x !== s)))} />
              <label htmlFor={`corp-${s}`}>{CORPORATE_LABELS[s]}</label>
            </div>
          ))}
        </fieldset>
        <Button type="submit" isDisabled={!valid}>
          Search
        </Button>
      </form>
    </section>
  );
}

const LOOK_AHEAD_LABELS: Record<LookAheadFilter, string> = { all: "Show All", look_ahead_only: "Look Ahead Only", not_for_look_ahead_only: "Not for Look Ahead Only" };

/** The Admin Settings' Look Ahead filter (Default.aspx:684-698; HQ Advanced and above). */
export function LookAheadFilterChoice({ value, onChange }: { value: LookAheadFilter; onChange: (v: LookAheadFilter) => void }): React.JSX.Element {
  return (
    <fieldset role="group" aria-labelledby="la-filter-legend">
      <legend id="la-filter-legend">Look Ahead filter</legend>
      {(Object.keys(LOOK_AHEAD_LABELS) as LookAheadFilter[]).map((v) => (
        <div key={v}>
          <input type="radio" id={`la-filter-${v}`} name="la-filter" checked={value === v} onChange={() => onChange(v)} />
          <label htmlFor={`la-filter-${v}`}>{LOOK_AHEAD_LABELS[v]}</label>
        </div>
      ))}
    </fieldset>
  );
}

/** The Excel export (C151): the current query's visible rows as .xlsx. */
export function ExportButton({ query }: { query: ListQuery }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await downloadExport(query);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn't export the list.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <Button variant="secondary" isDisabled={busy} onPress={() => void run()}>
        Excel export
      </Button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 4: Wire them into the screen**

In `ActivityListScreen.tsx`:
- import the five components;
- add selection state, cleared whenever the query changes:
  ```tsx
  const [selected, setSelected] = useState<Map<number, { version: number; label: string }>>(new Map());
  const queryKey = JSON.stringify(query);
  useEffect(() => setSelected(new Map()), [queryKey, reloadToken]);
  const reload = () => setReloadToken((n) => n + 1);
  ```
  (place these after `query` is defined and before the early returns, so hook order never changes);
- build the table tools:
  ```tsx
  const tools: TableTools = {
    renderStar: (r, update) => <WatchStar row={r} myName={me.displayName} update={update} />,
    ...(config.list.reviewSelected
      ? {
          selected,
          onSelect: (r: ListRow, on: boolean) =>
            setSelected((s) => {
              const n = new Map(s);
              if (on) n.set(r.id, { version: r.version, label: minId(r) });
              else n.delete(r.id);
              return n;
            }),
        }
      : {}),
  };
  ```
  and pass `tools={tools}` to `ActivityTable` (replacing Task 2's inline `tools`);
- after `MyQueries`, add:
  ```tsx
      {config.list.corporateQueries && (
        <CorporateQueries active={query.corporate} onRun={(corporate) => setQuery({ ...query, corporate })} onClear={() => setQuery({ ...query, corporate: null })} />
      )}
      {config.list.lookAheadFilter && <LookAheadFilterChoice value={query.lookAhead} onChange={(lookAhead) => setQuery({ ...query, lookAhead })} />}
      <section aria-label="List actions" className="gcpe-actions">
        {config.list.reviewSelected && <ReviewSelected selected={selected} onDone={reload} />}
        {config.list.clearLaStatus && <ClearLaStatus onDone={reload} />}
        <ExportButton query={query} />
      </section>
  ```
- import `minId` and `type TableTools` from `./cells` and `type ListRow` from the contract.

- [ ] **Step 5: Run the tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/calendar`
Expected: PASS.

- [ ] **Step 6: Run the affected e2e specs**

Run the Task 1 Step 10 command. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/staff-web
git commit -m "feat(staff-web): the list's HQ tools (Review selected, Clear LA Status, Corporate Queries, the Look Ahead filter) and the Excel export, partial commits reported"
```

---

### Task 4: The month and week views

Covers: spec §8.1 ("Calendar view: a month and week view of the current filter, replacing legacy's FullCalendar toggle"). Decisions D17 (5d-1), D25, D29.

**Files:**
- Create: `apps/staff-web/src/screens/calendar/list/CalendarGrid.tsx`, `apps/staff-web/src/screens/calendar/list/CalendarGrid.test.tsx`.
- Modify: `apps/staff-web/src/screens/calendar/list/ActivityListScreen.tsx`, `apps/staff-web/src/screens/calendar/list/a11y.test.tsx`, `apps/staff-web/src/screens/calendar/list/dates.ts`, `apps/staff-web/src/styles/global.css`.

**Interfaces:**
- Consumes: `listApi.calendar(q, start, end)`; `dates.ts`.
- Produces: `monthRange(anchor: string): { start: string; end: string }`, `weekRange(anchor: string): { start: string; end: string }`, `shiftMonth(anchor: string, delta: number): string` (in `dates.ts`); `ViewSwitch({ view, onChange })` and `CalendarGrid({ query, view, anchor, timeZone, onAnchor })`.

- [ ] **Step 1: Write the failing tests**

`apps/staff-web/src/screens/calendar/list/CalendarGrid.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { monthRange, shiftMonth, weekRange } from "./dates";
import { renderList, stubFetch, type Call } from "./fixtures";

const ITEM = { id: 20001, title: "Sample listed", startAt: "2026-11-10T17:00:00.000Z", endAt: "2026-11-12T18:00:00.000Z", isAllDay: false, isConfirmed: true, isConfidential: false, ministryAbbreviation: "HLTH" };
const rangeOf = (url: string) => {
  const p = new URL(url, "http://staff.example.test").searchParams;
  return [p.get("start"), p.get("end")];
};

describe("the month and week views (spec addendum §8.1)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("ranges: whole Sunday-first weeks around the month, or one week", () => {
    expect(monthRange("2026-11-15")).toEqual({ start: "2026-11-01", end: "2026-12-05" });
    expect(monthRange("2026-12-31")).toEqual({ start: "2026-11-29", end: "2027-01-02" });
    expect(weekRange("2026-11-11")).toEqual({ start: "2026-11-08", end: "2026-11-14" });
    expect(shiftMonth("2026-12-15", 1)).toBe("2027-01-01");
    expect(shiftMonth("2026-01-31", -1)).toBe("2025-12-01");
  });

  it("the month view shows each activity on each of its days, and moves by month", async () => {
    const calls: Call[] = [];
    stubFetch(calls, { calendar: { items: [ITEM], truncated: false } });
    renderList("/calendar?view=month&on=2026-11-15");
    expect(await screen.findByRole("heading", { level: 2, name: "November 2026" })).toBeInTheDocument();
    await waitFor(() => expect(rangeOf(calls.find((c) => c.url.startsWith("/calendar/api/list/calendar?"))!.url)).toEqual(["2026-11-01", "2026-12-05"]));
    for (const day of ["2026-11-10", "2026-11-11", "2026-11-12"]) {
      const cell = document.querySelector(`td[data-date="${day}"]`) as HTMLElement;
      expect(within(cell).getByText(/HLTH-20001/)).toBeInTheDocument();
    }
    expect(within(document.querySelector('td[data-date="2026-11-10"]') as HTMLElement).getByText("HLTH-20001 9:00 AM Sample listed")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Next month" }));
    expect(await screen.findByRole("heading", { level: 2, name: "December 2026" })).toBeInTheDocument();
  });

  it("the week view, and the note when the range holds more than 1,000", async () => {
    const calls: Call[] = [];
    stubFetch(calls, { calendar: { items: [ITEM], truncated: true } });
    renderList("/calendar?view=week&on=2026-11-11");
    expect(await screen.findByRole("heading", { level: 2, name: "Week of Nov 8, 2026" })).toBeInTheDocument();
    expect(await screen.findByText("Only the first 1,000 activities are shown. Narrow the filter to see the rest.")).toBeInTheDocument();
    await waitFor(() => expect(rangeOf(calls.find((c) => c.url.startsWith("/calendar/api/list/calendar?"))!.url)).toEqual(["2026-11-08", "2026-11-14"]));
  });

  it("switches between the list and the calendar views", async () => {
    stubFetch([], { calendar: { items: [], truncated: false } });
    renderList();
    await screen.findByText("Sample listed");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Month" }));
    expect(await screen.findByRole("table", { name: /\d{4}$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Month" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "List" }));
    expect(await screen.findByText("Sample listed")).toBeInTheDocument();
  });
});
```

Add to `apps/staff-web/src/screens/calendar/list/a11y.test.tsx`:

```tsx
  it("the month view and the week view", async () => {
    const item = { id: 20001, title: "Sample listed", startAt: "2026-11-10T17:00:00.000Z", endAt: "2026-11-10T18:00:00.000Z", isAllDay: false, isConfirmed: true, isConfidential: false, ministryAbbreviation: "HLTH" };
    stubFetch([], { calendar: { items: [item], truncated: true } });
    const month = renderList("/calendar?view=month&on=2026-11-15");
    await screen.findByText("HLTH-20001 9:00 AM Sample listed");
    expect(await seriousViolations(month.container)).toEqual([]);
    cleanup();
    const week = renderList("/calendar?view=week&on=2026-11-11");
    await screen.findByText("HLTH-20001 9:00 AM Sample listed");
    expect(await seriousViolations(week.container)).toEqual([]);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/calendar/list`
Expected: FAIL ("monthRange is not exported"; no "Month" button).

- [ ] **Step 3: Implement**

Append to `apps/staff-web/src/screens/calendar/list/dates.ts`:

```ts
const lastOfMonth = (first: string) => addDaysTo(shiftMonth(first, 1), -1);

/** The first of the month `delta` months from `anchor`'s. */
export function shiftMonth(anchor: string, delta: number): string {
  const d = new Date(`${anchor.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + delta);
  return d.toISOString().slice(0, 10);
}

/** Whole Sunday-first weeks covering `anchor`'s month: at most 42 days. */
export function monthRange(anchor: string): { start: string; end: string } {
  const first = shiftMonth(anchor, 0);
  const last = lastOfMonth(first);
  return { start: addDaysTo(first, -weekdayOf(first)), end: addDaysTo(last, 6 - weekdayOf(last)) };
}

export function weekRange(anchor: string): { start: string; end: string } {
  const start = addDaysTo(anchor, -weekdayOf(anchor));
  return { start, end: addDaysTo(start, 6) };
}
```

`apps/staff-web/src/screens/calendar/list/CalendarGrid.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { Button, InlineAlert } from "@bcgov/design-system-react-components";
import type { CalendarItem, CalendarRangeView, ListQuery } from "@gcpe/calendar-contract";
import { listApi } from "./api";
import { minId } from "./cells";
import { addDaysTo, bcDateOf, monthRange, shiftMonth, todayIn, weekRange } from "./dates";
import type { ListView } from "./types";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = [["Sun", "Sunday"], ["Mon", "Monday"], ["Tue", "Tuesday"], ["Wed", "Wednesday"], ["Thu", "Thursday"], ["Fri", "Friday"], ["Sat", "Saturday"]] as const;
const VIEW_LABELS: Record<ListView, string> = { list: "List", month: "Month", week: "Week" };
const shortMonth = (d: string) => MONTHS[Number(d.slice(5, 7)) - 1]!.slice(0, 3);

/** List, Month or Week (replacing legacy's FullCalendar toggle, Default.aspx:191-262). */
export function ViewSwitch({ view, onChange }: { view: ListView; onChange: (v: ListView) => void }): React.JSX.Element {
  return (
    <div role="group" aria-label="View" className="gcpe-actions">
      {(Object.keys(VIEW_LABELS) as ListView[]).map((v) => (
        <button key={v} type="button" className="gcpe-view-button" aria-pressed={view === v} onClick={() => onChange(v)}>
          {VIEW_LABELS[v]}
        </button>
      ))}
    </div>
  );
}

/** "9:00 AM" with a plain space: Intl's own output puts a narrow no-break space before AM/PM. */
function timeText(iso: string, timeZone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]),
  );
  return `${p.hour}:${p.minute} ${p.dayPeriod}`;
}

/** A month or week of the current query's activities; a multi-day activity shows on each of its days. */
export function CalendarGrid({ query, view, anchor, timeZone, onAnchor }: { query: ListQuery; view: "month" | "week"; anchor: string; timeZone: string; onAnchor: (date: string) => void }): React.JSX.Element {
  const range = view === "month" ? monthRange(anchor) : weekRange(anchor);
  const [data, setData] = useState<CalendarRangeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const key = JSON.stringify([query, range.start, range.end]);
  useEffect(() => {
    const call = ++latest.current;
    setData(null);
    setError(null);
    listApi.calendar(query, range.start, range.end).then(
      (d) => call === latest.current && setData(d),
      () => call === latest.current && setError("Couldn't load the calendar."),
    );
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const days: string[] = [];
  for (let d = range.start; d <= range.end; d = addDaysTo(d, 1)) days.push(d);
  const byDay = new Map<string, CalendarItem[]>();
  for (const item of data?.items ?? []) {
    if (!item.startAt) continue;
    const first = bcDateOf(item.startAt, timeZone);
    const last = item.endAt ? bcDateOf(item.endAt, timeZone) : first;
    for (let d = first < range.start ? range.start : first; d <= last && d <= range.end; d = addDaysTo(d, 1)) byDay.set(d, [...(byDay.get(d) ?? []), item]);
  }
  const weeks: string[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  const title = view === "month" ? `${MONTHS[Number(anchor.slice(5, 7)) - 1]} ${anchor.slice(0, 4)}` : `Week of ${shortMonth(range.start)} ${Number(range.start.slice(8))}, ${range.start.slice(0, 4)}`;
  const unit = view === "month" ? "month" : "week";
  const step = (delta: -1 | 1) => (view === "month" ? shiftMonth(anchor, delta) : addDaysTo(anchor, 7 * delta));
  const itemText = (i: CalendarItem, day: string) =>
    `${minId(i)} ${!i.isAllDay && i.startAt && bcDateOf(i.startAt, timeZone) === day ? `${timeText(i.startAt, timeZone)} ` : ""}${i.title}`;

  return (
    <section aria-labelledby="calendar-grid-heading" className="gcpe-calendar-grid">
      <h2 id="calendar-grid-heading">{title}</h2>
      <div className="gcpe-actions">
        <Button variant="secondary" onPress={() => onAnchor(step(-1))}>{`Previous ${unit}`}</Button>
        <Button variant="secondary" onPress={() => onAnchor(todayIn(timeZone))}>
          Today
        </Button>
        <Button variant="secondary" onPress={() => onAnchor(step(1))}>{`Next ${unit}`}</Button>
      </div>
      {error && <InlineAlert variant="danger" role="alert" description={error} />}
      {!error && data === null && <p>Loading…</p>}
      {data?.truncated && <p>Only the first 1,000 activities are shown. Narrow the filter to see the rest.</p>}
      <table aria-labelledby="calendar-grid-heading">
        <thead>
          <tr>
            {DAYS.map(([short, full]) => (
              <th key={short} scope="col">
                <abbr title={full}>{short}</abbr>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0]}>
              {week.map((d) => (
                <td key={d} data-date={d} className={view === "month" && d.slice(0, 7) !== anchor.slice(0, 7) ? "gcpe-other-month" : undefined}>
                  <span className="gcpe-day">{view === "month" ? Number(d.slice(8)) : `${shortMonth(d)} ${Number(d.slice(8))}`}</span>
                  <ul>
                    {(byDay.get(d) ?? []).map((i) => (
                      <li key={i.id}>{itemText(i, d)}</li>
                    ))}
                  </ul>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
```

`minId` takes `{ id, ministryAbbreviation }`, which `CalendarItem` has.

In `ActivityListScreen.tsx`:
- read the view and anchor from the URL (before the early returns):
  ```tsx
  const viewParam = params.get("view");
  const view: ListView = viewParam === "month" || viewParam === "week" ? viewParam : "list";
  const setParam = (name: string, value: string | null) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (value === null) n.delete(name);
      else n.set(name, value);
      return n;
    });
  ```
- after the `List actions` section, add `<ViewSwitch view={view} onChange={(v) => setParam("view", v === "list" ? null : v)} />`;
- render the table only for the list view, and the grid otherwise:
  ```tsx
      {view === "list" ? (
        <ActivityTable query={query} hidden={prefs.hiddenColumns} timeZone={config.timeZone} reloadToken={reloadToken} onSort={(sort, dir) => setQuery({ ...query, sort, dir })} tools={tools} />
      ) : (
        <CalendarGrid query={query} view={view} anchor={params.get("on") ?? todayIn(config.timeZone)} timeZone={config.timeZone} onAnchor={(d) => setParam("on", d)} />
      )}
  ```
- a malformed `on` falls back to today: replace `params.get("on") ?? todayIn(config.timeZone)` with `onParam` computed as `/^\d{4}-\d{2}-\d{2}$/.test(params.get("on") ?? "") ? params.get("on")! : todayIn(config.timeZone)`.

Append to `global.css`:

```css
.gcpe-calendar-grid table {
  table-layout: fixed;
  width: 100%;
  border-collapse: collapse;
}
.gcpe-calendar-grid td {
  border: 1px solid #d8d8d8;
  vertical-align: top;
  height: 6rem;
  padding: 0.25rem;
}
.gcpe-calendar-grid .gcpe-other-month {
  background: #f5f5f5;
}
.gcpe-calendar-grid ul {
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: 0.8rem;
}
.gcpe-view-button[aria-pressed="true"] {
  font-weight: 700;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web`
Then both `tsc` commands.
Expected: PASS.

- [ ] **Step 5: Run the affected e2e specs**

Run the Task 1 Step 10 command. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/staff-web
git commit -m "feat(staff-web): month and week views of the list's filter"
```

---

### Task 5: End to end: every role's visibility, the list's journeys and axe; parity, notes, runbook, carry-forward and deploy

Covers: spec §3 row 5d (axe on every state; a visibility e2e for each role), §16 acceptance items 1, 2 (the list, quick search by id and the Excel export halves), 12 (Review selected and Clear LA Status refused below their threshold, already pinned on the server in 5c-1; the UI half here) and 18; §14 (C127, C139, C141, C151, C154 and new rows C172, C173, C175 and C176). Decision D30.

**Files:**
- Modify: `apps/core/src/services/seed-test-users.ts`, `apps/core/src/services/seed-test-users.test.ts`, `tests/e2e/constants.ts`, `scripts/siteground-seed-users.sh`.
- Create: `tests/e2e/calendar-list.spec.ts`.
- Modify: `tests/e2e/axe-sweep.spec.ts`.
- Modify: `docs/parity/changes-from-legacy.md`, `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`, `docs/superpowers/plans/phase-5-carry-forward.md`.

**Interfaces:**
- Consumes: every route of 5d-1, 5c and 5b; `readXlsx` (`apps/calendar/test/xlsx-read.ts`); the e2e helpers.
- Produces: the seeded users `cal-advanced@example.test`, `cal-hq-editor@example.test`, `cal-hq-advanced@example.test`, and constants `CAL_ADVANCED_EMAIL`, `CAL_HQ_EDITOR_EMAIL`, `CAL_HQ_ADVANCED_EMAIL`.

- [ ] **Step 1: Seed the three users**

In `apps/core/src/services/seed-test-users.ts`, add to `TEST_USERS` after `cal-readonly`:

```ts
  { email: "cal-advanced@example.test", displayName: "Test Calendar Advanced", roles: [], calendar: { role: "Calendar.Advanced", organizationKeys: ["health"] } },
  { email: "cal-hq-editor@example.test", displayName: "Test Calendar HQ Editor", roles: [], calendar: { role: "Calendar.Editor", organizationKeys: ["gcpe-headquarters"] } },
  { email: "cal-hq-advanced@example.test", displayName: "Test Calendar HQ Advanced", roles: [], calendar: { role: "Calendar.Advanced", organizationKeys: ["gcpe-headquarters"] } },
```

In `apps/core/src/services/seed-test-users.test.ts`, extend the loop list in "skips Calendar access when an organization is missing…" to `["cal-admin", "cal-sysadmin", "cal-hq-admin", "cal-editor", "cal-readonly", "cal-advanced", "cal-hq-editor", "cal-hq-advanced"]`.

In `tests/e2e/constants.ts`, add to `TEST_USER_PASSWORDS`:

```ts
  "cal-advanced@example.test": "e2e-cal-advanced-password-1",
  "cal-hq-editor@example.test": "e2e-cal-hq-editor-password-1",
  "cal-hq-advanced@example.test": "e2e-cal-hq-advanced-password-1",
```

and the constants:

```ts
export const CAL_ADVANCED_EMAIL = "cal-advanced@example.test";
export const CAL_HQ_EDITOR_EMAIL = "cal-hq-editor@example.test";
export const CAL_HQ_ADVANCED_EMAIL = "cal-hq-advanced@example.test";
```

In `scripts/siteground-seed-users.sh`, update the header comment to "the eight cal-*@example.test users", and add after the existing `seed cal-readonly…` line:

```bash
seed cal-advanced@example.test "Test Calendar Advanced" ""
seed cal-hq-editor@example.test "Test Calendar HQ Editor" ""
seed cal-hq-advanced@example.test "Test Calendar HQ Advanced" ""
```

and after the existing `calendar_access cal-readonly…` line:

```bash
calendar_access cal-advanced@example.test Calendar.Advanced health
calendar_access cal-hq-editor@example.test Calendar.Editor gcpe-headquarters
calendar_access cal-hq-advanced@example.test Calendar.Advanced gcpe-headquarters
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/core/src/services/seed-test-users.test.ts tests/siteground-seed-users.test.ts`
Expected: PASS (if `tests/siteground-seed-users.test.ts` pins the user count or list, update it to the eight Calendar users).

- [ ] **Step 2: The end-to-end spec**

`tests/e2e/calendar-list.spec.ts`:

```ts
// The 5d exit check: every role sees exactly what the visibility rule allows, in the list, its id
// search and the Excel export; the list's journeys work end to end; axe passes on every state
// visited. Setup runs as the HQ Administrator, who is exempt from the 4pm-5pm freeze, so the spec
// runs at any hour.
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { readXlsx } from "../../apps/calendar/test/xlsx-read";
import {
  CAL_ADMIN_EMAIL, CAL_ADVANCED_EMAIL, CAL_EDITOR_EMAIL, CAL_HQ_ADMIN_EMAIL, CAL_HQ_ADVANCED_EMAIL, CAL_HQ_EDITOR_EMAIL, CAL_READONLY_EMAIL,
  CAL_SYSADMIN_EMAIL, TEST_USER_PASSWORDS,
} from "./constants";
import { apiCall, baseUrl, expectNoSeriousA11yViolations, loginForCookie } from "./playwright-support";

type Key = "A" | "B" | "C" | "D" | "E" | "F";
interface Fixture {
  tag: string;
  ids: Record<Key, number>;
  category: number;
  city: number;
  health: number;
  finance: number;
}

const login = (email: string) => loginForCookie(email, TEST_USER_PASSWORDS[email]!);
async function useCookie(context: BrowserContext, cookie: string): Promise<void> {
  await context.clearCookies();
  const [name, value] = cookie.split("=", 2) as [string, string];
  await context.addCookies([{ name, value, domain: new URL(baseUrl()).hostname, path: "/", httpOnly: true, secure: false, sameSite: "Lax" }]);
}
const listUrl = (q: object, extra = "") => `${baseUrl()}/hub/calendar?q=${encodeURIComponent(JSON.stringify(q))}${extra}`;
const titles = (page: Page) => page.locator(".gcpe-activity-title");
const MAY = { from: "2031-05-01", to: "2031-05-31" };

function input(f: Pick<Fixture, "category" | "city">, o: { title: string; ministry: "health" | "finance"; contact: number; time: string; date?: string; confidential?: boolean; shared?: string[] }) {
  return {
    categoryId: f.category, title: o.title, details: "", significance: "", strategy: "", schedule: "", comments: "", leadOrganization: "", venue: "", otherCity: "", potentialDates: "",
    isIssue: false, isConfidential: o.confidential ?? false, isMilestone: false, isCrossGovernment: false, isAtLegislature: false, isAllDay: false, isConfirmed: true,
    startDate: o.date ?? "2031-05-14", startTime: o.time, endDate: o.date ?? "2031-05-14", endTime: `${String(Number(o.time.slice(0, 2)) + 1).padStart(2, "0")}:00`, nrDate: null, nrTime: null,
    contactMinistryKey: o.ministry, commContactId: o.contact, governmentRepresentativeId: null, cityId: f.city, premierRequestedId: null,
    nrDistributionId: null, eventPlannerId: null, videographerId: null, nrOriginId: null,
    commMaterialIds: [], initiativeIds: [], keywordNames: [], sectorKeys: [], themeKeys: [], tagKeys: [], sharedWithKeys: o.shared ?? [], translations: [],
  };
}

let cached: Fixture | null = null;
/** Six activities on 2031-05-14: A Health, B Health confidential, C Finance, D Finance confidential, E Finance confidential shared with Health, F Health deleted. */
async function fixture(): Promise<Fixture> {
  if (cached) return cached;
  const stamp = Date.now();
  const tag = `vis${stamp}`;
  const sys = await login(CAL_SYSADMIN_EMAIL);
  const admin = await login(CAL_ADMIN_EMAIL);
  const hq = await login(CAL_HQ_ADMIN_EMAIL);
  const editorId = (await apiCall<{ userId: string }>(await login(CAL_EDITOR_EMAIL), "/calendar/api/me")).userId;
  const readOnlyId = (await apiCall<{ userId: string }>(await login(CAL_READONLY_EMAIL), "/calendar/api/me")).userId;
  await apiCall(admin, `/calendar/api/users/${editorId}/comm-contacts/health`, { method: "PUT", body: { rank: 4 } });
  await apiCall(hq, `/calendar/api/users/${readOnlyId}/comm-contacts/finance`, { method: "PUT", body: { rank: 4 } });
  // Not Awareness (2, hidden by default) and not a release category (12, 58).
  let category = await apiCall<{ id: number }>(sys, "/calendar/api/lookups/categories", { method: "POST", body: { name: `E2E list category ${stamp}` } });
  while ([2, 12, 58].includes(category.id)) category = await apiCall<{ id: number }>(sys, "/calendar/api/lookups/categories", { method: "POST", body: { name: `E2E list category ${stamp}-${category.id}` } });
  const city = await apiCall<{ id: number }>(sys, "/calendar/api/lookups/cities", { method: "POST", body: { name: `E2E list city ${stamp}` } });
  const contacts = await apiCall<{ id: number; label: string }[]>(hq, "/calendar/api/transfer/comm-contacts");
  const health = contacts.find((c) => c.label === "Test Calendar Editor (HLTH)")!.id;
  const finance = contacts.find((c) => c.label === "Test Calendar Read Only (FIN)")!.id;
  const f = { category: category.id, city: city.id };
  const make = async (key: Key, o: { ministry: "health" | "finance"; time: string; confidential?: boolean; shared?: string[] }) =>
    (await apiCall<{ id: number }>(hq, "/calendar/api/activities", { method: "POST", body: input(f, { ...o, title: `Vis ${key} ${tag}`, contact: o.ministry === "health" ? health : finance }) })).id;
  const ids: Record<Key, number> = {
    A: await make("A", { ministry: "health", time: "09:00" }),
    B: await make("B", { ministry: "health", time: "10:00", confidential: true }),
    C: await make("C", { ministry: "finance", time: "11:00" }),
    D: await make("D", { ministry: "finance", time: "12:00", confidential: true }),
    E: await make("E", { ministry: "finance", time: "13:00", confidential: true, shared: ["health"] }),
    F: await make("F", { ministry: "health", time: "14:00" }),
  };
  const view = await apiCall<{ version: number }>(hq, `/calendar/api/activities/${ids.F}`);
  await apiCall(hq, `/calendar/api/activities/${ids.F}`, { method: "DELETE", body: { version: view.version } });
  cached = { tag, ids, ...f, health, finance };
  return cached;
}

const ROLES: [string, string, Key[]][] = [
  ["Read Only (Finance)", CAL_READONLY_EMAIL, ["C", "D", "E"]],
  ["Editor (Health)", CAL_EDITOR_EMAIL, ["A", "B", "E"]],
  ["Advanced (Health)", CAL_ADVANCED_EMAIL, ["A", "B", "E"]],
  ["Administrator (Health)", CAL_ADMIN_EMAIL, ["A", "B", "E"]],
  ["System Administrator (Health)", CAL_SYSADMIN_EMAIL, ["A", "B", "E"]],
  ["HQ Editor", CAL_HQ_EDITOR_EMAIL, ["A", "C"]],
  ["HQ Advanced", CAL_HQ_ADVANCED_EMAIL, ["A", "B", "C", "D", "E"]],
  ["HQ Administrator", CAL_HQ_ADMIN_EMAIL, ["A", "B", "C", "D", "E", "F"]],
];

test.describe("the Calendar list: visibility for each role (spec addendum §6)", () => {
  for (const [role, email, keys] of ROLES) {
    test(`${role} sees exactly what the visibility rule allows`, async ({ page, context }) => {
      const f = await fixture();
      await useCookie(context, await login(email));
      await page.goto(listUrl({ filter: { ...MAY, quickSearch: f.tag } }));
      await expect(titles(page)).toHaveText(keys.map((k) => `Vis ${k} ${f.tag}`));
      await expectNoSeriousA11yViolations(page, `the list as ${role}`);
    });
  }

  test("an id search and the Excel export stay inside visibility (C127, C151)", async ({ page, context }) => {
    const f = await fixture();
    const hqEditor = await login(CAL_HQ_EDITOR_EMAIL);
    await useCookie(context, hqEditor);
    await page.goto(listUrl({ filter: { quickSearch: `FIN-${f.ids.D}` } }));
    await expect(page.getByText("No activities match.")).toBeVisible();
    const res = await fetch(`${baseUrl()}/calendar/api/list/export.xlsx?q=${encodeURIComponent(JSON.stringify({ filter: { ...MAY, quickSearch: f.tag } }))}`, { headers: { cookie: hqEditor } });
    expect(res.status).toBe(200);
    const { cells } = readXlsx(Buffer.from(await res.arrayBuffer()));
    expect([...cells].filter(([ref]) => /^E\d+$/.test(ref) && ref !== "E2").map(([, v]) => v)).toEqual([`Vis A ${f.tag}`, `Vis C ${f.tag}`]);
    await useCookie(context, await login(CAL_READONLY_EMAIL));
    await page.goto(listUrl({ filter: { quickSearch: `FIN-${f.ids.D}` } }));
    await expect(titles(page)).toHaveText([`Vis D ${f.tag}`]);
  });
});

test.describe("the Calendar list: journeys", () => {
  test("a ministry editor saves, runs, renames and deletes a query, watches an activity, hides a column and exports", async ({ page, context }) => {
    const f = await fixture();
    await useCookie(context, await login(CAL_EDITOR_EMAIL));
    await page.goto(listUrl({ filter: { ...MAY, quickSearch: f.tag } }));
    await expect(titles(page)).toHaveCount(3);
    const queries = page.getByRole("region", { name: "My Queries" });
    await queries.getByLabel("Name for this filter").fill(`Sample query ${f.tag}`);
    await queries.getByRole("button", { name: "Save query" }).click();
    await expect(queries.getByRole("status")).toHaveText(`Saved the query “Sample query ${f.tag}”.`);
    await page.goto(`${baseUrl()}/hub/calendar`);
    await queries.getByRole("button", { name: `Sample query ${f.tag}` }).click();
    await expect(titles(page)).toHaveText([`Vis A ${f.tag}`, `Vis B ${f.tag}`, `Vis E ${f.tag}`]);
    await queries.getByRole("button", { name: `Rename Sample query ${f.tag}` }).click();
    await expectNoSeriousA11yViolations(page, "My Queries, renaming");
    await queries.getByLabel("New name").fill(`Renamed ${f.tag}`);
    await queries.getByRole("button", { name: "Save name" }).click();
    await expect(queries.getByRole("status")).toHaveText(`Renamed to “Renamed ${f.tag}”.`);
    await queries.getByRole("button", { name: `Delete Renamed ${f.tag}` }).click();
    await expect(queries.getByRole("status")).toHaveText(`Deleted the query “Renamed ${f.tag}”.`);

    const star = page.getByRole("button", { name: `Watch HLTH-${f.ids.A}` });
    await star.click();
    await expect(star).toHaveAttribute("aria-pressed", "true");
    await page.goto(listUrl({ filter: { ...MAY, quickSearch: f.tag }, display: "my_watchlist" }));
    await expect(titles(page)).toHaveText([`Vis A ${f.tag}`]);
    await page.getByRole("button", { name: `Watch HLTH-${f.ids.A}` }).click();

    await page.goto(listUrl({ filter: { ...MAY, quickSearch: f.tag } }));
    await page.getByText("Columns", { exact: true }).click();
    await page.getByRole("checkbox", { name: "City", exact: true }).uncheck();
    await expect(page.getByRole("columnheader", { name: "City", exact: true })).toHaveCount(0);
    await page.reload();
    await expect(titles(page)).toHaveCount(3);
    await expect(page.getByRole("columnheader", { name: "City", exact: true })).toHaveCount(0);
    await page.getByText("Columns", { exact: true }).click();
    await page.getByRole("checkbox", { name: "City", exact: true }).check();
    await expect(page.getByRole("columnheader", { name: "City", exact: true })).toHaveCount(1);

    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Excel export" }).click()]);
    expect(download.suggestedFilename()).toBe("BCGovernmentActivities.xlsx");
  });

  test("an HQ Administrator reviews selected rows, skipping one changed meanwhile, clears LA status, and runs a corporate query", async ({ page, context }) => {
    const f = await fixture();
    const hq = await login(CAL_HQ_ADMIN_EMAIL);
    const rev = `rev${Date.now()}`;
    const make = async (key: string, time: string) =>
      (await apiCall<{ id: number }>(hq, "/calendar/api/activities", { method: "POST", body: input(f, { title: `Rev ${key} ${rev}`, ministry: "health", contact: f.health, time, date: "2031-06-10" }) })).id;
    const g = await make("G", "09:00");
    const h = await make("H", "10:00");
    await useCookie(context, hq);
    await page.goto(listUrl({ filter: { from: "2031-06-01", to: "2031-06-30", quickSearch: rev } }));
    await expect(titles(page)).toHaveCount(2);
    await page.getByRole("checkbox", { name: `Select HLTH-${g}` }).check();
    await page.getByRole("checkbox", { name: `Select HLTH-${h}` }).check();
    // H changes after the list loaded.
    const view = await apiCall<{ version: number; fields: object }>(hq, `/calendar/api/activities/${h}`);
    await apiCall(hq, `/calendar/api/activities/${h}`, { method: "PUT", body: { ...view.fields, title: `Rev H changed ${rev}`, version: view.version, tabId: null } });
    await page.getByRole("button", { name: "Review selected (2)" }).click();
    await expect(page.getByText(`Reviewed 1 activity. 1 skipped because it changed since the list loaded: HLTH-${h}.`)).toBeVisible();
    await expectNoSeriousA11yViolations(page, "after Review selected");

    await page.getByLabel("Days ahead").fill("0");
    await page.getByRole("button", { name: "Clear LA Status" }).click();
    await expect(page.getByText(/^Cleared the LA status of \d+ activit(y|ies)\.$/)).toBeVisible();

    const corp = page.getByRole("region", { name: "Corporate Queries" });
    await corp.getByLabel("Show all").check();
    await corp.getByRole("button", { name: "Search" }).click();
    await expect(corp.getByText("Showing a corporate query.")).toBeVisible();
    await expect(page.getByText(/^Showing \d+ of \d+ activit(y|ies)\.$/)).toBeVisible();
    await expectNoSeriousA11yViolations(page, "a corporate query");
    await corp.getByRole("button", { name: "Back to the filter" }).click();

    await page.goto(listUrl({ filter: { ...MAY, quickSearch: f.tag } }));
    await page.getByRole("group", { name: "Look Ahead filter" }).getByLabel("Not for Look Ahead Only").check();
    await expect(titles(page)).toHaveText([`Vis B ${f.tag}`, `Vis D ${f.tag}`, `Vis E ${f.tag}`]);
  });

  test("the month and week views show the filter's activities", async ({ page, context }) => {
    const f = await fixture();
    await useCookie(context, await login(CAL_EDITOR_EMAIL));
    await page.goto(listUrl({ filter: { quickSearch: f.tag } }, "&view=month&on=2031-05-01"));
    await expect(page.getByRole("heading", { level: 2, name: "May 2031" })).toBeVisible();
    await expect(page.locator('td[data-date="2031-05-14"]').getByText(`HLTH-${f.ids.A} 9:00 AM Vis A ${f.tag}`)).toBeVisible();
    await expect(page.locator('td[data-date="2031-05-14"] li')).toHaveCount(3);
    await expectNoSeriousA11yViolations(page, "the month view");
    await page.goto(listUrl({ filter: { quickSearch: f.tag } }, "&view=week&on=2031-05-14"));
    await expect(page.getByRole("heading", { level: 2, name: "Week of May 11, 2031" })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "the week view");
  });
});
```

In `tests/e2e/axe-sweep.spec.ts`, add (import `CAL_HQ_ADMIN_EMAIL`):

```ts
  // The list with every HQ tool, and its month view.
  test("the Calendar list as an HQ Administrator, and its month view", async ({ page, context }) => {
    const cookie = await loginForCookie(CAL_HQ_ADMIN_EMAIL, TEST_USER_PASSWORDS[CAL_HQ_ADMIN_EMAIL]!);
    const [name, value] = cookie.split("=", 2) as [string, string];
    await context.addCookies([{ name, value, domain: new URL(baseUrl()).hostname, path: "/", httpOnly: true, secure: false, sameSite: "Lax" }]);
    for (const path of ["/hub/calendar", "/hub/calendar?view=month"]) {
      await gotoAndWaitForH1(page, path);
      await expectNoSeriousA11yViolations(page, path);
    }
  });
```

- [ ] **Step 3: Run the e2e suite**

Run: `npx -y -p node@24 -- npm run test:e2e`
Expected: PASS, all specs. If a role's titles differ, the server's `visibleSql` and §6 disagree; read §6's matrix before changing an expectation.

- [ ] **Step 4: Parity rows**

`docs/parity/changes-from-legacy.md`, "Corporate Calendar (Phase 5)":
- C127's Status: "Agreed (rule built in 5c-1; the list, its id search and the Excel export in 5d; other readers in 5e–5i)".
- C139's Status: add "; list buttons in 5d".
- Add C141, C151 and C154 from spec §14 with Status "Agreed (built in 5d)".
- Leave C174, C177 and C178 as they are: 5d-1 added them.
- Add:

```markdown
| C172 | Quick search matched the Executive Summary (`HqComments`) for everyone (`ActivityDAO.cs:101-117`). | It matches the Executive Summary only for users who see the Look Ahead fieldset. | The field is HQ-only on screen and in history; a search hit would reveal it. | Proposed |
| C173 | The list's details: display and hidden columns saved on every list load; the Comm Contact filter matched active contacts only; My Activities also required the user's own ministries; the id search took the number after the last "-"; the Govt Rep column prefixed "Premier," and Premier showed "Premier Reqstd". | Display and columns save when changed; the Comm Contact filter matches the person, inactive contacts included; My Activities is "my comm contact", any ministry; "ABBR-123" searches any id, a bare number only above 10,000; the Premier prefix and wording follow the lookup's own values. The Awareness and consultations hides apply until a filter names them, except on My Watchlist. | Finding a departed contact's work; the spec's "as comm contact"; legacy's prefixes depended on lookup values outside the code. | Proposed |
| C175 | Saved queries kept display, This day only and the Look Ahead setting, but running one never applied them (`Default.aspx:426-488`). | Imported queries drop those three, and any value that no longer maps, and the import report lists each drop. | They never took effect; keeping them would change what an old query shows. | Proposed |
| C176 | The watchlist star was set on the activity page only. | It also toggles from the list's Activity Id cell. | The activity page arrives in 5e; the list needs My Watchlist to be usable now. | Proposed |
```

- [ ] **Step 5: Running notes**

Append to `docs/manuals/running-notes.md`:

```markdown
## Phase 5d — The activity list

- **All Calendar users** — Hub → Calendar opens the activity list: today onward by default, 30 at a
  time (more load as you scroll, or with "Show more"). Filter by dates, words, HQ Tags, Issue, Date
  Confirmed, Status, Category, Lead Ministry, Comm Contact, Representative, Initiative, Premier
  Requested and Distribution; choose Show All, My Ministries, My Activities or My Watchlist.
- **All Calendar users** — Type an activity number such as HLTH-12345 in "Search for" to go
  straight to it. A bare number up to 10,000 is searched as a word.
- **All Calendar users** — Awareness dates and the consultations ministry are hidden until you pick
  that category or ministry in the filter. They show on My Watchlist.
- **All Calendar users** — Columns: choose which show; your choice and your display are kept.
  The link in the address bar keeps your filter: bookmark it or send it to a colleague.
- **All Calendar users** — My Queries: save the current filter, run it, rename it, move it and
  delete it. Only you see your queries. Saving works during the 4pm-5pm freeze.
- **All Calendar users** — The star watches an activity; its tooltip lists who else watches it.
- **All Calendar users** — Excel export downloads what the list shows (up to 10,000 activities),
  with the old header, columns and confidentiality footer.
- **All Calendar users** — Month and Week show the same filter as a calendar.
- **HQ Administrator** — Tick rows and Review selected. Rows someone changed since your list loaded
  are skipped and named. If the screen says only some were reviewed, select the rest and run it again.
- **HQ Editor and above** — Clear LA Status for the next N days (8 by default).
- **HQ Advanced and above** — Corporate Queries and the Look Ahead filter.
- **HQ Advanced and above** — Searching the Executive Summary only finds it for users who can see
  that field.
```

- [ ] **Step 6: Runbook**

`docs/deploy/siteground.md`, under "Corporate Calendar", add `### Activity list (Phase 5d)`:
- **No migration.**
- **Seeded users:** run `scripts/siteground-seed-users.sh https://boxs.ca` again to add `cal-advanced`, `cal-hq-editor` and `cal-hq-advanced` (it prompts for every seeded password).
- **Hand checks:**
  1. As cal-editor: Hub → Calendar shows the list with today onward. Time the first load and a "Show more" with the browser's network panel; record both beside 5d-1's measured numbers in `docs/superpowers/plans/2026-10-08-phase-5d-list-performance.md`.
  2. Save a query, reload, run it; rename and delete it.
  3. Excel export: open the downloaded file in Excel. The header row, 16 columns and red footer show; no repair prompt.
  4. As cal-hq-admin: tick two rows, Review selected; Corporate Queries → Show all → Search.
  5. Month and Week views show activities on their days.

- [ ] **Step 7: Carry-forward**

In `docs/superpowers/plans/phase-5-carry-forward.md`:
- Delete § 5d and its heading.
- Add to § 5e:
  - "**Titles link to the activity page** from the list's Title cell and the calendar view's items (`apps/staff-web/src/screens/calendar/list/cells.tsx`, `CalendarGrid.tsx`); return to the list's own URL (`?q=`) after save (C149)."
  - "**The activity page's watchlist star** uses `PUT`/`DELETE /calendar/api/activities/:id/watch` and shows the watchers' names, as the list's `WatchStar` does."
- Add to § 5g: "**Report buttons in the list's toolbar** (`ActivityListScreen`'s List actions) take the list's current `ListQuery` as `q`, as the Excel export does; dates use `friendlyDateRange` from `@gcpe/calendar-contract`, which the export already uses."
- Add to § 5i:
  - "**Saved queries:** call `migrateLegacySavedFilters` (`apps/calendar/src/list/legacy-filters.ts`) with resolvers backed by Core's organizations and `user_legacy_ids`, and put its report in the import report."
  - "**List preferences:** for each imported user, write `user_profiles.list_display` with `legacyDisplay(FilterDisplayValue)` and `hidden_columns` with `legacyHiddenColumns(HiddenColumns)`, both together: a null `list_display` means no choice yet."

- [ ] **Step 8: Final verification**

Run, under Node 24:
- the whole Vitest suite;
- both `tsc` commands;
- `npm run test:e2e`.

Then:
- `git diff feat/phase-5c | grep -oE "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+" | sort -u` shows only `example.test`, `x.invalid`, `example.com` or `example.gov.bc.ca`.
- `git diff feat/phase-5c -- apps packages scripts tests | grep -nE "Task [0-9]|\bD[0-9]+\b|fix round"` prints nothing.
- `git diff feat/phase-5c -- apps | grep -nE "console\.(log|debug)"` prints nothing.

- [ ] **Step 9: Commit**

```bash
git add apps/core scripts tests docs
git commit -m "test(e2e),docs: the list's visibility for every role, its journeys and axe; three seeded Calendar users; parity C127 C139 C141 C151 C154 C172 C173 C175 C176"
```

- [ ] **Step 10: Deploy and hand checks**

1. Deploy `feat/phase-5d` to boxs.ca (`npm run deploy:siteground`, then the printed push).
2. Check `/stack/health`.
3. Do Step 6's hand checks if `gcpe_calendar` exists there. Seeding the three new users needs the seed script's interactive password prompts; if they can't be answered, mark those checks as waiting on Paul.

---

## Risks and things to watch

- **`IntersectionObserver` in the real browser.** jsdom has none, so the unit tests exercise only the "Show more" button. *Assumed* the observer fires near the table's end in Chromium; Task 5's journeys don't scroll past 30 rows. If it misfires, the button still works.
- **The BC design-system `Button` and `aria-label`.** *Assumed* it passes `aria-label` to the DOM (react-aria's `Button` does). Task 2's test asserts the names ("Rename Sample one"), so a dropped label fails loudly.
- **`fieldset role="group"` for the Look Ahead filter.** A `fieldset` is already a group; the explicit role and `aria-labelledby` make `getByRole("group", { name: "Look Ahead filter" })` reliable. *Verified* by Task 3's test.
- **The e2e database is shared by every spec.** The visibility tests filter by a per-run tag, so other specs' activities never appear. The corporate-query check asserts only that rows come back, because every spec's upcoming activities qualify.
- **Clear LA Status in the e2e touches every visible activity starting by today.** No other spec reads LA status today; if one does later, it must set its own.
- **Seeding three users on boxs.ca needs passwords typed by a person.** Until then the boxs.ca hand checks run as the existing five users.

## Self-review (done while writing)

- **Spec coverage (5d, screen half):**
  - **§8.1 Filters, Display, quick search:** Task 1 (`FilterPanel`, with the hint for id search).
  - **§8.1 Columns:** Task 1 (cells for every column; the Activity Id cell's watched, reviewed, shared and release marks, `MIN-Id`, "updated X ago by", "created"); column choice saved (Task 1).
  - **§8.1 Sorting and loading:** Task 1 (sort buttons with `aria-sort`; 30 at a time on scroll and by button).
  - **§8.1 Saved filters:** Task 2. **Watchlist:** Task 2. **Calendar view:** Task 4. **Corporate queries** and **Look Ahead admin filter:** Task 3. **Toolbar:** Review selected, Clear LA Status, Excel export (Task 3); reports are 5g's (carry-forward). **Excel export:** Task 3 and Task 5's end-to-end check.
  - **§7.4:** the standing freeze notice (Task 1).
  - **§6:** each tool shown by the server's own flags (Task 3); visibility for every role end to end (Task 5).
  - **§3 row 5d exit:** axe on every state (each task's `a11y.test.tsx` additions, plus Task 5's e2e checks and the sweep); a visibility e2e per role (Task 5). The saved-filter fixture and the 500 ms measurement are 5d-1's.
  - **§14:** C127, C139, C141, C151, C154, C172, C173, C175 and C176 (Task 5).
  - **Carry-forward:** the three staff-web items (Tasks 1, 3).
- **Placeholders:** none. Steps that edit an existing file name the exact lines to add or replace: Task 1 Step 7 (router and the section's axe test), Tasks 2–4's screen wiring, Task 5 Steps 1, 4, 6 and 7.
- **Type consistency:**
  - `TableTools` (Task 1) is what Tasks 2 and 3 fill (`renderStar`, `selected`, `onSelect`).
  - `listApi`'s methods match 5d-1's routes and the contract types; `ReviewSelectedResult` and `ClearLaStatusResult` match `apps/calendar/src/activities/bulk.ts`.
  - `minId` takes `{ id, ministryAbbreviation }`, which both `ListRow` and `CalendarItem` carry.
  - `ListView` (Task 1's `types.ts`) is what `ViewSwitch` and the screen use (Task 4).
- **Review Focus:** each line names its pinning test, and each test is in its task's code: Task 1 (1, 3, 4), Task 2 (4), Task 3 (2, 5), Task 5 (2).
