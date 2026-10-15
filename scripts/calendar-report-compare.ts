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
// this repository. The script refuses an --out inside it, and writes nothing but the two outlines,
// the two row-text files and their differences there. Exit code 1 when the outlines or the rows differ.
import { lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { activityIdOf, outlineOf, outlineToken, pdfPages, type PdfPage } from "../apps/calendar/test/pdf-text";

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

/** A line's top may sit this many points above its row's link. */
const ROW_TOLERANCE = 3;
const PAGE_OF = /\s*Page \d+ of \d+$/;
const normalise = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Each activity row's text, keyed "id:<n>#<occurrence>" (the Look Ahead repeats a multi-day row): every
 * line goes to the nearest activity link at or above it, and lines above a page's first link continue
 * the previous page's last row. Dropped: the cover, headings (outline tokens), and page furniture,
 * meaning a line (less any "Page N of M") on at least half the body pages and on 3 or more.
 */
export function rowTextsOf(pages: PdfPage[]): Map<string, string> {
  const body = pages.filter((p) => !p.lines.some((l) => l.text === "Contents:"));
  const strip = (t: string) => t.replace(PAGE_OF, "").trim();
  const seen = new Map<string, number>();
  for (const p of body) for (const t of new Set(p.lines.map((l) => strip(l.text)))) seen.set(t, (seen.get(t) ?? 0) + 1);
  const furniture = (t: string) => t === "" || ((seen.get(t) ?? 0) >= 3 && (seen.get(t) ?? 0) * 2 >= body.length);
  const out = new Map<string, string[]>();
  const occurrences = new Map<number, number>();
  let carried: string | null = null;
  for (const p of body) {
    const keyed = p.links
      .map((l) => ({ y: l.y, id: activityIdOf(l.url) }))
      .filter((l): l is { y: number; id: number } => l.id !== null)
      .sort((a, b) => b.y - a.y)
      .map((l) => {
        const n = (occurrences.get(l.id) ?? 0) + 1;
        occurrences.set(l.id, n);
        const key = `id:${l.id}#${n}`;
        out.set(key, []);
        return { y: l.y, key };
      });
    for (const line of [...p.lines].sort((a, b) => b.y - a.y)) {
      const text = strip(line.text);
      if (furniture(text) || outlineToken(line.text) !== null) continue;
      const owner = keyed.filter((k) => k.y + ROW_TOLERANCE >= line.y).at(-1)?.key ?? carried;
      if (owner) out.get(owner)!.push(text);
    }
    if (keyed.length) carried = keyed.at(-1)!.key;
  }
  return new Map([...out].map(([k, v]) => [k, normalise(v.join(" "))]));
}

export interface RowCounts { same: number; differ: number; onlyLegacy: number; onlyOurs: number }
/** Row by row, in legacy's order then ours: "~ key: word changes", "- key" only in legacy, "+ key" only in ours. */
export function compareRowTexts(legacy: Map<string, string>, ours: Map<string, string>): { counts: RowCounts; lines: string[] } {
  const counts: RowCounts = { same: 0, differ: 0, onlyLegacy: 0, onlyOurs: 0 };
  const lines: string[] = [];
  for (const [key, text] of legacy) {
    const mine = ours.get(key);
    if (mine === undefined) { counts.onlyLegacy++; lines.push(`- ${key}`); continue; }
    if (mine === text) { counts.same++; continue; }
    counts.differ++;
    lines.push(`~ ${key}: ${diffOutlines(text.split(" "), mine.split(" ")).filter((l) => !l.startsWith("  ")).join(" ")}`);
  }
  for (const key of ours.keys()) if (!legacy.has(key)) { counts.onlyOurs++; lines.push(`+ ${key}`); }
  return { counts, lines };
}

export async function compareReports(o: { legacy: string; ours: string; out: string }): Promise<{ same: boolean; diff: string[]; rows: RowCounts }> {
  if (insideRepo(o.out)) throw new Error("--out must be outside the repository: the legacy reports hold real activities");
  const legacyPages = await pdfPages(new Uint8Array(readFileSync(o.legacy)));
  const oursPages = await pdfPages(new Uint8Array(readFileSync(o.ours)));
  const legacy = outlineOf(legacyPages);
  const ours = outlineOf(oursPages);
  const diff = diffOutlines(legacy, ours);
  const legacyRows = rowTextsOf(legacyPages);
  const oursRows = rowTextsOf(oursPages);
  const { counts: rows, lines: rowLines } = compareRowTexts(legacyRows, oursRows);
  mkdirSync(o.out, { recursive: true });
  writeFileSync(join(o.out, "outline-legacy.txt"), `${legacy.join("\n")}\n`);
  writeFileSync(join(o.out, "outline-new.txt"), `${ours.join("\n")}\n`);
  writeFileSync(join(o.out, "diff.txt"), `${diff.join("\n")}\n`);
  writeFileSync(join(o.out, "rows-legacy.txt"), [...legacyRows].map(([k, v]) => `${k}\t${v}\n`).join(""));
  writeFileSync(join(o.out, "rows-new.txt"), [...oursRows].map(([k, v]) => `${k}\t${v}\n`).join(""));
  writeFileSync(join(o.out, "rows-diff.txt"), `${rowLines.join("\n")}\n`);
  return { same: diff.every((l) => l.startsWith("  ")) && rows.differ + rows.onlyLegacy + rows.onlyOurs === 0, diff, rows };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    const v = i === -1 ? undefined : process.argv[i + 1];
    if (!v) throw new Error(`--${name} is required (see the usage at the top of scripts/calendar-report-compare.ts)`);
    return v;
  };
  const { same, diff, rows } = await compareReports({ legacy: arg("legacy"), ours: arg("new"), out: arg("out") });
  const n = diff.filter((l) => !l.startsWith("  ")).length;
  console.log(same ? "The outlines match." : `The outlines differ in ${n} lines; rows: ${rows.differ} differ, ${rows.onlyLegacy} only in legacy, ${rows.onlyOurs} only in ours: see diff.txt and rows-diff.txt.`);
  process.exit(same ? 0 : 1);
}
