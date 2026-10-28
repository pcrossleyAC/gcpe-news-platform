import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
// A namespace import: the SiteGround bundle's banner already declares a top-level `createRequire`.
import * as nodeModule from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { SiteStorage } from "./storage";

/** The folder scripts/lib/public-site-assets.mjs copies apps/public-site/assets into, beside a bundle (stack.js, main.js). */
export const BUNDLED_SITE_ASSETS = "public-site-assets";

/** BC Sans as the legacy @font-face rules name it (woff2 is listed first, so the other formats are never fetched). */
export const BC_SANS_FILES = [
  "BCSans-Regular.woff2",
  "BCSans-Italic.woff2",
  "BCSans-Bold.woff2",
  "BCSans-BoldItalic.woff2",
  "BCSans-Light.woff2",
  "BCSans-LightItalic.woff2",
];
const FONT_LICENSE = "LICENSE_OFL.txt";

export interface BuiltinAssetSources {
  /** Every file under it is written to the output folder's assets/ at the same relative path. */
  root: string;
  /** Holds BC_SANS_FILES; LICENSE_OFL.txt is beside them in a bundle and one level up in @bcgov/bc-sans. */
  fontsDir: string;
}

/**
 * In a bundle, `here` (this module's URL) is the bundle's own file with public-site-assets/ beside
 * it. In a source checkout the vendored files are apps/public-site/assets and BC Sans comes from
 * @bcgov/bc-sans.
 */
export function builtinAssetSources(here: string = import.meta.url, exists: (path: string) => boolean = existsSync): BuiltinAssetSources {
  const bundled = fileURLToPath(new URL(`./${BUNDLED_SITE_ASSETS}`, here));
  if (exists(bundled)) return { root: bundled, fontsDir: join(bundled, "legacy", "fonts") };
  const fontsDir = join(dirname(nodeModule.createRequire(here).resolve("@bcgov/bc-sans/package.json")), "fonts");
  return { root: fileURLToPath(new URL("../assets", here)), fontsDir };
}

/** Every file under `dir` (dotfiles skipped), as POSIX paths relative to `dir`. */
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const rel = relative(dir, join(entry.parentPath, entry.name)).split(sep);
    if (rel.some((seg) => seg.startsWith("."))) continue;
    out.push(rel.join("/"));
  }
  return out.sort();
}

/**
 * Writes the vendored legacy CSS and images, the BC logos, BC Sans and the icon sprite into the
 * output folder's assets/, and favicon.ico at its root. Idempotent and cheap, so it runs on every
 * start (self-heal.ts) and every static-pages build, whatever else the folder holds.
 */
export async function writeBuiltinAssets(storage: SiteStorage, sources: BuiltinAssetSources = builtinAssetSources()): Promise<void> {
  const { root, fontsDir } = sources;
  for (const rel of await filesUnder(root)) {
    const bytes = new Uint8Array(await readFile(join(root, rel)));
    await storage.write(`assets/${rel}`, bytes);
    if (rel === "legacy/favicon.ico") await storage.write("favicon.ico", bytes);
  }
  for (const f of BC_SANS_FILES) await storage.write(`assets/legacy/fonts/${f}`, new Uint8Array(await readFile(join(fontsDir, f))));
  const license = [join(fontsDir, FONT_LICENSE), join(fontsDir, "..", FONT_LICENSE)].find((p) => existsSync(p));
  if (!license) throw new Error(`${FONT_LICENSE} not found beside ${fontsDir}`);
  await storage.write(`assets/legacy/fonts/${FONT_LICENSE}`, new Uint8Array(await readFile(license)));
}
