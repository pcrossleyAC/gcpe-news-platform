import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { dispatchOnce, outboxDeliveries, outboxEvents } from "@gcpe/events";
import { createCalendarTestDb, createTestApp, projectUser, sessionCookie } from "../../test/helpers";
import { call, insertRaw, seedWorld, type World } from "../../test/world";

const SYSADMIN = "00000000-0000-4000-8000-000000000499";
const NRMS = { name: "nrms", url: "http://nrms.invalid/events", secret: "s".repeat(32), types: ["activity.created", "activity.updated", "activity.deleted"] };

describe("the Calendar's undelivered events (spec addendum §5.1)", () => {
  let tdb: TestDatabase;
  let w: World;
  let app: ReturnType<typeof createTestApp>;
  let sysCookie = "";
  const dead = async (status: "dead" | "pending" | "delivered" = "dead", aggregateId = "activity:7", sequence = 1) => {
    const id = randomUUID();
    const envelope = { id, type: "activity.updated", version: 1, source: "calendar", aggregateId, sequence, occurredAt: "2026-09-01T00:00:00Z", correlationId: randomUUID(), data: { id: 7, isConfidential: true, isDeleted: false } };
    await tdb.db.insert(outboxEvents).values({ id, type: envelope.type, aggregateId: envelope.aggregateId, sequence, envelope, createdAt: new Date("2026-09-01T00:00:00Z") });
    await tdb.db.insert(outboxDeliveries).values({ eventId: id, subscriber: "nrms", status, attempts: 9, lastError: "HTTP 503" });
    return id;
  };

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    w = await seedWorld(app, tdb.db);
    // seedWorld has no System Administrator.
    await projectUser(app, { id: SYSADMIN, email: "sys@example.test", displayName: "Sample SysAdmin", isActive: true, calendarRole: "Calendar.SysAdmin", organizationKeys: ["health"] });
    sysCookie = await sessionCookie(SYSADMIN);
  });
  afterAll(() => tdb.drop());

  it("lists dead deliveries only, without their payload", async () => {
    const id = await dead();
    await dead("pending");
    await dead("delivered");
    const res = await call(app, "get", "/api/dead-letters", sysCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [{ eventId: id, subscriber: "nrms", type: "activity.updated", aggregateId: "activity:7", activityReference: null, attempts: 9, lastError: "HTTP 503", createdAt: "2026-09-01T00:00:00.000Z", queuedAtBc: "2026-08-31 17:00" }], truncated: false });
    expect(JSON.stringify(res.body)).not.toContain("isConfidential");
  });

  it("names the activity by its reference, only where the System Administrator can see it", async () => {
    await tdb.db.delete(outboxDeliveries);
    const mine = await insertRaw(tdb.db, { contactMinistryKey: "health", title: "Sample seen" });
    const hidden = await insertRaw(tdb.db, { commContactId: w.contact.financeEditor, contactMinistryKey: "finance", isConfidential: true, title: "Sample unseen" });
    const seen = await dead("dead", `activity:${mine}`);
    const unseen = await dead("dead", `activity:${hidden}`);
    const items = (await call(app, "get", "/api/dead-letters", sysCookie)).body.items as { eventId: string; activityReference: string | null }[];
    expect(items.find((i) => i.eventId === seen)!.activityReference).toBe(`HLTH-${mine}`);
    // A Health System Administrator can't see a confidential Finance activity: not even its ministry.
    expect(items.find((i) => i.eventId === unseen)!.activityReference).toBeNull();
    expect(JSON.stringify(items)).not.toContain("FIN");
  });

  it("is System Administrator only", async () => {
    expect((await call(app, "get", "/api/dead-letters", w.as.hqAdmin.cookie)).status).toBe(403);
    expect((await call(app, "post", "/api/dead-letters/retry", w.as.admin.cookie, { eventId: randomUUID(), subscriber: "nrms" })).status).toBe(403);
  });

  it("a retry puts the delivery back in the queue, and the next dispatch delivers it", async () => {
    const id = await dead();
    expect((await call(app, "post", "/api/dead-letters/retry", sysCookie, { eventId: id, subscriber: "nrms" })).status).toBe(204);
    const [d] = await tdb.db.select().from(outboxDeliveries).where(and(eq(outboxDeliveries.eventId, id), eq(outboxDeliveries.subscriber, "nrms")));
    expect(d).toMatchObject({ status: "pending", attempts: 0, lastError: null, lockedUntil: null });
    const result = await dispatchOnce({ db: tdb.db, subscribers: [NRMS], fetchImpl: async () => new Response(null, { status: 200 }) });
    expect(result.delivered).toBeGreaterThanOrEqual(1);
  });

  it("a retry that fails again is dead again at once: the event is past the dispatcher's 24 hours", async () => {
    const id = await dead();
    await call(app, "post", "/api/dead-letters/retry", sysCookie, { eventId: id, subscriber: "nrms" });
    await dispatchOnce({ db: tdb.db, subscribers: [NRMS], fetchImpl: async () => new Response(null, { status: 503 }) });
    const list = (await call(app, "get", "/api/dead-letters", sysCookie)).body.items as { eventId: string; attempts: number }[];
    expect(list.find((l) => l.eventId === id)).toMatchObject({ attempts: 1 });
  });

  it("a retry of a delivery that isn't dead is 404; a malformed body is 400", async () => {
    const pending = await dead("pending");
    expect((await call(app, "post", "/api/dead-letters/retry", sysCookie, { eventId: pending, subscriber: "nrms" })).status).toBe(404);
    expect((await call(app, "post", "/api/dead-letters/retry", sysCookie, { eventId: "nope", subscriber: "nrms" })).status).toBe(400);
  });

  // Suite review fix round 1, I1: a newer change to the same activity, to the same app, replaced it.
  it("a retry of a delivery a newer one for the same activity replaced is 409, with a plain reason", async () => {
    const older = await dead("dead", "activity:88", 1);
    await dead("dead", "activity:88", 2);
    const res = await call(app, "post", "/api/dead-letters/retry", sysCookie, { eventId: older, subscriber: "nrms" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "A newer update replaced this one, so it isn't sent again." });
  });

  it("lists the 200 most recent and says when there are more", async () => {
    await tdb.db.delete(outboxDeliveries);
    const ids: string[] = [];
    for (let n = 0; n < 200; n++) ids.push(await dead());
    const full = await call(app, "get", "/api/dead-letters", sysCookie);
    expect(full.body.items).toHaveLength(200);
    expect(full.body.truncated).toBe(false);
    ids.push(await dead());
    const over = await call(app, "get", "/api/dead-letters", sysCookie);
    expect(over.body.items).toHaveLength(200);
    expect(over.body.truncated).toBe(true);
  });
});
