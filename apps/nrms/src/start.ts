import { fileURLToPath } from "node:url";
import { z } from "zod";
import express from "express";
import { authFromEnv, serviceTokenProvider, type LocalAuthConfig, type ServiceTokenOptions } from "@gcpe/auth";
import { assertTimeZoneRules, eventSecretsSchema, loadTenantConfig, parseEnv } from "@gcpe/config";
import type { Closer } from "@gcpe/http-kit";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { dispatchOnce, parseSubscribers, startDispatcher } from "@gcpe/events";
import { localStore } from "@gcpe/storage";
import { distributionClient, nodClient } from "./clients";
import { createApp } from "./app";
import { flickrClient, type FlickrConfig } from "./media/flickr-client";
import { publishDue, startPublisher } from "./publisher";

/** An optional setting where "" (an emptied SiteGround field) means unset. */
const optionalSetting = z
  .string()
  .optional()
  .transform((v) => (v === "" ? undefined : v));

const FLICKR_SECRETS = ["FLICKR_API_SECRET", "FLICKR_ACCESS_TOKEN", "FLICKR_ACCESS_SECRET"] as const;

export const nrmsEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().default(3006),
  EVENT_SUBSCRIBERS: z.string().optional(),
  EVENT_SECRETS: eventSecretsSchema,
  MIGRATIONS_FOLDER: z.string().default(fileURLToPath(new URL("../migrations", import.meta.url))),
  PUBLISH_INTERVAL_MS: z.coerce.number().int().default(60000),
  TENANT_CONFIG: z.string().default(fileURLToPath(new URL("../../../config/tenants/bc.json", import.meta.url))),
  // Task 9: NoD's base URL — optional, since not every environment wants NRMS to show a live
  // subscriber count at schedule time (schedule() just skips the count when unset). The four
  // Entra fields below are likewise optional and, like serviceTokenProvider everywhere else,
  // must be set together or not at all; with none set, NRMS falls back to a local admin token
  // (test/non-prod environments) for its calls to NoD.
  NOD_URL: z.string().url().optional(),
  NOD_TOKEN_URL: z.string().url().optional(),
  NOD_CLIENT_ID: z.string().optional(),
  NOD_CLIENT_SECRET: z.string().optional(),
  NOD_SCOPE: z.string().optional(),
  // Task 11: Distribution, for "Email me a copy" — optional (the route answers 503 when unset);
  // the stack defaults it to self:/distribution. Its Entra fields follow the same all-or-none
  // rule as NoD's, with the same local-token fallback.
  DISTRIBUTION_URL: z.string().url().optional(),
  DISTRIBUTION_TOKEN_URL: z.string().url().optional(),
  DISTRIBUTION_CLIENT_ID: z.string().optional(),
  DISTRIBUTION_CLIENT_SECRET: z.string().optional(),
  DISTRIBUTION_SCOPE: z.string().optional(),
  // Phase 3c: uploaded release files (translations, media assets). The stack sets this to
  // <DATA_DIR>/storage (survives a redeploy) and serves it publicly at /files; this default is
  // only for standalone dev.
  STORAGE_DIR: z.string().min(1).default(fileURLToPath(new URL("../../../data/storage", import.meta.url))),
  // The public origin /files/<key> is served from, prefixed to file URLs in published records
  // (e.g. https://boxs.ca). "" keeps them root-relative; the stack derives it from the site URL.
  PUBLIC_FILES_BASE: z.union([z.literal(""), z.string().url()]).default("").transform((v) => v.replace(/\/+$/, "")),
  // Phase 3c: Flickr (OAuth 1.0a). No FLICKR_API_KEY → no Flickr: asset status reports
  // "unavailable" and the publisher treats Flickr releases as it does an outage. The stack runs
  // its fake Flickr in that case and sets FLICKR_MODE=fake plus the fake's credentials and URLs.
  FLICKR_MODE: z.enum(["real", "fake"]).default("real"),
  FLICKR_API_KEY: optionalSetting,
  FLICKR_API_SECRET: optionalSetting,
  FLICKR_ACCESS_TOKEN: optionalSetting,
  FLICKR_ACCESS_SECRET: optionalSetting,
  FLICKR_REST_URL: z.string().url().default("https://api.flickr.com/services/rest"),
  FLICKR_OEMBED_URL: z.string().url().default("https://www.flickr.com/services/oembed"),
  FLICKR_OAUTH_URL: z.string().url().default("https://www.flickr.com/services/oauth"),
  FLICKR_ALERT_EMAILS: z
    .string()
    .default("")
    .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(z.string().email("FLICKR_ALERT_EMAILS must be a comma-separated list of email addresses"))),
}).superRefine((env, ctx) => {
  if (!env.FLICKR_API_KEY) return;
  for (const name of FLICKR_SECRETS) {
    if (!env[name]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: `${name} is required when FLICKR_API_KEY is set` });
  }
});

