import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNrmsTestDb } from "../../test/helpers";
import { activityRecord, envelope, NRMS_EVENT_SECRETS, nextSequence, orgRecord, sendEvent, userRecord } from "../../test/events";
import { createApp } from "../app";
import { calendarActivities, calendarViewers, organizations } from "../db/schema";
import { needsCalendarViewers } from "./projection";

const PLANNER = "8a7f3c1e-2b4d-4e6f-9a0b-1c2d3e4f5a6b";

describe("NRMS's projections of the Calendar's activities and Core's Calendar access (spec addendum §11)", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  const row = async (id: number) => (await tdb.db.select().from(calendarActivities).where(eq(calendarActivities.id, id)))[0];
  /** Sends one event; returns the receiver's outcome ("applied", "stale", "duplicate" or "ignored"). */
  const send = async (source: string, type: string, data: unknown, aggregateId: string, sequence?: number) => {
    const res = await sendEvent(app, envelope(source, type, data, aggregateId, sequence));
    expect(res.status).toBe(200);
    return res.body.outcome as string;
  };
  const activity = (type: string, data: unknown, sequence?: number) => send("calendar", type, data, `activity:${(data as { id: number }).id}`, sequence);

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    app = createApp({ db: tdb.db, auth: { session: { secret: "z".repeat(40) } }, eventSecrets: NRMS_EVENT_SECRETS, workflow: { timeZone: "America/Vancouver" } });
  });
  afterAll(() => tdb.drop());

  it("keeps a non-confidential activity's Forecast fields, with Core keys exactly as sent", async () => {
    expect(await activity("activity.created", activityRecord(4101, { contactMinistryKey: "5F3A9C2E-HEALTH", sharedMinistryKeys: ["finance"], translations: ["French"] }))).toBe("applied");
    expect(await row(4101)).toMatchObject({
      isConfidential: false, isDeleted: false, title: "Sample activity 4101", contactMinistryKey: "5F3A9C2E-HEALTH", sharedMinistryKeys: ["finance"],
      categoryNames: ["Approved Event"], cityName: "Victoria, BC", sectorKeys: ["health"], translations: ["French"], startAt: new Date("2031-06-11T17:00:00.000Z"),
    });
  });

  it("holds a confidential activity as its id only, and wipes the text of one made confidential", async () => {
    await activity("activity.created", { id: 4102, isConfidential: true, isDeleted: false });
    expect(await row(4102)).toMatchObject({ isConfidential: true, isDeleted: false, title: null, details: null, startAt: null, contactMinistryKey: null, sharedMinistryKeys: [], categoryNames: [], translations: [] });
    await activity("activity.updated", { id: 4101, isConfidential: true, isDeleted: false });
    expect(await row(4101)).toMatchObject({ isConfidential: true, title: null, details: null, cityName: null, contactMinistryKey: null, sharedMinistryKeys: [], sectorKeys: [], translations: [] });
  });

  it("the database refuses text on a confidential row, whatever writes it (C127)", async () => {
    await expect(tdb.db.insert(calendarActivities).values({ id: 4199, isConfidential: true, isDeleted: false, title: "leak" })).rejects.toThrow();
  });

  it("a deleted activity stays deleted: activity.deleted, then activity.updated with isDeleted (review, Clear LA Status)", async () => {
    await activity("activity.created", activityRecord(4103));
    await activity("activity.deleted", { id: 4103 });
    expect((await row(4103))!.isDeleted).toBe(true);
    await activity("activity.updated", activityRecord(4103, { isDeleted: true, title: "Reviewed after deletion" }));
    expect(await row(4103)).toMatchObject({ isDeleted: true, title: "Reviewed after deletion" });
  });

  it("an older event arriving late, a duplicate, and a dead letter replayed after a newer one change nothing", async () => {
    const first = nextSequence();
    const second = nextSequence();
    expect(await activity("activity.deleted", { id: 4104 }, second)).toBe("applied");
    expect(await activity("activity.created", activityRecord(4104), first)).toBe("stale");
    expect(await row(4104)).toMatchObject({ isDeleted: true, isConfidential: true, title: null });
    const again = envelope("calendar", "activity.updated", activityRecord(4104, { isDeleted: true }), "activity:4104");
    expect((await sendEvent(app, again)).body.outcome).toBe("applied");
    expect((await sendEvent(app, again)).body.outcome).toBe("duplicate");
  });

  it("activity.deleted for an activity never seen keeps an id-only deleted row, so its id still resolves", async () => {
    await activity("activity.deleted", { id: 4105 });
    expect(await row(4105)).toMatchObject({ isDeleted: true, isConfidential: true, title: null });
  });

  it("activity.* is taken only from the Calendar, user.upserted only from Core", async () => {
    expect(await send("core", "activity.created", activityRecord(4106), "activity:4106")).toBe("ignored");
    expect(await row(4106)).toBeUndefined();
  });

  it("keeps each user's Calendar role, ministries and active state, and no email or name", async () => {
    expect(await send("core", "user.upserted", userRecord(PLANNER.toUpperCase(), { organizationKeys: ["Health", "finance", "Health"] }), `user:${PLANNER}`)).toBe("applied");
    const [v] = await tdb.db.select().from(calendarViewers).where(eq(calendarViewers.userId, PLANNER));
    expect(v).toEqual({ userId: PLANNER, isActive: true, calendarRole: "Calendar.ReadOnly", organizationKeys: ["Health", "finance"] });
    await send("core", "user.upserted", userRecord(PLANNER, { calendarRole: null, isActive: false }), `user:${PLANNER}`);
    expect((await tdb.db.select().from(calendarViewers).where(eq(calendarViewers.userId, PLANNER)))[0]).toMatchObject({ isActive: false, calendarRole: null });
  });

  it("keeps an organization's HQ flag", async () => {
    await send("core", "org.upserted", orgRecord("GCPE-HQ", { isHq: true }), "org:GCPE-HQ");
    expect((await tdb.db.select().from(organizations).where(eq(organizations.key, "gcpe-hq")))[0]).toMatchObject({ isHq: true });
  });

  it("needs Calendar viewers until Core's users arrive", async () => {
    const fresh = await createNrmsTestDb();
    try {
      expect(await needsCalendarViewers(fresh.db)).toBe(true);
      expect(await needsCalendarViewers(tdb.db)).toBe(false);
    } finally {
      await fresh.drop();
    }
  });
});
