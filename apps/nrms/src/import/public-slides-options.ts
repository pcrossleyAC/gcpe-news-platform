import { join } from "node:path";
import { parseSubscribers, type SubscriberConfig } from "@gcpe/events";
import { resolveDataDir } from "../../../stack/src/data-dir";
import { DEFAULT_SLIDES_API_BASE, STACK_SITE_SUBSCRIBERS, type PublicSlidesOptions } from "./public-slides";

export const PUBLIC_SLIDES_USAGE = `usage: import:public-slides [--from <base>] [--replace] [--dry-run]
       import:public-slides --remove [--replace] [--dry-run]`;

/** `import:public-slides`'s argv (after `node script`). Unknown arguments are rejected, never ignored. */
export function parsePublicSlidesArgs(argv: string[]): PublicSlidesOptions {
  const o: PublicSlidesOptions = { from: DEFAULT_SLIDES_API_BASE, dryRun: false, remove: false, replace: false };
  let fromGiven = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf("=");
    const [flag, inline] = arg.startsWith("--") && eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    if (flag === "--dry-run" && inline === undefined) o.dryRun = true;
    else if (flag === "--remove" && inline === undefined) o.remove = true;
    else if (flag === "--replace" && inline === undefined) o.replace = true;
    else if (flag === "--from") {
      const value = inline ?? argv[++i];
      if (value === undefined || value === "") throw new Error(`--from needs a value\n${PUBLIC_SLIDES_USAGE}`);
      const url = new URL(value);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("--from must be an http(s) URL");
      o.from = value.replace(/\/+$/, "");
      fromGiven = true;
    } else throw new Error(`Unknown argument: ${arg}\n${PUBLIC_SLIDES_USAGE}`);
  }
  if (o.remove && fromGiven) throw new Error(`--remove takes no --from (it fetches nothing)\n${PUBLIC_SLIDES_USAGE}`);
  return o;
}

/**
 * Where NRMS keeps (and the stack serves at /files) slide images, found as the stack finds it
 * (apps/stack/src/env.ts): NRMS_STORAGE_DIR, else `<DATA_DIR>/storage` with DATA_DIR defaulting
 * to ~/gcpe-data. A plain STORAGE_DIR (standalone NRMS) wins over both.
 */
export function storageDirFromEnv(env: NodeJS.ProcessEnv): string {
  return env.STORAGE_DIR || env.NRMS_STORAGE_DIR || join(resolveDataDir(env), "storage");
}

/** The origin slide image URLs carry, as the stack sets NRMS's PUBLIC_FILES_BASE: explicit, else the public site URL's origin. */
export function filesBaseFromEnv(env: NodeJS.ProcessEnv): string | null {
  const explicit = env.PUBLIC_FILES_BASE ?? env.NRMS_PUBLIC_FILES_BASE;
  if (explicit !== undefined) return explicit.replace(/\/+$/, "");
  const site = env.SITE_PUBLIC_SITE_URL;
  if (!site) return null;
  return new URL(site).origin;
}

/** NRMS's EVENT_SUBSCRIBERS as configured, else the stack's own (which is what boxs.ca runs). */
export function subscribersFromEnv(env: NodeJS.ProcessEnv): SubscriberConfig[] {
  const json = env.EVENT_SUBSCRIBERS ?? env.NRMS_EVENT_SUBSCRIBERS;
  return json ? parseSubscribers(json) : STACK_SITE_SUBSCRIBERS;
}
