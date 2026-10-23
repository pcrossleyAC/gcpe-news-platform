import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";
import { backupScript, BOXS_APPS, DROP_MINE_SQL, DUMP_FILTER_SED, localDump, PRELUDE, restoreScript, testAccountsScript, tickScript, unsafeDumpLine } from "../../scripts/lib/scrub/boxs";

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

  it("refuses a from/siteOutput outside the union and a times that isn't a positive whole number", () => {
    expect(() => restoreScript({ stamp: "20261022-120000", from: "backups; rm" as never, apps: ["core"], resetNodPositions: false, siteOutput: "clear" })).toThrow();
    expect(() => restoreScript({ stamp: "20261022-120000", from: "scrub-load", apps: ["core"], resetNodPositions: false, siteOutput: "wipe" as never })).toThrow();
    expect(() => tickScript("https://boxs.ca", Number.NaN)).toThrow();
    expect(() => tickScript("https://boxs.ca", Number.POSITIVE_INFINITY)).toThrow();
    expect(() => tickScript("https://boxs.ca", 0)).toThrow();
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

describe("fix round 1: restore safety and secret handling", () => {
  const MIG = join(resolve(import.meta.dirname, "..", ".."), "apps", "core", "migrations");
  let src: TestDatabase; // the "new" data a dump is taken from
  let target: TestDatabase; // the restore target, starts with "old" data

  beforeAll(async () => { [src, target] = await Promise.all([createTestDatabase({ migrationsFolder: MIG }), createTestDatabase({ migrationsFolder: MIG })]); });
  afterAll(async () => { await Promise.all([src?.drop(), target?.drop()]); });

  const q = async (url: string, text: string) => { const c = new pg.Client({ connectionString: url }); await c.connect(); try { return (await c.query(text)).rows; } finally { await c.end(); } };
  const emails = async (url: string) => (await q(url, "SELECT email FROM users ORDER BY email")).map((r: { email: string }) => r.email);

  beforeEach(async () => {
    await q(src.url, "DELETE FROM users");
    await q(target.url, "DELETE FROM users");
    await q(src.url, "INSERT INTO users (email, display_name) VALUES ('new.alex@example.test', 'New Alex')");
    await q(target.url, "INSERT INTO users (email, display_name) VALUES ('old.alex@example.test', 'Old Alex')");
  });

  function fakeHome(): string {
    const dir = mkdtempSync(join(tmpdir(), "scrub-home-"));
    mkdirSync(join(dir, "www", "boxs.ca", "public_html", ".nodeapp"), { recursive: true });
    mkdirSync(join(dir, "gcpe-data", "site-output"), { recursive: true });
    writeFileSync(join(dir, "gcpe-data", "site-output", "index.html"), "placeholder");
    return dir;
  }
  const envFile = (home: string) => join(home, "www", "boxs.ca", "public_html", ".nodeapp", ".env-local");
  const runBash = (script: string, home: string) => spawnSync("bash", ["-c", script], { env: { ...process.env, HOME: home } });
  const realDump = (url: string) => spawnSync("pg_dump", ["--format=plain", "--no-owner", "--no-acl", `--dbname=${url}`], { encoding: "utf8" }).stdout;

  it("url_of extracts the right value even when other lines would break sourcing", () => {
    const home = fakeHome();
    writeFileSync(envFile(home), ["TRICKY=x(y", "SPACED=has a space in it", `CORE_DATABASE_URL=${target.url}`, ""].join("\n"));
    const r = runBash([PRELUDE, 'url_of SPACED', 'printf "|"', 'url_of CORE_DATABASE_URL'].join("\n"), home);
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toBe(`has a space in it|${target.url}`);
  });

  it("pg_url_noauth splits a URL's password into PGPASSWORD, not into the URL argument", () => {
    const home = fakeHome();
    writeFileSync(envFile(home), "X=1\n");
    const r = runBash([PRELUDE, 'pg_url_noauth "postgres://alice:p(a)ss@host:5432/db?sslmode=require"', 'printf "%s|%s" "$PGURL_NOAUTH" "$PGPASSWORD"'].join("\n"), home);
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toBe("postgres://alice@host:5432/db?sslmode=require|p(a)ss");
  });

  it("a truncated .gz fails gzip's own check and leaves the old row", async () => {
    const home = fakeHome();
    writeFileSync(envFile(home), `CORE_DATABASE_URL=${target.url}\n`);
    const stamp = "20261022-130001";
    const dir = join(home, "gcpe-data", "scrub-load", stamp);
    mkdirSync(dir, { recursive: true });
    const good = gzipSync(Buffer.from(realDump(src.url)));
    writeFileSync(join(dir, "core.sql.gz"), good.subarray(0, Math.floor(good.length / 2)));
    const r = runBash(restoreScript({ stamp, from: "scrub-load", apps: ["core"], resetNodPositions: false, siteOutput: "clear" }), home);
    expect(r.status).not.toBe(0);
    expect(r.stderr.toString()).toMatch(/not a valid gzip/);
    expect(await emails(target.url)).toEqual(["old.alex@example.test"]);
  });

  it("a well-formed gzip of a cut-off dump fails the completion check and leaves the old row", async () => {
    const home = fakeHome();
    writeFileSync(envFile(home), `CORE_DATABASE_URL=${target.url}\n`);
    const stamp = "20261022-130002";
    const dir = join(home, "gcpe-data", "scrub-load", stamp);
    mkdirSync(dir, { recursive: true });
    const dump = realDump(src.url);
    const cutoff = dump.slice(0, dump.length - 200);
    writeFileSync(join(dir, "core.sql.gz"), gzipSync(Buffer.from(cutoff)));
    const r = runBash(restoreScript({ stamp, from: "scrub-load", apps: ["core"], resetNodPositions: false, siteOutput: "clear" }), home);
    expect(r.status).not.toBe(0);
    expect(r.stderr.toString()).toMatch(/dump-complete marker/);
    expect(await emails(target.url)).toEqual(["old.alex@example.test"]);
  });

  it("an empty but well-formed gzip fails the completion check and leaves the old row", async () => {
    const home = fakeHome();
    writeFileSync(envFile(home), `CORE_DATABASE_URL=${target.url}\n`);
    const stamp = "20261022-130003";
    const dir = join(home, "gcpe-data", "scrub-load", stamp);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "core.sql.gz"), gzipSync(Buffer.alloc(0)));
    const r = runBash(restoreScript({ stamp, from: "scrub-load", apps: ["core"], resetNodPositions: false, siteOutput: "clear" }), home);
    expect(r.status).not.toBe(0);
    expect(r.stderr.toString()).toMatch(/dump-complete marker/);
    expect(await emails(target.url)).toEqual(["old.alex@example.test"]);
  });

  it("a good dump actually restores through the generated script", async () => {
    const home = fakeHome();
    writeFileSync(envFile(home), `CORE_DATABASE_URL=${target.url}\n`);
    const stamp = "20261022-130004";
    const dir = join(home, "gcpe-data", "scrub-load", stamp);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "core.sql.gz"), gzipSync(Buffer.from(realDump(src.url))));
    const r = runBash(restoreScript({ stamp, from: "scrub-load", apps: ["core"], resetNodPositions: false, siteOutput: "clear" }), home);
    expect(r.status).toBe(0);
    expect(await emails(target.url)).toEqual(["new.alex@example.test"]);
  });

  it("a missing second app's file fails validation before the first app is touched", async () => {
    const home = fakeHome();
    writeFileSync(envFile(home), [`CORE_DATABASE_URL=${target.url}`, "NRMS_DATABASE_URL=postgres://localhost:5432/does-not-matter"].join("\n"));
    const stamp = "20261022-130005";
    const dir = join(home, "gcpe-data", "scrub-load", stamp);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "core.sql.gz"), gzipSync(Buffer.from(realDump(src.url))));
    // nrms.sql.gz is deliberately never written.
    const r = runBash(restoreScript({ stamp, from: "scrub-load", apps: ["core", "nrms"], resetNodPositions: false, siteOutput: "clear" }), home);
    expect(r.status).not.toBe(0);
    expect(r.stderr.toString()).toMatch(/missing nrms\.sql\.gz/);
    expect(await emails(target.url)).toEqual(["old.alex@example.test"]);
  });

  it("a missing *_DATABASE_URL makes the backup fail before any file is written", () => {
    const home = fakeHome();
    // CORE_DATABASE_URL (first in BOXS_APPS) is deliberately left unset.
    writeFileSync(envFile(home), "NRMS_DATABASE_URL=postgres://localhost:5432/scrub_test_target\n");
    const stamp = "20261022-130006";
    const r = runBash(backupScript(stamp), home);
    expect(r.status).not.toBe(0);
    expect(existsSync(join(home, "gcpe-data", "backups", stamp, "core.sql.gz"))).toBe(false);
  });

  it("a backup without its COMPLETE marker is refused; the same backup with it restores", async () => {
    const home = fakeHome();
    writeFileSync(envFile(home), `${BOXS_APPS.map((a) => `${a.envVar}=${src.url}`).join("\n")}\n`);
    const stamp = "20261022-130007";
    const b = runBash(backupScript(stamp), home);
    expect(b.status).toBe(0);
    const dir = join(home, "gcpe-data", "backups", stamp);
    expect(existsSync(join(dir, "COMPLETE"))).toBe(true);

    writeFileSync(envFile(home), `CORE_DATABASE_URL=${target.url}\n`);
    const complete = join(dir, "COMPLETE");
    const moved = `${complete}.away`;
    spawnSync("mv", [complete, moved]);
    const noMarker = runBash(restoreScript({ stamp, from: "backups", apps: ["core"], resetNodPositions: false, siteOutput: "clear" }), home);
    expect(noMarker.status).not.toBe(0);
    expect(noMarker.stderr.toString()).toMatch(/COMPLETE marker/);
    expect(await emails(target.url)).toEqual(["old.alex@example.test"]);

    spawnSync("mv", [moved, complete]);
    const withMarker = runBash(restoreScript({ stamp, from: "backups", apps: ["core"], resetNodPositions: false, siteOutput: "clear" }), home);
    expect(withMarker.status).toBe(0);
    expect(await emails(target.url)).toEqual(["new.alex@example.test"]);
  });
});

