import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminUrl, withAdmin } from "@gcpe/db-kit";
import { cleanTestDbs, isHarnessDatabase, isHarnessRole } from "../scripts/clean-test-dbs";

const hex = (n: number) => randomBytes(n).toString("hex").slice(0, n);
const exists = (name: string) => withAdmin(async (c) => (await c.query("SELECT 1 FROM pg_database WHERE datname = $1", [name])).rowCount === 1);
const roleExists = (name: string) => withAdmin(async (c) => (await c.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [name])).rowCount === 1);

describe("isHarnessDatabase / isHarnessRole", () => {
  it("accepts only the names the harness creates", () => {
    expect(isHarnessDatabase(`test_${"a1".repeat(10)}`)).toBe(true);
    expect(isHarnessDatabase(`test_nr_${"0f".repeat(8)}`)).toBe(true);
    for (const name of [`test_${"a".repeat(19)}`, `test_${"a".repeat(21)}`, `test_${"A".repeat(20)}`, `test_nr_${"a".repeat(20)}`, `test_tzcheck_${"a".repeat(20)}`, `migrate_${"a".repeat(16)}`, "postgres", "gcpe_nrms", `x_test_${"a".repeat(20)}`, `test_${"a".repeat(20)}_keep`])
      expect(isHarnessDatabase(name), name).toBe(false);
    expect(isHarnessRole(`nr_${"9".repeat(16)}`)).toBe(true);
    for (const name of [`nr_${"9".repeat(15)}`, `nr_${"9".repeat(17)}`, `NR_${"9".repeat(16)}`, "postgres", `nr_${"g".repeat(16)}`]) expect(isHarnessRole(name), name).toBe(false);
  });
});

describe("npm run test:clean-dbs", () => {
  const idle = `test_${hex(20)}`;
  const busy = `test_${hex(20)}`;
  const decoy = `test_${hex(20)}_keep`;
  const pairId = hex(16);
  const pairDb = `test_nr_${pairId}`;
  const pairRole = `nr_${pairId}`;
  const loneRole = `nr_${hex(16)}`;
  const mine = new Set([idle, busy, decoy, pairDb, pairRole, loneRole]);
  const only = (name: string) => mine.has(name);
  let session: pg.Client;

  beforeAll(async () => {
    await withAdmin(async (c) => {
      for (const db of [idle, busy, decoy]) await c.query(`CREATE DATABASE "${db}"`);
      await c.query(`CREATE ROLE "${pairRole}" NOLOGIN`);
      await c.query(`CREATE DATABASE "${pairDb}" OWNER "${pairRole}"`);
      await c.query(`CREATE ROLE "${loneRole}" NOLOGIN`);
    });
    const url = new URL(adminUrl());
    url.pathname = `/${busy}`;
    session = new pg.Client({ connectionString: url.toString() });
    await session.connect();
  });
  afterAll(async () => {
    await session.end().catch(() => {});
    await withAdmin(async (c) => {
      for (const db of [idle, busy, decoy, pairDb]) await c.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
      for (const r of [pairRole, loneRole]) await c.query(`DROP ROLE IF EXISTS "${r}"`);
    });
  });

  it("a dry run drops nothing", async () => {
    const r = await cleanTestDbs({ confirm: false, minAgeMinutes: 0, only });
    expect(r.databases).toContainEqual({ name: idle, outcome: "would drop" });
    expect(r.databases).toContainEqual({ name: busy, outcome: "skipped", reason: "in use" });
    for (const n of [idle, busy, decoy, pairDb]) expect(await exists(n)).toBe(true);
    for (const n of [pairRole, loneRole]) expect(await roleExists(n)).toBe(true);
  });

  it("skips databases younger than the minimum age (another checkout's suite may be using them)", async () => {
    // Narrowed to the one database, so this confirmed run drops nothing the next test counts on.
    const r = await cleanTestDbs({ confirm: true, only: (n) => n === idle });
    expect(r.databases).toEqual([{ name: idle, outcome: "skipped", reason: "created less than 60 minutes ago" }]);
    expect(await exists(idle)).toBe(true);
  });

  it("--confirm drops idle harness databases and their roles, skips one in use, and never touches another name", async () => {
    const r = await cleanTestDbs({ confirm: true, minAgeMinutes: 0, only });
    expect(r.databases).toContainEqual({ name: idle, outcome: "dropped" });
    expect(r.databases).toContainEqual({ name: pairDb, outcome: "dropped" });
    expect(r.databases).toContainEqual({ name: busy, outcome: "skipped", reason: "in use" });
    expect(r.databases.map((d) => d.name)).not.toContain(decoy);
    expect(r.roles).toContainEqual({ name: pairRole, outcome: "dropped" });
    expect(r.roles).toContainEqual({ name: loneRole, outcome: "dropped" });
    expect(await exists(idle)).toBe(false);
    expect(await exists(pairDb)).toBe(false);
    expect(await exists(busy)).toBe(true);
    expect(await exists(decoy)).toBe(true);
  });
});
