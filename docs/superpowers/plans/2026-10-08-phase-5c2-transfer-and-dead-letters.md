# Phase 5c-2: Transfer, the Deactivation Preview and the Calendar Dead-Letter Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Calendar Administrators get three things. **Transfer** moves every open-or-past, non-deleted activity from one comm contact to another: preview the count, confirm, and get a history entry per activity (C150). The **user page** lists a user's open activities before they are deactivated, as legacy's user page did. System Administrators get a **dead-letter page** for the Calendar's undelivered `activity.*` events, with a retry.

**Architecture:**
- **Server (`apps/calendar`).** Three small services on 5c-1's write path:
  - `transfer.ts`: preview and run, in sorted batches of 100, each activity under its own advisory lock, with history and `activity.updated` for each;
  - `users.ts`'s `openActivitiesOf`, through `visibleSql`;
  - `dead-letters.ts`, over the Calendar's own `outbox_deliveries`.
- **Routes:** each family sits behind `requireLevel`:
  - `/api/transfer/*` and `/api/users/:id/open-activities` need Administrator;
  - `/api/dead-letters` needs System Administrator.
- **Staff-web.** `/hub/calendar/transfer`, a two-step deactivation on `/hub/calendar/users/:id`, and `/hub/calendar/dead-letters`, each with an axe test. Nav items show by level.
- **End to end:** a Playwright journey (comm contacts → activities → preview on the user page → Transfer → empty preview), and `/hub/calendar` joins the stack-wide axe sweep.

