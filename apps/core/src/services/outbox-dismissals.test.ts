import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { TestDatabase } from "@gcpe/db-kit";
import type { UndeliveredUpdate } from "@gcpe/events";
import { createCoreTestDb } from "../../test/helpers";
import { recentDismissals, recordDismissals } from "./outbox-dismissals";

const update = (over: Partial<UndeliveredUpdate> = {}): UndeliveredUpdate => ({
  eventId: randomUUID(),
  subscriber: "nod",
  type: "release.published",
  aggregateId: "release:1",
  about: "A headline",
  attempts: 9,
  lastError: "HTTP 503",
  createdAt: "2026-10-30T17:00:00.000Z",
  replaced: false,
  overtaken: false,
  ...over,
});

// Suite review fix round 1, M1: who dismissed which undelivered update, and when.
describe("outbox dismissals", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCoreTestDb();
  });
  afterAll(async () => tdb.drop());

  it("records who dismissed each one and lists them newest first", async () => {
    const a = update();
    const b = update({ type: "org.deactivated", about: "health", replaced: true });
    await recordDismissals(tdb.db, "nrms", [a], { id: "u1", name: "Pat Admin" });
    await recordDismissals(tdb.db, "core", [b], { id: "u2", name: "Sam Admin" });
    // Recording the same one again changes nothing.
    await recordDismissals(tdb.db, "nrms", [a], { id: "u2", name: "Sam Admin" });
    const list = await recentDismissals(tdb.db, 10);
    expect(list.map((d) => [d.app, d.eventId, d.dismissedBy])).toEqual([
      ["core", b.eventId, "Sam Admin"],
      ["nrms", a.eventId, "Pat Admin"],
    ]);
    expect(list[0]).toMatchObject({ subscriber: "nod", type: "org.deactivated", about: "health", lastError: "HTTP 503", createdAt: b.createdAt, replaced: true });
    expect(new Date(list[0]!.dismissedAt).toString()).not.toBe("Invalid Date");
    expect(await recentDismissals(tdb.db, 1)).toHaveLength(1);
  });

  it("records nothing for an empty list", async () => {
    await expect(recordDismissals(tdb.db, "nrms", [], { id: "u1", name: "Pat" })).resolves.toBeUndefined();
  });
});
