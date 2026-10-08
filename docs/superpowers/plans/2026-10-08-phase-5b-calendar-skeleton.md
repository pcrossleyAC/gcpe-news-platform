# Phase 5b-1: Calendar App Skeleton, Event Contracts, Public Organizations and Lookup Admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new `apps/calendar` app, mounted by the stack at `/calendar`, holds the whole Calendar schema of spec §5.2, keeps projections of Core's organizations, terms and users, re-derives every caller's Calendar role, ministries and HQ membership from those projections on every request, and serves a generic lookup admin (with legacy's SysAdmin lock-down) that staff use end to end on boxs.ca. `packages/events` gains the `activity.*` and `release.status_changed` contracts. Core organizations gain `isPublic`, so GCPE Headquarters and GCPE Media Relations disappear from the public News API and the subscribe page (Q54).

**Architecture:**
- **Contracts (`packages/events`):** `activity.created`/`activity.updated` as a discriminated union on `isConfidential` (the confidential form is `.strict()` and id-only, so a producer can't leak text), `activity.deleted`, `release.status_changed`, and `isPublic` on `org.upserted` (defaulted to `true`, so old envelopes stay public).
- **Core:** `organizations.is_public`, optional on input like `isHq`, set false only on create for GCPEHQ and GCPEMEDIA by the seed and the legacy importer; a Core.Admin switch `PUT /core/api/organizations/:key/public` and a "Public" column on the Organizations screen.
- **Consumers of `isPublic`:** the News API stores it and hides non-public ministries from `/api/Ministries` and the ministry and minister lookups; NoD upserts a non-public organization's list as inactive, so it is neither offered nor subscribable.
- **`apps/calendar`:** Express, Drizzle, zod, its own database. One migration `0000_init` from drizzle-kit, holding every §5.2 table plus the event tables. The receiver applies Core's `org.*`, `sector.*`, `theme.*`, `tag.*` and `user.upserted` to `orgs`, `terms` and `users`. Every `/api` request runs `requireCalendarActor`, which reads the caller's row from `users` and their HQ membership from `orgs`; the session cookie's roles are never trusted. A dispatch worker is wired for the outbox, though nothing emits yet.
- **Stack:** prefix `CALENDAR`, Core → Calendar route with an explicit type list, mount at `/calendar`, a `calendar.dispatch` tick step, health and `--check` entries, and the stack-wide login limiter. All of it applies only when `CALENDAR_DATABASE_URL` is set; otherwise `/calendar` answers 503 and nothing routes to it.
- **Lookup admin:** one registry of the eleven lookups, one service using `sql.identifier`, one router; Administrators see every lookup, SysAdmin-only lookups are read-only below SysAdmin, as legacy.
- **staff-web:** a "Calendar" nav item for any Calendar role, a Calendar section whose screens read `GET /calendar/api/me`, and the lookup screens at `/hub/calendar/lookups[/:name]`.

**Tech Stack:** Node 24, TypeScript 5.9 strict, Express 5, Drizzle 0.45 / drizzle-kit 0.31, zod 3.25, Vitest 4.1, supertest, React 19 + react-router 7 (library mode), `@bcgov/design-system-react-components`, axe-core, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-07-calendar-parity-design.md`:
- §1–§3 (row 5b and its exit check);
- §5.1 App, §5.2 Tables, §5.3 Lookup admin, §5.4 Events;
- §6 (the schema must support `visible()`; the function itself is 5c's);
- §13 volumes (lookup sizes: cities 330, keywords 336, government representatives 335);
- §14–§17 for the rows this plan adds.

Also `docs/superpowers/plans/phase-5-carry-forward.md` (every 5b item that this plan takes is named in "Carry-forward items taken" below) and the 5a plan `docs/superpowers/plans/2026-10-07-phase-5a-core-calendar-roles.md`, whose `packages/auth` Calendar roles, `user.upserted`, `org.upserted` with `isHq` and Core calendar-access API this plan consumes.

**Companion plan:** `docs/superpowers/plans/2026-10-08-phase-5b2-calendar-users-and-report-spike.md` (5b-2: the Calendar users screen, Core's active and link routes for Calendar Administrators, Calendar test users, and the report-rendering spike). **This plan (5b-1) comes first.** 5b-2's Tasks 1–4 need this plan's app, projections and Calendar section; its spike task needs nothing from either plan and may run any time after this plan is deployed.

**Base:**
- **Branch:** `feat/phase-5b` in `/Users/paul/gcpe-news-platform-p5b`, stacked on `feat/phase-5` (5a finished) at `e4dbf50`. Every path below is repo-relative.
- **Line numbers** are against `e4dbf50`. Re-find by symbol if anything moved.
- **Migrations:** Core's last is `0002_calendar_access`, the News API's `0001_post_origin`. The Calendar's first is `0000_init`. Re-check each `migrations/meta/_journal.json` before generating.

**What the code does today** (`e4dbf50`, verified by reading):
- `orgRecordSchema` carries `isHq` (default false) but nothing like `isPublic` (`packages/events/src/catalogue.ts:20-49`).
- The News API lists every ministry Core sends (`apps/news-api/src/read.ts:35-43`); NoD lists every one as a subscribable list (`apps/nod/src/lists.ts:28-31`, `publicListItems`).
- `HQ_SEED_ORGANIZATIONS` creates GCPE Headquarters and GCPE Media Relations with `isHq: true` (`scripts/lib/public-taxonomy.ts:268-301`); `hqOnlyOnCreate` drops `isHq` for an existing organization (`:312-318`); the importer passes `isHqOnCreate` (`apps/core/src/import/run.ts:46`).
- The stack mounts six apps (`apps/stack/src/stack.ts:266-271`), lists Core's subscribers explicitly by type (`apps/stack/src/env.ts`, `INTERNAL_EVENT_ROUTES`), and runs the reference-data backfill only for NoD (`stack.ts:512-521`).
- No dead-letter page exists anywhere (grep for `dead-letter|deadLetter|DeadLetter` finds only `packages/events`).
- `requireBearer` accepts the staff session cookie and sets `req.auth = { subject: session.id, roles: session.roles, … }` with roles minted at sign-in (`packages/auth/src/bearer.ts:52-66`). Core re-derives them per request (`apps/core/src/app.ts:16-34`); no other app does.

---

## Decisions made in planning

Paul is unavailable and authorised autonomous work. Each decision says why and what it costs if wrong. Task 9 writes the parity rows they create.

- **D1. Split 5b in two; 5b-1 first.** 5b's scope (contracts, Q54, the app, stack wiring, lookups, users screen, Core routes, test users, spike) is about 15 right-sized tasks. 5b-1 ends at the first half of the exit check (lookup admin end to end on boxs.ca, event contract tests); 5b-2 adds the users screen and the spike report. *If wrong:* one extra plan review; nothing in 5b-1 depends on 5b-2.
- **D2. The Calendar names ministries and terms by Core key, not by Core id.** Spec §5.2 says "Core ids", but events name organizations and terms only by key (5a R4, `organizationKeys`). Columns are `contact_ministry_key`, `ministry_key`, `term_key`. *If wrong:* a Core key rename would orphan Calendar references; Core has no key rename today, and the same holds for NRMS and NoD.
- **D3. No foreign keys to projection tables** (`orgs`, `terms`, `users`); Calendar-owned tables (lookups, activities, joins) do reference each other. Projections fill asynchronously and the 5i importer writes activities independently of event delivery. *If wrong:* a dangling key is possible; readers left-join and 5c's validation refuses unknown keys on save.
- **D4. Every legacy-id table uses `integer GENERATED BY DEFAULT AS IDENTITY`.** Explicit legacy ids insert; 5i re-bases each sequence above the imported maximum (spec §12.1). *If wrong:* nothing visible; a missed re-base would make the first new row collide, which 5i's test catches.
- **D5. `isPublic` lives on Core's organization and `org.upserted`** (spec parent §3.1: Core owns reference data; two consumers need it). It is optional on input exactly like `isHq`: omitted keeps the stored flag, a new organization defaults to public, and the seed and the importer set it false only when they create GCPEHQ or GCPEMEDIA (C124's create-only rule). A Core.Admin flips it on Hub → Organizations. *If wrong:* moving it into the News API later is one column there; Core's flag would simply be unused.
- **D6. boxs.ca's two existing GCPE organizations are set non-public by hand once** (runbook step), not by a data migration: a migration would hard-code BC abbreviations into a tenant-neutral schema, and production imports create them fresh. *If wrong:* one manual click per test site.
- **D7. The News API stores `is_public` on `categories` (migration `0002`) and hides non-public ministries from `/api/Ministries`, `/api/Ministries/:key` and the minister lookup (404).** NoD upserts a non-public organization's list with `active = isActive && isPublic`, which removes it from the subscribe page and from `activeListKeys`. *If wrong:* NoD staff see the two GCPE lists as inactive in Lists and categories; harmless.
- **D8. Per-request grant re-check (carry-forward).** `requireCalendarActor` reads the caller's `users` row on every `/api` request: missing, inactive or role-less is 403 `no Calendar access`. Roles in the session cookie are ignored. *If wrong:* one indexed primary-key read per request; measured as negligible at 471 users.
- **D9. HQ(u) counts an HQ organization whether or not it is active** (Q56's working assumption, the same rule as Core's grant checks). A test pins it so a later change has to touch both places (carry-forward Q56). *If wrong:* a retired HQ organization keeps granting reach until removed from users; Q56 stays open for the business.
- **D10. Bearer tokens (break-glass, service tokens) have no Calendar access.** Their subject is not a projected user. Said in the runbook (carry-forward "Break-glass").
- **D11. The stack mounts the Calendar only when `CALENDAR_DATABASE_URL` is set.** boxs.ca needs a seventh database created by hand in Site Tools, which no script can do (the database user can't `CREATE DATABASE`). Unset: `/calendar` answers 503 `calendar not configured`, Core routes nothing to it, `/stack/health` and `--check` leave it out (with a warning). *If wrong:* a production deployment could start without the Calendar unnoticed; the Phase 7 cutover checklist gets a running-notes line, and `--check` prints the skip.
- **D12. Deferred from 5b:** the Calendar dead-letter page and the lock-expiry sweep (5c, when the Calendar first emits and locks exist), the `calendar` tenant config section (5c, its first consumer), `CALENDAR_STORAGE_DIR` (5e, attachments), Transfer and the deactivation preview of open activities (5c, they need activities and `visible()`). The dispatch tick step is wired now. Task 9 writes these into the carry-forward file.
- **D13. Lookup admin semantics.** Administrators (L ≥ 4) see every lookup; the seven locked ones are read-only below SysAdmin, as legacy showed the grid without edit buttons (`ListDetails.aspx.cs:34-70`). Rows are added, renamed (with their extra fields), deactivated or reactivated, and reordered; **never deleted**, because activities reference them (C162, Proposed). A new or renamed active row may not repeat another active row's name in the same lookup, case-insensitively (409). Name and extra-field limits are legacy's column sizes. Reorder posts the full id list and gets 409 when the set changed. Edits are last-write-wins (rare, low-stakes admin data). Write refusals are 403 (admin data, not activity data; §6's 404 rule is about activities).
- **D14. The staff-web Calendar section** is shown for any `Calendar.*` role in the session, and its screens read `GET /calendar/api/me`, the projection's view, so a revoked grant shows as "no Calendar access" without signing out. Calendar Administrators keep landing on Hub → Calendar access (5a's e2e pins that); any other Calendar-only user lands on `/hub/calendar`.
- **D15. The standalone Calendar listens on port 3007**, the next free one (Core 3001 … NRMS 3006).
- **D16. Contract field names.** `activity.*` uses camelCase names of §5.4's list (`startAt`, `contactMinistryKey`, `sharedMinistryKeys`, `categoryNames`, `cityName`, `themeKeys`, `tagKeys`, `sectorKeys`, `translations`); dates are nullable because legacy's are (`Activity.sql` `StartDateTime NULL`). `release.status_changed` names "English headline" `headline` and lets `key` be null (a draft has no key). Release types and statuses mirror `packages/nrms-contract`, kept equal by a test. *If wrong:* 5c and 5h are the first producers; renaming before then is free.
- **D17. Lookup `name` is `NOT NULL`;** 5i maps a legacy NULL name to `""` (legacy junk rows stay as they are, spec §5.2). Recorded in the carry-forward for 5i.

## Carry-forward items taken

From `docs/superpowers/plans/phase-5-carry-forward.md` § 5b. Task 9 deletes these items; 5b-2 takes the rest.

| Item | Where |
|---|---|
| Calendar subscriber in Core's subscribers, then republish | Task 6 (route, backfill trigger), Task 9 (runbook) |
| User projection; HQ from the org projection; missing user has no access | Task 5 |
| The Calendar re-checks the grant per request | Task 5 (D8) |
| Q54 `isPublic` | Tasks 1–3 (D5–D7) |
| Q56 (Core and Calendar agree on HQ) | Task 5 (D9) |
| Break-glass has no Calendar access, in the runbook | Task 5 test, Task 9 runbook (D10) |
| Organisations screens never send `isHq` (or `isPublic`) in the general org PUT | Task 2 (the screen uses the two switch routes only) |

Left for 5b-2: Calendar users screen; Calendar test users. Left for later phases: Entra null-email matching (no Entra work in 5b).

## Global Constraints

- **Worktree and commits:**
  - Work on `feat/phase-5b` in `/Users/paul/gcpe-news-platform-p5b`. Commit locally after each task.
  - **Never add `Co-Authored-By` or any AI attribution** to a commit (project rule). Never commit `CLAUDE.md`.
  - **Code comments never carry task, round or ruling labels** ("Task 3", "D5", "fix round 1"). Say *why*, not *when*. Spec row ids (C124, Q54) are fine in comments. The spec's own R-decisions are cited by section ("spec addendum §5.3"), never as "R10".
- **Node 24 for everything** (BC's permanent UTC−7 from 2026-11-01 needs tzdata ≥ 2026b):
  - Tests: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run <paths>`.
  - Type-checks: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json` and `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p apps/staff-web/tsconfig.json`.
  - E2E: `npx -y -p node@24 -- npm run test:e2e`.
  - Show each new test failing before implementing it (a real RED run).
- **Migrations:** drizzle-kit only, run from the app folder: `cd apps/<app> && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name <name>`. Never hand-edit generated DDL. Additive only on existing apps.
- **Locks:** a write that reads then changes shared state takes, in this order, the aggregate's advisory lock (`pg_advisory_xact_lock`), then the row `FOR UPDATE`, then re-checks what it read before the lock (the `withLockedSubscriber` / `setCalendarAccess` pattern). Never take two aggregate locks in an unsorted order.
- **Logs:** errors are logged with `safeErrorLabel(e)` only, never the error, its message or a bound parameter. No debug logging is added.
- **Events:** subscriber lists name their types explicitly; never `"*"` on a new route. `enqueueEvent` validates every payload through `parseEvent`.
- **Privacy:** no real names or emails anywhere (code, tests, fixtures, docs, commits). Test data uses `example.test` or `x.invalid` and fictional names ("Robin Staff", "Kim Imported", "Sample keyword"). **Never copy a row of legacy data**, including lookup values; legacy files are read for structure only.
- **Server is the authority** (C140): every Calendar route checks the level on the server; staff-web only hides what the server would refuse.
- **Staff-web patterns (unchanged from 4f–5a):**
  - Calls go through `apiFetch` with same-origin paths (`/calendar/api/...`, `/core/api/...`). A load failure shows a danger `InlineAlert`.
  - Loads are guarded against out-of-order responses (a `latest` ref).
  - Each screen calls `useDocumentTitle` with its `h1` text, unconditionally. Title assertions use `await waitFor(() => expect(document.title).toBe(...))`.
  - Status messages use `role="status"`; errors use `role="alert"` next to the control that caused them.
  - Each new screen has an axe test (wcag2a/wcag2aa, no serious or critical).
  - **Browser code never imports `@gcpe/auth`.**
- **Copy:** role labels are legacy's ("Read Only", "Editor", "Advanced", "Administrator", "System Administrator"). "Ministries" is the Calendar's word for a user's organizations; "HQ organization" for `is_hq`; "Public" for `is_public`.

## Review Focus

1. **A Calendar user whose role is removed or who is deactivated while their session cookie is still valid.** Their next Calendar request is refused (403 `no Calendar access`), and the Calendar section says so, without waiting for the cookie to expire. Pinned in Task 5 ("a revoked grant takes effect on the next request, whatever the cookie says").
2. **A deploy to boxs.ca before anyone has created the seventh database.** The stack starts, every other app works, `/calendar/api/*` answers 503, `/stack/health` stays 200, and Core queues nothing for the Calendar. Pinned in Task 6 ("without CALENDAR_DATABASE_URL the stack starts and /calendar answers 503") and ("no Calendar route when the Calendar isn't configured").
3. **Two administrators changing the same lookup at once.** Two creates of the same name: exactly one succeeds, the other gets 409. A reorder against a list another admin just added to: 409, never a half-applied order. Pinned in Task 7 ("two concurrent creates of one name: exactly one wins") and ("a reorder whose id set is stale is refused and changes nothing").
4. **An `org.upserted` envelope stored before `isPublic` existed, replayed by Core's republish or a retry.** It parses as public; nothing is hidden by accident. Pinned in Task 1 ("an org.upserted without isPublic parses as public") and Task 3 ("a replayed old envelope keeps the ministry listed").
5. **A user's `user.upserted` arriving before the `org.upserted` of their HQ organization** (different aggregates, so no ordering between them). The user is not HQ until the organization arrives, then is, with no re-send. Pinned in Task 5 ("HQ follows the org projection, whichever event arrives first").

---

## File structure

| File | Responsibility |
|---|---|
| `packages/events/src/catalogue.ts` (+ `catalogue-calendar.test.ts`, `catalogue.test.ts`) | `isPublic` on orgs; `activity.*`; `release.status_changed`; release type and status mirrors |
| `apps/core/src/db/schema.ts` + `migrations/0003_org_public.sql` | `organizations.is_public` |
| `apps/core/src/services/organizations.ts` (+ test) | `NON_PUBLIC_ABBREVIATIONS`, optional `isPublic` input, `isPublicOnCreate`, `setOrganizationPublic` |
| `apps/core/src/http/routes.ts` (+ `routes.test.ts`) | `PUT /api/organizations/:key/public` |
| `apps/core/src/import/run.ts` | `isPublicOnCreate` |
| `scripts/lib/public-taxonomy.ts`, `scripts/seed-core-from-public-api.ts` (+ `tests/seed-core-from-public-api.test.ts`) | GCPE organizations created non-public; `flagsOnlyOnCreate` |
| `apps/staff-web/src/screens/admin/organizations/OrganizationsScreen.tsx` (+ test) | "Public" switch |
| `apps/news-api/src/db/schema.ts` + `migrations/0002_category_public.sql`, `src/projections.ts`, `src/read.ts` (+ test) | Hide non-public ministries |
| `apps/nod/src/lists.ts` (+ `lists.test.ts`) | Non-public organization's list inactive |
| `apps/calendar/package.json`, `drizzle.config.ts`, `Dockerfile` | App package |
| `apps/calendar/src/db/schema.ts` (+ `schema.test.ts`) + `migrations/0000_init.sql` | Every §5.2 table |
| `apps/calendar/src/start.ts`, `app.ts`, `main.ts`, `loop.ts` (+ `start.test.ts`) | Wiring |
| `apps/calendar/src/projections.ts` (+ test) | `orgs`, `terms`, `users` from Core; `needsReferenceData` |
| `apps/calendar/src/actor.ts` (+ `actor.test.ts`) | `loadCalendarActor`, `requireCalendarActor`, `requireLevel` |
| `apps/calendar/src/http/routes.ts` | `apiRoutes`: `/me`, lookups |
| `apps/calendar/src/lookups.ts`, `src/http/lookup-routes.ts` (+ tests) | Lookup registry, service, routes |
| `apps/calendar/test/helpers.ts` | Test database, signed events, session cookies |
| `apps/stack/src/env.ts`, `stack.ts`, `main.ts` (+ `env.test.ts`, `stack.test.ts`, `stack-check.test.ts`) | Mount and wiring |
| `scripts/siteground-env.ts`, `scripts/build-siteground.mjs` (+ `tests/siteground-env.test.ts`) | Seventh database |
| `tests/e2e/global-setup.ts`, `tests/e2e/calendar-lookups.spec.ts` | E2E |
| `apps/staff-web/src/screens/calendar/access.ts`, `useCalendarMe.ts`, `CalendarSection.tsx`, `CalendarHome.tsx`, `lookups/LookupsScreen.tsx`, `lookups/LookupScreen.tsx`, `lookups/types.ts` (+ tests, `a11y.test.tsx`) | Calendar section and lookup screens |
| `apps/staff-web/src/router.tsx`, `shell/AppShell.tsx`, `shell/HomeRedirect.tsx` (+ `AppShell.test.tsx`) | Routes, nav, landing |
| `docs/parity/*`, `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`, `docs/superpowers/plans/phase-5-carry-forward.md`, spec §5.2/§5.4 | Docs |

---

### Task 1: Event contracts: `activity.*`, `release.status_changed`, and `isPublic`

Covers spec §5.4, §16 "Event contracts" (producer side of the shapes), Q54's contract half, D16. Pure: no database.

**Files:**
- Modify: `packages/events/src/catalogue.ts`.
- Create: `packages/events/src/catalogue-calendar.test.ts`.
- Modify: `packages/events/src/catalogue.test.ts` (the `org` literal gains `isPublic`).
- Modify: every `OrgRecord` literal `tsc` names after Step 3 (add `isPublic: true`).

**Interfaces:**
- Produces (`@gcpe/events`):
  - `orgRecordSchema` gains `isPublic: z.boolean().default(true)`; `OrgRecord.isPublic: boolean`.
  - `releaseTypeSchema`, `releaseStatusSchema` (mirrors of `RELEASE_TYPES`, `RELEASE_STATUSES`).
  - `activityRecordSchema` (non-confidential, `isConfidential: false`), `confidentialActivitySchema` (`{ id, isConfidential: true, isDeleted }`, strict), `activityEventSchema` (their discriminated union); types `ActivityRecord`, `ConfidentialActivity`, `ActivityEvent`.
  - `activityDeletedSchema` (`{ id }`), `releaseStatusChangedSchema`, type `ReleaseStatusChanged`.
  - `eventDataSchemas` gains `activity.created`, `activity.updated`, `activity.deleted`, `release.status_changed`.

- [ ] **Step 1: Write the failing test**

`packages/events/src/catalogue-calendar.test.ts`:

```ts
import { describe, expect, it } from "vitest";
// Relative import: @gcpe/events doesn't depend on @gcpe/nrms-contract; this keeps the lists equal.
import { RELEASE_STATUSES, RELEASE_TYPES } from "../../nrms-contract/src/types";
import { parseEvent, releaseStatusSchema, releaseTypeSchema, type ActivityRecord, type ReleaseStatusChanged } from "./index";

const envelope = (type: string, data: unknown, aggregateId = "activity:4101") => ({
  id: "6f0d7f4e-8a51-4d39-9f42-2a4f4c1c0b11",
  type,
  version: 1,
  source: type.startsWith("release.") ? "nrms" : "calendar",
  aggregateId,
  sequence: 1,
  occurredAt: "2026-10-08T17:00:00Z",
  correlationId: "0b8f3f86-2d1e-4b59-9e0c-5d6f1b1c2a33",
  data,
});

const activity: ActivityRecord = {
  id: 4101,
  isConfidential: false,
  isDeleted: false,
  title: "Sample community announcement",
  details: "Fictional details for a contract test.",
  startAt: "2026-11-02T17:00:00Z",
  endAt: "2026-11-02T18:00:00Z",
  nrAt: null,
  isAllDay: false,
  isConfirmed: true,
  contactMinistryKey: "health",
  sharedMinistryKeys: ["finance"],
  categoryNames: ["Approved Release"],
  cityName: "Victoria",
  themeKeys: [],
  tagKeys: ["sample-tag"],
  sectorKeys: ["health"],
  translations: ["French"],
};

describe("activity.created / activity.updated", () => {
  it("accepts a non-confidential activity with every §5.4 field", () => {
    for (const type of ["activity.created", "activity.updated"]) expect(parseEvent(envelope(type, activity)).data).toEqual(activity);
  });

  it("accepts a confidential activity as id, flag and deletion only", () => {
    const confidential = { id: 4102, isConfidential: true, isDeleted: false };
    expect(parseEvent(envelope("activity.updated", confidential)).data).toEqual(confidential);
  });

  it("refuses a confidential activity that carries any text (spec addendum §5.4: no confidential text leaves the Calendar)", () => {
    expect(() => parseEvent(envelope("activity.updated", { id: 4102, isConfidential: true, isDeleted: false, title: "leak" }))).toThrow();
    expect(() => parseEvent(envelope("activity.updated", { ...activity, isConfidential: true }))).toThrow();
  });

  it("accepts legacy's missing dates and missing contact ministry, and refuses a non-integer id", () => {
    const undated = { ...activity, startAt: null, endAt: null, contactMinistryKey: null };
    expect(parseEvent(envelope("activity.created", undated)).data).toEqual(undated);
    expect(() => parseEvent(envelope("activity.created", { ...activity, id: "4101" }))).toThrow();
    expect(() => parseEvent(envelope("activity.created", { ...activity, id: 0 }))).toThrow();
  });

  it("activity.deleted carries only the id", () => {
    expect(parseEvent(envelope("activity.deleted", { id: 4101 })).data).toEqual({ id: 4101 });
    expect(() => parseEvent(envelope("activity.deleted", { id: 4101, title: "x" }))).toThrow();
  });
});

describe("release.status_changed", () => {
  const change: ReleaseStatusChanged = {
    releaseId: "8a7f3c1e-2b4d-4e6f-9a0b-1c2d3e4f5a6b",
    key: "2026HLTH0001-000001",
    reference: "NEWS-00001",
    type: "release",
    activityId: 4101,
    previousActivityId: null,
    status: "scheduled",
    publishAt: "2026-11-02T17:00:00Z",
    releasedAt: null,
    headline: "Sample headline",
  };

  it("accepts a status change linked to an activity", () => {
    expect(parseEvent(envelope("release.status_changed", change, `release:${change.releaseId}`)).data).toEqual(change);
  });

  it("accepts a draft with no key and a link moved away (previousActivityId set, activityId null)", () => {
    const moved = { ...change, key: null, reference: null, status: "draft", activityId: null, previousActivityId: 4101, publishAt: null };
    expect(parseEvent(envelope("release.status_changed", moved, `release:${change.releaseId}`)).data).toEqual(moved);
  });

  it("refuses an unknown status or type", () => {
    expect(() => parseEvent(envelope("release.status_changed", { ...change, status: "archived" }))).toThrow();
    expect(() => parseEvent(envelope("release.status_changed", { ...change, type: "newsletter" }))).toThrow();
  });

  it("names exactly packages/nrms-contract's release types and statuses", () => {
    expect(releaseTypeSchema.options).toEqual([...RELEASE_TYPES]);
    expect(releaseStatusSchema.options).toEqual([...RELEASE_STATUSES]);
  });
});
```

Add to `packages/events/src/catalogue.test.ts`, inside its top-level `describe` (the file already builds an `org` literal and an org envelope helper; reuse whatever it names them):

```ts
  it("an org.upserted without isPublic parses as public, so a replayed old envelope never hides an organization", () => {
    const { isPublic: _p, ...old } = org;
    const parsed = parseEvent({ ...orgEnvelope, data: old }).data as OrgRecord;
    expect(parsed.isPublic).toBe(true);
  });

  it("an org.upserted carries isPublic false through", () => {
    expect((parseEvent({ ...orgEnvelope, data: { ...org, isPublic: false } }).data as OrgRecord).isPublic).toBe(false);
  });
```

If the file has no shared envelope for orgs, define one next to `org`:

```ts
const orgEnvelope = {
  id: "6f0d7f4e-8a51-4d39-9f42-2a4f4c1c0b11",
  type: "org.upserted",
  version: 1,
  source: "core",
  aggregateId: "org:health",
  sequence: 1,
  occurredAt: "2026-10-08T17:00:00Z",
  correlationId: "0b8f3f86-2d1e-4b59-9e0c-5d6f1b1c2a33",
  data: org,
};
```

and add `isPublic: true,` to the `org` literal after `isHq`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/events/src/catalogue-calendar.test.ts packages/events/src/catalogue.test.ts`
Expected: FAIL. `releaseStatusSchema` and `releaseTypeSchema` aren't exported; `activity.*` and `release.status_changed` parse with untyped data, so the refusal cases don't throw; `isPublic` is stripped (undefined).

- [ ] **Step 3: Implement the contracts**

In `packages/events/src/catalogue.ts`, in `orgRecordSchema` after `isHq`:

```ts
  // Listed on public surfaces (the News API's ministries, the subscribe page). GCPE Headquarters
  // and GCPE Media Relations are not (Q54); the Office of the Premier is HQ but public, so this
  // is its own flag. Defaulted so an envelope stored before the flag existed stays public.
  isPublic: z.boolean().default(true),
```

After `userRecordSchema`, add:

```ts
/** NRMS's release types and statuses. Mirrors packages/nrms-contract (this package doesn't depend
 * on it); catalogue-calendar.test.ts keeps them equal. */
export const releaseTypeSchema = z.enum(["release", "story", "factsheet", "update", "advisory"]);
export const releaseStatusSchema = z.enum(["draft", "approved", "scheduled", "publishing", "published", "unpublishing", "failed", "deleted"]);

const activityId = z.number().int().positive();
const keyList = z.array(z.string().min(1));

/** Calendar → NRMS, for an activity that is not confidential (spec addendum §5.4). */
export const activityRecordSchema = z
  .object({
    id: activityId,
    isConfidential: z.literal(false),
    isDeleted: z.boolean(),
    title: z.string(),
    details: z.string(),
    // Legacy allows an activity without dates (calendar.Activity.StartDateTime is NULL-able).
    startAt: offsetDateTime.nullable(),
    endAt: offsetDateTime.nullable(),
    nrAt: offsetDateTime.nullable(),
    isAllDay: z.boolean(),
    isConfirmed: z.boolean(),
    contactMinistryKey: z.string().min(1).nullable(),
    sharedMinistryKeys: keyList,
    categoryNames: z.array(z.string()),
    cityName: z.string().nullable(),
    themeKeys: keyList,
    tagKeys: keyList,
    sectorKeys: keyList,
    translations: z.array(z.string()),
  })
  .strict();
export type ActivityRecord = z.infer<typeof activityRecordSchema>;

/** A confidential activity leaves the Calendar as these three fields and nothing else (spec
 * addendum §5.4, C127). Strict, so a producer that adds a field fails its own write. */
export const confidentialActivitySchema = z.object({ id: activityId, isConfidential: z.literal(true), isDeleted: z.boolean() }).strict();
export type ConfidentialActivity = z.infer<typeof confidentialActivitySchema>;

export const activityEventSchema = z.discriminatedUnion("isConfidential", [activityRecordSchema, confidentialActivitySchema]);
export type ActivityEvent = z.infer<typeof activityEventSchema>;

export const activityDeletedSchema = z.object({ id: activityId }).strict();

/** NRMS → Calendar at every release status write and every change of its activity link (spec
 * addendum §11). `previousActivityId` lets the Calendar drop a link that moved. */
export const releaseStatusChangedSchema = z
  .object({
    releaseId: z.string().uuid(),
    key: z.string().min(1).nullable(),
    reference: z.string().nullable(),
    type: releaseTypeSchema,
    activityId: activityId.nullable(),
    previousActivityId: activityId.nullable(),
    status: releaseStatusSchema,
    publishAt: offsetDateTime.nullable(),
    releasedAt: offsetDateTime.nullable(),
    headline: z.string().nullable(),
  })
  .strict();
export type ReleaseStatusChanged = z.infer<typeof releaseStatusChangedSchema>;
```

`offsetDateTime` is declared at `catalogue.ts:92`, above this point. In `eventDataSchemas`, after `"delivery.bounced"`:

```ts
  "activity.created": activityEventSchema,
  "activity.updated": activityEventSchema,
  "activity.deleted": activityDeletedSchema,
  "release.status_changed": releaseStatusChangedSchema,
```

- [ ] **Step 4: Fix `OrgRecord` literals**

Run: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
For each error "Property 'isPublic' is missing in type … OrgRecord", add `isPublic: true,` after that literal's `isHq`. Change nothing else. Re-run until clean. (Core's `toOrgRecord` is fixed in Task 2; if `tsc` names it here, add `isPublic: true,` for now; Task 2 replaces it with the column.)

- [ ] **Step 5: Run the tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/events`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/events apps packages scripts tests
git commit -m "feat(events): activity.* and release.status_changed contracts; isPublic on org.upserted"
```

---

### Task 2: Core: public organizations (Q54)

Covers carry-forward Q54 (Core half), D5, D6, and "never send `isHq` in the general org PUT".

**Files:**
- Modify: `apps/core/src/db/schema.ts` (`organizations.isPublic`); generate `apps/core/migrations/0003_org_public.sql`.
- Modify: `apps/core/src/services/organizations.ts` (+ `organizations.test.ts`).
- Modify: `apps/core/src/http/routes.ts` (+ `routes.test.ts`).
- Modify: `apps/core/src/import/run.ts`.
- Modify: `scripts/lib/public-taxonomy.ts`, `scripts/seed-core-from-public-api.ts` (+ `tests/seed-core-from-public-api.test.ts`).
- Modify: `apps/staff-web/src/screens/admin/organizations/OrganizationsScreen.tsx` (+ test), `apps/staff-web/src/screens/admin/calendar-access/CalendarAccessScreen.tsx` (`OrgOption` gains `isPublic`).

**Interfaces:**
- Consumes: `OrgRecord.isPublic` (Task 1).
- Produces:
  - `NON_PUBLIC_ABBREVIATIONS = ["GCPEHQ", "GCPEMEDIA"] as const`; `isNonPublicAbbreviation(abbreviation: string | null | undefined): boolean`.
  - `orgInputSchema` with optional `isPublic`; `upsertOrganization(db, input, subscribers, opts: { legacyId?; isHqOnCreate?; isPublicOnCreate? })`.
  - `setOrganizationPublic(db: Db, key: string, isPublic: boolean, subscribers: SubscriberConfig[]): Promise<OrgRecord | null>`.
  - `PUT /core/api/organizations/:key/public { isPublic: boolean }` (Core.Admin) → `OrgRecord` | 404.
  - `flagsOnlyOnCreate(input: OrgInput, exists: boolean): OrgInput` (replaces `hqOnlyOnCreate`).
  - staff-web `OrgOption.isPublic: boolean`.

- [ ] **Step 1: Write the failing service tests**

Append to `apps/core/src/services/organizations.test.ts` (it already creates a Core test database; reuse its `tdb` and `healthOrg` imports):

```ts
describe("isPublic (Q54)", () => {
  it("a new organization is public unless told otherwise; isPublicOnCreate applies only on create", async () => {
    const created = await upsertOrganization(tdb.db, { ...healthOrg, key: "pub-a" }, []);
    expect(created.record.isPublic).toBe(true);
    const gcpe = await upsertOrganization(tdb.db, { ...healthOrg, key: "pub-b", abbreviation: "GCPEHQ" }, [], { isPublicOnCreate: false });
    expect(gcpe.record.isPublic).toBe(false);
    // An existing organization keeps its flag whatever isPublicOnCreate says.
    await setOrganizationPublic(tdb.db, "pub-b", true, []);
    const again = await upsertOrganization(tdb.db, { ...healthOrg, key: "pub-b", abbreviation: "GCPEHQ", displayName: "Renamed" }, [], { isPublicOnCreate: false });
    expect(again.record.isPublic).toBe(true);
  });

  it("an upsert that omits isPublic keeps the stored flag; one that sends it sets it", async () => {
    await upsertOrganization(tdb.db, { ...healthOrg, key: "pub-c" }, []);
    await setOrganizationPublic(tdb.db, "pub-c", false, []);
    expect((await upsertOrganization(tdb.db, { ...healthOrg, key: "pub-c", displayName: "Renamed" }, [])).record.isPublic).toBe(false);
    expect((await upsertOrganization(tdb.db, { ...healthOrg, key: "pub-c", isPublic: true }, [])).record.isPublic).toBe(true);
  });

  it("setOrganizationPublic emits org.upserted only on a change, and 404s an unknown key", async () => {
    await upsertOrganization(tdb.db, { ...healthOrg, key: "pub-d" }, []);
    const subs: SubscriberConfig[] = [{ name: "x", url: "http://x/events", secret: "s", types: ["org.upserted"] }];
    const before = (await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, "org:pub-d"))).length;
    expect((await setOrganizationPublic(tdb.db, "pub-d", true, subs))!.isPublic).toBe(true);
    expect((await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, "org:pub-d"))).length).toBe(before);
    expect((await setOrganizationPublic(tdb.db, "pub-d", false, subs))!.isPublic).toBe(false);
    const after = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, "org:pub-d"));
    expect(after.length).toBe(before + 1);
    expect((after.at(-1)!.envelope as { data: OrgRecord }).data.isPublic).toBe(false);
    expect(await setOrganizationPublic(tdb.db, "no-such-org", false, subs)).toBeNull();
  });

  it("isNonPublicAbbreviation matches GCPEHQ and GCPEMEDIA, trimmed and case-insensitive, and not PREM", () => {
    expect(isNonPublicAbbreviation(" gcpehq ")).toBe(true);
    expect(isNonPublicAbbreviation("GCPEMEDIA")).toBe(true);
    expect(isNonPublicAbbreviation("PREM")).toBe(false);
    expect(isNonPublicAbbreviation(null)).toBe(false);
  });
});
```

Add to the file's imports what it lacks: `setOrganizationPublic`, `isNonPublicAbbreviation` from `./organizations`; `outboxEvents`, `type OrgRecord`, `type SubscriberConfig` from `@gcpe/events`; `eq` from `drizzle-orm`.

Append to `apps/core/src/http/routes.test.ts` (it builds an app with a Core.Admin bearer; reuse its helpers):

```ts
  it("PUT /api/organizations/:key/public is Core.Admin only and returns the record", async () => {
    await request(app).put("/api/organizations/health").set(adminAuth).send(healthOrg).expect(200);
    const res = await request(app).put("/api/organizations/health/public").set(adminAuth).send({ isPublic: false });
    expect(res.status).toBe(200);
    expect(res.body.isPublic).toBe(false);
    expect((await request(app).put("/api/organizations/health/public").set(editorAuth).send({ isPublic: true })).status).toBe(403);
    expect((await request(app).put("/api/organizations/no-such-org/public").set(adminAuth).send({ isPublic: true })).status).toBe(404);
    expect((await request(app).put("/api/organizations/health/public").set(adminAuth).send({ isPublic: "no" })).status).toBe(400);
  });
