import * as fs from "node:fs/promises";
import { mkdir, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLegacySiteFixture } from "./fixture";
import { exactPagePath, LISTING_MIN_REREAD_MS, LISTING_SETTLE_MS, resolvePostKey } from "./site-files";

// Count readdir calls without changing what they return.
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return { ...real, readdir: vi.fn(real.readdir) };
});
const readdirCalls = (dir: string) => vi.mocked(fs.readdir).mock.calls.filter(([p]) => p === dir).length;

describe("resolvePostKey", () => {
  let outputDir: string;
  let now: number;
  beforeEach(async () => {
    outputDir = await createLegacySiteFixture();
    now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.mocked(fs.readdir).mockClear();
  });
  afterEach(async () => {
    vi.mocked(Date.now).mockRestore();
    await rm(outputDir, { recursive: true, force: true });
  });

  /** Moves the cache's clock past the re-read interval. */
  const pastInterval = () => (now += LISTING_MIN_REREAD_MS + 1);

  it("returns the on-disk name whatever the case asked, or null", async () => {
    expect(await resolvePostKey(outputDir, "2026tt0105-001130")).toBe("2026TT0105-001130");
    expect(await resolvePostKey(outputDir, "2026TT0105-001130")).toBe("2026TT0105-001130");
    expect(await resolvePostKey(outputDir, "NOPE-1")).toBeNull();
  });

  it("resolvePostKey ignores names that fail POST_KEY (e.g. '_long', '.x')", async () => {
    for (const name of ["_long", ".x", "a.b"]) await mkdir(join(outputDir, "releases", name), { recursive: true });
    for (const key of ["_long", ".x", "a.b", "..", ""]) expect(await resolvePostKey(outputDir, key)).toBeNull();
    expect(await resolvePostKey(outputDir, "2026TT0105-001130")).toBe("2026TT0105-001130");
  });

  it("is null when releases/ is missing, and picks up a releases/ created later", async () => {
    await rm(join(outputDir, "releases"), { recursive: true, force: true });
    expect(await resolvePostKey(outputDir, "2026TT0105-001130")).toBeNull();
    await mkdir(join(outputDir, "releases", "K-1"), { recursive: true });
    expect(await resolvePostKey(outputDir, "k-1")).toBe("K-1");
  });

  it("a repeated lookup within the interval does not re-readdir; a new entry is picked up after it", async () => {
    const releases = join(outputDir, "releases");
    expect(await resolvePostKey(outputDir, "NEW-1")).toBeNull();
    expect(readdirCalls(releases)).toBe(1);
    await mkdir(join(releases, "NEW-1"));
    const later = new Date(now + 60_000);
    await utimes(releases, later, later);
    // Within the interval: the cached listing answers, even though releases/ changed.
    for (let i = 0; i < 5; i++) expect(await resolvePostKey(outputDir, "new-1")).toBeNull();
    expect(readdirCalls(releases)).toBe(1);
    pastInterval();
    expect(await resolvePostKey(outputDir, "new-1")).toBe("NEW-1");
    expect(readdirCalls(releases)).toBe(2);
  });

  it("concurrent lookups share one readdir", async () => {
    const releases = join(outputDir, "releases");
    await Promise.all(Array.from({ length: 10 }, () => resolvePostKey(outputDir, "2026tt0105-001130")));
    expect(readdirCalls(releases)).toBe(1);
  });

  it("exactPagePath and resolvePostKey share releases/'s one listing", async () => {
    const releases = join(outputDir, "releases");
    expect(await exactPagePath(outputDir, "/releases/2026TT0105-001130/")).toBe("/releases/2026TT0105-001130/");
    expect(await resolvePostKey(outputDir, "2026tt0105-001130")).toBe("2026TT0105-001130");
    expect(await exactPagePath(outputDir, "/releases/2026tt0105-001130/")).toBeNull();
    expect(readdirCalls(releases)).toBe(1);
  });

  it("after the interval: a settled, unchanged listing is not re-read; an unsettled one is", async () => {
    const releases = join(outputDir, "releases");
    // Settled: mtime well before the read.
    const old = new Date(now - 10 * LISTING_SETTLE_MS);
    await utimes(releases, old, old);
    await resolvePostKey(outputDir, "x-1");
    pastInterval();
    await resolvePostKey(outputDir, "x-1");
    expect(readdirCalls(releases)).toBe(1);

    // Unsettled: mtime within LISTING_SETTLE_MS of the read → re-read at the next check even
    // though the mtime is unchanged (an entry added in the same coarse tick).
    pastInterval();
    const recent = new Date(now - LISTING_SETTLE_MS / 2);
    await utimes(releases, recent, recent);
    await resolvePostKey(outputDir, "x-1"); // mtime changed: read #2, unsettled
    expect(readdirCalls(releases)).toBe(2);
    await mkdir(join(releases, "X-1"));
    await utimes(releases, recent, recent); // same mtime as read #2
    pastInterval();
    expect(await resolvePostKey(outputDir, "x-1")).toBe("X-1"); // read #3 despite equal mtime
    expect(readdirCalls(releases)).toBe(3);
  });
});
