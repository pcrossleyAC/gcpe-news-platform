# Phase 0 — Foundation & Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the monorepo, the shared packages every app depends on (config, db-kit, events, auth, legacy-import), and the Core app that owns reference data and publishes it as events.

**Architecture:** npm-workspaces monorepo; TypeScript source consumed directly by workspace packages (no per-package build). Each app owns one Postgres database with Drizzle migrations. Apps communicate only via REST and HMAC-signed webhook events delivered from a transactional outbox (spec §4). Core is the first app: reference data (organizations, sectors, themes, tags, services), REST API protected by Entra bearer tokens, legacy SQL Server importer.

**Tech Stack:** Node ≥20.11 (dev machine has 22), TypeScript 5.9, Express 5.2, Drizzle ORM 0.45 + drizzle-kit 0.31, zod 3.25, pg 8, jose 6, mssql 12, vitest 4.1, supertest 7, esbuild 0.28, tsx 4.

**Spec:** `docs/superpowers/specs/2026-10-02-gcpe-news-platform-design.md`

## Global Constraints

- Node ≥ 20.11; ESM everywhere (`"type": "module"`); TypeScript `strict: true`, `moduleResolution: "Bundler"`.
- Conventions from Media Hub 2.0: Express (v5, so rejected async handlers become 500s instead of hanging requests) + Drizzle + drizzle-zod + zod; vitest; OpenShift via GitHub Actions (spec §3.4).
- One Postgres database per app; no cross-database queries; every table has exactly one owning app (spec §3.1 Rules 1–3).
- Postgres ≥ 14 with pgvector available (dev machine: Homebrew Postgres 14.17 with `vector` 0.8.0; CI and deploy: `pgvector/pgvector:pg16`).
- Events: outbox written in the same transaction as the state change; HMAC-SHA256 over `timestamp + "." + body`; receivers reject timestamps older than 5 minutes; retry with exponential backoff for 24 h then dead-letter; receivers dedupe on event id and ignore lower sequences per aggregate (spec §4.1).
- Envelope fields exactly: `id, type, version, source, aggregateId, sequence, occurredAt, correlationId, data` (spec §4.2).
- Staff/service auth: Entra ID only (spec §3.4, §10.1). No secrets committed; `.env` is git-ignored.
- Legacy enum values are preserved exactly: ReleaseType Release=1, Story=2, Factsheet=3, Update=4, Advisory=5; LCID 4105 = English, 3084 = French (spec §9, §2).
- Commits: conventional-commit messages, **no `Co-Authored-By: Claude` lines**, never commit `CLAUDE.md`.
- Tests that need Postgres read `TEST_DATABASE_ADMIN_URL` (default `postgres://localhost:5432/postgres`) and create/drop a throwaway database per test file.

## Review Focus

1. **Event re-delivery after a receiver crash mid-handler** — the handler's writes and the inbox record must roll back together, so the retry re-applies; pinned in Task 6 (`handler throws → 500 and event is re-appliable`).
2. **Two dispatcher replicas running at once** — a delivery must be POSTed once, not twice; pinned in Task 5 (`concurrent dispatchOnce calls deliver each event once`).
3. **Importer re-run** — running the Core legacy import twice must not emit a second wave of events for unchanged rows; pinned in Task 12 (`second import emits no events`).
4. **Legacy rows with empty strings vs NULLs** (`N''` is common in legacy data) — values must be carried verbatim, not coerced; pinned in Task 12 mapper test using the real GCPE Media Relations seed row.
5. **Out-of-order delivery** (sequence 2 arrives before 1) — the older event must not overwrite newer state; pinned in Task 6 (`stale sequence is ignored`).

---

## File Structure

```
package.json                     # workspaces, root scripts, shared devDependencies
tsconfig.json                    # strict TS for all workspaces (noEmit; type-check only)
vitest.config.ts                 # single root vitest config
.nvmrc                           # 22
.github/workflows/ci.yml         # type-check + tests against pgvector/pgvector:pg16
deploy/docker-compose.yml        # Postgres+pgvector, Mailpit, MinIO for local dev
config/tenants/bc.json           # BC tenant config
config/tenants/nb.json           # example second tenant
scripts/build-app.mjs            # esbuild bundler for an app (workspace packages bundled, npm deps external)
packages/config/                 # tenant config + env parsing
packages/db-kit/                 # pg pool + drizzle, migrations, test database helper
packages/events/                 # envelope, catalogue, signing, outbox tables, publisher, dispatcher, receiver
packages/auth/                   # Entra bearer verification, role guard, client-credentials token provider
packages/legacy-import/          # SQL Server source abstraction + legacy enum maps
apps/core/                       # Core app: schema, services, HTTP API, legacy importer, Dockerfile
```

---

### Task 1: Monorepo scaffold and `@gcpe/config`

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.nvmrc`, `.env.example`
- Create: `.github/workflows/ci.yml`, `deploy/docker-compose.yml`
- Create: `config/tenants/bc.json`, `config/tenants/nb.json`
- Create: `packages/config/package.json`, `packages/config/src/index.ts`, `packages/config/src/tenant.ts`, `packages/config/src/env.ts`
- Test: `packages/config/src/tenant.test.ts`, `packages/config/src/env.test.ts`

**Interfaces:**
- Produces: `loadTenantConfig(path: string): TenantConfig`, `tenantConfigSchema`, `type TenantConfig`, `parseEnv<T extends z.ZodTypeAny>(schema: T, env?: NodeJS.ProcessEnv): z.infer<T>` from `@gcpe/config`.

- [ ] **Step 1: Create root workspace files**

`package.json`:
```json
{
  "name": "gcpe-news-platform",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20.11" },
  "workspaces": ["packages/*", "apps/*"],
  "scripts": {
    "check": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "@types/node": "^20.16.11",
    "esbuild": "^0.28.2",
    "tsx": "^4.20.0",
    "typescript": "~5.9.3",
    "vitest": "^4.1.10"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "allowImportingTsExtensions": false,
    "noEmit": true
  },
  "include": ["packages/*/src", "packages/*/test", "apps/*/src", "apps/*/test", "apps/*/scripts", "vitest.config.ts"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    env: { TZ: "UTC" },
  },
});
```

`.nvmrc`:
```
22
```

`.env.example`:
```
# Admin connection used by tests to create throwaway databases
TEST_DATABASE_ADMIN_URL=postgres://localhost:5432/postgres
```

- [ ] **Step 2: Create CI and local infrastructure files**

`.github/workflows/ci.yml`:
```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 5s --health-timeout 5s --health-retries 10
    env:
      TEST_DATABASE_ADMIN_URL: postgres://postgres:postgres@localhost:5432/postgres
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm run check
      - run: npm test
```

`deploy/docker-compose.yml`:
```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    ports: ["5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]
  mailpit:
    image: axllent/mailpit:latest
    ports: ["1025:1025", "8025:8025"]
  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minio
      MINIO_ROOT_PASSWORD: minio-password
    ports: ["9000:9000", "9001:9001"]
    volumes: ["miniodata:/data"]
volumes:
  pgdata: {}
  miniodata: {}
```

`config/tenants/bc.json`:
```json
{
  "tenantId": "bc",
  "siteName": "BC Gov News",
  "timeZone": "America/Vancouver",
  "defaultLanguageId": 4105,
  "organizationLabel": { "singular": "Ministry", "plural": "Ministries" },
  "publicSiteBaseUrl": "https://news.gov.bc.ca",
  "branding": { "primaryColor": "#003366", "logoUrl": null }
}
```

`config/tenants/nb.json`:
```json
{
  "tenantId": "nb",
  "siteName": "New Brunswick News",
  "timeZone": "America/Moncton",
  "defaultLanguageId": 4105,
  "organizationLabel": { "singular": "Department", "plural": "Departments" },
  "publicSiteBaseUrl": "https://news.gov.nb.ca",
  "branding": { "primaryColor": "#003366", "logoUrl": null }
}
```

- [ ] **Step 3: Create the `@gcpe/config` package manifest**

`packages/config/package.json`:
```json
{
  "name": "@gcpe/config",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "zod": "^3.25.76" }
}
```

Run: `npm install`
Expected: installs without errors; `node_modules/@gcpe/config` is a symlink to `packages/config`.

- [ ] **Step 4: Write the failing tests**

`packages/config/src/tenant.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTenantConfig } from "./tenant";

function writeTemp(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "tenant-"));
  const file = join(dir, "t.json");
  writeFileSync(file, JSON.stringify(content));
  return file;
}

const valid = {
  tenantId: "bc",
  siteName: "BC Gov News",
  timeZone: "America/Vancouver",
  defaultLanguageId: 4105,
  organizationLabel: { singular: "Ministry", plural: "Ministries" },
  publicSiteBaseUrl: "https://news.gov.bc.ca",
  branding: { primaryColor: "#003366", logoUrl: null },
};

describe("loadTenantConfig", () => {
  it("loads the committed BC tenant file", () => {
    const cfg = loadTenantConfig(new URL("../../../config/tenants/bc.json", import.meta.url).pathname);
    expect(cfg.tenantId).toBe("bc");
    expect(cfg.timeZone).toBe("America/Vancouver");
  });

  it("rejects an unknown IANA time zone", () => {
    expect(() => loadTenantConfig(writeTemp({ ...valid, timeZone: "Mars/Olympus" }))).toThrow(/timeZone/);
  });

  it("rejects a malformed brand colour", () => {
    expect(() =>
      loadTenantConfig(writeTemp({ ...valid, branding: { primaryColor: "blue", logoUrl: null } })),
    ).toThrow(/primaryColor/);
  });
});
```

`packages/config/src/env.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseEnv } from "./env";

describe("parseEnv", () => {
  const schema = z.object({ PORT: z.coerce.number().int().default(3000), DATABASE_URL: z.string().url() });

  it("parses and coerces values", () => {
    expect(parseEnv(schema, { DATABASE_URL: "postgres://x/y", PORT: "8080" })).toEqual({
      DATABASE_URL: "postgres://x/y",
      PORT: 8080,
    });
  });

  it("names every invalid variable in the error", () => {
    expect(() => parseEnv(schema, { PORT: "abc" })).toThrow(/PORT.*DATABASE_URL|DATABASE_URL.*PORT/);
  });
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `npx vitest run packages/config`
Expected: FAIL — `Failed to resolve import "./tenant"` / `"./env"`.

- [ ] **Step 6: Implement**

`packages/config/src/tenant.ts`:
```ts
import { readFileSync } from "node:fs";
import { z } from "zod";

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const tenantConfigSchema = z.object({
  tenantId: z.string().min(1),
  siteName: z.string().min(1),
  timeZone: z.string().refine(isValidTimeZone, { message: "timeZone must be a valid IANA time zone" }),
  defaultLanguageId: z.number().int(),
  organizationLabel: z.object({ singular: z.string().min(1), plural: z.string().min(1) }),
  publicSiteBaseUrl: z.string().url(),
  branding: z.object({
    primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "primaryColor must be #RRGGBB"),
    logoUrl: z.string().url().nullable(),
  }),
});

export type TenantConfig = z.infer<typeof tenantConfigSchema>;

export function loadTenantConfig(path: string): TenantConfig {
  const result = tenantConfigSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!result.success) {
    throw new Error(
      `Invalid tenant config ${path}: ` +
        result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  return result.data;
}
```

`packages/config/src/env.ts`:
```ts
import { z } from "zod";

export function parseEnv<T extends z.ZodTypeAny>(schema: T, env: NodeJS.ProcessEnv = process.env): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new Error(
      "Invalid environment: " + result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  return result.data;
}
```

`packages/config/src/index.ts`:
```ts
export { loadTenantConfig, tenantConfigSchema, type TenantConfig } from "./tenant";
export { parseEnv } from "./env";
```

- [ ] **Step 7: Run tests and type-check**

Run: `npx vitest run packages/config && npm run check`
Expected: 5 tests PASS; `tsc` exits 0.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .nvmrc .env.example .github deploy config packages/config
git commit -m "chore: monorepo scaffold, CI, local infra, and @gcpe/config"
```

---

### Task 2: `@gcpe/db-kit`

**Files:**
- Create: `packages/db-kit/package.json`, `packages/db-kit/src/index.ts`, `packages/db-kit/src/db.ts`, `packages/db-kit/src/test-db.ts`
- Create: `packages/db-kit/test/migrations/0000_init.sql`, `packages/db-kit/test/migrations/meta/_journal.json`
- Test: `packages/db-kit/src/test-db.test.ts`

**Interfaces:**
- Produces (from `@gcpe/db-kit`):
  - `type Db = NodePgDatabase<Record<string, never>>`
  - `type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]`
  - `type DbOrTx = Db | Tx`
  - `createDb(url: string, opts?: { max?: number }): { pool: pg.Pool; db: Db }`
  - `runMigrations(db: Db, migrationsFolder: string): Promise<void>`
  - `createTestDatabase(opts: { migrationsFolder: string; extensions?: string[] }): Promise<TestDatabase>` where `TestDatabase = { pool: pg.Pool; db: Db; url: string; drop(): Promise<void> }`

- [ ] **Step 1: Package manifest and migration fixture**

`packages/db-kit/package.json`:
```json
{
  "name": "@gcpe/db-kit",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "drizzle-orm": "^0.45.2", "pg": "^8.16.3" },
  "devDependencies": { "@types/pg": "^8.23.1" }
}
```

`packages/db-kit/test/migrations/0000_init.sql`:
```sql
CREATE TABLE "widgets" ("id" serial PRIMARY KEY NOT NULL, "name" text NOT NULL);
```

`packages/db-kit/test/migrations/meta/_journal.json`:
```json
{
  "version": "7",
  "dialect": "postgresql",
  "entries": [{ "idx": 0, "version": "7", "when": 1759449600000, "tag": "0000_init", "breakpoints": true }]
}
```

Run: `npm install`

- [ ] **Step 2: Write the failing test**

`packages/db-kit/src/test-db.test.ts`:
```ts
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createTestDatabase, type TestDatabase } from "./test-db";

const migrationsFolder = new URL("../test/migrations", import.meta.url).pathname;

