# Phase 5g: The Corporate Calendar's Reports (PDF) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the activity list's toolbar, staff download the Look Ahead, the 30/60/90 and the Planning report as PDF, and HQ Administrators the Exec Look Ahead too. Each report is built from the list's current query, holds only the activities the user can see, follows legacy's sections, order, columns, colours and running text, and is set in BC Sans. Rendering never blocks the one stack process that serves NRMS, NoD, Distribution, the Calendar and the public site.

**Architecture:**
- **Read, then build, then draw.**
  - `reportData` reads the rows: the list's own `listWhere` without the list's default hides, never a deleted activity, in legacy's order, inside `inReadSnapshot`, through `rowsOf` (so `visibleSql` applies twice).
  - Pure builders (`lookAheadDoc`, `thirtySixtyNinetyDoc`, `planningDoc`) turn the rows into a `ReportDoc`: plain data with headings, tables, colours and breaks, decided by legacy's rules (`ActivityHandler.ashx.cs`).
  - A `PdfRenderer` draws the `ReportDoc`. This is the rendering seam. Today it is pdfmake in a `worker_threads` worker, one fresh worker per report with its own heap limit. A browser renderer on a container host could later draw the same `ReportDoc`.
- **Jobs, so no request waits on a render.** `POST /calendar/api/reports/:report` (body `{ q }`) builds the document and queues it. It waits up to 5 s. If the PDF is ready by then, it answers 201; otherwise 202. `GET /calendar/api/reports/jobs/:id` polls the job, and `GET /calendar/api/reports/jobs/:id/pdf` downloads it.
  - Finished PDFs are held in memory only, for 10 minutes. Only the user who started a job can read it.
  - One render runs at a time, with at most four waiting and two per user. Past that, the answer is 503 with Retry-After.
- **Fonts:** BC Sans from `@bcgov/bc-sans`. Each worker turns the WOFF files into TrueType once, with Node's own zlib, and embeds them as subsets.
- **Artifacts:** the worker is a separate CommonJS bundle, `report-worker.cjs`, with `fonts/` beside it. It sits next to `stack.js` (SiteGround) and next to `main.js` (the per-app images).
- **Staff app:** a "Reports (PDF)" button group after Excel export. It shows "Preparing your … report…" while it polls, then saves the PDF.
- **Parity proof:** golden structure tests render each report in the worker and read it back with a pure-JS PDF reader (`unpdf`). They compare the sequence of sections, day and month headings and activity links with legacy's rules on a fictional fixture. The same reader backs `npm run calendar:report-compare`, the hook 5i uses with the team's past-period PDFs.

**Tech Stack:** Node 24, Express 5, Drizzle on Postgres, zod, pdfmake 0.3.11 (pdfkit 0.19), `worker_threads`, `@bcgov/bc-sans` 2.1.2, unpdf 1.8.1 (tests and the 5i hook only), React 19, `@bcgov/design-system-react-components`, Vitest 4.1 (supertest; jsdom with Testing Library and axe-core), Playwright 1.63 with `@axe-core/playwright`, esbuild.

**Spec:** `docs/superpowers/specs/2026-10-07-calendar-parity-design.md`:
- §3 row 5g. Exit check: "Golden HTML per section from fixtures. Text extracted from both PDF and Word matches the golden activity order. Every report built on boxs.ca." Q48 removes Word, and Task 11 rewrites the check to match what this plan proves.
- §6: the one visibility rule; "Exec Look Ahead: HQ and L ≥ Administrator"; "Reports, Excel export, favourites: any Calendar role; data limited by `visible()`"; the Look Ahead fieldset's rule.
- §7.6: the consultations-ministry inference rule.
- §8.1: the toolbar's report buttons.
- §10, §10.2–§10.5: the reports. §10.1 and Q57: the spike and its boxs.ca results.
- §12.3: the 5i parity check this plan gives a hook to.
- §14: C127, C132, C148. §15: Q48 (answered: PDF only, Paul 2026-10-10).
- §16: the Reports test line, acceptance 2 (the reports part), 10 and 18.
- R6.

The plan also takes these into account:
- `docs/superpowers/plans/phase-5-carry-forward.md` § 5g. It is binding. Each item maps to a task below, and Task 11 deletes the section.
- `docs/parity/legacy-report-layouts.md`: the measured layouts, the pixel-verified colours and the 16 discrepancies.
- The sample PDFs it describes, at `/Users/paul/gcpe-news-platform-4c/docs/parity/legacy-survey/results/Hub/` (`LookAhead 1.pdf`, `ExecLookAhead.pdf`, `30-60-90-example.pdf`, `PlanningReport.pdf`). They hold real activities. They were read locally while planning and are never copied into the repo or into this plan.
- The spike: `docs/superpowers/plans/2026-10-08-phase-5b-report-rendering-spike.md`, whose code is on `spike/5b-report-rendering` at `29b60ba` (never merged), and Q57's boxs.ca answer in `docs/parity/open-questions.md`.
- Legacy: `Calendar/ActivityHandler.ashx.cs` (`ProcessReport`, `SubreportEventHandler`, `GenerateLookAheadActivities`, `GenerateMonthly30_60_90`, `GeneratePlannedActivities`, `FormatHqComments`, `FormatTitleDetails`, `FormatLookAheadRelease`, `AddNewDetailsRow`), `Calendar/ActivityListProvider.ashx.cs` (`GetFilteredActivities`, `FriendlyDateTimeRange`, `FriendlyDateTime`, `IsTimeTBD`, `GetCreatedOrUpdatedMessage`, `FriendlyTimeSpan`, `ParseDetailsForUrl`), `Gcpe.Calendar.Library/Data/ActivityDAO.cs:160-200`, and the RDLC files in `Calendar/Reports`.
- The 5e and 5f plans for house style. Their decisions E1–E26 and F1–F13 hold. This plan adds G1–G22.

**Order:**
- Tasks 1–5 build the contract, the data and the documents, with no renderer.
- Task 6 draws them.
- Task 7 adds the jobs and the routes.
- Task 8 proves the PDFs.
- Task 9 builds the artifacts.
- Task 10 is the screen.
- Task 11 is end to end and the docs.

Each task needs the ones before it. Task 10 needs only Task 1's contract and Task 7's routes.

