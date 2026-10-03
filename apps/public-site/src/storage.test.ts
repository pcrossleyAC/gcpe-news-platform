import { mkdtemp, readFile, readdir } from "node:fs/promises";
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
});
