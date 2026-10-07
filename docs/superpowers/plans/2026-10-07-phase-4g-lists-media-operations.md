# Phase 4g: Lists & Categories, Media Lists and Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff can manage which subscriber lists are offered and in what order, with live subscriber counts. NoD Editors can manage media-list members (add from Media Hub or by hand, remove, resolve "needs attention" flags, see who opted out, see and run the Media Hub sync). NoD Admins get an Operations screen: NoD and Distribution pause/resume, the bounce summary address, and the test-site bounce upload. Core Admins get a screen for media-list names (NRMS).

**Architecture:**
- **NoD, media lists:** the 4c media-list routes move out of `http/routes.ts` into their own router, `http/staff-media-routes.ts`. It opens reads to `NoD.Viewer` and writes to `NoD.Editor`, replaces `GET /media-hub/contacts?q=` with `POST /media-hub/contacts/search`, and adds `GET /media-hub/contacts/:id` and `GET /media-lists/:key/opted-out`. Like 4f's staff router, it answers unexpected errors itself, because its queries bind addresses. That error wrapper moves to a shared `http/private-errors.ts`.
- **NoD, lists:** a `staff-lists.ts` module plus `http/staff-list-routes.ts`. Two new staff-owned columns, `lists.enabled` and `lists.staff_sort_order`, sit beside the source-owned `active`/`sort_order`, so a Core or NRMS event never undoes a staff choice.
- **NoD, operations:** `operations.ts` plus `http/operations-routes.ts`. The bounce summary address becomes a stored setting (`nod_settings.bounce_summary_email`), with `NOD_BOUNCE_SUMMARY_EMAIL` as the default. The Distribution client gains `bounceSource()`.
- **NRMS:** `GET /media-lists` opens to `Core.Admin`, the role that already owns media-list create/edit.
- **staff-web:** the Subscribers section gains Lists and categories, Media lists (index + per-list screen), and Operations. A top-level Media list names screen is added for Core Admins.

**Tech Stack:** Node 24, TypeScript 5.9 strict, Express 5, Drizzle 0.45 / drizzle-kit 0.31, zod 3.25, Vitest 4.1, supertest, React 19 + react-router 7 (library mode), `@bcgov/design-system-react-components`, axe-core, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-05-nod-distribution-parity-design.md`:
- §8 "Staff Subscribers section": the Lists & categories, Media lists and Operations bullets, and the Roles bullets;
- §5.1 (pause/resume, ops email), §5.3 (Media Hub contract, sync, needs attention);
- §7 (bounces, summary email, fake mailbox);
- §9 (purge; deferred, see Ruling R2);
- §10 acceptance items 10 and 14.

Executors read the spec alongside this plan.

**Base:**
- **Branch:** `feat/phase-4g`, cut from `feat/phase-4f` at `86572f9`.
- **Worktree:** `/Users/paul/gcpe-news-platform-4g`.
- **Line numbers:** every file:line reference below is against `86572f9`. Re-find by symbol if anything has moved.

**Sub-plan split (Ruling R1):**
- **4g (this plan):** Lists & categories, Media lists screens, Operations, the NRMS media-list names screen, the search-term-in-URL fix, and the 4g staff-screen carry-forwards.
- **4h:** Reports with CSV export.
- **4i:** the emergency RSS ingester, the retention purge (with its on/off switch and preview), and the legacy NoD importer.

**Legacy parity screens** (`~/HUB/Subscribe/Gcpe.NewsOnDemand.Website`):
- `ManageLists.aspx.cs` and `ManageListCategories.aspx.cs`: lists grouped by category, Up/Down ordering by `SlotNumber`, Edit and Delete. Media-distribution lists are explicitly not editable there: "they need to remain sync-ed to the lists in the hub" (`ManageLists.aspx.cs`, the `media-distribution-lists` branch).
- `ManageDistributionService.aspx.cs`: status lights for As It Happens, Daily Digest and Distribution. Suspend/Resume for Distribution is two-step (click, then confirm), and each change emails an `AppEvent` naming the user (lines 62-110).
- `BounceManager.cs`: the summary goes to a hard-coded address.

## Global Constraints

- **Worktree and commits:**
  - Work in `/Users/paul/gcpe-news-platform-4g`, branch `feat/phase-4g`. Commit locally after each task.
  - Never add `Co-Authored-By` or any AI attribution (project convention, as in 4f). Never commit `CLAUDE.md`.
  - **Code comments never carry task, review-round or finding labels** ("Task 3", "fix round 1", "I2"…). Say *why*, not *when*.
- **Node 24 for everything:**
  - Tests: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run <paths>`.
  - Type-checks: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json` and `… -p apps/staff-web/tsconfig.json`.
  - E2E: `npx -y -p node@24 -- npm run test:e2e`.
  - Show each new test failing before implementing it (a real RED run).
- **Migrations:**
  - Generate with drizzle-kit: `cd apps/nod && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name <name>`.
  - Never hand-edit generated DDL. Migrations must be safe on boxs.ca's existing data, and additive only. The next free NoD number at planning time is `0020`.
- **Clocks:** time comparisons in SQL use the DB clock (`now()`), never a JS `Date` against a DB timestamp.
- **Locking (`apps/nod/src/locks.ts`):**
  - Every write that reads or changes a subscriber's email, status or attention flag first takes `lockAddress(tx, lower(email))`, then reads the row `FOR UPDATE`. Use `withLockedSubscriber` where the address must be learned first.
  - A change of email locks **both** addresses, in sorted order.
- **Privacy:**
  - **Email addresses and search terms never go in logs**: not in `console.*`, not in `last_error`, not in `operations_log.detail`, and not in an error that reaches `jsonErrorHandler`. It logs the whole error, and a `DrizzleQueryError` message carries its bound params.
  - Every route that binds an address or a search term runs through `privateErrorsWith` (`http/private-errors.ts`, Task 1).
  - **A search term never travels in a URL.** That covers staff-web page URLs and every NoD route: subscriber search (4f) and Media Hub contact search (this plan) are POST bodies. The one exception is NoD's outbound call to Media Hub's own contract (`GET /api/service/contacts?q=`, spec §5.3), which this plan does not change (Ruling R8, Q35).
  - `subscriber_history.detail` never stores an email address. `document.title` never contains one.
- **Media memberships are never touched by public-list edits** (unchanged from 4f).
- **Staff-owned vs source-owned list fields:**
  - Core (ministries, sectors, themes, tags) and NRMS (media lists) own `lists.name`, `lists.active` and `lists.sort_order`. Every upsert in `lists.ts` overwrites them.
  - Staff own `lists.enabled`, `lists.staff_sort_order`, `list_categories.enabled` and `list_categories.sort_order`. No event handler ever writes these.
  - Media-list names, order and active state are changed in NRMS only. NoD refuses staff edits to the `media-distribution-lists` category and its lists (409 `managed-in-nrms`).
- **"Offered" (Ruling R3):**
  - A list is offered to the public and on the staff preferences form only when it is `active`, `enabled`, and its category is `enabled`.
  - Disabling a list or category never removes or stops existing subscriptions. Matching and sending ignore `enabled`. Both the staff and public preference saves keep a held list that is no longer offered (4f's `allowedPublicKeys` already allows held keys).
- **Roles (spec §8; Rulings R5, R7, R15):**
  - Lists and categories: reads `NoD.Viewer`/`NoD.Editor`/`NoD.Admin`; writes `NoD.Admin`.
  - Media lists, members, opt-outs and sync status: reads `NoD.Viewer`/`NoD.Editor`/`NoD.Admin`. Add, remove, resolve, Media Hub search/contact lookup and "run sync now": `NoD.Editor`/`NoD.Admin`.
  - Operations, read and write: `NoD.Admin` only.
  - Distribution pause/resume also needs `Distribution.Operate` on NoD's own service token. That already holds (`apps/nod/src/distribution-token.ts:77`, roles `["Distribution.Send", "Distribution.Operate"]`), and Distribution's `/api/settings/*` and `/api/bounces/*` gate on it (`apps/distribution/src/http/routes.ts`). Don't widen either side.
  - Media-list names (NRMS): `Core.Admin`, unchanged; NRMS's `GET /media-lists` also accepts it.
  - The server is the authority; staff-web hides what a role can't use.
- **Staff-web patterns (unchanged from 4f):**
  - Every call goes through `apiFetch` (`apps/staff-web/src/api/client.ts`), with same-origin `/nod/api/...` and `/nrms/api/...` paths.
  - Every screen calls `useDocumentTitle` with its `h1` text, unconditionally and statically. No async titles.
  - Tests stub `fetch` with `jsonResponse` (`apps/staff-web/test/jsonResponse.ts`). Each new screen is in an axe test (wcag2a/wcag2aa, serious/critical).
  - Title assertions use `await waitFor(() => expect(document.title).toBe(...))`.
  - Confirm dialogs use `Modal` + `AlertDialog`, either inside a `DialogTrigger` (as `SubscribersScreen.tsx` does) or controlled with `isOpen` (as `FilesScreen.tsx` does).
  - Reorder buttons are keyboard buttons with visible text naming the item ("Move Health up"), built on `shared/reorder.ts`'s `moveBy`.
- **Copy:**
  - Attention labels:
    - `email-gone`: "Media Hub email removed";
    - `email-taken`: "Media Hub email belongs to another subscriber";
    - `email-invalid`: "Media Hub email isn't valid";
    - `bouncing`: "Bouncing".
  - Member sources: `media-hub` "Media Hub", `manual-media` "Added by hand", anything else "Subscriber".
  - Status words on Operations: "Running" / "Paused".
- **Carried to 4h (Reports), recorded here so 4h inherits them:**
  - **CSV exports** are streamed, with `Content-Type: text/csv; charset=utf-8` and `Content-Disposition: attachment; filename="<report>-<YYYY-MM-DD>.csv"`.
  - **Formula injection:** any cell starting with `=`, `+`, `-` or `@` is prefixed with `'`. Also tab and CR, per OWASP.
  - An export that contains email addresses is role-gated (Ruling R17), and its request and contents are never logged.
  - Every report query is bounded (a date window, or a page) and uses an index on `deliveries`/`messages`, never a full scan. Add missing indexes with drizzle-kit.

## Review Focus

1. **Re-adding a media member who unsubscribed.** Staff see when they unsubscribed and must confirm. Cancelling adds nothing, and confirming sends `confirmOptOut: true`. The server already refuses without it (4c). The screen must never auto-confirm or hide the date. Pinned in Task 5 ("opted-out add asks first").
2. **Disabling a list that people are subscribed to.** It disappears from the public and staff choices. Existing subscribers keep it, keep receiving its releases, and keep it through a staff preferences save. Pinned in Task 2 ("disabling a list keeps its subscribers").
3. **A Core or NRMS republish after staff disable or reorder lists.** The staff choices survive; only name/active/source order change. Pinned in Task 2 ("a Core upsert keeps staff choices").
4. **Clearing a media member's "bouncing" flag.** It takes the address lock, and restarts the bounce count, so one more bounce doesn't re-flag them at once. Pinned in Task 1 ("clearing bouncing restarts the count", "resolve waits for the address lock").
5. **Opening Operations while Distribution is down.** The screen still loads, NoD's own controls still work, Distribution shows as unavailable, and nothing returns a 500 or logs an address. Pinned in Task 3 ("Distribution down") and Task 6 ("Distribution unavailable").

---

## File structure

| File | Responsibility |
|---|---|
| `apps/nod/src/http/private-errors.ts` | `privateErrorsWith(mapError, label)`: shared no-address error wrapper |
| `apps/nod/src/http/staff-subscriber-routes.ts` | Uses the shared wrapper (behaviour unchanged) |
| `apps/nod/src/http/staff-media-routes.ts` | Every media-list/member/Media Hub/sync/resolve route |
| `apps/nod/src/http/staff-list-routes.ts` | Lists & categories routes |
| `apps/nod/src/http/operations-routes.ts` | `GET /operations`, `PUT /operations/bounce-summary-address` |
| `apps/nod/src/http/routes.ts` | Drops the media routes; mounts the three new routers; `SettingsRouteDeps` grows |
| `apps/nod/src/media-members.ts` | Member/list read shapes grow; `listMediaOptOuts` |
| `apps/nod/src/media-hub/sync.ts` | `resolveMediaMember` locks; clearing `bouncing` restarts the bounce window |
| `apps/nod/src/subscribe/history.ts` | `bounce-resolved` action |
| `apps/nod/src/staff-lists.ts` | Lists view with counts, enable/disable, ordering |
| `apps/nod/src/lists.ts` | `LIST_ORDER`; offered = active + enabled + category enabled |
| `apps/nod/src/staff-subscribers/read.ts` | `listOptions` honours `enabled` and staff order |
| `apps/nod/src/settings.ts` | `writeOpsLog` exported with detail; bounce summary address get/set |
| `apps/nod/src/operations.ts` | `getOperations` |
| `apps/nod/src/bounce-summary.ts`, `start.ts`, `app.ts` | Stored summary address wins over the env default |
| `apps/nod/src/distribution-client.ts` | `bounceSource()` |
| `apps/nod/src/db/schema.ts` + migrations `0020`–`0022` | Indexes; `lists.enabled`, `lists.staff_sort_order`; `nod_settings.bounce_summary_email` |
| `apps/nrms/src/http/routes.ts` | `GET /media-lists` accepts `Core.Admin` |
| `apps/staff-web/src/screens/subscribers/*` | Section nav, access, types, labels; Lists, Media lists, Media list, Media Hub search, Resolve dialog, Operations |
| `apps/staff-web/src/screens/admin/media-lists/MediaListNamesScreen.tsx` | NRMS media-list names (Core.Admin) |
| `apps/staff-web/src/router.tsx`, `src/shell/AppShell.tsx` | Routes and nav |
| `apps/stack/src/stack.test.ts`, `tests/e2e/media-lists.spec.ts` | Callers of the old search GET |
| `tests/e2e/subscribers-admin.spec.ts` | 4g end to end |
| `docs/parity/*`, `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`, `docs/superpowers/plans/phase-4-carry-forward.md`, spec §2 table | Docs |

---

### Task 1: NoD staff media-list router (Editor access, POST search, opt-outs, resolve locking)

Closes these carry-forward items (`docs/superpowers/plans/phase-4-carry-forward.md`, "4g (staff screens…)"):
- "NoD media-list member screens" (server half);
- "A read route/screen listing who opted out of each media list" (server half);
- "Open the NoD media-list member/sync/resolve routes to `NoD.Editor`".

It also closes 4f's parked item: "`GET /media-hub/contacts?q=` also carries a search term in the URL — move to POST".

**Files:**
- Create:
  - `apps/nod/src/http/private-errors.ts`;
  - `apps/nod/src/http/staff-media-routes.ts` (+ `staff-media-routes.test.ts`).
- Modify:
  - `apps/nod/src/http/staff-subscriber-routes.ts` (use the shared wrapper);
  - `apps/nod/src/http/routes.ts` (delete the media routes at :111-219 and their schemas; mount the new router; re-export the moved schemas);
  - `apps/nod/src/http/routes.test.ts` (the shapes that change; the search calls);
  - `apps/nod/src/media-members.ts`;
  - `apps/nod/src/media-hub/sync.ts` (`resolveMediaMember`);
  - `apps/nod/src/subscribe/history.ts`, `apps/staff-web/src/screens/subscribers/labels.ts` (`bounce-resolved`);
  - `apps/nod/src/db/schema.ts` + generated migration `0020_staff_media_indexes`;
  - `apps/stack/src/stack.test.ts:963`, `tests/e2e/media-lists.spec.ts:170`.

**Interfaces:**
- Consumes:
  - `NOD_READ_ROLES`, `NOD_WRITE_ROLES` (staff-subscriber-routes.ts);
  - `staffAuth()` (`apps/nod/test/staff-auth.ts`);
  - `waitForLockWaiter` (`apps/nod/test/helpers.ts`);
  - `withLockedSubscriber`, `lockAddress` (locks.ts).
- Produces:
  - `privateErrorsWith(mapError: ErrorMapper, label: string)`, which returns `privateErrors<P>(handler)`; `type ErrorMapper = (e: unknown, res: Response) => boolean`.
  - `staffMediaRoutes(db: Db, mediaHub: MediaHubClient | null): Router`; `addMediaMemberSchema`, `resolveMediaMemberSchema`, `MEDIA_HUB_SEARCH_PAGE_SIZE = 25` (re-exported from routes.ts).
  - From `media-members.ts`:
    - `MediaMember` gains `mediaHubEmailRef: string | null` and `attentionAt: Date | null`.
    - `MediaListSummary` gains `needsAttention: number`.
    - `OPT_OUT_LIMIT = 200`; `MediaOptOut { subscriberId: string; email: string; at: Date; member: boolean }`.
    - `listMediaOptOuts(db, key): Promise<{ items: MediaOptOut[]; truncated: boolean }>`.
  - History action `bounce-resolved`.
  - **Routes (under `/nod/api`):**

    | Route | Role |
    |---|---|
    | `GET /media-lists` | read |
    | `GET /media-lists/:key/members` | read |
    | `GET /media-lists/:key/opted-out` | read |
    | `POST /media-lists/:key/members` | write |
    | `DELETE /media-lists/:key/members/:subscriberId` | write |
    | `POST /media-hub/contacts/search` body `{ q?, page? }` | write |
    | `GET /media-hub/contacts/:id` | write |
    | `GET /media-hub/sync` | read |
    | `POST /media-hub/sync` | write |
    | `POST /media-members/:subscriberId/resolve` | write |

    `GET /media-hub/contacts` is gone (404).

- [ ] **Step 1: Write the failing tests**

`apps/nod/src/http/staff-media-routes.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb, waitForLockWaiter } from "../../test/helpers";
import { staffAuth } from "../../test/staff-auth";
import { createApp } from "../app";
import { subscriberHistory, subscribers } from "../db/schema";
import { lockAddress } from "../locks";
import type { MediaHubClient } from "../media-hub/client";
import type { MediaHubContact } from "../media-hub/contract";
import { addMediaMember, optOutMediaMemberships } from "../media-members";

const contact: MediaHubContact = {
  id: 42,
  firstName: "Sam",
  lastName: "Reporter",
  outlet: "Riverbend Gazette",
  emails: [{ ref: "personal", address: "sam@riverbend.example.test", kind: "personal", organization: null, preferred: true }],
  deletedAt: null,
};

describe("staff media-list routes", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let viewer: string, editor: string, nrmsEditor: string;
  const mediaHub = { search: vi.fn(), get: vi.fn(), changes: vi.fn() };

  beforeAll(async () => {
    tdb = await createNodTestDb();
    const { auth, token } = await staffAuth();
    viewer = await token(["NoD.Viewer"]);
    editor = await token(["NoD.Editor"], "Erin Editor");
    nrmsEditor = await token(["NRMS.Editor"]);
    app = createApp({
      db: tdb.db,
      auth,
      eventSecrets: { nrms: "nrms-secret", core: "core-secret" },
      render: { siteUrl: "https://news.gov.bc.ca", bannerUrl: null },
      mediaHub: mediaHub as unknown as MediaHubClient,
    });
    await tdb.db.execute(sql`INSERT INTO lists (list_key, category, key, name) VALUES ('media-distribution-lists:budget','media-distribution-lists','budget','Budget')`);
  });
  afterAll(async () => tdb.drop());
  beforeEach(() => {
    mediaHub.search.mockReset();
    mediaHub.get.mockReset();
  });

  const as = (tok: string) => ({
    get: (p: string) => request(app).get(p).set("authorization", `Bearer ${tok}`),
    post: (p: string, body: object = {}) => request(app).post(p).set("authorization", `Bearer ${tok}`).send(body),
    del: (p: string) => request(app).delete(p).set("authorization", `Bearer ${tok}`),
  });

  it("a NoD Viewer reads lists, members, opt-outs and sync status, and is refused every write", async () => {
    for (const p of ["/api/media-lists", "/api/media-lists/budget/members", "/api/media-lists/budget/opted-out", "/api/media-hub/sync"]) {
      expect((await as(viewer).get(p)).status, p).toBe(200);
    }
    expect((await as(viewer).post("/api/media-lists/budget/members", { email: "v@example.test" })).status).toBe(403);
    expect((await as(viewer).del("/api/media-lists/budget/members/00000000-0000-0000-0000-000000000000")).status).toBe(403);
    expect((await as(viewer).post("/api/media-hub/contacts/search", { q: "Sam" })).status).toBe(403);
    expect((await as(viewer).get("/api/media-hub/contacts/42")).status).toBe(403);
    expect((await as(viewer).post("/api/media-hub/sync")).status).toBe(403);
    expect((await as(viewer).post("/api/media-members/00000000-0000-0000-0000-000000000000/resolve")).status).toBe(403);
    expect((await as(nrmsEditor).get("/api/media-lists")).status).toBe(403);
  });

  it("a NoD Editor adds and removes a member, recorded under their name", async () => {
    const added = await as(editor).post("/api/media-lists/budget/members", { email: "erin-adds@example.test" });
    expect(added.status).toBe(201);
    const removed = await as(editor).del(`/api/media-lists/budget/members/${added.body.subscriberId}`);
    expect(removed.status).toBe(204);
    const actions = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, added.body.subscriberId));
    expect(actions.map((h) => [h.action, h.actor])).toEqual(expect.arrayContaining([["media-list-added", "Erin Editor"], ["media-list-removed", "Erin Editor"]]));
  });

  it("search travels in a POST body with a fixed page size; the old GET path is gone", async () => {
    mediaHub.search.mockResolvedValue({ contacts: [contact], page: 2, pageSize: 25, total: 26 });
    const res = await as(editor).post("/api/media-hub/contacts/search", { q: " Sam ", page: 2 });
    expect(res.status).toBe(200);
    expect(mediaHub.search).toHaveBeenCalledWith("Sam", 2, 25);
    expect(res.body.contacts).toEqual([contact]);
    expect((await as(editor).post("/api/media-hub/contacts/search", {})).status).toBe(200);
    expect(mediaHub.search).toHaveBeenLastCalledWith("", 1, 25);
    expect((await as(editor).get("/api/media-hub/contacts?q=Sam")).status).toBe(404);
  });

  it("a failing search logs neither the term nor an address", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mediaHub.search.mockRejectedValue(new Error("boom while searching for secret-term pat@example.test"));
    const res = await as(editor).post("/api/media-hub/contacts/search", { q: "secret-term" });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "internal error" });
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).not.toContain("secret-term");
    expect(logged).not.toContain("@");
    spy.mockRestore();
  });

  it("GET /media-hub/contacts/:id returns a live contact; unknown, deleted or non-numeric ids are 404", async () => {
    mediaHub.get.mockImplementation(async (id: number) => (id === 42 ? contact : id === 43 ? { ...contact, id: 43, deletedAt: "2026-10-01T00:00:00Z" } : null));
    expect((await as(editor).get("/api/media-hub/contacts/42")).body).toEqual(contact);
    expect((await as(editor).get("/api/media-hub/contacts/43")).status).toBe(404);
    expect((await as(editor).get("/api/media-hub/contacts/44")).status).toBe(404);
    expect((await as(editor).get("/api/media-hub/contacts/abc")).status).toBe(404);
  });

  it("DELETE and resolve with a non-uuid subscriber id are 404s, never 500s", async () => {
    expect((await as(editor).del("/api/media-lists/budget/members/not-a-uuid")).status).toBe(404);
    expect((await as(editor).post("/api/media-members/not-a-uuid/resolve")).status).toBe(404);
  });

  it("the opted-out view lists who left the list by unsubscribing, newest first, and whether they're back", async () => {
    const { subscriberId } = await addMediaMember(tdb.db, "budget", { email: "left@example.test", source: "manual-media" }, "t");
    await optOutMediaMemberships(tdb.db, subscriberId, "subscriber");
    const out = await as(viewer).get("/api/media-lists/budget/opted-out");
    expect(out.body.truncated).toBe(false);
    expect(out.body.items[0]).toMatchObject({ subscriberId, email: "left@example.test", member: false });
    await addMediaMember(tdb.db, "budget", { email: "left@example.test", source: "manual-media", confirmOptOut: true }, "t");
    expect((await as(viewer).get("/api/media-lists/budget/opted-out")).body.items[0]).toMatchObject({ subscriberId, member: true });
    expect((await as(viewer).get("/api/media-lists/nope/opted-out")).status).toBe(404);
  });

  it("clearing bouncing restarts the count and records bounce-resolved", async () => {
    const { subscriberId } = await addMediaMember(tdb.db, "budget", { email: "bouncy@example.test", source: "manual-media" }, "t");
    await tdb.db.update(subscribers).set({ needsAttention: "bouncing", attentionAt: sql`now()` }).where(eq(subscribers.id, subscriberId));
    const res = await as(editor).post(`/api/media-members/${subscriberId}/resolve`, {});
    expect(res.status).toBe(200);
    const [row] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId));
    expect(row).toMatchObject({ needsAttention: null, attentionAt: null });
    expect(row!.bounceWindowFrom).not.toBeNull();
    const resolved = await tdb.db.select().from(subscriberHistory).where(and(eq(subscriberHistory.subscriberId, subscriberId), eq(subscriberHistory.action, "bounce-resolved")));
    expect(resolved.map((h) => h.actor)).toEqual(["Erin Editor"]);
  });

  it("resolve without a ref waits for the address lock", async () => {
    const { subscriberId } = await addMediaMember(tdb.db, "budget", { email: "locked@example.test", source: "manual-media" }, "t");
    await tdb.db.update(subscribers).set({ needsAttention: "bouncing", attentionAt: sql`now()` }).where(eq(subscribers.id, subscriberId));
    let release!: () => void;
    let locked!: () => void;
    const lockHeld = new Promise<void>((r) => (locked = r));
    const holder = tdb.db.transaction(async (tx) => {
      await lockAddress(tx, "locked@example.test");
      locked();
      await new Promise<void>((r) => (release = r));
    });
    await lockHeld;
    const resolving = as(editor).post(`/api/media-members/${subscriberId}/resolve`, {}).then((r) => r.status);
    await waitForLockWaiter(tdb.db);
    expect((await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId)))[0]!.needsAttention).toBe("bouncing");
    release();
    await holder;
    expect(await resolving).toBe(200);
  });

  it("list summaries count members needing attention; members carry their ref and flag time", async () => {
    const { subscriberId } = await addMediaMember(tdb.db, "budget", { email: "flagged@example.test", source: "manual-media" }, "t");
    await tdb.db.update(subscribers).set({ needsAttention: "bouncing", attentionAt: sql`now()` }).where(eq(subscribers.id, subscriberId));
    const lists = await as(viewer).get("/api/media-lists");
    expect(lists.body.find((l: { key: string }) => l.key === "budget").needsAttention).toBeGreaterThanOrEqual(1);
    const members = await as(viewer).get("/api/media-lists/budget/members");
    expect(members.body.find((m: { subscriberId: string }) => m.subscriberId === subscriberId)).toMatchObject({ needsAttention: "bouncing", mediaHubEmailRef: null });
    expect(members.body.find((m: { subscriberId: string }) => m.subscriberId === subscriberId).attentionAt).toEqual(expect.any(String));
  });

  it("the member and opt-out lookups have their indexes", async () => {
    const { rows } = await tdb.pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE indexname IN ('subscriptions_list_key_idx','subscriber_history_action_detail_at_idx') ORDER BY indexname",
    );
    expect(rows.map((r) => r.indexname)).toEqual(["subscriber_history_action_detail_at_idx", "subscriptions_list_key_idx"]);
  });
});
```

`apps/nod/src/http/routes.test.ts` (the media blocks stay where they are, since they still run through `createApp`). Change only:
- The two role-test titles at :333 and :344, to "401s without a token, 403s with no NoD role, …". The assertions stay: `reader` has no roles, so it is still 403.
- The `:359` expectation:
  `expect(res.body).toEqual([{ listKey: "media-distribution-lists:budget", key: "budget", name: "Budget", active: true, members: 1, needsAttention: 0 }]);`
- The `:371` expectation:
  `expect(res.body).toContainEqual({ subscriberId, email: "shown@example.com", source: "manual-media", mediaHubContactId: null, mediaHubEmailRef: null, needsAttention: null, attentionAt: null });`
- The test at `:510`, renamed and rewritten:

```ts
  it("POST /api/media-hub/contacts/search proxies search with a fixed pageSize of 25", async () => {
    const res = await request(app).post("/api/media-hub/contacts/search").send({ q: "Sam", page: 1 }).set("authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(mediaHub.search).toHaveBeenCalledWith("Sam", 1, 25);
    expect(res.body.contacts).toEqual([sampleHubContact]);
  });
```

- `:700`:
  `const search = await request(app).post("/api/media-hub/contacts/search").send({ q: "x" }).set("authorization", `Bearer ${admin}`);`

`apps/stack/src/stack.test.ts:963`:

```ts
      const res = await fetch(`${instance.stackUrl}/nod/api/media-hub/contacts/search`, {
        method: "POST",
        headers: { authorization: `Bearer ${instance.adminToken}`, "content-type": "application/json" },
        body: JSON.stringify({ page: 1 }),
      });
```

`tests/e2e/media-lists.spec.ts:170`:

```ts
    const search = await apiCall<{ contacts: MediaHubContact[] }>(adminCookie, "/nod/api/media-hub/contacts/search", { method: "POST", body: { q: "" } });
```

- [ ] **Step 2: Run them; expect FAIL**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/http/staff-media-routes.test.ts apps/nod/src/http/routes.test.ts`

Expected:
- the Viewer gets 403 on the reads (`requireRole("NoD.Admin")`);
- `POST /media-hub/contacts/search` is 404;
- `opted-out` is 404;
- `needsAttention` and `mediaHubEmailRef` are missing;
- the bouncing resolve writes `media-hub-resolved` and leaves `bounceWindowFrom` null;
- the lock test sees the flag cleared while the lock is held;
- the index test finds none.

- [ ] **Step 3: Schema, indexes and history action**

`apps/nod/src/db/schema.ts`:
- `subscriptions`' third argument becomes:

```ts
  (t) => [
    primaryKey({ columns: [t.subscriberId, t.listKey] }),
    // Per-list member reads (media-members.ts) and per-list counts (staff-lists.ts): the
    // primary key leads with subscriber_id, so it can't serve a lookup by list.
    index("subscriptions_list_key_idx").on(t.listKey),
  ],
```

- `subscriberHistory`'s index array gains:

```ts
    // The per-media-list opt-out view (media-members.ts listMediaOptOuts): equality on action
    // and detail (the list key), newest first.
    index("subscriber_history_action_detail_at_idx").on(t.action, t.detail, t.at),
```

Generate: `cd apps/nod && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name staff_media_indexes`. Expect two `CREATE INDEX` statements and nothing else.

`apps/nod/src/subscribe/history.ts`: add `"bounce-resolved",` after `"bounce-flagged",` in `HISTORY_ACTIONS`.

`apps/staff-web/src/screens/subscribers/labels.ts` `HISTORY_LABELS`: add after `"bounce-flagged"`:

```ts
  "bounce-resolved": "Bouncing flag cleared by staff (bounce count restarts)",
```

- [ ] **Step 4: Shared error wrapper**

`apps/nod/src/http/private-errors.ts`:

```ts
import type { Request, Response } from "express";
import { safeErrorLabel } from "../subscribe/journeys";

/** Maps a router's own domain errors to a response; false for anything it doesn't know. */
export type ErrorMapper = (e: unknown, res: Response) => boolean;

