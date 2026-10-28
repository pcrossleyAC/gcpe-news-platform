// Copies the public site's built-in assets beside a bundle, the layout
// apps/public-site/src/site-assets.ts (builtinAssetSources) looks for:
//   <outDir>/public-site-assets/{legacy,site}/…   apps/public-site/assets
//   <outDir>/public-site-assets/legacy/fonts/     BC Sans (woff2) and LICENSE_OFL.txt
//   <outDir>/public-site-assets/vendor/            hls.js's light build (the /live/ page)
import { copyFileSync, cpSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const BC_SANS_FILES = ["BCSans-Regular.woff2", "BCSans-Italic.woff2", "BCSans-Bold.woff2", "BCSans-BoldItalic.woff2", "BCSans-Light.woff2", "BCSans-LightItalic.woff2"];

export function copyPublicSiteAssets(outDir) {
  const dest = join(outDir, "public-site-assets");
  cpSync(join(root, "apps/public-site/assets"), dest, { recursive: true });
  const pkg = dirname(createRequire(join(root, "apps/public-site/package.json")).resolve("@bcgov/bc-sans/package.json"));
  const fonts = join(dest, "legacy", "fonts");
  mkdirSync(fonts, { recursive: true });
  for (const f of BC_SANS_FILES) copyFileSync(join(pkg, "fonts", f), join(fonts, f));
  copyFileSync(join(pkg, "LICENSE_OFL.txt"), join(fonts, "LICENSE_OFL.txt"));
  const hls = dirname(createRequire(join(root, "apps/public-site/package.json")).resolve("hls.js/package.json"));
  mkdirSync(join(dest, "vendor"), { recursive: true });
  copyFileSync(join(hls, "dist", "hls.light.min.js"), join(dest, "vendor", "hls.light.min.js"));
}
