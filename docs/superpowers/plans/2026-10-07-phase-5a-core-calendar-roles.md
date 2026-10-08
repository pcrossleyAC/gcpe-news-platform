# Phase 5a: Core Calendar Roles, Ministry Scope and HQ Organizations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Core holds who may use the Corporate Calendar: one ministry-scoped Calendar role per user (ReadOnly < Editor < Advanced < Administrator < SysAdmin), the user's ministries, and HQ organizations (GCPEHQ and GCPEMEDIA). A Calendar Administrator grants roles up to Administrator, never SysAdmin, through server-gated Core routes and a staff-web screen. Users without an email exist, but only as inactive users who can't sign in. Every change reaches subscribers as `user.upserted`, and `org.upserted` carries `isHq`.

**Architecture:**
- **Roles (`packages/auth`):**
  - `CALENDAR_ROLES` sits beside the flat `STAFF_ROLES`, never inside it.
  - `calendar-roles.ts` holds the pure grant rules: levels, `grantCeiling`, `checkCalendarGrant`. It has no runtime imports, so staff-web's mirror is tested against it directly.
- **Core data:** one additive migration, `0002_calendar_access`:
  - `organizations.is_hq`;
  - `users.email` nullable, with a check that an active user has one;
  - `user_organizations`, the user's ministries M(u);
  - `user_legacy_ids`, created now and written by 5i;
  - a partial unique index allowing one `Calendar.*` row per user in `role_grants`.
- **Core services:**
  - `users.ts` reports flat roles, the Calendar role and ministry keys separately. A session carries both kinds of role.
  - Every user write emits `user.upserted` in its own transaction, under the user's aggregate lock.
  - `calendar-access.ts` is the one place a Calendar role or ministry set changes. It enforces C125 and this plan's rulings.
  - `organizations.ts` gains `setOrganizationHq`. An upsert that omits `isHq` keeps the stored flag.
- **Core HTTP:**
  - `GET` and `PUT /api/calendar-access[/:id]`, for Core.Admin, Calendar.Administrator and Calendar.SysAdmin.
  - `PUT /api/organizations/:key/hq` and `POST /api/users/:id/link`, for Core.Admin.
- **Events (`packages/events`):** `user.upserted` (new) and `org.upserted` with `isHq`, which defaults to `false` so older envelopes still parse.
- **staff-web:**
  - a **Calendar access** screen (`/hub/calendar-access`);
  - an **Organizations** screen with the HQ switch (`/hub/organizations`, Core.Admin);
  - on the Users screen, no-email users and the Link action.
  - Nav items and the landing redirect follow the roles.

**Tech Stack:** Node 24, TypeScript 5.9 strict, Express 5, Drizzle 0.45 / drizzle-kit 0.31, zod 3.25, Vitest 4.1, supertest, React 19 + react-router 7 (library mode), `@bcgov/design-system-react-components`, axe-core, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-07-calendar-parity-design.md` (at `df5062b`):
- §3, row 5a, and its exit check;
- §2 "Roles" row;
- §4 (all of it);
- §5.4 (`user.upserted`, `org.upserted` with `isHq`);
- §8.5 (the parts Core's API serves);
- §14, rows C124 and C125;
- §15, Q48 and Q49 (both answered at `df5062b`);
- §16 "Event contracts" and acceptance item 1 (the Core half).

The parent spec is `docs/superpowers/specs/2026-10-02-gcpe-news-platform-design.md`, §8.2 Access and §4.3. Executors read the spec alongside this plan.

**Base:**
- **Branch:** `feat/phase-5a`, cut from `feat/phase-5` at `df5062b`. The controller may build on `feat/phase-5` in `/Users/paul/gcpe-news-platform-p5` instead. Every path below is repo-relative.
- **Line numbers:** every file:line reference is against `df5062b`. Re-find by symbol if anything moved.
- **Migrations:** Core's last migration is `0001_users`, so this plan's is `0002`. Re-check `apps/core/migrations/meta/_journal.json` before generating.

**What the code does today** (`df5062b`):
- `role_grants(user_id, role)` holds flat roles. `STAFF_ROLES` (`packages/auth/src/roles.ts:4`) is the only role catalogue.
- `setRoles` deletes **every** grant and re-inserts (`apps/core/src/services/users.ts:121-132`). `UserView.roles` is every grant.
- `users.email` is `NOT NULL` with a unique index on `lower(email)` (`apps/core/src/db/schema.ts:48-66`).
- Core emits no user events: §4.3's `user.upserted`, `role.granted` and `role.revoked` were never built.
- `orgInputSchema = orgRecordSchema.omit({ updatedAt })` (`apps/core/src/services/organizations.ts:7`).
  - The BC seed (`scripts/seed-core-from-public-api.ts`) and the legacy importer (`apps/core/src/import/run.ts:45`) both upsert every org through it.
  - So a defaulted `isHq` on input would clear HQ on every re-run.
- `GET /api/organizations` is open to any authenticated caller. `/api/users` is Core.Admin only (`apps/core/src/http/routes.ts:144`).
- The public News API lists **every** ministry Core sends, active or not (`apps/news-api/src/read.ts:35-43`).

**What legacy did** (`~/HUB/gcpe-hub-develop/Hub.Legacy`):
- **Roles:** `SecurityRole { ReadOnly = 1, Editor, Advanced, Administrator, SysAdmin }` (`Gcpe.Calendar.Library/Security/CustomPrincipal.cs:14`). One `SystemUser.RoleId` per user.
- **Role labels:** "Read Only", "Editor", "Advanced", "Administrator", "System Administrator" (`Calendar/Admin/User.aspx:120-124`). The default is Read Only (`User.aspx.cs:74`).
- **HQ settings:** matched by ministry **abbreviation**: `applicationOwners.Contains(m.Abbreviation)` (`CustomPrincipal.cs:119`). The README's default `ApplicationOwnerOrganizations` is `"GCPEHQ,GCPEMEDIA,PREM"`, and `HQAdmin` is `"GCPEHQ"` (`README.md:450-460`).
- **User page** (`Calendar/Admin/User.aspx.cs`):
  - saving needs at least one ministry: "Please select at least 1 Ministry." (`:639-642`);
  - it lists every user, unscoped by the admin's ministry (`UserList.aspx.cs:19-20`);
  - it has no server role check (C140), and any admin-page user could set any role, including SysAdmin, on anyone, including themself (C125).
- **GCPE Media Relations** is a `dbo.Ministry` row: abbreviation `GCPEMEDIA`, key a GUID (`db-scripts/gcpe.hub-data-01-dbo.sql`).
- **The live public API** (`https://api.news.gov.bc.ca/api/Ministries`, read 2026-10-07) lists 36 ministries and no GCPE organization. How legacy hides them was not checked.

---

## Rulings

Decided for this plan. Task 7 writes the parity rows and questions.

- **R1. Calendar grants live in `role_grants`, apart from the flat roles.**
  - A Calendar role is one `role_grants` row named `Calendar.*`. A partial unique index allows at most one per user (spec §4: "Granting one replaces the other").
  - `UserView.roles` holds only flat roles. `UserView.calendarRole` and `UserView.organizationKeys` are new.
  - The session's `roles` is `sessionRolesOf(u)`: the flat roles plus the Calendar role. So `requireAnyRole("Calendar.Administrator")` works on Core's routes, and the staff app sees the role.
  - Core.Admin's flat-roles save (`PUT /api/users/:id/roles`) deletes only non-Calendar grants. A Calendar role can't be set through it (it is not in `STAFF_ROLES`, so the request gets a 400).
- **R2. Who may grant what.** `checkCalendarGrant` refuses, in this order:
  1. `not-an-administrator`: the actor is none of Core.Admin, Calendar.SysAdmin or Calendar.Administrator.
  2. `own-access`: the actor changes their own Calendar access and is not a Core.Admin. This is **proposed** (C159). Without it, a Calendar Administrator can make themself HQ.
  3. `target-above-ceiling`: the target's current role is above the actor's ceiling. A Calendar Administrator can't touch a SysAdmin, not even to demote them. C125 says "only SysAdmin or Core.Admin grants SysAdmin", and demoting one is the same power.
  4. `above-ceiling`: the requested role is above the ceiling. This is C125.
  5. `hq-organization`: the request **adds** an HQ organization the target doesn't already have, and the actor is a Calendar Administrator who is not HQ themself. This is **proposed** (C160). HQ grants every ministry, and confidential items at Advanced (spec §6), so a ministry Administrator shouldn't hand it out.
  - The ceiling is SysAdmin for Core.Admin and Calendar.SysAdmin, and Administrator for Calendar.Administrator.
  - The rules are **ministry-blind otherwise**, as legacy: an Administrator manages users of any ministry (`UserList.aspx.cs`).
- **R3. A Calendar role needs at least one ministry** (legacy `User.aspx.cs:639-642`), or the request gets a 400.
  - Clearing the role (`role: null`) accepts any ministry list, including none.
  - The request replaces the whole ministry set.
