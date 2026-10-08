import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { closeServer, createShutdown } from "@gcpe/http-kit";
import { checkStack, startStack } from "./stack";

/**
 * Task 15: when main.ts is bundled by `scripts/build-siteground.mjs` into one flat
 * `dist/siteground/stack.js`, every app's own `MIGRATIONS_FOLDER` default (each app's own
 * `start.ts`/`env.ts`, e.g. `fileURLToPath(new URL("../migrations", import.meta.url))`) and
 * the stack's own `TENANT_CONFIG` default (`env.ts`) are computed *once*, at module
 * initialization, from `import.meta.url` — which after bundling is the single output file's
 * URL (`stack.js`), not the original source file's. Every app's default would then resolve to
 * the exact same wrong path (one level above the bundle, not the per-app `migrations/<app>`
 * folder the build script actually copies next to it).
 *
 * Rather than patch every app's schema default for a bundling concern specific to this one
 * deployment target, the artifact instead carries its own `migrations/<app>` folders and
 * `config/` next to `stack.js` (see the build script), and main.ts fills in the matching
 * `<PREFIX>_MIGRATIONS_FOLDER` / `TENANT_CONFIG` env vars *before* calling `startStack`/
 * `checkStack` — but only when the operator hasn't already set them AND the artifact's own
 * folder actually exists next to this file. That `existsSync` guard is what keeps this a
 * no-op everywhere else: unbundled (`tsx watch src/main.ts`, every test — none of which import
 * main.ts, but defence in depth costs nothing here) `import.meta.url` is this very file under
 * `apps/stack/src/`, and `./migrations/<app>` next to *that* never exists, so every app keeps
 * using its own normal default.
 */
const ARTIFACT_MIGRATIONS_DIRS: Record<string, string> = {
  CORE_MIGRATIONS_FOLDER: "core",
  NRMS_MIGRATIONS_FOLDER: "nrms",
  NEWSAPI_MIGRATIONS_FOLDER: "news-api",
  SITE_MIGRATIONS_FOLDER: "public-site",
  NOD_MIGRATIONS_FOLDER: "nod",
  DIST_MIGRATIONS_FOLDER: "distribution",
  CALENDAR_MIGRATIONS_FOLDER: "calendar",
};

function applyArtifactDefaults(env: NodeJS.ProcessEnv): void {
  for (const [key, dir] of Object.entries(ARTIFACT_MIGRATIONS_DIRS)) {
    if (env[key]) continue;
    const candidate = fileURLToPath(new URL(`./migrations/${dir}/`, import.meta.url));
    if (existsSync(candidate)) env[key] = candidate;
  }
  if (!env.TENANT_CONFIG) {
    const candidate = fileURLToPath(new URL("./config/tenants/bc.json", import.meta.url));
    if (existsSync(candidate)) env.TENANT_CONFIG = candidate;
  }
}

applyArtifactDefaults(process.env);

/**
 * 2026-10-04 SiteGround debugging (scripts/siteground-flickr-walkthrough.sh --outage): Node
 * 24 exits on an unhandled rejection by default (and always has on an uncaught exception) —
 * with no handler of our own, that exit is silent from SiteGround's side: there is no
 * reachable runtime log over SSH (siteground-facts.md), the crash looks identical to an
 * ordinary 30-60s idle-kill cold start, and nothing durable records that it happened at all
 * or why. These two handlers log first (through console.error, so once `startStack` has
 * installed its capture below, the message also reaches `GET /stack/errors` for the *next*
 * process to show) and then exit anyway — deliberately, not a change in outcome:
 *
 * - Investigation here found the actual cause of the restarts seen on boxs.ca was something
 *   else entirely (the documented idle-kill, not a crash — see docs/deploy/siteground.md and
 *   packages/flickr-fake's new `statePath`), so there's no evidence a real unhandled
 *   rejection has ever reached this process. If one ever does, though, it means some promise
 *   somewhere was never awaited — i.e. an invariant this codebase doesn't otherwise check for
 *   broke in a way nothing here was written to recover from (a half-finished write, a
 *   listener left in a torn state). Continuing to serve requests after that is a worse bet
 *   than restarting clean.
 * - SiteGround already cold-starts a brand-new process, cheaply (well under a second for all
 *   six apps), on the very next request/tick regardless of why the last one stopped — so
 *   exiting here costs nothing beyond what idle-kill already costs continuously in normal
 *   operation.
 *
 * Shuts down the same way a SIGTERM would (DB pools closed, etc.) when `shutdown` has been
 * assigned below already; falls back to a bare exit if the crash happens during startup,
 * before there's anything to shut down.
 */
let shutdownOnCrash: (() => Promise<void>) | undefined;
function crash(kind: string, err: unknown): void {
  console.error(`[stack] ${kind} — exiting so the platform restarts clean`, err);
  if (shutdownOnCrash) {
    void shutdownOnCrash();
  } else {
    process.exit(1);
  }
}
process.on("unhandledRejection", (reason) => crash("unhandled rejection", reason));
process.on("uncaughtException", (err) => crash("uncaught exception", err));

/**
 * `node stack.js --check`: validates config (every app's env schema, its resolved
 * MIGRATIONS_FOLDER existing on disk, and the tenant config's time-zone self-check) and exits
 * — no database connection, no listening server. Used by the build script as a build-time
 * smoke test, and by the deploy runbook as a post-deploy one (SSH, before relying on the
 * cron-driven `/stack/tick`).
 */
if (process.argv.includes("--check")) {
  try {
    const result = await checkStack(process.env);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  } catch (e) {
    console.error("[stack] --check failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

const handle = await startStack(process.env);
const server = createServer(handle.app);
handle.attach?.(server);
handle.startLoops();
server.listen(handle.port, () => console.log(`[stack] listening on ${handle.port}`));

const shutdown = createShutdown({
  logPrefix: "[stack]",
  exit: process.exit,
  closers: [...handle.closeBeforeServer, { name: "http server", close: () => closeServer(server) }, ...handle.closers],
});
shutdownOnCrash = shutdown;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown());
}
