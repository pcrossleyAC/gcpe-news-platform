import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";

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
      await mkdir(dirname(full), { recursive: true });
      const tmp = `${full}.${randomUUID()}.tmp`;
      await writeFile(tmp, html, "utf8");
      await rename(tmp, full); // atomic on one filesystem: readers never see a half-written page
    },
    async remove(relPath) {
      await rm(target(relPath), { force: true });
    },
  };
}