- **R4. `user.upserted`.**
  - **Payload:** `{ id, email (nullable), displayName, isActive, calendarRole (nullable), organizationKeys }`.
  - **`organizationKeys`, not the spec's `organizationIds`.** `OrgRecord` carries no id, and every event names organizations by key (`release.*` `ministryKeys`, `activity.*` "contact ministry key"). The Calendar's org projection is keyed the same way. Task 7 updates the spec's two lines. Paul confirms (Questions, item 2).
  - **Aggregate:** `user:<uuid>`, the same `<kind>:<key>` shape as `org:<key>`.
  - **When:** emitted on create, rename, activate or deactivate, a flat-roles save, a Calendar access save, and link. It is emitted even when nothing visible changed (a projection is idempotent).
  - **Not emitted:** on a password change, because the payload has no password.
  - **Republish:** `POST /api/admin/republish` (and the stack's startup republish) re-emits every user, so 5b's projection can fill itself.
  - **No consumer yet.** The stack's subscriber lists name their types explicitly (`apps/stack/src/env.ts:259-263`), so until 5b adds the Calendar subscriber the events stay in Core's outbox with no deliveries.
- **R5. `isHq`.**
  - `org.upserted` carries `isHq: z.boolean().default(false)`. An envelope without it parses as `false`, the same pattern as `mediaText` on releases.
  - On input `isHq` is **optional**: omitted keeps the stored flag, and is `false` for a new organization. So re-running the BC seed or the legacy importer never clears HQ.
  - Core.Admin flips it with `PUT /api/organizations/:key/hq { isHq }`, which emits `org.upserted` only on a change.
  - `HQ_ABBREVIATIONS = ["GCPEHQ", "GCPEMEDIA"]` (Q49, answered). Matching is on the trimmed, upper-cased abbreviation, as legacy matched `Ministry.Abbreviation`.
  - The **legacy importer** sends `isHq: true` for those two abbreviations and omits it for every other ministry. A re-run re-asserts HQ on those two. Clear it in Core only after the final import.
  - The **BC seed** (`scripts/seed-core-from-public-api.ts`) adds `gcpe-headquarters` (GCPEHQ) and `gcpe-media-relations` (GCPEMEDIA) as active HQ organizations. The public API has neither.
  - A user is HQ when any of their organizations has `is_hq`. That is computed where it is used: here by `isHqMember` for R2.5, and by the Calendar from its projections in 5b and 5c. It is never stored on the user.
  - So **GCPEMEDIA members get every HQ privilege** (C124, Q49). This plan's tests pin that for the Core side.
- **R6. Users without email.**
  - `createUserSchema` accepts `email: null` only with `isActive: false`.
  - The database refuses an active user without an email (`users_active_needs_email`), as a backstop.
  - **Activating** a no-email user is a 409 ("set an email before activating this user").
  - **Link** (`POST /api/users/:id/link { email }`, Core.Admin) applies only to a user with no email. It sets the email and activates in one transaction. An email already in use is a 409.
  - **Sign-in** matches by email, so a no-email user can never sign in. An old session cookie for an inactive user is refused on every `/api` call and by `GET /auth/session`, as today.
  - Postgres treats NULLs as distinct in a unique index, so any number of no-email users coexist under the existing `lower(email)` index. Task 2 pins this with a test rather than adding a partial index.
- **R7. Scope held back for 5b.**
  - Calendar Administrators editing **active** and **Link** (spec §8.5) arrive with the Calendar users screen, together with the rule on users who also hold NRMS or NoD roles (Questions, item 4).
  - Calendar test users also arrive in 5b: nothing in 5a needs a seeded one, and the e2e creates its own.
  - Task 7 writes these into `docs/superpowers/plans/phase-5-carry-forward.md`.
- **R8. Inactive ministries.**
  - An inactive organization can't be **added** to a user (400, "unknown or inactive ministry"), the same as an unknown key.
  - One the user already holds may be **kept** on a re-save. Otherwise a deactivated ministry would block every later edit of its members.
  - The screen offers active organizations, plus any inactive one the user already holds, marked "inactive".
- **R9. The exit check's matrix, as Core can test it.**
  - "Role × own/shared/other-ministry × HQ" in Core means: the actor's role × the target's requested ministries relative to the actor's own (own, shared, other, an HQ organization) × requested role.
  - The test pins that Core's rules are ministry-blind apart from the HQ rule, and that only allowed grants emit, with the right payload.
  - The activity-visibility matrix (`inScope`, `seesConfidential`) belongs to 5c.
- **R10. `user_legacy_ids`** (system `calendar`, legacy `SystemUser.Id` as text, user id) is created in this migration because spec §4 places it in Core. 5i writes it. No service here reads it.

## Global Constraints

- **Worktree and commits:**
  - Work on `feat/phase-5a` (see Base). Commit locally after each task.
  - **Never add `Co-Authored-By` or any AI attribution** (project rule). Never commit `CLAUDE.md`.
  - **Code comments never carry task, round or ruling labels** ("Task 3", "R5", "fix round 1"). Say *why*, not *when*. Spec row ids (C125, Q49) are fine in comments, as existing code does. The spec's own R-decisions are cited by section ("spec addendum §4"), never as "R12": they collide with this plan's ruling numbers, and Task 7's grep refuses them.
- **Node 24 for everything:**
  - Tests: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run <paths>`.
  - Type-checks: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json` and `… -p apps/staff-web/tsconfig.json`.
  - E2E: `npx -y -p node@24 -- npm run test:e2e`.
  - Show each new test failing before implementing it (a real RED run).
- **Migrations:**
  - drizzle-kit only: `cd apps/core && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name calendar_access`.
  - Never hand-edit generated DDL. Additive only, and safe on boxs.ca's data: every existing user has an email, and no existing grant is a Calendar role.
- **Roles:**
  - Calendar role names are exactly `Calendar.ReadOnly`, `Calendar.Editor`, `Calendar.Advanced`, `Calendar.Administrator` and `Calendar.SysAdmin`, levels 1–5 in that order.
  - They are **never** added to `STAFF_ROLES` or `ADMIN_ROLES`. Every check is "level ≥ n". Legacy's always-true `IsInRole(string)` is not ported.
  - **The server is the authority** (C140): every Calendar access route is gated by `requireAnyRole` and then by `checkCalendarGrant`. staff-web only hides what the server would refuse.
- **Events:**
  - `user.upserted` and `org.upserted` are enqueued inside the writing transaction, after `lockAggregate`. The row is read `FOR UPDATE` before it changes.
  - The order is always aggregate lock, then row lock, as in `organizations.ts`.
  - `enqueueEvent` validates every payload through `parseEvent`, so a wrong payload fails the write.
- **Privacy:**
  - **Never put an email address in a log, an error message that reaches `jsonErrorHandler`, or `document.title`.**
  - Test data uses `example.test` or `x.invalid` addresses and fictional names ("Robin Staff", "Kim Imported"). **No real names or addresses** anywhere: code, tests, fixtures, docs or commits.
  - Legacy files hold real people's data. Never copy a row from them.
- **Staff-web patterns (unchanged from 4f–4i):**
  - Calls go through `apiFetch`, with same-origin `/core/api/...` paths. A load failure shows a danger `InlineAlert`.
  - Loads are guarded against out-of-order responses (a `latest` ref).
  - Each screen calls `useDocumentTitle` with its `h1` text, unconditionally. Title assertions use `await waitFor(() => expect(document.title).toBe(...))`.
  - Status messages are found with `getByRole("status")`. Errors show with `role="alert"` next to the control that caused them.
  - Each new or changed screen keeps an axe test (wcag2a/wcag2aa, serious/critical).
  - **Browser code never imports `@gcpe/auth`** (it pulls in express and jose). staff-web mirrors the names, and a node-environment `.ts` test imports `packages/auth/src/*.ts` by relative path to keep the mirror equal.
- **Copy:**
  - Role labels are legacy's: "Read Only", "Editor", "Advanced", "Administrator", "System Administrator". "No Calendar access" means no role.
  - "Ministries" is the Calendar's word for M(u). "Organization" is Core's word, used on the Organizations screen. "HQ organization" is used everywhere for `is_hq`.
  - Server refusal text comes from `REFUSAL_MESSAGES` (Task 5), shown as the server sent it.

## Review Focus

1. **Re-running the BC seed or the legacy importer after HQ was set or cleared by hand.** The flag survives a seed re-run untouched. The importer re-asserts it only on GCPEHQ and GCPEMEDIA. Pinned in Task 3 ("an upsert that omits isHq keeps the stored flag") and the seed test ("adds GCPEHQ and GCPEMEDIA as active HQ organizations, and re-seeding sends isHq only for those two").
2. **A Core.Admin saving a user's NRMS or NoD roles on the Users screen when that user holds a Calendar role and ministries.** The Calendar role and ministries are untouched, and the session still carries the Calendar role. Pinned in Task 2 ("a flat-roles save keeps the Calendar role and ministries").
3. **A ministry deactivated after users were given it.** Re-saving those users' access with it kept succeeds. Adding it to anyone new is refused with its key named. Pinned in Task 5 ("an inactive ministry can be kept but not added").
4. **A Calendar Administrator acting on a SysAdmin or on themself, including adding an HQ ministry to themself.** The server refuses with a reason staff can act on, and the screen shows those rows read-only. Pinned in Task 5 ("an Administrator can't touch a SysAdmin…", "only a Core.Admin changes their own access") and Task 6 ("a System Administrator's row and your own row are read-only for an Administrator").
5. **A Core.Admin acting through a bearer token or the break-glass account,** whose subject is `admin` or `svc`, not a UUID. The grant works and never 500s on the HQ-membership query. Pinned in Task 5 ("a bearer Core.Admin with a non-UUID subject can grant").

---

## File structure

| File | Responsibility |
|---|---|
| `packages/auth/src/roles.ts` | `CALENDAR_ROLES`, `CalendarRole` |
| `packages/auth/src/calendar-roles.ts` (+ test) | Levels, `isCalendarRole`, `calendarLevel`, `grantCeiling`, `checkCalendarGrant` |
| `packages/auth/src/index.ts` | Exports |
| `apps/staff-web/src/screens/admin/calendar-access/calendar-roles.ts` (+ test) | Browser mirror: labels, ceiling, grantable roles |
| `apps/core/src/db/schema.ts` + `migrations/0002_calendar_access.sql` | `is_hq`, nullable email + check, `user_organizations`, `user_legacy_ids`, one-Calendar-role index |
| `packages/events/src/catalogue.ts` (+ tests) | `calendarRoleSchema`, `userRecordSchema`, `user.upserted`; `isHq` on `orgRecordSchema` |
| `apps/core/src/services/aggregate.ts` | `userAggregateId` |
| `apps/core/src/services/users.ts` (+ tests) | Split roles, `sessionRolesOf`, `emitUserUpserted`, `subscribers` on writes, no-email rules, `linkUser` |
| `apps/core/src/services/republish.ts` | Users too |
| `apps/core/src/services/organizations.ts` (+ test) | `HQ_ABBREVIATIONS`, `isHqAbbreviation`, optional `isHq` input, `setOrganizationHq` |
| `apps/core/src/services/calendar-access.ts` | `calendarAccessSchema`, `setCalendarAccess`, `listCalendarAccess`, errors, `REFUSAL_MESSAGES` |
| `apps/core/src/http/calendar-access.ts` (+ test) | The Calendar access router and the matrix test |
| `apps/core/src/http/users.ts`, `routes.ts`, `session.ts` | Subscribers threaded; link; HQ route; mount; session roles |
| `apps/core/src/import/map.ts`, `import/users.ts`, `services/seed-test-users.ts` | HQ on import; `[]` subscribers where no config exists |
| `scripts/lib/public-taxonomy.ts`, `scripts/seed-core-from-public-api.ts` | The two HQ organizations |
| `apps/staff-web/src/screens/admin/messages.ts` | `messagesOf`, moved out of UsersScreen |
| `apps/staff-web/src/screens/admin/calendar-access/CalendarAccessScreen.tsx` (+ test) | Calendar access |
| `apps/staff-web/src/screens/admin/organizations/OrganizationsScreen.tsx` (+ test) | HQ switch |
| `apps/staff-web/src/screens/admin/users/UsersScreen.tsx` (+ test) | No-email users, Link |
| `apps/staff-web/src/shell/AppShell.tsx`, `HomeRedirect.tsx`, `src/router.tsx` | Nav, landing, routes |
| `tests/e2e/calendar-access.spec.ts` | Acceptance item 1, Core half, end to end |
| `docs/parity/*`, `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`, spec §4/§5.4, `docs/superpowers/plans/phase-5-carry-forward.md` | Docs |

---

### Task 1: Calendar roles and the grant rules

Covers spec §4 "Roles" and "Who grants what", C125, and R2. This task is pure: no database and no HTTP.

**Files:**
- Modify: `packages/auth/src/roles.ts`, `packages/auth/src/index.ts`.
- Create:
  - `packages/auth/src/calendar-roles.ts`, `packages/auth/src/calendar-roles.test.ts`;
  - `apps/staff-web/src/screens/admin/calendar-access/calendar-roles.ts`, `apps/staff-web/src/screens/admin/calendar-access/calendar-roles.test.ts`.

**Interfaces:**
- Produces (`@gcpe/auth`):
  - `CALENDAR_ROLES: readonly ["Calendar.ReadOnly","Calendar.Editor","Calendar.Advanced","Calendar.Administrator","Calendar.SysAdmin"]`;
  - `type CalendarRole`;
  - `CALENDAR_LEVELS: Readonly<Record<CalendarRole, number>>` (1–5);
  - `isCalendarRole(role: string): role is CalendarRole`;
  - `calendarLevel(roles: readonly string[]): number` (0 when none);
  - `grantCeiling(actorRoles: readonly string[]): CalendarRole | null`;
  - `type CalendarGrantRefusal = "not-an-administrator" | "own-access" | "target-above-ceiling" | "above-ceiling" | "hq-organization"`;
  - `interface CalendarGrantCheck { actorId: string; actorRoles: readonly string[]; actorIsHq: boolean; targetId: string; targetRole: CalendarRole | null; nextRole: CalendarRole | null; addsHqOrganization: boolean }`;
  - `checkCalendarGrant(c: CalendarGrantCheck): CalendarGrantRefusal | null`.
- Produces (staff-web mirror):
  - `CALENDAR_ROLE_INFO: readonly { role: CalendarRoleName; label: string }[]`;
  - `type CalendarRoleName`;
  - `CALENDAR_ACCESS_ROLES: readonly string[]`;
  - `canManageCalendarAccess(s: HasRole): boolean`;
  - `ceilingLevel(s: HasRole): number`;
  - `levelOf(role: CalendarRoleName | null): number`;
  - `grantableCalendarRoles(s: HasRole): { role; label }[]`;
  - `calendarRoleLabel(role: CalendarRoleName): string`.
  - `HasRole` is `{ has(role: string): boolean }`.

- [ ] **Step 1: Write the failing server test**

`packages/auth/src/calendar-roles.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CALENDAR_LEVELS, calendarLevel, checkCalendarGrant, grantCeiling, isCalendarRole, type CalendarGrantCheck } from "./calendar-roles";
import { CALENDAR_ROLES, STAFF_ROLES } from "./roles";

const grant = (over: Partial<CalendarGrantCheck>): CalendarGrantCheck => ({
  actorId: "actor",
  actorRoles: ["Calendar.Administrator"],
  actorIsHq: false,
  targetId: "target",
  targetRole: null,
  nextRole: "Calendar.Editor",
  addsHqOrganization: false,
  ...over,
});

describe("Calendar roles", () => {
  it("run 1–5 in legacy's SecurityRole order", () => {
    expect([...CALENDAR_ROLES]).toEqual(["Calendar.ReadOnly", "Calendar.Editor", "Calendar.Advanced", "Calendar.Administrator", "Calendar.SysAdmin"]);
    expect(CALENDAR_ROLES.map((r) => CALENDAR_LEVELS[r])).toEqual([1, 2, 3, 4, 5]);
  });

  it("are kept out of the flat staff roles", () => {
    for (const r of CALENDAR_ROLES) expect(STAFF_ROLES as readonly string[]).not.toContain(r);
    expect(isCalendarRole("Calendar.Editor")).toBe(true);
    expect(isCalendarRole("NRMS.Editor")).toBe(false);
    expect(isCalendarRole("Calendar.Owner")).toBe(false);
  });

  it("calendarLevel reads the Calendar role among a user's roles; none is 0", () => {
    expect(calendarLevel(["NRMS.Editor", "Calendar.Advanced"])).toBe(3);
    expect(calendarLevel(["NRMS.Editor"])).toBe(0);
    expect(calendarLevel([])).toBe(0);
  });

  it("grantCeiling: Core.Admin and SysAdmin grant up to SysAdmin, Administrator up to Administrator, anyone else nothing", () => {
    expect(grantCeiling(["Core.Admin"])).toBe("Calendar.SysAdmin");
    expect(grantCeiling(["Calendar.SysAdmin"])).toBe("Calendar.SysAdmin");
    expect(grantCeiling(["Calendar.Administrator"])).toBe("Calendar.Administrator");
    expect(grantCeiling(["Calendar.Advanced", "NRMS.Editor", "NoD.Admin"])).toBeNull();
    expect(grantCeiling([])).toBeNull();
  });
});

describe("checkCalendarGrant", () => {
  it("an Administrator grants every role up to Administrator, never SysAdmin (C125)", () => {
    for (const nextRole of ["Calendar.ReadOnly", "Calendar.Editor", "Calendar.Advanced", "Calendar.Administrator", null] as const) {
      expect(checkCalendarGrant(grant({ nextRole }))).toBeNull();
    }
    expect(checkCalendarGrant(grant({ nextRole: "Calendar.SysAdmin" }))).toBe("above-ceiling");
  });

  it("an Administrator can't change a SysAdmin's access, even to lower or remove it", () => {
    expect(checkCalendarGrant(grant({ targetRole: "Calendar.SysAdmin", nextRole: "Calendar.ReadOnly" }))).toBe("target-above-ceiling");
    expect(checkCalendarGrant(grant({ targetRole: "Calendar.SysAdmin", nextRole: null }))).toBe("target-above-ceiling");
  });

  it("a SysAdmin and a Core.Admin grant and remove SysAdmin", () => {
    expect(checkCalendarGrant(grant({ actorRoles: ["Calendar.SysAdmin"], nextRole: "Calendar.SysAdmin" }))).toBeNull();
    expect(checkCalendarGrant(grant({ actorRoles: ["Core.Admin"], targetRole: "Calendar.SysAdmin", nextRole: null }))).toBeNull();
  });

  it("nobody but a Core.Admin changes their own Calendar access", () => {
    expect(checkCalendarGrant(grant({ targetId: "actor" }))).toBe("own-access");
    expect(checkCalendarGrant(grant({ actorRoles: ["Calendar.SysAdmin"], targetId: "actor" }))).toBe("own-access");
    expect(checkCalendarGrant(grant({ actorRoles: ["Core.Admin"], targetId: "actor", nextRole: "Calendar.SysAdmin" }))).toBeNull();
  });

  it("adding an HQ organization takes an HQ Administrator, a SysAdmin or a Core.Admin", () => {
    expect(checkCalendarGrant(grant({ addsHqOrganization: true }))).toBe("hq-organization");
    expect(checkCalendarGrant(grant({ addsHqOrganization: true, actorIsHq: true }))).toBeNull();
    expect(checkCalendarGrant(grant({ addsHqOrganization: true, actorRoles: ["Calendar.SysAdmin"] }))).toBeNull();
    expect(checkCalendarGrant(grant({ addsHqOrganization: true, actorRoles: ["Core.Admin"] }))).toBeNull();
  });

  it("refuses anyone below Administrator whatever they ask for", () => {
    for (const actorRoles of [[], ["Calendar.Advanced"], ["Calendar.Editor"], ["Calendar.ReadOnly"], ["NRMS.Editor", "NoD.Admin"]]) {
      expect(checkCalendarGrant(grant({ actorRoles, nextRole: null }))).toBe("not-an-administrator");
    }
  });

  it("reports the first refusal in a fixed order, so staff see the reason they can act on", () => {
    // Own access outranks the role ceiling: an Administrator asking for SysAdmin for themself is told about themself.
    expect(checkCalendarGrant(grant({ targetId: "actor", nextRole: "Calendar.SysAdmin" }))).toBe("own-access");
    // A SysAdmin target outranks the requested role.
    expect(checkCalendarGrant(grant({ targetRole: "Calendar.SysAdmin", nextRole: "Calendar.SysAdmin", addsHqOrganization: true }))).toBe("target-above-ceiling");
    // The role ceiling outranks the HQ rule.
    expect(checkCalendarGrant(grant({ nextRole: "Calendar.SysAdmin", addsHqOrganization: true }))).toBe("above-ceiling");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/auth/src/calendar-roles.test.ts`
Expected: FAIL. The module `./calendar-roles` can't be resolved, and `CALENDAR_ROLES` is not exported from `./roles`.

- [ ] **Step 3: Implement the roles and the rules**

Append to `packages/auth/src/roles.ts`:

```ts
/**
 * The Corporate Calendar's ministry-scoped roles, lowest to highest: legacy's SecurityRole 1–5
 * (Gcpe.Calendar.Library/Security/CustomPrincipal.cs:14). A user holds at most one, so they are
 * kept apart from the flat STAFF_ROLES and granted only through Core's Calendar access routes.
 */
export const CALENDAR_ROLES = ["Calendar.ReadOnly", "Calendar.Editor", "Calendar.Advanced", "Calendar.Administrator", "Calendar.SysAdmin"] as const;
export type CalendarRole = (typeof CALENDAR_ROLES)[number];
```

Create `packages/auth/src/calendar-roles.ts`:

```ts
// Pure Calendar grant rules (spec addendum §4, C125). No runtime imports beyond ./roles, so
// staff-web's mirror test can import this file directly.
import { CALENDAR_ROLES, type CalendarRole } from "./roles";

export const CALENDAR_LEVELS: Readonly<Record<CalendarRole, number>> = Object.fromEntries(CALENDAR_ROLES.map((r, i) => [r, i + 1])) as Record<CalendarRole, number>;

export function isCalendarRole(role: string): role is CalendarRole {
  return (CALENDAR_ROLES as readonly string[]).includes(role);
}

/** The level of the Calendar role among `roles` (every check is "level ≥ n"); 0 for none. */
export function calendarLevel(roles: readonly string[]): number {
  return Math.max(0, ...roles.filter(isCalendarRole).map((r) => CALENDAR_LEVELS[r]));
}

/** The highest Calendar role an actor may grant, or null when they may grant none (C125). */
export function grantCeiling(actorRoles: readonly string[]): CalendarRole | null {
  if (actorRoles.includes("Core.Admin") || actorRoles.includes("Calendar.SysAdmin")) return "Calendar.SysAdmin";
  if (actorRoles.includes("Calendar.Administrator")) return "Calendar.Administrator";
  return null;
}

export type CalendarGrantRefusal = "not-an-administrator" | "own-access" | "target-above-ceiling" | "above-ceiling" | "hq-organization";

export interface CalendarGrantCheck {
  actorId: string;
  actorRoles: readonly string[];
  /** The actor belongs to an HQ organization. */
  actorIsHq: boolean;
  targetId: string;
  /** The target's Calendar role before this change. */
  targetRole: CalendarRole | null;
  nextRole: CalendarRole | null;
  /** The change gives the target an HQ organization they don't already have. */
  addsHqOrganization: boolean;
}

/**
 * Why this Calendar access change is refused, or null when it is allowed. Checked in a fixed
 * order so the reason returned is the one staff can act on first. Legacy's admin pages let
 * anyone set any role, including SysAdmin, on anyone, including themself (C125).
 */
export function checkCalendarGrant(c: CalendarGrantCheck): CalendarGrantRefusal | null {
  const ceiling = grantCeiling(c.actorRoles);
  if (!ceiling) return "not-an-administrator";
  if (!c.actorRoles.includes("Core.Admin") && c.actorId === c.targetId) return "own-access";
  const max = CALENDAR_LEVELS[ceiling];
  if (c.targetRole && CALENDAR_LEVELS[c.targetRole] > max) return "target-above-ceiling";
  if (c.nextRole && CALENDAR_LEVELS[c.nextRole] > max) return "above-ceiling";
  // HQ sees every ministry, so only someone who already has that reach (or a SysAdmin) hands it out.
  if (c.addsHqOrganization && max < CALENDAR_LEVELS["Calendar.SysAdmin"] && !c.actorIsHq) return "hq-organization";
  return null;
}
```

In `packages/auth/src/index.ts`:
- change the roles line to `export { CALENDAR_ROLES, CORE_ADMIN_DIRECTORY_ROLE, DISTRIBUTION_OPERATE_ROLE, NOD_SUBSCRIBE_API_ROLE, STAFF_ROLES, type CalendarRole, type StaffRole } from "./roles";`;
- add `export { CALENDAR_LEVELS, calendarLevel, checkCalendarGrant, grantCeiling, isCalendarRole, type CalendarGrantCheck, type CalendarGrantRefusal } from "./calendar-roles";`.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/auth/src/calendar-roles.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Write the failing staff-web mirror test**

`apps/staff-web/src/screens/admin/calendar-access/calendar-roles.test.ts` (node environment, because it ends in `.ts`):

```ts
import { describe, expect, it } from "vitest";
// Imported by relative path, bypassing the @gcpe/auth barrel (Node-only): these two files have
// no runtime imports beyond each other, so the test sees the server's real rules.
import { CALENDAR_ROLES } from "../../../../../../packages/auth/src/roles";
import { CALENDAR_LEVELS, grantCeiling } from "../../../../../../packages/auth/src/calendar-roles";
import { CALENDAR_ROLE_INFO, calendarRoleLabel, canManageCalendarAccess, ceilingLevel, grantableCalendarRoles, levelOf } from "./calendar-roles";

const ROLE_SETS: string[][] = [
  [],
  ["Core.Admin"],
  ["Calendar.SysAdmin"],
  ["Calendar.Administrator"],
  ["Calendar.Advanced"],
  ["Calendar.Editor"],
  ["Calendar.ReadOnly"],
  ["NRMS.Editor", "NoD.Admin"],
  ["Core.Admin", "Calendar.ReadOnly"],
];
const sessionOf = (roles: string[]) => ({ has: (r: string) => roles.includes(r) });

describe("staff-web's Calendar roles", () => {
  it("names the server's Calendar roles, in the same order", () => {
    expect(CALENDAR_ROLE_INFO.map((r) => r.role)).toEqual([...CALENDAR_ROLES]);
  });

  it("uses legacy's labels", () => {
    expect(CALENDAR_ROLE_INFO.map((r) => r.label)).toEqual(["Read Only", "Editor", "Advanced", "Administrator", "System Administrator"]);
    expect(calendarRoleLabel("Calendar.SysAdmin")).toBe("System Administrator");
  });

  it("offers exactly the roles the server lets each actor grant", () => {
    for (const roles of ROLE_SETS) {
      const ceiling = grantCeiling(roles);
      const max = ceiling ? CALENDAR_LEVELS[ceiling] : 0;
      expect(ceilingLevel(sessionOf(roles))).toBe(max);
      expect(grantableCalendarRoles(sessionOf(roles)).map((r) => r.role)).toEqual(CALENDAR_ROLES.filter((r) => CALENDAR_LEVELS[r] <= max));
      expect(canManageCalendarAccess(sessionOf(roles))).toBe(max > 0);
    }
  });

  it("levelOf matches the server's levels; no role is 0", () => {
    for (const r of CALENDAR_ROLES) expect(levelOf(r)).toBe(CALENDAR_LEVELS[r]);
    expect(levelOf(null)).toBe(0);
  });
});
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/admin/calendar-access/calendar-roles.test.ts`
Expected: FAIL, because `./calendar-roles` doesn't exist.

- [ ] **Step 6: Implement the mirror**

`apps/staff-web/src/screens/admin/calendar-access/calendar-roles.ts`:

```ts
/**
 * The Calendar roles with legacy's labels (Calendar/Admin/User.aspx:120-124), lowest to highest.
 * Mirrors packages/auth's CALENDAR_ROLES and grant ceiling: browser code can't import
 * @gcpe/auth (it pulls in express and jose). calendar-roles.test.ts keeps both equal to the
 * server's. The server still decides every grant; this only decides what the screen offers.
 */
export const CALENDAR_ROLE_INFO = [
  { role: "Calendar.ReadOnly", label: "Read Only" },
  { role: "Calendar.Editor", label: "Editor" },
  { role: "Calendar.Advanced", label: "Advanced" },
  { role: "Calendar.Administrator", label: "Administrator" },
  { role: "Calendar.SysAdmin", label: "System Administrator" },
] as const;

export type CalendarRoleName = (typeof CALENDAR_ROLE_INFO)[number]["role"];

interface HasRole {
  has(role: string): boolean;
}

/** Who may open Calendar access: the server gates the same three roles. */
export const CALENDAR_ACCESS_ROLES: readonly string[] = ["Core.Admin", "Calendar.Administrator", "Calendar.SysAdmin"];

export function canManageCalendarAccess(s: HasRole): boolean {
  return CALENDAR_ACCESS_ROLES.some((r) => s.has(r));
}

export function levelOf(role: CalendarRoleName | null): number {
  return role ? CALENDAR_ROLE_INFO.findIndex((r) => r.role === role) + 1 : 0;
}

/** The highest level this session may grant: 5 for Core.Admin or System Administrator, 4 for Administrator, else 0. */
export function ceilingLevel(s: HasRole): number {
  if (s.has("Core.Admin") || s.has("Calendar.SysAdmin")) return 5;
  if (s.has("Calendar.Administrator")) return 4;
  return 0;
}

export function grantableCalendarRoles(s: HasRole): (typeof CALENDAR_ROLE_INFO)[number][] {
  const max = ceilingLevel(s);
  return CALENDAR_ROLE_INFO.filter((_, i) => i + 1 <= max);
}

export function calendarRoleLabel(role: CalendarRoleName): string {
  return CALENDAR_ROLE_INFO.find((r) => r.role === role)!.label;
}
```

- [ ] **Step 7: Run both tests and the type-checks**

Run:
- `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/auth apps/staff-web/src/screens/admin`;
- both `tsc` commands.

Expected: PASS. `apps/staff-web/src/screens/admin/users/roles.test.ts` stays green, because `STAFF_ROLES` is unchanged.

- [ ] **Step 8: Commit**

```bash
git add packages/auth/src/roles.ts packages/auth/src/calendar-roles.ts packages/auth/src/calendar-roles.test.ts packages/auth/src/index.ts apps/staff-web/src/screens/admin/calendar-access/calendar-roles.ts apps/staff-web/src/screens/admin/calendar-access/calendar-roles.test.ts
git commit -m "feat(auth): Calendar roles and grant rules (C125)"
```

---

### Task 2: Core's user store: Calendar grants, ministries, and `user.upserted`

Covers spec §4 "Roles", "Ministry scope" and "Event", §5.4 `user.upserted`, §16 "Event contracts", and R1, R4, R6 (schema only) and R10. **This task generates the one migration for 5a.** Tasks 3–5 use its columns.

**Files:**
- Modify:
  - `apps/core/src/db/schema.ts`;
  - `packages/events/src/catalogue.ts`;
  - `apps/core/src/services/aggregate.ts`, `apps/core/src/services/users.ts`, `apps/core/src/services/republish.ts`, `apps/core/src/services/seed-test-users.ts`;
  - `apps/core/src/import/users.ts`;
  - `apps/core/src/http/users.ts`, `apps/core/src/http/routes.ts`, `apps/core/src/http/session.ts`.
- Generate: `apps/core/migrations/0002_calendar_access.sql` and its snapshot and journal entry.
- Modify tests, mechanically: append `, []` to every `createUser(…)`, `updateUser(…)` and `setRoles(…)` call. Add `calendarRole: null, organizationKeys: []` to every whole-`UserView` `toEqual`. The files are:
  - `apps/core/src/services/users.test.ts`, `apps/core/src/services/seed-test-users.test.ts`;
  - `apps/core/src/http/users.test.ts`, `apps/core/src/http/session.test.ts`, `apps/core/src/http/session-roles.test.ts`;
  - `apps/core/src/import/users.test.ts`.
- Create tests:
  - `packages/events/src/catalogue-user.test.ts`;
  - `apps/core/src/services/user-events.test.ts`;
  - `apps/core/src/db/calendar-schema.test.ts`.

**Interfaces:**
- Consumes: `CALENDAR_ROLES`, `isCalendarRole`, `CalendarRole` (Task 1).
- Produces:
  - **Schema:**
    - `organizations.isHq`;
    - `users.email: string | null`;
    - `userOrganizations { userId, organizationId }`;
    - `userLegacyIds { system: "calendar", legacyId, userId }`.
  - **`@gcpe/events`:**
    - `calendarRoleSchema`;
    - `userRecordSchema`, with `type UserRecord = { id: string; email: string | null; displayName: string; isActive: boolean; calendarRole: CalendarRole-name | null; organizationKeys: string[] }`;
    - `eventDataSchemas["user.upserted"]`.
  - **`aggregate.ts`:** `userAggregateId(id: string): string` (`user:<id>`).
  - **`users.ts`:**
    - `UserView { id; email: string | null; displayName; isActive; signInMethod; roles: string[]; calendarRole: CalendarRole | null; organizationKeys: string[] }`;
    - `sessionRolesOf(u: Pick<UserView,"roles"|"calendarRole">): string[]`;
    - `toUserRecord(u: UserView): UserRecord`;
    - `emitUserUpserted(tx: Tx, id: string, subscribers: SubscriberConfig[]): Promise<void>`;
    - `createUser(db, input, subscribers)`, `updateUser(db, id, patch, subscribers)` and `setRoles(db, id, roles, subscribers)`. `setRoles` refuses a Calendar role and keeps the existing one.
  - **Routes:** `usersRouter(db: Db, subscribers: SubscriberConfig[])`.

- [ ] **Step 1: Write the failing schema test**

`apps/core/src/db/calendar-schema.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCoreTestDb, healthOrg } from "../../test/helpers";
import { upsertOrganization } from "../services/organizations";
import { organizations, roleGrants, userLegacyIds, userOrganizations, users } from "./schema";

describe("Calendar access schema", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCoreTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  const pgCode = (e: unknown) => (e as { cause?: { code?: string } }).cause?.code;

  it("allows one Calendar role per user, beside any flat roles", async () => {
    const [u] = await tdb.db.insert(users).values({ email: "one-role@example.test", displayName: "One Role" }).returning();
    await tdb.db.insert(roleGrants).values([
      { userId: u!.id, role: "NRMS.Editor" },
      { userId: u!.id, role: "Calendar.Editor" },
    ]);
    const second = await tdb.db.insert(roleGrants).values({ userId: u!.id, role: "Calendar.Advanced" }).catch((e: unknown) => e);
    expect(pgCode(second)).toBe("23505");
  });

  it("refuses an active user without an email; any number of inactive no-email users coexist", async () => {
    const active = await tdb.db.insert(users).values({ email: null, displayName: "Active No Email", isActive: true }).catch((e: unknown) => e);
    expect(pgCode(active)).toBe("23514");
    await tdb.db.insert(users).values([
      { email: null, displayName: "Kim Imported", isActive: false },
      { email: null, displayName: "Lee Imported", isActive: false },
    ]);
    expect((await tdb.db.select().from(users).where(eq(users.isActive, false))).filter((u) => u.email === null)).toHaveLength(2);
  });

  it("organizations default to not HQ; ministries go with the user; legacy ids are unique per system", async () => {
    await upsertOrganization(tdb.db, healthOrg, []);
    const [org] = await tdb.db.select().from(organizations).where(eq(organizations.key, "health"));
    expect(org!.isHq).toBe(false);

    const [u] = await tdb.db.insert(users).values({ email: "ministries@example.test", displayName: "Has Ministries" }).returning();
    await tdb.db.insert(userOrganizations).values({ userId: u!.id, organizationId: org!.id });
    await tdb.db.insert(userLegacyIds).values({ system: "calendar", legacyId: "1042", userId: u!.id });
    const dup = await tdb.db.insert(userLegacyIds).values({ system: "calendar", legacyId: "1042", userId: u!.id }).catch((e: unknown) => e);
    expect(pgCode(dup)).toBe("23505");

    await tdb.db.delete(users).where(eq(users.id, u!.id));
    expect(await tdb.db.select().from(userOrganizations).where(eq(userOrganizations.userId, u!.id))).toEqual([]);
    expect(await tdb.db.select().from(userLegacyIds).where(eq(userLegacyIds.userId, u!.id))).toEqual([]);
  });
});
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/core/src/db/calendar-schema.test.ts`
Expected: FAIL. `userOrganizations` and `userLegacyIds` are not exported, and `isHq` doesn't exist.

- [ ] **Step 2: Change the schema and generate the migration**

In `apps/core/src/db/schema.ts`:
- **Imports:** add `index` to the `drizzle-orm/pg-core` import.
- **`organizations`:** after `sectorKeys`, add:

```ts
  /** HQ organization (spec addendum §4, C124): its members see every ministry in the Calendar. */
  isHq: boolean("is_hq").notNull().default(false),
```

- **`users`:**
  - change `email: text("email").notNull(),` to `email: text("email"),`, with the comment `/** Null only for an inactive user: legacy Calendar users with no email (spec addendum §4). */`;
  - add a check after `users_sign_in_method_check`:

```ts
    check("users_active_needs_email", sql`${t.isActive} = false OR ${t.email} IS NOT NULL`),
```

- **`roleGrants`:** the table callback becomes:

```ts
  (t) => [
    primaryKey({ columns: [t.userId, t.role] }),
    // A user holds at most one Calendar role (spec addendum §4); granting one replaces the other.
    uniqueIndex("role_grants_one_calendar_role").on(t.userId).where(sql`${t.role} LIKE 'Calendar.%'`),
  ],
```

- **Two new tables**, appended:

```ts
/** A user's ministries, M(u) in the spec addendum (§4): the Calendar's scope only. NRMS and NoD roles stay flat. */
export const userOrganizations = pgTable(
  "user_organizations",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
  },
  (t) => [primaryKey({ columns: [t.userId, t.organizationId] }), index("user_organizations_organization_idx").on(t.organizationId)],
);

/** Legacy user ids (spec addendum §4): several legacy SystemUser ids may point to one user when legacy emails repeat. Written by the Calendar importer. */
export const userLegacyIds = pgTable(
  "user_legacy_ids",
  {
    system: text("system").$type<"calendar">().notNull(),
    legacyId: text("legacy_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.system, t.legacyId] }),
    index("user_legacy_ids_user_idx").on(t.userId),
    check("user_legacy_ids_system_check", sql`${t.system} IN ('calendar')`),
  ],
);
```

Generate: `cd apps/core && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name calendar_access`

Read `apps/core/migrations/0002_calendar_access.sql`. It must contain exactly these changes and nothing that drops or rewrites data:
- `CREATE TABLE "user_organizations"` and `CREATE TABLE "user_legacy_ids"`;
- `ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL`;
- `ALTER TABLE "organizations" ADD COLUMN "is_hq" boolean DEFAULT false NOT NULL`;
- the three foreign keys and two indexes;
- `CREATE UNIQUE INDEX "role_grants_one_calendar_role" … WHERE …LIKE 'Calendar.%'`;
- `ADD CONSTRAINT "users_active_needs_email" CHECK …`;
- `ADD CONSTRAINT "user_legacy_ids_system_check" CHECK …`.

`users_email_lower_idx` must be untouched.

- [ ] **Step 3: Run the schema test**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/core/src/db/calendar-schema.test.ts`
Expected: PASS (3 tests). If `tsc` complains in `services/users.ts` that `email` may be null, Step 7 fixes it.

- [ ] **Step 4: Write the failing event contract test**

`packages/events/src/catalogue-user.test.ts`:

```ts
import { describe, expect, it } from "vitest";
// Relative import: @gcpe/events doesn't depend on @gcpe/auth; this keeps the two role lists equal.
import { CALENDAR_ROLES } from "../../auth/src/roles";
import { calendarRoleSchema, parseEvent, type UserRecord } from "./index";

const user: UserRecord = {
  id: "8a7f3c1e-2b4d-4e6f-9a0b-1c2d3e4f5a6b",
  email: "robin.staff@example.test",
  displayName: "Robin Staff",
  isActive: true,
  calendarRole: "Calendar.Editor",
  organizationKeys: ["health"],
};

const envelope = (data: unknown) => ({
  id: "6f0d7f4e-8a51-4d39-9f42-2a4f4c1c0b11",
  type: "user.upserted",
  version: 1,
  source: "core",
  aggregateId: `user:${user.id}`,
  sequence: 1,
  occurredAt: "2026-10-07T17:00:00Z",
  correlationId: "0b8f3f86-2d1e-4b59-9e0c-5d6f1b1c2a33",
  data,
});

describe("user.upserted", () => {
  it("accepts a user with a Calendar role and ministries", () => {
    expect(parseEvent(envelope(user)).data).toEqual(user);
  });

  it("accepts an inactive user with no email and no Calendar access", () => {
    const imported = { ...user, email: null, isActive: false, calendarRole: null, organizationKeys: [] };
    expect(parseEvent(envelope(imported)).data).toEqual(imported);
  });

  it("rejects an unknown Calendar role, a missing ministry list, and a non-uuid id", () => {
    expect(() => parseEvent(envelope({ ...user, calendarRole: "Calendar.Owner" }))).toThrow();
    const { organizationKeys: _k, ...noKeys } = user;
    expect(() => parseEvent(envelope(noKeys))).toThrow();
    expect(() => parseEvent(envelope({ ...user, id: "local:admin" }))).toThrow();
  });

  it("names exactly packages/auth's Calendar roles, in order", () => {
    expect(calendarRoleSchema.options).toEqual([...CALENDAR_ROLES]);
  });
});
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/events/src/catalogue-user.test.ts`
Expected: FAIL, because `calendarRoleSchema` and `UserRecord` are not exported.

- [ ] **Step 5: Add `user.upserted` to the catalogue**

In `packages/events/src/catalogue.ts`, before `eventDataSchemas`:

```ts
/** Calendar roles, lowest to highest. Mirrors packages/auth's CALENDAR_ROLES (this package
 * doesn't depend on auth); catalogue-user.test.ts keeps them equal. */
export const calendarRoleSchema = z.enum(["Calendar.ReadOnly", "Calendar.Editor", "Calendar.Advanced", "Calendar.Administrator", "Calendar.SysAdmin"]);

/** Core → Calendar (spec addendum §4, §5.4). Ministries are named by organization key, as every other event names them. */
export const userRecordSchema = z.object({
  id: z.string().uuid(),
  email: z.string().nullable(),
  displayName: z.string().min(1),
  isActive: z.boolean(),
  calendarRole: calendarRoleSchema.nullable(),
  organizationKeys: z.array(z.string().min(1)),
});
export type UserRecord = z.infer<typeof userRecordSchema>;
```

Add `"user.upserted": userRecordSchema,` to `eventDataSchemas`, after `"org.deactivated"`.

Run the test again. Expected: PASS (4 tests).

- [ ] **Step 6: Write the failing service tests**

`apps/core/src/services/user-events.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { outboxDeliveries, outboxEvents, type SubscriberConfig, type UserRecord } from "@gcpe/events";
import { createCoreTestDb, healthOrg } from "../../test/helpers";
import { organizations, roleGrants, userOrganizations } from "../db/schema";
import { upsertOrganization } from "./organizations";
import { republishAll } from "./republish";
import { createUser, createUserSchema, getUser, sessionUserFor, setPassword, setRoles, updateUser } from "./users";

const subs: SubscriberConfig[] = [{ name: "calendar", url: "http://x/events", secret: "s", types: ["user.upserted"] }];

describe("user.upserted from Core", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCoreTestDb();
    await upsertOrganization(tdb.db, healthOrg, []);
  });
  afterAll(async () => {
    await tdb.drop();
  });

  async function userEvents(id: string): Promise<UserRecord[]> {
    const rows = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, `user:${id}`)).orderBy(asc(outboxEvents.sequence));
    for (const r of rows) expect(r.type).toBe("user.upserted");
    return rows.map((r) => (r.envelope as { data: UserRecord }).data);
  }

  async function giveCalendarAccess(id: string, role: string, orgKey: string) {
    const [org] = await tdb.db.select().from(organizations).where(eq(organizations.key, orgKey));
    await tdb.db.insert(roleGrants).values({ userId: id, role });
    await tdb.db.insert(userOrganizations).values({ userId: id, organizationId: org!.id });
  }

  it("create, rename, deactivate and a flat-roles save each emit the whole record; a password change doesn't", async () => {
    const u = await createUser(tdb.db, createUserSchema.parse({ email: "robin.staff@example.test", displayName: "Robin Staff", roles: ["NRMS.Viewer"] }), subs);
    await updateUser(tdb.db, u.id, { displayName: "Robin S. Staff" }, subs);
    await updateUser(tdb.db, u.id, { isActive: false }, subs);
    await setRoles(tdb.db, u.id, ["NRMS.Editor"], subs);
    await setPassword(tdb.db, u.id, "a long enough password");
    const events = await userEvents(u.id);
    expect(events.map((e) => [e.displayName, e.isActive])).toEqual([
      ["Robin Staff", true],
      ["Robin S. Staff", true],
      ["Robin S. Staff", false],
      ["Robin S. Staff", false],
    ]);
    expect(events[0]).toEqual({ id: u.id, email: "robin.staff@example.test", displayName: "Robin Staff", isActive: true, calendarRole: null, organizationKeys: [] });
    expect(JSON.stringify(events)).not.toMatch(/scrypt|passwordHash|password/);
  });

  it("reports the Calendar role apart from the flat roles; the session and the event carry it", async () => {
    const u = await createUser(tdb.db, createUserSchema.parse({ email: "cal.one@example.test", displayName: "Cal One", roles: ["NRMS.Viewer"] }), subs);
    await giveCalendarAccess(u.id, "Calendar.Editor", "health");
    const view = (await getUser(tdb.db, u.id))!;
    expect(view.roles).toEqual(["NRMS.Viewer"]);
    expect(view.calendarRole).toBe("Calendar.Editor");
    expect(view.organizationKeys).toEqual(["health"]);
    expect((await sessionUserFor(tdb.db, u.id))!.roles).toEqual(["Calendar.Editor", "NRMS.Viewer"]);
  });

  it("a flat-roles save keeps the Calendar role and ministries", async () => {
    const u = await createUser(tdb.db, createUserSchema.parse({ email: "keeps.calendar@example.test", displayName: "Keeps Calendar", roles: ["NRMS.Viewer"] }), subs);
    await giveCalendarAccess(u.id, "Calendar.Advanced", "health");
    const after = await setRoles(tdb.db, u.id, ["NoD.Viewer", "NRMS.Editor"], subs);
    expect(after.roles).toEqual(["NoD.Viewer", "NRMS.Editor"]);
    expect(after.calendarRole).toBe("Calendar.Advanced");
    expect(after.organizationKeys).toEqual(["health"]);
    expect((await userEvents(u.id)).at(-1)).toMatchObject({ calendarRole: "Calendar.Advanced", organizationKeys: ["health"] });
    await expect(setRoles(tdb.db, u.id, ["Calendar.SysAdmin"], subs)).rejects.toThrow(/Calendar role/);
  });

  it("only subscribers of user.upserted get a delivery", async () => {
    const orgOnly: SubscriberConfig[] = [{ name: "nrms", url: "http://x/events", secret: "s", types: ["org.upserted"] }];
    const a = await createUser(tdb.db, createUserSchema.parse({ email: "delivered@example.test", displayName: "Delivered" }), subs);
    const b = await createUser(tdb.db, createUserSchema.parse({ email: "not-delivered@example.test", displayName: "Not Delivered" }), orgOnly);
    const deliveriesFor = async (id: string) => {
      const [event] = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, `user:${id}`));
      return (await tdb.db.select().from(outboxDeliveries).where(eq(outboxDeliveries.eventId, event!.id))).map((d) => d.subscriber);
    };
    expect(await deliveriesFor(a.id)).toEqual(["calendar"]);
    expect(await deliveriesFor(b.id)).toEqual([]);
  });

  it("republishAll re-emits every user with their current record", async () => {
    const u = await createUser(tdb.db, createUserSchema.parse({ email: "republished@example.test", displayName: "Republished" }), subs);
    const before = (await userEvents(u.id)).length;
    await republishAll(tdb.db, subs);
    const events = await userEvents(u.id);
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)).toEqual(toRecordOf(await getUser(tdb.db, u.id)));
  });
});

