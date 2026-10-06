import { lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface SiteStorage {
  write(relPath: string, html: string): Promise<void>;
  remove(relPath: string): Promise<void>;
}

/** `realpath`, but `undefined` (instead of a thrown ENOENT) when the path doesn't exist. */
async function tryRealpath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * Walks up from `path` until it finds a component that already exists (via `lstat`, so a
 * symlink itself counts even if its target is broken) and returns that ancestor, unresolved.
 * Used so write() can check *before* calling `mkdir(recursive: true)` — which would otherwise
 * silently walk through and create directories inside a planted symlink without ever seeing a
 * resolved path.
 */
async function nearestExistingAncestor(path: string): Promise<string> {
  let candidate = path;
  for (;;) {
    try {
      await lstat(candidate);
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = dirname(candidate);
      if (parent === candidate) return candidate; // reached the filesystem root
      candidate = parent;
    }
  }
}

/**
 * The one "is this real (symlink-resolved) path actually inside root" check, shared by every
 * call site that needs it: write()'s pre- and post-mkdir checks, and remove()'s check.
 */
function assertInsideRoot(realBase: string, real: string, relPath: string): void {
  if (real !== realBase && !real.startsWith(realBase + sep)) {
    throw new Error(`path outside output dir: ${relPath}`);
  }
}

export function fsStorage(root: string): SiteStorage {
  const base = resolve(root);
  const target = (relPath: string): string => {
    const full = resolve(base, relPath);
    const rel = relative(base, full);
    if (isAbsolute(relPath) || rel.startsWith("..") || isAbsolute(rel) || rel === "") throw new Error(`path outside output dir: ${relPath}`);
    return full;
  };
  return {
    async write(relPath, html) {
      const full = target(relPath);
      const dir = dirname(full);

      // target()'s check above is purely syntactic (string prefix matching on the unresolved
      // path), so a symlink planted inside root (e.g. releases/K1 -> /etc) can still redirect
      // a syntactically-safe relPath outside root — and mkdir(recursive) would walk straight
      // through it, creating directories outside root, before any check below ever ran. Find
      // the nearest ancestor that already exists and make sure it's still really inside root
      // first. If root itself doesn't exist yet, there's nothing inside it a symlink could be
      // hiding behind, so there's nothing to check — just create it fresh below.
      const ancestor = await nearestExistingAncestor(dir);
      const realBaseBeforeMkdir = await tryRealpath(base);
      if (realBaseBeforeMkdir !== undefined) {
        assertInsideRoot(realBaseBeforeMkdir, await realpath(ancestor), relPath);
      }

      await mkdir(dir, { recursive: true });

      // Re-check with the real (symlink-resolved) paths now that mkdir has walked the whole
      // chain, in case a symlink was planted deeper than the pre-check's ancestor.
      assertInsideRoot(await realpath(base), await realpath(dir), relPath);

      const tmp = `${full}.${randomUUID()}.tmp`;
      try {
        await writeFile(tmp, html, "utf8");
        await rename(tmp, full); // atomic on one filesystem: readers never see a half-written page
      } catch (err) {
        await rm(tmp, { force: true }); // don't leave a stray .tmp behind on failure
        throw err;
      }
    },
    async remove(relPath) {
      const full = target(relPath);
      const realDir = await tryRealpath(dirname(full));
      if (realDir === undefined) return; // the parent doesn't exist, so neither does the file
      assertInsideRoot(await realpath(base), realDir, relPath);
      await rm(full, { force: true });
    },
  };
}
