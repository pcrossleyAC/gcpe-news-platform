import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

describe("fix round 2: a password with special characters, over real scram-sha-256 auth", () => {
  // The local admin database used everywhere else in this file runs on trust auth, which never
  // exercises PGPASSWORD at all. Proving the percent-decode fix needs a cluster that actually
  // checks a password, so one is built from scratch here, on a scratch port, and torn down
  // afterwards — never the shared local Postgres, never boxs.ca.
  const pgDataDir = mkdtempSync(join(tmpdir(), "scrub-scram-"));
  const sockDir = `/tmp/scrub-pw-test-${process.pid}`; // short path: unix socket paths have ~100 byte limit
  const pwFile = join(pgDataDir, "..", `scrub-scram-pw-${process.pid}.txt`);
  const port = 20000 + (process.pid % 10000);
  const password = "p@ss(w)rd x%z"; // @, (, ), a space and % — every character the fix must survive
  const dbUrl = `postgres://${encodeURIComponent("scrubtest")}:${encodeURIComponent(password)}@127.0.0.1:${port}/scrubtest_db`;
  let started = false;

  const pgCtl = (args: string[]) => spawnSync("pg_ctl", args, { encoding: "utf8" });

  beforeAll(() => {
    mkdirSync(sockDir, { recursive: true });
    writeFileSync(pwFile, "initpass\n");
    const init = spawnSync("initdb", ["-D", pgDataDir, "-A", "scram-sha-256", "-U", "paul", `--pwfile=${pwFile}`, "--no-sync"], { encoding: "utf8" });
    expect(init.status).toBe(0);
    const start = pgCtl(["-D", pgDataDir, "-o", `-p ${port} -k ${sockDir}`, "-l", join(pgDataDir, "..", "scrub-scram.log"), "start"]);
    expect(start.status).toBe(0);
    started = true;
    const setup = spawnSync("psql", ["-h", sockDir, "-p", String(port), "-U", "paul", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", `CREATE ROLE scrubtest LOGIN PASSWORD '${password}'`, "-c", "CREATE DATABASE scrubtest_db OWNER scrubtest"], { env: { ...process.env, PGPASSWORD: "initpass" }, encoding: "utf8" });
    expect(setup.status).toBe(0);
  });

  afterAll(() => {
    if (started) pgCtl(["-D", pgDataDir, "stop", "-m", "fast"]);
    rmSync(pgDataDir, { recursive: true, force: true });
    rmSync(sockDir, { recursive: true, force: true });
    rmSync(pwFile, { force: true });
  });

  it("pg_url_noauth decodes the password so psql actually authenticates", () => {
    const home = fakeHomeForPwTest();
    const r = spawnSync("bash", ["-c", [PRELUDE, `pg_url_noauth "${dbUrl}"`, 'psql "$PGURL_NOAUTH" -X -A -t -q -c "SELECT current_user"'].join("\n")], { env: { ...process.env, HOME: home } });
    expect(r.status).toBe(0);
    expect(r.stdout.toString().trim()).toBe("scrubtest");
  });

  it("localDump authenticates with the decoded password", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scrub-localdump-pw-"));
    const out = join(dir, "core.sql.gz");
    await localDump(dbUrl, out);
    expect(existsSync(out)).toBe(true);
  });

  function fakeHomeForPwTest(): string {
    const dir = mkdtempSync(join(tmpdir(), "scrub-home-pw-"));
    mkdirSync(join(dir, "www", "boxs.ca", "public_html", ".nodeapp"), { recursive: true });
    writeFileSync(join(dir, "www", "boxs.ca", "public_html", ".nodeapp", ".env-local"), "X=1\n");
    return dir;
  }
});

describe("fix round 2: site-output restore swaps on the same filesystem", () => {
  function fakeHome(): string {
    const dir = mkdtempSync(join(tmpdir(), "scrub-home-so-"));
    mkdirSync(join(dir, "www", "boxs.ca", "public_html", ".nodeapp"), { recursive: true });
    writeFileSync(join(dir, "www", "boxs.ca", "public_html", ".nodeapp", ".env-local"), "X=1\n");
    mkdirSync(join(dir, "gcpe-data", "site-output"), { recursive: true });
    writeFileSync(join(dir, "gcpe-data", "site-output", "old.html"), "old");
    return dir;
  }

  it("extracts to a scratch directory under gcpe-data (not the system tmp) and swaps it in", () => {
    const home = fakeHome();
    const stamp = "20261022-140001";
    const srcDir = join(home, "gcpe-data", "scrub-load", stamp);
    mkdirSync(srcDir, { recursive: true });
    const stageDir = mkdtempSync(join(tmpdir(), "scrub-siteoutput-"));
    mkdirSync(join(stageDir, "site-output"));
    writeFileSync(join(stageDir, "site-output", "new.html"), "new");
    spawnSync("tar", ["-C", stageDir, "-czf", join(srcDir, "site-output.tar.gz"), "site-output"]);

    const script = restoreScript({ stamp, from: "scrub-load", apps: [], resetNodPositions: false, siteOutput: "restore" });
    expect(script).toContain('mktemp -d "$HOME/gcpe-data/site-output-swap.XXXXXX"');
    const r = spawnSync("bash", ["-c", script], { env: { ...process.env, HOME: home } });
    expect(r.status).toBe(0);

    expect(existsSync(join(home, "gcpe-data", "site-output", "new.html"))).toBe(true);
    expect(existsSync(join(home, "gcpe-data", "site-output", "old.html"))).toBe(false);
    // The scratch swap directory cleans itself up (the script's EXIT trap), leaving nothing behind.
    expect(readdirSync(join(home, "gcpe-data")).filter((n) => n.startsWith("site-output-swap."))).toEqual([]);
  });
});

describe("post-review fix: url_of strips the quoting boxs.ca's real settings file uses", () => {
  function fakeHome(envLines: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "scrub-home-quoted-"));
    mkdirSync(join(dir, "www", "boxs.ca", "public_html", ".nodeapp"), { recursive: true });
    writeFileSync(join(dir, "www", "boxs.ca", "public_html", ".nodeapp", ".env-local"), `${envLines.join("\n")}\n`);
    return dir;
  }
  const lookup = (envLines: string[], vars: string[]) => {
    const home = fakeHome(envLines);
    const script = [PRELUDE, ...vars.map((v, i) => `printf "${i > 0 ? "|" : ""}%s" "$(url_of ${v})"`)].join("\n");
    return spawnSync("bash", ["-c", script], { env: { ...process.env, HOME: home } });
  };

  it("unwraps a single-quoted value (boxs.ca's actual shape) without sourcing the file", () => {
    const r = lookup(["CORE_DATABASE_URL='postgres://user:pass!@localhost:5432/db'"], ["CORE_DATABASE_URL"]);
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toBe("postgres://user:pass!@localhost:5432/db");
  });

  it("turns a shell-escaped embedded quote (\\'\\\\''\\') back into a plain quote", () => {
    const r = lookup([`ESCAPED='it'\\''s a secret'`], ["ESCAPED"]);
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toBe("it's a secret");
  });

  it("unwraps a double-quoted value", () => {
    const r = lookup(['DOUBLE="hello world"'], ["DOUBLE"]);
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toBe("hello world");
  });

  it("leaves an unquoted value exactly as it is", () => {
    const r = lookup(["PLAIN=plainvalue"], ["PLAIN"]);
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toBe("plainvalue");
  });

  it("handles multiple quoting styles in the same file, each looked up correctly", () => {
    const r = lookup(
      ["CORE_DATABASE_URL='postgres://user:pass!@localhost:5432/db'", `ESCAPED='it'\\''s a secret'`, 'DOUBLE="hello world"', "PLAIN=plainvalue"],
      ["CORE_DATABASE_URL", "ESCAPED", "DOUBLE", "PLAIN"],
    );
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toBe("postgres://user:pass!@localhost:5432/db|it's a secret|hello world|plainvalue");
  });
});

