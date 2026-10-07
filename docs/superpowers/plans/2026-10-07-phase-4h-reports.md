# Phase 4h: Staff Reports with CSV Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** NoD staff get the five spec §8 reports (active subscribers by list, recent unsubscribes, sends per release, daily digest runs, Distribution sent vs bounced), each on screen and as a CSV. Address-bearing CSVs are limited to NoD Editors and Admins (Q37).

**Architecture:**
- **NoD, `apps/nod/src/reports/`:** one module per report, plus two shared ones:
  - `csv.ts` streams an injection-safe UTF-8 CSV with a BOM, with backpressure.
  - `range.ts` turns BC calendar dates into UTC instants in Node.
  - Every query is bounded by a date window or a page and reads through an index.
- **NoD, `http/report-routes.ts`:** a router under `/nod/api/reports/*`.
  - Reads are open to `NoD.Viewer`/`NoD.Editor`/`NoD.Admin`. Address CSVs need `NoD.Editor`/`NoD.Admin`.
  - Errors go through `privateErrorsWith`, and every address export writes an `operations_log` row.
- **Distribution:** one new `POST /api/reports/daily` (`Distribution.Operate`). It counts sent, bounced and failed messages per day and per sending app, between day boundaries that NoD supplies. Distribution stays zone-free, and Postgres's tzdata is never used.
- **staff-web:** a Reports area under Subscribers (`/hub/subscribers/reports/*`), with an index and five screens. Filters (dates, list key, timing, page) live in the page URL. CSVs download through plain same-origin links.

**Tech Stack:** Node 24, TypeScript 5.9 strict, Express 5, Drizzle 0.45 / drizzle-kit 0.31, zod 3.25, Vitest 4.1, supertest, React 19 + react-router 7 (library mode), `@bcgov/design-system-react-components`, axe-core, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-05-nod-distribution-parity-design.md`:
- §8 "Reports, each with CSV export" (the five bullets) and the Roles bullets;
- §5.1/§5.4 (what a send is: as-it-happens, digest, media; one delivery row per item × subscriber × mode);
- §6 (Distribution messages, priorities, `Message-ID`);
- §7 (bounces: hard vs soft, matching);
- §10 acceptance item 14 (each role sees exactly its parts).

Executors read the spec alongside this plan.

**Base:**
- **Branch:** `feat/phase-4h`, cut from `feat/phase-4g` at `7d38c8f`.
- **Worktree:** `/Users/paul/gcpe-news-platform-4h`.
- **Line numbers:** every file:line reference below is against `7d38c8f`. Re-find by symbol if anything has moved.

**Legacy parity screens** (`~/HUB/Subscribe/Gcpe.NewsOnDemand.Website`). Every page has a `showReport`/`showcsv` query switch, a paged table and a `report.csv` with no BOM and no quoting.
- **`ActiveSubscribersReport.aspx.cs`:**
  - Shows all `IsEnabled` subscribers, sortable by email (default ascending), status, or date registered (default descending).
  - Count line: "N users are currently subscribed and active".
  - CSV: `email, status, datesubscribed`.
  - It is not per list.
- **`SubscriberListReport.aspx.cs`:** "N users were subscribed to <lists> from A to B". It rebuilds membership from `SysLog` subscribe/unsubscribe events by counting them, and is not ported (C99, Q41).
- **`AsItHappensReport.aspx.cs` / `DailyDigestReport.aspx.cs`:** despite their names, these are subscriber lists filtered by `ImmediateDelivery`/`DigestDelivery`, with an Active/Disabled/Deleted filter. They are not send reports. Their job moves to the timing filter on Active subscribers by list, and the status filter on the Subscribers search (C99).
- **`RecentUnsubscribersReport.aspx.cs`:**
  - Fixed 90 days from `DateTime.Today.AddDays(-90)`.
  - Built from `SysLog` `Unsubscribe` (104) rows, deduplicated per subscriber.
  - Shows current status and registered date. Count line: "N users were unsubscribed in the last 90 days".
- **`DistributionReport.aspx.cs`:**
  - Date-ranged counts of `SysLog` rows: Sent = `SentNewsOnDemandItemToDistribution` (21) + `SentDailyDigestItemToDistribution` (22); Bounced = `BouncedNewsOnDemandMessage` (12, hard and soft); Success = Sent − Bounced.
  - Bugs: the bounced count's start filter uses the end date (line 59), and the CSV builds the detail rows but never writes them (lines 87-102).
- **`SelfSubscriberReport`, `SubscribedEmailsReport`:** legacy defects, not ported (C57).

**Measured before planning** (scratch probe at legacy volume, Q21's Jul–Sep rates, 90 days):
- **Setup:** Apple M4 Pro, Homebrew PostgreSQL 14.17. The data was:
  - 3.78 M `deliveries`: 900 as-it-happens recipients × 20 releases a day; 200 media members × 10 releases a day; and 90 digest runs × 2,750 subscribers × 8 items.
  - 2.07 M Distribution `messages`.
- **Results:**

| Query | Cold | Warm |
|---|---|---|
| Per-release page (25 of 1,800 items) | 46 ms | 8 ms |
| Per-release, all of 90 days | 1,027 ms | 383 ms |
| Digest page (30 runs, with the two partial indexes in R13) | 127 ms | 8 ms |
| Distribution by day × app, 90 days (planner picks a parallel seq scan) | 261 ms | 220 ms |
| Distribution by day × app, 30 days (index-only scan) | 103 ms | 101 ms |

- These numbers set the budgets in Global Constraints. The probe tests in Tasks 3 and 4 re-measure them against the real schema.

## Global Constraints

- **Worktree and commits:**
  - Work in `/Users/paul/gcpe-news-platform-4h`, branch `feat/phase-4h`. Commit locally after each task.
  - Never add `Co-Authored-By` or any AI attribution (project rule). Never commit `CLAUDE.md`.
  - **Code comments never carry task, review-round or finding labels** ("Task 3", "fix round 1", "I2"…). Say *why*, not *when*.
- **Node 24 for everything:**
  - Tests: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run <paths>`.
  - Type-checks: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json` and `… -p apps/staff-web/tsconfig.json`.
  - E2E: `npx -y -p node@24 -- npm run test:e2e`.
  - Show each new test failing before implementing it (a real RED run).
  - Node 24's bundled tzdata is 2026b or later, which the range tests rely on.
- **Migrations:**
  - Generate with drizzle-kit: `cd apps/<app> && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name <name>`.
  - Never hand-edit generated DDL. Migrations must be additive and safe on boxs.ca's existing data.
  - Next free numbers at planning time: NoD `0023`, Distribution `0010`.
- **Clocks:** time comparisons in SQL use the DB clock (`now()`), never a JS `Date` against a DB timestamp. "Today" for a report is the BC date of the database's `now()` (`bcToday`, Task 1).
- **Time (BC):**
  - Day boundaries are computed in Node with `@gcpe/config`'s `wallClockToInstant` (`dayBounds`, Task 1) and passed to SQL as instants.
  - **SQL never uses `AT TIME ZONE` or `date_trunc` on a tenant zone.** The local test Postgres is 14.17, whose tzdata predates BC's permanent UTC−7 from 2026-11-01, and Distribution has no tenant config at all.
  - CSV times are `YYYY-MM-DD HH:mm` in BC time, and every such header says "(BC time)".
- **Privacy:**
  - **Email addresses and export contents never go in logs**: not in `console.*`, not in `operations_log.detail`, and not in an error that reaches `jsonErrorHandler`.
  - Every report route runs through `privateErrorsWith` (`http/private-errors.ts`).
  - **No report takes an address or a search term.** Report filters (`from`, `to`, `list`, `timing`, `page`) may travel in a query string. staff-web builds report URLs only through `reportUrl` (Task 5), which drops any other key.
  - `operations_log.detail` for an export names the report and list key, never an address.
- **Roles (spec §8; Q37, 4g R17):**
  - Every report, on screen and as JSON: `NoD.Viewer`/`NoD.Editor`/`NoD.Admin` (`NOD_READ_ROLES`).
  - **Address-bearing CSVs** (a list's members; recent unsubscribes with addresses): `NoD.Editor`/`NoD.Admin` (`NOD_WRITE_ROLES`).
  - Every other CSV is count-only and open to Viewers.
  - The server is the authority; staff-web hides what a role can't use.
  - Distribution's report route needs `Distribution.Operate`, which NoD's own service token already carries (`apps/nod/src/distribution-token.ts:77`). Don't widen it.
- **CSV:**
  - **Streamed:** written in batches of at most 1,000 rows, with backpressure (`drain`).
  - **Headers:** `Content-Type: text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="<report>-<YYYY-MM-DD>.csv"` (the BC date of the export), `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`.
  - **Encoding:** UTF-8 with a BOM (`EF BB BF`) so Excel reads it, CRLF line ends, RFC 4180 quoting.
  - **Formula injection:** a text cell starting with `=`, `+`, `-`, `@`, tab or CR gets a leading `'`. Numbers are written as numbers.
  - **Failures:** a failure after the first byte destroys the connection, so a partial file never looks complete. A failure before it is a JSON 500.
  - Never log export contents.
- **Queries:**
  - Every report query is bounded: a date range of at most 92 days (`MAX_RANGE_DAYS`), or Recent unsubscribes' fixed 90 days. Screens are paged.
  - Each query reads through an index. New indexes come from drizzle-kit (R13).
  - EXPLAIN tests pin index use on `deliveries`, `subscriber_history` and `messages`. A partial index's applicability is shown with `SET LOCAL enable_seqscan = off` inside a transaction. The planner's real choice at volume is shown by the probes.
- **Performance budgets** (legacy volume, 90 days of data, local Postgres; the probes assert them):

| Report | Screen (one page) | CSV / whole range |
|---|---|---|
| Active subscribers by list (20,000 subscribers) | 300 ms | 1,000 ms |
| Recent unsubscribes | 300 ms | 1,000 ms |
| Sends per release | 300 ms | 2,000 ms (90 days) |
| Daily digest runs | 300 ms | 1,000 ms |
| Distribution sent vs bounced | 1,000 ms (92 days), 500 ms (31 days) | same query |

- **Probes:** run only with `REPORT_PROBE=1`, because seeding takes about 35 s. They print their timings (numbers only), which Task 7 records.
- **Reports are read-only:** no locks, and no writes except the export audit row.
- **Staff-web patterns (unchanged from 4f/4g):**
  - Every JSON call goes through `apiFetch` (`apps/staff-web/src/api/client.ts`) with same-origin `/nod/api/...` paths.
  - CSVs are plain `<a href download>` links: a same-origin GET carries the session cookie, and GETs need no CSRF header.
  - Every screen calls `useDocumentTitle` with its static `h1` text.
  - Tests stub `fetch` (`apps/staff-web/test/jsonResponse.ts`). Each new screen is in an axe test (wcag2a/wcag2aa, serious/critical). Title assertions use `await waitFor(() => expect(document.title).toBe(...))`.
- **Copy:**
  - Timing: "As it happens", "Daily digest", "As it happens and daily digest", "None (media lists only)".
  - Sources: `self` "Signed up", `admin` "Added by staff", `media-hub` "Media Hub", `manual-media` "Added by hand".
  - Unsubscribe how: "Unsubscribed" / "Deleted by staff".
  - Statuses: "Pending", "Active", "Disabled", "Deleted".
  - Item types: `releases` "News release", `stories` "Story", `factsheets` "Factsheet", `updates` "Update", `advisories` "Media advisory", emergency "Emergency alert".
  - NoD's own Distribution app id shows as "News On Demand".

## Review Focus

1. **A CSV that fails part-way.** If the database errors after the BOM and header have gone out, the download must fail visibly (connection destroyed, `res.complete === false`), never end cleanly as a short file that looks whole. Before any byte, the caller gets a JSON 500. Pinned in Task 1 ("a failure part-way aborts the download", "a failure before the first byte is a JSON error").
2. **Hostile text in a cell.** A release title or an address starting with `=`, `+`, `-`, `@`, tab or CR is neutralised with a leading `'`. Commas, quotes and line breaks are quoted, so a title can't break the row structure. Pinned in Task 1 (`csvCell`, and the members export with `=1+2@example.test`) and Task 3 (a title of `=HYPERLINK("http://x","y")` in the per-release CSV).
3. **A range that crosses 2026-11-01.** BC stops changing clocks: midnight is 07:00Z on both sides. A message sent at 23:30 BC on Oct 31 counts on Oct 31, and the CSV shows BC times. Pinned in Task 1 (`dayBounds` across Nov 1 and across the March DST start) and Task 4 (Distribution bucketing of `2026-11-01T06:30Z`).
4. **A Viewer typing an address-CSV URL by hand.** The server returns 403 and nothing streams; the screen never shows the link. Pinned in Task 1 (members CSV), Task 2 (unsubscribes CSV), Task 5 (links hidden for a Viewer) and Task 7 (e2e).
5. **Distribution down while staff open its report.** The Distribution report shows "Distribution is unavailable right now…"; the NoD reports still work; the route returns 502 and logs only an error label, never Distribution's response body. Pinned in Task 4 ("Distribution down") and Task 6 ("Distribution unavailable").

---

## File structure

| File | Responsibility |
|---|---|
| `apps/nod/src/reports/csv.ts` | `csvCell`, `csvLine`, `csvFilename`, `streamCsv`, `oneBatch`, `mapBatches` |
| `apps/nod/src/reports/range.ts` | BC dates → instants (`dayBounds`), `resolveRange`, `bcToday`, `localDate`, `localDateTime` |
| `apps/nod/src/reports/by-list.ts` | Active subscribers by list: counts, members page, member batches, CSV rows |
| `apps/nod/src/reports/unsubscribes.ts` | Recent unsubscribes: window, page, batches, daily counts |
| `apps/nod/src/reports/release-sends.ts` | Sends per release (as-it-happens and media) |
| `apps/nod/src/reports/digest-runs.ts` | Daily digest runs |
| `apps/nod/src/reports/distribution.ts` | Shapes Distribution's daily counts for NoD (labels, totals, CSV rows) |
| `apps/nod/src/reports/volume.probe.test.ts` | Opt-in legacy-volume probe for every NoD report |
| `apps/nod/src/http/report-routes.ts` | `/reports/*` routes, roles, export audit row |
| `apps/nod/src/http/routes.ts`, `apps/nod/src/app.ts` | Mount the router; `SettingsRouteDeps.nodAppId`; `dailyReport` on the Distribution deps |
| `apps/nod/src/digest.ts` | `digestJobKeyPrefix`, `DIGEST_JOB_PREFIX_LENGTH` (used by the digest job and the report) |
| `apps/nod/src/settings.ts` | `OperationsAction` gains `report-exported` |
| `apps/nod/src/distribution-client.ts` | `dailyReport(bounds)` |
| `apps/nod/src/db/schema.ts` + migrations `0023`, `0024` | `subscriber_history (action, at)`; two partial `deliveries (job_id)` indexes |
| `apps/distribution/src/reports.ts` (+ `reports.probe.test.ts`) | Daily counts by app between given boundaries |
| `apps/distribution/src/http/routes.ts` | `POST /reports/daily` |
| `apps/distribution/src/db/schema.ts` + migration `0010` | `messages` sent-at and failed partial indexes |
| `apps/staff-web/src/screens/subscribers/reports/*` | Types, URL/params/report hooks, `RangeForm`, `CsvLink`, format and error helpers, six screens |
| `apps/staff-web/test/reportFixtures.tsx` | Report fixtures, `stubReports`, `renderAt` |
| `apps/staff-web/src/router.tsx`, `SubscribersSection.tsx` | Routes and the "Reports" nav link |
| `tests/e2e/reports.spec.ts` | 4h end to end |
| `docs/parity/*`, `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`, `docs/superpowers/plans/phase-4-carry-forward.md` | Docs |

---

### Task 1: Report foundations and Active subscribers by list (NoD)

Covers spec §8's "active subscribers by list", with its CSVs, and the shared CSV, range and route pieces every later task uses.

**Files:**
- Create:
  - `apps/nod/src/reports/csv.ts` (+ `csv.test.ts`);
  - `apps/nod/src/reports/range.ts` (+ `range.test.ts`);
  - `apps/nod/src/reports/by-list.ts` (+ `by-list.test.ts`);
  - `apps/nod/src/http/report-routes.ts` (+ `report-routes.test.ts`).
- Modify:
  - `apps/nod/src/http/routes.ts` (mount `reportRoutes` beside the other staff routers at :169-172);
  - `apps/nod/src/settings.ts:8-19` (`OperationsAction` gains `"report-exported"`).

**Interfaces:**
- Consumes:
  - `staffListsView(db)` (`staff-lists.ts`);
  - `NOD_READ_ROLES`, `NOD_WRITE_ROLES` (`http/staff-subscriber-routes.ts`);
  - `privateErrorsWith` (`http/private-errors.ts`);
  - `writeOpsLog` (`settings.ts`);
  - `wallClockToInstant` (`@gcpe/config`);
  - `staffAuth()` (`apps/nod/test/staff-auth.ts`), `createNodTestDb()` (`apps/nod/test/helpers.ts`);
  - `SettingsRouteDeps` (`http/routes.ts`).
- Produces, in `reports/csv.ts`:
  - `type CsvCell = string | number | null | undefined`;
  - `CSV_BOM`;
  - `csvCell(v): string`, `csvLine(cells): string`;
  - `csvFilename(report, today): string`;
  - `streamCsv(res, filename, header, batches: AsyncIterable<CsvCell[][]>): Promise<number>`;
  - `oneBatch(rows)`, `mapBatches(batches, toRow)`.
- Produces, in `reports/range.ts`:
  - `MAX_RANGE_DAYS = 92`, `DEFAULT_RANGE_DAYS = 30`;
  - `ReportRangeError` (`code: "invalid-date" | "range-reversed" | "range-too-long"`);
  - `addDays`, `dayBounds(from, days, tz): Date[]`;
  - `localDate`, `localDateTime`;
  - `bcToday(db, tz)`;
  - `resolveRange(input, today, tz): ReportRange`, where `ReportRange` is `{ from; to; days; bounds; start; end }`.
- Produces, in `reports/by-list.ts`:
  - `ALL_SUBSCRIBERS = "all"`, `ALL_NEWS = "*"`;
  - `TIMING_FILTERS`, `TimingFilter`;
  - `MEMBERS_PAGE_SIZE = 50`;
  - `ReportListNotFoundError`;
  - `subscribersByList(db)`, `listLabel(db, list)`, `membersPage(db, q)`, `memberBatches(db, list, timing, batchSize?)`;
  - `BY_LIST_CSV_HEADER`, `byListCsvRows(report)`, `MEMBER_CSV_HEADER`, `memberCsvRow(m, tz)`;
  - `timingText`, `sourceText`.
- Produces, in `http/report-routes.ts`:
  - `type ReportRouteDeps = Pick<SettingsRouteDeps, "timeZone">` (Task 4 widens it);
  - `reportRoutes(db, deps): Router`.
- Routes (under `/nod/api`):

  | Route | Role |
  |---|---|
  | `GET /reports/subscribers-by-list` | read |
  | `GET /reports/subscribers-by-list.csv` (counts) | read |
  | `GET /reports/subscribers-by-list/members?list=&timing=&page=` | read |
  | `GET /reports/subscribers-by-list/members.csv?list=&timing=` | Editor/Admin |

- [ ] **Step 1: Write the failing tests**

`apps/nod/src/reports/csv.test.ts`:

```ts
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it } from "vitest";
import { CSV_BOM, csvCell, csvFilename, csvLine, oneBatch, streamCsv, type CsvCell } from "./csv";

interface Raw {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /** False when the connection ended before the response did (a destroyed stream). */
  complete: boolean;
}

/** Serves one handler on a real socket, so a destroyed response is observable as an incomplete one. */
function serve(handler: express.RequestHandler): Promise<Raw> {
  const app = express();
  app.get("/x", handler);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      const req = http.get({ port, path: "/x" }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", () => undefined);
        res.on("close", () => {
          server.close();
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), complete: res.complete });
        });
      });
      req.on("error", (e) => {
        server.close();
        reject(e);
      });
    });
  });
}

describe("csvCell", () => {
  it("neutralises cells a spreadsheet would run as a formula", () => {
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tcmd")).toBe("'\tcmd");
    expect(csvCell("\rcmd")).toBe(`"'\rcmd"`);
  });

  it("quotes commas, quotes, line breaks and edge spaces; leaves plain text and numbers alone", () => {
    expect(csvCell("Health, Ministry of")).toBe(`"Health, Ministry of"`);
    expect(csvCell('Say "hi"')).toBe(`"Say ""hi"""`);
    expect(csvCell("two\nlines")).toBe(`"two\nlines"`);
    expect(csvCell(" padded ")).toBe(`" padded "`);
    expect(csvCell("pat@example.test")).toBe("pat@example.test");
    expect(csvCell(42)).toBe("42");
    expect(csvCell(-3)).toBe("-3");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("joins a line with CRLF", () => {
    expect(csvLine(["a", 1, null])).toBe("a,1,\r\n");
  });

  it("names files <report>-<date>.csv and refuses anything else", () => {
    expect(csvFilename("release-sends", "2026-10-07")).toBe("release-sends-2026-10-07.csv");
    expect(() => csvFilename('x"; evil', "2026-10-07")).toThrow();
  });
});

describe("streamCsv", () => {
  it("streams a UTF-8 BOM, the header and CRLF rows as an attachment", async () => {
    const r = await serve(async (_req, res) => {
      await streamCsv(res, "test-2026-10-07.csv", ["Email", "Count"], oneBatch([["pat@example.test", 2], ["=1+1", 3]]));
    });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(r.headers["content-disposition"]).toBe('attachment; filename="test-2026-10-07.csv"');
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect([...r.body.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(r.body.toString("utf8")).toBe(`${CSV_BOM}Email,Count\r\npat@example.test,2\r\n'=1+1,3\r\n`);
    expect(r.complete).toBe(true);
  });

  it("writes every row of many batches, in order", async () => {
    async function* batches(): AsyncGenerator<CsvCell[][]> {
      for (let b = 0; b < 10; b++) yield Array.from({ length: 1000 }, (_, i) => [`row-${b * 1000 + i}`]);
    }
    const r = await serve(async (_req, res) => {
      await streamCsv(res, "many-2026-10-07.csv", ["Row"], batches());
    });
    const lines = r.body.toString("utf8").split("\r\n");
    expect(lines).toHaveLength(10_002); // header + 10,000 rows + the empty string after the last CRLF
    expect(lines[1]).toBe("row-0");
    expect(lines[10_000]).toBe("row-9999");
  });

  it("a failure part-way aborts the download instead of ending it cleanly", async () => {
    async function* failing(): AsyncGenerator<CsvCell[][]> {
      yield [["first@example.test"]];
      await new Promise((r) => setTimeout(r, 50)); // let the header reach the client first
      throw new Error("boom");
    }
    const r = await serve(async (_req, res) => {
      await streamCsv(res, "t-2026-10-07.csv", ["Email"], failing()).catch(() => undefined);
    });
    expect(r.status).toBe(200);
    expect(r.complete).toBe(false);
  });

  it("a failure before the first byte is a JSON error, with no CSV headers", async () => {
    async function* failsAtOnce(): AsyncGenerator<CsvCell[][]> {
      throw new Error("boom");
    }
    const r = await serve(async (_req, res) => {
      await streamCsv(res, "t-2026-10-07.csv", ["Email"], failsAtOnce()).catch(() => void res.status(500).json({ error: "internal error" }));
    });
    expect(r.status).toBe(500);
    expect(r.headers["content-type"]).toMatch(/^application\/json/);
    expect(r.headers["content-disposition"]).toBeUndefined();
  });
});
```

`apps/nod/src/reports/range.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { addDays, dayBounds, localDate, localDateTime, MAX_RANGE_DAYS, ReportRangeError, resolveRange } from "./range";

const BC = "America/Vancouver";
const iso = (ds: Date[]) => ds.map((d) => d.toISOString());

describe("dayBounds", () => {
  it("keeps BC midnight at 07:00Z across 2026-11-01 (BC stays on UTC−7; needs tzdata 2026b+)", () => {
    expect(iso(dayBounds("2026-10-31", 3, BC))).toEqual([
      "2026-10-31T07:00:00.000Z",
      "2026-11-01T07:00:00.000Z",
      "2026-11-02T07:00:00.000Z",
      "2026-11-03T07:00:00.000Z",
    ]);
  });

  it("moves BC midnight from 08:00Z to 07:00Z across the March 2026 clock change", () => {
    expect(iso(dayBounds("2026-03-07", 2, BC))).toEqual(["2026-03-07T08:00:00.000Z", "2026-03-08T08:00:00.000Z", "2026-03-09T07:00:00.000Z"]);
  });
});

describe("local formatting", () => {
  it("formats instants as BC dates and times", () => {
    expect(localDate(new Date("2026-11-01T06:30:00Z"), BC)).toBe("2026-10-31");
    expect(localDateTime(new Date("2026-11-15T20:05:00Z"), BC)).toBe("2026-11-15 13:05");
    expect(localDateTime(new Date("2026-07-01T07:00:00Z"), BC)).toBe("2026-07-01 00:00");
  });
});

describe("resolveRange", () => {
  it("defaults to the 30 days ending today", () => {
    const r = resolveRange({}, "2026-10-07", BC);
    expect(r).toMatchObject({ from: "2026-09-08", to: "2026-10-07", days: 30 });
    expect(r.start.toISOString()).toBe("2026-09-08T07:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-10-08T07:00:00.000Z");
    expect(r.bounds).toHaveLength(31);
  });

  it("accepts a range up to the maximum and refuses one day more", () => {
    expect(resolveRange({ from: "2026-01-01", to: addDays("2026-01-01", MAX_RANGE_DAYS - 1) }, "2026-10-07", BC).days).toBe(92);
    expect(() => resolveRange({ from: "2026-01-01", to: addDays("2026-01-01", MAX_RANGE_DAYS) }, "2026-10-07", BC)).toThrow(
      expect.objectContaining({ code: "range-too-long" }),
    );
  });

  it("refuses reversed ranges and dates that don't exist", () => {
    expect(() => resolveRange({ from: "2026-10-07", to: "2026-10-06" }, "2026-10-07", BC)).toThrow(expect.objectContaining({ code: "range-reversed" }));
    expect(() => resolveRange({ from: "2026-02-30" }, "2026-10-07", BC)).toThrow(ReportRangeError);
    expect(() => resolveRange({ to: "07/10/2026" }, "2026-10-07", BC)).toThrow(expect.objectContaining({ code: "invalid-date" }));
  });
});
```

`apps/nod/src/reports/by-list.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../../test/helpers";
import { lists, subscribers, subscriptions } from "../db/schema";
import { memberBatches, membersPage, ReportListNotFoundError, subscribersByList } from "./by-list";

