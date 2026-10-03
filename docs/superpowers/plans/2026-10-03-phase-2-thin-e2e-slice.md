# Phase 2 — Thin E2E Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A release created in a minimal NRMS is auto-published on schedule and flows through events to the News API, a static HTML page, NoD and Distribution, ending as an email captured by an SMTP sink — proven by one automated end-to-end test.

**Architecture:** Four new thin apps (`nrms`, `public-site`, `nod`, `distribution`) follow the Phase 0/1 app template exactly (Express 5 + Drizzle + own Postgres DB + `@gcpe/events` outbox/receiver + `@gcpe/http-kit`). The News API gains an outbox and emits `site.rebuild_requested`. Apps talk only via signed events and one authenticated REST call (NoD → Distribution `POST /api/messages`). No staff UIs in this phase — those arrive with parity in Phases 3–5.

**Tech Stack:** Node ≥22.12, TypeScript 5.9 strict, Express 5.2, Drizzle 0.45 / drizzle-kit 0.31, zod 3.25, pg, jose, nodemailer (new), smtp-server + mailparser (new, dev only), vitest 4.1, supertest, esbuild via `scripts/build-app.mjs`.

**Spec:** `docs/superpowers/specs/2026-10-02-gcpe-news-platform-design.md` — §3 (apps, rules), §4 (events), §5 (release flow), §7.1–7.2, §7.5 (NoD/Distribution), §11 Phase 2 row ("Minimal NRMS publish → News API → static page → NoD → Distribution → Mailpit; exit check: reduced E2E test green").

## Global Constraints

- Node `>=22.12`; ESM (`"type": "module"`); TypeScript strict with `noUncheckedIndexedAccess`; `npm run check` (tsc) must stay clean.
- One Postgres database per app; no cross-database queries; apps interact only via REST and events (spec §3.1 rules 1–3).
- Each app must start and serve its own function with no subscribers or upstream apps configured (spec §3.1 rule 3).
- Events: producer writes to the outbox in the same transaction as the state change (`enqueueEvent`); receivers use `createEventReceiver` mounted before any body parser.
- Event sources (the `source` field and EVENT_SECRETS key): `core`, `nrms`, `news-api`. Event types added here: `site.rebuild_requested` only.
- Release types keep legacy values in mapping (Release=1…Advisory=5); in events they are `postKindSchema` strings (`releases|stories|factsheets|updates|advisories`).
- Staff/service API auth: `const auth = authFromEnv(process.env)` (Task 3) → `requireBearer(auth.bearer)` + `requireRole`, and mount `auth.loginRouter` when non-null — exactly as Core does after Task 3. Entra (RS256) and the optional local admin (HS256, test environments only) are both accepted. Roles: `Core.Admin`, `NRMS.Editor`, `NoD.Admin`, `Distribution.Send` (all in `ADMIN_ROLES`). App env never lists `ENTRA_TENANT_ID`/`AUTH_AUDIENCE` itself; `authFromEnv` owns them.
- Non-prod mail redirect on by default: Distribution refuses to start unless `MAIL_REDIRECT_TO` is set or `MAIL_ALLOW_REAL_RECIPIENTS=true` (spec §7.5, §10.1).
- All emails to subscribers carry `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (spec §7.1).
- Distribution priorities: system 100, media 40, immediate 30, digest 20; +2 for recipients in configured internal domains (spec §7.5).
- Hand-written fixtures use fictional personal data only (e.g. `alex.example@gov.bc.ca`, `250-555-0100`, "Honourable Sam Placeholder").
- Add npm dependencies with `npx -y npm@11 install …` (npm 10.9.4 arborist crash), then verify `npm ci` works.
- Commits: no Claude co-author trailers. Never commit `CLAUDE.md`.
- Tests that need a database use `createTestDatabase({ migrationsFolder })` from `@gcpe/db-kit`; never sleep for ordering — poll with `vi.waitFor`.

## Review Focus

1. **The scheduler publishes a release twice** when two NRMS replicas tick together, or a tick overlaps a slow one. Expected: exactly one `release.published` per release. → Task 4 test "two concurrent publishDue calls publish each release once".
2. **A subscriber gets the same As-It-Happens email twice** when `release.published` is redelivered, or the NoD send job is retried after Distribution already accepted it. Expected: one email. → Task 9 test (duplicate delivery inserts nothing) and Task 10 test (retry reuses the idempotency key; Distribution returns the existing batch).
3. **Hostile release content reaches HTML.** A headline containing `<script>` or an `{{manageUrl}}`-looking string must be escaped in the static page and the email; a header substitution containing CR/LF must not inject headers. → Task 6 render test and Task 7 substitution tests.
4. **A path-traversal key** (`../../etc`) in a rebuild request must never write outside the output directory. → Task 6 storage test.
5. **Real recipients in test environments.** Distribution with neither `MAIL_REDIRECT_TO` nor `MAIL_ALLOW_REAL_RECIPIENTS` set must refuse to start; with a redirect set, nobody but the redirect address receives mail, and the original recipient is recorded. → Task 8 env and redirect tests.

---

## File Structure

```
packages/events/src/catalogue.ts            + site.rebuild_requested schema, indexKeysFor (moved from news-api)
apps/news-api/src/projections.ts            emits site.rebuild_requested on release.*; imports indexKeysFor
apps/news-api/src/{env,main,shutdown}.ts    EVENT_SUBSCRIBERS + dispatcher
apps/nrms/        src/db/schema.ts  src/releases.ts  src/publisher.ts  src/http/routes.ts  src/app.ts  src/main.ts  test/helpers.ts  Dockerfile  drizzle.config.ts  package.json
apps/public-site/ src/db/schema.ts  src/storage.ts  src/render.ts  src/news-api-client.ts  src/rebuild.ts  src/app.ts  src/main.ts  test/helpers.ts  Dockerfile  drizzle.config.ts  package.json
apps/distribution/ src/db/schema.ts  src/priority.ts  src/substitute.ts  src/messages.ts  src/sender.ts  src/http/routes.ts  src/env.ts  src/app.ts  src/main.ts  test/helpers.ts  test/smtp-sink.ts  Dockerfile  drizzle.config.ts  package.json
apps/nod/         src/db/schema.ts  src/subscribers.ts  src/as-it-happens.ts  src/send-jobs.ts  src/distribution-client.ts  src/http/routes.ts  src/app.ts  src/main.ts  test/helpers.ts  Dockerfile  drizzle.config.ts  package.json
tests/e2e/thin-slice.test.ts                the Phase 2 exit check
tests/e2e/support.ts                        token minting + server helpers
vitest.config.ts, tsconfig.json             include tests/**
.github/workflows/ci.yml                    build + docker build the four new apps
README.md                                   new apps, env vars, running the slice
```

Each new app's `drizzle.config.ts` is identical to `apps/core/drizzle.config.ts`. Each schema starts with `export * from "@gcpe/events/tables";` so the outbox/inbox tables are in its migrations. Migrations are generated, never hand-written: `cd apps/<app> && npx drizzle-kit generate --name init`.

---

### Task 1: Event catalogue — `site.rebuild_requested` and shared `indexKeysFor`

**Files:**
- Modify: `packages/events/src/catalogue.ts`
- Modify: `apps/news-api/src/projections.ts` (remove local `indexKeysFor`, re-export from `@gcpe/events`)
- Test: `packages/events/src/catalogue-rebuild.test.ts`

**Interfaces:**
- Produces: `siteRebuildRequestedSchema`, `type SiteRebuildRequested = { pages: string[] }`, event type `"site.rebuild_requested"`, `indexKeysFor(r): string[]` exported from `@gcpe/events`. Page identifiers: `"home"` and `` `post:${key}` ``.

- [ ] **Step 1: Write the failing test**

```ts
// packages/events/src/catalogue-rebuild.test.ts
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { indexKeysFor, parseEvent } from "./catalogue";

const envelope = (data: unknown) => ({
  id: randomUUID(), type: "site.rebuild_requested", version: 1, source: "news-api", aggregateId: "post:k1",
  sequence: 1, occurredAt: "2026-10-03T17:00:00Z", correlationId: randomUUID(), data,
});

describe("site.rebuild_requested", () => {
  it("accepts a non-empty page list", () => {
    expect(parseEvent(envelope({ pages: ["home", "post:2026HLTH0001-000001"] })).data).toEqual({ pages: ["home", "post:2026HLTH0001-000001"] });
  });
  it("rejects an empty page list and empty identifiers", () => {
    expect(() => parseEvent(envelope({ pages: [] }))).toThrow();
    expect(() => parseEvent(envelope({ pages: [""] }))).toThrow();
  });
});

describe("indexKeysFor", () => {
  it("prefixes and lowercases every category key", () => {
    expect(indexKeysFor({ ministryKeys: ["Health"], sectorKeys: ["Mining"], tagKeys: [], themeKeys: ["Economy"] })).toEqual([
      "ministries:health", "sectors:mining", "themes:economy",
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/events/src/catalogue-rebuild.test.ts`
Expected: FAIL — `indexKeysFor` is not exported, and the rebuild event parses without validation.

- [ ] **Step 3: Implement**

In `packages/events/src/catalogue.ts`, after `siteContentChangedSchema`:

```ts
/** Page identifiers the public site builder understands: "home" and `post:<key>`. Unknown ids are skipped by the builder. */
export const siteRebuildRequestedSchema = z.object({ pages: z.array(z.string().min(1)).min(1) });
export type SiteRebuildRequested = z.infer<typeof siteRebuildRequestedSchema>;