/**
 * Wraps handlers so an error never reaches `next(err)`. These routers' queries bind email
 * addresses or search terms, a DrizzleQueryError's message carries its bound params, and the
 * shared jsonErrorHandler logs the whole error. Known errors go through `mapError`; anything
 * else is a bare 500, logged by its Postgres code or error name only.
 */
export function privateErrorsWith(mapError: ErrorMapper, label: string) {
  return function privateErrors<P>(handler: (req: Request<P>, res: Response) => Promise<void>) {
    return (req: Request<P>, res: Response): void => {
      handler(req, res).catch((e: unknown) => {
        if (mapError(e, res)) return;
        console.error(`[nod] ${label} failed`, safeErrorLabel(e));
        if (!res.headersSent) res.status(500).json({ error: "internal error" });
      });
    };
  };
}
```

`apps/nod/src/http/staff-subscriber-routes.ts`:
- delete the local `privateErrors` function (and its doc comment) and the now-unused `safeErrorLabel` and `Request` imports;
- after `mapError`, add:

```ts
/** Every handler here binds addresses or search terms (see private-errors.ts). */
export const privateErrors = privateErrorsWith(mapError, "staff subscriber request");
```

- import `privateErrorsWith` from `./private-errors`.

The 4f test "privateErrors logs no address" must stay green unchanged.

- [ ] **Step 5: media-members.ts reads**

Replace `MediaMember`, `MediaListSummary`, `listMediaMembers` and `listMediaLists`, and add `listMediaOptOuts`:

```ts
export interface MediaMember {
  subscriberId: string;
  email: string;
  source: string;
  mediaHubContactId: number | null;
  /** The chosen Media Hub email's ref; what the resolve screen preselects against. */
  mediaHubEmailRef: string | null;
  needsAttention: string | null;
  attentionAt: Date | null;
}

export interface MediaListSummary {
  listKey: string;
  key: string;
  name: string;
  active: boolean;
  members: number;
  /** Members with a needs-attention flag (C59): what the index screen surfaces first. */
  needsAttention: number;
}

/** Every member of `listKey`, for the staff member-management screen. Not paged: media lists
 * hold hundreds of members, and legacy showed them all on one page. */
export async function listMediaMembers(db: DbOrTx, listKey: string): Promise<MediaMember[]> {
  const key = mediaListKey(listKey);
  if (!(await mediaListRow(db, key))) throw new MediaListNotFoundError(listKey);
  return db
    .select({
      subscriberId: subscribers.id,
      email: subscribers.email,
      source: subscribers.source,
      mediaHubContactId: subscribers.mediaHubContactId,
      mediaHubEmailRef: subscribers.mediaHubEmailRef,
      needsAttention: subscribers.needsAttention,
      attentionAt: subscribers.attentionAt,
    })
    .from(subscriptions)
    .innerJoin(subscribers, eq(subscribers.id, subscriptions.subscriberId))
    .where(eq(subscriptions.listKey, key))
    .orderBy(asc(subscribers.email));
}

/** Every media list, with live member and needs-attention counts, for the staff media-lists screen. */
export async function listMediaLists(db: DbOrTx): Promise<MediaListSummary[]> {
  return db
    .select({
      listKey: lists.listKey,
      key: lists.key,
      name: lists.name,
      active: lists.active,
      members: sql<number>`count(${subscriptions.subscriberId})::int`,
      needsAttention: sql<number>`count(${subscribers.id}) FILTER (WHERE ${subscribers.needsAttention} IS NOT NULL)::int`,
    })
    .from(lists)
    .leftJoin(subscriptions, eq(subscriptions.listKey, lists.listKey))
    .leftJoin(subscribers, eq(subscribers.id, subscriptions.subscriberId))
    .where(eq(lists.category, MEDIA_CATEGORY))
    .groupBy(lists.listKey, lists.key, lists.name, lists.active, lists.sortOrder)
    .orderBy(asc(lists.sortOrder), asc(lists.name));
}

/** How many opt-outs the per-list view returns; the newest are what staff act on. */
export const OPT_OUT_LIMIT = 200;

export interface MediaOptOut {
  subscriberId: string;
  /** The subscriber's current address (it may have moved since they opted out). */
  email: string;
  at: Date;
  /** Whether they're on this list again now (re-added by staff with confirmation). */
  member: boolean;
}

/**
 * Who left `listKey` by unsubscribing (history `media-list-opted-out`, whose detail is the full
 * list key), newest first, at most {@link OPT_OUT_LIMIT}. Staff removals are not opt-outs and
 * never appear here (C82). Served by subscriber_history_action_detail_at_idx.
 */
export async function listMediaOptOuts(db: DbOrTx, listKey: string): Promise<{ items: MediaOptOut[]; truncated: boolean }> {
  const key = mediaListKey(listKey);
  if (!(await mediaListRow(db, key))) throw new MediaListNotFoundError(listKey);
  const { rows } = await db.execute<{ subscriber_id: string; email: string; at: string | Date; member: boolean }>(sql`
    SELECT h.subscriber_id, s.email, h.at,
           EXISTS (SELECT 1 FROM subscriptions x WHERE x.subscriber_id = h.subscriber_id AND x.list_key = ${key}) AS member
      FROM subscriber_history h
      JOIN subscribers s ON s.id = h.subscriber_id
     WHERE h.action = 'media-list-opted-out' AND h.detail = ${key}
     ORDER BY h.at DESC
     LIMIT ${OPT_OUT_LIMIT + 1}`);
  return {
    items: rows.slice(0, OPT_OUT_LIMIT).map((r) => ({ subscriberId: r.subscriber_id, email: r.email, at: new Date(r.at), member: r.member })),
    truncated: rows.length > OPT_OUT_LIMIT,
  };
}
```

- [ ] **Step 6: resolveMediaMember takes the lock; clearing bouncing restarts the count**

In `apps/nod/src/media-hub/sync.ts`:
- change the import to `import { lockAddress, withLockedSubscriber } from "../locks";`;
- replace the `if (emailRef === undefined) { … }` block of `resolveMediaMember` with:

```ts
  if (emailRef === undefined) {
    // Clearing a flag is a write to the subscriber row, so it takes the address lock like every
    // other writer (locks.ts). Clearing "bouncing" means staff judge the mailbox fixed: the
    // bounce threshold restarts from now, as a staff reactivation does (C84), so the bounces
    // that caused the flag don't re-flag the member on the very next one.
    return withLockedSubscriber(db, subscriberId, null, async (tx, s): Promise<ResolveOutcome> => {
      if (!s) return "not-found";
      if (s.needsAttention === null) return "resolved";
      const bouncing = s.needsAttention === "bouncing";
      await tx
        .update(subscribers)
        .set({ needsAttention: null, attentionAt: null, ...(bouncing ? { bounceWindowFrom: sql`now()` } : {}) })
        .where(eq(subscribers.id, s.id));
      if (bouncing) await writeHistory(tx, s.id, actor, "bounce-resolved");
      else await writeHistory(tx, s.id, actor, "media-hub-resolved", s.mediaHubEmailRef ?? "");
      return "resolved";
    });
  }
```

Leave the `[current]` read above it; the ref path still uses it. Update the function's doc comment: "With no `emailRef`, clears the flag under the address lock; clearing `bouncing` also restarts the bounce window."

- [ ] **Step 7: The router**

`apps/nod/src/http/staff-media-routes.ts`:

```ts
import { Router, type Response } from "express";
import { z, ZodError } from "zod";
import type { Db } from "@gcpe/db-kit";
import { actorOf, requireAnyRole } from "@gcpe/auth";
import { MediaHubError, type MediaHubClient } from "../media-hub/client";
import { getMediaSyncStatus, resolveMediaMember, runMediaSync } from "../media-hub/sync";
import { addMediaMember, listMediaLists, listMediaMembers, listMediaOptOuts, MediaListNotFoundError, OptedOutError, removeMediaMember } from "../media-members";
import { emailAddressSchema } from "../subscribe/info";
import { privateErrorsWith } from "./private-errors";
import { NOD_READ_ROLES, NOD_WRITE_ROLES } from "./staff-subscriber-routes";

export const addMediaMemberSchema = z.union([
  z.object({ email: emailAddressSchema, confirmOptOut: z.boolean().optional() }),
  z.object({ mediaHubContactId: z.number().int(), emailRef: z.string().min(1), confirmOptOut: z.boolean().optional() }),
]);

export const resolveMediaMemberSchema = z.object({ emailRef: z.string().min(1).optional() });

/** Staff choose a query and page, never a page size. */
export const MEDIA_HUB_SEARCH_PAGE_SIZE = 25;

const searchBody = z.object({
  q: z.string().trim().max(200).default(""),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});
const uuid = z.string().uuid();
const contactId = z.string().regex(/^\d{1,9}$/).transform(Number);

function mapError(e: unknown, res: Response): boolean {
  if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues }), true;
  if (e instanceof MediaListNotFoundError) return void res.status(404).json({ error: "not found" }), true;
  if (e instanceof OptedOutError) return void res.status(409).json({ error: "opted-out", at: e.at.toISOString() }), true;
  if (e instanceof MediaHubError) {
    // Kind and status only: the client's own messages are address-free, but a network error's
    // text comes from the platform and is not ours to vouch for.
    console.error("[nod] Media Hub call failed", e.kind, e.status ?? "");
    res.status(502).json({ error: "media hub unavailable" });
    return true;
  }
  return false;
}

/** Member adds bind addresses, and search binds a term (see private-errors.ts). */
const privateErrors = privateErrorsWith(mapError, "staff media-list request");
const notFound = (res: Response) => void res.status(404).json({ error: "not found" });
const noHub = (res: Response) => void res.status(503).json({ error: "media hub not configured" });

/**
 * Media lists for the staff section (spec §8): NoD Viewers read lists, members, opt-outs and
 * the sync status; NoD Editors and Admins change membership, search Media Hub, run the sync
 * and resolve flags. List names and keys come from NRMS (C47) and aren't edited here.
 */
export function staffMediaRoutes(db: Db, mediaHub: MediaHubClient | null): Router {
  const r = Router();
  const read = requireAnyRole(...NOD_READ_ROLES);
  const write = requireAnyRole(...NOD_WRITE_ROLES);

  r.get("/media-lists", read, privateErrors(async (_req, res) => {
    res.json(await listMediaLists(db));
  }));

  r.get("/media-lists/:key/members", read, privateErrors<{ key: string }>(async (req, res) => {
    res.json(await listMediaMembers(db, req.params.key));
  }));

  r.get("/media-lists/:key/opted-out", read, privateErrors<{ key: string }>(async (req, res) => {
    res.json(await listMediaOptOuts(db, req.params.key));
  }));

  r.post("/media-lists/:key/members", write, privateErrors<{ key: string }>(async (req, res) => {
    const parsed = addMediaMemberSchema.parse(req.body);
    const actor = actorOf(req).name;
    if ("mediaHubContactId" in parsed) {
      if (!mediaHub) return noHub(res);
      const contact = await mediaHub.get(parsed.mediaHubContactId);
      const email = contact?.deletedAt ? undefined : contact?.emails.find((e) => e.ref === parsed.emailRef);
      if (!contact || contact.deletedAt || !email) return notFound(res);
      // The contract doesn't require a valid address (contract.ts); it's checked here, with the
      // same schema and response as a manual add's bad email.
      const address = emailAddressSchema.safeParse(email.address);
      if (!address.success) return void res.status(400).json({ error: "invalid request", issues: address.error.issues });
      const { subscriberId, created } = await addMediaMember(
        db,
        req.params.key,
        { email: address.data, source: "media-hub", mediaHubContactId: parsed.mediaHubContactId, mediaHubEmailRef: parsed.emailRef, confirmOptOut: parsed.confirmOptOut },
        actor,
      );
      return void res.status(created ? 201 : 200).json({ subscriberId, created });
    }
    const { subscriberId, created } = await addMediaMember(db, req.params.key, { email: parsed.email, source: "manual-media", confirmOptOut: parsed.confirmOptOut }, actor);
    res.status(created ? 201 : 200).json({ subscriberId, created });
  }));

  r.delete("/media-lists/:key/members/:subscriberId", write, privateErrors<{ key: string; subscriberId: string }>(async (req, res) => {
    if (!uuid.safeParse(req.params.subscriberId).success) return notFound(res);
    await removeMediaMember(db, req.params.key, req.params.subscriberId, actorOf(req).name);
    res.status(204).end();
  }));

  // The term is usually a name or an address, and a URL's query string lands in every proxy's
  // access log and in browser history, so it travels in the body (as subscriber search does).
  r.post("/media-hub/contacts/search", write, privateErrors(async (req, res) => {
    if (!mediaHub) return noHub(res);
    const { q, page } = searchBody.parse(req.body ?? {});
    res.json(await mediaHub.search(q, page, MEDIA_HUB_SEARCH_PAGE_SIZE));
  }));

  // One contact's current emails, for the resolve dialog.
  r.get("/media-hub/contacts/:id", write, privateErrors<{ id: string }>(async (req, res) => {
    const id = contactId.safeParse(req.params.id);
    if (!id.success) return notFound(res);
    if (!mediaHub) return noHub(res);
    const contact = await mediaHub.get(id.data);
    if (!contact || contact.deletedAt) return notFound(res);
    res.json(contact);
  }));

  r.get("/media-hub/sync", read, privateErrors(async (_req, res) => {
    res.json(await getMediaSyncStatus(db));
  }));

  r.post("/media-hub/sync", write, privateErrors(async (_req, res) => {
    if (!mediaHub) return noHub(res);
    const outcome = await runMediaSync(db, mediaHub);
    if (outcome === "busy") return void res.status(409).json({ error: "sync in progress" });
    res.json(outcome);
  }));

  r.post("/media-members/:subscriberId/resolve", write, privateErrors<{ subscriberId: string }>(async (req, res) => {
    if (!uuid.safeParse(req.params.subscriberId).success) return notFound(res);
    const parsed = resolveMediaMemberSchema.parse(req.body ?? {});
    const outcome = await resolveMediaMember(db, mediaHub, req.params.subscriberId, parsed.emailRef, actorOf(req).name);
    if (outcome === "not-found" || outcome === "ref-not-found") return notFound(res);
    if (outcome === "media-hub-unavailable") return noHub(res);
    if (outcome === "invalid-email") return void res.status(400).json({ error: "invalid email" });
    if (outcome === "email-taken") return void res.status(409).json({ error: "email-taken" });
    if (outcome === "conflict") return void res.status(409).json({ error: "changed, retry" });
    res.status(200).json({ ok: true });
  }));

  return r;
}
```

`apps/nod/src/http/routes.ts`:
- Delete every route from `r.get("/media-lists", …)` through `r.post("/media-members/:subscriberId/resolve", …)`.
- Delete the local `addMediaMemberSchema`, `resolveMediaMemberSchema` and `MEDIA_HUB_SEARCH_PAGE_SIZE`.
- Delete the `MediaListNotFoundError`, `OptedOutError` and `MediaHubError` cases from `handleError`. `bouncesInboxRoutes` and the remaining routes never throw them.
- Remove the now-unused imports (`getMediaSyncStatus`, `resolveMediaMember`, `runMediaSync`, the media-members functions, `MediaHubError`).
- Add next to the existing re-exports:

```ts
/** Moved to staff-media-routes.ts with the routes that use them; re-exported for callers that
 * import them from here. */
