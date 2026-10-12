// Queues every page of the public site for rebuilding (spec §6.2, runbook "site:rebuild-all").
// The queue drains on the next ticks; nothing is rendered here.
import { parseEnv } from "@gcpe/config";
import { createDb } from "@gcpe/db-kit";
import { safeErrorLabel } from "@gcpe/http-kit";
import { z } from "zod";
import { createSiteBuilder } from "../builder";
import { newsApiClient } from "../news-api-client";
import { postIndex } from "../post-index";
import { enqueueRebuildAll } from "../rebuild-all";
import { fsStorage } from "../storage";

const env = parseEnv(z.object({ DATABASE_URL: z.string().url(), NEWS_API_URL: z.string().url(), OUTPUT_DIR: z.string().min(1), PUBLIC_SITE_URL: z.string().url(), SITE_NAME: z.string().default("site") }), process.env);
const { db, pool } = createDb(env.DATABASE_URL);
try {
  const builder = createSiteBuilder({ newsApi: newsApiClient(env.NEWS_API_URL), storage: fsStorage(env.OUTPUT_DIR), index: postIndex(db), site: { name: env.SITE_NAME, baseUrl: env.PUBLIC_SITE_URL }, assetsDir: null });
  const { pages } = await enqueueRebuildAll(db, builder);
  console.log(`[public-site] queued ${pages} pages; they render over the next ticks`);
} catch (err) {
  console.error(`[public-site] site:rebuild-all failed ${safeErrorLabel(err)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
