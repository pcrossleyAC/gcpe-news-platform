import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { createDb, runMigrations } from "./db";
import { adminUrl, withAdmin } from "./test-db";

const migrationsFolder = new URL("../test/migrations", import.meta.url).pathname;

describe("runMigrations", () => {
  const name = `migrate_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  let url: string;
  beforeAll(async () => {
    await withAdmin((c) => c.query(`CREATE DATABASE "${name}"`));
    const u = new URL(adminUrl());
    u.pathname = `/${name}`;
    url = u.toString();
  });
  afterAll(async () => {
    await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
  });

  it("concurrent runs against a fresh database (replicas booting together) both succeed and apply once", async () => {
    const replicas = Array.from({ length: 4 }, () => createDb(url, { max: 2 }));
    try {
      const results = await Promise.allSettled(replicas.map((r) => runMigrations(r.db, migrationsFolder)));
      expect(results.map((r) => (r.status === "rejected" ? String(r.reason) : "ok"))).toEqual(["ok", "ok", "ok", "ok"]);
    } finally {
      await Promise.all(replicas.map((r) => r.pool.end()));
    }
    const check = new pg.Client({ connectionString: url });
    await check.connect();
    try {
      expect((await check.query("SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations")).rows[0].n).toBe(1);
      expect((await check.query("SELECT to_regclass('widgets') IS NOT NULL AS ok")).rows[0].ok).toBe(true);
      // The migration lock is released afterwards.
      expect((await check.query("SELECT count(*)::int AS n FROM pg_locks l JOIN pg_database d ON d.oid = l.database WHERE l.locktype = 'advisory' AND d.datname = current_database()")).rows[0].n).toBe(0);
    } finally {
      await check.end();
    }
  });

  it("works with a pool of one connection", async () => {
    const { db, pool } = createDb(url, { max: 1 });
    try {
      await runMigrations(db, migrationsFolder);
      expect((await pool.query("SELECT 1 AS one")).rows[0].one).toBe(1);
    } finally {
      await pool.end();
    }
  });
});

describe("createDb", () => {
  it("logs errors from idle pooled connections instead of crashing the process", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { pool } = createDb(adminUrl(), { max: 1 });
    try {
      const { rows } = await pool.query("SELECT pg_backend_pid() AS pid");
      // The connection is now idle in the pool; kill its backend from another session.
      await withAdmin((c) => c.query("SELECT pg_terminate_backend($1)", [rows[0].pid]));
      await vi.waitFor(() => expect(errSpy).toHaveBeenCalledWith("[db] idle client error", expect.any(Error)), { timeout: 5_000 });
    } finally {
      await pool.end();
      errSpy.mockRestore();
    }
  });
});