**Base:**
- **Branch:** `feat/phase-5g` in `/Users/paul/gcpe-news-platform-p5g`, from `feat/phase-5f` (PR #24) at `acccc09`, which sits on `main`. Every path is repo-relative.
- **Facts this plan relies on (verified by reading the code at `acccc09`):**
  - **The list** (`apps/calendar/src/list/query.ts`):
    - `listWhere(scope, q)` calls `filterWhere(scope, f, display)`. That always appends `defaultHides(scope, f)` (Awareness and the consultations ministry hidden unless the filter names them) except on My Watchlist.
    - `scopeOf(db, deps, actor)` returns `{ actor, rules, today, consultationsKeys }`.
    - `rowsOf(tx, scope, ids)` (`list/rows.ts`) re-applies `visibleSql`. It sets `hqStatus` only where `can.seeLookAheadFieldset(actor, rules, facts)` holds (C177).
    - `ListRow` has no section, Long Term Outlook, Executive Summary, NR time, category ids or initiatives.
  - **The Excel export** (`list/export.ts`, `http/list-routes.ts`):
    - Legacy's order is written inline as three `orderBy` terms plus `asc(activities.id)`.
    - The concurrency gate is a counter local to `listRoutes` (`EXPORT_CONCURRENCY = 2`), so other routes can't share it.
    - `ExportBusyError` maps to 503 with `Retry-After` in `sendListError` (`http/list-errors.ts`), which `runList` uses.
    - The export takes `q` through `listQueryParam`, a JSON string piped into `listQuerySchema`.
  - **Dates:** `friendlyDateRange(a, { timeZone, today, weekday? })` (`packages/calendar-contract/src/format.ts`) has no reference day and always prints the end time. `friendlySpan(at, now, timeZone)` returns "3 Days" / "2 Months".
  - **Capabilities and visibility:** `can` (`apps/calendar/src/capabilities.ts`) has no Exec Look Ahead entry. `visibleSql` and `visible` are in `visibility.ts`. `inReadSnapshot` is in `activities/store.ts`.
  - **Config:** `GET /calendar/api/config`'s `list` is `{ markup, corporateQueries, lookAheadFilter, reviewSelected, clearLaStatus }`. The test pins it with `toEqual` (`http/config-routes.test.ts:38-39`).
  - **Tenant settings:** the tenant's `calendar` section (`packages/config/src/calendar.ts`, strict) has `lookAheadCoverImage: string | null` (BC: null) and `reportBanner: { province, confidentiality }`. Its comment says "no legacy id or category name is written into a rule".
  - **App wiring:**
    - `ApiDeps` (`http/routes.ts`) and `AppDeps` (`app.ts`) build the `/api` deps.
    - `startCalendar` (`start.ts`) parses `calendarEnvSchema` and returns closers.
    - The stack bundles everything into `dist/siteground/stack.js`, an ESM bundle whose banner declares a top-level `createRequire` (`scripts/build-siteground.mjs`). It scans the artifact for the build machine's username and paths.
    - The per-app images bundle `src/main.ts` with npm dependencies external (`scripts/build-app.mjs`, `apps/calendar/Dockerfile`).
  - **Test helpers:**
    - `TEST_RULES`, `FIXED_NOW` (2026-11-03 11:00 BC, a Tuesday) and `createTestApp(db, over)` are in `apps/calendar/test/helpers.ts`.
    - `seedWorld`, `insertRaw` (takes an explicit `id`), `call` and `Who` are in `test/world.ts`. `insertRaw`'s default `hqSection` is `in_the_news`.
    - World categories: plain 32, awareness 2. Comm material 1 is "Sample news release". Initiative 1 has short name "SI". Organizations: health HLTH, finance FIN, gcpe-hq HQ (HQ), consult CONSULT.
  - **E2E:**
    - `listFixture()` (`tests/e2e/calendar-support.ts`) makes A–F on 2031-05-14 (a Wednesday) through the API as the HQ Administrator, with a fresh non-events category.
    - So A and C are inferred In the News, and the confidential B, D and E are Not on LA (`inferLookAhead`, `packages/calendar-contract/src/look-ahead.ts`).
    - `sessionOf`, `useCookie`, `listUrl` and `MAY` are there too, and `apiCall`, `baseUrl` and `expectNoSeriousA11yViolations` are in `playwright-support.ts`.
  - **Staff app:**
    - `ActivityListScreen`'s toolbar is `<section aria-label="List actions" className="gcpe-actions">` with `ExportButton`.
    - `downloadExport` (`list/api.ts`) fetches the file and saves it through an object URL.
    - `.gcpe-calendar-toolbar .gcpe-actions > div` lays out a button group.
    - `stubFetch`, `renderList`, `never`, `HQ_ADMIN_ME` and `HQ_ADMIN_CONFIG` are in `list/fixtures.tsx`.
  - **Packages:** `@bcgov/bc-sans` 2.1.2 is already in `package-lock.json` (staff-web) and ships `fonts/*.woff` and `LICENSE_OFL.txt`. pdfmake, `@types/pdfmake` and unpdf are not installed.
  - **Parity lists:**
    - The highest change row in `docs/parity/changes-from-legacy.md` is C183. C132 and C148 are spec rows not yet written there. C127's status already names "reports in 5g".
    - The highest question in `docs/parity/open-questions.md` is Q61. Q48's row there still has only the 2026-10-07 answer.

## Measured while planning (2026-10-10)

These numbers come from a scratch harness. The harness used this plan's approach: pdfmake 0.3.11 driven directly, with `pageBreak: "before"` nodes, BC Sans and a worker thread. It ran locally, and on boxs.ca over `ssh boxs` with `/usr/local/bin/node-24` (v24.18.1) from `~/tmp`, which was deleted afterwards. Nothing was deployed.

| Case (Letter portrait, BC Sans, worker thread) | boxs.ca render | boxs.ca peak RSS (whole process) | Main thread's 10 ms timer during render |
|---|---|---|---|
| 1 day × 12 rows | 172 ms (326 ms with worker start) | 112 MB | 32 of 33 ticks |
| 60 days × 12 rows (720 rows, 60 pages; the spike's 28.3 s case) | 1.2–1.3 s | 189 MB | 142 of 144 |
| 60 days × 20 rows (1,200 rows) | 1.9 s | 289 MB | 201 of 204 |
| 60 days × 40 rows (2,400 rows) | 3.5 s (heap 147 MB) | 323 MB | 355 of 360 |
| 60 days × 80 rows (4,800 rows) | 7.0 s (heap 193 MB) | 437 MB | 701 of 709 |
| 100 days × 100 rows, heap limit 256 MB | `ERR_WORKER_OUT_OF_MEMORY`: the worker ended, the process didn't | — | — |
| BC Sans as WOFF, read by pdfkit itself | +3.4 s per document (pdfkit inflates WOFF in JavaScript, every time) | — | — |

- **What made the spike slow:** its 28 s came from html-to-pdfmake's `pageBreakBefore` callback, and BC Sans read as WOFF would have added more. Both are designed out here: G1 and G6.
- **Bundling:**
  - An ESM bundle of pdfmake fails at load ("`__dirname` is not defined"): its in-memory file store reads `__dirname`. A CommonJS bundle runs (G7).
  - A worker can't transfer a pooled `Buffer`'s memory ("Cannot transfer object of unsupported type", Node 24.18 on boxs.ca), so the worker copies the PDF into a fresh `Uint8Array` first.
- **The legacy sample PDFs:**
  - `LookAhead 1.pdf` and `ExecLookAhead.pdf` are HQ reports: one Events page per day, and Executive Summaries as the row text, Awareness Dates included. That explains discrepancy 16.
  - Read with unpdf, their activity links (`Activity.aspx?ActivityId=…`) and section and day headings give an outline in the same vocabulary as ours: 178 activity links in `LookAhead 1.pdf`.
- **SiteGround's proxy timeout was not measured.** That needs a deliberately slow route deployed to boxs.ca. G3 makes the design independent of it.

---
## Decisions made in planning

Each says why and what it costs if wrong. Task 11 writes the parity rows and the questions.

- **G1. pdfmake draws a renderer-neutral `ReportDoc`, with no HTML.** There is no template, no jsdom and no html-to-pdfmake. Builders emit headings, tables (header cells, row cells with fills), the cover banner, the legend and page breaks, and the running text. Colours and breaks are decided in the builders.
  - *Why:* the spike's HTML path was what made pdfmake slow (28.3 s on boxs.ca). Driven directly, the same 60-day case takes 1.3 s (measured above). Plain data also crosses into a worker by structured clone.
  - *Cost if wrong:* a later Chromium renderer needs an HTML writer for `ReportDoc`. That is one file behind the same `PdfRenderer` interface (G2). §10.1's "HTML templates stay the source" no longer holds, and Task 11 updates the spec.
- **G2. Render in a `worker_threads` worker, not a child process: a fresh worker per report.**
  - Each worker gets `resourceLimits: { maxOldGenerationSizeMb: REPORT_HEAP_MB (320), maxYoungGenerationSizeMb: 32 }` and a `REPORT_TIMEOUT_SECONDS` (120) timeout, then terminates.
  - `REPORT_CONCURRENCY` (1) renders run at once.
  - The interface is `PdfRenderer { render(doc): Promise<Uint8Array>; close(): Promise<void> }`.
  - *Why:* pdfmake runs in a worker (verified). A worker costs no extra OS process (SiteGround allows 80), and the main thread's timer kept firing through every render measured. A heap past its limit ends only that worker (measured). A fresh worker per report returns all its memory: one at a time, the process peaks near 450 MB at the 5,000-row limit (G4).
  - *Cost if wrong:* about 150 ms of worker start per report on boxs.ca. A pooled worker would save it, but would keep pdfmake's heap between reports.
- **G3. Every report is a job; a start waits at most `REPORT_INLINE_WAIT_MS` (5 s).**
  - `POST /calendar/api/reports/:report` with `{ q }` answers 201 when the PDF is ready within the wait, else 202. Either way the body is `ReportJobView { id, report, status, error }`.
  - `GET /reports/jobs/:id` polls the job, and `GET /reports/jobs/:id/pdf` downloads it.
  - *Why:* one code path. No request outlives about 5 s plus the database read, so the plan doesn't depend on SiteGround's unmeasured proxy timeout. Most reports (1–2 s measured) feel immediate. The download is a plain GET, saved like the Excel export.
  - *Not done:* the proxy timeout isn't measured. It needs a deliberately slow route deployed to boxs.ca, which isn't trivially safe. The wait is configurable (0–25 s).
  - *Cost if wrong:* one extra round trip per report. The spec's `GET /calendar/api/reports/:report?<filter>` changes shape. Task 11 updates §10, and C184 records it.
- **G4. Bounds, each refused before any render. `ReportTooLargeError` is 422 "Too many … : narrow the filter and run the report again".**
  - At most 5,000 activities read (`REPORT_ACTIVITY_LIMIT`).
  - At most 5,000 table rows drawn (`REPORT_ROW_LIMIT`; 4,800 took 7 s and a 193 MB heap on boxs.ca).
  - A Look Ahead of at most 366 days.
  - At most 4 reports waiting (`REPORT_QUEUE_MAX`), and at most 2 unfinished per user (`REPORT_PER_USER_MAX`). Past either, the answer is 503 with `Retry-After: 10`.
  - *Why:* the Excel export refuses at 10,000 rows. A PDF row costs far more, and the Look Ahead repeats a multi-day row on each of its days. The export's gate is a counter local to `listRoutes`, so it can't be shared. Reports queue rather than refuse, and reuse its 503 + `Retry-After` shape through `sendListError`.
  - *Cost if wrong:* a large real filter is refused. Each limit is one constant.
- **G5. Finished PDFs live only in the process's memory.**
  - They are kept for 10 minutes after the render ends, and at most 64 MB in all, oldest first. They are never written to disk.
  - Every read checks the owner (`userId`). Another user's job, an unknown id, a malformed id and an expired job are the same 404 `{ error: "not found" }`.
  - The download re-checks `can.runReport`.
  - A restart forgets every job. The screen says "The report was lost while it was being prepared. Run it again." (SiteGround stops an idle process after 30–60 s; a polling browser keeps it busy.)
  - *Why:* confidentiality. Nothing outlives the process.
  - *Cost if wrong:* a user who waits more than 10 minutes to save re-runs the report.
- **G6. BC Sans, embedded, from `@bcgov/bc-sans` 2.1.2.**
  - Each worker reads the four WOFF faces and unpacks them to TrueType once with `node:zlib` (`woffToSfnt`). It hands them to pdfmake through its in-memory file store and embeds subsets.
  - pdfmake is told to fetch no URL and read no local file (`setUrlAccessPolicy`, `setLocalAccessPolicy`).
  - *Correction to the brief:* the spike didn't solve BC Sans. It used pdfkit's built-in Helvetica (`render-pdfmake.mjs`). This plan solves it: pdfkit reading the WOFF itself added 3.4 s to every document on boxs.ca, while unpacking once costs about 10 ms.
  - *Cost if wrong:* none known. `woffToSfnt` only reassembles the font's own tables.
- **G7. The worker ships as its own CommonJS bundle, `report-worker.cjs`, with `fonts/` (BC Sans and its OFL licence) beside it.** It sits next to `stack.js` (SiteGround) and next to `main.js` (per-app images, npm packages left external there).
  - `reportAssets()` finds the worker. In a source checkout it is `worker.ts`, run with `--import tsx` (Vitest and Playwright included). Beside a bundle it uses the bundle's own files. If the worker or the fonts can't be found, the Calendar starts and its report routes answer 503.
  - *Why:* an ESM bundle of pdfmake fails on `__dirname` (measured). The SiteGround artifact has no `node_modules`.
  - `legalComments: "none"`, as `stack.js`. An author's handle in pdfmake's dependencies matched the build machine's username and failed the leak scan (seen while planning).
  - `assets.ts` imports `node:module` as a namespace: a named `createRequire` import collided with the bundle banner's own and broke `stack.js` at load (seen while planning).
  - *Cost if wrong:* about 1.6 MB more in the artifact.
- **G8. What a report reads.**
  - It reads the list's query (`q`) through `listWhere(scope, q, { defaultHides: false })`. Legacy's reports read the filter without the grid's first-load hides (`ActivityHandler.ashx.cs:36-53` against `ActivityListProvider.ashx.cs:90-91`), so the Awareness Dates section has rows.
  - It never reads a deleted activity (`activities.deleted_at IS NULL`), whoever asks. Legacy's report query read only `IsActive` rows, except when the filter's status was Changed (`ActivityDAO.cs:176-193`).
  - It orders by legacy's start date, end date and start time (`legacyReportOrder`, now shared with the Excel export) whatever the list's sort, and reads in one snapshot.
  - *Cost if wrong:* an HQ Administrator filtering on Changed no longer sees deletions awaiting review in a report. They do in the list (C187).
- **G9. Confidentiality.**
  - Every row passes `visibleSql` twice: in `listWhere`, then in `rowsOf`.
  - The Executive Summary and the NEW/CHANGED flag appear only where `can.seeLookAheadFieldset(actor, rules, facts)` holds, as on the screens (C177). Legacy gave the summary to every HQ user and the flag to everyone.
  - Where a row sits (its stored section) follows legacy for every viewer: the Look Ahead *is* the sections.
  - The HQ variant comes from HQ(u), as legacy's `IsAppOwner`: Issues by section, a page per day, the FYI category, and only Long Term Outlook rows that are marked.
  - The Exec Look Ahead is `can.execLookAhead` (HQ, Administrator and above). It is checked on the server and offered through `GET /config`'s `list.execLookAhead`.
  - The route logs only `safeErrorLabel` and the route.
  - *Cost if wrong:* an HQ Read Only user's Look Ahead shows titles where legacy showed Executive Summaries (C188).
- **G10. "Consultations and Dialogues" is dropped (carry-forward; Paul 2026-10-07).**
  - The legend has no swatch for it.
  - The consultations ministry's activities appear in no Look Ahead section, as before. Legacy routed them only to that section (`BelongsToAwarenessConsultationReport`).
  - They stay in the 30/60/90 and Planning reports, as legacy's did.
  - §7.6's inference rule ("contact ministry is the consultations ministry → Consultations and Dialogues") still matters. It keeps those activities Not on LA with no override (`sectionToStore`), so they can't leak into Events or In the News. It is kept.
  - *Cost if wrong:* if the section is ever wanted back, it is one table in `lookAheadDoc`.
- **G11. The Look Ahead's reference day (carry-forward).**
  - `friendlyDateRange` becomes `friendlyDateParts(a, { timeZone, today, weekday?, referenceDay?, endTime? })` plus the string form. On the reference day, a timed activity shows only its start time, an all-day one shows its weekday date, and a time-TBD one shows only "Time TBD" (legacy's `FriendlyDateTime`).
  - Only the Look Ahead passes `referenceDay` and `endTime: false`. Every other caller is unchanged.
  - "TBC" and "Time TBD" are bold blue (`#1919d2`), as legacy.
- **G12. Legacy's report bugs, fixed (carry-forward; C186).**
  - The Exec Look Ahead says "Last updated" once: "Last updated today at 9:15 AM", "Last updated yesterday at …", "Last updated 2 months ago".
  - A title's raw `**CONFIDENTIAL**` marker is dropped, any case, in every report.
  - Both "Fact Sheet" and "Factsheet" give the RLS code Fact Sheet (C148).
  - The Exec Look Ahead's "City: Venue" uses the typed Other City, not "Other...".
- **G13. Legacy kept as it is, quirks included.** Each is named in a test or a comment.
  - The Issues and Reports section isn't split by day; it holds every row the filter brought (ActivityHandler.ashx.cs:920-923).
  - Its RLS can read "Report", because legacy's `inTheNews` is true for that table too. That is discrepancy 3, explained.
  - HQ's Awareness Dates rows show the Executive Summary. That is discrepancy 16, explained.
  - The title shows the start's year only when both ends share it.
  - The Exec Look Ahead with no To runs its days for one month, but its Long Term Outlook starts at 60 days, so activities in between appear nowhere (Q63).
  - The Exec's detailed text applies only in Events, Issues and In the News. Discrepancy 6 says otherwise for Awareness Dates; 5i's comparison settles it.
- **G14. Every tenant text and name the reports match lives in the tenant's `calendar.reports`:**
  - the cover's lines;
  - the Planning title;
  - lead abbreviations (GCPEHQ → HQ);
  - the "TBD" city and the ", BC" suffix;
  - the TV / Radio category;
  - Planning's "Issue" and "FYI Only" texts;
  - the RLS material and origin rules, in legacy's order.

  *Why:* `packages/config/src/calendar.ts` says no legacy id or category name is written into a rule. Test rules use fictional names.
- **G15. Row links are absolute:** `<origin>/hub/calendar/activities/:id`, with no `return` (carry-forward). The origin is the request's own scheme and host, used only when the host looks like a host name. *Why:* a PDF can't follow a relative link. *Cost if wrong:* behind a proxy that rewrites Host, links point at the internal name. Express's `trust proxy` is already 1.
- **G16. The cover.**
  - A drawn dark-grey banner carries the cover's lines. Legacy's cover photograph isn't used (`lookAheadCoverImage` stays null), and neither is the "Questions or Comments?" box with its phone number and mailbox, which the spec doesn't name.
  - Later pages carry the province's name as text in place of the BC logo.
  - *Cost if wrong:* Q62. The image would be one `image` block once a file and a decision exist.
- **G17. Colours:** the pixel-verified ones from `docs/parity/legacy-report-layouts.md`, including black headers on the list sections and `#f2dbdb` only in the Issues date column. The zebra grey `#d9d9d9`, the heading blue `#365f91` and the brown `#9e3a38` of "DRAFT AND CONFIDENTIAL" are by eye. Layout is compared by eye in 5i (§12.3).
- **G18. File names:** `LookAhead.pdf`, `ExecLookAhead.pdf`, `30-60-90.pdf`, `PlanningReport.pdf`. They are served as `attachment` with `nosniff` and `no-store`. Legacy streamed the PDF with no name.
- **G19. The screen.**
  - A "Reports (PDF)" group after Excel export shows Look Ahead, Exec Look Ahead (only with `list.execLookAhead`), 30/60/90 and Planning.
  - Clicking one disables all four and shows "Preparing your <report> report…" (`role="status"`). The screen polls once a second, for up to 5 minutes, then saves the file. Success says "The <report> report has downloaded."
  - Every refusal shows the server's own words (`role="alert"`).
  - The Excel export's download moves into a shared `downloadFile`.
- **G20. The parity proof (§3 row 5g, §16).**
  - `pdfPages` reads a PDF with unpdf 1.8.1: MIT, no dependencies, pure JS. Its optional canvas peer is not installed.
  - `outlineOf` turns it into "§ SECTION", "# day or month", "∅ empty day" and "id:N". The ids come from link annotations, so a number in a title can't be mistaken for one, and legacy's `ActivityId=` links read the same way.
  - Golden tests compare that outline for each report and role with what legacy's rules give for a fictional fixture.
  - `npm run calendar:report-compare -- --legacy <pdf> --new <pdf> --out <dir>` is 5i's hook. It refuses an `--out` inside the repo.
- **G21. Dependencies, pinned exactly:**
  - `pdfmake` 0.3.11 (MIT; pulls pdfkit 0.19.1, fontkit 2.0.4 and linebreak, all MIT). It is the spike's choice, a minor version on, with typings.
  - `@bcgov/bc-sans` 2.1.2 (Apache-2.0 and OFL-1.1). Already in the lockfile.
  - `@types/pdfmake` 0.3.3 (dev).
  - `unpdf` 1.8.1 (dev).
  - `npm audit` reports the same 6 moderate advisories before and after (drizzle-kit's tree; checked 2026-10-10).
- **G22. No migration.** Nothing in the Calendar's schema changes.

## Carry-forward items taken

From `docs/superpowers/plans/phase-5-carry-forward.md` § 5g. Task 11 deletes the section.

| Item | Where |
|---|---|
| PDF only, pdfmake in a background job; measure the proxy timeout first; the PDF offered as a download once built | G1–G3, G5; Tasks 6–7 (worker, jobs, routes), Task 10 (download). The timeout isn't measured (G3). |
| Build on the spike's recommendation; close its "Risks and what wasn't checked" | G1, G2, G6, G7. Its risks: no Word (moot, Q48); hosts measured (boxs.ca, above); memory bounded per worker (G2); pdfmake now 0.3.11 (G21); SVG cover moot (G16). |
| Don't build "Consultations and Dialogues"; record it; fix the spec's "all 7 sections" and the legend; check §7.6's rule | G10; Task 4 (no section, no swatch), Task 11 (C185, spec R6, §10.2, §16, §7.6 note) |
| The Look Ahead's reference day | G11; Task 1 (`friendlyDateParts`), Task 4 |
| Legacy report fixes: "Last updated updated", raw `**CONFIDENTIAL**` | G12; Task 3 |
| Report buttons take the list's current `ListQuery` as `q` | Task 10 (`startReport(report, query)` posts `{ q: query }`); Task 7 (`reportStartSchema`) |
| Rows link to `/hub/calendar/activities/:id` | G15; Task 3 (`minIdRuns`), Task 8 and Task 11 (the links read back from the PDF) |
## Global Constraints

- **Worktree and commits:**
  - Work on `feat/phase-5g` in `/Users/paul/gcpe-news-platform-p5g`. Commit locally after each task, with a plain message. Don't push until the branch is reviewed.
  - **Never add `Co-Authored-By` or any AI attribution** to a commit. Never commit `CLAUDE.md`.
  - **No task, decision or round labels in code comments** ("Task 3", "G4", "fix round 1"). Spec row ids (C186, Q63) and legacy file references are fine.
- **Node 24 for everything:**
  - Tests: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run <paths>`.
  - Type-checks: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json` and `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p apps/staff-web/tsconfig.json`.
  - E2E: `npx -y -p node@24 -- npm run test:e2e` (a single spec: append `-- tests/e2e/<file>`).
  - Packages: `npx -y -p node@24 -- npm install …`. Run `npm ci` first if `node_modules` is missing.
- **Every behaviour change starts with a real RED run:** run the new test, see it fail for the stated reason, then implement.
- **Never block the event loop:** pdfmake runs only inside the report worker (`apps/calendar/src/reports/render/worker.ts`). Nothing on a request's path imports `render/pdf.ts` or pdfmake.
- **Reads use `listWhere` and `rowsOf` inside `inReadSnapshot`,** so `visibleSql` filters every row in SQL. No reader filters in memory after reading. Not visible is never a row in any report.
- **Look Ahead fields follow the screens:** the Executive Summary and the NEW/CHANGED flag only where `can.seeLookAheadFieldset` holds. The Exec Look Ahead is for HQ Administrators and above, on the server.
- **Jobs and PDFs are their owner's alone:** any other id is 404. They are held in memory only, never on disk.
- **No input produces a 500:** the body is `reportStartSchema` (strict), ids are `reportJobIdSchema`, and an unknown report is 404. Every refusal maps in `sendListError`.
- **Logs:** `safeErrorLabel` plus the route only; no debug logging. Never a title, a query string or a job id.
- **Privacy:** `example.test` addresses, fictional GUIDs and fictional names only. No legacy data is copied: no legacy PDF, cover photograph, phone number or activity text enters the repo.
- **Migrations:** drizzle-kit only. This plan adds none.
- **Bounded ids and strings:** job ids are 22 base64url characters, the query is the list's own bounded schema, a Look Ahead is at most 366 days, and a report is at most 5,000 activities and 5,000 rows.
- **New dependencies are pinned exactly** (`--save-exact`) and justified in G21.
- **Staff-web patterns:**
  - Calls go through `apiFetch` with same-origin paths. File downloads go through `downloadFile`.
  - Messages use `role="status"` and errors `role="alert"`.
  - Every state has an axe test, and browser code never imports `@gcpe/auth`.
  - Controls are at least 24 by 24 CSS pixels.
- **UI tasks run the affected e2e specs:** `calendar-reports.spec.ts`, `calendar-list.spec.ts` and `axe-sweep.spec.ts`. The full suite stays green.
- **E2E sessions:** seeded users use sessions minted in global-setup (`sessionOf`), never a real login, because the login limiter allows 10 a minute.
- **Parity lists:**
  - New rows go in `docs/parity/changes-from-legacy.md`, from C184 (the highest at `acccc09` is C183). C132 and C148 are added as built.
  - New questions go in `docs/parity/open-questions.md`, from Q62 (the highest is Q61).
  - Running-notes lines carry the legend's role tags (`docs/manuals/running-notes.md`: All Calendar users, HQ Editor and above, HQ Administrator, Operations, Developer).

## Review Focus

1. **Two report clicks in a row, or a whole office running reports at 9 AM.** Expected:
   - the screen disables the buttons while one runs;
   - the server renders one at a time, keeps at most four waiting and two per user, and answers the rest 503 with Retry-After;
   - the screen shows the server's "try again in a few seconds";
   - nothing blocks the rest of the stack.

   Pinned in Task 7 ("at most 2 unfinished reports per user…") and Task 10 ("while the server prepares it, says so and holds the buttons…", "…turned away while others run, says why").
2. **A filter far too wide for a PDF:** every date-forward activity, a year-long Look Ahead, or 90 activities each running 60 days. Expected: 422 with "narrow the filter", before any render. A render that still runs out of heap ends its worker only, and the job says "too large". Pinned in Task 2 (5,000 activities), Task 4 (366 days), Task 7 (5,400 rows; a failed render) and Task 6 (out of memory).
3. **Text that tries to be something else:**
   - `**`, `_`, `\r\n`, private-use characters and an unclosed marker in an Executive Summary;
   - `javascript:` or an `[a label]https://…` address in the details;
   - `**CONFIDENTIAL**` in a title.

   Expected: only http(s) addresses become links, markers become bold or italic or are left as typed, and nothing else is interpreted. Pinned in Task 3 ("the Executive Summary's **bold**…", "the first web address becomes a link…").
4. **Someone else's report:** another user's job id, a made-up one, a malformed one, `../`, an expired one, and a role taken away between start and download. Expected: the same 404 every time, and no PDF. Pinned in Task 7 ("another user's report, a made-up id, and a malformed one…", "a finished report is forgotten after its time") and Task 11 (e2e "another user's report is not found").
5. **The process restarts while a report is being prepared** (a deploy, or SiteGround's idle stop). Expected: the screen's next poll gets 404 and says "The report was lost while it was being prepared. Run it again."; no hang. Pinned in Task 10 ("a report the server forgot while preparing it…").

---

## File structure

| File | Responsibility |
|---|---|
| `packages/calendar-contract/src/format.ts` (+ test) | `friendlyDateParts` with the Look Ahead's reference day and start-time-only option; `friendlyDateRange` on top |
| `packages/calendar-contract/src/reports.ts` (+ test), `src/index.ts`, `src/rules.ts` | Report kinds, labels, file names, `reportStartSchema`, `reportJobIdSchema`, `ReportJobView`; `ReportRules`/`RlsRule` in `CalendarRules` |
| `packages/config/src/calendar.ts` (+ test), `config/tenants/bc.json` | The tenant's `calendar.reports` |
| `apps/calendar/src/list/query.ts`, `src/list/export.ts` | `listWhere`'s `{ defaultHides }` option; `legacyReportOrder`, shared with the export |
| `apps/calendar/src/reports/data.ts` (+ test) | `reportData`, `reportRowsOf`, `ReportRow`, the 5,000-activity limit |
| `apps/calendar/src/reports/model.ts` | `ReportDoc` and its blocks; `rowCountOf` |
| `apps/calendar/src/reports/dates.ts`, `text.ts` (+ `text.test.ts`) | Legacy's date stamps; row text, RLS, flags, links, colours |
| `apps/calendar/src/reports/look-ahead.ts` (+ test) | The Look Ahead and the Exec Look Ahead |
| `apps/calendar/src/reports/thirty-sixty-ninety.ts`, `planning.ts`, `build.ts` (+ `list-reports.test.ts`) | The 30/60/90 and Planning reports; `buildReport` |
| `apps/calendar/src/reports/render/fonts.ts`, `layout.ts`, `pdf.ts`, `worker.ts`, `renderer.ts`, `assets.ts` (+ `layout.test.ts`, `renderer.test.ts`) | BC Sans, `ReportDoc` → pdfmake, the worker, `PdfRenderer`, where the worker and fonts are |
| `apps/calendar/src/reports/jobs.ts` | `ReportJobs`: queue, limits, store, owner checks, expiry |
| `apps/calendar/src/http/report-routes.ts` (+ test), `http/routes.ts`, `http/list-errors.ts`, `app.ts`, `start.ts` (+ test), `capabilities.ts`, `http/config-routes.ts` (+ test) | The three routes, their errors and wiring; `can.execLookAhead`, `can.runReport`; `list.execLookAhead` |
| `apps/calendar/src/reports/golden.test.ts` | The parity proof: each report's PDF outline, per role |
| `apps/calendar/test/report-rows.ts`, `test/pdf-text.ts`, `test/helpers.ts` | `reportRow`, `outline`, `plain`; `pdfPages`, `outlineOf`; `TEST_RULES.reports` |
| `scripts/build-report-worker.mjs` (+ `.d.mts`), `scripts/build-siteground.mjs`, `scripts/build-app.mjs`, `tests/build-report-worker.test.ts` | The worker bundle and fonts in both artifacts |
| `scripts/calendar-report-compare.ts`, `tests/calendar-report-compare.test.ts`, `package.json` | 5i's comparison hook |
| `apps/staff-web/src/screens/calendar/list/Reports.tsx` (+ test), `api.ts`, `types.ts`, `fixtures.tsx`, `ActivityListScreen.tsx`, `a11y.test.tsx` | The buttons, polling and download |
| `tests/e2e/calendar-reports.spec.ts` | End to end, per role |
| `docs/parity/changes-from-legacy.md`, `docs/parity/open-questions.md`, `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`, `docs/superpowers/specs/2026-10-07-calendar-parity-design.md`, `docs/superpowers/plans/phase-5-carry-forward.md` | Docs |

---
### Task 1: The contract: friendly dates with a reference day, the report kinds and job view, the tenant's report texts

Covers: carry-forward § 5g (the reference day; the report buttons' `q`), spec §10 (the reports' input), §10.2 (RLS codes, the cover), §14 C148. Decisions G3, G11, G14, G18.

**Files:**
- Create: `packages/calendar-contract/src/reports.ts`, `packages/calendar-contract/src/reports.test.ts`.
- Modify: `packages/calendar-contract/src/format.ts`, `packages/calendar-contract/src/format.test.ts`, `packages/calendar-contract/src/rules.ts`, `packages/calendar-contract/src/index.ts`, `packages/calendar-contract/src/editor.test.ts`, `packages/config/src/calendar.ts`, `packages/config/src/calendar.test.ts`, `config/tenants/bc.json`, `apps/calendar/test/helpers.ts`.

**Interfaces:**
- Consumes: `listQuerySchema` (`./list`); `DatedActivity` (`./format`).
- Produces:
  - `friendlyDateParts(a: DatedActivity, o: FriendlyDateOptions): FriendlyDateParts`, where `FriendlyDateOptions = { timeZone; today; weekday?; referenceDay?; endTime? }` and `FriendlyDateParts = { text: string; pending: "TBC" | "Time TBD" | null }`. `friendlyDateRange(a, o): string` keeps its old behaviour for old options.
  - `REPORT_KINDS = ["look-ahead", "exec-look-ahead", "30-60-90", "planning"]`, `type ReportKind`, `isReportKind(s)`, `REPORT_LABELS`, `REPORT_FILE_NAMES`.
  - `reportStartSchema` (`{ q: ListQuery }`, strict), `reportJobIdSchema`, `REPORT_JOB_STATUSES`, `type ReportJobStatus`, `interface ReportJobView { id; report: ReportKind; status; error: string | null }`.
  - `interface RlsRule { contains: readonly string[]; code: string; notInEvents?: boolean; releaseTime?: boolean }`.
  - `interface ReportRules { cover: { organization; lines }; planningTitle; leadAbbreviations; cityToBeDecidedName; citySuffix; tvRadioCategoryName; issueCategoryText; fyiOnlyCategoryText; rlsMaterials: readonly RlsRule[]; rlsOrigins: readonly RlsRule[] }`.
  - `CalendarRules.reports: ReportRules`.
  - `TEST_RULES.reports`, with fictional values Tasks 3–8 rely on:
    - cover "Sample Communications Office" / "SAMPLE PROVINCE", "CORPORATE LOOK AHEAD";
    - Planning title "Sample Corporate Calendar: Schedule of Activities";
    - lead `{ FIN: "FN" }`;
    - city "Sample undecided city", suffix ", SP";
    - broadcast "Sample broadcast", issue "Sample issue", FYI "Sample FYI only";
    - materials NR / Report (not in Events) / Fact Sheet (two spellings) / e-news (not in Events, no time);
    - origins Gov / Joint.

- [ ] **Step 1: Write the failing tests**

`packages/calendar-contract/src/format.test.ts`: change the import to

```ts
import { friendlyDateParts, friendlyDateRange, friendlySpan } from "./format";
```

and append:

```ts
describe("the Look Ahead's dates: a reference day, the start time only (ActivityListProvider.ashx.cs:784-823)", () => {
  const timed = (start: string, end: string, more: object = {}) => ({ startAt: at(start), endAt: at(end), isAllDay: false, isConfirmed: true, ...more });
  const la = { ...o, weekday: false, endTime: false };
  it("a timed activity on the reference day shows only its start time", () => {
    expect(friendlyDateRange(timed("2026-11-10T21:00:00Z", "2026-11-10T22:00:00Z"), { ...la, referenceDay: "2026-11-10" })).toBe("2:00 PM");
  });
  it("an all-day activity on the reference day shows the date with its weekday", () => {
    expect(friendlyDateRange({ ...timed("2026-11-10T08:00:00Z", "2026-11-11T06:45:00Z"), isAllDay: true }, { ...la, referenceDay: "2026-11-10" })).toBe("Tue Nov 10");
  });
  it("another day shows the date without the weekday and the start time alone, the year against the reference day", () => {
    expect(friendlyDateRange(timed("2026-11-12T17:30:00Z", "2026-11-12T18:00:00Z"), { ...la, referenceDay: "2026-11-10" })).toBe("Nov 12 10:30 AM");
    expect(friendlyDateRange(timed("2026-12-30T16:00:00Z", "2027-01-02T17:00:00Z"), { ...la, referenceDay: "2026-12-31" })).toBe("Dec 30 2026-Jan 2 2027");
    expect(friendlyDateRange(timed("2027-01-04T16:00:00Z", "2027-01-05T17:00:00Z"), { ...la, referenceDay: "2027-01-04" })).toBe("Jan 4-5");
  });
  it("Time TBD on the reference day is the marker alone; TBC is kept apart for the reports to colour", () => {
    expect(friendlyDateParts(timed("2026-11-10T15:00:00Z", "2026-11-11T01:00:00Z", { isConfirmed: false }), { ...la, referenceDay: "2026-11-10" })).toEqual({ text: "", pending: "Time TBD" });
    expect(friendlyDateParts(timed("2026-11-10T21:00:00Z", "2026-11-10T22:00:00Z", { isConfirmed: false }), { ...la, referenceDay: "2026-11-10" })).toEqual({ text: "2:00 PM", pending: "TBC" });
    expect(friendlyDateParts(timed("2026-11-10T21:00:00Z", "2026-11-10T22:00:00Z"), o)).toEqual({ text: "Tue Nov 10 2:00-3:00 PM", pending: null });
  });
});
```

Create `packages/calendar-contract/src/reports.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_LIST_QUERY } from "./list";
import { REPORT_FILE_NAMES, REPORT_KINDS, isReportKind, reportJobIdSchema, reportStartSchema } from "./reports";

describe("the reports' contract (spec addendum §10)", () => {
  it("names legacy's four reports, each with a file name", () => {
    expect(REPORT_KINDS).toEqual(["look-ahead", "exec-look-ahead", "30-60-90", "planning"]);
    expect(Object.keys(REPORT_FILE_NAMES)).toEqual([...REPORT_KINDS]);
    expect(isReportKind("planning")).toBe(true);
    expect(isReportKind("word")).toBe(false);
  });

  it("starts from the list's own query, defaults filled in, and nothing else", () => {
    expect(reportStartSchema.parse({ q: {} })).toEqual({ q: DEFAULT_LIST_QUERY });
    expect(reportStartSchema.safeParse({}).success).toBe(false);
    expect(reportStartSchema.safeParse({ q: {}, format: "docx" }).success).toBe(false);
    expect(reportStartSchema.safeParse({ q: { filter: { from: "2026-02-30" } } }).success).toBe(false);
  });

  it("a job id is 22 base64url characters", () => {
    expect(reportJobIdSchema.safeParse("AbCdEfGhIjKlMnOpQrSt_-").success).toBe(true);
    for (const bad of ["", "short", "AbCdEfGhIjKlMnOpQrSt_-x", "AbCdEfGhIjKlMnOpQrSt/+", "../../../../etc/passwd"]) expect(reportJobIdSchema.safeParse(bad).success, bad).toBe(false);
  });
});
```

`packages/config/src/calendar.test.ts`, after the test "BC carries legacy's values (spec addendum §5.1)":

```ts
  it("BC's report texts and RLS codes are legacy's (ActivityHandler.ashx.cs:1176-1257, C148)", () => {
    const r = bc().calendar!.reports;
    expect(r.rlsMaterials.map((m) => m.code)).toEqual(["NR", "IB", "OpEd", "Report", "STMT", "TA", "NYCU", "Fact Sheet", "e-news"]);
    expect(r.rlsMaterials.find((m) => m.code === "Fact Sheet")!.contains).toEqual(["Fact Sheet", "Factsheet"]);
    expect(r.rlsMaterials.filter((m) => m.notInEvents).map((m) => m.code)).toEqual(["Report", "e-news"]);
    expect(r.rlsOrigins.map((o) => o.code)).toEqual(["BCGov", "Joint", "3rd party", "Fed"]);
    expect(r.leadAbbreviations).toEqual({ GCPEHQ: "HQ" });
    expect(r.cover.lines).toEqual(["BC GOVERNMENT", "CORPORATE LOOK AHEAD"]);
  });

  it("refuses a report rule with no text to match", () => {
    const c = bc().calendar!;
    expect(calendarTenantSchema.safeParse({ ...c, reports: { ...c.reports, rlsOrigins: [{ contains: [], code: "X" }] } }).success).toBe(false);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/calendar-contract/src/format.test.ts packages/calendar-contract/src/reports.test.ts packages/config/src/calendar.test.ts`
Expected: FAIL. `format.test.ts`: "friendlyDateParts is not a function". `reports.test.ts`: "Failed to resolve import "./reports"". `calendar.test.ts`: "Cannot read properties of undefined (reading 'rlsMaterials')".

- [ ] **Step 3: Implement**

`packages/calendar-contract/src/format.ts`: replace the whole `friendlyDateRange` function and its doc comment with:

```ts
export interface FriendlyDateOptions {
  timeZone: string;
  /** Today's BC date (YYYY-MM-DD): it decides when a year shows. */
  today: string;
  /** The weekday on a single day's date; on by default. */
  weekday?: boolean;
  /**
   * The Look Ahead's day (YYYY-MM-DD), which stands in for today: a timed activity on that day
   * shows its time without the date (ActivityListProvider.ashx.cs:784-823, `referenceDay`).
   */
  referenceDay?: string;
  /** The end time after the start time; on by default. The Look Ahead shows the start time only. */
  endTime?: boolean;
}

/** A friendly date's text, and legacy's "TBC" or "Time TBD" marker, which the reports colour. */
export interface FriendlyDateParts {
  text: string;
  pending: "TBC" | "Time TBD" | null;
}

/**
 * Legacy's FriendlyDateTimeRange (ActivityListProvider.ashx.cs:769-840), in the tenant's time
 * zone, with plain spaces, as text and marker.
 */
export function friendlyDateParts(a: DatedActivity, o: FriendlyDateOptions): FriendlyDateParts {
  if (!a.startAt || !a.endAt) return { text: a.potentialDates || "—", pending: null };
  const s = wall(new Date(a.startAt), o.timeZone);
  const e = wall(new Date(a.endAt), o.timeZone);
  const [ry, rm, rd] = (o.referenceDay ?? o.today).split("-").map(Number) as [number, number, number];
  const ref = { y: ry, m: rm, d: rd };
  // An unconfirmed 8 AM to 6 PM day is legacy's "time to be decided" placeholder (IsTimeTBD).
  const timeTbd = sameDay(s, e) && !a.isConfirmed && s.hh === 8 && s.mm === 0 && e.hh === 18 && e.mm === 0;
  let value = "";
  if (sameDay(s, e)) {
    const isRef = sameDay(s, ref);
    value = isRef && o.referenceDay !== undefined && !a.isAllDay ? "" : dateText(s, !isRef && s.y !== ref.y, isRef || (o.weekday ?? true));
    if (!a.isAllDay && !timeTbd) {
      value += (o.endTime ?? true) ? ` ${timeText(s, s.hh >= 12 !== e.hh >= 12)}-${timeText(e, true)}` : ` ${timeText(s, true)}`;
    }
    value = value.trim();
  } else {
    const year = s.y !== e.y || s.y !== ref.y;
    value = `${dateText(s, year, false)}-${year || s.m !== e.m ? dateText(e, year, false) : String(e.d)}`;
  }
  if (a.isConfirmed) return { text: value, pending: null };
  return { text: a.potentialDates || value, pending: timeTbd ? "Time TBD" : "TBC" };
}

/** {@link friendlyDateParts} as one string: the list, the export and the updates feed. */
export function friendlyDateRange(a: DatedActivity, o: FriendlyDateOptions): string {
  const p = friendlyDateParts(a, o);
  return p.pending ? `${p.text} ${p.pending}`.trim() : p.text;
}
```

Create `packages/calendar-contract/src/reports.ts`:

```ts
import { z } from "zod";
import { listQuerySchema } from "./list";

/** The four reports (spec addendum §10), as their route names. */
export const REPORT_KINDS = ["look-ahead", "exec-look-ahead", "30-60-90", "planning"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const isReportKind = (s: string): s is ReportKind => (REPORT_KINDS as readonly string[]).includes(s);

/** The list toolbar's button labels. */
export const REPORT_LABELS: Readonly<Record<ReportKind, string>> = {
  "look-ahead": "Look Ahead",
  "exec-look-ahead": "Exec Look Ahead",
  "30-60-90": "30/60/90",
  planning: "Planning",
};

/** The downloaded file's name. */
export const REPORT_FILE_NAMES: Readonly<Record<ReportKind, string>> = {
  "look-ahead": "LookAhead.pdf",
  "exec-look-ahead": "ExecLookAhead.pdf",
  "30-60-90": "30-60-90.pdf",
  planning: "PlanningReport.pdf",
};

/** `POST /calendar/api/reports/:report`'s body: the list's current query, as the Excel export takes it. */
export const reportStartSchema = z.object({ q: listQuerySchema }).strict();

/** A report job's id: 16 random bytes, base64url. */
export const reportJobIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/, "not a report id");

export const REPORT_JOB_STATUSES = ["running", "ready", "failed"] as const;
export type ReportJobStatus = (typeof REPORT_JOB_STATUSES)[number];

/** What the report routes answer about a job. Only the user who started it ever sees it. */
export interface ReportJobView {
  id: string;
  report: ReportKind;
  status: ReportJobStatus;
  /** Why it failed, in words for staff; null unless failed. */
  error: string | null;
}
```

`packages/calendar-contract/src/index.ts`, after `export * from "./list";`:

```ts
export * from "./reports";
```

`packages/calendar-contract/src/rules.ts`, above `/** What the activity rules read…`:

```ts
/** One RLS code: the first rule whose text appears in the activity's comm materials (or origins) wins (ActivityHandler.ashx.cs:1176-1257). */
export interface RlsRule {
  contains: readonly string[];
  code: string;
  /** Not in the Events, Speeches & Releases table: legacy's `inTheNews`, true for Issues and Reports and In the News. */
  notInEvents?: boolean;
  /** False when the NR time never follows this code (legacy's Newsletter fallback). */
  releaseTime?: boolean;
}

/** The report texts and names a tenant supplies (spec addendum §10). BC's are legacy's. */
export interface ReportRules {
  cover: { organization: string; lines: readonly string[] };
  planningTitle: string;
  /** The Lead column's and CC ID#'s abbreviation for these ministries (legacy: GCPEHQ → HQ). */
  leadAbbreviations: Readonly<Record<string, string>>;
  /** The city name that means "not decided yet": no city in the title (ActivityHandler.ashx.cs:1124-1128). */
  cityToBeDecidedName: string;
  /** Dropped from a city's name in the reports (", BC"). */
  citySuffix: string;
  /** An HQ Look Ahead's Category column keeps this category's name instead of "FYI". */
  tvRadioCategoryName: string;
  /** Planning's Significance column: "Issue" when a category name contains this text. */
  issueCategoryText: string;
  /** Planning's Significance column: "FYI Only" when a category name contains this text. */
  fyiOnlyCategoryText: string;
  rlsMaterials: readonly RlsRule[];
  rlsOrigins: readonly RlsRule[];
}
```

and in `CalendarRules`, after `reportBanner: { province: string; confidentiality: string };`:

```ts
  reports: ReportRules;
```

`packages/config/src/calendar.ts`, above `export const calendarTenantSchema = z`:

```ts
const rlsRule = z
  .object({ contains: z.array(z.string().min(1)).min(1), code: z.string().min(1), notInEvents: z.boolean().optional(), releaseTime: z.boolean().optional() })
  .strict();

/** The report texts and names (spec addendum §10): BC's are legacy's, from ActivityHandler.ashx.cs and its RDLC files. */
const reportsSchema = z
  .object({
    cover: z.object({ organization: z.string().min(1), lines: z.array(z.string().min(1)).min(1).max(3) }).strict(),
    planningTitle: z.string().min(1),
    leadAbbreviations: z.record(z.string().min(1), z.string().min(1)),
    cityToBeDecidedName: z.string().min(1),
    citySuffix: z.string(),
    tvRadioCategoryName: z.string().min(1),
    issueCategoryText: z.string().min(1),
    fyiOnlyCategoryText: z.string().min(1),
    rlsMaterials: z.array(rlsRule),
    rlsOrigins: z.array(rlsRule),
  })
  .strict();
```

and in the schema's object, after the `reportBanner` line:

```ts
    reports: reportsSchema,
```

`config/tenants/bc.json`: the `reportBanner` line gains a trailing comma, and after it, still inside `"calendar"`:

```json
    "reports": {
      "cover": { "organization": "Government Communications and Public Engagement", "lines": ["BC GOVERNMENT", "CORPORATE LOOK AHEAD"] },
      "planningTitle": "GCPE Corporate Calendar: Schedule of Activities",
      "leadAbbreviations": { "GCPEHQ": "HQ" },
      "cityToBeDecidedName": "TBD",
      "citySuffix": ", BC",
      "tvRadioCategoryName": "TV / Radio",
      "issueCategoryText": "Issue",
      "fyiOnlyCategoryText": "FYI Only",
      "rlsMaterials": [
        { "contains": ["News Release"], "code": "NR" },
        { "contains": ["Information Bulletin"], "code": "IB" },
        { "contains": ["Opinion Editorial"], "code": "OpEd" },
        { "contains": ["Report"], "code": "Report", "notInEvents": true },
        { "contains": ["Statement"], "code": "STMT" },
        { "contains": ["Traffic Advisory"], "code": "TA" },
        { "contains": ["News You Can Use"], "code": "NYCU" },
        { "contains": ["Fact Sheet", "Factsheet"], "code": "Fact Sheet" },
        { "contains": ["Newsletter"], "code": "e-news", "notInEvents": true, "releaseTime": false }
      ],
      "rlsOrigins": [
        { "contains": ["Ministry"], "code": "BCGov" },
        { "contains": ["Joint"], "code": "Joint" },
        { "contains": ["3rd party"], "code": "3rd party" },
        { "contains": ["Federal"], "code": "Fed" }
      ]
    }
```

These are legacy's own strings and order:
- The material and origin texts are the `materials.Contains(...)` and `origins.Contains(...)` chain of `FormatLookAheadRelease` (`ActivityHandler.ashx.cs:1176-1257`). "Factsheet" is C148's fix.
- The cover lines are the words on legacy's cover image.
- The Planning title is `PlanningReport.rdlc`'s.
- "TBD" and ", BC" are `FormatCity`'s; "TV / Radio" is the Category column's.
- "Issue" and "FYI Only" are `GeneratePlannedActivities`'s.
- GCPEHQ → HQ is the `Ministry.Replace("GCPEHQ", "HQ")` of the Look Ahead.

`apps/calendar/test/helpers.ts` and `packages/calendar-contract/src/editor.test.ts`: in each `CalendarRules` literal, after `reportBanner: …,`:

```ts
  reports: {
    cover: { organization: "Sample Communications Office", lines: ["SAMPLE PROVINCE", "CORPORATE LOOK AHEAD"] },
    planningTitle: "Sample Corporate Calendar: Schedule of Activities",
    leadAbbreviations: { FIN: "FN" },
    cityToBeDecidedName: "Sample undecided city",
    citySuffix: ", SP",
    tvRadioCategoryName: "Sample broadcast",
    issueCategoryText: "Sample issue",
    fyiOnlyCategoryText: "Sample FYI only",
    rlsMaterials: [
      { contains: ["Sample news release"], code: "NR" },
      { contains: ["Sample report"], code: "Report", notInEvents: true },
      { contains: ["Sample fact sheet", "Sample factsheet"], code: "Fact Sheet" },
      { contains: ["Sample newsletter"], code: "e-news", notInEvents: true, releaseTime: false },
    ],
    rlsOrigins: [
      { contains: ["Sample origin"], code: "Gov" },
      { contains: ["Sample joint origin"], code: "Joint" },
    ],
  },
```

`editorRulesOf` copies only `EDITOR_RULE_KEYS`, so `reports` never reaches the browser; `editor.test.ts`'s first test already pins the key set.

- [ ] **Step 4: Run them to see them pass, and type-check**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/calendar-contract packages/config`
Expected: PASS.
Run: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/calendar-contract packages/config config/tenants/bc.json apps/calendar/test/helpers.ts
git commit -m "feat(calendar-contract): report kinds and jobs, the Look Ahead's reference day, the tenant's report texts"
```

---

### Task 2: What a report reads: the list's query and visibility, no default hides, no deletions, legacy's order

Covers: spec §6 (reports are a `visible()` reader; the Look Ahead fieldset's rule), §10 ("takes the list's current filter and sort, applies `visible()`, and orders by start date, then end date, then start time"), §16 acceptance 2 (the reports part). Decisions G4, G8, G9.

**Files:**
- Create: `apps/calendar/src/reports/data.ts`, `apps/calendar/src/reports/data.test.ts`.
- Modify: `apps/calendar/src/list/query.ts`, `apps/calendar/src/list/export.ts`.

**Interfaces:**
- Consumes: `listWhere`, `scopeOf`, `ListScope` (`list/query.ts`); `rowsOf` (`list/rows.ts`); `inReadSnapshot`; `can.seeLookAheadFieldset`; `dbNow`; `ApiDeps`; `CalendarActor`.
- Produces:
  - `interface WhereOptions { defaultHides?: boolean }`; `filterWhere(scope, f, display, o?)`; `listWhere(scope, q, o?)`; `legacyReportOrder(timeZone): SQL[]` (`list/query.ts`).
  - `REPORT_ACTIVITY_LIMIT = 5000`; `class ReportTooLargeError(what = "activities match")` with message "Too many <what>: narrow the filter and run the report again".
  - `interface ReportRow extends ListRow { categoryIds: number[]; hqSection: HqSection; longTermOutlook: boolean; executiveSummary: string | null; initiatives: string[]; nrAt: string | null }`.
  - `interface ReportData { rows: ReportRow[]; scope: ListScope; q: ListQuery; now: Date }`.
  - `reportRowsOf(tx, scope, ids): Promise<ReportRow[]>`; `reportData(deps, actor, q): Promise<ReportData>`.

- [ ] **Step 1: Write the failing test**

Create `apps/calendar/src/reports/data.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { listQuerySchema, type ListQueryInput } from "@gcpe/calendar-contract";
import { loadCalendarActor } from "../actor";
import { ActivityForbiddenError } from "../activities/errors";
import { activityCategories, activityInitiatives, activitySharedWith } from "../db/schema";
import type { ApiDeps } from "../http/routes";
import { createCalendarTestDb, createTestApp, FIXED_NOW, TEST_RULES } from "../../test/helpers";
import { insertRaw, seedWorld, type Who, type World } from "../../test/world";
import { REPORT_ACTIVITY_LIMIT, ReportTooLargeError, reportData } from "./data";

type Key = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H";
const MARCH = { from: "2046-03-01", to: "2046-03-31" };

describe("what a report reads (spec addendum §6, §10)", () => {
  let tdb: TestDatabase;
  let w: World;
  let deps: ApiDeps;
  const ids = {} as Record<Key, number>;
  const keyOf = (id: number) => (Object.keys(ids) as Key[]).find((k) => ids[k] === id) ?? String(id);
  const read = async (who: Who, q: ListQueryInput = { filter: MARCH }, rules = TEST_RULES) =>
    reportData({ ...deps, rules }, (await loadCalendarActor(tdb.db, w.as[who].id))!, listQuerySchema.parse(q));

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    const app = createTestApp(tdb.db);
    w = await seedWorld(app, tdb.db);
    deps = { db: tdb.db, rules: TEST_RULES, subscribers: [], now: () => FIXED_NOW };
    // 2046-03-10 09:00 BC is 16:00Z. Inserted out of order: the report reads start date, end date, then start time.
    const make = async (k: Key, start: string, over: Parameters<typeof insertRaw>[1] = {}) => {
      ids[k] = await insertRaw(tdb.db, { title: `Report ${k}`, startAt: new Date(start), endAt: new Date(new Date(start).getTime() + 3_600_000), hqComments: `Sample summary ${k}`, hqStatus: "new", ...over });
      await tdb.db.insert(activityCategories).values({ activityId: ids[k], categoryId: k === "G" ? w.cat.awareness : w.cat.plain });
    };
    await make("H", "2046-03-12T16:00:00Z", { contactMinistryKey: "consult" });
    await make("G", "2046-03-11T16:00:00Z");
    await make("F", "2046-03-10T21:00:00Z", { deletedAt: new Date("2046-03-01T00:00:00Z"), needsReview: ["active"] });
    await make("E", "2046-03-10T20:00:00Z", { contactMinistryKey: "finance", isConfidential: true });
    await tdb.db.insert(activitySharedWith).values({ activityId: ids.E, ministryKey: "health" });
    await make("D", "2046-03-10T19:00:00Z", { contactMinistryKey: "finance", isConfidential: true });
    await make("C", "2046-03-10T18:00:00Z", { contactMinistryKey: "finance", nrAt: new Date("2046-03-10T18:30:00Z"), longTermOutlook: true, hqSection: "issues_and_reports" });
    await make("B", "2046-03-10T17:00:00Z", { isConfidential: true });
    await make("A", "2046-03-10T16:00:00Z");
    await tdb.db.insert(activityInitiatives).values({ activityId: ids.A, initiativeId: w.ids.initiative });
  });
  afterAll(() => tdb.drop());

  const ROLES: [Who, Key[]][] = [
    ["readOnly", ["A", "B", "E", "G"]],
    ["editor", ["A", "B", "E", "G"]],
    ["financeEditor", ["C", "D", "E"]],
    ["admin", ["A", "B", "E", "G"]],
    ["hqReadOnly", ["A", "C", "G", "H"]],
    ["hqEditor", ["A", "C", "G", "H"]],
    ["hqAdvanced", ["A", "B", "C", "D", "E", "G", "H"]],
    ["hqAdmin", ["A", "B", "C", "D", "E", "G", "H"]],
  ];
  for (const [who, keys] of ROLES) {
    it(`${who}: exactly the activities the list's visibility rule allows, never a deleted one, Awareness dates and the consultations ministry included`, async () => {
      expect((await read(who)).rows.map((r) => keyOf(r.id))).toEqual(keys);
    });
  }

  it("orders by start date, end date and start time whatever the list's sort", async () => {
    const d = await read("hqAdmin", { filter: MARCH, sort: "title", dir: "desc" });
    expect(d.rows.map((r) => keyOf(r.id))).toEqual(["A", "B", "C", "D", "E", "G", "H"]);
    expect(d.now).toEqual(FIXED_NOW);
  });

  it("the Executive Summary and LA status only where the Look Ahead fieldset shows (spec addendum §6, C177)", async () => {
    const summaryOf = async (who: Who, k: Key, rules = TEST_RULES) => (await read(who, { filter: MARCH }, rules)).rows.find((r) => r.id === ids[k])!;
    for (const who of ["hqEditor", "hqAdmin"] as const) {
      expect(await summaryOf(who, "A")).toMatchObject({ executiveSummary: "Sample summary A", hqStatus: "new" });
    }
    for (const who of ["editor", "admin", "hqReadOnly"] as const) {
      expect(await summaryOf(who, "A")).toMatchObject({ executiveSummary: null, hqStatus: null });
    }
    // ShowHqCommentsField on: an Editor sees it on their own ministry's activity, not on one only shared with them.
    const shown = { ...TEST_RULES, showHqCommentsField: true };
    expect((await summaryOf("editor", "A", shown)).executiveSummary).toBe("Sample summary A");
    expect((await summaryOf("editor", "E", shown)).executiveSummary).toBeNull();
  });

  it("carries the section, Long Term Outlook, NR time, category ids and initiative short names", async () => {
    const rows = (await read("hqAdmin")).rows;
    expect(rows.find((r) => r.id === ids.C)).toMatchObject({ hqSection: "issues_and_reports", longTermOutlook: true, nrAt: "2046-03-10T18:30:00.000Z" });
    expect(rows.find((r) => r.id === ids.A)).toMatchObject({ hqSection: "in_the_news", longTermOutlook: false, nrAt: null, categoryIds: [w.cat.plain], initiatives: ["SI"] });
    expect(rows.find((r) => r.id === ids.G)!.categoryIds).toEqual([w.cat.awareness]);
  });

  it("the HQ-only parts of the query stay HQ-only", async () => {
    await expect(read("admin", { filter: MARCH, lookAhead: "look_ahead_only" })).rejects.toBeInstanceOf(ActivityForbiddenError);
    await expect(read("editor", { corporate: { days: 7, statuses: ["new"] } })).rejects.toBeInstanceOf(ActivityForbiddenError);
  });

  it(`refuses more than ${REPORT_ACTIVITY_LIMIT} activities before reading their rows`, async () => {
    await tdb.db.execute(
      sql`INSERT INTO activities (title, details, significance, schedule, contact_ministry_key, start_at, end_at, is_confirmed, status, hq_section)
          SELECT 'Sample bulk', '', '', '', 'health', '2047-06-10T16:00:00Z', '2047-06-10T17:00:00Z', true, 'reviewed', 'in_the_news' FROM generate_series(1, ${REPORT_ACTIVITY_LIMIT + 1})`,
    );
    await expect(read("editor", { filter: { from: "2047-06-01", to: "2047-06-30" } })).rejects.toBeInstanceOf(ReportTooLargeError);
    await tdb.db.execute(sql`DELETE FROM activities WHERE title = 'Sample bulk' AND start_at = '2047-06-10T16:00:00Z' AND id IN (SELECT id FROM activities WHERE title = 'Sample bulk' LIMIT 1)`);
    expect((await read("editor", { filter: { from: "2047-06-01", to: "2047-06-30" } })).rows).toHaveLength(REPORT_ACTIVITY_LIMIT);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/reports/data.test.ts`
Expected: FAIL, "Failed to resolve import "./data"".

- [ ] **Step 3: Implement**

`apps/calendar/src/list/query.ts`:
- Above `/** The filter panel and the display …`, add:

```ts
/** Options a reader other than the list itself may set. */
export interface WhereOptions {
  /**
   * The list's bare first load hides Awareness dates and the consultations ministry
   * (ActivityListProvider.ashx.cs:90-91). Legacy's reports read the filter without that step
   * (ActivityHandler.ashx.cs:36-53), so their Awareness Dates section has rows.
   */
  defaultHides?: boolean;
}
```

- Change `filterWhere`'s signature to `export function filterWhere(scope: ListScope, f: ListFilter, display: ListDisplay, o: WhereOptions = {}): SQL {`. Change its last `} else {` (the one before `parts.push(...defaultHides(scope, f));`) to `} else if (o.defaultHides ?? true) {`.
- Change `listWhere`'s signature to `export function listWhere(scope: ListScope, q: ListQuery, o: WhereOptions = {}): SQL {`, and its `filterWhere(scope, q.filter, q.display)` call to `filterWhere(scope, q.filter, q.display, o)`.
- Above `const ministryAbbreviation = sql\`…`, add:

```ts
/** Legacy's report and export order: start date, end date, then start time, in the tenant's zone (ActivityHandler.ashx.cs:46-48), whatever the list's sort. */
export function legacyReportOrder(timeZone: string): SQL[] {
  return [
    sql`(${activities.startAt} AT TIME ZONE ${timeZone})::date ASC NULLS LAST`,
    sql`(${activities.endAt} AT TIME ZONE ${timeZone})::date ASC NULLS LAST`,
    sql`to_char(${activities.startAt} AT TIME ZONE ${timeZone}, 'HH24:MI') ASC NULLS LAST`,
    sql`${activities.id} ASC`,
  ];
}
```

`apps/calendar/src/list/export.ts`: the export now uses the shared order. Replace the `ids` query in `exportWorkbook` (from `const tz = deps.rules.timeZone;` to `).map((r) => r.id);`) with:

```ts
    const ids = (
      await tx
        .select({ id: activities.id })
        .from(activities)
        .where(listWhere(scope, q))
        .orderBy(...legacyReportOrder(deps.rules.timeZone))
        .limit(EXPORT_ROW_LIMIT + 1)
    ).map((r) => r.id);
```

Then delete `import { asc, sql } from "drizzle-orm";`, and import `legacyReportOrder` from `./query` beside `idSearchOf, listWhere, scopeOf`.

Create `apps/calendar/src/reports/data.ts`:

```ts
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import type { HqSection, ListQuery, ListRow } from "@gcpe/calendar-contract";
import type { CalendarActor } from "../actor";
import { inReadSnapshot } from "../activities/store";
import { can } from "../capabilities";
import { activities, activityCategories, activityInitiatives, activitySharedWith, initiatives } from "../db/schema";
import type { ApiDeps } from "../http/routes";
import { legacyReportOrder, listWhere, scopeOf, type ListScope } from "../list/query";
import { rowsOf } from "../list/rows";
import { dbNow } from "../time";
import type { VisibilityFacts } from "../visibility";

/** The most activities one report reads; more is refused with 422 before anything is built. */
export const REPORT_ACTIVITY_LIMIT = 5000;
export class ReportTooLargeError extends Error {
  override name = "ReportTooLargeError";
  constructor(what = "activities match") {
    super(`Too many ${what}: narrow the filter and run the report again`);
  }
}

/** A list row plus what only the reports read. */
export interface ReportRow extends ListRow {
  categoryIds: number[];
  /** Where the Look Ahead places it, for every viewer, as legacy (ActivityHandler.ashx.cs:899-1068). */
  hqSection: HqSection;
  longTermOutlook: boolean;
  /** The Executive Summary, only where the viewer sees the Look Ahead fieldset (spec addendum §6); null otherwise. */
  executiveSummary: string | null;
  /** HQ Initiatives' short names, by name. */
  initiatives: string[];
  /** NR date and time. */
  nrAt: string | null;
}

export interface ReportData {
  rows: ReportRow[];
  scope: ListScope;
  q: ListQuery;
  /** The database's now: the "Updated" time and every "updated X ago". */
  now: Date;
}

async function grouped<V>(q: Promise<{ id: number; v: V }[]>): Promise<Map<number, V[]>> {
  const out = new Map<number, V[]>();
  for (const r of await q) out.set(r.id, [...(out.get(r.id) ?? []), r.v]);
  return out;
}

/** The list's rows for these ids, with the reports' extra facts. Still filtered by visibleSql (rowsOf). */
export async function reportRowsOf(tx: DbOrTx, scope: ListScope, ids: readonly number[]): Promise<ReportRow[]> {
  const base = await rowsOf(tx, scope, ids);
  if (base.length === 0) return [];
  const got = base.map((r) => r.id);
  const extra = new Map(
    (
      await tx
        .select({ id: activities.id, hqSection: activities.hqSection, longTermOutlook: activities.longTermOutlook, hqComments: activities.hqComments, nrAt: activities.nrAt })
        .from(activities)
        .where(inArray(activities.id, got))
    ).map((r) => [r.id, r]),
  );
  const categoryIds = await grouped(tx.select({ id: activityCategories.activityId, v: activityCategories.categoryId }).from(activityCategories).where(inArray(activityCategories.activityId, got)));
  const shared = await grouped(tx.select({ id: activitySharedWith.activityId, v: activitySharedWith.ministryKey }).from(activitySharedWith).where(inArray(activitySharedWith.activityId, got)));
  const shortNames = await grouped(
    tx
      .select({ id: activityInitiatives.activityId, v: initiatives.shortName })
      .from(activityInitiatives)
      .innerJoin(initiatives, eq(initiatives.id, activityInitiatives.initiativeId))
      .where(inArray(activityInitiatives.activityId, got))
      .orderBy(asc(initiatives.name)),
  );
  return base.map((r) => {
    const x = extra.get(r.id)!;
    const facts: VisibilityFacts = { contactMinistryKey: r.ministryKey, sharedMinistryKeys: shared.get(r.id) ?? [], isConfidential: r.isConfidential, isDeleted: r.isDeleted };
    return {
      ...r,
      categoryIds: categoryIds.get(r.id) ?? [],
      hqSection: x.hqSection,
      longTermOutlook: x.longTermOutlook,
      executiveSummary: can.seeLookAheadFieldset(scope.actor, scope.rules, facts) ? x.hqComments : null,
      initiatives: (shortNames.get(r.id) ?? []).filter((n): n is string => !!n),
      nrAt: x.nrAt?.toISOString() ?? null,
    };
  });
}

/**
 * What a report reads (spec addendum §10): the list's query and visibility, without the list's
 * default hides, never a deleted activity, in legacy's order. One snapshot, so the rows and "now" agree.
 */
export function reportData(deps: ApiDeps, actor: CalendarActor, q: ListQuery): Promise<ReportData> {
  return inReadSnapshot(deps.db, async (tx) => {
    const scope = await scopeOf(tx, deps, actor);
    const ids = (
      await tx
        .select({ id: activities.id })
        .from(activities)
        .where(and(listWhere(scope, q, { defaultHides: false }), isNull(activities.deletedAt)))
        .orderBy(...legacyReportOrder(deps.rules.timeZone))
        .limit(REPORT_ACTIVITY_LIMIT + 1)
    ).map((r) => r.id);
    if (ids.length > REPORT_ACTIVITY_LIMIT) throw new ReportTooLargeError();
    return { rows: await reportRowsOf(tx, scope, ids), scope, q, now: await dbNow(tx, deps.now) };
  });
}
```

- [ ] **Step 4: Run it to see it pass, with the list's and the export's tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/reports/data.test.ts apps/calendar/src/list apps/calendar/src/http/export-routes.test.ts apps/calendar/src/http/list-routes.test.ts`
Expected: PASS (the data test's 13, and the list's and the export's unchanged).
Run both `tsc` commands. Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/calendar/src/list/query.ts apps/calendar/src/list/export.ts apps/calendar/src/reports/data.ts apps/calendar/src/reports/data.test.ts
git commit -m "feat(calendar): what a report reads: the list's query and visibility, no default hides or deletions, legacy's order"
```

---
### Task 3: The report document, legacy's date stamps and row text

Covers: spec §10.2 (row text, flag, RLS codes, colours), §10.3 (the Exec's row text), §10.4–§10.5 ("created/updated X ago"), §14 C148; carry-forward § 5g (the legacy report fixes; rows link to `/hub/calendar/activities/:id`). Decisions G1, G12, G13, G14, G15, G17. Review Focus 3.

**Files:**
- Create: `apps/calendar/src/reports/model.ts`, `apps/calendar/src/reports/dates.ts`, `apps/calendar/src/reports/text.ts`, `apps/calendar/src/reports/text.test.ts`, `apps/calendar/test/report-rows.ts`.

**Interfaces:**
- Consumes: Task 1's `CalendarRules.reports`, `friendlySpan`, `sameCategoryName`; Task 2's `ReportRow`; `wallClock`, `addDays` (`../time`).
- Produces:
  - `model.ts`: `Run { text; bold?; italic?; underline?; color?; size?; link? }`, `Cell { runs; fill?; align? }`, the blocks `HeadingBlock` (`kind: "heading"`, `runs`, `size`, `align?`, `spaceBefore?`), `TableBlock` (`widths`, `header: Cell[]`, `rows: Cell[][]`), `BannerBlock` (`organization`, `lines`), `LegendBlock` (`items: { colour; runs }[]`) and `PageBreakBlock`, `type Block`, `Running { left?; center?; right?; pageNumbers? }`, `ReportDoc { page: "letter-portrait" | "legal-landscape"; title; header: Running | null; footer: Running | null; firstPage?; blocks }`, and `rowCountOf(doc)`.
  - `dates.ts`: `weekdayOf`, `longDay` ("Tuesday, November 3, 2026"), `shortDay` ("Tue Nov 3"), `titleDay(date, withYear)` ("Tuesday, Nov. 3, 2026"), `monthHeading`, `monthStart`, `addMonths` (.NET's clamp), `clockTime` ("1:15 PM"), `updatedLong`, `updatedNumeric`.
  - `text.ts`:
    - `COLOURS`;
    - `interface TextContext { rules; isHq; now; today; origin: string | null }`;
    - `cleanTitle`, `cityOf`, `formatTitle`, `executiveSummaryRuns`, `linkify`, `initiativeRuns`, `titleDetailsRuns(row, rules, { thirtySixtyNinety })`, `lookAheadText(row, rules, { titleOnly })`;
    - `createdOrUpdated(row, now, tz)`, `lastUpdatedText(row, now, tz)`, `detailedRuns(row, c)`, `flagRuns(row)`, `leadOf(row, rules)`, `minIdRuns(row, c)`;
    - `type LookAheadTable = "events" | "issues" | "news"`, `rlsLines(row, rules, { table, day })`, `categoryText(row, rules, isHq)`.
  - `test/report-rows.ts`: `bc(date, time)` (an ISO instant at BC wall time, UTC−7), `reportRow(over)`, `plain(runs)`, `outline(doc)` ("# heading", "---", "[banner] …", "[legend] …", and each table row's CC ID#).

- [ ] **Step 1: Write the test helpers and the failing test**

Create `apps/calendar/test/report-rows.ts`:

```ts
import type { ReportRow } from "../src/reports/data";

/** BC is UTC−7 from 2026-11-01: "2026-11-10", "09:00" is 16:00Z. */
export const bc = (date: string, time: string) => new Date(`${date}T${time}:00-07:00`).toISOString();

/** A report row with fictional values: a confirmed one-hour Health activity at 9 AM BC on 2026-11-10, In the News. */
export function reportRow(over: Partial<ReportRow> = {}): ReportRow {
  return {
    id: 20001, version: 1, ministryKey: "health", ministryAbbreviation: "HLTH", status: "reviewed", hqStatus: null, isDeleted: false,
    isWatched: false, watcherNames: [], isShared: false, hasRelease: false,
    createdAt: "2026-10-01T16:00:00.000Z", lastUpdatedAt: "2026-10-02T16:00:00.000Z", lastUpdatedByName: "Robin Staff",
    keywords: [], startAt: bc("2026-11-10", "09:00"), endAt: bc("2026-11-10", "10:00"), isAllDay: false, isConfirmed: true, potentialDates: "",
    title: "Sample activity", details: "Sample details", significance: "Sample significance", strategy: "", schedule: "",
    categories: ["Sample plain category"], isIssue: false, isConfidential: false, commMaterials: [], nrOrigins: [], nrDistribution: null,
    premierRequested: null, leadOrganization: "", translations: [], city: "Sample City", venue: "",
    commContact: { name: "Robin Staff", phone: "250-555-0101" }, governmentRepresentative: null, eventPlanner: null, needsReview: [],
    categoryIds: [32], hqSection: "in_the_news", longTermOutlook: false, executiveSummary: null, initiatives: [], nrAt: null,
    ...over,
  };
}

/** Each run's text joined: what a reader sees, styles aside. */
export const plain = (runs: { text: string }[]) => runs.map((r) => r.text).join("");

/**
 * A document's structure, for golden comparisons: "# heading", "---" for a page break, and each
 * table row as its CC ID# ("HLTH-20001"). Colours and fonts are the renderer's tests' business.
 */
export function outline(doc: { blocks: import("../src/reports/model").Block[] }): string[] {
  const out: string[] = [];
  for (const b of doc.blocks) {
    if (b.kind === "heading") out.push(`# ${plain(b.runs)}`);
    else if (b.kind === "pageBreak") out.push("---");
    else if (b.kind === "banner") out.push(`[banner] ${b.lines.join(" ")}`);
    else if (b.kind === "legend") out.push(`[legend] ${b.items.map((i) => plain(i.runs)).join(" | ")}`);
    else for (const row of b.rows) out.push(row.flatMap((cell) => plain(cell.runs).split("\n")).find((t) => /^[A-Z][A-Z0-9]*-\d+$/.test(t)) ?? "?");
  }
  return out;
}
```

Create `apps/calendar/src/reports/text.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { TEST_RULES } from "../../test/helpers";
import { bc, plain, reportRow } from "../../test/report-rows";
import { addMonths, longDay, shortDay, titleDay, updatedLong, updatedNumeric } from "./dates";
import {
  categoryText, cleanTitle, COLOURS, createdOrUpdated, detailedRuns, executiveSummaryRuns, formatTitle, lastUpdatedText, linkify, lookAheadText, minIdRuns, rlsLines, titleDetailsRuns,
} from "./text";

const tz = TEST_RULES.timeZone;
// 2026-11-03 11:00 BC, a Tuesday.
const NOW = new Date("2026-11-03T18:00:00Z");
const c = { rules: TEST_RULES, isHq: false, now: NOW, today: "2026-11-03", origin: "https://staff.example.test" };

describe("report dates in legacy's formats", () => {
  it("days, titles, months and the Updated stamps", () => {
    expect(longDay("2026-11-03")).toBe("Tuesday, November 3, 2026");
    expect(shortDay("2026-11-03")).toBe("Tue Nov 3");
    expect(titleDay("2026-05-01", false)).toBe("Friday, May. 1");
    expect(titleDay("2026-11-03", true)).toBe("Tuesday, Nov. 3, 2026");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-11-15", 1)).toBe("2026-12-15");
    expect(updatedLong(NOW, tz)).toBe("Updated Tuesday, Nov 3, 2026 11:00 AM");
    expect(updatedNumeric(new Date("2026-11-03T20:05:09Z"), tz)).toBe("Updated 11/3/2026 1:05:09 PM");
  });
});

describe("report text (ActivityHandler.ashx.cs:1087-1257)", () => {
  it("a title drops the raw **CONFIDENTIAL** marker and a city its suffix and the undecided city", () => {
    expect(cleanTitle("**CONFIDENTIAL** Sample launch")).toBe("Sample launch");
    expect(cleanTitle("Sample **confidential** launch")).toBe("Sample launch");
    expect(cleanTitle("Sample **bold** launch")).toBe("Sample **bold** launch");
    expect(formatTitle(reportRow({ city: "Sampleton, SP" }), TEST_RULES)).toBe("Sampleton - Sample activity");
    expect(formatTitle(reportRow({ city: "Sample undecided city" }), TEST_RULES)).toBe("Sample activity");
    expect(formatTitle(reportRow({ city: null }), TEST_RULES)).toBe("Sample activity");
  });

  it("the Executive Summary's **bold** and _italic_ become styles; a bare ** is no summary", () => {
    expect(executiveSummaryRuns("**Sampleton -- Sample launch:** details _soon_\r\nNext line")).toEqual([
      { text: "Sampleton -- Sample launch:", bold: true },
      { text: " details " },
      { text: "soon", italic: true },
      { text: "\nNext line" },
    ]);
    expect(executiveSummaryRuns("**")).toBeNull();
    expect(executiveSummaryRuns(null)).toBeNull();
    expect(executiveSummaryRuns("an unclosed ** marker")).toEqual([{ text: "an unclosed ** marker" }]);
  });

  it("the first web address becomes a link: http:// shown without its scheme, a [label] before it used as its text", () => {
    expect(linkify([{ text: "See http://example.test/page/ for more" }])).toEqual([
      { text: "See " },
      { text: "example.test/page", link: "http://example.test/page", underline: true, color: COLOURS.link },
      { text: " for more" },
    ]);
    expect(linkify([{ text: "Title", bold: true }, { text: ": read [the notice]https://example.test/n" }])).toEqual([
      { text: "Title", bold: true },
      { text: ": read " },
      { text: "the notice", link: "https://example.test/n", underline: true, color: COLOURS.link },
    ]);
    expect(linkify([{ text: "No address, and javascript:alert(1) is not one" }])).toEqual([{ text: "No address, and javascript:alert(1) is not one" }]);
  });

  it("title and details: bold title, the red Not for Look Ahead, the 30/60/90's significance at 9 pt", () => {
    const row = reportRow({ isConfidential: true });
    expect(titleDetailsRuns(row, TEST_RULES, { thirtySixtyNinety: false })).toEqual([
      { text: "Sample City - Sample activity", bold: true },
      { text: ": " },
      { text: "Not for Look Ahead ", color: COLOURS.darkRed },
      { text: "Sample details" },
    ]);
    expect(plain(titleDetailsRuns(reportRow(), TEST_RULES, { thirtySixtyNinety: true }))).toBe("Sample City - Sample activity: Sample details\nSignificance: Sample significance");
  });

  it("the Look Ahead's text: the Executive Summary when the viewer has it, the initiatives after", () => {
    expect(plain(lookAheadText(reportRow({ initiatives: ["SI", "SJ"] }), TEST_RULES, { titleOnly: false }))).toBe("Sample City - Sample activity: Sample details SI, SJ");
    expect(plain(lookAheadText(reportRow({ executiveSummary: "**Summary** text" }), TEST_RULES, { titleOnly: false }))).toBe("Summary text");
    expect(plain(lookAheadText(reportRow(), TEST_RULES, { titleOnly: true }))).toBe("Sample City - Sample activity");
  });

  it("created or updated, as the list says it; the Exec Look Ahead's Last updated says it once", () => {
    expect(createdOrUpdated(reportRow({ status: "new", createdAt: "2026-11-02T18:00:00Z" }), NOW, tz)).toBe("created yesterday");
    expect(createdOrUpdated(reportRow({ lastUpdatedAt: "2026-09-01T18:00:00Z" }), NOW, tz)).toBe("updated 2 months ago");
    expect(lastUpdatedText(reportRow({ lastUpdatedAt: "2026-11-03T16:15:00Z" }), NOW, tz)).toBe("Last updated today at 9:15 AM");
    expect(lastUpdatedText(reportRow({ lastUpdatedAt: "2026-11-02T22:00:00Z" }), NOW, tz)).toBe("Last updated yesterday at 3:00 PM");
    expect(lastUpdatedText(reportRow({ lastUpdatedAt: "2026-09-01T18:00:00Z" }), NOW, tz)).toBe("Last updated 2 months ago");
  });

  it("the Exec Look Ahead's row: title, details, significance, City: Venue, Last updated; the typed Other City, not Other...", () => {
    const runs = detailedRuns(reportRow({ city: "Sampleton, SP", venue: "Sample Hall", title: "**CONFIDENTIAL** Sample launch" }), c);
    expect(plain(runs)).toBe("Sample launch\nSample details\nSample significance\nSampleton: Sample Hall  Last updated 1 month ago");
    expect(runs.find((r) => r.text === "Sampleton: Sample Hall")).toMatchObject({ bold: true });
    expect(plain(detailedRuns(reportRow({ city: null, venue: "", details: "", significance: "" }), c))).toBe("Sample activity\nLast updated 1 month ago");
  });

  it("the CC ID# links to the activity in the staff app, under the tenant's abbreviation", () => {
    expect(minIdRuns(reportRow(), c)).toEqual([{ text: "HLTH-20001", color: COLOURS.link, link: "https://staff.example.test/hub/calendar/activities/20001" }]);
    expect(minIdRuns(reportRow({ ministryAbbreviation: "FIN" }), { ...c, origin: null })).toEqual([{ text: "FN-20001", color: COLOURS.link }]);
  });

  it("RLS: origin above material, the first rule wins, Report only outside Events, both fact sheet spellings (C148), the NR time on its day", () => {
    const day = "2026-11-10";
    const r = (over: object) => reportRow(over);
    expect(rlsLines(r({}), TEST_RULES, { table: "events", day })).toEqual(["-"]);
    expect(rlsLines(r({ nrOrigins: ["Sample origin"], commMaterials: ["Sample news release"] }), TEST_RULES, { table: "events", day })).toEqual(["Gov", "NR"]);
    expect(rlsLines(r({ commMaterials: ["Sample report"] }), TEST_RULES, { table: "events", day })).toEqual(["-"]);
    expect(rlsLines(r({ commMaterials: ["Sample report"] }), TEST_RULES, { table: "issues", day: null })).toEqual(["Report"]);
    expect(rlsLines(r({ commMaterials: ["Sample factsheet"] }), TEST_RULES, { table: "events", day })).toEqual(["Fact Sheet"]);
    const nr = { commMaterials: ["Sample news release"], nrAt: bc(day, "13:15") };
    expect(rlsLines(r(nr), TEST_RULES, { table: "events", day })).toEqual(["NR", "1:15 pm"]);
    expect(rlsLines(r(nr), TEST_RULES, { table: "events", day: "2026-11-11" })).toEqual(["NR"]);
    expect(rlsLines(r({ ...nr, nrAt: bc(day, "09:00") }), TEST_RULES, { table: "events", day })).toEqual(["NR"]);
    expect(rlsLines(r({ commMaterials: ["Sample newsletter"], nrAt: bc(day, "13:15") }), TEST_RULES, { table: "news", day })).toEqual(["e-news"]);
  });

  it("the Category column: Issue, HQ's FYI unless only the broadcast category, else the names", () => {
    expect(categoryText(reportRow({ isIssue: true }), TEST_RULES, true)).toBe("Issue");
    expect(categoryText(reportRow(), TEST_RULES, true)).toBe("FYI");
    expect(categoryText(reportRow({ categories: [" Sample  broadcast"] }), TEST_RULES, true)).toBe(" Sample  broadcast");
    expect(categoryText(reportRow({ categories: ["Sample plain category", "Sample other"] }), TEST_RULES, false)).toBe("Sample plain category, Sample other");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/reports/text.test.ts`
Expected: FAIL, "Failed to resolve import "./dates"".

- [ ] **Step 3: Implement**

Create `apps/calendar/src/reports/model.ts`:

```ts
/**
 * A report as a renderer-neutral document: plain data, so it crosses into the rendering worker
 * by structured clone, and any renderer behind PdfRenderer (pdfmake today; a browser on a container
 * host later) draws the same thing. Builders choose every colour and break; renderers only draw.
 */

/** A run of text. A "\n" inside `text` breaks the line. */
export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** "#rrggbb". */
  color?: string;
  /** Points; the document's 9 pt otherwise. */
  size?: number;
  /** An absolute http(s) URL. */
  link?: string;
}

export interface Cell {
  runs: Run[];
  /** Background, "#rrggbb". */
  fill?: string;
  align?: "left" | "center" | "right";
}

export interface HeadingBlock {
  kind: "heading";
  runs: Run[];
  size: number;
  align?: "left" | "center";
  /** Space above, in points. */
  spaceBefore?: number;
}

export interface TableBlock {
  kind: "table";
  /** Points, or "*" for the rest of the line. */
  widths: (number | "*")[];
  /** Repeated at the top of every page the table runs onto. */
  header: Cell[];
  rows: Cell[][];
}

/** The Look Ahead's cover banner: the organization's name above the report's name, white on dark grey. */
export interface BannerBlock {
  kind: "banner";
  organization: string;
  lines: string[];
}

/** The cover's "Contents:" legend. */
export interface LegendBlock {
  kind: "legend";
  items: { colour: string; runs: Run[] }[];
}

export interface PageBreakBlock {
  kind: "pageBreak";
}

export type Block = HeadingBlock | TableBlock | BannerBlock | LegendBlock | PageBreakBlock;

/** Running text at one edge of the page. */
export interface Running {
  left?: Run[];
  center?: Run[];
  right?: Run[];
  /** "Page X of Y" at the right. */
  pageNumbers?: boolean;
}

export interface ReportDoc {
  page: "letter-portrait" | "legal-landscape";
  /** The PDF's own title. */
  title: string;
  header: Running | null;
  footer: Running | null;
  /** Page 1's own header and footer, where they differ (the Look Ahead's cover). */
  firstPage?: { header: Running | null; footer: Running | null };
  blocks: Block[];
}

/** The table rows a document holds: what a render costs. */
export function rowCountOf(doc: ReportDoc): number {
  return doc.blocks.reduce((n, b) => n + (b.kind === "table" ? b.rows.length : 0), 0);
}
```

Create `apps/calendar/src/reports/dates.ts`:

```ts
import { wallClock } from "../time";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const parts = (date: string) => date.split("-").map(Number) as [number, number, number];

/** 0 is Sunday, for a BC date (YYYY-MM-DD). */
export function weekdayOf(date: string): number {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** .NET's "dddd, MMMM d, yyyy": "Tuesday, November 3, 2026" (a day's heading; "No Activities for …"). */
export function longDay(date: string): string {
  const [y, m, d] = parts(date);
  return `${DAYS[weekdayOf(date)]}, ${MONTHS[m - 1]} ${d}, ${y}`;
}

/** .NET's "ddd MMM d": "Tue Nov 3" (a day table's first header cell). */
export function shortDay(date: string): string {
  const [, m, d] = parts(date);
  return `${DAYS[weekdayOf(date)]!.slice(0, 3)} ${MONTHS[m - 1]!.slice(0, 3)} ${d}`;
}

/** .NET's "dddd, MMM. d[, yyyy]" (the Look Ahead's title, ActivityHandler.ashx.cs:668-673). */
export function titleDay(date: string, withYear: boolean): string {
  const [y, m, d] = parts(date);
  return `${DAYS[weekdayOf(date)]}, ${MONTHS[m - 1]!.slice(0, 3)}. ${d}${withYear ? `, ${y}` : ""}`;
}

/** "November 2026" (a 30/60/90 month's heading). */
export function monthHeading(date: string): string {
  const [y, m] = parts(date);
  return `${MONTHS[m - 1]} ${y}`;
}

export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** .NET's AddMonths: the same day of the month, or the month's last day when it has fewer. */
export function addMonths(date: string, n: number): string {
  const [y, m, d] = parts(date);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}

const twelve = (hh: number) => (hh % 12 === 0 ? 12 : hh % 12);

/** "h:mm tt": "1:15 PM". */
export function clockTime(at: Date, timeZone: string): string {
  const [hh, mm] = wallClock(at, timeZone).time.split(":").map(Number) as [number, number];
  return `${twelve(hh)}:${String(mm).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}`;
}

/** The Look Ahead's and 30/60/90's "Updated dddd, MMM d, yyyy h:mm tt". */
export function updatedLong(now: Date, timeZone: string): string {
  const { date } = wallClock(now, timeZone);
  const [y, m, d] = parts(date);
  return `Updated ${DAYS[weekdayOf(date)]}, ${MONTHS[m - 1]!.slice(0, 3)} ${d}, ${y} ${clockTime(now, timeZone)}`;
}

/** Planning's "Updated M/d/yyyy h:mm:ss tt". */
export function updatedNumeric(now: Date, timeZone: string): string {
  const w = wallClock(now, timeZone);
  const [y, m, d] = parts(w.date);
  const hh = Math.floor(w.secondsOfDay / 3600);
  const mm = Math.floor((w.secondsOfDay % 3600) / 60);
  const ss = w.secondsOfDay % 60;
  return `Updated ${m}/${d}/${y} ${twelve(hh)}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}`;
}
```

Create `apps/calendar/src/reports/text.ts`:

```ts
import { friendlySpan, sameCategoryName, type CalendarRules } from "@gcpe/calendar-contract";
import { addDays, wallClock } from "../time";
import type { ReportRow } from "./data";
import { clockTime } from "./dates";
import type { Run } from "./model";

/** Legacy's report colours (docs/parity/legacy-report-layouts.md, pixel-verified where it says so). */
export const COLOURS = {
  events: "#558abd",
  issues: "#ccc0d9",
  issuesDate: "#f2dbdb",
  news: "#e8f3a9",
  awareness: "#eaf1dd",
  outlook: "#edf2f8",
  outlookHeader: "#9e3a38",
  listHeader: "#000000",
  thirtySixtyNinety: "#35989d",
  planning: "#384c70",
  white: "#ffffff",
  zebra: "#d9d9d9",
  heading: "#365f91",
  draft: "#9e3a38",
  banner: "#595959",
  darkRed: "#8b0000",
  seaGreen: "#2e8b57",
  flag: "#ffa500",
  link: "#0000ee",
  pending: "#1919d2",
  lastUpdated: "#cf7a50",
} as const;

/** What turns a row into report text: the tenant's rules, the viewer's HQ flag, the clock and the staff app's origin. */
export interface TextContext {
  rules: CalendarRules;
  /** Legacy's IsAppOwner: the HQ variant of the Look Ahead. */
  isHq: boolean;
  now: Date;
  /** Today's BC date. */
  today: string;
  /** "https://host" of the staff app, for each row's link; null leaves the CC ID# unlinked. */
  origin: string | null;
}

/**
 * A title without the raw `**CONFIDENTIAL**` marker, which legacy printed asterisks and all
 * (docs/parity/legacy-report-layouts.md, discrepancy 8).
 */
export function cleanTitle(title: string): string {
  return title.replace(/\*\*\s*confidential\s*\*\*/gi, " ").replace(/\s+/g, " ").trim();
}

/** The city for a title, without the tenant's suffix; null when there is none or it is the "to be decided" city. */
export function cityOf(row: Pick<ReportRow, "city">, rules: CalendarRules): string | null {
  if (!row.city || row.city === rules.reports.cityToBeDecidedName) return null;
  const city = rules.reports.citySuffix ? row.city.replaceAll(rules.reports.citySuffix, "") : row.city;
  return city.trim() || null;
}

/** Legacy's FormatTitle: "City - Title". */
export function formatTitle(row: Pick<ReportRow, "city" | "title">, rules: CalendarRules): string {
  const city = cityOf(row, rules);
  return `${city ? `${city} - ` : ""}${cleanTitle(row.title)}`;
}

const BOLD_OPEN = "";
const BOLD_CLOSE = "";
const ITALIC_OPEN = "";
const ITALIC_CLOSE = "";

/**
 * Legacy's FormatHqComments (ActivityHandler.ashx.cs:1087-1112): `**bold**`, then `_italic_`,
 * pair by pair; null for an empty one or the clone's bare "**".
 */
export function executiveSummaryRuns(summary: string | null): Run[] | null {
  if (summary === null || summary.length <= 2) return null;
  let s = summary.replace(/[-]/g, "");
  for (;;) {
    let marker = "**";
    let start = s.indexOf(marker);
    if (start === -1) {
      marker = "_";
      start = s.indexOf(marker);
    }
    if (start === -1) break;
    const end = s.indexOf(marker, start + marker.length);
    if (end === -1) break;
    const [open, close] = marker === "_" ? [ITALIC_OPEN, ITALIC_CLOSE] : [BOLD_OPEN, BOLD_CLOSE];
    s = `${s.slice(0, start)}${open}${s.slice(start + marker.length, end)}${close}${s.slice(end + marker.length)}`;
  }
  const out: Run[] = [];
  let bold = 0;
  let italic = 0;
  for (const part of s.replace(/\r\n/g, "\n").split(/([-])/)) {
    if (part === BOLD_OPEN) bold++;
    else if (part === BOLD_CLOSE) bold--;
    else if (part === ITALIC_OPEN) italic++;
    else if (part === ITALIC_CLOSE) italic--;
    else if (part) out.push({ text: part, ...(bold > 0 ? { bold: true } : {}), ...(italic > 0 ? { italic: true } : {}) });
  }
  return out;
}

function sliceRuns(runs: Run[], from: number, to: number): Run[] {
  const out: Run[] = [];
  let pos = 0;
  for (const r of runs) {
    const end = pos + r.text.length;
    const a = Math.max(from, pos);
    const b = Math.min(to, end);
    if (a < b) out.push({ ...r, text: r.text.slice(a - pos, b - pos) });
    pos = end;
  }
  return out;
}

/**
 * Legacy's AddNewDetailsRow (ActivityHandler.ashx.cs:1063-1085): the first http:// (else https://)
 * address becomes a link. Its text is a "[label]" written just before it, else the address, an
 * http:// one without its scheme.
 */
export function linkify(runs: Run[]): Run[] {
  const text = runs.map((r) => r.text).join("");
  let start = text.indexOf("http://");
  const isHttp = start !== -1;
  if (!isHttp) start = text.indexOf("https://");
  if (start === -1) return runs;
  const stop = /[\s<]/.exec(text.slice(start));
  const end = stop ? start + stop.index : text.length;
  const url = text.slice(start, end).replace(/\/+$/, "");
  if (url.length <= "http://".length) return runs;
  let label = isHttp ? url.slice("http://".length) : url;
  let keep = start;
  const before = text.slice(0, start);
  if (before.endsWith("]")) {
    const open = before.indexOf("[");
    if (open !== -1) {
      label = before.slice(open + 1, -1);
      keep = open;
    }
  }
  return [...sliceRuns(runs, 0, keep), { text: label, link: url, underline: true, color: COLOURS.link }, ...sliceRuns(runs, end, text.length)];
}

/** Legacy's FormatInitiative: the short names, sea-green. */
export function initiativeRuns(row: Pick<ReportRow, "initiatives">): Run[] {
  return row.initiatives.length ? [{ text: ` ${row.initiatives.join(", ")}`, color: COLOURS.seaGreen }] : [];
}

/**
 * Legacy's FormatTitleDetails (ActivityHandler.ashx.cs:1114-1128): "**City - Title**: details",
 * the red "Not for Look Ahead" before the details; the 30/60/90 adds the significance and sets
 * the details at 9 pt.
 */
export function titleDetailsRuns(row: ReportRow, rules: CalendarRules, o: { thirtySixtyNinety: boolean }): Run[] {
  const size = o.thirtySixtyNinety ? { size: 9 } : {};
  const body: Run[] = [
    ...(row.isConfidential ? [{ text: "Not for Look Ahead ", color: COLOURS.darkRed, ...size }] : []),
    { text: row.details, ...size },
    ...(o.thirtySixtyNinety && row.significance ? [{ text: "\nSignificance: ", italic: true, ...size }, { text: row.significance, ...size }] : []),
  ];
  return [{ text: formatTitle(row, rules), bold: true }, { text: ": " }, ...body];
}

/** The Look Ahead's row text: the Executive Summary where the viewer sees it, else the title and details, then the initiatives. */
export function lookAheadText(row: ReportRow, rules: CalendarRules, o: { titleOnly: boolean }): Run[] {
  const summary = executiveSummaryRuns(row.executiveSummary);
  const text = summary ?? (o.titleOnly ? [{ text: formatTitle(row, rules), bold: true }] : titleDetailsRuns(row, rules, { thirtySixtyNinety: false }));
  return linkify([...text, ...initiativeRuns(row)]);
}

/** "today at 3:15 PM", "yesterday at …", or "2 months ago", by the BC calendar. */
function whenText(at: Date, now: Date, timeZone: string, withTime: boolean): string {
  const day = wallClock(at, timeZone).date;
  const today = wallClock(now, timeZone).date;
  if (withTime && day === today) return `today at ${clockTime(at, timeZone)}`;
  if (day === addDays(today, -1)) return withTime ? `yesterday at ${clockTime(at, timeZone)}` : "yesterday";
  return `${friendlySpan(at, now, timeZone).toLowerCase()} ago`;
}

/** Legacy's GetCreatedOrUpdatedMessage (ActivityListProvider.ashx.cs:669-688): "created 3 days ago", "updated yesterday". */
export function createdOrUpdated(row: Pick<ReportRow, "status" | "createdAt" | "lastUpdatedAt">, now: Date, timeZone: string): string {
  const isNew = row.status === "new";
  return `${isNew ? "created" : "updated"} ${whenText(new Date(isNew ? row.createdAt : row.lastUpdatedAt), now, timeZone, false)}`;
}

/** The Exec Look Ahead's "Last updated …", once ("Last updated updated" was legacy's, discrepancy 5). */
export function lastUpdatedText(row: Pick<ReportRow, "lastUpdatedAt">, now: Date, timeZone: string): string {
  return `Last updated ${whenText(new Date(row.lastUpdatedAt), now, timeZone, true)}`;
}

/**
 * The Exec Look Ahead's row (ActivityHandler.ashx.cs:984-1035): the title, details, significance,
 * "City: Venue" and when it was last updated. The city is the one shown everywhere else, the typed
 * Other City included (legacy printed "Other...").
 */
export function detailedRuns(row: ReportRow, c: TextContext): Run[] {
  const city = row.city ? (c.rules.reports.citySuffix ? row.city.replaceAll(c.rules.reports.citySuffix, "").trim() : row.city) : "";
  const cityVenue = [city, row.venue].filter(Boolean).join(": ");
  const runs: Run[] = [{ text: cleanTitle(row.title), bold: true }];
  if (row.details) runs.push({ text: `\n${row.details}` });
  if (row.significance) runs.push({ text: `\n${row.significance}` });
  if (cityVenue) runs.push({ text: "\n" }, { text: cityVenue, bold: true });
  runs.push({ text: cityVenue ? "  " : "\n" }, { text: lastUpdatedText(row, c.now, c.rules.timeZone), size: 8, color: COLOURS.lastUpdated });
  return linkify(runs);
}

/** Legacy's FormatFlag: NEW or CHANGED in orange, from the LA status the viewer may see. */
export function flagRuns(row: Pick<ReportRow, "hqStatus">): Run[] {
  return row.hqStatus ? [{ text: `\n${row.hqStatus.toUpperCase()}`, bold: true, color: COLOURS.flag }] : [];
}

/** The Lead column and the CC ID#'s prefix: the ministry's abbreviation, mapped as the tenant says (GCPEHQ → HQ). */
export function leadOf(row: Pick<ReportRow, "ministryAbbreviation">, rules: CalendarRules): string {
  const abbr = row.ministryAbbreviation ?? "";
  return rules.reports.leadAbbreviations[abbr] ?? abbr;
}

/** "MIN-Id", blue, linked to the activity in the staff app (carry-forward § 5g). */
export function minIdRuns(row: Pick<ReportRow, "id" | "ministryAbbreviation">, c: Pick<TextContext, "rules" | "origin">): Run[] {
  return [{ text: `${leadOf(row, c.rules)}-${row.id}`, color: COLOURS.link, ...(c.origin ? { link: `${c.origin}/hub/calendar/activities/${row.id}` } : {}) }];
}

/** Which Look Ahead table a row is in: legacy's `inTheNews` is true for Issues and Reports and for In the News. */
export type LookAheadTable = "events" | "issues" | "news";

/**
 * Legacy's FormatLookAheadRelease (ActivityHandler.ashx.cs:1176-1257): the origin's code above the
 * material's code, then the NR time when it differs from the start and falls on that day; "-" for none.
 */
export function rlsLines(row: ReportRow, rules: CalendarRules, o: { table: LookAheadTable; day: string | null }): string[] {
  const lines: string[] = [];
  const found = (rule: { contains: readonly string[] }, text: string) => rule.contains.some((c) => text.includes(c));
  const origins = row.nrOrigins.join(", ");
  const origin = origins ? rules.reports.rlsOrigins.find((r) => found(r, origins)) : undefined;
  if (origin) lines.push(origin.code);
  const materials = row.commMaterials.join(", ");
  const material = materials ? rules.reports.rlsMaterials.find((r) => !(r.notInEvents && o.table === "events") && found(r, materials)) : undefined;
  if (material) {
    lines.push(material.code);
    const nr = row.nrAt ? new Date(row.nrAt) : null;
    if (nr && material.releaseTime !== false && o.day !== null && row.nrAt !== row.startAt && wallClock(nr, rules.timeZone).date === o.day) {
      lines.push(clockTime(nr, rules.timeZone).toLowerCase());
    }
  }
  return lines.length ? lines : ["-"];
}

/** The Category column (ActivityHandler.ashx.cs:1046-1058): Issue; for HQ, FYI unless it is only the TV/Radio category; else the names. */
export function categoryText(row: Pick<ReportRow, "isIssue" | "categories">, rules: CalendarRules, isHq: boolean): string {
  if (row.isIssue) return "Issue";
  const tvRadioOnly = row.categories.length === 1 && sameCategoryName(row.categories[0]!, rules.reports.tvRadioCategoryName);
  if (isHq && !tvRadioOnly) return "FYI";
  return row.categories.join(", ");
}
```

- [ ] **Step 4: Run it to see it pass, and type-check**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/reports/text.test.ts`
Expected: PASS (11 tests).
Run: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/calendar/src/reports/model.ts apps/calendar/src/reports/dates.ts apps/calendar/src/reports/text.ts apps/calendar/src/reports/text.test.ts apps/calendar/test/report-rows.ts
git commit -m "feat(calendar): the report document, legacy's date stamps and row text, RLS codes and links"
```

---

### Task 4: The Look Ahead and the Exec Look Ahead

Covers: spec §10.2 (range, title, running text, sections in order, selection, order within a day, page breaks, row text, flag, RLS, legend), §10.3, §16 acceptance 10 (sections, legend colours, page-break rule); carry-forward § 5g (no Consultations and Dialogues; the reference day). Decisions G9, G10, G11, G13, G16. Review Focus 2 (the 366-day limit).

**Files:**
- Create: `apps/calendar/src/reports/look-ahead.ts`, `apps/calendar/src/reports/look-ahead.test.ts`.

**Interfaces:**
- Consumes: Tasks 1–3: `friendlyDateParts`, `ReportRow`, `ReportTooLargeError`, the `dates.ts` and `text.ts` helpers, `ReportDoc` and its blocks; `bcMidnight`, `addDays`, `wallClock` (`../time`).
- Produces:
  - `LOOK_AHEAD_MAX_DAYS = 366`.
  - `interface LookAheadContext extends TextContext { rows: ReportRow[]; q: ListQuery; consultationsKeys: readonly string[] }`.
  - `interface LookAheadRange { from; to; includeOutlook; outlookAfter: Date | null }`, and `lookAheadRange(q, today, timeZone, detailed)`.
  - `lookAheadDoc(c: LookAheadContext, o: { detailed: boolean }): ReportDoc`. Its title is "Look Ahead" or "Exec Look Ahead".

**How legacy's rules map** (`ActivityHandler.ashx.cs`):
- **Range (640-661):** From or today. With no To: 59 more days (the Exec: one more month), and the Long Term Outlook. This day only: one day.
- **Rows that leave the day tables (`BelongsToAwarenessConsultationReport`):**
  - the consultations ministry goes nowhere now (G10);
  - the Awareness category goes to Awareness Dates;
  - a start after From + 60 days goes to the Long Term Outlook (only when no To was given).
- **`GenerateLookAheadActivities` (899-1061):**
  - It skips confidential Not on LA rows.
  - Issues and Reports: for HQ, the stored section; for others, not Not for Look Ahead, unconfirmed, and 5 days or more.
  - A day's Events or In the News: rows that overlap the day and have that section and aren't Issues.
  - Order: in Events, time-TBD and multi-day rows go first, in list order; in In the News, time-TBD rows go on top, one-day rows next, multi-day rows last.
  - The flag shows on the start day only.
  - The Category column and the RLS cell come from Task 3.
  - Issue rows are purple in In the News, and in every table of the Exec.
- **Page breaks (707-731):** for HQ, after each day but a Saturday unless more than 16 rows have built up; for everyone, after the last day.
- **Sections (the RDLC):**
  1. Cover.
  2. "Inside Government", then per day "Events, Speeches & Releases", or "No Activities for …".
  3. "ISSUES AND REPORTS".
  4. A page break, "Outside Government", then each day that has In the News rows.
  5. A page break, then "AWARENESS DATES".
  6. "LONG TERM OUTLOOK", when included.

- [ ] **Step 1: Write the failing test**

Create `apps/calendar/src/reports/look-ahead.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { listQuerySchema, type ListQueryInput } from "@gcpe/calendar-contract";
import { TEST_RULES } from "../../test/helpers";
import { bc, outline, plain, reportRow } from "../../test/report-rows";
import { ReportTooLargeError, type ReportRow } from "./data";
import { LOOK_AHEAD_MAX_DAYS, lookAheadDoc, lookAheadRange, type LookAheadContext } from "./look-ahead";
import type { TableBlock } from "./model";
import { COLOURS } from "./text";

const tz = TEST_RULES.timeZone;
// 2026-11-03 11:00 BC. 2026-11-13 is a Friday.
const NOW = new Date("2026-11-03T18:00:00Z");
const q = (i: ListQueryInput) => listQuerySchema.parse(i);
const ctx = (rows: ReportRow[], over: Partial<LookAheadContext> = {}): LookAheadContext => ({
  rules: TEST_RULES, isHq: false, now: NOW, today: "2026-11-03", origin: "https://staff.example.test", consultationsKeys: ["consult"], rows,
  q: q({ filter: { from: "2026-11-10", to: "2026-11-12" } }), ...over,
});
const at = (day: string, time: string) => bc(day, time);
const row = (id: number, over: Partial<ReportRow>) => reportRow({ id, title: `Sample ${id}`, ...over });
const tables = (blocks: ReturnType<typeof lookAheadDoc>["blocks"]) => blocks.filter((b): b is TableBlock => b.kind === "table");

// Every case on 2026-11-10..12 (Tue to Thu), in legacy's order (start date, end date, start time).
const B = row(20002, { hqSection: "events_and_speeches", isAllDay: true, startAt: at("2026-11-10", "00:00"), endAt: at("2026-11-12", "23:59") });
const E = row(20005, { hqSection: "in_the_news", startAt: at("2026-11-10", "09:00"), endAt: at("2026-11-11", "17:00") });
const F = row(20006, { hqSection: "in_the_news", isConfirmed: false, startAt: at("2026-11-10", "10:00"), endAt: at("2026-11-16", "10:00") });
const C = row(20003, { hqSection: "events_and_speeches", isConfirmed: false, startAt: at("2026-11-10", "08:00"), endAt: at("2026-11-10", "18:00") });
const A = row(20001, { hqSection: "events_and_speeches", startAt: at("2026-11-10", "09:00"), endAt: at("2026-11-10", "10:00"), hqStatus: "new" });
const G = row(20007, { hqSection: "not_on_la", categoryIds: [2], isAllDay: true, startAt: at("2026-11-10", "00:00"), endAt: at("2026-11-10", "23:59") });
const H = row(20008, { hqSection: "not_on_la", ministryKey: "consult", ministryAbbreviation: "CONSULT", startAt: at("2026-11-10", "11:00"), endAt: at("2026-11-10", "12:00") });
const I = row(20009, { hqSection: "not_on_la", isConfidential: true, startAt: at("2026-11-10", "12:00"), endAt: at("2026-11-10", "13:00") });
const J = row(20010, { hqSection: "issues_and_reports", isIssue: true, startAt: at("2026-11-10", "13:00"), endAt: at("2026-11-10", "14:00") });
const D = row(20004, { hqSection: "in_the_news", startAt: at("2026-11-11", "09:00"), endAt: at("2026-11-11", "10:00") });
const ROWS = [B, E, F, C, A, G, H, I, J, D];

describe("the Look Ahead's range and title (ActivityHandler.ashx.cs:640-673)", () => {
  it("no To: 60 days from From or today, and the Long Term Outlook; the Exec, one month", () => {
    expect(lookAheadRange(q({}), "2026-11-03", tz, false)).toMatchObject({ from: "2026-11-03", to: "2027-01-01", includeOutlook: true });
    expect(lookAheadRange(q({}), "2026-11-03", tz, false).outlookAfter).toEqual(new Date(bc("2027-01-02", "00:00")));
    expect(lookAheadRange(q({ filter: { from: "2026-01-31" } }), "2026-11-03", tz, true)).toMatchObject({ from: "2026-01-31", to: "2026-02-28", includeOutlook: true });
  });
  it("a To: those days, no Outlook; This day only: one day", () => {
    expect(lookAheadRange(q({ filter: { from: "2026-11-10", to: "2026-11-12" } }), "2026-11-03", tz, false)).toEqual({ from: "2026-11-10", to: "2026-11-12", includeOutlook: false, outlookAfter: null });
    expect(lookAheadRange(q({ filter: { from: "2026-11-10", thisDayOnly: true } }), "2026-11-03", tz, false)).toMatchObject({ from: "2026-11-10", to: "2026-11-10", includeOutlook: false });
  });
  it("legacy's title: the start's year only when both ends share it", () => {
    const title = (i: ListQueryInput) => plain((lookAheadDoc(ctx([], { q: q(i) }), { detailed: false }).blocks[1] as { runs: { text: string }[] }).runs);
    expect(title({ filter: { from: "2026-11-10", to: "2026-11-12" } })).toBe("Tuesday, Nov. 10, 2026 to Thursday, Nov. 12, 2026");
    expect(title({ filter: { from: "2026-12-30", to: "2027-01-02" } })).toBe("Wednesday, Dec. 30 to Saturday, Jan. 2, 2027");
    expect(title({ filter: { from: "2026-11-10", thisDayOnly: true } })).toBe("Tuesday, Nov. 10, 2026");
  });
  it(`refuses more than ${LOOK_AHEAD_MAX_DAYS} days`, () => {
    expect(() => lookAheadDoc(ctx([], { q: q({ filter: { from: "2026-01-01", to: "2027-01-02" } }) }), { detailed: false })).toThrow(ReportTooLargeError);
  });
});

describe("the Look Ahead's sections, in legacy's order (spec addendum §10.2)", () => {
  it("for a ministry user: the cover without Consultations, each day's Events, Issues by legacy's ministry rule, each day's In the News, Awareness Dates", () => {
    expect(outline(lookAheadDoc(ctx(ROWS), { detailed: false }))).toEqual([
      "[banner] SAMPLE PROVINCE CORPORATE LOOK AHEAD",
      "# Tuesday, Nov. 10, 2026 to Thursday, Nov. 12, 2026",
      "# Contents:",
      "[legend] Events, Speeches and Releases (Inside Government) | Issues and Reports | In the News (Outside Government) | Awareness Dates",
      "---",
      "# Inside Government",
      // Time-TBD and multi-day rows first, in list order; then the day's timed rows.
      "# Tuesday, November 10, 2026", "# Events, Speeches & Releases", "HLTH-20002", "HLTH-20003", "HLTH-20001",
      "# Wednesday, November 11, 2026", "# Events, Speeches & Releases", "HLTH-20002",
      "# Thursday, November 12, 2026", "# Events, Speeches & Releases", "HLTH-20002",
      "---",
      // A ministry's Issues: not Not for Look Ahead, unconfirmed, five days or more (J's HQ section doesn't count).
      "# ISSUES AND REPORTS", "HLTH-20006",
      "---",
      "# Outside Government",
      "# In the News", "HLTH-20005",
      "# In the News", "HLTH-20004", "HLTH-20005",
      "---",
      "# AWARENESS DATES", "HLTH-20007",
    ]);
  });

  it("an empty day says so; the consultations ministry's and a confidential Not on LA activity appear nowhere", () => {
    const doc = lookAheadDoc(ctx([H, I], { q: q({ filter: { from: "2026-11-10", thisDayOnly: true } }) }), { detailed: false });
    expect(outline(doc).filter((l) => !l.startsWith("[") && l !== "# Contents:")).toEqual([
      "# Tuesday, Nov. 10, 2026", "---", "# Inside Government", "# No Activities for Tuesday, November 10, 2026", "---", "# ISSUES AND REPORTS", "---", "# Outside Government", "---", "# AWARENESS DATES",
    ]);
  });

  it("for HQ: Issues by the stored section, HQ's FYI category, and a break after every day but a Saturday", () => {
    const fri = (id: number, day: string) => row(id, { hqSection: "events_and_speeches", startAt: at(day, "09:00"), endAt: at(day, "10:00") });
    const rows = [J, fri(20011, "2026-11-13"), fri(20012, "2026-11-14"), fri(20013, "2026-11-15")];
    const doc = lookAheadDoc(ctx(rows, { isHq: true, q: q({ filter: { from: "2026-11-13", to: "2026-11-15" } }) }), { detailed: false });
    expect(outline(doc).slice(5)).toEqual([
      "# Inside Government",
      "# Friday, November 13, 2026", "# Events, Speeches & Releases", "HLTH-20011", "---",
      "# Saturday, November 14, 2026", "# Events, Speeches & Releases", "HLTH-20012",
      "# Sunday, November 15, 2026", "# Events, Speeches & Releases", "HLTH-20013", "---",
      // Issues and Reports isn't split by day: every row the list's filter brought (ActivityHandler.ashx.cs:920-923).
      "# ISSUES AND REPORTS", "HLTH-20010", "---", "# Outside Government", "---", "# AWARENESS DATES",
    ]);
    const hqIssues = lookAheadDoc(ctx(ROWS, { isHq: true }), { detailed: false });
    const issues = tables(hqIssues.blocks).find((t) => plain(t.header[0]!.runs) === "Date")!;
    expect(issues.rows.map((r) => plain(r[1]!.runs))).toEqual(["HLTH-20010"]);
    expect(plain(issues.rows[0]![3]!.runs)).toBe("Issue");
    const news = tables(hqIssues.blocks).filter((t) => plain(t.header[1]!.runs) === "CC ID#" && plain(t.header[0]!.runs) !== "Date");
    // F (unconfirmed, six days) is HQ's In the News on each of its days, an FYI.
    expect(news.map((t) => t.rows.map((r) => `${plain(r[1]!.runs)} ${plain(r[3]!.runs)}`))).toEqual([
      ["HLTH-20005 FYI", "HLTH-20006 FYI"], ["HLTH-20004 FYI", "HLTH-20005 FYI", "HLTH-20006 FYI"], ["HLTH-20006 FYI"],
    ]);
  });

  it("no To: the Long Term Outlook after 60 days, HQ seeing only those marked for it", () => {
    const later = row(20020, { hqSection: "events_and_speeches", startAt: at("2027-01-20", "09:00"), endAt: at("2027-01-20", "10:00") });
    const marked = row(20021, { hqSection: "events_and_speeches", longTermOutlook: true, startAt: at("2027-01-21", "09:00"), endAt: at("2027-01-21", "10:00") });
    const tail = (isHq: boolean) => outline(lookAheadDoc(ctx([later, marked], { isHq, q: q({}) }), { detailed: false })).slice(-3);
    expect(tail(false)).toEqual(["# LONG TERM OUTLOOK", "HLTH-20020", "HLTH-20021"]);
    expect(tail(true)).toEqual(["# AWARENESS DATES", "# LONG TERM OUTLOOK", "HLTH-20021"]);
    const legend = lookAheadDoc(ctx([], { q: q({}) }), { detailed: false }).blocks[3];
    expect(legend).toMatchObject({ kind: "legend", items: [{}, {}, {}, {}, { colour: COLOURS.outlook }] });
  });
});

describe("a Look Ahead row (ActivityHandler.ashx.cs:984-1061)", () => {
  const day = (doc: ReturnType<typeof lookAheadDoc>, n = 0) => tables(doc.blocks)[n]!;
  it("date without the day it sits under, the flag on its start day only, lead, text, RLS and the linked CC ID#", () => {
    const doc = lookAheadDoc(ctx([B, A]), { detailed: false });
    const [first, second] = day(doc).rows;
    expect(plain(day(doc).header[0]!.runs)).toBe("Tue Nov 10");
    expect(plain(first![0]!.runs)).toBe("Nov 10-12");
    expect(plain(second![0]!.runs)).toBe("9:00 AM\nNEW");
    expect(second!.map((cell) => plain(cell.runs))).toEqual(["9:00 AM\nNEW", "HLTH", "Sample City - Sample 20001: Sample details", "-", "HLTH-20001"]);
    expect(second![4]!.runs[0]!.link).toBe("https://staff.example.test/hub/calendar/activities/20001");
    expect([first![2]!.fill, second![2]!.fill]).toEqual([COLOURS.zebra, undefined]);
    expect(first![0]!.fill).toBe(COLOURS.events);
    // The flag doesn't repeat on a later day of a multi-day row.
    const multi = lookAheadDoc(ctx([{ ...B, hqStatus: "changed" }]), { detailed: false });
    expect(tables(multi.blocks).slice(0, 3).map((t) => plain(t.rows[0]![0]!.runs))).toEqual(["Nov 10-12\nCHANGED", "Nov 10-12", "Nov 10-12"]);
  });

  it("Time TBD and TBC are bold blue after the date", () => {
    const cell = day(lookAheadDoc(ctx([C]), { detailed: false })).rows[0]![0]!;
    expect(cell.runs).toEqual([{ text: "", color: COLOURS.white }, { text: "Time TBD", bold: true, color: COLOURS.pending }]);
  });

  it("the Executive Summary in place of the title and details, where the row carries it", () => {
    const doc = lookAheadDoc(ctx([{ ...A, executiveSummary: "**Sample summary** for HQ" }], { isHq: true }), { detailed: false });
    expect(plain(day(doc).rows[0]![2]!.runs)).toBe("Sample summary for HQ");
  });

  it("the Exec Look Ahead: the detailed text, and issues highlighted in every table", () => {
    const doc = lookAheadDoc(ctx([{ ...A, isIssue: true, lastUpdatedAt: "2026-11-03T16:15:00Z" }], { isHq: true }), { detailed: true });
    const r = day(doc).rows[0]!;
    expect(plain(r[2]!.runs)).toBe("Sample 20001\nSample details\nSample significance\nSample City  Last updated today at 9:15 AM");
    expect(r[2]!.fill).toBe(COLOURS.issues);
    expect(doc.title).toBe("Exec Look Ahead");
  });

  it("the running text: page 1 only the DRAFT ONLY line; later pages the province, DRAFT AND CONFIDENTIAL, Updated, the CHANGED note and Page X of Y", () => {
    const doc = lookAheadDoc(ctx([]), { detailed: false });
    expect(doc.firstPage).toEqual({ header: { right: [{ text: "DRAFT ONLY - NOT FOR CIRCULATION\nInformation is confidential and subject to change" }] }, footer: null });
    expect(plain(doc.header!.left!)).toBe("Sample Province");
    expect(plain(doc.header!.right!)).toBe("DRAFT AND CONFIDENTIAL");
    expect(plain(doc.footer!.left!)).toBe("Updated Tuesday, Nov 3, 2026 11:00 AM");
    expect(doc.footer).toMatchObject({ pageNumbers: true });
    expect(doc.page).toBe("letter-portrait");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/reports/look-ahead.test.ts`
Expected: FAIL, "Failed to resolve import "./look-ahead"".

- [ ] **Step 3: Implement**

Create `apps/calendar/src/reports/look-ahead.ts`:

```ts
import { friendlyDateParts, type FriendlyDateParts, type ListQuery } from "@gcpe/calendar-contract";
import { addDays, bcMidnight, wallClock } from "../time";
import { ReportTooLargeError, type ReportRow } from "./data";
import { addMonths, longDay, shortDay, titleDay, updatedLong, weekdayOf } from "./dates";
import type { Block, Cell, ReportDoc, Run } from "./model";
import {
  categoryText, COLOURS, detailedRuns, flagRuns, leadOf, lookAheadText, minIdRuns, rlsLines, type LookAheadTable, type TextContext,
} from "./text";

/** A Look Ahead covers at most this many days; a longer range is refused before anything is drawn. */
export const LOOK_AHEAD_MAX_DAYS = 366;

export interface LookAheadContext extends TextContext {
  rows: ReportRow[];
  q: ListQuery;
  /** Organizations carrying the tenant's consultations abbreviation (ListScope.consultationsKeys). */
  consultationsKeys: readonly string[];
}

export interface LookAheadRange {
  from: string;
  to: string;
  /** The Long Term Outlook section and its legend entry. */
  includeOutlook: boolean;
  /** Activities starting after this instant belong to the Long Term Outlook, whether or not it is shown. */
  outlookAfter: Date | null;
}

/** ActivityHandler.ashx.cs:640-661: the filter's From or today; no To runs 60 days (the Exec, one month) and adds the Outlook. */
export function lookAheadRange(q: ListQuery, today: string, timeZone: string, detailed: boolean): LookAheadRange {
  const f = q.filter;
  const from = f.from ?? today;
  const ownTo = f.to !== null && !f.thisDayOnly;
  const to = ownTo ? f.to! : f.thisDayOnly ? from : detailed ? addMonths(from, 1) : addDays(from, 59);
  return { from, to, includeOutlook: !ownTo && !f.thisDayOnly, outlookAfter: f.to === null ? bcMidnight(addDays(from, 60), timeZone) : null };
}

/** Legacy's BelongsToAwarenessConsultationReport: rows that leave the day tables. The consultations ministry's rows appear nowhere: their section is dropped. */
function elsewhere(row: ReportRow, c: LookAheadContext, outlookAfter: Date | null): "consultations" | "awareness" | "outlook" | null {
  if (row.ministryKey !== null && c.consultationsKeys.includes(row.ministryKey)) return "consultations";
  if (row.categoryIds.some((id) => c.rules.awarenessCategoryIds.includes(id))) return "awareness";
  if (outlookAfter && row.startAt && new Date(row.startAt) > outlookAfter) return "outlook";
  return null;
}

/** Legacy's IsTimeTBD: an unconfirmed 8 AM to 6 PM day. */
function isTimeTbd(row: ReportRow, timeZone: string): boolean {
  if (!row.startAt || !row.endAt || row.isConfirmed) return false;
  const s = wallClock(new Date(row.startAt), timeZone);
  const e = wallClock(new Date(row.endAt), timeZone);
  return s.date === e.date && s.time === "08:00" && e.time === "18:00";
}

interface LaRow {
  row: ReportRow;
  date: FriendlyDateParts;
  flag: boolean;
  text: Run[];
  category: string;
  rls: string[];
  issue: boolean;
}

/**
 * Legacy's GenerateLookAheadActivities (ActivityHandler.ashx.cs:899-1061): one day's Events or In
 * the News rows, or (no day) Issues and Reports, in legacy's order: time-TBD and multi-day rows
 * first in Events; in In the News, time-TBD rows on top, then one-day rows, multi-day rows last.
 */
function sectionRows(c: LookAheadContext, range: LookAheadRange, o: { table: LookAheadTable; day: string | null; detailed: boolean }): LaRow[] {
  const tz = c.rules.timeZone;
  const dayStart = o.day ? bcMidnight(o.day, tz) : null;
  const dayEnd = o.day ? bcMidnight(addDays(o.day, 1), tz) : null;
  const inTheNews = o.table !== "events";
  const out: LaRow[] = [];
  let firstBlock = 0;
  for (const row of c.rows) {
    const start = row.startAt ? new Date(row.startAt) : null;
    const end = row.endAt ? new Date(row.endAt) : null;
    if (dayEnd && (!start || start >= dayEnd)) continue;
    if (elsewhere(row, c, range.outlookAfter) !== null) continue;
    if (row.isConfidential && row.hqSection === "not_on_la") continue;
    const spanDays = start && end ? Math.floor((end.getTime() - start.getTime()) / 86_400_000) : 0;
    const forIssues = c.isHq ? row.hqSection === "issues_and_reports" : !row.isConfidential && !row.isConfirmed && spanDays >= 5;
    if (o.day === null) {
      if (!forIssues) continue;
    } else {
      if (!end || end < dayStart! || forIssues) continue;
      if (row.hqSection !== (inTheNews ? "in_the_news" : "events_and_speeches")) continue;
    }
    const tbd = isTimeTbd(row, tz);
    const startDay = start ? wallClock(start, tz).date : null;
    let at = out.length;
    if (o.day !== null) {
      if (tbd) {
        at = inTheNews ? 0 : firstBlock;
        firstBlock++;
      } else if (inTheNews === (startDay === (end ? wallClock(end, tz).date : null))) {
        at = firstBlock++;
      }
    }
    const detailed = o.detailed && ["events_and_speeches", "issues_and_reports", "in_the_news"].includes(row.hqSection);
    out.splice(at, 0, {
      row,
      date: friendlyDateParts(row, { timeZone: tz, today: c.today, weekday: false, endTime: false, ...(o.day ? { referenceDay: o.day } : {}) }),
      flag: o.day === null || startDay === o.day,
      text: detailed ? detailedRuns(row, c) : lookAheadText(row, c.rules, { titleOnly: false }),
      category: categoryText(row, c.rules, c.isHq),
      rls: rlsLines(row, c.rules, { table: o.table, day: o.day }),
      issue: (row.isIssue && inTheNews) || (o.detailed && row.isIssue),
    });
  }
  return out;
}

const header = (labels: string[], fill: string): Cell[] => labels.map((text) => ({ runs: [{ text, bold: true, color: COLOURS.white }], fill }));
const heading = (text: string, o: { size?: number; align?: "left" | "center"; underline?: boolean; colour?: string; spaceBefore?: number } = {}): Block => ({
  kind: "heading",
  runs: [{ text, bold: true, ...(o.underline ? { underline: true } : {}), ...(o.colour ? { color: o.colour } : {}) }],
  size: o.size ?? 12,
  ...(o.align ? { align: o.align } : {}),
  ...(o.spaceBefore ? { spaceBefore: o.spaceBefore } : {}),
});

function dateRuns(r: { date: FriendlyDateParts; flag: boolean; row: ReportRow }, colour?: string): Run[] {
  const runs: Run[] = [{ text: r.date.text, ...(colour ? { color: colour } : {}) }];
  if (r.date.pending) runs.push({ text: `${r.date.text ? " " : ""}${r.date.pending}`, bold: true, color: COLOURS.pending });
  return r.flag ? [...runs, ...flagRuns(r.row)] : runs;
}

function eventsTable(c: LookAheadContext, day: string, rows: LaRow[]): Block {
  return {
    kind: "table",
    widths: [62, 36, "*", 50, 58],
    header: header([shortDay(day), "Lead", "Activity/Details", "RLS", "CC ID#"], COLOURS.events),
    rows: rows.map((r, i) => {
      const fill = r.issue ? COLOURS.issues : i % 2 === 0 ? COLOURS.zebra : undefined;
      const f = fill ? { fill } : {};
      return [
        { runs: dateRuns(r, COLOURS.white), fill: COLOURS.events },
        { runs: [{ text: leadOf(r.row, c.rules) }], align: "center", ...f },
        { runs: r.text, ...f },
        { runs: [{ text: r.rls.join("\n") }], align: "center", ...f },
        { runs: minIdRuns(r.row, c), align: "center", ...f },
      ];
    }),
  };
}

function listTable(c: LookAheadContext, first: string, rows: LaRow[], dateFill: string, issues: boolean): Block {
  return {
    kind: "table",
    widths: [62, 58, "*", 52, 46],
    header: header([first, "CC ID#", "Activity/Details", "Category", "Rls"], COLOURS.listHeader),
    rows: rows.map((r) => {
      const purple = issues || r.issue ? { fill: COLOURS.issues } : {};
      return [
        { runs: dateRuns(r), fill: dateFill },
        { runs: minIdRuns(r.row, c), align: "center", ...(r.issue && !issues ? purple : {}) },
        { runs: r.text, ...purple },
        { runs: [{ text: r.category }], align: "center", ...purple },
        { runs: [{ text: r.rls.join("\n") }], align: "center", ...(r.issue && !issues ? purple : {}) },
      ];
    }),
  };
}

/** Awareness Dates and the Long Term Outlook (ActivityHandler.ashx.cs:808-838): list order, no day split. */
function laterTable(c: LookAheadContext, range: LookAheadRange, which: "awareness" | "outlook"): Block {
  const rows = c.rows.filter((r) => elsewhere(r, c, range.outlookAfter) === which && (which === "awareness" || !c.isHq || r.longTermOutlook));
  const outlook = which === "outlook";
  return {
    kind: "table",
    widths: [62, "*", 72],
    header: header(["Date", outlook ? "Activity/Details" : "Name", "CC ID#"], outlook ? COLOURS.outlookHeader : COLOURS.listHeader),
    rows: rows.map((row) => [
      { runs: dateRuns({ row, flag: true, date: friendlyDateParts(row, { timeZone: c.rules.timeZone, today: c.today, weekday: false }) }), fill: outlook ? COLOURS.outlook : COLOURS.awareness },
      { runs: lookAheadText(row, c.rules, { titleOnly: !outlook }) },
      { runs: minIdRuns(row, c), align: "center" },
    ]),
  };
}

/**
 * The Look Ahead (spec addendum §10.2; Reports/LookAheadReport.rdlc) and, with `detailed`, the Exec
 * Look Ahead (§10.3). Six sections: legacy's "Consultations and Dialogues" is dropped (carry-forward § 5g).
 */
export function lookAheadDoc(c: LookAheadContext, o: { detailed: boolean }): ReportDoc {
  const range = lookAheadRange(c.q, c.today, c.rules.timeZone, o.detailed);
  const days: string[] = [];
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) {
    if (days.length === LOOK_AHEAD_MAX_DAYS) throw new ReportTooLargeError("days in the range");
    days.push(d);
  }
  const sameYear = range.from.slice(0, 4) === range.to.slice(0, 4);
  // Legacy's own quirk, kept: the start shows its year only when both ends share it (ActivityHandler.ashx.cs:668-673).
  const title = c.q.filter.thisDayOnly ? titleDay(range.from, true) : `${titleDay(range.from, sameYear)} to ${titleDay(range.to, true)}`;
  const legend = [
    { colour: COLOURS.events, runs: [{ text: "Events, Speeches and Releases", bold: true }, { text: " (Inside Government)" }] },
    { colour: COLOURS.issues, runs: [{ text: "Issues and Reports", bold: true }] },
    { colour: COLOURS.news, runs: [{ text: "In the News", bold: true }, { text: " (Outside Government)" }] },
    { colour: COLOURS.awareness, runs: [{ text: "Awareness Dates", bold: true }] },
    ...(range.includeOutlook ? [{ colour: COLOURS.outlook, runs: [{ text: "Long Term Outlook", bold: true }] }] : []),
  ];
  const blocks: Block[] = [
    { kind: "banner", organization: c.rules.reports.cover.organization, lines: [...c.rules.reports.cover.lines] },
    heading(title, { size: 14, spaceBefore: 24 }),
    { kind: "heading", runs: [{ text: "Contents:", color: "#808080" }], size: 11, spaceBefore: 6 },
    { kind: "legend", items: legend },
    { kind: "pageBreak" },
    heading("Inside Government", { size: 14, underline: true }),
  ];
  // ActivityHandler.ashx.cs:707-731: HQ breaks after every day but Saturday, or once more than 16 rows build up; everyone, after the last day.
  let sinceBreak = 0;
  for (const day of days) {
    const rows = sectionRows(c, range, { table: "events", day, detailed: o.detailed });
    if (rows.length === 0) blocks.push(heading(`No Activities for ${longDay(day)}`, { size: 14, align: "center", colour: COLOURS.heading, spaceBefore: 12 }));
    else blocks.push(heading(longDay(day), { size: 14, align: "center", colour: COLOURS.heading, spaceBefore: 12 }), heading("Events, Speeches & Releases", { colour: COLOURS.heading }), eventsTable(c, day, rows));
    const onPage = rows.length ? rows.length + 2 : 0;
    sinceBreak += onPage;
    if ((c.isHq && (weekdayOf(day) !== 6 || sinceBreak + onPage > 16)) || day === range.to) {
      sinceBreak = 0;
      blocks.push({ kind: "pageBreak" });
    }
  }
  blocks.push(heading("ISSUES AND REPORTS", { colour: COLOURS.heading }), listTable(c, "Date", sectionRows(c, range, { table: "issues", day: null, detailed: o.detailed }), COLOURS.issuesDate, true));
  blocks.push({ kind: "pageBreak" }, heading("Outside Government", { size: 14, underline: true }));
  for (const day of days) {
    const rows = sectionRows(c, range, { table: "news", day, detailed: o.detailed });
    if (rows.length) blocks.push(heading("In the News", { colour: COLOURS.heading, spaceBefore: 8 }), listTable(c, shortDay(day), rows, COLOURS.news, false));
  }
  blocks.push({ kind: "pageBreak" }, heading("AWARENESS DATES", { colour: COLOURS.heading }), laterTable(c, range, "awareness"));
  if (range.includeOutlook) blocks.push(heading("LONG TERM OUTLOOK", { colour: COLOURS.heading, spaceBefore: 12 }), laterTable(c, range, "outlook"));
  return {
    page: "letter-portrait",
    title: o.detailed ? "Exec Look Ahead" : "Look Ahead",
    firstPage: { header: { right: [{ text: "DRAFT ONLY - NOT FOR CIRCULATION\nInformation is confidential and subject to change" }] }, footer: null },
    header: { left: [{ text: c.rules.reportBanner.province, bold: true, size: 11 }], right: [{ text: c.rules.reportBanner.confidentiality, color: COLOURS.draft }] },
    footer: {
      left: [{ text: updatedLong(c.now, c.rules.timeZone), size: 7 }],
      center: [{ text: '"CHANGED" applies to major detail or date changes only (not time switches)', size: 7 }],
      pageNumbers: true,
    },
    blocks,
  };
}
```

- [ ] **Step 4: Run it to see it pass, and type-check**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/reports/look-ahead.test.ts`
Expected: PASS (13 tests).
Run: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/calendar/src/reports/look-ahead.ts apps/calendar/src/reports/look-ahead.test.ts
git commit -m "feat(calendar): the Look Ahead and the Exec Look Ahead, six sections, legacy's selection, order and breaks"
```

---

### Task 5: The 30/60/90 and Planning reports; one entry point for all four

Covers: spec §10.4, §10.5. Decisions G12, G13, G14.

**Files:**
- Create: `apps/calendar/src/reports/thirty-sixty-ninety.ts`, `apps/calendar/src/reports/planning.ts`, `apps/calendar/src/reports/build.ts`, `apps/calendar/src/reports/list-reports.test.ts`.

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  - `interface ListReportContext extends TextContext { rows: ReportRow[]; q: ListQuery }`.
  - `thirtySixtyNinetyMonths(q, today): string[]`, `thirtySixtyNinetyDoc(c): ReportDoc` (title "30 / 60 / 90 Report").
  - `planningTags(keywords): string[]`, `planningDoc(c): ReportDoc` (title "Planning Report", Legal landscape).
  - `buildReport(kind: ReportKind, data: ReportData, origin: string | null): ReportDoc`.

**How legacy's rules map:**
- **30/60/90 (`ActivityHandler.ashx.cs:640-661`, `840-868`):**
  - From (or today) snaps to the 1st, and the report runs to From + 90 days, To, or that one month for This day only.
  - Each month takes the remaining rows until one starts at or after the next month's start. A row is never repeated, and rows after the last month are dropped.
  - DATE is the friendly date with its weekday. TOPIC is bold "City - Title", then ": " and the details at 9 pt, then "*Significance:* …". STRATEGY/COMM MATERIALS is the strategy, a blank line, then the materials. ID/CONT is `MIN-Id`, the contact, then "created/updated X ago", only with a contact.
  - Issue rows are purple. The footer is red "DRAFT AND CONFIDENTIAL" plus "Updated …", and the page numbers.
- **Planning (`GeneratePlannedActivities`, 545-610):**
  - Schedule is the date, the scheduling notes, "Premier Requested: <value without "Premier ">" and "Tags: <HQ tags first>".
  - Title & Summary is bold "City - Title", then a line, then a red bold "Not for Look Ahead" before the details.
  - Significance is "**Issue**" (an issue, or a category containing the tenant's issue text) or "FYI Only", then the significance.
  - CC ID# is `MIN-Id`, then "created/updated X ago".

- [ ] **Step 1: Write the failing test**

Create `apps/calendar/src/reports/list-reports.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { listQuerySchema, type ListQueryInput } from "@gcpe/calendar-contract";
import { TEST_RULES } from "../../test/helpers";
import { bc, outline, plain, reportRow } from "../../test/report-rows";
import type { ReportRow } from "./data";
import type { TableBlock } from "./model";
import { planningDoc, planningTags } from "./planning";
import { COLOURS } from "./text";
import { thirtySixtyNinetyDoc, thirtySixtyNinetyMonths, type ListReportContext } from "./thirty-sixty-ninety";

const NOW = new Date("2026-11-03T18:00:00Z");
const q = (i: ListQueryInput) => listQuerySchema.parse(i);
const ctx = (rows: ReportRow[], i: ListQueryInput = {}): ListReportContext => ({ rules: TEST_RULES, isHq: false, now: NOW, today: "2026-11-03", origin: "https://staff.example.test", rows, q: q(i) });
const on = (id: number, day: string, over: Partial<ReportRow> = {}) => reportRow({ id, title: `Sample ${id}`, startAt: bc(day, "09:00"), endAt: bc(day, "10:00"), ...over });

describe("the 30/60/90 report (spec addendum §10.4)", () => {
  it("months: From or today snapped to the 1st, through 90 days on (3 or 4 months), or through To", () => {
    expect(thirtySixtyNinetyMonths(q({}), "2026-11-03")).toEqual(["2026-11-01", "2026-12-01", "2027-01-01"]);
    expect(thirtySixtyNinetyMonths(q({ filter: { from: "2026-01-15" } }), "2026-11-03")).toEqual(["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01"]);
    expect(thirtySixtyNinetyMonths(q({ filter: { from: "2026-11-15", to: "2026-12-02" } }), "2026-11-03")).toEqual(["2026-11-01", "2026-12-01"]);
    expect(thirtySixtyNinetyMonths(q({ filter: { from: "2026-11-15", thisDayOnly: true } }), "2026-11-03")).toEqual(["2026-11-01"]);
  });

  it("each activity once, under the month it starts; one that started earlier under the first month; later ones left out", () => {
    const rows = [
      reportRow({ id: 20001, startAt: bc("2026-10-28", "09:00"), endAt: bc("2026-11-04", "10:00") }),
      on(20002, "2026-11-10"),
      reportRow({ id: 20003, startAt: bc("2026-11-30", "09:00"), endAt: bc("2026-12-02", "10:00") }),
      on(20004, "2026-12-01"),
      on(20005, "2027-02-01"),
    ];
    expect(outline(thirtySixtyNinetyDoc(ctx(rows, { filter: { from: "2026-11-03" } })))).toEqual([
      "# 30 / 60 / 90 REPORT",
      "# November 2026", "HLTH-20001", "HLTH-20002", "HLTH-20003",
      "# December 2026", "HLTH-20004",
      "# January 2027",
    ]);
  });

  it("a row: friendly date, bold title with 9 pt details and Significance, strategy and materials, CC ID# with the contact and when; Issue rows purple", () => {
    const doc = thirtySixtyNinetyDoc(ctx([on(20001, "2026-11-10", { isIssue: true, strategy: "Sample strategy", commMaterials: ["Sample news release"], status: "new", createdAt: "2026-11-02T18:00:00Z" })]));
    const row = (doc.blocks[2] as TableBlock).rows[0]!;
    expect(row.map((c) => plain(c.runs))).toEqual([
      "Tue Nov 10 9:00-10:00 AM",
      "Sample City - Sample 20001: Sample details\nSignificance: Sample significance",
      "Sample strategy\n\nSample news release",
      "HLTH-20001\nRobin Staff\n\ncreated yesterday",
    ]);
    expect(row.slice(1).map((c) => c.fill)).toEqual([COLOURS.issues, COLOURS.issues, COLOURS.issues]);
    expect(row[0]!.fill).toBe(COLOURS.thirtySixtyNinety);
    expect(plain(doc.footer!.left!)).toBe("DRAFT AND CONFIDENTIAL Updated Tuesday, Nov 3, 2026 11:00 AM");
    expect(doc.header).toBeNull();
  });
});

describe("the Planning report (spec addendum §10.5)", () => {
  it("Legal landscape, its title and Updated stamp, one row per activity in the list's order", () => {
    const doc = planningDoc(ctx([on(20002, "2026-11-10"), on(20001, "2026-11-11")]));
    expect(doc.page).toBe("legal-landscape");
    expect(plain(doc.header!.left!)).toBe("Sample Corporate Calendar: Schedule of Activities");
    expect(plain(doc.footer!.left!)).toBe("Updated 11/3/2026 11:00:00 AM");
    expect(outline(doc)).toEqual(["HLTH-20002", "HLTH-20001"]);
  });

  it("Schedule, Title & Summary, Significance and CC ID#, as legacy builds them", () => {
    const row = (over: Partial<ReportRow>) => (planningDoc(ctx([on(20001, "2026-11-10", over)])).blocks[0] as TableBlock).rows[0]!.map((c) => plain(c.runs));
    expect(row({ schedule: "Sample schedule", premierRequested: "Premier Confirmed", keywords: ["Sample", "HQ sample", "Another"], isConfidential: true, city: "Sampleton, SP" })).toEqual([
      "Tue Nov 10 9:00-10:00 AM\nSample schedule\nPremier Requested: Confirmed\nTags: HQ sample, Another, Sample",
      "Sampleton - Sample 20001\nNot for Look Ahead Sample details",
      "Sample significance",
      "HLTH-20001\nupdated 1 month ago",
    ]);
    expect(row({ isIssue: true })[2]).toBe("Issue\nSample significance");
    expect(row({ categories: ["Sample issue category"] })[2]).toBe("Issue\nSample significance");
    expect(row({ categories: ["Sample FYI only"] })[2]).toBe("FYI Only\nSample significance");
  });

  it("HQ tags first, each group sorted", () => {
    expect(planningTags(["b", "HQ z", "a", "HQ a"])).toEqual(["HQ a", "HQ z", "a", "b"]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/reports/list-reports.test.ts`
Expected: FAIL, "Failed to resolve import "./planning"".

- [ ] **Step 3: Implement**

Create `apps/calendar/src/reports/thirty-sixty-ninety.ts`:

```ts
import { friendlyDateRange, type ListQuery } from "@gcpe/calendar-contract";
import { addDays, bcMidnight } from "../time";
import type { ReportRow } from "./data";
import { addMonths, monthHeading, monthStart, updatedLong } from "./dates";
import type { Block, Cell, ReportDoc, Run } from "./model";
import { COLOURS, createdOrUpdated, linkify, minIdRuns, titleDetailsRuns, type TextContext } from "./text";

export interface ListReportContext extends TextContext {
  rows: ReportRow[];
  q: ListQuery;
}

/** ActivityHandler.ashx.cs:640-661: From (or today) snapped to the 1st; no To runs 90 days; This day only, that month. */
export function thirtySixtyNinetyMonths(q: ListQuery, today: string): string[] {
  const from = monthStart(q.filter.from ?? today);
  const to = q.filter.to !== null && !q.filter.thisDayOnly ? q.filter.to : q.filter.thisDayOnly ? from : addDays(from, 90);
  const months: string[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) months.push(m);
  return months;
}

const header = (labels: string[]): Cell[] => labels.map((text) => ({ runs: [{ text, bold: true, color: COLOURS.white }], fill: COLOURS.thirtySixtyNinety }));

function rowCells(row: ReportRow, c: ListReportContext): Cell[] {
  const tz = c.rules.timeZone;
  const purple = row.isIssue ? { fill: COLOURS.issues } : {};
  const materials = [row.strategy, row.commMaterials.join(", ")].filter(Boolean).join("\n\n");
  const contact: Run[] = row.commContact ? [{ text: `\n${row.commContact.name}` }, { text: `\n\n${createdOrUpdated(row, c.now, tz)}`, size: 8, color: "#808080" }] : [];
  return [
    { runs: [{ text: friendlyDateRange(row, { timeZone: tz, today: c.today, weekday: true }), color: COLOURS.white }], fill: COLOURS.thirtySixtyNinety },
    { runs: linkify(titleDetailsRuns(row, c.rules, { thirtySixtyNinety: true })), ...purple },
    { runs: materials ? [{ text: materials, size: 9 }] : [], ...purple },
    { runs: [...minIdRuns(row, c), ...contact], ...purple },
  ];
}

/**
 * The 30/60/90 report (spec addendum §10.4; Reports/Main30_60_90Report.rdlc): one table per month.
 * Each activity appears once, in the month it starts (or the first month, if it started earlier);
 * those starting after the last month are left out, as legacy (ActivityHandler.ashx.cs:840-868).
 */
export function thirtySixtyNinetyDoc(c: ListReportContext): ReportDoc {
  const tz = c.rules.timeZone;
  let rest = c.rows;
  const blocks: Block[] = [{ kind: "heading", runs: [{ text: "30 / 60 / 90 REPORT", bold: true }], size: 16, align: "center" }];
  for (const month of thirtySixtyNinetyMonths(c.q, c.today)) {
    const next = bcMidnight(addMonths(month, 1), tz);
    const n = rest.findIndex((r) => r.startAt !== null && new Date(r.startAt) >= next);
    const mine = n === -1 ? rest : rest.slice(0, n);
    rest = rest.slice(mine.length);
    blocks.push(
      { kind: "heading", runs: [{ text: monthHeading(month), bold: true, color: COLOURS.thirtySixtyNinety }], size: 13, align: "center", spaceBefore: 10 },
      { kind: "table", widths: [70, "*", 120, 82], header: header(["DATE", "TOPIC", "STRATEGY/COMM MATERIALS", "ID/CONT"]), rows: mine.map((r) => rowCells(r, c)) },
    );
  }
  return {
    page: "letter-portrait",
    title: "30 / 60 / 90 Report",
    header: null,
    footer: {
      left: [{ text: c.rules.reportBanner.confidentiality, bold: true, color: "#ff0000", size: 8 }, { text: ` ${updatedLong(c.now, tz)}`, bold: true, size: 8 }],
      pageNumbers: true,
    },
    blocks,
  };
}
```

Create `apps/calendar/src/reports/planning.ts`:

```ts
import { friendlyDateRange } from "@gcpe/calendar-contract";
import type { ReportRow } from "./data";
import { updatedNumeric } from "./dates";
import type { Cell, ReportDoc, Run } from "./model";
import { cityOf, cleanTitle, COLOURS, createdOrUpdated, linkify, minIdRuns } from "./text";
import type { ListReportContext } from "./thirty-sixty-ninety";

/** Legacy's Tags line: HQ Tags sorted, those starting "HQ" first (ActivityHandler.ashx.cs:560-566). */
export function planningTags(keywords: readonly string[]): string[] {
  const sorted = [...keywords].sort();
  return [...sorted.filter((k) => k.startsWith("HQ")), ...sorted.filter((k) => !k.startsWith("HQ"))];
}

function rowCells(row: ReportRow, c: ListReportContext): Cell[] {
  const tz = c.rules.timeZone;
  const r = c.rules.reports;
  const schedule: Run[] = [{ text: friendlyDateRange(row, { timeZone: tz, today: c.today, weekday: true }) }];
  if (row.schedule) schedule.push({ text: `\n${row.schedule}` });
  if (row.premierRequested) schedule.push({ text: "\nPremier Requested: ", bold: true, color: COLOURS.draft }, { text: row.premierRequested.replaceAll("Premier ", ""), color: COLOURS.draft });
  if (row.keywords.length) schedule.push({ text: "\nTags: ", bold: true, color: COLOURS.draft }, { text: planningTags(row.keywords).join(", "), color: COLOURS.draft });
  const city = cityOf(row, c.rules);
  const summary: Run[] = [
    { text: `${city ? `${city} - ` : ""}${cleanTitle(row.title)}`, bold: true },
    { text: "\n" },
    ...(row.isConfidential ? [{ text: "Not for Look Ahead ", bold: true, color: COLOURS.darkRed }] : []),
    { text: row.details },
  ];
  const issue = row.isIssue || row.categories.some((n) => n.includes(r.issueCategoryText));
  const fyi = !issue && row.categories.some((n) => n.includes(r.fyiOnlyCategoryText));
  const significance: Run[] = [...(issue ? [{ text: "Issue", bold: true }, { text: "\n" }] : fyi ? [{ text: "FYI Only" }, { text: "\n" }] : []), { text: row.significance }];
  return [
    { runs: schedule },
    { runs: linkify(summary) },
    { runs: significance },
    { runs: [...minIdRuns(row, c), { text: `\n${createdOrUpdated(row, c.now, tz)}`, size: 8, color: "#808080" }] },
  ];
}

/** The Planning report (spec addendum §10.5; Reports/PlanningReport.rdlc): Legal landscape, one row per activity in legacy's order. */
export function planningDoc(c: ListReportContext): ReportDoc {
  return {
    page: "legal-landscape",
    title: "Planning Report",
    header: { left: [{ text: c.rules.reports.planningTitle, bold: true, size: 14, color: COLOURS.planning }], right: [{ text: c.rules.reportBanner.confidentiality, bold: true, color: COLOURS.draft }] },
    footer: { left: [{ text: updatedNumeric(c.now, c.rules.timeZone), size: 8 }], pageNumbers: true },
    blocks: [
      {
        kind: "table",
        widths: [190, "*", 230, 92],
        header: ["Schedule", "Title & Summary", "Significance", "CC ID#"].map((text) => ({ runs: [{ text, bold: true, color: COLOURS.white }], fill: COLOURS.planning })),
        rows: c.rows.map((r) => rowCells(r, c)),
      },
    ],
  };
}
```

Create `apps/calendar/src/reports/build.ts`:

```ts
import type { ReportKind } from "@gcpe/calendar-contract";
import type { ReportData } from "./data";
import { lookAheadDoc } from "./look-ahead";
import type { ReportDoc } from "./model";
import { planningDoc } from "./planning";
import { thirtySixtyNinetyDoc } from "./thirty-sixty-ninety";

/** One report's document from what it read. `origin` is the staff app's "https://host", for each row's link. */
export function buildReport(kind: ReportKind, data: ReportData, origin: string | null): ReportDoc {
  const { scope, rows, q, now } = data;
  const c = { rules: scope.rules, isHq: scope.actor.isHq, now, today: scope.today, origin, rows, q };
  switch (kind) {
    case "look-ahead":
      return lookAheadDoc({ ...c, consultationsKeys: scope.consultationsKeys }, { detailed: false });
    case "exec-look-ahead":
      return lookAheadDoc({ ...c, consultationsKeys: scope.consultationsKeys }, { detailed: true });
    case "30-60-90":
      return thirtySixtyNinetyDoc(c);
    case "planning":
      return planningDoc(c);
  }
}
```

- [ ] **Step 4: Run every report test so far, and type-check**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/reports`
Expected: PASS (43 tests: data 13, text 11, Look Ahead 13, these 6).
Run: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/calendar/src/reports/thirty-sixty-ninety.ts apps/calendar/src/reports/planning.ts apps/calendar/src/reports/build.ts apps/calendar/src/reports/list-reports.test.ts
git commit -m "feat(calendar): the 30/60/90 and Planning reports, and one entry point for all four"
```

---
### Task 6: Drawing: BC Sans, the document as pdfmake, the worker and the rendering seam

Covers: spec §10 ("pdfmake on SiteGround, built in the background"), §10.1's requirements (Letter portrait and Legal landscape, a page-1 header that differs, "Page X of Y", coloured header cells and row fills, forced page breaks), Q57 (keep one rendering interface). Decisions G1, G2, G6, G7, G21. Review Focus 2 (a render past its heap).

**Files:**
- Create: `apps/calendar/src/reports/render/fonts.ts`, `layout.ts`, `pdf.ts`, `worker.ts`, `renderer.ts`, `assets.ts`, `layout.test.ts`, `renderer.test.ts`; `apps/calendar/test/pdf-text.ts`.
- Modify: `apps/calendar/package.json`, `package-lock.json`.

**Interfaces:**
- Consumes: Task 3's `ReportDoc` and its blocks.
- Produces:
  - `fonts.ts`: `woffToSfnt(woff: Buffer): Buffer`, `BC_SANS_FILES`, `loadBcSans(dir)`.
  - `layout.ts`: `FONT = "BCSans"`, `docDefinitionOf(doc: ReportDoc): TDocumentDefinitions` (pure).
  - `pdf.ts`: `useBcSans(fontsDir)`, `renderPdf(doc): Promise<Uint8Array<ArrayBuffer>>`. Only the worker imports this module at run time; tests import it directly.
  - `worker.ts`: the worker entry. It takes `workerData: { fontsDir }`, receives one `ReportDoc`, and posts back one `Uint8Array`, transferred.
  - `renderer.ts`:
    - `interface PdfRenderer { render(doc): Promise<Uint8Array>; close(): Promise<void> }`;
    - `type RenderFailure = "out_of_memory" | "timeout" | "failed"`;
    - `class ReportRenderError { reason; code: "ERR_REPORT_<REASON>" }`;
    - `interface WorkerRendererOptions extends ReportAssets { heapMb; timeoutMs }`, and `workerRenderer(o): PdfRenderer`.
  - `assets.ts`: `interface ReportAssets { workerFile; execArgv; fontsDir }`, `BUNDLED_WORKER = "report-worker.cjs"`, `reportAssets(here = import.meta.url, exists = existsSync)`.
  - `test/pdf-text.ts`: `interface PdfPage { size: [w, h]; lines: { y; text }[]; links: { y; url }[] }`, `pdfPages(bytes): Promise<PdfPage[]>`. Task 8 adds `outlineOf`.

- [ ] **Step 1: Add the dependencies (G21)**

```bash
npx -y -p node@24 -- npm install --workspace @gcpe/calendar --save-exact pdfmake@0.3.11 @bcgov/bc-sans@2.1.2
npx -y -p node@24 -- npm install --workspace @gcpe/calendar --save-exact --save-dev @types/pdfmake@0.3.3 unpdf@1.8.1
npx -y -p node@24 -- npm audit
```

Expected:
- `apps/calendar/package.json` gains `"@bcgov/bc-sans": "2.1.2"` and `"pdfmake": "0.3.11"` under `dependencies`, and `"@types/pdfmake": "0.3.3"` and `"unpdf": "1.8.1"` under `devDependencies`.
- `npm audit` lists the same 6 moderate advisories as before (drizzle-kit's tree), and none new.
- `node_modules/@napi-rs` is absent: unpdf's canvas peer is optional.

- [ ] **Step 2: Write the failing tests**

Create `apps/calendar/test/pdf-text.ts` (Task 8 appends to it):

```ts
import { getDocumentProxy } from "unpdf";

/** One page of a PDF as a reader meets it: its size, its lines top to bottom, and its links. */
export interface PdfPage {
  /** Points: [width, height]. */
  size: [number, number];
  lines: { y: number; text: string }[];
  links: { y: number; url: string }[];
}

/** The text of every page, cells on one baseline joined into one line, with unpdf (pdf.js, no native code). */
export async function pdfPages(bytes: Uint8Array): Promise<PdfPage[]> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  const pages: PdfPage[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const [x0, y0, x1, y1] = page.view as [number, number, number, number];
    const byLine = new Map<number, { x: number; s: string }[]>();
    for (const item of (await page.getTextContent()).items) {
      if (!("str" in item) || !item.str) continue;
      const y = Math.round(item.transform[5] as number);
      const key = [...byLine.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
      byLine.set(key, [...(byLine.get(key) ?? []), { x: item.transform[4] as number, s: item.str }]);
    }
    const lines = [...byLine]
      .sort(([a], [b]) => b - a)
      .map(([y, items]) => ({ y, text: items.sort((a, b) => a.x - b.x).map((i) => i.s).join(" ").replace(/\s+/g, " ").trim() }))
      .filter((l) => l.text);
    const links = ((await page.getAnnotations()) as { subtype?: string; url?: string; rect?: number[] }[])
      .filter((a) => a.subtype === "Link" && typeof a.url === "string")
      .map((a) => ({ y: Math.round(a.rect![3]!), url: a.url! }));
    pages.push({ size: [Math.round(x1 - x0), Math.round(y1 - y0)], lines, links });
  }
  return pages;
}
```

Create `apps/calendar/src/reports/render/layout.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { pdfPages } from "../../../test/pdf-text";
import type { ReportDoc, TableBlock } from "../model";
import { reportAssets } from "./assets";
import { woffToSfnt } from "./fonts";
import { docDefinitionOf } from "./layout";
import { renderPdf, useBcSans } from "./pdf";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fontsDir = reportAssets().fontsDir;
const table = (rows: number, fill?: string): TableBlock => ({
  kind: "table",
  widths: [60, "*", 60],
  header: ["Date", "Activity/Details", "CC ID#"].map((text) => ({ runs: [{ text, bold: true, color: "#ffffff" }], fill: "#558abd" })),
  rows: Array.from({ length: rows }, (_, i) => [{ runs: [{ text: `Day ${i}` }] }, { runs: [{ text: `Sample row ${i} with fictional details` }], ...(fill ? { fill } : {}) }, { runs: [{ text: `HLTH-${20001 + i}`, link: `https://staff.example.test/hub/calendar/activities/${20001 + i}` }] }]),
});
const doc = (over: Partial<ReportDoc> = {}): ReportDoc => ({
  page: "letter-portrait",
  title: "Sample report",
  firstPage: { header: { right: [{ text: "Sample first page header" }] }, footer: null },
  header: { left: [{ text: "Sample Province" }], right: [{ text: "DRAFT AND CONFIDENTIAL" }] },
  footer: { left: [{ text: "Updated sample" }], pageNumbers: true },
  blocks: [{ kind: "heading", runs: [{ text: "Sample first page" }], size: 14 }, { kind: "pageBreak" }, { kind: "heading", runs: [{ text: "Sample second page" }], size: 14 }, table(80, "#ccc0d9")],
  ...over,
});

describe("BC Sans, embedded (spec addendum §10.1)", () => {
  it("each WOFF face unpacks to a TrueType font with the same tables", () => {
    const woff = readFileSync(join(fontsDir, "BCSans-Regular.woff"));
    const sfnt = woffToSfnt(woff);
    expect(sfnt.readUInt32BE(0)).toBe(woff.readUInt32BE(4));
    expect(sfnt.readUInt16BE(4)).toBe(woff.readUInt16BE(12));
    expect(() => woffToSfnt(Buffer.from("not a font at all, just some sample text here....."))).toThrow("not a WOFF font");
  });
});

describe("a report document as pdfmake draws it", () => {
  it("maps page size, colours, links and breaks without rendering", () => {
    const def = docDefinitionOf(doc({ page: "legal-landscape" }));
    expect([def.pageSize, def.pageOrientation]).toEqual(["LEGAL", "landscape"]);
    expect(def.content).toHaveLength(3);
    expect(def.content).toMatchObject([{ fontSize: 14 }, { pageBreak: "before" }, { table: { headerRows: 1, dontBreakRows: true } }]);
    const body = (def.content as { table?: { body: { fillColor?: string; text: { link?: string }[] }[][] } }[])[2]!.table!.body;
    expect(body[0]![0]!.fillColor).toBe("#558abd");
    expect(body[1]![1]!.fillColor).toBe("#ccc0d9");
    expect(body[1]![2]!.text[0]!.link).toBe("https://staff.example.test/hub/calendar/activities/20001");
  });

  it("renders: Letter portrait, page 1's own header and no footer, later pages' running text, Page X of Y, BC Sans embedded, the table header repeated", async () => {
    useBcSans(fontsDir);
    const bytes = await renderPdf(doc());
    const pages = await pdfPages(bytes);
    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(pages.every((p) => p.size[0] === 612 && p.size[1] === 792)).toBe(true);
    const text = pages.map((p) => p.lines.map((l) => l.text).join("\n"));
    expect(text[0]).toContain("Sample first page header");
    expect(text[0]).not.toContain("Page 1 of");
    expect(text[0]).not.toContain("DRAFT AND CONFIDENTIAL");
    for (let i = 1; i < pages.length; i++) {
      expect(text[i]).toContain(`Page ${i + 1} of ${pages.length}`);
      expect(text[i]).toContain("DRAFT AND CONFIDENTIAL");
      expect(text[i]).toContain("Updated sample");
      expect(text[i]).toMatch(/Date Activity\/Details CC ID#/);
    }
    expect(text[1]).toContain("Sample second page");
    expect(pages[1]!.links[0]!.url).toBe("https://staff.example.test/hub/calendar/activities/20001");
    const raw = Buffer.from(bytes).toString("latin1");
    expect(raw).toMatch(/\+BCSans-Regular/);
    expect(raw).toMatch(/\+BCSans-Bold/);
    expect(raw).not.toMatch(/Helvetica/);
  });

  it("renders Legal landscape", async () => {
    useBcSans(fontsDir);
    const pages = await pdfPages(await renderPdf(doc({ page: "legal-landscape", firstPage: undefined, blocks: [table(3)] })));
    expect(pages[0]!.size).toEqual([1008, 612]);
    expect(pages[0]!.lines.map((l) => l.text).join("\n")).toContain("Page 1 of 1");
  });
});
```

Create `apps/calendar/src/reports/render/renderer.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { pdfPages } from "../../../test/pdf-text";
import type { ReportDoc } from "../model";
import { BUNDLED_WORKER, reportAssets } from "./assets";
import { ReportRenderError, workerRenderer, type PdfRenderer } from "./renderer";

const doc = (rows: number): ReportDoc => ({
  page: "letter-portrait",
  title: "Sample report",
  header: null,
  footer: { pageNumbers: true },
  blocks: [
    {
      kind: "table",
      widths: [60, "*", 60],
      header: ["Date", "Activity/Details", "CC ID#"].map((text) => ({ runs: [{ text }] })),
      rows: Array.from({ length: rows }, (_, i) => [{ runs: [{ text: "Tue Nov 10" }] }, { runs: [{ text: `Sample row ${i}: ${"fictional details ".repeat(8)}` }] }, { runs: [{ text: `HLTH-${20001 + i}` }] }]),
    },
  ],
});

describe("rendering in a worker thread (the stack's event loop stays free)", () => {
  let renderer: PdfRenderer | null = null;
  afterEach(async () => {
    await renderer?.close();
    renderer = null;
  });
  const make = (over: { heapMb?: number; timeoutMs?: number } = {}) => (renderer = workerRenderer({ ...reportAssets(), heapMb: 256, timeoutMs: 60_000, ...over }));

  it("finds the worker and BC Sans in a source checkout, and beside a bundle when they're there", () => {
    const src = reportAssets();
    expect(src.workerFile).toMatch(/reports\/render\/worker\.ts$/);
    expect(src.execArgv).toEqual(["--import", "tsx"]);
    expect(src.fontsDir).toMatch(/@bcgov\/bc-sans\/fonts$/);
    const bundle = reportAssets("file:///srv/app/stack.js", (p) => p === `/srv/app/${BUNDLED_WORKER}` || p === "/srv/app/fonts/");
    expect(bundle).toEqual({ workerFile: `/srv/app/${BUNDLED_WORKER}`, execArgv: [], fontsDir: "/srv/app/fonts/" });
  });

  it("renders a report while the main thread keeps running", async () => {
    let ticks = 0;
    const tick = setInterval(() => ticks++, 10);
    const started = Date.now();
    const bytes = await make().render(doc(600));
    clearInterval(tick);
    const pages = await pdfPages(bytes);
    expect(Buffer.from(bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    expect(pages.at(-1)!.lines.map((l) => l.text).join("\n")).toContain(`Page ${pages.length} of ${pages.length}`);
    // A 10 ms timer firing through the render: the work happened off this thread.
    expect(ticks).toBeGreaterThan((Date.now() - started) / 10 / 2);
  });

  it("a render past its heap ends the worker, not the process: out_of_memory", async () => {
    const err = await make({ heapMb: 24 }).render(doc(20_000)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReportRenderError);
    expect((err as ReportRenderError).reason).toBe("out_of_memory");
  });

  it("a render past its time ends: timeout", async () => {
    const err = await make({ timeoutMs: 1 }).render(doc(10)).catch((e: unknown) => e);
    expect((err as ReportRenderError).reason).toBe("timeout");
  });

  it("closing ends the renders still running", async () => {
    const r = make();
    const pending = r.render(doc(3000)).catch((e: unknown) => e);
    await r.close();
    expect((await pending as ReportRenderError).reason).toBe("failed");
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/reports/render`
Expected: FAIL, "Failed to resolve import "./assets"" in both files.

- [ ] **Step 4: Implement**

Create `apps/calendar/src/reports/render/fonts.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

/**
 * WOFF 1.0 → the TrueType font inside it, with Node's own zlib. pdfkit can read WOFF itself, but
 * inflates it in JavaScript for every document: about 400 ms locally and 3.4 s on boxs.ca for BC
 * Sans's four faces, against about 10 ms once here (measured 2026-10-10).
 */
export function woffToSfnt(woff: Buffer): Buffer {
  if (woff.length < 44 || woff.readUInt32BE(0) !== 0x774f4646) throw new Error("not a WOFF font");
  const flavor = woff.readUInt32BE(4);
  const numTables = woff.readUInt16BE(12);
  const tables: { tag: number; checksum: number; data: Buffer }[] = [];
  for (let i = 0; i < numTables; i++) {
    const e = 44 + i * 20;
    const offset = woff.readUInt32BE(e + 4);
    const compLength = woff.readUInt32BE(e + 8);
    const origLength = woff.readUInt32BE(e + 12);
    const raw = woff.subarray(offset, offset + compLength);
    const data = compLength < origLength ? inflateSync(raw) : Buffer.from(raw);
    if (data.length !== origLength) throw new Error("a WOFF table didn't inflate to its stated length");
    tables.push({ tag: woff.readUInt32BE(e), checksum: woff.readUInt32BE(e + 16), data });
  }
  let searchRange = 1;
  let entrySelector = 0;
  while (searchRange * 2 <= numTables) {
    searchRange *= 2;
    entrySelector++;
  }
  searchRange *= 16;
  const headerLength = 12 + numTables * 16;
  const out = Buffer.alloc(tables.reduce((n, t) => n + ((t.data.length + 3) & ~3), headerLength));
  out.writeUInt32BE(flavor, 0);
  out.writeUInt16BE(numTables, 4);
  out.writeUInt16BE(searchRange, 6);
  out.writeUInt16BE(entrySelector, 8);
  out.writeUInt16BE(numTables * 16 - searchRange, 10);
  let offset = headerLength;
  tables.forEach((t, i) => {
    const d = 12 + i * 16;
    out.writeUInt32BE(t.tag, d);
    out.writeUInt32BE(t.checksum, d + 4);
    out.writeUInt32BE(offset, d + 8);
    out.writeUInt32BE(t.data.length, d + 12);
    t.data.copy(out, offset);
    offset += (t.data.length + 3) & ~3;
  });
  return out;
}

/** BC Sans's four faces (@bcgov/bc-sans), by pdfmake's style names. */
export const BC_SANS_FILES = { normal: "BCSans-Regular.woff", bold: "BCSans-Bold.woff", italics: "BCSans-Italic.woff", bolditalics: "BCSans-BoldItalic.woff" } as const;

/** Each face as TrueType bytes, read from `dir`. */
export function loadBcSans(dir: string): Record<keyof typeof BC_SANS_FILES, Buffer> {
  return Object.fromEntries(Object.entries(BC_SANS_FILES).map(([style, file]) => [style, woffToSfnt(readFileSync(join(dir, file)))])) as Record<keyof typeof BC_SANS_FILES, Buffer>;
}
```

Create `apps/calendar/src/reports/render/layout.ts`:

```ts
import type { Content, ContextPageSize, CustomTableLayout, TableCell, TDocumentDefinitions } from "pdfmake/interfaces";
import type { Block, Cell, ReportDoc, Run, Running } from "../model";

export const FONT = "BCSans";
const MARGIN = 36;
const GRID: CustomTableLayout = {
  hLineWidth: () => 0.5,
  vLineWidth: () => 0.5,
  hLineColor: () => "#bfbfbf",
  vLineColor: () => "#bfbfbf",
  paddingLeft: () => 3,
  paddingRight: () => 3,
  paddingTop: () => 2,
  paddingBottom: () => 2,
};
const NONE: CustomTableLayout = { hLineWidth: () => 0, vLineWidth: () => 0 };

function textOf(runs: Run[]) {
  if (runs.length === 0) return "";
  return runs.map((r) => ({
    text: r.text,
    ...(r.bold ? { bold: true } : {}),
    ...(r.italic ? { italics: true } : {}),
    ...(r.underline ? { decoration: "underline" as const } : {}),
    ...(r.color ? { color: r.color } : {}),
    ...(r.size ? { fontSize: r.size } : {}),
    ...(r.link ? { link: r.link } : {}),
  }));
}

const cellOf = (c: Cell): TableCell => ({ text: textOf(c.runs), ...(c.fill ? { fillColor: c.fill } : {}), ...(c.align ? { alignment: c.align } : {}) });

function contentOf(b: Exclude<Block, { kind: "pageBreak" }>): Content {
  switch (b.kind) {
    case "heading":
      return { text: textOf(b.runs), fontSize: b.size, alignment: b.align ?? "left", margin: [0, b.spaceBefore ?? 4, 0, 4] };
    case "table":
      return { table: { headerRows: 1, dontBreakRows: true, widths: b.widths, body: [b.header.map(cellOf), ...b.rows.map((r) => r.map(cellOf))] }, layout: GRID, margin: [0, 0, 0, 6] };
    case "banner":
      return {
        table: {
          widths: ["*"],
          body: [[{
            stack: [{ text: b.organization, fontSize: 13, bold: true, color: "#d9d9d9", margin: [0, 0, 0, 8] }, ...b.lines.map((l) => ({ text: l, fontSize: 26, color: "#ffffff" }))],
            fillColor: "#595959",
            margin: [180, 60, 16, 60],
          }]],
        },
        layout: NONE,
      };
    case "legend":
      return {
        table: { widths: [18, "*"], body: b.items.map((i) => [{ text: "", fillColor: i.colour }, { text: textOf(i.runs), fontSize: 10 }]) },
        layout: { ...NONE, paddingTop: () => 3, paddingBottom: () => 3, paddingLeft: () => 6, paddingRight: () => 6 },
        margin: [0, 4, 0, 0],
      };
  }
}

function runningOf(r: Running | null, page: number, pages: number): Content {
  if (!r) return "";
  const right = r.pageNumbers ? `Page ${page} of ${pages}` : textOf(r.right ?? []);
  return {
    columns: [
      { text: textOf(r.left ?? []), width: "*" },
      { text: textOf(r.center ?? []), width: "auto", alignment: "center" },
      { text: right, width: "auto", alignment: "right" },
    ],
    columnGap: 8,
    fontSize: 8,
    margin: [MARGIN, 16, MARGIN, 0],
  };
}

/** A report document as pdfmake's document definition. Pure: tests read it without rendering. */
export function docDefinitionOf(doc: ReportDoc): TDocumentDefinitions {
  const content: Content[] = [];
  let breakNext = false;
  for (const b of doc.blocks) {
    if (b.kind === "pageBreak") {
      breakNext = content.length > 0;
      continue;
    }
    const node = contentOf(b) as Content & { pageBreak?: "before" };
    if (breakNext) node.pageBreak = "before";
    breakNext = false;
    content.push(node);
  }
  const first = doc.firstPage;
  return {
    info: { title: doc.title },
    pageSize: doc.page === "legal-landscape" ? "LEGAL" : "LETTER",
    pageOrientation: doc.page === "legal-landscape" ? "landscape" : "portrait",
    pageMargins: [MARGIN, 54, MARGIN, 44],
    defaultStyle: { font: FONT, fontSize: 9 },
    header: (page: number, pages: number, _size: ContextPageSize) => runningOf(page === 1 && first ? first.header : doc.header, page, pages),
    footer: (page: number, pages: number) => runningOf(page === 1 && first ? first.footer : doc.footer, page, pages),
    content,
  };
}
```

Create `apps/calendar/src/reports/render/pdf.ts`:

```ts
import pdfmake from "pdfmake";
import type { ReportDoc } from "../model";
import { BC_SANS_FILES, loadBcSans } from "./fonts";
import { docDefinitionOf, FONT } from "./layout";

/** pdfmake's in-memory file store; its server build has one, though its types don't say so. */
const store = (pdfmake as unknown as { virtualfs: { writeFileSync(name: string, data: Buffer): void } }).virtualfs;

/**
 * Embeds BC Sans, and stops pdfmake from fetching anything: a report names no URL or file, so a
 * document that tried would be refused rather than reach the network or the disk.
 */
export function useBcSans(fontsDir: string): void {
  const faces = loadBcSans(fontsDir);
  for (const [style, bytes] of Object.entries(faces)) store.writeFileSync(BC_SANS_FILES[style as keyof typeof BC_SANS_FILES], bytes);
  pdfmake.setFonts({ [FONT]: { ...BC_SANS_FILES } });
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy(() => false);
}

/** Lays out and writes one report. Synchronous work: run it in a worker, never on a request's thread. */
export async function renderPdf(doc: ReportDoc): Promise<Uint8Array<ArrayBuffer>> {
  const buf = await pdfmake.createPdf(docDefinitionOf(doc)).getBuffer();
  // A copy of its own, so it can be transferred out of the worker (a pooled Buffer can't be).
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out;
}
```

Create `apps/calendar/src/reports/render/worker.ts`:

```ts
import { parentPort, workerData } from "node:worker_threads";
import type { ReportDoc } from "../model";
import { renderPdf, useBcSans } from "./pdf";

// One report per worker: the worker's own heap limit bounds it, and its memory goes when it ends.
useBcSans((workerData as { fontsDir: string }).fontsDir);
parentPort!.once("message", (doc: ReportDoc) => {
  void renderPdf(doc).then((bytes) => parentPort!.postMessage(bytes, [bytes.buffer]));
});
```

Create `apps/calendar/src/reports/render/renderer.ts`:

```ts
import { Worker } from "node:worker_threads";
import type { ReportDoc } from "../model";
import type { ReportAssets } from "./assets";

/**
 * The rendering seam (spec addendum §10.1, Q57): pdfmake in a worker on SiteGround, where Chromium
 * can't run. A browser renderer on a container host would implement the same interface over the
 * same ReportDoc.
 */
export interface PdfRenderer {
  render(doc: ReportDoc): Promise<Uint8Array>;
  /** Ends every render still running. */
  close(): Promise<void>;
}

export type RenderFailure = "out_of_memory" | "timeout" | "failed";
export class ReportRenderError extends Error {
  override name = "ReportRenderError";
  /** What safeErrorLabel logs when there is no cause with a code of its own. */
  readonly code: string;
  constructor(
    readonly reason: RenderFailure,
    options?: ErrorOptions,
  ) {
    super(`the report render ended: ${reason}`, options);
    this.code = `ERR_REPORT_${reason.toUpperCase()}`;
  }
}

export interface WorkerRendererOptions extends ReportAssets {
  /** The worker's old-generation heap, in MB: a render past it ends, never the process. */
  heapMb: number;
  timeoutMs: number;
}

const codeOf = (e: unknown) => (e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "");

/** Each render in a fresh worker thread, so pdfmake's synchronous layout never blocks the stack's event loop. */
export function workerRenderer(o: WorkerRendererOptions): PdfRenderer {
  const live = new Set<Worker>();
  return {
    render(doc) {
      return new Promise<Uint8Array>((resolve, reject) => {
        const worker = new Worker(o.workerFile, {
          execArgv: o.execArgv,
          workerData: { fontsDir: o.fontsDir },
          resourceLimits: { maxOldGenerationSizeMb: o.heapMb, maxYoungGenerationSizeMb: 32 },
        });
        live.add(worker);
        let settled = false;
        const settle = (f: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          live.delete(worker);
          void worker.terminate();
          f();
        };
        const timer = setTimeout(() => settle(() => reject(new ReportRenderError("timeout"))), o.timeoutMs);
        worker.once("message", (bytes: Uint8Array) => settle(() => resolve(bytes)));
        worker.once("error", (e) => settle(() => reject(new ReportRenderError(codeOf(e) === "ERR_WORKER_OUT_OF_MEMORY" ? "out_of_memory" : "failed", { cause: e }))));
        worker.once("exit", () => settle(() => reject(new ReportRenderError("failed"))));
        worker.postMessage(doc);
      });
    },
    async close() {
      await Promise.all([...live].map((w) => w.terminate()));
    },
  };
}
```

Create `apps/calendar/src/reports/render/assets.ts`:

```ts
import { existsSync } from "node:fs";
// A namespace import: the SiteGround bundle's banner already declares a top-level `createRequire`.
import * as nodeModule from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the rendering worker and BC Sans are, in a source checkout or next to a bundle. */
export interface ReportAssets {
  workerFile: string;
  execArgv: string[];
  fontsDir: string;
}

/** The worker's bundle, written next to stack.js (scripts/build-siteground.mjs) and main.js (scripts/build-app.mjs). */
export const BUNDLED_WORKER = "report-worker.cjs";

/**
 * In a bundle, `here` (this module's URL) is the bundle's own file, with report-worker.cjs and
 * fonts/ beside it. In a source checkout the worker is worker.ts beside this file, run through tsx,
 * and the fonts come from @bcgov/bc-sans.
 */
export function reportAssets(here: string = import.meta.url, exists: (path: string) => boolean = existsSync): ReportAssets {
  const packaged = () => join(dirname(nodeModule.createRequire(here).resolve("@bcgov/bc-sans/package.json")), "fonts");
  const bundled = fileURLToPath(new URL(`./${BUNDLED_WORKER}`, here));
  if (exists(bundled)) {
    const fonts = fileURLToPath(new URL("./fonts/", here));
    return { workerFile: bundled, execArgv: [], fontsDir: exists(fonts) ? fonts : packaged() };
  }
  return { workerFile: fileURLToPath(new URL("./worker.ts", here)), execArgv: ["--import", "tsx"], fontsDir: packaged() };
}
```

- [ ] **Step 5: Run them to see them pass, and type-check**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/reports/render`
Expected: PASS (9 tests), in about a second. The out-of-memory test ends a worker at 24 MB, and the timer test proves the main thread kept running during a 600-row render.
Run: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/calendar/package.json package-lock.json apps/calendar/src/reports/render apps/calendar/test/pdf-text.ts
git commit -m "feat(calendar): draw reports with pdfmake in a worker thread, BC Sans embedded, behind one renderer interface"
```

---

### Task 7: Report jobs and the routes: start, poll, download; the Exec Look Ahead's gate

Covers: spec §6 ("Exec Look Ahead: HQ and L ≥ Administrator"; not visible is 404), §10 (input, output, per request), §16 acceptance 10 (Exec offered only to HQ Administrators). Decisions G3, G4, G5, G9, G15, G18. Review Focus 1, 2, 4.

**Files:**
- Create: `apps/calendar/src/reports/jobs.ts`, `apps/calendar/src/http/report-routes.ts`, `apps/calendar/src/http/report-routes.test.ts`.
- Modify: `apps/calendar/src/capabilities.ts`, `apps/calendar/src/http/config-routes.ts`, `apps/calendar/src/http/config-routes.test.ts`, `apps/calendar/src/http/routes.ts`, `apps/calendar/src/http/list-errors.ts`, `apps/calendar/src/app.ts`, `apps/calendar/src/start.ts`, `apps/calendar/src/start.test.ts`.

**Interfaces:**
- Consumes: Tasks 1–6: `reportStartSchema`, `reportJobIdSchema`, `isReportKind`, `REPORT_FILE_NAMES`, `ReportJobView`, `reportData`, `ReportTooLargeError`, `buildReport`, `rowCountOf`, `PdfRenderer`, `ReportRenderError`, `workerRenderer`, `reportAssets`; `runList`, `sendListError`, `ActivityNotFoundError`, `ActivityForbiddenError`, `safeErrorLabel`.
- Produces:
  - `can.execLookAhead(u)`, `can.runReport(u, report)`; `GET /config`'s `list.execLookAhead`.
  - `jobs.ts`:
    - the limits `REPORT_QUEUE_MAX = 4`, `REPORT_PER_USER_MAX = 2`, `REPORT_TTL_MS`, `REPORT_STORE_MAX_BYTES`, `REPORT_RETRY_AFTER_SECONDS = 10`;
    - the errors `ReportBusyError` (503), `ReportsUnavailableError` (503), `ReportJobNotFoundError` (404), `ReportJobNotReadyError` (409);
    - `class ReportJobs({ renderer, concurrency, now? })` with `start(owner, report, doc): ReportJobView`, `settle(owner, id, ms): Promise<ReportJobView>`, `view(owner, id)`, `pdf(owner, id): { report; bytes }` and `close()`.
  - `ApiDeps.reports?: { jobs: ReportJobs; inlineWaitMs: number } | null`; `AppDeps.reports`.
  - `REPORT_ROW_LIMIT = 5000`; `reportRoutes(deps)`, serving `POST /reports/:report`, `GET /reports/jobs/:id` and `GET /reports/jobs/:id/pdf`.
  - `calendarEnvSchema`'s `REPORT_CONCURRENCY` (1, 1–4), `REPORT_HEAP_MB` (320, 64–4096), `REPORT_TIMEOUT_SECONDS` (120, 5–900) and `REPORT_INLINE_WAIT_MS` (5000, 0–25000). In the stack they are `CALENDAR_REPORT_*`.

- [ ] **Step 1: Write the failing tests**

Create `apps/calendar/src/http/report-routes.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import type { ReportJobView } from "@gcpe/calendar-contract";
import { createCalendarTestDb, createTestApp, FIXED_NOW } from "../../test/helpers";
import { call, insertRaw, seedWorld, type Who, type World } from "../../test/world";
import { activityCategories } from "../db/schema";
import { REPORT_PER_USER_MAX, REPORT_QUEUE_MAX, REPORT_TTL_MS, ReportJobs } from "../reports/jobs";
import type { ReportDoc } from "../reports/model";
import { ReportRenderError, type PdfRenderer } from "../reports/render/renderer";

/** Supertest's body parser, for a binary body. */
type BodyParser = Parameters<ReturnType<ReturnType<typeof request>["get"]>["parse"]>[0];
const binary: BodyParser = (res, cb) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

/** A renderer that answers when told to, recording what it was given. */
function fakeRenderer() {
  const docs: ReportDoc[] = [];
  let hold = false;
  const waiting: (() => void)[] = [];
  let fail: Error | null = null;
  const renderer: PdfRenderer = {
    async render(doc) {
      docs.push(doc);
      if (hold) await new Promise<void>((resolve) => waiting.push(resolve));
      if (fail) throw fail;
      return new TextEncoder().encode(`%PDF-sample ${doc.title}`);
    },
    close: async () => {},
  };
  return {
    renderer, docs,
    hold: () => void (hold = true),
    release: () => { hold = false; waiting.splice(0).forEach((f) => f()); },
    failWith: (e: Error | null) => void (fail = e),
  };
}

const MARCH = { filter: { from: "2046-03-01", to: "2046-03-31" } };

describe("the report routes (spec addendum §10)", () => {
  let tdb: TestDatabase;
  let w: World;
  let app: ReturnType<typeof createTestApp>;
  let fake: ReturnType<typeof fakeRenderer>;
  let jobs: ReportJobs;
  let clock = FIXED_NOW.getTime();
  const start = (who: Who, report: string, q: object = MARCH) => call(app, "post", `/api/reports/${report}`, w.as[who].cookie, { q });
  const poll = (who: Who, id: string) => call(app, "get", `/api/reports/jobs/${id}`, w.as[who].cookie);
  const pdf = (who: Who, id: string) => request(app).get(`/api/reports/jobs/${id}/pdf`).set("cookie", w.as[who].cookie).buffer(true).parse(binary);

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    fake = fakeRenderer();
    jobs = new ReportJobs({ renderer: fake.renderer, concurrency: 1, now: () => clock });
    app = createTestApp(tdb.db, { reports: { jobs, inlineWaitMs: 200 } });
    w = await seedWorld(app, tdb.db);
    const id = await insertRaw(tdb.db, { title: "Sample routed", startAt: new Date("2046-03-10T16:00:00Z"), endAt: new Date("2046-03-10T17:00:00Z") });
    await tdb.db.insert(activityCategories).values({ activityId: id, categoryId: w.cat.plain });
  });
  afterEach(() => {
    fake.release();
    fake.failWith(null);
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await jobs.close();
    await tdb.drop();
  });

  it("a quick report is ready when the start answers: 201, then the PDF downloads as an attachment", async () => {
    const res = await start("readOnly", "look-ahead");
    expect(res.status).toBe(201);
    const view = res.body as ReportJobView;
    expect(view).toMatchObject({ report: "look-ahead", status: "ready", error: null });
    expect(view.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect((await poll("readOnly", view.id)).body).toEqual(view);
    const file = await pdf("readOnly", view.id);
    expect(file.status).toBe(200);
    expect(file.headers["content-type"]).toBe("application/pdf");
    expect(file.headers["content-disposition"]).toBe('attachment; filename="LookAhead.pdf"');
    expect(file.headers["x-content-type-options"]).toBe("nosniff");
    expect(file.headers["cache-control"]).toBe("no-store");
    expect((file.body as Buffer).toString("latin1")).toBe("%PDF-sample Look Ahead");
  });

  it("each report builds its own document from the list's query", async () => {
    for (const [report, title] of [["30-60-90", "30 / 60 / 90 Report"], ["planning", "Planning Report"], ["exec-look-ahead", "Exec Look Ahead"]] as const) {
      const res = await start("hqAdmin", report);
      expect(res.status, report).toBe(201);
      expect(fake.docs.at(-1)!.title).toBe(title);
    }
  });

  it("a slow report answers 202 and is polled until ready; its PDF before then is 409", async () => {
    fake.hold();
    const res = await start("editor", "planning");
    expect(res.status).toBe(202);
    const { id } = res.body as ReportJobView;
    expect((await poll("editor", id)).body).toMatchObject({ status: "running" });
    expect((await pdf("editor", id)).status).toBe(409);
    fake.release();
    await jobs.settle(w.as.editor.id, id, 1000);
    expect((await poll("editor", id)).body).toMatchObject({ status: "ready" });
    expect((await pdf("editor", id)).status).toBe(200);
  });

  it("another user's report, a made-up id, and a malformed one are all the same 404", async () => {
    const { id } = (await start("editor", "look-ahead")).body as ReportJobView;
    for (const [who, path] of [["financeEditor", id], ["hqAdmin", id], ["editor", "AAAAAAAAAAAAAAAAAAAAAA"], ["editor", "..%2F..%2Fsecret"]] as const) {
      const a = await poll(who, path);
      expect([a.status, a.body], `${who} ${path}`).toEqual([404, { error: "not found" }]);
      expect((await pdf(who, path)).status).toBe(404);
    }
  });

  it("the Exec Look Ahead is for HQ Administrators and above only (spec addendum §6)", async () => {
    for (const who of ["readOnly", "admin", "hqEditor", "hqAdvanced"] as const) expect((await start(who, "exec-look-ahead")).status, who).toBe(403);
    expect((await start("hqAdmin", "exec-look-ahead")).status).toBe(201);
    const cfg = async (who: Who) => (await call(app, "get", "/api/config", w.as[who].cookie)).body.list.execLookAhead as boolean;
    expect([await cfg("admin"), await cfg("hqAdvanced"), await cfg("hqAdmin")]).toEqual([false, false, true]);
  });

  it("an unknown report is 404, and a bad query 400, never a 500", async () => {
    expect((await start("editor", "word")).status).toBe(404);
    expect((await call(app, "post", "/api/reports/look-ahead", w.as.editor.cookie, {})).status).toBe(400);
    expect((await start("editor", "look-ahead", { filter: { from: "2046-02-30" } })).status).toBe(400);
    expect((await start("editor", "look-ahead", { lookAhead: "look_ahead_only" })).status).toBe(403);
  });

  it(`at most ${REPORT_PER_USER_MAX} unfinished reports per user and ${REPORT_QUEUE_MAX} waiting in all; past either, 503 with Retry-After`, async () => {
    fake.hold();
    expect((await start("editor", "look-ahead")).status).toBe(202);
    expect((await start("editor", "look-ahead")).status).toBe(202);
    const mine = await start("editor", "look-ahead");
    expect(mine.status).toBe(503);
    expect(mine.headers["retry-after"]).toBe("10");
    // The editor's first is rendering, the second waits; four more can wait.
    for (const who of ["readOnly", "readOnly", "admin"] as const) expect((await start(who, "planning")).status).toBe(202);
    expect((await start("advanced", "planning")).status).toBe(503);
    fake.release();
  });

  it("a render that fails says why, and logs only a label and the route", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.failWith(new ReportRenderError("out_of_memory"));
    const res = await start("editor", "look-ahead");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "failed", error: "The report is too large to prepare: narrow the filter and run it again." });
    expect((await pdf("editor", (res.body as ReportJobView).id)).status).toBe(409);
    expect(log).toHaveBeenCalledWith("[calendar] a report failed", "ERR_REPORT_OUT_OF_MEMORY", "POST /calendar/api/reports/look-ahead");
    expect(JSON.stringify(log.mock.calls)).not.toContain("Sample routed");
  });

  it("a finished report is forgotten after its time", async () => {
    const { id } = (await start("editor", "look-ahead")).body as ReportJobView;
    clock += REPORT_TTL_MS + 1;
    expect((await poll("editor", id)).status).toBe(404);
  });

  it("too many rows to print is 422 before anything renders", async () => {
    // 90 activities each In the News on all 60 days: 5,400 rows.
    for (let i = 0; i < 90; i++) {
      const id = await insertRaw(tdb.db, { title: `Sample long ${i}`, startAt: new Date("2047-05-01T16:00:00Z"), endAt: new Date("2047-06-29T17:00:00Z") });
      await tdb.db.insert(activityCategories).values({ activityId: id, categoryId: w.cat.plain });
    }
    const before = fake.docs.length;
    const res = await start("editor", "look-ahead", { filter: { from: "2047-05-01" } });
    expect([res.status, res.body]).toEqual([422, { error: "Too many rows to print: narrow the filter and run the report again" }]);
    expect(fake.docs.length).toBe(before);
  });

  it("with no renderer, the report routes say so: 503", async () => {
    const bare = createTestApp(tdb.db);
    expect((await call(bare, "post", "/api/reports/look-ahead", w.as.editor.cookie, { q: MARCH })).status).toBe(503);
  });
});
```

`apps/calendar/src/start.test.ts`, before the test "refuses to start when the tenant file has no calendar section (spec addendum §5.1)":

```ts
  it("reads the report settings, with defaults sized for SiteGround: one render at a time, 320 MB, 2 minutes, a 5 s wait", () => {
    const base = { DATABASE_URL: "postgres://user:pass@127.0.0.1:1/calendar" };
    expect(calendarEnvSchema.parse(base)).toMatchObject({ REPORT_CONCURRENCY: 1, REPORT_HEAP_MB: 320, REPORT_TIMEOUT_SECONDS: 120, REPORT_INLINE_WAIT_MS: 5000 });
    expect(calendarEnvSchema.parse({ ...base, REPORT_CONCURRENCY: "2", REPORT_INLINE_WAIT_MS: "0" })).toMatchObject({ REPORT_CONCURRENCY: 2, REPORT_INLINE_WAIT_MS: 0 });
    for (const bad of [{ REPORT_CONCURRENCY: "0" }, { REPORT_HEAP_MB: "10" }, { REPORT_INLINE_WAIT_MS: "60000" }]) expect(calendarEnvSchema.safeParse({ ...base, ...bad }).success, JSON.stringify(bad)).toBe(false);
  });
```

`apps/calendar/src/http/config-routes.test.ts`: in the two `list` expectations (lines 38–39), add `execLookAhead: false` at the end of each object.

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/http/report-routes.test.ts apps/calendar/src/start.test.ts apps/calendar/src/http/config-routes.test.ts`
Expected: FAIL. `report-routes.test.ts`: "Failed to resolve import "../reports/jobs"". `start.test.ts`: `REPORT_CONCURRENCY` missing from the parsed env. `config-routes.test.ts`: `execLookAhead` missing from `list`.

- [ ] **Step 3: Implement**

`apps/calendar/src/capabilities.ts`:
- Import `type ReportKind` beside `LEVEL, type CalendarRules`.
- After `transfer: …,` add:

```ts
  /** Spec addendum §6: the Exec Look Ahead is for HQ Administrators and above. */
  execLookAhead: (u: Viewer) => u.isHq && u.level >= LEVEL.administrator,
  /** Every report is for any Calendar role, its rows limited by visible(); the Exec Look Ahead as above. */
  runReport: (u: Viewer, report: ReportKind) => u.level >= LEVEL.readOnly && (report !== "exec-look-ahead" || can.execLookAhead(u)),
```

`apps/calendar/src/http/config-routes.ts`, in `list`, after `clearLaStatus: can.clearLaStatus(actor),`:

```ts
          execLookAhead: can.execLookAhead(actor),
```

Create `apps/calendar/src/reports/jobs.ts`:

```ts
import { randomBytes } from "node:crypto";
import { safeErrorLabel } from "@gcpe/http-kit";
import type { ReportJobView, ReportKind } from "@gcpe/calendar-contract";
import type { ReportDoc } from "./model";
import { ReportRenderError, type PdfRenderer } from "./render/renderer";

/** Reports waiting for a render slot, across every user; more is 503 with Retry-After. */
export const REPORT_QUEUE_MAX = 4;
/** Unfinished reports one user may have at once. */
export const REPORT_PER_USER_MAX = 2;
/** A finished report is kept this long for its download, then forgotten. It is never written to disk. */
export const REPORT_TTL_MS = 10 * 60_000;
/** Finished PDFs held at once, in bytes; past it the oldest go first. */
export const REPORT_STORE_MAX_BYTES = 64 * 1024 * 1024;
/** Seconds a refused start is told to wait. */
export const REPORT_RETRY_AFTER_SECONDS = 10;

/** HTTP 503 with Retry-After. */
export class ReportBusyError extends Error {
  override name = "ReportBusyError";
  constructor() {
    super("Other reports are being prepared: try again in a few seconds");
  }
}
/** HTTP 503: this server has no report renderer (its worker or BC Sans wasn't found at startup). */
export class ReportsUnavailableError extends Error {
  override name = "ReportsUnavailableError";
  constructor() {
    super("Reports aren't available on this server right now");
  }
}
/** Not this user's, unknown, or expired: 404, the same answer for each. */
export class ReportJobNotFoundError extends Error {
  override name = "ReportJobNotFoundError";
}
/** HTTP 409: asked for the PDF before it was ready, or after it failed. */
export class ReportJobNotReadyError extends Error {
  override name = "ReportJobNotReadyError";
  constructor() {
    super("The report isn't ready");
  }
}

const FAILURE_TEXT: Record<ReportRenderError["reason"], string> = {
  out_of_memory: "The report is too large to prepare: narrow the filter and run it again.",
  timeout: "The report took too long to prepare: narrow the filter and run it again.",
  failed: "The report couldn't be prepared. Try again.",
};

interface Job {
  id: string;
  owner: string;
  report: ReportKind;
  status: ReportJobView["status"];
  doc: ReportDoc | null;
  bytes: Uint8Array | null;
  error: string | null;
  finishedAt: number | null;
  done: Promise<void>;
  finish: () => void;
}

export interface ReportJobsOptions {
  renderer: PdfRenderer;
  /** Renders at once; each is a worker with its own heap. */
  concurrency: number;
  now?: () => number;
}

/**
 * Report jobs, in this process's memory only: a queue in front of the renderer, at most
 * `concurrency` renders at once, and finished PDFs kept for REPORT_TTL_MS. Every read names its
 * owner; another user's job is "not found". A restart forgets every job, which the user re-runs.
 */
export class ReportJobs {
  private readonly jobs = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private running = 0;
  private readonly sweeper: NodeJS.Timeout;
  private readonly now: () => number;

  constructor(private readonly o: ReportJobsOptions) {
    this.now = o.now ?? Date.now;
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  /** Queues a report for `owner`. Refuses (ReportBusyError) past the queue or the owner's own limit. */
  start(owner: string, report: ReportKind, doc: ReportDoc): ReportJobView {
    this.sweep();
    const mine = [...this.jobs.values()].filter((j) => j.owner === owner && j.status === "running").length;
    if (this.queue.length >= REPORT_QUEUE_MAX || mine >= REPORT_PER_USER_MAX) throw new ReportBusyError();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    const job: Job = { id: randomBytes(16).toString("base64url"), owner, report, status: "running", doc, bytes: null, error: null, finishedAt: null, done, finish };
    this.jobs.set(job.id, job);
    this.queue.push(job);
    this.pump();
    return this.viewOf(job);
  }

  /** Resolves when the job finishes or `ms` pass, whichever is first. */
  async settle(owner: string, id: string, ms: number): Promise<ReportJobView> {
    const job = this.own(owner, id);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([job.done, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
    clearTimeout(timer);
    return this.viewOf(job);
  }

  view(owner: string, id: string): ReportJobView {
    return this.viewOf(this.own(owner, id));
  }

  pdf(owner: string, id: string): { report: ReportKind; bytes: Uint8Array } {
    const job = this.own(owner, id);
    if (job.status !== "ready" || !job.bytes) throw new ReportJobNotReadyError();
    return { report: job.report, bytes: job.bytes };
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    this.queue.length = 0;
    await this.o.renderer.close();
  }

  private own(owner: string, id: string): Job {
    this.sweep();
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner) throw new ReportJobNotFoundError();
    return job;
  }

  private viewOf(j: Job): ReportJobView {
    return { id: j.id, report: j.report, status: j.status, error: j.error };
  }

  private pump(): void {
    while (this.running < this.o.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      const doc = job.doc!;
      job.doc = null;
      this.running++;
      this.o.renderer
        .render(doc)
        .then(
          (bytes) => {
            job.bytes = bytes;
            job.status = "ready";
          },
          (e: unknown) => {
            job.status = "failed";
            job.error = FAILURE_TEXT[e instanceof ReportRenderError ? e.reason : "failed"];
            console.error("[calendar] a report failed", safeErrorLabel(e), `POST /calendar/api/reports/${job.report}`);
          },
        )
        .finally(() => {
          job.finishedAt = this.now();
          this.running--;
          job.finish();
          this.sweep();
          this.pump();
        });
    }
  }

  /** Forgets finished jobs past their time, then the oldest finished PDFs past the store's size. */
  private sweep(): void {
    const now = this.now();
    for (const [id, j] of this.jobs) if (j.finishedAt !== null && now - j.finishedAt > REPORT_TTL_MS) this.jobs.delete(id);
    const ready = [...this.jobs.values()].filter((j) => j.bytes).sort((a, b) => a.finishedAt! - b.finishedAt!);
    let held = ready.reduce((n, j) => n + j.bytes!.byteLength, 0);
    for (const j of ready) {
      if (held <= REPORT_STORE_MAX_BYTES) break;
      held -= j.bytes!.byteLength;
      this.jobs.delete(j.id);
    }
  }
}
```

Create `apps/calendar/src/http/report-routes.ts`:

```ts
import { Router, type Request } from "express";
import { REPORT_FILE_NAMES, isReportKind, reportJobIdSchema, reportStartSchema } from "@gcpe/calendar-contract";
import { ActivityForbiddenError, ActivityNotFoundError } from "../activities/errors";
import { can } from "../capabilities";
import { buildReport } from "../reports/build";
import { reportData, ReportTooLargeError } from "../reports/data";
import { ReportJobNotFoundError, ReportsUnavailableError } from "../reports/jobs";
import { rowCountOf } from "../reports/model";
import { runList } from "./list-errors";
import type { ApiDeps } from "./routes";

/** The most table rows one report draws: 4,800 took 7 s and a 193 MB heap on boxs.ca (2026-10-10). */
export const REPORT_ROW_LIMIT = 5000;

/** The staff app's origin for each row's link: this request's own scheme and host, when they look like one. */
function originOf(req: Request): string | null {
  const host = req.get("host") ?? "";
  return (req.protocol === "https" || req.protocol === "http") && /^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(host) ? `${req.protocol}://${host}` : null;
}

const jobIdOf = (req: Request): string => {
  const id = reportJobIdSchema.safeParse(req.params.id);
  if (!id.success) throw new ReportJobNotFoundError();
  return id.data;
};

/**
 * The reports (spec addendum §10): POST starts one from the list's query and answers 201 once its
 * PDF is ready, or 202 if it is still being prepared after a short wait; GET polls it; GET .../pdf
 * downloads it. Only the user who started a report can see it.
 */
export function reportRoutes(deps: ApiDeps): Router {
  const r = Router();
  const service = () => {
    if (!deps.reports) throw new ReportsUnavailableError();
    return deps.reports;
  };
  r.post("/reports/:report", runList(async (req, res) => {
    const report = String(req.params.report);
    if (!isReportKind(report)) throw new ActivityNotFoundError();
    const actor = req.calendar!;
    if (!can.runReport(actor, report)) throw new ActivityForbiddenError("The Exec Look Ahead is for HQ Administrators");
    const { q } = reportStartSchema.parse(req.body ?? {});
    const { jobs, inlineWaitMs } = service();
    const doc = buildReport(report, await reportData(deps, actor, q), originOf(req));
    if (rowCountOf(doc) > REPORT_ROW_LIMIT) throw new ReportTooLargeError("rows to print");
    const started = jobs.start(actor.userId, report, doc);
    const view = await jobs.settle(actor.userId, started.id, inlineWaitMs);
    res.status(view.status === "running" ? 202 : 201).json(view);
  }));
  r.get("/reports/jobs/:id", runList(async (req, res) => {
    res.json(service().jobs.view(req.calendar!.userId, jobIdOf(req)));
  }));
  r.get("/reports/jobs/:id/pdf", runList(async (req, res) => {
    const actor = req.calendar!;
    const { report, bytes } = service().jobs.pdf(actor.userId, jobIdOf(req));
    // A role taken away since the report started takes the report with it.
    if (!can.runReport(actor, report)) throw new ReportJobNotFoundError();
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${REPORT_FILE_NAMES[report]}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    });
    res.send(Buffer.from(bytes));
  }));
  return r;
}
```

`apps/calendar/src/http/list-errors.ts`: import

```ts
import { ReportTooLargeError } from "../reports/data";
import { REPORT_RETRY_AFTER_SECONDS, ReportBusyError, ReportJobNotFoundError, ReportJobNotReadyError, ReportsUnavailableError } from "../reports/jobs";
```

and in `sendListError`, after the `ExportBusyError` line:

```ts
  if (e instanceof ReportTooLargeError) return void res.status(422).json({ error: e.message }), true;
  if (e instanceof ReportBusyError) return void res.status(503).set("Retry-After", String(REPORT_RETRY_AFTER_SECONDS)).json({ error: e.message }), true;
  if (e instanceof ReportsUnavailableError) return void res.status(503).json({ error: e.message }), true;
  if (e instanceof ReportJobNotFoundError) return void res.status(404).json({ error: "not found" }), true;
  if (e instanceof ReportJobNotReadyError) return void res.status(409).json({ error: e.message }), true;
```

`apps/calendar/src/http/routes.ts`:
- Import `reportRoutes` from `./report-routes` and `type ReportJobs` from `../reports/jobs`.
- Add to `ApiDeps`:

```ts
  /** The report jobs and how long a start waits for its PDF before answering 202; null or unset answers the report routes 503. */
  reports?: { jobs: ReportJobs; inlineWaitMs: number } | null;
```

- In `apiRoutes`, after `r.use(feedRoutes(deps));`, add `r.use(reportRoutes(deps));`.

`apps/calendar/src/app.ts`:
- Import `type ApiDeps` from `./http/routes` beside `apiRoutes`.
- Add `reports?: ApiDeps["reports"];` to `AppDeps`.
- Build the API's deps as:

```ts
  const api: ApiDeps = { db: deps.db, rules: deps.rules, subscribers: deps.subscribers ?? [], now: deps.now, store: deps.store ?? null, reports: deps.reports ?? null };
```

`apps/calendar/src/start.ts`:
- Import:

```ts
import type { ApiDeps } from "./http/routes";
import { ReportJobs } from "./reports/jobs";
import { reportAssets } from "./reports/render/assets";
import { workerRenderer } from "./reports/render/renderer";
```

- Replace the end of `calendarEnvSchema` (its `STORAGE_DIR` entry and the closing `});`) with:

```ts
  STORAGE_DIR: z.string().min(1).default(fileURLToPath(new URL("../../../data/calendar-files", import.meta.url))),
  // Reports (spec addendum §10): each PDF is drawn in a worker thread with its own heap, one at a time
  // by default. A start waits this long for its PDF before answering 202 and letting the browser poll,
  // so no request outlives a proxy's timeout, whatever it is.
  REPORT_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  REPORT_HEAP_MB: z.coerce.number().int().min(64).max(4096).default(320),
  REPORT_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(900).default(120),
  REPORT_INLINE_WAIT_MS: z.coerce.number().int().min(0).max(25_000).default(5000),
});

/** The report jobs, or null when the worker or BC Sans can't be found: the Calendar runs, its reports answer 503. */
function startReports(p: z.infer<typeof calendarEnvSchema>): ApiDeps["reports"] {
  try {
    const renderer = workerRenderer({ ...reportAssets(), heapMb: p.REPORT_HEAP_MB, timeoutMs: p.REPORT_TIMEOUT_SECONDS * 1000 });
    return { jobs: new ReportJobs({ renderer, concurrency: p.REPORT_CONCURRENCY }), inlineWaitMs: p.REPORT_INLINE_WAIT_MS };
  } catch (e) {
    console.error("[calendar] reports are unavailable: the report worker or its fonts weren't found", safeErrorLabel(e));
    return null;
  }
}
```

- In `startCalendar`, replace the `createApp(...)` line with:

```ts
  const reports = startReports(parsed);
  const app = createApp({ db, auth: auth.bearer, eventSecrets: parsed.EVENT_SECRETS, rules, subscribers, store, reports });
```

- In `closers`, after the lock sweep, add:

```ts
      { name: "report jobs", close: async () => { await reports?.jobs.close(); } },
```

- [ ] **Step 4: Run them to see them pass, then the Calendar's whole suite, and type-check**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/http/report-routes.test.ts apps/calendar/src/start.test.ts apps/calendar/src/http/config-routes.test.ts`
Expected: PASS (report routes 11, start 4, config 4).
Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar apps/stack`
Expected: PASS.
Run both `tsc` commands. Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/calendar/src/reports/jobs.ts apps/calendar/src/http apps/calendar/src/capabilities.ts apps/calendar/src/app.ts apps/calendar/src/start.ts apps/calendar/src/start.test.ts
git commit -m "feat(calendar): report jobs: start, poll and download, owner only; the Exec Look Ahead for HQ Administrators"
```

---
### Task 8: The parity proof: each report's PDF read back, and 5i's comparison hook

Covers: spec §3 row 5g's exit check (as Task 11 rewrites it), §12.3 (the comparison 5i runs), §16 (the Reports test line; acceptance 2 (reports), 10). Decision G20.

**Files:**
- Create: `apps/calendar/src/reports/golden.test.ts`, `scripts/calendar-report-compare.ts`, `tests/calendar-report-compare.test.ts`.
- Modify: `apps/calendar/test/pdf-text.ts`, `package.json`.

**Interfaces:**
- Consumes: everything above, through the routes, with the real worker renderer.
- Produces:
  - `outlineOf(pages: PdfPage[]): string[]` (`test/pdf-text.ts`). It gives "§ SECTION", "# Weekday, Month d, yyyy" or "# Month yyyy", "∅ Weekday, Month d, yyyy" (no activities) and "id:N" from each activity link, ours or legacy's. It skips the cover.
  - `diffOutlines(a, b)`, `insideRepo(dir)`, `compareReports({ legacy, ours, out })` (`scripts/calendar-report-compare.ts`).
  - `npm run calendar:report-compare -- --legacy <pdf> --new <pdf> --out <dir>`.

**The fixture**, fictional, Monday 2046-03-12 to Wednesday 2046-03-14, ids 30001–30007 as A–G:
- A: Health, Events, with a news release.
- B: Health confidential, Events.
- C: Finance, In the News.
- D: Finance confidential, Issues by section.
- E: Health, an all-day Awareness date.
- F: the consultations ministry.
- G: Health, an unconfirmed six-day issue, In the News.

What legacy's rules give, per role:
- **The Health Editor's Look Ahead:** A and B on Monday, two empty days, G under Issues (the ministry rule), E under Awareness.
- **The HQ Administrator's Look Ahead:** D under Issues (by section), and G and C In the News on their days (G last, as a multi-day row).
- **The HQ Editor:** neither B nor D anywhere.
- F appears in no Look Ahead, but appears in Planning.

- [ ] **Step 1: Write the failing tests**

`apps/calendar/test/pdf-text.ts`, append:

```ts
const SECTIONS = ["inside government", "outside government", "events, speeches & releases", "issues and reports", "consultations and dialogues", "in the news", "awareness dates", "long term outlook", "30 / 60 / 90 report"];
const DAY = /^(No Activities for )?((?:Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)day, [A-Z][a-z]+ \d{1,2}, \d{4})$/;
const MONTH = /^(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4}$/;
/** An activity's link: ours (/hub/calendar/activities/123) or legacy's (Activity.aspx?ActivityId=123). */
const ACTIVITY_LINK = /(?:\/hub\/calendar\/activities\/|[?&]ActivityId=)(\d+)$/;

/**
 * A report's structure in reading order, for golden tests and the 5i comparison with legacy's
 * PDFs: "§ SECTION", "# day or month heading", "∅ day with no activities", and "id:123" for each
 * row's activity link. The cover (the page with "Contents:") is skipped.
 */
export function outlineOf(pages: PdfPage[]): string[] {
  const out: string[] = [];
  for (const page of pages) {
    if (page.lines.some((l) => l.text === "Contents:")) continue;
    const tokens: { y: number; t: string }[] = [];
    for (const l of page.lines) {
      const day = DAY.exec(l.text);
      if (SECTIONS.includes(l.text.toLowerCase())) tokens.push({ y: l.y, t: `§ ${l.text.toUpperCase()}` });
      else if (day) tokens.push({ y: l.y, t: `${day[1] ? "∅" : "#"} ${day[2]}` });
      else if (MONTH.test(l.text)) tokens.push({ y: l.y, t: `# ${l.text}` });
    }
    for (const link of page.links) {
      const m = ACTIVITY_LINK.exec(link.url);
      if (m) tokens.push({ y: link.y, t: `id:${m[1]}` });
    }
    out.push(...tokens.sort((a, b) => b.y - a.y).map((x) => x.t));
  }
  return out;
}
```

Create `apps/calendar/src/reports/golden.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import type { ReportJobView } from "@gcpe/calendar-contract";
import { createCalendarTestDb, createTestApp } from "../../test/helpers";
import { outlineOf, pdfPages, type PdfPage } from "../../test/pdf-text";
import { call, insertRaw, seedWorld, type Who, type World } from "../../test/world";
import { activityCategories, activityCommMaterials } from "../db/schema";
import { ReportJobs } from "./jobs";
import { reportAssets } from "./render/assets";
import { workerRenderer } from "./render/renderer";

/** Supertest's body parser, for a binary body. */
type BodyParser = Parameters<ReturnType<ReturnType<typeof request>["get"]>["parse"]>[0];
const binary: BodyParser = (res, cb) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

// Monday 2046-03-12 to Wednesday 2046-03-14; BC is UTC−7, so 09:00 BC is 16:00Z.
const RANGE = { filter: { from: "2046-03-12", to: "2046-03-14" } };
const IDS = { A: 30001, B: 30002, C: 30003, D: 30004, E: 30005, F: 30006, G: 30007 } as const;
type Key = keyof typeof IDS;
const id = (k: Key) => `id:${IDS[k]}`;

/**
 * The parity proof (spec addendum §3 row 5g, §16 acceptance 10): each report rendered to PDF in the
 * worker, its text read back with a PDF reader, and its sections and activity order compared with
 * what legacy's rules give for this fixture. Fictional data only.
 */
describe("the reports as PDF: sections and activity order from the text (golden structure)", () => {
  let tdb: TestDatabase;
  let w: World;
  let app: ReturnType<typeof createTestApp>;
  let jobs: ReportJobs;
  const pdfOf = async (who: Who, report: string): Promise<PdfPage[]> => {
    const started = await call(app, "post", `/api/reports/${report}`, w.as[who].cookie, { q: RANGE });
    expect(started.status, `${report} as ${who}`).toBe(201);
    const file = await request(app).get(`/api/reports/jobs/${(started.body as ReportJobView).id}/pdf`).set("cookie", w.as[who].cookie).buffer(true).parse(binary);
    expect(file.status).toBe(200);
    return pdfPages(new Uint8Array(file.body as Buffer));
  };
  const text = (pages: PdfPage[]) => pages.flatMap((p) => p.lines.map((l) => l.text)).join("\n");

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    jobs = new ReportJobs({ renderer: workerRenderer({ ...reportAssets(), heapMb: 256, timeoutMs: 60_000 }), concurrency: 1 });
    app = createTestApp(tdb.db, { reports: { jobs, inlineWaitMs: 30_000 } });
    w = await seedWorld(app, tdb.db);
    const make = async (k: Key, start: string, end: string, over: Parameters<typeof insertRaw>[1], category: number = w.cat.plain) => {
      await insertRaw(tdb.db, { id: IDS[k], title: `Golden ${k}`, details: `Fictional details ${k}`, startAt: new Date(start), endAt: new Date(end), ...over });
      await tdb.db.insert(activityCategories).values({ activityId: IDS[k], categoryId: category });
    };
    await make("A", "2046-03-12T16:00:00Z", "2046-03-12T17:00:00Z", { hqSection: "events_and_speeches" });
    await tdb.db.insert(activityCommMaterials).values({ activityId: IDS.A, commMaterialId: w.commMaterial.newsRelease });
    await make("B", "2046-03-12T17:00:00Z", "2046-03-12T18:00:00Z", { hqSection: "events_and_speeches", isConfidential: true });
    await make("C", "2046-03-13T16:00:00Z", "2046-03-13T17:00:00Z", { hqSection: "in_the_news", contactMinistryKey: "finance" });
    await make("D", "2046-03-13T17:00:00Z", "2046-03-13T18:00:00Z", { hqSection: "issues_and_reports", contactMinistryKey: "finance", isConfidential: true });
    await make("E", "2046-03-14T07:00:00Z", "2046-03-15T06:45:00Z", { hqSection: "not_on_la", isAllDay: true }, w.cat.awareness);
    await make("F", "2046-03-12T18:00:00Z", "2046-03-12T19:00:00Z", { hqSection: "not_on_la", contactMinistryKey: "consult" });
    await make("G", "2046-03-12T16:00:00Z", "2046-03-18T16:00:00Z", { hqSection: "in_the_news", isIssue: true, isConfirmed: false });
  });
  afterAll(async () => {
    await jobs.close();
    await tdb.drop();
  });

  it("Look Ahead, Health Editor: their events, an empty day said so, Issues by the ministry rule, Awareness; no Consultations section", async () => {
    const pages = await pdfOf("editor", "look-ahead");
    expect(pages.every((p) => p.size[0] === 612 && p.size[1] === 792)).toBe(true);
    expect(outlineOf(pages)).toEqual([
      "§ INSIDE GOVERNMENT", "# Monday, March 12, 2046", "§ EVENTS, SPEECHES & RELEASES", id("A"), id("B"),
      "∅ Tuesday, March 13, 2046", "∅ Wednesday, March 14, 2046",
      "§ ISSUES AND REPORTS", id("G"),
      "§ OUTSIDE GOVERNMENT",
      "§ AWARENESS DATES", id("E"),
    ]);
    const all = text(pages);
    expect(all).toContain("DRAFT ONLY - NOT FOR CIRCULATION");
    expect(all).toContain("Monday, Mar. 12, 2046 to Wednesday, Mar. 14, 2046");
    expect(all).not.toContain("Consultations and Dialogues");
    expect(all).toContain("Not for Look Ahead Fictional details B");
    for (const k of ["C", "D", "F"] as const) expect(all).not.toContain(`Golden ${k}`);
  });

  it("Look Ahead, HQ Administrator: Issues by section, In the News per day, a page per day", async () => {
    const pages = await pdfOf("hqAdmin", "look-ahead");
    expect(outlineOf(pages)).toEqual([
      "§ INSIDE GOVERNMENT", "# Monday, March 12, 2046", "§ EVENTS, SPEECHES & RELEASES", id("A"), id("B"),
      "∅ Tuesday, March 13, 2046", "∅ Wednesday, March 14, 2046",
      "§ ISSUES AND REPORTS", id("D"),
      "§ OUTSIDE GOVERNMENT",
      "§ IN THE NEWS", id("G"), "§ IN THE NEWS", id("C"), id("G"), "§ IN THE NEWS", id("G"),
      "§ AWARENESS DATES", id("E"),
    ]);
    // Cover, then one page for each of the three days (HQ breaks after every day but Saturday), Issues, In the News, Awareness.
    expect(pages).toHaveLength(7);
    expect(text(pages)).not.toContain("Golden F");
  });

  it("Look Ahead, HQ Editor: another ministry's confidential activities nowhere (C127)", async () => {
    const pages = await pdfOf("hqEditor", "look-ahead");
    expect(outlineOf(pages)).toEqual([
      "§ INSIDE GOVERNMENT", "# Monday, March 12, 2046", "§ EVENTS, SPEECHES & RELEASES", id("A"),
      "∅ Tuesday, March 13, 2046", "∅ Wednesday, March 14, 2046",
      "§ ISSUES AND REPORTS",
      "§ OUTSIDE GOVERNMENT",
      "§ IN THE NEWS", id("G"), "§ IN THE NEWS", id("C"), id("G"), "§ IN THE NEWS", id("G"),
      "§ AWARENESS DATES", id("E"),
    ]);
    for (const k of ["B", "D"] as const) expect(text(pages)).not.toContain(`Golden ${k}`);
  });

  it("Exec Look Ahead, HQ Administrator: the Look Ahead's structure with each row's Last updated", async () => {
    const pages = await pdfOf("hqAdmin", "exec-look-ahead");
    expect(outlineOf(pages)).toEqual(outlineOf(await pdfOf("hqAdmin", "look-ahead")));
    expect(text(pages)).toMatch(/Last updated/);
    expect(text(pages)).not.toMatch(/Last updated updated/);
  });

  it("30/60/90, Health Editor: one month, each activity once, the consultations ministry kept", async () => {
    const pages = await pdfOf("editor", "30-60-90");
    expect(outlineOf(pages)).toEqual(["§ 30 / 60 / 90 REPORT", "# March 2046", id("A"), id("B"), id("G"), id("E")]);
    expect(text(pages)).toMatch(/DRAFT AND CONFIDENTIAL Updated Tuesday, Nov 3, 2026 11:00 AM/);
  });

  it("Planning, HQ Administrator: Legal landscape, every visible activity in legacy's order", async () => {
    const pages = await pdfOf("hqAdmin", "planning");
    expect(pages.every((p) => p.size[0] === 1008 && p.size[1] === 612)).toBe(true);
    expect(outlineOf(pages)).toEqual(["A", "B", "F", "G", "C", "D", "E"].map((k) => id(k as Key)));
    expect(text(pages)).toContain("Sample Corporate Calendar: Schedule of Activities");
  });
});
```

Create `tests/calendar-report-compare.test.ts`:

```ts
// The 5i comparison hook, on our own reports only: the past-period legacy PDFs never enter the repo.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reportAssets } from "../apps/calendar/src/reports/render/assets";
import { renderPdf, useBcSans } from "../apps/calendar/src/reports/render/pdf";
import type { ReportDoc } from "../apps/calendar/src/reports/model";
import { compareReports, diffOutlines, insideRepo } from "../scripts/calendar-report-compare";

const doc = (ids: number[]): ReportDoc => ({
  page: "letter-portrait", title: "Sample", header: null, footer: { pageNumbers: true },
  blocks: [
    { kind: "heading", runs: [{ text: "AWARENESS DATES" }], size: 12 },
    { kind: "table", widths: ["*", 80], header: [{ runs: [{ text: "Name" }] }, { runs: [{ text: "CC ID#" }] }], rows: ids.map((id) => [{ runs: [{ text: `Sample ${id}` }] }, { runs: [{ text: `HLTH-${id}`, link: `https://staff.example.test/hub/calendar/activities/${id}` }] }]) },
  ],
});

describe("the report comparison hook for 5i (spec addendum §12.3)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "report-compare-"));
    useBcSans(reportAssets().fontsDir);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("diffs two outlines line by line", () => {
    expect(diffOutlines(["§ A", "id:1", "id:2"], ["§ A", "id:2", "id:3"])).toEqual(["  § A", "- id:1", "  id:2", "+ id:3"]);
  });

  it("compares two PDFs' sections and activities, writing only outside the repository", async () => {
    writeFileSync(join(dir, "legacy.pdf"), await renderPdf(doc([1, 2])));
    writeFileSync(join(dir, "ours.pdf"), await renderPdf(doc([1, 2])));
    writeFileSync(join(dir, "other.pdf"), await renderPdf(doc([2, 3])));
    expect((await compareReports({ legacy: join(dir, "legacy.pdf"), ours: join(dir, "ours.pdf"), out: join(dir, "same") })).same).toBe(true);
    const r = await compareReports({ legacy: join(dir, "legacy.pdf"), ours: join(dir, "other.pdf"), out: join(dir, "differ") });
    expect(r.diff).toEqual(["  § AWARENESS DATES", "- id:1", "  id:2", "+ id:3"]);
    expect(readFileSync(join(dir, "differ", "outline-legacy.txt"), "utf8")).toBe("§ AWARENESS DATES\nid:1\nid:2\n");
    expect(insideRepo(resolve(import.meta.dirname, "..", "docs"))).toBe(true);
    expect(insideRepo(dir)).toBe(false);
    await expect(compareReports({ legacy: join(dir, "legacy.pdf"), ours: join(dir, "ours.pdf"), out: resolve(import.meta.dirname, "report-parity") })).rejects.toThrow("--out must be outside the repository");
  });
});
```

- [ ] **Step 2: Run them, and see the golden tests fail if the rules were different**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/reports/golden.test.ts tests/calendar-report-compare.test.ts`
Expected: `calendar-report-compare.test.ts` FAILS, "Failed to resolve import "../scripts/calendar-report-compare"".

The golden tests exercise Tasks 1–7's code, so they pass as written (6 tests). To show they can fail, add `"id:30006"` (F, the consultations ministry) after `id("B")` in the Health Editor's expectation. Run it and see it FAIL on `toEqual`, then restore it.

- [ ] **Step 3: Implement the hook**

Create `scripts/calendar-report-compare.ts`:

```ts
#!/usr/bin/env -S node --
// The hook for 5i's report parity check (spec addendum §12.3): compares the structure of a legacy
// report PDF with ours for the same range and filter, section by section, activity by activity.
// Both are read with the reader the golden tests use (apps/calendar/test/pdf-text.ts), so a
// difference is in the reports, not in how they were read.
//
// Usage:
//   npm run calendar:report-compare -- --legacy <legacy.pdf> --new <ours.pdf> --out <folder>
//
// The past-period PDFs the team supplies hold real activities: they and the output stay outside
// this repository. The script refuses an --out inside it, and writes nothing but the two outlines
// and their differences there. Exit code 1 when the outlines differ.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { outlineOf, pdfPages } from "../apps/calendar/test/pdf-text";

const REPO = resolve(import.meta.dirname, "..");

/** The shortest edit from `a` to `b`, as lines: "  same", "- only in a", "+ only in b". */
export function diffOutlines(a: string[], b: string[]): string[] {
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) (out.push(`  ${a[i]}`), i++, j++);
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);
  return out;
}

/** True when `dir` is this repository or inside it. */
export function insideRepo(dir: string): boolean {
  const rel = relative(REPO, resolve(dir));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

export async function compareReports(o: { legacy: string; ours: string; out: string }): Promise<{ same: boolean; diff: string[] }> {
  if (insideRepo(o.out)) throw new Error("--out must be outside the repository: the legacy reports hold real activities");
  const legacy = outlineOf(await pdfPages(new Uint8Array(readFileSync(o.legacy))));
  const ours = outlineOf(await pdfPages(new Uint8Array(readFileSync(o.ours))));
  const diff = diffOutlines(legacy, ours);
  mkdirSync(o.out, { recursive: true });
  writeFileSync(join(o.out, "outline-legacy.txt"), `${legacy.join("\n")}\n`);
  writeFileSync(join(o.out, "outline-new.txt"), `${ours.join("\n")}\n`);
  writeFileSync(join(o.out, "diff.txt"), `${diff.join("\n")}\n`);
  return { same: diff.every((l) => l.startsWith("  ")), diff };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    const v = i === -1 ? undefined : process.argv[i + 1];
    if (!v) throw new Error(`--${name} is required (see the usage at the top of scripts/calendar-report-compare.ts)`);
    return v;
  };
  const { same, diff } = await compareReports({ legacy: arg("legacy"), ours: arg("new"), out: arg("out") });
  console.log(same ? "The outlines match." : `The outlines differ in ${diff.filter((l) => !l.startsWith("  ")).length} lines: see diff.txt.`);
  process.exit(same ? 0 : 1);
}
```

`package.json`, in `scripts`, after `"distribution:capacity": …`:

```json
    "calendar:report-compare": "tsx scripts/calendar-report-compare.ts"
```

- [ ] **Step 4: Run them to see them pass, and type-check**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/reports tests/calendar-report-compare.test.ts`
Expected: PASS (58 report tests, 2 comparison tests).
Run: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: no errors.

The legacy samples aren't in the repo, so this is optional. To see the hook read one, run `npm run calendar:report-compare -- --legacy "<path>/LookAhead 1.pdf" --new <any of ours> --out <a folder in your temp dir>`. Expected: it writes `outline-legacy.txt` with "§ INSIDE GOVERNMENT", day headings and id lines, and exits 1 (they differ). Delete the folder afterwards.

- [ ] **Step 5: Commit**

```bash
git add apps/calendar/test/pdf-text.ts apps/calendar/src/reports/golden.test.ts scripts/calendar-report-compare.ts tests/calendar-report-compare.test.ts package.json
git commit -m "test(calendar): each report's PDF read back against legacy's rules; the report comparison hook for 5i"
```

---

### Task 9: The worker in both artifacts: SiteGround's and the per-app images

Covers: spec §10 ("pdfmake on SiteGround"), §3 row 5g ("Every report built on boxs.ca", which Task 11 checks by hand). Decision G7.

**Files:**
- Create: `scripts/build-report-worker.mjs`, `scripts/build-report-worker.d.mts`, `tests/build-report-worker.test.ts`.
- Modify: `scripts/build-siteground.mjs`, `scripts/build-app.mjs`.

**Interfaces:**
- Consumes: Task 6's `worker.ts`, `reportAssets`, `workerRenderer`; `findLeakedPaths` (`build-siteground.mjs`); `pdfPages`.
- Produces: `buildReportWorker(outDir, { external? })`. It writes `<outDir>/report-worker.cjs` and `<outDir>/fonts/` (the four `.woff` faces and `LICENSE_OFL.txt`).

- [ ] **Step 1: Write the failing test**

Create `tests/build-report-worker.test.ts`:

```ts
// The bundled report worker must run where nothing but the artifact exists (SiteGround: no
// node_modules), which an ESM bundle of pdfmake can't (it reads __dirname). This builds it the way
// both build scripts do and renders a page with it.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildReportWorker } from "../scripts/build-report-worker.mjs";
import { findLeakedPaths } from "../scripts/build-siteground.mjs";
import { reportAssets } from "../apps/calendar/src/reports/render/assets";
import { workerRenderer } from "../apps/calendar/src/reports/render/renderer";
import { pdfPages } from "../apps/calendar/test/pdf-text";

describe("the bundled report worker", () => {
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "report-worker-"));
    await buildReportWorker(dir);
  }, 60_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("writes report-worker.cjs and BC Sans with its licence beside it", () => {
    expect(readdirSync(dir).sort()).toEqual(["fonts", "report-worker.cjs"]);
    expect(readdirSync(join(dir, "fonts")).sort()).toEqual(["BCSans-Bold.woff", "BCSans-BoldItalic.woff", "BCSans-Italic.woff", "BCSans-Regular.woff", "LICENSE_OFL.txt"]);
    expect(findLeakedPaths(dir, [{ label: "the repository's absolute path", value: resolve(import.meta.dirname, "..") }])).toEqual([]);
  });

  it("is found beside a bundle and renders a PDF in BC Sans", async () => {
    const assets = reportAssets(pathToFileURL(join(dir, "stack.js")).href);
    expect(assets).toEqual({ workerFile: join(dir, "report-worker.cjs"), execArgv: [], fontsDir: `${join(dir, "fonts")}/` });
    const renderer = workerRenderer({ ...assets, heapMb: 128, timeoutMs: 30_000 });
    try {
      const bytes = await renderer.render({ page: "letter-portrait", title: "Sample", header: null, footer: { pageNumbers: true }, blocks: [{ kind: "heading", runs: [{ text: "Sample bundled render" }], size: 12 }] });
      expect((await pdfPages(bytes))[0]!.lines.map((l) => l.text)).toEqual(["Sample bundled render", "Page 1 of 1"]);
      expect(Buffer.from(bytes).toString("latin1")).toMatch(/\+BCSans-Regular/);
    } finally {
      await renderer.close();
    }
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run tests/build-report-worker.test.ts`
Expected: FAIL, "Failed to resolve import "../scripts/build-report-worker.mjs"".

- [ ] **Step 3: Implement**

Create `scripts/build-report-worker.mjs`:

```js
// Bundles the Calendar's report worker (apps/calendar/src/reports/render/worker.ts) to
// <outDir>/report-worker.cjs and copies BC Sans to <outDir>/fonts/, the layout
// apps/calendar/src/reports/render/assets.ts looks for beside a bundle. CommonJS, not ESM: pdfmake's
// in-memory file store reads __dirname, which an ESM bundle doesn't define.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(join(root, "apps/calendar/package.json"));
const FONT_FILES = ["BCSans-Regular.woff", "BCSans-Bold.woff", "BCSans-Italic.woff", "BCSans-BoldItalic.woff", "LICENSE_OFL.txt"];

/** `external`: npm packages left to node_modules (the per-app images); none for SiteGround's self-contained artifact. */
export async function buildReportWorker(outDir, { external = [] } = {}) {
  mkdirSync(join(outDir, "fonts"), { recursive: true });
  await build({
    entryPoints: [join(root, "apps/calendar/src/reports/render/worker.ts")],
    outfile: join(outDir, "report-worker.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external,
    minifyWhitespace: true,
    minifySyntax: true,
    minifyIdentifiers: false,
    keepNames: true,
    // As stack.js: no end-of-file legal-comment block, whose authors' handles can match the build
    // machine's username and fail build-siteground's leak scan.
    legalComments: "none",
    logLevel: "warning",
  });
  const pkg = dirname(require.resolve("@bcgov/bc-sans/package.json"));
  for (const f of FONT_FILES) copyFileSync(join(pkg, f.endsWith(".txt") ? f : join("fonts", f)), join(outDir, "fonts", f));
}
```

Create `scripts/build-report-worker.d.mts`:

```ts
// Hand-written declaration for build-report-worker.mjs, for tests/build-report-worker.test.ts.
export declare function buildReportWorker(outDir: string, options?: { external?: string[] }): Promise<void>;
```

`scripts/build-siteground.mjs`:
- Import `buildReportWorker` from `./build-report-worker.mjs`, above the `build-staff-web.mjs` import.
- In `runBuild`, before `console.log("[build-siteground] copying migrations …");`, add:

```js
  // The Calendar's reports render in a worker thread, which needs a file of its own beside stack.js,
  // and BC Sans beside that (apps/calendar/src/reports/render/assets.ts).
  console.log("[build-siteground] bundling the report worker and copying BC Sans …");
  await buildReportWorker(outDir);
```

`scripts/build-app.mjs`: replace the last line, ``console.log(`built ${appDir}/dist/main.js`);``, with:

```js
// The Calendar (alone or in the stack) renders reports in a worker thread: its own bundle beside main.js.
if (["calendar", "stack"].includes(appDir.split("/").pop())) {
  const { buildReportWorker } = await import("./build-report-worker.mjs");
  await buildReportWorker(join(appDir, "dist"), { external: [...deps] });
}
console.log(`built ${appDir}/dist/main.js`);
```

(`apps/calendar/Dockerfile` already runs `npm ci --omit=dev --workspace @gcpe/calendar`, so pdfmake is in the image's `node_modules`. It copies `apps/calendar/dist`, which now holds `report-worker.cjs` and `fonts/`.)

- [ ] **Step 4: Run it to see it pass, then build the SiteGround artifact**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run tests/build-report-worker.test.ts tests/build-siteground-guard.test.ts`
Expected: PASS.
Run: `npx -y -p node@24 -- npm run build:siteground`
Expected:
- the run ends with "[build-siteground] OK — no leaked local paths/username found.", the `--check` smoke test, and "[build-siteground] OK — artifact at …";
- `dist/siteground/` holds `report-worker.cjs` (about 1.6 MB) and `fonts/`.

If `--check` fails with "Identifier 'createRequire' has already been declared", something on the stack's import graph imports `createRequire` by name. Use a namespace import, as `assets.ts` does.
Run both `tsc` commands. Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-report-worker.mjs scripts/build-report-worker.d.mts scripts/build-siteground.mjs scripts/build-app.mjs tests/build-report-worker.test.ts
git commit -m "build: the report worker and BC Sans beside stack.js and each app's main.js"
```

---
### Task 10: The list's report buttons: start, "Preparing your report…", save

Covers: spec §8.1 (the toolbar's Look Ahead, Exec Look Ahead, 30/60/90 and Planning, each as PDF), §10, §16 acceptance 10 (Exec offered only to HQ Administrators) and 18 (axe); carry-forward § 5g (buttons take the current `ListQuery` as `q`). Decisions G3, G5, G19. Review Focus 1, 5.

**Files:**
- Create: `apps/staff-web/src/screens/calendar/list/Reports.tsx`, `apps/staff-web/src/screens/calendar/list/Reports.test.tsx`.
- Modify: `apps/staff-web/src/screens/calendar/list/api.ts`, `types.ts`, `fixtures.tsx`, `ActivityListScreen.tsx`, `a11y.test.tsx`.

**Interfaces:**
- Consumes: Task 1's `REPORT_KINDS`, `REPORT_LABELS`, `REPORT_FILE_NAMES`, `ReportKind`, `ReportJobView`; Task 7's routes and `list.execLookAhead`; `apiFetch`, `ApiError`, `reportUnauthorized`.
- Produces:
  - `listApi.startReport(report, query)` (POST `{ q: query }`), `listApi.reportJob(id)`, `listApi.reportPdfUrl(id)`.
  - `downloadFile(url, fileName, fallback)`; `downloadExport(query)` now uses it.
  - `REPORT_POLL_MS = 1000`, `REPORT_WAIT_MAX_MS = 300000`.
  - `runReport(report, query, o?: { sleep?; now? })`.
  - `ReportButtons({ query, execLookAhead })`.
  - `CalendarConfigView.list.execLookAhead`.

- [ ] **Step 1: Write the failing tests**

`apps/staff-web/src/screens/calendar/list/fixtures.tsx`: add `execLookAhead: false` to `CONFIG.list`, and `execLookAhead: true` to `HQ_ADMIN_CONFIG.list`.

Create `apps/staff-web/src/screens/calendar/list/Reports.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_LIST_QUERY, type ReportJobView } from "@gcpe/calendar-contract";
import { jsonResponse } from "../../../../test/jsonResponse";
import { REPORT_WAIT_MAX_MS, runReport } from "./api";
import { HQ_ADMIN_CONFIG, HQ_ADMIN_ME, never, renderList, stubFetch, type Call } from "./fixtures";

const ID = "AbCdEfGhIjKlMnOpQrSt_-";
const job = (over: Partial<ReportJobView> = {}): ReportJobView => ({ id: ID, report: "look-ahead", status: "ready", error: null, ...over });
const pdf = () => new Response(new Blob(["%PDF-sample"]), { status: 200, headers: { "content-type": "application/pdf" } });
const reports = (page: Element) => within(page.querySelector('[aria-label="Reports (PDF)"]') as HTMLElement);

describe("the list's reports (spec addendum §8.1, §10)", () => {
  let names: string[];
  beforeEach(() => {
    // jsdom has no object URLs; record what the link would save.
    names = [];
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:sample"), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("an Editor gets Look Ahead, 30/60/90 and Planning; an HQ Administrator also the Exec Look Ahead", async () => {
    stubFetch([]);
    const { container } = renderList();
    await screen.findByText("Sample listed");
    expect(reports(container).getAllByRole("button").map((b) => b.textContent)).toEqual(["Look Ahead", "30/60/90", "Planning"]);
    cleanup();
    stubFetch([], { me: HQ_ADMIN_ME, config: HQ_ADMIN_CONFIG });
    const hq = renderList();
    await screen.findByText("Sample listed");
    expect(reports(hq.container).getAllByRole("button").map((b) => b.textContent)).toEqual(["Look Ahead", "Exec Look Ahead", "30/60/90", "Planning"]);
  });

  it("runs the report for the list's current query and saves the PDF it gets back", async () => {
    const calls: Call[] = [];
    stubFetch(calls, {
      other: (url) => (url === "/calendar/api/reports/look-ahead" ? jsonResponse(201, job()) : url === `/calendar/api/reports/jobs/${ID}/pdf` ? pdf() : undefined),
    });
    renderList();
    await screen.findByText("Sample listed");
    await userEvent.setup().click(screen.getByRole("button", { name: "Look Ahead" }));
    expect(await screen.findByText("The Look Ahead report has downloaded.")).toBeInTheDocument();
    const post = calls.find((c) => c.url === "/calendar/api/reports/look-ahead")!;
    expect(post.init!.method).toBe("POST");
    expect(JSON.parse(String(post.init!.body))).toEqual({ q: DEFAULT_LIST_QUERY });
    expect(names).toEqual(["LookAhead.pdf"]);
  });

  it("while the server prepares it, says so and holds the buttons, then saves it", async () => {
    const calls: Call[] = [];
    stubFetch(calls, {
      other: (url) => {
        if (url === "/calendar/api/reports/planning") return jsonResponse(202, job({ report: "planning", status: "running" }));
        if (url === `/calendar/api/reports/jobs/${ID}`) return jsonResponse(200, job({ report: "planning" }));
        if (url === `/calendar/api/reports/jobs/${ID}/pdf`) return pdf();
        return undefined;
      },
    });
    renderList();
    await screen.findByText("Sample listed");
    await userEvent.setup().click(screen.getByRole("button", { name: "Planning" }));
    expect(await screen.findByText("Preparing your Planning report…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Look Ahead" })).toBeDisabled();
    expect(await screen.findByText("The Planning report has downloaded.", undefined, { timeout: 3000 })).toBeInTheDocument();
    expect(calls.filter((c) => c.url === `/calendar/api/reports/jobs/${ID}`)).toHaveLength(1);
    expect(names).toEqual(["PlanningReport.pdf"]);
    expect(screen.getByRole("button", { name: "Look Ahead" })).toBeEnabled();
  });

  it("a report that failed, or one turned away while others run, says why", async () => {
    stubFetch([], {
      other: (url) =>
        url === "/calendar/api/reports/look-ahead"
          ? jsonResponse(201, job({ status: "failed", error: "The report is too large to prepare: narrow the filter and run it again." }))
          : url === "/calendar/api/reports/30-60-90"
            ? jsonResponse(503, { error: "Other reports are being prepared: try again in a few seconds" })
            : undefined,
    });
    renderList();
    await screen.findByText("Sample listed");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Look Ahead" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The report is too large to prepare: narrow the filter and run it again.");
    await user.click(screen.getByRole("button", { name: "30/60/90" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Other reports are being prepared: try again in a few seconds"));
    expect(names).toEqual([]);
  });

  it("a report the server forgot while preparing it (a restart) says to run it again", async () => {
    stubFetch([], {
      other: (url) => (url === "/calendar/api/reports/look-ahead" ? jsonResponse(202, job({ status: "running" })) : url === `/calendar/api/reports/jobs/${ID}` ? jsonResponse(404, { error: "not found" }) : undefined),
    });
    await expect(runReport("look-ahead", DEFAULT_LIST_QUERY, { sleep: async () => {} })).rejects.toThrow("The report was lost while it was being prepared. Run it again.");
  });

  it("gives up waiting after five minutes", async () => {
    stubFetch([], { other: (url) => (url.startsWith("/calendar/api/reports") ? jsonResponse(202, job({ status: "running" })) : undefined) });
    let t = 0;
    const out = runReport("look-ahead", DEFAULT_LIST_QUERY, { now: () => t, sleep: async (ms) => void (t += ms) });
    await expect(out).rejects.toThrow("The report is taking too long. Try again later, or narrow the filter.");
    expect(t).toBeGreaterThan(REPORT_WAIT_MAX_MS);
  });

  it("a report still starting shows the same message, for screen readers too", async () => {
    stubFetch([], { other: (url) => (url === "/calendar/api/reports/look-ahead" ? never() : undefined) });
    const { container } = renderList();
    await screen.findByText("Sample listed");
    await userEvent.setup().click(screen.getByRole("button", { name: "Look Ahead" }));
    expect(await reports(container).findByRole("status")).toHaveTextContent("Preparing your Look Ahead report…");
  });
});
```

`apps/staff-web/src/screens/calendar/list/a11y.test.tsx`, before the test "the grid failing to load":

```tsx
  it("the reports: all four for an HQ Administrator, one being prepared", async () => {
    stubFetch([], { me: HQ_ADMIN_ME, config: HQ_ADMIN_CONFIG, other: (url) => (url === "/calendar/api/reports/exec-look-ahead" ? never() : undefined) });
    const { container } = renderList();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Exec Look Ahead" }));
    await screen.findByText("Preparing your Exec Look Ahead report…");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("a report refused", async () => {
    stubFetch([], { other: (url) => (url === "/calendar/api/reports/planning" ? jsonResponse(422, { error: "Too many activities match: narrow the filter and run the report again" }) : undefined) });
    const { container } = renderList();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Planning" }));
    await screen.findByText("Too many activities match: narrow the filter and run the report again");
    expect(await seriousViolations(container)).toEqual([]);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/calendar/list/Reports.test.tsx apps/staff-web/src/screens/calendar/list/a11y.test.tsx`
Expected: FAIL. `Reports.test.tsx`: "runReport is not a function" or "No export named REPORT_WAIT_MAX_MS". The a11y tests: no button named "Exec Look Ahead".

- [ ] **Step 3: Implement**

`apps/staff-web/src/screens/calendar/list/types.ts`: in `CalendarConfigView`, `list` gains `execLookAhead: boolean`.

`apps/staff-web/src/screens/calendar/list/api.ts`:
- Imports:

```ts
import { REPORT_FILE_NAMES, type CalendarRangeView, type ListFilter, type ListOptions, type ListPage, type ListPreferences, type ListQuery, type ReportJobView, type ReportKind, type SavedFilterView } from "@gcpe/calendar-contract";
import { ApiError, apiFetch, reportUnauthorized } from "../../../api/client";
```

- In `listApi`, after `exportUrl`:

```ts
  startReport: (report: ReportKind, query: ListQuery) => apiFetch<ReportJobView>(`/calendar/api/reports/${report}`, { method: "POST", body: { q: query } }),
  reportJob: (id: string) => apiFetch<ReportJobView>(`/calendar/api/reports/jobs/${encodeURIComponent(id)}`),
  reportPdfUrl: (id: string) => `/calendar/api/reports/jobs/${encodeURIComponent(id)}/pdf`,
```

- Replace `downloadExport` and its doc comment (to the end of the file) with:

```ts
/** A file from the API, saved by the browser. A refusal comes back as an Error carrying the server's own message. */
export async function downloadFile(url: string, fileName: string, fallback: string): Promise<void> {
  const res = await fetch(url, { credentials: "same-origin" });
  if (!res.ok) {
    // A session that ended sends the user to sign in and back, as apiFetch does.
    if (res.status === 401) reportUnauthorized();
    let message = fallback;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string") message = body.error;
    } catch {
      // Not JSON: keep the general message.
    }
    throw new Error(message);
  }
  const href = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = href;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(href);
}

/** The Excel export as a download. */
export function downloadExport(query: ListQuery): Promise<void> {
  return downloadFile(listApi.exportUrl(query), "BCGovernmentActivities.xlsx", "Couldn't export the list.");
}

/** How often a report being prepared is asked about, and for how long before giving up. */
export const REPORT_POLL_MS = 1000;
export const REPORT_WAIT_MAX_MS = 5 * 60_000;

/**
 * A report (spec addendum §10): started from the current query, polled while the server prepares
 * it, then saved as a PDF.
 */
export async function runReport(
  report: ReportKind,
  query: ListQuery,
  o: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<void> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = o.now ?? Date.now;
  let job = await listApi.startReport(report, query);
  const giveUp = now() + REPORT_WAIT_MAX_MS;
  while (job.status === "running") {
    if (now() > giveUp) throw new Error("The report is taking too long. Try again later, or narrow the filter.");
    await sleep(REPORT_POLL_MS);
    try {
      job = await listApi.reportJob(job.id);
    } catch (e) {
      // A server restart (SiteGround stops an idle process) forgets every report being prepared.
      if (e instanceof ApiError && e.status === 404) throw new Error("The report was lost while it was being prepared. Run it again.");
      throw e;
    }
  }
  if (job.status === "failed") throw new Error(job.error ?? "The report couldn't be prepared. Try again.");
  await downloadFile(listApi.reportPdfUrl(job.id), REPORT_FILE_NAMES[report], "Couldn't download the report.");
}
```

Create `apps/staff-web/src/screens/calendar/list/Reports.tsx`:

```tsx
import { useState } from "react";
import { Button } from "@bcgov/design-system-react-components";
import { REPORT_KINDS, REPORT_LABELS, type ListQuery, type ReportKind } from "@gcpe/calendar-contract";
import { runReport } from "./api";

/**
 * The list toolbar's reports (spec addendum §8.1, §10): Look Ahead, Exec Look Ahead (HQ
 * Administrators), 30/60/90 and Planning, each a PDF of the list's current query. One at a time.
 */
export function ReportButtons({ query, execLookAhead }: { query: ListQuery; execLookAhead: boolean }): React.JSX.Element {
  const [busy, setBusy] = useState<ReportKind | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (report: ReportKind) => {
    setBusy(report);
    setStatus(null);
    setError(null);
    try {
      await runReport(report, query);
      setStatus(`The ${REPORT_LABELS[report]} report has downloaded.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The report couldn't be prepared. Try again.");
    } finally {
      setBusy(null);
    }
  };
  const kinds = REPORT_KINDS.filter((k) => k !== "exec-look-ahead" || execLookAhead);
  return (
    <div role="group" aria-label="Reports (PDF)">
      {kinds.map((k) => (
        <Button key={k} variant="secondary" isDisabled={busy !== null} onPress={() => void run(k)}>
          {REPORT_LABELS[k]}
        </Button>
      ))}
      {busy && <p role="status">{`Preparing your ${REPORT_LABELS[busy]} report…`}</p>}
      {!busy && status && <p role="status">{status}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
```

`apps/staff-web/src/screens/calendar/list/ActivityListScreen.tsx`:
- Import `ReportButtons` from `./Reports`.
- After `<ExportButton query={query} />`, add:

```tsx
          <ReportButtons query={query} execLookAhead={config.list.execLookAhead} />
```

The group is a `div` inside `.gcpe-actions`, so `.gcpe-calendar-toolbar .gcpe-actions > div` lays it out with no new CSS.

- [ ] **Step 4: Run them to see them pass, then the Calendar's screens, and type-check**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/calendar`
Expected: PASS (302 tests, with these 7 and the 2 axe states). The "while the server prepares it" test waits through one 1 s poll.
Run: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p apps/staff-web/tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/staff-web/src/screens/calendar/list
git commit -m "feat(staff-web): the list's Look Ahead, Exec Look Ahead, 30/60/90 and Planning buttons, prepared and saved as PDF"
```

---
### Task 11: End to end for each role; parity rows, questions, the spec, running notes, deploy notes and carry-forward

Covers: spec §3 row 5g's exit check end to end, §16 acceptance 2 (reports), 10 and 18; carry-forward § 5g (recording Consultations and Dialogues as dropped; the spec's "all 7 sections" and legend). Decisions G1–G22 recorded as C132, C148, C184–C189, Q62 and Q63.

**Files:**
- Create: `tests/e2e/calendar-reports.spec.ts`.
- Modify: `docs/parity/changes-from-legacy.md`, `docs/parity/open-questions.md`, `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`, `docs/superpowers/specs/2026-10-07-calendar-parity-design.md`, `docs/superpowers/plans/phase-5-carry-forward.md`.

**Interfaces:**
- Consumes: everything above; `listFixture`, `listUrl`, `MAY`, `sessionOf`, `useCookie`, `Key` (`calendar-support.ts`); `apiCall`, `baseUrl`, `expectNoSeriousA11yViolations` (`playwright-support.ts`); `pdfPages`, `outlineOf`.
- Produces: nothing new for code.

- [ ] **Step 1: Write the spec**

Create `tests/e2e/calendar-reports.spec.ts`:

```ts
// The 5g exit check end to end: each report as PDF from the list's current query, for several
// Calendar roles over the shared list fixture (A Health, B Health confidential, C Finance, D
// Finance confidential, E Finance confidential shared with Health, F Health deleted), read back
// with the golden tests' PDF reader. The fixture's activities sit In the News (confirmed, not an
// events category); B, D and E are confidential with no Look Ahead section, so only Planning and
// 30/60/90 list them. The full role matrix runs on real Postgres in apps/calendar/src/reports/.
import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import type { ReportJobView } from "@gcpe/calendar-contract";
import { outlineOf, pdfPages } from "../../apps/calendar/test/pdf-text";
import { CAL_EDITOR_EMAIL, CAL_HQ_ADMIN_EMAIL, CAL_HQ_EDITOR_EMAIL, CAL_READONLY_EMAIL } from "./constants";
import { listFixture, listUrl, MAY, sessionOf, useCookie, type Key } from "./calendar-support";
import { apiCall, baseUrl, expectNoSeriousA11yViolations } from "./playwright-support";

/** Starts a report through the API, polls it, and returns its PDF's bytes. */
async function reportPdf(cookie: string, report: string, q: object): Promise<Uint8Array> {
  let job = await apiCall<ReportJobView>(cookie, `/calendar/api/reports/${report}`, { method: "POST", body: { q } });
  for (let i = 0; job.status === "running" && i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    job = await apiCall<ReportJobView>(cookie, `/calendar/api/reports/jobs/${job.id}`);
  }
  expect(job.status).toBe("ready");
  const res = await fetch(`${baseUrl()}/calendar/api/reports/jobs/${job.id}/pdf`, { headers: { cookie } });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/pdf");
  return new Uint8Array(await res.arrayBuffer());
}

const ids = (outline: string[]) => outline.filter((t) => t.startsWith("id:")).map((t) => Number(t.slice(3)));

test.describe("the reports, as each role (spec addendum §3 row 5g, §10, §16 acceptance 10)", () => {
  const roles: [string, string, Key[]][] = [
    ["Editor (Health)", CAL_EDITOR_EMAIL, ["A", "B", "E"]],
    ["Read Only (Finance)", CAL_READONLY_EMAIL, ["C", "D", "E"]],
    ["HQ Editor", CAL_HQ_EDITOR_EMAIL, ["A", "C"]],
    ["HQ Administrator", CAL_HQ_ADMIN_EMAIL, ["A", "B", "C", "D", "E"]],
  ];
  for (const [who, email, keys] of roles) {
    test(`${who}: Planning and 30/60/90 list exactly the activities they can see, never a deleted one`, async () => {
      const f = await listFixture();
      const cookie = await sessionOf(email);
      const q = { filter: { ...MAY, quickSearch: f.tag } };
      const expected = keys.map((k) => f.ids[k]);
      const planning = await pdfPages(await reportPdf(cookie, "planning", q));
      expect(planning[0]!.size).toEqual([1008, 612]);
      expect(ids(outlineOf(planning))).toEqual(expected);
      expect(ids(outlineOf(await pdfPages(await reportPdf(cookie, "30-60-90", q))))).toEqual(expected);
    });
  }

  test("the Exec Look Ahead is refused below HQ Administrator, offered and built for one", async ({ page, context }) => {
    const f = await listFixture();
    const q = { filter: { ...MAY, quickSearch: f.tag } };
    const hqEditor = await sessionOf(CAL_HQ_EDITOR_EMAIL);
    const refused = await fetch(`${baseUrl()}/calendar/api/reports/exec-look-ahead`, {
      method: "POST", headers: { cookie: hqEditor, "x-gcpe-request": "1", "content-type": "application/json" }, body: JSON.stringify({ q }),
    });
    expect(refused.status).toBe(403);
    await useCookie(context, hqEditor);
    await page.goto(listUrl(q));
    await expect(page.getByRole("group", { name: "Reports (PDF)" }).getByRole("button")).toHaveText(["Look Ahead", "30/60/90", "Planning"]);
    const admin = await sessionOf(CAL_HQ_ADMIN_EMAIL);
    const exec = outlineOf(await pdfPages(await reportPdf(admin, "exec-look-ahead", q)));
    expect(exec).toContain("§ IN THE NEWS");
    expect(ids(exec)).toEqual([f.ids.A, f.ids.C]);
  });

  test("another user's report is not found", async () => {
    const f = await listFixture();
    const admin = await sessionOf(CAL_HQ_ADMIN_EMAIL);
    const job = await apiCall<ReportJobView>(admin, "/calendar/api/reports/planning", { method: "POST", body: { q: { filter: { ...MAY, quickSearch: f.tag } } } });
    const res = await fetch(`${baseUrl()}/calendar/api/reports/jobs/${job.id}/pdf`, { headers: { cookie: await sessionOf(CAL_EDITOR_EMAIL) } });
    expect(res.status).toBe(404);
  });

  test("HQ Editor: Look Ahead from the list's toolbar downloads the PDF for the current filter", async ({ page, context }) => {
    const f = await listFixture();
    await useCookie(context, await sessionOf(CAL_HQ_EDITOR_EMAIL));
    await page.goto(listUrl({ filter: { ...MAY, quickSearch: f.tag } }));
    await expect(page.locator(".gcpe-activity-title")).toHaveCount(2);
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Look Ahead" }).click()]);
    expect(download.suggestedFilename()).toBe("LookAhead.pdf");
    const outline = outlineOf(await pdfPages(new Uint8Array(readFileSync(await download.path()))));
    // May 2031, In the News on Wednesday May 14 only; the other days have no Events.
    expect(outline.slice(0, 2)).toEqual(["§ INSIDE GOVERNMENT", "∅ Thursday, May 1, 2031"]);
    expect(outline.slice(outline.indexOf("§ OUTSIDE GOVERNMENT"))).toEqual(["§ OUTSIDE GOVERNMENT", "§ IN THE NEWS", `id:${f.ids.A}`, `id:${f.ids.C}`, "§ AWARENESS DATES"]);
    await expect(page.getByRole("status").filter({ hasText: "The Look Ahead report has downloaded." })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "the list after a report downloaded");
  });
});
```

`axe-sweep.spec.ts` already scans `/hub/calendar` as each sweep user, so the report group is in its scan. The spec above scans the list after a download.

- [ ] **Step 2: See the spec fail once, then pass, then run the full suites**

The spec exercises Tasks 1–10's code, so it passes as written. To show it can fail, change the HQ Editor's expected keys `["A", "C"]` to `["A", "B", "C"]`. Run it and see that test FAIL on `toEqual`, which proves B is really absent from the HQ Editor's PDF. Then restore it.
Run: `npx -y -p node@24 -- npm run test:e2e -- tests/e2e/calendar-reports.spec.ts tests/e2e/calendar-list.spec.ts tests/e2e/axe-sweep.spec.ts`
Expected: PASS (7 report tests; the list and the sweep unchanged).
Run: `npx -y -p node@24 -- npm run test:e2e`
Expected: PASS, every spec.
Run the full Vitest suite: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run`. Then run both `tsc` commands.
Expected: PASS, no errors.

- [ ] **Step 3: The parity rows and the questions**

`docs/parity/changes-from-legacy.md`, in the "Corporate Calendar (Phase 5)" section, after the last row (C183):

```markdown
| C132 | Reports as RDLC through ReportViewer. The UI offered PDF; Word only by editing the URL (`&format=Word`). | Each report offered as PDF only, from the list's toolbar. Layouts, sections and filters as legacy. No Word export. | R6; Q48 (Paul, 2026-10-10: the Calendar team doesn't use Word). | Agreed (Q48; built in 5g) |
| C148 | The RLS code "Fact Sheet" never matched the lookup name "Factsheet" (`ActivityHandler.ashx.cs:1210`). | Matches both spellings. | Legacy data bug. | Agreed (built in 5g) |
| C184 | Each report was rendered inside the request (`ActivityHandler.ashx.cs`, `ProcessReport`) and streamed with no file name, however long it took and however many activities it held. | A report is prepared in the background, one at a time, in a worker thread with its own memory limit. The browser waits up to 5 seconds, then shows "Preparing your … report…" and checks every second, then saves `LookAhead.pdf`, `ExecLookAhead.pdf`, `30-60-90.pdf` or `PlanningReport.pdf`. The PDF is kept in memory for 10 minutes for the user who ran it, never on disk. At most 5,000 activities, 5,000 table rows and 366 Look Ahead days: more is refused with "narrow the filter". Four reports may wait, two per user; more is "try again in a few seconds". | One Node process serves every app on SiteGround: a long synchronous render would stop them all, and a held request could outlive the host's proxy timeout. | Proposed |
| C185 | The Look Ahead had a "Consultations and Dialogues" section (the consultations ministry's confirmed activities) and a legend swatch for it. | Not built. The Look Ahead has six sections, and the consultations ministry's activities appear in none of them; they stay in the 30/60/90 and Planning reports. The inference rule that keeps them Not on LA stays (spec addendum §7.6). | Dropped: unused for years, Paul 2026-10-07. | Agreed (Paul, 2026-10-07) |
| C186 | The Exec Look Ahead printed "Last updated updated 2 months ago", and "Other..." as the city of an activity whose city was typed in. A title's `**CONFIDENTIAL**` marker printed asterisks and all (`docs/parity/legacy-report-layouts.md`, discrepancies 5 and 8). | "Last updated 2 months ago" (or "today at …", "yesterday at …"); the typed city; the marker dropped from titles in every report. | Legacy display bugs. | Proposed |
| C187 | A report filtered on status Changed included deletions awaiting review, for HQ Administrators (`ActivityDAO.cs:176-193`). | No report includes a deleted activity, whatever the filter. | A deleted activity has no place in a printed plan; the list still shows deletions to review. | Proposed |
| C188 | Every HQ user's Look Ahead showed Executive Summaries in place of titles, HQ Read Only included, and every reader saw the NEW/CHANGED flags. | Executive Summaries and NEW/CHANGED appear only for those who see the Look Ahead fieldset (HQ Editors and above, or a ministry's editors on its own activities when ShowHqCommentsField is on). Everyone else sees the title and details. | The fieldset's rule (spec addendum §6), which the list (C177), the activity page and View changes already apply. | Proposed |
| C189 | The Look Ahead's cover was a photograph of the Parliament Buildings with a "Questions or Comments?" box (a phone number and mailbox), and later pages showed the BC logo. | A drawn banner with the tenant's cover lines, no contact box, and the province's name as text on later pages, all in BC Sans. | No cover image or contact text is configured (Q62); BC Sans is the platform's typeface. | Proposed (Q62) |
```

`docs/parity/open-questions.md`, in "## Open", after Q59:

```markdown
| Q62 | May the Look Ahead use legacy's **cover photograph** (`LookAheadCover.jpg`) and its **"Questions or Comments?" box**, and what should the box say? | The cover is the first thing readers see; the box gave a phone number and a mailbox. | A drawn banner with "BC GOVERNMENT / CORPORATE LOOK AHEAD" under "Government Communications and Public Engagement", and no box (C189). The tenant setting `lookAheadCoverImage` is there for an image. | 2026-10-10 |
| Q63 | The **Exec Look Ahead with no To date** runs its days for one month but starts its Long Term Outlook at 60 days, so activities starting in between appear in no section (`ActivityHandler.ashx.cs:640-661`). Keep it, or start the Outlook where the days end? | HQ Administrators may miss activities 31 to 60 days out. | Legacy's behaviour, until the 5i comparison or the team says otherwise. | 2026-10-10 |
```

In "## Answered", Q48's answer cell becomes:

```markdown
**Answered (2026-10-07):** similar layout is fine — same sections, order, columns, colours, headers and footers, and the same text; page breaks may fall differently. **Superseded (Paul, 2026-10-10):** no Word version at all; the Calendar team doesn't use Word today. Reports are PDF only (C132).
```

and its "Answered" column reads `2026-10-10`.

- [ ] **Step 4: The spec**

`docs/superpowers/specs/2026-10-07-calendar-parity-design.md`:
- **R6** (§2): "Look Ahead (all 7 sections)" becomes "Look Ahead (six sections: legacy's Consultations and Dialogues is dropped, Paul 2026-10-07)".
- **§3 row 5g's exit check** becomes "Golden structure from fixtures: the sections, headings and activity links read back from each report's PDF give legacy's order for each role. Every report built on boxs.ca."
- **§7.6 rule 2:** append "The section itself is dropped from the Look Ahead (C185); the rule stays, so those activities keep Not on LA."
- **§10's Output bullet** becomes: "**Output:** renders each report to PDF in the background (C184): `POST /calendar/api/reports/:report` with the list's query as `q` answers 201 when the PDF is ready within a short wait, else 202; `GET /calendar/api/reports/jobs/:id` polls; `GET /calendar/api/reports/jobs/:id/pdf` downloads. No Word version (Q48, Paul 2026-10-10: the Calendar team doesn't use Word today). pdfmake draws it in a worker thread (§10.1, Q57)."
- **§10.1:** after "The HTML templates stay the source either way.", add a bullet: "**Outcome (5g):** no HTML template. Builders write a renderer-neutral document that pdfmake draws in a worker thread; a browser renderer on a container host would draw the same document."
- **§10.2:**
  - In the Cover item, delete "Consultations and Dialogues `#daeef3`; ".
  - Item 4 becomes "4. ~~Consultations and Dialogues~~: dropped (C185)."
  - Item 6's "showing the title only" becomes "showing the title only (the Executive Summary for those who see it)".
  - In the RLS bullet, "Report → Report (In the News only)" becomes "Report → Report (Issues and Reports, and In the News)", and "Newsletter → e-news (In the News only)" becomes "Newsletter → e-news (Issues and Reports, and In the News)".
- **§16:**
  - The Reports test line becomes "**Reports:** golden structure per report from fixtures: the sections, headings and activity links read back from each PDF match legacy's rules."
  - Acceptance 10's "The Look Ahead has all 7 sections" becomes "The Look Ahead has its six sections".

- [ ] **Step 5: Running notes, deploy notes, carry-forward**

`docs/manuals/running-notes.md`, append:

```markdown
## Phase 5g — Reports

- **All Calendar users** — The list's toolbar has Look Ahead, 30/60/90 and Planning buttons after Excel export. Each makes a PDF of the activities the list's current filter finds, in date order, whatever the list is sorted by.
- **All Calendar users** — A report takes a few seconds. While it's being prepared the page says "Preparing your … report…" and the buttons wait; the PDF then downloads by itself. If you leave the page first, run it again.
- **All Calendar users** — A report holds only activities you can see. Other ministries' confidential activities, and deleted activities, are never in it.
- **All Calendar users** — "Too many activities match" or "Too many rows to print" means the filter is too wide for a PDF: narrow the dates or the filter. "Other reports are being prepared" means wait a few seconds and try again.
- **All Calendar users** — The Look Ahead has six sections; "Consultations and Dialogues" is gone. With no To date it covers 60 days and adds the Long Term Outlook.
- **All Calendar users** — Each activity number in a report links to the activity in the Hub.
- **HQ Editor and above** — Your Look Ahead shows each activity's Executive Summary, when it has one, and its NEW or CHANGED flag. Others see titles and details.
- **HQ Administrator** — Exec Look Ahead is yours alone. With no To date it covers one month.
- **Operations** — Reports render in a worker thread of the stack process, one at a time: `CALENDAR_REPORT_CONCURRENCY` (1), `CALENDAR_REPORT_HEAP_MB` (320), `CALENDAR_REPORT_TIMEOUT_SECONDS` (120), `CALENDAR_REPORT_INLINE_WAIT_MS` (5000). A finished PDF stays in memory for 10 minutes; a restart forgets it.
- **Developer** — `npm run calendar:report-compare -- --legacy <pdf> --new <pdf> --out <folder outside the repo>` compares two reports' sections and activity order (5i's parity check).
```

`docs/deploy/siteground.md`, after the "### Updates feed (Phase 5f)" section, before "## Troubleshooting":

```markdown
### Reports (Phase 5g)

**No migration.** The artifact now carries `report-worker.cjs` and `fonts/` beside `stack.js`; they deploy with it. Optional settings: `CALENDAR_REPORT_CONCURRENCY` (default 1), `CALENDAR_REPORT_HEAP_MB` (320), `CALENDAR_REPORT_TIMEOUT_SECONDS` (120), `CALENDAR_REPORT_INLINE_WAIT_MS` (5000). If the worker or the fonts are missing, the Calendar still starts, its report buttons say "Reports aren't available on this server right now", and `/stack/errors` shows "[calendar] reports are unavailable…".

**Hand checks on boxs.ca after deploy** (spec §3 row 5g, §16 acceptance 10):

1. As cal-editor: Hub → Calendar, filter a week with activities, click Look Ahead. The PDF downloads: Letter, BC Sans (the viewer's document properties list BCSans fonts), the cover, then "Inside Government". Each CC ID# opens the activity.
2. Click 30/60/90 (Letter) and Planning (Legal landscape).
3. As cal-hq-editor the toolbar has no Exec Look Ahead. As cal-hq-admin it does, and its rows end "Last updated …", said once.
4. As cal-hq-admin, run a Look Ahead with no To date (60 days). Note whether it arrived without a "Preparing…" pause, and how many seconds it took; record both here. While it renders, load `/site/` in another tab: it answers at once.
5. `/stack/errors` holds no "[calendar] a report failed" line. If it does, its label says which limit was hit: `ERR_WORKER_OUT_OF_MEMORY` (raise `CALENDAR_REPORT_HEAP_MB`) or `ERR_REPORT_TIMEOUT`.
```

`docs/superpowers/plans/phase-5-carry-forward.md`:
- Delete the whole "## 5g" section (every item is built or recorded in Tasks 1–11).
- Add to "## 5i":

```markdown
- **Report parity:** run `npm run calendar:report-compare` (scripts/calendar-report-compare.ts) on each past-period legacy PDF against ours for the same range and filter, with `--out` outside the repo. Settle there what the samples couldn't:
  - whether legacy's Awareness Dates rows carried "Last updated" in the Exec Look Ahead (discrepancy 6; legacy's code says no);
  - whether legacy showed In the News for a day with no rows (we skip such days);
  - where legacy broke pages around "Outside Government" and the Long Term Outlook;
  - Q63.
```

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/calendar-reports.spec.ts docs/parity/changes-from-legacy.md docs/parity/open-questions.md docs/manuals/running-notes.md docs/deploy/siteground.md docs/superpowers/specs/2026-10-07-calendar-parity-design.md docs/superpowers/plans/phase-5-carry-forward.md
git commit -m "test(e2e),docs: the reports as each role; parity C132, C148, C184-C189, Q62, Q63; spec, running and deploy notes"
```

---
## Phase 5g at a glance

| Task | Delivers | Exit evidence |
|---|---|---|
| 1 | Reference-day dates, report kinds and jobs, the tenant's report texts | `format.test.ts`, `reports.test.ts`, `calendar.test.ts` |
| 2 | What a report reads: the list's query and visibility, no default hides or deletions, legacy's order | `reports/data.test.ts` (every role; Look Ahead fields; 5,000 limit) |
| 3 | The document model, date stamps, row text, RLS, links | `reports/text.test.ts` |
| 4 | The Look Ahead and Exec Look Ahead | `reports/look-ahead.test.ts` (golden outlines per variant) |
| 5 | The 30/60/90 and Planning reports; `buildReport` | `reports/list-reports.test.ts` |
| 6 | pdfmake in a worker, BC Sans, the rendering seam | `render/layout.test.ts`, `render/renderer.test.ts` (sizes, running text, fonts, heap limit, timeout, main thread free) |
| 7 | Jobs and routes; the Exec gate | `http/report-routes.test.ts`, `start.test.ts`, `config-routes.test.ts` |
| 8 | Each PDF read back against legacy's rules; the 5i hook | `reports/golden.test.ts`, `tests/calendar-report-compare.test.ts` |
| 9 | The worker in both artifacts | `tests/build-report-worker.test.ts`; `npm run build:siteground` OK |
| 10 | The list's report buttons | `Reports.test.tsx`, `a11y.test.tsx` |
| 11 | End to end per role; docs | `calendar-reports.spec.ts`; full e2e green |

## Risks and things to watch

- **boxs.ca memory.** One render at a time peaked at 437 MB for the whole process at 4,800 rows (measured standalone). The stack's own baseline adds to that. Watch `/stack/errors` for `ERR_WORKER_OUT_OF_MEMORY` and SiteGround's account memory during the hand checks. Lowering `CALENDAR_REPORT_HEAP_MB` trades large reports for headroom.
- **SiteGround's idle stop** (30–60 s with no request) ends a render nobody is polling. The screen polls every second, so this happens only if the tab closes; the user re-runs it.
- **The proxy timeout is still unmeasured.** No request should hold for more than about 5 s plus the database read (G3). If boxs.ca ever shows a 502/504 on a start, lower `CALENDAR_REPORT_INLINE_WAIT_MS`.
- **Layout fidelity is by eye** (§12.3). Column widths, the zebra grey, the heading blue and where pages break are close to the samples, not pixel-matched. The 5i comparison checks structure and order.
- **pdfmake's `dontBreakRows`:** a single row taller than a page can't split. Rows here are bounded by legacy's column sizes (details 700, Executive Summary 2,000 characters), so one fits a page. If one ever doesn't, the render fails and the job says why.
- **unpdf joins a row's cells on one line in reading order.** The golden tests compare links and headings, not row text, so a cell that wraps differently doesn't fail them.
- **The worker is started with `--import tsx` in a source checkout** (Vitest, Playwright, `npm run dev`). That needs `tsx` resolvable from the working directory, which every repo script has.
- **Not checked here:**
  - Word and PDF/A (no Word: Q48);
  - screen readers inside the PDF (no tagged PDF; legacy's wasn't either);
  - a container host with Chromium (the seam is ready, no renderer is built);
  - the legacy-vs-new comparison on real data (5i).

## Self-review (done while writing)

1. **Spec coverage.**
   - §10 Input (filter and sort, `visible()`, legacy's order) → Task 2. Output → Tasks 6–7 (with C184's change). Links → Task 3. BC times → Tasks 1 and 3. Per request (no shared state) → Task 7 (each job its own document and worker).
   - §10.1 requirements (both page sizes, first-page header, Page X of Y, colours, breaks) → Task 6.
   - §10.2 → Task 4: range, title, running text, all six sections, selection, order within a day, page breaks, row text, flag, RLS, cover. The cover image is Q62 (G16).
   - §10.3 → Tasks 3 and 4. §10.4 and §10.5 → Task 5.
   - §6: the Exec gate → Task 7; `visible()` → Task 2; the Look Ahead fieldset → Tasks 2 and 3. Not visible is 404 → Task 7.
   - §8.1 toolbar → Task 10. §12.3 hook → Task 8.
   - §16 acceptance 2 (reports) → Tasks 2, 8 and 11; 10 → Tasks 4, 7, 8, 10 and 11; 18 → Task 10 and the e2e axe.
   - The carry-forward → the table above.
2. **Placeholder scan.** None. Every code step carries its code, every docs step its text. The one optional step (reading a legacy sample with the hook) names its exact command and needs nothing from the repo.
3. **Type consistency.**
   - `ReportRow`, `ReportData` and `ReportTooLargeError` (Task 2) are used unchanged in Tasks 3–8.
   - `ReportDoc` and its blocks (Task 3) are read by `outline` (Task 3's helper), `docDefinitionOf` (Task 6) and `rowCountOf` (Task 7).
   - `TextContext`, `LookAheadContext` and `ListReportContext` (Tasks 3–5) are built by `buildReport` (Task 5).
   - `PdfRenderer`, `ReportRenderError` (`reason`, `code`), `workerRenderer` and `reportAssets` (Task 6) are used by `ReportJobs` and `start.ts` (Task 7), the golden tests (Task 8) and the build test (Task 9).
   - `ReportJobView` and `REPORT_FILE_NAMES` (Task 1) are used by the routes (Task 7) and the screen (Task 10).
   - `pdfPages` (Task 6) is extended by `outlineOf` (Task 8), which the e2e spec (Task 11) and the hook use.
4. **Review Focus.** Each of the five has a named test in its owning task: 1 in Tasks 7 and 10, 2 in Tasks 2, 4, 6 and 7, 3 in Task 3, 4 in Tasks 7 and 11, 5 in Task 10.
5. **Dry run (2026-10-10, at `acccc09`).** Every code block above was applied to the worktree, run, and then reverted. Only this plan is committed.
   - Calendar report tests: 58 pass (data 13, text 11, Look Ahead 13, 30/60/90 and Planning 6, render 9, golden 6). Report routes 11, start and config pass.
   - `tests/build-report-worker.test.ts` 2 and `tests/calendar-report-compare.test.ts` 2 pass. `npm run build:siteground` ends OK with its `--check`.
   - `screens/calendar` 302 tests pass, with `Reports.test.tsx` 7 and the two new axe states.
   - The full Vitest suite passes (4,089 tests), as do both `tsc` runs.
   - `calendar-reports.spec.ts` 7, `calendar-list.spec.ts` and `axe-sweep.spec.ts` pass against the local stack.
   - The dry run caught three faults, fixed in the code above: `createRequire` colliding with the bundle's banner; a footer column too narrow for 30/60/90's stamp; two tests that expected a page's footer items on separate lines.
   - Not run in the dry run: the full e2e suite.

## Execution

Execution method: subagent-driven, as the 5e and 5f plans were. A fresh implementer and reviewer per task, then a whole-branch review. Tasks 1–5 are pure or read-only, with exact expectations. Tasks 6–9 carry the risk (worker, memory, bundling) and their tests are the evidence. Task 10 needs only Task 1's contract and Task 7's routes.
