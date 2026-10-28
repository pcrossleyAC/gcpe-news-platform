import { DEFAULT_FILES_BASE } from "./public-files";
import { DEFAULT_PUBLIC_API_BASE } from "./public-fetch";

export interface FilesImportCliOptions {
  from: string;
  /** Host of the translation/asset files (relative keys are made absolute under it). */
  filesBase: string;
  /** Parallel requests, 1..4; each worker starts at most one request a second. */
  concurrency: number;
  /** Only posts published on or after this date (YYYY-MM-DD, America/Vancouver). */
  since: string | null;
  /** Only these posts (and regardless of legacy's flags). */
  keys: string[];
  /** Fetch posts already filled again. */
  refresh: boolean;
  /** Every legacy-imported post, not only those legacy flags as having translations or media assets. */
  all: boolean;
  dryRun: boolean;
  /** Stop after this many requests (0: no cap). */
  maxRequests: number;
}

export const FILES_IMPORT_USAGE = `usage: import:files [--from <base>] [--files-base <url>] [--concurrency <1..4>] [--since <YYYY-MM-DD>] [--keys k1,k2,...] [--max-requests <n>] [--all] [--refresh] [--dry-run]`;

export const MAX_CONCURRENCY = 4;

const VALUE_FLAGS = new Set(["--from", "--files-base", "--concurrency", "--since", "--keys", "--max-requests"]);

function count(flag: string, raw: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`${flag} needs a whole number, got "${raw}"`);
  return Number(raw);
}

/** `import:files`'s argv (after `node script`). Unknown arguments are rejected, never ignored. */
export function parseFilesImportArgs(argv: string[]): FilesImportCliOptions {
  const o: FilesImportCliOptions = { from: DEFAULT_PUBLIC_API_BASE, filesBase: DEFAULT_FILES_BASE, concurrency: 1, since: null, keys: [], refresh: false, all: false, dryRun: false, maxRequests: 0 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf("=");
    const [flag, inline] = arg.startsWith("--") && eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    if (flag === "--dry-run") o.dryRun = true;
    else if (flag === "--refresh") o.refresh = true;
    else if (flag === "--all") o.all = true;
    else if (VALUE_FLAGS.has(flag)) {
      const value = inline ?? argv[++i];
      if (value === undefined || value === "") throw new Error(`${flag} needs a value\n${FILES_IMPORT_USAGE}`);
      if (flag === "--from") {
        const url = new URL(value);
        if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`--from must be an http(s) URL`);
        o.from = value.replace(/\/+$/, "");
      } else if (flag === "--files-base") {
        if (new URL(value).protocol !== "https:") throw new Error(`--files-base must be an https URL`);
        o.filesBase = value.replace(/\/+$/, "");
      } else if (flag === "--concurrency") {
        o.concurrency = count(flag, value);
        if (o.concurrency < 1 || o.concurrency > MAX_CONCURRENCY) throw new Error(`--concurrency must be 1 to ${MAX_CONCURRENCY}, got ${o.concurrency}`);
      } else if (flag === "--since") {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
        const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
        if (!d || d.toISOString().slice(0, 10) !== value) throw new Error(`--since needs a date as YYYY-MM-DD, got "${value}"`);
        o.since = value;
      } else if (flag === "--max-requests") o.maxRequests = count(flag, value);
      else o.keys.push(...value.split(",").map((k) => k.trim()).filter(Boolean));
    } else throw new Error(`Unknown argument: ${arg}\n${FILES_IMPORT_USAGE}`);
  }
  return o;
}
