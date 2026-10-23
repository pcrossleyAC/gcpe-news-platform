import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import pg from "pg";
import { z } from "zod";
import { adminUrl, withAdmin } from "@gcpe/db-kit";
import { SCRUB_DB, type MssqlConfig } from "./mssql";
import { ScrubArgumentError } from "./private-out";

const REPO = resolve(import.meta.dirname, "..", "..", "..");

export const LOCAL_DB_NAMES = { core: "scrub_core", nrms: "scrub_nrms", newsApi: "scrub_news_api", site: "scrub_site", calendar: "scrub_calendar", nod: "scrub_nod", distribution: "scrub_distribution" } as const;
export type LocalApp = keyof typeof LOCAL_DB_NAMES;
const LOCAL_NAME = /^scrub_[a-z_]+$/;

export function localDbUrl(name: string, admin = adminUrl()): string {
  if (!LOCAL_NAME.test(name)) throw new ScrubArgumentError("local scrub databases are named scrub_*");
  const u = new URL(admin);
  u.pathname = `/${name}`;
  return u.toString();
}

export async function recreateLocalDbs(): Promise<Record<LocalApp, string>> {
  await withAdmin(async (c) => {
    for (const name of Object.values(LOCAL_DB_NAMES)) {
      if (!LOCAL_NAME.test(name)) throw new ScrubArgumentError("local scrub databases are named scrub_*");
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.query(`CREATE DATABASE ${name}`);
    }
  });
  return Object.fromEntries(Object.entries(LOCAL_DB_NAMES).map(([k, v]) => [k, localDbUrl(v)])) as Record<LocalApp, string>;
}

export function legacyEnv(cfg: MssqlConfig, scrubbedDb: string): Record<string, string> {
  if (!SCRUB_DB.test(scrubbedDb)) throw new ScrubArgumentError("the importers may only read a *_Scrubbed database");
  if (cfg.port !== 1433) throw new ScrubArgumentError("the importers only reach SQL Server on port 1433");
  return { LEGACY_SQL_SERVER: cfg.server, LEGACY_SQL_DATABASE: scrubbedDb, LEGACY_SQL_USER: cfg.user, LEGACY_SQL_PASSWORD: cfg.password, LEGACY_SQL_TRUST_CERT: cfg.trustServerCertificate ? "true" : "false" };
}

/** A command-line subscriber: only its name and types matter; the running stack delivers by name.
 * The placeholder URL is never called by the CLI itself — the later trial step's in-process
 * stack delivers queued events to the named subscriber once it's up. */
export const PLACEHOLDER_SUBSCRIBER = (name: string, types: string[]) => ({ name, url: "https://import-cli.example.test/unused", secret: "unused-by-cli-000000000000000000000000", types });

export interface CommandStep { name: string; npmArgs: string[]; env: Record<string, string> }

export function importSteps(urls: Record<LocalApp, string>, legacy: Record<string, string>, o: { out: string; cutoff: string }): CommandStep[] {
  return [
    { name: "core", npmArgs: ["--workspace", "@gcpe/core", "run", "import:legacy"], env: { ...legacy, DATABASE_URL: urls.core } },
    { name: "nrms", npmArgs: ["run", "nrms:import", "--", "--report", join(o.out, "reports", "nrms-import.json")], env: { ...legacy, DATABASE_URL: urls.nrms, CORE_DATABASE_URL: urls.core } },
    {
      name: "calendar",
      npmArgs: ["run", "calendar:import", "--", "--cutoff", o.cutoff, "--confirm", "--report", join(o.out, "reports", "calendar-import.json")],
      env: { ...legacy, DATABASE_URL: urls.calendar, CORE_DATABASE_URL: urls.core, CALENDAR_STORAGE_DIR: join(o.out, "calendar-files"), CORE_EVENT_SUBSCRIBERS: JSON.stringify([PLACEHOLDER_SUBSCRIBER("calendar", ["user.upserted"]), PLACEHOLDER_SUBSCRIBER("nrms", ["user.upserted"])]) },
    },
    { name: "news-api", npmArgs: ["--workspace", "@gcpe/news-api", "run", "import:legacy"], env: { ...legacy, DATABASE_URL: urls.newsApi } },
  ];
}

/** Runs an npm script with its own env; its output goes to a private log, never to the terminal. */
export async function runStep(step: CommandStep, logFile: string, spawnFn: typeof spawn = spawn): Promise<number> {
  mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
  const fd = openSync(logFile, "a", 0o600);
  try {
    return await new Promise<number>((res, rej) => {
      const child = spawnFn("npm", step.npmArgs, { cwd: REPO, env: { ...process.env, ...step.env }, stdio: ["ignore", fd, fd] });
      child.on("error", rej);
      child.on("exit", (code) => res(code ?? 1));
    });
  } finally {
    closeSync(fd);
  }
}

const accountsSchema = z.object({
  users: z.array(z.object({ id: z.string().uuid(), email: z.string().nullable(), display_name: z.string(), is_active: z.boolean(), sign_in_method: z.enum(["local", "entra"]), password_hash: z.string().nullable(), entra_oid: z.string().nullable(), created_at: z.string(), updated_at: z.string() })),
  roleGrants: z.array(z.object({ user_id: z.string().uuid(), role: z.string(), granted_at: z.string() })),
  memberships: z.array(z.object({ user_id: z.string().uuid(), org_key: z.string(), org_abbreviation: z.string().nullable() })),
});
export type TestAccounts = z.infer<typeof accountsSchema>;

export function parseTestAccounts(json: string): TestAccounts {
  return accountsSchema.parse(JSON.parse(json));
}

export function signInEmails(a: TestAccounts): Set<string> {
  return new Set(a.users.map((u) => (u.email ?? "").toLowerCase()).filter((e) => e !== ""));
}

export async function seedTestAccounts(coreUrl: string, a: TestAccounts): Promise<{ users: number; grants: number; memberships: number }> {
  const client = new pg.Client({ connectionString: coreUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    for (const u of a.users) await client.query("INSERT INTO users (id, email, display_name, is_active, sign_in_method, password_hash, entra_oid, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)", [u.id, u.email, u.display_name, u.is_active, u.sign_in_method, u.password_hash, u.entra_oid, u.created_at, u.updated_at]);
    for (const g of a.roleGrants) await client.query("INSERT INTO role_grants (user_id, role, granted_at) VALUES ($1, $2, $3)", [g.user_id, g.role, g.granted_at]);
    const missing = new Set<string>();
    for (const m of a.memberships) {
      const r = await client.query("INSERT INTO user_organizations (user_id, organization_id) SELECT $1, o.id FROM organizations o WHERE o.key = $2 OR ($3::text IS NOT NULL AND o.abbreviation = $3) ORDER BY (o.key = $2) DESC LIMIT 1 ON CONFLICT DO NOTHING", [m.user_id, m.org_key, m.org_abbreviation]);
      if (r.rowCount === 0) missing.add(m.org_key);
    }
    if (missing.size > 0) throw new ScrubArgumentError(`no organisation for the test accounts' keys: ${[...missing].sort().join(", ")}`);
    await client.query("COMMIT");
    return { users: a.users.length, grants: a.roleGrants.length, memberships: a.memberships.length };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    await client.end();
  }
}
