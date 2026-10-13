import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// Every place that calls an upload route from outside NRMS itself. NRMS's own route tests are
// left out: they send ?name= on purpose, to prove it is refused.
const CALLERS = ["apps/staff-web/src", "tests/e2e", "scripts", "apps/stack/src"];
const NAME_IN_URL = [/(\/files|page-images)[^\n"'`]*[?&]name=/, /URLSearchParams\(\{[^}]*\bname\b/];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return e === "node_modules" ? [] : files(p);
    return /\.(ts|tsx|mjs|sh)$/.test(p) ? [p] : [];
  });
}

describe("upload names never travel in a URL", () => {
  it("the patterns catch the old shapes", () => {
    expect(NAME_IN_URL.some((re) => re.test("`/nrms/api/site/files?name=${n}&replace=false`"))).toBe(true);
    expect(NAME_IN_URL.some((re) => re.test("`/nrms/api/releases/${id}/files?kind=asset&version=1&name=a.png`"))).toBe(true);
    expect(NAME_IN_URL.some((re) => re.test("new URLSearchParams({ name, replace: \"false\" })"))).toBe(true);
    expect(NAME_IN_URL.some((re) => re.test("`/nrms/api/site/files?replace=false`"))).toBe(false);
  });

  it("no caller puts ?name= on an upload URL", () => {
    const offenders = CALLERS.flatMap((d) => files(join(ROOT, d)))
      .flatMap((f) => readFileSync(f, "utf8").split("\n").map((line, i) => ({ f, i, line })))
      .filter(({ line }) => NAME_IN_URL.some((re) => re.test(line)))
      .map(({ f, i, line }) => `${relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
    expect(offenders).toEqual([]);
  });
});