/** NRMS's Flickr client config, or null when FLICKR_API_KEY is unset (Flickr then reads as unavailable). */
export function flickrConfigFromEnv(parsed: z.infer<typeof nrmsEnvSchema>): FlickrConfig | null {
  if (!parsed.FLICKR_API_KEY) return null;
  return {
    apiKey: parsed.FLICKR_API_KEY,
    // The schema requires all three once FLICKR_API_KEY is set.
    apiSecret: parsed.FLICKR_API_SECRET!,
    accessToken: parsed.FLICKR_ACCESS_TOKEN!,
    accessSecret: parsed.FLICKR_ACCESS_SECRET!,
    restUrl: parsed.FLICKR_REST_URL,
    oembedUrl: parsed.FLICKR_OEMBED_URL,
  };
}

/**
 * Builds the {@link ServiceTokenOptions} for NRMS's own calls to NoD's subscriber-count
 * endpoint — pulled out of `startNrms` so the wiring (which role, which subject) can be
 * asserted directly in a test, without standing up a database or a network call.
 *
 * Fix round 1 (review finding): roles is `["NoD.SubscriberCount"]`, a dedicated, read-only
 * service role — not `NRMS.Editor`, which on the local-auth branch is a full NRMS write
 * credential (same LOCAL_AUTH_SECRET/issuer/audience everywhere) and far more than reading a
 * count needs. Not added to STAFF_ROLES: no human ever holds it.
 */
export function nodServiceTokenOptions(
  parsed: Pick<z.infer<typeof nrmsEnvSchema>, "NOD_TOKEN_URL" | "NOD_CLIENT_ID" | "NOD_CLIENT_SECRET" | "NOD_SCOPE">,
  local: LocalAuthConfig | null,
): ServiceTokenOptions {
  return {
    tokenUrl: parsed.NOD_TOKEN_URL,
    clientId: parsed.NOD_CLIENT_ID,
    clientSecret: parsed.NOD_CLIENT_SECRET,
    scope: parsed.NOD_SCOPE,
    local,
    subject: "nrms",
    roles: ["NoD.SubscriberCount"],
    envPrefix: "NOD",
  };
}

/**
 * {@link ServiceTokenOptions} for NRMS's calls to Distribution. Subject "nrms" is also the local
 * token's azp, which Distribution uses as the app id that scopes idempotency keys and batches.
 */
