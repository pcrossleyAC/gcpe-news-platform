import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "apps/staff-web/src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx$/.test(p) && !/\.test\.tsx$/.test(p) ? [p] : [];
  });
}

/** Each `gcpe-table` with no `<TableScroll>` around it: a table wider than a phone would push the
 * whole page sideways instead of scrolling in its own box (shared/TableScroll.tsx). */
export function unwrappedTables(source: string): number[] {
  const lines: number[] = [];
  for (const m of source.matchAll(/<table\b[^>]*className="gcpe-table\b/g)) {
    const before = source.slice(0, m.index);
    const opened = (before.match(/<TableScroll\b/g) ?? []).length;
    const closed = (before.match(/<\/TableScroll>/g) ?? []).length;
    if (opened <= closed) lines.push(before.split("\n").length);
  }
  return lines;
}

describe("staff-web: a data table never widens the page", () => {
  it("the scanner finds a bare table, and not one inside TableScroll", () => {
    expect(unwrappedTables('<div>\n<table className="gcpe-table">')).toEqual([2]);
    expect(unwrappedTables('<TableScroll label="x">\n<table aria-label="x" className="gcpe-table gcpe-x">')).toEqual([]);
    expect(unwrappedTables('<TableScroll label="x"><table className="gcpe-table"></table></TableScroll>\n<table className="gcpe-table">')).toEqual([2]);
  });

  it("every gcpe-table sits in a TableScroll", () => {
    const offenders = sources(SRC).flatMap((f) => unwrappedTables(readFileSync(f, "utf8")).map((line) => `${relative(ROOT, f)}:${line}`));
    expect(offenders).toEqual([]);
  });
});
