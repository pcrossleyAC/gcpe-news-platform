import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrCreateKey, preparePrivateDir, runStamp, ScrubArgumentError, writePrivate } from "../../scripts/lib/scrub/private-out";

const root = () => mkdtempSync(join(tmpdir(), "scrub-private-"));

describe("private output", () => {
  it("creates an owner-only folder inside the private root", () => {
    const r = root();
    const dir = preparePrivateDir(join(r, "run", "one"), r);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("refuses a folder outside the private root, or the root itself", () => {
    const r = root();
    expect(() => preparePrivateDir(join(tmpdir(), "elsewhere"), r)).toThrow(ScrubArgumentError);
    expect(() => preparePrivateDir(r, r)).toThrow(ScrubArgumentError);
  });

  it("refuses a folder inside the repository", () => {
    expect(() => preparePrivateDir(resolve(import.meta.dirname, "..", "..", "tmp-out"), resolve(import.meta.dirname, "..", ".."))).toThrow(/outside the repository/);
  });

  it("writes files readable by the owner only", () => {
    const r = root();
    const p = join(preparePrivateDir(join(r, "x"), r), "f.txt");
    writePrivate(p, "fictional");
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("creates the key once and reads the same key back", () => {
    const r = root();
    const p = join(r, "scrub-key");
    const k = loadOrCreateKey(p, r);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(loadOrCreateKey(p, r)).toBe(k);
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("rejects a malformed key file", () => {
    const r = root();
    const p = join(r, "bad-key");
    writeFileSync(p, "not hex");
    expect(() => loadOrCreateKey(p, r)).toThrow(ScrubArgumentError);
    expect(readFileSync(p, "utf8")).toBe("not hex");
  });

  it("refuses a key file outside the private root", () => {
    const r = root();
    expect(() => loadOrCreateKey(join(tmpdir(), "elsewhere-key"), r)).toThrow(ScrubArgumentError);
  });

  it("refuses a key file inside the repository", () => {
    const p = resolve(import.meta.dirname, "..", "..", "repo-key");
    expect(() => loadOrCreateKey(p)).toThrow(ScrubArgumentError);
  });

  it("stamps a run in UTC", () => {
    expect(runStamp(new Date("2026-10-22T23:59:58.123Z"))).toBe("20261022-235958");
  });
});
