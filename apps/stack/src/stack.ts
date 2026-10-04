import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express, { Router, type Express } from "express";
import rateLimit from "express-rate-limit";
import type { ZodTypeAny } from "zod";
import { authFromEnv, requireBearer, requireRole } from "@gcpe/auth";
import { assertTimeZoneRules, loadTenantConfig, parseEnv } from "@gcpe/config";
import type { Closer } from "@gcpe/http-kit";

import { coreEnvSchema, startCore, type AppHandle as CoreHandle } from "../../core/src/start";
import { distributionEnvSchema } from "../../distribution/src/env";
import { startDistribution, type AppHandle as DistributionHandle } from "../../distribution/src/start";
import { newsApiEnvSchema } from "../../news-api/src/env";
import { startNewsApi, type AppHandle as NewsApiHandle } from "../../news-api/src/start";
import { nodEnvSchema, startNod, type AppHandle as NodHandle } from "../../nod/src/start";
import { nrmsEnvSchema, startNrms, type AppHandle as NrmsHandle } from "../../nrms/src/start";
import { publicSiteEnvSchema } from "../../public-site/src/env";
import { startPublicSite, type AppHandle as PublicSiteHandle } from "../../public-site/src/start";

import { noStoreByDefault, noStoreOnRedirect } from "./cache-control";
import { installErrorCapture } from "./errors";
import { envFor, resolveSelfUrls, type AppPrefix, stackEnvSchema } from "./env";
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

/** The static site's own cache lifetime (brief: "the static /site files get Cache-Control:
 * public, max-age=60"). express.static's `maxAge` option wants milliseconds. */
const SITE_MAX_AGE_MS = 60_000;

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
 * other `*_URL` var — see `resolveSelfUrls`) resolved to the stack's own loopback port. Fix
 * round 1, P2-R30 important fix 1: applied to every app, not just NRMS/NEWSAPI — Core's own
 * EVENT_SUBSCRIBERS needs this exactly as much as NRMS's does (Core publishes org.upserted
 * the same way NRMS publishes release.published).
 */
