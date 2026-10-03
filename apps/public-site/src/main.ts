import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadTenantConfig, parseEnv } from "@gcpe/config";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { closeServer, createShutdown } from "@gcpe/http-kit";
import { createApp } from "./app";
import { newsApiClient } from "./news-api-client";
import { createRebuildHandler } from "./rebuild";
import { fsStorage } from "./storage";

const defaultTenantConfigPath = fileURLToPath(new URL("../../../config/tenants/bc.json", import.meta.url));
const tenantConfigPath = process.env.TENANT_CONFIG ?? defaultTenantConfigPath;

// SITE_NAME defaults from the tenant config's siteName when that config can be loaded; if it
// can't (missing file, invalid config, or a non-default TENANT_CONFIG that doesn't exist),
// SITE_NAME has no default and parseEnv below requires it.
let defaultSiteName: string | undefined;
try {
  defaultSiteName = loadTenantConfig(tenantConfigPath).siteName;
} catch {
  defaultSiteName = undefined;
}
const siteNameSchema = defaultSiteName !== undefined ? z.string().min(1).default(defaultSiteName) : z.string().min(1);

// Parses EVENT_SECRETS exactly like apps/news-api/src/env.ts: a malformed value surfaces as
// parseEnv's own "Invalid environment: EVENT_SECRETS: …" message instead of an uncaught
// SyntaxError/ZodError thrown straight out of main.ts.
const eventSecrets = z
  .string()
  .default("{}")
  .transform((value, ctx) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be valid JSON" });
      return z.NEVER;
    }
    const result = z.record(z.string()).safeParse(parsed);
    if (!result.success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a JSON object of string values" });
      return z.NEVER;
    }
    return result.data;
  });

const env = parseEnv(
  z.object({
    DATABASE_URL: z.string().url(),
    PORT: z.coerce.number().int().default(3003),
    NEWS_API_URL: z.string().url(),
    OUTPUT_DIR: z.string().min(1),
    SITE_NAME: siteNameSchema,
    PUBLIC_SITE_URL: z.string().url(),
    EVENT_SECRETS: eventSecrets,
    MIGRATIONS_FOLDER: z.string().default(fileURLToPath(new URL("../migrations", import.meta.url))),
    TENANT_CONFIG: z.string().default(defaultTenantConfigPath),
  }),
);

const { db, pool } = createDb(env.DATABASE_URL);
await runMigrations(db, env.MIGRATIONS_FOLDER);

const handler = createRebuildHandler({
  newsApi: newsApiClient(env.NEWS_API_URL),
  storage: fsStorage(env.OUTPUT_DIR),
  site: { name: env.SITE_NAME, baseUrl: env.PUBLIC_SITE_URL },
});

const app = createApp({ db, eventSecrets: env.EVENT_SECRETS, handler });
const server = app.listen(env.PORT, () => console.log(`[public-site] listening on ${env.PORT}`));

const shutdown = createShutdown({
  logPrefix: "[public-site]",
  exit: process.exit,
  closers: [
    { name: "http server", close: () => closeServer(server) },
    { name: "db pool", close: () => pool.end() },
  ],
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown());
}