describe("active subscribers by list", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    await tdb.db.insert(lists).values([
      { listKey: "ministries:health", category: "ministries", key: "health", name: "Health" },
      { listKey: "ministries:finance", category: "ministries", key: "finance", name: "Finance" },
    ]);
    const [a, b, c, d] = await tdb.db
      .insert(subscribers)
      .values([
        { email: "alex@example.test", status: "active", asItHappens: true, digest: false },
        { email: "Blake@example.test", status: "active", asItHappens: false, digest: true },
        { email: "casey@example.test", status: "disabled", asItHappens: true, digest: false },
        { email: "dana@example.test", status: "active", asItHappens: true, digest: true },
      ])
      .returning({ id: subscribers.id });
    await tdb.db.insert(subscriptions).values([
      { subscriberId: a!.id, listKey: "ministries:health" },
      { subscriberId: b!.id, listKey: "ministries:health" },
      { subscriberId: b!.id, listKey: "ministries:finance" },
      { subscriberId: c!.id, listKey: "ministries:health" },
      { subscriberId: d!.id, listKey: "*" },
    ]);
  });
  afterAll(async () => tdb.drop());

  it("counts active subscribers per list, split by timing, with All news and everyone", async () => {
    const r = await subscribersByList(tdb.db);
    expect(r.all).toEqual({ subscribers: 3, asItHappens: 2, digest: 2 });
    expect(r.allNews).toEqual({ subscribers: 1, asItHappens: 1, digest: 1 });
    const ministries = r.categories.find((c) => c.key === "ministries")!;
    expect(ministries.lists.find((l) => l.listKey === "ministries:health")).toMatchObject({ name: "Health", subscribers: 2, asItHappens: 1, digest: 1 });
    expect(ministries.lists.find((l) => l.listKey === "ministries:finance")).toMatchObject({ subscribers: 1, asItHappens: 0, digest: 1 });
  });

  it("pages a list's active members by address, case-insensitively, filtered by timing", async () => {
    const health = await membersPage(tdb.db, { list: "ministries:health", timing: "any", page: 1 });
    expect(health).toMatchObject({ list: "ministries:health", listName: "Health", total: 2, page: 1, pageSize: 50 });
    expect(health.items.map((m) => m.email)).toEqual(["alex@example.test", "Blake@example.test"]);
    expect((await membersPage(tdb.db, { list: "ministries:health", timing: "digest", page: 1 })).items.map((m) => m.email)).toEqual(["Blake@example.test"]);
    expect((await membersPage(tdb.db, { list: "all", timing: "any", page: 1 })).items.map((m) => m.email)).toEqual([
      "alex@example.test",
      "Blake@example.test",
      "dana@example.test",
    ]);
    expect((await membersPage(tdb.db, { list: "*", timing: "any", page: 1 })).listName).toBe("All news");
  });

  it("refuses a list that doesn't exist", async () => {
    await expect(membersPage(tdb.db, { list: "ministries:nope", timing: "any", page: 1 })).rejects.toBeInstanceOf(ReportListNotFoundError);
  });

  it("yields members in keyset batches, in the same order as the page", async () => {
    const seen: string[][] = [];
    for await (const batch of memberBatches(tdb.db, "all", "any", 2)) seen.push(batch.map((m) => m.email));
    expect(seen).toEqual([["alex@example.test", "Blake@example.test"], ["dana@example.test"]]);
  });
});
```

`apps/nod/src/http/report-routes.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../../test/helpers";
import { staffAuth } from "../../test/staff-auth";
import { createApp } from "../app";
import { lists, operationsLog, subscribers, subscriptions } from "../db/schema";
import type { DistributionClient } from "../distribution-client";

/** A GET whose body stays raw bytes, so a test sees the BOM exactly as sent. */
function getCsv(app: ReturnType<typeof createApp>, path: string, token: string) {
  return request(app)
    .get(path)
    .set("authorization", `Bearer ${token}`)
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
}

describe("report routes", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let viewer: string, editor: string, outsider: string;
  const distribution = {
    send: vi.fn(),
    getSettings: vi.fn(),
    setPaused: vi.fn(),
    uploadBounce: vi.fn(),
    bounceStats: vi.fn(),
    bounceSource: vi.fn(),
    dailyReport: vi.fn(),
  } as unknown as DistributionClient;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    const { auth, token } = await staffAuth();
    viewer = await token(["NoD.Viewer"], "Vic Viewer");
    editor = await token(["NoD.Editor"], "Eddie Editor");
    outsider = await token(["NRMS.Editor"]);
    app = createApp({
      db: tdb.db,
      auth,
      eventSecrets: { nrms: "nrms-secret", core: "core-secret" },
      render: { siteUrl: "https://news.example", bannerUrl: null },
      distribution,
      timeZone: "America/Vancouver",
    });
    await tdb.db.insert(lists).values([{ listKey: "ministries:health", category: "ministries", key: "health", name: "Health" }]);
    const [pat, formula] = await tdb.db
      .insert(subscribers)
      .values([
        { email: "pat@example.test", status: "active", asItHappens: true, digest: false },
        { email: "=1+2@example.test", status: "active", asItHappens: false, digest: true },
      ])
      .returning({ id: subscribers.id });
    await tdb.db.insert(subscriptions).values([
      { subscriberId: pat!.id, listKey: "ministries:health" },
      { subscriberId: formula!.id, listKey: "ministries:health" },
    ]);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => tdb.drop());

  it("reports are for NoD roles only", async () => {
    expect((await request(app).get("/api/reports/subscribers-by-list").set("authorization", `Bearer ${outsider}`)).status).toBe(403);
  });

  it("a Viewer reads counts by list and exports them", async () => {
    const res = await request(app).get("/api/reports/subscribers-by-list").set("authorization", `Bearer ${viewer}`);
    expect(res.status).toBe(200);
    const health = res.body.categories.find((c: { key: string }) => c.key === "ministries").lists[0];
    expect(health).toMatchObject({ listKey: "ministries:health", subscribers: 2, asItHappens: 1, digest: 1 });

    const csv = await getCsv(app, "/api/reports/subscribers-by-list.csv", viewer);
    expect(csv.status).toBe(200);
    expect(csv.headers["content-disposition"]).toMatch(/^attachment; filename="subscribers-by-list-\d{4}-\d{2}-\d{2}\.csv"$/);
    const text = (csv.body as Buffer).toString("utf8");
    expect(text.startsWith("﻿Category,List,Subscribers,As it happens,Daily digest\r\n")).toBe(true);
    expect(text).toContain("Ministries,Health,2,1,1\r\n");
    expect(text).not.toContain("@");
  });

  it("a Viewer can't export addresses, even by URL", async () => {
    const res = await getCsv(app, "/api/reports/subscribers-by-list/members.csv?list=ministries%3Ahealth", viewer);
    expect(res.status).toBe(403);
  });

  it("an Editor exports a list's members with neutralised cells, and the export is logged without addresses", async () => {
    const res = await getCsv(app, "/api/reports/subscribers-by-list/members.csv?list=ministries%3Ahealth", editor);
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="subscribers-ministries-health-\d{4}-\d{2}-\d{2}\.csv"$/);
    const lines = (res.body as Buffer).toString("utf8").split("\r\n");
    expect(lines[0]).toBe("﻿Email,Timing,Source,Registered (BC time)");
    expect(lines[1]).toMatch(/^'=1\+2@example\.test,Daily digest,Signed up,\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(lines[2]).toMatch(/^pat@example\.test,As it happens,Signed up,/);
    const [log] = await tdb.db.select().from(operationsLog).where(eq(operationsLog.action, "report-exported"));
    expect(log).toMatchObject({ actor: "Eddie Editor", detail: "subscribers ministries:health any" });
    expect(log!.detail).not.toContain("@");
  });

  it("an unknown list is a 404 before any CSV starts", async () => {
    const res = await request(app).get("/api/reports/subscribers-by-list/members.csv?list=ministries%3Anope").set("authorization", `Bearer ${editor}`);
    expect(res.status).toBe(404);
    expect(res.headers["content-disposition"]).toBeUndefined();
  });

  it("nothing about an export reaches the logs", async () => {
    const spies = (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    await getCsv(app, "/api/reports/subscribers-by-list/members.csv?list=all", editor);
    await request(app).get("/api/reports/subscribers-by-list/members?list=all").set("authorization", `Bearer ${viewer}`);
    const logged = spies.flatMap((s) => s.mock.calls.flat()).map(String).join("\n");
    expect(logged).not.toContain("pat@example.test");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/reports apps/nod/src/http/report-routes.test.ts`
Expected: FAIL. The modules don't exist ("Failed to load url ./csv" and similar), and the routes return 404.

- [ ] **Step 3: Implement `reports/csv.ts`**

```ts
/**
 * Report CSVs: UTF-8 with a BOM (Excel reads anything else as the local code page), CRLF and
 * RFC 4180 quoting, streamed in batches with backpressure. A text cell a spreadsheet would run as
 * a formula gets a leading apostrophe (OWASP "CSV injection"): release titles and addresses are
 * typed by people outside staff's control.
 */
import type { Response } from "express";

export type CsvCell = string | number | null | undefined;
export const CSV_BOM = "﻿";

const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;
/** Flushes to the socket once this much is buffered: fewer, larger writes. */
const FLUSH_AT = 64 * 1024;

export function csvCell(v: CsvCell): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  let s = FORMULA_START.test(v) ? `'${v}` : v;
  if (NEEDS_QUOTES.test(s) || s !== s.trim()) s = `"${s.replaceAll('"', '""')}"`;
  return s;
}

export function csvLine(cells: CsvCell[]): string {
  return `${cells.map(csvCell).join(",")}\r\n`;
}

/** `<report>-<YYYY-MM-DD>.csv`; report names are ours, never user input, and stay header-safe. */
export function csvFilename(report: string, today: string): string {
  if (!/^[a-z0-9-]+$/.test(report) || !/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error("invalid CSV filename");
  return `${report}-${today}.csv`;
}

export async function* oneBatch(rows: CsvCell[][]): AsyncGenerator<CsvCell[][]> {
  yield rows;
}

export async function* mapBatches<T>(batches: AsyncIterable<T[]>, toRow: (t: T) => CsvCell[]): AsyncGenerator<CsvCell[][]> {
  for await (const batch of batches) yield batch.map(toRow);
}

class ClientGoneError extends Error {
  constructor() {
    super("client went away");
    this.name = "ClientGoneError";
  }
}

async function write(res: Response, chunk: string): Promise<void> {
  if (res.destroyed) throw new ClientGoneError();
  if (res.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new ClientGoneError());
    };
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
    };
    res.on("drain", onDrain);
    res.on("close", onClose);
  });
}

/**
 * Streams `batches` as a CSV attachment and returns how many rows went out. The first batch is
 * fetched before anything is sent, so a query that fails at once still gets the caller's JSON
 * error. After the first byte, a failure destroys the connection: the browser shows a failed
 * download, never a short file that looks whole. Rows are never logged.
 */
export async function streamCsv(res: Response, filename: string, header: string[], batches: AsyncIterable<CsvCell[][]>): Promise<number> {
  const it = batches[Symbol.asyncIterator]();
  let next = await it.next();
  res.status(200);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  let count = 0;
  try {
    // The header goes out at once: from here on, any failure is visible to the browser as an
    // aborted download.
    await write(res, CSV_BOM + csvLine(header));
    let buffer = "";
    while (!next.done) {
      for (const row of next.value) {
        buffer += csvLine(row);
        count++;
        if (buffer.length >= FLUSH_AT) {
          await write(res, buffer);
          buffer = "";
        }
      }
      next = await it.next();
    }
    await write(res, buffer);
    res.end();
    return count;
  } catch (e) {
    res.destroy();
    throw e;
  }
}
```

- [ ] **Step 4: Implement `reports/range.ts`**

```ts
/**
 * Report date ranges in BC calendar days. Boundaries are computed here, from the runtime's own
 * tzdata (Node 24: 2026b+, which knows BC stays on UTC−7 from 2026-11-01), and handed to SQL as
 * instants. SQL never converts zones itself: Postgres's tzdata can lag (local 14.17 does), and
 * Distribution has no tenant zone at all.
 */
import { sql } from "drizzle-orm";
import { wallClockToInstant } from "@gcpe/config";
import type { DbOrTx } from "@gcpe/db-kit";

/** A calendar quarter; at legacy volume (Q21) that's about 2 M delivery rows per report. */
export const MAX_RANGE_DAYS = 92;
export const DEFAULT_RANGE_DAYS = 30;

export type RangeErrorCode = "invalid-date" | "range-reversed" | "range-too-long";
export class ReportRangeError extends Error {
  constructor(readonly code: RangeErrorCode) {
    super(code);
    this.name = "ReportRangeError";
  }
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(date: string): { y: number; m: number; d: number } {
  const match = ISO_DATE.exec(date);
  if (!match) throw new ReportRangeError("invalid-date");
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) throw new ReportRangeError("invalid-date");
  return { y, m, d };
}

/** `date` plus `n` calendar days; plain date arithmetic, no zone involved. */
export function addDays(date: string, n: number): string {
  const { y, m, d } = parts(date);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const a = parts(from);
  const b = parts(to);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
}

/** Midnight (in `timeZone`) at the start of each of `days` days from `from`, plus the midnight that
 * closes the last one: `days + 1` instants. Day i is [bounds[i], bounds[i + 1]). */
export function dayBounds(from: string, days: number, timeZone: string): Date[] {
  const { y, m, d } = parts(from);
  return Array.from({ length: days + 1 }, (_, i) => wallClockToInstant(new Date(Date.UTC(y, m - 1, d + i)), timeZone));
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function zoned(instant: Date, timeZone: string): Record<string, string> {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formatters.set(timeZone, f);
  }
  return Object.fromEntries(f.formatToParts(instant).map((p) => [p.type, p.value]));
}

/** The tenant-local calendar date of `instant`: "YYYY-MM-DD". */
export function localDate(instant: Date, timeZone: string): string {
  const p = zoned(instant, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** The tenant-local "YYYY-MM-DD HH:mm" of `instant`, as CSVs show times. */
export function localDateTime(instant: Date, timeZone: string): string {
  const p = zoned(instant, timeZone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** Today's BC date by the database clock (raw `execute` returns timestamptz as text). */
export async function bcToday(db: DbOrTx, timeZone: string): Promise<string> {
  const { rows } = await db.execute<{ now: string }>(sql`SELECT now() AS now`);
  return localDate(new Date(rows[0]!.now), timeZone);
}

export interface ReportRange {
  from: string;
  to: string;
  days: number;
  bounds: Date[];
  start: Date;
  end: Date;
}

/** `from`..`to` inclusive (BC dates). Missing `to` is today; missing `from` makes a 30-day range. */
export function resolveRange(input: { from?: string; to?: string }, today: string, timeZone: string): ReportRange {
  const to = input.to ?? today;
  const from = input.from ?? addDays(to, -(DEFAULT_RANGE_DAYS - 1));
  const days = daysBetween(from, to) + 1;
  if (days < 1) throw new ReportRangeError("range-reversed");
  if (days > MAX_RANGE_DAYS) throw new ReportRangeError("range-too-long");
  const bounds = dayBounds(from, days, timeZone);
  return { from, to, days, bounds, start: bounds[0]!, end: bounds[days]! };
}
```

- [ ] **Step 5: Implement `reports/by-list.ts`**

```ts
/**
 * Active subscribers by list (spec §8): a snapshot of who receives each list now. It replaces
 * legacy's ActiveSubscribers (everyone), AsItHappens and DailyDigest (by timing) and
 * SubscriberListReport (per list); see C99.
 */
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import { lists, subscribers, subscriptions, type SubscriberSource } from "../db/schema";
import { staffListsView } from "../staff-lists";
import { localDateTime } from "./range";
import type { CsvCell } from "./csv";

export const ALL_SUBSCRIBERS = "all";
export const ALL_NEWS = "*";
export const TIMING_FILTERS = ["any", "as-it-happens", "digest"] as const;
export type TimingFilter = (typeof TIMING_FILTERS)[number];
export const MEMBERS_PAGE_SIZE = 50;

export class ReportListNotFoundError extends Error {
  constructor() {
    super("not found");
    this.name = "ReportListNotFoundError";
  }
}

export interface TimingCounts {
  subscribers: number;
  asItHappens: number;
  digest: number;
}
export interface ByListList extends TimingCounts {
  listKey: string;
  name: string;
  active: boolean;
}
export interface ByListCategory {
  key: string;
  name: string;
  lists: ByListList[];
}
export interface SubscribersByListReport {
  all: TimingCounts;
  allNews: TimingCounts;
  categories: ByListCategory[];
}
export interface ReportMember {
  id: string;
  email: string;
  asItHappens: boolean;
  digest: boolean;
  source: SubscriberSource;
  createdAt: string;
}
export interface MembersPage {
  list: string;
  listName: string;
  timing: TimingFilter;
  total: number;
  page: number;
  pageSize: number;
  items: ReportMember[];
}

const ZERO: TimingCounts = { subscribers: 0, asItHappens: 0, digest: 0 };

export async function subscribersByList(db: DbOrTx): Promise<SubscribersByListReport> {
  const view = await staffListsView(db);
  const { rows } = await db.execute<{ list_key: string; subscribers: number; as_it_happens: number; digest: number }>(sql`
    SELECT sub.list_key, count(*)::int AS subscribers,
           count(*) FILTER (WHERE s.as_it_happens)::int AS as_it_happens,
           count(*) FILTER (WHERE s.digest)::int AS digest
      FROM subscriptions sub
      JOIN subscribers s ON s.id = sub.subscriber_id
     WHERE s.status = 'active'
     GROUP BY sub.list_key`);
  const { rows: everyone } = await db.execute<{ subscribers: number; as_it_happens: number; digest: number }>(sql`
    SELECT count(*)::int AS subscribers,
           count(*) FILTER (WHERE as_it_happens)::int AS as_it_happens,
           count(*) FILTER (WHERE digest)::int AS digest
      FROM subscribers WHERE status = 'active'`);
  const by = new Map(rows.map((r) => [r.list_key, { subscribers: r.subscribers, asItHappens: r.as_it_happens, digest: r.digest }]));
  const all = everyone[0]!;
  return {
    all: { subscribers: all.subscribers, asItHappens: all.as_it_happens, digest: all.digest },
    allNews: by.get(ALL_NEWS) ?? ZERO,
    categories: view.categories.map((c) => ({
      key: c.key,
      name: c.name,
      lists: c.lists.map((l) => ({ listKey: l.listKey, name: l.name, active: l.active, ...(by.get(l.listKey) ?? ZERO) })),
    })),
  };
}

/** "All active subscribers", "All news", or the list's own name; unknown keys are 404. */
export async function listLabel(db: DbOrTx, list: string): Promise<string> {
  if (list === ALL_SUBSCRIBERS) return "All active subscribers";
  if (list === ALL_NEWS) return "All news";
  const [row] = await db.select({ name: lists.name }).from(lists).where(eq(lists.listKey, list));
  if (!row) throw new ReportListNotFoundError();
  return row.name;
}

function scope(list: string, timing: TimingFilter): SQL {
  const conds: SQL[] = [eq(subscribers.status, "active")];
  if (list !== ALL_SUBSCRIBERS) {
    conds.push(sql`EXISTS (SELECT 1 FROM ${subscriptions} WHERE ${subscriptions.subscriberId} = ${subscribers.id} AND ${subscriptions.listKey} = ${list})`);
  }
  if (timing === "as-it-happens") conds.push(eq(subscribers.asItHappens, true));
  if (timing === "digest") conds.push(eq(subscribers.digest, true));
  return and(...conds)!;
}

const memberColumns = {
  id: subscribers.id,
  email: subscribers.email,
  sortKey: sql<string>`lower(${subscribers.email})`,
  asItHappens: subscribers.asItHappens,
  digest: subscribers.digest,
  source: subscribers.source,
  createdAt: subscribers.createdAt,
};
type MemberRow = { id: string; email: string; sortKey: string; asItHappens: boolean; digest: boolean; source: SubscriberSource; createdAt: Date };
const toMember = (r: MemberRow): ReportMember => ({
  id: r.id,
  email: r.email,
  asItHappens: r.asItHappens,
  digest: r.digest,
  source: r.source,
  createdAt: r.createdAt.toISOString(),
});

export async function membersPage(db: DbOrTx, q: { list: string; timing: TimingFilter; page: number }): Promise<MembersPage> {
  const listName = await listLabel(db, q.list);
  const where = scope(q.list, q.timing);
  const rows = await db
    .select(memberColumns)
    .from(subscribers)
    .where(where)
    .orderBy(sql`lower(${subscribers.email})`, subscribers.id)
    .limit(MEMBERS_PAGE_SIZE)
    .offset((q.page - 1) * MEMBERS_PAGE_SIZE);
  const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(subscribers).where(where)) as [{ n: number }];
  return { list: q.list, listName, timing: q.timing, total: n, page: q.page, pageSize: MEMBERS_PAGE_SIZE, items: rows.map(toMember) };
}

/** Every member in address order, `batchSize` at a time (keyset, so a long export never rescans). */
export async function* memberBatches(db: DbOrTx, list: string, timing: TimingFilter, batchSize = 1000): AsyncGenerator<ReportMember[]> {
  let after: { sortKey: string; id: string } | null = null;
  for (;;) {
    const where: SQL = after
      ? and(scope(list, timing), sql`(lower(${subscribers.email}), ${subscribers.id}) > (${after.sortKey}, ${after.id}::uuid)`)!
      : scope(list, timing);
    const rows = await db.select(memberColumns).from(subscribers).where(where).orderBy(sql`lower(${subscribers.email})`, subscribers.id).limit(batchSize);
    if (rows.length > 0) yield rows.map(toMember);
    if (rows.length < batchSize) return;
    const last = rows[rows.length - 1]!;
    after = { sortKey: last.sortKey, id: last.id };
  }
}

export function timingText(m: { asItHappens: boolean; digest: boolean }): string {
  if (m.asItHappens && m.digest) return "As it happens and daily digest";
  if (m.asItHappens) return "As it happens";
  if (m.digest) return "Daily digest";
  return "None (media lists only)";
}

const SOURCE_TEXT: Record<SubscriberSource, string> = { self: "Signed up", admin: "Added by staff", "media-hub": "Media Hub", "manual-media": "Added by hand" };
export function sourceText(source: SubscriberSource): string {
  return SOURCE_TEXT[source] ?? source;
}

export const BY_LIST_CSV_HEADER = ["Category", "List", "Subscribers", "As it happens", "Daily digest"];
export function byListCsvRows(r: SubscribersByListReport): CsvCell[][] {
  const counts = (c: TimingCounts): CsvCell[] => [c.subscribers, c.asItHappens, c.digest];
  return [
    ["All active subscribers", "", ...counts(r.all)],
    ["All news", "", ...counts(r.allNews)],
    ...r.categories.flatMap((c) => c.lists.map((l): CsvCell[] => [c.name, l.active ? l.name : `${l.name} (retired)`, ...counts(l)])),
  ];
}

export const MEMBER_CSV_HEADER = ["Email", "Timing", "Source", "Registered (BC time)"];
export function memberCsvRow(m: ReportMember, timeZone: string): CsvCell[] {
  return [m.email, timingText(m), sourceText(m.source), localDateTime(new Date(m.createdAt), timeZone)];
}
```

- [ ] **Step 6: Implement `http/report-routes.ts`, the ops-log action and the mount**

`apps/nod/src/settings.ts`: add `| "report-exported"` as the last member of `OperationsAction`.

`apps/nod/src/http/report-routes.ts`:

```ts
import { Router, type Response } from "express";
import { z, ZodError } from "zod";
import type { Db } from "@gcpe/db-kit";
import { actorOf, requireAnyRole } from "@gcpe/auth";
import { writeOpsLog } from "../settings";
import { csvFilename, mapBatches, oneBatch, streamCsv } from "../reports/csv";
import { bcToday, MAX_RANGE_DAYS, ReportRangeError } from "../reports/range";
import {
  ALL_NEWS, ALL_SUBSCRIBERS, BY_LIST_CSV_HEADER, byListCsvRows, listLabel, MEMBER_CSV_HEADER, memberBatches, memberCsvRow, membersPage,
  ReportListNotFoundError, subscribersByList, TIMING_FILTERS,
} from "../reports/by-list";
import { privateErrorsWith } from "./private-errors";
import type { SettingsRouteDeps } from "./routes";
import { NOD_READ_ROLES, NOD_WRITE_ROLES } from "./staff-subscriber-routes";

export type ReportRouteDeps = Pick<SettingsRouteDeps, "timeZone">;

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);
export const pageParam = z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(10_000).default(1));
const listParam = z.preprocess(
  emptyToUndefined,
  z.string().max(300).default(ALL_SUBSCRIBERS).transform((s) => (s === ALL_SUBSCRIBERS || s === ALL_NEWS ? s : s.toLowerCase())),
);
const membersQuery = z.object({ list: listParam, timing: z.preprocess(emptyToUndefined, z.enum(TIMING_FILTERS).default("any")), page: pageParam });

function mapError(e: unknown, res: Response): boolean {
  if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues }), true;
  if (e instanceof ReportRangeError) return void res.status(400).json({ error: e.code, maxDays: MAX_RANGE_DAYS }), true;
  if (e instanceof ReportListNotFoundError) return void res.status(404).json({ error: "not found" }), true;
  return false;
}
/** Report queries bind no addresses, but their rows hold them; errors stay label-only. */
const privateErrors = privateErrorsWith(mapError, "report request");

/** "ministries:health" -> "ministries-health", for a filename. */
function slug(list: string): string {
  if (list === ALL_NEWS) return "all-news";
  return list.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "list";
}

/** Spec §8 Reports. Reads: NoD.Viewer and up. Address CSVs: NoD.Editor and NoD.Admin (Q37). */
export function reportRoutes(db: Db, deps: ReportRouteDeps): Router {
  const r = Router();
  const read = requireAnyRole(...NOD_READ_ROLES);
  const exportAddresses = requireAnyRole(...NOD_WRITE_ROLES);

  r.get("/reports/subscribers-by-list", read, privateErrors(async (_req, res) => {
    res.json(await subscribersByList(db));
  }));

  r.get("/reports/subscribers-by-list.csv", read, privateErrors(async (_req, res) => {
    const report = await subscribersByList(db);
    const today = await bcToday(db, deps.timeZone);
    await streamCsv(res, csvFilename("subscribers-by-list", today), BY_LIST_CSV_HEADER, oneBatch(byListCsvRows(report)));
  }));

  r.get("/reports/subscribers-by-list/members", read, privateErrors(async (req, res) => {
    res.json(await membersPage(db, membersQuery.parse(req.query)));
  }));

  r.get("/reports/subscribers-by-list/members.csv", exportAddresses, privateErrors(async (req, res) => {
    const { list, timing } = membersQuery.parse(req.query);
    await listLabel(db, list); // 404 before any byte of CSV
    const today = await bcToday(db, deps.timeZone);
    // Who took addresses out of the system, and which; never the addresses themselves.
    await writeOpsLog(db, actorOf(req).name, "report-exported", `subscribers ${list} ${timing}`);
    await streamCsv(res, csvFilename(`subscribers-${slug(list)}`, today), MEMBER_CSV_HEADER, mapBatches(memberBatches(db, list, timing), (m) => memberCsvRow(m, deps.timeZone)));
  }));

  return r;
}
```

`apps/nod/src/http/routes.ts`: import `reportRoutes` from `./report-routes`, and add `r.use(reportRoutes(db, settings));` directly above `r.use(staffSubscriberRoutes(db));` (:172).

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/reports apps/nod/src/http/report-routes.test.ts`
Expected: PASS.

