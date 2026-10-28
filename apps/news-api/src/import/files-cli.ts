// `npm --workspace @gcpe/news-api run import:files -- [options]` — fills in the translation and
// media-asset lists of legacy-imported posts from the public legacy News API
// (api.news.gov.bc.ca), whose files stay on Azure. Run after `import:legacy`; see
// docs/parity/url-cutover-runbook.md and docs/deploy/siteground.md, "Legacy translations and
// media assets". Never emits an event or a notification.
import { createDb } from "@gcpe/db-kit";
import { parseFilesImportArgs } from "./files-options";
import { createFilesApiClient, runFilesImport } from "./files-run";

let exitCode = 0;
try {
  const options = parseFilesImportArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required (the News API's database)");
  const conn = createDb(url);
  try {
    const client = createFilesApiClient({ base: options.from, concurrency: options.concurrency, maxRequests: options.maxRequests, log: console.log });
    const report = await runFilesImport({ db: conn.db, client }, options, { log: console.log });
    console.log(JSON.stringify(report, null, 2));
    if (report.stopped === "rate-limited") {
      exitCode = 1;
      console.error(`[import:files] ${report.resume}`);
    } else if (report.resume) console.log(`[import:files] ${report.resume}`);
  } finally {
    await conn.pool.end();
  }
} catch (e) {
  exitCode = 1;
  console.error(`[import:files] failed: ${e instanceof Error ? e.message : String(e)}`);
}
process.exitCode = exitCode;
