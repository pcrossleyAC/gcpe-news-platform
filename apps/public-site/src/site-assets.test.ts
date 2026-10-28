import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { memoryStorage } from "../test/memory-storage";
import { BC_SANS_FILES, builtinAssetSources, BUNDLED_SITE_ASSETS, LEGACY_BUNDLE, LEGACY_BUNDLE_SOURCES, writeBuiltinAssets } from "./site-assets";
import { SITE_SCRIPT } from "./site-script";

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const ASSETS = fileURLToPath(new URL("../assets/", import.meta.url));

/** Files the legacy site's own CSS names but its repository never had (look-and-feel §3), and the font fallbacks after woff2. */
const MISSING_IN_LEGACY = [
  "Images/24x24-facebook.png",
  "Images/24x24-share.png",
  "Images/SocialMedia/24x24-blogs.png",
  "Images/SocialMedia/24x24-facebook-feed.png",
  "Images/SocialMedia/24x24-pinterest.png",
  "Images/SocialMedia/24x24-twitter-feed.png",
  "Images/SocialMedia/24x24-ustream.png",
];

describe("builtinAssetSources", () => {
  it("source checkout: root is apps/public-site/assets and fonts come from @bcgov/bc-sans", () => {
    const src = builtinAssetSources();
    expect(src.root).toBe(ASSETS.replace(/[\\/]$/, ""));
    expect(src.fontsDir).toMatch(/@bcgov[\\/]bc-sans[\\/]fonts$/);
    for (const f of BC_SANS_FILES) expect(existsSync(join(src.fontsDir, f))).toBe(true);
  });

  it("bundle layout: public-site-assets beside the bundle wins when it exists", () => {
    // resolve(): on Windows a root-relative path gains the current drive letter, as fileURLToPath does.
    const dir = resolve("/srv/app");
    const here = pathToFileURL(join(dir, "stack.js")).href;
    const src = builtinAssetSources(here, (p) => p === join(dir, BUNDLED_SITE_ASSETS));
    expect(src.root).toBe(join(dir, BUNDLED_SITE_ASSETS));
    expect(src.fontsDir).toBe(join(dir, BUNDLED_SITE_ASSETS, "legacy", "fonts"));
  });
});