export function distributionServiceTokenOptions(
  parsed: Pick<z.infer<typeof nrmsEnvSchema>, "DISTRIBUTION_TOKEN_URL" | "DISTRIBUTION_CLIENT_ID" | "DISTRIBUTION_CLIENT_SECRET" | "DISTRIBUTION_SCOPE">,
  local: LocalAuthConfig | null,
): ServiceTokenOptions {
  return {
    tokenUrl: parsed.DISTRIBUTION_TOKEN_URL,
    clientId: parsed.DISTRIBUTION_CLIENT_ID,
    clientSecret: parsed.DISTRIBUTION_CLIENT_SECRET,
    scope: parsed.DISTRIBUTION_SCOPE,
    local,
    subject: "nrms",
    roles: ["Distribution.Send"],
    envPrefix: "DISTRIBUTION",
  };
}

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
  /** Closers that must run *before* the http server closes. NRMS has none — always empty —
   * but the field exists on every app's AppHandle so main.ts (and the stack) can build the
   * shutdown order uniformly: `[...closeBeforeServer, httpServer, ...closers]`, with no
   * app-specific special-casing. */
  closeBeforeServer: Closer[];
  /** The rest of today's shutdown order, run *after* the http server closes, excluding the
   * http server itself (main.ts owns that). */
  closers: Closer[];
}

/**
 * Wires up everything NRMS's main.ts needs: parses env, runs migrations, builds the Express
 * app and the pieces behind its two background loops (publisher, event dispatcher).
 * Identical behaviour to the former main.ts.
 */
export async function startNrms(env: NodeJS.ProcessEnv): Promise<AppHandle> {
  const parsed = parseEnv(nrmsEnvSchema, env);
  const auth = authFromEnv(env);
  // The tenant's time zone decides the BC year in approve-time Keys; fail fast if this
  // runtime's tzdata disagrees with the tenant's pinned self-check (as the News API does).
  const tenant = loadTenantConfig(parsed.TENANT_CONFIG);
  assertTimeZoneRules(tenant);
  const countSubscribers = parsed.NOD_URL
    ? nodClient({
        baseUrl: parsed.NOD_URL,
        getToken: serviceTokenProvider(nodServiceTokenOptions(parsed, auth.local)),
      }).countSubscribers
    : undefined;
  const filesBase = parsed.PUBLIC_FILES_BASE;
  const workflow = { timeZone: tenant.timeZone, countSubscribers, filesBase };
  const store = localStore(parsed.STORAGE_DIR, "/files/");
  const distribution = parsed.DISTRIBUTION_URL
    ? distributionClient({ baseUrl: parsed.DISTRIBUTION_URL, getToken: serviceTokenProvider(distributionServiceTokenOptions(parsed, auth.local)) })
    : undefined;
  const flickrConfig = flickrConfigFromEnv(parsed);
  const flickr = flickrConfig ? flickrClient(flickrConfig) : null;
  // The mode only — never the key, secrets or tokens.
  console.log(`[nrms] Flickr: ${flickrConfig ? parsed.FLICKR_MODE : "not configured"}`);
  const { db, pool } = createDb(parsed.DATABASE_URL);
  await runMigrations(db, parsed.MIGRATIONS_FOLDER);
  const subscribers = parseSubscribers(parsed.EVENT_SUBSCRIBERS);

  const app = createApp({
    db,
    auth: auth.bearer,
    loginRouter: auth.loginRouter,
    eventSecrets: parsed.EVENT_SECRETS,
    workflow,
    distribution,
    store,
    flickr,
  });

  // Set by startLoops(); closers below reference these lazily so they're safe to call even
  // if startLoops() was never invoked.
  let stopPublisher: (() => Promise<void>) | undefined;
  let stopDispatcher: (() => Promise<void>) | undefined;

  return {
    app,
    port: parsed.PORT,
    workers: {
      publish: () => publishDue({ db, subscribers, filesBase }),
      dispatch: () => dispatchOnce({ db, subscribers }),
    },
    startLoops() {
      stopDispatcher = startDispatcher({ db, subscribers });
      stopPublisher = startPublisher({ db, subscribers, filesBase, intervalMs: parsed.PUBLISH_INTERVAL_MS });
    },
    closeBeforeServer: [],
    closers: [
      { name: "publisher", close: async () => { await stopPublisher?.(); } },
      { name: "event dispatcher", close: async () => { await stopDispatcher?.(); } },
      { name: "db pool", close: () => pool.end() },
    ],
  };
}