describe("createTestDatabase", () => {
  let tdb: TestDatabase;
  afterAll(async () => {
    await tdb?.drop();
  });

  it("creates a fresh database, runs migrations and enables extensions", async () => {
    tdb = await createTestDatabase({ migrationsFolder, extensions: ["vector"] });
    await tdb.pool.query("INSERT INTO widgets (name) VALUES ('a')");
    const { rows } = await tdb.pool.query("SELECT count(*)::int AS n FROM widgets");
    expect(rows[0].n).toBe(1);
    const ext = await tdb.pool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
    expect(ext.rowCount).toBe(1);
  });

  it("drop() removes the database", async () => {
    const other = await createTestDatabase({ migrationsFolder });
    const name = new URL(other.url).pathname.slice(1);
    await other.drop();
    const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://localhost:5432/postgres" });
    await admin.connect();
    const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    await admin.end();
    expect(rowCount).toBe(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/db-kit`
Expected: FAIL — cannot resolve `./test-db`.

- [ ] **Step 4: Implement**

`packages/db-kit/src/db.ts`:
```ts
import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

export type Db = NodePgDatabase<Record<string, never>>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

export function createDb(url: string, opts: { max?: number } = {}): { pool: pg.Pool; db: Db } {
  const pool = new pg.Pool({ connectionString: url, max: opts.max ?? 10 });
  const db = drizzle(pool) as Db;
  return { pool, db };
}

export async function runMigrations(db: Db, migrationsFolder: string): Promise<void> {
  await migrate(db, { migrationsFolder });
}
```

`packages/db-kit/src/test-db.ts`:
```ts
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createDb, runMigrations, type Db } from "./db";

export interface TestDatabase {
  pool: pg.Pool;
  db: Db;
  url: string;
  drop(): Promise<void>;
}

function adminUrl(): string {
  return process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://localhost:5432/postgres";
}

async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function createTestDatabase(opts: { migrationsFolder: string; extensions?: string[] }): Promise<TestDatabase> {
  const name = `test_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  await withAdmin((c) => c.query(`CREATE DATABASE "${name}"`));
  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  const { pool, db } = createDb(url.toString(), { max: 5 });
  for (const ext of opts.extensions ?? []) {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS "${ext}"`);
  }
  await runMigrations(db, opts.migrationsFolder);
  return {
    pool,
    db,
    url: url.toString(),
    async drop() {
      await pool.end();
      await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    },
  };
}
```

`packages/db-kit/src/index.ts`:
```ts
export { createDb, runMigrations, type Db, type Tx, type DbOrTx } from "./db";
export { createTestDatabase, type TestDatabase } from "./test-db";
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run packages/db-kit && npm run check`
Expected: 2 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db-kit package-lock.json
git commit -m "feat(db-kit): drizzle/pg setup, migrations runner, throwaway test databases"
```

---

### Task 3: `@gcpe/events` — envelope, reference-data catalogue, signing

**Files:**
- Create: `packages/events/package.json`, `packages/events/src/index.ts`, `packages/events/src/envelope.ts`, `packages/events/src/catalogue.ts`, `packages/events/src/signing.ts`
- Test: `packages/events/src/catalogue.test.ts`, `packages/events/src/signing.test.ts`

**Interfaces:**
- Produces:
  - `eventEnvelopeSchema`, `type EventEnvelope<T = unknown>`
  - Record schemas/types: `socialSchema`, `linkSchema`, `contactSchema`, `orgRecordSchema` / `type OrgRecord`, `termKindSchema` / `type TermKind = "sector" | "theme" | "tag" | "service"`, `termRecordSchema` / `type TermRecord`
  - `eventDataSchemas` (object keyed by event type), `type EventType = keyof typeof eventDataSchemas`, `type EventData<T extends EventType>`
  - `parseEvent(raw: unknown): EventEnvelope` (validates envelope; validates `data` when the type is in the catalogue; passes unknown types through)
  - `termEventType(kind: TermKind, action: "upserted" | "deactivated"): EventType`
  - `signPayload(secret: string, timestamp: string, body: string): string`
  - `verifySignature(input: { secret: string; timestamp: string | undefined; body: string; signature: string | undefined; nowMs: number; toleranceMs?: number }): boolean`

- [ ] **Step 1: Package manifest**

`packages/events/package.json`:
```json
{
  "name": "@gcpe/events",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts", "./tables": "./src/tables.ts" },
  "dependencies": {
    "@gcpe/db-kit": "0.0.0",
    "drizzle-orm": "^0.45.2",
    "express": "^5.2.1",
    "zod": "^3.25.76"
  },
  "devDependencies": { "@types/express": "^5.0.6", "drizzle-kit": "^0.31.9", "supertest": "^7.1.0", "@types/supertest": "^7.2.1" }
}
```

Run: `npm install`

- [ ] **Step 2: Write the failing tests**

`packages/events/src/catalogue.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { parseEvent, termEventType, type OrgRecord } from "./index";

const org: OrgRecord = {
  key: "health",
  displayName: "Health",
  abbreviation: "HLTH",
  sortOrder: 10,
  isActive: true,
  parentKey: null,
  url: "http://gov.bc.ca/health",
  displayAdditionalName: null,
  minister: { name: "Honourable Ravi Kahlon", summary: "Honourable Ravi Kahlon", detailsHtml: "<p>x</p>", email: "HLTH.Minister@gov.bc.ca", photoUrl: null, address: "PO BOX 9050" },
  contact: { fullName: "Alex Example", phoneNumber: "250-555-0100", mobileNumber: "250-555-0100", emailAddress: "alex.example@gov.bc.ca" },
  secondContact: null,
  weekendContactNumber: "",
  social: { twitterUsername: "", flickrUrl: null, youtubeUrl: null, audioUrl: null },
  topicLinks: [{ text: "Get immunized", url: "https://www2.gov.bc.ca/x" }],
  serviceLinks: [],
  sectorKeys: ["health"],
  updatedAt: "2026-10-02T16:46:05.527-07:00",
};

function envelope(type: string, data: unknown) {
  return {
    id: "6f0d7f4e-8a51-4d39-9f42-2a4f4c1c0b11",
    type,
    version: 1,
    source: "core",
    aggregateId: "org:health",
    sequence: 1,
    occurredAt: "2026-10-02T17:00:00Z",
    correlationId: "0b8f3f86-2d1e-4b59-9e0c-5d6f1b1c2a33",
    data,
  };
}

describe("parseEvent", () => {
  it("accepts a valid org.upserted event", () => {
    expect(parseEvent(envelope("org.upserted", org)).data).toEqual(org);
  });

  it("rejects org.upserted with a missing minister block", () => {
    const { minister: _m, ...bad } = org;
    expect(() => parseEvent(envelope("org.upserted", bad))).toThrow();
  });

  it("rejects an envelope with a non-positive sequence", () => {
    expect(() => parseEvent({ ...envelope("org.upserted", org), sequence: 0 })).toThrow();
  });

  it("passes unknown event types through without validating data", () => {
    expect(parseEvent(envelope("future.thing", { anything: 1 })).type).toBe("future.thing");
  });

  it("maps term kinds to event types", () => {
    expect(termEventType("sector", "upserted")).toBe("sector.upserted");
    expect(termEventType("service", "deactivated")).toBe("service.deactivated");
  });
});
```

`packages/events/src/signing.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { signPayload, verifySignature } from "./signing";

const secret = "s3cret";
const ts = "2026-10-02T17:00:00.000Z";
const nowMs = Date.parse(ts);

describe("signing", () => {
  it("verifies its own signature", () => {
    const sig = signPayload(secret, ts, '{"a":1}');
    expect(verifySignature({ secret, timestamp: ts, body: '{"a":1}', signature: sig, nowMs })).toBe(true);
  });

  it("rejects a tampered body", () => {
    const sig = signPayload(secret, ts, '{"a":1}');
    expect(verifySignature({ secret, timestamp: ts, body: '{"a":2}', signature: sig, nowMs })).toBe(false);
  });

  it("rejects a timestamp older than five minutes", () => {
    const sig = signPayload(secret, ts, "{}");
    expect(verifySignature({ secret, timestamp: ts, body: "{}", signature: sig, nowMs: nowMs + 300_001 })).toBe(false);
  });

  it("rejects missing headers and non-hex signatures", () => {
    expect(verifySignature({ secret, timestamp: undefined, body: "{}", signature: "ab", nowMs })).toBe(false);
    expect(verifySignature({ secret, timestamp: ts, body: "{}", signature: "zz-not-hex", nowMs })).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run packages/events`
Expected: FAIL — unresolved imports.

- [ ] **Step 4: Implement**

`packages/events/src/envelope.ts`:
```ts
import { z } from "zod";

export const eventEnvelopeSchema = z.object({
  id: z.string().uuid(),
  type: z.string().min(1),
  version: z.number().int().positive(),
  source: z.string().min(1),
  aggregateId: z.string().min(1),
  sequence: z.number().int().positive(),
  occurredAt: z.string().datetime({ offset: true }),
  correlationId: z.string().uuid(),
  data: z.unknown(),
});

export type EventEnvelope<T = unknown> = Omit<z.infer<typeof eventEnvelopeSchema>, "data"> & { data: T };
```

`packages/events/src/catalogue.ts`:
```ts
import { z } from "zod";
import { eventEnvelopeSchema, type EventEnvelope } from "./envelope";

export const socialSchema = z.object({
  twitterUsername: z.string().nullable(),
  flickrUrl: z.string().nullable(),
  youtubeUrl: z.string().nullable(),
  audioUrl: z.string().nullable(),
});

export const linkSchema = z.object({ text: z.string(), url: z.string() });

export const contactSchema = z.object({
  fullName: z.string().nullable(),
  phoneNumber: z.string().nullable(),
  mobileNumber: z.string().nullable(),
  emailAddress: z.string().nullable(),
});

export const orgRecordSchema = z.object({
  key: z.string().min(1),
  displayName: z.string().min(1),
  abbreviation: z.string().nullable(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  parentKey: z.string().nullable(),
  url: z.string().nullable(),
  displayAdditionalName: z.string().nullable(),
  minister: z.object({
    name: z.string().nullable(),
    summary: z.string().nullable(),
    detailsHtml: z.string().nullable(),
    email: z.string().nullable(),
    photoUrl: z.string().nullable(),
    address: z.string().nullable(),
  }),
  contact: contactSchema.nullable(),
  secondContact: contactSchema.nullable(),
  weekendContactNumber: z.string().nullable(),
  social: socialSchema,
  topicLinks: z.array(linkSchema),
  serviceLinks: z.array(linkSchema),
  sectorKeys: z.array(z.string()),
  updatedAt: z.string().datetime({ offset: true }),
});
export type OrgRecord = z.infer<typeof orgRecordSchema>;

export const termKindSchema = z.enum(["sector", "theme", "tag", "service"]);
export type TermKind = z.infer<typeof termKindSchema>;

export const termRecordSchema = z.object({
  kind: termKindSchema,
  key: z.string().min(1),
  displayName: z.string().nullable(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  social: socialSchema,
  updatedAt: z.string().datetime({ offset: true }),
});
export type TermRecord = z.infer<typeof termRecordSchema>;

const termDeactivated = z.object({ kind: termKindSchema, key: z.string().min(1) });

export const eventDataSchemas = {
  "org.upserted": orgRecordSchema,
  "org.deactivated": z.object({ key: z.string().min(1) }),
  "sector.upserted": termRecordSchema,
  "sector.deactivated": termDeactivated,
  "theme.upserted": termRecordSchema,
  "theme.deactivated": termDeactivated,
  "tag.upserted": termRecordSchema,
  "tag.deactivated": termDeactivated,
  "service.upserted": termRecordSchema,
  "service.deactivated": termDeactivated,
} as const;

export type EventType = keyof typeof eventDataSchemas;
export type EventData<T extends EventType> = z.infer<(typeof eventDataSchemas)[T]>;

export function termEventType(kind: TermKind, action: "upserted" | "deactivated"): EventType {
  return `${kind}.${action}` as EventType;
}

export function parseEvent(raw: unknown): EventEnvelope {
  const envelope = eventEnvelopeSchema.parse(raw);
  const schema = (eventDataSchemas as Record<string, z.ZodTypeAny>)[envelope.type];
  if (!schema) return envelope as EventEnvelope;
  return { ...envelope, data: schema.parse(envelope.data) };
}
```

`packages/events/src/signing.ts`:
```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function signPayload(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function verifySignature(input: {
  secret: string;
  timestamp: string | undefined;
  body: string;
  signature: string | undefined;
  nowMs: number;
  toleranceMs?: number;
}): boolean {
  const { secret, timestamp, body, signature, nowMs, toleranceMs = 300_000 } = input;
  if (!timestamp || !signature || !/^[0-9a-f]+$/i.test(signature)) return false;
  const ts = Date.parse(timestamp);
  if (Number.isNaN(ts) || Math.abs(nowMs - ts) > toleranceMs) return false;
  const expected = Buffer.from(signPayload(secret, timestamp, body), "hex");
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

`packages/events/src/index.ts`:
```ts
export * from "./envelope";
export * from "./catalogue";
export * from "./signing";
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run packages/events && npm run check`
Expected: 9 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/events package-lock.json
git commit -m "feat(events): envelope, reference-data event catalogue, HMAC signing"
```

---

### Task 4: `@gcpe/events` — outbox tables and `enqueueEvent`

**Files:**
- Create: `packages/events/src/tables.ts`, `packages/events/src/subscribers.ts`, `packages/events/src/publisher.ts`, `packages/events/drizzle.config.ts`
- Create (generated): `packages/events/test/migrations/*`
- Modify: `packages/events/src/index.ts`
- Test: `packages/events/src/publisher.test.ts`

**Interfaces:**
- Consumes: `Db`, `DbOrTx`, `createTestDatabase` (Task 2); `parseEvent`, `EventEnvelope` (Task 3).
- Produces:
  - Tables `outboxEvents`, `outboxDeliveries`, `aggregateSequences`, `inboxEvents`, `inboxPositions` (exported from `@gcpe/events/tables`; every app re-exports them from its schema).
  - `interface SubscriberConfig { name: string; url: string; secret: string; types: string[] }` (`types` contains exact event types or `"*"`)
  - `parseSubscribers(json: string | undefined): SubscriberConfig[]`
  - `enqueueEvent(tx: DbOrTx, input: { type: string; source: string; aggregateId: string; data: unknown; correlationId?: string; version?: number }, subscribers: SubscriberConfig[]): Promise<EventEnvelope>`

- [ ] **Step 1: Write the tables**

`packages/events/src/tables.ts`:
```ts
import { index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const outboxEvents = pgTable("outbox_events", {
  id: uuid("id").primaryKey(),
  type: text("type").notNull(),
  aggregateId: text("aggregate_id").notNull(),
  sequence: integer("sequence").notNull(),
  envelope: jsonb("envelope").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const outboxDeliveries = pgTable(
  "outbox_deliveries",
  {
    eventId: uuid("event_id").notNull().references(() => outboxEvents.id, { onDelete: "cascade" }),
    subscriber: text("subscriber").notNull(),
    status: text("status").notNull().default("pending"), // pending | delivered | dead
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.subscriber] }), index("outbox_deliveries_due_idx").on(t.status, t.nextAttemptAt)],
);

export const aggregateSequences = pgTable("aggregate_sequences", {
  aggregateId: text("aggregate_id").primaryKey(),
  lastSequence: integer("last_sequence").notNull(),
});

export const inboxEvents = pgTable("inbox_events", {
  eventId: uuid("event_id").primaryKey(),
  source: text("source").notNull(),
  type: text("type").notNull(),
  outcome: text("outcome").notNull(), // applied | ignored | stale
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

export const inboxPositions = pgTable(
  "inbox_positions",
  {
    source: text("source").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    lastSequence: integer("last_sequence").notNull(),
  },
  (t) => [primaryKey({ columns: [t.source, t.aggregateId] })],
);
```

`packages/events/drizzle.config.ts`:
```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/tables.ts",
  out: "./test/migrations",
});
```

- [ ] **Step 2: Generate the test migrations**

Run: `cd packages/events && npx drizzle-kit generate --name events_tables && cd ../..`
Expected: creates `packages/events/test/migrations/0000_events_tables.sql` and `meta/_journal.json`, containing `CREATE TABLE "outbox_events"`, `"outbox_deliveries"`, `"aggregate_sequences"`, `"inbox_events"`, `"inbox_positions"`.

- [ ] **Step 3: Write the failing test**

`packages/events/src/publisher.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";
import { enqueueEvent } from "./publisher";
import { parseSubscribers } from "./subscribers";
import { outboxDeliveries, outboxEvents } from "./tables";

const migrationsFolder = new URL("../test/migrations", import.meta.url).pathname;
const subs = parseSubscribers(
  JSON.stringify([
    { name: "news-api", url: "http://news-api/events", secret: "a", types: ["org.upserted"] },
    { name: "audit", url: "http://audit/events", secret: "b", types: ["*"] },
  ]),
);

describe("enqueueEvent", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase({ migrationsFolder });
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("assigns increasing sequences per aggregate and fans out to matching subscribers", async () => {
    const first = await enqueueEvent(tdb.db, { type: "org.deactivated", source: "core", aggregateId: "org:a", data: { key: "a" } }, subs);
    const second = await enqueueEvent(tdb.db, { type: "org.deactivated", source: "core", aggregateId: "org:a", data: { key: "a" } }, subs);
    const other = await enqueueEvent(tdb.db, { type: "org.deactivated", source: "core", aggregateId: "org:b", data: { key: "b" } }, subs);
    expect([first.sequence, second.sequence, other.sequence]).toEqual([1, 2, 1]);

    const deliveries = await tdb.db.select().from(outboxDeliveries).where(eq(outboxDeliveries.eventId, first.id));
    expect(deliveries.map((d) => d.subscriber)).toEqual(["audit"]);
  });

  it("stores the full envelope", async () => {
    const env = await enqueueEvent(tdb.db, { type: "org.deactivated", source: "core", aggregateId: "org:c", data: { key: "c" } }, subs);
    const [row] = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.id, env.id));
    expect(row!.envelope).toEqual(env);
  });

  it("rejects data that does not match the catalogue and writes nothing", async () => {
    await expect(
      tdb.db.transaction((tx) => enqueueEvent(tx, { type: "org.deactivated", source: "core", aggregateId: "org:d", data: {} }, subs)),
    ).rejects.toThrow();
    const rows = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, "org:d"));
    expect(rows).toHaveLength(0);
  });
});

describe("parseSubscribers", () => {
  it("returns [] for undefined and rejects malformed config", () => {
    expect(parseSubscribers(undefined)).toEqual([]);
    expect(() => parseSubscribers('[{"name":"x"}]')).toThrow();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run packages/events/src/publisher.test.ts`
Expected: FAIL — cannot resolve `./publisher`.

- [ ] **Step 5: Implement**

`packages/events/src/subscribers.ts`:
```ts
import { z } from "zod";

const subscriberSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  secret: z.string().min(1),
  types: z.array(z.string().min(1)).min(1),
});

export type SubscriberConfig = z.infer<typeof subscriberSchema>;

export function parseSubscribers(json: string | undefined): SubscriberConfig[] {
  if (!json) return [];
  return z.array(subscriberSchema).parse(JSON.parse(json));
}

export function subscribersFor(type: string, subscribers: SubscriberConfig[]): SubscriberConfig[] {
  return subscribers.filter((s) => s.types.includes("*") || s.types.includes(type));
}
```

`packages/events/src/publisher.ts`:
```ts
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import { parseEvent } from "./catalogue";
import type { EventEnvelope } from "./envelope";
import { subscribersFor, type SubscriberConfig } from "./subscribers";
import { aggregateSequences, outboxDeliveries, outboxEvents } from "./tables";

export async function enqueueEvent(
  tx: DbOrTx,
  input: { type: string; source: string; aggregateId: string; data: unknown; correlationId?: string; version?: number },
  subscribers: SubscriberConfig[],
): Promise<EventEnvelope> {
  const [seq] = await tx
    .insert(aggregateSequences)
    .values({ aggregateId: input.aggregateId, lastSequence: 1 })
    .onConflictDoUpdate({
      target: aggregateSequences.aggregateId,
      set: { lastSequence: sql`${aggregateSequences.lastSequence} + 1` },
    })
    .returning({ lastSequence: aggregateSequences.lastSequence });

  const envelope = parseEvent({
    id: randomUUID(),
    type: input.type,
    version: input.version ?? 1,
    source: input.source,
    aggregateId: input.aggregateId,
    sequence: seq!.lastSequence,
    occurredAt: new Date().toISOString(),
    correlationId: input.correlationId ?? randomUUID(),
    data: input.data,
  });

  await tx.insert(outboxEvents).values({
    id: envelope.id,
    type: envelope.type,
    aggregateId: envelope.aggregateId,
    sequence: envelope.sequence,
    envelope,
  });
  const targets = subscribersFor(envelope.type, subscribers);
  if (targets.length > 0) {
    await tx.insert(outboxDeliveries).values(targets.map((s) => ({ eventId: envelope.id, subscriber: s.name })));
  }
  return envelope;
}
```

Note: the "rejects invalid data" test runs inside a transaction so the sequence increment is rolled back with the failed insert.

Update `packages/events/src/index.ts`:
```ts
export * from "./envelope";
export * from "./catalogue";
export * from "./signing";
export * from "./subscribers";
export * from "./publisher";
export * from "./tables";
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run packages/events && npm run check`
Expected: all events tests PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/events package-lock.json
git commit -m "feat(events): transactional outbox tables and enqueueEvent with per-aggregate sequences"
```

---

### Task 5: `@gcpe/events` — dispatcher

**Files:**
- Create: `packages/events/src/dispatcher.ts`
- Modify: `packages/events/src/index.ts` (add `export * from "./dispatcher";`)
- Test: `packages/events/src/dispatcher.test.ts`

**Interfaces:**
- Consumes: `enqueueEvent`, tables, `SubscriberConfig`, `signPayload`.
- Produces:
  - `backoffMs(attempts: number): number` — 10 s × 2^(attempts−1), capped at 1 h
  - `dispatchOnce(opts: DispatchOptions): Promise<{ delivered: number; retried: number; dead: number }>`
  - `startDispatcher(opts: DispatchOptions & { intervalMs?: number }): () => Promise<void>` (returns a stop function)
  - `interface DispatchOptions { db: Db; subscribers: SubscriberConfig[]; fetchImpl?: typeof fetch; now?: () => Date; batchSize?: number; maxAgeMs?: number; lockMs?: number; timeoutMs?: number }`
  - Outgoing request headers: `content-type: application/json`, `x-event-id`, `x-event-type`, `x-event-source`, `x-event-timestamp` (send time, ISO), `x-signature`.

- [ ] **Step 1: Write the failing test**

`packages/events/src/dispatcher.test.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";
import { backoffMs, dispatchOnce } from "./dispatcher";
import { enqueueEvent } from "./publisher";
import { verifySignature } from "./signing";
import type { SubscriberConfig } from "./subscribers";
import { outboxDeliveries } from "./tables";

const migrationsFolder = new URL("../test/migrations", import.meta.url).pathname;

describe("dispatchOnce", () => {
  let tdb: TestDatabase;
  let server: Server;
  let received: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
  let respondWith = 200;
  let subs: SubscriberConfig[];

  beforeAll(async () => {
    tdb = await createTestDatabase({ migrationsFolder });
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        res.statusCode = respondWith;
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    subs = [{ name: "target", url: `http://127.0.0.1:${port}/events`, secret: "k", types: ["*"] }];
  });
  afterAll(async () => {
    server.close();
    await tdb.drop();
  });
  beforeEach(async () => {
    received = [];
    respondWith = 200;
    await tdb.pool.query("DELETE FROM outbox_events");
  });

  it("delivers a signed event and marks it delivered", async () => {
    const env = await enqueueEvent(tdb.db, { type: "org.deactivated", source: "core", aggregateId: "org:x", data: { key: "x" } }, subs);
    expect(await dispatchOnce({ db: tdb.db, subscribers: subs })).toEqual({ delivered: 1, retried: 0, dead: 0 });
    expect(received).toHaveLength(1);
    const h = received[0]!.headers;
    expect(h["x-event-id"]).toBe(env.id);
    expect(
      verifySignature({ secret: "k", timestamp: h["x-event-timestamp"] as string, body: received[0]!.body, signature: h["x-signature"] as string, nowMs: Date.now() }),
    ).toBe(true);
    const [d] = await tdb.db.select().from(outboxDeliveries).where(eq(outboxDeliveries.eventId, env.id));
    expect(d!.status).toBe("delivered");
    expect(await dispatchOnce({ db: tdb.db, subscribers: subs })).toEqual({ delivered: 0, retried: 0, dead: 0 });
  });

  it("schedules a retry with backoff on failure", async () => {
    respondWith = 503;
    const env = await enqueueEvent(tdb.db, { type: "org.deactivated", source: "core", aggregateId: "org:y", data: { key: "y" } }, subs);
    const now = new Date();
    expect(await dispatchOnce({ db: tdb.db, subscribers: subs, now: () => now })).toEqual({ delivered: 0, retried: 1, dead: 0 });
    const [d] = await tdb.db.select().from(outboxDeliveries).where(eq(outboxDeliveries.eventId, env.id));
    expect(d!.status).toBe("pending");
    expect(d!.attempts).toBe(1);
    expect(d!.nextAttemptAt.getTime()).toBe(now.getTime() + backoffMs(1));
    expect(d!.lastError).toMatch(/503/);
  });

  it("dead-letters deliveries older than maxAge", async () => {
    respondWith = 500;
    await enqueueEvent(tdb.db, { type: "org.deactivated", source: "core", aggregateId: "org:z", data: { key: "z" } }, subs);
    const later = new Date(Date.now() + 25 * 3_600_000);
    expect(await dispatchOnce({ db: tdb.db, subscribers: subs, now: () => later })).toEqual({ delivered: 0, retried: 0, dead: 1 });
  });

  it("concurrent dispatchOnce calls deliver each event once", async () => {
    for (let i = 0; i < 10; i++) {
      await enqueueEvent(tdb.db, { type: "org.deactivated", source: "core", aggregateId: `org:c${i}`, data: { key: `c${i}` } }, subs);
    }
    const results = await Promise.all([
      dispatchOnce({ db: tdb.db, subscribers: subs }),
      dispatchOnce({ db: tdb.db, subscribers: subs }),
      dispatchOnce({ db: tdb.db, subscribers: subs }),
    ]);
    expect(results.reduce((n, r) => n + r.delivered, 0)).toBe(10);
    expect(new Set(received.map((r) => r.headers["x-event-id"])).size).toBe(10);
    expect(received).toHaveLength(10);
  });

  it("computes capped exponential backoff", () => {
    expect(backoffMs(1)).toBe(10_000);
    expect(backoffMs(2)).toBe(20_000);
    expect(backoffMs(20)).toBe(3_600_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/events/src/dispatcher.test.ts`
Expected: FAIL — cannot resolve `./dispatcher`.

- [ ] **Step 3: Implement**

`packages/events/src/dispatcher.ts`:
```ts
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import type { EventEnvelope } from "./envelope";
import { signPayload } from "./signing";
import type { SubscriberConfig } from "./subscribers";
import { outboxDeliveries } from "./tables";

export interface DispatchOptions {
  db: Db;
  subscribers: SubscriberConfig[];
  fetchImpl?: typeof fetch;
  now?: () => Date;
  batchSize?: number;
  maxAgeMs?: number;
  lockMs?: number;
  timeoutMs?: number;
}

export function backoffMs(attempts: number): number {
  return Math.min(10_000 * 2 ** (attempts - 1), 3_600_000);
}

interface ClaimedRow {
  event_id: string;
  subscriber: string;
  attempts: number;
  envelope: EventEnvelope;
  created_at: Date;
}

export async function dispatchOnce(opts: DispatchOptions): Promise<{ delivered: number; retried: number; dead: number }> {
  const now = (opts.now ?? (() => new Date()))();
  const lockUntil = new Date(now.getTime() + (opts.lockMs ?? 60_000));
  const maxAgeMs = opts.maxAgeMs ?? 24 * 3_600_000;
  const doFetch = opts.fetchImpl ?? fetch;

  // Phase 1: claim (short transaction, no network I/O while holding row locks).
  const claimed = await opts.db.execute<ClaimedRow>(sql`
    UPDATE outbox_deliveries d
       SET locked_until = ${lockUntil}
      FROM outbox_events e
     WHERE e.id = d.event_id
       AND (d.event_id, d.subscriber) IN (
             SELECT event_id, subscriber FROM outbox_deliveries
              WHERE status = 'pending'
                AND next_attempt_at <= ${now}
                AND (locked_until IS NULL OR locked_until < ${now})
              ORDER BY next_attempt_at
              LIMIT ${opts.batchSize ?? 50}
              FOR UPDATE SKIP LOCKED)
    RETURNING d.event_id, d.subscriber, d.attempts, e.envelope, e.created_at`);

  const result = { delivered: 0, retried: 0, dead: 0 };
  for (const row of claimed.rows) {
    const where = and(eq(outboxDeliveries.eventId, row.event_id), eq(outboxDeliveries.subscriber, row.subscriber));
    const sub = opts.subscribers.find((s) => s.name === row.subscriber);
    let error: string | null = null;
    if (!sub) {
      error = `subscriber ${row.subscriber} is not configured`;
    } else {
      const body = JSON.stringify(row.envelope);
      const timestamp = new Date().toISOString();
      try {
        const res = await doFetch(sub.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-event-id": row.envelope.id,
            "x-event-type": row.envelope.type,
            "x-event-source": row.envelope.source,
            "x-event-timestamp": timestamp,
            "x-signature": signPayload(sub.secret, timestamp, body),
          },
          body,
          signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        });
        if (!res.ok) error = `HTTP ${res.status}`;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }

    const attempts = row.attempts + 1;
    if (error === null) {
      await opts.db.update(outboxDeliveries).set({ status: "delivered", attempts, deliveredAt: now, lockedUntil: null, lastError: null }).where(where);
      result.delivered++;
    } else if (!sub || now.getTime() - new Date(row.created_at).getTime() >= maxAgeMs) {
      await opts.db.update(outboxDeliveries).set({ status: "dead", attempts, lockedUntil: null, lastError: error }).where(where);
      result.dead++;
    } else {
      await opts.db
        .update(outboxDeliveries)
        .set({ attempts, nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)), lockedUntil: null, lastError: error })
        .where(where);
      result.retried++;
    }
  }
  return result;
}

export function startDispatcher(opts: DispatchOptions & { intervalMs?: number }): () => Promise<void> {
  let running: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (running) return;
    running = dispatchOnce(opts)
      .catch((e) => console.error("[events] dispatch failed", e))
      .finally(() => {
        running = null;
      });
  }, opts.intervalMs ?? 1000);
  return async () => {
    clearInterval(timer);
    await running;
  };
}
```

Add to `packages/events/src/index.ts`: `export * from "./dispatcher";`

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/events && npm run check`
Expected: all PASS, including the concurrency test (exactly 10 POSTs).

- [ ] **Step 5: Commit**

```bash
git add packages/events
git commit -m "feat(events): outbox dispatcher with SKIP LOCKED claims, signed delivery, backoff and dead-lettering"
```

---

### Task 6: `@gcpe/events` — receiver and round-trip

**Files:**
- Create: `packages/events/src/receiver.ts`
- Modify: `packages/events/src/index.ts` (add `export * from "./receiver";`)
- Test: `packages/events/src/receiver.test.ts`, `packages/events/src/roundtrip.test.ts`

**Interfaces:**
- Consumes: `parseEvent`, `verifySignature`, `inboxEvents`, `inboxPositions`, `Db`, `Tx`.
- Produces:
  - `type EventHandler = (tx: Tx, event: EventEnvelope) => Promise<void>`
  - `createEventReceiver(opts: { db: Db; secrets: Record<string, string>; handlers: Record<string, EventHandler>; now?: () => number; onApplied?: (event: EventEnvelope) => void | Promise<void> }): express.Router` — mounts `POST /events`; responses: `401` bad/missing signature, `400` invalid event or source mismatch, `500` handler error (nothing recorded), `200 {"outcome": "applied" | "ignored" | "stale" | "duplicate"}`.

- [ ] **Step 1: Write the failing receiver test**

`packages/events/src/receiver.test.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";
import { createEventReceiver } from "./receiver";
import { signPayload } from "./signing";

const migrationsFolder = new URL("../test/migrations", import.meta.url).pathname;

function makeEvent(seq: number, aggregateId = "org:health", type = "org.deactivated") {
  return { id: randomUUID(), type, version: 1, source: "core", aggregateId, sequence: seq, occurredAt: new Date().toISOString(), correlationId: randomUUID(), data: { key: "health" } };
}

function post(app: express.Express, event: object, opts: { secret?: string; timestamp?: string } = {}) {
  const body = JSON.stringify(event);
  const ts = opts.timestamp ?? new Date().toISOString();
  return request(app)
    .post("/events")
    .set("content-type", "application/json")
    .set("x-event-source", "core")
    .set("x-event-timestamp", ts)
    .set("x-signature", signPayload(opts.secret ?? "k", ts, body))
    .send(body);
}

describe("createEventReceiver", () => {
  let tdb: TestDatabase;
  let app: express.Express;
  let applied: string[] = [];
  let failNext = false;

  beforeAll(async () => {
    tdb = await createTestDatabase({ migrationsFolder });
    await tdb.pool.query("CREATE TABLE side_effects (event_id uuid PRIMARY KEY)");
    app = express();
    app.use(
      createEventReceiver({
        db: tdb.db,
        secrets: { core: "k" },
        handlers: {
          "org.deactivated": async (tx, event) => {
            await tx.execute(sql`INSERT INTO side_effects (event_id) VALUES (${event.id})`);
            if (failNext) {
              failNext = false;
              throw new Error("boom");
            }
            applied.push(event.id);
          },
        },
      }),
    );
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(() => {
    applied = [];
  });

  it("applies a valid event once and reports duplicates", async () => {
    const e = makeEvent(1);
    expect((await post(app, e)).body).toEqual({ outcome: "applied" });
    expect((await post(app, e)).body).toEqual({ outcome: "duplicate" });
    expect(applied).toEqual([e.id]);
  });

  it("rejects bad signatures and stale timestamps with 401", async () => {
    expect((await post(app, makeEvent(2), { secret: "wrong" })).status).toBe(401);
    expect((await post(app, makeEvent(2), { timestamp: new Date(Date.now() - 600_000).toISOString() })).status).toBe(401);
  });

  it("rejects an invalid event with 400", async () => {
    expect((await post(app, { ...makeEvent(3), data: {} })).status).toBe(400);
  });

  it("stale sequence is ignored", async () => {
    const newer = makeEvent(10, "org:seq");
    const older = makeEvent(9, "org:seq");
    expect((await post(app, newer)).body.outcome).toBe("applied");
    expect((await post(app, older)).body.outcome).toBe("stale");
    expect(applied).toEqual([newer.id]);
  });

  it("handler throws → 500 and event is re-appliable", async () => {
    const e = makeEvent(1, "org:fail");
    failNext = true;
    expect((await post(app, e)).status).toBe(500);
    const side = await tdb.pool.query("SELECT 1 FROM side_effects WHERE event_id = $1", [e.id]);
    expect(side.rowCount).toBe(0);
    expect((await post(app, e)).body.outcome).toBe("applied");
  });

  it("records events with no handler as ignored", async () => {
    expect((await post(app, makeEvent(1, "x:1", "future.thing"))).body).toEqual({ outcome: "ignored" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/events/src/receiver.test.ts`
Expected: FAIL — cannot resolve `./receiver`.

- [ ] **Step 3: Implement**

`packages/events/src/receiver.ts`:
```ts
import express from "express";
import { and, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "@gcpe/db-kit";
import { parseEvent } from "./catalogue";
import type { EventEnvelope } from "./envelope";
import { verifySignature } from "./signing";
import { inboxEvents, inboxPositions } from "./tables";

export type EventHandler = (tx: Tx, event: EventEnvelope) => Promise<void>;

export interface ReceiverOptions {
  db: Db;
  secrets: Record<string, string>;
  handlers: Record<string, EventHandler>;
  now?: () => number;
  onApplied?: (event: EventEnvelope) => void | Promise<void>;
}

type Outcome = "applied" | "ignored" | "stale" | "duplicate";

export function createEventReceiver(opts: ReceiverOptions): express.Router {
  const router = express.Router();
  router.post("/events", express.text({ type: "application/json", limit: "25mb" }), async (req, res) => {
    const body = typeof req.body === "string" ? req.body : "";
    const source = req.header("x-event-source");
    const secret = source ? opts.secrets[source] : undefined;
    const valid =
      secret !== undefined &&
      verifySignature({
        secret,
        timestamp: req.header("x-event-timestamp"),
        body,
        signature: req.header("x-signature"),
        nowMs: (opts.now ?? Date.now)(),
      });
    if (!valid) return void res.status(401).json({ error: "invalid signature" });

    let event: EventEnvelope;
    try {
      event = parseEvent(JSON.parse(body));
    } catch {
      return void res.status(400).json({ error: "invalid event" });
    }
    if (event.source !== source) return void res.status(400).json({ error: "source mismatch" });

    try {
      const outcome = await opts.db.transaction(async (tx): Promise<Outcome> => {
        const inserted = await tx
          .insert(inboxEvents)
          .values({ eventId: event.id, source: event.source, type: event.type, outcome: "pending" })
          .onConflictDoNothing()
          .returning({ id: inboxEvents.eventId });
        if (inserted.length === 0) return "duplicate";

        const [pos] = await tx
          .select()
          .from(inboxPositions)
          .where(and(eq(inboxPositions.source, event.source), eq(inboxPositions.aggregateId, event.aggregateId)))
          .for("update");

        let outcome: Outcome;
        if (pos && event.sequence <= pos.lastSequence) {
          outcome = "stale";
        } else {
          const handler = opts.handlers[event.type];
          if (handler) await handler(tx, event);
          outcome = handler ? "applied" : "ignored";
          await tx
            .insert(inboxPositions)
            .values({ source: event.source, aggregateId: event.aggregateId, lastSequence: event.sequence })
            .onConflictDoUpdate({
              target: [inboxPositions.source, inboxPositions.aggregateId],
              set: { lastSequence: sql`greatest(${inboxPositions.lastSequence}, excluded.last_sequence)` },
            });
        }
        await tx.update(inboxEvents).set({ outcome }).where(eq(inboxEvents.eventId, event.id));
        return outcome;
      });
      if (outcome === "applied" && opts.onApplied) await opts.onApplied(event);
      res.status(200).json({ outcome });
    } catch (e) {
      console.error("[events] handler failed", event.type, event.id, e);
      res.status(500).json({ error: "handler failed" });
    }
  });
  return router;
}
```

Add to `packages/events/src/index.ts`: `export * from "./receiver";`

- [ ] **Step 4: Run receiver tests**

Run: `npx vitest run packages/events/src/receiver.test.ts`
Expected: 6 tests PASS.

- [ ] **Step 5: Write the round-trip test (Phase 0 exit check)**

`packages/events/src/roundtrip.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";
import { dispatchOnce } from "./dispatcher";
import { enqueueEvent } from "./publisher";
import { createEventReceiver } from "./receiver";
import type { SubscriberConfig } from "./subscribers";

const migrationsFolder = new URL("../test/migrations", import.meta.url).pathname;

describe("producer → consumer round trip", () => {
  let producer: TestDatabase;
  let consumer: TestDatabase;
  let server: Server | undefined;
  let subs: SubscriberConfig[];
  let port: number;

  function startConsumer(): Promise<void> {
    const app = express();
    app.use(
      createEventReceiver({
        db: consumer.db,
        secrets: { core: "shared" },
        handlers: {
          "org.deactivated": async (tx, e) => {
            await tx.execute(sql`INSERT INTO deactivated (key) VALUES (${(e.data as { key: string }).key}) ON CONFLICT DO NOTHING`);
          },
        },
      }),
    );
    return new Promise((r) => {
      server = app.listen(port, r);
    });
  }

  beforeAll(async () => {
    producer = await createTestDatabase({ migrationsFolder });
    consumer = await createTestDatabase({ migrationsFolder });
    await consumer.pool.query("CREATE TABLE deactivated (key text PRIMARY KEY)");
    const probe = await new Promise<Server>((r) => {
      const s = express().listen(0, () => r(s));
    });
    port = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));
    subs = [{ name: "consumer", url: `http://127.0.0.1:${port}/events`, secret: "shared", types: ["org.deactivated"] }];
  });
  afterAll(async () => {
    server?.close();
    await producer.drop();
    await consumer.drop();
  });

  it("retries while the consumer is down, then delivers exactly once", async () => {
    await enqueueEvent(producer.db, { type: "org.deactivated", source: "core", aggregateId: "org:health", data: { key: "health" } }, subs);

    const down = await dispatchOnce({ db: producer.db, subscribers: subs });
    expect(down.retried).toBe(1);

    await startConsumer();
    const later = new Date(Date.now() + 11_000);
    const up = await dispatchOnce({ db: producer.db, subscribers: subs, now: () => later });
    expect(up.delivered).toBe(1);

    const { rows } = await consumer.pool.query("SELECT key FROM deactivated");
    expect(rows).toEqual([{ key: "health" }]);
  });
});
```

- [ ] **Step 6: Run all events tests**

Run: `npx vitest run packages/events && npm run check`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/events
git commit -m "feat(events): signed webhook receiver with inbox dedupe and sequence ordering; round-trip test"
```

