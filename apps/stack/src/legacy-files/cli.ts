// `npm run legacy-files:copy -- [options]` (bundled for servers as tools/legacy-files-copy.mjs):
// imports the legacy news.gov.bc.ca/files/<name> files — the legacy Hub's Website > Files uploads —
// as NRMS site files, so they show in the Hub's Website > Files list and are served at
// /files/<name>. Writes NRMS's database (NRMS_DATABASE_URL) and object store (NRMS_STORAGE_DIR,
// else <DATA_DIR>/storage, as the stack resolves it).
//
// Discovery: LEGACY_FILES_SAS_URL (a read+list SAS for the legacy `files` container; a secret,
// never printed) lists the whole container. Without it, the links in our content (the databases
// named by NEWSAPI_/NRMS_/CORE_DATABASE_URL, read-only) plus --paths-file/--scan-file are fetched
// through the public front door. See docs/parity/url-cutover-runbook.md ("Legacy /files") and
// docs/deploy/siteground.md / windows.md ("Legacy /files import").
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createDb } from "@gcpe/db-kit";
import { localStore } from "@gcpe/storage";
import { resolveDataDir } from "../data-dir";
import { createLegacyFilesClient, runLegacyFilesCopy, type LegacyFilesClient } from "./copy";
import { parseLegacyFilesArgs, parseSasUrl } from "./options";
import { KNOWN_LEGACY_FILES, mergeExtracted, parsePathsFile, type Extracted } from "./references";
import { extractFromFileText, scanDatabase, SCAN_TABLES, type ScanSource } from "./sources";
import { nrmsSiteFilesTarget } from "./target";

let exitCode = 0;
let client: LegacyFilesClient | null = null;
try {
  const options = parseLegacyFilesArgs(process.argv.slice(2));
  const sasRaw = process.env.LEGACY_FILES_SAS_URL;
  const sas = sasRaw ? parseSasUrl(sasRaw) : null;
  if (sas && (options.pathsFiles.length > 0 || options.scanFiles.length > 0)) throw new Error("--paths-file and --scan-file are for runs without LEGACY_FILES_SAS_URL: the container listing already names every file");
  const nrmsUrl = process.env.NRMS_DATABASE_URL;
  if (!nrmsUrl) throw new Error("NRMS_DATABASE_URL is required: the files are imported as NRMS site files");
  const dataDir = resolveDataDir(process.env);
  // As the stack resolves it (env.ts envFor): NRMS_STORAGE_DIR as given, else <DATA_DIR>/storage.
  const storageDir = process.env.NRMS_STORAGE_DIR ? resolve(process.env.NRMS_STORAGE_DIR) : join(dataDir, "storage");
  const maxBytes = options.maxFileMb * 1024 * 1024;

  client = createLegacyFilesClient({ source: sas ? { kind: "sas", containerUrl: sas } : { kind: "front-door", origin: options.origin }, concurrency: options.concurrency, maxRequests: options.maxRequests, maxBytes });
  const sources: Record<string, unknown> = {};
  let rejected: Extracted["rejected"] = [];
  let listed: Awaited<ReturnType<LegacyFilesClient["list"]>> | undefined;
  let paths: string[] | undefined;

  if (sas) {
    console.log("[legacy-files] listing the legacy files container (LEGACY_FILES_SAS_URL) …");
    listed = await client.list();
    sources.listing = listed.length;
  } else {
    const parts: Extracted[] = [{ paths: [...KNOWN_LEGACY_FILES], rejected: [] }];
    sources.known = KNOWN_LEGACY_FILES.length;
    if (options.db) {
      for (const source of Object.keys(SCAN_TABLES) as ScanSource[]) {
        const url = process.env[`${source}_DATABASE_URL`];
        if (!url) continue;
        const conn = createDb(url, { max: 1 });
        try {
          const r = await scanDatabase(conn.pool, SCAN_TABLES[source]);
          parts.push(r.extracted);
          sources[source] = { paths: r.extracted.paths.length, rows: r.rows };
        } finally {
          await conn.pool.end();
        }
      }
    }
    for (const f of options.pathsFiles) {
      const r = parsePathsFile(await readFile(f, "utf8"));
      parts.push(r);
      sources[`paths-file ${f}`] = r.paths.length;
    }
    for (const f of options.scanFiles) {
      const r = extractFromFileText(await readFile(f, "utf8"));
      parts.push(r);
      sources[`scan-file ${f}`] = r.paths.length;
    }
    const all = mergeExtracted(parts);
    paths = all.paths;
    rejected = all.rejected;
  }

  const conn = createDb(nrmsUrl, { max: 2 });
  try {
    const target = nrmsSiteFilesTarget(conn.db, localStore(storageDir));
    console.log(`[legacy-files] importing into NRMS site files (store ${storageDir}) from ${sas ? "the container listing" : options.origin}${options.dryRun ? " (dry run: no file is downloaded or written)" : ""}`);
    const report = await runLegacyFilesCopy({ client, target }, { listed, paths, dryRun: options.dryRun, refresh: options.refresh, concurrency: options.concurrency, maxBytes }, { log: console.log });
    console.log(client.redact(JSON.stringify({ ...report, storageDir, origin: sas ? "(LEGACY_FILES_SAS_URL)" : options.origin, sources, rejected }, null, 2)));
    if (report.stopped === "rate-limited") {
      exitCode = 1;
      console.error(`[legacy-files] ${report.resume}`);
    } else if (report.resume) console.log(`[legacy-files] ${report.resume}`);
    if (report.failed.length > 0) exitCode = 1;
  } finally {
    await conn.pool.end();
  }
} catch (e) {
  exitCode = 1;
  const message = e instanceof Error ? e.message : String(e);
  console.error(`[legacy-files] failed: ${client ? client.redact(message) : message.replace(/([?&]sig=)[^&\s"']*/gi, "$1<redacted>")}`);
}
process.exitCode = exitCode;