If the `dayBounds` Nov 1 test fails with `2026-11-02T08:00:00.000Z`, the runtime's tzdata is older than 2026b. Check `node -p process.versions.tz` under Node 24 before touching code.

Then run both type-checks.

- [ ] **Step 8: Commit**

```bash
git add apps/nod/src/reports apps/nod/src/http/report-routes.ts apps/nod/src/http/report-routes.test.ts apps/nod/src/http/routes.ts apps/nod/src/settings.ts
git commit -m "feat(nod): report foundations (streamed injection-safe CSV, BC day ranges) and active subscribers by list"
```

---

### Task 2: Recent unsubscribes (NoD)

Covers spec §8's "recent unsubscribes (90 days)", and the carry-forward rule in `phase-4-carry-forward.md` "4h (reports)":
- `unsubscribed` and `staff-deleted` count as unsubscribes;
- `subscribed`/`resubscribed` count as new vs returning;
- old `confirmed` rows count as subscribed.

**Files:**
- Create: `apps/nod/src/reports/unsubscribes.ts` (+ `unsubscribes.test.ts`).
- Modify:
  - `apps/nod/src/db/schema.ts` (`subscriber_history` gains `subscriber_history_action_at_idx`) + generated migration `0023_report_history_index`;
  - `apps/nod/src/http/report-routes.ts`, `report-routes.test.ts`.

**Interfaces:**
- Consumes: `addDays`, `bcToday`, `dayBounds`, `localDate`, `localDateTime` (`range.ts`); `streamCsv`, `oneBatch`, `mapBatches`, `csvFilename` (`csv.ts`); `pageParam` (`report-routes.ts`).
- Produces (`reports/unsubscribes.ts`):
  - constants: `UNSUBSCRIBE_WINDOW_DAYS = 90`, `UNSUBSCRIBES_PAGE_SIZE = 50`, `UNSUBSCRIBE_ACTIONS`;
  - window: `UnsubscribeWindow { since; today; start; days; bounds }`, `unsubscribeWindow(db, tz)`;
  - SQL and page: `unsubscribesSql(start, limit, offset)`, `unsubscribesPage(db, window, page)`, `unsubscribeBatches(db, window, batchSize?)`;
  - daily counts: `unsubscribeDailyCounts(db, window): Promise<CsvCell[][]>`;
  - CSV: `UNSUBSCRIBE_CSV_HEADER`, `unsubscribeCsvRow(row, tz)`, `UNSUBSCRIBE_COUNTS_HEADER`;
  - types: `UnsubscribeRow`, `UnsubscribesPage`, `UnsubscribeSummary`.
- Routes:

  | Route | Role |
  |---|---|
  | `GET /reports/unsubscribes?page=` | read |
  | `GET /reports/unsubscribes.csv` (addresses) | Editor/Admin |
  | `GET /reports/unsubscribes/daily.csv` (counts) | read |

- [ ] **Step 1: Write the failing tests**

`apps/nod/src/reports/unsubscribes.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../../test/helpers";
import { subscriberHistory, subscribers } from "../db/schema";
import { addDays, localDate } from "./range";
import { unsubscribeBatches, unsubscribeDailyCounts, unsubscribesPage, unsubscribesSql, unsubscribeWindow } from "./unsubscribes";

const BC = "America/Vancouver";
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

describe("recent unsubscribes", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    const [alex, blake, casey, dana] = await tdb.db
      .insert(subscribers)
      .values([
        { email: "alex@example.test", status: "active" },
        { email: "blake@example.test", status: "deleted" },
        { email: "casey@example.test", status: "deleted" },
        { email: "dana@example.test", status: "deleted" },
      ])
      .returning({ id: subscribers.id });
    await tdb.db.insert(subscriberHistory).values([
      { subscriberId: alex!.id, at: daysAgo(10), actor: "subscriber", action: "unsubscribed" },
      { subscriberId: alex!.id, at: daysAgo(5), actor: "subscriber", action: "resubscribed" },
      { subscriberId: blake!.id, at: daysAgo(2), actor: "Jamie Staff", action: "staff-deleted" },
      { subscriberId: casey!.id, at: daysAgo(100), actor: "subscriber", action: "unsubscribed" },
      { subscriberId: dana!.id, at: daysAgo(20), actor: "subscriber", action: "unsubscribed" },
      { subscriberId: dana!.id, at: daysAgo(3), actor: "subscriber", action: "unsubscribed" },
      { subscriberId: dana!.id, at: daysAgo(30), actor: "subscriber", action: "subscribed" },
      { subscriberId: casey!.id, at: daysAgo(40), actor: "subscriber", action: "confirmed" },
    ]);
  });
  afterAll(async () => tdb.drop());

  it("lists each person's latest unsubscribe in the last 90 days, newest first, with how and their status now", async () => {
    const window = await unsubscribeWindow(tdb.db, BC);
    const page = await unsubscribesPage(tdb.db, window, 1);
    expect(page.total).toBe(3);
    expect(page.items.map((i) => [i.email, i.how, i.status])).toEqual([
      ["blake@example.test", "staff", "deleted"],
      ["dana@example.test", "subscriber", "deleted"],
      ["alex@example.test", "subscriber", "active"],
    ]);
    expect(localDate(new Date(page.items[1]!.at), BC)).toBe(localDate(daysAgo(3), BC));
    expect(page.summary).toEqual({ subscribed: 2, resubscribed: 1, unsubscribed: 3, staffDeleted: 1 });
  });

  it("starts the window at BC midnight 90 days ago", async () => {
    const window = await unsubscribeWindow(tdb.db, BC);
    expect(window.since).toBe(addDays(localDate(new Date(), BC), -90));
    expect(window.days).toBe(91);
  });

  it("batches the same rows for the CSV", async () => {
    const window = await unsubscribeWindow(tdb.db, BC);
    const all: string[] = [];
    for await (const b of unsubscribeBatches(tdb.db, window, 2)) all.push(...b.map((r) => r.email));
    expect(all).toEqual(["blake@example.test", "dana@example.test", "alex@example.test"]);
  });

  it("counts each BC day of the window, zeros included, without addresses", async () => {
    const window = await unsubscribeWindow(tdb.db, BC);
    const rows = await unsubscribeDailyCounts(tdb.db, window);
    expect(rows).toHaveLength(91);
    expect(rows.find((r) => r[0] === localDate(daysAgo(2), BC))).toEqual([localDate(daysAgo(2), BC), 0, 0, 0, 1]);
    expect(rows.flat().some((c) => String(c).includes("@"))).toBe(false);
  });

  it("reads subscriber_history through its (action, at) index", async () => {
    await tdb.db.execute(sql.raw(`
      INSERT INTO subscribers (email, status) SELECT 'plan-' || g || '@example.test', 'active' FROM generate_series(1, 1000) g;
      WITH s AS (SELECT id, row_number() OVER (ORDER BY id) AS n FROM subscribers WHERE email LIKE 'plan-%')
      INSERT INTO subscriber_history (subscriber_id, at, actor, action)
      SELECT s.id, now() - ((g % 1500) || ' days')::interval, 'subscriber', CASE WHEN g % 3 = 0 THEN 'unsubscribed' ELSE 'preferences-updated' END
        FROM generate_series(1, 50000) g JOIN s ON s.n = g % 1000 + 1;
      ANALYZE subscriber_history;
    `));
    const window = await unsubscribeWindow(tdb.db, BC);
    const { rows } = await tdb.db.execute<{ "QUERY PLAN": string }>(sql`EXPLAIN ${unsubscribesSql(window.start, 50, 0)}`);
    const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(plan).toContain("subscriber_history_action_at_idx");
    expect(plan).not.toContain("Seq Scan on subscriber_history");
  });
});
```

Inside the top-level `describe` of `apps/nod/src/http/report-routes.test.ts`, after the existing tests, add:

```ts
  describe("recent unsubscribes", () => {
    beforeAll(async () => {
      const [gone] = await tdb.db.insert(subscribers).values({ email: "gone@example.test", status: "deleted" }).returning({ id: subscribers.id });
      await tdb.db.insert(subscriberHistory).values({ subscriberId: gone!.id, actor: "subscriber", action: "unsubscribed" });
    });

    it("a Viewer reads the page and the daily counts CSV, but not the address CSV", async () => {
      const page = await request(app).get("/api/reports/unsubscribes").set("authorization", `Bearer ${viewer}`);
      expect(page.status).toBe(200);
      expect(page.body.items.map((i: { email: string }) => i.email)).toContain("gone@example.test");
      const counts = await getCsv(app, "/api/reports/unsubscribes/daily.csv", viewer);
      expect(counts.status).toBe(200);
      expect((counts.body as Buffer).toString("utf8").split("\r\n")[0]).toBe("﻿Date,New subscriptions,Returning,Unsubscribed,Deleted by staff");
      expect((counts.body as Buffer).toString("utf8")).not.toContain("@");
      expect((await getCsv(app, "/api/reports/unsubscribes.csv", viewer)).status).toBe(403);
    });

    it("an Editor exports the addresses, and the export is logged", async () => {
      const res = await getCsv(app, "/api/reports/unsubscribes.csv", editor);
      expect(res.status).toBe(200);
      expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="unsubscribes-\d{4}-\d{2}-\d{2}\.csv"$/);
      const text = (res.body as Buffer).toString("utf8");
      expect(text.split("\r\n")[0]).toBe("﻿Email,How,When (BC time),Status now,Registered (BC time)");
      expect(text).toMatch(/\r\ngone@example\.test,Unsubscribed,\d{4}-\d{2}-\d{2} \d{2}:\d{2},Deleted,/);
      const logs = await tdb.db.select().from(operationsLog).where(eq(operationsLog.detail, "unsubscribes"));
      expect(logs).toHaveLength(1);
    });
  });
```

Also add `subscriberHistory` to that file's schema import.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/reports/unsubscribes.test.ts apps/nod/src/http/report-routes.test.ts`
Expected: FAIL ("Failed to load url ./unsubscribes"; the route tests get 404).

- [ ] **Step 3: Add the index and generate the migration**

In `apps/nod/src/db/schema.ts`, add to `subscriber_history`'s index list:

```ts
    // Report windows (reports/unsubscribes.ts): equality on action, a range on at, any list key.
    index("subscriber_history_action_at_idx").on(t.action, t.at),
```

Run: `cd apps/nod && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name report_history_index`
Expected: `migrations/0023_report_history_index.sql` holding one `CREATE INDEX "subscriber_history_action_at_idx" ...` statement.

- [ ] **Step 4: Implement `reports/unsubscribes.ts`**

```ts
/**
 * Recent unsubscribes (spec §8; legacy RecentUnsubscribersReport): everyone whose latest
 * unsubscribe falls between BC midnight 90 days ago and now, one row each. An unsubscribe is the
 * subscriber's own `unsubscribed` or staff's `staff-deleted`. A bounce-disabled subscriber
 * hasn't unsubscribed and isn't listed (Q40).
 */
import { sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import type { SubscriberStatus } from "../db/schema";
import type { CsvCell } from "./csv";
import { addDays, bcToday, dayBounds, localDateTime } from "./range";

export const UNSUBSCRIBE_WINDOW_DAYS = 90;
export const UNSUBSCRIBES_PAGE_SIZE = 50;
export const UNSUBSCRIBE_ACTIONS = ["unsubscribed", "staff-deleted"] as const;
/** `confirmed` predates the subscribed/resubscribed split and counts as new. */
const SUMMARY_ACTIONS = ["subscribed", "confirmed", "resubscribed", ...UNSUBSCRIBE_ACTIONS] as const;

export type UnsubscribeHow = "subscriber" | "staff";
export interface UnsubscribeRow {
  subscriberId: string;
  email: string;
  how: UnsubscribeHow;
  at: string;
  status: SubscriberStatus;
  registeredAt: string;
}
export interface UnsubscribeSummary {
  subscribed: number;
  resubscribed: number;
  unsubscribed: number;
  staffDeleted: number;
}
export interface UnsubscribesPage {
  since: string;
  summary: UnsubscribeSummary;
  total: number;
  page: number;
  pageSize: number;
  items: UnsubscribeRow[];
}
export interface UnsubscribeWindow {
  since: string;
  today: string;
  start: Date;
  days: number;
  bounds: Date[];
}

export async function unsubscribeWindow(db: DbOrTx, timeZone: string): Promise<UnsubscribeWindow> {
  const today = await bcToday(db, timeZone);
  const since = addDays(today, -UNSUBSCRIBE_WINDOW_DAYS);
  const days = UNSUBSCRIBE_WINDOW_DAYS + 1;
  const bounds = dayBounds(since, days, timeZone);
  return { since, today, start: bounds[0]!, days, bounds };
}

const actionList = (actions: readonly string[]): SQL => sql.join(actions.map((a) => sql`${a}`), sql`, `);

/** One row per person, their latest unsubscribe at or after `start`, newest first. */
export function unsubscribesSql(start: Date, limit: number, offset: number): SQL {
  return sql`
    WITH latest AS (
      SELECT DISTINCT ON (h.subscriber_id) h.subscriber_id, h.action, h.at
        FROM subscriber_history h
       WHERE h.action IN (${actionList(UNSUBSCRIBE_ACTIONS)}) AND h.at >= ${start}
       ORDER BY h.subscriber_id, h.at DESC, h.id DESC)
    SELECT l.subscriber_id, l.action, l.at, s.email, s.status, s.created_at
      FROM latest l
      JOIN subscribers s ON s.id = l.subscriber_id
     ORDER BY l.at DESC, l.subscriber_id
     LIMIT ${limit} OFFSET ${offset}`;
}

interface RawRow {
  subscriber_id: string;
  action: string;
  at: string;
  email: string;
  status: SubscriberStatus;
  created_at: string;
}
const toRow = (r: RawRow): UnsubscribeRow => ({
  subscriberId: r.subscriber_id,
  email: r.email,
  how: r.action === "staff-deleted" ? "staff" : "subscriber",
  at: new Date(r.at).toISOString(),
  status: r.status,
  registeredAt: new Date(r.created_at).toISOString(),
});

async function summary(db: DbOrTx, start: Date): Promise<UnsubscribeSummary> {
  const { rows } = await db.execute<{ subscribed: number; resubscribed: number; unsubscribed: number; staff_deleted: number }>(sql`
    SELECT count(*) FILTER (WHERE action IN ('subscribed', 'confirmed'))::int AS subscribed,
           count(*) FILTER (WHERE action = 'resubscribed')::int AS resubscribed,
           count(*) FILTER (WHERE action = 'unsubscribed')::int AS unsubscribed,
           count(*) FILTER (WHERE action = 'staff-deleted')::int AS staff_deleted
      FROM subscriber_history
     WHERE action IN (${actionList(SUMMARY_ACTIONS)}) AND at >= ${start}`);
  const r = rows[0]!;
  return { subscribed: r.subscribed, resubscribed: r.resubscribed, unsubscribed: r.unsubscribed, staffDeleted: r.staff_deleted };
}

export async function unsubscribesPage(db: DbOrTx, window: UnsubscribeWindow, page: number): Promise<UnsubscribesPage> {
  const { rows } = await db.execute<RawRow>(unsubscribesSql(window.start, UNSUBSCRIBES_PAGE_SIZE, (page - 1) * UNSUBSCRIBES_PAGE_SIZE));
  const { rows: total } = await db.execute<{ n: number }>(sql`
    SELECT count(DISTINCT subscriber_id)::int AS n FROM subscriber_history
     WHERE action IN (${actionList(UNSUBSCRIBE_ACTIONS)}) AND at >= ${window.start}`);
  return {
    since: window.since,
    summary: await summary(db, window.start),
    total: total[0]!.n,
    page,
    pageSize: UNSUBSCRIBES_PAGE_SIZE,
    items: rows.map(toRow),
  };
}

export async function* unsubscribeBatches(db: DbOrTx, window: UnsubscribeWindow, batchSize = 1000): AsyncGenerator<UnsubscribeRow[]> {
  for (let offset = 0; ; offset += batchSize) {
    const { rows } = await db.execute<RawRow>(unsubscribesSql(window.start, batchSize, offset));
    if (rows.length > 0) yield rows.map(toRow);
    if (rows.length < batchSize) return;
  }
}

export const UNSUBSCRIBE_COUNTS_HEADER = ["Date", "New subscriptions", "Returning", "Unsubscribed", "Deleted by staff"];

/** One row per BC day of the window, oldest first, zeros included. Counts events, not people. */
export async function unsubscribeDailyCounts(db: DbOrTx, window: UnsubscribeWindow): Promise<CsvCell[][]> {
  const bounds = sql`${sql.param(window.bounds.map((b) => b.toISOString()))}::timestamptz[]`;
  const { rows } = await db.execute<{ day: number; subscribed: number; resubscribed: number; unsubscribed: number; staff_deleted: number }>(sql`
    SELECT width_bucket(at, ${bounds}) - 1 AS day,
           count(*) FILTER (WHERE action IN ('subscribed', 'confirmed'))::int AS subscribed,
           count(*) FILTER (WHERE action = 'resubscribed')::int AS resubscribed,
           count(*) FILTER (WHERE action = 'unsubscribed')::int AS unsubscribed,
           count(*) FILTER (WHERE action = 'staff-deleted')::int AS staff_deleted
      FROM subscriber_history
     WHERE action IN (${actionList(SUMMARY_ACTIONS)}) AND at >= ${window.start} AND at < ${window.bounds[window.days]!}
     GROUP BY 1`);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return Array.from({ length: window.days }, (_, i): CsvCell[] => {
    const r = byDay.get(i);
    return [addDays(window.since, i), r?.subscribed ?? 0, r?.resubscribed ?? 0, r?.unsubscribed ?? 0, r?.staff_deleted ?? 0];
  });
}

const STATUS_TEXT: Record<SubscriberStatus, string> = { pending: "Pending", active: "Active", disabled: "Disabled", deleted: "Deleted" };
export const UNSUBSCRIBE_CSV_HEADER = ["Email", "How", "When (BC time)", "Status now", "Registered (BC time)"];
export function unsubscribeCsvRow(r: UnsubscribeRow, timeZone: string): CsvCell[] {
  return [
    r.email,
    r.how === "staff" ? "Deleted by staff" : "Unsubscribed",
    localDateTime(new Date(r.at), timeZone),
    STATUS_TEXT[r.status],
    localDateTime(new Date(r.registeredAt), timeZone),
  ];
}
```

- [ ] **Step 5: Add the routes**

In `apps/nod/src/http/report-routes.ts`, import from `../reports/unsubscribes`:
- `UNSUBSCRIBE_COUNTS_HEADER`, `UNSUBSCRIBE_CSV_HEADER`;
- `unsubscribeBatches`, `unsubscribeCsvRow`, `unsubscribeDailyCounts`, `unsubscribesPage`, `unsubscribeWindow`.

Then add, inside `reportRoutes` before `return r;`:

```ts
  const pageQuery = z.object({ page: pageParam });

  r.get("/reports/unsubscribes", read, privateErrors(async (req, res) => {
    const { page } = pageQuery.parse(req.query);
    res.json(await unsubscribesPage(db, await unsubscribeWindow(db, deps.timeZone), page));
  }));

  r.get("/reports/unsubscribes/daily.csv", read, privateErrors(async (_req, res) => {
    const window = await unsubscribeWindow(db, deps.timeZone);
    await streamCsv(res, csvFilename("unsubscribe-counts", window.today), UNSUBSCRIBE_COUNTS_HEADER, oneBatch(await unsubscribeDailyCounts(db, window)));
  }));

  r.get("/reports/unsubscribes.csv", exportAddresses, privateErrors(async (req, res) => {
    const window = await unsubscribeWindow(db, deps.timeZone);
    await writeOpsLog(db, actorOf(req).name, "report-exported", "unsubscribes");
    await streamCsv(res, csvFilename("unsubscribes", window.today), UNSUBSCRIBE_CSV_HEADER, mapBatches(unsubscribeBatches(db, window), (u) => unsubscribeCsvRow(u, deps.timeZone)));
  }));
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/reports apps/nod/src/http/report-routes.test.ts apps/nod/src/db/migrations.test.ts`
Expected: PASS. Then run both type-checks.

- [ ] **Step 7: Commit**

```bash
git add apps/nod/src/reports/unsubscribes.ts apps/nod/src/reports/unsubscribes.test.ts apps/nod/src/http/report-routes.ts apps/nod/src/http/report-routes.test.ts apps/nod/src/db/schema.ts apps/nod/migrations
git commit -m "feat(nod): recent unsubscribes report with address and daily-count CSVs"
```

---
### Task 3: Sends per release and daily digest runs (NoD), with the volume probe

Covers spec §8's "per-release sends (as-it-happens and media, with counts delivered/bounced)" and "digest runs".

**Files:**
- Create:
  - `apps/nod/src/reports/release-sends.ts` (+ `release-sends.test.ts`);
  - `apps/nod/src/reports/digest-runs.ts` (+ `digest-runs.test.ts`);
  - `apps/nod/src/reports/volume.probe.test.ts`.
- Modify:
  - `apps/nod/src/digest.ts:84-88` (`digestJobKeyPrefix`, used by `createDigestJob`) and `apps/nod/src/digest.test.ts`;
  - `apps/nod/src/db/schema.ts` (two partial `deliveries` indexes) + generated migration `0024_report_delivery_indexes`;
  - `apps/nod/src/http/report-routes.ts`, `report-routes.test.ts`.

**Interfaces:**
- Consumes: `ReportRange`, `resolveRange`, `bcToday`, `localDateTime`, `MAX_RANGE_DAYS` (`range.ts`); `streamCsv`, `mapBatches`, `csvFilename`, `CsvCell` (`csv.ts`); `pageParam` (`report-routes.ts`).
- Produces, in `digest.ts`: `digestJobKeyPrefix(cutoff: Date): string` and `DIGEST_JOB_PREFIX_LENGTH = 32`.
- Produces, in `reports/release-sends.ts`:
  - `RELEASE_SENDS_PAGE_SIZE = 25`;
  - types: `ModeCounts { recipients; delivered; bounced; notSent }`, `ReleaseSendRow { itemKey; title; type; publishedAt; asItHappens: ModeCounts; media: ModeCounts }`, `RangedPage<T> { from; to; total; page; pageSize; items: T[] }`;
  - `itemTypeLabel(kind, postKind)`;
  - `releaseSendsSql(range, limit, offset)`, `releaseSendsPage(db, range, page)`, `releaseSendBatches(db, range, batchSize?)`;
  - `RELEASE_SENDS_CSV_HEADER`, `releaseSendCsvRow(row, tz)`.
- Produces, in `reports/digest-runs.ts`:
  - `DIGEST_RUNS_PAGE_SIZE = 31`;
  - `DigestRunRow { cutoff; ranAt; items; subscribers; delivered; bounced; notSent }`;
  - `digestRunCountsSql(prefixes)`, `digestRunsPage(db, range, page)`, `digestRunBatches(db, range)`;
  - `DIGEST_RUNS_CSV_HEADER`, `digestRunCsvRow(row, tz)`.
- Produces, in `report-routes.ts`: `rangeQuery` (zod: `from?`, `to?`, `page`).
- Routes (all read):
  - `GET /reports/release-sends?from=&to=&page=` and `.csv?from=&to=`;
  - `GET /reports/digest-runs?from=&to=&page=` and `.csv?from=&to=`.
- **Definitions (R10, R11):**
  - **Sent:** handed to Distribution (`deliveries.distribution_batch_id` set).
  - **Bounced:** any bounce recorded (`bounce_status` set; hard or soft, as legacy counted).
  - **Delivered:** sent − bounced.
  - **Not sent:** recipients − sent (in progress, or skipped).
  - **Digest units:** an email, which is one subscriber in one run.

- [ ] **Step 1: Write the failing tests**

In `apps/nod/src/digest.test.ts`, add (importing `digestJobKeyPrefix`, `DIGEST_JOB_PREFIX_LENGTH` from `./digest`):

```ts
describe("digestJobKeyPrefix", () => {
  it("is 'digest:<cutoff ISO>:' and always DIGEST_JOB_PREFIX_LENGTH long", () => {
    const prefix = digestJobKeyPrefix(new Date("2026-10-08T00:00:00Z"));
    expect(prefix).toBe("digest:2026-10-08T00:00:00.000Z:");
    expect(prefix).toHaveLength(DIGEST_JOB_PREFIX_LENGTH);
  });
});
```

`apps/nod/src/reports/release-sends.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../../test/helpers";
import { deliveries, items, subscribers } from "../db/schema";
import { resolveRange, localDate } from "./range";
import { releaseSendBatches, releaseSendCsvRow, releaseSendsPage, releaseSendsSql } from "./release-sends";
import { csvLine } from "./csv";

const BC = "America/Vancouver";
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const HOSTILE = '=HYPERLINK("http://x","y")';

describe("sends per release", () => {
  let tdb: TestDatabase;
  const range = () => resolveRange({}, localDate(new Date(), BC), BC);

  beforeAll(async () => {
    tdb = await createNodTestDb();
    const [s1, s2, s3, s4] = await tdb.db
      .insert(subscribers)
      .values(["s1", "s2", "s3", "s4"].map((n) => ({ email: `${n}@example.test`, status: "active" as const })))
      .returning({ id: subscribers.id });
    await tdb.db.insert(items).values([
      { key: "r1", kind: "release", postKind: "releases", title: HOSTILE, url: "https://news.example/r1", publishedAt: daysAgo(2) },
      { key: "r2", kind: "release", postKind: "releases", title: "Too old", url: "https://news.example/r2", publishedAt: daysAgo(40) },
      { key: "r3", kind: "release", postKind: "stories", title: "Nobody matched", url: "https://news.example/r3", publishedAt: daysAgo(1) },
      { key: "e1", kind: "emergency", title: "Wildfire alert", url: "https://news.example/e1", publishedAt: daysAgo(1) },
    ]);
    const sent = { attemptedAt: daysAgo(1), distributionBatchId: randomUUID() };
    await tdb.db.insert(deliveries).values([
      { itemKey: "r1", subscriberId: s1!.id, mode: "as_it_happens", ...sent },
      { itemKey: "r1", subscriberId: s2!.id, mode: "as_it_happens", ...sent, bounceStatus: "5.1.1", hardBouncedAt: daysAgo(1) },
      { itemKey: "r1", subscriberId: s3!.id, mode: "as_it_happens" },
      { itemKey: "r1", subscriberId: s4!.id, mode: "as_it_happens", ...sent, bounceStatus: "4.2.2" },
      { itemKey: "r1", subscriberId: s1!.id, mode: "media", ...sent },
      { itemKey: "r1", subscriberId: s2!.id, mode: "digest", ...sent },
      { itemKey: "r2", subscriberId: s1!.id, mode: "as_it_happens", ...sent },
      { itemKey: "e1", subscriberId: s1!.id, mode: "as_it_happens", ...sent },
    ]);
  });
  afterAll(async () => tdb.drop());

  it("counts each sent item in the range by mode, newest first, leaving out digest rows and items nobody got", async () => {
    const page = await releaseSendsPage(tdb.db, range(), 1);
    expect(page.total).toBe(2);
    expect(page.items.map((i) => [i.itemKey, i.type])).toEqual([
      ["e1", "Emergency alert"],
      ["r1", "News release"],
    ]);
    const r1 = page.items[1]!;
    expect(r1.title).toBe(HOSTILE);
    expect(r1.asItHappens).toEqual({ recipients: 4, delivered: 1, bounced: 2, notSent: 1 });
    expect(r1.media).toEqual({ recipients: 1, delivered: 1, bounced: 0, notSent: 0 });
  });

  it("batches the same rows for the CSV, with the hostile title neutralised", async () => {
    const all = [];
    for await (const b of releaseSendBatches(tdb.db, range(), 1)) all.push(...b);
    expect(all.map((r) => r.itemKey)).toEqual(["e1", "r1"]);
    const line = csvLine(releaseSendCsvRow(all[1]!, BC));
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2},"'=HYPERLINK\(""http:\/\/x"",""y""\)",News release,4,1,2,1,1,1,0,0\r\n$/);
  });

  it("reads deliveries by primary key and items by publish time", async () => {
    const plan = await tdb.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const { rows } = await tx.execute<{ "QUERY PLAN": string }>(sql`EXPLAIN ${releaseSendsSql(range(), 25, 0)}`);
      return rows.map((r) => r["QUERY PLAN"]).join("\n");
    });
    expect(plan).toContain("deliveries_pkey");
    expect(plan).toContain("items_published_at_idx");
  });
});
```