**Tech Stack:** Node 24, TypeScript 5.9 strict, Express 5, Drizzle 0.45, zod 3.25, Vitest 4.1, supertest, React 19 + react-router 7, `@bcgov/design-system-react-components`, axe-core, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-07-calendar-parity-design.md`:
- §5.1 (the dead-letter page);
- §6 (Transfer is Administrator and above; `visible()` limits every reader);
- §7.1 Transfer;
- §7.4 (Transfer is not frozen);
- §7.5 (Transfer bumps versions and ignores locks);
- §8.5 (Users and Transfer, and deactivation listing open activities);
- §14 C150.

The plan also takes these other documents into account:
- The carry-forward `docs/superpowers/plans/phase-5-carry-forward.md`, § 5c-2 as 5c-1 left it.
- The 5c-1 plan `docs/superpowers/plans/2026-10-08-phase-5c-activity-api.md`. Its store, history, events, `visibleSql`, freeze and batching are what this plan uses.
- Legacy `Admin/Transfer.aspx.cs:29-90` and `Admin/User.aspx:183-223`, read for structure only.

**Order:** **5c-1 first**, all of it. Then Tasks 1–6 of this plan in order; Tasks 4 and 5 consume Tasks 1–3's routes.

**Base:**
- **Branch:** `feat/phase-5c` in `/Users/paul/gcpe-news-platform-p5c`, after 5c-1's last commit. Every path is repo-relative.
- **What exists after 5c-1:**
  - `apps/calendar/src/activities/*`, of which this plan uses:
    - from `store.ts`: `lockActivity`, `loadStored` and `factsOf`;
    - from `history.ts`: `writeChange`;
    - from `events.ts`: `emitActivity`;
    - from `bulk.ts`: `BATCH_SIZE`.
  - `visible`/`visibleSql`, `can`, `dbNow`, `wallClock` and `bcMidnight`.
  - `ApiDeps`, `sendActivityError`, and the error classes.
  - `test/helpers.ts` (`TEST_RULES`, `FIXED_NOW`, `createTestApp(db, over)`) and `test/world.ts` (`seedWorld`, `validInput`, `call`, `insertRaw`, `historyOf`, `outboxOf`).
- **Facts this plan relies on:**
  - `userRoutes(db)` takes only the database (`apps/calendar/src/http/user-routes.ts`). This plan widens it to `ApiDeps`.
  - The dispatcher marks a delivery `dead` once its event is 24 hours old and it fails again. `lastError` is `HTTP <status>` or the fetch error's message, never the payload (`packages/events/src/dispatcher.ts:95-135`).
  - The existing `CalendarUserScreen.test.tsx` stub throws on unhandled URLs (`:24-45`).

---

## Decisions made in planning

Each decision says why it was made and what it costs if it is wrong. Task 6 writes the parity rows they create.

- **G1. Who may Transfer what.**
  - **The role:** Administrator and above (§6).
  - **Which contacts:** a non-HQ Administrator may transfer only between comm contacts of their own ministries. HQ Administrators may use any.
  - **Which activities move:** every non-deleted activity of contact A that the caller can see (`visibleSql`), past ones included, as legacy.
  - **What doesn't change:** no needs-review flags, no status and no "last updated" (C150, F14). Each activity's `version` moves, which is how an open editor learns of the change.
  - **The target:** B must be active, and B must differ from A.
  - **Not frozen** (§7.4).
  - **Why:** legacy had no role check at all. The ministry limit stops one ministry's Administrator from emptying another ministry's contact; the visibility limit keeps confidential activities a caller can't see out of their hands.
  - **If wrong:** an HQ Administrator does the cross-ministry move. New row C171 (Proposed).
- **G2. The Transfer screen's lists.**
  - **From:** offers every comm contact the caller may use, inactive ones included, because moving work off a deactivated contact is the common case.
  - **To:** offers active ones only.
  - **Labels:** "Name (ABBR)", as legacy's dropdowns.
  - **Confirming:** the screen shows the count and the new lead ministry before the confirm button.
- **G3. The deactivation preview.**
  - **Which activities:** those whose comm contact is one of the user's *active* comm contacts, as legacy's list was (`User.aspx:183-223`).
  - **"Open":** not deleted, and the end (or the start, when there is no end) is at or after 00:00 BC today. An undated activity counts as open.
  - **Limits:** `visibleSql` only, and at most 500 rows with a `truncated` flag.
  - **No count of hidden ones,** because a count would tell an Administrator that confidential activities exist.
  - **On screen:** the list appears between "Deactivate" and the confirm button, with a link to Transfer.
  - **If wrong:** an Administrator misses activities they can't see anyway. New row C170 (Proposed).
- **G4. The dead-letter page.**
  - **Who:** Calendar System Administrators only. It is operational, and Core admins have no Calendar actor unless they hold a Calendar role.
  - **What it shows:** event type, aggregate, subscriber, attempts, last error and age. It never shows the payload.
  - **Retry:** resets that one delivery to `pending` with its attempts at zero. If the subscriber still fails, the dispatcher marks it dead again at once, because the event is already over 24 hours old. The page says so.
  - **Scope:** the Calendar's own outbox only. No other app has a dead-letter page today; a platform-wide one isn't in Phase 5's scope.
  - **If wrong:** a Core-level page later reads the same table shape.
- **G5. The end-to-end test and the axe sweep.**
  - **Setup:** the e2e creates activities as cal-hq-admin, who is exempt from the freeze, so a run between 16:00 and 17:00 BC behaves like any other. Transfer itself isn't frozen.
  - **The axe sweep:** `/hub/calendar` joins it, closing the carry-forward's "Staff-web follow-up".
- **G6. `userRoutes` takes `ApiDeps`.** The preview needs the rules and the clock. The existing routes use `deps.db`, with no behaviour change.

## Carry-forward items taken

From `docs/superpowers/plans/phase-5-carry-forward.md` § 5c-2 and § "Staff-web follow-up". Task 6 deletes them.

| Item | Where |
|---|---|
| Dead-letter page | Tasks 3 and 5 (G4) |
| Transfer (API and screen) | Tasks 1 and 4 (G1, G2) |
| Deactivation preview | Tasks 2 and 5 (G3) |
| Add `/hub/calendar` to the e2e axe sweep | Task 6 (G5) |

## Global Constraints

- **Worktree and commits:**
  - Work on `feat/phase-5c` in `/Users/paul/gcpe-news-platform-p5c`. Commit locally after each task.
  - **Never add `Co-Authored-By` or any AI attribution** to a commit. Never commit `CLAUDE.md`.
  - **Code comments never carry task, decision, round or ruling labels** ("Task 3", "G1", "fix round 1"). Spec row ids (C150, Q51) are fine.
- **Node 24 for everything** (BC's permanent UTC−7 from 2026-11-01 needs tzdata ≥ 2026b):
  - Tests: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run <paths>`.
  - Type-checks: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json` and `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p apps/staff-web/tsconfig.json`.
  - E2E: `npx -y -p node@24 -- npm run test:e2e`.
  - Show each new test failing before implementing it (a real RED run).
- **Migrations:** drizzle-kit only. This plan adds none.
- **Keys and ids:** Core keys are byte-exact and never case-folded. User ids are compared canonically (trim and lowercase).
- **Access:**
  - Bearer tokens get no Calendar access. The Calendar actor is read per request from the projection; cookie roles are ignored.
  - A not-visible activity never appears in a list and is never counted.
- **Lock order:** advisory lock per activity, then the row `FOR UPDATE`, then re-check, with write and emit in one transaction. Bulk work locks ascending ids in batches of `BATCH_SIZE`.
- **Errors and logs:**
  - No constraint error may reach a 500.
  - Request bodies and queries are strict zod.
  - Logs carry `safeErrorLabel(e)` only. No debug logging.
- **Events:**
  - The News API never gets an `activity.*` route or handler (C127).
  - Confidential activity text never leaves the Calendar, and the dead-letter page never shows a payload.
- **Privacy:** `example.test` addresses, fictional GUIDs and fictional names only. No legacy data is copied.
- **Staff-web patterns (unchanged from 5b):**
  - Calls go through `apiFetch` with same-origin paths.
  - A load failure shows a danger `InlineAlert`.
  - Loads are guarded by a `latest` ref.
  - Each screen calls `useDocumentTitle` with its `h1` text.
  - Messages use `role="status"`, and errors use `role="alert"` beside their control.
  - Each new screen has an axe test.
  - **Browser code never imports `@gcpe/auth`.**
- **Copy:** "comm contact", "Transfer activities", "Undelivered events", and legacy's label form "Name (ABBR)".

## Review Focus

1. **Transfer clicked twice, or two Administrators transferring from the same contact at once.** Each activity moves exactly once: the second run finds it already moved and skips it. The totals add up to the activities that existed, and no activity gets two `transferred` entries. Pinned in Task 1 ("two transfers at once move each activity once").
2. **The preview's count goes stale** because someone adds an activity for contact A between Preview and Transfer. The run moves what is there at run time and reports its own count, which the screen shows. Pinned in Task 1 ("the run moves what is there when it runs, and says how many") and Task 4 ("shows the run's own count").
3. **An activity open in someone's editor when it is transferred.** The transfer goes through, ignoring the lock, and that editor's next save gets 409 "reload". Pinned in Task 1 ("an open editor's next save is 409").
4. **A user page for someone with no comm contact at all,** such as a Read Only user. The deactivation preview is an empty list ("No open activities"), never a 404 or an error, and deactivation proceeds. Pinned in Task 2 ("a user who is nobody's comm contact has none") and Task 5 ("deactivates a user with no open activities").
5. **Retrying a dead delivery whose subscriber is still down.** The retry is accepted, the delivery goes back to dead on the next tick, and the page says the retry failed again rather than silently showing it gone. Pinned in Task 3 ("a retry that fails again is dead again at once") and Task 5 ("says to check the subscriber").

---

## File structure

| File | Responsibility |
|---|---|
| `apps/calendar/src/transfer.ts` (+ `http/transfer-routes.test.ts`) | Contacts list, preview, run |
| `apps/calendar/src/http/transfer-routes.ts` | `/api/transfer/*` |
| `apps/calendar/src/users.ts`, `http/user-routes.ts` (+ `http/open-activities.test.ts`) | `openActivitiesOf`, `GET /api/users/:id/open-activities` |
| `apps/calendar/src/dead-letters.ts`, `http/dead-letter-routes.ts` (+ `http/dead-letter-routes.test.ts`) | List and retry |
| `apps/calendar/src/http/routes.ts` | Mount the three |
| `apps/staff-web/src/screens/calendar/transfer/types.ts`, `TransferScreen.tsx` (+ test) | Transfer screen |
| `apps/staff-web/src/screens/calendar/users/CalendarUserScreen.tsx` (+ test), `users/types.ts` | Two-step deactivation with the preview |
| `apps/staff-web/src/screens/calendar/dead-letters/DeadLettersScreen.tsx` (+ test) | Dead-letter page |
| `apps/staff-web/src/screens/calendar/CalendarSection.tsx`, `CalendarHome.tsx`, `access.ts`, `a11y.test.tsx`, `src/router.tsx` | Nav, routes, axe |
| `tests/e2e/calendar-transfer.spec.ts`, `tests/e2e/axe-sweep.spec.ts` | E2E |
| `docs/parity/*`, `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`, carry-forward | Docs |

---

### Task 1: Transfer: the API

Covers: spec §7.1 Transfer (`Admin/Transfer.aspx.cs:29-90`), §8.5 ("pick comm contact A and comm contact B, preview the count, confirm"), §6, §7.4, §7.5, and C150. Decision G1. Review Focus 1–3.

**Files:**
- Create: `apps/calendar/src/transfer.ts`, `apps/calendar/src/http/transfer-routes.ts`.
- Create: `apps/calendar/src/http/transfer-routes.test.ts`.
- Modify: `apps/calendar/src/http/routes.ts`.

**Interfaces:**
- Consumes: from 5c-1:
  - `lockActivity`, `loadStored` and `factsOf`;
  - `writeChange`, `emitActivity` and `BATCH_SIZE`;
  - `visible`, `visibleSql` and `can.transfer`;
  - `dbNow`, `ApiDeps` and `sendActivityError`;
  - `ActivityForbiddenError`.
- Produces:
  - **Types:**
    - `interface TransferContact { id: number; userId: string; displayName: string; ministryKey: string; ministryAbbreviation: string | null; ministryName: string; isActive: boolean; label: string }`;
    - `class TransferError(message)`, which maps to 422;
    - `class TransferContactNotFoundError`, which maps to 404.
  - **Services:**
    - `transferContacts(db, actor): Promise<TransferContact[]>`;
    - `previewTransfer(deps, actor, fromId, toId): Promise<{ from: TransferContact; to: TransferContact; count: number }>`;
    - `runTransfer(deps, actor, fromId, toId): Promise<{ transferred: number }>`.
  - **Routes:**
    - `GET /api/transfer/comm-contacts`;
    - `GET /api/transfer/preview?from=<id>&to=<id>`;
    - `POST /api/transfer` with `{ from, to }`.

- [ ] **Step 1: Write the failing tests**

`apps/calendar/src/http/transfer-routes.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCalendarTestDb, createTestApp, FIXED_NOW } from "../../test/helpers";
import { call, historyOf, insertRaw, outboxOf, seedWorld, validInput, type World } from "../../test/world";
import { activities, commContacts } from "../db/schema";

describe("Transfer (spec addendum §7.1, C150)", () => {
  let tdb: TestDatabase;
  let w: World;
  let clock = FIXED_NOW;
  let app: ReturnType<typeof createTestApp>;
  let target: number; // an active Health contact other than the editor's
  const preview = (who: keyof World["as"], from: number, to: number) => call(app, "get", `/api/transfer/preview?from=${from}&to=${to}`, w.as[who].cookie);
  const transfer = (who: keyof World["as"], from: number, to: number) => call(app, "post", "/api/transfer", w.as[who].cookie, { from, to });
  // A new Health comm contact for a user who has none there yet (one per user and ministry).
  const fresh = async (userId: string) => (await tdb.db.insert(commContacts).values({ userId, ministryKey: "health", rank: 6 }).returning({ id: commContacts.id }))[0]!.id;

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db, { now: () => clock });
    w = await seedWorld(app, tdb.db);
    target = w.contact.adminHealth;
  });
  afterAll(() => tdb.drop());

  it("lists the contacts an Administrator may use: their ministries' for a ministry Administrator, every one for HQ", async () => {
    const mine = await call(app, "get", "/api/transfer/comm-contacts", w.as.admin.cookie);
    expect(mine.status).toBe(200);
    expect(mine.body.map((c: { ministryKey: string }) => c.ministryKey)).toEqual(expect.arrayContaining(["health"]));
    expect(mine.body.some((c: { ministryKey: string }) => c.ministryKey === "finance")).toBe(false);
    expect(mine.body).toContainEqual(expect.objectContaining({ id: w.contact.editorHealth, label: "Robin Staff (HLTH)", isActive: true }));
    expect(mine.body).toContainEqual(expect.objectContaining({ id: w.contact.retiredHealth, isActive: false }));
    const all = await call(app, "get", "/api/transfer/comm-contacts", w.as.hqAdmin.cookie);
    expect(all.body.some((c: { ministryKey: string }) => c.ministryKey === "finance")).toBe(true);
  });

  it("previews and moves every non-deleted activity of A, past ones too; deleted ones stay", async () => {
    const from = w.contact.retiredHealth;
    const live = await insertRaw(tdb.db, { commContactId: from });
    const past = await insertRaw(tdb.db, { commContactId: from, startAt: new Date("2025-01-10T17:00:00Z"), endAt: new Date("2025-01-10T18:00:00Z") });
    const gone = await insertRaw(tdb.db, { commContactId: from, deletedAt: FIXED_NOW });
    const p = await preview("admin", from, target);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ count: 2, from: { id: from }, to: { id: target, ministryName: "Sample Health" } });
    expect((await transfer("admin", from, target)).body).toEqual({ transferred: 2 });
    const rows = await tdb.db.select().from(activities).where(inArray(activities.id, [live, past, gone]));
    expect(rows.find((r) => r.id === live)).toMatchObject({ commContactId: target, contactMinistryKey: "health", version: 2, status: "reviewed", needsReview: [] });
    expect(rows.find((r) => r.id === past)!.commContactId).toBe(target);
    expect(rows.find((r) => r.id === gone)!.commContactId).toBe(from);
  });

  it("writes a transferred entry per activity and queues activity.updated; last updated is untouched", async () => {
    const a = await insertRaw(tdb.db, { commContactId: w.contact.retiredHealth });
    const before = (await tdb.db.select().from(activities).where(eq(activities.id, a)))[0]!;
    await transfer("admin", w.contact.retiredHealth, target);
    expect((await historyOf(tdb.db, a)).at(-1)).toMatchObject({ action: "transferred", actorName: "Sample Admin", fields: { comm_contact: ["Sample Advanced (HLTH)", "Sample Admin (HLTH)"] } });
    expect((await outboxOf(tdb.db, a)).at(-1)!.type).toBe("activity.updated");
    expect((await tdb.db.select().from(activities).where(eq(activities.id, a)))[0]!.lastUpdatedAt).toEqual(before.lastUpdatedAt);
  });

  it("an HQ Administrator moves activities across ministries; the lead ministry becomes B's (by id, not display text)", async () => {
    const a = await insertRaw(tdb.db, { commContactId: w.contact.editorHealth });
    expect((await transfer("hqAdmin", w.contact.editorHealth, w.contact.financeEditor)).status).toBe(200);
    const [row] = await tdb.db.select().from(activities).where(eq(activities.id, a));
    expect(row).toMatchObject({ commContactId: w.contact.financeEditor, contactMinistryKey: "finance" });
    expect((await historyOf(tdb.db, a)).at(-1)!.fields).toMatchObject({ contact_ministry: ["Sample Health", "Sample Finance"] });
    await transfer("hqAdmin", w.contact.financeEditor, w.contact.editorHealth);
  });

  it("moves only what the caller can see", async () => {
    const hidden = await insertRaw(tdb.db, { commContactId: w.contact.editorHealth, contactMinistryKey: "finance", isConfidential: true });
    const p = await preview("admin", w.contact.editorHealth, target);
    const hq = await preview("hqAdmin", w.contact.editorHealth, target);
    expect(hq.body.count).toBe(p.body.count + 1);
    await transfer("admin", w.contact.editorHealth, target);
    expect((await tdb.db.select().from(activities).where(eq(activities.id, hidden)))[0]!.commContactId).toBe(w.contact.editorHealth);
    await transfer("hqAdmin", target, w.contact.editorHealth);
  });

  it("refuses: below Administrator (403), another ministry's contact for a ministry Administrator (404), an inactive target or A = B (422)", async () => {
    expect((await preview("advanced", w.contact.editorHealth, target)).status).toBe(403);
    expect((await transfer("editor", w.contact.editorHealth, target)).status).toBe(403);
    expect((await preview("admin", w.contact.editorHealth, w.contact.financeEditor)).status).toBe(404);
    expect((await transfer("admin", w.contact.editorHealth, w.contact.retiredHealth)).body).toEqual({ error: "Choose an active comm contact to transfer to" });
    expect((await transfer("admin", target, target)).body).toEqual({ error: "Choose two different comm contacts" });
    expect((await call(app, "post", "/api/transfer", w.as.admin.cookie, { from: 1, to: 2, extra: true })).status).toBe(400);
    expect((await call(app, "get", "/api/transfer/preview?from=abc&to=1", w.as.admin.cookie)).status).toBe(400);
  });

  it("isn't frozen (spec addendum §7.4)", async () => {
    clock = new Date("2026-11-03T23:30:00Z");
    expect((await transfer("admin", w.contact.editorHealth, target)).status).toBe(200);
    clock = FIXED_NOW;
  });

  it("an open editor's next save is 409", async () => {
    const a = (await call(app, "post", "/api/activities", w.as.editor.cookie, validInput(w))).body.activity;
    await call(app, "put", `/api/activities/${a.id}/lock`, w.as.editor.cookie, { tabId: "tab-a" });
    await transfer("admin", w.contact.editorHealth, target);
    const res = await call(app, "put", `/api/activities/${a.id}`, w.as.editor.cookie, { ...a.fields, version: a.version, tabId: "tab-a" });
    expect(res.body).toMatchObject({ code: "version_conflict" });
    await transfer("admin", target, w.contact.editorHealth);
  });

  it("the run moves what is there when it runs, and says how many", async () => {
    const from = await fresh(w.as.readOnly.id);
    await insertRaw(tdb.db, { commContactId: from });
    expect((await preview("admin", from, target)).body.count).toBe(1);
    await insertRaw(tdb.db, { commContactId: from });
    expect((await transfer("admin", from, target)).body).toEqual({ transferred: 2 });
  });

  it("two transfers at once move each activity once; 150 activities cross batches", async () => {
    const from = await fresh(w.as.hqReadOnly.id);
    const ids: number[] = [];
    for (let n = 0; n < 150; n++) ids.push(await insertRaw(tdb.db, { commContactId: from }));
    const [x, y] = await Promise.all([transfer("admin", from, target), transfer("hqAdmin", from, target)]);
    expect(x.body.transferred + y.body.transferred).toBe(150);
    for (const id of ids.slice(0, 3)) expect((await historyOf(tdb.db, id)).filter((h) => h.action === "transferred")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/http/transfer-routes.test.ts`
Expected: FAIL. `/api/transfer/*` is 404.

- [ ] **Step 3: Implement**

`apps/calendar/src/transfer.ts`:

```ts
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import type { CalendarActor } from "./actor";
import { BATCH_SIZE } from "./activities/bulk";
import { ActivityForbiddenError } from "./activities/errors";
import { emitActivity } from "./activities/events";
import { writeChange, type FieldChange } from "./activities/history";
import { factsOf, loadStored, lockActivity } from "./activities/store";
import { can } from "./capabilities";
import { activities, commContacts, orgs, users } from "./db/schema";
import type { ApiDeps } from "./http/routes";
import { dbNow } from "./time";
import { visible, visibleSql } from "./visibility";

export interface TransferContact {
  id: number;
  userId: string;
  displayName: string;
  ministryKey: string;
  ministryAbbreviation: string | null;
  ministryName: string;
  isActive: boolean;
  /** "Name (ABBR)", as legacy's dropdowns (Admin/Transfer.aspx.cs:20-27). */
  label: string;
}