export { addMediaMemberSchema, resolveMediaMemberSchema, MEDIA_HUB_SEARCH_PAGE_SIZE } from "./staff-media-routes";
```

- Just before `r.use(staffSubscriberRoutes(db));`, add `r.use(staffMediaRoutes(db, mediaHub));` and import `staffMediaRoutes`.

Then run `grep -rn "addMediaMemberSchema\|resolveMediaMemberSchema" apps/nod/src`. Every hit must resolve.

- [ ] **Step 8: Run; expect PASS**

Run the Step 2 command, then `apps/nod apps/stack/src/stack.test.ts apps/staff-web/src/screens/subscribers/labels.test.ts`. Expect PASS. The stack test needs the full stack, the same as in CI. If it is skipped locally, say so in the commit body.

- [ ] **Step 9: Type-check both projects, then commit**

```bash
git add apps/nod apps/stack/src/stack.test.ts tests/e2e/media-lists.spec.ts apps/staff-web/src/screens/subscribers/labels.ts
git commit -m "feat(nod): staff media-list router — Viewer reads, Editor writes, POST Media Hub search, opt-out view, locked resolve"
```

---

### Task 2: NoD lists & categories API

**Files:**
- Create:
  - `apps/nod/src/staff-lists.ts` (+ `staff-lists.test.ts`);
  - `apps/nod/src/http/staff-list-routes.ts` (+ `staff-list-routes.test.ts`).
- Modify:
  - `apps/nod/src/db/schema.ts` (`lists`) + generated migration `0021_list_staff_fields`;
  - `apps/nod/src/lists.ts` (`LIST_ORDER`, `publicListItems`, `activeListKeys`);
  - `apps/nod/src/staff-subscribers/read.ts` (`listOptions`);
  - `apps/nod/src/settings.ts` (`writeOpsLog` exported with `detail`; `OperationsAction` grows);
  - `apps/nod/src/http/routes.ts` (mount).

**Interfaces:**
- Consumes: `privateErrorsWith` (Task 1); `NOD_READ_ROLES` (staff-subscriber-routes.ts); `listsHandler`, `MEDIA_CATEGORY` (lists.ts); `updatePreferences` (staff-subscribers/actions.ts); `countSubscribers` (subscribers.ts).
- Produces:
  - `lists.enabled` (boolean, default true) and `lists.staff_sort_order` (integer, nullable).
  - `LIST_ORDER` (lists.ts): staff order first (nulls last), then the source's `sort_order`, then name.
  - `writeOpsLog(dbOrTx, actor, action, detail = "")`, exported.
  - `OperationsAction` adds `"category-enabled" | "category-disabled" | "categories-reordered" | "lists-reordered" | "list-enabled" | "list-disabled" | "bounce-summary-address-changed"`.
  - From `staff-lists.ts`:
    - `type NamesFrom = "Core" | "NRMS" | "NoD"`.
    - `StaffList { listKey; key; name; active: boolean; enabled: boolean; subscribers: number }`.
    - `StaffCategory { key; name; enabled: boolean; namesFrom: NamesFrom; editable: boolean; lists: StaffList[] }`.
    - `StaffListsView { allNews: number; categories: StaffCategory[] }`.
    - `staffListsView(db)`.
    - `setCategoryEnabled(db, key, enabled, actor)` and `setListEnabled(db, listKey, enabled, actor)`, each returning `{ changed: boolean }`.
    - `reorderCategories(db, keys, actor)` and `reorderLists(db, category, listKeys, actor)`, each returning `void`.
    - Errors: `ListNotFoundError`, `ManagedInNrmsError`, `OrderOutOfDateError`.
  - `NOD_ADMIN_ROLES = ["NoD.Admin"] as const` and `staffListRoutes(db): Router` (staff-list-routes.ts).
  - **Routes:**
    - `GET /list-categories` (read) → `StaffListsView`.
    - Admin only:
      - `PUT /list-categories/order` `{ keys }`;
      - `PUT /list-categories/:key` `{ enabled }`;
      - `PUT /list-categories/:key/list-order` `{ listKeys }`;
      - `PUT /lists/:listKey` `{ enabled }`.
    - Responses: `{ changed }` from the two enable routes, `{ ok: true }` from the two order routes. 404 for an unknown key. 409 `{ error: "managed-in-nrms" }` for media, and 409 `{ error: "order-out-of-date" }` for an order that isn't an exact permutation.

- [ ] **Step 1: Write the failing tests**

`apps/nod/src/staff-lists.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import type { EventEnvelope } from "@gcpe/events";
import { createNodTestDb } from "../test/helpers";
import { lists, operationsLog, subscribers, subscriptions } from "./db/schema";
import { activeListKeys, listsHandler, publicListItems } from "./lists";
import { updatePreferences } from "./staff-subscribers/actions";
import { listOptions } from "./staff-subscribers/read";
import { countSubscribers } from "./subscribers";
import { ListNotFoundError, ManagedInNrmsError, OrderOutOfDateError, reorderCategories, reorderLists, setCategoryEnabled, setListEnabled, staffListsView } from "./staff-lists";

describe("staff lists", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createNodTestDb();
  });
  afterAll(async () => tdb.drop());
  beforeEach(async () => {
    await tdb.db.execute(sql`
      DELETE FROM subscribers; DELETE FROM operations_log;
      DELETE FROM lists WHERE category <> 'emergency';
      INSERT INTO list_categories (key, name, enabled, sort_order) VALUES ('ministries','Ministries',true,1),('sectors','Sectors',true,2),('media-distribution-lists','Media distribution lists',true,9)
        ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled, sort_order = EXCLUDED.sort_order;
      INSERT INTO lists (list_key, category, key, name, active, sort_order) VALUES
        ('ministries:health','ministries','health','Health',true,1),
        ('ministries:energy','ministries','energy','Energy',true,2),
        ('ministries:old','ministries','old','Old ministry',false,3),
        ('media-distribution-lists:budget','media-distribution-lists','budget','Budget',true,1)`);
  });

  const addActive = async (email: string, keys: string[]) => {
    const [s] = await tdb.db.insert(subscribers).values({ email, status: "active", verifiedAt: new Date(), asItHappens: true }).returning();
    if (keys.length) await tdb.db.insert(subscriptions).values(keys.map((listKey) => ({ subscriberId: s!.id, listKey })));
    return s!;
  };

  it("counts active subscribers per list and all news, in category then list order; media is read-only", async () => {
    await addActive("a@example.test", ["*", "ministries:health"]);
    await addActive("b@example.test", ["ministries:health"]);
    const [d] = await tdb.db.insert(subscribers).values({ email: "c@example.test", status: "disabled" }).returning();
    await tdb.db.insert(subscriptions).values({ subscriberId: d!.id, listKey: "ministries:health" });
    const view = await staffListsView(tdb.db);
    expect(view.allNews).toBe(1);
    expect(view.categories.map((c) => c.key).slice(0, 2)).toEqual(["ministries", "sectors"]);
    const ministries = view.categories.find((c) => c.key === "ministries")!;
    expect(ministries).toMatchObject({ namesFrom: "Core", editable: true, enabled: true });
    expect(ministries.lists.map((l) => [l.key, l.subscribers, l.active])).toEqual([["health", 2, true], ["energy", 0, true], ["old", 0, false]]);
    expect(view.categories.find((c) => c.key === "media-distribution-lists")).toMatchObject({ namesFrom: "NRMS", editable: false });
    expect(view.categories.find((c) => c.key === "emergency")).toMatchObject({ namesFrom: "NoD", editable: true });
  });

  it("disabling a list keeps its subscribers: hidden from every choice, kept through a staff save, still a recipient", async () => {
    const s = await addActive("keep@example.test", ["ministries:health"]);
    expect(await setListEnabled(tdb.db, "ministries:health", false, "Jamie")).toEqual({ changed: true });
    expect((await publicListItems(tdb.db, "ministries")).map((l) => l.key)).toEqual(["energy"]);
    expect(await activeListKeys(tdb.db, ["ministries:health"])).toEqual([]);
    expect((await listOptions(tdb.db)).categories.flatMap((c) => c.lists.map((l) => l.listKey))).not.toContain("ministries:health");
    await updatePreferences(tdb.db, s.id, { asItHappens: true, digest: false, allNews: false, listKeys: ["ministries:health", "ministries:energy"] }, "Jamie");
    const held = await tdb.db.select({ k: subscriptions.listKey }).from(subscriptions).where(eq(subscriptions.subscriberId, s.id));
    expect(held.map((h) => h.k).sort()).toEqual(["ministries:energy", "ministries:health"]);
    expect(await countSubscribers(tdb.db, ["ministries:health"])).toBe(1);
    expect(await setListEnabled(tdb.db, "ministries:health", false, "Jamie")).toEqual({ changed: false });
    const log = await tdb.db.select().from(operationsLog);
    expect(log.map((l) => [l.action, l.detail, l.actor])).toEqual([["list-disabled", "ministries:health", "Jamie"]]);
  });

  it("a Core upsert keeps staff choices: enabled and staff order survive a rename and re-sort", async () => {
    await setListEnabled(tdb.db, "ministries:health", false, "Jamie");
    await reorderLists(tdb.db, "ministries", ["ministries:energy", "ministries:old", "ministries:health"], "Jamie");
    const event = { source: "core", type: "org.upserted", data: { key: "health", displayName: "Health (renamed)", sortOrder: 0, isActive: true } } as unknown as EventEnvelope;
    await tdb.db.transaction(async (tx) => listsHandler(event)!(tx, event));
    const [row] = await tdb.db.select().from(lists).where(eq(lists.listKey, "ministries:health"));
    expect(row).toMatchObject({ name: "Health (renamed)", sortOrder: 0, enabled: false, staffSortOrder: 3 });
    expect((await staffListsView(tdb.db)).categories.find((c) => c.key === "ministries")!.lists.map((l) => l.key)).toEqual(["energy", "old", "health"]);
  });

  it("a list Core adds after a reorder sorts after the staff-ordered ones", async () => {
    await reorderLists(tdb.db, "ministries", ["ministries:old", "ministries:energy", "ministries:health"], "Jamie");
    await tdb.db.execute(sql`INSERT INTO lists (list_key, category, key, name, sort_order) VALUES ('ministries:aaa','ministries','aaa','Aaa',0)`);
    expect((await publicListItems(tdb.db, "ministries")).map((l) => l.key)).toEqual(["energy", "health", "aaa"]);
    expect((await staffListsView(tdb.db)).categories.find((c) => c.key === "ministries")!.lists.map((l) => l.key)).toEqual(["old", "energy", "health", "aaa"]);
  });

  it("an order must be an exact permutation", async () => {
    await expect(reorderLists(tdb.db, "ministries", ["ministries:health", "ministries:energy"], "J")).rejects.toBeInstanceOf(OrderOutOfDateError);
    await expect(reorderLists(tdb.db, "ministries", ["ministries:health", "ministries:health", "ministries:old"], "J")).rejects.toBeInstanceOf(OrderOutOfDateError);
    const all = (await staffListsView(tdb.db)).categories.map((c) => c.key);
    await expect(reorderCategories(tdb.db, all.slice(1), "J")).rejects.toBeInstanceOf(OrderOutOfDateError);
    await reorderCategories(tdb.db, [...all].reverse(), "J");
    expect((await staffListsView(tdb.db)).categories.map((c) => c.key)).toEqual([...all].reverse());
  });

  it("media lists and their category are managed in NRMS; unknown keys are not found", async () => {
    await expect(setListEnabled(tdb.db, "media-distribution-lists:budget", false, "J")).rejects.toBeInstanceOf(ManagedInNrmsError);
    await expect(setCategoryEnabled(tdb.db, "media-distribution-lists", false, "J")).rejects.toBeInstanceOf(ManagedInNrmsError);
    await expect(reorderLists(tdb.db, "media-distribution-lists", ["media-distribution-lists:budget"], "J")).rejects.toBeInstanceOf(ManagedInNrmsError);
    await expect(setListEnabled(tdb.db, "ministries:nope", false, "J")).rejects.toBeInstanceOf(ListNotFoundError);
    await expect(setCategoryEnabled(tdb.db, "nope", false, "J")).rejects.toBeInstanceOf(ListNotFoundError);
  });

  it("disabling a category hides its lists from the public and records who did it", async () => {
    expect(await setCategoryEnabled(tdb.db, "ministries", false, "Jamie")).toEqual({ changed: true });
    expect(await publicListItems(tdb.db, "ministries")).toEqual([]);
    expect((await tdb.db.select().from(operationsLog)).map((l) => [l.action, l.detail])).toEqual([["category-disabled", "ministries"]]);
  });
});
```

`apps/nod/src/http/staff-list-routes.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../../test/helpers";
import { staffAuth } from "../../test/staff-auth";
import { createApp } from "../app";

describe("staff list routes", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let viewer: string, editor: string, admin: string;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    const { auth, token } = await staffAuth();
    viewer = await token(["NoD.Viewer"]);
    editor = await token(["NoD.Editor"]);
    admin = await token(["NoD.Admin"], "Avery Admin");
    app = createApp({ db: tdb.db, auth, eventSecrets: { nrms: "nrms-secret", core: "core-secret" }, render: { siteUrl: "https://news.gov.bc.ca", bannerUrl: null } });
    await tdb.db.execute(sql`
      INSERT INTO lists (list_key, category, key, name) VALUES ('ministries:health','ministries','health','Health'),
        ('media-distribution-lists:budget','media-distribution-lists','budget','Budget')`);
  });
  afterAll(async () => tdb.drop());

  const put = (tok: string, p: string, body: object) => request(app).put(p).set("authorization", `Bearer ${tok}`).send(body);

  it("NoD Viewers read the view; only Admins change it", async () => {
    const view = await request(app).get("/api/list-categories").set("authorization", `Bearer ${viewer}`);
    expect(view.status).toBe(200);
    expect(view.body.categories.find((c: { key: string }) => c.key === "ministries").lists[0]).toMatchObject({ listKey: "ministries:health", enabled: true, subscribers: 0 });
    expect((await put(viewer, "/api/lists/ministries:health", { enabled: false })).status).toBe(403);
    expect((await put(editor, "/api/lists/ministries:health", { enabled: false })).status).toBe(403);
    const ok = await put(admin, "/api/lists/ministries%3Ahealth", { enabled: false });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ changed: true });
  });

  it("maps errors: 400 bad body, 404 unknown, 409 media and stale order", async () => {
    expect((await put(admin, "/api/lists/ministries:health", { enabled: "no" })).status).toBe(400);
    expect((await put(admin, "/api/lists/ministries:nope", { enabled: true })).status).toBe(404);
    expect((await put(admin, "/api/list-categories/nope", { enabled: true })).status).toBe(404);
    const media = await put(admin, "/api/lists/media-distribution-lists:budget", { enabled: false });
    expect([media.status, media.body]).toEqual([409, { error: "managed-in-nrms" }]);
    const stale = await put(admin, "/api/list-categories/order", { keys: ["ministries"] });
    expect([stale.status, stale.body]).toEqual([409, { error: "order-out-of-date" }]);
    const listOrder = await put(admin, "/api/list-categories/ministries/list-order", { listKeys: ["ministries:health"] });
    expect([listOrder.status, listOrder.body]).toEqual([200, { ok: true }]);
  });
});
```

- [ ] **Step 2: Run them; expect FAIL**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/staff-lists.test.ts apps/nod/src/http/staff-list-routes.test.ts`

Expected: the imports from `./staff-lists` fail, the `lists.enabled` column is missing, and the routes are 404.

- [ ] **Step 3: Schema and migration**

`apps/nod/src/db/schema.ts`, in `lists` after `topicUrl`:

```ts
    // Staff's own switch (spec §8), separate from `active`, which Core/NRMS own and every
    // upsert overwrites. Off = not offered for new subscriptions; existing subscriptions are
    // kept and still sent.
    enabled: boolean("enabled").notNull().default(true),
    // Staff's order within the category. Null = after every staff-ordered list, by the source's
    // own sort_order: a list Core adds later appears at the end until staff place it.
    staffSortOrder: integer("staff_sort_order"),
```

Generate: `… generate --name list_staff_fields`. Expect two `ADD COLUMN` statements.

- [ ] **Step 4: Offered and ordered everywhere**

`apps/nod/src/lists.ts`:

```ts
/** Display order for lists: staff's own order first (nulls last), then the source's, then name. */
export const LIST_ORDER = [sql`${lists.staffSortOrder} ASC NULLS LAST`, asc(lists.sortOrder), asc(lists.name)];
```

- In `publicListItems`, the `where` gains `eq(lists.enabled, true)`, and `.orderBy(asc(lists.sortOrder), asc(lists.name))` becomes `.orderBy(...LIST_ORDER)`. The doc comment becomes "active, staff-enabled lists of an enabled public category".
- In `activeListKeys`, the `where` gains `eq(lists.enabled, true)`. Update its doc comment the same way.

`apps/nod/src/staff-subscribers/read.ts` `listOptions`:
- the `where` gains `eq(lists.enabled, true)`;
- the order becomes `.orderBy(asc(listCategories.sortOrder), ...LIST_ORDER)`;
- import `LIST_ORDER` from `../lists`.

- [ ] **Step 5: settings.ts: the shared log writer**

Replace `OperationsAction` and `writeOpsLog`:

```ts
export type OperationsAction =
  | "paused"
  | "resumed"
  | "distribution-paused"
  | "distribution-resumed"
  | "category-enabled"
  | "category-disabled"
  | "categories-reordered"
  | "lists-reordered"
  | "list-enabled"
  | "list-disabled"
  | "bounce-summary-address-changed";

/** Writes one `operations_log` row. `detail` names what changed (a list or category key) and
 * never holds an email address: the log is staff-visible and kept indefinitely. */
export async function writeOpsLog(dbOrTx: DbOrTx, actor: string, action: OperationsAction, detail = ""): Promise<{ id: string; at: Date }> {
  const [log] = await dbOrTx.insert(operationsLog).values({ actor, action, detail }).returning({ id: operationsLog.id, at: operationsLog.at });
  return log!;
}
```

- [ ] **Step 6: staff-lists.ts**

```ts
/**
 * Lists & categories for the staff section (spec §8). Core and NRMS own list names, `active` and
 * their own sort order; staff own whether a list or category is offered and the order staff and
 * the public see. Media lists are NRMS's entirely (legacy refused to edit them in NoD too).
 */
import { asc, eq, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "@gcpe/db-kit";
import { listCategories, lists } from "./db/schema";
import { LIST_ORDER, MEDIA_CATEGORY } from "./lists";
import { writeOpsLog } from "./settings";

export type NamesFrom = "Core" | "NRMS" | "NoD";
const NAMES_FROM: Record<string, NamesFrom> = { ministries: "Core", sectors: "Core", themes: "Core", tags: "Core", [MEDIA_CATEGORY]: "NRMS" };

export interface StaffList {
  listKey: string;
  key: string;
  name: string;
  /** The source's own state (Core/NRMS); a retired list stays visible here. */
  active: boolean;
  /** Staff's switch: offered for new subscriptions. */
  enabled: boolean;
  /** Active subscribers holding this list. */
  subscribers: number;
}

export interface StaffCategory {
  key: string;
  name: string;
  enabled: boolean;
  namesFrom: NamesFrom;
  /** False for media lists: names, order and state are changed in NRMS. */
  editable: boolean;
  lists: StaffList[];
}

export interface StaffListsView {
  /** Active subscribers on "All news" (`*`). */
  allNews: number;
  categories: StaffCategory[];
}

export class ListNotFoundError extends Error {
  constructor() {
    super("not found");
    this.name = "ListNotFoundError";
  }
}
export class ManagedInNrmsError extends Error {
  constructor() {
    super("managed-in-nrms");
    this.name = "ManagedInNrmsError";
  }
}
/** The order sent isn't exactly the current set: a list arrived or left since the screen loaded. */
export class OrderOutOfDateError extends Error {
  constructor() {
    super("order-out-of-date");
    this.name = "OrderOutOfDateError";
  }
}

export async function staffListsView(db: DbOrTx): Promise<StaffListsView> {
  const cats = await db.select().from(listCategories).orderBy(asc(listCategories.sortOrder), asc(listCategories.name));
  const rows = await db
    .select({ listKey: lists.listKey, category: lists.category, key: lists.key, name: lists.name, active: lists.active, enabled: lists.enabled })
    .from(lists)
    .orderBy(...LIST_ORDER);
  // One pass over subscriptions (bounded by subscriber count, never deliveries).
  const { rows: counts } = await db.execute<{ list_key: string; n: number }>(sql`
    SELECT sub.list_key, count(*)::int AS n
      FROM subscriptions sub
      JOIN subscribers s ON s.id = sub.subscriber_id
     WHERE s.status = 'active'
     GROUP BY sub.list_key`);
  const count = new Map(counts.map((c) => [c.list_key, c.n]));
  return {
    allNews: count.get("*") ?? 0,
    categories: cats.map((c) => ({
      key: c.key,
      name: c.name,
      enabled: c.enabled,
      namesFrom: NAMES_FROM[c.key] ?? "NoD",
      editable: c.key !== MEDIA_CATEGORY,
      lists: rows
        .filter((l) => l.category === c.key)
        .map((l) => ({ listKey: l.listKey, key: l.key, name: l.name, active: l.active, enabled: l.enabled, subscribers: count.get(l.listKey) ?? 0 })),
    })),
  };
}

function isPermutation(have: string[], want: string[]): boolean {
  return have.length === want.length && new Set(want).size === want.length && want.every((k) => have.includes(k));
}

export async function setCategoryEnabled(db: Db, key: string, enabled: boolean, actor: string): Promise<{ changed: boolean }> {
  if (key === MEDIA_CATEGORY) throw new ManagedInNrmsError();
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ enabled: listCategories.enabled }).from(listCategories).where(eq(listCategories.key, key)).for("update");
    if (!row) throw new ListNotFoundError();
    if (row.enabled === enabled) return { changed: false };
    await tx.update(listCategories).set({ enabled }).where(eq(listCategories.key, key));
    await writeOpsLog(tx, actor, enabled ? "category-enabled" : "category-disabled", key);
    return { changed: true };
  });
}

export async function setListEnabled(db: Db, listKey: string, enabled: boolean, actor: string): Promise<{ changed: boolean }> {
  const key = listKey.toLowerCase();
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ category: lists.category, enabled: lists.enabled }).from(lists).where(eq(lists.listKey, key)).for("update");
    if (!row) throw new ListNotFoundError();
    if (row.category === MEDIA_CATEGORY) throw new ManagedInNrmsError();
    if (row.enabled === enabled) return { changed: false };
    await tx.update(lists).set({ enabled }).where(eq(lists.listKey, key));
    await writeOpsLog(tx, actor, enabled ? "list-enabled" : "list-disabled", key);
    return { changed: true };
  });
}

/** Category order: the staff screens and the preferences form. The public Subscribe API asks
 * per category, so this doesn't change the public page. */
export async function reorderCategories(db: Db, keys: string[], actor: string): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx.select({ key: listCategories.key }).from(listCategories).for("update");
    if (!isPermutation(rows.map((r) => r.key), keys)) throw new OrderOutOfDateError();
    for (const [i, key] of keys.entries()) await tx.update(listCategories).set({ sortOrder: i + 1 }).where(eq(listCategories.key, key));
    await writeOpsLog(tx, actor, "categories-reordered");
  });
}

/** List order within one category, every list included (retired ones too, so their slot is
 * kept if Core brings them back). This order is what the public subscribe page shows. */
export async function reorderLists(db: Db, category: string, listKeys: string[], actor: string): Promise<void> {
  if (category === MEDIA_CATEGORY) throw new ManagedInNrmsError();
  const wanted = listKeys.map((k) => k.toLowerCase());
  await db.transaction(async (tx) => {
    const [cat] = await tx.select({ key: listCategories.key }).from(listCategories).where(eq(listCategories.key, category));
    if (!cat) throw new ListNotFoundError();
    const rows = await tx.select({ listKey: lists.listKey }).from(lists).where(eq(lists.category, category)).for("update");
    if (!isPermutation(rows.map((r) => r.listKey), wanted)) throw new OrderOutOfDateError();
    for (const [i, listKey] of wanted.entries()) await tx.update(lists).set({ staffSortOrder: i + 1 }).where(eq(lists.listKey, listKey));
    await writeOpsLog(tx, actor, "lists-reordered", category);
  });
}
```

