# Phase 4f: Staff Subscribers Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff with the new `NoD.Viewer` / `NoD.Editor` roles (and `NoD.Admin`) can find subscribers in the staff app and, as Editor or Admin, edit their timing, lists and status, change their email, delete them, see their history, act on a whole page of search results at once with a confirmation, and add new subscribers who are active immediately (C51).

**Architecture:**
- **Roles:** `NoD.Viewer` and `NoD.Editor` join Core's staff role catalogue (`packages/auth`) and staff-web's mirrored list. Core grants them as it grants every staff role.
- **NoD:**
  - A `staff-subscribers/` module: `read.ts` for search, detail, history and list options; `actions.ts` for edit, status, change email, delete and bulk.
  - One router, `http/staff-subscriber-routes.ts`, mounted inside the existing `/api` router. It also takes over `POST /subscribers`.
  - Every write takes the per-address lock (`locks.ts`) and writes `subscriber_history` in the same transaction.
  - The router answers unexpected errors itself, logging only an error label. Its queries bind addresses and search terms, and the shared error handler would log them.
- **Public journeys** (carry-forward):
  - Confirmation writes `subscribed` or `resubscribed`.
  - A completed email move expires the subscriber's other links, and keeps the history of any dead row it replaces.
  - A superseded verify link is dead everywhere.
  - Reactivation, by staff or by the subscriber's own re-confirm, restarts the bounce count.
- **staff-web:** a new `/hub/subscribers` section, with search and list (bulk actions in a confirm dialog), Add, detail/edit, and history. The nav item and the landing redirect follow the NoD roles.

**Tech Stack:** Node 24, TypeScript 5.9 strict, Express 5, Drizzle 0.45 / drizzle-kit 0.31, zod 3.25, Vitest 4.1, supertest, React 19 + react-router 7 (library mode), `@bcgov/design-system-react-components`, axe-core, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-05-nod-distribution-parity-design.md`:
- §8 "Staff Subscribers section": the Subscribers bullets and the Roles bullets;
- §3 (`subscribers.status`, `subscriber_history`);
- §7 (the bounce threshold that reactivation interacts with);
- §10 acceptance item 14.

Executors read the spec alongside this plan.

**Base:**
- **Branch:** `feat/phase-4f`, cut from `feat/phase-4e` after 4e's final fixes land. At planning time its head was `4e2655e`.
- **Worktree:** `/Users/paul/gcpe-news-platform-4f`, created by the controller (superpowers:using-git-worktrees).
- **Line numbers:** every file:line reference below is against 4e's head. Re-find by symbol if the final 4e fixes moved anything.

**Context:**
- Research notes, with file:line refs: `research-4f.md` in the session scratchpad. They are not in the repo; nothing in this plan depends on reading them.
- **Legacy parity screens** (`~/HUB/Subscribe/Gcpe.NewsOnDemand.Website`):
  - `ManageSubscribers.aspx.cs`: substring search via `PatIndex`; an All/Active/Disabled filter; paged; row Edit/Activate/Deactivate/Delete; bulk Activate/De-activate/Delete on checked rows with no confirmation; deleted subscribers hidden (`IsDeleted == false`, :128).
  - `UserControls/AddEditSubscriber.ascx.cs`: an email + confirm-email pair; "All news" or per-list checkboxes; As It Happens / Daily Digest, at least one required; Save, Activate/Deactivate, Change Email, Delete.
  - `SubscriberHistory.aspx.cs`: Action / User / Date, newest first, with a blank user shown as "Subscriber".
- **Legacy email change** (`SubscriptionProvider.cs:252-258`): refused outright if any subscriber already has the new address.

## Global Constraints

- **Worktree and commits:**
  - Work in `/Users/paul/gcpe-news-platform-4f`, branch `feat/phase-4f`. Commit locally after each task.
  - Never add `Co-Authored-By` or any AI attribution. Never commit `CLAUDE.md`.
  - **Code comments never carry task, review-round or finding labels** ("Task 3", "fix round 1", "I2"…). Say *why*, not *when*.
- **Node 24 for everything:**
  - Tests: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run <paths>`.
  - Type-checks: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json` and `… -p apps/staff-web/tsconfig.json`.
  - E2E: `npx -y -p node@24 -- npm run test:e2e`.
  - Show each new test failing before implementing it (a real RED run).
- **Migrations:**
  - Generate with drizzle-kit: `cd apps/nod && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name <name>`.
  - Never hand-edit generated DDL. Migrations must be safe on boxs.ca's existing data, and additive only.
- **Clocks:** time comparisons in SQL use the DB clock (`now()`), never a JS `Date` against a DB timestamp.
- **Locking (spec §3; `apps/nod/src/locks.ts`):**
  - Every write that reads or changes a subscriber's email or status first calls `lockAddress(tx, lower(email))`, then reads the row `FOR UPDATE`.
  - A change of email locks **both** addresses, in sorted order.
- **Privacy:**
  - **Email addresses and search terms never go in logs**: not in `console.*`, not in `last_error`, and not in an error that reaches `jsonErrorHandler` (it logs the whole error, and a `DrizzleQueryError` message carries its bound params).
  - `subscriber_history.detail` never stores an email address.
  - `document.title` never contains an email address.
- **Media memberships are never touched by public-list edits.**
  - Staff preference edits replace only non-`media-distribution-lists:` subscriptions. This is the same rule as `replaceSubscriptions` in `subscribe/journeys.ts`, and 4c shipped a bug when it was missed.
  - Only staff **delete** removes media memberships. It writes `media-list-removed` for each, never `media-list-opted-out` or `unsubscribed`.
- **"disabled" (4e's definition, extended here):**
  - Bounce- or staff-disabled. Receives nothing. Kept, never purged.
  - Staff can see it (status filter, detail with the reason) and reactivate it. Reactivation writes `staff-activated` history.
  - **Reactivation restarts the bounce count** (Ruling R2): `subscribers.bounce_window_from = now()`, and the 10-in-15-days threshold only counts emails attempted after it. The subscriber's own re-confirm from `disabled` does the same.
- **Status transitions staff may make:**
  - `disabled → active`, `active → disabled`, and any non-deleted status `→ deleted`.
  - A no-op (already in the target state) answers `{ changed: false }`.
  - Anything else is `409 { error: "status", status }`.
  - Staff can never reactivate a `deleted` (unsubscribed) subscriber (Ruling R1).
- **Roles (spec §8):**
  - Reads (search, detail, history, list options): `NoD.Viewer`, `NoD.Editor` or `NoD.Admin`.
  - Writes (add, edit, status, email, delete, bulk): `NoD.Editor` or `NoD.Admin`.
  - The server is the authority; staff-web hides what a role can't use. Service uses of `NoD.Admin` and `NoD.SubscriberCount` are unchanged.
- **Staff-web patterns:**
  - Every call goes through `apiFetch` (`apps/staff-web/src/api/client.ts`), with same-origin `/nod/api/...` paths.
  - Every screen calls `useDocumentTitle` with its `h1` text, unconditionally.
  - Tests stub `fetch` with `jsonResponse` (`apps/staff-web/test/jsonResponse.ts`), and each section has an `a11y.test.tsx` running axe (wcag2a/wcag2aa, serious/critical).
  - **Title assertions use `await waitFor(() => expect(document.title).toBe(...))`**, never a bare `expect` right after `findByRole`. That pattern is flaky by construction (research §3).
  - Confirm dialogs use `DialogTrigger` + `Modal` + `AlertDialog`, as `ActionsSection.tsx` does.
- **Copy:**
  - Status labels: Pending, Active, Disabled, "Unsubscribed or deleted".
  - Timing labels: "As it happens", "Daily digest".
  - Error text comes from the server's `error` or zod `issues[].message`, the same as `UsersScreen.messagesOf`.

## Review Focus

1. **A staff edit of the public lists of a subscriber who is also on media lists.** The media memberships survive exactly. The public lists change and nothing else does. Pinned in Task 4 ("staff preferences edit keeps media memberships").
2. **A bulk action over a page that mixes statuses.** Example: Activate on rows that are active, disabled, deleted, plus one that someone else just deleted. Each row is handled on its own. Allowed rows change, the rest are reported as skipped with a reason, and one refusal never rolls back the others. The screen says how many changed and how many were skipped. Pinned in Task 4 ("bulk over mixed statuses") and Task 5 ("bulk outcome message").
3. **Search terms with LIKE metacharacters, mixed case or surrounding spaces** (`pat_smith`, `100%`, `" PAT@"`). They match literally and case-insensitively. They never act as wildcards, and never cause a 500. Pinned in Task 3 ("search treats wildcards literally").
4. **A staff-reactivated bounce-disabled subscriber whose mailbox bounces once more.** They stay active: the old bounces no longer count, and it takes 10 fresh hard-bounced emails in 15 days to disable them again. Pinned in Task 4 ("reactivation restarts the bounce count").
5. **A database error during search, change-email or add.** The response is a detail-free 500, and nothing logged contains the address or the search term. Pinned in Task 3 ("privateErrors logs no address").

---

## File structure

| File | Responsibility |
|---|---|
| `packages/auth/src/roles.ts` | `STAFF_ROLES` gains `NoD.Viewer`, `NoD.Editor` |
| `apps/staff-web/src/screens/admin/users/roles.ts` | Mirror with descriptions |
| `apps/core/src/services/seed-test-users.ts`, `scripts/siteground-seed-users.sh`, `tests/e2e/constants.ts`, `tests/e2e/playwright-support.ts` | Two new test users |
| `apps/nod/src/db/schema.ts` + `migrations/0019_*` | `subscribers.bounce_window_from` |
| `apps/nod/src/bounces.ts` | Threshold counts only emails after `bounce_window_from` |
| `apps/nod/src/subscribe/history.ts` | `HISTORY_ACTIONS` const array + new actions |
| `apps/nod/src/subscribe/links.ts` | `expireSessionLinks` |
| `apps/nod/src/subscribe/journeys.ts` | `subscribed`/`resubscribed`; move keeps history, expires links; superseded verify link dead; re-confirm restarts bounce count |
| `apps/nod/src/subscribers.ts` | `replacePublicSubscriptions` (moved from journeys); `addSubscriber` timing, lock, history |
| `apps/nod/src/staff-subscribers/read.ts` | Search, detail, history, list options |
| `apps/nod/src/staff-subscribers/actions.ts` | Edit, status, change email, delete, bulk |
| `apps/nod/src/http/staff-subscriber-routes.ts` | Every staff subscriber route + `privateErrors` |
| `apps/nod/src/http/routes.ts` | Mounts the staff router; drops its own `POST /subscribers` |
| `apps/nod/test/staff-auth.ts` | Signs role tokens for route tests |
| `apps/staff-web/src/screens/subscribers/*` | Section, search/list, add, detail, history, list picker, labels, access, types |
| `apps/staff-web/src/shell/AppShell.tsx`, `HomeRedirect.tsx`, `src/router.tsx` | Nav item, landing redirect, routes |
| `tests/e2e/subscribers.spec.ts` | Acceptance item 14 + the staff flows |
| `docs/parity/*`, `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`, `docs/superpowers/plans/phase-4-carry-forward.md` | Docs |

---

### Task 1: NoD.Viewer and NoD.Editor roles, and their test users

**Files:**
- Modify:
  - `packages/auth/src/roles.ts`, `packages/auth/src/session.test.ts:57`;
  - `apps/staff-web/src/screens/admin/users/roles.ts`;
  - `apps/core/src/services/seed-test-users.ts`, `apps/core/src/services/seed-test-users.test.ts`;
  - `apps/core/src/http/users.test.ts`;
  - `scripts/siteground-seed-users.sh`;
  - `tests/e2e/constants.ts`, `tests/e2e/playwright-support.ts` (`ROLE_LOGINS`).
- Test: `packages/auth/src/session.test.ts`, `apps/staff-web/src/screens/admin/users/roles.test.ts` (unchanged; it must stay green), `apps/core/src/http/users.test.ts`, `apps/core/src/services/seed-test-users.test.ts`.

**Interfaces:**
- Produces:
  - `STAFF_ROLES = ["Core.Admin", "NRMS.Editor", "NRMS.SiteEditor", "NRMS.Viewer", "NoD.Viewer", "NoD.Editor", "NoD.Admin", "Distribution.Send"]`.
  - Test users `nod-viewer@example.test` (`NoD.Viewer`, "Test NoD Viewer") and `nod-editor@example.test` (`NoD.Editor`, "Test NoD Editor").
  - e2e constants `NOD_VIEWER_EMAIL`, `NOD_EDITOR_EMAIL`; `ROLE_LOGINS.nodViewer`, `ROLE_LOGINS.nodEditor`.

- [ ] **Step 1: Write the failing tests**

`packages/auth/src/session.test.ts`, replace the line-57 assertion:

```ts
    expect(STAFF_ROLES).toEqual(["Core.Admin", "NRMS.Editor", "NRMS.SiteEditor", "NRMS.Viewer", "NoD.Viewer", "NoD.Editor", "NoD.Admin", "Distribution.Send"]);
```

`apps/core/src/http/users.test.ts`, add inside the existing describe (it already has `as(adminCookie)`):

```ts
  it("grants the NoD.Viewer and NoD.Editor roles", async () => {
    const created = await as(adminCookie).post("/api/users", { email: "nod.staff@example.test", displayName: "NoD Staff", roles: ["NoD.Viewer"], password: "nod staff pass 12" });
    expect(created.status).toBe(201);
    expect(created.body.roles).toEqual(["NoD.Viewer"]);
    const reroled = await as(adminCookie).put(`/api/users/${created.body.id}/roles`, { roles: ["NoD.Editor"] });
    expect(reroled.body.roles).toEqual(["NoD.Editor"]);
  });
```

`apps/core/src/services/seed-test-users.test.ts`, extend the first test:

```ts
    expect((await findUserByEmail(tdb.db, "nod-viewer@example.test"))?.roles).toEqual(["NoD.Viewer"]);
    expect((await findUserByEmail(tdb.db, "nod-editor@example.test"))?.roles).toEqual(["NoD.Editor"]);
```

Rename that test to "creates the five test users with their roles".

- [ ] **Step 2: Run them; expect FAIL**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/auth apps/core/src/http/users.test.ts apps/core/src/services/seed-test-users.test.ts`

Expected:
- the `STAFF_ROLES` equality fails;
- the users test gets 400, since `z.enum(STAFF_ROLES)` rejects the role;
- the seed test fails on a missing user.

- [ ] **Step 3: Implement**

`packages/auth/src/roles.ts`:

```ts
/** Every role a staff user can hold (spec addendum §2; NoD.Viewer/NoD.Editor from the NoD
 * parity spec §8 — Viewer reads the Subscribers section, Editor also changes subscribers and
 * media lists, Admin adds Operations and categories). No ministry scope — legacy has none. */
export const STAFF_ROLES = ["Core.Admin", "NRMS.Editor", "NRMS.SiteEditor", "NRMS.Viewer", "NoD.Viewer", "NoD.Editor", "NoD.Admin", "Distribution.Send"] as const;
```

`apps/staff-web/src/screens/admin/users/roles.ts`: insert before `NoD.Admin`, and reword `NoD.Admin`:

```ts
  { role: "NoD.Viewer", description: "Search News on Demand subscribers and see lists and reports, read-only." },
  { role: "NoD.Editor", description: "Add, edit, deactivate and delete News on Demand subscribers and media-list members." },
  { role: "NoD.Admin", description: "Everything a NoD Editor can do, plus News on Demand operations and list categories." },
```

`apps/core/src/services/seed-test-users.ts`, change `TEST_USERS` and its doc comment:

```ts
/** The local test users (spec addendum §2; the two NoD users for the Subscribers section's
 * role checks, NoD parity spec §10 item 14). Fictional addresses on the reserved .test TLD. */
export const TEST_USERS = [
  { email: "editor@example.test", displayName: "Test Editor", roles: ["NRMS.Editor"] },
  { email: "site-editor@example.test", displayName: "Test Site Editor", roles: ["NRMS.SiteEditor"] },
  { email: "viewer@example.test", displayName: "Test Viewer", roles: ["NRMS.Viewer"] },
  { email: "nod-viewer@example.test", displayName: "Test NoD Viewer", roles: ["NoD.Viewer"] },
  { email: "nod-editor@example.test", displayName: "Test NoD Editor", roles: ["NoD.Editor"] },
] as const;
```

`scripts/siteground-seed-users.sh`:
- change the header's "three Phase 3 test users" to "five test users";
- after the `seed viewer@example.test …` line, add:

```bash
seed nod-viewer@example.test "Test NoD Viewer" NoD.Viewer
seed nod-editor@example.test "Test NoD Editor" NoD.Editor
```

`tests/e2e/constants.ts`, add to `TEST_USER_PASSWORDS` and add the exports. `seedTestUsers` refuses to run if any `TEST_USERS` entry has no password.

```ts
  "nod-viewer@example.test": "e2e-nod-viewer-password-1",
  "nod-editor@example.test": "e2e-nod-editor-password-1",
```
```ts
export const NOD_VIEWER_EMAIL = "nod-viewer@example.test";
export const NOD_EDITOR_EMAIL = "nod-editor@example.test";
```

`tests/e2e/playwright-support.ts` `ROLE_LOGINS`, add:

```ts
  nodViewer: () => loginForCookie("nod-viewer@example.test", TEST_USER_PASSWORDS["nod-viewer@example.test"]!),
  nodEditor: () => loginForCookie("nod-editor@example.test", TEST_USER_PASSWORDS["nod-editor@example.test"]!),
