import { fileURLToPath } from "node:url";
import { z } from "zod";
import express from "express";
import { authFromEnv, serviceTokenProvider } from "@gcpe/auth";
import { assertTimeZoneRules, eventSecretsSchema, loadTenantConfig, parseEnv } from "@gcpe/config";
import { createDb, runMigrations } from "@gcpe/db-kit";
import type { Closer } from "@gcpe/http-kit";
import { createApp } from "./app";
import { runDigestIfDue, startDigestLoop } from "./digest";
import { distributionClient } from "./distribution-client";
import { distributionTokenProvider } from "./distribution-token";
import { needsReferenceData } from "./lists";
import { mediaHubClient, type MediaHubClient } from "./media-hub/client";
import type { RecipientLinkOptions } from "./recipient-links";
import type { RenderOptions } from "./render";
import { sendDueJobs, startJobSender } from "./send-jobs";

export const nodEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().default(3004),
  EVENT_SECRETS: eventSecretsSchema,
  DISTRIBUTION_URL: z.string().url(),
  // All four set together → Entra client credentials; none set → a local token (test
  // environments), minted from authFromEnv's own local secret. See distribution-token.ts.
  DISTRIBUTION_TOKEN_URL: z.string().optional(),
  DISTRIBUTION_CLIENT_ID: z.string().optional(),
  DISTRIBUTION_CLIENT_SECRET: z.string().optional(),
  DISTRIBUTION_SCOPE: z.string().optional(),
  // Bounds a single chunk request to Distribution; also sizes send-jobs.ts's claim lock
  // (chunks * this + margin), so a hung request can't outlive the lock protecting it.
  DISTRIBUTION_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  PUBLIC_SITE_URL: z.string().url(),
  // Task 5: optional banner image for every outbound email's shell (render.ts); no banner image
  // host exists yet, so the default is the plain blue heading fallback. Operators set this as
  // `NOD_BANNER_URL` on the stack; apps/stack/src/env.ts's envFor strips the "NOD_" prefix
  // before this schema sees it (same convention as OPS_EMAIL below), so this schema's own key
  // is the stripped `BANNER_URL` -- it used to be the doubly-prefixed `NOD_BANNER_URL`, which
  // envFor's stripping silently dropped on the floor on the stack.
  BANNER_URL: z.string().url().optional(),
  // Phase 4a: HMAC key for unsubscribe tokens (the stack derives it from STACK_EVENT_SECRET).
  LINK_SECRET: z.string().min(32),
  // Task 7: operator inbox notified (system-priority email) whenever sending is paused or
  // resumed, alongside the always-written operations_log row. Optional -- a deployment with
  // no operator inbox configured still records the operations_log row, just sends no email.
  // The operator sets `NOD_OPS_EMAIL`; by the time this schema sees it, apps/stack/src/env.ts's
  // envFor has already stripped the "NOD_" prefix (same as DATABASE_URL, PORT, etc. above).
  OPS_EMAIL: z.string().email().optional(),
  // The page emailed verify/manage links open. Default: the public site's test page.
  SUBSCRIBE_PAGE_URL: z.string().url().optional(),
  // Base URL of the public Subscribe API, carrying the one-click unsubscribe path
  // (recipient-links.ts, Task 3). Default: PUBLIC_SITE_URL's own origin's /api/Subscribe.
  SUBSCRIBE_API_URL: z.string().url().optional(),
  // Media Hub contacts contract. Unset -> search and add-from-hub answer 503 "media hub not
  // configured" while manual entry still works; the stack points this at its own fake Media
  // Hub when no real one is configured (see apps/stack/src/env.ts).
  MEDIA_HUB_URL: z.string().url().optional(),
  MEDIA_HUB_TOKEN_URL: z.string().optional(),
  MEDIA_HUB_CLIENT_ID: z.string().optional(),
  MEDIA_HUB_CLIENT_SECRET: z.string().optional(),
  MEDIA_HUB_SCOPE: z.string().optional(),
  MEDIA_HUB_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  MIGRATIONS_FOLDER: z.string().default(fileURLToPath(new URL("../migrations", import.meta.url))),
  // Task 6: the tenant's time zone (digest.ts's 17:00 cutoff) and its tzdata self-check, same
  // default as apps/news-api/src/env.ts.
  TENANT_CONFIG: z.string().default(fileURLToPath(new URL("../../../config/tenants/bc.json", import.meta.url))),
});

export interface AppHandle {
  app: express.Express;
  /** Parsed PORT (same env var/default as before) — main.ts listens on this; nothing new to
   * parse there. */
  port: number;
  /** One iteration of each background loop, using the same function and options the loop
   * itself uses. */
  workers: Record<string, () => Promise<unknown>>;
  /** Starts the interval loops exactly as main.ts does today. */
  startLoops(): void;
  /** Closers that must run *before* the http server closes. NoD has none — always empty —
   * but the field exists on every app's AppHandle so main.ts (and the stack) can build the
   * shutdown order uniformly: `[...closeBeforeServer, httpServer, ...closers]`, with no
   * app-specific special-casing. */
  closeBeforeServer: Closer[];
  /** The rest of today's shutdown order, run *after* the http server closes, excluding the
   * http server itself (main.ts owns that). */
  closers: Closer[];
}

/**
 * Wires up everything NoD's main.ts needs: parses env, runs migrations, builds the
 * Distribution client/token provider and the Express app, and the pieces behind its job
 * sender loop. Identical behaviour to the former main.ts.
 */