```

`adminAuth` and `editorAuth` stand for the header objects the file already uses for a Core.Admin and a non-admin bearer; use the file's own names.

Append to `tests/seed-core-from-public-api.test.ts`, in the describe that covers the HQ organizations:

```ts
  it("creates the two GCPE organizations non-public, and leaves both flags alone when they already exist", () => {
    for (const o of HQ_SEED_ORGANIZATIONS) expect(o).toMatchObject({ isHq: true, isPublic: false });
    const existing = flagsOnlyOnCreate(HQ_SEED_ORGANIZATIONS[0]!, true);
    expect("isHq" in existing || "isPublic" in existing).toBe(false);
    expect(flagsOnlyOnCreate(HQ_SEED_ORGANIZATIONS[0]!, false)).toMatchObject({ isHq: true, isPublic: false });
  });
```

and replace every `hqOnlyOnCreate` import and call in that file with `flagsOnlyOnCreate`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/core/src/services/organizations.test.ts apps/core/src/http/routes.test.ts tests/seed-core-from-public-api.test.ts`
Expected: FAIL. `setOrganizationPublic`, `isNonPublicAbbreviation` and `flagsOnlyOnCreate` don't exist; the route 404s.

- [ ] **Step 3: Schema and migration**

In `apps/core/src/db/schema.ts`, after `isHq`:

```ts
  /** Listed on public surfaces (Q54). False for GCPE Headquarters and GCPE Media Relations. */
  isPublic: boolean("is_public").notNull().default(true),
```

Run: `cd apps/core && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name org_public`
Expected: `migrations/0003_org_public.sql` containing one `ALTER TABLE "organizations" ADD COLUMN "is_public" boolean DEFAULT true NOT NULL;`. Existing rows become public, which is right for every organization except the two GCPE ones (D6).

- [ ] **Step 4: The service**

In `apps/core/src/services/organizations.ts`:

```ts
export const orgInputSchema = orgRecordSchema
  .omit({ updatedAt: true, isHq: true, isPublic: true })
  .extend({ isHq: z.boolean().optional(), isPublic: z.boolean().optional() });

/** Legacy abbreviations of the organizations hidden from public lists (Q54). The Office of the
 * Premier is HQ but public, so this is not HQ_ABBREVIATIONS. */
export const NON_PUBLIC_ABBREVIATIONS = ["GCPEHQ", "GCPEMEDIA"] as const;

export function isNonPublicAbbreviation(abbreviation: string | null | undefined): boolean {
  return abbreviation != null && (NON_PUBLIC_ABBREVIATIONS as readonly string[]).includes(abbreviation.trim().toUpperCase());
}
```

Update the doc comment above `orgInputSchema` to say both flags are optional with the same create-only rule. In `toOrgRecord`, after `isHq: row.isHq,` add `isPublic: row.isPublic,`. In `upsertOrganization`, add `isPublicOnCreate?: boolean` to `opts` (doc: "The public flag to give the organization if this upsert creates it. Ignored when it already exists.") and replace the `data` line with:

```ts
    const data = {
      ...parsed,
      isHq: parsed.isHq ?? (existing ? existing.isHq : (opts.isHqOnCreate ?? false)),
      isPublic: parsed.isPublic ?? (existing ? existing.isPublic : (opts.isPublicOnCreate ?? true)),
    };
```

Add after `setOrganizationHq`:

```ts
/** Core.Admin's public switch (Q54). Emits org.upserted only when the flag changes. */
export async function setOrganizationPublic(db: Db, key: string, isPublic: boolean, subscribers: SubscriberConfig[]): Promise<OrgRecord | null> {
  return db.transaction(async (tx) => {
    await lockAggregate(tx, orgAggregateId(key));
    const [existing] = await tx.select().from(organizations).where(eq(organizations.key, key)).for("update");
    if (!existing) return null;
    if (existing.isPublic === isPublic) return toOrgRecord(existing);
    const [row] = await tx.update(organizations).set({ isPublic, updatedAt: new Date() }).where(eq(organizations.key, key)).returning();
    const record = toOrgRecord(row!);
    await enqueueEvent(tx, { type: "org.upserted", source: CORE_SOURCE, aggregateId: orgAggregateId(key), data: record }, subscribers);
    return record;
  });
}
```

- [ ] **Step 5: The route, the importer and the seed**

In `apps/core/src/http/routes.ts`, import `setOrganizationPublic` and add after the `/hq` route:

```ts
  const publicSchema = z.object({ isPublic: z.boolean() });
  r.put(
    "/organizations/:key/public",
    admin,
    safe<{ key: string }>(async (req, res) => {
      const { isPublic } = publicSchema.parse(req.body);
      const record = await setOrganizationPublic(db, req.params.key, isPublic, subscribers);
      record ? res.json(record) : res.status(404).json({ error: "not found" });
    }),
  );
```

In `apps/core/src/import/run.ts` line 46, import `isNonPublicAbbreviation` and pass both create-only flags:

```ts
    // GCPEHQ, GCPEMEDIA and PREM are created HQ (Q49), and GCPEHQ and GCPEMEDIA non-public (Q54);
    // an existing organization keeps Core.Admin's flags (C124).
    const { changed } = await upsertOrganization(db, org, subscribers, {
      legacyId: id,
      isHqOnCreate: isHqAbbreviation(row.Abbreviation),
      isPublicOnCreate: !isNonPublicAbbreviation(row.Abbreviation),
    });
```

In `scripts/lib/public-taxonomy.ts`: in `hqOrganization`, add `isPublic: false,` after `isHq: true,`; update `HQ_SEED_ORGANIZATIONS`' doc comment to say both are created non-public (Q54) and the Office of the Premier stays public. Replace `hqOnlyOnCreate` with:

```ts
/**
 * The seed asserts the HQ and public flags only when it creates the organization (C124, Q54).
 * When the organization already exists the body omits both, so Core keeps whatever Core.Admin
 * last chose, in either direction.
 */
export function flagsOnlyOnCreate(input: OrgInput, exists: boolean): OrgInput {
  if (!exists) return input;
  const { isHq: _hq, isPublic: _pub, ...body } = input;
  return body;
}
```

In `scripts/seed-core-from-public-api.ts`, `putOrganization`: change the guard to `if (input.isHq !== undefined || input.isPublic !== undefined)`, call `flagsOnlyOnCreate`, update the import and the doc comment ("A body that asserts HQ or public …").

- [ ] **Step 6: The Organizations screen**

In `CalendarAccessScreen.tsx`'s `OrgOption`, add `isPublic: boolean;` after `isHq`. In `OrganizationsScreen.tsx`:
- Rename `setHq` to `setFlag` with signature `(o: OrgOption, flag: "hq" | "public", value: boolean)`; it PUTs `/core/api/organizations/${encodeURIComponent(o.key)}/${flag}` with body `flag === "hq" ? { isHq: value } : { isPublic: value }`, and sets status:
  - HQ: `${o.displayName} is ${value ? "now" : "no longer"} an HQ organization.` (unchanged text);
  - public: `${o.displayName} is ${value ? "now" : "no longer"} listed publicly.`
- Add a "Public" header after "HQ" and a cell with `<input type="checkbox" aria-label={`${o.displayName} is listed publicly`} checked={o.isPublic} disabled={busy} onChange={(e) => void setFlag(o, "public", e.target.checked)} />`.
- Add a sentence to the intro: "Organizations that aren't public are left out of the public ministry list and the subscribe page."
- The caption becomes "Organizations, their HQ flag and whether they're public".

Never send either flag through the general `PUT /core/api/organizations/:key`.

