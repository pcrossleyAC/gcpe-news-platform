# Phase 4e: Bounces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Distribution reads bounce messages every 15 minutes from a bounce source: Microsoft Graph in production, a fake inbox on test sites. It parses them (RFC 3464 first, legacy heuristic as fallback), matches them to the exact message by `Message-ID`, and tells the sending app with a `delivery.bounced` event.
- NoD records hard bounces against deliveries. It disables a subscriber whose last 10 deliveries in 15 days all hard-bounced; media-list members are flagged instead.
- NoD sends a daily bounce summary.

**Architecture:**
- **Distribution:**
  - A `BounceSource` interface (`fetchNew`/`markProcessed`) with fake and Graph implementations.
  - A pure parser and matcher; a `bounces` table recording every processed bounce.
  - Bounce events go through the existing outbox tables, already in Distribution's DB but unused, delivered to NoD on a new stack route.
- **NoD:**
  - Records the Distribution batch id on each delivery when the part is sent, so a bounce maps back to the delivery.
  - Applies the 10-in-15-days rule in the event handler, and sends the summary from its own records.

**Tech Stack:** Node 24, TypeScript, Express 5, Drizzle ORM + drizzle-kit, Postgres, zod, mailparser (becomes a runtime dependency of Distribution), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-05-nod-distribution-parity-design.md` §7 and §10 item 9 (approved).

**Base:** branch `feat/phase-4e`, worktree `/Users/paul/gcpe-news-platform-4e`, from `feat/phase-4d` @ `0bf2c6e`. PR #8 is merged, so the PR targets `main` directly.

**Context:**
- Research notes with file:line refs: `.superpowers/research-4e.md` (git-ignored).
- **Legacy references:**
  - `~/HUB/Subscribe/.../BounceManager.cs` (EWS reader, regexes at :60-67, summary at :187-218);
  - `DistributionProvider.cs:385-526` (matching, the 10-in-15-days rule; production `NumDaysToBounce = 15`; it sets `IsDeleted` and `IsEnabled = false`; media-list members are only bolded in the summary);
  - `Global.asax.cs:168-175` (Sunday/Wednesday noon schedule).
- The legacy survey shows `hard_bounced_total = 0` over 365 days. Legacy's subject-based matching almost never matched. Expect real numbers once ours runs.
- SiteGround is a test environment only. Every email there is redirected, so no real bounces happen; boxs.ca uses the fake inbox.

## Global Constraints

- **Worktree and commits:**
  - Work in `/Users/paul/gcpe-news-platform-4e`, branch `feat/phase-4e`. Commit locally after each task.
  - Never add `Co-Authored-By`/AI attribution. Never commit `CLAUDE.md`.
  - Don't label code comments with task or review-round numbers.
- **Node 24 for everything.**
  - Tests: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run <paths>`.
  - Type-checks: `… typescript/bin/tsc -p tsconfig.json` and `-p apps/staff-web/tsconfig.json`.
  - E2E: `npx -y -p node@24 -- npm run test:e2e`.
  - Show each new test failing before implementing (a real RED run).
