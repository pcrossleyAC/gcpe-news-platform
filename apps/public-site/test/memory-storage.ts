import type { SiteStorage } from "../src/storage";

export function memoryStorage(): SiteStorage & { files: Map<string, string | Uint8Array> } {
  const files = new Map<string, string | Uint8Array>();
  return {
    files,
    async write(relPath, content) {
      files.set(relPath, content);
    },
    async remove(relPath) {
      files.delete(relPath);
    },
    async exists(relPath) {
      return files.has(relPath);
    },
    async read(relPath) {
      const v = files.get(relPath);
      return v === undefined ? null : typeof v === "string" ? v : Buffer.from(v).toString("utf8");
    },
    async listDirs(relPath) {
      const prefix = `${relPath}/`;
      const names = new Set<string>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const seg = key.slice(prefix.length).split("/")[0];
        if (seg && key.slice(prefix.length).includes("/")) names.add(seg);
      }
      return [...names];
    },
  };
}
