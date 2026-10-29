// `npm --workspace @gcpe/nrms run import:public-slides -- [options]` — copies news.gov.bc.ca's
// CURRENT home-page carousel (api.news.gov.bc.ca, one request) into NRMS's carousel and publishes
// it the way the Hub does, for test hosts such as boxs.ca. See docs/deploy/siteground.md,
// "Seeding boxs.ca with news.gov's carousel". `--remove` undoes it. Never sends email.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { localStore } from "@gcpe/storage";
import { fetchPublicSlides, runPublicSlides } from "./public-slides";
import { bareEnvWarnings, filesBaseFromEnv, parsePublicSlidesArgs, storageDirFromEnv, subscribersFromEnv } from "./public-slides-options";
import type { SlideImageFiles } from "../website/slide-images";

/** NRMS's migrations: beside the source in a checkout, or `migrations/nrms` beside the bundled tool in the SiteGround artifact. */
function migrationsFolder(): string | null {
  for (const rel of ["../../migrations/", "../migrations/nrms/"]) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(`${dir}/meta/_journal.json`)) return dir;
  }
  return null;
}

let exitCode = 0;
try {
  const options = parsePublicSlidesArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url && (!options.dryRun || options.remove)) throw new Error("DATABASE_URL is required (NRMS's database), except for an import --dry-run");
  const writing = !options.dryRun;
  let files: SlideImageFiles | null = null;
  if (url) {
    for (const w of bareEnvWarnings(process.env)) console.error(`[import:public-slides] warning: ${w}`);
    const storageDir = storageDirFromEnv(process.env);
    const filesBase = filesBaseFromEnv(process.env);
    if (writing) {
      if (!existsSync(storageDir)) throw new Error(`NRMS's file store ${storageDir} does not exist: set NRMS_STORAGE_DIR (or DATA_DIR) to what the running stack uses`);
      if (filesBase === null) throw new Error("set SITE_PUBLIC_SITE_URL (e.g. https://boxs.ca) or NRMS_PUBLIC_FILES_BASE, as the running stack has it, so slide image URLs match the Hub's");
    }
    files = { store: localStore(storageDir, "/files/"), filesBase: filesBase ?? "" };
    console.error(`[import:public-slides] file store ${storageDir}, image URLs under ${filesBase ?? "(unset)"}/files/`);
  }
  const conn = url ? createDb(url) : null;
  try {
    if (conn && writing) {
      const folder = migrationsFolder();
      if (!folder) throw new Error("the NRMS migrations folder was not found beside this tool");
      await runMigrations(conn.db, folder);
    }
    const report = await runPublicSlides(
      { db: conn?.db ?? null, fetchSlides: () => fetchPublicSlides(options.from), subscribers: subscribersFromEnv(process.env), files },
      options,
    );
    console.log(JSON.stringify(report, null, 2));
    if (report.failed) {
      exitCode = 1;
      console.error(`[import:public-slides] not done: ${report.write?.reason ?? report.remove?.reason ?? "no importable slides"}`);
    }
  } finally {
    await conn?.pool.end();
  }
} catch (e) {
  exitCode = 1;
  console.error(`[import:public-slides] failed: ${e instanceof Error ? e.message : String(e)}`);
}
process.exitCode = exitCode;
