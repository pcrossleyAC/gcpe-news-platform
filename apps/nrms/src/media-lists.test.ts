import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { mintSession } from "@gcpe/auth";
import { outboxEvents, type SubscriberConfig } from "@gcpe/events";
import { createNrmsTestDb } from "../test/helpers";
import { createApp } from "./app";
import { mediaLists } from "./db/schema";
import { createMediaList, MediaListConflictError, MediaListNotFoundError, republishMediaLists, updateMediaList } from "./media-lists";

const subscribers: SubscriberConfig[] = [];

describe("media-lists (business logic)", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNrmsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE media_lists, outbox_events, outbox_deliveries, aggregate_sequences CASCADE");
  });

  it("createMediaList inserts the row and emits exactly one media_list.created outbox event with the record", async () => {
    const record = await createMediaList(tdb.db, { key: "campus-press", displayName: "Campus Press" }, subscribers);
    expect(record).toEqual({ key: "campus-press", displayName: "Campus Press", sortOrder: 0, isActive: true });

    const [row] = await tdb.db.select().from(mediaLists).where(eq(mediaLists.key, "campus-press"));
    expect(row).toMatchObject({ key: "campus-press", displayName: "Campus Press", sortOrder: 0, isActive: true });

    const events = await tdb.db.select().from(outboxEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "media_list.created", aggregateId: "media-list:campus-press" });
    expect((events[0]!.envelope as { data: unknown }).data).toEqual(record);
  });

  it("createMediaList honours an explicit sortOrder", async () => {
    const record = await createMediaList(tdb.db, { key: "wire-services", displayName: "Wire Services", sortOrder: 5 }, subscribers);
    expect(record.sortOrder).toBe(5);
  });

  it("a duplicate key throws MediaListConflictError, with no second outbox event", async () => {
    await createMediaList(tdb.db, { key: "campus-press", displayName: "Campus Press" }, subscribers);
    await expect(createMediaList(tdb.db, { key: "campus-press", displayName: "Campus Press Again" }, subscribers)).rejects.toBeInstanceOf(
      MediaListConflictError,
    );
    const events = await tdb.db.select().from(outboxEvents);
    expect(events).toHaveLength(1);
  });

  it("updateMediaList changes displayName and emits media_list.updated with the full record", async () => {
    await createMediaList(tdb.db, { key: "campus-press", displayName: "Campus Press" }, subscribers);
    const updated = await updateMediaList(tdb.db, "campus-press", { displayName: "Campus Press Wire" }, subscribers);
    expect(updated).toEqual({ key: "campus-press", displayName: "Campus Press Wire", sortOrder: 0, isActive: true });

    const events = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.type, "media_list.updated"));
    expect(events).toHaveLength(1);
    expect((events[0]!.envelope as { data: unknown }).data).toEqual(updated);
  });

  it("setting isActive: false emits media_list.deactivated with just the key, not media_list.updated", async () => {
    await createMediaList(tdb.db, { key: "campus-press", displayName: "Campus Press" }, subscribers);
    const updated = await updateMediaList(tdb.db, "campus-press", { isActive: false }, subscribers);
    expect(updated.isActive).toBe(false);

    const events = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, "media-list:campus-press"));
    // One media_list.created (from the setup create) + one media_list.deactivated.
    expect(events.map((e) => e.type).sort()).toEqual(["media_list.created", "media_list.deactivated"]);
    const deactivated = events.find((e) => e.type === "media_list.deactivated")!;
    expect((deactivated.envelope as { data: unknown }).data).toEqual({ key: "campus-press" });
  });

  it("an unknown key throws MediaListNotFoundError", async () => {
    await expect(updateMediaList(tdb.db, "no-such-list", { displayName: "x" }, subscribers)).rejects.toBeInstanceOf(MediaListNotFoundError);
  });

  it("republishMediaLists emits one media_list.updated per row, active or not, and returns the count", async () => {
    await createMediaList(tdb.db, { key: "campus-press", displayName: "Campus Press" }, subscribers);
    await createMediaList(tdb.db, { key: "wire-services", displayName: "Wire Services" }, subscribers);
    await updateMediaList(tdb.db, "wire-services", { isActive: false }, subscribers);

    const count = await republishMediaLists(tdb.db, subscribers);
    expect(count).toBe(2);

    const events = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.type, "media_list.updated"));
    // The one from deactivating wire-services isn't media_list.updated (it's deactivated), so
    // these two are both from the republish call.
    expect(events).toHaveLength(2);
    const keys = events.map((e) => (e.envelope as { data: { key: string } }).data.key).sort();
    expect(keys).toEqual(["campus-press", "wire-services"]);
  });
});