---

### Task 7: `@gcpe/auth`

**Files:**
- Create: `packages/auth/package.json`, `packages/auth/src/index.ts`, `packages/auth/src/bearer.ts`, `packages/auth/src/client-credentials.ts`
- Test: `packages/auth/src/bearer.test.ts`, `packages/auth/src/client-credentials.test.ts`

**Interfaces:**
- Produces:
  - `interface AuthContext { subject: string; roles: string[]; claims: Record<string, unknown> }`; Express `Request.auth?: AuthContext` augmentation
  - `entraJwks(tenantId: string): JWTVerifyGetKey`
  - `entraIssuer(tenantId: string): string` → `https://login.microsoftonline.com/${tenantId}/v2.0`
  - `requireBearer(opts: { issuer: string; audience: string; keys: JWTVerifyGetKey }): RequestHandler`
  - `requireRole(role: string): RequestHandler`
  - `createClientCredentialsProvider(opts: { tokenUrl: string; clientId: string; clientSecret: string; scope: string; fetchImpl?: typeof fetch; now?: () => number }): () => Promise<string>`

- [ ] **Step 1: Package manifest**

`packages/auth/package.json`:
```json
{
  "name": "@gcpe/auth",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "express": "^5.2.1", "jose": "^6.1.3" },
  "devDependencies": { "@types/express": "^5.0.6", "supertest": "^7.1.0", "@types/supertest": "^7.2.1" }
}
```

