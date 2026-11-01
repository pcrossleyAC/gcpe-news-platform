import { existsSync } from "node:fs";
import { join } from "node:path";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express, { Router, type Express } from "express";
import rateLimit from "express-rate-limit";
import type { ZodTypeAny } from "zod";
import { authFromEnv, requireBearer, requireRole, serviceTokenProvider, sessionGateInstalled, setSessionGate } from "@gcpe/auth";
import { assertTimeZoneRules, loadTenantConfig, parseEnv } from "@gcpe/config";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { createFakeEmergencyFeed } from "@gcpe/emergency-feed-fake";
import { createFakeFlickr } from "@gcpe/flickr-fake";
import { createFakeMediaHub } from "@gcpe/media-hub-fake";
import { createFakeOidc } from "@gcpe/oidc-fake";
import { safeErrorLabel, type Closer } from "@gcpe/http-kit";
import { loadSiteSettingsDefaults } from "@gcpe/site-settings/node";

import { calendarEnvSchema, startCalendar, type AppHandle as CalendarHandle } from "../../calendar/src/start";
import { signInSettingsFromEnv } from "../../core/src/entra/config";
import { coreEnvSchema, startCore, type AppHandle as CoreHandle } from "../../core/src/start";
import { distributionEnvSchema } from "../../distribution/src/env";
import { startDistribution, type AppHandle as DistributionHandle } from "../../distribution/src/start";
import { newsApiEnvSchema } from "../../news-api/src/env";
import { nodSubscribeTokenOptions, startNewsApi, type AppHandle as NewsApiHandle } from "../../news-api/src/start";
import { distributionTokenFor, mediaHubTokenFor, nodEnvSchema, startNod, type AppHandle as NodHandle } from "../../nod/src/start";
import {
  coreServiceTokenOptions,
  distributionServiceTokenOptions,
  newsApiServiceTokenOptions,
  nodServiceTokenOptions,
  nrmsEnvSchema,
  startNrms,
  type AppHandle as NrmsHandle,
} from "../../nrms/src/start";
import { newsApiTokenOptions, publicSiteEnvSchema } from "../../public-site/src/env";
import { startPublicSite, type AppHandle as PublicSiteHandle } from "../../public-site/src/start";

import { noStoreByDefault } from "./cache-control";
import { filesHandlers } from "./files-gate";
import { textCompression } from "./compress";
import { ensureWritableDir, resolveDataDir } from "./data-dir";
import { checkCalendarDbTimeZone, pgOffsetOf, type DbTimeZoneStatus } from "./db-time-zone";
import { INTERNAL_ORIGIN, installInternalFetch } from "./internal-fetch";
import { groupErrors, installErrorCapture, type ErrorEntry } from "./errors";
import { HEALTH_LIMITS, runOpsChecks, type Check, type OpsSources, type TimeoutStreaks } from "./ops-checks";
import { undeliveredRouter } from "./undelivered";
import { mountSite, rootSiteNotFound, siteBasePath } from "./site-mount";
import {
  assertPrivateDir,
  calendarConfigured,
  envFor,
  FAKE_EMERGENCY_FEED_PATH,
  FAKE_ENTRA,
  FAKE_ENTRA_IDENTITIES,
  FAKE_ENTRA_PATH,
  FAKE_FLICKR,
  FAKE_FLICKR_PATH,
  FAKE_MEDIA_HUB_PATH,
  productionProblems,
  type ProductionProblems,
  resolveSelfUrls,
  type AppPrefix,
  stackEnvSchema,
  usesFakeEmergencyFeed,
  usesFakeEntra,
  usesFakeFlickr,
  usesFakeMediaHub,
} from "./env";
import { createTickRunner, tickRouter, type TickStep } from "./tick";

export interface StackHandle {
  app: Express;
  port: number;
  startLoops(): void;
  /** Wires News API's SignalR hub WebSocket upgrade handling to the http server — present
   * only when UPDATES_HUB_ENABLED=true (default false; SiteGround strips WebSocket upgrades,
   * so production never sets this). Forwards straight to News API's own `attach`. */
  attach?(server: Server): void;
  closeBeforeServer: Closer[];
  closers: Closer[];
}

/** /stack/errors's persisted ring: how many of the most recent console.error calls are kept,
 * in memory and in the DATA_DIR-backed file that survives a restart. */
const ERROR_LOG_RING_LIMIT = 1000;

/** The origin of the public site's URL — where the stack serves /files — or "" if it isn't a URL. */
export function publicFilesBase(siteUrl: string | undefined): string {
  try {
    return siteUrl ? new URL(siteUrl).origin : "";
  } catch {
    return "";
  }
}

/** The fake Flickr's public base — what its oEmbed image URLs point at: the public site's origin
 * + /fake-flickr, or http://localhost:<port>/fake-flickr when the site URL isn't a URL. */
export function fakeFlickrPublicBase(siteUrl: string | undefined, port: number): string {
  return `${publicFilesBase(siteUrl) || `http://localhost:${port}`}${FAKE_FLICKR_PATH}`;
}

/** `requested` as-is when it's a real port; otherwise (PORT=0, "let the OS pick") binds a
 * throwaway probe server to learn an actual port and closes it immediately so the real
 * server (bound later, by main.ts, to this exact number) can reuse it. Same small
 * bind-then-rebind race already accepted elsewhere in this codebase (tests/e2e/support.ts's
 * `reserve()`) — needed here because `self:` subscriber URLs (see env.ts) must be resolved to
 * a concrete port *before* any app is started, and in production PORT is always a fixed,
 * platform-injected value (never 0), so this path is test-only in practice.
 */