/** Index keys a release is listed under (`ministries:health`, …), lowercased. Shared by the News API and NoD. */
export function indexKeysFor(r: Pick<ReleaseRecord, "ministryKeys" | "sectorKeys" | "tagKeys" | "themeKeys">): string[] {
  return [
    ...r.ministryKeys.map((k) => `ministries:${k}`),
    ...r.sectorKeys.map((k) => `sectors:${k}`),
    ...r.tagKeys.map((k) => `tags:${k}`),
    ...r.themeKeys.map((k) => `themes:${k}`),
  ].map((s) => s.toLowerCase());
}
```

Add `"site.rebuild_requested": siteRebuildRequestedSchema,` to `eventDataSchemas`.

In `apps/news-api/src/projections.ts`, delete the local `indexKeysFor` function, add `indexKeysFor` to the existing `@gcpe/events` import, and add `export { indexKeysFor };` so existing imports from `./projections` (tests, importer) keep working.

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/events apps/news-api && npm run check`
Expected: all PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add packages/events/src/catalogue.ts packages/events/src/catalogue-rebuild.test.ts apps/news-api/src/projections.ts
git commit -m "feat(events): site.rebuild_requested event and shared indexKeysFor"
```

---

### Task 2: News API emits `site.rebuild_requested`

**Files:**
- Modify: `apps/news-api/src/projections.ts` (`createProjectionHandlers`, `createSourceRestrictedHandlers` take options)
- Modify: `apps/news-api/src/app.ts` (`AppDeps.subscribers?: SubscriberConfig[]`, passed to handlers)
- Modify: `apps/news-api/src/env.ts` (`EVENT_SUBSCRIBERS` optional string, parsed with `parseSubscribers`)
- Modify: `apps/news-api/src/main.ts` (start dispatcher; pass subscribers)
- Modify: `apps/news-api/src/shutdown.ts` (`stopDispatcher` closer after the LISTEN connection, before the pool)
- Test: `apps/news-api/src/rebuild-events.test.ts`, update `apps/news-api/src/shutdown.test.ts` for the new closer

**Interfaces:**
- Consumes: Task 1 `site.rebuild_requested`.
- Produces: on every applied `release.published` / `release.updated` / `release.unpublished`, one outbox event `{ type: "site.rebuild_requested", source: "news-api", aggregateId: "post:<lowercased key>", data: { pages: ["home", "post:<key as received>"] }, correlationId: <incoming event's correlationId> }`. `createProjectionHandlers(opts?: { subscribers?: SubscriberConfig[] })`. `createSourceRestrictedHandlers(opts?)` likewise.

Why `aggregateId` is per post, not one `site` aggregate: receivers drop events whose sequence is lower than the last applied for that aggregate. With a single aggregate, a retried rebuild for post A delivered after a newer one for post B would be dropped as stale, and A's page would never be rebuilt. Per post, a newer rebuild of the same post correctly supersedes an older one.

- [ ] **Step 1: Write the failing test**

```ts
// apps/news-api/src/rebuild-events.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { sampleRelease } from "@gcpe/events/testing";
import { outboxEvents, type SubscriberConfig } from "@gcpe/events";
import { createNewsTestDb } from "../test/helpers";
import { createProjectionHandlers } from "./projections";

const subscribers: SubscriberConfig[] = [{ name: "public-site", url: "http://site.invalid/events", secret: "s", types: ["site.rebuild_requested"] }];
const event = (type: string, data: unknown) => ({
  id: crypto.randomUUID(), type, version: 1, source: "nrms", aggregateId: "k", sequence: 1,
  occurredAt: "2026-10-03T17:00:00Z", correlationId: "11111111-1111-4111-8111-111111111111", data,
});

describe("News API rebuild requests", () => {
  let tdb: TestDatabase;
  beforeAll(async () => { tdb = await createNewsTestDb(); });
  afterAll(async () => { await tdb.drop(); });
  beforeEach(async () => { await tdb.pool.query("TRUNCATE outbox_events, outbox_deliveries, aggregate_sequences, posts CASCADE"); });

  it("enqueues site.rebuild_requested in the same transaction as release.published", async () => {
    const handlers = createProjectionHandlers({ subscribers });
    await tdb.db.transaction((tx) => handlers["release.published"]!(tx, event("release.published", sampleRelease)));
    const rows = await tdb.db.select().from(outboxEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "site.rebuild_requested", aggregateId: `post:${sampleRelease.key.toLowerCase()}` });
    expect((rows[0]!.payload as { data: unknown; correlationId: string })).toMatchObject({
      data: { pages: ["home", `post:${sampleRelease.key}`] },
      correlationId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("enqueues nothing when the projection transaction rolls back", async () => {
    const handlers = createProjectionHandlers({ subscribers });
    await expect(tdb.db.transaction(async (tx) => {
      await handlers["release.published"]!(tx, event("release.published", sampleRelease));
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await tdb.db.select().from(outboxEvents)).toHaveLength(0);
  });

  it("enqueues a rebuild for unpublish too", async () => {
    const handlers = createProjectionHandlers({ subscribers });
    await tdb.db.transaction((tx) => handlers["release.unpublished"]!(tx, event("release.unpublished", { key: sampleRelease.key })));
    expect(await tdb.db.select().from(outboxEvents)).toHaveLength(1);
  });

  it("still applies with no subscribers configured (rule 3) and writes no deliveries", async () => {
    const handlers = createProjectionHandlers();
    await tdb.db.transaction((tx) => handlers["release.published"]!(tx, event("release.published", sampleRelease)));
    const { rows } = await tdb.pool.query("SELECT count(*)::int AS n FROM outbox_deliveries");
    expect(rows[0].n).toBe(0);
  });
});
```

Before writing the assertions on `outboxEvents` columns, open `packages/events/src/tables.ts` and use its actual column names (the envelope column may not be called `payload`; adjust the test to the real name, and keep the assertions themselves).

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/news-api/src/rebuild-events.test.ts`
Expected: FAIL — no outbox rows.

- [ ] **Step 3: Implement**

In `projections.ts`:

```ts
import { enqueueEvent, type SubscriberConfig } from "@gcpe/events";

export interface ProjectionOptions { subscribers?: SubscriberConfig[] }

async function requestRebuild(tx: Tx, key: string, correlationId: string, subscribers: SubscriberConfig[]): Promise<void> {
  await enqueueEvent(
    tx,
    { type: "site.rebuild_requested", source: "news-api", aggregateId: `post:${key.toLowerCase()}`, data: { pages: ["home", `post:${key}`] }, correlationId },
    subscribers,
  );
}

export function createProjectionHandlers(opts: ProjectionOptions = {}): Record<string, EventHandler> {
  const subscribers = opts.subscribers ?? [];
  // …existing term handlers unchanged…
  const releaseApplied: EventHandler = async (tx, e) => {
    const r = e.data as ReleaseRecord;
    await applyRelease(tx, r);
    await requestRebuild(tx, r.key, e.correlationId, subscribers);
  };
  return {
    // …existing entries unchanged except:
    "release.published": releaseApplied,
    "release.updated": releaseApplied,
    "release.unpublished": async (tx, e) => {
      const { key } = e.data as { key: string };
      await unpublishRelease(tx, key);
      await requestRebuild(tx, key, e.correlationId, subscribers);
    },
  };
}

export function createSourceRestrictedHandlers(opts: ProjectionOptions = {}): (event: EventEnvelope) => EventHandler | undefined {
  const handlers = createProjectionHandlers(opts);
  // …body unchanged
}
```

`enqueueEvent` with zero matching subscribers still writes the outbox event row and no deliveries — that is what the "no subscribers" test pins. If the existing `enqueueEvent` writes no row at all with zero subscribers, change the test's expectation to match the existing behaviour. Do not change `enqueueEvent`.

`app.ts`: add `subscribers?: SubscriberConfig[]` to `AppDeps` and call `createSourceRestrictedHandlers({ subscribers: deps.subscribers })`.

`env.ts`: add `EVENT_SUBSCRIBERS: z.string().optional()` to `newsApiEnvSchema`.

`main.ts`:

```ts
import { parseSubscribers, startDispatcher } from "@gcpe/events";
const subscribers = parseSubscribers(env.EVENT_SUBSCRIBERS);
const stopDispatcher = startDispatcher({ db, subscribers });
// createApp({ …, subscribers })
// createNewsApiShutdown({ …, stopDispatcher })
```

`shutdown.ts`: add `stopDispatcher: () => Promise<void>` to `ShutdownDeps`, and add the closer `{ name: "event dispatcher", close: deps.stopDispatcher }` after "LISTEN connection" and before "db pool". Update `shutdown.test.ts` so the closer order assertion includes it.

- [ ] **Step 4: Run tests**

Run: `npx vitest run apps/news-api && npm run check`
Expected: all PASS (including the existing e2e-core and compat suites).

- [ ] **Step 5: Commit**

```bash
git add apps/news-api
git commit -m "feat(news-api): emit site.rebuild_requested from release projections"
```

---

### Task 3: Local admin login (Entra bypass for test environments)

**Why:** the owner has no Entra app registrations yet and needs to sign in to test deployments, SiteGround included. Spec §10.1 is amended in this task: Entra remains the production identity provider, and an optional local admin account exists for test environments only.

**Files:**
- Create: `packages/auth/src/password.ts`, `packages/auth/src/local.ts`, `packages/auth/src/from-env.ts`, `packages/auth/src/cli/hash-password.ts`
- Modify: `packages/auth/src/bearer.ts`, `packages/auth/src/index.ts`, `packages/auth/package.json` (add `express-rate-limit` and `zod`, same versions as the News API and Core), root `package.json` (script `"auth:hash-password": "tsx packages/auth/src/cli/hash-password.ts"`)
- Modify: `apps/core/src/main.ts` and `apps/core/src/app.ts` — the Core reference wiring every later app copies
- Modify: `docs/superpowers/specs/2026-10-02-gcpe-news-platform-design.md` §3.4 and §10.1, `.env.example`
- Test: `packages/auth/src/password.test.ts`, `packages/auth/src/local.test.ts`, `packages/auth/src/from-env.test.ts`, extend `apps/core/src/http/routes.test.ts`

**Interfaces:**
- Produces:
  - `hashPassword(pw: string): Promise<string>` → `scrypt$16384$8$1$<saltB64url>$<hashB64url>`
  - `verifyPassword(pw: string, stored: string): Promise<boolean>`
  - `LOCAL_ISSUER = "gcpe-local"`, `LOCAL_AUDIENCE = "gcpe-local"`
  - `ADMIN_ROLES = ["Core.Admin", "NRMS.Editor", "NoD.Admin", "Distribution.Send"]`
  - `mintLocalToken({ secret, subject, roles, azp?, ttlSeconds? }): Promise<string>` — HS256, default TTL 8 h
  - `localLoginRouter(cfg: LocalAuthConfig): Router` — `POST /auth/local/token` body `{ username, password }` → 200 `{ access_token, token_type: "Bearer", expires_in }` | 401 `{ error: "invalid credentials" }` | 429
  - `requireBearer(opts: BearerOptions)` where `BearerOptions = { issuer?: string; audience?: string; keys?: JWTVerifyGetKey; local?: { secret: string } }`
  - `authFromEnv(env: NodeJS.ProcessEnv): { bearer: BearerOptions; loginRouter: Router | null; local: LocalAuthConfig | null }` — throws if neither Entra nor local is configured
  - `LocalAuthConfig = { username: string; passwordHash: string; secret: string }`
- Env (all apps with an `/api`):
  - `ENTRA_TENANT_ID` and `AUTH_AUDIENCE` (now optional; set both or neither)
  - `LOCAL_ADMIN_ENABLED` (`"true"`/`"false"`, default false)
  - `LOCAL_ADMIN_USERNAME` (default `admin`)
  - `LOCAL_ADMIN_PASSWORD_HASH` (output of `npm run auth:hash-password`)
  - `LOCAL_AUTH_SECRET` (≥ 32 characters; shared by every app in one environment so one login works everywhere)
- Consumed by Tasks 5, 9 and 10: every new app builds its auth with `authFromEnv(process.env)`, passes `bearer` to `requireBearer`, and mounts `loginRouter` when non-null. NoD mints its Distribution service token with `mintLocalToken` when no Entra client credentials are configured (Task 10).

**Security rules (each one pinned by a test):**
1. Algorithms are pinned per path. Local tokens are HS256 only, verified with `LOCAL_AUTH_SECRET`, issuer `gcpe-local`, audience `gcpe-local`. Entra tokens are RS256 only, as before. An RS256 token claiming `iss: gcpe-local`, or an HS256 token claiming the Entra issuer, is rejected. Branch on the token's `alg` header, but verify with the pinned algorithm list of that branch.
2. When local auth is disabled, an HS256 token is rejected even if it is correctly signed with the secret.
3. The password is stored only as a scrypt hash and compared with `timingSafeEqual`. A wrong username still runs `verifyPassword` against the configured hash, so timing doesn't reveal valid usernames. Both failures return the same 401 body.
4. `POST /auth/local/token` is rate-limited: 10 requests per minute per IP, with `express-rate-limit`. Its JSON body limit is 1 kb.
5. Enabled requires a hash in the `scrypt$…` format and a secret of at least 32 characters, or startup fails with a clear message. Startup logs `[auth] LOCAL ADMIN LOGIN ENABLED — test environments only`.
6. `LOCAL_ADMIN_ENABLED` is parsed as the strings `"true"`/`"false"`; `"false"` means disabled.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/auth/src/password.test.ts
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";
describe("password hashing", () => {
  it("round-trips and rejects wrong passwords", async () => {
    const h = await hashPassword("correct horse battery staple");
    expect(h).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(await verifyPassword("correct horse battery staple", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
  });
  it("salts: the same password hashes differently", async () => {
    expect(await hashPassword("x")).not.toBe(await hashPassword("x"));
  });
  it("returns false (does not throw) for malformed stored hashes", async () => {
    expect(await verifyPassword("x", "plaintext")).toBe(false);
    expect(await verifyPassword("x", "scrypt$1$1$1$$")).toBe(false);
  });
});
```

```ts
// packages/auth/src/local.test.ts
import express from "express";
import request from "supertest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { requireBearer, requireRole } from "./bearer";
import { ADMIN_ROLES, LOCAL_AUDIENCE, LOCAL_ISSUER, localLoginRouter, mintLocalToken } from "./local";
import { hashPassword } from "./password";

const secret = "a".repeat(32) + "-local-test-secret";
const entra = { issuer: "https://login.microsoftonline.com/t/v2.0", audience: "api://core" };

function appWith(opts: Parameters<typeof requireBearer>[0], login?: express.Router) {
  const app = express();
  if (login) app.use(login);
  app.get("/api/x", requireBearer(opts), requireRole("Core.Admin"), (req, res) => void res.json({ sub: req.auth!.subject }));
  return app;
}

describe("local admin auth", () => {
  let passwordHash: string;
  let rsa: Awaited<ReturnType<typeof generateKeyPair>>;
  let keys: ReturnType<typeof createLocalJWKSet>;
  beforeAll(async () => {
    passwordHash = await hashPassword("s3cret-pass");
    rsa = await generateKeyPair("RS256");
    keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(rsa.publicKey)), kid: "k", alg: "RS256" }] });
  });

  it("logs in and the token works on the API", async () => {
    const login = localLoginRouter({ username: "admin", passwordHash, secret });
    const app = appWith({ ...entra, keys, local: { secret } }, login);
    const res = await request(app).post("/auth/local/token").send({ username: "admin", password: "s3cret-pass" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ token_type: "Bearer", expires_in: 28800 });
    const api = await request(app).get("/api/x").set("authorization", `Bearer ${res.body.access_token}`);
    expect(api.body).toEqual({ sub: "admin" });
  });

  it("gives the same 401 for a wrong username and a wrong password", async () => {
    const app = appWith({ local: { secret } }, localLoginRouter({ username: "admin", passwordHash, secret }));
    const a = await request(app).post("/auth/local/token").send({ username: "nobody", password: "s3cret-pass" });
    const b = await request(app).post("/auth/local/token").send({ username: "admin", password: "nope" });
    expect([a.status, b.status]).toEqual([401, 401]);
    expect(a.body).toEqual(b.body);
  });

  it("rate-limits login attempts", async () => {
    const app = appWith({ local: { secret } }, localLoginRouter({ username: "admin", passwordHash, secret }));
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await request(app).post("/auth/local/token").send({ username: "admin", password: "x" })).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it("rejects a correctly signed local token when local auth is disabled", async () => {
    const token = await mintLocalToken({ secret, subject: "admin", roles: [...ADMIN_ROLES] });
    const res = await request(appWith({ ...entra, keys })).get("/api/x").set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it("rejects algorithm/issuer confusion in both directions", async () => {
    const app = appWith({ ...entra, keys, local: { secret } });
    const rsWithLocalIss = await new SignJWT({ roles: ["Core.Admin"] }).setProtectedHeader({ alg: "RS256", kid: "k" })
      .setIssuer(LOCAL_ISSUER).setAudience(LOCAL_AUDIENCE).setSubject("x").setExpirationTime("5m").sign(rsa.privateKey);
    const hsWithEntraIss = await new SignJWT({ roles: ["Core.Admin"] }).setProtectedHeader({ alg: "HS256" })
      .setIssuer(entra.issuer).setAudience(entra.audience).setSubject("x").setExpirationTime("5m").sign(new TextEncoder().encode(secret));
    expect((await request(app).get("/api/x").set("authorization", `Bearer ${rsWithLocalIss}`)).status).toBe(401);
    expect((await request(app).get("/api/x").set("authorization", `Bearer ${hsWithEntraIss}`)).status).toBe(401);
  });

  it("rejects a local token signed with a different secret, and an expired one", async () => {
    const app = appWith({ local: { secret } });
    const wrong = await mintLocalToken({ secret: "b".repeat(40), subject: "admin", roles: [...ADMIN_ROLES] });
    const expired = await mintLocalToken({ secret, subject: "admin", roles: [...ADMIN_ROLES], ttlSeconds: -10 });
    expect((await request(app).get("/api/x").set("authorization", `Bearer ${wrong}`)).status).toBe(401);
    expect((await request(app).get("/api/x").set("authorization", `Bearer ${expired}`)).status).toBe(401);
  });

  it("still accepts Entra RS256 tokens alongside local auth", async () => {
    const t = await new SignJWT({ roles: ["Core.Admin"] }).setProtectedHeader({ alg: "RS256", kid: "k" })
      .setIssuer(entra.issuer).setAudience(entra.audience).setSubject("svc").setExpirationTime("5m").sign(rsa.privateKey);
    expect((await request(appWith({ ...entra, keys, local: { secret } })).get("/api/x").set("authorization", `Bearer ${t}`)).body).toEqual({ sub: "svc" });
  });
});
```

```ts
// packages/auth/src/from-env.test.ts
import { describe, expect, it } from "vitest";
import { authFromEnv } from "./from-env";
const hash = "scrypt$16384$8$1$c2FsdA$aGFzaA";
const secret = "x".repeat(32);
describe("authFromEnv", () => {
  it("throws when neither Entra nor local admin is configured", () => {
    expect(() => authFromEnv({})).toThrow(/ENTRA_TENANT_ID.*LOCAL_ADMIN_ENABLED/s);
  });
  it("throws when only one of ENTRA_TENANT_ID / AUTH_AUDIENCE is set", () => {
    expect(() => authFromEnv({ ENTRA_TENANT_ID: "t" })).toThrow(/AUTH_AUDIENCE/);
  });
  it("enables local admin only with a valid hash and a long secret", () => {
    expect(() => authFromEnv({ LOCAL_ADMIN_ENABLED: "true", LOCAL_ADMIN_PASSWORD_HASH: "plain", LOCAL_AUTH_SECRET: secret })).toThrow(/LOCAL_ADMIN_PASSWORD_HASH/);
    expect(() => authFromEnv({ LOCAL_ADMIN_ENABLED: "true", LOCAL_ADMIN_PASSWORD_HASH: hash, LOCAL_AUTH_SECRET: "short" })).toThrow(/LOCAL_AUTH_SECRET/);
    const a = authFromEnv({ LOCAL_ADMIN_ENABLED: "true", LOCAL_ADMIN_PASSWORD_HASH: hash, LOCAL_AUTH_SECRET: secret });
    expect(a.local).toEqual({ username: "admin", passwordHash: hash, secret });
    expect(a.loginRouter).not.toBeNull();
    expect(a.bearer.local).toEqual({ secret });
  });
  it('treats LOCAL_ADMIN_ENABLED="false" as disabled', () => {
    expect(() => authFromEnv({ LOCAL_ADMIN_ENABLED: "false", LOCAL_ADMIN_PASSWORD_HASH: hash, LOCAL_AUTH_SECRET: secret })).toThrow();
  });
  it("Entra only: no login router", () => {
    const a = authFromEnv({ ENTRA_TENANT_ID: "t", AUTH_AUDIENCE: "api://core" });
    expect(a.loginRouter).toBeNull();
    expect(a.bearer).toMatchObject({ issuer: "https://login.microsoftonline.com/t/v2.0", audience: "api://core" });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/auth`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

```ts
// packages/auth/src/password.ts
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

const N = 16384, R = 8, P = 1, KEYLEN = 64;
const scrypt = (pw: string, salt: Buffer, keylen: number, opts: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(pw, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export const PASSWORD_HASH_FORMAT = /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/;

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  if (!PASSWORD_HASH_FORMAT.test(stored)) return false;
  const [, n, r, p, saltB64, hashB64] = stored.split("$");
  const expected = Buffer.from(hashB64!, "base64url");
  if (expected.length === 0) return false;
  try {
    const actual = await scrypt(pw, Buffer.from(saltB64!, "base64url"), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
```

```ts
// packages/auth/src/local.ts
import express, { Router } from "express";
import rateLimit from "express-rate-limit";
import { SignJWT } from "jose";
import { verifyPassword } from "./password";

export const LOCAL_ISSUER = "gcpe-local";
export const LOCAL_AUDIENCE = "gcpe-local";
export const ADMIN_ROLES = ["Core.Admin", "NRMS.Editor", "NoD.Admin", "Distribution.Send"] as const;
const DEFAULT_TTL = 8 * 60 * 60;

export interface LocalAuthConfig { username: string; passwordHash: string; secret: string }

export const localKey = (secret: string) => new TextEncoder().encode(secret);

export async function mintLocalToken(o: { secret: string; subject: string; roles: readonly string[]; azp?: string; ttlSeconds?: number }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ roles: [...o.roles], ...(o.azp ? { azp: o.azp } : {}) })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(LOCAL_ISSUER)
    .setAudience(LOCAL_AUDIENCE)
    .setSubject(o.subject)
    .setIssuedAt(now)
    .setExpirationTime(now + (o.ttlSeconds ?? DEFAULT_TTL))
    .sign(localKey(o.secret));
}

export function localLoginRouter(cfg: LocalAuthConfig, opts: { ratePerMinute?: number } = {}): Router {
  const r = Router();
  r.post(
    "/auth/local/token",
    rateLimit({ windowMs: 60_000, limit: opts.ratePerMinute ?? 10, standardHeaders: "draft-7", legacyHeaders: false }),
    express.json({ limit: "1kb" }),
    async (req, res) => {
      const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
      const pw = typeof password === "string" ? password : "";
      // Always run the hash comparison so a wrong username costs the same as a wrong password.
      const passwordOk = await verifyPassword(pw, cfg.passwordHash);
      if (username !== cfg.username || !passwordOk) return void res.status(401).json({ error: "invalid credentials" });
      const access_token = await mintLocalToken({ secret: cfg.secret, subject: cfg.username, roles: ADMIN_ROLES });
      res.json({ access_token, token_type: "Bearer", expires_in: DEFAULT_TTL });
    },
  );
  return r;
}
```

`bearer.ts`: replace `requireBearer`:

```ts
import { decodeProtectedHeader, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { LOCAL_AUDIENCE, LOCAL_ISSUER, localKey } from "./local";

export interface BearerOptions { issuer?: string; audience?: string; keys?: JWTVerifyGetKey; local?: { secret: string } }

export function requireBearer(opts: BearerOptions): RequestHandler {
  const entra = opts.issuer && opts.audience && opts.keys ? { issuer: opts.issuer, audience: opts.audience, keys: opts.keys } : null;
  const local = opts.local ? { key: localKey(opts.local.secret) } : null;
  return async (req, res, next) => {
    const header = req.header("authorization");
    if (!header?.startsWith("Bearer ")) return void res.status(401).json({ error: "missing bearer token" });
    const token = header.slice(7);
    try {
      const alg = decodeProtectedHeader(token).alg;
      let payload: JWTPayload;
      if (alg === "HS256" && local) {
        ({ payload } = await jwtVerify(token, local.key, { issuer: LOCAL_ISSUER, audience: LOCAL_AUDIENCE, algorithms: ["HS256"] }));
      } else if (entra) {
        ({ payload } = await jwtVerify(token, entra.keys, { issuer: entra.issuer, audience: entra.audience, algorithms: ["RS256"] }));
      } else {
        throw new Error("no verifier for token");
      }
      req.auth = { subject: String(payload.sub), roles: Array.isArray(payload.roles) ? payload.roles.map(String) : [], claims: payload as Record<string, unknown> };
      next();
    } catch {
      res.status(401).json({ error: "invalid token" });
    }
  };
}
```

`local.ts` imports nothing from `bearer.ts`, so there is no import cycle.

```ts
// packages/auth/src/from-env.ts
import type { Router } from "express";
import { z } from "zod";
import { entraIssuer, entraJwks, type BearerOptions } from "./bearer";
import { localLoginRouter, type LocalAuthConfig } from "./local";
import { PASSWORD_HASH_FORMAT } from "./password";

const schema = z
  .object({
    ENTRA_TENANT_ID: z.string().min(1).optional(),
    AUTH_AUDIENCE: z.string().min(1).optional(),
    LOCAL_ADMIN_ENABLED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
    LOCAL_ADMIN_USERNAME: z.string().min(1).default("admin"),
    LOCAL_ADMIN_PASSWORD_HASH: z.string().optional(),
    LOCAL_AUTH_SECRET: z.string().optional(),
  })
  .superRefine((e, ctx) => {
    if (Boolean(e.ENTRA_TENANT_ID) !== Boolean(e.AUTH_AUDIENCE)) ctx.addIssue({ code: "custom", message: "set both ENTRA_TENANT_ID and AUTH_AUDIENCE, or neither" });
    if (e.LOCAL_ADMIN_ENABLED) {
      if (!e.LOCAL_ADMIN_PASSWORD_HASH || !PASSWORD_HASH_FORMAT.test(e.LOCAL_ADMIN_PASSWORD_HASH))
        ctx.addIssue({ code: "custom", message: "LOCAL_ADMIN_PASSWORD_HASH must be the output of `npm run auth:hash-password`" });
      if (!e.LOCAL_AUTH_SECRET || e.LOCAL_AUTH_SECRET.length < 32) ctx.addIssue({ code: "custom", message: "LOCAL_AUTH_SECRET must be at least 32 characters" });
    }
    if (!e.ENTRA_TENANT_ID && !e.LOCAL_ADMIN_ENABLED)
      ctx.addIssue({ code: "custom", message: "configure ENTRA_TENANT_ID + AUTH_AUDIENCE, or LOCAL_ADMIN_ENABLED=true (test environments)" });
  });

export function authFromEnv(env: NodeJS.ProcessEnv): { bearer: BearerOptions; loginRouter: Router | null; local: LocalAuthConfig | null } {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`auth configuration: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const e = parsed.data;
  const local = e.LOCAL_ADMIN_ENABLED ? { username: e.LOCAL_ADMIN_USERNAME, passwordHash: e.LOCAL_ADMIN_PASSWORD_HASH!, secret: e.LOCAL_AUTH_SECRET! } : null;
  if (local) console.warn("[auth] LOCAL ADMIN LOGIN ENABLED — test environments only");
  return {
    bearer: {
      ...(e.ENTRA_TENANT_ID ? { issuer: entraIssuer(e.ENTRA_TENANT_ID), audience: e.AUTH_AUDIENCE!, keys: entraJwks(e.ENTRA_TENANT_ID) } : {}),
      ...(local ? { local: { secret: local.secret } } : {}),
    },
    loginRouter: local ? localLoginRouter(local) : null,
    local,
  };
}
```

`entraJwks` builds a remote JWKS lazily (jose fetches on first verification), so `authFromEnv` makes no network call.

```ts
// packages/auth/src/cli/hash-password.ts — reads the password from stdin so it never lands in shell history.
import { createInterface } from "node:readline/promises";
import { hashPassword } from "../password";

