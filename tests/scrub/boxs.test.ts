import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";
import { backupScript, BOXS_APPS, DROP_MINE_SQL, DUMP_FILTER_SED, restoreScript, testAccountsScript, tickScript, unsafeDumpLine } from "../../scripts/lib/scrub/boxs";

describe("remote scripts", () => {
  const scripts = [testAccountsScript(), backupScript("20261022-120000"), restoreScript({ stamp: "20261022-120000", from: "scrub-load", apps: ["core", "nrms"], resetNodPositions: true, siteOutput: "clear" }), tickScript("https://boxs.ca", 3)];

  it("fail fast, stay private and never trace or dump settings", () => {
    for (const s of scripts) {
      expect(s).toMatch(/^set -euo pipefail\numask 077\n/);
      expect(s).not.toMatch(/set -x|printenv|^env$|echo "\$u"|cat "\$ENV_FILE"/m);
    }
  });

  it("refuses bad stamps, apps and sites", () => {
    expect(() => backupScript("2026; rm -rf ~")).toThrow();
    expect(() => restoreScript({ stamp: "20261022-120000", from: "scrub-load", apps: ["core; id"], resetNodPositions: false, siteOutput: "clear" })).toThrow();
    expect(() => tickScript("https://boxs.ca/$(id)", 1)).toThrow();
  });

  it("backs up all seven databases and restores only the ones asked for", () => {
    const b = backupScript("20261022-120000");
    for (const a of BOXS_APPS) expect(b).toContain(`${a.app}:${a.envVar}`);
    const r = restoreScript({ stamp: "20261022-120000", from: "scrub-load", apps: ["core"], resetNodPositions: true, siteOutput: "clear" });
    expect(r).toContain("restore_one core CORE_DATABASE_URL");
    expect(r).not.toContain("restore_one nod");
    expect(r).toContain("DELETE FROM inbox_positions WHERE source IN ('core', 'nrms')");
  });

  it("flags dump lines it can't restore on boxs.ca", () => {
    expect(unsafeDumpLine("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;")).toMatch(/extension/);
    expect(unsafeDumpLine("\\connect other")).toMatch(/connect/);
    expect(unsafeDumpLine("CREATE TABLE public.users (")).toBeNull();
  });
});

describe("drop-mine restore on local Postgres", () => {
  const MIG = join(resolve(import.meta.dirname, "..", ".."), "apps", "core", "migrations");
  let a: TestDatabase, b: TestDatabase;
  beforeAll(async () => { [a, b] = await Promise.all([createTestDatabase({ migrationsFolder: MIG }), createTestDatabase({ migrationsFolder: MIG })]); });
  afterAll(async () => { await Promise.all([a?.drop(), b?.drop()]); });
  const run = async (url: string, text: string) => { const c = new pg.Client({ connectionString: url }); await c.connect(); try { return (await c.query(text)).rows; } finally { await c.end(); } };
  const restore = (dump: string, extra = "") => {
    const dir = mkdtempSync(join(tmpdir(), "scrub-restore-"));
    writeFileSync(join(dir, "drop.sql"), DROP_MINE_SQL);
    writeFileSync(join(dir, "dump.sql"), dump + extra);
    return spawnSync("bash", ["-c", `set -o pipefail; { cat drop.sql; sed ${DUMP_FILTER_SED.map((x) => `'${x}'`).join(" ")} dump.sql; } | psql "$U" -X -q -v ON_ERROR_STOP=1 --single-transaction -f - >/dev/null`], { cwd: dir, env: { ...process.env, U: b.url } });
  };

  it("replaces every table and leaves the old data when the restore fails", async () => {
    await run(a.url, "INSERT INTO users (email, display_name) VALUES ('alex.ashfield@example.test', 'Alex Ashfield')");
    await run(b.url, "INSERT INTO users (email, display_name) VALUES ('old@example.test', 'Old Row')");
    const dump = spawnSync("pg_dump", ["--format=plain", "--no-owner", "--no-acl", `--dbname=${a.url}`], { encoding: "utf8" }).stdout;
    expect(restore(dump, "\nSELECT 1/0;\n").status).not.toBe(0);
    expect((await run(b.url, "SELECT email FROM users")).map((r) => r.email)).toEqual(["old@example.test"]);
    expect(restore(dump).status).toBe(0);
    expect((await run(b.url, "SELECT email FROM users")).map((r) => r.email)).toEqual(["alex.ashfield@example.test"]);
    expect((await run(b.url, "SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name IN ('public', 'information_schema', 'drizzle')"))[0].n).toBe(3);
  });
});
