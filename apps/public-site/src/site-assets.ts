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

/**
 * The legacy stylesheets every page blocks rendering on, in legacy order, concatenated into one
 * generated file so a page makes one request instead of five. The sources stay unmodified (P3).
 * The bundle sits in Content/ beside site.css so the relative url()s in site.css and
 * custom.css ("../fonts/…") and transforms.css ("Images/…") resolve exactly as before;
 * bootstrap.min.css has only data: urls. print.css (media=print) and granville-bridge-theme.css
 * (Blue Bridge only) stay separate.
 */
export const LEGACY_BUNDLE = "legacy/Content/legacy.bundle.css";
export const LEGACY_BUNDLE_SOURCES = [
  "legacy/lib/bootstrap5/css/bootstrap.min.css",
  "legacy/Content/site.css",
  "legacy/Content/custom.css",
  "legacy/Content/transforms.css",
  "legacy/Content/accessibility-styles.css",
] as const;

/** Each source byte-for-byte, newline-terminated, minus one leading UTF-8 BOM — the one a browser
 * strips when it decodes a stylesheet on its own. Mid-bundle it would not be stripped: it would
 * become part of the next selector and drop that rule. (custom.css starts with two BOMs; the
 * second is kept, so the bundle behaves exactly as the separate file does on news.gov.) */
function legacyBundle(read: (rel: string) => Buffer): Uint8Array {
  const parts = LEGACY_BUNDLE_SOURCES.map((rel) => {
    const raw = read(rel);
    return raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? raw.subarray(3) : raw;
  });
  return new Uint8Array(Buffer.concat(parts.flatMap((b) => [b, Buffer.from("\n")])));
}

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
 * output folder's assets/, the generated legacy CSS bundle beside them, and favicon.ico at its root. Idempotent and cheap, so it runs on every
 * start (self-heal.ts) and every static-pages build, whatever else the folder holds.
 */
export async function writeBuiltinAssets(storage: SiteStorage, sources: BuiltinAssetSources = builtinAssetSources()): Promise<void> {
  const { root, fontsDir } = sources;
  const read = new Map<string, Buffer>();
  for (const rel of await filesUnder(root)) {
    const buf = await readFile(join(root, rel));
    read.set(rel, buf);
    const bytes = new Uint8Array(buf);
    await storage.write(`assets/${rel}`, bytes);
    if (rel === "legacy/favicon.ico") await storage.write("favicon.ico", bytes);
  }
  await storage.write(
    `assets/${LEGACY_BUNDLE}`,
    legacyBundle((rel) => {
      const buf = read.get(rel);
      if (!buf) throw new Error(`${rel} missing from ${root}`);
      return buf;
    }),
  );
  for (const f of BC_SANS_FILES) await storage.write(`assets/legacy/fonts/${f}`, new Uint8Array(await readFile(join(fontsDir, f))));
  const license = [join(fontsDir, FONT_LICENSE), join(fontsDir, "..", FONT_LICENSE)].find((p) => existsSync(p));
  if (!license) throw new Error(`${FONT_LICENSE} not found beside ${fontsDir}`);
  await storage.write(`assets/legacy/fonts/${FONT_LICENSE}`, new Uint8Array(await readFile(license)));
}
