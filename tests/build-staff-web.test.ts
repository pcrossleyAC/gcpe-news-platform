// Task 1 (staff-web): scripts/build-staff-web.mjs. Two layers, same split as
// tests/build-siteground-guard.test.ts: the pure URL-rewriting logic gets a fast unit test
// with a synthetic metafile, and the real build (esbuild, bundling react/react-dom/the BC
// design system) runs exactly once, in `beforeAll`, for the handful of tests that need actual
// output on disk.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { assetUrlsFromMetafile } from "../scripts/build-staff-web.mjs";

const root = resolve(import.meta.dirname, "..");
const distDir = join(root, "apps/staff-web/dist");

function allFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allFiles(p));
    else out.push(p);
  }
  return out;
}

describe("assetUrlsFromMetafile", () => {
  it("rewrites the JS entry and its CSS sibling to absolute /hub/assets/ URLs", () => {
    const metafile = {
      outputs: {
        "apps/staff-web/dist/assets/app-ABC123.js": {},
        "apps/staff-web/dist/assets/app-ABC123.css": {},
        "apps/staff-web/dist/assets/BCSans-Regular-XYZ9.woff2": {},
      },
    };
    expect(assetUrlsFromMetafile(metafile)).toEqual({
      jsPath: "/hub/assets/app-ABC123.js",
      cssPath: "/hub/assets/app-ABC123.css",
    });
  });

  it("omits cssPath when the entry has no CSS output", () => {
    const metafile = { outputs: { "apps/staff-web/dist/assets/app-ABC123.js": {} } };
    expect(assetUrlsFromMetafile(metafile)).toEqual({ jsPath: "/hub/assets/app-ABC123.js", cssPath: undefined });
  });

  it("throws when no JS entry output is found", () => {
    expect(() => assetUrlsFromMetafile({ outputs: {} })).toThrow(/no JS entry output/);
  });
});

describe("the real build", () => {
  beforeAll(() => {
    execFileSync(process.execPath, [join(root, "scripts/build-staff-web.mjs")], { cwd: root, stdio: "inherit" });
  }, 60_000);

  it("produces index.html referencing hashed JS and CSS under /hub/assets/", () => {
    const html = readFileSync(join(distDir, "index.html"), "utf8");
    expect(html).toMatch(/<script type="module" src="\/hub\/assets\/app-[A-Za-z0-9]+\.js"><\/script>/);
    expect(html).toMatch(/<link rel="stylesheet" href="\/hub\/assets\/app-[A-Za-z0-9]+\.css" \/>/);
  });

  it("copies the design system's fonts alongside the bundle with hashed names", () => {
    const names = readdirSync(join(distDir, "assets"));
    expect(names.some((n) => /^BCSans-Regular-[A-Za-z0-9]+\.woff2$/.test(n))).toBe(true);
  });

  it("ships no source maps", () => {
    expect(allFiles(distDir).filter((f) => f.endsWith(".map"))).toEqual([]);
  });

  it("leaks no local absolute path, home directory, or username anywhere in the output", () => {
    const forbidden = [root, homedir(), userInfo().username].filter((v) => v.length > 0);
    const offenders = allFiles(distDir).filter((f) => {
      let content: string;
      try {
        content = readFileSync(f, "utf8");
      } catch {
        return false; // binary (e.g. a .woff font) — never contains a text path anyway
      }
      return forbidden.some((value) => content.includes(value));
    });
    expect(offenders).toEqual([]);
  });
});
