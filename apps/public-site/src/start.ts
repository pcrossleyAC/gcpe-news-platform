import { z } from "zod";
import express from "express";
import { assertTimeZoneRules, parseEnv } from "@gcpe/config";
import type { Closer } from "@gcpe/http-kit";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { createApp } from "./app";
import { publicSiteEnvSchema, resolveTenantConfig, tenantConfigPathSchema } from "./env";
import { newsApiClient } from "./news-api-client";
import { createRebuildHandler } from "./rebuild";
import { selfHeal } from "./self-heal";
import { fsStorage } from "./storage";

export interface AppHandle {
  app: express.Express;
  /** Parsed PORT (same env var/default as before) — main.ts listens on this; nothing new to
   * parse there. */
  port: number;
  /** Public Site has no background loops; empty. */
  workers: Record<string, () => Promise<unknown>>;
  /** No-op: nothing to start. Kept for a uniform AppHandle shape across apps. */
  startLoops(): void;
  /** Closers that must run *before* the http server closes. Public Site has none — always
   * empty — but the field exists on every app's AppHandle so main.ts (and the stack) can
   * build the shutdown order uniformly: `[...closeBeforeServer, httpServer, ...closers]`,
   * with no app-specific special-casing. */
  closeBeforeServer: Closer[];
  /** The rest of today's shutdown order, run *after* the http server closes, excluding the
   * http server itself (main.ts owns that). */
  closers: Closer[];
}

/**
 * Wires up everything Public Site's main.ts needs: resolves the tenant config, parses env,
 * runs migrations, and builds the Express app. Identical behaviour to the former main.ts —
 * including the P2-R17 time-zone self-check, run only when a tenant config actually loaded.
 */
export async function startPublicSite(env: NodeJS.ProcessEnv): Promise<AppHandle> {
  // Parsed once up front (reusing the exact schema used again below for the full env's
  // TENANT_CONFIG field) so the path used to load the tenant config is the same value
  // parseEnv produces, not a hand-rolled fallback.
  const { TENANT_CONFIG: tenantConfigPath } = parseEnv(z.object({ TENANT_CONFIG: tenantConfigPathSchema }), env);
  const tenantConfigWasExplicit = typeof env.TENANT_CONFIG === "string" && env.TENANT_CONFIG.length > 0;
  const tenantConfig = resolveTenantConfig({ tenantConfigPath, wasExplicit: tenantConfigWasExplicit });
  // P2-R17: only when a tenant config actually loaded (resolveTenantConfig can silently
  // return undefined for a missing *default* — see its own doc comment) — fail fast if this
  // runtime's tzdata disagrees with the pinned self-check.
  if (tenantConfig) assertTimeZoneRules(tenantConfig);

  const parsed = parseEnv(publicSiteEnvSchema(tenantConfig), env);

  const { db, pool } = createDb(parsed.DATABASE_URL);
  await runMigrations(db, parsed.MIGRATIONS_FOLDER);

  const newsApi = newsApiClient(parsed.NEWS_API_URL);
  const storage = fsStorage(parsed.OUTPUT_DIR);
  const site = { name: parsed.SITE_NAME, baseUrl: parsed.PUBLIC_SITE_URL };

  const handler = createRebuildHandler({ newsApi, storage, site });

  const app = createApp({ db, eventSecrets: parsed.EVENT_SECRETS, handler });

  // Task 1: self-heal once at startup if the output folder came up empty (e.g. right after a
  // SiteGround redeploy). Never thrown — the News API may not be up yet in a standalone run
  // (and main.ts has already decided this app should start regardless).
  void selfHeal({ newsApi, storage, site })
    .then((r) => r && console.log(`[public-site] self-heal rebuilt ${r.rebuilt} posts`))
    .catch((e) => console.error(`[public-site] self-heal failed: ${e instanceof Error ? e.message : e}`));

  return {
    app,
    port: parsed.PORT,
    workers: {},
    startLoops() {
      // No background loops.
    },
    closeBeforeServer: [],
    closers: [{ name: "db pool", close: () => pool.end() }],
  };
}