const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY });
const pw = await rl.question("Password for the local admin (input hidden if a TTY is attached): ");
rl.close();
if (pw.length < 12) {
  console.error("Use at least 12 characters.");
  process.exit(1);
}
console.log(await hashPassword(pw));
```

`index.ts`: also export `authFromEnv`, `ADMIN_ROLES`, `LOCAL_AUDIENCE`, `LOCAL_ISSUER`, `localLoginRouter`, `mintLocalToken`, `type LocalAuthConfig`, `type BearerOptions`, `hashPassword` and `verifyPassword`.

Core wiring (the reference for later apps):
- `apps/core/src/main.ts`: delete `ENTRA_TENANT_ID` and `AUTH_AUDIENCE` from its zod schema. Add `const auth = authFromEnv(process.env);` and pass `auth: auth.bearer, loginRouter: auth.loginRouter` to `createApp`.
- `apps/core/src/app.ts`: `deps.auth` becomes `BearerOptions`; add `loginRouter?: Router | null`. Mount `if (deps.loginRouter) app.use(deps.loginRouter);` after `healthRoutes` and before `/api`.
- Extend `routes.test.ts` with one case: a Core app built with `local: { secret }` and a login router; log in → `POST /api/organizations` with the token → 2xx.

Spec amendments:
- §3.4 Auth bullet: append " — plus an optional local admin account for test environments (§10.1)".
- §10.1, new bullet: "**Local admin (test environments only):** `LOCAL_ADMIN_ENABLED=true` enables one admin account (username + scrypt password hash) that signs in at `POST /auth/local/token` and receives an 8-hour HS256 token (issuer/audience `gcpe-local`) carrying all admin roles. It is off by default and must never be enabled in production; Entra remains the only production identity provider."

`.env.example`: add the four `LOCAL_*` variables with comments, and mark `ENTRA_TENANT_ID`/`AUTH_AUDIENCE` optional.

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/auth apps/core && npm run check && npm test`
Expected: all PASS.

- [ ] **Step 5: Manual check of the CLI**

Run: `echo 'a-long-test-password' | npm run -s auth:hash-password`
Expected: one line matching `scrypt$16384$8$1$…$…`.

- [ ] **Step 6: Commit**

```bash
git add packages/auth apps/core package.json package-lock.json .env.example docs/superpowers/specs/2026-10-02-gcpe-news-platform-design.md
git commit -m "feat(auth): optional local admin login for test environments"
```

---

### Task 4: NRMS (thin) — schema, release service, scheduled publisher

