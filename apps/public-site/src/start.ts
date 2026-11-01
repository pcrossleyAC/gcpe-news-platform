import { z } from "zod";
import express from "express";
import { serviceTokenProvider } from "@gcpe/auth";
import { assertTimeZoneRules, isTestSite, parseEnv, trustProxyHopsFrom } from "@gcpe/config";
import type { Closer } from "@gcpe/http-kit";
import { createDb, runMigrations, withStatementTimeout } from "@gcpe/db-kit";
import { loadSiteSettingsDefaults } from "@gcpe/site-settings/node";
import { createApp } from "./app";
import { createSiteBuilder } from "./builder";
import { changesClient, syncChanges } from "./change-feed";
import { newsApiTokenOptions, publicSiteEnvSchema, resolveTenantConfig, tenantConfigPathSchema } from "./env";
import { every } from "./loop";
import { newsApiClient } from "./news-api-client";
import { postIndex } from "./post-index";
import { queueHealth } from "./queue";
import type { SiteInfo } from "./render";
import { selfHeal } from "./self-heal";
import { fsStorage } from "./storage";
import { createRebuildHandler, kickBackgroundSync, syncSite, type SyncDeps } from "./sync";
import { DEFAULT_THEME } from "./theme-css";

export interface AppHandle {
  app: express.Express;
  /** Parsed PORT (same env var/default as before) — main.ts listens on this; nothing new to
   * parse there. */
  port: number;
  /** `sync`: queues and drains up to SITE_REBUILD_BATCH pages (spec §6.2) — what the stack's
   * `site.sync` tick step runs (apps/stack/src/stack.ts). */
  workers: Record<string, () => Promise<unknown>>;
  /** The rebuild queue's length and oldest wait, for `/stack/health` (suite review O2.1). */
  rebuildQueue(timeoutMs: number): Promise<{ pages: number; oldestMinutes: number | null }>;
  /** Starts the standalone `site.sync` loop (main.ts), every SYNC_INTERVAL_MS. A no-op in the
   * stack, which ticks `workers.sync` itself instead. */
  startLoops(): void;
  /** Closers that must run *before* the http server closes. Stops the standalone loop (if
   * `startLoops()` ran) before anything else shuts down — see `closers`'s doc comment for the
   * order's rationale. */
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

  // connectionTimeoutMillis (I1): if every connection is ever wedged, a caller waiting for one
  // fails loudly after 10s instead of hanging forever.
  const { db, pool } = createDb(parsed.DATABASE_URL, { connectionTimeoutMillis: 10_000 });
  await runMigrations(db, parsed.MIGRATIONS_FOLDER);

  const newsApi = newsApiClient(parsed.NEWS_API_URL);
  const storage = fsStorage(parsed.OUTPUT_DIR);
  const theme = tenantConfig?.site.theme ?? DEFAULT_THEME;
  const site: SiteInfo = { name: parsed.SITE_NAME, baseUrl: parsed.PUBLIC_SITE_URL, theme, timeZone: tenantConfig?.timeZone,
    verification: { googleFile: parsed.GOOGLE_VERIFICATION_FILE ?? null, googleMeta: parsed.GOOGLE_SITE_VERIFICATION ?? null },
  };
  // What the site shows before any settings are published (and if the first fetch fails): the
  // tenant's <tenant>.site-settings.json, else derived from its theme — as NRMS loads them.
  // Throws on an invalid file, so a bad deploy fails here rather than on the first render.
  const defaultSettings = tenantConfig ? loadSiteSettingsDefaults(tenantConfigPath, tenantConfig.site.theme) : undefined;
  // Plan 3d task 4: the TEST banner prefix and noindex meta — decided once, from this process's
  // own env view (the stack's envFor shares NODE_ENV/SITE_ENVIRONMENT
  // into it the same way for every app).
  const test = isTestSite(env);

  const index = postIndex(db);
  const builder = createSiteBuilder({ newsApi, storage, index, site, assetsDir: parsed.SITE_ASSETS_DIR, searchApiBase: parsed.SEARCH_API_URL ?? "" });
  // Throws here, at startup, if neither Entra client credentials nor a local admin secret is
  // configured — a misconfigured deployment fails fast rather than on the first tick.
  const getToken = serviceTokenProvider(newsApiTokenOptions(parsed, env));
  const changeFeed = changesClient({ baseUrl: parsed.NEWS_API_URL, getToken });
  const syncDeps: SyncDeps = { db, builder, index, newsApi, storage, site, test, batch: parsed.SITE_REBUILD_BATCH, feed: () => syncChanges({ db, client: changeFeed, builder, index }), defaultSettings };
  const handler = createRebuildHandler(syncDeps);

  // I1: the drain and feed sync run outside the receiver's transaction, kicked (not awaited —
  // the receiver itself awaits onApplied, so this must not return kickBackgroundSync's own
  // promise, or the response would wait on the whole drain again) only once that transaction
  // has committed.
  const app = createApp({
    trustProxyHops: trustProxyHopsFrom(env),
    db,
    eventSecrets: parsed.EVENT_SECRETS,
    handler,
    onApplied: () => {
      void kickBackgroundSync(syncDeps);
    },
  });

  let stop: (() => void) | undefined;

  return {
    app,
    port: parsed.PORT,
    workers: { sync: () => syncSite(syncDeps) },
    rebuildQueue: (timeoutMs) => withStatementTimeout(db, timeoutMs, (tx) => queueHealth(tx)),
    startLoops() {
      stop = every(parsed.SYNC_INTERVAL_MS, "site.sync", () => syncSite(syncDeps));
    },
    closeBeforeServer: [{ name: "background loops", close: async () => stop?.() }],
    closers: [{ name: "db pool", close: () => pool.end() }],
    // Fix round 1: not called here — see the AppHandle.selfHeal doc comment above for why.
    selfHeal: () => selfHeal(syncDeps),
  };
}
