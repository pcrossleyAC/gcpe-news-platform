import { existsSync } from "node:fs";
import { join } from "node:path";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express, { Router, type Express } from "express";
import rateLimit from "express-rate-limit";
import type { ZodTypeAny } from "zod";
import { authFromEnv, requireBearer, requireRole } from "@gcpe/auth";
import { assertTimeZoneRules, loadTenantConfig, parseEnv } from "@gcpe/config";
import { createFakeFlickr } from "@gcpe/flickr-fake";
import { createFakeMediaHub } from "@gcpe/media-hub-fake";
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
import { ensureWritableDir, resolveDataDir } from "./data-dir";
import { INTERNAL_ORIGIN, installInternalFetch } from "./internal-fetch";
import { installErrorCapture, type ErrorEntry } from "./errors";
import {
  envFor,
  FAKE_FLICKR,
  FAKE_FLICKR_PATH,
  FAKE_MEDIA_HUB_PATH,
  resolveSelfUrls,
  type AppPrefix,
  stackEnvSchema,
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

/** The static site's own cache lifetime (brief: "the static /site files get Cache-Control:
 * public, max-age=60"). express.static's `maxAge` option wants milliseconds. */
const SITE_MAX_AGE_MS = 60_000;
/** Uploaded release files under /files (same one-minute public lifetime). */
const FILES_MAX_AGE_MS = 60_000;

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
 * other `*_URL` var — see `resolveSelfUrls`) resolved to the stack's own loopback port. Fix
 * round 1, P2-R30 important fix 1: applied to every app, not just NRMS/NEWSAPI — Core's own
 * EVENT_SUBSCRIBERS needs this exactly as much as NRMS's does (Core publishes org.upserted
 * the same way NRMS publishes release.published).
 *
 * `dataDir` (Task 1) is threaded through to `envFor` so NRMS's STORAGE_DIR and a relative
 * SITE_OUTPUT_DIR both anchor under the one persistent folder that survives a redeploy.
 */
