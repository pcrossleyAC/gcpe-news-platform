import { mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface SiteStorage {
  write(relPath: string, html: string): Promise<void>;
  remove(relPath: string): Promise<void>;
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
      await mkdir(dir, { recursive: true });
      // target()'s check above is purely syntactic (string prefix matching), so a symlink
      // planted inside root (e.g. releases/K1 -> /etc) can still redirect a syntactically-safe
      // relPath outside root once mkdir/writeFile follow it. Re-check with the real
      // (symlink-resolved) paths now that mkdir has walked the chain.
      const realBase = await realpath(base);
      const realDir = await realpath(dir);
      if (realDir !== realBase && !realDir.startsWith(realBase + sep)) {
        throw new Error(`path outside output dir: ${relPath}`);
      }
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
      await rm(target(relPath), { force: true });
    },
  };
}
