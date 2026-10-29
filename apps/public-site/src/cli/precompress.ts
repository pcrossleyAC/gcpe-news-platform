// Writes the .br/.gz companions for every compressible file already in OUTPUT_DIR (a site built
// before pages were compressed when written). Idempotent and safe while the stack is serving.
// Not needed after a rebuild-all: the builder writes companions with every page.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseEnv } from "@gcpe/config";
import { safeErrorLabel } from "@gcpe/http-kit";
import { z } from "zod";
import { backfillCompanions } from "../precompress";

async function main(): Promise<void> {
  const env = parseEnv(z.object({ OUTPUT_DIR: z.string().min(1) }), process.env);
  const started = Date.now();
  const r = await backfillCompanions(env.OUTPUT_DIR);
  console.log(`[public-site] precompressed ${r.written} files, ${r.current} already current, ${r.orphansRemoved} orphans removed (${Math.round((Date.now() - started) / 1000)}s)`);
}

if (pathToFileURL(realpathSync(process.argv[1]!)).href === import.meta.url) {
  main().catch((e) => {
    console.error(`[public-site] site:precompress failed ${safeErrorLabel(e)}`);
    process.exitCode = 1;
  });
}