function resolvedEnvFor(env: NodeJS.ProcessEnv, prefix: AppPrefix, actualPort: number): NodeJS.ProcessEnv {
  return resolveSelfUrls(envFor(env, prefix), actualPort);
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
 */
function healthRouter(actualPort: number): Router {
  const checks: { name: string; path: string }[] = [
    { name: "core", path: "/core/health/ready" },
    { name: "nrms", path: "/nrms/health/ready" },
    { name: "nod", path: "/nod/health/ready" },
    { name: "distribution", path: "/distribution/health/ready" },
    { name: "site-builder", path: "/site-builder/health/ready" },
    { name: "news-api", path: "/health/ready" },
  ];
  let cached: { expiresAt: number; status: number; body: { status: string; apps: Record<string, boolean> } } | undefined;
  const r = Router();
  r.get("/health", async (_req, res) => {
    if (cached && cached.expiresAt > Date.now()) {
      return void res.status(cached.status).json(cached.body);
    }
    const apps: Record<string, boolean> = {};
    await Promise.all(
      checks.map(async ({ name, path }) => {
        try {
          const response = await fetch(`http://127.0.0.1:${actualPort}${path}`);
          apps[name] = response.ok;
        } catch {
          apps[name] = false;
        }
      }),
    );
    const ok = Object.values(apps).every(Boolean);
    const status = ok ? 200 : 503;
    const body = { status: ok ? "ok" : "unavailable", apps };
    cached = { expiresAt: Date.now() + HEALTH_CACHE_TTL_MS, status, body };
    res.status(status).json(body);
  });
  return r;
}

function errorsRouter(auth: Parameters<typeof requireBearer>[0], entries: () => { timestamp: string; message: string }[]): Router {
  const r = Router();
  r.get("/errors", requireBearer(auth), requireRole("Core.Admin"), (_req, res) => {
    res.json({ errors: entries() });
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

  const actualPort = await determineActualPort(stackEnv.PORT);

  // Fix round 1, P2-R30 important fix 1 + M9: every app's view gets self: URLs resolved, not
  // just NRMS/NEWSAPI's EVENT_SUBSCRIBERS.
  const coreEnv = resolvedEnvFor(env, "CORE", actualPort);
  const nrmsEnv = resolvedEnvFor(env, "NRMS", actualPort);
  const newsApiEnv = resolvedEnvFor(env, "NEWSAPI", actualPort);
  const siteEnv = resolvedEnvFor(env, "SITE", actualPort);
  const nodEnv = resolvedEnvFor(env, "NOD", actualPort);
  const distEnv = resolvedEnvFor(env, "DIST", actualPort);

  // Fix round 1, P2-R30 M5: name the app and its env prefix in any startup failure.
  const core: CoreHandle = await startNamed("Core", "CORE", () => startCore(coreEnv));
  const nrms: NrmsHandle = await startNamed("NRMS", "NRMS", () => startNrms(nrmsEnv));
  const nod: NodHandle = await startNamed("NoD", "NOD", () => startNod(nodEnv));
  const distribution: DistributionHandle = await startNamed("Distribution", "DIST", () => startDistribution(distEnv));
  const siteBuilder: PublicSiteHandle = await startNamed("Public Site", "SITE", () => startPublicSite(siteEnv));
  const newsApi: NewsApiHandle = await startNamed("News API", "NEWSAPI", () => startNewsApi(newsApiEnv, { hub: stackEnv.UPDATES_HUB_ENABLED }));

  console.log(`[stack] cold start complete in ${Date.now() - startedAt}ms (tenant ${tenant.tenantId}, ${tenant.timeZone})`);

  const errorCapture = installErrorCapture();

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // one hop: SiteGround's nginx

  // startPublicSite(siteEnv) above already validated OUTPUT_DIR (its own schema requires a
  // non-empty string with no default) — if it were missing, that call would already have
  // thrown. The `string | undefined` here is only `envFor`'s own NodeJS.ProcessEnv-shaped
  // return type, not a real possibility at this point.
  const outputDir = siteEnv.OUTPUT_DIR!;

  // Mounted before the no-store default below, so express.static's own maxAge-derived
  // Cache-Control (public, max-age=60) is never overridden by it — a request this static
  // mount actually serves never reaches noStoreByDefault at all. noStoreOnRedirect (M4) sits
  // in front of express.static itself so its *redirect* (a directory request missing its
  // trailing slash) gets no-store too, instead of the bare, cacheable-by-default 301
  // express.static would otherwise send.
  app.use("/site", noStoreOnRedirect, express.static(outputDir, { index: "index.html", maxAge: SITE_MAX_AGE_MS }));

  app.use(noStoreByDefault);

  // Fix round 1, P2-R30 M7: one combined login-attempt budget (10/min/IP) across every
  // app's local-admin login route, mounted on those exact paths *before* the apps themselves
  // are mounted below — each app's own localLoginRouter still has its own independent
  // 10/min/IP limiter too (unchanged), so this is an additional, stack-wide ceiling on top,
  // not a replacement: an attacker spreading guesses across /core, /nrms, /nod and
  // /distribution to dodge any single app's limiter still hits this one.
  const combinedLoginLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false });
  app.use(["/core/auth/local/token", "/nrms/auth/local/token", "/nod/auth/local/token", "/distribution/auth/local/token"], combinedLoginLimiter);

  // Fix round 1, P2-R30 M6: /stack/errors's bearer check is built from Core's own env view
  // (which, like every app's view, now carries the shared ENTRA_TENANT_ID plus its own
  // CORE_AUTH_AUDIENCE) rather than the raw, unprefixed env — Core is the stack's admin app,
  // so its own identity configuration is the one /stack/errors defers to.
  const errorsAuth = authFromEnv(coreEnv);
  app.use("/stack", healthRouter(actualPort));
  app.use("/stack", errorsRouter(errorsAuth.bearer, errorCapture.entries));
  app.use(
    "/stack",
    tickRouter(
      stackEnv.TICK_TOKEN,
      createTickRunner([
        { name: "nrms.publish", run: worker(nrms, "publish") },
        { name: "nrms.dispatch", run: worker(nrms, "dispatch") },
        { name: "core.dispatch", run: worker(core, "dispatch") },
        { name: "news-api.dispatch", run: worker(newsApi, "dispatch") },
        { name: "nod.send", run: worker(nod, "send") },
        { name: "distribution.send", run: worker(distribution, "send") },
      ] satisfies TickStep[]),
    ),
  );

  // Specific prefixes first; News API last (it owns "/" and would otherwise swallow every
  // other prefix — see its own app.ts catch-all 404).
  app.use("/core", core.app);
  app.use("/nrms", nrms.app);
  app.use("/nod", nod.app);
  app.use("/distribution", distribution.app);
  app.use("/site-builder", siteBuilder.app);
  app.use(newsApi.app);

  return {
    app,
    port: actualPort,
    attach: newsApi.attach,
    startLoops() {
      if (!stackEnv.STACK_LOOPS) return;
      core.startLoops();
      nrms.startLoops();
      nod.startLoops();
      distribution.startLoops();
      siteBuilder.startLoops();
      newsApi.startLoops();
    },
    // Mount order: core, nrms, nod, distribution, siteBuilder, newsApi.
    closeBeforeServer: [...core.closeBeforeServer, ...nrms.closeBeforeServer, ...nod.closeBeforeServer, ...distribution.closeBeforeServer, ...siteBuilder.closeBeforeServer, ...newsApi.closeBeforeServer],
    // Reverse mount order, then the error capture last so it's still installed while every
    // other closer's own console.error calls (e.g. a failed shutdown step) run.
    closers: [...newsApi.closers, ...siteBuilder.closers, ...distribution.closers, ...nod.closers, ...nrms.closers, ...core.closers, { name: "error capture", close: () => errorCapture.close() }],
  };
}

export interface StackCheckAppResult {
  ok: boolean;
  /** The app's resolved MIGRATIONS_FOLDER, when its env parsed successfully. */
  migrationsFolder?: string;
  error?: string;
}

export interface StackCheckResult {
  ok: boolean;
  tenantId?: string;
  timeZone?: string;
  apps: Record<string, StackCheckAppResult>;
}

/**
 * Task 15's `node stack.js --check`: validates the stack's configuration — the stack-level
 * env (TICK_TOKEN, tenant config + its P2-R17 time-zone self-check), then every one of the
 * six apps' own env schema and its resolved MIGRATIONS_FOLDER actually existing on disk —
 * all WITHOUT opening a single database connection (no `createDb`/`runMigrations` call, unlike
 * `startStack`). This is the SiteGround deploy's build-time and post-deploy smoke test: a
 * misconfigured `<PREFIX>_*` var, or a MIGRATIONS_FOLDER that doesn't resolve relative to the
 * bundled `stack.js` the way main.ts expects, fails fast and names which app and which prefix
 * — instead of surfacing three minutes later as "DATABASE_URL: Required" with six candidates
 * and no way to tell which (the same problem `startNamed` solves for a real `startStack` run).
 */
export async function checkStack(env: NodeJS.ProcessEnv): Promise<StackCheckResult> {
  const stackEnv = parseEnv(stackEnvSchema, env);
  const tenant = loadTenantConfig(stackEnv.TENANT_CONFIG);
  assertTimeZoneRules(tenant);

  // self: URLs need a real port to resolve against; --check never binds a socket (and
  // PORT=0 — "let the OS pick" — has nothing to probe here), so this only has to be a
  // positive integer for the resolved URL's *shape* to come out right. Never dialled.
  const actualPort = stackEnv.PORT || 1;

  const checks: { label: string; prefix: AppPrefix; schema: ZodTypeAny }[] = [
    { label: "core", prefix: "CORE", schema: coreEnvSchema },
    { label: "nrms", prefix: "NRMS", schema: nrmsEnvSchema },
    { label: "news-api", prefix: "NEWSAPI", schema: newsApiEnvSchema },
    { label: "public-site", prefix: "SITE", schema: publicSiteEnvSchema(tenant) },
    { label: "nod", prefix: "NOD", schema: nodEnvSchema },
    { label: "distribution", prefix: "DIST", schema: distributionEnvSchema },
  ];

  const apps: Record<string, StackCheckAppResult> = {};
  let ok = true;
  for (const c of checks) {
    const view = resolvedEnvFor(env, c.prefix, actualPort);
    const parsed = c.schema.safeParse(view);
    if (!parsed.success) {
      ok = false;
      const message = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      apps[c.label] = { ok: false, error: `(its variables are ${c.prefix}_*): ${message}` };
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

  return { ok, tenantId: tenant.tenantId, timeZone: tenant.timeZone, apps };
}
