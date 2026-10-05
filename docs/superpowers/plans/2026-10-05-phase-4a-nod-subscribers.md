# Phase 4a — NoD Subscriber Model and Subscribe API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Members of the public can subscribe, confirm by email, manage their preferences, change their email and unsubscribe through the legacy Subscribe API (via the News API proxy), on NoD's new subscriber model, with working test pages on boxs.ca.

**Architecture:** NoD gains the Phase 4 subscriber columns, list categories and lists (mirrored from Core's org/sector/theme/tag events), one-time links stored only as hashes, an HMAC-derived stable unsubscribe token, and a subscriber history. A `subscribe/` module in NoD implements the seven legacy Subscribe endpoints plus RFC 8058 one-click unsubscribe, behind a new service role. The News API's existing proxy gets a local service token on test sites, so the whole path works on boxs.ca. The public site writes three static test pages whose script calls the News API, the same path gcpe-news-webapp uses.

**Tech Stack:** Node 24, TypeScript 5.9 strict, Express 5, Drizzle 0.45 / drizzle-kit 0.31, zod 3.25, Vitest 4.1, supertest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-05-nod-distribution-parity-design.md` §3 (data model, the parts 4a needs), §4 (journeys, test-site pages, rate limiting), §10 acceptance items 1–2. Changes C48–C51 and C57; new C60 and Q28 (Task 8).

## Global Constraints

- New worktree `/Users/paul/gcpe-news-platform-p4`, branch `feat/phase-4`, created from `feat/phase-3` (Task 1 step 1). Commit locally after each task. Never add a `Co-Authored-By` trailer or any AI attribution. Never commit `CLAUDE.md`.
- **Node 24 for everything** (tzdata ≥ 2026b; under Node 22 two time-zone tests fail). Tests: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run <paths>`. Type-check: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json` and `… -p apps/staff-web/tsconfig.json`. E2E: `npx -y -p node@24 -- npm run test:e2e`.
- Migrations: generate with drizzle-kit (`cd apps/nod && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name <name>`); data-copy migrations use `--custom`. Never hand-edit a generated migration's DDL.
- Database time comparisons use the database clock (`now()` in SQL), never a JS `Date` against a DB timestamp.
- **Legacy API paths and JSON shapes are fixed** (`docs/contracts/news-api-v1.swagger.json`): `SubscriberInfo` = `{ emailAddress, subscribedCategories: { [categoryKey]: string[] }, isAllNews, isAsItHappens, isDailyDigest, isAdminRegistration, notifyIfNewCategories, expiredLinkOrUnverifiedEmail }`, camelCase. `SubscriptionItems` returns `[{ key, value }]`.
- **Email wording (legacy, `SubscriptionProvider.cs` + Web.config):**
  - Verification subject `BC Gov News On Demand Email Verification`, body "Confirm your request" / "Thank you for subscribing to BC Gov News On Demand." / "To confirm your request and begin receiving communications by email, click here: <link>".
  - Manage subject `BC Gov News On Demand Subscription Management`, body "To log in and manage your subscription, click here: <link>".
  - Priority `system`.
- Links expire 24 hours after creation (legacy `AuthenticationTimeout`). At most 3 verification/manage emails per address per rolling hour; beyond that the API answers exactly as if it had sent one.
- **Anti-enumeration:** no Subscribe endpoint's response may differ depending on whether an email address is subscribed.
- **Tokens only (C60):** the `{tokenGuid}` path parameter of Update and Unsubscribe is a link or unsubscribe token, never an email address. Legacy treated an email there as an admin action.
- Category keys (Q28 working assumption): `ministries`, `sectors`, `themes`, `tags`, `emergency`, `media-distribution-lists`. "All news" is `isAllNews` ↔ list key `*`. `media-distribution-lists` is never offered or accepted through the public API.
- No email addresses, tokens or secrets in logs.

## Review Focus

1. **The same email typed with different case or surrounding spaces** (`" Pat@Example.com "` vs `pat@example.com`): one subscriber, and the anti-enumeration path, never a second row or a 500. Pinned in Task 5 ("normalises case and spaces").
2. **A link clicked twice, or after it was used to confirm:** the second click shows the current preferences (a manage view), never re-applies stale pending preferences and never errors. Pinned in Task 5 ("confirm twice").
3. **An expired link:** Confirm returns `expiredLinkOrUnverifiedEmail: true` and changes nothing; Update with it is refused; CheckEmailActivationToken says `false`. Pinned in Task 5 ("expired link").
4. **Subscribe with no lists and not all news, or with neither timing option:** refused with a readable 400, never a subscriber who can receive nothing. Pinned in Task 4 ("rejects empty preferences").
5. **A preference naming a list that doesn't exist or is inactive, or the media category:** silently dropped (legacy ignores unknown keys); if nothing valid remains, rule 4 applies. Pinned in Task 4 ("drops unknown and media lists").

---

## File structure

| File | Responsibility |
|---|---|
| `apps/nod/src/db/schema.ts` | Adds subscriber columns, `list_categories`, `lists`, `subscriber_links`, `subscriber_history` |
| `apps/nod/migrations/0004…0006` | Generated DDL + custom backfill/seed |
| `apps/nod/src/lists.ts` | Core events → `lists`; public list items; `needsReferenceData` |
| `apps/nod/src/subscribe/tokens.ts` | Random link tokens, hashing, HMAC unsubscribe tokens |
| `apps/nod/src/subscribe/links.ts` | Create/find links, per-email rate count |
| `apps/nod/src/subscribe/history.ts` | `writeHistory` |
| `apps/nod/src/subscribe/info.ts` | `SubscriberInfo` zod schema, info → prefs, subscriber → info |
| `apps/nod/src/subscribe/emails.ts` | Verification/manage/change-email messages and sending |
| `apps/nod/src/subscribe/journeys.ts` | Subscribe, confirm, update, manage link, check, unsubscribe |
| `apps/nod/src/http/subscribe-routes.ts` | `/api/Subscribe/*` routes |
| `apps/nod/src/subscribers.ts`, `as-it-happens.ts` | Moved to subscriber-level timing and `status` |
| `apps/nod/src/app.ts`, `start.ts` | Wiring: Core handler, subscribe routes, `LINK_SECRET`, `SUBSCRIBE_PAGE_URL` |
| `packages/auth/src/roles.ts` | `NOD_SUBSCRIBE_API_ROLE` |
| `apps/news-api/src/start.ts`, `http/v1/subscribe.ts` | Local service token; `OneClickUnsubscribe` route |
| `apps/stack/src/env.ts`, `stack.ts` | Core→NoD event route; News API's NoD URL default; NoD link secret; reference-data backfill |
| `apps/core/src/start.ts` | `republish` worker |
| `apps/public-site/src/subscribe-pages.ts`, `self-heal.ts` | The three test pages |
| `tests/e2e/subscribe-journey.spec.ts` | Acceptance items 1–2 end to end |

---

### Task 1: Worktree, schema and migrations

**Files:**
- Modify: `apps/nod/src/db/schema.ts`, `apps/nod/src/subscribers.ts`, `apps/nod/src/as-it-happens.ts`
- Create: `apps/nod/migrations/0004_subscriber_model.sql` (generated), `0005_backfill_subscriber_model.sql` (custom), `0006_drop_subscription_timing.sql` (generated)
- Test: `apps/nod/src/db/migrations.test.ts` (new), `apps/nod/src/subscribers.test.ts`, `apps/nod/src/as-it-happens.test.ts`

**Interfaces:**
- Produces: tables `subscribers` (new columns `status`, `asItHappens`, `digest`, `source`, `mediaHubContactId`, `endedAt`, `unsubscribeVersion`), `listCategories`, `lists`, `subscriberLinks`, `subscriberHistory`; types `SubscriberStatus`, `SubscriberSource`, `LinkPurpose`, `SubscriberPrefs`. `addSubscriber` and `countSubscribers` keep their signatures.

- [ ] **Step 1: Create the worktree**

```bash
cd /Users/paul/gcpe-news-platform-p3 && git worktree add -b feat/phase-4 /Users/paul/gcpe-news-platform-p4 feat/phase-3
cd /Users/paul/gcpe-news-platform-p4 && npx -y npm@11 ci
```

- [ ] **Step 2: Add the new columns and tables to the schema (keep `subscriptions.as_it_happens` for now)**

In `apps/nod/src/db/schema.ts`, add `check` is already imported; add these exports above `subscribers` and extend `subscribers`:

```ts
export const SUBSCRIBER_STATUSES = ["pending", "active", "disabled", "deleted"] as const;
export type SubscriberStatus = (typeof SUBSCRIBER_STATUSES)[number];
export const SUBSCRIBER_SOURCES = ["self", "admin", "media-hub", "manual-media"] as const;
export type SubscriberSource = (typeof SUBSCRIBER_SOURCES)[number];

export const subscribers = pgTable(
  "subscribers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    manageToken: text("manage_token").notNull().unique(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Phase 4 (spec §3). Timing lives on the subscriber, as in legacy (Subscriber.ImmediateDelivery
    // / DigestDelivery). Only `active` subscribers receive mail.
    status: text("status").$type<SubscriberStatus>().notNull().default("pending"),
    asItHappens: boolean("as_it_happens").notNull().default(true),
    digest: boolean("digest").notNull().default(false),
    source: text("source").$type<SubscriberSource>().notNull().default("self"),
    mediaHubContactId: integer("media_hub_contact_id"),
    // Set when the subscriber unsubscribes, is deleted, or moves to a new address; drives the
    // 90-day purge (4g).
    endedAt: timestamp("ended_at", { withTimezone: true }),
    // Bumped to invalidate every unsubscribe token issued so far (tokens.ts): on email change.
    unsubscribeVersion: integer("unsubscribe_version").notNull().default(1),
  },
  (t) => [
    uniqueIndex("subscribers_email_lower_idx").on(sql`lower(${t.email})`),
    check("subscribers_status_check", sql`${t.status} IN ('pending','active','disabled','deleted')`),
    check("subscribers_source_check", sql`${t.source} IN ('self','admin','media-hub','manual-media')`),
  ],
);
```

Append the new tables:

```ts
export const listCategories = pgTable("list_categories", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
});

/** One subscribable list. `listKey` is `<category>:<key>` — the same shape as
 * `@gcpe/events`' `indexKeysFor` output and `subscriptions.list_key`, so matching a release to
 * subscribers stays a plain string comparison. */
export const lists = pgTable(
  "lists",
  {
    listKey: text("list_key").primaryKey(),
    category: text("category").notNull().references(() => listCategories.key),
    key: text("key").notNull(),
    name: text("name").notNull(),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    topicUrl: text("topic_url").notNull().default(""),
  },
  (t) => [uniqueIndex("lists_category_key_idx").on(t.category, t.key)],
);

export const LINK_PURPOSES = ["verify", "manage", "change-email"] as const;
export type LinkPurpose = (typeof LINK_PURPOSES)[number];

/** What a subscriber asked for — stored on a pending link until it's confirmed. */
export interface SubscriberPrefs {
  allNews: boolean;
  listKeys: string[];
  asItHappens: boolean;
  digest: boolean;
}

/** One-time links (spec §3). Only a SHA-256 of the token is stored (C48). */
export const subscriberLinks = pgTable(
  "subscriber_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull().unique(),
    purpose: text("purpose").$type<LinkPurpose>().notNull(),
    subscriberId: uuid("subscriber_id").references(() => subscribers.id, { onDelete: "cascade" }),
    // Lowercased target address: the address being verified (verify, change-email) or the
    // subscriber's own (manage). Also what the per-address rate limit counts on.
    email: text("email").notNull(),
    pending: jsonb("pending").$type<SubscriberPrefs>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // When the pending preferences (or pending email change) were applied. The link keeps
    // working as a manage session until it expires.
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [
    index("subscriber_links_email_created_idx").on(t.email, t.createdAt),
    check("subscriber_links_purpose_check", sql`${t.purpose} IN ('verify','manage','change-email')`),
  ],
);

/** Replaces legacy SysLog for subscribers: feeds the History screen and reports (4f). */
export const subscriberHistory = pgTable(
  "subscriber_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriberId: uuid("subscriber_id").notNull().references(() => subscribers.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    detail: text("detail").notNull().default(""),
  },
  (t) => [index("subscriber_history_subscriber_at_idx").on(t.subscriberId, t.at)],
);
```

Add `index` to the `drizzle-orm/pg-core` import.

- [ ] **Step 3: Generate the DDL migration**

Run: `cd apps/nod && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name subscriber_model`
Expected: `migrations/0004_subscriber_model.sql` with `ALTER TABLE "subscribers" ADD COLUMN …` and `CREATE TABLE "list_categories" …` etc.

- [ ] **Step 4: Write the backfill/seed migration**

Run: `cd apps/nod && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --custom --name backfill_subscriber_model`, then fill `0005_backfill_subscriber_model.sql`:

```sql
-- Phase 2 subscribers: verified ones become active; timing moves up from the subscription rows.
UPDATE "subscribers" s
   SET "status" = CASE WHEN s."verified_at" IS NULL THEN 'pending' ELSE 'active' END,
       "as_it_happens" = COALESCE((SELECT bool_or(sub."as_it_happens") FROM "subscriptions" sub WHERE sub."subscriber_id" = s."id"), true);
