# Phase 5b-2: Calendar Users Screen, Calendar Test Users and the Report-Rendering Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Calendar Administrators manage Calendar users in the Calendar section: legacy's user list ("Full name (Abbreviation) (rank)"), a user page that edits the Calendar-owned contact details and comm-contact ranks, the Calendar role and ministries through Core, and (for Calendar-only users, Q55) active and link through two new Core routes. Seeded Calendar test users exist locally, in e2e and on boxs.ca. A committed spike report answers spec §10.1 with measured numbers: how one HTML template becomes PDF and Word, at Letter portrait and Legal landscape, on local Node 24 and on boxs.ca.

**Architecture:**
- **Core:** `PUT /core/api/calendar-access/:id/active` and `POST /core/api/calendar-access/:id/link`, behind the existing Calendar access gate. They reuse `updateUser` and `linkUser` with a new in-transaction `guard`, which runs after the user's aggregate lock and `FOR UPDATE`, and refuses a target who holds any flat (NRMS, NoD, Core) role unless the caller is a Core.Admin (Q55), and otherwise applies `checkCalendarGrant` with the role unchanged.
- **Calendar:** `GET /api/users` (user × ministry rows from the projections), `GET /api/users/:id`, `PUT /api/users/:id/profile`, `PUT /api/users/:id/comm-contacts/:ministryKey`, all at Administrator and above, each write under a per-user advisory lock.
- **staff-web:** `/hub/calendar/users` and `/hub/calendar/users/:id`. The user page reuses 5a's `AccessEditor` (moved to its own file) for the role and ministries, and calls Core directly for those and for active and link, as 5a's Calendar access screen does.
- **Test users:** `TEST_USERS` gains five Calendar users with ministries; `seedTestUsers` gives them access when the organizations exist and reports a skip otherwise.
- **Spike:** a throwaway branch `spike/5b-report-rendering` with a self-contained `spikes/report-rendering/` package (never a workspace, never merged). It renders three samples and a full 60-day Look Ahead from a synthetic 1,106-activity fixture with Chromium (PDF), a pure-JS fallback (PDF) and an HTML→DOCX converter (Word), measures time, memory, size and pages, and checks fidelity automatically. On boxs.ca it runs over SSH and, through a temporary Core.Admin-gated route, inside the app runtime. Only the report is committed to `feat/phase-5b`.

**Tech Stack:** Node 24, TypeScript 5.9 strict, Express 5, Drizzle 0.45, zod 3.25, Vitest 4.1, supertest, React 19 + react-router 7, `@bcgov/design-system-react-components`, axe-core, Playwright. Spike only: `puppeteer-core` 25.13.0 (Apache-2.0), `@sparticuz/chromium` 153.0.0 (MIT), `@turbodocx/html-to-docx` 1.23.1 (MIT), `pdfmake` 0.2.23 (MIT), `html-to-pdfmake` 2.5.35 (MIT), `jsdom` 30.1.2 (MIT, already in the repo), `pdf-lib` 1.17.1 (MIT, already in the repo), `jszip` (MIT, a dependency of the DOCX converter). Versions and licences read from the npm registry on 2026-10-08.

