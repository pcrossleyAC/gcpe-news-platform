import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express, { Router, type Express } from "express";
import { authFromEnv, requireBearer, requireRole } from "@gcpe/auth";
import { assertTimeZoneRules, loadTenantConfig, parseEnv } from "@gcpe/config";
import type { Closer } from "@gcpe/http-kit";

import { startCore, type AppHandle as CoreHandle } from "../../core/src/start";
import { startDistribution, type AppHandle as DistributionHandle } from "../../distribution/src/start";
import { startNewsApi, type AppHandle as NewsApiHandle } from "../../news-api/src/start";
import { startNod, type AppHandle as NodHandle } from "../../nod/src/start";
import { startNrms, type AppHandle as NrmsHandle } from "../../nrms/src/start";
import { startPublicSite, type AppHandle as PublicSiteHandle } from "../../public-site/src/start";

import { noStoreByDefault } from "./cache-control";
import { installErrorCapture } from "./errors";
import { envFor, resolveSelfSubscribers, stackEnvSchema } from "./env";
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

function withResolvedSubscribers(env: NodeJS.ProcessEnv, actualPort: number): NodeJS.ProcessEnv {
  if (env.EVENT_SUBSCRIBERS === undefined) return env;
  return { ...env, EVENT_SUBSCRIBERS: resolveSelfSubscribers(env.EVENT_SUBSCRIBERS, actualPort) };
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

/** `GET /stack/health`: each mounted app's own `/health/ready`, fetched over the loopback
 * interface at the stack's own (by now listening) port — the only way to reach a readiness
 * check that's wired up *inside* each app's own Express instance (see createApp in every
 * app's app.ts) without reimplementing it here. */
function healthRouter(actualPort: number): Router {
  const checks: { name: string; path: string }[] = [
    { name: "core", path: "/core/health/ready" },
    { name: "nrms", path: "/nrms/health/ready" },
    { name: "nod", path: "/nod/health/ready" },
    { name: "distribution", path: "/distribution/health/ready" },
    { name: "site-builder", path: "/site-builder/health/ready" },
    { name: "news-api", path: "/health/ready" },
  ];
  const r = Router();
  r.get("/health", async (_req, res) => {
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
    res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "unavailable", apps });
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

  const coreEnv = envFor(env, "CORE");
  const nrmsEnv = withResolvedSubscribers(envFor(env, "NRMS"), actualPort);
  const newsApiEnv = withResolvedSubscribers(envFor(env, "NEWSAPI"), actualPort);
  const siteEnv = envFor(env, "SITE");
  const nodEnv = envFor(env, "NOD");
  const distEnv = envFor(env, "DIST");

  const core: CoreHandle = await startCore(coreEnv);
  const nrms: NrmsHandle = await startNrms(nrmsEnv);
  const nod: NodHandle = await startNod(nodEnv);
  const distribution: DistributionHandle = await startDistribution(distEnv);
  const siteBuilder: PublicSiteHandle = await startPublicSite(siteEnv);
  const newsApi: NewsApiHandle = await startNewsApi(newsApiEnv, { hub: stackEnv.UPDATES_HUB_ENABLED });

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
  // mount actually serves never reaches noStoreByDefault at all.
  app.use("/site", express.static(outputDir, { index: "index.html", maxAge: SITE_MAX_AGE_MS }));

  app.use(noStoreByDefault);

  const auth = authFromEnv(env);
  app.use("/stack", healthRouter(actualPort));
  app.use("/stack", errorsRouter(auth.bearer, errorCapture.entries));
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
