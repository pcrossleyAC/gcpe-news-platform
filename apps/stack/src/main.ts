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
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown());
}