function toRecordOf(u: Awaited<ReturnType<typeof getUser>>): UserRecord {
  return { id: u!.id, email: u!.email, displayName: u!.displayName, isActive: u!.isActive, calendarRole: u!.calendarRole, organizationKeys: u!.organizationKeys };
}
```

Also add to `apps/core/src/http/session-roles.test.ts`, inside its `describe`. Import `and`, `eq` from `drizzle-orm` and `roleGrants` from `../db/schema`:

```ts
  it("signs in with the Calendar role in the session, and renews it when it changes", async () => {
    const u = await createUser(tdb.db, createUserSchema.parse({ email: "calendar-session@example.test", displayName: "Cal Session", roles: ["NRMS.Viewer"], password: "calendar pass 123" }), []);
    await tdb.db.insert(roleGrants).values({ userId: u.id, role: "Calendar.Editor" });
    const login = await request(app).post("/auth/login").set("x-gcpe-request", "1").send({ username: "calendar-session@example.test", password: "calendar pass 123" });
    expect(login.status).toBe(200);
    expect(login.body.user.roles).toEqual(["Calendar.Editor", "NRMS.Viewer"]);
    const cookie = (login.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;

    await tdb.db
      .update(roleGrants)
      .set({ role: "Calendar.Advanced" })
      .where(and(eq(roleGrants.userId, u.id), eq(roleGrants.role, "Calendar.Editor")));
    const renewed = await request(app).get("/auth/session").set("cookie", cookie);
    expect(renewed.status).toBe(200);
    expect(renewed.body.user.roles).toEqual(["Calendar.Advanced", "NRMS.Viewer"]);
    expect(renewed.headers["set-cookie"]).toBeDefined();
  });
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/core/src/services/user-events.test.ts apps/core/src/http/session-roles.test.ts`
Expected: FAIL. The services take no `subscribers`, no events are emitted, and `calendarRole` is undefined.

- [ ] **Step 7: Implement the user store changes**

`apps/core/src/services/aggregate.ts`: add

```ts
export function userAggregateId(id: string): string {
  return `user:${id}`;
}
```

`apps/core/src/services/users.ts`. The imports and the parts that change; everything not shown stays as it is:

```ts
import { and, asc, eq, inArray, notLike, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbOrTx, Tx } from "@gcpe/db-kit";
import { hashPassword, isCalendarRole, STAFF_ROLES, verifyPassword, type CalendarRole, type SessionUser } from "@gcpe/auth";
import { enqueueEvent, type SubscriberConfig, type UserRecord } from "@gcpe/events";
import { organizations, roleGrants, userOrganizations, users } from "../db/schema";
import { CORE_SOURCE, lockAggregate, userAggregateId } from "./aggregate";

// … email, password, roles, displayName, createUserSchema, updateUserSchema, setRolesSchema,
// setPasswordSchema unchanged …

export interface UserView {
  id: string;
  /** Null only for an inactive user (spec addendum §4, users without email). */
  email: string | null;
  displayName: string;
  isActive: boolean;
  signInMethod: "local" | "entra";
  /** Flat staff roles (STAFF_ROLES). Never a Calendar role. */
  roles: string[];
  /** The user's one Calendar role, if any. */
  calendarRole: CalendarRole | null;
  /** The user's ministries, M(u), by organization key, sorted. */
  organizationKeys: string[];
}

async function withAccess(db: DbOrTx, rows: UserRow[]): Promise<UserView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const grants = await db.select().from(roleGrants).where(inArray(roleGrants.userId, ids));
  const memberships = await db
    .select({ userId: userOrganizations.userId, key: organizations.key })
    .from(userOrganizations)
    .innerJoin(organizations, eq(organizations.id, userOrganizations.organizationId))
    .where(inArray(userOrganizations.userId, ids));
  const flat = new Map<string, string[]>();
  const calendar = new Map<string, CalendarRole>();
  const orgKeys = new Map<string, string[]>();
  for (const g of grants) {
    if (isCalendarRole(g.role)) calendar.set(g.userId, g.role);
    else flat.set(g.userId, [...(flat.get(g.userId) ?? []), g.role]);
  }
  for (const m of memberships) orgKeys.set(m.userId, [...(orgKeys.get(m.userId) ?? []), m.key]);
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    displayName: r.displayName,
    isActive: r.isActive,
    signInMethod: r.signInMethod,
    roles: (flat.get(r.id) ?? []).sort(),
    calendarRole: calendar.get(r.id) ?? null,
    organizationKeys: (orgKeys.get(r.id) ?? []).sort(),
  }));
}