Run: `npm install`

- [ ] **Step 2: Write the failing tests**

`packages/auth/src/bearer.test.ts`:
```ts
import { beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from "jose";
import { requireBearer, requireRole } from "./bearer";

const issuer = "https://login.microsoftonline.com/tenant/v2.0";
const audience = "api://core";
let keys: JWTVerifyGetKey;
let privateKey: CryptoKey;

async function token(claims: Record<string, unknown>, opts: { aud?: string; exp?: string | number } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(issuer)
    .setAudience(opts.aud ?? audience)
    .setSubject("user-1")
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "5m")
    .sign(privateKey);
}

describe("requireBearer / requireRole", () => {
  let app: express.Express;
  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" };
    keys = createLocalJWKSet({ keys: [jwk] });
    app = express();
    app.get("/read", requireBearer({ issuer, audience, keys }), (req, res) => res.json(req.auth));
    app.get("/admin", requireBearer({ issuer, audience, keys }), requireRole("Core.Admin"), (_req, res) => res.json({ ok: true }));
  });

  it("401 without a token", async () => {
    expect((await request(app).get("/read")).status).toBe(401);
  });

  it("401 for wrong audience or expired token", async () => {
    expect((await request(app).get("/read").set("authorization", `Bearer ${await token({}, { aud: "api://other" })}`)).status).toBe(401);
    expect((await request(app).get("/read").set("authorization", `Bearer ${await token({}, { exp: Math.floor(Date.now() / 1000) - 60 })}`)).status).toBe(401);
  });

  it("exposes subject and roles", async () => {
    const res = await request(app).get("/read").set("authorization", `Bearer ${await token({ roles: ["Core.Admin"] })}`);
    expect(res.body).toMatchObject({ subject: "user-1", roles: ["Core.Admin"] });
  });

  it("403 when the role is missing", async () => {
    const res = await request(app).get("/admin").set("authorization", `Bearer ${await token({ roles: ["Core.Read"] })}`);
    expect(res.status).toBe(403);
  });
});
```

`packages/auth/src/client-credentials.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createClientCredentialsProvider } from "./client-credentials";

describe("createClientCredentialsProvider", () => {
  it("caches the token until 60s before expiry", async () => {
    let calls = 0;
    let now = 1_000_000;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls++;
      expect(String(init.body)).toContain("grant_type=client_credentials");
      return new Response(JSON.stringify({ access_token: `t${calls}`, expires_in: 3600 }), { status: 200 });
    }) as typeof fetch;
    const get = createClientCredentialsProvider({ tokenUrl: "https://x/token", clientId: "c", clientSecret: "s", scope: "api://nod/.default", fetchImpl, now: () => now });
    expect(await get()).toBe("t1");
    now += 3_500_000;
    expect(await get()).toBe("t1");
    now += 50_000;
    expect(await get()).toBe("t2");
  });

  it("throws on a failed token request", async () => {
    const fetchImpl = (async () => new Response("no", { status: 400 })) as typeof fetch;
    const get = createClientCredentialsProvider({ tokenUrl: "https://x/token", clientId: "c", clientSecret: "s", scope: "x", fetchImpl });
    await expect(get()).rejects.toThrow(/400/);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run packages/auth`
Expected: FAIL — unresolved imports.

- [ ] **Step 4: Implement**

`packages/auth/src/bearer.ts`:
```ts
import type { RequestHandler } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface AuthContext {
  subject: string;
  roles: string[];
  claims: Record<string, unknown>;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export function entraJwks(tenantId: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`));
}

export function entraIssuer(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}/v2.0`;
}

export function requireBearer(opts: { issuer: string; audience: string; keys: JWTVerifyGetKey }): RequestHandler {
  return async (req, res, next) => {
    const header = req.header("authorization");
    if (!header?.startsWith("Bearer ")) return void res.status(401).json({ error: "missing bearer token" });
    try {
      const { payload } = await jwtVerify(header.slice(7), opts.keys, { issuer: opts.issuer, audience: opts.audience });
      req.auth = {
        subject: String(payload.sub),
        roles: Array.isArray(payload.roles) ? payload.roles.map(String) : [],
        claims: payload as Record<string, unknown>,
      };
      next();
    } catch {
      res.status(401).json({ error: "invalid token" });
    }
  };
}

export function requireRole(role: string): RequestHandler {
  return (req, res, next) => (req.auth?.roles.includes(role) ? next() : void res.status(403).json({ error: "forbidden" }));
}
```

`packages/auth/src/client-credentials.ts`:
```ts
export function createClientCredentialsProvider(opts: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): () => Promise<string> {
  let cached: { token: string; expiresAt: number } | undefined;
  return async () => {
    const now = (opts.now ?? Date.now)();
    if (cached && cached.expiresAt - 60_000 > now) return cached.token;
    const res = await (opts.fetchImpl ?? fetch)(opts.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        scope: opts.scope,
      }),
    });
    if (!res.ok) throw new Error(`token request failed: HTTP ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: json.access_token, expiresAt: now + json.expires_in * 1000 };
    return cached.token;
  };
}
```

`packages/auth/src/index.ts`:
```ts
export { entraIssuer, entraJwks, requireBearer, requireRole, type AuthContext } from "./bearer";
export { createClientCredentialsProvider } from "./client-credentials";
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run packages/auth && npm run check`
Expected: 6 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/auth package-lock.json
git commit -m "feat(auth): Entra bearer verification, role guard, client-credentials token provider"
```

---

### Task 8: `@gcpe/legacy-import`

**Files:**
- Create: `packages/legacy-import/package.json`, `packages/legacy-import/src/index.ts`, `packages/legacy-import/src/source.ts`, `packages/legacy-import/src/enums.ts`
- Test: `packages/legacy-import/src/enums.test.ts`, `packages/legacy-import/src/source.test.ts`