`apps/nod/src/reports/digest-runs.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../../test/helpers";
import { deliveries, digestRuns, items, jobRecipients, sendJobs, subscribers } from "../db/schema";
import { digestJobKeyPrefix } from "../digest";
import { localDate, resolveRange } from "./range";
import { digestRunBatches, digestRunCountsSql, digestRunsPage } from "./digest-runs";

const BC = "America/Vancouver";
const ms = (d: Date) => new Date(Math.floor(d.getTime() / 1000) * 1000);
const daysAgo = (n: number) => ms(new Date(Date.now() - n * 86_400_000));

describe("daily digest runs", () => {
  let tdb: TestDatabase;
  const range = () => resolveRange({}, localDate(new Date(), BC), BC);
  const cutoff = daysAgo(2);

  beforeAll(async () => {
    tdb = await createNodTestDb();
    const [s1, s2, s3, s4] = await tdb.db
      .insert(subscribers)
      .values(["d1", "d2", "d3", "d4"].map((n) => ({ email: `${n}@example.test`, status: "active" as const, digest: true })))
      .returning({ id: subscribers.id });
    const windowStart = new Date(cutoff.getTime() - 86_400_000);
    const inWindow = new Date(cutoff.getTime() - 3_600_000);
    await tdb.db.insert(items).values([
      { key: "k1", kind: "release", postKind: "releases", title: "One", url: "https://news.example/k1", publishedAt: inWindow },
      { key: "k2", kind: "release", postKind: "stories", title: "Two", url: "https://news.example/k2", publishedAt: inWindow },
      { key: "k3", kind: "release", postKind: "advisories", title: "Advisory", url: "https://news.example/k3", publishedAt: inWindow },
      { key: "k4", kind: "release", postKind: "releases", title: "Before", url: "https://news.example/k4", publishedAt: new Date(windowStart.getTime() - 1000) },
    ]);
    await tdb.db.insert(digestRuns).values([
      { cutoff, windowStart, subscribers: 3, groups: 2 },
      { cutoff: daysAgo(60), windowStart: daysAgo(61), subscribers: 9, groups: 1 },
    ]);
    const prefix = digestJobKeyPrefix(cutoff);
    const [a, b, c] = await tdb.db
      .insert(sendJobs)
      .values([
        { jobKey: `${prefix}aaaaaaaaaaaaaaaa`, kind: "digest", priority: "digest", status: "sent" },
        { jobKey: `${prefix}bbbbbbbbbbbbbbbb`, kind: "digest", priority: "digest", status: "pending" },
        { jobKey: `${prefix}cccccccccccccccc`, kind: "digest", priority: "digest", status: "cancelled" },
      ])
      .returning({ id: sendJobs.id });
    await tdb.db.insert(jobRecipients).values([
      { jobId: a!.id, subscriberId: s1!.id },
      { jobId: a!.id, subscriberId: s2!.id },
      { jobId: b!.id, subscriberId: s3!.id },
      { jobId: c!.id, subscriberId: s4!.id },
    ]);
    const handed = { attemptedAt: cutoff, distributionBatchId: randomUUID() };
    await tdb.db.insert(deliveries).values([
      { itemKey: "k1", subscriberId: s1!.id, mode: "digest", jobId: a!.id, ...handed },
      { itemKey: "k2", subscriberId: s1!.id, mode: "digest", jobId: a!.id, ...handed },
      { itemKey: "k1", subscriberId: s2!.id, mode: "digest", jobId: a!.id, ...handed, bounceStatus: "5.1.1", hardBouncedAt: cutoff },
      { itemKey: "k2", subscriberId: s2!.id, mode: "digest", jobId: a!.id, ...handed, bounceStatus: "5.1.1", hardBouncedAt: cutoff },
      { itemKey: "k1", subscriberId: s3!.id, mode: "digest", jobId: b!.id },
    ]);
  });
  afterAll(async () => tdb.drop());

  it("counts each run in the range by email: delivered, bounced, not sent; cancelled jobs left out", async () => {
    const page = await digestRunsPage(tdb.db, range(), 1);
    expect(page.total).toBe(1);
    expect(page.items).toEqual([
      { cutoff: cutoff.toISOString(), ranAt: expect.any(String), items: 2, subscribers: 3, delivered: 1, bounced: 1, notSent: 1 },
    ]);
  });

  it("batches the same rows for the CSV", async () => {
    const all = [];
    for await (const b of digestRunBatches(tdb.db, range())) all.push(...b);
    expect(all.map((r) => r.cutoff)).toEqual([cutoff.toISOString()]);
  });

  it("finds unsent and bounced emails through the partial indexes", async () => {
    const plan = await tdb.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const { rows } = await tx.execute<{ "QUERY PLAN": string }>(sql`EXPLAIN ${digestRunCountsSql([digestJobKeyPrefix(cutoff)])}`);
      return rows.map((r) => r["QUERY PLAN"]).join("\n");
    });
    expect(plan).toContain("deliveries_job_unsent_idx");
    expect(plan).toContain("deliveries_job_bounced_idx");
    expect(plan).toContain("job_recipients_pkey");
  });
});
```

Inside the top-level `describe` of `report-routes.test.ts`, add:

```ts
  describe("sends per release and digest runs", () => {
    beforeAll(async () => {
      const [s] = await tdb.db.insert(subscribers).values({ email: "reader@example.test", status: "active" }).returning({ id: subscribers.id });
      await tdb.db.insert(items).values({ key: "rr1", kind: "release", postKind: "releases", title: "-1 days to go", url: "https://news.example/rr1", publishedAt: new Date() });
      await tdb.db.insert(deliveries).values({ itemKey: "rr1", subscriberId: s!.id, mode: "as_it_happens", attemptedAt: new Date(), distributionBatchId: randomUUID() });
    });

    it("a Viewer reads and exports sends per release; a hostile title is neutralised", async () => {
      const page = await request(app).get("/api/reports/release-sends").set("authorization", `Bearer ${viewer}`);
      expect(page.status).toBe(200);
      expect(page.body).toMatchObject({ total: 1, page: 1, pageSize: 25, items: [{ itemKey: "rr1", asItHappens: { recipients: 1, delivered: 1 } }] });
      const csv = await getCsv(app, "/api/reports/release-sends.csv", viewer);
      expect(csv.status).toBe(200);
      expect(csv.headers["content-disposition"]).toMatch(/filename="release-sends-\d{4}-\d{2}-\d{2}\.csv"/);
      expect((csv.body as Buffer).toString("utf8")).toContain(",'-1 days to go,News release,1,1,0,0,0,0,0,0\r\n");
    });

    it("refuses a range longer than 92 days, a reversed one and an impossible date", async () => {
      const get = (q: string) => request(app).get(`/api/reports/release-sends?${q}`).set("authorization", `Bearer ${viewer}`);
      expect((await get("from=2026-01-01&to=2026-04-03")).body).toEqual({ error: "range-too-long", maxDays: 92 });
      expect((await get("from=2026-01-01&to=2026-04-02")).status).toBe(200);
      expect((await get("from=2026-02-02&to=2026-02-01")).body).toMatchObject({ error: "range-reversed" });
      expect((await get("from=2026-02-30")).body).toMatchObject({ error: "invalid-date" });
    });

    it("a Viewer reads and exports digest runs", async () => {
      const page = await request(app).get("/api/reports/digest-runs?from=2026-09-01&to=2026-09-30").set("authorization", `Bearer ${viewer}`);
      expect(page.body).toMatchObject({ from: "2026-09-01", to: "2026-09-30", total: 0, items: [] });
      const csv = await getCsv(app, "/api/reports/digest-runs.csv?from=2026-09-01&to=2026-09-30", viewer);
      expect((csv.body as Buffer).toString("utf8")).toBe("﻿Run (BC time),Ran at (BC time),Items in window,Subscribers,Delivered,Bounced,Not sent\r\n");
    });
  });
```

Add `deliveries`, `items` to that file's schema import, and `import { randomUUID } from "node:crypto";`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/reports apps/nod/src/digest.test.ts apps/nod/src/http/report-routes.test.ts`
Expected: FAIL. The new modules are missing, `digestJobKeyPrefix` is not exported, and the routes return 404.

- [ ] **Step 3: Indexes and migration; the job-key prefix**

In `apps/nod/src/db/schema.ts`, add to `deliveries`' index list:

```ts
    // Digest-run report (reports/digest-runs.ts): a run's emails not yet handed to Distribution,
    // and its bounced ones, found among a few thousand job rows without reading them all.
    index("deliveries_job_unsent_idx").on(t.jobId).where(sql`${t.distributionBatchId} IS NULL`),
    index("deliveries_job_bounced_idx").on(t.jobId).where(sql`${t.bounceStatus} IS NOT NULL`),
```

Run: `cd apps/nod && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name report_delivery_indexes`
Expected: `migrations/0024_report_delivery_indexes.sql` with two `CREATE INDEX ... WHERE` statements.

In `apps/nod/src/digest.ts`, add next to `DIGEST_HOUR`:

```ts
/** Every digest job of one run has a key starting with this; the digest-run report finds a run's
 * jobs by it. */
export function digestJobKeyPrefix(cutoff: Date): string {
  return `digest:${cutoff.toISOString()}:`;
}
/** toISOString is always 24 characters ("2026-10-07T00:00:00.000Z"), so every prefix is 32. */
export const DIGEST_JOB_PREFIX_LENGTH = 32;
```

In `createDigestJob`, replace ``const jobKey = `digest:${cutoff.toISOString()}:${hash}`;`` with ``const jobKey = `${digestJobKeyPrefix(cutoff)}${hash}`;`` (same string; the existing digest tests prove it).

- [ ] **Step 4: Implement `reports/release-sends.ts`**

```ts
/**
 * Sends per release (spec §8): each release or emergency item published in the range that went to
 * anyone as-it-happens or by media list, with recipients, delivered, bounced and not sent per mode.
 * Digest deliveries belong to the digest-run report. Sent = handed to Distribution; bounced = any
 * bounce recorded, hard or soft (legacy counted both).
 */
import { sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import type { CsvCell } from "./csv";
import { localDateTime, type ReportRange } from "./range";

export const RELEASE_SENDS_PAGE_SIZE = 25;

export interface ModeCounts {
  recipients: number;
  delivered: number;
  bounced: number;
  notSent: number;
}
export interface ReleaseSendRow {
  itemKey: string;
  title: string;
  type: string;
  publishedAt: string;
  asItHappens: ModeCounts;
  media: ModeCounts;
}
export interface RangedPage<T> {
  from: string;
  to: string;
  total: number;
  page: number;
  pageSize: number;
  items: T[];
}

const POST_KIND_LABELS: Record<string, string> = {
  releases: "News release",
  stories: "Story",
  factsheets: "Factsheet",
  updates: "Update",
  advisories: "Media advisory",
};
export function itemTypeLabel(kind: string, postKind: string | null): string {
  if (kind === "emergency") return "Emergency alert";
  return (postKind ? POST_KIND_LABELS[postKind] : undefined) ?? "Release";
}

/** Newest first. The LATERAL count reads one item's deliveries by primary key; LIMIT stops the
 * walk down items_published_at_idx as soon as a page is full. */
export function releaseSendsSql(range: ReportRange, limit: number, offset: number): SQL {
  return sql`
    SELECT i.key, i.title, i.kind, i.post_kind, i.published_at, c.*
      FROM items i
      JOIN LATERAL (
        SELECT count(*) FILTER (WHERE d.mode = 'as_it_happens')::int AS aih_recipients,
               count(*) FILTER (WHERE d.mode = 'as_it_happens' AND d.distribution_batch_id IS NOT NULL)::int AS aih_sent,
               count(*) FILTER (WHERE d.mode = 'as_it_happens' AND d.bounce_status IS NOT NULL)::int AS aih_bounced,
               count(*) FILTER (WHERE d.mode = 'media')::int AS media_recipients,
               count(*) FILTER (WHERE d.mode = 'media' AND d.distribution_batch_id IS NOT NULL)::int AS media_sent,
               count(*) FILTER (WHERE d.mode = 'media' AND d.bounce_status IS NOT NULL)::int AS media_bounced
          FROM deliveries d
         WHERE d.item_key = i.key AND d.mode IN ('as_it_happens', 'media')) c ON c.aih_recipients + c.media_recipients > 0
     WHERE i.published_at >= ${range.start} AND i.published_at < ${range.end}
     ORDER BY i.published_at DESC, i.key DESC
     LIMIT ${limit} OFFSET ${offset}`;
}

interface RawRow {
  key: string;
  title: string;
  kind: string;
  post_kind: string | null;
  published_at: string;
  aih_recipients: number;
  aih_sent: number;
  aih_bounced: number;
  media_recipients: number;
  media_sent: number;
  media_bounced: number;
}
const counts = (recipients: number, sent: number, bounced: number): ModeCounts => ({ recipients, delivered: sent - bounced, bounced, notSent: recipients - sent });
const toRow = (r: RawRow): ReleaseSendRow => ({
  itemKey: r.key,
  title: r.title,
  type: itemTypeLabel(r.kind, r.post_kind),
  publishedAt: new Date(r.published_at).toISOString(),
  asItHappens: counts(r.aih_recipients, r.aih_sent, r.aih_bounced),
  media: counts(r.media_recipients, r.media_sent, r.media_bounced),
});

export async function releaseSendsPage(db: DbOrTx, range: ReportRange, page: number): Promise<RangedPage<ReleaseSendRow>> {
  const { rows } = await db.execute<RawRow>(releaseSendsSql(range, RELEASE_SENDS_PAGE_SIZE, (page - 1) * RELEASE_SENDS_PAGE_SIZE));
  const { rows: total } = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM items i
     WHERE i.published_at >= ${range.start} AND i.published_at < ${range.end}
       AND EXISTS (SELECT 1 FROM deliveries d WHERE d.item_key = i.key AND d.mode IN ('as_it_happens', 'media'))`);
  return { from: range.from, to: range.to, total: total[0]!.n, page, pageSize: RELEASE_SENDS_PAGE_SIZE, items: rows.map(toRow) };
}

export async function* releaseSendBatches(db: DbOrTx, range: ReportRange, batchSize = 500): AsyncGenerator<ReleaseSendRow[]> {
  for (let offset = 0; ; offset += batchSize) {
    const { rows } = await db.execute<RawRow>(releaseSendsSql(range, batchSize, offset));
    if (rows.length > 0) yield rows.map(toRow);
    if (rows.length < batchSize) return;
  }
}

export const RELEASE_SENDS_CSV_HEADER = [
  "Published (BC time)", "Title", "Type",
  "As it happens: recipients", "As it happens: delivered", "As it happens: bounced", "As it happens: not sent",
  "Media: recipients", "Media: delivered", "Media: bounced", "Media: not sent",
];
export function releaseSendCsvRow(r: ReleaseSendRow, timeZone: string): CsvCell[] {
  const m = (c: ModeCounts): CsvCell[] => [c.recipients, c.delivered, c.bounced, c.notSent];
  return [localDateTime(new Date(r.publishedAt), timeZone), r.title, r.type, ...m(r.asItHappens), ...m(r.media)];
}
```

- [ ] **Step 5: Implement `reports/digest-runs.ts`**

```ts
/**
 * Daily digest runs (spec §8): one row per run (its 17:00 cutoff) in the range. Units are emails,
 * one per subscriber per run, not delivery rows (a digest leaves one row per item). A run's jobs
 * are found by their key prefix; cancelled jobs (every item withdrawn) sent nothing and are left
 * out. "Items" counts what the run's window offered: the digest's own filter, before matching.
 */
import { and, desc, gte, lt, sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import { digestRuns, items } from "../db/schema";
import { DIGEST_JOB_PREFIX_LENGTH, digestJobKeyPrefix } from "../digest";
import type { CsvCell } from "./csv";
import { localDateTime, type ReportRange } from "./range";
import type { RangedPage } from "./release-sends";

export const DIGEST_RUNS_PAGE_SIZE = 31;

export interface DigestRunRow {
  cutoff: string;
  ranAt: string;
  items: number;
  subscribers: number;
  delivered: number;
  bounced: number;
  notSent: number;
}

const inRange = (range: ReportRange) => and(gte(digestRuns.cutoff, range.start), lt(digestRuns.cutoff, range.end));

function runs(db: DbOrTx, range: ReportRange, limit: number, offset: number) {
  return db
    .select({
      cutoff: digestRuns.cutoff,
      ranAt: digestRuns.ranAt,
      items: sql<number>`(SELECT count(*)::int FROM ${items} i
         WHERE i.kind = 'release' AND i.to_subscribers AND i.withdrawn_at IS NULL
           AND COALESCE(i.post_kind, '') <> 'advisories'
           AND i.published_at > ${digestRuns.windowStart} AND i.published_at <= ${digestRuns.cutoff})`,
    })
    .from(digestRuns)
    .where(inRange(range))
    .orderBy(desc(digestRuns.cutoff))
    .limit(limit)
    .offset(offset);
}

/** Emails per run prefix: all, not yet handed to Distribution, and bounced. */
export function digestRunCountsSql(prefixes: string[]): SQL {
  return sql`
    WITH jobs AS (
      SELECT left(j.job_key, ${DIGEST_JOB_PREFIX_LENGTH}) AS prefix, j.id
        FROM send_jobs j
       WHERE j.kind = 'digest' AND j.status <> 'cancelled'
         AND left(j.job_key, ${DIGEST_JOB_PREFIX_LENGTH}) = ANY(${sql.param(prefixes)}::text[])),
    per AS (SELECT prefix, array_agg(id) AS ids FROM jobs GROUP BY prefix)
    SELECT per.prefix,
           (SELECT count(*) FROM job_recipients jr WHERE jr.job_id = ANY(per.ids))::int AS emails,
           (SELECT count(DISTINCT d.subscriber_id) FROM deliveries d
             WHERE d.job_id = ANY(per.ids) AND d.distribution_batch_id IS NULL)::int AS not_sent,
           (SELECT count(DISTINCT d.subscriber_id) FROM deliveries d
             WHERE d.job_id = ANY(per.ids) AND d.bounce_status IS NOT NULL)::int AS bounced
      FROM per`;
}

async function withCounts(db: DbOrTx, rows: { cutoff: Date; ranAt: Date; items: number }[]): Promise<DigestRunRow[]> {
  if (rows.length === 0) return [];
  const { rows: counts } = await db.execute<{ prefix: string; emails: number; not_sent: number; bounced: number }>(
    digestRunCountsSql(rows.map((r) => digestJobKeyPrefix(r.cutoff))),
  );
  const by = new Map(counts.map((c) => [c.prefix, c]));
  return rows.map((r) => {
    const c = by.get(digestJobKeyPrefix(r.cutoff));
    const emails = c?.emails ?? 0;
    const notSent = c?.not_sent ?? 0;
    const bounced = c?.bounced ?? 0;
    return {
      cutoff: r.cutoff.toISOString(),
      ranAt: r.ranAt.toISOString(),
      items: r.items,
      subscribers: emails,
      delivered: Math.max(0, emails - notSent - bounced),
      bounced,
      notSent,
    };
  });
}

export async function digestRunsPage(db: DbOrTx, range: ReportRange, page: number): Promise<RangedPage<DigestRunRow>> {
  const rows = await runs(db, range, DIGEST_RUNS_PAGE_SIZE, (page - 1) * DIGEST_RUNS_PAGE_SIZE);
  const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(digestRuns).where(inRange(range))) as [{ n: number }];
  return { from: range.from, to: range.to, total: n, page, pageSize: DIGEST_RUNS_PAGE_SIZE, items: await withCounts(db, rows) };
}

/** A range holds at most 92 runs (one cutoff a day, catch-ups included), so one batch. */
export async function* digestRunBatches(db: DbOrTx, range: ReportRange): AsyncGenerator<DigestRunRow[]> {
  yield await withCounts(db, await runs(db, range, 1000, 0));
}

export const DIGEST_RUNS_CSV_HEADER = ["Run (BC time)", "Ran at (BC time)", "Items in window", "Subscribers", "Delivered", "Bounced", "Not sent"];
export function digestRunCsvRow(r: DigestRunRow, timeZone: string): CsvCell[] {
  return [localDateTime(new Date(r.cutoff), timeZone), localDateTime(new Date(r.ranAt), timeZone), r.items, r.subscribers, r.delivered, r.bounced, r.notSent];
}
```

- [ ] **Step 6: Add the routes**

In `apps/nod/src/http/report-routes.ts`:
- Import `resolveRange` from `../reports/range`.
- Import `RELEASE_SENDS_CSV_HEADER`, `releaseSendBatches`, `releaseSendCsvRow`, `releaseSendsPage` from `../reports/release-sends`.
- Import `DIGEST_RUNS_CSV_HEADER`, `digestRunBatches`, `digestRunCsvRow`, `digestRunsPage` from `../reports/digest-runs`.
- Import `type Request` from `express`.

Then add the module-level schema and helper:

```ts
const dateParam = z.preprocess(emptyToUndefined, z.string().max(10).optional());
export const rangeQuery = z.object({ from: dateParam, to: dateParam, page: pageParam });
```

Inside `reportRoutes`:

```ts
  const rangeOf = async (req: Request) => {
    const q = rangeQuery.parse(req.query);
    const today = await bcToday(db, deps.timeZone);
    return { range: resolveRange(q, today, deps.timeZone), page: q.page, today };
  };

  r.get("/reports/release-sends", read, privateErrors(async (req, res) => {
    const { range, page } = await rangeOf(req);
    res.json(await releaseSendsPage(db, range, page));
  }));

  r.get("/reports/release-sends.csv", read, privateErrors(async (req, res) => {
    const { range, today } = await rangeOf(req);
    await streamCsv(res, csvFilename("release-sends", today), RELEASE_SENDS_CSV_HEADER, mapBatches(releaseSendBatches(db, range), (s) => releaseSendCsvRow(s, deps.timeZone)));
  }));

  r.get("/reports/digest-runs", read, privateErrors(async (req, res) => {
    const { range, page } = await rangeOf(req);
    res.json(await digestRunsPage(db, range, page));
  }));

  r.get("/reports/digest-runs.csv", read, privateErrors(async (req, res) => {
    const { range, today } = await rangeOf(req);
    await streamCsv(res, csvFilename("digest-runs", today), DIGEST_RUNS_CSV_HEADER, mapBatches(digestRunBatches(db, range), (d) => digestRunCsvRow(d, deps.timeZone)));
  }));
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/reports apps/nod/src/digest.test.ts apps/nod/src/send-jobs.test.ts apps/nod/src/http/report-routes.test.ts apps/nod/src/db/migrations.test.ts`
Expected: PASS. Then run both type-checks.

- [ ] **Step 8: Write the volume probe**

`apps/nod/src/reports/volume.probe.test.ts`:

```ts
// Legacy-volume probe for every NoD report (Q21's Jul–Sep rates, 90 days). Opt-in: seeding 3.8 M
// delivery rows takes about half a minute. Run with REPORT_PROBE=1; prints timings (numbers only)
// and asserts the plan's budgets.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../../test/helpers";
import { memberBatches, membersPage, subscribersByList } from "./by-list";
import { digestRunBatches, digestRunsPage } from "./digest-runs";
import { localDate, resolveRange, addDays } from "./range";
import { releaseSendBatches, releaseSendsPage } from "./release-sends";
import { unsubscribeBatches, unsubscribesPage, unsubscribeWindow } from "./unsubscribes";

const BC = "America/Vancouver";

async function bestOf(n: number, f: () => Promise<unknown>): Promise<number> {
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await f();
    best = Math.min(best, performance.now() - t0);
  }
  return Math.round(best);
}
async function drain<T>(batches: AsyncIterable<T[]>): Promise<number> {
  let n = 0;
  for await (const b of batches) n += b.length;
  return n;
}