async function determineActualPort(requested: number): Promise<number> {
  if (requested !== 0) return requested;
  return new Promise<number>((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Builds one app's env view, with every `self:/…` URL (EVENT_SUBSCRIBERS entries and any
 * other `*_URL`/`*_BASE` var — see `resolveSelfUrls`) resolved to the stack's own loopback
 * port. Fix
 * round 1, P2-R30 important fix 1: applied to every app, not just NRMS/NEWSAPI — Core's own
 * EVENT_SUBSCRIBERS needs this exactly as much as NRMS's does (Core publishes org.upserted
 * the same way NRMS publishes release.published).
 *
 * `dataDir` is threaded through to `envFor` so NRMS's STORAGE_DIR and a relative
 * SITE_OUTPUT_DIR both anchor under the one persistent folder that survives a redeploy.
 */
function resolvedEnvFor(env: NodeJS.ProcessEnv, prefix: AppPrefix, dataDir: string): NodeJS.ProcessEnv {
  return resolveSelfUrls(envFor(env, prefix, dataDir));
}

/**
 * Every path prefix some part of the stack answers itself, rather than the public site. A new
 * top-level mount belongs here too. The site's own pass-through list is SITE_PASS_THROUGH below
 * (all of these but "/updates"): under those, rootSiteNotFound and legacyUrls step aside and the
 * app answers its own 404 (News API's JSON one for /api, /health and /events).
 */
export const STACK_OWNED_PREFIXES: readonly string[] = [
  "/api",
  "/health",
  "/events",
  "/updates",
  "/core",
  "/nrms",
  "/nod",
  "/calendar",
  "/distribution",
  "/site-builder",
  "/stack",
  "/hub",
  "/files",
  FAKE_FLICKR_PATH,
  FAKE_MEDIA_HUB_PATH,
  FAKE_EMERGENCY_FEED_PATH,
  FAKE_ENTRA_PATH,
];

/**
 * The prefixes the public site leaves alone (legacyUrls and rootSiteNotFound): every
 * stack-owned prefix except "/updates" (ruling P3-R4). Legacy Updates posts, feeds and archives
 * live at news.gov.bc.ca/updates/…, so a GET/HEAD there must reach the legacy rules and the
 * site's HTML 404. News API's hub keeps working: its only Express route is POST
 * /updates/negotiate (legacyUrls and rootSiteNotFound pass every non-GET/HEAD through), and its
 * WebSocket handshake arrives on the server's 'upgrade' event, which never enters Express.
 */
export const SITE_PASS_THROUGH: readonly string[] = STACK_OWNED_PREFIXES.filter((p) => p !== "/updates");

/** Every folder the stack serves to anyone, named by the setting that moves it. */
function publicDirs(nrmsStorage: string | undefined, siteOutput: string | undefined, staffWeb: string | undefined): Record<string, string | undefined> {
  return { "NRMS_STORAGE_DIR (served at /files)": nrmsStorage, "SITE_OUTPUT_DIR (served at / and /site)": siteOutput, "STAFF_WEB_DIR (served at /hub)": staffWeb };
}

/** Throws on real production's refusals (productionProblems); logs each warning, never silently. */
function assertProductionReady(env: NodeJS.ProcessEnv): void {
  const { errors, warnings } = productionProblems(env);
  if (errors.length > 0) {
    throw new Error(`[stack] refusing to start: this is the real production site (NODE_ENV=production without SITE_ENVIRONMENT=test), and ${errors.join("; ")}`);
  }
  for (const w of warnings) console.warn(`[stack] PRODUCTION WARNING: ${w}`);
}

/**
 * The service tokens each app builds when it starts (serviceTokenProvider throws at construction
 * when a caller has no way to get one: no Entra client credentials, not inside the stack, no
 * break-glass secret). `stack --check` builds them the same way, from the same option functions,
 * so a deployment that can't start fails the check too. Nothing is minted or fetched.
 */
function buildServiceTokens(prefix: AppPrefix, parsed: unknown, view: NodeJS.ProcessEnv): void {
  const auth = () => authFromEnv(view);
  if (prefix === "NRMS") {
    const p = parsed as Parameters<typeof nodServiceTokenOptions>[0] & Parameters<typeof distributionServiceTokenOptions>[0] & Parameters<typeof coreServiceTokenOptions>[0] & Parameters<typeof newsApiServiceTokenOptions>[0];
    const { local, internal } = auth();
    if (p.NOD_URL) serviceTokenProvider(nodServiceTokenOptions(p, local, internal));
    if (p.DISTRIBUTION_URL) serviceTokenProvider(distributionServiceTokenOptions(p, local, internal));
    if (p.CORE_URL) serviceTokenProvider(coreServiceTokenOptions(p, local, internal));
    if (p.NEWS_API_URL) serviceTokenProvider(newsApiServiceTokenOptions(p, local, internal));
  } else if (prefix === "NOD") {
    const p = parsed as Parameters<typeof distributionTokenFor>[0];
    distributionTokenFor(p, auth());
    if (p.MEDIA_HUB_URL) mediaHubTokenFor(p, auth());
  } else if (prefix === "SITE") {
    serviceTokenProvider(newsApiTokenOptions(parsed as Parameters<typeof newsApiTokenOptions>[0], view));
  } else if (prefix === "NEWSAPI") {
    const p = parsed as Parameters<typeof nodSubscribeTokenOptions>[0];
    if (p.NOD_BASE_URL) serviceTokenProvider(nodSubscribeTokenOptions(p, view));
  }
}

/**
 * Fix round 1, P2-R30 M5: wraps one `start<App>()` call so a startup failure names the app
 * and which env prefix to go check — the six apps' own error messages (e.g. parseEnv's
 * "Invalid environment: DATABASE_URL: Required") never mention that they were even called
 * with a *stripped* env view, let alone which stack-level prefix produced it, which otherwise
 * leaves an operator staring at "DATABASE_URL: Required" with six different candidates
 * (CORE_DATABASE_URL? NRMS_DATABASE_URL? …) and no way to tell which.
 */
async function startNamed<T>(label: string, prefix: AppPrefix, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`[stack] ${label} failed to start (its variables are ${prefix}_*): ${message}`);
  }
}

/** Looks up a named worker on an AppHandle, throwing (rather than silently running nothing)
 * if it's missing — `workers` is typed as a plain `Record<string, …>` so TS can't check the
 * name against the AppHandle's real, app-specific keys; this is that check, done once here
 * instead of asserted away at every call site. */
function worker(handle: { workers: Record<string, () => Promise<unknown>> }, name: string): () => Promise<unknown> {
  const fn = handle.workers[name];
  if (!fn) throw new Error(`startStack: expected a "${name}" worker on this app's AppHandle`);
  return fn;
}

const HEALTH_CACHE_TTL_MS = 5_000;

/**
 * `GET /stack/health`: each mounted app's own `/health/ready`, fetched over the loopback
 * interface at the stack's own (by now listening) port — the only way to reach a readiness
 * check that's wired up *inside* each app's own Express instance (see createApp in every
 * app's app.ts) without reimplementing it here.
 *
 * Fix round 1, P2-R30 M8: the aggregate result is cached in-process for
 * {@link HEALTH_CACHE_TTL_MS} — an external uptime monitor polling this every few seconds
 * would otherwise fan out into 6 fresh loopback requests (one of which is itself a DB ping)
 * on every single poll, for a number that's realistically stable across a 5 s window.
 *
 * `startedAt`/`pid` (2026-10-04 SiteGround debugging): SiteGround idle-kills the stack
 * process after 30-60s and cold-starts a brand-new one on the next request
 * (docs/deploy/siteground.md "Background work scheduler") — indistinguishable, from the
 * outside, from a crash-triggered restart unless something names *when this process itself
 * started*. Two polls a request-apart with a different `startedAt` (or `pid`) prove a restart
 * happened between them; the same `startedAt` across many minutes proves the process stayed
 * up the whole time. Deliberately outside the cache above (constant for the process's whole
 * life, so there's nothing to cache) and never itself a reason for a non-200/503.
 *
 * `newsApiSearch` (spec §5.3) is the News API's startup search mode; like `startedAt`, it is
 * constant for the process, so it sits outside the cache.
 */