```

- [ ] **Step 4: Run; expect PASS**

Run the Step 2 command plus `apps/staff-web/src/screens/admin/users`. Expect PASS, including `roles.test.ts`, which checks that client and server agree.

- [ ] **Step 5: Type-check both projects, then commit**

```bash
git add packages/auth apps/staff-web/src/screens/admin/users/roles.ts apps/core scripts/siteground-seed-users.sh tests/e2e/constants.ts tests/e2e/playwright-support.ts
git commit -m "feat(auth,core,staff-web): NoD.Viewer and NoD.Editor roles; NoD test users"
```

---

### Task 2: Bounce window, history actions and the public-journey carry-forwards

This task owns every carry-forward item that touches `journeys.ts`, `links.ts`, `history.ts` and `bounces.ts`. Quoted from `docs/superpowers/plans/phase-4-carry-forward.md` (the "4e / 4f" section):

> - When an email move deletes a `pending`/`deleted` row, its `subscriber_history` cascades away. Decide the audit-retention rule.
> - History has no separate "subscribed" action, so a new signup and a reactivation both log "confirmed". Settle this for the 4f reports.
> - After a move, the old address's unexpired manage/verify sessions still work for up to 24 h. Consider using up the subscriber's other session links when the move completes.
> - A superseded verify link (claimed by a sibling confirm, no subscriber id) returns `null` from Confirm but `true` from CheckEmailActivationToken. Align them.

Rulings, recorded in the plan's Rulings section:
- **R3:** the dead row's history moves onto the mover, plus a `record-merged` row.
- **R4:** `subscribed` for a first confirmation; `resubscribed` when the row was `disabled` or `deleted`. Old `confirmed` rows stay readable.
- **R5:** a completed move expires every other live link of the subscriber.
- **R6:** `CheckEmailActivationToken` says `false` for a superseded verify link.
- **R2:** reactivation restarts the bounce count.

**Files:**
- Modify:
  - `apps/nod/src/db/schema.ts` (+ generated `apps/nod/migrations/0019_subscriber_bounce_window.sql`);
  - `apps/nod/src/bounces.ts`;
  - `apps/nod/src/subscribe/history.ts`, `apps/nod/src/subscribe/links.ts`, `apps/nod/src/subscribe/journeys.ts`;
  - `apps/nod/src/subscribers.ts`.
- Test: `apps/nod/src/bounces.test.ts`, `apps/nod/src/subscribe/journeys.test.ts`, `apps/nod/src/subscribe/links.test.ts`.

**Interfaces:**
- Produces:
  - Column `subscribers.bounce_window_from timestamptz NULL` (Drizzle `bounceWindowFrom`).
  - `HISTORY_ACTIONS` (const array, exported from `subscribe/history.ts`) and `type HistoryAction = (typeof HISTORY_ACTIONS)[number]`, now including `"resubscribed"` and `"record-merged"`.
  - `expireSessionLinks(tx: DbOrTx, subscriberId: string, keepId: string | null): Promise<number>` in `subscribe/links.ts`.
  - `replacePublicSubscriptions(tx: DbOrTx, subscriberId: string, listKeys: string[]): Promise<void>` in `subscribers.ts`, moved from `journeys.ts`'s private `replaceSubscriptions`.

- [ ] **Step 1: Write the failing tests**

`apps/nod/src/bounces.test.ts`, add. It reuses the file's `insertSubscriber`, `insertEmail`, `bounceEvent`, `daysAgo`, `OPTS`:

```ts
  it("reactivation restarts the bounce count: only emails after bounce_window_from count", async () => {
    const s = await insertSubscriber(tdb.db, "window@example.test");
    for (let i = 0; i < 9; i++) {
      await insertEmail(tdb.db, { subscriberId: s.id, itemKeyPrefix: `win-old-${i}`, n: 1, attemptedAt: daysAgo(3), distributionBatchId: randomUUID(), hardBounced: true });
    }
    await tdb.db.update(subscribers).set({ bounceWindowFrom: daysAgo(1) }).where(eq(subscribers.id, s.id));
    expect(await countBouncedEmails(tdb.db, s.id)).toBe(0);

    const batchId = randomUUID();
    await insertEmail(tdb.db, { subscriberId: s.id, itemKeyPrefix: "win-new", n: 1, attemptedAt: new Date(), distributionBatchId: batchId });
    const r = await tdb.db.transaction((tx) => onDeliveryBounced(tx, bounceEvent({ email: "window@example.test", batchId }), OPTS));
    expect(r.action).toBe("recorded");
    const [after] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, s.id));
    expect(after!.status).toBe("active");
    expect(await countBouncedEmails(tdb.db, s.id)).toBe(1);
  });
```

`apps/nod/src/subscribe/journeys.test.ts`:
- Change both `eq(subscriberHistory.action, "confirmed")` (lines ~229 and ~242) to `"subscribed"`.
- Add the tests below.

```ts
  it("a first confirmation writes 'subscribed'; confirming again from disabled or deleted writes 'resubscribed'", async () => {
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    const [s] = await tdb.db.select().from(subscribers);
    await tdb.db.update(subscribers).set({ status: "disabled" }).where(eq(subscribers.id, s!.id));
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    const actions = (await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, s!.id))).map((h) => h.action).sort();
    expect(actions).toEqual(["resubscribed", "subscribed"]);
  });

  it("re-confirming from disabled restarts the bounce count", async () => {
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    await tdb.db.update(subscribers).set({ status: "disabled" });
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    const [s] = await tdb.db.select().from(subscribers);
    expect(s!.status).toBe("active");
    expect(s!.bounceWindowFrom).not.toBeNull();
  });

  it("a move over a dead row keeps that row's history on the mover, with a record-merged line", async () => {
    for (const email of ["a@example.test", "b@example.test"]) { await subscribe(deps, info({ emailAddress: email })); await confirm(deps, tokenFrom()); }
    const [bRow] = await tdb.db.select().from(subscribers).where(eq(subscribers.email, "b@example.test"));
    await unsubscribe(deps, unsubscribeToken(SECRET, bRow!.id, 1));
    await requestManageLink(deps, "a@example.test");
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    await update(deps, tokenFrom(), info({ emailAddress: "b@example.test" }));
    await confirm(deps, tokenFrom());
    const [mover] = await tdb.db.select().from(subscribers);
    const history = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, mover!.id));
    expect(history.map((h) => h.action)).toEqual(expect.arrayContaining(["unsubscribed", "record-merged", "email-changed"]));
    expect(history.find((h) => h.action === "record-merged")!.detail).toBe("deleted");
  });

  it("after a completed move, the subscriber's other links stop working; the change-email link stays a session", async () => {
    await subscribe(deps, info({ emailAddress: "old@example.test" }));
    const verifyToken = tokenFrom();
    await confirm(deps, verifyToken);
    await requestManageLink(deps, "old@example.test");
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    const manageToken = tokenFrom();
    await update(deps, manageToken, info({ emailAddress: "new@example.test" }));
    const changeToken = tokenFrom();
    await confirm(deps, changeToken);
    expect(await checkToken(deps, manageToken)).toBe(false);
    expect(await checkToken(deps, verifyToken)).toBe(false);
    expect(await update(deps, manageToken, info({ emailAddress: "new@example.test" }))).toBe("invalid");
    expect(await checkToken(deps, changeToken)).toBe(true);
  });

  it("a superseded verify link is dead everywhere: confirm null, checkToken false", async () => {
    await subscribe(deps, info());
    const first = tokenFrom();
    await subscribe(deps, info());
    const second = tokenFrom();
    await confirm(deps, first);
    expect(await confirm(deps, second)).toBeNull();
    expect(await checkToken(deps, second)).toBe(false);
    expect(await checkToken(deps, first)).toBe(true);
  });
```

Check the "superseded" setup before relying on it. The second `subscribe` must send a second verify email: the address isn't active yet, so it should. If the first `confirm` result is a manage view rather than `null` for `second`, re-read `confirm()`. `second` has `used_at` set and no `subscriber_id`, so `manageViewById(null)` returns `null`.

`apps/nod/src/subscribe/links.test.ts`, add:

```ts
  it("expireSessionLinks ends every other live link of the subscriber and keeps the one named", async () => {
    const [s] = await tdb.db.insert(subscribers).values({ email: "x@example.test", status: "active" }).returning();
    const keep = await createLink(tdb.db, { purpose: "change-email", email: "y@example.test", subscriberId: s!.id, pending: null });
    const other = await createLink(tdb.db, { purpose: "manage", email: "x@example.test", subscriberId: s!.id, pending: null, origin: "send" });
    expect(await expireSessionLinks(tdb.db, s!.id, keep.id)).toBe(1);
    expect((await findLink(tdb.db, other.token))!.expired).toBe(true);
    expect((await findLink(tdb.db, keep.token))!.expired).toBe(false);
  });
```

Adapt the import and fixture style to the existing `links.test.ts` setup if it differs.

- [ ] **Step 2: Run; expect FAIL**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/bounces.test.ts apps/nod/src/subscribe`

Expected: compile errors (`bounceWindowFrom`, `expireSessionLinks` don't exist), then assertion failures.

- [ ] **Step 3: Implement**

`apps/nod/src/db/schema.ts`, in `subscribers` after `unsubscribeVersion`:

```ts
    // When the bounce threshold (bounces.ts) starts counting from: set on every reactivation
    // (staff activate, or the subscriber's own re-confirm from `disabled`), so emails that
    // bounced before someone judged the mailbox fixed never count toward disabling it again.
    // Null = count everything in the 15-day window.
    bounceWindowFrom: timestamp("bounce_window_from", { withTimezone: true }),
```

Generate: `cd apps/nod && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name subscriber_bounce_window`. Expect a single `ALTER TABLE "subscribers" ADD COLUMN "bounce_window_from" timestamp with time zone;`.

`apps/nod/src/bounces.ts`, in `groupedBouncedEmailsSql`, add after the `attempted_at >= now() - …` line:

```ts
       AND attempted_at > COALESCE((SELECT bounce_window_from FROM subscribers WHERE id = ${subscriberId}), '-infinity'::timestamptz)
```

Extend the function's doc comment with one sentence: "Only emails attempted after the subscriber's `bounce_window_from` count — a reactivation restarts the count."

`apps/nod/src/subscribe/history.ts`, replace the union with:

```ts
/** Every action `subscriber_history` holds; staff-web's History screen has a label for each
 * (apps/staff-web/src/screens/subscribers/labels.test.ts checks they stay in step).
 * `confirmed` is no longer written — rows from before the subscribed/resubscribed split keep it. */
export const HISTORY_ACTIONS = [
  "subscribed",
  "resubscribed",
  "confirmed",
  "preferences-updated",
  "email-change-requested",
  "email-changed",
  "record-merged",
  "unsubscribed",
  "media-list-added",
  "media-list-removed",
  "media-list-opted-out",
  "media-ended",
  "media-hub-email-changed",
  "media-hub-flagged",
  "media-hub-resolved",
  "bounce-recorded",
  "bounce-disabled",
  "bounce-flagged",
] as const;
export type HistoryAction = (typeof HISTORY_ACTIONS)[number];
```

`apps/nod/src/subscribe/links.ts`, add:

```ts
/** Ends every other still-live link of this subscriber's — verify, manage and send-stamped
 * alike — by moving its expiry to now, so none of them works as a session any more. Used when
 * the subscriber's address changes: those links were mailed to an address that is no longer
 * theirs. `keepId` is the link that made the change (it stays the new address's session), or
 * null when staff made it. */
export async function expireSessionLinks(tx: DbOrTx, subscriberId: string, keepId: string | null): Promise<number> {
  const r = await tx.execute<{ id: string }>(sql`
    UPDATE ${subscriberLinks} SET expires_at = now()
     WHERE subscriber_id = ${subscriberId} AND expires_at > now()
       ${keepId ? sql`AND id <> ${keepId}` : sql``}
    RETURNING id`);
  return r.rows.length;
}
```

`apps/nod/src/subscribers.ts`, move `replaceSubscriptions` here, exported and renamed:

```ts
/** Replaces a subscriber's non-media subscriptions with `listKeys`. Media memberships
 * (`media-distribution-lists:*`) are never in `listKeys` — neither the public manage page nor
 * the staff preferences form offers them — and must survive untouched. */
export async function replacePublicSubscriptions(tx: DbOrTx, subscriberId: string, listKeys: string[]): Promise<void> {
  await tx
    .delete(subscriptions)
    .where(and(eq(subscriptions.subscriberId, subscriberId), sql`${subscriptions.listKey} NOT LIKE ${`${MEDIA_CATEGORY}:%`}`));
  if (listKeys.length) await tx.insert(subscriptions).values(listKeys.map((listKey) => ({ subscriberId, listKey })));
}
```

Add `and, eq` to its drizzle import and `DbOrTx` to its db-kit import. In `journeys.ts`, delete the local function and import this one, renaming both call sites.

`apps/nod/src/subscribe/journeys.ts`:

1. `applyVerify`, inside the transaction, after `existing` is read:

```ts
    // A first confirmation, or a pending row's, is a new subscription; a disabled or deleted
    // row coming back is a resubscription — reports count the two separately.
    const historyAction = !existing || existing.status === "pending" ? "subscribed" : "resubscribed";
    const fields = {
      status: "active" as const,
      verifiedAt: sql`now()`,
      asItHappens: pending.asItHappens,
      digest: pending.digest,
      endedAt: null,
      source: "self" as const,
      // Their own confirmation proves the mailbox works again: restart the bounce count.
      ...(existing?.status === "disabled" ? { bounceWindowFrom: sql`now()` } : {}),
    };
```

Then change the `writeHistory(…, "confirmed", …)` line to `writeHistory(tx, subscriberId, SELF, historyAction, pending.listKeys.join(", "))`.

2. `applyEmailChange`, in the `pending`/`deleted` branch, replace the bare delete with:

```ts
        // A dead row, not a live subscriber to protect — but its history is the record of what
        // happened at this address (an unsubscribe is consent evidence), so it moves onto the
        // mover before the row goes, rather than cascading away with it.
        await tx.update(subscriberHistory).set({ subscriberId }).where(eq(subscriberHistory.subscriberId, taken.id));
        await tx.delete(subscribers).where(eq(subscribers.id, taken.id));
        await writeHistory(tx, subscriberId, SELF, "record-merged", taken.status);
```

Import `subscriberHistory` from `../db/schema`.

3. `applyEmailChange`, after the `update(subscribers).set({ email: … })` and before `writeHistory(…, "email-changed")`:

```ts
    // Links mailed to the old address must stop working the moment it stops being theirs.
    await expireSessionLinks(tx, subscriberId, link.id);
```

4. `checkToken`, before the final `return true`:

```ts
  // A verify link claimed by a sibling confirmation (used, but never bound to a subscriber) is
  // dead: Confirm already answers null for it, so this must not call it valid.
  if (link.purpose === "verify" && link.usedAt !== null && link.subscriberId === null) return false;
```

- [ ] **Step 4: Run; expect PASS**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod`. The whole app must pass, including `bounce-summary.test.ts`, which shares `countBouncedEmails`.

- [ ] **Step 5: Commit**

```bash
git add apps/nod
git commit -m "feat(nod): reactivation restarts the bounce count; subscribed/resubscribed history; moves keep history and expire old links"
```

---

### Task 3: NoD staff read API (search, detail, history, list options)

**Files:**
- Create:
  - `apps/nod/src/staff-subscribers/read.ts` (+ `read.test.ts`);
  - `apps/nod/src/http/staff-subscriber-routes.ts` (+ `staff-subscriber-routes.test.ts`);
  - `apps/nod/test/staff-auth.ts`.
- Modify: `apps/nod/src/http/routes.ts` (mount the router at the end of `apiRoutes`).

**Interfaces:**
- Consumes: `countBouncedEmails`, `THRESHOLD_WINDOW_DAYS` (bounces.ts); `PUBLIC_CATEGORIES`, `MEDIA_CATEGORY` (lists.ts); `safeErrorLabel` (subscribe/journeys.ts).
- Produces:
  - **From `read.ts`:**
    - `STATUS_FILTERS = ["all", "pending", "active", "disabled", "deleted"] as const`; `type StatusFilter`.
    - `PAGE_SIZE = 50`, `HISTORY_LIMIT = 500`.
    - `escapeLike(s: string): string`.
    - `searchSubscribers(db, { q: string; status: StatusFilter; page: number }): Promise<SubscriberPage>`.
    - `getSubscriberDetail(db, id: string): Promise<SubscriberDetail | null>`.
    - `listHistory(db, id: string): Promise<HistoryEntry[] | null>`.
    - `listOptions(db): Promise<ListOptions>`.
    - Types:
      - `SubscriberSummary { id; email; status; source; asItHappens; digest; createdAt: Date; needsAttention: string | null }`.
      - `SubscriberPage { total; page; pageSize; items: SubscriberSummary[] }`.
      - `SubscriberDetail extends SubscriberSummary { verifiedAt; endedAt; attentionAt: Date | null; allNews: boolean; listKeys: string[]; mediaLists: { listKey: string; name: string }[]; disabledReason: "bounces" | "staff" | null; bouncedEmails: number; bounceWindowDays: number }`.
      - `HistoryEntry { at: Date; actor: string; action: string; detail: string }`.
      - `ListOptions { categories: { key: string; name: string; lists: { listKey: string; name: string }[] }[] }`.
  - **From `staff-subscriber-routes.ts`:**
    - `NOD_READ_ROLES = ["NoD.Viewer", "NoD.Editor", "NoD.Admin"] as const`, `NOD_WRITE_ROLES = ["NoD.Editor", "NoD.Admin"] as const`.
    - `privateErrors(handler)`.
    - `staffSubscriberRoutes(db: Db): Router`.
  - **Routes (under `/nod/api`):**
    - `GET /subscribers?q=&status=&page=` → `SubscriberPage`.
    - `GET /subscriber-list-options` → `ListOptions`.
    - `GET /subscribers/:id` → `SubscriberDetail` (404 for a non-uuid or unknown id).
    - `GET /subscribers/:id/history` → `{ items: HistoryEntry[] }`.
  - From `apps/nod/test/staff-auth.ts`: `staffAuth(): Promise<{ auth: BearerOptions; token(roles: string[], name?: string): Promise<string> }>`.

- [ ] **Step 1: Write the test helper**

`apps/nod/test/staff-auth.ts`:

```ts
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { BearerOptions } from "@gcpe/auth";

const issuer = "https://login.microsoftonline.com/t/v2.0";
const audience = "api://nod";

/** An Entra-shaped bearer setup for route tests: `auth` goes to createApp, `token(roles)` signs
 * a five-minute token carrying those roles and a display name (what actorOf() records). */
export async function staffAuth(): Promise<{ auth: BearerOptions; token(roles: string[], name?: string): Promise<string> }> {
  const pair = await generateKeyPair("RS256");
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k", alg: "RS256" }] });
  return {
    auth: { issuer, audience, keys },
    token: (roles, name = "Jamie Staff") =>
      new SignJWT({ roles, name })
        .setProtectedHeader({ alg: "RS256", kid: "k" })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject("staff-1")
        .setExpirationTime("5m")
        .sign(pair.privateKey),
  };
}
```

- [ ] **Step 2: Write the failing tests**

`apps/nod/src/staff-subscribers/read.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../../test/helpers";
import { subscriberHistory, subscribers, subscriptions } from "../db/schema";
import { escapeLike, getSubscriberDetail, listHistory, listOptions, PAGE_SIZE, searchSubscribers } from "./read";

describe("staff subscriber reads", () => {
  let tdb: TestDatabase;
  const add = async (email: string, over: Partial<typeof subscribers.$inferInsert> = {}) =>
    (await tdb.db.insert(subscribers).values({ email, status: "active", ...over }).returning())[0]!;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    await tdb.db.execute(sql`
      INSERT INTO list_categories (key, name, enabled, sort_order) VALUES ('ministries','Ministries',true,1),('sectors','Sectors',false,2),('media-distribution-lists','Media',true,9)
      ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled, sort_order = EXCLUDED.sort_order;
      INSERT INTO lists (list_key, category, key, name, active, sort_order) VALUES
        ('ministries:health','ministries','health','Health',true,1),
        ('ministries:old','ministries','old','Old ministry',false,2),
        ('sectors:energy','sectors','energy','Energy',true,1),
        ('media-distribution-lists:budget','media-distribution-lists','budget','Budget',true,1)`);
  });
  afterAll(async () => tdb.drop());
  beforeEach(async () => {
    await tdb.db.execute(sql`DELETE FROM subscribers`);
  });

  it("search is a case-insensitive, trimmed substring match, ordered by email", async () => {
    await add("zed.pat@example.test");
    await add("Pat@Example.test");
    await add("lee@example.test");
    const r = await searchSubscribers(tdb.db, { q: "  PAT@ ", status: "all", page: 1 });
    expect(r.items.map((s) => s.email)).toEqual(["Pat@Example.test", "zed.pat@example.test"]);
    expect(r.total).toBe(2);
  });

  it("search treats wildcards literally", async () => {
    await add("pat_smith@example.test");
    await add("patxsmith@example.test");
    await add("back\\slash@example.test");
    expect((await searchSubscribers(tdb.db, { q: "pat_smith", status: "all", page: 1 })).items.map((s) => s.email)).toEqual(["pat_smith@example.test"]);
    expect((await searchSubscribers(tdb.db, { q: "%", status: "all", page: 1 })).total).toBe(0);
    expect((await searchSubscribers(tdb.db, { q: "k\\s", status: "all", page: 1 })).total).toBe(1);
    expect(escapeLike("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
  });

  it("filters by status, including disabled and deleted", async () => {
    await add("a@example.test");
    await add("b@example.test", { status: "disabled" });
    await add("c@example.test", { status: "deleted" });
    expect((await searchSubscribers(tdb.db, { q: "", status: "disabled", page: 1 })).items.map((s) => s.email)).toEqual(["b@example.test"]);
    expect((await searchSubscribers(tdb.db, { q: "", status: "all", page: 1 })).total).toBe(3);
  });

  it("pages by PAGE_SIZE and reports the total; a page past the end is empty", async () => {
    for (let i = 0; i < PAGE_SIZE + 1; i++) await add(`p${String(i).padStart(3, "0")}@example.test`);
    const p1 = await searchSubscribers(tdb.db, { q: "", status: "all", page: 1 });
    const p2 = await searchSubscribers(tdb.db, { q: "", status: "all", page: 2 });
    const p9 = await searchSubscribers(tdb.db, { q: "", status: "all", page: 9 });
    expect([p1.items.length, p2.items.length, p9.items.length, p1.total, p1.pageSize]).toEqual([PAGE_SIZE, 1, 0, PAGE_SIZE + 1, PAGE_SIZE]);
  });

  it("detail splits public lists, all news and named media lists, and explains a disabled status", async () => {
    const s = await add("d@example.test", { status: "disabled" });
    await tdb.db.insert(subscriptions).values([
      { subscriberId: s.id, listKey: "*" },
      { subscriberId: s.id, listKey: "ministries:health" },
      { subscriberId: s.id, listKey: "media-distribution-lists:budget" },
    ]);
    await tdb.db.insert(subscriberHistory).values({ subscriberId: s.id, actor: "distribution-bounce", action: "bounce-disabled", detail: "10/15d" });
    const d = await getSubscriberDetail(tdb.db, s.id);
    expect(d).toMatchObject({
      email: "d@example.test", status: "disabled", allNews: true, listKeys: ["ministries:health"],
      mediaLists: [{ listKey: "media-distribution-lists:budget", name: "Budget" }], disabledReason: "bounces", bouncedEmails: 0, bounceWindowDays: 15,
    });
    await tdb.db.insert(subscriberHistory).values({ subscriberId: s.id, actor: "Jamie", action: "staff-deactivated", at: new Date(Date.now() + 1000) });
    expect((await getSubscriberDetail(tdb.db, s.id))!.disabledReason).toBe("staff");
    expect(await getSubscriberDetail(tdb.db, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("history is newest first; an unknown subscriber is null", async () => {
    const s = await add("h@example.test");
    await tdb.db.insert(subscriberHistory).values([
      { subscriberId: s.id, actor: "subscriber", action: "subscribed", at: new Date("2026-10-01T00:00:00Z") },
      { subscriberId: s.id, actor: "Jamie", action: "staff-deactivated", at: new Date("2026-10-02T00:00:00Z") },
    ]);
    expect((await listHistory(tdb.db, s.id))!.map((h) => h.action)).toEqual(["staff-deactivated", "subscribed"]);
    expect(await listHistory(tdb.db, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("list options are enabled public categories' active lists only — never media", async () => {
    // emergency:alerts is seeded by migration 0005 (active, in the enabled "emergency" category).
    expect(await listOptions(tdb.db)).toEqual({
      categories: [
        { key: "ministries", name: "Ministries", lists: [{ listKey: "ministries:health", name: "Health" }] },
        { key: "emergency", name: "Emergency Info BC", lists: [{ listKey: "emergency:alerts", name: "Emergency Info BC Alerts" }] },
      ],
    });
  });
});
```

The `list_categories` seed already exists from migration 0005. The `ON CONFLICT` keeps the test independent of its seeded values.

`apps/nod/src/http/staff-subscriber-routes.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../../test/helpers";
import { staffAuth } from "../../test/staff-auth";
import { createApp } from "../app";
import { privateErrors } from "./staff-subscriber-routes";

describe("staff subscriber routes — reads", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let viewer: string, nrmsEditor: string, admin: string;
  let patId: string;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    const { auth, token } = await staffAuth();
    viewer = await token(["NoD.Viewer"]);
    nrmsEditor = await token(["NRMS.Editor"]);
    admin = await token(["NoD.Admin"]);
    app = createApp({ db: tdb.db, auth, eventSecrets: { nrms: "nrms-secret", core: "core-secret" }, render: { siteUrl: "https://news.gov.bc.ca", bannerUrl: null } });
    const r = await tdb.db.execute<{ id: string }>(sql`INSERT INTO subscribers (email, status) VALUES ('pat@example.test','active') RETURNING id`);
    patId = r.rows[0]!.id;
  });
  afterAll(async () => tdb.drop());

  const get = (path: string, tok?: string) => (tok ? request(app).get(path).set("authorization", `Bearer ${tok}`) : request(app).get(path));

  it("401 without a token; 403 for a non-NoD role; 200 for NoD.Viewer", async () => {
    expect((await get("/api/subscribers")).status).toBe(401);
    expect((await get("/api/subscribers", nrmsEditor)).status).toBe(403);
    const ok = await get("/api/subscribers?q=pat&status=active", viewer);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ total: 1, page: 1, pageSize: 50, items: [{ id: patId, email: "pat@example.test", status: "active" }] });
  });

  it("400 for an unknown status filter", async () => {
    expect((await get("/api/subscribers?status=bogus", viewer)).status).toBe(400);
  });

  it("detail and history: 404 for a non-uuid or unknown id", async () => {
    expect((await get(`/api/subscribers/${patId}`, viewer)).body).toMatchObject({ id: patId, listKeys: [], mediaLists: [] });
    expect((await get(`/api/subscribers/${patId}/history`, viewer)).body).toEqual({ items: [] });
    expect((await get("/api/subscribers/not-a-uuid", viewer)).status).toBe(404);
    expect((await get("/api/subscribers/00000000-0000-0000-0000-000000000000/history", viewer)).status).toBe(404);
  });

  it("the existing count route still wins over /subscribers/:id", async () => {
    // Were /subscribers/:id reached first, "count" would fail the uuid check and answer 404.
    const res = await get("/api/subscribers/count?lists=", admin);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 0 });
  });

  it("privateErrors logs no address: an unexpected error is a bare 500 and only a label is logged", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bare = express();
    bare.get("/boom", privateErrors(async () => {
      throw Object.assign(new Error('Failed query: select … params: pat@example.test'), { cause: { code: "XX000" } });
    }));
    const res = await request(bare).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "internal error" });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("@");
    expect(JSON.stringify(spy.mock.calls)).toContain("XX000");
    spy.mockRestore();
  });
});
```

- [ ] **Step 3: Run; expect FAIL**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/staff-subscribers apps/nod/src/http/staff-subscriber-routes.test.ts`