**Interfaces:**
- Produces:
  - `interface LegacySource { query<T extends Record<string, unknown>>(sqlText: string): Promise<T[]>; close(): Promise<void> }`
  - `createMssqlSource(config: { server: string; database: string; user: string; password: string; port?: number; encrypt?: boolean; trustServerCertificate?: boolean }): Promise<LegacySource>`
  - `createFakeSource(tables: Record<string, Record<string, unknown>[]>): LegacySource` — returns the rows registered under the **first line** of the SQL text trimmed (queries in importers start with a `-- name:` comment line, e.g. `-- name: ministries`), for tests.
  - `RELEASE_TYPE_TO_KIND: Readonly<Record<number, "releases" | "stories" | "factsheets" | "updates" | "advisories">>`, `releaseKindFromLegacy(type: number): string` (throws on unknown)
  - `LANGUAGE_BY_LCID: Readonly<Record<number, "en" | "fr">>` (4105→en, 3084→fr)
  - `PUBLISH_OPTIONS = { NewsArchives: 1, NewsOnDemand: 2, MediaContacts: 4 } as const`, `hasPublishOption(value: number, flag: number): boolean`

- [ ] **Step 1: Package manifest**

`packages/legacy-import/package.json`:
```json
{
  "name": "@gcpe/legacy-import",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "mssql": "^12.0.0" },
  "devDependencies": { "@types/mssql": "^12.3.0" }
}
```

Run: `npm install`

- [ ] **Step 2: Write the failing tests**

`packages/legacy-import/src/enums.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { LANGUAGE_BY_LCID, PUBLISH_OPTIONS, hasPublishOption, releaseKindFromLegacy } from "./enums";

describe("legacy enums", () => {
  // Legacy: Gcpe.Hub.Data_Legacy/Entity/ReleaseType.cs:16-20 and HubEntitiesExtensions.ReleasePathName
  it("maps ReleaseType 1..5 to post kinds (guards against the nrms 0..4 off-by-one)", () => {
    expect([1, 2, 3, 4, 5].map(releaseKindFromLegacy)).toEqual(["releases", "stories", "factsheets", "updates", "advisories"]);
  });

  it("throws on unknown release types, including 0", () => {
    expect(() => releaseKindFromLegacy(0)).toThrow(/ReleaseType 0/);
    expect(() => releaseKindFromLegacy(6)).toThrow();
  });

  it("maps LCIDs", () => {
    expect(LANGUAGE_BY_LCID[4105]).toBe("en");
    expect(LANGUAGE_BY_LCID[3084]).toBe("fr");
  });

  // Legacy: Gcpe.Hub.Data_Legacy/Entity/PublishOptions.cs:17-19
  it("reads PublishOptions bit flags", () => {
    expect(hasPublishOption(3, PUBLISH_OPTIONS.NewsOnDemand)).toBe(true);
    expect(hasPublishOption(5, PUBLISH_OPTIONS.NewsOnDemand)).toBe(false);
    expect(hasPublishOption(5, PUBLISH_OPTIONS.MediaContacts)).toBe(true);
  });
});
```

`packages/legacy-import/src/source.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createFakeSource } from "./source";

describe("createFakeSource", () => {
  it("returns rows registered under the query's -- name: line", async () => {
    const src = createFakeSource({ ministries: [{ Key: "health" }] });
    expect(await src.query("-- name: ministries\nSELECT * FROM dbo.Ministry")).toEqual([{ Key: "health" }]);
  });

  it("throws for an unregistered query name", async () => {
    const src = createFakeSource({});
    await expect(src.query("-- name: nope\nSELECT 1")).rejects.toThrow(/nope/);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run packages/legacy-import`
Expected: FAIL — unresolved imports.

- [ ] **Step 4: Implement**

`packages/legacy-import/src/enums.ts`:
```ts
export const RELEASE_TYPE_TO_KIND = Object.freeze({
  1: "releases",
  2: "stories",
  3: "factsheets",
  4: "updates",
  5: "advisories",
} as const);

export function releaseKindFromLegacy(type: number): string {
  const kind = (RELEASE_TYPE_TO_KIND as Record<number, string>)[type];
  if (!kind) throw new Error(`Unknown legacy ReleaseType ${type}`);
  return kind;
}

export const LANGUAGE_BY_LCID = Object.freeze({ 4105: "en", 3084: "fr" } as const) as Readonly<Record<number, "en" | "fr">>;

export const PUBLISH_OPTIONS = { NewsArchives: 1, NewsOnDemand: 2, MediaContacts: 4 } as const;

export function hasPublishOption(value: number, flag: number): boolean {
  return (value & flag) === flag;
}
```

`packages/legacy-import/src/source.ts`:
```ts
import sql from "mssql";

export interface LegacySource {
  query<T extends Record<string, unknown>>(sqlText: string): Promise<T[]>;
  close(): Promise<void>;
}

export async function createMssqlSource(config: {
  server: string;
  database: string;
  user: string;
  password: string;
  port?: number;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
}): Promise<LegacySource> {
  const pool = await new sql.ConnectionPool({
    server: config.server,
    database: config.database,
    user: config.user,
    password: config.password,
    port: config.port ?? 1433,
    options: { encrypt: config.encrypt ?? true, trustServerCertificate: config.trustServerCertificate ?? false },
    requestTimeout: 120_000,
  }).connect();
  return {
    async query<T extends Record<string, unknown>>(sqlText: string): Promise<T[]> {
      const result = await pool.request().query<T>(sqlText);
      return result.recordset as unknown as T[];
    },
    async close() {
      await pool.close();
    },
  };
}

function queryName(sqlText: string): string {
  const first = sqlText.trimStart().split("\n")[0] ?? "";
  const match = /^--\s*name:\s*(\S+)/.exec(first);
  if (!match) throw new Error("Legacy queries must start with a '-- name: <name>' line");
  return match[1]!;
}

export function createFakeSource(tables: Record<string, Record<string, unknown>[]>): LegacySource {
  return {
    async query<T extends Record<string, unknown>>(sqlText: string): Promise<T[]> {
      const name = queryName(sqlText);
      const rows = tables[name];
      if (!rows) throw new Error(`Fake source has no rows for query '${name}'`);
      return rows as T[];
    },
    async close() {},
  };
}
```