export async function startNod(env: NodeJS.ProcessEnv): Promise<AppHandle> {
  const parsed = parseEnv(nodEnvSchema, env);

  const tenant = loadTenantConfig(parsed.TENANT_CONFIG);
  // P2-R17: fail fast, loudly, before anything else starts, if this runtime's tzdata
  // disagrees with the tenant's pinned (at, expectedOffset) self-check.
  assertTimeZoneRules(tenant);

  const auth = authFromEnv(env);
  const { db, pool } = createDb(parsed.DATABASE_URL);
  await runMigrations(db, parsed.MIGRATIONS_FOLDER);

  const getDistributionToken = distributionTokenProvider({
    tokenUrl: parsed.DISTRIBUTION_TOKEN_URL,
    clientId: parsed.DISTRIBUTION_CLIENT_ID,
    clientSecret: parsed.DISTRIBUTION_CLIENT_SECRET,
    scope: parsed.DISTRIBUTION_SCOPE,
    local: auth.local,
  });
  const distribution = distributionClient({
    baseUrl: parsed.DISTRIBUTION_URL,
    getToken: getDistributionToken,
    timeoutMs: parsed.DISTRIBUTION_TIMEOUT_MS,
  });

  // Task 5: siteUrl is the public site home ("See more from BC Gov News" in every email's
  // footer) — the same URL as items' own publicSiteUrl.
  const render: RenderOptions = { siteUrl: parsed.PUBLIC_SITE_URL, bannerUrl: parsed.BANNER_URL ?? null };

  // Both the subscribe journeys' own manage-link page and Task 3's per-recipient manage links
  // (recipient-links.ts) open the same page — one default, shared.
  const subscribePageUrl = parsed.SUBSCRIBE_PAGE_URL ?? `${parsed.PUBLIC_SITE_URL.replace(/\/$/, "")}/subscribe/manage/`;
  // Task 4: the job sender's own consumer — a fresh manage link and the stable one-click
  // unsubscribe URL for each active recipient, built just before their chunk part is sent.
  const recipientLinks: RecipientLinkOptions = {
    pageUrl: subscribePageUrl,
    subscribeApiUrl: parsed.SUBSCRIBE_API_URL ?? `${new URL(parsed.PUBLIC_SITE_URL).origin}/api/Subscribe`,
    linkSecret: parsed.LINK_SECRET,
  };

  const sendJobsOptions = { db, distribution, links: recipientLinks, render, perChunkMs: parsed.DISTRIBUTION_TIMEOUT_MS };

  // Only built when a Media Hub is actually configured -- search and add-from-hub answer 503
  // otherwise (routes.ts), and there is then no token provider to fail at startup.
  const mediaHub: MediaHubClient | null = parsed.MEDIA_HUB_URL
    ? mediaHubClient({
        baseUrl: parsed.MEDIA_HUB_URL,
        getToken: serviceTokenProvider({
          tokenUrl: parsed.MEDIA_HUB_TOKEN_URL,
          clientId: parsed.MEDIA_HUB_CLIENT_ID,
          clientSecret: parsed.MEDIA_HUB_CLIENT_SECRET,
          scope: parsed.MEDIA_HUB_SCOPE,
          local: auth.local,
          subject: "nod",
          roles: ["MediaHub.ContactsRead"],
          envPrefix: "NOD_MEDIA_HUB",
        }),
        timeoutMs: parsed.MEDIA_HUB_TIMEOUT_MS,
      })
    : null;

  const app = createApp({
    db,
    auth: auth.bearer,
    loginRouter: auth.loginRouter,
    eventSecrets: parsed.EVENT_SECRETS,
    render,
    subscribe: {
      db,
      distribution,
      pageUrl: subscribePageUrl,
      linkSecret: parsed.LINK_SECRET,
      render,
    },
    distribution,
    opsEmail: parsed.OPS_EMAIL ?? null,
    timeZone: tenant.timeZone,
    mediaHub,
  });

  // Set by startLoops(); the closers below reference these lazily so they're safe to call even
  // if startLoops() was never invoked.
  let stopJobSender: (() => Promise<void>) | undefined;
  let stopDigestLoop: (() => Promise<void>) | undefined;

  return {
    app,
    port: parsed.PORT,
    workers: {
      send: () => sendDueJobs(sendJobsOptions),
      // Task 6: the 17:00 daily digest -- a no-op call every tick until the tenant's wall
      // clock actually reaches DIGEST_HOUR for a cutoff not already run.
      digest: () => runDigestIfDue(db, tenant.timeZone, render),
      // Phase 4a: lets the stack (stack.ts) check, once at startup, whether Core's reference
      // data has ever reached this NoD so it knows whether to ask Core to republish.
      needsReferenceData: () => needsReferenceData(db),
    },
    startLoops() {
      stopJobSender = startJobSender(sendJobsOptions);
      // The standalone NoD image and STACK_LOOPS=true must also run the digest -- the
      // workers.digest hook above only ever fires once, when a caller asks for it.
      stopDigestLoop = startDigestLoop({ db, timeZone: tenant.timeZone, render });
    },
    closeBeforeServer: [],
    closers: [
      { name: "job sender", close: async () => { await stopJobSender?.(); } },
      { name: "digest loop", close: async () => { await stopDigestLoop?.(); } },
      { name: "db pool", close: () => pool.end() },
    ],
  };
}