- **Migrations:** drizzle-kit generated; `--custom` for data. Never hand-edit DDL. Safe on boxs.ca's existing data.
- **Clocks:** the database clock (`now()`) everywhere. The "every 15 minutes" gate and the daily summary time use DB `now()`; the summary's local time uses the tenant zone via `@gcpe/config` (`dailyCutoff`).
- **Bounce source (spec §7):**
  - Interface: `fetchNew(limit: number): Promise<{ id: string; raw: string }[]>` and `markProcessed(ids: string[]): Promise<void>`.
  - `BOUNCE_SOURCE=fake|graph`, default `fake`. Startup refuses `graph` without all of `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `BOUNCE_MAILBOX`.
  - Graph is built and unit-tested against recorded responses only, and not run live until Q23 is answered.
- **Schedule:** every 15 minutes from the tick (C54). Self-gated by `distribution_settings.bounces_checked_at <= now() - interval '15 minutes'`. Concurrent runs → one, by the settings row lock.
- **Parsing:**
  1. RFC 3464 first: a `multipart/report; report-type=delivery-status` gives `Final-Recipient` (else `Original-Recipient`), `Status`, and the original `Message-ID` from the attached `message/rfc822` or `text/rfc822-headers` part.
  2. Fallback: the legacy heuristic.
     - Subject starts with `Undeliverable:`.
     - Recipient = the first email address in the body.
     - Code = the first match of `[#;\s]([45]\d{2})` or `[#;\s]([45]\.\d{1,3}\.\d{1,3})` (legacy `BounceManager.cs:60-67`).
  - A status or code starting with `5` is **hard**; anything else is **soft**.
  - Anything that isn't recognisably a bounce is recorded as `ignored`.
  - **Every** fetched message is marked processed, as legacy did, so nothing is re-read forever.
- **Matching:**
  1. By `messages.message_id`.
  2. Fallback, if there's no Message-ID or it isn't found: the most recent `sent` message to that recipient (case-insensitive) within 4 days.
  - An unmatched bounce is recorded with `matched = false` and emits nothing.
  - The recipient reported downstream is the message's intended recipient (`messages.email`), never the redirect address.
- **Event:**
  - `delivery.bounced { appId, batchId, messageId, email, hard, status, at }`, emitted through Distribution's outbox in the same transaction as the bounce row.
  - Routed DIST → NOD only, and only for the app that sent the message: `appId` must match the receiver's app name.
  - Idempotent at the receiver.
- **NoD threshold (spec §7, legacy `DistributionProvider.cs:465-506`):**
  - On a hard bounce, mark the matching delivery `hard_bounced_at`.
  - Then, if the subscriber's last 10 attempted deliveries within 15 days are **all** hard-bounced, act:
    - **Not a media-list member:** set `status = 'disabled'`, write history `bounce-disabled` (detail: `10/<days>d`), and stop sending.
    - **A media-list member:** set `needs_attention = 'bouncing'` and keep `status` (C59).
  - Soft bounces are recorded and never count.
- **"disabled" defined** (4a/4e carry-forward):
  - Bounce- or staff-disabled. Receives nothing: sends already select `status = 'active'`.
  - Kept, not purged.
  - Shown as a member by the membership endpoint (as built in 4c).
  - The person can reactivate themselves through public subscribe → confirm: the verification email reaching them proves the mailbox works again. That's 4a's existing behaviour, now intended.
- **Summary email (spec §7):**
  - Daily at 08:00 BC time, only if there were bounces since the last summary.
  - To `BOUNCE_SUMMARY_EMAIL` (NoD env; `NOD_BOUNCE_SUMMARY_EMAIL` on the stack). Unset → no summary.
  - Subject `News On Demand - Bounce Manager - <YYYY-MM-DD>`. System priority.
  - **Body:** one line per bounced subscriber in the window: the address, hard/soft and status code, and the outcome (`recorded (n/Nd)`, `disabled (10/Nd)`, `flagged — media list member`). Media-list members appear in bold, as legacy did. Then counts of unmatched and ignored messages.
  - The summary recipient is staff, so addresses may appear in the email body. They never appear in logs.
- **Logs:** no addresses, tokens or secrets in logs or `last_error`. The raw bounce message is stored in the DB (it's evidence) but never logged.
- **Roles:**
  - Distribution's fake-inbox upload: `Distribution.Operate`.
  - NoD's proxy upload route: `NoD.Admin`, and only when Distribution reports `BOUNCE_SOURCE=fake`.

## Review Focus

1. **A bounce for a message sent to a redirected address on a test site.** It matches the message by `Message-ID` and reports the intended recipient, not the redirect mailbox. Pinned in Task 1 ("redirected message reports the intended recipient").
2. **The same bounce delivered twice** (outbox retry), or the same `.eml` uploaded twice. One `hard_bounced_at`, one threshold evaluation, no double history. Pinned in Tasks 1 and 4.
3. **A journalist's media-list address bounces 10 times.** Flagged "needs attention", not disabled. They keep their media lists, and the summary shows them in bold. Pinned in Task 4.
4. **A disabled subscriber subscribes again from the public page.** Verify → confirm reactivates them, and the next release reaches them. Pinned in Task 4.
5. **Two bounce runs racing** (tick + loop) inside the same 15 minutes. One run fetches; nothing is processed twice. Pinned in Task 2.

---

### Task 1: Distribution bounce parser, store and matcher

**Files:**
- Create: `apps/distribution/src/bounces/parse.ts` (+ test, with `.eml` fixtures under `apps/distribution/test/fixtures/bounces/`), `apps/distribution/src/bounces/store.ts` (+ test).
- Modify: `apps/distribution/src/db/schema.ts` (+ migration), `apps/distribution/package.json` (mailparser → dependencies).

**Interfaces:**
- Produces:
  - `parseBounce(raw: string): Promise<ParsedBounce>`, where `ParsedBounce = { kind: "bounce"; recipient: string; status: string; hard: boolean; originalMessageId: string | null; method: "rfc3464" | "heuristic" } | { kind: "ignored"; reason: string }`.
  - Table `bounces`: `id uuid`, `source_id text` (unique per source), `received_at`, `raw text`, `kind` (`bounce`/`ignored`), `recipient`, `status`, `hard bool`, `method`, `message_id uuid null` (FK messages), `matched bool`, `processed_at`.
  - Columns on `messages`: `bounced_at timestamptz null`, `bounce_status text null`, `bounce_hard bool null`.
  - `recordBounce(tx, sourceId, raw, parsed): Promise<{ bounceId: string; matched: { messageId: string; batchId: string; appId: string; email: string } | null; duplicate: boolean }>`:
    - A duplicate `source_id` → `duplicate: true`, nothing else.
    - Otherwise match per Global Constraints and set the message's bounce columns. For an existing hard bounce, never overwrite `bounced_at`.
- Fixtures (no real addresses; `example.test` only):
  - an Exchange NDR (multipart/report with `message/delivery-status` and `text/rfc822-headers`);
  - a Gmail-style DSN;
  - a 4.x.x delay notice (soft);
  - a legacy-style "Undeliverable:" plain message with a `550 5.1.1` code and no Message-ID;
  - an auto-reply (ignored);
  - a malformed message (ignored, no throw).

- [ ] **Step 1: Write the failing tests**
  - `parse.test.ts`:
    - each fixture's expected `ParsedBounce`;
    - `5.1.1` → hard, `4.4.7` → soft;
    - the heuristic picks the first body address and the first code;
    - never throws.
  - `store.test.ts`:
    - match by Message-ID;
    - the fallback by recipient within 4 days, picking the most recent;
    - none older than 4 days;
    - unmatched recorded with `matched = false`;
    - **redirected message reports the intended recipient**: `messages.email`, with `original_recipient` set;
    - a duplicate `source_id` → `duplicate: true` and no changes;
    - a soft bounce after a hard one keeps the hard.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement**, including the migration.
- [ ] **Step 4: Run** `apps/distribution`. Expect PASS.
- [ ] **Step 5: Commit** — `feat(distribution): bounce parser (RFC 3464 + legacy heuristic), bounce store and matcher`

---

### Task 2: Bounce sources and the 15-minute processing step

**Files:**
- Create:
  - `apps/distribution/src/bounces/source.ts` (interface + fake), `apps/distribution/src/bounces/graph.ts` (+ test with recorded JSON under `apps/distribution/test/fixtures/graph/`);
  - `apps/distribution/src/bounces/run.ts` (+ test).
- Modify:
  - `apps/distribution/src/db/schema.ts` (+ migration: `bounce_inbox` table; `distribution_settings.bounces_checked_at`);
  - `apps/distribution/src/env.ts` (+ test), `apps/distribution/src/start.ts`, `apps/distribution/src/http/routes.ts` (+ test);
  - `apps/stack/src/stack.ts` (+ test).

**Interfaces:**
- Produces:
  - `BounceSource` (Global Constraints).
  - `fakeBounceSource(db)` reads `bounce_inbox (id uuid, raw text, received_at, processed_at)` rows where `processed_at IS NULL`.
  - `graphBounceSource({ tenantId, clientId, clientSecret, mailbox, fetchImpl? })`:
    - Client-credentials token via `packages/auth`'s client-credentials provider (scope `https://graph.microsoft.com/.default`).
    - `fetchNew` lists unread messages in the mailbox's Inbox (`/users/{mailbox}/mailFolders/inbox/messages?$filter=isRead eq false&$top=…`) and downloads each MIME (`/messages/{id}/$value`).
    - `markProcessed` sets `isRead = true` and moves the message to a `Processed` folder (created if missing). Legacy deleted messages; we keep them, which is safer.
  - `runBouncesIfDue(db, source, opts): Promise<{ ran: boolean; fetched: number; bounces: number; matched: number; ignored: number }>`:
    - In a short transaction, lock the settings row, check the 15-minute gate, set `bounces_checked_at = now()`, commit.
    - Then fetch (≤ 200), parse and `recordBounce` each in its own transaction, then `markProcessed`.
    - Per-message errors are counted and don't stop the run.
  - Worker `bounces`. Tick step `{ name: "distribution.bounces", run: worker(distribution, "bounces") }` after `distribution.send`. `startLoops` runs it once a minute; it self-gates.
  - Route (`Distribution.Operate`): `POST /api/bounces/inbox`, body `{ raw: string }` (≤ 1 MB). Only when `BOUNCE_SOURCE=fake`, else 404. Responds `201 { id }`. Also `GET /api/bounces/source` → `{ source: "fake" | "graph" }`.
  - Env: `BOUNCE_SOURCE`, `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `BOUNCE_MAILBOX`.

- [ ] **Step 1: Write the failing tests**
  - Fake source round trip.
  - `graph.test.ts`, against recorded responses:
    - list → MIME download → mark read and move;
    - the folder is created when missing;
    - a 401 throws a typed error with no token in its message.
  - `run.test.ts`:
    - not due within 15 minutes;
    - due after;
    - **two racing runs → one fetches**;
    - a bad message is counted and the rest proceed;
    - everything fetched is marked processed.
  - Routes: 401/403/404 (graph mode), 201.
  - Env: `graph` without credentials fails startup.
  - Stack: the tick order includes `distribution.bounces`.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `apps/distribution apps/stack`. Expect PASS.
- [ ] **Step 5: Commit** — `feat(distribution): bounce sources (fake inbox, Graph) and a 15-minute bounce run`

---

### Task 3: `delivery.bounced` events from Distribution to NoD

**Files:**
- Modify:
  - `packages/events/src/catalogue.ts` (+ test);
  - `apps/news-api/src/projections.ts` (source ownership) and `apps/news-api/src/event-sources.test.ts` if needed;
  - `apps/distribution/src/bounces/store.ts`, `apps/distribution/src/env.ts`, `apps/distribution/src/start.ts`;
  - `apps/stack/src/env.ts`, `apps/stack/src/stack.ts` (+ tests).

**Interfaces:**
- Produces:
  - `deliveryBouncedSchema = z.object({ appId: z.string(), batchId: z.string().uuid(), messageId: z.string(), email: z.string(), hard: z.boolean(), status: z.string(), at: offsetDateTime })`, registered as `delivery.bounced`.
  - Distribution env `EVENT_SUBSCRIBERS`, as other senders have it.
  - `recordBounce` enqueues `delivery.bounced` (source `distribution`, aggregateId `message:<id>`) in the same transaction when a bounce matched.
  - Worker `dispatch` (the existing outbox dispatcher, as other apps use it). Tick step `distribution.dispatch` after `distribution.bounces`.
  - Stack route `{ from: "DIST", source: "distribution", to: "NOD", name: "nod", url: "self:/nod/events", types: ["delivery.bounced"] }`.
- The routing contract is "only the sending app": NoD's handler ignores events whose `appId` isn't NoD's own Distribution app id, so NRMS's correction notices never reach NoD's bounce logic. Find the appId NoD's sends carry: the token's `azp`/subject that Distribution stores as `batches.app_id`.

- [ ] **Step 1: Write the failing tests**
  - catalogue: the schema accepts and rejects;
  - store: a matched bounce writes one outbox row; unmatched and ignored write none;
  - news-api event-sources: ownership includes `delivery.bounced` under the new `distribution` source;
  - stack: the route exists and an end-to-end bounce reaches NoD's event receiver (inbox row).
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `packages/events apps/distribution apps/news-api apps/stack`. Expect PASS.
- [ ] **Step 5: Commit** — `feat(events,distribution,stack): delivery.bounced from Distribution to NoD`

---

### Task 4: NoD records bounces and applies the 10-in-15-days rule

**Files:**
- Modify:
  - `apps/nod/src/db/schema.ts` (+ migration: `deliveries.distribution_batch_id uuid`, `deliveries.hard_bounced_at`, `deliveries.bounce_status`; index on `distribution_batch_id`);
  - `apps/nod/src/send-jobs.ts` (+ test);
  - `apps/nod/src/app.ts`;
  - `apps/nod/src/subscribe/history.ts`.
- Create: `apps/nod/src/bounces.ts` (+ test).

**Interfaces:**
- Produces:
  - Sender: after a successful `distribution.send` for a part, set `distribution_batch_id = <returned batchId>` on that part's deliveries for the job.
  - `onDeliveryBounced(tx, event): Promise<{ matched: boolean; action: "none" | "recorded" | "disabled" | "flagged" }>`:
    1. Ignore an event whose `appId` isn't NoD's own.
    2. Find the subscriber by `lower(email)`, regardless of status.
    3. Find the delivery: `distribution_batch_id = batchId` for that subscriber; fallback, their most recent attempted delivery within 4 days.
    4. Soft bounce: set `bounce_status` if null, then stop.
    5. Hard bounce: set `hard_bounced_at` (if null) and `bounce_status`.
    6. Then the threshold: take the subscriber's 10 most recent deliveries with `attempted_at >= now() - 15 days`. If there are 10 and all have `hard_bounced_at`:
       - **media member** (`hasMediaMemberships`) → `needs_attention = 'bouncing'`, `attention_at`, history `bounce-flagged`;
       - otherwise, if `status = 'active'` → `status = 'disabled'`, history `bounce-disabled` with detail `10/<days>d`.
    - Take the per-address lock and `FOR UPDATE` on the subscriber first, as the 4c member code does.
  - History actions `bounce-recorded` (only when the threshold doesn't trip; one row per hard bounce, detail = status code), `bounce-disabled`, `bounce-flagged`.
  - Wire it into NoD's event receiver handlers in `app.ts`.
  - **disabled semantics** (Global Constraints):
    - Sends already skip it; confirm with a test.
    - Public subscribe → confirm reactivates it (4a behaviour). Pin it with a test and remove 4a's forward-reference comment.

- [ ] **Step 1: Write the failing tests** (`bounces.test.ts`)
  - A hard bounce marks the delivery.
  - The same event twice → one history row.
  - 9 hard of 10 → no action.
  - 10/10 within 15 days → disabled, history `10/<n>d`, and the next As-It-Happens job excludes them.
  - 10 hard but one older than 15 days → no action.
  - **A media member** → flagged `bouncing`, not disabled, lists kept.
  - Soft bounces never count.
  - Another app's `appId` → ignored.
  - The fallback match without a batch id.
  - `send-jobs.test.ts`: the batch id is recorded after a successful part, and not on failure.
  - `journeys.test.ts`: **a disabled subscriber subscribes again** → verify → confirm → `active`.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement**, including the migration.
- [ ] **Step 4: Run** `apps/nod`. Expect PASS.
- [ ] **Step 5: Commit** — `feat(nod): record bounces; disable after 10 hard bounces in 15 days; flag media members`

---

### Task 5: Daily bounce summary and the test-site upload route

**Files:**
- Create: `apps/nod/src/bounce-summary.ts` (+ test).
- Modify:
  - `apps/nod/src/db/schema.ts` (+ migration: `nod_settings.bounce_summary_at`);
  - `apps/nod/src/start.ts` (env, worker, loop);
  - `apps/nod/src/http/routes.ts` (+ test), `apps/nod/src/distribution-client.ts` (+ test);
  - `apps/stack/src/stack.ts` (tick step) + test.

**Interfaces:**
- Produces:
  - Env `BOUNCE_SUMMARY_EMAIL` (optional email).
  - `runBounceSummaryIfDue(db, distribution, timeZone, to): Promise<{ sent: boolean; lines: number }>`:
    - Due once per BC day at or after 08:00 (`dailyCutoff`, hour 8), and only if `to` is set.
    - The window is from the last `bounce_summary_at` (or 24 h) to now.
    - It builds the body per Global Constraints from NoD's history rows (`bounce-recorded`/`bounce-disabled`/`bounce-flagged`) and the deliveries in the window. The unmatched/ignored counts come from Distribution: add `GET /api/bounces/stats?since=` (`Distribution.Operate`) → `{ unmatched, ignored }`, and a matching client method.
    - Send at system priority with idempotency key `nod-bounce-summary-<YYYY-MM-DD>`.
    - Set `bounce_summary_at` in the same claim pattern as the media sync (lock the settings row; concurrent runs → one).
  - Worker `bounceSummary`; tick step `nod.bounce-summary` after `nod.media-sync`; `startLoops` checks every minute.
  - NoD route (`NoD.Admin`): `POST /api/bounces/inbox` with body `{ raw }` proxies to Distribution's upload (`distribution.uploadBounce(raw)`). It returns Distribution's 404 as 404 ("not available: the bounce source isn't the fake inbox").

- [ ] **Step 1: Write the failing tests**
  - Summary:
    - not before 08:00;
    - once per day;
    - nothing to report → no email;
    - the body lines for recorded, disabled and flagged (media member in `<b>`);
    - the subject format;
    - concurrent runs → one email;
    - no address in logs.
  - Route:
    - 401/403;
    - proxies to the fake;
    - 404 when Distribution isn't fake.
  - Stack: the tick order.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `apps/nod apps/distribution apps/stack`. Expect PASS.
- [ ] **Step 5: Commit** — `feat(nod,distribution): daily bounce summary; fake-inbox upload through NoD`

---

### Task 6: End to end, docs and verification

**Files:**
- Create: `tests/e2e/bounces.spec.ts`.
- Modify:
  - `tests/e2e/global-setup.ts` (`NOD_BOUNCE_SUMMARY_EMAIL`);
  - docs: `docs/parity/changes-from-legacy.md`, `docs/parity/open-questions.md`, `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`, `docs/superpowers/plans/phase-4-carry-forward.md`;
  - `README.md` (env tables).

**E2E** (acceptance item 9):
1. Subscribe and confirm an address, then publish a release so a delivery exists.
2. Read the delivered email's `Message-ID` from the sink. Build an RFC 3464 bounce `.eml` for it, with `550 5.1.1` and that Message-ID.
3. `POST /nod/api/bounces/inbox` as admin, then tick until processed: the delivery shows `hard_bounced_at`.
4. Seed 9 more hard-bounced deliveries for that subscriber within 15 days via the API path, or 9 more releases + uploads if fast enough. Upload one more: the subscriber is `disabled`, and the next release doesn't reach them.
5. Move the summary clock past 08:00 (test hook): exactly one `News On Demand - Bounce Manager - <date>` email to the summary address, listing the address as disabled.

**Docs:**
- **Parity rows** (next free C numbers):
  - a bounce disables, and legacy's delete is not used: the record is kept and reactivates on re-subscribe;
  - processed bounce mail is moved to a `Processed` folder rather than deleted;
  - every fetched message is recorded in `bounces` (evidence);
  - the summary is sent by NoD to a configured address.
- **Q23:** what's built (the Graph source against recorded responses), and what production still needs:
  - the mailbox;
  - an Entra app with `Mail.ReadWrite` limited by an application access policy to that mailbox;
  - the env keys.
- **Running notes:**
  - Operations: the env keys; boxs.ca uses the fake inbox; how to upload an `.eml`.
  - Editor/Admin: what disabled means; the summary email.
- **siteground.md:** hand-check item 9 with the upload steps.
- **Carry-forward:**
  - remove the "Define disabled" 4e item;
  - note that the legacy `MailboxPassword` storage isn't needed (Graph uses Entra);
  - leave the 4f items.
- **README:** Distribution `BOUNCE_SOURCE`/`GRAPH_*`/`BOUNCE_MAILBOX`/`EVENT_SUBSCRIBERS`; NoD `BOUNCE_SUMMARY_EMAIL`.

- [ ] **Step 1:** Write `bounces.spec.ts`; run and expect FAIL until the helpers exist; fix.
- [ ] **Step 2:** Docs.
- [ ] **Step 3:** Full verification: both type-checks, full vitest, `npm run test:e2e` (previous 52 passed / 1 skipped). Record the counts.
- [ ] **Step 4: Commit and push** — `feat(e2e,docs): bounces end to end; Phase 4e docs`, then `git push -u origin feat/phase-4e`. The controller deploys after the final review.

---

## Self-review notes (for the reviewer)

- **Spec §7 coverage:**
  - source interface, Graph and fake: Task 2; schedule: Task 2;
  - parsing: Task 1; matching: Task 1;
  - event: Task 3; NoD threshold and media flag: Task 4; summary: Task 5.
  - §10 item 9: Task 6.
- **Rulings (flagged for Paul at plan review):**
  - **"Disabled", not "deleted".** Spec §7 says "disabled and `deleted`", copying legacy's two flags. In our model, `deleted` means "ended/unsubscribed" (purged after 90 days, counted as an opt-out by 4c), and a bouncing mailbox isn't an opt-out. So bounce-disabled subscribers become `disabled`: kept, sent nothing, reactivated by their own re-subscribe. *Cost if wrong:* one status value to change; the purge would then remove them after 90 days.
  - **Processed bounce mail is moved, not deleted.** It keeps evidence and costs nothing. *Cost if wrong:* the mailbox grows; a later cleanup job.
  - **The summary comes from NoD, not Distribution.** Only NoD knows subscribers and media lists, which the summary must show. *Cost if wrong:* none.
  - **The threshold applies to the delivery history NoD knows about,** i.e. sends since NoD went live. A subscriber needs 10 bounced sends in 15 days before anything happens, so there's no immediate effect at cutover. *Cost if wrong:* none.
  - **Only the sending app gets the event** (`appId` filter), so NRMS's correction notices and future senders can't trip NoD's rule. *Cost if wrong:* none.