`packages/legacy-import/src/index.ts`:
```ts
export * from "./enums";
export * from "./source";
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run packages/legacy-import && npm run check`
Expected: 6 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/legacy-import package-lock.json
git commit -m "feat(legacy-import): SQL Server source abstraction, fake source, legacy enum maps"
```

---

### Task 9: Core — schema and reference-data services

**Files:**
- Create: `apps/core/package.json`, `apps/core/drizzle.config.ts`, `apps/core/src/db/schema.ts`
- Create (generated): `apps/core/migrations/*`
- Create: `apps/core/src/services/organizations.ts`, `apps/core/src/services/terms.ts`, `apps/core/src/services/republish.ts`
- Test: `apps/core/src/services/organizations.test.ts`, `apps/core/src/services/terms.test.ts`, `apps/core/test/helpers.ts`

**Interfaces:**
- Consumes: `enqueueEvent`, `SubscriberConfig`, `OrgRecord`, `TermRecord`, `TermKind`, `termEventType`, `orgRecordSchema`, `termRecordSchema` (Tasks 3–4); `Db`, `createTestDatabase` (Task 2).
- Produces:
  - Tables `organizations`, `terms` (+ re-exported event tables)
  - `orgInputSchema = orgRecordSchema.omit({ updatedAt: true })`, `type OrgInput`
  - `termInputSchema = termRecordSchema.omit({ updatedAt: true })`, `type TermInput`
  - `upsertOrganization(db: Db, input: OrgInput, subscribers: SubscriberConfig[], opts?: { legacyId?: string }): Promise<{ record: OrgRecord; changed: boolean }>` — emits `org.upserted` only when changed
  - `deactivateOrganization(db: Db, key: string, subscribers: SubscriberConfig[]): Promise<boolean>` — emits `org.deactivated`
  - `listOrganizations(db: Db): Promise<OrgRecord[]>`, `getOrganization(db: Db, key: string): Promise<OrgRecord | null>`
  - `upsertTerm(db: Db, input: TermInput, subscribers: SubscriberConfig[], opts?: { legacyId?: string }): Promise<{ record: TermRecord; changed: boolean }>`
  - `deactivateTerm(db: Db, kind: TermKind, key: string, subscribers: SubscriberConfig[]): Promise<boolean>`
  - `listTerms(db: Db, kind: TermKind): Promise<TermRecord[]>`, `getTerm(db: Db, kind: TermKind, key: string): Promise<TermRecord | null>`
  - `republishAll(db: Db, subscribers: SubscriberConfig[]): Promise<number>` — enqueues `*.upserted` for every org and term (for bootstrapping new consumers); returns count
  - Aggregate ids: `org:<key>`, `<kind>:<key>`
  - Test helper `createCoreTestDb(): Promise<TestDatabase>` from `apps/core/test/helpers.ts`; fixture `healthOrg: OrgInput`

- [ ] **Step 1: Package manifest and Drizzle config**

`apps/core/package.json`:
```json
{
  "name": "@gcpe/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "db:generate": "drizzle-kit generate",
    "import:legacy": "tsx src/import/cli.ts",
    "build": "node ../../scripts/build-app.mjs apps/core"
  },
  "dependencies": {
    "@gcpe/auth": "0.0.0",
    "@gcpe/config": "0.0.0",
    "@gcpe/db-kit": "0.0.0",
    "@gcpe/events": "0.0.0",
    "@gcpe/legacy-import": "0.0.0",
    "drizzle-orm": "^0.45.2",
    "express": "^5.2.1",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@types/express": "^5.0.6",
    "@types/supertest": "^7.2.1",
    "drizzle-kit": "^0.31.9",
    "jose": "^6.1.3",
    "supertest": "^7.1.0"
  }
}
```

`apps/core/drizzle.config.ts`:
```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
```

Run: `npm install`

- [ ] **Step 2: Write the schema**

`apps/core/src/db/schema.ts`:
```ts
import { sql } from "drizzle-orm";
import { boolean, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import type { OrgRecord, TermRecord } from "@gcpe/events";

export * from "@gcpe/events/tables";

type Contact = NonNullable<OrgRecord["contact"]>;
type Link = OrgRecord["topicLinks"][number];

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  displayName: text("display_name").notNull(),
  abbreviation: text("abbreviation"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  parentKey: text("parent_key"),
  url: text("url"),
  displayAdditionalName: text("display_additional_name"),
  minister: jsonb("minister").$type<OrgRecord["minister"]>().notNull(),
  contact: jsonb("contact").$type<Contact | null>(),
  secondContact: jsonb("second_contact").$type<Contact | null>(),
  weekendContactNumber: text("weekend_contact_number"),
  social: jsonb("social").$type<OrgRecord["social"]>().notNull(),
  topicLinks: jsonb("topic_links").$type<Link[]>().notNull().default([]),
  serviceLinks: jsonb("service_links").$type<Link[]>().notNull().default([]),
  sectorKeys: text("sector_keys").array().notNull().default(sql`'{}'::text[]`),
  legacyId: uuid("legacy_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const terms = pgTable(
  "terms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").$type<TermRecord["kind"]>().notNull(),
    key: text("key").notNull(),
    displayName: text("display_name"),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    social: jsonb("social").$type<TermRecord["social"]>().notNull(),
    legacyId: uuid("legacy_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("terms_kind_key").on(t.kind, t.key)],
);
```

- [ ] **Step 3: Generate migrations**

Run: `npm --workspace @gcpe/core run db:generate -- --name init`
Expected: `apps/core/migrations/0000_init.sql` contains `CREATE TABLE "organizations"`, `"terms"`, and the five event tables.

- [ ] **Step 4: Write the test helper and failing tests**

`apps/core/test/helpers.ts`:
```ts
import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";
import type { OrgInput } from "../src/services/organizations";

export const coreMigrations = new URL("../migrations", import.meta.url).pathname;

export function createCoreTestDb(): Promise<TestDatabase> {
  return createTestDatabase({ migrationsFolder: coreMigrations });
}

export const healthOrg: OrgInput = {
  key: "health",
  displayName: "Health",
  abbreviation: "HLTH",
  sortOrder: 10,
  isActive: true,
  parentKey: null,
  url: "http://gov.bc.ca/health",
  displayAdditionalName: null,
  minister: { name: "Honourable Ravi Kahlon", summary: "Honourable Ravi Kahlon", detailsHtml: "<p>bio</p>", email: "HLTH.Minister@gov.bc.ca", photoUrl: null, address: "PO BOX 9050" },
  contact: { fullName: "Alex Example", phoneNumber: "250-555-0100", mobileNumber: "250-555-0100", emailAddress: "alex.example@gov.bc.ca" },
  secondContact: null,
  weekendContactNumber: "",
  social: { twitterUsername: "", flickrUrl: null, youtubeUrl: null, audioUrl: null },
  topicLinks: [{ text: "Get immunized", url: "https://www2.gov.bc.ca/immunize" }],
  serviceLinks: [],
  sectorKeys: ["health"],
};
```

`apps/core/src/services/organizations.test.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { outboxEvents, type SubscriberConfig } from "@gcpe/events";
import { createCoreTestDb, healthOrg } from "../../test/helpers";
import { deactivateOrganization, getOrganization, listOrganizations, upsertOrganization } from "./organizations";

const subs: SubscriberConfig[] = [{ name: "news-api", url: "http://x/events", secret: "s", types: ["*"] }];

describe("organizations service", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCoreTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE organizations, outbox_events, aggregate_sequences CASCADE");
  });

  it("inserts, returns the record, and emits org.upserted", async () => {
    const { record, changed } = await upsertOrganization(tdb.db, healthOrg, subs);
    expect(changed).toBe(true);
    expect(record).toMatchObject(healthOrg);
    const events = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, "org:health"));
    expect(events.map((e) => e.type)).toEqual(["org.upserted"]);
    expect((events[0]!.envelope as { data: unknown }).data).toEqual(record);
  });

  it("does not emit when nothing changed", async () => {
    await upsertOrganization(tdb.db, healthOrg, subs);
    const again = await upsertOrganization(tdb.db, healthOrg, subs);
    expect(again.changed).toBe(false);
    const events = await tdb.db.select().from(outboxEvents);
    expect(events).toHaveLength(1);
  });

  it("emits again when a field changes", async () => {
    await upsertOrganization(tdb.db, healthOrg, subs);
    await upsertOrganization(tdb.db, { ...healthOrg, displayName: "Health and Wellness" }, subs);
    expect(await tdb.db.select().from(outboxEvents)).toHaveLength(2);
    expect((await getOrganization(tdb.db, "health"))!.displayName).toBe("Health and Wellness");
  });

  it("deactivates and emits org.deactivated; unknown key returns false", async () => {
    await upsertOrganization(tdb.db, healthOrg, subs);
    expect(await deactivateOrganization(tdb.db, "health", subs)).toBe(true);
    expect((await getOrganization(tdb.db, "health"))!.isActive).toBe(false);
    expect(await deactivateOrganization(tdb.db, "nope", subs)).toBe(false);
    const types = (await tdb.db.select().from(outboxEvents)).map((e) => e.type);
    expect(types).toEqual(["org.upserted", "org.deactivated"]);
  });

  it("lists by sort order then key", async () => {
    await upsertOrganization(tdb.db, { ...healthOrg, key: "b", sortOrder: 1 }, subs);
    await upsertOrganization(tdb.db, { ...healthOrg, key: "a", sortOrder: 2 }, subs);
    await upsertOrganization(tdb.db, { ...healthOrg, key: "c", sortOrder: 1 }, subs);
    expect((await listOrganizations(tdb.db)).map((o) => o.key)).toEqual(["b", "c", "a"]);
  });
});
```

`apps/core/src/services/terms.test.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { outboxEvents, type SubscriberConfig } from "@gcpe/events";
import { createCoreTestDb, healthOrg } from "../../test/helpers";
import { upsertOrganization } from "./organizations";
import { republishAll } from "./republish";
import { deactivateTerm, getTerm, listTerms, upsertTerm, type TermInput } from "./terms";

const subs: SubscriberConfig[] = [{ name: "news-api", url: "http://x/events", secret: "s", types: ["*"] }];
const economy: TermInput = {
  kind: "sector",
  key: "economy",
  displayName: "Economy",
  sortOrder: 0,
  isActive: true,
  social: { twitterUsername: "@BCGovNews", flickrUrl: null, youtubeUrl: null, audioUrl: null },
};

describe("terms service", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCoreTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE organizations, terms, outbox_events, aggregate_sequences CASCADE");
  });

  it("upserts with change detection and kind-specific event types", async () => {
    expect((await upsertTerm(tdb.db, economy, subs)).changed).toBe(true);
    expect((await upsertTerm(tdb.db, economy, subs)).changed).toBe(false);
    await upsertTerm(tdb.db, { ...economy, kind: "theme", key: "economy" }, subs);
    const types = (await tdb.db.select().from(outboxEvents)).map((e) => `${e.type}|${e.aggregateId}`);
    expect(types.sort()).toEqual(["sector.upserted|sector:economy", "theme.upserted|theme:economy"]);
    expect((await listTerms(tdb.db, "sector")).map((t) => t.key)).toEqual(["economy"]);
  });

  it("deactivates a term", async () => {
    await upsertTerm(tdb.db, economy, subs);
    expect(await deactivateTerm(tdb.db, "sector", "economy", subs)).toBe(true);
    expect((await getTerm(tdb.db, "sector", "economy"))!.isActive).toBe(false);
  });

  it("republishAll emits one upserted event per org and term", async () => {
    await upsertOrganization(tdb.db, healthOrg, subs);
    await upsertTerm(tdb.db, economy, subs);
    await tdb.pool.query("DELETE FROM outbox_events");
    expect(await republishAll(tdb.db, subs)).toBe(2);
    const types = (await tdb.db.select().from(outboxEvents)).map((e) => e.type).sort();
    expect(types).toEqual(["org.upserted", "sector.upserted"]);
  });
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `npx vitest run apps/core`
Expected: FAIL — cannot resolve `./organizations` etc.

- [ ] **Step 6: Implement services**

`apps/core/src/services/organizations.ts`:
```ts
import { asc, eq } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { enqueueEvent, orgRecordSchema, type OrgRecord, type SubscriberConfig } from "@gcpe/events";
import { organizations } from "../db/schema";

export const orgInputSchema = orgRecordSchema.omit({ updatedAt: true });
export type OrgInput = Omit<OrgRecord, "updatedAt">;

type Row = typeof organizations.$inferSelect;

export function toOrgRecord(row: Row): OrgRecord {
  return {
    key: row.key,
    displayName: row.displayName,
    abbreviation: row.abbreviation,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    parentKey: row.parentKey,
    url: row.url,
    displayAdditionalName: row.displayAdditionalName,
    minister: row.minister,
    contact: row.contact ?? null,
    secondContact: row.secondContact ?? null,
    weekendContactNumber: row.weekendContactNumber,
    social: row.social,
    topicLinks: row.topicLinks,
    serviceLinks: row.serviceLinks,
    sectorKeys: row.sectorKeys,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function sameContent(a: OrgInput, b: OrgInput): boolean {
  return JSON.stringify(orgInputSchema.parse(a)) === JSON.stringify(orgInputSchema.parse(b));
}

export async function upsertOrganization(
  db: Db,
  input: OrgInput,
  subscribers: SubscriberConfig[],
  opts: { legacyId?: string } = {},
): Promise<{ record: OrgRecord; changed: boolean }> {
  const data = orgInputSchema.parse(input);
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(organizations).where(eq(organizations.key, data.key)).for("update");
    if (existing) {
      const { updatedAt: _u, ...current } = toOrgRecord(existing);
      if (sameContent(current, data)) return { record: toOrgRecord(existing), changed: false };
    }
    const values = { ...data, legacyId: opts.legacyId ?? existing?.legacyId ?? null, updatedAt: new Date() };
    const [row] = await tx
      .insert(organizations)
      .values(values)
      .onConflictDoUpdate({ target: organizations.key, set: values })
      .returning();
    const record = toOrgRecord(row!);
    await enqueueEvent(tx, { type: "org.upserted", source: "core", aggregateId: `org:${record.key}`, data: record }, subscribers);
    return { record, changed: true };
  });
}

export async function deactivateOrganization(db: Db, key: string, subscribers: SubscriberConfig[]): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(organizations)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(organizations.key, key))
      .returning({ key: organizations.key });
    if (rows.length === 0) return false;
    await enqueueEvent(tx, { type: "org.deactivated", source: "core", aggregateId: `org:${key}`, data: { key } }, subscribers);
    return true;
  });
}

export async function listOrganizations(db: Db): Promise<OrgRecord[]> {
  const rows = await db.select().from(organizations).orderBy(asc(organizations.sortOrder), asc(organizations.key));
  return rows.map(toOrgRecord);
}

export async function getOrganization(db: Db, key: string): Promise<OrgRecord | null> {
  const [row] = await db.select().from(organizations).where(eq(organizations.key, key));
  return row ? toOrgRecord(row) : null;
}
```

`apps/core/src/services/terms.ts`:
```ts
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { enqueueEvent, termEventType, termRecordSchema, type SubscriberConfig, type TermKind, type TermRecord } from "@gcpe/events";
import { terms } from "../db/schema";

export const termInputSchema = termRecordSchema.omit({ updatedAt: true });
export type TermInput = Omit<TermRecord, "updatedAt">;

type Row = typeof terms.$inferSelect;

export function toTermRecord(row: Row): TermRecord {
  return {
    kind: row.kind,
    key: row.key,
    displayName: row.displayName,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    social: row.social,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function upsertTerm(
  db: Db,
  input: TermInput,
  subscribers: SubscriberConfig[],
  opts: { legacyId?: string } = {},
): Promise<{ record: TermRecord; changed: boolean }> {
  const data = termInputSchema.parse(input);
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(terms)
      .where(and(eq(terms.kind, data.kind), eq(terms.key, data.key)))
      .for("update");
    if (existing) {
      const { updatedAt: _u, ...current } = toTermRecord(existing);
      if (JSON.stringify(termInputSchema.parse(current)) === JSON.stringify(data)) {
        return { record: toTermRecord(existing), changed: false };
      }
    }
    const values = { ...data, legacyId: opts.legacyId ?? existing?.legacyId ?? null, updatedAt: new Date() };
    const [row] = await tx
      .insert(terms)
      .values(values)
      .onConflictDoUpdate({ target: [terms.kind, terms.key], set: values })
      .returning();
    const record = toTermRecord(row!);
    await enqueueEvent(
      tx,
      { type: termEventType(record.kind, "upserted"), source: "core", aggregateId: `${record.kind}:${record.key}`, data: record },
      subscribers,
    );
    return { record, changed: true };
  });
}

export async function deactivateTerm(db: Db, kind: TermKind, key: string, subscribers: SubscriberConfig[]): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(terms)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(terms.kind, kind), eq(terms.key, key)))
      .returning({ key: terms.key });
    if (rows.length === 0) return false;
    await enqueueEvent(tx, { type: termEventType(kind, "deactivated"), source: "core", aggregateId: `${kind}:${key}`, data: { kind, key } }, subscribers);
    return true;
  });
}

export async function listTerms(db: Db, kind: TermKind): Promise<TermRecord[]> {
  const rows = await db.select().from(terms).where(eq(terms.kind, kind)).orderBy(asc(terms.sortOrder), asc(terms.key));
  return rows.map(toTermRecord);
}

export async function getTerm(db: Db, kind: TermKind, key: string): Promise<TermRecord | null> {
  const [row] = await db.select().from(terms).where(and(eq(terms.kind, kind), eq(terms.key, key)));
  return row ? toTermRecord(row) : null;
}
```

`apps/core/src/services/republish.ts`:
```ts
import type { Db } from "@gcpe/db-kit";
import { enqueueEvent, termEventType, type SubscriberConfig } from "@gcpe/events";
import { organizations, terms } from "../db/schema";
import { toOrgRecord } from "./organizations";
import { toTermRecord } from "./terms";

export async function republishAll(db: Db, subscribers: SubscriberConfig[]): Promise<number> {
  return db.transaction(async (tx) => {
    let count = 0;
    for (const row of await tx.select().from(organizations)) {
      const record = toOrgRecord(row);
      await enqueueEvent(tx, { type: "org.upserted", source: "core", aggregateId: `org:${record.key}`, data: record }, subscribers);
      count++;
    }
    for (const row of await tx.select().from(terms)) {
      const record = toTermRecord(row);
      await enqueueEvent(
        tx,
        { type: termEventType(record.kind, "upserted"), source: "core", aggregateId: `${record.kind}:${record.key}`, data: record },
        subscribers,
      );
      count++;
    }
    return count;
  });
}
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run apps/core && npm run check`
Expected: 8 tests PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/core package-lock.json
git commit -m "feat(core): reference-data schema and services with change-detected events"
```

---

### Task 10: Core — HTTP API, app wiring, build and container

**Files:**
- Create: `apps/core/src/http/routes.ts`, `apps/core/src/app.ts`, `apps/core/src/main.ts`, `apps/core/Dockerfile`, `scripts/build-app.mjs`
- Test: `apps/core/src/http/routes.test.ts`

**Interfaces:**
- Consumes: services from Task 9; `requireBearer`, `requireRole` (Task 7); `startDispatcher`, `parseSubscribers` (Tasks 4–5); `parseEnv` (Task 1).
- Produces:
  - `createApp(deps: { db: Db; subscribers: SubscriberConfig[]; auth: { issuer: string; audience: string; keys: JWTVerifyGetKey } }): express.Express`
  - HTTP (all under bearer auth; writes require role `Core.Admin`):
    - `GET /api/organizations` → `OrgRecord[]`; `GET /api/organizations/:key` → `OrgRecord | 404`
    - `PUT /api/organizations/:key` (body `OrgInput`, key must match) → `200 OrgRecord`; `400` on validation error
    - `POST /api/organizations/:key/deactivate` → `204 | 404`
    - `GET /api/terms/:kind`, `GET /api/terms/:kind/:key`, `PUT /api/terms/:kind/:key`, `POST /api/terms/:kind/:key/deactivate` (kind ∈ sector|theme|tag|service, else 404)
    - `POST /api/admin/republish` → `202 { "enqueued": n }`
  - Unauthenticated: `GET /health/live` → 200 `{status:"ok"}`; `GET /health/ready` → 200 when DB answers `SELECT 1`, else 503
  - Env: `DATABASE_URL`, `PORT` (default 3001), `ENTRA_TENANT_ID`, `AUTH_AUDIENCE`, `EVENT_SUBSCRIBERS` (JSON array of SubscriberConfig)

- [ ] **Step 1: Write the failing API test**

`apps/core/src/http/routes.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCoreTestDb, healthOrg } from "../../test/helpers";
import { createApp } from "../app";

const issuer = "https://login.microsoftonline.com/t/v2.0";
const audience = "api://core";

describe("Core HTTP API", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let admin: string;
  let reader: string;

  beforeAll(async () => {
    tdb = await createCoreTestDb();
    const pair = await generateKeyPair("RS256");
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k", alg: "RS256" }] });
    const sign = (roles: string[]) =>
      new SignJWT({ roles }).setProtectedHeader({ alg: "RS256", kid: "k" }).setIssuer(issuer).setAudience(audience).setSubject("svc").setExpirationTime("5m").sign(pair.privateKey);
    admin = await sign(["Core.Admin"]);
    reader = await sign([]);
    app = createApp({ db: tdb.db, subscribers: [], auth: { issuer, audience, keys } });
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("health endpoints need no auth", async () => {
    expect((await request(app).get("/health/live")).status).toBe(200);
    expect((await request(app).get("/health/ready")).body).toEqual({ status: "ok" });
  });

  it("requires a token for reads and Core.Admin for writes", async () => {
    expect((await request(app).get("/api/organizations")).status).toBe(401);
    expect((await request(app).put("/api/organizations/health").set("authorization", `Bearer ${reader}`).send(healthOrg)).status).toBe(403);
  });

  it("creates, reads, lists and deactivates an organization", async () => {
    const put = await request(app).put("/api/organizations/health").set("authorization", `Bearer ${admin}`).send(healthOrg);
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject(healthOrg);
    expect((await request(app).get("/api/organizations/health").set("authorization", `Bearer ${reader}`)).body.key).toBe("health");
    expect((await request(app).get("/api/organizations").set("authorization", `Bearer ${reader}`)).body).toHaveLength(1);
    expect((await request(app).post("/api/organizations/health/deactivate").set("authorization", `Bearer ${admin}`)).status).toBe(204);
    expect((await request(app).post("/api/organizations/nope/deactivate").set("authorization", `Bearer ${admin}`)).status).toBe(404);
  });

  it("400 when the body key does not match the path or is invalid", async () => {
    expect((await request(app).put("/api/organizations/other").set("authorization", `Bearer ${admin}`).send(healthOrg)).status).toBe(400);
    expect((await request(app).put("/api/organizations/health").set("authorization", `Bearer ${admin}`).send({ key: "health" })).status).toBe(400);
  });

  it("handles terms and rejects unknown kinds", async () => {
    const term = { kind: "tag", key: "covid-19", displayName: "COVID-19", sortOrder: 0, isActive: true, social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null } };
    expect((await request(app).put("/api/terms/tag/covid-19").set("authorization", `Bearer ${admin}`).send(term)).status).toBe(200);
    expect((await request(app).get("/api/terms/tag").set("authorization", `Bearer ${reader}`)).body).toHaveLength(1);
    expect((await request(app).get("/api/terms/planet").set("authorization", `Bearer ${reader}`)).status).toBe(404);
  });

  it("republish returns the number of enqueued events", async () => {
    const res = await request(app).post("/api/admin/republish").set("authorization", `Bearer ${admin}`);
    expect(res.status).toBe(202);
    expect(res.body.enqueued).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/core/src/http`
Expected: FAIL — cannot resolve `../app`.

- [ ] **Step 3: Implement routes and app**

`apps/core/src/http/routes.ts`:
```ts
import express, { type Request, type Response } from "express";
import { ZodError } from "zod";
import type { Db } from "@gcpe/db-kit";
import { requireRole } from "@gcpe/auth";
import { termKindSchema, type SubscriberConfig, type TermKind } from "@gcpe/events";
import { deactivateOrganization, getOrganization, listOrganizations, orgInputSchema, upsertOrganization } from "../services/organizations";
import { republishAll } from "../services/republish";
import { deactivateTerm, getTerm, listTerms, termInputSchema, upsertTerm } from "../services/terms";

function parseKind(req: Request, res: Response): TermKind | null {
  const parsed = termKindSchema.safeParse(req.params.kind);
  if (!parsed.success) {
    res.status(404).json({ error: "unknown term kind" });
    return null;
  }
  return parsed.data;
}

function badRequest(res: Response, e: unknown) {
  res.status(400).json({ error: e instanceof ZodError ? e.issues : String(e) });
}

export function apiRoutes(db: Db, subscribers: SubscriberConfig[]): express.Router {
  const r = express.Router();
  const admin = requireRole("Core.Admin");

  r.get("/organizations", async (_req, res) => void res.json(await listOrganizations(db)));
  r.get("/organizations/:key", async (req, res) => {
    const org = await getOrganization(db, req.params.key);
    org ? res.json(org) : res.status(404).json({ error: "not found" });
  });
  r.put("/organizations/:key", admin, async (req, res) => {
    try {
      const input = orgInputSchema.parse(req.body);
      if (input.key !== req.params.key) return void res.status(400).json({ error: "body key must match path" });
      res.json((await upsertOrganization(db, input, subscribers)).record);
    } catch (e) {
      badRequest(res, e);
    }
  });
  r.post("/organizations/:key/deactivate", admin, async (req, res) => {
    (await deactivateOrganization(db, req.params.key, subscribers)) ? res.status(204).end() : res.status(404).json({ error: "not found" });
  });

  r.get("/terms/:kind", async (req, res) => {
    const kind = parseKind(req, res);
    if (kind) res.json(await listTerms(db, kind));
  });
  r.get("/terms/:kind/:key", async (req, res) => {
    const kind = parseKind(req, res);
    if (!kind) return;
    const term = await getTerm(db, kind, req.params.key);
    term ? res.json(term) : res.status(404).json({ error: "not found" });
  });
  r.put("/terms/:kind/:key", admin, async (req, res) => {
    const kind = parseKind(req, res);
    if (!kind) return;
    try {
      const input = termInputSchema.parse(req.body);
      if (input.kind !== kind || input.key !== req.params.key) return void res.status(400).json({ error: "body kind/key must match path" });
      res.json((await upsertTerm(db, input, subscribers)).record);
    } catch (e) {
      badRequest(res, e);
    }
  });
  r.post("/terms/:kind/:key/deactivate", admin, async (req, res) => {
    const kind = parseKind(req, res);
    if (!kind) return;
    (await deactivateTerm(db, kind, req.params.key, subscribers)) ? res.status(204).end() : res.status(404).json({ error: "not found" });
  });

  r.post("/admin/republish", admin, async (_req, res) => {
    res.status(202).json({ enqueued: await republishAll(db, subscribers) });
  });
  return r;
}
```

`apps/core/src/app.ts`:
```ts
import express from "express";
import { sql } from "drizzle-orm";
import type { JWTVerifyGetKey } from "jose";
import type { Db } from "@gcpe/db-kit";
import { requireBearer } from "@gcpe/auth";
import type { SubscriberConfig } from "@gcpe/events";
import { apiRoutes } from "./http/routes";

export function createApp(deps: {
  db: Db;
  subscribers: SubscriberConfig[];
  auth: { issuer: string; audience: string; keys: JWTVerifyGetKey };
}): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.get("/health/live", (_req, res) => void res.json({ status: "ok" }));
  app.get("/health/ready", async (_req, res) => {
    try {
      await deps.db.execute(sql`SELECT 1`);
      res.json({ status: "ok" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });
  app.use("/api", express.json({ limit: "2mb" }), requireBearer(deps.auth), apiRoutes(deps.db, deps.subscribers));
  return app;
}
```

`apps/core/src/main.ts`:
```ts
import { z } from "zod";
import { entraIssuer, entraJwks } from "@gcpe/auth";
import { parseEnv } from "@gcpe/config";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { parseSubscribers, startDispatcher } from "@gcpe/events";
import { createApp } from "./app";

const env = parseEnv(
  z.object({
    DATABASE_URL: z.string().url(),
    PORT: z.coerce.number().int().default(3001),
    ENTRA_TENANT_ID: z.string().min(1),
    AUTH_AUDIENCE: z.string().min(1),
    EVENT_SUBSCRIBERS: z.string().optional(),
    MIGRATIONS_FOLDER: z.string().default(new URL("../migrations", import.meta.url).pathname),
  }),
);

const { db } = createDb(env.DATABASE_URL);
await runMigrations(db, env.MIGRATIONS_FOLDER);
const subscribers = parseSubscribers(env.EVENT_SUBSCRIBERS);
const stopDispatcher = startDispatcher({ db, subscribers });
const app = createApp({
  db,
  subscribers,
  auth: { issuer: entraIssuer(env.ENTRA_TENANT_ID), audience: env.AUTH_AUDIENCE, keys: entraJwks(env.ENTRA_TENANT_ID) },
});
const server = app.listen(env.PORT, () => console.log(`[core] listening on ${env.PORT}`));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    server.close();
    await stopDispatcher();
    process.exit(0);
  });
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run apps/core && npm run check`
Expected: all Core tests PASS.

- [ ] **Step 5: Build script and Dockerfile**

`scripts/build-app.mjs`:
```js
// Usage: node scripts/build-app.mjs apps/<name>
// Bundles the app and its @gcpe/* workspace packages into dist/main.js; npm dependencies stay external.
import { build } from "esbuild";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? ".");
const root = resolve(import.meta.dirname, "..");
const deps = new Set();
const addDeps = (pkgPath) => {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  for (const name of Object.keys(pkg.dependencies ?? {})) if (!name.startsWith("@gcpe/")) deps.add(name);
};
addDeps(join(appDir, "package.json"));
for (const dir of readdirSync(join(root, "packages"))) {
  const p = join(root, "packages", dir, "package.json");
  if (existsSync(p)) addDeps(p);
}
await build({
  entryPoints: [join(appDir, "src/main.ts")],
  outfile: join(appDir, "dist/main.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: [...deps],
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
});
console.log(`built ${appDir}/dist/main.js`);
```

`apps/core/Dockerfile` (build context = repo root):
```dockerfile
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps/core ./apps/core
COPY scripts ./scripts
RUN npm ci --workspace @gcpe/core --include-workspace-root
RUN node scripts/build-app.mjs apps/core

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/package.json /repo/package-lock.json ./
COPY --from=build /repo/apps/core/package.json ./apps/core/package.json
COPY --from=build /repo/packages ./packages
RUN npm ci --omit=dev --workspace @gcpe/core && rm -rf packages/*/src/**/*.test.ts
COPY --from=build /repo/apps/core/dist ./apps/core/dist
COPY --from=build /repo/apps/core/migrations ./apps/core/migrations
USER 1001
ENV MIGRATIONS_FOLDER=/app/apps/core/migrations
EXPOSE 3001
HEALTHCHECK CMD wget -qO- http://localhost:3001/health/live || exit 1
CMD ["node", "apps/core/dist/main.js"]
```

Run: `npm --workspace @gcpe/core run build && ls apps/core/dist/main.js`
Expected: `built .../apps/core/dist/main.js` and the file exists. (`docker build -f apps/core/Dockerfile .` is verified in CI later; Docker is not installed on the dev machine.)

Add `dist/` is already in `.gitignore`.

- [ ] **Step 6: Commit**

```bash
git add apps/core scripts/build-app.mjs
git commit -m "feat(core): authenticated reference-data API, health endpoints, bundler and Dockerfile"
```

---

### Task 11: Core — legacy reference-data importer

**Files:**
- Create: `apps/core/src/import/queries.ts`, `apps/core/src/import/map.ts`, `apps/core/src/import/run.ts`, `apps/core/src/import/cli.ts`
- Test: `apps/core/src/import/map.test.ts`, `apps/core/src/import/run.test.ts`

**Interfaces:**
- Consumes: `LegacySource`, `createMssqlSource`, `createFakeSource` (Task 8); `upsertOrganization`, `upsertTerm`, `OrgInput`, `TermInput` (Task 9).
- Produces:
  - Query constants `Q_MINISTRIES`, `Q_MINISTRY_TOPICS`, `Q_MINISTRY_SERVICES`, `Q_MINISTRY_SECTORS`, `Q_SECTORS`, `Q_THEMES`, `Q_TAGS`, `Q_SERVICES` (each begins with `-- name: <name>`)
  - Row types `LegacyMinistryRow`, `LegacyLinkRow`, `LegacyMinistrySectorRow`, `LegacyTermRow`
  - `mapMinistry(row: LegacyMinistryRow, links: { topics: LegacyLinkRow[]; services: LegacyLinkRow[]; sectorKeys: string[] }): OrgInput`
  - `mapTerm(kind: TermKind, row: LegacyTermRow): TermInput`
  - `importLegacyReference(db: Db, source: LegacySource, subscribers: SubscriberConfig[]): Promise<{ organizations: { total: number; changed: number }; terms: { total: number; changed: number } }>`
  - CLI env: `DATABASE_URL`, `EVENT_SUBSCRIBERS`, `LEGACY_SQL_SERVER`, `LEGACY_SQL_DATABASE` (default `Gcpe.Hub`), `LEGACY_SQL_USER`, `LEGACY_SQL_PASSWORD`, `LEGACY_SQL_TRUST_CERT` (`true|false`)

**Mapping rules (legacy → Core):**

| Core field | Legacy source |
|---|---|
| `key` | `Ministry.Key` (verbatim — some are GUID strings, e.g. GCPE Media Relations) |
| `displayName`, `abbreviation`, `sortOrder`, `isActive` | `DisplayName`, `Abbreviation`, `SortOrder`, `IsActive` |
| `parentKey` | `Ministry.Key` of `ParentId` |
| `url`, `displayAdditionalName`, `weekendContactNumber` | `MinistryUrl`, `DisplayAdditionalName`, `WeekendContactNumber` |
| `minister.{name, summary, detailsHtml, email, photoUrl, address}` | `MinisterName`, `MinisterSummary`, `MinisterPageHtml`, `MinisterEmail`, `MinisterPhotoUrl`, `MinisterAddress` |
| `contact`, `secondContact` | `calendar.SystemUser` via `ContactUserId` / `SecondContactUserId` (`FullName`, `PhoneNumber`, `MobileNumber`, `EmailAddress`); `null` when the id is NULL |
| `social` | `TwitterUsername`, `FlickrUrl`, `YoutubeUrl`, `AudioUrl` |
| `topicLinks`, `serviceLinks` | `MinistryTopic`, `MinistryService` ordered by `SortIndex` → `{ text: LinkText, url: LinkUrl }` |
| `sectorKeys` | `Sector.Key` via `MinistrySector` |
| Term `displayName` | `DisplayName`, falling back to the English (`LanguageId = 4105`) `SectorLanguage.Name` for sectors |

All strings are carried **verbatim** (legacy `N''` stays `""`, `NULL` stays `null`).

- [ ] **Step 1: Write the failing mapper test (real legacy seed values)**

`apps/core/src/import/map.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { mapMinistry, mapTerm, type LegacyMinistryRow } from "./map";

