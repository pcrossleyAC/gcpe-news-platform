/** Legacy's Azure front door for the `files` container (verified 2026-10-29: serves the same bytes as news.gov.bc.ca/files/…). */
export const DEFAULT_LEGACY_FILES_ORIGIN = "https://bcgovnews-etg7c8etapa6btfr.z03.azurefd.net";

export interface LegacyFilesCliOptions {
  /** Where the files are fetched from: scheme, host and optional port only. */
  origin: string;
  /** Parallel requests, 1..4; each worker starts at most one request a second. */
  concurrency: number;
  dryRun: boolean;
  refresh: boolean;
  /** Scan the databases named by CORE_/NRMS_/NEWSAPI_DATABASE_URL (`--no-db`: don't). */
  db: boolean;
  /** One path per line (bare, /files/-relative or absolute news.gov.bc.ca URLs). */
  pathsFiles: string[];
  /** Any text (HTML, JSON, IIS logs): every legacy /files/ link in it. */
  scanFiles: string[];
  /** Stop after this many requests (0: no cap). */
  maxRequests: number;
  /** A file larger than this many MiB fails (default 512). Imports may exceed the Hub's 25 MB upload cap up to this. */
  maxFileMb: number;
}

export const LEGACY_FILES_USAGE =
  "usage: legacy-files:copy [--dry-run] [--refresh] [--concurrency <1..4>] [--max-file-mb <n>] [--max-requests <n>]   (with LEGACY_FILES_SAS_URL: the container is listed)\n" +
  "       legacy-files:copy ... [--origin <https://host>] [--paths-file <file>]... [--scan-file <file>]... [--no-db]   (without: links in our content)";

export const MAX_CONCURRENCY = 4;
const VALUE_FLAGS = new Set(["--origin", "--concurrency", "--paths-file", "--scan-file", "--max-requests", "--max-file-mb"]);

function count(flag: string, raw: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`${flag} needs a whole number, got "${raw}"`);
  return Number(raw);
}

/** An https origin (no path, query or credentials), without a trailing slash. */
export function parseOrigin(flag: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${flag} must be an https URL, got "${value}"`);
  }
  if (url.protocol !== "https:") throw new Error(`${flag} must be an https URL`);
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash || url.username || url.password) throw new Error(`${flag} must be an origin only (https://host[:port]), got "${value}"`);
  return url.origin;
}

/** argv after `node script`. Unknown arguments are refused, never ignored. */
export function parseLegacyFilesArgs(argv: string[]): LegacyFilesCliOptions {
  const o: LegacyFilesCliOptions = { origin: DEFAULT_LEGACY_FILES_ORIGIN, concurrency: 1, dryRun: false, refresh: false, db: true, pathsFiles: [], scanFiles: [], maxRequests: 0, maxFileMb: 512 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf("=");
    const [flag, inline] = arg.startsWith("--") && eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    if (flag === "--dry-run") o.dryRun = true;
    else if (flag === "--refresh") o.refresh = true;
    else if (flag === "--no-db") o.db = false;
    else if (VALUE_FLAGS.has(flag)) {
      const value = inline ?? argv[++i];
      if (value === undefined || value === "") throw new Error(`${flag} needs a value\n${LEGACY_FILES_USAGE}`);
      if (flag === "--origin") o.origin = parseOrigin(flag, value);
      else if (flag === "--concurrency") {
        o.concurrency = count(flag, value);
        if (o.concurrency < 1 || o.concurrency > MAX_CONCURRENCY) throw new Error(`--concurrency must be 1 to ${MAX_CONCURRENCY}, got ${o.concurrency}`);
      } else if (flag === "--paths-file") o.pathsFiles.push(value);
      else if (flag === "--scan-file") o.scanFiles.push(value);
      else if (flag === "--max-file-mb") {
        o.maxFileMb = count(flag, value);
        if (o.maxFileMb < 1) throw new Error("--max-file-mb must be at least 1");
      } else o.maxRequests = count(flag, value);
    } else throw new Error(`Unknown argument: ${arg}\n${LEGACY_FILES_USAGE}`);
  }
  return o;
}

/**
 * `LEGACY_FILES_SAS_URL`: the legacy `files` container's URL with a read+list SAS
 * (`https://<account>.blob.core.windows.net/files?sv=…&sp=rl&sig=…`). A secret: an error here
 * never repeats the value.
 */
export function parseSasUrl(value: string): string {
  const fail = (why: string): never => {
    throw new Error(`LEGACY_FILES_SAS_URL ${why} (the value is not shown)`);
  };
  let url: URL | null = null;
  try {
    url = new URL(value);
  } catch {
    fail("is not a URL");
  }
  if (url!.protocol !== "https:") fail("must be https");
  if (!/^\/[^/]+\/?$/.test(url!.pathname)) fail("must be the container's URL (https://<account>.blob.core.windows.net/<container>?…)");
  if (!url!.searchParams.get("sig")) fail("has no SAS signature (sig=)");
  return value;
}
