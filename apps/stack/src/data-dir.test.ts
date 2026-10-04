import { mkdtemp, readdir, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ensureWritableDir, resolveDataDir } from "./data-dir";

describe("data dir", () => {
  const made: string[] = [];
  afterAll(async () => {
    for (const d of made) await rm(d, { recursive: true, force: true });
  });
  it("defaults to ~/gcpe-data, honours absolute DATA_DIR, resolves relative against home", () => {
    expect(resolveDataDir({}, "/home/x")).toBe("/home/x/gcpe-data");
    expect(resolveDataDir({ DATA_DIR: "/srv/data" }, "/home/x")).toBe("/srv/data");
    expect(resolveDataDir({ DATA_DIR: "data" }, "/home/x")).toBe("/home/x/data");
  });
  it("creates the folder, leaves no test file behind, and fails clearly when unwritable", async () => {
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
