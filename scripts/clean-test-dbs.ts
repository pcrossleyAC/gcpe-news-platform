/**
 * `npm run test:clean-dbs [-- --confirm] [-- --min-age-minutes=N]`: drops the databases and roles
 * test runs left behind (a killed run never reaches its own drop), on TEST_DATABASE_ADMIN_URL's
 * server (default postgres://localhost:5432/postgres). Only the names the harness creates:
 * test_<20 hex> (createTestDatabase), test_nr_<16 hex> and its role nr_<16 hex> (the News API's
 * restricted test database). A database with any session, or younger than the minimum age
 * (default 60 minutes: another checkout's suite may be between connections), is skipped. Dry run
 * by default; --confirm to drop. Plain DROP, never FORCE: Postgres itself refuses a database
 * someone connected to in the meantime.
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { safeErrorLabel } from "@gcpe/http-kit";
import { withAdmin } from "@gcpe/db-kit";

const HARNESS_DATABASES = [/^test_[0-9a-f]{20}$/, /^test_nr_[0-9a-f]{16}$/];
const HARNESS_ROLE = /^nr_[0-9a-f]{16}$/;
const DEFAULT_MIN_AGE_MINUTES = 60;

export const isHarnessDatabase = (name: string): boolean => HARNESS_DATABASES.some((re) => re.test(name));
export const isHarnessRole = (name: string): boolean => HARNESS_ROLE.test(name);

export interface Outcome {
  name: string;
  outcome: "dropped" | "would drop" | "skipped";
  reason?: string;
}
export interface CleanResult {
  databases: Outcome[];
  roles: Outcome[];
}
export interface CleanOptions {
  confirm: boolean;
  minAgeMinutes?: number;
  /** Narrows the run further (tests use it to stay off other suites' databases). Never widens it. */
  only?: (name: string) => boolean;
}

const codeOf = (e: unknown): unknown => (typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined);

export async function cleanTestDbs(opts: CleanOptions): Promise<CleanResult> {
  const minAge = opts.minAgeMinutes ?? DEFAULT_MIN_AGE_MINUTES;
  const only = opts.only ?? (() => true);
  return withAdmin(async (c) => {
    const databases: Outcome[] = [];
    const names = (await c.query<{ datname: string }>("SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname")).rows
      .map((r) => r.datname)
      .filter((n) => isHarnessDatabase(n) && only(n));
    for (const name of names) {
      const { rows } = await c.query<{ sessions: number; age: number }>(
        `SELECT (SELECT count(*)::int FROM pg_stat_activity WHERE datname = $1) AS sessions,
                extract(epoch FROM now() - (pg_stat_file('base/' || oid || '/PG_VERSION')).modification)::float8 / 60 AS age
           FROM pg_database WHERE datname = $1`,
        [name],
      );
      const row = rows[0];
      if (!row) continue;
      if (row.sessions > 0) databases.push({ name, outcome: "skipped", reason: "in use" });
      else if (minAge > 0 && row.age < minAge) databases.push({ name, outcome: "skipped", reason: `created less than ${minAge} minutes ago` });
      else if (!opts.confirm) databases.push({ name, outcome: "would drop" });
      else {
        try {
          // `name` matched a harness pattern above: only [a-z0-9_], safe to quote.
          await c.query(`DROP DATABASE "${name}"`);
          databases.push({ name, outcome: "dropped" });
        } catch (e) {
          databases.push({ name, outcome: "skipped", reason: codeOf(e) === "55006" ? "in use" : safeErrorLabel(e) });
        }
      }
    }

    // A role is only ever dropped in the very same run that just dropped (or, in a dry run,
    // would drop) its own twin database — never on its own, however long it has had no twin.
    // Otherwise a role created a moment before its database (createRestrictedNewsTestDb does
    // `CREATE ROLE` first) looks exactly like a genuinely orphaned one to a run that lands in
    // that gap, and would be dropped out from under the database creation still in flight.
    const handledDbNames = new Set(databases.filter((d) => d.outcome === "dropped" || d.outcome === "would drop").map((d) => d.name));

    const roles: Outcome[] = [];
    const roleNames = (await c.query<{ rolname: string }>("SELECT rolname FROM pg_roles ORDER BY rolname")).rows
      .map((r) => r.rolname)
      .filter((n) => isHarnessRole(n) && only(n));
    for (const name of roleNames) {
      const twinName = `test_${name}`;
      const twinHandledThisRun = handledDbNames.has(twinName);
      const twinScanned = databases.some((d) => d.name === twinName);
      const sessions = await c.query("SELECT 1 FROM pg_stat_activity WHERE usename = $1", [name]);
      if (!twinHandledThisRun && twinScanned) roles.push({ name, outcome: "skipped", reason: "its database still exists" });
      else if (!twinHandledThisRun) roles.push({ name, outcome: "skipped", reason: "no database was dropped alongside it this run" });
      else if ((sessions.rowCount ?? 0) > 0) roles.push({ name, outcome: "skipped", reason: "in use" });
      else if (!opts.confirm) roles.push({ name, outcome: "would drop" });
      else {
        try {
          await c.query(`DROP ROLE "${name}"`);
          roles.push({ name, outcome: "dropped" });
        } catch (e) {
          roles.push({ name, outcome: "skipped", reason: codeOf(e) === "2BP01" ? "still owns objects" : safeErrorLabel(e) });
        }
      }
    }
    return { databases, roles };
  });
}

function minAgeArg(argv: string[]): number | undefined {
  const arg = argv.find((a) => a.startsWith("--min-age-minutes="));
  if (!arg) return undefined;
  const n = Number(arg.slice("--min-age-minutes=".length));
  if (!Number.isInteger(n) || n < 0) throw new Error("--min-age-minutes takes a whole number of minutes");
  return n;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const confirm = argv.includes("--confirm");
  let minAgeMinutes: number | undefined;
  try {
    minAgeMinutes = minAgeArg(argv);
  } catch (e) {
    // The script's own argument-parsing text, not a database error: it never carries a bound
    // value, so printing it directly (not safeErrorLabel, which would flatten it to "Error") is
    // safe and is the only way the caller finds out what was actually wrong.
    console.error(e instanceof Error ? e.message : "invalid --min-age-minutes");
    process.exitCode = 1;
    return;
  }
  const r = await cleanTestDbs({ confirm, minAgeMinutes });
  for (const [kind, list] of [["database", r.databases], ["role", r.roles]] as const) {
    for (const o of list) console.log(`${o.outcome.padEnd(10)} ${kind} ${o.name}${o.reason ? ` (${o.reason})` : ""}`);
  }
  const all = [...r.databases, ...r.roles];
  if (all.length === 0) console.log("No leftover test databases or roles.");
  else if (!confirm && all.some((o) => o.outcome === "would drop")) console.log("Dry run: nothing dropped. Re-run with --confirm to drop.");
}

if (pathToFileURL(realpathSync(process.argv[1]!)).href === import.meta.url) {
  main().catch((e) => {
    console.error(safeErrorLabel(e));
    process.exitCode = 1;
  });
}