describe("fix round 1: localDump", () => {
  const MIG = join(resolve(import.meta.dirname, "..", ".."), "apps", "core", "migrations");
  let clean: TestDatabase;
  let withExtension: TestDatabase;
  beforeAll(async () => {
    [clean, withExtension] = await Promise.all([createTestDatabase({ migrationsFolder: MIG }), createTestDatabase({ migrationsFolder: MIG })]);
    const c = new pg.Client({ connectionString: withExtension.url });
    await c.connect();
    try { await c.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"'); } finally { await c.end(); }
  });
  afterAll(async () => { await Promise.all([clean?.drop(), withExtension?.drop()]); });

  it("refuses a dump holding an extension it can't restore, leaving no partial file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scrub-localdump-"));
    const out = join(dir, "core.sql.gz");
    await expect(localDump(withExtension.url, out)).rejects.toThrow(/extension/);
    expect(existsSync(out)).toBe(false);
  });

  it("dumps a clean database to a valid, complete gzip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scrub-localdump-"));
    const out = join(dir, "core.sql.gz");
    await localDump(clean.url, out);
    const r = spawnSync("bash", ["-c", `gunzip -c "${out}" | tail -n 5 | grep -qF -- '-- PostgreSQL database dump complete'`]);
    expect(r.status).toBe(0);
  });
});