function healthRouter(startedAt: string, withCalendar: boolean, newsApiSearch: "semantic" | "text", ops: OpsSources): Router {
  const checks: { name: string; path: string }[] = [
    { name: "core", path: "/core/health/ready" },
    { name: "nrms", path: "/nrms/health/ready" },
    { name: "nod", path: "/nod/health/ready" },
    { name: "distribution", path: "/distribution/health/ready" },
    { name: "site-builder", path: "/site-builder/health/ready" },
    { name: "news-api", path: "/health/ready" },
  ];
  if (withCalendar) checks.push({ name: "calendar", path: "/calendar/health/ready" });
  let cached: { expiresAt: number; status: number; body: { status: string; apps: Record<string, boolean>; checks: Record<string, Check> } } | undefined;
  const r = Router();
  // Fix round 3, N8: kept across computations so a check that keeps timing out turns red.
  const timeoutStreaks: TimeoutStreaks = new Map();
  type Computed = { status: number; body: { status: string; apps: Record<string, boolean>; checks: Record<string, Check> } };
  const compute = async (): Promise<Computed> => {
    const apps: Record<string, boolean> = {};
    const [, opsChecks] = await Promise.all([
      Promise.all(
        checks.map(async ({ name, path }) => {
          try {
            const response = await fetch(`${INTERNAL_ORIGIN}${path}`);
            apps[name] = response.ok;
          } catch {
            apps[name] = false;
          }
        }),
      ),
      runOpsChecks(ops, HEALTH_LIMITS, timeoutStreaks),
    ]);
    // Suite review O2.1 (owner 2026-10-31): an app down is "unavailable" (503, as before); every app
    // up but a background check red is "degraded", still 200 so a load balancer or the deploy's
    // own health wait doesn't take the site out over a backlog.
    const ok = Object.values(apps).every(Boolean);
    return { status: ok ? 200 : 503, body: { status: !ok ? "unavailable" : Object.values(opsChecks).some((c) => c.ok === false) ? "degraded" : "ok", apps, checks: opsChecks } };
  };
  // Fix round 1, N3: one recomputation at a time, shared by every caller that misses the cache
  // while it runs (the endpoint is public on SiteGround).
  let inflight: Promise<Computed> | undefined;
  r.get("/health", async (_req, res) => {
    if (!(cached && cached.expiresAt > Date.now())) {
      inflight ??= compute()
        .then((c) => {
          cached = { expiresAt: Date.now() + HEALTH_CACHE_TTL_MS, ...c };
          return c;
        })
        .finally(() => {
          inflight = undefined;
        });
      const c = await inflight;
      return void res.status(c.status).json({ ...c.body, newsApiSearch, startedAt, pid: process.pid });
    }
    res.status(cached.status).json({ ...cached.body, newsApiSearch, startedAt, pid: process.pid });
  });
  return r;
}

/** `/stack/errors`'s own response-size knob: how many of the persisted ring's entries a single
 * GET returns. Independent of the ring's own cap (ERROR_LOG_RING_LIMIT below) — a caller can
 * ask for fewer than what's kept, up to everything that's kept. */
const ERROR_LOG_DEFAULT_RESPONSE_LIMIT = 200;
const ERROR_LOG_MAX_RESPONSE_LIMIT = 1000;

function errorsRouter(auth: Parameters<typeof requireBearer>[0], entries: () => ErrorEntry[]): Router {
  const r = Router();
  r.get("/errors", requireBearer(auth), requireRole("Core.Admin"), (req, res) => {
    const all = entries();
    const requested = Number(req.query.limit);
    const limit =
      Number.isFinite(requested) && requested > 0
        ? Math.min(Math.trunc(requested), ERROR_LOG_MAX_RESPONSE_LIMIT)
        : ERROR_LOG_DEFAULT_RESPONSE_LIMIT;
    // Suite review O2.3: `?group=1` folds identical messages across the whole kept ring, newest
    // first, at most `limit` groups — what the Hub's Error log shows.
    if (req.query.group === "1") return void res.json({ groups: groupErrors(all, limit), entries: all.length });
    res.json({ errors: all.slice(Math.max(0, all.length - limit)) });
  });
  return r;
}

/**
 * Wires up the whole platform as one Express app, for SiteGround's single-Node-project
 * hosting (see siteground-facts.md): every app's own start<App>() (unchanged — same
 * migrations, same health checks, same auth), mounted under its own path prefix behind one
 * http server, plus the stack-only /stack/tick (driving every app's background workers once
 * per call, for a scheduler to hit on an interval since idle processes are killed — see
 * siteground-facts.md), /stack/health and /stack/errors.
 */
