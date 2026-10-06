# Phase 4b — NoD Sending (As-It-Happens, Daily Digest, Emergency, Pause) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** NoD sends As-It-Happens, the 17:00 Daily Digest and emergency items to the right subscribers exactly once, with working per-email manage and one-click unsubscribe links, and a global pause that holds sends without dropping them.

**Architecture:**
- NoD keeps an `items` table fed by NRMS's release events (and, for emergency alerts, an admin API until 4g's feed).
- Every send is a `send_job` whose recipients live in a new `job_recipients` table. `deliveries` becomes the per item × subscriber × mode record that enforces "never twice".
- As-It-Happens is one job per item. The digest runs from the scheduled tick, groups subscribers by their exact set of matching items, and makes one job per group, so each distinct digest is rendered once.
- Each recipient gets a fresh 24-hour manage link and a stable one-click unsubscribe URL through Distribution's per-recipient substitutions.

**Tech Stack:** Node 24, TypeScript 5.9 strict, Express 5, Drizzle 0.45 / drizzle-kit 0.31, zod 3.25, Vitest 4.1, supertest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-05-nod-distribution-parity-design.md`:
- §3: `items`, `deliveries`, `nod_settings`;
- §5.1–5.2: sending and rendering;
- §10 acceptance items 3, 4, 5 and 10.

Carry-forward: `docs/superpowers/plans/phase-4-carry-forward.md`, section "4b". 4a context: `docs/superpowers/plans/2026-10-05-phase-4a-nod-subscribers.md`.

## Global Constraints

- **Worktree and commits:** `/Users/paul/gcpe-news-platform-4b`, branch `feat/phase-4b`, created from `main` @ `ff31686`. Commit locally after each task. Never add a `Co-Authored-By` trailer or any AI attribution. Never commit `CLAUDE.md`.
- **Node 24 for everything** (Node 22's tzdata predates BC's 2026 change). Commands:
  - Tests: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run <paths>`. A path filter is a substring match: `apps/nod/src/send` also matches `send-jobs.test.ts`.
  - Type-check: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json` and `… -p apps/staff-web/tsconfig.json`.
  - E2E: `npx -y -p node@24 -- npm run test:e2e`.
- **Migrations:** generate with drizzle-kit (`cd apps/nod && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name <name>`). Data-copy migrations use `--custom`. Never hand-edit generated DDL.
- **Clocks:** every "now" comparison uses the database clock (`now()` in SQL). The digest cutoff is computed in Node from the database's `now()` using the tenant time zone (`@gcpe/config`), because Postgres's tzdata may predate BC's permanent UTC−7.
- **Subjects (legacy, `NodTask.cs`):**
  - As-It-Happens: `BC Gov News - <title>`.
  - Daily digest: `BCNews - Daily Digest`.
  - Emergency: `Emergency Info BC - <title>`.
  - A subject is never empty: fall back to the item key. Truncate to 998 UTF-16 units without splitting a surrogate pair (keep `as-it-happens.ts`'s existing sanitising).
- **Priorities:** As-It-Happens and emergency `immediate`, digest `digest`. These are Distribution's priority names; Distribution maps them to 30 and 20.
- **"All news"** (list key `*`) matches only items that carry at least one `ministries:` key. This is legacy behaviour (`DistributionProvider.cs:296`). The rule lives in one SQL helper, used by As-It-Happens, the digest and `countSubscribers`.
- **Exactly once:**
  - At most one `deliveries` row per (item, subscriber, mode), enforced by the primary key.
  - A subscriber gets an item As-It-Happens only if they haven't already had it in a digest.
  - At most one digest per subscriber per cutoff.
- **Digest window and content:**
  - Window: items published after the previous cutoff, up to and including the current cutoff.
  - Excluded: advisories (`postKind = 'advisories'`), items with `toSubscribers = false`, withdrawn items, and emergency items.
  - First run ever: window start = cutoff − 24 h.
- **Releases versus corrections:**
  - `release.updated` (corrections and the 3e replay, `notify` true or false) never creates an item or a send. It only refreshes an existing item's title, summary, list keys and URL.
  - `release.unpublished` marks the item withdrawn and cancels its unsent jobs.
- **Per-email links:**
  - Every subscriber email carries `{{manageUrl}}`: a fresh 24-hour `manage` link with `origin = 'send'`, which doesn't count toward the 3-per-hour request cap.
  - Every subscriber email also carries `{{unsubscribeUrl}}` = `<SUBSCRIBE_API_URL>/OneClickUnsubscribe/<stable HMAC token>`, in the body footer and in the `List-Unsubscribe` header. Headers: `List-Unsubscribe: <{{unsubscribeUrl}}>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.
- **Pause:** while `nod_settings.paused` is true, NoD still records items, deliveries and jobs, but the sender claims nothing. Pausing and resuming each write `operations_log` and email `NOD_OPS_EMAIL` when it is set.
- **Logs:** no email addresses, tokens or secrets in logs. Log errors through `safeErrorLabel` (`apps/nod/src/subscribe/journeys.ts`).

## Review Focus

1. **A release corrected after publishing (`release.updated` with `notify: true`), or replayed by the 3e importer (`notify: false`):** nobody is emailed again, and the digest shows the corrected headline. Pinned in Task 2 ("updated never sends").
2. **A release unpublished minutes after going out, before the sender ran:** nobody gets it, and it's not in that evening's digest. Pinned in Task 4 ("withdrawn item's job is cancelled") and Task 6 ("withdrawn excluded").
3. **The tick runs twice at 17:00, or two processes race (SiteGround cold starts):** one digest per subscriber, never two. Pinned in Task 6 ("concurrent runs send one digest").
4. **A subscriber who receives several As-It-Happens emails in an hour, then clicks "Manage":** the request isn't blocked by the 3-per-hour cap, because send links don't count. Pinned in Task 3 ("send links don't count toward the cap").
5. **Daylight-saving and BC's permanent UTC−7:** the cutoff is 17:00 BC local time on both sides of 2026-11-01, and 2026-03-08 (spring forward) still has a 17:00. Pinned in Task 6 ("cutoff across zone changes").

---

## File structure

| File | Responsibility |
|---|---|
| `apps/nod/src/db/schema.ts` | `items`, `job_recipients`, `nod_settings`, `digest_runs`, `operations_log`; `deliveries` and `send_jobs` reshaped; `subscriber_links.origin`; `subscribers.manage_token` dropped |
| `apps/nod/migrations/0007…` | DDL + backfill of Phase 2/4a rows |
| `apps/nod/src/items.ts` | NRMS release events → `items`; withdrawal |
| `apps/nod/src/matching.ts` | The one SQL fragment for "subscription matches item" |
| `apps/nod/src/render.ts` | As-It-Happens, digest and emergency messages |
| `apps/nod/src/recipient-links.ts` | Bulk fresh manage links + unsubscribe URLs for a send |
| `apps/nod/src/send-jobs.ts` | Sender on `job_recipients`; priority; pause gate; withdrawn → cancelled |
| `apps/nod/src/as-it-happens.ts` | As-It-Happens and emergency job creation |
| `apps/nod/src/digest.ts` | `digestCutoff`, `runDigestIfDue` |
| `apps/nod/src/settings.ts` | Pause/resume, operations log, ops email |
| `apps/nod/src/http/routes.ts` | Admin: settings, emergency items |
| `apps/news-api/src/http/v1/subscribe.ts` | One-click: own rate bucket, shared forwarding, content-type passthrough |
| `apps/public-site/src/subscribe-pages.ts` | 4a carry-forward polish |
| `apps/stack/src/env.ts`, `stack.ts` | NRMS→NoD event types; `nod.digest` tick step |
| `tests/e2e/global-setup.ts`, `nod-sending.spec.ts` | Expose headers in the mail inspector; acceptance items 3, 5, 10 |