- [ ] **Step 7: staff-list-routes.ts and mount**

```ts
import { Router, type Response } from "express";
import { z, ZodError } from "zod";
import type { Db } from "@gcpe/db-kit";
import { actorOf, requireAnyRole } from "@gcpe/auth";
import { ListNotFoundError, ManagedInNrmsError, OrderOutOfDateError, reorderCategories, reorderLists, setCategoryEnabled, setListEnabled, staffListsView } from "../staff-lists";
import { privateErrorsWith } from "./private-errors";
import { NOD_READ_ROLES } from "./staff-subscriber-routes";

/** Spec §8: NoD.Admin alone changes categories and lists (and runs Operations). */
export const NOD_ADMIN_ROLES = ["NoD.Admin"] as const;

const enabledBody = z.object({ enabled: z.boolean() });
const categoryOrderBody = z.object({ keys: z.array(z.string().min(1).max(100)).min(1).max(50) });
const listOrderBody = z.object({ listKeys: z.array(z.string().min(1).max(300)).min(1).max(2000) });

function mapError(e: unknown, res: Response): boolean {
  if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues }), true;
  if (e instanceof ListNotFoundError) return void res.status(404).json({ error: "not found" }), true;
  if (e instanceof ManagedInNrmsError) return void res.status(409).json({ error: "managed-in-nrms" }), true;
  if (e instanceof OrderOutOfDateError) return void res.status(409).json({ error: "order-out-of-date" }), true;
  return false;
}
const privateErrors = privateErrorsWith(mapError, "staff list request");

export function staffListRoutes(db: Db): Router {
  const r = Router();
  const read = requireAnyRole(...NOD_READ_ROLES);
  const admin = requireAnyRole(...NOD_ADMIN_ROLES);

  r.get("/list-categories", read, privateErrors(async (_req, res) => {
    res.json(await staffListsView(db));
  }));

  // Registered ahead of "/list-categories/:key", so "order" is never taken for a category key.
  r.put("/list-categories/order", admin, privateErrors(async (req, res) => {
    await reorderCategories(db, categoryOrderBody.parse(req.body).keys, actorOf(req).name);
    res.json({ ok: true });
  }));

  r.put("/list-categories/:key/list-order", admin, privateErrors<{ key: string }>(async (req, res) => {
    await reorderLists(db, req.params.key, listOrderBody.parse(req.body).listKeys, actorOf(req).name);
    res.json({ ok: true });
  }));

  r.put("/list-categories/:key", admin, privateErrors<{ key: string }>(async (req, res) => {
    res.json(await setCategoryEnabled(db, req.params.key, enabledBody.parse(req.body).enabled, actorOf(req).name));
  }));

  r.put("/lists/:listKey", admin, privateErrors<{ listKey: string }>(async (req, res) => {
    res.json(await setListEnabled(db, req.params.listKey, enabledBody.parse(req.body).enabled, actorOf(req).name));
  }));

  return r;
}
```

`apps/nod/src/http/routes.ts`: add `r.use(staffListRoutes(db));` next to the other `r.use` calls.

- [ ] **Step 8: Run; expect PASS**

Run the Step 2 command plus `apps/nod`. Expect all green, including `lists.test.ts`, `read.test.ts` and `actions.test.ts`, unchanged.

- [ ] **Step 9: Type-check, then commit**

```bash
git add apps/nod
git commit -m "feat(nod): lists & categories — staff enable/disable and order that survive Core/NRMS events, with live counts"
```

---

### Task 3: NoD operations API (status, bounce summary address)

**Files:**
- Create:
  - `apps/nod/src/operations.ts` (+ `operations.test.ts`);
  - `apps/nod/src/http/operations-routes.ts` (+ `operations-routes.test.ts`).
- Modify:
  - `apps/nod/src/db/schema.ts` (`nodSettings`) + generated migration `0022_bounce_summary_email`;
  - `apps/nod/src/settings.ts`;
  - `apps/nod/src/bounce-summary.ts` (+ test);
  - `apps/nod/src/distribution-client.ts`;
  - `apps/nod/src/app.ts`, `apps/nod/src/start.ts`, `apps/nod/src/http/routes.ts`.

**Interfaces:**
- Consumes: `writeOpsLog`, `NOD_ADMIN_ROLES`, `privateErrorsWith`; `getSettings` (settings.ts).
- Produces:
  - `nod_settings.bounce_summary_email` (text, nullable).
  - `DistributionClient.bounceSource(): Promise<{ source: "fake" | "graph" }>`.
  - From `settings.ts`:
    - `BounceSummaryAddress { address: string | null; from: "setting" | "server" | null }`;
    - `resolveBounceSummaryAddress(db, fallback: string | null)`;
    - `setBounceSummaryAddress(db, address: string | null, actor): Promise<{ changed: boolean }>`.
  - `OperationsStatus { nod: { paused; lastDigestCutoff }; distribution: { paused: boolean } | null; bounceSource: "fake" | "graph" | null; bounceSummary: BounceSummaryAddress }` and `getOperations(db, distribution, fallback)`.
  - `AppDeps.bounceSummaryFallback?: string | null`, and `SettingsRouteDeps.bounceSummaryFallback: string | null`.
  - `runBounceSummaryIfDue(db, distribution, timeZone, fallbackTo, now?)`: the 4th argument is now the default, used only when no address is stored.
  - **Routes (`NoD.Admin`):**
    - `GET /operations` → `OperationsStatus`;
    - `PUT /operations/bounce-summary-address` `{ address: string | null }` → `{ changed, bounceSummary }`. An empty string means null.

- [ ] **Step 1: Write the failing tests**

`apps/nod/src/operations.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../test/helpers";
import { nodSettings, operationsLog } from "./db/schema";
import type { DistributionClient } from "./distribution-client";
import { getOperations } from "./operations";
import { resolveBounceSummaryAddress, setBounceSummaryAddress } from "./settings";

describe("operations", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNodTestDb();
  });
  afterAll(async () => tdb.drop());
  beforeEach(async () => {
    await tdb.db.update(nodSettings).set({ bounceSummaryEmail: null, paused: false }).where(eq(nodSettings.id, 1));
    await tdb.db.delete(operationsLog);
  });

  it("the summary address: stored setting first, then the server default, else none", async () => {
    expect(await resolveBounceSummaryAddress(tdb.db, null)).toEqual({ address: null, from: null });
    expect(await resolveBounceSummaryAddress(tdb.db, "server@example.test")).toEqual({ address: "server@example.test", from: "server" });
    expect(await setBounceSummaryAddress(tdb.db, "staff@example.test", "Avery")).toEqual({ changed: true });
    expect(await resolveBounceSummaryAddress(tdb.db, "server@example.test")).toEqual({ address: "staff@example.test", from: "setting" });
    expect(await setBounceSummaryAddress(tdb.db, "staff@example.test", "Avery")).toEqual({ changed: false });
    expect(await setBounceSummaryAddress(tdb.db, null, "Avery")).toEqual({ changed: true });
    expect(await resolveBounceSummaryAddress(tdb.db, "server@example.test")).toEqual({ address: "server@example.test", from: "server" });
    const log = await tdb.db.select().from(operationsLog);
    expect(log.map((l) => [l.action, l.detail])).toEqual([["bounce-summary-address-changed", "set"], ["bounce-summary-address-changed", "cleared"]]);
    expect(JSON.stringify(log)).not.toContain("@");
  });

  it("Distribution down: NoD's own state still comes back; Distribution's is null; nothing logs an address", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const distribution = {
      getSettings: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED ops@example.test")),
      bounceSource: vi.fn().mockRejectedValue(new Error("timeout")),
    } as unknown as Pick<DistributionClient, "getSettings" | "bounceSource">;
    const ops = await getOperations(tdb.db, distribution, "server@example.test");
    expect(ops).toEqual({
      nod: { paused: false, lastDigestCutoff: null },
      distribution: null,
      bounceSource: null,
      bounceSummary: { address: "server@example.test", from: "server" },
    });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("@");
    spy.mockRestore();
  });

  it("Distribution up: its pause state and bounce source", async () => {
    const distribution = {
      getSettings: vi.fn().mockResolvedValue({ paused: true }),
      bounceSource: vi.fn().mockResolvedValue({ source: "fake" }),
    } as unknown as Pick<DistributionClient, "getSettings" | "bounceSource">;
    expect(await getOperations(tdb.db, distribution, null)).toMatchObject({ distribution: { paused: true }, bounceSource: "fake" });
  });
});
```

`apps/nod/src/http/operations-routes.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../../test/helpers";
import { staffAuth } from "../../test/staff-auth";
import { createApp } from "../app";
import type { DistributionClient } from "../distribution-client";

describe("operations routes", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let admin: string, editor: string;
  const distribution = {
    send: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({ paused: false }),
    setPaused: vi.fn(),
    uploadBounce: vi.fn(),
    bounceStats: vi.fn(),
    bounceSource: vi.fn().mockResolvedValue({ source: "fake" }),
  } as unknown as DistributionClient;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    const { auth, token } = await staffAuth();
    admin = await token(["NoD.Admin"], "Avery Admin");
    editor = await token(["NoD.Editor"]);
    app = createApp({
      db: tdb.db,
      auth,
      eventSecrets: { nrms: "nrms-secret", core: "core-secret" },
      render: { siteUrl: "https://news.gov.bc.ca", bannerUrl: null },
      distribution,
      bounceSummaryFallback: "server@example.test",
    });
  });
  afterAll(async () => tdb.drop());

  it("Admin only", async () => {
    expect((await request(app).get("/api/operations").set("authorization", `Bearer ${editor}`)).status).toBe(403);
    expect((await request(app).put("/api/operations/bounce-summary-address").set("authorization", `Bearer ${editor}`).send({ address: null })).status).toBe(403);
  });

  it("reads the whole status", async () => {
    const res = await request(app).get("/api/operations").set("authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      nod: { paused: false, lastDigestCutoff: null },
      distribution: { paused: false },
      bounceSource: "fake",
      bounceSummary: { address: "server@example.test", from: "server" },
    });
  });

  it("sets, validates and clears the summary address; an empty string clears it", async () => {
    const put = (body: object) => request(app).put("/api/operations/bounce-summary-address").set("authorization", `Bearer ${admin}`).send(body);
    expect((await put({ address: "not an email" })).status).toBe(400);
    const set = await put({ address: " Summary@Example.test " });
    expect(set.body).toEqual({ changed: true, bounceSummary: { address: "Summary@Example.test", from: "setting" } });
    const cleared = await put({ address: "" });
    expect(cleared.body).toEqual({ changed: true, bounceSummary: { address: "server@example.test", from: "server" } });
  });
});
```

Add to `apps/nod/src/bounce-summary.test.ts`. The `beforeEach` `nodSettings` update also sets `bounceSummaryEmail: null`, and `MessageRequest` is already imported.

```ts
  it("sends to the staff-set address ahead of the server default", async () => {
    await tdb.db.update(nodSettings).set({ bounceSummaryEmail: "summary-staff@example.test" }).where(eq(nodSettings.id, 1));
    const distribution = stubDistribution();
    distribution.bounceStats.mockResolvedValue({ unmatched: 1, ignored: 0 });
    const result = await runBounceSummaryIfDue(tdb.db, distribution, TZ, "server-default@example.test", () => DAY1_0805);
    expect(result.sent).toBe(true);
    expect((distribution.send.mock.calls[0]![0] as MessageRequest).recipients).toEqual([{ email: "summary-staff@example.test", substitutions: {} }]);
  });

  it("a staff-set address sends even with no server default", async () => {
    await tdb.db.update(nodSettings).set({ bounceSummaryEmail: "summary-staff@example.test" }).where(eq(nodSettings.id, 1));
    const distribution = stubDistribution();
    distribution.bounceStats.mockResolvedValue({ unmatched: 1, ignored: 0 });
    expect((await runBounceSummaryIfDue(tdb.db, distribution, TZ, null, () => DAY1_0805)).sent).toBe(true);
  });
```

- [ ] **Step 2: Run them; expect FAIL**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/operations.test.ts apps/nod/src/http/operations-routes.test.ts apps/nod/src/bounce-summary.test.ts`

Expected: the `bounceSummaryEmail` column is missing, the imports fail, the routes are 404, and the summary goes to the default address.

- [ ] **Step 3: Schema and migration**

`nodSettings`, before `updatedAt`:

```ts
    // The daily bounce summary's recipient, set by staff on Operations (spec §8). Null = use
    // NOD_BOUNCE_SUMMARY_EMAIL, the server default.
    bounceSummaryEmail: text("bounce_summary_email"),
```

Generate: `… generate --name bounce_summary_email`.

- [ ] **Step 4: settings.ts address functions**

```ts
export interface BounceSummaryAddress {
  address: string | null;
  /** "setting": staff chose it; "server": NOD_BOUNCE_SUMMARY_EMAIL; null: none, nothing is sent. */
  from: "setting" | "server" | null;
}

export async function resolveBounceSummaryAddress(db: DbOrTx, fallback: string | null): Promise<BounceSummaryAddress> {
  const [row] = await db.select({ stored: nodSettings.bounceSummaryEmail }).from(nodSettings).where(eq(nodSettings.id, 1));
  if (row?.stored) return { address: row.stored, from: "setting" };
  if (fallback) return { address: fallback, from: "server" };
  return { address: null, from: null };
}

/** Sets (or, with null, clears back to the server default) the summary address. The log
 * records that it changed, never the address. */
export async function setBounceSummaryAddress(db: Db, address: string | null, actor: string): Promise<{ changed: boolean }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(nodSettings)
      .set({ bounceSummaryEmail: address, updatedAt: sql`now()` })
      .where(and(eq(nodSettings.id, 1), sql`${nodSettings.bounceSummaryEmail} IS DISTINCT FROM ${address}`))
      .returning({ id: nodSettings.id });
    if (!row) return { changed: false };
    await writeOpsLog(tx, actor, "bounce-summary-address-changed", address === null ? "cleared" : "set");
    return { changed: true };
  });
}
```

- [ ] **Step 5: Distribution client `bounceSource`**

`apps/nod/src/distribution-client.ts`:
- next to the other schemas (:94-98), add:
  `const bounceSourceResponseSchema = z.object({ source: z.enum(["fake", "graph"]) });`
- in `interface DistributionClient`, add:
  `/** Distribution's bounce source (GET /api/bounces/source, Distribution.Operate): "fake" only where the test-site upload works. */ bounceSource(): Promise<{ source: "fake" | "graph" }>;`
- in `distributionClient`'s returned object, add:

```ts
    async bounceSource(): Promise<{ source: "fake" | "graph" }> {
      return callDistribution(opts, doFetch, timeoutMs, "/api/bounces/source", { method: "GET" }, bounceSourceResponseSchema, "Distribution response missing source");
    },
```

- [ ] **Step 6: operations.ts, the route, and wiring**

`apps/nod/src/operations.ts`:

```ts
import type { Db } from "@gcpe/db-kit";
import type { DistributionClient } from "./distribution-client";
import { getSettings, resolveBounceSummaryAddress, type BounceSummaryAddress } from "./settings";
import { safeErrorLabel } from "./subscribe/journeys";

/** Everything the staff Operations screen shows (spec §8), in one read. */
export interface OperationsStatus {
  nod: { paused: boolean; lastDigestCutoff: string | null };
  /** Null when Distribution didn't answer: the screen says so, and NoD's own controls still work. */
  distribution: { paused: boolean } | null;
  bounceSource: "fake" | "graph" | null;
  bounceSummary: BounceSummaryAddress;
}

export async function getOperations(
  db: Db,
  distribution: Pick<DistributionClient, "getSettings" | "bounceSource">,
  bounceSummaryFallback: string | null,
): Promise<OperationsStatus> {
  const [nod, bounceSummary, dist, bounceSource] = await Promise.all([
    getSettings(db),
    resolveBounceSummaryAddress(db, bounceSummaryFallback),
    distribution.getSettings().then(
      (s) => ({ paused: s.paused }),
      (e: unknown) => {
        console.error("[nod] operations: Distribution settings unavailable", safeErrorLabel(e));
        return null;
      },
    ),
    distribution.bounceSource().then(
      (s) => s.source,
      (e: unknown) => {
        console.error("[nod] operations: bounce source unavailable", safeErrorLabel(e));
        return null;
      },
    ),
  ]);
  return { nod, distribution: dist, bounceSource, bounceSummary };
}
```

`apps/nod/src/http/operations-routes.ts`:

```ts
import { Router, type Response } from "express";
import { z, ZodError } from "zod";
import type { Db } from "@gcpe/db-kit";
import { actorOf, requireAnyRole } from "@gcpe/auth";
import { getOperations } from "../operations";
import { resolveBounceSummaryAddress, setBounceSummaryAddress } from "../settings";
import { privateErrorsWith } from "./private-errors";
import type { SettingsRouteDeps } from "./routes";
import { NOD_ADMIN_ROLES } from "./staff-list-routes";

const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const addressBody = z.object({ address: z.preprocess(blankToNull, z.union([z.string().trim().email().max(254), z.null()])) });

function mapError(e: unknown, res: Response): boolean {
  if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues }), true;
  return false;
}
/** The summary address is bound in these queries (see private-errors.ts). */
const privateErrors = privateErrorsWith(mapError, "operations request");

/** Spec §8 Operations, NoD.Admin only. Pause/resume keep their existing routes
 * (/settings/*, /distribution/*); this adds the combined read and the summary address. */
export function operationsRoutes(db: Db, deps: SettingsRouteDeps): Router {
  const r = Router();
  const admin = requireAnyRole(...NOD_ADMIN_ROLES);

  r.get("/operations", admin, privateErrors(async (_req, res) => {
    res.json(await getOperations(db, deps.distribution, deps.bounceSummaryFallback));
  }));

  r.put("/operations/bounce-summary-address", admin, privateErrors(async (req, res) => {
    const { address } = addressBody.parse(req.body);
    const { changed } = await setBounceSummaryAddress(db, address, actorOf(req).name);
    res.json({ changed, bounceSummary: await resolveBounceSummaryAddress(db, deps.bounceSummaryFallback) });
  }));

  return r;
}
```

`apps/nod/src/http/routes.ts`:
- `SettingsRouteDeps.distribution` becomes `Pick<DistributionClient, "send" | "getSettings" | "setPaused" | "bounceSource">`;
- add `bounceSummaryFallback: string | null;` with the doc "NOD_BOUNCE_SUMMARY_EMAIL, used when staff haven't set an address";
- add `r.use(operationsRoutes(db, settings));`.

`apps/nod/src/app.ts`:
- `AppDeps.distribution`'s Pick adds `"bounceSource"`;
- `noDistribution` adds `bounceSource: () => Promise.reject(new Error("createApp: no Distribution client configured for the operations route"))`;
- `AppDeps` adds `bounceSummaryFallback?: string | null;` with the doc "NOD_BOUNCE_SUMMARY_EMAIL; null = none";
- the settings deps object passed to `apiRoutes` adds `bounceSummaryFallback: deps.bounceSummaryFallback ?? null`.

`apps/nod/src/start.ts`:
- `createApp({ … })` adds `bounceSummaryFallback: parsed.BOUNCE_SUMMARY_EMAIL ?? null`;
- rename the local `bounceSummaryEmail` to `bounceSummaryFallback` and fix its comment: "The server default; a staff-set address on Operations wins (resolveBounceSummaryAddress)";
- update the `bounceSummary` worker comment the same way.

`apps/nod/src/bounce-summary.ts` `runBounceSummaryIfDue`:
- rename the 4th parameter to `fallbackTo`;
- replace the first line `if (!to) return …` with:

```ts
  const { address: to } = await resolveBounceSummaryAddress(db, fallbackTo);
  if (!to) return { sent: false, lines: 0 };
```

- import `resolveBounceSummaryAddress` from `./settings`;
- update the doc comment: "the recipient is the staff-set address, else `fallbackTo` (NOD_BOUNCE_SUMMARY_EMAIL), else nothing is sent";
- `startBounceSummaryLoop`'s `to` option keeps its name, documented as the fallback.

- [ ] **Step 7: Run; expect PASS**

Run the Step 2 command, then all of `apps/nod`. The existing `routes.test.ts` distribution stubs are cast `as unknown as DistributionClient` and don't need `bounceSource`.

- [ ] **Step 8: Type-check, then commit**

```bash
git add apps/nod
git commit -m "feat(nod): operations read and staff-set bounce summary address (server default as fallback)"
```

---

### Task 4: staff-web: section nav, shared types, and the Lists and categories screen

**Files:**
- Create:
  - `apps/staff-web/src/screens/subscribers/ListsScreen.tsx` (+ `ListsScreen.test.tsx`);
  - `apps/staff-web/src/screens/subscribers/SubscribersSection.test.tsx`.
- Modify:
  - `apps/staff-web/src/screens/subscribers/access.ts`, `types.ts`, `labels.ts`, `SubscribersSection.tsx`;
  - `apps/staff-web/src/router.tsx`.

**Interfaces:**
- Consumes: `GET /nod/api/list-categories`, `PUT /nod/api/lists/:listKey`, `PUT /nod/api/list-categories/:key`, `PUT /nod/api/list-categories/order`, `PUT /nod/api/list-categories/:key/list-order` (Task 2).
- Produces:
  - `canAdminSubscribers(s): boolean` (access.ts).
  - In `types.ts`:
    - `StaffList`, `StaffCategory`, `StaffListsView` (mirroring Task 2);
    - `MediaListSummary`, `MediaMember`, `MediaOptOut`, `MediaOptOutPage`, `MediaHubEmail`, `MediaHubContact`, `MediaHubContactPage`, `AddMemberBody`, `SyncResultView`, `SyncStatus`, `OperationsStatus` (used by Tasks 5 and 6).
  - In `labels.ts`: `attentionLabel`, `memberSourceLabel`, `describeSync`, `mediaErrorText`.
  - Routes `/subscribers/lists`, `/subscribers/media-lists`, `/subscribers/media-lists/:key`, `/subscribers/operations`. Tasks 5 and 6 fill in the last three; this task registers them with placeholder `null` elements, so the nav works.

- [ ] **Step 1: Write the failing tests**

`apps/staff-web/src/screens/subscribers/ListsScreen.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { ListsScreen } from "./ListsScreen";
import type { StaffListsView } from "./types";