export async function startStack(env: NodeJS.ProcessEnv): Promise<StackHandle> {
  const startedAt = Date.now();
  const stackEnv = parseEnv(stackEnvSchema, env);

  // Fail fast on stale tzdata before any app (each of which also runs this same check for
  // itself) spends time opening DB connections / running migrations.
  const tenant = loadTenantConfig(stackEnv.TENANT_CONFIG);
  assertTimeZoneRules(tenant);

  // Owner decisions 2026-10-31 (production configuration T4): the real production site refuses to
  // start with a setting missing that would otherwise fail silently, before any database or folder
  // is touched, so a deploy fails (and Deploy-GcpeRelease rolls back) instead of going live wrong.
  assertProductionReady(env);

  // The one folder that survives a SiteGround redeploy (site output, uploaded files)
  // — resolved and checked writable before any app starts, so a misconfigured/unwritable
  // DATA_DIR fails fast instead of surfacing later as a silent write failure or a 404 for
  // every /site page after the next deploy.
  const dataDir = resolveDataDir(env);
  await ensureWritableDir(dataDir);

  const actualPort = await determineActualPort(stackEnv.PORT);

  // Fix round 1, P2-R30 important fix 1 + M9: every app's view gets self: URLs resolved, not
  // just NRMS/NEWSAPI's EVENT_SUBSCRIBERS.
  const coreEnv = resolvedEnvFor(env, "CORE", dataDir);
  const nrmsEnv = resolvedEnvFor(env, "NRMS", dataDir);
  const newsApiEnv = resolvedEnvFor(env, "NEWSAPI", dataDir);
  const siteEnv = resolvedEnvFor(env, "SITE", dataDir);
  const nodEnv = resolvedEnvFor(env, "NOD", dataDir);
  const distEnv = resolvedEnvFor(env, "DIST", dataDir);
  const calendarEnv = resolvedEnvFor(env, "CALENDAR", dataDir);
  if (calendarConfigured(env)) {
    assertPrivateDir("CALENDAR_STORAGE_DIR", calendarEnv.STORAGE_DIR!, publicDirs(nrmsEnv.STORAGE_DIR, siteEnv.OUTPUT_DIR, stackEnv.STAFF_WEB_DIR));
    // Unlike the default (under DATA_DIR, already covered by the ensureWritableDir call above),
    // an explicit override is never otherwise written to before someone's first upload.
    await ensureWritableDir(calendarEnv.STORAGE_DIR!);
  }
  // Phase 3c: published records carry absolute file URLs; unless NRMS_PUBLIC_FILES_BASE says
  // otherwise, files are served (below, at /files) from the public site's own origin.
  if (nrmsEnv.PUBLIC_FILES_BASE === undefined) nrmsEnv.PUBLIC_FILES_BASE = publicFilesBase(siteEnv.PUBLIC_SITE_URL ?? tenant.publicSiteBaseUrl);
  // Search results link to the public site this stack serves, not the tenant's production domain.
  if (newsApiEnv.PUBLIC_SITE_URL === undefined) newsApiEnv.PUBLIC_SITE_URL = siteEnv.PUBLIC_SITE_URL ?? tenant.publicSiteBaseUrl;

  // Every self:/… URL resolves to INTERNAL_ORIGIN (http://stack.internal), which this
  // routes into the stack's own Express app in memory — no loopback networking, which
  // SiteGround's sandboxed runtime doesn't allow. Installed BEFORE the apps start because
  // their HTTP clients capture `fetch` when they're created; `stackApp` is assigned below.
  let stackApp: express.Express | undefined;
  const uninstallInternalFetch = installInternalFetch(() => stackApp);

  // Fix round 1, P2-R30 M5: name the app and its env prefix in any startup failure.
  const core: CoreHandle = await startNamed("Core", "CORE", () => startCore(coreEnv));
  // Owner decision 2026-10-31: every app in this process checks a staff cookie with Core (still
  // active, not signed out), so a deactivation is refused on the very next request anywhere, not
  // only in Core. Installed before the other apps start, removed on shutdown.
  const uninstallSessionGate = setSessionGate(core.sessionGate);
  if (!sessionGateInstalled()) throw new Error("[stack] Core's session check was not installed: refusing to start");
  console.log("[stack] staff session check installed for every app");
  const nrms: NrmsHandle = await startNamed("NRMS", "NRMS", () => startNrms(nrmsEnv));
  const nod: NodHandle = await startNamed("NoD", "NOD", () => startNod(nodEnv));
  // The Calendar runs only once its own database has been created (SiteGround: by hand in Site
  // Tools) — every other app still starts normally when it hasn't been yet.
  const calendar: CalendarHandle | null = calendarConfigured(env) ? await startNamed("Calendar", "CALENDAR", () => startCalendar(calendarEnv)) : null;
  if (!calendar) console.warn("[stack] CALENDAR_DATABASE_URL is not set: the Calendar is not mounted (/calendar answers 503)");
  const distribution: DistributionHandle = await startNamed("Distribution", "DIST", () => startDistribution(distEnv));
  const siteBuilder: PublicSiteHandle = await startNamed("Public Site", "SITE", () => startPublicSite(siteEnv));
  const newsApi: NewsApiHandle = await startNamed("News API", "NEWSAPI", () => startNewsApi(newsApiEnv, { hub: stackEnv.UPDATES_HUB_ENABLED }));

  console.log(`[stack] cold start complete in ${Date.now() - startedAt}ms (tenant ${tenant.tenantId}, ${tenant.timeZone})`);

  // 2026-10-04 SiteGround debugging: held only in process memory until now, this log was wiped
  // by every idle-kill restart (docs/deploy/siteground.md "Troubleshooting") — it was nearly
  // always empty by the time anyone checked it. Persisted under DATA_DIR (the same folder that
  // already survives a restart and a redeploy; see data-dir.ts) so it doesn't lose history.
  const errorCapture = installErrorCapture({
    limit: ERROR_LOG_RING_LIMIT,
    filePath: join(dataDir, "logs", "errors.jsonl"),
    startedAt: new Date(startedAt).toISOString(),
  });

  // Once, after the error capture so a stale database lands in errors.jsonl. The Calendar has
  // just migrated its database, so it answers; this never throws and never stops the stack.
  if (calendar) await checkCalendarDbTimeZone(tenant, pgOffsetOf(calendarEnv.DATABASE_URL!));

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", stackEnv.TRUST_PROXY_HOPS); // default 1 hop: SiteGround's nginx / local IIS; 2 behind a DMZ proxy
  // R13: text responses are compressed here, ahead of every mount, so a host whose proxy doesn't
  // compress (the Windows/IIS package) still serves compressed CSS, HTML and JSON (compress.ts).
  app.use(textCompression());

  // startPublicSite(siteEnv) above already validated OUTPUT_DIR (its own schema requires a
  // non-empty string with no default) — if it were missing, that call would already have
  // thrown. The `string | undefined` here is only `envFor`'s own NodeJS.ProcessEnv-shaped
  // return type, not a real possibility at this point.
  const outputDir = siteEnv.OUTPUT_DIR!;

  // Mounted before the no-store default below, so express.static's own maxAge-derived
  // Cache-Control (public, max-age=60) is never overridden by it — a request this static
  // mount actually serves never reaches noStoreByDefault at all. noStoreOnRedirect (M4) sits
  // in front of express.static itself so its *redirect* (a directory request missing its
  // trailing slash) gets no-store too. dotfiles: "deny" (plan 3d task 4 fix round 1) keeps the
  // public site's own `.site-state.json` render-state marker (apps/public-site/src/rebuild.ts)
  // and anything else dot-prefixed under OUTPUT_DIR unservable.
  // Parity P2: news.gov URLs are root-relative, so the site is always served at "/". While
  // PUBLIC_SITE_URL still has a path (boxs.ca's https://boxs.ca/site until the operator flips
  // it), the site is served under that prefix too, with siteNotFound for its unknown pages;
  // once it is the bare origin, /site/<rest>?<query> 301s to /<rest>?<query> (site-mount.ts).
  // Old news.gov.bc.ca URLs (parity plan 3) are answered inside it, never under a SITE_PASS_THROUGH prefix.
  mountSite(app, { outputDir, basePath: siteBasePath(siteEnv.PUBLIC_SITE_URL ?? tenant.publicSiteBaseUrl), passThrough: SITE_PASS_THROUGH, lookupReference: (r) => newsApi.postKeyByReference(r) });

  // Phase 3c: uploaded files from NRMS's STORAGE_DIR (<DATA_DIR>/storage, which survives a
  // redeploy) at /files/<key>. Q17 (owner decision 2026-10-28, C38): a release's translation
  // and media files are served only while the release is live — a draft's, an embargoed
  // (scheduled, not yet gone live) release's, an unpublished or deleted release's file answers
  // the same no-store 404 as an unknown key; staff open them through the Hub instead
  // (GET /nrms/api/releases/:id/files/:fileId). Site files and carousel/pin images are served
  // as before. Content-Type comes from the key's extension, which NRMS forces to match the
  // sniffed bytes (PDF/PNG/JPEG only); nosniff stops a browser second-guessing it. Mounted
  // before the no-store default so the 60 s public cache stands. See files-gate.ts.
  //
  // Legacy news.gov.bc.ca /files/<name>: the legacy Hub's uploads, imported as NRMS site files by
  // legacy-files/cli.ts, are found by name in any letter case (siteFileByName); a path nothing
  // answers is 302'd to legacy's Azure origin (LEGACY_FILES_FALLBACK, on by default) — never for
  // a name staff deleted in the Hub (siteFileDeleted: the 404), nor for releases/ or slides/ (any case): a release file that isn't live stays the plain 404 (Q17).
  // Every /files answer gets files-policy.ts's type, disposition and sandbox CSP.
  app.use(
    "/files",
    ...filesHandlers({
      storageDir: nrmsEnv.STORAGE_DIR!,
      outputDir,
      isPublic: (key) => nrms.releaseFileIsPublic(key),
      siteFileByName: (name) => nrms.siteFileByName(name),
      siteFileDeleted: (name) => nrms.siteFileDeleted(name),
      fallbackOrigin: stackEnv.LEGACY_FILES_FALLBACK ? stackEnv.LEGACY_FILES_ORIGIN : null,
    }),
  );


  // The staff app, hosted at /hub — mounted here (before the no-store
  // default) so /hub/assets' own long-lived Cache-Control isn't overridden by it, same
  // reasoning as /site and /files above. /hub/assets' filenames are content-hashed by the
  // build (esbuild's [hash]), so a year-long immutable cache is safe: a changed file is a
  // changed URL. fallthrough: false means a miss under /hub/assets (a stale or mistyped asset
  // reference) 404s outright — it must never fall through to the SPA-fallback route below and
  // come back as index.html.
  const staffWebDir = stackEnv.STAFF_WEB_DIR;
  const staffWebAssetsDir = join(staffWebDir, "assets");
  if (existsSync(staffWebAssetsDir)) {
    app.use("/hub/assets", express.static(staffWebAssetsDir, { immutable: true, maxAge: "1y", fallthrough: false }));
  }
  // The manuals' "Download as Word" files (/hub/manuals/<manualId>.docx), written by the staff app's
  // build. Not content-hashed, so no long cache: the default revalidating headers apply. A miss 404s
  // here rather than reaching the extension check below, which would 404 it anyway.
  const staffWebManualsDir = join(staffWebDir, "manuals");
  if (existsSync(staffWebManualsDir)) {
    app.use("/hub/manuals", express.static(staffWebManualsDir, { index: false, fallthrough: false }));
  }
  // Deep links (e.g. /hub/releases/<id>) and a plain browser refresh must all resolve to the
  // shell's index.html, which then does its own client-side routing — matched here by "the
  // last path segment has no extension", so a genuinely missing file (anything that looks like
  // a file but isn't under /hub/assets, e.g. a typo'd /hub/favicon.ico) 404s instead of
  // silently becoming the shell (constraints.md review item 5). index.html is never cached —
  // Cache-Control: no-store is set explicitly here since this route runs ahead of
  // noStoreByDefault. When the build directory is missing entirely (never built yet, or a
  // broken deploy), /hub/* answers 503 "Staff app not built" rather than crashing the whole
  // stack — every other mount below (including /stack/health) still starts normally.
  app.use("/hub", (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    res.setHeader("Cache-Control", "no-store");
    // Minors: the staff shell is never meant to be framed by anything (clickjacking) — belt
    // and suspenders, since the two headers cover browsers that only honour one of them.
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    res.setHeader("X-Frame-Options", "DENY");
    const last = req.path.split("/").pop() ?? "";
    if (last.includes(".")) return void res.status(404).end();
    const indexPath = join(staffWebDir, "index.html");
    if (!existsSync(indexPath)) return void res.status(503).send("Staff app not built");
    // `root` keeps send's dotfile check to "index.html" itself: on SiteGround the build lives
    // under ~/.nodeapp/<build>/hub, and an absolute path with a dot segment would 404.
    res.sendFile("index.html", { root: staffWebDir });
  });

  app.use(noStoreByDefault);

  // Fix round 1, P2-R30 M6: /stack/errors's bearer check (and the fake Flickr's switches below)
  // is built from Core's own env view (which, like every app's view, carries the shared
  // ENTRA_TENANT_ID plus its own CORE_AUTH_AUDIENCE) rather than the raw, unprefixed env — Core is
  // the stack's admin app, so its own identity configuration is the one these defer to.
  const errorsAuth = authFromEnv(coreEnv);

  // Phase 3c: no Flickr key on a non-production (or test, or explicitly fake) deployment → a fake
  // Flickr (signature-checking, in-memory photos) that NRMS's env view already points at (envFor
  // sets FLICKR_MODE=fake and the self: URLs; see usesFakeFlickr). Mounted ahead of every app —
  // and of any body parser, since it reads the raw form body its signatures cover. The Flickr
  // API surface (/services/*, /static/*, photo pages) stays public like the real one; the
  // /__fake/* test switches need a Core.Admin bearer or staff session.
  if (usesFakeFlickr(env)) {
    console.warn(`[stack] FLICKR: using the FAKE Flickr at ${FAKE_FLICKR_PATH} — set NRMS_FLICKR_API_KEY etc. for real Flickr`);
    // 2026-10-04 SiteGround debugging: the fake's refuseAuth/outageCalls/deleted switches and
    // every photo's isPublic flag used to live only in this process's memory — SiteGround
    // idle-kills the stack process after 30-60s and cold-starts a brand-new one on the very
    // next request (docs/deploy/siteground.md "Background work scheduler"), which reset all
    // of that mid-scenario. scripts/siteground-flickr-walkthrough.sh --outage polls once a
    // minute, close enough to that idle window that a restart between polls silently cleared
    // refuseAuth and un-published the photo it had just made public, which is why the photo's
    // reported state oscillated (unavailable -> private -> public -> private) instead of
    // settling. statePath, under the same DATA_DIR that already survives this (and a
    // redeploy), makes the fake's test state durable across it, the same way real Flickr's
    // own state would be.
    const fake = createFakeFlickr({ ...FAKE_FLICKR, publicBaseUrl: fakeFlickrPublicBase(siteEnv.PUBLIC_SITE_URL, actualPort), statePath: join(dataDir, "fake-flickr-state.json") });
    app.use(`${FAKE_FLICKR_PATH}/__fake`, requireBearer(errorsAuth.bearer), requireRole("Core.Admin"));
    app.use(FAKE_FLICKR_PATH, fake.router);
  }

  // No Media Hub configured at all (NOD_MEDIA_HUB_URL unset) on a non-production (or test, or
  // explicitly allowed) deployment → a fake Media Hub (deterministic, made-up
  // contacts under example.test) that NoD's own env view already points at (envFor sets
  // MEDIA_HUB_URL=self:/fake-media-hub; see usesFakeMediaHub). Its own service routes
  // (/api/service/*) are gated by the same bearer verifier as everywhere else in this stack,
  // plus the MediaHub.ContactsRead role NoD's service token carries -- the fake package itself
  // has no @gcpe/auth dependency, so it takes that check as an injected middleware rather than
  // building it. The /__fake/* test switches stay Core.Admin-only, same as fake Flickr's.
  if (usesFakeMediaHub(env)) {
    console.warn(`[stack] MEDIA HUB: using the FAKE Media Hub at ${FAKE_MEDIA_HUB_PATH} — set NOD_MEDIA_HUB_URL etc. for a real Media Hub`);
    const fakeMediaHub = createFakeMediaHub({
      statePath: join(dataDir, "fake-media-hub-state.json"),
      requireServiceAuth: [requireBearer(errorsAuth.bearer), requireRole("MediaHub.ContactsRead")],
    });
    app.use(`${FAKE_MEDIA_HUB_PATH}/__fake`, requireBearer(errorsAuth.bearer), requireRole("Core.Admin"));
    app.use(FAKE_MEDIA_HUB_PATH, fakeMediaHub.router);
  }

  // No NOD_EMERGENCY_FEED_URL on a test deployment → a fake alerts feed NoD's env view already
  // points at. The feed itself is public, as the real one is; adding or resetting alerts
  // (/__fake) is Core.Admin-only, as with the other fakes.
  if (usesFakeEmergencyFeed(env)) {
    console.warn(`[stack] EMERGENCY FEED: using the FAKE feed at ${FAKE_EMERGENCY_FEED_PATH} — set NOD_EMERGENCY_FEED_URL for the real one`);
    const fakeFeed = createFakeEmergencyFeed({ statePath: join(dataDir, "fake-emergency-feed-state.json") });
    app.use(`${FAKE_EMERGENCY_FEED_PATH}/__fake`, requireBearer(errorsAuth.bearer), requireRole("Core.Admin"));
    app.use(FAKE_EMERGENCY_FEED_PATH, fakeFeed.router);
  }

  // FAKE_ENTRA_ENABLED=true on a test site → a fake Microsoft sign-in that Core's env view already
  // points at (envFor; see usesFakeEntra). Core reaches it in-process; the browser reaches its
  // picker under CORE_PUBLIC_BASE_URL. It offers only FAKE_ENTRA_IDENTITIES.
  if (usesFakeEntra(env)) {
    console.warn(`[stack] ENTRA: using the FAKE Microsoft sign-in at ${FAKE_ENTRA_PATH} — test sites only`);
    const publicOrigin = new URL(coreEnv.PUBLIC_BASE_URL!).origin;
    const fakeEntra = await createFakeOidc({
      tenantId: FAKE_ENTRA.tenantId,
      clientId: FAKE_ENTRA.clientId,
      clientSecret: FAKE_ENTRA.clientSecret,
      redirectUris: [`${publicOrigin}/core/auth/entra/callback`],
      serverBase: `${INTERNAL_ORIGIN}${FAKE_ENTRA_PATH}`,
      browserBase: `${publicOrigin}${FAKE_ENTRA_PATH}`,
      identities: [...FAKE_ENTRA_IDENTITIES],
    });
    app.use(FAKE_ENTRA_PATH, fakeEntra.router);
  }

  // One combined login-attempt budget (10/min/IP) across every app's local-admin login route
  // and staff sign-in (/core/auth/login), mounted on those exact paths *before* the apps
  // themselves are mounted below. Each app's own localLoginRouter keeps its own 10/min/IP
  // limiter too, so this is an additional, stack-wide ceiling: an attacker spreading guesses
  // across the apps to dodge any single app's limiter still hits this one. The Calendar has no
  // local-admin route (spec §5.1), so it has no path here.
  const combinedLoginLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false });
  app.use(["/core/auth/local/token", "/nrms/auth/local/token", "/nod/auth/local/token", "/distribution/auth/local/token", "/core/auth/login"], combinedLoginLimiter);

  // Suite review O1/O2 (owner 2026-10-31): every app with an outbox (NoD and the public site send
  // no events), in the order the Hub lists them.
  const outboxes = [
    { name: "nrms", outbox: nrms.outbox },
    { name: "core", outbox: core.outbox },
    { name: "distribution", outbox: distribution.outbox },
    { name: "news-api", outbox: newsApi.outbox },
    ...(calendar ? [{ name: "calendar", outbox: calendar.outbox }] : []),
  ];
  const opsSources: OpsSources = {
    outboxes,
    overdueScheduled: (graceMs, timeoutMs) => nrms.overdueScheduled(graceMs, timeoutMs),
    nod: (timeoutMs) => nod.health(timeoutMs),
    rebuildQueue: (timeoutMs) => siteBuilder.rebuildQueue(timeoutMs),
    uptimeMinutes: () => (Date.now() - startedAt) / 60_000,
  };
  app.use("/stack", healthRouter(new Date(startedAt).toISOString(), calendar !== null, newsApi.searchMode, opsSources));
  app.use("/stack", errorsRouter(errorsAuth.bearer, errorCapture.entries));
  app.use("/stack", undeliveredRouter(errorsAuth.bearer, outboxes, core.outboxDismissals));
  app.use(
    "/stack",
    tickRouter(
      stackEnv.TICK_TOKEN,
      createTickRunner([
        // Flickr first, so a photo made public this tick is published with it in the same tick.
        { name: "nrms.flickr", run: worker(nrms, "flickr") },
        // Carousel switch-over before publish: a next carousel that just went live should be
        // what the same tick's publish step (and anything it triggers) sees as current.
        { name: "nrms.site", run: worker(nrms, "site") },
        // Government-term rollover: a term dated weeks ahead goes current at the first tick after
        // 00:00 BC on its date, and publishes the government_terms.published snapshot.
        { name: "nrms.government-terms", run: worker(nrms, "governmentTerms") },
        { name: "nrms.publish", run: worker(nrms, "publish") },
        { name: "nrms.dispatch", run: worker(nrms, "dispatch") },
        // A staged cabinet change scheduled for the swearing-in publishes at the first tick after
        // its time; just before core.dispatch, so its org events go out in the same tick.
        { name: "core.cabinet-changes", run: worker(core, "cabinetChanges") },
        { name: "core.dispatch", run: worker(core, "dispatch") },
        ...(calendar ? [{ name: "calendar.dispatch", run: worker(calendar, "dispatch") }] : []),
        // Deletes edit locks idle for 15 minutes (spec addendum §7.5); a no-op most ticks.
        ...(calendar ? [{ name: "calendar.lock-sweep", run: worker(calendar, "lockSweep") }] : []),
        // Deletes attachment bytes a failed delete left behind: a day old or more and referenced
        // by no row, at most 50 per tick (activities/orphan-sweep.ts).
        ...(calendar ? [{ name: "calendar.orphan-sweep", run: worker(calendar, "orphanSweep") }] : []),
        { name: "news-api.dispatch", run: worker(newsApi, "dispatch") },
        // Embeds up to 50 published posts and recomputes their related posts (spec §5.2). A
        // no-op unless the News API's search mode is semantic; it skips the tick while its
        // breaker is open.
        { name: "news-api.embed", run: worker(newsApi, "embed") },
        // Deletes change-feed rows older than 90 days (spec §5.4); cheap when there are none.
        { name: "news-api.changes-prune", run: worker(newsApi, "changesPrune") },
        // Reads the change feed into the site's rebuild queue and renders up to
        // SITE_SITE_REBUILD_BATCH pages (spec §6.2). After the News API's own steps, so this
        // tick's changes are already in the feed.
        { name: "site.sync", run: worker(siteBuilder, "sync") },
        // The nightly Media Hub sync before the digest: an email address or flag it fixes up
        // this tick should already be current by the time the digest (and anything else this
        // tick does) looks at that subscriber.
        { name: "nod.media-sync", run: worker(nod, "mediaSync") },
        // Self-gated to once a day at 08:00 BC time (bounce-summary.ts) -- a no-op on every
        // other tick, and whenever no NOD_BOUNCE_SUMMARY_EMAIL is configured.
        { name: "nod.bounce-summary", run: worker(nod, "bounceSummary") },
        // Self-gated to every 5 minutes (emergency/ingest.ts). Before nod.send, so an alert
        // recorded this tick goes out in the same tick.
        { name: "nod.emergency-feed", run: worker(nod, "emergencyFeed") },
        // The daily digest, immediately before the sender: a digest job this step just
        // created is picked up by the very same tick's own nod.send, not left for the next one.
        { name: "nod.digest", run: worker(nod, "digest") },
        { name: "nod.send", run: worker(nod, "send") },
        // Self-gated to 03:00 BC nightly (purge.ts): expired send links always, subscribers only
        // while the Operations switch is on. Bounded per tick; a big night finishes over several.
        // After the emergency feed and the sender, so housekeeping never delays an alert.
        { name: "nod.purge", run: worker(nod, "purge") },
        { name: "distribution.send", run: worker(distribution, "send") },
        // Self-gated to once every 15 minutes (distribution/src/bounces/run.ts) — a no-op on
        // every other tick.
        { name: "distribution.bounces", run: worker(distribution, "bounces") },
        // Delivers whatever that same bounces step just enqueued (delivery.bounced, to NoD) —
        // immediately after it, same tick, same pattern as nrms.dispatch/core.dispatch above.
        { name: "distribution.dispatch", run: worker(distribution, "dispatch") },
      ] satisfies TickStep[]),
    ),
  );

  // Specific prefixes first; News API last (it owns "/" and would otherwise swallow every
  // other prefix — see its own app.ts catch-all 404).
  app.use("/core", core.app);
  app.use("/nrms", nrms.app);
  app.use("/nod", nod.app);
  app.use(
    "/calendar",
    calendar ? calendar.app : (_req: express.Request, res: express.Response) => void res.status(503).json({ error: "calendar not configured" }),
  );
  app.use("/distribution", distribution.app);
  app.use("/site-builder", siteBuilder.app);
  // Any other GET/HEAD nothing above served is a public-site page that doesn't exist: the
  // site's own 404.html, not News API's JSON catch-all — except under the stack's own prefixes
  // (News API's /api, /health and /events among them), which keep their own 404s. /updates
  // is the site's (SITE_PASS_THROUGH): only the hub's POST /updates/negotiate goes on to News API.
  app.use(rootSiteNotFound(outputDir, SITE_PASS_THROUGH));
  app.use(newsApi.app);
  stackApp = app;

  // Public-site's self-heal needs the in-process self: fetch, which only becomes usable once
  // `stackApp` above is assigned (installInternalFetch's lookup throws "the stack app is not
  // ready yet" before that). Firing it from inside startPublicSite would always lose that race,
  // since News API (which self-heal reads from over a self: URL) starts after Public Site.
  // Fire-and-forget (startLoops/the caller never awaits this directly), and must never throw
  // past here. A failure logs only safeErrorLabel: the error's message can carry file-system
  // paths or a query's bound values. Kept (below, as a closeBeforeServer entry) so shutdown
  // waits for it to settle before any app's DB pool closes -- otherwise a slow self-heal still
  // running when the pool closes would throw a second, unrelated "self-heal failed" (the pool
  // error, not whatever this run was actually testing) that lands however long after this
  // instance is gone, console.error included.
  const selfHealDone = siteBuilder
    .selfHeal()
    .then((r) => r && console.log(`[public-site] self-heal rebuilt ${r.rebuilt} posts`))
    .catch((e) => console.error("[public-site] self-heal failed", safeErrorLabel(e)));

  // NoD's lists, the Calendar's organizations, terms and users, and (with the Calendar mounted)
  // NRMS's Calendar viewers come from Core's events, which only flow on change. A fresh app with
  // no reference data yet (first deploy, or a fresh database) would otherwise stay empty until each
  // record next changed in Core, so it asks Core to republish everything once; the events reach
  // it on the next dispatch tick. Fire-and-forget, never throws. Kept (below, as a
  // closeBeforeServer entry) for the same reason as selfHealDone above.
  const referenceDataBackfillDone = (async () => {
    try {
      const nodNeeds = (await worker(nod, "needsReferenceData")()) === true;
      const calendarNeeds = calendar ? (await worker(calendar, "needsReferenceData")()) === true : false;
      const nrmsNeeds = calendar ? (await worker(nrms, "needsCalendarViewers")()) === true : false;
      if (nodNeeds || calendarNeeds || nrmsNeeds) {
        const n = await worker(core, "republish")();
        console.log(`[stack] ${[nodNeeds && "NoD", calendarNeeds && "the Calendar", nrmsNeeds && "NRMS"].filter(Boolean).join(" and ")} had no reference data; Core republished ${String(n)} records`);
      }
    } catch (e) {
      console.error("[stack] reference-data backfill failed", safeErrorLabel(e));
    }
  })();

  return {
    app,
    port: actualPort,
    attach: newsApi.attach,
    startLoops() {
      if (!stackEnv.STACK_LOOPS) return;
      core.startLoops();
      nrms.startLoops();
      nod.startLoops();
      calendar?.startLoops();
      distribution.startLoops();
      siteBuilder.startLoops();
      newsApi.startLoops();
    },
    // Mount order: core, nrms, nod, calendar, distribution, siteBuilder, newsApi, then this
    // stack's own two startup-time background turns, both already self-catching -- waited on
    // here only so neither is still touching a pool once the closers below start closing them.
    closeBeforeServer: [
      ...core.closeBeforeServer,
      ...nrms.closeBeforeServer,
      ...nod.closeBeforeServer,
      ...(calendar?.closeBeforeServer ?? []),
      ...distribution.closeBeforeServer,
      ...siteBuilder.closeBeforeServer,
      ...newsApi.closeBeforeServer,
      { name: "public-site self-heal", close: async () => void (await selfHealDone) },
      { name: "stack reference-data backfill", close: async () => void (await referenceDataBackfillDone) },
    ],
    // Reverse mount order, then the error capture last so it's still installed while every
    // other closer's own console.error calls (e.g. a failed shutdown step) run.
    closers: [...newsApi.closers, ...siteBuilder.closers, ...distribution.closers, ...(calendar?.closers ?? []), ...nod.closers, ...nrms.closers, ...core.closers, { name: "error capture", close: () => errorCapture.close() }, { name: "internal fetch", close: () => uninstallInternalFetch() }, { name: "session gate", close: async () => uninstallSessionGate() }],
  };
}

