import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyPublicSiteAssets } from "../scripts/lib/public-site-assets.mjs";
import { BC_SANS_FILES, builtinAssetSources, writeBuiltinAssets } from "../apps/public-site/src/site-assets";
import { memoryStorage } from "../apps/public-site/test/memory-storage";

describe("copyPublicSiteAssets", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "public-site-assets-"));
    copyPublicSiteAssets(dir);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("lays out public-site-assets/ as builtinAssetSources expects for a bundle", async () => {
    const src = builtinAssetSources(pathToFileURL(join(dir, "stack.js")).href);
    expect(src.root).toBe(join(dir, "public-site-assets"));
    expect(src.fontsDir).toBe(join(dir, "public-site-assets", "legacy", "fonts"));
    for (const f of BC_SANS_FILES) expect(existsSync(join(src.fontsDir, f)), f).toBe(true);
    expect(existsSync(join(src.fontsDir, "LICENSE_OFL.txt"))).toBe(true);
    expect(existsSync(join(src.root, "site", "icons.svg"))).toBe(true);
    // The Windows and SiteGround bundles carry hls.js's light build for the /live/ page.
    expect(src.hlsFile).toBe(join(dir, "public-site-assets", "vendor", "hls.light.min.js"));
    expect(existsSync(src.hlsFile)).toBe(true);
    expect(readFileSync(join(src.root, "legacy", "Content", "Images", "Gov", "BC_Mark.svg"), "utf8")).toContain("<svg");

    const bundled = memoryStorage();
    await writeBuiltinAssets(bundled, src);
    const checkout = memoryStorage();
    await writeBuiltinAssets(checkout);
    expect([...bundled.files.keys()].sort()).toEqual([...checkout.files.keys()].sort());
  });
});
