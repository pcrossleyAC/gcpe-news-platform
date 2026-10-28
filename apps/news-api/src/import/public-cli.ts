// `npm --workspace @gcpe/news-api run import:public -- [options]` — copies a slice of PUBLIC
// news.gov.bc.ca posts (api.news.gov.bc.ca) into a News API database, through the legacy
// importer's write path, for test hosts such as boxs.ca. See docs/deploy/siteground.md,
// "Seeding boxs.ca with public news.gov posts". Never emits an event or a notification.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { createPublicApiClient, RateLimitedError } from "./public-fetch";
import { parsePublicImportArgs } from "./public-options";
import { runPublicImport } from "./public-run";

/** This file's migrations: beside the source in a checkout, or `migrations/news-api` beside the bundled tool in the SiteGround artifact. */
function migrationsFolder(): string | null {
  for (const rel of ["../../migrations/", "../migrations/news-api/"]) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(`${dir}/meta/_journal.json`)) return dir;
  }
  return null;
}

let exitCode = 0;
try {
  const options = parsePublicImportArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url && (!options.dryRun || options.remove)) throw new Error("DATABASE_URL is required (the News API's database), except for an import --dry-run");
  const conn = url ? createDb(url) : null;
  try {
    if (conn && !options.dryRun) {
      const folder = migrationsFolder();
      if (!folder) throw new Error("the News API migrations folder was not found beside this tool");
      await runMigrations(conn.db, folder);
    }
    const client = createPublicApiClient({ base: options.from, log: console.log });
    const report = await runPublicImport({ db: conn?.db ?? null, client }, options, { log: console.log });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await conn?.pool.end();
  }
} catch (e) {
  exitCode = 1;
  console.error(`[import:public] ${e instanceof RateLimitedError ? "" : "failed: "}${e instanceof Error ? e.message : String(e)}`);
}
process.exitCode = exitCode;
