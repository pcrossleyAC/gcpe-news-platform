import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
const require = createRequire(import.meta.url);
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendMatchingExtension, assertSafeKey, forceExtension, InvalidKeyError, localStore, ObjectBusyError, ObjectTooLargeError, randomFileKey, safeFileName, sniff } from "./index";

const PDF = Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj\n");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);

describe("names", () => {
  it("sanitises file names and generates random keys", () => {
    expect(safeFileName("Budget 2027 — Backgrounder (FR).PDF")).toBe("budget-2027-backgrounder-fr-.pdf");
    expect(safeFileName("../../etc/passwd")).toBe("etc-passwd");
    expect(safeFileName('a"b\r\n.pdf')).toBe("a-b-.pdf");
    expect(safeFileName("")).toBe("file");
    expect(safeFileName("x".repeat(300)).length).toBeLessThanOrEqual(100);
    expect(randomFileKey("releases/abc/translations", "Doc.pdf")).toMatch(/^releases\/abc\/translations\/[0-9a-f]{16}-doc\.pdf$/);
  });
  it("rejects unsafe keys", () => {
    for (const bad of ["../x", "a/../b", "/abs", "A/b", "a//b", "a/b/c/d/e", ".hidden", "a/.."]) expect(() => assertSafeKey(bad), bad).toThrow(InvalidKeyError);
    expect(() => assertSafeKey("releases/abc/translations/0123456789abcdef-doc.pdf")).not.toThrow();
  });

  it("appendMatchingExtension keeps a matching extension and appends the canonical one otherwise", () => {
    expect(appendMatchingExtension("doc.pdf", "application/pdf")).toBe("doc.pdf");
    expect(appendMatchingExtension("evil.html", "image/png")).toBe("evil.html.png");
    expect(appendMatchingExtension("photo.jpeg", "image/jpeg")).toBe("photo.jpeg");
  });

  it("forceExtension keeps a matching extension and replaces a mismatched one, or appends when there is none", () => {
    expect(forceExtension("budget-2026.pdf", "application/pdf")).toBe("budget-2026.pdf");
    expect(forceExtension("report.pdf", "image/png")).toBe("report.png");
    expect(forceExtension("report", "image/png")).toBe("report.png");
    expect(forceExtension("photo.jpeg", "image/jpeg")).toBe("photo.jpeg");
  });
});

describe("sniff", () => {
  it("recognises PDF, PNG and JPEG by magic bytes only", () => {
    expect(sniff(PDF)).toBe("application/pdf");
    expect(sniff(PNG)).toBe("image/png");
    expect(sniff(JPEG)).toBe("image/jpeg");
    expect(sniff(Buffer.from("<html><script>"))).toBeNull();
    expect(sniff(Buffer.from("MZ\x90\x00"))).toBeNull();
    expect(sniff(Buffer.alloc(0))).toBeNull();
  });
});

describe("localStore", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "gcpe-store-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it("puts, gets, lists, deletes, with metadata and public paths", async () => {
    const s = localStore(root);
    const key = "releases/r1/translations/0123456789abcdef-doc.pdf";
    const meta = await s.put(key, PDF, "application/pdf");
    expect(meta).toMatchObject({ key, contentType: "application/pdf", size: PDF.length });
    expect((await readFile(join(root, key))).equals(PDF)).toBe(true);
    expect((await s.get(key))!.bytes.equals(PDF)).toBe(true);
    expect((await s.list("releases/r1")).map((o) => o.key)).toEqual([key]);
    expect(s.publicPath(key)).toBe(`/files/${key}`);
    expect(await s.delete(key)).toBe(true);
    expect(await s.get(key)).toBeNull();
    expect(await s.delete(key)).toBe(false);
    await expect(stat(join(root, ".meta", `${key}.json`))).rejects.toThrow();
  });
  it("refuses unsafe keys at every entry point", async () => {
    const s = localStore(root);
    await expect(s.put("../escape", PDF, "application/pdf")).rejects.toThrow(InvalidKeyError);
    await expect(s.get("../escape")).rejects.toThrow(InvalidKeyError);
    await expect(s.delete("a/../b")).rejects.toThrow(InvalidKeyError);
  });

  it("rejects unsafe list prefixes but still lists everything on an empty prefix", async () => {
    const s = localStore(root);
    const key = "releases/r1/0123456789abcdef-doc.pdf";
    await s.put(key, PDF, "application/pdf");
    await expect(s.list("../x")).rejects.toThrow(InvalidKeyError);
    await expect(s.list(".meta")).rejects.toThrow(InvalidKeyError);
    expect((await s.list("")).map((o) => o.key)).toEqual([key]);
  });

  it("leaves no tmp file when a write fails, and list() ignores stray tmp files", async () => {
    const s = localStore(root);
    const blockedKey = "blocked/0123456789abcdef-x.pdf";
    await mkdir(join(root, blockedKey), { recursive: true });
    await expect(s.put(blockedKey, PDF, "application/pdf")).rejects.toThrow();
    const blockedEntries = await readdir(join(root, "blocked"));
    expect(blockedEntries.some((name) => name.includes(".tmp-"))).toBe(false);

    await writeFile(join(root, "blocked", "x.tmp-abc"), "partial");
    expect((await s.list("blocked")).map((o) => o.key)).not.toContain("blocked/x.tmp-abc");
  });

  it("falls back to octet-stream when metadata JSON is corrupt", async () => {
    const s = localStore(root);
    const key = "corrupt/0123456789abcdef-y.pdf";
    await s.put(key, PDF, "application/pdf");
    await writeFile(join(root, ".meta", `${key}.json`), "{not json");

    const got = await s.get(key);
    expect(got!.meta.contentType).toBe("application/octet-stream");
    expect(got!.meta.size).toBe(PDF.length);

    const listed = await s.list("corrupt");
    expect(listed[0]!.contentType).toBe("application/octet-stream");
  });
});