**Spec:** `docs/superpowers/specs/2026-10-07-calendar-parity-design.md`:
- §3 row 5b (the exit check's second half: "A spike report recorded in the plan folder, covering both formats, both page sizes, and both hosts");
- §4 (users without email, Link), §5.2 (`comm_contacts`, `user_profiles`), §8.5 (Users and Transfer);
- §10.1 (the rendering spike), §10.2–§10.5 (the layouts the samples imitate), §13 (live window 1,106 activities, 37 confidential; a 60-day Look Ahead covers about 700–800);
- §15 Q48 (Word: similar layout is enough), Q55 (answered: Core admin only for anyone holding a non-Calendar role).

Also `docs/parity/legacy-report-layouts.md` (colours pixel-verified, column sets, running text), `docs/superpowers/plans/phase-5-carry-forward.md` § 5b (as left by 5b-1: "Calendar users screen (§8.5)", "Calendar test users"), and the 5b-1 plan `docs/superpowers/plans/2026-10-08-phase-5b-calendar-skeleton.md`, whose app, projections, actor and Calendar section this plan builds on.

**Order:** 5b-1 first. Then Tasks 1–4 and 6 of this plan in order. Task 5 (the spike) needs nothing from either plan's code and may run in parallel with Tasks 1–4; it needs boxs.ca to be running 5b-1 so the spike's temporary deploy can be replaced by the real artifact afterwards.

**Base:**
- **Branch:** `feat/phase-5b` in `/Users/paul/gcpe-news-platform-p5b`, after 5b-1's last commit. Every path is repo-relative.
- **What exists after 5b-1:** `apps/calendar` with `users`, `orgs`, `comm_contacts`, `user_profiles` tables; `requireCalendarActor`, `requireLevel`, `req.calendar`; `apps/calendar/test/helpers.ts` (`createCalendarTestDb`, `createTestApp`, `projectUser`, `projectOrg`, `sessionCookie`); the staff-web Calendar section (`CalendarSection`, `useCalendarContext`, `CALENDAR_ADMIN_LEVEL`).
- **Core today** (`e4dbf50`): `updateUser(db, id, patch, subscribers)` and `linkUser(db, id, address, subscribers)` lock the user (`lockUser`), read the row `FOR UPDATE`, then write and emit `user.upserted` (`apps/core/src/services/users.ts:184-228`). `/core/api/users` is Core.Admin only. `/core/api/calendar-access` is open to Core.Admin, Calendar.Administrator and Calendar.SysAdmin (`apps/core/src/http/routes.ts:197`).

---

## Decisions made in planning

Each says why and the cost if wrong. Task 6 writes the parity rows they create.

- **E1. The Calendar users screen lives in the Calendar section** (`/hub/calendar/users`), reusing 5a's `AccessEditor` for role and ministries. Hub → Calendar access stays as it is (Core admins use it; 5a's e2e lands Calendar Administrators there). *If wrong:* two places edit the same grant; both call the same Core route, so they can't disagree.
- **E2. Active and Link for Calendar Administrators are two new Core routes under `/core/api/calendar-access/:id/`** (carry-forward). The rule, checked under the user's aggregate lock: a Core.Admin may always; anyone else only on a user with no flat role (Q55, answered), and only where `checkCalendarGrant` would let them change that user's access with the role unchanged (so not themself, not a System Administrator unless they are one, not an HQ user unless they are HQ). Deactivating yourself is refused for everyone, as on Hub → Users. *If wrong:* a Calendar Administrator has to ask a Core admin; nothing is weakened.
- **E3. Contact details and comm-contact ranks are editable by any Calendar Administrator or System Administrator, on any projected user, including themself.** They are Calendar data, not access (spec §4 "Calendar contact details … belong to Calendar"), and legacy let any admin-page user edit them. *If wrong:* an Administrator can change a System Administrator's phone number; low stakes, and every write is by a server-checked Administrator.
- **E4. A rank is set only for one of the user's ministries as the Calendar's projection shows them;** otherwise 409 with what to do ("save their ministries first; the Calendar picks them up within a minute"). "Not a comm contact" deactivates the `comm_contacts` row rather than deleting it, so activities that name it keep their contact. *If wrong:* one extra step after adding a ministry.
- **E5. The user list shows each ministry's own rank.** Legacy showed one rank per user, from the first active comm contact it found, whatever the ministry (`UserList.aspx.cs:27-34`). New row C165. *If wrong:* a cosmetic difference in the list.
- **E6. The list's default is active users with a Calendar role,** as legacy's (`UserList.aspx.cs:19-20` lists active users with active ministries); two switches add inactive users (including no-email ones, spec §8.5) and users without Calendar access (so a Calendar Administrator can find an existing Core user to give access to, C161).
- **E7. Deferred to 5c, as 5b-1 recorded:** Transfer, and the deactivation preview of open activities (both need activities and `visible()`). Deactivating works now without the preview.
- **E8. Calendar test users** (all `@example.test`, fictional names): `cal-admin` (Administrator, Health), `cal-sysadmin` (System Administrator, Health), `cal-hq-admin` (Administrator, GCPE Headquarters), `cal-editor` (Editor, Health), `cal-readonly` (Read Only, Finance). `seedTestUsers` gives Calendar access only when every named organization exists in Core, and reports `calendar: "skipped"` with the missing keys otherwise. e2e's global setup creates the three organizations in Core first. *If wrong:* a seeded user without access; the report says so.
- **E9. Spike isolation.** The spike's code lives only on branch `spike/5b-report-rendering`, in `spikes/report-rendering/` with its own `package.json` (outside `workspaces`, outside `tsconfig.json`'s `include` and Vitest's globs). It is never merged. `feat/phase-5b` gets only the report, which names the spike branch's commit. Outputs come only from the synthetic fixture.
- **E10. Spike candidates are the spec's two** (headless Chromium for PDF, an HTML→DOCX converter for Word), plus one measured fallback per format chosen now so a failure has an alternative ready for Paul (spec §10.1: "the measured alternatives go to Paul"): a browser-free HTML→PDF path (`html-to-pdfmake` + `pdfmake`, both MIT) and a DOCX post-processor that adds `NUMPAGES` and a first-page header with `jszip`. Puppeteer drives Chromium over a pipe (`pipe: true`), never a WebSocket, because SiteGround's runtime forbids loopback networking (`apps/stack/src/stack.ts:258-261`).
- **E11. Spike hosts.** Local: macOS with Node 24 (the developer machine). boxs.ca: (a) the SSH shell with `/usr/local/bin/node-24`, and (b) the Node app runtime itself, which differs from SSH (`docs/deploy/siteground.md` "Troubleshooting": runtime logs aren't reachable over SSH; loopback is blocked). The runtime leg is a temporary deploy of the stack with one Core.Admin-gated route that runs the spike from `~/gcpe-data/spike/`; the real 5b artifact is redeployed right after. If Docker is on the developer's PATH, the local leg also runs in `node:24-bookworm-slim` as an OpenShift-like container (spec §10.1 names that host); if not, the report says it wasn't measured.
- **E12. The spike's samples use synthetic content and a generated placeholder cover image,** never legacy's `LookAheadCover.jpg` or any legacy text. Colours, column sets and running text come from `docs/parity/legacy-report-layouts.md`.

## Global Constraints

- **Worktree and commits:**
  - Work on `feat/phase-5b` in `/Users/paul/gcpe-news-platform-p5b` (the spike on its own branch, E9). Commit locally after each task.
  - **Never add `Co-Authored-By` or any AI attribution** to a commit. Never commit `CLAUDE.md`.
  - **Code comments never carry task, round or ruling labels** ("Task 3", "E2", "fix round 1"). Spec row ids (C165, Q55) are fine.
- **Node 24 for everything** (BC's permanent UTC−7 from 2026-11-01 needs tzdata ≥ 2026b):
  - Tests: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run <paths>`.
  - Type-checks: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json` and `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p apps/staff-web/tsconfig.json`.
  - E2E: `npx -y -p node@24 -- npm run test:e2e`.
  - Show each new test failing before implementing it (a real RED run).
- **Migrations:** drizzle-kit only. This plan adds none.
- **Locks:** aggregate lock (`lockAggregate` / `pg_advisory_xact_lock`), then the row `FOR UPDATE`, then re-check what was read before the lock. Core's guard runs after `updateUser`/`linkUser` have done both.
- **Logs:** `safeErrorLabel(e)` only; no debug logging. Never an email address in a log or an error message.
- **Events:** explicit type lists; `enqueueEvent` validates payloads.
- **Privacy:** no real names or emails anywhere; `example.test` / `x.invalid`; fictional names. **Never copy legacy data**, including report text, images or lookup values; legacy files and PDFs are read for structure only.
- **Server is the authority** (C140). staff-web only hides what the server would refuse.
- **Staff-web patterns:** `apiFetch` with same-origin paths; a danger `InlineAlert` on load failure; a `latest` ref against out-of-order loads; `useDocumentTitle` with the `h1` text; `role="status"` and `role="alert"`; an axe test for each new screen; browser code never imports `@gcpe/auth`.
- **Copy:** legacy's role labels ("Read Only" … "System Administrator"); legacy's rank labels ("Comm Director", "Comm Manager", "Sr. PAO", "PAO", "Jr. PAO", "Other"; plus "Not a comm contact").

## Review Focus

1. **A Calendar Administrator deactivates someone who was given an NRMS role a moment after the page loaded.** The server refuses with "only a Core admin can change a user who also has NRMS or NoD roles", because the check runs under the user's lock, after any concurrent role save has committed. Pinned in Task 1 ("the Q55 check runs under the user's lock: a role granted while the request waits is seen").
2. **Setting a rank for a ministry the admin added in Core seconds ago.** The Calendar's projection hasn't caught up: 409 with an actionable message, never a 500 and never a row for a ministry the user doesn't hold. Pinned in Task 2 ("a rank for a ministry the projection doesn't show is refused with what to do").
3. **A phone number typed as staff usually type them** ("(250) 555-0100", "250 555 0100"). 400 naming legacy's format, shown next to the field; the database CHECK is never what refuses it. Pinned in Task 2 ("a phone number not in legacy's format is refused with the format named") and Task 3 ("shows the server's field message").
4. **Seeding test users on a site whose organizations don't exist yet.** Users are created, their Calendar access is skipped and reported, nothing throws; a re-run after the organizations exist grants it. Pinned in Task 4 ("skips Calendar access when an organization is missing, and grants it on a re-run").
5. **Opening a user page by URL for a user the Calendar hasn't heard of** (a Core user created a moment ago, or a mistyped id). 404 and a "not found" message, not an empty form that would create a profile for nobody. Pinned in Task 2 ("an unknown or malformed user id is 404, and no profile is written") and Task 3.

---

## File structure

| File | Responsibility |
|---|---|
| `apps/core/src/services/users.ts` | `updateUser`/`linkUser` accept an in-transaction `guard` |
| `apps/core/src/services/calendar-access.ts` | `CalendarOnlyError`, `calendarAdminGuard`, `setCalendarUserActive`, `linkCalendarUser` |
| `apps/core/src/http/calendar-access.ts` (+ `calendar-user-account.test.ts`) | `PUT /:id/active`, `POST /:id/link` |
| `apps/calendar/src/users.ts` (+ `users.test.ts`) | List rows, detail, profile and rank writes |
| `apps/calendar/src/http/user-routes.ts` (+ `user-routes.test.ts`), `http/routes.ts` | Routes |
| `apps/staff-web/src/screens/admin/calendar-access/AccessEditor.tsx`, `CalendarAccessScreen.tsx` | `AccessEditor` moved out, unchanged |
| `apps/staff-web/src/screens/calendar/users/types.ts`, `CalendarUsersScreen.tsx`, `CalendarUserScreen.tsx` (+ tests) | The two screens |
| `apps/staff-web/src/screens/calendar/CalendarSection.tsx`, `src/router.tsx`, `screens/calendar/a11y.test.tsx` | Nav, routes, axe |
| `apps/core/src/services/seed-test-users.ts` (+ test), `scripts/siteground-seed-users.sh` (+ `tests/siteground-seed-users.test.ts`), `tests/e2e/constants.ts`, `tests/e2e/global-setup.ts`, `tests/e2e/calendar-users.spec.ts` | Calendar test users and the e2e |
| `spikes/report-rendering/*` (spike branch only) | Fixture, templates, renderers, measurement, checks, runtime route |
| `docs/superpowers/plans/2026-10-08-phase-5b-report-rendering-spike.md` | The spike report |
| `docs/parity/*`, `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`, `docs/superpowers/plans/phase-5-carry-forward.md` | Docs |

---

### Task 1: Core: Calendar Administrators set active and link Calendar-only users (Q55)

Covers spec §8.5 ("Edited through Core's API: … active"; "Link"), §4 (Link), Q55, carry-forward "Calendar users screen" (the Core half), E2.

**Files:**
- Modify: `apps/core/src/services/users.ts`, `apps/core/src/services/calendar-access.ts`, `apps/core/src/http/calendar-access.ts`.
- Create: `apps/core/src/http/calendar-user-account.test.ts`.

**Interfaces:**
- Consumes: `checkCalendarGrant`, `CalendarGrantRefusedError`, `REFUSAL_MESSAGES`, `actorIsHq` (5a, same file), `lockUser`, `getUser`.
- Produces:
  - `type UserGuard = (tx: Tx, id: string) => Promise<void>`; `updateUser(db, id, patch, subscribers, opts?: { guard?: UserGuard })`; `linkUser(db, id, address, subscribers, opts?: { guard?: UserGuard })`.
  - `CalendarOnlyError`; `CALENDAR_ONLY_MESSAGE = "only a Core admin can change a user who also has NRMS or NoD roles"`.
  - `setCalendarUserActive(db: Db, actor: CalendarActor, id: string, isActive: boolean, subscribers: SubscriberConfig[]): Promise<CalendarAccessView>`.
  - `linkCalendarUser(db: Db, actor: CalendarActor, id: string, email: string, subscribers: SubscriberConfig[]): Promise<CalendarAccessView>`.
  - `PUT /core/api/calendar-access/:id/active { isActive }` and `POST /core/api/calendar-access/:id/link { email }` → `CalendarAccessView`; 403 `{ error, reason }` with `reason` a `CalendarGrantRefusal` or `"other-roles"`; 409 for self-deactivation, a no-email activation, an already-linked user, or an email in use; 404 unknown user.

- [ ] **Step 1: Write the failing test**

`apps/core/src/http/calendar-user-account.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { mintSession, type CalendarRole } from "@gcpe/auth";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCoreTestDb, healthOrg } from "../../test/helpers";
import { createApp } from "../app";
import { lockAggregate, userAggregateId } from "../services/aggregate";
import { setCalendarAccess } from "../services/calendar-access";
import { upsertOrganization } from "../services/organizations";
import { createUser, createUserSchema } from "../services/users";
import { roleGrants } from "../db/schema";

const SECRET = "session-secret-for-calendar-user-account-01";
const SETUP = { id: "setup", roles: ["Core.Admin"] };

describe("Calendar Administrators: active and link (Q55)", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  const cookie: Record<string, string> = {};
  const id: Record<string, string> = {};

  async function person(name: string, opts: { flat?: string[]; calendar?: CalendarRole; orgs?: string[]; email?: string | null; active?: boolean } = {}) {
    const email = opts.email === undefined ? `${name}@example.test` : opts.email;
    const u = await createUser(tdb.db, createUserSchema.parse({ email, displayName: `Sample ${name}`, roles: opts.flat ?? [], isActive: opts.active ?? email !== null }), []);
    if (opts.calendar) await setCalendarAccess(tdb.db, SETUP, u.id, { role: opts.calendar, organizationKeys: opts.orgs ?? ["health"] }, []);
    id[name] = u.id;
    cookie[name] = `gcpe_session=${(await mintSession(SECRET, { id: u.id, name, email: email ?? "", roles: [] })).token}`;
  }
  const put = (actor: string, target: string, isActive: boolean) =>
    request(app).put(`/api/calendar-access/${id[target]}/active`).set("cookie", cookie[actor]!).set("x-gcpe-request", "1").send({ isActive });
  const link = (actor: string, target: string, email: string) =>
    request(app).post(`/api/calendar-access/${id[target]}/link`).set("cookie", cookie[actor]!).set("x-gcpe-request", "1").send({ email });

  beforeAll(async () => {
    tdb = await createCoreTestDb();
    app = createApp({ db: tdb.db, subscribers: [], auth: { session: { secret: SECRET } }, session: { secret: SECRET, secure: false, local: null } });
    await upsertOrganization(tdb.db, healthOrg, []);
    await upsertOrganization(tdb.db, { ...healthOrg, key: "gcpe-headquarters", displayName: "GCPE Headquarters", abbreviation: "GCPEHQ", sectorKeys: [], isHq: true }, []);
    await person("coreAdmin", { flat: ["Core.Admin"] });
    await person("sysAdmin", { calendar: "Calendar.SysAdmin" });
    await person("admin", { calendar: "Calendar.Administrator" });
    await person("hqAdmin", { calendar: "Calendar.Administrator", orgs: ["gcpe-headquarters"] });
    await person("editor", { calendar: "Calendar.Editor" });
    await person("editor2", { calendar: "Calendar.Editor" });
    await person("nrmsToo", { flat: ["NRMS.Editor"], calendar: "Calendar.Editor" });
    await person("hqEditor", { calendar: "Calendar.Editor", orgs: ["gcpe-headquarters"] });
    await person("otherSys", { calendar: "Calendar.SysAdmin" });
    await person("imported", { email: null, calendar: "Calendar.Editor" });
    await person("imported2", { email: null, calendar: "Calendar.Editor" });
  });
  afterAll(() => tdb.drop());

  it("an Administrator deactivates and reactivates a Calendar-only user", async () => {
    const off = await put("admin", "editor", false);
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ id: id.editor, isActive: false, calendarRole: "Calendar.Editor" });
    expect((await put("admin", "editor", true)).body.isActive).toBe(true);
  });

  it("only a Core admin changes a user who also holds an NRMS or NoD role", async () => {
    const refused = await put("admin", "nrmsToo", false);
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: "only a Core admin can change a user who also has NRMS or NoD roles", reason: "other-roles" });
    expect((await put("sysAdmin", "nrmsToo", false)).status).toBe(403);
    expect((await put("coreAdmin", "nrmsToo", false)).status).toBe(200);
    await put("coreAdmin", "nrmsToo", true);
  });

  it("follows the grant rules with the role unchanged: no SysAdmin target for an Administrator, no HQ target for a non-HQ Administrator", async () => {
    expect((await put("admin", "otherSys", false)).body.reason).toBe("target-above-ceiling");
    expect((await put("admin", "hqEditor", false)).body.reason).toBe("hq-target");
    expect((await put("hqAdmin", "hqEditor", false)).status).toBe(200);
    expect((await put("sysAdmin", "otherSys", false)).status).toBe(200);
  });

  it("nobody deactivates themself here", async () => {
    expect((await put("admin", "admin", false)).status).toBe(409);
    expect((await put("coreAdmin", "coreAdmin", false)).status).toBe(409);
  });

  it("a no-email user can't be activated, only linked; linking sets the email and activates", async () => {
    expect((await put("admin", "imported", true)).status).toBe(409);
    const linked = await link("admin", "imported", "kim.imported@example.test");
    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject({ email: "kim.imported@example.test", isActive: true });
    expect((await link("admin", "imported", "again@example.test")).status).toBe(409);
    expect((await link("admin", "imported2", "kim.imported@example.test")).status).toBe(409); // email in use
  });

  it("is closed to anyone below Calendar Administrator, and 404s an unknown user", async () => {
    expect((await put("editor2", "editor", false)).status).toBe(403);
    expect((await request(app).put("/api/calendar-access/00000000-0000-4000-8000-000000000000/active").set("cookie", cookie.admin!).set("x-gcpe-request", "1").send({ isActive: false })).status).toBe(404);
  });

  it("the Q55 check runs under the user's lock: a role granted while the request waits is seen", async () => {
    await person("racer", { calendar: "Calendar.Editor" });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    // Another writer holds the user's aggregate lock and grants an NRMS role inside it.
    const granting = tdb.db.transaction(async (tx) => {
      await lockAggregate(tx, userAggregateId(id.racer!));
      await tx.insert(roleGrants).values({ userId: id.racer!, role: "NRMS.Viewer" });
      await held;
    });
    const pending = put("admin", "racer", false).then((r) => r);
    await waitForLockWaiter(tdb);
    release();
    await granting;
    const res = await pending;
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe("other-roles");
  });
});

/** Resolves once some session is blocked on a lock: the request has done its unlocked work and is queued behind the test's transaction. */
async function waitForLockWaiter(tdb: TestDatabase, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await tdb.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
    if (r.rows[0]!.n > 0) return;
    if (Date.now() > deadline) throw new Error("no session started waiting for a lock");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
```

The waiter helper is the same as `apps/nod/test/helpers.ts`'s `waitForLockWaiter`, inlined because Core's test helpers have none.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/core/src/http/calendar-user-account.test.ts`
Expected: FAIL. `/active` and `/link` are 404.

- [ ] **Step 3: The guard hook in `users.ts`**

```ts
/** Runs inside the user's write transaction, after their aggregate lock and FOR UPDATE, so what it
 * reads can't change before the write commits. Throws to refuse. */
export type UserGuard = (tx: Tx, id: string) => Promise<void>;
```

`updateUser(db, id, patch, subscribers, opts: { guard?: UserGuard } = {})`: after `if (!row) throw new UserNotFoundError(id);` add `await opts.guard?.(tx, row.id);`. Same in `linkUser`, after its `if (!row) …` and before the "already has an email" check. Existing callers are unchanged.

- [ ] **Step 4: The service in `calendar-access.ts`**

```ts
export const CALENDAR_ONLY_MESSAGE = "only a Core admin can change a user who also has NRMS or NoD roles";

/** Q55: a Calendar Administrator may change the account of a user whose only access is the Calendar. */
export class CalendarOnlyError extends Error {
  override name = "CalendarOnlyError";
}

async function targetHoldsHq(tx: Tx, userId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: organizations.id })
    .from(userOrganizations)
    .innerJoin(organizations, eq(organizations.id, userOrganizations.organizationId))
    .where(and(eq(userOrganizations.userId, userId), eq(organizations.isHq, true)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Who may deactivate, reactivate or link a user from the Calendar (spec addendum §8.5, Q55): a
 * Core.Admin always; anyone else only on a user with no flat role, and only where they could change
 * that user's Calendar access with the role left as it is (C125, C159, C160).
 */
function calendarAdminGuard(actor: CalendarActor): UserGuard {
  return async (tx, id) => {
    if (actor.roles.includes("Core.Admin")) return;
    const current = (await getUser(tx, id))!;
    if (current.roles.length > 0) throw new CalendarOnlyError();
    const refusal = checkCalendarGrant({
      actorId: actor.id,
      actorRoles: actor.roles,
      actorIsHq: await actorIsHq(tx, actor.id),
      targetId: id,
      targetRole: current.calendarRole,
      nextRole: current.calendarRole,
      addsHqOrganization: false,
      targetHasHqAfter: await targetHoldsHq(tx, id),
    });
    if (refusal) throw new CalendarGrantRefusedError(refusal);
  };
}

export async function setCalendarUserActive(db: Db, actor: CalendarActor, id: string, isActive: boolean, subscribers: SubscriberConfig[]): Promise<CalendarAccessView> {
  return toView(await updateUser(db, id, { isActive }, subscribers, { guard: calendarAdminGuard(actor) }));
}

export async function linkCalendarUser(db: Db, actor: CalendarActor, id: string, email: string, subscribers: SubscriberConfig[]): Promise<CalendarAccessView> {
  return toView(await linkUser(db, id, email, subscribers, { guard: calendarAdminGuard(actor) }));
}
```

Import `updateUser`, `linkUser`, `type UserGuard` from `./users`.

- [ ] **Step 5: The routes**

In `apps/core/src/http/calendar-access.ts`, extend `run`'s catch:

```ts
    if (e instanceof CalendarOnlyError) return void res.status(403).json({ error: CALENDAR_ONLY_MESSAGE, reason: "other-roles" });
    if (e instanceof SelfDeactivationError) return void res.status(409).json({ error: "you can't deactivate yourself" });
    if (e instanceof UserNeedsEmailError) return void res.status(409).json({ error: "set an email before activating this user" });
    if (e instanceof UserAlreadyHasEmailError) return void res.status(409).json({ error: "this user already has an email" });
    if (e instanceof UserExistsError) return void res.status(409).json({ error: "a user with that email already exists" });
```

and add, inside `calendarAccessRouter`:

```ts
class SelfDeactivationError extends Error {}
const activeSchema = z.object({ isActive: z.boolean() }).strict();
const canonical = (s: string) => s.trim().toLowerCase();

  r.put(
    "/:id/active",
    run<IdParams>(async (req, res) => {
      const { isActive } = activeSchema.parse(req.body);
      if (!isActive && canonical(req.params.id) === canonical(req.auth!.subject)) throw new SelfDeactivationError();
      res.json(await setCalendarUserActive(db, { id: req.auth!.subject, roles: req.auth!.roles }, req.params.id, isActive, subscribers));
    }),
  );
  r.post(
    "/:id/link",
    run<IdParams>(async (req, res) => {
      const { email } = linkUserSchema.parse(req.body);
      res.json(await linkCalendarUser(db, { id: req.auth!.subject, roles: req.auth!.roles }, req.params.id, email, subscribers));
    }),
  );
```

Declare `SelfDeactivationError`, `activeSchema` and `canonical` at module level. Import `z` from `zod`, the errors and `linkUserSchema` from `../services/users`, and the new service functions.

- [ ] **Step 6: Run the tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/core` and the root `tsc`.
Expected: PASS and clean, including 5a's `calendar-access.test.ts` and `no-email-users.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add apps/core
git commit -m "feat(core): Calendar Administrators deactivate, reactivate and link Calendar-only users (Q55)"
```

---

### Task 2: Calendar users API: list, detail, contact details and ranks

Covers spec §8.5 (user list, "Edited here", "Per ministry: the comm-contact rank"), §5.2 (`comm_contacts`, `user_profiles`), E3–E6.

**Files:**
- Create: `apps/calendar/src/users.ts` (+ `users.test.ts`).
- Create: `apps/calendar/src/http/user-routes.ts` (+ `user-routes.test.ts`).
- Modify: `apps/calendar/src/http/routes.ts`.

**Interfaces:**
- Consumes: `users`, `orgs`, `commContacts`, `userProfiles` (5b-1); `requireLevel` (5b-1).
- Produces:
  - `interface CalendarUserRow { userId: string; displayName: string; email: string | null; isActive: boolean; role: CalendarRole | null; ministryKey: string | null; ministryAbbreviation: string | null; rank: number | null }`.
  - `interface CalendarUserDetail { user: { id; displayName; email; isActive; role; ministryKeys: string[] }; profile: Profile; commContacts: { ministryKey: string; rank: number | null; isActive: boolean }[] }`; `interface Profile { phone: string | null; mobile: string | null; jobTitle: string | null; description: string | null }`.
  - `listCalendarUsers(db, opts: { inactive: boolean; noAccess: boolean })`, `getCalendarUser(db, id)`, `profileSchema`, `saveProfile(db, id, input)`, `rankSchema`, `setCommContactRank(db, id, ministryKey, rank)`.
  - Errors `CalendarUserNotFoundError`, `NotUsersMinistryError`.
  - HTTP (Administrator and above): `GET /api/users?inactive=1&noAccess=1`, `GET /api/users/:id`, `PUT /api/users/:id/profile`, `PUT /api/users/:id/comm-contacts/:ministryKey { rank: 1..6 | null }`.

- [ ] **Step 1: Write the failing tests**

`apps/calendar/src/users.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCalendarTestDb, createTestApp, projectOrg, projectUser } from "../test/helpers";
import { userProfiles } from "./db/schema";
import { CalendarUserNotFoundError, getCalendarUser, listCalendarUsers, NotUsersMinistryError, profileSchema, saveProfile, setCommContactRank } from "./users";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("Calendar users", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    const app = createTestApp(tdb.db);
    await projectOrg(app, "health", { abbreviation: "HLTH" });
    await projectOrg(app, "finance", { abbreviation: "FIN" });
    await projectUser(app, { id: id(1), email: "robin.staff@example.test", displayName: "Robin Staff", isActive: true, calendarRole: "Calendar.Editor", organizationKeys: ["health", "finance"] });
    await projectUser(app, { id: id(2), email: null, displayName: "Kim Imported", isActive: false, calendarRole: "Calendar.Editor", organizationKeys: ["health"] });
    await projectUser(app, { id: id(3), email: "sam.noaccess@example.test", displayName: "Sam Noaccess", isActive: true, calendarRole: null, organizationKeys: [] });
  });
  afterAll(() => tdb.drop());

  it("lists active users with a Calendar role, one row per ministry, with that ministry's rank (C165)", async () => {
    await setCommContactRank(tdb.db, id(1), "health", 1);
    const rows = await listCalendarUsers(tdb.db, { inactive: false, noAccess: false });
    expect(rows.map((r) => [r.displayName, r.ministryAbbreviation, r.rank])).toEqual([
      ["Robin Staff", "FIN", null],
      ["Robin Staff", "HLTH", 1],
    ]);
  });

  it("adds inactive users and users without Calendar access when asked", async () => {
    const names = (await listCalendarUsers(tdb.db, { inactive: true, noAccess: true })).map((r) => r.displayName);
    expect(names).toContain("Kim Imported");
    expect(names).toContain("Sam Noaccess");
  });

  it("detail has the profile and comm contacts; a missing profile reads as empty", async () => {
    const d = await getCalendarUser(tdb.db, id(1));
    expect(d.user).toMatchObject({ displayName: "Robin Staff", ministryKeys: ["finance", "health"], role: "Calendar.Editor" });
    expect(d.profile).toEqual({ phone: null, mobile: null, jobTitle: null, description: null });
    expect(d.commContacts).toEqual([{ ministryKey: "health", rank: 1, isActive: true }]);
  });

  it("saves contact details; blank becomes empty", async () => {
    await saveProfile(tdb.db, id(1), profileSchema.parse({ phone: "250-555-0100", mobile: "", jobTitle: "Sample title", description: "" }));
    expect((await getCalendarUser(tdb.db, id(1))).profile).toEqual({ phone: "250-555-0100", mobile: null, jobTitle: "Sample title", description: null });
  });

  it("a phone number not in legacy's format is refused with the format named", () => {
    for (const phone of ["(250) 555-0100", "250 555 0100", "2505550100"]) {
      const r = profileSchema.safeParse({ phone, mobile: null, jobTitle: null, description: null });
      expect(r.success).toBe(false);
      expect(r.error!.issues[0]!.message).toBe("use 12 digits and hyphens, like 250-555-0100");
    }
  });

  it("'not a comm contact' deactivates the row and keeps it", async () => {
    await setCommContactRank(tdb.db, id(1), "health", null);
    expect((await getCalendarUser(tdb.db, id(1))).commContacts).toEqual([{ ministryKey: "health", rank: 1, isActive: false }]);
    await setCommContactRank(tdb.db, id(1), "health", 4);
    expect((await getCalendarUser(tdb.db, id(1))).commContacts).toEqual([{ ministryKey: "health", rank: 4, isActive: true }]);
  });

  it("a rank for a ministry the projection doesn't show is refused with what to do", async () => {
    await expect(setCommContactRank(tdb.db, id(1), "education", 2)).rejects.toBeInstanceOf(NotUsersMinistryError);
  });

  it("an unknown or malformed user id is 404, and no profile is written", async () => {
    await expect(getCalendarUser(tdb.db, id(99))).rejects.toBeInstanceOf(CalendarUserNotFoundError);
    await expect(getCalendarUser(tdb.db, "not-a-uuid")).rejects.toBeInstanceOf(CalendarUserNotFoundError);
    await expect(saveProfile(tdb.db, id(99), profileSchema.parse({ phone: null, mobile: null, jobTitle: null, description: null }))).rejects.toBeInstanceOf(CalendarUserNotFoundError);
    expect(await tdb.db.select().from(userProfiles).where(eq(userProfiles.userId, id(99)))).toEqual([]);
  });
});
```

`apps/calendar/src/http/user-routes.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCalendarTestDb, createTestApp, projectOrg, projectUser, sessionCookie } from "../../test/helpers";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("Calendar user routes", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createTestApp>;
  let admin: string;
  let advanced: string;
  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    await projectOrg(app, "health", { abbreviation: "HLTH" });
    await projectUser(app, { id: id(1), email: "a@example.test", displayName: "Sample Admin", isActive: true, calendarRole: "Calendar.Administrator", organizationKeys: ["health"] });
    await projectUser(app, { id: id(2), email: "b@example.test", displayName: "Sample Advanced", isActive: true, calendarRole: "Calendar.Advanced", organizationKeys: ["health"] });
    admin = await sessionCookie(id(1));
    advanced = await sessionCookie(id(2));
  });
  afterAll(() => tdb.drop());

  const put = (cookie: string, path: string, body: object) => request(app).put(path).set("cookie", cookie).set("x-gcpe-request", "1").send(body);

  it("is Administrator and above only (C140)", async () => {
    expect((await request(app).get("/api/users").set("cookie", advanced)).status).toBe(403);
    expect((await put(advanced, `/api/users/${id(1)}/profile`, { phone: null, mobile: null, jobTitle: null, description: null })).status).toBe(403);
  });

  it("lists, reads, and writes profile and rank", async () => {
    expect((await request(app).get("/api/users").set("cookie", admin)).body).toHaveLength(2);
    expect((await request(app).get("/api/users?inactive=1&noAccess=1").set("cookie", admin)).status).toBe(200);
    expect((await put(admin, `/api/users/${id(2)}/profile`, { phone: "250-555-0101", mobile: null, jobTitle: "Sample", description: null })).status).toBe(200);
    const rank = await put(admin, `/api/users/${id(2)}/comm-contacts/health`, { rank: 3 });
    expect(rank.status).toBe(200);
    expect(rank.body).toEqual([{ ministryKey: "health", rank: 3, isActive: true }]);
    expect((await request(app).get(`/api/users/${id(2)}`).set("cookie", admin)).body.profile.phone).toBe("250-555-0101");
  });

  it("answers 400 with legacy's phone format, 409 for a ministry the user doesn't hold, 404 for an unknown user", async () => {
    const bad = await put(admin, `/api/users/${id(2)}/profile`, { phone: "(250) 555-0101", mobile: null, jobTitle: null, description: null });
    expect(bad.status).toBe(400);
    expect(bad.body.issues[0].message).toBe("use 12 digits and hyphens, like 250-555-0100");
    const notHeld = await put(admin, `/api/users/${id(2)}/comm-contacts/finance`, { rank: 2 });
    expect(notHeld.status).toBe(409);
    expect(notHeld.body.error).toBe("finance isn't one of this user's ministries in the Calendar yet: save their ministries first; the Calendar picks them up within a minute");
    expect((await request(app).get(`/api/users/${id(99)}`).set("cookie", admin)).status).toBe(404);
    expect((await put(admin, `/api/users/${id(2)}/comm-contacts/health`, { rank: 7 })).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/users.test.ts apps/calendar/src/http/user-routes.test.ts`
Expected: FAIL. `./users` can't be resolved; `/api/users` 404s.

- [ ] **Step 3: The service**

`apps/calendar/src/users.ts`:

```ts
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbOrTx, Tx } from "@gcpe/db-kit";
import type { CalendarRole } from "@gcpe/auth";
import { commContacts, userProfiles, users } from "./db/schema";

export class CalendarUserNotFoundError extends Error {
  override name = "CalendarUserNotFoundError";
}
export class NotUsersMinistryError extends Error {
  override name = "NotUsersMinistryError";
  constructor(readonly ministryKey: string) {
    super("not one of the user's ministries");
  }
}

export interface CalendarUserRow {
  userId: string;
  displayName: string;
  email: string | null;
  isActive: boolean;
  role: CalendarRole | null;
  ministryKey: string | null;
  ministryAbbreviation: string | null;
  rank: number | null;
}

export interface Profile {
  phone: string | null;
  mobile: string | null;
  jobTitle: string | null;
  description: string | null;
}

export interface CalendarUserDetail {
  user: { id: string; displayName: string; email: string | null; isActive: boolean; role: CalendarRole | null; ministryKeys: string[] };
  profile: Profile;
  commContacts: { ministryKey: string; rank: number | null; isActive: boolean }[];
}

const isUuid = (s: string) => z.string().uuid().safeParse(s).success;
const blankToNull = (v: string | null | undefined) => (v ? v : null);
// Legacy's CHECK on SystemUser phone numbers.
const phone = z.string().trim().regex(/^[0-9-]{12}$/, "use 12 digits and hyphens, like 250-555-0100").or(z.literal("")).nullable().transform(blankToNull);

export const profileSchema = z
  .object({
    phone,
    mobile: phone,
    jobTitle: z.string().trim().max(100, "job title: at most 100 characters").nullable().transform(blankToNull),
    description: z.string().trim().max(2000, "description: at most 2000 characters").nullable().transform(blankToNull),
  })
  .strict();

/** Rank 1 Comm Director … 6 Other (Admin/User.aspx.cs:16-25); null is "not a comm contact". */
export const rankSchema = z.object({ rank: z.number().int().min(1).max(6).nullable() }).strict();

/**
 * Legacy's user list (Admin/UserList.aspx.cs:15-39): one row per user and ministry, ordered by
 * ministry abbreviation then name, each with that ministry's comm-contact rank (C165). A user
 * with no ministries gets one row without a ministry.
 */
export async function listCalendarUsers(db: DbOrTx, opts: { inactive: boolean; noAccess: boolean }): Promise<CalendarUserRow[]> {
  const r = await db.execute<CalendarUserRow>(sql`
    SELECT u.id AS "userId", u.display_name AS "displayName", u.email, u.is_active AS "isActive", u.calendar_role AS "role",
           m.key AS "ministryKey", o.abbreviation AS "ministryAbbreviation",
           CASE WHEN c.is_active THEN c.rank END AS "rank"
    FROM users u
    LEFT JOIN LATERAL unnest(u.organization_keys) AS m(key) ON true
    LEFT JOIN orgs o ON o.key = m.key
    LEFT JOIN comm_contacts c ON c.user_id = u.id AND c.ministry_key = m.key
    WHERE (${opts.inactive} OR u.is_active) AND (${opts.noAccess} OR u.calendar_role IS NOT NULL)
    ORDER BY coalesce(o.abbreviation, m.key, '~'), lower(u.display_name), u.id`);
  return r.rows;
}

async function projectedUser(db: DbOrTx, id: string) {
  if (!isUuid(id)) throw new CalendarUserNotFoundError();
  const [u] = await db.select().from(users).where(eq(users.id, id));
  if (!u) throw new CalendarUserNotFoundError();
  return u;
}

export async function getCalendarUser(db: DbOrTx, id: string): Promise<CalendarUserDetail> {
  const u = await projectedUser(db, id);
  const [p] = await db.select().from(userProfiles).where(eq(userProfiles.userId, u.id));
  const contacts = await db.select().from(commContacts).where(eq(commContacts.userId, u.id)).orderBy(commContacts.ministryKey);
  return {
    user: { id: u.id, displayName: u.displayName, email: u.email, isActive: u.isActive, role: u.calendarRole, ministryKeys: u.organizationKeys },
    profile: { phone: p?.phone ?? null, mobile: p?.mobile ?? null, jobTitle: p?.jobTitle ?? null, description: p?.description ?? null },
    commContacts: contacts.map((c) => ({ ministryKey: c.ministryKey, rank: c.rank, isActive: c.isActive })),
  };
}

/** Every write to one user's Calendar data takes this first, then reads what it relies on. */
async function lockUserData(tx: Tx, id: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`calendar-user:${id}`}))`);
}

export async function saveProfile(db: Db, id: string, input: Profile): Promise<Profile> {
  return db.transaction(async (tx) => {
    if (!isUuid(id)) throw new CalendarUserNotFoundError();
    await lockUserData(tx, id);
    const u = await projectedUser(tx, id);
    await tx.select().from(userProfiles).where(eq(userProfiles.userId, u.id)).for("update");
    const values = { ...input, updatedAt: new Date() };
    await tx.insert(userProfiles).values({ userId: u.id, ...values }).onConflictDoUpdate({ target: userProfiles.userId, set: values });
    return input;
  });
}

export async function setCommContactRank(db: Db, id: string, ministryKey: string, rank: number | null): Promise<CalendarUserDetail["commContacts"]> {
  return db.transaction(async (tx) => {
    if (!isUuid(id)) throw new CalendarUserNotFoundError();
    await lockUserData(tx, id);
    const u = await projectedUser(tx, id);
    const key = ministryKey.toLowerCase();
    if (!u.organizationKeys.includes(key)) throw new NotUsersMinistryError(key);
    const [existing] = await tx.select().from(commContacts).where(and(eq(commContacts.userId, u.id), eq(commContacts.ministryKey, key))).for("update");
    if (existing) {
      await tx
        .update(commContacts)
        .set(rank === null ? { isActive: false } : { rank, isActive: true })
        .where(eq(commContacts.id, existing.id));
    } else if (rank !== null) {
      await tx.insert(commContacts).values({ userId: u.id, ministryKey: key, rank, isActive: true });
    }
    return (await getCalendarUser(tx, u.id)).commContacts;
  });
}
```