--> statement-breakpoint
INSERT INTO "list_categories" ("key", "name", "enabled", "sort_order") VALUES
  ('ministries', 'Ministries', true, 1),
  ('sectors', 'Sectors', true, 2),
  ('themes', 'Themes', true, 3),
  ('tags', 'Tags', true, 4),
  ('emergency', 'Emergency Info BC', true, 5),
  ('media-distribution-lists', 'Media distribution lists', true, 6)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "lists" ("list_key", "category", "key", "name", "sort_order") VALUES
  ('emergency:alerts', 'emergency', 'alerts', 'Emergency Info BC Alerts', 1)
ON CONFLICT ("list_key") DO NOTHING;
```

- [ ] **Step 5: Drop the per-subscription timing column and generate**

Remove `asItHappens` from `subscriptions` in `schema.ts`, then run `generate --name drop_subscription_timing`.
Expected: `0006_drop_subscription_timing.sql` containing `ALTER TABLE "subscriptions" DROP COLUMN "as_it_happens";`.

- [ ] **Step 6: Write the failing migration test**

Create `apps/nod/src/db/migrations.test.ts`. It applies migrations 0000–0003, inserts Phase 2 rows, then applies the rest:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";
import { nodMigrations } from "../../test/helpers";

describe("0005 backfill", () => {
  let tdb: TestDatabase | undefined;
  afterEach(async () => tdb?.drop());

  it("activates verified Phase 2 subscribers, keeps unverified ones pending, and lifts timing to the subscriber", async () => {
    tdb = await createTestDatabase({ migrationsFolder: nodMigrations, upTo: "0003_freeze_chunks" });
    await tdb.db.execute(sql`
      INSERT INTO subscribers (id, email, manage_token, verified_at) VALUES
        ('00000000-0000-0000-0000-000000000001', 'a@example.test', 't1', now()),
        ('00000000-0000-0000-0000-000000000002', 'b@example.test', 't2', NULL);
      INSERT INTO subscriptions (subscriber_id, list_key, as_it_happens) VALUES
        ('00000000-0000-0000-0000-000000000001', '*', false),
        ('00000000-0000-0000-0000-000000000002', 'ministries:health', true);`);
    await tdb.migrate();
    const rows = await tdb.db.execute<{ email: string; status: string; as_it_happens: boolean }>(
      sql`SELECT email, status, as_it_happens FROM subscribers ORDER BY email`);
    expect(rows.rows).toEqual([
      { email: "a@example.test", status: "active", as_it_happens: false },
      { email: "b@example.test", status: "pending", as_it_happens: true },
    ]);
    const cats = await tdb.db.execute<{ key: string }>(sql`SELECT key FROM list_categories ORDER BY sort_order`);
    expect(cats.rows.map((r) => r.key)).toEqual(["ministries", "sectors", "themes", "tags", "emergency", "media-distribution-lists"]);
  });
});
```

If `createTestDatabase` has no `upTo`/`migrate()` support, add it in `packages/db-kit` (a migrations-folder copy holding only the journal entries up to the named tag; `migrate()` runs the full folder). Check first: `grep -n "upTo\|migrate" packages/db-kit/src/*.ts`. If you add it, give it its own test in `packages/db-kit`.

- [ ] **Step 7: Run it; expect the backfill assertions to pass once Steps 2–5 are in**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/db/migrations.test.ts`
Expected: PASS. If it fails on `upTo`, finish the db-kit helper first.

- [ ] **Step 8: Move the senders and counters to subscriber-level timing**

`apps/nod/src/as-it-happens.ts`, in the `INSERT INTO deliveries … SELECT`:

```sql
       WHERE s.status = 'active'
         AND s.as_it_happens = true
         AND ${listKeyMatch}
```

(replacing `s.verified_at IS NOT NULL AND sub.as_it_happens = true`).

`apps/nod/src/subscribers.ts`:
- `addSubscriber` inserts `{ email: input.email, manageToken, verifiedAt: new Date(), status: "active", source: "admin", asItHappens: true }` and subscription rows without `asItHappens`.
- `countSubscribers` filters `WHERE s.status = 'active' AND sub.list_key = ANY(…)`.

`apps/nod/src/send-jobs.ts`: replace any `verified_at IS NOT NULL` recipient filter with `status = 'active'` (`grep -n "verified" apps/nod/src/send-jobs.ts`).

- [ ] **Step 9: Add the tests that pin the new filters**

In `apps/nod/src/as-it-happens.test.ts` add:

```ts
it("skips pending and digest-only subscribers", async () => {
  await tdb.db.execute(sql`
    INSERT INTO subscribers (id, email, manage_token, status, as_it_happens, digest) VALUES
      ('00000000-0000-0000-0000-0000000000a1', 'on@example.test', 'ta1', 'active', true, false),
      ('00000000-0000-0000-0000-0000000000a2', 'pending@example.test', 'ta2', 'pending', true, false),
      ('00000000-0000-0000-0000-0000000000a3', 'digest@example.test', 'ta3', 'active', false, true);
    INSERT INTO subscriptions (subscriber_id, list_key) VALUES
      ('00000000-0000-0000-0000-0000000000a1', '*'),
      ('00000000-0000-0000-0000-0000000000a2', '*'),
      ('00000000-0000-0000-0000-0000000000a3', '*');`);
  const res = await sendEvent(app, envelope("nrms", "release.published", sampleRelease({ key: "K-TIMING" })));
  expect(res.status).toBe(200);
  const rows = await tdb.db.execute<{ subscriber_id: string }>(sql`SELECT subscriber_id FROM deliveries WHERE release_key = 'K-TIMING'`);
  expect(rows.rows.map((r) => r.subscriber_id)).toEqual(["00000000-0000-0000-0000-0000000000a1"]);
});
```

(Use the file's existing `app`/`tdb` setup and `sampleRelease` import; adapt the key option name to `sampleRelease`'s signature.)

- [ ] **Step 10: Run all NoD tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod`
Expected: PASS (fix any Phase 2 test that inserted `subscriptions.as_it_happens`, by setting `subscribers.as_it_happens` instead).

- [ ] **Step 11: Commit**

```bash
git add apps/nod packages/db-kit
git commit -m "feat(nod): Phase 4 subscriber model — status, subscriber-level timing, lists, links, history"
```

---

### Task 2: Lists from Core events, and the reference-data backfill

**Files:**
- Create: `apps/nod/src/lists.ts`, `apps/nod/src/lists.test.ts`
- Modify: `apps/nod/src/app.ts`, `apps/nod/src/start.ts`, `apps/nod/test/helpers.ts`, `apps/core/src/start.ts`, `apps/stack/src/env.ts`, `apps/stack/src/stack.ts`, `apps/stack/src/env.test.ts`

**Interfaces:**
- Consumes: `lists`, `listCategories` (Task 1); `OrgRecord`, `TermRecord`, `EventHandler`, `EventEnvelope` from `@gcpe/events`.
- Produces: `listsHandler(event: EventEnvelope): EventHandler | undefined`; `publicListItems(db: DbOrTx, categoryKey: string): Promise<{ key: string; value: string }[]>`; `PUBLIC_CATEGORIES: readonly string[]`; `activeListKeys(db: DbOrTx, listKeys: string[]): Promise<string[]>`; `needsReferenceData(db: DbOrTx): Promise<boolean>`; NoD worker `needsReferenceData`; Core worker `republish`.

- [ ] **Step 1: Write the failing tests**

`apps/nod/src/lists.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb, createTestApp, envelope, sendEvent } from "../test/helpers";
import { activeListKeys, needsReferenceData, publicListItems } from "./lists";

describe("lists from Core events", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createTestApp>;
  beforeAll(async () => { tdb = await createNodTestDb(); app = createTestApp(tdb.db); });
  afterAll(async () => tdb.drop());
  beforeEach(async () => { await tdb.db.execute(sql`DELETE FROM lists WHERE category <> 'emergency'`); });

  const org = (key: string, displayName: string, isActive = true) =>
    envelope("core", "org.upserted", { key, displayName, abbreviation: "X", sortOrder: 2, isActive }, `org:${key}`);

  it("creates and renames a ministry list, lowercasing the key", async () => {
    expect((await sendEvent(app, org("Health", "Ministry of Health"))).status).toBe(200);
    expect((await sendEvent(app, org("Health", "Health"))).status).toBe(200);
    expect(await publicListItems(tdb.db, "ministries")).toEqual([{ key: "health", value: "Health" }]);
  });

  it("deactivating hides the list from the public items but keeps the row", async () => {
    await sendEvent(app, org("agri", "Agriculture"));
    await sendEvent(app, envelope("core", "org.deactivated", { key: "agri" }, "org:agri"));
    expect(await publicListItems(tdb.db, "ministries")).toEqual([]);
    expect(await activeListKeys(tdb.db, ["ministries:agri"])).toEqual([]);
  });

  it("maps sector/theme/tag terms to their categories", async () => {
    await sendEvent(app, envelope("core", "sector.upserted", { kind: "sector", key: "Mining", displayName: "Mining", sortOrder: 1, isActive: true }, "sector:mining"));
    expect(await publicListItems(tdb.db, "sectors")).toEqual([{ key: "mining", value: "Mining" }]);
  });

  it("never exposes media lists or unknown categories publicly", async () => {
    await tdb.db.execute(sql`INSERT INTO lists (list_key, category, key, name) VALUES ('media-distribution-lists:budget', 'media-distribution-lists', 'budget', 'Budget')`);
    expect(await publicListItems(tdb.db, "media-distribution-lists")).toEqual([]);
    expect(await publicListItems(tdb.db, "nope")).toEqual([]);
    expect(await activeListKeys(tdb.db, ["media-distribution-lists:budget", "*"])).toEqual(["*"]);
  });

  it("needsReferenceData is true until a ministry list exists", async () => {
    expect(await needsReferenceData(tdb.db)).toBe(true);
    await sendEvent(app, org("health", "Health"));
    expect(await needsReferenceData(tdb.db)).toBe(false);
  });
});
```