/** HTTP 422. */
export class TransferError extends Error {
  override name = "TransferError";
}
/** HTTP 404: no such contact, or one of a ministry the caller may not transfer for. */
export class TransferContactNotFoundError extends Error {
  override name = "TransferContactNotFoundError";
}

async function allContacts(db: Db): Promise<TransferContact[]> {
  const rows = await db
    .select({ id: commContacts.id, userId: commContacts.userId, ministryKey: commContacts.ministryKey, isActive: commContacts.isActive, displayName: users.displayName, abbreviation: orgs.abbreviation, ministryName: orgs.displayName })
    .from(commContacts)
    .leftJoin(users, eq(users.id, commContacts.userId))
    .leftJoin(orgs, eq(orgs.key, commContacts.ministryKey))
    .orderBy(asc(orgs.abbreviation), asc(users.displayName), asc(commContacts.id));
  return rows.map((r) => {
    const displayName = r.displayName ?? "Unknown user";
    return {
      id: r.id, userId: r.userId, displayName, ministryKey: r.ministryKey, ministryAbbreviation: r.abbreviation, ministryName: r.ministryName ?? r.ministryKey,
      isActive: r.isActive, label: `${displayName} (${r.abbreviation ?? r.ministryKey})`,
    };
  });
}

/** An HQ Administrator may use any contact; anyone else only their own ministries' (C150). */
export async function transferContacts(db: Db, actor: CalendarActor): Promise<TransferContact[]> {
  if (!can.transfer(actor)) throw new ActivityForbiddenError("Administrators transfer activities");
  const all = await allContacts(db);
  return actor.isHq ? all : all.filter((c) => actor.ministryKeys.includes(c.ministryKey));
}

async function pair(db: Db, actor: CalendarActor, fromId: number, toId: number): Promise<{ from: TransferContact; to: TransferContact }> {
  const usable = await transferContacts(db, actor);
  const from = usable.find((c) => c.id === fromId);
  const to = usable.find((c) => c.id === toId);
  if (!from || !to) throw new TransferContactNotFoundError();
  if (from.id === to.id) throw new TransferError("Choose two different comm contacts");
  if (!to.isActive) throw new TransferError("Choose an active comm contact to transfer to");
  return { from, to };
}

const candidates = (db: Db, actor: CalendarActor, fromId: number) =>
  db.select({ id: activities.id }).from(activities).where(and(eq(activities.commContactId, fromId), isNull(activities.deletedAt), visibleSql(actor))).orderBy(asc(activities.id));

export async function previewTransfer(deps: ApiDeps, actor: CalendarActor, fromId: number, toId: number) {
  const { from, to } = await pair(deps.db, actor, fromId, toId);
  return { from, to, count: (await candidates(deps.db, actor, fromId)).length };
}

/**
 * Moves every non-deleted activity of A that the caller can see to B, and sets its lead ministry
 * to B's, by id (legacy parsed the abbreviation out of the dropdown's text). No needs-review flag,
 * status or "last updated" changes, as legacy (C150); each activity's version moves, so an open
 * editor reloads. Not frozen (spec addendum §7.4).
 */
export async function runTransfer(deps: ApiDeps, actor: CalendarActor, fromId: number, toId: number): Promise<{ transferred: number }> {
  const { from, to } = await pair(deps.db, actor, fromId, toId);
  const ids = (await candidates(deps.db, actor, fromId)).map((r) => r.id);
  let transferred = 0;
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    await deps.db.transaction(async (tx) => {
      const now = await dbNow(tx, deps.now);
      for (const id of ids.slice(i, i + BATCH_SIZE)) {
        await lockActivity(tx, id);
        const s = await loadStored(tx, id, { forUpdate: true });
        // Re-check under the lock: a concurrent transfer, save or delete may have got there first.
        if (!s || s.row.deletedAt || s.row.commContactId !== fromId || !visible(actor, factsOf(s))) continue;
        await tx.update(activities).set({ commContactId: to.id, contactMinistryKey: to.ministryKey, version: s.row.version + 1 }).where(eq(activities.id, id));
        const fields: FieldChange[] = [{ key: "comm_contact", old: from.label, new: to.label }];
        if (s.row.contactMinistryKey !== to.ministryKey) {
          const [old] = s.row.contactMinistryKey ? await tx.select({ name: orgs.displayName }).from(orgs).where(eq(orgs.key, s.row.contactMinistryKey)) : [];
          fields.push({ key: "contact_ministry", old: old?.name ?? s.row.contactMinistryKey, new: to.ministryName });
        }
        await writeChange(tx, { activityId: id, actor, action: "transferred", contactMinistryKey: to.ministryKey, at: now, fields });
        await emitActivity(tx, deps, id, "activity.updated");
        transferred++;
      }
    });
  }
  return { transferred };
}
```

`apps/calendar/src/http/transfer-routes.ts`:

```ts
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { requireLevel } from "../actor";
import { previewTransfer, runTransfer, TransferContactNotFoundError, TransferError, transferContacts } from "../transfer";
import { sendActivityError } from "./errors";
import type { ApiDeps } from "./routes";

const id = z.coerce.number().int().positive();
const pairQuery = z.object({ from: id, to: id }).strict();
const pairBody = z.object({ from: z.number().int().positive(), to: z.number().int().positive() }).strict();

const run = (h: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) =>
  h(req, res).catch((e: unknown) => {
    if (e instanceof TransferError) return void res.status(422).json({ error: e.message });
    if (e instanceof TransferContactNotFoundError) return void res.status(404).json({ error: "not found" });
    if (!sendActivityError(e, res)) next(e);
  });

/** Transfer (spec addendum §8.5): Administrator and above, on the server (C140). */
export function transferRoutes(deps: ApiDeps): Router {
  const r = Router();
  r.use("/transfer", requireLevel("Calendar.Administrator"));
  r.get("/transfer/comm-contacts", run(async (req, res) => void res.json(await transferContacts(deps.db, req.calendar!))));
  r.get("/transfer/preview", run(async (req, res) => {
    const q = pairQuery.parse(req.query);
    res.json(await previewTransfer(deps, req.calendar!, q.from, q.to));
  }));
  r.post("/transfer", run(async (req, res) => {
    const b = pairBody.parse(req.body);
    res.json(await runTransfer(deps, req.calendar!, b.from, b.to));
  }));
  return r;
}
```

`apps/calendar/src/http/routes.ts`: `r.use(transferRoutes(deps));`.



- [ ] **Step 4: Run the tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/calendar
git commit -m "feat(calendar): Transfer between comm contacts, server-checked, with history per activity (C150)"
```

---

### Task 2: The deactivation preview: a user's open activities

Covers: spec §8.5 ("Deactivating lists the user's open activities first", `User.aspx:183-223`) and the carry-forward item "Deactivation preview". Decisions G3 and G6. Review Focus 4.

**Files:**
- Modify: `apps/calendar/src/users.ts`, `apps/calendar/src/http/user-routes.ts`, `apps/calendar/src/http/routes.ts`.
- Create: `apps/calendar/src/http/open-activities.test.ts`.

**Interfaces:**
- Consumes: `visibleSql`, `bcMidnight`, `wallClock`, `dbNow`, `ApiDeps`; `CalendarUserNotFoundError` (5b-2).
- Produces:
  - `interface OpenActivity { id: number; reference: string; title: string; startAt: string | null; endAt: string | null; startDate: string | null; endDate: string | null }`, where `reference` is `"ABBR-id"`, legacy's `MIN-Id`;
  - `openActivitiesOf(deps: ApiDeps, actor: Viewer, userId: string, opts?: { limit?: number }): Promise<{ activities: OpenActivity[]; truncated: boolean }>`;
  - `userRoutes(deps: ApiDeps): Router` (was `userRoutes(db)`);
  - `GET /api/users/:id/open-activities`.

- [ ] **Step 1: Write the failing tests**