const VIEW: StaffListsView = {
  allNews: 12,
  categories: [
    {
      key: "ministries", name: "Ministries", enabled: true, namesFrom: "Core", editable: true,
      lists: [
        { listKey: "ministries:health", key: "health", name: "Health", active: true, enabled: true, subscribers: 40 },
        { listKey: "ministries:energy", key: "energy", name: "Energy", active: true, enabled: false, subscribers: 3 },
        { listKey: "ministries:old", key: "old", name: "Old ministry", active: false, enabled: true, subscribers: 0 },
      ],
    },
    { key: "media-distribution-lists", name: "Media distribution lists", enabled: true, namesFrom: "NRMS", editable: false, lists: [{ listKey: "media-distribution-lists:budget", key: "budget", name: "Budget", active: true, enabled: true, subscribers: 9 }] },
  ],
};

type Call = { url: string; method: string; body: unknown };
function stub(roles: string[], onPut?: (url: string) => Response | undefined) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
    if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
    if (url === "/nod/api/list-categories") return jsonResponse(200, VIEW);
    if (init?.method === "PUT") return onPut?.(url) ?? jsonResponse(200, { changed: true });
    throw new Error(`unhandled: ${url}`);
  }));
  return calls;
}

function renderIt() {
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/subscribers/lists"]}>
        <RequireAuth>
          <Routes>
            <Route path="/subscribers/lists" element={<ListsScreen />} />
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe("ListsScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("shows counts, where names come from, retired and not-offered lists; a Viewer gets no controls", async () => {
    stub(["NoD.Viewer"]);
    renderIt();
    expect(await screen.findByText("All news: 12 active subscribers.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Ministries" })).toBeInTheDocument();
    expect(screen.getByText("Names come from Core.")).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Health 40 Yes/ })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Energy 3 No/ })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Old ministry \(retired in Core\)/ })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Move/ })).toBeNull();
    await waitFor(() => expect(document.title).toBe("Lists and categories — GCPE News Staff"));
  });

  it("an Admin stops offering a list and moves one up; media lists have no controls", async () => {
    const calls = stub(["NoD.Admin"]);
    renderIt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: "Offer Health" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Health is no longer offered.");
    expect(calls).toContainEqual({ url: "/nod/api/lists/ministries%3Ahealth", method: "PUT", body: { enabled: false } });
    await user.click(screen.getByRole("button", { name: "Move Energy up" }));
    await waitFor(() =>
      expect(calls).toContainEqual({ url: "/nod/api/list-categories/ministries/list-order", method: "PUT", body: { listKeys: ["ministries:energy", "ministries:health", "ministries:old"] } }),
    );
    expect(screen.queryByRole("checkbox", { name: "Offer Budget" })).toBeNull();
    // getByText matches an element's own text nodes only, so the sentence around the link is
    // checked through the link itself.
    expect(screen.getByRole("link", { name: "Media list names" })).toHaveAttribute("href", "/media-list-names");
  });

  it("a stale order reloads and says so", async () => {
    stub(["NoD.Admin"], (url) => (url.endsWith("/order") ? jsonResponse(409, { error: "order-out-of-date" }) : undefined));
    renderIt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Move Media distribution lists up" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The lists changed while you were looking");
  });
});
```

`apps/staff-web/src/screens/subscribers/SubscribersSection.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { SubscribersSection } from "./SubscribersSection";

function renderAs(roles: string[]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
    return jsonResponse(200, {});
  }));
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/subscribers"]}>
        <RequireAuth>
          <Routes>
            <Route path="/subscribers" element={<SubscribersSection />} />
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
}

const links = async () => within(await screen.findByRole("navigation", { name: "Subscribers sections" })).getAllByRole("link").map((l) => l.textContent);

describe("SubscribersSection nav", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });
  it("Viewer", async () => {
    renderAs(["NoD.Viewer"]);
    expect(await links()).toEqual(["Find subscribers", "Lists and categories", "Media lists"]);
  });
  it("Editor", async () => {
    renderAs(["NoD.Editor"]);
    expect(await links()).toEqual(["Find subscribers", "Add a subscriber", "Lists and categories", "Media lists"]);
  });
  it("Admin", async () => {
    renderAs(["NoD.Admin"]);
    expect(await links()).toEqual(["Find subscribers", "Add a subscriber", "Lists and categories", "Media lists", "Operations"]);
  });
});
```

- [ ] **Step 2: Run them; expect FAIL**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/staff-web/src/screens/subscribers`

Expected: `ListsScreen` doesn't exist, and the nav has only two links.

- [ ] **Step 3: access, types, labels**

`access.ts`, append:

```ts
/** Spec §8: NoD.Admin alone changes lists and categories and uses Operations. */
export function canAdminSubscribers(s: SessionValue): boolean {
  return s.has("NoD.Admin");
}
```

`types.ts`, append:

```ts
/** apps/nod/src/staff-lists.ts */
export interface StaffList {
  listKey: string;
  key: string;
  name: string;
  active: boolean;
  enabled: boolean;
  subscribers: number;
}
export interface StaffCategory {
  key: string;
  name: string;
  enabled: boolean;
  namesFrom: "Core" | "NRMS" | "NoD";
  editable: boolean;
  lists: StaffList[];
}
export interface StaffListsView {
  allNews: number;
  categories: StaffCategory[];
}

/** apps/nod/src/media-members.ts */
export interface MediaListSummary {
  listKey: string;
  key: string;
  name: string;
  active: boolean;
  members: number;
  needsAttention: number;
}
export interface MediaMember {
  subscriberId: string;
  email: string;
  source: string;
  mediaHubContactId: number | null;
  mediaHubEmailRef: string | null;
  needsAttention: string | null;
  attentionAt: string | null;
}
export interface MediaOptOut {
  subscriberId: string;
  email: string;
  at: string;
  member: boolean;
}
export interface MediaOptOutPage {
  items: MediaOptOut[];
  truncated: boolean;
}
export type AddMemberBody = { email: string; confirmOptOut?: boolean } | { mediaHubContactId: number; emailRef: string; confirmOptOut?: boolean };

/** apps/nod/src/media-hub/contract.ts */
export interface MediaHubEmail {
  ref: string;
  address: string;
  kind: "personal" | "workplace";
  organization: string | null;
  preferred: boolean;
}
export interface MediaHubContact {
  id: number;
  firstName: string;
  lastName: string;
  outlet: string | null;
  emails: MediaHubEmail[];
  deletedAt: string | null;
}
export interface MediaHubContactPage {
  contacts: MediaHubContact[];
  page: number;
  pageSize: number;
  total: number;
}

/** apps/nod/src/media-hub/sync.ts StoredSyncResult / getMediaSyncStatus */
export type SyncResultView =
  | { contacts: number; updated: number; flagged: number; removed: number; errors: number; inProgress?: true }
  | { error: string; kind?: string };
export interface SyncStatus {
  since: string | null;
  at: string | null;
  result: SyncResultView | null;
  running: boolean;
}

/** apps/nod/src/operations.ts */
export interface OperationsStatus {
  nod: { paused: boolean; lastDigestCutoff: string | null };
  distribution: { paused: boolean } | null;
  bounceSource: "fake" | "graph" | null;
  bounceSummary: { address: string | null; from: "setting" | "server" | null };
}
```

`labels.ts`, append. Also add `import { ApiError } from "../../api/client";` and `import type { SyncResultView } from "./types";`.

```ts
const ATTENTION_LABELS: Record<string, string> = {
  "email-gone": "Media Hub email removed",
  "email-taken": "Media Hub email belongs to another subscriber",
  "email-invalid": "Media Hub email isn't valid",
  bouncing: "Bouncing",
};
export function attentionLabel(reason: string): string {
  return ATTENTION_LABELS[reason] ?? reason;
}

export function memberSourceLabel(source: string): string {
  if (source === "media-hub") return "Media Hub";
  if (source === "manual-media") return "Added by hand";
  return "Subscriber";
}

export function describeSync(result: SyncResultView | null): string {
  if (!result) return "No sync has run yet.";
  if ("error" in result) return "The last sync stopped with an error. The next run tries again.";
  const text = `${result.contacts} changed contacts: ${result.updated} updated, ${result.flagged} flagged, ${result.removed} removed, ${result.errors} skipped.`;
  return result.inProgress ? `In progress. ${text}` : text;
}

/** What a media-list or Media Hub call's failure means to staff. */
export function mediaErrorText(e: unknown): string {
  if (!(e instanceof ApiError)) return "Something went wrong.";
  if (e.status === 400) return "That isn't a valid email address.";
  if (e.status === 404) return "That contact or email is no longer in Media Hub.";
  if (e.status === 502) return "Media Hub isn't responding. Try again, or add the address by hand.";
  if (e.status === 503) return "Media Hub isn't set up on this site. Add the address by hand instead.";
  return e.message;
}
```

- [ ] **Step 4: ListsScreen**

```tsx
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Button, InlineAlert } from "@bcgov/design-system-react-components";
import { apiFetch, ApiError } from "../../api/client";
import { useSession } from "../../session/SessionContext";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { moveBy } from "../../shared/reorder";
import { canAdminSubscribers } from "./access";
import type { StaffCategory, StaffListsView } from "./types";

function saveErrorText(e: unknown): string {
  if (e instanceof ApiError && e.status === 409 && e.message === "order-out-of-date") return "The lists changed while you were looking. They've been reloaded; try again.";
  if (e instanceof ApiError && e.status === 409 && e.message === "managed-in-nrms") return "Media lists are managed in NRMS.";
  return "Couldn't save. Try again.";
}

/** `/hub/subscribers/lists` (legacy ManageLists/ManageListCategories): every category and list
 * with its active subscriber count. NoD Admins choose what's offered and the order; list names
 * come from Core or NRMS and are read-only. Changes apply at once: they're reversible, and no
 * one's subscription is removed or stops being sent. */
export function ListsScreen(): React.JSX.Element {
  useDocumentTitle("Lists and categories");
  const canAdmin = canAdminSubscribers(useSession());
  const [view, setView] = useState<StaffListsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    apiFetch<StaffListsView>("/nod/api/list-categories").then(
      (v) => {
        setView(v);
        setLoadError(null);
      },
      () => setLoadError("Couldn't load lists."),
    );
  }, []);
  useEffect(() => reload(), [reload]);

  const save = async (path: string, body: unknown, done: string) => {
    setBusy(true);
    setSaveError(null);
    setMessage(null);
    try {
      await apiFetch(path, { method: "PUT", body });
      setMessage(done);
    } catch (e) {
      setSaveError(saveErrorText(e));
    } finally {
      setBusy(false);
      reload();
    }
  };

  const moveCategory = (index: number, delta: 1 | -1) => {
    const keys = moveBy(view!.categories.map((c) => c.key), index, delta);
    const name = view!.categories[index]!.name;
    void save("/nod/api/list-categories/order", { keys }, `${name} moved ${delta < 0 ? "up" : "down"}.`);
  };
  const moveList = (c: StaffCategory, index: number, delta: 1 | -1) => {
    const listKeys = moveBy(c.lists.map((l) => l.listKey), index, delta);
    void save(`/nod/api/list-categories/${encodeURIComponent(c.key)}/list-order`, { listKeys }, `${c.lists[index]!.name} moved ${delta < 0 ? "up" : "down"}.`);
  };

  return (
    <div className="gcpe-subscribers__lists">
      <h1>Lists and categories</h1>
      {loadError && <InlineAlert variant="danger" role="alert" description={loadError} />}
      {saveError && <InlineAlert variant="danger" role="alert" description={saveError} />}
      {message && <p role="status">{message}</p>}
      {view && <p>{`All news: ${view.allNews} active ${view.allNews === 1 ? "subscriber" : "subscribers"}.`}</p>}
      {view?.categories.map((c, ci) => (
        <section key={c.key} aria-labelledby={`category-${c.key}`}>
          <h2 id={`category-${c.key}`}>{c.name}</h2>
          {c.editable ? (
            <p>
              {`Names come from ${c.namesFrom}.`}
              {!c.enabled && " Not offered to subscribers."}
            </p>
          ) : (
            <p>
              Names, order and status come from NRMS (<Link to="/media-list-names">Media list names</Link>).
            </p>
          )}
          {canAdmin && (
            <div className="gcpe-subscribers__lists-controls">
              {c.editable && (
                <label>
                  <input
                    type="checkbox"
                    checked={c.enabled}
                    disabled={busy}
                    onChange={() => void save(`/nod/api/list-categories/${encodeURIComponent(c.key)}`, { enabled: !c.enabled }, `${c.name} ${c.enabled ? "is no longer offered" : "is offered again"}.`)}
                  />{" "}
                  {`Offer ${c.name}`}
                </label>
              )}
              <Button variant="secondary" isDisabled={busy || ci === 0} onPress={() => moveCategory(ci, -1)}>
                {`Move ${c.name} up`}
              </Button>
              <Button variant="secondary" isDisabled={busy || ci === view.categories.length - 1} onPress={() => moveCategory(ci, 1)}>
                {`Move ${c.name} down`}
              </Button>
            </div>
          )}
          {c.lists.length === 0 ? (
            <p>No lists yet.</p>
          ) : (
            <table aria-label={`${c.name} lists`}>
              <thead>
                <tr>
                  <th scope="col">List</th>
                  <th scope="col">Active subscribers</th>
                  <th scope="col">Offered</th>
                  {canAdmin && c.editable && <th scope="col">Order</th>}
                </tr>
              </thead>
              <tbody>
                {c.lists.map((l, li) => (
                  <tr key={l.listKey}>
                    <td>
                      {l.name}
                      {!l.active && ` (retired in ${c.namesFrom})`}
                    </td>
                    <td>{l.subscribers}</td>
                    <td>
                      {canAdmin && c.editable ? (
                        <label>
                          <input
                            type="checkbox"
                            checked={l.enabled}
                            disabled={busy}
                            onChange={() => void save(`/nod/api/lists/${encodeURIComponent(l.listKey)}`, { enabled: !l.enabled }, `${l.name} ${l.enabled ? "is no longer offered" : "is offered again"}.`)}
                          />{" "}
                          {`Offer ${l.name}`}
                        </label>
                      ) : l.enabled ? (
                        "Yes"
                      ) : (
                        "No"
                      )}
                    </td>
                    {canAdmin && c.editable && (
                      <td>
                        <Button variant="secondary" isDisabled={busy || li === 0} onPress={() => moveList(c, li, -1)}>
                          {`Move ${l.name} up`}
                        </Button>
                        <Button variant="secondary" isDisabled={busy || li === c.lists.length - 1} onPress={() => moveList(c, li, 1)}>
                          {`Move ${l.name} down`}
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}
    </div>
  );
}
```

The test's row name `/Health 40 Yes/` is for a Viewer, whose "Offered" cell is the plain text "Yes".

- [ ] **Step 5: Section nav and routes**

`SubscribersSection.tsx`:
- update the doc comment (drop "join this sub-nav later");
- import `canAdminSubscribers`;
- after the "Add a subscriber" item, add:

```tsx
          <li>
            <NavLink to="/subscribers/lists">Lists and categories</NavLink>
          </li>
          <li>
            <NavLink to="/subscribers/media-lists">Media lists</NavLink>
          </li>
          {canAdminSubscribers(session) && (
            <li>
              <NavLink to="/subscribers/operations">Operations</NavLink>
            </li>
          )}
```

`router.tsx`: the `subscribers` children become the list below. Literal segments rank above `:id` in react-router 7, but list them first for readers anyway.

```tsx
        children: [
          { index: true, element: <SubscribersScreen /> },
          { path: "new", element: <AddSubscriberScreen /> },
          { path: "lists", element: <ListsScreen /> },
          { path: "media-lists", element: null },
          { path: "media-lists/:key", element: null },
          { path: "operations", element: null },
          { path: ":id", element: <SubscriberScreen /> },
          { path: ":id/history", element: <HistoryScreen /> },
        ],
```

- [ ] **Step 6: Run; expect PASS. Type-check staff-web; commit**

```bash
git add apps/staff-web
git commit -m "feat(staff-web): Lists and categories screen; Subscribers sub-nav for media lists and operations"
```

---

### Task 5: staff-web Media lists screens

Closes the carry-forward items "NoD media-list member screens" and "A read route/screen listing who opted out of each media list" (screen half).

**Files:**
- Create, under `apps/staff-web/src/screens/subscribers/`:
  - `MediaListsScreen.tsx` (+ `.test.tsx`);
  - `MediaListScreen.tsx` (+ `.test.tsx`);
  - `MediaHubSearch.tsx`;
  - `ResolveDialog.tsx`.
- Modify: `apps/staff-web/src/router.tsx` (replace the two `null` media routes), `apps/staff-web/src/screens/subscribers/a11y.test.tsx`.

**Interfaces:**
- Consumes: the Task 1 routes; the Task 4 types and labels; `Pagination` (`../releases/Pagination`); `formatWhen`, `useTenantTimeZone`.
- Produces: `MediaListsScreen`, `MediaListScreen`, `MediaHubSearch({ onAdd, disabled })`, `ResolveDialog({ member, onClose, onResolved })`.

- [ ] **Step 1: Write the failing tests**

`MediaListsScreen.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { MediaListsScreen } from "./MediaListsScreen";

const LISTS = [
  { listKey: "media-distribution-lists:budget", key: "budget", name: "Budget", active: true, members: 12, needsAttention: 2 },
  { listKey: "media-distribution-lists:old", key: "old", name: "Old list", active: false, members: 0, needsAttention: 0 },
];
const SYNC = { since: null, at: "2026-10-07T09:00:00.000Z", result: { contacts: 5, updated: 1, flagged: 1, removed: 0, errors: 0 }, running: false };

function stub(roles: string[], syncPost: () => Response = () => jsonResponse(200, { done: true, result: { contacts: 1, updated: 0, flagged: 0, removed: 0, errors: 0 } })) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
    if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
    if (url === "/nod/api/media-lists") return jsonResponse(200, LISTS);
    if (url === "/nod/api/media-hub/sync") return init?.method === "POST" ? syncPost() : jsonResponse(200, SYNC);
    throw new Error(`unhandled: ${url}`);
  }));
}
function renderIt() {
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/subscribers/media-lists"]}>
        <RequireAuth>
          <Routes>
            <Route path="/subscribers/media-lists" element={<MediaListsScreen />} />
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe("MediaListsScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("lists media lists with members and attention counts and the last sync; a Viewer can't run it", async () => {
    stub(["NoD.Viewer"]);
    renderIt();
    expect(await screen.findByRole("link", { name: "Budget" })).toHaveAttribute("href", "/subscribers/media-lists/budget");
    expect(screen.getByRole("row", { name: /Budget 12 2 Active/ })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Old list 0 0 Retired/ })).toBeInTheDocument();
    expect(screen.getByText("5 changed contacts: 1 updated, 1 flagged, 0 removed, 0 skipped.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sync with Media Hub now" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Manage media list names" })).toBeNull();
    await waitFor(() => expect(document.title).toBe("Media lists — GCPE News Staff"));
  });

  it("an Editor runs the sync; a sync already running is explained", async () => {
    stub(["NoD.Editor"]);
    renderIt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Sync with Media Hub now" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Sync finished.");
    cleanup();
    vi.unstubAllGlobals();
    stub(["NoD.Editor"], () => jsonResponse(409, { error: "sync in progress" }));
    renderIt();
    await user.click(await screen.findByRole("button", { name: "Sync with Media Hub now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A sync is already running.");
  });

  it("a Core Admin with a NoD role gets the names link", async () => {
    stub(["NoD.Viewer", "Core.Admin"]);
    renderIt();
    expect(await screen.findByRole("link", { name: "Manage media list names" })).toHaveAttribute("href", "/media-list-names");
  });
});
```