Add to `apps/nod/test/helpers.ts` a `createTestApp(db)` that calls `createApp` with the same options `routes.test.ts` uses (issuer/audience/keys can be any `BearerOptions`; events only need `eventSecrets`) and `subscribe` options from Task 6 left `undefined` for now. Add `core: "core-secret"` to `EVENT_SECRETS` if missing (it's already there).

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/lists.test.ts`
Expected: FAIL (`./lists` not found).

- [ ] **Step 3: Implement `lists.ts`**

```ts
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import type { EventEnvelope, EventHandler, OrgRecord, TermRecord } from "@gcpe/events";
import { listCategories, lists } from "./db/schema";

/** Categories the public Subscribe API offers (spec §4). Media lists are staff-managed (4c). */
export const PUBLIC_CATEGORIES = ["ministries", "sectors", "themes", "tags", "emergency"] as const;
const TERM_CATEGORY = { sector: "sectors", theme: "themes", tag: "tags" } as const;

async function upsertList(tx: DbOrTx, category: string, key: string, name: string, sortOrder: number, active: boolean) {
  const k = key.toLowerCase();
  const row = { listKey: `${category}:${k}`, category, key: k, name, sortOrder, active };
  await tx.insert(lists).values(row).onConflictDoUpdate({ target: lists.listKey, set: { name, sortOrder, active } });
}
async function deactivate(tx: DbOrTx, category: string, key: string) {
  await tx.update(lists).set({ active: false }).where(eq(lists.listKey, `${category}:${key.toLowerCase()}`));
}

const onOrg: EventHandler = async (tx, e) => {
  const o = e.data as OrgRecord;
  await upsertList(tx, "ministries", o.key, o.displayName, o.sortOrder, o.isActive);
};
const onOrgGone: EventHandler = async (tx, e) => deactivate(tx, "ministries", (e.data as { key: string }).key);
const onTerm: EventHandler = async (tx, e) => {
  const t = e.data as TermRecord;
  const category = TERM_CATEGORY[t.kind as keyof typeof TERM_CATEGORY];
  if (!category) return; // services etc. are not subscribable
  await upsertList(tx, category, t.key, t.displayName ?? t.key, t.sortOrder, t.isActive);
};
const onTermGone: EventHandler = async (tx, e) => {
  const d = e.data as { kind: string; key: string };
  const category = TERM_CATEGORY[d.kind as keyof typeof TERM_CATEGORY];
  if (category) await deactivate(tx, category, d.key);
};

/** Core's org/sector/theme/tag events → NoD's `lists` (spec §3). */
export function listsHandler(event: EventEnvelope): EventHandler | undefined {
  if (event.source !== "core") return undefined;
  switch (event.type) {
    case "org.upserted": return onOrg;
    case "org.deactivated": return onOrgGone;
    case "sector.upserted": case "theme.upserted": case "tag.upserted": return onTerm;
    case "sector.deactivated": case "theme.deactivated": case "tag.deactivated": return onTermGone;
    default: return undefined;
  }
}

/** Legacy `SubscriptionItems/{categoryKey}`: active lists of an enabled public category. */
export async function publicListItems(db: DbOrTx, categoryKey: string): Promise<{ key: string; value: string }[]> {
  if (!(PUBLIC_CATEGORIES as readonly string[]).includes(categoryKey)) return [];
  const rows = await db
    .select({ key: lists.key, value: lists.name })
    .from(lists)
    .innerJoin(listCategories, eq(listCategories.key, lists.category))
    .where(and(eq(lists.category, categoryKey), eq(lists.active, true), eq(listCategories.enabled, true)))
    .orderBy(asc(lists.sortOrder), asc(lists.name));
  return rows;
}

/** The subset of `listKeys` a member of the public may subscribe to: `*`, or an active list in
 * an enabled public category. Order follows the input; duplicates removed. */
export async function activeListKeys(db: DbOrTx, listKeys: string[]): Promise<string[]> {
  const wanted = [...new Set(listKeys.map((k) => k.toLowerCase()))];
  const named = wanted.filter((k) => k !== "*");
  const found = named.length
    ? await db
        .select({ listKey: lists.listKey })
        .from(lists)
        .innerJoin(listCategories, eq(listCategories.key, lists.category))
        .where(and(inArray(lists.listKey, named), eq(lists.active, true), eq(listCategories.enabled, true), inArray(lists.category, [...PUBLIC_CATEGORIES])))
    : [];
  const ok = new Set(found.map((r) => r.listKey));
  return wanted.filter((k) => k === "*" || ok.has(k));
}

/** True until Core's reference data has reached NoD (no ministry list yet) — the stack then
 * asks Core to republish (Task 2 step 5). */
export async function needsReferenceData(db: DbOrTx): Promise<boolean> {
  const r = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${lists} WHERE ${lists.category} = 'ministries'`);
  return r.rows[0]!.n === 0;
}
```

- [ ] **Step 4: Wire the handler into the app**

`apps/nod/src/app.ts`, in `createEventReceiver`'s `handlers`:

```ts
handlers: (ev) => (ev.source === "nrms" && ev.type === "release.published" ? handler : listsHandler(ev)),
```

`apps/nod/src/start.ts`, `workers`: add `needsReferenceData: () => needsReferenceData(db)`.

- [ ] **Step 5: Stack — route Core's events to NoD, and backfill once**

`apps/stack/src/env.ts`, `INTERNAL_EVENT_ROUTES`, after the CORE→NRMS route:

```ts
  {
    from: "CORE", source: "core", to: "NOD", name: "nod", url: "self:/nod/events",
    types: ["org.upserted", "org.deactivated", "sector.upserted", "sector.deactivated", "theme.upserted", "theme.deactivated", "tag.upserted", "tag.deactivated"],
  },
```

Update the doc comment above it ("NoD consumes release.published and Core's taxonomy events…"). In `apps/stack/src/env.test.ts` add a test that `internalEventEnv(secret).NOD.EVENT_SECRETS` has both `core` and `nrms` keys.

`apps/core/src/start.ts`, `workers`: add `republish: () => republishAll(db, subscribers)` (import from `./services/republish`).

`apps/stack/src/stack.ts`, after the existing `void siteBuilder.selfHeal()…` block:

```ts
  // Phase 4a: NoD's lists come from Core's events, which only flow on change. A NoD with no
  // ministry lists yet (first deploy, or a fresh database) asks Core to republish everything
  // once; the events reach NoD on the next dispatch tick. Fire-and-forget, never throws.
  void (async () => {
    try {
      if (await nod.workers.needsReferenceData!()) {
        const n = await core.workers.republish!();
        console.log(`[stack] NoD had no lists; Core republished ${String(n)} reference records`);
      }
    } catch (e) {
      console.error("[stack] reference-data backfill failed", e instanceof Error ? e.message : e);
    }
  })();
```

Add a stack test (`apps/stack/src/stack.test.ts`, alongside the existing startup tests): after startup plus one tick, `GET /api/Subscribe/SubscriptionItems/ministries` — skip this assertion until Task 6 wires the route; for now assert NoD's `lists` has a `ministries:` row after `tick()`, using the test's existing Core seed.

- [ ] **Step 6: Run the tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod apps/stack apps/core`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/nod apps/stack apps/core
git commit -m "feat(nod): lists mirrored from Core events; stack backfills reference data once"
```

---

### Task 3: Tokens, links and history

**Files:**
- Create: `apps/nod/src/subscribe/tokens.ts`, `links.ts`, `history.ts`, and `tokens.test.ts`, `links.test.ts`

**Interfaces:**
- Consumes: `subscriberLinks`, `subscriberHistory`, `LinkPurpose`, `SubscriberPrefs` (Task 1).
- Produces:
  - `newLinkToken(): string` (43-char base64url), `hashToken(token: string): string` (hex SHA-256)
  - `unsubscribeToken(secret: string, subscriberId: string, version: number): string`
  - `parseUnsubscribeToken(secret: string, token: string): { subscriberId: string; version: number } | null`
  - `LINK_TTL_MS = 86_400_000`, `MAX_EMAILS_PER_HOUR = 3`
  - `createLink(tx: DbOrTx, input: { purpose: LinkPurpose; email: string; subscriberId: string | null; pending: SubscriberPrefs | null }): Promise<{ id: string; token: string }>`
  - `findLink(db: DbOrTx, token: string): Promise<LinkRow | null>` where `LinkRow = typeof subscriberLinks.$inferSelect & { expired: boolean }`
  - `markLinkUsed(tx: DbOrTx, id: string): Promise<void>`
  - `linksSentLastHour(db: DbOrTx, email: string): Promise<number>`
  - `writeHistory(tx: DbOrTx, subscriberId: string, actor: string, action: HistoryAction, detail?: string): Promise<void>` with `HistoryAction = "subscribed" | "confirmed" | "preferences-updated" | "email-change-requested" | "email-changed" | "unsubscribed"`

- [ ] **Step 1: Write the failing tests**

`apps/nod/src/subscribe/tokens.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { hashToken, newLinkToken, parseUnsubscribeToken, unsubscribeToken } from "./tokens";

const SECRET = "s".repeat(32);
const ID = "3f1c2e4a-1b2c-4d5e-8f90-123456789abc";

describe("tokens", () => {
  it("link tokens are 43-char base64url and differ every time", () => {
    const a = newLinkToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newLinkToken()).not.toBe(a);
  });
  it("hashToken is stable hex sha-256", () => {
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("an unsubscribe token round-trips and names its subscriber and version", () => {
    expect(parseUnsubscribeToken(SECRET, unsubscribeToken(SECRET, ID, 2))).toEqual({ subscriberId: ID, version: 2 });
  });
  it("rejects a tampered, foreign-secret or malformed unsubscribe token", () => {
    const t = unsubscribeToken(SECRET, ID, 1);
    expect(parseUnsubscribeToken(SECRET, t.slice(0, -1) + (t.endsWith("A") ? "B" : "A"))).toBeNull();
    expect(parseUnsubscribeToken("x".repeat(32), t)).toBeNull();
    expect(parseUnsubscribeToken(SECRET, "pat@example.com")).toBeNull();
    expect(parseUnsubscribeToken(SECRET, "")).toBeNull();
  });
});
```

`apps/nod/src/subscribe/links.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../../test/helpers";
import { createLink, findLink, linksSentLastHour, markLinkUsed } from "./links";
import { hashToken } from "./tokens";

describe("links", () => {
  let tdb: TestDatabase;
  beforeAll(async () => { tdb = await createNodTestDb(); });
  afterAll(async () => tdb.drop());

  it("stores only the hash, lowercases the email, and finds the link by its token", async () => {
    const { id, token } = await createLink(tdb.db, { purpose: "verify", email: "Pat@Example.TEST", subscriberId: null, pending: { allNews: true, listKeys: ["*"], asItHappens: true, digest: false } });
    const raw = await tdb.db.execute<{ token_hash: string; email: string }>(sql`SELECT token_hash, email FROM subscriber_links WHERE id = ${id}`);
    expect(raw.rows[0]).toEqual({ token_hash: hashToken(token), email: "pat@example.test" });
    const found = await findLink(tdb.db, token);
    expect(found?.id).toBe(id);
    expect(found?.expired).toBe(false);
    expect(await findLink(tdb.db, "not-a-token")).toBeNull();
  });

  it("reports expiry by the database clock", async () => {
    const { id, token } = await createLink(tdb.db, { purpose: "manage", email: "old@example.test", subscriberId: null, pending: null });
    await tdb.db.execute(sql`UPDATE subscriber_links SET expires_at = now() - interval '1 second' WHERE id = ${id}`);
    expect((await findLink(tdb.db, token))?.expired).toBe(true);
  });

  it("counts links created for an address in the last hour, case-insensitively", async () => {
    for (let i = 0; i < 2; i++) await createLink(tdb.db, { purpose: "manage", email: "count@example.test", subscriberId: null, pending: null });
    await tdb.db.execute(sql`UPDATE subscriber_links SET created_at = now() - interval '2 hours' WHERE email = 'count@example.test' AND id = (SELECT id FROM subscriber_links WHERE email = 'count@example.test' LIMIT 1)`);
    expect(await linksSentLastHour(tdb.db, "COUNT@example.test")).toBe(1);
  });

  it("markLinkUsed stamps used_at", async () => {
    const { id, token } = await createLink(tdb.db, { purpose: "verify", email: "u@example.test", subscriberId: null, pending: null });
    await markLinkUsed(tdb.db, id);
    expect((await findLink(tdb.db, token))?.usedAt).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/subscribe`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `tokens.ts`**

```ts
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const newLinkToken = (): string => randomBytes(32).toString("base64url");
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const mac = (secret: string, id: string, version: number) =>
  createHmac("sha256", secret).update(`nod-unsubscribe:${id}:${version}`).digest("base64url");

/** Stable per-subscriber unsubscribe token for `List-Unsubscribe` (C48): `<id>.<version>.<mac>`.
 * Derived, never stored; bumping `subscribers.unsubscribe_version` invalidates every earlier one. */
export function unsubscribeToken(secret: string, subscriberId: string, version: number): string {
  return `${subscriberId}.${version}.${mac(secret, subscriberId, version)}`;
}

export function parseUnsubscribeToken(secret: string, token: string): { subscriberId: string; version: number } | null {
  const [id, v, sig, ...rest] = token.split(".");
  if (rest.length || !id || !v || !sig || !UUID.test(id) || !/^\d{1,9}$/.test(v)) return null;
  const version = Number(v);
  const expected = Buffer.from(mac(secret, id, version));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { subscriberId: id, version };
}
```

- [ ] **Step 4: Implement `links.ts` and `history.ts`**

`links.ts`:

```ts
import { eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import { subscriberLinks, type LinkPurpose, type SubscriberPrefs } from "../db/schema";
import { hashToken, newLinkToken } from "./tokens";

export const LINK_TTL_MS = 24 * 3_600_000;
export const MAX_EMAILS_PER_HOUR = 3;
export type LinkRow = typeof subscriberLinks.$inferSelect & { expired: boolean };

export async function createLink(
  tx: DbOrTx,
  input: { purpose: LinkPurpose; email: string; subscriberId: string | null; pending: SubscriberPrefs | null },
): Promise<{ id: string; token: string }> {
  const token = newLinkToken();
  const [row] = await tx
    .insert(subscriberLinks)
    .values({
      tokenHash: hashToken(token),
      purpose: input.purpose,
      email: input.email.trim().toLowerCase(),
      subscriberId: input.subscriberId,
      pending: input.pending,
      expiresAt: sql`now() + make_interval(secs => ${LINK_TTL_MS / 1000})`,
    })
    .returning({ id: subscriberLinks.id });
  return { id: row!.id, token };
}

export async function findLink(db: DbOrTx, token: string): Promise<LinkRow | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [row] = await db
    .select({ link: subscriberLinks, expired: sql<boolean>`${subscriberLinks.expiresAt} <= now()` })
    .from(subscriberLinks)
    .where(eq(subscriberLinks.tokenHash, hashToken(token)));
  return row ? { ...row.link, expired: row.expired } : null;
}

export async function markLinkUsed(tx: DbOrTx, id: string): Promise<void> {
  await tx.update(subscriberLinks).set({ usedAt: sql`now()` }).where(eq(subscriberLinks.id, id));
}

export async function linksSentLastHour(db: DbOrTx, email: string): Promise<number> {
  const r = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM ${subscriberLinks}
     WHERE ${subscriberLinks.email} = ${email.trim().toLowerCase()} AND ${subscriberLinks.createdAt} > now() - interval '1 hour'`);
  return r.rows[0]!.n;
}
```

`history.ts`:

```ts
import type { DbOrTx } from "@gcpe/db-kit";
import { subscriberHistory } from "../db/schema";