`apps/calendar/src/http/open-activities.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCalendarTestDb, createTestApp, FIXED_NOW, TEST_RULES } from "../../test/helpers";
import { call, insertRaw, seedWorld, type World } from "../../test/world";
import { openActivitiesOf } from "../users";

describe("a user's open activities, before deactivating (spec addendum §8.5)", () => {
  let tdb: TestDatabase;
  let w: World;
  let app: ReturnType<typeof createTestApp>;
  const open = (who: keyof World["as"], userId: string) => call(app, "get", `/api/users/${userId}/open-activities`, w.as[who].cookie);

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    w = await seedWorld(app, tdb.db);
  });
  afterAll(() => tdb.drop());

  it("lists the open activities of their active comm contacts, in date order", async () => {
    const c = w.contact.editorHealth;
    // FIXED_NOW is 2026-11-03 11:00 BC: "today" starts at 2026-11-03T07:00Z.
    const later = await insertRaw(tdb.db, { commContactId: c, title: "Sample later", startAt: new Date("2026-12-01T17:00:00Z"), endAt: new Date("2026-12-01T18:00:00Z") });
    const today = await insertRaw(tdb.db, { commContactId: c, title: "Sample today", startAt: new Date("2026-11-03T07:00:00Z"), endAt: new Date("2026-11-03T07:30:00Z") });
    const undated = await insertRaw(tdb.db, { commContactId: c, title: "Sample undated", startAt: null, endAt: null });
    await insertRaw(tdb.db, { commContactId: c, title: "Sample yesterday", startAt: new Date("2026-11-02T17:00:00Z"), endAt: new Date("2026-11-02T18:00:00Z") });
    await insertRaw(tdb.db, { commContactId: c, title: "Sample deleted", deletedAt: FIXED_NOW });
    const res = await open("admin", w.as.editor.id);
    expect(res.status).toBe(200);
    expect(res.body.activities.map((a: { id: number }) => a.id)).toEqual([today, later, undated]);
    expect(res.body.activities[0]).toMatchObject({ reference: `HLTH-${today}`, title: "Sample today", startDate: "2026-11-03" });
    expect(res.body.truncated).toBe(false);
  });

  it("only what the Administrator can see, with no count of the rest", async () => {
    await insertRaw(tdb.db, { commContactId: w.contact.financeEditor, contactMinistryKey: "finance", isConfidential: true, title: "Sample hidden" });
    const ministry = await open("admin", w.as.financeEditor.id);
    expect(ministry.body).toEqual({ activities: [], truncated: false });
    const hq = await open("hqAdmin", w.as.financeEditor.id);
    expect(hq.body.activities.map((a: { title: string }) => a.title)).toContain("Sample hidden");
  });

  it("a user who is nobody's comm contact has none; an inactive comm contact's activities aren't theirs", async () => {
    expect((await open("admin", w.as.readOnly.id)).body).toEqual({ activities: [], truncated: false });
    await insertRaw(tdb.db, { commContactId: w.contact.retiredHealth, title: "Sample retired contact's" });
    expect((await open("admin", w.as.advanced.id)).body.activities).toEqual([]);
  });

  it("says when the list is cut short", async () => {
    const actor = { level: 4, isHq: true, ministryKeys: ["gcpe-hq"] };
    const out = await openActivitiesOf({ db: tdb.db, rules: TEST_RULES, subscribers: [], now: () => FIXED_NOW }, actor, w.as.editor.id, { limit: 2 });
    expect(out).toMatchObject({ truncated: true });
    expect(out.activities).toHaveLength(2);
  });

  it("is Administrator-only, and 404 for an unknown user", async () => {
    expect((await open("advanced", w.as.editor.id)).status).toBe(403);
    expect((await open("admin", "00000000-0000-4000-8000-000000009999")).status).toBe(404);
    expect((await open("admin", "not-a-uuid")).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/http/open-activities.test.ts`
Expected: FAIL. `openActivitiesOf` isn't exported, and the route is 404.

- [ ] **Step 3: Implement**

Append to `apps/calendar/src/users.ts`:

```ts
import { asc, eq, gte, isNull, or } from "drizzle-orm";
import type { ApiDeps } from "./http/routes";
import { activities, orgs } from "./db/schema";
import { bcMidnight, dbNow, wallClock } from "./time";
import { visibleSql, type Viewer } from "./visibility";

export interface OpenActivity {
  id: number;
  /** Legacy's MIN-Id. */
  reference: string;
  title: string;
  startAt: string | null;
  endAt: string | null;
  startDate: string | null;
  endDate: string | null;
}

/**
 * What legacy's user page listed before deactivating (User.aspx:183-223): activities whose comm
 * contact is one of the user's active comm contacts, here only those still open (not deleted,
 * ending today or later, or undated) and visible to the Administrator. No count of the rest: it
 * would reveal confidential activities.
 */
export async function openActivitiesOf(deps: ApiDeps, actor: Viewer, userId: string, opts: { limit?: number } = {}): Promise<{ activities: OpenActivity[]; truncated: boolean }> {
  const u = await projectedUser(deps.db, userId);
  const limit = opts.limit ?? 500;
  const now = await dbNow(deps.db, deps.now);
  const today = bcMidnight(wallClock(now, deps.rules.timeZone).date, deps.rules.timeZone);
  const ends = sql`coalesce(${activities.endAt}, ${activities.startAt})`;
  const rows = await deps.db
    .select({ id: activities.id, title: activities.title, startAt: activities.startAt, endAt: activities.endAt, abbreviation: orgs.abbreviation })
    .from(activities)
    .innerJoin(commContacts, eq(commContacts.id, activities.commContactId))
    .leftJoin(orgs, eq(orgs.key, activities.contactMinistryKey))
    .where(and(eq(commContacts.userId, u.id), eq(commContacts.isActive, true), isNull(activities.deletedAt), or(sql`${ends} IS NULL`, gte(ends, today)), visibleSql(actor)))
    .orderBy(sql`${activities.startAt} ASC NULLS LAST`, asc(activities.id))
    .limit(limit + 1);
  const local = (d: Date | null) => (d ? wallClock(d, deps.rules.timeZone).date : null);
  return {
    truncated: rows.length > limit,
    activities: rows.slice(0, limit).map((r) => ({
      id: r.id, reference: `${r.abbreviation ?? "?"}-${r.id}`, title: r.title,
      startAt: r.startAt?.toISOString() ?? null, endAt: r.endAt?.toISOString() ?? null, startDate: local(r.startAt), endDate: local(r.endAt),
    })),
  };
}
```

Merge the imports with the file's existing ones (`and`, `eq` and `sql` are already imported, as is `commContacts`). `gte(ends, today)` compares an `SQL` with a `Date`. If drizzle's typing refuses that, write `sql\`${ends} >= ${today}\``.

`apps/calendar/src/http/user-routes.ts`:
- Change the signature to `userRoutes(deps: ApiDeps)`, and use `deps.db` wherever it used `db`.
- Add, before `r.get("/users/:id", …)`:

```ts
  r.get("/users/:id/open-activities", run(async (req, res) => void res.json(await openActivitiesOf(deps, req.calendar!, req.params.id))));
```

`apps/calendar/src/http/routes.ts`: `r.use(userRoutes(deps));`.

- [ ] **Step 4: Run the tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar`
Expected: PASS, including 5b-2's `user-routes.test.ts` and `users.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add apps/calendar
git commit -m "feat(calendar): a user's open, visible activities, listed before deactivation"
```

---

### Task 3: The dead-letter API

Covers: spec §5.1 ("a dead-letter page") and the carry-forward item "Dead-letter page". Decision G4. Review Focus 5.

**Files:**
- Create: `apps/calendar/src/dead-letters.ts`, `apps/calendar/src/http/dead-letter-routes.ts`.
- Create: `apps/calendar/src/http/dead-letter-routes.test.ts`.
- Modify: `apps/calendar/src/http/routes.ts`.

**Interfaces:**
- Consumes: `outboxEvents`, `outboxDeliveries`, `dispatchOnce` (`@gcpe/events`); `requireLevel`.
- Produces:
  - `interface DeadLetter { eventId: string; subscriber: string; type: string; aggregateId: string; attempts: number; lastError: string | null; createdAt: string; queuedAtBc: string }`;
  - `listDeadLetters(db, timeZone: string, limit?: number): Promise<DeadLetter[]>`, newest first, default 200;
  - `retryDeadLetter(db, eventId, subscriber): Promise<boolean>`;
  - `GET /api/dead-letters` and `POST /api/dead-letters/retry` with `{ eventId, subscriber }`. The retry answers 204, or 404 when the delivery isn't dead.

- [ ] **Step 1: Write the failing tests**

`apps/calendar/src/http/dead-letter-routes.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { dispatchOnce, outboxDeliveries, outboxEvents } from "@gcpe/events";
import { createCalendarTestDb, createTestApp, projectUser, sessionCookie } from "../../test/helpers";
import { call, seedWorld, type World } from "../../test/world";

const SYSADMIN = "00000000-0000-4000-8000-000000000499";
const NRMS = { name: "nrms", url: "http://nrms.invalid/events", secret: "s".repeat(32), types: ["activity.created", "activity.updated", "activity.deleted"] };

