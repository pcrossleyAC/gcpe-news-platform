// Task 1 (staff-web): builds the staff web app's browser bundle at apps/staff-web/dist/ —
// index.html plus hashed assets/app-<hash>.js|css (fonts/images the CSS references are copied
// alongside with their own hashed names, via esbuild's `file` loader). Base path is `/hub/`
// (apps/stack/src/stack.ts hosts the staff app there); no source maps ship in the output.
// This is also the input scripts/build-siteground.mjs copies into dist/siteground/hub/.
//
// Usage: node scripts/build-staff-web.mjs [--watch]
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { context } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const entry = join(root, "apps/staff-web/src/main.tsx");
const outDir = join(root, "apps/staff-web/dist");
const outDirRel = relative(root, outDir);

/** Mounted at /hub (apps/stack/src/stack.ts) — every asset reference in index.html is this
 * absolute path, never a relative one, so the shell works the same regardless of which deep
 * /hub/<anything> path the browser actually loaded it from. */
const BASE_PATH = "/hub/";

const ESBUILD_OPTIONS = {
  entryPoints: [entry],
  outdir: outDir,
  absWorkingDir: root,
  bundle: true,
  platform: "browser",
  format: "esm",
  target: ["es2022"],
  // Content-hashed names (esbuild's own [hash]) are *why* /hub/assets/* can be cached
  // immutably for a year in apps/stack/src/stack.ts — a changed file is a changed URL.
  entryNames: "assets/app-[hash]",
  chunkNames: "assets/chunk-[name]-[hash]",
  assetNames: "assets/[name]-[hash]",
  // The design system's fonts (and any future icons/images its CSS references via url()) are
  // copied out as hashed files; esbuild also rewrites those url()s to the new hashed path.
  loader: {
    ".woff": "file",
    ".woff2": "file",
    ".ttf": "file",
    ".eot": "file",
    ".svg": "file",
    ".png": "file",
    ".jpg": "file",
    ".jpeg": "file",
    ".gif": "file",
  },
  // React/react-dom's own dev-only branches key off this; esbuild's `define` is a literal
  // textual substitution, so no runtime `process` polyfill is needed for it to work.
  define: { "process.env.NODE_ENV": '"production"' },
  minify: true,
  // P2-R34-style precaution (same reasoning as scripts/build-siteground.mjs): esbuild would
  // otherwise append a per-package relative-path legal-comment block, one of the few places a
  // local path could leak into a shipped artifact.
  legalComments: "none",
  sourcemap: false,
  metafile: true,
  write: true,
  logLevel: "info",
};

function htmlDocument({ jsPath, cssPath }) {
  const lines = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    "  <title>GCPE News — Staff</title>",
  ];
  if (cssPath) lines.push(`  <link rel="stylesheet" href="${cssPath}" />`);
  lines.push("</head>", "<body>", '  <div id="root"></div>', `  <script type="module" src="${jsPath}"></script>`, "</body>", "</html>", "");
  return lines.join("\n");
}

/**
 * Picks the JS entry's and (if any) its CSS sibling's output paths out of an esbuild metafile,
 * rewriting each to an absolute /hub/assets/... URL. Exported, and covered by its own test
 * directly, so the URL-rewriting logic itself is unit-tested without needing a real build.
 */
export function assetUrlsFromMetafile(metafile) {
  const outputs = Object.keys(metafile.outputs);
  const toUrl = (outputPath) => `${BASE_PATH}${relative(outDirRel, outputPath)}`;
  const jsOutput = outputs.find((f) => f.endsWith(".js") && relative(outDirRel, f).startsWith("assets/app-"));
  const cssOutput = outputs.find((f) => f.endsWith(".css") && relative(outDirRel, f).startsWith("assets/app-"));
  if (!jsOutput) throw new Error("no JS entry output found in the esbuild metafile");
  return { jsPath: toUrl(jsOutput), cssPath: cssOutput ? toUrl(cssOutput) : undefined };
}

/** Regenerates index.html after every build (including each `--watch` rebuild), so a dev
 * session's hashed filenames in index.html never go stale against what's actually on disk. */
const writeIndexHtmlPlugin = {
  name: "write-index-html",
  setup(build) {
    build.onEnd((result) => {
      if (!result.metafile) return;
      const { jsPath, cssPath } = assetUrlsFromMetafile(result.metafile);
      writeFileSync(join(outDir, "index.html"), htmlDocument({ jsPath, cssPath }));
      console.log(`[build-staff-web] wrote ${outDirRel}/index.html referencing ${jsPath}${cssPath ? ` and ${cssPath}` : ""}`);
    });
  },
};

/**
 * Everything that touches the filesystem/esbuild lives in here (same pattern as
 * scripts/build-siteground.mjs's runBuild) so importing this module for its pure pieces
 * (assetUrlsFromMetafile) never has a side effect of its own.
 */
export async function runBuild({ watch = false } = {}) {
  console.log("[build-staff-web] cleaning apps/staff-web/dist …");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  console.log("[build-staff-web] bundling apps/staff-web/src/main.tsx …");
  const ctx = await context({ ...ESBUILD_OPTIONS, plugins: [writeIndexHtmlPlugin] });

  if (!watch) {
    await ctx.rebuild();
    await ctx.dispose();
    console.log(`[build-staff-web] OK — built at ${outDirRel}`);
    return;
  }

  console.log("[build-staff-web] watching for changes (Ctrl+C to stop) …");
  await ctx.watch();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runBuild({ watch: process.argv.includes("--watch") });
}
