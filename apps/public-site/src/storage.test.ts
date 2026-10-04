import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
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

  // Fix round 2, item 1: remove() had no realpath protection at all — a symlink planted
  // inside root (e.g. releases -> /outside) let remove() delete a file outside root.
  it("refuses to remove through a symlink that escapes the root, leaving the outside file untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "site-"));
    const outside = await mkdtemp(join(tmpdir(), "outside-"));
    await writeFile(join(outside, "victim.txt"), "do not delete me", "utf8");
    await symlink(outside, join(root, "releases"));
    const s = fsStorage(root);
    await expect(s.remove("releases/victim.txt")).rejects.toThrow(/outside/);
    expect(await readFile(join(outside, "victim.txt"), "utf8")).toBe("do not delete me");
  });

  // Fix round 2, item 2: write()'s pre-mkdir check (round 1) ran *after* mkdir(recursive),
  // which follows a planted symlink and creates directories outside root before the
  // post-mkdir realpath check ever gets a chance to run.
  it("refuses to create directories through a symlink that escapes the root, before anything is created outside", async () => {
    const root = await mkdtemp(join(tmpdir(), "site-"));
    const outside = await mkdtemp(join(tmpdir(), "outside-"));
    await symlink(outside, join(root, "releases"));
    const s = fsStorage(root);
    await expect(s.write("releases/K1/index.html", "<p>a</p>")).rejects.toThrow(/outside/);
    expect(await readdir(outside)).toEqual([]); // no "K1" directory was created outside root
  });

  // Fix round 3 (plan 3d task 4, fix round 1): read()/listDirs() back the site-wide
  // render-state marker and the "which post pages exist on disk" enumeration.
  describe("read", () => {
    it("returns a written file's contents, and null when missing", async () => {
      const root = await mkdtemp(join(tmpdir(), "site-"));
      const s = fsStorage(root);
      expect(await s.read(".site-state.json")).toBeNull();
      await s.write(".site-state.json", '{"granvilleOn":true,"test":false}');
      expect(await s.read(".site-state.json")).toBe('{"granvilleOn":true,"test":false}');
    });

    it("refuses a path that escapes the root", async () => {
      const s = fsStorage(await mkdtemp(join(tmpdir(), "site-")));
      await expect(s.read("../escape.html")).rejects.toThrow(/outside/);
    });
  });

  describe("listDirs", () => {
    it("lists immediate subdirectory names, ignoring files and nested subdirectories", async () => {
      const root = await mkdtemp(join(tmpdir(), "site-"));
      const s = fsStorage(root);
      await s.write("releases/K1/index.html", "<p>a</p>");
      await s.write("releases/K2/index.html", "<p>b</p>");
      await writeFile(join(root, "releases", "not-a-dir.txt"), "x", "utf8");
      expect((await s.listDirs("releases")).sort()).toEqual(["K1", "K2"]);
    });

    it("returns an empty array when the directory doesn't exist", async () => {
      const s = fsStorage(await mkdtemp(join(tmpdir(), "site-")));
      expect(await s.listDirs("releases")).toEqual([]);
    });

    it("refuses to list through a symlink that escapes the root", async () => {
      const root = await mkdtemp(join(tmpdir(), "site-"));
      const outside = await mkdtemp(join(tmpdir(), "outside-"));
      await mkdir(join(outside, "secret"));
      await symlink(outside, join(root, "releases"));
      const s = fsStorage(root);
      await expect(s.listDirs("releases")).rejects.toThrow(/outside/);
    });
  });
});