/** The roles a session carries: the flat roles plus the Calendar role, so role checks see both. */
export function sessionRolesOf(u: Pick<UserView, "roles" | "calendarRole">): string[] {
  return [...u.roles, ...(u.calendarRole ? [u.calendarRole] : [])].sort();
}

export function toUserRecord(u: UserView): UserRecord {
  return { id: u.id, email: u.email, displayName: u.displayName, isActive: u.isActive, calendarRole: u.calendarRole, organizationKeys: u.organizationKeys };
}

/**
 * Enqueues `user.upserted` with the user's current record. Call inside the writing transaction,
 * after lockAggregate(userAggregateId(id)), so sequences follow commit order.
 */
export async function emitUserUpserted(tx: Tx, id: string, subscribers: SubscriberConfig[]): Promise<void> {
  const u = await getUser(tx, id);
  if (!u) return;
  await enqueueEvent(tx, { type: "user.upserted", source: CORE_SOURCE, aggregateId: userAggregateId(id), data: toUserRecord(u) }, subscribers);
}
```

- Rename every `withRoles(` call to `withAccess(`.
- `adminEmails`: return `[...new Set(rows.flatMap((r) => (r.email ? [r.email] : [])))].sort();`.

The writes:

```ts
export async function createUser(db: Db, input: CreateUserInput, subscribers: SubscriberConfig[]): Promise<UserView> {
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  try {
    const id = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(users)
        .values({ email: input.email, displayName: input.displayName, passwordHash, isActive: input.isActive })
        .returning({ id: users.id });
      await lockAggregate(tx, userAggregateId(row!.id));
      const unique = [...new Set(input.roles)];
      if (unique.length) await tx.insert(roleGrants).values(unique.map((role) => ({ userId: row!.id, role })));
      await emitUserUpserted(tx, row!.id, subscribers);
      return row!.id;
    });
    return (await getUser(db, id))!;
  } catch (e) {
    if (isUniqueViolation(e)) throw new UserExistsError(input.email);
    throw e;
  }
}

export async function updateUser(db: Db, id: string, patch: UpdateUserInput, subscribers: SubscriberConfig[]): Promise<UserView> {
  if (!isUuid(id)) throw new UserNotFoundError(id);
  await db.transaction(async (tx) => {
    await lockAggregate(tx, userAggregateId(id));
    const [row] = await tx.select({ id: users.id }).from(users).where(eq(users.id, id)).for("update");
    if (!row) throw new UserNotFoundError(id);
    await tx
      .update(users)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(users.id, id));
    await emitUserUpserted(tx, id, subscribers);
  });
  return (await getUser(db, id))!;
}

/** Replaces the user's flat roles. The Calendar role is changed only through calendar-access.ts and is kept here. */
export async function setRoles(db: Db, id: string, next: string[], subscribers: SubscriberConfig[]): Promise<UserView> {
  if (next.some(isCalendarRole)) throw new Error("setRoles never sets a Calendar role; use setCalendarAccess");
  if (!isUuid(id)) throw new UserNotFoundError(id);
  await db.transaction(async (tx) => {
    await lockAggregate(tx, userAggregateId(id));
    const found = await tx.execute(sql`SELECT id FROM ${users} WHERE id = ${id} FOR UPDATE`);
    if (found.rows.length === 0) throw new UserNotFoundError(id);
    await tx.delete(roleGrants).where(and(eq(roleGrants.userId, id), notLike(roleGrants.role, "Calendar.%")));
    const unique = [...new Set(next)];
    if (unique.length) await tx.insert(roleGrants).values(unique.map((role) => ({ userId: id, role })));
    await tx.update(users).set({ updatedAt: new Date() }).where(eq(users.id, id));
    await emitUserUpserted(tx, id, subscribers);
  });
  return (await getUser(db, id))!;
}
```

`sessionUserFor`:

```ts
export async function sessionUserFor(db: Db, id: string): Promise<SessionUser | null> {
  const u = await getUser(db, id);
  // An active user always has an email (users_active_needs_email).
  return u && u.isActive ? { id: u.id, name: u.displayName, email: u.email ?? "", roles: sessionRolesOf(u) } : null;
}
```

`apps/core/src/http/session.ts`:
- import `sessionRolesOf` beside `authenticate`;
- the login line becomes `await issue(res, { id: user.id, name: user.displayName, email: user.email ?? "", roles: sessionRolesOf(user) });`.

`apps/core/src/http/users.ts`:
- `export function usersRouter(db: Db, subscribers: SubscriberConfig[]): Router` (import the type from `@gcpe/events`);
- pass `subscribers` as the last argument of `createUser`, `updateUser` and `setRoles`.

`apps/core/src/http/routes.ts`: `r.use("/users", admin, usersRouter(db, subscribers));`.

`apps/core/src/services/republish.ts`: import `users` from `../db/schema`, and `userAggregateId` and `emitUserUpserted`. Append before `return count;`:

```ts
  const userIds = await db.select({ id: users.id }).from(users).orderBy(asc(users.id));
  for (const { id } of userIds) {
    const done = await db.transaction(async (tx) => {
      await lockAggregate(tx, userAggregateId(id));
      const [row] = await tx.select({ id: users.id }).from(users).where(eq(users.id, id)).for("update");
      if (!row) return false;
      await emitUserUpserted(tx, id, subscribers);
      return true;
    });
    if (done) count++;
  }
```

Update its doc comment's first line to "Re-emits an upserted event for every organization, term and user."

`apps/core/src/services/seed-test-users.ts`: pass `[]` to `createUser`, `setRoles` and `updateUser`. Add a comment above the loop:

```ts
  // The seed CLI has no subscriber config. Core's republish carries seeded users to subscribers.
```

`apps/core/src/import/users.ts`: `createUser(db, parsed.data, [])`, with the comment `// Imported staff are inactive with no roles, so they grant no Calendar access; Core's republish carries them to subscribers.`

- [ ] **Step 8: Update the existing tests mechanically and run Core**

In each test file listed under **Files**:
- append `, []` to every `createUser(`, `updateUser(` and `setRoles(` call;
- add `calendarRole: null, organizationKeys: []` to each `toEqual` on a whole `UserView`: `services/users.test.ts:32`, `http/users.test.ts:45`, and any other the run reports.

Run:
- `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/core packages/events packages/auth`;
- both `tsc` commands.

Expected: PASS. NRMS's importer calls `importLegacyUsers` unchanged (`apps/nrms/src/import/run.ts:85`); run `apps/nrms/src/import` too, to confirm.

- [ ] **Step 9: Commit**

```bash
git add apps/core packages/events
git commit -m "feat(core): Calendar grants and ministries in Core's user store; user.upserted"
```

---

### Task 3: HQ organizations (`isHq`)

Covers spec §4 "HQ organizations", §5.4 `org.upserted` (extended), C124, Q49 (GCPEHQ and GCPEMEDIA) and R5.

**Files:**
- Modify:
  - `packages/events/src/catalogue.ts`, `packages/events/src/catalogue.test.ts`;
  - `apps/core/src/services/organizations.ts`, `apps/core/src/services/organizations.test.ts`;
  - `apps/core/src/http/routes.ts`, `apps/core/src/http/routes.test.ts`;
  - `apps/core/src/import/map.ts`, `apps/core/src/import/map.test.ts`;
  - `scripts/lib/public-taxonomy.ts`, `scripts/seed-core-from-public-api.ts`, `tests/seed-core-from-public-api.test.ts`.
- Modify as `tsc` reports: `OrgRecord` literals gain `isHq: false`. At planning these are in:
  - `apps/news-api/src/dto.test.ts`, `projections.test.ts`, `http/v1/posts.test.ts`, `http/v1/categories.test.ts`, `dev/fixture-world.ts`;
  - `apps/nod/src/lists.test.ts`.
  - `OrgInput` literals need nothing, because `isHq` is optional there.

**Interfaces:**
- Consumes: `organizations.isHq` (Task 2).
- Produces:
  - `OrgRecord.isHq: boolean`;
  - `type OrgInput = z.infer<typeof orgInputSchema>`, with `isHq?: boolean`;
  - `HQ_ABBREVIATIONS = ["GCPEHQ","GCPEMEDIA"] as const`;
  - `isHqAbbreviation(a: string | null | undefined): boolean`;
  - `setOrganizationHq(db: Db, key: string, isHq: boolean, subscribers: SubscriberConfig[]): Promise<OrgRecord | null>`;
  - the route `PUT /api/organizations/:key/hq { isHq: boolean }` (Core.Admin), which returns the `OrgRecord` or a 404;
  - `HQ_SEED_ORGANIZATIONS: OrgInput[]` (scripts).

- [ ] **Step 1: Write the failing tests**

In `packages/events/src/catalogue.test.ts`, inside `describe("parseEvent")`. Add `isHq: false` to the `org` fixture at the top, then:

```ts
  it("org.upserted carries isHq; an older envelope without it parses as not HQ", () => {
    expect(parseEvent(envelope("org.upserted", { ...org, isHq: true })).data).toMatchObject({ isHq: true });
    const { isHq: _h, ...older } = org;
    expect(parseEvent(envelope("org.upserted", older)).data).toMatchObject({ isHq: false });
    expect(() => parseEvent(envelope("org.upserted", { ...org, isHq: "yes" }))).toThrow();
  });
```

In `apps/core/src/services/organizations.test.ts`, import `setOrganizationHq`, `HQ_ABBREVIATIONS` and `isHqAbbreviation`, then:

```ts
  it("an organization is not HQ until set; org.upserted carries the flag", async () => {
    const { record } = await upsertOrganization(tdb.db, healthOrg, subs);
    expect(record.isHq).toBe(false);
    const hq = await upsertOrganization(tdb.db, { ...healthOrg, key: "gcpe-headquarters", abbreviation: "GCPEHQ", isHq: true }, subs);
    expect(hq.record.isHq).toBe(true);
    const [event] = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, "org:gcpe-headquarters"));
    expect((event!.envelope as { data: { isHq: boolean } }).data.isHq).toBe(true);
  });

  it("an upsert that omits isHq keeps the stored flag and emits nothing new", async () => {
    await upsertOrganization(tdb.db, { ...healthOrg, isHq: true }, subs);
    const again = await upsertOrganization(tdb.db, healthOrg, subs);
    expect(again.changed).toBe(false);
    expect(again.record.isHq).toBe(true);
    const renamed = await upsertOrganization(tdb.db, { ...healthOrg, displayName: "Health and Wellness" }, subs);
    expect(renamed.record.isHq).toBe(true);
    expect(await tdb.db.select().from(outboxEvents)).toHaveLength(2);
  });

  it("setOrganizationHq flips the flag and emits once; the same value emits nothing; an unknown key is null", async () => {
    await upsertOrganization(tdb.db, healthOrg, subs);
    expect((await setOrganizationHq(tdb.db, "health", true, subs))!.isHq).toBe(true);
    expect((await setOrganizationHq(tdb.db, "health", true, subs))!.isHq).toBe(true);
    expect((await setOrganizationHq(tdb.db, "health", false, subs))!.isHq).toBe(false);
    const types = (await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, "org:health"))).map((e) => e.type);
    expect(types).toEqual(["org.upserted", "org.upserted", "org.upserted"]);
    expect(await setOrganizationHq(tdb.db, "no-such-org", true, subs)).toBeNull();
  });

  it("HQ abbreviations are GCPEHQ and GCPEMEDIA, matched trimmed and in any case (Q49)", () => {
    expect([...HQ_ABBREVIATIONS]).toEqual(["GCPEHQ", "GCPEMEDIA"]);
    expect(isHqAbbreviation(" gcpemedia ")).toBe(true);
    expect(isHqAbbreviation("GCPEHQ")).toBe(true);
    expect(isHqAbbreviation("PREM")).toBe(false);
    expect(isHqAbbreviation(null)).toBe(false);
  });
```

In `apps/core/src/http/routes.test.ts`:

```ts
  it("PUT /organizations/:key/hq is Core.Admin only, 404s an unknown key and 400s a non-boolean", async () => {
    const auth = (t: string) => ({ authorization: `Bearer ${t}` });
    await request(app).put("/api/organizations/health").set(auth(admin)).send(healthOrg).expect(200);
    expect((await request(app).put("/api/organizations/health/hq").set(auth(editorOnly)).send({ isHq: true })).status).toBe(403);
    const set = await request(app).put("/api/organizations/health/hq").set(auth(admin)).send({ isHq: true });
    expect(set.status).toBe(200);
    expect(set.body.isHq).toBe(true);
    expect((await request(app).get("/api/organizations/health").set(auth(reader))).body.isHq).toBe(true);
    expect((await request(app).put("/api/organizations/nope/hq").set(auth(admin)).send({ isHq: true })).status).toBe(404);
    expect((await request(app).put("/api/organizations/health/hq").set(auth(admin)).send({ isHq: "yes" })).status).toBe(400);
  });
```

In `apps/core/src/import/map.test.ts`:
- the first `toEqual` (the GCPE Media Relations row) gains `isHq: true`;
- add:

```ts
  it("marks GCPEHQ and GCPEMEDIA as HQ and leaves every other ministry's flag to Core (Q49)", () => {
    const related = { topics: [], services: [], sectorKeys: [] };
    expect(mapMinistry({ ...mediaRelations, Abbreviation: "GCPEHQ" }, related).isHq).toBe(true);
    expect(mapMinistry({ ...mediaRelations, Abbreviation: "GCPEMEDIA" }, related).isHq).toBe(true);
    expect("isHq" in mapMinistry({ ...mediaRelations, Abbreviation: "HLTH" }, related)).toBe(false);
  });
```

Other `map.test.ts` cases that spread `mediaRelations` and compare whole objects gain `isHq: true` too.

In `tests/seed-core-from-public-api.test.ts`, inside `describe("run() …")`:

```ts
  it("adds GCPEHQ and GCPEMEDIA as active HQ organizations, and re-seeding sends isHq only for those two", async () => {
    const { fetchImpl, calls } = makeFetchMock({ publicMinistries: [SAMPLE_MINISTRY], publicMinister: SAMPLE_MINISTER, publicSectors: [], publicThemes: [], publicTags: [] });
    const result = await run({ targetBaseUrl: "https://boxs.ca", token: "t", fetchImpl, delayMs: 0, log: () => {} });
    expect(result.ok).toBe(true);
    const orgPuts = calls.filter((c) => c.method === "PUT" && c.url.pathname.startsWith("/core/api/organizations/"));
    const bodies = new Map(orgPuts.map((c) => [c.url.pathname, JSON.parse(c.body!) as Record<string, unknown>]));
    for (const [path, abbreviation] of [["/core/api/organizations/gcpe-headquarters", "GCPEHQ"], ["/core/api/organizations/gcpe-media-relations", "GCPEMEDIA"]] as const) {
      expect(bodies.get(path)).toMatchObject({ abbreviation, isHq: true, isActive: true });
      expect(() => orgInputSchema.parse(bodies.get(path))).not.toThrow();
    }
    // A public ministry's body never carries isHq, so re-seeding never clears a flag set by hand.
    expect("isHq" in bodies.get("/core/api/organizations/aest")!).toBe(false);
    expect(result.summaries.find((s) => s.kind === "hq-organizations")).toMatchObject({ upserted: 2, failed: 0 });
  });
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/events/src/catalogue.test.ts apps/core/src/services/organizations.test.ts apps/core/src/http/routes.test.ts apps/core/src/import/map.test.ts tests/seed-core-from-public-api.test.ts`
Expected: FAIL. `isHq` is not in the schema, `setOrganizationHq` and `HQ_ABBREVIATIONS` don't exist, the route 404s, and the seed adds no HQ organizations.

- [ ] **Step 2: Implement `isHq` in the catalogue and Core**

`packages/events/src/catalogue.ts`, in `orgRecordSchema` after `sectorKeys`:

```ts
  // HQ organization (Calendar spec addendum §4, C124). Defaulted so an envelope stored before
  // the flag existed still parses.
  isHq: z.boolean().default(false),
```

`apps/core/src/services/organizations.ts`:

```ts
import { z } from "zod";
// … existing imports …

/**
 * isHq is optional on input: omitted keeps the stored flag (false for a new organization), so
 * re-running the BC seed or the legacy importer never clears an HQ flag set by Core.Admin.
 */
export const orgInputSchema = orgRecordSchema.omit({ updatedAt: true, isHq: true }).extend({ isHq: z.boolean().optional() });
export type OrgInput = z.infer<typeof orgInputSchema>;

/** Legacy abbreviations of the HQ organizations (Q49): GCPE Headquarters and GCPE Media Relations. Legacy matched HQ by Ministry.Abbreviation. */
export const HQ_ABBREVIATIONS = ["GCPEHQ", "GCPEMEDIA"] as const;

export function isHqAbbreviation(abbreviation: string | null | undefined): boolean {
  return abbreviation != null && (HQ_ABBREVIATIONS as readonly string[]).includes(abbreviation.trim().toUpperCase());
}
```

- `toOrgRecord` gains `isHq: row.isHq,` after `sectorKeys`.
- In `upsertOrganization`, parse first, then resolve the flag under the lock:

```ts
  const parsed = orgInputSchema.parse(input);
  return db.transaction(async (tx) => {
    await lockAggregate(tx, orgAggregateId(parsed.key));
    const [existing] = await tx.select().from(organizations).where(eq(organizations.key, parsed.key)).for("update");
    const data = { ...parsed, isHq: parsed.isHq ?? existing?.isHq ?? false };
    // … the rest unchanged, using `data` …
```

Add:

```ts
/** Core.Admin's HQ switch. Emits org.upserted only when the flag changes. */
export async function setOrganizationHq(db: Db, key: string, isHq: boolean, subscribers: SubscriberConfig[]): Promise<OrgRecord | null> {
  return db.transaction(async (tx) => {
    await lockAggregate(tx, orgAggregateId(key));
    const [existing] = await tx.select().from(organizations).where(eq(organizations.key, key)).for("update");
    if (!existing) return null;
    if (existing.isHq === isHq) return toOrgRecord(existing);
    const [row] = await tx.update(organizations).set({ isHq, updatedAt: new Date() }).where(eq(organizations.key, key)).returning();
    const record = toOrgRecord(row!);
    await enqueueEvent(tx, { type: "org.upserted", source: CORE_SOURCE, aggregateId: orgAggregateId(key), data: record }, subscribers);
    return record;
  });
}
```

`apps/core/src/http/routes.ts`: import `z` from `zod` and `setOrganizationHq`. After the `PUT /organizations/:key` route, add:

```ts
  const hqSchema = z.object({ isHq: z.boolean() });
  r.put(
    "/organizations/:key/hq",
    admin,
    safe<{ key: string }>(async (req, res) => {
      const { isHq } = hqSchema.parse(req.body);
      const record = await setOrganizationHq(db, req.params.key, isHq, subscribers);
      record ? res.json(record) : res.status(404).json({ error: "not found" });
    }),
  );
```

`apps/core/src/import/map.ts`:
- change `import type { OrgInput } from "../services/organizations";` to `import { isHqAbbreviation, type OrgInput } from "../services/organizations";`;
- `mapMinistry`'s returned object ends with:

```ts
    sectorKeys: [...related.sectorKeys].sort(),
    // Only the two HQ ministries say anything about HQ; every other ministry leaves Core's flag alone.
    ...(isHqAbbreviation(row.Abbreviation) ? { isHq: true } : {}),
```

- [ ] **Step 3: Add the HQ organizations to the BC seed**

`scripts/lib/public-taxonomy.ts`, after `toOrgInput`:

```ts
/**
 * GCPE's HQ organizations (Calendar spec addendum Q49). The public API lists neither (checked
 * 2026-10-07: 36 ministries, none GCPE), so the seed adds them. The Calendar matches them by
 * abbreviation, as legacy did.
 */
export const HQ_SEED_ORGANIZATIONS: OrgInput[] = [
  hqOrganization("gcpe-headquarters", "GCPE Headquarters", "GCPEHQ"),
  hqOrganization("gcpe-media-relations", "GCPE Media Relations", "GCPEMEDIA"),
];

function hqOrganization(key: string, displayName: string, abbreviation: string): OrgInput {
  return {
    key,
    displayName,
    abbreviation,
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
    isHq: true,
  };
}
```

`scripts/seed-core-from-public-api.ts`:
- import `HQ_SEED_ORGANIZATIONS`;
- add:

```ts
async function seedHqOrganizations(opts: Required<Pick<RunOptions, "targetBaseUrl" | "token" | "delayMs" | "fetchImpl">>): Promise<KindSummary> {
  const summary: KindSummary = { kind: "hq-organizations", upserted: 0, failed: 0, failures: [], noAbbreviation: [] };
  for (const org of HQ_SEED_ORGANIZATIONS) {
    const input = orgInputSchema.parse(org);
    await sleep(opts.delayMs);
    const res = await putJson(opts.targetBaseUrl, `/core/api/organizations/${encodeURIComponent(input.key)}`, opts.token, input, opts.fetchImpl);
    if (res.ok) summary.upserted++;
    else {
      summary.failed++;
      summary.failures.push({ key: input.key, status: res.status });
    }
  }
  return summary;
}
```

- in `run()`, right after `summaries.push(await seedMinistries(…))`, add `summaries.push(await seedHqOrganizations(common));`.

- [ ] **Step 4: Fix `OrgRecord` literals, then run everything touched**

Run `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`. Add `isHq: false` to each `OrgRecord`-typed literal it reports (expected in the files listed under **Files**). Then run:
- `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/events apps/core apps/news-api apps/nod/src/lists.test.ts apps/nrms/src/taxonomy tests/seed-core-from-public-api.test.ts`;
- both `tsc` commands.

Expected: PASS. News API and NRMS map org fields explicitly (`apps/news-api/src/projections.ts:179-204`), so `isHq` never reaches a public payload. `dto.test.ts` keeps passing unchanged apart from the fixture.

- [ ] **Step 5: Commit**

```bash
git add packages/events apps/core apps/news-api apps/nod scripts tests/seed-core-from-public-api.test.ts
git commit -m "feat(core): HQ organizations (is_hq on org.upserted); GCPEHQ and GCPEMEDIA seeded and imported as HQ (C124, Q49)"
```

---

### Task 4: Users without an email

Covers spec §4 "Users without email (R12)", the exit check's "An inactive no-email user can't sign in", and R6.

**Files:**
- Modify: `apps/core/src/services/users.ts`, `apps/core/src/http/users.ts`.
- Create: `apps/core/src/http/no-email-users.test.ts`.

**Interfaces:**
- Consumes: `users.email` nullable and `users_active_needs_email` (Task 2); `emitUserUpserted` and `lockAggregate` (Task 2).
- Produces:
  - `createUserSchema` with `email: string | null` (default `null`), refusing an active user with no email;
  - `UserNeedsEmailError`, `UserAlreadyHasEmailError`;
  - `linkUserSchema`;
  - `linkUser(db: Db, id: string, email: string, subscribers: SubscriberConfig[]): Promise<UserView>`;
  - the route `POST /api/users/:id/link { email }` (Core.Admin).

- [ ] **Step 1: Write the failing tests**

`apps/core/src/http/no-email-users.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { asc, eq, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { mintSession } from "@gcpe/auth";
import { outboxEvents, type SubscriberConfig, type UserRecord } from "@gcpe/events";
import { createCoreTestDb } from "../../test/helpers";
import { createApp } from "../app";
import { createUser, createUserSchema } from "../services/users";

const SECRET = "session-secret-for-no-email-tests-0123456789";
const subs: SubscriberConfig[] = [{ name: "calendar", url: "http://x/events", secret: "s", types: ["user.upserted"] }];

describe("users without an email", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;

  beforeAll(async () => {
    tdb = await createCoreTestDb();
    app = createApp({ db: tdb.db, subscribers: subs, auth: { session: { secret: SECRET } }, session: { secret: SECRET, secure: false, local: null } });
    const admin = await createUser(tdb.db, createUserSchema.parse({ email: "admin@example.test", displayName: "Admin", roles: ["Core.Admin"] }), []);
    adminCookie = `gcpe_session=${(await mintSession(SECRET, { id: admin.id, name: "Admin", email: "admin@example.test", roles: ["Core.Admin"] })).token}`;
  });
  afterAll(async () => {
    await tdb.drop();
  });

  const as = (cookie: string) => ({
    post: (p: string, body: object) => request(app).post(p).set("cookie", cookie).set("x-gcpe-request", "1").send(body),
    patch: (p: string, body: object) => request(app).patch(p).set("cookie", cookie).set("x-gcpe-request", "1").send(body),
  });

  async function createNoEmail(displayName: string): Promise<string> {
    const res = await as(adminCookie).post("/api/users", { displayName, isActive: false, password: "a long enough password" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email: null, isActive: false, displayName });
    return res.body.id as string;
  }

  it("creates inactive users with no email; an active one needs an email", async () => {
    await createNoEmail("Kim Imported");
    await createNoEmail("Lee Imported");
    const active = await as(adminCookie).post("/api/users", { displayName: "Active Nobody" });
    expect(active.status).toBe(400);
    expect(JSON.stringify(active.body.issues)).toContain("an active user needs an email");
  });

  it("can't be activated until an email is set; the database refuses it too", async () => {
    const id = await createNoEmail("Pat Imported");
    const res = await as(adminCookie).patch(`/api/users/${id}`, { isActive: true });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "set an email before activating this user" });
    const direct = await tdb.db.execute(sql`UPDATE users SET is_active = true WHERE id = ${id}`).catch((e: unknown) => e);
    expect((direct as { cause?: { code?: string } }).cause?.code ?? (direct as { code?: string }).code).toBe("23514");
  });

  it("can't sign in, and a session cookie minted for one is refused", async () => {
    const id = await createNoEmail("Sam Imported");
    for (const username of ["", " ", "Sam Imported"]) {
      const login = await request(app).post("/auth/login").set("x-gcpe-request", "1").send({ username, password: "a long enough password" });
      expect(login.status).toBe(401);
    }
    const cookie = `gcpe_session=${(await mintSession(SECRET, { id, name: "Sam Imported", email: "", roles: [] })).token}`;
    expect((await request(app).get("/auth/session").set("cookie", cookie)).status).toBe(401);
    expect((await request(app).get("/api/organizations").set("cookie", cookie)).status).toBe(401);
  });

  it("link sets the email and activates in one step, emits user.upserted, and the user can then sign in", async () => {
    const id = await createNoEmail("Jo Imported");
    const linked = await as(adminCookie).post(`/api/users/${id}/link`, { email: " Jo.Imported@Example.test " });
    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject({ email: "jo.imported@example.test", isActive: true });
    const rows = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, `user:${id}`)).orderBy(asc(outboxEvents.sequence));
    expect((rows.at(-1)!.envelope as { data: UserRecord }).data).toMatchObject({ email: "jo.imported@example.test", isActive: true });
    const login = await request(app).post("/auth/login").set("x-gcpe-request", "1").send({ username: "jo.imported@example.test", password: "a long enough password" });
    expect(login.status).toBe(200);
  });

  it("refuses link for a user who already has an email, an email already in use, and a malformed one", async () => {
    const id = await createNoEmail("Ali Imported");
    expect((await as(adminCookie).post(`/api/users/${id}/link`, { email: "not-an-email" })).status).toBe(400);
    const taken = await as(adminCookie).post(`/api/users/${id}/link`, { email: "ADMIN@example.test" });
    expect(taken.status).toBe(409);
    expect(taken.body).toEqual({ error: "a user with that email already exists" });
    expect((await as(adminCookie).post(`/api/users/${id}/link`, { email: "ali.imported@example.test" })).status).toBe(200);
    const again = await as(adminCookie).post(`/api/users/${id}/link`, { email: "ali.other@example.test" });
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: "this user already has an email" });
    expect((await as(adminCookie).post("/api/users/00000000-0000-4000-8000-000000000000/link", { email: "x@example.test" })).status).toBe(404);
  });
});
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/core/src/http/no-email-users.test.ts`
Expected: FAIL. A POST without email is a 400, activation reaches the database check (a 500), and `/link` is a 404.

- [ ] **Step 2: Implement**

`apps/core/src/services/users.ts`:

```ts
export const createUserSchema = z
  .object({
    /** Null only for an inactive user: legacy Calendar users with no email (spec addendum §4). */
    email: email.nullable().default(null),
    displayName,
    roles: roles.default([]),
    password: password.optional(),
    /** Phase 3e (NRMS legacy importer): legacy staff import as inactive, with no password or roles. */
    isActive: z.boolean().default(true),
  })
  .refine((v) => v.email !== null || !v.isActive, { message: "an active user needs an email", path: ["email"] });

export const linkUserSchema = z.object({ email });

export class UserNeedsEmailError extends Error {}
export class UserAlreadyHasEmailError extends Error {}
```

- In `createUser`, the catch throws `new UserExistsError(input.email ?? "")`.
- In `updateUser`, select `{ email: users.email }` instead of `{ id: users.id }`, and add after the not-found check:

```ts
    if (patch.isActive === true && row.email === null) throw new UserNeedsEmailError(id);
```

Add:

```ts
/**
 * Sets the email of a user who has none, and activates them (spec addendum §4): legacy
 * Calendar users imported without an email are linked this way, and Entra matching later uses it.
 */
export async function linkUser(db: Db, id: string, address: string, subscribers: SubscriberConfig[]): Promise<UserView> {
  if (!isUuid(id)) throw new UserNotFoundError(id);
  try {
    await db.transaction(async (tx) => {
      await lockAggregate(tx, userAggregateId(id));
      const [row] = await tx.select({ email: users.email }).from(users).where(eq(users.id, id)).for("update");
      if (!row) throw new UserNotFoundError(id);
      if (row.email !== null) throw new UserAlreadyHasEmailError(id);
      await tx.update(users).set({ email: address, isActive: true, updatedAt: new Date() }).where(eq(users.id, id));
      await emitUserUpserted(tx, id, subscribers);
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new UserExistsError(address);
    throw e;
  }
  return (await getUser(db, id))!;
}
```

`apps/core/src/http/users.ts`:
- import `linkUser`, `linkUserSchema`, `UserAlreadyHasEmailError` and `UserNeedsEmailError`;
- in `run`, before `next(e)`:

```ts
    if (e instanceof UserNeedsEmailError) return void res.status(409).json({ error: "set an email before activating this user" });
    if (e instanceof UserAlreadyHasEmailError) return void res.status(409).json({ error: "this user already has an email" });
```

- add the route:

```ts
  r.post(
    "/:id/link",
    run<IdParams>(async (req, res) => {
      const { email } = linkUserSchema.parse(req.body);
      res.json(await linkUser(db, req.params.id, email, subscribers));
    }),
  );
```

- [ ] **Step 3: Run Core and the type-checks**

Run:
- `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/core apps/nrms/src/import`;
- both `tsc` commands.

Expected: PASS. The NRMS legacy importer passes a string email, so `importLegacyUsers` is unaffected.

- [ ] **Step 4: Commit**

```bash
git add apps/core
git commit -m "feat(core): users without an email are inactive until linked; link sets the email and activates"
```

---

### Task 5: The Calendar access API, and the grant matrix