`MediaListScreen.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { MediaListScreen } from "./MediaListScreen";
import type { MediaMember } from "./types";

const ID1 = "11111111-1111-1111-1111-111111111111";
const ID2 = "22222222-2222-2222-2222-222222222222";
const MEMBERS: MediaMember[] = [
  { subscriberId: ID1, email: "sam@riverbend.example.test", source: "media-hub", mediaHubContactId: 42, mediaHubEmailRef: "personal", needsAttention: "email-gone", attentionAt: "2026-10-06T09:00:00.000Z" },
  { subscriberId: ID2, email: "lee@example.test", source: "manual-media", mediaHubContactId: null, mediaHubEmailRef: null, needsAttention: "bouncing", attentionAt: "2026-10-06T09:00:00.000Z" },
];
const OPTED = { items: [{ subscriberId: "33333333-3333-3333-3333-333333333333", email: "gone@example.test", at: "2026-09-01T17:00:00.000Z", member: false }], truncated: false };
const CONTACT = {
  id: 42, firstName: "Sam", lastName: "Reporter", outlet: "Riverbend Gazette", deletedAt: null,
  emails: [
    { ref: "personal", address: "sam@riverbend.example.test", kind: "personal", organization: null, preferred: true },
    { ref: "workplace:1", address: "sam@gazette.example.test", kind: "workplace", organization: "Riverbend Gazette", preferred: false },
  ],
};

type Call = { url: string; method: string; body: unknown };
function stub(roles: string[], onAdd?: (body: Record<string, unknown>) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
    if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
    if (url === "/nod/api/media-lists") return jsonResponse(200, [{ listKey: "media-distribution-lists:budget", key: "budget", name: "Budget", active: true, members: 2, needsAttention: 2 }]);
    if (url === "/nod/api/media-lists/budget/members" && method === "GET") return jsonResponse(200, MEMBERS);
    if (url === "/nod/api/media-lists/budget/members" && method === "POST") return onAdd?.(body) ?? jsonResponse(201, { subscriberId: "x", created: true });
    if (url === "/nod/api/media-lists/budget/opted-out") return jsonResponse(200, OPTED);
    if (url === "/nod/api/media-hub/contacts/search") return jsonResponse(200, { contacts: [CONTACT], page: 1, pageSize: 25, total: 1 });
    if (url === "/nod/api/media-hub/contacts/42") return jsonResponse(200, CONTACT);
    if (url.startsWith("/nod/api/media-lists/budget/members/") && method === "DELETE") return new Response(null, { status: 204 });
    if (url.endsWith("/resolve")) return jsonResponse(200, { ok: true });
    throw new Error(`unhandled: ${method} ${url}`);
  }));
  return calls;
}
function renderIt() {
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/subscribers/media-lists/budget"]}>
        <RequireAuth>
          <Routes>
            <Route path="/subscribers/media-lists/:key" element={<MediaListScreen />} />
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe("MediaListScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("shows members with source and flag, and the opt-outs; a Viewer has no controls", async () => {
    stub(["NoD.Viewer"]);
    renderIt();
    const members = await screen.findByRole("table", { name: "Members" });
    expect(within(members).getByRole("row", { name: /sam@riverbend\.example\.test Media Hub Media Hub email removed/ })).toBeInTheDocument();
    expect(within(members).getByRole("row", { name: /lee@example\.test Added by hand Bouncing/ })).toBeInTheDocument();
    const opted = screen.getByRole("table", { name: "Left this list by unsubscribing" });
    expect(within(opted).getByRole("row", { name: /gone@example\.test .* No/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Email address" })).toBeNull();
    expect(screen.getByText("Budget")).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe("Media list — GCPE News Staff"));
  });

  it("opted-out add asks first, shows when they left, and sends confirmOptOut only on confirm", async () => {
    const calls = stub(["NoD.Editor"], (body) => (body.confirmOptOut ? jsonResponse(200, { subscriberId: "x", created: false }) : jsonResponse(409, { error: "opted-out", at: "2026-09-01T17:00:00.000Z" })));
    renderIt();
    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox", { name: "Email address" }), "gone@example.test");
    await user.click(screen.getByRole("button", { name: "Add to list" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("They unsubscribed");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/members"))).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Add to list" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Add anyway" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/nod/api/media-lists/budget/members", method: "POST", body: { email: "gone@example.test", confirmOptOut: true } }));
    expect(await screen.findByRole("status")).toHaveTextContent("Added to the list.");
  });

  it("Media Hub search posts the term (never in the URL) and adds the chosen email", async () => {
    const calls = stub(["NoD.Editor"]);
    renderIt();
    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox", { name: "Name, email or outlet" }), "Sam");
    await user.click(screen.getByRole("button", { name: "Search Media Hub" }));
    await user.click(await screen.findByRole("button", { name: "Add sam@gazette.example.test" }));
    expect(calls).toContainEqual({ url: "/nod/api/media-hub/contacts/search", method: "POST", body: { q: "Sam", page: 1 } });
    expect(calls.some((c) => c.url.includes("Sam"))).toBe(false);
    await waitFor(() => expect(calls).toContainEqual({ url: "/nod/api/media-lists/budget/members", method: "POST", body: { mediaHubContactId: 42, emailRef: "workplace:1" } }));
  });

  it("remove asks first, then DELETEs", async () => {
    const calls = stub(["NoD.Editor"]);
    renderIt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Remove lee@example.test" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Confirm remove" }));
    await waitFor(() => expect(calls).toContainEqual({ url: `/nod/api/media-lists/budget/members/${ID2}`, method: "DELETE", body: undefined }));
  });

  it("resolve: bouncing clears with an empty body; a Media Hub flag offers the contact's emails", async () => {
    const calls = stub(["NoD.Editor"]);
    renderIt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Resolve lee@example.test" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Clear flag" }));
    await waitFor(() => expect(calls).toContainEqual({ url: `/nod/api/media-members/${ID2}/resolve`, method: "POST", body: {} }));
    await user.click(await screen.findByRole("button", { name: "Resolve sam@riverbend.example.test" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(await within(dialog).findByRole("radio", { name: /sam@gazette\.example\.test/ }));
    await user.click(within(dialog).getByRole("button", { name: "Use this email" }));
    await waitFor(() => expect(calls).toContainEqual({ url: `/nod/api/media-members/${ID1}/resolve`, method: "POST", body: { emailRef: "workplace:1" } }));
  });
});
```

`a11y.test.tsx`: extend `stubCommon` with the same `/nod/api/media-lists`, `/members`, `/opted-out` and `/media-hub/sync` responses as above. Then add:

```tsx
  it("Media lists has no serious violations", async () => {
    stubCommon(["NoD.Editor"]);
    const { container } = render(withAuthAt("/subscribers/media-lists", "/subscribers/media-lists", <MediaListsScreen />));
    await screen.findByRole("link", { name: "Budget" });
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("A media list, with the remove dialog open, has no serious violations", async () => {
    stubCommon(["NoD.Editor"]);
    const { container } = render(withAuthAt("/subscribers/media-lists/budget", "/subscribers/media-lists/:key", <MediaListScreen />));
    await userEvent.setup().click(await screen.findByRole("button", { name: "Remove lee@example.test" }));
    await screen.findByRole("alertdialog");
    expect(await seriousViolations(document.body)).toEqual([]);
    expect(await seriousViolations(container)).toEqual([]);
  });
```

`withAuthAt(path, pattern, element)` is a local helper. Copy the file's existing `withAuth` and give it `initialEntries={[path]}` and a single `<Route path={pattern} element={element} />`. If `withAuth` already takes a path, use it instead.

- [ ] **Step 2: Run them; expect FAIL** (the modules don't exist).

- [ ] **Step 3: MediaListsScreen**

```tsx
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Button, InlineAlert } from "@bcgov/design-system-react-components";
import { apiFetch, ApiError } from "../../api/client";
import { formatWhen } from "../../format/dates";
import { useTenantTimeZone } from "../../format/tenantTimeZone";
import { useSession } from "../../session/SessionContext";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { canEditSubscribers } from "./access";
import { describeSync, mediaErrorText } from "./labels";
import type { MediaListSummary, SyncResultView, SyncStatus } from "./types";

/** `/hub/subscribers/media-lists`: every media list (names from NRMS), its member and
 * needs-attention counts, and the nightly Media Hub sync's last result. Editors can run the
 * sync now. */
export function MediaListsScreen(): React.JSX.Element {
  useDocumentTitle("Media lists");
  const session = useSession();
  const canEdit = canEditSubscribers(session);
  const timeZone = useTenantTimeZone();
  const [lists, setLists] = useState<MediaListSummary[] | null>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    Promise.all([apiFetch<MediaListSummary[]>("/nod/api/media-lists"), apiFetch<SyncStatus>("/nod/api/media-hub/sync")]).then(
      ([l, s]) => {
        setLists(l);
        setSync(s);
        setLoadError(null);
      },
      () => setLoadError("Couldn't load media lists."),
    );
  }, []);
  useEffect(() => reload(), [reload]);

  const runSync = async () => {
    setBusy(true);
    setSyncError(null);
    setMessage(null);
    try {
      const r = await apiFetch<{ done: boolean; result: SyncResultView }>("/nod/api/media-hub/sync", { method: "POST" });
      setMessage(r.done ? `Sync finished. ${describeSync(r.result)}` : `Sync stopped part-way and carries on at the next scheduled run. ${describeSync(r.result)}`);
      reload();
    } catch (e) {
      setSyncError(e instanceof ApiError && e.status === 409 ? "A sync is already running. Try again in a few minutes." : mediaErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gcpe-subscribers__media-lists">
      <h1>Media lists</h1>
      {loadError && <InlineAlert variant="danger" role="alert" description={loadError} />}
      {session.has("Core.Admin") && (
        <p>
          <Link to="/media-list-names">Manage media list names</Link>
        </p>
      )}
      {lists && lists.length === 0 && <p>No media lists yet.</p>}
      {lists && lists.length > 0 && (
        <table aria-label="Media lists">
          <thead>
            <tr>
              <th scope="col">List</th>
              <th scope="col">Members</th>
              <th scope="col">Need attention</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {lists.map((l) => (
              <tr key={l.listKey}>
                <td>
                  <Link to={`/subscribers/media-lists/${encodeURIComponent(l.key)}`}>{l.name}</Link>
                </td>
                <td>{l.members}</td>
                <td>{l.needsAttention}</td>
                <td>{l.active ? "Active" : "Retired"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <section aria-labelledby="media-sync-heading">
        <h2 id="media-sync-heading">Media Hub sync</h2>
        {sync && (
          <>
            <p>{`Last run: ${sync.at ? formatWhen(sync.at, new Date(), timeZone) : "never"}.`}</p>
            <p>{describeSync(sync.result)}</p>
            {sync.running && <p>A sync is running now.</p>}
          </>
        )}
        {message && <p role="status">{message}</p>}
        {syncError && <InlineAlert variant="danger" role="alert" description={syncError} />}
        {canEdit && (
          <Button variant="secondary" onPress={() => void runSync()} isDisabled={busy}>
            Sync with Media Hub now
          </Button>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 4: MediaHubSearch**

```tsx
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Form, InlineAlert, TextField } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../api/client";
import { Pagination } from "../releases/Pagination";
import { mediaErrorText } from "./labels";
import type { AddMemberBody, MediaHubContactPage } from "./types";

/** Finds Media Hub contacts by name, email or outlet and adds the chosen email (spec §5.3).
 * The term lives in component state and goes to NoD in a POST body, never in a URL. */
