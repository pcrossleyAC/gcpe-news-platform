import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb, createTestApp, envelope, sendEvent } from "../test/helpers";
import { mediaOptOuts, subscriberHistory, subscriptions } from "./db/schema";
import { activeListKeys, moveMinistrySubscribers, needsReferenceData, publicListItems } from "./lists";
import { addSubscriber } from "./subscribers";

describe("lists from Core events", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createTestApp>;
  beforeAll(async () => { tdb = await createNodTestDb(); app = createTestApp(tdb.db); });
  afterAll(async () => tdb.drop());
  beforeEach(async () => { await tdb.db.execute(sql`DELETE FROM lists WHERE category <> 'emergency'`); });

  // orgRecordSchema (packages/events/src/catalogue.ts) requires every field below — a partial
  // payload fails parseEvent's validation (400), never reaching listsHandler at all.
  const org = (key: string, displayName: string, isActive = true) =>
    envelope(
      "core",
      "org.upserted",
      {
        key,
        displayName,
        abbreviation: "X",
        sortOrder: 2,
        isActive,
        parentKey: null,
        url: null,
        displayAdditionalName: null,
        minister: { name: null, summary: null, detailsHtml: null, email: null, photoUrl: null, address: null },
        contact: null,
        secondContact: null,
        weekendContactNumber: null,
        social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null },
        topicLinks: [],
        serviceLinks: [],
        sectorKeys: [],
        updatedAt: new Date().toISOString(),
      },
      `org:${key}`,
    );

  it("creates and renames a ministry list, lowercasing the key", async () => {
    expect((await sendEvent(app, org("Health", "Ministry of Health"))).status).toBe(200);
    expect((await sendEvent(app, org("Health", "Health"))).status).toBe(200);
    expect(await publicListItems(tdb.db, "ministries")).toEqual([{ key: "health", value: "Health" }]);
  });

  it("deactivating hides the list from the public items but keeps the row", async () => {
    await sendEvent(app, org("agri", "Agriculture"));
    await sendEvent(app, envelope("core", "org.deactivated", { key: "agri" }, "org:agri"));
    expect(await publicListItems(tdb.db, "ministries")).toEqual([]);
    expect(await activeListKeys(tdb.db, ["ministries:agri"])).toEqual([]);
  });

  it("maps sector/theme/tag terms to their categories", async () => {
    // termRecordSchema requires social + updatedAt too (see the org() helper's note above).
    const term = {
      kind: "sector",
      key: "Mining",
      displayName: "Mining",
      sortOrder: 1,
      isActive: true,
      social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null },
      updatedAt: new Date().toISOString(),
    };
    await sendEvent(app, envelope("core", "sector.upserted", term, "sector:mining"));
    expect(await publicListItems(tdb.db, "sectors")).toEqual([{ key: "mining", value: "Mining" }]);
  });

  it("never exposes media lists or unknown categories publicly", async () => {
    await tdb.db.execute(sql`INSERT INTO lists (list_key, category, key, name) VALUES ('media-distribution-lists:budget', 'media-distribution-lists', 'budget', 'Budget')`);
    expect(await publicListItems(tdb.db, "media-distribution-lists")).toEqual([]);
    expect(await publicListItems(tdb.db, "nope")).toEqual([]);
    expect(await activeListKeys(tdb.db, ["media-distribution-lists:budget", "*"])).toEqual(["*"]);
  });

  it("needsReferenceData is true until a ministry list exists", async () => {
    expect(await needsReferenceData(tdb.db)).toBe(true);
    await sendEvent(app, org("health", "Health"));
    expect(await needsReferenceData(tdb.db)).toBe(false);
  });

  const mediaList = (key: string, displayName: string, isActive = true, sortOrder = 1) =>
    envelope("nrms", "media_list.created", { key, displayName, sortOrder, isActive }, `media_list:${key}`);

  it("media_list.created creates an active media-distribution-lists entry", async () => {
    expect((await sendEvent(app, mediaList("budget", "Budget"))).status).toBe(200);
    const r = await tdb.db.execute<{ list_key: string; active: boolean }>(sql`SELECT list_key, active FROM lists WHERE list_key = 'media-distribution-lists:budget'`);
    expect(r.rows[0]).toMatchObject({ list_key: "media-distribution-lists:budget", active: true });
  });

  it("deactivate then media_list.updated with isActive true re-activates (4a carry-forward)", async () => {
    await sendEvent(app, mediaList("transport", "Transport"));
    await sendEvent(app, envelope("nrms", "media_list.deactivated", { key: "transport" }, "media_list:transport"));
    const afterDeactivate = await tdb.db.execute<{ active: boolean }>(sql`SELECT active FROM lists WHERE list_key = 'media-distribution-lists:transport'`);
    expect(afterDeactivate.rows[0]!.active).toBe(false);

    const updated = envelope("nrms", "media_list.updated", { key: "transport", displayName: "Transport", sortOrder: 1, isActive: true }, "media_list:transport");
    expect((await sendEvent(app, updated)).status).toBe(200);
    const afterReactivate = await tdb.db.execute<{ active: boolean }>(sql`SELECT active FROM lists WHERE list_key = 'media-distribution-lists:transport'`);
    expect(afterReactivate.rows[0]!.active).toBe(true);
  });

  it("a non-public organization's list is inactive: not offered, not subscribable (Q54)", async () => {
    const hidden = org("gcpe-headquarters", "GCPE Headquarters");
    const premier = org("office-of-the-premier", "Office of the Premier");
    expect((await sendEvent(app, { ...hidden, data: { ...(hidden.data as object), isHq: true, isPublic: false } })).status).toBe(200);
    expect((await sendEvent(app, { ...premier, data: { ...(premier.data as object), isHq: true, isPublic: true } })).status).toBe(200);
    const offered = (await publicListItems(tdb.db, "ministries")).map((i) => i.key);
    expect(offered).toContain("office-of-the-premier");
    expect(offered).not.toContain("gcpe-headquarters");
    expect(await activeListKeys(tdb.db, ["ministries:gcpe-headquarters"])).toEqual([]);
  });

  it("no subscriber's membership or opt-out changes when the org goes non-public, then public again (Q54)", async () => {
    const sendOrgPublic = (key: string, displayName: string, isPublic: boolean) => {
      const e = org(key, displayName);
      return sendEvent(app, { ...e, data: { ...(e.data as object), isPublic } });
    };
    expect((await sendOrgPublic("finance", "Finance", true)).status).toBe(200);
    const { id: subscriberId } = await addSubscriber(tdb.db, { email: "kept@example.test", lists: ["ministries:finance"] });
    const membershipBefore = await tdb.db.select().from(subscriptions).where(eq(subscriptions.subscriberId, subscriberId));
    const optOutsBefore = await tdb.db.select().from(mediaOptOuts);

    expect((await sendOrgPublic("finance", "Finance", false)).status).toBe(200);
    expect(await tdb.db.select().from(subscriptions).where(eq(subscriptions.subscriberId, subscriberId))).toEqual(membershipBefore);
    expect(await tdb.db.select().from(mediaOptOuts)).toEqual(optOutsBefore);

    expect((await sendOrgPublic("finance", "Finance", true)).status).toBe(200);
    expect(await tdb.db.select().from(subscriptions).where(eq(subscriptions.subscriberId, subscriberId))).toEqual(membershipBefore);
    expect(await tdb.db.select().from(mediaOptOuts)).toEqual(optOutsBefore);
  });
  describe("org.succeeded", () => {
    const succeeded = (key: string, successorKeys: string[], moveSubscribers = true) =>
      envelope("core", "org.succeeded", { key, successorKeys, moveSubscribers, moveCalendar: false, moveDrafts: false, takeAbbreviation: false, at: "2028-11-20T17:00:00.000Z" }, `org-succeeded:${key}`);
    const keysOf = async (id: string) =>
      (await tdb.db.select().from(subscriptions).where(eq(subscriptions.subscriberId, id))).map((r) => r.listKey).sort();
    const historyOf = (id: string) => tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, id));

    it("moves subscribers and writes one history line each", async () => {
      const a = await addSubscriber(tdb.db, { email: "mv-a@example.test", lists: ["ministries:old1", "sectors:x"] });
      const b = await addSubscriber(tdb.db, { email: "mv-b@example.test", lists: ["ministries:old1"] });
      expect((await sendEvent(app, succeeded("old1", ["new1"]))).status).toBe(200);
      expect(await keysOf(a.id)).toEqual(["ministries:new1", "sectors:x"]);
      expect(await keysOf(b.id)).toEqual(["ministries:new1"]);
      const h = (await historyOf(a.id)).filter((r) => r.action === "list-moved");
      expect(h).toHaveLength(1);
      expect(h[0]).toMatchObject({ detail: "ministries:old1 → ministries:new1", actor: "system: ministry succession" });
      expect((await historyOf(b.id)).filter((r) => r.action === "list-moved")).toHaveLength(1);
    });

    it("a subscriber already on B ends with exactly one B row", async () => {
      const a = await addSubscriber(tdb.db, { email: "both@example.test", lists: ["ministries:old2", "ministries:new2"] });
      await sendEvent(app, succeeded("old2", ["new2"]));
      expect(await keysOf(a.id)).toEqual(["ministries:new2"]);
    });

    it("a split adds every successor", async () => {
      const a = await addSubscriber(tdb.db, { email: "split@example.test", lists: ["ministries:old3"] });
      await sendEvent(app, succeeded("old3", ["new3a", "new3b"]));
      expect(await keysOf(a.id)).toEqual(["ministries:new3a", "ministries:new3b"]);
      expect((await historyOf(a.id)).filter((r) => r.action === "list-moved")).toHaveLength(1);
    });

    it("a second delivery (the same event, or a redelivery under a new id) moves nothing and adds no history", async () => {
      const a = await addSubscriber(tdb.db, { email: "twice@example.test", lists: ["ministries:old4"] });
      const e = succeeded("old4", ["new4"]);
      expect((await sendEvent(app, e)).status).toBe(200);
      expect(await keysOf(a.id)).toEqual(["ministries:new4"]);
      expect((await sendEvent(app, e)).status).toBe(200);
      expect((await sendEvent(app, succeeded("old4", ["new4"]))).status).toBe(200);
      expect(await keysOf(a.id)).toEqual(["ministries:new4"]);
      expect((await historyOf(a.id)).filter((r) => r.action === "list-moved")).toHaveLength(1);
      // The helper itself reports the no-op.
      await tdb.db.transaction(async (tx) => { expect(await moveMinistrySubscribers(tx, "old4", ["new4"], "t")).toBe(0); });
    });

    it("moveSubscribers false is a no-op; the same hand-over with it on then moves", async () => {
      const a = await addSubscriber(tdb.db, { email: "stay@example.test", lists: ["ministries:old5"] });
      expect((await sendEvent(app, succeeded("old5", ["new5"], false))).status).toBe(200);
      expect(await keysOf(a.id)).toEqual(["ministries:old5"]);
      expect((await historyOf(a.id)).filter((r) => r.action === "list-moved")).toHaveLength(0);
      expect((await sendEvent(app, succeeded("old5", ["new5"]))).status).toBe(200);
      expect(await keysOf(a.id)).toEqual(["ministries:new5"]);
    });

    it("a successor equal to the ministry itself is ignored", async () => {
      const a = await addSubscriber(tdb.db, { email: "self@example.test", lists: ["ministries:old6"] });
      await sendEvent(app, succeeded("old6", ["old6"]));
      expect(await keysOf(a.id)).toEqual(["ministries:old6"]);
      expect((await historyOf(a.id)).filter((r) => r.action === "list-moved")).toHaveLength(0);
      await sendEvent(app, succeeded("old6", ["old6", "new6"]));
      expect(await keysOf(a.id)).toEqual(["ministries:new6"]);
      expect((await historyOf(a.id)).filter((r) => r.action === "list-moved").map((r) => r.detail)).toEqual(["ministries:old6 → ministries:new6"]);
    });

    it("matches keys case-insensitively", async () => {
      const a = await addSubscriber(tdb.db, { email: "case@example.test", lists: ["ministries:old7"] });
      await sendEvent(app, succeeded("Old7", ["NEW7", "new7"]));
      expect(await keysOf(a.id)).toEqual(["ministries:new7"]);
    });
  });
});
