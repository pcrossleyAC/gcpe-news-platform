// Task 15: builds the SiteGround artifact — a fully self-contained dist/siteground/ directory
// SiteGround's GitHub-deploy-with-no-build-command can run as-is: `node stack.js`. Unlike
// scripts/build-app.mjs (used by the six per-app Docker images), every npm dependency is
// bundled IN, not left external — SiteGround's own build pipeline deletes package-lock.json
// and runs `npm install` with nothing in package.json's "dependencies" to resolve, so the
// bundle itself has to carry express, drizzle-orm, pg, nodemailer, jose, zod, ws and
// express-rate-limit (see siteground-facts.md).
//
// Usage: node scripts/build-siteground.mjs
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const outDir = join(root, "dist/siteground");

// Only genuinely optional native add-ons stay external (see task-15-brief.md): pg-native is
// an opt-in peer dependency `pg` itself never imports unconditionally; bufferutil and
// utf-8-validate are `ws`'s optional native accelerators (pure-JS fallbacks ship in `ws`
// itself). Nothing else in the dependency graph (express, drizzle-orm, pg, nodemailer, jose,
// zod, ws, express-rate-limit, and every @gcpe/* workspace package) is excluded — all of it
// bundles cleanly into one file.
const EXTERNAL = ["pg-native", "bufferutil", "utf-8-validate"];

// Every app whose migrations/ folder (and env-prefix) the stack mounts, in the same order
// apps/stack/src/main.ts's ARTIFACT_MIGRATIONS_DIRS lists them.
const APPS = ["core", "nrms", "news-api", "public-site", "nod", "distribution"];

console.log("[build-siteground] cleaning dist/siteground …");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

console.log("[build-siteground] bundling apps/stack/src/main.ts …");
const result = await build({
  entryPoints: [join(root, "apps/stack/src/main.ts")],
  outfile: join(outDir, "stack.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: EXTERNAL,
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  metafile: true,
  logLevel: "info",
});

const bundleBytes = statSync(join(outDir, "stack.js")).size;
console.log(`[build-siteground] stack.js: ${(bundleBytes / 1024 / 1024).toFixed(2)} MiB`);
writeFileSync(join(outDir, "esbuild-metafile.json"), JSON.stringify(result.metafile));

console.log("[build-siteground] copying migrations …");
for (const app of APPS) {
  const src = join(root, "apps", app, "migrations");
  if (!existsSync(src)) {
    console.error(`[build-siteground] missing apps/${app}/migrations — cannot build the artifact`);
    process.exit(1);
  }
  cpSync(src, join(outDir, "migrations", app), { recursive: true });
}

console.log("[build-siteground] copying config …");
cpSync(join(root, "config"), join(outDir, "config"), { recursive: true });

writeFileSync(
  join(outDir, "package.json"),
  JSON.stringify(
    {
      name: "gcpe-news-platform-siteground",
      private: true,
      type: "module",
      engines: { node: ">=24" },
      // No "dependencies": the bundle carries everything it needs. SiteGround's build
      // pipeline still runs `npm install` (it deletes package-lock.json first and can't be
      // skipped), but with an empty dependency set that's a fast no-op.
      scripts: { start: "node stack.js" },
    },
    null,
    2,
  ) + "\n",
);

writeFileSync(
  join(outDir, "README.txt"),
  [
    "GCPE News Platform — SiteGround artifact",
    "",
    "This directory is a prebuilt, fully self-contained build of apps/stack (the whole",
    "platform in one Node process). Nothing here needs `npm install` to resolve — every",
    "dependency is bundled into stack.js.",
    "",
    "Run: node stack.js",
    "Check config without starting anything: node stack.js --check",
    "",
    "Deploy steps, required environment variables, and the operator runbook are at:",
    "docs/deploy/siteground.md (in the main repository, not in this artifact).",
    "",
    "This directory's only job is to be the deploy/siteground branch's tree, committed there",
    "by scripts/deploy-siteground.sh — it is not meant to be edited by hand.",
    "",
  ].join("\n"),
);

console.log("[build-siteground] smoke test: node dist/siteground/stack.js --check …");
try {
  execFileSync(process.execPath, [join(outDir, "stack.js"), "--check"], {
    cwd: outDir,
    stdio: "inherit",
    env: {
      ...process.env,
      // Just enough for every one of the six apps' own env schema to parse — url-shaped
      // DATABASE_URLs that are never dialled (--check never calls createDb), one tick token,
      // and the handful of required non-DB vars (see apps/stack/src/stack.test.ts's env for
      // the full real wiring; this is the minimal structural subset).
      TICK_TOKEN: "x".repeat(40),
      CORE_DATABASE_URL: "postgres://user:pass@127.0.0.1:1/core",
      NRMS_DATABASE_URL: "postgres://user:pass@127.0.0.1:1/nrms",
      NEWSAPI_DATABASE_URL: "postgres://user:pass@127.0.0.1:1/news_api",
      SITE_DATABASE_URL: "postgres://user:pass@127.0.0.1:1/site",
      SITE_NEWS_API_URL: "self:/",
      SITE_OUTPUT_DIR: "./site-output",
      SITE_PUBLIC_SITE_URL: "https://news.example.invalid/site",
      NOD_DATABASE_URL: "postgres://user:pass@127.0.0.1:1/nod",
      NOD_DISTRIBUTION_URL: "self:/distribution",
      NOD_PUBLIC_SITE_URL: "https://news.example.invalid/site",
      NOD_MANAGE_URL: "https://news.example.invalid/manage",
      DIST_DATABASE_URL: "postgres://user:pass@127.0.0.1:1/distribution",
      DIST_SMTP_HOST: "127.0.0.1",
      DIST_MAIL_FROM: "noreply@news.example.invalid",
      DIST_MAIL_REDIRECT_TO: "ops@news.example.invalid",
    },
  });
} catch (e) {
  console.error("[build-siteground] FAILED: dist/siteground/stack.js --check exited non-zero");
  throw e;
}

console.log(`[build-siteground] OK — artifact at ${outDir}`);
