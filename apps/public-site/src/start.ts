import { z } from "zod";
import express from "express";
import { assertTimeZoneRules, parseEnv } from "@gcpe/config";
import type { Closer } from "@gcpe/http-kit";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { createApp } from "./app";
import { createSiteBuilder } from "./builder";
import { publicSiteEnvSchema, resolveTenantConfig, tenantConfigPathSchema } from "./env";
import { newsApiClient } from "./news-api-client";
import { postIndex } from "./post-index";
import { createRebuildHandler } from "./rebuild";
import type { SiteInfo } from "./render";
import { selfHeal } from "./self-heal";
import { isTestSite } from "./site-env";
import { logoFor } from "./static-pages";
import { fsStorage } from "./storage";
import { DEFAULT_THEME } from "./theme-css";

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
  /**
   * Task 1 fix round 1: rebuilds `index.html` (and the latest posts) once, if the output
   * folder came up empty (e.g. right after a SiteGround redeploy) — see self-heal.ts. Exposed
   * here instead of being fired automatically inside `startPublicSite`: in the single-process
   * stack, the in-process `self:` fetch `newsApiClient` relies on only becomes usable once
   * every app has started and `stack.ts` assigns its own `stackApp` (installInternalFetch's
   * lookup throws "the stack app is not ready yet" before that) — calling this from inside
   * `startPublicSite` itself always hit that race and failed. The caller decides when it's
   * actually safe to call: `main.ts` calls it right after the http server starts listening
   * (standalone has no such race); `stack.ts` calls it right after `stackApp` is assigned.
   */
  selfHeal(): Promise<{ rebuilt: number } | null>;
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
  const theme = tenantConfig?.site.theme ?? DEFAULT_THEME;
  const site: SiteInfo = { name: parsed.SITE_NAME, baseUrl: parsed.PUBLIC_SITE_URL, theme };
  site.logo = logoFor(theme, parsed.SITE_ASSETS_DIR, site);
  // Plan 3d task 4: the TEST banner prefix and noindex meta — decided once, from this process's
  // own env view (the stack's envFor shares NODE_ENV/LOCAL_ADMIN_ALLOW_IN_PRODUCTION/SITE_ENVIRONMENT
  // into it the same way for every app).
  const test = isTestSite(env);

  const index = postIndex(db);
  const builder = createSiteBuilder({ newsApi, storage, index, site, assetsDir: parsed.SITE_ASSETS_DIR });
  const handler = createRebuildHandler({ builder, newsApi, storage, site, test });

  const app = createApp({ db, eventSecrets: parsed.EVENT_SECRETS, handler });

  return {
    app,
    port: parsed.PORT,
    workers: {},
    startLoops() {
      // No background loops.
    },
    closeBeforeServer: [],
    closers: [{ name: "db pool", close: () => pool.end() }],
    // Fix round 1: not called here — see the AppHandle.selfHeal doc comment above for why.
    selfHeal: () => selfHeal({ builder, newsApi, storage, site, test }),
  };
}