export type HistoryAction = "subscribed" | "confirmed" | "preferences-updated" | "email-change-requested" | "email-changed" | "unsubscribed";

export async function writeHistory(tx: DbOrTx, subscriberId: string, actor: string, action: HistoryAction, detail = ""): Promise<void> {
  await tx.insert(subscriberHistory).values({ subscriberId, actor, action, detail });
}
```

- [ ] **Step 5: Run the tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/subscribe`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/nod/src/subscribe
git commit -m "feat(nod): hashed one-time links, HMAC unsubscribe tokens, subscriber history"
```

---

### Task 4: SubscriberInfo contract, preferences and emails

**Files:**
- Create: `apps/nod/src/subscribe/info.ts`, `info.test.ts`, `emails.ts`, `emails.test.ts`

**Interfaces:**
- Consumes: `activeListKeys`, `PUBLIC_CATEGORIES` (Task 2); `SubscriberPrefs`, `subscribers`, `subscriptions`, `lists` (Task 1); `DistributionClient`, `MessageRequest` (`apps/nod/src/distribution-client.ts`).
- Produces:
  - `subscriberInfoSchema` (zod), `type SubscriberInfo = z.infer<typeof subscriberInfoSchema>`
  - `class PreferencesError extends Error`
  - `toPrefs(db: DbOrTx, info: SubscriberInfo): Promise<{ email: string; prefs: SubscriberPrefs }>` — throws `PreferencesError`
  - `infoFor(db: DbOrTx, subscriberId: string): Promise<SubscriberInfo>`
  - `normaliseEmail(raw: string): string`
  - `type SystemEmailKind = "verify" | "manage" | "change-email"`
  - `renderSystemEmail(kind: SystemEmailKind, link: string): { subject: string; html: string; text: string }`
  - `linkUrl(pageUrl: string, token: string): string`
  - `sendSystemEmail(distribution: DistributionClient, to: string, kind: SystemEmailKind, link: string, idempotencyKey: string): Promise<void>` (logs and swallows failures)

- [ ] **Step 1: Write the failing tests**

`apps/nod/src/subscribe/info.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../../test/helpers";
import { PreferencesError, infoFor, normaliseEmail, subscriberInfoSchema, toPrefs } from "./info";

describe("SubscriberInfo", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNodTestDb();
    await tdb.db.execute(sql`INSERT INTO lists (list_key, category, key, name) VALUES
      ('ministries:health', 'ministries', 'health', 'Health'),
      ('ministries:old', 'ministries', 'old', 'Old'),
      ('media-distribution-lists:budget', 'media-distribution-lists', 'budget', 'Budget');
      UPDATE lists SET active = false WHERE list_key = 'ministries:old';`);
  });
  afterAll(async () => tdb.drop());

  const info = (over: Record<string, unknown>) =>
    subscriberInfoSchema.parse({ emailAddress: "pat@example.test", subscribedCategories: {}, isAllNews: false, isAsItHappens: true, isDailyDigest: false, ...over });

  it("normalises case and spaces", () => {
    expect(normaliseEmail("  Pat@Example.TEST ")).toBe("pat@example.test");
  });

  it("maps categories to list keys and all-news to *", async () => {
    expect(await toPrefs(tdb.db, info({ subscribedCategories: { ministries: ["Health"] } }))).toEqual({
      email: "pat@example.test",
      prefs: { allNews: false, listKeys: ["ministries:health"], asItHappens: true, digest: false },
    });
    expect((await toPrefs(tdb.db, info({ isAllNews: true }))).prefs.listKeys).toEqual(["*"]);
  });

  it("drops unknown and media lists", async () => {
    const r = await toPrefs(tdb.db, info({ subscribedCategories: { ministries: ["health", "old", "nope"], "media-distribution-lists": ["budget"] } }));
    expect(r.prefs.listKeys).toEqual(["ministries:health"]);
  });

  it("rejects empty preferences", async () => {
    await expect(toPrefs(tdb.db, info({ subscribedCategories: { ministries: ["nope"] } }))).rejects.toBeInstanceOf(PreferencesError);
    await expect(toPrefs(tdb.db, info({ isAllNews: true, isAsItHappens: false, isDailyDigest: false }))).rejects.toBeInstanceOf(PreferencesError);
  });

  it("rejects an invalid or over-long email", () => {
    expect(subscriberInfoSchema.safeParse({ emailAddress: "not-an-email" }).success).toBe(false);
    expect(subscriberInfoSchema.safeParse({ emailAddress: `${"a".repeat(145)}@x.test` }).success).toBe(false);
  });

  it("infoFor returns legacy-shaped preferences", async () => {
    await tdb.db.execute(sql`
      INSERT INTO subscribers (id, email, manage_token, status, as_it_happens, digest) VALUES ('00000000-0000-0000-0000-0000000000b1', 'info@example.test', 'tb1', 'active', false, true);
      INSERT INTO subscriptions (subscriber_id, list_key) VALUES ('00000000-0000-0000-0000-0000000000b1', 'ministries:health');`);
    expect(await infoFor(tdb.db, "00000000-0000-0000-0000-0000000000b1")).toEqual({
      emailAddress: "info@example.test",
      subscribedCategories: { ministries: ["health"] },
      isAllNews: false,
      isAsItHappens: false,
      isDailyDigest: true,
      isAdminRegistration: false,
      notifyIfNewCategories: false,
      expiredLinkOrUnverifiedEmail: false,
    });
  });
});
```

`apps/nod/src/subscribe/emails.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { linkUrl, renderSystemEmail, sendSystemEmail } from "./emails";