export interface StackCheckAppResult {
  ok: boolean;
  /** The app's resolved MIGRATIONS_FOLDER, when its env parsed successfully. */
  migrationsFolder?: string;
  error?: string;
  /** Set instead of ever being checked, when the app simply isn't configured for this
   * deployment (CALENDAR_DATABASE_URL unset) — `ok` stays true, since an unconfigured optional
   * app is not a failure. */
  skipped?: string;
}

export interface StackCheckResult {
  ok: boolean;
  tenantId?: string;
  timeZone?: string;
  apps: Record<string, StackCheckAppResult>;
  /** A warning only, never part of `ok`: the Calendar database's tzdata (db-time-zone.ts). Absent when the Calendar isn't configured. */
  calendarDbTimeZone?: DbTimeZoneStatus;
  /** Real production's refusals (any error fails `ok`) and warnings; both empty on a test site. */
  production: ProductionProblems;
}

/** Every app the stack runs, with the env schema its start<App>() parses — the Calendar only when
 * it is configured (calendarConfigured). Shared by checkStack and migrateStack. */
function appEnvSchemas(env: NodeJS.ProcessEnv, tenant: ReturnType<typeof loadTenantConfig>): { label: string; prefix: AppPrefix; schema: ZodTypeAny }[] {
  return [
    { label: "core", prefix: "CORE", schema: coreEnvSchema },
    { label: "nrms", prefix: "NRMS", schema: nrmsEnvSchema },
    { label: "news-api", prefix: "NEWSAPI", schema: newsApiEnvSchema },
    { label: "public-site", prefix: "SITE", schema: publicSiteEnvSchema(tenant) },
    { label: "nod", prefix: "NOD", schema: nodEnvSchema },
    { label: "distribution", prefix: "DIST", schema: distributionEnvSchema },
    ...(calendarConfigured(env) ? [{ label: "calendar", prefix: "CALENDAR" as const, schema: calendarEnvSchema }] : []),
  ];
}

