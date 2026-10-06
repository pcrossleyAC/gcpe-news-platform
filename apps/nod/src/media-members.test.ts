import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../test/helpers";
import { subscriberHistory, subscribers, subscriptions } from "./db/schema";
import { addMediaMember, hasMediaMemberships, listMediaLists, listMediaMembers, MediaListNotFoundError, OptedOutError, removeMediaMember } from "./media-members";

const ACTOR = "staff:jamie";

describe("media list members", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNodTestDb();
  });
  afterAll(async () => tdb.drop());
  beforeEach(async () => {
    await tdb.db.execute(sql`DELETE FROM subscriber_history; DELETE FROM subscribers; DELETE FROM lists WHERE category = 'media-distribution-lists';`);
    await tdb.db.execute(
      sql`INSERT INTO lists (list_key, category, key, name) VALUES ('media-distribution-lists:budget', 'media-distribution-lists', 'budget', 'Budget')`,
    );
  });

  it("404s (MediaListNotFoundError) for a list not in the media category", async () => {
    await expect(addMediaMember(tdb.db, "nope", { email: "x@example.test", source: "manual-media" }, ACTOR)).rejects.toBeInstanceOf(MediaListNotFoundError);
    await expect(listMediaMembers(tdb.db, "nope")).rejects.toBeInstanceOf(MediaListNotFoundError);
  });

  it("adds a new address as an active manual-media subscriber with no timing flags", async () => {
    const { subscriberId, created } = await addMediaMember(tdb.db, "budget", { email: "Journo@Example.TEST", source: "manual-media" }, ACTOR);
    expect(created).toBe(true);
    const [s] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId));
    expect(s).toMatchObject({ email: "journo@example.test", status: "active", source: "manual-media", asItHappens: false, digest: false });
    const subs = await tdb.db.select().from(subscriptions).where(eq(subscriptions.subscriberId, subscriberId));
    expect(subs.map((r) => r.listKey)).toEqual(["media-distribution-lists:budget"]);
    expect(await hasMediaMemberships(tdb.db, subscriberId)).toBe(true);
    const history = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, subscriberId));
    expect(history).toMatchObject([{ actor: ACTOR, action: "media-list-added", detail: "media-distribution-lists:budget" }]);
  });

  it("adds a member to an existing self subscriber, leaving source, timing and public lists alone", async () => {
    const [self] = await tdb.db
      .insert(subscribers)
      .values({ email: "pat@example.test", status: "active", source: "self", asItHappens: true, digest: true })
      .returning();
    await tdb.db.insert(subscriptions).values({ subscriberId: self!.id, listKey: "ministries:health" });

    const { subscriberId, created } = await addMediaMember(tdb.db, "budget", { email: "pat@example.test", source: "manual-media" }, ACTOR);
    expect(created).toBe(false);
    expect(subscriberId).toBe(self!.id);
    const [s] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, self!.id));
    expect(s).toMatchObject({ source: "self", asItHappens: true, digest: true });
    const subs = await tdb.db.select().from(subscriptions).where(eq(subscriptions.subscriberId, self!.id));
    expect(subs.map((r) => r.listKey).sort()).toEqual(["media-distribution-lists:budget", "ministries:health"]);
  });

  it("adding the same address twice is idempotent: created false, one subscription", async () => {
    await addMediaMember(tdb.db, "budget", { email: "dup@example.test", source: "manual-media" }, ACTOR);
    const { created } = await addMediaMember(tdb.db, "budget", { email: "DUP@example.test", source: "manual-media" }, ACTOR);
    expect(created).toBe(false);
    const [s] = await tdb.db.select().from(subscribers).where(eq(subscribers.email, "dup@example.test"));
    const subs = await tdb.db.select().from(subscriptions).where(eq(subscriptions.subscriberId, s!.id));
    expect(subs).toHaveLength(1);
  });

  it("removing the last membership of a manual-media subscriber ends them", async () => {
    const { subscriberId } = await addMediaMember(tdb.db, "budget", { email: "gone@example.test", source: "manual-media" }, ACTOR);
    const removed = await removeMediaMember(tdb.db, "budget", subscriberId, ACTOR);
    expect(removed).toBe(true);
    const [s] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId));
    expect(s).toMatchObject({ status: "deleted" });
    expect(s!.endedAt).not.toBeNull();
    const history = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, subscriberId));
    expect(history.map((h) => h.action)).toEqual(["media-list-added", "media-list-removed", "unsubscribed"]);
  });

  it("removing a self subscriber's only media membership removes just the subscription", async () => {
    const [self] = await tdb.db.insert(subscribers).values({ email: "pat2@example.test", status: "active", source: "self", asItHappens: true }).returning();
    await tdb.db.insert(subscriptions).values({ subscriberId: self!.id, listKey: "ministries:health" });
    await addMediaMember(tdb.db, "budget", { email: "pat2@example.test", source: "manual-media" }, ACTOR);

    const removed = await removeMediaMember(tdb.db, "budget", self!.id, ACTOR);
    expect(removed).toBe(true);
    const [s] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, self!.id));
    expect(s).toMatchObject({ status: "active" }); // untouched
    const subs = await tdb.db.select().from(subscriptions).where(eq(subscriptions.subscriberId, self!.id));
    expect(subs.map((r) => r.listKey)).toEqual(["ministries:health"]);
  });

  it("removing a membership that doesn't exist returns false and writes nothing", async () => {
    const [s] = await tdb.db.insert(subscribers).values({ email: "none@example.test", status: "active", source: "self" }).returning();
    expect(await removeMediaMember(tdb.db, "budget", s!.id, ACTOR)).toBe(false);
    const history = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, s!.id));
    expect(history).toHaveLength(0);
  });

  it("re-adding an opted-out address needs confirmOptOut; confirming reactivates", async () => {
    const { subscriberId } = await addMediaMember(tdb.db, "budget", { email: "opted@example.test", source: "manual-media" }, ACTOR);
    await tdb.db.update(subscribers).set({ status: "deleted", endedAt: sql`now()` }).where(eq(subscribers.id, subscriberId));
    await tdb.db.insert(subscriberHistory).values({ subscriberId, actor: "subscriber", action: "unsubscribed" });

    const err = await addMediaMember(tdb.db, "budget", { email: "opted@example.test", source: "manual-media" }, ACTOR).catch((e) => e);
    expect(err).toBeInstanceOf(OptedOutError);

    const result = await addMediaMember(tdb.db, "budget", { email: "opted@example.test", confirmOptOut: true, source: "manual-media" }, ACTOR);
    expect(result.subscriberId).toBe(subscriberId);
    const [s] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId));
    expect(s).toMatchObject({ status: "active" });
  });

  it("listMediaLists reports live member counts", async () => {
    await addMediaMember(tdb.db, "budget", { email: "a@example.test", source: "manual-media" }, ACTOR);
    await addMediaMember(tdb.db, "budget", { email: "b@example.test", source: "manual-media" }, ACTOR);
    const rows = await listMediaLists(tdb.db);
    expect(rows).toEqual([{ listKey: "media-distribution-lists:budget", key: "budget", name: "Budget", active: true, members: 2 }]);
  });
});