describe("system emails", () => {
  it("uses the legacy subjects and wording, with the link in both parts", () => {
    const v = renderSystemEmail("verify", "https://boxs.ca/site/subscribe/manage/?token=abc");
    expect(v.subject).toBe("BC Gov News On Demand Email Verification");
    expect(v.text).toContain("Thank you for subscribing to BC Gov News On Demand.");
    expect(v.text).toContain("To confirm your request and begin receiving communications by email, click here: https://boxs.ca/site/subscribe/manage/?token=abc");
    expect(v.html).toContain('href="https://boxs.ca/site/subscribe/manage/?token=abc"');
    expect(renderSystemEmail("manage", "https://x.test/m").subject).toBe("BC Gov News On Demand Subscription Management");
    expect(renderSystemEmail("manage", "https://x.test/m").text).toContain("To log in and manage your subscription, click here: https://x.test/m");
  });

  it("escapes the link in HTML", () => {
    expect(renderSystemEmail("manage", 'https://x.test/?a="b"&c').html).toContain("https://x.test/?a=&quot;b&quot;&amp;c");
  });

  it("linkUrl keeps an existing query and sets token", () => {
    expect(linkUrl("https://x.test/manage/?lang=fr", "t1")).toBe("https://x.test/manage/?lang=fr&token=t1");
  });

  it("sends at system priority with an idempotency key, and never throws", async () => {
    const send = vi.fn().mockResolvedValueOnce({ batchId: "b" }).mockRejectedValueOnce(new Error("down"));
    await sendSystemEmail({ send }, "pat@example.test", "verify", "https://x.test/l", "link-1");
    expect(send.mock.calls[0]![0]).toMatchObject({ priority: "system", idempotencyKey: "link-1", recipients: [{ email: "pat@example.test", substitutions: {} }] });
    await expect(sendSystemEmail({ send }, "pat@example.test", "manage", "https://x.test/l", "link-2")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/subscribe/info.test.ts apps/nod/src/subscribe/emails.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement `info.ts`**

```ts
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx } from "@gcpe/db-kit";
import { subscribers, subscriptions, type SubscriberPrefs } from "../db/schema";
import { activeListKeys } from "../lists";

/** Legacy SubscriberInfo (docs/contracts/news-api-v1.swagger.json). Unknown fields ignored;
 * `isAdminRegistration` and `notifyIfNewCategories` are accepted but never acted on (C57, C60). */
export const subscriberInfoSchema = z.object({
  emailAddress: z.string().trim().max(150).email(),
  subscribedCategories: z.record(z.array(z.string().max(200)).max(500)).default({}),
  isAllNews: z.boolean().default(false),
  isAsItHappens: z.boolean().default(false),
  isDailyDigest: z.boolean().default(false),
  isAdminRegistration: z.boolean().default(false),
  notifyIfNewCategories: z.boolean().default(false),
  expiredLinkOrUnverifiedEmail: z.boolean().default(false),
});
export type SubscriberInfo = z.infer<typeof subscriberInfoSchema>;

export class PreferencesError extends Error {}

export const normaliseEmail = (raw: string): string => raw.trim().toLowerCase();

export async function toPrefs(db: DbOrTx, info: SubscriberInfo): Promise<{ email: string; prefs: SubscriberPrefs }> {
  if (!info.isAsItHappens && !info.isDailyDigest) throw new PreferencesError("Choose As It Happens, Daily Digest, or both.");
  const requested = info.isAllNews
    ? ["*"]
    : Object.entries(info.subscribedCategories).flatMap(([category, keys]) => keys.map((k) => `${category.toLowerCase()}:${k.toLowerCase()}`));
  const listKeys = await activeListKeys(db, requested);
  if (listKeys.length === 0) throw new PreferencesError("Choose at least one topic, or all news.");
  return { email: normaliseEmail(info.emailAddress), prefs: { allNews: listKeys.includes("*"), listKeys, asItHappens: info.isAsItHappens, digest: info.isDailyDigest } };
}

export async function infoFor(db: DbOrTx, subscriberId: string): Promise<SubscriberInfo> {
  const [s] = await db.select().from(subscribers).where(eq(subscribers.id, subscriberId));
  if (!s) throw new Error(`subscriber ${subscriberId} not found`);
  const subs = await db.select({ listKey: subscriptions.listKey }).from(subscriptions).where(eq(subscriptions.subscriberId, subscriberId)).orderBy(asc(subscriptions.listKey));
  const subscribedCategories: Record<string, string[]> = {};
  for (const { listKey } of subs) {
    if (listKey === "*") continue;
    const i = listKey.indexOf(":");
    (subscribedCategories[listKey.slice(0, i)] ??= []).push(listKey.slice(i + 1));
  }
  return {
    emailAddress: s.email,
    subscribedCategories,
    isAllNews: subs.some((r) => r.listKey === "*"),
    isAsItHappens: s.asItHappens,
    isDailyDigest: s.digest,
    isAdminRegistration: false,
    notifyIfNewCategories: false,
    expiredLinkOrUnverifiedEmail: false,
  };
}
```

- [ ] **Step 4: Implement `emails.ts`**

```ts
import { escapeHtml } from "@gcpe/http-kit";
import type { DistributionClient } from "../distribution-client";

export type SystemEmailKind = "verify" | "manage" | "change-email";

const WORDING: Record<SystemEmailKind, { subject: string; heading: string; lines: string[]; action: string }> = {
  verify: {
    subject: "BC Gov News On Demand Email Verification",
    heading: "Confirm your request",
    lines: ["Thank you for subscribing to BC Gov News On Demand."],
    action: "To confirm your request and begin receiving communications by email, click here:",
  },
  "change-email": {
    subject: "BC Gov News On Demand Email Verification",
    heading: "Confirm your new email address",
    lines: ["You asked to receive BC Gov News On Demand at this address."],
    action: "To confirm this address and move your subscription to it, click here:",
  },
  manage: {
    subject: "BC Gov News On Demand Subscription Management",
    heading: "Manage your subscription",
    lines: [],
    action: "To log in and manage your subscription, click here:",
  },
};

export function renderSystemEmail(kind: SystemEmailKind, link: string): { subject: string; html: string; text: string } {
  const w = WORDING[kind];
  const text = [w.heading, "", ...w.lines.flatMap((l) => [l, ""]), `${w.action} ${link}`, "", "This link expires in 24 hours."].join("\n");
  const html =
    `<h1>${escapeHtml(w.heading)}</h1>` +
    w.lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("") +
    `<p>${escapeHtml(w.action)} <a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>` +
    `<p>This link expires in 24 hours.</p>`;
  return { subject: w.subject, html, text };
}

export function linkUrl(pageUrl: string, token: string): string {
  const url = new URL(pageUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

/** Never throws: a failed send is logged (without the address) and the caller's response is
 * unchanged — anti-enumeration means the caller can't say "we couldn't email you" anyway. */
export async function sendSystemEmail(
  distribution: Pick<DistributionClient, "send">,
  to: string,
  kind: SystemEmailKind,
  link: string,
  idempotencyKey: string,
): Promise<void> {
  const { subject, html, text } = renderSystemEmail(kind, link);
  try {
    await distribution.send({ priority: "system", idempotencyKey, subject, html, text, headers: {}, recipients: [{ email: to, substitutions: {} }] });
  } catch (e) {
    console.error(`[nod] ${kind} email ${idempotencyKey} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/subscribe`
Expected: PASS. If the `escapeHtml` output for `"` differs from `&quot;`, adjust the test's expected string to `@gcpe/http-kit`'s actual escaping (read `packages/http-kit/src` first); don't change `escapeHtml`.

- [ ] **Step 6: Commit**

```bash
git add apps/nod/src/subscribe
git commit -m "feat(nod): legacy SubscriberInfo mapping and verification/manage emails"
```

---

### Task 5: Journeys

**Files:**
- Create: `apps/nod/src/subscribe/journeys.ts`, `journeys.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces:

```ts
export interface JourneyDeps {
  db: Db;
  distribution: Pick<DistributionClient, "send">;
  /** Page the emailed links open (?token= is appended): the manage page. */
  pageUrl: string;
  /** HMAC secret for unsubscribe tokens (≥ 32 chars). */
  linkSecret: string;
}
export function subscribe(deps: JourneyDeps, info: SubscriberInfo): Promise<void>;          // throws PreferencesError
export function confirm(deps: JourneyDeps, token: string): Promise<SubscriberInfo | null>;
export function update(deps: JourneyDeps, token: string, info: SubscriberInfo): Promise<"ok" | "invalid">; // throws PreferencesError
export function requestManageLink(deps: JourneyDeps, email: string): Promise<void>;
export function checkToken(deps: JourneyDeps, token: string): Promise<boolean>;
export function unsubscribe(deps: JourneyDeps, token: string): Promise<true>;
```

Behaviour (spec §4, plan rulings):
- **subscribe:** normalise; `toPrefs`; if `linksSentLastHour(email) >= MAX_EMAILS_PER_HOUR` return without doing anything. If an `active` subscriber has this email: create a `manage` link for them and send the manage email. Otherwise create a `verify` link with `pending = prefs` (subscriber id = the existing `pending`/`disabled`/`deleted` row's id if any, else null) and send the verification email.
- **confirm:** `findLink` → null → return `null`. Expired → return `{ ...emptyInfo, emailAddress: link.email, expiredLinkOrUnverifiedEmail: true }` and change nothing. Subscriber `deleted` and link is not a fresh `verify` → `null`.
  - `verify` with `usedAt === null`: in one transaction, create or reuse the subscriber by email (`status: active`, `verifiedAt: now`, `asItHappens`/`digest` from pending, `endedAt: null`, `source: self`), replace its subscriptions with `pending.listKeys`, attach the subscriber to the link, `markLinkUsed`, history `confirmed`. Return `infoFor`.
  - `change-email` with `usedAt === null`: in one transaction, if another subscriber already has the new address, unsubscribe this subscriber (legacy secret unsubscribe) and return `null`; otherwise set `email`, bump `unsubscribeVersion`, `markLinkUsed`, history `email-changed`. Return `infoFor`.
  - Anything else (manage link, or already used): return `infoFor(link.subscriberId)` (a manage view).
- **update:** `findLink`; invalid if missing, expired, no subscriber, or subscriber not `active`. Apply `toPrefs` (asItHappens, digest, subscriptions replaced) and history `preferences-updated`. If the normalised email differs from the subscriber's: rate-check the new address; create a `change-email` link (subscriber id, email = new address, pending = null), send the change-email message to the **new** address, history `email-change-requested`. Return `"ok"`.
- **requestManageLink:** normalise; rate-check; if an `active` subscriber has the email, create a `manage` link and send. Always resolve.
- **checkToken:** link exists, not expired.
- **unsubscribe:** token is a link token (any purpose, not expired) with a subscriber, or a valid unsubscribe token whose version matches the subscriber's → set `status: deleted`, `endedAt: now` (only if not already deleted), history `unsubscribed`. Also accept a Phase 2 `manage_token` (`subscribers.manage_token`) until 4b retires it. Always return `true` (C50).

- [ ] **Step 1: Write the failing tests**

`apps/nod/src/subscribe/journeys.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../../test/helpers";
import { subscribers, subscriptions } from "../db/schema";
import { subscriberInfoSchema, PreferencesError } from "./info";
import { checkToken, confirm, requestManageLink, subscribe, unsubscribe, update, type JourneyDeps } from "./journeys";
import { unsubscribeToken } from "./tokens";

const SECRET = "k".repeat(32);

describe("subscriber journeys", () => {
  let tdb: TestDatabase;
  let deps: JourneyDeps;
  const sent: { to: string; subject: string; text: string }[] = [];
  const tokenFrom = (i = sent.length - 1) => new URL(sent[i]!.text.match(/https:\S+/)![0]).searchParams.get("token")!;
  const info = (over: Record<string, unknown> = {}) =>
    subscriberInfoSchema.parse({ emailAddress: "pat@example.test", subscribedCategories: { ministries: ["health"] }, isAsItHappens: true, ...over });

  beforeAll(async () => {
    tdb = await createNodTestDb();
    await tdb.db.execute(sql`INSERT INTO lists (list_key, category, key, name) VALUES ('ministries:health','ministries','health','Health'), ('ministries:agri','ministries','agri','Agriculture')`);
    deps = {
      db: tdb.db,
      pageUrl: "https://boxs.ca/site/subscribe/manage/",
      linkSecret: SECRET,
      distribution: { send: vi.fn(async (m) => { sent.push({ to: m.recipients[0].email, subject: m.subject, text: m.text }); return { batchId: "b" }; }) },
    };
  });
  afterAll(async () => tdb.drop());
  beforeEach(async () => {
    sent.length = 0;
    await tdb.db.execute(sql`DELETE FROM subscriber_links; DELETE FROM subscribers;`);
  });

  it("subscribe → verify email → confirm activates with the chosen lists and timing", async () => {
    await subscribe(deps, info({ isDailyDigest: true }));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe("BC Gov News On Demand Email Verification");
    expect(await tdb.db.select().from(subscribers)).toHaveLength(0); // nothing until confirmed
    const result = await confirm(deps, tokenFrom());
    expect(result).toMatchObject({ emailAddress: "pat@example.test", subscribedCategories: { ministries: ["health"] }, isAsItHappens: true, isDailyDigest: true });
    const [s] = await tdb.db.select().from(subscribers);
    expect(s).toMatchObject({ status: "active", source: "self", asItHappens: true, digest: true });
  });

  it("normalises case and spaces", async () => {
    await subscribe(deps, info({ emailAddress: "  Pat@Example.TEST " }));
    await confirm(deps, tokenFrom());
    await subscribe(deps, info({ emailAddress: "PAT@example.test" }));
    expect(await tdb.db.select().from(subscribers)).toHaveLength(1);
    expect(sent[1]!.subject).toBe("BC Gov News On Demand Subscription Management");
  });

  it("an existing subscriber gets a manage email, not a second verification (anti-enumeration)", async () => {
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    await subscribe(deps, info({ subscribedCategories: { ministries: ["agri"] } }));
    expect(sent.map((m) => m.subject)).toEqual(["BC Gov News On Demand Email Verification", "BC Gov News On Demand Subscription Management"]);
    const subs = await tdb.db.select().from(subscriptions);
    expect(subs.map((r) => r.listKey)).toEqual(["ministries:health"]); // unchanged until they act on the manage link
  });

  it("confirm twice: the second click is a manage view and re-applies nothing", async () => {
    await subscribe(deps, info());
    const token = tokenFrom();
    await confirm(deps, token);
    await tdb.db.update(subscribers).set({ digest: true, asItHappens: false });
    expect(await confirm(deps, token)).toMatchObject({ isAsItHappens: false, isDailyDigest: true });
  });

  it("expired link: confirm flags it, update refuses, check says false", async () => {
    await subscribe(deps, info());
    const token = tokenFrom();
    await tdb.db.execute(sql`UPDATE subscriber_links SET expires_at = now() - interval '1 minute'`);
    expect(await confirm(deps, token)).toMatchObject({ emailAddress: "pat@example.test", expiredLinkOrUnverifiedEmail: true });
    expect(await tdb.db.select().from(subscribers)).toHaveLength(0);
    expect(await checkToken(deps, token)).toBe(false);
    expect(await update(deps, token, info())).toBe("invalid");
  });

  it("unknown or email-shaped tokens are invalid everywhere (C60)", async () => {
    expect(await confirm(deps, "pat@example.test")).toBeNull();
    expect(await update(deps, "pat@example.test", info())).toBe("invalid");
    expect(await checkToken(deps, "nope")).toBe(false);
    expect(await unsubscribe(deps, "pat@example.test")).toBe(true);
  });

  it("update changes timing and lists through a manage link", async () => {
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    await requestManageLink(deps, "pat@example.test");
    expect(await update(deps, tokenFrom(), info({ subscribedCategories: { ministries: ["agri"] }, isAsItHappens: false, isDailyDigest: true }))).toBe("ok");
    const [s] = await tdb.db.select().from(subscribers);
    expect(s).toMatchObject({ asItHappens: false, digest: true });
    expect((await tdb.db.select().from(subscriptions)).map((r) => r.listKey)).toEqual(["ministries:agri"]);
  });

  it("changing email verifies the new address before switching (C49)", async () => {
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    await requestManageLink(deps, "pat@example.test");
    await update(deps, tokenFrom(), info({ emailAddress: "new@example.test" }));
    expect(sent.at(-1)!.to).toBe("new@example.test");
    expect((await tdb.db.select().from(subscribers))[0]!.email).toBe("pat@example.test"); // not yet
    await confirm(deps, tokenFrom());
    const [s] = await tdb.db.select().from(subscribers);
    expect(s).toMatchObject({ email: "new@example.test", unsubscribeVersion: 2 });
  });

  it("moving to an address that's already subscribed unsubscribes the old record silently", async () => {
    for (const email of ["a@example.test", "b@example.test"]) { await subscribe(deps, info({ emailAddress: email })); await confirm(deps, tokenFrom()); }
    await requestManageLink(deps, "a@example.test");
    await update(deps, tokenFrom(), info({ emailAddress: "b@example.test" }));
    expect(await confirm(deps, tokenFrom())).toBeNull();
    const [a] = await tdb.db.select().from(subscribers).where(eq(subscribers.email, "a@example.test"));
    expect(a!.status).toBe("deleted");
  });

  it("unsubscribe by link or stable token is idempotent; an old-version token does nothing", async () => {
    await subscribe(deps, info());
    await confirm(deps, tokenFrom());
    const [s] = await tdb.db.select().from(subscribers);
    expect(await unsubscribe(deps, unsubscribeToken(SECRET, s!.id, 0))).toBe(true);
    expect((await tdb.db.select().from(subscribers))[0]!.status).toBe("active");
    expect(await unsubscribe(deps, unsubscribeToken(SECRET, s!.id, 1))).toBe(true);
    expect(await unsubscribe(deps, unsubscribeToken(SECRET, s!.id, 1))).toBe(true);
    const [after] = await tdb.db.select().from(subscribers);
    expect(after).toMatchObject({ status: "deleted" });
    expect(after!.endedAt).not.toBeNull();
  });

  it("caps verification/manage emails at 3 per address per hour without changing the response", async () => {
    for (let i = 0; i < 5; i++) await subscribe(deps, info({ emailAddress: "flood@example.test" }));
    expect(sent.filter((m) => m.to === "flood@example.test")).toHaveLength(3);
  });

  it("refuses a subscription that can receive nothing", async () => {
    await expect(subscribe(deps, info({ subscribedCategories: { ministries: ["nope"] } }))).rejects.toBeInstanceOf(PreferencesError);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/subscribe/journeys.test.ts`
Expected: FAIL (`./journeys` missing).

- [ ] **Step 3: Implement `journeys.ts`**

```ts
import { and, eq, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "@gcpe/db-kit";
import type { DistributionClient } from "../distribution-client";
import { subscribers, subscriptions, type SubscriberPrefs } from "../db/schema";
import { writeHistory } from "./history";
import { infoFor, normaliseEmail, toPrefs, type SubscriberInfo } from "./info";
import { createLink, findLink, linksSentLastHour, markLinkUsed, MAX_EMAILS_PER_HOUR, type LinkRow } from "./links";
import { linkUrl, sendSystemEmail, type SystemEmailKind } from "./emails";
import { parseUnsubscribeToken } from "./tokens";

export interface JourneyDeps {
  db: Db;
  distribution: Pick<DistributionClient, "send">;
  pageUrl: string;
  linkSecret: string;
}

const SELF = "subscriber";

async function bySubscriberEmail(db: DbOrTx, email: string) {
  const [s] = await db.select().from(subscribers).where(sql`lower(${subscribers.email}) = ${email}`);
  return s ?? null;
}

async function issue(deps: JourneyDeps, kind: SystemEmailKind, input: { email: string; subscriberId: string | null; pending: SubscriberPrefs | null }) {
  if ((await linksSentLastHour(deps.db, input.email)) >= MAX_EMAILS_PER_HOUR) return;
  const { id, token } = await createLink(deps.db, { purpose: kind, ...input });
  await sendSystemEmail(deps.distribution, input.email, kind, linkUrl(deps.pageUrl, token), `nod-link-${id}`);
}

async function replaceSubscriptions(tx: DbOrTx, subscriberId: string, listKeys: string[]) {
  await tx.delete(subscriptions).where(eq(subscriptions.subscriberId, subscriberId));
  if (listKeys.length) await tx.insert(subscriptions).values(listKeys.map((listKey) => ({ subscriberId, listKey })));
}

export async function subscribe(deps: JourneyDeps, info: SubscriberInfo): Promise<void> {
  const { email, prefs } = await toPrefs(deps.db, info);
  const existing = await bySubscriberEmail(deps.db, email);
  if (existing?.status === "active") return issue(deps, "manage", { email, subscriberId: existing.id, pending: null });
  return issue(deps, "verify", { email, subscriberId: existing?.id ?? null, pending: prefs });
}

const EMPTY: Omit<SubscriberInfo, "emailAddress"> = {
  subscribedCategories: {}, isAllNews: false, isAsItHappens: false, isDailyDigest: false,
  isAdminRegistration: false, notifyIfNewCategories: false, expiredLinkOrUnverifiedEmail: false,
};

export async function confirm(deps: JourneyDeps, token: string): Promise<SubscriberInfo | null> {
  const link = await findLink(deps.db, token);
  if (!link) return null;
  if (link.expired) return { ...EMPTY, emailAddress: link.email, expiredLinkOrUnverifiedEmail: true };

  if (link.purpose === "verify" && link.usedAt === null && link.pending) return applyVerify(deps, link);
  if (link.purpose === "change-email" && link.usedAt === null) return applyEmailChange(deps, link);
  if (!link.subscriberId) return null;
  const [s] = await deps.db.select().from(subscribers).where(eq(subscribers.id, link.subscriberId));
  if (!s || s.status === "deleted") return null;
  return infoFor(deps.db, s.id);
}

async function applyVerify(deps: JourneyDeps, link: LinkRow): Promise<SubscriberInfo> {
  const pending = link.pending!;
  const id = await deps.db.transaction(async (tx) => {
    const existing = await bySubscriberEmail(tx, link.email);
    const fields = { status: "active" as const, verifiedAt: sql`now()`, asItHappens: pending.asItHappens, digest: pending.digest, endedAt: null };
    let subscriberId: string;
    if (existing) {
      await tx.update(subscribers).set(fields).where(eq(subscribers.id, existing.id));
      subscriberId = existing.id;
    } else {
      const [row] = await tx
        .insert(subscribers)
        .values({ email: link.email, manageToken: `phase4-${link.id}`, source: "self", ...fields })
        .returning({ id: subscribers.id });
      subscriberId = row!.id;
    }
    await replaceSubscriptions(tx, subscriberId, pending.listKeys);
    await tx.execute(sql`UPDATE subscriber_links SET subscriber_id = ${subscriberId}, pending = NULL WHERE id = ${link.id}`);
    await markLinkUsed(tx, link.id);
    await writeHistory(tx, subscriberId, SELF, "confirmed", pending.listKeys.join(", "));
    return subscriberId;
  });
  return infoFor(deps.db, id);
}

async function applyEmailChange(deps: JourneyDeps, link: LinkRow): Promise<SubscriberInfo | null> {
  if (!link.subscriberId) return null;
  const moved = await deps.db.transaction(async (tx) => {
    await markLinkUsed(tx, link.id);
    const taken = await bySubscriberEmail(tx, link.email);
    if (taken && taken.id !== link.subscriberId) {
      await endSubscriber(tx, link.subscriberId);
      return false;
    }
    await tx
      .update(subscribers)
      .set({ email: link.email, unsubscribeVersion: sql`${subscribers.unsubscribeVersion} + 1` })
      .where(and(eq(subscribers.id, link.subscriberId), eq(subscribers.status, "active")));
    await writeHistory(tx, link.subscriberId, SELF, "email-changed");
    return true;
  });
  return moved ? infoFor(deps.db, link.subscriberId) : null;
}

async function endSubscriber(tx: DbOrTx, subscriberId: string) {
  const ended = await tx
    .update(subscribers)
    .set({ status: "deleted", endedAt: sql`now()` })
    .where(and(eq(subscribers.id, subscriberId), sql`${subscribers.status} <> 'deleted'`))
    .returning({ id: subscribers.id });
  if (ended.length) await writeHistory(tx, subscriberId, SELF, "unsubscribed");
}

export async function update(deps: JourneyDeps, token: string, info: SubscriberInfo): Promise<"ok" | "invalid"> {
  const link = await findLink(deps.db, token);
  if (!link || link.expired || !link.subscriberId) return "invalid";
  const [s] = await deps.db.select().from(subscribers).where(eq(subscribers.id, link.subscriberId));
  if (!s || s.status !== "active") return "invalid";
  const { email, prefs } = await toPrefs(deps.db, info);
  await deps.db.transaction(async (tx) => {
    await tx.update(subscribers).set({ asItHappens: prefs.asItHappens, digest: prefs.digest }).where(eq(subscribers.id, s.id));
    await replaceSubscriptions(tx, s.id, prefs.listKeys);
    await writeHistory(tx, s.id, SELF, "preferences-updated", prefs.listKeys.join(", "));
  });
  if (email !== normaliseEmail(s.email)) {
    await writeHistory(deps.db, s.id, SELF, "email-change-requested");
    await issue(deps, "change-email", { email, subscriberId: s.id, pending: null });
  }
  return "ok";
}

export async function requestManageLink(deps: JourneyDeps, rawEmail: string): Promise<void> {
  const email = normaliseEmail(rawEmail);
  const s = await bySubscriberEmail(deps.db, email);
  if (s?.status === "active") await issue(deps, "manage", { email, subscriberId: s.id, pending: null });
}

export async function checkToken(deps: JourneyDeps, token: string): Promise<boolean> {
  const link = await findLink(deps.db, token);
  return !!link && !link.expired;
}

export async function unsubscribe(deps: JourneyDeps, token: string): Promise<true> {
  let subscriberId: string | null = null;
  const link = await findLink(deps.db, token);
  if (link && !link.expired && link.subscriberId) subscriberId = link.subscriberId;
  if (!subscriberId) {
    const parsed = parseUnsubscribeToken(deps.linkSecret, token);
    if (parsed) {
      const [s] = await deps.db.select().from(subscribers).where(eq(subscribers.id, parsed.subscriberId));
      if (s && s.unsubscribeVersion === parsed.version) subscriberId = s.id;
    }
  }
  if (!subscriberId && /^[A-Za-z0-9_-]{43}$/.test(token)) {
    // Phase 2 footers carry subscribers.manage_token; honoured until 4b replaces those links.
    const [s] = await deps.db.select({ id: subscribers.id }).from(subscribers).where(eq(subscribers.manageToken, token));
    subscriberId = s?.id ?? null;
  }
  if (subscriberId) await deps.db.transaction((tx) => endSubscriber(tx, subscriberId!));
  return true;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/subscribe`
Expected: PASS. If `manageToken` (`NOT NULL UNIQUE`) needs a real random value, use `randomBytes(32).toString("base64url")` instead of `phase4-${link.id}` (it's retired in 4b).

- [ ] **Step 5: Commit**

```bash
git add apps/nod/src/subscribe
git commit -m "feat(nod): subscribe, confirm, manage, change-email and unsubscribe journeys"
```

---

### Task 6: HTTP routes, service role, News API proxy and stack wiring

**Files:**
- Create: `apps/nod/src/http/subscribe-routes.ts`, `subscribe-routes.test.ts`
- Modify: `packages/auth/src/roles.ts`, `packages/auth/src/index.ts`, `apps/nod/src/app.ts`, `apps/nod/src/start.ts`, `apps/nod/test/helpers.ts`, `apps/news-api/src/start.ts`, `apps/news-api/src/http/v1/subscribe.ts` (+ its test), `apps/stack/src/env.ts` (+ test), `scripts/build-siteground.mjs` (only if it lists NoD env vars)

**Interfaces:**
- Consumes: Task 5's journeys; `publicListItems` (Task 2); `requireAnyRole` (`@gcpe/auth`).
- Produces: `NOD_SUBSCRIBE_API_ROLE = "NoD.SubscribeApi"`; `subscribeApiRoutes(deps: JourneyDeps): Router`; NoD env `LINK_SECRET` (≥ 32 chars) and `SUBSCRIBE_PAGE_URL` (default `${PUBLIC_SITE_URL}/subscribe/manage/`); `AppDeps.subscribe?: JourneyDeps`.

Route table (mounted at NoD `/api/Subscribe`, after `requireBearer`, role `NoD.SubscribeApi` or `NoD.Admin`):

| Method + path | Response |
|---|---|
| `GET /SubscriptionItems/:categoryKey` | `200 [{ key, value }]` |
| `POST /CreateNewsOnDemandEmailSubscriptionWithPreferences` | `204`; `400 { error }` on bad body or `PreferencesError` |
| `GET /ConfirmUpdateCreateSubscription/:tokenGuid` | `200 SubscriberInfo` or `200 null` |
| `POST /UpdateNewsOnDemandEmailSubscriptionWithPreferences/:tokenGuid` | `204`; `404 { error: "This link is not valid or has expired." }`; `400` |
| `GET /ManageNewsOnDemandEmailSubscription/:emailAddress` | `204` always (a malformed address too) |
| `GET /CheckEmailActivationToken/:tokenGuid` | `200 true/false` |
| `GET /UnsubscribeSubscriber/:tokenGuid` | `200 true` |
| `POST /OneClickUnsubscribe/:tokenGuid` | `200 true` (RFC 8058) |

- [ ] **Step 1: Add the role**

`packages/auth/src/roles.ts`:

```ts
/** Phase 4a: the News API's service role for proxying the public Subscribe API to NoD (legacy
 * "SubscribeApiUser"). Not a staff role. */
export const NOD_SUBSCRIBE_API_ROLE = "NoD.SubscribeApi";
```

Export it from `packages/auth/src/index.ts` alongside `CORE_ADMIN_DIRECTORY_ROLE`.

- [ ] **Step 2: Write the failing route tests**

`apps/nod/src/http/subscribe-routes.test.ts`, using the JWT setup from `routes.test.ts` (copy its `beforeAll` key-pair and `sign` helper), and an app built with `createApp({ …, subscribe: deps })` where `deps.distribution.send` is a `vi.fn` recording messages as in Task 5:

```ts
it("needs the subscribe service role", async () => {
  expect((await request(app).get("/api/Subscribe/SubscriptionItems/ministries")).status).toBe(401);
  expect((await request(app).get("/api/Subscribe/SubscriptionItems/ministries").set("authorization", `Bearer ${reader}`)).status).toBe(403);
  expect((await request(app).get("/api/Subscribe/SubscriptionItems/ministries").set("authorization", `Bearer ${svc}`)).status).toBe(200);
});

it("runs the whole journey over HTTP with legacy shapes", async () => {
  const auth = { authorization: `Bearer ${svc}` };
  const items = await request(app).get("/api/Subscribe/SubscriptionItems/ministries").set(auth);
  expect(items.body).toEqual([{ key: "health", value: "Health" }]);

  const created = await request(app).post("/api/Subscribe/CreateNewsOnDemandEmailSubscriptionWithPreferences").set(auth)
    .send({ emailAddress: "web@example.test", subscribedCategories: { ministries: ["health"] }, isAllNews: false, isAsItHappens: true, isDailyDigest: false });
  expect(created.status).toBe(204);
  const token = tokenFrom();

  expect((await request(app).get(`/api/Subscribe/CheckEmailActivationToken/${token}`).set(auth)).body).toBe(true);
  const confirmed = await request(app).get(`/api/Subscribe/ConfirmUpdateCreateSubscription/${token}`).set(auth);
  expect(confirmed.body).toMatchObject({ emailAddress: "web@example.test", isAsItHappens: true });

  const updated = await request(app).post(`/api/Subscribe/UpdateNewsOnDemandEmailSubscriptionWithPreferences/${token}`).set(auth)
    .send({ emailAddress: "web@example.test", isAllNews: true, isAsItHappens: false, isDailyDigest: true });
  expect(updated.status).toBe(204);

  expect((await request(app).get(`/api/Subscribe/UnsubscribeSubscriber/${token}`).set(auth)).body).toBe(true);
});

it("answers Manage identically for known, unknown and malformed addresses", async () => {
  const auth = { authorization: `Bearer ${svc}` };
  const a = await request(app).get("/api/Subscribe/ManageNewsOnDemandEmailSubscription/web@example.test").set(auth);
  const b = await request(app).get("/api/Subscribe/ManageNewsOnDemandEmailSubscription/nobody@example.test").set(auth);
  const c = await request(app).get("/api/Subscribe/ManageNewsOnDemandEmailSubscription/not-an-email").set(auth);
  expect([a.status, b.status, c.status]).toEqual([204, 204, 204]);
});

it("Update with an unknown token is a 404, a bad body a 400, and Confirm of an unknown token is null", async () => {
  const auth = { authorization: `Bearer ${svc}` };
  expect((await request(app).post("/api/Subscribe/UpdateNewsOnDemandEmailSubscriptionWithPreferences/web@example.test").set(auth).send({ emailAddress: "web@example.test", isAllNews: true, isAsItHappens: true })).status).toBe(404);
  expect((await request(app).post("/api/Subscribe/CreateNewsOnDemandEmailSubscriptionWithPreferences").set(auth).send({ emailAddress: "x" })).status).toBe(400);
  const c = await request(app).get("/api/Subscribe/ConfirmUpdateCreateSubscription/nope").set(auth);
  expect(c.status).toBe(200);
  expect(c.body).toBeNull();
});

it("one-click unsubscribe accepts the RFC 8058 form body", async () => {
  const res = await request(app).post("/api/Subscribe/OneClickUnsubscribe/whatever").set({ authorization: `Bearer ${svc}` })
    .type("form").send("List-Unsubscribe=One-Click");
  expect(res.status).toBe(200);
  expect(res.body).toBe(true);
});
```

`svc` is signed with `roles: ["NoD.SubscribeApi"]`; `reader` with `roles: []`. Seed `lists` with `ministries:health` in `beforeAll`. Define `sent` and `tokenFrom` exactly as in Task 5's test (the `vi.fn` send records `{ to, subject, text }`; `tokenFrom()` pulls `token` from the last message's link).

- [ ] **Step 3: Run them to see them fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod/src/http/subscribe-routes.test.ts`
Expected: FAIL (route module missing).

- [ ] **Step 4: Implement `subscribe-routes.ts`**

```ts
import express, { Router, type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import { requireAnyRole, NOD_SUBSCRIBE_API_ROLE } from "@gcpe/auth";
import { publicListItems } from "../lists";
import { PreferencesError, subscriberInfoSchema } from "../subscribe/info";
import { checkToken, confirm, requestManageLink, subscribe, unsubscribe, update, type JourneyDeps } from "../subscribe/journeys";

type H = (req: Request, res: Response) => Promise<void>;
const run = (h: H) => (req: Request, res: Response, next: NextFunction) =>
  h(req, res).catch((e: unknown) => {
    if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues });
    if (e instanceof PreferencesError) return void res.status(400).json({ error: e.message });
    next(e);
  });
const param = (req: Request, name: string) => String(req.params[name] ?? "");

/** The legacy public Subscribe API (spec §4), reached through the News API proxy. */
export function subscribeApiRoutes(deps: JourneyDeps): Router {
  const r = Router();
  r.use(requireAnyRole(NOD_SUBSCRIBE_API_ROLE, "NoD.Admin"));
  r.get("/SubscriptionItems/:categoryKey", run(async (req, res) => void res.json(await publicListItems(deps.db, param(req, "categoryKey").toLowerCase()))));
  r.post("/CreateNewsOnDemandEmailSubscriptionWithPreferences", run(async (req, res) => {
    await subscribe(deps, subscriberInfoSchema.parse(req.body));
    res.status(204).end();
  }));
  r.get("/ConfirmUpdateCreateSubscription/:tokenGuid", run(async (req, res) => void res.json(await confirm(deps, param(req, "tokenGuid")))));
  r.post("/UpdateNewsOnDemandEmailSubscriptionWithPreferences/:tokenGuid", run(async (req, res) => {
    const outcome = await update(deps, param(req, "tokenGuid"), subscriberInfoSchema.parse(req.body));
    if (outcome === "invalid") return void res.status(404).json({ error: "This link is not valid or has expired." });
    res.status(204).end();
  }));
  r.get("/ManageNewsOnDemandEmailSubscription/:emailAddress", run(async (req, res) => {
    const parsed = subscriberInfoSchema.shape.emailAddress.safeParse(param(req, "emailAddress"));
    if (parsed.success) await requestManageLink(deps, parsed.data);
    res.status(204).end();
  }));
  r.get("/CheckEmailActivationToken/:tokenGuid", run(async (req, res) => void res.json(await checkToken(deps, param(req, "tokenGuid")))));
  r.get("/UnsubscribeSubscriber/:tokenGuid", run(async (req, res) => void res.json(await unsubscribe(deps, param(req, "tokenGuid")))));
  r.post("/OneClickUnsubscribe/:tokenGuid", express.urlencoded({ extended: false, limit: "1kb" }), run(async (req, res) => void res.json(await unsubscribe(deps, param(req, "tokenGuid")))));
  return r;
}
```

Note `res.json(null)` sends the body `null` with status 200, matching legacy.

- [ ] **Step 5: Mount it and add the env**

`apps/nod/src/app.ts`: add `subscribe?: JourneyDeps` to `AppDeps`; before the existing `/api` mount:

```ts
  if (deps.subscribe) app.use("/api/Subscribe", requireBearer(deps.auth), express.json({ limit: "100kb" }), subscribeApiRoutes(deps.subscribe));
```

`apps/nod/src/start.ts`, `nodEnvSchema`:

```ts
  // Phase 4a: HMAC key for unsubscribe tokens (the stack derives it from STACK_EVENT_SECRET).
  LINK_SECRET: z.string().min(32),
  // The page emailed verify/manage links open. Default: the public site's test page.
  SUBSCRIBE_PAGE_URL: z.string().url().optional(),
```

and pass `subscribe: { db, distribution, pageUrl: parsed.SUBSCRIBE_PAGE_URL ?? `${parsed.PUBLIC_SITE_URL.replace(/\/$/, "")}/subscribe/manage/`, linkSecret: parsed.LINK_SECRET }` to `createApp`. Update `start.test.ts` and every test env fixture that builds NoD's env (`grep -rln "MANAGE_URL" apps tests scripts`) to include a 32-char `LINK_SECRET`.

- [ ] **Step 6: Stack defaults**

`apps/stack/src/env.ts`:
- `STACK_APP_DEFAULTS.NEWSAPI = { NOD_BASE_URL: "self:/nod" }` (update the doc comment: the public Subscribe API proxies to this stack's NoD).
- In `envFor`, after the `SESSION_SECRET` line: `if (prefix === "NOD" && !view.LINK_SECRET && env.STACK_EVENT_SECRET) view.LINK_SECRET = createHmac("sha256", env.STACK_EVENT_SECRET).update("gcpe-nod-links").digest("hex");`
- Tests in `env.test.ts`: `envFor({ STACK_EVENT_SECRET: "x".repeat(32) }, "NEWSAPI").NOD_BASE_URL === "self:/nod"`; NoD's `LINK_SECRET` is 64 hex chars, stable, and an explicit `NOD_LINK_SECRET` wins.

- [ ] **Step 7: News API — local service token and the one-click route**

`apps/news-api/src/start.ts`: replace the `getToken` block with

```ts
  const nodEntra = [parsed.NOD_TOKEN_URL, parsed.NOD_CLIENT_ID, parsed.NOD_CLIENT_SECRET, parsed.NOD_SCOPE];
  // Entra when configured; otherwise, on test sites, a local token carrying the subscribe
  // role (same fallback NRMS uses for its NoD calls).
  const getToken = parsed.NOD_BASE_URL
    ? serviceTokenProvider({
        tokenUrl: parsed.NOD_TOKEN_URL, clientId: parsed.NOD_CLIENT_ID, clientSecret: parsed.NOD_CLIENT_SECRET, scope: parsed.NOD_SCOPE,
        local: nodEntra.every((v) => !v) && env.LOCAL_ADMIN_ENABLED === "true" ? authFromEnv(env).local : null,
        subject: "news-api",
        roles: [NOD_SUBSCRIBE_API_ROLE],
        envPrefix: "NOD",
      })
    : undefined;
```

(imports `serviceTokenProvider`, `authFromEnv`, `NOD_SUBSCRIBE_API_ROLE` from `@gcpe/auth`; drop the unused `createClientCredentialsProvider` import). `serviceTokenProvider` throws at startup if neither Entra nor local is available, which is the intended fail-fast.

`apps/news-api/src/http/v1/subscribe.ts`, `ROUTES`: add `["post", "/Subscribe/OneClickUnsubscribe/:tokenGuid"]`. The proxy forwards bodies as JSON; for this route forward the raw form body instead. Add, before the generic loop:

```ts
  r.post("/Subscribe/OneClickUnsubscribe/:tokenGuid", express.urlencoded({ extended: false, limit: "1kb" }), async (req, res) => {
    const upstreamPath = buildUpstreamPath("/Subscribe/OneClickUnsubscribe/:tokenGuid", req.params);
    if (upstreamPath === undefined) return void res.status(400).json({ error: "invalid parameter" });
    try {
      const headers: Record<string, string> = { accept: "application/json", "content-type": "application/x-www-form-urlencoded" };
      if (opts.getToken) headers.authorization = `Bearer ${await opts.getToken()}`;
      const upstream = await doFetch(`${opts.baseUrl.replace(/\/$/, "")}/api${upstreamPath}`, {
        method: "POST", headers, body: "List-Unsubscribe=One-Click", signal: AbortSignal.timeout(15_000),
      });
      res.status(upstream.status).type("application/json").send(await upstream.text());
    } catch (e) {
      console.error("[news-api] one-click unsubscribe proxy failed", e);
      res.status(502).json({ error: "subscriptions upstream unavailable" });
    }
  });
```

and do **not** add it to `ROUTES`. Add a test in `apps/news-api/src/http/v1/subscribe.test.ts` (follow its existing fake-upstream pattern): a form POST reaches the upstream as `POST /api/Subscribe/OneClickUnsubscribe/<token>` with the bearer header, and returns the upstream body. Mail clients send this POST without the `api-version` query: check that the proxy's api-version middleware (`grep -n "api-version\|ApiVersionUnspecified" apps/news-api/src -r`) lets this one path through without it, and add that exemption with a test if it doesn't.

- [ ] **Step 8: Run the affected suites**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/nod apps/news-api apps/stack packages/auth`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/nod apps/news-api apps/stack packages/auth scripts
git commit -m "feat(nod,news-api,stack): legacy Subscribe API on NoD behind a service role; proxy works on test sites"
```

---

### Task 7: Test-site pages and the end-to-end journey

**Files:**
- Create: `apps/public-site/src/subscribe-pages.ts`, `subscribe-pages.test.ts`, `tests/e2e/subscribe-journey.spec.ts`
- Modify: `apps/public-site/src/self-heal.ts` (+ its test)

**Interfaces:**
- Consumes: `SiteInfo`, `PageOptions` (`render.ts`), `SiteStorage` (`storage.ts`); the public Subscribe API (Task 6).
- Produces: `SUBSCRIBE_PAGES: { path: string; render(site: SiteInfo, opts: PageOptions): string }[]` for `subscribe/index.html`, `subscribe/manage/index.html`, `subscribe/unsubscribe/index.html`; `writeSubscribePages(storage: SiteStorage, site: SiteInfo, opts: PageOptions): Promise<void>`.

Page behaviour (one shared inline script, no external assets, works at 320px wide, every control labelled):
- **`/subscribe/`:** loads `SubscriptionItems` for `ministries`, `sectors`, `themes`, `tags` into checkbox groups (one `<fieldset>`/`<legend>` each), plus "All news", "As it happens" (checked) and "Daily digest". Submits `CreateNewsOnDemandEmailSubscriptionWithPreferences`. On 204 shows "Check your email to confirm your subscription." (`role="status"`); on 400 shows the server's `error` (`role="alert"`).
- **`/subscribe/manage/?token=…`:** calls `ConfirmUpdateCreateSubscription/<token>`. `null` → "This link isn't valid. Request a new one below." plus an email box calling `ManageNewsOnDemandEmailSubscription/<email>` ("If that address is subscribed, we've emailed it a link."). `expiredLinkOrUnverifiedEmail` → "This link has expired…" plus the same request box. Otherwise renders the same form pre-filled; Save posts `UpdateNewsOnDemandEmailSubscriptionWithPreferences/<token>` ("Your preferences are saved."; if the email changed: "We've emailed <new address> to confirm the change."). An "Unsubscribe" button goes to `/subscribe/unsubscribe/?token=…`.
- **`/subscribe/unsubscribe/?token=…`:** a confirm button that calls `UnsubscribeSubscriber/<token>`, then "You're unsubscribed." Never unsubscribes on page load (link scanners).
- Every fetch goes to `${origin}/api/Subscribe/...?api-version=1.0`, with `encodeURIComponent` on path values. Response text goes into the page only through `textContent`, never `innerHTML`.
- The pages carry the same header, test banner and noindex as every other page (reuse `render.ts`'s page chrome: export its `page()` helper as `renderPage` if needed).

- [ ] **Step 1: Write the failing unit test**

`apps/public-site/src/subscribe-pages.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SUBSCRIBE_PAGES, writeSubscribePages } from "./subscribe-pages";

const site = { name: "BC Gov News", baseUrl: "https://boxs.ca/site" };

describe("subscribe test pages", () => {
  it("writes the three pages with site chrome, noindex on a test site, and no innerHTML", async () => {
    const files = new Map<string, string>();
    await writeSubscribePages({ write: async (p: string, c: string) => void files.set(p, c) } as never, site, { test: true });
    expect([...files.keys()].sort()).toEqual(["subscribe/index.html", "subscribe/manage/index.html", "subscribe/unsubscribe/index.html"]);
    for (const html of files.values()) {
      expect(html).toContain('<header><a href="/site/">');
      expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
      expect(html).toContain("/api/Subscribe/");
      expect(html).toContain("api-version=1.0");
      expect(html).not.toContain("innerHTML");
    }
  });
  it("the unsubscribe page only acts on a button press", () => {
    const html = SUBSCRIBE_PAGES.find((p) => p.path === "subscribe/unsubscribe/index.html")!.render(site, {});
    expect(html).toMatch(/<button[^>]*>Unsubscribe<\/button>/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/public-site/src/subscribe-pages.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `subscribe-pages.ts`**

Build the three bodies as template strings; share one `<script>` string (`SUBSCRIBE_SCRIPT`) that reads `document.body.dataset.page` (`"subscribe" | "manage" | "unsubscribe"`) and wires the behaviour above with `fetch`, `document.createElement` and `textContent`. Render each through the shared page chrome (`renderPage(title, site, canonicalPath, body, opts)` exported from `render.ts`; canonical paths `${basePath}/subscribe/`, etc.). `writeSubscribePages` writes each `SUBSCRIBE_PAGES` entry with `storage.write`.

Keep the script under ~150 lines; it only needs: `api(path, init)` (prefixes origin + `/api/Subscribe/` + `?api-version=1.0`), `loadCategories(container, selected)`, `readForm(form)` → SubscriberInfo, `say(el, text, kind)`.

- [ ] **Step 4: Write the pages on every startup**

`apps/public-site/src/self-heal.ts`, inside the `enqueueSiteWrite` body, before the `index.html` existence check:

```ts
    // Phase 4a test pages: cheap and stateless, so rewritten on every start (they pick up any
    // chrome change without a marker bump).
    await writeSubscribePages(storage, site, { test, banner: computed?.banner ?? null });
```

Add a `self-heal.test.ts` assertion that the three files exist after `selfHeal` on an empty storage and on a storage that already has `index.html`.

- [ ] **Step 5: Run the public-site tests**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/public-site`
Expected: PASS.

- [ ] **Step 6: Write the end-to-end journey (acceptance items 1–2)**

`tests/e2e/subscribe-journey.spec.ts`:

```ts
// Phase 4 acceptance items 1–2: subscribe → verify → manage → unsubscribe, through the News
// API proxy and the test-site pages, with every email read back from the SMTP sink.
import { test, expect } from "@playwright/test";
import { baseUrl, expectNoSeriousA11yViolations, fetchSentMessages, tick, waitForMessageWithSubject } from "./playwright-support";

const VERIFY = "BC Gov News On Demand Email Verification";
const MANAGE = "BC Gov News On Demand Subscription Management";
const linkIn = (text: string | null) => text!.match(/https?:\/\/\S+token=[A-Za-z0-9_-]+/)![0];

async function newestTo(email: string, subject: string) {
  await expect.poll(async () => (await fetchSentMessages()).filter((m) => m.to.includes(email) && m.subject === subject).length).toBeGreaterThan(0);
  return (await fetchSentMessages()).filter((m) => m.to.includes(email) && m.subject === subject).at(-1)!;
}

test("subscribe, confirm, manage and unsubscribe through the test pages", async ({ page }) => {
  const email = `journey-${Date.now()}@example.test`;
  await tick(); // Core's reference data reaches NoD's lists
  await page.goto(`${baseUrl()}/site/subscribe/`);
  await expectNoSeriousA11yViolations(page, "subscribe page");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("checkbox", { name: "All news" }).check();
  await page.getByRole("button", { name: "Subscribe" }).click();
  await expect(page.getByRole("status")).toHaveText("Check your email to confirm your subscription.");
  await tick(); // Distribution sends

  await page.goto(linkIn((await newestTo(email, VERIFY)).text).replace(/^https?:\/\/[^/]+/, baseUrl()));
  await expect(page.getByRole("checkbox", { name: "All news" })).toBeChecked();
  await page.getByRole("checkbox", { name: "Daily digest" }).check();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toHaveText("Your preferences are saved.");

  await page.getByRole("button", { name: "Unsubscribe" }).click();
  await page.getByRole("button", { name: "Unsubscribe" }).click();
  await expect(page.getByRole("status")).toHaveText("You're unsubscribed.");
});

test("subscribing an address that's already subscribed looks identical and sends a manage email", async ({ page, request }) => {
  const email = `again-${Date.now()}@example.test`;
  const body = { emailAddress: email, isAllNews: true, isAsItHappens: true, isDailyDigest: false, subscribedCategories: {} };
  const url = `${baseUrl()}/api/Subscribe/CreateNewsOnDemandEmailSubscriptionWithPreferences?api-version=1.0`;
  const first = await request.post(url, { data: body });
  await tick();
  await request.get(`${baseUrl()}/api/Subscribe/ConfirmUpdateCreateSubscription/${new URL(linkIn((await newestTo(email, VERIFY)).text)).searchParams.get("token")}?api-version=1.0`);
  const second = await request.post(url, { data: body });
  expect([first.status(), second.status()]).toEqual([204, 204]);
  expect(await second.text()).toBe(await first.text());
  await tick();
  await newestTo(email, MANAGE);
  void page;
});
```

If the e2e global setup doesn't run the reference-data backfill (the stack only does it at startup), seed a ministry through Core's API at the start of the spec, or add `await tick()` twice; check `global-setup.ts` for how Core is seeded. Use `waitForMessageWithSubject` only where the subject is unique; these subjects aren't, hence `newestTo`.

- [ ] **Step 7: Run the e2e suite**

Run: `npx -y -p node@24 -- npm run test:e2e`
Expected: all previous specs still pass (42 passed, 1 skipped), plus the 2 new ones.

- [ ] **Step 8: Commit**

```bash
git add apps/public-site tests/e2e
git commit -m "feat(public-site): subscribe/manage/unsubscribe test pages; e2e subscriber journey"
```

---

### Task 8: Docs, full verification and deploy

**Files:**
- Modify: `docs/parity/changes-from-legacy.md`, `docs/parity/open-questions.md`, `docs/manuals/running-notes.md`, `docs/deploy/siteground.md`

- [ ] **Step 1: Record the change and the question**

`changes-from-legacy.md`, NoD section, after C59:

```markdown
| C60 | Update and Unsubscribe accept an email address in place of the link token and treat it as an admin action (`SubscriptionProvider.cs:447-472`, `:218-242`); through the public News API, anyone who knows an address can change or cancel that subscription. | The public API accepts tokens only (link tokens or the stable unsubscribe token); staff actions go through the staff app (4f). | The legacy behaviour lets strangers unsubscribe or redirect someone else's subscription. | Agreed |
```

`open-questions.md`, Open table, after Q27:

```markdown
| Q28 | What are legacy NoD's exact list category keys (`ListCategory.Key`) and list keys, as gcpe-news-webapp sends them in `subscribedCategories`? | The public Subscribe API must accept the keys the real webapp sends; 4a assumes `ministries`/`sectors`/`themes`/`tags`/`emergency`, with list keys matching Core's keys. | As assumed; answered by `docs/parity/legacy-survey/06-nod.sql` query 1.5. | 2026-10-05 |
```

Also in Q27's row: add to the working assumption "Likely `Subscribe/SubscriberInformation?emailAddress=` (legacy `SubscribeController.SubscriberInformation`), which returns `SubscribedCategories`."

- [ ] **Step 2: Running notes and hand-check list**

`docs/manuals/running-notes.md`, add:

```markdown
## Phase 4 — NoD and Distribution

- **Operations** — Subscription emails link to `SUBSCRIBE_PAGE_URL` (default: the public site's
  `/subscribe/manage/`). Links last 24 hours. An address gets at most 3 confirmation/manage
  emails an hour; more requests are quietly ignored.
- **Operations** — A fresh NoD has no lists until Core's reference data reaches it; the stack asks
  Core to republish once at startup when NoD has no ministry lists.
- **Developer** — The public Subscribe API never reveals whether an address is subscribed, and
  takes link tokens only, never an email address in place of a token (C60).
```

`docs/deploy/siteground.md`, Hand-check list: add

```markdown
- [ ] **Phase 4 item 1** — on `https://boxs.ca/site/subscribe/`, subscribe an address you control (it arrives at the redirect addresses with a `[to: …]` prefix); open the link, change a preference, save; unsubscribe from the manage page.
```

- [ ] **Step 3: Full verification**

Run, from `/Users/paul/gcpe-news-platform-p4`:

```bash
npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json
npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p apps/staff-web/tsconfig.json
npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run
npx -y -p node@24 -- npm run test:e2e
```

Expected: both type-checks print nothing; vitest all green; e2e 44 passed, 1 skipped. Record the numbers in the commit message below.

- [ ] **Step 4: Commit, push, deploy**

```bash
git add docs
git commit -m "docs(parity): C60, Q28; Phase 4 running notes and hand-check"
git push -u origin feat/phase-4
npx -y -p node@24 -- bash scripts/deploy-siteground.sh
git -c http.postBuffer=524288000 push --force origin deploy/siteground:deploy/siteground
```

Then wait about 6 minutes **without polling boxs.ca** (polling keeps the old process alive), and verify:

```bash
curl -s "https://boxs.ca/api/Subscribe/SubscriptionItems/ministries?api-version=1.0" | head -c 300   # a JSON array of ministries (may be [] for one tick after the first start)
curl -s -o /dev/null -w "%{http_code}\n" https://boxs.ca/site/subscribe/                            # 200
curl -s https://boxs.ca/stack/health                                                                # all apps true
```

If `SubscriptionItems` stays `[]` after a few minutes, Core's republish ran but the dispatch hasn't: wait for the next scheduled `/stack/tick`. If it still returns `503 subscriptions unavailable`, the deployment has an explicit `NEWSAPI_NOD_BASE_URL=` override; report it rather than editing SiteGround settings.
```

---

## Self-review notes (for the reviewer)

- **Spec coverage:** §3 tables needed by 4a — subscribers (all new columns), list_categories, lists, subscriber_links, subscriber_history (Task 1); `deliveries`/`items`/`nod_settings` changes are 4b's. Core-fed lists (Task 2). §4 journeys 1–5 (Task 5) with legacy paths/shapes (Task 6), test-site pages (Task 7), per-email rate limit (Task 5). Acceptance items 1–2 (Task 7 e2e). C48 (Tasks 3, 5), C49 (Task 5), C50 (Task 5), C51 (unchanged `addSubscriber` stays immediate-active), C57 (verification saved; `notifyIfNewCategories` ignored), C60/Q28 (Task 8).
- **Ruling — the stable unsubscribe token is derived (HMAC), not stored:** the spec says "a separate, stable token per subscriber… only hashes stored". A stored hash can't be put into an email later; a keyed HMAC of the subscriber id and a version gives the same property (nothing in the database works as a token) and rotates by bumping the version. Cost if wrong: none for 4a; 4b puts it in `List-Unsubscribe`.
- **Ruling — Phase 2 `manage_token`:** kept and still honoured by Unsubscribe until 4b replaces as-it-happens footers; dropped in 4b.
- **Ruling — status codes:** void legacy endpoints answer `204` (ASP.NET Web API's behaviour for `void`); Update with a bad token answers `404` (legacy returned a silent `false`), so the test page can tell the user.
```
