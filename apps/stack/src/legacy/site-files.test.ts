import { mkdir, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLegacySiteFixture } from "./fixture";
import { resolvePostKey } from "./site-files";

describe("resolvePostKey", () => {
  let outputDir: string;
  beforeEach(async () => {
    outputDir = await createLegacySiteFixture();
  });
  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  it("returns the on-disk name whatever the case asked, or null", async () => {
    expect(await resolvePostKey(outputDir, "2026tt0105-001130")).toBe("2026TT0105-001130");
    expect(await resolvePostKey(outputDir, "2026TT0105-001130")).toBe("2026TT0105-001130");
    expect(await resolvePostKey(outputDir, "NOPE-1")).toBeNull();
  });

  it("resolvePostKey ignores names that fail POST_KEY (e.g. '_long', '.x')", async () => {
    for (const name of ["_long", ".x", "a.b"]) await mkdir(join(outputDir, "releases", name), { recursive: true });
    const later = new Date(Date.now() + 60_000);
    await utimes(join(outputDir, "releases"), later, later);
    for (const key of ["_long", ".x", "a.b", "..", ""]) expect(await resolvePostKey(outputDir, key)).toBeNull();
    expect(await resolvePostKey(outputDir, "2026TT0105-001130")).toBe("2026TT0105-001130");
  });

  it("is null when releases/ is missing, and picks up a releases/ created later", async () => {
    await rm(join(outputDir, "releases"), { recursive: true, force: true });
    expect(await resolvePostKey(outputDir, "2026TT0105-001130")).toBeNull();
    await mkdir(join(outputDir, "releases", "K-1"), { recursive: true });
    expect(await resolvePostKey(outputDir, "k-1")).toBe("K-1");
  });
});