In `OrganizationsScreen.test.tsx`, add `isPublic: true` to `ORGS[0]` and `isPublic: false` to `ORGS[1]`, extend the fetch stub with `if (url === "/core/api/organizations/health/public" && init?.method === "PUT") return jsonResponse(200, { ...ORGS[0], isPublic: false });`, and add:

```ts
  it("shows and sets whether each organization is listed publicly", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(["Core.Admin"], calls);
    renderScreen();
    expect(await screen.findByLabelText("GCPE Media Relations is listed publicly")).not.toBeChecked();
    const health = screen.getByLabelText("Health is listed publicly");
    expect(health).toBeChecked();
    await userEvent.setup().click(health);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/public") && c.init?.method === "PUT")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/public"))!.init!.body as string)).toEqual({ isPublic: false });
    expect(await screen.findByRole("status")).toHaveTextContent("Health is no longer listed publicly.");
  });
```

Update `apps/staff-web/src/screens/admin/calendar-access/fixtures.ts`'s `ORGS` with `isPublic` on each (GCPE ones `false`, others `true`).

- [ ] **Step 7: Run the tests and type-checks**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/core tests/seed-core-from-public-api.test.ts tests/hq-flag-on-create.test.ts apps/staff-web/src/screens/admin`
Then both `tsc` commands.
Expected: PASS and clean.

- [ ] **Step 8: Commit**

```bash
git add apps/core scripts tests apps/staff-web
git commit -m "feat(core,staff-web): public flag on organizations; GCPE HQ and Media Relations created non-public (Q54)"
```

---

### Task 3: Hide non-public organizations in the News API and NoD

Covers carry-forward Q54 (consumer half), D7.

**Files:**
- Modify: `apps/news-api/src/db/schema.ts` (`categories.isPublic`); generate `apps/news-api/migrations/0002_category_public.sql`.
- Modify: `apps/news-api/src/projections.ts` (`applyOrg`), `apps/news-api/src/read.ts` (`allMinistries`, `getMinister`).
- Create: `apps/news-api/src/public-ministries.test.ts`.
- Modify: `apps/nod/src/lists.ts` (`onOrg`), `apps/nod/src/lists.test.ts`.

**Interfaces:**
- Consumes: `OrgRecord.isPublic` (Task 1).
- Produces: none new; `listMinistries`, `getMinistry`, `getMinister` skip non-public ministries.

- [ ] **Step 1: Write the failing tests**

`apps/news-api/src/public-ministries.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import type { OrgRecord } from "@gcpe/events";
import { createNewsTestDb } from "../test/helpers";
import { applyOrg } from "./projections";
import { getMinister, getMinistry, listMinistries } from "./read";

const org = (key: string, over: Partial<OrgRecord> = {}): OrgRecord => ({
  key,
  displayName: key,
  abbreviation: null,
  sortOrder: 0,
  isActive: true,
  parentKey: null,
  url: null,
  displayAdditionalName: null,
  minister: { name: null, summary: null, detailsHtml: null, email: null, photoUrl: null, address: null },
  contact: null,
  secondContact: null,
  weekendContactNumber: null,
  social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null },
  topicLinks: [],
  serviceLinks: [],
  sectorKeys: [],
  isHq: false,
  isPublic: true,
  updatedAt: "2026-10-08T17:00:00Z",
  ...over,
});

describe("non-public ministries (Q54)", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNewsTestDb();
    await tdb.db.transaction((tx) => applyOrg(tx, org("health")));
    await tdb.db.transaction((tx) => applyOrg(tx, org("office-of-the-premier", { isHq: true })));
    await tdb.db.transaction((tx) => applyOrg(tx, org("gcpe-headquarters", { isHq: true, isPublic: false })));
  });
  afterAll(() => tdb.drop());

  it("are left out of the ministry list; an HQ but public ministry stays", async () => {
    const keys = (await listMinistries(tdb.db, "America/Vancouver")).map((m) => (m as { key: string }).key);
    expect(keys).toContain("health");
    expect(keys).toContain("office-of-the-premier");
    expect(keys).not.toContain("gcpe-headquarters");
  });

  it("are not found by key, as ministry or minister", async () => {
    expect(await getMinistry(tdb.db, "gcpe-headquarters", "America/Vancouver")).toBeNull();
    expect(await getMinister(tdb.db, "gcpe-headquarters", "America/Vancouver")).toBeNull();
    expect(await getMinistry(tdb.db, "health", "America/Vancouver")).not.toBeNull();
  });

  it("become listed again when Core makes them public, and a replayed old envelope keeps the ministry listed", async () => {
    await tdb.db.transaction((tx) => applyOrg(tx, org("gcpe-headquarters", { isHq: true, isPublic: true })));
    expect(await getMinistry(tdb.db, "gcpe-headquarters", "America/Vancouver")).not.toBeNull();
    // An envelope stored before isPublic existed parses with the default (Task 1), so it is public.
    await tdb.db.transaction((tx) => applyOrg(tx, org("health", { isPublic: true })));
    expect(await getMinistry(tdb.db, "health", "America/Vancouver")).not.toBeNull();
  });
});
```

If `listMinistries`' DTO names the key differently (check `toMinistryDto` in `apps/news-api/src/dto.ts`), map with that field instead of `key`.

Append to `apps/nod/src/lists.test.ts`, inside `describe("lists from Core events")`, using the file's own `org(key, displayName)` envelope builder (lines 16-39) and its `app`; add `publicListItems` and `activeListKeys` to its import from `./lists`:

```ts
  it("a non-public organization's list is inactive: not offered, not subscribable (Q54)", async () => {
    const hidden = org("gcpe-headquarters", "GCPE Headquarters");
    const premier = org("office-of-the-premier", "Office of the Premier");
    expect((await sendEvent(app, { ...hidden, data: { ...(hidden.data as object), isHq: true, isPublic: false } })).status).toBe(200);
    expect((await sendEvent(app, { ...premier, data: { ...(premier.data as object), isHq: true, isPublic: true } })).status).toBe(200);
    const offered = (await publicListItems(tdb.db, "ministries")).map((i) => i.key);
    expect(offered).toContain("office-of-the-premier");
    expect(offered).not.toContain("gcpe-headquarters");
    expect(await activeListKeys(tdb.db, ["ministries:gcpe-headquarters"])).toEqual([]);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/news-api/src/public-ministries.test.ts apps/nod/src/lists.test.ts`
Expected: FAIL. The GCPE ministry is listed and found; NoD offers its list.

- [ ] **Step 3: News API**

In `apps/news-api/src/db/schema.ts`, in `categories` after `isActive`:

```ts
    // Q54: a ministry Core marks non-public (GCPE Headquarters, GCPE Media Relations) is stored
    // but never listed or found. Sectors, themes and tags are always public.
    isPublic: boolean("is_public").notNull().default(true),
```

Run: `cd apps/news-api && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name category_public`
Expected: `0002_category_public.sql` with one `ADD COLUMN "is_public" boolean DEFAULT true NOT NULL`.

In `projections.ts` `applyOrg`'s `values`, after `isActive: org.isActive,` add `isPublic: org.isPublic,`.

In `read.ts`, `allMinistries`:

```ts
async function allMinistries(db: Db): Promise<CategoryRow[]> {
  return db
    .select()
    .from(categories)
    .where(and(eq(categories.kind, "ministries"), eq(categories.isPublic, true)))
    .orderBy(asc(categories.sortOrder), asc(categories.key));
}
```

and `getMinister`'s where clause becomes `and(eq(categories.kind, "ministries"), lowerEq(categories.key, key), eq(categories.isPublic, true))`. `activeChildKey` works on the filtered list, so a non-public child never shows as a parent's `childMinistryKey`.

- [ ] **Step 4: NoD**

In `apps/nod/src/lists.ts`:

```ts
const onOrg: EventHandler = async (tx, e) => {
  const o = e.data as OrgRecord;
  // A non-public organization (Q54) is kept as an inactive list: not offered on the subscribe
  // page and not subscribable, the same as a deactivated one.
  await upsertList(tx, "ministries", o.key, o.displayName, o.sortOrder, o.isActive && o.isPublic);
};
```

- [ ] **Step 5: Run the tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/news-api apps/nod/src/lists.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/news-api apps/nod
git commit -m "feat(news-api,nod): non-public organizations are left out of public ministry lists and the subscribe page (Q54)"
```

---

### Task 4: `apps/calendar`: package, schema and first migration

Covers spec §5.1 (conventions), §5.2 (every table), D2–D4, D17.

**Files:**
- Create: `apps/calendar/package.json`, `apps/calendar/drizzle.config.ts`, `apps/calendar/Dockerfile`.
- Create: `apps/calendar/src/db/schema.ts`, `apps/calendar/src/db/schema.test.ts`.
- Generate: `apps/calendar/migrations/0000_init.sql` (+ `meta/`).
- Create: `apps/calendar/test/helpers.ts` (database part; Task 5 adds the rest).
- Modify: `package-lock.json` (via `npm install`).

**Interfaces:**
- Produces (`apps/calendar/src/db/schema.ts`):
  - constants `ACTIVITY_STATUSES`, `HQ_STATUSES`, `HQ_SECTIONS`, `NEEDS_REVIEW_KEYS` (23), `CHANGE_ACTIONS`, `CHANGE_SOURCES`, `LIST_DISPLAYS`, `TERM_KINDS`, and their types;
  - projections `orgs`, `terms`, `users`;
  - lookups `categories`, `cities`, `commMaterials`, `eventPlanners`, `governmentRepresentatives`, `initiatives`, `keywords`, `nrDistributions`, `nrOrigins`, `premierRequested`, `videographers` (SQL names `categories`, `cities`, `comm_materials`, `event_planners`, `government_representatives`, `initiatives`, `keywords`, `nr_distributions`, `nr_origins`, `premier_requested`, `videographers`);
  - `commContacts`, `userProfiles`, `savedFilters`, `activities`, the nine join tables, `activityFiles`, `favourites`, `activityChanges`, `activityChangeFields`, `activityLocks`, `releaseLinks`;
  - re-exports `@gcpe/events/tables`.
- Produces (`apps/calendar/test/helpers.ts`): `calendarMigrations: string`, `createCalendarTestDb(): Promise<TestDatabase>`.

- [ ] **Step 1: Package files**

`apps/calendar/package.json`:

```json
{
  "name": "@gcpe/calendar",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "db:generate": "drizzle-kit generate",
    "build": "node ../../scripts/build-app.mjs apps/calendar"
  },
  "dependencies": {
    "@gcpe/auth": "0.0.0",
    "@gcpe/config": "0.0.0",
    "@gcpe/db-kit": "0.0.0",
    "@gcpe/events": "0.0.0",
    "@gcpe/http-kit": "0.0.0",
    "drizzle-orm": "^0.45.2",
    "express": "^5.2.1",
    "pg": "^8.16.3",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@types/express": "^5.0.6",
    "@types/pg": "^8.23.1",
    "@types/supertest": "^7.2.1",
    "drizzle-kit": "^0.31.9",
    "supertest": "^7.1.0"
  }
}
```

`apps/calendar/drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
```

`apps/calendar/Dockerfile`: copy `apps/nod/Dockerfile`, replacing `apps/nod` with `apps/calendar`, `@gcpe/nod` with `@gcpe/calendar`, and `3004` with `3007` (three places: `EXPOSE`, the `HEALTHCHECK` default, its comment).

Run: `npx -y -p node@24 -- npm install`
Expected: `package-lock.json` gains the `apps/calendar` workspace; no new third-party packages.

- [ ] **Step 2: Write the failing schema test**

`apps/calendar/test/helpers.ts`:

```ts
import { fileURLToPath } from "node:url";
import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";

export const calendarMigrations = fileURLToPath(new URL("../migrations", import.meta.url));

export function createCalendarTestDb(): Promise<TestDatabase> {
  return createTestDatabase({ migrationsFolder: calendarMigrations });
}
```

`apps/calendar/src/db/schema.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCalendarTestDb } from "../../test/helpers";
import { activities, activityCategories, categories, cities, commContacts, NEEDS_REVIEW_KEYS, userProfiles } from "./schema";

const USER = "8a7f3c1e-2b4d-4e6f-9a0b-1c2d3e4f5a6b";

describe("Calendar schema", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCalendarTestDb();
  });
  afterAll(() => tdb.drop());

  it("keeps legacy ids: explicit ids insert into lookups and activities", async () => {
    await tdb.db.insert(categories).values({ id: 58, name: "Sample category" });
    await tdb.db.insert(cities).values({ id: 311, name: "Other..." });
    const [a] = await tdb.db.insert(activities).values({ id: 90001, title: "Sample", cityId: 311 }).returning({ id: activities.id });
    expect(a!.id).toBe(90001);
    await tdb.db.insert(activityCategories).values({ activityId: 90001, categoryId: 58 });
  });

  it("a row without an id gets one from the identity", async () => {
    const [c] = await tdb.db.insert(categories).values({ name: "Another sample" }).returning({ id: categories.id });
    expect(c!.id).toBeGreaterThan(0);
  });

  it("stores an imported activity with no dates, no comm contact and no contact ministry (C147)", async () => {
    const [a] = await tdb.db.insert(activities).values({ title: "Imported without dates" }).returning();
    expect(a).toMatchObject({ startAt: null, endAt: null, commContactId: null, contactMinistryKey: null, status: "new", hqSection: "events_and_speeches", version: 1, needsReview: [] });
  });

  it("holds exactly the 23 needs-review keys and refuses any other", async () => {
    expect(NEEDS_REVIEW_KEYS).toHaveLength(23);
    await tdb.db.insert(activities).values({ title: "All flags", needsReview: [...NEEDS_REVIEW_KEYS] });
    await expect(tdb.db.insert(activities).values({ title: "Bad flag", needsReview: ["priority"] })).rejects.toThrow();
  });

  it("refuses an unknown status, HQ status or Look Ahead section", async () => {
    await expect(tdb.db.execute(sql`INSERT INTO activities (title, status) VALUES ('x', 'archived')`)).rejects.toThrow();
    await expect(tdb.db.execute(sql`INSERT INTO activities (title, hq_status) VALUES ('x', 'reviewed')`)).rejects.toThrow();
    await expect(tdb.db.execute(sql`INSERT INTO activities (title, hq_section) VALUES ('x', 'consultations')`)).rejects.toThrow();
  });

  it("refuses text over legacy's column sizes", async () => {
    await expect(tdb.db.insert(activities).values({ title: "x".repeat(501) })).rejects.toThrow();
    await expect(tdb.db.insert(activities).values({ title: "ok", potentialDates: "x".repeat(71) })).rejects.toThrow();
    await tdb.db.insert(activities).values({ title: "x".repeat(217) }); // the longest legacy title (SV 4.5)
  });

  it("allows one comm contact per user and ministry, ranked 1–6", async () => {
    await tdb.db.insert(commContacts).values({ userId: USER, ministryKey: "health", rank: 1 });
    await expect(tdb.db.insert(commContacts).values({ userId: USER, ministryKey: "health", rank: 2 })).rejects.toThrow();
    await expect(tdb.db.insert(commContacts).values({ userId: USER, ministryKey: "finance", rank: 7 })).rejects.toThrow();
  });

  it("keeps legacy's phone format: 12 characters of digits and hyphens", async () => {
    await tdb.db.insert(userProfiles).values({ userId: USER, phone: "250-555-0100", mobile: null });
    await expect(tdb.db.insert(userProfiles).values({ userId: "9a7f3c1e-2b4d-4e6f-9a0b-1c2d3e4f5a6b", phone: "(250) 555-0100" })).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/db/schema.test.ts`
Expected: FAIL. `./schema` can't be resolved and there is no migrations folder.

- [ ] **Step 4: Write the schema**

`apps/calendar/src/db/schema.ts`:

```ts
import { sql, type SQL } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { CalendarRole } from "@gcpe/auth";

// The event receiver and the outbox need these in the Calendar's own database.
export * from "@gcpe/events/tables";

const tz = (name: string) => timestamp(name, { withTimezone: true });
/** Legacy integer ids are kept (spec addendum §5.2); new rows draw from the identity, which the
 * importer re-bases above the imported maximum. */
const legacyId = () => integer("id").primaryKey().generatedByDefaultAsIdentity();
const sqlList = (values: readonly string[]): SQL => sql.raw(values.map((v) => `'${v}'`).join(","));
const maxLength = (table: string, column: AnyPgColumn, n: number) => check(`${table}_${column.name}_length`, sql`char_length(${column}) <= ${sql.raw(String(n))}`);

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
/** The list's "Display" choice (spec addendum §8.1; legacy FilterDisplayValue). */
export const LIST_DISPLAYS = ["all", "my_ministries", "my_activities", "my_watchlist"] as const;
export type ListDisplay = (typeof LIST_DISPLAYS)[number];
export const TERM_KINDS = ["sector", "theme", "tag"] as const;
export type TermKind = (typeof TERM_KINDS)[number];

// ── Projections of Core (spec addendum §5.2). Keyed by Core key or user id; nothing references
// them by foreign key, because they fill asynchronously from events.

export const orgs = pgTable("orgs", {
  key: text("key").primaryKey(),
  displayName: text("display_name").notNull(),
  abbreviation: text("abbreviation"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull(),
  isHq: boolean("is_hq").notNull().default(false),
});

export const terms = pgTable(
  "terms",
  {
    kind: text("kind").$type<TermKind>().notNull(),
    key: text("key").notNull(),
    displayName: text("display_name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.key] }), check("terms_kind_check", sql`${t.kind} IN (${sqlList(TERM_KINDS)})`)],
);

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  email: text("email"),
  displayName: text("display_name").notNull(),
  isActive: boolean("is_active").notNull(),
  calendarRole: text("calendar_role").$type<CalendarRole>(),
  organizationKeys: text("organization_keys").array().notNull().default(sql`'{}'::text[]`),
});

// ── Lookups (spec addendum §5.2, §5.3). Legacy ids; never deleted, only deactivated.

const lookupColumns = () => ({
  id: legacyId(),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
});

export const categories = pgTable("categories", lookupColumns());
export const cities = pgTable("cities", lookupColumns());
export const commMaterials = pgTable("comm_materials", lookupColumns());
export const eventPlanners = pgTable("event_planners", { ...lookupColumns(), phone: text("phone"), jobTitle: text("job_title") });
export const governmentRepresentatives = pgTable("government_representatives", { ...lookupColumns(), description: text("description") });
export const initiatives = pgTable("initiatives", { ...lookupColumns(), shortName: text("short_name") });
export const keywords = pgTable("keywords", lookupColumns());
export const nrDistributions = pgTable("nr_distributions", lookupColumns());
export const nrOrigins = pgTable("nr_origins", lookupColumns());
export const premierRequested = pgTable("premier_requested", lookupColumns());
export const videographers = pgTable("videographers", { ...lookupColumns(), jobTitle: text("job_title") });

/** Legacy CommunicationContact: one per user × ministry; rank 1 Comm Director … 6 Other (Admin/User.aspx.cs:16-25). */
export const commContacts = pgTable(
  "comm_contacts",
  {
    id: legacyId(),
    userId: uuid("user_id").notNull(),
    ministryKey: text("ministry_key").notNull(),
    rank: integer("rank"),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => [
    uniqueIndex("comm_contacts_user_ministry_idx").on(t.userId, t.ministryKey),
    check("comm_contacts_rank_check", sql`${t.rank} IS NULL OR ${t.rank} BETWEEN 1 AND 6`),
  ],
);

/** Calendar-only contact details and list preferences (spec addendum §4, §5.2). */
export const userProfiles = pgTable(
  "user_profiles",
  {
    userId: uuid("user_id").primaryKey(),
    phone: text("phone"),
    mobile: text("mobile"),
    jobTitle: text("job_title"),
    description: text("description"),
    listDisplay: text("list_display").$type<ListDisplay>(),
    hiddenColumns: text("hidden_columns").array().notNull().default(sql`'{}'::text[]`),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // Legacy's CHECK: 12 characters of digits and hyphens.
    check("user_profiles_phone_check", sql`${t.phone} IS NULL OR ${t.phone} ~ '^[0-9-]{12}$'`),
    check("user_profiles_mobile_check", sql`${t.mobile} IS NULL OR ${t.mobile} ~ '^[0-9-]{12}$'`),
    check("user_profiles_list_display_check", sql`${t.listDisplay} IS NULL OR ${t.listDisplay} IN (${sqlList(LIST_DISPLAYS)})`),
    maxLength("user_profiles", t.jobTitle, 100),
    maxLength("user_profiles", t.description, 2000),
  ],
);

export const savedFilters = pgTable(
  "saved_filters",
  {
    id: legacyId(),
    ownerId: uuid("owner_id").notNull(),
    name: text("name").notNull(),
    filter: jsonb("filter").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => [index("saved_filters_owner_idx").on(t.ownerId), maxLength("saved_filters", t.name, 200)],
);

// ── Activities (spec addendum §5.2: one row per legacy calendar.Activity).

export const activities = pgTable(
  "activities",
  {
    id: legacyId(),
    startAt: tz("start_at"),
    endAt: tz("end_at"),
    nrAt: tz("nr_at"),
    potentialDates: text("potential_dates"),
    isAllDay: boolean("is_all_day").notNull().default(false),
    isConfirmed: boolean("is_confirmed").notNull().default(false),
    title: text("title").notNull().default(""),
    details: text("details").notNull().default(""),
    schedule: text("schedule").notNull().default(""),
    significance: text("significance").notNull().default(""),
    strategy: text("strategy"),
    comments: text("comments"),
    hqComments: text("hq_comments"),
    leadOrganization: text("lead_organization"),
    venue: text("venue"),
    otherCity: text("other_city"),
    translations: text("translations").array().notNull().default(sql`'{}'::text[]`),
    status: text("status").$type<ActivityStatus>().notNull().default("new"),
    hqStatus: text("hq_status").$type<HqStatus>(),
    // Legacy's default HqSection is 2.
    hqSection: text("hq_section").$type<HqSection>().notNull().default("events_and_speeches"),
    longTermOutlook: boolean("long_term_outlook").notNull().default(false),
    nrDistributionId: integer("nr_distribution_id").references(() => nrDistributions.id),
    premierRequestedId: integer("premier_requested_id").references(() => premierRequested.id),
    contactMinistryKey: text("contact_ministry_key"),
    governmentRepresentativeId: integer("government_representative_id").references(() => governmentRepresentatives.id),
    commContactId: integer("comm_contact_id").references(() => commContacts.id),
    eventPlannerId: integer("event_planner_id").references(() => eventPlanners.id),
    videographerId: integer("videographer_id").references(() => videographers.id),
    cityId: integer("city_id").references(() => cities.id),
    isIssue: boolean("is_issue").notNull().default(false),
    isAtLegislature: boolean("is_at_legislature").notNull().default(false),
    isConfidential: boolean("is_confidential").notNull().default(false),
    isCrossGovernment: boolean("is_cross_government").notNull().default(false),
    isMilestone: boolean("is_milestone").notNull().default(false),
    deletedAt: tz("deleted_at"),
    deletedBy: uuid("deleted_by"),
    needsReview: text("needs_review").array().$type<NeedsReviewKey[]>().notNull().default(sql`'{}'::text[]`),
    createdAt: tz("created_at").notNull().defaultNow(),
    createdBy: uuid("created_by"),
    lastUpdatedAt: tz("last_updated_at").notNull().defaultNow(),
    lastUpdatedBy: uuid("last_updated_by"),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    index("activities_start_at_idx").on(t.startAt),
    index("activities_end_at_idx").on(t.endAt),
    index("activities_contact_ministry_idx").on(t.contactMinistryKey),
    index("activities_comm_contact_idx").on(t.commContactId),
    check("activities_status_check", sql`${t.status} IN (${sqlList(ACTIVITY_STATUSES)})`),
    check("activities_hq_status_check", sql`${t.hqStatus} IS NULL OR ${t.hqStatus} IN (${sqlList(HQ_STATUSES)})`),
    check("activities_hq_section_check", sql`${t.hqSection} IN (${sqlList(HQ_SECTIONS)})`),
    check("activities_needs_review_check", sql`${t.needsReview} <@ ARRAY[${sqlList(NEEDS_REVIEW_KEYS)}]::text[]`),
    // Legacy's column sizes; the editor's tighter limits on new values are 5c's validation.
    maxLength("activities", t.title, 500),
    maxLength("activities", t.details, 700),
    maxLength("activities", t.schedule, 500),
    maxLength("activities", t.significance, 500),
    maxLength("activities", t.strategy, 500),
    maxLength("activities", t.comments, 4000),
    maxLength("activities", t.hqComments, 2000),
    maxLength("activities", t.leadOrganization, 100),
    maxLength("activities", t.venue, 150),
    maxLength("activities", t.otherCity, 150),
    maxLength("activities", t.potentialDates, 70),
  ],
);

const activityRef = () => integer("activity_id").notNull().references(() => activities.id, { onDelete: "cascade" });

export const activityCategories = pgTable("activity_categories", { activityId: activityRef(), categoryId: integer("category_id").notNull().references(() => categories.id) }, (t) => [primaryKey({ columns: [t.activityId, t.categoryId] })]);
export const activityCommMaterials = pgTable("activity_comm_materials", { activityId: activityRef(), commMaterialId: integer("comm_material_id").notNull().references(() => commMaterials.id) }, (t) => [primaryKey({ columns: [t.activityId, t.commMaterialId] })]);
export const activityInitiatives = pgTable("activity_initiatives", { activityId: activityRef(), initiativeId: integer("initiative_id").notNull().references(() => initiatives.id) }, (t) => [primaryKey({ columns: [t.activityId, t.initiativeId] })]);
/** "HQ Tags". */
export const activityKeywords = pgTable("activity_keywords", { activityId: activityRef(), keywordId: integer("keyword_id").notNull().references(() => keywords.id) }, (t) => [primaryKey({ columns: [t.activityId, t.keywordId] })]);
export const activityNrOrigins = pgTable("activity_nr_origins", { activityId: activityRef(), nrOriginId: integer("nr_origin_id").notNull().references(() => nrOrigins.id) }, (t) => [primaryKey({ columns: [t.activityId, t.nrOriginId] })]);
export const activitySectors = pgTable("activity_sectors", { activityId: activityRef(), termKey: text("term_key").notNull() }, (t) => [primaryKey({ columns: [t.activityId, t.termKey] })]);
export const activityThemes = pgTable("activity_themes", { activityId: activityRef(), termKey: text("term_key").notNull() }, (t) => [primaryKey({ columns: [t.activityId, t.termKey] })]);
/** "News Subscribe". */
export const activityTags = pgTable("activity_tags", { activityId: activityRef(), termKey: text("term_key").notNull() }, (t) => [primaryKey({ columns: [t.activityId, t.termKey] })]);
export const activitySharedWith = pgTable(
  "activity_shared_with",
  { activityId: activityRef(), ministryKey: text("ministry_key").notNull() },
  (t) => [primaryKey({ columns: [t.activityId, t.ministryKey] }), index("activity_shared_with_ministry_idx").on(t.ministryKey)],
);

export const activityFiles = pgTable(
  "activity_files",
  {
    id: legacyId(),
    activityId: integer("activity_id").notNull().references(() => activities.id),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    length: integer("length").notNull(),
    sha256: text("sha256").notNull(),
    storageKey: text("storage_key").notNull(),
    uploadedAt: tz("uploaded_at").notNull().defaultNow(),
    uploadedBy: uuid("uploaded_by"),
  },
  // Same-name upload replaces (Activity.aspx.cs:1436-1437).
  (t) => [uniqueIndex("activity_files_name_idx").on(t.activityId, t.fileName)],
);

/** The watchlist (legacy FavoriteActivity). */
export const favourites = pgTable(
  "favourites",
  { userId: uuid("user_id").notNull(), activityId: activityRef() },
  (t) => [primaryKey({ columns: [t.userId, t.activityId] }), index("favourites_activity_idx").on(t.activityId)],
);

export const activityChanges = pgTable(
  "activity_changes",
  {
    id: integer("id").primaryKey().generatedByDefaultAsIdentity(),
    activityId: activityRef(),
    at: tz("at").notNull().defaultNow(),
    actorId: uuid("actor_id"),
    actorName: text("actor_name").notNull(),
    action: text("action").$type<ChangeAction>().notNull(),
    source: text("source").$type<ChangeSource>().notNull().default("calendar"),
    contactMinistryKey: text("contact_ministry_key"),
  },
  (t) => [
    index("activity_changes_activity_at_idx").on(t.activityId, t.at),
    index("activity_changes_at_idx").on(t.at),
    check("activity_changes_action_check", sql`${t.action} IN (${sqlList(CHANGE_ACTIONS)})`),
    check("activity_changes_source_check", sql`${t.source} IN (${sqlList(CHANGE_SOURCES)})`),
  ],
);

export const activityChangeFields = pgTable(
  "activity_change_fields",
  {
    changeId: integer("change_id").notNull().references(() => activityChanges.id, { onDelete: "cascade" }),
    fieldKey: text("field_key").notNull(),
    oldValue: text("old_value"),
    newValue: text("new_value"),
  },
  (t) => [primaryKey({ columns: [t.changeId, t.fieldKey] })],
);

export const activityLocks = pgTable("activity_locks", {
  activityId: integer("activity_id").primaryKey().references(() => activities.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull(),
  tabId: text("tab_id").notNull(),
  acquiredAt: tz("acquired_at").notNull().defaultNow(),
  lastActiveAt: tz("last_active_at").notNull().defaultNow(),
});

/** The projection of NRMS's release.status_changed (spec addendum §11). */
export const releaseLinks = pgTable(
  "release_links",
  {
    releaseId: uuid("release_id").primaryKey(),
    activityId: integer("activity_id").notNull().references(() => activities.id, { onDelete: "cascade" }),
    key: text("key"),
    type: text("type").notNull(),
    status: text("status").notNull(),
    publishAt: tz("publish_at"),
    releasedAt: tz("released_at"),
    reference: text("reference"),
    headline: text("headline"),
    lastSequence: integer("last_sequence").notNull(),
  },
  (t) => [index("release_links_activity_idx").on(t.activityId)],
);
```

- [ ] **Step 5: Generate the migration**

Run: `cd apps/calendar && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name init`
Expected: `migrations/0000_init.sql`, `migrations/meta/_journal.json` and `meta/0000_snapshot.json`. Read the SQL: every table above, `outbox_events`, `outbox_deliveries`, `aggregate_sequences`, `inbox_events`, `inbox_positions`, and each `CHECK` with its literal lists (for example `"activities"."needs_review" <@ ARRAY['title',…,'digital']::text[]`). If drizzle-kit renders a check differently from the expression above, keep what it generated; never hand-edit it.

- [ ] **Step 6: Run the test**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/db/schema.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/calendar package-lock.json
git commit -m "feat(calendar): app package and the Calendar schema with legacy ids (spec addendum §5.2)"
```

---

### Task 5: Calendar projections, the per-request actor, and `GET /api/me`

Covers spec §4 "Per-request checks in the Calendar", §5.1 (receiver, Rule 3 of the parent spec), §6's inputs (M(u), HQ(u), L(u)), carry-forward items "User projection", "re-checks the grant per request", Q56, "Break-glass"; D8–D10.

**Files:**
- Create: `apps/calendar/src/projections.ts` (+ `projections.test.ts`).
- Create: `apps/calendar/src/actor.ts` (+ `actor.test.ts`).
- Create: `apps/calendar/src/http/routes.ts`.
- Create: `apps/calendar/src/app.ts`, `apps/calendar/src/start.ts`, `apps/calendar/src/main.ts` (+ `start.test.ts`).
- Modify: `apps/calendar/test/helpers.ts`.

**Interfaces:**
- Consumes: `orgs`, `terms`, `users` (Task 4); `CALENDAR_LEVELS`, `requireBearer`, `mintSession` (`@gcpe/auth`); `createEventReceiver`, `dispatchOnce`, `startDispatcher`, `parseSubscribers` (`@gcpe/events`).
- Produces:
  - `projectionHandler(event: EventEnvelope): EventHandler | undefined`; `needsReferenceData(db: DbOrTx): Promise<boolean>`.
  - `interface CalendarActor { userId: string; displayName: string; role: CalendarRole; level: number; ministryKeys: string[]; isHq: boolean }`; `Express.Request.calendar?: CalendarActor`.
  - `loadCalendarActor(db: DbOrTx, subject: string): Promise<CalendarActor | null>`; `requireCalendarActor(db: Db): RequestHandler`; `requireLevel(min: CalendarRole): RequestHandler`.
  - `apiRoutes(db: Db): Router` with `GET /me` → `CalendarActor`.
  - `createApp(deps: { db: Db; auth: BearerOptions; loginRouter?: Router | null; eventSecrets: Record<string, string> }): express.Express`.
  - `calendarEnvSchema`; `startCalendar(env: NodeJS.ProcessEnv): Promise<AppHandle>` with `workers.dispatch` and `workers.needsReferenceData`.
  - Test helpers: `EVENT_SECRETS`, `SESSION_SECRET`, `createTestApp(db)`, `envelope(source, type, data, aggregateId)`, `sendEvent(app, event)`, `sessionCookie(userId, roles?)`, `projectUser(app, record)`, `projectOrg(app, partial)`.

- [ ] **Step 1: Test helpers**

Append to `apps/calendar/test/helpers.ts`:

```ts
import { randomUUID } from "node:crypto";
import type express from "express";
import request from "supertest";
import type { Db } from "@gcpe/db-kit";
import { mintSession } from "@gcpe/auth";
import { signPayload, type OrgRecord, type UserRecord } from "@gcpe/events";
import { createApp } from "../src/app";

export const EVENT_SECRETS = { core: "core-secret", nrms: "nrms-secret" } as const;
export const SESSION_SECRET = "calendar-session-secret-0123456789abcdef";

export function createTestApp(db: Db): express.Express {
  return createApp({ db, auth: { session: { secret: SESSION_SECRET } }, eventSecrets: EVENT_SECRETS });
}

let seq = 0;
export function envelope(source: string, type: string, data: unknown, aggregateId: string) {
  return { id: randomUUID(), type, version: 1, source, aggregateId, sequence: ++seq, occurredAt: new Date().toISOString(), correlationId: randomUUID(), data };
}

export async function sendEvent(app: express.Express, event: ReturnType<typeof envelope>): Promise<request.Response> {
  const body = JSON.stringify(event);
  const ts = new Date().toISOString();
  const secret = EVENT_SECRETS[event.source as keyof typeof EVENT_SECRETS];
  return request(app)
    .post("/events")
    .set("content-type", "application/json")
    .set("x-event-source", event.source)
    .set("x-event-timestamp", ts)
    .set("x-signature", secret ? signPayload(secret, ts, body) : "bad-signature")
    .send(body);
}

/** A session cookie for `userId`. The roles in it are what sign-in minted; the Calendar ignores them. */
export async function sessionCookie(userId: string, roles: string[] = []): Promise<string> {
  const { token } = await mintSession(SESSION_SECRET, { id: userId, name: "Cookie Name", email: "cookie@example.test", roles });
  return `gcpe_session=${token}`;
}

export async function projectUser(app: express.Express, user: UserRecord): Promise<void> {
  const res = await sendEvent(app, envelope("core", "user.upserted", user, `user:${user.id}`));
  if (res.status !== 200) throw new Error(`user.upserted failed: ${res.status}`);
}

export function orgRecord(key: string, over: Partial<OrgRecord> = {}): OrgRecord {
  return {
    key,
    displayName: key,
    abbreviation: key.toUpperCase().slice(0, 6),
    sortOrder: 0,
    isActive: true,
    parentKey: null,
    url: null,
    displayAdditionalName: null,
    minister: { name: null, summary: null, detailsHtml: null, email: null, photoUrl: null, address: null },
    contact: null,
    secondContact: null,
    weekendContactNumber: null,
    social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null },
    topicLinks: [],
    serviceLinks: [],
    sectorKeys: [],
    isHq: false,
    isPublic: true,
    updatedAt: "2026-10-08T17:00:00Z",
    ...over,
  };
}

export async function projectOrg(app: express.Express, key: string, over: Partial<OrgRecord> = {}): Promise<void> {
  const res = await sendEvent(app, envelope("core", "org.upserted", orgRecord(key, over), `org:${key}`));
  if (res.status !== 200) throw new Error(`org.upserted failed: ${res.status}`);
}
```

- [ ] **Step 2: Write the failing tests**

`apps/calendar/src/projections.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCalendarTestDb, createTestApp, envelope, projectOrg, projectUser, sendEvent } from "../test/helpers";
import { orgs, terms, users } from "./db/schema";
import { needsReferenceData } from "./projections";

