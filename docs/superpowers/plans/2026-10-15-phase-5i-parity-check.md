# Phase 5i (parity half): The Report Parity Check Against Legacy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm run calendar:report-parity` takes legacy's survey-08 Part B CSV export and four legacy report PDFs. It imports the CSV snapshot into throwaway Core and Calendar databases, renders our four reports for the same ranges and filter as an HQ System Administrator, and compares each pair section by section and row by row. All outputs are written to a private folder outside the repository. The last task runs it on the real June 2026 inputs. Each difference is then explained by a C-row or fixed.

**Architecture:**
- **A CSV snapshot source** (`apps/calendar/src/import/csv-snapshot.ts`, pure). It decodes each file (UTF-8, or Windows-1252 when the bytes aren't valid UTF-8) and parses RFC 4180 CSV. It splits the files into sections by their `query` label, checks each section's header and its Part C count, and builds the same `LegacySnapshot` that `load.ts` builds from SQL Server. Tables the export didn't query are listed in a new `provenance` field, so the import report says "not provided" instead of counting zero rows.
- **The importer takes a snapshot in place of a source** (`run.ts`, one line of behaviour). The report gains a `notProvided` list. Those tables leave the balance, and the facts that depend on them are omitted.
- **Row text in the comparison** (`scripts/calendar-report-compare.ts`). Next to the existing outline (sections, day headings and activity ids), each activity row's text is extracted, with whitespace normalised. It is compared by activity id and occurrence, and written privately with word-level changes. This is §12.3's "row text" leg.
- **The runner** (`scripts/calendar-report-parity.ts`):
  1. Creates throwaway databases with `createTestDatabase`.
  2. Seeds Core's organisations, sectors, themes and tags with the legacy GUIDs from 8.43–8.46, through Core's own services.
  3. Imports the snapshot with `runCalendarImport`.
  4. Projects Core into the Calendar through Core's `republishAll` and the Calendar's `projectionHandler`, in process.
  5. Renders each report in process (`reportData` → `buildReport` → `renderPdf`), with `now` set to the legacy PDF's creation time.
  6. Runs `compareReports` for each pair.
  7. Drops the databases in `finally`.
- **The run** (Task 4) is done by the controller on the real files, under the data rules below. It produces:
  - a private differences report;
  - a sanitised summary in the repo, with counts and categories only;
  - C-rows or fixes.

**Tech Stack:** Node 24, TypeScript 5.9, Drizzle 0.45 on Postgres, zod 3.25, `unpdf` (pdf.js) for reading PDFs, pdfmake through the existing renderer, Vitest 4.1, tsx.

**Spec:** `docs/superpowers/specs/2026-10-07-calendar-parity-design.md`:
- §12.3, the report parity check: what it builds, compares and needs, and when it passes.
- §3, the 5i row: "On a legacy snapshot (Q50), every report matches legacy's for a date range after the cutoff".
- §16 acceptance 17.
- §15 Q50, plus §12.1 for the importer this reuses.

Read with:
- `docs/superpowers/plans/phase-5-carry-forward.md` "## 5i parity check": binding. Task 4 settles its four items and rewrites the section.
- `docs/parity/legacy-report-layouts.md` ("Discrepancies to flag precisely").
- The 08 SQL v2 on `origin/fix/sql-08-v2` (`git show origin/fix/sql-08-v2:docs/parity/legacy-survey/08-calendar-parity.sql`), which fixes the CSV shapes.

## Global Constraints

- **Worktree and commits:**
  - Work on `feat/5i-parity` in `/Users/paul/gcpe-news-platform-5i`. Commit locally after each task, with a plain message. Don't push until the branch is reviewed.
  - **Never add `Co-Authored-By` or any AI attribution** to a commit. Never commit `CLAUDE.md`.
  - **No task, decision or round labels in code comments** ("Task 3", "R7", "fix round 1"). Spec row ids (C134, Q50) and legacy file references are fine.
- **Node 24 for everything.** The default shell `node` here is v22; `/usr/local/bin/node` is v24.
  - Tests: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run <paths>`.
  - Type-check: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`.
  - Scripts: `npx -y -p node@24 -- npm run <script> -- <args>`.
- **Every behaviour change starts with a real RED run:** run the new test, see it fail for the stated reason, then implement.
- **No debug logging.** Logs carry `safeErrorLabel`, counts, file names and section labels only. Never a cell value, a title, a name or an email. Every `CsvSnapshotError` message names a file, a section, a row number and a column, never the cell's value.
- **Real data (Task 4 above all):**
  - The real CSVs and PDFs in `~/Downloads` hold real personal data and confidential activities.
  - **Never print data values.** Print headers, counts and shapes only.
  - **Never copy real data into the repo, a log in the repo, a commit message or a test.** Every run output goes to `~/gcpe-parity-private` (mode 700).
  - The runner refuses an `--out` inside the repository, symlinks followed.
  - Before committing anything in Task 4, run the leak check in Task 4 Step 9.
- **Fictional fixtures only:** `example.test` addresses, "Sample …" names, `0E000000-…` GUIDs, activity ids 41001–41005 in March 2031.
- **Migrations:** drizzle-kit only (`cd apps/<app> && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name <name>`). Never hand-edit generated DDL. **This plan needs none.**
- **`calendar:import` is unchanged for production:** it still reads SQL Server only. The CSV source is reachable only from the parity runner and tests.
- **Parity lists:**
  - New change rows go in `docs/parity/changes-from-legacy.md` from C211 (the highest at `b7eafaa` is C210).
  - New questions go in `docs/parity/open-questions.md` from Q101. Q100 is taken by this plan (see "New open questions").
  - Running-notes lines carry the legend's role tags (`docs/manuals/running-notes.md`).

## Review Focus

1. **A quoted Details field with commas, doubled quotes and CRLF line breaks**, which is how SSMS writes long text. It must stay one field and keep its text exactly. Pinned in Task 1 ("parseCsv keeps quoted commas, quotes and line breaks").
2. **The old v1 export and the new one in the same folder** (`~/Downloads` holds both `08-8.10.csv` and `08-8.10 1.csv`). Passing both must fail on the repeated label, never merge them. Pinned in Task 1 ("a section in two files is refused").
3. **Survey 08's Part A file passed by mistake.** Its labels 8.1, 8.2 and 8.3 would normalise to 8.10, 8.20 and 8.30; the header check must refuse it. Pinned in Task 1 ("a section whose header lacks its columns is refused").
4. **A bad cell in real data:** an impossible date, or text in an id column. The error must name where it is and never what it is, because the message reaches the terminal. Pinned in Task 1 ("errors name the place, never the value").
5. **A run that fails half-way** (a missing PDF, an unbalanced import). It must still drop both throwaway databases, which then hold real data, and say so. It must also never write outside `--out`. Pinned in Task 3 ("a failed run still drops its databases").

## Rulings (planner's, against the code at `b7eafaa` and the real files' shapes)

Checked while planning, on the real files, counts and shapes only:
- `08-8.10 1.csv` and `08-8.30-08-8.46.csv` are Windows-1252; the other two are UTF-8. No file has a BOM. Line endings are CRLF.
- Sections are separated by records whose cells are all empty. The 8.30–8.46 file pads every row to 10 columns, including the header, with empty column names.
- Every section's row count matches Part C: 8.10 948, 8.11 948, 8.12 1,674, 8.13 327, 8.14 4,751, 8.15 472, 8.16 absent and 0 in Part C, 8.17 4,766, 8.18 223, 8.19 967, 8.2 342, 8.46 21.
- Dates read `YYYY-MM-DDTHH:MM:SS.fff` (948 of 948). Booleans are `0` and `1`. 8.10 has no needs-review columns, and `HqStatusId` is NULL on all 948 rows.
- Every ministry, theme and tag GUID resolves in 8.43, 8.45 and 8.46, and every comm contact id in 8.32. Every category, comm material, initiative, keyword and origin id resolves.
- A dry run (`selectScope`, `unknownLegacyKeys` and `mapActivity` on a snapshot built from the real files, in memory) gave:
  - at cutoff 2026-06-01: 948 activities in scope and 0 unknown keys;
  - 948 mapped and none skipped, 114 of them deleted;
  - validation warnings on Significance (81) and Schedule (1);
  - 1,205 comm contacts in scope.

The rulings:

1. **The CSV reader is a module, not a `calendar:import` flag.** `--from-csv` on the production CLI would let a snapshot with no users, history or files feed a real import. The reader is used only by the parity runner and tests.
2. **Encoding is decided per file.** Bytes that decode as strict UTF-8 are UTF-8, with any BOM dropped; anything else is Windows-1252. The runner logs each file's encoding.
3. **Labels are numeric, to two decimals:** `8.2` → `8.20`, `8.1` → `8.10`. A known label's header must hold that section's columns, which stops Part A's 8.1, 8.2 and 8.3 posing as 8.10, 8.20 and 8.30. A label met twice, in one file or two, is an error. Unknown labels (8.41 Status) are ignored and listed.
4. **The literal `NULL` is null; an empty cell is the empty string** (SSMS's convention). A real text value of exactly `NULL` would be misread. Accepted.
5. **A missing section counts as empty only when Part C says 0** (8.16 sectors). Without a Part C file, a missing section is an error. With one, every section's row count must equal Part C's.
6. **The needs-review flags aren't in 8.10.** They import as none, and the import report notes it. The reports don't print them.
7. **Users come from comm contacts, not left empty.** The runner sets `usersFromCommContacts: true`. With users empty, all 1,205 in-scope comm contacts would be skipped ("its user wasn't imported"), and every contact name in the 30-60-90 would differ.
   - **One legacy user per `SystemUserId` in 8.32.** Its name comes from that user's lowest-id contact referenced by a snapshot activity, else the lowest-id active contact, else the lowest-id contact. The 134 referenced users each have one name.
   - Each has no email, no role and is inactive. The report notes that users were derived.
   - `usersFromCommContacts: false` gives the brief's literal behaviour: users empty and reported "not provided".
   - `userMinistries`, `savedFilters`, `favourites`, `files` and `logs` are always reported "not provided".
8. **The importer takes `snapshot` in place of `source`** (a union type). Nothing else in the run changes: the SQL path and its tests are untouched.
9. **In the report, a "not provided" table is listed and left out of `tables` and the balance, not shown as zero.** Facts that depend on it are omitted:
   - user facts when users are missing or derived;
   - history facts when logs are missing.
10. **The cutoff is 2026-06-01**, the range's first day. The dry run puts all 948 in scope. §12.3's rule that the range starts on or after the cutoff holds, and the runner enforces it.
11. **The runner lives in the repo:** `scripts/calendar-report-parity.ts`, as `npm run calendar:report-parity` (the spec's name). Its arguments differ from §12.3's sketch because the snapshot is CSV.
    - It refuses `--out` inside the repository and makes `--out` mode 700.
    - Its databases are `createTestDatabase`'s `test_…`, so `npm run test:clean-dbs` can drop a crash leftover. Both are dropped in `finally` unless `--keep-dbs` is given.
12. **Core is seeded through Core's own services.** `upsertOrganization` and `upsertTerm` take the 8.43–8.46 legacy GUIDs as legacy ids and the legacy `Key`s as keys (11 ministry keys are GUID-shaped; Core keys are free text). Core's `HQ_ABBREVIATIONS` (GCPEHQ, GCPEMEDIA, PREM; each appears once in 8.43) decides `isHqOnCreate`. The template is the fictional `healthOrg`, as `seedCoreForImport` does.
13. **The Calendar's projections are filled in process.** Core's `republishAll` runs, then the Calendar's `projectionHandler` is applied to each envelope in Core's `outbox_events`. These are the real event shapes, with no HTTP and no dispatcher.
14. **Reports are built in process, as a constructed actor.** The actor is `Calendar.SysAdmin`, level 5, HQ, in the GCPEHQ organisation: legacy role 5, GCPEHQ SysAdmin. No session, no HTTP, no worker. `reportData` applies the same visibility as the routes.
15. **`now` is each legacy PDF's `CreationDate`** (2026-10-15, 08:11:59 to 08:14:19 PDT), so the "Updated" line and "updated X ago" agree. `--now` overrides it.
16. **The filter is read from `filters.png`:**
    - From 06/01/2026 To 06/30/2026; To 08/31/2026 for the 30-60-90;
    - "This day only" off; no search text, tags, category or More options;
    - Display "Show All"; the Admin Settings Look Ahead Filter "Show All".

    So `q = listQuerySchema.parse({ filter: { from, to } })`, whose defaults are `display: "all"` and `lookAhead: "all"`. The Corporate Queries panel was not applied. Legacy's list showed 439 activities for June and 836 for June to August.
17. **Release links (8.20) feed only the import's release counts.** No report reads `release_links`: the only readers are `list/rows.ts`'s `hasRelease` and the activity view. The runner doesn't project them.
18. **Row text joins the comparison** (§12.3's "row text with whitespace normalised"):
    - Each line on a page belongs to the nearest activity link at or above it. Lines above a page's first link continue the previous page's last row.
    - Page furniture is dropped: a line, with any trailing "Page N of M" removed, that repeats on at least half the body pages (and on 3 or more).
    - Rows are keyed `id:<n>#<occurrence>`, because the Look Ahead repeats multi-day rows: 483 links for 434 ids in the real file.
19. **`ExeclExport.xls` is not compared.** The Excel export isn't part of §12.3. Task 4 may use its row count as a cross-check only.
20. **The fix policy in Task 4:** a difference is fixed inside Task 4 only when the fix is in the report builders (`apps/calendar/src/reports/`), changes about 30 lines or fewer, and can be pinned by a fictional golden or unit test. Anything bigger becomes a carry-forward item. Every difference not fixed cites a C-row (new ones from C211) or a new question (from Q101).
21. **The repo summary carries counts and categories only:** no titles, names, contacts, activity ids or MIN-Ids. The full differences report stays in `~/gcpe-parity-private`.

## New open questions

- **Q100 (blocks the Exec pair only):** `ExecLookAhead.pdf` is text-identical to `LookAhead.pdf`: all 117 pages, the same 675-token outline, a byte-identical size. Legacy's Exec Look Ahead adds significance, venue and "Last updated" lines (`legacy-report-layouts.md` §2). So the file is almost certainly the Look Ahead exported twice. Can the Exec Look Ahead for 2026-06-01 to 2026-06-30 be re-exported as role 5? Until then, Task 4 reports the Exec pair as inconclusive, not as differences.

## File map

| File | Responsibility |
|---|---|
| `apps/calendar/src/import/legacy-rows.ts` (modify) | `OPTIONAL_TABLES`, `SnapshotProvenance`, `LegacySnapshot.provenance?` |
| `apps/calendar/src/import/csv-snapshot.ts` (create) | Decode, parse, section, check against Part C, build the snapshot and the key rows |
| `apps/calendar/test/legacy-csv-fixture.ts` (create) | Fictional CSV files in the real export's shapes (encodings, padding, separators, `8.2`) |
| `apps/calendar/src/import/csv-snapshot.test.ts` (create) | Reader tests, including the in-memory scope dry run |
| `apps/calendar/src/import/report.ts` / `report.test.ts` (modify) | `notProvided` |
| `apps/calendar/src/import/run.ts` / `run.test.ts` (modify) | `snapshot` in place of `source`; provenance into the report |
| `scripts/lib/calendar-parity-core.ts` (create) | Seed a throwaway Core with legacy keys |
| `apps/calendar/test/pdf-text.ts` (modify) | Export `outlineToken` and `activityIdOf` |
| `scripts/calendar-report-compare.ts` / `tests/calendar-report-compare.test.ts` (modify) | Row texts and their comparison |
| `scripts/calendar-report-parity.ts` / `tests/calendar-report-parity.test.ts` (create) | The runner |
| `package.json` (modify) | `calendar:report-parity` |
| `docs/parity/calendar-report-parity.md` (create, Task 4) | Sanitised summary |
| `docs/parity/open-questions.md`, `docs/parity/changes-from-legacy.md`, the spec's §15 Q50 row, `docs/manuals/running-notes.md`, `docs/superpowers/plans/phase-5-carry-forward.md` (modify, Task 4) | Tracking |

---

### Task 1: The CSV snapshot source, and the importer reading it

**Risk:** data-integrity (full review). This is the keystone: what the reader builds is what the reports show.

**Files:**
- Modify: `apps/calendar/src/import/legacy-rows.ts`, `apps/calendar/src/import/report.ts`, `apps/calendar/src/import/report.test.ts`, `apps/calendar/src/import/run.ts`, `apps/calendar/src/import/run.test.ts`
- Create: `apps/calendar/src/import/csv-snapshot.ts`, `apps/calendar/src/import/csv-snapshot.test.ts`, `apps/calendar/test/legacy-csv-fixture.ts`, `scripts/lib/calendar-parity-core.ts`

**Interfaces:**
- Consumes: `LegacySnapshot`, `JOIN_TABLES`, `LOOKUP_TABLES` (`legacy-rows.ts`); `NEEDS_REVIEW_COLUMNS` (`map.ts`); `upsertOrganization`, `HQ_ABBREVIATIONS` (`apps/core/src/services/organizations.ts`); `upsertTerm` (`apps/core/src/services/terms.ts`); `healthOrg` (`apps/core/test/helpers.ts`).
- Produces:
  - `legacy-rows.ts`: `OPTIONAL_TABLES`, `type OptionalTable`, `interface SnapshotProvenance { notProvided: OptionalTable[]; usersFromCommContacts: boolean; notes: string[] }`, `LegacySnapshot.provenance?: SnapshotProvenance`.
  - `csv-snapshot.ts`: `interface CsvFile { name: string; bytes: Uint8Array }`, `class CsvSnapshotError`, `decodeCsv(bytes): { text: string; encoding: CsvEncoding }`, `parseCsv(text): string[][]`, `sectionLabel(raw): string | null`, `interface LegacyKeyRow { Id: string; Key: string; DisplayName: string; Abbreviation: string | null; SortOrder: number | null; IsActive: boolean }`, `interface LegacyKeyRows { ministries; sectors; themes; tags: LegacyKeyRow[] }`, `snapshotFromCsv(files: CsvFile[], o: { partC?: CsvFile; usersFromCommContacts: boolean }): CsvSnapshot` where `CsvSnapshot = { snapshot: LegacySnapshot; keys: LegacyKeyRows; encodings: Record<string, CsvEncoding>; ignoredSections: string[] }`.
  - `run.ts`: `CalendarImportDeps` accepts `{ snapshot: LegacySnapshot }` in place of `{ source: LegacySource }`.
  - `report.ts`: `CalendarImportReport.notProvided(table: string, note: string)`, `CalendarImportReportJSON.notProvided: { table: string; note: string }[]`.
  - `scripts/lib/calendar-parity-core.ts`: `seedCoreFromLegacyKeys(coreDb: Db, keys: LegacyKeyRows): Promise<string>` (returns the GCPEHQ organisation's key).
  - Fixture: `legacyCsvFiles(): CsvFile[]`, `partCFile(): CsvFile`, `CSV_GUID`, `CSV_CUTOFF = "2031-03-01"`.

- [ ] **Step 1: Add the provenance types to `legacy-rows.ts`**

Append to `apps/calendar/src/import/legacy-rows.ts`, and add the field to `LegacySnapshot`:

```ts
/** Tables a snapshot may lack: survey 08's CSV export never queried them. */
export const OPTIONAL_TABLES = ["users", "userMinistries", "savedFilters", "favourites", "files", "logs"] as const;
export type OptionalTable = (typeof OPTIONAL_TABLES)[number];
/** Where a snapshot came from, when it isn't a full read of SQL Server. */
export interface SnapshotProvenance {
  /** Tables the source didn't hold: reported as such, never as zero rows. */
  notProvided: OptionalTable[];
  /** Users were made from comm contacts (names only, no email, no role). */
  usersFromCommContacts: boolean;
  /** Plain notes for the import report: no values. */
  notes: string[];
}
```

In `interface LegacySnapshot`, after `totals`:

```ts
  /** Absent for a full SQL Server read. */
  provenance?: SnapshotProvenance;
```

- [ ] **Step 2: Write the fictional fixture**

Create `apps/calendar/test/legacy-csv-fixture.ts`. It reproduces the real export's shapes: Windows-1252 for the activities and lookups files, `8.2` for 8.20, all-empty separator records, the lookups file padded to 10 columns, 8.16 absent, CRLF line endings, a quoted multi-line Details field, and the literal `NULL`.

```ts
import type { CsvFile } from "../src/import/csv-snapshot";

/** A fictional cutoff for the CSV fixture: every activity below ends on or after it. */
export const CSV_CUTOFF = "2031-03-01";
/** Fictional legacy GUIDs, uppercase as legacy stores them. */
export const CSV_GUID = {
  fin: "0E000000-0000-4000-8000-000000000001",
  hq: "0E000000-0000-4000-8000-000000000002",
  engage: "0E000000-0000-4000-8000-000000000003",
  sector: "0E000000-0000-4000-8000-000000000004",
  theme: "0E000000-0000-4000-8000-000000000005",
  tag: "0E000000-0000-4000-8000-000000000006",
  rel1: "0E000000-0000-4000-8000-0000000000A1",
  rel2: "0E000000-0000-4000-8000-0000000000A2",
  rel3: "0E000000-0000-4000-8000-0000000000A3",
} as const;

/** Windows-1252 bytes: Latin-1 for U+00A0–U+00FF, plus the curly apostrophe at 0x92. */
export function cp1252(text: string): Uint8Array {
  return Uint8Array.from([...text].map((ch) => {
    const c = ch.codePointAt(0)!;
    if (ch === "’") return 0x92;
    if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) return c;
    throw new Error(`no Windows-1252 byte for U+${c.toString(16)}`);
  }));
}
const q = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const line = (cells: (string | number)[]) => cells.map((c) => q(String(c))).join(",");
const pad = (cells: (string | number)[], width: number) => [...cells, ...Array(width - cells.length).fill("")];
const csv = (records: (string | number)[][]) => `${records.map(line).join("\r\n")}\r\n`;

export const ACTIVITY_COLUMNS = [
  "query", "Id", "StartDateTime", "EndDateTime", "PotentialDates", "NRDateTime", "IsAllDay", "IsConfirmed",
  "Title", "Details", "Schedule", "Significance", "Strategy", "Comments", "HqComments",
  "LeadOrganization", "Venue", "Translations", "OtherCity",
  "StatusId", "HqStatusId", "HqSection", "NRDistributionId", "PremierRequestedId",
  "ContactMinistryId", "GovernmentRepresentativeId", "CommunicationContactId", "EventPlannerId",
  "VideographerId", "CityId",
  "IsActive", "IsIssue", "IsAtLegislature", "IsConfidential", "IsCrossGovernment", "IsMilestone",
  "CreatedDateTime", "CreatedBy", "LastUpdatedDateTime", "LastUpdatedBy",
] as const;
type ActivityCells = Partial<Record<(typeof ACTIVITY_COLUMNS)[number], string | number>>;
function activity(Id: number, over: ActivityCells): (string | number)[] {
  const base: ActivityCells = {
    query: "8.10", Id, PotentialDates: "", NRDateTime: "NULL", IsAllDay: 0, IsConfirmed: 1,
    Title: `Sample activity ${Id}`, Details: "Sample details", Schedule: "Sample schedule", Significance: "Sample significance",
    Strategy: "", Comments: "", HqComments: "Sample summary", LeadOrganization: "", Venue: "", Translations: "NULL", OtherCity: "",
    StatusId: 2, HqStatusId: "NULL", HqSection: 1, NRDistributionId: "NULL", PremierRequestedId: "NULL",
    ContactMinistryId: CSV_GUID.fin, GovernmentRepresentativeId: "NULL", CommunicationContactId: 501, EventPlannerId: "NULL",
    VideographerId: "NULL", CityId: 311,
    IsActive: 1, IsIssue: 0, IsAtLegislature: 0, IsConfidential: 0, IsCrossGovernment: 0, IsMilestone: 0,
    CreatedDateTime: "2031-01-10T09:00:00.000", CreatedBy: 9100, LastUpdatedDateTime: "2031-02-01T09:00:00.000", LastUpdatedBy: 9100,
  };
  const row = { ...base, ...over };
  return ACTIVITY_COLUMNS.map((c) => row[c] ?? "");
}

/** Five activities in March 2031: a plain one, an awareness date, a deleted one, an issue, and one spanning the cutoff. */
export function activitiesCsv(): string {
  return csv([
    [...ACTIVITY_COLUMNS],
    activity(41001, {
      StartDateTime: "2031-03-03T09:00:00.000", EndDateTime: "2031-03-03T10:00:00.000",
      Title: "Sample café opening", Details: "Sample details, with a comma, a \"quote\" and the minister’s line\r\nand a second line",
    }),
    activity(41002, { StartDateTime: "2031-03-04T00:00:00.000", EndDateTime: "2031-03-04T23:59:00.000", IsAllDay: 1, HqSection: 4, Title: "Sample awareness day" }),
    activity(41003, { StartDateTime: "2031-03-03T13:00:00.000", EndDateTime: "2031-03-03T14:00:00.000", IsActive: 0, Title: "Sample deleted activity" }),
    activity(41004, {
      StartDateTime: "2031-03-05T09:00:00.000", EndDateTime: "2031-03-05T10:00:00.000", IsIssue: 1, HqSection: 2,
      ContactMinistryId: CSV_GUID.hq, CommunicationContactId: 502, NRDateTime: "2031-03-05T08:30:00.000", Title: "Sample issue",
    }),
    activity(41005, { StartDateTime: "2031-02-27T09:00:00.000", EndDateTime: "2031-03-03T17:00:00.000", HqSection: -1, Title: "Sample spanning activity" }),
  ]);
}

/** 8.11–8.19 in one file, separated as SSMS separates result sets; 8.16 has no rows, so no section. */
export function joinsCsv(): string {
  const sep = ["", "", "", ""];
  return csv([
    ["query", "ActivityId", "CategoryId", "IsActive"], ["8.11", 41001, 12, 1], ["8.11", 41002, 2, 1], ["8.11", 41003, 12, 1], ["8.11", 41004, 12, 1], ["8.11", 41005, 12, 1], sep, sep,
    ["query", "ActivityId", "CommunicationMaterialId", "IsActive"], ["8.12", 41001, 1, 1], sep, sep,
    ["query", "ActivityId", "InitiativeId", "IsActive"], ["8.13", 41004, 1, 1], sep, sep,
    ["query", "ActivityId", "KeywordId", "IsActive"], ["8.14", 41001, 1, 1], sep, sep,
    ["query", "ActivityId", "NROriginId", "IsActive"], ["8.15", 41001, 1, 1], sep, sep,
    ["query", "ActivityId", "MinistryId", "IsActive"], ["8.17", 41004, CSV_GUID.fin, 1], sep, sep,
    ["query", "ActivityId", "TagId", "IsActive"], ["8.18", 41004, CSV_GUID.tag, 1], sep, sep,
    ["query", "ActivityId", "ThemeId", "IsActive"], ["8.19", 41004, CSV_GUID.theme, 1],
  ]);
}

/** 8.20, labelled "8.2" as the real export has it. */
export function releasesCsv(): string {
  const rel = (id: string, activityId: number, key: string) => ["8.2", id, activityId, key, 1, "2031-03-03T10:00:00-07:00", 1, 1];
  return csv([
    ["query", "Id", "ActivityId", "Key", "ReleaseType", "PublishDateTime", "IsPublished", "IsActive"],
    rel(CSV_GUID.rel1, 41001, "2031FIN0001-000001"), rel(CSV_GUID.rel2, 41001, "2031FIN0002-000002"), rel(CSV_GUID.rel3, 41004, "2031HQ0001-000003"),
  ]);
}

/** 8.30–8.46 in one file, every record padded to 10 columns as the real export is. */
export function lookupsCsv(): string {
  const W = 10;
  const sep = pad([], W);
  const section = (header: string[], rows: (string | number)[][]) => [pad(header, W), ...rows.map((r) => pad(r, W)), sep, sep];
  return csv([
    ...section(["query", "Id", "Name", "SortOrder", "IsActive", "TimeStamp", "RowGuid"], [["8.30", 2, "Sample awareness", 1, 1, "0x01", CSV_GUID.rel1], ["8.30", 12, "Sample category", 2, 1, "0x02", CSV_GUID.rel2]]),
    ...section(["query", "Id", "Name", "IsActive", "TimeStamp", "RowGuid", "SortOrder"], [["8.31", 311, "Sample City", 1, "0x03", "NULL", 1]]),
    ...section(["query", "Id", "SystemUserId", "Name", "MinistryShortName", "MinistryId", "SortOrder", "IsActive", "TimeStamp", "RowGuid"], [
      ["8.32", 501, 9001, "Sample Contact One", "SFIN", CSV_GUID.fin, 1, 1, "0x04", "NULL"],
      ["8.32", 502, 9002, "Sample Contact Two", "SHQ", CSV_GUID.hq, 2, 0, "0x05", "NULL"],
      ["8.32", 503, 9001, "Sample Contact Alias", "SHQ", CSV_GUID.hq, 1, 1, "0x06", "NULL"],
      ["8.32", 504, 9003, "Sample No Ministry", "", "NULL", "NULL", 1, "0x07", "NULL"],
    ]),
    ...section(["query", "Id", "Name", "IsActive", "SortOrder", "TimeStamp", "RowGuid"], [["8.33", 1, "Sample material", 1, 1, "0x08", CSV_GUID.rel3]]),
    ...section(["query", "Id", "Name", "PhoneNumber", "JobTitle", "SortOrder", "IsActive", "TimeStamp", "RowGuid"], [["8.34", 1, "Sample Planner", "NULL", "Sample planner title", 1, 1, "0x09", "NULL"]]),
    ...section(["query", "Id", "Name", "Description", "IsActive", "SortOrder", "TimeStamp", "RowGuid"], [["8.35", 1, "Sample Representative", "Sample description", 1, "NULL", "0x0A", "NULL"]]),
    ...section(["query", "Id", "Name", "IsActive", "SortOrder", "TimeStamp", "RowGuid", "ShortName"], [["8.36", 1, "Sample initiative", 1, 1, "0x0B", CSV_GUID.rel1, "SI"]]),
    ...section(["query", "Id", "Name", "SortOrder", "IsActive", "LastUpdatedDateTime", "LastUpdatedBy"], [["8.37", 1, "Sample keyword", 0, 1, "2031-01-01T00:00:00.000", 9100]]),
    ...section(["query", "Id", "Name", "SortOrder", "IsActive", "TimeStamp", "RowGuid"], [["8.38", 1, "Sample distribution", 1, 1, "0x0C", CSV_GUID.rel2]]),
    ...section(["query", "Id", "Name", "IsActive", "SortOrder", "TimeStamp", "RowGuid"], [["8.39", 1, "Sample origin", 1, "NULL", "0x0D", CSV_GUID.rel3]]),
    ...section(["query", "Id", "Name", "IsActive", "SortOrder", "TimeStamp", "RowGuid"], [["8.40", 1, "Sample request", 1, 1, "0x0E", CSV_GUID.rel1]]),
    ...section(["query", "Id", "Name", "IsActive", "TimeStamp", "RowGuid"], [["8.41", 1, "Sample status", 1, "0x0F", CSV_GUID.rel2]]),
    ...section(["query", "Id", "Name", "JobTitle", "SortOrder", "IsActive", "TimeStamp", "RowGuid"], [["8.42", 1, "Sample Videographer", "NULL", 1, 1, "0x10", "NULL"]]),
    ...section(["query", "Id", "Key", "DisplayName", "Abbreviation", "IsActive"], [
      ["8.43", CSV_GUID.fin, "sample-finance", "Sample Finance", "SFIN", 1],
      ["8.43", CSV_GUID.hq, "sample-hq", "Sample Communications HQ", "GCPEHQ", 1],
      ["8.43", CSV_GUID.engage, "sample-engagement", "Sample Engagement", "CITENG", 1],
    ]),
    ...section(["query", "Id", "Key", "DisplayName", "IsActive"], [["8.44", CSV_GUID.sector, "sample-sector", "Sample sector", 1]]),
    ...section(["query", "Id", "Key", "DisplayName", "IsActive"], [["8.45", CSV_GUID.theme, "sample-theme", "Sample theme", 1]]),
    ...[pad(["query", "Id", "Key", "DisplayName", "SortOrder", "IsActive"], W), pad(["8.46", CSV_GUID.tag, "sample-tag", "Sample tag", 0, 1], W)],
  ]);
}

export function partCCsv(): string {
  return csv([["query", "rows_returned"], ["8.10", 5], ["8.11", 5], ["8.12", 1], ["8.13", 1], ["8.14", 1], ["8.15", 1], ["8.16", 0], ["8.17", 1], ["8.18", 1], ["8.19", 1], ["8.2", 3], ["8.46", 1]]);
}

const utf8 = (s: string) => new TextEncoder().encode(s);
/** The four files as the real export has them: two Windows-1252, two UTF-8. */
export function legacyCsvFiles(): CsvFile[] {
  return [
    { name: "activities.csv", bytes: cp1252(activitiesCsv()) },
    { name: "joins.csv", bytes: utf8(joinsCsv()) },
    { name: "releases.csv", bytes: utf8(releasesCsv()) },
    { name: "lookups.csv", bytes: cp1252(lookupsCsv()) },
  ];
}
export const partCFile = (): CsvFile => ({ name: "part-c.csv", bytes: utf8(partCCsv()) });
```

- [ ] **Step 3: Write the failing reader tests**

Create `apps/calendar/src/import/csv-snapshot.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { TEST_RULES } from "../../test/helpers";
import { CSV_CUTOFF, CSV_GUID, legacyCsvFiles, partCFile, partCCsv } from "../../test/legacy-csv-fixture";
import { CsvSnapshotError, decodeCsv, parseCsv, sectionLabel, snapshotFromCsv, type CsvFile, type LegacyKeyRows } from "./csv-snapshot";
import { joinsByActivity, mapActivity, unknownLegacyKeys } from "./map";
import { selectScope } from "./scope";

const utf8 = (s: string) => new TextEncoder().encode(s);
const read = (o: { partC?: CsvFile | undefined; users?: boolean; files?: CsvFile[] } = {}) =>
  snapshotFromCsv(o.files ?? legacyCsvFiles(), { partC: "partC" in o ? o.partC : partCFile(), usersFromCommContacts: o.users ?? true });

describe("decodeCsv", () => {
  it("reads Windows-1252 when the bytes aren't UTF-8, and UTF-8 without its BOM otherwise", () => {
    expect(decodeCsv(Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x92]))).toEqual({ text: "café’", encoding: "windows-1252" });
    expect(decodeCsv(Uint8Array.from([0xef, 0xbb, 0xbf, 0x63, 0xc3, 0xa9]))).toEqual({ text: "cé", encoding: "utf-8" });
  });
});

describe("parseCsv", () => {
  it("keeps quoted commas, quotes and line breaks in one field", () => {
    expect(parseCsv('a,"b, ""c""\r\nd",e\r\nf,,\r\n')).toEqual([["a", 'b, "c"\r\nd', "e"], ["f", "", ""]]);
  });
  it("refuses a quoted field that never closes", () => {
    expect(() => parseCsv('a,"b\r\n')).toThrow(CsvSnapshotError);
  });
});

describe("sectionLabel", () => {
  it("reads labels as numbers, to two decimals", () => {
    expect(["8.2", "8.10", "8.46", " 8.11 ", "query", "x", ""].map(sectionLabel)).toEqual(["8.20", "8.10", "8.46", "8.11", null, null, null]);
  });
});

describe("snapshotFromCsv", () => {
  it("builds the importer's snapshot from the four files", () => {
    const { snapshot: s, encodings, ignoredSections, keys } = read();
    expect(encodings).toEqual({ "activities.csv": "windows-1252", "joins.csv": "utf-8", "releases.csv": "utf-8", "lookups.csv": "windows-1252" });
    expect(ignoredSections).toEqual(["8.41"]);
    expect(s.activities.map((a) => a.Id)).toEqual([41001, 41002, 41003, 41004, 41005]);
    const a = s.activities[0]!;
    expect(a.Title).toBe("Sample café opening");
    expect(a.Details).toBe("Sample details, with a comma, a \"quote\" and the minister’s line\r\nand a second line");
    expect(a.StartDateTime).toEqual(new Date(Date.UTC(2031, 2, 3, 9, 0)));
    expect(a.NRDateTime).toBeNull();
    expect(a.Translations).toBeNull();
    expect(a.PotentialDates).toBe("");
    expect(a.IsActive).toBe(true);
    expect(a.IsTitleNeedsReview).toBe(false);
    expect(s.activities[2]!.IsActive).toBe(false);
    expect(s.activities[4]!.HqSection).toBe(-1);
    expect(s.joins.categories).toHaveLength(5);
    expect(s.joins.sectors).toEqual([]);
    expect(s.joins.tags).toEqual([{ ActivityId: 41004, ValueId: CSV_GUID.tag, IsActive: true }]);
    expect(s.joins.categories[1]).toEqual({ ActivityId: 41002, ValueId: 2, IsActive: true });
    expect(s.releaseLinks).toEqual([{ ActivityId: 41001, N: 2 }, { ActivityId: 41004, N: 1 }]);
    expect(s.lookups.cities).toEqual([{ Id: 311, Name: "Sample City", SortOrder: 1, IsActive: true }]);
    expect(s.lookups.eventPlanners[0]).toMatchObject({ PhoneNumber: null, JobTitle: "Sample planner title" });
    expect(s.lookups.initiatives[0]).toMatchObject({ ShortName: "SI" });
    expect(s.commContacts).toEqual([
      { Id: 501, SystemUserId: 9001, MinistryId: CSV_GUID.fin, SortOrder: 1, IsActive: true },
      { Id: 502, SystemUserId: 9002, MinistryId: CSV_GUID.hq, SortOrder: 2, IsActive: false },
      { Id: 503, SystemUserId: 9001, MinistryId: CSV_GUID.hq, SortOrder: 1, IsActive: true },
      { Id: 504, SystemUserId: 9003, MinistryId: null, SortOrder: null, IsActive: true },
    ]);
    expect(s.totals).toEqual({ activities: 5, favourites: 0, files: 0, logs: 0 });
    expect([s.userMinistries, s.savedFilters, s.favourites, s.files, s.logs]).toEqual([[], [], [], [], []]);
    expect(keys.ministries.map((m) => [m.Key, m.Abbreviation])).toEqual([["sample-finance", "SFIN"], ["sample-hq", "GCPEHQ"], ["sample-engagement", "CITENG"]]);
    expect(keys.tags[0]).toMatchObject({ Id: CSV_GUID.tag, Key: "sample-tag", SortOrder: 0, IsActive: true });
  });

  it("makes one inactive, email-less, role-less user per comm contact user, named from a contact the activities use", () => {
    const { snapshot: s } = read();
    expect(s.users.map((u) => [u.Id, u.DisplayName, u.EmailAddress, u.IsActive, u.RoleId])).toEqual([
      [9001, "Sample Contact One", null, false, 0],
      [9002, "Sample Contact Two", null, false, 0],
      [9003, "Sample No Ministry", null, false, 0],
    ]);
    expect(s.provenance).toEqual({
      notProvided: ["userMinistries", "savedFilters", "favourites", "files", "logs"],
      usersFromCommContacts: true,
      notes: [
        "needs-review flags aren't in the export: imported as none",
        "users are made from comm contacts: names only, no email, no role, inactive",
      ],
    });
  });

  it("leaves users empty and not provided when asked to", () => {
    const { snapshot: s } = read({ users: false });
    expect(s.users).toEqual([]);
    expect(s.provenance?.notProvided).toEqual(["users", "userMinistries", "savedFilters", "favourites", "files", "logs"]);
  });

  it("refuses a missing section unless Part C says it is empty", () => {
    expect(() => read({ partC: undefined })).toThrow(/section 8\.16 is missing/);
    expect(read().snapshot.joins.sectors).toEqual([]);
  });

  it("refuses a section whose row count isn't Part C's", () => {
    const partC: CsvFile = { name: "part-c.csv", bytes: utf8(partCCsv().replace("8.12,1", "8.12,2")) };
    expect(() => read({ partC })).toThrow("section 8.12: 1 rows read, Part C says 2");
  });

  it("refuses a section in two files", () => {
    const files = legacyCsvFiles();
    expect(() => read({ files: [...files, { ...files[1]!, name: "joins-again.csv" }] })).toThrow(/section 8\.11 appears twice \(joins\.csv and joins-again\.csv\)/);
  });

  it("refuses a section whose header lacks its columns (survey 08's Part A file)", () => {
    const partA: CsvFile = { name: "part-a.csv", bytes: utf8("query,CategoryId,Name,Active\r\n8.1,2,Sample,1\r\n") };
    expect(() => read({ files: [...legacyCsvFiles(), partA] })).toThrow("part-a.csv: section 8.10's header lacks Id");
  });

  it("errors name the place, never the value", () => {
    const files = legacyCsvFiles();
    const bad = new TextDecoder("windows-1252").decode(files[0]!.bytes).replace("2031-03-04T00:00:00.000", "2031-02-30T00:00:00.000");
    const run = () => read({ files: [{ name: "activities.csv", bytes: new TextEncoder().encode(bad) }, ...files.slice(1)] });
    expect(run).toThrow("activities.csv: section 8.10, row 2, column StartDateTime: not a date and time");
    try { run(); } catch (e) { expect((e as Error).message).not.toContain("2031-02-30"); }
  });

  it("feeds the importer's scope and mapping: every activity in scope, every key known", () => {
    const { snapshot: s, keys } = read();
    const scope = selectScope(s, { cutoff: CSV_CUTOFF, awarenessCategoryIds: TEST_RULES.awarenessCategoryIds });
    expect(scope.activities).toHaveLength(5);
    const known = legacyKeysOf(keys);
    expect(unknownLegacyKeys(s, scope, known)).toEqual([]);
    const joins = joinsByActivity(scope);
    const mapped = scope.activities.map((a) => mapActivity(a, joins.get(a.Id)!, { timeZone: TEST_RULES.timeZone, userIdOf: () => null, commContactIdOf: (id) => id, keys: known }));
    expect(mapped.filter((m) => "skip" in m)).toEqual([]);
  });
});

/** Core's view of the fixture's keys, without a database: legacy GUIDs lowercased, as Core stores them. */
function legacyKeysOf(k: LegacyKeyRows) {
  const orgs = new Map(k.ministries.map((m) => [m.Id.toLowerCase(), { id: m.Id.toLowerCase(), key: m.Key, displayName: m.DisplayName, abbreviation: m.Abbreviation }]));
  const terms = new Map([...k.sectors.map((t) => [`sector:${t.Id.toLowerCase()}`, t.Key]), ...k.themes.map((t) => [`theme:${t.Id.toLowerCase()}`, t.Key]), ...k.tags.map((t) => [`tag:${t.Id.toLowerCase()}`, t.Key])] as [string, string][]);
  return { org: (g: string) => orgs.get(g.trim().toLowerCase()) ?? null, termKey: (kind: "sector" | "theme" | "tag", g: string) => terms.get(`${kind}:${g.trim().toLowerCase()}`) ?? null };
}
```

- [ ] **Step 4: Run it to see it fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/import/csv-snapshot.test.ts`
Expected: FAIL with "Failed to load url ./csv-snapshot" (the module doesn't exist).

- [ ] **Step 5: Write the reader**

Create `apps/calendar/src/import/csv-snapshot.ts`:

```ts
import {
  JOIN_TABLES, LOOKUP_TABLES, type JoinTable, type LegacyActivity, type LegacyCommContact, type LegacyJoinRow, type LegacyLookup,
  type LegacyReleaseLink, type LegacySnapshot, type LegacyUser, type LookupTable, type OptionalTable,
} from "./legacy-rows";
import { NEEDS_REVIEW_COLUMNS } from "./map";

// Survey 08's Part B export (docs/parity/legacy-survey/08-calendar-parity.sql, v2), saved from SSMS
// as CSV: every record starts with its query label, each result set has its own "query,…" header,
// NULL is the literal text NULL, and dates are ISO text. Only the report parity check reads it.

export interface CsvFile { name: string; bytes: Uint8Array }
export type CsvEncoding = "utf-8" | "windows-1252";
type CsvRow = Record<string, string | null>;
interface CsvSection { label: string; file: string; rows: CsvRow[] }
/** Its message names a file, a section, a row and a column, never a cell's value: it reaches the terminal. */
export class CsvSnapshotError extends Error { override name = "CsvSnapshotError"; }

/** UTF-8 when the bytes are valid UTF-8 (a BOM is dropped), else Windows-1252, SSMS's ANSI default here. */
export function decodeCsv(bytes: Uint8Array): { text: string; encoding: CsvEncoding } {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "windows-1252" };
  }
}

/** RFC 4180: a field that starts with a quote runs to its closing quote, "" inside is one quote, and CRLF or LF ends a record. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let atStart = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
      continue;
    }
    if (c === '"' && atStart) { quoted = true; atStart = false; continue; }
    if (c === ",") { row.push(field); field = ""; atStart = true; continue; }
    if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = ""; atStart = true;
      continue;
    }
    field += c;
    atStart = false;
  }
  if (quoted) throw new CsvSnapshotError("a quoted field never closes");
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/** "8.2" and "8.20" are one label: the export drops a trailing zero. */
export function sectionLabel(raw: string): string | null {
  const m = /^(\d+)\.(\d{1,2})$/.exec(raw.trim());
  return m ? `${m[1]}.${m[2]!.padEnd(2, "0")}` : null;
}

const LOOKUP_BASE = ["Id", "Name", "SortOrder", "IsActive"];
const JOIN_SECTION: Record<JoinTable, { label: string; column: string; guid: boolean }> = {
  categories: { label: "8.11", column: "CategoryId", guid: false },
  commMaterials: { label: "8.12", column: "CommunicationMaterialId", guid: false },
  initiatives: { label: "8.13", column: "InitiativeId", guid: false },
  keywords: { label: "8.14", column: "KeywordId", guid: false },
  nrOrigins: { label: "8.15", column: "NROriginId", guid: false },
  sectors: { label: "8.16", column: "SectorId", guid: true },
  sharedWith: { label: "8.17", column: "MinistryId", guid: true },
  tags: { label: "8.18", column: "TagId", guid: true },
  themes: { label: "8.19", column: "ThemeId", guid: true },
};
const LOOKUP_SECTION: Record<LookupTable, { label: string; extra: string[] }> = {
  categories: { label: "8.30", extra: [] }, cities: { label: "8.31", extra: [] }, commMaterials: { label: "8.33", extra: [] },
  eventPlanners: { label: "8.34", extra: ["PhoneNumber", "JobTitle"] }, governmentRepresentatives: { label: "8.35", extra: ["Description"] },
  initiatives: { label: "8.36", extra: ["ShortName"] }, keywords: { label: "8.37", extra: [] }, nrDistributions: { label: "8.38", extra: [] },
  nrOrigins: { label: "8.39", extra: [] }, premierRequested: { label: "8.40", extra: [] }, videographers: { label: "8.42", extra: ["JobTitle"] },
};
const ACTIVITY_COLUMNS = [
  "Id", "StartDateTime", "EndDateTime", "PotentialDates", "NRDateTime", "IsAllDay", "IsConfirmed", "Title", "Details", "Schedule", "Significance",
  "Strategy", "Comments", "HqComments", "LeadOrganization", "Venue", "Translations", "OtherCity", "StatusId", "HqStatusId", "HqSection",
  "NRDistributionId", "PremierRequestedId", "ContactMinistryId", "GovernmentRepresentativeId", "CommunicationContactId", "EventPlannerId",
  "VideographerId", "CityId", "IsActive", "IsIssue", "IsAtLegislature", "IsConfidential", "IsCrossGovernment", "IsMilestone",
  "CreatedDateTime", "CreatedBy", "LastUpdatedDateTime", "LastUpdatedBy",
];
/** The columns each known section must carry. Any other label is ignored. */
const SECTION_COLUMNS: Record<string, string[]> = {
  "8.10": ACTIVITY_COLUMNS,
  ...Object.fromEntries(Object.values(JOIN_SECTION).map((j) => [j.label, ["ActivityId", j.column, "IsActive"]])),
  "8.20": ["ActivityId"],
  ...Object.fromEntries(Object.values(LOOKUP_SECTION).map((l) => [l.label, [...LOOKUP_BASE, ...l.extra]])),
  "8.32": ["Id", "SystemUserId", "Name", "MinistryId", "SortOrder", "IsActive"],
  "8.43": ["Id", "Key", "DisplayName", "Abbreviation", "IsActive"],
  "8.44": ["Id", "Key", "DisplayName", "IsActive"],
  "8.45": ["Id", "Key", "DisplayName", "IsActive"],
  "8.46": ["Id", "Key", "DisplayName", "SortOrder", "IsActive"],
};

const blank = (cells: string[]) => cells.every((c) => c.trim() === "");

function readSections(files: readonly CsvFile[]) {
  const sections = new Map<string, CsvSection>();
  const encodings: Record<string, CsvEncoding> = {};
  const ignored = new Set<string>();
  for (const f of files) {
    const { text, encoding } = decodeCsv(f.bytes);
    encodings[f.name] = encoding;
    let header: string[] | null = null;
    let current: CsvSection | null = null;
    let record = 0;
    for (const cells of parseCsv(text)) {
      record++;
      if (blank(cells)) continue;
      if (cells[0] === "query") {
        const width = cells.length - [...cells].reverse().findIndex((c) => c.trim() !== "");
        header = cells.slice(0, width);
        current = null;
        continue;
      }
      const label = sectionLabel(cells[0]!);
      if (!header || !label) throw new CsvSnapshotError(`${f.name}: record ${record} has no query label under a "query,…" header`);
      if (!current || current.label !== label) {
        const need = SECTION_COLUMNS[label];
        if (!need) { ignored.add(label); current = { label, file: f.name, rows: [] }; continue; }
        // The header first: survey 08's Part A labels (8.1, 8.2, 8.3) read as 8.10, 8.20, 8.30 and must be named as the wrong file.
        const lacking = need.find((c) => !header!.includes(c));
        if (lacking) throw new CsvSnapshotError(`${f.name}: section ${label}'s header lacks ${lacking}`);
        const prior = sections.get(label);
        if (prior) throw new CsvSnapshotError(`section ${label} appears twice (${prior.file} and ${f.name})`);
        current = { label, file: f.name, rows: [] };
        sections.set(label, current);
      }
      if (!SECTION_COLUMNS[label]) continue;
      if (cells.length < header.length || !blank(cells.slice(header.length))) {
        throw new CsvSnapshotError(`${f.name}: section ${label}, row ${current.rows.length + 1}: ${cells.length} cells for ${header.length} columns`);
      }
      const row: CsvRow = {};
      header.forEach((h, i) => { if (h !== "") row[h] = cells[i] === "NULL" ? null : cells[i]!; });
      current.rows.push(row);
    }
  }
  return { sections, encodings, ignored: [...ignored].sort() };
}

function readPartC(file: CsvFile): Map<string, number> {
  const out = new Map<string, number>();
  for (const cells of parseCsv(decodeCsv(file.bytes).text)) {
    if (blank(cells) || cells[0] === "query") continue;
    const label = sectionLabel(cells[0]!);
    const n = Number(cells[1]);
    if (!label || !Number.isSafeInteger(n) || n < 0) throw new CsvSnapshotError(`${file.name}: a Part C record isn't "label,count"`);
    out.set(label, n);
  }
  return out;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?$/;

/** Typed reads of one row; every error names the place only. */
function cellsOf(s: CsvSection, i: number) {
  const r = s.rows[i]!;
  const fail = (col: string, what: string): never => { throw new CsvSnapshotError(`${s.file}: section ${s.label}, row ${i + 1}, column ${col}: ${what}`); };
  const int = (col: string): number | null => {
    const v = r[col] ?? null;
    if (v === null || v === "") return null;
    return /^-?\d+$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : fail(col, "not a whole number");
  };
  const bool = (col: string): boolean | null => {
    const v = r[col] ?? null;
    if (v === null || v === "") return null;
    const t = v.toLowerCase();
    return t === "1" || t === "true" ? true : t === "0" || t === "false" ? false : fail(col, "not 0 or 1");
  };
  return {
    text: (col: string) => r[col] ?? "",
    str: (col: string) => r[col] ?? null,
    int,
    reqInt: (col: string) => int(col) ?? fail(col, "is empty"),
    bool,
    reqBool: (col: string) => bool(col) ?? fail(col, "is empty"),
    guid: (col: string) => { const v = r[col] ?? null; return v === null || GUID.test(v) ? v : fail(col, "not a GUID"); },
    reqGuid: (col: string) => { const v = r[col] ?? null; return v !== null && GUID.test(v) ? v : fail(col, "not a GUID"); },
    reqText: (col: string) => { const v = r[col] ?? ""; return v.trim() !== "" ? v : fail(col, "is empty"); },
    /** Legacy DATETIMEs: BC wall-clock time in the UTC fields, as load.ts receives them from mssql. */
    wall: (col: string): Date | null => {
      const v = r[col] ?? null;
      if (v === null || v === "") return null;
      const m = WALL.exec(v);
      if (!m) return fail(col, "not a date and time");
      const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
      const ms = Number((m[7] ?? "0").padEnd(3, "0").slice(0, 3));
      const at = new Date(Date.UTC(y, mo - 1, d, h, mi, se, ms));
      return at.getUTCFullYear() === y && at.getUTCMonth() === mo - 1 && at.getUTCDate() === d && h < 24 && mi < 60 && se < 60 ? at : fail(col, "not a date and time");
    },
  };
}
const rowsOf = <T>(s: CsvSection, f: (c: ReturnType<typeof cellsOf>) => T): T[] => s.rows.map((_, i) => f(cellsOf(s, i)));

export interface LegacyKeyRow { Id: string; Key: string; DisplayName: string; Abbreviation: string | null; SortOrder: number | null; IsActive: boolean }
/** dbo.Ministry, Sector, Theme and Tag (8.43–8.46): what a throwaway Core needs so the importer's key check passes. */
export interface LegacyKeyRows { ministries: LegacyKeyRow[]; sectors: LegacyKeyRow[]; themes: LegacyKeyRow[]; tags: LegacyKeyRow[] }
export interface CsvSnapshot { snapshot: LegacySnapshot; keys: LegacyKeyRows; encodings: Record<string, CsvEncoding>; ignoredSections: string[] }
export interface CsvSnapshotOptions {
  /** Part C's row counts: enforced for every section it lists, and the only way a section may be absent (a count of 0). */
  partC?: CsvFile | undefined;
  /** Make users from comm contacts, so contacts import and their names reach the reports. */
  usersFromCommContacts: boolean;
}

/** The same LegacySnapshot load.ts builds from SQL Server, from survey 08's Part B CSV files. */
export function snapshotFromCsv(files: readonly CsvFile[], o: CsvSnapshotOptions): CsvSnapshot {
  const { sections, encodings, ignored } = readSections(files);
  const partC = o.partC ? readPartC(o.partC) : null;
  for (const [label, expected] of partC ?? []) {
    const got = sections.get(label)?.rows.length ?? 0;
    if (got !== expected) throw new CsvSnapshotError(`section ${label}: ${got} rows read, Part C says ${expected}`);
  }
  const need = (label: string): CsvSection => {
    const s = sections.get(label);
    if (s) return s;
    if (partC?.get(label) === 0) return { label, file: "(Part C: no rows)", rows: [] };
    throw new CsvSnapshotError(`section ${label} is missing${partC ? "" : " (pass the Part C counts if it is truly empty)"}`);
  };

  const notReviewed = Object.fromEntries(Object.values(NEEDS_REVIEW_COLUMNS).map((k) => [k, false]));
  const activities: LegacyActivity[] = rowsOf(need("8.10"), (c) => ({
    ...(notReviewed as Pick<LegacyActivity, (typeof NEEDS_REVIEW_COLUMNS)[keyof typeof NEEDS_REVIEW_COLUMNS]>),
    Id: c.reqInt("Id"),
    StartDateTime: c.wall("StartDateTime"), EndDateTime: c.wall("EndDateTime"), NRDateTime: c.wall("NRDateTime"),
    PotentialDates: c.str("PotentialDates"),
    Title: c.text("Title"), Details: c.text("Details"), Schedule: c.text("Schedule"), Significance: c.text("Significance"),
    Strategy: c.str("Strategy"), Comments: c.str("Comments"), HqComments: c.str("HqComments"),
    LeadOrganization: c.str("LeadOrganization"), Venue: c.str("Venue"), OtherCity: c.str("OtherCity"), Translations: c.str("Translations"),
    StatusId: c.int("StatusId"), HqStatusId: c.int("HqStatusId"), HqSection: c.reqInt("HqSection"),
    NRDistributionId: c.int("NRDistributionId"), PremierRequestedId: c.int("PremierRequestedId"), ContactMinistryId: c.guid("ContactMinistryId"),
    GovernmentRepresentativeId: c.int("GovernmentRepresentativeId"), CommunicationContactId: c.int("CommunicationContactId"),
    EventPlannerId: c.int("EventPlannerId"), VideographerId: c.int("VideographerId"), CityId: c.int("CityId"),
    IsActive: c.reqBool("IsActive"), IsConfirmed: c.reqBool("IsConfirmed"), IsIssue: c.reqBool("IsIssue"), IsAllDay: c.reqBool("IsAllDay"),
    IsAtLegislature: c.reqBool("IsAtLegislature"), IsConfidential: c.reqBool("IsConfidential"), IsCrossGovernment: c.reqBool("IsCrossGovernment"),
    IsMilestone: c.reqBool("IsMilestone"),
    CreatedDateTime: c.wall("CreatedDateTime"), CreatedBy: c.int("CreatedBy"), LastUpdatedDateTime: c.wall("LastUpdatedDateTime"), LastUpdatedBy: c.int("LastUpdatedBy"),
  }));

  const joins = {} as Record<JoinTable, LegacyJoinRow[]>;
  for (const t of JOIN_TABLES) {
    const j = JOIN_SECTION[t];
    joins[t] = rowsOf(need(j.label), (c) => ({ ActivityId: c.reqInt("ActivityId"), ValueId: j.guid ? c.reqGuid(j.column) : c.reqInt(j.column), IsActive: c.reqBool("IsActive") }));
  }

  const lookups = {} as Record<LookupTable, LegacyLookup[]>;
  for (const t of LOOKUP_TABLES) {
    const l = LOOKUP_SECTION[t];
    lookups[t] = rowsOf(need(l.label), (c) => {
      const row: LegacyLookup = { Id: c.reqInt("Id"), Name: c.str("Name"), SortOrder: c.int("SortOrder"), IsActive: c.bool("IsActive") };
      for (const x of l.extra) (row as unknown as Record<string, string | null>)[x] = c.str(x);
      return row;
    });
  }

  const contactRows = rowsOf(need("8.32"), (c) => ({
    contact: { Id: c.reqInt("Id"), SystemUserId: c.reqInt("SystemUserId"), MinistryId: c.guid("MinistryId"), SortOrder: c.int("SortOrder"), IsActive: c.bool("IsActive") } satisfies LegacyCommContact,
    name: c.text("Name"),
  }));
  const commContacts = contactRows.map((r) => r.contact);

  const linkCounts = new Map<number, number>();
  for (const id of rowsOf(need("8.20"), (c) => c.reqInt("ActivityId"))) linkCounts.set(id, (linkCounts.get(id) ?? 0) + 1);
  const releaseLinks: LegacyReleaseLink[] = [...linkCounts].sort(([a], [b]) => a - b).map(([ActivityId, N]) => ({ ActivityId, N }));

  const keyRows = (label: string) => rowsOf(need(label), (c) => ({
    Id: c.reqGuid("Id"), Key: c.reqText("Key"), DisplayName: c.text("DisplayName"),
    Abbreviation: c.str("Abbreviation"), SortOrder: c.int("SortOrder"), IsActive: c.reqBool("IsActive"),
  }));
  const keys: LegacyKeyRows = { ministries: keyRows("8.43"), sectors: keyRows("8.44"), themes: keyRows("8.45"), tags: keyRows("8.46") };

  const referenced = new Set(activities.map((a) => a.CommunicationContactId).filter((id): id is number => id !== null));
  const users = o.usersFromCommContacts ? usersFromContacts(contactRows, referenced) : [];
  const notProvided: OptionalTable[] = [...(o.usersFromCommContacts ? [] : (["users"] as const)), "userMinistries", "savedFilters", "favourites", "files", "logs"];
  const notes = ["needs-review flags aren't in the export: imported as none"];
  if (o.usersFromCommContacts) notes.push("users are made from comm contacts: names only, no email, no role, inactive");

  return {
    snapshot: {
      activities, joins, users, userMinistries: [], commContacts, savedFilters: [], favourites: [], files: [], logs: [], lookups, releaseLinks,
      totals: { activities: activities.length, favourites: 0, files: 0, logs: 0 },
      provenance: { notProvided, usersFromCommContacts: o.usersFromCommContacts, notes },
    },
    keys, encodings, ignoredSections: ignored,
  };
}

/** One user per SystemUserId, named from its lowest-id contact an activity uses, else its lowest-id active one, else its lowest-id one. */
function usersFromContacts(rows: { contact: LegacyCommContact; name: string }[], referenced: Set<number>): LegacyUser[] {
  const rank = (r: { contact: LegacyCommContact }) => [referenced.has(r.contact.Id) ? 0 : 1, r.contact.IsActive === true ? 0 : 1, r.contact.Id] as const;
  const best = new Map<number, { contact: LegacyCommContact; name: string }>();
  for (const r of rows) {
    const cur = best.get(r.contact.SystemUserId);
    if (!cur || compare(rank(r), rank(cur)) < 0) best.set(r.contact.SystemUserId, r);
  }
  return [...best].sort(([a], [b]) => a - b).map(([Id, r]) => ({
    Id, RoleId: 0, DisplayName: r.name, FullName: null, EmailAddress: null, IsActive: false,
    JobTitle: null, PhoneNumber: null, MobileNumber: null, Description: null, FilterDisplayValue: null, HiddenColumns: null, LastUpdatedDateTime: null,
  }));
}
const compare = (a: readonly number[], b: readonly number[]) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!; return 0; };
```

`RoleId: 0` maps to no Calendar role (`CALENDAR_ROLES[-1]` is undefined). `planCalendarUsers` creates each user inactive with no email (spec §12.1, "Active").

- [ ] **Step 6: Run the reader tests to green**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/import/csv-snapshot.test.ts`
Expected: PASS, 13 tests. If "builds the importer's snapshot" fails on `lookups.cities`, the extra-column loop is adding `undefined` keys: only `LOOKUP_SECTION[t].extra` columns may be added.

- [ ] **Step 7: Write the failing report and run tests**

Add to `apps/calendar/src/import/report.test.ts`:

```ts
  it("lists tables the snapshot didn't provide, and leaves them out of the counts and the balance", () => {
    const r = new CalendarImportReport("confirmed", "2031-03-01");
    r.legacy("favourites", 0);
    r.count("favourites", "planned", 0);
    r.legacy("activities", 2);
    r.count("activities", "inserted", 2);
    r.notProvided("favourites", "not in the snapshot");
    r.legacy("favourites", 3);
    expect(r.balanced()).toBe(true);
    expect(Object.keys(r.toJSON().tables)).toEqual(["activities"]);
    expect(r.toJSON().notProvided).toEqual([{ table: "favourites", note: "not in the snapshot" }]);
    expect(r.toText()).toContain("Not provided: favourites (not in the snapshot)");
  });
```

Add to `apps/calendar/src/import/run.test.ts`. Put the imports at the top of the file, and the `describe` block at the end:

```ts
import { legacyCsvFiles, partCFile, CSV_CUTOFF } from "../../test/legacy-csv-fixture";
import { snapshotFromCsv } from "./csv-snapshot";
import { seedCoreFromLegacyKeys } from "../../../../scripts/lib/calendar-parity-core";
import { commContacts as calCommContacts } from "../db/schema";

describe("calendar:import from a CSV snapshot", () => {
  it("imports every activity, makes users from comm contacts, and reports the tables it never had as not provided", async () => {
    await core.db.execute(sql`TRUNCATE users, organizations, terms, outbox_events, outbox_deliveries, aggregate_sequences CASCADE`);
    const { snapshot, keys } = snapshotFromCsv(legacyCsvFiles(), { partC: partCFile(), usersFromCommContacts: true });
    expect(await seedCoreFromLegacyKeys(core.db, keys)).toBe("sample-hq");
    const d = await deps();
    const report = await runCalendarImport({ db: d.db, coreDb: d.coreDb, snapshot, store: d.store, rules: TEST_RULES, coreSubscribers: [] }, { cutoff: CSV_CUTOFF, confirm: true });
    const j = report.toJSON();
    expect(j.balanced).toBe(true);
    expect(j.tables.activities).toMatchObject({ legacy: 5, inserted: 5 });
    expect(j.tables.users).toMatchObject({ legacy: 3, inserted: 3 });
    expect(j.tables.commContacts).toMatchObject({ legacy: 4, inserted: 3, skipped: 1 });
    expect(Object.keys(j.tables)).not.toContain("favourites");
    expect(j.notProvided.map((n) => n.table)).toEqual(["userMinistries", "savedFilters", "favourites", "files", "logRows"]);
    expect(j.notes).toEqual(expect.arrayContaining(["users are made from comm contacts: names only, no email, no role, inactive"]));
    expect(j.facts).not.toHaveProperty("historyRows");
    expect(j.facts).not.toHaveProperty("usersWithoutEmail");
    expect((await cal.db.select({ id: activities.id }).from(activities).orderBy(asc(activities.id))).map((r) => r.id)).toEqual([41001, 41002, 41003, 41004, 41005]);
    const [a] = await cal.db.select({ commContactId: activities.commContactId }).from(activities).where(eq(activities.id, 41001));
    expect(a!.commContactId).toBe(501);
    expect((await cal.db.select({ id: calCommContacts.id }).from(calCommContacts).orderBy(asc(calCommContacts.id))).map((r) => r.id)).toEqual([501, 502, 503]);
    const made = await core.db.select({ name: coreUsers.displayName, email: coreUsers.email, active: coreUsers.isActive }).from(coreUsers).orderBy(asc(coreUsers.displayName));
    expect(made).toEqual([
      { name: "Sample Contact One", email: null, active: false },
      { name: "Sample Contact Two", email: null, active: false },
      { name: "Sample No Ministry", email: null, active: false },
    ]);
  });
});
```

- [ ] **Step 8: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/import/report.test.ts apps/calendar/src/import/run.test.ts`
Expected: FAIL. `r.notProvided is not a function`; the run test fails to import `scripts/lib/calendar-parity-core` and fails to type the `snapshot` deps.

- [ ] **Step 9: Add `notProvided` to the report**

In `apps/calendar/src/import/report.ts`:
- Add `notProvided: { table: string; note: string }[];` to `CalendarImportReportJSON`, after `facts`, with the doc comment `/** Tables the snapshot didn't hold (a CSV export): listed here, never counted as zero rows. */`.
- Add `notProvided: []` to the `data` initialiser.
- Add the methods and use them:

```ts
  notProvided(table: string, note: string): void { this.data.notProvided.push({ table, note }); }
  private missing(): Set<string> { return new Set(this.data.notProvided.map((n) => n.table)); }
  balanced(): boolean {
    if (this.data.failed) return false;
    const missing = this.missing();
    for (const [t, r] of this.tables) if (!missing.has(t) && r.legacy !== OUTCOMES.reduce((n, o) => n + r[o], 0)) return false;
    return true;
  }
```

In `toJSON`, filter the table entries: `tables: Object.fromEntries([...this.tables.entries()].filter(([t]) => !missing.has(t)).sort(([a], [b]) => a.localeCompare(b)))`, with `const missing = this.missing();` first. In `toText`, after the per-table lines: `for (const n of j.notProvided) lines.push(\`Not provided: ${n.table} (${n.note})\`);`.

- [ ] **Step 10: Let the run take a snapshot, and carry the provenance**

In `apps/calendar/src/import/run.ts`:

```ts
interface CalendarImportBase { db: Db; coreDb: Db; store: ObjectStore; rules: CalendarRules; coreSubscribers: SubscriberConfig[]; log?: (s: string) => void }
/** The legacy rows come from SQL Server, or from a snapshot already read (the CSV export the report parity check uses). */
export type CalendarImportDeps = CalendarImportBase & ({ source: LegacySource; snapshot?: undefined } | { snapshot: LegacySnapshot; source?: undefined });
```

In `body`: `const s = deps.snapshot !== undefined ? deps.snapshot : await loadLegacy(deps.source, scopeOpts);`. If TypeScript doesn't narrow `deps.source` there, use `"snapshot" in deps && deps.snapshot ? … : …` with the same meaning. Don't add a non-null assertion.

`balanceScope` starts with:

```ts
const REPORT_TABLE: Record<OptionalTable, string> = { users: "users", userMinistries: "userMinistries", savedFilters: "savedFilters", favourites: "favourites", files: "files", logs: "logRows" };
// …
  for (const t of s.provenance?.notProvided ?? []) report.notProvided(REPORT_TABLE[t], "not in the snapshot");
  for (const n of s.provenance?.notes ?? []) report.note(n);
```

In `recordFacts`, wrap the user facts (`usersWithoutEmail`, `usersWithInvalidEmail`, `duplicateEmailGroups`, `commContactsOfInactiveUsers`) in `if (usersAreReal)`, and the two history facts in `if (!missing.has("logs"))`, where:

```ts
  const missing = new Set(s.provenance?.notProvided ?? []);
  const usersAreReal = !missing.has("users") && s.provenance?.usersFromCommContacts !== true;
```

- [ ] **Step 11: Write the Core seed for throwaway databases**

Create `scripts/lib/calendar-parity-core.ts`:

```ts
import type { Db } from "@gcpe/db-kit";
import type { LegacyKeyRows } from "../../apps/calendar/src/import/csv-snapshot";
import { HQ_ABBREVIATIONS, upsertOrganization } from "../../apps/core/src/services/organizations";
import { upsertTerm } from "../../apps/core/src/services/terms";
import { healthOrg } from "../../apps/core/test/helpers";

const SOCIAL = { twitterUsername: "", flickrUrl: null, youtubeUrl: null, audioUrl: null };
const HQ = new Set<string>(HQ_ABBREVIATIONS);

/**
 * Fills a throwaway Core (the report parity check's own database, never a real one) with legacy's
 * ministries, sectors, themes and tags under their legacy GUIDs and keys, so the importer's key
 * check passes. The organisation template is the fictional healthOrg. Returns the GCPEHQ key.
 */
export async function seedCoreFromLegacyKeys(coreDb: Db, keys: LegacyKeyRows): Promise<string> {
  const hq = keys.ministries.filter((m) => (m.Abbreviation ?? "").toUpperCase() === "GCPEHQ");
  if (hq.length !== 1) throw new Error(`expected one GCPEHQ ministry, found ${hq.length}`);
  for (const [i, m] of keys.ministries.entries()) {
    const abbreviation = m.Abbreviation;
    await upsertOrganization(
      coreDb,
      { ...healthOrg, key: m.Key, displayName: m.DisplayName, abbreviation, sortOrder: i, isActive: m.IsActive, sectorKeys: [] },
      [],
      { legacyId: m.Id.toLowerCase(), isHqOnCreate: HQ.has((abbreviation ?? "").toUpperCase()) },
    );
  }
  for (const [kind, rows] of [["sector", keys.sectors], ["theme", keys.themes], ["tag", keys.tags]] as const) {
    for (const [i, t] of rows.entries()) {
      await upsertTerm(coreDb, { kind, key: t.Key, displayName: t.DisplayName, sortOrder: t.SortOrder ?? i, isActive: t.IsActive, social: SOCIAL }, [], { legacyId: t.Id.toLowerCase() });
    }
  }
  return hq[0]!.Key;
}
```

- [ ] **Step 12: Run every importer test, then type-check**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/import`
Expected: PASS. Every existing test is unchanged, plus the new ones.

Run: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: no errors.

- [ ] **Step 13: Commit**

```bash
git add apps/calendar/src/import/legacy-rows.ts apps/calendar/src/import/csv-snapshot.ts apps/calendar/src/import/csv-snapshot.test.ts apps/calendar/src/import/report.ts apps/calendar/src/import/report.test.ts apps/calendar/src/import/run.ts apps/calendar/src/import/run.test.ts apps/calendar/test/legacy-csv-fixture.ts scripts/lib/calendar-parity-core.ts
git commit -m "feat(calendar-import): read survey 08's CSV snapshot; report tables it lacks as not provided"
```

---

### Task 2: Row text in the report comparison

**Risk:** low-risk (light review). It is a pure function on extracted text, and only writes to `--out`.

**Files:**
- Modify: `apps/calendar/test/pdf-text.ts`, `scripts/calendar-report-compare.ts`, `tests/calendar-report-compare.test.ts`

**Interfaces:**
- Consumes: `PdfPage`, `pdfPages`, `outlineOf` (`apps/calendar/test/pdf-text.ts`); `diffOutlines` (same script).
- Produces:
  - `pdf-text.ts`: `outlineToken(text: string): string | null`, `activityIdOf(url: string): number | null`.
  - `calendar-report-compare.ts`: `rowTextsOf(pages: PdfPage[]): Map<string, string>`, `interface RowCounts { same: number; differ: number; onlyLegacy: number; onlyOurs: number }`, `compareRowTexts(legacy, ours): { counts: RowCounts; lines: string[] }`.
  - `compareReports(...)` now returns `{ same: boolean; diff: string[]; rows: RowCounts }`. `same` is true only when the outline and every row match. It writes `rows-legacy.txt`, `rows-new.txt` and `rows-diff.txt` next to the outline files.

- [ ] **Step 1: Write the failing tests**

Add to `tests/calendar-report-compare.test.ts` (extend the import from `../scripts/calendar-report-compare` with `compareRowTexts, rowTextsOf`, and add `import type { PdfPage } from "../apps/calendar/test/pdf-text";`):

```ts
const page = (lines: [number, string][], links: [number, number][] = []): PdfPage => ({
  size: [612, 792],
  lines: lines.map(([y, text]) => ({ y, text })),
  links: links.map(([y, id]) => ({ y, url: `https://staff.example.test/hub/calendar/activities/${id}` })),
});

describe("row texts (spec addendum §12.3: the row text with whitespace normalised)", () => {
  it("gives each line to the activity link at or above it, carries a row across a page, and drops furniture, headings and the cover", () => {
    const pages = [
      page([[700, "Contents:"], [600, "Sample cover"]]),
      page([[760, "SAMPLE HEADER"], [700, "Monday, March 3, 2031"], [650, "SAMPLE-1  Sample   one"], [630, "more of one"], [600, "SAMPLE-2 Sample two"], [40, "Printed Sample Page 1 of 3"]], [[652, 1], [602, 2]]),
      page([[760, "SAMPLE HEADER"], [740, "two continues"], [650, "SAMPLE-1 Sample one again"], [40, "Printed Sample Page 2 of 3"]], [[652, 1]]),
      page([[760, "SAMPLE HEADER"], [650, "IN THE NEWS"], [40, "Printed Sample Page 3 of 3"]]),
    ];
    expect(Object.fromEntries(rowTextsOf(pages))).toEqual({
      "id:1#1": "SAMPLE-1 Sample one more of one",
      "id:2#1": "SAMPLE-2 Sample two two continues",
      "id:1#2": "SAMPLE-1 Sample one again",
    });
  });

  it("compares by activity and occurrence, with word-level changes", () => {
    const legacy = new Map([["id:1#1", "Sample one updated 2 days ago"], ["id:2#1", "Sample two"], ["id:3#1", "Sample three"]]);
    const ours = new Map([["id:1#1", "Sample one Last updated 2 days ago"], ["id:2#1", "Sample two"], ["id:4#1", "Sample four"]]);
    const r = compareRowTexts(legacy, ours);
    expect(r.counts).toEqual({ same: 1, differ: 1, onlyLegacy: 1, onlyOurs: 1 });
    expect(r.lines).toEqual([
      "~ id:1#1: + Last",
      "- id:3#1",
      "+ id:4#1",
    ]);
  });
});
```

Change the existing PDF test's expectations: identical PDFs give `same: true` with `rows: { same: 2, differ: 0, onlyLegacy: 0, onlyOurs: 0 }`. For the differing pair, add `expect(r.rows).toMatchObject({ same: 1, onlyLegacy: 1, onlyOurs: 1 })` and `expect(readFileSync(join(dir, "differ", "rows-legacy.txt"), "utf8")).toBe("id:1#1\tSample 1 HLTH-1\nid:2#1\tSample 2 HLTH-2\n")`.

The word diff is `diffOutlines` on words. Legacy's `… one updated 2 days ago` against our `… one Last updated 2 days ago` is one insertion, `+ Last`. The format is `~ <key>: <changes>`, where the changes are the non-equal diff tokens joined by single spaces.

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run tests/calendar-report-compare.test.ts`
Expected: FAIL with "rowTextsOf is not a function" (not exported).

- [ ] **Step 3: Export the outline pieces from `pdf-text.ts`**

In `apps/calendar/test/pdf-text.ts`, add these and make `outlineOf` use them (same behaviour):

```ts
/** A section, day or month heading as its outline token, or null for any other line. */
export function outlineToken(text: string): string | null {
  const day = DAY.exec(text);
  if (SECTIONS.includes(text.toLowerCase())) return `§ ${text.toUpperCase()}`;
  if (day) return `${day[1] ? "∅" : "#"} ${day[2]}`;
  if (MONTH.test(text)) return `# ${text}`;
  return null;
}
/** The activity a link opens, ours or legacy's, or null. */
export function activityIdOf(url: string): number | null {
  const m = ACTIVITY_LINK.exec(url);
  return m ? Number(m[1]) : null;
}
```

- [ ] **Step 4: Add row texts to the comparison**

In `scripts/calendar-report-compare.ts` (extend the import from `pdf-text` with `activityIdOf, outlineToken, type PdfPage`):

```ts
/** A line's top may sit this many points above its row's link. */
const ROW_TOLERANCE = 3;
const PAGE_OF = /\s*Page \d+ of \d+$/;
const normalise = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Each activity row's text, keyed "id:<n>#<occurrence>" (the Look Ahead repeats a multi-day row): every
 * line goes to the nearest activity link at or above it, and lines above a page's first link continue
 * the previous page's last row. Dropped: the cover, headings (outline tokens), and page furniture,
 * meaning a line (less any "Page N of M") on at least half the body pages and on 3 or more.
 */
export function rowTextsOf(pages: PdfPage[]): Map<string, string> {
  const body = pages.filter((p) => !p.lines.some((l) => l.text === "Contents:"));
  const strip = (t: string) => t.replace(PAGE_OF, "").trim();
  const seen = new Map<string, number>();
  for (const p of body) for (const t of new Set(p.lines.map((l) => strip(l.text)))) seen.set(t, (seen.get(t) ?? 0) + 1);
  const furniture = (t: string) => t === "" || ((seen.get(t) ?? 0) >= 3 && (seen.get(t) ?? 0) * 2 >= body.length);
  const out = new Map<string, string[]>();
  const occurrences = new Map<number, number>();
  let carried: string | null = null;
  for (const p of body) {
    const keyed = p.links
      .map((l) => ({ y: l.y, id: activityIdOf(l.url) }))
      .filter((l): l is { y: number; id: number } => l.id !== null)
      .sort((a, b) => b.y - a.y)
      .map((l) => {
        const n = (occurrences.get(l.id) ?? 0) + 1;
        occurrences.set(l.id, n);
        const key = `id:${l.id}#${n}`;
        out.set(key, []);
        return { y: l.y, key };
      });
    for (const line of [...p.lines].sort((a, b) => b.y - a.y)) {
      const text = strip(line.text);
      if (furniture(text) || outlineToken(line.text) !== null) continue;
      const owner = keyed.filter((k) => k.y + ROW_TOLERANCE >= line.y).at(-1)?.key ?? carried;
      if (owner) out.get(owner)!.push(text);
    }
    if (keyed.length) carried = keyed.at(-1)!.key;
  }
  return new Map([...out].map(([k, v]) => [k, normalise(v.join(" "))]));
}

export interface RowCounts { same: number; differ: number; onlyLegacy: number; onlyOurs: number }
/** Row by row, in legacy's order then ours: "~ key: word changes", "- key" only in legacy, "+ key" only in ours. */
export function compareRowTexts(legacy: Map<string, string>, ours: Map<string, string>): { counts: RowCounts; lines: string[] } {
  const counts: RowCounts = { same: 0, differ: 0, onlyLegacy: 0, onlyOurs: 0 };
  const lines: string[] = [];
  for (const [key, text] of legacy) {
    const mine = ours.get(key);
    if (mine === undefined) { counts.onlyLegacy++; lines.push(`- ${key}`); continue; }
    if (mine === text) { counts.same++; continue; }
    counts.differ++;
    lines.push(`~ ${key}: ${diffOutlines(text.split(" "), mine.split(" ")).filter((l) => !l.startsWith("  ")).join(" ")}`);
  }
  for (const key of ours.keys()) if (!legacy.has(key)) { counts.onlyOurs++; lines.push(`+ ${key}`); }
  return { counts, lines };
}
```

In `compareReports`:
- Read each PDF's pages once.
- Compute the outlines from those pages, and `rowTextsOf` for each.
- Write `rows-legacy.txt` and `rows-new.txt` as `key\ttext` lines, and `rows-diff.txt` as the comparison's lines.
- Return `{ same: diff.every(...) && rows.differ + rows.onlyLegacy + rows.onlyOurs === 0, diff, rows }`.

Update the CLI's message: `The outlines differ in N lines; rows: D differ, L only in legacy, O only in ours: see diff.txt and rows-diff.txt.` Update the header comment's last sentence: the script writes the two outlines, the two row-text files and their differences, and nothing else.

- [ ] **Step 5: Run to green, then type-check**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run tests/calendar-report-compare.test.ts apps/calendar/src/reports/golden.test.ts`
Expected: PASS. The golden tests still use `outlineOf` unchanged.

Run: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/calendar/test/pdf-text.ts scripts/calendar-report-compare.ts tests/calendar-report-compare.test.ts
git commit -m "feat(calendar-reports): compare each activity row's text, not only the outline"
```

---

### Task 3: The parity runner

**Risk:** confidentiality (full review). It is the only code that touches the real files, and it must never write outside `--out` or leave real data in a database.

**Files:**
- Create: `scripts/calendar-report-parity.ts`, `tests/calendar-report-parity.test.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes:
  - `snapshotFromCsv`, `CsvFile`, `CsvSnapshotError` (Task 1);
  - `seedCoreFromLegacyKeys` (Task 1);
  - `runCalendarImport` with `snapshot` (Task 1);
  - `compareReports` returning `{ same, diff, rows }`, plus `insideRepo` (Task 2);
  - `republishAll` (`apps/core/src/services/republish.ts`);
  - `projectionHandler` (`apps/calendar/src/projections.ts`);
  - `reportData` (`apps/calendar/src/reports/data.ts`);
  - `buildReport` (`apps/calendar/src/reports/build.ts`);
  - `renderPdf`, `useBcSans` (`render/pdf.ts`), `reportAssets` (`render/assets.ts`);
  - `rulesFromTenant` (`apps/calendar/src/rules.ts`), `loadTenantConfig` (`@gcpe/config`);
  - `createTestDatabase` (`@gcpe/db-kit`), `outboxEvents` (`@gcpe/events`), `localStore` (`@gcpe/storage`).
- Produces:
  - `parseParityArgs(argv: string[]): ParityOptions` and `class ParityArgumentError`;
  - `parsePdfDate(raw: string): Date | null` and `pdfCreatedAt(path: string): Promise<Date | null>`;
  - `projectCoreIntoCalendar(coreDb: Db, calDb: Db): Promise<number>`;
  - `runParity(o: ParityOptions): Promise<ParityResult>`;
  - `REPORTS`;
  - npm script `calendar:report-parity`.
  - Output layout under `--out`:
    - `import-report.json` and `import-report.txt`;
    - `ours/<legacy file name>`;
    - `compare/<kind>/{outline-legacy,outline-new,diff,rows-legacy,rows-new,rows-diff}.txt`;
    - `store/`, which stays empty;
    - `summary.json` (counts only).

- [ ] **Step 1: Write the failing tests**

Create `tests/calendar-report-parity.test.ts`:

```ts
// The report parity runner on the fictional CSV fixture: real legacy files never enter the repo.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { legacyCsvFiles, partCFile } from "../apps/calendar/test/legacy-csv-fixture";
import { outlineOf, pdfPages } from "../apps/calendar/test/pdf-text";
import { reportAssets } from "../apps/calendar/src/reports/render/assets";
import { renderPdf, useBcSans } from "../apps/calendar/src/reports/render/pdf";
import { parsePdfDate, parseParityArgs, REPORTS, runParity, type ParityOptions } from "../scripts/calendar-report-parity";

const BC = resolve(import.meta.dirname, "..", "config", "tenants", "bc.json");
let dir: string;
let options: (over: Partial<ParityOptions>) => ParityOptions;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "report-parity-"));
  const csv = legacyCsvFiles().map((f) => { const p = join(dir, f.name); writeFileSync(p, f.bytes); return p; });
  writeFileSync(join(dir, "part-c.csv"), partCFile().bytes);
  mkdirSync(join(dir, "legacy-empty"));
  useBcSans(reportAssets().fontsDir);
  const empty = await renderPdf({ page: "letter-portrait", title: "Sample", header: null, footer: { pageNumbers: true }, blocks: [{ kind: "heading", runs: [{ text: "Sample" }], size: 12 }] });
  for (const r of REPORTS) writeFileSync(join(dir, "legacy-empty", r.legacy), empty);
  options = (over) => ({
    csv, partC: join(dir, "part-c.csv"), legacyDir: join(dir, "legacy-empty"), out: join(dir, "out"),
    cutoff: "2031-03-01", from: "2031-03-03", to: "2031-03-05", to90: "2031-05-31",
    now: new Date("2031-03-06T17:00:00Z"), keepDbs: false, tenantConfig: BC, ...over,
  });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the report parity runner (spec addendum §12.3)", () => {
  it("reads its arguments, and refuses a range that starts before the cutoff", () => {
    const base = ["--csv", "a.csv", "--csv", "b.csv", "--legacy-dir", "l", "--out", "/tmp/o", "--cutoff", "2031-03-01", "--from", "2031-03-03", "--to", "2031-03-05", "--to-30-60-90", "2031-05-31"];
    expect(parseParityArgs(base)).toMatchObject({ csv: ["a.csv", "b.csv"], partC: null, now: null, keepDbs: false });
    expect(parseParityArgs([...base, "--part-c", "c.csv", "--now", "2031-03-06T17:00:00Z", "--keep-dbs"])).toMatchObject({ partC: "c.csv", keepDbs: true, now: new Date("2031-03-06T17:00:00Z") });
    expect(() => parseParityArgs(base.map((a) => (a === "2031-03-03" ? "2031-02-27" : a)))).toThrow(/--from must be on or after --cutoff/);
    expect(() => parseParityArgs(base.filter((a) => a !== "--csv" && a !== "a.csv" && a !== "b.csv"))).toThrow(/--csv/);
    expect(() => parseParityArgs([...base, "--confirm"])).toThrow(/Unknown argument/);
  });

  it("reads a PDF creation date as SSRS writes it", () => {
    expect(parsePdfDate("D:20310303081240-07'00'")).toEqual(new Date("2031-03-03T15:12:40Z"));
    expect(parsePdfDate("D:20310303081240Z")).toEqual(new Date("2031-03-03T08:12:40Z"));
    expect(parsePdfDate("yesterday")).toBeNull();
  });

  it("refuses an --out inside the repository before it reads or creates anything", async () => {
    await expect(runParity(options({ out: resolve(import.meta.dirname, "..", "docs", "parity-out") }))).rejects.toThrow(/outside the repository/);
  });

  it("imports the snapshot, renders our four reports, compares each with legacy's, and writes only under --out", async () => {
    const log: string[] = [];
    const first = await runParity({ ...options({}), log: (s) => log.push(s) });
    expect(first.activities).toBe(5);
    expect(first.reports.map((r) => r.kind)).toEqual(["look-ahead", "exec-look-ahead", "planning", "30-60-90"]);
    expect(first.reports.every((r) => !r.same)).toBe(true);
    const out = join(dir, "out");
    expect(statSync(out).mode & 0o777).toBe(0o700);
    expect(readdirSync(out).sort()).toEqual(["compare", "import-report.json", "import-report.txt", "ours", "store", "summary.json"]);
    expect(readFileSync(join(out, "import-report.txt"), "utf8")).toContain("Not provided: favourites");
    const la = outlineOf(await pdfPages(new Uint8Array(readFileSync(join(out, "ours", "LookAhead.pdf")))));
    expect(la).toContain("id:41001");
    expect(la).not.toContain("id:41003");
    expect(log.at(-1)).toBe("Dropped the throwaway databases.");

    const same = join(dir, "legacy-ours");
    mkdirSync(same);
    for (const r of REPORTS) copyFileSync(join(out, "ours", r.legacy), join(same, r.legacy));
    const second = await runParity(options({ legacyDir: same, out: join(dir, "out-2") }));
    expect(second.reports.map((r) => [r.kind, r.same, r.outlineChanges, r.rows.differ])).toEqual(REPORTS.map((r) => [r.kind, true, 0, 0]));
  }, 180_000);

  it("a failed run still drops its databases", async () => {
    const log: string[] = [];
    await expect(runParity({ ...options({ legacyDir: join(dir, "missing"), out: join(dir, "out-3"), now: null }), log: (s) => log.push(s) })).rejects.toThrow();
    expect(log.at(-1)).toBe("Dropped the throwaway databases.");
  }, 120_000);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run tests/calendar-report-parity.test.ts`
Expected: FAIL with "Failed to load url ../scripts/calendar-report-parity".

- [ ] **Step 3: Write the runner**

Create `scripts/calendar-report-parity.ts`:

```ts
#!/usr/bin/env -S node --
// The report parity check (spec addendum §12.3) on legacy's survey-08 Part B export: the CSV
// snapshot goes into throwaway Core and Calendar databases, our four reports are rendered for the
// legacy PDFs' range and filter as an HQ System Administrator, and each pair is compared.
//
// Usage:
//   npm run calendar:report-parity -- --csv <file> [--csv <file> …] [--part-c <file>] --legacy-dir <folder>
//     --out <folder> --cutoff <date> --from <date> --to <date> --to-30-60-90 <date> [--now <ISO>] [--keep-dbs]
//
// The CSVs and legacy PDFs hold real activities and people. Everything this writes goes under --out,
// which must be outside this repository (mode 700). The databases are dropped at the end, also on
// failure. It prints counts and file names only. Exit code 0 when every pair matches, 1 when any
// differs, 2 on an error.
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { asc } from "drizzle-orm";
import { getDocumentProxy } from "unpdf";
import { CALENDAR_LEVELS } from "@gcpe/auth";
import { bcDateSchema, listQuerySchema, type ReportKind } from "@gcpe/calendar-contract";
import { loadTenantConfig } from "@gcpe/config";
import { createTestDatabase, type Db } from "@gcpe/db-kit";
import { outboxEvents, type EventEnvelope } from "@gcpe/events";
import { safeErrorLabel } from "@gcpe/http-kit";
import { localStore } from "@gcpe/storage";
import type { CalendarActor } from "../apps/calendar/src/actor";
import { CsvSnapshotError, snapshotFromCsv, type CsvFile } from "../apps/calendar/src/import/csv-snapshot";
import { runCalendarImport } from "../apps/calendar/src/import/run";
import { projectionHandler } from "../apps/calendar/src/projections";
import { buildReport } from "../apps/calendar/src/reports/build";
import { reportData } from "../apps/calendar/src/reports/data";
import { reportAssets } from "../apps/calendar/src/reports/render/assets";
import { renderPdf, useBcSans } from "../apps/calendar/src/reports/render/pdf";
import { rulesFromTenant } from "../apps/calendar/src/rules";
import { republishAll } from "../apps/core/src/services/republish";
import { compareReports, insideRepo, type RowCounts } from "./calendar-report-compare";
import { seedCoreFromLegacyKeys } from "./lib/calendar-parity-core";

const ROOT = resolve(import.meta.dirname, "..");
const CAL_MIGRATIONS = join(ROOT, "apps", "calendar", "migrations");
const CORE_MIGRATIONS = join(ROOT, "apps", "core", "migrations");
/** Our rows link here; only the path matters to the comparison. */
const ORIGIN = "https://calendar-parity.example.test";

/** The four reports and the legacy file each is compared with. The 30-60-90 runs to --to-30-60-90. */
export const REPORTS: readonly { kind: ReportKind; legacy: string }[] = [
  { kind: "look-ahead", legacy: "LookAhead.pdf" },
  { kind: "exec-look-ahead", legacy: "ExecLookAhead.pdf" },
  { kind: "planning", legacy: "Planning.pdf" },
  { kind: "30-60-90", legacy: "30-60-90.pdf" },
];

export interface ParityOptions {
  csv: string[]; partC: string | null; legacyDir: string; out: string;
  cutoff: string; from: string; to: string; to90: string;
  /** "Now" for every report; null takes each legacy PDF's creation date. */
  now: Date | null; keepDbs: boolean; tenantConfig: string;
  log?: (s: string) => void;
}
export interface ParityResult { activities: number; reports: { kind: ReportKind; same: boolean; outlineChanges: number; rows: RowCounts }[] }
/** A bad command line: its message is ours, safe to print. */
export class ParityArgumentError extends Error { override name = "ParityArgumentError"; }

export function parseParityArgs(argv: string[]): ParityOptions {
  const o: Partial<ParityOptions> & { csv: string[] } = { csv: [], partC: null, now: null, keepDbs: false, tenantConfig: join(ROOT, "config", "tenants", "bc.json") };
  const value = (i: number, name: string) => { const v = argv[i]; if (!v || v.startsWith("--")) throw new ParityArgumentError(`${name} needs a value`); return v; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--csv") o.csv.push(value(++i, a));
    else if (a === "--part-c") o.partC = value(++i, a);
    else if (a === "--legacy-dir") o.legacyDir = value(++i, a);
    else if (a === "--out") o.out = value(++i, a);
    else if (a === "--cutoff") o.cutoff = value(++i, a);
    else if (a === "--from") o.from = value(++i, a);
    else if (a === "--to") o.to = value(++i, a);
    else if (a === "--to-30-60-90") o.to90 = value(++i, a);
    else if (a === "--tenant") o.tenantConfig = value(++i, a);
    else if (a === "--keep-dbs") o.keepDbs = true;
    else if (a === "--now") { const d = new Date(value(++i, a)); if (Number.isNaN(d.getTime())) throw new ParityArgumentError("--now must be an ISO date and time"); o.now = d; }
    else throw new ParityArgumentError(`Unknown argument: ${a}`);
  }
  if (o.csv.length === 0) throw new ParityArgumentError("--csv <file> is required (once per file)");
  for (const k of ["legacyDir", "out"] as const) if (!o[k]) throw new ParityArgumentError(`--${k === "legacyDir" ? "legacy-dir" : "out"} is required`);
  for (const [k, flag] of [["cutoff", "--cutoff"], ["from", "--from"], ["to", "--to"], ["to90", "--to-30-60-90"]] as const) {
    if (!o[k] || !bcDateSchema.safeParse(o[k]).success) throw new ParityArgumentError(`${flag} must be a real date, YYYY-MM-DD`);
  }
  if (o.from! < o.cutoff!) throw new ParityArgumentError("--from must be on or after --cutoff, so both sides hold the same activities");
  if (o.to! < o.from! || o.to90! < o.from!) throw new ParityArgumentError("--to and --to-30-60-90 must be on or after --from");
  return o as ParityOptions;
}

/** A PDF date ("D:YYYYMMDDHHmmSS-07'00'", or …Z) as an instant, or null. */
export function parsePdfDate(raw: string): Date | null {
  const m = /^D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:(Z)|([+-])(\d{2})'(\d{2})'?)?$/.exec(raw.trim());
  if (!m) return null;
  const utc = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
  const offset = m[8] ? (m[8] === "-" ? -1 : 1) * (+m[9]! * 60 + +m[10]!) : 0;
  return new Date(utc - offset * 60_000);
}
export async function pdfCreatedAt(path: string): Promise<Date | null> {
  const pdf = await getDocumentProxy(new Uint8Array(readFileSync(path)), { verbosity: 0 });
  const info = (await pdf.getMetadata()).info as { CreationDate?: unknown };
  return typeof info.CreationDate === "string" ? parsePdfDate(info.CreationDate) : null;
}

/** Core's organisations, terms and users into the Calendar's projections, through the real events, in process. */
export async function projectCoreIntoCalendar(coreDb: Db, calDb: Db): Promise<number> {
  await republishAll(coreDb, []);
  const rows = await coreDb.select({ envelope: outboxEvents.envelope }).from(outboxEvents).orderBy(asc(outboxEvents.aggregateId), asc(outboxEvents.sequence));
  let applied = 0;
  for (const { envelope } of rows) {
    const e = envelope as EventEnvelope;
    const handle = projectionHandler(e);
    if (!handle) continue;
    await calDb.transaction((tx) => handle(tx, e));
    applied++;
  }
  return applied;
}

const readFile = (p: string): CsvFile => ({ name: basename(p), bytes: new Uint8Array(readFileSync(p)) });

export async function runParity(o: ParityOptions): Promise<ParityResult> {
  const log = o.log ?? (() => {});
  if (insideRepo(o.out)) throw new ParityArgumentError("--out must be outside the repository: the run holds real activities");
  mkdirSync(o.out, { recursive: true, mode: 0o700 });
  chmodSync(o.out, 0o700);
  const { snapshot, keys, encodings, ignoredSections } = snapshotFromCsv(o.csv.map(readFile), { partC: o.partC ? readFile(o.partC) : undefined, usersFromCommContacts: true });
  log(`Read ${snapshot.activities.length} activities from ${o.csv.length} files (${Object.entries(encodings).map(([f, e]) => `${f}: ${e}`).join("; ")}). Ignored sections: ${ignoredSections.join(", ") || "none"}.`);
  const rules = rulesFromTenant(loadTenantConfig(o.tenantConfig));
  const cal = await createTestDatabase({ migrationsFolder: CAL_MIGRATIONS });
  const core = await createTestDatabase({ migrationsFolder: CORE_MIGRATIONS }).catch(async (e: unknown) => { await cal.drop(); throw e; });
  try {
    const hqKey = await seedCoreFromLegacyKeys(core.db, keys);
    mkdirSync(join(o.out, "store"), { recursive: true, mode: 0o700 });
    const report = await runCalendarImport({ db: cal.db, coreDb: core.db, snapshot, store: localStore(join(o.out, "store")), rules, coreSubscribers: [] }, { cutoff: o.cutoff, confirm: true });
    writeFileSync(join(o.out, "import-report.json"), JSON.stringify(report.toJSON(), null, 2));
    writeFileSync(join(o.out, "import-report.txt"), report.toText());
    const inserted = report.toJSON().tables.activities?.inserted ?? 0;
    log(`Imported ${inserted} of ${snapshot.activities.length} activities (${report.balanced() ? "balanced" : "NOT BALANCED"}).`);
    if (!report.balanced() || inserted !== snapshot.activities.length) throw new Error("the import didn't take every activity: see import-report.txt");
    log(`Projected ${await projectCoreIntoCalendar(core.db, cal.db)} Core events into the Calendar.`);

    const actor: CalendarActor = { userId: randomUUID(), displayName: "Parity runner", role: "Calendar.SysAdmin", level: CALENDAR_LEVELS["Calendar.SysAdmin"], ministryKeys: [hqKey], isHq: true };
    useBcSans(reportAssets().fontsDir);
    mkdirSync(join(o.out, "ours"), { recursive: true, mode: 0o700 });
    const reports: ParityResult["reports"] = [];
    for (const r of REPORTS) {
      const legacy = join(o.legacyDir, r.legacy);
      const now = o.now ?? (await pdfCreatedAt(legacy));
      if (!now) throw new ParityArgumentError(`${r.legacy} has no creation date: pass --now`);
      const q = listQuerySchema.parse({ filter: { from: o.from, to: r.kind === "30-60-90" ? o.to90 : o.to } });
      const data = await reportData({ db: cal.db, rules, subscribers: [], now: () => now }, actor, q);
      const ours = join(o.out, "ours", r.legacy);
      writeFileSync(ours, await renderPdf(buildReport(r.kind, data, ORIGIN)));
      const c = await compareReports({ legacy, ours, out: join(o.out, "compare", r.kind) });
      reports.push({ kind: r.kind, same: c.same, outlineChanges: c.diff.filter((l) => !l.startsWith("  ")).length, rows: c.rows });
      log(`${r.kind}: ${data.rows.length} activities read; ${c.same ? "matches" : "differs"}.`);
    }
    const result: ParityResult = { activities: snapshot.activities.length, reports };
    writeFileSync(join(o.out, "summary.json"), JSON.stringify(result, null, 2));
    return result;
  } finally {
    if (o.keepDbs) log(`Kept the databases: ${new URL(cal.url).pathname.slice(1)} and ${new URL(core.url).pathname.slice(1)}. They hold real data: drop them when done.`);
    else { await Promise.all([cal.drop(), core.drop()]); log("Dropped the throwaway databases."); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const r = await runParity({ ...parseParityArgs(process.argv.slice(2)), log: console.log });
    for (const x of r.reports) console.log(`${x.kind}: ${x.same ? "matches" : `${x.outlineChanges} outline lines differ; rows: ${x.rows.differ} differ, ${x.rows.onlyLegacy} only in legacy, ${x.rows.onlyOurs} only in ours`}`);
    process.exitCode = r.reports.every((x) => x.same) ? 0 : 1;
  } catch (e) {
    console.error(e instanceof ParityArgumentError || e instanceof CsvSnapshotError ? e.message : safeErrorLabel(e));
    process.exitCode = 2;
  }
}
```

The `insideRepo` check comes before anything is read or created, so a refused `--out` never creates a database.

- [ ] **Step 4: Add the npm script**

In `package.json` scripts, after `calendar:report-compare`:

```json
    "calendar:report-parity": "tsx scripts/calendar-report-parity.ts",
```

- [ ] **Step 5: Run to green, then type-check**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run tests/calendar-report-parity.test.ts tests/calendar-report-compare.test.ts`
Expected: PASS.

If the second run ("legacy-ours") doesn't match, the cause is non-determinism in our own render: a time read outside `now`, or an unordered query. Find it and fix the runner or the renderer. Don't loosen the test.

Run: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add scripts/calendar-report-parity.ts tests/calendar-report-parity.test.ts package.json
git commit -m "feat(calendar-reports): npm run calendar:report-parity, from a CSV snapshot to compared PDFs"
```

---

### Task 4: The run on the June 2026 inputs, and what the differences mean

**Risk:** confidentiality (full review). It runs on real personal and confidential data, and only sanitised counts may enter the repo. **Done by the controller, or an implementer told these rules verbatim.** Paul approved going ahead. No push.

**Files:**
- Create: `docs/parity/calendar-report-parity.md` (sanitised)
- Modify: `docs/parity/open-questions.md` (Q50; Q100; new Qs from Q101), the spec's §15 Q50 row (`docs/superpowers/specs/2026-10-07-calendar-parity-design.md`), `docs/parity/changes-from-legacy.md` (new rows from C211), `docs/manuals/running-notes.md`, `docs/superpowers/plans/phase-5-carry-forward.md` ("## 5i parity check")
- Possibly modify, for small fixes under ruling 20: `apps/calendar/src/reports/*.ts`, with their fictional tests

**Interfaces:**
- Consumes: `npm run calendar:report-parity` (Task 3); `rows-diff.txt` and `diff.txt` (Task 2).
- Produces: the private differences report `~/gcpe-parity-private/2026-10-15-june/differences.md`, and the sanitised summary.

**Data rules for this task** (repeat them to any implementer):
- Never print a cell, a title, a name, a contact or a row text to the terminal or a transcript. Read the private files with tools that show only counts, or open them yourself privately and write only categories and counts into anything that leaves `~/gcpe-parity-private`.
- Never `git add` anything from `~/gcpe-parity-private`, and never copy a real value into a test. A fix's test uses the fictional fixtures.
- Pass the inputs as explicit files. `~/Downloads` also holds the older v1 export (`08-8.10.csv`, `08-8.11-08-8.19.csv`, `08-8.20.csv`, `08-8.30-08-8.44.csv`). Don't use those.

- [ ] **Step 1: Preconditions**

Run: `git log --oneline -3`. Expected: Tasks 1–3 committed.
Run: `npx -y -p node@24 -- node -v`. Expected: `v24.x`.
Run: `pg_isready`. Expected: accepting connections.
Run: `ls -ld ~/gcpe-parity-private`. Expected: `drwx------`.

- [ ] **Step 2: Run the parity check**

```bash
OUT=~/gcpe-parity-private/2026-10-15-june
D=~/Downloads
npx -y -p node@24 -- npm run calendar:report-parity -- \
  --csv "$D/08-8.10 1.csv" --csv "$D/08-8.11-08-8.19 1.csv" --csv "$D/08-8.20 1.csv" --csv "$D/08-8.30-08-8.46.csv" \
  --part-c "$D/PartC-08-8.10.csv" --legacy-dir "$D" --out "$OUT" \
  --cutoff 2026-06-01 --from 2026-06-01 --to 2026-06-30 --to-30-60-90 2026-08-31 \
  > ~/gcpe-parity-private/2026-10-15-june.log 2>&1; echo "exit $?"; cat ~/gcpe-parity-private/2026-10-15-june.log
```

The log holds file names and counts only (Task 3's design), so printing it is allowed.

Expected:
- the exit code is 1 (differences) or 0;
- "Read 948 activities from 4 files", with `08-8.10 1.csv: windows-1252` and `08-8.30-08-8.46.csv: windows-1252`;
- "Ignored sections: 8.41";
- "Imported 948 of 948 activities (balanced)";
- four report lines;
- "Dropped the throwaway databases."

Exit code 2 means an error. Its message names a place, never a value. Fix the cause and re-run.

- [ ] **Step 3: Check the import report (counts only)**

Run: `grep -E "^(Calendar import|  (activities|users|commContacts|lookup:)|Not provided|Note:)" ~/gcpe-parity-private/2026-10-15-june/import-report.txt`

Expected:
- activities `legacy=948 … inserted=948`;
- commContacts inserted plus skipped equals 1,205, the skips being "no ministry" (11 contacts have no ministry) or merges;
- five "Not provided" lines, and the two notes.

Do not print the `Skipped:` or `Mapping fallbacks:` sections' reasons beyond their counts: they carry ids only, but keep to counts anyway.

- [ ] **Step 4: Measure each pair (counts only)**

```bash
cat ~/gcpe-parity-private/2026-10-15-june/summary.json
for k in look-ahead exec-look-ahead planning 30-60-90; do
  d=~/gcpe-parity-private/2026-10-15-june/compare/$k
  echo "$k outline: -$(grep -c '^- ' $d/diff.txt) +$(grep -c '^+ ' $d/diff.txt) same=$(grep -c '^  ' $d/diff.txt)  rows: ~$(grep -c '^~ ' $d/rows-diff.txt) -$(grep -c '^- ' $d/rows-diff.txt) +$(grep -c '^+ ' $d/rows-diff.txt)"
done
```

Expected sizes, for orientation:
- The legacy Look Ahead has 483 activity links for 434 ids.
- Planning has 439 links: legacy's June list count, `filters.png`.
- The 30-60-90 has 834 links against legacy's 836 list rows.

- [ ] **Step 5: Categorise, privately**

Write `~/gcpe-parity-private/2026-10-15-june/differences.md`, private, by working through each pair's `diff.txt` and `rows-diff.txt`. Group every differing line into a category.

For bulk work, write a throwaway bucketing script inside `~/gcpe-parity-private`, never in the repo. It groups the `~` lines of `rows-diff.txt` by the shape of their word changes, with digits masked, and prints counts per bucket. Open a few rows per bucket yourself to name the category.

Categories to test first, with the code to read and the C-rows to check:

| Likely category | Where to look | Explained by |
|---|---|---|
| The Exec pair differs wholesale | `ExecLookAhead.pdf` is text-identical to `LookAhead.pdf` (117/117 pages) | Inconclusive under Q100: legacy input missing. Not a difference. |
| "updated X ago" / "Last updated" wording, doubled word | `reports/text.ts` `createdOrUpdated`, `dates.ts` | `legacy-report-layouts.md` discrepancy 5; carry-forward "discrepancy 6" |
| Awareness rows with or without "Last updated" in the Exec | `look-ahead.ts` | carry-forward item 1 (settle it here, or under Q100) |
| A day with no rows (In the News) shown or skipped | `look-ahead.ts` day loop | carry-forward item 2 |
| A section order or page-break position | outline `§` tokens | carry-forward item 3; layout is compared by eye (§12.3) |
| Rows only in legacy | deleted (114 in the snapshot), confidential visibility, filter edges (activities starting before 06-01) | C127 and similar; `listWhere` |
| Rows only in ours | the same; awareness history | R13 |
| A contact name differs | derived users (ruling 7); legacy may print `CommunicationContact.Name` | the runner's derivation, not the product |
| Ordering inside a day or section | `legacyReportOrder` | an org sortOrder the runner set from 8.43's file order (ruling 12): check this before calling it a bug |
| An RLS code or flag text | `text.ts` `minIdRuns` | `legacy-report-layouts.md` discrepancy 3 |
| Q63's Exec Outlook window | `lookAheadRange` | Q63 (an explicit To date makes the Outlook moot here: record that) |

For each category, record in `differences.md`:
- the category name;
- its count per report;
- the evidence: which code line, which legacy behaviour;
- the verdict: **intended** (cite the C-row, or draft a new C-row from C211), **fix** (ruling 20), **follow-up** (a carry-forward item), **runner artefact**, or **inconclusive** (Q100).

- [ ] **Step 6: Fix what ruling 20 allows, test first, then re-run**

For each **fix**:
1. Write a fictional test in the report's existing suite (`look-ahead.test.ts`, `list-reports.test.ts` or `golden.test.ts`) that reproduces the shape.
2. Run it RED, fix it, and run it GREEN.
3. Run `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/reports tests/calendar-report-compare.test.ts tests/calendar-report-parity.test.ts`.
4. Commit each fix on its own: `fix(calendar-reports): …`, with no real values in the message.

Then re-run Step 2 into `~/gcpe-parity-private/2026-10-15-june-2`, and Step 4 on it. Every category marked **fix** must be gone, and nothing new may appear.

- [ ] **Step 7: Write the sanitised summary**

Create `docs/parity/calendar-report-parity.md`. Its sections:
- **Inputs.** Survey 08 v2 Part B. PDFs exported 2026-10-15 08:11–08:14 PDT as legacy role 5 (GCPEHQ SysAdmin). The range is 2026-06-01 to 2026-06-30, and to 2026-08-31 for the 30-60-90; the filter is as in ruling 16. 948 activities, 114 of them deleted. Cutoff 2026-06-01.
- **Snapshot consistency (Q50).** The CSVs were saved about 4 hours after the PDFs. Of the 948 activities, 0 have a `CreatedDateTime` or `LastUpdatedDateTime` after the first PDF's creation. That was checked by count when planning; re-check it by count on the run's snapshot. Assumed: a legacy delete stamps `LastUpdatedDateTime`.
- **Results.** A table of report × outline lines (−/+), rows same/differ/only-legacy/only-ours, before and after fixes.
- **Categories.** A table of category × per-report counts × verdict × C-row, question or fix commit.
- **Not compared.** Layout by eye (§12.3, Q48), the Excel export (ruling 19), and the Exec pair until Q100 is answered.

No titles, names, contacts, activity ids, MIN-Ids or text excerpts.

- [ ] **Step 8: Update the tracking lists**

1. `docs/parity/open-questions.md` Q50: set the answer to what the run settled, and mirror it in the spec's §15 Q50 row.
2. Add Q100 (text under "New open questions" above), and any new questions from Q101.
3. New C-rows in `changes-from-legacy.md` from C211, one per **intended** category no existing row covers.
4. `docs/superpowers/plans/phase-5-carry-forward.md` "## 5i parity check": rewrite it.
   - Each of the four items is settled (with the C-row) or carried with what is still unknown.
   - The 8.20 item is now answered: the v2 export holds it, 342 rows.
   - Add a follow-up for each **follow-up** category.
5. `docs/manuals/running-notes.md`: one line tagged `Operations` on running `npm run calendar:report-parity` with `--out` outside the repo. Add one line per user-visible fix, with its role tag.

- [ ] **Step 9: Leak check before committing**

Run a private check from `~/gcpe-parity-private`, never added to the repo. It:
- reads the 948 titles from `08-8.10 1.csv` with the Task 1 reader;
- keeps titles of 12 or more characters, plus every 8.32 contact name;
- checks whether any of them appears in `git diff --cached` or in any file this task changed;
- prints only the number of hits.

```bash
cd /Users/paul/gcpe-news-platform-5i && git add docs/parity docs/superpowers docs/manuals apps/calendar/src/reports && git diff --cached --stat
# then, from ~/gcpe-parity-private, the leak check:
npx -y -p node@24 -- node --import tsx ~/gcpe-parity-private/leak-check.mts   # run from the repo root so tsx resolves; it imports the reader by absolute path; prints "hits: 0"
```

Expected: `hits: 0`. Any hit means: unstage, remove it, and run the check again.

- [ ] **Step 10: Commit**

```bash
git commit -m "docs(parity): report parity check on the June 2026 legacy snapshot: results, categories and tracking"
```

Then run `npx -y -p node@24 -- npm run test:clean-dbs`, a dry run. Expected: no leftover `test_…` database from the parity runs.

---

## Self-review notes

- **Spec coverage, §12.3:**
  - builds every report as PDF from imported data: Task 3;
  - extracts the text of each, ours and legacy's: Tasks 2 and 3;
  - compares per section the sequence of MIN-Ids and date headings (outline) and the row text, whitespace normalised (rows): Task 2. Each row's flag and RLS code are part of its row text;
  - writes a diff report: Tasks 2 and 3;
  - passes when every difference is explained by a C-row: Task 4;
  - the legacy snapshot at the same moment (Q50): Task 4's consistency check;
  - layout by eye: recorded as not compared;
  - §3 row 5i and acceptance 17: the fixture half by Task 3's identical-pair test, the legacy half by Task 4.
- **Carry-forward "5i parity check":** all four items and the 8.20 note go to Task 4, Steps 5 and 8.
- **Types:**
  - `CsvFile`, `LegacyKeyRows`, `snapshotFromCsv` and `seedCoreFromLegacyKeys` are the same in Tasks 1 and 3.
  - `compareReports` returns `rows: RowCounts` in Task 2, consumed by Task 3.
  - `REPORTS[].legacy` names match the real files: `LookAhead.pdf`, `ExecLookAhead.pdf`, `Planning.pdf`, `30-60-90.pdf`.
- **Known soft spots, for the reviewer:**
  - Task 2's line-to-row rule on SSRS's layout is unproven until Task 4. If legacy rows sit above their link, raise `ROW_TOLERANCE` in Task 4 on evidence, by count of "only text above the first link" lines, and record it.
  - Ruling 12's ministry sort order is a guess at what doesn't matter.