export function MediaHubSearch({ onAdd, disabled }: { onAdd(body: AddMemberBody): void; disabled: boolean }): React.JSX.Element {
  const [input, setInput] = useState("");
  const [q, setQ] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<MediaHubContactPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Only the latest search may land.
  const latest = useRef(0);

  useEffect(() => {
    if (q === null) return;
    const seq = ++latest.current;
    apiFetch<MediaHubContactPage>("/nod/api/media-hub/contacts/search", { method: "POST", body: { q, page } }).then(
      (r) => {
        if (seq !== latest.current) return;
        setResult(r);
        setError(null);
      },
      (e: unknown) => {
        if (seq === latest.current) setError(mediaErrorText(e));
      },
    );
  }, [q, page]);

  const onSearch = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setPage(1);
    setQ(input.trim());
  };

  const contacts = (result?.contacts ?? []).filter((c) => !c.deletedAt);
  return (
    <section aria-labelledby="media-hub-search-heading">
      <h2 id="media-hub-search-heading">Add from Media Hub</h2>
      <Form onSubmit={onSearch} aria-label="Search Media Hub">
        <TextField label="Name, email or outlet" name="q" value={input} onChange={setInput} />
        <Button type="submit">Search Media Hub</Button>
      </Form>
      {error && <InlineAlert variant="danger" role="alert" description={error} />}
      {result && contacts.length === 0 && <p>No contacts match.</p>}
      {contacts.length > 0 && (
        <ul className="gcpe-subscribers__hub-results">
          {contacts.map((c) => (
            <li key={c.id}>
              <strong>{`${c.firstName} ${c.lastName}`}</strong>
              {c.outlet && ` — ${c.outlet}`}
              <ul>
                {c.emails.map((e) => (
                  <li key={e.ref}>
                    {`${e.address} (${e.kind}${e.preferred ? ", preferred" : ""}) `}
                    <Button variant="secondary" isDisabled={disabled} onPress={() => onAdd({ mediaHubContactId: c.id, emailRef: e.ref })}>
                      {`Add ${e.address}`}
                    </Button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {result && <Pagination page={result.page} pageSize={result.pageSize} total={result.total} onPageChange={setPage} />}
    </section>
  );
}
```

- [ ] **Step 5: ResolveDialog**

```tsx
import { useEffect, useState } from "react";
import { AlertDialog, Button, InlineAlert, Modal } from "@bcgov/design-system-react-components";
import { apiFetch, ApiError } from "../../api/client";
import { attentionLabel, mediaErrorText } from "./labels";
import type { MediaHubContact, MediaMember } from "./types";

/**
 * Clears a member's needs-attention flag (C59). "Bouncing", or a member with no Media Hub
 * contact, just clears. A bouncing member's bounce count restarts, so do it once the mailbox
 * works. A Media Hub flag offers the contact's current emails to switch to, or clearing the flag
 * as it stands.
 */
export function ResolveDialog({ member, onClose, onResolved }: { member: MediaMember; onClose(): void; onResolved(message: string): void }): React.JSX.Element {
  const bouncing = member.needsAttention === "bouncing";
  const chooseEmail = !bouncing && member.mediaHubContactId !== null;
  const [contact, setContact] = useState<MediaHubContact | null>(null);
  const [ref, setRef] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!chooseEmail) return;
    let live = true;
    apiFetch<MediaHubContact>(`/nod/api/media-hub/contacts/${member.mediaHubContactId}`).then(
      (c) => {
        if (live) setContact(c);
      },
      (e: unknown) => {
        if (live) setError(mediaErrorText(e));
      },
    );
    return () => {
      live = false;
    };
  }, [chooseEmail, member.mediaHubContactId]);

  const resolve = async (emailRef?: string) => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/nod/api/media-members/${member.subscriberId}/resolve`, { method: "POST", body: emailRef ? { emailRef } : {} });
      onResolved(emailRef ? "Email updated and flag cleared." : "Flag cleared.");
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 409 && e.message === "email-taken"
          ? "That address belongs to another subscriber. Choose another email, or remove this member."
          : mediaErrorText(e),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onOpenChange={(open) => { if (!open) onClose(); }} isDismissable>
      <AlertDialog
        role="alertdialog"
        variant="warning"
        title={bouncing ? "Clear the bouncing flag?" : "Resolve this member"}
        buttons={
          <>
            <Button onPress={onClose} isDisabled={busy}>
              Cancel
            </Button>
            {chooseEmail && (
              <Button variant="secondary" onPress={() => void resolve()} isDisabled={busy}>
                Clear the flag only
              </Button>
            )}
            <Button onPress={() => void resolve(chooseEmail ? (ref ?? undefined) : undefined)} isDisabled={busy || (chooseEmail && !ref)}>
              {chooseEmail ? "Use this email" : "Clear flag"}
            </Button>
          </>
        }
      >
        <p>
          {bouncing
            ? "Do this once their mailbox works again. Their bounce count starts again from now."
            : `${member.email}: ${attentionLabel(member.needsAttention ?? "")}.`}
        </p>
        {chooseEmail && contact && (
          <fieldset>
            <legend>Choose the email to use</legend>
            {contact.emails.map((e) => (
              <label key={e.ref}>
                <input type="radio" name="emailRef" value={e.ref} checked={ref === e.ref} onChange={() => setRef(e.ref)} />{" "}
                {e.address}
                {e.organization ? ` (${e.organization})` : ""}
              </label>
            ))}
          </fieldset>
        )}
        {error && <InlineAlert variant="danger" role="alert" description={error} />}
      </AlertDialog>
    </Modal>
  );
}
```

- [ ] **Step 6: MediaListScreen**

```tsx
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { AlertDialog, Button, Form, InlineAlert, Modal, TextField } from "@bcgov/design-system-react-components";
import { apiFetch, ApiError } from "../../api/client";
import { formatWhen } from "../../format/dates";
import { useTenantTimeZone } from "../../format/tenantTimeZone";
import { useSession } from "../../session/SessionContext";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { canEditSubscribers } from "./access";
import { attentionLabel, mediaErrorText, memberSourceLabel } from "./labels";
import { MediaHubSearch } from "./MediaHubSearch";
import { ResolveDialog } from "./ResolveDialog";
import type { AddMemberBody, MediaListSummary, MediaMember, MediaOptOutPage } from "./types";

/**
 * `/hub/subscribers/media-lists/:key`: one media list's members, who left it by unsubscribing,
 * and, for Editors, add (by hand or from Media Hub), remove and resolve. The h1 and title are
 * the static "Media list"; the list name is shown below it (no async titles). Re-adding someone
 * who unsubscribed always asks first and names when they left (C64).
 */
export function MediaListScreen(): React.JSX.Element {
  const { key = "" } = useParams();
  useDocumentTitle("Media list");
  const canEdit = canEditSubscribers(useSession());
  const timeZone = useTenantTimeZone();
  const base = `/nod/api/media-lists/${encodeURIComponent(key)}`;

  const [list, setList] = useState<MediaListSummary | null>(null);
  const [members, setMembers] = useState<MediaMember[] | null>(null);
  const [optOuts, setOptOuts] = useState<MediaOptOutPage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [optOutPrompt, setOptOutPrompt] = useState<{ body: AddMemberBody; at: string } | null>(null);
  const [removing, setRemoving] = useState<MediaMember | null>(null);
  const [resolving, setResolving] = useState<MediaMember | null>(null);

  const reload = useCallback(() => {
    Promise.all([apiFetch<MediaListSummary[]>("/nod/api/media-lists"), apiFetch<MediaMember[]>(`${base}/members`), apiFetch<MediaOptOutPage>(`${base}/opted-out`)]).then(
      ([all, m, o]) => {
        setList(all.find((l) => l.key === key) ?? null);
        setMembers(m);
        setOptOuts(o);
        setLoadError(null);
      },
      (e: unknown) => setLoadError(e instanceof ApiError && e.status === 404 ? "There's no media list with that key." : "Couldn't load this media list."),
    );
  }, [base, key]);
  useEffect(() => reload(), [reload]);

  const add = async (body: AddMemberBody) => {
    setBusy(true);
    setActionError(null);
    setMessage(null);
    try {
      await apiFetch(`${base}/members`, { method: "POST", body });
      setOptOutPrompt(null);
      setEmail("");
      setMessage("Added to the list.");
      reload();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.message === "opted-out") {
        setOptOutPrompt({ body, at: (e.body as { at?: string } | undefined)?.at ?? "" });
      } else {
        setActionError(mediaErrorText(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const onAddManual = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (email.trim()) void add({ email: email.trim() });
  };

  const remove = async (m: MediaMember) => {
    setBusy(true);
    setActionError(null);
    try {
      await apiFetch(`${base}/members/${m.subscriberId}`, { method: "DELETE" });
      setRemoving(null);
      setMessage("Removed from the list.");
      reload();
    } catch {
      setActionError("Couldn't remove. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gcpe-subscribers__media-list">
      <h1>Media list</h1>
      <p>
        <Link to="/subscribers/media-lists">All media lists</Link>
      </p>
      {list && (
        <p>
          <strong>{list.name}</strong>
          {!list.active && " (retired in NRMS: releases can no longer be sent to it)"}
        </p>
      )}
      {loadError && <InlineAlert variant="danger" role="alert" description={loadError} />}
      {message && <p role="status">{message}</p>}
      {actionError && <InlineAlert variant="danger" role="alert" description={actionError} />}

      {members && members.length === 0 && <p>No members yet.</p>}
      {members && members.length > 0 && (
        <table aria-label="Members">
          <thead>
            <tr>
              <th scope="col">Email</th>
              <th scope="col">Source</th>
              <th scope="col">Needs attention</th>
              {canEdit && <th scope="col">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.subscriberId}>
                <td>
                  <Link to={`/subscribers/${m.subscriberId}`}>{m.email}</Link>
                </td>
                <td>{memberSourceLabel(m.source)}</td>
                <td>{m.needsAttention ? attentionLabel(m.needsAttention) : ""}</td>
                {canEdit && (
                  <td>
                    {m.needsAttention && (
                      <Button variant="secondary" isDisabled={busy} onPress={() => setResolving(m)}>
                        {`Resolve ${m.email}`}
                      </Button>
                    )}
                    <Button variant="secondary" danger isDisabled={busy} onPress={() => setRemoving(m)}>
                      {`Remove ${m.email}`}
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canEdit && (
        <>
          <section aria-labelledby="add-manual-heading">
            <h2 id="add-manual-heading">Add an address by hand</h2>
            <p>For people who aren&rsquo;t in Media Hub.</p>
            <Form onSubmit={onAddManual} aria-label="Add an address by hand">
              <TextField label="Email address" name="email" value={email} onChange={setEmail} />
              <Button type="submit" isDisabled={busy}>
                Add to list
              </Button>
            </Form>
          </section>
          <MediaHubSearch onAdd={(body) => void add(body)} disabled={busy} />
        </>
      )}

      <section aria-labelledby="opted-out-heading">
        <h2 id="opted-out-heading">Left this list by unsubscribing</h2>
        {optOuts && optOuts.items.length === 0 && <p>Nobody has.</p>}
        {optOuts && optOuts.items.length > 0 && (
          <table aria-label="Left this list by unsubscribing">
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">Left</th>
                <th scope="col">Back on the list</th>
              </tr>
            </thead>
            <tbody>
              {optOuts.items.map((o) => (
                <tr key={`${o.subscriberId}-${o.at}`}>
                  <td>
                    <Link to={`/subscribers/${o.subscriberId}`}>{o.email}</Link>
                  </td>
                  <td>{formatWhen(o.at, new Date(), timeZone)}</td>
                  <td>{o.member ? "Yes" : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {optOuts?.truncated && <p>Showing the most recent 200.</p>}
      </section>

      {optOutPrompt && (
        <Modal isOpen onOpenChange={(open) => { if (!open) setOptOutPrompt(null); }} isDismissable>
          <AlertDialog
            role="alertdialog"
            variant="warning"
            title="This person unsubscribed"
            buttons={
              <>
                <Button onPress={() => setOptOutPrompt(null)} isDisabled={busy}>
                  Cancel
                </Button>
                <Button onPress={() => void add({ ...optOutPrompt.body, confirmOptOut: true })} isDisabled={busy}>
                  Add anyway
                </Button>
              </>
            }
          >
            <p>{`They unsubscribed ${optOutPrompt.at ? formatWhen(optOutPrompt.at, new Date(), timeZone) : "earlier"}. Add them only if they've asked to receive media releases again.`}</p>
          </AlertDialog>
        </Modal>
      )}

      {removing && (
        <Modal isOpen onOpenChange={(open) => { if (!open) setRemoving(null); }} isDismissable>
          <AlertDialog
            role="alertdialog"
            variant="destructive"
            title={`Remove ${removing.email} from this list?`}
            buttons={
              <>
                <Button onPress={() => setRemoving(null)} isDisabled={busy}>
                  Cancel
                </Button>
                <Button danger onPress={() => void remove(removing)} isDisabled={busy}>
                  Confirm remove
                </Button>
              </>
            }
          >
            <p>If this is their last list and they were added only for media lists, they stop receiving email altogether.</p>
          </AlertDialog>
        </Modal>
      )}

      {resolving && (
        <ResolveDialog
          member={resolving}
          onClose={() => setResolving(null)}
          onResolved={(text) => {
            setResolving(null);
            setMessage(text);
            reload();
          }}
        />
      )}
    </div>
  );
}
```

`router.tsx`: replace the two `null` media routes with `<MediaListsScreen />` and `<MediaListScreen />`.

- [ ] **Step 7: Run; expect PASS.** Run all of `apps/staff-web/src/screens/subscribers`. If a row-name regex misses because of whitespace in the accessible name, fix the regex, never the assertion's intent.

- [ ] **Step 8: Type-check staff-web, then commit**

```bash
git add apps/staff-web
git commit -m "feat(staff-web): media lists — members, add by hand or from Media Hub, opt-out confirmation, remove, resolve, sync"
```

---

### Task 6: staff-web Operations screen

**Files:**
- Create: `apps/staff-web/src/screens/subscribers/OperationsScreen.tsx` (+ `OperationsScreen.test.tsx`).
- Modify: `apps/staff-web/src/router.tsx` (the `operations` route), `apps/staff-web/src/screens/subscribers/a11y.test.tsx`.

**Interfaces:**
- Consumes:
  - `GET /nod/api/operations`, `PUT /nod/api/operations/bounce-summary-address` (Task 3);
  - existing `POST /nod/api/settings/pause|resume`, `POST /nod/api/distribution/pause|resume`, `POST /nod/api/bounces/inbox` `{ raw }`.
- Produces: `OperationsScreen`.

- [ ] **Step 1: Write the failing tests**

`OperationsScreen.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "../../../test/jsonResponse";
import { SessionProvider } from "../../session/SessionContext";
import { RequireAuth } from "../../session/RequireAuth";
import { OperationsScreen } from "./OperationsScreen";
import type { OperationsStatus } from "./types";

const OPS: OperationsStatus = {
  nod: { paused: false, lastDigestCutoff: "2026-10-07T00:00:00.000Z" },
  distribution: { paused: false },
  bounceSource: "fake",
  bounceSummary: { address: "server@example.test", from: "server" },
};

type Call = { url: string; method: string; body: unknown };
function stub(roles: string[], ops: OperationsStatus = OPS) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
    if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
    if (url === "/nod/api/operations") return jsonResponse(200, ops);
    if (url.endsWith("/pause")) return jsonResponse(200, { paused: true, changed: true });
    if (url === "/nod/api/operations/bounce-summary-address") return jsonResponse(200, { changed: true, bounceSummary: { address: "staff@example.test", from: "setting" } });
    if (url === "/nod/api/bounces/inbox") return jsonResponse(201, { id: "b1" });
    throw new Error(`unhandled: ${method} ${url}`);
  }));
  return calls;
}
function renderIt() {
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/subscribers/operations"]}>
        <RequireAuth>
          <Routes>
            <Route path="/subscribers/operations" element={<OperationsScreen />} />
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe("OperationsScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("an Editor is told it's for admins and nothing is fetched", async () => {
    const calls = stub(["NoD.Editor"]);
    renderIt();
    expect(await screen.findByText("You don’t have permission to use Operations.")).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/nod/api/operations")).toBe(false);
    await waitFor(() => expect(document.title).toBe("Operations — GCPE News Staff"));
  });

  it("pausing NoD asks first, then posts and reloads", async () => {
    const calls = stub(["NoD.Admin"]);
    renderIt();
    const user = userEvent.setup();
    const nod = await screen.findByRole("region", { name: "News On Demand sending" });
    expect(within(nod).getByText("Running")).toBeInTheDocument();
    await user.click(within(nod).getByRole("button", { name: "Pause News On Demand sending" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Nothing is dropped");
    await user.click(within(dialog).getByRole("button", { name: "Confirm pause" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/nod/api/settings/pause", method: "POST", body: undefined }));
    expect(calls.filter((c) => c.url === "/nod/api/operations").length).toBeGreaterThanOrEqual(2);
  });

  it("Distribution unavailable: says so, offers no Distribution button, NoD controls still work", async () => {
    stub(["NoD.Admin"], { ...OPS, distribution: null, bounceSource: null });
    renderIt();
    const dist = await screen.findByRole("region", { name: "Distribution" });
    expect(within(dist).getByText(/Distribution isn’t responding/)).toBeInTheDocument();
    expect(within(dist).queryByRole("button")).toBeNull();
    expect(screen.getByRole("button", { name: "Pause News On Demand sending" })).toBeEnabled();
    expect(screen.queryByRole("region", { name: "Test bounce upload" })).toBeNull();
  });

  it("sets the summary address and offers the server default back", async () => {
    const calls = stub(["NoD.Admin"]);
    renderIt();
    const user = userEvent.setup();
    expect(await screen.findByText("Using the server default.")).toBeInTheDocument();
    const field = screen.getByRole("textbox", { name: "Bounce summary email" });
    await user.clear(field);
    await user.type(field, "staff@example.test");
    await user.click(screen.getByRole("button", { name: "Save address" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/nod/api/operations/bounce-summary-address", method: "PUT", body: { address: "staff@example.test" } }));
    expect(await screen.findByRole("status")).toHaveTextContent("Bounce summary address saved.");
  });

  it("uploads a pasted bounce on a fake-mailbox site", async () => {
    const calls = stub(["NoD.Admin"]);
    renderIt();
    const user = userEvent.setup();
    const upload = await screen.findByRole("region", { name: "Test bounce upload" });
    await user.type(within(upload).getByRole("textbox", { name: "Or paste the message" }), "Subject: Undeliverable");
    await user.click(within(upload).getByRole("button", { name: "Upload bounce" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/nod/api/bounces/inbox", method: "POST", body: { raw: "Subject: Undeliverable" } }));
  });
});
```

`a11y.test.tsx`: stub `/nod/api/operations` with the `OPS` above, and add:

```tsx
  it("Operations, with the pause dialog open, has no serious violations", async () => {
    stubCommon(["NoD.Admin"]);
    const { container } = render(withAuthAt("/subscribers/operations", "/subscribers/operations", <OperationsScreen />));
    await userEvent.setup().click(await screen.findByRole("button", { name: "Pause News On Demand sending" }));
    await screen.findByRole("alertdialog");
    expect(await seriousViolations(document.body)).toEqual([]);
    expect(await seriousViolations(container)).toEqual([]);
  });
```

- [ ] **Step 2: Run them; expect FAIL** (the module doesn't exist).

- [ ] **Step 3: OperationsScreen**

```tsx
import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { AlertDialog, Button, DialogTrigger, Form, InlineAlert, Modal, TextField } from "@bcgov/design-system-react-components";
import { apiFetch, ApiError } from "../../api/client";
import { formatWhen } from "../../format/dates";
import { useTenantTimeZone } from "../../format/tenantTimeZone";
import { useSession } from "../../session/SessionContext";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { canAdminSubscribers } from "./access";
import type { OperationsStatus } from "./types";

/** Distribution's own fake-inbox limit (apps/distribution/src/http/routes.ts). */
const MAX_BOUNCE_BYTES = 1024 * 1024;

/** `/hub/subscribers/operations` (legacy ManageDistributionService), NoD.Admin only. */
export function OperationsScreen(): React.JSX.Element {
  useDocumentTitle("Operations");
  const canAdmin = canAdminSubscribers(useSession());
  if (!canAdmin) {
    return (
      <div className="gcpe-subscribers__operations">
        <h1>Operations</h1>
        <p>You don&rsquo;t have permission to use Operations.</p>
      </div>
    );
  }
  return <OperationsPanels />;
}

function OperationsPanels(): React.JSX.Element {
  const timeZone = useTenantTimeZone();
  const [ops, setOps] = useState<OperationsStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(() => {
    apiFetch<OperationsStatus>("/nod/api/operations").then(
      (o) => {
        setOps(o);
        setLoadError(null);
      },
      () => setLoadError("Couldn't load operations."),
    );
  }, []);
  useEffect(() => reload(), [reload]);
  const done = (text: string) => {
    setMessage(text);
    reload();
  };

  return (
    <div className="gcpe-subscribers__operations">
      <h1>Operations</h1>
      {loadError && <InlineAlert variant="danger" role="alert" description={loadError} />}
      {message && <p role="status">{message}</p>}
      {ops && (
        <>
          <PauseControl
            title="News On Demand sending"
            paused={ops.nod.paused}
            path="/nod/api/settings"
            pauseBody="News On Demand keeps recording releases and building emails but holds them until you resume. Nothing is dropped. The operations inbox is emailed."
            resumeBody="Held emails start going out straight away. The operations inbox is emailed."
            onDone={done}
          >
            <p>{`Last daily digest: ${ops.nod.lastDigestCutoff ? formatWhen(ops.nod.lastDigestCutoff, new Date(), timeZone) : "none yet"}.`}</p>
          </PauseControl>
          {ops.distribution ? (
            <PauseControl
              title="Distribution"
              paused={ops.distribution.paused}
              path="/nod/api/distribution"
              pauseBody="No email goes out from any app, except system notices, until you resume. Queued email is kept. The operations inbox is emailed."
              resumeBody="Queued email starts going out straight away. The operations inbox is emailed."
              onDone={done}
            />
          ) : (
            <section aria-labelledby="ops-distribution">
              <h2 id="ops-distribution">Distribution</h2>
              <InlineAlert variant="warning" description="Distribution isn’t responding, so its state is unknown. Reload the page shortly." />
            </section>
          )}
          <BounceSummaryForm value={ops.bounceSummary} onDone={done} />
          {ops.bounceSource === "fake" && <BounceUpload onDone={done} />}
        </>
      )}
    </div>
  );
}

function PauseControl(props: {
  title: string;
  paused: boolean;
  path: string;
  pauseBody: string;
  resumeBody: string;
  onDone(text: string): void;
  children?: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `ops-${props.path.replace(/\W+/g, "-")}`;
  const verb = props.paused ? "resume" : "pause";
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`${props.path}/${verb}`, { method: "POST" });
      setOpen(false);
      props.onDone(`${props.title} ${props.paused ? "resumed" : "paused"}.`);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 502 ? "Distribution isn’t responding. Nothing changed." : "Couldn’t change it. Nothing changed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby={id}>
      <h2 id={id}>{props.title}</h2>
      <p>{props.paused ? "Paused" : "Running"}</p>
      {props.children}
      <DialogTrigger
        isOpen={open}
        onOpenChange={(o) => {
          setError(null);
          setOpen(o);
        }}
      >
        <Button variant="secondary" danger={!props.paused}>{`${props.paused ? "Resume" : "Pause"} ${props.title}`}</Button>
        <Modal isDismissable>
          <AlertDialog
            role="alertdialog"
            variant="warning"
            title={`${props.paused ? "Resume" : "Pause"} ${props.title}?`}
            buttons={
              <>
                <Button onPress={() => setOpen(false)} isDisabled={busy}>
                  Cancel
                </Button>
                <Button danger={!props.paused} onPress={() => void run()} isDisabled={busy}>
                  {`Confirm ${verb}`}
                </Button>
              </>
            }
          >
            <p>{props.paused ? props.resumeBody : props.pauseBody}</p>
            {error && <InlineAlert variant="danger" role="alert" description={error} />}
          </AlertDialog>
        </Modal>
      </DialogTrigger>
    </section>
  );
}

function BounceSummaryForm({ value, onDone }: { value: OperationsStatus["bounceSummary"]; onDone(text: string): void }): React.JSX.Element {
  const [address, setAddress] = useState(value.address ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setAddress(value.address ?? ""), [value.address]);
  const put = async (next: string | null, text: string) => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/nod/api/operations/bounce-summary-address", { method: "PUT", body: { address: next } });
      onDone(text);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 400 ? "Enter a valid email address." : "Couldn’t save. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void put(address.trim() || null, "Bounce summary address saved.");
  };
  return (
    <section aria-labelledby="ops-bounce-summary">
      <h2 id="ops-bounce-summary">Bounce summary</h2>
      <p>A daily email at 8:00 listing bounced subscribers, sent only when there were bounces.</p>
      {value.from === "server" && <p>Using the server default.</p>}
      {value.from === null && <p>No address is set, so no summary is sent.</p>}
      <Form onSubmit={onSubmit} aria-label="Bounce summary address">
        <TextField label="Bounce summary email" name="address" value={address} onChange={setAddress} />
        <Button type="submit" isDisabled={busy}>
          Save address
        </Button>
        {value.from === "setting" && (
          <Button variant="secondary" isDisabled={busy} onPress={() => void put(null, "Using the server default again.")}>
            Use the server default
          </Button>
        )}
      </Form>
      {error && <InlineAlert variant="danger" role="alert" description={error} />}
    </section>
  );
}

/** Test sites only: shown when Distribution's bounce source is the fake mailbox (spec §7). */
function BounceUpload({ onDone }: { onDone(text: string): void }): React.JSX.Element {
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_BOUNCE_BYTES) return setError("That file is over 1 MB.");
    setError(null);
    setRaw(await file.text());
  };
  const upload = async () => {
    if (!raw.trim()) return setError("Choose a .eml file or paste a message first.");
    if (new Blob([raw]).size > MAX_BOUNCE_BYTES) return setError("That message is over 1 MB.");
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/nod/api/bounces/inbox", { method: "POST", body: { raw } });
      setRaw("");
      onDone("Uploaded. Bounce processing picks it up within 15 minutes.");
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? "This site doesn’t use the test mailbox." : "Couldn’t upload. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="ops-bounce-upload">
      <h2 id="ops-bounce-upload">Test bounce upload</h2>
      <p>Test sites only: every email is redirected, so real bounces never arrive. Upload a bounce message to test bounce handling.</p>
      <label>
        Bounce message (.eml)
        <input type="file" accept=".eml,message/rfc822,text/plain" onChange={(e) => void onFile(e)} disabled={busy} />
      </label>
      <label htmlFor="ops-bounce-raw">Or paste the message</label>
      <textarea id="ops-bounce-raw" rows={8} value={raw} onChange={(e) => setRaw(e.target.value)} disabled={busy} />
      <Button onPress={() => void upload()} isDisabled={busy}>
        Upload bounce
      </Button>
      {error && <InlineAlert variant="danger" role="alert" description={error} />}
    </section>
  );
}
```

`router.tsx`: replace the `operations` route's `null` with `<OperationsScreen />`.

The tests find each panel with `getByRole("region", { name })`. A `<section>` with `aria-labelledby` is a region, so this holds.

- [ ] **Step 4: Run; expect PASS. Type-check; commit**

```bash
git add apps/staff-web
git commit -m "feat(staff-web): Operations — NoD and Distribution pause/resume with confirmation, bounce summary address, test bounce upload"
```

---

### Task 7: Media list names (NRMS, Core.Admin)

Closes the carry-forward item "NRMS staff-web media-list screen".

**Files:**
- Create: `apps/staff-web/src/screens/admin/media-lists/MediaListNamesScreen.tsx` (+ `.test.tsx`).
- Modify:
  - `apps/nrms/src/http/routes.ts:301` and `apps/nrms/src/http/routes.test.ts` (`GET /media-lists` for `Core.Admin`);
  - `apps/staff-web/src/router.tsx` (top-level `media-list-names`);
  - `apps/staff-web/src/shell/AppShell.tsx` (nav item) and `AppShell.test.tsx`;
  - `apps/staff-web/src/screens/admin/a11y.test.tsx`.

**Interfaces:**
- Consumes: NRMS `GET /media-lists` → `{ key, displayName, sortOrder, isActive }[]`; `POST /media-lists` `{ key, displayName, sortOrder? }`; `PUT /media-lists/:key` `{ displayName?, sortOrder?, isActive? }`.
- Produces: `MediaListNamesScreen` at `/hub/media-list-names`, in the nav as "Media list names" for `Core.Admin`.

- [ ] **Step 1: Write the failing tests**

`apps/nrms/src/http/routes.test.ts`: inside the test at `:390`, after `expect(lists.status).toBe(200);`, add:

```ts
    // Core.Admin creates and edits media lists, so it must be able to list them too.
    expect((await get("/api/media-lists", await cookieFor(["Core.Admin"]))).status).toBe(200);
```

`MediaListNamesScreen.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { jsonResponse } from "../../../../test/jsonResponse";
import { SessionProvider } from "../../../session/SessionContext";
import { RequireAuth } from "../../../session/RequireAuth";
import { MediaListNamesScreen } from "./MediaListNamesScreen";

const ROWS = [
  { key: "001-a-daily-news", displayName: "Daily news", sortOrder: 1, isActive: true },
  { key: "002-budget", displayName: "Budget", sortOrder: 2, isActive: true },
];
type Call = { url: string; method: string; body: unknown };
function stub(roles: string[], onPost?: () => Response) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/core/auth/session") return jsonResponse(200, { user: { id: "u", name: "Pat", email: "pat@x.invalid", roles }, expiresAt: new Date().toISOString() });
    if (url === "/nrms/api/config") return jsonResponse(200, { timeZone: "America/Vancouver" });
    if (url === "/nrms/api/media-lists" && method === "GET") return jsonResponse(200, ROWS);
    if (url === "/nrms/api/media-lists" && method === "POST") return onPost?.() ?? jsonResponse(201, { key: "003-new", displayName: "New", sortOrder: 0, isActive: true });
    if (url.startsWith("/nrms/api/media-lists/") && method === "PUT") return jsonResponse(200, {});
    throw new Error(`unhandled: ${method} ${url}`);
  }));
  return calls;
}
function renderIt() {
  render(
    <SessionProvider>
      <MemoryRouter initialEntries={["/media-list-names"]}>
        <RequireAuth>
          <Routes>
            <Route path="/media-list-names" element={<MediaListNamesScreen />} />
          </Routes>
        </RequireAuth>
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe("MediaListNamesScreen", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("refuses anyone but a Core Admin", async () => {
    const calls = stub(["NoD.Admin"]);
    renderIt();
    expect(await screen.findByText("You don’t have permission to manage media list names.")).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/nrms/api/media-lists")).toBe(false);
    await waitFor(() => expect(document.title).toBe("Media list names — GCPE News Staff"));
  });

  it("renames a list and adds one; a duplicate key is explained", async () => {
    const calls = stub(["Core.Admin"]);
    renderIt();
    const user = userEvent.setup();
    const name = await screen.findByRole("textbox", { name: "Name for 002-budget" });
    await user.clear(name);
    await user.type(name, "Budget 2027");
    await user.click(screen.getByRole("button", { name: "Save 002-budget" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/nrms/api/media-lists/002-budget", method: "PUT", body: { displayName: "Budget 2027", sortOrder: 2, isActive: true } }));
    await user.type(screen.getByRole("textbox", { name: "Key" }), "003-new");
    await user.type(screen.getByRole("textbox", { name: "Name" }), "New");
    await user.click(screen.getByRole("button", { name: "Add media list" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/nrms/api/media-lists", method: "POST", body: { key: "003-new", displayName: "New" } }));
  });

  it("retiring a list asks first", async () => {
    const calls = stub(["Core.Admin"]);
    renderIt();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: "002-budget active" }));
    await user.click(screen.getByRole("button", { name: "Save 002-budget" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Retire list" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/nrms/api/media-lists/002-budget", method: "PUT", body: { displayName: "Budget", sortOrder: 2, isActive: false } }));
  });
});
```

Add an axe case for the screen to `apps/staff-web/src/screens/admin/a11y.test.tsx`, following that file's own stub pattern.

`apps/staff-web/src/shell/AppShell.test.tsx`:
- `allLabels` becomes `["Releases", "Search", "Website", "Subscribers", "Users", "Media list names", "Error log"]`;
- the Core.Admin case expects `["Website", "Users", "Media list names", "Error log"]`.

`visibleLabels` filters on `allLabels`, so the other cases are unaffected and still prove that no NRMS or NoD role sees the new item.

- [ ] **Step 2: Run them; expect FAIL** (403 for Core.Admin; the module doesn't exist).

- [ ] **Step 3: NRMS gate**

`apps/nrms/src/http/routes.ts:301`:

```ts
  // Core.Admin creates and edits media lists (mediaListAdmin, below), so it reads them too.
  r.get("/media-lists", anySignedIn, run(async (_req, res) => void res.json(await listMediaLists(db))));
```

`anySignedIn` is already defined at :113 as the three NRMS roles plus `Core.Admin`.

- [ ] **Step 4: MediaListNamesScreen**

```tsx
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AlertDialog, Button, Form, InlineAlert, Modal, TextField } from "@bcgov/design-system-react-components";
import { apiFetch, ApiError } from "../../../api/client";
import { useSession } from "../../../session/SessionContext";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";

interface MediaListRecord {
  key: string;
  displayName: string;
  sortOrder: number;
  isActive: boolean;
}

/** `/hub/media-list-names`: NRMS owns media-list keys and names (C47); NoD mirrors them through
 * events within a minute. Core.Admin only, the role NRMS's media-list admin routes require. */
export function MediaListNamesScreen(): React.JSX.Element {
  useDocumentTitle("Media list names");
  if (!useSession().has("Core.Admin")) {
    return (
      <div className="gcpe-admin__media-lists">
        <h1>Media list names</h1>
        <p>You don&rsquo;t have permission to manage media list names.</p>
      </div>
    );
  }
  return <MediaListNamesEditor />;
}

function MediaListNamesEditor(): React.JSX.Element {
  const [rows, setRows] = useState<MediaListRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    apiFetch<MediaListRecord[]>("/nrms/api/media-lists").then(
      (r) => {
        setRows(r);
        setLoadError(null);
      },
      () => setLoadError("Couldn't load media lists."),
    );
  }, []);
  useEffect(() => reload(), [reload]);

  const onAdd = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setAddError(null);
    try {
      await apiFetch("/nrms/api/media-lists", { method: "POST", body: { key: key.trim(), displayName: name.trim() } });
      setKey("");
      setName("");
      setMessage("Media list added. It reaches News On Demand within a minute.");
      reload();
    } catch (err) {
      setAddError(
        err instanceof ApiError && err.status === 409
          ? "A media list with that key already exists."
          : err instanceof ApiError && err.status === 400
            ? "Keys use lowercase letters, numbers and hyphens; both fields are required."
            : "Couldn't add. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gcpe-admin__media-lists">
      <h1>Media list names</h1>
      <p>Changes reach News On Demand&rsquo;s media lists within a minute. Members are managed under Subscribers, Media lists.</p>
      {loadError && <InlineAlert variant="danger" role="alert" description={loadError} />}
      {message && <p role="status">{message}</p>}
      {rows && (
        <table aria-label="Media lists">
          <thead>
            <tr>
              <th scope="col">Key</th>
              <th scope="col">Name</th>
              <th scope="col">Order</th>
              <th scope="col">Active</th>
              <th scope="col">Save</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <MediaListRow
                key={r.key}
                record={r}
                onSaved={(text) => {
                  setMessage(text);
                  reload();
                }}
              />
            ))}
          </tbody>
        </table>
      )}
      <Form onSubmit={(e) => void onAdd(e)} aria-label="Add a media list">
        <TextField label="Key" name="key" value={key} onChange={setKey} />
        <TextField label="Name" name="name" value={name} onChange={setName} />
        <Button type="submit" isDisabled={busy}>
          Add media list
        </Button>
      </Form>
      {addError && <InlineAlert variant="danger" role="alert" description={addError} />}
    </div>
  );
}

function MediaListRow({ record, onSaved }: { record: MediaListRecord; onSaved(text: string): void }): React.JSX.Element {
  const [name, setName] = useState(record.displayName);
  const [order, setOrder] = useState(String(record.sortOrder));
  const [active, setActive] = useState(record.isActive);
  const [confirmRetire, setConfirmRetire] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const sortOrder = Number(order);
    if (!Number.isInteger(sortOrder)) return setError("Order must be a whole number.");
    if (!name.trim()) return setError("Name is required.");
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/nrms/api/media-lists/${encodeURIComponent(record.key)}`, { method: "PUT", body: { displayName: name.trim(), sortOrder, isActive: active } });
      setConfirmRetire(false);
      onSaved(`${record.key} saved.`);
    } catch {
      setError("Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr>
      <td>{record.key}</td>
      <td>
        <TextField label={`Name for ${record.key}`} value={name} onChange={setName} />
      </td>
      <td>
        <label>
          <span className="visually-hidden">{`Order for ${record.key}`}</span>
          <input type="number" value={order} onChange={(e) => setOrder(e.target.value)} />
        </label>
      </td>
      <td>
        <label>
          <input type="checkbox" checked={active} onChange={() => setActive(!active)} /> {`${record.key} active`}
        </label>
      </td>
      <td>
        <Button variant="secondary" isDisabled={busy} onPress={() => (record.isActive && !active ? setConfirmRetire(true) : void save())}>
          {`Save ${record.key}`}
        </Button>
        {error && <InlineAlert variant="danger" role="alert" description={error} />}
        {confirmRetire && (
          <Modal isOpen onOpenChange={(open) => { if (!open) setConfirmRetire(false); }} isDismissable>
            <AlertDialog
              role="alertdialog"
              variant="warning"
              title={`Retire ${record.key}?`}
              buttons={
                <>
                  <Button onPress={() => setConfirmRetire(false)} isDisabled={busy}>
                    Cancel
                  </Button>
                  <Button onPress={() => void save()} isDisabled={busy}>
                    Retire list
                  </Button>
                </>
              }
            >
              <p>Releases can no longer be sent to it. Its members are kept, and ticking Active again brings it back.</p>
            </AlertDialog>
          </Modal>
        )}
      </td>
    </tr>
  );
}
```

If `visually-hidden` isn't the staff app's class for screen-reader-only text, use whichever class `grep -rn "visually-hidden\|sr-only" apps/staff-web/src` finds.

`router.tsx`: add `{ path: "media-list-names", element: <MediaListNamesScreen /> },` next to `users`.

`AppShell.tsx` `NAV_ITEMS`: after Users, add `{ to: "/media-list-names", label: "Media list names", show: (s) => s.has("Core.Admin") },`. Update the doc comment: "Users, Media list names and the error log are Core.Admin only."

- [ ] **Step 5: Run; expect PASS** (`apps/nrms/src/http/routes.test.ts apps/staff-web/src/screens/admin apps/staff-web/src/shell`). Type-check both projects.

- [ ] **Step 6: Commit**

```bash
git add apps/nrms/src/http apps/staff-web
git commit -m "feat(staff-web,nrms): Media list names screen for Core Admins"
```

---

### Task 8: End to end, docs and verification

**Files:**
- Create: `tests/e2e/subscribers-admin.spec.ts`.
- Modify:
  - `docs/parity/changes-from-legacy.md`, `docs/parity/open-questions.md`;
  - `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`;
  - `docs/superpowers/plans/phase-4-carry-forward.md`;
  - `docs/superpowers/specs/2026-10-05-nod-distribution-parity-design.md` (§2 table only).

**Interfaces:**
- Consumes: `signInAs`, `ROLE_LOGINS`, `apiCall`, `baseUrl`, `tick`, `expectNoSeriousA11yViolations`, `settleModalTransition` (`playwright-support.ts`).

- [ ] **Step 1: Write the e2e spec**

```ts
// NoD parity spec §8 (Lists & categories, Media lists, Operations) and §10 items 10 and 14,
// end to end through the stack, with axe on every screen and dialog. Specs run serially against
// one stack (playwright.config.ts workers: 1); every test that changes shared state restores it.
import { test, expect } from "@playwright/test";
import { apiCall, baseUrl, expectNoSeriousA11yViolations, ROLE_LOGINS, settleModalTransition, signInAs, tick } from "./playwright-support";

const unique = (label: string) => `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;

/** Creates an NRMS media list (tolerating 409) and ticks until NoD has mirrored it. */
async function ensureMirroredMediaList(adminCookie: string, key: string, displayName: string): Promise<void> {
  const res = await fetch(`${baseUrl()}/nrms/api/media-lists`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-GCPE-Request": "1", cookie: adminCookie },
    body: JSON.stringify({ key, displayName }),
  });
  if (res.status !== 201 && res.status !== 409) throw new Error(`media list creation failed: ${res.status}`);
  const start = Date.now();
  for (;;) {
    await tick();
    const lists = await apiCall<{ key: string; active: boolean }[]>(adminCookie, "/nod/api/media-lists");
    if (lists.some((l) => l.key === key && l.active)) return;
    if (Date.now() - start > 10_000) throw new Error(`media list ${key} never reached NoD`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

test.describe("Lists and categories", () => {
  test("an Admin stops offering a list and it leaves the choices; a Viewer sees counts only", async ({ page, context }) => {
    const admin = await ROLE_LOGINS.admin();
    await signInAs(context, "admin");
    await page.goto(`${baseUrl()}/hub/subscribers/lists`);
    await expect(page.getByRole("heading", { level: 1, name: "Lists and categories" })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "lists and categories (admin)");
    try {
      await page.getByRole("checkbox", { name: "Offer Emergency Info BC Alerts" }).uncheck();
      await expect(page.getByRole("status")).toHaveText("Emergency Info BC Alerts is no longer offered.");
      const options = await apiCall<{ categories: { lists: { listKey: string }[] }[] }>(admin, "/nod/api/subscriber-list-options");
      expect(options.categories.flatMap((c) => c.lists.map((l) => l.listKey))).not.toContain("emergency:alerts");
    } finally {
      await apiCall(admin, "/nod/api/lists/emergency%3Aalerts", { method: "PUT", body: { enabled: true } });
    }
    const viewer = await ROLE_LOGINS.nodViewer();
    await expect(apiCall(viewer, "/nod/api/lists/emergency%3Aalerts", { method: "PUT", body: { enabled: false } })).rejects.toThrow(/403/);
  });
});

test.describe("Media lists", () => {
  test("an Editor adds by hand and from Media Hub, then removes with confirmation; a Viewer reads only", async ({ page, context }) => {
    const admin = await ROLE_LOGINS.admin();
    const key = `e2e-4g-${Date.now()}`;
    await ensureMirroredMediaList(admin, key, "E2E 4g list");
    const email = unique("media-manual");

    await signInAs(context, "nodEditor");
    await page.goto(`${baseUrl()}/hub/subscribers/media-lists`);
    await expectNoSeriousA11yViolations(page, "media lists");
    await page.getByRole("link", { name: "E2E 4g list" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Media list" })).toBeVisible();

    await page.getByRole("textbox", { name: "Email address" }).fill(email);
    await page.getByRole("button", { name: "Add to list" }).click();
    await expect(page.getByRole("status")).toHaveText("Added to the list.");
    await expect(page.getByRole("link", { name: email })).toBeVisible();

    await page.getByRole("textbox", { name: "Name, email or outlet" }).fill("");
    await page.getByRole("button", { name: "Search Media Hub" }).click();
    const firstAdd = page.getByRole("button", { name: /^Add .+@/ }).first();
    await expect(firstAdd).toBeVisible();
    await firstAdd.click();
    await expect(page.getByRole("status")).toHaveText("Added to the list.");
    await expectNoSeriousA11yViolations(page, "media list (editor)");

    await page.getByRole("button", { name: `Remove ${email}` }).click();
    await settleModalTransition(page);
    await expectNoSeriousA11yViolations(page, "remove member dialog");
    await page.getByRole("button", { name: "Confirm remove" }).click();
    await expect(page.getByRole("status")).toHaveText("Removed from the list.");
    await expect(page.getByRole("link", { name: email })).toHaveCount(0);

    await context.clearCookies();
    await signInAs(context, "nodViewer");
    await page.goto(`${baseUrl()}/hub/subscribers/media-lists/${key}`);
    await expect(page.getByRole("table", { name: "Members" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Email address" })).toHaveCount(0);
  });
});

test.describe("Operations (item 10 by hand, item 14 by role)", () => {
  test("an Admin pauses and resumes NoD with confirmation, sets the summary address, and sees the test upload", async ({ page, context }) => {
    const admin = await ROLE_LOGINS.admin();
    await signInAs(context, "admin");
    await page.goto(`${baseUrl()}/hub/subscribers/operations`);
    await expectNoSeriousA11yViolations(page, "operations");
    try {
      await page.getByRole("button", { name: "Pause News On Demand sending" }).click();
      await settleModalTransition(page);
      await expectNoSeriousA11yViolations(page, "pause dialog");
      await page.getByRole("button", { name: "Confirm pause" }).click();
      await expect(page.getByRole("status")).toHaveText("News On Demand sending paused.");
      await page.getByRole("button", { name: "Resume News On Demand sending" }).click();
      await page.getByRole("button", { name: "Confirm resume" }).click();
      await expect(page.getByRole("status")).toHaveText("News On Demand sending resumed.");
    } finally {
      await apiCall(admin, "/nod/api/settings/resume", { method: "POST" });
    }
    try {
      await page.getByRole("textbox", { name: "Bounce summary email" }).fill("ops-summary@example.test");
      await page.getByRole("button", { name: "Save address" }).click();
      await expect(page.getByRole("status")).toHaveText("Bounce summary address saved.");
      await page.getByRole("button", { name: "Use the server default" }).click();
      await expect(page.getByText("Using the server default.")).toBeVisible();
    } finally {
      await apiCall(admin, "/nod/api/operations/bounce-summary-address", { method: "PUT", body: { address: null } });
    }
    await expect(page.getByRole("region", { name: "Test bounce upload" })).toBeVisible();
  });

  test("a NoD Editor doesn't get Operations, and the server refuses them", async ({ page, context }) => {
    await signInAs(context, "nodEditor");
    await page.goto(`${baseUrl()}/hub/subscribers`);
    await expect(page.getByRole("link", { name: "Operations" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Media lists" })).toBeVisible();
    const editor = await ROLE_LOGINS.nodEditor();
    await expect(apiCall(editor, "/nod/api/operations")).rejects.toThrow(/403/);
  });
});
```

Check two details against the stack:
- The e2e Distribution's `BOUNCE_SOURCE` defaults to `fake`; `bounces.spec.ts` uploads through it. If it doesn't, drop the upload assertion and note why.
- The admin test user's display name, if a check needs one. Read `tests/e2e/constants.ts`.

- [ ] **Step 2: Run the new spec; expect FAIL until it's right, then PASS**

Run: `npx -y -p node@24 -- npm run test:e2e -- tests/e2e/subscribers-admin.spec.ts tests/e2e/media-lists.spec.ts`. Fix selector mismatches against the real screens, never by weakening a role or consent assertion.

- [ ] **Step 3: Docs**

**`docs/parity/changes-from-legacy.md`.** Add rows to the "NoD and Distribution (Phase 4)" table, using the next free numbers (C92 onward at planning time; re-check first). Status "Agreed" unless noted.

| # | Legacy | New | Why | Status |
|---|---|---|---|---|
| C92 | Lists are edited (renamed) and deleted in NoD (`EditList.aspx`, `ManageLists.aspx.cs` delete). | Names come from Core (ministries, sectors, themes, tags) or NRMS (media lists) and are read-only in NoD. Staff instead switch a list or category off ("not offered"). That hides it from the public and staff choices, but existing subscribers keep it and still receive its releases. | One source of truth for names; switching off never silently drops anyone's subscription. | Proposed (Q36) |
| C93 | List order is NoD's own `SlotNumber`, moved Up/Down per list; media lists can't be edited in NoD. | Staff order lists within a category, and that order survives Core's updates; a list Core adds later goes at the end. Media-list order, names and active state are set in NRMS (Media list names, Core Admin). Category order affects the staff screens only. | Core and NRMS keep owning their data, while staff keep control of what subscribers see. | Agreed |
| C94 | The bounce summary goes to a hard-coded address (`BounceManager.cs`, Carolynn.Hunter@gov.bc.ca). | NoD Admins set it on Operations. The server's `NOD_BOUNCE_SUMMARY_EMAIL` is the default when none is set. Changes are logged without the address. | Staff changes shouldn't need a deploy. | Agreed |
| C95 | N/A: legacy has no media-member flags. | Clearing a media member's "bouncing" flag restarts their bounce count, as staff reactivation does (C84). | Staff clear it because the mailbox is fixed; old bounces shouldn't re-flag at once. | Agreed |
| C96 | N/A: legacy can't show who left a media list. | Each media list shows who left it by unsubscribing (most recent 200), and whether they're back on it. Re-adding someone who unsubscribed always asks first and shows when they left. | Staff can answer "why isn't this reporter getting our releases?" without guessing, and never override an opt-out by accident. | Agreed |
| C97 | Distribution Suspend/Resume is two-step; As It Happens/Digest have status lights but no pause. | Operations pauses and resumes both NoD sending and Distribution, each behind a confirmation, each emailing the operations inbox. If Distribution is unreachable, the screen says so and NoD's own controls still work. | Parity, plus the NoD pause spec §5.1 added. | Agreed |

**`docs/parity/open-questions.md`, Open.** Add (next free numbers; Q35 onward at planning time):
- **Q35**, "Can Media Hub's contact search accept the term in a POST body?"
  - Why it matters: NoD's own routes keep search terms out of URLs, but the Media Hub contract (spec §5.3) is `GET /api/service/contacts?q=`, so the term lands in Media Hub's access logs.
  - Working assumption: keep the GET until the Media Hub repo implements the contract; propose `POST /api/service/contacts/search` there.
- **Q36**, "When a list is switched off, should its existing subscribers stop receiving it?"
  - Why it matters: legacy deleted lists; we keep subscriptions so nothing is lost silently.
  - Working assumption: no. Switching off only stops new subscriptions.
- **Q37**, "Who may export subscriber email addresses (4h reports)?"
  - Why it matters: exports leave the system.
  - Working assumption: NoD Editors and Admins export address-bearing CSVs; NoD Viewers see reports on screen and export count-only CSVs.

**`docs/manuals/running-notes.md`, Phase 4 block.** Add:
- **Administrator**: "Lists and categories" (Subscribers) shows each list's active subscribers. NoD Admins can stop offering a list or a whole category (existing subscribers keep it and still get its releases) and set the order the public sees. Names come from Core, and media lists from NRMS.
- **Administrator**: "Media list names" (Core Admins) adds, renames, orders and retires media lists. Retiring stops releases going to a list but keeps its members. Changes reach News On Demand within a minute.
- **Editor**: Media lists: add a reporter from Media Hub (choose which of their emails) or type an address for someone not in Media Hub. If they unsubscribed, you'll be asked to confirm, and you'll see when they left; add them only if they've asked to come back.
- **Editor**: A flagged member shows why. "Bouncing": clear it once the mailbox works, and their bounce count starts again. A Media Hub email problem: pick another of their emails, or clear the flag.
- **Viewer**: Each media list shows who left it by unsubscribing, and whether they're back on it.
- **Operations**: Operations (NoD Admins) pauses and resumes News On Demand sending and Distribution. Each asks first and emails the operations inbox. Pausing holds email; nothing is dropped. The bounce summary address is set here; clearing it goes back to the server default.
- **Operations**: On test sites, Operations has a "Test bounce upload" for a `.eml` bounce message. Bounce processing picks it up within 15 minutes.
- **Developer**: A route that binds an address or a search term uses `privateErrorsWith` (`apps/nod/src/http/private-errors.ts`), and search terms go in POST bodies, never URLs.

**`docs/deploy/siteground.md`.** Add hand-checks:
- as the admin, open Subscribers → Operations;
- confirm the Test bounce upload panel shows on boxs.ca;
- pause and resume NoD, and confirm the ops email arrives at the redirect address;
- as `nod-editor`, add and remove a media-list member from the fake Media Hub.

**`docs/superpowers/plans/phase-4-carry-forward.md`:**
- Delete the four lines this plan closes from "4g (staff screens…)": the NRMS media-list screen, the NoD member screens, the opt-out view, and the `NoD.Editor` opening.
- Rename the section to `## 4h (reports)` and keep its reports line.
- Rename `## 4g (retention/purge)` to `## 4i (emergency feed, retention purge, importer)`, and add to it: "Purge on/off switch and next-run preview on Operations (deferred from 4g, Ruling R2)."

**Spec §2 table** (`2026-10-05-nod-distribution-parity-design.md`): replace the 4g row with three rows. Change nothing else in the spec.

| Sub | What | Main check |
|---|---|---|
| 4g | Staff Lists & categories, Media lists screens, Operations (§8) | Role e2e, axe, list-choice survival tests |
| 4h | Staff Reports with CSV export (§8) | Report and CSV tests |
| 4i | Emergency RSS ingester, retention purge, legacy NoD importer (§9) | Purge and importer tests |

- [ ] **Step 4: Full verification**

- Both type-checks.
- Full vitest: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run`.
- Full e2e: `npx -y -p node@24 -- npm run test:e2e`.
- `grep -rn "media-hub/contacts?" apps tests` returns nothing.

Record the passed/skipped counts in the commit body and compare them with 4f's final run (vitest 2542, e2e 57 passed / 1 skipped). Any drop is a regression to fix.

- [ ] **Step 5: Commit and push**

```bash
git add tests/e2e/subscribers-admin.spec.ts docs
git commit -m "feat(e2e,docs): Phase 4g lists, media lists and operations end to end; parity and running notes"
git push -u origin feat/phase-4g
```

The controller deploys to boxs.ca after the final review.

---

## Rulings (decided while Paul was asleep, flagged for review)

- **R1. Split: 4g = Lists & categories + Media lists + Operations; 4h = Reports; the old emergency/purge/importer sub-plan becomes 4i.** Reports alone need five queries, CSV streaming, injection-safe encoding, an export role rule and new `deliveries`/`messages` indexes. Folded in, this plan would run 12+ tasks.
  - *Cost if wrong:* none to the code; only plan bookkeeping.
- **R2. The purge on/off switch and its next-run preview are deferred to 4i, with the purge.** Acceptance item 12 ("purge removes exactly the rows its preview counted") is only testable when one selection function feeds both. A switch for a purge that doesn't exist would show staff a control that does nothing.
  - *Cost if wrong:* a small Operations panel added in 4i. The screen leaves room for it.
- **R3. Switching a list or category off stops new subscriptions only.** Existing subscriptions are kept and still sent, and both preference forms keep a held, no-longer-offered list. This matches how the existing `list_categories.enabled` already behaves, and it never drops anyone silently (C92, Q36).
  - *Cost if wrong:* add `l.enabled` to the matching queries.
- **R4. List order is a staff override (`lists.staff_sort_order`) that Core events never touch.** Lists Core adds later go at the end, and media-list order stays in NRMS. Category order is NoD's but only affects staff screens: the public API is per-category.
  - *Cost if wrong:* drop the override and order by Core's `sort_order`.
- **R5. Lists & categories writes are `NoD.Admin` only** (spec §8: "Admin: … Operations and categories"). Toggles and moves apply at once with no dialog: they're reversible and nothing is sent or dropped.
- **R6. Subscriber counts are active subscribers only.** "All news" is shown separately.
- **R7. Media lists: `NoD.Viewer` reads** (lists, members, opt-outs, sync status). Add/remove/resolve/search/sync are `NoD.Editor`+. Spec §8 gives Viewer "lists" and Editor "media lists". Viewers can already search every subscriber, so member addresses are no new exposure.
- **R8. Media Hub search moves to `POST /media-hub/contacts/search`; the GET is removed, not deprecated** (the only callers were staff-web-to-be, the stack test and an e2e). NoD's outbound call to Media Hub's own contract stays a GET (spec §5.3), raised as Q35.
- **R9. Resolving a flag takes the address lock** (the no-ref path didn't). Clearing "bouncing" restarts the bounce window, under a new history action, `bounce-resolved` (C95).
- **R10. The media routes move to their own router with private error handling.** They bind addresses, and the old routes sent unexpected errors to `jsonErrorHandler`, which logs bound params. Media Hub errors now log kind and status only.
- **R11. The opt-out view shows the most recent 200 opt-out events per list**, with "back on the list". Indexed on `subscriber_history (action, detail, at)`.
- **R12. The member list isn't paged.** Media lists hold hundreds, and legacy showed all.
  - *Cost if wrong:* add paging to one route and one table.
- **R13. The bounce summary address is a stored setting; `NOD_BOUNCE_SUMMARY_EMAIL` becomes its default.** Clearing returns to the default. Staff can't turn the summary off while a server default exists; legacy always sent. `operations_log` records "set"/"cleared", never the address.
- **R14. The test bounce upload shows only when Distribution reports `source: "fake"`.** NRMS's `isTestSite` flag isn't used. Distribution's 404 outside fake mode stays the authority.
- **R15. Operations is `NoD.Admin` for reading too.** Both pauses ask for confirmation in both directions; legacy confirmed Distribution's.
- **R16. Media list names live at `/hub/media-list-names` for `Core.Admin`,** the role NRMS's media-list admin already requires. NRMS's `GET /media-lists` opens to `Core.Admin`. Media lists link to it for Core Admins.
- **R17. CSV export roles (for 4h): address-bearing exports are `NoD.Editor`/`NoD.Admin`.** `NoD.Viewer` gets on-screen reports and count-only CSVs (Q37). Viewers can read addresses on screen, but an export leaves the system in bulk.
- **R18. The media-list detail screen's h1/title is the static "Media list"**, with the list name below. Same reasoning as 4f's R11 (no async titles).
- **R19. NoD refuses edits to the media category and media lists (409 `managed-in-nrms`)**, as legacy refused them in `ManageLists`.

## Self-review notes (for the reviewer)

- **Spec §8 coverage:**
  - Lists & categories:
    - enable/disable: Tasks 2, 4;
    - order: Tasks 2, 4;
    - subscriber counts: Tasks 2, 4;
    - names read-only from Core/NRMS: Tasks 2, 4, 7.
  - Media lists:
    - members per list: Tasks 1, 5;
    - add from Media Hub, choosing the email: Tasks 1, 5;
    - add manually, remove: Task 5;
    - needs-attention flags including bouncing, with resolve: Tasks 1, 5;
    - last sync time and result: Task 5.
  - Operations:
    - NoD and Distribution pause/resume: Task 6, on existing routes;
    - bounce summary address: Tasks 3, 6;
    - fake bounce upload: Tasks 3, 6;
    - purge: deferred (R2).
  - Roles: Tasks 1-3 (server), 4-7 (UI), 8 (e2e).
  - Reports: 4h (R1).
- **Carry-forward coverage** (the 4g staff-screens section):
  - NRMS media-list screen: Task 7;
  - NoD member screens: Tasks 1, 5;
  - opt-out view: Tasks 1, 5;
  - `NoD.Editor` opening: Task 1;
  - the reports line moves to 4h;
  - the retention items move to 4i (Task 8 docs).
- **Constraints:**
  - search term never in a URL: Task 1 (route + test), Task 5 (UI test);
  - no address in logs: Task 1 (search failure), Task 3 (ops log, Distribution failure);
  - locking: Task 1 (resolve lock test);
  - staff fields survive events: Task 2.
- **Types used across tasks:**
  - `privateErrorsWith`: Task 1 → Tasks 2, 3.
  - `NOD_ADMIN_ROLES`: Task 2 → Task 3.
  - `writeOpsLog(…, detail)`: Task 2 → Task 3.
  - `MediaMember.mediaHubEmailRef`/`attentionAt` and `MediaListSummary.needsAttention`: Task 1 → Task 4 types → Task 5.
  - `OperationsStatus`: Task 3 → Task 4 types → Task 6.
  - `SettingsRouteDeps.bounceSummaryFallback` / `AppDeps.bounceSummaryFallback`: Task 3 only.
- **Planner caveats:**
  - The staff-web row-name regexes depend on how the accessible name concatenates cell text; adjust whitespace, not intent.
  - BC design-system `Button` props are used as 4f used them (`variant="secondary"`, `danger`, `isDisabled`, `onPress`).
  - The stack test (Task 1) runs only where the full stack does.
