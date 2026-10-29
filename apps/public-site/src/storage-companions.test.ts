import { mkdir, mkdtemp, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import compression from "compression";
import { backfillCompanions, isCompanionCandidate } from "./precompress";
import { fsStorage } from "./storage";

const BIG = "<p>government news release body text</p>\n".repeat(100); // ~4 KB
const exists = (p: string) => stat(p).then(() => true, () => false);
const fresh = () => mkdtemp(join(tmpdir(), "site-co-"));

describe("fsStorage writes compressed companions", () => {
  it("writes <file>.br and <file>.gz that decompress to the original byte for byte", async () => {
    const root = await fresh();
    await fsStorage(root).write("releases/K1/index.html", BIG);
    const original = await readFile(join(root, "releases/K1/index.html"));
    expect(brotliDecompressSync(await readFile(join(root, "releases/K1/index.html.br"))).equals(original)).toBe(true);
    expect(gunzipSync(await readFile(join(root, "releases/K1/index.html.gz"))).equals(original)).toBe(true);
    expect((await readdir(join(root, "releases/K1"))).filter((f) => f.includes(".tmp"))).toEqual([]);
    // Stamped with the page's own mtime: the stack serves a companion only when the two match.
    expect((await stat(join(root, "releases/K1/index.html.br"))).mtimeMs).toBe((await stat(join(root, "releases/K1/index.html"))).mtimeMs);
  });

  it.each(["a.html", "feed.xml", "atom.xml", "sitemap.xml", "x.css", "x.js", "x.json", "x.svg", "robots.txt", "favicon.ico"])("%s gets companions", async (name) => {
    const root = await fresh();
    await fsStorage(root).write(name, BIG);
    expect(await exists(join(root, `${name}.br`))).toBe(true);
    expect(await exists(join(root, `${name}.gz`))).toBe(true);
  });

  it("binary, tiny (< 1 KB) and dot files get none", async () => {
    const root = await fresh();
    const s = fsStorage(root);
    await s.write("a.woff2", new Uint8Array(5000).fill(7));
    await s.write("a.png", new Uint8Array(5000).fill(7));
    await s.write("tiny.html", "<p>x</p>");
    await s.write(".site-state.json", BIG);
    await s.write("releases/_long/h/.key", BIG);
    expect((await readdir(root)).filter((f) => /\.(br|gz)$/.test(f))).toEqual([]);
  });

  it("agrees with compression's own rule: compresses exactly what it would at 1 KB", async () => {
    const mime = createRequire(import.meta.url)("mime-types") as { contentType(name: string): string | false };
    for (const ext of [".html", ".xml", ".css", ".js", ".json", ".svg", ".txt", ".ico", ".png", ".woff2", ".pdf", ".jpg", ".key", ".webmanifest"]) {
      const type = mime.contentType(`x${ext}`) || "";
      const would = compression.filter({ headers: {} } as never, { getHeader: () => type } as never);
      expect(isCompanionCandidate(`x${ext}`, 1024), ext).toBe(Boolean(would));
      expect(isCompanionCandidate(`x${ext}`, 1023), ext).toBe(false);
    }
  });

  it("a rewrite replaces both companions; shrinking below 1 KB removes them", async () => {
    const root = await fresh();
    const s = fsStorage(root);
    await s.write("p.html", BIG);
    await s.write("p.html", BIG + "<p>more</p>");
    expect(gunzipSync(await readFile(join(root, "p.html.gz"))).toString()).toBe(BIG + "<p>more</p>");
    await s.write("p.html", "<p>tiny</p>");
    expect(await exists(join(root, "p.html.br"))).toBe(false);
    expect(await exists(join(root, "p.html.gz"))).toBe(false);
  });

  it("remove deletes the companions with the file; removing a missing file is fine", async () => {
    const root = await fresh();
    const s = fsStorage(root);
    await s.write("releases/K1/index.html", BIG);
    await s.remove("releases/K1/index.html");
    expect(await readdir(join(root, "releases/K1"))).toEqual([]);
    await s.remove("releases/K1/index.html");
    await s.removeEmptyDir("releases/K1"); // empty again, so it goes
    expect(await exists(join(root, "releases/K1"))).toBe(false);
  });

  it("cleans every temp file when the rename fails", async () => {
    const root = await fresh();
    await mkdir(join(root, "d", "index.html"), { recursive: true });
    await expect(fsStorage(root).write("d/index.html", BIG)).rejects.toThrow();
    expect((await readdir(join(root, "d"))).filter((f) => f.includes(".tmp"))).toEqual([]);
  });
});

describe("backfillCompanions (site:precompress)", () => {
  it("creates missing companions for files already on disk, leaves fresh ones, replaces stale ones, drops orphans", async () => {
    const root = await fresh();
    await mkdir(join(root, "a"), { recursive: true });
    await writeFile(join(root, "a/index.html"), BIG);
    await writeFile(join(root, "b.css"), BIG);
    await writeFile(join(root, "c.png"), Buffer.alloc(4000, 1));
    await writeFile(join(root, ".site-state.json"), BIG);
    await writeFile(join(root, "gone.html.br"), "orphan");
    const first = await backfillCompanions(root);
    expect(first).toMatchObject({ written: 2, orphansRemoved: 1 });
    expect(brotliDecompressSync(await readFile(join(root, "a/index.html.br"))).toString()).toBe(BIG);
    expect(await exists(join(root, "c.png.br"))).toBe(false);
    expect(await exists(join(root, ".site-state.json.br"))).toBe(false);
    expect(await exists(join(root, "gone.html.br"))).toBe(false);
    expect(await backfillCompanions(root)).toMatchObject({ written: 0, current: 2 });
    // The original changes behind the companions' back (an older companion mtime): rebuilt.
    await writeFile(join(root, "b.css"), BIG + "x");
    const future = new Date(Date.now() + 5000);
    await utimes(join(root, "b.css"), future, future);
    expect(await backfillCompanions(root)).toMatchObject({ written: 1 });
    expect(gunzipSync(await readFile(join(root, "b.css.gz"))).toString()).toBe(BIG + "x");
  });
});
