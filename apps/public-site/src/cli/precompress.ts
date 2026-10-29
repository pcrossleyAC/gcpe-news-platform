// Writes the .br/.gz companions for every compressible file already in OUTPUT_DIR (a site built
// before pages were compressed when written). Idempotent and safe while the stack is serving.
// Not needed after a rebuild-all: the builder writes companions with every page. Exits 1 if any
// file failed (each is logged; the others are still done).
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseEnv } from "@gcpe/config";
import { safeErrorLabel } from "@gcpe/http-kit";
import { z } from "zod";
import { backfillCompanions } from "../precompress";

async function main(): Promise<void> {
  const env = parseEnv(z.object({ OUTPUT_DIR: z.string().min(1) }), process.env);
  const started = Date.now();
  // Per-file failures (a file held open past the retries on Windows, say) are logged as they
  // happen and the rest carry on; the run still exits non-zero so a scheduled task notices.
  const r = await backfillCompanions(env.OUTPUT_DIR, (line) => {
    if (line.startsWith("failed ")) console.error(`[public-site] site:precompress ${line}`);
  });
  console.log(`[public-site] precompressed ${r.written} files, ${r.current} already current, ${r.orphansRemoved} orphans removed, ${r.failed} failed (${Math.round((Date.now() - started) / 1000)}s)`);
  if (r.failed > 0) process.exitCode = 1;
}

if (pathToFileURL(realpathSync(process.argv[1]!)).href === import.meta.url) {
  main().catch((e) => {
    console.error(`[public-site] site:precompress failed ${safeErrorLabel(e)}`);
    process.exitCode = 1;
  });
}
