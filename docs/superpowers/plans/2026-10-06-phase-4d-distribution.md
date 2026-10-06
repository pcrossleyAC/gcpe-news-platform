# Phase 4d: Distribution Rate Cap, Concurrency, Pause and Capacity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Distribution:
- sends at a configured, database-enforced rate across every worker, with configurable concurrency;
- stamps a recorded `Message-ID` on every message and sets a configured Reply-To;
- can be paused and resumed as a whole by NoD admins.

A local capacity run measures what the sender can do, and the numbers are recorded beside Q21/Q22.

**Architecture:**
- **Rate cap:** a per-minute counter row, claimed in the same transaction as the messages, caps how many rows any worker may claim in the current minute. Concurrency is a bounded in-run worker pool over the claimed rows.
- **Message-ID and Reply-To:** the `Message-ID` is derived from the message row's id and recorded on the row when sent. Reply-To comes from Distribution config or the request.
- **Pause:** a Distribution settings row the sender checks at claim time. NoD exposes the switch to `NoD.Admin` and calls Distribution with a service role.
- **Capacity:** measured by a local script against an in-process SMTP sink, or a running Mailpit. It is never run against SiteGround.

**Tech Stack:** Node 24, TypeScript, Express 5, Drizzle ORM + drizzle-kit, Postgres, zod, nodemailer, smtp-server (test sink), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-05-nod-distribution-parity-design.md` §6 and §10 items 10–11 (approved).

**Base:** branch `feat/phase-4d`, worktree `/Users/paul/gcpe-news-platform-4d`, from `main` @ `1a05735`.

**Context:**
- Research notes with file:line refs are in `.superpowers/research-4d.md` (git-ignored).
- **SiteGround (boxs.ca) is a test environment only and never sends production email** (Paul, 2026-10-06). Keep its defaults modest. Production sets its rate from the relay's real limit (Q22).
- Legacy volumes for context (Q21):
  - busiest hour ≈ 24,914 emails, about 415/min;
  - busiest day 118,733;
  - As-It-Happens ≈ 18k/day.
- Already built in Phase 2, so 4d only documents it: permanent-vs-transient classification, escalating backoff, the age backstop, outage deferral (`apps/distribution/src/sender.ts:131-177, 407-420`). That satisfies the spec's "Retries" bullet and C53.

## Global Constraints

- **Worktree and commits:**
  - Work in `/Users/paul/gcpe-news-platform-4d`, branch `feat/phase-4d`. Commit locally after each task.
  - Never add a `Co-Authored-By` trailer or AI attribution. Never commit `CLAUDE.md`.
  - Don't label code comments with task or review-round numbers.
- **Node 24 for everything:**
  - Tests: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run <paths>` (a path filter is a substring match).
  - Type-checks: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json` and `… -p apps/staff-web/tsconfig.json`.
  - E2E: `npx -y -p node@24 -- npm run test:e2e`.
- **Migrations:**
  - Generate with drizzle-kit (`cd apps/<app> && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name <name>`); `--custom` for data migrations.
  - Never hand-edit generated DDL. Every migration must be safe on boxs.ca's existing data.
- **Clocks:** every "now" uses the database clock (`now()`). The rate window is `date_trunc('minute', now())`.
- **Rate cap (C58, spec §6):**
  - `MAIL_RATE_PER_MINUTE`, default `60`; minimum `1` (no "unlimited" value, so a typo can't remove the cap).
  - Enforced across all workers through the database: a worker may claim at most `cap − already claimed this minute` rows. The counter is incremented in the same transaction as the claim.
  - A claimed row counts against the minute whether or not its send succeeds. This is conservative: never over the cap.
- **Concurrency:**
  - `MAIL_CONCURRENCY` (default `1`, the Phase 2 behaviour; max `16`) is the number of `sendMail` calls in flight within one sender run.
  - `SMTP_MAX_CONNECTIONS` must be ≥ `MAIL_CONCURRENCY`; startup refuses otherwise.
- **Priorities (spec §6):**
  - system 100, media 40, immediate 30, digest 20; +2 for recipients in `INTERNAL_DOMAINS`.
  - `INTERNAL_DOMAINS` defaults to `gov.bc.ca,leg.bc.ca` (legacy `CommonMethods.cs:113-120`'s configured core domains).
- **Message-ID:**
  - Every message gets `Message-ID: <{messages.id}@{MESSAGE_ID_DOMAIN}>`.
  - `MESSAGE_ID_DOMAIN` defaults to the domain of `MAIL_FROM`.
  - The id is stable across retries of the same message and recorded in `messages.message_id` when the send is attempted. 4e matches bounces by it (C52).
- **Reply-To:**
  - A request may carry `replyTo` (one email address). Otherwise Distribution uses `MAIL_REPLY_TO` if set. Otherwise there is no Reply-To.
  - NoD sets `replyTo` from its own `REPLY_TO` setting (`NOD_REPLY_TO` on the stack) on every email it sends.
  - **Never set a real government mailbox as Reply-To on a test site:** replies from redirected test mail would reach it. boxs.ca leaves `NOD_REPLY_TO` unset.
- **Distribution pause (spec §6, §8):**
  - A Distribution-wide switch. While paused, the sender claims nothing except `system`-priority messages (verification, manage links, ops notices), so subscribers can still confirm and admins still get the pause/resume email.
  - Messages are held, never dropped.
  - Staff control it through NoD with `NoD.Admin`. NoD calls Distribution with its service token, which gains the role `Distribution.Operate`.
  - Each change is written to NoD's `operations_log` and emailed to `NOD_OPS_EMAIL`, exactly like NoD's own pause (4b).
- **Logs:** no email addresses, tokens or secrets in logs. Errors go through each app's existing safe-label helper.
- **Capacity runs are local only.** Never against SiteGround, never with real recipients: the run uses `example.test` addresses and a local sink.

## Review Focus

1. **Two workers race the same minute** (the stack tick plus a standalone loop, or two processes). The total claimed in that minute never exceeds the cap, and nothing deadlocks. Pinned in Task 2 ("two concurrent workers stay under the cap").
2. **A sender-level or outage error mid-run with concurrency > 1.** In-flight sends finish, unreached rows are released, and nothing is double-sent or left locked for the full lock time. Pinned in Task 3 ("outage with concurrency releases the rest").
3. **Distribution paused while a release goes out.** News messages are held, then sent after resume. A verification email still goes out while paused. Pinned in Task 4.
4. **A retry of a message whose first attempt was accepted but the reply was lost.** Same `Message-ID` both times, so the recipient's mail system and 4e's bounce matching see one message. Pinned in Task 1 ("Message-ID is stable across retries").
5. **A misconfigured deploy** (`MAIL_CONCURRENCY` above `SMTP_MAX_CONNECTIONS`, rate 0, a malformed `MAIL_REPLY_TO`). Startup fails with a clear message rather than sending wrongly. Pinned in Tasks 1–3 (env tests).

---

### Task 1: Message-ID, Reply-To and internal-domain default

**Files:**
- Modify:
  - `apps/distribution/src/db/schema.ts` (+ generated migration);
  - `apps/distribution/src/env.ts` (+ test);
  - `apps/distribution/src/messages.ts` (+ test);
  - `apps/distribution/src/sender.ts` (+ test);
  - `apps/nod/src/distribution-client.ts`, `apps/nod/src/start.ts`, and every NoD send site that builds a `MessageRequest` (+ tests);
  - `apps/stack/src/env.ts` if it enumerates keys.

**Interfaces:**
- Produces:
  - `messages.messageId: text("message_id")` (nullable; set when a send is attempted).
  - Batches store the request's Reply-To: `batches.replyTo: text("reply_to")` (nullable).
  - `messageRequestSchema` gains `replyTo: z.string().email().optional()`.
  - Distribution env:
    - `MAIL_REPLY_TO` (optional, must be an email);
    - `MESSAGE_ID_DOMAIN` (optional; default derived from `MAIL_FROM`'s domain; startup fails if neither yields a domain);
    - `INTERNAL_DOMAINS` default `"gov.bc.ca,leg.bc.ca"`.
  - `messageIdFor(rowId: string, domain: string): string` → `<${rowId}@${domain}>` (exported for 4e).
  - NoD env `REPLY_TO` (optional email). `MessageRequest` gains `replyTo?: string`. Every NoD send passes `replyTo` when set: As-It-Happens, digest, emergency, media, system emails, ops emails.

Rules:
- At send time, set nodemailer `messageId` to `messageIdFor(row.id, domain)` and `replyTo` to `batch.reply_to ?? MAIL_REPLY_TO ?? undefined`.
- Write `message_id` on the row in the same update that re-asserts the lock just before sending. It is the same value on every attempt.
- Redirect mode keeps the same Message-ID and Reply-To. Only the recipient and subject prefix change, as today.
- Caller headers can't set `Message-ID` or `Reply-To`; `messages.ts` already strips non-allowed headers, and a test pins it.

- [ ] **Step 1: Write the failing tests**
  - `sender.test.ts`:
    - **Message-ID:** the sink receives `Message-ID: <rowId@example.test>` and `messages.message_id` equals it.
    - **Message-ID is stable across retries:** a transient failure, then success, gives the same Message-ID both times.
    - **Reply-To:** the request's `replyTo` beats `MAIL_REPLY_TO`; with neither there is no Reply-To header.
  - `messages.test.ts`:
    - `replyTo` must be an email;
    - a caller `Reply-To`/`Message-ID` header is rejected or stripped (whichever the existing header rule does — pin it).
  - `env.test.ts`:
    - default internal domains;
    - `MESSAGE_ID_DOMAIN` derived from `MAIL_FROM`;
    - a malformed `MAIL_REPLY_TO` fails startup.
  - `priority.test.ts`: an `@gov.bc.ca` recipient gets +2 by default.
  - NoD: a send with `REPLY_TO` set carries `replyTo` in the request; unset, it carries none.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement**, including the migration.
- [ ] **Step 4: Run** `apps/distribution apps/nod apps/stack`. Expect PASS.
- [ ] **Step 5: Commit** — `feat(distribution,nod): recorded Message-ID per message, Reply-To, internal-domain default`

---

### Task 2: Database-enforced rate cap

**Files:**
- Modify:
  - `apps/distribution/src/db/schema.ts` (+ migration);
  - `apps/distribution/src/sender.ts` (+ test);
  - `apps/distribution/src/env.ts` (+ test);
  - `apps/distribution/src/start.ts`.

**Interfaces:**
- Produces:
  - Table `send_rate_windows (window_start timestamptz PRIMARY KEY, claimed integer NOT NULL DEFAULT 0)`.
  - Env `MAIL_RATE_PER_MINUTE` (int ≥ 1, default 60).
  - `SendOptions.ratePerMinute: number`.
  - `sendDue` result gains `rateLimited: boolean` (true when the minute's budget was exhausted before `batchSize`).

Rules:
- In the claim transaction, before the claim CTE:
  - `INSERT INTO send_rate_windows (window_start) VALUES (date_trunc('minute', now())) ON CONFLICT DO NOTHING`;
  - then `SELECT claimed … FOR UPDATE`;
  - `budget = ratePerMinute − claimed`. If `budget ≤ 0`, claim nothing and return `rateLimited: true`.
  - Claim `LIMIT least(batchSize, budget)`, then `UPDATE … SET claimed = claimed + <rows claimed>`.
- The window-row lock serialises claimers for a few milliseconds only. It must not be held across `sendMail`; the claim transaction commits before any send, as today.
- Delete windows older than one day opportunistically: one `DELETE` per claim where `window_start < now() - interval '1 day'`, cheap with the primary key.
- **Interaction with the lock timing:** fewer claimed rows means a shorter run. `defaultSendLockMs` stays sized from `batchSize`, a safe overestimate.

- [ ] **Step 1: Write the failing tests** (`sender.test.ts`):
  - cap 5, 12 due messages: one `sendDue` sends 5 with `rateLimited: true`, and a second call in the same minute sends 0;
  - **two concurrent workers stay under the cap:** `Promise.all` of two `sendDue` calls, cap 7, 20 due → exactly 7 sent in total, no error;
  - the next minute (advance the DB clock by setting the window row's `window_start` back one minute, or by an injectable clock in SQL) → sends again;
  - the old-window cleanup deletes a two-day-old row;
  - env: `MAIL_RATE_PER_MINUTE=0` fails startup; the default is 60.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `apps/distribution`. Expect PASS.
- [ ] **Step 5: Commit** — `feat(distribution): database-enforced per-minute send cap across workers`

---

### Task 3: Concurrency within a sender run

**Files:**
- Modify:
  - `apps/distribution/src/sender.ts` (+ test);
  - `apps/distribution/src/env.ts` (+ test);
  - `apps/distribution/src/start.ts`.

**Interfaces:**
- Produces: env `MAIL_CONCURRENCY` (int 1–16, default 1); `SendOptions.concurrency`. Startup fails if `MAIL_CONCURRENCY > SMTP_MAX_CONNECTIONS`.

Rules:
- Replace the sequential `for` loop with a bounded pool: at most `concurrency` per-row handlers in flight, taking rows in the existing claim order.
- Each handler keeps today's per-row logic unchanged: re-assert the lock, send, classify, update.
- **Stop conditions:**
  - A sender-level error or an unhealthy-transport outage sets a shared `stop` flag. No new rows start; in-flight sends finish and are handled normally; rows never started are released (`locked_until = null`) exactly as today's "release unreached rows".
  - `stopRequested` behaves the same way.
- With `concurrency = 1`, behaviour and every existing test are unchanged.
- The per-run claim lock already covers the run because the run gets shorter with concurrency, so no change.

- [ ] **Step 1: Write the failing tests** (`sender.test.ts`, smtp sink with `delayMs`):
  - concurrency 4 and 8 messages with a 200 ms sink delay take well under 8 × 200 ms, and all 8 are sent exactly once;
  - **outage with concurrency releases the rest:** concurrency 3, the second send hits an AUTH 535 → in-flight sends finish, no new ones start, unreached rows are pending and unlocked, nothing sent twice;
  - a permanent RCPT rejection on one row doesn't stop the others;
  - env: concurrency 4 with `SMTP_MAX_CONNECTIONS` 3 fails startup;
  - the full existing suite stays green at concurrency 1.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `apps/distribution` (twice; concurrency tests must not flake). Expect PASS.
- [ ] **Step 5: Commit** — `feat(distribution): bounded send concurrency within a run`

---

### Task 4: Distribution-wide pause, controlled from NoD

**Files:**
- Modify:
  - Distribution:
    - `apps/distribution/src/db/schema.ts` (+ migration seeding row 1);
    - `apps/distribution/src/sender.ts` (+ test);
    - `apps/distribution/src/http/routes.ts` (+ test).
  - NoD:
    - `apps/nod/src/distribution-client.ts` (+ test);
    - `apps/nod/src/settings.ts` (+ test);
    - `apps/nod/src/http/routes.ts` (+ test);
    - `apps/nod/src/start.ts`.
  - `packages/auth/src/roles.ts` (role constant).

**Interfaces:**
- Produces:
  - Distribution:
    - table `distribution_settings (id smallint PK CHECK (id = 1), paused boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now())`, seeded.
    - Routes, role `Distribution.Operate`: `GET /api/settings` → `{ paused }`; `POST /api/settings/pause` and `/resume` → `{ paused, changed }` (`changed` false when already in that state).
  - Sender: when paused, the claim adds `AND priority >= 100`. Only system-priority mail goes out.
  - `DISTRIBUTION_OPERATE_ROLE = "Distribution.Operate"` in `packages/auth/src/roles.ts` (a service role, not a staff role). NoD's Distribution service token adds it to its roles, wherever NoD builds that token today.
  - `DistributionClient` gains `getSettings(): Promise<{ paused: boolean }>` and `setPaused(paused: boolean): Promise<{ paused: boolean; changed: boolean }>`.
  - NoD routes (`NoD.Admin`):
    - `GET /api/distribution/settings` → `{ paused }`;
    - `POST /api/distribution/pause` and `/resume` → `{ paused, changed }`.
  - When `changed`, write NoD `operations_log` (action `distribution-paused` / `distribution-resumed`, actor) and send the ops email to `NOD_OPS_EMAIL` the same way NoD's own `setPaused` does. Subject `BC Gov News On Demand distribution paused` / `… resumed`.

- [ ] **Step 1: Write the failing tests**
  - Distribution:
    - paused → `sendDue` sends a pending system message but not a pending immediate one, and the immediate one is still `pending`;
    - resumed → it sends;
    - routes: 401/403 without `Distribution.Operate`, the response shapes, repeat pause → `changed: false`.
  - NoD:
    - routes: 401/403 without `NoD.Admin`;
    - pause calls the client, writes one `operations_log` row and sends one ops email;
    - a repeat pause writes nothing;
    - a Distribution error → 502, nothing logged.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `apps/distribution apps/nod packages/auth apps/stack`. Expect PASS.
- [ ] **Step 5: Commit** — `feat(distribution,nod): Distribution-wide pause controlled by NoD admins`

---

### Task 5: Capacity measurement, docs, verification

**Files:**
- Create:
  - `scripts/distribution-capacity.ts` (+ `npm run distribution:capacity`);
  - `tests/distribution-capacity.test.ts`, a smoke test with a tiny N.
- Modify:
  - `docs/parity/open-questions.md` (Q21/Q22);
  - `docs/parity/changes-from-legacy.md`;
  - `docs/manuals/running-notes.md`;
  - `docs/deploy/siteground.md`;
  - `docs/superpowers/plans/phase-4-carry-forward.md`;
  - `README.md` (Distribution and NoD env tables).

**Capacity script:**
- Uses a throwaway local Postgres database through the existing test-db helper, and an SMTP target: the in-process `smtp-server` sink by default, or `--smtp host:port` for a running Mailpit.
- **Phase A, throughput:** queue N synthetic `@example.test` recipients (default 20,000) in one batch, with the cap set high (1,000,000/min). For each concurrency in `1,2,4,8`, run `sendDue` in a loop until drained. Record sends/minute and drain time.
- **Phase B, cap holds:** with cap 600/min and two concurrent workers, run for 2 minutes. Record the per-minute counts; each must be ≤ 600.
- **Output:** a Markdown table on stdout. Drain times at caps 60/300/600/1,200 per minute are computed as `N / min(cap, measured throughput at the chosen concurrency)`.
- **Safety:**
  - It refuses to run if `SMTP_HOST` or any argument points anywhere other than localhost/127.0.0.1.
  - It never uses real addresses.
  - It never reads `.env`.

**Docs:**
- **Q21/Q22:** add our measured numbers (machine, Node and Postgres versions, sink) and the drain-time table. State that production's `MAIL_RATE_PER_MINUTE` must come from the relay's limit (Q22, still open), and that legacy's busiest hour needed ~415/min.
- **`changes-from-legacy.md` (next free C numbers):**
  - Distribution pause lets system mail through (legacy `IsNewsDistributionEnabled` stopped everything).
  - A recorded `Message-ID` per message (C52's prerequisite).
  - Reply-To is configurable and unset on test sites.
  - Concurrency + a database-enforced rate cap (legacy had a 2-connection pool and no rate limit). Extends C58.
  - Retry classification confirmed as built in Phase 2 (C53).
- **Running notes:**
  - **Operations:** `DIST_MAIL_RATE_PER_MINUTE`, `DIST_MAIL_CONCURRENCY`, `DIST_SMTP_MAX_CONNECTIONS`, `DIST_MAIL_REPLY_TO`, `DIST_MESSAGE_ID_DOMAIN`, `DIST_INTERNAL_DOMAINS`, `NOD_REPLY_TO`; Distribution pause via NoD.
  - **Admin:** what pause holds and what it lets through.
- **`siteground.md`:**
  - boxs.ca keeps the defaults (60/min, concurrency 1) and leaves the Reply-To settings unset.
  - Hand-check item 10 gains the Distribution pause.
  - State that the capacity script is local only.
- **Carry-forward:** remove the 4d Reply-To item, which this phase resolves.

- [ ] **Step 1:** Write the smoke test (N=50, concurrency 1 and 2, the in-process sink) asserting the script's output contains a row per concurrency and that every message was delivered exactly once. Run; expect FAIL.
- [ ] **Step 2:** Implement the script. Run the smoke test; expect PASS.
- [ ] **Step 3:** Run the real measurement locally: `npm run distribution:capacity` (N=20,000). Paste the table into Q21/Q22 with the run date and machine.
- [ ] **Step 4:** Docs as above.
- [ ] **Step 5:** Full verification: both type-checks, the full vitest suite and `npm run test:e2e` (previous 52 passed / 1 skipped). Record the counts.
- [ ] **Step 6: Commit and push** — `feat(distribution,docs): capacity measurement; Phase 4d docs`, then `git push -u origin feat/phase-4d`. The controller deploys after the final review.

---

## Self-review notes (for the reviewer)

- **Spec §6 coverage:**
  - rate cap: Task 2; concurrency: Task 3;
  - priorities: already built, plus the internal-domain default in Task 1;
  - Message-ID: Task 1; pause: Task 4;
  - retries: already built in Phase 2 and documented in Task 5;
  - capacity: Task 5.
- **§10:** item 10 (pause) is extended to Distribution in Task 4; item 11 (cap across two workers, capacity numbers) is covered in Tasks 2 and 5.
- **Carry-forward:** 4d's Reply-To item is Task 1.
- **Rulings:**
  - **Pause lets system mail through.** Verification, manage links and the pause/resume ops email itself keep flowing; otherwise pausing would also block subscribers confirming and the admins' own notice. Legacy stopped everything. *Cost if wrong:* system mail goes out while paused; one `AND priority >= 100` to remove.
  - **No "unlimited" rate.** The minimum is 1/min, so a missing or zero setting can't silently remove the cap. Production sets a big number explicitly. *Cost if wrong:* none.
  - **Message-ID derived from the row id,** stable across retries, so an accepted-but-unacknowledged first attempt and its retry are one message to receiving systems and to bounce matching. *Cost if wrong:* none known.
  - **Reply-To from config, unset on boxs.ca,** so test replies never reach a real government mailbox. *Cost if wrong:* test emails have no Reply-To, as today.
  - **Capacity is measured against the in-process SMTP sink by default** (Mailpit optional via `--smtp`). The spec names Mailpit, but the repo's automated harness uses `smtp-server`, and the result measures our sender and database, which is the point. Mailpit adds an HTTP store we'd also be measuring. *Cost if wrong:* re-run with `--smtp localhost:1025` against Mailpit.
  - **Drain times at low caps are computed, not waited out.** 20,000 at 60/min would take 5.5 hours. *Cost if wrong:* none; Phase B proves the cap holds.