const ROBIN = "8a7f3c1e-2b4d-4e6f-9a0b-1c2d3e4f5a6b";

describe("Core projections", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createTestApp>;
  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
  });
  afterAll(() => tdb.drop());

  it("needs reference data until the first organization arrives", async () => {
    expect(await needsReferenceData(tdb.db)).toBe(true);
    await projectOrg(app, "health", { abbreviation: "HLTH" });
    expect(await needsReferenceData(tdb.db)).toBe(false);
  });

  it("keeps an organization's HQ flag and active state, and org.deactivated deactivates it", async () => {
    await projectOrg(app, "gcpe-headquarters", { isHq: true, abbreviation: "GCPEHQ" });
    expect((await tdb.db.select().from(orgs).where(eq(orgs.key, "gcpe-headquarters")))[0]).toMatchObject({ isHq: true, isActive: true, abbreviation: "GCPEHQ" });
    await sendEvent(app, envelope("core", "org.deactivated", { key: "gcpe-headquarters" }, "org:gcpe-headquarters"));
    expect((await tdb.db.select().from(orgs).where(eq(orgs.key, "gcpe-headquarters")))[0]!.isActive).toBe(false);
  });

  it("keeps sectors, themes and tags, and ignores services", async () => {
    const term = (kind: string, key: string) => ({ kind, key, displayName: key, sortOrder: 0, isActive: true, social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null }, updatedAt: "2026-10-08T17:00:00Z" });
    for (const kind of ["sector", "theme", "tag", "service"]) {
      expect((await sendEvent(app, envelope("core", `${kind}.upserted`, term(kind, `sample-${kind}`), `${kind}:sample-${kind}`))).status).toBe(200);
    }
    expect((await tdb.db.select().from(terms)).map((t) => t.kind).sort()).toEqual(["sector", "tag", "theme"]);
    await sendEvent(app, envelope("core", "tag.deactivated", { kind: "tag", key: "sample-tag" }, "tag:sample-tag"));
    expect((await tdb.db.select().from(terms).where(eq(terms.key, "sample-tag")))[0]!.isActive).toBe(false);
  });

  it("keeps a user's Calendar role and ministries, lowercased, deduplicated and sorted", async () => {
    await projectUser(app, { id: ROBIN, email: "robin.staff@example.test", displayName: "Robin Staff", isActive: true, calendarRole: "Calendar.Editor", organizationKeys: ["Health", "finance", "health"] });
    expect((await tdb.db.select().from(users).where(eq(users.id, ROBIN)))[0]).toMatchObject({ calendarRole: "Calendar.Editor", organizationKeys: ["finance", "health"], isActive: true });
  });

  it("ignores Core events it has no use for, and refuses a user.upserted from any other source", async () => {
    expect((await sendEvent(app, envelope("core", "release.published", {}, "release:x"))).status).toBe(400); // fails the contract, never reaches a handler
    const fromNrms = await sendEvent(app, envelope("nrms", "user.upserted", { id: ROBIN, email: null, displayName: "X", isActive: true, calendarRole: "Calendar.SysAdmin", organizationKeys: [] }, `user:${ROBIN}`));
    expect(fromNrms.body.outcome).toBe("ignored");
    expect((await tdb.db.select().from(users).where(eq(users.id, ROBIN)))[0]!.calendarRole).toBe("Calendar.Editor");
  });
});
```

`apps/calendar/src/actor.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { mintLocalToken } from "@gcpe/auth";
import type { TestDatabase } from "@gcpe/db-kit";
import type { UserRecord } from "@gcpe/events";
import { createApp } from "./app";
import { createCalendarTestDb, createTestApp, EVENT_SECRETS, projectOrg, projectUser, SESSION_SECRET, sessionCookie } from "../test/helpers";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const user = (n: number, over: Partial<UserRecord> = {}): UserRecord => ({
  id: id(n),
  email: `user${n}@example.test`,
  displayName: `Sample User ${n}`,
  isActive: true,
  calendarRole: "Calendar.Editor",
  organizationKeys: ["health"],
  ...over,
});

describe("the Calendar actor, re-derived on every request", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createTestApp>;
  const me = async (cookie: string) => request(app).get("/api/me").set("cookie", cookie);

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    await projectOrg(app, "health", { abbreviation: "HLTH" });
    await projectOrg(app, "finance", { abbreviation: "FIN" });
  });
  afterAll(() => tdb.drop());

  it("returns the projection's role, level, ministries and HQ, not the cookie's roles", async () => {
    await projectUser(app, user(1));
    const res = await me(await sessionCookie(id(1), ["Calendar.SysAdmin", "Core.Admin"]));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: id(1), displayName: "Sample User 1", role: "Calendar.Editor", level: 2, ministryKeys: ["health"], isHq: false });
  });

  it("a revoked grant takes effect on the next request, whatever the cookie says", async () => {
    await projectUser(app, user(2, { calendarRole: "Calendar.Administrator" }));
    const cookie = await sessionCookie(id(2), ["Calendar.Administrator"]);
    expect((await me(cookie)).status).toBe(200);
    await projectUser(app, user(2, { calendarRole: null }));
    const after = await me(cookie);
    expect(after.status).toBe(403);
    expect(after.body).toEqual({ error: "no Calendar access" });
  });

  it("a deactivated user, and a user the projection has never seen, have no Calendar access", async () => {
    await projectUser(app, user(3, { isActive: false }));
    expect((await me(await sessionCookie(id(3), ["Calendar.Editor"]))).status).toBe(403);
    expect((await me(await sessionCookie(id(99), ["Calendar.SysAdmin"]))).status).toBe(403);
  });

  it("HQ follows the org projection, whichever event arrives first", async () => {
    await projectUser(app, user(4, { organizationKeys: ["gcpe-media-relations"] }));
    const cookie = await sessionCookie(id(4));
    expect((await me(cookie)).body.isHq).toBe(false);
    await projectOrg(app, "gcpe-media-relations", { isHq: true });
    expect((await me(cookie)).body.isHq).toBe(true);
  });

  it("a deactivated HQ organization still makes its members HQ, as in Core's grant checks (Q56)", async () => {
    await projectOrg(app, "retired-hq", { isHq: true, isActive: false });
    await projectUser(app, user(5, { organizationKeys: ["retired-hq"] }));
    expect((await me(await sessionCookie(id(5)))).body.isHq).toBe(true);
  });

  it("a bearer token (break-glass or service) has no Calendar access: its subject is no projected user", async () => {
    const local = "calendar-local-bearer-secret-0123456789ab";
    const withLocal = createApp({ db: tdb.db, auth: { session: { secret: SESSION_SECRET }, local: { secret: local } }, eventSecrets: EVENT_SECRETS });
    const token = await mintLocalToken({ secret: local, subject: "admin", roles: ["Core.Admin", "Calendar.SysAdmin"] });
    expect((await request(withLocal).get("/api/me").set("authorization", `Bearer ${token}`)).status).toBe(403);
  });

  it("anonymous is 401", async () => {
    expect((await request(app).get("/api/me")).status).toBe(401);
  });
});
```

`apps/calendar/src/start.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCalendarTestDb } from "../test/helpers";
import { startCalendar } from "./start";