// Values from gcpe-hub-develop/db-scripts/gcpe.hub-data-01-dbo.sql (GCPE Media Relations row)
const mediaRelations: LegacyMinistryRow = {
  Id: "768dbf29-89c6-48d1-901e-017a8a3557a4",
  Key: "768DBF29-89C6-48D1-901E-017A8A3557A4",
  SortOrder: 190,
  DisplayName: "GCPE Media Relations",
  Abbreviation: "GCPEMEDIA",
  IsActive: true,
  MinisterEmail: "",
  MinisterPhotoUrl: "",
  MinisterPageHtml: "",
  MinisterAddress: "",
  MinisterName: "",
  MinisterSummary: "",
  MinistryUrl: null,
  ParentKey: null,
  WeekendContactNumber: "",
  DisplayAdditionalName: "",
  TwitterUsername: "",
  FlickrUrl: "",
  YoutubeUrl: "",
  AudioUrl: "",
  ContactFullName: null,
  ContactPhone: null,
  ContactMobile: null,
  ContactEmail: null,
  ContactUserId: null,
  SecondContactFullName: null,
  SecondContactPhone: null,
  SecondContactMobile: null,
  SecondContactEmail: null,
  SecondContactUserId: null,
};

describe("mapMinistry", () => {
  it("carries empty strings and NULLs verbatim", () => {
    const org = mapMinistry(mediaRelations, { topics: [], services: [], sectorKeys: [] });
    expect(org).toEqual({
      key: "768DBF29-89C6-48D1-901E-017A8A3557A4",
      displayName: "GCPE Media Relations",
      abbreviation: "GCPEMEDIA",
      sortOrder: 190,
      isActive: true,
      parentKey: null,
      url: null,
      displayAdditionalName: "",
      minister: { name: "", summary: "", detailsHtml: "", email: "", photoUrl: "", address: "" },
      contact: null,
      secondContact: null,
      weekendContactNumber: "",
      social: { twitterUsername: "", flickrUrl: "", youtubeUrl: "", audioUrl: "" },
      topicLinks: [],
      serviceLinks: [],
      sectorKeys: [],
    });
  });

  it("maps contacts, parent, and links ordered by SortIndex", () => {
    const org = mapMinistry(
      { ...mediaRelations, Key: "health", ParentKey: "office-of-the-premier", ContactUserId: 7, ContactFullName: "Alex Example", ContactPhone: "250-555-0100", ContactMobile: "250-555-0100", ContactEmail: "alex.example@gov.bc.ca" },
      {
        topics: [
          { MinistryId: mediaRelations.Id, SortIndex: 2, LinkText: "Second", LinkUrl: "https://b" },
          { MinistryId: mediaRelations.Id, SortIndex: 1, LinkText: "First", LinkUrl: "https://a" },
        ],
        services: [],
        sectorKeys: ["health"],
      },
    );
    expect(org.parentKey).toBe("office-of-the-premier");
    expect(org.contact).toEqual({ fullName: "Alex Example", phoneNumber: "250-555-0100", mobileNumber: "250-555-0100", emailAddress: "alex.example@gov.bc.ca" });
    expect(org.topicLinks).toEqual([{ text: "First", url: "https://a" }, { text: "Second", url: "https://b" }]);
    expect(org.sectorKeys).toEqual(["health"]);
  });
});