describe.runIf(process.env.REPORT_PROBE === "1")("report volume probe (legacy volume, 90 days)", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    await tdb.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`
        CREATE TEMP TABLE probe_subs ON COMMIT DROP AS SELECT g AS n, gen_random_uuid() AS id FROM generate_series(1, 20000) g;
        INSERT INTO subscribers (id, email, status, as_it_happens, digest, source)
          SELECT id, 'probe-' || n || '@example.test', 'active', n <= 19000, n BETWEEN 10001 AND 12750,
                 CASE WHEN n > 19800 THEN 'manual-media' ELSE 'self' END
            FROM probe_subs;
        INSERT INTO lists (list_key, category, key, name)
          SELECT 'ministries:probe-' || g, 'ministries', 'probe-' || g, 'Probe ministry ' || g FROM generate_series(1, 30) g;
        INSERT INTO subscriptions (subscriber_id, list_key)
          SELECT s.id, 'ministries:probe-' || ((s.n + k) % 30 + 1) FROM probe_subs s, generate_series(0, 2) k ON CONFLICT DO NOTHING;
        INSERT INTO subscriber_history (subscriber_id, at, actor, action)
          SELECT id, now() - ((n % 400) || ' days')::interval, 'subscriber', 'subscribed' FROM probe_subs;
        INSERT INTO subscriber_history (subscriber_id, at, actor, action)
          SELECT id, now() - ((n % 90) || ' days')::interval, 'subscriber', 'unsubscribed' FROM probe_subs WHERE n % 2 = 0;
        INSERT INTO items (key, kind, post_kind, title, url, published_at)
          SELECT 'probe-' || d || '-' || i, 'release', 'releases', 'Probe release ' || d || '-' || i, 'https://news.example/' || d || '-' || i,
                 now() - (d || ' days')::interval + (i || ' minutes')::interval
            FROM generate_series(1, 90) d, generate_series(1, 20) i;
        -- As it happens: 900 recipients a release, about 18,000 a day.
        INSERT INTO deliveries (subscriber_id, item_key, mode, attempted_at, distribution_batch_id, bounce_status)
          SELECT s.id, i.key, 'as_it_happens', i.published_at, gen_random_uuid(), CASE WHEN random() < 0.001 THEN '5.1.1' END
            FROM items i JOIN probe_subs s ON s.n BETWEEN (abs(hashtext(i.key)) % 18000) + 1 AND (abs(hashtext(i.key)) % 18000) + 900
           WHERE i.key LIKE 'probe-%';
        -- Media: 10 releases a day to 200 members, about 2,000 a day.
        INSERT INTO deliveries (subscriber_id, item_key, mode, attempted_at, distribution_batch_id, bounce_status)
          SELECT s.id, i.key, 'media', i.published_at, gen_random_uuid(), CASE WHEN random() < 0.006 THEN '5.1.1' END
            FROM items i JOIN probe_subs s ON s.n > 19800
           WHERE i.key LIKE 'probe-%' AND split_part(i.key, '-', 3)::int <= 10;
        -- Digest: 90 runs, 25 groups of 110 subscribers (2,750 a run), 8 items each.
        INSERT INTO digest_runs (cutoff, window_start, subscribers, groups)
          SELECT date_trunc('day', now()) - (d || ' days')::interval + interval '1 day', date_trunc('day', now()) - (d || ' days')::interval, 2750, 25
            FROM generate_series(1, 90) d;
        INSERT INTO send_jobs (job_key, kind, priority, status)
          SELECT 'digest:' || to_char(r.cutoff AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || ':' || lpad(g::text, 16, '0'), 'digest', 'digest', 'sent'
            FROM digest_runs r, generate_series(1, 25) g;
        INSERT INTO job_recipients (job_id, subscriber_id)
          SELECT j.id, s.id FROM send_jobs j
            JOIN probe_subs s ON s.n BETWEEN 10001 + (right(j.job_key, 2)::int - 1) * 110 AND 10000 + right(j.job_key, 2)::int * 110
           WHERE j.kind = 'digest';
        INSERT INTO deliveries (subscriber_id, item_key, mode, job_id, attempted_at, distribution_batch_id)
          SELECT jr.subscriber_id, 'probe-' || r.d || '-' || k, 'digest', jr.job_id, r.cutoff, gen_random_uuid()
            FROM job_recipients jr
            JOIN send_jobs j ON j.id = jr.job_id
            JOIN (SELECT cutoff, extract(day FROM date_trunc('day', now()) + interval '1 day' - cutoff)::int AS d FROM digest_runs) r
              ON left(j.job_key, 32) = 'digest:' || to_char(r.cutoff AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || ':'
           CROSS JOIN generate_series(1, 8) k
          ON CONFLICT DO NOTHING;
      `));
    });
    await tdb.db.execute(sql`VACUUM ANALYZE`);
  }, 300_000);
  afterAll(async () => tdb.drop());

  it("meets every budget", async () => {
    const today = localDate(new Date(), BC);
    const range90 = resolveRange({ from: addDays(today, -89), to: today }, today, BC);
    const window = await unsubscribeWindow(tdb.db, BC);
    const t = {
      byList: await bestOf(3, () => subscribersByList(tdb.db)),
      membersPage: await bestOf(3, () => membersPage(tdb.db, { list: "all", timing: "any", page: 1 })),
      membersAll: await bestOf(3, () => drain(memberBatches(tdb.db, "all", "any"))),
      unsubscribesPage: await bestOf(3, () => unsubscribesPage(tdb.db, window, 1)),
      unsubscribesAll: await bestOf(3, () => drain(unsubscribeBatches(tdb.db, window))),
      releasePage: await bestOf(3, () => releaseSendsPage(tdb.db, range90, 1)),
      releaseAll: await bestOf(3, () => drain(releaseSendBatches(tdb.db, range90))),
      digestPage: await bestOf(3, () => digestRunsPage(tdb.db, range90, 1)),
      digestAll: await bestOf(3, () => drain(digestRunBatches(tdb.db, range90))),
    };
    console.log("[probe] NoD report timings (ms, best of 3):", JSON.stringify(t));
    expect(await drain(releaseSendBatches(tdb.db, range90))).toBeGreaterThan(1700);
    expect(t.byList).toBeLessThan(300);
    expect(t.membersPage).toBeLessThan(300);
    expect(t.membersAll).toBeLessThan(1000);
    expect(t.unsubscribesPage).toBeLessThan(300);
    expect(t.unsubscribesAll).toBeLessThan(1000);
    expect(t.releasePage).toBeLessThan(300);
    expect(t.releaseAll).toBeLessThan(2000);
    expect(t.digestPage).toBeLessThan(300);
    expect(t.digestAll).toBeLessThan(1000);
  }, 300_000);
});
```

Run: `REPORT_PROBE=1 npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/reports/volume.probe.test.ts`
Expected: PASS, with one `[probe]` line. Keep that line for Task 7.

If a budget fails:
1. Run the slow query under `EXPLAIN (ANALYZE, BUFFERS)` against the probe database before changing anything.
2. Fix the query or the index, not the budget.
3. If the fix needs a schema change, raise it with the controller instead of improvising.

Without `REPORT_PROBE`, the file reports one skipped suite.

- [ ] **Step 9: Commit**

```bash
git add apps/nod/src/reports apps/nod/src/digest.ts apps/nod/src/digest.test.ts apps/nod/src/http/report-routes.ts apps/nod/src/http/report-routes.test.ts apps/nod/src/db/schema.ts apps/nod/migrations
git commit -m "feat(nod): sends per release and daily digest run reports, partial delivery indexes, legacy-volume probe"
```

---

### Task 4: Distribution sent vs bounced (Distribution + NoD)

Covers spec §8's "Distribution sent vs bounced".

**Files:**
- Create:
  - `apps/distribution/src/reports.ts` (+ `reports.test.ts`, `reports.probe.test.ts`);
  - `apps/nod/src/reports/distribution.ts` (+ `distribution.test.ts`).
- Modify, Distribution:
  - `apps/distribution/src/db/schema.ts` (two partial `messages` indexes) + generated migration `0010_report_indexes`;
  - `apps/distribution/src/http/routes.ts` (`POST /reports/daily`), `routes.test.ts`.
- Modify, NoD:
  - `apps/nod/src/distribution-client.ts` (`DailyReportRow`, `dailyReport`);
  - `apps/nod/src/http/routes.ts:61-70` (`SettingsRouteDeps` gains `nodAppId`; its `distribution` Pick gains `"dailyReport"`);
  - `apps/nod/src/app.ts:37,54-60,113-126` (`AppDeps.distribution` Pick and `noDistribution` gain `dailyReport`; `nodAppId: deps.distributionAppId ?? "nod"`);
  - `apps/nod/src/http/report-routes.ts`, `report-routes.test.ts`.
  - Any test stub typed as the narrowed Pick (not cast) gains `dailyReport: vi.fn()`. `tsc` lists them.

**Interfaces:**
- Consumes:
  - `ReportRange`, `addDays`, `bcToday`, `resolveRange` (`range.ts`);
  - `rangeQuery` (`report-routes.ts`);
  - `streamCsv`, `oneBatch`, `csvFilename` (`csv.ts`);
  - `DistributionError` (`distribution-client.ts`).
- Produces (Distribution, `reports.ts`):
  - `MAX_REPORT_DAYS = 92`, `dailyReportSchema`;
  - `DailyReportRow { day: number; appId: string; sent: number; hardBounced: number; softBounced: number; failed: number }`;
  - `dailyReportSql(bounds: Date[]): SQL`, `dailyReport(db, bounds): Promise<DailyReportRow[]>`;
  - route `POST /api/reports/daily` (`Distribution.Operate`), body `{ bounds: string[] }` (2 to 93 increasing ISO instants), response `{ rows: DailyReportRow[] }`.
- Produces (NoD):
  - `DistributionClient.dailyReport(bounds: string[]): Promise<{ rows: DailyReportRow[] }>`;
  - in `reports/distribution.ts`: `DeliveryCounts { sent; delivered; hardBounced; softBounced; failed }`, `DistributionReport { from; to; totals: DeliveryCounts; apps: ({ app: string } & DeliveryCounts)[]; days: ({ date: string; app: string } & DeliveryCounts)[] }`, `distributionReport(client, range, nodAppId)`, `DISTRIBUTION_CSV_HEADER`, `distributionCsvRows(report)`;
  - `type ReportRouteDeps = Pick<SettingsRouteDeps, "timeZone" | "distribution" | "nodAppId">`.
- NoD routes (read): `GET /reports/distribution?from=&to=` and `.csv`.
- **Definitions (R12):**
  - **Sent:** a `sent` message, bucketed by `sent_at`.
  - **Bounces:** split by `bounce_hard` (true = hard, false = soft).
  - **Delivered:** sent − hard − soft (legacy: Success = Sent − Bounced).
  - **Failed:** a `failed` message, bucketed by its batch's `created_at`, because a failed message has no send time.

- [ ] **Step 1: Write the failing tests (Distribution)**

`apps/distribution/src/reports.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createDistributionTestDb } from "../test/helpers";
import { batches, messages } from "./db/schema";
import { dailyReport, dailyReportSql } from "./reports";

// BC midnights either side of 2026-11-01: 07:00Z both, BC stays on UTC−7 (NoD computes these).
const BOUNDS = ["2026-10-31T07:00:00.000Z", "2026-11-01T07:00:00.000Z", "2026-11-02T07:00:00.000Z"].map((s) => new Date(s));

describe("Distribution daily report", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createDistributionTestDb();
    const [nod, nrms] = await tdb.db
      .insert(batches)
      .values([
        { appId: "nod", subject: "s", html: "<p>h</p>", createdAt: new Date("2026-10-31T20:00:00Z") },
        { appId: "nrms", subject: "s", html: "<p>h</p>", createdAt: new Date("2026-11-01T09:00:00Z") },
      ])
      .returning({ id: batches.id });
    const m = (batchId: string, over: Partial<typeof messages.$inferInsert>) => ({ batchId, email: "x@example.test", priority: 30, ...over });
    await tdb.db.insert(messages).values([
      m(nod!.id, { status: "sent", sentAt: new Date("2026-11-01T06:30:00Z") }), // 23:30 BC on Oct 31
      m(nod!.id, { status: "sent", sentAt: new Date("2026-11-01T07:30:00Z"), bouncedAt: new Date(), bounceHard: true }),
      m(nod!.id, { status: "sent", sentAt: new Date("2026-11-01T08:00:00Z"), bouncedAt: new Date(), bounceHard: false }),
      m(nod!.id, { status: "failed" }),
      m(nod!.id, { status: "pending" }),
      m(nod!.id, { status: "sent", sentAt: new Date("2026-11-02T07:00:00Z") }), // first instant after the range
      m(nrms!.id, { status: "sent", sentAt: new Date("2026-11-01T10:00:00Z") }),
    ]);
  });
  afterAll(async () => tdb.drop());

  it("counts by the given day boundaries and app: sent and bounces by send time, failures by queue time", async () => {
    expect(await dailyReport(tdb.db, BOUNDS)).toEqual([
      { day: 0, appId: "nod", sent: 1, hardBounced: 0, softBounced: 0, failed: 1 },
      { day: 1, appId: "nod", sent: 2, hardBounced: 1, softBounced: 1, failed: 0 },
      { day: 1, appId: "nrms", sent: 1, hardBounced: 0, softBounced: 0, failed: 0 },
    ]);
  });

  it("reads a month out of a long history through messages_sent_at_idx", async () => {
    const [b] = await tdb.db.insert(batches).values({ appId: "nod", subject: "s", html: "<p>h</p>" }).returning({ id: batches.id });
    await tdb.db.execute(sql.raw(`
      INSERT INTO messages (batch_id, email, priority, status, sent_at)
      SELECT '${b!.id}', 'user' || g || '@example.test', 30, 'sent', now() - ((g % 400) || ' days')::interval
        FROM generate_series(1, 60000) g;
      ANALYZE messages;
    `));
    const now = Date.now();
    const month = Array.from({ length: 31 }, (_, i) => new Date(now - (30 - i) * 86_400_000));
    const { rows } = await tdb.db.execute<{ "QUERY PLAN": string }>(sql`EXPLAIN ${dailyReportSql(month)}`);
    const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(plan).toContain("messages_sent_at_idx");
    expect(plan).not.toMatch(/Seq Scan on messages/);
  });
});
```

The failed-message branch of the plan reads `messages_failed_batch_idx`. With only one failed row, the planner may still choose it or scan. The assertion above covers the sent branch only.

In `apps/distribution/src/http/routes.test.ts`, add a `describe` after `GET /api/bounces/stats`:

```ts
  describe("POST /api/reports/daily", () => {
    const post = (token: string | null, body: unknown) => {
      const r = request(app).post("/api/reports/daily").send(body as object);
      return token ? r.set("authorization", `Bearer ${token}`) : r;
    };
    const bounds = ["2026-09-01T07:00:00.000Z", "2026-09-02T07:00:00.000Z"];

    it("401s without a token, 403s without Distribution.Operate", async () => {
      expect((await post(null, { bounds })).status).toBe(401);
      expect((await post(reader, { bounds })).status).toBe(403);
    });

    it("400s bounds that are missing, too few, too many, not increasing or not dates", async () => {
      expect((await post(operator, {})).status).toBe(400);
      expect((await post(operator, { bounds: [bounds[0]] })).status).toBe(400);
      expect((await post(operator, { bounds: [bounds[1], bounds[0]] })).status).toBe(400);
      expect((await post(operator, { bounds: [bounds[0], "not-a-date"] })).status).toBe(400);
      const tooMany = Array.from({ length: 94 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i, 8)).toISOString());
      expect((await post(operator, { bounds: tooMany })).status).toBe(400);
    });

    it("returns the rows for a valid range", async () => {
      const res = await post(operator, { bounds });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ rows: expect.any(Array) });
    });
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/distribution/src/reports.test.ts apps/distribution/src/http/routes.test.ts`
Expected: FAIL ("Failed to load url ./reports"; the route returns 404).

- [ ] **Step 3: Distribution indexes, migration, module and route**

In `apps/distribution/src/db/schema.ts`, add to `messages`' index list:

```ts
    // Daily report (reports.ts): sent messages by send time with their batch and bounce kind, so a
    // month's counts read this index alone instead of the table.
    index("messages_sent_at_idx").on(t.sentAt, t.batchId, t.bounceHard).where(sql`${t.status} = 'sent'`),
    // Daily report: failed messages are few; find them without a scan.
    index("messages_failed_batch_idx").on(t.batchId).where(sql`${t.status} = 'failed'`),
```

Run: `cd apps/distribution && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name report_indexes`
Expected: `migrations/0010_report_indexes.sql` with two `CREATE INDEX` statements.

`apps/distribution/src/reports.ts`:

```ts
/**
 * Sent vs bounced per day and sending app, for NoD's staff report (spec §8). The caller supplies
 * the day boundaries (NoD computes BC midnights from its tenant zone), so this service stays
 * zone-free and Postgres's own tzdata is never consulted. Day i is [bounds[i], bounds[i + 1]).
 */
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx } from "@gcpe/db-kit";

/** NoD caps a report at 92 days; one more boundary closes the last day. */
export const MAX_REPORT_DAYS = 92;
const isoInstant = z.string().refine((s) => !Number.isNaN(Date.parse(s)), { message: "must be a valid date" });
export const dailyReportSchema = z
  .object({ bounds: z.array(isoInstant).min(2).max(MAX_REPORT_DAYS + 1) })
  .refine((b) => b.bounds.every((v, i) => i === 0 || Date.parse(v) > Date.parse(b.bounds[i - 1]!)), { message: "bounds must increase", path: ["bounds"] });

export interface DailyReportRow {
  day: number;
  appId: string;
  sent: number;
  hardBounced: number;
  softBounced: number;
  failed: number;
}

/** Sent and bounced count by send time; failed by when the batch was queued (no send time). */
export function dailyReportSql(bounds: Date[]): SQL {
  const first = bounds[0]!;
  const last = bounds[bounds.length - 1]!;
  const edges = sql`${sql.param(bounds.map((b) => b.toISOString()))}::timestamptz[]`;
  return sql`
    WITH sent AS (
      SELECT width_bucket(m.sent_at, ${edges}) - 1 AS day, b.app_id,
             count(*)::int AS sent,
             count(*) FILTER (WHERE m.bounce_hard)::int AS hard,
             count(*) FILTER (WHERE m.bounce_hard = false)::int AS soft
        FROM messages m JOIN batches b ON b.id = m.batch_id
       WHERE m.status = 'sent' AND m.sent_at >= ${first} AND m.sent_at < ${last}
       GROUP BY 1, 2),
    failed AS (
      SELECT width_bucket(b.created_at, ${edges}) - 1 AS day, b.app_id, count(*)::int AS failed
        FROM messages m JOIN batches b ON b.id = m.batch_id
       WHERE m.status = 'failed' AND b.created_at >= ${first} AND b.created_at < ${last}
       GROUP BY 1, 2)
    SELECT COALESCE(s.day, f.day) AS day, COALESCE(s.app_id, f.app_id) AS app_id,
           COALESCE(s.sent, 0) AS sent, COALESCE(s.hard, 0) AS hard_bounced,
           COALESCE(s.soft, 0) AS soft_bounced, COALESCE(f.failed, 0) AS failed
      FROM sent s FULL JOIN failed f ON f.day = s.day AND f.app_id = s.app_id
     ORDER BY 1, 2`;
}

export async function dailyReport(db: DbOrTx, bounds: Date[]): Promise<DailyReportRow[]> {
  const { rows } = await db.execute<{ day: number; app_id: string; sent: number; hard_bounced: number; soft_bounced: number; failed: number }>(dailyReportSql(bounds));
  return rows.map((r) => ({ day: r.day, appId: r.app_id, sent: r.sent, hardBounced: r.hard_bounced, softBounced: r.soft_bounced, failed: r.failed }));
}
```

In `apps/distribution/src/http/routes.ts`, import `dailyReport, dailyReportSchema` from `../reports` and add, after the `/bounces/stats` route:

```ts
  // NoD's staff report (spec §8): sent vs bounced per day and app, between day boundaries NoD
  // computes from its tenant zone. A read, but POST: up to 93 instants don't belong in a URL.
  r.post(
    "/reports/daily",
    requireRole("Distribution.Operate"),
    run(async (req, res) => {
      const { bounds } = dailyReportSchema.parse(req.body);
      res.json({ rows: await dailyReport(db, bounds.map((b) => new Date(b))) });
    }),
  );
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/distribution`
Expected: PASS.

- [ ] **Step 4: Write the failing tests (NoD)**

`apps/nod/src/reports/distribution.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { DistributionClient } from "../distribution-client";
import { csvLine } from "./csv";
import { distributionCsvRows, distributionReport } from "./distribution";
import { resolveRange } from "./range";

const BC = "America/Vancouver";

describe("distribution report", () => {
  it("asks Distribution for BC-midnight boundaries and labels, totals and dates its rows", async () => {
    const dailyReport = vi.fn().mockResolvedValue({
      rows: [
        { day: 0, appId: "nod-client", sent: 10, hardBounced: 1, softBounced: 2, failed: 1 },
        { day: 1, appId: "nod-client", sent: 5, hardBounced: 0, softBounced: 0, failed: 0 },
        { day: 1, appId: "nrms-client", sent: 3, hardBounced: 1, softBounced: 0, failed: 0 },
      ],
    });
    const range = resolveRange({ from: "2026-10-31", to: "2026-11-01" }, "2026-11-05", BC);
    const report = await distributionReport({ dailyReport } as unknown as Pick<DistributionClient, "dailyReport">, range, "nod-client");

    expect(dailyReport).toHaveBeenCalledWith(["2026-10-31T07:00:00.000Z", "2026-11-01T07:00:00.000Z", "2026-11-02T07:00:00.000Z"]);
    expect(report.totals).toEqual({ sent: 18, delivered: 14, hardBounced: 2, softBounced: 2, failed: 1 });
    expect(report.apps).toEqual([
      { app: "News On Demand", sent: 15, delivered: 12, hardBounced: 1, softBounced: 2, failed: 1 },
      { app: "nrms-client", sent: 3, delivered: 2, hardBounced: 1, softBounced: 0, failed: 0 },
    ]);
    expect(report.days.map((d) => [d.date, d.app, d.sent])).toEqual([
      ["2026-11-01", "News On Demand", 5],
      ["2026-11-01", "nrms-client", 3],
      ["2026-10-31", "News On Demand", 10],
    ]);
    expect(distributionCsvRows(report).map((r) => csvLine(r))).toContain("2026-10-31,News On Demand,10,7,1,2,1\r\n");
  });
});
```

Inside the top-level `describe` of `report-routes.test.ts`, add:

```ts
  describe("distribution", () => {
    it("a Viewer reads and exports Distribution's counts", async () => {
      vi.mocked(distribution.dailyReport).mockResolvedValue({ rows: [{ day: 0, appId: "nod", sent: 4, hardBounced: 1, softBounced: 0, failed: 0 }] });
      const res = await request(app).get("/api/reports/distribution?from=2026-09-01&to=2026-09-02").set("authorization", `Bearer ${viewer}`);
      expect(res.status).toBe(200);
      expect(res.body.days).toEqual([{ date: "2026-09-01", app: "News On Demand", sent: 4, delivered: 3, hardBounced: 1, softBounced: 0, failed: 0 }]);
      const csv = await getCsv(app, "/api/reports/distribution.csv?from=2026-09-01&to=2026-09-02", viewer);
      expect((csv.body as Buffer).toString("utf8")).toBe("﻿Date,Sent by,Sent,Delivered,Hard bounces,Soft bounces,Failed\r\n2026-09-01,News On Demand,4,3,1,0,0\r\n");
    });

    it("Distribution down: 502, and the log carries a label, not Distribution's body", async () => {
      vi.mocked(distribution.dailyReport).mockRejectedValue(new DistributionError("Distribution responded HTTP 500: secret-body", true, 500));
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const res = await request(app).get("/api/reports/distribution").set("authorization", `Bearer ${viewer}`);
      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: "distribution unavailable" });
      expect(errors.mock.calls.flat().map(String).join("\n")).not.toContain("secret-body");
      expect((await request(app).get("/api/reports/subscribers-by-list").set("authorization", `Bearer ${viewer}`)).status).toBe(200);
    });
  });
```

Add `import { DistributionError } from "../distribution-client";` to that file. Its `distribution` stub already has `dailyReport: vi.fn()` (Task 1).

- [ ] **Step 5: Run them to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/reports/distribution.test.ts apps/nod/src/http/report-routes.test.ts`
Expected: FAIL ("Failed to load url ./distribution"; the route returns 404).

- [ ] **Step 6: NoD client, report module, deps and routes**

In `apps/nod/src/distribution-client.ts`:
- Add the exported type next to `MessageRecipient`:

```ts
/** One day × sending app of Distribution's daily report (apps/distribution/src/reports.ts). */
export interface DailyReportRow {
  day: number;
  appId: string;
  sent: number;
  hardBounced: number;
  softBounced: number;
  failed: number;
}
```

- Add to the `DistributionClient` interface:

```ts
  /** Sent, bounced and failed counts per day and app (`POST /api/reports/daily`,
   * Distribution.Operate) between the given increasing ISO instants (day i is
   * [bounds[i], bounds[i + 1])). NoD computes the boundaries in its tenant zone. */
  dailyReport(bounds: string[]): Promise<{ rows: DailyReportRow[] }>;
```

- Add the schema beside the other response schemas:

```ts
const nonNegative = z.number().int().nonnegative();
const dailyReportResponseSchema = z.object({
  rows: z.array(z.object({ day: nonNegative, appId: z.string(), sent: nonNegative, hardBounced: nonNegative, softBounced: nonNegative, failed: nonNegative })),
});
```

- Add the method to the object `distributionClient` returns:

```ts
    async dailyReport(bounds: string[]): Promise<{ rows: DailyReportRow[] }> {
      return callDistribution(opts, doFetch, timeoutMs, "/api/reports/daily", { method: "POST", body: { bounds } }, dailyReportResponseSchema, "Distribution response missing rows");
    },
```

`apps/nod/src/reports/distribution.ts`:

```ts
/**
 * Distribution sent vs bounced (spec §8), from Distribution's own message records: per BC day and
 * sending app, and in total. Delivered = sent − bounces (hard and soft; legacy's Success =
 * Sent − Bounced). NoD's own messages are labelled; any other app shows its id.
 */
import type { DistributionClient } from "../distribution-client";
import type { CsvCell } from "./csv";
import { addDays, type ReportRange } from "./range";

export interface DeliveryCounts {
  sent: number;
  delivered: number;
  hardBounced: number;
  softBounced: number;
  failed: number;
}
export interface DistributionReport {
  from: string;
  to: string;
  totals: DeliveryCounts;
  apps: ({ app: string } & DeliveryCounts)[];
  days: ({ date: string; app: string } & DeliveryCounts)[];
}

const ZERO: DeliveryCounts = { sent: 0, delivered: 0, hardBounced: 0, softBounced: 0, failed: 0 };
const add = (a: DeliveryCounts, b: DeliveryCounts): DeliveryCounts => ({
  sent: a.sent + b.sent,
  delivered: a.delivered + b.delivered,
  hardBounced: a.hardBounced + b.hardBounced,
  softBounced: a.softBounced + b.softBounced,
  failed: a.failed + b.failed,
});

export async function distributionReport(client: Pick<DistributionClient, "dailyReport">, range: ReportRange, nodAppId: string): Promise<DistributionReport> {
  const { rows } = await client.dailyReport(range.bounds.map((b) => b.toISOString()));
  const label = (appId: string) => (appId === nodAppId ? "News On Demand" : appId);
  const days = rows
    .filter((r) => r.day >= 0 && r.day < range.days)
    .map((r) => ({
      date: addDays(range.from, r.day),
      app: label(r.appId),
      sent: r.sent,
      delivered: Math.max(0, r.sent - r.hardBounced - r.softBounced),
      hardBounced: r.hardBounced,
      softBounced: r.softBounced,
      failed: r.failed,
    }))
    .sort((a, b) => (a.date === b.date ? a.app.localeCompare(b.app) : b.date.localeCompare(a.date)));
  const countsOf = (d: DeliveryCounts): DeliveryCounts => ({ sent: d.sent, delivered: d.delivered, hardBounced: d.hardBounced, softBounced: d.softBounced, failed: d.failed });
  const byApp = new Map<string, DeliveryCounts>();
  for (const d of days) byApp.set(d.app, add(byApp.get(d.app) ?? ZERO, countsOf(d)));
  return {
    from: range.from,
    to: range.to,
    totals: days.reduce<DeliveryCounts>((t, d) => add(t, countsOf(d)), ZERO),
    apps: [...byApp.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([app, c]) => ({ app, ...c })),
    days,
  };
}

export const DISTRIBUTION_CSV_HEADER = ["Date", "Sent by", "Sent", "Delivered", "Hard bounces", "Soft bounces", "Failed"];
export function distributionCsvRows(r: DistributionReport): CsvCell[][] {
  return r.days.map((d) => [d.date, d.app, d.sent, d.delivered, d.hardBounced, d.softBounced, d.failed]);
}
```

`apps/nod/src/http/routes.ts`: in `SettingsRouteDeps`, change the Pick to `Pick<DistributionClient, "send" | "getSettings" | "setPaused" | "bounceSource" | "dailyReport">` and add:

```ts
  /** NoD's own appId as Distribution records it (bounces.ts): the reports label its messages. */
  nodAppId: string;
```

