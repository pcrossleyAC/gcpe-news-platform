# Scrubbed Legacy Test Data for boxs.ca Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm run scrub:test-data` restores a legacy `Gcpe.Hub` backup as a `*_Scrubbed` copy on the operator's Mac, pseudonymises people, keeps only ended non-confidential activities and published releases, shifts calendar dates, proves no real person's name, email or phone survives (on SQL Server and again in Postgres), imports it with the existing importers, trials it locally, and, after typed approval, backs up boxs.ca and replaces its calendar, release and public-site data. `npm run scrub:test-data:restore -- <stamp>` undoes a load.

**Architecture:**
- **Pure rules** in `scripts/lib/scrub/`: fictional identities (`identity.ts`, `names.ts`), the people index and name variants (`people.ts`), the text scrubber and leak finder (`text.ts`), date shifting (`dates.ts`), and the legacy table rules and scope SQL (`legacy-schema.ts`). Each has its own unit tests on fictional fixtures.
- **SQL Server work** (`mssql.ts`, `mssql-text.ts`) runs only against a database whose name ends in `_Scrubbed`: restore, scope deletes, emptied tables, structured people columns, every text column, date shift, and Gate 1. Integration tests run against a tiny fictional fixture database when `SCRUB_TEST_MSSQL_PASSWORD` is set, and skip with a clear message otherwise.
- **Postgres work**: Gate 2 (`pg-gate.ts`), local `scrub_*` databases, the four importers run unchanged as child processes, the test-account seed (`local.ts`), and the local trial: the whole stack in process, event drain, replays, search backfill and a smoke test (`trial.ts`, `smoke.ts`).
- **boxs.ca work** (`boxs.ts`): fixed bash scripts piped over `ssh boxs bash -s`. They read database URLs from the stack's own settings file inside a subshell and never print them. They download test accounts, back up all seven databases and `site-output`, and restore inside one `psql --single-transaction` per database.
- **The CLI** (`scripts/scrub-test-data.ts`) is a step runner with injected steps (`runPipeline`), so ordering and stop-at-first-failed-gate are unit-tested without SQL Server or boxs.ca.

**Tech Stack:** Node 24, TypeScript 5.9, `mssql` 12 (already a dependency of `@gcpe/legacy-import`), `pg`, zod 3.25, Vitest 4.1, tsx; on boxs.ca: bash, `psql`/`pg_dump` 18.6, gzip, tar, curl.

**Spec:** `docs/superpowers/specs/2026-10-22-scrubbed-test-data-design.md` (approved 2026-10-22). Read it first: it is the authority. Where this plan differs, the difference is listed under "Spec deviations" and was forced by a verified fact.

---

## Verified while planning (spec §8)

Checked on 2026-10-22, read-only. No data values were selected from the legacy database, and no secret was printed.

### 1. Legacy schema (local restore of `Gcpe.Hub`, SQL Server 2022 CU27, database compatibility level 110)