describe("the Calendar's undelivered events (spec addendum §5.1)", () => {
  let tdb: TestDatabase;
  let w: World;
  let app: ReturnType<typeof createTestApp>;
  let sysCookie = "";
  const dead = async (status: "dead" | "pending" | "delivered" = "dead") => {
    const id = randomUUID();
    const envelope = { id, type: "activity.updated", version: 1, source: "calendar", aggregateId: "activity:7", sequence: 1, occurredAt: "2026-09-01T00:00:00Z", correlationId: randomUUID(), data: { id: 7, isConfidential: true, isDeleted: false } };
    await tdb.db.insert(outboxEvents).values({ id, type: envelope.type, aggregateId: envelope.aggregateId, sequence: 1, envelope, createdAt: new Date("2026-09-01T00:00:00Z") });
    await tdb.db.insert(outboxDeliveries).values({ eventId: id, subscriber: "nrms", status, attempts: 9, lastError: "HTTP 503" });
    return id;
  };

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    w = await seedWorld(app, tdb.db);
    // seedWorld has no System Administrator.
    await projectUser(app, { id: SYSADMIN, email: "sys@example.test", displayName: "Sample SysAdmin", isActive: true, calendarRole: "Calendar.SysAdmin", organizationKeys: ["health"] });
    sysCookie = await sessionCookie(SYSADMIN);
  });
  afterAll(() => tdb.drop());

  it("lists dead deliveries only, without their payload", async () => {
    const id = await dead();
    await dead("pending");
    await dead("delivered");
    const res = await call(app, "get", "/api/dead-letters", sysCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ eventId: id, subscriber: "nrms", type: "activity.updated", aggregateId: "activity:7", attempts: 9, lastError: "HTTP 503", createdAt: "2026-09-01T00:00:00.000Z", queuedAtBc: "2026-08-31 17:00" }]);
    expect(JSON.stringify(res.body)).not.toContain("isConfidential");
  });

  it("is System Administrator only", async () => {
    expect((await call(app, "get", "/api/dead-letters", w.as.hqAdmin.cookie)).status).toBe(403);
    expect((await call(app, "post", "/api/dead-letters/retry", w.as.admin.cookie, { eventId: randomUUID(), subscriber: "nrms" })).status).toBe(403);
  });

  it("a retry puts the delivery back in the queue, and the next dispatch delivers it", async () => {
    const id = await dead();
    expect((await call(app, "post", "/api/dead-letters/retry", sysCookie, { eventId: id, subscriber: "nrms" })).status).toBe(204);
    const [d] = await tdb.db.select().from(outboxDeliveries).where(and(eq(outboxDeliveries.eventId, id), eq(outboxDeliveries.subscriber, "nrms")));
    expect(d).toMatchObject({ status: "pending", attempts: 0, lastError: null, lockedUntil: null });
    const result = await dispatchOnce({ db: tdb.db, subscribers: [NRMS], fetchImpl: async () => new Response(null, { status: 200 }) });
    expect(result.delivered).toBeGreaterThanOrEqual(1);
  });

  it("a retry that fails again is dead again at once: the event is past the dispatcher's 24 hours", async () => {
    const id = await dead();
    await call(app, "post", "/api/dead-letters/retry", sysCookie, { eventId: id, subscriber: "nrms" });
    await dispatchOnce({ db: tdb.db, subscribers: [NRMS], fetchImpl: async () => new Response(null, { status: 503 }) });
    const list = (await call(app, "get", "/api/dead-letters", sysCookie)).body as { eventId: string; attempts: number }[];
    expect(list.find((l) => l.eventId === id)).toMatchObject({ attempts: 1 });
  });

  it("a retry of a delivery that isn't dead is 404; a malformed body is 400", async () => {
    const pending = await dead("pending");
    expect((await call(app, "post", "/api/dead-letters/retry", sysCookie, { eventId: pending, subscriber: "nrms" })).status).toBe(404);
    expect((await call(app, "post", "/api/dead-letters/retry", sysCookie, { eventId: "nope", subscriber: "nrms" })).status).toBe(400);
  });
});
```

The events are dated 2026-09-01, more than 24 hours before any run of this test, so a failed retry is dead again at once, as it would be in production.

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar/src/http/dead-letter-routes.test.ts`
Expected: FAIL. `/api/dead-letters` is 404.

- [ ] **Step 3: Implement**

`apps/calendar/src/dead-letters.ts`:

```ts
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { outboxDeliveries, outboxEvents } from "@gcpe/events";
import { wallClock } from "./time";

export interface DeadLetter {
  eventId: string;
  subscriber: string;
  type: string;
  aggregateId: string;
  attempts: number;
  /** "HTTP 503" or a network error's own text; never the payload. */
  lastError: string | null;
  createdAt: string;
  /** When it was queued, as "YYYY-MM-DD HH:MM" in the tenant's time zone; a browser's tzdata can be stale. */
  queuedAtBc: string;
}

/** The Calendar's deliveries the dispatcher gave up on (24 hours of retries). The payload is never shown. */
export async function listDeadLetters(db: Db, timeZone: string, limit = 200): Promise<DeadLetter[]> {
  const rows = await db
    .select({ eventId: outboxDeliveries.eventId, subscriber: outboxDeliveries.subscriber, attempts: outboxDeliveries.attempts, lastError: outboxDeliveries.lastError, type: outboxEvents.type, aggregateId: outboxEvents.aggregateId, createdAt: outboxEvents.createdAt })
    .from(outboxDeliveries)
    .innerJoin(outboxEvents, eq(outboxEvents.id, outboxDeliveries.eventId))
    .where(eq(outboxDeliveries.status, "dead"))
    .orderBy(desc(outboxEvents.createdAt))
    .limit(limit);
  return rows.map((r) => {
    const w = wallClock(r.createdAt, timeZone);
    return { ...r, createdAt: r.createdAt.toISOString(), queuedAtBc: `${w.date} ${w.time}` };
  });
}

/**
 * Puts one dead delivery back in the queue: the next dispatch tries it once more. The event is
 * already past the dispatcher's 24 hours, so a failure makes it dead again straight away.
 */
export async function retryDeadLetter(db: Db, eventId: string, subscriber: string): Promise<boolean> {
  const r = await db
    .update(outboxDeliveries)
    .set({ status: "pending", attempts: 0, nextAttemptAt: new Date(0), lockedUntil: null, lastError: null })
    .where(and(eq(outboxDeliveries.eventId, eventId), eq(outboxDeliveries.subscriber, subscriber), eq(outboxDeliveries.status, "dead")));
  return (r.rowCount ?? 0) > 0;
}
```

`nextAttemptAt: new Date(0)` makes the row due on the very next dispatch, whatever clock that dispatch uses.

`apps/calendar/src/http/dead-letter-routes.ts`:

```ts
import { Router } from "express";
import { z, ZodError } from "zod";
import { requireLevel } from "../actor";
import { listDeadLetters, retryDeadLetter } from "../dead-letters";
import type { ApiDeps } from "./routes";

const retrySchema = z.object({ eventId: z.string().uuid(), subscriber: z.string().min(1).max(100) }).strict();

/** The dead-letter page's API (spec addendum §5.1): System Administrators only. */
export function deadLetterRoutes(deps: ApiDeps): Router {
  const r = Router();
  r.use("/dead-letters", requireLevel("Calendar.SysAdmin"));
  r.get("/dead-letters", async (_req, res, next) => {
    try {
      res.json(await listDeadLetters(deps.db, deps.rules.timeZone));
    } catch (e) {
      next(e);
    }
  });
  r.post("/dead-letters/retry", async (req, res, next) => {
    try {
      const b = retrySchema.parse(req.body);
      if (!(await retryDeadLetter(deps.db, b.eventId, b.subscriber))) return void res.status(404).json({ error: "not found" });
      res.status(204).end();
    } catch (e) {
      if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues });
      next(e);
    }
  });
  return r;
}
```

`apps/calendar/src/http/routes.ts`: `r.use(deadLetterRoutes(deps));`.

- [ ] **Step 4: Run the tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/calendar`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/calendar
git commit -m "feat(calendar): dead-letter API for the Calendar's undelivered events, System Administrators only"
```

---

### Task 4: staff-web: the Transfer screen

Covers: spec §8.5 Transfer ("pick comm contact A and comm contact B, preview the count, confirm"). Decision G2. Review Focus 2.

**Files:**
- Create: `apps/staff-web/src/screens/calendar/transfer/types.ts`, `TransferScreen.tsx` (+ `TransferScreen.test.tsx`).
- Modify: `apps/staff-web/src/screens/calendar/CalendarSection.tsx`, `CalendarHome.tsx`, `a11y.test.tsx`, `apps/staff-web/src/router.tsx`.

**Interfaces:**
- Consumes: `GET /calendar/api/transfer/comm-contacts`, `GET /calendar/api/transfer/preview`, `POST /calendar/api/transfer` (Task 1); `apiFetch`, `ApiError`, `messagesOf`, `useDocumentTitle`; `CALENDAR_ADMIN_LEVEL`.
- Produces:
  - `TransferScreen` at `/hub/calendar/transfer`;
  - the types `TransferContact` and `TransferPreview`, which mirror Task 1's shapes.

- [ ] **Step 1: Write the failing tests**

`apps/staff-web/src/screens/calendar/transfer/TransferScreen.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { TransferScreen } from "./TransferScreen";

const CONTACTS = [
  { id: 1, userId: "u1", displayName: "Robin Staff", ministryKey: "health", ministryAbbreviation: "HLTH", ministryName: "Health", isActive: true, label: "Robin Staff (HLTH)" },
  { id: 2, userId: "u2", displayName: "Kim Imported", ministryKey: "health", ministryAbbreviation: "HLTH", ministryName: "Health", isActive: false, label: "Kim Imported (HLTH)" },
  { id: 3, userId: "u3", displayName: "Sam Finance", ministryKey: "finance", ministryAbbreviation: "FIN", ministryName: "Finance", isActive: true, label: "Sam Finance (FIN)" },
];

function stub(calls: { url: string; init?: RequestInit }[], transferred = 3) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "a1", name: "Pat", email: "pat@x.invalid", roles: ["Calendar.Administrator"] }, expiresAt: new Date().toISOString() });
      if (url === "/calendar/api/transfer/comm-contacts") return jsonResponse(200, CONTACTS);
      if (url.startsWith("/calendar/api/transfer/preview")) return jsonResponse(200, { from: CONTACTS[1], to: CONTACTS[2], count: 2 });
      if (url === "/calendar/api/transfer") return jsonResponse(200, { transferred });
      throw new Error(`unhandled: ${url}`);
    }),
  );
}

const renderScreen = () =>
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/calendar/transfer"]}>
        <RequireAuth>
          <Routes>
            <Route path="/calendar/transfer" element={<TransferScreen />} />
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );

describe("TransferScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("offers every contact as From and only active ones as To", async () => {
    stub([]);
    renderScreen();
    await screen.findByRole("heading", { level: 1, name: "Transfer activities" });
    const from = screen.getByLabelText("From comm contact") as HTMLSelectElement;
    const to = screen.getByLabelText("To comm contact") as HTMLSelectElement;
    await waitFor(() => expect([...from.options].map((o) => o.text)).toEqual(["Choose a comm contact", "Robin Staff (HLTH)", "Kim Imported (HLTH) — inactive", "Sam Finance (FIN)"]));
    expect([...to.options].map((o) => o.text)).toEqual(["Choose a comm contact", "Robin Staff (HLTH)", "Sam Finance (FIN)"]);
    await waitFor(() => expect(document.title).toContain("Transfer activities"));
  });

  it("previews the count and the new lead ministry, then transfers and shows the run's own count", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(calls, 3);
    renderScreen();
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("From comm contact"), "2");
    await user.selectOptions(screen.getByLabelText("To comm contact"), "3");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByText("2 activities will move from Kim Imported (HLTH) to Sam Finance (FIN). Their lead ministry becomes Finance.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Transfer 2 activities" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Transferred 3 activities from Kim Imported (HLTH) to Sam Finance (FIN).");
    const post = calls.find((c) => c.url === "/calendar/api/transfer")!;
    expect(JSON.parse(post.init!.body as string)).toEqual({ from: 2, to: 3 });
  });

  it("shows the server's refusal next to the form", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "a1", name: "Pat", email: "pat@x.invalid", roles: ["Calendar.Administrator"] }, expiresAt: new Date().toISOString() });
        if (url === "/calendar/api/transfer/comm-contacts") return jsonResponse(200, CONTACTS);
        return jsonResponse(422, { error: "Choose two different comm contacts" });
      }),
    );
    renderScreen();
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("From comm contact"), "1");
    await user.selectOptions(screen.getByLabelText("To comm contact"), "3");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose two different comm contacts");
  });
});
```