**Files:**
- Create: `apps/nrms/package.json`, `apps/nrms/drizzle.config.ts`, `apps/nrms/src/db/schema.ts`, `apps/nrms/src/releases.ts`, `apps/nrms/src/publisher.ts`, `apps/nrms/test/helpers.ts`, `apps/nrms/migrations/*` (generated)
- Test: `apps/nrms/src/releases.test.ts`, `apps/nrms/src/publisher.test.ts`

**Interfaces:**
- Produces:
  - `releaseDraftSchema` (zod) and `type ReleaseDraft`
  - `createDraft(db: Db, draft: ReleaseDraft): Promise<void>` — throws `ReleaseExistsError` if the key exists, in any casing
  - `scheduleRelease(db: Db, key: string, publishAt: Date): Promise<void>` — throws `ReleaseNotFoundError`, or `ReleaseAlreadyPublishedError`
  - `getRelease(db: Db, key: string): Promise<ReleaseRow | undefined>`
  - `publishDue(opts: { db: Db; subscribers: SubscriberConfig[]; now?: () => Date; limit?: number }): Promise<{ published: string[] }>`
  - `startPublisher(opts & { intervalMs?: number }): () => Promise<void>` (default interval 60 000 ms)
  - `createNrmsTestDb()` in `test/helpers.ts`; `sampleDraft` fixture

`package.json` mirrors `apps/core/package.json`: name `@gcpe/nrms`, the same dependencies minus `@gcpe/legacy-import`, and `"build": "node ../../scripts/build-app.mjs apps/nrms"`. Run `npx -y npm@11 install` at the repo root afterwards so the workspace links.

- [ ] **Step 1: Schema**

```ts
// apps/nrms/src/db/schema.ts
import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { PostKind, ReleaseRecord } from "@gcpe/events";

export * from "@gcpe/events/tables";

export type ReleaseStatus = "draft" | "scheduled" | "published";
/** Everything in the published record that the author controls. */
export type ReleaseContent = Omit<ReleaseRecord, "key" | "kind" | "publishDate" | "timestamp" | "atomId" | "renditions">;

export const releases = pgTable(
  "releases",
  {
    key: text("key").primaryKey(),
    kind: text("kind").$type<PostKind>().notNull(),
    status: text("status").$type<ReleaseStatus>().notNull().default("draft"),
    publishAt: timestamp("publish_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    content: jsonb("content").$type<ReleaseContent>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("releases_key_lower_idx").on(sql`lower(${t.key})`),
    index("releases_due_idx").on(t.publishAt).where(sql`${t.status} = 'scheduled'`),
  ],
);
export type ReleaseRow = typeof releases.$inferSelect;
```

Add a check constraint for status. If drizzle-kit 0.31 `check()` is available, use it; otherwise append it to the generated migration: `ALTER TABLE "releases" ADD CONSTRAINT "releases_status_check" CHECK (status IN ('draft','scheduled','published'));`.

Generate: `cd apps/nrms && npx drizzle-kit generate --name init`.

- [ ] **Step 2: Write the failing tests**

```ts
// apps/nrms/test/helpers.ts
import { fileURLToPath } from "node:url";
import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";
import type { ReleaseDraft } from "../src/releases";

export const nrmsMigrations = fileURLToPath(new URL("../migrations", import.meta.url));
export const createNrmsTestDb = (): Promise<TestDatabase> => createTestDatabase({ migrationsFolder: nrmsMigrations });

export const sampleDraft: ReleaseDraft = {
  key: "2026HLTH0001-000001",
  kind: "releases",
  reference: "NEWS-00001",
  leadMinistryKey: "health",
  summary: "Clinics open on weekends.",
  socialMediaSummary: null,
  socialMediaHeadline: null,
  keywords: null,
  location: "VICTORIA",
  hasMediaAssets: false,
  hasTranslations: false,
  isNewsOnDemand: true,
  assetUrl: null,
  redirectUri: null,
  documents: [{
    pageTitle: "Weekend clinics", languageId: 4105, headline: "Weekend clinics open across B.C.", subheadline: null,
    detailsHtml: "<p>Clinics will open on weekends.</p>", byline: null,
    contacts: [{ title: "Media Relations", details: "Alex Example\n250-555-0100" }],
  }],
  ministryKeys: ["health"], sectorKeys: [], tagKeys: [], themeKeys: [],
  assets: null, translations: null,
  publishFlags: { toWeb: true, toSubscribers: true, toMediaLists: false },
  mediaListKeys: [],
};
```

```ts
// apps/nrms/src/releases.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNrmsTestDb, sampleDraft } from "../test/helpers";
import { createDraft, getRelease, ReleaseAlreadyPublishedError, ReleaseExistsError, ReleaseNotFoundError, releaseDraftSchema, scheduleRelease } from "./releases";

describe("NRMS releases", () => {
  let tdb: TestDatabase;
  beforeAll(async () => { tdb = await createNrmsTestDb(); });
  afterAll(async () => { await tdb.drop(); });
  beforeEach(async () => { await tdb.pool.query("TRUNCATE releases"); });

  it("creates a draft and rejects the same key in another casing", async () => {
    await createDraft(tdb.db, sampleDraft);
    expect((await getRelease(tdb.db, sampleDraft.key))?.status).toBe("draft");
    await expect(createDraft(tdb.db, { ...sampleDraft, key: sampleDraft.key.toLowerCase() })).rejects.toBeInstanceOf(ReleaseExistsError);
  });

  it("looks releases up case-insensitively", async () => {
    await createDraft(tdb.db, sampleDraft);
    expect((await getRelease(tdb.db, sampleDraft.key.toLowerCase()))?.key).toBe(sampleDraft.key);
  });

  it("schedules a draft and refuses to reschedule a published release", async () => {
    await createDraft(tdb.db, sampleDraft);
    const at = new Date("2026-10-03T17:00:00Z");
    await scheduleRelease(tdb.db, sampleDraft.key, at);
    expect(await getRelease(tdb.db, sampleDraft.key)).toMatchObject({ status: "scheduled", publishAt: at });
    await tdb.pool.query("UPDATE releases SET status = 'published'");
    await expect(scheduleRelease(tdb.db, sampleDraft.key, at)).rejects.toBeInstanceOf(ReleaseAlreadyPublishedError);
    await expect(scheduleRelease(tdb.db, "nope", at)).rejects.toBeInstanceOf(ReleaseNotFoundError);
  });

  it("validates keys: letters, digits and hyphens only", () => {
    expect(releaseDraftSchema.safeParse({ ...sampleDraft, key: "../x" }).success).toBe(false);
    expect(releaseDraftSchema.safeParse({ ...sampleDraft, key: "a b" }).success).toBe(false);
    expect(releaseDraftSchema.safeParse(sampleDraft).success).toBe(true);
  });
});
```

```ts
// apps/nrms/src/publisher.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { outboxEvents, parseEvent, type SubscriberConfig } from "@gcpe/events";
import { createNrmsTestDb, sampleDraft } from "../test/helpers";
import { createDraft, getRelease, scheduleRelease } from "./releases";
import { publishDue } from "./publisher";

const subscribers: SubscriberConfig[] = [{ name: "news-api", url: "http://news.invalid/events", secret: "s", types: ["release.published"] }];
const NOW = new Date("2026-10-03T17:00:30Z");

describe("publishDue", () => {
  let tdb: TestDatabase;
  beforeAll(async () => { tdb = await createNrmsTestDb(); });
  afterAll(async () => { await tdb.drop(); });
  beforeEach(async () => { await tdb.pool.query("TRUNCATE releases, outbox_events, outbox_deliveries, aggregate_sequences CASCADE"); });

  it("publishes due releases with a complete release.published event", async () => {
    await createDraft(tdb.db, sampleDraft);
    await scheduleRelease(tdb.db, sampleDraft.key, new Date("2026-10-03T17:00:00Z"));
    expect(await publishDue({ db: tdb.db, subscribers, now: () => NOW })).toEqual({ published: [sampleDraft.key] });
    expect(await getRelease(tdb.db, sampleDraft.key)).toMatchObject({ status: "published", publishedAt: NOW });
    const [row] = await tdb.db.select().from(outboxEvents);
    // Use the real envelope column from packages/events/src/tables.ts.
    const env = parseEvent((row as Record<string, unknown>).payload);
    expect(env).toMatchObject({ type: "release.published", source: "nrms", aggregateId: sampleDraft.key });
    expect(env.data).toMatchObject({ key: sampleDraft.key, kind: "releases", publishDate: NOW.toISOString(), timestamp: NOW.toISOString(), atomId: null, renditions: null });
  });

  it("leaves drafts and future releases alone", async () => {
    await createDraft(tdb.db, sampleDraft);
    await createDraft(tdb.db, { ...sampleDraft, key: "FUTURE-1" });
    await scheduleRelease(tdb.db, "FUTURE-1", new Date("2026-10-03T18:00:00Z"));
    expect(await publishDue({ db: tdb.db, subscribers, now: () => NOW })).toEqual({ published: [] });
  });

  it("two concurrent publishDue calls publish each release once", async () => {
    for (let i = 0; i < 10; i++) {
      await createDraft(tdb.db, { ...sampleDraft, key: `K-${i}` });
      await scheduleRelease(tdb.db, `K-${i}`, new Date("2026-10-03T17:00:00Z"));
    }
    const [a, b] = await Promise.all([
      publishDue({ db: tdb.db, subscribers, now: () => NOW }),
      publishDue({ db: tdb.db, subscribers, now: () => NOW }),
    ]);
    expect([...a.published, ...b.published].sort()).toEqual(Array.from({ length: 10 }, (_, i) => `K-${i}`).sort());
    const { rows } = await tdb.pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE type = 'release.published'");
    expect(rows[0].n).toBe(10);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run apps/nrms`
Expected: FAIL — the modules don't exist.

- [ ] **Step 4: Implement**

```ts
// apps/nrms/src/releases.ts
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@gcpe/db-kit";
import { releaseRecordSchema } from "@gcpe/events";
import { releases, type ReleaseContent, type ReleaseRow } from "./db/schema";

export const releaseDraftSchema = releaseRecordSchema
  .omit({ publishDate: true, timestamp: true, atomId: true, renditions: true })
  .extend({ key: z.string().min(1).max(100).regex(/^[A-Za-z0-9-]+$/, "letters, digits and hyphens only") });
export type ReleaseDraft = z.infer<typeof releaseDraftSchema>;

export class ReleaseExistsError extends Error {}
export class ReleaseNotFoundError extends Error {}
export class ReleaseAlreadyPublishedError extends Error {}

const byKey = (key: string) => sql`lower(${releases.key}) = lower(${key})`;

export async function getRelease(db: Db, key: string): Promise<ReleaseRow | undefined> {
  const [row] = await db.select().from(releases).where(byKey(key));
  return row;
}

export async function createDraft(db: Db, draft: ReleaseDraft): Promise<void> {
  const { key, kind, ...content } = draft;
  try {
    await db.insert(releases).values({ key, kind, content: content satisfies ReleaseContent });
  } catch (e) {
    if ((e as { code?: string }).code === "23505" || (e as { cause?: { code?: string } }).cause?.code === "23505") throw new ReleaseExistsError(key);
    throw e;
  }
}

export async function scheduleRelease(db: Db, key: string, publishAt: Date): Promise<void> {
  const row = await getRelease(db, key);
  if (!row) throw new ReleaseNotFoundError(key);
  const updated = await db
    .update(releases)
    .set({ status: "scheduled", publishAt, updatedAt: new Date() })
    .where(sql`${byKey(key)} AND ${releases.status} <> 'published'`)
    .returning({ key: releases.key });
  if (updated.length === 0) throw new ReleaseAlreadyPublishedError(key);
}
```

Check how drizzle 0.45 surfaces pg error codes (directly on the error, or on `.cause`). The helper above handles both; keep whichever branch the test proves.

```ts
// apps/nrms/src/publisher.ts
import { sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { enqueueEvent, type ReleaseRecord, type SubscriberConfig } from "@gcpe/events";
import { releases, type ReleaseRow } from "./db/schema";

export interface PublishOptions { db: Db; subscribers: SubscriberConfig[]; now?: () => Date; limit?: number }

export function toReleaseRecord(row: ReleaseRow, publishedAt: Date): ReleaseRecord {
  const at = publishedAt.toISOString();
  return { ...row.content, key: row.key, kind: row.kind, publishDate: at, timestamp: at, atomId: null, renditions: null };
}

/**
 * Spec §5 step 4: one transaction per release — claim it with FOR UPDATE SKIP LOCKED (so
 * concurrent replicas never publish the same release), mark it published, and write
 * release.published to the outbox in that same transaction.
 */
export async function publishDue(opts: PublishOptions): Promise<{ published: string[] }> {
  const now = (opts.now ?? (() => new Date()))();
  const limit = opts.limit ?? 50;
  const published: string[] = [];
  while (published.length < limit) {
    const key = await opts.db.transaction(async (tx) => {
      const claimed = await tx.execute<{ key: string }>(sql`
        SELECT key FROM ${releases}
        WHERE status = 'scheduled' AND publish_at <= ${now.toISOString()}::timestamptz
        ORDER BY publish_at, key
        FOR UPDATE SKIP LOCKED LIMIT 1`);
      const k = claimed.rows[0]?.key;
      if (!k) return null;
      const [row] = await tx
        .update(releases)
        .set({ status: "published", publishedAt: now, updatedAt: now })
        .where(sql`${releases.key} = ${k}`)
        .returning();
      await enqueueEvent(tx, { type: "release.published", source: "nrms", aggregateId: row!.key, data: toReleaseRecord(row!, now) }, opts.subscribers);
      return row!.key;
    });
    if (!key) break;
    published.push(key);
  }
  return { published };
}

export function startPublisher(opts: PublishOptions & { intervalMs?: number }): () => Promise<void> {
  let running: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (running) return;
    running = publishDue(opts)
      .then((r) => r.published.length && console.log(`[nrms] published ${r.published.join(", ")}`))
      .catch((e) => console.error("[nrms] publish failed", e))
      .finally(() => { running = null; });
  }, opts.intervalMs ?? 60_000);
  timer.unref();
  return async () => { clearInterval(timer); await running; };
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run apps/nrms && npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/nrms package.json package-lock.json
git commit -m "feat(nrms): thin release store and SKIP LOCKED scheduled publisher"
```

