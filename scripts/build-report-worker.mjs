// Bundles the Calendar's report worker (apps/calendar/src/reports/render/worker.ts) to
// <outDir>/report-worker.cjs and copies BC Sans to <outDir>/fonts/, the layout
// apps/calendar/src/reports/render/assets.ts looks for beside a bundle. CommonJS, not ESM: pdfmake's
// in-memory file store reads __dirname, which an ESM bundle doesn't define.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(join(root, "apps/calendar/package.json"));
const FONT_FILES = ["BCSans-Regular.woff", "BCSans-Bold.woff", "BCSans-Italic.woff", "BCSans-BoldItalic.woff", "LICENSE_OFL.txt"];

/** `external`: npm packages left to node_modules (the per-app images); none for SiteGround's self-contained artifact. */
export async function buildReportWorker(outDir, { external = [] } = {}) {
  mkdirSync(join(outDir, "fonts"), { recursive: true });
  await build({
    entryPoints: [join(root, "apps/calendar/src/reports/render/worker.ts")],
    outfile: join(outDir, "report-worker.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external,
    minifyWhitespace: true,
    minifySyntax: true,
    minifyIdentifiers: false,
    keepNames: true,
    // As stack.js: no end-of-file legal-comment block, whose authors' handles can match the build
    // machine's username and fail build-siteground's leak scan.
    legalComments: "none",
    logLevel: "warning",
  });
  const pkg = dirname(require.resolve("@bcgov/bc-sans/package.json"));
  for (const f of FONT_FILES) copyFileSync(join(pkg, f.endsWith(".txt") ? f : join("fonts", f)), join(outDir, "fonts", f));
}