In `apps/staff-web/src/screens/calendar/a11y.test.tsx`:
- add `if (url === "/calendar/api/transfer/comm-contacts") return jsonResponse(200, [{ id: 1, userId: "u1", displayName: "Robin Staff", ministryKey: "health", ministryAbbreviation: "HLTH", ministryName: "Health", isActive: true, label: "Robin Staff (HLTH)" }]);` to `stub()`;
- add `<Route path="transfer" element={<TransferScreen />} />` to `at()`;
- add:

```tsx
  it("Transfer", async () => {
    stub();
    const { container } = render(at("/calendar/transfer"));
    await screen.findByRole("heading", { level: 1, name: "Transfer activities" });
    expect(await seriousViolations(container)).toEqual([]);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/calendar`
Expected: FAIL. `./TransferScreen` can't be resolved.

- [ ] **Step 3: Implement**

`apps/staff-web/src/screens/calendar/transfer/types.ts`:

```ts
/** apps/calendar/src/transfer.ts's TransferContact. */
export interface TransferContact {
  id: number;
  userId: string;
  displayName: string;
  ministryKey: string;
  ministryAbbreviation: string | null;
  ministryName: string;
  isActive: boolean;
  label: string;
}
export interface TransferPreview {
  from: TransferContact;
  to: TransferContact;
  count: number;
}

export const plural = (n: number) => `${n} ${n === 1 ? "activity" : "activities"}`;
```

`apps/staff-web/src/screens/calendar/transfer/TransferScreen.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { Button, InlineAlert } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../../api/client";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { messagesOf } from "../../admin/messages";
import { plural, type TransferContact, type TransferPreview } from "./types";

/** `/hub/calendar/transfer` (spec addendum §8.5): move every activity of one comm contact to another. */
export function TransferScreen(): React.JSX.Element {
  useDocumentTitle("Transfer activities");
  const [contacts, setContacts] = useState<TransferContact[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [preview, setPreview] = useState<TransferPreview | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);

  useEffect(() => {
    const call = ++latest.current;
    apiFetch<TransferContact[]>("/calendar/api/transfer/comm-contacts").then(
      (c) => call === latest.current && setContacts(c),
      () => call === latest.current && setLoadError("Couldn't load comm contacts."),
    );
  }, []);

  const choose = (setter: (v: string) => void) => (e: React.ChangeEvent<HTMLSelectElement>) => {
    setter(e.target.value);
    setPreview(null);
    setStatus(null);
    setErrors([]);
  };
  const doPreview = async () => {
    setBusy(true);
    setErrors([]);
    try {
      setPreview(await apiFetch<TransferPreview>(`/calendar/api/transfer/preview?from=${from}&to=${to}`));
    } catch (caught) {
      setErrors(messagesOf(caught));
    } finally {
      setBusy(false);
    }
  };
  const doTransfer = async () => {
    if (!preview) return;
    setBusy(true);
    setErrors([]);
    try {
      const out = await apiFetch<{ transferred: number }>("/calendar/api/transfer", { method: "POST", body: { from: preview.from.id, to: preview.to.id } });
      setStatus(`Transferred ${plural(out.transferred)} from ${preview.from.label} to ${preview.to.label}.`);
      setPreview(null);
    } catch (caught) {
      setErrors(messagesOf(caught));
    } finally {
      setBusy(false);
    }
  };

  if (loadError) return <InlineAlert variant="danger" role="alert" description={loadError} />;
  return (
    <div>
      <h1>Transfer activities</h1>
      <p>Moves every activity of one comm contact, past ones included, to another, and makes the second contact&rsquo;s ministry the lead ministry. Deleted activities stay where they are.</p>
      {status && <p role="status">{status}</p>}
      {contacts === null ? (
        <p>Loading…</p>
      ) : (
        <form aria-label="Transfer activities" onSubmit={(e) => { e.preventDefault(); void doPreview(); }}>
          <div>
            <label htmlFor="transfer-from">From comm contact</label>
            <select id="transfer-from" value={from} onChange={choose(setFrom)}>
              <option value="">Choose a comm contact</option>
              {contacts.map((c) => (
                <option key={c.id} value={String(c.id)}>{c.isActive ? c.label : `${c.label} — inactive`}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="transfer-to">To comm contact</label>
            <select id="transfer-to" value={to} onChange={choose(setTo)}>
              <option value="">Choose a comm contact</option>
              {contacts.filter((c) => c.isActive).map((c) => (
                <option key={c.id} value={String(c.id)}>{c.label}</option>
              ))}
            </select>
          </div>
          {errors.map((m) => (
            <p role="alert" key={m}>{m}</p>
          ))}
          <Button type="submit" isDisabled={busy || !from || !to}>Preview</Button>
        </form>
      )}
      {preview && (
        <section aria-label="Transfer preview">
          <p>{`${plural(preview.count)} will move from ${preview.from.label} to ${preview.to.label}. Their lead ministry becomes ${preview.to.ministryName}.`}</p>
          <Button onPress={() => void doTransfer()} isDisabled={busy || preview.count === 0}>{`Transfer ${plural(preview.count)}`}</Button>
        </section>
      )}
    </div>
  );
}
```

`CalendarSection.tsx`: after the "Users" nav item, add an item for `me.level >= CALENDAR_ADMIN_LEVEL`: `<NavLink to="/calendar/transfer">Transfer</NavLink>`.

`CalendarHome.tsx`: after the users link, add `<p><Link to="/calendar/transfer">Transfer activities between comm contacts</Link></p>` for the same level.

`router.tsx`: add `{ path: "transfer", element: <TransferScreen /> }` to the `calendar` children, and import `TransferScreen`.

- [ ] **Step 4: Run the tests and the type-check**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/calendar apps/staff-web/src/router.test.tsx`
Expected: PASS.

Run: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p apps/staff-web/tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/staff-web
git commit -m "feat(staff-web): Transfer activities between comm contacts, with a preview"
```

---

### Task 5: staff-web: the deactivation preview and the dead-letter page

Covers: spec §8.5 ("Deactivating lists the user's open activities first") and §5.1 (the dead-letter page). Decisions G3 and G4. Review Focus 4 and 5.

**Files:**
- Modify: `apps/staff-web/src/screens/calendar/users/CalendarUserScreen.tsx` (+ test), `users/types.ts`.
- Create: `apps/staff-web/src/screens/calendar/dead-letters/DeadLettersScreen.tsx` (+ `DeadLettersScreen.test.tsx`).
- Modify: `apps/staff-web/src/screens/calendar/access.ts`, `CalendarSection.tsx`, `a11y.test.tsx`, `apps/staff-web/src/router.tsx`.

**Interfaces:**
- Consumes: `GET /calendar/api/users/:id/open-activities` (Task 2); `GET /calendar/api/dead-letters`, `POST /calendar/api/dead-letters/retry` (Task 3).
- Produces:
  - `OpenActivity` and `OpenActivities` in `users/types.ts`;
  - `CALENDAR_SYSADMIN_LEVEL = 5`;
  - `DeadLettersScreen` at `/hub/calendar/dead-letters`.

- [ ] **Step 1: Write the failing tests**

In `CalendarUserScreen.test.tsx`, add a handler to `stub()` before the final `/calendar/api/users/` 404 line:

```ts
      if (url.endsWith("/open-activities")) return jsonResponse(200, openActivities);
```

where `openActivities` is a module-level `let` that each test sets (default `{ activities: [], truncated: false }`). Then replace the existing deactivate test's click-and-expect with the two-step flow, and add:

```tsx
  it("lists the user's open activities before deactivating, with a way to Transfer them", async () => {
    openActivities = { activities: [{ id: 41, reference: "HLTH-41", title: "Sample launch", startAt: "2026-11-10T17:00:00.000Z", endAt: null, startDate: "2026-11-10", endDate: null }], truncated: false };
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(calls);
    renderAt("u1");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Deactivate Robin Staff" }));
    const preview = await screen.findByRole("region", { name: "Before deactivating Robin Staff" });
    expect(within(preview).getByText("HLTH-41 — Sample launch — 2026-11-10")).toBeInTheDocument();
    expect(within(preview).getByRole("link", { name: "Transfer their activities first" })).toHaveAttribute("href", "/calendar/transfer");
    expect(calls.some((c) => c.url.endsWith("/active"))).toBe(false);
    await user.click(within(preview).getByRole("button", { name: "Deactivate anyway" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/active"))).toBe(true));
  });

  it("deactivates a user with no open activities after saying so; Cancel deactivates nobody", async () => {
    openActivities = { activities: [], truncated: false };
    const calls: { url: string; init?: RequestInit }[] = [];
    stub(calls);
    renderAt("u1");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Deactivate Robin Staff" }));
    const preview = await screen.findByRole("region", { name: "Before deactivating Robin Staff" });
    expect(within(preview).getByText("No open activities.")).toBeInTheDocument();
    await user.click(within(preview).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("region", { name: "Before deactivating Robin Staff" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Deactivate Robin Staff" }));
    await user.click(within(await screen.findByRole("region", { name: "Before deactivating Robin Staff" })).getByRole("button", { name: "Deactivate" }));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/active"))).toHaveLength(1));
  });
```

`apps/staff-web/src/screens/calendar/dead-letters/DeadLettersScreen.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { DeadLettersScreen } from "./DeadLettersScreen";

const ROW = { eventId: "11111111-1111-4111-8111-111111111111", subscriber: "nrms", type: "activity.updated", aggregateId: "activity:7", attempts: 9, lastError: "HTTP 503", createdAt: "2026-09-01T00:00:00.000Z", queuedAtBc: "2026-08-31 17:00" };

function stub(calls: string[], rowsAfterRetry: unknown[]) {
  let retried = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "s1", name: "Sam", email: "sam@x.invalid", roles: ["Calendar.SysAdmin"] }, expiresAt: new Date().toISOString() });
      if (url === "/calendar/api/dead-letters") return jsonResponse(200, retried ? rowsAfterRetry : [ROW]);
      if (url === "/calendar/api/dead-letters/retry") {
        retried = true;
        return new Response(null, { status: 204 });
      }
      throw new Error(`unhandled: ${url}`);
    }),
  );
}

const renderScreen = () =>
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/calendar/dead-letters"]}>
        <RequireAuth>
          <Routes>
            <Route path="/calendar/dead-letters" element={<DeadLettersScreen />} />
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );

describe("DeadLettersScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists undelivered events and retries one", async () => {
    const calls: string[] = [];
    stub(calls, []);
    renderScreen();
    const row = (await screen.findByText("activity:7")).closest("tr")!;
    expect(within(row).getByText("HTTP 503")).toBeInTheDocument();
    await userEvent.setup().click(within(row).getByRole("button", { name: "Retry activity.updated for activity:7" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Queued for delivery again.");
    expect(calls).toContain("POST /calendar/api/dead-letters/retry");
    expect(await screen.findByText("Nothing is waiting: every event was delivered.")).toBeInTheDocument();
  });

  it("says to check the subscriber when a retried event is back on the list", async () => {
    stub([], [ROW]);
    renderScreen();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Retry activity.updated for activity:7" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Queued for delivery again. If it comes back here after the next minute, the receiving app is still refusing it: check it before retrying.");
  });
});
```