`apps/nod/src/app.ts`:
- Add `"dailyReport"` to the `AppDeps.distribution` Pick and to `noDistribution`'s type.
- Add `dailyReport: () => Promise.reject(new Error("createApp: no Distribution client configured for the reports"))` to `noDistribution`.
- Add `nodAppId: deps.distributionAppId ?? "nod",` to the settings object passed to `apiRoutes`.

`apps/nod/src/http/report-routes.ts`:
- Change `ReportRouteDeps` to `Pick<SettingsRouteDeps, "timeZone" | "distribution" | "nodAppId">`.
- Import `DistributionError` from `../distribution-client`, `safeErrorLabel` from `@gcpe/http-kit`, and `DISTRIBUTION_CSV_HEADER`, `distributionCsvRows`, `distributionReport` from `../reports/distribution`.
- Add to `mapError`:

```ts
  if (e instanceof DistributionError) {
    console.error("[nod] Distribution report call failed", safeErrorLabel(e));
    return void res.status(502).json({ error: "distribution unavailable" }), true;
  }
```

- Add the routes:

```ts
  r.get("/reports/distribution", read, privateErrors(async (req, res) => {
    const { range } = await rangeOf(req);
    res.json(await distributionReport(deps.distribution, range, deps.nodAppId));
  }));

  r.get("/reports/distribution.csv", read, privateErrors(async (req, res) => {
    const { range, today } = await rangeOf(req);
    const report = await distributionReport(deps.distribution, range, deps.nodAppId);
    await streamCsv(res, csvFilename("distribution", today), DISTRIBUTION_CSV_HEADER, oneBatch(distributionCsvRows(report)));
  }));
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod apps/distribution`
Expected: PASS. Then run both type-checks, and fix any test stub that `tsc` reports as missing `dailyReport`.

- [ ] **Step 8: Distribution volume probe**

`apps/distribution/src/reports.probe.test.ts`:

```ts
// Legacy-volume probe for the daily report: about 22,800 messages a day for 90 days (Q21). Opt-in
// with REPORT_PROBE=1; prints timings (numbers only) and asserts the plan's budgets.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createDistributionTestDb } from "../test/helpers";
import { dailyReport } from "./reports";

async function bestOf(n: number, f: () => Promise<unknown>): Promise<number> {
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await f();
    best = Math.min(best, performance.now() - t0);
  }
  return Math.round(best);
}
const days = (n: number) => Array.from({ length: n + 1 }, (_, i) => new Date(Date.now() - (n - i) * 86_400_000));

describe.runIf(process.env.REPORT_PROBE === "1")("Distribution report volume probe", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createDistributionTestDb();
    await tdb.db.execute(sql.raw(`
      INSERT INTO batches (app_id, subject, html, created_at)
        SELECT CASE WHEN b % 50 = 0 THEN 'nrms' ELSE 'nod' END, 's', '<p>h</p>', now() - ((b / 23) || ' days')::interval
          FROM generate_series(1, 2070) b;
      INSERT INTO messages (batch_id, email, priority, status, sent_at, bounced_at, bounce_hard)
        SELECT b.id, 'user' || g || '@example.test', 30,
               CASE WHEN g % 5000 = 0 THEN 'failed' ELSE 'sent' END,
               CASE WHEN g % 5000 = 0 THEN NULL ELSE b.created_at + (g || ' milliseconds')::interval END,
               CASE WHEN g % 900 = 0 THEN b.created_at END,
               CASE WHEN g % 900 = 0 THEN (g % 1800 = 0) END
          FROM batches b, generate_series(1, 1000) g;
    `));
    await tdb.db.execute(sql`VACUUM ANALYZE messages`);
  }, 300_000);
  afterAll(async () => tdb.drop());

  it("meets the budgets", async () => {
    const t = { days92: await bestOf(3, () => dailyReport(tdb.db, days(92))), days31: await bestOf(3, () => dailyReport(tdb.db, days(31))) };
    console.log("[probe] Distribution report timings (ms, best of 3):", JSON.stringify(t));
    expect(t.days92).toBeLessThan(1000);
    expect(t.days31).toBeLessThan(500);
  }, 300_000);
});
```

Run: `REPORT_PROBE=1 npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/distribution/src/reports.probe.test.ts`
Expected: PASS, with one `[probe]` line. Keep it for Task 7.

- [ ] **Step 9: Commit**

```bash
git add apps/distribution apps/nod/src/distribution-client.ts apps/nod/src/reports apps/nod/src/http apps/nod/src/app.ts
git commit -m "feat(distribution,nod): Distribution sent vs bounced report by BC day and app, with message indexes and probe"
```

If `tsc` sent you to fix other test stubs, add those files to the commit as well.

---
### Task 5: staff-web Reports area, Active subscribers by list, Recent unsubscribes

**Files:**
- Create, in `apps/staff-web/src/screens/subscribers/reports/`:
  - `types.ts`, `reportUrl.ts`, `useReport.ts`, `useReportParams.ts`, `errors.ts`, `format.ts`, `CsvLink.tsx`;
  - `ReportsScreen.tsx`, `SubscribersByListReportScreen.tsx`, `UnsubscribesReportScreen.tsx`;
  - tests: `helpers.test.tsx`, `ReportsScreen.test.tsx`, `SubscribersByListReportScreen.test.tsx`, `UnsubscribesReportScreen.test.tsx`, `a11y.test.tsx`;
  - outside that folder: `apps/staff-web/test/reportFixtures.tsx`.
- Modify:
  - `apps/staff-web/src/router.tsx:83-95` (three child routes under `subscribers`);
  - `apps/staff-web/src/screens/subscribers/SubscribersSection.tsx` (a "Reports" link, before Operations) and `SubscribersSection.test.tsx`.

**Interfaces:**
- Consumes:
  - `apiFetch`, `ApiError` (`api/client.ts`);
  - `useSession`, `canEditSubscribers` (`access.ts`), `timingLabel` (`labels.ts`);
  - `useTenantTimeZone`, `useDocumentTitle`;
  - `Pagination` (`screens/releases/Pagination.tsx`);
  - the JSON shapes of Tasks 1 and 2.
- Produces:
  - `reportUrl(path, params: ReportParams): string`, where `ReportParams` holds only `list`/`timing`/`from`/`to`/`page`;
  - `useReport<T>(url: string | null): { data: T | null; error: unknown }`;
  - `useReportParams(): { value(key): string; page: number; update(changes): void }`;
  - `reportErrorText(e): string`, `bcDate(iso, tz)`, `bcDateTime(iso, tz)`;
  - `CsvLink({ href, children })`;
  - the three screens;
  - `stubReports(roles, overrides?)`, `renderAt(path, pattern, element)`, `calledUrls(fetchMock)` and the fixtures (`test/reportFixtures.tsx`).
- staff-web paths:
  - `/hub/subscribers/reports` (index);
  - `/hub/subscribers/reports/subscribers-by-list` (`?list=&timing=&page=`);
  - `/hub/subscribers/reports/unsubscribes` (`?page=`).

- [ ] **Step 1: Shared types, fixtures and the failing tests**

`apps/staff-web/src/screens/subscribers/reports/types.ts`:

```ts
/** JSON shapes of NoD's /reports routes (apps/nod/src/reports/*). */
export type TimingFilter = "any" | "as-it-happens" | "digest";
export interface TimingCounts {
  subscribers: number;
  asItHappens: number;
  digest: number;
}
export interface ByListList extends TimingCounts {
  listKey: string;
  name: string;
  active: boolean;
}
export interface SubscribersByListReport {
  all: TimingCounts;
  allNews: TimingCounts;
  categories: { key: string; name: string; lists: ByListList[] }[];
}
export interface ReportMember {
  id: string;
  email: string;
  asItHappens: boolean;
  digest: boolean;
  source: string;
  createdAt: string;
}
export interface MembersPage {
  list: string;
  listName: string;
  timing: TimingFilter;
  total: number;
  page: number;
  pageSize: number;
  items: ReportMember[];
}
export interface UnsubscribeRow {
  subscriberId: string;
  email: string;
  how: "subscriber" | "staff";
  at: string;
  status: "pending" | "active" | "disabled" | "deleted";
  registeredAt: string;
}
export interface UnsubscribesPage {
  since: string;
  summary: { subscribed: number; resubscribed: number; unsubscribed: number; staffDeleted: number };
  total: number;
  page: number;
  pageSize: number;
  items: UnsubscribeRow[];
}
```

`apps/staff-web/test/reportFixtures.tsx`:

```tsx
import { vi } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "./jsonResponse";
import { SessionProvider } from "../src/session/SessionContext";
import { RequireAuth } from "../src/session/RequireAuth";
import type { MembersPage, SubscribersByListReport, UnsubscribesPage } from "../src/screens/subscribers/reports/types";

export const BY_LIST: SubscribersByListReport = {
  all: { subscribers: 120, asItHappens: 100, digest: 40 },
  allNews: { subscribers: 30, asItHappens: 25, digest: 10 },
  categories: [
    {
      key: "ministries",
      name: "Ministries",
      lists: [
        { listKey: "ministries:health", name: "Health", active: true, subscribers: 40, asItHappens: 35, digest: 12 },
        { listKey: "ministries:old", name: "Old ministry", active: false, subscribers: 2, asItHappens: 2, digest: 0 },
      ],
    },
    { key: "themes", name: "Themes", lists: [] },
  ],
};

export const MEMBERS: MembersPage = {
  list: "ministries:health",
  listName: "Health",
  timing: "any",
  total: 2,
  page: 1,
  pageSize: 50,
  items: [
    { id: "11111111-1111-1111-1111-111111111111", email: "pat@example.test", asItHappens: true, digest: false, source: "self", createdAt: "2026-09-01T17:00:00.000Z" },
    { id: "22222222-2222-2222-2222-222222222222", email: "lee@example.test", asItHappens: false, digest: true, source: "admin", createdAt: "2026-11-15T20:05:00.000Z" },
  ],
};

export const UNSUBSCRIBES: UnsubscribesPage = {
  since: "2026-07-09",
  summary: { subscribed: 12, resubscribed: 3, unsubscribed: 5, staffDeleted: 1 },
  total: 2,
  page: 1,
  pageSize: 50,
  items: [
    { subscriberId: "33333333-3333-3333-3333-333333333333", email: "gone@example.test", how: "subscriber", at: "2026-10-05T16:30:00.000Z", status: "deleted", registeredAt: "2026-01-02T17:00:00.000Z" },
    { subscriberId: "44444444-4444-4444-4444-444444444444", email: "back@example.test", how: "staff", at: "2026-10-01T16:30:00.000Z", status: "active", registeredAt: "2025-05-02T17:00:00.000Z" },
  ],
};

type Responder = () => Response;
/** Default answers by URL prefix, most specific first. */
const DEFAULTS: [string, Responder][] = [
  ["/nod/api/reports/subscribers-by-list/members", () => jsonResponse(200, MEMBERS)],
  ["/nod/api/reports/subscribers-by-list", () => jsonResponse(200, BY_LIST)],
  ["/nod/api/reports/unsubscribes", () => jsonResponse(200, UNSUBSCRIBES)],
];

/** Stubs fetch: the session (with `roles`), the tenant config, and every report route. An
 * `overrides` entry wins for any URL starting with its key. */
export function stubReports(roles: string[], overrides: Record<string, Responder> = {}) {
  const fetchMock = vi.fn(async (url: string) => {
    for (const [prefix, respond] of Object.entries(overrides)) if (url.startsWith(prefix)) return respond();
    if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
    if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
    for (const [prefix, respond] of DEFAULTS) if (url.startsWith(prefix)) return respond();
    throw new Error(`unhandled: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export const calledUrls = (fetchMock: ReturnType<typeof stubReports>): string[] => fetchMock.mock.calls.map((c) => String(c[0]));

export function renderAt(path: string, pattern: string, element: React.ReactNode) {
  return render(
    <SessionProvider>
      <MemoryRouter initialEntries={[path]}>
        <RequireAuth>
          <Routes>
            <Route path={pattern} element={element} />
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
}
```

`apps/staff-web/src/screens/subscribers/reports/helpers.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";
import { ApiError } from "../../../api/client";
import { reportErrorText } from "./errors";
import { bcDate, bcDateTime } from "./format";
import { reportUrl } from "./reportUrl";

describe("report helpers", () => {
  it("builds report URLs from filters only, dropping anything else and empty values", () => {
    expect(reportUrl("/nod/api/reports/x", { list: "ministries:health", timing: "digest", page: 2 })).toBe("/nod/api/reports/x?list=ministries%3Ahealth&timing=digest&page=2");
    expect(reportUrl("/nod/api/reports/x", { from: "", to: undefined })).toBe("/nod/api/reports/x");
    expect(reportUrl("/nod/api/reports/x", { q: "pat@example.test" } as never)).toBe("/nod/api/reports/x");
  });

  it("formats BC dates and times, including after BC stops changing clocks", () => {
    expect(bcDateTime("2026-10-05T16:30:00.000Z", "America/Vancouver")).toBe("2026-10-05 09:30");
    expect(bcDateTime("2026-11-15T20:05:00.000Z", "America/Vancouver")).toBe("2026-11-15 13:05");
    expect(bcDate("2026-11-01T06:30:00.000Z", "America/Vancouver")).toBe("2026-10-31");
  });

  it("explains report errors in plain words", () => {
    const err = (status: number, error?: string) => new ApiError({ status, message: "x", body: error ? { error } : undefined });
    expect(reportErrorText(err(400, "range-too-long"))).toBe("Choose a range of 92 days or fewer.");
    expect(reportErrorText(err(400, "range-reversed"))).toBe("The start date must be on or before the end date.");
    expect(reportErrorText(err(502))).toBe("Distribution is unavailable right now. Try again in a few minutes.");
    expect(reportErrorText(new Error("network"))).toBe("Couldn't load the report. Try again.");
  });
});
```

`apps/staff-web/src/screens/subscribers/reports/ReportsScreen.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { renderAt, stubReports } from "../../../../test/reportFixtures";
import { ReportsScreen } from "./ReportsScreen";

describe("ReportsScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("links every report", async () => {
    stubReports(["NoD.Viewer"]);
    renderAt("/subscribers/reports", "/subscribers/reports", <ReportsScreen />);
    const expected: [string, string][] = [
      ["Active subscribers by list", "/subscribers/reports/subscribers-by-list"],
      ["Recent unsubscribes", "/subscribers/reports/unsubscribes"],
      ["Sends per release", "/subscribers/reports/release-sends"],
      ["Daily digest runs", "/subscribers/reports/digest-runs"],
      ["Distribution sent and bounced", "/subscribers/reports/distribution"],
    ];
    for (const [name, href] of expected) expect(await screen.findByRole("link", { name })).toHaveAttribute("href", href);
    await waitFor(() => expect(document.title).toBe("Reports — GCPE News Staff"));
  });
});
```

`apps/staff-web/src/screens/subscribers/reports/SubscribersByListReportScreen.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { calledUrls, renderAt, stubReports } from "../../../../test/reportFixtures";
import { SubscribersByListReportScreen } from "./SubscribersByListReportScreen";

const PATTERN = "/subscribers/reports/subscribers-by-list";

describe("SubscribersByListReportScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("shows counts by list, and a Viewer gets the counts CSV but not the members CSV", async () => {
    stubReports(["NoD.Viewer"]);
    renderAt(`${PATTERN}?list=ministries%3Ahealth`, PATTERN, <SubscribersByListReportScreen />);
    expect(await screen.findByRole("row", { name: /^All active subscribers 120 100 40/ })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /^Health 40 35 12/ })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /^Old ministry \(retired\) 2 2 0/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Themes" })).toBeNull();
    expect(screen.getByRole("link", { name: "Download counts (CSV)" })).toHaveAttribute("href", "/nod/api/reports/subscribers-by-list.csv");
    expect(await screen.findByRole("link", { name: "pat@example.test" })).toHaveAttribute("href", "/subscribers/11111111-1111-1111-1111-111111111111");
    expect(screen.getByRole("row", { name: /lee@example\.test Daily digest Added by staff 2026-11-15/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Download members (CSV)" })).toBeNull();
    await waitFor(() => expect(document.title).toBe("Active subscribers by list — GCPE News Staff"));
  });

  it("gives an Editor the members CSV for the chosen list and timing", async () => {
    stubReports(["NoD.Editor"]);
    renderAt(`${PATTERN}?list=ministries%3Ahealth&timing=digest`, PATTERN, <SubscribersByListReportScreen />);
    expect(await screen.findByRole("link", { name: "Download members (CSV)" })).toHaveAttribute(
      "href",
      "/nod/api/reports/subscribers-by-list/members.csv?list=ministries%3Ahealth&timing=digest",
    );
  });

  it("loads the members of the list chosen, and again when the timing changes", async () => {
    const fetchMock = stubReports(["NoD.Viewer"]);
    renderAt(PATTERN, PATTERN, <SubscribersByListReportScreen />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("link", { name: "Show members of Health" }));
    await waitFor(() => expect(calledUrls(fetchMock)).toContain("/nod/api/reports/subscribers-by-list/members?list=ministries%3Ahealth&timing=any"));
    await user.selectOptions(await screen.findByLabelText("Timing"), "digest");
    await waitFor(() => expect(calledUrls(fetchMock)).toContain("/nod/api/reports/subscribers-by-list/members?list=ministries%3Ahealth&timing=digest"));
  });

  it("says so when a list no longer exists", async () => {
    stubReports(["NoD.Viewer"], { "/nod/api/reports/subscribers-by-list/members": () => new Response(JSON.stringify({ error: "not found" }), { status: 404 }) });
    renderAt(`${PATTERN}?list=ministries%3Agone`, PATTERN, <SubscribersByListReportScreen />);
    expect(await screen.findByRole("alert")).toHaveTextContent("That list doesn't exist any more.");
  });
});
```

`apps/staff-web/src/screens/subscribers/reports/UnsubscribesReportScreen.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { calledUrls, renderAt, stubReports } from "../../../../test/reportFixtures";
import { UnsubscribesReportScreen } from "./UnsubscribesReportScreen";

const PATTERN = "/subscribers/reports/unsubscribes";

describe("UnsubscribesReportScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("shows who left, how and when in BC time, the window's counts, and a Viewer gets counts only", async () => {
    stubReports(["NoD.Viewer"]);
    renderAt(PATTERN, PATTERN, <UnsubscribesReportScreen />);
    expect(await screen.findByText("Since 2026-07-09: 12 new subscriptions, 3 returning, 5 unsubscribed, 1 deleted by staff.")).toBeInTheDocument();
    expect(screen.getByText("2 people unsubscribed or were deleted since 2026-07-09.")).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /gone@example\.test Unsubscribed 2026-10-05 09:30 Deleted 2026-01-02/ })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /back@example\.test Deleted by staff 2026-10-01 09:30 Active 2025-05-02/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download daily counts (CSV)" })).toHaveAttribute("href", "/nod/api/reports/unsubscribes/daily.csv");
    expect(screen.queryByRole("link", { name: "Download list with addresses (CSV)" })).toBeNull();
    await waitFor(() => expect(document.title).toBe("Recent unsubscribes — GCPE News Staff"));
  });

  it("gives an Editor the address CSV", async () => {
    stubReports(["NoD.Editor"]);
    renderAt(PATTERN, PATTERN, <UnsubscribesReportScreen />);
    expect(await screen.findByRole("link", { name: "Download list with addresses (CSV)" })).toHaveAttribute("href", "/nod/api/reports/unsubscribes.csv");
  });

  it("takes its page from the URL", async () => {
    const fetchMock = stubReports(["NoD.Viewer"]);
    renderAt(`${PATTERN}?page=2`, PATTERN, <UnsubscribesReportScreen />);
    await waitFor(() => expect(calledUrls(fetchMock)).toContain("/nod/api/reports/unsubscribes?page=2"));
  });
});
```

`apps/staff-web/src/screens/subscribers/reports/a11y.test.tsx`:

```tsx
/** axe checks for the Reports screens (wcag2a/wcag2aa, serious and critical). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import axe from "axe-core";
import { renderAt, stubReports } from "../../../../test/reportFixtures";
import { ReportsScreen } from "./ReportsScreen";
import { SubscribersByListReportScreen } from "./SubscribersByListReportScreen";
import { UnsubscribesReportScreen } from "./UnsubscribesReportScreen";

async function seriousViolations(container: Element) {
  const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}

describe("accessibility — Reports", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("ReportsScreen", async () => {
    stubReports(["NoD.Viewer"]);
    const { container } = renderAt("/subscribers/reports", "/subscribers/reports", <ReportsScreen />);
    await screen.findByRole("link", { name: "Recent unsubscribes" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("SubscribersByListReportScreen with members open (Editor)", async () => {
    stubReports(["NoD.Editor"]);
    const path = "/subscribers/reports/subscribers-by-list";
    const { container } = renderAt(`${path}?list=ministries%3Ahealth`, path, <SubscribersByListReportScreen />);
    await screen.findByRole("link", { name: "pat@example.test" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("UnsubscribesReportScreen (Editor)", async () => {
    stubReports(["NoD.Editor"]);
    const path = "/subscribers/reports/unsubscribes";
    const { container } = renderAt(path, path, <UnsubscribesReportScreen />);
    await screen.findByRole("link", { name: "gone@example.test" });
    expect(await seriousViolations(container)).toEqual([]);
  });
});
```

In `SubscribersSection.test.tsx`, change the three expectations to:
- Viewer: `["Find subscribers", "Lists and categories", "Media lists", "Reports"]`;
- Editor: `["Find subscribers", "Add a subscriber", "Lists and categories", "Media lists", "Reports"]`;
- Admin: `["Find subscribers", "Add a subscriber", "Lists and categories", "Media lists", "Reports", "Operations"]`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/subscribers`
Expected: FAIL. The report modules are missing, and the nav has no "Reports".

- [ ] **Step 3: Implement the helpers**

`reports/reportUrl.ts`:

```ts
/** The filters a report URL may carry: dates, a list key, a timing and a page. Never an address or
 * a search term; any other key is dropped here, so none can slip into a URL by accident. */
const URL_PARAMS = ["list", "timing", "from", "to", "page"] as const;
export type ReportParam = (typeof URL_PARAMS)[number];
export type ReportParams = Partial<Record<ReportParam, string | number | undefined>>;

export function reportUrl(path: string, params: ReportParams = {}): string {
  const q = new URLSearchParams();
  for (const key of URL_PARAMS) {
    const v = params[key];
    if (v !== undefined && v !== "") q.set(key, String(v));
  }
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}
```

`reports/useReport.ts`:

```ts
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../../api/client";

/** GETs `url` whenever it changes (null: nothing to load). Only the latest request may land, so a
 * slow earlier page can't overwrite a newer one. */
export function useReport<T>(url: string | null): { data: T | null; error: unknown } {
  const [state, setState] = useState<{ url: string | null; data: T | null; error: unknown }>({ url: null, data: null, error: null });
  const latest = useRef(0);
  useEffect(() => {
    if (!url) return;
    const seq = ++latest.current;
    apiFetch<T>(url).then(
      (data) => {
        if (seq === latest.current) setState({ url, data, error: null });
      },
      (error: unknown) => {
        if (seq === latest.current) setState({ url, data: null, error });
      },
    );
  }, [url]);
  return state.url === url ? { data: state.data, error: state.error } : { data: null, error: null };
}
```

`reports/useReportParams.ts`:

```ts
import { useSearchParams } from "react-router";
import type { ReportParam } from "./reportUrl";

const MAX_PAGE = 10_000;

/** A report's filters, kept in the page URL (they're dates, a list key, a timing and a page, never
 * an address). Changing anything but the page goes back to page 1. */
export function useReportParams(): {
  value(key: Exclude<ReportParam, "page">): string;
  page: number;
  update(changes: Partial<Record<ReportParam, string | null>>): void;
} {
  const [params, setParams] = useSearchParams();
  const n = Number(params.get("page"));
  const page = Number.isInteger(n) && n >= 1 && n <= MAX_PAGE ? n : 1;
  return {
    value: (key) => params.get(key) ?? "",
    page,
    update: (changes) =>
      setParams((current) => {
        const next = new URLSearchParams(current);
        if (!("page" in changes)) next.delete("page");
        for (const [key, v] of Object.entries(changes)) {
          if (v === null || v === undefined || v === "") next.delete(key);
          else next.set(key, v);
        }
        return next;
      }),
  };
}
```

`reports/errors.ts`:

```ts
import { ApiError } from "../../../api/client";