describe("startCalendar", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCalendarTestDb();
  });
  afterAll(() => tdb.drop());

  it("starts, serves health with Core and NRMS absent, and exposes dispatch and needsReferenceData", async () => {
    const handle = await startCalendar({ DATABASE_URL: tdb.url, NODE_ENV: "test" });
    try {
      expect((await request(handle.app).get("/health/ready")).status).toBe(200);
      expect(handle.port).toBe(3007);
      expect(await handle.workers.needsReferenceData!()).toBe(true);
      expect(await handle.workers.dispatch!()).toEqual({ delivered: 0, retried: 0, dead: 0 });
    } finally {
      for (const c of [...handle.closeBeforeServer, ...handle.closers]) await c.close();
    }
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar`
Expected: FAIL. `./app`, `./projections`, `./start` can't be resolved.

- [ ] **Step 4: Projections**

`apps/calendar/src/projections.ts`:

```ts
import { and, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import type { EventEnvelope, EventHandler, OrgRecord, TermRecord, UserRecord } from "@gcpe/events";
import { orgs, terms, TERM_KINDS, users, type TermKind } from "./db/schema";

const isTermKind = (kind: string): kind is TermKind => (TERM_KINDS as readonly string[]).includes(kind);

const onOrg: EventHandler = async (tx, e) => {
  const o = e.data as OrgRecord;
  const row = { key: o.key.toLowerCase(), displayName: o.displayName, abbreviation: o.abbreviation, sortOrder: o.sortOrder, isActive: o.isActive, isHq: o.isHq };
  await tx.insert(orgs).values(row).onConflictDoUpdate({ target: orgs.key, set: row });
};
const onOrgGone: EventHandler = async (tx, e) => {
  await tx.update(orgs).set({ isActive: false }).where(eq(orgs.key, (e.data as { key: string }).key.toLowerCase()));
};
const onTerm: EventHandler = async (tx, e) => {
  const t = e.data as TermRecord;
  if (!isTermKind(t.kind)) return; // services have no Calendar use
  const row = { kind: t.kind, key: t.key.toLowerCase(), displayName: t.displayName ?? t.key, sortOrder: t.sortOrder, isActive: t.isActive };
  await tx.insert(terms).values(row).onConflictDoUpdate({ target: [terms.kind, terms.key], set: row });
};
const onTermGone: EventHandler = async (tx, e) => {
  const d = e.data as { kind: string; key: string };
  if (!isTermKind(d.kind)) return;
  await tx.update(terms).set({ isActive: false }).where(and(eq(terms.kind, d.kind), eq(terms.key, d.key.toLowerCase())));
};
/** Core's user.upserted (spec addendum §4). The whole record replaces the row: role, ministries and active. */
const onUser: EventHandler = async (tx, e) => {
  const u = e.data as UserRecord;
  const row = {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    isActive: u.isActive,
    calendarRole: u.calendarRole,
    organizationKeys: [...new Set(u.organizationKeys.map((k) => k.toLowerCase()))].sort(),
  };
  await tx.insert(users).values(row).onConflictDoUpdate({ target: users.id, set: row });
};

/** Core's reference data and users → the Calendar's projections. Only Core may send these. */
export function projectionHandler(event: EventEnvelope): EventHandler | undefined {
  if (event.source !== "core") return undefined;
  switch (event.type) {
    case "org.upserted":
      return onOrg;
    case "org.deactivated":
      return onOrgGone;
    case "sector.upserted":
    case "theme.upserted":
    case "tag.upserted":
      return onTerm;
    case "sector.deactivated":
    case "theme.deactivated":
    case "tag.deactivated":
      return onTermGone;
    case "user.upserted":
      return onUser;
    default:
      return undefined;
  }
}

/** True until Core's organizations have reached the Calendar; the stack then asks Core to republish. */
export async function needsReferenceData(db: DbOrTx): Promise<boolean> {
  const r = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${orgs}`);
  return r.rows[0]!.n === 0;
}
```

- [ ] **Step 5: The actor**

`apps/calendar/src/actor.ts`:

```ts
import type { RequestHandler } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbOrTx } from "@gcpe/db-kit";
import { CALENDAR_LEVELS, type CalendarRole } from "@gcpe/auth";
import { safeErrorLabel } from "@gcpe/http-kit";
import { orgs, users } from "./db/schema";

/** Who is asking, as the Calendar's projections say now: L(u), M(u) and HQ(u) of spec addendum §6. */
export interface CalendarActor {
  userId: string;
  displayName: string;
  role: CalendarRole;
  level: number;
  ministryKeys: string[];
  isHq: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      calendar?: CalendarActor;
    }
  }
}

const isUuid = (s: string) => z.string().uuid().safeParse(s).success;

/**
 * The caller's Calendar access from the projections, or null for none: a subject that isn't a
 * projected user (break-glass, a service token), an inactive user, or one with no Calendar role.
 * HQ is any of the user's organizations flagged HQ, whether or not it is still active, the same
 * rule as Core's grant checks (Q56).
 */
export async function loadCalendarActor(db: DbOrTx, subject: string): Promise<CalendarActor | null> {
  if (!isUuid(subject)) return null;
  const [u] = await db.select().from(users).where(eq(users.id, subject));
  if (!u || !u.isActive || !u.calendarRole) return null;
  const hq = u.organizationKeys.length
    ? await db.select({ key: orgs.key }).from(orgs).where(and(inArray(orgs.key, u.organizationKeys), eq(orgs.isHq, true))).limit(1)
    : [];
  return { userId: u.id, displayName: u.displayName, role: u.calendarRole, level: CALENDAR_LEVELS[u.calendarRole], ministryKeys: u.organizationKeys, isHq: hq.length > 0 };
}

/**
 * Runs after requireBearer on every /api request. A session cookie's roles were minted at sign-in
 * and can be an hour old, so they are never used here: a revoked grant takes effect as soon as
 * its user.upserted arrives (spec addendum §4).
 */
export function requireCalendarActor(db: Db): RequestHandler {
  return async (req, res, next) => {
    try {
      const actor = req.auth ? await loadCalendarActor(db, req.auth.subject) : null;
      if (!actor) return void res.status(403).json({ error: "no Calendar access" });
      req.calendar = actor;
      next();
    } catch (e) {
      console.error("[calendar] actor lookup failed", safeErrorLabel(e));
      res.status(500).json({ error: "internal error" });
    }
  };
}

/** Every check is "level ≥ n" (spec addendum §4). */
export function requireLevel(min: CalendarRole): RequestHandler {
  return (req, res, next) => ((req.calendar?.level ?? 0) >= CALENDAR_LEVELS[min] ? next() : void res.status(403).json({ error: "forbidden" }));
}
```

- [ ] **Step 6: Routes, app, start, main**

`apps/calendar/src/http/routes.ts`:

```ts
import { Router } from "express";
import type { Db } from "@gcpe/db-kit";

/** The Calendar's /api, mounted behind requireBearer and requireCalendarActor. */
export function apiRoutes(_db: Db): Router {
  const r = Router();
  // What the staff app shows comes from here, never from the session's roles.
  r.get("/me", (req, res) => void res.json(req.calendar));
  return r;
}
```

`apps/calendar/src/app.ts`:

```ts
import express, { type Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { requireBearer, type BearerOptions } from "@gcpe/auth";
import { createEventReceiver } from "@gcpe/events";
import { healthRoutes, jsonErrorHandler } from "@gcpe/http-kit";
import { requireCalendarActor } from "./actor";
import { apiRoutes } from "./http/routes";
import { projectionHandler } from "./projections";

export interface AppDeps {
  db: Db;
  auth: BearerOptions;
  loginRouter?: Router | null;
  eventSecrets: Record<string, string>;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // one hop: OpenShift router / SiteGround nginx
  app.use(healthRoutes([() => deps.db.execute(sql`SELECT 1`)]));
  // Before any body parser: signatures cover the raw bytes.
  app.use(createEventReceiver({ db: deps.db, secrets: deps.eventSecrets, handlers: projectionHandler }));
  if (deps.loginRouter) app.use(deps.loginRouter);
  // Authenticate and resolve the Calendar actor before parsing, so a caller without Calendar
  // access can't make us buffer a body.
  app.use("/api", requireBearer(deps.auth), requireCalendarActor(deps.db), express.json({ limit: "100kb" }), apiRoutes(deps.db));
  app.use(jsonErrorHandler({ logPrefix: "[calendar]" }));
  return app;
}
```

`apps/calendar/src/start.ts`:

```ts
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type express from "express";
import { authFromEnv } from "@gcpe/auth";
import { assertTimeZoneRules, eventSecretsSchema, loadTenantConfig, parseEnv } from "@gcpe/config";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { dispatchOnce, parseSubscribers, startDispatcher } from "@gcpe/events";
import type { Closer } from "@gcpe/http-kit";
import { createApp } from "./app";
import { needsReferenceData } from "./projections";

export const calendarEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().default(3007),
  EVENT_SUBSCRIBERS: z.string().optional(),
  EVENT_SECRETS: eventSecretsSchema,
  MIGRATIONS_FOLDER: z.string().default(fileURLToPath(new URL("../migrations", import.meta.url))),
  TENANT_CONFIG: z.string().default(fileURLToPath(new URL("../../../config/tenants/bc.json", import.meta.url))),
});

export interface AppHandle {
  app: express.Express;
  port: number;
  workers: Record<string, () => Promise<unknown>>;
  startLoops(): void;
  closeBeforeServer: Closer[];
  closers: Closer[];
}

/** Parses env, checks the tenant's tzdata, runs migrations, and builds the app and its dispatcher. */
export async function startCalendar(env: NodeJS.ProcessEnv): Promise<AppHandle> {
  const parsed = parseEnv(calendarEnvSchema, env);
  // Freeze windows and every BC time shown depend on tzdata ≥ 2026b (permanent UTC−7 from 2026-11-01).
  assertTimeZoneRules(loadTenantConfig(parsed.TENANT_CONFIG));
  const auth = authFromEnv(env);
  const { db, pool } = createDb(parsed.DATABASE_URL);
  await runMigrations(db, parsed.MIGRATIONS_FOLDER);
  const subscribers = parseSubscribers(parsed.EVENT_SUBSCRIBERS);
  const app = createApp({ db, auth: auth.bearer, loginRouter: auth.loginRouter, eventSecrets: parsed.EVENT_SECRETS });

  let stopDispatcher: (() => Promise<void>) | undefined;
  return {
    app,
    port: parsed.PORT,
    workers: {
      // Nothing emits yet; activity.* arrives with the activity rules.
      dispatch: () => dispatchOnce({ db, subscribers }),
      needsReferenceData: () => needsReferenceData(db),
    },
    startLoops() {
      stopDispatcher = startDispatcher({ db, subscribers });
    },
    closeBeforeServer: [],
    closers: [
      { name: "event dispatcher", close: async () => { await stopDispatcher?.(); } },
      { name: "db pool", close: () => pool.end() },
    ],
  };
}
```

`apps/calendar/src/main.ts`:

```ts
import { closeServer, createShutdown } from "@gcpe/http-kit";
import { startCalendar } from "./start";

const handle = await startCalendar(process.env);
handle.startLoops();
const server = handle.app.listen(handle.port, () => console.log(`[calendar] listening on ${handle.port}`));

const shutdown = createShutdown({
  logPrefix: "[calendar]",
  exit: process.exit,
  closers: [...handle.closeBeforeServer, { name: "http server", close: () => closeServer(server) }, ...handle.closers],
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown());
}
```

- [ ] **Step 7: Run the tests and type-check**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar` and `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: PASS and clean. If `dispatchOnce` returns a shape other than `{ delivered, retried, dead }` for an empty outbox, assert what it returns (read `packages/events/src/dispatcher.ts`).

- [ ] **Step 8: Commit**

```bash
git add apps/calendar
git commit -m "feat(calendar): Core projections, per-request Calendar actor, GET /api/me"
```

---

### Task 6: Mount the Calendar in the stack, and the seventh database

Covers spec §5.1 (stack mount, tick, local-admin route behind the login limiter), carry-forward "Calendar subscriber", D11.

**Files:**
- Modify: `apps/stack/src/env.ts` (+ `env.test.ts`), `apps/stack/src/stack.ts` (+ `stack.test.ts`, `stack-check.test.ts`), `apps/stack/src/main.ts`.
- Modify: `scripts/siteground-env.ts` (+ `tests/siteground-env.test.ts`), `scripts/build-siteground.mjs`.
- Modify: `tests/e2e/global-setup.ts`.

**Interfaces:**
- Consumes: `startCalendar`, `calendarEnvSchema`, `AppHandle` (Task 5); `createCalendarTestDb` (Task 4).
- Produces:
  - `APP_PREFIXES` gains `"CALENDAR"`; `calendarConfigured(env: NodeJS.ProcessEnv): boolean`; `eventRoutesFor(env)`; `internalEventEnv(stackSecret, routes = INTERNAL_EVENT_ROUTES)`.
  - A Core → Calendar route `{ from: "CORE", source: "core", to: "CALENDAR", name: "calendar", url: "self:/calendar/events", types: [...] }`.
  - The stack serves `/calendar/*` (or 503 `{ error: "calendar not configured" }`), tick step `calendar.dispatch`, health entry `calendar`, `--check` entry `calendar`.

- [ ] **Step 1: Write the failing tests**

In `apps/stack/src/env.test.ts`, add:

```ts
describe("Calendar routing", () => {
  const SECRET = "x".repeat(40);
  const coreSubscribers = (env: NodeJS.ProcessEnv) => JSON.parse(envFor({ ...env, STACK_EVENT_SECRET: SECRET }, "CORE").EVENT_SUBSCRIBERS!) as { name: string; types: string[] }[];

  it("routes Core's user, organization and term events to the Calendar, by explicit type, when the Calendar is configured", () => {
    const calendar = coreSubscribers({ CALENDAR_DATABASE_URL: "postgres://x/cal" }).find((s) => s.name === "calendar");
    expect(calendar?.types.sort()).toEqual(
      ["org.deactivated", "org.upserted", "sector.deactivated", "sector.upserted", "tag.deactivated", "tag.upserted", "theme.deactivated", "theme.upserted", "user.upserted"],
    );
    expect(envFor({ CALENDAR_DATABASE_URL: "postgres://x/cal", STACK_EVENT_SECRET: SECRET }, "CALENDAR").EVENT_SECRETS).toBeDefined();
  });

  it("no Calendar route when the Calendar isn't configured", () => {
    expect(coreSubscribers({}).some((s) => s.name === "calendar")).toBe(false);
  });

  it("still never routes user.* to the News API", () => {
    const newsApi = coreSubscribers({ CALENDAR_DATABASE_URL: "postgres://x/cal" }).find((s) => s.name === "news-api");
    expect(newsApi?.types.some((t) => t.startsWith("user."))).toBe(false);
  });

  it("strips the CALENDAR_ prefix", () => {
    expect(envFor({ CALENDAR_DATABASE_URL: "postgres://x/cal" }, "CALENDAR").DATABASE_URL).toBe("postgres://x/cal");
  });
});
```

In `apps/stack/src/stack.test.ts`:
- `setupStack` gains `calendar?: boolean` (default `true`). When true it also creates `createCalendarTestDb()` (import from `../../calendar/test/helpers`), adds it to `StackTestInstanceDbs` as `calendar?: TestDatabase`, sets `env.CALENDAR_DATABASE_URL`, and drops it in `close()`.
- In `describe("apps/stack")`, add:

```ts
  it("a ministry saved in Core shows up in the Calendar's organizations after a tick", async () => {
    const putRes = await fetch(`${instance.stackUrl}/core/api/organizations/${healthOrg.key}`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${instance.adminToken}` },
      body: JSON.stringify(healthOrg),
    });
    expect(putRes.status).toBe(200);
    expect((await fetch(`${instance.stackUrl}/stack/tick`, { method: "POST", headers: { authorization: `Bearer ${instance.tickToken}` } })).status).toBe(200);
    const rows = await instance.dbs.calendar!.pool.query<{ key: string }>("SELECT key FROM orgs WHERE key = $1", [healthOrg.key]);
    expect(rows.rows).toEqual([{ key: healthOrg.key }]);
  });

  it("the Calendar answers under /calendar, and /stack/health lists it", async () => {
    expect((await fetch(`${instance.stackUrl}/calendar/health/ready`)).status).toBe(200);
    expect((await fetch(`${instance.stackUrl}/calendar/api/me`)).status).toBe(401);
    const health = (await (await fetch(`${instance.stackUrl}/stack/health`)).json()) as { apps: Record<string, boolean> };
    expect(health.apps.calendar).toBe(true);
  });