/**
 * `node stack.js --check`: validates the stack's configuration — the stack-level
 * env (TICK_TOKEN, tenant config + its P2-R17 time-zone self-check), then every one of the
 * six apps' own env schema, its auth config (`authFromEnv` — ruling P2-R34: a truncated
 * `LOCAL_ADMIN_PASSWORD_HASH`, a too-short `LOCAL_AUTH_SECRET`, a half-set Entra pair, or the
 * production-guard refusal would otherwise only surface at a real `startStack`, not here),
 * and its resolved MIGRATIONS_FOLDER actually existing on disk — all WITHOUT a database pool,
 * migration or write (no `createDb`/`runMigrations` call, unlike `startStack`). The one
 * connection it opens is the Calendar's read-only time-zone probe (`calendarDbTimeZone`), when
 * the Calendar is configured: a warning field that never changes `ok`. This is the
 * SiteGround deploy's build-time and post-deploy smoke test: a misconfigured `<PREFIX>_*` var,
 * or a MIGRATIONS_FOLDER that doesn't resolve relative to the bundled `stack.js` the way
 * main.ts expects, fails fast and names which app and which prefix — instead of surfacing
 * three minutes later as "DATABASE_URL: Required" with six candidates and no way to tell
 * which (the same problem `startNamed` solves for a real `startStack` run).
 */