export function reportErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    const code = (e.body as { error?: string } | undefined)?.error;
    if (e.status === 400 && code === "range-too-long") return "Choose a range of 92 days or fewer.";
    if (e.status === 400 && code === "range-reversed") return "The start date must be on or before the end date.";
    if (e.status === 400 && code === "invalid-date") return "Enter real dates.";
    if (e.status === 403) return "You don't have permission to view this report.";
    if (e.status === 404) return "That list doesn't exist any more.";
    if (e.status === 502) return "Distribution is unavailable right now. Try again in a few minutes.";
  }
  return "Couldn't load the report. Try again.";
}
```

`reports/format.ts`:

```ts
/** Report dates and times as the CSVs show them: "YYYY-MM-DD" and "YYYY-MM-DD HH:mm", BC time. */
const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(iso: string, timeZone: string): Record<string, string> {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formatters.set(timeZone, f);
  }
  return Object.fromEntries(f.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
}
export function bcDate(iso: string, timeZone: string): string {
  const p = parts(iso, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}
export function bcDateTime(iso: string, timeZone: string): string {
  const p = parts(iso, timeZone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
```

`reports/CsvLink.tsx`:

```tsx
/** A plain same-origin link: the session cookie authenticates the GET (no CSRF header needed), and
 * the browser streams the file to disk itself, so nothing is held in the page. */
export function CsvLink({ href, children }: { href: string; children: string }): React.JSX.Element {
  return (
    <p className="gcpe-reports__csv">
      <a href={href} download>
        {children}
      </a>
    </p>
  );
}
```

- [ ] **Step 4: Implement the three screens**

`reports/ReportsScreen.tsx`:

```tsx
import { Link } from "react-router";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";

const REPORTS = [
  { to: "subscribers-by-list", name: "Active subscribers by list", about: "who receives each list now, with as-it-happens and digest counts." },
  { to: "unsubscribes", name: "Recent unsubscribes", about: "everyone who unsubscribed or was deleted in the last 90 days." },
  { to: "release-sends", name: "Sends per release", about: "as-it-happens and media-list emails for each release: delivered, bounced and not sent." },
  { to: "digest-runs", name: "Daily digest runs", about: "each 17:00 digest: subscribers, delivered, bounced and not sent." },
  { to: "distribution", name: "Distribution sent and bounced", about: "everything Distribution sent, by day and sending app." },
];

/** `/hub/subscribers/reports` (spec §8 Reports). */
export function ReportsScreen(): React.JSX.Element {
  useDocumentTitle("Reports");
  return (
    <div className="gcpe-reports">
      <h1>Reports</h1>
      <p>Every report can be downloaded as a CSV file. Dates and times are BC time.</p>
      <ul>
        {REPORTS.map((r) => (
          <li key={r.to}>
            <Link to={`/subscribers/reports/${r.to}`}>{r.name}</Link>: {r.about}
          </li>
        ))}
      </ul>
      <p>CSV files with email addresses are for News On Demand editors and administrators.</p>
    </div>
  );
}
```

`reports/SubscribersByListReportScreen.tsx`:

```tsx
import { Link } from "react-router";
import { InlineAlert } from "@bcgov/design-system-react-components";
import { useTenantTimeZone } from "../../../format/tenantTimeZone";
import { useSession } from "../../../session/SessionContext";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { Pagination } from "../../releases/Pagination";
import { canEditSubscribers } from "../access";
import { timingLabel } from "../labels";
import { CsvLink } from "./CsvLink";
import { reportErrorText } from "./errors";
import { bcDate } from "./format";
import { reportUrl } from "./reportUrl";
import { useReport } from "./useReport";
import { useReportParams } from "./useReportParams";
import type { MembersPage, SubscribersByListReport, TimingCounts, TimingFilter } from "./types";

const TIMING_OPTIONS: { value: TimingFilter; label: string }[] = [
  { value: "any", label: "Any timing" },
  { value: "as-it-happens", label: "As it happens" },
  { value: "digest", label: "Daily digest" },
];
const SOURCE_LABELS: Record<string, string> = { self: "Signed up", admin: "Added by staff", "media-hub": "Media Hub", "manual-media": "Added by hand" };

function CountsRow({ listKey, name, counts }: { listKey: string; name: string; counts: TimingCounts }): React.JSX.Element {
  return (
    <tr>
      <th scope="row">{name}</th>
      <td>{counts.subscribers}</td>
      <td>{counts.asItHappens}</td>
      <td>{counts.digest}</td>
      <td>
        <Link to={`?${new URLSearchParams({ list: listKey }).toString()}`} aria-label={`Show members of ${name}`}>
          Show members
        </Link>
      </td>
    </tr>
  );
}

function CountsTable({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <table aria-label={label}>
      <thead>
        <tr>
          <th scope="col">List</th>
          <th scope="col">Subscribers</th>
          <th scope="col">As it happens</th>
          <th scope="col">Daily digest</th>
          <th scope="col">Members</th>
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

/** `/hub/subscribers/reports/subscribers-by-list` (spec §8): active subscribers per list now, and
 * the members of one list (or All news, or everyone) by timing. The list key, timing and page
 * live in the URL; the members CSV is for Editors and Admins (Q37). */
export function SubscribersByListReportScreen(): React.JSX.Element {
  useDocumentTitle("Active subscribers by list");
  const canExport = canEditSubscribers(useSession());
  const timeZone = useTenantTimeZone();
  const params = useReportParams();
  const list = params.value("list");
  const timing = TIMING_OPTIONS.find((o) => o.value === params.value("timing"))?.value ?? "any";
  const summary = useReport<SubscribersByListReport>("/nod/api/reports/subscribers-by-list");
  const members = useReport<MembersPage>(
    list ? reportUrl("/nod/api/reports/subscribers-by-list/members", { list, timing, page: params.page > 1 ? params.page : undefined }) : null,
  );

  return (
    <div className="gcpe-reports">
      <h1>Active subscribers by list</h1>
      <p>Who receives each list now. Active subscribers only.</p>
      {summary.error ? <InlineAlert variant="danger" role="alert" description={reportErrorText(summary.error)} /> : null}
      {!summary.data && !summary.error && <p>Loading…</p>}
      {summary.data && (
        <>
          <CsvLink href="/nod/api/reports/subscribers-by-list.csv">Download counts (CSV)</CsvLink>
          <CountsTable label="Everyone">
            <CountsRow listKey="all" name="All active subscribers" counts={summary.data.all} />
            <CountsRow listKey="*" name="All news" counts={summary.data.allNews} />
          </CountsTable>
          {summary.data.categories
            .filter((c) => c.lists.length > 0)
            .map((c) => (
              <section key={c.key} aria-labelledby={`report-category-${c.key}`}>
                <h2 id={`report-category-${c.key}`}>{c.name}</h2>
                <CountsTable label={c.name}>
                  {c.lists.map((l) => (
                    <CountsRow key={l.listKey} listKey={l.listKey} name={l.active ? l.name : `${l.name} (retired)`} counts={l} />
                  ))}
                </CountsTable>
              </section>
            ))}
        </>
      )}

      {list && (
        <section aria-labelledby="report-members-heading">
          <h2 id="report-members-heading">{members.data ? `Members: ${members.data.listName}` : "Members"}</h2>
          <label htmlFor="report-timing">Timing</label>
          <select id="report-timing" value={timing} onChange={(e) => params.update({ timing: e.target.value === "any" ? null : e.target.value })}>
            {TIMING_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {members.error ? <InlineAlert variant="danger" role="alert" description={reportErrorText(members.error)} /> : null}
          {members.data && (
            <>
              <p>{`${members.data.total} active ${members.data.total === 1 ? "subscriber" : "subscribers"}.`}</p>
              {canExport && (
                <CsvLink href={reportUrl("/nod/api/reports/subscribers-by-list/members.csv", { list, timing })}>Download members (CSV)</CsvLink>
              )}
              {members.data.items.length > 0 && (
                <table aria-label="Members">
                  <thead>
                    <tr>
                      <th scope="col">Email</th>
                      <th scope="col">Timing</th>
                      <th scope="col">Source</th>
                      <th scope="col">Registered</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.data.items.map((m) => (
                      <tr key={m.id}>
                        <td>
                          <Link to={`/subscribers/${m.id}`}>{m.email}</Link>
                        </td>
                        <td>{timingLabel(m)}</td>
                        <td>{SOURCE_LABELS[m.source] ?? m.source}</td>
                        <td>{bcDate(m.createdAt, timeZone)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <Pagination page={members.data.page} pageSize={members.data.pageSize} total={members.data.total} onPageChange={(n) => params.update({ page: String(n) })} />
            </>
          )}
        </section>
      )}
    </div>
  );
}
```

`reports/UnsubscribesReportScreen.tsx`:

```tsx
import { Link } from "react-router";
import { InlineAlert } from "@bcgov/design-system-react-components";
import { useTenantTimeZone } from "../../../format/tenantTimeZone";
import { useSession } from "../../../session/SessionContext";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { Pagination } from "../../releases/Pagination";
import { canEditSubscribers } from "../access";
import { CsvLink } from "./CsvLink";
import { reportErrorText } from "./errors";
import { bcDate, bcDateTime } from "./format";
import { reportUrl } from "./reportUrl";
import { useReport } from "./useReport";
import { useReportParams } from "./useReportParams";
import type { UnsubscribeRow, UnsubscribesPage } from "./types";

const HOW: Record<UnsubscribeRow["how"], string> = { subscriber: "Unsubscribed", staff: "Deleted by staff" };
const STATUS: Record<UnsubscribeRow["status"], string> = { pending: "Pending", active: "Active", disabled: "Disabled", deleted: "Deleted" };

/** `/hub/subscribers/reports/unsubscribes` (spec §8; legacy RecentUnsubscribersReport): the last 90
 * days, fixed. Viewers export daily counts; Editors and Admins also export addresses (Q37). */
export function UnsubscribesReportScreen(): React.JSX.Element {
  useDocumentTitle("Recent unsubscribes");
  const canExport = canEditSubscribers(useSession());
  const timeZone = useTenantTimeZone();
  const params = useReportParams();
  const report = useReport<UnsubscribesPage>(reportUrl("/nod/api/reports/unsubscribes", { page: params.page > 1 ? params.page : undefined }));
  const d = report.data;

  return (
    <div className="gcpe-reports">
      <h1>Recent unsubscribes</h1>
      <p>
        Everyone whose latest unsubscribe, or deletion by staff, was in the last 90 days. Subscribers disabled because their email bounced
        aren&rsquo;t listed: find them under Subscribers with the Disabled status.
      </p>
      {report.error ? <InlineAlert variant="danger" role="alert" description={reportErrorText(report.error)} /> : null}
      {!d && !report.error && <p>Loading…</p>}
      {d && (
        <>
          <p>{`Since ${d.since}: ${d.summary.subscribed} new subscriptions, ${d.summary.resubscribed} returning, ${d.summary.unsubscribed} unsubscribed, ${d.summary.staffDeleted} deleted by staff.`}</p>
          <p>{d.total === 1 ? `1 person unsubscribed or was deleted since ${d.since}.` : `${d.total} people unsubscribed or were deleted since ${d.since}.`}</p>
          <CsvLink href="/nod/api/reports/unsubscribes/daily.csv">Download daily counts (CSV)</CsvLink>
          {canExport && <CsvLink href="/nod/api/reports/unsubscribes.csv">Download list with addresses (CSV)</CsvLink>}
          {d.items.length > 0 ? (
            <table aria-label="Recent unsubscribes">
              <thead>
                <tr>
                  <th scope="col">Email</th>
                  <th scope="col">How</th>
                  <th scope="col">When</th>
                  <th scope="col">Status now</th>
                  <th scope="col">Registered</th>
                </tr>
              </thead>
              <tbody>
                {d.items.map((u) => (
                  <tr key={u.subscriberId}>
                    <td>
                      <Link to={`/subscribers/${u.subscriberId}`}>{u.email}</Link>
                    </td>
                    <td>{HOW[u.how]}</td>
                    <td>{bcDateTime(u.at, timeZone)}</td>
                    <td>{STATUS[u.status]}</td>
                    <td>{bcDate(u.registeredAt, timeZone)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>No one unsubscribed in the last 90 days.</p>
          )}
          <Pagination page={d.page} pageSize={d.pageSize} total={d.total} onPageChange={(n) => params.update({ page: String(n) })} />
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Routes and nav**

`apps/staff-web/src/router.tsx`:
- Import `ReportsScreen`, `SubscribersByListReportScreen` and `UnsubscribesReportScreen` from `./screens/subscribers/reports/...`.
- Add these children under `subscribers`, after `operations`:

```tsx
          { path: "reports", element: <ReportsScreen /> },
          { path: "reports/subscribers-by-list", element: <SubscribersByListReportScreen /> },
          { path: "reports/unsubscribes", element: <UnsubscribesReportScreen /> },
```

`SubscribersSection.tsx`: add before the Operations item:

```tsx
          <li>
            <NavLink to="/subscribers/reports">Reports</NavLink>
          </li>
```

The index links all five reports. The last three routes arrive in Task 6; until then those links render the section's empty catch-all.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web`
Expected: PASS. Then run `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p apps/staff-web/tsconfig.json`.

If `router.test.tsx` pins the `subscribers` children, add the new paths there.

- [ ] **Step 7: Commit**

```bash
git add apps/staff-web
git commit -m "feat(staff-web): Reports area with active subscribers by list and recent unsubscribes"
```

---

### Task 6: staff-web Sends per release, Daily digest runs, Distribution sent and bounced

**Files:**
- Create, in `apps/staff-web/src/screens/subscribers/reports/`:
  - `RangeForm.tsx`, `useRangedReport.ts`;
  - `ReleaseSendsReportScreen.tsx`, `DigestRunsReportScreen.tsx`, `DistributionReportScreen.tsx`;
  - `ReleaseSendsReportScreen.test.tsx`, `DigestRunsReportScreen.test.tsx`, `DistributionReportScreen.test.tsx`.
- Modify:
  - `reports/types.ts` (ranged report shapes);
  - `reports/a11y.test.tsx` (three more screens);
  - `apps/staff-web/test/reportFixtures.tsx` (three fixtures and their default routes);
  - `apps/staff-web/src/router.tsx` (three child routes).

**Interfaces:**
- Consumes: everything Task 5 produced; the JSON shapes of Tasks 3 and 4.
- Produces:
  - `RangeForm({ from, to, onApply })`;
  - `useRangedReport<T extends { from: string; to: string }>(path)`, returning `{ report, params, shown, csvHref(csvPath), apply(from, to) }`;
  - types `ModeCounts`, `ReleaseSendRow`, `RangedPage<T>`, `DigestRunRow`, `DeliveryCounts`, `DistributionReport`;
  - fixtures `RELEASE_SENDS`, `DIGEST_RUNS`, `DISTRIBUTION`.
- staff-web paths:
  - `/hub/subscribers/reports/release-sends` (`?from=&to=&page=`);
  - `/hub/subscribers/reports/digest-runs` (`?from=&to=&page=`);
  - `/hub/subscribers/reports/distribution` (`?from=&to=`).

- [ ] **Step 1: Types, fixtures and the failing tests**

Append to `reports/types.ts`:

```ts
export interface ModeCounts {
  recipients: number;
  delivered: number;
  bounced: number;
  notSent: number;
}
export interface ReleaseSendRow {
  itemKey: string;
  title: string;
  type: string;
  publishedAt: string;
  asItHappens: ModeCounts;
  media: ModeCounts;
}
export interface RangedPage<T> {
  from: string;
  to: string;
  total: number;
  page: number;
  pageSize: number;
  items: T[];
}
export interface DigestRunRow {
  cutoff: string;
  ranAt: string;
  items: number;
  subscribers: number;
  delivered: number;
  bounced: number;
  notSent: number;
}
export interface DeliveryCounts {
  sent: number;
  delivered: number;
  hardBounced: number;
  softBounced: number;
  failed: number;
}
export interface DistributionReport {
  from: string;
  to: string;
  totals: DeliveryCounts;
  apps: ({ app: string } & DeliveryCounts)[];
  days: ({ date: string; app: string } & DeliveryCounts)[];
}
```

In `apps/staff-web/test/reportFixtures.tsx`, extend the type import and add:

```tsx
export const RELEASE_SENDS: RangedPage<ReleaseSendRow> = {
  from: "2026-09-08",
  to: "2026-10-07",
  total: 1,
  page: 1,
  pageSize: 25,
  items: [
    {
      itemKey: "r1",
      title: "Budget 2027",
      type: "News release",
      publishedAt: "2026-10-06T16:30:00.000Z",
      asItHappens: { recipients: 4, delivered: 1, bounced: 2, notSent: 1 },
      media: { recipients: 1, delivered: 1, bounced: 0, notSent: 0 },
    },
  ],
};

export const DIGEST_RUNS: RangedPage<DigestRunRow> = {
  from: "2026-09-08",
  to: "2026-10-07",
  total: 1,
  page: 1,
  pageSize: 31,
  items: [{ cutoff: "2026-10-07T00:00:00.000Z", ranAt: "2026-10-07T00:00:05.000Z", items: 7, subscribers: 2750, delivered: 2740, bounced: 6, notSent: 4 }],
};

export const DISTRIBUTION: DistributionReport = {
  from: "2026-09-08",
  to: "2026-10-07",
  totals: { sent: 18, delivered: 14, hardBounced: 2, softBounced: 2, failed: 1 },
  apps: [
    { app: "News On Demand", sent: 15, delivered: 12, hardBounced: 1, softBounced: 2, failed: 1 },
    { app: "nrms-client", sent: 3, delivered: 2, hardBounced: 1, softBounced: 0, failed: 0 },
  ],
  days: [
    { date: "2026-10-06", app: "News On Demand", sent: 15, delivered: 12, hardBounced: 1, softBounced: 2, failed: 1 },
    { date: "2026-10-06", app: "nrms-client", sent: 3, delivered: 2, hardBounced: 1, softBounced: 0, failed: 0 },
  ],
};
```

Add three `DEFAULTS` entries:
- `["/nod/api/reports/release-sends", () => jsonResponse(200, RELEASE_SENDS)]`;
- `["/nod/api/reports/digest-runs", () => jsonResponse(200, DIGEST_RUNS)]`;
- `["/nod/api/reports/distribution", () => jsonResponse(200, DISTRIBUTION)]`.

`reports/ReleaseSendsReportScreen.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { calledUrls, renderAt, stubReports } from "../../../../test/reportFixtures";
import { ReleaseSendsReportScreen } from "./ReleaseSendsReportScreen";

const PATTERN = "/subscribers/reports/release-sends";

describe("ReleaseSendsReportScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("shows each release's counts by mode in BC time, with the range the server used and its CSV", async () => {
    stubReports(["NoD.Viewer"]);
    renderAt(PATTERN, PATTERN, <ReleaseSendsReportScreen />);
    expect(await screen.findByRole("row", { name: /^2026-10-06 09:30 Budget 2027 News release 4 1 2 1 1 1 0 0$/ })).toBeInTheDocument();
    expect(screen.getByLabelText("From (BC date)")).toHaveValue("2026-09-08");
    expect(screen.getByLabelText("To (BC date)")).toHaveValue("2026-10-07");
    expect(screen.getByRole("link", { name: "Download (CSV)" })).toHaveAttribute("href", "/nod/api/reports/release-sends.csv?from=2026-09-08&to=2026-10-07");
    await waitFor(() => expect(document.title).toBe("Sends per release — GCPE News Staff"));
  });

  it("asks for the range in the URL, and for a new one when staff change it", async () => {
    const fetchMock = stubReports(["NoD.Viewer"]);
    renderAt(`${PATTERN}?from=2026-09-01&to=2026-09-30`, PATTERN, <ReleaseSendsReportScreen />);
    await waitFor(() => expect(calledUrls(fetchMock)).toContain("/nod/api/reports/release-sends?from=2026-09-01&to=2026-09-30"));
    fireEvent.change(await screen.findByLabelText("From (BC date)"), { target: { value: "2026-08-01" } });
    fireEvent.change(screen.getByLabelText("To (BC date)"), { target: { value: "2026-08-31" } });
    await userEvent.setup().click(screen.getByRole("button", { name: "Show" }));
    await waitFor(() => expect(calledUrls(fetchMock)).toContain("/nod/api/reports/release-sends?from=2026-08-01&to=2026-08-31"));
  });

  it("explains a range that's too long", async () => {
    stubReports(["NoD.Viewer"], {
      "/nod/api/reports/release-sends": () => new Response(JSON.stringify({ error: "range-too-long", maxDays: 92 }), { status: 400, headers: { "content-type": "application/json" } }),
    });
    renderAt(`${PATTERN}?from=2026-01-01&to=2026-06-30`, PATTERN, <ReleaseSendsReportScreen />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a range of 92 days or fewer.");
    expect(screen.queryByRole("link", { name: "Download (CSV)" })).toBeNull();
  });
});
```

`reports/DigestRunsReportScreen.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { renderAt, stubReports } from "../../../../test/reportFixtures";
import { DigestRunsReportScreen } from "./DigestRunsReportScreen";

const PATTERN = "/subscribers/reports/digest-runs";

describe("DigestRunsReportScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("shows each run in BC time with its email counts and the CSV", async () => {
    stubReports(["NoD.Viewer"]);
    renderAt(PATTERN, PATTERN, <DigestRunsReportScreen />);
    expect(await screen.findByRole("row", { name: /^2026-10-06 17:00 2026-10-06 17:00 7 2750 2740 6 4$/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download (CSV)" })).toHaveAttribute("href", "/nod/api/reports/digest-runs.csv?from=2026-09-08&to=2026-10-07");
    await waitFor(() => expect(document.title).toBe("Daily digest runs — GCPE News Staff"));
  });
});
```

`reports/DistributionReportScreen.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { jsonResponse } from "../../../../test/jsonResponse";
import { renderAt, stubReports } from "../../../../test/reportFixtures";
import { DistributionReportScreen } from "./DistributionReportScreen";

const PATTERN = "/subscribers/reports/distribution";

describe("DistributionReportScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("shows totals by sending app and counts by day", async () => {
    stubReports(["NoD.Viewer"]);
    renderAt(PATTERN, PATTERN, <DistributionReportScreen />);
    const totals = await screen.findByRole("table", { name: "Totals" });
    expect(within(totals).getByRole("row", { name: /^News On Demand 15 12 1 2 1$/ })).toBeInTheDocument();
    expect(within(totals).getByRole("row", { name: /^All senders 18 14 2 2 1$/ })).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "By day" })).getByRole("row", { name: /^2026-10-06 nrms-client 3 2 1 0 0$/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download (CSV)" })).toHaveAttribute("href", "/nod/api/reports/distribution.csv?from=2026-09-08&to=2026-10-07");
    await waitFor(() => expect(document.title).toBe("Distribution sent and bounced — GCPE News Staff"));
  });

  it("Distribution unavailable: says so, offers no CSV, and keeps the range form", async () => {
    stubReports(["NoD.Viewer"], { "/nod/api/reports/distribution": () => jsonResponse(502, { error: "distribution unavailable" }) });
    renderAt(PATTERN, PATTERN, <DistributionReportScreen />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Distribution is unavailable right now. Try again in a few minutes.");
    expect(screen.queryByRole("link", { name: "Download (CSV)" })).toBeNull();
    expect(screen.getByRole("button", { name: "Show" })).toBeInTheDocument();
  });
});
```

Add to `reports/a11y.test.tsx` (importing the three screens):

```tsx
  it.each([
    ["release-sends", () => <ReleaseSendsReportScreen />, "Budget 2027"],
    ["digest-runs", () => <DigestRunsReportScreen />, "2750"],
    ["distribution", () => <DistributionReportScreen />, "nrms-client"],
  ])("%s report", async (slug, element, text) => {
    stubReports(["NoD.Viewer"]);
    const path = `/subscribers/reports/${slug}`;
    const { container } = renderAt(path, path, element());
    await screen.findAllByText(text);
    expect(await seriousViolations(container)).toEqual([]);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/subscribers/reports`
Expected: FAIL ("Failed to load url ./ReleaseSendsReportScreen" and similar).

- [ ] **Step 3: Implement the range form and hook**

`reports/RangeForm.tsx`:

```tsx
import { useState, type FormEvent } from "react";
import { Button, Form, TextField } from "@bcgov/design-system-react-components";

/** From/To as BC calendar days. The parent keys this on the range it shows, so the server's
 * resolved default (the last 30 days) fills both fields. */
export function RangeForm({ from, to, onApply }: { from: string; to: string; onApply(from: string, to: string): void }): React.JSX.Element {
  const [f, setF] = useState(from);
  const [t, setT] = useState(to);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onApply(f, t);
  };
  return (
    <Form onSubmit={submit} aria-label="Date range" className="gcpe-reports__range">
      <TextField label="From (BC date)" type="date" value={f} onChange={setF} />
      <TextField label="To (BC date)" type="date" value={t} onChange={setT} />
      <Button type="submit">Show</Button>
      <p>Up to 92 days at a time.</p>
    </Form>
  );
}
```

`reports/useRangedReport.ts`:

```ts
import { reportUrl } from "./reportUrl";
import { useReport } from "./useReport";
import { useReportParams } from "./useReportParams";

/** A date-ranged report: the range and page come from the page URL; until staff pick one, the
 * server's default (the last 30 days) is shown and filled into the form. */
export function useRangedReport<T extends { from: string; to: string }>(path: string) {
  const params = useReportParams();
  const from = params.value("from");
  const to = params.value("to");
  const report = useReport<T>(reportUrl(path, { from, to, page: params.page > 1 ? params.page : undefined }));
  return {
    report,
    params,
    shown: { from: report.data?.from ?? from, to: report.data?.to ?? to },
    csvHref: (csvPath: string) => reportUrl(csvPath, { from: report.data?.from, to: report.data?.to }),
    apply: (f: string, t: string) => params.update({ from: f || null, to: t || null }),
  };
}
```

- [ ] **Step 4: Implement the three screens**

`reports/ReleaseSendsReportScreen.tsx`:

```tsx
import { InlineAlert } from "@bcgov/design-system-react-components";
import { useTenantTimeZone } from "../../../format/tenantTimeZone";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { Pagination } from "../../releases/Pagination";
import { CsvLink } from "./CsvLink";
import { reportErrorText } from "./errors";
import { bcDateTime } from "./format";
import { RangeForm } from "./RangeForm";
import { useRangedReport } from "./useRangedReport";
import type { ModeCounts, RangedPage, ReleaseSendRow } from "./types";

const COLUMNS = ["Recipients", "Delivered", "Bounced", "Not sent"];

function ModeCells({ c }: { c: ModeCounts }): React.JSX.Element {
  return (
    <>
      <td>{c.recipients}</td>
      <td>{c.delivered}</td>
      <td>{c.bounced}</td>
      <td>{c.notSent}</td>
    </>
  );
}

/** `/hub/subscribers/reports/release-sends` (spec §8): as-it-happens and media-list emails per
 * release or alert published in the range. */
export function ReleaseSendsReportScreen(): React.JSX.Element {
  useDocumentTitle("Sends per release");
  const timeZone = useTenantTimeZone();
  const { report, params, shown, csvHref, apply } = useRangedReport<RangedPage<ReleaseSendRow>>("/nod/api/reports/release-sends");
  const d = report.data;
  return (
    <div className="gcpe-reports">
      <h1>Sends per release</h1>
      <p>
        As-it-happens and media-list emails for each release or alert published in the range. Delivered means handed to Distribution and
        not bounced; not sent includes sends still going out. Daily digest emails are in Daily digest runs.
      </p>
      <RangeForm key={`${shown.from}|${shown.to}`} from={shown.from} to={shown.to} onApply={apply} />
      {report.error ? <InlineAlert variant="danger" role="alert" description={reportErrorText(report.error)} /> : null}
      {!d && !report.error && <p>Loading…</p>}
      {d && (
        <>
          <p>{`${d.total} ${d.total === 1 ? "release" : "releases"} sent from ${d.from} to ${d.to}.`}</p>
          <CsvLink href={csvHref("/nod/api/reports/release-sends.csv")}>Download (CSV)</CsvLink>
          {d.items.length > 0 ? (
            <table aria-label="Sends per release">
              <thead>
                <tr>
                  <th scope="col" rowSpan={2}>Published</th>
                  <th scope="col" rowSpan={2}>Release</th>
                  <th scope="col" rowSpan={2}>Type</th>
                  <th scope="colgroup" colSpan={4}>As it happens</th>
                  <th scope="colgroup" colSpan={4}>Media lists</th>
                </tr>
                <tr>
                  {["aih", "media"].flatMap((g) => COLUMNS.map((c) => <th key={`${g}-${c}`} scope="col">{c}</th>))}
                </tr>
              </thead>
              <tbody>
                {d.items.map((r) => (
                  <tr key={r.itemKey}>
                    <td>{bcDateTime(r.publishedAt, timeZone)}</td>
                    <th scope="row">{r.title}</th>
                    <td>{r.type}</td>
                    <ModeCells c={r.asItHappens} />
                    <ModeCells c={r.media} />
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>No releases were sent in this range.</p>
          )}
          <Pagination page={d.page} pageSize={d.pageSize} total={d.total} onPageChange={(n) => params.update({ page: String(n) })} />
        </>
      )}
    </div>
  );
}
```

`reports/DigestRunsReportScreen.tsx`:

```tsx
import { InlineAlert } from "@bcgov/design-system-react-components";
import { useTenantTimeZone } from "../../../format/tenantTimeZone";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { Pagination } from "../../releases/Pagination";
import { CsvLink } from "./CsvLink";
import { reportErrorText } from "./errors";
import { bcDateTime } from "./format";
import { RangeForm } from "./RangeForm";
import { useRangedReport } from "./useRangedReport";
import type { DigestRunRow, RangedPage } from "./types";

/** `/hub/subscribers/reports/digest-runs` (spec §8): each 17:00 digest run in the range, counted
 * in emails (one per subscriber). */
export function DigestRunsReportScreen(): React.JSX.Element {
  useDocumentTitle("Daily digest runs");
  const timeZone = useTenantTimeZone();
  const { report, params, shown, csvHref, apply } = useRangedReport<RangedPage<DigestRunRow>>("/nod/api/reports/digest-runs");
  const d = report.data;
  return (
    <div className="gcpe-reports">
      <h1>Daily digest runs</h1>
      <p>Each daily digest run: one email per subscriber. Items are the releases the run&rsquo;s window offered.</p>
      <RangeForm key={`${shown.from}|${shown.to}`} from={shown.from} to={shown.to} onApply={apply} />
      {report.error ? <InlineAlert variant="danger" role="alert" description={reportErrorText(report.error)} /> : null}
      {!d && !report.error && <p>Loading…</p>}
      {d && (
        <>
          <CsvLink href={csvHref("/nod/api/reports/digest-runs.csv")}>Download (CSV)</CsvLink>
          {d.items.length > 0 ? (
            <table aria-label="Daily digest runs">
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  <th scope="col">Ran at</th>
                  <th scope="col">Items in window</th>
                  <th scope="col">Subscribers</th>
                  <th scope="col">Delivered</th>
                  <th scope="col">Bounced</th>
                  <th scope="col">Not sent</th>
                </tr>
              </thead>
              <tbody>
                {d.items.map((r) => (
                  <tr key={r.cutoff}>
                    <th scope="row">{bcDateTime(r.cutoff, timeZone)}</th>
                    <td>{bcDateTime(r.ranAt, timeZone)}</td>
                    <td>{r.items}</td>
                    <td>{r.subscribers}</td>
                    <td>{r.delivered}</td>
                    <td>{r.bounced}</td>
                    <td>{r.notSent}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>No digest ran in this range.</p>
          )}
          <Pagination page={d.page} pageSize={d.pageSize} total={d.total} onPageChange={(n) => params.update({ page: String(n) })} />
        </>
      )}
    </div>
  );
}
```

`reports/DistributionReportScreen.tsx`:

```tsx
import { InlineAlert } from "@bcgov/design-system-react-components";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { CsvLink } from "./CsvLink";
import { reportErrorText } from "./errors";
import { RangeForm } from "./RangeForm";
import { useRangedReport } from "./useRangedReport";
import type { DeliveryCounts, DistributionReport } from "./types";

const HEADINGS = ["Sent", "Delivered", "Hard bounces", "Soft bounces", "Failed"];

function CountCells({ c }: { c: DeliveryCounts }): React.JSX.Element {
  return (
    <>
      <td>{c.sent}</td>
      <td>{c.delivered}</td>
      <td>{c.hardBounced}</td>
      <td>{c.softBounced}</td>
      <td>{c.failed}</td>
    </>
  );
}

/** `/hub/subscribers/reports/distribution` (spec §8): what Distribution sent, by BC day and sending
 * app. Distribution answers this itself; when it's down, the screen says so. */
export function DistributionReportScreen(): React.JSX.Element {
  useDocumentTitle("Distribution sent and bounced");
  const { report, shown, csvHref, apply } = useRangedReport<DistributionReport>("/nod/api/reports/distribution");
  const d = report.data;
  return (
    <div className="gcpe-reports">
      <h1>Distribution sent and bounced</h1>
      <p>
        Every email Distribution sent, by BC day and sending app. Delivered is sent less bounces. Failed emails were never sent and are
        counted on the day they were queued.
      </p>
      <RangeForm key={`${shown.from}|${shown.to}`} from={shown.from} to={shown.to} onApply={apply} />
      {report.error ? <InlineAlert variant="danger" role="alert" description={reportErrorText(report.error)} /> : null}
      {!d && !report.error && <p>Loading…</p>}
      {d && (
        <>
          <CsvLink href={csvHref("/nod/api/reports/distribution.csv")}>Download (CSV)</CsvLink>
          <table aria-label="Totals">
            <thead>
              <tr>
                <th scope="col">Sent by</th>
                {HEADINGS.map((h) => (
                  <th key={h} scope="col">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.apps.map((a) => (
                <tr key={a.app}>
                  <th scope="row">{a.app}</th>
                  <CountCells c={a} />
                </tr>
              ))}
              <tr>
                <th scope="row">All senders</th>
                <CountCells c={d.totals} />
              </tr>
            </tbody>
          </table>
          {d.days.length > 0 ? (
            <table aria-label="By day">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Sent by</th>
                  {HEADINGS.map((h) => (
                    <th key={h} scope="col">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.days.map((day) => (
                  <tr key={`${day.date}|${day.app}`}>
                    <th scope="row">{day.date}</th>
                    <td>{day.app}</td>
                    <CountCells c={day} />
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>Nothing was sent in this range.</p>
          )}
        </>
      )}
    </div>
  );
}
```

`apps/staff-web/src/router.tsx`: import the three screens and add, after `reports/unsubscribes`:

```tsx
          { path: "reports/release-sends", element: <ReleaseSendsReportScreen /> },
          { path: "reports/digest-runs", element: <DigestRunsReportScreen /> },
          { path: "reports/distribution", element: <DistributionReportScreen /> },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web`
Expected: PASS. Then run the staff-web type-check.

If a row-name regex fails only on whitespace (how cell text joins into an accessible name), adjust the whitespace, not the intent.

- [ ] **Step 6: Commit**

```bash
git add apps/staff-web
git commit -m "feat(staff-web): sends per release, daily digest runs and Distribution reports with date ranges"
```

---
### Task 7: End to end, probe numbers, docs and verification

**Files:**
- Create: `tests/e2e/reports.spec.ts`.
- Modify:
  - `docs/parity/changes-from-legacy.md`, `docs/parity/open-questions.md`;
  - `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`;
  - `docs/superpowers/plans/phase-4-carry-forward.md`.

**Interfaces:**
- Consumes (`tests/e2e/playwright-support.ts`): `signInAs`, `ROLE_LOGINS`, `apiCall`, `baseUrl`, `tick`, `createApprovedAndPublished`, `uniqueHeadline`, `expectNoSeriousA11yViolations`. Also the two `[probe]` lines from Tasks 3 and 4.

- [ ] **Step 1: Write the e2e spec**

`tests/e2e/reports.spec.ts`:

```ts
// NoD parity spec §8 Reports and §10 item 14, end to end through the stack: every report opens for
// a NoD Viewer with axe clean; address CSVs are refused to a Viewer and download for an Editor with
// a BOM; a published release shows in Sends per release and in Distribution's totals.
import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import {
  apiCall, baseUrl, createApprovedAndPublished, expectNoSeriousA11yViolations, ROLE_LOGINS, signInAs, tick, uniqueHeadline,
} from "./playwright-support";

const REPORTS: [link: string, h1: string][] = [
  ["Active subscribers by list", "Active subscribers by list"],
  ["Recent unsubscribes", "Recent unsubscribes"],
  ["Sends per release", "Sends per release"],
  ["Daily digest runs", "Daily digest runs"],
  ["Distribution sent and bounced", "Distribution sent and bounced"],
];

test.describe("Reports", () => {
  test("a NoD Viewer opens every report and gets count-only CSVs; address CSVs are refused", async ({ page, context }) => {
    await signInAs(context, "nodViewer");
    await page.goto(`${baseUrl()}/hub/subscribers/reports`);
    await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "reports index");
    for (const [link, h1] of REPORTS) {
      await page.goto(`${baseUrl()}/hub/subscribers/reports`);
      await page.getByRole("link", { name: link }).click();
      await expect(page.getByRole("heading", { level: 1, name: h1 })).toBeVisible();
      await expect(page.getByText("Loading…")).toHaveCount(0);
      await expectNoSeriousA11yViolations(page, h1);
    }
    await page.goto(`${baseUrl()}/hub/subscribers/reports/unsubscribes`);
    await expect(page.getByRole("link", { name: "Download daily counts (CSV)" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Download list with addresses (CSV)" })).toHaveCount(0);

    const viewer = await ROLE_LOGINS.nodViewer();
    for (const path of ["/nod/api/reports/unsubscribes.csv", "/nod/api/reports/subscribers-by-list/members.csv?list=all"]) {
      expect((await fetch(`${baseUrl()}${path}`, { headers: { cookie: viewer } })).status).toBe(403);
    }
  });

  test("an Editor downloads every active subscriber as a CSV with a BOM", async ({ page, context }) => {
    const admin = await ROLE_LOGINS.admin();
    const email = `report-${Date.now()}@example.test`;
    await apiCall(admin, "/nod/api/subscribers", { method: "POST", body: { email, lists: ["ministries:finance"] } });

    await signInAs(context, "nodEditor");
    await page.goto(`${baseUrl()}/hub/subscribers/reports/subscribers-by-list?list=all`);
    await expect(page.getByRole("heading", { level: 2, name: "Members: All active subscribers" })).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download members (CSV)" }).click()]);
    expect(download.suggestedFilename()).toMatch(/^subscribers-all-\d{4}-\d{2}-\d{2}\.csv$/);
    const bytes = await readFile((await download.path())!);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = bytes.toString("utf8");
    expect(text.split("\r\n")[0]).toBe("﻿Email,Timing,Source,Registered (BC time)");
    expect(text).toMatch(new RegExp(`\\r\\n${email.replace(/[.]/g, "\\.")},As it happens,Added by staff,\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}\\r\\n`));
  });

  test("a published release appears in Sends per release and in Distribution's totals", async ({ page, context }) => {
    const admin = await ROLE_LOGINS.admin();
    await apiCall(admin, "/nod/api/subscribers", { method: "POST", body: { email: `report-aih-${Date.now()}@example.test`, lists: "all" } });
    const headline = uniqueHeadline("Reports end to end");
    await createApprovedAndPublished(await ROLE_LOGINS.editor(), { headline });
    await expect
      .poll(
        async () => {
          await tick();
          const r = await apiCall<{ items: { title: string; asItHappens: { delivered: number } }[] }>(admin, "/nod/api/reports/release-sends");
          return r.items.find((i) => i.title === headline)?.asItHappens.delivered ?? 0;
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);

    await signInAs(context, "nodViewer");
    await page.goto(`${baseUrl()}/hub/subscribers/reports/release-sends`);
    await expect(page.getByRole("row", { name: new RegExp(headline) })).toBeVisible();
    await page.goto(`${baseUrl()}/hub/subscribers/reports/distribution`);
    await expect(page.getByRole("table", { name: "Totals" }).getByRole("row", { name: /^News On Demand \d+/ })).toBeVisible();
  });
});
```

Check three details against the stack before running:
- **The item title.** NoD's `items.title` for a published release must be the headline. If NoD stores something else (read `apps/nod/src/items.ts`), match on what it stores.
- **The e2e Distribution app id.** It must equal NoD's `distributionAppId`, so the Totals row reads "News On Demand". If the stack gives NoD a different `DISTRIBUTION_APP_ID`, assert on that id instead, and note it.
- **The source label.** `POST /nod/api/subscribers` must create `source: "admin"` ("Added by staff"). Read `addSubscriber` in `apps/nod/src/subscribers.ts`.

- [ ] **Step 2: Run the new spec; expect FAIL until it's right, then PASS**

Run: `npx -y -p node@24 -- npm run test:e2e -- tests/e2e/reports.spec.ts`

Fix selector mismatches against the real screens, never by weakening a role or CSV assertion.

- [ ] **Step 3: Docs**

**`docs/parity/changes-from-legacy.md`:**
- Add rows to the "NoD and Distribution (Phase 4)" table, using the next free numbers. C99 onward at planning time; re-check first.
- Status is "Agreed" unless noted.

| # | Legacy | New | Why | Status |
|---|---|---|---|---|
| C99 | Four subscriber-list reports: ActiveSubscribers (all enabled, not per list); AsItHappens and DailyDigest (subscribers by timing, filterable Active/Disabled/Deleted); SubscriberListReport (who was on chosen lists between two dates, rebuilt by counting `SysLog` subscribe/unsubscribe events). | One "Active subscribers by list" report: today's active counts per list, split by timing, plus a paged member list for any list, All news or everyone, filterable by timing. Disabled and deleted subscribers by timing are found with the Subscribers search's status filter. "Who was on list X between two dates" isn't ported. | A snapshot answers "who gets this list now". Legacy's history view counted events rather than reading membership, and miscounted after re-subscribes. | Proposed (Q41) |
| C100 | Recent unsubscribes: self-unsubscribes since server-local midnight 90 days ago, one row per person, showing current status and registered date. | Same window, from BC midnight. Also lists staff deletions, and says how and when. Adds the window's counts of new, returning and unsubscribed subscribers. Bounce-disabled subscribers aren't listed. | Staff asked "who left?"; a staff delete is a departure too. Counts give the trend legacy's SubscriberListReport tried to show. | Proposed (Q40) |
| C101 | N/A: legacy had no per-send reports (its "As It Happens" and "Daily Digest" reports were subscriber lists). | Sends per release (as-it-happens and media: recipients, delivered, bounced, not sent) and Daily digest runs (per run: items, subscribers, delivered, bounced, not sent). | Spec §8. | Agreed |
| C102 | Distribution report: counts of `SysLog` sent rows vs all bounce rows in a date range. Its bounced count's start filter used the end date (`DistributionReport.aspx.cs:59`); its CSV built per-address detail but never wrote it. | Counts from Distribution's own message records, per BC day and sending app: sent, delivered (sent less bounces), hard and soft bounces, failed. No per-address list; a subscriber's own history shows their bounces. | Distribution is the authority on what it sent; legacy's numbers came from a log NoD wrote about itself. | Proposed |
| C103 | `report.csv`: no BOM, no quoting, no protection against formula cells, for anyone who could open the reports. | UTF-8 CSV with a BOM (Excel reads it), RFC 4180 quoting, cells that would run as formulas made inert, named `<report>-<date>.csv`, streamed. CSVs with addresses are for NoD Editors and Admins only (Q37), and each such export is recorded (who and which report, never the addresses) in the operations log. | Exports leave the system: they must be correct, safe to open, and accountable. | Agreed |
| C104 | Report date ranges were unlimited (or absent). | Ranges are BC calendar days, at most 92 at a time, defaulting to the last 30. | Bounded queries at legacy volume (Q21); a quarter covers routine reporting. | Proposed (Q39) |

**`docs/parity/open-questions.md`, Open.** Add rows in the table's own format (`| # | Question | Why it matters | Working assumption | Raised |`), using the next free numbers (Q39 onward at planning time):

| # | Question | Why it matters | Working assumption | Raised |
|---|---|---|---|---|
| Q39 | Is 92 days enough per report request, or do staff need a year at a time (for example, annual Distribution totals)? | Longer ranges mean slower, heavier queries at legacy volume. | 92 days; a year is four downloads. | 2026-10-07 |
| Q40 | Should subscribers disabled by bounces appear in Recent unsubscribes? | They stop receiving email but didn't choose to leave. | No; they're found under Subscribers with the Disabled status. | 2026-10-07 |
| Q41 | Does anyone use legacy's "subscribed to list X between two dates" report (SubscriberListReport)? | It's the one legacy report not carried over. | No; the snapshot by list replaces it. | 2026-10-07 |

In Q21's row, append one sentence giving the two `[probe]` lines' numbers. Use this pattern: "Reports (4h) at this volume, local Postgres: sends per release 90 days N ms (page N ms); digest runs N ms; Distribution 92 days N ms; …"

**`docs/manuals/running-notes.md`, Phase 4 block.** Add:
- **Viewer**: Subscribers → Reports has five reports: active subscribers by list, recent unsubscribes, sends per release, daily digest runs, and Distribution sent and bounced. Dates are BC days; pick up to 92 at a time, or leave them empty for the last 30.
- **Viewer**: Every report downloads as a CSV that opens in Excel. Viewers get counts only; CSVs with email addresses (a list's members, recent unsubscribes) are for NoD Editors and Admins.
- **Editor**: Each address CSV you download is recorded in the operations log (who, which report; never the addresses).
- **Viewer**: In Sends per release, "delivered" means handed to Distribution and not bounced; "not sent" includes a send still going out. Digest emails are in Daily digest runs, counted once per subscriber.
- **Operations**: The Distribution report comes from Distribution itself. If Distribution is down, that report says so and the others still work.
- **Developer**: Report day boundaries are computed in Node (`apps/nod/src/reports/range.ts`) and passed to SQL as instants; never use `AT TIME ZONE` in a report query. CSVs go through `streamCsv` (`reports/csv.ts`), which neutralises formula cells and aborts, rather than truncates, on error. The legacy-volume probes run with `REPORT_PROBE=1`.

**`docs/deploy/siteground.md`.** Add hand-checks:
- as `nod-viewer`, open each report under Subscribers → Reports;
- download Sends per release and confirm it opens in Excel with accents intact;
- confirm the address-CSV links are absent;
- as `nod-editor`, download Active subscribers → everyone, and confirm the operations log row.

**`docs/superpowers/plans/phase-4-carry-forward.md`:** delete the `## 4h (reports)` section, including its one line, which Task 2 closes.

- [ ] **Step 4: Full verification**

- Both type-checks.
- Full vitest: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run`.
- Both probes: `REPORT_PROBE=1 npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/reports/volume.probe.test.ts apps/distribution/src/reports.probe.test.ts`.
- Full e2e: `npx -y -p node@24 -- npm run test:e2e`.
- `grep -rn "AT TIME ZONE" apps/nod/src/reports apps/distribution/src/reports.ts` returns nothing. (The probe seeds use it only to build legacy-shaped job keys in UTC; that is the one allowed use.)
- `grep -rn "console\.\(log\|info\|warn\|error\)" apps/nod/src/reports apps/nod/src/http/report-routes.ts` shows only the probe's `[probe]` line and the Distribution error label.

Record the passed/skipped counts in the commit body and compare them with 4g's final run (vitest 2629, e2e 61 passed / 1 skipped). Any drop is a regression to fix.

- [ ] **Step 5: Commit and push**

```bash
git add tests/e2e/reports.spec.ts docs
git commit -m "feat(e2e,docs): Phase 4h reports end to end; parity rows, open questions, running notes and probe numbers"
git push -u origin feat/phase-4h
```

The controller deploys to boxs.ca after the final review.

---

## Rulings (decided while Paul was asleep, flagged for review)

- **R1. Reports live under Subscribers → Reports** (`/hub/subscribers/reports`): an index plus one screen per report. Every NoD role reads all five (spec §8 gives Viewer "reports").
  - *Cost if wrong:* moving five routes.
- **R2. CSV roles honour Q37.**
  - Address-bearing CSVs (a list's members; recent unsubscribes with addresses) are `NoD.Editor`/`NoD.Admin`. Every other CSV is count-only and open to Viewers.
  - Viewers get a daily-counts CSV for unsubscribes instead of the address list.
  - The server enforces this (403); the screen hides the links.
  - *Cost if wrong:* one role list per route.
- **R3. Every address export writes an `operations_log` row** (`report-exported`, actor, report and list key; never addresses or contents).
  - *Cost if wrong:* one row per export. No screen shows the log yet.
- **R4. CSVs are plain same-origin GET links.**
  - The session cookie authenticates them; GETs need no CSRF header; the browser streams to disk.
  - Report filters (dates, list key, timing, page) are in the query string. No report takes an address or a search term, and `reportUrl` drops any other key.
- **R5. Streaming without a new dependency.**
  - Rows come from keyset batches (members) or bounded offset batches of at most 1,000, and are written with `drain` backpressure. No `pg-cursor`.
  - The first batch is read before any byte goes out, so an immediate failure is a JSON 500. A later failure destroys the connection, so a partial file never looks complete.
- **R6. Day boundaries are computed in Node** (`dayBounds`, from `@gcpe/config`'s `wallClockToInstant`) and passed to SQL as instants.
  - SQL never uses `AT TIME ZONE`. The local Postgres (14.17) has pre-2026b tzdata, and Distribution has no tenant config. For the same reason, Distribution's report takes its boundaries from NoD.
- **R7. Ranges are BC calendar dates, inclusive.**
  - The default is the last 30 days, today included. The maximum is 92 days, a calendar quarter; beyond it the route returns 400 `range-too-long` (Q39).
  - Recent unsubscribes keeps legacy's fixed 90 days (from BC midnight 90 days ago) with no picker.
- **R8. Active subscribers by list is a current snapshot.**
  - It shows per-list counts split by timing, plus a paged member list for one list, All news or everyone, filterable by timing.
  - It replaces legacy's ActiveSubscribers, AsItHappens and DailyDigest pages; their status filter is the Subscribers search's job.
  - SubscriberListReport's date-range history isn't ported (C99, Q41).
  - Viewers see addresses on screen, as they already do in the Subscribers search (4g R7/R17).
- **R9. Recent unsubscribes** shows the latest `unsubscribed` or `staff-deleted` per person in the window (the carry-forward rule), with how, when, and status now.
  - Bounce-disabled and `media-ended` aren't unsubscribes (Q40).
  - The summary counts subscribed (including legacy `confirmed`), returning (`resubscribed`), unsubscribed, and deleted by staff.
- **R10. Sends per release** lists items (releases and emergency alerts) published in the range with at least one as-it-happens or media delivery. Per mode it gives recipients, delivered, bounced and not sent:
  - **Sent:** handed to Distribution (`distribution_batch_id`).
  - **Bounced:** any bounce recorded (`bounce_status`, hard or soft, as legacy counted).
  - **Delivered:** sent − bounced.
  - **Not sent:** recipients − sent.
  - Digest rows are excluded. A media-list member who also matches publicly already gets one copy only (4c).
- **R11. Daily digest runs** gives one row per run in the range, counted in emails, not item rows.
  - Cancelled jobs (every item withdrawn) are left out.
  - "Items" is what the run's window offered (the digest's own filter), not per-subscriber matches.
  - Jobs are found by job-key prefix (`digestJobKeyPrefix`, now shared with `createDigestJob`), so no schema change.
- **R12. Distribution sent vs bounced** comes from Distribution's message rows, per BC day and sending app.
  - Sent is counted by `sent_at`, bounces by `bounce_hard`, and failed by the batch's queued day.
  - Delivered = sent − hard − soft (legacy's Success = Sent − Bounced).
  - NoD's own app id shows as "News On Demand"; others show their id.
  - No per-address detail (C102).
- **R13. Indexes, all by drizzle-kit:**
  - NoD: `subscriber_history (action, at)`; `deliveries (job_id) WHERE distribution_batch_id IS NULL`; `deliveries (job_id) WHERE bounce_status IS NOT NULL`.
  - Distribution: `messages (sent_at, batch_id, bounce_hard) WHERE status = 'sent'`; `messages (batch_id) WHERE status = 'failed'`.
  - Sends per release needs none: the probe measured 8–46 ms per page on the primary key and `items_published_at_idx`.
- **R14. The budgets in Global Constraints come from a scratch probe at legacy volume.**
  - The probe tests are opt-in (`REPORT_PROBE=1`, about 35 s of seeding). Default runs carry EXPLAIN tests instead.
  - At 92 of 92 days the planner reads Distribution's messages with a parallel seq scan (220–260 ms), which is correct while the table holds only 90 days. The index pays off once history grows; the EXPLAIN test pins that case.
- **R15. Page sizes:** members 50, unsubscribes 50, sends per release 25, digest runs 31. Distribution isn't paged (at most 92 × apps rows).
- **R16. CSV format:**
  - UTF-8 with a BOM, CRLF line ends, RFC 4180 quoting; a leading `'` for cells starting with `= + - @`, tab or CR. Numbers are numbers.
  - Times are `YYYY-MM-DD HH:mm` BC, with "(BC time)" in the header.
  - Files are named `<report>-<BC date>.csv` and sent with `Cache-Control: no-store`.
- **R17. Static h1s and titles:** "Reports", "Active subscribers by list", "Recent unsubscribes", "Sends per release", "Daily digest runs", "Distribution sent and bounced" (4f R11: no async titles).
- **R18. The writ period needs no special handling.** Reports show what happened. The probe sizes on Jul–Sep rates (Q21).

**For Paul to decide:**
- Q39 (the 92-day cap), Q40 (bounce-disabled in Recent unsubscribes) and Q41 (SubscriberListReport not ported).
- Whether C99, C100, C102 and C104 move from Proposed to Agreed.
- Whether R3's export audit row should also get a screen.

## Self-review notes (for the reviewer)

- **Spec §8 Reports coverage:**
  - active subscribers by list: Task 1 (server), Task 5 (screen);
  - recent unsubscribes (90 days): Task 2, Task 5;
  - per-release sends, as-it-happens and media, delivered/bounced: Task 3, Task 6;
  - digest runs: Task 3, Task 6;
  - Distribution sent vs bounced: Task 4, Task 6;
  - CSV for each: Tasks 1-4 (routes), Tasks 5-6 (links);
  - roles: Tasks 1, 2 (server 403s), 5 (links hidden), 7 (e2e).
- **Constraint coverage:**
  - CSV streaming, BOM, filename, `no-store`, abort on failure: Task 1 `csv.test.ts`;
  - formula injection: Task 1 (`csvCell`, members export), Task 3 (release title);
  - never logging contents: Task 1 ("nothing about an export reaches the logs"), Task 4 (Distribution body not logged);
  - bounded queries: `resolveRange` (Task 1), the 400s (Task 3 route test), the fixed window (Task 2);
  - indexes by drizzle-kit with EXPLAIN: Tasks 2, 3, 4;
  - BC time across 2026-11-01: Task 1 (`dayBounds`, `localDateTime`), Task 4 (bucketing), Task 5 (`bcDateTime`);
  - budgets: Task 3 and Task 4 probes, recorded in Task 7;
  - addresses and search terms never in URLs: `reportUrl` (Task 5 test), no route takes either.
- **Carry-forward:** the "4h (reports)" line is implemented in Task 2 (actions) and deleted in Task 7.
- **Types used across tasks:**
  - `ReportRange`, `resolveRange`, `bcToday`, `addDays`, `localDateTime`: Task 1 → Tasks 2-4.
  - `streamCsv`, `oneBatch`, `mapBatches`, `csvFilename`, `CsvCell`: Task 1 → Tasks 2-4.
  - `pageParam`: Task 1 → Tasks 2, 3. `rangeQuery`/`rangeOf`: Task 3 → Task 4.
  - `ReportRouteDeps`: `Pick<SettingsRouteDeps, "timeZone">` (Task 1) → `+ "distribution" | "nodAppId"` (Task 4). `SettingsRouteDeps.nodAppId` is new in Task 4.
  - `RangedPage<T>`: Task 3 (server) and Task 6 (staff-web types), same shape.
  - `DailyReportRow`: Distribution `reports.ts` and NoD `distribution-client.ts` (mirrored, not imported: the two apps share only HTTP).
  - JSON shapes in `staff-web/.../reports/types.ts` mirror Tasks 1-4. Field names are checked against each server type: `subscribers`/`asItHappens`/`digest`; `listName`; `how`/`at`/`status`/`registeredAt`; `type`/`publishedAt`/`notSent`; `cutoff`/`ranAt`/`items`; `hardBounced`/`softBounced`/`failed`.
- **Planner caveats:**
  - Task 1's members CSV test relies on `=` sorting before `p` under `lower()`. If the test database's collation orders punctuation differently, compare the set of lines rather than the order.
  - The digest EXPLAIN test turns off seq scans to show the partial indexes apply. The probe shows the planner choosing them at volume.
  - `getCsv`'s raw-bytes parser keeps the BOM visible. superagent's default text decoding might too, but the test doesn't rely on it.
  - The e2e Distribution label check depends on the stack's NoD app id (Task 7 Step 1 says how to adapt).