---

### Task 5: NRMS (thin) — HTTP API, main, Dockerfile

**Files:**
- Create: `apps/nrms/src/http/routes.ts`, `apps/nrms/src/app.ts`, `apps/nrms/src/main.ts`, `apps/nrms/Dockerfile`
- Test: `apps/nrms/src/http/routes.test.ts`

**Interfaces:**
- Consumes: Task 4.
- Produces:
  - `createApp({ db, auth })`
  - `POST /api/releases` (role `NRMS.Editor`): body `ReleaseDraft` → 201 `{ key }`; 400 on validation; 409 if the key exists
  - `POST /api/releases/:key/schedule` (role `NRMS.Editor`): body `{ publishAt: <ISO with offset> }` → 200 `{ key, status: "scheduled", publishAt }`; 404; 409 if already published
  - `GET /api/releases/:key` (any valid token) → 200 `{ key, kind, status, publishAt, publishedAt, content }`; 404
  - env: `DATABASE_URL`, `PORT` (default 3002), auth env via `authFromEnv` (Task 3), `EVENT_SUBSCRIBERS`, `MIGRATIONS_FOLDER`, `PUBLISH_INTERVAL_MS` (default 60000)

- [ ] **Step 1: Write the failing test**

Mint tokens exactly as in `apps/core/src/http/routes.test.ts` (`generateKeyPair("RS256")`, `createLocalJWKSet`, `SignJWT` with `roles`, issuer `https://login.microsoftonline.com/t/v2.0`, audience `api://nrms`).

```ts
// apps/nrms/src/http/routes.test.ts — cases (write each as an `it`):
// 1. GET /health/live 200 without a token.
// 2. POST /api/releases without a token → 401; with a token lacking NRMS.Editor → 403.
// 3. POST /api/releases with sampleDraft → 201 { key }; the same again → 409 { error: "release exists" }.
// 4. POST /api/releases with { ...sampleDraft, key: "../x" } → 400 with { error: "invalid request", issues: [...] }.
// 5. POST /api/releases/:key/schedule { publishAt: "2026-10-03T10:00:00-07:00" } → 200 and status "scheduled";
//    with publishAt "2026-10-03T10:00:00" (no offset) → 400; unknown key → 404.
// 6. GET /api/releases/:key → 200 body.status "draft"; unknown → 404 { error: "not found" }.
// 7. A route error (stub getRelease to throw via vi.spyOn on the module namespace) → 500 { error: "internal error" } with no stack.
```

Write each case as concrete supertest code in the same style as Core's routes test.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/nrms/src/http`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// apps/nrms/src/http/routes.ts
import { Router, type NextFunction, type Request, type Response } from "express";
import { z, ZodError } from "zod";
import type { Db } from "@gcpe/db-kit";
import { requireRole } from "@gcpe/auth";
import * as releasesService from "../releases";

const scheduleSchema = z.object({ publishAt: z.string().datetime({ offset: true }) });
type Handler = (req: Request, res: Response) => Promise<void>;
const safe = (h: Handler) => (req: Request, res: Response, next: NextFunction) => h(req, res).catch(next);

function handleError(e: unknown, res: Response): boolean {
  if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues }), true;
  if (e instanceof releasesService.ReleaseExistsError) return void res.status(409).json({ error: "release exists" }), true;
  if (e instanceof releasesService.ReleaseAlreadyPublishedError) return void res.status(409).json({ error: "release already published" }), true;
  if (e instanceof releasesService.ReleaseNotFoundError) return void res.status(404).json({ error: "not found" }), true;
  return false;
}