- [ ] **Step 4: The routes**

`apps/calendar/src/http/user-routes.ts`:

```ts
import { Router, type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import type { Db } from "@gcpe/db-kit";
import { requireLevel } from "../actor";
import { CalendarUserNotFoundError, getCalendarUser, listCalendarUsers, NotUsersMinistryError, profileSchema, rankSchema, saveProfile, setCommContactRank } from "../users";

type Params = { id: string; ministryKey?: string };
const run = (h: (req: Request<Params>, res: Response) => Promise<void>) => (req: Request<Params>, res: Response, next: NextFunction) =>
  h(req, res).catch((e: unknown) => {
    if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues });
    if (e instanceof CalendarUserNotFoundError) return void res.status(404).json({ error: "not found" });
    if (e instanceof NotUsersMinistryError) {
      return void res.status(409).json({ error: `${e.ministryKey} isn't one of this user's ministries in the Calendar yet: save their ministries first; the Calendar picks them up within a minute` });
    }
    next(e);
  });

/** Calendar users (spec addendum §8.5): Administrator and above. Role, ministries, active and link are Core's. */
export function userRoutes(db: Db): Router {
  const r = Router();
  r.use("/users", requireLevel("Calendar.Administrator"));
  r.get("/users", run(async (req, res) => {
    res.json(await listCalendarUsers(db, { inactive: req.query.inactive === "1", noAccess: req.query.noAccess === "1" }));
  }));
  r.get("/users/:id", run(async (req, res) => void res.json(await getCalendarUser(db, req.params.id))));
  r.put("/users/:id/profile", run(async (req, res) => void res.json(await saveProfile(db, req.params.id, profileSchema.parse(req.body)))));
  r.put("/users/:id/comm-contacts/:ministryKey", run(async (req, res) => {
    const { rank } = rankSchema.parse(req.body);
    res.json(await setCommContactRank(db, req.params.id, req.params.ministryKey!, rank));
  }));
  return r;
}
```

In `apps/calendar/src/http/routes.ts`: `import { userRoutes } from "./user-routes";` and `r.use(userRoutes(db));` after the lookups.

- [ ] **Step 5: Run the tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar` and the root `tsc`.
Expected: PASS and clean.

- [ ] **Step 6: Commit**

```bash
git add apps/calendar
git commit -m "feat(calendar): Calendar users API: legacy's user list, contact details and comm-contact ranks"
```

---

### Task 3: staff-web: the Calendar users screens

Covers spec §8.5 (user list, user page, Link), §16 (axe), E1, E5, E6.

**Files:**
- Create: `apps/staff-web/src/screens/admin/calendar-access/AccessEditor.tsx` (moved from `CalendarAccessScreen.tsx`).
- Modify: `apps/staff-web/src/screens/admin/calendar-access/CalendarAccessScreen.tsx`.
- Create: `apps/staff-web/src/screens/calendar/users/types.ts`, `CalendarUsersScreen.tsx`, `CalendarUserScreen.tsx`, `CalendarUsersScreen.test.tsx`, `CalendarUserScreen.test.tsx`.
- Modify: `apps/staff-web/src/screens/calendar/CalendarSection.tsx`, `apps/staff-web/src/router.tsx`, `apps/staff-web/src/screens/calendar/a11y.test.tsx`.

**Interfaces:**
- Consumes: Task 1's Core routes; Task 2's Calendar routes; `GET /core/api/calendar-access`, `GET /core/api/organizations`; 5a's `checkCalendarGrant`, `grantableCalendarRoles`, `canonicalId` (staff-web mirror).
- Produces:
  - `AccessEditor` (same props as today), `type Actor`, `orgLabel(o: OrgOption): string`, `actorFor(session, users, orgs): Actor`, all exported from `AccessEditor.tsx`.
  - `RANK_OPTIONS`, `CalendarUserRow`, `CalendarUserDetail` (staff-web mirrors of Task 2's types).
  - Routes `/hub/calendar/users`, `/hub/calendar/users/:id`.

- [ ] **Step 1: Move `AccessEditor` without changing it**

Create `AccessEditor.tsx` holding, unchanged, `orgLabel`, `LOCKED_MESSAGES`, `saveMessages`, the `Actor` interface (now exported) and the `AccessEditor` component (now exported), with the imports they need. Add:

```tsx
/** What checkCalendarGrant needs about the signed-in actor: their session roles, and HQ from their own row in Core's list (break-glass has none, so is never HQ). */
export function actorFor(session: { user: { id: string } | null; roles: readonly string[] }, users: readonly CalendarAccessUser[], orgs: readonly OrgOption[]): Actor {
  const hqKeys = new Set(orgs.filter((o) => o.isHq).map((o) => o.key));
  const own = users.find((u) => canonicalId(u.id) === canonicalId(session.user?.id ?? ""));
  return { id: session.user?.id ?? "", roles: session.roles, isHq: !!own?.organizationKeys.some((k) => hqKeys.has(k)) };
}
```

`CalendarAccessScreen.tsx` imports `AccessEditor`, `LOCKED_MESSAGES`, `actorFor`, `type Actor` from `./AccessEditor` and uses `actorFor(session, users ?? [], orgs)` in place of its inline actor computation. Keep `CalendarAccessUser` and `OrgOption` exported from `CalendarAccessScreen.tsx` (other files import them from there).

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/admin`
Expected: PASS unchanged (a pure move).