Covers spec §4 "Who grants what", §8.5 (role and ministries through Core's API), C125, C140 for these routes, the 5a exit check, and R2, R3, R8 and R9.

**Files:**
- Create:
  - `apps/core/src/services/calendar-access.ts`;
  - `apps/core/src/http/calendar-access.ts`, `apps/core/src/http/calendar-access.test.ts`.
- Modify: `apps/core/src/http/routes.ts`.

**Interfaces:**
- Consumes:
  - `checkCalendarGrant`, `CALENDAR_ROLES`, `CalendarRole` and `CalendarGrantRefusal` (Task 1);
  - `getUser`, `emitUserUpserted`, `UserNotFoundError`, `UserView` and `userAggregateId` (Task 2);
  - `organizations.isHq` (Tasks 2–3).
- Produces:
  - `calendarAccessSchema` (`{ role: CalendarRole | null; organizationKeys: string[] }`, refined);
  - `type CalendarAccessView = Pick<UserView, "id"|"email"|"displayName"|"isActive"|"calendarRole"|"organizationKeys">`;
  - `listCalendarAccess(db): Promise<CalendarAccessView[]>`;
  - `setCalendarAccess(db, actor: { id: string; roles: string[] }, targetId, input, subscribers): Promise<CalendarAccessView>`;
  - `CalendarGrantRefusedError` (`.reason`), `UnknownOrganizationError` (`.keys`);
  - `REFUSAL_MESSAGES: Record<CalendarGrantRefusal, string>`;
  - `CALENDAR_ACCESS_ROLES`;
  - the routes `GET /api/calendar-access` and `PUT /api/calendar-access/:id`.
  - A refusal is `403 { error, reason }`. A bad ministry is `400 { error: "unknown or inactive ministry", keys }`.

- [ ] **Step 1: Write the failing tests, including the matrix**

`apps/core/src/http/calendar-access.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { and, asc, eq, like } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { CALENDAR_ROLES, mintLocalToken, mintSession, type CalendarRole } from "@gcpe/auth";
import { outboxEvents, type SubscriberConfig, type UserRecord } from "@gcpe/events";
import { createCoreTestDb, healthOrg } from "../../test/helpers";
import { createApp } from "../app";
import { roleGrants, userOrganizations } from "../db/schema";
import { setCalendarAccess } from "../services/calendar-access";
import { deactivateOrganization, upsertOrganization } from "../services/organizations";
import { createUser, createUserSchema } from "../services/users";

const SECRET = "session-secret-for-calendar-access-0123456789";
const LOCAL = "local-bearer-secret-for-calendar-access-0123";
const subs: SubscriberConfig[] = [{ name: "calendar", url: "http://x/events", secret: "s", types: ["user.upserted"] }];
const SETUP = { id: "setup", roles: ["Core.Admin"] };

type ActorName = "coreAdmin" | "sysAdmin" | "adminHq" | "adminMedia" | "adminHealth" | "advanced" | "editor" | "readOnly" | "nrmsEditor";
const ACTORS: Record<ActorName, { flat: string[]; calendar: CalendarRole | null; orgs: string[] }> = {
  coreAdmin: { flat: ["Core.Admin"], calendar: null, orgs: [] },
  sysAdmin: { flat: [], calendar: "Calendar.SysAdmin", orgs: ["health"] },
  adminHq: { flat: [], calendar: "Calendar.Administrator", orgs: ["gcpe-headquarters"] },
  // GCPEMEDIA is HQ too (Q49): its Administrators get every HQ privilege GCPEHQ's do (C124).
  adminMedia: { flat: [], calendar: "Calendar.Administrator", orgs: ["gcpe-media-relations"] },
  adminHealth: { flat: [], calendar: "Calendar.Administrator", orgs: ["health"] },
  advanced: { flat: [], calendar: "Calendar.Advanced", orgs: ["health"] },
  editor: { flat: [], calendar: "Calendar.Editor", orgs: ["health"] },
  readOnly: { flat: [], calendar: "Calendar.ReadOnly", orgs: ["health"] },
  nrmsEditor: { flat: ["NRMS.Editor"], calendar: null, orgs: [] },
};
// The target's requested ministries, relative to the ministry-level actors' own ministry (Health).
const RELATIONS = { own: ["health"], shared: ["finance", "health"], other: ["finance"], hq: ["gcpe-headquarters"] } as const;
type Relation = keyof typeof RELATIONS;
const HQ_KEYS = new Set(["gcpe-headquarters", "gcpe-media-relations"]);

/** The rules restated from the spec, independently of checkCalendarGrant: C125, plus the HQ-ministry rule. */
function expectedStatus(actor: ActorName, relation: Relation, role: CalendarRole | null): 200 | 403 {
  const a = ACTORS[actor];
  const ceiling = a.flat.includes("Core.Admin") || a.calendar === "Calendar.SysAdmin" ? 5 : a.calendar === "Calendar.Administrator" ? 4 : 0;
  if (ceiling === 0) return 403;
  if (role !== null && CALENDAR_ROLES.indexOf(role) + 1 > ceiling) return 403;
  if (relation === "hq" && ceiling < 5 && !a.orgs.some((k) => HQ_KEYS.has(k))) return 403;
  return 200;
}

describe("Calendar access API", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  const ids = {} as Record<ActorName, string>;
  const cookies = {} as Record<ActorName, string>;
  let targetId: string;

  beforeAll(async () => {
    tdb = await createCoreTestDb();
    app = createApp({ db: tdb.db, subscribers: subs, auth: { session: { secret: SECRET }, local: { secret: LOCAL } }, session: { secret: SECRET, secure: false, local: null } });
    await upsertOrganization(tdb.db, healthOrg, []);
    await upsertOrganization(tdb.db, { ...healthOrg, key: "finance", displayName: "Finance", abbreviation: "FIN", sectorKeys: [] }, []);
    await upsertOrganization(tdb.db, { ...healthOrg, key: "gcpe-headquarters", displayName: "GCPE Headquarters", abbreviation: "GCPEHQ", sectorKeys: [], isHq: true }, []);
    await upsertOrganization(tdb.db, { ...healthOrg, key: "gcpe-media-relations", displayName: "GCPE Media Relations", abbreviation: "GCPEMEDIA", sectorKeys: [], isHq: true }, []);
    for (const [name, a] of Object.entries(ACTORS) as [ActorName, (typeof ACTORS)[ActorName]][]) {
      const u = await createUser(tdb.db, createUserSchema.parse({ email: `${name.toLowerCase()}@example.test`, displayName: name, roles: a.flat }), []);
      if (a.calendar) await setCalendarAccess(tdb.db, SETUP, u.id, { role: a.calendar, organizationKeys: a.orgs }, []);
      ids[name] = u.id;
      // Roles in the cookie don't matter: Core re-derives them from the database on every /api call.
      cookies[name] = `gcpe_session=${(await mintSession(SECRET, { id: u.id, name, email: `${name.toLowerCase()}@example.test`, roles: [] })).token}`;
    }
    targetId = (await createUser(tdb.db, createUserSchema.parse({ email: "robin.staff@example.test", displayName: "Robin Staff" }), [])).id;
  });
  afterAll(async () => {
    await tdb.drop();
  });

  const put = (cookie: string, id: string, body: object) => request(app).put(`/api/calendar-access/${id}`).set("cookie", cookie).set("x-gcpe-request", "1").send(body);

  async function userEvents(id: string): Promise<UserRecord[]> {
    const rows = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, `user:${id}`)).orderBy(asc(outboxEvents.sequence));
    return rows.map((r) => (r.envelope as { data: UserRecord }).data);
  }

  async function resetTarget() {
    await tdb.db.delete(roleGrants).where(and(eq(roleGrants.userId, targetId), like(roleGrants.role, "Calendar.%")));
    await tdb.db.delete(userOrganizations).where(eq(userOrganizations.userId, targetId));
  }

  it("role × ministry relation × HQ: each grant is allowed or refused exactly as the rules say, and only allowed grants emit", async () => {
    const mismatches: string[] = [];
    for (const actor of Object.keys(ACTORS) as ActorName[]) {
      for (const relation of Object.keys(RELATIONS) as Relation[]) {
        for (const role of [null, ...CALENDAR_ROLES] as (CalendarRole | null)[]) {
          await resetTarget();
          const before = (await userEvents(targetId)).length;
          const res = await put(cookies[actor], targetId, { role, organizationKeys: [...RELATIONS[relation]] });
          const want = expectedStatus(actor, relation, role);
          const label = `${actor} gives ${role ?? "no role"} with ${relation} ministries`;
          if (res.status !== want) {
            mismatches.push(`${label}: got ${res.status}, want ${want}`);
            continue;
          }
          const events = await userEvents(targetId);
          if (want === 200) {
            const last = events.at(-1);
            const ok = events.length === before + 1 && last?.calendarRole === role && JSON.stringify(last.organizationKeys) === JSON.stringify([...RELATIONS[relation]].sort());
            if (!ok) mismatches.push(`${label}: event ${JSON.stringify(last)}`);
            if (res.body.calendarRole !== role) mismatches.push(`${label}: response ${JSON.stringify(res.body)}`);
          } else if (events.length !== before) {
            mismatches.push(`${label}: a refused grant emitted`);
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("names the reason: an Administrator asking for SysAdmin, or for an HQ ministry while not HQ", async () => {
    await resetTarget();
    const sys = await put(cookies.adminHealth, targetId, { role: "Calendar.SysAdmin", organizationKeys: ["health"] });
    expect(sys.status).toBe(403);
    expect(sys.body).toEqual({ error: "only a System Administrator or a Core admin can grant System Administrator", reason: "above-ceiling" });
    const hq = await put(cookies.adminHealth, targetId, { role: "Calendar.Editor", organizationKeys: ["gcpe-headquarters"] });
    expect(hq.body).toEqual({ error: "only an HQ Administrator, a System Administrator or a Core admin can add an HQ ministry", reason: "hq-organization" });
  });

  it("an Administrator can't touch a SysAdmin, not even to lower or remove their role", async () => {
    await resetTarget();
    await setCalendarAccess(tdb.db, SETUP, targetId, { role: "Calendar.SysAdmin", organizationKeys: ["health"] }, []);
    for (const role of [null, "Calendar.ReadOnly", "Calendar.Administrator"]) {
      const res = await put(cookies.adminHq, targetId, { role, organizationKeys: ["health"] });
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe("target-above-ceiling");
    }
    expect((await put(cookies.sysAdmin, targetId, { role: "Calendar.Editor", organizationKeys: ["health"] })).status).toBe(200);
  });

  it("only a Core.Admin changes their own access", async () => {
    const self = await put(cookies.adminHq, ids.adminHq, { role: "Calendar.Administrator", organizationKeys: ["gcpe-headquarters", "health"] });
    expect(self.status).toBe(403);
    expect(self.body.reason).toBe("own-access");
    expect((await put(cookies.sysAdmin, ids.sysAdmin, { role: "Calendar.SysAdmin", organizationKeys: ["finance"] })).body.reason).toBe("own-access");
    expect((await put(cookies.coreAdmin, ids.coreAdmin, { role: "Calendar.SysAdmin", organizationKeys: ["gcpe-headquarters"] })).status).toBe(200);
  });

  it("a Calendar role needs a ministry; clearing the role doesn't; ministries are replaced, not merged", async () => {
    await resetTarget();
    const none = await put(cookies.coreAdmin, targetId, { role: "Calendar.Editor", organizationKeys: [] });
    expect(none.status).toBe(400);
    expect(JSON.stringify(none.body.issues)).toContain("choose at least one ministry for a Calendar role");
    expect((await put(cookies.coreAdmin, targetId, { role: "Calendar.Editor", organizationKeys: ["health", "finance", "health"] })).body.organizationKeys).toEqual(["finance", "health"]);
    expect((await put(cookies.coreAdmin, targetId, { role: null, organizationKeys: [] })).body).toMatchObject({ calendarRole: null, organizationKeys: [] });
    expect((await put(cookies.coreAdmin, targetId, { role: "Calendar.Owner", organizationKeys: ["health"] })).status).toBe(400);
  });

  it("an inactive ministry can be kept but not added; an unknown one is named", async () => {
    await upsertOrganization(tdb.db, { ...healthOrg, key: "retired", displayName: "Retired Ministry", abbreviation: "RET", sectorKeys: [] }, []);
    await resetTarget();
    await setCalendarAccess(tdb.db, SETUP, targetId, { role: "Calendar.Editor", organizationKeys: ["retired"] }, []);
    await deactivateOrganization(tdb.db, "retired", []);
    expect((await put(cookies.adminHq, targetId, { role: "Calendar.Advanced", organizationKeys: ["retired", "health"] })).status).toBe(200);

    const other = (await createUser(tdb.db, createUserSchema.parse({ email: "new.staff@example.test", displayName: "New Staff" }), [])).id;
    const added = await put(cookies.adminHq, other, { role: "Calendar.Editor", organizationKeys: ["retired", "no-such-ministry"] });
    expect(added.status).toBe(400);
    expect(added.body).toEqual({ error: "unknown or inactive ministry", keys: ["no-such-ministry", "retired"] });
  });

  it("a bearer Core.Admin with a non-UUID subject can grant", async () => {
    await resetTarget();
    const token = await mintLocalToken({ secret: LOCAL, subject: "admin", roles: ["Core.Admin"] });
    const res = await request(app).put(`/api/calendar-access/${targetId}`).set("authorization", `Bearer ${token}`).send({ role: "Calendar.SysAdmin", organizationKeys: ["gcpe-headquarters"] });
    expect(res.status).toBe(200);
  });

  it("GET lists every user's Calendar access to the three admin roles only; the grant takes effect on the next request", async () => {
    expect((await request(app).get("/api/calendar-access").set("cookie", cookies.editor)).status).toBe(403);
    const list = await request(app).get("/api/calendar-access").set("cookie", cookies.adminHealth);
    expect(list.status).toBe(200);
    expect(list.body.find((u: { id: string }) => u.id === ids.adminMedia)).toEqual({
      id: ids.adminMedia,
      email: "adminmedia@example.test",
      displayName: "adminMedia",
      isActive: true,
      calendarRole: "Calendar.Administrator",
      organizationKeys: ["gcpe-media-relations"],
    });
    expect(JSON.stringify(list.body)).not.toMatch(/passwordHash|signInMethod|NRMS\./);

    // The target's own session gains the Calendar.Administrator check as soon as it's granted.
    const targetCookie = `gcpe_session=${(await mintSession(SECRET, { id: targetId, name: "Robin Staff", email: "robin.staff@example.test", roles: [] })).token}`;
    await resetTarget();
    expect((await request(app).get("/api/calendar-access").set("cookie", targetCookie)).status).toBe(403);
    await put(cookies.coreAdmin, targetId, { role: "Calendar.Administrator", organizationKeys: ["health"] });
    expect((await request(app).get("/api/calendar-access").set("cookie", targetCookie)).status).toBe(200);
  });

  it("404s an unknown or malformed user id", async () => {
    expect((await put(cookies.coreAdmin, "00000000-0000-4000-8000-000000000000", { role: null, organizationKeys: [] })).status).toBe(404);
    expect((await put(cookies.coreAdmin, "not-a-uuid", { role: null, organizationKeys: [] })).status).toBe(404);
  });
});
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/core/src/http/calendar-access.test.ts`
Expected: FAIL, because `../services/calendar-access` doesn't exist.

- [ ] **Step 2: Implement the service**

`apps/core/src/services/calendar-access.ts`:

```ts
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Tx } from "@gcpe/db-kit";
import { CALENDAR_ROLES, checkCalendarGrant, type CalendarGrantRefusal } from "@gcpe/auth";
import type { SubscriberConfig } from "@gcpe/events";
import { organizations, roleGrants, userOrganizations, users } from "../db/schema";
import { lockAggregate, userAggregateId } from "./aggregate";
import { emitUserUpserted, getUser, listUsers, UserNotFoundError, type UserView } from "./users";

/** The whole of a user's Calendar access: one role (or none) and the full set of ministries, replaced together. */
export const calendarAccessSchema = z
  .object({
    role: z.enum(CALENDAR_ROLES).nullable(),
    organizationKeys: z.array(z.string().trim().min(1).max(100)).max(100),
  })
  // Legacy's user page refused to save without a ministry (Calendar/Admin/User.aspx.cs:639-642).
  .refine((v) => v.role === null || v.organizationKeys.length > 0, { message: "choose at least one ministry for a Calendar role", path: ["organizationKeys"] });
export type CalendarAccessInput = z.infer<typeof calendarAccessSchema>;

export type CalendarAccessView = Pick<UserView, "id" | "email" | "displayName" | "isActive" | "calendarRole" | "organizationKeys">;

export const REFUSAL_MESSAGES: Record<CalendarGrantRefusal, string> = {
  "not-an-administrator": "only a Calendar Administrator can change Calendar access",
  "own-access": "you can't change your own Calendar access",
  "target-above-ceiling": "only a System Administrator or a Core admin can change a System Administrator's access",
  "above-ceiling": "only a System Administrator or a Core admin can grant System Administrator",
  "hq-organization": "only an HQ Administrator, a System Administrator or a Core admin can add an HQ ministry",
};

export class CalendarGrantRefusedError extends Error {
  constructor(readonly reason: CalendarGrantRefusal) {
    super(reason);
  }
}

export class UnknownOrganizationError extends Error {
  constructor(readonly keys: string[]) {
    super("unknown or inactive ministry");
  }
}

export interface CalendarActor {
  /** The caller's subject: a user id for staff sessions, or a non-UUID for break-glass and service tokens. */
  id: string;
  roles: string[];
}

const isUuid = (id: string) => z.string().uuid().safeParse(id).success;

function toView(u: UserView): CalendarAccessView {
  return { id: u.id, email: u.email, displayName: u.displayName, isActive: u.isActive, calendarRole: u.calendarRole, organizationKeys: u.organizationKeys };
}

/** Whether the user belongs to an HQ organization. Break-glass and service subjects have no ministries. */
async function isHqMember(tx: Tx, userId: string): Promise<boolean> {
  if (!isUuid(userId)) return false;
  const rows = await tx
    .select({ id: organizations.id })
    .from(userOrganizations)
    .innerJoin(organizations, eq(organizations.id, userOrganizations.organizationId))
    .where(and(eq(userOrganizations.userId, userId), eq(organizations.isHq, true)))
    .limit(1);
  return rows.length > 0;
}

export async function listCalendarAccess(db: Db): Promise<CalendarAccessView[]> {
  return (await listUsers(db)).map(toView);
}

/**
 * Replaces a user's Calendar role and ministries, after checkCalendarGrant (C125). Emits
 * user.upserted in the same transaction. An inactive ministry the user already holds may be
 * kept; a new one must exist and be active.
 */
export async function setCalendarAccess(db: Db, actor: CalendarActor, targetId: string, input: CalendarAccessInput, subscribers: SubscriberConfig[]): Promise<CalendarAccessView> {
  if (!isUuid(targetId)) throw new UserNotFoundError(targetId);
  const keys = [...new Set(input.organizationKeys)];
  await db.transaction(async (tx) => {
    await lockAggregate(tx, userAggregateId(targetId));
    const found = await tx.execute(sql`SELECT id FROM ${users} WHERE id = ${targetId} FOR UPDATE`);
    if (found.rows.length === 0) throw new UserNotFoundError(targetId);
    const current = (await getUser(tx, targetId))!;
    const held = new Set(current.organizationKeys);
    const requested = keys.length
      ? await tx.select({ id: organizations.id, key: organizations.key, isActive: organizations.isActive, isHq: organizations.isHq }).from(organizations).where(inArray(organizations.key, keys))
      : [];
    const byKey = new Map(requested.map((o) => [o.key, o]));
    const bad = keys.filter((k) => {
      const o = byKey.get(k);
      return !o || (!o.isActive && !held.has(k));
    });
    if (bad.length) throw new UnknownOrganizationError(bad.sort());

    const refusal = checkCalendarGrant({
      actorId: actor.id,
      actorRoles: actor.roles,
      actorIsHq: await isHqMember(tx, actor.id),
      targetId,
      targetRole: current.calendarRole,
      nextRole: input.role,
      addsHqOrganization: requested.some((o) => o.isHq && !held.has(o.key)),
    });
    if (refusal) throw new CalendarGrantRefusedError(refusal);

    await tx.delete(roleGrants).where(and(eq(roleGrants.userId, targetId), like(roleGrants.role, "Calendar.%")));
    if (input.role) await tx.insert(roleGrants).values({ userId: targetId, role: input.role });
    await tx.delete(userOrganizations).where(eq(userOrganizations.userId, targetId));
    if (requested.length) await tx.insert(userOrganizations).values(requested.map((o) => ({ userId: targetId, organizationId: o.id })));
    await tx.update(users).set({ updatedAt: new Date() }).where(eq(users.id, targetId));
    await emitUserUpserted(tx, targetId, subscribers);
  });
  return toView((await getUser(db, targetId))!);
}
```

`getUser` and `listUsers` must be exported from `users.ts`. Both already are.

- [ ] **Step 3: Implement the router and mount it**

`apps/core/src/http/calendar-access.ts`:

```ts
import { Router, type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import type { Db } from "@gcpe/db-kit";
import type { SubscriberConfig } from "@gcpe/events";
import { calendarAccessSchema, CalendarGrantRefusedError, listCalendarAccess, REFUSAL_MESSAGES, setCalendarAccess, UnknownOrganizationError } from "../services/calendar-access";
import { UserNotFoundError } from "../services/users";

/** Who may open these routes at all; checkCalendarGrant then decides each change (C125, C140). */
export const CALENDAR_ACCESS_ROLES = ["Core.Admin", "Calendar.Administrator", "Calendar.SysAdmin"] as const;

type IdParams = { id: string };
const run = <P>(h: (req: Request<P>, res: Response) => Promise<void>) => (req: Request<P>, res: Response, next: NextFunction) =>
  h(req, res).catch((e: unknown) => {
    if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues });
    if (e instanceof UserNotFoundError) return void res.status(404).json({ error: "not found" });
    if (e instanceof CalendarGrantRefusedError) return void res.status(403).json({ error: REFUSAL_MESSAGES[e.reason], reason: e.reason });
    if (e instanceof UnknownOrganizationError) return void res.status(400).json({ error: "unknown or inactive ministry", keys: e.keys });
    next(e);
  });

/** Calendar roles and ministries (spec addendum §4, §8.5). Mounted behind requireAnyRole(...CALENDAR_ACCESS_ROLES). */
export function calendarAccessRouter(db: Db, subscribers: SubscriberConfig[]): Router {
  const r = Router();
  r.get("/", run(async (_req, res) => void res.json(await listCalendarAccess(db))));
  r.put(
    "/:id",
    run<IdParams>(async (req, res) => {
      const input = calendarAccessSchema.parse(req.body);
      res.json(await setCalendarAccess(db, { id: req.auth!.subject, roles: req.auth!.roles }, req.params.id, input, subscribers));
    }),
  );
  return r;
}
```

`apps/core/src/http/routes.ts`:
- import `calendarAccessRouter` and `CALENDAR_ACCESS_ROLES`;
- before `r.use("/users", …)`, add `r.use("/calendar-access", requireAnyRole(...CALENDAR_ACCESS_ROLES), calendarAccessRouter(db, subscribers));`.

- [ ] **Step 4: Run it**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/core/src/http/calendar-access.test.ts`
Expected: PASS (9 tests). The matrix runs 216 grants. If it reports mismatches, each line names actor, role and relation. Fix the code, never the oracle, unless the oracle contradicts the spec.

- [ ] **Step 5: Run Core and the type-checks**

Run:
- `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/core packages/auth packages/events`;
- both `tsc` commands.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/core
git commit -m "feat(core): Calendar access API, gated on the server; Administrator can't grant SysAdmin (C125)"
```

---

### Task 6: staff-web: Calendar access, Organizations, and no-email users

Covers spec §3 row 5a ("Core admin screens for all of these"), §8.5's role and ministries editing, R8, and Review Focus item 4 on screen.

**Files:**
- Create:
  - `apps/staff-web/src/screens/admin/messages.ts`;
  - `apps/staff-web/src/screens/admin/calendar-access/CalendarAccessScreen.tsx`, `CalendarAccessScreen.test.tsx`;
  - `apps/staff-web/src/screens/admin/calendar-access/fixtures.ts` (test fixtures shared by the screen test and the axe test; a test file never imports another test file, which would register its tests twice);
  - `apps/staff-web/src/screens/admin/organizations/OrganizationsScreen.tsx`, `OrganizationsScreen.test.tsx`.
- Modify:
  - `apps/staff-web/src/screens/admin/users/UsersScreen.tsx`, `UsersScreen.test.tsx`;
  - `apps/staff-web/src/screens/admin/a11y.test.tsx`;
  - `apps/staff-web/src/shell/AppShell.tsx`, `AppShell.test.tsx`;
  - `apps/staff-web/src/shell/HomeRedirect.tsx`;
  - `apps/staff-web/src/router.tsx`, `router.test.tsx`.

**Interfaces:**
- Consumes:
  - `GET` and `PUT /core/api/calendar-access[/:id]` (Task 5);
  - `GET /core/api/organizations` (with `isHq`) and `PUT /core/api/organizations/:key/hq` (Task 3);
  - `POST /core/api/users/:id/link` (Task 4);
  - the Task 1 mirror.
- Produces:
  - `messagesOf(caught: unknown): string[]`;
  - `CalendarAccessScreen`, with `type CalendarAccessUser` and `type OrgOption`;
  - `OrganizationsScreen`;
  - routes `/hub/calendar-access` and `/hub/organizations`;
  - nav items "Calendar access" and "Organizations".

- [ ] **Step 1: Write the failing screen tests**

`apps/staff-web/src/screens/admin/calendar-access/fixtures.ts` (shared by the screen test and the axe test; fictional people only):

```ts
import type { CalendarAccessUser, OrgOption } from "./CalendarAccessScreen";

export const ORGS: OrgOption[] = [
  { key: "health", displayName: "Health", abbreviation: "HLTH", isActive: true, isHq: false },
  { key: "gcpe-headquarters", displayName: "GCPE Headquarters", abbreviation: "GCPEHQ", isActive: true, isHq: true },
  { key: "retired", displayName: "Retired Ministry", abbreviation: "RET", isActive: false, isHq: false },
];
export const SELF: CalendarAccessUser = { id: "self-1", email: "sam.self@x.invalid", displayName: "Sam Self", isActive: true, calendarRole: "Calendar.Administrator", organizationKeys: ["health"] };
export const STAFF: CalendarAccessUser = { id: "staff-1", email: "robin.staff@x.invalid", displayName: "Robin Staff", isActive: true, calendarRole: null, organizationKeys: [] };
export const SYSADMIN: CalendarAccessUser = { id: "sys-1", email: "lee.sys@x.invalid", displayName: "Lee Sys", isActive: true, calendarRole: "Calendar.SysAdmin", organizationKeys: ["health"] };
export const IMPORTED: CalendarAccessUser = { id: "old-1", email: null, displayName: "Kim Imported", isActive: false, calendarRole: "Calendar.Editor", organizationKeys: ["retired"] };
export const ACCESS_USERS: CalendarAccessUser[] = [SELF, STAFF, SYSADMIN, IMPORTED];
```

`apps/staff-web/src/screens/admin/calendar-access/CalendarAccessScreen.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { CalendarAccessScreen } from "./CalendarAccessScreen";
import { ACCESS_USERS, ORGS, STAFF } from "./fixtures";

type Call = { url: string; init?: RequestInit };
function stub(roles: string[], calls: Call[], onPut?: (url: string, init: RequestInit) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "self-1", name: "Sam Self", email: "sam.self@x.invalid", roles }, expiresAt: new Date().toISOString() });
      if (url === "/core/api/calendar-access" && (init?.method ?? "GET") === "GET") return jsonResponse(200, ACCESS_USERS);
      if (url === "/core/api/organizations") return jsonResponse(200, ORGS);
      if (init?.method === "PUT" && onPut) return onPut(url, init);
      throw new Error(`unhandled: ${url} ${init?.method ?? "GET"}`);
    }),
  );
}

function renderScreen() {
  render(
    <SessionProvider>
      <MemoryRouter>
        <RequireAuth>
          <CalendarAccessScreen />
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe("CalendarAccessScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("sets the document title", async () => {
    stub(["Calendar.Administrator"], []);
    renderScreen();
    await screen.findByRole("heading", { level: 1, name: "Calendar access" });
    await waitFor(() => expect(document.title).toBe("Calendar access — GCPE News Staff"));
  });

  it("an Administrator is offered roles up to Administrator, and saves the role with the ministries", async () => {
    const calls: Call[] = [];
    stub(["Calendar.Administrator"], calls, () => jsonResponse(200, { ...STAFF, calendarRole: "Calendar.Editor", organizationKeys: ["health"] }));
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit access for Robin Staff" }));
    const form = screen.getByRole("form", { name: "Calendar access for Robin Staff" });
    const select = within(form).getByLabelText("Calendar role") as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual(["No Calendar access", "Read Only", "Editor", "Advanced", "Administrator"]);
    // Inactive ministries are offered only to users who already hold them.
    expect(within(form).queryByLabelText(/Retired Ministry/)).toBeNull();
    expect(within(form).getByLabelText("GCPE Headquarters (GCPEHQ) — HQ")).toBeInTheDocument();
    await user.selectOptions(select, "Calendar.Editor");
    await user.click(within(form).getByLabelText("Health (HLTH)"));
    await user.click(within(form).getByRole("button", { name: "Save Calendar access" }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.init?.method === "PUT")!;
    expect(put.url).toBe("/core/api/calendar-access/staff-1");
    expect(JSON.parse(put.init!.body as string)).toEqual({ role: "Calendar.Editor", organizationKeys: ["health"] });
    expect(await screen.findByRole("status")).toHaveTextContent("Saved Calendar access for Robin Staff.");
  });

  it("shows the server's refusal inside the form", async () => {
    stub(["Calendar.Administrator"], [], () => jsonResponse(403, { error: "only an HQ Administrator, a System Administrator or a Core admin can add an HQ ministry", reason: "hq-organization" }));
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit access for Robin Staff" }));
    const form = screen.getByRole("form", { name: "Calendar access for Robin Staff" });
    await user.click(within(form).getByLabelText("GCPE Headquarters (GCPEHQ) — HQ"));
    await user.click(within(form).getByRole("button", { name: "Save Calendar access" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("only an HQ Administrator, a System Administrator or a Core admin can add an HQ ministry");
  });

  it("a System Administrator's row and your own row are read-only for an Administrator", async () => {
    stub(["Calendar.Administrator"], []);
    renderScreen();
    await screen.findByRole("button", { name: "Edit access for Robin Staff" });
    expect(screen.queryByRole("button", { name: "Edit access for Lee Sys" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit access for Sam Self" })).toBeNull();
    expect(screen.getByText("Only a System Administrator or a Core admin can change this user’s access.")).toBeInTheDocument();
    expect(screen.getByText("You can’t change your own Calendar access.")).toBeInTheDocument();
  });

  it("a Core admin gets System Administrator and can edit their own row", async () => {
    stub(["Core.Admin"], []);
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit access for Sam Self" }));
    const select = within(screen.getByRole("form", { name: "Calendar access for Sam Self" })).getByLabelText("Calendar role") as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toContain("System Administrator");
  });

  it("inactive users, including those with no email, appear under the filter; their inactive ministries stay offered", async () => {
    stub(["Calendar.Administrator"], []);
    renderScreen();
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "Edit access for Robin Staff" });
    expect(screen.queryByText("Kim Imported")).toBeNull();
    await user.click(screen.getByLabelText("Show inactive users, including those with no email"));
    expect(screen.getByText("No email — inactive")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit access for Kim Imported" }));
    expect(within(screen.getByRole("form", { name: "Calendar access for Kim Imported" })).getByLabelText("Retired Ministry (RET) — inactive")).toBeChecked();
  });

  it("finds users by name or email", async () => {
    stub(["Calendar.Administrator"], []);
    renderScreen();
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "Edit access for Robin Staff" });
    await user.type(screen.getByLabelText("Find a user by name or email"), "LEE.SYS");
    expect(screen.queryByText("Robin Staff")).toBeNull();
    expect(screen.getByText("Lee Sys")).toBeInTheDocument();
  });

  it("someone without an admin role sees the permission message and nothing is fetched", async () => {
    const calls: Call[] = [];
    stub(["Calendar.Advanced"], calls);
    renderScreen();
    expect(await screen.findByText("You don’t have permission to view this page.")).toBeInTheDocument();
    expect(calls.map((c) => c.url)).toEqual(["/core/auth/session"]);
  });
});
```

`apps/staff-web/src/screens/admin/organizations/OrganizationsScreen.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { OrganizationsScreen } from "./OrganizationsScreen";

const ORGS = [
  { key: "health", displayName: "Health", abbreviation: "HLTH", isActive: true, isHq: false },
  { key: "gcpe-media-relations", displayName: "GCPE Media Relations", abbreviation: "GCPEMEDIA", isActive: true, isHq: true },
];

function stub(roles: string[], calls: { url: string; init?: RequestInit }[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u1", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
      if (url === "/core/api/organizations") return jsonResponse(200, ORGS);
      if (url === "/core/api/organizations/health/hq" && init?.method === "PUT") return jsonResponse(200, { ...ORGS[0], isHq: true });
      throw new Error(`unhandled: ${url}`);
    }),
  );
}

const renderScreen = () =>
  render(
    <SessionProvider>
      <MemoryRouter>
        <RequireAuth>
          <OrganizationsScreen />
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );

describe("OrganizationsScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("shows each organization's HQ flag and sets it", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(["Core.Admin"], calls);
    renderScreen();
    await waitFor(() => expect(document.title).toBe("Organizations — GCPE News Staff"));
    expect(await screen.findByLabelText("GCPE Media Relations is an HQ organization")).toBeChecked();
    const health = screen.getByLabelText("Health is an HQ organization");
    expect(health).not.toBeChecked();
    await userEvent.setup().click(health);
    await waitFor(() => expect(calls.some((c) => c.init?.method === "PUT")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.init?.method === "PUT")!.init!.body as string)).toEqual({ isHq: true });
    expect(await screen.findByRole("status")).toHaveTextContent("Health is now an HQ organization.");
  });

  it("is Core.Admin only", async () => {
    stub(["Calendar.SysAdmin"], []);
    renderScreen();
    expect(await screen.findByText("You don’t have permission to view this page.")).toBeInTheDocument();
  });
});
```

In `apps/staff-web/src/screens/admin/users/UsersScreen.test.tsx`, add:

```tsx
  it("shows a user with no email as such, and links them to an email", async () => {
    const IMPORTED: UserView = { id: "old-1", email: null, displayName: "Kim Imported", isActive: false, signInMethod: "local", roles: [] };
    const calls: { url: string; init?: RequestInit }[] = [];
    stubSession(calls, (url, init) => {
      if (url === "/core/api/users" && (init?.method ?? "GET") === "GET") return jsonResponse(200, [SELF, IMPORTED]);
      if (url === "/core/api/users/old-1/link" && init?.method === "POST") return jsonResponse(200, { ...IMPORTED, email: "kim.imported@x.invalid", isActive: true });
      return null;
    });
    render(withAuth(<UsersScreen />));
    const user = userEvent.setup();
    expect(await screen.findByRole("heading", { name: "Kim Imported (no email) (inactive)" })).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: /Kim Imported/ })).toBeNull();
    const form = screen.getByRole("form", { name: "Link Kim Imported to an email" });
    await user.type(within(form).getByLabelText(/^Email for Kim Imported/), "kim.imported@x.invalid");
    await user.click(within(form).getByRole("button", { name: "Link and activate" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/core/api/users/old-1/link")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.url === "/core/api/users/old-1/link")!.init!.body as string)).toEqual({ email: "kim.imported@x.invalid" });
  });
```

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/admin`
Expected: FAIL. The two screens don't exist, and `UserView.email` can't be null.

- [ ] **Step 2: Move `messagesOf` and build the Calendar access screen**

`apps/staff-web/src/screens/admin/messages.ts`: move `messagesOf` here verbatim from `UsersScreen.tsx` (with its doc comment, and `export`). `UsersScreen.tsx` imports it from `"../messages"`.

`apps/staff-web/src/screens/admin/calendar-access/CalendarAccessScreen.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, InlineAlert, TextField } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../../api/client";
import { useSession } from "../../../session/SessionContext";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { messagesOf } from "../messages";
import { calendarRoleLabel, canManageCalendarAccess, ceilingLevel, grantableCalendarRoles, levelOf, type CalendarRoleName } from "./calendar-roles";

