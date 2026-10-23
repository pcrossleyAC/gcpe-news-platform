import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Everything holding real data, the mapping and the key lives under here, and nowhere else. */
export const PRIVATE_ROOT = join(homedir(), "gcpe-parity-private");
const REPO = resolve(import.meta.dirname, "..", "..", "..");

/** A bad command line or setting: its message is ours and carries no data, so it is safe to print. */
export class ScrubArgumentError extends Error { override name = "ScrubArgumentError"; }
/** A step that failed for a reason we can name without quoting any data. */
export class ScrubStepError extends Error { override name = "ScrubStepError"; }

/** The real path of `p`, resolving the nearest existing parent when `p` doesn't exist yet. */
function real(p: string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) break;
    rest.unshift(basename(cur));
    cur = up;
  }
  return join(realpathSync(cur), ...rest);
}
const strictlyInside = (root: string, p: string) => {
  const rel = relative(real(root), real(p));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

export function preparePrivateDir(dir: string, root = PRIVATE_ROOT): string {
  if (real(dir) === real(REPO) || strictlyInside(REPO, dir)) throw new ScrubArgumentError("--out must be outside the repository: the run holds real data");
  if (!strictlyInside(root, dir)) throw new ScrubArgumentError(`--out must be a folder inside ${root}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return real(dir);
}

export function writePrivate(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

const KEY = /^[0-9a-f]{64}$/;
/** The key that makes fictional identities stable from run to run without being guessable from the repo. */
export function loadOrCreateKey(path: string): string {
  if (existsSync(path)) {
    const k = readFileSync(path, "utf8").trim();
    if (!KEY.test(k)) throw new ScrubArgumentError("the scrub key file must hold 64 hex characters");
    return k;
  }
  const k = randomBytes(32).toString("hex");
  writePrivate(path, `${k}\n`);
  return k;
}

export function runStamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

export async function withPrivateUmask<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.umask(0o077);
  try {
    return await fn();
  } finally {
    process.umask(previous);
  }
}
