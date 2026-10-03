import { z } from "zod";
import { assertTimeZoneRules, parseEnv } from "@gcpe/config";
import { closeServer, createShutdown } from "@gcpe/http-kit";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { createApp } from "./app";
import { publicSiteEnvSchema, resolveTenantConfig, tenantConfigPathSchema } from "./env";
import { newsApiClient } from "./news-api-client";
import { createRebuildHandler } from "./rebuild";
import { fsStorage } from "./storage";

// Parsed once up front (reusing the exact schema used again below for the full env's
// TENANT_CONFIG field) so the path used to load the tenant config is the same value
// parseEnv produces, not a hand-rolled `process.env.TENANT_CONFIG ?? default`.
const { TENANT_CONFIG: tenantConfigPath } = parseEnv(z.object({ TENANT_CONFIG: tenantConfigPathSchema }));
const tenantConfigWasExplicit = typeof process.env.TENANT_CONFIG === "string" && process.env.TENANT_CONFIG.length > 0;
const tenantConfig = resolveTenantConfig({ tenantConfigPath, wasExplicit: tenantConfigWasExplicit });
// P2-R17: only when a tenant config actually loaded (resolveTenantConfig can silently return
// undefined for a missing *default* — see its own doc comment) — fail fast if this runtime's
// tzdata disagrees with the pinned self-check.
if (tenantConfig) assertTimeZoneRules(tenantConfig);

const env = parseEnv(publicSiteEnvSchema(tenantConfig));

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
