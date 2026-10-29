import { parseRequestTarget } from "../legacy/safe-path";

/**
 * Legacy `https://news.gov.bc.ca/files/<path>` links: which paths our content names, and the
 * one check every such path passes before it is imported as a site file name or is redirected
 * to (serving). See docs/parity/url-cutover-runbook.md, "Legacy /files".
 */

/** Paths no content links but news.gov serves, copied on every run. */
export const KNOWN_LEGACY_FILES: readonly string[] = [
  // `/assets/license` redirects here (apps/stack/src/legacy/rules.ts, C305), and the Hub's
  // default media-assets licence link names it.
  "News_Footage_License_British_Columbia.pdf",
];

/**
 * First segments that belong to NRMS's own store (apps/stack/src/files-gate.ts): release files
 * (`releases/…`, public only while the release is live, Q17) and carousel images (`slides/…`).
 * A legacy copy is never stored, served or redirected there, in any letter case.
 */
export const RESERVED_FIRST_SEGMENTS: readonly string[] = ["releases", "slides"];

/** Characters Windows refuses in a file name (":" and "\" are refused by parseRequestTarget too). */
const WINDOWS_INVALID = /[<>"|?*]/;
/** Windows device names, with or without an extension. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$)(\..*)?$/i;
const MAX_SEGMENT = 255;
const MAX_PATH = 1024;

export type Normalized = { ok: true; path: string } | { ok: false; reason: string };

/**
 * A path under `/files/` as written in a link (still percent-encoded, no query), decoded
 * segment by segment, or why it is refused. The result keeps its letter case and has no
 * leading slash: `Newsroom/Downloads/Fact Sheet.pdf`.
 *
 * Refused: anything parseRequestTarget refuses (malformed encoding, control characters, `\`, an
 * encoded `/`, `.`/`..` segments, Windows aliases — `:` streams, `~` 8.3 short names, a
 * trailing `.` or space), an empty segment, a segment starting with "." (dotfiles, the store's
 * own `.tmp`), characters or device names Windows can't hold, over-long names, and NRMS's
 * reserved first segments.
 */
export function normalizeLegacyPath(raw: string): Normalized {
  if (raw === "" || raw.startsWith("/")) return { ok: false, reason: "empty path or leading slash" };
  const target = parseRequestTarget(`/${raw}`);
  if (!target || target.query !== "") return { ok: false, reason: "unsafe or malformed path (traversal, dot segment, encoded separator, control character or Windows alias)" };
  const path = target.path.slice(1);
  const segments = path.split("/");
  for (const s of segments) {
    if (s === "") return { ok: false, reason: "empty path segment" };
    if (s.startsWith(".")) return { ok: false, reason: "segment starts with a dot" };
    if (WINDOWS_INVALID.test(s) || WINDOWS_DEVICE.test(s)) return { ok: false, reason: "name Windows can't store" };
    if (s.length > MAX_SEGMENT) return { ok: false, reason: "segment too long" };
  }
  if (path.length > MAX_PATH) return { ok: false, reason: "path too long" };
  if (RESERVED_FIRST_SEGMENTS.includes(segments[0]!.toLowerCase())) return { ok: false, reason: `reserved: /files/${segments[0]}/ is NRMS's own namespace` };
  return { ok: true, path };
}

/** Blob names to ask the origin for, in legacy's order: lowercased first, then as written. */
export function legacyCandidates(path: string): string[] {
  const lower = path.toLowerCase();
  return lower === path ? [path] : [lower, path];
}

export interface Extracted {
  /** Normalized paths, in order of first appearance, exact duplicates removed. */
  paths: string[];
  rejected: { reference: string; reason: string }[];
}

const ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** `https://news.gov.bc.ca/files/…` (http or https or protocol-relative, optional www., optional default port, any case). */
const ABSOLUTE = /^(?:https?:)?\/\/(?:www\.)?news\.gov\.bc\.ca(?::443|:80)?\/files\/(.*)$/is;
const RELATIVE = /^\/files\/(.*)$/is;

/** The part after `/files/` of a whole URL value (an attribute value or a path-file line), or null. */
function filesPathOf(url: string): string | null {
  const m = ABSOLUTE.exec(url) ?? RELATIVE.exec(url);
  if (!m) return null;
  return m[1]!.replace(/[?#].*$/s, "");
}

/** Quoted attribute values (any attribute: href, src, data-*, content …). */
const QUOTED_ATTRIBUTE = /=\s*(?:"([^"]*)"|'([^']*)')/g;
/** Unquoted occurrences in free text (text, JSON strings, log lines): absolute or relative, up to whitespace or a delimiter. */
const IN_TEXT = /(?:(?:https?:)?\/\/(?:www\.)?news\.gov\.bc\.ca(?::443|:80)?|(?<![\w.\-~:/%@\]]))\/files\/([^\s"'<>\\`?#]*)/gi;

/** Trailing sentence punctuation, and a closing parenthesis the path didn't open. */
function trimTrailing(raw: string): string {
  let s = raw.replace(/[.,;:!]+$/, "");
  while (s.endsWith(")") && (s.match(/\(/g)?.length ?? 0) < (s.match(/\)/g)?.length ?? 0)) s = s.slice(0, -1).replace(/[.,;:!]+$/, "");
  return s;
}

/**
 * Every legacy `/files/` link in `text` (HTML, plain text, JSON, a log): absolute news.gov.bc.ca
 * links (with or without www, http or https or protocol-relative) and relative `/files/…`
 * links, percent-encoded or not. A quoted attribute value is taken whole (so a name with spaces
 * survives); elsewhere a link ends at whitespace or a delimiter. Another host's `/files/` is not
 * a legacy link. A bare `/files/` names no file and is skipped silently.
 */
export function extractFileReferences(text: string): Extracted {
  const raws: string[] = [];
  const rest = text.replace(QUOTED_ATTRIBUTE, (whole, dq: string | undefined, sq: string | undefined) => {
    // Trimmed after decoding: hrefs in legacy bodies end in a stray &nbsp; or U+00A0 (seen live, 2026-10-29).
    const value = decodeEntities(dq ?? sq ?? "").trim();
    const p = filesPathOf(value);
    if (p === null) return whole;
    raws.push(p);
    return " ";
  });
  // Entities decoded first, then cut at any whitespace they produced (`…pdf&nbsp;</a>`, seen live).
  for (const m of rest.matchAll(IN_TEXT)) raws.push(trimTrailing(decodeEntities(m[1]!).split(/\s/)[0]!));
  return collect(raws);
}

function collect(raws: string[]): Extracted {
  const out: Extracted = { paths: [], rejected: [] };
  const seen = new Set<string>();
  const seenRejected = new Set<string>();
  for (const raw of raws) {
    if (raw === "") continue;
    const n = normalizeLegacyPath(raw);
    if (!n.ok) {
      if (!seenRejected.has(raw)) out.rejected.push({ reference: raw, reason: n.reason });
      seenRejected.add(raw);
    } else if (!seen.has(n.path)) {
      seen.add(n.path);
      out.paths.push(n.path);
    }
  }
  return out;
}

/** A `--paths-file`: one path per line, bare (`Newsroom/a.pdf`), `/files/`-relative or absolute; `#` comments and blank lines skipped. */
export function parsePathsFile(text: string): Extracted {
  const raws: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    raws.push(filesPathOf(t) ?? t.replace(/[?#].*$/s, ""));
  }
  return collect(raws);
}

/** Merges several extraction results, keeping first-seen order. */
export function mergeExtracted(parts: Extracted[]): Extracted {
  const out: Extracted = { paths: [], rejected: [] };
  const seen = new Set<string>();
  for (const p of parts) {
    for (const path of p.paths) if (!seen.has(path)) (seen.add(path), out.paths.push(path));
    out.rejected.push(...p.rejected);
  }
  return out;
}
