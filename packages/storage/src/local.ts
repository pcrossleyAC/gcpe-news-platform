import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { InvalidKeyError, assertSafeKey } from "./names";

export interface StoredObject {
  key: string;
  contentType: string;
  size: number;
  updatedAt: Date;
}

/** A streamed object ran past `maxBytes`: nothing was stored. */
export class ObjectTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`larger than ${maxBytes} bytes`);
    this.name = "ObjectTooLargeError";
  }
}

export interface ObjectStore {
  put(key: string, bytes: Buffer, contentType: string): Promise<StoredObject>;
  /** Streams `source` to `key` (temp file + rename): never holds the whole object in memory. Over `maxBytes`: ObjectTooLargeError, nothing stored. */
  putStream(key: string, source: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | Readable, contentType: string, opts?: { maxBytes?: number }): Promise<StoredObject>;
  /** Renames `from` onto `to` (bytes and metadata), replacing `to`. Throws when `from` doesn't exist. */
  move(from: string, to: string): Promise<StoredObject>;
  /** The first `n` bytes of `key` (fewer if it is shorter), or null when there is none. */
  readHead(key: string, n: number): Promise<Buffer | null>;
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

/** The rename onto `to` kept failing because Windows has the target open (EPERM/EBUSY/EACCES), after retries. */
export class ObjectBusyError extends Error {
  constructor(readonly key: string) {
    super(`${key} is in use (the rename kept failing)`);
    this.name = "ObjectBusyError";
  }
}

type RenameFn = (from: string, to: string) => Promise<void>;
export interface LocalStoreOptions {
  /** For tests: the rename to use (default fs.rename). */
  rename?: RenameFn;
  /** For tests: how to wait between rename retries. */
  sleep?: (ms: number) => Promise<void>;
}

/** Codes Windows answers when the rename target (or source) is open in another process: retried. */
const BUSY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
/** Waits before each of 5 retries: 100, 200, 400, 800, 1600 ms (about 3 s in all). */
const RENAME_BACKOFF_MS = [100, 200, 400, 800, 1600];

/**
 * fs.rename with retries for Windows: replacing a file that a reader (the /files static server, an
 * antivirus scan, a backup copy) has open fails EPERM/EBUSY/EACCES until it is closed. Retried 5
 * times with backoff; then ObjectBusyError (the caller answers 503, try again). Other errors at once.
 */
async function renameWithRetry(from: string, to: string, key: string, doRename: RenameFn, sleep: (ms: number) => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await doRename(from, to);
      return;
    } catch (err) {
      const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
      if (typeof code !== "string" || !BUSY_CODES.has(code)) throw err;
      if (attempt >= RENAME_BACKOFF_MS.length) throw new ObjectBusyError(key);
      await sleep(RENAME_BACKOFF_MS[attempt]!);
    }
  }
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function atomicWrite(path: string, data: string | Buffer, doRename: RenameFn = rename, sleep = realSleep): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(8).toString("hex")}`;
  try {
    await writeFile(tmp, data);
    await renameWithRetry(tmp, path, path, doRename, sleep);
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
export function localStore(root: string, publicPrefix = "/files/", options: LocalStoreOptions = {}): ObjectStore {
  const doRename: RenameFn = options.rename ?? rename;
  const sleep = options.sleep ?? realSleep;
  const write = (path: string, data: string | Buffer) => atomicWrite(path, data, doRename, sleep);
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
      await write(filePath(key), bytes);
      const updatedAt = new Date();
      const meta: MetaFile = { contentType, size: bytes.length, updatedAt: updatedAt.toISOString() };
      await write(metaPath(key), JSON.stringify(meta));
      return { key, contentType, size: bytes.length, updatedAt };
    },

    async putStream(key, source, contentType, opts = {}) {
      assertSafeKey(key);
      const path = filePath(key);
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp-${randomBytes(8).toString("hex")}`;
      const max = opts.maxBytes ?? Infinity;
      let size = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, done) {
          size += chunk.length;
          done(size > max ? new ObjectTooLargeError(max) : null, chunk);
        },
      });
      try {
        await pipeline(source instanceof Readable ? source : Readable.from(source), counter, createWriteStream(tmp, { flags: "wx" }));
        await renameWithRetry(tmp, path, key, doRename, sleep);
      } catch (err) {
        try {
          await unlink(tmp);
        } catch {
          // best-effort cleanup; the original error is what matters
        }
        throw err;
      }
      const updatedAt = new Date();
      const meta: MetaFile = { contentType, size, updatedAt: updatedAt.toISOString() };
      await write(metaPath(key), JSON.stringify(meta));
      return { key, contentType, size, updatedAt };
    },

    async move(from, to) {
      assertSafeKey(from);
      assertSafeKey(to);
      const meta = await readMeta(from);
      if (!meta) throw new InvalidKeyError(from, "no such object");
      await mkdir(dirname(filePath(to)), { recursive: true });
      await renameWithRetry(filePath(from), filePath(to), to, doRename, sleep);
      const moved: MetaFile = { contentType: meta.contentType, size: meta.size, updatedAt: new Date().toISOString() };
      await write(metaPath(to), JSON.stringify(moved));
      try {
        await unlink(metaPath(from));
      } catch (err) {
        if (!isEnoent(err)) throw err;
      }
      return { key: to, contentType: moved.contentType, size: moved.size, updatedAt: new Date(moved.updatedAt) };
    },

    async readHead(key, n) {
      assertSafeKey(key);
      let handle;
      try {
        handle = await open(filePath(key), "r");
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
      try {
        const buf = Buffer.alloc(n);
        const { bytesRead } = await handle.read(buf, 0, n, 0);
        return buf.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
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