Expected: the modules don't exist.

- [ ] **Step 4: Implement `read.ts`**

```ts
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import { countBouncedEmails, THRESHOLD_WINDOW_DAYS } from "../bounces";
import { listCategories, lists, subscriberHistory, subscribers, subscriptions, SUBSCRIBER_STATUSES, type SubscriberStatus } from "../db/schema";
import { MEDIA_CATEGORY, PUBLIC_CATEGORIES } from "../lists";

export const STATUS_FILTERS = ["all", ...SUBSCRIBER_STATUSES] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];
/** Fixed, like legacy's paginator: staff page through results, they don't choose a size. */
export const PAGE_SIZE = 50;
/** A subscriber with more history than this is vanishingly rare; the screen shows the newest. */
export const HISTORY_LIMIT = 500;

export interface SubscriberSummary {
  id: string;
  email: string;
  status: SubscriberStatus;
  source: string;
  asItHappens: boolean;
  digest: boolean;
  createdAt: Date;
  needsAttention: string | null;
}
export interface SubscriberPage { total: number; page: number; pageSize: number; items: SubscriberSummary[] }
export interface SubscriberDetail extends SubscriberSummary {
  verifiedAt: Date | null;
  endedAt: Date | null;
  attentionAt: Date | null;
  allNews: boolean;
  /** Public list keys (`<category>:<key>`), never `*` (see allNews) or a media key. */
  listKeys: string[];
  mediaLists: { listKey: string; name: string }[];
  /** Why a `disabled` subscriber is disabled — the latest of bounce-disabled / staff-deactivated in their history; null when not disabled or unexplained (e.g. imported that way). */
  disabledReason: "bounces" | "staff" | null;
  /** Hard-bounced emails counted toward the threshold right now (bounces.ts's own count). */
  bouncedEmails: number;
  bounceWindowDays: number;
}
export interface HistoryEntry { at: Date; actor: string; action: string; detail: string }
export interface ListOptions { categories: { key: string; name: string; lists: { listKey: string; name: string }[] }[] }

/** Escapes LIKE's metacharacters so a staff search for `pat_smith` or `100%` matches those
 * characters literally; paired with `ESCAPE '\'` below. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const summaryColumns = {
  id: subscribers.id,
  email: subscribers.email,
  status: subscribers.status,
  source: subscribers.source,
  asItHappens: subscribers.asItHappens,
  digest: subscribers.digest,
  createdAt: subscribers.createdAt,
  needsAttention: subscribers.needsAttention,
};

export async function searchSubscribers(db: DbOrTx, input: { q: string; status: StatusFilter; page: number }): Promise<SubscriberPage> {
  const term = input.q.trim().toLowerCase();
  const conds: SQL[] = [];
  if (term) conds.push(sql`lower(${subscribers.email}) LIKE ${`%${escapeLike(term)}%`} ESCAPE '\\'`);
  if (input.status !== "all") conds.push(eq(subscribers.status, input.status));
  const where = conds.length ? and(...conds) : undefined;
  const page = Math.max(1, input.page);
  const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(subscribers).where(where)) as [{ n: number }];
  const items = await db
    .select(summaryColumns)
    .from(subscribers)
    .where(where)
    .orderBy(sql`lower(${subscribers.email})`, asc(subscribers.id))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);
  return { total: n, page, pageSize: PAGE_SIZE, items };
}

export async function getSubscriberDetail(db: DbOrTx, id: string): Promise<SubscriberDetail | null> {
  const [s] = await db.select().from(subscribers).where(eq(subscribers.id, id));
  if (!s) return null;
  const subs = await db
    .select({ listKey: subscriptions.listKey, name: lists.name })
    .from(subscriptions)
    .leftJoin(lists, eq(lists.listKey, subscriptions.listKey))
    .where(eq(subscriptions.subscriberId, id))
    .orderBy(asc(subscriptions.listKey));
  const isMedia = (k: string) => k.startsWith(`${MEDIA_CATEGORY}:`);
  let disabledReason: SubscriberDetail["disabledReason"] = null;
  if (s.status === "disabled") {
    const [last] = await db
      .select({ action: subscriberHistory.action })
      .from(subscriberHistory)
      .where(and(eq(subscriberHistory.subscriberId, id), inArray(subscriberHistory.action, ["bounce-disabled", "staff-deactivated"])))
      .orderBy(desc(subscriberHistory.at))
      .limit(1);
    disabledReason = last ? (last.action === "bounce-disabled" ? "bounces" : "staff") : null;
  }
  return {
    id: s.id, email: s.email, status: s.status, source: s.source, asItHappens: s.asItHappens, digest: s.digest,
    createdAt: s.createdAt, needsAttention: s.needsAttention, verifiedAt: s.verifiedAt, endedAt: s.endedAt, attentionAt: s.attentionAt,
    allNews: subs.some((r) => r.listKey === "*"),
    listKeys: subs.filter((r) => r.listKey !== "*" && !isMedia(r.listKey)).map((r) => r.listKey),
    mediaLists: subs.filter((r) => isMedia(r.listKey)).map((r) => ({ listKey: r.listKey, name: r.name ?? r.listKey })),
    disabledReason,
    bouncedEmails: await countBouncedEmails(db, id),
    bounceWindowDays: THRESHOLD_WINDOW_DAYS,
  };
}

export async function listHistory(db: DbOrTx, id: string): Promise<HistoryEntry[] | null> {
  const [s] = await db.select({ id: subscribers.id }).from(subscribers).where(eq(subscribers.id, id));
  if (!s) return null;
  return db
    .select({ at: subscriberHistory.at, actor: subscriberHistory.actor, action: subscriberHistory.action, detail: subscriberHistory.detail })
    .from(subscriberHistory)
    .where(eq(subscriberHistory.subscriberId, id))
    .orderBy(desc(subscriberHistory.at), desc(subscriberHistory.id))
    .limit(HISTORY_LIMIT);
}

/** What the staff preferences form offers: active lists in enabled public categories (the
 * same set the public Subscribe API accepts, lists.ts's activeListKeys), grouped by category
 * in display order. Media lists are never offered here — they're managed per list. */
export async function listOptions(db: DbOrTx): Promise<ListOptions> {
  const rows = await db
    .select({ category: listCategories.key, categoryName: listCategories.name, listKey: lists.listKey, name: lists.name })
    .from(lists)
    .innerJoin(listCategories, eq(listCategories.key, lists.category))
    .where(and(inArray(lists.category, [...PUBLIC_CATEGORIES]), eq(lists.active, true), eq(listCategories.enabled, true)))
    .orderBy(asc(listCategories.sortOrder), asc(lists.sortOrder), asc(lists.name));
  const categories: ListOptions["categories"] = [];
  for (const r of rows) {
    let c = categories.at(-1);
    if (!c || c.key !== r.category) categories.push((c = { key: r.category, name: r.categoryName, lists: [] }));
    c.lists.push({ listKey: r.listKey, name: r.name });
  }
  return { categories };
}
```

- [ ] **Step 5: Implement the router and mount it**

`apps/nod/src/http/staff-subscriber-routes.ts`:

```ts
import { Router, type Request, type Response } from "express";
import { z, ZodError } from "zod";
import type { Db } from "@gcpe/db-kit";
import { requireAnyRole } from "@gcpe/auth";
import { safeErrorLabel } from "../subscribe/journeys";
import { getSubscriberDetail, listHistory, listOptions, searchSubscribers, STATUS_FILTERS } from "../staff-subscribers/read";

/** Spec §8: Viewer reads the Subscribers section; Editor and Admin also change it. */
export const NOD_READ_ROLES = ["NoD.Viewer", "NoD.Editor", "NoD.Admin"] as const;
export const NOD_WRITE_ROLES = ["NoD.Editor", "NoD.Admin"] as const;

const idParam = z.string().uuid();
const searchQuery = z.object({
  q: z.string().max(254).default(""),
  status: z.enum(STATUS_FILTERS).default("all"),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
});

/** Maps this router's domain errors to responses; false for anything else. Grows with the
 * write routes. */
function mapError(e: unknown, res: Response): boolean {
  if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues }), true;
  return false;
}

/**
 * Every handler here runs through this instead of `next(err)`: these routes' queries bind
 * email addresses and search terms, a DrizzleQueryError's message carries its bound params,
 * and the shared jsonErrorHandler logs the whole error. So an unexpected error is answered
 * here as a bare 500 and logged by its Postgres code or error name only.
 */
export function privateErrors<P>(handler: (req: Request<P>, res: Response) => Promise<void>) {
  return (req: Request<P>, res: Response): void => {
    handler(req, res).catch((e: unknown) => {
      if (mapError(e, res)) return;
      console.error("[nod] staff subscriber request failed", safeErrorLabel(e));
      if (!res.headersSent) res.status(500).json({ error: "internal error" });
    });
  };
}

const notFound = (res: Response) => void res.status(404).json({ error: "not found" });