function resolvedEnvFor(env: NodeJS.ProcessEnv, prefix: AppPrefix, dataDir: string): NodeJS.ProcessEnv {
  return resolveSelfUrls(envFor(env, prefix, dataDir));
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
 */
function healthRouter(startedAt: string): Router {
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
      return void res.status(cached.status).json({ ...cached.body, startedAt, pid: process.pid });
    }
    const apps: Record<string, boolean> = {};
    await Promise.all(
      checks.map(async ({ name, path }) => {
        try {
          const response = await fetch(`${INTERNAL_ORIGIN}${path}`);
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
    res.status(status).json({ ...body, startedAt, pid: process.pid });
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

  // Task 1: the one folder that survives a SiteGround redeploy (site output, uploaded files)
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
  // Phase 3c: published records carry absolute file URLs; unless NRMS_PUBLIC_FILES_BASE says
  // otherwise, files are served (below, at /files) from the public site's own origin.
  if (nrmsEnv.PUBLIC_FILES_BASE === undefined) nrmsEnv.PUBLIC_FILES_BASE = publicFilesBase(siteEnv.PUBLIC_SITE_URL ?? tenant.publicSiteBaseUrl);

  // Every self:/… URL resolves to INTERNAL_ORIGIN (http://stack.internal), which this
  // routes into the stack's own Express app in memory — no loopback networking, which
  // SiteGround's sandboxed runtime doesn't allow. Installed BEFORE the apps start because
  // their HTTP clients capture `fetch` when they're created; `stackApp` is assigned below.
  let stackApp: express.Express | undefined;
  const uninstallInternalFetch = installInternalFetch(() => stackApp);

  // Fix round 1, P2-R30 M5: name the app and its env prefix in any startup failure.
  const core: CoreHandle = await startNamed("Core", "CORE", () => startCore(coreEnv));
  const nrms: NrmsHandle = await startNamed("NRMS", "NRMS", () => startNrms(nrmsEnv));
  const nod: NodHandle = await startNamed("NoD", "NOD", () => startNod(nodEnv));
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
  // express.static would otherwise send. dotfiles: "deny" (plan 3d task 4 fix round 1) is set
  // explicitly for the public site's own `.site-state.json` render-state marker
  // (apps/public-site/src/rebuild.ts) and anything else dot-prefixed under OUTPUT_DIR — "ignore"
  // (serve-static's default) already keeps a dotfile unservable too, so this changes no
  // observable behaviour (both fall through, with the default fallthrough: true, to the
  // same eventual 404), but says explicitly that a dotfile is refused on purpose, not by
  // accident of the default.
  app.use("/site", noStoreOnRedirect, express.static(outputDir, { index: "index.html", maxAge: SITE_MAX_AGE_MS, dotfiles: "deny" }));

  // Phase 3c: uploaded release files (translations, media assets) from NRMS's STORAGE_DIR
  // (<DATA_DIR>/storage, which survives a redeploy), publicly downloadable at /files/<key>.
  // A file becomes downloadable as soon as it's uploaded — including on a draft, before
  // approval or embargo lifts (addReleaseFile in apps/nrms/src/media/files.ts checks the
  // file's type, not the release's status; see open question Q17 in
  // docs/parity/open-questions.md, and C38 in docs/parity/changes-from-legacy.md) — but every
  // key carries a 16-hex random part, so nothing is guessable or listable (no index, no
  // directory redirects). The store's `.meta` folder is refused by dotfiles: "deny".
  // Content-Type comes from the key's extension, which NRMS forces to match the sniffed bytes
  // (PDF/PNG/JPEG only); nosniff stops a browser second-guessing it. Mounted before the
  // no-store default so the 60 s public cache stands.
  const storageDir = nrmsEnv.STORAGE_DIR!;
  app.use(
    "/files",
    express.static(storageDir, {
      index: false,
      redirect: false,
      dotfiles: "deny",
      fallthrough: false,
      maxAge: FILES_MAX_AGE_MS,
      setHeaders: (res) => res.setHeader("X-Content-Type-Options", "nosniff"),
    }),
  );

  // Task 1 (staff-web): the staff app, hosted at /hub — mounted here (before the no-store
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

  // Fix round 1, P2-R30 M7: one combined login-attempt budget (10/min/IP) across every
  // app's local-admin login route, mounted on those exact paths *before* the apps themselves
  // are mounted below — each app's own localLoginRouter still has its own independent
  // 10/min/IP limiter too (unchanged), so this is an additional, stack-wide ceiling on top,
  // not a replacement: an attacker spreading guesses across /core, /nrms, /nod and
  // /distribution to dodge any single app's limiter still hits this one. Task 6: staff sign-in
  // (/core/auth/login) shares this same stack-wide budget, not a separate one.
  const combinedLoginLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false });
  app.use(
    ["/core/auth/local/token", "/nrms/auth/local/token", "/nod/auth/local/token", "/distribution/auth/local/token", "/core/auth/login"],
    combinedLoginLimiter,
  );

  app.use("/stack", healthRouter(new Date(startedAt).toISOString()));
  app.use("/stack", errorsRouter(errorsAuth.bearer, errorCapture.entries));
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
        { name: "nrms.publish", run: worker(nrms, "publish") },
        { name: "nrms.dispatch", run: worker(nrms, "dispatch") },
        { name: "core.dispatch", run: worker(core, "dispatch") },
        { name: "news-api.dispatch", run: worker(newsApi, "dispatch") },
        // The daily digest, immediately before the sender: a digest job this step just
        // created is picked up by the very same tick's own nod.send, not left for the next one.
        { name: "nod.digest", run: worker(nod, "digest") },
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
  stackApp = app;

  // Fix round 1: public-site's self-heal needs the in-process self: fetch, which only becomes
  // usable once `stackApp` above is assigned (installInternalFetch's lookup throws "the stack
  // app is not ready yet" before that) — firing it from inside startPublicSite itself (the
  // original Task 1 approach) always lost that race, since News API (which self-heal reads
  // from over a self: URL) starts after Public Site. Fire-and-forget, same logging as the
  // standalone main.ts does, and must never throw past here.
  void siteBuilder
    .selfHeal()
    .then((r) => r && console.log(`[public-site] self-heal rebuilt ${r.rebuilt} posts`))
    .catch((e) => console.error(`[public-site] self-heal failed: ${e instanceof Error ? e.message : e}`));

  // Phase 4a: NoD's lists come from Core's events, which only flow on change. A NoD with no
  // ministry lists yet (first deploy, or a fresh database) asks Core to republish everything
  // once; the events reach NoD on the next dispatch tick. Fire-and-forget, never throws.
  void (async () => {
    try {
      if (await worker(nod, "needsReferenceData")()) {
        const n = await worker(core, "republish")();
        console.log(`[stack] NoD had no lists; Core republished ${String(n)} reference records`);
      }
    } catch (e) {
      console.error("[stack] reference-data backfill failed", e instanceof Error ? e.message : e);
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
      distribution.startLoops();
      siteBuilder.startLoops();
      newsApi.startLoops();
    },
    // Mount order: core, nrms, nod, distribution, siteBuilder, newsApi.
    closeBeforeServer: [...core.closeBeforeServer, ...nrms.closeBeforeServer, ...nod.closeBeforeServer, ...distribution.closeBeforeServer, ...siteBuilder.closeBeforeServer, ...newsApi.closeBeforeServer],
    // Reverse mount order, then the error capture last so it's still installed while every
    // other closer's own console.error calls (e.g. a failed shutdown step) run.
    closers: [...newsApi.closers, ...siteBuilder.closers, ...distribution.closers, ...nod.closers, ...nrms.closers, ...core.closers, { name: "error capture", close: () => errorCapture.close() }, { name: "internal fetch", close: () => uninstallInternalFetch() }],
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
 * six apps' own env schema, its auth config (`authFromEnv` — ruling P2-R34: a truncated
 * `LOCAL_ADMIN_PASSWORD_HASH`, a too-short `LOCAL_AUTH_SECRET`, a half-set Entra pair, or the
 * production-guard refusal would otherwise only surface at a real `startStack`, not here),
 * and its resolved MIGRATIONS_FOLDER actually existing on disk — all WITHOUT opening a single
 * database connection (no `createDb`/`runMigrations` call, unlike `startStack`). This is the
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

  // Task 1: the same DATA_DIR resolution a real startStack() uses, so --check validates each
  // app's SITE_OUTPUT_DIR/NRMS_STORAGE_DIR exactly as they'd actually resolve — but, like the
  // rest of this function, without any filesystem side effect (no ensureWritableDir call;
  // that's exercised by a real startStack()).
  const dataDir = resolveDataDir(env);

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
    const view = resolvedEnvFor(env, c.prefix, dataDir);
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

  return { ok, tenantId: tenant.tenantId, timeZone: tenant.timeZone, apps };
}