export interface CalendarAccessUser {
  id: string;
  email: string | null;
  displayName: string;
  isActive: boolean;
  calendarRole: CalendarRoleName | null;
  organizationKeys: string[];
}

/** The fields of Core's OrgRecord this screen reads. */
export interface OrgOption {
  key: string;
  displayName: string;
  abbreviation: string | null;
  isActive: boolean;
  isHq: boolean;
}

function orgLabel(o: OrgOption): string {
  return `${o.displayName}${o.abbreviation ? ` (${o.abbreviation})` : ""}${o.isHq ? " — HQ" : ""}${o.isActive ? "" : " — inactive"}`;
}

function AccessEditor({ user, orgs, onSaved, onCancel }: { user: CalendarAccessUser; orgs: OrgOption[]; onSaved(message: string): void; onCancel(): void }): React.JSX.Element {
  const session = useSession();
  const [role, setRole] = useState<CalendarRoleName | "">(user.calendarRole ?? "");
  const [keys, setKeys] = useState<string[]>(user.organizationKeys);
  const [messages, setMessages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // Inactive ministries can't be added, but one the user already holds stays offered so it can be kept.
  const choices = orgs.filter((o) => o.isActive || user.organizationKeys.includes(o.key));
  const toggle = (key: string) => setKeys((k) => (k.includes(key) ? k.filter((x) => x !== key) : [...k, key]));

  const save = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setMessages([]);
    try {
      await apiFetch(`/core/api/calendar-access/${user.id}`, { method: "PUT", body: { role: role === "" ? null : role, organizationKeys: keys } });
      onSaved(`Saved Calendar access for ${user.displayName}.`);
    } catch (caught) {
      setMessages(messagesOf(caught));
    } finally {
      setBusy(false);
    }
  };

  const selectId = `calendar-role-${user.id}`;
  return (
    <form onSubmit={save} aria-label={`Calendar access for ${user.displayName}`}>
      {messages.map((m) => (
        <p role="alert" key={m}>
          {m}
        </p>
      ))}
      <label htmlFor={selectId}>Calendar role</label>
      <select id={selectId} value={role} onChange={(e) => setRole(e.target.value as CalendarRoleName | "")} disabled={busy}>
        <option value="">No Calendar access</option>
        {grantableCalendarRoles(session).map((r) => (
          <option key={r.role} value={r.role}>
            {r.label}
          </option>
        ))}
      </select>
      <fieldset>
        <legend>Ministries</legend>
        {choices.map((o) => {
          const id = `org-${user.id}-${o.key}`;
          return (
            <div key={o.key}>
              <input id={id} type="checkbox" checked={keys.includes(o.key)} onChange={() => toggle(o.key)} disabled={busy} />
              <label htmlFor={id}>{orgLabel(o)}</label>
            </div>
          );
        })}
      </fieldset>
      <Button type="submit" isDisabled={busy}>
        Save Calendar access
      </Button>
      <Button variant="secondary" onPress={onCancel} isDisabled={busy}>
        Cancel
      </Button>
    </form>
  );
}

/**
 * `/hub/calendar-access`: Calendar roles and ministries (spec addendum §4, §8.5). Open to
 * Core.Admin, Calendar.Administrator and Calendar.SysAdmin. The server decides every grant
 * (C125); this screen only offers what the server would allow, and shows its refusal otherwise.
 */
