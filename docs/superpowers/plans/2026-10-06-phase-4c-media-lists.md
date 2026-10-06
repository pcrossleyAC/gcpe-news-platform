# Phase 4c: Media Lists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff-curated media distribution lists. NRMS owns list names and keys and announces them. NoD mirrors them and holds the members: Media Hub contacts with a chosen email, or manual addresses. A release marked "to media lists" goes to each member once, in full text. Media Hub's Membership tab keeps working against NoD.

**Architecture:**
- **NRMS:** gains a small media-list admin API and emits `media_list.*` events (outbox). NoD mirrors them into `lists` under the existing `media-distribution-lists` category.
- **Membership model:** a member is a subscription row on the shared, email-unique `subscribers` table. Media memberships are invisible to the public Subscribe journeys and survive them.
- **Media Hub:** a contract client in NoD talks to Media Hub's (future) service API. A fake package implements that contract on the stack and in tests. A nightly sync reconciles members from the change feed.
- **Media sends:** a new `media` send kind on 4b's sending model. One email per recipient, priority `media`. The full text comes from NRMS in the release event. There is no manage or unsubscribe link (legacy parity).

**Tech Stack:** Node 24, TypeScript, Express 5, Drizzle ORM + drizzle-kit, Postgres, zod, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-05-nod-distribution-parity-design.md` §3, §5.3–5.5, §10 items 6–8 (approved).

**Base:** branch `feat/phase-4c`, worktree `/Users/paul/gcpe-news-platform-4c`, created from `feat/phase-4b` @ `e1b2137` (PR #6, not yet merged). 4c is a stacked PR on #6.

**Research notes** (code facts with file:line, gathered 2026-10-06):
- `.superpowers/research-4c.md` (git-ignored). Highlights are repeated where a task needs them.
- Legacy references:
  - `~/HUB/Subscribe/Gcpe.NewsOnDemand.Library/Legacy/NodTask.cs:199-310,351-422` (media send);
  - `~/HUB/Subscribe/Gcpe.NewsOnDemand.Website.Services/Controllers/SubscribeController.cs` (`SubscriberInformation`);
  - `~/HUB/Subscribe/Gcpe.NewsOnDemand.Library/SubscriberInfo.cs` (response model);
  - `~/media-hub-app/server/routes.ts:7397-7509` (Membership tab caller);
  - `~/media-hub-app/database/shared/schema.ts:310-412` (contacts, workplaces).

## Global Constraints

- **Worktree and commits:**
  - Work in `/Users/paul/gcpe-news-platform-4c`, branch `feat/phase-4c`.
  - Commit locally after each task.
  - Never add a `Co-Authored-By` trailer or any AI attribution. Never commit `CLAUDE.md`.
  - Don't label code comments with task or review-round numbers.
- **Node 24 for everything.**
  - Tests: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run <paths>`. A path filter is a substring match.
  - Type-check: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json` and `… -p apps/staff-web/tsconfig.json`.
  - E2E: `npx -y -p node@24 -- npm run test:e2e`.
- **Migrations:**
  - Generate with drizzle-kit: `cd apps/<app> && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name <name>`.
  - Data-copy migrations use `--custom`. Never hand-edit generated DDL.
  - Every migration must be safe on boxs.ca's existing 4b data.
- **Clocks:** every "now" comparison uses the database clock (`now()`). The nightly sync's "is it due" uses the tenant time zone via `@gcpe/config` (Node's tzdata), like the digest.
- **List keys:**
  - A media list's NoD list key is `media-distribution-lists:<key>`, lowercased, where `<key>` is NRMS `media_lists.key`.
  - Media list keys never appear in public Subscribe responses or the public topic line.
  - "All news" (`*`) never matches a media key.
- **Members:**
  - A member is a `subscriptions` row whose list key is in the `media-distribution-lists` category, on the email-unique `subscribers` row for that address.
  - Adding a member never sends a verification email (C51) and never changes the subscriber's public timing flags.
  - Staff-added media subscribers are `active` at once.
- **Public journeys never touch media memberships:**
  - `infoFor` omits them.
  - `update()` replaces only non-media subscriptions.
  - Public unsubscribe (link or one-click) of a subscriber who has media memberships ends their public subscriptions, clears `as_it_happens`/`digest` and writes history. It keeps the media memberships and the subscriber `active`.
- **Media emails (legacy `NodTask.cs`):**
  - **Subject:** `BC Gov News - <title>`; for an advisory (`postKind = 'advisories'`), just `<title>`. Never empty: fall back to the item key. Keep 4b's subject sanitising (998 UTF-16 units, no split surrogate pair).
  - **Body layout:**
    - no banner and no footer;
    - BC Sans font stack at 18px;
    - the full text as paragraphs;
    - then "▶ READ MORE" (bold blue link to the release), omitted for advisories;
    - then the grey topic line, alphabetical, excluding media lists.
  - **Advisory reminder:** in an advisory whose text has the line `MEDIA ADVISORY - EVENT REMINDER`, drop the lines that follow it up to the next blank line.
  - **Priority:** `media`. One recipient per Distribution message.
  - **No links:** no `{{manageUrl}}`, no `{{unsubscribeUrl}}`, no `List-Unsubscribe` header (C63).
- **One copy per person per release:**
  - At most one `media` delivery per (item, subscriber), enforced by the deliveries primary key.
  - A subscriber who gets the media version of a release does not also get it As-It-Happens (legacy `NodTask.cs:230`).
  - Media sends are created before As-It-Happens sends for the same release, in the same transaction.
- **Media Hub contract** (spec §5.3, amended: each email gets a stable `ref`). Service token: Entra client credentials, else a local token (`serviceTokenProvider`).
  - `GET /api/service/contacts?q=&page=&pageSize=` → `{ contacts: Contact[], page, pageSize, total }`.
  - `GET /api/service/contacts/:id` → `Contact` (including soft-deleted), or 404.
  - `GET /api/service/contacts/changes?since=<ISO>&cursor=` → `{ contacts: Contact[], nextCursor: string | null }`.
  - `Contact = { id: number, firstName, lastName, outlet: string | null, emails: { ref: string, address: string, kind: "personal" | "workplace", organization: string | null, preferred: boolean }[], deletedAt: string | null }`.
  - `ref` is `"personal"` or `"workplace:<workplaceId>"`.
- **Membership endpoint (C55):**
  - Route: `GET /Subscribe/SubscriberInformation?emailAddress=<email>`, served by NoD (stack path `/nod/Subscribe/SubscriberInformation`).
  - Auth: HTTP Basic against `MEMBERSHIP_API_USERNAME` and `MEMBERSHIP_API_PASSWORD_HASH` (scrypt; never a plain password).
  - Response is legacy `SubscriberInfo` JSON with PascalCase keys.
- **Logs:** no email addresses, tokens, passwords or secrets in logs. Errors go through `safeErrorLabel` (`apps/nod/src/subscribe/journeys.ts`).
- **Roles:**
  - NRMS media-list admin: `Core.Admin`.
  - NoD media-list member admin, Media Hub search, sync controls: `NoD.Admin` (4f adds `NoD.Editor`).
  - NRMS's media contact count calls NoD's existing `GET /api/subscribers/count`.

## Review Focus

1. **A journalist who is also a public subscriber** clicks "Unsubscribe" in an As-It-Happens email. Their public lists end, but they stay on the media lists and keep getting media releases. Pinned in Task 2 ("public unsubscribe keeps media memberships").
2. **A release goes to a media list and also matches that journalist's public As-It-Happens topics.** They get one email, the full-text media version. Pinned in Task 5 ("media member gets one copy").
3. **A Media Hub contact's chosen workplace email changes to an address that already belongs to another NoD subscriber.** The member is flagged "needs attention" and nothing is merged or lost. Pinned in Task 4 ("email change collides").
4. **The nightly sync runs twice, or the stack ticks twice in the same minute.** One sync, the cursor advances once, no double history rows. Pinned in Task 4 ("concurrent syncs").
5. **Media Hub calls the membership endpoint with wrong credentials, or for an unknown email.** Wrong credentials get 401 with a `WWW-Authenticate` header and nothing about the address. An unknown email gets 200 with empty categories, so the tab shows "no lists" rather than an error. Pinned in Task 6.

---

## Pre-flight (controller, before Task 1)

- Commit Paul's legacy survey workbooks already filed at `docs/parity/legacy-survey/results/Hub/*.xlsx`, with the README note. Message: `docs(parity): legacy Hub survey results (reference, NRMS, Calendar)`.
- Check `results/` for a `NewsOnDemand`/`06` workbook before Task 2. If one exists, read its media-list sheets (list keys, member counts, the `media-subscription-services` category) and adjust Task 2/6 rulings in the ledger.

---

### Task 1: NRMS media-list admin API and `media_list.*` events

**Files:**
- Modify:
  - `packages/events/src/catalogue.ts` (+ its test);
  - `apps/nrms/src/http/routes.ts`;
  - `apps/nrms/src/import/reference.ts`;
  - `apps/stack/src/env.ts` (NRMS→NoD route types);
  - `apps/stack/src/env.test.ts`.
- Create: `apps/nrms/src/media-lists.ts`, `apps/nrms/src/media-lists.test.ts`.

**Interfaces:**
- Produces:
  - `mediaListRecordSchema = z.object({ key: z.string().min(1), displayName: z.string().min(1), sortOrder: z.number().int(), isActive: z.boolean() })`; `type MediaListRecord`.
  - Event types `media_list.created` (data: `MediaListRecord`), `media_list.updated` (data: `MediaListRecord`), `media_list.deactivated` (data: `{ key: string }`), registered in `eventDataSchemas`.
  - `apps/nrms/src/media-lists.ts`:
    - `createMediaList(db: Db, input: { key: string; displayName: string; sortOrder?: number }, subscribers: EventSubscriber[]): Promise<MediaListRecord>` emits `media_list.created`.
    - `updateMediaList(db, key, input: { displayName?: string; sortOrder?: number; isActive?: boolean }, subscribers)` emits `media_list.updated`, or `media_list.deactivated` when `isActive` goes true→false.
    - `republishMediaLists(db, subscribers): Promise<number>` emits `media_list.updated` for every row, active or not; returns the count.
  - Routes (`Core.Admin`):
    - `POST /api/media-lists` → 201 record; 409 if the key exists;
    - `PUT /api/media-lists/:key` → 200 record; 404 if unknown;
    - `POST /api/media-lists/republish` → `{ count }`.
  - The existing `GET /api/media-lists` is unchanged.

Rules:
- Key: `^[a-z0-9][a-z0-9-]*$`, ≤ 100 chars, immutable after create. Legacy slugs like `001-a-daily-news` fit.
- Each write and its event go in one transaction via `enqueueEvent(tx, { type, source: "nrms", aggregateId: \`media-list:${key}\`, data }, subscribers)`. Follow `apps/nrms/src/publisher.ts:96`.
- The importer's media-list upsert (`import/reference.ts:184-195`) emits `media_list.updated` for each upserted row in the same transaction, so an import reaches NoD.
- Stack: add `"media_list.created", "media_list.updated", "media_list.deactivated"` to the NRMS→NOD route's `types` in `INTERNAL_EVENT_ROUTES`.
- The staff-web screen for media lists is not in 4c (4f carry-forward, Task 8).

- [ ] **Step 1: Write the failing tests**
  - `catalogue` test: each `media_list.*` type parses a valid envelope and rejects a missing key.
  - `media-lists.test.ts`, against the NRMS test DB:
    - create emits one `media_list.created` outbox row with the record;
    - a duplicate key gives 409 via the route;
    - update of `displayName` emits `media_list.updated`;
    - `isActive: false` emits `media_list.deactivated`;
    - republish emits one event per row;
    - the routes give 401 without a token and 403 without `Core.Admin`.
  - `env.test.ts`: the NRMS→NOD route includes the three types.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `packages/events apps/nrms apps/stack`. Expect PASS.
- [ ] **Step 5: Commit** — `feat(nrms,events): media-list admin API and media_list.* events`

---

### Task 2: NoD mirrors media lists; member model; public journeys leave media memberships alone

**Files:**
- Modify:
  - `apps/nod/src/db/schema.ts` (+ generated migration);
  - `apps/nod/src/lists.ts` (+ test);
  - `apps/nod/src/subscribe/info.ts`;
  - `apps/nod/src/subscribe/journeys.ts` (+ tests);
  - `apps/nod/src/app.ts`;
  - `apps/nod/src/http/routes.ts` (+ test).
- Create: `apps/nod/src/media-members.ts`, `apps/nod/src/media-members.test.ts`.

**Interfaces:**
- Consumes: `media_list.*` events (Task 1).
- Produces:
  - `MEDIA_CATEGORY = "media-distribution-lists"`; `mediaListKey(key: string): string`.
  - Schema additions on `subscribers`:
    - `needsAttention: text("needs_attention")`: a short reason; null = fine.
    - `attentionAt: timestamp("attention_at", { withTimezone: true })`.
    - `mediaHubEmailRef: text("media_hub_email_ref")`: the chosen email's contract `ref`.
  - `media-members.ts`:
    - `addMediaMember(db: Db, listKey: string, input: { email: string; source: "media-hub" | "manual-media"; mediaHubContactId?: number; mediaHubEmailRef?: string }, actor: string): Promise<{ subscriberId: string; created: boolean }>`.
    - `removeMediaMember(db, listKey, subscriberId, actor): Promise<boolean>`.
    - `listMediaMembers(db, listKey): Promise<{ subscriberId: string; email: string; source: string; mediaHubContactId: number | null; needsAttention: string | null }[]>`.
    - `hasMediaMemberships(tx, subscriberId): Promise<boolean>`.
  - Routes (`NoD.Admin`):
    - `GET /api/media-lists` → `[{ listKey, key, name, active, members }]`;
    - `GET /api/media-lists/:key/members`;
    - `POST /api/media-lists/:key/members` (body `{ email }` → manual) → 201/200 `{ subscriberId, created }`. Task 3 adds the Media Hub body;
    - `DELETE /api/media-lists/:key/members/:subscriberId` → 204.

Rules:
- **Mirror:**
  - `media_list.created`/`updated` → `upsertList(tx, MEDIA_CATEGORY, key, displayName, sortOrder, isActive)`.
  - `media_list.deactivated` → `deactivate(tx, MEDIA_CATEGORY, key)`.
  - Add a test that re-activating a deactivated list works (4a carry-forward).
  - A deactivated media list keeps its members but sends nothing (Task 5 checks `lists.active`).
- **Add member** (in a transaction):
  - Lowercase the email. Find the subscriber by email, or insert one: `status 'active'`, the given `source`, `as_it_happens false`, `digest false`, `media_hub_contact_id`/`media_hub_email_ref` as given, and a new unsubscribe token as 4a's create path makes one.
  - If found: set `status 'active'` when it was `pending`/`deleted`/`disabled`. Set `media_hub_contact_id`/`media_hub_email_ref` when given. Leave `source`, timing flags and public subscriptions unchanged. Clear `ended_at`.
  - Insert the subscription `ON CONFLICT DO NOTHING`.
  - Write `subscriber_history` (`actor`, action `media-list-added`, detail the list key).
  - The list must exist in the `media-distribution-lists` category, else 404.
- **Remove member:**
  - Delete the subscription and write history `media-list-removed`.
  - If the subscriber's `source` is `media-hub` or `manual-media` and no subscriptions remain, end them the way 4a's unsubscribe does (`status 'deleted'`, `ended_at = now()`, history).
- **Public journeys (4a carry-forward):**
  - `infoFor` skips list keys in the media category.
  - `update()` replaces only non-media subscriptions. Change `replaceSubscriptions` to delete `WHERE subscriber_id = $1 AND list_key NOT LIKE 'media-distribution-lists:%'`.
  - `unsubscribe()`/`endSubscriber()`: if `hasMediaMemberships`, delete non-media subscriptions and set `as_it_happens = false, digest = false`. Keep `status` and `ended_at` unchanged, write history `unsubscribed-public-only`, and return the same success. Otherwise the existing behaviour stands.
  - Change-email (4a) moves media memberships with the subscriber row as today. It's one row, so nothing to change; pin it with a test.

- [ ] **Step 1: Write the failing tests**
  - `lists.test.ts`:
    - `media_list.created` creates `media-distribution-lists:<key>`, active;
    - deactivate then `updated` with `isActive: true` re-activates.
  - `media-members.test.ts`:
    - add to a new address creates an active `manual-media` subscriber with no timing flags and no verification email (the distribution fake gets no calls);
    - add to an existing self subscriber keeps `source 'self'`, timing and public lists;
    - adding twice is idempotent (`created: false`, one subscription);
    - remove the last membership of a `manual-media` subscriber → `deleted`;
    - remove from a self subscriber → only the subscription goes.
  - `journeys.test.ts` (**public unsubscribe keeps media memberships**): a self subscriber with `ministries:health` and a media membership unsubscribes by token → status `active`, timing flags false, only the media subscription left, history `unsubscribed-public-only`.
  - `journeys.test.ts`: `update()` with new public prefs keeps the media subscription.
  - `journeys.test.ts`: `infoFor` omits the media key.
  - `routes.test.ts`: 401/403 checks and response shapes for the four routes; 404 for an unknown media list.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement**, including the drizzle-kit migration for the three subscriber columns.
- [ ] **Step 4: Run** `apps/nod`. Expect PASS.
- [ ] **Step 5: Commit** — `feat(nod): mirror media lists; media members; public journeys leave media memberships alone`

---

### Task 3: Media Hub contract client and fake; add a member from Media Hub

**Files:**
- Create:
  - `packages/media-hub-fake/` (`package.json` `@gcpe/media-hub-fake`, `src/index.ts`, `src/contacts.ts`, `src/index.test.ts`), shaped like `@gcpe/flickr-fake`;
  - `apps/nod/src/media-hub/contract.ts` (zod schemas + types);
  - `apps/nod/src/media-hub/client.ts` (+ test).
- Modify:
  - `apps/nod/src/start.ts` (env);
  - `apps/nod/src/app.ts`;
  - `apps/nod/src/http/routes.ts` (+ test);
  - `apps/stack/src/env.ts`, `apps/stack/src/stack.ts` (mount the fake, NoD default URL) + tests;
  - root `package.json` workspaces if packages aren't globbed.

**Interfaces:**
- Produces:
  - `contract.ts`: `contactSchema`, `contactPageSchema`, `changesPageSchema` exactly as in Global Constraints; types `MediaHubContact`, `MediaHubEmail`.
  - `client.ts`:
    - `interface MediaHubClient { search(q: string, page: number, pageSize: number): Promise<ContactPage>; get(id: number): Promise<MediaHubContact | null>; changes(since: string, cursor: string | null): Promise<ChangesPage> }`.
    - `mediaHubClient({ baseUrl, getToken, timeoutMs, fetchImpl? }): MediaHubClient`.
    - Responses are validated with the zod schemas; a schema mismatch throws `MediaHubError("contract")`.
  - NoD env: `MEDIA_HUB_URL` (optional; unset → search/add-from-hub return 503 `{ error: "media hub not configured" }`, manual entry still works), `MEDIA_HUB_TOKEN_URL`, `MEDIA_HUB_CLIENT_ID`, `MEDIA_HUB_CLIENT_SECRET`, `MEDIA_HUB_SCOPE`, `MEDIA_HUB_TIMEOUT_MS` (default 15000).
    - Token: `serviceTokenProvider({ …, local: auth.local, subject: "nod", roles: ["MediaHub.ContactsRead"], envPrefix: "NOD_MEDIA_HUB" })`.
  - Routes (`NoD.Admin`):
    - `GET /api/media-hub/contacts?q=&page=` proxies `search` (pageSize 25);
    - `POST /api/media-lists/:key/members` also accepts `{ mediaHubContactId: number, emailRef: string }`. It loads the contact with `get`, and 404s if missing, deleted, or the ref isn't among its emails. It then calls `addMediaMember` with `source 'media-hub'` and that email's address.
  - Fake (`@gcpe/media-hub-fake`):
    - `createFakeMediaHub({ statePath?: string, seed?: number, contactCount?: number }) → { router, controls }`.
    - Default 60 generated contacts, deterministic for a seed. Each has a personal email and 1–2 workplace emails (one `preferred`). 5 are soft-deleted. Every address is under `example.test`, with no real data.
    - Service routes require a bearer token with role `MediaHub.ContactsRead`, verified with the stack's bearer verifier.
    - Control routes under `/__fake` (stack gates them with `Core.Admin`, like fake Flickr):
      - `POST /__fake/contacts/:id/email {ref, address}` changes an address and bumps `updatedAt`;
      - `POST /__fake/contacts/:id/remove-email {ref}`;
      - `POST /__fake/contacts/:id/delete`;
      - `POST /__fake/reset`.
    - `changes` returns contacts with `updatedAt > since`, ordered by (updatedAt, id), pages of 100 with an opaque cursor.
    - State persists to `statePath` (JSON) when given.
  - Stack: mount at `FAKE_MEDIA_HUB_PATH = "/fake-media-hub"` when `NOD_MEDIA_HUB_URL` is unset. Add `STACK_APP_DEFAULTS.NOD.MEDIA_HUB_URL = "self:/fake-media-hub"` only in that case. Log a `[stack] MEDIA HUB: using the FAKE …` warning like Flickr's. State goes in `<dataDir>/fake-media-hub-state.json`.

- [ ] **Step 1: Write the failing tests**
  - `packages/media-hub-fake/src/index.test.ts`:
    - search by part of a name and by outlet;
    - paging totals;
    - `get` returns a deleted contact with `deletedAt`;
    - `changes` after an email change returns that contact once and then nothing;
    - 401 without a token, 403 without the role.
  - `client.test.ts`: against the fake's router on an ephemeral server:
    - search/get/changes round-trip;
    - a contract-violating response (missing `emails`) throws `MediaHubError`;
    - a timeout throws.
  - `routes.test.ts`:
    - add from Media Hub stores `media_hub_contact_id` and `media_hub_email_ref` and uses that email's address;
    - an unknown ref → 404;
    - with `MEDIA_HUB_URL` unset → 503 for search and add-from-hub, while manual add still works.
  - Stack tests: the fake is mounted only when `NOD_MEDIA_HUB_URL` is unset, and NoD's default points at it.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `packages/media-hub-fake apps/nod apps/stack`. Expect PASS.
- [ ] **Step 5: Commit** — `feat(nod,stack): Media Hub contacts contract, client and fake; add members from Media Hub`

---

### Task 4: Nightly Media Hub sync and "needs attention"

**Files:**
- Create: `apps/nod/src/media-hub/sync.ts`, `apps/nod/src/media-hub/sync.test.ts`.
- Modify:
  - `apps/nod/src/db/schema.ts` (+ migration: `nod_settings` sync columns);
  - `apps/nod/src/start.ts` (worker + loop);
  - `apps/stack/src/stack.ts` (tick step) + test;
  - `apps/nod/src/http/routes.ts` (+ test).

**Interfaces:**
- Consumes: `MediaHubClient` (Task 3), `media-members.ts` (Task 2).
- Produces:
  - `nod_settings` columns: `mediaSyncSince: timestamp`, `mediaSyncAt: timestamp`, `mediaSyncResult: jsonb`.
  - `MEDIA_SYNC_HOUR = 2`. Due once per BC day at or after 02:00, computed like `digestCutoff` (reuse its helper with the hour as a parameter, or a sibling `dailyCutoff(dbNow, timeZone, hour)`).
  - `runMediaSyncIfDue(db, client, timeZone): Promise<{ ran: boolean; result?: SyncResult }>`.
  - `runMediaSync(db, client): Promise<SyncResult>` with `SyncResult = { contacts: number; updated: number; flagged: number; removed: number; errors: number }`.
  - Worker `mediaSync`; tick step `{ name: "nod.media-sync", run: worker(nod, "mediaSync") }` placed before `nod.digest`. `startLoops` gets the same once-a-minute check as the digest loop.
  - Routes (`NoD.Admin`):
    - `GET /api/media-hub/sync` → `{ since, at, result }`;
    - `POST /api/media-hub/sync` → runs `runMediaSync` now, returns the result;
    - `POST /api/media-members/:subscriberId/resolve` with body `{ emailRef?: string }`. Re-points to a new ref (loaded with `get`), or with no body just clears the flag. Writes history.

Rules:
- **Concurrency:** `runMediaSyncIfDue` and `runMediaSync` take `SELECT … FROM nod_settings WHERE id = 1 FOR UPDATE` first. A second concurrent run waits, then sees `mediaSyncAt` already in today's window and returns `ran: false`.
- **Feed:** page through `changes(since = mediaSyncSince ?? '1970-01-01T00:00:00Z', cursor)` until `nextCursor` is null. Record the run's start (database `now()`) as the new `mediaSyncSince` only after the whole feed is processed.
- For each changed contact, for every subscriber with `media_hub_contact_id = contact.id` and at least one media subscription:
  - **Deleted contact** (`deletedAt` set): remove every media membership (`removeMediaMember`, actor `media-hub-sync`).
  - **Chosen email changed:** the chosen ref is present with a new address.
    - If no other subscriber has the new address: update `subscribers.email`, rotate the unsubscribe token as 4a's email change does, and write history `media-hub-email-changed`. The detail is the ref, never the addresses.
    - If another subscriber has it (**email change collides**): set `needs_attention = 'email-taken'` and `attention_at = now()`, change nothing else, and write history.
  - **Chosen email gone** (ref not present): set `needs_attention = 'email-gone'` and keep the member (C59).
  - **Unchanged:** if `needs_attention` was `email-gone` and the ref is back, clear it.
- **Errors:** one contact's error is counted in `errors` and logged via `safeErrorLabel` with the contact id, and doesn't stop the run. A client or contract error aborts the run without advancing `mediaSyncSince`, and records `{ error: safeErrorLabel(e) }` as the result.

- [ ] **Step 1: Write the failing tests** (`sync.test.ts`, the fake client from Task 3 on an ephemeral server):
  - **Email change:** fake changes the chosen workplace address → after a sync the member's subscriber email is updated, the unsubscribe version is bumped, and history is written.
  - **Email change collides:** the new address already belongs to another subscriber → flagged `email-taken`, emails unchanged.
  - **Email gone:** the fake removes the chosen ref → flagged `email-gone`, still a member.
  - **Contact deleted:** memberships removed; a `media-hub` subscriber with nothing left becomes `deleted`.
  - **Concurrent syncs:** `Promise.all([runMediaSyncIfDue(...), runMediaSyncIfDue(...)])` → exactly one `ran: true`; `mediaSyncSince` set once; one history row per change.
  - **Abort:** a contract error leaves `mediaSyncSince` unchanged and records the error result.
  - **Due:** at 01:59 BC, not due; at 02:00, due once.
  - `routes.test.ts`: `resolve` with a valid new ref re-points and clears the flag; 401/403.
  - `stack.test.ts`: the tick order has `nod.media-sync` before `nod.digest`.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `apps/nod apps/stack`. Expect PASS.
- [ ] **Step 5: Commit** — `feat(nod): nightly Media Hub sync with needs-attention flags`

---

### Task 5: Media-list sends

**Files:**
- Modify:
  - `packages/events/src/catalogue.ts` (`mediaText`);
  - `apps/nrms/src/releases/record.ts` and/or `apps/nrms/src/publisher.ts`;
  - `apps/nod/src/db/schema.ts` (+ migration: `items.media_text`, `items.media_list_keys`);
  - `apps/nod/src/items.ts` (+ test);
  - `apps/nod/src/as-it-happens.ts` (+ test);
  - `apps/nod/src/render.ts` (+ test);
  - `apps/nod/src/send-jobs.ts` (+ test).
- Create: `apps/nod/src/media-send.ts`, `apps/nod/src/media-send.test.ts`.

**Interfaces:**
- Consumes:
  - `renderText(v, opts)` (`apps/nrms/src/renditions/text.ts`);
  - `createItemSend` and its cancelled-job replacement (4b);
  - `MEDIA_CATEGORY`, `mediaListKey` (Task 2).
- Produces:
  - `releaseRecordSchema` gains `mediaText: z.string().nullable().default(null)`. The default keeps older stored envelopes and importer replays valid. NRMS fills it with `renderText(view, renditionOptions)` when `publishFlags.toMediaLists` is true, else null, for `release.published` and `release.updated`.
  - `items` gains `mediaText: text("media_text")` and `mediaListKeys: text("media_list_keys").array().notNull().default([])`, holding `media-distribution-lists:<key>` from `mediaListKeys`.
    - `itemFromRelease` fills both, but only when `toMediaLists`.
    - `refreshReleaseItem` (`release.updated`) refreshes both. It never sends.
  - `renderMedia(item: RenderItem & { mediaText: string; postKind: string | null }, opts: RenderOptions): Rendered` in `render.ts`, per Global Constraints:
    - text → escape HTML, normalise CRLF to LF, split on blank lines into `<p>`, single newlines become `<br>`;
    - the text part is the media text, then `Read more: <url>` (non-advisory), then the categories line.
  - `createMediaSend(tx: Tx, itemKey: string, render: RenderOptions): Promise<boolean>`:
    - skip if the item is withdrawn, `mediaText` is null or `mediaListKeys` is empty;
    - recipients: distinct `active` subscribers with a subscription in an **active** list among `mediaListKeys`;
    - `jobKey: \`media:${key}\``, `kind 'media'`, `priority 'media'`, rendered once;
    - `deliveries` mode `media`, inserted set-based;
    - same `ON CONFLICT (job_key) DO NOTHING` and cancelled-job replacement as `createItemSend`;
    - if there are no recipients, delete the job and return false.
  - `app.ts` `onPublished` becomes `createMediaSend` then `createItemSend(…, "as_it_happens")` in the same transaction.
  - `createItemSend("as_it_happens")` also excludes subscribers with a `media` delivery for the item.
  - Sender, for `kind = 'media'` jobs:
    - no `recipientSubstitutions` call, no per-recipient substitutions, and no `List-Unsubscribe`/`List-Unsubscribe-Post` headers;
    - withdrawn-item cancellation works as for item jobs (it has `item_key`).
  - **Byte-size probe fix** (4c carry-forward): `partitionChunkByBytes` probes with placeholder substitutions as long as the real ones.
    - For jobs that use links: `{ manageUrl: "x".repeat(MANAGE_URL_LEN), unsubscribeUrl: "x".repeat(UNSUBSCRIBE_URL_LEN) }`, with the lengths computed from the actual `RecipientLinkOptions` and fixed token lengths.
    - For media jobs: `{}`.

- [ ] **Step 1: Write the failing tests**
  - `catalogue` test: a record without `mediaText` parses with `null`.
  - NRMS publisher test: with `toMediaLists` the event's `mediaText` equals `renderText(...)` for that release; without it, null.
  - `render.test.ts` (`renderMedia`):
    - no banner, no footer, no `{{manageUrl}}`/`{{unsubscribeUrl}}`;
    - full text paragraphs;
    - READ MORE present for a release, absent for an advisory;
    - advisory subject is the bare title, release subject `BC Gov News - <title>`;
    - the `MEDIA ADVISORY - EVENT REMINDER` rule drops the following headline lines;
    - the topic line excludes media lists;
    - the text is HTML-escaped.
  - `media-send.test.ts`:
    - members of two selected lists (one member on both) → one `media` delivery each;
    - a member of a deactivated list gets nothing;
    - a non-member public subscriber gets nothing from the media job;
    - `toMediaLists` false → no job;
    - second `release.published` → nothing new;
    - **media member gets one copy:** a member who is also a matching As-It-Happens subscriber gets a `media` delivery and no `as_it_happens` delivery;
    - withdraw → the pending media job is removed;
    - republish → a fresh job that skips already-attempted recipients.
  - `send-jobs.test.ts`:
    - a media job's request has priority `media`, no `List-Unsubscribe` header, empty substitutions, and makes no `subscriber_links` rows;
    - the byte probe with real link lengths splits a part that the old empty-substitution probe would have kept whole (construct html near `maxChunkBytes`).
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `packages/events apps/nrms apps/nod tests/e2e/thin-slice.test.ts`. Expect PASS.
- [ ] **Step 5: Commit** — `feat(nod,nrms,events): media-list sends with full text; byte probe counts per-recipient links`

---

### Task 6: Legacy membership endpoint (Basic Auth)

**Files:**
- Create:
  - `apps/nod/src/http/membership.ts`, `apps/nod/src/http/membership.test.ts`;
  - `scripts/hash-membership-password.ts`.
- Modify: `apps/nod/src/start.ts` (env), `apps/nod/src/app.ts`, `package.json` (script `nod:membership-hash`).

**Interfaces:**
- Produces:
  - Env `MEMBERSHIP_API_USERNAME` and `MEMBERSHIP_API_PASSWORD_HASH`, both optional. If either is unset the route returns 503 `{ error: "membership endpoint not configured" }`.
  - Hash format: `scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>` (N=16384, r=8, p=1, 32-byte key), produced by `npm run nod:membership-hash` (prompts without echo, prints the string).
  - `GET /Subscribe/SubscriberInformation?emailAddress=<email>`, mounted on NoD's app root (stack: `/nod/Subscribe/SubscriberInformation`).
    - Bad or missing credentials → 401 with `WWW-Authenticate: Basic realm="NoD"`, body `{ error: "unauthorized" }`. Compare the username and the scrypt result with `timingSafeEqual`.
    - Failed auth is rate-limited per IP: 10/minute, then 429.
    - Missing or invalid `emailAddress` → 400.
  - Response 200, legacy `SubscriberInfo`:

```json
{
  "EmailAddress": "<as stored, or as given if unknown>",
  "SubscribedCategories": { "<category>": ["<list key>", "..."] },
  "IsAllNews": false,
  "IsAsItHappens": false,
  "IsDailyDigest": false,
  "IsAdminRegistration": false,
  "NotifyIfNewCategories": false,
  "ExpiredLinkOrUnverifiedEmail": false
}
```

Rules:
- `SubscribedCategories` includes every category the subscriber has, media lists included. This is a staff-facing service endpoint, unlike public `infoFor`. Only subscribers with `status` `active` or `disabled` count.
- `IsAllNews` is true when the subscriber has `*`. `IsAsItHappens`/`IsDailyDigest` come from the timing flags. `IsAdminRegistration` is true when `source` is not `self`.
- **Unknown email** → 200 with `SubscribedCategories: {}` and all flags false. Media Hub reads `data.SubscribedCategories || {}` and shows "no lists".
- The endpoint never logs the email address.
- `media-subscription-services` exists in legacy Media Hub reads but not in NoD. It is omitted; Media Hub defaults it to `[]` (Q30).

- [ ] **Step 1: Write the failing tests** (`membership.test.ts`)
  - Correct credentials + a member of `media-distribution-lists:001-a-daily` and `tags:x` → 200 with both categories and PascalCase keys.
  - Wrong password → 401 with `WWW-Authenticate`. No header → 401. The 11th bad attempt in a minute → 429.
  - Unknown email → 200 with empty categories.
  - Env unset → 503.
  - The hash script's format round-trips through the verifier.
  - Media Hub's parser (`/^(\d{3})-(\d|[a-z])-(.+)$/` on the list keys) is satisfied by a legacy-style key.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `apps/nod`. Expect PASS.
- [ ] **Step 5: Commit** — `feat(nod): legacy SubscriberInformation endpoint for Media Hub (Basic Auth, hashed)`

---

### Task 7: NRMS media contact count

**Files:**
- Modify:
  - `apps/nrms/src/releases/workflow.ts` (+ test);
  - `apps/nrms/src/start.ts`;
  - wherever `subscriberCount`'s result is surfaced (follow it through `schedule()` and the view/history it writes);
  - the staff-web component that shows the subscriber count, if it shows it (+ test).

**Interfaces:**
- Consumes: NoD `GET /api/subscribers/count?lists=` (roles include `NoD.SubscriberCount`).
- Produces:
  - `WorkflowDeps.countMediaContacts?: (listKeys: string[]) => Promise<number>`, wired in `start.ts` to the same NoD client as `countSubscribers`. It passes `media-distribution-lists:<key>` keys.
  - `mediaContactCount(v, deps)`, a sibling of `subscriberCount`. It runs only for a first publish with `publishOptions.toMediaLists` and media lists selected. It is best effort, and null on error.
  - Its result is recorded and shown exactly where `subscriberCount` is ("~N media contacts" beside "~N subscribers"). It is also written to the release's `media_subscribers` column at publish, matching the legacy column the importer fills.

- [ ] **Step 1: Write the failing tests**
  - Workflow test: with `toMediaLists` and two media lists, `countMediaContacts` is called with the two prefixed keys and the result is recorded.
  - Without `toMediaLists` it is not called.
  - An error gives null, not a failure.
  - If staff-web shows the subscriber count: a component test shows the media count beside it.
- [ ] **Step 2–4:** Fail, implement, pass (`apps/nrms apps/staff-web`).
- [ ] **Step 5: Commit** — `feat(nrms): media contact count from NoD at schedule time`

---

### Task 8: End to end, docs and verification

**Files:**
- Create: `tests/e2e/media-lists.spec.ts`.
- Modify:
  - `tests/e2e/global-setup.ts` and `tests/e2e/playwright-support.ts` (helpers);
  - `docs/parity/changes-from-legacy.md`, `docs/parity/open-questions.md`;
  - `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`;
  - `docs/superpowers/plans/phase-4-carry-forward.md`;
  - `README.md` (NoD env table).

**E2E** (`media-lists.spec.ts`, acceptance 6–8). Use the admin cookie helper, and `waitForMessageTo` with exact subject and recipient.
1. **Media send:**
   - `POST /nrms/api/media-lists` creates `"0e2-a-e2e-desk"`; tick until NoD has `media-distribution-lists:0e2-a-e2e-desk`.
   - Add a manual member through `POST /nod/api/media-lists/0e2-a-e2e-desk/members`.
   - Publish a release with `toMediaLists` and that list, then tick.
   - Exactly one email `BC Gov News - <headline>` to the member. Its text contains the release body. It has no `list-unsubscribe` header and no `/subscribe/manage/` link.
   - Repeat with an advisory: the subject is the bare title and there's no READ MORE.
2. **Media Hub member and sync:**
   - Add a member from the fake: search `GET /nod/api/media-hub/contacts?q=…`, then add with a workplace ref.
   - `POST /fake-media-hub/__fake/contacts/:id/email` changes that ref's address. `POST /nod/api/media-hub/sync` updates the member's email.
   - Delete the contact in the fake and sync again: the member is gone.
3. **Membership endpoint:** with e2e `MEMBERSHIP_API_*` set in global-setup (hash produced in setup), `GET /nod/Subscribe/SubscriberInformation?emailAddress=<member>` with Basic Auth returns `SubscribedCategories["media-distribution-lists"]` containing the key.

**Docs:**
- **`changes-from-legacy.md`** (after the last C row):
  - **C63:** media-list emails carry no manage or unsubscribe link and no `List-Unsubscribe` header, as in legacy. Journalists ask staff to be removed.
  - **C64:** a public unsubscribe by someone also on media lists ends only their public subscriptions. Legacy deleted the whole subscriber.
  - **C65:** the Media Hub contract gives each email a stable `ref`, so the sync can tell "changed" from "gone".
  - **C66:** NRMS holds media list names and keys with an admin API and events. Legacy keys were hand-matched in the Hub (extends C47).
- **`open-questions.md`:**
  - **Q29:** may media-list emails go out without one-click unsubscribe under Gmail/Yahoo bulk-sender rules and CASL? Working assumption: they're requested press distribution, as legacy treated them.
  - **Q30:** does `media-subscription-services` exist in legacy NoD? Is it needed?
  - Close **Q27**: the path is pinned as `Subscribe/SubscriberInformation?emailAddress=`, served at `/nod/Subscribe/…` on the stack. Media Hub's `NOD_API_URL` must be set to that.
- **Running notes, Phase 4:**
  - **Editor:** media lists and their members, how media emails look, "needs attention".
  - **Operations:** `MEMBERSHIP_API_*`, the `nod:membership-hash` script, `MEDIA_HUB_*` and the fake.
- **`siteground.md`:** hand-check items 6 (media send), 7 (Media Hub member + sync on the fake) and 8 (membership call with curl and Basic Auth).
- **Carry-forward:**
  - delete the done 4c items;
  - move "NRMS staff-web media-list screen" and "NoD media-list member screens" into 4f;
  - keep the 4g purge item.
- **README:** NoD env rows `MEDIA_HUB_*`, `MEMBERSHIP_API_USERNAME`, `MEMBERSHIP_API_PASSWORD_HASH`.

**Verification:** both type-checks, the full vitest suite, `npm run test:e2e` (previous 49 passed / 1 skipped, plus 3). Record the counts. Commit and `git push -u origin feat/phase-4c`. The controller deploys after the final review.

- [ ] **Step 1:** Write `media-lists.spec.ts`; run it and expect FAIL until the setup and helpers exist; fix.
- [ ] **Step 2:** Docs as above.
- [ ] **Step 3:** Full verification; record the counts.
- [ ] **Step 4: Commit and push** — `feat(e2e,docs): media lists end to end; Phase 4c docs`

---

## Self-review notes (for the reviewer)

- **Spec coverage:**
  - §5.3 NRMS names/keys + events: Task 1. Mirror and members: Task 2. Contract, fake and add-from-hub: Task 3. Sync and the three cases: Task 4.
  - §5.4 full-text sends, priority 40, never grouped, advisory rules, one copy: Task 5. NRMS media contact count: Task 7.
  - §5.5 membership endpoint with hashed Basic credentials, Q27 pinned: Task 6.
  - §10 items 6, 7 and 8: Task 8 e2e.
  - Carry-forward 4c (`infoFor`, `update`, public unsubscribe, `upsertList` reactivation, byte probe): Tasks 2 and 5.
- **Rulings:**
  - **Shared subscriber row.** The spec says a member "is a subscriber with source media-hub/manual-media", but `subscribers.email` is unique, so a journalist who also self-subscribed is one row. `source` records who created the row. Membership is the media subscription. *Cost if wrong:* a separate members table later — Tasks 2 and 4 only.
  - **No unsubscribe in media emails** (C63, Q29). This is legacy parity and matches the real media-list sample (`docs/parity/samples/media-list-as-it-happens-2026-09-21.md`). *Cost if wrong:* add the header later. Task 5's sender branch is the one place.
  - **Media version replaces As-It-Happens** for the same release and person (legacy `NodTask.cs:230`). *Cost if wrong:* that person gets both.
  - **Advisory reminder rule** follows the legacy code: it keeps the `MEDIA ADVISORY - EVENT REMINDER` line and drops the headline after it. The spec's wording ("is stripped") is loose; the code is the authority for parity. *Cost if wrong:* one line differs.
  - **`mediaText` in the release event,** filled by NRMS only for media releases, because NoD can't run NRMS's `renderText` on a `ReleaseView`. Legacy did the same (Hub pushed `TextContent` only for media). *Cost if wrong:* a larger event for media releases.
  - **Contract `ref`** added to each email (C65). Media Hub hasn't built the API yet, so it costs nothing now.
  - **NRMS media-list admin is API-only in 4c.** The screen moves to 4f, and existing lists arrive through the importer and `republish`. *Cost if wrong:* staff need a screen sooner.
  - **Membership endpoint on NoD directly** (`/nod/Subscribe/SubscriberInformation`), not through the News API proxy. The proxy replaces `Authorization` with its own service token, and Basic Auth must reach NoD. *Cost if wrong:* Media Hub's `NOD_API_URL` changes once.
