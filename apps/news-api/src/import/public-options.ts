import { DEFAULT_FILES_BASE } from "./public-files";
import { DEFAULT_PUBLIC_API_BASE } from "./public-fetch";

export interface PublicImportCliOptions {
  from: string;
  perKind: number;
  perCategory: number;
  keys: string[];
  maxRequests: number;
  dryRun: boolean;
  remove: boolean;
  /** Rewrite posts this importer created even when the source timestamp is unchanged. */
  refresh: boolean;
  /** Host of the translation/asset files (relative keys are made absolute under it). */
  filesBase: string;
}

export const PUBLIC_IMPORT_USAGE = `usage: import:public [--from <base>] [--per-kind <n>] [--per-category <n>] [--keys k1,k2,...] [--max-requests <n>] [--files-base <url>] [--refresh] [--dry-run]
       import:public --remove [--dry-run]`;

const VALUE_FLAGS = new Set(["--from", "--per-kind", "--per-category", "--keys", "--max-requests", "--files-base"]);

function count(flag: string, raw: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`${flag} needs a whole number, got "${raw}"`);
  return Number(raw);
}

/** `import:public`'s argv (after `node script`). Unknown arguments are rejected, never ignored. */
export function parsePublicImportArgs(argv: string[]): PublicImportCliOptions {
  const o: PublicImportCliOptions = { from: DEFAULT_PUBLIC_API_BASE, perKind: 20, perCategory: 3, keys: [], maxRequests: 300, dryRun: false, remove: false, refresh: false, filesBase: DEFAULT_FILES_BASE };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf("=");
    const [flag, inline] = arg.startsWith("--") && eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    if (flag === "--dry-run") o.dryRun = true;
    else if (flag === "--remove") o.remove = true;
    else if (flag === "--refresh") o.refresh = true;
    else if (VALUE_FLAGS.has(flag)) {
      const value = inline ?? argv[++i];
      if (value === undefined || value === "") throw new Error(`${flag} needs a value\n${PUBLIC_IMPORT_USAGE}`);
      if (flag === "--from") {
        const url = new URL(value);
        if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`--from must be an http(s) URL`);
        o.from = value.replace(/\/+$/, "");
      } else if (flag === "--files-base") {
        if (new URL(value).protocol !== "https:") throw new Error(`--files-base must be an https URL`);
        o.filesBase = value.replace(/\/+$/, "");
      } else if (flag === "--per-kind") o.perKind = count(flag, value);
      else if (flag === "--per-category") o.perCategory = count(flag, value);
      else if (flag === "--max-requests") o.maxRequests = count(flag, value);
      else o.keys.push(...value.split(",").map((k) => k.trim()).filter(Boolean));
    } else throw new Error(`Unknown argument: ${arg}\n${PUBLIC_IMPORT_USAGE}`);
  }
  if (o.remove && (o.keys.length > 0 || argv.some((a) => /^--(from|per-kind|per-category|max-requests|files-base|refresh)\b/.test(a)))) {
    throw new Error(`--remove takes no fetch options (it only deletes what this importer created)\n${PUBLIC_IMPORT_USAGE}`);
  }
  return o;
}
