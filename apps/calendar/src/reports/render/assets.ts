import { existsSync } from "node:fs";
// A namespace import: the SiteGround bundle's banner already declares a top-level `createRequire`.
import * as nodeModule from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the rendering worker, BC Sans and the tenant's report images are, in a source checkout or next to a bundle. */
export interface ReportAssets {
  workerFile: string;
  execArgv: string[];
  fontsDir: string;
  imagesDir: string;
}

/** The worker's bundle, written next to stack.js (scripts/build-siteground.mjs) and main.js (scripts/build-app.mjs). */
export const BUNDLED_WORKER = "report-worker.cjs";
/** The report images' folder beside a bundle (scripts/build-report-worker.mjs copies apps/calendar/assets/report/ there). */
export const BUNDLED_IMAGES = "report-images";

/**
 * In a bundle, `here` (this module's URL) is the bundle's own file, with report-worker.cjs, fonts/
 * and report-images/ beside it. In a source checkout the worker is worker.ts beside this file, run
 * through tsx, the fonts come from @bcgov/bc-sans and the images from apps/calendar/assets/report/.
 */
export function reportAssets(here: string = import.meta.url, exists: (path: string) => boolean = existsSync): ReportAssets {
  const packaged = () => join(dirname(nodeModule.createRequire(here).resolve("@bcgov/bc-sans/package.json")), "fonts");
  const bundled = fileURLToPath(new URL(`./${BUNDLED_WORKER}`, here));
  if (exists(bundled)) {
    const fonts = fileURLToPath(new URL("./fonts/", here));
    return { workerFile: bundled, execArgv: [], fontsDir: exists(fonts) ? fonts : packaged(), imagesDir: fileURLToPath(new URL(`./${BUNDLED_IMAGES}/`, here)) };
  }
  return { workerFile: fileURLToPath(new URL("./worker.ts", here)), execArgv: ["--import", "tsx"], fontsDir: packaged(), imagesDir: fileURLToPath(new URL("../../../assets/report/", here)) };
}
