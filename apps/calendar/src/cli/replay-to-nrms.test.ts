import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { outboxDeliveries, outboxEvents, type SubscriberConfig } from "@gcpe/events";
import { createCalendarTestDb, TEST_RULES } from "../../test/helpers";
import { insertRaw } from "../../test/world";
import { replayToNrms } from "./replay-to-nrms";

const subscribers: SubscriberConfig[] = [{ name: "nrms", url: "http://nrms.invalid/events", secret: "s".repeat(40), types: ["activity.created", "activity.updated", "activity.deleted"] }];

describe("npm run calendar:replay-to-nrms (spec addendum §11, §12.1)", () => {
  let tdb: TestDatabase;
  let live: number;
  let secret: number;
  let gone: number;
  const events = () => tdb.db.select().from(outboxEvents).orderBy(asc(outboxEvents.aggregateId));

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    live = await insertRaw(tdb.db, { title: "Sample live" });
    secret = await insertRaw(tdb.db, { title: "Sample confidential", isConfidential: true });
    gone = await insertRaw(tdb.db, { title: "Sample deleted", deletedAt: new Date("2026-10-01T00:00:00Z") });
  });
  afterAll(() => tdb.drop());

  it("a dry run counts, names the matching subscriber, and sends nothing", async () => {
    expect(await replayToNrms(tdb.db, { confirm: false, rules: TEST_RULES, subscribers })).toEqual({
      confirmed: false, count: 3, subscriberNames: ["nrms"], refused: false, failures: [],
    });
    expect(await events()).toEqual([]);
  });

  it("refuses --confirm when no configured subscriber accepts activity.updated, and enqueues nothing", async () => {
    const noMatch: SubscriberConfig[] = [{ name: "nrms", url: "http://nrms.invalid/events", secret: "s".repeat(40), types: ["activity.deleted"] }];
    expect(await replayToNrms(tdb.db, { confirm: true, rules: TEST_RULES, subscribers: noMatch })).toEqual({
      confirmed: true, count: 3, subscriberNames: [], refused: true, failures: [],
    });
    expect(await events()).toEqual([]);
  });

  it("confirmed, sends each activity's current state as activity.updated to NRMS: confidential as its id only, deleted as deleted", async () => {
    expect(await replayToNrms(tdb.db, { confirm: true, rules: TEST_RULES, subscribers })).toEqual({
      confirmed: true, count: 3, subscriberNames: ["nrms"], refused: false, failures: [],
    });
    const sent = (await events()).map((e) => ({ type: e.type, aggregateId: e.aggregateId, data: (e.envelope as { data: Record<string, unknown> }).data }));
    expect(sent).toHaveLength(3);
    expect(sent.every((e) => e.type === "activity.updated")).toBe(true);
    expect(sent.find((e) => e.aggregateId === `activity:${live}`)!.data).toMatchObject({ id: live, isConfidential: false, isDeleted: false, title: "Sample live" });
    expect(sent.find((e) => e.aggregateId === `activity:${secret}`)!.data).toEqual({ id: secret, isConfidential: true, isDeleted: false });
    expect(sent.find((e) => e.aggregateId === `activity:${gone}`)!.data).toMatchObject({ id: gone, isDeleted: true });
    const [first] = await events();
    expect((await tdb.db.select().from(outboxDeliveries).where(eq(outboxDeliveries.eventId, first!.id))).map((d) => d.subscriber)).toEqual(["nrms"]);
  });
});