describe("localStore streaming (site files of any size)", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "storage-stream-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function* chunks(...parts: (string | Buffer)[]) {
    for (const p of parts) yield typeof p === "string" ? Buffer.from(p) : p;
  }

  it("putStream writes the bytes and metadata without buffering them in one Buffer; readHead reads the start", async () => {
    const store = localStore(root);
    const meta = await store.putStream("streamed.bin", chunks("ab", "cd", "ef"), "application/octet-stream");
    expect(meta).toMatchObject({ key: "streamed.bin", size: 6, contentType: "application/octet-stream" });
    expect((await store.get("streamed.bin"))!.bytes.toString()).toBe("abcdef");
    expect((await store.readHead("streamed.bin", 4))!.toString()).toBe("abcd");
    expect(await store.readHead("missing.bin", 4)).toBeNull();
  });

  it("putStream over maxBytes throws ObjectTooLargeError and leaves nothing behind (no file, no temp file)", async () => {
    const store = localStore(root);
    await expect(store.putStream("big.bin", chunks("12345", "67890", "x"), "application/octet-stream", { maxBytes: 10 })).rejects.toThrow(ObjectTooLargeError);
    expect(await store.get("big.bin")).toBeNull();
    expect((await readdir(root)).filter((n) => n.startsWith("big.bin"))).toEqual([]);
  });

  it("move renames an object (bytes and metadata) onto another key, replacing what was there", async () => {
    const store = localStore(root);
    await store.put("dest.pdf", Buffer.from("old"), "application/pdf");
    await store.putStream("tmp-1-dest.pdf", chunks("new bytes"), "application/pdf");
    const moved = await store.move("tmp-1-dest.pdf", "dest.pdf");
    expect(moved).toMatchObject({ key: "dest.pdf", size: 9, contentType: "application/pdf" });
    expect((await store.get("dest.pdf"))!.bytes.toString()).toBe("new bytes");
    expect(await store.get("tmp-1-dest.pdf")).toBeNull();
    await expect(store.move("nope.pdf", "x.pdf")).rejects.toThrow();
  });
});

describe("localStore renames on Windows: a busy target is retried, then ObjectBusyError", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "storage-busy-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const failing = (code: string, times: number) => {
    let left = times;
    const calls: string[] = [];
    const { rename } = require("node:fs/promises") as typeof import("node:fs/promises");
    const fn = async (from: string, to: string) => {
      calls.push(to);
      if (left-- > 0) throw Object.assign(new Error(`${code}: synthetic`), { code });
      return rename(from, to);
    };
    return { fn, calls };
  };

  it("EBUSY/EPERM/EACCES are retried with backoff (100, 200, 400, 800, 1600 ms) and then succeed", async () => {
    for (const code of ["EBUSY", "EPERM", "EACCES"]) {
      const sleeps: number[] = [];
      const f = failing(code, 2);
      const store = localStore(root, "/files/", { rename: f.fn, sleep: async (ms) => void sleeps.push(ms) });
      await store.put(`busy-${code.toLowerCase()}.pdf`, Buffer.from("old"), "application/pdf");
      await store.putStream(`tmp-${code.toLowerCase()}`, [Buffer.from("new")], "application/pdf");
      f.calls.length = 0;
      sleeps.length = 0;
      const failMove = failing(code, 2);
      const moving = localStore(root, "/files/", { rename: failMove.fn, sleep: async (ms) => void sleeps.push(ms) });
      await moving.move(`tmp-${code.toLowerCase()}`, `busy-${code.toLowerCase()}.pdf`);
      expect(sleeps.slice(0, 2), code).toEqual([100, 200]);
      expect((await store.get(`busy-${code.toLowerCase()}.pdf`))!.bytes.toString()).toBe("new");
    }
  });

  it("after 5 retries it throws ObjectBusyError; the source is left in place", async () => {
    const store = localStore(root);
    await store.putStream("tmp-stuck", [Buffer.from("x")], "application/pdf");
    const sleeps: number[] = [];
    const stuck = localStore(root, "/files/", { rename: failing("EBUSY", 99).fn, sleep: async (ms) => void sleeps.push(ms) });
    await expect(stuck.move("tmp-stuck", "stuck.pdf")).rejects.toThrow(ObjectBusyError);
    expect(sleeps).toEqual([100, 200, 400, 800, 1600]);
    expect(await store.get("tmp-stuck")).not.toBeNull();
  });

  it("other errors are not retried", async () => {
    const store = localStore(root);
    await store.putStream("tmp-other", [Buffer.from("x")], "application/pdf");
    const sleeps: number[] = [];
    const f = failing("EXDEV", 1);
    const other = localStore(root, "/files/", { rename: f.fn, sleep: async (ms) => void sleeps.push(ms) });
    await expect(other.move("tmp-other", "other.pdf")).rejects.toThrow(/EXDEV/);
    expect(sleeps).toEqual([]);
  });

  it("put's atomic write shares the retry", async () => {
    const sleeps: number[] = [];
    const store = localStore(root, "/files/", { rename: failing("EPERM", 1).fn, sleep: async (ms) => void sleeps.push(ms) });
    await store.put("retried.pdf", Buffer.from("ok"), "application/pdf");
    expect(sleeps).toEqual([100]);
    expect((await store.get("retried.pdf"))!.bytes.toString()).toBe("ok");
  });
});