describe("mapTerm", () => {
  // gcpe.hub-data-01-dbo.sql Sector row
  it("maps a sector with its English name fallback", () => {
    expect(
      mapTerm("sector", { Id: "1b1c7a5e-0000-0000-0000-000000000001", Key: "government-operations", SortOrder: 0, IsActive: true, DisplayName: null, EnglishName: "Government Operations", TwitterUsername: "", FlickrUrl: "", YoutubeUrl: "", AudioUrl: "" }),
    ).toEqual({
      kind: "sector",
      key: "government-operations",
      displayName: "Government Operations",
      sortOrder: 0,
      isActive: true,
      social: { twitterUsername: "", flickrUrl: "", youtubeUrl: "", audioUrl: "" },
    });
  });

  it("maps a theme without social columns to null social fields", () => {
    expect(mapTerm("theme", { Id: "1b1c7a5e-0000-0000-0000-000000000002", Key: "health", SortOrder: 0, IsActive: true, DisplayName: "Health" }).social).toEqual({
      twitterUsername: null,
      flickrUrl: null,
      youtubeUrl: null,
      audioUrl: null,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/core/src/import/map.test.ts`
Expected: FAIL — cannot resolve `./map`.

- [ ] **Step 3: Implement queries and mapper**

`apps/core/src/import/queries.ts`:
```ts
export const Q_MINISTRIES = `-- name: ministries
SELECT m.Id, m.[Key], m.SortOrder, m.DisplayName, m.Abbreviation, m.IsActive,
       m.MinisterEmail, m.MinisterPhotoUrl, m.MinisterPageHtml, m.MinisterAddress, m.MinisterName, m.MinisterSummary,
       m.MinistryUrl, p.[Key] AS ParentKey, m.WeekendContactNumber, m.DisplayAdditionalName,
       m.TwitterUsername, m.FlickrUrl, m.YoutubeUrl, m.AudioUrl,
       m.ContactUserId, c1.FullName AS ContactFullName, c1.PhoneNumber AS ContactPhone, c1.MobileNumber AS ContactMobile, c1.EmailAddress AS ContactEmail,
       m.SecondContactUserId, c2.FullName AS SecondContactFullName, c2.PhoneNumber AS SecondContactPhone, c2.MobileNumber AS SecondContactMobile, c2.EmailAddress AS SecondContactEmail
FROM dbo.Ministry m
LEFT JOIN dbo.Ministry p ON p.Id = m.ParentId
LEFT JOIN calendar.SystemUser c1 ON c1.Id = m.ContactUserId
LEFT JOIN calendar.SystemUser c2 ON c2.Id = m.SecondContactUserId`;

export const Q_MINISTRY_TOPICS = `-- name: ministryTopics
SELECT MinistryId, SortIndex, LinkText, LinkUrl FROM dbo.MinistryTopic`;

export const Q_MINISTRY_SERVICES = `-- name: ministryServices
SELECT MinistryId, SortIndex, LinkText, LinkUrl FROM dbo.MinistryService`;

export const Q_MINISTRY_SECTORS = `-- name: ministrySectors
SELECT ms.MinistryId, s.[Key] AS SectorKey FROM dbo.MinistrySector ms JOIN dbo.Sector s ON s.Id = ms.SectorId`;

export const Q_SECTORS = `-- name: sectors
SELECT s.Id, s.[Key], s.SortOrder, s.IsActive, s.DisplayName, sl.Name AS EnglishName,
       s.TwitterUsername, s.FlickrUrl, s.YoutubeUrl, s.AudioUrl
FROM dbo.Sector s
LEFT JOIN dbo.SectorLanguage sl ON sl.SectorId = s.Id AND sl.LanguageId = 4105`;

export const Q_THEMES = `-- name: themes
SELECT Id, [Key], SortOrder, IsActive, DisplayName FROM dbo.Theme`;

export const Q_TAGS = `-- name: tags
SELECT Id, [Key], SortOrder, IsActive, DisplayName FROM dbo.Tag`;

export const Q_SERVICES = `-- name: services
SELECT Id, [Key], SortOrder, IsActive, DisplayName FROM dbo.Service`;
```

`apps/core/src/import/map.ts`:
```ts
import type { TermKind } from "@gcpe/events";
import type { OrgInput } from "../services/organizations";
import type { TermInput } from "../services/terms";

export interface LegacyMinistryRow extends Record<string, unknown> {
  Id: string;
  Key: string;
  SortOrder: number;
  DisplayName: string;
  Abbreviation: string | null;
  IsActive: boolean;
  MinisterEmail: string | null;
  MinisterPhotoUrl: string | null;
  MinisterPageHtml: string | null;
  MinisterAddress: string | null;
  MinisterName: string | null;
  MinisterSummary: string | null;
  MinistryUrl: string | null;
  ParentKey: string | null;
  WeekendContactNumber: string | null;
  DisplayAdditionalName: string | null;
  TwitterUsername: string | null;
  FlickrUrl: string | null;
  YoutubeUrl: string | null;
  AudioUrl: string | null;
  ContactUserId: number | null;
  ContactFullName: string | null;
  ContactPhone: string | null;
  ContactMobile: string | null;
  ContactEmail: string | null;
  SecondContactUserId: number | null;
  SecondContactFullName: string | null;
  SecondContactPhone: string | null;
  SecondContactMobile: string | null;
  SecondContactEmail: string | null;
}

export interface LegacyLinkRow extends Record<string, unknown> {
  MinistryId: string;
  SortIndex: number;
  LinkText: string;
  LinkUrl: string;
}

export interface LegacyMinistrySectorRow extends Record<string, unknown> {
  MinistryId: string;
  SectorKey: string;
}

export interface LegacyTermRow extends Record<string, unknown> {
  Id: string;
  Key: string;
  SortOrder: number;
  IsActive: boolean;
  DisplayName: string | null;
  EnglishName?: string | null;
  TwitterUsername?: string | null;
  FlickrUrl?: string | null;
  YoutubeUrl?: string | null;
  AudioUrl?: string | null;
}

function links(rows: LegacyLinkRow[]) {
  return [...rows].sort((a, b) => a.SortIndex - b.SortIndex).map((r) => ({ text: r.LinkText, url: r.LinkUrl }));
}

function contact(id: number | null, fullName: string | null, phone: string | null, mobile: string | null, email: string | null) {
  if (id === null || id === undefined) return null;
  return { fullName, phoneNumber: phone, mobileNumber: mobile, emailAddress: email };
}

export function mapMinistry(
  row: LegacyMinistryRow,
  related: { topics: LegacyLinkRow[]; services: LegacyLinkRow[]; sectorKeys: string[] },
): OrgInput {
  return {
    key: row.Key,
    displayName: row.DisplayName,
    abbreviation: row.Abbreviation,
    sortOrder: row.SortOrder,
    isActive: Boolean(row.IsActive),
    parentKey: row.ParentKey,
    url: row.MinistryUrl,
    displayAdditionalName: row.DisplayAdditionalName,
    minister: {
      name: row.MinisterName,
      summary: row.MinisterSummary,
      detailsHtml: row.MinisterPageHtml,
      email: row.MinisterEmail,
      photoUrl: row.MinisterPhotoUrl,
      address: row.MinisterAddress,
    },
    contact: contact(row.ContactUserId, row.ContactFullName, row.ContactPhone, row.ContactMobile, row.ContactEmail),
    secondContact: contact(row.SecondContactUserId, row.SecondContactFullName, row.SecondContactPhone, row.SecondContactMobile, row.SecondContactEmail),
    weekendContactNumber: row.WeekendContactNumber,
    social: { twitterUsername: row.TwitterUsername, flickrUrl: row.FlickrUrl, youtubeUrl: row.YoutubeUrl, audioUrl: row.AudioUrl },
    topicLinks: links(related.topics),
    serviceLinks: links(related.services),
    sectorKeys: [...related.sectorKeys].sort(),
  };
}

export function mapTerm(kind: TermKind, row: LegacyTermRow): TermInput {
  return {
    kind,
    key: row.Key,
    displayName: row.DisplayName ?? row.EnglishName ?? null,
    sortOrder: row.SortOrder,
    isActive: Boolean(row.IsActive),
    social: {
      twitterUsername: row.TwitterUsername ?? null,
      flickrUrl: row.FlickrUrl ?? null,
      youtubeUrl: row.YoutubeUrl ?? null,
      audioUrl: row.AudioUrl ?? null,
    },
  };
}
```

- [ ] **Step 4: Run mapper tests**

Run: `npx vitest run apps/core/src/import/map.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Write the failing import-run test**

`apps/core/src/import/run.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { outboxEvents, type SubscriberConfig } from "@gcpe/events";
import { createFakeSource } from "@gcpe/legacy-import";
import { createCoreTestDb } from "../../test/helpers";
import { listOrganizations } from "../services/organizations";
import { importLegacyReference } from "./run";

const subs: SubscriberConfig[] = [{ name: "news-api", url: "http://x/events", secret: "s", types: ["*"] }];
const healthId = "11111111-1111-1111-1111-111111111111";
const ministryRow = {
  Id: healthId, Key: "health", SortOrder: 10, DisplayName: "Health", Abbreviation: "HLTH", IsActive: true,
  MinisterEmail: "HLTH.Minister@gov.bc.ca", MinisterPhotoUrl: null, MinisterPageHtml: "<p>bio</p>", MinisterAddress: "PO BOX 9050",
  MinisterName: "Honourable Ravi Kahlon", MinisterSummary: "Honourable Ravi Kahlon", MinistryUrl: "http://gov.bc.ca/health", ParentKey: null,
  WeekendContactNumber: "", DisplayAdditionalName: null, TwitterUsername: "", FlickrUrl: null, YoutubeUrl: null, AudioUrl: null,
  ContactUserId: null, ContactFullName: null, ContactPhone: null, ContactMobile: null, ContactEmail: null,
  SecondContactUserId: null, SecondContactFullName: null, SecondContactPhone: null, SecondContactMobile: null, SecondContactEmail: null,
};
const source = createFakeSource({
  ministries: [ministryRow],
  ministryTopics: [{ MinistryId: healthId, SortIndex: 0, LinkText: "Get immunized", LinkUrl: "https://x" }],
  ministryServices: [],
  ministrySectors: [{ MinistryId: healthId, SectorKey: "health" }],
  sectors: [{ Id: "22222222-2222-2222-2222-222222222222", Key: "health", SortOrder: 0, IsActive: true, DisplayName: "Health", EnglishName: "Health", TwitterUsername: "", FlickrUrl: "", YoutubeUrl: "", AudioUrl: "" }],
  themes: [{ Id: "33333333-3333-3333-3333-333333333333", Key: "health", SortOrder: 0, IsActive: true, DisplayName: "Health" }],
  tags: [],
  services: [],
});

describe("importLegacyReference", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCoreTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("imports organizations and terms and emits events", async () => {
    const result = await importLegacyReference(tdb.db, source, subs);
    expect(result).toEqual({ organizations: { total: 1, changed: 1 }, terms: { total: 2, changed: 2 } });
    const [org] = await listOrganizations(tdb.db);
    expect(org!.topicLinks).toEqual([{ text: "Get immunized", url: "https://x" }]);
    expect(org!.sectorKeys).toEqual(["health"]);
    expect(await tdb.db.select().from(outboxEvents)).toHaveLength(3);
  });

  it("second import emits no events", async () => {
    const result = await importLegacyReference(tdb.db, source, subs);
    expect(result).toEqual({ organizations: { total: 1, changed: 0 }, terms: { total: 2, changed: 0 } });
    expect(await tdb.db.select().from(outboxEvents)).toHaveLength(3);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run apps/core/src/import/run.test.ts`
Expected: FAIL — cannot resolve `./run`.

- [ ] **Step 7: Implement the runner and CLI**

`apps/core/src/import/run.ts`:
```ts
import type { Db } from "@gcpe/db-kit";
import type { SubscriberConfig, TermKind } from "@gcpe/events";
import type { LegacySource } from "@gcpe/legacy-import";
import { upsertOrganization } from "../services/organizations";
import { upsertTerm } from "../services/terms";
import { mapMinistry, mapTerm, type LegacyLinkRow, type LegacyMinistryRow, type LegacyMinistrySectorRow, type LegacyTermRow } from "./map";
import { Q_MINISTRIES, Q_MINISTRY_SECTORS, Q_MINISTRY_SERVICES, Q_MINISTRY_TOPICS, Q_SECTORS, Q_SERVICES, Q_TAGS, Q_THEMES } from "./queries";

function groupBy<T, K>(rows: T[], key: (r: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const r of rows) map.set(key(r), [...(map.get(key(r)) ?? []), r]);
  return map;
}

const norm = (id: string) => id.toLowerCase();

export async function importLegacyReference(db: Db, source: LegacySource, subscribers: SubscriberConfig[]) {
  const result = { organizations: { total: 0, changed: 0 }, terms: { total: 0, changed: 0 } };

  const termQueries: [TermKind, string][] = [
    ["sector", Q_SECTORS],
    ["theme", Q_THEMES],
    ["tag", Q_TAGS],
    ["service", Q_SERVICES],
  ];
  for (const [kind, q] of termQueries) {
    for (const row of await source.query<LegacyTermRow>(q)) {
      const { changed } = await upsertTerm(db, mapTerm(kind, row), subscribers, { legacyId: norm(row.Id) });
      result.terms.total++;
      if (changed) result.terms.changed++;
    }
  }

  const ministries = await source.query<LegacyMinistryRow>(Q_MINISTRIES);
  const topics = groupBy(await source.query<LegacyLinkRow>(Q_MINISTRY_TOPICS), (r) => norm(r.MinistryId));
  const services = groupBy(await source.query<LegacyLinkRow>(Q_MINISTRY_SERVICES), (r) => norm(r.MinistryId));
  const sectors = groupBy(await source.query<LegacyMinistrySectorRow>(Q_MINISTRY_SECTORS), (r) => norm(r.MinistryId));
  for (const row of ministries) {
    const id = norm(row.Id);
    const org = mapMinistry(row, {
      topics: topics.get(id) ?? [],
      services: services.get(id) ?? [],
      sectorKeys: (sectors.get(id) ?? []).map((s) => s.SectorKey),
    });
    const { changed } = await upsertOrganization(db, org, subscribers, { legacyId: id });
    result.organizations.total++;
    if (changed) result.organizations.changed++;
  }
  return result;
}
```

`apps/core/src/import/cli.ts`:
```ts
import { z } from "zod";
import { parseEnv } from "@gcpe/config";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { parseSubscribers } from "@gcpe/events";
import { createMssqlSource } from "@gcpe/legacy-import";
import { importLegacyReference } from "./run";

const env = parseEnv(
  z.object({
    DATABASE_URL: z.string().url(),
    EVENT_SUBSCRIBERS: z.string().optional(),
    LEGACY_SQL_SERVER: z.string().min(1),
    LEGACY_SQL_DATABASE: z.string().default("Gcpe.Hub"),
    LEGACY_SQL_USER: z.string().min(1),
    LEGACY_SQL_PASSWORD: z.string().min(1),
    LEGACY_SQL_TRUST_CERT: z.enum(["true", "false"]).default("false"),
  }),
);

const { db, pool } = createDb(env.DATABASE_URL);
await runMigrations(db, new URL("../../migrations", import.meta.url).pathname);
const source = await createMssqlSource({
  server: env.LEGACY_SQL_SERVER,
  database: env.LEGACY_SQL_DATABASE,
  user: env.LEGACY_SQL_USER,
  password: env.LEGACY_SQL_PASSWORD,
  trustServerCertificate: env.LEGACY_SQL_TRUST_CERT === "true",
});
try {
  const result = await importLegacyReference(db, source, parseSubscribers(env.EVENT_SUBSCRIBERS));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await source.close();
  await pool.end();
}
```

- [ ] **Step 8: Run all tests and type-check**

Run: `npm test && npm run check`
Expected: every test in the repo PASSES; `tsc` exits 0.

- [ ] **Step 9: Commit**

```bash
git add apps/core
git commit -m "feat(core): idempotent legacy SQL Server reference-data importer"
```

---

### Task 12: README developer setup

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace README with developer setup**

`README.md`:
````markdown
# gcpe-news-platform

Node.js + PostgreSQL replatform of the GCPE news toolchain: Corporate Calendar → NRMS → NoD → Distribution → News API → static public site.

- Design: [docs/superpowers/specs/2026-10-02-gcpe-news-platform-design.md](docs/superpowers/specs/2026-10-02-gcpe-news-platform-design.md)
- Plans: [docs/superpowers/plans/](docs/superpowers/plans/)

## Prerequisites

- Node 22 (`.nvmrc`), npm 10
- PostgreSQL ≥ 14 with the `vector` extension available (Homebrew `postgresql@14` + `pgvector`, or `docker compose -f deploy/docker-compose.yml up postgres`)

## Setup

```bash
npm install
cp .env.example .env   # adjust TEST_DATABASE_ADMIN_URL if needed
npm run check          # type-check every workspace
npm test               # unit + integration tests (creates/drops throwaway databases)
```

## Workspaces

| Path | Purpose |
|---|---|
| `packages/config` | Tenant config (`config/tenants/*.json`) and env parsing |
| `packages/db-kit` | Postgres pool + Drizzle, migrations, test databases |
| `packages/events` | Event envelope/catalogue, outbox, dispatcher, signed webhook receiver |
| `packages/auth` | Entra bearer tokens, role guard, client-credentials tokens |
| `packages/legacy-import` | Legacy SQL Server reader and enum maps |
| `apps/core` | Reference data (organizations, sectors, themes, tags, services) |

## Running Core locally

```bash
createdb core
DATABASE_URL=postgres://localhost:5432/core ENTRA_TENANT_ID=<tenant> AUTH_AUDIENCE=api://core \
EVENT_SUBSCRIBERS='[]' npm --workspace @gcpe/core run dev
```

Legacy import (requires network access to a legacy SQL Server copy):

```bash
DATABASE_URL=postgres://localhost:5432/core LEGACY_SQL_SERVER=<host> LEGACY_SQL_USER=<user> LEGACY_SQL_PASSWORD=<pw> \
npm --workspace @gcpe/core run import:legacy
```
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: developer setup for foundation and Core"
```

---

## Phase 0 exit check

Run: `npm run check && npm test`
Expected: all green. `packages/events/src/roundtrip.test.ts` demonstrates the spec §11 Phase 0 exit criterion (two apps exchange a signed event with dedupe and retry).