export async function checkStack(env: NodeJS.ProcessEnv): Promise<StackCheckResult> {
  const stackEnv = parseEnv(stackEnvSchema, env);
  const tenant = loadTenantConfig(stackEnv.TENANT_CONFIG);
  assertTimeZoneRules(tenant);

  // self: URLs need a real port to resolve against; --check never binds a socket (and
  // PORT=0 — "let the OS pick" — has nothing to probe here), so this only has to be a
  // positive integer for the resolved URL's *shape* to come out right. Never dialled.
  const actualPort = stackEnv.PORT || 1;

  // The same DATA_DIR resolution a real startStack() uses, so --check validates each app's
  // SITE_OUTPUT_DIR/NRMS_STORAGE_DIR exactly as they'd actually resolve — but, like the rest
  // of this function, without any filesystem side effect (no ensureWritableDir call; that's
  // exercised by a real startStack()).
  const dataDir = resolveDataDir(env);

  let calendarStorageError: string | null = null;
  if (calendarConfigured(env)) {
    try {
      assertPrivateDir(
        "CALENDAR_STORAGE_DIR",
        resolvedEnvFor(env, "CALENDAR", dataDir).STORAGE_DIR!,
        publicDirs(resolvedEnvFor(env, "NRMS", dataDir).STORAGE_DIR, resolvedEnvFor(env, "SITE", dataDir).OUTPUT_DIR, stackEnv.STAFF_WEB_DIR),
      );
    } catch (e) {
      calendarStorageError = e instanceof Error ? e.message : String(e);
    }
  }

  const checks = appEnvSchemas(env, tenant);

  const apps: Record<string, StackCheckAppResult> = {};
  if (!calendarConfigured(env)) apps.calendar = { ok: true, skipped: "CALENDAR_DATABASE_URL is not set" };
  let ok = true;
  for (const c of checks) {
    // resolvedEnvFor (CORE only) can throw — usesFakeEntra refuses FAKE_ENTRA_ENABLED on a real
    // production deployment or alongside real Entra settings. Report that refusal as this app's
    // own result, the same shape as every other failure here, instead of letting it abort the
    // whole check.
    let view: NodeJS.ProcessEnv;
    try {
      view = resolvedEnvFor(env, c.prefix, dataDir);
    } catch (e) {
      ok = false;
      apps[c.label] = { ok: false, error: `(its variables are ${c.prefix}_*): ${e instanceof Error ? e.message : String(e)}` };
      continue;
    }
    const errors: string[] = [];

    const parsed = c.schema.safeParse(view);
    if (!parsed.success) {
      errors.push(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }

    // P2-R34: every app wires its own auth the same way it does at real startup
    // (authFromEnv(env), called inside start<App>() — see e.g. apps/core/src/start.ts) —
    // --check must exercise the exact same validation, not just each app's own env schema
    // (which has no auth fields at all; auth is deliberately validated separately, the same
    // way it's wired separately at runtime).
    try {
      authFromEnv(view);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
    // Core's sign-in settings (Entra on or off, partial configuration), checked as startCore checks them.
    if (c.prefix === "CORE") {
      try {
        signInSettingsFromEnv(view);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    // The tenant's site-settings defaults, loaded exactly as startPublicSite loads them (it throws
    // on an invalid file) — so a bad file fails --check rather than only the boot.
    if (c.label === "public-site") {
      try {
        loadSiteSettingsDefaults(stackEnv.TENANT_CONFIG, tenant.site.theme);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    if (c.label === "calendar" && calendarStorageError) errors.push(calendarStorageError);
    // The service tokens this app builds at startup, built the same way (only once its env parsed).
    if (parsed.success && errors.length === 0) {
      try {
        buildServiceTokens(c.prefix, parsed.data, view);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }

    if (errors.length > 0) {
      ok = false;
      apps[c.label] = { ok: false, error: `(its variables are ${c.prefix}_*): ${errors.join("; ")}` };
      continue;
    }

    const migrationsFolder = (parsed.data as { MIGRATIONS_FOLDER?: string }).MIGRATIONS_FOLDER;
    const folderOk = migrationsFolder === undefined || existsSync(migrationsFolder);
    if (!folderOk) ok = false;
    apps[c.label] = {
      ok: folderOk,
      migrationsFolder,
      ...(folderOk ? {} : { error: `migrations folder not found: ${migrationsFolder}` }),
    };
  }

  // The one connection --check opens: a single read-only probe of the Calendar's database,
  // bounded by queryOnce's timeout, that can't fail the check.
  const calendarDbTimeZone = calendarConfigured(env) ? await checkCalendarDbTimeZone(tenant, pgOffsetOf(resolvedEnvFor(env, "CALENDAR", dataDir).DATABASE_URL!)) : undefined;
  const production = productionProblems(env);
  if (production.errors.length > 0) ok = false;
  return { ok, tenantId: tenant.tenantId, timeZone: tenant.timeZone, apps, ...(calendarDbTimeZone ? { calendarDbTimeZone } : {}), production };
}

export interface StackMigrateResult {
  ok: boolean;
  apps: Record<string, StackCheckAppResult>;
}

/**
 * `node stack.js --migrate`: applies every configured app's migrations to its own database and
 * returns — no app started, no server, no background loop, nothing written under DATA_DIR. For an
 * orchestrator that migrates before a rollout (an OpenShift Job or initContainer running the same
 * image with the same env as the Deployment: docs/deploy/openshift.md). startStack still migrates
 * on start, exactly as before; both use db-kit's advisory-locked runMigrations, so running both,
 * or several at once, is safe and the later one finds nothing to apply.
 *
 * Each app's env is parsed with the same schema its start<App>() uses (a Job given incomplete
 * settings fails here, as the Deployment would), its failure is reported under its own label and
 * prefix, and the remaining apps are still migrated: their databases are independent.
 */
export async function migrateStack(env: NodeJS.ProcessEnv): Promise<StackMigrateResult> {
  const { TENANT_CONFIG } = parseEnv(stackEnvSchema.pick({ TENANT_CONFIG: true }), env);
  const tenant = loadTenantConfig(TENANT_CONFIG);
  const dataDir = resolveDataDir(env);

  const apps: Record<string, StackCheckAppResult> = {};
  if (!calendarConfigured(env)) apps.calendar = { ok: true, skipped: "CALENDAR_DATABASE_URL is not set" };
  let ok = true;
  for (const c of appEnvSchemas(env, tenant)) {
    const fail = (e: unknown) => {
      ok = false;
      apps[c.label] = { ok: false, error: `(its variables are ${c.prefix}_*): ${e instanceof Error ? e.message : String(e)}` };
    };
    let parsed: { DATABASE_URL: string; MIGRATIONS_FOLDER: string };
    try {
      const result = c.schema.safeParse(resolvedEnvFor(env, c.prefix, dataDir));
      if (!result.success) {
        fail(result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
        continue;
      }
      parsed = result.data as typeof parsed;
    } catch (e) {
      fail(e);
      continue;
    }
    const startedAt = Date.now();
    const { db, pool } = createDb(parsed.DATABASE_URL, { max: 1, connectionTimeoutMillis: 10_000 });
    try {
      await runMigrations(db, parsed.MIGRATIONS_FOLDER);
      apps[c.label] = { ok: true, migrationsFolder: parsed.MIGRATIONS_FOLDER };
      console.log(`[stack] --migrate: ${c.label} up to date (${Date.now() - startedAt}ms)`);
    } catch (e) {
      fail(e);
    } finally {
      await pool.end().catch(() => {});
    }
  }
  return { ok, apps };
}