```

- Add a new describe:

```ts
describe("apps/stack: without CALENDAR_DATABASE_URL", () => {
  let instance: StackTestInstance;
  beforeAll(async () => {
    instance = await setupStack({ calendar: false });
  });
  afterAll(async () => {
    await instance.close();
  });

  it("without CALENDAR_DATABASE_URL the stack starts and /calendar answers 503", async () => {
    const res = await fetch(`${instance.stackUrl}/calendar/api/me`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "calendar not configured" });
    const health = await fetch(`${instance.stackUrl}/stack/health`);
    expect(health.status).toBe(200);
    expect(((await health.json()) as { apps: Record<string, boolean> }).apps).not.toHaveProperty("calendar");
  });

  it("Core queues nothing for the Calendar", async () => {
    await fetch(`${instance.stackUrl}/core/api/organizations/${healthOrg.key}`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${instance.adminToken}` },
      body: JSON.stringify(healthOrg),
    });
    const r = await instance.dbs.core.pool.query("SELECT 1 FROM outbox_deliveries WHERE subscriber = 'calendar'");
    expect(r.rowCount).toBe(0);
  });
});
```

In `apps/stack/src/stack-check.test.ts`, add (mirroring the file's own env builder; `DB(name)` and the base env are the file's):

```ts
  it("checks the Calendar when CALENDAR_DATABASE_URL is set, and reports it skipped when not", async () => {
    const withCal = await checkStack({ ...baseEnv, CALENDAR_DATABASE_URL: DB("calendar") });
    expect(withCal.apps.calendar).toMatchObject({ ok: true });
    const without = await checkStack(baseEnv);
    expect(without.apps.calendar).toEqual({ ok: true, skipped: "CALENDAR_DATABASE_URL is not set" });
  });
```

In `tests/siteground-env.test.ts`, add `calendar: "gcpe_calendar"` to the `dbNames` fixture and:

```ts
  it("writes CALENDAR_DATABASE_URL when a Calendar database is named, and leaves it out when blank", () => {
    expect(buildEnvText({ ...input, dbNames: { ...input.dbNames, calendar: "gcpe_calendar" } })).toMatch(/^CALENDAR_DATABASE_URL=postgres:\/\/.*\/gcpe_calendar$/m);
    expect(buildEnvText({ ...input, dbNames: { ...input.dbNames, calendar: "" } })).not.toMatch(/CALENDAR_DATABASE_URL/);
  });
```

using the file's own name for the text builder (read `scripts/siteground-env.ts`; the function that returns the `KEY=value` block).

- [ ] **Step 2: Run them to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/stack tests/siteground-env.test.ts`
Expected: FAIL. No `CALENDAR` prefix, no Calendar route, no `/calendar` mount.

- [ ] **Step 3: `env.ts`**

```ts
export const APP_PREFIXES = ["CORE", "NRMS", "NEWSAPI", "SITE", "NOD", "DIST", "CALENDAR"] as const;

/** The Calendar runs only where its database exists: a SiteGround site needs it created by hand
 * in Site Tools, so a deploy before then must still start every other app. */
export function calendarConfigured(env: NodeJS.ProcessEnv): boolean {
  return !!env.CALENDAR_DATABASE_URL;
}
```

Add to `INTERNAL_EVENT_ROUTES`, after the Core → NoD route:

```ts
  {
    // The Calendar's projections (spec addendum §4, §5.2). user.* goes here and nowhere public.
    from: "CORE", source: "core", to: "CALENDAR", name: "calendar", url: "self:/calendar/events",
    types: ["org.upserted", "org.deactivated", "user.upserted", "sector.upserted", "sector.deactivated", "theme.upserted", "theme.deactivated", "tag.upserted", "tag.deactivated"],
  },
```

Add, and use:

```ts
type EventRoute = (typeof INTERNAL_EVENT_ROUTES)[number];

/** The routes this deployment wires: every route, less the Calendar's when it isn't configured. */
export function eventRoutesFor(env: NodeJS.ProcessEnv): readonly EventRoute[] {
  return calendarConfigured(env) ? INTERNAL_EVENT_ROUTES : INTERNAL_EVENT_ROUTES.filter((r) => r.from !== "CALENDAR" && r.to !== "CALENDAR");
}
```

Change `routeSecret`'s parameter type to `EventRoute`, `internalEventEnv(stackSecret: string, routes: readonly EventRoute[] = INTERNAL_EVENT_ROUTES)` iterating `routes`, and in `envFor`: `if (env.STACK_EVENT_SECRET) Object.assign(view, internalEventEnv(env.STACK_EVENT_SECRET, eventRoutesFor(env))[prefix]);`.

- [ ] **Step 4: `stack.ts`**

- Import `calendarEnvSchema`, `startCalendar` and `type AppHandle as CalendarHandle` from `../../calendar/src/start`, and `calendarConfigured` from `./env`.
- After `const distEnv = …`: `const calendarEnv = resolvedEnvFor(env, "CALENDAR", dataDir);`
- After NoD starts:

```ts
  const calendar: CalendarHandle | null = calendarConfigured(env) ? await startNamed("Calendar", "CALENDAR", () => startCalendar(calendarEnv)) : null;
  if (!calendar) console.warn("[stack] CALENDAR_DATABASE_URL is not set: the Calendar is not mounted (/calendar answers 503)");
```

- `healthRouter(startedAt: string, withCalendar: boolean)`: build `checks` as today, then `if (withCalendar) checks.push({ name: "calendar", path: "/calendar/health/ready" });`. Call it with `calendar !== null`.
- Add `"/calendar/auth/local/token"` to the combined login limiter's path list.
- Tick steps: after `{ name: "core.dispatch", … }` insert `...(calendar ? [{ name: "calendar.dispatch", run: worker(calendar, "dispatch") }] : []),`.
- Mount, after `/nod`: 

```ts
  app.use(
    "/calendar",
    calendar ? calendar.app : (_req: express.Request, res: express.Response) => void res.status(503).json({ error: "calendar not configured" }),
  );
```

- The backfill block becomes:

```ts
  void (async () => {
    try {
      const nodNeeds = (await worker(nod, "needsReferenceData")()) === true;
      const calendarNeeds = calendar ? (await worker(calendar, "needsReferenceData")()) === true : false;
      if (nodNeeds || calendarNeeds) {
        const n = await worker(core, "republish")();
        console.log(`[stack] ${[nodNeeds && "NoD", calendarNeeds && "the Calendar"].filter(Boolean).join(" and ")} had no reference data; Core republished ${String(n)} records`);
      }
    } catch (e) {
      console.error("[stack] reference-data backfill failed", safeErrorLabel(e));
    }
  })();
```

  (import `safeErrorLabel` from `@gcpe/http-kit`; the old line logged `e.message`, which breaks the logging constraint.) Update the stack test that asserts the old "NoD had no lists" log text, if one does, to the new text. The existing test "GET /stack/health aggregates every app's own readiness" now sees `calendar: true` in `apps` (the shared instance has a Calendar); add it to that test's expected object if it compares exactly.
- `startLoops`: `calendar?.startLoops();` after `nod.startLoops()`. `closeBeforeServer` and `closers`: insert `...(calendar?.closeBeforeServer ?? [])` after NoD's, and `...(calendar?.closers ?? [])` before NoD's in the reversed list.
- `checkStack`: add `{ label: "calendar", prefix: "CALENDAR", schema: calendarEnvSchema }` to `checks` only when `calendarConfigured(env)`; otherwise set `apps.calendar = { ok: true, skipped: "CALENDAR_DATABASE_URL is not set" }` and print nothing else. Add `skipped?: string` to `StackCheckAppResult`.

In `apps/stack/src/main.ts`, add `CALENDAR_MIGRATIONS_FOLDER: "calendar",` to `ARTIFACT_MIGRATIONS_DIRS`.

- [ ] **Step 5: Deploy tooling and e2e setup**

`scripts/build-siteground.mjs`: add `"calendar"` to `APPS`, and `CALENDAR_DATABASE_URL: "postgres://user:pass@127.0.0.1:1/calendar",` to the placeholder env of the build-time `--check`.

`scripts/siteground-env.ts`:
- `dbNames` type gains `calendar: string`.
- In the env text, after the NoD block:

```ts
    // The Calendar's database is created by hand in Site Tools; until it exists the stack runs without it.
    ...(input.dbNames.calendar ? ["", `CALENDAR_DATABASE_URL=${dbUrl(input.dbUser, input.dbPassword, input.dbNames.calendar)}`] : []),
```

- Non-interactive: `calendar: env.SITEGROUND_DB_NAME_CALENDAR ?? "",`; interactive: `calendar: await p.plain("Database name for the Calendar (blank until it exists in Site Tools)", ""),`. The prefix prompt text says "defaults for the database names below". Update the module doc comment's list of `SITEGROUND_*` vars.

`tests/e2e/global-setup.ts`: import `createCalendarTestDb` from `../../apps/calendar/test/helpers`; add it to the `Promise.all` and to `dbs` as `calendar`; set `CALENDAR_DATABASE_URL: calendar.url` in `env`; `process.env.E2E_CALENDAR_DATABASE_URL = calendar.url;` next to the others.

- [ ] **Step 6: Run the tests and type-check**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/stack tests/siteground-env.test.ts tests/build-siteground-guard.test.ts` and the root `tsc`.
Expected: PASS and clean.

- [ ] **Step 7: Commit**

```bash
git add apps/stack scripts tests
git commit -m "feat(stack): mount the Calendar at /calendar when its database is configured; Core routes users and reference data to it"
```

---

### Task 7: The lookup admin API

Covers spec §5.3 (generic screen's server side, legacy lock-down, C140), D13.

**Files:**
- Create: `apps/calendar/src/lookups.ts` (+ `lookups.test.ts`).
- Create: `apps/calendar/src/http/lookup-routes.ts` (+ `lookup-routes.test.ts`).
- Modify: `apps/calendar/src/http/routes.ts` (mount).

**Interfaces:**
- Consumes: the lookup tables (Task 4); `requireLevel`, `req.calendar` (Task 5); test helpers (Task 5).
- Produces:
  - `LOOKUP_NAMES` (`"categories" | "cities" | "comm-materials" | "event-planners" | "government-representatives" | "initiatives" | "keywords" | "nr-distributions" | "nr-origins" | "premier-requested" | "videographers"`), `type LookupName`, `type ExtraKey = "phone" | "jobTitle" | "description" | "shortName"`.
  - `interface LookupDef { name; label; singular; table; minRole: CalendarRole; nameMax: number; extras: readonly { key: ExtraKey; label: string; max: number }[] }`; `LOOKUPS: Readonly<Record<LookupName, LookupDef>>`; `lookupDef(name: string): LookupDef | null`; `canEditLookup(def, level): boolean`.
  - `interface LookupRow { id: number; name: string; sortOrder: number; isActive: boolean; extras: Partial<Record<ExtraKey, string | null>> }`.
  - `lookupInputSchema(def)` → `{ name: string; extras: Partial<Record<ExtraKey, string | null>>; isActive?: boolean }`.
  - `listLookupRows(db, def)`, `createLookupRow(db, def, input)`, `updateLookupRow(db, def, id, input)`, `reorderLookup(db, def, ids: number[])`.
  - Errors: `DuplicateLookupNameError`, `LookupRowNotFoundError`, `StaleLookupOrderError`.
  - HTTP (all behind `requireLevel("Calendar.Administrator")`):
    - `GET /api/lookups` → `LookupSummary[]` = `{ name, label, singular, editable, minRole, nameMax, extras }[]`;
    - `GET /api/lookups/:name` → `LookupSummary & { rows: LookupRow[] }`;
    - `POST /api/lookups/:name` → 201 `LookupRow`;
    - `PUT /api/lookups/:name/order { ids: number[] }` → `LookupRow[]`;
    - `PUT /api/lookups/:name/:id { name, extras, isActive? }` → `LookupRow`.

- [ ] **Step 1: Write the failing tests**

`apps/calendar/src/lookups.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCalendarTestDb } from "../test/helpers";
import { createLookupRow, DuplicateLookupNameError, listLookupRows, LOOKUPS, lookupInputSchema, reorderLookup, StaleLookupOrderError, updateLookupRow } from "./lookups";

describe("lookup service", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCalendarTestDb();
  });
  afterAll(() => tdb.drop());
  const keywords = LOOKUPS.keywords;
  const planners = LOOKUPS["event-planners"];

  it("legacy's lock-down: seven lookups are SysAdmin-only, four are Administrator and above (spec addendum §5.3)", () => {
    const by = (role: string) => Object.values(LOOKUPS).filter((d) => d.minRole === role).map((d) => d.name).sort();
    expect(by("Calendar.SysAdmin")).toEqual(["categories", "cities", "comm-materials", "government-representatives", "nr-distributions", "nr-origins", "premier-requested"]);
    expect(by("Calendar.Administrator")).toEqual(["event-planners", "initiatives", "keywords", "videographers"]);
  });

  it("creates rows at the end of the order, trims, and keeps extra fields", async () => {
    const a = await createLookupRow(tdb.db, keywords, lookupInputSchema(keywords).parse({ name: "  Sample keyword  " }));
    const b = await createLookupRow(tdb.db, keywords, lookupInputSchema(keywords).parse({ name: "Second keyword" }));
    expect(a).toMatchObject({ name: "Sample keyword", isActive: true });
    expect(b.sortOrder).toBe(a.sortOrder + 1);
    const p = await createLookupRow(tdb.db, planners, lookupInputSchema(planners).parse({ name: "Sample Planner", extras: { phone: "250-555-0101", jobTitle: "" } }));
    expect(p.extras).toEqual({ phone: "250-555-0101", jobTitle: null });
  });

  it("refuses an active duplicate name in the same lookup, case-insensitively, but allows it once the other is inactive", async () => {
    const first = await createLookupRow(tdb.db, keywords, lookupInputSchema(keywords).parse({ name: "Duplicate me" }));
    await expect(createLookupRow(tdb.db, keywords, lookupInputSchema(keywords).parse({ name: "DUPLICATE ME" }))).rejects.toBeInstanceOf(DuplicateLookupNameError);
    await updateLookupRow(tdb.db, keywords, first.id, lookupInputSchema(keywords).parse({ name: "Duplicate me", isActive: false }));
    await createLookupRow(tdb.db, keywords, lookupInputSchema(keywords).parse({ name: "duplicate me" }));
    // Reactivating the first would now duplicate an active name.
    await expect(updateLookupRow(tdb.db, keywords, first.id, lookupInputSchema(keywords).parse({ name: "Duplicate me", isActive: true }))).rejects.toBeInstanceOf(DuplicateLookupNameError);
  });

  it("two concurrent creates of one name: exactly one wins", async () => {
    const input = lookupInputSchema(keywords).parse({ name: "Race keyword" });
    const results = await Promise.allSettled([createLookupRow(tdb.db, keywords, input), createLookupRow(tdb.db, keywords, input)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(DuplicateLookupNameError);
  });

  it("reorders by the full id list", async () => {
    const rows = await listLookupRows(tdb.db, keywords);
    const reversed = rows.map((r) => r.id).reverse();
    const after = await reorderLookup(tdb.db, keywords, reversed);
    expect(after.map((r) => r.id)).toEqual(reversed);
    expect(after.map((r) => r.sortOrder)).toEqual(reversed.map((_, i) => i + 1));
  });

  it("a reorder whose id set is stale is refused and changes nothing", async () => {
    const before = await listLookupRows(tdb.db, keywords);
    const stale = before.map((r) => r.id).slice(1); // missing one row, as if it were added after the page loaded
    await expect(reorderLookup(tdb.db, keywords, stale.reverse())).rejects.toBeInstanceOf(StaleLookupOrderError);
    expect(await listLookupRows(tdb.db, keywords)).toEqual(before);
  });

  it("validates names and extras against legacy's column sizes", () => {
    expect(() => lookupInputSchema(LOOKUPS.categories).parse({ name: "x".repeat(51) })).toThrow();
    expect(() => lookupInputSchema(LOOKUPS.categories).parse({ name: "   " })).toThrow();
    expect(() => lookupInputSchema(LOOKUPS["government-representatives"]).parse({ name: "Sample", extras: { description: "x".repeat(85) } })).toThrow();
    expect(() => lookupInputSchema(LOOKUPS.categories).parse({ name: "Sample", extras: { phone: "1" } })).toThrow(); // categories have no extras
  });
});
```

`apps/calendar/src/http/lookup-routes.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import type { CalendarRole } from "@gcpe/auth";
import { createCalendarTestDb, createTestApp, projectOrg, projectUser, sessionCookie } from "../../test/helpers";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("lookup admin routes", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createTestApp>;
  const cookies: Partial<Record<CalendarRole, string>> = {};
  const as = (role: CalendarRole) => cookies[role]!;
  const write = (method: "post" | "put", path: string, role: CalendarRole, body: object) => request(app)[method](path).set("cookie", as(role)).set("x-gcpe-request", "1").send(body);

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    await projectOrg(app, "health");
    const roles: CalendarRole[] = ["Calendar.ReadOnly", "Calendar.Editor", "Calendar.Advanced", "Calendar.Administrator", "Calendar.SysAdmin"];
    for (const [i, role] of roles.entries()) {
      await projectUser(app, { id: id(i + 1), email: `u${i}@example.test`, displayName: `Sample ${role}`, isActive: true, calendarRole: role, organizationKeys: ["health"] });
      cookies[role] = await sessionCookie(id(i + 1));
    }
  });
  afterAll(() => tdb.drop());

  it("is refused below Administrator, on reads and writes (C140)", async () => {
    for (const role of ["Calendar.ReadOnly", "Calendar.Editor", "Calendar.Advanced"] as CalendarRole[]) {
      expect((await request(app).get("/api/lookups").set("cookie", as(role))).status).toBe(403);
      expect((await write("post", "/api/lookups/keywords", role, { name: "Nope" })).status).toBe(403);
    }
  });

  it("an Administrator sees every lookup, editable only where legacy allowed", async () => {
    const res = await request(app).get("/api/lookups").set("cookie", as("Calendar.Administrator"));
    expect(res.status).toBe(200);
    const editable = Object.fromEntries((res.body as { name: string; editable: boolean }[]).map((l) => [l.name, l.editable]));
    expect(editable).toMatchObject({ keywords: true, initiatives: true, "event-planners": true, videographers: true, categories: false, cities: false });
  });

  it("an Administrator changes keywords but not categories; a SysAdmin changes both", async () => {
    const kw = await write("post", "/api/lookups/keywords", "Calendar.Administrator", { name: "Sample keyword" });
    expect(kw.status).toBe(201);
    const refused = await write("post", "/api/lookups/categories", "Calendar.Administrator", { name: "Sample category" });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("only a System Administrator can change Categories");
    expect((await write("post", "/api/lookups/categories", "Calendar.SysAdmin", { name: "Sample category" })).status).toBe(201);
  });

  it("renames, deactivates and reactivates a row; GET shows inactive rows too", async () => {
    const created = (await write("post", "/api/lookups/initiatives", "Calendar.Administrator", { name: "Sample initiative", extras: { shortName: "SI" } })).body;
    const renamed = await write("put", `/api/lookups/initiatives/${created.id}`, "Calendar.Administrator", { name: "Renamed initiative", extras: { shortName: "RI" }, isActive: false });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: "Renamed initiative", isActive: false, extras: { shortName: "RI" } });
    const list = await request(app).get("/api/lookups/initiatives").set("cookie", as("Calendar.Administrator"));
    expect(list.body.rows.find((r: { id: number }) => r.id === created.id)).toMatchObject({ isActive: false });
  });

  it("reorders, and refuses a stale order with 409", async () => {
    const rows = (await request(app).get("/api/lookups/keywords").set("cookie", as("Calendar.Administrator"))).body.rows as { id: number }[];
    await write("post", "/api/lookups/keywords", "Calendar.Administrator", { name: "Added meanwhile" });
    const stale = await write("put", "/api/lookups/keywords/order", "Calendar.Administrator", { ids: rows.map((r) => r.id) });
    expect(stale.status).toBe(409);
  });

  it("answers 404 for an unknown lookup or row, 400 for a bad body, 409 for a duplicate active name", async () => {
    expect((await request(app).get("/api/lookups/priorities").set("cookie", as("Calendar.SysAdmin"))).status).toBe(404);
    expect((await write("put", "/api/lookups/keywords/999999", "Calendar.SysAdmin", { name: "x" })).status).toBe(404);
    expect((await write("put", "/api/lookups/keywords/abc", "Calendar.SysAdmin", { name: "x" })).status).toBe(404);
    expect((await write("post", "/api/lookups/keywords", "Calendar.SysAdmin", { name: "" })).status).toBe(400);
    expect((await write("post", "/api/lookups/keywords", "Calendar.SysAdmin", { name: "sample KEYWORD" })).status).toBe(409);
  });

  it("refuses a write without the CSRF header", async () => {
    expect((await request(app).post("/api/lookups/keywords").set("cookie", as("Calendar.SysAdmin")).send({ name: "x" })).status).toBe(403);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/lookups.test.ts apps/calendar/src/http/lookup-routes.test.ts`
Expected: FAIL. `./lookups` can't be resolved; `/api/lookups` 404s.

- [ ] **Step 3: The service**

`apps/calendar/src/lookups.ts`:

```ts
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbOrTx, Tx } from "@gcpe/db-kit";
import { CALENDAR_LEVELS, type CalendarRole } from "@gcpe/auth";

export const LOOKUP_NAMES = [
  "categories", "cities", "comm-materials", "event-planners", "government-representatives", "initiatives",
  "keywords", "nr-distributions", "nr-origins", "premier-requested", "videographers",
] as const;
export type LookupName = (typeof LOOKUP_NAMES)[number];
export type ExtraKey = "phone" | "jobTitle" | "description" | "shortName";
const EXTRA_COLUMNS: Record<ExtraKey, string> = { phone: "phone", jobTitle: "job_title", description: "description", shortName: "short_name" };

export interface LookupDef {
  name: LookupName;
  label: string;
  singular: string;
  table: string;
  minRole: CalendarRole;
  /** Legacy's column size for Name; new values only. */
  nameMax: number;
  extras: readonly { key: ExtraKey; label: string; max: number }[];
}

const SYS: CalendarRole = "Calendar.SysAdmin";
const ADMIN: CalendarRole = "Calendar.Administrator";

/** Legacy's lock-down (Admin/DynamicData/PageTemplates/ListDetails.aspx.cs:34-70; spec addendum §5.3). Sizes from Gcpe.Hub.Database/calendar/Tables. */
export const LOOKUPS: Readonly<Record<LookupName, LookupDef>> = {
  categories: { name: "categories", label: "Categories", singular: "category", table: "categories", minRole: SYS, nameMax: 50, extras: [] },
  cities: { name: "cities", label: "Cities", singular: "city", table: "cities", minRole: SYS, nameMax: 255, extras: [] },
  "comm-materials": { name: "comm-materials", label: "Comm materials", singular: "comm material", table: "comm_materials", minRole: SYS, nameMax: 100, extras: [] },
  "event-planners": {
    name: "event-planners", label: "Event planners", singular: "event planner", table: "event_planners", minRole: ADMIN, nameMax: 100,
    extras: [{ key: "phone", label: "Phone", max: 50 }, { key: "jobTitle", label: "Job title", max: 150 }],
  },
  "government-representatives": {
    name: "government-representatives", label: "Government representatives", singular: "government representative", table: "government_representatives", minRole: SYS, nameMax: 50,
    extras: [{ key: "description", label: "Description", max: 84 }],
  },
  initiatives: { name: "initiatives", label: "HQ initiatives", singular: "initiative", table: "initiatives", minRole: ADMIN, nameMax: 50, extras: [{ key: "shortName", label: "Short name", max: 40 }] },
  keywords: { name: "keywords", label: "HQ tags", singular: "HQ tag", table: "keywords", minRole: ADMIN, nameMax: 255, extras: [] },
  "nr-distributions": { name: "nr-distributions", label: "NR distributions", singular: "NR distribution", table: "nr_distributions", minRole: SYS, nameMax: 50, extras: [] },
  "nr-origins": { name: "nr-origins", label: "NR origins", singular: "NR origin", table: "nr_origins", minRole: SYS, nameMax: 50, extras: [] },
  "premier-requested": { name: "premier-requested", label: "Premier requested", singular: "Premier requested value", table: "premier_requested", minRole: SYS, nameMax: 50, extras: [] },
  videographers: { name: "videographers", label: "Digital (videographers)", singular: "videographer", table: "videographers", minRole: ADMIN, nameMax: 100, extras: [{ key: "jobTitle", label: "Job title", max: 150 }] },
};

export function lookupDef(name: string): LookupDef | null {
  return (LOOKUP_NAMES as readonly string[]).includes(name) ? LOOKUPS[name as LookupName] : null;
}

export function canEditLookup(def: LookupDef, level: number): boolean {
  return level >= CALENDAR_LEVELS[def.minRole];
}

export interface LookupRow {
  id: number;
  name: string;
  sortOrder: number;
  isActive: boolean;
  extras: Partial<Record<ExtraKey, string | null>>;
}

export class DuplicateLookupNameError extends Error {
  override name = "DuplicateLookupNameError";
}
export class LookupRowNotFoundError extends Error {
  override name = "LookupRowNotFoundError";
}
export class StaleLookupOrderError extends Error {
  override name = "StaleLookupOrderError";
}

/** A blank extra becomes null; every value is trimmed and held to legacy's size. */
export function lookupInputSchema(def: LookupDef) {
  const extras = Object.fromEntries(
    def.extras.map((e) => [
      e.key,
      z.string().trim().max(e.max, `${e.label}: at most ${e.max} characters`).nullable().optional().transform((v) => (v ? v : null)),
    ]),
  );
  return z
    .object({
      name: z.string().trim().min(1, "enter a name").max(def.nameMax, `at most ${def.nameMax} characters`),
      extras: z.object(extras).strict().default({}),
      isActive: z.boolean().optional(),
    })
    .strict();
}
export type LookupInput = { name: string; extras: Partial<Record<ExtraKey, string | null>>; isActive?: boolean };

const table = (def: LookupDef) => sql.identifier(def.table);

function columns(def: LookupDef): SQL {
  return sql.join(
    [sql`id`, sql`name`, sql`sort_order AS "sortOrder"`, sql`is_active AS "isActive"`, ...def.extras.map((e) => sql`${sql.identifier(EXTRA_COLUMNS[e.key])} AS ${sql.identifier(e.key)}`)],
    sql`, `,
  );
}

function toRow(def: LookupDef, r: Record<string, unknown>): LookupRow {
  return {
    id: Number(r.id),
    name: String(r.name),
    sortOrder: Number(r.sortOrder),
    isActive: r.isActive === true,
    extras: Object.fromEntries(def.extras.map((e) => [e.key, (r[e.key] as string | null) ?? null])),
  };
}

export async function listLookupRows(db: DbOrTx, def: LookupDef): Promise<LookupRow[]> {
  const r = await db.execute<Record<string, unknown>>(sql`SELECT ${columns(def)} FROM ${table(def)} ORDER BY sort_order, lower(name), id`);
  return r.rows.map((row) => toRow(def, row));
}

/** The lookup's aggregate lock: every write to one lookup takes it first, so a name check and the
 * write that relies on it can't interleave with another admin's. */
async function lockLookup(tx: Tx, def: LookupDef): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`calendar-lookup:${def.name}`}))`);
}

async function assertNameFree(tx: Tx, def: LookupDef, name: string, exceptId: number | null): Promise<void> {
  const except = exceptId === null ? sql`` : sql` AND id <> ${exceptId}`;
  const r = await tx.execute(sql`SELECT 1 FROM ${table(def)} WHERE is_active AND lower(name) = lower(${name})${except} LIMIT 1`);
  if (r.rows.length > 0) throw new DuplicateLookupNameError();
}

export async function createLookupRow(db: Db, def: LookupDef, input: LookupInput): Promise<LookupRow> {
  return db.transaction(async (tx) => {
    await lockLookup(tx, def);
    await assertNameFree(tx, def, input.name, null);
    const cols = [sql.identifier("name"), sql.identifier("sort_order"), ...def.extras.map((e) => sql.identifier(EXTRA_COLUMNS[e.key]))];
    const vals = [sql`${input.name}`, sql`(SELECT coalesce(max(sort_order), 0) + 1 FROM ${table(def)})`, ...def.extras.map((e) => sql`${input.extras[e.key] ?? null}`)];
    const r = await tx.execute<Record<string, unknown>>(
      sql`INSERT INTO ${table(def)} (${sql.join(cols, sql`, `)}) VALUES (${sql.join(vals, sql`, `)}) RETURNING ${columns(def)}`,
    );
    return toRow(def, r.rows[0]!);
  });
}

/** Replaces the row's name and extras, and its active flag when given. */
export async function updateLookupRow(db: Db, def: LookupDef, id: number, input: LookupInput): Promise<LookupRow> {
  return db.transaction(async (tx) => {
    await lockLookup(tx, def);
    const cur = await tx.execute<{ is_active: boolean }>(sql`SELECT is_active FROM ${table(def)} WHERE id = ${id} FOR UPDATE`);
    if (cur.rows.length === 0) throw new LookupRowNotFoundError();
    if (input.isActive ?? cur.rows[0]!.is_active) await assertNameFree(tx, def, input.name, id);
    const sets = [
      sql`name = ${input.name}`,
      ...def.extras.map((e) => sql`${sql.identifier(EXTRA_COLUMNS[e.key])} = ${input.extras[e.key] ?? null}`),
      ...(input.isActive === undefined ? [] : [sql`is_active = ${input.isActive}`]),
    ];
    const r = await tx.execute<Record<string, unknown>>(sql`UPDATE ${table(def)} SET ${sql.join(sets, sql`, `)} WHERE id = ${id} RETURNING ${columns(def)}`);
    return toRow(def, r.rows[0]!);
  });
}

/** Sets sort_order 1..n in the order given. The ids must be exactly the lookup's current rows. */
export async function reorderLookup(db: Db, def: LookupDef, ids: number[]): Promise<LookupRow[]> {
  return db.transaction(async (tx) => {
    await lockLookup(tx, def);
    const cur = await tx.execute<{ id: number }>(sql`SELECT id FROM ${table(def)} ORDER BY id FOR UPDATE`);
    const have = cur.rows.map((r) => Number(r.id));
    const want = [...ids].sort((a, b) => a - b);
    if (have.length !== want.length || have.some((v, i) => v !== want[i])) throw new StaleLookupOrderError();
    // ids are validated integers, so the array literal is safe to build as text.
    const list = `{${ids.join(",")}}`;
    await tx.execute(sql`UPDATE ${table(def)} AS t SET sort_order = o.ord FROM unnest(${list}::int[]) WITH ORDINALITY AS o(id, ord) WHERE t.id = o.id`);
    return listLookupRows(tx, def);
  });
}
```

- [ ] **Step 4: The routes**

`apps/calendar/src/http/lookup-routes.ts`:

```ts
import { Router, type NextFunction, type Request, type Response } from "express";
import { z, ZodError } from "zod";
import type { Db } from "@gcpe/db-kit";
import { requireLevel } from "../actor";
import {
  canEditLookup,
  createLookupRow,
  DuplicateLookupNameError,
  listLookupRows,
  LOOKUPS,
  lookupDef,
  lookupInputSchema,
  LookupRowNotFoundError,
  reorderLookup,
  StaleLookupOrderError,
  updateLookupRow,
  type LookupDef,
} from "../lookups";

class NotFound extends Error {}
class NotEditable extends Error {
  constructor(readonly def: LookupDef) {
    super("not editable");
  }
}

type Params = { name: string; id?: string };
const run = (h: (req: Request<Params>, res: Response) => Promise<void>) => (req: Request<Params>, res: Response, next: NextFunction) =>
  h(req, res).catch((e: unknown) => {
    if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues });
    if (e instanceof NotFound || e instanceof LookupRowNotFoundError) return void res.status(404).json({ error: "not found" });
    if (e instanceof NotEditable) return void res.status(403).json({ error: `only a System Administrator can change ${e.def.label}` });
    if (e instanceof DuplicateLookupNameError) return void res.status(409).json({ error: "an active row with that name already exists" });
    if (e instanceof StaleLookupOrderError) return void res.status(409).json({ error: "the list changed since you loaded it: reload and try again" });
    next(e);
  });

function summary(def: LookupDef, level: number) {
  return { name: def.name, label: def.label, singular: def.singular, editable: canEditLookup(def, level), minRole: def.minRole, nameMax: def.nameMax, extras: def.extras };
}

function defOf(req: Request<Params>): LookupDef {
  const def = lookupDef(req.params.name);
  if (!def) throw new NotFound();
  return def;
}
function editableDefOf(req: Request<Params>): LookupDef {
  const def = defOf(req);
  if (!canEditLookup(def, req.calendar!.level)) throw new NotEditable(def);
  return def;
}
function idOf(req: Request<Params>): number {
  if (!/^\d{1,9}$/.test(req.params.id ?? "")) throw new NotFound();
  return Number(req.params.id);
}

const orderSchema = z.object({ ids: z.array(z.number().int().positive()).max(5000).refine((ids) => new Set(ids).size === ids.length, "duplicate id") }).strict();

/** The generic lookup admin (spec addendum §5.3). Administrators see every lookup; legacy's locked ones need SysAdmin to change. */
export function lookupRoutes(db: Db): Router {
  const r = Router();
  r.use("/lookups", requireLevel("Calendar.Administrator"));
  r.get("/lookups", (req, res) => void res.json(Object.values(LOOKUPS).map((d) => summary(d, req.calendar!.level))));
  r.get("/lookups/:name", run(async (req, res) => {
    const def = defOf(req);
    res.json({ ...summary(def, req.calendar!.level), rows: await listLookupRows(db, def) });
  }));
  r.post("/lookups/:name", run(async (req, res) => {
    const def = editableDefOf(req);
    res.status(201).json(await createLookupRow(db, def, lookupInputSchema(def).parse(req.body)));
  }));
  // Before "/:name/:id", so "order" is never read as a row id.
  r.put("/lookups/:name/order", run(async (req, res) => {
    const def = editableDefOf(req);
    res.json(await reorderLookup(db, def, orderSchema.parse(req.body).ids));
  }));
  r.put("/lookups/:name/:id", run(async (req, res) => {
    const def = editableDefOf(req);
    res.json(await updateLookupRow(db, def, idOf(req), lookupInputSchema(def).parse(req.body)));
  }));
  return r;
}
```

In `apps/calendar/src/http/routes.ts`, `import { lookupRoutes } from "./lookup-routes";`, rename the `_db` parameter to `db`, and add `r.use(lookupRoutes(db));` after `/me`.

- [ ] **Step 5: Run the tests and type-check**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar` and the root `tsc`.
Expected: PASS and clean.

- [ ] **Step 6: Commit**

```bash
git add apps/calendar
git commit -m "feat(calendar): generic lookup admin API with legacy's SysAdmin lock-down (spec addendum §5.3)"
```

---

### Task 8: staff-web: the Calendar section and the lookup screens

Covers spec §8 intro (Calendar section in staff-web, section shown for a Calendar role), §5.3 (the generic screen), §16 (axe on every Calendar screen), D14.

**Files:**
- Create: `apps/staff-web/src/screens/calendar/access.ts` (+ `access.test.ts`), `useCalendarMe.ts`, `CalendarSection.tsx`, `CalendarHome.tsx`.
- Create: `apps/staff-web/src/screens/calendar/lookups/types.ts`, `LookupsScreen.tsx`, `LookupScreen.tsx` (+ `LookupScreen.test.tsx`).
- Create: `apps/staff-web/src/screens/calendar/a11y.test.tsx`.
- Modify: `apps/staff-web/src/router.tsx`, `apps/staff-web/src/shell/AppShell.tsx` (+ `AppShell.test.tsx`), `apps/staff-web/src/shell/HomeRedirect.tsx`.

**Interfaces:**
- Consumes: `GET /calendar/api/me`, the lookup routes (Task 7).
- Produces:
  - `hasCalendarRole(s: { roles: readonly string[] }): boolean`; `CALENDAR_ADMIN_LEVEL = 4`.
  - `interface CalendarMe { userId: string; displayName: string; role: string; level: number; ministryKeys: string[]; isHq: boolean }`.
  - `useCalendarMe(): { me: CalendarMe | null; denied: boolean; error: string | null }`.
  - `CalendarSection` (sub-nav + `<Outlet context={me}/>`), `useCalendarContext(): CalendarMe`.
  - Routes `/hub/calendar`, `/hub/calendar/lookups`, `/hub/calendar/lookups/:name`.
  - `LookupSummary`, `LookupRowView` types.

- [ ] **Step 1: Write the failing tests**

`apps/staff-web/src/screens/calendar/access.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { hasCalendarRole } from "./access";

describe("hasCalendarRole", () => {
  it("is true for any Calendar role and false otherwise", () => {
    expect(hasCalendarRole({ roles: ["Calendar.ReadOnly"] })).toBe(true);
    expect(hasCalendarRole({ roles: ["NRMS.Editor", "Calendar.SysAdmin"] })).toBe(true);
    expect(hasCalendarRole({ roles: ["Core.Admin", "NoD.Admin"] })).toBe(false);
  });
});
```

`apps/staff-web/src/screens/calendar/lookups/LookupScreen.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { LookupScreen } from "./LookupScreen";
import { LookupsScreen } from "./LookupsScreen";

const KEYWORDS = {
  name: "keywords",
  label: "HQ tags",
  singular: "HQ tag",
  editable: true,
  minRole: "Calendar.Administrator",
  nameMax: 255,
  extras: [],
  rows: [
    { id: 1, name: "Sample keyword", sortOrder: 1, isActive: true, extras: {} },
    { id: 2, name: "Second keyword", sortOrder: 2, isActive: false, extras: {} },
  ],
};
const CATEGORIES = { ...KEYWORDS, name: "categories", label: "Categories", singular: "category", editable: false, minRole: "Calendar.SysAdmin", nameMax: 50, rows: [{ id: 58, name: "Sample category", sortOrder: 1, isActive: true, extras: {} }] };

function stub(calls: { url: string; init?: RequestInit }[], respond: (url: string, init?: RequestInit) => Response | undefined = () => undefined) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const custom = respond(url, init);
      if (custom) return custom;
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u1", name: "Pat", email: "pat@x.invalid", roles: ["Calendar.Administrator"] }, expiresAt: new Date().toISOString() });
      if (url === "/calendar/api/lookups") return jsonResponse(200, [KEYWORDS, CATEGORIES].map(({ rows: _r, ...s }) => s));
      if (url === "/calendar/api/lookups/keywords" && !init?.method) return jsonResponse(200, KEYWORDS);
      if (url === "/calendar/api/lookups/categories") return jsonResponse(200, CATEGORIES);
      if (url === "/calendar/api/lookups/keywords" && init?.method === "POST") return jsonResponse(201, { id: 3, name: "New keyword", sortOrder: 3, isActive: true, extras: {} });
      if (url === "/calendar/api/lookups/keywords/order") return jsonResponse(200, [KEYWORDS.rows[1], KEYWORDS.rows[0]]);
      if (url.startsWith("/calendar/api/lookups/keywords/")) return jsonResponse(200, { ...KEYWORDS.rows[0], ...JSON.parse(init!.body as string) });
      throw new Error(`unhandled: ${url}`);
    }),
  );
}

const renderAt = (path: string) =>
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={[path]}>
        <RequireAuth>
          <Routes>
            <Route path="/calendar/lookups" element={<LookupsScreen />} />
            <Route path="/calendar/lookups/:name" element={<LookupScreen />} />
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );

describe("Calendar lookup screens", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("lists every lookup, marking the ones this user can only read", async () => {
    stub([]);
    renderAt("/calendar/lookups");
    await waitFor(() => expect(document.title).toBe("Calendar lookups — GCPE News Staff"));
    expect(await screen.findByRole("link", { name: "HQ tags" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Categories (read only)" })).toBeInTheDocument();
  });

  it("shows rows, active and inactive, and adds a row", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(calls);
    renderAt("/calendar/lookups/keywords");
    await waitFor(() => expect(document.title).toBe("HQ tags — GCPE News Staff"));
    const table = await screen.findByRole("table", { name: "HQ tags" });
    expect(within(table).getByText("Sample keyword")).toBeInTheDocument();
    expect(within(table).getByRole("row", { name: /Second keyword/ })).toHaveTextContent("Inactive");
    const user = userEvent.setup();
    const add = screen.getByRole("form", { name: "Add an HQ tag" });
    await user.type(within(add).getByLabelText("Name"), "New keyword");
    await user.click(within(add).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === "POST")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.init?.method === "POST")!.init!.body as string)).toEqual({ name: "New keyword", extras: {} });
    expect(await screen.findByRole("status")).toHaveTextContent("Added New keyword.");
  });

  it("renames and deactivates a row", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(calls);
    renderAt("/calendar/lookups/keywords");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit Sample keyword" }));
    const form = screen.getByRole("form", { name: "Edit Sample keyword" });
    const name = within(form).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Renamed keyword");
    await user.click(within(form).getByLabelText("Active"));
    await user.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/calendar/api/lookups/keywords/1")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.url === "/calendar/api/lookups/keywords/1")!.init!.body as string)).toEqual({ name: "Renamed keyword", extras: {}, isActive: false });
  });

  it("moves a row up by posting the whole order", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(calls);
    renderAt("/calendar/lookups/keywords");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Move Second keyword up" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/order"))).toBe(true));
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/order"))!.init!.body as string)).toEqual({ ids: [2, 1] });
  });

  it("a read-only lookup has no add, edit or move controls and says who can change it", async () => {
    stub([]);
    renderAt("/calendar/lookups/categories");
    expect(await screen.findByText("Only a System Administrator can change categories.")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: /Add/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Edit|Move/ })).toBeNull();
  });

  it("shows the server's refusal next to the form", async () => {
    stub([], (url, init) => (url === "/calendar/api/lookups/keywords" && init?.method === "POST" ? jsonResponse(409, { error: "an active row with that name already exists" }) : undefined));
    renderAt("/calendar/lookups/keywords");
    const user = userEvent.setup();
    const add = await screen.findByRole("form", { name: "Add an HQ tag" });
    await user.type(within(add).getByLabelText("Name"), "Sample keyword");
    await user.click(within(add).getByRole("button", { name: "Add" }));
    expect(await within(add).findByRole("alert")).toHaveTextContent("an active row with that name already exists");
  });
});
```

`apps/staff-web/src/screens/calendar/a11y.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import axe from "axe-core";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { CalendarSection } from "./CalendarSection";
import { CalendarHome } from "./CalendarHome";
import { LookupsScreen } from "./lookups/LookupsScreen";
import { LookupScreen } from "./lookups/LookupScreen";

async function seriousViolations(container: Element) {
  const results = await axe.run(container, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
  return results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}

const ME = { userId: "u1", displayName: "Pat", role: "Calendar.Administrator", level: 4, ministryKeys: ["health"], isHq: false };
const LOOKUP = { name: "event-planners", label: "Event planners", singular: "event planner", editable: true, minRole: "Calendar.Administrator", nameMax: 100, extras: [{ key: "phone", label: "Phone", max: 50 }], rows: [{ id: 1, name: "Sample Planner", sortOrder: 1, isActive: true, extras: { phone: "250-555-0101" } }] };

function stub() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u1", name: "Pat", email: "pat@x.invalid", roles: ["Calendar.Administrator"] }, expiresAt: new Date().toISOString() });
      if (url === "/calendar/api/me") return jsonResponse(200, ME);
      if (url === "/calendar/api/lookups") return jsonResponse(200, [{ ...LOOKUP, rows: undefined }]);
      if (url === "/calendar/api/lookups/event-planners") return jsonResponse(200, LOOKUP);
      return jsonResponse(200, {});
    }),
  );
}

const at = (path: string) => (
  <SessionProvider>
    <MemoryRouter initialEntries={[path]}>
      <RequireAuth>
        <Routes>
          <Route path="/calendar" element={<CalendarSection />}>
            <Route index element={<CalendarHome />} />
            <Route path="lookups" element={<LookupsScreen />} />
            <Route path="lookups/:name" element={<LookupScreen />} />
          </Route>
        </Routes>
      </RequireAuth>
    </MemoryRouter>
  </SessionProvider>
);

describe("accessibility: Calendar section", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("Calendar home", async () => {
    stub();
    const { container } = render(at("/calendar"));
    await screen.findByRole("heading", { level: 1, name: "Corporate Calendar" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("lookup list", async () => {
    stub();
    const { container } = render(at("/calendar/lookups"));
    await screen.findByRole("link", { name: "Event planners" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("one lookup, with its extra fields", async () => {
    stub();
    const { container } = render(at("/calendar/lookups/event-planners"));
    await screen.findByText("Sample Planner");
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("the no-access message when the projection refuses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u1", name: "Pat", email: "pat@x.invalid", roles: ["Calendar.Editor"] }, expiresAt: new Date().toISOString() });
        if (url === "/calendar/api/me") return jsonResponse(403, { error: "no Calendar access" });
        return jsonResponse(200, {});
      }),
    );
    const { container } = render(at("/calendar"));
    expect(await screen.findByText("You don’t have Calendar access. Ask a Calendar administrator.")).toBeInTheDocument();
    expect(await seriousViolations(container)).toEqual([]);
  });
});
```

In `apps/staff-web/src/shell/AppShell.test.tsx`, add `"Calendar"` to `allLabels` after `"Subscribers"`, and add a case:

```tsx
  it("shows Calendar to any Calendar role, and only to them", async () => {
    await renderShell(["Calendar.ReadOnly"]);
    expect(visibleLabels()).toEqual(["Calendar"]);
  });
```

Adjust every existing expectation in that file that lists visible labels for a role set including a Calendar role (for example a Calendar.Administrator case now shows `["Calendar", "Calendar access"]`).

- [ ] **Step 2: Run them to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/calendar apps/staff-web/src/shell`
Expected: FAIL. The modules don't exist; the nav has no Calendar item.

- [ ] **Step 3: Access, `useCalendarMe`, section and home**

`apps/staff-web/src/screens/calendar/access.ts`:

```ts
/** The Calendar section appears for any Calendar role in the session (spec addendum §8). What
 * each screen offers comes from GET /calendar/api/me, which the server re-derives per request. */
export function hasCalendarRole(s: { roles: readonly string[] }): boolean {
  return s.roles.some((r) => r.startsWith("Calendar."));
}

/** Administrator and above see the Calendar's admin screens (spec addendum §6, "Lookups, users, Transfer"). */
export const CALENDAR_ADMIN_LEVEL = 4;

export interface CalendarMe {
  userId: string;
  displayName: string;
  role: string;
  level: number;
  ministryKeys: string[];
  isHq: boolean;
}
```

`apps/staff-web/src/screens/calendar/useCalendarMe.ts`:

```ts
import { useEffect, useRef, useState } from "react";
import { ApiError, apiFetch } from "../../api/client";
import type { CalendarMe } from "./access";

/** The caller's Calendar access as the server sees it now. `denied` is a 403: no role, inactive, or revoked. */
export function useCalendarMe(): { me: CalendarMe | null; denied: boolean; error: string | null } {
  const [state, setState] = useState<{ me: CalendarMe | null; denied: boolean; error: string | null }>({ me: null, denied: false, error: null });
  const latest = useRef(0);
  useEffect(() => {
    const call = ++latest.current;
    apiFetch<CalendarMe>("/calendar/api/me").then(
      (me) => {
        if (call === latest.current) setState({ me, denied: false, error: null });
      },
      (caught: unknown) => {
        if (call !== latest.current) return;
        if (caught instanceof ApiError && caught.status === 403) setState({ me: null, denied: true, error: null });
        else setState({ me: null, denied: false, error: "Couldn't load your Calendar access." });
      },
    );
  }, []);
  return state;
}
```

`apps/staff-web/src/screens/calendar/CalendarSection.tsx`:

```tsx
import { NavLink, Outlet, useOutletContext } from "react-router";
import { InlineAlert } from "@bcgov/design-system-react-components";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { CALENDAR_ADMIN_LEVEL, type CalendarMe } from "./access";
import { useCalendarMe } from "./useCalendarMe";

/** `/hub/calendar/*`: the Calendar's sub-nav and its screens. Each screen owns its h1 and title,
 * except the messages below, which own theirs. */
export function CalendarSection(): React.JSX.Element {
  const { me, denied, error } = useCalendarMe();
  useDocumentTitle(denied || error ? "Corporate Calendar" : null);
  if (denied || error) {
    return (
      <div className="gcpe-calendar">
        <h1>Corporate Calendar</h1>
        {denied ? <p>You don&rsquo;t have Calendar access. Ask a Calendar administrator.</p> : <InlineAlert variant="danger" role="alert" description={error!} />}
      </div>
    );
  }
  if (!me) return <p>Loading…</p>;
  return (
    <div className="gcpe-calendar">
      <nav aria-label="Calendar sections">
        <ul>
          <li>
            <NavLink to="/calendar" end>
              Calendar
            </NavLink>
          </li>
          {me.level >= CALENDAR_ADMIN_LEVEL && (
            <li>
              <NavLink to="/calendar/lookups">Lookups</NavLink>
            </li>
          )}
        </ul>
      </nav>
      <Outlet context={me} />
    </div>
  );
}

/** The caller's Calendar access, for a screen rendered inside CalendarSection. */
export function useCalendarContext(): CalendarMe {
  return useOutletContext<CalendarMe>();
}
```

`apps/staff-web/src/screens/calendar/CalendarHome.tsx`:

```tsx
import { Link } from "react-router";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { CALENDAR_ADMIN_LEVEL } from "./access";
import { useCalendarContext } from "./CalendarSection";

/** The Calendar's landing page until the activity list exists. */
export function CalendarHome(): React.JSX.Element {
  const me = useCalendarContext();
  useDocumentTitle("Corporate Calendar");
  return (
    <div>
      <h1>Corporate Calendar</h1>
      <p>Activities, the list and reports are on their way. Your Calendar access is in place.</p>
      {me.level >= CALENDAR_ADMIN_LEVEL && (
        <p>
          <Link to="/calendar/lookups">Manage the Calendar&rsquo;s lookups</Link>
        </p>
      )}
    </div>
  );
}
```

`LookupsScreen` and `LookupScreen` must also render outside `CalendarSection` in their own tests, so they don't call `useCalendarContext`; they rely on the server's `editable` flags.

- [ ] **Step 4: Lookup screens**

`apps/staff-web/src/screens/calendar/lookups/types.ts`:

```ts
export interface LookupExtra {
  key: string;
  label: string;
  max: number;
}
export interface LookupSummary {
  name: string;
  label: string;
  singular: string;
  editable: boolean;
  minRole: string;
  nameMax: number;
  extras: LookupExtra[];
}
export interface LookupRowView {
  id: number;
  name: string;
  sortOrder: number;
  isActive: boolean;
  extras: Record<string, string | null>;
}
export interface LookupDetail extends LookupSummary {
  rows: LookupRowView[];
}

/** "an HQ tag", "a city". */
export function withArticle(singular: string): string {
  return `${/^[aeiouAEIOU]|^HQ\b|^NR\b/.test(singular) ? "an" : "a"} ${singular}`;
}
```

`apps/staff-web/src/screens/calendar/lookups/LookupsScreen.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { InlineAlert } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../../api/client";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import type { LookupSummary } from "./types";

/** `/hub/calendar/lookups`: every lookup (spec addendum §5.3). Locked ones are read-only below System Administrator. */
export function LookupsScreen(): React.JSX.Element {
  useDocumentTitle("Calendar lookups");
  const [lookups, setLookups] = useState<LookupSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  useEffect(() => {
    const call = ++latest.current;
    apiFetch<LookupSummary[]>("/calendar/api/lookups").then(
      (l) => {
        if (call === latest.current) setLookups(l);
      },
      () => {
        if (call === latest.current) setError("Couldn't load the lookups.");
      },
    );
  }, []);
  return (
    <div>
      <h1>Calendar lookups</h1>
      <p>The choices offered on activities. Rows are never deleted; deactivate a row to stop offering it.</p>
      {error && <InlineAlert variant="danger" role="alert" description={error} />}
      {lookups === null && !error && <p>Loading…</p>}
      <ul>
        {(lookups ?? []).map((l) => (
          <li key={l.name}>
            <Link to={`/calendar/lookups/${l.name}`}>{l.editable ? l.label : `${l.label} (read only)`}</Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

`apps/staff-web/src/screens/calendar/lookups/LookupScreen.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { Button, InlineAlert } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../../api/client";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { messagesOf } from "../../admin/messages";
import { withArticle, type LookupDetail, type LookupRowView, type LookupSummary } from "./types";

interface Draft {
  name: string;
  extras: Record<string, string>;
  isActive: boolean;
}

function RowForm({ lookup, row, label, submitLabel, onSubmit, onCancel }: {
  lookup: LookupSummary;
  row: LookupRowView | null;
  label: string;
  submitLabel: string;
  onSubmit(draft: Draft): Promise<void>;
  onCancel?(): void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<Draft>({
    name: row?.name ?? "",
    extras: Object.fromEntries(lookup.extras.map((e) => [e.key, row?.extras[e.key] ?? ""])),
    isActive: row?.isActive ?? true,
  });
  const [messages, setMessages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const idBase = `lookup-${lookup.name}-${row?.id ?? "new"}`;
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setMessages([]);
    try {
      await onSubmit(draft);
      if (!row) setDraft({ name: "", extras: Object.fromEntries(lookup.extras.map((x) => [x.key, ""])), isActive: true });
    } catch (caught) {
      setMessages(messagesOf(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form aria-label={label} onSubmit={submit}>
      {messages.map((m) => (
        <p role="alert" key={m}>
          {m}
        </p>
      ))}
      <label htmlFor={`${idBase}-name`}>Name</label>
      <input id={`${idBase}-name`} value={draft.name} maxLength={lookup.nameMax} onChange={(e) => setDraft({ ...draft, name: e.target.value })} disabled={busy} required />
      {lookup.extras.map((x) => (
        <div key={x.key}>
          <label htmlFor={`${idBase}-${x.key}`}>{x.label}</label>
          <input id={`${idBase}-${x.key}`} value={draft.extras[x.key] ?? ""} maxLength={x.max} onChange={(e) => setDraft({ ...draft, extras: { ...draft.extras, [x.key]: e.target.value } })} disabled={busy} />
        </div>
      ))}
      {row && (
        <div>
          <input id={`${idBase}-active`} type="checkbox" checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} disabled={busy} />
          <label htmlFor={`${idBase}-active`}>Active</label>
        </div>
      )}
      <Button type="submit" isDisabled={busy}>
        {submitLabel}
      </Button>
      {onCancel && (
        <Button variant="secondary" onPress={onCancel} isDisabled={busy}>
          Cancel
        </Button>
      )}
    </form>
  );
}

/** `/hub/calendar/lookups/:name`: one lookup's rows (spec addendum §5.3). */
export function LookupScreen(): React.JSX.Element {
  const { name = "" } = useParams();
  const [lookup, setLookup] = useState<LookupDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [orderMessages, setOrderMessages] = useState<string[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const latest = useRef(0);
  useDocumentTitle(lookup?.label ?? null);

  const reload = useCallback(() => {
    const call = ++latest.current;
    apiFetch<LookupDetail>(`/calendar/api/lookups/${encodeURIComponent(name)}`).then(
      (l) => {
        if (call === latest.current) setLookup(l);
      },
      () => {
        if (call === latest.current) setLoadError("Couldn't load this lookup.");
      },
    );
  }, [name]);
  useEffect(() => reload(), [reload]);

  if (loadError) return <InlineAlert variant="danger" role="alert" description={loadError} />;
  if (!lookup) return <p>Loading…</p>;

  const body = (d: Draft) => ({ name: d.name, extras: Object.fromEntries(lookup.extras.map((x) => [x.key, d.extras[x.key] ?? ""])) });
  const add = async (d: Draft) => {
    const created = await apiFetch<LookupRowView>(`/calendar/api/lookups/${lookup.name}`, { method: "POST", body: body(d) });
    setStatus(`Added ${created.name}.`);
    reload();
  };
  const save = (row: LookupRowView) => async (d: Draft) => {
    const saved = await apiFetch<LookupRowView>(`/calendar/api/lookups/${lookup.name}/${row.id}`, { method: "PUT", body: { ...body(d), isActive: d.isActive } });
    setEditing(null);
    setStatus(`Saved ${saved.name}.`);
    reload();
  };
  const move = async (index: number, by: -1 | 1) => {
    const ids = lookup.rows.map((r) => r.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + by, 0, moved!);
    setOrderMessages([]);
    try {
      await apiFetch(`/calendar/api/lookups/${lookup.name}/order`, { method: "PUT", body: { ids } });
      setStatus(`Moved ${lookup.rows[index]!.name} ${by < 0 ? "up" : "down"}.`);
    } catch (caught) {
      setOrderMessages(messagesOf(caught));
    }
    reload();
  };

  return (
    <div>
      <p>
        <Link to="/calendar/lookups">All lookups</Link>
      </p>
      <h1>{lookup.label}</h1>
      {!lookup.editable && <p>Only a System Administrator can change {lookup.label.toLowerCase()}.</p>}
      {status && <p role="status">{status}</p>}
      {orderMessages.map((m) => (
        <p role="alert" key={m}>
          {m}
        </p>
      ))}
      <table>
        <caption>{lookup.label}</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            {lookup.extras.map((x) => (
              <th scope="col" key={x.key}>
                {x.label}
              </th>
            ))}
            <th scope="col">Status</th>
            {lookup.editable && <th scope="col">Actions</th>}
          </tr>
        </thead>
        <tbody>
          {lookup.rows.map((r, i) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              {lookup.extras.map((x) => (
                <td key={x.key}>{r.extras[x.key] ?? ""}</td>
              ))}
              <td>{r.isActive ? "Active" : "Inactive"}</td>
              {lookup.editable && (
                <td>
                  {editing === r.id ? (
                    <RowForm lookup={lookup} row={r} label={`Edit ${r.name}`} submitLabel="Save" onSubmit={save(r)} onCancel={() => setEditing(null)} />
                  ) : (
                    <>
                      <Button variant="secondary" onPress={() => setEditing(r.id)}>{`Edit ${r.name}`}</Button>
                      {i > 0 && <Button variant="tertiary" onPress={() => void move(i, -1)}>{`Move ${r.name} up`}</Button>}
                      {i < lookup.rows.length - 1 && <Button variant="tertiary" onPress={() => void move(i, 1)}>{`Move ${r.name} down`}</Button>}
                    </>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {lookup.editable && (
        <>
          <h2>Add {withArticle(lookup.singular)}</h2>
          <RowForm lookup={lookup} row={null} label={`Add ${withArticle(lookup.singular)}`} submitLabel="Add" onSubmit={add} />
        </>
      )}
    </div>
  );
}
```

The design system's `Button` names its accessible name from its children; the tests match "Edit Sample keyword" and "Move Second keyword up". If the design system version has no `tertiary` variant, use `secondary`.

- [ ] **Step 5: Router, nav and landing**

`router.tsx`: import `CalendarSection`, `CalendarHome`, `LookupsScreen`, `LookupScreen`, and add before `{ path: "users", … }`:

```tsx
      {
        path: "calendar",
        element: <CalendarSection />,
        children: [
          { index: true, element: <CalendarHome /> },
          { path: "lookups", element: <LookupsScreen /> },
          { path: "lookups/:name", element: <LookupScreen /> },
        ],
      },
```

`AppShell.tsx`: import `hasCalendarRole` and add `{ to: "/calendar", label: "Calendar", show: hasCalendarRole },` after Subscribers; add "Calendar is visible to any Calendar role" to the doc comment.

`HomeRedirect.tsx`: after the Calendar access branch, a user with only a Calendar role lands on `/calendar`:

```tsx
  const target = nrms
    ? "/releases/drafts"
    : canReadSubscribers(session)
      ? "/subscribers"
      : canManageCalendarAccess(session)
        ? "/calendar-access"
        : hasCalendarRole(session)
          ? "/calendar"
          : "/releases/drafts";
```

Update its doc comment.

- [ ] **Step 6: Run the tests and type-check**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web` and `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p apps/staff-web/tsconfig.json`
Expected: PASS and clean.

- [ ] **Step 7: Commit**

```bash
git add apps/staff-web
git commit -m "feat(staff-web): Calendar section and the lookup admin screens"
```

---

### Task 9: End to end, parity lists, runbook, carry-forward, and boxs.ca

Covers the 5b exit check's first half ("Lookup admin end to end on boxs.ca", "Event contract tests"), §14/§15 rows, the running notes, and the carry-forward file.

**Files:**
- Create: `tests/e2e/calendar-lookups.spec.ts`.
- Modify: `docs/parity/changes-from-legacy.md`, `docs/parity/open-questions.md`, `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`, `docs/superpowers/plans/phase-5-carry-forward.md`, `docs/superpowers/specs/2026-10-07-calendar-parity-design.md`.

**Interfaces:**
- Consumes: everything above; `apiCall`, `loginForCookie`, `baseUrl`, `tick`, `expectNoSeriousA11yViolations` from `tests/e2e/playwright-support.ts`; `healthOrg` from `apps/core/test/helpers`.
- Produces: docs only.

- [ ] **Step 1: Write the e2e spec**

`tests/e2e/calendar-lookups.spec.ts`:

```ts
// The 5b exit check's lookup half: a Calendar Administrator manages an unlocked lookup and can
// only read a locked one; a System Administrator changes the locked one; the server refuses what
// the screen doesn't offer; a revoked grant is refused on the next request.
import { test, expect } from "@playwright/test";
import { healthOrg } from "../../apps/core/test/helpers";
import { ADMIN_PASSWORD, ADMIN_USERNAME } from "./constants";
import { apiCall, baseUrl, expectNoSeriousA11yViolations, loginForCookie, tick } from "./playwright-support";

test.describe("Calendar lookups", () => {
  test("an Administrator edits HQ tags and reads Categories; a System Administrator edits Categories", async ({ page, context }) => {
    const admin = await loginForCookie(ADMIN_USERNAME, ADMIN_PASSWORD);
    const stamp = Date.now();
    await apiCall(admin, "/core/api/organizations/health", { method: "PUT", body: healthOrg });
    const mk = async (who: string, role: string) => {
      const email = `cal-${who}-${stamp}@example.test`;
      const u = await apiCall<{ id: string }>(admin, "/core/api/users", { method: "POST", body: { email, displayName: `Calendar ${who} ${stamp}`, password: `e2e-cal-${who}-password-1` } });
      await apiCall(admin, `/core/api/calendar-access/${u.id}`, { method: "PUT", body: { role, organizationKeys: ["health"] } });
      return { id: u.id, email, password: `e2e-cal-${who}-password-1` };
    };
    const calAdmin = await mk("admin", "Calendar.Administrator");
    const sysAdmin = await mk("sysadmin", "Calendar.SysAdmin");
    await tick(); // Core's user.upserted and org.upserted reach the Calendar's projections

    const cookie = await loginForCookie(calAdmin.email, calAdmin.password);
    const [name, value] = cookie.split("=", 2) as [string, string];
    await context.addCookies([{ name, value, domain: new URL(baseUrl()).hostname, path: "/", httpOnly: true, secure: false, sameSite: "Lax" }]);

    await page.goto(`${baseUrl()}/hub/calendar/lookups`);
    await expect(page.getByRole("heading", { level: 1, name: "Calendar lookups" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Categories (read only)" })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "Calendar lookups");

    await page.getByRole("link", { name: "HQ tags" }).click();
    const add = page.getByRole("form", { name: "Add an HQ tag" });
    await add.getByLabel("Name").fill(`Sample keyword ${stamp}`);
    await add.getByRole("button", { name: "Add" }).click();
    await expect(page.getByRole("status")).toHaveText(`Added Sample keyword ${stamp}.`);
    await page.getByRole("button", { name: `Edit Sample keyword ${stamp}` }).click();
    const edit = page.getByRole("form", { name: `Edit Sample keyword ${stamp}` });
    await edit.getByLabel("Active").uncheck();
    await edit.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("row", { name: new RegExp(`Sample keyword ${stamp}`) })).toContainText("Inactive");
    await expectNoSeriousA11yViolations(page, "HQ tags");

    await page.goto(`${baseUrl()}/hub/calendar/lookups/categories`);
    await expect(page.getByText("Only a System Administrator can change categories.")).toBeVisible();
    const refused = await fetch(`${baseUrl()}/calendar/api/lookups/categories`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-gcpe-request": "1" },
      body: JSON.stringify({ name: `Sample category ${stamp}` }),
    });
    expect(refused.status).toBe(403);

    const sysCookie = await loginForCookie(sysAdmin.email, sysAdmin.password);
    const created = await fetch(`${baseUrl()}/calendar/api/lookups/categories`, {
      method: "POST",
      headers: { cookie: sysCookie, "content-type": "application/json", "x-gcpe-request": "1" },
      body: JSON.stringify({ name: `Sample category ${stamp}` }),
    });
    expect(created.status).toBe(201);

    // A revoked grant is refused on the very next request with the same cookie.
    await apiCall(admin, `/core/api/calendar-access/${calAdmin.id}`, { method: "PUT", body: { role: null, organizationKeys: [] } });
    await tick();
    expect((await fetch(`${baseUrl()}/calendar/api/me`, { headers: { cookie } })).status).toBe(403);
  });
});
```

`apiCall(cookie, path, { method, body })` adds the CSRF header and JSON body itself (`playwright-support.ts:76-93`).

- [ ] **Step 2: Run the e2e suite**

Run: `npx -y -p node@24 -- npm run test:e2e`
Expected: PASS, including `calendar-access.spec.ts` from 5a and the new spec.

- [ ] **Step 3: Parity rows**

`docs/parity/changes-from-legacy.md`, section "Corporate Calendar (Phase 5)", append:

```markdown
| C162 | Calendar admins could delete lookup rows through Dynamic Data (`Admin/DynamicData/PageTemplates/ListDetails.aspx.cs`) when the table wasn't locked. | Lookup rows are never deleted; they're deactivated. An active row can't repeat another active row's name in the same lookup. | Activities and history reference lookup rows; deleting one would break them or fail. Duplicate names are what made legacy's dropdowns confusing. | Proposed |
| C163 | Calendar admin pages were separate Dynamic Data grids per table. | One lookup screen for all eleven lookups, with legacy's lock-down: categories, cities, comm materials, government representatives, NR distributions, NR origins and Premier requested need a System Administrator; event planners, HQ initiatives, HQ tags and Digital need an Administrator. Administrators see the locked ones read-only. | One screen to learn; the server checks every change (C140). | Agreed (spec §5.3) |
| C164 | Calendar roles came from `calendar.SystemUser` on each request. | The Calendar reads the caller's role, ministries and HQ membership from its copy of Core's users on every request. A removed role takes effect within one event dispatch (about a minute on boxs.ca), not at the next sign-in. Break-glass and service tokens have no Calendar access. | One user store (C125); a session cookie lives up to an hour. | Agreed (carry-forward) |
```

`docs/parity/open-questions.md`: in Q54's "Answered" row, replace "Built in 5b (see …); until then boxs.ca shows them." with "Built in 5b-1: Core's organization `isPublic` flag (Hub → Organizations), set false for GCPEHQ and GCPEMEDIA when the seed or the importer creates them. On boxs.ca the two existing organizations were made non-public by hand." Leave Q56 open; add to its working assumption: "Pinned by the Calendar's test 'a deactivated HQ organization still makes its members HQ'."

- [ ] **Step 4: Running notes**

`docs/manuals/running-notes.md`, append `## Phase 5b-1 — Calendar app, lookups, public organizations`:

```markdown
- **Administrator** — Hub → Calendar → Lookups lists every Calendar lookup. Administrators change event
  planners, HQ initiatives, HQ tags and Digital; the other seven (categories, cities, comm materials,
  government representatives, NR distributions, NR origins, Premier requested) need a System
  Administrator and are read-only for everyone else.
- **Administrator** — Lookup rows are never deleted. Untick Active to stop offering a row; it stays on
  old activities. Two active rows in one lookup can't share a name.
- **Administrator** — Calendar access changes reach the Calendar within a minute (one background
  tick). A person whose role was removed sees "You don't have Calendar access" on their next click,
  without signing out.
- **Administrator** — Core admins choose on Hub → Organizations whether an organization is listed
  publicly. GCPE Headquarters and GCPE Media Relations are not; the Office of the Premier is HQ and public.
- **Operations** — The break-glass admin and service tokens have no Calendar access: the Calendar knows
  only users Core has sent it. Sign in as a real user with a Calendar role to use it.
- **Operations** — The Calendar needs its own database. Until `CALENDAR_DATABASE_URL` is set the stack
  runs without it, `/calendar` answers 503, and `node stack.js --check` prints
  `"calendar": {"ok": true, "skipped": …}`. Phase 7's cutover checklist must confirm it is set.
- **Developer** — The Calendar names ministries, sectors, themes and tags by Core key, not id. Its
  projections (`orgs`, `terms`, `users`) have no foreign keys pointing at them.
```

- [ ] **Step 5: Runbook**

`docs/deploy/siteground.md`:
- "Databases": seven databases; add `gcpe_calendar` to the suggested names, with "The Calendar's database can be added later: the stack runs without it until `CALENDAR_DATABASE_URL` is set."
- New section `## Corporate Calendar (Phase 5b-1)`:
  - **One-time (Paul, Site Tools):** create the `gcpe_calendar` PostgreSQL database for the existing database user; add `CALENDAR_DATABASE_URL=postgres://<user>:<password>@localhost:5432/gcpe_calendar` to the Node.js project's environment; restart. No other setting is needed: the stack derives the Calendar's event secrets from `STACK_EVENT_SECRET`.
  - **Migrations:** Core `0003_org_public` (one column), News API `0002_category_public` (one column), Calendar `0000_init` (new database). All additive.
  - **After the first start with the Calendar:** the stack sees an empty `orgs` table and asks Core to republish once; after the next tick `SELECT count(*) FROM orgs` and `SELECT count(*) FROM users` in `gcpe_calendar` are non-zero.
  - **Q54 on boxs.ca:** on Hub → Organizations, untick "listed publicly" for GCPE Headquarters and GCPE Media Relations (they existed before the flag). Then `curl -s https://boxs.ca/api/Ministries | grep -c gcpe-` prints `0`, and the test subscribe page no longer offers them.
  - **Break-glass:** has no Calendar access, by design.
  - **Hand checks (5b exit, lookup half):** as a user with Calendar.Administrator and a ministry: Hub → Calendar → Lookups; HQ tags: add, rename, deactivate a "Sample keyword …"; Categories shows read-only. As a Calendar.SysAdmin: add and deactivate a "Sample category …". Remove the Administrator's role on Hub → Calendar access, wait one tick, click in the Calendar: "You don't have Calendar access".
- "Known limits": "The Calendar is optional until its database exists (`/calendar` 503)."

- [ ] **Step 6: Carry-forward and spec**

`docs/superpowers/plans/phase-5-carry-forward.md`, § 5b: delete the items taken (see "Carry-forward items taken"), keep "Calendar users screen (§8.5)" and "Calendar test users" (5b-2), and keep "Entra/OIDC matching must never match on a null email" under a new heading `## Entra sign-in (later phase)`. Add:

```markdown
## 5c

- **Dead-letter page.** The Calendar's outbox has a dispatcher but no screen for dead deliveries; build it when the Calendar first emits `activity.*` (spec addendum §5.1).
- **Lock-expiry sweep** on the stack tick (spec addendum §5.1, §7.5), with the `activity_locks` table that 5b-1 created.
- **Tenant `calendar` config section** (spec addendum §5.1): freeze window and zone, release category ids 12 and 58, City "Other…" 311, comm material 61, category names, consultations ministry, contact-ministry exclusions, `SharedWithExcludes`, Translations default list, required-field switches, `ShowHqCommentsField`, `ShowRecordsSection`, cover image, banner text.
- **Transfer** (spec addendum §7.1, §8.5): the API and the screen, with the users screen 5b-2 builds.
- **Deactivation preview** (spec addendum §8.5, `User.aspx:183-223`): list a user's open activities before deactivating, filtered by `visible()`. Legacy listed every activity with that user as an active comm contact, past ones included; "open" here means not deleted and ending today or later.

## 5e

- **`CALENDAR_STORAGE_DIR`** for attachments, outside the deploy folder (spec addendum §5.1, §8.4).

## 5i

- **Sequences:** re-base every legacy-id identity (`activities`, every lookup, `comm_contacts`, `saved_filters`, `activity_files`) above the imported maximum (spec addendum §12.1).
- **Lookup names:** legacy allows a NULL `Name`; the Calendar's `name` is NOT NULL, so map NULL to `""`.
- **Keys, not ids:** legacy ministry GUIDs map to Core organization keys (`contact_ministry_key`, `ministry_key`, `activity_shared_with.ministry_key`), and sectors, themes and tags to term keys.
```

In the spec, §5.2 "Ids and formats", change "Ministries, sectors, themes and tags are Core ids" to "Ministries, sectors, themes and tags are named by Core key (as every event names them), held in local projections (`orgs`, `terms`)", and add under §5.4's table: "`org.upserted` (extended) also adds `isPublic` (Q54)." Commit these spec lines with a message that says they change the approved spec.

- [ ] **Step 7: Final verification**

Run, all under Node 24:
- `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run`;
- both `tsc` commands;
- `npx -y -p node@24 -- npm run test:e2e`.

Then:
- `git diff e4dbf50 | grep -oE "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+" | sort -u`: every result is at `example.test`, `example.com`, `x.invalid` or `example.gov.bc.ca`, or was already present at `e4dbf50`.
- `git diff e4dbf50 -- apps packages scripts | grep -nE "Task [0-9]|\bD[0-9]+\b|\bR[0-9]+\b|fix round"` prints nothing.

- [ ] **Step 8: Commit**

```bash
git add tests/e2e/calendar-lookups.spec.ts docs
git commit -m "test(e2e),docs: Calendar lookups end to end; parity C162-C164, Q54 built; runbook, running notes, carry-forward"
```

- [ ] **Step 9: Deploy to boxs.ca**

Paul authorised test-environment deploys without asking. From a clean worktree: `npx -y -p node@24 -- npm run deploy:siteground`, then the printed `git push --force origin deploy/siteground:deploy/siteground`. Check `https://boxs.ca/stack/health` is 200 and `https://boxs.ca/calendar/api/me` answers 503 (no Calendar database yet) or 401 (once it exists). Do the Q54 hand step (untick "listed publicly" for the two GCPE organizations, through `PUT /core/api/organizations/:key/public` with a minted local token as in earlier phases, or the screen). Leave Paul a note that the lookup hand checks wait for the one Site Tools step (create `gcpe_calendar`, set `CALENDAR_DATABASE_URL`).

---

## Risks and things to watch

- **The seventh database is a manual step (D11).** Until Paul creates it, boxs.ca runs without the Calendar and the lookup half of the exit check can't be done there. Everything else deploys. *Verified:* the database user can't `CREATE DATABASE` (`docs/deploy/siteground.md` "One-time setup").
- **drizzle-kit's rendering of the CHECK constraints.** The schema builds the `needs_review` list with `sql.raw`; the generated SQL must contain the literal 23 keys. *Assumed* drizzle-kit 0.31 emits check expressions verbatim; Task 4's tests (an unknown key is refused) prove the constraint exists either way.
- **`unnest(…) WITH ORDINALITY` reorder** needs Postgres ≥ 9.4. *Assumed* for boxs.ca: the platform already runs there (drizzle migrations, `FOR UPDATE SKIP LOCKED`), but its server version was not re-read for this plan. Task 9's hand check (move a keyword up) settles it on the first deploy.
- **Projection lag is visible to admins.** A Calendar access change in Core reaches the Calendar on the next tick. On boxs.ca that is up to a minute plus any idle-kill restart. The running notes say so.
- **News API `getMinister` for a hidden ministry is a 404.** *Inferred* nothing public links to the two GCPE organizations (the live legacy API lists none); a release whose lead ministry is GCPE would render without a minister.

## Self-review (done while writing)

- **Spec coverage (5b, first half):**
  - §5.1 App: package and conventions (Task 4), receiver and inbox (Task 5), outbox dispatcher and tick step (Tasks 5, 6), session cookie and CSRF (Task 5's `requireBearer`; Task 7's CSRF test), local-admin route behind the stack-wide limiter (Task 6), Rule 3 (Task 5's start test with Core and NRMS absent). Dead-letter page, lock sweep, storage dir and tenant section deferred with reasons (D12) and written into the carry-forward (Task 9).
  - §5.2 Tables: every table in Task 4, with legacy ids (D4), keys (D2), and the not-carried-over items left out.
  - §5.3 Lookup admin: Tasks 7 and 8, lock-down as legacy, server checks (C140), comm contacts and Core-owned taxonomies excluded.
  - §5.4 Events: Task 1, including the id-only confidential form; consumer tests for `user.upserted` and `org.upserted` with `isHq` in Task 5. `activity.*` and `release.status_changed` producers and consumers are 5c and 5h.
  - §6: M(u), HQ(u), L(u) per request (Task 5). `visible()` itself is 5c.
  - §8.5 users screen and Transfer, the spike (§10.1) and Calendar test users: 5b-2.
  - Carry-forward items: table above.
- **Placeholders:** none. Three steps describe mechanical edits by rule rather than listing every line: Task 1 Step 4 (add `isPublic: true` to literals `tsc` names), Task 2 Step 1 (reuse the route test file's own auth helper names), and Task 6 Step 1 (reuse `stack-check.test.ts`'s and `siteground-env.test.ts`'s own builders). Each says exactly what changes.
- **Type consistency:** `CalendarActor` (Task 5) is what `/me` returns and what staff-web's `CalendarMe` mirrors (Task 8). `LookupDef`, `LookupRow`, `lookupInputSchema` (Task 7) match the route bodies and staff-web's `LookupSummary`/`LookupRowView` (Task 8). `OrgRecord.isPublic` (Task 1) is read by Core (Task 2), the News API and NoD (Task 3) and the Calendar's `orgRecord` helper (Task 5). `calendarConfigured` and `eventRoutesFor` (Task 6) are the only gates on the Calendar's presence.
- **Review Focus:** each line names its pinning test, and each test is in its task's code.
