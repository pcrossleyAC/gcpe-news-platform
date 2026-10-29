import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { retryWhileBusy, RETRY_DELAYS_MS } from "./fs-retry";
import { backfillCompanions } from "./precompress";
import { fsStorage } from "./storage";

const BIG = "<p>government news release body text</p>\n".repeat(100);
const err = (code: string) => Object.assign(new Error(`${code}: simulated`), { code });
const noSleep = async () => {};

describe("retryWhileBusy", () => {
  it("retries EPERM / EACCES / EBUSY and returns once the operation succeeds", async () => {
    for (const code of ["EPERM", "EACCES", "EBUSY"]) {
      let calls = 0;
      const slept: number[] = [];
      const v = await retryWhileBusy(async () => {
        if (++calls <= 3) throw err(code);
        return "ok";
      }, async (ms) => void slept.push(ms));
      expect(v).toBe("ok");
      expect(calls).toBe(4);
      expect(slept).toEqual(RETRY_DELAYS_MS.slice(0, 3));
    }
  });

  it("gives up after 10 tries over about a second, with the last error", async () => {
    let calls = 0;
    await expect(retryWhileBusy(async () => { calls++; throw err("EBUSY"); }, noSleep)).rejects.toMatchObject({ code: "EBUSY" });
    expect(calls).toBe(10);
    const total = RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(800);
    expect(total).toBeLessThanOrEqual(1500);
  });

  it("never retries other errors", async () => {
    let calls = 0;
    await expect(retryWhileBusy(async () => { calls++; throw err("ENOENT"); }, noSleep)).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls).toBe(1);
  });
});

/** rename / rm that fail with `code` for paths matching `when`, `times` times (Infinity: always). */
function flaky(code: string, times: number, when: (to: string) => boolean) {
  let left = times;
  const calls: string[] = [];
  return {
    calls,
    fs: {
      rename: async (from: string, to: string) => {
        if (when(to) && left > 0) {
          left--;
          calls.push(to);
          throw err(code);
        }
        return rename(from, to);
      },
      rm: async (path: string, opts?: { force?: boolean }) => {
        if (when(path) && left > 0) {
          left--;
          calls.push(path);
          throw err(code);
        }
        return rm(path, opts);
      },
      sleep: noSleep,
    },
  };
}

describe("fsStorage on Windows: a reader or the virus scanner holds the file for a moment", () => {
  it("the page's rename fails EPERM 4 times, then succeeds: written, companions in place", async () => {
    const root = await mkdtemp(join(tmpdir(), "site-retry-"));
    const f = flaky("EPERM", 4, (p) => p.endsWith("index.html"));
    await fsStorage(root, f.fs).write("index.html", BIG);
    expect(f.calls.length).toBe(4);
    expect(await readFile(join(root, "index.html"), "utf8")).toBe(BIG);
    expect(brotliDecompressSync(await readFile(join(root, "index.html.br"))).toString()).toBe(BIG);
  });

  it("a companion's rename and the old companion's unlink fail EBUSY a few times: retried", async () => {
    const root = await mkdtemp(join(tmpdir(), "site-retry-"));
    await fsStorage(root).write("p.html", BIG);
    const f = flaky("EBUSY", 6, (p) => p.endsWith(".br"));
    await fsStorage(root, f.fs).write("p.html", BIG + "<p>2</p>");
    expect(f.calls.length).toBe(6);
    expect(brotliDecompressSync(await readFile(join(root, "p.html.br"))).toString()).toBe(BIG + "<p>2</p>");
  });

  it("remove retries the unlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "site-retry-"));
    await fsStorage(root).write("p.html", BIG);
    const f = flaky("EPERM", 2, (p) => p.endsWith("p.html") || p.endsWith(".gz"));
    await fsStorage(root, f.fs).remove("p.html");
    expect(f.calls.length).toBe(2);
    expect(await readdir(root)).toEqual([]);
  });

  it("a rename that always fails: the write rejects with EPERM after 10 tries and leaves no temp file", async () => {
    const root = await mkdtemp(join(tmpdir(), "site-retry-"));
    const f = flaky("EPERM", Infinity, (p) => p.endsWith("index.html"));
    await expect(fsStorage(root, f.fs).write("index.html", BIG)).rejects.toMatchObject({ code: "EPERM" });
    expect(f.calls.length).toBe(10);
    expect((await readdir(root)).filter((n) => n.includes(".tmp"))).toEqual([]);
  });
});

describe("fsStorage stamps each companion with its page's exact mtime", () => {
  it("page and companions carry the identical mtime, on a write and on a rewrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "site-mtime-"));
    for (const body of [BIG, BIG + "<p>2</p>"]) {
      await fsStorage(root).write("a/index.html", body);
      const page = (await stat(join(root, "a/index.html"))).mtimeMs;
      for (const ext of [".br", ".gz"]) expect((await stat(join(root, `a/index.html${ext}`))).mtimeMs, ext).toBe(page);
    }
  });
});

describe("backfillCompanions keeps going past a file it cannot replace", () => {
  it("counts the failure, writes the rest, and logs the file", async () => {
    const root = await mkdtemp(join(tmpdir(), "site-backfill-"));
    await mkdir(join(root, "a"), { recursive: true });
    await writeFile(join(root, "a/index.html"), BIG);
    await writeFile(join(root, "b.css"), BIG);
    await writeFile(join(root, "c.js"), BIG);
    const f = flaky("EPERM", Infinity, (p) => p.endsWith("b.css.br"));
    const lines: string[] = [];
    const r = await backfillCompanions(root, (l) => lines.push(l), f.fs);
    expect(r).toMatchObject({ written: 2, failed: 1 });
    expect(lines.some((l) => l.includes("b.css") && l.includes("EPERM"))).toBe(true);
    expect(brotliDecompressSync(await readFile(join(root, "c.js.br"))).toString()).toBe(BIG);
    expect((await readdir(root)).filter((n) => n.includes(".tmp"))).toEqual([]);
  });

  it("a transient EBUSY on a companion's rename is retried, not counted as a failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "site-backfill-"));
    await writeFile(join(root, "b.css"), BIG);
    const f = flaky("EBUSY", 3, (p) => p.endsWith("b.css.gz"));
    expect(await backfillCompanions(root, () => {}, f.fs)).toMatchObject({ written: 1, failed: 0 });
  });

  it("a companion with a newer mtime than its page (a page rolled back) is replaced", async () => {
    const root = await mkdtemp(join(tmpdir(), "site-backfill-"));
    await fsStorage(root).write("p.html", BIG + "v2");
    await writeFile(join(root, "p.html"), BIG + "v1");
    const past = new Date(Date.now() - 86_400_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(join(root, "p.html"), past, past);
    expect(await backfillCompanions(root)).toMatchObject({ written: 1 });
    expect(brotliDecompressSync(await readFile(join(root, "p.html.br"))).toString()).toBe(BIG + "v1");
  });
});