describe("post-review fix: a single-quoted password with ! authenticates end to end", () => {
  // Same throwaway-cluster approach as fix round 2: a scratch scram-sha-256 Postgres, on a
  // scratch port, created and torn down entirely inside this test — never the shared local
  // Postgres, never boxs.ca. This time the settings file wraps the URL in single quotes, as
  // boxs.ca's real one does, and the password holds `!`, boxs.ca's real password shape.
  const pgDataDir = mkdtempSync(join(tmpdir(), "scrub-scram-bang-"));
  const sockDir = `/tmp/scrub-pw-bang-${process.pid}`;
  const pwFile = join(pgDataDir, "..", `scrub-scram-bang-pw-${process.pid}.txt`);
  const port = 21000 + (process.pid % 10000);
  const password = "p@ss!w0rd";
  const dbUrl = `postgres://${encodeURIComponent("scrubtest")}:${encodeURIComponent(password)}@127.0.0.1:${port}/scrubtest_db`;
  let started = false;

  const pgCtl = (args: string[]) => spawnSync("pg_ctl", args, { encoding: "utf8" });

  beforeAll(() => {
    mkdirSync(sockDir, { recursive: true });
    writeFileSync(pwFile, "initpass\n");
    const init = spawnSync("initdb", ["-D", pgDataDir, "-A", "scram-sha-256", "-U", "paul", `--pwfile=${pwFile}`, "--no-sync"], { encoding: "utf8" });
    expect(init.status).toBe(0);
    const start = pgCtl(["-D", pgDataDir, "-o", `-p ${port} -k ${sockDir}`, "-l", join(pgDataDir, "..", "scrub-scram-bang.log"), "start"]);
    expect(start.status).toBe(0);
    started = true;
    const setup = spawnSync("psql", ["-h", sockDir, "-p", String(port), "-U", "paul", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", `CREATE ROLE scrubtest LOGIN PASSWORD '${password}'`, "-c", "CREATE DATABASE scrubtest_db OWNER scrubtest"], { env: { ...process.env, PGPASSWORD: "initpass" }, encoding: "utf8" });
    expect(setup.status).toBe(0);
  });

  afterAll(() => {
    if (started) pgCtl(["-D", pgDataDir, "stop", "-m", "fast"]);
    rmSync(pgDataDir, { recursive: true, force: true });
    rmSync(sockDir, { recursive: true, force: true });
    rmSync(pwFile, { force: true });
  });

  it("url_of unwraps the quoted URL, pg_url_noauth decodes the ! password, and psql authenticates", () => {
    const home = mkdtempSync(join(tmpdir(), "scrub-home-bang-"));
    mkdirSync(join(home, "www", "boxs.ca", "public_html", ".nodeapp"), { recursive: true });
    writeFileSync(join(home, "www", "boxs.ca", "public_html", ".nodeapp", ".env-local"), `CORE_DATABASE_URL='${dbUrl}'\n`);
    const script = [PRELUDE, 'u="$(url_of CORE_DATABASE_URL)"', 'pg_url_noauth "$u"', 'psql "$PGURL_NOAUTH" -X -A -t -q -c "SELECT current_user"'].join("\n");
    const r = spawnSync("bash", ["-c", script], { env: { ...process.env, HOME: home } });
    expect(r.status).toBe(0);
    expect(r.stdout.toString().trim()).toBe("scrubtest");
  });
});