export function staffSubscriberRoutes(db: Db): Router {
  const r = Router();
  const read = requireAnyRole(...NOD_READ_ROLES);

  r.get("/subscribers", read, privateErrors(async (req, res) => {
    res.json(await searchSubscribers(db, searchQuery.parse(req.query)));
  }));

  r.get("/subscriber-list-options", read, privateErrors(async (_req, res) => {
    res.json(await listOptions(db));
  }));

  r.get("/subscribers/:id", read, privateErrors<{ id: string }>(async (req, res) => {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return notFound(res);
    const detail = await getSubscriberDetail(db, id.data);
    if (!detail) return notFound(res);
    res.json(detail);
  }));

  r.get("/subscribers/:id/history", read, privateErrors<{ id: string }>(async (req, res) => {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return notFound(res);
    const items = await listHistory(db, id.data);
    if (!items) return notFound(res);
    res.json({ items });
  }));

  return r;
}
```

`apps/nod/src/http/routes.ts`: import `staffSubscriberRoutes`, then add `r.use(staffSubscriberRoutes(db));` as the last line before `return r;` in `apiRoutes`. It comes after `/subscribers/count`, which therefore still matches first.

- [ ] **Step 6: Run; expect PASS**

Run the Step 3 command, then `apps/nod` in full.

- [ ] **Step 7: Commit**

```bash
git add apps/nod
git commit -m "feat(nod): staff subscriber search, detail, history and list options for NoD Viewer/Editor/Admin"
```

---

### Task 4: NoD staff write API (edit, status, change email, delete, bulk, add)

**Files:**
- Create: `apps/nod/src/staff-subscribers/actions.ts` (+ `actions.test.ts`).
- Modify:
  - `apps/nod/src/subscribe/history.ts` (staff actions);
  - `apps/nod/src/subscribers.ts` (`addSubscriber`);
  - `apps/nod/src/http/staff-subscriber-routes.ts` (+ test);
  - `apps/nod/src/http/routes.ts` (remove its own `POST /subscribers`; re-export the schemas);
  - `apps/nod/src/http/routes.test.ts` (only if an import moves).

**Interfaces:**
- Consumes: `lockAddress`; `replacePublicSubscriptions`, `expireSessionLinks`, `HISTORY_ACTIONS` (Task 2); `activeListKeys`, `MEDIA_CATEGORY`; `hasMediaMemberships`; `NOD_WRITE_ROLES`, `privateErrors` (Task 3).
- Produces:
  - **History actions:** `"staff-added" | "staff-preferences-updated" | "staff-email-changed" | "staff-activated" | "staff-deactivated" | "staff-deleted"`, appended to `HISTORY_ACTIONS`.
  - **Errors:**
    - `SubscriberNotFoundError` → 404;
    - `SubscriberStateError(status)` → 409 `{ error: "status", status }`;
    - `EmailTakenError(id)` → 409 `{ error: "email-taken", id }`;
    - `MediaHubManagedError` → 409 `{ error: "media-hub-managed" }`;
    - `StaffPreferencesError(message)` → 400 `{ error: message }`.
  - **Actions:**
    - `StaffPrefsInput { asItHappens: boolean; digest: boolean; allNews: boolean; listKeys: string[] }`.
    - `updatePreferences(db, id, input, actor): Promise<void>`.
    - `setStatus(db, id, to: "active" | "disabled", actor): Promise<{ changed: boolean }>`.
    - `deleteSubscriber(db, id, actor): Promise<{ changed: boolean }>`.
    - `changeEmail(db, id, newEmail, actor): Promise<{ changed: boolean }>`.
    - `BULK_ACTIONS = ["activate", "deactivate", "delete"] as const`; `BULK_MAX = 200`.
    - `bulkAction(db, ids, action, actor): Promise<BulkResult>`, where `BulkResult { changed: number; skipped: { id: string; reason: "not-found" | "unchanged" | "status" }[] }`.
  - **`addSubscriber(db, input: { email; lists: string[] | "all"; asItHappens?: boolean; digest?: boolean }, actor = "admin-api")`:**
    - lowercases the address;
    - takes the address lock;
    - timing defaults to as-it-happens only (Phase 2's behaviour);
    - writes `staff-added` history.
  - **Routes (under `/nod/api`):**
    - `POST /subscribers` `{ email, lists, asItHappens?, digest? }` → 201 `{ id }`, or 409 `{ error: "subscriber exists", id }`.
    - `PUT /subscribers/:id/preferences` (`StaffPrefsInput`) → 200 `{ ok: true }`.
    - `POST /subscribers/:id/status` `{ status: "active" | "disabled" }` → 200 `{ changed }`.
    - `POST /subscribers/:id/email` `{ email }` → 200 `{ changed }`.
    - `DELETE /subscribers/:id` → 200 `{ changed }`.
    - `POST /subscribers/bulk` `{ action, ids }` → 200 `BulkResult`.
    - All of them: `NOD_WRITE_ROLES`, and 404 for a non-uuid id.
  - `listKeySchema` now also accepts `emergency:<key>`.

- [ ] **Step 1: Write the failing tests**

`apps/nod/src/staff-subscribers/actions.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import type { DeliveryBounced } from "@gcpe/events";
import { createNodTestDb, envelope } from "../../test/helpers";
import { onDeliveryBounced } from "../bounces";
import { deliveries, subscriberHistory, subscribers, subscriptions } from "../db/schema";
import { addMediaMember } from "../media-members";
import { addSubscriber } from "../subscribers";
import { createLink, findLink } from "../subscribe/links";
import {
  bulkAction, changeEmail, deleteSubscriber, EmailTakenError, MediaHubManagedError, setStatus, StaffPreferencesError, SubscriberStateError, updatePreferences,
} from "./actions";

const ACTOR = "Jamie Staff";

describe("staff subscriber actions", () => {
  let tdb: TestDatabase;
  const add = async (email: string, over: Partial<typeof subscribers.$inferInsert> = {}) =>
    (await tdb.db.insert(subscribers).values({ email, status: "active", asItHappens: true, ...over }).returning())[0]!;
  const keys = async (id: string) => (await tdb.db.select().from(subscriptions).where(eq(subscriptions.subscriberId, id))).map((r) => r.listKey).sort();
  const actions = async (id: string) => (await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, id))).map((h) => h.action).sort();

  beforeAll(async () => {
    tdb = await createNodTestDb();
    await tdb.db.execute(sql`INSERT INTO lists (list_key, category, key, name, active) VALUES
      ('ministries:health','ministries','health','Health',true),
      ('ministries:agri','ministries','agri','Agriculture',true),
      ('ministries:old','ministries','old','Old',false),
      ('media-distribution-lists:budget','media-distribution-lists','budget','Budget',true)`);
  });
  afterAll(async () => tdb.drop());
  beforeEach(async () => {
    await tdb.db.execute(sql`DELETE FROM subscriber_links; DELETE FROM subscribers;`);
  });

  it("staff preferences edit keeps media memberships", async () => {
    const { subscriberId } = await addMediaMember(tdb.db, "budget", { email: "both@example.test", source: "manual-media" }, ACTOR);
    await tdb.db.insert(subscriptions).values({ subscriberId, listKey: "ministries:health" });
    await updatePreferences(tdb.db, subscriberId, { asItHappens: true, digest: true, allNews: false, listKeys: ["ministries:agri"] }, ACTOR);
    expect(await keys(subscriberId)).toEqual(["media-distribution-lists:budget", "ministries:agri"]);
    const [h] = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.action, "staff-preferences-updated"));
    expect(h).toMatchObject({ actor: ACTOR, subscriberId });
  });

  it("refuses lists without timing and timing without lists; a media-only member may clear both", async () => {
    const s = await add("p@example.test");
    await expect(updatePreferences(tdb.db, s.id, { asItHappens: false, digest: false, allNews: false, listKeys: ["ministries:health"] }, ACTOR)).rejects.toThrow(StaffPreferencesError);
    await expect(updatePreferences(tdb.db, s.id, { asItHappens: true, digest: false, allNews: false, listKeys: [] }, ACTOR)).rejects.toThrow(StaffPreferencesError);
    await expect(updatePreferences(tdb.db, s.id, { asItHappens: false, digest: false, allNews: false, listKeys: [] }, ACTOR)).rejects.toThrow(StaffPreferencesError);
    const { subscriberId } = await addMediaMember(tdb.db, "budget", { email: "m@example.test", source: "manual-media" }, ACTOR);
    await updatePreferences(tdb.db, subscriberId, { asItHappens: false, digest: false, allNews: false, listKeys: [] }, ACTOR);
    expect(await keys(subscriberId)).toEqual(["media-distribution-lists:budget"]);
  });

  it("keeps a held inactive list, takes all news as '*', and refuses a media or unknown key", async () => {
    const s = await add("k@example.test");
    await tdb.db.insert(subscriptions).values({ subscriberId: s.id, listKey: "ministries:old" });
    await updatePreferences(tdb.db, s.id, { asItHappens: true, digest: false, allNews: false, listKeys: ["ministries:old", "ministries:health"] }, ACTOR);
    expect(await keys(s.id)).toEqual(["ministries:health", "ministries:old"]);
    await updatePreferences(tdb.db, s.id, { asItHappens: true, digest: false, allNews: true, listKeys: ["ministries:health"] }, ACTOR);
    expect(await keys(s.id)).toEqual(["*"]);
    await expect(updatePreferences(tdb.db, s.id, { asItHappens: true, digest: false, allNews: false, listKeys: ["media-distribution-lists:budget"] }, ACTOR)).rejects.toThrow(StaffPreferencesError);
    await expect(updatePreferences(tdb.db, s.id, { asItHappens: true, digest: false, allNews: false, listKeys: ["ministries:nope"] }, ACTOR)).rejects.toThrow(StaffPreferencesError);
  });

  it("refuses to edit a deleted or pending subscriber", async () => {
    const s = await add("gone@example.test", { status: "deleted" });
    await expect(updatePreferences(tdb.db, s.id, { asItHappens: true, digest: false, allNews: true, listKeys: [] }, ACTOR)).rejects.toThrow(SubscriberStateError);
  });

  it("status: deactivate and activate write history; a no-op is unchanged; a deleted subscriber can't be activated", async () => {
    const s = await add("s@example.test");
    expect(await setStatus(tdb.db, s.id, "disabled", ACTOR)).toEqual({ changed: true });
    expect(await setStatus(tdb.db, s.id, "disabled", ACTOR)).toEqual({ changed: false });
    expect(await setStatus(tdb.db, s.id, "active", ACTOR)).toEqual({ changed: true });
    expect(await actions(s.id)).toEqual(["staff-activated", "staff-deactivated"]);
    const [after] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, s.id));
    expect(after!.bounceWindowFrom).not.toBeNull();
    const d = await add("d@example.test", { status: "deleted" });
    await expect(setStatus(tdb.db, d.id, "active", ACTOR)).rejects.toThrow(SubscriberStateError);
  });

  it("reactivation restarts the bounce count", async () => {
    const s = await add("bouncy@example.test", { status: "disabled" });
    for (let i = 0; i < 10; i++) {
      await tdb.db.insert(deliveries).values({ subscriberId: s.id, itemKey: `old-${i}`, attemptedAt: new Date(Date.now() - 3_600_000), distributionBatchId: randomUUID(), hardBouncedAt: new Date(), bounceStatus: "5.1.1" });
    }
    await setStatus(tdb.db, s.id, "active", ACTOR);
    const batchId = randomUUID();
    await tdb.db.insert(deliveries).values({ subscriberId: s.id, itemKey: "new-1", attemptedAt: new Date(Date.now() + 1000), distributionBatchId: batchId });
    const data: DeliveryBounced = { appId: "nod", batchId, messageId: randomUUID(), email: "bouncy@example.test", hard: true, status: "5.1.1", at: new Date().toISOString() };
    const r = await tdb.db.transaction((tx) => onDeliveryBounced(tx, envelope("distribution", "delivery.bounced", data), { appId: "nod" }));
    expect(r.action).toBe("recorded");
    expect((await tdb.db.select().from(subscribers).where(eq(subscribers.id, s.id)))[0]!.status).toBe("active");
  });

  it("delete ends the subscriber and removes media memberships as staff removals, not opt-outs; re-adding needs no confirmOptOut", async () => {
    const { subscriberId } = await addMediaMember(tdb.db, "budget", { email: "del@example.test", source: "manual-media" }, ACTOR);
    expect(await deleteSubscriber(tdb.db, subscriberId, ACTOR)).toEqual({ changed: true });
    expect(await deleteSubscriber(tdb.db, subscriberId, ACTOR)).toEqual({ changed: false });
    const [row] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId));
    expect(row).toMatchObject({ status: "deleted" });
    expect(row!.endedAt).not.toBeNull();
    expect(await keys(subscriberId)).toEqual([]);
    const acts = await actions(subscriberId);
    expect(acts).toEqual(expect.arrayContaining(["staff-deleted", "media-list-removed"]));
    expect(acts).not.toContain("media-list-opted-out");
    expect(acts).not.toContain("unsubscribed");
    await expect(addMediaMember(tdb.db, "budget", { email: "del@example.test", source: "manual-media" }, ACTOR)).resolves.toMatchObject({ subscriberId });
  });

  it("change email moves the address, rotates the unsubscribe token, ends old links and writes history with no address", async () => {
    const s = await add("old@example.test");
    const link = await createLink(tdb.db, { purpose: "manage", email: "old@example.test", subscriberId: s.id, pending: null });
    expect(await changeEmail(tdb.db, s.id, " New@Example.TEST ", ACTOR)).toEqual({ changed: true });
    const [after] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, s.id));
    expect(after).toMatchObject({ email: "new@example.test", unsubscribeVersion: s.unsubscribeVersion + 1 });
    expect((await findLink(tdb.db, link.token))!.expired).toBe(true);
    const [h] = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.action, "staff-email-changed"));
    expect(h!.detail).not.toContain("@");
    expect(await changeEmail(tdb.db, s.id, "NEW@example.test", ACTOR)).toEqual({ changed: false });
  });

  it("change email refuses an address held by any other row (even deleted), and a Media Hub-sourced member", async () => {
    const s = await add("a@example.test");
    const taken = await add("b@example.test", { status: "deleted" });
    const err = await changeEmail(tdb.db, s.id, "b@example.test", ACTOR).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmailTakenError);
    expect((err as EmailTakenError).id).toBe(taken.id);
    expect((await tdb.db.select().from(subscribers).where(eq(subscribers.id, s.id)))[0]!.email).toBe("a@example.test");
    const hub = await add("hub@example.test", { source: "media-hub", mediaHubContactId: 7 });
    await expect(changeEmail(tdb.db, hub.id, "other@example.test", ACTOR)).rejects.toThrow(MediaHubManagedError);
  });

  it("bulk over mixed statuses handles each row on its own and reports what it skipped", async () => {
    const active = await add("b1@example.test");
    const disabled = await add("b2@example.test", { status: "disabled" });
    const deleted = await add("b3@example.test", { status: "deleted" });
    const missing = "00000000-0000-0000-0000-000000000000";
    const r = await bulkAction(tdb.db, [active.id, disabled.id, deleted.id, missing, disabled.id], "activate", ACTOR);
    expect(r.changed).toBe(1);
    expect(r.skipped).toEqual([
      { id: active.id, reason: "unchanged" },
      { id: deleted.id, reason: "status" },
      { id: missing, reason: "not-found" },
    ]);
  });

  it("addSubscriber lowercases, takes timing, and writes staff-added history", async () => {
    const { id } = await addSubscriber(tdb.db, { email: "New.Person@Example.test", lists: ["ministries:health"], asItHappens: false, digest: true }, ACTOR);
    const [row] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, id));
    expect(row).toMatchObject({ email: "new.person@example.test", status: "active", source: "admin", asItHappens: false, digest: true });
    expect(await actions(id)).toEqual(["staff-added"]);
  });
});
```

`apps/nod/src/http/staff-subscriber-routes.test.ts`, add a second describe:

```ts
describe("staff subscriber routes — writes", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let viewer: string, editor: string, admin: string;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    const { auth, token } = await staffAuth();
    [viewer, editor, admin] = await Promise.all([token(["NoD.Viewer"]), token(["NoD.Editor"]), token(["NoD.Admin"])]);
    app = createApp({ db: tdb.db, auth, eventSecrets: { nrms: "nrms-secret", core: "core-secret" }, render: { siteUrl: "https://news.gov.bc.ca", bannerUrl: null } });
    await tdb.db.execute(sql`INSERT INTO lists (list_key, category, key, name) VALUES ('ministries:health','ministries','health','Health')`);
  });
  afterAll(async () => tdb.drop());

  const send = (method: "post" | "put" | "delete", path: string, tok: string, body?: unknown) =>
    request(app)[method](path).set("authorization", `Bearer ${tok}`).send(body as object);

  it("Viewer can't write; Editor and Admin can add", async () => {
    expect((await send("post", "/api/subscribers", viewer, { email: "v@example.test", lists: "all" })).status).toBe(403);
    expect((await send("post", "/api/subscribers", editor, { email: "e@example.test", lists: ["ministries:health"], digest: true })).status).toBe(201);
    expect((await send("post", "/api/subscribers", admin, { email: "a@example.test", lists: "all" })).status).toBe(201);
  });

  it("adding an existing address answers 409 with that subscriber's id; neither timing is 400", async () => {
    const first = await send("post", "/api/subscribers", editor, { email: "dupe@example.test", lists: "all" });
    const dup = await send("post", "/api/subscribers", editor, { email: "DUPE@example.test", lists: "all" });
    expect(dup.status).toBe(409);
    expect(dup.body).toEqual({ error: "subscriber exists", id: first.body.id });
    expect((await send("post", "/api/subscribers", editor, { email: "none@example.test", lists: "all", asItHappens: false })).status).toBe(400);
  });

  it("preferences, status, email, delete and bulk round trip with their error shapes", async () => {
    const { body: { id } } = await send("post", "/api/subscribers", editor, { email: "rt@example.test", lists: "all" });
    expect((await send("put", `/api/subscribers/${id}/preferences`, editor, { asItHappens: false, digest: false, allNews: true, listKeys: [] })).body).toEqual({ error: "Choose As It Happens, Daily Digest, or both." });
    expect((await send("put", `/api/subscribers/${id}/preferences`, editor, { asItHappens: true, digest: false, allNews: false, listKeys: ["ministries:health"] })).body).toEqual({ ok: true });
    expect((await send("post", `/api/subscribers/${id}/status`, editor, { status: "disabled" })).body).toEqual({ changed: true });
    expect((await send("post", `/api/subscribers/${id}/email`, editor, { email: "dupe@example.test" })).body).toMatchObject({ error: "email-taken" });
    expect((await send("post", `/api/subscribers/${id}/email`, editor, { email: "rt2@example.test" })).body).toEqual({ changed: true });
    expect((await send("delete", `/api/subscribers/${id}`, editor)).body).toEqual({ changed: true });
    expect((await send("post", `/api/subscribers/${id}/status`, editor, { status: "active" })).body).toEqual({ error: "status", status: "deleted" });
    expect((await send("post", "/api/subscribers/bulk", editor, { action: "delete", ids: [id] })).body).toEqual({ changed: 0, skipped: [{ id, reason: "unchanged" }] });
    expect((await send("post", "/api/subscribers/bulk", editor, { action: "delete", ids: Array.from({ length: 201 }, () => randomUUID()) })).status).toBe(400);
    expect((await send("post", "/api/subscribers/not-a-uuid/status", editor, { status: "active" })).status).toBe(404);
  });
});
```

Add `import { randomUUID } from "node:crypto";` at the top of the routes test.

- [ ] **Step 2: Run; expect FAIL**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/staff-subscribers apps/nod/src/http`

Expected: `actions.ts` is missing, and the new routes 404.

- [ ] **Step 3: Implement**

`apps/nod/src/subscribe/history.ts`, append to `HISTORY_ACTIONS`:

```ts
  "staff-added",
  "staff-preferences-updated",
  "staff-email-changed",
  "staff-activated",
  "staff-deactivated",
  "staff-deleted",
```

`apps/nod/src/staff-subscribers/actions.ts`:

```ts
/**
 * Staff changes to one subscriber (spec §8). Each runs in its own transaction, takes the
 * per-address lock (locks.ts) before reading the row FOR UPDATE, and writes history with the
 * staff member's display name as the actor.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "@gcpe/db-kit";
import { subscribers, subscriptions, type SubscriberRow, type SubscriberStatus } from "../db/schema";
import { activeListKeys, MEDIA_CATEGORY } from "../lists";
import { lockAddress } from "../locks";
import { hasMediaMemberships } from "../media-members";
import { replacePublicSubscriptions } from "../subscribers";
import { writeHistory } from "../subscribe/history";
import { normaliseEmail } from "../subscribe/info";
import { expireSessionLinks } from "../subscribe/links";

export class SubscriberNotFoundError extends Error {
  constructor() { super("not found"); }
}
/** The subscriber's current status doesn't allow this change (e.g. activating a deleted one). */
export class SubscriberStateError extends Error {
  constructor(public readonly status: SubscriberStatus) { super("status"); }
}
/** Another subscriber row — whatever its status — already has the address. */
export class EmailTakenError extends Error {
  constructor(public readonly id: string) { super("email-taken"); }
}
/** A Media Hub-sourced member's address follows Media Hub (the nightly sync would undo a staff
 * edit); it's changed in Media Hub, or re-pointed through the media list's resolve action. */
export class MediaHubManagedError extends Error {
  constructor() { super("media-hub-managed"); }
}
export class StaffPreferencesError extends Error {}

export interface StaffPrefsInput { asItHappens: boolean; digest: boolean; allNews: boolean; listKeys: string[] }

export const BULK_ACTIONS = ["activate", "deactivate", "delete"] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];
/** Comfortably above one page of search results (read.ts's PAGE_SIZE). */
export const BULK_MAX = 200;
export interface BulkResult { changed: number; skipped: { id: string; reason: "not-found" | "unchanged" | "status" }[] }

const isMediaKey = (k: string) => k.startsWith(`${MEDIA_CATEGORY}:`);

/** Locks the row's address, then reads the row FOR UPDATE. If the address changed between the
 * unlocked read and the lock, the new address is locked too, so this never holds a row whose
 * current address some other writer could be working on. */
async function lockSubscriber(tx: Tx, id: string): Promise<SubscriberRow | null> {
  const [before] = await tx.select({ email: subscribers.email }).from(subscribers).where(eq(subscribers.id, id));
  if (!before) return null;
  await lockAddress(tx, before.email.toLowerCase());
  const [row] = await tx.select().from(subscribers).where(eq(subscribers.id, id)).for("update");
  if (row && row.email.toLowerCase() !== before.email.toLowerCase()) await lockAddress(tx, row.email.toLowerCase());
  return row ?? null;
}

/** `*`, an active list in an enabled public category, or a public key this subscriber already
 * holds even if its list has since gone inactive — so saving the form never silently drops a
 * subscription it had no checkbox for. Anything else, media keys included, is refused. */
async function allowedPublicKeys(tx: Tx, id: string, requested: string[]): Promise<string[]> {
  const wanted = [...new Set(requested.map((k) => k.trim().toLowerCase()))];
  const active = new Set(await activeListKeys(tx, wanted));
  const heldRows = await tx.select({ listKey: subscriptions.listKey }).from(subscriptions).where(eq(subscriptions.subscriberId, id));
  const held = new Set(heldRows.map((r) => r.listKey).filter((k) => !isMediaKey(k)));
  const refused = wanted.filter((k) => !active.has(k) && !held.has(k));
  if (refused.length) throw new StaffPreferencesError(`Not a list subscribers can choose: ${refused.join(", ")}`);
  return wanted;
}

export async function updatePreferences(db: Db, id: string, input: StaffPrefsInput, actor: string): Promise<void> {
  await db.transaction(async (tx) => {
    const s = await lockSubscriber(tx, id);
    if (!s) throw new SubscriberNotFoundError();
    if (s.status !== "active" && s.status !== "disabled") throw new SubscriberStateError(s.status);
    const keys = await allowedPublicKeys(tx, id, input.allNews ? ["*"] : input.listKeys);
    const hasTiming = input.asItHappens || input.digest;
    if (keys.length > 0 && !hasTiming) throw new StaffPreferencesError("Choose As It Happens, Daily Digest, or both.");
    // Nothing public at all is only right for someone who's here for media lists alone.
    if (keys.length === 0 && (hasTiming || !(await hasMediaMemberships(tx, id)))) throw new StaffPreferencesError("Choose at least one list, or all news.");
    await tx.update(subscribers).set({ asItHappens: input.asItHappens, digest: input.digest }).where(eq(subscribers.id, id));
    await replacePublicSubscriptions(tx, id, keys);
    const timing = [input.asItHappens && "as-it-happens", input.digest && "digest"].filter(Boolean).join(", ") || "none";
    await writeHistory(tx, id, actor, "staff-preferences-updated", `${timing}; ${keys.join(", ") || "no lists"}`);
  });
}

export async function setStatus(db: Db, id: string, to: "active" | "disabled", actor: string): Promise<{ changed: boolean }> {
  return db.transaction(async (tx) => {
    const s = await lockSubscriber(tx, id);
    if (!s) throw new SubscriberNotFoundError();
    if (s.status === to) return { changed: false };
    if (to === "active") {
      // Only a disabled subscriber comes back this way: a deleted one unsubscribed (only their
      // own re-subscribe restores them), and a pending one never confirmed.
      if (s.status !== "disabled") throw new SubscriberStateError(s.status);
      await tx.update(subscribers).set({ status: "active", bounceWindowFrom: sql`now()` }).where(eq(subscribers.id, id));
      await writeHistory(tx, id, actor, "staff-activated");
    } else {
      if (s.status !== "active") throw new SubscriberStateError(s.status);
      await tx.update(subscribers).set({ status: "disabled" }).where(eq(subscribers.id, id));
      await writeHistory(tx, id, actor, "staff-deactivated");
    }
    return { changed: true };
  });
}

/** Staff delete = unsubscribe on the subscriber's behalf: `deleted`, `ended_at` set. Media
 * memberships go too (a deleted subscriber is sent nothing, so keeping them would only inflate
 * list counts), recorded as staff removals — never `media-list-opted-out`/`unsubscribed`,
 * which mean the person themselves opted out and make a later media re-add need confirmOptOut. */
export async function deleteSubscriber(db: Db, id: string, actor: string): Promise<{ changed: boolean }> {
  return db.transaction(async (tx) => {
    const s = await lockSubscriber(tx, id);
    if (!s) throw new SubscriberNotFoundError();
    if (s.status === "deleted") return { changed: false };
    await tx.update(subscribers).set({ status: "deleted", endedAt: sql`now()` }).where(eq(subscribers.id, id));
    await writeHistory(tx, id, actor, "staff-deleted");
    const removed = await tx
      .delete(subscriptions)
      .where(and(eq(subscriptions.subscriberId, id), sql`${subscriptions.listKey} LIKE ${`${MEDIA_CATEGORY}:%`}`))
      .returning({ listKey: subscriptions.listKey });
    for (const { listKey } of removed) await writeHistory(tx, id, actor, "media-list-removed", listKey);
    return { changed: true };
  });
}

/** Staff-initiated: no verification email (spec §8). Refused when any other row has the
 * address (legacy `ChangeUsersSubscriptionEmail` refuses too, and refusing means no row is ever
 * deleted and no history lost). Rotates the unsubscribe token and ends every outstanding link,
 * since those went to the old address. History records the change, never the addresses. */
export async function changeEmail(db: Db, id: string, rawEmail: string, actor: string): Promise<{ changed: boolean }> {
  const email = normaliseEmail(rawEmail);
  return db.transaction(async (tx) => {
    const [before] = await tx.select({ email: subscribers.email }).from(subscribers).where(eq(subscribers.id, id));
    if (!before) throw new SubscriberNotFoundError();
    // Both addresses, in a fixed order, so two staff moving A→B and B→A at once can't deadlock.
    for (const address of [...new Set([before.email.toLowerCase(), email])].sort()) await lockAddress(tx, address);
    const [s] = await tx.select().from(subscribers).where(eq(subscribers.id, id)).for("update");
    if (!s) throw new SubscriberNotFoundError();
    if (s.email.toLowerCase() !== before.email.toLowerCase()) await lockAddress(tx, s.email.toLowerCase());
    if (s.status === "deleted") throw new SubscriberStateError(s.status);
    if (s.source === "media-hub") throw new MediaHubManagedError();
    if (s.email.toLowerCase() === email) return { changed: false };
    const [taken] = await tx.select({ id: subscribers.id }).from(subscribers).where(sql`lower(${subscribers.email}) = ${email}`);
    if (taken) throw new EmailTakenError(taken.id);
    await tx.update(subscribers).set({ email, unsubscribeVersion: sql`${subscribers.unsubscribeVersion} + 1` }).where(eq(subscribers.id, id));
    await expireSessionLinks(tx, id, null);
    await writeHistory(tx, id, actor, "staff-email-changed");
    return { changed: true };
  });
}

/** One transaction per subscriber, not one for the batch: a single transaction would hold up
 * to BULK_MAX address locks until the end and block every journey touching any of them, and
 * one row's refusal would roll back all the rest. Each outcome is reported instead. */
export async function bulkAction(db: Db, ids: string[], action: BulkAction, actor: string): Promise<BulkResult> {
  const result: BulkResult = { changed: 0, skipped: [] };
  for (const id of [...new Set(ids)]) {
    try {
      const { changed } = action === "delete" ? await deleteSubscriber(db, id, actor) : await setStatus(db, id, action === "activate" ? "active" : "disabled", actor);
      if (changed) result.changed++;
      else result.skipped.push({ id, reason: "unchanged" });
    } catch (e) {
      if (e instanceof SubscriberNotFoundError) result.skipped.push({ id, reason: "not-found" });
      else if (e instanceof SubscriberStateError) result.skipped.push({ id, reason: "status" });
      else throw e;
    }
  }
  return result;
}
```

`apps/nod/src/subscribers.ts`, `addSubscriber`. Keep the existing doc comment and add to it: "Lowercases the address, takes the address lock like every other writer, and writes `staff-added` history."

```ts
export interface AddSubscriberInput {
  email: string;
  /** "all" subscribes to every list ('*'); otherwise one or more index keys (e.g. "ministries:Health"). */
  lists: string[] | "all";
  /** Default true, and digest default false: Phase 2's admin adds were as-it-happens only. */
  asItHappens?: boolean;
  digest?: boolean;
}

export async function addSubscriber(db: Db, input: AddSubscriberInput, actor = "admin-api"): Promise<{ id: string }> {
  const email = normaliseEmail(input.email);
  const listKeys = input.lists === "all" ? ["*"] : [...new Set(input.lists.map((key) => key.toLowerCase()))];
  try {
    return await db.transaction(async (tx) => {
      await lockAddress(tx, email);
      const [row] = await tx
        .insert(subscribers)
        .values({ email, verifiedAt: new Date(), status: "active", source: "admin", asItHappens: input.asItHappens ?? true, digest: input.digest ?? false })
        .returning({ id: subscribers.id });
      const subscriberId = row!.id;
      if (listKeys.length > 0) await tx.insert(subscriptions).values(listKeys.map((listKey) => ({ subscriberId, listKey })));
      await writeHistory(tx, subscriberId, actor, "staff-added", listKeys.join(", "));
      return { id: subscriberId };
    });
  } catch (e) {
    // (keep the existing comment and 23505 → SubscriberExistsError mapping unchanged)
  }
}
```

Imports: `lockAddress` from `./locks`, `writeHistory` from `./subscribe/history`, `normaliseEmail` from `./subscribe/info`. Check for an import cycle: `subscribe/info.ts` imports `lists.ts` only, and `history.ts` imports schema only, so there isn't one.

`apps/nod/src/http/staff-subscriber-routes.ts`:
- Move `listKeySchema` and `addSubscriberSchema` here from `routes.ts`, widened.
- Extend `mapError`.
- Add the write routes.

```ts
/** '*' is "all" in addSubscriberSchema; otherwise '<category>:<key>' in a public category. */
export const listKeySchema = z
  .string()
  .regex(/^(ministries|sectors|themes|tags|emergency):.+$/i, "must be '<kind>:<key>' with kind in ministries|sectors|themes|tags|emergency");

export const addSubscriberSchema = z
  .object({
    email: emailAddressSchema,
    lists: z.union([z.literal("all"), z.array(listKeySchema)]),
    asItHappens: z.boolean().optional(),
    digest: z.boolean().optional(),
  })
  .refine((b) => (b.asItHappens ?? true) || b.digest === true, { message: "Choose As It Happens, Daily Digest, or both.", path: ["asItHappens"] });

const prefsBody = z.object({ asItHappens: z.boolean(), digest: z.boolean(), allNews: z.boolean(), listKeys: z.array(z.string().max(200)).max(500) });
const statusBody = z.object({ status: z.enum(["active", "disabled"]) });
const emailBody = z.object({ email: z.string().trim().max(254).email() });
const bulkBody = z.object({ action: z.enum(BULK_ACTIONS), ids: z.array(z.string().uuid()).min(1).max(BULK_MAX) });
```

`mapError` additions, before `return false`:

```ts
  if (e instanceof SubscriberNotFoundError) return void res.status(404).json({ error: "not found" }), true;
  if (e instanceof SubscriberStateError) return void res.status(409).json({ error: "status", status: e.status }), true;
  if (e instanceof EmailTakenError) return void res.status(409).json({ error: "email-taken", id: e.id }), true;
  if (e instanceof MediaHubManagedError) return void res.status(409).json({ error: "media-hub-managed" }), true;
  if (e instanceof StaffPreferencesError) return void res.status(400).json({ error: e.message }), true;
```

Routes, inside `staffSubscriberRoutes` (with `const write = requireAnyRole(...NOD_WRITE_ROLES);` and `actorOf` from `@gcpe/auth`):

```ts
  /** Adds a subscriber, active at once with no verification email (C51). Also the Phase 2
   * admin/service add, which keeps working: same path, body and response, with timing optional. */
  r.post("/subscribers", write, privateErrors(async (req, res) => {
    const parsed = addSubscriberSchema.parse(req.body);
    try {
      res.status(201).json(await addSubscriber(db, parsed, actorOf(req).name));
    } catch (e) {
      if (!(e instanceof SubscriberExistsError)) throw e;
      const [row] = await db.select({ id: subscribers.id }).from(subscribers).where(sql`lower(${subscribers.email}) = ${normaliseEmail(parsed.email)}`);
      res.status(409).json({ error: "subscriber exists", id: row?.id ?? null });
    }
  }));

  r.post("/subscribers/bulk", write, privateErrors(async (req, res) => {
    const { action, ids } = bulkBody.parse(req.body);
    res.json(await bulkAction(db, ids, action, actorOf(req).name));
  }));

  const withId = (h: (id: string, req: Request<{ id: string }>, res: Response) => Promise<void>) =>
    privateErrors<{ id: string }>(async (req, res) => {
      const id = idParam.safeParse(req.params.id);
      if (!id.success) return notFound(res);
      await h(id.data, req, res);
    });

  r.put("/subscribers/:id/preferences", write, withId(async (id, req, res) => {
    await updatePreferences(db, id, prefsBody.parse(req.body), actorOf(req).name);
    res.json({ ok: true });
  }));
  r.post("/subscribers/:id/status", write, withId(async (id, req, res) => {
    res.json(await setStatus(db, id, statusBody.parse(req.body).status, actorOf(req).name));
  }));
  r.post("/subscribers/:id/email", write, withId(async (id, req, res) => {
    res.json(await changeEmail(db, id, emailBody.parse(req.body).email, actorOf(req).name));
  }));
  r.delete("/subscribers/:id", write, withId(async (id, req, res) => {
    res.json(await deleteSubscriber(db, id, actorOf(req).name));
  }));
```

Rewrite the two existing `GET /subscribers/:id` handlers with `withId` too (DRY).

`apps/nod/src/http/routes.ts`:
- delete its `r.post("/subscribers", …)` block and its `listKeySchema` / `addSubscriberSchema` definitions;
- add `export { addSubscriberSchema, listKeySchema } from "./staff-subscriber-routes";`;
- import `listKeySchema` from there for `countListKeySchema`;
- remove now-unused imports (`addSubscriber`, `SubscriberExistsError`).

The existing `routes.test.ts` add-subscriber tests must pass unchanged. They use `NoD.Admin`, which is in `NOD_WRITE_ROLES`.

- [ ] **Step 4: Run; expect PASS**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod`. Also run `apps/stack`: its tests call `POST /nod/api/subscribers`.

- [ ] **Step 5: Type-check and commit**

```bash
git add apps/nod
git commit -m "feat(nod): staff subscriber edit, status, change email, delete, bulk and add"
```

---

### Task 5: staff-web Subscribers section: nav, landing, search/list with bulk actions, Add

**Files:**
- Create, under `apps/staff-web/src/screens/subscribers/`:
  - `access.ts`, `types.ts`, `labels.ts`;
  - `SubscribersSection.tsx`;
  - `SubscribersScreen.tsx` (+ `.test.tsx`);
  - `AddSubscriberScreen.tsx` (+ `.test.tsx`);
  - `ListPicker.tsx`;
  - `a11y.test.tsx`.
- Create: `apps/staff-web/src/shell/HomeRedirect.tsx`.
- Modify:
  - `apps/staff-web/src/shell/AppShell.tsx` (+ `AppShell.test.tsx`);
  - `apps/staff-web/src/router.tsx` (+ `router.test.tsx`).

**Interfaces:**
- Consumes: the Task 3/4 routes and shapes.
- Produces:
  - **`access.ts`:**
    - `canReadSubscribers(s: SessionValue): boolean` — any of `NoD.Viewer | NoD.Editor | NoD.Admin`;
    - `canEditSubscribers(s)` — `NoD.Editor | NoD.Admin`.
  - **`types.ts`:** `SubscriberStatus`, `StatusFilter`, `SubscriberSummary`, `SubscriberPage`, `SubscriberDetail`, `HistoryEntry`, `ListOptions`, `BulkAction`, `BulkResult`.
    - These mirror Task 3/4's shapes, with dates as ISO `string`. They are defined locally: browser code can't import `apps/nod`.
  - **`labels.ts`:**
    - `STATUS_LABELS: Record<SubscriberStatus, string>`, `STATUS_FILTER_OPTIONS`;
    - `timingLabel({ asItHappens, digest }): string`;
    - `HISTORY_LABELS: Record<string, string>`, `historyLabel(action)`, `actorLabel(actor)`.
    - Task 6 adds history labels' test parity.
  - **`ListPicker`** props: `{ categories: ListOptions["categories"]; allNews: boolean; listKeys: string[]; heldKeys?: string[]; onChange(next: { allNews: boolean; listKeys: string[] }): void; disabled?: boolean }`.
  - **Routes:**
    - `/hub/subscribers` (search);
    - `/hub/subscribers/new` (Add);
    - `/hub/subscribers/:id` and `/hub/subscribers/:id/history`. Their routes are added here with temporary `null` elements, and Task 6 fills them.
  - **`HomeRedirect`:** the index route. A user with a NoD read role and no NRMS role lands on `/subscribers`; everyone else lands on `/releases/drafts`.

- [ ] **Step 1: Write the failing tests**

`AppShell.test.tsx`:
- add `"Subscribers"` to `allLabels`, between `"Website"` and `"Users"`;
- the existing three expectations stay as they are (none of those roles is a NoD role);
- add:

```ts
  it("each NoD role sees Subscribers; NRMS roles don't", async () => {
    await renderShell(["NoD.Viewer"]);
    expect(visibleLabels()).toEqual(["Subscribers"]);
    cleanup();
    await renderShell(["NoD.Editor", "NRMS.Editor"]);
    expect(visibleLabels()).toEqual(["Releases", "Search", "Website", "Subscribers"]);
  });