---

### Task 1: Schema and migrations

**Files:**
- Modify: `apps/nod/src/db/schema.ts`
- Create: `apps/nod/migrations/0007_sending_model.sql` (generated), `0008_backfill_sending_model.sql` (custom), `0009_drop_legacy_send_columns.sql` (generated)
- Test: `apps/nod/src/db/migrations.test.ts` (extend)

**Interfaces:**
- Produces:
  - `items`, `ItemKind = "release" | "emergency"`, `ItemRow`;
  - `deliveries` (columns `itemKey`, `subscriberId`, `mode`, `jobId`, `createdAt`, `attemptedAt`; PK `(itemKey, subscriberId, mode)`), `DeliveryMode = "as_it_happens" | "digest" | "media"`;
  - `sendJobs` (columns as today, but `releaseKey` → `itemKey`, now nullable, plus `jobKey` unique and `priority`; status adds `cancelled`), `SendJobStatus`;
  - `jobRecipients` (`jobId`, `subscriberId`, `chunkIndex`; PK `(jobId, subscriberId)`);
  - `nodSettings` (singleton `id = 1`: `paused`, `lastDigestCutoff`, `updatedAt`);
  - `digestRuns` (`cutoff` PK, `windowStart`, `ranAt`, `subscribers`, `groups`);
  - `operationsLog` (`id`, `at`, `actor`, `action`, `detail`);
  - `subscriberLinks.origin: "request" | "send"`.
  
  `subscribers.manageToken` is removed.

- [ ] **Step 1: Write the failing migration test**

Extend `apps/nod/src/db/migrations.test.ts` with a test that migrates up to `0006_drop_subscription_timing`, inserts Phase 2/4a-shaped rows, then migrates the rest:

```ts
it("0008 moves Phase 2 send state onto the new model", async () => {
  tdb = await createTestDatabase({ migrationsFolder: nodMigrations, upTo: "0006_drop_subscription_timing" });
  await tdb.db.execute(sql`
    INSERT INTO subscribers (id, email, manage_token, status) VALUES
      ('00000000-0000-0000-0000-000000000011', 'a@example.test', 't11', 'active'),
      ('00000000-0000-0000-0000-000000000012', 'b@example.test', 't12', 'active');
    INSERT INTO send_jobs (id, release_key, kind, subject, status, chunks_assigned) VALUES
      ('00000000-0000-0000-0000-0000000000f1', 'K1', 'as_it_happens', 'S', 'sent', true);
    INSERT INTO deliveries (release_key, subscriber_id, chunk_index) VALUES
      ('K1', '00000000-0000-0000-0000-000000000011', 0),
      ('K1', '00000000-0000-0000-0000-000000000012', 0);`);
  await tdb.migrate();
  const d = await tdb.db.execute<{ item_key: string; mode: string; job_id: string }>(sql`SELECT item_key, mode, job_id FROM deliveries ORDER BY subscriber_id`);
  expect(d.rows).toEqual([
    { item_key: "K1", mode: "as_it_happens", job_id: "00000000-0000-0000-0000-0000000000f1" },
    { item_key: "K1", mode: "as_it_happens", job_id: "00000000-0000-0000-0000-0000000000f1" },
  ]);
  const r = await tdb.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM job_recipients WHERE job_id = '00000000-0000-0000-0000-0000000000f1' AND chunk_index = 0`);
  expect(r.rows[0]!.n).toBe(2);
  const j = await tdb.db.execute<{ job_key: string; priority: string; item_key: string }>(sql`SELECT job_key, priority, item_key FROM send_jobs`);
  expect(j.rows[0]).toEqual({ job_key: "as_it_happens:K1", priority: "immediate", item_key: "K1" });
  const s = await tdb.db.execute<{ paused: boolean }>(sql`SELECT paused FROM nod_settings WHERE id = 1`);
  expect(s.rows[0]!.paused).toBe(false);
  const cols = await tdb.db.execute<{ column_name: string }>(sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'subscribers' AND column_name = 'manage_token'`);
  expect(cols.rows).toHaveLength(0);
});
```

- [ ] **Step 2: Run it; expect FAIL** (migrations 0007+ don't exist).

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/db/migrations.test.ts`

- [ ] **Step 3: Add the new tables and columns (keep the old columns for now)**

In `apps/nod/src/db/schema.ts`:
- Add `ITEM_KINDS`, `items`, `DELIVERY_MODES`, `jobRecipients`, `nodSettings`, `digestRuns`, `operationsLog`.
- Add `LINK_ORIGINS` and `subscriberLinks.origin` (default `'request'`, check constraint).
- On `deliveries`, add `itemKey` (text, nullable for now), `mode` (default `'as_it_happens'`, check), `jobId` (FK `send_jobs.id` ON DELETE SET NULL) and `attemptedAt`.
- On `send_jobs`, add `jobKey` (text, nullable for now), `priority` (default `'immediate'`, check `IN ('immediate','digest','media','system')`) and `itemKey` (nullable). Widen the status check to include `'cancelled'`.

```ts
export const ITEM_KINDS = ["release", "emergency"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** What NoD sends (spec §3): a published release, or an emergency alert. */
export const items = pgTable(
  "items",
  {
    key: text("key").primaryKey(),
    kind: text("kind").$type<ItemKind>().notNull(),
    // NRMS post kind (releases|stories|factsheets|updates|advisories); null for emergency items.
    postKind: text("post_kind"),
    // `<category>:<key>` like subscriptions.list_key, lowercased.
    listKeys: text("list_keys").array().notNull().default(sql`'{}'::text[]`),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    url: text("url").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    toSubscribers: boolean("to_subscribers").notNull().default(true),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("items_published_at_idx").on(t.publishedAt), check("items_kind_check", sql`${t.kind} IN ('release','emergency')`)],
);
export type ItemRow = typeof items.$inferSelect;

export const DELIVERY_MODES = ["as_it_happens", "digest", "media"] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

/** Who a send job goes to. Chunk indices are frozen on first attempt (P2-R16), per job. */
export const jobRecipients = pgTable(
  "job_recipients",
  {
    jobId: uuid("job_id").notNull().references(() => sendJobs.id, { onDelete: "cascade" }),
    subscriberId: uuid("subscriber_id").notNull().references(() => subscribers.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index"),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.subscriberId] })],
);

export const nodSettings = pgTable(
  "nod_settings",
  {
    id: integer("id").primaryKey().default(1),
    paused: boolean("paused").notNull().default(false),
    lastDigestCutoff: timestamp("last_digest_cutoff", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("nod_settings_singleton", sql`${t.id} = 1`)],
);

export const digestRuns = pgTable("digest_runs", {
  cutoff: timestamp("cutoff", { withTimezone: true }).primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
  subscribers: integer("subscribers").notNull().default(0),
  groups: integer("groups").notNull().default(0),
});

/** Staff/operations actions that aren't about one subscriber (pause/resume now; more in 4f). */
export const operationsLog = pgTable("operations_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  detail: text("detail").notNull().default(""),
});

export const LINK_ORIGINS = ["request", "send"] as const;
export type LinkOrigin = (typeof LINK_ORIGINS)[number];
```

Generate: `generate --name sending_model` → `0007_sending_model.sql`.

- [ ] **Step 4: Backfill (custom migration)**

`generate --custom --name backfill_sending_model`, then fill `0008_backfill_sending_model.sql`:

```sql
UPDATE "send_jobs" SET "job_key" = "kind" || ':' || "release_key", "item_key" = "release_key",
       "priority" = CASE WHEN "kind" = 'digest' THEN 'digest' ELSE 'immediate' END;
--> statement-breakpoint
UPDATE "deliveries" d SET "item_key" = d."release_key", "mode" = 'as_it_happens',
       "job_id" = (SELECT j."id" FROM "send_jobs" j WHERE j."release_key" = d."release_key" AND j."kind" = 'as_it_happens'),
       "attempted_at" = CASE WHEN EXISTS (SELECT 1 FROM "send_jobs" j WHERE j."release_key" = d."release_key" AND j."status" = 'sent') THEN d."created_at" END;
--> statement-breakpoint
INSERT INTO "job_recipients" ("job_id", "subscriber_id", "chunk_index")
SELECT d."job_id", d."subscriber_id", d."chunk_index" FROM "deliveries" d WHERE d."job_id" IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "nod_settings" ("id") VALUES (1) ON CONFLICT DO NOTHING;
```

- [ ] **Step 5: Drop the old columns and tighten**

In `schema.ts`:
- `deliveries`: remove `releaseKey` and `chunkIndex`; make `itemKey` not null; PK becomes `(itemKey, subscriberId, mode)`.
- `send_jobs`: remove `releaseKey`, `kind` stays; make `jobKey` not null and unique (`send_jobs_job_key_idx`); drop the old `(release_key, kind)` unique index.
- `subscribers`: remove `manageToken`.

Then `generate --name drop_legacy_send_columns` → `0009_drop_legacy_send_columns.sql`.

- [ ] **Step 6: Make the code compile against the new schema, minimally**

This task only keeps the build green; Tasks 3–5 rewrite the senders.
- In `send-jobs.ts`, `as-it-happens.ts`, `subscribers.ts` and `subscribe/journeys.ts`, replace `releaseKey` with `itemKey` and drop `manageToken`.
- In `journeys.ts`, delete the Phase 2 `manage_token` unsubscribe fallback and its test. The carry-forward retires it now; Task 3 replaces footers. Also delete the `manageToken: randomBytes(...)` value in `applyVerify`.
- In `send-jobs.ts`, a temporary shim keeps the existing tests compiling: `fetchAssignedMembers` reads `job_recipients` joined on `jobId`, and `ensureChunksAssigned` assigns on `job_recipients`.
- In `as-it-happens.ts`, insert the job first (`jobKey: \`as_it_happens:${r.key}\``, `itemKey: r.key`), then `deliveries` with `jobId`, then `job_recipients` from those deliveries.

Run `tsc` and fix the remaining type errors.

- [ ] **Step 7: Run NoD tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod`
Expected: PASS, including the new migration test. Update any test that inserted `manage_token` or `release_key` to the new columns.

- [ ] **Step 8: Commit**

```bash
git add apps/nod
git commit -m "feat(nod): sending model — items, job recipients, settings, digest runs; drop manage_token"
```

---

### Task 2: Items from NRMS release events

**Files:**
- Create: `apps/nod/src/items.ts`, `apps/nod/src/items.test.ts`
- Modify: `apps/nod/src/app.ts`, `apps/nod/src/release-updated.test.ts`, `apps/stack/src/env.ts`, `apps/stack/src/env.test.ts`

**Interfaces:**
- Consumes: `items` (Task 1); `ReleaseRecord`, `indexKeysFor`, `EventHandler`, `EventEnvelope` (`@gcpe/events`).
- Produces:
  - `itemFromRelease(r: ReleaseRecord, publicSiteUrl: string): typeof items.$inferInsert`;
  - `upsertReleaseItem(tx: DbOrTx, r: ReleaseRecord, publicSiteUrl: string): Promise<void>`;
  - `refreshReleaseItem(tx, r, publicSiteUrl): Promise<boolean>` (true when an item existed);
  - `withdrawItem(tx: DbOrTx, key: string): Promise<void>` (sets `withdrawn_at = now()` and cancels the item's `pending` jobs: `status = 'cancelled'`);
  - `itemHandlers(opts: { publicSiteUrl: string; onPublished: (tx: Tx, r: ReleaseRecord) => Promise<void> }): (e: EventEnvelope) => EventHandler | undefined`.

Rules:
- **Title:** the English document's headline, else the first document's, else the key. Language 4105 is English.
- **Summary:** the English document's `subheadline` when it's non-empty, else `r.summary ?? ""`. The legacy digest's line under each title is the subheadline (`docs/parity/samples/daily-digest-2026-09-22.md`).
- **URL:** `` `${publicSiteUrl.replace(/\/$/, "")}/releases/${encodeURIComponent(r.key)}` ``.
- **Other fields:** `listKeys = indexKeysFor(r)`, `postKind = r.kind`, `publishedAt = r.publishDate`, `toSubscribers = r.publishFlags.toSubscribers`.
- **`release.published`:** upsert the item, clearing `withdrawn_at`, then `onPublished`.
- **`release.updated`:** `refreshReleaseItem` only. Never insert, never send.
- **`release.unpublished`:** `withdrawItem`.

- [ ] **Step 1: Write the failing tests** (`items.test.ts`, using `createNodTestDb`, `envelope`, `sendEvent`, and an app built with `createTestApp`):

```ts
it("published creates the item from the release", async () => {
  const r = { ...sampleRelease, key: "K-ITEM", kind: "releases" as const };
  expect((await sendEvent(app, envelope("nrms", "release.published", r, r.key))).status).toBe(200);
  const [row] = await tdb.db.select().from(items).where(eq(items.key, "K-ITEM"));
  expect(row).toMatchObject({ kind: "release", postKind: "releases", url: "https://news.example/site/releases/K-ITEM", toSubscribers: r.publishFlags.toSubscribers });
  expect(row!.listKeys).toEqual(indexKeysFor(r));
});

it("updated never sends and never creates; it refreshes an existing item", async () => {
  const r = { ...sampleRelease, key: "K-UPD" };
  await sendEvent(app, envelope("nrms", "release.updated", { ...r, notify: true }, r.key));
  expect(await tdb.db.select().from(items).where(eq(items.key, "K-UPD"))).toHaveLength(0);
  await sendEvent(app, envelope("nrms", "release.published", r, r.key));
  const jobsBefore = await tdb.db.select().from(sendJobs);
  const corrected = { ...r, documents: r.documents.map((d) => ({ ...d, headline: "Corrected headline" })), notify: true };
  await sendEvent(app, envelope("nrms", "release.updated", corrected, r.key));
  const [row] = await tdb.db.select().from(items).where(eq(items.key, "K-UPD"));
  expect(row!.title).toBe("Corrected headline");
  expect(await tdb.db.select().from(sendJobs)).toHaveLength(jobsBefore.length);
});

it("unpublished withdraws the item and cancels its pending jobs", async () => {
  const r = { ...sampleRelease, key: "K-WD" };
  await sendEvent(app, envelope("nrms", "release.published", r, r.key));
  await tdb.db.insert(sendJobs).values({ jobKey: "as_it_happens:K-WD", itemKey: "K-WD", kind: "as_it_happens", subject: "s" }).onConflictDoNothing();
  await sendEvent(app, envelope("nrms", "release.unpublished", { key: "K-WD" }, r.key));
  const [row] = await tdb.db.select().from(items).where(eq(items.key, "K-WD"));
  expect(row!.withdrawnAt).not.toBeNull();
  const jobs = await tdb.db.select().from(sendJobs).where(eq(sendJobs.itemKey, "K-WD"));
  expect(jobs.every((j) => j.status === "cancelled")).toBe(true);
});
```

`createTestApp` uses `publicSiteUrl: "https://news.example/site"` (update `test/helpers.ts` if it differs). Update `release-updated.test.ts`: it still asserts no delivery or send job for `release.updated` (both `notify` values). Its doc comment now says NoD refreshes items but never sends.

- [ ] **Step 2: Run them; expect FAIL.**

- [ ] **Step 3: Implement `items.ts`**, and wire it in `app.ts`. Replace the receiver's `handlers` with `(ev) => itemHandlers({ publicSiteUrl, onPublished })(ev) ?? listsHandler(ev)`. For now `onPublished` is the existing As-It-Happens job creation; Task 5 replaces it. `itemHandlers` returns undefined unless `ev.source === "nrms"`.

- [ ] **Step 4: Stack route.** In `apps/stack/src/env.ts`, change the NRMS→NoD route's `types` to `["release.published", "release.updated", "release.unpublished"]` and update the topology doc comment. In `env.test.ts`, assert NoD's NRMS subscriber entry lists exactly those three types.

- [ ] **Step 5: Run** `apps/nod apps/stack`. Expect PASS.

- [ ] **Step 6: Commit** — `feat(nod): items from NRMS release events; corrections refresh, unpublish withdraws`

---

### Task 3: Per-recipient links and the "matches" rule

**Files:**
- Create: `apps/nod/src/matching.ts`, `apps/nod/src/recipient-links.ts`, `apps/nod/src/recipient-links.test.ts`, `apps/nod/src/matching.test.ts`
- Modify: `apps/nod/src/subscribe/links.ts` (+ test), `apps/nod/src/subscribers.ts`, `apps/nod/src/start.ts`

**Interfaces:**
- Consumes: `subscriberLinks`, `LINK_ORIGINS` (Task 1); `newLinkToken`, `hashToken`, `unsubscribeToken` (`subscribe/tokens.ts`); `LINK_TTL_MS` (`subscribe/links.ts`).
- Produces:
  - `matchesItem(listKeyCol: SQL, itemListKeys: SQL): SQL` (in `matching.ts`);
  - `interface RecipientLinkOptions { pageUrl: string; subscribeApiUrl: string; linkSecret: string }`;
  - `recipientSubstitutions(db: DbOrTx, members: { subscriberId: string; email: string; unsubscribeVersion: number }[], opts: RecipientLinkOptions): Promise<Map<string, { manageUrl: string; unsubscribeUrl: string }>>` (keyed by subscriberId);
  - NoD env `SUBSCRIBE_API_URL` (default `${new URL(PUBLIC_SITE_URL).origin}/api/Subscribe`).

`matching.ts`:

```ts
import { sql, type SQL } from "drizzle-orm";

/** Spec: a subscription matches an item when its list key is one of the item's keys, or it is
 * "all news" (`*`) and the item carries a ministry key (legacy DistributionProvider.cs:296). */
export function matchesItem(listKeyCol: SQL, itemListKeys: SQL): SQL {
  return sql`(${listKeyCol} = ANY(${itemListKeys}) OR (${listKeyCol} = '*' AND EXISTS (SELECT 1 FROM unnest(${itemListKeys}) AS k WHERE k LIKE 'ministries:%')))`;
}
```

`recipient-links.ts`:
- Generate one `newLinkToken()` per member.
- Insert `manage` links in chunks of 1,000 rows. Each row has `tokenHash`, `purpose 'manage'`, `origin 'send'`, `email` (lowercased), `subscriberId`, and `expiresAt = now() + 24h`.
- Return `manageUrl = linkUrl(pageUrl, token)` and `unsubscribeUrl = \`${subscribeApiUrl.replace(/\/$/, "")}/OneClickUnsubscribe/${encodeURIComponent(unsubscribeToken(linkSecret, id, version))}\``.

- [ ] **Step 1: Write the failing tests**

`recipient-links.test.ts`:
- For 3 members, the result has 3 entries.
- Each `manageUrl` token, run through Task 4a's `confirm()`, returns that subscriber's info.
- Each `unsubscribeUrl` path segment, passed to `unsubscribe()`, deletes that subscriber.
- 3 new `subscriber_links` rows exist with `origin = 'send'`.

`links.test.ts` (**send links don't count toward the cap**): create 5 `origin: 'send'` links for an address, then `linksSentLastHour(db, address)` is 0. Then `requestManageLink` still sends a manage email.

`matching.test.ts`, with three items:
- `'*'` matches an item with `['ministries:health']`;
- `'*'` does not match an item with only `['emergency:alerts']`;
- `'sectors:mining'` matches an item listing it;
- nothing matches an item with empty keys.

- [ ] **Step 2: Run; expect FAIL.**

- [ ] **Step 3: Implement.**
- `links.ts`: `createLink` takes an optional `origin` (default `'request'`). `linksSentLastHour` adds `AND origin = 'request'`.
- `subscribers.ts` `countSubscribers`: switch to `matchesItem` semantics. A count for list keys K counts active subscribers where `sub.list_key = ANY(K)` or (`'*'` and K has a ministries key). Keep its signature, and keep the existing tests green.
- `start.ts`: add `SUBSCRIBE_API_URL`, and build `RecipientLinkOptions` from `SUBSCRIBE_PAGE_URL`/default, `SUBSCRIBE_API_URL`/default and `LINK_SECRET`.

- [ ] **Step 4: Run** `apps/nod`. Expect PASS.

- [ ] **Step 5: Commit** — `feat(nod): per-recipient manage links and one-click URLs; single "matches" rule`

---

### Task 4: Sender on job recipients, with priority, pause gate and cancellation

**Files:**
- Modify: `apps/nod/src/send-jobs.ts`, `apps/nod/src/send-jobs.test.ts`, `tests/clock-skew.test.ts` (fixture columns)

**Interfaces:**
- Consumes:
  - `jobRecipients`, `sendJobs`, `deliveries`, `nodSettings`, `items` (Task 1);
  - `recipientSubstitutions`, `RecipientLinkOptions` (Task 3);
  - `DistributionClient`, `MessageRequest` (`priority` field).
- Produces:
  - `SendJobsOptions` gains `links: RecipientLinkOptions`; `manageUrl` is removed;
  - `sendDueJobs(opts): Promise<{ sent: number; retried: number; failed: number; cancelled: number; paused: boolean }>`;
  - `ensureChunksAssigned(db, jobId, chunkSize, opts?)` (no `releaseKey` argument).

Behaviour:
- **Pause:** at the start of `sendDueJobs`, read `nod_settings.paused`. If true, return `{ sent: 0, retried: 0, failed: 0, cancelled: 0, paused: true }` without claiming anything.
- **Claim:** `claimOneJob` also returns `priority`, `kind` and `item_key`.
- **Cancellation:** after claiming, if the job has an `item_key` whose item is withdrawn, set the job's status to `cancelled`, release the lock and count it in `cancelled`. Nothing is sent.
- **Recipients:** come from `job_recipients` joined to `subscribers` (`email`, `status`, `unsubscribe_version`), ordered by `subscriber_id`. Only `active` subscribers are sent to (existing rule).
- **Chunking:** `ensureChunksAssigned` numbers `job_recipients` rows of the job whose `chunk_index IS NULL`, using `row_number() OVER (ORDER BY subscriber_id)` — the same P2-R16 freeze, on the new table.
- **Per chunk part:** call `recipientSubstitutions` for that part's active members, just before sending. Request:
  - `priority`: the job's `priority`;
  - `headers`: `{ "List-Unsubscribe": "<{{unsubscribeUrl}}>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }`;
  - each recipient's `substitutions`: `{ manageUrl, unsubscribeUrl }`.
- **After a successful send:** set `deliveries.attempted_at = now()` for rows of this job whose subscriber was in the sent part.
- **Unchanged:** retry, backoff, age backstop and byte-size partitioning.

- [ ] **Step 1: Write the failing tests** (in `send-jobs.test.ts`; adapt its fake `distribution` and fixtures):

```ts
it("paused: claims nothing; resumed: sends", async () => { /* set nod_settings.paused=true; sendDueJobs → paused true, distribution not called, job still pending; set false; sendDueJobs → sent 1 */ });
it("withdrawn item's job is cancelled, nothing sent", async () => { /* item withdrawn_at set; pending job for it; sendDueJobs → cancelled 1; distribution not called; status 'cancelled' */ });
it("each recipient gets their own manage and one-click URLs, and the List-Unsubscribe header uses the placeholder", async () => {
  /* two active recipients; capture the MessageRequest; expect headers["List-Unsubscribe"] === "<{{unsubscribeUrl}}>";
     recipients[i].substitutions.manageUrl contains "token=" and differs between the two;
     substitutions.unsubscribeUrl starts with the SUBSCRIBE_API_URL + "/OneClickUnsubscribe/" */
});
it("uses the job's priority", async () => { /* job priority 'digest' → request.priority 'digest' */ });
it("a digest job with several delivery rows per subscriber sends each subscriber once", async () => {
  /* one job, 2 job_recipients, 3 deliveries (2 items for subscriber A, 1 for B) → one request with 2 recipients */
});
```

Write each test body in full, following the existing tests in the file (same setup helpers, inserted rows and fake distribution). The comments above say exactly what each asserts.

- [ ] **Step 2: Run; expect FAIL.**

- [ ] **Step 3: Implement** the behaviour above in `send-jobs.ts`. Remove `manageLinkFor` and the `manageToken` recipient field. Update `start.ts` to pass `links` in place of `manageUrl`. `MANAGE_URL` stays in the env schema only if something else reads it; otherwise remove it and its fixtures (`grep -rn MANAGE_URL apps scripts tests`).

- [ ] **Step 4: Run** `apps/nod` and `tests/clock-skew.test.ts`. Expect PASS (update the clock-skew fixture to the new columns: `send_jobs.job_key/item_key`, `job_recipients`).

- [ ] **Step 5: Commit** — `feat(nod): sender on job recipients — priority, pause gate, cancelled withdrawn items, per-recipient links`

---

### Task 5: As-It-Happens and emergency sends

**Files:**
- Create: `apps/nod/src/render.ts`, `apps/nod/src/render.test.ts`
- Modify: `apps/nod/src/as-it-happens.ts` (+ test), `apps/nod/src/app.ts`, `apps/nod/src/http/routes.ts` (+ test)

**Interfaces:**
- Consumes: `items`, `deliveries`, `jobRecipients`, `sendJobs` (Task 1); `upsertReleaseItem` and `itemHandlers` (Task 2); `matchesItem` (Task 3).
- Produces:
  - `render.ts`:
    - `type RenderItem = Pick<ItemRow, "key" | "title" | "summary" | "url" | "publishedAt"> & { categories: { name: string; url: string | null }[] }`;
    - `type RenderOptions = { siteUrl: string; bannerUrl: string | null }` (siteUrl = public site home for "See more from BC Gov News"; bannerUrl from optional env `NOD_BANNER_URL`);
    - `renderAsItHappens(item: RenderItem, opts: RenderOptions): Rendered`;
    - `renderEmergency(item: RenderItem, opts: RenderOptions): Rendered`;
    - `renderDigest(items: RenderItem[], opts: RenderOptions): Rendered`;
    - `itemCategories(db: DbOrTx, listKeys: string[]): Promise<{ name: string; url: string | null }[]>` (names from `lists`, sorted alphabetically case-insensitively, url = `lists.topic_url` or null when empty; keys with no `lists` row are skipped; `emergency:*` keys included);
    - `type Rendered = { subject: string; html: string; text: string }`.

    **Layout, from the real legacy digest** (`docs/parity/samples/daily-digest-2026-09-22.md`; it answers Q24 for the digest):
    - Banner: `<img src=bannerUrl alt="Government of B.C. News on Demand">` when bannerUrl is set, else a blue heading "Government of B.C. — News on Demand".
    - One block per item: the title as a bold blue link to `url`; the summary line; "▶ READ MORE" as a bold blue link to `url`; then a grey line of category names, comma-separated, each a grey link when it has a url.
    - Footer: a two-cell grey bar, "Manage your subscription" → `{{manageUrl}}` and "See more from BC Gov News" → siteUrl. Below it: "Please do not respond to this message", then a small "Unsubscribe" link → `{{unsubscribeUrl}}` (C62; legacy had none in the body).
    - The digest lists items in `publishedAt` order, with no date heading. As-It-Happens and emergency emails use the same layout for one item.
    - Inline styles only (email clients ignore `<style>`). Table-based layout, max width 600px. The text part mirrors it: title, summary, "Read more: <url>", categories, then the footer links.
    
    Footers carry `{{manageUrl}}` and `{{unsubscribeUrl}}`. Keep the existing `neutralizeHtml`/`neutralizeText`/subject sanitising, moved here.

    **Amendment (2026-10-05, from three more legacy samples; see `docs/parity/samples/as-it-happens-2026-08-07.md`, `manage-email-2026-09-24.md`):**
    - The subscriber As-It-Happens sample confirms the layout above for one item.
    - **Summary source (corrects Task 2):** an item's summary is the release's own `summary` (`r.summary ?? ""`), not the English subheadline. Legacy emails print the English release's Summary field (`ReleasePublisher.cs:60`), pre-filled from the body trimmed to 500 characters and staff-editable; NRMS mirrors this (`releases/service.ts:348`). Change `itemFromRelease` in `apps/nod/src/items.ts` and its tests (and the doc comment) accordingly. The summary can be ~500 characters: render it as a paragraph.
    - **System emails share the shell:** `renderSystemEmail` (`apps/nod/src/subscribe/emails.ts`) wraps its heading, lines and action link in the same banner and a footer with a **one-cell** grey bar "See more from BC Gov News" → siteUrl, then "Please do not respond to this message". No manage cell and no unsubscribe link (these emails aren't subscriber sends). Subjects and wording stay as 4a built them (they match the sample). Export a shared shell helper from `render.ts` for this; add a test that a manage email has the banner, the "See more" link and the do-not-respond line.
  - `as-it-happens.ts`:
    - `createItemSend(tx: Tx, itemKey: string, kind: "as_it_happens" | "emergency"): Promise<boolean>` (true if a job was created);
    - `recordEmergencyItem(db: Db, input: { guid: string; title: string; summary: string; url: string; publishedAt?: string }): Promise<{ key: string; created: boolean }>`.
  - Route `POST /api/emergency-items`, `NoD.Admin` only. Body `{ guid, title, summary?, url, publishedAt? }` (zod: title ≤ 500, url http(s)). Responds `201 { key }` when new, `200 { key }` when the guid was already recorded.

Rules:
- **`createItemSend("as_it_happens")`:** skip if the item is withdrawn or `toSubscribers` is false. Recipients are active subscribers with `as_it_happens = true` and a subscription matching the item (`matchesItem`), excluding any subscriber who already has a `digest` delivery for the item.
  - Insert the job: `jobKey: \`as_it_happens:${key}\``, priority `immediate`, rendered once, `ON CONFLICT (job_key) DO NOTHING`. If it already existed, return false.
  - Then insert `job_recipients` and `deliveries` (mode `as_it_happens`, `job_id`) with set-based `INSERT … SELECT`, with no JS round trip of ids.
  - If there are no recipients, delete the job and return false.
- **`createItemSend("emergency")`:** recipients are every active subscriber subscribed to any of the item's list keys, whatever their timing. Job key `emergency:${key}`, `renderEmergency`, and deliveries mode `as_it_happens`.
- **`recordEmergencyItem`:** key `emergency:${sha256(guid).slice(0, 32)}`; `kind 'emergency'`, `listKeys ['emergency:alerts']`, `publishedAt` = given or `now()`. Insert `ON CONFLICT DO NOTHING`. If inserted, call `createItemSend(…, "emergency")` in the same transaction.
- `app.ts`'s `onPublished` becomes `(tx, r) => createItemSend(tx, r.key, "as_it_happens")`, after `upsertReleaseItem`.

- [ ] **Step 1: Write the failing tests**
- `render.test.ts`:
  - **Subjects:** `BC Gov News - <title>`, `Emergency Info BC - <title>`, `BCNews - Daily Digest`; key fallback for an empty title; 998-unit truncation; no `{{` survives from the content.
  - **Content:**
    - Footers contain `{{manageUrl}}` and `{{unsubscribeUrl}}` exactly once each.
    - The digest lists every item's title and url in published order, each with "▶ READ MORE" and its category line.
    - The banner uses `<img>` when bannerUrl is set, else the heading.
    - "See more from BC Gov News" links to siteUrl, and "Please do not respond to this message" is present.
    - The HTML escapes titles and category names.
  - `itemCategories`: alphabetical, skips unknown keys, null url for an empty topic_url.
- `as-it-happens.test.ts` (rewrite against the new model):
  - matching active As-It-Happens subscribers get one delivery each, and a digest-only subscriber gets none;
  - a second `release.published` for the same key creates nothing new;
  - a subscriber with a `digest` delivery for the item is skipped;
  - `toSubscribers: false` creates no job;
  - `*` gets ministry items but not emergency items.
- **Emergency:** `routes.test.ts`, for `POST /api/emergency-items`:
  - 401 without a token, 403 without `NoD.Admin`;
  - 201 then 200 for the same guid;
  - a digest-only subscriber on `emergency:alerts` gets a delivery;
  - a subscriber not on the list gets none.

- [ ] **Step 2: Run; expect FAIL.** Then **Step 3: Implement**, **Step 4: Run** `apps/nod` (PASS), **Step 5: Commit** — `feat(nod): As-It-Happens on items, emergency sends, legacy subjects`

---

### Task 6: Daily digest

**Files:**
- Create: `apps/nod/src/digest.ts`, `apps/nod/src/digest.test.ts`
- Modify: `apps/nod/src/start.ts` (env `TENANT_CONFIG`, worker `digest`), `apps/stack/src/stack.ts` (tick step), `apps/stack/src/stack.test.ts` (tick order)

**Interfaces:**
- Consumes: `items`, `deliveries`, `jobRecipients`, `sendJobs`, `nodSettings`, `digestRuns` (Task 1); `matchesItem` (Task 3); `renderDigest` (Task 5); `loadTenantConfig`, `assertTimeZoneRules`, `wallClockToInstant` (`@gcpe/config`).
- Produces:
  - `DIGEST_HOUR = 17`;
  - `digestCutoff(dbNow: Date, timeZone: string): Date`;
  - `runDigestIfDue(db: Db, timeZone: string): Promise<{ ran: boolean; cutoff: string | null; subscribers: number; groups: number }>`;
  - NoD worker `digest`; stack tick step `{ name: "nod.digest", run: worker(nod, "digest") }`, placed before `nod.send`.

`digestCutoff`: the latest instant ≤ `dbNow` at which the wall clock in `timeZone` reads 17:00.

```ts
export const DIGEST_HOUR = 17;

function localDateParts(d: Date, timeZone: string): { y: number; m: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: get("year"), m: get("month"), day: get("day") };
}

/** 17:00 local on the local date of `dbNow`, or the day before if that is still ahead. Uses the
 * same wall-clock→instant conversion as the rest of the platform (Node's tzdata, asserted at
 * startup), never Postgres's. */
export function digestCutoff(dbNow: Date, timeZone: string): Date {
  const { y, m, day } = localDateParts(dbNow, timeZone);
  const at = (dayOffset: number) => wallClockToInstant(new Date(Date.UTC(y, m - 1, day + dayOffset, DIGEST_HOUR, 0, 0)), timeZone);
  const today = at(0);
  return today.getTime() <= dbNow.getTime() ? today : at(-1);
}
```

(Check `wallClockToInstant`'s contract in `packages/config/src/timezone.ts` before relying on it: it takes a `Date` whose UTC fields are the wall-clock fields. If it differs, adapt and say so in the report.)

`runDigestIfDue(db, timeZone)`, in one transaction:
1. `SELECT now()` from the DB → `dbNow`; `cutoff = digestCutoff(dbNow, timeZone)`.
2. `SELECT … FROM nod_settings WHERE id = 1 FOR UPDATE`. If `last_digest_cutoff >= cutoff`, return `{ ran: false, cutoff, … }`.
3. `windowStart = last_digest_cutoff ?? cutoff − 24h`.
4. `INSERT INTO digest_runs (cutoff, window_start) … ON CONFLICT DO NOTHING RETURNING cutoff`. If no row came back, another process has the run, so return not ran.
5. Group subscribers by matching items:

```sql
WITH win AS (
  SELECT key, list_keys FROM items
   WHERE kind = 'release' AND to_subscribers AND withdrawn_at IS NULL
     AND COALESCE(post_kind, '') <> 'advisories'
     AND published_at > $windowStart AND published_at <= $cutoff),
m AS (
  SELECT DISTINCT s.id AS subscriber_id, w.key
    FROM subscribers s
    JOIN subscriptions sub ON sub.subscriber_id = s.id
    JOIN win w ON <matchesItem(sub.list_key, w.list_keys)>
   WHERE s.status = 'active' AND s.digest),
per AS (SELECT subscriber_id, array_agg(key ORDER BY key) AS keys FROM m GROUP BY subscriber_id)
SELECT keys, array_agg(subscriber_id ORDER BY subscriber_id) AS subscriber_ids FROM per GROUP BY keys
```

6. For each group:
   - load its items in `published_at` order, attach `itemCategories(tx, item.listKeys)` to each, and `renderDigest(items, renderOptions)`;
   - insert `send_jobs` with `jobKey = \`digest:${cutoff.toISOString()}:${sha256(keys.join(",")).slice(0, 16)}\``, kind `digest`, priority `digest`, `itemKey` null;
   - insert `job_recipients` (`unnest(subscriber_ids)`) and `deliveries` (every key × every subscriber, mode `digest`, `job_id`), both `ON CONFLICT DO NOTHING`.
7. Update `digest_runs` counts and `nod_settings.last_digest_cutoff = cutoff`.

`start.ts`:
- Add `TENANT_CONFIG` to `nodEnvSchema` (same default as `apps/news-api/src/env.ts`).
- At startup, `loadTenantConfig` + `assertTimeZoneRules`.
- Worker: `digest: () => runDigestIfDue(db, tenant.timeZone)`.

- [ ] **Step 1: Write the failing tests** (`digest.test.ts`)

```ts
describe("digestCutoff", () => {
  const tz = "America/Vancouver";
  it("is today 17:00 local once past it, yesterday's before", () => {
    expect(digestCutoff(new Date("2026-10-06T00:30:00Z"), tz).toISOString()).toBe("2026-10-06T00:00:00.000Z"); // 17:30 PDT → 17:00 PDT
    expect(digestCutoff(new Date("2026-10-05T23:59:00Z"), tz).toISOString()).toBe("2026-10-05T00:00:00.000Z"); // 16:59 PDT → yesterday 17:00
  });
  it("cutoff across zone changes", () => {
    // BC permanent UTC−7 from 2026-11-01 (tzdata 2026b+): 17:00 local = 00:00Z next day, both sides.
    expect(digestCutoff(new Date("2026-11-03T01:00:00Z"), tz).toISOString()).toBe("2026-11-03T00:00:00.000Z");
    // Spring forward 2026-03-08 (UTC−8 → UTC−7): 17:00 still exists.
    expect(digestCutoff(new Date("2026-03-09T01:00:00Z"), tz).toISOString()).toBe("2026-03-09T00:00:00.000Z");
    // Before it, in standard time (UTC−8): 17:00 = 01:00Z.
    expect(digestCutoff(new Date("2026-02-10T02:00:00Z"), tz).toISOString()).toBe("2026-02-10T01:00:00.000Z");
  });
});
```

Database tests, using `createNodTestDb`, inserted items with explicit `published_at` relative to a cutoff, and `nod_settings.last_digest_cutoff` set to a known value. To run "at" a time, set `last_digest_cutoff` to the previous cutoff, and set item times relative to `digestCutoff(new Date(), tz)`. The real clock is fine because only relative order matters.
- **Groups:** two subscribers with the same lists share one job; a subscriber with different lists gets its own job. Each job's `job_recipients` holds exactly its subscribers. `deliveries` has one `digest` row per item per subscriber.
- **Exclusions:** advisories, `toSubscribers=false`, emergency items and items outside the window are excluded. "Withdrawn excluded": a withdrawn item is not in any job.
- **Timing:** As-It-Happens-only subscribers get nothing.
- **Second run:** a second `runDigestIfDue` returns `ran: false` and creates nothing.
- **Catch-up:** with `last_digest_cutoff` = cutoff − 3 days, one run covers all three days' items in one digest.
- **"Concurrent runs send one digest":** `await Promise.all([runDigestIfDue(db, tz), runDigestIfDue(db, tz)])` gives exactly one `ran: true`, one set of jobs, and no error.
- **First run:** `last_digest_cutoff` null → window = the 24 h before cutoff.
- **Integration with As-It-Happens:** after a digest delivered item K to subscriber S (who has both timings), `createItemSend(K, "as_it_happens")` skips S.

- [ ] **Step 2: Run; expect FAIL.**

- [ ] **Step 3: Implement** `digest.ts`, the env/worker in `start.ts`, and the tick step in `stack.ts`. In `stack.test.ts`, assert the tick step order includes `nod.digest` immediately before `nod.send`.

- [ ] **Step 4: Run** `apps/nod apps/stack`. Expect PASS.

- [ ] **Step 5: Commit** — `feat(nod): 17:00 daily digest with catch-up, grouped rendering, exactly-once`

---

### Task 7: Pause/resume, operations log, ops email

**Files:**
- Create: `apps/nod/src/settings.ts`, `apps/nod/src/settings.test.ts`
- Modify: `apps/nod/src/http/routes.ts` (+ test), `apps/nod/src/start.ts` (env `NOD_OPS_EMAIL` → schema key `OPS_EMAIL`)

**Interfaces:**
- Consumes: `nodSettings`, `operationsLog` (Task 1); `DistributionClient`; `safeErrorLabel`.
- Produces:
  - `getSettings(db): Promise<{ paused: boolean; lastDigestCutoff: string | null }>`;
  - `setPaused(deps: { db: Db; distribution: Pick<DistributionClient, "send">; opsEmail: string | null }, paused: boolean, actor: string): Promise<{ changed: boolean }>`.
  
  Routes (`NoD.Admin`): `GET /api/settings` → `200 { paused, lastDigestCutoff }`; `POST /api/settings/pause` and `POST /api/settings/resume` → `200 { paused, changed }`. The actor is the bearer's `name` claim, else `sub`.

`setPaused`:
- In a transaction, update `nod_settings` only if the value changes (`WHERE paused <> $paused RETURNING`).
- On a change, insert `operations_log` (`action: 'paused' | 'resumed'`, actor). After commit, if `opsEmail` is set, send a `system`-priority email:
  - subject `BC Gov News On Demand sending paused` or `… resumed`;
  - body naming the actor and the time in the tenant zone;
  - idempotency key `nod-ops-<log id>`.
- Send failures are logged with `safeErrorLabel` and never thrown.
- A repeat pause is `changed: false`, writes no log and sends no email.

- [ ] **Step 1: Write the failing tests**
- **Pause:** sets paused, writes one log row and sends one ops email. A repeat pause changes nothing.
- **Resume:** works the same way in reverse.
- **No ops email configured:** no send.
- **Ops email fails:** the call still resolves.
- **Routes:** role checks (401/403) and the response shapes.
- **Held, not dropped:** a job created while paused is still `pending` after `sendDueJobs`, and is sent after resume. This test sits in `settings.test.ts` and uses the Task 4 sender with a fake distribution.

- [ ] **Step 2–4:** Fail, implement, pass (`apps/nod`).

- [ ] **Step 5: Commit** — `feat(nod): pause/resume with operations log and ops email`

---

### Task 8: News API one-click hardening

**Files:**
- Modify: `apps/news-api/src/http/v1/subscribe.ts`, `apps/news-api/src/http/v1/subscribe.test.ts`, `apps/news-api/src/env.ts`, `apps/news-api/src/start.ts`

**Interfaces:**
- Produces:
  - `SubscribeProxyOptions.oneClickRateLimitPerMinute?: number`, default 6000, from env `ONE_CLICK_RATE_LIMIT_PER_MIN`;
  - a private `forward(req, res, upstreamPath, init)` helper shared by the generic loop and the one-click route.

Changes (carry-forward 4b):
- **Rate limits:** one-click POSTs get their own `rateLimit` instance (limit `oneClickRateLimitPerMinute`, same key generator). The generic `/Subscribe` limiter skips them: `skip: (req) => req.path.startsWith("/OneClickUnsubscribe/")`. Mail providers send these from shared IPs.
- **Shared forwarding:** both handlers go through `forward`, which handles the token, timeout, status, content-type passthrough (no forced `application/json`) and the 502 log line.
- **Body:** the one-click route still sends the fixed body `List-Unsubscribe=One-Click`.

- [ ] **Step 1: Write the failing tests**
- **Forwarded request:** the upstream receives `content-type: application/x-www-form-urlencoded` and body `List-Unsubscribe=One-Click`.
- **Response type:** an upstream `text/plain` response comes back as `text/plain`.
- **Rate buckets:** with `rateLimitPerMinute: 2`, three one-click POSTs from one IP all reach upstream, while three generic GETs give 429 on the third. With `oneClickRateLimitPerMinute: 2`, the third one-click is 429.

- [ ] **Step 2–4:** Fail, implement, pass (`apps/news-api`).

- [ ] **Step 5: Commit** — `fix(news-api): one-click unsubscribe gets its own rate bucket; shared proxy forwarding`

---

### Task 9: Test-page polish and end-to-end sending

**Files:**
- Modify: `apps/public-site/src/subscribe-pages.ts` (+ test), `tests/e2e/global-setup.ts`, `tests/e2e/playwright-support.ts`, `tests/e2e/subscribe-journey.spec.ts`, `tests/e2e/publish-email.spec.ts`
- Create: `tests/e2e/nod-sending.spec.ts`

**Interfaces:**
- Consumes: everything above. Admin calls in e2e use the existing admin cookie helper (`loginForCookie(ADMIN_USERNAME, ADMIN_PASSWORD)`, CSRF header as in `ensureSubscriber`).
- Produces: `SentMessage.headers: Record<string, string>`, with lowercased header names from the sink.

**Page polish** (carry-forward 4b):
- `loadCategories` reports a failure with `say(…, "Couldn't load topics. Reload the page to try again.", "alert")`.
- The manage page with no `token` shows the request box straight away and never calls Confirm with `"null"`.
- The unsubscribe button handles a network failure: "Something went wrong. Try again." (alert).
- A 400 from Create or Update shows the server's `error` message, or, for zod issues, "Check the email address."
- Use two fixed live regions (`role="status"` and `role="alert"`) instead of switching one element's role.
- Offer the `emergency` category alongside the four others.
- Rename `id="unsubscribe-link"` to `id="unsubscribe-button"`.
- Pin the expired-link text "This link has expired. Request a new one below." in the unit test.
- Remove the dead `waitForMessageWithSubject` import from `subscribe-journey.spec.ts`.

**E2E** (`nod-sending.spec.ts`; acceptance items 3, 5, 10):

1. **As-It-Happens once, with working links:**
   - Subscribe and confirm an address through the API, all news, As-It-Happens.
   - Publish a release (`createApprovedAndPublished`), `tick()`, and expect exactly one email `BC Gov News - <headline>` to that address.
   - Open its `{{manageUrl}}` link (the first `…/subscribe/manage/?token=` URL in the text). The manage page shows the preferences.
   - POST the `list-unsubscribe` header URL (strip `<>`) with the RFC 8058 form body, then prove inactivity (Create → Verification email).
   - Tick again: still exactly one email for that release.
2. **Emergency:** subscribe an address to `emergency: ['alerts']` with Daily digest only. `POST /nod/api/emergency-items` as admin, then `tick()`. Expect `Emergency Info BC - <title>` to that address.
3. **Pause holds, resume releases:**
   - `POST /nod/api/settings/pause`.
   - Publish a release for a subscribed address, `tick()`: no email.
   - `POST /nod/api/settings/resume`, `tick()`: the email arrives.
   - Always resume in a `finally` so later specs aren't paused.

`publish-email.spec.ts`: the subject is now `BC Gov News - ${headline}`.

- [ ] **Step 1:** Extend the mail inspector with `headers` (from `m.headers`, a Map: `Object.fromEntries([...m.headers].map(([k, v]) => [k, String(typeof v === "object" && v && "text" in v ? v.text : v)]))`) and `SentMessage`. Update `publish-email.spec.ts`.
- [ ] **Step 2:** Write `nod-sending.spec.ts` as above. Run it and expect FAIL until the page polish lands where a spec relies on it, then fix.
- [ ] **Step 3:** Implement the page polish, with unit tests in `subscribe-pages.test.ts` for the no-token path, the two live regions and the emergency category.
- [ ] **Step 4:** Run `apps/public-site`, then the full e2e suite. Expect the previous 46 passed / 1 skipped, plus the 3 new ones.
- [ ] **Step 5: Commit** — `feat(nod,public-site,e2e): sending end to end; test-page polish`

---

### Task 10: Docs and verification

**Files:**
- Modify: `docs/parity/changes-from-legacy.md`, `docs/parity/open-questions.md`, `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`, `docs/superpowers/plans/phase-4-carry-forward.md`, `README.md` (NoD env table)

- [ ] **Step 1: Parity rows** (NoD table, after C60):

```markdown
| C61 | A release's NoD entry is never withdrawn: legacy has no unpublish path into NoD, so an unpublished release can still go out in that evening's digest. | `release.unpublished` withdraws the item: unsent As-It-Happens jobs are cancelled and it's left out of later digests. | An unpublished release shouldn't reach subscribers. | Agreed |
| C62 | Each As-It-Happens email creates a 1-day manage link (`NodTask.cs:408-419`); there is no unsubscribe header. | Each email carries a fresh 24-hour manage link and a stable one-click unsubscribe URL, also in `List-Unsubscribe` (RFC 8058). Send-created links don't count toward the 3-per-hour request cap. | Mail providers expect one-click unsubscribe; old emails keep a working unsubscribe. | Agreed |
```

- [ ] **Step 2: Running notes, Phase 4 section:**
- **Operations:** the digest runs from the scheduled tick at 17:00 BC time. A missed tick catches up on the next one, in one digest.
- **Operations:** pause holds every NoD send (nothing is dropped). Pause and resume are logged and emailed to `NOD_OPS_EMAIL` when it is set.
- **Editor:** a correction never re-emails subscribers. Unpublishing stops anything not yet sent and keeps the release out of later digests.

Remove the 4a-era bullet about footers not working with the new manage page.

- [ ] **Step 3: siteground.md hand-check, Phase 4:**
- item 3: As-It-Happens arrives once; its footer manage link and one-click unsubscribe work;
- item 4: the 17:00 digest arrives (check the evening after a publish);
- item 10: pause holds, resume releases.

Replace the "footer links are fixed in 4b" note.

- [ ] **Step 4: Carry-forward:** delete the "4b" section, now done. Move anything left unfinished into the 4c section with a note.

- [ ] **Step 4b: Q24:** in `docs/parity/open-questions.md`, update Q24's working assumption: "Daily digest layout now known from a real 2026-09-22 sample (`docs/parity/samples/daily-digest-2026-09-22.md`) and implemented; still needed: a verification-email sample and the banner image URL (legacy `Site.BannerSource`)." (As-It-Happens, media-list and manage samples arrived 2026-10-05 and are already recorded.)

- [ ] **Step 5: README:** add `SUBSCRIBE_API_URL`, `TENANT_CONFIG` and `NOD_OPS_EMAIL` to the NoD env table. Remove `MANAGE_URL` if Task 4 removed it.

- [ ] **Step 6: Full verification (Node 24):** both type-checks, the full vitest suite, and `npm run test:e2e`. All green; record the counts.

- [ ] **Step 7: Commit and push the branch** (`git push -u origin feat/phase-4b`). The deploy to boxs.ca runs after the final whole-branch review: `scripts/deploy-siteground.sh`, then `git -c http.postBuffer=524288000 push --force origin deploy/siteground:deploy/siteground`. Wait about 6 minutes without polling, then check `/stack/health` and the Subscribe API.

---

## Self-review notes (for the reviewer)

- **Spec coverage:**
  - §3 `items`, `deliveries` (item × subscriber × mode, attempted at), `nod_settings`, plus `digest_runs`/`operations_log`, which the spec's reports need: Task 1.
  - §5.1 As-It-Happens: Task 5. Digest: Task 6. Emergency: Task 5. No duplicates: Tasks 1, 5 and 6. Pause/resume: Task 7. Templates stay placeholders (Q24): Task 5.
  - §5.2 render once per item × mode (a digest group is one rendering): Tasks 5 and 6.
  - §10 items 3 and 5: Task 9 e2e. Item 4: Task 6 tests plus a hand-check, since a real 17:00 can't run in e2e. Item 10: Tasks 7 and 9.
  - Carry-forward 4b: footers (Tasks 3 and 4), `List-Unsubscribe` (Task 4), one-click bucket and forwarding (Task 8), page polish (Task 9).
- **Ruling, `deliveries.delivered_at`:** the spec lists "attempted at, delivered at, hard-bounced at, Distribution message id". 4b records `attempted_at` (handed to Distribution). Delivered, bounced and message id need Distribution's per-message feedback, which arrives with bounces in 4e, so 4e adds those columns. Cost if wrong: one more migration in 4e.
- **Ruling, emergency source:** the 4g RSS ingester will call `recordEmergencyItem`. Until then, an admin-only API creates emergency items, so §10 item 5 is testable now and boxs.ca can be hand-checked.
- **Ruling, `release.updated`:** it refreshes an existing item but never creates one, because the 3e replay sends every live release as `release.updated` and those must not enter a digest.
- **Ruling, digest cutoff:** computed in Node from the database's `now()`. Postgres's tzdata may not know BC's permanent UTC−7, while Node 24's (2026c) is asserted at startup.