export function apiRoutes(db: Db): Router {
  const r = Router();
  const run = (h: Handler): ReturnType<typeof safe> => safe(async (req, res) => {
    try { await h(req, res); } catch (e) { if (!handleError(e, res)) throw e; }
  });
  r.post("/releases", requireRole("NRMS.Editor"), run(async (req, res) => {
    const draft = releasesService.releaseDraftSchema.parse(req.body);
    await releasesService.createDraft(db, draft);
    res.status(201).json({ key: draft.key });
  }));
  r.post("/releases/:key/schedule", requireRole("NRMS.Editor"), run(async (req, res) => {
    const { publishAt } = scheduleSchema.parse(req.body);
    const at = new Date(publishAt);
    await releasesService.scheduleRelease(db, req.params.key!, at);
    res.json({ key: req.params.key, status: "scheduled", publishAt: at.toISOString() });
  }));
  r.get("/releases/:key", run(async (req, res) => {
    const row = await releasesService.getRelease(db, req.params.key!);
    if (!row) return void res.status(404).json({ error: "not found" });
    res.json({ key: row.key, kind: row.kind, status: row.status, publishAt: row.publishAt, publishedAt: row.publishedAt, content: row.content });
  }));
  return r;
}
```

`app.ts` is Core's `app.ts` with `apiRoutes(deps.db)` and `logPrefix: "[nrms]"`. Order: `healthRoutes`, then `/api` `requireBearer` → `express.json({ limit: MAX_EVENT_BYTES })` → routes, then `jsonErrorHandler`.

`main.ts` is Core's `main.ts` with:
- the env above;
- `startPublisher({ db, subscribers, intervalMs: env.PUBLISH_INTERVAL_MS })` alongside `startDispatcher`;
- closers in this order: http server, publisher, event dispatcher, db pool.

`Dockerfile`: copy `apps/core/Dockerfile`, replace `core` with `nrms` and 3001 with 3002, and delete the legacy-import comment (NRMS has no legacy-import dependency).

- [ ] **Step 4: Run tests and build**

Run: `npx vitest run apps/nrms && npm run check && npm --workspace @gcpe/nrms run build`
Expected: PASS; `apps/nrms/dist/main.js` built.

- [ ] **Step 5: Commit**

```bash
git add apps/nrms
git commit -m "feat(nrms): authenticated release API, scheduler wiring, Dockerfile"
```

---

### Task 6: Public site builder (thin)

**Files:**
- Create: `apps/public-site/{package.json,drizzle.config.ts,Dockerfile}`, `src/db/schema.ts` (events tables only), `src/storage.ts`, `src/render.ts`, `src/news-api-client.ts`, `src/rebuild.ts`, `src/app.ts`, `src/main.ts`, `test/helpers.ts`, `migrations/*` (generated)
- Test: `src/storage.test.ts`, `src/render.test.ts`, `src/rebuild.test.ts`

**Interfaces:**
- Consumes: `site.rebuild_requested` (source `news-api`); News API `GET /api/Posts/:key?api-version=1.0` (an empty 200 body means not found), `GET /api/Posts/Latest/home/default?api-version=1.0&count=10`.
- Produces:
  - `fsStorage(root: string): SiteStorage` where `SiteStorage = { write(relPath: string, html: string): Promise<void>; remove(relPath: string): Promise<void> }`
  - `renderPostPage(post: PostDto, site: SiteInfo): string`, `renderHomePage(posts: PostDto[], site: SiteInfo): string`, `escapeHtml(s: string): string`
  - `newsApiClient(baseUrl: string, fetchImpl?: typeof fetch): NewsApiClient` with `getPost(key): Promise<PostDto | null>`, `latestHome(count): Promise<PostDto[]>`
  - `createRebuildHandler({ newsApi, storage, site }): EventHandler`
  - `createApp({ db, eventSecrets, handler })`
  - Output layout: `index.html` for home and `releases/<key>/index.html` per post (legacy URL shape `/releases/<key>`).
  - env: `DATABASE_URL`, `PORT` (default 3003), `NEWS_API_URL`, `OUTPUT_DIR`, `SITE_NAME` (default from tenant config), `EVENT_SECRETS` (JSON, parsed like the News API's), `MIGRATIONS_FOLDER`, `TENANT_CONFIG`

`PostDto` is a local type with the fields the renderer reads: `key`, `kind`, `publishDate`, `summary`, `location`, `documents` (array of `{ languageId, headline, subheadline, detailsHtml, contacts: {title, details}[] }`), `ministryKeys`.

Ruling for this phase: `detailsHtml` is authored by trusted, authenticated NRMS staff and is rendered as HTML, as the legacy site does. Every other field is escaped. Sanitising `detailsHtml` (e.g. an allow-list sanitiser) is recorded as a Phase 3 item for the NRMS editor.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/public-site/src/storage.test.ts
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fsStorage } from "./storage";

describe("fsStorage", () => {
  it("writes atomically and removes", async () => {
    const root = await mkdtemp(join(tmpdir(), "site-"));
    const s = fsStorage(root);
    await s.write("releases/K1/index.html", "<p>a</p>");
    expect(await readFile(join(root, "releases/K1/index.html"), "utf8")).toBe("<p>a</p>");
    expect((await readdir(join(root, "releases/K1"))).filter((f) => f.includes(".tmp"))).toEqual([]);
    await s.remove("releases/K1/index.html");
    await s.remove("releases/K1/index.html"); // removing a missing file is fine
  });
  it("refuses paths that escape the root", async () => {
    const s = fsStorage(await mkdtemp(join(tmpdir(), "site-")));
    await expect(s.write("../escape.html", "x")).rejects.toThrow(/outside/);
    await expect(s.write("/etc/passwd", "x")).rejects.toThrow(/outside/);
    await expect(s.remove("releases/../../x")).rejects.toThrow(/outside/);
  });
});
```

```ts
// apps/public-site/src/render.test.ts
import { describe, expect, it } from "vitest";
import { escapeHtml, renderHomePage, renderPostPage, type PostDto } from "./render";

const post: PostDto = {
  key: "2026HLTH0001-000001", kind: "releases", publishDate: "2026-10-03T10:00:00-07:00", summary: "Summary <b>", location: "VICTORIA",
  ministryKeys: ["health"],
  documents: [
    { languageId: 3084, headline: "Titre", subheadline: null, detailsHtml: "<p>fr</p>", contacts: [] },
    { languageId: 4105, headline: "Clinics <script>alert(1)</script>", subheadline: null, detailsHtml: "<p>Clinics will open.</p>", contacts: [{ title: "Media", details: "Alex Example\n250-555-0100" }] },
  ],
};
const site = { name: "BC Gov News", baseUrl: "https://news.example" };

describe("render", () => {
  it("escapes the five HTML metacharacters", () => {
    expect(escapeHtml(`<a href="x">'&`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
  });
  it("renders the English document, escaped headline, trusted body, contacts", () => {
    const html = renderPostPage(post, site);
    expect(html).toContain("<title>Clinics &lt;script&gt;alert(1)&lt;/script&gt; | BC Gov News</title>");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("<p>Clinics will open.</p>");
    expect(html).toContain("Alex Example<br>250-555-0100");
    expect(html).toContain('<link rel="canonical" href="https://news.example/releases/2026HLTH0001-000001">');
    expect(html.startsWith("<!doctype html>")).toBe(true);
  });
  it("home lists posts linking to their pages", () => {
    const html = renderHomePage([post], site);
    expect(html).toContain('href="/releases/2026HLTH0001-000001"');
    expect(html).toContain("Clinics &lt;script&gt;");
  });
});
```

```ts
// apps/public-site/src/rebuild.test.ts — cases:
// Use an in-memory SiteStorage ({ files: Map, write, remove }) and a stub NewsApiClient.
// 1. pages ["home", "post:K1"] with getPost(K1) → post: writes "index.html" and "releases/K1/index.html".
// 2. post:K1 with getPost → null (unpublished): removes "releases/K1/index.html", writes nothing for it.
// 3. "post:../../x" and an unknown id "ministry:health": skipped (console.warn), no write, no throw.
// 4. getPost rejects (News API down): the handler rejects, so the receiver returns 500 and the dispatcher retries.
// Call the handler as handler(tx, envelope) with `tx` = `{} as Tx` — the handler must not touch the DB.
```

Write each as concrete code.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/public-site`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// apps/public-site/src/storage.ts
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export interface SiteStorage { write(relPath: string, html: string): Promise<void>; remove(relPath: string): Promise<void> }

export function fsStorage(root: string): SiteStorage {
  const base = resolve(root);
  const target = (relPath: string): string => {
    const full = resolve(base, relPath);
    const rel = relative(base, full);
    if (isAbsolute(relPath) || rel.startsWith("..") || isAbsolute(rel) || rel === "") throw new Error(`path outside output dir: ${relPath}`);
    return full;
  };
  return {
    async write(relPath, html) {
      const full = target(relPath);
      await mkdir(dirname(full), { recursive: true });
      const tmp = `${full}.${randomUUID()}.tmp`;
      await writeFile(tmp, html, "utf8");
      await rename(tmp, full); // atomic on one filesystem: readers never see a half-written page
    },
    async remove(relPath) {
      await rm(target(relPath), { force: true });
    },
  };
}
```

```ts
// apps/public-site/src/render.ts
export interface PostDocument { languageId: number; headline: string | null; subheadline: string | null; detailsHtml: string | null; contacts: { title: string | null; details: string | null }[] }
export interface PostDto { key: string; kind: string; publishDate: string; summary: string | null; location: string | null; ministryKeys: string[]; documents: PostDocument[] }
export interface SiteInfo { name: string; baseUrl: string }

const ENGLISH = 4105;
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const e = (s: string | null | undefined) => escapeHtml(s ?? "");
const english = (p: PostDto) => p.documents.find((d) => d.languageId === ENGLISH) ?? p.documents[0];

function page(title: string, site: SiteInfo, canonicalPath: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)} | ${e(site.name)}</title>
<link rel="canonical" href="${e(site.baseUrl + canonicalPath)}">
</head>
<body>
<header><a href="/">${e(site.name)}</a></header>
<main>
${body}
</main>
</body>
</html>
`;
}

export function renderPostPage(p: PostDto, site: SiteInfo): string {
  const d = english(p);
  const headline = d?.headline ?? p.key;
  const contacts = (d?.contacts ?? [])
    .map((c) => `<li><strong>${e(c.title)}</strong><br>${e(c.details).replace(/\n/g, "<br>")}</li>`)
    .join("\n");
  const body = `<article>
<h1>${e(headline)}</h1>
${d?.subheadline ? `<h2>${e(d.subheadline)}</h2>` : ""}
<p><time datetime="${e(p.publishDate)}">${e(p.publishDate)}</time>${p.location ? ` · ${e(p.location)}` : ""}</p>
${d?.detailsHtml ?? ""}
${contacts ? `<section><h2>Contacts</h2><ul>\n${contacts}\n</ul></section>` : ""}
</article>`;
  return page(headline, site, `/releases/${p.key}`, body);
}

export function renderHomePage(posts: PostDto[], site: SiteInfo): string {
  const items = posts
    .map((p) => `<li><a href="/releases/${encodeURIComponent(p.key)}">${e(english(p)?.headline ?? p.key)}</a> <time datetime="${e(p.publishDate)}">${e(p.publishDate)}</time></li>`)
    .join("\n");
  return page("Home", site, "/", `<h1>Latest news</h1>\n<ul>\n${items}\n</ul>`);
}
```

Note: `escapeHtml(c.details)` turns `\n` into nothing special, so the replace of `\n` with `<br>` after escaping is safe.

```ts
// apps/public-site/src/news-api-client.ts
import type { PostDto } from "./render";

export interface NewsApiClient { getPost(key: string): Promise<PostDto | null>; latestHome(count: number): Promise<PostDto[]> }

export function newsApiClient(baseUrl: string, fetchImpl: typeof fetch = fetch): NewsApiClient {
  const get = async (path: string): Promise<unknown> => {
    const res = await fetchImpl(new URL(path, baseUrl), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`News API ${res.status} for ${path}`);
    const text = await res.text();
    return text.trim() === "" ? null : JSON.parse(text); // the v1 API answers "not found" with an empty 200
  };
  return {
    getPost: async (key) => (await get(`/api/Posts/${encodeURIComponent(key)}?api-version=1.0`)) as PostDto | null,
    latestHome: async (count) => ((await get(`/api/Posts/Latest/home/default?api-version=1.0&count=${count}`)) as PostDto[] | null) ?? [],
  };
}
```

```ts
// apps/public-site/src/rebuild.ts
import type { EventHandler } from "@gcpe/events";
import type { NewsApiClient } from "./news-api-client";
import { renderHomePage, renderPostPage, type SiteInfo } from "./render";
import type { SiteStorage } from "./storage";

const KEY = /^[A-Za-z0-9-]+$/;
const HOME_COUNT = 10;

export function createRebuildHandler(deps: { newsApi: NewsApiClient; storage: SiteStorage; site: SiteInfo }): EventHandler {
  return async (_tx, event) => {
    const { pages } = event.data as { pages: string[] };
    for (const id of new Set(pages)) {
      if (id === "home") {
        await deps.storage.write("index.html", renderHomePage(await deps.newsApi.latestHome(HOME_COUNT), deps.site));
        continue;
      }
      const key = id.startsWith("post:") ? id.slice(5) : null;
      if (!key || !KEY.test(key)) {
        console.warn(`[public-site] skipping unknown page id ${JSON.stringify(id)}`);
        continue;
      }
      const post = await deps.newsApi.getPost(key);
      const path = `releases/${post?.key ?? key}/index.html`;
      if (post) await deps.storage.write(path, renderPostPage(post, deps.site));
      else await deps.storage.remove(path);
    }
  };
}
```

`app.ts`: `healthRoutes([db ping])`, `createEventReceiver({ db, secrets: deps.eventSecrets, handlers: (ev) => (ev.source === "news-api" && ev.type === "site.rebuild_requested" ? deps.handler : undefined) })`, a 404 JSON fallthrough, and `jsonErrorHandler({ logPrefix: "[public-site]" })`.

`main.ts`: same pattern as the other apps. Parse `EVENT_SECRETS` with the same zod transform as `apps/news-api/src/env.ts`, then build `fsStorage(env.OUTPUT_DIR)`, `newsApiClient(env.NEWS_API_URL)` and `site = { name: env.SITE_NAME, baseUrl: env.PUBLIC_SITE_URL }`. Add `PUBLIC_SITE_URL` to the env (required URL). Closers: http server, db pool.

`Dockerfile`: the Core template with `public-site`, port 3003, and `ENV OUTPUT_DIR=/app/output` plus `VOLUME /app/output`.

- [ ] **Step 4: Run tests and build**

Run: `npx vitest run apps/public-site && npm run check && npm --workspace @gcpe/public-site run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/public-site package.json package-lock.json
git commit -m "feat(public-site): thin static builder driven by site.rebuild_requested"
```

---

### Task 7: Distribution — schema, priorities, substitutions, `POST /api/messages`

**Files:**
- Create: `apps/distribution/{package.json,drizzle.config.ts}`, `src/db/schema.ts`, `src/priority.ts`, `src/substitute.ts`, `src/messages.ts`, `src/http/routes.ts`, `src/app.ts`, `test/helpers.ts`, `migrations/*`
- Test: `src/priority.test.ts`, `src/substitute.test.ts`, `src/http/routes.test.ts`

**Interfaces:**
- Produces:
  - `priorityFor(kind: "system" | "media" | "immediate" | "digest", email: string, internalDomains: string[]): number`
  - `substitute(template: string, values: Record<string, string>, mode: "html" | "text" | "header"): string`
  - `messageRequestSchema`, `createBatch(db, appId, req, internalDomains): Promise<{ batchId: string; created: boolean }>`, `batchStatus(db, id)`
  - `POST /api/messages` (role `Distribution.Send`) → 202 `{ batchId }` for a new batch, 200 `{ batchId }` when the `(appId, idempotencyKey)` pair already exists
  - `GET /api/batches/:id` → `{ id, total, pending, sent, failed }`
  - `appId` comes from the token: the `azp` claim (Entra v2 client id), falling back to `sub`.
  - The schema, routes and `createApp({ db, auth, internalDomains })` are consumed by Task 8.

Request schema:

```ts
export const messageRequestSchema = z.object({
  priority: z.enum(["system", "media", "immediate", "digest"]),
  idempotencyKey: z.string().min(1).max(200).optional(),
  subject: z.string().min(1).max(998),
  html: z.string().min(1),
  text: z.string().optional(),
  headers: z.record(z.string().regex(/^[A-Za-z0-9-]+$/), z.string()).default({}),
  recipients: z.array(z.object({ email: z.string().email(), substitutions: z.record(z.string()).default({}) })).min(1).max(20_000),
});
```

Ruling: the body limit is 5 MB and a batch holds at most 20,000 recipients. Larger sends are split by the caller. Spec §7.6 capacity is verified before Phase 4.

Schema (`src/db/schema.ts`):
- `batches`: `id uuid pk default random`, `app_id text not null`, `idempotency_key text`, `subject text`, `html text`, `text text`, `headers jsonb`, `created_at`. Unique on `(app_id, idempotency_key)`; Postgres allows multiple NULL idempotency keys.
- `messages`: `id uuid pk`, `batch_id uuid fk → batches on delete cascade`, `email text`, `substitutions jsonb`, `priority int`, `status text check in ('pending','sent','failed') default 'pending'`, `attempts int default 0`, `next_attempt_at timestamptz default now()`, `locked_until timestamptz`, `last_error text`, `sent_at timestamptz`, `original_recipient text`. Index `messages_due_idx` on `(priority desc, next_attempt_at)` where `status = 'pending'`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/distribution/src/priority.test.ts
import { describe, expect, it } from "vitest";
import { priorityFor } from "./priority";
describe("priorityFor", () => {
  it("uses the spec's base priorities", () => {
    expect([priorityFor("system", "a@x.com", []), priorityFor("media", "a@x.com", []), priorityFor("immediate", "a@x.com", []), priorityFor("digest", "a@x.com", [])]).toEqual([100, 40, 30, 20]);
  });
  it("adds 2 for internal domains, case-insensitively, exact domain only", () => {
    expect(priorityFor("immediate", "Alex.Example@GOV.BC.CA", ["gov.bc.ca"])).toBe(32);
    expect(priorityFor("immediate", "a@notgov.bc.ca", ["gov.bc.ca"])).toBe(30);
  });
});
```

```ts
// apps/distribution/src/substitute.test.ts
import { describe, expect, it } from "vitest";
import { substitute } from "./substitute";
describe("substitute", () => {
  it("replaces known placeholders and leaves unknown ones", () => {
    expect(substitute("Hi {{name}} {{other}}", { name: "Alex" }, "text")).toBe("Hi Alex {{other}}");
  });
  it("escapes values in html mode only", () => {
    expect(substitute("<a href=\"{{u}}\">", { u: "x\"><script>" }, "html")).toBe("<a href=\"x&quot;&gt;&lt;script&gt;\">");
    expect(substitute("{{u}}", { u: "<b>" }, "text")).toBe("<b>");
  });
  it("strips CR/LF from header values", () => {
    expect(substitute("<{{u}}>", { u: "https://x\r\nBcc: evil@x.com" }, "header")).toBe("<https://xBcc: evil@x.com>");
  });
  it("does not re-expand placeholders that appear inside values", () => {
    expect(substitute("{{a}}", { a: "{{b}}", b: "boom" }, "text")).toBe("{{b}}");
  });
});
```

```ts
// apps/distribution/src/http/routes.test.ts — cases (concrete supertest code, tokens minted like Core's test with azp claim "nod-client"):
// 1. 401 without a token; 403 without Distribution.Send.
// 2. A valid request with 2 recipients → 202 { batchId }; DB has 1 batch (app_id "nod-client") and 2 pending messages with
//    priority 30 and 32 (internalDomains ["gov.bc.ca"], one recipient @gov.bc.ca).
// 3. The same idempotencyKey again → 200 with the same batchId; still 1 batch and 2 messages.
// 4. The same idempotencyKey from a different azp → a new batch (keys are scoped per app).
// 5. A recipient with an invalid email → 400; zero recipients → 400; a header name containing ":" → 400.
// 6. GET /api/batches/:id → { id, total: 2, pending: 2, sent: 0, failed: 0 }; an unknown uuid → 404; a non-uuid → 404.
// 7. Two concurrent POSTs with the same idempotencyKey → both return the same batchId; exactly 1 batch row.
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/distribution`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// apps/distribution/src/priority.ts
const BASE = { system: 100, media: 40, immediate: 30, digest: 20 } as const;
export type PriorityKind = keyof typeof BASE;
export function priorityFor(kind: PriorityKind, email: string, internalDomains: string[]): number {
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  return BASE[kind] + (internalDomains.some((d) => d.toLowerCase() === domain) ? 2 : 0);
}
```

```ts
// apps/distribution/src/substitute.ts
const PLACEHOLDER = /\{\{([A-Za-z0-9_]+)\}\}/g;
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
export function substitute(template: string, values: Record<string, string>, mode: "html" | "text" | "header"): string {
  // One pass over the template: replacement text is never rescanned, so values can't inject placeholders.
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    if (!Object.hasOwn(values, name)) return whole;
    const v = values[name]!;
    return mode === "html" ? escapeHtml(v) : mode === "header" ? v.replace(/[\r\n]/g, "") : v;
  });
}
```

`messages.ts` `createBatch`: run it in a transaction. First take `pg_advisory_xact_lock(hashtext(appId || ':' || idempotencyKey))` when a key is present. Then look up an existing batch, which means returning `{ batchId, created: false }`. Otherwise insert the batch, then insert all messages in chunks of 1,000 rows, with `priority = priorityFor(req.priority, email, internalDomains)`. `batchStatus`: one `count(*) FILTER (WHERE status = …)` query, with `undefined` when the batch doesn't exist.

`routes.ts`: `requireRole("Distribution.Send")` on POST. Take `appId` from `req.auth.claims.azp ?? req.auth.subject`; read `packages/auth/src/bearer.ts` for the exact `AuthContext` field names. Reject a non-uuid `:id` with 404 before querying. Error mapping: ZodError → 400 `{ error: "invalid request", issues }`.

`app.ts`: `/api` → `requireBearer` → `express.json({ limit: "5mb" })` → routes; `jsonErrorHandler({ logPrefix: "[distribution]" })`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run apps/distribution && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/distribution package.json package-lock.json
git commit -m "feat(distribution): message batches with priorities, idempotency, substitutions"
```

---

### Task 8: Distribution — SMTP sender worker, mail redirect, main, Dockerfile

**Files:**
- Create: `apps/distribution/src/sender.ts`, `src/env.ts`, `src/main.ts`, `test/smtp-sink.ts`, `Dockerfile`
- Test: `src/sender.test.ts`, `src/env.test.ts`
- Dependencies: `npx -y npm@11 install nodemailer -w @gcpe/distribution`; `npx -y npm@11 install -D @types/nodemailer smtp-server @types/smtp-server mailparser @types/mailparser -w @gcpe/distribution`

**Interfaces:**
- Consumes: Task 7 schema and `substitute`.
- Produces:
  - `sendDue(opts: { db; transport: Transporter; from: string; redirectTo: string[]; now?: () => Date; batchSize?: number; lockMs?: number }): Promise<{ sent: number; retried: number; failed: number }>`
  - `startSender(opts & { intervalMs?: number }): () => Promise<void>` (default 2 000 ms)
  - `distributionEnvSchema`
  - `startSmtpSink(): Promise<{ port: number; messages: ParsedMail[]; close(): Promise<void> }>`
  - The sink is test-only; it is also used by the Task 11 E2E test.

Behaviour:
- Claim `status='pending' AND next_attempt_at <= now AND (locked_until IS NULL OR locked_until < now)`, ordered by `priority DESC, next_attempt_at, id`, with `FOR UPDATE SKIP LOCKED LIMIT batchSize`. Set `locked_until = now + lockMs`, and use that value as the ownership token in the terminal updates, exactly like `packages/events/src/dispatcher.ts`.
- Per message: render `subject` and each header value with `substitute(…, "header")`, `html` with `"html"`, and `text` with `"text"`.
- Redirect: when `redirectTo` is non-empty, `to = redirectTo`, add the header `X-Original-To: <original email>`, and store `original_recipient`.
- On success: `status='sent'`, `sent_at`.
- On failure: `attempts+1`; `next_attempt_at = now + min(2^attempts × 30s, 1h)`; `last_error` holds the message truncated to 500 characters. After 5 attempts the status becomes `failed`. An SMTP 5xx response (permanent; nodemailer exposes `responseCode`) fails immediately.
- env (`env.ts`): `DATABASE_URL`, `PORT` (3005), auth env via `authFromEnv` (Task 3; not part of this schema), `SMTP_HOST`, `SMTP_PORT` (default 587), `SMTP_SECURE` (default false; STARTTLS when the server offers it), `SMTP_USER`/`SMTP_PASS` (optional), `SMTP_TLS_REJECT_UNAUTHORIZED` (default true), `MAIL_FROM`, `MAIL_REDIRECT_TO` (comma list), `MAIL_ALLOW_REAL_RECIPIENTS` (default false), `INTERNAL_DOMAINS` (comma list), `SEND_INTERVAL_MS`, `MIGRATIONS_FOLDER`. `superRefine`: error unless `MAIL_REDIRECT_TO` is non-empty or `MAIL_ALLOW_REAL_RECIPIENTS === true`. Both set → the redirect wins.

- [ ] **Step 1: SMTP sink**

```ts
// apps/distribution/test/smtp-sink.ts
import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";
import { simpleParser, type ParsedMail } from "mailparser";

export async function startSmtpSink(): Promise<{ port: number; messages: ParsedMail[]; close(): Promise<void> }> {
  const messages: ParsedMail[] = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS"],
    onData(stream, _session, cb) {
      simpleParser(stream).then((m) => { messages.push(m); cb(); }, cb);
    },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.server.address() as AddressInfo).port;
  return { port, messages, close: () => new Promise<void>((r) => server.close(() => r())) };
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// apps/distribution/src/sender.test.ts — cases (concrete code; create batches with createBatch from Task 7;
// transport = nodemailer.createTransport({ host: "127.0.0.1", port: sink.port, secure: false, ignoreTLS: true })):
// 1. Two recipients → sendDue → sink has 2 mails; substitutions applied per recipient in html and in the
//    List-Unsubscribe header; DB statuses "sent".
// 2. redirectTo ["qa@example.com"] → the mail goes to qa@example.com only; header x-original-to = the real address;
//    original_recipient stored.
// 3. Higher priority sends first: create a digest batch, then a system batch, with batchSize 1 → the first mail is the system one.
// 4. Sink closed (connection refused) → attempts 1, status pending, next_attempt_at in the future, last_error set;
//    a second sendDue with the same `now` sends nothing (not due yet).
// 5. Concurrency: 20 messages, two concurrent sendDue calls → the sink receives exactly 20 mails (no duplicates).
// 6. A permanent 5xx: use a sink variant whose onRcptTo rejects with err.responseCode = 550 → status "failed" after one attempt.
```

```ts
// apps/distribution/src/env.test.ts
import { describe, expect, it } from "vitest";
import { distributionEnvSchema } from "./env";
const base = { DATABASE_URL: "postgres://x/y", SMTP_HOST: "localhost", MAIL_FROM: "news@example.com" };
describe("distribution env", () => {
  it("refuses to start with neither a redirect nor explicit real-recipient permission", () => {
    expect(distributionEnvSchema.safeParse(base).success).toBe(false);
  });
  it("accepts a redirect list or explicit permission", () => {
    expect(distributionEnvSchema.parse({ ...base, MAIL_REDIRECT_TO: "qa@example.com, dev@example.com" }).MAIL_REDIRECT_TO).toEqual(["qa@example.com", "dev@example.com"]);
    expect(distributionEnvSchema.parse({ ...base, MAIL_ALLOW_REAL_RECIPIENTS: "true" }).MAIL_ALLOW_REAL_RECIPIENTS).toBe(true);
  });
  it("treats MAIL_ALLOW_REAL_RECIPIENTS=false as false (not truthy string)", () => {
    expect(distributionEnvSchema.safeParse({ ...base, MAIL_ALLOW_REAL_RECIPIENTS: "false" }).success).toBe(false);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run apps/distribution`
Expected: FAIL.

- [ ] **Step 4: Implement**

Implement `sender.ts` as specified above, mirroring the claim/ownership SQL in `packages/events/src/dispatcher.ts`. In `env.ts`, parse booleans with `z.enum(["true","false"]).default("false").transform((v) => v === "true")`, never `z.coerce.boolean()` (which treats "false" as true). Parse comma lists with `z.string().default("").transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean))`.

`main.ts`:
1. Build the transport with `nodemailer.createTransport({ host, port, secure, auth: user ? { user, pass } : undefined, tls: { rejectUnauthorized: env.SMTP_TLS_REJECT_UNAUTHORIZED } })`.
2. Log `[distribution] mail redirect ON → …` or `[distribution] WARNING: delivering to real recipients` at startup.
3. Start `startSender`, plus `createApp`.
4. Closers: http server, sender, transport.close(), db pool.

`Dockerfile`: the Core template with `distribution`, port 3005, no legacy-import comment.

- [ ] **Step 5: Run tests and build**

Run: `npx vitest run apps/distribution && npm run check && npm --workspace @gcpe/distribution run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/distribution package.json package-lock.json
git commit -m "feat(distribution): SMTP sender with priorities, retries, non-prod redirect"
```

---

### Task 9: NoD (thin) — subscribers, As-It-Happens fan-out on `release.published`

**Files:**
- Create: `apps/nod/{package.json,drizzle.config.ts}`, `src/db/schema.ts`, `src/subscribers.ts`, `src/as-it-happens.ts`, `src/http/routes.ts`, `src/app.ts`, `test/helpers.ts`, `migrations/*`
- Test: `src/subscribers.test.ts`, `src/as-it-happens.test.ts`, `src/http/routes.test.ts`

**Interfaces:**
- Consumes: `release.published` (source `nrms`), `indexKeysFor` (Task 1).
- Produces:
  - `addSubscriber(db, { email, lists: string[] | "all" }): Promise<{ id: string }>` — throws `SubscriberExistsError` on a case-insensitive email clash
  - `createAsItHappensHandler(opts: { publicSiteUrl: string; manageUrl: string }): EventHandler`
  - `renderAsItHappens(r: ReleaseRecord, publicSiteUrl: string): { subject: string; html: string; text: string }`
  - `POST /api/subscribers` (role `NoD.Admin`) → 201 `{ id }`; 409; 400
  - The `send_jobs` table is consumed by Task 10.

Schema:
- `subscribers`: `id uuid pk`, `email text not null`, `manage_token text not null unique` (random 32-byte base64url, set in code), `verified_at timestamptz`, `created_at`. Unique index on `lower(email)`.
- `subscriptions`: `subscriber_id uuid fk cascade`, `list_key text not null` (`'*'` = all news, else an index key such as `ministries:health`), `as_it_happens boolean not null default true`; PK `(subscriber_id, list_key)`.
- `deliveries`: `release_key text`, `subscriber_id uuid fk cascade`, `created_at`; PK `(release_key, subscriber_id)`.
- `send_jobs`: `id uuid pk`, `release_key text not null`, `kind text not null default 'as_it_happens'`, `subject text`, `html text`, `text text`, `status text check in ('pending','sent','failed') default 'pending'`, `attempts int default 0`, `next_attempt_at timestamptz default now()`, `locked_until timestamptz`, `batch_id uuid`, `last_error text`, `created_at`. Unique on `(release_key, kind)`.

Ruling for this phase: subscribers are added already verified through the admin API, standing in for the double opt-in journey that arrives in Phase 4. Only verified subscribers receive mail.

Handler logic, all inside the receiver's transaction:
1. If `!r.publishFlags.toSubscribers`, return.
2. `keys = indexKeysFor(r)`.
3. Select distinct verified subscriber ids with an `as_it_happens` subscription where `list_key = '*'` or `list_key = ANY(keys)`.
4. Insert `deliveries` `ON CONFLICT DO NOTHING`.
5. Insert one `send_jobs` row `ON CONFLICT (release_key, kind) DO NOTHING`, with the rendered subject/html/text.

The email html contains `{{manageUrl}}` in the footer as an unsubscribe link. It is not a link to the manage page, because Distribution substitutes it per recipient.

`renderAsItHappens`:
- subject = English headline (or the key);
- html = `<h1>` escaped headline, escaped summary, a link `${publicSiteUrl}/releases/${encodeURIComponent(key)}`, and the footer `<p><a href="{{manageUrl}}">Manage or unsubscribe</a></p>`;
- text = the plain equivalent.
Release text is escaped, so a headline containing `{{manageUrl}}` cannot become a link. Distribution substitutes in a single pass, so a placeholder inside the headline is replaced too. To stop that, replace `{{` in release text with `{&#123;` in html and `{ {` in text before inserting. The test below pins this.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/nod/src/as-it-happens.test.ts — cases (concrete code):
// Setup: subscribers A (all news), B (ministries:health), C (sectors:mining), D (all news, unverified: set verified_at null).
// 1. release.published (sampleRelease with ministryKeys ["Health"], toSubscribers true) → deliveries for A and B only
//    (case-insensitive match via indexKeysFor); one send_job with subject = the English headline.
// 2. The same event applied again → no new deliveries, still one send_job.
// 3. toSubscribers false → no deliveries, no job.
// 4. No matching subscribers → no job (an empty job would send nothing).
// 5. renderAsItHappens escapes "<script>" in the headline and neutralises "{{manageUrl}}" inside the headline/summary,
//    while the footer keeps exactly one real {{manageUrl}}.
```

```ts
// apps/nod/src/subscribers.test.ts — cases: add with lists "all" → one subscription "*"; add with
// ["ministries:Health"] → stored lowercased; the same email in other casing → SubscriberExistsError;
// manage_token is ≥ 40 chars and unique across 2 subscribers; an invalid list key (not "<kind>:<key>"
// with kind in ministries|sectors|themes|tags) → ZodError via the routes.
```

```ts
// apps/nod/src/http/routes.test.ts — 401/403/201/409/400 as in the other apps; also POST /events
// with an nrms-signed release.published applies (inbox outcome "applied") and a core-signed
// release.published is ignored.
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/nod`
Expected: FAIL.

- [ ] **Step 3: Implement** the schema, `subscribers.ts`, `as-it-happens.ts`, `routes.ts` and `app.ts` per the interfaces above.
- `app.ts` mounts `createEventReceiver({ db, secrets, handlers: (ev) => ev.source === "nrms" && ev.type === "release.published" ? handler : undefined })` before `/api`.
- `/api` is `requireBearer` → `express.json({ limit: "100kb" })` → routes.
- Then `jsonErrorHandler({ logPrefix: "[nod]" })`.
- Generate migrations with drizzle-kit.

- [ ] **Step 4: Run tests**

Run: `npx vitest run apps/nod && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/nod package.json package-lock.json
git commit -m "feat(nod): subscribers and As-It-Happens fan-out on release.published"
```

---

### Task 10: NoD — send worker → Distribution, main, Dockerfile

**Files:**
- Create: `apps/nod/src/distribution-client.ts`, `src/send-jobs.ts`, `src/main.ts`, `Dockerfile`
- Test: `src/send-jobs.test.ts`

**Interfaces:**
- Consumes: Task 9 tables; Distribution `POST /api/messages` (Task 7).
- Produces:
  - `distributionClient({ baseUrl, getToken, fetchImpl? }): { send(req: MessageRequest): Promise<{ batchId: string }> }` — throws `DistributionError` with `.retryable`
  - `sendDueJobs(opts: { db; distribution; now?: () => Date; batchSize?: number; maxAgeMs?: number }): Promise<{ sent: number; retried: number; failed: number }>`
  - `startJobSender(opts & { intervalMs?: number })` (default 5 000 ms)
  - env: `DATABASE_URL`, `PORT` (3004), auth env via `authFromEnv` (Task 3), `EVENT_SECRETS`, `DISTRIBUTION_URL`, `DISTRIBUTION_TOKEN_URL`, `DISTRIBUTION_CLIENT_ID`, `DISTRIBUTION_CLIENT_SECRET`, `DISTRIBUTION_SCOPE`, `PUBLIC_SITE_URL`, `MANAGE_URL` (the subscription-management page base, e.g. `https://news.example/subscribe/manage`), `MIGRATIONS_FOLDER`

Behaviour:
- Claim jobs like Task 8, using `locked_until` as the ownership token.
- Recipients: `SELECT s.email, s.manage_token FROM deliveries d JOIN subscribers s … WHERE d.release_key = job.release_key AND s.verified_at IS NOT NULL`. Each recipient's substitutions are `{ manageUrl: `${MANAGE_URL}?token=${encodeURIComponent(token)}` }`.
- Request: `{ priority: "immediate", idempotencyKey: job.id, subject, html, text, headers: { "List-Unsubscribe": "<{{manageUrl}}>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }, recipients }`.
- 2xx → `status='sent'`, store `batch_id`.
- 5xx, network error or 429 → retry with the dispatcher's `backoffMs`; after `maxAgeMs` (24 h) → `failed`.
- Any other 4xx → `failed` immediately with `last_error`.
- A retry reuses `job.id` as the idempotency key, so a send that succeeded but whose response was lost cannot become a second batch.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/nod/src/send-jobs.test.ts — cases (concrete code, a stub distribution client recording calls):
// 1. One job with 2 deliveries → send called once with 2 recipients, per-recipient manageUrl containing the
//    URL-encoded token, the List-Unsubscribe headers, idempotencyKey = job id; job status "sent" with batch_id.
// 2. The client throws DistributionError(retryable) → job pending, attempts 1, next_attempt_at in the future;
//    after a success on the next due run the idempotencyKey is the same job id as the first attempt.
// 3. A non-retryable error → status "failed".
// 4. A job older than maxAgeMs that fails retryably → "failed".
// 5. Two concurrent sendDueJobs → send called exactly once per job.
// 6. distributionClient: a real HTTP round trip against an express stub — sends Authorization: Bearer <token>,
//    maps 503 → retryable, 400 → not retryable, 200/202 → { batchId }.
```

- [ ] **Step 2: Run them to verify they fail.** Run: `npx vitest run apps/nod/src/send-jobs.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement** `distribution-client.ts`, `send-jobs.ts` and `main.ts`.
- `main.ts`: the Distribution token comes from `createClientCredentialsProvider` when all four `DISTRIBUTION_TOKEN_URL/CLIENT_ID/CLIENT_SECRET/SCOPE` are set. Otherwise, when `authFromEnv(...).local` is non-null, a `localServiceToken` is minted: `mintLocalToken({ secret, subject: "nod", azp: "nod", roles: ["Distribution.Send"], ttlSeconds: 3600 })`, cached and re-minted when under 5 minutes remain. With neither, startup fails with a clear message. Put the selection in `src/distribution-token.ts` with a unit test for all three branches.
- `main.ts` starts the receiver app, `startJobSender`, and no dispatcher (NoD emits no events in Phase 2).
- Closers: http server, job sender, db pool.
- `Dockerfile`: the Core template with `nod`, port 3004.

- [ ] **Step 4: Run tests and build.** Run: `npx vitest run apps/nod && npm run check && npm --workspace @gcpe/nod run build` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/nod
git commit -m "feat(nod): As-It-Happens send worker calling Distribution idempotently"
```

---

### Task 11: The Phase 2 exit check — reduced E2E test

**Files:**
- Create: `tests/e2e/support.ts`, `tests/e2e/thin-slice.test.ts`
- Modify: `vitest.config.ts` (add `"tests/**/*.test.ts"` to `include`), `tsconfig.json` (add `"tests"` to `include`)

