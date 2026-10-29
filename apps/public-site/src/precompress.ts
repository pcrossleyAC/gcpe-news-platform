import { readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, extname, join } from "node:path";
import { brotliCompress, constants, gzip } from "node:zlib";
import { promisify } from "node:util";

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/**
 * Static text is compressed once, when the site writes it, and the stack serves the stored copy
 * (apps/stack/src/site-mount.ts) instead of compressing on every request (compress.ts). The
 * companions sit next to the file: `<file>.br` and `<file>.gz`.
 */

/** compress.ts's threshold (the `compression` default): a response under 1 KB is sent as is. */
export const COMPANION_MIN_BYTES = 1024;

/**
 * Brotli quality for a stored copy. Compressed once per write, so far above the q4 the per-request
 * path uses. 10, not the maximum 11: on the fixture site's pages q11 costs 14 ms against 4.6 ms for 3% more bytes (a 343 KB stylesheet: 270 ms against 88 ms).
 */
export const BROTLI_QUALITY = 10;
export const GZIP_LEVEL = 9;

/**
 * The extensions whose Content-Type `compression` compresses (mime-db's `compressible` flag), among
 * the files the site writes: HTML, the RSS/Atom feeds and sitemaps (XML), CSS, JS, JSON, SVG, text
 * and the favicon (image/x-icon is flagged compressible). A test checks this list against
 * `compression.filter` itself.
 */
const COMPRESSIBLE_EXTENSIONS: ReadonlySet<string> = new Set([".html", ".htm", ".xml", ".css", ".js", ".mjs", ".json", ".svg", ".txt", ".ico", ".webmanifest"]);

/** Whether a file at `relPath` of `bytes` length gets companions (never a dot file: those aren't served). */
export function isCompanionCandidate(relPath: string, bytes: number): boolean {
  return bytes >= COMPANION_MIN_BYTES && isCompressibleName(relPath);
}

/** The name alone, ignoring size: whether a rewrite or removal has companions to replace or delete. */
export function isCompressibleName(relPath: string): boolean {
  const name = basename(relPath);
  return !name.startsWith(".") && COMPRESSIBLE_EXTENSIONS.has(extname(name).toLowerCase());
}

export interface Companions {
  br: Buffer;
  gz: Buffer;
}

/** Both encodings of `body`, or `null` for either that is not smaller than the original. */
export async function compressCompanions(body: Buffer): Promise<{ br: Buffer | null; gz: Buffer | null }> {
  const [br, gz] = await Promise.all([
    brotliAsync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY, [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT, [constants.BROTLI_PARAM_SIZE_HINT]: body.length } }),
    gzipAsync(body, { level: GZIP_LEVEL }),
  ]);
  return { br: br.length < body.length ? br : null, gz: gz.length < body.length ? gz : null };
}

export const companionPaths = (file: string): [string, string] => [`${file}.br`, `${file}.gz`];

export interface BackfillResult {
  /** Companions written (one count per file with at least one companion written). */
  written: number;
  /** Files whose companions were already there and not older than the file. */
  current: number;
  /** `.br`/`.gz` files whose original no longer exists, removed. */
  orphansRemoved: number;
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) yield* walk(join(dir, e.name));
    else if (e.isFile()) yield join(dir, e.name);
  }
}

/** A companion this much older than its page still counts as current (utimes truncates below a millisecond). */
export const FRESHNESS_SLACK_MS = 1;

const freshFor = async (companion: string, mtimeMs: number): Promise<boolean> => {
  try {
    return (await stat(companion)).mtimeMs + FRESHNESS_SLACK_MS >= mtimeMs;
  } catch {
    return false;
  }
};

/**
 * Creates the companions for files already on disk (a site written before companions existed, or
 * restored from a backup), replaces any older than their file and removes orphans. Idempotent;
 * safe while the site is live: a companion is stamped with the mtime of the original it was
 * computed from, and dropped if the original changed meanwhile, so a page the builder rewrote in
 * the middle leaves a companion older than the new page, which the stack ignores. Sequential, so
 * it takes one core at most. `site:precompress` (cli/precompress.ts) runs it.
 */
export async function backfillCompanions(root: string, log: (line: string) => void = () => {}): Promise<BackfillResult> {
  const result: BackfillResult = { written: 0, current: 0, orphansRemoved: 0 };
  for await (const file of walk(root)) {
    if (/\.(br|gz)$/i.test(file)) {
      const original = file.slice(0, -3);
      if (!(await stat(original).then((s) => s.isFile(), () => false)) || !isCompressibleName(original)) {
        await rm(file, { force: true });
        result.orphansRemoved++;
        log(`removed orphan ${file}`);
      }
      continue;
    }
    if (!isCompressibleName(file)) continue;
    const before = await stat(file);
    if (!isCompanionCandidate(file, before.size)) continue;
    const [brPath, gzPath] = companionPaths(file);
    if ((await freshFor(brPath, before.mtimeMs)) && (await freshFor(gzPath, before.mtimeMs))) {
      result.current++;
      continue;
    }
    const body = await readFile(file);
    const { br, gz } = await compressCompanions(body);
    const after = await stat(file).catch(() => null);
    if (!after || after.mtimeMs !== before.mtimeMs || after.size !== before.size) continue; // rewritten meanwhile: the builder wrote its own
    for (const [path, bytes] of [[brPath, br], [gzPath, gz]] as const) {
      if (bytes === null) {
        await rm(path, { force: true });
        continue;
      }
      const tmp = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(tmp, bytes);
        await utimes(tmp, before.atime, before.mtime);
        await rename(tmp, path);
      } catch (err) {
        await rm(tmp, { force: true });
        throw err;
      }
    }
    result.written++;
  }
  return result;
}