- [ ] **Step 2: Write the failing screen tests**

`apps/staff-web/src/screens/calendar/users/CalendarUsersScreen.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { CalendarUsersScreen } from "./CalendarUsersScreen";

const ROWS = [
  { userId: "u1", displayName: "Robin Staff", email: "robin.staff@example.test", isActive: true, role: "Calendar.Editor", ministryKey: "finance", ministryAbbreviation: "FIN", rank: null },
  { userId: "u1", displayName: "Robin Staff", email: "robin.staff@example.test", isActive: true, role: "Calendar.Editor", ministryKey: "health", ministryAbbreviation: "HLTH", rank: 4 },
];

function stub(calls: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "a1", name: "Pat", email: "pat@x.invalid", roles: ["Calendar.Administrator"] }, expiresAt: new Date().toISOString() });
      if (url.startsWith("/calendar/api/users")) return jsonResponse(200, url.includes("inactive=1") ? [...ROWS, { ...ROWS[1], userId: "u2", displayName: "Kim Imported", email: null, isActive: false, rank: null }] : ROWS);
      throw new Error(`unhandled: ${url}`);
    }),
  );
}

const renderScreen = () =>
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/calendar/users"]}>
        <RequireAuth>
          <Routes>
            <Route path="/calendar/users" element={<CalendarUsersScreen />} />
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );

describe("CalendarUsersScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("lists user × ministry rows as legacy did, with each ministry's rank", async () => {
    stub([]);
    renderScreen();
    await waitFor(() => expect(document.title).toBe("Calendar users — GCPE News Staff"));
    expect(await screen.findByRole("link", { name: "Robin Staff (HLTH) (4)" })).toHaveAttribute("href", "/calendar/users/u1");
    expect(screen.getByRole("link", { name: "Robin Staff (FIN)" })).toBeInTheDocument();
  });

  it("asks for inactive users, including those with no email, when the switch is on", async () => {
    const calls: string[] = [];
    stub(calls);
    renderScreen();
    await screen.findByRole("link", { name: "Robin Staff (HLTH) (4)" });
    await userEvent.setup().click(screen.getByLabelText("Show inactive users, including those with no email"));
    expect(await screen.findByRole("link", { name: "Kim Imported (HLTH) — inactive" })).toBeInTheDocument();
    expect(calls).toContain("/calendar/api/users?inactive=1");
  });
});
```

`apps/staff-web/src/screens/calendar/users/CalendarUserScreen.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { CalendarUserScreen } from "./CalendarUserScreen";

const DETAIL = {
  user: { id: "u1", displayName: "Robin Staff", email: "robin.staff@example.test", isActive: true, role: "Calendar.Editor", ministryKeys: ["health"] },
  profile: { phone: "250-555-0100", mobile: null, jobTitle: null, description: null },
  commContacts: [{ ministryKey: "health", rank: 4, isActive: true }],
};
const CORE_USERS = [
  { id: "a1", email: "pat@x.invalid", displayName: "Pat", isActive: true, calendarRole: "Calendar.Administrator", organizationKeys: ["health"] },
  { id: "u1", email: "robin.staff@example.test", displayName: "Robin Staff", isActive: true, calendarRole: "Calendar.Editor", organizationKeys: ["health"] },
  { id: "u2", email: null, displayName: "Kim Imported", isActive: false, calendarRole: "Calendar.Editor", organizationKeys: ["health"] },
];
const ORGS = [{ key: "health", displayName: "Health", abbreviation: "HLTH", isActive: true, isHq: false, isPublic: true }];

function stub(calls: { url: string; init?: RequestInit }[], detail = DETAIL, override?: (url: string, init?: RequestInit) => Response | undefined) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const o = override?.(url, init);
      if (o) return o;
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "a1", name: "Pat", email: "pat@x.invalid", roles: ["Calendar.Administrator"] }, expiresAt: new Date().toISOString() });
      if (url === `/calendar/api/users/${detail.user.id}` && !init?.method) return jsonResponse(200, detail);
      if (url === "/core/api/calendar-access") return jsonResponse(200, CORE_USERS);
      if (url === "/core/api/organizations") return jsonResponse(200, ORGS);
      if (url.endsWith("/profile")) return jsonResponse(200, JSON.parse(init!.body as string));
      if (url.includes("/comm-contacts/")) return jsonResponse(200, [{ ministryKey: "health", rank: JSON.parse(init!.body as string).rank, isActive: true }]);
      if (url.endsWith("/active")) return jsonResponse(200, { ...CORE_USERS[1], isActive: JSON.parse(init!.body as string).isActive });
      if (url.endsWith("/link")) return jsonResponse(200, { ...CORE_USERS[2], email: "kim.imported@example.test", isActive: true });
      if (url.startsWith("/calendar/api/users/")) return jsonResponse(404, { error: "not found" });
      throw new Error(`unhandled: ${url}`);
    }),
  );
}

const renderAt = (id: string) =>
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={[`/calendar/users/${id}`]}>
        <RequireAuth>
          <Routes>
            <Route path="/calendar/users/:id" element={<CalendarUserScreen />} />
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );

describe("CalendarUserScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("shows the user and saves contact details", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(calls);
    renderAt("u1");
    await waitFor(() => expect(document.title).toBe("Robin Staff — GCPE News Staff"));
    const form = await screen.findByRole("form", { name: "Contact details" });
    const job = within(form).getByLabelText("Job title");
    const user = userEvent.setup();
    await user.type(job, "Sample title");
    await user.click(within(form).getByRole("button", { name: "Save contact details" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/calendar/api/users/u1/profile")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/profile"))!.init!.body as string)).toEqual({ phone: "250-555-0100", mobile: "", jobTitle: "Sample title", description: "" });
    expect(await screen.findByRole("status")).toHaveTextContent("Saved contact details.");
  });

  it("shows the server's field message", async () => {
    stub([], DETAIL, (url, init) =>
      url.endsWith("/profile") && init?.method === "PUT" ? jsonResponse(400, { error: "invalid request", issues: [{ message: "use 12 digits and hyphens, like 250-555-0100", path: ["phone"] }] }) : undefined,
    );
    renderAt("u1");
    const form = await screen.findByRole("form", { name: "Contact details" });
    await userEvent.setup().click(within(form).getByRole("button", { name: "Save contact details" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("use 12 digits and hyphens, like 250-555-0100");
  });

  it("sets a comm-contact rank per ministry", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(calls);
    renderAt("u1");
    const rank = await screen.findByLabelText("Comm contact rank for Health (HLTH)");
    expect(rank).toHaveValue("4");
    await userEvent.setup().selectOptions(rank, "1");
    await waitFor(() => expect(calls.some((c) => c.url === "/calendar/api/users/u1/comm-contacts/health")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.url.includes("/comm-contacts/"))!.init!.body as string)).toEqual({ rank: 1 });
  });

  it("deactivates through Core's Calendar route", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(calls);
    renderAt("u1");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Deactivate Robin Staff" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/core/api/calendar-access/u1/active")).toBe(true));
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/active"))!.init!.body as string)).toEqual({ isActive: false });
    expect(await screen.findByRole("status")).toHaveTextContent("Robin Staff is deactivated. The Calendar picks this up within a minute.");
  });

  it("offers Link for an inactive user with no email", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const imported = { ...DETAIL, user: { ...DETAIL.user, id: "u2", displayName: "Kim Imported", email: null, isActive: false }, profile: { phone: null, mobile: null, jobTitle: null, description: null }, commContacts: [] };
    stub(calls, imported);
    renderAt("u2");
    const form = await screen.findByRole("form", { name: "Link and activate Kim Imported" });
    const user = userEvent.setup();
    await user.type(within(form).getByLabelText("Email"), "kim.imported@example.test");
    await user.click(within(form).getByRole("button", { name: "Link and activate" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/core/api/calendar-access/u2/link")).toBe(true));
  });

  it("shows Core's refusal for a user with other roles", async () => {
    stub([], DETAIL, (url) => (url.endsWith("/active") ? jsonResponse(403, { error: "only a Core admin can change a user who also has NRMS or NoD roles", reason: "other-roles" }) : undefined));
    renderAt("u1");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Deactivate Robin Staff" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("only a Core admin can change a user who also has NRMS or NoD roles");
  });

  it("an unknown user is not found", async () => {
    stub([]);
    renderAt("nobody");
    expect(await screen.findByText("This user isn’t in the Calendar.")).toBeInTheDocument();
  });
});
```

Add to `apps/staff-web/src/screens/calendar/a11y.test.tsx`: routes `users` → `<CalendarUsersScreen />` and `users/:id` → `<CalendarUserScreen />` in `at()`, stub responses for `/calendar/api/users` (the `ROWS` above), `/calendar/api/users/u1` (`DETAIL`), `/core/api/calendar-access` and `/core/api/organizations`, and two cases:

```tsx
  it("Calendar users", async () => {
    stub();
    const { container } = render(at("/calendar/users"));
    await screen.findByRole("link", { name: "Robin Staff (HLTH) (4)" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("one Calendar user", async () => {
    stub();
    const { container } = render(at("/calendar/users/u1"));
    await screen.findByRole("form", { name: "Contact details" });
    expect(await seriousViolations(container)).toEqual([]);
  });
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/calendar`
Expected: FAIL. The screens don't exist.

- [ ] **Step 4: Types and the list screen**

`apps/staff-web/src/screens/calendar/users/types.ts`:

```ts
import type { CalendarRoleName } from "../../admin/calendar-access/calendar-roles";

export interface CalendarUserRow {
  userId: string;
  displayName: string;
  email: string | null;
  isActive: boolean;
  role: CalendarRoleName | null;
  ministryKey: string | null;
  ministryAbbreviation: string | null;
  rank: number | null;
}
export interface Profile {
  phone: string | null;
  mobile: string | null;
  jobTitle: string | null;
  description: string | null;
}
export interface CalendarUserDetail {
  user: { id: string; displayName: string; email: string | null; isActive: boolean; role: CalendarRoleName | null; ministryKeys: string[] };
  profile: Profile;
  commContacts: { ministryKey: string; rank: number | null; isActive: boolean }[];
}

/** Legacy's CommContactTypeSortOrder (Admin/User.aspx.cs:16-25). */
export const RANK_OPTIONS = [
  { value: "", label: "Not a comm contact" },
  { value: "1", label: "Comm Director" },
  { value: "2", label: "Comm Manager" },
  { value: "3", label: "Sr. PAO" },
  { value: "4", label: "PAO" },
  { value: "5", label: "Jr. PAO" },
  { value: "6", label: "Other" },
] as const;

/** Legacy's list label: "Full name (Abbreviation) (rank)". */
export function rowLabel(r: CalendarUserRow): string {
  return `${r.displayName}${r.ministryAbbreviation ? ` (${r.ministryAbbreviation})` : r.ministryKey ? ` (${r.ministryKey})` : ""}${r.rank ? ` (${r.rank})` : ""}${r.isActive ? "" : " — inactive"}`;
}
```

`apps/staff-web/src/screens/calendar/users/CalendarUsersScreen.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { InlineAlert, TextField } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../../api/client";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { rowLabel, type CalendarUserRow } from "./types";

/** `/hub/calendar/users`: legacy's user list (Admin/UserList.aspx.cs), one row per user and ministry. */
export function CalendarUsersScreen(): React.JSX.Element {
  useDocumentTitle("Calendar users");
  const [inactive, setInactive] = useState(false);
  const [noAccess, setNoAccess] = useState(false);
  const [filter, setFilter] = useState("");
  const [rows, setRows] = useState<CalendarUserRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  useEffect(() => {
    const call = ++latest.current;
    const q = [inactive && "inactive=1", noAccess && "noAccess=1"].filter(Boolean).join("&");
    apiFetch<CalendarUserRow[]>(`/calendar/api/users${q ? `?${q}` : ""}`).then(
      (r) => {
        if (call === latest.current) {
          setRows(r);
          setError(null);
        }
      },
      () => {
        if (call === latest.current) setError("Couldn't load Calendar users.");
      },
    );
  }, [inactive, noAccess]);

  const needle = filter.trim().toLowerCase();
  const shown = (rows ?? []).filter((r) => !needle || r.displayName.toLowerCase().includes(needle) || (r.ministryAbbreviation ?? "").toLowerCase().includes(needle));
  return (
    <div>
      <h1>Calendar users</h1>
      <p>Contact details and comm-contact ranks are kept here. Roles, ministries and accounts are saved in Core and reach the Calendar within a minute.</p>
      {error && <InlineAlert variant="danger" role="alert" description={error} />}
      <TextField label="Find by name or ministry" value={filter} onChange={setFilter} />
      <div>
        <input id="calendar-users-inactive" type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} />
        <label htmlFor="calendar-users-inactive">Show inactive users, including those with no email</label>
      </div>
      <div>
        <input id="calendar-users-no-access" type="checkbox" checked={noAccess} onChange={(e) => setNoAccess(e.target.checked)} />
        <label htmlFor="calendar-users-no-access">Show users without Calendar access</label>
      </div>
      {rows === null && !error && <p>Loading…</p>}
      <ul>
        {shown.map((r) => (
          <li key={`${r.userId}:${r.ministryKey ?? ""}`}>
            <Link to={`/calendar/users/${r.userId}`}>{rowLabel(r)}</Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 5: The user screen**

`apps/staff-web/src/screens/calendar/users/CalendarUserScreen.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { Button, InlineAlert } from "@bcgov/design-system-react-components";
import { ApiError, apiFetch } from "../../../api/client";
import { useSession } from "../../../session/SessionContext";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { messagesOf } from "../../admin/messages";
import { AccessEditor, actorFor } from "../../admin/calendar-access/AccessEditor";
import type { CalendarAccessUser, OrgOption } from "../../admin/calendar-access/CalendarAccessScreen";
import { RANK_OPTIONS, type CalendarUserDetail, type Profile } from "./types";

const LAG = "The Calendar picks this up within a minute.";

function Alerts({ messages }: { messages: string[] }): React.JSX.Element {
  return (
    <>
      {messages.map((m) => (
        <p role="alert" key={m}>
          {m}
        </p>
      ))}
    </>
  );
}