const SECRET = "z".repeat(40) + "-nrms-media-lists-test";

describe("media-lists admin routes (Core.Admin)", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;
  let editorCookie: string;

  const cookieFor = async (roles: string[]) =>
    `gcpe_session=${(await mintSession(SECRET, { id: "00000000-0000-4000-8000-00000000000c", name: "Robin Admin", email: "robin@example.invalid", roles })).token}`;

  beforeAll(async () => {
    tdb = await createNrmsTestDb();
    app = createApp({ db: tdb.db, auth: { session: { secret: SECRET } }, eventSecrets: {}, workflow: { timeZone: "America/Vancouver" } });
    adminCookie = await cookieFor(["Core.Admin"]);
    editorCookie = await cookieFor(["NRMS.Editor"]);
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE media_lists, outbox_events, outbox_deliveries, aggregate_sequences CASCADE");
  });

  it("POST /api/media-lists: 201 with the record for Core.Admin", async () => {
    const res = await request(app).post("/api/media-lists").set("cookie", adminCookie).set("x-gcpe-request", "1").send({ key: "campus-press", displayName: "Campus Press" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ key: "campus-press", displayName: "Campus Press", sortOrder: 0, isActive: true });
  });

  it("POST /api/media-lists: a duplicate key is 409", async () => {
    await request(app).post("/api/media-lists").set("cookie", adminCookie).set("x-gcpe-request", "1").send({ key: "campus-press", displayName: "Campus Press" });
    const res = await request(app).post("/api/media-lists").set("cookie", adminCookie).set("x-gcpe-request", "1").send({ key: "campus-press", displayName: "Again" });
    expect(res.status).toBe(409);
  });

  it("PUT /api/media-lists/:key: 200 with the updated record; unknown key is 404", async () => {
    await request(app).post("/api/media-lists").set("cookie", adminCookie).set("x-gcpe-request", "1").send({ key: "campus-press", displayName: "Campus Press" });
    const res = await request(app).put("/api/media-lists/campus-press").set("cookie", adminCookie).set("x-gcpe-request", "1").send({ displayName: "Campus Press Wire" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ key: "campus-press", displayName: "Campus Press Wire" });

    const notFound = await request(app).put("/api/media-lists/no-such-list").set("cookie", adminCookie).set("x-gcpe-request", "1").send({ displayName: "x" });
    expect(notFound.status).toBe(404);
  });

  it("POST /api/media-lists/republish: 200 with { count }", async () => {
    await request(app).post("/api/media-lists").set("cookie", adminCookie).set("x-gcpe-request", "1").send({ key: "campus-press", displayName: "Campus Press" });
    await request(app).post("/api/media-lists").set("cookie", adminCookie).set("x-gcpe-request", "1").send({ key: "wire-services", displayName: "Wire Services" });
    const res = await request(app).post("/api/media-lists/republish").set("cookie", adminCookie).set("x-gcpe-request", "1").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 2 });
  });

  it("401 without a token/session", async () => {
    expect((await request(app).post("/api/media-lists").send({ key: "x", displayName: "X" })).status).toBe(401);
    expect((await request(app).put("/api/media-lists/campus-press").send({ displayName: "x" })).status).toBe(401);
    expect((await request(app).post("/api/media-lists/republish").send({})).status).toBe(401);
  });

  it("403 without Core.Admin (an NRMS.Editor can't manage media lists)", async () => {
    expect((await request(app).post("/api/media-lists").set("cookie", editorCookie).set("x-gcpe-request", "1").send({ key: "x", displayName: "X" })).status).toBe(403);
    expect((await request(app).put("/api/media-lists/campus-press").set("cookie", editorCookie).set("x-gcpe-request", "1").send({ displayName: "x" })).status).toBe(403);
    expect((await request(app).post("/api/media-lists/republish").set("cookie", editorCookie).set("x-gcpe-request", "1").send({})).status).toBe(403);
  });
});