describe("writeBuiltinAssets", () => {
  it("writes favicon.ico at the root, the six woff2 + LICENSE_OFL.txt under assets/legacy/fonts, the four logo SVGs, every vendored CSS, LICENSE and NOTICE.md", async () => {
    const storage = memoryStorage();
    await writeBuiltinAssets(storage);
    const has = (p: string) => storage.files.has(p);
    expect(has("favicon.ico")).toBe(true);
    expect(has("assets/legacy/favicon.ico")).toBe(true);
    for (const f of BC_SANS_FILES) expect(has(`assets/legacy/fonts/${f}`), f).toBe(true);
    expect(has("assets/legacy/fonts/LICENSE_OFL.txt")).toBe(true);
    for (const f of ["BCID_H_rgb_pos_LH_crop.svg", "BC_Mark.svg", "BCID_H_rgb_pos_LH_crop_bridge.svg", "BC_Mark_bridge.svg"]) {
      expect(has(`assets/legacy/Content/Images/Gov/${f}`), f).toBe(true);
    }
    for (const f of ["site", "custom", "transforms", "accessibility-styles", "print", "granville-bridge-theme"]) expect(has(`assets/legacy/Content/${f}.css`), f).toBe(true);
    expect(has("assets/legacy/lib/bootstrap5/css/bootstrap.min.css")).toBe(true);
    expect(has("assets/legacy/LICENSE")).toBe(true);
    expect(has("assets/legacy/NOTICE.md")).toBe(true);
    expect(has("assets/site/icons.svg")).toBe(true);
    expect(storage.files.get("assets/site/site.js")).toBe(SITE_SCRIPT);
  });

  it("writes legacy.bundle.css beside the Content CSS: the five render-blocking files in legacy order, byte-for-byte bar a leading BOM", async () => {
    expect(LEGACY_BUNDLE).toBe("legacy/Content/legacy.bundle.css");
    expect(LEGACY_BUNDLE_SOURCES).toEqual([
      "legacy/lib/bootstrap5/css/bootstrap.min.css",
      "legacy/Content/site.css",
      "legacy/Content/custom.css",
      "legacy/Content/transforms.css",
      "legacy/Content/accessibility-styles.css",
    ]);
    const storage = memoryStorage();
    await writeBuiltinAssets(storage);
    const bundle = Buffer.from(storage.files.get(`assets/${LEGACY_BUNDLE}`) as Uint8Array);
    const parts = LEGACY_BUNDLE_SOURCES.map((rel) => {
      const raw = readFileSync(join(ASSETS, rel));
      return raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? raw.subarray(3) : raw;
    });
    expect(bundle.equals(Buffer.concat(parts.flatMap((b) => [b, Buffer.from("\n")])))).toBe(true);
    // A browser strips one leading BOM per file, so exactly one is dropped per source. custom.css
    // starts with two; its second survives in the bundle just as it does on news.gov.
    const boms = (b: Buffer) => { let n = 0; for (let i = b.indexOf(BOM); i !== -1; i = b.indexOf(BOM, i + 1)) n++; return n; };
    expect(boms(bundle)).toBe(1);
    // @charset is only honoured first in a file: bootstrap.min.css's must lead the bundle.
    expect(bundle.subarray(0, 8).toString()).toBe("@charset");
  });

  it("every url(...) in the vendored CSS resolves to a written file, except the allow-listed files legacy itself lacks", async () => {
    const storage = memoryStorage();
    await writeBuiltinAssets(storage);
    const cssFiles = [...storage.files.keys()].filter((k) => k.startsWith("assets/legacy/") && k.endsWith(".css"));
    expect(cssFiles.length).toBe(8); // the seven vendored files and the generated bundle
    const unresolved: string[] = [];
    for (const css of cssFiles) {
      const text = Buffer.from(storage.files.get(css) as string | Uint8Array).toString("utf8");
      for (const m of text.matchAll(/url\(\s*(["']?)([^)"']+)\1\s*\)/g)) {
        const ref = m[2]!.split(/[?#]/)[0]!;
        if (/^(data:|https?:|\/\/)/.test(ref)) continue;
        if (/\.(otf|ttf|woff)$/.test(ref)) continue; // woff2 is listed first in every @font-face
        const target = posix.normalize(posix.join(posix.dirname(css), ref));
        if (storage.files.has(target)) continue;
        if (MISSING_IN_LEGACY.some((a) => target.endsWith(`/Content/${a}`))) continue;
        unresolved.push(`${css} -> ${ref}`);
      }
    }
    expect(unresolved).toEqual([]);
  });

  it("no dead legacy file is written: minimenu.css, covid-banner-style.css, covidcategory.css, jquery*, bootstrap.bundle*", async () => {
    const storage = memoryStorage();
    await writeBuiltinAssets(storage);
    const dead = [...storage.files.keys()].filter((k) => /minimenu\.css|covid-banner-style\.css|covidcategory\.css|jquery|bootstrap\.bundle/i.test(k));
    expect(dead).toEqual([]);
  });

  it("the vendored tree on disk holds exactly the 45 files the briefs list plus NOTICE.md", () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    expect(walk(join(ASSETS, "legacy")).length).toBe(46);
    expect(readFileSync(join(ASSETS, "legacy", "NOTICE.md"), "utf8")).toContain("3fdf3e6b6faa92172ba60f8bd2951bce96dbe2de");
    // The SiteGround build refuses an artifact that names the build machine's home directory.
    expect(readFileSync(join(ASSETS, "legacy", "NOTICE.md"), "utf8")).not.toMatch(/\/Users\/|\/home\/|[A-Za-z]:\\Users/);

    // The non-legacy assets shipped beside them are named with their licences too.
    const notice = readFileSync(join(ASSETS, "legacy", "NOTICE.md"), "utf8");
    expect(notice).toMatch(/BC Sans[^\n]*@bcgov\/bc-sans[^\n]*SIL Open Font License[^\n]*LICENSE_OFL\.txt/);
    expect(notice).toMatch(/Font Awesome Free[^\n]*CC BY 4\.0[^\n]*assets\/site\/icons\.svg/);
  });

  it("NOTICE.md lists every vendored file on disk with its sha256, and nothing else", () => {
    const root = join(ASSETS, "legacy");
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    const onDisk = walk(root)
      .map((f) => relative(root, f).split(sep).join("/"))
      .filter((f) => f !== "NOTICE.md")
      .sort();
    const notice = readFileSync(join(root, "NOTICE.md"), "utf8");
    const listed = new Map([...notice.matchAll(/^\| `([^`]+)` \| ([0-9a-f]{64}) \|$/gm)].map((m) => [m[1]!, m[2]!]));
    expect([...listed.keys()].sort()).toEqual(onDisk);
    for (const f of onDisk) expect(createHash("sha256").update(readFileSync(join(root, f))).digest("hex"), f).toBe(listed.get(f));
  });

  it("render.ts takes LEGACY_BUNDLE from the pure legacy-bundle module, not the Node I/O module", () => {
    const render = readFileSync(new URL("./render.ts", import.meta.url), "utf8");
    expect(render).not.toMatch(/from "\.\/site-assets"/);
    expect(render).toMatch(/import \{ LEGACY_BUNDLE \} from "\.\/legacy-bundle";/);
    const pure = readFileSync(new URL("./legacy-bundle.ts", import.meta.url), "utf8");
    expect(pure).not.toMatch(/from "node:/);
  });
});