**Interfaces:**
- Consumes: every earlier task. Wires the apps exactly as each `main.ts` does, in-process, on real HTTP servers (`listen(0)`), with five separate test databases, a local JWKS for Entra tokens, and the SMTP sink.

Flow under test (spec §11 Phase 2 exit check):
1. Distribution app + sink (`MAIL_ALLOW_REAL_RECIPIENTS` equivalent: `redirectTo: []`); NoD app with a verified subscriber `alex.example@gov.bc.ca` on `ministries:health`; public-site app with `OUTPUT_DIR` = a temp dir; News API app (`createApp` from `apps/news-api/src/app.ts` with `subscribers` → public-site); NRMS app with `subscribers` → News API (`release.published`, `release.*`) and NoD (`release.published`).
2. `POST /api/releases` (token with `NRMS.Editor`) using `sampleDraft`, then `POST /api/releases/:key/schedule` with a `publishAt` one minute in the past.
3. `publishDue` once → `dispatchOnce` on the NRMS DB → expect `{ delivered: 2 }`.
4. `GET /api/Posts/<key>?api-version=1.0` on the News API returns the headline.
5. `dispatchOnce` on the News API DB → expect `{ delivered: 1 }` → `<OUTPUT_DIR>/releases/<key>/index.html` contains the escaped headline, and `<OUTPUT_DIR>/index.html` links to it.
6. `sendDueJobs` on the NoD DB (its distribution client talks real HTTP to the Distribution app with a minted `Distribution.Send` token whose `azp` is `nod`) → `sendDue` on the Distribution DB → `vi.waitFor` until the sink has 1 message:
   - `to` = `alex.example@gov.bc.ca`;
   - `subject` = the headline;
   - `list-unsubscribe` contains `?token=`;
   - `list-unsubscribe-post` = `List-Unsubscribe=One-Click`;
   - the html links to `/releases/<key>`.