In `a11y.test.tsx`:
- add `if (url.endsWith("/open-activities")) return jsonResponse(200, { activities: [], truncated: false });` and `if (url === "/calendar/api/dead-letters") return jsonResponse(200, [{ eventId: "11111111-1111-4111-8111-111111111111", subscriber: "nrms", type: "activity.updated", aggregateId: "activity:7", attempts: 9, lastError: "HTTP 503", createdAt: "2026-09-01T00:00:00.000Z", queuedAtBc: "2026-08-31 17:00" }]);` to `stub()`, before the `/calendar/api/users` catch-all;
- add the route `<Route path="dead-letters" element={<DeadLettersScreen />} />`;
- add an `it("Undelivered events", …)` that renders `/calendar/dead-letters`, waits for the `h1` "Undelivered events", and runs `seriousViolations`;
- add an `it("the deactivation preview", …)` that renders `/calendar/users/u1`, clicks "Deactivate Robin Staff", waits for the region, and runs `seriousViolations`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/calendar`
Expected: FAIL. There is no preview region, and `./DeadLettersScreen` can't be resolved.

- [ ] **Step 3: Implement**

`users/types.ts`, add:

```ts
/** apps/calendar/src/users.ts's OpenActivity. */
export interface OpenActivity {
  id: number;
  reference: string;
  title: string;
  startAt: string | null;
  endAt: string | null;
  startDate: string | null;
  endDate: string | null;
}
export interface OpenActivities {
  activities: OpenActivity[];
  truncated: boolean;
}
```

`CalendarUserScreen.tsx`:
- Add state `const [preview, setPreview] = useState<OpenActivities | null>(null);`.
- Replace the direct `onPress={() => void setActive(false)}` on the Deactivate button with `onPress={() => void showPreview()}`, where:

```tsx
  const showPreview = async () => {
    try {
      setPreview(await apiFetch<OpenActivities>(`/calendar/api/users/${u.id}/open-activities`));
    } catch (caught) {
      fail(caught);
    }
  };
```

- Render this right after that button, while `preview` is set:

```tsx
      {preview && (
        <section aria-label={`Before deactivating ${u.displayName}`}>
          <h3>Open activities</h3>
          {preview.activities.length === 0 ? (
            <p>No open activities.</p>
          ) : (
            <>
              <p>{u.displayName} is the comm contact for these activities. Deactivating doesn&rsquo;t move them.</p>
              <ul>
                {preview.activities.map((a) => (
                  <li key={a.id}>{`${a.reference} — ${a.title} — ${a.startDate ?? "no date"}`}</li>
                ))}
              </ul>
              {preview.truncated && <p>Only the first 500 are listed.</p>}
              <p>
                <Link to="/calendar/transfer">Transfer their activities first</Link>
              </p>
            </>
          )}
          <Button
            variant="secondary"
            onPress={() => {
              setPreview(null);
              void setActive(false);
            }}
          >
            {preview.activities.length === 0 ? "Deactivate" : "Deactivate anyway"}
          </Button>
          <Button variant="tertiary" onPress={() => setPreview(null)}>
            Cancel
          </Button>
        </section>
      )}
```

`access.ts`: add `export const CALENDAR_SYSADMIN_LEVEL = 5;`.

`apps/staff-web/src/screens/calendar/dead-letters/DeadLettersScreen.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, InlineAlert } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../../api/client";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { messagesOf } from "../../admin/messages";

interface DeadLetter {
  eventId: string;
  subscriber: string;
  type: string;
  aggregateId: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  queuedAtBc: string;
}

const RETRY_NOTE = "Queued for delivery again. If it comes back here after the next minute, the receiving app is still refusing it: check it before retrying.";

