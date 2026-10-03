import { mkdir, mkdtemp, readFile, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fsStorage } from "./storage";

describe("fsStorage", () => {
  it("writes atomically and removes", async () => {
    const root = await mkdtemp(join(tmpdir(), "site-"));
    const s = fsStorage(root);
    await s.write("releases/K1/index.html", "<p>a</p>");
    expect(await readFile(join(root, "releases/K1/index.html"), "utf8")).toBe("<p>a</p>");
    expect((await readdir(join(root, "releases/K1"))).filter((f) => f.includes(".tmp"))).toEqual([]);
    await s.remove("releases/K1/index.html");
    await s.remove("releases/K1/index.html"); // removing a missing file is fine
  });
  it("refuses paths that escape the root", async () => {
    const s = fsStorage(await mkdtemp(join(tmpdir(), "site-")));
    await expect(s.write("../escape.html", "x")).rejects.toThrow(/outside/);
    await expect(s.write("/etc/passwd", "x")).rejects.toThrow(/outside/);
    await expect(s.remove("releases/../../x")).rejects.toThrow(/outside/);
  });

  // Fix round 1, item 2: a failed writeFile/rename used to leave the .tmp file behind forever.
  it("cleans up the temp file when the rename fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "site-"));
    const s = fsStorage(root);
    // Make the target path itself a directory, so rename(tmp, full) EISDIRs.
    await mkdir(join(root, "releases", "K1", "index.html"), { recursive: true });
    await expect(s.write("releases/K1/index.html", "<p>a</p>")).rejects.toThrow();
    const leftover = (await readdir(join(root, "releases", "K1"))).filter((f) => f.includes(".tmp"));
    expect(leftover).toEqual([]);
  });

  // Fix round 1, item 3: a symlink planted inside root (e.g. releases/K1 -> /etc) makes a
  // syntactically-valid relPath resolve outside root once mkdir/writeFile follow it.
  it("refuses to write through a symlink that escapes the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "site-"));
    const outside = await mkdtemp(join(tmpdir(), "outside-"));
    await symlink(outside, join(root, "escape"));
    const s = fsStorage(root);
    await expect(s.write("escape/index.html", "<p>a</p>")).rejects.toThrow(/outside/);
    expect(await readdir(outside)).toEqual([]);
  });
});
