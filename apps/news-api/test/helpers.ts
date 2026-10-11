import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type express from "express";
import pg from "pg";
import request from "supertest";
import { createDb, createTestDatabase, runMigrations, type TestDatabase } from "@gcpe/db-kit";
import { signPayload } from "@gcpe/events";
import type { Closer } from "@gcpe/http-kit";
import { fileURLToPath } from "node:url";

export const TZ = "America/Vancouver";
export const EVENT_SECRETS = { core: "core-secret", nrms: "nrms-secret" } as const;
export const newsMigrations = fileURLToPath(new URL("../migrations", import.meta.url));

export function createNewsTestDb(): Promise<TestDatabase> {
  return createTestDatabase({ migrationsFolder: newsMigrations });
}

const adminUrl = () => process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://localhost:5432/postgres";

async function asAdmin(statements: string[]): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    for (const s of statements) await client.query(s);
  } finally {
    await client.end();
  }
}

/**
 * A database owned by a fresh LOGIN role that is not a superuser, so it cannot CREATE EXTENSION
 * vector (the SiteGround case, spec §9), with every News API migration applied as that role.
 */
export async function createRestrictedNewsTestDb(): Promise<TestDatabase> {
  const id = randomUUID().replace(/-/g, "").slice(0, 16);
  const role = `nr_${id}`;
  const name = `test_nr_${id}`;
  const password = `pw_${id}`;
  await asAdmin([
    `CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}'`,
    `CREATE DATABASE "${name}" OWNER "${role}"`,
  ]);
  const url = new URL(adminUrl());
  url.username = role;
  url.password = password;
  url.pathname = `/${name}`;
  const { pool, db } = createDb(url.toString(), { max: 5 });
  const drop = async () => {
    await pool.end().catch(() => {});
    await asAdmin([`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`, `DROP ROLE IF EXISTS "${role}"`]);
  };
  try {
    await runMigrations(db, newsMigrations);
  } catch (e) {
    await drop();
    throw e;
  }
  return { pool, db, url: url.toString(), migrate: () => runMigrations(db, newsMigrations), drop };
}

export function newsMigrationCount(): number {
  return (JSON.parse(readFileSync(join(newsMigrations, "meta", "_journal.json"), "utf8")) as { entries: unknown[] }).entries.length;
}

const bcTenantPath = fileURLToPath(new URL("../../../config/tenants/bc.json", import.meta.url));

/** BC's tenant config with `patch` merged over its top level, written to a temp file. */
export function writeTenantConfig(patch: Record<string, unknown>): string {
  const bc = JSON.parse(readFileSync(bcTenantPath, "utf8")) as Record<string, unknown>;
  const file = join(mkdtempSync(join(tmpdir(), "tenant-")), "tenant.json");
  writeFileSync(file, JSON.stringify({ ...bc, ...patch }));
  return file;
}

export async function closeHandle(h: { closeBeforeServer: Closer[]; closers: Closer[] }): Promise<void> {
  await Promise.all([...h.closeBeforeServer, ...h.closers].map((c) => c.close()));
}

export async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Polls pg_stat_activity until some backend in this database is actually blocked waiting on a
 * lock. Used instead of an arbitrary sleep so the race test's interleaving — issue the
 * importer's write while a row lock is held, then release it — is guaranteed to occur, not
 * just likely to occur within some fixed delay. `query` in pg_stat_activity holds a
 * parameterized statement's placeholders, not its bound values, so this deliberately doesn't
 * try to match the query text — on this throwaway, single-use test database, any backend
 * blocked on a lock at this moment is the one the test is waiting for.
 */
export async function waitUntilBlockedOnLock(pool: pg.Pool, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()");
    if (rows.length > 0) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for a backend to block on a lock");
    await new Promise((r) => setTimeout(r, 10));
  }
}

let seq = 0;
export function envelope(source: "core" | "nrms", type: string, aggregateId: string, data: unknown) {
  return {
    id: randomUUID(),
    type,
    version: 1,
    source,
    aggregateId,
    sequence: ++seq,
    occurredAt: new Date().toISOString(),
    correlationId: randomUUID(),
    data,
  };
}

export async function sendEvent(app: express.Express, event: ReturnType<typeof envelope>) {
  const body = JSON.stringify(event);
  const ts = new Date().toISOString();
  const res = await request(app)
    .post("/events")
    .set("content-type", "application/json")
    .set("x-event-source", event.source)
    .set("x-event-timestamp", ts)
    .set("x-signature", signPayload(EVENT_SECRETS[event.source], ts, body))
    .send(body);
  if (res.status !== 200) throw new Error(`event ${event.type} rejected: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { outcome: string };
}
