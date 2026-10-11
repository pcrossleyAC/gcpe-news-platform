import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { sampleRelease } from "@gcpe/events/testing";
import { createNewsTestDb } from "../../test/helpers";
import { posts } from "../db/schema";
import { applyRelease } from "../projections";
import { searchTextFor } from "../search/search-text";
import { parseBackfillArgs, printBackfillResult, searchBackfill } from "./search-backfill";

// Mixed case: under COLLATE "C" upper case sorts first, so keyset paging must not skip any.
const KEYS = ["a-1", "B-2", "c-3", "D-4", "e-5"];
const releaseFor = (key: string) => ({ ...sampleRelease, key, reference: null, location: `Town ${key}` });

describe("searchBackfill", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNewsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE posts");
    for (const key of KEYS) await tdb.db.transaction((tx) => applyRelease(tx, releaseFor(key), { notify: false }));
    // As the rows stand straight after the migration: no search text yet.
    await tdb.pool.query("UPDATE posts SET search_text = NULL");
  });

  const textOf = async (key: string) => (await tdb.db.select({ t: posts.searchText }).from(posts).where(eq(posts.key, key)))[0]?.t;

  it("returns a failure instead of throwing when counting the rows fails", async () => {
    const failing = Object.create(tdb.db) as typeof tdb.db;
    failing.select = (() => {
      throw Object.assign(new Error('column "search_text" does not exist'), { code: "42703" });
    }) as typeof tdb.db.select;
    const r = await searchBackfill(failing, { confirm: true, all: false });
    expect(r).toMatchObject({ confirmed: true, missingColumn: false, filled: 0 });
    expect(r.failure).toEqual(expect.any(String));
    expect(r.failure).not.toContain("search_text");
  });

  it("dry run counts and writes nothing", async () => {
    const r = await searchBackfill(tdb.db, { confirm: false, all: false });
    expect(r).toMatchObject({ confirmed: false, missingColumn: false, total: 5, pending: 5, filled: 0, failure: null });
    expect(await textOf("a-1")).toBeNull();
  });

  it("--confirm fills every NULL row in batches, and search_vector follows", async () => {
    const r = await searchBackfill(tdb.db, { confirm: true, all: false, batchSize: 2 });
    expect(r).toMatchObject({ confirmed: true, pending: 5, filled: 5, failure: null });
    for (const key of KEYS) expect(await textOf(key)).toBe(searchTextFor(releaseFor(key)));
    const hits = await tdb.pool.query("SELECT key FROM posts WHERE search_vector @@ websearch_to_tsquery('english', 'town')");
    expect(hits.rows).toHaveLength(5);
  });

  it("is safe to re-run: the second run finds nothing to do", async () => {
    await searchBackfill(tdb.db, { confirm: true, all: false });
    const again = await searchBackfill(tdb.db, { confirm: true, all: false });
    expect(again).toMatchObject({ pending: 0, filled: 0, failure: null });
  });

  it("default mode leaves rows that already have search text alone; --all recomputes them", async () => {
    await tdb.pool.query("UPDATE posts SET search_text = 'written by a newer release event' WHERE key = 'c-3'");
    const r = await searchBackfill(tdb.db, { confirm: true, all: false, batchSize: 2 });
    expect(r.filled).toBe(4);
    expect(await textOf("c-3")).toBe("written by a newer release event");

    const all = await searchBackfill(tdb.db, { confirm: true, all: true, batchSize: 2 });
    expect(all).toMatchObject({ all: true, pending: 5, filled: 5 });
    expect(await textOf("c-3")).toBe(searchTextFor(releaseFor("c-3")));
  });

  it("reports a missing column instead of failing on it", async () => {
    const other = await createNewsTestDb();
    try {
      await other.pool.query("ALTER TABLE posts DROP COLUMN search_vector, DROP COLUMN search_text");
      expect(await searchBackfill(other.db, { confirm: true, all: false })).toMatchObject({ missingColumn: true, filled: 0 });
    } finally {
      await other.drop();
    }
  });
});

describe("parseBackfillArgs and printBackfillResult", () => {
  it("accepts --confirm and --all and refuses anything else", () => {
    expect(parseBackfillArgs([])).toEqual({ confirm: false, all: false });
    expect(parseBackfillArgs(["--all", "--confirm"])).toEqual({ confirm: true, all: true });
    expect(() => parseBackfillArgs(["--confrim"])).toThrow(/Unknown argument: --confrim/);
  });

  it("prints what a dry run would do, what a run did, and how to recover", () => {
    const base = { all: false, missingColumn: false, total: 10, pending: 4, filled: 0, failure: null };
    const lines: string[] = [];
    printBackfillResult({ ...base, confirmed: false }, (s) => lines.push(s));
    printBackfillResult({ ...base, confirmed: true, filled: 4 }, (s) => lines.push(s));
    printBackfillResult({ ...base, confirmed: true, filled: 2, failure: "57014" }, (s) => lines.push(s));
    printBackfillResult({ ...base, confirmed: true, missingColumn: true }, (s) => lines.push(s));
    expect(lines).toEqual([
      "Would fill search text for 4 of 10 post(s).",
      "Dry run: nothing written. Re-run with --confirm to write.",
      "Filled search text for 4 of 4 post(s).",
      "Filled search text for 2 of 4 post(s).",
      "Stopped: 57014. Re-run to continue.",
      "posts.search_text doesn't exist yet: start the News API once (it runs migrations), then re-run.",
    ]);
  });
});
