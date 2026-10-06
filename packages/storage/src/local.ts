import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { InvalidKeyError, assertSafeKey } from "./names";

export interface StoredObject {
  key: string;
  contentType: string;
  size: number;
  updatedAt: Date;
}

export interface ObjectStore {
  put(key: string, bytes: Buffer, contentType: string): Promise<StoredObject>;
  get(key: string): Promise<{ bytes: Buffer; meta: StoredObject } | null>;
  delete(key: string): Promise<boolean>;
  list(prefix: string): Promise<StoredObject[]>;
  publicPath(key: string): string;
}

interface MetaFile {
  contentType: string;
  size: number;
  updatedAt: string;
}

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

async function atomicWrite(path: string, data: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(8).toString("hex")}`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, path);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      // best-effort cleanup; the original error is what matters
    }
    throw err;
  }
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === "ENOENT";
}

/**
 * A local-folder ObjectStore. Objects live at `<root>/<key>`; metadata lives
 * at `<root>/.meta/<key>.json`. Writes are atomic (temp file + rename).
 */
export function localStore(root: string, publicPrefix = "/files/"): ObjectStore {
  const filePath = (key: string) => join(root, key);
  const metaPath = (key: string) => join(root, ".meta", `${key}.json`);

  async function readMeta(key: string): Promise<StoredObject | null> {
    let st;
    try {
      st = await stat(filePath(key));
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
    // Missing or corrupt metadata is not fatal: fall back to defaults
    // derived from the file itself rather than failing the read.
    let meta: MetaFile | null = null;
    try {
      meta = JSON.parse(await readFile(metaPath(key), "utf8")) as MetaFile;
    } catch {
      meta = null;
    }
    return {
      key,
      contentType: meta?.contentType ?? DEFAULT_CONTENT_TYPE,
      size: meta?.size ?? st.size,
      updatedAt: meta?.updatedAt ? new Date(meta.updatedAt) : st.mtime,
    };
  }

  return {
    async put(key, bytes, contentType) {
      assertSafeKey(key);
      await atomicWrite(filePath(key), bytes);
      const updatedAt = new Date();
      const meta: MetaFile = { contentType, size: bytes.length, updatedAt: updatedAt.toISOString() };
      await atomicWrite(metaPath(key), JSON.stringify(meta));
      return { key, contentType, size: bytes.length, updatedAt };
    },

    async get(key) {
      assertSafeKey(key);
      let bytes: Buffer;
      try {
        bytes = await readFile(filePath(key));
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
      const meta = await readMeta(key);
      if (!meta) return null;
      return { bytes, meta };
    },

    async delete(key) {
      assertSafeKey(key);
      try {
        await unlink(filePath(key));
      } catch (err) {
        if (isEnoent(err)) return false;
        throw err;
      }
      try {
        await unlink(metaPath(key));
      } catch (err) {
        if (!isEnoent(err)) throw err;
      }
      return true;
    },

    async list(prefix) {
      // First layer: the prefix must itself look like a safe key (this is
      // what rejects things like ".meta" or "a/../b" outright, rather than
      // relying solely on where the resolved path happens to land).
      if (prefix !== "") {
        const normalized = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
        assertSafeKey(normalized);
      }

      // Second layer (defense in depth): the resolved path must still be
      // inside root.
      const resolvedRoot = resolve(root);
      const base = resolve(root, prefix);
      if (base !== resolvedRoot && !base.startsWith(resolvedRoot + sep)) {
        throw new InvalidKeyError(prefix, "prefix escapes root");
      }

      const keys: string[] = [];

      async function walk(dir: string): Promise<void> {
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch (err) {
          if (isEnoent(err)) return;
          throw err;
        }
        for (const entry of entries) {
          if (entry.name === ".meta") continue;
          if (entry.name.includes(".tmp-")) continue; // in-progress atomic write
          const entryPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(entryPath);
          } else if (entry.isFile()) {
            keys.push(relative(resolvedRoot, entryPath).split(sep).join("/"));
          }
        }
      }

      await walk(base);
      keys.sort();
      const metas = await Promise.all(keys.map((key) => readMeta(key)));
      return metas.filter((meta): meta is StoredObject => meta !== null);
    },

    publicPath(key) {
      return publicPrefix + key.split("/").map(encodeURIComponent).join("/");
    },
  };
}
