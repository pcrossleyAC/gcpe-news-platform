#!/usr/bin/env -S node --
// The hook for 5i's report parity check (spec addendum §12.3): compares the structure of a legacy
// report PDF with ours for the same range and filter, section by section, activity by activity.
// Both are read with the reader the golden tests use (apps/calendar/test/pdf-text.ts), so a
// difference is in the reports, not in how they were read.
//
// Usage:
//   npm run calendar:report-compare -- --legacy <legacy.pdf> --new <ours.pdf> --out <folder>
//
// The past-period PDFs the team supplies hold real activities: they and the output stay outside
// this repository. The script refuses an --out inside it, and writes nothing but the two outlines
// and their differences there. Exit code 1 when the outlines differ.
import { lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { outlineOf, pdfPages } from "../apps/calendar/test/pdf-text";

/**
 * `path` with every symlink in it followed to its target, even past a point that doesn't exist
 * yet: a component that is itself a symlink resolves to what it points at (a relative target
 * resolved against the link's own directory), recursively; a component that doesn't exist at all
 * is kept literally, with whatever is below it, so a not-yet-created `--out` still resolves
 * through a symlinked parent (fs.realpathSync refuses a path whose target doesn't exist).
 */
function weakRealpath(path: string, seen: Set<string> = new Set()): string {
  const abs = resolve(path);
  const parent = dirname(abs);
  if (parent === abs) return abs; // the filesystem root
  let link: string | null = null;
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) link = readlinkSync(abs);
  } catch {
    return join(weakRealpath(parent, seen), basename(abs));
  }
  if (link === null) return join(weakRealpath(parent, seen), basename(abs));
  if (seen.has(abs)) throw new Error(`a symlink cycle at ${abs}`);
  seen.add(abs);
  return weakRealpath(isAbsolute(link) ? link : resolve(dirname(abs), link), seen);
}

const REPO = weakRealpath(resolve(import.meta.dirname, ".."));

/** The shortest edit from `a` to `b`, as lines: "  same", "- only in a", "+ only in b". */
export function diffOutlines(a: string[], b: string[]): string[] {
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) (out.push(`  ${a[i]}`), i++, j++);
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);
  return out;
}

/** True when `dir` is this repository or inside it, every symlink in `dir` followed first. */
export function insideRepo(dir: string): boolean {
  const rel = relative(REPO, weakRealpath(dir));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

export async function compareReports(o: { legacy: string; ours: string; out: string }): Promise<{ same: boolean; diff: string[] }> {
  if (insideRepo(o.out)) throw new Error("--out must be outside the repository: the legacy reports hold real activities");
  const legacy = outlineOf(await pdfPages(new Uint8Array(readFileSync(o.legacy))));
  const ours = outlineOf(await pdfPages(new Uint8Array(readFileSync(o.ours))));
  const diff = diffOutlines(legacy, ours);
  mkdirSync(o.out, { recursive: true });
  writeFileSync(join(o.out, "outline-legacy.txt"), `${legacy.join("\n")}\n`);
  writeFileSync(join(o.out, "outline-new.txt"), `${ours.join("\n")}\n`);
  writeFileSync(join(o.out, "diff.txt"), `${diff.join("\n")}\n`);
  return { same: diff.every((l) => l.startsWith("  ")), diff };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    const v = i === -1 ? undefined : process.argv[i + 1];
    if (!v) throw new Error(`--${name} is required (see the usage at the top of scripts/calendar-report-compare.ts)`);
    return v;
  };
  const { same, diff } = await compareReports({ legacy: arg("legacy"), ours: arg("new"), out: arg("out") });
  console.log(same ? "The outlines match." : `The outlines differ in ${diff.filter((l) => !l.startsWith("  ")).length} lines: see diff.txt.`);
  process.exit(same ? 0 : 1);
}
