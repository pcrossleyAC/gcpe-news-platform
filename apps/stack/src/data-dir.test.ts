import { mkdtemp, readdir, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ensureWritableDir, resolveDataDir } from "./data-dir";

describe("data dir", () => {
  const made: string[] = [];
  afterAll(async () => {
    for (const d of made) await rm(d, { recursive: true, force: true });
  });
  it("defaults to ~/gcpe-data, honours absolute DATA_DIR, resolves relative against home", () => {
    const home = resolve("/home/x");
    expect(resolveDataDir({}, home)).toBe(join(home, "gcpe-data"));
    expect(resolveDataDir({ DATA_DIR: resolve("/srv/data") }, home)).toBe(resolve("/srv/data"));
    expect(resolveDataDir({ DATA_DIR: "data" }, home)).toBe(join(home, "data"));
  });
  // chmod 0o500 doesn't make a directory unwritable on Windows (POSIX permission bits).
  it.skipIf(process.platform === "win32")("creates the folder, leaves no test file behind, and fails clearly when unwritable", async () => {
    const base = await mkdtemp(join(tmpdir(), "gcpe-dd-"));
    made.push(base);
    await ensureWritableDir(join(base, "a", "b"));
    expect(await readdir(join(base, "a", "b"))).toEqual([]);
    const locked = join(base, "locked");
    await ensureWritableDir(locked);
    await chmod(locked, 0o500);
    await expect(ensureWritableDir(locked)).rejects.toThrow(/data directory .*locked is not writable/);
    await chmod(locked, 0o700);
  });
});