7. Re-run every step's worker once more (publishDue, both dispatchOnce, sendDueJobs, sendDue) → still exactly 1 email; NoD inbox shows the event once.
8. All IDs are linked: the NoD `send_jobs.release_key` equals the key, and the correlationId on the News API's `site.rebuild_requested` outbox event equals the NRMS `release.published` correlationId.

Auth in the E2E: every app runs with the local admin enabled and one shared `LOCAL_AUTH_SECRET`, and no Entra config — the setup the owner will use first. The NRMS and NoD admin calls use a token from `POST /nrms/auth/local/token` (username `admin`, a password hashed in `beforeAll`). NoD reaches Distribution with its minted local service token (`azp: "nod"`). RS256/Entra tokens stay covered by the unit tests.

- [ ] **Step 1: Write `tests/e2e/support.ts`**: `localAuthEnv()` returns `{ secret, passwordHash, password }` for the shared local admin; `listen(app)` returns `{ server, url, close }`.
- [ ] **Step 2: Write `tests/e2e/thin-slice.test.ts`** implementing steps 1–8 as one `it`, with an `afterAll` that closes servers, the sink, and drops all five DBs.
- [ ] **Step 3: Run it.** `npx vitest run tests/e2e` — Expected: PASS. Then break one link to prove the test discriminates: comment out `requestRebuild` in News API projections → the test must fail at step 5. Restore it.
- [ ] **Step 4: Full suite.** `npm run check && npm test` — all PASS.
- [ ] **Step 5: Commit**

```bash
git add tests vitest.config.ts tsconfig.json
git commit -m "test(e2e): Phase 2 thin slice — NRMS publish to email and static page"
```

---

### Task 12: CI, README, compose

**Files:**
- Modify: `.github/workflows/ci.yml` — for each of `nrms`, `public-site`, `nod`, `distribution`, add a "Build <App> bundle" (`npm --workspace @gcpe/<app> run build`) and a "Build <App> image" (`docker build -f apps/<app>/Dockerfile -t gcpe-<app>:ci .`) step, after the existing ones.
- Modify: `README.md` — the apps table (ports 3001 core, 3002 nrms, 3003 public-site, 3004 nod, 3005 distribution, 8080 news-api; use the News API's actual default from `apps/news-api/src/env.ts`), each app's env vars, the event wiring (which `EVENT_SUBSCRIBERS`/`EVENT_SECRETS` connect which apps, with one worked JSON example for the slice), the local admin login (generate a hash with `npm run auth:hash-password`, set `LOCAL_ADMIN_ENABLED`/`LOCAL_ADMIN_PASSWORD_HASH`/`LOCAL_AUTH_SECRET`, then `curl -X POST …/auth/local/token`; test environments only), the mail redirect safety rule, and how to run the slice locally against Mailpit (`deploy/docker-compose.yml` → `SMTP_HOST=localhost SMTP_PORT=1025`, UI at http://localhost:8025).

- [ ] **Step 1:** Make the edits. Validate the YAML: `npx -y yaml-lint .github/workflows/ci.yml` or `node -e "require('yaml')"`-style parsing if available; otherwise review indentation by eye against the existing steps.
- [ ] **Step 2:** `npm run check && npm test` — PASS.
- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml README.md
git commit -m "ci+docs: build and document the Phase 2 apps"
```

---

### Task 13: SiteGround test deployment (gated by the probe)

**What we know (2026-10-03):**
- **Verified (SiteGround blog 2026-10-01, KB updated 2026-09-03):**
  - Node.js Projects run on GrowBig (5 projects), GoGeek (10) and Cloud (unlimited). StartUp has none.
  - Deployment is from GitHub (push to deploy) or a ZIP, with a configurable build command, Node version and env vars.
  - "You can create MySQL and PostgreSQL databases right from Site Tools."
- **Unknown, settled by `deploy/siteground-probe`:**
  - which Node versions are offered (we need 22.12+);
  - whether the process stays up while idle (our dispatcher, publisher and sender loops need that);
  - whether WebSocket upgrades pass the proxy (the KB "no WebSockets" article dates from 2024, about custom ports, before Node projects);
  - whether pgvector is installable (not needed until Phase 6; no current migration uses it);
  - whether we can create several databases;
  - LISTEN/NOTIFY.

**Gate:** run the probe on SiteGround and record its JSON in `docs/deploy/siteground.md` before starting this task. Each probe result selects a branch below.

**Files:**
- Create: `apps/stack/{package.json,src/main.ts,src/env.ts,src/mount.test.ts}`, `docs/deploy/siteground.md`
- Modify: `scripts/build-app.mjs` (none expected; `apps/stack` builds like any app)

**Interfaces:**
- `apps/stack` is a single Node process that serves every Phase 2 app on one `PORT`:
  - the News API at `/` (it owns `/api/*`, `/updates`, `/events`);
  - Core at `/core`, NRMS at `/nrms`, NoD at `/nod`, Distribution at `/distribution`, the site builder at `/site-builder`;
  - the generated static site at `/site` (`express.static(OUTPUT_DIR)`).
- It runs every app's background loops in-process: dispatchers, the NRMS publisher, the NoD job sender and the Distribution sender.
- Why one process: six apps exceed GrowBig's five projects, and one process means one deploy. The apps keep their own databases and talk only over HTTP and events, so this changes no app code.
- Event subscriber URLs point at the stack itself, e.g. `http://127.0.0.1:$PORT/nrms/events`.
- `createApp` functions are reused unchanged. Each app's `main.ts` wiring moves into an exported `start<App>(env)` function returning `{ app, closers }`, so both `main.ts` and the stack call it.
- env: one `DATABASE_URL_<APP>` per app; otherwise the union of the apps' env vars, with each app's name as a prefix where they clash (e.g. `NRMS_EVENT_SUBSCRIBERS`).

**Probe-dependent branches:**
- Node < 22.12 offered → stop; deployment there is blocked until SiteGround offers 22.12+, or use another host. Do not lower `engines`.
- Process paused or killed while idle → add `GET /stack/tick` (protected by `TICK_TOKEN`) that runs one iteration of every loop, and document an external 1-minute pinger (e.g. an uptime monitor). The loops stay as-is for hosts that keep the process alive.
- WebSocket upgrade blocked → `UPDATES_HUB_ENABLED=false` (the hub is already optional in `createApp`). The only consumer is gcpe-news-webapp's live cache refresh, which test use does not need. Document it.
- Cannot create multiple databases → use one database with a schema per app. Set `search_path` per pool (`?options=-c%20search_path%3D<app>`), and give drizzle's migrations table a per-app schema (`migrationsSchema: "<app>_drizzle"`) so the apps' migration records don't collide. Add a db-kit test proving two apps migrate into one database without interference.
- pgvector unavailable → nothing to do in Phase 2. Note it as a Phase 6 prerequisite: an external Postgres with pgvector, connected directly rather than through a transaction pooler, because LISTEN/NOTIFY and session advisory locks need session state.

- [ ] **Step 1:** Write `docs/deploy/siteground.md` from the probe results.
- [ ] **Step 2:** Failing test `apps/stack/src/mount.test.ts`: build the stack with five test databases and assert:
  - `GET /health/live`, `GET /nrms/health/live`, `GET /nod/health/live`, `GET /distribution/health/live` and `GET /api/Ministries?api-version=1.0` all answer;
  - `POST /nrms/events` with a bad signature → 401 (the receiver is mounted);
  - `/site/` serves a file written into `OUTPUT_DIR`.
- [ ] **Step 3:** Refactor each app's `main.ts` into `start<App>(env)` plus a thin `main.ts`; implement `apps/stack`. All existing tests stay green.
- [ ] **Step 4:** Implement the branches the probe selected, each with its own test.
- [ ] **Step 5:** Deploy runbook in `docs/deploy/siteground.md`:
  - create the project and databases;
  - set the env vars (full list);
  - set the build command `npm ci && npm --workspace @gcpe/stack run build` and the start command `node apps/stack/dist/main.js`;
  - run the smoke test, which re-runs the E2E flow by hand with curl and checks the mail in Mailpit or a test inbox, with `MAIL_REDIRECT_TO` set.
- [ ] **Step 6:** Commit.

```bash
git add apps/stack apps/*/src/main.ts apps/*/src/start.ts docs/deploy/siteground.md
git commit -m "feat(stack): single-process deployment for SiteGround-style hosts"
```
