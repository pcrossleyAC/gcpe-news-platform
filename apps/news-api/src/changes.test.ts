import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNewsTestDb, waitFor, waitUntilBlockedOnLock } from "../test/helpers";
import { pruneChanges, readChanges, recordChanges, type Change } from "./changes";

describe("the change feed (spec §5.4)", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNewsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE changes RESTART IDENTITY");
    await tdb.pool.query("TRUNCATE change_feed_state");
  });
  const record = (rows: Change[]) => tdb.db.transaction((tx) => recordChanges(tx, rows));
  const ids = async () => (await tdb.pool.query<{ id: string }>("SELECT id FROM changes ORDER BY id")).rows.map((r) => Number(r.id));

  it("reads changes after a cursor, in id order, up to the limit, and says where to resume", async () => {
    await record([{ kind: "post.upserted", key: "R-1" }, { kind: "home", key: null }]);
    await record([{ kind: "ministry", key: "health" }]);
    expect(await readChanges(tdb.db, 0, 2)).toMatchObject({
      resync: false,
      next: 2,
      changes: [{ id: 1, kind: "post.upserted", key: "R-1" }, { id: 2, kind: "home", key: null }],
    });
    expect(await readChanges(tdb.db, 2, 2)).toMatchObject({ resync: false, next: 3, changes: [{ id: 3, kind: "ministry", key: "health" }] });
    expect(await readChanges(tdb.db, 3, 2)).toEqual({ resync: false, next: 3, changes: [] });
    expect(await readChanges(tdb.db, 99, 2)).toEqual({ resync: false, next: 99, changes: [] });
  });

  it("records nothing for an empty list, and takes no lock for it", async () => {
    await record([]);
    expect(await ids()).toEqual([]);
  });

  it("a change waits for an earlier uncommitted change, so a reader never sees ids out of order", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = tdb.db.transaction(async (tx) => {
      await recordChanges(tx, [{ kind: "post.upserted", key: "FIRST" }]);
      await gate;
    });
    // The sequence advances outside the transaction: once it has, FIRST holds id 1, uncommitted.
    await waitFor(async () => (await tdb.pool.query<{ is_called: boolean }>("SELECT is_called FROM changes_id_seq")).rows[0]!.is_called);
    const second = tdb.db.transaction((tx) => recordChanges(tx, [{ kind: "post.upserted", key: "SECOND" }]));
    await Promise.race([waitUntilBlockedOnLock(tdb.pool).catch(() => {}), second]);
    // Without the feed's lock, SECOND (id 2) would already be committed and visible here, and a
    // reader that moved its cursor to 2 would never see FIRST.
    const before = await readChanges(tdb.db, 0, 10);
    if (before.resync) throw new Error("unexpected resync");
    expect(before.changes).toEqual([]);
    release();
    await Promise.all([first, second]);
    const after = await readChanges(tdb.db, 0, 10);
    if (after.resync) throw new Error("unexpected resync");
    expect(after.changes.map((c) => [c.id, c.key])).toEqual([[1, "FIRST"], [2, "SECOND"]]);
  });

  it("records 70,000 changes in one call", async () => {
    const rows = Array.from({ length: 70_000 }, (_, i) => ({ kind: "post.unpublished" as const, key: `K-${i}` }));
    await tdb.db.transaction((tx) => recordChanges(tx, rows));
    expect((await tdb.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM changes")).rows[0]!.n).toBe(70_000);
  });

  it("prunes rows older than 90 days, and answers resync with the head for a cursor below what was pruned", async () => {
    await record([{ kind: "home", key: null }]);
    await record([{ kind: "slides", key: null }]);
    await record([{ kind: "tag", key: "fires" }]);
    await tdb.pool.query("UPDATE changes SET at = now() - interval '91 days' WHERE id <= 2");
    expect(await pruneChanges(tdb.db)).toBe(2);
    expect(await ids()).toEqual([3]);
    expect(await readChanges(tdb.db, 0, 10)).toEqual({ resync: true, next: 3 });
    expect(await readChanges(tdb.db, 1, 10)).toEqual({ resync: true, next: 3 });
    expect(await readChanges(tdb.db, 2, 10)).toMatchObject({ resync: false, next: 3, changes: [{ id: 3 }] });
    // A prune that deletes nothing keeps the watermark.
    expect(await pruneChanges(tdb.db)).toBe(0);
    expect(await readChanges(tdb.db, 1, 10)).toEqual({ resync: true, next: 3 });
  });

  it("keeps a row 89 days old, and with every row pruned answers resync with the watermark as next", async () => {
    await record([{ kind: "home", key: null }]);
    await record([{ kind: "home", key: null }]);
    await tdb.pool.query("UPDATE changes SET at = now() - interval '89 days' WHERE id = 2");
    await tdb.pool.query("UPDATE changes SET at = now() - interval '91 days' WHERE id = 1");
    expect(await pruneChanges(tdb.db)).toBe(1);
    await tdb.pool.query("UPDATE changes SET at = now() - interval '91 days'");
    expect(await pruneChanges(tdb.db)).toBe(1);
    expect(await ids()).toEqual([]);
    expect(await readChanges(tdb.db, 0, 10)).toEqual({ resync: true, next: 2 });
    expect(await readChanges(tdb.db, 2, 10)).toEqual({ resync: false, next: 2, changes: [] });
  });
});
