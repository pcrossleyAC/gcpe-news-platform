import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertSafeKey, InvalidKeyError, localStore, randomFileKey, safeFileName, sniff } from "./index";

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
});