- **Compatibility level 110:** no `STRING_AGG`, no `DROP … IF EXISTS`. `OFFSET/FETCH`, `TRY_CONVERT` and `CONCAT` are fine. Recovery model is FULL; the scrubbed copy is switched to SIMPLE.
- **No triggers** on any table. Every non-media table has a primary key.
- **People-bearing tables and columns:**
  - `calendar.SystemUser` (1,230 rows): `FullName`, `DisplayName` (nvarchar 50), `EmailAddress` (nvarchar 50), `PhoneNumber` (nvarchar 20), `MobileNumber` (nvarchar 15), `Username` (nvarchar 20), plus free text `Description` (2000) and `JobTitle`.
  - `dbo.User` (107): `DisplayName`, `EmailAddress` (both NOT NULL).
  - `calendar.CommunicationContact` (2,692): `Name` (denormalised copy of its `SystemUserId`'s name).
  - `calendar.GovernmentRepresentative` (334): `Name` (nvarchar 50), `Description` (84).
  - `calendar.EventPlanner` (35): `Name`, `PhoneNumber`, `JobTitle`.
  - `calendar.Videographer` (9): `Name`, `JobTitle`.
  - **Also found (not in spec §4's list):**
    - `dbo.Ministry` (54): `MinisterName`, `MinisterEmail` and `MinisterAddress`, plus HTML `MinisterPageHtml` and `MinisterSummary`. Ministers are also Government Representatives, and their names run through every release, so they join the people list.
    - `dbo.Ministry.ContactUserId`/`SecondContactUserId` point at `calendar.SystemUser`, and Core's import joins them. They are covered by the SystemUser rewrite.
    - `media.Contact` (9,156 journalists: `FirstName`, `LastName`). Their names can appear in calendar text, so they join the people list for free-text replacement. The table itself is emptied.
    - `dashboard.UserMinistryPreference.Email` (227) and the whole `media.*` schema hold people but are read by no importer. Both are emptied.
- **Free-text columns of kept rows** (all scrubbed):
  - `calendar.Activity`: `Title`, `Details`, `Schedule`, `Significance`, `Strategy`, `Comments` (4000), `HqComments`, `LeadOrganization`, `Venue`, `Translations`, `OtherCity`, `PotentialDates`.
  - `calendar.Log`: `OldValue`, `NewValue`, `FieldName`.
  - `calendar.ActivityFilter`: `Name`, `QueryString`.
  - `dbo.NewsReleaseDocumentLanguage`: `BodyHtml`, `Headline`, `Subheadline`, `Byline`, `Organizations`, `PageTitle`.
  - `dbo.NewsReleaseDocumentContact.Information`.
  - `dbo.NewsReleaseLanguage`: `Summary`, `SocialMediaHeadline`, `SocialMediaSummary`, `Location`.
  - `dbo.NewsReleaseLog.Description`.
  - `dbo.NewsRelease.Keywords`.
  - `dbo.Slide`: `Headline`, `Summary`.
  - `dbo.Ministry`/`dbo.Sector`: the `*Html` columns and `MinisterSummary`.
  - `dbo.ApplicationSetting.SettingValue`.
  - `dbo.ResourceLink`, `dbo.MinistryTopic` and `dbo.MinistryService` link text.
  - Every lookup `Name`.
- **What the importers read** (`apps/*/src/import/queries.ts`):
  - **`calendar.Log` is read.** The Calendar importer turns it into activity history (`history-map.ts`), and Carolynn's CAL-11 checks "from legacy log" entries.
  - **`dbo.NewsReleaseLog` is read**, joined to `dbo.User`, as NRMS release history (NRMS-18).
  - **Per spec §8, both are kept for kept rows and scrubbed like other text.** Only `calendar.NewsFeed` (read by nothing) is emptied.
  - `dbo.NewsReleaseHistory` is only counted, so it is emptied, together with its 8,007 `dbo.Blob` rows.
  - `calendar.ActivityFiles` is emptied: attachments are out of scope.
- **Links to fix when rows are removed:**
  - `dbo.Ministry`/`Sector`/`Theme` `TopReleaseId`/`FeatureReleaseId` have NO_ACTION foreign keys to `dbo.NewsRelease`.
  - `dbo.ApplicationSetting` `HomeTopReleaseId`/`HomeFeatureReleaseId` hold release GUIDs as text (NOT NULL; both importers treat `''` as none).
  - `dbo.NewsRelease.ActivityId` has no foreign key.
  - Release child tables cascade, but `NewsReleaseDocumentContact`→`NewsReleaseDocument` is NO_ACTION, so the scope SQL deletes children explicitly.
  - Scheduled (future) carousels are unannounced content too, so they are removed with their slides.
- **Importers currently fail on this backup** (from the 2026-10-22 rehearsal's sanitised report; not part of this plan). See "Prerequisites".

### 2. boxs.ca (`ssh boxs`, read-only)

- **PostgreSQL server 18.6**; `psql`, `pg_dump` and `pg_restore` 18.6 in `/bin`. The local tools are 14.17, so per spec we use **plain-SQL dumps**. psql 18 restores them; PG14 dumps carry no `\restrict` lines.
- **The database user** cannot `CREATE DATABASE` (`rolcreatedb = f`). It owns every table and the `drizzle` schema. `public` is owned by another role (`root`), and the user has CREATE on it.
  - So a restore must drop only the user's own objects and must never drop or comment on `public`.
  - The seven database names are generated (e.g. `db…`). The stack reads them from `*_DATABASE_URL`.
- **Settings file:** `~/www/boxs.ca/public_html/.nodeapp/.env-local` (mode 600) holds `CORE_DATABASE_URL`, `NRMS_DATABASE_URL`, `NEWSAPI_DATABASE_URL`, `SITE_DATABASE_URL`, `NOD_DATABASE_URL`, `DIST_DATABASE_URL`, `CALENDAR_DATABASE_URL` (variable names only were listed). The tick token is at `~/.gcpe-tick-token`.
- **Process control:**
  - The Node app runs outside the SSH session's view: no `ps`, nothing under `/proc`, and `nodejs-manage` only rebuilds a version list.
  - **The stack can be stopped and started only in Site Tools.** The pipeline pauses for the operator and confirms each change by polling `/stack/health` (`200` with `{"status":"ok"}` when up).
- **Disk:**
  - The home filesystem shows 534 GB free (shared); `quota` isn't available over SSH. The home directory uses ~953 MB, of which 848 MB is old `.nodeapp` release folders.
  - Each of the seven databases is 8–10 MB today. The plan prints local database sizes before upload; the operator checks Site Tools' storage meter (open risk).
- **Deployed:** commit `9001d1f` (2026-10-19), with the same migration counts per app as `main`.
- **Current data:**
  - Core: 15 users, all local with passwords, none with legacy ids. 13 are `@example.test`; 2 use other domains and are carried over as they are. There are 26 role grants and 10 memberships over 3 organisation keys.
  - Calendar: 0 activities. NRMS: 13 releases and 1 media list.
  - NoD: 4 subscribers. Its `inbox_positions` hold positions for sources `core` (67) and `nrms` (12).

### 3. Carolynn's UAT rows that depend on the old fictional sample records, or on what the load removes

Source: `~/Desktop/GCPE-boxs-test-script-for-Carolynn.xlsx`. Task 14 puts this list in the runbook.

- **NRMS-17:** the retired test media list lives in NRMS, which is replaced. Paul re-creates a retired list among the legacy lists.
- **NOD-07, NOD-08, NOD-09, NOD-10:** media-list membership. NoD is kept, but its media lists mirror NRMS's. After the load and the media-lists republish, use a legacy list. The old test list in NoD no longer has an NRMS counterpart.
- **CAL-07, CAL-14:** need a confidential activity. The load removes every confidential activity, so cal-editor creates a fictional one first.
- **CAL-18:** "a Core user with no Calendar role". Imported pseudonymised users now exist. Pick one from Calendar access, or a test account.
- **CAL-20:** two Health comm contacts, one with an open activity. These are now pseudonymised legacy comm contacts. Open activities are only among the shifted ones in the coming weeks.
- **CAL-22, CROSS-04:** a confirmed, non-confidential activity with an "Approved…" category from now on. Shifted legacy activities may provide one; otherwise create it as CAL-02 does.
- **Unaffected:** the test accounts (SIGNIN-*, CAL-01 roles), NoD subscribers (NoD kept), and the WEB-*/SITE-* rows that create their own data. SITE-05/SITE-07 "this month" rely on new test releases, since legacy releases keep their real dates (latest 2026-10-22).

## Prerequisites (outside this plan)

- **The importers must run clean against this backup before Task 15**, the real run. The 2026-10-22 rehearsal found two failures:
  - **Core:** `apps/core/src/import/queries.ts` `Q_SERVICES` reads `dbo.Service`, which doesn't exist in this backup.
  - **NRMS:** the page-layout mapping throws on a third legacy `PageLayout` value (26 of 63 `NewsReleaseType` rows).
- Spec D4 runs the importers unchanged, so the fixes belong to the import work, not here. Tasks 1–14 don't depend on them; the pipeline stops at its import step, with the importer's own exit code and a private log, until they are merged.

## Spec deviations (each forced by a verified fact; report to Paul)

1. **Logs:**
   - `calendar.Log` and `dbo.NewsReleaseLog` are kept for kept rows and scrubbed, not truncated: the importers read them (spec §8's own rule).
   - `calendar.NewsFeed` is emptied.
2. **People sources beyond §4's list:** `dbo.Ministry` minister columns and `media.Contact` journalists (text replacement only).
   - Every `calendar.SystemUser` and `dbo.User` row gets a fictional identity, even one whose name can't be parsed, so "every legacy user becomes an invented user" holds.
3. **Step 4 order:** Core import → seed test accounts → NRMS → Calendar → News API. Test accounts' memberships need Core's organisations, matched by key, so the seed can't run before Core's import.
4. **Step 9:**
   - "Stop/start the stack" is a Site Tools action, confirmed by `/stack/health` polling.
   - The News API search text is backfilled locally before the dump, not on boxs.ca: same result, with no checkout needed on the server.
   - NoD's `inbox_positions` for sources `core` and `nrms` are cleared during the load, so NoD accepts the new Core and NRMS event sequences. Then Core and the media lists are republished.
5. **Gate 2 runs twice:** after import (spec) and again after the local trial, on the exact databases that are dumped.
6. **Transactions:** scope = one transaction; emptied tables = one; structured people = one; text = one per table; dates = one. The copy is disposable: a failure re-restores it on the next run.
7. **Gate checks are stricter than §6:** any email not at `example.test` and any phone not in the fake form fails Gate 1 and Gate 2. This covers "every email and phone found anywhere in the original's text".
8. **Calendar cutoff** `--calendar-cutoff` defaults to `2000-01-01`, so every kept activity is imported (legacy scale).

## Global Constraints

- **Worktree:**
  - Work on `feat/scrubbed-test-data` in `/Users/paul/gcpe-news-platform-scrub`. Never touch `/Users/paul/gcpe-news-platform-5i` (another agent runs importers there).
  - Never create or drop Postgres databases named `rehearsal_*`. This plan's local databases are only `scrub_core`, `scrub_nrms`, `scrub_news_api`, `scrub_site`, `scrub_calendar`, `scrub_nod`, `scrub_distribution`, plus `createTestDatabase`'s `test_*`.
- **Commits:** commit after each task with a plain message and no `Co-Authored-By` line. Push only when the controller says so.
- **Node 24** for everything: `npx -y -p node@24 -- <cmd>`. First time in the worktree: `npx -y -p node@24 -- npm ci`.
- **Tests:** `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run <paths>`. Postgres tests need the local Postgres (default `postgres://localhost:5432/postgres`, override `TEST_DATABASE_ADMIN_URL`).
- **SQL Server integration tests** run only with `SCRUB_TEST_MSSQL_PASSWORD` set; `SCRUB_TEST_MSSQL_SERVER`/`USER`/`PORT` default to `127.0.0.1`/`sa`/`1433`. Load it without printing it: `SCRUB_TEST_MSSQL_PASSWORD="$(sed -n 's/^MSSQL_SA_PASSWORD=//p' ~/gcpe-parity-private/mssql.env)"`. The tests create and drop only `ScrubFixture_<hex>_Scrubbed` databases.
- **Type checks:** `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json` and `… -p apps/staff-web/tsconfig.json`.
- **Migrations:** none are needed. If one ever is: drizzle-kit only.
- **Real data:**
  - The repository holds fictional data only. Invented names (for example "Quill Ashbury"). Phones are 555-01xx only. Output addresses are `@example.test`.
  - Fixtures that must look *real* (input to the scrubber) use the RFC 2606 domains `@gov.example`/`@news.example`, because `@example.test` is the scrubber's own output domain and is deliberately left alone.
  - Fixture phones use 555-01xx numbers in formats other than the fake output form `250-555-01NN`, for example `(604) 555-0142`, `604.555.0142`, `555.0142`.
  - Never write a real legacy value into the repo, a test, a comment, a commit message or a log line.
- **Private output:**
  - Real data, the real→fake mapping, test-account password hashes, reports with row ids, dumps and logs go only under `~/gcpe-parity-private` (`--out` must be inside it), with umask 077, folders 700 and files 600.
  - The scrub key lives at `~/gcpe-parity-private/scrub-key`.
- **Never connect to `Gcpe.Hub` for writing.** Every writing function checks `DB_NAME()` ends in `_Scrubbed`. Importers get `LEGACY_SQL_DATABASE=<the _Scrubbed name>` only.
- **No secrets printed or written to the repo:**
  - the SQL Server password;
  - boxs.ca's `.env-local` and its database URLs;
  - `~/.gcpe-tick-token`;
  - the break-glass and test-account passwords. These are prompted hidden through `Prompter.hidden` from `scripts/siteground-env.ts`.
- **Logging:**
  - No debug logging. Progress lines carry step names, table and column names, and counts only.
  - Errors print our own `ScrubArgumentError`/`ScrubStepError` messages (written to carry no data) or `safeErrorLabel(e)`, never a driver's `e.message`: SQL Server's truncation error quotes the value.
- **No contact with boxs.ca from any test.** Only Task 15, run by the controller, uses `ssh boxs` or `https://boxs.ca`.
- **Code style:** match the surrounding code (2-space indent, double quotes, semicolons, `node:` imports, long lines like `scripts/calendar-report-parity.ts`).
  - Comments say why, not what. No task, decision or spec-section labels ("Task 3", "D2", "§4") in code comments.
  - Reuse `mssql` (already installed for `@gcpe/legacy-import`), `pg`, `@gcpe/db-kit`, `@gcpe/http-kit`'s `safeErrorLabel`, and `scripts/siteground-env.ts`'s prompt helpers.

## Review Focus

These failure modes are implied by the spec, but no requirement names them. They are the most likely to bite, most likely first. Each has a pinned test in the task that owns the code.

1. **A person's name split by markup, an entity or a line break, or written possessive, surname-first or in capitals, inside release HTML.** Expected: replaced, with the markup between the parts kept intact. Test: Task 4, "keeps markup between name parts".
2. **A fictional identity that equals a real person's name, or a carried-over test account's email.** Expected: a different identity. Test: Task 2, "never hands out a forbidden name or a reserved email".
3. **A replacement longer than its column** (`Description` nvarchar(84), `MobileNumber` nvarchar(15), `Username` nvarchar(20)). Expected: a value fitted to the column, not a failed transaction. Test: Task 8, "fits a longer replacement to the column".
4. **Running the scrub twice**, on the same text or as a second run with the same key. Expected: no further change, and the same fictional identities. Tests: Task 4 "is idempotent", Task 8 "a second pass changes nothing".
5. **Kept rows pointing at removed rows:**
   - a kept release linked to a removed activity;
   - a Top/Feature or `HomeTopReleaseId` pointing at a removed release;
   - a scheduled carousel's slides.

   Expected: NULL or `''`, and the dependent rows removed, with no foreign-key error. Test: Task 7, "scopes releases, activities and carousels".

---

## File structure

| File | Responsibility |
|---|---|
| `scripts/lib/scrub/private-out.ts` | Private folder checks, private writes, the scrub key, run stamps, error classes |
| `scripts/lib/scrub/args.ts` | `scrub:test-data` command line |
| `scripts/lib/scrub/names.ts` | Fictional first names and surnames |
| `scripts/lib/scrub/identity.ts` | Keyed, deterministic fictional identities, fake phones and emails |
| `scripts/lib/scrub/people.ts` | Name parsing, variants, the people index built from legacy rows |
| `scripts/lib/scrub/text.ts` | `scrubText`, `findLeaks` (strict and plain routes), email and phone detectors |
| `scripts/lib/scrub/dates.ts` | Wall clock, week offset, shifting log date text |
| `scripts/lib/scrub/legacy-schema.ts` | Required and emptied tables, identifier columns, people queries, scope SQL |
| `scripts/lib/scrub/mssql.ts` | SQL Server pool, restore of the copy, scope, emptied tables, counts, date shift |
| `scripts/lib/scrub/mssql-text.ts` | People read and structured rewrite, every-text-column scrub, Gate 1 |
| `scripts/lib/scrub/pg-gate.ts` | Gate 2 over Postgres text, JSON and array columns, plus the sign-in check |
| `scripts/lib/scrub/local.ts` | Local `scrub_*` databases, importer steps, test-account seed |
| `scripts/lib/scrub/smoke.ts` | Sign-in, health and the five-check smoke test over HTTP |
| `scripts/lib/scrub/trial.ts` | Local in-process stack, event drain, replays, backfill, smoke |
| `scripts/lib/scrub/boxs.ts` | Remote scripts (test accounts, backup, restore, ticks), ssh, upload, download, local dump |
| `scripts/scrub-test-data.ts` | `runPipeline` and the real step wiring |
| `scripts/scrub-test-data-restore.ts` | Undo a load from a boxs.ca backup |
| `tests/scrub/*.test.ts`, `tests/scrub/mssql-fixture.ts` | Tests and the fictional SQL Server fixture |
| `scripts/siteground-env.ts` | Modify: export `promptHidden` and `Prompter` |
| `package.json` | Modify: two scripts |
| `docs/deploy/siteground.md`, `docs/manuals/running-notes.md` | Runbook section and operator line |

---

### Task 1: Private output, run stamps and the command line

**Files:**
- Create: `scripts/lib/scrub/private-out.ts`, `scripts/lib/scrub/args.ts`
- Test: `tests/scrub/private-out.test.ts`, `tests/scrub/args.test.ts`

**Interfaces:**
- Consumes: `bcDateSchema` from `@gcpe/calendar-contract`.
- Produces:
  - `PRIVATE_ROOT: string`
  - `class ScrubArgumentError`
  - `class ScrubStepError`
  - `preparePrivateDir(dir: string, root?: string): string` (returns the real path)
  - `writePrivate(path: string, content: string | Uint8Array): void`
  - `loadOrCreateKey(path: string): string` (64 hex)
  - `runStamp(d?: Date): string` (`YYYYMMDD-HHMMSS`, UTC)
  - `withPrivateUmask<T>(fn: () => Promise<T>): Promise<T>`
  - `STEPS`, `type Step`
  - `interface ScrubOptions { backup; out; keyFile; scrubbedDb; calendarCutoff; site; sshHost; stopAfter; calendarUser; releaseUser; leadDays }`
  - `parseScrubArgs(argv: string[], privateRoot?: string): ScrubOptions`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/scrub/private-out.test.ts
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrCreateKey, preparePrivateDir, runStamp, ScrubArgumentError, writePrivate } from "../../scripts/lib/scrub/private-out";

const root = () => mkdtempSync(join(tmpdir(), "scrub-private-"));

describe("private output", () => {
  it("creates an owner-only folder inside the private root", () => {
    const r = root();
    const dir = preparePrivateDir(join(r, "run", "one"), r);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("refuses a folder outside the private root, or the root itself", () => {
    const r = root();
    expect(() => preparePrivateDir(join(tmpdir(), "elsewhere"), r)).toThrow(ScrubArgumentError);
    expect(() => preparePrivateDir(r, r)).toThrow(ScrubArgumentError);
  });

  it("refuses a folder inside the repository", () => {
    expect(() => preparePrivateDir(resolve(import.meta.dirname, "..", "..", "tmp-out"), resolve(import.meta.dirname, "..", ".."))).toThrow(/outside the repository/);
  });

  it("writes files readable by the owner only", () => {
    const r = root();
    const p = join(preparePrivateDir(join(r, "x"), r), "f.txt");
    writePrivate(p, "fictional");
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("creates the key once and reads the same key back", () => {
    const p = join(root(), "scrub-key");
    const k = loadOrCreateKey(p);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(loadOrCreateKey(p)).toBe(k);
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("rejects a malformed key file", () => {
    const p = join(root(), "bad-key");
    writeFileSync(p, "not hex");
    expect(() => loadOrCreateKey(p)).toThrow(ScrubArgumentError);
    expect(readFileSync(p, "utf8")).toBe("not hex");
  });

  it("stamps a run in UTC", () => {
    expect(runStamp(new Date("2026-10-22T23:59:58.123Z"))).toBe("20261022-235958");
  });
});
```

```ts
// tests/scrub/args.test.ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseScrubArgs } from "../../scripts/lib/scrub/args";
import { ScrubArgumentError } from "../../scripts/lib/scrub/private-out";

const base = ["--backup", "/backup/Hub_TEST.bak", "--out", "/p/runs"];

describe("parseScrubArgs", () => {
  it("fills the defaults", () => {
    const o = parseScrubArgs(base, "/p");
    expect(o).toMatchObject({ backup: "/backup/Hub_TEST.bak", out: "/p/runs", keyFile: join("/p", "scrub-key"), scrubbedDb: "Gcpe.Hub_Scrubbed", calendarCutoff: "2000-01-01", site: "https://boxs.ca", sshHost: "boxs", stopAfter: "load", calendarUser: "cal-hq-editor@example.test", releaseUser: "editor@example.test", leadDays: 14 });
  });

  it("requires --backup and --out", () => {
    expect(() => parseScrubArgs(["--out", "/p/x"], "/p")).toThrow(/--backup/);
    expect(() => parseScrubArgs(["--backup", "/b/x.bak"], "/p")).toThrow(/--out/);
  });

  it.each([
    [["--backup", "relative.bak"], /absolute/],
    [["--backup", "/b/../x.bak"], /absolute/],
    [["--scrubbed-db", "Gcpe.Hub"], /_Scrubbed/],
    [["--calendar-cutoff", "2026-02-30"], /YYYY-MM-DD/],
    [["--site", "http://boxs.ca"], /https/],
    [["--ssh-host", "boxs; rm -rf ~"], /--ssh-host/],
    [["--stop-after", "everything"], /--stop-after/],
    [["--calendar-user", "not-an-email"], /--calendar-user/],
    [["--nope"], /Unknown argument/],
  ])("rejects %j", (extra, message) => {
    const argv = [...base.filter((_, i) => !(extra[0] === "--backup" && (i === 0 || i === 1))), ...extra];
    expect(() => parseScrubArgs(argv, "/p")).toThrow(ScrubArgumentError);
    expect(() => parseScrubArgs(argv, "/p")).toThrow(message);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run tests/scrub/private-out.test.ts tests/scrub/args.test.ts`
Expected: FAIL, "Cannot find module '../../scripts/lib/scrub/private-out'".

- [ ] **Step 3: Implement**

```ts
// scripts/lib/scrub/private-out.ts
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Everything holding real data, the mapping and the key lives under here, and nowhere else. */
export const PRIVATE_ROOT = join(homedir(), "gcpe-parity-private");
const REPO = resolve(import.meta.dirname, "..", "..", "..");

/** A bad command line or setting: its message is ours and carries no data, so it is safe to print. */
export class ScrubArgumentError extends Error { override name = "ScrubArgumentError"; }
/** A step that failed for a reason we can name without quoting any data. */
export class ScrubStepError extends Error { override name = "ScrubStepError"; }

/** The real path of `p`, resolving the nearest existing parent when `p` doesn't exist yet. */
function real(p: string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) break;
    rest.unshift(basename(cur));
    cur = up;
  }
  return join(realpathSync(cur), ...rest);
}
const strictlyInside = (root: string, p: string) => {
  const rel = relative(real(root), real(p));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

export function preparePrivateDir(dir: string, root = PRIVATE_ROOT): string {
  if (real(dir) === real(REPO) || strictlyInside(REPO, dir)) throw new ScrubArgumentError("--out must be outside the repository: the run holds real data");
  if (!strictlyInside(root, dir)) throw new ScrubArgumentError(`--out must be a folder inside ${root}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return real(dir);
}

export function writePrivate(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

const KEY = /^[0-9a-f]{64}$/;
/** The key that makes fictional identities stable from run to run without being guessable from the repo. */
export function loadOrCreateKey(path: string): string {
  if (existsSync(path)) {
    const k = readFileSync(path, "utf8").trim();
    if (!KEY.test(k)) throw new ScrubArgumentError("the scrub key file must hold 64 hex characters");
    return k;
  }
  const k = randomBytes(32).toString("hex");
  writePrivate(path, `${k}\n`);
  return k;
}

export function runStamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

export async function withPrivateUmask<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.umask(0o077);
  try {
    return await fn();
  } finally {
    process.umask(previous);
  }
}
```

```ts
// scripts/lib/scrub/args.ts
import { join, resolve } from "node:path";
import { bcDateSchema } from "@gcpe/calendar-contract";
import { PRIVATE_ROOT, ScrubArgumentError } from "./private-out";

export const STEPS = ["copy", "scrub", "gate1", "import", "gate2", "trial", "approve", "backup", "load"] as const;
export type Step = (typeof STEPS)[number];

export interface ScrubOptions {
  /** The .bak path as SQL Server sees it (in the local container, /backup/<file>.bak). */
  backup: string;
  out: string;
  keyFile: string;
  scrubbedDb: string;
  calendarCutoff: string;
  site: string;
  sshHost: string;
  stopAfter: Step;
  calendarUser: string;
  releaseUser: string;
  leadDays: number;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseScrubArgs(argv: string[], privateRoot = PRIVATE_ROOT): ScrubOptions {
  const o: Partial<Record<string, string>> = {};
  const flags = ["--backup", "--out", "--key-file", "--scrubbed-db", "--calendar-cutoff", "--site", "--ssh-host", "--stop-after", "--calendar-user", "--release-user"];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!flags.includes(a)) throw new ScrubArgumentError(`Unknown argument: ${a}`);
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) throw new ScrubArgumentError(`${a} needs a value`);
    o[a] = v;
  }
  const backup = o["--backup"];
  if (!backup) throw new ScrubArgumentError("--backup <file> is required: the .bak path as SQL Server sees it");
  if (!/^\/[A-Za-z0-9_./-]+\.bak$/.test(backup) || backup.split("/").includes("..")) throw new ScrubArgumentError("--backup must be an absolute .bak path of letters, digits, _ . / and - only");
  const out = o["--out"];
  if (!out) throw new ScrubArgumentError("--out <folder> is required");
  const scrubbedDb = o["--scrubbed-db"] ?? "Gcpe.Hub_Scrubbed";
  if (!/^[A-Za-z0-9_.]+_Scrubbed$/.test(scrubbedDb)) throw new ScrubArgumentError("--scrubbed-db must end in _Scrubbed");
  const calendarCutoff = o["--calendar-cutoff"] ?? "2000-01-01";
  if (!bcDateSchema.safeParse(calendarCutoff).success) throw new ScrubArgumentError("--calendar-cutoff must be a real date, YYYY-MM-DD");
  const site = (o["--site"] ?? "https://boxs.ca").replace(/\/+$/, "");
  let url: URL;
  try { url = new URL(site); } catch { throw new ScrubArgumentError("--site must be an https origin"); }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) throw new ScrubArgumentError("--site must be an https origin");
  const sshHost = o["--ssh-host"] ?? "boxs";
  if (!/^[A-Za-z0-9._-]+$/.test(sshHost)) throw new ScrubArgumentError("--ssh-host must be an ssh host alias");
  const stopAfter = (o["--stop-after"] ?? "load") as Step;
  if (!STEPS.includes(stopAfter)) throw new ScrubArgumentError(`--stop-after must be one of: ${STEPS.join(", ")}`);
  const calendarUser = o["--calendar-user"] ?? "cal-hq-editor@example.test";
  if (!EMAIL.test(calendarUser)) throw new ScrubArgumentError("--calendar-user must be an email address");
  const releaseUser = o["--release-user"] ?? "editor@example.test";
  if (!EMAIL.test(releaseUser)) throw new ScrubArgumentError("--release-user must be an email address");
  return { backup, out: resolve(out), keyFile: resolve(o["--key-file"] ?? join(privateRoot, "scrub-key")), scrubbedDb, calendarCutoff, site, sshHost, stopAfter, calendarUser, releaseUser, leadDays: 14 };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run tests/scrub/private-out.test.ts tests/scrub/args.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check and commit**

```bash
npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json
git add scripts/lib/scrub/private-out.ts scripts/lib/scrub/args.ts tests/scrub/private-out.test.ts tests/scrub/args.test.ts
git commit -m "scrub: private output folder, key and command line"
```

---

### Task 2: Fictional identities

**Files:**
- Create: `scripts/lib/scrub/names.ts`, `scripts/lib/scrub/identity.ts`
- Test: `tests/scrub/identity.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `FIRST_NAMES: readonly string[]`, `SURNAMES: readonly string[]`
  - `interface FakeIdentity { slot: number; first: string; last: string; full: string; email: string; phone: string; username: string }`
  - `CAPACITY: number`
  - `FAKE_PHONE: RegExp` (`/^(?:250-)?555-01\d\d$/`)
  - `hmacInt(key: string, value: string): number`
  - `fakePhone(key: string, seed: string): string` (`250-555-01NN`)
  - `fakeEmailFor(key: string, email: string): string` (`person<n>@example.test`)
  - `identityAt(slot: number): Omit<FakeIdentity, "phone">`
  - `createIdentityAllocator(key: string, o: { forbiddenNames: ReadonlySet<string>; reservedEmails: ReadonlySet<string> }): { allocate(personKey: string): FakeIdentity }`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/scrub/identity.test.ts
import { describe, expect, it } from "vitest";
import { CAPACITY, createIdentityAllocator, FAKE_PHONE, fakeEmailFor, fakePhone, identityAt } from "../../scripts/lib/scrub/identity";
import { FIRST_NAMES, SURNAMES } from "../../scripts/lib/scrub/names";

const KEY = "a".repeat(64);
const none = { forbiddenNames: new Set<string>(), reservedEmails: new Set<string>() };

describe("fictional identities", () => {
  it("gives the same identity to the same person for the same key and order", () => {
    const a = createIdentityAllocator(KEY, none);
    const b = createIdentityAllocator(KEY, none);
    expect(a.allocate("e:quill.ashbury@gov.example")).toEqual(b.allocate("e:quill.ashbury@gov.example"));
  });

  it("gives different people different identities", () => {
    const a = createIdentityAllocator(KEY, none);
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(a.allocate(`n:person ${i}`).full);
    expect(seen.size).toBe(2000);
  });

  it("depends on the key", () => {
    const p = "e:quill.ashbury@gov.example";
    expect(createIdentityAllocator(KEY, none).allocate(p).slot).not.toBe(createIdentityAllocator("b".repeat(64), none).allocate(p).slot);
  });

  it("never hands out a forbidden name or a reserved email", () => {
    const first = createIdentityAllocator(KEY, none).allocate("n:quill ashbury");
    const guarded = createIdentityAllocator(KEY, { forbiddenNames: new Set([first.full.toLowerCase()]), reservedEmails: new Set() }).allocate("n:quill ashbury");
    expect(guarded.full).not.toBe(first.full);
    const reserved = createIdentityAllocator(KEY, { forbiddenNames: new Set(), reservedEmails: new Set([first.email]) }).allocate("n:quill ashbury");
    expect(reserved.email).not.toBe(first.email);
  });

  it("fits every identity into legacy's shortest columns", () => {
    let full = 0, email = 0, username = 0;
    for (let slot = 0; slot < CAPACITY; slot++) {
      const id = identityAt(slot);
      full = Math.max(full, id.full.length); email = Math.max(email, id.email.length); username = Math.max(username, id.username.length);
    }
    expect(full).toBeLessThanOrEqual(50);
    expect(email).toBeLessThanOrEqual(50);
    expect(username).toBeLessThanOrEqual(20);
    expect(CAPACITY).toBeGreaterThanOrEqual(20_000);
  });

  it("makes example.test emails and 555-01xx phones", () => {
    const id = createIdentityAllocator(KEY, none).allocate("n:quill ashbury");
    expect(id.email).toMatch(/^[a-z]+\.[a-z]+@example\.test$/);
    expect(id.phone).toMatch(FAKE_PHONE);
    expect(fakePhone(KEY, "6045550142")).toMatch(/^250-555-01\d\d$/);
    expect(fakePhone(KEY, "6045550142")).toBe(fakePhone(KEY, "6045550142"));
    expect(fakeEmailFor(KEY, "Press@News.Example")).toBe(fakeEmailFor(KEY, "press@news.example"));
    expect(fakeEmailFor(KEY, "press@news.example")).toMatch(/^person\d{1,6}@example\.test$/);
  });

  it("uses only letters in names", () => {
    for (const n of [...FIRST_NAMES, ...SURNAMES]) expect(n).toMatch(/^[A-Z][a-z]+$/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run tests/scrub/identity.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// scripts/lib/scrub/names.ts
/** Given names for fictional people. Common enough to read naturally, paired with invented surnames below. */
export const FIRST_NAMES = [
  "Alex", "Avery", "Blair", "Cameron", "Casey", "Dana", "Devon", "Drew", "Eden", "Ellis",
  "Emerson", "Finley", "Harper", "Hayden", "Jamie", "Jesse", "Jordan", "Jules", "Kai", "Kendall",
  "Logan", "Marley", "Morgan", "Noel", "Oakley", "Parker", "Peyton", "Quinn", "Reese", "Remy",
  "Riley", "Robin", "Rowe", "Sam", "Shay", "Sidney", "Skyler", "Stevie", "Sutton", "Tatum",
  "Taylor", "Teagan", "Toby", "Val", "Ari", "Cass", "Dale", "Eli", "Fran", "Glen",
  "Hollis", "Isa", "Kit", "Mel", "Nico", "Ollie", "Pat", "Rae", "Sol", "Tali",
  "Uma", "Vic", "Wynn", "Zane", "Brook", "Cody", "Darby", "Emery", "Frankie", "Gale",
  "Hart", "Indy", "Jody", "Kerry", "Lane", "Milan", "Nova", "Orrin", "Perry", "Rory",
] as const;

const STEMS = ["Ash", "Birch", "Cedar", "Alder", "Briar", "Fern", "Heath", "Larch", "Maple", "Rowan", "Thistle", "Willow", "Hazel", "Juniper", "Moss", "Reed", "Sorrel", "Tansy", "Yarrow", "Clover", "Bramble", "Elder", "Holly", "Linden", "Myrtle", "Quince", "Sedge", "Teasel", "Vetch", "Wren"] as const;
const ENDINGS = ["field", "wood", "brook", "ford", "ley", "ton", "more", "dale", "croft", "well"] as const;
/** Invented surnames: plant names joined to place-name endings. */
export const SURNAMES: readonly string[] = STEMS.flatMap((s) => ENDINGS.map((e) => `${s}${e}`));
```

```ts
// scripts/lib/scrub/identity.ts
import { createHmac } from "node:crypto";
import { FIRST_NAMES, SURNAMES } from "./names";

export interface FakeIdentity { slot: number; first: string; last: string; full: string; email: string; phone: string; username: string }

export const CAPACITY = FIRST_NAMES.length * SURNAMES.length;
/** What the scrubber writes, so a second pass leaves it alone and the gates accept it. */
export const FAKE_PHONE = /^(?:250-)?555-01\d\d$/;

export function hmacInt(key: string, value: string): number {
  return createHmac("sha256", key).update(value).digest().readUIntBE(0, 6);
}

export function fakePhone(key: string, seed: string): string {
  return `250-555-01${String(hmacInt(key, `phone:${seed}`) % 100).padStart(2, "0")}`;
}

export function fakeEmailFor(key: string, email: string): string {
  return `person${hmacInt(key, `email:${email.toLowerCase()}`) % 1_000_000}@example.test`;
}

export function identityAt(slot: number): Omit<FakeIdentity, "phone"> {
  const first = FIRST_NAMES[slot % FIRST_NAMES.length]!;
  const last = SURNAMES[Math.floor(slot / FIRST_NAMES.length) % SURNAMES.length]!;
  return { slot, first, last, full: `${first} ${last}`, email: `${first}.${last}@example.test`.toLowerCase(), username: `user${String(slot).padStart(5, "0")}` };
}

export interface IdentityAllocator { allocate(personKey: string): FakeIdentity }

/**
 * Each person starts at a keyed slot and probes forward past slots already taken, names that
 * belong to a real person in the people list, and emails a carried-over test account uses.
 * Allocating people in a stable order therefore gives the same identities on every run.
 */
export function createIdentityAllocator(key: string, o: { forbiddenNames: ReadonlySet<string>; reservedEmails: ReadonlySet<string> }): IdentityAllocator {
  const used = new Set<number>();
  return {
    allocate(personKey) {
      const start = hmacInt(key, `person:${personKey}`) % CAPACITY;
      for (let i = 0; i < CAPACITY; i++) {
        const slot = (start + i) % CAPACITY;
        if (used.has(slot)) continue;
        const id = identityAt(slot);
        if (o.forbiddenNames.has(id.full.toLowerCase()) || o.reservedEmails.has(id.email)) continue;
        used.add(slot);
        return { ...id, phone: fakePhone(key, `person:${personKey}`) };
      }
      throw new Error("ran out of fictional identities");
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run tests/scrub/identity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/scrub/names.ts scripts/lib/scrub/identity.ts tests/scrub/identity.test.ts
git commit -m "scrub: keyed fictional identities"
```

---

### Task 3: The people index

**Files:**
- Create: `scripts/lib/scrub/people.ts`
- Test: `tests/scrub/people.test.ts`

**Interfaces:**
- Consumes: `createIdentityAllocator`, `FakeIdentity` (Task 2).
- Produces:
  - `interface PersonSource { source: string; id: string; names: (string | null)[]; email: string | null; phones: (string | null)[]; linkId?: string | null; linkSource?: string; alwaysPerson?: boolean }`
  - `interface Person { key: string; names: string[]; emails: string[]; phones: string[]; sources: string[]; fake: FakeIdentity }`
  - `interface VariantHit { person: Person; surnameFirst: boolean }`
  - `interface PeopleIndex { persons: Person[]; bySource: Map<string, Person>; byVariant: Map<string, VariantHit>; byEmail: Map<string, Person>; firstTokens: Set<string>; maxWords: number }`
  - `TOKEN_RE`
  - `normToken(t: string): string`
  - `normEmail(raw: string | null): string | null`
  - `parseName(raw: string | null): { given: string[]; surname: string[] } | null`
  - `nameVariants(raw: string | null): { key: string; surnameFirst: boolean }[]`
  - `buildPeopleIndex(sources: PersonSource[], key: string, reservedEmails?: ReadonlySet<string>): PeopleIndex`
  - `mappingCsv(index: PeopleIndex): string`

  Source keys in `bySource` are `${source}:${id}`. Variant keys are lowercase, accent-free tokens joined by single spaces, with `" , "` marking the surname-first comma (e.g. `"ashbury , quill"`).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/scrub/people.test.ts
import { describe, expect, it } from "vitest";
import { buildPeopleIndex, mappingCsv, nameVariants, normEmail, parseName, type PersonSource } from "../../scripts/lib/scrub/people";

const KEY = "c".repeat(64);
const src = (source: string, id: string, names: (string | null)[], email: string | null = null, extra: Partial<PersonSource> = {}): PersonSource => ({ source, id, names, email, phones: [], ...extra });

describe("parseName", () => {
  it.each([
    ["Quill Ashbury", { given: ["quill"], surname: ["ashbury"] }],
    ["Ashbury, Quill", { given: ["quill"], surname: ["ashbury"] }],
    ["Hon. Dorian Feld", { given: ["dorian"], surname: ["feld"] }],
    ["José Ñúñez", { given: ["jose"], surname: ["nunez"] }],
    ["Marisol Tennant-Vey", { given: ["marisol"], surname: ["tennant-vey"] }],
    ["Quill Q. Ashbury", { given: ["quill"], surname: ["ashbury"] }],
  ])("parses %s", (raw, expected) => expect(parseName(raw)).toEqual(expected));

  it.each(["Premier", "Deputy Minister", "Admin", "", null, "Room 250", "a@b.example", "One Two Three Four Five"])("rejects %j", (raw) => expect(parseName(raw)).toBeNull());
});

describe("nameVariants", () => {
  it("covers the full, first-last and surname-first forms", () => {
    expect(nameVariants("Quill Bryn Ashbury").map((v) => v.key).sort()).toEqual(["ashbury , quill", "ashbury , quill bryn", "quill ashbury", "quill bryn ashbury"].sort());
    expect(nameVariants("Quill Ashbury").find((v) => v.key === "ashbury , quill")?.surnameFirst).toBe(true);
  });
});

describe("normEmail", () => {
  it("lowercases valid addresses and drops invalid ones", () => {
    expect(normEmail(" Quill.Ashbury@Gov.Example ")).toBe("quill.ashbury@gov.example");
    expect(normEmail("quill at gov")).toBeNull();
    expect(normEmail(null)).toBeNull();
  });
});

describe("buildPeopleIndex", () => {
  const sources: PersonSource[] = [
    src("calendar.SystemUser", "1", ["Quill Ashbury", "Ashbury, Quill"], "quill.ashbury@gov.example", { alwaysPerson: true, phones: ["(604) 555-0142"] }),
    src("dbo.User", "U1", ["Quill Ashbury"], "Quill.Ashbury@gov.example", { alwaysPerson: true }),
    src("calendar.CommunicationContact", "7", ["Q. Ashbury"], null, { linkId: "1", linkSource: "calendar.SystemUser" }),
    src("calendar.GovernmentRepresentative", "1", ["Hon. Dorian Feld"]),
    src("dbo.Ministry", "M1", ["Dorian Feld"], "dorian.feld@gov.example"),
    src("calendar.GovernmentRepresentative", "2", ["Premier"]),
    src("calendar.SystemUser", "3", ["Admin"], null, { alwaysPerson: true }),
  ];
  const index = buildPeopleIndex(sources, KEY, new Set(["editor@example.test"]));
  const of = (k: string) => index.bySource.get(k);

  it("joins rows sharing an email, whatever the case", () => {
    expect(of("calendar.SystemUser:1")).toBe(of("dbo.User:U1"));
  });

  it("joins a comm contact to the user it names", () => {
    expect(of("calendar.CommunicationContact:7")).toBe(of("calendar.SystemUser:1"));
  });

  it("joins a name-only row to the person with that name", () => {
    expect(of("calendar.GovernmentRepresentative:1")).toBe(of("dbo.Ministry:M1"));
  });

  it("leaves a role name out but still gives every user row an identity", () => {
    expect(of("calendar.GovernmentRepresentative:2")).toBeUndefined();
    expect(of("calendar.SystemUser:3")?.fake.full).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  });

  it("indexes variants, emails and the tokens a match can start with", () => {
    expect(index.byVariant.get("quill ashbury")?.person).toBe(of("calendar.SystemUser:1"));
    expect(index.byVariant.get("ashbury , quill")?.surnameFirst).toBe(true);
    expect(index.byEmail.get("quill.ashbury@gov.example")).toBe(of("calendar.SystemUser:1"));
    expect(index.firstTokens.has("quill") && index.firstTokens.has("ashbury")).toBe(true);
    expect(index.maxWords).toBeGreaterThanOrEqual(2);
  });

  it("is deterministic for the same rows in any order", () => {
    const again = buildPeopleIndex([...sources].reverse(), KEY, new Set(["editor@example.test"]));
    expect(again.bySource.get("calendar.SystemUser:1")?.fake).toEqual(of("calendar.SystemUser:1")?.fake);
  });

  it("never gives a fake name equal to a real one", () => {
    const real = new Set(index.persons.flatMap((p) => p.names.flatMap((n) => nameVariants(n).map((v) => v.key))));
    for (const p of index.persons) expect(real.has(p.fake.full.toLowerCase())).toBe(false);
  });

  it("writes a mapping with one row per person", () => {
    const csv = mappingCsv(index).trim().split("\n");
    expect(csv[0]).toBe("person_key,real_names,real_emails,fake_name,fake_email,fake_phone");
    expect(csv).toHaveLength(index.persons.length + 1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run tests/scrub/people.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// scripts/lib/scrub/people.ts
import { createIdentityAllocator, type FakeIdentity } from "./identity";

export interface PersonSource {
  source: string;
  id: string;
  names: (string | null)[];
  email: string | null;
  phones: (string | null)[];
  /** A row that names another row's person (a comm contact's user). */
  linkId?: string | null;
  linkSource?: string;
  /** User rows always get an identity, even when their name can't be parsed. */
  alwaysPerson?: boolean;
}
export interface Person { key: string; names: string[]; emails: string[]; phones: string[]; sources: string[]; fake: FakeIdentity }
export interface VariantHit { person: Person; surnameFirst: boolean }
export interface PeopleIndex {
  persons: Person[];
  bySource: Map<string, Person>;
  byVariant: Map<string, VariantHit>;
  byEmail: Map<string, Person>;
  firstTokens: Set<string>;
  maxWords: number;
}

/** A word: letters and marks, with inner apostrophes and hyphens (O'Neil, Tennant-Vey). */
export const TOKEN_RE = /[\p{L}\p{M}][\p{L}\p{M}'’-]*/gu;
const HONORIFICS = new Set(["hon", "honourable", "honorable", "the", "rt", "dr", "mr", "mrs", "ms", "mx", "sir", "dame"]);
/** Names made only of these are roles or placeholders, not people. */
const ROLE_WORDS = new Set([
  "premier", "minister", "deputy", "parliamentary", "secretary", "mla", "mp", "assistant", "associate", "acting", "staff", "team",
  "office", "tbd", "tba", "none", "other", "various", "multiple", "ministry", "unknown", "gcpe", "communications", "media",
  "relations", "director", "executive", "chief", "of", "and", "for", "government", "representative", "events", "event",
  "planner", "videographer", "photographer", "coordinator", "admin", "administrator", "system", "test", "user", "hq",
]);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normToken(t: string): string {
  return t.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/’/g, "'");
}

export function normEmail(raw: string | null): string | null {
  if (raw === null) return null;
  const e = raw.trim().toLowerCase();
  return EMAIL.test(e) ? e : null;
}

const tokensOf = (raw: string) => [...raw.matchAll(TOKEN_RE)].map((m) => normToken(m[0])).filter((t) => t.length > 1);

/** A person's name as given names and surname, or null for roles, placeholders and anything that isn't a name. */
export function parseName(raw: string | null): { given: string[]; surname: string[] } | null {
  if (raw === null) return null;
  const s = raw.trim();
  if (s === "" || /[\d@]/.test(s)) return null;
  const parts = s.split(",");
  let given: string[];
  let surname: string[];
  if (parts.length === 2) {
    surname = tokensOf(parts[0]!);
    given = tokensOf(parts[1]!);
  } else if (parts.length === 1) {
    const t = tokensOf(s);
    surname = t.slice(-1);
    given = t.slice(0, -1);
  } else return null;
  while (given.length > 0 && HONORIFICS.has(given[0]!)) given.shift();
  if (given.length === 0 || surname.length === 0 || given.length + surname.length > 4) return null;
  if ([...given, ...surname].every((t) => ROLE_WORDS.has(t))) return null;
  return { given, surname };
}

export function nameVariants(raw: string | null): { key: string; surnameFirst: boolean }[] {
  const p = parseName(raw);
  if (!p) return [];
  const first = p.given[0]!;
  const last = p.surname.join(" ");
  const v = new Map<string, boolean>([
    [[...p.given, last].join(" "), false],
    [`${first} ${last}`, false],
    [`${last} , ${p.given.join(" ")}`, true],
    [`${last} , ${first}`, true],
  ]);
  return [...v].map(([key, surnameFirst]) => ({ key, surnameFirst }));
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

interface Draft { key: string; names: Set<string>; emails: Set<string>; phones: Set<string>; sources: Set<string> }

export function buildPeopleIndex(sources: PersonSource[], key: string, reservedEmails: ReadonlySet<string> = new Set()): PeopleIndex {
  const drafts = new Map<string, Draft>();
  const byCanonical = new Map<string, Draft>();
  const sourceDraft = new Map<string, Draft>();
  const draft = (k: string) => {
    let d = drafts.get(k);
    if (!d) { d = { key: k, names: new Set(), emails: new Set(), phones: new Set(), sources: new Set() }; drafts.set(k, d); }
    return d;
  };
  const sk = (s: PersonSource) => `${s.source}:${s.id}`;
  const canonicalOf = (s: PersonSource) => {
    for (const n of s.names) { const p = parseName(n); if (p) return [...p.given, ...p.surname].join(" "); }
    return null;
  };
  const add = (d: Draft, s: PersonSource) => {
    for (const n of s.names) if (n && n.trim()) d.names.add(n.trim());
    const e = normEmail(s.email);
    if (e) d.emails.add(e);
    for (const p of s.phones) if (p && p.trim()) d.phones.add(p.trim());
    d.sources.add(sk(s));
    sourceDraft.set(sk(s), d);
    const c = canonicalOf(s);
    if (c && !byCanonical.has(c)) byCanonical.set(c, d);
  };
  const sorted = [...sources].sort((a, b) => cmp(sk(a), sk(b)));
  const linked = (s: PersonSource) => !!s.linkId && !!s.linkSource;
  // Emails first: they are the strongest evidence two rows are one person.
  for (const s of sorted) { const e = normEmail(s.email); if (e) add(draft(`e:${e}`), s); }
  // Then names, joining a person who already has that name.
  for (const s of sorted) {
    if (sourceDraft.has(sk(s)) || linked(s)) continue;
    const c = canonicalOf(s);
    if (c) add(byCanonical.get(c) ?? draft(`n:${c}`), s);
  }
  // Every user row is a person, named or not.
  for (const s of sorted) if (!sourceDraft.has(sk(s)) && s.alwaysPerson) add(draft(`s:${sk(s)}`), s);
  // Rows that name another row's person join that person.
  for (const s of sorted) {
    if (sourceDraft.has(sk(s)) || !linked(s)) continue;
    const target = sourceDraft.get(`${s.linkSource}:${s.linkId}`);
    const c = canonicalOf(s);
    if (target) add(target, s);
    else if (c) add(byCanonical.get(c) ?? draft(`n:${c}`), s);
  }

  const forbidden = new Set<string>();
  for (const d of drafts.values()) for (const n of d.names) for (const v of nameVariants(n)) if (!v.surnameFirst) forbidden.add(v.key);
  const allocator = createIdentityAllocator(key, { forbiddenNames: forbidden, reservedEmails });
  const persons: Person[] = [...drafts.values()].sort((a, b) => cmp(a.key, b.key)).map((d) => ({
    key: d.key, names: [...d.names].sort(cmp), emails: [...d.emails].sort(cmp), phones: [...d.phones].sort(cmp), sources: [...d.sources].sort(cmp), fake: allocator.allocate(d.key),
  }));

  const index: PeopleIndex = { persons, bySource: new Map(), byVariant: new Map(), byEmail: new Map(), firstTokens: new Set(), maxWords: 0 };
  for (const p of persons) {
    for (const n of p.names) for (const v of nameVariants(n)) if (!index.byVariant.has(v.key)) index.byVariant.set(v.key, { person: p, surnameFirst: v.surnameFirst });
    for (const e of p.emails) if (!index.byEmail.has(e)) index.byEmail.set(e, p);
    for (const s of p.sources) index.bySource.set(s, p);
  }
  for (const k of index.byVariant.keys()) {
    const words = k.split(" ").filter((w) => w !== ",");
    index.firstTokens.add(words[0]!);
    index.maxWords = Math.max(index.maxWords, words.length);
  }
  return index;
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
/** The real-to-fictional table. It holds real names: write it only with writePrivate. */
export function mappingCsv(index: PeopleIndex): string {
  const rows = index.persons.map((p) => [p.key, p.names.join(" | "), p.emails.join(" | "), p.fake.full, p.fake.email, p.fake.phone].map(csvCell).join(","));
  return ["person_key,real_names,real_emails,fake_name,fake_email,fake_phone", ...rows].join("\n") + "\n";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run tests/scrub/people.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/scrub/people.ts tests/scrub/people.test.ts
git commit -m "scrub: people index from legacy rows"
```

---

### Task 4: Text scrubber and leak finder

**Files:**
- Create: `scripts/lib/scrub/text.ts`
- Test: `tests/scrub/text.test.ts`

**Interfaces:**
- Consumes: `PeopleIndex`, `TOKEN_RE`, `normToken`, `buildPeopleIndex` (Task 3); `FAKE_PHONE`, `fakePhone`, `fakeEmailFor` (Task 2).
- Produces:
  - `EMAIL_RE`
  - `interface Counts { names: number; emails: number; phones: number }`
  - `interface ScrubCtx { index: PeopleIndex; key: string }`
  - `phoneSpans(text): { start: number; end: number; local: boolean }[]`
  - `nameSpans(text, index): NameMatch[]`
  - `scrubText(text: string, ctx: ScrubCtx): { text: string; counts: Counts }`
  - `type LeakKind = "name" | "name-plain" | "email" | "phone"`
  - `findLeaks(text: string, index: PeopleIndex): LeakKind[]`
  - `plainNameHits(text: string, index: PeopleIndex): number`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/scrub/text.test.ts
import { describe, expect, it } from "vitest";
import { buildPeopleIndex } from "../../scripts/lib/scrub/people";
import { findLeaks, plainNameHits, scrubText } from "../../scripts/lib/scrub/text";

const KEY = "d".repeat(64);
const index = buildPeopleIndex([
  { source: "calendar.SystemUser", id: "1", names: ["Quill Ashbury"], email: "quill.ashbury@gov.example", phones: ["(604) 555-0142"], alwaysPerson: true },
  { source: "calendar.GovernmentRepresentative", id: "1", names: ["Hon. Dorian Feld"], email: null, phones: [] },
  { source: "media.Contact", id: "9", names: ["José Ñúñez"], email: null, phones: [] },
  { source: "calendar.SystemUser", id: "2", names: ["Marisol Tennant-Vey"], email: null, phones: [], alwaysPerson: true },
], KEY);
const ctx = { index, key: KEY };
const quill = index.bySource.get("calendar.SystemUser:1")!.fake;
const s = (t: string) => scrubText(t, ctx).text;

describe("names", () => {
  it("replaces a full name inside a sentence", () => expect(s("Met with Quill Ashbury today.")).toBe(`Met with ${quill.first} ${quill.last} today.`));
  it("keeps capitals", () => expect(s("QUILL ASHBURY")).toBe(`${quill.first.toUpperCase()} ${quill.last.toUpperCase()}`));
  it("matches across a line break", () => expect(s("Quill\nAshbury")).toBe(`${quill.first}\n${quill.last}`));
  it("keeps markup between name parts", () => {
    expect(s("Quill&nbsp;Ashbury")).toBe(`${quill.first}&nbsp;${quill.last}`);
    expect(s("<b>Quill</b> <i>Ashbury</i>")).toBe(`<b>${quill.first}</b> <i>${quill.last}</i>`);
    expect(s("<p>Quill Ashbury&#8217;s team</p>")).toBe(`<p>${quill.first} ${quill.last}&#8217;s team</p>`);
    expect(s("Quill &amp; Ashbury")).toBe("Quill &amp; Ashbury");
  });
  it("handles the surname-first form", () => expect(s("Ashbury, Quill said")).toBe(`${quill.last}, ${quill.first} said`));
  it("keeps possessives", () => {
    expect(s("Quill Ashbury's plan")).toBe(`${quill.first} ${quill.last}'s plan`);
    expect(s("Quill Ashbury’s plan")).toBe(`${quill.first} ${quill.last}’s plan`);
  });
  it("leaves an honorific and replaces the person", () => expect(s("Hon. Dorian Feld spoke")).not.toMatch(/Dorian|Feld/));
  it("ignores accents and case", () => expect(s("with jose nunez")).not.toMatch(/jose|nunez/i));
  it("matches hyphenated surnames whole", () => {
    expect(s("Marisol Tennant-Vey")).not.toMatch(/Marisol/);
    expect(s("Marisol Tennant arrived")).toBe("Marisol Tennant arrived");
  });
  it("matches whole words only", () => {
    expect(s("Quillon Ashbury")).toBe("Quillon Ashbury");
    expect(s("Quill Ashburyton")).toBe("Quill Ashburyton");
  });
  it("gives the same person the same name everywhere", () => expect(s("Quill Ashbury and Ashbury, Quill")).toBe(`${quill.first} ${quill.last} and ${quill.last}, ${quill.first}`));
});

describe("emails", () => {
  it("maps a known person's email to their fictional one", () => expect(s("Write quill.ashbury@gov.example.")).toBe(`Write ${quill.email}.`));
  it("maps an unknown email to a numbered example.test address", () => expect(s("press@news.example")).toMatch(/^person\d+@example\.test$/));
  it("leaves example.test alone", () => expect(s("editor@example.test")).toBe("editor@example.test"));
});

describe("phones", () => {
  it.each(["604-555-0142", "(604) 555-0142", "604.555.0142", "+1 604 555 0142", "1-800-555-0142", "604-555-0142 ext. 123", "604-555-0142 x123", "604 555 0142"])("replaces %s", (p) => {
    const out = s(`Call ${p} now`);
    expect(out).toMatch(/^Call 250-555-01\d\d now$/);
  });
  it("replaces a seven-digit local number", () => expect(s("Call 555.0142 now")).toMatch(/^Call 555-01\d\d now$/));
  it.each(["2025-2026", "2026HLTH0001-000001", "1b4e28ba-2fa1-11d2-883f-0016d3cca427", "$1,250,000", "10:30 a.m.", "NEWS-12345", "2026-10-22"])("leaves %s alone", (t) => expect(s(t)).toBe(t));
});

describe("re-running", () => {
  const sample = "Quill Ashbury (604) 555-0142, quill.ashbury@gov.example; Ashbury, Quill's note to press@news.example and Hon. Dorian Feld at 555.0142.";
  it("is idempotent", () => {
    const once = s(sample);
    expect(s(once)).toBe(once);
    expect(scrubText(once, ctx).counts).toEqual({ names: 0, emails: 0, phones: 0 });
  });
  it("is deterministic", () => expect(s(sample)).toBe(s(sample)));
});

describe("findLeaks", () => {
  it("finds every kind before scrubbing and nothing after", () => {
    const raw = "Quill Ashbury, quill.ashbury@gov.example, 604-555-0142";
    expect(new Set(findLeaks(raw, index))).toEqual(new Set(["name", "name-plain", "email", "phone"]));
    expect(findLeaks(s(raw), index)).toEqual([]);
  });
  it("finds names by the plain route too", () => {
    expect(plainNameHits("met Quill Ashbury and Ashbury, Quill", index)).toBe(2);
    expect(plainNameHits("met Quill<br/>Ashbury", index)).toBe(1);
    expect(plainNameHits("(Quill Ashbury), then Quill Ashbury's.", index)).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run tests/scrub/text.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// scripts/lib/scrub/text.ts
import { FAKE_PHONE, fakeEmailFor, fakePhone } from "./identity";
import { normToken, TOKEN_RE, type PeopleIndex, type VariantHit } from "./people";

export const EMAIL_RE = /(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g;
/** North American numbers with an area code: 604-555-0142, (604) 555-0142, 604.555.0142, +1 604 555 0142, 1-800-…, with ext./x. */
const FULL_PHONE_RE = /(?<![\w+-])(?:\+?1[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]\d{4}(?:\s*(?:ext\.?|extension|x)\s*\d{1,6})?(?![\w-])/gi;
/** Seven-digit local numbers, only with a hyphen or dot, so years, ids and keys aren't mistaken for them. */
const LOCAL_PHONE_RE = /(?<![\w+.-])\d{3}[.-]\d{4}(?![\w.-])/g;
const TEST_DOMAIN = "@example.test";

export interface Counts { names: number; emails: number; phones: number }
export interface ScrubCtx { index: PeopleIndex; key: string }
type Role = "given" | "surname" | "drop";
export interface NameMatch { start: number; end: number; hit: VariantHit; parts: { start: number; end: number; role: Role }[] }

export function phoneSpans(text: string): { start: number; end: number; local: boolean }[] {
  const spans: { start: number; end: number; local: boolean }[] = [];
  for (const m of text.matchAll(FULL_PHONE_RE)) spans.push({ start: m.index, end: m.index + m[0].length, local: false });
  for (const m of text.matchAll(LOCAL_PHONE_RE)) {
    const start = m.index, end = m.index + m[0].length;
    if (!spans.some((x) => start < x.end && end > x.start)) spans.push({ start, end, local: true });
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** What may sit between two parts of one name: spaces, line breaks, non-breaking spaces and tags. */
const JOIN_GAP = /^(?:\s|&nbsp;|&#160;|&#xa0;|<[^<>]{0,200}>)+$/i;
const COMMA_GAP = /^,(?:\s|&nbsp;|&#160;|&#xa0;)*$/i;
const POSSESSIVE = /['’]s$/i;

/** Tags and entities, blanked out before finding words so `<b>` or `&nbsp;` never reads as a word. */
const MARKUP_RE = /<[^<>]{0,200}>|&(?:[a-z]+|#\d+|#x[0-9a-f]+);/gi;

export function nameSpans(text: string, index: PeopleIndex): NameMatch[] {
  const masked = text.replace(MARKUP_RE, (m) => " ".repeat(m.length));
  const toks = [...masked.matchAll(TOKEN_RE)].map((m) => ({ start: m.index, end: m.index + m[0].length, norm: normToken(m[0]) }));
  const out: NameMatch[] = [];
  for (let i = 0; i < toks.length; i++) {
    if (!index.firstTokens.has(toks[i]!.norm)) continue;
    let match: NameMatch | null = null;
    let used = 0;
    for (let n = Math.min(index.maxWords, toks.length - i); n >= 2 && !match; n--) {
      let key = toks[i]!.norm;
      let commaAt = -1;
      let ok = true;
      for (let j = i + 1; j < i + n; j++) {
        const gap = text.slice(toks[j - 1]!.end, toks[j]!.start);
        if (JOIN_GAP.test(gap)) key += " ";
        else if (commaAt === -1 && COMMA_GAP.test(gap)) { key += " , "; commaAt = j; }
        else { ok = false; break; }
        key += j === i + n - 1 ? toks[j]!.norm.replace(POSSESSIVE, "") : toks[j]!.norm;
      }
      if (!ok) continue;
      const hit = index.byVariant.get(key);
      if (!hit) continue;
      const last = toks[i + n - 1]!;
      const poss = POSSESSIVE.exec(text.slice(last.start, last.end));
      const parts = toks.slice(i, i + n).map((t, k) => {
        const j = i + k;
        const end = j === i + n - 1 && poss ? t.end - poss[0].length : t.end;
        const role: Role = hit.surnameFirst ? (j === i ? "surname" : j === commaAt ? "given" : "drop") : j === i ? "given" : j === i + n - 1 ? "surname" : "drop";
        return { start: t.start, end, role };
      });
      match = { start: toks[i]!.start, end: parts[parts.length - 1]!.end, hit, parts };
      used = n;
    }
    if (match) { out.push(match); i += used - 1; }
  }
  return out;
}

function replaceSpans<T extends { start: number; end: number }>(text: string, spans: T[], f: (original: string, span: T) => string): string {
  let out = "";
  let at = 0;
  for (const sp of spans) { out += text.slice(at, sp.start) + f(text.slice(sp.start, sp.end), sp); at = sp.end; }
  return out + text.slice(at);
}
const upperIf = (original: string, s: string) => (original === original.toUpperCase() && original !== original.toLowerCase() ? s.toUpperCase() : s);

export function scrubText(text: string, ctx: ScrubCtx): { text: string; counts: Counts } {
  const counts: Counts = { names: 0, emails: 0, phones: 0 };
  let out = text.replace(EMAIL_RE, (m) => {
    const e = m.toLowerCase();
    if (e.endsWith(TEST_DOMAIN)) return m;
    counts.emails++;
    return ctx.index.byEmail.get(e)?.fake.email ?? fakeEmailFor(ctx.key, e);
  });
  out = replaceSpans(out, phoneSpans(out), (m, sp) => {
    if (FAKE_PHONE.test(m)) return m;
    counts.phones++;
    const f = fakePhone(ctx.key, m.replace(/\D/g, ""));
    return sp.local ? f.slice(4) : f;
  });
  const matches = nameSpans(out, ctx.index);
  counts.names += matches.length;
  const parts = matches.flatMap((m) => m.parts.map((p) => ({ ...p, fake: m.hit.person.fake })));
  out = replaceSpans(out, parts, (orig, p) => (p.role === "drop" ? "" : upperIf(orig, p.role === "given" ? p.fake.first : p.fake.last)));
  return { text: out, counts };
}

export type LeakKind = "name" | "name-plain" | "email" | "phone";

/**
 * A second, independent route to the same names: tags and entities become spaces, the text is
 * split on whitespace only, and each run of words is looked up whole. It catches a tokenizer or
 * gap-rule mistake in nameSpans, which would otherwise hide from a gate that used nameSpans alone.
 */
const LEADING_PUNCT = /^[("'“‘[]+/;
const TRAILING_PUNCT = /[.,;:!?)\]"”]+$/;

export function plainNameHits(text: string, index: PeopleIndex): number {
  const words = text.replace(/<[^<>]{0,200}>/g, " ").replace(/&nbsp;|&#160;|&#xa0;/gi, " ").split(/\s+/).filter(Boolean);
  let hits = 0;
  for (let i = 0; i < words.length; i++) {
    for (let n = Math.min(index.maxWords, words.length - i); n >= 2; n--) {
      const key = words.slice(i, i + n).map((w, k) => {
        let t = normToken(w);
        if (k === 0) t = t.replace(LEADING_PUNCT, "");
        if (k === 0 && t.endsWith(",")) t = `${t.slice(0, -1)} ,`;
        if (k === n - 1) t = t.replace(TRAILING_PUNCT, "").replace(POSSESSIVE, "");
        return t;
      }).join(" ");
      if (index.byVariant.has(key)) { hits++; i += n - 1; break; }
    }
  }
  return hits;
}

export function findLeaks(text: string, index: PeopleIndex): LeakKind[] {
  const kinds: LeakKind[] = [];
  for (const m of text.matchAll(EMAIL_RE)) if (!m[0].toLowerCase().endsWith(TEST_DOMAIN)) kinds.push("email");
  for (const sp of phoneSpans(text)) if (!FAKE_PHONE.test(text.slice(sp.start, sp.end))) kinds.push("phone");
  kinds.push(...nameSpans(text, index).map((): LeakKind => "name"));
  for (let i = plainNameHits(text, index); i > 0; i--) kinds.push("name-plain");
  return kinds;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run tests/scrub/text.test.ts`
Expected: PASS.
- If a phone format fails, fix the regex, not the test: every format in spec §4.3 must pass.
- If a "leave alone" case fails, tighten the lookarounds.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/scrub/text.ts tests/scrub/text.test.ts
git commit -m "scrub: text scrubber and leak finder"
```

---

### Task 5: Date shifting

**Files:**
- Create: `scripts/lib/scrub/dates.ts`
- Test: `tests/scrub/dates.test.ts`

**Interfaces:**
- Produces:
  - `DAY_MS`, `WEEK_MS`
  - `wallClockOf(instant: Date, timeZone: string): Date` (a Date whose UTC fields are the wall clock, as `mssql` reads legacy DATETIMEs)
  - `weekOffset(latestEndWall: Date, runWall: Date, leadDays?: number): number`
  - `shiftWall(d: Date, weeks: number): Date`
  - `shiftDateText(raw: string, weeks: number): string | null`
  - `bcToday(now?: Date): string`
  - `addDays(day: string, n: number): string`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/scrub/dates.test.ts
import { describe, expect, it } from "vitest";
import { addDays, bcToday, shiftDateText, shiftWall, wallClockOf, weekOffset } from "../../scripts/lib/scrub/dates";

const wall = (iso: string) => new Date(`${iso}Z`);

describe("dates", () => {
  it("reads BC wall-clock time, including after the move to permanent UTC-7", () => {
    expect(wallClockOf(new Date("2026-10-22T19:00:00Z"), "America/Vancouver").toISOString()).toBe("2026-10-22T12:00:00.000Z");
    expect(wallClockOf(new Date("2026-12-01T19:00:00Z"), "America/Vancouver").toISOString()).toBe("2026-12-01T12:00:00.000Z");
  });

  it("lands the latest kept activity about two weeks after the run, in whole weeks", () => {
    expect(weekOffset(wall("2026-10-12T10:00:00"), wall("2026-10-22T12:00:00"))).toBe(3);
    expect(weekOffset(wall("2026-09-01T10:00:00"), wall("2026-10-22T12:00:00"))).toBe(9);
    expect(weekOffset(wall("2026-12-01T10:00:00"), wall("2026-10-22T12:00:00"))).toBe(0);
  });

  it("keeps weekday and time of day", () => {
    const d = wall("2026-10-12T09:30:00");
    const shifted = shiftWall(d, 3);
    expect(shifted.toISOString()).toBe("2026-11-02T09:30:00.000Z");
    expect(shifted.getUTCDay()).toBe(d.getUTCDay());
  });

  it.each([
    ["10/5/2026 9:00:00 AM", 3, "10/26/2026 9:00:00 AM"],
    ["12/31/2026 11:59:00 PM", 1, "1/7/2027 11:59:00 PM"],
    ["2026-10-05 09:00:00", 3, "2026-10-26 09:00:00"],
    ["2026-10-05T09:00:00.1230000", 1, "2026-10-12T09:00:00.1230000"],
    ["2026-10-05 09:00", 1, "2026-10-12 09:00"],
  ])("shifts log date text %s", (raw, weeks, expected) => expect(shiftDateText(raw, weeks)).toBe(expected));

  it("leaves text it can't read as a date", () => {
    expect(shiftDateText("next Tuesday", 3)).toBeNull();
    expect(shiftDateText("2026-10-05", 3)).toBeNull();
  });

  it("gives BC's date and adds days", () => {
    expect(bcToday(new Date("2026-10-23T06:00:00Z"))).toBe("2026-10-22");
    expect(addDays("2026-10-30", 6)).toBe("2026-11-05");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run tests/scrub/dates.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// scripts/lib/scrub/dates.ts
export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;

export function wallClockOf(instant: Date, timeZone: string): Date {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(instant).map((p) => [p.type, p.value]));
  return new Date(Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!, instant.getUTCMilliseconds()));
}

export function weekOffset(latestEndWall: Date, runWall: Date, leadDays = 14): number {
  return Math.max(0, Math.round((runWall.getTime() + leadDays * DAY_MS - latestEndWall.getTime()) / WEEK_MS));
}

/** Wall-clock values carry no zone, so whole weeks keep weekday and time of day exactly. */
export function shiftWall(d: Date, weeks: number): Date {
  return new Date(d.getTime() + weeks * WEEK_MS);
}

const US = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) ([AP]M)$/i;
const ISO = /^(\d{4})-(\d{2})-(\d{2})([ T])(\d{2}):(\d{2})(?::(\d{2}))?(\.\d{1,7})?$/;
const p2 = (n: number) => String(n).padStart(2, "0");

/** A legacy log's date text, moved by whole weeks in the same format; null when it isn't one of legacy's formats. */
export function shiftDateText(raw: string, weeks: number): string | null {
  const s = raw.trim();
  let m = US.exec(s);
  if (m) {
    const h = (+m[4]! % 12) + (m[7]!.toUpperCase() === "PM" ? 12 : 0);
    const d = shiftWall(new Date(Date.UTC(+m[3]!, +m[1]! - 1, +m[2]!, h, +m[5]!, +m[6]!)), weeks);
    const h12 = d.getUTCHours() % 12 === 0 ? 12 : d.getUTCHours() % 12;
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()} ${h12}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${d.getUTCHours() < 12 ? "AM" : "PM"}`;
  }
  m = ISO.exec(s);
  if (m) {
    const d = shiftWall(new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[5]!, +m[6]!, m[7] ? +m[7] : 0)), weeks);
    return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}${m[4]}${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}${m[7] !== undefined ? `:${p2(d.getUTCSeconds())}` : ""}${m[8] ?? ""}`;
  }
  return null;
}

export function bcToday(now = new Date()): string {
  return wallClockOf(now, "America/Vancouver").toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run tests/scrub/dates.test.ts`
Expected: PASS. On a Node older than 24 the second `wallClockOf` case fails: it pins tzdata ≥ 2026b.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/scrub/dates.ts tests/scrub/dates.test.ts
git commit -m "scrub: calendar date shifting"
```

---

### Task 6: Legacy table rules and scope SQL

**Files:**
- Create: `scripts/lib/scrub/legacy-schema.ts`
- Test: `tests/scrub/legacy-schema.test.ts`

**Interfaces:**
- Produces:
  - `REQUIRED_TABLES: readonly string[]`
  - `ACTIVITY_CHILD_TABLES: readonly string[]`
  - `EMPTIED_TABLES: readonly string[]`
  - `EMPTIED_SCHEMAS: readonly string[]`
  - `IDENTIFIER_COLUMNS: Readonly<Record<string, readonly string[]>>`
  - `interface PeopleQuery { source: string; sql: string; linkSource?: string; alwaysPerson?: boolean }`
  - `PEOPLE_QUERIES: readonly PeopleQuery[]` (each selects `Id, Name1, Name2, Email, Phone1, Phone2, LinkId`, all as nvarchar)
  - `interface StructuredSpec { source: string; table: string; columns: Readonly<Record<string, "full" | "email" | "phone" | "username">> }`
  - `STRUCTURED: readonly StructuredSpec[]`
  - `KEEP_RELEASE`, `KEEP_ACTIVITY`
  - `releaseScopeSql(): string` (expects `@refUtc` datetimeoffset)
  - `activityScopeSql(): string` (expects `@refWall` datetime)
  - `BLOB_CLEANUP_SQL`
  - `quoteName(table: string): string`
  - `quoteCol(col: string): string`

- [ ] **Step 1: Write the failing tests**

The inventory below is the non-media text-column list read from the restored schema while planning: metadata only, no values. It guards the rules against typos.

```ts
// tests/scrub/legacy-schema.test.ts
import { describe, expect, it } from "vitest";
import { ACTIVITY_CHILD_TABLES, activityScopeSql, EMPTIED_TABLES, IDENTIFIER_COLUMNS, KEEP_ACTIVITY, KEEP_RELEASE, PEOPLE_QUERIES, quoteCol, quoteName, releaseScopeSql, REQUIRED_TABLES, STRUCTURED } from "../../scripts/lib/scrub/legacy-schema";

const TEXT_COLUMNS: Record<string, string[]> = {
  "calendar.Activity": ["PotentialDates", "Title", "Details", "Schedule", "Significance", "Strategy", "Comments", "HqComments", "LeadOrganization", "Venue", "Translations", "OtherCity"],
  "calendar.ActivityFilter": ["QueryString", "Name"],
  "calendar.CommunicationContact": ["Name", "MinistryShortName"],
  "calendar.EventPlanner": ["Name", "PhoneNumber", "JobTitle"],
  "calendar.GovernmentRepresentative": ["Name", "Description"],
  "calendar.Log": ["TableName", "FieldName", "OldValue", "NewValue", "Operation"],
  "calendar.SystemUser": ["Username", "Description", "FullName", "DisplayName", "JobTitle", "PhoneNumber", "MobileNumber", "EmailAddress", "HiddenColumns"],
  "calendar.Videographer": ["Name", "JobTitle"],
  "dbo.ApplicationSetting": ["SettingName", "SettingValue"],
  "dbo.MediaDistributionList": ["Key", "DisplayName"],
  "dbo.Ministry": ["Key", "DisplayName", "Abbreviation", "MinisterEmail", "MinisterPhotoUrl", "MinisterPageHtml", "MiscHtml", "MiscRightHtml", "TwitterUsername", "FlickrUrl", "YoutubeUrl", "AudioUrl", "FacebookEmbedHtml", "YoutubeEmbedHtml", "AudioEmbedHtml", "MinisterAddress", "MinisterName", "MinisterSummary", "MinistryUrl", "WeekendContactNumber", "DisplayAdditionalName"],
  "dbo.NewsRelease": ["Key", "Reference", "AtomId", "Keywords", "AssetUrl", "RedirectUrl"],
  "dbo.NewsReleaseDocumentContact": ["Information"],
  "dbo.NewsReleaseDocumentLanguage": ["PageTitle", "Organizations", "Headline", "Subheadline", "Byline", "BodyHtml"],
  "dbo.NewsReleaseLanguage": ["Location", "Summary", "SocialMediaHeadline", "SocialMediaSummary"],
  "dbo.NewsReleaseLog": ["Description"],
  "dbo.NewsReleaseType": ["PageTitle"],
  "dbo.Sector": ["Key", "DisplayName", "MiscHtml", "MiscRightHtml", "TwitterUsername", "FlickrUrl", "YoutubeUrl", "AudioUrl", "FacebookEmbedHtml", "YoutubeEmbedHtml", "AudioEmbedHtml"],
  "dbo.Slide": ["Headline", "Summary", "ActionUrl", "FacebookPostUrl"],
  "dbo.Tag": ["Key", "DisplayName"],
  "dbo.Theme": ["Key", "DisplayName"],
  "dbo.User": ["DisplayName", "EmailAddress"],
};

describe("legacy table rules", () => {
  it("names only identifier columns that exist", () => {
    for (const [table, cols] of Object.entries(IDENTIFIER_COLUMNS)) for (const c of cols) expect(TEXT_COLUMNS[table], `${table}.${c}`).toContain(c);
  });

  it("rewrites only structured columns that exist", () => {
    for (const s of STRUCTURED) for (const c of Object.keys(s.columns)) expect(TEXT_COLUMNS[s.table], `${s.table}.${c}`).toContain(c);
  });

  it("reads every people source, with user rows always becoming people", () => {
    expect(PEOPLE_QUERIES.map((q) => q.source)).toEqual(["calendar.SystemUser", "dbo.User", "calendar.CommunicationContact", "calendar.GovernmentRepresentative", "calendar.EventPlanner", "calendar.Videographer", "dbo.Ministry", "media.Contact"]);
    expect(PEOPLE_QUERIES.filter((q) => q.alwaysPerson).map((q) => q.source)).toEqual(["calendar.SystemUser", "dbo.User"]);
    for (const q of PEOPLE_QUERIES) for (const col of ["AS Id", "AS Name1", "AS Name2", "AS Email", "AS Phone1", "AS Phone2", "AS LinkId"]) expect(q.sql, q.source).toContain(col);
  });

  it("keeps only published, active, past releases and removes their dependants first", () => {
    const sql = releaseScopeSql();
    expect(sql).toContain(KEEP_RELEASE);
    expect(sql.indexOf("dbo.NewsReleaseDocumentContact")).toBeLessThan(sql.indexOf("DELETE d FROM dbo.NewsReleaseDocument"));
    expect(sql.indexOf("UPDATE dbo.Ministry SET TopReleaseId")).toBeLessThan(sql.indexOf("DELETE r FROM dbo.NewsRelease"));
    expect(sql).toContain("HomeTopReleaseId");
    expect(sql).toContain("c.PublishDateTime > @refUtc");
  });

  it("keeps only ended, non-confidential activities and clears what pointed at the rest", () => {
    const sql = activityScopeSql();
    expect(KEEP_ACTIVITY).toBe("a.EndDateTime < @refWall AND a.IsConfidential = 0");
    for (const t of ACTIVITY_CHILD_TABLES) expect(sql).toContain(`DELETE x FROM ${t} x`);
    expect(sql).toContain("SET ActivityId = NULL");
    expect(sql.lastIndexOf("DELETE a FROM calendar.Activity")).toBeGreaterThan(sql.indexOf("calendar.Log"));
  });

  it("requires every table it touches", () => {
    for (const t of [...ACTIVITY_CHILD_TABLES, ...EMPTIED_TABLES, ...STRUCTURED.map((s) => s.table)]) expect(REQUIRED_TABLES).toContain(t);
  });

  it("quotes names and refuses anything else", () => {
    expect(quoteName("dbo.User")).toBe("[dbo].[User]");
    expect(quoteCol("Key")).toBe("[Key]");
    expect(() => quoteName("dbo.User; DROP TABLE x")).toThrow();
    expect(() => quoteCol("a]b")).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run tests/scrub/legacy-schema.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// scripts/lib/scrub/legacy-schema.ts
export const ACTIVITY_CHILD_TABLES = [
  "calendar.ActivityCategories", "calendar.ActivityCommunicationMaterials", "calendar.ActivityInitiatives", "calendar.ActivityKeywords",
  "calendar.ActivityNROrigins", "calendar.ActivitySectors", "calendar.ActivitySharedWith", "calendar.ActivityTags", "calendar.ActivityThemes",
  "calendar.FavoriteActivity", "calendar.Log",
] as const;

/** Read by no importer, or out of scope, and holding people or unpublished content. */
export const EMPTIED_TABLES = ["calendar.NewsFeed", "calendar.ActivityFiles", "dbo.NewsReleaseHistory", "dbo.MediaRequestResolution"] as const;
export const EMPTIED_SCHEMAS = ["media", "dashboard"] as const;

export const REQUIRED_TABLES = [
  "calendar.Activity", ...ACTIVITY_CHILD_TABLES, "calendar.NewsFeed", "calendar.ActivityFiles", "calendar.ActivityFilter",
  "calendar.SystemUser", "calendar.CommunicationContact", "calendar.GovernmentRepresentative", "calendar.EventPlanner", "calendar.Videographer",
  "dbo.NewsRelease", "dbo.NewsReleaseLanguage", "dbo.NewsReleaseDocument", "dbo.NewsReleaseDocumentLanguage", "dbo.NewsReleaseDocumentContact",
  "dbo.NewsReleaseLog", "dbo.NewsReleaseMediaDistribution", "dbo.NewsReleaseMinistry", "dbo.NewsReleaseSector", "dbo.NewsReleaseTag",
  "dbo.NewsReleaseTheme", "dbo.NewsReleaseHistory", "dbo.NewsReleaseImage", "dbo.Blob", "dbo.Ministry", "dbo.Sector", "dbo.Theme",
  "dbo.ApplicationSetting", "dbo.Carousel", "dbo.CarouselSlide", "dbo.Slide", "dbo.User", "dbo.MediaRequestResolution", "media.Contact",
] as const;

/** Keys and references other rows and URLs depend on; never rewritten (the gates still read them). */
export const IDENTIFIER_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  "dbo.NewsRelease": ["Key", "Reference", "AtomId"],
  "dbo.Ministry": ["Key"],
  "dbo.Sector": ["Key"],
  "dbo.Tag": ["Key"],
  "dbo.Theme": ["Key"],
  "dbo.MediaDistributionList": ["Key"],
};

export interface PeopleQuery { source: string; sql: string; linkSource?: string; alwaysPerson?: boolean }
const NULLS = (cols: string[]) => cols.map((c) => `CAST(NULL AS nvarchar(50)) AS ${c}`).join(", ");
export const PEOPLE_QUERIES: readonly PeopleQuery[] = [
  { source: "calendar.SystemUser", alwaysPerson: true, sql: `SELECT CAST(Id AS nvarchar(50)) AS Id, FullName AS Name1, DisplayName AS Name2, EmailAddress AS Email, PhoneNumber AS Phone1, MobileNumber AS Phone2, ${NULLS(["LinkId"])} FROM calendar.SystemUser` },
  { source: "dbo.User", alwaysPerson: true, sql: `SELECT CAST(Id AS nvarchar(50)) AS Id, DisplayName AS Name1, EmailAddress AS Email, ${NULLS(["Name2", "Phone1", "Phone2", "LinkId"])} FROM dbo.[User]` },
  { source: "calendar.CommunicationContact", linkSource: "calendar.SystemUser", sql: `SELECT CAST(Id AS nvarchar(50)) AS Id, Name AS Name1, CAST(SystemUserId AS nvarchar(50)) AS LinkId, ${NULLS(["Name2", "Email", "Phone1", "Phone2"])} FROM calendar.CommunicationContact` },
  { source: "calendar.GovernmentRepresentative", sql: `SELECT CAST(Id AS nvarchar(50)) AS Id, Name AS Name1, ${NULLS(["Name2", "Email", "Phone1", "Phone2", "LinkId"])} FROM calendar.GovernmentRepresentative` },
  { source: "calendar.EventPlanner", sql: `SELECT CAST(Id AS nvarchar(50)) AS Id, Name AS Name1, PhoneNumber AS Phone1, ${NULLS(["Name2", "Email", "Phone2", "LinkId"])} FROM calendar.EventPlanner` },
  { source: "calendar.Videographer", sql: `SELECT CAST(Id AS nvarchar(50)) AS Id, Name AS Name1, ${NULLS(["Name2", "Email", "Phone1", "Phone2", "LinkId"])} FROM calendar.Videographer` },
  { source: "dbo.Ministry", sql: `SELECT CAST(Id AS nvarchar(50)) AS Id, MinisterName AS Name1, MinisterEmail AS Email, ${NULLS(["Name2", "Phone1", "Phone2", "LinkId"])} FROM dbo.Ministry` },
  { source: "media.Contact", sql: `SELECT CAST(Id AS nvarchar(50)) AS Id, NULLIF(LTRIM(RTRIM(CONCAT(FirstName, N' ', LastName))), N'') AS Name1, ${NULLS(["Name2", "Email", "Phone1", "Phone2", "LinkId"])} FROM media.Contact` },
];

export interface StructuredSpec { source: string; table: string; columns: Readonly<Record<string, "full" | "email" | "phone" | "username">> }
/** Columns that hold a person's own name, email, phone or user name: overwritten with their fictional identity. */
export const STRUCTURED: readonly StructuredSpec[] = [
  { source: "calendar.SystemUser", table: "calendar.SystemUser", columns: { FullName: "full", DisplayName: "full", EmailAddress: "email", PhoneNumber: "phone", MobileNumber: "phone", Username: "username" } },
  { source: "dbo.User", table: "dbo.User", columns: { DisplayName: "full", EmailAddress: "email" } },
  { source: "calendar.CommunicationContact", table: "calendar.CommunicationContact", columns: { Name: "full" } },
  { source: "calendar.GovernmentRepresentative", table: "calendar.GovernmentRepresentative", columns: { Name: "full" } },
  { source: "calendar.EventPlanner", table: "calendar.EventPlanner", columns: { Name: "full", PhoneNumber: "phone" } },
  { source: "calendar.Videographer", table: "calendar.Videographer", columns: { Name: "full" } },
  { source: "dbo.Ministry", table: "dbo.Ministry", columns: { MinisterName: "full", MinisterEmail: "email" } },
];

export const KEEP_RELEASE = "r.IsCommitted = 1 AND r.IsPublished = 1 AND r.IsActive = 1 AND r.PublishDateTime IS NOT NULL AND r.PublishDateTime <= @refUtc";
export const KEEP_ACTIVITY = "a.EndDateTime < @refWall AND a.IsConfidential = 0";

export function releaseScopeSql(): string {
  const gone = (col: string) => `NOT EXISTS (SELECT 1 FROM @keep k WHERE k.Id = ${col})`;
  return [
    "SET NOCOUNT ON;",
    "DECLARE @keep TABLE (Id uniqueidentifier PRIMARY KEY);",
    `INSERT @keep (Id) SELECT r.Id FROM dbo.NewsRelease r WHERE ${KEEP_RELEASE};`,
    ...["dbo.Ministry", "dbo.Sector", "dbo.Theme"].flatMap((t) => ["TopReleaseId", "FeatureReleaseId"].map((c) => `UPDATE ${t} SET ${c} = NULL WHERE ${c} IS NOT NULL AND ${gone(c)};`)),
    `UPDATE dbo.ApplicationSetting SET SettingValue = N'' WHERE SettingName IN ('HomeTopReleaseId', 'HomeFeatureReleaseId') AND (TRY_CONVERT(uniqueidentifier, SettingValue) IS NULL OR ${gone("TRY_CONVERT(uniqueidentifier, SettingValue)")});`,
    `DELETE c FROM dbo.NewsReleaseDocumentContact c JOIN dbo.NewsReleaseDocument d ON d.Id = c.DocumentId WHERE ${gone("d.ReleaseId")};`,
    `DELETE l FROM dbo.NewsReleaseDocumentLanguage l JOIN dbo.NewsReleaseDocument d ON d.Id = l.DocumentId WHERE ${gone("d.ReleaseId")};`,
    `DELETE d FROM dbo.NewsReleaseDocument d WHERE ${gone("d.ReleaseId")};`,
    ...["dbo.NewsReleaseLanguage", "dbo.NewsReleaseLog", "dbo.NewsReleaseMediaDistribution", "dbo.NewsReleaseMinistry", "dbo.NewsReleaseSector", "dbo.NewsReleaseTag", "dbo.NewsReleaseTheme", "dbo.NewsReleaseHistory"].map((t) => `DELETE x FROM ${t} x WHERE ${gone("x.ReleaseId")};`),
    `DELETE r FROM dbo.NewsRelease r WHERE ${gone("r.Id")};`,
    "DELETE cs FROM dbo.CarouselSlide cs JOIN dbo.Carousel c ON c.Id = cs.CarouselId WHERE c.PublishDateTime IS NULL OR c.PublishDateTime > @refUtc;",
    "DELETE c FROM dbo.Carousel c WHERE c.PublishDateTime IS NULL OR c.PublishDateTime > @refUtc;",
    "DELETE s FROM dbo.Slide s WHERE NOT EXISTS (SELECT 1 FROM dbo.CarouselSlide cs WHERE cs.SlideId = s.Id);",
  ].join("\n");
}

export function activityScopeSql(): string {
  const gone = (col: string) => `NOT EXISTS (SELECT 1 FROM @act k WHERE k.Id = ${col})`;
  return [
    "SET NOCOUNT ON;",
    "DECLARE @act TABLE (Id int PRIMARY KEY);",
    `INSERT @act (Id) SELECT a.Id FROM calendar.Activity a WHERE ${KEEP_ACTIVITY};`,
    "DELETE FROM calendar.NewsFeed;",
    "DELETE FROM calendar.ActivityFiles;",
    ...ACTIVITY_CHILD_TABLES.map((t) => `DELETE x FROM ${t} x WHERE ${gone("x.ActivityId")};`),
    `UPDATE r SET ActivityId = NULL FROM dbo.NewsRelease r WHERE r.ActivityId IS NOT NULL AND ${gone("r.ActivityId")};`,
    `DELETE a FROM calendar.Activity a WHERE ${gone("a.Id")};`,
  ].join("\n");
}

export const BLOB_CLEANUP_SQL = "DELETE b FROM dbo.Blob b WHERE NOT EXISTS (SELECT 1 FROM dbo.NewsReleaseImage i WHERE i.BlobId = b.Id) AND NOT EXISTS (SELECT 1 FROM dbo.NewsReleaseHistory h WHERE h.BlobId = b.Id);";

const PART = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function quoteName(table: string): string {
  const parts = table.split(".");
  if (parts.length !== 2 || !parts.every((p) => PART.test(p))) throw new Error("not a schema.table name");
  return parts.map((p) => `[${p}]`).join(".");
}
export function quoteCol(col: string): string {
  if (!PART.test(col)) throw new Error("not a column name");
  return `[${col}]`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run tests/scrub/legacy-schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/scrub/legacy-schema.ts tests/scrub/legacy-schema.test.ts
git commit -m "scrub: legacy table rules and scope SQL"
```

---

### Task 7: SQL Server copy, scope, emptied tables and date shift

**Files:**
- Create: `scripts/lib/scrub/mssql.ts`, `tests/scrub/mssql-fixture.ts`
- Test: `tests/scrub/mssql.test.ts`

**Interfaces:**
- Consumes: Task 6's rules; `weekOffset`, `shiftDateText` (Task 5); `ScrubArgumentError`, `ScrubStepError` (Task 1).
- Produces:
  - `interface MssqlConfig { server: string; port: number; user: string; password: string; trustServerCertificate: boolean }`
  - `mssqlConfigFromEnv(env?): MssqlConfig`
  - `openPool(cfg, database): Promise<sql.ConnectionPool>`
  - `SCRUB_DB: RegExp`
  - `assertScrubCopy(db: sql.ConnectionPool | sql.Transaction): Promise<void>`
  - `restorePlan(dbName, files, dataDir, logDir): { sql: string; params: Record<string, string> }`
  - `restoreScrubCopy(master, backupPath, dbName): Promise<void>`
  - `assertRequiredTables(pool): Promise<void>`
  - `applyScope(pool, refUtc: Date, refWall: Date): Promise<void>`
  - `emptyTables(pool): Promise<string[]>`
  - `tableCounts(pool): Promise<Record<string, number>>`
  - `interface DateShiftResult { weeks: number; latestEnd: Date | null; columns: number; logText: { shifted: number; unparsed: number } }`
  - `shiftCalendarDates(pool, refWall: Date, leadDays: number): Promise<DateShiftResult>`
- The fixture produces:
  - `mssqlTestConfig(env?): MssqlConfig | null`
  - `SKIP_MESSAGE`
  - `FIXTURE_KEY`, `REF_UTC`, `REF_WALL`, `ID`
  - `createFixture(cfg): Promise<{ name: string; pool: sql.ConnectionPool; drop(): Promise<void> }>`

- [ ] **Step 1: Write the fixture (fictional data only)**

```ts
// tests/scrub/mssql-fixture.ts
import { randomBytes } from "node:crypto";
import type sql from "mssql";
import { openPool, type MssqlConfig } from "../../scripts/lib/scrub/mssql";

export function mssqlTestConfig(env: NodeJS.ProcessEnv = process.env): MssqlConfig | null {
  const password = env.SCRUB_TEST_MSSQL_PASSWORD;
  if (!password) return null;
  return { server: env.SCRUB_TEST_MSSQL_SERVER ?? "127.0.0.1", port: Number(env.SCRUB_TEST_MSSQL_PORT ?? 1433), user: env.SCRUB_TEST_MSSQL_USER ?? "sa", password, trustServerCertificate: true };
}
export const SKIP_MESSAGE = "SQL Server scrub tests skipped: set SCRUB_TEST_MSSQL_PASSWORD (and SCRUB_TEST_MSSQL_SERVER/USER/PORT unless 127.0.0.1/sa/1433) to run them";

export const FIXTURE_KEY = "e".repeat(64);
/** 2026-10-22 12:00 in BC, as an instant and as legacy's wall-clock DATETIME. */
export const REF_UTC = new Date("2026-10-22T19:00:00Z");
export const REF_WALL = new Date(Date.UTC(2026, 9, 22, 12, 0, 0));

const g = (prefix: string, n: number) => `${prefix}000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const ID = {
  R1: g("10", 1), R2: g("10", 2), R3: g("10", 3), R4: g("10", 4),
  D1: g("20", 1), D2: g("20", 2), D3: g("20", 3), D4: g("20", 4),
  C1: g("30", 1), C2: g("30", 2), S1: g("40", 1), S2: g("40", 2),
  B1: g("50", 1), B2: g("50", 2), IMG1: g("60", 1), M1: g("70", 1), SEC1: g("71", 1), TH1: g("72", 1),
  U1: g("80", 1), MC1: g("90", 1), MRR1: g("a0", 1), L1: g("b0", 1),
};

const ACTIVITY_JOINS = ["ActivityCategories", "ActivityCommunicationMaterials", "ActivityInitiatives", "ActivityNROrigins", "ActivitySectors", "ActivitySharedWith"];
const SCHEMA_SQL = [
  "CREATE SCHEMA calendar", "CREATE SCHEMA media", "CREATE SCHEMA dashboard",
  "CREATE TABLE calendar.SystemUser (Id int PRIMARY KEY, Username nvarchar(20) NULL, FullName nvarchar(50) NULL, DisplayName nvarchar(50) NULL, EmailAddress nvarchar(50) NULL, PhoneNumber nvarchar(20) NULL, MobileNumber nvarchar(15) NULL, JobTitle nvarchar(100) NULL, Description nvarchar(2000) NULL, CreatedDateTime datetime NULL, LastUpdatedDateTime datetime NULL)",
  "CREATE TABLE calendar.CommunicationContact (Id int PRIMARY KEY, SystemUserId int NULL, Name nvarchar(100) NULL)",
  "CREATE TABLE calendar.GovernmentRepresentative (Id int PRIMARY KEY, Name nvarchar(50) NULL, Description nvarchar(84) NULL)",
  "CREATE TABLE calendar.EventPlanner (Id int PRIMARY KEY, Name nvarchar(100) NULL, PhoneNumber nvarchar(50) NULL, JobTitle nvarchar(150) NULL)",
  "CREATE TABLE calendar.Videographer (Id int PRIMARY KEY, Name nvarchar(100) NULL, JobTitle nvarchar(150) NULL)",
  "CREATE TABLE calendar.Activity (Id int PRIMARY KEY, StartDateTime datetime NULL, EndDateTime datetime NULL, NRDateTime datetime NULL, Title nvarchar(500) NULL, Comments nvarchar(4000) NULL, IsActive bit NOT NULL, IsConfidential bit NULL, CreatedDateTime datetime NULL, LastUpdatedDateTime datetime NULL)",
  ...ACTIVITY_JOINS.map((t) => `CREATE TABLE calendar.${t} (Id int IDENTITY PRIMARY KEY, ActivityId int NOT NULL, CreatedDateTime datetime NULL, LastUpdatedDateTime datetime NOT NULL)`),
  "CREATE TABLE calendar.ActivityKeywords (ActivityId int NOT NULL, KeywordId int NOT NULL, LastUpdatedDateTime datetime NOT NULL, PRIMARY KEY (ActivityId, KeywordId))",
  "CREATE TABLE calendar.ActivityTags (ActivityId int NOT NULL, TagId uniqueidentifier NOT NULL, CreatedDateTime datetime NOT NULL, LastUpdatedDateTime datetime NOT NULL, PRIMARY KEY (ActivityId, TagId))",
  "CREATE TABLE calendar.ActivityThemes (ActivityId int NOT NULL, ThemeId uniqueidentifier NOT NULL, CreatedDateTime datetime NOT NULL, LastUpdatedDateTime datetime NOT NULL, PRIMARY KEY (ActivityId, ThemeId))",
  "CREATE TABLE calendar.FavoriteActivity (ActivityId int NOT NULL, SystemUserId int NOT NULL, PRIMARY KEY (ActivityId, SystemUserId))",
  "CREATE TABLE calendar.Log (Id int PRIMARY KEY, ActivityId int NOT NULL, TableName nvarchar(50) NULL, FieldName nvarchar(1000) NULL, OldValue nvarchar(1000) NULL, NewValue nvarchar(1000) NULL, Operation nvarchar(50) NULL, CreatedDateTime datetime NULL, LastUpdatedDateTime datetime NOT NULL)",
  "CREATE TABLE calendar.NewsFeed (Id int PRIMARY KEY, ActivityId int NULL, Text nvarchar(1000) NULL, CreatedDateTime datetime NULL)",
  "CREATE TABLE calendar.ActivityFiles (Id int PRIMARY KEY, ActivityId int NOT NULL, FileName varchar(max) NULL, Data varbinary(max) NOT NULL, LastUpdatedDateTime datetime NOT NULL)",
  "CREATE TABLE calendar.ActivityFilter (Id int PRIMARY KEY, Name nvarchar(200) NULL, QueryString nvarchar(300) NULL, CreatedDateTime datetime NULL, LastUpdatedDateTime datetime NULL)",
  "CREATE TABLE dbo.[User] (Id uniqueidentifier PRIMARY KEY, DisplayName nvarchar(256) NOT NULL, EmailAddress nvarchar(256) NOT NULL, IsActive bit NOT NULL)",
  "CREATE TABLE dbo.NewsRelease (Id uniqueidentifier PRIMARY KEY, [Key] varchar(255) NOT NULL, Reference varchar(50) NOT NULL, AtomId varchar(255) NOT NULL, IsCommitted bit NOT NULL, IsPublished bit NOT NULL, IsActive bit NOT NULL, PublishDateTime datetimeoffset NULL, ActivityId int NULL, Keywords nvarchar(max) NOT NULL)",
  "CREATE TABLE dbo.NewsReleaseLanguage (ReleaseId uniqueidentifier NOT NULL, LanguageId int NOT NULL, Summary nvarchar(max) NULL, PRIMARY KEY (ReleaseId, LanguageId))",
  "CREATE TABLE dbo.NewsReleaseDocument (Id uniqueidentifier PRIMARY KEY, ReleaseId uniqueidentifier NOT NULL)",
  "CREATE TABLE dbo.NewsReleaseDocumentLanguage (DocumentId uniqueidentifier NOT NULL, LanguageId int NOT NULL, Headline nvarchar(255) NULL, BodyHtml nvarchar(max) NULL, PRIMARY KEY (DocumentId, LanguageId))",
  "CREATE TABLE dbo.NewsReleaseDocumentContact (DocumentId uniqueidentifier NOT NULL, LanguageId int NOT NULL, SortIndex int NOT NULL, Information nvarchar(250) NULL, PRIMARY KEY (DocumentId, LanguageId, SortIndex))",
  "CREATE TABLE dbo.NewsReleaseLog (Id int PRIMARY KEY, ReleaseId uniqueidentifier NOT NULL, Description nvarchar(200) NULL, UserId uniqueidentifier NULL)",
  ...["MediaDistribution:MediaDistributionListId", "Ministry:MinistryId", "Sector:SectorId", "Tag:TagId", "Theme:ThemeId"].map((x) => { const [t, c] = x.split(":"); return `CREATE TABLE dbo.NewsRelease${t} (ReleaseId uniqueidentifier NOT NULL, ${c} uniqueidentifier NOT NULL, PRIMARY KEY (ReleaseId, ${c}))`; }),
  "CREATE TABLE dbo.Blob (Id uniqueidentifier PRIMARY KEY, Data varbinary(max) NOT NULL)",
  "CREATE TABLE dbo.NewsReleaseHistory (ReleaseId uniqueidentifier NOT NULL, PublishDateTime datetimeoffset NOT NULL, MimeType varchar(100) NOT NULL, BlobId uniqueidentifier NOT NULL, PRIMARY KEY (ReleaseId, PublishDateTime, MimeType))",
  "CREATE TABLE dbo.NewsReleaseImage (Id uniqueidentifier PRIMARY KEY, BlobId uniqueidentifier NULL, Name varchar(50) NULL)",
  "CREATE TABLE dbo.Ministry (Id uniqueidentifier PRIMARY KEY, [Key] nvarchar(100) NOT NULL, TopReleaseId uniqueidentifier NULL, FeatureReleaseId uniqueidentifier NULL, MinisterName nvarchar(255) NULL, MinisterEmail nvarchar(255) NULL, MinisterSummary nvarchar(max) NULL)",
  "CREATE TABLE dbo.Sector (Id uniqueidentifier PRIMARY KEY, [Key] varchar(100) NOT NULL, TopReleaseId uniqueidentifier NULL, FeatureReleaseId uniqueidentifier NULL)",
  "CREATE TABLE dbo.Theme (Id uniqueidentifier PRIMARY KEY, [Key] varchar(255) NOT NULL, TopReleaseId uniqueidentifier NULL, FeatureReleaseId uniqueidentifier NULL)",
  "CREATE TABLE dbo.ApplicationSetting (SettingName varchar(100) PRIMARY KEY, SettingValue nvarchar(max) NOT NULL)",
  "CREATE TABLE dbo.Carousel (Id uniqueidentifier PRIMARY KEY, PublishDateTime datetimeoffset NULL)",
  "CREATE TABLE dbo.Slide (Id uniqueidentifier PRIMARY KEY, Headline nvarchar(255) NULL, Summary nvarchar(max) NULL)",
  "CREATE TABLE dbo.CarouselSlide (CarouselId uniqueidentifier NOT NULL, SlideId uniqueidentifier NOT NULL, SortIndex int NOT NULL, PRIMARY KEY (CarouselId, SlideId))",
  "CREATE TABLE dbo.MediaRequestResolution (Id uniqueidentifier PRIMARY KEY, DisplayAs nvarchar(50) NULL)",
  "CREATE TABLE media.Contact (Id uniqueidentifier PRIMARY KEY, FirstName nvarchar(150) NULL, LastName nvarchar(150) NULL)",
  "CREATE TABLE dashboard.UserMinistryPreference (MinistryId uniqueidentifier NOT NULL, Email nvarchar(50) NOT NULL, PRIMARY KEY (MinistryId, Email))",
];

const DATA_SQL = [
  `INSERT calendar.SystemUser (Id, Username, FullName, DisplayName, EmailAddress, PhoneNumber, MobileNumber, Description, CreatedDateTime, LastUpdatedDateTime) VALUES
    (1, N'qashbury', N'Quill Ashbury', N'Ashbury, Quill', N'quill.ashbury@gov.example', N'(604) 555-0142', N'604.555.0143', N'Back-up: Marisol Tennant-Vey', '20250101 09:00', '20261001 09:00'),
    (2, N'mtv', N'Marisol Tennant-Vey', N'Marisol Tennant-Vey', N'MARISOL.TV@gov.example', NULL, NULL, NULL, '20250101 09:00', '20250101 09:00'),
    (3, NULL, NULL, N'Admin', NULL, NULL, NULL, NULL, NULL, NULL),
    (4, N'treyes', N'Tobin Reyes-Hart', N'Tobin Reyes-Hart', N'tobin at gov', NULL, NULL, NULL, NULL, NULL)`,
  "INSERT calendar.CommunicationContact (Id, SystemUserId, Name) VALUES (1, 1, N'Quill Ashbury')",
  `INSERT calendar.GovernmentRepresentative (Id, Name, Description) VALUES (1, N'Hon. Dorian Feld', NULL), (2, N'Premier', NULL), (3, N'Hon. Dorian Feld', N'${"x".repeat(70)} a@gov.example')`,
  "INSERT calendar.EventPlanner (Id, Name, PhoneNumber) VALUES (1, N'Ines Okafor-Lind', N'250.555.0161')",
  "INSERT calendar.Videographer (Id, Name) VALUES (1, N'Tobin Reyes-Hart')",
  `INSERT calendar.Activity (Id, StartDateTime, EndDateTime, NRDateTime, Title, Comments, IsActive, IsConfidential, CreatedDateTime, LastUpdatedDateTime) VALUES
    (1, '20261012 09:00', '20261012 10:00', '20261012 08:00', N'Visit with Quill Ashbury', N'Ask Ines Okafor-Lind (250.555.0161) or press@news.example. Wynona Brightwater''s interview; Ashbury, Quill to attend.', 1, 0, '20261001 10:00', '20261005 10:00'),
    (2, '20261027 09:00', '20261027 10:00', NULL, N'Future announcement', N'Not yet public', 1, 0, '20261001 10:00', '20261001 10:00'),
    (3, '20261001 09:00', '20261001 10:00', NULL, N'Confidential briefing', N'Confidential', 1, 1, '20260901 10:00', '20260901 10:00'),
    (4, '20261001 09:00', NULL, NULL, N'No end date', NULL, 1, 0, '20260901 10:00', '20260901 10:00'),
    (5, '20260901 09:00', '20260901 10:00', NULL, N'Deleted but ended', NULL, 0, 0, '20260801 10:00', '20260801 10:00')`,
  ...ACTIVITY_JOINS.map((t) => `INSERT calendar.${t} (ActivityId, CreatedDateTime, LastUpdatedDateTime) VALUES (1, '20261001 10:00', '20261001 10:00'), (2, '20261001 10:00', '20261001 10:00'), (3, '20261001 10:00', '20261001 10:00'), (5, '20261001 10:00', '20261001 10:00')`),
  "INSERT calendar.ActivityKeywords (ActivityId, KeywordId, LastUpdatedDateTime) VALUES (1, 1, '20261001 10:00'), (2, 1, '20261001 10:00')",
  `INSERT calendar.ActivityTags (ActivityId, TagId, CreatedDateTime, LastUpdatedDateTime) VALUES (1, '${ID.TH1}', '20261001 10:00', '20261001 10:00'), (3, '${ID.TH1}', '20261001 10:00', '20261001 10:00')`,
  `INSERT calendar.ActivityThemes (ActivityId, ThemeId, CreatedDateTime, LastUpdatedDateTime) VALUES (1, '${ID.TH1}', '20261001 10:00', '20261001 10:00'), (4, '${ID.TH1}', '20261001 10:00', '20261001 10:00')`,
  "INSERT calendar.FavoriteActivity (ActivityId, SystemUserId) VALUES (1, 1), (2, 1), (3, 2)",
  `INSERT calendar.Log (Id, ActivityId, TableName, FieldName, OldValue, NewValue, Operation, CreatedDateTime, LastUpdatedDateTime) VALUES
    (1, 1, N'Activity', N'StartDateTime', N'10/5/2026 9:00:00 AM', N'10/12/2026 9:00:00 AM', N'Update', '20261005 10:00', '20261005 10:00'),
    (2, 1, N'Activity', N'Title', N'Plan with Quill Ashbury', N'Visit with Quill Ashbury', N'Update', '20261005 10:00', '20261005 10:00'),
    (3, 2, N'Activity', N'Title', N'Old', N'Future announcement', N'Update', '20261001 10:00', '20261001 10:00')`,
  "INSERT calendar.NewsFeed (Id, ActivityId, Text, CreatedDateTime) VALUES (1, 1, N'Quill Ashbury changed the title', '20261005 10:00')",
  "INSERT calendar.ActivityFiles (Id, ActivityId, FileName, Data, LastUpdatedDateTime) VALUES (1, 1, 'notes.pdf', 0x255044462D, '20261005 10:00')",
  "INSERT calendar.ActivityFilter (Id, Name, QueryString, CreatedDateTime, LastUpdatedDateTime) VALUES (1, N'Quill Ashbury events', N'q=Ashbury', '20261001 10:00', '20261001 10:00')",
  `INSERT dbo.[User] (Id, DisplayName, EmailAddress, IsActive) VALUES ('${ID.U1}', N'Quill Ashbury', N'Quill.Ashbury@gov.example', 1)`,
  `INSERT dbo.NewsRelease (Id, [Key], Reference, AtomId, IsCommitted, IsPublished, IsActive, PublishDateTime, ActivityId, Keywords) VALUES
    ('${ID.R1}', '2026HLTH0001-000001', 'NEWS-00001', 'atom-1', 1, 1, 1, '2026-10-01T10:00:00-07:00', 1, N'health'),
    ('${ID.R2}', '2026HLTH0002-000002', 'NEWS-00002', 'atom-2', 0, 0, 1, NULL, NULL, N'draft'),
    ('${ID.R3}', '2026HLTH0003-000003', 'NEWS-00003', 'atom-3', 1, 1, 1, '2026-11-15T10:00:00-08:00', NULL, N'scheduled'),
    ('${ID.R4}', '2026HLTH0004-000004', 'NEWS-00004', 'atom-4', 1, 1, 1, '2026-10-02T10:00:00-07:00', 2, N'linked')`,
  `INSERT dbo.NewsReleaseLanguage (ReleaseId, LanguageId, Summary) VALUES ('${ID.R1}', 4105, N'Quill Ashbury announces'), ('${ID.R2}', 4105, N'Draft')`,
  `INSERT dbo.NewsReleaseDocument (Id, ReleaseId) VALUES ('${ID.D1}', '${ID.R1}'), ('${ID.D2}', '${ID.R2}'), ('${ID.D3}', '${ID.R3}'), ('${ID.D4}', '${ID.R4}')`,
  `INSERT dbo.NewsReleaseDocumentLanguage (DocumentId, LanguageId, Headline, BodyHtml) VALUES
    ('${ID.D1}', 4105, N'Clinic opens', N'<p>Minister <b>Dorian</b> Feld and Quill&nbsp;Ashbury''s team. Call 1-800-555-0142.</p>'),
    ('${ID.D2}', 4105, N'Draft', N'<p>Unpublished</p>'), ('${ID.D3}', 4105, N'Scheduled', N'<p>Embargoed</p>'), ('${ID.D4}', 4105, N'Linked', N'<p>Linked</p>')`,
  `INSERT dbo.NewsReleaseDocumentContact (DocumentId, LanguageId, SortIndex, Information) VALUES ('${ID.D1}', 4105, 0, N'Media Relations' + CHAR(10) + N'Quill Ashbury' + CHAR(10) + N'604-555-0142'), ('${ID.D2}', 4105, 0, N'Draft contact')`,
  `INSERT dbo.NewsReleaseLog (Id, ReleaseId, Description, UserId) VALUES (1, '${ID.R1}', N'Approved by Quill Ashbury', '${ID.U1}'), (2, '${ID.R2}', N'Created', NULL)`,
  `INSERT dbo.NewsReleaseMinistry (ReleaseId, MinistryId) VALUES ('${ID.R1}', '${ID.M1}'), ('${ID.R2}', '${ID.M1}')`,
  `INSERT dbo.Blob (Id, Data) VALUES ('${ID.B1}', 0x01), ('${ID.B2}', 0x02)`,
  `INSERT dbo.NewsReleaseHistory (ReleaseId, PublishDateTime, MimeType, BlobId) VALUES ('${ID.R1}', '2026-10-01T10:00:00-07:00', 'application/pdf', '${ID.B1}')`,
  `INSERT dbo.NewsReleaseImage (Id, BlobId, Name) VALUES ('${ID.IMG1}', '${ID.B2}', 'letterhead')`,
  `INSERT dbo.Ministry (Id, [Key], TopReleaseId, FeatureReleaseId, MinisterName, MinisterEmail, MinisterSummary) VALUES ('${ID.M1}', N'health', '${ID.R2}', '${ID.R1}', N'Hon. Dorian Feld', N'dorian.feld@gov.example', N'<p>Dorian Feld was elected in 2024.</p>')`,
  `INSERT dbo.Sector (Id, [Key], TopReleaseId, FeatureReleaseId) VALUES ('${ID.SEC1}', 'health', '${ID.R3}', NULL)`,
  `INSERT dbo.Theme (Id, [Key], TopReleaseId, FeatureReleaseId) VALUES ('${ID.TH1}', 'care', NULL, '${ID.R4}')`,
  `INSERT dbo.ApplicationSetting (SettingName, SettingValue) VALUES ('HomeTopReleaseId', N'${ID.R2}'), ('HomeFeatureReleaseId', N'${ID.R1}'), ('granville', N'<p>Call 1-800-555-0142</p>')`,
  `INSERT dbo.Carousel (Id, PublishDateTime) VALUES ('${ID.C1}', '2026-10-01T10:00:00-07:00'), ('${ID.C2}', '2026-12-01T10:00:00-08:00')`,
  `INSERT dbo.Slide (Id, Headline, Summary) VALUES ('${ID.S1}', N'Live now', N'Quill Ashbury explains'), ('${ID.S2}', N'Coming soon', N'Embargoed slide')`,
  `INSERT dbo.CarouselSlide (CarouselId, SlideId, SortIndex) VALUES ('${ID.C1}', '${ID.S1}', 0), ('${ID.C2}', '${ID.S2}', 0)`,
  `INSERT dbo.MediaRequestResolution (Id, DisplayAs) VALUES ('${ID.MRR1}', N'Resolved')`,
  `INSERT media.Contact (Id, FirstName, LastName) VALUES ('${ID.MC1}', N'Wynona', N'Brightwater')`,
  `INSERT dashboard.UserMinistryPreference (MinistryId, Email) VALUES ('${ID.M1}', N'someone@gov.example')`,
];

export async function createFixture(cfg: MssqlConfig): Promise<{ name: string; pool: sql.ConnectionPool; drop(): Promise<void> }> {
  const name = `ScrubFixture_${randomBytes(6).toString("hex")}_Scrubbed`;
  const master = await openPool(cfg, "master");
  try { await master.request().query(`CREATE DATABASE [${name}]`); } finally { await master.close(); }
  const pool = await openPool(cfg, name);
  for (const s of [...SCHEMA_SQL, ...DATA_SQL]) await pool.request().query(s);
  return {
    name,
    pool,
    async drop() {
      await pool.close();
      const m = await openPool(cfg, "master");
      try { await m.request().query(`ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${name}];`); } finally { await m.close(); }
    },
  };
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// tests/scrub/mssql.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyScope, assertRequiredTables, assertScrubCopy, emptyTables, openPool, restorePlan, shiftCalendarDates, tableCounts } from "../../scripts/lib/scrub/mssql";
import { createFixture, ID, mssqlTestConfig, REF_UTC, REF_WALL, SKIP_MESSAGE } from "./mssql-fixture";

describe("restorePlan", () => {
  it("moves each file next to the server's own and refuses other names", () => {
    const p = restorePlan("Gcpe.Hub_Scrubbed", [{ LogicalName: "Gcpe.Hub", Type: "D" }, { LogicalName: "Gcpe.Hub_log", Type: "L" }], "/var/opt/mssql/data/", "/var/opt/mssql/data");
    expect(p.sql).toBe("RESTORE DATABASE @db FROM DISK = @backup WITH MOVE @l0 TO @f0, MOVE @l1 TO @f1, REPLACE, RECOVERY, STATS = 10;");
    expect(p.params).toEqual({ db: "Gcpe.Hub_Scrubbed", l0: "Gcpe.Hub", f0: "/var/opt/mssql/data/Gcpe.Hub_Scrubbed_0.mdf", l1: "Gcpe.Hub_log", f1: "/var/opt/mssql/data/Gcpe.Hub_Scrubbed_1.ldf" });
    expect(() => restorePlan("Gcpe.Hub", [], "/d", "/l")).toThrow(/_Scrubbed/);
  });
});

const cfg = mssqlTestConfig();
if (!cfg) console.warn(SKIP_MESSAGE);

describe.skipIf(!cfg)("on a fictional SQL Server fixture", () => {
  let fx: Awaited<ReturnType<typeof import("./mssql-fixture").createFixture>>;
  beforeAll(async () => { fx = await createFixture(cfg!); }, 120_000);
  afterAll(async () => { await fx?.drop(); });
  const q = async <T>(text: string) => (await fx.pool.request().query<T>(text)).recordset;

  it("refuses to write anywhere but a _Scrubbed database", async () => {
    await assertScrubCopy(fx.pool);
    const master = await openPool(cfg!, "master");
    try { await expect(assertScrubCopy(master)).rejects.toThrow(/_Scrubbed/); } finally { await master.close(); }
  });

  it("finds every required table", async () => { await assertRequiredTables(fx.pool); });

  it("scopes releases, activities and carousels", async () => {
    await applyScope(fx.pool, REF_UTC, REF_WALL);
    expect((await q<{ Id: number }>("SELECT Id FROM calendar.Activity ORDER BY Id")).map((r) => r.Id)).toEqual([1, 5]);
    expect((await q<{ n: number }>("SELECT COUNT(*) AS n FROM calendar.ActivityCategories WHERE ActivityId NOT IN (1, 5)"))[0]!.n).toBe(0);
    expect((await q<{ n: number }>("SELECT COUNT(*) AS n FROM calendar.FavoriteActivity"))[0]!.n).toBe(1);
    expect((await q<{ Id: number }>("SELECT Id FROM calendar.Log ORDER BY Id")).map((r) => r.Id)).toEqual([1, 2]);
    const releases = await q<{ Id: string; ActivityId: number | null }>("SELECT CAST(Id AS nvarchar(50)) AS Id, ActivityId FROM dbo.NewsRelease ORDER BY Id");
    expect(releases).toEqual([{ Id: ID.R1.toUpperCase(), ActivityId: 1 }, { Id: ID.R4.toUpperCase(), ActivityId: null }]);
    expect((await q<{ n: number }>("SELECT COUNT(*) AS n FROM dbo.NewsReleaseDocumentContact"))[0]!.n).toBe(1);
    const m = (await q<{ Top: string | null; Feature: string | null }>("SELECT CAST(TopReleaseId AS nvarchar(50)) AS Top, CAST(FeatureReleaseId AS nvarchar(50)) AS Feature FROM dbo.Ministry"))[0]!;
    expect(m).toEqual({ Top: null, Feature: ID.R1.toUpperCase() });
    expect((await q<{ T: string | null }>("SELECT CAST(TopReleaseId AS nvarchar(50)) AS T FROM dbo.Sector"))[0]!.T).toBeNull();
    const settings = Object.fromEntries((await q<{ SettingName: string; SettingValue: string }>("SELECT SettingName, SettingValue FROM dbo.ApplicationSetting")).map((r) => [r.SettingName, r.SettingValue]));
    expect(settings.HomeTopReleaseId).toBe("");
    expect(settings.HomeFeatureReleaseId).toBe(ID.R1);
    expect((await q<{ n: number }>("SELECT COUNT(*) AS n FROM dbo.Carousel"))[0]!.n).toBe(1);
    expect((await q<{ n: number }>("SELECT COUNT(*) AS n FROM dbo.Slide"))[0]!.n).toBe(1);
    expect((await q<{ n: number }>("SELECT COUNT(*) AS n FROM calendar.NewsFeed"))[0]!.n).toBe(0);
    expect((await q<{ n: number }>("SELECT COUNT(*) AS n FROM calendar.ActivityFiles"))[0]!.n).toBe(0);
  });

  it("empties the tables no importer reads", async () => {
    const emptied = await emptyTables(fx.pool);
    expect(emptied).toEqual(expect.arrayContaining(["media.Contact", "dashboard.UserMinistryPreference", "dbo.NewsReleaseHistory", "dbo.MediaRequestResolution"]));
    const counts = await tableCounts(fx.pool);
    for (const t of emptied) expect(counts[t], t).toBe(0);
    expect(counts["dbo.Blob"]).toBe(1);
  });

  it("shifts every calendar date by whole weeks", async () => {
    const r = await shiftCalendarDates(fx.pool, REF_WALL, 14);
    expect(r.weeks).toBe(3);
    const a = (await q<{ StartDateTime: Date; EndDateTime: Date; CreatedDateTime: Date }>("SELECT StartDateTime, EndDateTime, CreatedDateTime FROM calendar.Activity WHERE Id = 1"))[0]!;
    expect(a.EndDateTime.toISOString()).toBe("2026-11-02T10:00:00.000Z");
    expect(a.StartDateTime.getUTCDay()).toBe(1);
    expect(a.CreatedDateTime.toISOString()).toBe("2026-10-22T10:00:00.000Z");
    expect((await q<{ OldValue: string }>("SELECT OldValue FROM calendar.Log WHERE Id = 1"))[0]!.OldValue).toBe("10/26/2026 9:00:00 AM");
    expect(r.logText).toEqual({ shifted: 1, unparsed: 0 });
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `SCRUB_TEST_MSSQL_PASSWORD="$(sed -n 's/^MSSQL_SA_PASSWORD=//p' ~/gcpe-parity-private/mssql.env)" npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run tests/scrub/mssql.test.ts`
Expected: FAIL, "Cannot find module '../../scripts/lib/scrub/mssql'".

- [ ] **Step 4: Implement**

```ts
// scripts/lib/scrub/mssql.ts
import sql from "mssql";
import { shiftDateText, weekOffset } from "./dates";
import { activityScopeSql, BLOB_CLEANUP_SQL, EMPTIED_SCHEMAS, EMPTIED_TABLES, quoteCol, quoteName, releaseScopeSql, REQUIRED_TABLES } from "./legacy-schema";
import { ScrubArgumentError, ScrubStepError } from "./private-out";

export interface MssqlConfig { server: string; port: number; user: string; password: string; trustServerCertificate: boolean }

export function mssqlConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MssqlConfig {
  const need = (k: string) => { const v = env[k]; if (!v) throw new ScrubArgumentError(`${k} is not set`); return v; };
  return { server: need("LEGACY_SQL_SERVER"), port: Number(env.LEGACY_SQL_PORT ?? 1433), user: need("LEGACY_SQL_USER"), password: need("LEGACY_SQL_PASSWORD"), trustServerCertificate: env.LEGACY_SQL_TRUST_CERT === "true" };
}

export async function openPool(cfg: MssqlConfig, database: string): Promise<sql.ConnectionPool> {
  return new sql.ConnectionPool({
    server: cfg.server, port: cfg.port, user: cfg.user, password: cfg.password, database,
    options: { encrypt: true, trustServerCertificate: cfg.trustServerCertificate },
    requestTimeout: 3_600_000,
    pool: { max: 2 },
  }).connect();
}

export const SCRUB_DB = /^[A-Za-z0-9_.]+_Scrubbed$/;

export async function assertScrubCopy(db: sql.ConnectionPool | sql.Transaction): Promise<void> {
  const r = await new sql.Request(db).query<{ n: string }>("SELECT DB_NAME() AS n");
  if (!SCRUB_DB.test(r.recordset[0]?.n ?? "")) throw new ScrubStepError("refusing to write: the connection is not to a *_Scrubbed database");
}

export interface BackupFile { LogicalName: string; Type: string }

export function restorePlan(dbName: string, files: BackupFile[], dataDir: string, logDir: string): { sql: string; params: Record<string, string> } {
  if (!SCRUB_DB.test(dbName)) throw new ScrubArgumentError("the scrubbed copy's name must end in _Scrubbed");
  const params: Record<string, string> = { db: dbName };
  let data = 0;
  const moves = files.map((f, i) => {
    const log = f.Type === "L";
    params[`l${i}`] = f.LogicalName;
    params[`f${i}`] = `${(log ? logDir : dataDir).replace(/\/+$/, "")}/${dbName}_${i}.${log ? "ldf" : data++ === 0 ? "mdf" : "ndf"}`;
    return `MOVE @l${i} TO @f${i}`;
  });
  return { sql: `RESTORE DATABASE @db FROM DISK = @backup WITH ${moves.join(", ")}, REPLACE, RECOVERY, STATS = 10;`, params };
}

/** Restores the backup under the scrubbed name. The original database is never opened. */
export async function restoreScrubCopy(master: sql.ConnectionPool, backupPath: string, dbName: string): Promise<void> {
  const files = (await master.request().input("backup", sql.NVarChar, backupPath).query<BackupFile>("RESTORE FILELISTONLY FROM DISK = @backup")).recordset;
  const dirs = (await master.request().query<{ d: string; l: string }>("SELECT CAST(SERVERPROPERTY('InstanceDefaultDataPath') AS nvarchar(400)) AS d, CAST(SERVERPROPERTY('InstanceDefaultLogPath') AS nvarchar(400)) AS l")).recordset[0]!;
  const plan = restorePlan(dbName, files, dirs.d, dirs.l);
  await master.request().input("db", sql.NVarChar, dbName).query("IF DB_ID(@db) IS NOT NULL BEGIN DECLARE @q nvarchar(400) = QUOTENAME(@db); EXEC('ALTER DATABASE ' + @q + ' SET SINGLE_USER WITH ROLLBACK IMMEDIATE'); EXEC('DROP DATABASE ' + @q); END");
  const restore = master.request().input("backup", sql.NVarChar, backupPath);
  for (const [k, v] of Object.entries(plan.params)) restore.input(k, sql.NVarChar, v);
  await restore.query(plan.sql);
  await master.request().input("db", sql.NVarChar, dbName).query("DECLARE @q nvarchar(400) = QUOTENAME(@db); EXEC('ALTER DATABASE ' + @q + ' SET RECOVERY SIMPLE');");
}

export async function tableCounts(pool: sql.ConnectionPool): Promise<Record<string, number>> {
  const rows = (await pool.request().query<{ t: string; n: number }>("SELECT s.name + '.' + t.name AS t, CAST(SUM(p.rows) AS int) AS n FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1) GROUP BY s.name, t.name")).recordset;
  return Object.fromEntries(rows.map((r) => [r.t, r.n]));
}

export async function assertRequiredTables(pool: sql.ConnectionPool): Promise<void> {
  const have = new Set(Object.keys(await tableCounts(pool)));
  const missing = REQUIRED_TABLES.filter((t) => !have.has(t));
  if (missing.length) throw new ScrubStepError(`the backup lacks tables the scrub needs: ${missing.join(", ")}`);
}

async function inTransaction(pool: sql.ConnectionPool, fn: (tx: sql.Transaction) => Promise<void>): Promise<void> {
  await assertScrubCopy(pool);
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await fn(tx);
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}

export async function applyScope(pool: sql.ConnectionPool, refUtc: Date, refWall: Date): Promise<void> {
  await inTransaction(pool, async (tx) => {
    await new sql.Request(tx).input("refUtc", sql.DateTimeOffset, refUtc).query(releaseScopeSql());
    await new sql.Request(tx).input("refWall", sql.DateTime, refWall).query(activityScopeSql());
  });
}

export async function emptyTables(pool: sql.ConnectionPool): Promise<string[]> {
  const extra = (await pool.request().query<{ t: string }>(`SELECT s.name + '.' + t.name AS t FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE s.name IN (${EMPTIED_SCHEMAS.map((s) => `'${s}'`).join(", ")})`)).recordset.map((r) => r.t);
  const tables = [...new Set<string>([...EMPTIED_TABLES, ...extra])].sort();
  await inTransaction(pool, async (tx) => {
    // Each table's own foreign keys are switched off so emptied tables can go in any order.
    for (const t of tables) await new sql.Request(tx).query(`ALTER TABLE ${quoteName(t)} NOCHECK CONSTRAINT ALL`);
    for (const t of tables) await new sql.Request(tx).query(`DELETE FROM ${quoteName(t)}`);
    await new sql.Request(tx).query(BLOB_CLEANUP_SQL);
  });
  return tables;
}

export interface DateShiftResult { weeks: number; latestEnd: Date | null; columns: number; logText: { shifted: number; unparsed: number } }

export async function shiftCalendarDates(pool: sql.ConnectionPool, refWall: Date, leadDays: number): Promise<DateShiftResult> {
  const latestEnd = (await pool.request().query<{ d: Date | null }>("SELECT MAX(EndDateTime) AS d FROM calendar.Activity")).recordset[0]?.d ?? null;
  const weeks = latestEnd ? weekOffset(latestEnd, refWall, leadDays) : 0;
  const cols = (await pool.request().query<{ t: string; c: string }>("SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = 'calendar' AND DATA_TYPE IN ('datetime', 'datetime2', 'smalldatetime', 'date', 'datetimeoffset') ORDER BY TABLE_NAME, ORDINAL_POSITION")).recordset;
  const byTable = new Map<string, string[]>();
  for (const r of cols) byTable.set(r.t, [...(byTable.get(r.t) ?? []), r.c]);
  const logText = { shifted: 0, unparsed: 0 };
  if (weeks > 0) {
    await inTransaction(pool, async (tx) => {
      for (const [t, cs] of byTable) await new sql.Request(tx).input("w", sql.Int, weeks).query(`UPDATE ${quoteName(`calendar.${t}`)} SET ${cs.map((c) => `${quoteCol(c)} = DATEADD(week, @w, ${quoteCol(c)})`).join(", ")}`);
      const logs = (await new sql.Request(tx).query<{ Id: number; OldValue: string | null; NewValue: string | null }>("SELECT Id, OldValue, NewValue FROM calendar.Log WHERE FieldName IN (N'StartDateTime', N'EndDateTime')")).recordset;
      for (const l of logs) {
        const move = (v: string | null) => {
          if (v === null || v.trim() === "") return v;
          const s = shiftDateText(v, weeks);
          if (s === null) logText.unparsed++;
          return s ?? v;
        };
        const o = move(l.OldValue), n = move(l.NewValue);
        if (o === l.OldValue && n === l.NewValue) continue;
        await new sql.Request(tx).input("id", sql.Int, l.Id).input("o", sql.NVarChar(1000), o).input("n", sql.NVarChar(1000), n).query("UPDATE calendar.Log SET OldValue = @o, NewValue = @n WHERE Id = @id");
        logText.shifted++;
      }
    });
  }
  return { weeks, latestEnd, columns: cols.length, logText };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: the Step 3 command.
Expected: PASS. Without the password, the `restorePlan` test passes and the fixture block is reported skipped, with `SKIP_MESSAGE` printed.

- [ ] **Step 6: Type-check and commit**

```bash
npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json
git add scripts/lib/scrub/mssql.ts tests/scrub/mssql-fixture.ts tests/scrub/mssql.test.ts
git commit -m "scrub: SQL Server copy, scope, emptied tables and date shift"
```

---

### Task 8: People, every text column, and Gate 1 on SQL Server

**Files:**
- Create: `scripts/lib/scrub/mssql-text.ts`
- Test: `tests/scrub/mssql-text.test.ts`

**Interfaces:**
- Consumes:
  - `PEOPLE_QUERIES`, `STRUCTURED`, `IDENTIFIER_COLUMNS`, `quoteName`, `quoteCol` (Task 6)
  - `assertScrubCopy` (Task 7)
  - `buildPeopleIndex`, `normEmail`, `PersonSource`, `PeopleIndex` (Task 3)
  - `scrubText`, `findLeaks`, `ScrubCtx`, `LeakKind` (Task 4)
- Produces:
  - `readPeopleSources(pool): Promise<PersonSource[]>`
  - `writeStructuredPeople(pool, index): Promise<number>`
  - `interface TextTable { table: string; pk: string[]; columns: { name: string; max: number }[] }`
  - `textTables(pool): Promise<TextTable[]>`
  - `interface TableScrub { rows; changed; truncated; names; emails; phones }`
  - `scrubAllText(pool, ctx, log?): Promise<Record<string, TableScrub>>`
  - `interface GateHit { table: string; column: string; kind: LeakKind; count: number }`
  - `interface GateResult { hits: GateHit[]; rows: { table: string; column: string; kind: LeakKind; id: string }[] }`
  - `gateMssql(pool, index): Promise<GateResult>`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/scrub/mssql-text.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyScope, emptyTables } from "../../scripts/lib/scrub/mssql";
import { gateMssql, readPeopleSources, scrubAllText, writeStructuredPeople } from "../../scripts/lib/scrub/mssql-text";
import { buildPeopleIndex, type PeopleIndex } from "../../scripts/lib/scrub/people";
import { createFixture, FIXTURE_KEY, mssqlTestConfig, REF_UTC, REF_WALL, SKIP_MESSAGE } from "./mssql-fixture";

const cfg = mssqlTestConfig();
if (!cfg) console.warn(SKIP_MESSAGE);

describe.skipIf(!cfg)("people and text on a fictional SQL Server fixture", () => {
  let fx: Awaited<ReturnType<typeof createFixture>>;
  let index: PeopleIndex;
  const q = async <T>(text: string) => (await fx.pool.request().query<T>(text)).recordset;

  beforeAll(async () => {
    fx = await createFixture(cfg!);
    index = buildPeopleIndex(await readPeopleSources(fx.pool), FIXTURE_KEY, new Set(["editor@example.test"]));
    await applyScope(fx.pool, REF_UTC, REF_WALL);
    await emptyTables(fx.pool);
  }, 120_000);
  afterAll(async () => { await fx?.drop(); });

  it("finds people in every source table, journalists included", () => {
    expect(index.bySource.get("calendar.SystemUser:1")).toBe(index.bySource.get("dbo.User:" + "80000000-0000-4000-8000-000000000001".toUpperCase()));
    expect(index.byVariant.has("wynona brightwater")).toBe(true);
    expect(index.bySource.has("calendar.GovernmentRepresentative:2")).toBe(false);
  });

  it("rewrites structured people columns with fictional identities", async () => {
    await writeStructuredPeople(fx.pool, index);
    const quill = index.bySource.get("calendar.SystemUser:1")!.fake;
    const u = (await q<{ FullName: string; DisplayName: string; EmailAddress: string; PhoneNumber: string; MobileNumber: string; Username: string }>("SELECT FullName, DisplayName, EmailAddress, PhoneNumber, MobileNumber, Username FROM calendar.SystemUser WHERE Id = 1"))[0]!;
    expect(u).toEqual({ FullName: quill.full, DisplayName: quill.full, EmailAddress: quill.email, PhoneNumber: quill.phone, MobileNumber: quill.phone, Username: quill.username });
    expect((await q<{ Name: string }>("SELECT Name FROM calendar.CommunicationContact WHERE Id = 1"))[0]!.Name).toBe(quill.full);
    expect((await q<{ Name: string }>("SELECT Name FROM calendar.GovernmentRepresentative WHERE Id = 2"))[0]!.Name).toBe("Premier");
    expect((await q<{ EmailAddress: string }>("SELECT EmailAddress FROM calendar.SystemUser WHERE Id = 4"))[0]!.EmailAddress).toMatch(/^invalid-\d+$/);
    expect((await q<{ DisplayName: string; EmailAddress: string | null }>("SELECT DisplayName, EmailAddress FROM calendar.SystemUser WHERE Id = 3"))[0]!.EmailAddress).toBeNull();
  });

  it("scrubs every text column and passes the gate", async () => {
    await scrubAllText(fx.pool, { index, key: FIXTURE_KEY });
    const gate = await gateMssql(fx.pool, index);
    expect(gate.hits).toEqual([]);
    const a = (await q<{ Title: string; Comments: string }>("SELECT Title, Comments FROM calendar.Activity WHERE Id = 1"))[0]!;
    expect(a.Title).not.toMatch(/Quill|Ashbury/);
    expect(a.Comments).toMatch(/person\d+@example\.test/);
    expect(a.Comments).toMatch(/555-01\d\d/);
    expect((await q<{ Key: string }>("SELECT [Key] FROM dbo.NewsRelease ORDER BY [Key]")).map((r) => r.Key)).toEqual(["2026HLTH0001-000001", "2026HLTH0004-000004"]);
  });

  it("fits a longer replacement to the column", async () => {
    const d = (await q<{ Description: string }>("SELECT Description FROM calendar.GovernmentRepresentative WHERE Id = 3"))[0]!.Description;
    expect(d).toHaveLength(84);
    expect(d).not.toContain("gov.example");
  });

  it("a second pass changes nothing", async () => {
    const again = await scrubAllText(fx.pool, { index, key: FIXTURE_KEY });
    for (const [table, r] of Object.entries(again)) expect(r.changed, table).toBe(0);
  });

  it("fails the gate on a planted name", async () => {
    await fx.pool.request().query("UPDATE calendar.Activity SET Comments = N'Quill Ashbury called' WHERE Id = 5");
    const gate = await gateMssql(fx.pool, index);
    expect(gate.hits).toEqual(expect.arrayContaining([{ table: "calendar.Activity", column: "Comments", kind: "name", count: 1 }, { table: "calendar.Activity", column: "Comments", kind: "name-plain", count: 1 }]));
    expect(gate.rows).toContainEqual({ table: "calendar.Activity", column: "Comments", kind: "name", id: "5" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `SCRUB_TEST_MSSQL_PASSWORD="$(sed -n 's/^MSSQL_SA_PASSWORD=//p' ~/gcpe-parity-private/mssql.env)" npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run tests/scrub/mssql-text.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// scripts/lib/scrub/mssql-text.ts
import sql from "mssql";
import { IDENTIFIER_COLUMNS, PEOPLE_QUERIES, quoteCol, quoteName, STRUCTURED } from "./legacy-schema";
import { assertScrubCopy } from "./mssql";
import { normEmail, type PeopleIndex, type Person, type PersonSource } from "./people";
import { findLeaks, scrubText, type LeakKind, type ScrubCtx } from "./text";

interface PeopleRow { Id: string; Name1: string | null; Name2: string | null; Email: string | null; Phone1: string | null; Phone2: string | null; LinkId: string | null }

export async function readPeopleSources(pool: sql.ConnectionPool): Promise<PersonSource[]> {
  const out: PersonSource[] = [];
  for (const pq of PEOPLE_QUERIES) {
    for (const r of (await pool.request().query<PeopleRow>(pq.sql)).recordset) {
      out.push({ source: pq.source, id: r.Id, names: [r.Name1, r.Name2], email: r.Email, phones: [r.Phone1, r.Phone2], linkId: r.LinkId, ...(pq.linkSource ? { linkSource: pq.linkSource } : {}), ...(pq.alwaysPerson ? { alwaysPerson: true } : {}) });
    }
  }
  return out;
}

function structuredValue(kind: "full" | "email" | "phone" | "username", p: Person, original: string | null): string | null {
  if (original === null || original.trim() === "") return original;
  if (kind === "full") return p.fake.full;
  if (kind === "phone") return p.fake.phone;
  if (kind === "username") return p.fake.username;
  // An unreadable address stays unreadable, so the importers meet the same edge case.
  return normEmail(original) ? p.fake.email : `invalid-${p.fake.slot}`;
}

export async function writeStructuredPeople(pool: sql.ConnectionPool, index: PeopleIndex): Promise<number> {
  await assertScrubCopy(pool);
  const tx = new sql.Transaction(pool);
  await tx.begin();
  let updated = 0;
  try {
    for (const spec of STRUCTURED) {
      const cols = Object.keys(spec.columns);
      const rows = (await new sql.Request(tx).query<Record<string, string | null> & { Id: string }>(`SELECT CAST(Id AS nvarchar(50)) AS Id, ${cols.map(quoteCol).join(", ")} FROM ${quoteName(spec.table)}`)).recordset;
      for (const row of rows) {
        const p = index.bySource.get(`${spec.source}:${row.Id}`);
        if (!p) continue;
        const req = new sql.Request(tx).input("id", sql.NVarChar(50), row.Id);
        cols.forEach((c, i) => req.input(`v${i}`, sql.NVarChar(sql.MAX), structuredValue(spec.columns[c]!, p, row[c] ?? null)));
        await req.query(`UPDATE ${quoteName(spec.table)} SET ${cols.map((c, i) => `${quoteCol(c)} = @v${i}`).join(", ")} WHERE Id = @id`);
        updated++;
      }
    }
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  }
  return updated;
}

export interface TextTable { table: string; pk: string[]; columns: { name: string; max: number }[] }

export async function textTables(pool: sql.ConnectionPool): Promise<TextTable[]> {
  const cols = (await pool.request().query<{ t: string; c: string; m: number | null }>("SELECT c.TABLE_SCHEMA + '.' + c.TABLE_NAME AS t, c.COLUMN_NAME AS c, c.CHARACTER_MAXIMUM_LENGTH AS m FROM INFORMATION_SCHEMA.COLUMNS c JOIN INFORMATION_SCHEMA.TABLES tb ON tb.TABLE_SCHEMA = c.TABLE_SCHEMA AND tb.TABLE_NAME = c.TABLE_NAME AND tb.TABLE_TYPE = 'BASE TABLE' WHERE c.DATA_TYPE IN ('char', 'nchar', 'varchar', 'nvarchar', 'text', 'ntext') ORDER BY 1, c.ORDINAL_POSITION")).recordset;
  const pks = (await pool.request().query<{ t: string; c: string }>("SELECT s.name + '.' + t.name AS t, c.name AS c FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id JOIN sys.tables t ON t.object_id = i.object_id JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE i.is_primary_key = 1 ORDER BY 1, ic.key_ordinal")).recordset;
  const pkOf = new Map<string, string[]>();
  for (const r of pks) pkOf.set(r.t, [...(pkOf.get(r.t) ?? []), r.c]);
  const out = new Map<string, TextTable>();
  for (const r of cols) {
    const t = out.get(r.t) ?? { table: r.t, pk: pkOf.get(r.t) ?? [], columns: [] };
    t.columns.push({ name: r.c, max: r.m ?? -1 });
    out.set(r.t, t);
  }
  return [...out.values()];
}

async function forEachPage(db: sql.ConnectionPool | sql.Transaction, t: TextTable, cols: string[], fn: (rows: Record<string, unknown>[]) => Promise<void>, pageSize = 2000): Promise<void> {
  const select = [...new Set([...t.pk, ...cols])].map(quoteCol).join(", ");
  const order = t.pk.length ? t.pk.map(quoteCol).join(", ") : "(SELECT NULL)";
  for (let offset = 0; ; offset += pageSize) {
    const rows = (await new sql.Request(db).input("o", sql.Int, offset).input("n", sql.Int, pageSize).query<Record<string, unknown>>(`SELECT ${select} FROM ${quoteName(t.table)} ORDER BY ${order} OFFSET @o ROWS FETCH NEXT @n ROWS ONLY`)).recordset;
    if (rows.length > 0) await fn(rows);
    if (rows.length < pageSize) return;
  }
}

export interface TableScrub { rows: number; changed: number; truncated: number; names: number; emails: number; phones: number }

export async function scrubAllText(pool: sql.ConnectionPool, ctx: ScrubCtx, log: (line: string) => void = () => {}): Promise<Record<string, TableScrub>> {
  await assertScrubCopy(pool);
  const report: Record<string, TableScrub> = {};
  for (const t of await textTables(pool)) {
    const cols = t.columns.filter((c) => !t.pk.includes(c.name) && !(IDENTIFIER_COLUMNS[t.table] ?? []).includes(c.name));
    if (cols.length === 0 || t.pk.length === 0) continue;
    const r: TableScrub = { rows: 0, changed: 0, truncated: 0, names: 0, emails: 0, phones: 0 };
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      await forEachPage(tx, t, cols.map((c) => c.name), async (rows) => {
        for (const row of rows) {
          r.rows++;
          const set: [string, string][] = [];
          for (const c of cols) {
            const v = row[c.name];
            if (typeof v !== "string" || v === "") continue;
            const s = scrubText(v, ctx);
            r.names += s.counts.names; r.emails += s.counts.emails; r.phones += s.counts.phones;
            let next = s.text;
            if (c.max > 0 && next.length > c.max) { next = next.slice(0, c.max); r.truncated++; }
            if (next !== v) set.push([c.name, next]);
          }
          if (set.length === 0) continue;
          const req = new sql.Request(tx);
          set.forEach(([, v], i) => req.input(`v${i}`, sql.NVarChar(sql.MAX), v));
          t.pk.forEach((k, i) => req.input(`k${i}`, row[k]));
          await req.query(`UPDATE ${quoteName(t.table)} SET ${set.map(([c], i) => `${quoteCol(c)} = @v${i}`).join(", ")} WHERE ${t.pk.map((k, i) => `${quoteCol(k)} = @k${i}`).join(" AND ")}`);
          r.changed++;
        }
      });
      await tx.commit();
    } catch (e) {
      await tx.rollback();
      throw e;
    }
    report[t.table] = r;
    log(`${t.table}: ${r.rows} rows read, ${r.changed} changed, ${r.truncated} fitted to their column`);
  }
  return report;
}

export interface GateHit { table: string; column: string; kind: LeakKind; count: number }
export interface GateResult { hits: GateHit[]; rows: { table: string; column: string; kind: LeakKind; id: string }[] }

export async function gateMssql(pool: sql.ConnectionPool, index: PeopleIndex): Promise<GateResult> {
  const counts = new Map<string, GateHit>();
  const rows: GateResult["rows"] = [];
  for (const t of await textTables(pool)) {
    const cols = t.columns.map((c) => c.name);
    await forEachPage(pool, t, cols, async (page) => {
      for (const row of page) for (const c of cols) {
        const v = row[c];
        if (typeof v !== "string" || v === "") continue;
        for (const kind of findLeaks(v, index)) {
          const k = `${t.table}|${c}|${kind}`;
          const h = counts.get(k) ?? { table: t.table, column: c, kind, count: 0 };
          h.count++;
          counts.set(k, h);
          rows.push({ table: t.table, column: c, kind, id: t.pk.map((p) => String(row[p])).join("/") });
        }
      }
    });
  }
  return { hits: [...counts.values()], rows };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: the Step 2 command.
Expected: PASS, or skipped with the message when there is no password.

- [ ] **Step 5: Run Tasks 7–8 together, type-check, commit**

```bash
SCRUB_TEST_MSSQL_PASSWORD="$(sed -n 's/^MSSQL_SA_PASSWORD=//p' ~/gcpe-parity-private/mssql.env)" npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run tests/scrub
npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json
git add scripts/lib/scrub/mssql-text.ts tests/scrub/mssql-text.test.ts
git commit -m "scrub: people, every text column and the SQL Server leak gate"
```

---

### Task 9: Gate 2 on Postgres

**Files:**
- Create: `scripts/lib/scrub/pg-gate.ts`
- Test: `tests/scrub/pg-gate.test.ts`

**Interfaces:**
- Consumes: `findLeaks` (Task 4), `PeopleIndex`/`buildPeopleIndex` (Task 3), `GateHit`/`GateResult` (Task 8).
- Produces:
  - `interface PgGateResult extends GateResult { signInProblems: number }`
  - `SIGN_IN_SQL`
  - `gatePostgres(dbs: { name: string; url: string }[], index: PeopleIndex, o: { coreUrl: string; signInAllowed: ReadonlySet<string> }): Promise<PgGateResult>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/scrub/pg-gate.test.ts
import { join, resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";
import { gatePostgres } from "../../scripts/lib/scrub/pg-gate";
import { buildPeopleIndex } from "../../scripts/lib/scrub/people";

const CORE_MIGRATIONS = join(resolve(import.meta.dirname, "..", ".."), "apps", "core", "migrations");
const index = buildPeopleIndex([{ source: "t", id: "1", names: ["Quill Ashbury"], email: "quill.ashbury@gov.example", phones: [] }], "f".repeat(64));

describe("gatePostgres", () => {
  let core: TestDatabase;
  beforeAll(async () => { core = await createTestDatabase({ migrationsFolder: CORE_MIGRATIONS }); });
  afterAll(async () => { await core?.drop(); });
  const exec = async (text: string, values: unknown[] = []) => { const c = new pg.Client({ connectionString: core.url }); await c.connect(); try { await c.query(text, values); } finally { await c.end(); } };

  it("passes a clean database", async () => {
    const r = await gatePostgres([{ name: "core", url: core.url }], index, { coreUrl: core.url, signInAllowed: new Set() });
    expect(r).toMatchObject({ hits: [], signInProblems: 0 });
  });

  it("finds names in text and inside JSON, and real emails", async () => {
    await exec("INSERT INTO organizations (key, display_name, minister, social) VALUES ('health', 'Health', $1::jsonb, '{}'::jsonb)", [JSON.stringify({ name: "Quill\nAshbury", email: "quill.ashbury@gov.example" })]);
    const r = await gatePostgres([{ name: "core", url: core.url }], index, { coreUrl: core.url, signInAllowed: new Set() });
    expect(r.hits).toEqual(expect.arrayContaining([
      { table: "core.organizations", column: "minister", kind: "name", count: 1 },
      { table: "core.organizations", column: "minister", kind: "email", count: 1 },
    ]));
  });

  it("counts users who could sign in and aren't carried-over test accounts", async () => {
    await exec("INSERT INTO users (email, display_name, password_hash) VALUES ('alex.ashfield@example.test', 'Alex Ashfield', 'scrypt$x'), ('editor@example.test', 'Test Editor', 'scrypt$y')");
    const r = await gatePostgres([], index, { coreUrl: core.url, signInAllowed: new Set(["editor@example.test"]) });
    expect(r.signInProblems).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run tests/scrub/pg-gate.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// scripts/lib/scrub/pg-gate.ts
import pg from "pg";
import type { GateHit, GateResult } from "./mssql-text";
import type { PeopleIndex } from "./people";
import { findLeaks } from "./text";

export interface PgGateResult extends GateResult { signInProblems: number }

/** Users who could sign in but aren't a carried-over test account, or whose email isn't fictional. */
export const SIGN_IN_SQL = "SELECT count(*)::int AS n FROM users WHERE NOT (lower(coalesce(email, '')) = ANY($1::text[])) AND (password_hash IS NOT NULL OR entra_oid IS NOT NULL OR (email IS NOT NULL AND lower(email) NOT LIKE '%@example.test'))";

const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;
function stringsOf(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out);
  else if (v !== null && typeof v === "object" && !(v instanceof Date) && !Buffer.isBuffer(v)) for (const x of Object.values(v)) stringsOf(x, out);
  return out;
}

export async function gatePostgres(dbs: { name: string; url: string }[], index: PeopleIndex, o: { coreUrl: string; signInAllowed: ReadonlySet<string> }): Promise<PgGateResult> {
  const counts = new Map<string, GateHit>();
  const rows: GateResult["rows"] = [];
  for (const db of dbs) {
    const client = new pg.Client({ connectionString: db.url });
    await client.connect();
    try {
      const cols = (await client.query<{ t: string; c: string }>("SELECT c.table_name AS t, c.column_name AS c FROM information_schema.columns c JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name WHERE c.table_schema = 'public' AND tb.table_type = 'BASE TABLE' AND (c.data_type IN ('text', 'character varying', 'character', 'json', 'jsonb') OR (c.data_type = 'ARRAY' AND c.udt_name IN ('_text', '_varchar'))) ORDER BY c.table_name, c.ordinal_position")).rows;
      const byTable = new Map<string, string[]>();
      for (const r of cols) byTable.set(r.t, [...(byTable.get(r.t) ?? []), r.c]);
      for (const [table, columns] of byTable) {
        let after = "(0,0)";
        for (;;) {
          const page = (await client.query<Record<string, unknown> & { ctid: string }>(`SELECT ctid::text AS ctid, ${columns.map(qi).join(", ")} FROM ${qi(table)} WHERE ctid > $1::tid ORDER BY ctid LIMIT 2000`, [after])).rows;
          for (const row of page) for (const c of columns) for (const s of stringsOf(row[c])) for (const kind of findLeaks(s, index)) {
            const t = `${db.name}.${table}`;
            const k = `${t}|${c}|${kind}`;
            const h = counts.get(k) ?? { table: t, column: c, kind, count: 0 };
            h.count++;
            counts.set(k, h);
            rows.push({ table: t, column: c, kind, id: row.ctid });
          }
          if (page.length < 2000) break;
          after = page[page.length - 1]!.ctid;
        }
      }
    } finally {
      await client.end();
    }
  }
  const core = new pg.Client({ connectionString: o.coreUrl });
  await core.connect();
  try {
    const signInProblems = (await core.query<{ n: number }>(SIGN_IN_SQL, [[...o.signInAllowed].map((e) => e.toLowerCase())])).rows[0]!.n;
    return { hits: [...counts.values()], rows, signInProblems };
  } finally {
    await core.end();
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run tests/scrub/pg-gate.test.ts`
Expected: PASS. If `ctid > $1::tid` is rejected by the local Postgres, page with `ORDER BY ctid LIMIT 2000 OFFSET $1` instead, and keep the test.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/scrub/pg-gate.ts tests/scrub/pg-gate.test.ts
git commit -m "scrub: Postgres leak gate and sign-in check"
```

---

### Task 10: Local databases, importer steps and the test-account seed

**Files:**
- Create: `scripts/lib/scrub/local.ts`
- Test: `tests/scrub/local.test.ts`

**Interfaces:**
- Consumes:
  - `adminUrl`, `withAdmin` from `@gcpe/db-kit`
  - `MssqlConfig`, `SCRUB_DB` (Task 7)
  - `ScrubArgumentError` (Task 1)
- Produces:
  - `LOCAL_DB_NAMES`, `type LocalApp`
  - `localDbUrl(name: string, admin?: string): string`
  - `recreateLocalDbs(): Promise<Record<LocalApp, string>>`
  - `legacyEnv(cfg: MssqlConfig, scrubbedDb: string): Record<string, string>`
  - `PLACEHOLDER_SUBSCRIBER(name, types)`
  - `interface CommandStep { name: string; npmArgs: string[]; env: Record<string, string> }`
  - `importSteps(urls, legacy, o: { out: string; cutoff: string }): CommandStep[]`
  - `runStep(step: CommandStep, logFile: string, spawnFn?: typeof spawn): Promise<number>`
  - `type TestAccounts`
  - `parseTestAccounts(json: string): TestAccounts`
  - `signInEmails(a: TestAccounts): Set<string>`
  - `seedTestAccounts(coreUrl: string, a: TestAccounts): Promise<{ users: number; grants: number; memberships: number }>`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/scrub/local.test.ts
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";
import { importSteps, legacyEnv, localDbUrl, parseTestAccounts, runStep, seedTestAccounts, signInEmails } from "../../scripts/lib/scrub/local";

const cfg = { server: "127.0.0.1", port: 1433, user: "sa", password: "fictional-password", trustServerCertificate: true };
const urls = { core: "postgres://h/scrub_core", nrms: "postgres://h/scrub_nrms", newsApi: "postgres://h/scrub_news_api", site: "postgres://h/scrub_site", calendar: "postgres://h/scrub_calendar", nod: "postgres://h/scrub_nod", distribution: "postgres://h/scrub_distribution" };

describe("importer steps", () => {
  it("only ever point the importers at the scrubbed copy", () => {
    expect(() => legacyEnv(cfg, "Gcpe.Hub")).toThrow(/_Scrubbed/);
    expect(() => legacyEnv({ ...cfg, port: 1434 }, "Gcpe.Hub_Scrubbed")).toThrow(/1433/);
    const steps = importSteps(urls, legacyEnv(cfg, "Gcpe.Hub_Scrubbed"), { out: "/p/run", cutoff: "2000-01-01" });
    expect(steps.map((s) => s.name)).toEqual(["core", "nrms", "calendar", "news-api"]);
    for (const s of steps) expect(s.env.LEGACY_SQL_DATABASE).toBe("Gcpe.Hub_Scrubbed");
    expect(steps[2]!.npmArgs).toEqual(["run", "calendar:import", "--", "--cutoff", "2000-01-01", "--confirm", "--report", "/p/run/reports/calendar-import.json"]);
    expect(JSON.parse(steps[2]!.env.CORE_EVENT_SUBSCRIBERS!).map((s: { name: string }) => s.name)).toEqual(["calendar", "nrms"]);
    expect(steps[1]!.env).toMatchObject({ DATABASE_URL: urls.nrms, CORE_DATABASE_URL: urls.core });
  });

  it("builds local URLs only for scrub_ names", () => {
    expect(localDbUrl("scrub_core", "postgres://localhost:5432/postgres")).toBe("postgres://localhost:5432/scrub_core");
    expect(() => localDbUrl("rehearsal_core")).toThrow();
  });

  it("writes a step's output to its log and returns the exit code", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "scrub-step-")), "x.log");
    const fake = ((_cmd: string, _args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      const child = new EventEmitter();
      expect(opts.env.DATABASE_URL).toBe("postgres://h/x");
      setImmediate(() => child.emit("exit", 2));
      return child;
    }) as never;
    expect(await runStep({ name: "x", npmArgs: ["run", "x"], env: { DATABASE_URL: "postgres://h/x" } }, log, fake)).toBe(2);
    expect(readFileSync(log, "utf8")).toBe("");
  });
});

const ACCOUNTS = JSON.stringify({
  users: [{ id: "c0000000-0000-4000-8000-000000000001", email: "editor@example.test", display_name: "Test Editor", is_active: true, sign_in_method: "local", password_hash: "scrypt$fictional", entra_oid: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" }],
  roleGrants: [{ user_id: "c0000000-0000-4000-8000-000000000001", role: "NRMS.Editor", granted_at: "2026-10-01T00:00:00Z" }],
  memberships: [{ user_id: "c0000000-0000-4000-8000-000000000001", org_key: "health", org_abbreviation: "HLTH" }],
});

describe("test accounts", () => {
  let core: TestDatabase;
  beforeAll(async () => { core = await createTestDatabase({ migrationsFolder: join(resolve(import.meta.dirname, "..", ".."), "apps", "core", "migrations") }); });
  afterAll(async () => { await core?.drop(); });
  const count = async (table: string) => { const c = new pg.Client({ connectionString: core.url }); await c.connect(); try { return (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n; } finally { await c.end(); } };

  it("parses and lists the accounts that may sign in", () => {
    expect([...signInEmails(parseTestAccounts(ACCOUNTS))]).toEqual(["editor@example.test"]);
    expect(() => parseTestAccounts("{}")).toThrow();
  });

  it("refuses, and writes nothing, when an organisation is missing", async () => {
    await expect(seedTestAccounts(core.url, parseTestAccounts(ACCOUNTS))).rejects.toThrow(/health/);
    expect(await count("users")).toBe(0);
  });

  it("seeds users, grants and memberships by organisation key", async () => {
    const c = new pg.Client({ connectionString: core.url }); await c.connect();
    try { await c.query("INSERT INTO organizations (key, display_name, abbreviation, minister, social) VALUES ('health', 'Health', 'HLTH', '{}'::jsonb, '{}'::jsonb)"); } finally { await c.end(); }
    expect(await seedTestAccounts(core.url, parseTestAccounts(ACCOUNTS))).toEqual({ users: 1, grants: 1, memberships: 1 });
    expect(await count("user_organizations")).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run tests/scrub/local.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// scripts/lib/scrub/local.ts
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import pg from "pg";
import { z } from "zod";
import { adminUrl, withAdmin } from "@gcpe/db-kit";
import { SCRUB_DB, type MssqlConfig } from "./mssql";
import { ScrubArgumentError } from "./private-out";

const REPO = resolve(import.meta.dirname, "..", "..", "..");

export const LOCAL_DB_NAMES = { core: "scrub_core", nrms: "scrub_nrms", newsApi: "scrub_news_api", site: "scrub_site", calendar: "scrub_calendar", nod: "scrub_nod", distribution: "scrub_distribution" } as const;
export type LocalApp = keyof typeof LOCAL_DB_NAMES;
const LOCAL_NAME = /^scrub_[a-z_]+$/;

export function localDbUrl(name: string, admin = adminUrl()): string {
  if (!LOCAL_NAME.test(name)) throw new ScrubArgumentError("local scrub databases are named scrub_*");
  const u = new URL(admin);
  u.pathname = `/${name}`;
  return u.toString();
}

export async function recreateLocalDbs(): Promise<Record<LocalApp, string>> {
  await withAdmin(async (c) => {
    for (const name of Object.values(LOCAL_DB_NAMES)) {
      if (!LOCAL_NAME.test(name)) throw new ScrubArgumentError("local scrub databases are named scrub_*");
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.query(`CREATE DATABASE ${name}`);
    }
  });
  return Object.fromEntries(Object.entries(LOCAL_DB_NAMES).map(([k, v]) => [k, localDbUrl(v)])) as Record<LocalApp, string>;
}

export function legacyEnv(cfg: MssqlConfig, scrubbedDb: string): Record<string, string> {
  if (!SCRUB_DB.test(scrubbedDb)) throw new ScrubArgumentError("the importers may only read a *_Scrubbed database");
  if (cfg.port !== 1433) throw new ScrubArgumentError("the importers only reach SQL Server on port 1433");
  return { LEGACY_SQL_SERVER: cfg.server, LEGACY_SQL_DATABASE: scrubbedDb, LEGACY_SQL_USER: cfg.user, LEGACY_SQL_PASSWORD: cfg.password, LEGACY_SQL_TRUST_CERT: cfg.trustServerCertificate ? "true" : "false" };
}

/** A command-line subscriber: only its name and types matter; the running stack delivers by name. */
export const PLACEHOLDER_SUBSCRIBER = (name: string, types: string[]) => ({ name, url: "https://import-cli.example.test/unused", secret: "unused-by-cli-000000000000000000000000", types });

export interface CommandStep { name: string; npmArgs: string[]; env: Record<string, string> }

export function importSteps(urls: Record<LocalApp, string>, legacy: Record<string, string>, o: { out: string; cutoff: string }): CommandStep[] {
  return [
    { name: "core", npmArgs: ["--workspace", "@gcpe/core", "run", "import:legacy"], env: { ...legacy, DATABASE_URL: urls.core } },
    { name: "nrms", npmArgs: ["run", "nrms:import", "--", "--report", join(o.out, "reports", "nrms-import.json")], env: { ...legacy, DATABASE_URL: urls.nrms, CORE_DATABASE_URL: urls.core } },
    {
      name: "calendar",
      npmArgs: ["run", "calendar:import", "--", "--cutoff", o.cutoff, "--confirm", "--report", join(o.out, "reports", "calendar-import.json")],
      env: { ...legacy, DATABASE_URL: urls.calendar, CORE_DATABASE_URL: urls.core, CALENDAR_STORAGE_DIR: join(o.out, "calendar-files"), CORE_EVENT_SUBSCRIBERS: JSON.stringify([PLACEHOLDER_SUBSCRIBER("calendar", ["user.upserted"]), PLACEHOLDER_SUBSCRIBER("nrms", ["user.upserted"])]) },
    },
    { name: "news-api", npmArgs: ["--workspace", "@gcpe/news-api", "run", "import:legacy"], env: { ...legacy, DATABASE_URL: urls.newsApi } },
  ];
}

/** Runs an npm script with its own env; its output goes to a private log, never to the terminal. */
export async function runStep(step: CommandStep, logFile: string, spawnFn: typeof spawn = spawn): Promise<number> {
  mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
  const fd = openSync(logFile, "a", 0o600);
  try {
    return await new Promise<number>((res, rej) => {
      const child = spawnFn("npm", step.npmArgs, { cwd: REPO, env: { ...process.env, ...step.env }, stdio: ["ignore", fd, fd] });
      child.on("error", rej);
      child.on("exit", (code) => res(code ?? 1));
    });
  } finally {
    closeSync(fd);
  }
}

const accountsSchema = z.object({
  users: z.array(z.object({ id: z.string().uuid(), email: z.string().nullable(), display_name: z.string(), is_active: z.boolean(), sign_in_method: z.enum(["local", "entra"]), password_hash: z.string().nullable(), entra_oid: z.string().nullable(), created_at: z.string(), updated_at: z.string() })),
  roleGrants: z.array(z.object({ user_id: z.string().uuid(), role: z.string(), granted_at: z.string() })),
  memberships: z.array(z.object({ user_id: z.string().uuid(), org_key: z.string(), org_abbreviation: z.string().nullable() })),
});
export type TestAccounts = z.infer<typeof accountsSchema>;

export function parseTestAccounts(json: string): TestAccounts {
  return accountsSchema.parse(JSON.parse(json));
}

export function signInEmails(a: TestAccounts): Set<string> {
  return new Set(a.users.map((u) => (u.email ?? "").toLowerCase()).filter((e) => e !== ""));
}

export async function seedTestAccounts(coreUrl: string, a: TestAccounts): Promise<{ users: number; grants: number; memberships: number }> {
  const client = new pg.Client({ connectionString: coreUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    for (const u of a.users) await client.query("INSERT INTO users (id, email, display_name, is_active, sign_in_method, password_hash, entra_oid, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)", [u.id, u.email, u.display_name, u.is_active, u.sign_in_method, u.password_hash, u.entra_oid, u.created_at, u.updated_at]);
    for (const g of a.roleGrants) await client.query("INSERT INTO role_grants (user_id, role, granted_at) VALUES ($1, $2, $3)", [g.user_id, g.role, g.granted_at]);
    const missing = new Set<string>();
    for (const m of a.memberships) {
      const r = await client.query("INSERT INTO user_organizations (user_id, organization_id) SELECT $1, o.id FROM organizations o WHERE o.key = $2 OR ($3::text IS NOT NULL AND o.abbreviation = $3) ORDER BY (o.key = $2) DESC LIMIT 1 ON CONFLICT DO NOTHING", [m.user_id, m.org_key, m.org_abbreviation]);
      if (r.rowCount === 0) missing.add(m.org_key);
    }
    if (missing.size > 0) throw new ScrubArgumentError(`no organisation for the test accounts' keys: ${[...missing].sort().join(", ")}`);
    await client.query("COMMIT");
    return { users: a.users.length, grants: a.roleGrants.length, memberships: a.memberships.length };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    await client.end();
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run tests/scrub/local.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/scrub/local.ts tests/scrub/local.test.ts
git commit -m "scrub: local databases, importer steps and test-account seed"
```

---

### Task 11: Smoke test and the local trial

**Files:**
- Create: `scripts/lib/scrub/smoke.ts`, `scripts/lib/scrub/trial.ts`
- Test: `tests/scrub/smoke.test.ts`, `tests/scrub/trial.test.ts`

**Interfaces:**
- Consumes:
  - `addDays`, `bcToday` (Task 5)
  - `CommandStep`, `PLACEHOLDER_SUBSCRIBER`, `runStep`, `LocalApp` (Task 10)
  - `startStack` (`apps/stack/src/stack.ts`), `sessionSecretFrom` (`apps/stack/src/env.ts`)
  - `startSmtpSink` (`apps/distribution/test/smtp-sink.ts`)
  - `hashPassword`, `mintSession`, `SESSION_COOKIE` (`@gcpe/auth`)
  - `findUserByEmail`, `sessionUserFor` (`apps/core/src/services/users.ts`)
  - `createDb` (`@gcpe/db-kit`)
- Produces:
  - `interface SmokeCheck { name: string; ok: boolean; detail: string }`
  - `loginWithPassword(base, email, password, f?): Promise<string>` (the `gcpe_session=…` cookie)
  - `stackHealthy(base, f?): Promise<boolean>`
  - `waitFor(cond: () => Promise<boolean>, o: { timeoutMs: number; everyMs: number }): Promise<boolean>`
  - `runSmoke(o: { base; calendarCookie; releaseCookie; today; fetch?; pollMs?; timeoutMs? }): Promise<SmokeCheck[]>`
  - `drainUntilIdle(o: { tick(): Promise<void>; pending(): Promise<{ pending: number; dead: number }>; maxTicks?: number }): Promise<number>`
  - `replaySteps(urls): CommandStep[]`
  - `interface TrialResult { ticks: number; smoke: SmokeCheck[] }`
  - `runTrial(o: { urls: Record<LocalApp, string>; out: string; calendarUser: string; releaseUser: string; log(line: string): void }): Promise<TrialResult>`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/scrub/smoke.test.ts
import { describe, expect, it } from "vitest";
import { loginWithPassword, runSmoke, stackHealthy } from "../../scripts/lib/scrub/smoke";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fakeFetch(over: Record<string, () => Response> = {}): typeof fetch {
  const routes: Record<string, () => Response> = {
    "GET /calendar/api/list": () => json({ rows: [], total: 12, offset: 0 }),
    "POST /calendar/api/reports/look-ahead": () => json({ id: "AAAAAAAAAAAAAAAAAAAAAA", report: "look-ahead", status: "running", error: null }, 202),
    "GET /calendar/api/reports/jobs/AAAAAAAAAAAAAAAAAAAAAA": () => json({ id: "AAAAAAAAAAAAAAAAAAAAAA", report: "look-ahead", status: "ready", error: null }),
    "GET /calendar/api/reports/jobs/AAAAAAAAAAAAAAAAAAAAAA/pdf": () => new Response("%PDF-1.7 fictional", { status: 200 }),
    "GET /nrms/api/releases": () => json({ items: [{ id: "r1" }], total: 1, page: 1, pageSize: 1 }),
    "GET /nrms/api/releases/r1": () => json({ id: "r1" }),
    "GET /site/": () => new Response("<!doctype html><html></html>", { status: 200 }),
    ...over,
  };
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const route = routes[`${init?.method ?? "GET"} ${u.pathname}`];
    return route ? route() : new Response("not found", { status: 404 });
  }) as typeof fetch;
}
const opts = (f: typeof fetch) => ({ base: "http://127.0.0.1:1", calendarCookie: "gcpe_session=a", releaseCookie: "gcpe_session=b", today: "2026-10-22", fetch: f, pollMs: 1, timeoutMs: 1000 });

describe("runSmoke", () => {
  it("passes when every check passes", async () => {
    const checks = await runSmoke(opts(fakeFetch()));
    expect(checks.map((c) => [c.name, c.ok])).toEqual([["calendar list", true], ["look ahead pdf", true], ["open a release", true], ["public home page", true]]);
  });

  it("fails an empty calendar and a report that isn't a PDF", async () => {
    const checks = await runSmoke(opts(fakeFetch({ "GET /calendar/api/list": () => json({ rows: [], total: 0, offset: 0 }), "GET /calendar/api/reports/jobs/AAAAAAAAAAAAAAAAAAAAAA/pdf": () => new Response("oops") })));
    expect(checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["calendar list", "look ahead pdf"]);
  });
});

describe("sign-in and health", () => {
  it("returns the session cookie", async () => {
    const f = (async () => new Response("{}", { status: 200, headers: { "set-cookie": "gcpe_session=abc.def; Path=/; HttpOnly" } })) as typeof fetch;
    expect(await loginWithPassword("http://x", "editor@example.test", "fictional", f)).toBe("gcpe_session=abc.def");
  });
  it("reports health only for 200 with status ok", async () => {
    expect(await stackHealthy("http://x", (async () => json({ status: "ok" })) as typeof fetch)).toBe(true);
    expect(await stackHealthy("http://x", (async () => json({ status: "unavailable" }, 503)) as typeof fetch)).toBe(false);
    expect(await stackHealthy("http://x", (async () => { throw new Error("down"); }) as typeof fetch)).toBe(false);
  });
});
```

```ts
// tests/scrub/trial.test.ts
import { describe, expect, it } from "vitest";
import { drainUntilIdle, replaySteps } from "../../scripts/lib/scrub/trial";

describe("drainUntilIdle", () => {
  it("stops after two quiet ticks", async () => {
    const pending = [3, 1, 0, 0, 5];
    let i = 0;
    expect(await drainUntilIdle({ tick: async () => {}, pending: async () => ({ pending: pending[i++]!, dead: 0 }) })).toBe(4);
  });
  it("fails on a dead delivery and when ticks run out", async () => {
    await expect(drainUntilIdle({ tick: async () => {}, pending: async () => ({ pending: 0, dead: 1 }) })).rejects.toThrow(/failed for good/);
    await expect(drainUntilIdle({ tick: async () => {}, pending: async () => ({ pending: 1, dead: 0 }), maxTicks: 3 })).rejects.toThrow(/still pending/);
  });
});

describe("replaySteps", () => {
  it("replays activities to NRMS, links to the Calendar, then fills search text", () => {
    const steps = replaySteps({ core: "c", nrms: "n", newsApi: "a", site: "s", calendar: "k", nod: "d", distribution: "t" });
    expect(steps.map((s) => s.npmArgs[1])).toEqual(["calendar:replay-to-nrms", "nrms:replay-activity-links", "news-api:search-backfill"]);
    expect(steps[0]!.env.DATABASE_URL).toBe("k");
    expect(JSON.parse(steps[1]!.env.EVENT_SUBSCRIBERS!)[0].types).toEqual(["release.status_changed"]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run tests/scrub/smoke.test.ts tests/scrub/trial.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

```ts
// scripts/lib/scrub/smoke.ts
import { setTimeout as sleep } from "node:timers/promises";
import { addDays } from "./dates";

export interface SmokeCheck { name: string; ok: boolean; detail: string }

export async function loginWithPassword(base: string, email: string, password: string, f: typeof fetch = fetch): Promise<string> {
  const res = await f(`${base}/core/auth/login`, { method: "POST", headers: { "content-type": "application/json", "x-gcpe-request": "1" }, body: JSON.stringify({ username: email, password }) });
  if (res.status !== 200) throw new Error(`sign-in as ${email} failed (HTTP ${res.status})`);
  const m = /gcpe_session=[^;]+/.exec(res.headers.get("set-cookie") ?? "");
  if (!m) throw new Error(`sign-in as ${email} returned no session`);
  return m[0];
}

export async function stackHealthy(base: string, f: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await f(`${base}/stack/health`);
    if (r.status !== 200) return false;
    return ((await r.json()) as { status?: string }).status === "ok";
  } catch {
    return false;
  }
}

export async function waitFor(cond: () => Promise<boolean>, o: { timeoutMs: number; everyMs: number }): Promise<boolean> {
  const deadline = Date.now() + o.timeoutMs;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() > deadline) return false;
    await sleep(o.everyMs);
  }
}

export async function runSmoke(o: { base: string; calendarCookie: string; releaseCookie: string; today: string; fetch?: typeof fetch; pollMs?: number; timeoutMs?: number }): Promise<SmokeCheck[]> {
  const f = o.fetch ?? fetch;
  const checks: SmokeCheck[] = [];
  const step = async (name: string, fn: () => Promise<string>) => {
    try { checks.push({ name, ok: true, detail: await fn() }); } catch (e) { checks.push({ name, ok: false, detail: e instanceof Error ? e.message : "error" }); }
  };
  const cal = { cookie: o.calendarCookie };
  const rel = { cookie: o.releaseCookie };
  const expectOk = (r: Response) => { if (r.status !== 200) throw new Error(`HTTP ${r.status}`); };

  await step("calendar list", async () => {
    const r = await f(`${o.base}/calendar/api/list?q=${encodeURIComponent("{}")}`, { headers: cal });
    expectOk(r);
    const total = ((await r.json()) as { total: number }).total;
    if (!(total > 0)) throw new Error("the list is empty");
    return `${total} activities`;
  });
  await step("look ahead pdf", async () => {
    const start = await f(`${o.base}/calendar/api/reports/look-ahead`, { method: "POST", headers: { ...cal, "content-type": "application/json", "x-gcpe-request": "1" }, body: JSON.stringify({ q: { filter: { from: o.today, to: addDays(o.today, 6) } } }) });
    if (start.status !== 201 && start.status !== 202) throw new Error(`HTTP ${start.status}`);
    let job = (await start.json()) as { id: string; status: string };
    const deadline = Date.now() + (o.timeoutMs ?? 120_000);
    while (job.status === "running") {
      if (Date.now() > deadline) throw new Error("the report timed out");
      await sleep(o.pollMs ?? 1000);
      job = (await (await f(`${o.base}/calendar/api/reports/jobs/${job.id}`, { headers: cal })).json()) as typeof job;
    }
    if (job.status !== "ready") throw new Error(`the report ${job.status}`);
    const pdf = await f(`${o.base}/calendar/api/reports/jobs/${job.id}/pdf`, { headers: cal });
    const bytes = new Uint8Array(await pdf.arrayBuffer());
    if (pdf.status !== 200 || new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") throw new Error("not a PDF");
    return `${bytes.length} bytes`;
  });
  await step("open a release", async () => {
    const list = await f(`${o.base}/nrms/api/releases?folder=published&pageSize=1`, { headers: rel });
    expectOk(list);
    const first = ((await list.json()) as { items: { id: string }[] }).items[0];
    if (!first) throw new Error("no published release");
    expectOk(await f(`${o.base}/nrms/api/releases/${first.id}`, { headers: rel }));
    return "opened";
  });
  await step("public home page", async () => {
    const r = await f(`${o.base}/site/`);
    expectOk(r);
    if (!(await r.text()).includes("<html")) throw new Error("not an HTML page");
    return "ok";
  });
  return checks;
}
```

```ts
// scripts/lib/scrub/trial.ts
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import pg from "pg";
import { hashPassword, mintSession, SESSION_COOKIE } from "@gcpe/auth";
import { createDb } from "@gcpe/db-kit";
import { findUserByEmail, sessionUserFor } from "../../../apps/core/src/services/users";
import { startSmtpSink } from "../../../apps/distribution/test/smtp-sink";
import { sessionSecretFrom } from "../../../apps/stack/src/env";
import { startStack } from "../../../apps/stack/src/stack";
import { bcToday } from "./dates";
import { PLACEHOLDER_SUBSCRIBER, runStep, type CommandStep, type LocalApp } from "./local";
import { ScrubStepError } from "./private-out";
import { runSmoke, type SmokeCheck } from "./smoke";

export async function drainUntilIdle(o: { tick(): Promise<void>; pending(): Promise<{ pending: number; dead: number }>; maxTicks?: number }): Promise<number> {
  let quiet = 0;
  for (let i = 1; i <= (o.maxTicks ?? 300); i++) {
    await o.tick();
    const s = await o.pending();
    if (s.dead > 0) throw new ScrubStepError(`${s.dead} event deliveries failed for good`);
    quiet = s.pending === 0 ? quiet + 1 : 0;
    if (quiet >= 2) return i;
  }
  throw new ScrubStepError("events are still pending after the last tick");
}

export function replaySteps(urls: Record<LocalApp, string>): CommandStep[] {
  return [
    { name: "calendar-replay-to-nrms", npmArgs: ["run", "calendar:replay-to-nrms", "--", "--confirm"], env: { DATABASE_URL: urls.calendar, EVENT_SUBSCRIBERS: JSON.stringify([PLACEHOLDER_SUBSCRIBER("nrms", ["activity.updated"])]) } },
    { name: "nrms-replay-activity-links", npmArgs: ["run", "nrms:replay-activity-links", "--", "--confirm"], env: { DATABASE_URL: urls.nrms, EVENT_SUBSCRIBERS: JSON.stringify([PLACEHOLDER_SUBSCRIBER("calendar", ["release.status_changed"])]) } },
    { name: "news-api-search-backfill", npmArgs: ["run", "news-api:search-backfill", "--", "--confirm"], env: { DATABASE_URL: urls.newsApi } },
  ];
}

async function pendingDeliveries(urls: string[]): Promise<{ pending: number; dead: number }> {
  let pending = 0, dead = 0;
  for (const url of urls) {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      if ((await c.query<{ t: string | null }>("SELECT to_regclass('public.outbox_deliveries')::text AS t")).rows[0]!.t === null) continue;
      const r = (await c.query<{ p: number; d: number }>("SELECT count(*) FILTER (WHERE status = 'pending')::int AS p, count(*) FILTER (WHERE status = 'dead')::int AS d FROM outbox_deliveries")).rows[0]!;
      pending += r.p; dead += r.d;
    } finally {
      await c.end();
    }
  }
  return { pending, dead };
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createNetServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address() as AddressInfo; s.close(() => res(port)); });
  });
}

export interface TrialResult { ticks: number; smoke: SmokeCheck[] }

/** The whole stack, in process, on the scrubbed local databases: events delivered, replays run, then the smoke test. */
export async function runTrial(o: { urls: Record<LocalApp, string>; out: string; calendarUser: string; releaseUser: string; log(line: string): void }): Promise<TrialResult> {
  const dataDir = join(o.out, "trial-data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const secret = () => randomBytes(32).toString("hex");
  const adminPassword = secret(), stackSecret = secret(), tickToken = secret();
  const sink = await startSmtpSink();
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    PORT: String(port), TICK_TOKEN: tickToken, STACK_LOOPS: "false", UPDATES_HUB_ENABLED: "false", NODE_ENV: "test", DATA_DIR: dataDir,
    LOCAL_ADMIN_ENABLED: "true", LOCAL_ADMIN_USERNAME: "admin", LOCAL_ADMIN_PASSWORD_HASH: await hashPassword(adminPassword), LOCAL_AUTH_SECRET: secret(), STACK_EVENT_SECRET: stackSecret,
    CORE_DATABASE_URL: o.urls.core, NRMS_DATABASE_URL: o.urls.nrms, NEWSAPI_DATABASE_URL: o.urls.newsApi, CALENDAR_DATABASE_URL: o.urls.calendar,
    SITE_DATABASE_URL: o.urls.site, SITE_NEWS_API_URL: "self:/", SITE_OUTPUT_DIR: join(dataDir, "site-output"), SITE_PUBLIC_SITE_URL: "self:/site",
    NOD_DATABASE_URL: o.urls.nod, NOD_DISTRIBUTION_URL: "self:/distribution", NOD_PUBLIC_SITE_URL: "self:/site", NOD_MEMBERSHIP_API_USERNAME: "trial", NOD_MEMBERSHIP_API_PASSWORD_HASH: await hashPassword(secret()),
    DIST_DATABASE_URL: o.urls.distribution, DIST_SMTP_HOST: "127.0.0.1", DIST_SMTP_PORT: String(sink.port), DIST_SMTP_SECURE: "false", DIST_MAIL_FROM: "noreply@example.test", DIST_MAIL_REDIRECT_TO: "trial@example.test",
  };
  const handle = await startStack(env);
  const server = createServer(handle.app);
  await new Promise<void>((res) => server.listen(handle.port, "127.0.0.1", () => res()));
  const base = `http://127.0.0.1:${handle.port}`;
  const quietly = async (fn: () => unknown) => { try { await fn(); } catch { /* shutting down: the next close still runs */ } };
  try {
    const tick = async () => { const r = await fetch(`${base}/stack/tick`, { method: "POST", headers: { authorization: `Bearer ${tickToken}` } }); if (!r.ok) throw new ScrubStepError(`a tick answered HTTP ${r.status}`); };
    const pending = () => pendingDeliveries(Object.values(o.urls));
    const tokenRes = await fetch(`${base}/core/auth/local/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: adminPassword }) });
    const token = ((await tokenRes.json()) as { access_token?: string }).access_token;
    if (!token) throw new ScrubStepError("the trial stack refused its own admin sign-in");
    const rep = await fetch(`${base}/core/api/admin/republish`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    if (rep.status !== 202) throw new ScrubStepError(`Core's republish answered HTTP ${rep.status}`);
    let ticks = await drainUntilIdle({ tick, pending });
    o.log(`Delivered Core's republish in ${ticks} ticks.`);
    for (const s of replaySteps(o.urls)) {
      const code = await runStep(s, join(o.out, "logs", `${s.name}.log`));
      if (code !== 0) throw new ScrubStepError(`${s.name} exited ${code}: see logs/${s.name}.log`);
    }
    ticks += await drainUntilIdle({ tick, pending });
    const { db, pool } = createDb(o.urls.core);
    let calendarCookie: string, releaseCookie: string;
    try {
      const cookieFor = async (email: string) => {
        const found = await findUserByEmail(db, email);
        const user = found && (await sessionUserFor(db, found.id));
        if (!user) throw new ScrubStepError(`test account ${email} is missing or inactive`);
        return `${SESSION_COOKIE}=${(await mintSession(sessionSecretFrom(stackSecret), user)).token}`;
      };
      calendarCookie = await cookieFor(o.calendarUser);
      releaseCookie = await cookieFor(o.releaseUser);
    } finally {
      await pool.end();
    }
    return { ticks, smoke: await runSmoke({ base, calendarCookie, releaseCookie, today: bcToday() }) };
  } finally {
    for (const c of handle.closeBeforeServer) await quietly(() => c.close());
    await new Promise<void>((res) => { server.closeAllConnections(); server.close(() => res()); });
    for (const c of handle.closers) await quietly(() => c.close());
    await quietly(() => sink.close());
  }
}
```

If `startStack` reports a missing setting, copy that setting's value shape from `tests/e2e/global-setup.ts`'s env, keep it fictional, and add it here.

- [ ] **Step 4: Run to verify they pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run tests/scrub/smoke.test.ts tests/scrub/trial.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check and commit**

```bash
npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json
git add scripts/lib/scrub/smoke.ts scripts/lib/scrub/trial.ts tests/scrub/smoke.test.ts tests/scrub/trial.test.ts
git commit -m "scrub: smoke test and local trial"
```

---

### Task 12: boxs.ca scripts, dump, upload and restore

**Files:**
- Create: `scripts/lib/scrub/boxs.ts`
- Test: `tests/scrub/boxs.test.ts`

**Interfaces:**
- Consumes: `LocalApp` (Task 10), `ScrubArgumentError`/`ScrubStepError` (Task 1).
- Produces:
  - `BOXS_ENV_FILE`
  - `BOXS_APPS: readonly { app: string; envVar: string; local: LocalApp; replaced: boolean }[]`
  - `STAMP_RE`
  - `DROP_MINE_SQL`
  - `DUMP_FILTER_SED: string[]` (sed arguments)
  - `unsafeDumpLine(line: string): string | null`
  - `testAccountsScript(): string`
  - `backupScript(stamp: string): string`
  - `restoreScript(o: { stamp: string; from: "scrub-load" | "backups"; apps: string[]; resetNodPositions: boolean; siteOutput: "clear" | "restore" }): string`
  - `tickScript(site: string, times: number): string`
  - `runRemote(host: string, script: string, o?: { capture?: boolean }): Promise<string>`
  - `uploadFile(host: string, localPath: string, stamp: string, name: string): Promise<void>`
  - `downloadBackup(host: string, stamp: string, localFile: string): Promise<void>`
  - `localDump(url: string, outFile: string): Promise<void>` (plain SQL, gzip, refuses unsafe lines)

- [ ] **Step 1: Write the failing tests**

The restore test runs the real drop SQL, filter and `psql --single-transaction` against two local test databases, so a failed restore is proven to leave the old data.

```ts
// tests/scrub/boxs.test.ts
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";
import { backupScript, BOXS_APPS, DROP_MINE_SQL, DUMP_FILTER_SED, restoreScript, testAccountsScript, tickScript, unsafeDumpLine } from "../../scripts/lib/scrub/boxs";

describe("remote scripts", () => {
  const scripts = [testAccountsScript(), backupScript("20261022-120000"), restoreScript({ stamp: "20261022-120000", from: "scrub-load", apps: ["core", "nrms"], resetNodPositions: true, siteOutput: "clear" }), tickScript("https://boxs.ca", 3)];

  it("fail fast, stay private and never trace or dump settings", () => {
    for (const s of scripts) {
      expect(s).toMatch(/^set -euo pipefail\numask 077\n/);
      expect(s).not.toMatch(/set -x|printenv|^env$|echo "\$u"|cat "\$ENV_FILE"/m);
    }
  });

  it("refuses bad stamps, apps and sites", () => {
    expect(() => backupScript("2026; rm -rf ~")).toThrow();
    expect(() => restoreScript({ stamp: "20261022-120000", from: "scrub-load", apps: ["core; id"], resetNodPositions: false, siteOutput: "clear" })).toThrow();
    expect(() => tickScript("https://boxs.ca/$(id)", 1)).toThrow();
  });

  it("backs up all seven databases and restores only the ones asked for", () => {
    const b = backupScript("20261022-120000");
    for (const a of BOXS_APPS) expect(b).toContain(`${a.app}:${a.envVar}`);
    const r = restoreScript({ stamp: "20261022-120000", from: "scrub-load", apps: ["core"], resetNodPositions: true, siteOutput: "clear" });
    expect(r).toContain("restore_one core CORE_DATABASE_URL");
    expect(r).not.toContain("restore_one nod");
    expect(r).toContain("DELETE FROM inbox_positions WHERE source IN ('core', 'nrms')");
  });

  it("flags dump lines it can't restore on boxs.ca", () => {
    expect(unsafeDumpLine("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;")).toMatch(/extension/);
    expect(unsafeDumpLine("\\connect other")).toMatch(/connect/);
    expect(unsafeDumpLine("CREATE TABLE public.users (")).toBeNull();
  });
});

describe("drop-mine restore on local Postgres", () => {
  const MIG = join(resolve(import.meta.dirname, "..", ".."), "apps", "core", "migrations");
  let a: TestDatabase, b: TestDatabase;
  beforeAll(async () => { [a, b] = await Promise.all([createTestDatabase({ migrationsFolder: MIG }), createTestDatabase({ migrationsFolder: MIG })]); });
  afterAll(async () => { await Promise.all([a?.drop(), b?.drop()]); });
  const run = async (url: string, text: string) => { const c = new pg.Client({ connectionString: url }); await c.connect(); try { return (await c.query(text)).rows; } finally { await c.end(); } };
  const restore = (dump: string, extra = "") => {
    const dir = mkdtempSync(join(tmpdir(), "scrub-restore-"));
    writeFileSync(join(dir, "drop.sql"), DROP_MINE_SQL);
    writeFileSync(join(dir, "dump.sql"), dump + extra);
    return spawnSync("bash", ["-c", `set -o pipefail; { cat drop.sql; sed ${DUMP_FILTER_SED.map((x) => `'${x}'`).join(" ")} dump.sql; } | psql "$U" -X -q -v ON_ERROR_STOP=1 --single-transaction -f - >/dev/null`], { cwd: dir, env: { ...process.env, U: b.url } });
  };

  it("replaces every table and leaves the old data when the restore fails", async () => {
    await run(a.url, "INSERT INTO users (email, display_name) VALUES ('alex.ashfield@example.test', 'Alex Ashfield')");
    await run(b.url, "INSERT INTO users (email, display_name) VALUES ('old@example.test', 'Old Row')");
    const dump = spawnSync("pg_dump", ["--format=plain", "--no-owner", "--no-acl", `--dbname=${a.url}`], { encoding: "utf8" }).stdout;
    expect(restore(dump, "\nSELECT 1/0;\n").status).not.toBe(0);
    expect((await run(b.url, "SELECT email FROM users")).map((r) => r.email)).toEqual(["old@example.test"]);
    expect(restore(dump).status).toBe(0);
    expect((await run(b.url, "SELECT email FROM users")).map((r) => r.email)).toEqual(["alex.ashfield@example.test"]);
    expect((await run(b.url, "SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name IN ('public', 'information_schema', 'drizzle')"))[0].n).toBe(3);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run tests/scrub/boxs.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// scripts/lib/scrub/boxs.ts
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type { LocalApp } from "./local";
import { ScrubArgumentError, ScrubStepError } from "./private-out";

/** Where SiteGround keeps the Node app's settings. Read only inside a subshell, never printed. */
export const BOXS_ENV_FILE = "$HOME/www/boxs.ca/public_html/.nodeapp/.env-local";

export const BOXS_APPS: readonly { app: string; envVar: string; local: LocalApp; replaced: boolean }[] = [
  { app: "core", envVar: "CORE_DATABASE_URL", local: "core", replaced: true },
  { app: "nrms", envVar: "NRMS_DATABASE_URL", local: "nrms", replaced: true },
  { app: "news-api", envVar: "NEWSAPI_DATABASE_URL", local: "newsApi", replaced: true },
  { app: "site", envVar: "SITE_DATABASE_URL", local: "site", replaced: true },
  { app: "calendar", envVar: "CALENDAR_DATABASE_URL", local: "calendar", replaced: true },
  { app: "nod", envVar: "NOD_DATABASE_URL", local: "nod", replaced: false },
  { app: "distribution", envVar: "DIST_DATABASE_URL", local: "distribution", replaced: false },
];
export const STAMP_RE = /^\d{8}-\d{6}$/;

const stampOk = (stamp: string) => { if (!STAMP_RE.test(stamp)) throw new ScrubArgumentError("a stamp is YYYYMMDD-HHMMSS"); return stamp; };
const appOf = (name: string) => { const a = BOXS_APPS.find((x) => x.app === name); if (!a) throw new ScrubArgumentError("unknown app"); return a; };

const PRELUDE = [
  "set -euo pipefail",
  "umask 077",
  `ENV_FILE="${BOXS_ENV_FILE}"`,
  '[ -r "$ENV_FILE" ] || { echo "cannot read the stack settings file" >&2; exit 1; }',
  'url_of() { ( set -a; . "$ENV_FILE" >/dev/null 2>&1; set +a; v="${!1:-}"; [ -n "$v" ] || { echo "$1 is not set" >&2; exit 1; }; printf "%s" "$v" ); }',
].join("\n");

/**
 * Drops what this database's own user owns: tables, views, sequences, types, functions and any
 * schema other than public and the system ones. On boxs.ca `public` belongs to another role; on a
 * local superuser it doesn't, and neither does information_schema, so both are excluded by name.
 */
export const DROP_MINE_SQL = `DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT n.nspname FROM pg_namespace n WHERE pg_get_userbyid(n.nspowner) = current_user AND n.nspname NOT IN ('public', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%' LOOP
    EXECUTE format('DROP SCHEMA %I CASCADE', r.nspname);
  END LOOP;
  FOR r IN SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) = current_user AND c.relkind IN ('r', 'p', 'v', 'm', 'f') LOOP
    EXECUTE format('DROP %s IF EXISTS public.%I CASCADE', CASE r.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END, r.relname);
  END LOOP;
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'S' AND pg_get_userbyid(c.relowner) = current_user LOOP
    EXECUTE format('DROP SEQUENCE IF EXISTS public.%I CASCADE', r.relname);
  END LOOP;
  FOR r IN SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd', 'c') AND pg_get_userbyid(t.typowner) = current_user AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.reltype = t.oid) LOOP
    EXECUTE format('DROP TYPE IF EXISTS public.%I CASCADE', r.typname);
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) = current_user LOOP
    EXECUTE 'DROP ROUTINE IF EXISTS ' || r.sig || ' CASCADE';
  END LOOP;
END $$;
`;

/** Lines a plain dump may carry about the shared `public` schema, which boxs.ca's user doesn't own. */
export const DUMP_FILTER_SED = ["-e", "/^COMMENT ON SCHEMA public IS /d", "-e", "/^CREATE SCHEMA public;$/d", "-e", "/^ALTER SCHEMA public OWNER TO /d"];

export function unsafeDumpLine(line: string): string | null {
  if (/^CREATE EXTENSION /.test(line)) return "an extension boxs.ca can't create";
  if (/^\\connect\b/.test(line)) return "a \\connect to another database";
  return null;
}

export function testAccountsScript(): string {
  const q = "WITH a AS (SELECT * FROM users WHERE password_hash IS NOT NULL OR entra_oid IS NOT NULL) SELECT json_build_object("
    + "'users', coalesce((SELECT json_agg(json_build_object('id', id, 'email', email, 'display_name', display_name, 'is_active', is_active, 'sign_in_method', sign_in_method, 'password_hash', password_hash, 'entra_oid', entra_oid, 'created_at', created_at, 'updated_at', updated_at) ORDER BY email) FROM a), '[]'::json), "
    + "'roleGrants', coalesce((SELECT json_agg(json_build_object('user_id', g.user_id, 'role', g.role, 'granted_at', g.granted_at) ORDER BY g.user_id, g.role) FROM role_grants g JOIN a ON a.id = g.user_id), '[]'::json), "
    + "'memberships', coalesce((SELECT json_agg(json_build_object('user_id', uo.user_id, 'org_key', o.key, 'org_abbreviation', o.abbreviation) ORDER BY uo.user_id, o.key) FROM user_organizations uo JOIN a ON a.id = uo.user_id JOIN organizations o ON o.id = uo.organization_id), '[]'::json))";
  return [PRELUDE, `psql "$(url_of CORE_DATABASE_URL)" -X -A -t -q -v ON_ERROR_STOP=1 -c "${q}"`, ""].join("\n");
}

export function backupScript(stamp: string): string {
  stampOk(stamp);
  return [
    PRELUDE,
    `DIR="$HOME/gcpe-data/backups/${stamp}"`,
    'mkdir -p "$DIR"',
    `for pair in ${BOXS_APPS.map((a) => `${a.app}:${a.envVar}`).join(" ")}; do`,
    '  app="${pair%%:*}"; var="${pair#*:}"',
    '  pg_dump --format=plain --no-owner --no-acl --dbname="$(url_of "$var")" | gzip > "$DIR/$app.sql.gz"',
    '  echo "dumped $app"',
    "done",
    'tar -C "$HOME/gcpe-data" -czf "$DIR/site-output.tar.gz" site-output',
    'echo "backup size (KB): $(du -sk "$DIR" | cut -f1)"',
    "",
  ].join("\n");
}

export function restoreScript(o: { stamp: string; from: "scrub-load" | "backups"; apps: string[]; resetNodPositions: boolean; siteOutput: "clear" | "restore" }): string {
  stampOk(o.stamp);
  const apps = o.apps.map(appOf);
  const sed = DUMP_FILTER_SED.map((x) => `'${x}'`).join(" ");
  return [
    PRELUDE,
    `SRC="$HOME/gcpe-data/${o.from}/${o.stamp}"`,
    'DROP_SQL="$(mktemp)"',
    "trap 'rm -f \"$DROP_SQL\"' EXIT",
    "cat > \"$DROP_SQL\" <<'DROPSQL'",
    DROP_MINE_SQL.trimEnd(),
    "DROPSQL",
    "restore_one() {",
    '  local app="$1" var="$2" u',
    '  u="$(url_of "$var")"',
    '  [ -s "$SRC/$app.sql.gz" ] || { echo "missing $app.sql.gz" >&2; exit 1; }',
    `  { cat "$DROP_SQL"; gunzip -c "$SRC/$app.sql.gz" | sed ${sed}; } | psql "$u" -X -q -v ON_ERROR_STOP=1 --single-transaction -f - >/dev/null`,
    '  echo "restored $app"',
    "}",
    ...apps.map((a) => `restore_one ${a.app} ${a.envVar}`),
    ...(o.resetNodPositions ? [`psql "$(url_of NOD_DATABASE_URL)" -X -q -v ON_ERROR_STOP=1 -c "DELETE FROM inbox_positions WHERE source IN ('core', 'nrms')" >/dev/null`, 'echo "cleared NoD positions for core and nrms"'] : []),
    ...(o.siteOutput === "clear"
      ? ['mkdir -p "$HOME/gcpe-data/site-output"', 'find "$HOME/gcpe-data/site-output" -mindepth 1 -delete', 'echo "cleared site-output: the site rebuilds on start"']
      : ['[ -s "$SRC/site-output.tar.gz" ] || { echo "missing site-output.tar.gz" >&2; exit 1; }', 'rm -rf "$HOME/gcpe-data/site-output"', 'tar -C "$HOME/gcpe-data" -xzf "$SRC/site-output.tar.gz"', 'echo "restored site-output"']),
    "",
  ].join("\n");
}

export function tickScript(site: string, times: number): string {
  if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(site)) throw new ScrubArgumentError("--site must be an https origin");
  return [PRELUDE, `for i in $(seq 1 ${Math.max(1, Math.trunc(times))}); do`, `  curl -fsS -X POST -H "Authorization: Bearer $(cat "$HOME/.gcpe-tick-token")" "${site}/stack/tick" >/dev/null`, "  sleep 5", "done", 'echo "ticked"', ""].join("\n");
}

export async function runRemote(host: string, script: string, o: { capture?: boolean } = {}): Promise<string> {
  return new Promise((res, rej) => {
    const child = spawn("ssh", ["-o", "BatchMode=yes", host, "bash", "-s"], { stdio: ["pipe", o.capture ? "pipe" : "inherit", "inherit"] });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    child.on("error", rej);
    child.on("exit", (code) => (code === 0 ? res(out) : rej(new ScrubStepError(`a step on ${host} failed (exit ${code})`))));
    child.stdin!.end(script);
  });
}

export async function uploadFile(host: string, localPath: string, stamp: string, name: string): Promise<void> {
  stampOk(stamp);
  if (!/^[a-z-]+\.sql\.gz$/.test(name)) throw new ScrubArgumentError("upload names are <app>.sql.gz");
  const child = spawn("ssh", ["-o", "BatchMode=yes", host, `umask 077; mkdir -p "$HOME/gcpe-data/scrub-load/${stamp}" && cat > "$HOME/gcpe-data/scrub-load/${stamp}/${name}"`], { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise<void>((res, rej) => { child.on("error", rej); child.on("exit", (code) => (code === 0 ? res() : rej(new ScrubStepError(`uploading ${name} failed (exit ${code})`)))); });
  await pipeline(createReadStream(localPath), child.stdin!);
  await done;
}

export async function downloadBackup(host: string, stamp: string, localFile: string): Promise<void> {
  stampOk(stamp);
  mkdirSync(dirname(localFile), { recursive: true, mode: 0o700 });
  const child = spawn("ssh", ["-o", "BatchMode=yes", host, `tar -C "$HOME/gcpe-data/backups" -cf - ${stamp}`], { stdio: ["ignore", "pipe", "inherit"] });
  const done = new Promise<void>((res, rej) => { child.on("error", rej); child.on("exit", (code) => (code === 0 ? res() : rej(new ScrubStepError(`downloading the backup failed (exit ${code})`)))); });
  await pipeline(child.stdout!, createWriteStream(localFile, { mode: 0o600 }));
  await done;
}

/** A plain-SQL dump, gzipped, after checking it holds nothing boxs.ca's user can't restore. */
export async function localDump(url: string, outFile: string): Promise<void> {
  mkdirSync(dirname(outFile), { recursive: true, mode: 0o700 });
  const child = spawn("pg_dump", ["--format=plain", "--no-owner", "--no-acl", `--dbname=${url}`], { stdio: ["ignore", "pipe", "inherit"] });
  const done = new Promise<void>((res, rej) => { child.on("error", rej); child.on("exit", (code) => (code === 0 ? res() : rej(new ScrubStepError(`pg_dump failed (exit ${code})`)))); });
  const gzip = createGzip();
  const written = pipeline(gzip, createWriteStream(outFile, { mode: 0o600 }));
  for await (const line of createInterface({ input: child.stdout!, crlfDelay: Infinity })) {
    const why = unsafeDumpLine(line);
    if (why) { child.kill(); gzip.destroy(); throw new ScrubStepError(`the dump holds ${why}`); }
    if (!gzip.write(`${line}\n`)) await new Promise((r) => gzip.once("drain", r));
  }
  gzip.end();
  await Promise.all([done, written]);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run tests/scrub/boxs.test.ts`
Expected: PASS.
- If the local `pg_dump` emits `COMMENT ON SCHEMA public` in another shape, widen `DUMP_FILTER_SED` and keep the test.
- Nothing here contacts boxs.ca.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/scrub/boxs.ts tests/scrub/boxs.test.ts
git commit -m "scrub: boxs.ca backup, restore and transfer"
```

---

### Task 13: The pipeline, the undo command and the npm scripts

**Files:**
- Create: `scripts/scrub-test-data.ts`, `scripts/scrub-test-data-restore.ts`
- Modify:
  - `scripts/siteground-env.ts`: add `export` to `async function promptHidden` and to `class Prompter`.
  - `package.json`: add the scripts `"scrub:test-data": "tsx scripts/scrub-test-data.ts"` and `"scrub:test-data:restore": "tsx scripts/scrub-test-data-restore.ts"` after `"search:spot-check"`.
- Test: `tests/scrub/pipeline.test.ts`

**Interfaces:**
- Consumes: every earlier task.
- Produces:
  - `interface GateOutcome { passed: boolean; lines: string[] }`
  - `interface ScrubSummary { weeks: number; people: number; lines: string[] }`
  - `interface PipelineDeps { copy; scrub; gate1; importAll; gate2(label); trial; approve(lines); backup; load(backupStamp); log }`
  - `type PipelineOutcome`
  - `runPipeline(stopAfter: Step, d: PipelineDeps): Promise<PipelineOutcome>`
  - `parseRestoreArgs(argv): { stamp: string; sshHost: string; site: string }`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/scrub/pipeline.test.ts
import { describe, expect, it } from "vitest";
import type { Step } from "../../scripts/lib/scrub/args";
import { parseRestoreArgs } from "../../scripts/scrub-test-data-restore";
import { runPipeline, type PipelineDeps } from "../../scripts/scrub-test-data";

function deps(over: Partial<PipelineDeps> = {}): { d: PipelineDeps; calls: string[] } {
  const calls: string[] = [];
  const pass = { passed: true, lines: [] };
  const d: PipelineDeps = {
    copy: async () => { calls.push("copy"); },
    scrub: async () => { calls.push("scrub"); return { weeks: 3, people: 2, lines: ["3 weeks"] }; },
    gate1: async () => { calls.push("gate1"); return pass; },
    importAll: async () => { calls.push("import"); },
    gate2: async (label) => { calls.push(`gate2:${label}`); return pass; },
    trial: async () => { calls.push("trial"); return { ticks: 4, smoke: [{ name: "calendar list", ok: true, detail: "12" }] }; },
    approve: async () => { calls.push("approve"); return true; },
    backup: async () => { calls.push("backup"); return "20261022-120000"; },
    load: async (s) => { calls.push(`load:${s}`); return [{ name: "public home page", ok: true, detail: "ok" }]; },
    log: () => {},
    ...over,
  };
  return { d, calls };
}

describe("runPipeline", () => {
  it("runs every step in order", async () => {
    const { d, calls } = deps();
    expect(await runPipeline("load", d)).toEqual({ status: "done", at: "load" });
    expect(calls).toEqual(["copy", "scrub", "gate1", "import", "gate2:after import", "trial", "gate2:after trial", "approve", "backup", "load:20261022-120000"]);
  });

  it("stops at the first failed gate", async () => {
    const { d, calls } = deps({ gate1: async () => ({ passed: false, lines: ["calendar.Activity.Comments name: 1"] }) });
    expect(await runPipeline("load", d)).toEqual({ status: "failed", at: "gate1", reason: "the SQL Server leak check found hits" });
    expect(calls).toEqual(["copy", "scrub"]);
  });

  it("stops when the trial's smoke test fails", async () => {
    const { d, calls } = deps({ trial: async () => ({ ticks: 1, smoke: [{ name: "look ahead pdf", ok: false, detail: "not a PDF" }] }) });
    expect((await runPipeline("load", d)).status).toBe("failed");
    expect(calls).not.toContain("approve");
  });

  it.each<[Step, string]>([["copy", "copy"], ["gate1", "gate1"], ["trial", "gate2:after trial"]])("stops after %s when asked", async (step, last) => {
    const { d, calls } = deps();
    expect(await runPipeline(step, d)).toEqual({ status: "stopped", at: step });
    expect(calls[calls.length - 1]).toBe(last);
  });

  it("never touches boxs.ca without approval", async () => {
    const { d, calls } = deps({ approve: async () => false });
    expect(await runPipeline("load", d)).toEqual({ status: "failed", at: "approve", reason: "not approved" });
    expect(calls).not.toContain("backup");
  });
});

describe("parseRestoreArgs", () => {
  it("takes a stamp and optional host and site", () => {
    expect(parseRestoreArgs(["20261022-120000"])).toEqual({ stamp: "20261022-120000", sshHost: "boxs", site: "https://boxs.ca" });
    expect(() => parseRestoreArgs([])).toThrow(/stamp/);
    expect(() => parseRestoreArgs(["latest"])).toThrow(/stamp/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run tests/scrub/pipeline.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the pipeline**

`scripts/scrub-test-data.ts` (the shebang is the file's first line):

```ts
#!/usr/bin/env -S node --
// Scrubbed legacy test data for boxs.ca (docs/deploy/siteground.md, "Refreshing test data from a
// legacy backup"). Restores a legacy backup as a *_Scrubbed copy, pseudonymises people, keeps only
// ended non-confidential activities and published releases, shifts calendar dates, checks for
// leaks on SQL Server and Postgres, imports and trials it locally, then, after typed approval,
// backs up boxs.ca and replaces its calendar, release and public-site data.
//
// Usage: npm run scrub:test-data -- --backup /backup/<file>.bak --out ~/gcpe-parity-private/scrub [--stop-after trial]
// Everything real stays under --out. It prints step names, table and column names and counts only.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { safeErrorLabel } from "@gcpe/http-kit";
import { Prompter } from "./siteground-env";
import { parseScrubArgs, STEPS, type Step } from "./lib/scrub/args";
import { BOXS_APPS, backupScript, downloadBackup, localDump, restoreScript, runRemote, testAccountsScript, tickScript, uploadFile } from "./lib/scrub/boxs";
import { bcToday, wallClockOf } from "./lib/scrub/dates";
import { importSteps, legacyEnv, parseTestAccounts, recreateLocalDbs, runStep, seedTestAccounts, signInEmails, type LocalApp, type TestAccounts } from "./lib/scrub/local";
import { applyScope, assertRequiredTables, emptyTables, mssqlConfigFromEnv, openPool, restoreScrubCopy, shiftCalendarDates, tableCounts } from "./lib/scrub/mssql";
import { gateMssql, readPeopleSources, scrubAllText, writeStructuredPeople, type GateResult } from "./lib/scrub/mssql-text";
import { buildPeopleIndex, mappingCsv, type PeopleIndex } from "./lib/scrub/people";
import { gatePostgres } from "./lib/scrub/pg-gate";
import { loadOrCreateKey, preparePrivateDir, runStamp, ScrubArgumentError, ScrubStepError, withPrivateUmask, writePrivate } from "./lib/scrub/private-out";
import { loginWithPassword, runSmoke, stackHealthy, waitFor, type SmokeCheck } from "./lib/scrub/smoke";
import { runTrial, type TrialResult } from "./lib/scrub/trial";

export interface GateOutcome { passed: boolean; lines: string[] }
export interface ScrubSummary { weeks: number; people: number; lines: string[] }
export interface PipelineDeps {
  copy(): Promise<void>;
  scrub(): Promise<ScrubSummary>;
  gate1(): Promise<GateOutcome>;
  importAll(): Promise<void>;
  gate2(label: string): Promise<GateOutcome>;
  trial(): Promise<TrialResult>;
  approve(lines: string[]): Promise<boolean>;
  backup(): Promise<string>;
  load(backupStamp: string): Promise<SmokeCheck[]>;
  log(line: string): void;
}
export type PipelineOutcome = { status: "done" | "stopped"; at: Step } | { status: "failed"; at: Step; reason: string };

export async function runPipeline(stopAfter: Step, d: PipelineDeps): Promise<PipelineOutcome> {
  const stop = (s: Step) => STEPS.indexOf(s) >= STEPS.indexOf(stopAfter);
  const lines: string[] = [];
  const gate = (o: GateOutcome, at: Step, what: string): PipelineOutcome | null => {
    for (const l of o.lines) d.log(`  ${l}`);
    lines.push(`${what}: ${o.passed ? "passed" : "FAILED"}`);
    return o.passed ? null : { status: "failed", at, reason: `the ${what} found hits` };
  };
  await d.copy();
  if (stop("copy")) return { status: "stopped", at: "copy" };
  const summary = await d.scrub();
  lines.push(...summary.lines, `date offset: ${summary.weeks} weeks`, `people pseudonymised: ${summary.people}`);
  if (stop("scrub")) return { status: "stopped", at: "scrub" };
  const g1 = gate(await d.gate1(), "gate1", "SQL Server leak check");
  if (g1) return g1;
  if (stop("gate1")) return { status: "stopped", at: "gate1" };
  await d.importAll();
  if (stop("import")) return { status: "stopped", at: "import" };
  const g2 = gate(await d.gate2("after import"), "gate2", "Postgres leak check");
  if (g2) return g2;
  if (stop("gate2")) return { status: "stopped", at: "gate2" };
  const trial = await d.trial();
  for (const c of trial.smoke) d.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
  if (!trial.smoke.every((c) => c.ok)) return { status: "failed", at: "trial", reason: "the local smoke test failed" };
  const g3 = gate(await d.gate2("after trial"), "trial", "Postgres leak check after the trial");
  if (g3) return g3;
  lines.push(`local trial: ${trial.ticks} ticks, smoke test passed`);
  if (stop("trial")) return { status: "stopped", at: "trial" };
  if (!(await d.approve(lines))) return { status: "failed", at: "approve", reason: "not approved" };
  const backupStamp = await d.backup();
  d.log(`boxs.ca backup: ${backupStamp} (undo with npm run scrub:test-data:restore -- ${backupStamp})`);
  if (stop("backup")) return { status: "stopped", at: "backup" };
  const smoke = await d.load(backupStamp);
  for (const c of smoke) d.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
  return smoke.every((c) => c.ok) ? { status: "done", at: "load" } : { status: "failed", at: "load", reason: `the boxs.ca smoke test failed: undo with npm run scrub:test-data:restore -- ${backupStamp}` };
}

const gateLines = (g: GateResult) => g.hits.map((h) => `${h.table}.${h.column} ${h.kind}: ${h.count}`);

async function main(): Promise<void> {
  const opts = parseScrubArgs(process.argv.slice(2));
  const stamp = runStamp();
  const out = preparePrivateDir(join(opts.out, stamp));
  const key = loadOrCreateKey(opts.keyFile);
  const cfg = mssqlConfigFromEnv();
  const refUtc = new Date();
  const refWall = wallClockOf(refUtc, "America/Vancouver");
  const host = new URL(opts.site).host;
  const prompt = new Prompter();
  const log = (line: string) => console.log(line);
  let index: PeopleIndex | null = null;
  let accounts: TestAccounts | null = null;
  let urls: Record<LocalApp, string> | null = null;
  const need = <T>(v: T | null, what: string): T => { if (v === null) throw new ScrubStepError(`${what} isn't ready: run the earlier steps first`); return v; };
  const scrubPool = () => openPool(cfg, opts.scrubbedDb);
  const pgDbs = () => (["core", "nrms", "newsApi", "site", "calendar"] as const).map((k) => ({ name: k, url: need(urls, "the local databases")[k] }));

  const deps: PipelineDeps = {
    log,
    async copy() {
      const master = await openPool(cfg, "master");
      try { await restoreScrubCopy(master, opts.backup, opts.scrubbedDb); } finally { await master.close(); }
      log(`Restored the backup as ${opts.scrubbedDb}.`);
    },
    async scrub() {
      accounts = parseTestAccounts(await runRemote(opts.sshHost, testAccountsScript(), { capture: true }));
      writePrivate(join(out, "test-accounts.json"), JSON.stringify(accounts));
      log(`Downloaded ${accounts.users.length} test accounts from ${host}.`);
      const pool = await scrubPool();
      try {
        await assertRequiredTables(pool);
        const before = await tableCounts(pool);
        index = buildPeopleIndex(await readPeopleSources(pool), key, signInEmails(accounts));
        writePrivate(join(out, "mapping.csv"), mappingCsv(index));
        await applyScope(pool, refUtc, refWall);
        const emptied = await emptyTables(pool);
        const structured = await writeStructuredPeople(pool, index);
        const text = await scrubAllText(pool, { index, key }, log);
        writePrivate(join(out, "reports", "text-scrub.json"), JSON.stringify(text, null, 2));
        const dates = await shiftCalendarDates(pool, refWall, opts.leadDays);
        const after = await tableCounts(pool);
        const kept = (t: string) => `${t}: ${after[t] ?? 0} of ${before[t] ?? 0} kept`;
        return {
          weeks: dates.weeks,
          people: index.persons.length,
          lines: [kept("calendar.Activity"), kept("dbo.NewsRelease"), kept("calendar.Log"), kept("dbo.NewsReleaseLog"), `tables emptied: ${emptied.length}`, `people rows rewritten: ${structured}`, `log dates shifted: ${dates.logText.shifted}, left as they were: ${dates.logText.unparsed}`],
        };
      } finally {
        await pool.close();
      }
    },
    async gate1() {
      const pool = await scrubPool();
      try {
        const g = await gateMssql(pool, need(index, "the people list"));
        writePrivate(join(out, "reports", "gate1.json"), JSON.stringify(g, null, 2));
        return { passed: g.hits.length === 0, lines: gateLines(g) };
      } finally {
        await pool.close();
      }
    },
    async importAll() {
      urls = await recreateLocalDbs();
      const steps = importSteps(urls, legacyEnv(cfg, opts.scrubbedDb), { out, cutoff: opts.calendarCutoff });
      const run = async (i: number) => {
        const s = steps[i]!;
        log(`Importing ${s.name}…`);
        const code = await runStep(s, join(out, "logs", `import-${s.name}.log`));
        if (code !== 0) throw new ScrubStepError(`the ${s.name} import exited ${code}: see logs/import-${s.name}.log under the run folder`);
      };
      await run(0);
      const seeded = await seedTestAccounts(urls.core, need(accounts, "the test accounts"));
      log(`Seeded ${seeded.users} test accounts.`);
      for (let i = 1; i < steps.length; i++) await run(i);
    },
    async gate2(label) {
      const g = await gatePostgres(pgDbs(), need(index, "the people list"), { coreUrl: need(urls, "the local databases").core, signInAllowed: signInEmails(need(accounts, "the test accounts")) });
      writePrivate(join(out, "reports", `gate2-${label.replace(/\W+/g, "-")}.json`), JSON.stringify(g, null, 2));
      return { passed: g.hits.length === 0 && g.signInProblems === 0, lines: [...gateLines(g), ...(g.signInProblems ? [`users who could sign in but aren't test accounts: ${g.signInProblems}`] : [])] };
    },
    async trial() {
      return runTrial({ urls: need(urls, "the local databases"), out, calendarUser: opts.calendarUser, releaseUser: opts.releaseUser, log });
    },
    async approve(lines) {
      for (const l of lines) log(l);
      const answer = await prompt.plain(`Type "load ${host}" to back up ${host} and replace its calendar, release and public-site data`, "");
      return answer === `load ${host}`;
    },
    async backup() {
      const b = runStamp();
      await runRemote(opts.sshHost, backupScript(b));
      await downloadBackup(opts.sshHost, b, join(out, `boxs-backup-${b}.tar`));
      return b;
    },
    async load(backupStamp) {
      const local = need(urls, "the local databases");
      const replaced = BOXS_APPS.filter((a) => a.replaced);
      for (const a of replaced) {
        const file = join(out, "dumps", `${a.app}.sql.gz`);
        await localDump(local[a.local], file);
        await uploadFile(opts.sshHost, file, stamp, `${a.app}.sql.gz`);
        log(`Uploaded ${a.app}.`);
      }
      await prompt.plain(`Stop the ${host} Node.js app in Site Tools (Devs → Node.js), then press Enter`, "");
      if (!(await waitFor(async () => !(await stackHealthy(opts.site)), { timeoutMs: 300_000, everyMs: 5_000 }))) throw new ScrubStepError(`${host} still answers: stop it in Site Tools first. Nothing was replaced; backup ${backupStamp} is ready`);
      await runRemote(opts.sshHost, restoreScript({ stamp, from: "scrub-load", apps: replaced.map((a) => a.app), resetNodPositions: true, siteOutput: "clear" }));
      await prompt.plain(`Start the ${host} Node.js app in Site Tools, then press Enter`, "");
      if (!(await waitFor(() => stackHealthy(opts.site), { timeoutMs: 600_000, everyMs: 10_000 }))) throw new ScrubStepError(`${host} isn't healthy: undo with npm run scrub:test-data:restore -- ${backupStamp}`);
      const adminUser = await prompt.plain("Break-glass admin user name", "admin");
      const tokenRes = await fetch(`${opts.site}/nrms/auth/local/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: adminUser, password: await prompt.hidden("Break-glass admin password: ") }) });
      const token = ((await tokenRes.json()) as { access_token?: string }).access_token;
      if (!token) throw new ScrubStepError("the break-glass sign-in failed");
      for (const path of ["/core/api/admin/republish", "/nrms/api/media-lists/republish"]) {
        const r = await fetch(`${opts.site}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
        if (!r.ok) throw new ScrubStepError(`${path} answered HTTP ${r.status}`);
      }
      await runRemote(opts.sshHost, tickScript(opts.site, 6));
      const calendarCookie = await loginWithPassword(opts.site, opts.calendarUser, await prompt.hidden(`Password for ${opts.calendarUser}: `));
      const releaseCookie = await loginWithPassword(opts.site, opts.releaseUser, await prompt.hidden(`Password for ${opts.releaseUser}: `));
      return runSmoke({ base: opts.site, calendarCookie, releaseCookie, today: bcToday() });
    },
  };

  try {
    const outcome = await withPrivateUmask(() => runPipeline(opts.stopAfter, deps));
    if (outcome.status === "failed") { console.error(`Stopped at ${outcome.at}: ${outcome.reason}.`); process.exitCode = 1; }
    else console.log(outcome.status === "done" ? `Loaded ${host}. Run folder: ${out}` : `Stopped after ${outcome.at}, as asked. Run folder: ${out}`);
  } finally {
    prompt.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (e) {
    console.error(e instanceof ScrubArgumentError || e instanceof ScrubStepError ? e.message : safeErrorLabel(e));
    process.exitCode = 1;
  }
}
```

- [ ] **Step 4: Implement the undo command**

`scripts/scrub-test-data-restore.ts`:

```ts
#!/usr/bin/env -S node --
// Undoes a scrub:test-data load: restores all seven boxs.ca databases and site-output from the
// backup the load took (~/gcpe-data/backups/<stamp> on boxs.ca). The operator stops and starts the
// app in Site Tools when asked; the command checks /stack/health each time.
//
// Usage: npm run scrub:test-data:restore -- <stamp> [--ssh-host boxs] [--site https://boxs.ca]
import { pathToFileURL } from "node:url";
import { safeErrorLabel } from "@gcpe/http-kit";
import { Prompter } from "./siteground-env";
import { BOXS_APPS, restoreScript, runRemote, STAMP_RE } from "./lib/scrub/boxs";
import { ScrubArgumentError, ScrubStepError } from "./lib/scrub/private-out";
import { stackHealthy, waitFor } from "./lib/scrub/smoke";

export function parseRestoreArgs(argv: string[]): { stamp: string; sshHost: string; site: string } {
  let stamp: string | undefined;
  let sshHost = "boxs";
  let site = "https://boxs.ca";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--ssh-host") sshHost = argv[++i] ?? "";
    else if (a === "--site") site = (argv[++i] ?? "").replace(/\/+$/, "");
    else if (!a.startsWith("--") && stamp === undefined) stamp = a;
    else throw new ScrubArgumentError(`Unknown argument: ${a}`);
  }
  if (!stamp || !STAMP_RE.test(stamp)) throw new ScrubArgumentError("give the backup's stamp, YYYYMMDD-HHMMSS, as the load printed it");
  if (!/^[A-Za-z0-9._-]+$/.test(sshHost)) throw new ScrubArgumentError("--ssh-host must be an ssh host alias");
  if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(site)) throw new ScrubArgumentError("--site must be an https origin");
  return { stamp, sshHost, site };
}

async function main(): Promise<void> {
  const o = parseRestoreArgs(process.argv.slice(2));
  const host = new URL(o.site).host;
  const prompt = new Prompter();
  try {
    if ((await prompt.plain(`Type "restore ${o.stamp}" to put ${host} back as it was at that backup`, "")) !== `restore ${o.stamp}`) throw new ScrubStepError("not confirmed: nothing changed");
    await prompt.plain(`Stop the ${host} Node.js app in Site Tools, then press Enter`, "");
    if (!(await waitFor(async () => !(await stackHealthy(o.site)), { timeoutMs: 300_000, everyMs: 5_000 }))) throw new ScrubStepError(`${host} still answers: stop it in Site Tools first. Nothing changed`);
    await runRemote(o.sshHost, restoreScript({ stamp: o.stamp, from: "backups", apps: BOXS_APPS.map((a) => a.app), resetNodPositions: false, siteOutput: "restore" }));
    await prompt.plain(`Start the ${host} Node.js app in Site Tools, then press Enter`, "");
    if (!(await waitFor(() => stackHealthy(o.site), { timeoutMs: 600_000, everyMs: 10_000 }))) throw new ScrubStepError(`${host} isn't healthy after the restore: check /hub/error-log`);
    console.log(`Restored ${host} from backup ${o.stamp}.`);
  } finally {
    prompt.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (e) {
    console.error(e instanceof ScrubArgumentError || e instanceof ScrubStepError ? e.message : safeErrorLabel(e));
    process.exitCode = 1;
  }
}
```

- [ ] **Step 5: Export the prompt helpers and add the npm scripts**

In `scripts/siteground-env.ts`, change `async function promptHidden(` to `export async function promptHidden(` and `class Prompter {` to `export class Prompter {`. Nothing else in that file changes. Then add the two `package.json` scripts listed under Files.

- [ ] **Step 6: Run the tests and the type checks**

Run:
```bash
npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run tests/scrub tests/siteground-env.test.ts
npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json
npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p apps/staff-web/tsconfig.json
```
Expected: PASS (SQL Server blocks skipped without the password); both type checks clean.

- [ ] **Step 7: Check the CLIs refuse a bad command line without touching anything**

Run: `npx -y -p node@24 -- npm run scrub:test-data -- --backup relative.bak --out /tmp/x`
Expected: exit 1, printing only "--backup must be an absolute .bak path …".

Run: `npx -y -p node@24 -- npm run scrub:test-data:restore -- latest`
Expected: exit 1, printing only the stamp message.

- [ ] **Step 8: Commit**

```bash
git add scripts/scrub-test-data.ts scripts/scrub-test-data-restore.ts scripts/siteground-env.ts package.json tests/scrub/pipeline.test.ts
git commit -m "scrub: pipeline, undo command and npm scripts"
```

---

### Task 14: Runbook, running notes and the UAT list

**Files:**
- Modify: `docs/deploy/siteground.md`: a new section "Refreshing test data from a legacy backup", inserted before "## Calendar access (Phase 5a)".
- Modify: `docs/manuals/running-notes.md`: one **Operations** line under a new heading `## Scrubbed test data`.

- [ ] **Step 1: Write the runbook section**

Plain English, short sentences, no task labels. It must cover, in this order:

1. **What it does and doesn't send.**
   - The spec §3 table, condensed: kept, replaced, removed.
   - Real data never leaves the Mac.
   - NoD, Distribution, settings, test accounts and the mail redirect are kept.
2. **Before you start.**
   - The importers must run clean against the backup: see the Prerequisites.
   - Node 24.
   - The SQL Server container running, with the backup in `~/gcpe-parity-private/legacy/`, which SQL Server sees as `/backup/`.
   - `ssh boxs` works.
   - Check Site Tools' storage meter has room for the dump sizes the run prints.
3. **Running it.**

   ```sh
   set -a; . ~/gcpe-parity-private/mssql.env; set +a
   LEGACY_SQL_SERVER=127.0.0.1 LEGACY_SQL_USER=sa LEGACY_SQL_PASSWORD="$MSSQL_SA_PASSWORD" LEGACY_SQL_TRUST_CERT=true \
     npx -y -p node@24 -- npm run scrub:test-data -- --backup /backup/<file>.bak --out ~/gcpe-parity-private/scrub --stop-after trial
   ```

   - The first run uses `--stop-after trial`. The second, full run omits it.
   - The run folder lists `mapping.csv`, `reports/`, `logs/` and `dumps/`. All of it is private; never copy any of it out.
4. **The gates.**
   - What Gate 1 and Gate 2 search: names (two routes), any email not at `example.test`, any phone not `250-555-01NN`/`555-01NN`, and users who could sign in but aren't test accounts.
   - The pass condition is zero.
   - The printed lines name table, column and kind only. Row ids are in `reports/gate*.json`.
   - What to do on a hit: read the private report, fix the rule, re-run. Never hand-edit the copy.
5. **Approval and load.**
   - The typed phrase.
   - The backup at `~/gcpe-data/backups/<stamp>/`, with a copy in the run folder.
   - The two Site Tools pauses: stop, then start. Each is confirmed by `/stack/health`.
   - Clearing NoD's positions, Core's republish, the media-lists republish, the ticks, and the smoke prompts for three passwords.
   - The public site rebuilds every page from empty, at about 200 pages a tick: about four hours for legacy volume. The home page and latest posts come first.
6. **Undo.** `npm run scrub:test-data:restore -- <stamp>`, with the same two Site Tools pauses.
7. **Known limits.**
   - Names of people in no legacy table aren't found.
   - Middle initials ("Jane Q. Doe") aren't matched.
   - Single-word names in people tables are left in structured columns that aren't user rows.
   - Phone numbers in public releases (e.g. 1-800 lines) are replaced too.
   - Created and last-updated stamps move with the offset, and can land a few days in the future.
   - The old test media list stays in NoD without an NRMS counterpart.
8. **UAT rows to re-point after a load.** The list from "Verified while planning §3" above, one line each.

- [ ] **Step 2: Add the running-notes line**

```markdown
## Scrubbed test data

- **Operations** — boxs.ca's calendar, releases and public site can be refreshed from a legacy backup with `npm run scrub:test-data` (see "Refreshing test data from a legacy backup" in docs/deploy/siteground.md). People are fictional, only ended non-confidential activities and published releases are kept, and calendar dates move forward so the coming weeks have activities. Test accounts, subscribers and settings stay. After a refresh, re-check the UAT rows the runbook lists; `npm run scrub:test-data:restore -- <stamp>` puts the previous data back.
```

- [ ] **Step 3: Check the docs carry no real values and no labels**

Run: `git diff -- docs | grep -nE '@(gov\.bc\.ca|gov\.example)|Task [0-9]|D[1-5]\b'`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add docs/deploy/siteground.md docs/manuals/running-notes.md
git commit -m "docs: refreshing boxs.ca test data from a scrubbed legacy backup"
```

---

### Task 15: First real run (controller only, not a subagent)

This task handles real data and changes boxs.ca. The controller runs it under the Global Constraints' data rules. Replies and commits carry counts, table names and stamps only.

- [ ] **Step 1: Confirm the prerequisites.** `origin/main` has the Core and NRMS importer fixes, and this branch is rebased on it. If not, stop and report.
- [ ] **Step 2: Run the whole suite once**, with the SQL Server password set. Expected: every scrub test passes, none skipped.
- [ ] **Step 3: Local-only run:** `--stop-after trial`. Expected:
  - Gate 1 and both Gate 2 runs pass.
  - All four smoke checks pass.
  - The printed kept-counts are plausible: activities of the 81,018 with `EndDateTime` before now and not confidential; releases of the 44,043 that are published, active and past.
  - Record `pg_database_size` of the five replaced `scrub_*` databases. A run stopped after the trial makes no dumps, so this is the size estimate.
- [ ] **Step 4: Paul checks Site Tools' storage meter** against those sizes, plus one backup (about 70 MB today).
- [ ] **Step 5: Full run.** Paul types the approval and does the two Site Tools pauses. Expected: the boxs.ca smoke test passes. Record the backup stamp in the private run folder and in the reply.
- [ ] **Step 6: Spot-check boxs.ca by hand:**
  - the calendar list shows activities in the coming weeks;
  - the Look Ahead PDF;
  - a release page under `/site/releases/<key>/` once the queue reaches it;
  - `/hub/error-log` is clean.
- [ ] **Step 7: Update the decisions spreadsheet and Carolynn's re-pointing note** (Paul's files, outside the repo), and the parity open-questions list if a new question came up.

---

## Self-review

- **Spec coverage:**
  - §2 D1–D5 → Tasks 4, 6/7, 5/7, 10/13 and 12/13.
  - §3 table → Task 6's scope SQL and emptied tables (Task 7).
  - §4.1–4.3 → Tasks 3, 4 and 8.
  - §4.5 → Tasks 1 and 13 (`mapping.csv` via `writePrivate`).
  - §5 → Tasks 5 and 7.
  - §6 steps 1–10 → Tasks 7, 8, 8, 10, 9, 11, 13, 12/13, 12/13 and 13.
  - §7 → the tests in Tasks 2–5, 7–9 and 11–13; the fixture skips with a message.
  - §8 → "Verified while planning".
  - §9 → Task 14.
- **Placeholder scan:** no TBD, "similar to" or "add appropriate…". Two steps name a fallback if the local environment disagrees: Task 9's `ctid` paging (checked: `tid > tid` works on the local Postgres 14) and Task 11's stack settings. Each states the exact replacement.
- **Type consistency:**
  - `PeopleIndex`, `bySource` keys `${source}:${id}`, `FakeIdentity`, `GateResult`/`GateHit`, `CommandStep`, `LocalApp`, `SmokeCheck`, `TrialResult` and `PipelineDeps` match across Tasks 3–13.
  - `BOXS_APPS[].local` uses the `LocalApp` keys (`newsApi`).
- **Review Focus:** all five lines have a pinned test, in Tasks 2, 4, 7 and 8.
