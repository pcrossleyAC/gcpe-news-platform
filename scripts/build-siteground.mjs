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
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const outDir = join(root, "dist/siteground");
// Deliberately OUTSIDE outDir (ruling P2-R34): this is build-time diagnostic output (full
// absolute input/output file paths, by design — that's what makes a metafile useful for
// bundle-size analysis), never part of what gets committed to deploy/siteground.
const metafilePath = join(root, "dist/siteground-meta.json");

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

/**
 * Recursively scans every file under `dir` for any of `forbidden`'s (non-empty) `value`s,
 * returning `{file, label}` for each match found. Exported (and covered by
 * tests/build-siteground-guard.test.ts) so the scan logic itself is unit-tested, not just
 * exercised as a side effect of a full build. Skips a file it can't read as UTF-8 text
 * (nothing in this artifact is binary, but this keeps the scan from crashing if that ever
 * changes) rather than failing the whole scan over one unreadable file.
 */
export function findLeakedPaths(dir, forbidden) {
  const active = forbidden.filter((f) => f.value && f.value.length > 0);
  const offenders = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      let content;
      try {
        content = readFileSync(p, "utf8");
      } catch {
        continue;
      }
      for (const { label, value } of active) {
        if (content.includes(value)) offenders.push({ file: p, label });
      }
    }
  };
  walk(dir);
  return offenders;
}

/**
 * Everything that actually touches the filesystem/network/exits the process lives in here,
 * called only when this file is run as the entry point (`node scripts/build-siteground.mjs`)
 * — NOT merely imported (as tests/build-siteground-guard.test.ts does, for `findLeakedPaths`
 * alone). A plain top-level `await build(...)` would otherwise re-run the entire build, every
 * time, as a side effect of any test importing this module — which is exactly what happened
 * before this was wrapped (confirmed: importing this file for `findLeakedPaths` triggered a
 * real esbuild bundle and rewrote dist/siteground, invisibly, from inside a test run).
 */
async function runBuild() {
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
    // P2-R34: minify whitespace and syntax (dead code, shorthand operators, etc.) — this is
    // what actually strips the per-package relative-path legal-comment block esbuild appends
    // at EOF by default (one of the places a leaked path could in principle hide) and shrinks
    // the bundle. Identifiers are deliberately NOT minified (minifyIdentifiers: false,
    // keepNames: true) so a stack trace on SiteGround still names real function/class names,
    // not a1/b2/c3 — legibility matters more there than the extra few hundred KB.
    minifyWhitespace: true,
    minifySyntax: true,
    minifyIdentifiers: false,
    keepNames: true,
    metafile: true,
    logLevel: "info",
  });

  const bundleBytes = statSync(join(outDir, "stack.js")).size;
  console.log(`[build-siteground] stack.js: ${(bundleBytes / 1024 / 1024).toFixed(2)} MiB`);
  writeFileSync(metafilePath, JSON.stringify(result.metafile));
  console.log(`[build-siteground] esbuild metafile written to ${metafilePath} (NOT inside dist/siteground)`);

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

  // P2-R34: this artifact is pushed to a public-facing deploy branch — fail the build outright
  // if it contains the machine's own absolute repo path, home directory, or username anywhere
  // (a leaked build-time comment, an un-rewritten sourcemap reference, a debug string — esbuild
  // doesn't promise none of these can ever appear, so this is checked explicitly rather than
  // assumed from "the external list is correct" or "nothing matched today").
  console.log("[build-siteground] scanning dist/siteground for leaked local paths/username …");
  const forbidden = [
    { label: "the repository's absolute path", value: root },
    { label: "the home directory", value: homedir() },
    { label: "the local username", value: userInfo().username },
  ];
  const offenders = findLeakedPaths(outDir, forbidden);
  if (offenders.length > 0) {
    console.error("[build-siteground] FAILED: the artifact leaks local machine information:");
    for (const o of offenders) console.error(`  ${o.file}: contains ${o.label}`);
    process.exit(1);
  }
  console.log("[build-siteground] OK — no leaked local paths/username found.");

  console.log("[build-siteground] smoke test: node dist/siteground/stack.js --check …");
  try {
    execFileSync(process.execPath, [join(outDir, "stack.js"), "--check"], {
      cwd: outDir,
      stdio: "inherit",
      env: {
        ...process.env,
        // Just enough for every one of the six apps' own env schema AND auth config (P2-R34:
        // --check now also runs authFromEnv per app) to parse — url-shaped DATABASE_URLs that
        // are never dialled (--check never calls createDb), one tick token, a syntactically
        // valid (but not secret-for-anything-real) local-admin password hash, and the handful
        // of required non-DB vars (see apps/stack/src/stack.test.ts's env for the full real
        // wiring; this is the minimal structural subset).
        TICK_TOKEN: "x".repeat(40),
        LOCAL_ADMIN_ENABLED: "true",
        LOCAL_ADMIN_PASSWORD_HASH:
          "scrypt$16384$8$1$AR0_F516SFjYwNcFNR980A$DE642bMgMzH2Q46b7hoQ2hf-CTYQIrqFSaM7xJNdHjGnXQw-T7aYQgf5Fqghm7p5YL4CEuW_ipSpedzYPPHzIw",
        LOCAL_AUTH_SECRET: "build-time-check-placeholder-secret-32c",
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
}

// Only run the build when this file is the actual entry point (`node
// scripts/build-siteground.mjs`), not when a test imports it for `findLeakedPaths`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runBuild();
}

