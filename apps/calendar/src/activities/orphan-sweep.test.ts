import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { localStore, randomFileKey, type ObjectStore } from "@gcpe/storage";
import { createCalendarTestDb } from "../../test/helpers";
import { insertRaw } from "../../test/world";
import { activityFiles } from "../db/schema";
import { createOrphanSweeper, ORPHAN_MIN_AGE_MS } from "./orphan-sweep";

const PDF = Buffer.from("%PDF-1.4 sample");
/** A clock a day and a minute ahead: everything stored so far counts as old enough to sweep. */
const later = () => new Date(Date.now() + ORPHAN_MIN_AGE_MS + 60_000);

describe("the orphaned attachment bytes sweeper", () => {
  let tdb: TestDatabase;
  let root: string;
  let store: ObjectStore;

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
  });
  afterAll(() => tdb.drop());
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "calendar-orphans-"));
    store = localStore(root);
    await tdb.db.delete(activityFiles);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  const put = async (activityId: number, name: string) => {
    const key = randomFileKey(`activities/${activityId}`, name);
    await store.put(key, PDF, "application/pdf");
    return key;
  };
  const row = (activityId: number, key: string, fileName = "Sample.pdf") =>
    tdb.db.insert(activityFiles).values({ activityId, fileName, contentType: "application/pdf", length: PDF.length, sha256: "0".repeat(64), storageKey: key });
  const exists = async (key: string) => (await store.get(key)) !== null;
  /** Calls the sweeper enough times to cover every activity in this database several times over. */
  const drain = async (sweep: () => Promise<{ scanned: number; deleted: number; failed: number }>) => {
    const results = [];
    for (let i = 0; i < 40; i++) results.push(await sweep());
    return results;
  };

  it("deletes old bytes no row references, and keeps the ones a row does", async () => {
    const a = await insertRaw(tdb.db, { title: "Sample with files" });
    const kept = await put(a, "Kept.pdf");
    await row(a, kept, "Kept.pdf");
    const orphan = await put(a, "Orphan.pdf");
    const results = await drain(createOrphanSweeper(tdb.db, store, { now: later }));
    expect(results.reduce((n, r) => n + r.deleted, 0)).toBe(1);
    expect(await exists(kept)).toBe(true);
    expect(await exists(orphan)).toBe(false);
  });

  it("never deletes bytes less than a day old: an upload whose row hasn't committed yet keeps them", async () => {
    const a = await insertRaw(tdb.db, { title: "Sample upload in flight" });
    const inFlight = await put(a, "Upload.pdf");
    await drain(createOrphanSweeper(tdb.db, store));
    expect(await exists(inFlight)).toBe(true);
    // The upload's transaction commits; a day later the bytes are still referenced.
    await row(a, inFlight, "Upload.pdf");
    await drain(createOrphanSweeper(tdb.db, store, { now: later }));
    expect(await exists(inFlight)).toBe(true);
  });

  it("keeps bytes that any row references, even a row on another activity", async () => {
    const a = await insertRaw(tdb.db, { title: "Sample folder owner" });
    const b = await insertRaw(tdb.db, { title: "Sample row owner" });
    const key = await put(a, "Shared.pdf");
    await row(b, key, "Shared.pdf");
    await drain(createOrphanSweeper(tdb.db, store, { now: later }));
    expect(await exists(key)).toBe(true);
  });

  it("works in bounded batches and comes back for what one call couldn't finish", async () => {
    const keys: string[] = [];
    for (let i = 0; i < 3; i++) {
      const a = await insertRaw(tdb.db, { title: `Sample batch ${i}` });
      keys.push(await put(a, "One.pdf"), await put(a, "Two.pdf"));
    }
    const results = await drain(createOrphanSweeper(tdb.db, store, { activities: 2, maxDeletes: 1, now: later }));
    for (const r of results) {
      expect(r.scanned).toBeLessThanOrEqual(2);
      expect(r.deleted).toBeLessThanOrEqual(1);
    }
    for (const k of keys) expect(await exists(k)).toBe(false);
  });

  it("counts a delete that fails, doesn't throw, and still deletes the rest", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const a = await insertRaw(tdb.db, { title: "Sample failing delete" });
    const bad = await put(a, "Locked.pdf");
    const good = await put(a, "Free.pdf");
    const failing: ObjectStore = { ...store, delete: async (k) => (k === bad ? Promise.reject(new Error("EACCES")) : store.delete(k)) };
    const results = await drain(createOrphanSweeper(tdb.db, failing, { now: later }));
    expect(results.reduce((n, r) => n + r.failed, 0)).toBeGreaterThanOrEqual(1);
    expect(await exists(good)).toBe(false);
    expect(await exists(bad)).toBe(true);
    // The log line carries the error's safe label only, never the key or the file name.
    for (const call of vi.mocked(console.error).mock.calls) expect(call.join(" ")).not.toContain("Locked");
  });
});
