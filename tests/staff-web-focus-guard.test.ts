import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "apps/staff-web/src");
// Names this app gives a request in flight. A control disabled by one loses keyboard focus to
// the page the moment the request starts; use isPending (buttons) or isReadOnly (fields) instead.
const IN_FLIGHT = /\b(busy|saving|submitting|loading|pending|creating|deleting|sending|retrying)\b/;

function inFlightDisables(source: string): { line: number; expr: string }[] {
  const found: { line: number; expr: string }[] = [];
  for (const m of source.matchAll(/isDisabled=\{/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (depth > 0 && i < source.length) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
      i++;
    }
    const expr = source.slice(start, i - 1);
    if (IN_FLIGHT.test(expr)) found.push({ line: source.slice(0, m.index).split("\n").length, expr: expr.replace(/\s+/g, " ").trim() });
  }
  return found;
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) ? [p] : [];
  });
}

describe("staff-web keeps keyboard focus while a request is in flight", () => {
  it("the scanner flags in-flight flags, across lines, and nothing else", () => {
    expect(inFlightDisables("<Button isDisabled={busy}>")).toHaveLength(1);
    expect(inFlightDisables("<Button isDisabled={\n  index === 0 || section.saving\n}>")).toHaveLength(1);
    expect(inFlightDisables("<Button isDisabled={retrying.has(keyOf(d))}>")).toHaveLength(1);
    expect(inFlightDisables("<Button isDisabled={readOnly || !canEdit}>")).toEqual([]);
    expect(inFlightDisables("<Button isPending={busy} isDisabled={dirty}>")).toEqual([]);
  });

  it("no control is disabled by an in-flight flag", () => {
    const offenders = sources(SRC).flatMap((f) => inFlightDisables(readFileSync(f, "utf8")).map((o) => `${relative(ROOT, f)}:${o.line} isDisabled={${o.expr}}`));
    expect(offenders).toEqual([]);
  });
});
