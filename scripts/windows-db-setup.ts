// Creates the stack's PostgreSQL login and its seven databases, and enables pgvector in the News
// API's, for a Windows Server deployment (docs/deploy/windows.md). deploy/windows/Install-Gcpe.ps1
// runs the bundled copy (app/scripts/windows-db-setup.js) on every install, so the server needs no
// psql: ADMIN_DATABASE_URL (a superuser) in the environment, and on stdin a JSON object
// { "user", "password", "prefix" } — the same values the env file's *_DATABASE_URLs carry.
//
// Safe to re-run: an existing login gets its password reset to the given one, an existing
// database is left as it is, and the extension is created only if it isn't there yet.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { z } from "zod";
import { parseJsonQuietly } from "./windows-json";

/** The databases the stack's env file points at, as `<prefix>_<name>` (scripts/windows-env.ts). */
export const DATABASE_NAMES = ["core", "nrms", "news_api", "site", "nod", "distribution", "calendar"] as const;

export const dbSetupInputSchema = z
  .object({
    user: z.string().regex(/^[a-z_][a-z0-9_]*$/),
    password: z.string().min(16),
    prefix: z.string().regex(/^[a-z_][a-z0-9_]*$/),
  })
  .strict();
export type DbSetupInput = z.infer<typeof dbSetupInputSchema>;

export interface DbSetupResult {
  role: "created" | "updated";
  created: string[];
  existing: string[];
  /** Whether `vector` is enabled in <prefix>_news_api: semantic search needs it (spec §5.3). */
  pgvector: boolean;
}

/** Points a database URL at another database on the same server. */
function onDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export async function setupDatabases(adminUrl: string, input: DbSetupInput): Promise<DbSetupResult> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const result: DbSetupResult = { role: "created", created: [], existing: [], pgvector: false };
  try {
    const role = admin.escapeIdentifier(input.user);
    const exists = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [input.user]);
    if (exists.rowCount) {
      await admin.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD ${admin.escapeLiteral(input.password)}`);
      result.role = "updated";
    } else {
      await admin.query(`CREATE ROLE ${role} WITH LOGIN PASSWORD ${admin.escapeLiteral(input.password)}`);
    }
    for (const name of DATABASE_NAMES) {
      const db = `${input.prefix}_${name}`;
      const found = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [db]);
      if (found.rowCount) {
        result.existing.push(db);
        continue;
      }
      await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(db)} OWNER ${role} ENCODING 'UTF8' TEMPLATE template0`);
      result.created.push(db);
    }
  } finally {
    await admin.end();
  }

  // CREATE EXTENSION needs a superuser, so it runs here rather than in the News API's own
  // migration 0005, which only enables it where the app's login is allowed to.
  const news = new pg.Client({ connectionString: onDatabase(adminUrl, `${input.prefix}_news_api`) });
  await news.connect();
  try {
    const available = await news.query("SELECT 1 FROM pg_available_extensions WHERE name = 'vector'");
    if (available.rowCount) {
      await news.query("CREATE EXTENSION IF NOT EXISTS vector");
      result.pgvector = true;
    }
  } finally {
    await news.end();
  }
  return result;
}

async function main(): Promise<void> {
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  if (!adminUrl) throw new Error("ADMIN_DATABASE_URL is not set");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const parsed = dbSetupInputSchema.safeParse(parseJsonQuietly(Buffer.concat(chunks).toString("utf8")));
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  process.stdout.write(JSON.stringify(await setupDatabases(adminUrl, parsed.data)) + "\n");
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  main().catch((e) => {
    // The message only: a pg error can quote the statement, and these carry a password.
    console.error(`windows-db-setup: ${e instanceof Error ? e.message.replace(/PASSWORD\s+'[^']*'/gi, "PASSWORD '…'") : String(e)}`);
    process.exit(1);
  });
}