function ProfileForm({ userId, profile, onSaved }: { userId: string; profile: Profile; onSaved(msg: string): void }): React.JSX.Element {
  const [draft, setDraft] = useState({ phone: profile.phone ?? "", mobile: profile.mobile ?? "", jobTitle: profile.jobTitle ?? "", description: profile.description ?? "" });
  const [messages, setMessages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const field = (key: keyof typeof draft, label: string, hint?: string) => (
    <div>
      <label htmlFor={`profile-${key}`}>{label}</label>
      {hint && <p id={`profile-${key}-hint`}>{hint}</p>}
      <input id={`profile-${key}`} aria-describedby={hint ? `profile-${key}-hint` : undefined} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} disabled={busy} />
    </div>
  );
  const save = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setMessages([]);
    try {
      await apiFetch(`/calendar/api/users/${userId}/profile`, { method: "PUT", body: draft });
      onSaved("Saved contact details.");
    } catch (caught) {
      setMessages(messagesOf(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form aria-label="Contact details" onSubmit={save}>
      <h2>Contact details</h2>
      <Alerts messages={messages} />
      {field("phone", "Phone", "12 digits and hyphens, like 250-555-0100")}
      {field("mobile", "Mobile", "12 digits and hyphens, like 250-555-0100")}
      {field("jobTitle", "Job title")}
      <div>
        <label htmlFor="profile-description">Description</label>
        <textarea id="profile-description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} disabled={busy} />
      </div>
      <Button type="submit" isDisabled={busy}>
        Save contact details
      </Button>
    </form>
  );
}

/** `/hub/calendar/users/:id`: one Calendar user (spec addendum §8.5). */
export function CalendarUserScreen(): React.JSX.Element {
  const { id = "" } = useParams();
  const session = useSession();
  const [detail, setDetail] = useState<CalendarUserDetail | null>(null);
  const [coreUsers, setCoreUsers] = useState<CalendarAccessUser[]>([]);
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [editingAccess, setEditingAccess] = useState(false);
  const [linkEmail, setLinkEmail] = useState("");
  const latest = useRef(0);
  useDocumentTitle(detail?.user.displayName ?? (notFound ? "Calendar user" : null));

  const reload = useCallback(() => {
    const call = ++latest.current;
    Promise.all([
      apiFetch<CalendarUserDetail>(`/calendar/api/users/${encodeURIComponent(id)}`),
      apiFetch<CalendarAccessUser[]>("/core/api/calendar-access"),
      apiFetch<OrgOption[]>("/core/api/organizations"),
    ]).then(
      ([d, u, o]) => {
        if (call !== latest.current) return;
        setDetail(d);
        setCoreUsers(u);
        setOrgs(o);
      },
      (caught: unknown) => {
        if (call !== latest.current) return;
        if (caught instanceof ApiError && caught.status === 404) setNotFound(true);
        else setLoadError("Couldn't load this user.");
      },
    );
  }, [id]);
  useEffect(() => reload(), [reload]);

  if (notFound) {
    return (
      <div>
        <h1>Calendar user</h1>
        <p>This user isn&rsquo;t in the Calendar.</p>
        <Link to="/calendar/users">All Calendar users</Link>
      </div>
    );
  }
  if (loadError) return <InlineAlert variant="danger" role="alert" description={loadError} />;
  if (!detail) return <p>Loading…</p>;

  const u = detail.user;
  // Core's view is the authority for role, ministries and active; the Calendar's copy can lag a tick.
  const core = coreUsers.find((c) => c.id === u.id);
  const byKey = new Map(orgs.map((o) => [o.key, o]));
  const done = (msg: string) => {
    setStatus(msg);
    setMessages([]);
    reload();
  };
  const fail = (caught: unknown) => setMessages(messagesOf(caught));

  const setRank = async (ministryKey: string, value: string) => {
    try {
      await apiFetch(`/calendar/api/users/${u.id}/comm-contacts/${encodeURIComponent(ministryKey)}`, { method: "PUT", body: { rank: value === "" ? null : Number(value) } });
      done("Saved the comm-contact rank.");
    } catch (caught) {
      fail(caught);
    }
  };
  const setActive = async (isActive: boolean) => {
    try {
      await apiFetch(`/core/api/calendar-access/${u.id}/active`, { method: "PUT", body: { isActive } });
      done(`${u.displayName} is ${isActive ? "reactivated" : "deactivated"}. ${LAG}`);
    } catch (caught) {
      fail(caught);
    }
  };
  const link = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try {
      await apiFetch(`/core/api/calendar-access/${u.id}/link`, { method: "POST", body: { email: linkEmail } });
      done(`${u.displayName} is linked and active. ${LAG}`);
    } catch (caught) {
      fail(caught);
    }
  };

  const isActive = core?.isActive ?? u.isActive;
  const email = core ? core.email : u.email;
  return (
    <div>
      <p>
        <Link to="/calendar/users">All Calendar users</Link>
      </p>
      <h1>{u.displayName}</h1>
      <p>
        {email ?? "No email"}
        {isActive ? "" : " — inactive"}
      </p>
      {status && <p role="status">{status}</p>}
      <Alerts messages={messages} />

      <h2>Calendar access</h2>
      {core && editingAccess ? (
        <AccessEditor
          user={core}
          orgs={orgs}
          actor={actorFor(session, coreUsers, orgs)}
          onSaved={(m) => {
            setEditingAccess(false);
            done(`${m} ${LAG}`);
          }}
          onCancel={() => setEditingAccess(false)}
        />
      ) : (
        <Button variant="secondary" onPress={() => setEditingAccess(true)} isDisabled={!core}>
          {`Edit Calendar access for ${u.displayName}`}
        </Button>
      )}

      <ProfileForm userId={u.id} profile={detail.profile} onSaved={done} />

      <h2>Comm contact</h2>
      {u.ministryKeys.length === 0 && <p>Give this user a ministry first.</p>}
      {u.ministryKeys.map((k) => {
        const o = byKey.get(k);
        const label = `${o?.displayName ?? k}${o?.abbreviation ? ` (${o.abbreviation})` : ""}`;
        const current = detail.commContacts.find((c) => c.ministryKey === k && c.isActive);
        return (
          <div key={k}>
            <label htmlFor={`rank-${k}`}>{`Comm contact rank for ${label}`}</label>
            <select id={`rank-${k}`} value={current?.rank ? String(current.rank) : ""} onChange={(e) => void setRank(k, e.target.value)}>
              {RANK_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
        );
      })}

      <h2>Account</h2>
      {isActive ? (
        <Button variant="secondary" onPress={() => void setActive(false)}>{`Deactivate ${u.displayName}`}</Button>
      ) : email ? (
        <Button variant="secondary" onPress={() => void setActive(true)}>{`Reactivate ${u.displayName}`}</Button>
      ) : (
        <form aria-label={`Link and activate ${u.displayName}`} onSubmit={link}>
          <p>This user was imported without an email. Linking sets their email and activates them.</p>
          <label htmlFor="link-email">Email</label>
          <input id="link-email" type="email" value={linkEmail} onChange={(e) => setLinkEmail(e.target.value)} required />
          <Button type="submit">Link and activate</Button>
        </form>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Nav and routes**

`CalendarSection.tsx`: after the Lookups item, for `me.level >= CALENDAR_ADMIN_LEVEL`: `<li><NavLink to="/calendar/users">Users</NavLink></li>`. `router.tsx`, in the `calendar` children: `{ path: "users", element: <CalendarUsersScreen /> }, { path: "users/:id", element: <CalendarUserScreen /> }`. `CalendarHome.tsx`: add a "Manage Calendar users" link next to the lookups one.

- [ ] **Step 7: Run the tests and type-check**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web` and the staff-web `tsc`.
Expected: PASS and clean.

- [ ] **Step 8: Commit**

```bash
git add apps/staff-web
git commit -m "feat(staff-web): Calendar users list and user page (contact details, ranks, access, active and link)"
```

---

### Task 4: Calendar test users, seeding, and the users e2e

Covers carry-forward "Calendar test users", the users half of acceptance item 1 on the staff screens, E8.

**Files:**
- Modify: `apps/core/src/services/seed-test-users.ts` (+ `seed-test-users.test.ts`), and the CLI that prints its result if it formats fields.
- Modify: `scripts/siteground-seed-users.sh` (+ `tests/siteground-seed-users.test.ts`).
- Modify: `tests/e2e/constants.ts`, `tests/e2e/global-setup.ts`.
- Create: `tests/e2e/calendar-users.spec.ts`.

**Interfaces:**
- Consumes: `setCalendarAccess`, `getOrganization`, `upsertOrganization` (Core); Task 1's routes; Task 3's screens.
- Produces:
  - `TEST_USERS` entries may carry `calendar: { role: CalendarRole; organizationKeys: string[] }`.
  - `seedTestUsers` result items `{ email; action: "created" | "updated"; calendar?: "set" | "skipped"; missingOrganizations?: string[] }`.
  - e2e constants `CAL_ADMIN_EMAIL`, `CAL_SYSADMIN_EMAIL`, `CAL_HQ_ADMIN_EMAIL`, `CAL_EDITOR_EMAIL`, `CAL_READONLY_EMAIL` and their passwords in `TEST_USER_PASSWORDS`.

- [ ] **Step 1: Write the failing tests**

In `apps/core/src/services/seed-test-users.test.ts` (one Core test database `tdb` for the file; `pw(n)` builds a password for every `TEST_USERS` address, so the new users are covered): the two existing `toEqual(TEST_USERS.map(...))` expectations become

```ts
const expected = (action: "created" | "updated") =>
  TEST_USERS.map((u) => ({ email: u.email, action, ...(u.calendar ? { calendar: "skipped", missingOrganizations: [...u.calendar.organizationKeys] } : {}) }));
```

(no organization exists yet in that database), the first test's title becomes "creates the test users with their roles", and append, after those tests (add `upsertOrganization` from `./organizations` and `healthOrg` from `../../test/helpers` to the imports):

```ts
  it("skips Calendar access when an organization is missing, and grants it on a re-run", async () => {
    const first = await seedTestUsers(tdb.db, pw(3));
    expect(first.find((r) => r.email === "cal-admin@example.test")).toMatchObject({ calendar: "skipped", missingOrganizations: ["health"] });
    await upsertOrganization(tdb.db, healthOrg, []);
    await upsertOrganization(tdb.db, { ...healthOrg, key: "finance", displayName: "Finance", abbreviation: "FIN", sectorKeys: [] }, []);
    await upsertOrganization(tdb.db, { ...healthOrg, key: "gcpe-headquarters", displayName: "GCPE Headquarters", abbreviation: "GCPEHQ", sectorKeys: [], isHq: true }, []);
    const second = await seedTestUsers(tdb.db, pw(4));
    for (const e of ["cal-admin", "cal-sysadmin", "cal-hq-admin", "cal-editor", "cal-readonly"]) {
      expect(second.find((r) => r.email === `${e}@example.test`)?.calendar).toBe("set");
    }
    const admin = await findUserByEmail(tdb.db, "cal-admin@example.test");
    expect(admin).toMatchObject({ calendarRole: "Calendar.Administrator", organizationKeys: ["health"], roles: [] });
    expect((await findUserByEmail(tdb.db, "cal-hq-admin@example.test"))!.organizationKeys).toEqual(["gcpe-headquarters"]);
  });

  it("users without a Calendar entry report no calendar field", async () => {
    const r = await seedTestUsers(tdb.db, pw(5));
    expect(r.find((x) => x.email === "editor@example.test")).not.toHaveProperty("calendar");
  });
```

In `tests/siteground-seed-users.test.ts`, add an expectation in the style of its existing ones (it reads the script text) that the script seeds the five `cal-*@example.test` users and calls `/core/api/calendar-access/`:

```ts
  it("seeds the Calendar test users and gives them Calendar access", () => {
    for (const e of ["cal-admin", "cal-sysadmin", "cal-hq-admin", "cal-editor", "cal-readonly"]) expect(script).toContain(`${e}@example.test`);
    expect(script).toContain("/core/api/calendar-access/");
  });
```

`tests/e2e/calendar-users.spec.ts`:

```ts
// The Calendar users screen end to end: a seeded Calendar Administrator edits a Calendar-only
// user's contact details and rank, deactivates them, and is refused on a user with an NRMS role.
import { test, expect } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USERNAME, CAL_ADMIN_EMAIL, EDITOR_EMAIL, TEST_USER_PASSWORDS } from "./constants";
import { apiCall, baseUrl, expectNoSeriousA11yViolations, loginForCookie, tick } from "./playwright-support";

test.describe("Calendar users", () => {
  test("a Calendar Administrator edits a user's contact details, rank and account", async ({ page, context }) => {
    const admin = await loginForCookie(ADMIN_USERNAME, ADMIN_PASSWORD);
    const stamp = Date.now();
    const staff = await apiCall<{ id: string }>(admin, "/core/api/users", { method: "POST", body: { email: `cal-user-${stamp}@example.test`, displayName: `Calendar User ${stamp}` } });
    await apiCall(admin, `/core/api/calendar-access/${staff.id}`, { method: "PUT", body: { role: "Calendar.Editor", organizationKeys: ["health"] } });
    await tick();

    const cookie = await loginForCookie(CAL_ADMIN_EMAIL, TEST_USER_PASSWORDS[CAL_ADMIN_EMAIL]!);
    const [name, value] = cookie.split("=", 2) as [string, string];
    await context.addCookies([{ name, value, domain: new URL(baseUrl()).hostname, path: "/", httpOnly: true, secure: false, sameSite: "Lax" }]);

    await page.goto(`${baseUrl()}/hub/calendar/users`);
    await expect(page.getByRole("heading", { level: 1, name: "Calendar users" })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "Calendar users");
    await page.getByRole("link", { name: new RegExp(`^Calendar User ${stamp} \\(HLTH\\)`) }).click();
    await expect(page.getByRole("heading", { level: 1, name: `Calendar User ${stamp}` })).toBeVisible();

    const profile = page.getByRole("form", { name: "Contact details" });
    await profile.getByLabel("Phone").fill("250 555 0100");
    await profile.getByRole("button", { name: "Save contact details" }).click();
    await expect(profile.getByRole("alert")).toHaveText("use 12 digits and hyphens, like 250-555-0100");
    await profile.getByLabel("Phone").fill("250-555-0100");
    await profile.getByRole("button", { name: "Save contact details" }).click();
    await expect(page.getByRole("status")).toHaveText("Saved contact details.");

    await page.getByLabel("Comm contact rank for Health (HLTH)").selectOption("4");
    await expect(page.getByRole("status")).toHaveText("Saved the comm-contact rank.");
    await expectNoSeriousA11yViolations(page, "Calendar user");

    await page.getByRole("button", { name: `Deactivate Calendar User ${stamp}` }).click();
    await expect(page.getByRole("status")).toContainText(`Calendar User ${stamp} is deactivated.`);

    // Q55: a user who also holds an NRMS role is a Core admin's to change.
    const editor = (await apiCall<{ id: string; email: string | null }[]>(admin, "/core/api/calendar-access")).find((u) => u.email === EDITOR_EMAIL)!;
    const refused = await fetch(`${baseUrl()}/core/api/calendar-access/${editor.id}/active`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json", "x-gcpe-request": "1" },
      body: JSON.stringify({ isActive: false }),
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ reason: "other-roles" });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/core/src/services/seed-test-users.test.ts tests/siteground-seed-users.test.ts`
Expected: FAIL. No Calendar users in `TEST_USERS`; the script has none.

- [ ] **Step 3: `TEST_USERS` and `seedTestUsers`**

In `apps/core/src/services/seed-test-users.ts`:

```ts
import type { CalendarRole } from "@gcpe/auth";
import { setCalendarAccess } from "./calendar-access";
import { getOrganization } from "./organizations";

interface TestUser {
  email: string;
  displayName: string;
  roles: readonly string[];
  /** Calendar access, given only when every organization exists (they come from the seed or a test). */
  calendar?: { role: CalendarRole; organizationKeys: readonly string[] };
}

/** The local test users (spec addendum §2; NoD parity spec §10 item 14; Calendar spec addendum §4).
 * Fictional addresses on the reserved .test TLD. */
export const TEST_USERS: readonly TestUser[] = [
  { email: "editor@example.test", displayName: "Test Editor", roles: ["NRMS.Editor"] },
  { email: "site-editor@example.test", displayName: "Test Site Editor", roles: ["NRMS.SiteEditor"] },
  { email: "viewer@example.test", displayName: "Test Viewer", roles: ["NRMS.Viewer"] },
  { email: "nod-viewer@example.test", displayName: "Test NoD Viewer", roles: ["NoD.Viewer"] },
  { email: "nod-editor@example.test", displayName: "Test NoD Editor", roles: ["NoD.Editor"] },
  { email: "cal-admin@example.test", displayName: "Test Calendar Administrator", roles: [], calendar: { role: "Calendar.Administrator", organizationKeys: ["health"] } },
  { email: "cal-sysadmin@example.test", displayName: "Test Calendar System Administrator", roles: [], calendar: { role: "Calendar.SysAdmin", organizationKeys: ["health"] } },
  { email: "cal-hq-admin@example.test", displayName: "Test Calendar HQ Administrator", roles: [], calendar: { role: "Calendar.Administrator", organizationKeys: ["gcpe-headquarters"] } },
  { email: "cal-editor@example.test", displayName: "Test Calendar Editor", roles: [], calendar: { role: "Calendar.Editor", organizationKeys: ["health"] } },
  { email: "cal-readonly@example.test", displayName: "Test Calendar Read Only", roles: [], calendar: { role: "Calendar.ReadOnly", organizationKeys: ["finance"] } },
];

export interface SeedResult {
  email: string;
  action: "created" | "updated";
  calendar?: "set" | "skipped";
  missingOrganizations?: string[];
}
```

In `seedTestUsers` (return type `Promise<SeedResult[]>`), after the create or update of each user, with `id` the created or existing user's id:

```ts
    if (u.calendar) {
      const missing: string[] = [];
      for (const k of u.calendar.organizationKeys) if (!(await getOrganization(db, k))) missing.push(k);
      if (missing.length) {
        result.calendar = "skipped";
        result.missingOrganizations = missing;
      } else {
        // The seed acts as a Core admin; Core's republish carries the grant to the Calendar.
        await setCalendarAccess(db, { id: "seed", roles: ["Core.Admin"] }, id, { role: u.calendar.role, organizationKeys: [...u.calendar.organizationKeys] }, []);
        result.calendar = "set";
      }
    }
    out.push(result);
```

restructuring the loop so `result` is built for both branches before the push (today each branch pushes directly). In `apps/core/src/cli/seed-test-users.ts:15`, print the Calendar outcome too: ``console.log(`${r.action.padEnd(8)} ${r.email}${r.calendar ? ` (calendar ${r.calendar}${r.missingOrganizations ? `: missing ${r.missingOrganizations.join(", ")}` : ""})` : ""}`)``.

- [ ] **Step 4: The SiteGround script**

In `scripts/siteground-seed-users.sh`:
- Change `create_body` so an empty role argument means no roles: `"roles":([sys.argv[3]] if sys.argv[3] else [])`, and the same in the roles PUT body.
- Add after `seed()`:

```bash
# Gives a seeded user Calendar access. Organizations must already exist (the public-API seed
# creates health and finance; it creates gcpe-headquarters as an HQ organization).
calendar_access() {
  local email="$1" role="$2" orgs="$3" id status
  id="$(curl_api "$BASE/core/api/users" | python3 -c 'import json,sys; e=sys.argv[1]; print(next((u["id"] for u in json.load(sys.stdin) if u["email"]==e), ""))' "$email")"
  [ -n "$id" ] || { echo "failed   $email (no such user)"; return; }
  status="$(python3 -c 'import json,sys; print(json.dumps({"role":sys.argv[1],"organizationKeys":sys.argv[2].split(",")}))' "$role" "$orgs" | curl_api -o /dev/null -w '%{http_code}' -X PUT "$BASE/core/api/calendar-access/$id" -d @-)"
  case "$status" in 2??) echo "calendar $email ($role: $orgs)" ;; *) echo "failed   $email (calendar access HTTP $status)" ;; esac
}
```

- After the existing `seed` lines:

```bash
seed cal-admin@example.test "Test Calendar Administrator" ""
seed cal-sysadmin@example.test "Test Calendar System Administrator" ""
seed cal-hq-admin@example.test "Test Calendar HQ Administrator" ""
seed cal-editor@example.test "Test Calendar Editor" ""
seed cal-readonly@example.test "Test Calendar Read Only" ""
calendar_access cal-admin@example.test Calendar.Administrator health
calendar_access cal-sysadmin@example.test Calendar.SysAdmin health
calendar_access cal-hq-admin@example.test Calendar.Administrator gcpe-headquarters
calendar_access cal-editor@example.test Calendar.Editor health
calendar_access cal-readonly@example.test Calendar.ReadOnly finance
```

- Update the header comment ("Creates (or resets) the test users …").

- [ ] **Step 5: e2e constants and setup**

`tests/e2e/constants.ts`: add the five addresses to `TEST_USER_PASSWORDS` (`"cal-admin@example.test": "e2e-cal-admin-password-1"`, and likewise `cal-sysadmin`, `cal-hq-admin`, `cal-editor`, `cal-readonly`), and export `CAL_ADMIN_EMAIL`, `CAL_SYSADMIN_EMAIL`, `CAL_HQ_ADMIN_EMAIL`, `CAL_EDITOR_EMAIL`, `CAL_READONLY_EMAIL`.

`tests/e2e/global-setup.ts`, before `seedTestUsers`:

```ts
  // The Calendar test users name these organizations; Core's republish (the stack's backfill on
  // an empty Calendar) carries them and the users' grants to the Calendar on the first tick.
  await upsertOrganization(core.db, healthOrg, []);
  await upsertOrganization(core.db, { ...healthOrg, key: "finance", displayName: "Finance", abbreviation: "FIN", sectorKeys: [] }, []);
  await upsertOrganization(core.db, { ...healthOrg, key: "gcpe-headquarters", displayName: "GCPE Headquarters", abbreviation: "GCPEHQ", sectorKeys: [], isHq: true, isPublic: false }, []);
```

importing `healthOrg` from `../../apps/core/test/helpers` and `upsertOrganization` from `../../apps/core/src/services/organizations`. The specs that PUT `health` themselves (5a's `calendar-access.spec.ts`, 5b-1's `calendar-lookups.spec.ts`) still pass: the PUT is an idempotent upsert.

- [ ] **Step 6: Run the tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/core tests/siteground-seed-users.test.ts` and `npx -y -p node@24 -- npm run test:e2e`.
Expected: PASS, including `sign-in-roles.spec.ts` (unchanged users) and the new spec.

- [ ] **Step 7: Commit**

```bash
git add apps/core scripts tests
git commit -m "test: Calendar test users seeded with ministries; Calendar users screen end to end"
```

---

### Task 5: The report-rendering spike (spec §10.1)

Research with a recorded outcome. The deliverable is `docs/superpowers/plans/2026-10-08-phase-5b-report-rendering-spike.md`, committed to `feat/phase-5b`. The code lives only on `spike/5b-report-rendering` (E9). The "test" of this task is the fidelity checker (Step 6), which exits non-zero on any failed requirement, and the report's completeness check (Step 10).

**Files (spike branch only):**
- Create: `spikes/report-rendering/package.json`, `fixture.mjs`, `templates.mjs`, `render-chromium.mjs`, `render-pdfmake.mjs`, `render-docx.mjs`, `patch-docx.mjs`, `measure.mjs`, `run-all.mjs`, `check.mjs`, `README.md`, `out/` (git-ignored).
- Create (temporary, spike branch only): `apps/stack/src/spike-route.ts`, a one-line mount in `apps/stack/src/stack.ts`.

**Files (`feat/phase-5b`):**
- Create: `docs/superpowers/plans/2026-10-08-phase-5b-report-rendering-spike.md`.

**Interfaces:**
- Consumes: nothing from the platform's code except, for the runtime leg, the stack's `errorsAuth` bearer and `DATA_DIR`.
- Produces: the report. Its recommendation is the input to 5g's plan.

- [ ] **Step 1: The spike branch and package**

```bash
git switch -c spike/5b-report-rendering
mkdir -p spikes/report-rendering/out
printf 'out/\nnode_modules/\n' > spikes/report-rendering/.gitignore
```

`spikes/report-rendering/package.json` (not a workspace: the root `workspaces` globs are `packages/*` and `apps/*`):

```json
{
  "name": "report-rendering-spike",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "dependencies": {
    "@sparticuz/chromium": "153.0.0",
    "@turbodocx/html-to-docx": "1.23.1",
    "html-to-pdfmake": "2.5.35",
    "jsdom": "30.1.2",
    "jszip": "3.10.1",
    "pdf-lib": "1.17.1",
    "pdfmake": "0.2.23",
    "puppeteer-core": "25.13.0"
  }
}
```

Before installing, re-check each licence: `for p in @sparticuz/chromium @turbodocx/html-to-docx html-to-pdfmake jsdom jszip pdf-lib pdfmake puppeteer-core; do npm view $p license; done` (expected: MIT, MIT, MIT, MIT, MIT or GPL-3.0 dual (jszip is "(MIT OR GPL-3.0-or-later)"; use it under MIT), MIT, MIT, Apache-2.0). Record the output in the report. Then `cd spikes/report-rendering && npx -y -p node@24 -- npm install`.

A local Chromium for macOS: `npx -y @puppeteer/browsers install chrome-headless-shell@stable --path ~/.cache/report-spike` and export `CHROMIUM_PATH` to the binary it prints. Record its version (`"$CHROMIUM_PATH" --version`).

- [ ] **Step 2: The synthetic fixture**

`spikes/report-rendering/fixture.mjs`:

```js
// 1,106 fictional activities, the live window's size (spec addendum §13, SV 4.2), 37 of them
// confidential. Deterministic, so every host renders the same bytes of input.
const MINISTRIES = ["HLTH", "FIN", "EDUC", "TRAN", "ENV", "AGRI", "JOBS", "HOUS"];
const CITIES = ["Sampletown", "Exampleville", "Testford", "Demo Bay", "Placeholder Hills"];
const SECTIONS = ["events_and_speeches", "in_the_news", "issues_and_reports", "not_on_la"];

export function makeFixture({ count = 1106, seed = 20261008, from = "2026-11-02" } = {}) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const base = Date.parse(`${from}T08:00:00-07:00`);
  return Array.from({ length: count }, (_, i) => {
    const dayOffset = Math.floor(rnd() * 150) - 30; // started up to 30 days ago, up to 120 ahead
    const spanDays = rnd() < 0.15 ? 1 + Math.floor(rnd() * 6) : 0;
    const start = new Date(base + dayOffset * 86_400_000 + Math.floor(rnd() * 20) * 1_800_000);
    const end = new Date(start.getTime() + (spanDays ? spanDays * 86_400_000 : 3_600_000));
    return {
      id: 50_000 + i,
      ministry: MINISTRIES[i % MINISTRIES.length],
      title: `Sample activity ${i + 1}`,
      details: Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => "Fictional details for the rendering spike.").join(" "),
      city: CITIES[i % CITIES.length],
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      isAllDay: spanDays > 0,
      isConfidential: i % 30 === 0,
      isIssue: rnd() < 0.1,
      hqSection: SECTIONS[Math.floor(rnd() * SECTIONS.length)],
      laStatus: rnd() < 0.1 ? "NEW" : rnd() < 0.1 ? "CHANGED" : null,
      rls: rnd() < 0.3 ? ["BCGov", "NR"] : ["-"],
      significance: "Fictional significance.",
      schedule: "Fictional scheduling note.",
      premierRequested: rnd() < 0.05 ? "Confirmed" : null,
      tags: ["HQ Sample", "Sample tag"],
    };
  });
}

/** The activities a Look Ahead from `from` for `days` days shows, per day (multi-day items repeat). */
export function lookAheadDays(activities, { from = "2026-11-02", days = 60 } = {}) {
  const out = [];
  for (let d = 0; d < days; d++) {
    const dayStart = Date.parse(`${from}T00:00:00-07:00`) + d * 86_400_000; // BC is UTC−7 all year from 2026-11-01
    const dayEnd = dayStart + 86_400_000;
    const rows = activities
      .filter((a) => !(a.isConfidential && a.hqSection === "not_on_la"))
      .filter((a) => Date.parse(a.startAt) < dayEnd && Date.parse(a.endAt) >= dayStart)
      .sort((a, b) => Number(b.isAllDay) - Number(a.isAllDay) || a.startAt.localeCompare(b.startAt));
    out.push({ date: new Date(dayStart), rows });
  }
  return out;
}
```

- [ ] **Step 3: The templates**

`spikes/report-rendering/templates.mjs`:

```js
// HTML templates in the layouts of docs/parity/legacy-report-layouts.md (pixel-verified colours).
// Running text uses CSS paged-media margin boxes, so one template carries its own page furniture.
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmtDay = (d) => d.toLocaleDateString("en-CA", { timeZone: "America/Vancouver", weekday: "long", month: "long", day: "numeric", year: "numeric" });
const UPDATED = "Updated Monday, Nov 2, 2026 8:00 AM";

export const PAGE = {
  letter: { css: "8.5in 11in", pdfmake: { pageSize: "LETTER", pageOrientation: "portrait" }, docx: { orientation: "portrait", pageSize: { width: 12240, height: 15840 } } },
  legal: { css: "14in 8.5in", pdfmake: { pageSize: "LEGAL", pageOrientation: "landscape" }, docx: { orientation: "landscape", pageSize: { width: 20160, height: 12240 } } },
};

function css(size) {
  return `
  @page { size: ${PAGE[size].css}; margin: 0.9in 0.5in 0.8in 0.5in;
    @top-left { content: "Province of BC"; font: 9pt Helvetica, Arial, sans-serif; }
    @top-right { content: "DRAFT AND CONFIDENTIAL"; color: #9e3a38; font: bold 9pt Helvetica, Arial, sans-serif; }
    @bottom-left { content: "${UPDATED}"; font: 8pt Helvetica, Arial, sans-serif; }
    @bottom-center { content: '"CHANGED" applies to major detail or date changes only (not time switches)'; font: 7pt Helvetica, Arial, sans-serif; }
    @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8pt Helvetica, Arial, sans-serif; } }
  @page :first { @top-right { content: "DRAFT ONLY - NOT FOR CIRCULATION / Information is confidential and subject to change"; color: #000; } @top-left { content: none; } }
  body { font: 9pt Helvetica, Arial, sans-serif; margin: 0; }
  table { width: 100%; border-collapse: collapse; page-break-inside: auto; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  th { color: #fff; text-align: left; padding: 3pt; }
  td { padding: 3pt; vertical-align: top; border-bottom: 0.5pt solid #ccc; }
  tbody tr:nth-child(even) td { background: #f2f2f2; }
  .events th { background: #558abd; }
  .planning th { background: #384c70; }
  .day { break-before: page; }
  .day:first-of-type { break-before: auto; }
  h2 { color: #558abd; text-align: center; font-size: 12pt; }
  .flag { color: #e36c09; font-weight: bold; }
  .legend td.swatch { width: 18pt; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }`;
}

const doc = (size, body) => `<!doctype html><html><head><meta charset="utf-8"><style>${css(size)}</style></head><body>${body}</body></html>`;

// A generated placeholder, never legacy's cover photograph (E12).
const COVER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="260"><rect width="600" height="260" fill="#555"/><text x="300" y="140" font-family="Helvetica" font-size="28" fill="#fff" text-anchor="middle">SAMPLE COVER</text></svg>`;
const COVER = `data:image/svg+xml;base64,${Buffer.from(COVER_SVG).toString("base64")}`;

const LEGEND = [
  ["Events, Speeches and Releases (Inside Government)", "#558abd"],
  ["Issues and Reports", "#ccc0d9"],
  ["In the News (Outside Government)", "#e8f3a9"],
  ["Awareness Dates", "#eaf1dd"],
];

export function coverHtml(size, title) {
  const rows = LEGEND.map(([label, colour]) => `<tr><td class="swatch" style="background:${colour}"></td><td>${esc(label)}</td></tr>`).join("");
  return doc(size, `<img src="${COVER}" style="width:100%"><h1 style="text-align:center">${esc(title)}</h1><p><b>Contents:</b></p><table class="legend">${rows}</table>`);
}

function dayTable(day) {
  const head = day.date.toLocaleDateString("en-CA", { timeZone: "America/Vancouver", weekday: "short", month: "short", day: "numeric" });
  const body = day.rows.length
    ? day.rows
        .map((a) => {
          const flag = a.laStatus ? `<div class="flag">${a.laStatus}</div>` : "";
          return `<tr><td>${flag}${a.isAllDay ? "All day" : new Date(a.startAt).toLocaleTimeString("en-CA", { timeZone: "America/Vancouver", hour: "numeric", minute: "2-digit" })}</td><td>${a.ministry}</td><td><b>${esc(a.city)} - ${esc(a.title)}</b>: ${esc(a.details)}</td><td>${a.rls.map(esc).join("<br>")}</td><td>${a.ministry}-${a.id}</td></tr>`;
        })
        .join("")
    : `<tr><td colspan="5">No Activities for ${esc(fmtDay(day.date))}</td></tr>`;
  return `<section class="day"><h2>${esc(fmtDay(day.date))}</h2><p><b>Events, Speeches &amp; Releases</b></p><table class="events"><thead><tr><th>${esc(head)}</th><th>Lead</th><th>Activity/Details</th><th>RLS</th><th>CC ID#</th></tr></thead><tbody>${body}</tbody></table></section>`;
}

export function eventsDayHtml(size, day) {
  return doc(size, dayTable(day));
}

/** The whole 60-day Look Ahead body: cover, then one day per page (legacy's HQ rule, simplified to always break). */
export function lookAheadHtml(size, title, days) {
  const cover = coverHtml(size, title).replace(/^.*<body>|<\/body>.*$/gs, "");
  return doc(size, `<section>${cover}</section>${days.map(dayTable).join("")}`);
}

export function planningHtml(size, activities) {
  const rows = activities
    .map(
      (a) =>
        `<tr><td>${esc(new Date(a.startAt).toDateString())}<br>${esc(a.schedule)}${a.premierRequested ? `<br><b style="color:#c0504d">Premier Requested: ${esc(a.premierRequested)}</b>` : ""}<br><span style="color:#c0504d">Tags: ${a.tags.map(esc).join(", ")}</span></td><td>${a.isConfidential ? '<b style="color:#c00">Not for Look Ahead</b><br>' : ""}<b>${esc(a.city)} - ${esc(a.title)}</b><br>${esc(a.details)}</td><td>${a.isIssue ? "<b>Issue</b>" : "FYI Only"}<br>${esc(a.significance)}</td><td>${a.ministry}-${a.id}</td></tr>`,
    )
    .join("");
  return doc(
    size,
    `<h1 style="color:#384c70">GCPE Corporate Calendar: Schedule of Activities</h1><table class="planning"><thead><tr><th>Schedule</th><th>Title &amp; Summary</th><th>Significance</th><th>CC ID#</th></tr></thead><tbody>${rows}</tbody></table>`,
  );
}

/** Running text for renderers that don't read CSS margin boxes (pdfmake, DOCX). */
export const RUNNING = {
  firstHeader: "DRAFT ONLY - NOT FOR CIRCULATION / Information is confidential and subject to change",
  header: "Province of BC — DRAFT AND CONFIDENTIAL",
  footerLeft: UPDATED,
};
```

- [ ] **Step 4: The renderers**

`spikes/report-rendering/render-chromium.mjs`:

```js
import puppeteer from "puppeteer-core";

/** Launches Chromium over a pipe (no WebSocket: SiteGround's runtime blocks loopback). */
export async function launch(host) {
  if (host.startsWith("siteground")) {
    const chromium = (await import("@sparticuz/chromium")).default;
    return puppeteer.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true, pipe: true });
  }
  if (!process.env.CHROMIUM_PATH) throw new Error("set CHROMIUM_PATH to a local chrome-headless-shell");
  return puppeteer.launch({ executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"], headless: true, pipe: true });
}

/** One HTML document → PDF, honouring @page size and margin boxes. */
export async function renderPdf(browser, html) {
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    return Buffer.from(await page.pdf({ preferCSSPageSize: true, printBackground: true }));
  } finally {
    await page.close();
  }
}
```

`spikes/report-rendering/render-pdfmake.mjs`:

```js
import { JSDOM } from "jsdom";
import htmlToPdfmake from "html-to-pdfmake";
import PdfPrinter from "pdfmake";
import { PAGE, RUNNING } from "./templates.mjs";

// pdfkit's standard 14 fonts: no font files to ship (the same reason NRMS's PDFs use pdf-lib's).
const printer = new PdfPrinter({ Helvetica: { normal: "Helvetica", bold: "Helvetica-Bold", italics: "Helvetica-Oblique", bolditalics: "Helvetica-BoldOblique" } });

/** The same HTML, without a browser: html-to-pdfmake's DOM walk, pdfmake's layout. */
export async function renderPdfmake(html, size) {
  const { window } = new JSDOM("");
  const body = html.replace(/^.*<body>|<\/body>.*$/gs, "").replace(/<img[^>]*>/g, ""); // SVG data URIs are out of scope for this path
  const content = htmlToPdfmake(body, { window, tableAutoSize: true });
  const docDef = {
    ...PAGE[size].pdfmake,
    pageMargins: [36, 60, 36, 50],
    defaultStyle: { font: "Helvetica", fontSize: 9 },
    header: (current) => ({ text: current === 1 ? RUNNING.firstHeader : RUNNING.header, alignment: "right", margin: [36, 20, 36, 0], fontSize: 8 }),
    footer: (current, total) => ({ columns: [{ text: RUNNING.footerLeft, fontSize: 8 }, { text: `Page ${current} of ${total}`, alignment: "right", fontSize: 8 }], margin: [36, 10, 36, 0] }),
    content,
  };
  const pdf = printer.createPdfKitDocument(docDef);
  const chunks = [];
  return new Promise((resolve, reject) => {
    pdf.on("data", (c) => chunks.push(c));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
    pdf.end();
  });
}
```

`spikes/report-rendering/render-docx.mjs`:

```js
import HTMLtoDOCX from "@turbodocx/html-to-docx";
import { PAGE, RUNNING } from "./templates.mjs";

/** The same HTML → DOCX. The footer carries {PAGE}/{NUMPAGES} markers for patch-docx.mjs. */
export async function renderDocx(html, size) {
  const body = html.replace(/^.*<body>|<\/body>.*$/gs, "");
  const buf = await HTMLtoDOCX(
    body,
    `<p style="text-align:right">${RUNNING.header}</p>`,
    { ...PAGE[size].docx, header: true, footer: true, pageNumber: false, margins: { top: 1296, bottom: 1152, left: 720, right: 720, header: 576, footer: 576 } },
    `<p>${RUNNING.footerLeft} — Page {PAGE} of {NUMPAGES}</p>`,
  );
  return Buffer.from(buf);
}
```

`spikes/report-rendering/patch-docx.mjs`:

```js
import JSZip from "jszip";
import { RUNNING } from "./templates.mjs";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const field = (code) => `</w:t></w:r><w:fldSimple w:instr=" ${code} "><w:r><w:t>1</w:t></w:r></w:fldSimple><w:r><w:t xml:space="preserve">`;
const escXml = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

/**
 * The measured fallback for Word's running text: turns {PAGE}/{NUMPAGES} into real fields, and
 * adds a different first-page header (w:titlePg plus a "first" header part), in schema order.
 */
export async function patchDocx(buf) {
  const zip = await JSZip.loadAsync(buf);
  for (const name of Object.keys(zip.files).filter((n) => /^word\/footer\d*\.xml$/.test(n))) {
    const xml = await zip.file(name).async("string");
    zip.file(name, xml.replaceAll("{PAGE}", field("PAGE")).replaceAll("{NUMPAGES}", field("NUMPAGES")));
  }
  zip.file("word/header-first.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="${W}"><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t>${escXml(RUNNING.firstHeader)}</w:t></w:r></w:p></w:hdr>`);
  const rels = await zip.file("word/_rels/document.xml.rels").async("string");
  zip.file("word/_rels/document.xml.rels", rels.replace("</Relationships>", `<Relationship Id="rIdSpikeFirstHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header-first.xml"/></Relationships>`));
  const types = await zip.file("[Content_Types].xml").async("string");
  zip.file("[Content_Types].xml", types.replace("</Types>", `<Override PartName="/word/header-first.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>`));
  let docXml = await zip.file("word/document.xml").async("string");
  // headerReference comes first in CT_SectPr; titlePg comes after pgMar/cols and before docGrid.
  docXml = docXml.replace(/<w:sectPr([^>]*)>/, `<w:sectPr$1><w:headerReference w:type="first" r:id="rIdSpikeFirstHeader"/>`);
  docXml = /<w:docGrid/.test(docXml) ? docXml.replace(/<w:docGrid/, "<w:titlePg/><w:docGrid") : docXml.replace("</w:sectPr>", "<w:titlePg/></w:sectPr>");
  zip.file("word/document.xml", docXml);
  return zip.generateAsync({ type: "nodebuffer" });
}
```

If `document.xml` doesn't declare the `r:` namespace on its root, add `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"` to the root element in the same replace; record in the report whether that was needed.

- [ ] **Step 5: Measurement**

`spikes/report-rendering/measure.mjs`:

```js
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";

/** Peak resident memory of a process tree we can see: this process, and a child Chromium by pid (Linux /proc). */
function childPeakMb(pid) {
  try {
    const m = /VmHWM:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch {
    return null; // macOS: no /proc; the report notes `ps -o rss` sampled by hand instead
  }
}

export async function measure(label, fn, { chromiumPid = null } = {}) {
  global.gc?.();
  const t0 = performance.now();
  const out = await fn();
  const ms = Math.round(performance.now() - t0);
  const pages = out.kind === "pdf" ? (await PDFDocument.load(out.bytes)).getPageCount() : null;
  return {
    label,
    ms,
    bytes: out.bytes.length,
    pages,
    nodePeakMb: Math.round(process.resourceUsage().maxRSS / 1024),
    chromiumPeakMb: chromiumPid ? childPeakMb(chromiumPid) : null,
  };
}
```

`spikes/report-rendering/run-all.mjs`:

```js
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lookAheadDays, makeFixture } from "./fixture.mjs";
import { coverHtml, eventsDayHtml, lookAheadHtml, planningHtml } from "./templates.mjs";
import { launch, renderPdf } from "./render-chromium.mjs";
import { renderPdfmake } from "./render-pdfmake.mjs";
import { renderDocx } from "./render-docx.mjs";
import { patchDocx } from "./patch-docx.mjs";
import { measure } from "./measure.mjs";

/** Renders every sample with every approach at both page sizes, writes outputs and a results JSON. */
export async function runAll({ host, outDir, repeat = 5, only = null }) {
  mkdirSync(outDir, { recursive: true });
  const activities = makeFixture();
  const days = lookAheadDays(activities, { days: 60 });
  const busiest = days.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
  const title = "Monday, Nov. 2, 2026 to Thursday, Dec. 31, 2026";
  const samples = {
    cover: (size) => coverHtml(size, title),
    "events-day": (size) => eventsDayHtml(size, busiest),
    planning: (size) => planningHtml(size, activities.slice(0, 40)),
    "look-ahead-60": (size) => lookAheadHtml(size, title, days),
  };
  const results = { host, node: process.version, fixture: { activities: activities.length, lookAheadRows: days.reduce((n, d) => n + d.rows.length, 0) }, runs: [] };

  const t0 = performance.now();
  const browser = await launch(host).catch((e) => ({ error: String(e?.message ?? e) }));
  results.chromiumLaunchMs = Math.round(performance.now() - t0);
  if (browser.error) results.chromiumError = browser.error;
  else results.chromiumVersion = await browser.version();
  const chromiumPid = browser.process?.()?.pid ?? null;

  for (const [name, make] of Object.entries(samples)) {
    if (only && !only.includes(name)) continue;
    for (const size of ["letter", "legal"]) {
      if (name === "planning" && size === "letter") continue; // Planning is Legal landscape only (§10.5)
      if (name !== "planning" && size === "legal" && name !== "events-day") continue; // the Look Ahead is Letter; one Legal Events table proves the size
      const html = make(size);
      const approaches = {
        "pdf-chromium": browser.error ? null : async () => ({ kind: "pdf", bytes: await renderPdf(browser, html) }),
        "pdf-pdfmake": async () => ({ kind: "pdf", bytes: await renderPdfmake(html, size) }),
        "docx-turbodocx": async () => ({ kind: "docx", bytes: await renderDocx(html, size) }),
        "docx-patched": async () => ({ kind: "docx", bytes: await patchDocx(await renderDocx(html, size)) }),
      };
      for (const [approach, fn] of Object.entries(approaches)) {
        if (!fn) continue;
        const runs = [];
        for (let i = 0; i < repeat + 1; i++) {
          let last;
          const r = await measure(`${name}/${size}/${approach}`, async () => (last = await fn()), { chromiumPid }).catch((e) => ({ label: `${name}/${size}/${approach}`, error: String(e?.message ?? e) }));
          runs.push(r);
          if (i === 0 && last) writeFileSync(join(outDir, `${name}.${size}.${approach}.${last.kind}`), last.bytes);
          if (r.error) break;
        }
        const timed = runs.slice(1).filter((r) => !r.error).map((r) => r.ms).sort((a, b) => a - b);
        results.runs.push({ sample: name, size, approach, first: runs[0], medianMs: timed.length ? timed[Math.floor(timed.length / 2)] : null, error: runs.find((r) => r.error)?.error ?? null });
      }
    }
  }
  if (!browser.error) await browser.close();
  writeFileSync(join(outDir, `results.${host}.json`), JSON.stringify(results, null, 2));
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const host = process.argv[2] ?? "local";
  const r = await runAll({ host, outDir: join(process.cwd(), "out", host) });
  console.log(JSON.stringify(r, null, 2));
}
```

- [ ] **Step 6: The fidelity checker (the spike's test)**

`spikes/report-rendering/check.mjs` (runs locally on any host's outputs; needs `pdftotext`/`pdfinfo` from poppler and `unzip`):

```js
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";

const SIZES = { letter: [612, 792], legal: [1008, 612] };
const failures = [];
const pass = [];
const expect = (ok, what) => (ok ? pass : failures).push(what);

async function checkPdf(file, size) {
  const bytes = readFileSync(file);
  const pdf = await PDFDocument.load(bytes);
  const n = pdf.getPageCount();
  const { width, height } = pdf.getPage(0).getSize();
  expect(Math.round(width) === SIZES[size][0] && Math.round(height) === SIZES[size][1], `${file}: page size ${Math.round(width)}×${Math.round(height)}`);
  const text = (p) => execFileSync("pdftotext", ["-f", String(p), "-l", String(p), "-layout", file, "-"], { encoding: "utf8" });
  for (let p = 1; p <= n; p++) expect(text(p).includes(`Page ${p} of ${n}`), `${file}: "Page ${p} of ${n}" on page ${p}`);
  if (n > 1) {
    expect(text(1).includes("DRAFT ONLY - NOT FOR CIRCULATION"), `${file}: page-1 header`);
    expect(!text(2).includes("DRAFT ONLY - NOT FOR CIRCULATION") && text(2).includes("DRAFT AND CONFIDENTIAL"), `${file}: later-page header differs`);
  }
  if (file.includes("look-ahead-60")) {
    // Forced page breaks: each later page starts with a day heading.
    const starts = Array.from({ length: Math.min(n, 8) - 1 }, (_, i) => text(i + 2).trim().split("\n")[1] ?? "");
    expect(starts.every((l) => /day, [A-Z][a-z]+ \d+, 2026/.test(l)), `${file}: a forced break before each day`);
  }
}

async function checkDocx(file, size) {
  const zip = await JSZip.loadAsync(readFileSync(file));
  const doc = await zip.file("word/document.xml").async("string");
  const [w, h] = size === "letter" ? [12240, 15840] : [20160, 12240];
  expect(new RegExp(`<w:pgSz[^>]*w:w="${w}"[^>]*w:h="${h}"`).test(doc), `${file}: page size ${w}×${h} twips`);
  if (size === "legal") expect(/w:orient="landscape"/.test(doc), `${file}: landscape`);
  const footers = await Promise.all(Object.keys(zip.files).filter((n) => /^word\/footer\d*\.xml$/.test(n)).map((n) => zip.file(n).async("string")));
  expect(footers.some((f) => /PAGE/.test(f) && /NUMPAGES/.test(f)), `${file}: "Page X of Y" fields in the footer`);
  expect(/<w:titlePg\/>/.test(doc) && /w:type="first"/.test(doc), `${file}: a different first-page header`);
  expect(/w:fill="558ABD"|w:fill="558abd"|w:fill="384C70"|w:fill="384c70"/.test(doc), `${file}: coloured header cells`);
  expect(/w:fill="F2F2F2"|w:fill="f2f2f2"/.test(doc), `${file}: alternating row shading`);
  if (file.includes("look-ahead-60")) expect(/<w:br w:type="page"\/>|<w:pageBreakBefore/.test(doc), `${file}: forced page breaks`);
}

const dir = process.argv[2];
for (const f of readdirSync(dir)) {
  const m = /^(.+)\.(letter|legal)\.(.+)\.(pdf|docx)$/.exec(f);
  if (!m) continue;
  if (m[4] === "pdf") await checkPdf(join(dir, f), m[2]);
  else await checkDocx(join(dir, f), m[2]);
}
console.log(JSON.stringify({ pass, failures }, null, 2));
process.exit(failures.length ? 1 : 0);
```

Colours in the PDFs are checked by eye on a `pdftoppm -r 60 -png` render of the Events and Planning samples (record each in the report with the hex read from a colour picker); the automated checks above cover everything else.

Run the local leg:

```bash
cd spikes/report-rendering
CHROMIUM_PATH=… npx -y -p node@24 -- node --expose-gc run-all.mjs local
npx -y -p node@24 -- node check.mjs out/local
```

Expected: `results.local.json` and the outputs in `out/local/`; `check.mjs` prints every pass and failure. A failure is a finding, not a bug to fix in the spike: record it. If Docker is on PATH (E11), also run the same two commands inside `docker run --rm -v "$PWD":/w -w /w node:24-bookworm-slim` with `host` `container` and `@sparticuz/chromium` as the Chromium (it targets Linux x64); otherwise write "container: not measured (no Docker)" in the report.

- [ ] **Step 7: boxs.ca over SSH**

Try `ssh boxs.ca true` (the SSH alias and key used in earlier phases). If SSH is refused, write that in the report and go to Step 8's "no SSH" path.

With SSH:

```bash
ssh boxs.ca 'uname -a; ldd --version | head -1; nproc; grep -E "MemTotal|MemAvailable" /proc/meminfo; ulimit -a; df -h /tmp ~ | tail -2; ls -ld /dev/shm; /usr/local/bin/node-24 --version'
```

Record all of it. Install the spike under `~/gcpe-data/spike` (DATA_DIR survives deploys and is outside the deploy folder):

```bash
rsync -a --delete --exclude node_modules --exclude out spikes/report-rendering/ boxs.ca:gcpe-data/spike/
ssh boxs.ca 'cd ~/gcpe-data/spike && PATH=/usr/local/bin:$PATH npm-24 ci --omit=dev 2>&1 | tail -3 || PATH=/usr/local/bin:$PATH npm ci --omit=dev 2>&1 | tail -3'
```

If no npm runs there, install locally for Linux and copy: `npm ci --omit=dev --os=linux --cpu=x64 --libc=glibc` in a scratch copy, then `rsync` its `node_modules`. Record which worked.

```bash
ssh boxs.ca 'cd ~/gcpe-data/spike && /usr/local/bin/node-24 --expose-gc run-all.mjs siteground-ssh > out-ssh.json 2>&1; tail -c 2000 out-ssh.json'
rsync -a boxs.ca:gcpe-data/spike/out/siteground-ssh/ spikes/report-rendering/out/siteground-ssh/
npx -y -p node@24 -- node spikes/report-rendering/check.mjs spikes/report-rendering/out/siteground-ssh
```

If Chromium fails to launch, record the exact error (missing shared library, sandbox, `/tmp` not executable, process limit) and retry once with `--single-process` added to `chromium.args`; record both.

- [ ] **Step 8: boxs.ca inside the app runtime**

The runtime differs from SSH (E11), so render once from inside the running stack. On the spike branch only, add `apps/stack/src/spike-route.ts`:

```ts
import { Router } from "express";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { requireBearer, requireRole, type BearerOptions } from "@gcpe/auth";
import { safeErrorLabel } from "@gcpe/http-kit";

/** Temporary: runs the report-rendering spike from DATA_DIR inside the app runtime. Core.Admin only. Never merged. */
export function spikeRouter(auth: BearerOptions, dataDir: string): Router {
  const r = Router();
  r.post("/spike/report", requireBearer(auth), requireRole("Core.Admin"), async (req, res) => {
    try {
      const mod = (await import(pathToFileURL(join(dataDir, "spike", "run-all.mjs")).href)) as { runAll(o: object): Promise<unknown> };
      const only = typeof req.query.only === "string" ? req.query.only.split(",") : null;
      res.json(await mod.runAll({ host: "siteground-runtime", outDir: join(dataDir, "spike", "out", "siteground-runtime"), repeat: 3, only }));
    } catch (e) {
      console.error("[stack] spike failed", safeErrorLabel(e));
      res.status(500).json({ error: safeErrorLabel(e) });
    }
  });
  return r;
}
```

and in `stack.ts`, next to the `/stack` errors router: `app.use("/stack", spikeRouter(errorsAuth.bearer, dataDir));`. The dynamic `import()` of an absolute file URL is left alone by esbuild, so puppeteer is resolved from `~/gcpe-data/spike/node_modules` at run time, not bundled.

**No-SSH path:** if Step 7 had no SSH, the spike files can't reach `~/gcpe-data`. Then the route can't run; write in the report that the runtime leg needs either SSH or a second Node.js project in Site Tools (the `deploy/siteground-probe` precedent), and that it is for Paul to choose. Skip to Step 9.

Deploy the spike artifact (Paul authorised test-environment deploys), measure, then restore:

```bash
npx -y -p node@24 -- npm run deploy:siteground   # from the spike branch, clean tree
git push --force origin deploy/siteground:deploy/siteground
TOKEN=…  # a short-lived local Core.Admin token minted on the server from .env-local's LOCAL_AUTH_SECRET, as in earlier phases; never printed
curl -s -X POST -H "authorization: Bearer $TOKEN" "https://boxs.ca/stack/spike/report?only=events-day" > runtime-1.json
curl -s -X POST -H "authorization: Bearer $TOKEN" "https://boxs.ca/stack/spike/report?only=look-ahead-60" > runtime-2.json
rsync -a boxs.ca:gcpe-data/spike/out/siteground-runtime/ spikes/report-rendering/out/siteground-runtime/
npx -y -p node@24 -- node spikes/report-rendering/check.mjs spikes/report-rendering/out/siteground-runtime
git switch feat/phase-5b && npx -y -p node@24 -- npm run deploy:siteground && git push --force origin deploy/siteground:deploy/siteground
curl -s https://boxs.ca/stack/health
ssh boxs.ca 'rm -rf ~/gcpe-data/spike'
```

Split the run with `?only=` so no single request outlives SiteGround's proxy timeout; if a request still times out, record the time at which it did (that is itself the measurement: the report can't be built inside one request on this host). Note the process's `startedAt` from `/stack/health` before and after each call: a change means the runtime killed the process (memory), which the report must say.

- [ ] **Step 9: Write the report**

Back on `feat/phase-5b`, create `docs/superpowers/plans/2026-10-08-phase-5b-report-rendering-spike.md` with these sections, every cell filled from `results.*.json` and `check.mjs` output (copy numbers, don't round beyond whole ms and MB):

```markdown
# Phase 5b report-rendering spike (spec addendum §10.1)

**Spike branch:** `spike/5b-report-rendering` at `<sha>` (never merged). **Run on:** <date>.

## Answer
<One paragraph: which approach for PDF and which for Word, on which hosts; whether anything goes to Paul before 5g (spec §10.1: "If either format fails on either host, the measured alternatives go to Paul").>

## Candidates
| Approach | Packages (version, licence, checked <date>) | Needs a browser |
|---|---|---|
| PDF: Chromium print | puppeteer-core …, @sparticuz/chromium … / local chrome-headless-shell … | yes |
| PDF: pdfmake from the same HTML | pdfmake …, html-to-pdfmake …, jsdom … | no |
| Word: HTML→DOCX | @turbodocx/html-to-docx … | no |
| Word: HTML→DOCX + post-processing | … + jszip … | no |

## Hosts
| Host | OS / glibc | CPUs | Memory | Node | Chromium | Notes (sandbox, /tmp, /dev/shm, limits) |
|---|---|---|---|---|---|---|
| local (macOS) | | | | | | |
| container (node:24-bookworm-slim) | | | | | | or "not measured" |
| boxs.ca SSH | | | | | | |
| boxs.ca runtime | | | | | | or why not measured |

## Measurements
One row per sample × size × approach × host: first run ms (includes warm-up), median ms of the rest, Node peak MB, Chromium peak MB, bytes, pages, error.
Plus: Chromium launch ms per host. The 60-day Look Ahead from the 1,106-activity fixture (<rows> rows across 60 days) gets its own table.

## Fidelity
| Requirement (§10.1) | PDF Chromium | PDF pdfmake | DOCX | DOCX patched |
|---|---|---|---|---|
| Letter portrait | | | | |
| Legal landscape (35.56 × 21.59 cm) | | | | |
| Page-1 header differs from later pages | | | | |
| "Page X of Y" | | | | |
| Coloured header cells (#558abd, #384c70) | | | | |
| Alternating row shading | | | | |
| Forced page breaks | | | | |
Each cell ✓ or ✗ with the check.mjs line, per host where they differ. The three §10.1 assumptions ("Chromium runs on SiteGround's Node hosting", "Chromium honours @page :first margins and a different first-page header", "the DOCX converter supports running headers and footers with Page X of Y") each get a Verified / Refuted line with its evidence.

## Recommendation for 5g
<Approach per format; the rendering seam 5g should build (for example a `renderReport(html, format, size)` module behind one interface, so a host without Chromium can use the fallback); memory and time limits to set; anything Paul must decide.>

## Risks and what wasn't checked
<For example: Word itself not used to open the DOCX (checked structurally and in <viewer>); the container leg; proxy timeouts on boxs.ca; Chromium's size in the artifact.>

## Reproduce
<The commands from Steps 6–8.>
```

- [ ] **Step 10: Check the report and commit**

The report is complete when: `grep -nE "<[a-z][^>]*>|TBD|TODO" docs/superpowers/plans/2026-10-08-phase-5b-report-rendering-spike.md` prints nothing (no unfilled angle-bracket slots), every Fidelity cell holds ✓ or ✗, and each of the four hosts has a row (measured, or the reason it wasn't). Then:

```bash
git add docs/superpowers/plans/2026-10-08-phase-5b-report-rendering-spike.md
git commit -m "docs: report-rendering spike (spec addendum §10.1): measured PDF and Word on local and boxs.ca"
```

Push the spike branch so the report's SHA resolves: `git push origin spike/5b-report-rendering`.

---

### Task 6: Parity lists, runbook, running notes, carry-forward, deploy and hand checks

Covers the 5b exit check ("Lookup admin end to end on boxs.ca. Event contract tests. A spike report …"), §14/§15 rows, running notes.

**Files:**
- Modify: `docs/parity/changes-from-legacy.md`, `docs/parity/open-questions.md`, `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`, `docs/superpowers/plans/phase-5-carry-forward.md`.

**Interfaces:** docs only.

- [ ] **Step 1: Parity rows**

`docs/parity/changes-from-legacy.md`, "Corporate Calendar (Phase 5)":

```markdown
| C165 | The user list showed one comm-contact rank per user, from the first active comm contact found, whatever the ministry (`Admin/UserList.aspx.cs:27-34`). | Each user × ministry row shows that ministry's rank. | A user who is a contact in two ministries at different ranks shows both correctly. | Proposed |
| C166 | Any admin-page user could deactivate any user, including themself and a SysAdmin. | A Calendar Administrator deactivates, reactivates or links only Calendar-only users (no NRMS, NoD or Core role), only where they could change that user's Calendar access, and never themself; a Core admin can for anyone else (Q55). | One account per person across every app; a Calendar admin shouldn't cut off someone's NRMS access. | Agreed (Q55) |
```

`docs/parity/open-questions.md`: Q55's answer gets "Built in 5b-2: `PUT /core/api/calendar-access/:id/active`, `POST /core/api/calendar-access/:id/link`." If the spike sends anything to Paul (Task 5's "Answer"), add it as Q57 with the measured alternatives as its working assumption.

- [ ] **Step 2: Running notes**

Append `## Phase 5b-2 — Calendar users, test users, report spike`:

```markdown
- **Administrator** — Hub → Calendar → Users lists each user once per ministry, as "Name (Abbreviation) (rank)".
  Switches add inactive users (including those imported without an email) and users without Calendar access.
- **Administrator** — On a user's page: contact details (phone and mobile as 12 digits and hyphens, like
  250-555-0100), the comm-contact rank for each of their ministries, their Calendar role and ministries,
  and their account. Role, ministries and account changes reach the Calendar within a minute.
- **Administrator** — A Calendar Administrator can deactivate, reactivate or link only people whose only
  access is the Calendar. Anyone who also uses NRMS or NoD is a Core admin's to change.
- **Administrator** — Set a comm-contact rank only after the person's ministry is saved; if the Calendar
  says the ministry isn't theirs yet, wait a minute and try again.
- **Operations** — `scripts/siteground-seed-users.sh` now also seeds five Calendar test users
  (cal-admin, cal-sysadmin, cal-hq-admin, cal-editor, cal-readonly @example.test) and gives them Calendar
  access; run it after the public-API seed so their organizations exist.
- **Developer** — The report-rendering spike's code is on `spike/5b-report-rendering`, never merged; its
  findings are in `docs/superpowers/plans/2026-10-08-phase-5b-report-rendering-spike.md`.
```

- [ ] **Step 3: Runbook**

`docs/deploy/siteground.md`, under "Corporate Calendar": a `### Calendar users (Phase 5b-2)` subsection: no migration; re-run `scripts/siteground-seed-users.sh https://boxs.ca` (interactive, Paul) to add the five Calendar test users; hand checks:
- as cal-admin: Hub → Calendar → Users lists "Test Calendar Editor (HLTH)"; open it, save a phone number, set rank PAO for Health;
- deactivate a fresh Calendar-only user, then reactivate them;
- try to deactivate "Test Editor" (an NRMS user): refused with the Core-admin message;
- as cal-hq-admin: open an HQ user and change their rank (allowed); as cal-admin, deactivating cal-hq-admin is refused (HQ user).

- [ ] **Step 4: Carry-forward**

In `docs/superpowers/plans/phase-5-carry-forward.md`, delete the § 5b items "Calendar users screen (§8.5)" and "Calendar test users", and the § 5b heading if empty. Under § 5g, add: "**Report rendering:** build on the spike's recommendation (`docs/superpowers/plans/2026-10-08-phase-5b-report-rendering-spike.md`); its 'Risks and what wasn't checked' list is 5g's to close." If the spike sent a question to Paul, add "Wait for Q57's answer before planning 5g."

- [ ] **Step 5: Final verification**

Run, under Node 24: the whole Vitest suite, both `tsc` commands, `npm run test:e2e`. Then:
- `git diff <5b-1's last commit> | grep -oE "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+" | sort -u`: only `example.test`, `x.invalid`, `example.com`, `example.gov.bc.ca`, or addresses already present.
- `git diff <5b-1's last commit> -- apps packages scripts | grep -nE "Task [0-9]|\bE[0-9]+\b|\bR[0-9]+\b|fix round"` prints nothing.
- `git branch --contains $(git rev-parse spike/5b-report-rendering) | grep -c feat/phase-5b` prints `0` (the spike is not merged).

- [ ] **Step 6: Commit**

```bash
git add docs
git commit -m "docs: parity C165 C166, Q55 built; runbook, running notes and carry-forward for 5b-2"
```

- [ ] **Step 7: Deploy and hand checks**

Deploy `feat/phase-5b` to boxs.ca (`npm run deploy:siteground`, then the printed push), check `/stack/health`, and do the 5b exit hand checks that don't need Paul: the lookup checks from 5b-1's runbook and Step 3's user checks, as a test user created through Core's API with a minted local token (the seeding script is interactive and is Paul's). If the Calendar's database still doesn't exist on boxs.ca, leave Paul the one Site Tools step (5b-1 D11) and mark the boxs.ca half of the exit check as waiting on it.

---

## Risks and things to watch

- **SSH to boxs.ca may be refused** (it was during Phase 4: "SSH to boxs.ca currently refused (key not loaded)", project memory). Then the SSH leg and the runtime leg (which installs the spike under `~/gcpe-data`) can't run, and the report says which host facts are missing and offers Paul the two ways to get them (load the key, or a probe project). The local and container legs still run.
- **`@sparticuz/chromium` targets Amazon Linux 2023's glibc.** *Assumed* SiteGround's glibc is new enough; Step 7 records `ldd --version`. If it isn't, Chromium won't start there and pdfmake is the measured alternative.
- **SiteGround's proxy timeout on a long request** (the runtime leg renders a 60-day report inside one HTTP request). *Not known*; Step 8 splits the run and records any timeout as a finding, which also shapes 5g (render in the background and email or store the file, rather than stream it).
- **The DOCX converter's first-page header and NUMPAGES.** Its README documents `headerType: "first"` and `pageNumber` (PAGE only, as far as the README shows); "Page X of Y" is *assumed* missing until Step 6 proves otherwise, which is why the post-processor exists.
- **The Q55 race test relies on `pg_stat_activity` showing the blocked request** (the same technique as NoD's `waitForLockWaiter`). If the request didn't reach the lock within 5 s the test fails loudly rather than passing by luck.

## Self-review (done while writing)

- **Spec coverage (5b, second half):**
  - §8.5 user list: Task 2 (`listCalendarUsers`), Task 3 (`CalendarUsersScreen`), inactive and no-email users under a switch (E6).
  - §8.5 user page: profile (Task 2/3), role and ministries through Core (Task 3, reusing 5a's editor), per-ministry rank (Task 2/3), Link (Tasks 1, 3), active (Tasks 1, 3; Q55). Deactivation preview and Transfer deferred to 5c (E7; 5b-1 wrote them into the carry-forward). "Verify" not built (C155, unchanged).
  - §10.1: Task 5, both formats, both page sizes, both hosts (plus the container stand-in when possible), the three samples, every listed fidelity point, the 60-day timing from 1,106 activities, the three assumptions marked Verified or Refuted, and the "measured alternatives go to Paul" rule.
  - Carry-forward § 5b remainder: the users screen (Tasks 1–3) and Calendar test users (Task 4).
  - Exit check: "spike report recorded in the plan folder" (Task 5); "lookup admin end to end on boxs.ca" and "event contract tests" are 5b-1's, rechecked in Task 6 Step 7.
- **Placeholders:** the report template in Task 5 Step 9 has `<…>` slots by design: they are what the spike fills, and Step 10's grep refuses the report while any remains. Two steps describe mechanical edits by rule (Task 4 Step 3's loop restructure; Task 3 Step 1's pure move), each saying exactly what changes.
- **Type consistency:** `CalendarActor` (Core, `{ id, roles }`) is what `calendarAdminGuard` takes; `UserGuard` matches the hook in `updateUser`/`linkUser`. `CalendarUserRow`, `CalendarUserDetail`, `Profile` match between `apps/calendar/src/users.ts` and staff-web's `types.ts`. `RANK_OPTIONS` values "1"–"6" map to `rankSchema`'s 1–6. `AccessEditor`, `Actor`, `actorFor` are exported from one file and used by both screens.
- **Review Focus:** each line names its pinning test, and each test is in its task's code.