export function CalendarAccessScreen(): React.JSX.Element {
  const session = useSession();
  useDocumentTitle("Calendar access");
  const allowed = canManageCalendarAccess(session);
  const [users, setUsers] = useState<CalendarAccessUser[] | null>(null);
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const latest = useRef(0);

  const reload = useCallback(() => {
    const call = ++latest.current;
    Promise.all([apiFetch<CalendarAccessUser[]>("/core/api/calendar-access"), apiFetch<OrgOption[]>("/core/api/organizations")]).then(
      ([u, o]) => {
        if (call !== latest.current) return;
        setUsers(u);
        setOrgs(o);
        setLoadError(null);
      },
      () => {
        if (call === latest.current) setLoadError("Couldn't load Calendar access.");
      },
    );
  }, []);

  useEffect(() => {
    if (allowed) reload();
  }, [allowed, reload]);

  if (!allowed) {
    return (
      <div className="gcpe-calendar-access">
        <h1>Calendar access</h1>
        <p>You don&rsquo;t have permission to view this page.</p>
      </div>
    );
  }

  const byKey = new Map(orgs.map((o) => [o.key, o]));
  const needle = filter.trim().toLowerCase();
  const shown = (users ?? []).filter((u) => (showInactive || u.isActive) && (!needle || u.displayName.toLowerCase().includes(needle) || (u.email ?? "").includes(needle)));
  const ceiling = ceilingLevel(session);
  const isCoreAdmin = session.has("Core.Admin");

  return (
    <div className="gcpe-calendar-access">
      <h1>Calendar access</h1>
      <p>Give staff a Calendar role and their ministries. Members of an HQ organization see every ministry.</p>
      {loadError && <InlineAlert variant="danger" role="alert" description={loadError} />}
      {status && <p role="status">{status}</p>}
      <TextField label="Find a user by name or email" value={filter} onChange={setFilter} />
      <div>
        <input id="calendar-access-show-inactive" type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
        <label htmlFor="calendar-access-show-inactive">Show inactive users, including those with no email</label>
      </div>
      {users === null && !loadError && <p>Loading…</p>}
      <ul>
        {shown.map((u) => {
          const ministries = u.organizationKeys.map((k) => byKey.get(k)?.abbreviation ?? k).join(", ") || "none";
          const locked =
            !isCoreAdmin && session.user?.id === u.id
              ? "You can’t change your own Calendar access."
              : levelOf(u.calendarRole) > ceiling
                ? "Only a System Administrator or a Core admin can change this user’s access."
                : null;
          return (
            <li key={u.id}>
              <h2>{u.displayName}</h2>
              <p>
                {u.email ?? "No email"}
                {u.isActive ? "" : " — inactive"}
              </p>
              <p>
                Calendar role: {u.calendarRole ? calendarRoleLabel(u.calendarRole) : "No Calendar access"}. Ministries: {ministries}.
              </p>
              {locked ? (
                <p>{locked}</p>
              ) : editing === u.id ? (
                <AccessEditor
                  user={u}
                  orgs={orgs}
                  onSaved={(m) => {
                    setEditing(null);
                    setStatus(m);
                    reload();
                  }}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <Button
                  variant="secondary"
                  onPress={() => {
                    setStatus(null);
                    setEditing(u.id);
                  }}
                >
                  {`Edit access for ${u.displayName}`}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
```

- [ ] **Step 3: Build the Organizations screen**

`apps/staff-web/src/screens/admin/organizations/OrganizationsScreen.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { InlineAlert } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../../api/client";
import { useSession } from "../../../session/SessionContext";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { messagesOf } from "../messages";
import type { OrgOption } from "../calendar-access/CalendarAccessScreen";

/**
 * `/hub/organizations`: Core.Admin's HQ switch (spec addendum §4, C124). Organizations
 * themselves are edited by the seed and the importer; this screen only sets `isHq`.
 */
export function OrganizationsScreen(): React.JSX.Element {
  const session = useSession();
  useDocumentTitle("Organizations");
  const isAdmin = session.has("Core.Admin");
  const [orgs, setOrgs] = useState<OrgOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);

  const reload = useCallback(() => {
    const call = ++latest.current;
    apiFetch<OrgOption[]>("/core/api/organizations").then(
      (o) => {
        if (call === latest.current) setOrgs(o);
      },
      () => {
        if (call === latest.current) setLoadError("Couldn't load organizations.");
      },
    );
  }, []);

  useEffect(() => {
    if (isAdmin) reload();
  }, [isAdmin, reload]);

  if (!isAdmin) {
    return (
      <div className="gcpe-organizations">
        <h1>Organizations</h1>
        <p>You don&rsquo;t have permission to view this page.</p>
      </div>
    );
  }

  const setHq = async (o: OrgOption, isHq: boolean) => {
    setBusy(true);
    setMessages([]);
    setStatus(null);
    try {
      await apiFetch(`/core/api/organizations/${encodeURIComponent(o.key)}/hq`, { method: "PUT", body: { isHq } });
      setStatus(`${o.displayName} is ${isHq ? "now" : "no longer"} an HQ organization.`);
      reload();
    } catch (caught) {
      setMessages(messagesOf(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gcpe-organizations">
      <h1>Organizations</h1>
      <p>Members of an HQ organization see every ministry in the Corporate Calendar and get its HQ-only fields and actions.</p>
      {loadError && <InlineAlert variant="danger" role="alert" description={loadError} />}
      {messages.map((m) => (
        <p role="alert" key={m}>
          {m}
        </p>
      ))}
      {status && <p role="status">{status}</p>}
      {orgs === null && !loadError && <p>Loading…</p>}
      {orgs && (
        <table>
          <caption>Organizations and their HQ flag</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Abbreviation</th>
              <th scope="col">Active</th>
              <th scope="col">HQ</th>
            </tr>
          </thead>
          <tbody>
            {orgs.map((o) => (
              <tr key={o.key}>
                <td>{o.displayName}</td>
                <td>{o.abbreviation ?? ""}</td>
                <td>{o.isActive ? "Yes" : "No"}</td>
                <td>
                  <input type="checkbox" aria-label={`${o.displayName} is an HQ organization`} checked={o.isHq} disabled={busy} onChange={(e) => void setHq(o, e.target.checked)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 4: No-email users and Link on the Users screen**

In `UsersScreen.tsx`:
- `UserView.email` becomes `string | null`.
- In `UserRow`, add `const who = user.email ?? \`${user.displayName} (no email)\`;`. Replace every `{user.email}` and `${user.email}` in labels with `who`. The `h2` becomes `{who} {!user.isActive && "(inactive)"}`.
- When `user.email === null`, render `<p>Inactive until linked to an email.</p>` and `<LinkForm user={user} onChanged={onChanged} />` **instead of** the active `Switch`.
- Add:

```tsx
/** Legacy Calendar users imported with no email (spec addendum §4) can't sign in until linked. */
function LinkForm({ user, onChanged }: { user: UserView; onChanged(): void }): React.JSX.Element {
  const [email, setEmail] = useState("");
  const [messages, setMessages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setMessages([]);
    try {
      await apiFetch<UserView>(`/core/api/users/${user.id}/link`, { method: "POST", body: { email } });
      onChanged();
    } catch (caught) {
      setMessages(messagesOf(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} aria-label={`Link ${user.displayName} to an email`}>
      {messages.map((m) => (
        <p role="alert" key={m}>
          {m}
        </p>
      ))}
      <p>Linking sets this user&rsquo;s email and activates them, so they can sign in.</p>
      <TextField label={`Email for ${user.displayName}`} type="email" value={email} onChange={setEmail} isRequired isDisabled={busy} />
      <Button type="submit" isDisabled={busy || email.trim() === ""}>
        Link and activate
      </Button>
    </form>
  );
}
```

- [ ] **Step 5: Nav, landing and routes**

`AppShell.tsx`:
- import `canManageCalendarAccess` from `"../screens/admin/calendar-access/calendar-roles"`;
- in `NAV_ITEMS`, after Users, add:

```ts
  { to: "/calendar-access", label: "Calendar access", show: canManageCalendarAccess },
  { to: "/organizations", label: "Organizations", show: (s) => s.has("Core.Admin") },
```

- extend its doc comment with: "Calendar access is visible to Core.Admin, Calendar.Administrator and Calendar.SysAdmin; Organizations to Core.Admin."

`HomeRedirect.tsx`:

```tsx
export function HomeRedirect(): React.JSX.Element {
  const session = useSession();
  const nrms = session.has("NRMS.Viewer") || session.has("NRMS.Editor") || session.has("NRMS.SiteEditor");
  const target = nrms ? "/releases/drafts" : canReadSubscribers(session) ? "/subscribers" : canManageCalendarAccess(session) ? "/calendar-access" : "/releases/drafts";
  return <Navigate to={target} replace />;
}
```

Update its doc comment: "…Subscribers for someone whose only staff roles are NoD ones, and Calendar access for a Calendar administrator with neither."

`router.tsx`: import both screens. After `{ path: "users", … }`, add `{ path: "calendar-access", element: <CalendarAccessScreen /> }` and `{ path: "organizations", element: <OrganizationsScreen /> }`.

`AppShell.test.tsx`:
- `allLabels` becomes `["Releases", "Search", "Website", "Subscribers", "Users", "Calendar access", "Organizations", "Media list names", "Error log"]`;
- the Core.Admin expectation becomes `["Website", "Users", "Calendar access", "Organizations", "Media list names", "Error log"]`;
- add:

```tsx
  it("Calendar Administrators and System Administrators see Calendar access only; other Calendar roles see nothing yet", async () => {
    await renderShell(["Calendar.Administrator"]);
    expect(visibleLabels()).toEqual(["Calendar access"]);
    cleanup();
    await renderShell(["Calendar.SysAdmin"]);
    expect(visibleLabels()).toEqual(["Calendar access"]);
    cleanup();
    await renderShell(["Calendar.Advanced"]);
    expect(visibleLabels()).toEqual([]);
  });
```

`router.test.tsx`: add, modelled on the NoD landing test:

```tsx
  it("a Calendar administrator with no NRMS or NoD role lands on Calendar access", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@x.invalid", roles: ["Calendar.Administrator"] }, expiresAt: new Date().toISOString() });
        if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
        if (url === "/core/api/calendar-access") return jsonResponse(200, []);
        if (url === "/core/api/organizations") return jsonResponse(200, []);
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const router = createMemoryRouter(routes, { basename: "/hub", initialEntries: ["/hub/"] });
    render(
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>,
    );
    expect(await screen.findByRole("heading", { level: 1, name: "Calendar access" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/hub/calendar-access");
  });
```

`a11y.test.tsx`:
- `ONE_USER` stays as is; its `email` is a string, which still fits.
- Add one case per new screen, stubbing the same URLs as their screen tests. Import `ORGS` and `ACCESS_USERS` from `./calendar-access/fixtures`, and `userEvent` from `@testing-library/user-event`.
- For `CalendarAccessScreen`, also open Robin's editor before running axe, so the form is checked too:

```tsx
  it("CalendarAccessScreen, with an editor open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "self-1", name: "Sam Self", email: "sam.self@x.invalid", roles: ["Calendar.Administrator"] }, expiresAt: new Date().toISOString() });
        if (url === "/core/api/calendar-access") return jsonResponse(200, ACCESS_USERS);
        if (url === "/core/api/organizations") return jsonResponse(200, ORGS);
        return jsonResponse(200, {});
      }),
    );
    const { container } = render(withAuth(<CalendarAccessScreen />));
    await userEvent.setup().click(await screen.findByRole("button", { name: "Edit access for Robin Staff" }));
    await screen.findByRole("form", { name: "Calendar access for Robin Staff" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("OrganizationsScreen", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u1", name: "Pat", email: "pat@x.invalid", roles: ["Core.Admin"] }, expiresAt: new Date().toISOString() });
        if (url === "/core/api/organizations") return jsonResponse(200, ORGS);
        return jsonResponse(200, {});
      }),
    );
    const { container } = render(withAuth(<OrganizationsScreen />));
    await screen.findByLabelText("Health is an HQ organization");
    expect(await seriousViolations(container)).toEqual([]);
  });
```

- [ ] **Step 6: Run staff-web and the type-check**

Run:
- `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web`;
- `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p apps/staff-web/tsconfig.json`.

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/staff-web
git commit -m "feat(staff-web): Calendar access and Organizations screens; no-email users and Link"
```

---

### Task 7: End to end, parity lists, runbook and running notes

Covers acceptance item 1 (the Core half), the sub-plan exit ("its parity rows and questions are updated, and its running-notes lines are written"), and the spec wording for R4.

**Files:**
- Create:
  - `tests/e2e/calendar-access.spec.ts`;
  - `docs/superpowers/plans/phase-5-carry-forward.md`.
- Modify:
  - `docs/parity/changes-from-legacy.md`, `docs/parity/open-questions.md`;
  - `docs/manuals/running-notes.md`;
  - `docs/deploy/siteground.md`;
  - `docs/superpowers/specs/2026-10-07-calendar-parity-design.md` (two lines: §4 "Event" and §5.4).

**Interfaces:**
- Consumes:
  - `loginForCookie`, `apiCall`, `baseUrl` and `expectNoSeriousA11yViolations` (`tests/e2e/playwright-support.ts`);
  - `ADMIN_USERNAME` and `ADMIN_PASSWORD` (`tests/e2e/constants.ts`);
  - `healthOrg` (`apps/core/test/helpers.ts`);
  - every route from Tasks 3–5.

- [ ] **Step 1: Write the e2e spec**

`tests/e2e/calendar-access.spec.ts`:

```ts
// Acceptance item 1, Core half: a Calendar Administrator sets a user's role and ministries on
// the Calendar access screen, isn't offered System Administrator, and the server refuses it
// (and an HQ ministry) even when asked directly. Visibility of activities is 5c's half.
import { test, expect } from "@playwright/test";
import { healthOrg } from "../../apps/core/test/helpers";
import { ADMIN_PASSWORD, ADMIN_USERNAME } from "./constants";
import { apiCall, baseUrl, expectNoSeriousA11yViolations, loginForCookie } from "./playwright-support";

test.describe("Calendar access", () => {
  test("a Calendar Administrator grants Editor with a ministry, and can't grant System Administrator or an HQ ministry", async ({ page, context }) => {
    const admin = await loginForCookie(ADMIN_USERNAME, ADMIN_PASSWORD);
    const stamp = Date.now();
    await apiCall(admin, "/core/api/organizations/health", { method: "PUT", body: healthOrg });
    await apiCall(admin, "/core/api/organizations/gcpe-headquarters", {
      method: "PUT",
      body: { ...healthOrg, key: "gcpe-headquarters", displayName: "GCPE Headquarters", abbreviation: "GCPEHQ", sectorKeys: [], isHq: true },
    });
    const calAdminEmail = `cal-admin-${stamp}@example.test`;
    const calAdmin = await apiCall<{ id: string }>(admin, "/core/api/users", { method: "POST", body: { email: calAdminEmail, displayName: `Calendar Admin ${stamp}`, password: "e2e-cal-admin-password-1" } });
    const staff = await apiCall<{ id: string }>(admin, "/core/api/users", { method: "POST", body: { email: `cal-staff-${stamp}@example.test`, displayName: `Calendar Staff ${stamp}` } });
    await apiCall(admin, `/core/api/calendar-access/${calAdmin.id}`, { method: "PUT", body: { role: "Calendar.Administrator", organizationKeys: ["health"] } });

    const cookie = await loginForCookie(calAdminEmail, "e2e-cal-admin-password-1");
    const [name, value] = cookie.split("=", 2) as [string, string];
    await context.addCookies([{ name, value, domain: new URL(baseUrl()).hostname, path: "/", httpOnly: true, secure: false, sameSite: "Lax" }]);

    await page.goto("/hub/");
    await expect(page).toHaveURL(/\/hub\/calendar-access$/);
    await expect(page.getByRole("heading", { level: 1, name: "Calendar access" })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "Calendar access");

    await page.getByRole("button", { name: `Edit access for Calendar Staff ${stamp}` }).click();
    const form = page.getByRole("form", { name: `Calendar access for Calendar Staff ${stamp}` });
    const roleSelect = form.getByLabel("Calendar role");
    await expect(roleSelect.locator("option")).toHaveText(["No Calendar access", "Read Only", "Editor", "Advanced", "Administrator"]);
    await roleSelect.selectOption("Calendar.Editor");
    await form.getByLabel(/^Health/).check();
    await expectNoSeriousA11yViolations(page, "Calendar access editor");
    await form.getByRole("button", { name: "Save Calendar access" }).click();
    await expect(page.getByRole("status")).toHaveText(`Saved Calendar access for Calendar Staff ${stamp}.`);
    // Scoped to this run's row: a retried run leaves an earlier Calendar Staff with the same text.
    await expect(page.getByRole("listitem").filter({ hasText: `Calendar Staff ${stamp}` })).toContainText("Calendar role: Editor. Ministries: HLTH.");

    // The server refuses what the screen doesn't offer.
    const direct = (body: object) =>
      fetch(`${baseUrl()}/core/api/calendar-access/${staff.id}`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json", "x-gcpe-request": "1" },
        body: JSON.stringify(body),
      });
    const sys = await direct({ role: "Calendar.SysAdmin", organizationKeys: ["health"] });
    expect(sys.status).toBe(403);
    expect(await sys.json()).toMatchObject({ reason: "above-ceiling" });
    const hq = await direct({ role: "Calendar.Editor", organizationKeys: ["gcpe-headquarters"] });
    expect(hq.status).toBe(403);
    expect(await hq.json()).toMatchObject({ reason: "hq-organization" });
  });
});
```

Run: `npx -y -p node@24 -- npm run test:e2e -- tests/e2e/calendar-access.spec.ts`
Expected: PASS. If the landing check fails, look at `HomeRedirect`. A calendar-only user must not hold any NRMS role here; the POST above sends no `roles`.

- [ ] **Step 2: Run the whole suite**

Run:
- `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run`;
- both `tsc` commands;
- `npx -y -p node@24 -- npm run test:e2e`.

Expected: all PASS. `sign-in-roles.spec.ts` must stay green: the five test users hold no Calendar roles.

- [ ] **Step 3: `docs/parity/changes-from-legacy.md`**

Add a new section at the end, `## Corporate Calendar (Phase 5)`, with the table header used elsewhere. Re-check the highest C number first: C123 at planning; the spec reserves C124–C158. Add:

```markdown
| C124 | Two settings: `ApplicationOwnerOrganizations` (a CSV whose members see every ministry and get the HQ report variant) and `HQAdmin` (one ministry, GCPEHQ, whose Editor-and-above members get the freeze exemption, the Look Ahead fieldset, relaxed required fields and review markup). | One `is_hq` flag on Core organizations, set on the Organizations screen (Core admin) and carried on `org.upserted`. A member of any HQ organization gets all of these. GCPEHQ and GCPEMEDIA are HQ (Q49), so GCPE Media Relations members also get what legacy gave only GCPEHQ. | One concept for staff and admins. Paul's decision R1 defines the exemption by HQ membership. | Agreed (Q49) |
| C125 | Roles and ministries lived in `calendar.SystemUser`. Any admin page user could set any role, including SysAdmin, and the admin pages had no server gate. | Calendar roles and ministries are Core grants, changed only through Core's Calendar access routes, which check the role on the server. Calendar.Administrator grants up to Administrator and can't change a System Administrator's access; only SysAdmin or Core.Admin grants SysAdmin. A Calendar role needs at least one ministry, as legacy's page required. | One user store; no self-escalation to SysAdmin. | Agreed |
| C159 | Any admin-page user could change their own role and ministries (`Calendar/Admin/User.aspx.cs`). | Only a Core admin can change their own Calendar access. A Calendar Administrator or System Administrator asks another administrator. | No self-escalation (for example, adding an HQ ministry to yourself), and no admin locks themself out by mistake. | Proposed |
| C160 | Any admin-page user could give anyone the GCPEHQ ministry, making them HQ. | Adding an HQ organization to a user takes an HQ Administrator, a System Administrator or a Core admin. Removing one doesn't. | HQ sees every ministry, and confidential items at Advanced (spec §6). A ministry Administrator shouldn't hand that out. | Proposed |
```

- [ ] **Step 4: `docs/parity/open-questions.md`**

Re-check the highest Q number. It was Q47 at planning, and the spec reserves Q48–Q53.

- Under **Answered**, add Q48 and Q49 as the spec words them at `df5062b`, in this file's Answered columns: question, answer, who and when, raised.
- Under **Open**, add:

```markdown
| Q54 | Should HQ organizations (GCPE Headquarters, GCPE Media Relations) be hidden from the public News API and the subscribe page? Our News API lists every ministry Core sends; legacy's public API lists 36 ministries and no GCPE organization (checked 2026-10-07). | Once Core has them (the BC seed adds both; the legacy importer brings every `dbo.Ministry` row), they appear in the public ministry list and as subscribable ministries. | Shown on test sites (boxs.ca only); must be settled before Phase 7. | 2026-10-07 |
| Q55 | May a Calendar Administrator deactivate, reactivate or link a user who also holds NRMS or NoD roles? Core has one active flag for every app. | Legacy's Calendar deactivation affected only the Calendar. Here it would also end that person's NRMS or NoD access. | No: only a Core admin can, for anyone holding a non-Calendar role. Calendar Administrators can for Calendar-only users (built in 5b). | 2026-10-07 |
```

- [ ] **Step 5: `docs/manuals/running-notes.md`**

Add `## Phase 5a — Calendar roles, ministries and HQ organizations`:

```markdown
- **Administrator** — Calendar access (Hub → Calendar access) gives a person one Calendar role (Read
  Only, Editor, Advanced, Administrator, System Administrator) and their ministries. A role needs at
  least one ministry. Saving replaces the person's whole ministry list.
- **Administrator** — A Calendar Administrator can grant up to Administrator. Only a System
  Administrator or a Core admin can grant System Administrator, or change a System Administrator's
  access. Nobody but a Core admin can change their own access: ask another administrator.
- **Administrator** — Members of an HQ organization see every ministry. GCPE Headquarters and GCPE
  Media Relations are HQ. Only an HQ Administrator, a System Administrator or a Core admin can add an
  HQ ministry to someone.
- **Administrator** — Core admins set which organizations are HQ on Hub → Organizations. Turning HQ off
  for an organization takes the all-ministry view away from every member at once.
- **Administrator** — A user with no email (imported from the legacy Calendar) is inactive and can't
  sign in. On Hub → Users, "Link and activate" sets their email and lets them sign in once they
  have a password.
- **Administrator** — A ministry that has been deactivated can't be added to anyone, but people who
  already have it keep it when their access is saved.
- **Developer** — Core emits `user.upserted` for every user change and on republish. Nothing consumes
  it until the Calendar app (5b) subscribes. Ministries are named by organization key.
- **Operations** — After deploying 5a, re-run `scripts/seed-core-from-public-api.ts` on test sites to
  add the two HQ organizations. Re-running it never clears an HQ flag set by hand.
```

- [ ] **Step 6: `docs/deploy/siteground.md`**

Add a section `## Calendar access (Phase 5a)`:
- **Migration:** Core's `0002_calendar_access` is additive: a column, a nullable email with a check, two tables and a partial index on `role_grants`. It runs in the normal deploy. It succeeds on boxs.ca's data because every existing user has an email and no grant is a Calendar role.
- **Seed:** re-run `GCPE_TOKEN=… npm run core:seed-from-public-api -- https://boxs.ca`. Its summary has a `hq-organizations: upserted=2` line.
- **Hand checks** (acceptance item 1, Core half):
  - As the break-glass admin, on Hub → Organizations, GCPE Headquarters and GCPE Media Relations are ticked HQ.
  - On Hub → Users, add a user with a password. On Calendar access, give them Administrator with one ministry.
  - Sign in as them. They land on Calendar access.
  - Give another user Editor with a ministry. "System Administrator" is not offered.
  - Their own row and any System Administrator's row are read-only.
  - Adding GCPE Headquarters to someone is refused with the HQ message.

- [ ] **Step 7: The spec's two lines, and the carry-forward file**

In `docs/superpowers/specs/2026-10-07-calendar-parity-design.md`, §4 "Event": replace "`organizationIds`" with "`organizationKeys` (organization keys, as every other event names organizations; `OrgRecord` carries no id)". In §5.4 the `user.upserted` row still points to §4, so nothing changes there. Commit this with a message that says it changes the approved spec. Paul confirms (Questions, item 2).

Create `docs/superpowers/plans/phase-5-carry-forward.md`:

```markdown
# Phase 5 carry-forward

Items one sub-plan leaves for a later one. Delete an item when the plan that takes it is written.

## 5b

- **Calendar subscriber.** Add the Calendar app to Core's `EVENT_SUBSCRIBERS` for `user.upserted`, `org.*`, `sector.*`, `theme.*` and `tag.*` (`apps/stack/src/env.ts`). Then run Core's republish once so the projections fill.
- **User projection.** `user.upserted` carries `organizationKeys`. HQ is "any organization in the user's keys with `isHq` in the org projection". A user missing from the projection has no Calendar access.
- **Calendar users screen (§8.5).** Role and ministries go through `PUT /core/api/calendar-access/:id` (built in 5a). Active and Link for Calendar Administrators need new Core routes, under Q55's rule: Calendar-only users only, unless the caller is Core.Admin.
- **Calendar test users.** Add Calendar test users to `TEST_USERS`, `scripts/siteground-seed-users.sh` and `tests/e2e/constants.ts`, with ministries. `seedTestUsers` will need the organizations to exist first.
- **Break-glass.** The break-glass admin has no users row, so it has no Calendar access in the Calendar app. That is by design; say so in the runbook.
```

- [ ] **Step 8: Final verification**

Run, all under Node 24:
- `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run`;
- both `tsc` commands;
- `npx -y -p node@24 -- npm run test:e2e`.

Then check the diff for addresses:
- `git diff df5062b | grep -oE "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+" | sort -u`. Every result must be at `example.test`, `example.com` or `x.invalid`, or an address already present at `df5062b`.
- `git diff df5062b -- apps packages scripts | grep -nE "Task [0-9]|\bR[0-9]+\b|fix round"` must print nothing: no plan labels in code, and the spec's own R-decisions are cited by section.

- [ ] **Step 9: Commit**

```bash
git add tests/e2e/calendar-access.spec.ts docs
git commit -m "test(e2e),docs: Calendar access end to end; parity C124 C125 C159 C160, Q48 Q49 answered, Q54 Q55; runbook and running notes"
```

---

## Risks and things to watch

- **Decision-relevant: HQ organizations become public ministries (Q54).** Seeding GCPE Headquarters and GCPE Media Relations puts them in boxs.ca's News API ministry list, and on its subscribe page. **Verified:** `listMinistries` doesn't filter (`apps/news-api/src/read.ts:35-43`), and the live legacy API lists none of them. The legacy Core importer already imports every `dbo.Ministry` row, so production has the same exposure in Phase 7 whatever 5a does.
- **The PREM question.** Legacy's README default for `ApplicationOwnerOrganizations` is `"GCPEHQ,GCPEMEDIA,PREM"` (`README.md:452`). Paul's Q49 answer names only GCPEHQ and GCPEMEDIA. If production's config included PREM, Office of the Premier staff lose the all-ministry view at cutover. **Not checked:** production's actual setting.
- **`organizationKeys` departs from the spec's `organizationIds`** (R4). If Paul prefers ids, `OrgRecord` must gain `id` and every consumer's org projection must store it. That is a larger change than the rename.
- **The matrix test's oracle restates the rules.** It is independent of `checkCalendarGrant`'s code, not of the spec. If the spec's rule is wrong, both agree. The two proposed rules (C159, C160) are the ones to confirm.
- **Startup republish now includes users.** `apps/core/src/start.ts:72` republishes on start. At about 470 imported users that is about 470 small transactions. **Inferred** to be quick, not measured.
- **The deactivation cascade isn't built.** A Calendar.Administrator who loses the role keeps any open browser tab until their next `/api` call, which re-derives roles. That is the same as every other role today.

## Self-review (done while writing)

- **Spec coverage (§4 and the 5a row):**
  - Calendar roles and levels: Task 1 (levels 1–5, "level ≥ n").
  - One role per user: Task 2's partial index and `setCalendarAccess`.
  - `user_organizations`: Task 2. M(u) on the user view and the event: Tasks 2 and 5.
  - The HQ flag: Task 2 (column) and Task 3 (event, route, seed, importer; GCPEHQ and GCPEMEDIA per Q49).
  - Who grants what: Tasks 1 and 5 (C125, plus the C159 and C160 proposals).
  - Grants through Core's API: Task 5.
  - Users without email: Task 2 (nullable column, check, NULL-distinct uniqueness) and Task 4 (create inactive, activation refused, link, no sign-in).
  - `user_legacy_ids`: Task 2 (schema only; 5i writes it).
  - Calendar contact details stay out of Core: nothing in 5a adds them.
  - `user.upserted`: Task 2 (contract, emission, republish).
  - Core admin screens: Task 6.
  - **Exit check:** the matrix in Task 5; "can't grant SysAdmin" in Tasks 1, 5 and 7; "inactive no-email user can't sign in" in Task 4.
  - Parity rows C124 and C125, Q48 and Q49, and running notes: Task 7.
  - §8.5's Calendar-admin Active and Link are deferred to 5b (R7), and recorded in the carry-forward.
- **Placeholders:** none. Two steps describe mechanical edits without repeating every line:
  - Task 2 Step 8 appends `, []` to existing test calls in six named files;
  - Task 3 Step 4 adds `isHq: false` to `OrgRecord` literals that `tsc` names.
  Both say exactly what changes.
- **Type consistency:**
  - `CalendarRole`, `CALENDAR_ROLES` and `calendarRoleSchema` hold the same five names. Task 2's test and Task 1's staff-web test pin the equality.
  - `UserView.calendarRole` and `organizationKeys` (Task 2) feed `toUserRecord`, `CalendarAccessView` (Task 5) and staff-web's `CalendarAccessUser` (Task 6).
  - `REFUSAL_MESSAGES` strings match Task 5's test and Task 6's refusal fixture.
  - `OrgOption` is a subset of `OrgRecord` with `isHq` (Task 3).
  - `usersRouter(db, subscribers)` is used by `routes.ts`, and `setCalendarAccess(db, actor, id, input, subscribers)` by the router and the tests.
- **Review Focus:** each item names its pinning test, and each test is present in its task's code.

## Questions for Paul (product decisions only)

1. **Self-edit and HQ-ministry rules (C159, C160, proposed).** Only a Core admin changes their own Calendar access. Only an HQ Administrator, a System Administrator or a Core admin can add an HQ ministry to someone. Keep both?
2. **`organizationKeys` instead of `organizationIds` on `user.upserted`.** Every other event names organizations by key, and `OrgRecord` has no id. Task 7 edits spec §4 to match. OK?
3. **HQ organizations on public lists (Q54).** Hide GCPE Headquarters and GCPE Media Relations from the public ministry list and the subscribe page? Legacy's public API doesn't show them.
4. **Calendar Administrators and users with other roles (Q55, for 5b).** May a Calendar Administrator deactivate or link someone who also holds NRMS or NoD roles? Proposed: no, only a Core admin.
5. **PREM.** Legacy's documented default made the Office of the Premier an application owner too. Your Q49 answer leaves it out. Confirm production didn't rely on it.
6. **Who creates users.** Legacy Calendar admins could add users. In 5a only a Core admin creates users, and Calendar Administrators grant access to existing ones. OK until Entra sign-in creates users on first sign-in?