```

`router.test.tsx`, add:

```ts
  it("a NoD-only user lands on Subscribers; /hub/subscribers/new is the Add screen for an Editor", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "1", name: "Pat", email: "pat@x.invalid", roles: ["NoD.Editor"] }, expiresAt: new Date().toISOString() });
      if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
      if (url.startsWith("/nod/api/subscribers?")) return jsonResponse(200, { total: 0, page: 1, pageSize: 50, items: [] });
      if (url === "/nod/api/subscriber-list-options") return jsonResponse(200, { categories: [] });
      throw new Error(`unexpected fetch: ${url}`);
    }));
    const router = createMemoryRouter(routes, { basename: "/hub", initialEntries: ["/hub/"] });
    render(<SessionProvider><RouterProvider router={router} /></SessionProvider>);
    expect(await screen.findByRole("heading", { level: 1, name: "Subscribers" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/hub/subscribers");
    router.navigate("/subscribers/new");
    expect(await screen.findByRole("heading", { level: 1, name: "Add a subscriber" })).toBeInTheDocument();
  });
```

`SubscribersScreen.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { SubscribersScreen } from "./SubscribersScreen";
import type { SubscriberPage } from "./types";

const PAGE: SubscriberPage = {
  total: 2, page: 1, pageSize: 50,
  items: [
    { id: "11111111-1111-1111-1111-111111111111", email: "pat@example.test", status: "active", source: "self", asItHappens: true, digest: false, createdAt: "2026-10-01T17:00:00.000Z", needsAttention: null },
    { id: "22222222-2222-2222-2222-222222222222", email: "lee@example.test", status: "disabled", source: "admin", asItHappens: false, digest: true, createdAt: "2026-10-02T17:00:00.000Z", needsAttention: null },
  ],
};

type Call = { url: string; method: string; body: unknown };
function stub(roles: string[], onBulk?: (body: unknown) => unknown) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
    if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
    if (url.startsWith("/nod/api/subscribers?")) return jsonResponse(200, PAGE);
    if (url === "/nod/api/subscribers/bulk") return jsonResponse(200, onBulk?.(JSON.parse(String(init!.body))) ?? { changed: 0, skipped: [] });
    throw new Error(`unhandled: ${url}`);
  }));
  return calls;
}

function renderAt(path = "/subscribers") {
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={[path]}>
        <RequireAuth>
          <Routes><Route path="/subscribers" element={<SubscribersScreen />} /></Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe("SubscribersScreen", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });

  it("sets the title and lists results with status and timing", async () => {
    stub(["NoD.Viewer"]);
    renderAt();
    expect(await screen.findByRole("link", { name: "pat@example.test" })).toHaveAttribute("href", "/subscribers/11111111-1111-1111-1111-111111111111");
    expect(screen.getByRole("cell", { name: "Disabled" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Daily digest" })).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe("Subscribers — GCPE News Staff"));
  });

  it("searching and filtering go through the URL into the request", async () => {
    const calls = stub(["NoD.Viewer"]);
    renderAt();
    const user = userEvent.setup();
    await screen.findByRole("link", { name: "pat@example.test" });
    await user.type(screen.getByRole("textbox", { name: "Email contains" }), "pat_");
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "disabled");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/nod/api/subscribers?q=pat_&status=disabled&page=1")).toBe(true));
  });

  it("a Viewer gets no selection checkboxes, bulk actions or Add link", async () => {
    stub(["NoD.Viewer"]);
    renderAt();
    await screen.findByRole("link", { name: "pat@example.test" });
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /selected/ })).toBeNull();
    expect(screen.queryByRole("link", { name: "Add a subscriber" })).toBeNull();
  });

  it("bulk delete asks first; Cancel sends nothing; Confirm sends the selected ids and reports the outcome", async () => {
    const calls = stub(["NoD.Editor"], () => ({ changed: 1, skipped: [{ id: "22222222-2222-2222-2222-222222222222", reason: "unchanged" }] }));
    renderAt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: "Select all on this page" }));
    await user.click(screen.getByRole("button", { name: "Delete selected (2)" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Delete 2 subscribers?")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(calls.some((c) => c.url === "/nod/api/subscribers/bulk")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Delete selected (2)" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/nod/api/subscribers/bulk")?.body).toEqual({ action: "delete", ids: PAGE.items.map((i) => i.id) }));
    expect(await screen.findByRole("status")).toHaveTextContent("1 changed. 1 skipped: already in that state.");
  });
});
```

`AddSubscriberScreen.test.tsx`:

```tsx
// same imports/stub style; routes: <Route path="/subscribers/new" element={<AddSubscriberScreen />} /> and
// <Route path="/subscribers/:id" element={<p>detail page</p>} />
const OPTIONS = { categories: [{ key: "ministries", name: "Ministries", lists: [{ listKey: "ministries:health", name: "Health" }] }] };

describe("AddSubscriberScreen", () => {
  it("refuses a confirm-email mismatch without sending", async () => {
    // fill Email "a@example.test", Confirm email "b@example.test", tick Health, As it happens, click Add subscriber
    // expect alert "The two email addresses don't match." and no POST /nod/api/subscribers
  });

  it("posts email, lists and timing and opens the new subscriber", async () => {
    // POST returns 201 { id: "33333333-3333-3333-3333-333333333333" }
    // expect body { email: "new@example.test", lists: ["ministries:health"], asItHappens: true, digest: false }
    // expect screen.findByText("detail page")
  });

  it("sends lists: 'all' when All news is ticked", async () => { /* body.lists === "all" */ });

  it("an existing address links to that subscriber", async () => {
    // POST returns 409 { error: "subscriber exists", id: "44444444-…" }
    // expect link "Open their record" href "/subscribers/44444444-…"
  });

  it("a Viewer sees a permission message, not the form", async () => {
    // roles ["NoD.Viewer"]: heading "Add a subscriber", text "You don't have permission to add subscribers.", no textbox
  });
});
```

Write these out fully in the file's own style: the `stub` helper as above, plus `userEvent` for `type`/`click`. The comments above list the exact inputs and assertions for each.

`a11y.test.tsx` (the `admin/a11y.test.tsx` shape): one test per screen, rendering it populated and running `seriousViolations`:
- `SubscribersScreen` as an Editor, so checkboxes and bulk buttons are present;
- the same screen with the bulk delete dialog open;
- `AddSubscriberScreen` with options loaded.

- [ ] **Step 2: Run; expect FAIL**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/shell apps/staff-web/src/router.test.tsx apps/staff-web/src/screens/subscribers`

- [ ] **Step 3: Implement**

`access.ts`:

```ts
import type { SessionValue } from "../../session/SessionContext";

/** Spec §8: NoD.Viewer reads the Subscribers section; NoD.Editor and NoD.Admin also change it.
 * The NoD API enforces the same split (NOD_READ_ROLES/NOD_WRITE_ROLES); this only decides
 * what's shown. */
export function canReadSubscribers(s: SessionValue): boolean {
  return s.has("NoD.Viewer") || s.has("NoD.Editor") || s.has("NoD.Admin");
}
export function canEditSubscribers(s: SessionValue): boolean {
  return s.has("NoD.Editor") || s.has("NoD.Admin");
}
```

`labels.ts`, the status and timing part; Task 6 adds history:

```ts
import type { StatusFilter, SubscriberStatus } from "./types";

export const STATUS_LABELS: Record<SubscriberStatus, string> = {
  pending: "Pending",
  active: "Active",
  disabled: "Disabled",
  deleted: "Unsubscribed or deleted",
};

export const STATUS_FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "disabled", label: "Disabled" },
  { value: "deleted", label: "Unsubscribed or deleted" },
  { value: "pending", label: "Pending" },
];

export function timingLabel(s: { asItHappens: boolean; digest: boolean }): string {
  if (s.asItHappens && s.digest) return "As it happens and daily digest";
  if (s.asItHappens) return "As it happens";
  if (s.digest) return "Daily digest";
  return "None (media lists only)";
}
```

`SubscribersSection.tsx`, the same shape as `WebsiteScreen`:

```tsx
import { NavLink, Outlet } from "react-router";
import { useSession } from "../../session/SessionContext";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { canEditSubscribers, canReadSubscribers } from "./access";

/** `/hub/subscribers/*`: the section's sub-nav plus `<Outlet/>`. No h1 of its own except the
 * permission-denied branch (each sub-screen owns its h1 and title). Lists & categories, Media
 * lists, Reports and Operations join this sub-nav later. */
export function SubscribersSection(): React.JSX.Element {
  const session = useSession();
  const canRead = canReadSubscribers(session);
  useDocumentTitle(!canRead ? "Subscribers" : null);
  if (!canRead) {
    return (
      <div className="gcpe-subscribers">
        <h1>Subscribers</h1>
        <p>You don&rsquo;t have permission to view subscribers.</p>
      </div>
    );
  }
  return (
    <div className="gcpe-subscribers">
      <nav aria-label="Subscribers sections">
        <ul>
          <li><NavLink to="/subscribers" end>Find subscribers</NavLink></li>
          {canEditSubscribers(session) && <li><NavLink to="/subscribers/new">Add a subscriber</NavLink></li>}
        </ul>
      </nav>
      <Outlet />
    </div>
  );
}
```

Make sure the section nav's "Add a subscriber" link and the screen's own Add link don't collide in tests. The screen has no Add link of its own; the Viewer test asserts that the *section's* link is absent. Because the Viewer test renders the screen without the section, also assert it in `router.test.tsx` for a Viewer: `queryByRole("link", { name: "Add a subscriber" })` is null.

`SubscribersScreen.tsx`:

```tsx
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { AlertDialog, Button, DialogTrigger, Form, InlineAlert, Modal, TextField } from "@bcgov/design-system-react-components";
import { apiFetch, ApiError } from "../../api/client";
import { formatWhen } from "../../format/dates";
import { useTenantTimeZone } from "../../format/tenantTimeZone";
import { useSession } from "../../session/SessionContext";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { Pagination } from "../releases/Pagination";
import { canEditSubscribers } from "./access";
import { STATUS_FILTER_OPTIONS, STATUS_LABELS, timingLabel } from "./labels";
import type { BulkAction, BulkResult, StatusFilter, SubscriberPage } from "./types";

const BULK_COPY: Record<BulkAction, { verb: string; title: (n: number) => string; body: string; variant: "warning" | "destructive" }> = {
  activate: { verb: "activate", title: (n) => `Activate ${n} ${n === 1 ? "subscriber" : "subscribers"}?`, body: "Only disabled subscribers are activated; the rest are skipped. A bounce-disabled subscriber's bounce count starts again.", variant: "warning" },
  deactivate: { verb: "deactivate", title: (n) => `Deactivate ${n} ${n === 1 ? "subscriber" : "subscribers"}?`, body: "They receive nothing until activated again. Their lists, including media lists, are kept.", variant: "warning" },
  delete: { verb: "delete", title: (n) => `Delete ${n} ${n === 1 ? "subscriber" : "subscribers"}?`, body: "They stop receiving email and are removed from every media list. Only they can subscribe again.", variant: "destructive" },
};

const SKIP_TEXT = { unchanged: "already in that state", status: "not allowed from their status", "not-found": "no longer exist" } as const;

export function describeBulk(r: BulkResult): string {
  const parts = [`${r.changed} changed.`];
  if (r.skipped.length) {
    const counts = Object.entries(SKIP_TEXT)
      .map(([reason, text]) => [r.skipped.filter((s) => s.reason === reason).length, text] as const)
      .filter(([n]) => n > 0)
      .map(([n, text]) => (r.skipped.length === n ? text : `${n} ${text}`));
    parts.push(`${r.skipped.length} skipped: ${counts.join(", ")}.`);
  }
  return parts.join(" ");
}

/** `/hub/subscribers?q=&status=&page=`: find subscribers by email substring and status
 * (legacy ManageSubscribers). Editors select rows on the current page for a bulk action,
 * always behind a confirm dialog. Selection never spans pages and clears on every reload. */