/** `/hub/calendar/dead-letters` (spec addendum §5.1): the Calendar's events no app accepted within 24 hours. */
export function DeadLettersScreen(): React.JSX.Element {
  useDocumentTitle("Undelivered events");
  const [rows, setRows] = useState<DeadLetter[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const latest = useRef(0);

  const reload = useCallback((after?: (rows: DeadLetter[]) => void) => {
    const call = ++latest.current;
    apiFetch<DeadLetter[]>("/calendar/api/dead-letters").then(
      (r) => {
        if (call !== latest.current) return;
        setRows(r);
        after?.(r);
      },
      () => call === latest.current && setError("Couldn't load undelivered events."),
    );
  }, []);
  useEffect(() => reload(), [reload]);

  const retry = async (d: DeadLetter) => {
    setMessages([]);
    try {
      await apiFetch("/calendar/api/dead-letters/retry", { method: "POST", body: { eventId: d.eventId, subscriber: d.subscriber } });
      reload((r) => setStatus(r.some((x) => x.eventId === d.eventId && x.subscriber === d.subscriber) ? RETRY_NOTE : "Queued for delivery again."));
    } catch (caught) {
      setMessages(messagesOf(caught));
    }
  };

  if (error) return <InlineAlert variant="danger" role="alert" description={error} />;
  return (
    <div>
      <h1>Undelivered events</h1>
      <p>Events the Calendar couldn&rsquo;t deliver to another app for 24 hours. Retrying sends one once more on the next minute&rsquo;s tick.</p>
      {status && <p role="status">{status}</p>}
      {messages.map((m) => (
        <p role="alert" key={m}>{m}</p>
      ))}
      {rows === null ? (
        <p>Loading…</p>
      ) : rows.length === 0 ? (
        <p>Nothing is waiting: every event was delivered.</p>
      ) : (
        <table>
          <caption>Undelivered events, newest first</caption>
          <thead>
            <tr>
              <th scope="col">Event</th>
              <th scope="col">About</th>
              <th scope="col">To</th>
              <th scope="col">Attempts</th>
              <th scope="col">Last error</th>
              <th scope="col">Queued</th>
              <th scope="col"><span className="gcpe-visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={`${d.eventId}:${d.subscriber}`}>
                <td>{d.type}</td>
                <td>{d.aggregateId}</td>
                <td>{d.subscriber}</td>
                <td>{d.attempts}</td>
                <td>{d.lastError ?? ""}</td>
                <td>{d.queuedAtBc}</td>
                <td>
                  <Button variant="secondary" size="small" onPress={() => void retry(d)} aria-label={`Retry ${d.type} for ${d.aggregateId}`}>
                    Retry
                  </Button>
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

`CalendarSection.tsx`: add a nav item for `me.level >= CALENDAR_SYSADMIN_LEVEL`: `<NavLink to="/calendar/dead-letters">Undelivered events</NavLink>`.

`router.tsx`: add `{ path: "dead-letters", element: <DeadLettersScreen /> }` to the `calendar` children.

- [ ] **Step 4: Run the tests and the type-check**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web`
Expected: PASS.

Run: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p apps/staff-web/tsconfig.json`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/staff-web
git commit -m "feat(staff-web): list a user's open activities before deactivating; the Calendar's undelivered-events page"
```

---

### Task 6: End to end, the axe sweep, parity, running notes, runbook, carry-forward and deploy

Covers: the 5c exit (spec §3), §14 C150, the carry-forward items "Dead-letter page", "Transfer", "Deactivation preview" and "Add `/hub/calendar` to the e2e axe sweep", and the boxs.ca deploy. Decision G5.

**Files:**
- Create: `tests/e2e/calendar-transfer.spec.ts`.
- Modify: `tests/e2e/axe-sweep.spec.ts`.
- Modify: `docs/parity/changes-from-legacy.md`, `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`, `docs/superpowers/plans/phase-5-carry-forward.md`.

**Interfaces:**
- Consumes: the seeded cal-* users (5b-2), the Core users API, the Calendar lookups, users, activities and transfer APIs.
- Produces: none.

- [ ] **Step 1: The e2e journey**

`tests/e2e/calendar-transfer.spec.ts`:

```ts
// A Calendar Administrator sees a user's open activities before deactivating them, moves those
// activities to another comm contact with Transfer, and the list is then empty. Setup runs as
// the HQ Administrator, who is exempt from the 4pm-5pm freeze, so the test runs at any hour.
import { test, expect } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USERNAME, CAL_ADMIN_EMAIL, CAL_HQ_ADMIN_EMAIL, CAL_SYSADMIN_EMAIL, TEST_USER_PASSWORDS } from "./constants";
import { apiCall, baseUrl, expectNoSeriousA11yViolations, loginForCookie, tick } from "./playwright-support";

test.describe("Calendar Transfer and the deactivation preview", () => {
  test("open activities are listed, transferred, and gone from the list", async ({ page, context }) => {
    const stamp = Date.now();
    const core = await loginForCookie(ADMIN_USERNAME, ADMIN_PASSWORD);
    const sys = await loginForCookie(CAL_SYSADMIN_EMAIL, TEST_USER_PASSWORDS[CAL_SYSADMIN_EMAIL]!);
    const admin = await loginForCookie(CAL_ADMIN_EMAIL, TEST_USER_PASSWORDS[CAL_ADMIN_EMAIL]!);
    const hq = await loginForCookie(CAL_HQ_ADMIN_EMAIL, TEST_USER_PASSWORDS[CAL_HQ_ADMIN_EMAIL]!);

    const people: { id: string }[] = [];
    for (const who of ["A", "B"]) {
      const u = await apiCall<{ id: string }>(core, "/core/api/users", { method: "POST", body: { email: `cal-contact-${who.toLowerCase()}-${stamp}@example.test`, displayName: `Contact ${who} ${stamp}` } });
      await apiCall(core, `/core/api/calendar-access/${u.id}`, { method: "PUT", body: { role: "Calendar.Editor", organizationKeys: ["health"] } });
      people.push(u);
    }
    await tick();
    for (const p of people) await apiCall(admin, `/calendar/api/users/${p.id}/comm-contacts/health`, { method: "PUT", body: { rank: 4 } });

    // A category outside the configured release categories (12, 58), and a city.
    let category = await apiCall<{ id: number }>(sys, "/calendar/api/lookups/categories", { method: "POST", body: { name: `E2E category ${stamp}` } });
    while ([12, 58].includes(category.id)) category = await apiCall<{ id: number }>(sys, "/calendar/api/lookups/categories", { method: "POST", body: { name: `E2E category ${stamp}-${category.id}` } });
    const city = await apiCall<{ id: number }>(sys, "/calendar/api/lookups/cities", { method: "POST", body: { name: `E2E city ${stamp}` } });
    const contacts = await apiCall<{ id: number; label: string }[]>(hq, "/calendar/api/transfer/comm-contacts");
    const a = contacts.find((c) => c.label === `Contact A ${stamp} (HLTH)`)!;
    const input = {
      categoryId: category.id, title: `E2E activity ${stamp}`, details: "", significance: "", strategy: "", schedule: "", comments: "", leadOrganization: "", venue: "", otherCity: "", potentialDates: "",
      isIssue: false, isConfidential: false, isMilestone: false, isCrossGovernment: false, isAtLegislature: false, isAllDay: false, isConfirmed: true,
      startDate: "2030-03-10", startTime: "09:00", endDate: "2030-03-10", endTime: "10:00", nrDate: null, nrTime: null,
      contactMinistryKey: "health", commContactId: a.id, governmentRepresentativeId: null, cityId: city.id, premierRequestedId: null,
      nrDistributionId: null, eventPlannerId: null, videographerId: null, nrOriginId: null,
      commMaterialIds: [], initiativeIds: [], keywordNames: [], sectorKeys: [], themeKeys: [], tagKeys: [], sharedWithKeys: [], translations: [],
    };
    for (let n = 0; n < 2; n++) await apiCall(hq, "/calendar/api/activities", { method: "POST", body: { ...input, title: `${input.title} ${n}` } });

    const [name, value] = admin.split("=", 2) as [string, string];
    await context.addCookies([{ name, value, domain: new URL(baseUrl()).hostname, path: "/", httpOnly: true, secure: false, sameSite: "Lax" }]);

    await page.goto(`${baseUrl()}/hub/calendar/users/${people[0]!.id}`);
    await page.getByRole("button", { name: `Deactivate Contact A ${stamp}` }).click();
    const preview = page.getByRole("region", { name: `Before deactivating Contact A ${stamp}` });
    await expect(preview.getByRole("listitem")).toHaveCount(2);
    await expectNoSeriousA11yViolations(page, "deactivation preview");
    await preview.getByRole("button", { name: "Cancel" }).click();

    await page.goto(`${baseUrl()}/hub/calendar/transfer`);
    await expect(page.getByRole("heading", { level: 1, name: "Transfer activities" })).toBeVisible();
    await page.getByLabel("From comm contact").selectOption({ label: `Contact A ${stamp} (HLTH)` });
    await page.getByLabel("To comm contact").selectOption({ label: `Contact B ${stamp} (HLTH)` });
    await page.getByRole("button", { name: "Preview" }).click();
    await expect(page.getByText(`2 activities will move from Contact A ${stamp} (HLTH) to Contact B ${stamp} (HLTH).`, { exact: false })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "Transfer");
    await page.getByRole("button", { name: "Transfer 2 activities" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Transferred" })).toHaveText(`Transferred 2 activities from Contact A ${stamp} (HLTH) to Contact B ${stamp} (HLTH).`);

    await page.goto(`${baseUrl()}/hub/calendar/users/${people[0]!.id}`);
    await page.getByRole("button", { name: `Deactivate Contact A ${stamp}` }).click();
    await expect(page.getByRole("region", { name: `Before deactivating Contact A ${stamp}` }).getByText("No open activities.")).toBeVisible();
  });
});
```

If `apiCall` doesn't already throw on a non-2xx response, assert each setup call's status the way `calendar-users.spec.ts` does.

`tests/e2e/axe-sweep.spec.ts`: add a test that signs in as cal-admin (cookie, as above), visits `/hub/calendar`, `/hub/calendar/lookups`, `/hub/calendar/users` and `/hub/calendar/transfer` with `gotoAndWaitForH1`, and runs `expectNoSeriousA11yViolations` on each. Also, as cal-sysadmin, visit `/hub/calendar/dead-letters`.

- [ ] **Step 2: Run the e2e**

Run: `npx -y -p node@24 -- npm run test:e2e -- tests/e2e/calendar-transfer.spec.ts tests/e2e/axe-sweep.spec.ts`
Expected: PASS.

- [ ] **Step 3: Parity rows**

`docs/parity/changes-from-legacy.md`, "Corporate Calendar (Phase 5)":
- Mark C150 "Built in 5c-2" in its Status cell.
- Add:

```markdown
| C170 | Before deactivating a user, the user page listed every activity with that user as an active comm contact, past ones included (`User.aspx:183-223`). | It lists their open activities only (not deleted, ending today or later, or undated) that the Administrator can see, with a link to Transfer, then asks to confirm. | Past activities need no new contact; confidential activities the Administrator can't see stay hidden (C127). | Proposed |
| C171 | Transfer had no role check and could move any contact's activities, confidential ones included (`Admin/Transfer.aspx.cs`). | Administrators and above. A ministry Administrator transfers only between their own ministries' comm contacts; an HQ Administrator between any. Only activities the Administrator can see move; an open editor is told to reload. | One ministry's Administrator shouldn't empty another ministry's contact; confidential activities follow the visibility rule (C127). | Proposed |
```

- [ ] **Step 4: Running notes**

Append to `docs/manuals/running-notes.md`:

```markdown
## Phase 5c-2 — Transfer, the deactivation preview, undelivered events

- **Administrator** — Hub → Calendar → Transfer moves every activity of one comm contact (past ones
  too, not deleted ones) to another and makes the second contact's ministry the lead ministry. It
  shows how many will move before you confirm. A ministry Administrator can transfer only within
  their own ministries; HQ Administrators can transfer across ministries. Transfer works during
  the 4pm-5pm freeze.
- **Administrator** — Deactivating a user first lists their open activities, with a link to
  Transfer. Deactivating doesn't move them.
- **System Administrator** — Hub → Calendar → Undelivered events lists events another app didn't
  accept for 24 hours. Retry sends one again on the next minute's tick; if it comes back, the
  receiving app is still refusing it.
```

- [ ] **Step 5: Runbook**

`docs/deploy/siteground.md`, under "Corporate Calendar", add `### Transfer and undelivered events (Phase 5c-2)`:
- **No migration.**
- **Hand checks:**
  1. As cal-admin: Hub → Calendar → Transfer. Pick two Health comm contacts and Preview. The count matches the activities created in 5c-1's hand checks. Transfer.
  2. On a user's page, Deactivate shows "No open activities." or the list.
  3. As cal-sysadmin: Hub → Calendar → Undelivered events shows "Nothing is waiting".

- [ ] **Step 6: Carry-forward**

In `docs/superpowers/plans/phase-5-carry-forward.md`:
- Delete § 5c-2 (Dead-letter page, Transfer, Deactivation preview) and its heading.
- Delete the "Staff-web follow-up" item "Add `/hub/calendar` to the e2e axe sweep", and that heading if it is left empty.

- [ ] **Step 7: Final verification**

Run, under Node 24:
- the whole Vitest suite;
- both `tsc` commands;
- `npm run test:e2e`.

Then:
- `git diff <5c-1's last commit> | grep -oE "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+" | sort -u` shows only `example.test`, `x.invalid`, `example.com` or `example.gov.bc.ca`.
- `git diff <5c-1's last commit> -- apps packages scripts tests | grep -nE "Task [0-9]|\bG[0-9]+\b|\bR[0-9]+\b|fix round"` prints nothing.

- [ ] **Step 8: Commit**

```bash
git add tests/e2e docs
git commit -m "test(e2e),docs: Transfer and the deactivation preview end to end; /hub/calendar in the axe sweep; parity C150 C170 C171"
```

- [ ] **Step 9: Deploy and hand checks**

1. Deploy `feat/phase-5c` to boxs.ca (`npm run deploy:siteground`, then the printed push).
2. Check `/stack/health`.
3. Do Step 5's hand checks if `gcpe_calendar` exists there. If it doesn't, leave Paul the Site Tools step and mark the boxs.ca hand checks as waiting on it.

---

## Risks and things to watch

- **Two transfers at once from overlapping sets.**
  - Each batch locks ascending ids, and each activity is re-checked under its lock, so no activity moves twice.
  - *Inferred:* two concurrent runs may each take a lock the other wants next. Both lock in ascending order within a batch, so neither waits in a cycle; Task 1's concurrency test exercises it.
- **The dead-letter retry's interaction with `maxAgeMs`.** A retried event older than 24 hours is dead again after one failed attempt. *Verified* by reading `packages/events/src/dispatcher.ts:126-131`, and pinned by Task 3's test.
- **`gte` on a `coalesce(…)` SQL expression.** *Assumed:* drizzle accepts it; Task 2 Step 3 names the plain-`sql` fallback.
- **e2e lookup ids.** The e2e creates its category through the API. On a fresh e2e database an id of 12 or 58 would make it a release category; the loop skips those. *Inferred* from 5b-1's identity columns, which start at 1.

## Self-review (done while writing)

- **Spec coverage (5c, second half):**
  - **§7.1 Transfer:** Task 1:
    - every active activity moves;
    - the contact ministry is set from B's by id;
    - a `transferred` entry is written for each;
    - no flags and no status change.
  - **§8.5 Transfer screen:** Task 4 (pick, preview the count, confirm).
  - **§8.5 deactivation listing:** Tasks 2 and 5.
  - **§5.1 dead-letter page:** Tasks 3 and 5.
  - **§6:** Administrator for Transfer (C140); `visibleSql` for the preview and the moved set.
  - **§7.4:** Transfer not frozen (Task 1 test).
  - **§7.5:** version bump; an open editor gets 409 (Task 1 test).
  - **§14:** C150 built; C170 and C171 (Task 6).
  - **Carry-forward:** every remaining 5c item, plus the staff-web axe-sweep item.
- **Placeholders:** none. These steps describe edits by rule, and each names exactly what changes:
  - Task 3's import tidy-up in the test;
  - Task 5's test-stub additions;
  - Task 6's axe-sweep test.
- **Type consistency:**
  - `TransferContact` and `TransferPreview` match between `apps/calendar/src/transfer.ts` and staff-web's `transfer/types.ts`.
  - `OpenActivity` matches between `users.ts` and staff-web's `users/types.ts`.
  - `DeadLetter` matches between `dead-letters.ts` and `DeadLettersScreen.tsx`.
  - `userRoutes(deps: ApiDeps)` is called from `routes.ts`.
- **Review Focus:** each line names its pinning test, and each test is in its task's code:
  1. Task 1;
  2. Tasks 1 and 4;
  3. Task 1;
  4. Tasks 2 and 5;
  5. Tasks 3 and 5.