export function SubscribersScreen(): React.JSX.Element {
  const session = useSession();
  useDocumentTitle("Subscribers");
  const timeZone = useTenantTimeZone();
  const canEdit = canEditSubscribers(session);
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const status = (params.get("status") ?? "all") as StatusFilter;
  const page = Number(params.get("page") ?? "1") || 1;
  const [qInput, setQInput] = useState(q);
  const [statusInput, setStatusInput] = useState<StatusFilter>(status);
  const [result, setResult] = useState<SubscriberPage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [pendingAction, setPendingAction] = useState<BulkAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const reload = useCallback(() => {
    const qs = new URLSearchParams({ q, status, page: String(page) });
    apiFetch<SubscriberPage>(`/nod/api/subscribers?${qs}`).then(
      (r) => { setResult(r); setSelected([]); setLoadError(null); },
      () => setLoadError("Couldn't load subscribers."),
    );
  }, [q, status, page]);
  useEffect(() => reload(), [reload]);

  const onSearch = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setOutcome(null);
    setParams({ q: qInput.trim(), status: statusInput, page: "1" });
  };
  const onPage = (next: number) => setParams({ q, status, page: String(next) });

  const runBulk = async () => {
    if (!pendingAction) return;
    setBusy(true);
    setBulkError(null);
    try {
      const r = await apiFetch<BulkResult>("/nod/api/subscribers/bulk", { method: "POST", body: { action: pendingAction, ids: selected } });
      setOutcome(describeBulk(r));
      setPendingAction(null);
      reload();
    } catch (caught) {
      setBulkError(caught instanceof ApiError ? caught.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const items = result?.items ?? [];
  const allSelected = items.length > 0 && selected.length === items.length;
  const toggle = (id: string) => setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  return (
    <div className="gcpe-subscribers__search">
      <h1>Subscribers</h1>
      <Form onSubmit={onSearch}>
        <TextField label="Email contains" name="q" value={qInput} onChange={setQInput} />
        <label htmlFor="subscribers-status">Status</label>
        <select id="subscribers-status" value={statusInput} onChange={(e) => setStatusInput(e.target.value as StatusFilter)}>
          {STATUS_FILTER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <Button type="submit">Search</Button>
      </Form>

      {loadError && <InlineAlert variant="danger" role="alert" description={loadError} />}
      {outcome && <p role="status">{outcome}</p>}

      {canEdit && selected.length > 0 && (
        <div className="gcpe-subscribers__bulk">
          {(["activate", "deactivate", "delete"] as const).map((a) => (
            <Button key={a} variant="secondary" danger={a === "delete"} onPress={() => { setBulkError(null); setPendingAction(a); }}>
              {`${a[0]!.toUpperCase()}${a.slice(1)} selected (${selected.length})`}
            </Button>
          ))}
        </div>
      )}
      <DialogTrigger isOpen={pendingAction !== null} onOpenChange={(open) => { if (!open) setPendingAction(null); }}>
        <span hidden />
        <Modal isDismissable>
          {pendingAction && (
            <AlertDialog
              variant={BULK_COPY[pendingAction].variant}
              title={BULK_COPY[pendingAction].title(selected.length)}
              buttons={
                <>
                  <Button onPress={() => setPendingAction(null)} isDisabled={busy}>Cancel</Button>
                  <Button danger={pendingAction === "delete"} onPress={() => void runBulk()} isDisabled={busy}>
                    {`Confirm ${BULK_COPY[pendingAction].verb}`}
                  </Button>
                </>
              }
            >
              <p>{BULK_COPY[pendingAction].body}</p>
              {bulkError && <InlineAlert variant="danger" role="alert" description={bulkError} />}
            </AlertDialog>
          )}
        </Modal>
      </DialogTrigger>

      {result && items.length === 0 && <p>No subscribers match.</p>}
      {items.length > 0 && (
        <table aria-label="Subscribers">
          <thead>
            <tr>
              {canEdit && (
                <th scope="col">
                  <input type="checkbox" aria-label="Select all on this page" checked={allSelected} onChange={() => setSelected(allSelected ? [] : items.map((i) => i.id))} />
                </th>
              )}
              <th scope="col">Email</th>
              <th scope="col">Status</th>
              <th scope="col">Timing</th>
              <th scope="col">Registered</th>
            </tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.id}>
                {canEdit && (
                  <td><input type="checkbox" aria-label={`Select ${s.email}`} checked={selected.includes(s.id)} onChange={() => toggle(s.id)} /></td>
                )}
                <td><Link to={`/subscribers/${s.id}`}>{s.email}</Link></td>
                <td>{STATUS_LABELS[s.status]}{s.needsAttention ? " (needs attention)" : ""}</td>
                <td>{timingLabel(s)}</td>
                <td>{formatWhen(s.createdAt, new Date(), timeZone)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {result && <Pagination page={result.page} pageSize={result.pageSize} total={result.total} onPageChange={onPage} />}
    </div>
  );
}
```

The `DialogTrigger` needs a trigger child, so this uses a hidden `<span>` because the dialog opens from state. If React Aria rejects a non-pressable child, follow the `ActionsSection` pattern instead: render one `DialogTrigger` per bulk button with that button as its trigger. That also restores focus to the button that opened the dialog, which is the better behaviour; prefer it if the hidden-span version has focus-return problems in the a11y test.

`ListPicker.tsx`:

```tsx
import type { ListOptions } from "./types";

/** "All news" or individual lists by category (legacy AddEditSubscriber's "All news" /
 * "Customize"). `heldKeys` are lists the subscriber already has that the options no longer
 * offer (an inactive list): shown, ticked, and kept unless unticked — the server accepts them
 * for this subscriber only. Media lists are never shown here. */
export function ListPicker(props: {
  categories: ListOptions["categories"];
  allNews: boolean;
  listKeys: string[];
  heldKeys?: string[];
  onChange(next: { allNews: boolean; listKeys: string[] }): void;
  disabled?: boolean;
}): React.JSX.Element {
  const { categories, allNews, listKeys, onChange, disabled } = props;
  const offered = new Set(categories.flatMap((c) => c.lists.map((l) => l.listKey)));
  const extra = (props.heldKeys ?? []).filter((k) => !offered.has(k));
  const toggle = (k: string) => onChange({ allNews, listKeys: listKeys.includes(k) ? listKeys.filter((x) => x !== k) : [...listKeys, k] });
  const box = (k: string, label: string) => (
    <label key={k}>
      <input type="checkbox" checked={listKeys.includes(k)} onChange={() => toggle(k)} disabled={disabled} /> {label}
    </label>
  );
  return (
    <fieldset>
      <legend>Lists</legend>
      <label>
        <input type="checkbox" checked={allNews} onChange={() => onChange({ allNews: !allNews, listKeys })} disabled={disabled} /> All news
      </label>
      {!allNews && categories.map((c) => (
        <fieldset key={c.key}>
          <legend>{c.name}</legend>
          {c.lists.map((l) => box(l.listKey, l.name))}
        </fieldset>
      ))}
      {!allNews && extra.length > 0 && (
        <fieldset>
          <legend>No longer offered</legend>
          {extra.map((k) => box(k, k))}
        </fieldset>
      )}
    </fieldset>
  );
}
```

`AddSubscriberScreen.tsx`:
- an h1 "Add a subscriber";
- `useDocumentTitle("Add a subscriber")`;
- a permission message for non-editors.

The form has:
- `TextField` "Email", `TextField` "Confirm email";
- `ListPicker` fed by `GET /nod/api/subscriber-list-options`;
- checkboxes "As it happens" (default ticked) and "Daily digest";
- a submit button "Add subscriber".

Submit:
1. Mismatch (compared trimmed and lowercased): alert "The two email addresses don't match.", and nothing is sent.
2. Otherwise, `POST /nod/api/subscribers` with `{ email, lists: allNews ? "all" : listKeys, asItHappens, digest }`.
3. 201: `navigate(\`/subscribers/${id}\`)`.
4. 409 `subscriber exists`: an alert "That address already has a subscriber record." plus a `Link` "Open their record" to `/subscribers/<id>`. The id comes from the `ApiError`: read it by calling `apiFetch` inside try/catch and re-fetching the raw body is awkward, so pass the id through `ApiError`:
   - add an optional `body?: unknown` to `ApiErrorInit`/`ApiError` in `client.ts`, set from the parsed JSON;
   - add a client test case in `api/client.test.tsx` ("ApiError carries the parsed body").
5. 400: the messages from `issues`/`message`, as in `UsersScreen.messagesOf`.

Client-side guards, before sending:
- no lists and not all news → "Choose at least one list, or all news.";
- neither timing → "Choose As It Happens, Daily Digest, or both."

`HomeRedirect.tsx`:

```tsx
import { Navigate } from "react-router";
import { useSession } from "../session/SessionContext";
import { canReadSubscribers } from "../screens/subscribers/access";

/** The staff app's landing page: Drafts for anyone with an NRMS role (unchanged), Subscribers
 * for someone whose only staff roles are NoD ones — they'd otherwise land on a Releases
 * screen they can't use. */
export function HomeRedirect(): React.JSX.Element {
  const session = useSession();
  const nrms = session.has("NRMS.Viewer") || session.has("NRMS.Editor") || session.has("NRMS.SiteEditor");
  return <Navigate to={!nrms && canReadSubscribers(session) ? "/subscribers" : "/releases/drafts"} replace />;
}
```

`AppShell.tsx` `NAV_ITEMS`: insert `{ to: "/subscribers", label: "Subscribers", show: canReadSubscribers }` after Website, and extend the doc comment with one line about it.

`router.tsx`:
- replace the index `<Navigate …>` with `<HomeRedirect />`;
- add before `users`:

```tsx
      {
        path: "subscribers",
        element: <SubscribersSection />,
        children: [
          { index: true, element: <SubscribersScreen /> },
          { path: "new", element: <AddSubscriberScreen /> },
          { path: ":id", element: null },
          { path: ":id/history", element: null },
        ],
      },
```

`types.ts`: write out the interfaces listed in Interfaces, with every date as `string`.

- [ ] **Step 4: Run; expect PASS**

Run the Step 2 command plus `apps/staff-web/src/api`. Then run both type-checks.

- [ ] **Step 5: Commit**

```bash
git add apps/staff-web
git commit -m "feat(staff-web): Subscribers section with search, bulk actions behind confirmation, and Add"
```

---

### Task 6: staff-web subscriber detail/edit and history screens

**Files:**
- Create, under `apps/staff-web/src/screens/subscribers/`:
  - `SubscriberScreen.tsx` (+ `.test.tsx`);
  - `HistoryScreen.tsx` (+ `.test.tsx`);
  - `labels.test.ts` (node project: history-label parity with the server).
- Modify:
  - `labels.ts` (history labels);
  - `a11y.test.tsx` (two more screens, plus the delete dialog);
  - `apps/staff-web/src/router.tsx` (fill the two `null` elements).

**Interfaces:**
- Consumes:
  - `GET /nod/api/subscribers/:id`, `GET /nod/api/subscriber-list-options`;
  - `PUT …/preferences`, `POST …/status`, `POST …/email`, `DELETE /nod/api/subscribers/:id`;
  - `GET …/history`;
  - `ListPicker`, the labels, access and types (Task 5);
  - `HISTORY_ACTIONS` (`apps/nod/src/subscribe/history.ts`, imported by path in the node-only test).
- Produces:
  - `HISTORY_LABELS`, `historyLabel(action: string): string`, `actorLabel(actor: string): string`.
  - Screens at `/hub/subscribers/:id` (h1 "Subscriber") and `/hub/subscribers/:id/history` (h1 "Subscriber history"). Both titles are fixed and never contain the address (Global Constraints).

- [ ] **Step 1: Write the failing tests**

`labels.test.ts`:

```ts
import { describe, expect, it } from "vitest";
// Node-environment test (ends in .ts): reads the server's own list directly, the same way
// admin/users/roles.test.ts checks STAFF_ROLES, so a new history action can't ship without a label.
import { HISTORY_ACTIONS } from "../../../../nod/src/subscribe/history";
import { actorLabel, HISTORY_LABELS, historyLabel } from "./labels";

describe("history labels", () => {
  it("has a label for every action the server writes, and no others", () => {
    expect(Object.keys(HISTORY_LABELS).sort()).toEqual([...HISTORY_ACTIONS].sort());
  });
  it("falls back to the raw action and names system actors", () => {
    expect(historyLabel("something-new")).toBe("something-new");
    expect(actorLabel("subscriber")).toBe("Subscriber");
    expect(actorLabel("distribution-bounce")).toBe("Bounce processing");
    expect(actorLabel("Jamie Staff")).toBe("Jamie Staff");
  });
});
```

If importing `history.ts` drags `drizzle-orm` into this test, that's fine: it's the node project. If the type-check of `apps/staff-web/tsconfig.json` objects to a path outside its `include`, mirror how `roles.test.ts` is excluded from or included in that config, and do the same.

`SubscriberScreen.test.tsx`. Render with `<Route path="/subscribers/:id" element={<SubscriberScreen />} />` at `/subscribers/1111…`. The stub serves:
- `GET /nod/api/subscribers/1111…` returns a `DETAIL` (status `disabled`, `disabledReason: "bounces"`, `listKeys: ["ministries:health"]`, `mediaLists: [{ listKey: "media-distribution-lists:budget", name: "Budget" }]`, `bouncedEmails: 0`);
- `GET /nod/api/subscriber-list-options` returns one category with Health and Agriculture.

Every write is recorded, and returns the per-test response. Tests:

```tsx
  it("shows the address, status with its reason, media lists read-only, and a fixed title", async () => {
    stub(["NoD.Viewer"]);
    renderAt();
    expect(await screen.findByText("pat@example.test")).toBeInTheDocument();
    expect(screen.getByText("Disabled — after repeated bounces")).toBeInTheDocument();
    expect(screen.getByText("Budget")).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe("Subscriber — GCPE News Staff"));
  });

  it("a Viewer gets no edit controls at all", async () => {
    stub(["NoD.Viewer"]);
    renderAt();
    await screen.findByText("pat@example.test");
    for (const name of ["Save preferences", "Activate", "Deactivate", "Change email", "Delete"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("an Editor saves timing and public lists; the body never carries a media key", async () => {
    const calls = stub(["NoD.Editor"], { "PUT /nod/api/subscribers/1111…/preferences": [200, { ok: true }] });
    renderAt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: "Agriculture" }));
    await user.click(screen.getByRole("checkbox", { name: "Daily digest" }));
    await user.click(screen.getByRole("button", { name: "Save preferences" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ asItHappens: false, digest: true, allNews: false, listKeys: ["ministries:health", "ministries:agri"] }));
    expect(await screen.findByRole("status")).toHaveTextContent("Preferences saved.");
  });

  it("shows the server's 400 message", async () => { /* PUT → 400 { error: "Choose at least one list, or all news." } → alert with that text */ });

  it("Activate a disabled subscriber posts status active and reloads", async () => { /* POST …/status { status: "active" } → { changed: true }; second GET returns status active → "Active" shown */ });

  it("Deactivate asks first", async () => { /* active DETAIL; click Deactivate → alertdialog "Deactivate this subscriber?"; Confirm deactivate → POST status disabled */ });

  it("Delete asks first, then shows the ended state with no edit controls", async () => {
    /* click Delete → alertdialog "Delete this subscriber?"; Cancel → no DELETE; Delete → Confirm delete → DELETE;
       second GET returns status deleted + endedAt → text "Unsubscribed or deleted" and no "Save preferences" button */
  });

  it("Change email: mismatch is refused; email-taken links to the other record", async () => {
    /* type New email "x@example.test", Confirm new email "y@example.test" → alert "The two email addresses don't match." no POST;
       fix confirm; POST → 409 { error: "email-taken", id: "9999…" } → alert "Another subscriber record already has that address." + link "Open that record" → /subscribers/9999… */
  });

  it("a Media Hub member's email can't be changed here", async () => { /* DETAIL source "media-hub" → no "Change email" button; text "This address comes from Media Hub." */ });
```

`HistoryScreen.test.tsx`:

```tsx
  it("lists history newest first with readable actions and actors, and links back", async () => {
    // GET …/history → { items: [ { at: "2026-10-02T17:00:00.000Z", actor: "Jamie Staff", action: "staff-deactivated", detail: "" },
    //                            { at: "2026-10-01T17:00:00.000Z", actor: "subscriber", action: "subscribed", detail: "ministries:health" } ] }
    // rows in order: "Deactivated by staff" / "Jamie Staff"; "Subscribed (confirmed by email)" / "Subscriber" / detail "ministries:health"
    // link "Back to subscriber" → /subscribers/1111…
    // await waitFor(() => expect(document.title).toBe("Subscriber history — GCPE News Staff"))
  });
  it("an unknown subscriber shows not found", async () => { /* GET → 404 → text "Subscriber not found." */ });
```

Write these out in full, in the same style as Task 5's tests. The comments above give the exact fixtures and assertions.

`a11y.test.tsx`, add:
- `SubscriberScreen` as an Editor, populated;
- `SubscriberScreen` with the delete dialog open;
- `HistoryScreen` populated.

- [ ] **Step 2: Run; expect FAIL**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/subscribers`

- [ ] **Step 3: Implement**

`labels.ts`, add:

```ts
/** One readable line per `subscriber_history.action` (apps/nod/src/subscribe/history.ts's
 * HISTORY_ACTIONS; labels.test.ts keeps the two in step). */
export const HISTORY_LABELS: Record<string, string> = {
  subscribed: "Subscribed (confirmed by email)",
  resubscribed: "Subscribed again (confirmed by email)",
  confirmed: "Confirmed by email",
  "preferences-updated": "Changed their preferences",
  "email-change-requested": "Asked to change their email address",
  "email-changed": "Changed their email address (confirmed by email)",
  "record-merged": "Took over an earlier record at this address",
  unsubscribed: "Unsubscribed",
  "media-list-added": "Added to a media list",
  "media-list-removed": "Removed from a media list",
  "media-list-opted-out": "Left a media list by unsubscribing",
  "media-ended": "Ended: removed from their last media list",
  "media-hub-email-changed": "Email updated from Media Hub",
  "media-hub-flagged": "Flagged: Media Hub email needs attention",
  "media-hub-resolved": "Media Hub flag resolved",
  "bounce-recorded": "An email bounced",
  "bounce-disabled": "Disabled after repeated bounces",
  "bounce-flagged": "Flagged: repeated bounces",
  "staff-added": "Added by staff",
  "staff-preferences-updated": "Preferences changed by staff",
  "staff-email-changed": "Email address changed by staff",
  "staff-activated": "Activated by staff",
  "staff-deactivated": "Deactivated by staff",
  "staff-deleted": "Deleted by staff",
};

export function historyLabel(action: string): string {
  return HISTORY_LABELS[action] ?? action;
}

const SYSTEM_ACTORS: Record<string, string> = {
  subscriber: "Subscriber",
  "distribution-bounce": "Bounce processing",
  "media-hub-sync": "Media Hub sync",
  "admin-api": "Admin API",
};

/** Legacy showed a blank user as "Subscriber" (SubscriberHistory.aspx.cs); staff actors are
 * stored by display name and shown as-is. */
export function actorLabel(actor: string): string {
  return SYSTEM_ACTORS[actor] ?? actor;
}
```

`SubscriberScreen.tsx` structure. Every write goes through `apiFetch`, then `reload()`.

- `useDocumentTitle("Subscriber")` is unconditional. The h1 is always "Subscriber": while loading, on error and when loaded, so the title never changes.
- **Loading:** `<p>Loading…</p>` under the h1. **404:** "Subscriber not found."
- **Summary (`<dl>`):**
  - Email;
  - Status: `STATUS_LABELS`, plus " — after repeated bounces" or " — by staff" from `disabledReason`;
  - Source (`self` → "Signed up themselves", `admin` → "Added by staff", `media-hub` → "Media Hub contact", `manual-media` → "Added to a media list by staff");
  - Registered and Ended, via `formatWhen`;
  - "Needs attention: <reason>" when set;
  - "Bounced emails counted (last 15 days): n" when `bouncedEmails > 0`;
  - Media lists (names, read-only, with "Managed per media list.");
  - a `Link` "History" to `/subscribers/<id>/history`.
- **Preferences** (Editor, and status `active` or `disabled`): a `<form aria-label="Preferences">` with "As it happens" / "Daily digest" checkboxes and `ListPicker`, seeded from `detail.allNews`/`detail.listKeys` with `heldKeys={detail.listKeys}`. Button "Save preferences". On success, `<p role="status">Preferences saved.</p>`; on error, alert messages.
  - For a Viewer, the same information shows as text: timing via `timingLabel`, and list names resolved from the options (key as fallback).
- **Status** (Editor):
  - "Activate" when `disabled`: posts immediately, with no dialog, because activation is reversible and harmless.
  - "Deactivate" when `active`: an `AlertDialog` "Deactivate this subscriber?" — "They receive nothing until activated again. Their lists, including media lists, are kept." — with "Confirm deactivate".
  - A 409 shows "This subscriber's status changed; reload." and reloads.
- **Change email** (Editor; status not `deleted`; source not `media-hub`, which shows "This address comes from Media Hub." instead):
  - "New email" and "Confirm new email" fields; a mismatch is refused client-side;
  - button "Change email";
  - help text: "No confirmation email is sent. Links in emails already sent to the old address stop working.";
  - 409 `email-taken`: "Another subscriber record already has that address." plus a link "Open that record" (id from `ApiError.body`, Task 5);
  - 409 `media-hub-managed` → the same Media Hub text.
- **Delete** (Editor; status not `deleted`): `DialogTrigger` + `AlertDialog` (destructive) "Delete this subscriber?" — "They stop receiving email and are removed from every media list. Only they can subscribe again." — with "Confirm delete", then reload.
- **Deleted:** no edit controls at all, and the line "Unsubscribed or deleted on <date>. Only they can subscribe again."

`HistoryScreen.tsx`:
- h1 "Subscriber history", `useDocumentTitle("Subscriber history")`;
- loads `GET /nod/api/subscribers/:id/history`; a 404 shows "Subscriber not found.";
- a table with columns When / What / Who / Detail, using `formatWhen`, `historyLabel`, `actorLabel` and the raw detail;
- an empty state: "No history yet.";
- a `Link` "Back to subscriber" above the table.

`router.tsx`: replace the two `null` elements with `<SubscriberScreen />` and `<HistoryScreen />`.

- [ ] **Step 4: Run; expect PASS**

Run: `apps/staff-web` in full, then both type-checks.

- [ ] **Step 5: Commit**

```bash
git add apps/staff-web
git commit -m "feat(staff-web): subscriber detail, edit, status, change email, delete and history screens"
```

---

### Task 7: End to end, docs and verification

**Files:**
- Create: `tests/e2e/subscribers.spec.ts`.
- Modify:
  - `docs/parity/changes-from-legacy.md`, `docs/parity/open-questions.md`;
  - `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`;
  - `docs/superpowers/plans/phase-4-carry-forward.md`.

**Interfaces:**
- Consumes:
  - `signInAs(context, "nodViewer" | "nodEditor" | "admin" | "editor")`;
  - `ROLE_LOGINS`, `apiCall`, `ensureSubscriber`, `expectNoSeriousA11yViolations`, `settleModalTransition`, `baseUrl` (`playwright-support.ts`).

- [ ] **Step 1: Write the e2e spec**

`tests/e2e/subscribers.spec.ts`:

```ts
// Acceptance item 14 (NoD parity spec §10): "Viewer/Editor/Admin each see exactly their parts of
// the Subscribers section", plus the §8 Subscribers flows end to end through the stack: add,
// edit, bulk deactivate/activate with confirmation, change email, delete, history — with axe
// on every screen and dialog.
import { test, expect } from "@playwright/test";
import { apiCall, baseUrl, ensureSubscriber, expectNoSeriousA11yViolations, ROLE_LOGINS, settleModalTransition, signInAs } from "./playwright-support";

const unique = (label: string) => `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;

test.describe("item 14: Subscribers section by role", () => {
  test("a NoD Viewer finds subscribers read-only; the server refuses their writes", async ({ page, context }) => {
    const admin = await ROLE_LOGINS.admin();
    const email = unique("viewer-sees");
    await ensureSubscriber(admin, email, ["ministries:health"]);
    await signInAs(context, "nodViewer");
    await page.goto(`${baseUrl()}/hub/`);
    await expect(page).toHaveURL(/\/hub\/subscribers$/);
    await expect(page.getByRole("link", { name: "Releases" })).toHaveCount(0);
    await page.getByLabel("Email contains").fill(email);
    await page.getByRole("button", { name: "Search" }).click();
    await page.getByRole("link", { name: email }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Subscriber" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save preferences" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);
    await expectNoSeriousA11yViolations(page, "subscriber detail (viewer)");
    const viewer = await ROLE_LOGINS.nodViewer();
    await expect(apiCall(viewer, "/nod/api/subscribers/bulk", { method: "POST", body: { action: "delete", ids: [crypto.randomUUID()] } })).rejects.toThrow(/403/);
  });

  test("an NRMS editor doesn't see the Subscribers section", async ({ page, context }) => {
    await signInAs(context, "editor");
    await page.goto(`${baseUrl()}/hub/releases/drafts`);
    await expect(page.getByRole("link", { name: "Subscribers" })).toHaveCount(0);
  });

  test("an Admin sees the same Subscribers controls as an Editor", async ({ page, context }) => {
    await signInAs(context, "admin");
    await page.goto(`${baseUrl()}/hub/subscribers`);
    await expect(page.getByRole("link", { name: "Add a subscriber" })).toBeVisible();
  });
});

test.describe("§8 Subscribers flows (NoD Editor)", () => {
  test("add → edit → bulk deactivate/activate with confirmation → change email → delete → history", async ({ page, context }) => {
    const email = unique("flow");
    const moved = unique("flow-moved");
    const other = unique("flow-other");
    await ensureSubscriber(await ROLE_LOGINS.admin(), other, ["ministries:health"]);
    await signInAs(context, "nodEditor");

    await page.goto(`${baseUrl()}/hub/subscribers/new`);
    await expectNoSeriousA11yViolations(page, "add subscriber");
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Confirm email").fill(email);
    await page.getByRole("checkbox", { name: "All news" }).check();
    await page.getByRole("button", { name: "Add subscriber" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Subscriber" })).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();
    await expect(page.getByText("Active", { exact: true })).toBeVisible();

    await page.getByRole("checkbox", { name: "Daily digest" }).check();
    await page.getByRole("button", { name: "Save preferences" }).click();
    await expect(page.getByRole("status")).toHaveText("Preferences saved.");

    await page.goto(`${baseUrl()}/hub/subscribers?q=${encodeURIComponent("flow-")}&status=all&page=1`);
    await page.getByRole("checkbox", { name: `Select ${email}` }).check();
    await page.getByRole("checkbox", { name: `Select ${other}` }).check();
    await page.getByRole("button", { name: "Deactivate selected (2)" }).click();
    await settleModalTransition(page);
    await expectNoSeriousA11yViolations(page, "bulk deactivate dialog");
    await page.getByRole("button", { name: "Confirm deactivate" }).click();
    await expect(page.getByRole("status")).toHaveText("2 changed.");
    await page.getByRole("checkbox", { name: `Select ${email}` }).check();
    await page.getByRole("button", { name: "Activate selected (1)" }).click();
    await page.getByRole("button", { name: "Confirm activate" }).click();
    await expect(page.getByRole("status")).toHaveText("1 changed.");

    await page.getByRole("link", { name: email }).click();
    await page.getByLabel("New email").fill(other);
    await page.getByLabel("Confirm new email").fill(other);
    await page.getByRole("button", { name: "Change email" }).click();
    await expect(page.getByText("Another subscriber record already has that address.")).toBeVisible();
    await page.getByLabel("New email").fill(moved);
    await page.getByLabel("Confirm new email").fill(moved);
    await page.getByRole("button", { name: "Change email" }).click();
    await expect(page.getByText(moved)).toBeVisible();

    await page.getByRole("button", { name: "Delete" }).click();
    await settleModalTransition(page);
    await expectNoSeriousA11yViolations(page, "delete subscriber dialog");
    await page.getByRole("button", { name: "Confirm delete" }).click();
    await expect(page.getByText("Unsubscribed or deleted", { exact: false })).toBeVisible();

    await page.getByRole("link", { name: "History" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Subscriber history" })).toBeVisible();
    for (const label of ["Added by staff", "Preferences changed by staff", "Deactivated by staff", "Activated by staff", "Email address changed by staff", "Deleted by staff"]) {
      await expect(page.getByRole("cell", { name: label })).toBeVisible();
    }
    // The actor is the signed-in staff member's display name (actorOf), never "Subscriber".
    await expect(page.getByRole("cell", { name: "Test NoD Editor" }).first()).toBeVisible();
    await expectNoSeriousA11yViolations(page, "subscriber history");
  });
});
```

Check two details against what the stack actually does:
- `apiCall` throws on a non-2xx status with the status in its message. Read `playwright-support.ts:74-95` and adapt the `rejects.toThrow` if it formats the status differently.
- Whether `settleModalTransition` exists with that name (the axe-sweep imports it).

If the e2e stack has no `ministries:health` list (`ensureSubscriber` only POSTs keys), the Add flow uses "All news", which needs none.

- [ ] **Step 2: Run the new spec; expect FAIL until it's right, then PASS**

Run: `npx -y -p node@24 -- npm run test:e2e -- tests/e2e/subscribers.spec.ts`. Fix any selector mismatches against the real screens, never by weakening an assertion about roles.

- [ ] **Step 3: Docs**

**`docs/parity/changes-from-legacy.md`.** Add rows to the "NoD and Distribution (Phase 4)" table, using the next free numbers (C77 onward at planning time; re-check the table first, since 4e's final fixes may add rows). Status "Agreed" unless noted.

| # | Legacy | New | Why | Status |
|---|---|---|---|---|
| C77 | Bulk Activate/De-activate/Delete on checked rows runs immediately, with no confirmation (`ManageSubscribers.aspx.cs:230-286`); the result is one generic message. | Every bulk action asks first, naming the action and the count. Each row is handled on its own, and the screen reports how many changed and how many were skipped and why. | A misclick on a page of 50 shouldn't delete 50 people; partial failures should be visible. | Agreed |
| C78 | Deleted subscribers are hidden from Manage Subscribers (`IsDeleted == false`). | Deleted (unsubscribed) subscribers are findable with the status filter and read-only. Staff can't reactivate them; only their own re-subscribe brings them back. Staff can reactivate **disabled** ones. | Staff need to answer "did this person unsubscribe?"; reactivating someone who opted out would override their consent (Q32). | Proposed |
| C79 | Staff delete calls the same unsubscribe as the public link. | Staff delete ends the subscriber and removes their media-list memberships as staff removals (history `staff-deleted`, `media-list-removed`), not as the person's own opt-out. Re-adding them to a media list needs no opt-out confirmation (C64 applies only to their own unsubscribe). | Keeps C64's consent check meaning "the person opted out", not "staff removed them". | Agreed |
| C80 | A staff email change (`ChangeUsersSubscriptionEmail`) is refused if the new address exists; old links keep working. | Still refused for an address held by any record, whatever its status. A Media Hub-sourced member's address is changed in Media Hub instead. On success, the unsubscribe token rotates and every outstanding link stops working. History records the change, not the addresses. | Old links point at a mailbox that's no longer the subscriber's. | Agreed |
| C81 | Reactivating a subscriber leaves their bounce history counting. | Reactivation (staff Activate, or the subscriber's own re-confirm) restarts the 10-in-15-days bounce count. | Staff reactivate because they believe the mailbox is fixed; one more bounce shouldn't undo that. | Agreed |
| C82 | `SubscriberHistory` reads `SysLog` by subscriber id, **or** by email for events on/after registration (picking up other people's rows at a reused address). | History is by subscriber id only. When an email move replaces a dead (pending or unsubscribed) record, that record's history moves onto the mover, with a "took over an earlier record" line. New signups and resubscriptions are logged separately (`subscribed` / `resubscribed`). | Exact attribution; nothing lost when a dead record is cleared; reports can count new vs returning subscribers. | Agreed |
| C83 | Manage Subscribers sorts by email, registered date or status. | Results are sorted by email only, 50 per page; status is a filter. | Search by substring plus the filter covers the use; the extra sorts add surface for little gain. | Proposed |
| C84 | After an email move, links to the old address keep working until they expire. | A completed move (public or staff) expires every other link the subscriber had. A verify link superseded by a sibling confirmation is dead everywhere. | Closes a 24-hour window in which the old mailbox could still manage the subscription. | Agreed |

**`docs/parity/open-questions.md`, Open.** Add:
- **Q32**, "Should staff ever be able to restore a subscriber who unsubscribed?"
  - Why it matters: legacy hid them; restoring would mail someone who opted out.
  - Working assumption: no. Staff can find them read-only; only the person's own re-subscribe restores them.

**`docs/manuals/running-notes.md`, Phase 4 block.** Add:
- **Administrator** — Staff roles for subscribers: **NoD Viewer** finds subscribers and reads their details and history; **NoD Editor** also adds, edits, deactivates, reactivates, deletes and changes email; **NoD Admin** can do everything an Editor can. Grant them on the Users screen.
- **Editor** — Bulk actions apply to the rows ticked on the current page only, always after a confirmation. Skipped rows (already in that state, or a deleted subscriber you tried to activate) are counted in the message, not treated as errors.
- **Editor** — "Disabled" means no email is sent: either bounces disabled the subscriber (the detail screen says so) or staff did. Activate restarts the bounce count. "Unsubscribed or deleted" subscribers can't be reactivated; only their own re-subscribe brings them back.
- **Editor** — A staff email change sends no confirmation, stops every link in emails already sent, and is refused if another record has that address (open that record instead). A Media Hub contact's address is changed in Media Hub.
- **Editor** — Deleting a subscriber removes them from every media list too. That's recorded as a staff removal, so adding them back to a media list later needs no opt-out confirmation.
- **Viewer** — The History screen shows "Subscriber" for the person's own actions, staff names for staff actions, and "Bounce processing" / "Media Hub sync" for automatic ones.
- **Operations** — Two more test users: `nod-viewer@example.test` and `nod-editor@example.test`. `scripts/siteground-seed-users.sh` creates all five.
- **Developer** — Staff subscriber routes answer unexpected errors themselves and log only an error code, because their queries bind addresses (`privateErrors`). Use it for any new route that binds an address.

**`docs/deploy/siteground.md`:**
- Add the hand-check for item 14: sign in as each of `nod-viewer`, `nod-editor` and the admin, and confirm what each sees on Subscribers.
- Update item 1's "three test users" to "five".

**`docs/superpowers/plans/phase-4-carry-forward.md`:**
- Delete the four journey/history lines this plan closes.
- Rename the remaining part of the "4e / 4f" section to `## 4g (staff screens: lists, media lists, reports, operations)` and keep its three media-list lines.
- Add to that section:
  - "Open the NoD media-list member/sync/resolve routes to `NoD.Editor` (spec §8) together with their screens."
  - "Reports read `subscribed`/`resubscribed` (new vs returning) and count `unsubscribed` + `staff-deleted` as unsubscribes; old `confirmed` rows count as `subscribed`."

- [ ] **Step 4: Full verification**

- Both type-checks.
- Full vitest: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run`.
- Full e2e: `npx -y -p node@24 -- npm run test:e2e`.

Record the passed/skipped counts in the commit message body. Compare against 4e's final run: 4e reported 52 passed / 1 skipped before bounces; use 4e's final number. Any drop is a regression to fix, not to explain away.

- [ ] **Step 5: Commit and push**

```bash
git add tests/e2e/subscribers.spec.ts docs
git commit -m "feat(e2e,docs): Subscribers section end to end; Phase 4f docs"
git push -u origin feat/phase-4f
```

The controller deploys to boxs.ca after the final review.

---

## Rulings (decided while Paul was asleep, flagged for review)

- **R1. Staff can't reactivate a `deleted` (unsubscribed) subscriber.** Staff Activate works only from `disabled`; `pending` and `deleted` answer 409. Deleted subscribers are findable and read-only (C78, Q32).
  - *Cost if wrong:* allow `deleted → active` in `setStatus`, plus a confirm dialog. About an hour.
- **R2. Reactivation restarts the bounce count.**
  - A new `subscribers.bounce_window_from` column; the threshold counts only emails attempted after it.
  - Set by staff Activate, and by the subscriber's own re-confirm from `disabled`, for consistency.
  - Old bounces stay on the deliveries and in history, so nothing is lost.
  - *Cost if wrong:* stop setting the column, and a chronically bouncing address is re-disabled after one more bounce.
- **R3. A move over a dead row keeps that row's history** (carry-forward 1). The history rows are re-pointed to the mover, and a `record-merged` line is written (detail: the dead row's status).
  - The alternative, a nullable `subscriber_id` plus an email snapshot on history, would store more addresses and complicate the 4g purge.
  - Staff email change avoids the question entirely by refusing any taken address.
  - *Cost if wrong:* the mover's history shows the old row's lines. A later migration could split them back out by the `record-merged` marker's timestamp.
- **R4. `subscribed` vs `resubscribed`** (carry-forward 2).
  - A first confirm (no row, or `pending`) writes `subscribed`; a confirm from `disabled`/`deleted` writes `resubscribed`.
  - `confirmed` is no longer written but stays a known action for existing rows.
  - 4g reports read both (noted in carry-forward).
- **R5. A completed move expires all the subscriber's other links**, including send-stamped manage links (carry-forward 3). This is done by setting `expires_at = now()`, which the existing `expired` check already honours.
  - *Cost:* someone clicking "manage" in an old email after a move gets the expired-link page. That's the point.
- **R6. A superseded verify link is dead everywhere** (carry-forward 4). `CheckEmailActivationToken` now answers `false`, matching Confirm's `null`.
- **R7. Staff email change is refused for any taken address**, whatever that row's status (legacy parity), and for `media-hub`-sourced members. It never stores addresses in history detail.
- **R8. Staff delete removes media memberships**, as `media-list-removed` (staff), not as an opt-out. Public subscriptions stay on the row for the audit trail, as the public unsubscribe leaves them.
- **R9. Bulk acts on the ticked rows of the current page only** (at most 200 ids per call). There is no "all N matching" mode: too easy to aim wrong. Each row runs in its own transaction.
- **R10. `POST /subscribers` moves into the staff router** and opens to `NoD.Editor`. It's back-compatible: same body (timing now optional), same 201, and a 409 that now also carries the existing `id`. It lowercases addresses, takes the address lock, and writes `staff-added`.
- **R11. The detail page's `h1` and title are "Subscriber", not the address.** Addresses stay out of browser history and tab titles, and this sidesteps the async-title flake entirely. The address is the first line under the heading.
- **R12. The NoD-only landing page is `/subscribers`.** Users with any NRMS role still land on Drafts.
- **R13. Staff preference edits are allowed for `active` and `disabled`.** They're refused for `pending`/`deleted`. A subscriber's held-but-now-inactive list is kept unless staff untick it. Both-empty preferences are allowed only for a media-only member.
- **R14. Media-list role widening (`NoD.Editor` on the 4c media routes) waits for 4g**, so the access change and its screens ship and are tested together.
- **R15. Search is a plain `lower(email) LIKE '%term%'`**, with no trigram index. That's adequate at legacy's volumes (Q21: tens of thousands of rows); add `pg_trgm` later if it's ever slow.

## Self-review notes (for the reviewer)

- **Spec §8 "Subscribers" coverage:**
  - search by substring + status filter: Tasks 3, 5;
  - edit timing, lists and status: Tasks 4, 6;
  - change email (no verification, history written): Tasks 4, 6;
  - delete (unsubscribe): Tasks 4, 6;
  - history: Tasks 3, 6;
  - bulk with confirmation: Tasks 4, 5;
  - add, active immediately (C51): Tasks 4, 5.
- **Spec §8 "Roles":** Task 1 (catalogue), Task 3/4 (server gates), Task 5 (nav and landing). The existing `NoD.Admin` service use and `NoD.SubscriberCount` are untouched.
- **§10 item 14:** Task 7's e2e, plus the hand-check line in `siteground.md`.
- **Carry-forward coverage:** the four journey/history items are in Task 2 (R3–R6). The three media-list items are deferred, below.
- **Constraint checks:**
  - Media memberships survive public-list edits: Task 4's first test.
  - `disabled` is visible and reactivatable, with history: Tasks 3, 4, 6.
  - Reactivation and the bounce window: Tasks 2, 4.
  - No addresses in logs: Task 3 (`privateErrors`) and Task 4 (the history detail test).
  - No flaky title asserts: Global Constraints, Tasks 5/6 (`waitFor`).
- **Types used across tasks:**
  - `HISTORY_ACTIONS`: Task 2, extended in Task 4, checked in Task 6.
  - `replacePublicSubscriptions`, `expireSessionLinks`: Task 2 → Task 4.
  - `NOD_READ_ROLES` / `NOD_WRITE_ROLES`, `privateErrors`: Task 3 → Task 4.
  - `ApiError.body`: Task 5 → Task 6.

## Deferred to 4g

From spec §8 (`docs/superpowers/specs/2026-10-05-nod-distribution-parity-design.md:208-216`), verbatim:

> - **Lists & categories:** enable/disable categories and lists, order them, see subscriber counts. Names of ministry/sector/theme/tag lists come from Core and are read-only here; media list names come from NRMS.
> - **Media lists:** members per list; add from Media Hub search (choose the email) or manually; remove; "needs attention" flags with a resolve action; last sync time and result.
> - **Reports**, each with CSV export:
>   - active subscribers by list;
>   - recent unsubscribes (90 days);
>   - per-release sends (as-it-happens and media, with counts delivered/bounced);
>   - digest runs;
>   - Distribution sent vs bounced.
> - **Operations:** NoD pause/resume, Distribution pause/resume, purge on/off (and next-run preview count), bounce summary address, the fake bounce mailbox upload (test sites only).

Also from §8's Roles (lines 218-220), the parts that belong to those screens: `NoD.Viewer`'s "reports, lists"; `NoD.Editor`'s "media lists"; `NoD.Admin`'s "Operations and categories".

From `docs/superpowers/plans/phase-4-carry-forward.md` ("4e / 4f" section), verbatim:

> - NRMS staff-web media-list screen (4c built the admin API only — `POST`/`PUT /nrms/api/media-lists`, `.../republish`; existing lists arrive via the importer and republish).
> - NoD media-list member screens (4c built the admin API only — `GET /nod/api/media-lists`, `GET`/`POST`/`DELETE .../members`, the Media Hub search/sync endpoints).
> - A read route/screen listing who opted out of each media list (history action `media-list-opted-out`).

Plus, from this plan's rulings:
- `NoD.Editor` on the 4c media routes (R14).
- Reports reading `subscribed`/`resubscribed`/`staff-deleted` (R4, C79).
