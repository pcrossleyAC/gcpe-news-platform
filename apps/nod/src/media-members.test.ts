import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb, waitForLockWaiter } from "../test/helpers";
import { lockAddress } from "./locks";
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

  it("removing the last membership of a manual-media subscriber ends them, writing media-ended (not unsubscribed)", async () => {
    const { subscriberId } = await addMediaMember(tdb.db, "budget", { email: "gone@example.test", source: "manual-media" }, ACTOR);
    const removed = await removeMediaMember(tdb.db, "budget", subscriberId, ACTOR);
    expect(removed).toBe(true);
    const [s] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId));
    expect(s).toMatchObject({ status: "deleted" });
    expect(s!.endedAt).not.toBeNull();
    const history = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, subscriberId));
    expect(history.map((h) => h.action)).toEqual(["media-list-added", "media-list-removed", "media-ended"]);
  });

  // C1: a media-created subscriber is `active`, so a public Subscribe sends them a manage link
  // and `update()` can add a public subscription while `source` stays manual-media/media-hub.
  // Removing their last *media* list must not end their own public mail.
  it("C1: a manual-media subscriber who also picked up a public subscription stays active after their last media list is removed", async () => {
    const { subscriberId } = await addMediaMember(tdb.db, "budget", { email: "both@example.test", source: "manual-media" }, ACTOR);
    await tdb.db.insert(subscriptions).values({ subscriberId, listKey: "ministries:health" });

    const removed = await removeMediaMember(tdb.db, "budget", subscriberId, ACTOR);
    expect(removed).toBe(true);
    const [s] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId));
    expect(s).toMatchObject({ status: "active" });
    const subs = await tdb.db.select().from(subscriptions).where(eq(subscriptions.subscriberId, subscriberId));
    expect(subs.map((r) => r.listKey)).toEqual(["ministries:health"]);
    const history = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, subscriberId));
    expect(history.map((h) => h.action)).not.toContain("media-ended");
  });

  // I1: a staff removal that ends the subscriber must not leave an "unsubscribed" history row,
  // or a later re-add is wrongly refused as opted-out.
  it("I1: re-adding a member staff ended (by removing their last list) needs no confirmOptOut", async () => {
    const { subscriberId } = await addMediaMember(tdb.db, "budget", { email: "ended@example.test", source: "manual-media" }, ACTOR);
    await removeMediaMember(tdb.db, "budget", subscriberId, ACTOR);
    const [ended] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId));
    expect(ended).toMatchObject({ status: "deleted" });

    const result = await addMediaMember(tdb.db, "budget", { email: "ended@example.test", source: "manual-media" }, ACTOR);
    expect(result.subscriberId).toBe(subscriberId);
    const [after] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId));
    expect(after).toMatchObject({ status: "active" });
  });

  // I2: two concurrent adds of a brand-new address must not race an insert into a unique
  // violation, and must leave exactly one subscriber with one subscription.
  it("I2: two concurrent adds of the same new address create exactly one subscriber and one subscription", async () => {
    const [a, b] = await Promise.all([
      addMediaMember(tdb.db, "budget", { email: "race@example.test", source: "manual-media" }, ACTOR),
      addMediaMember(tdb.db, "budget", { email: "RACE@example.test", source: "manual-media" }, ACTOR),
    ]);
    expect(a.subscriberId).toBe(b.subscriberId);
    const rows = await tdb.db.select().from(subscribers).where(eq(subscribers.email, "race@example.test"));
    expect(rows).toHaveLength(1);
    const subs = await tdb.db.select().from(subscriptions).where(eq(subscriptions.subscriberId, rows[0]!.id));
    expect(subs).toHaveLength(1);
  });

  // I2: two concurrent removes of a manual-media subscriber's two remaining lists must end them
  // exactly once, not zero times (each sees the other's list as "still there") or twice.
  it("I2: two concurrent removes of a manual-media subscriber's two lists end them exactly once", async () => {
    await tdb.db.execute(
      sql`INSERT INTO lists (list_key, category, key, name) VALUES ('media-distribution-lists:transport', 'media-distribution-lists', 'transport', 'Transport')`,
    );
    const { subscriberId } = await addMediaMember(tdb.db, "budget", { email: "two-lists@example.test", source: "manual-media" }, ACTOR);
    await addMediaMember(tdb.db, "transport", { email: "two-lists@example.test", source: "manual-media" }, ACTOR);

    await Promise.all([removeMediaMember(tdb.db, "budget", subscriberId, ACTOR), removeMediaMember(tdb.db, "transport", subscriberId, ACTOR)]);

    const [s] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId));
    expect(s).toMatchObject({ status: "deleted" });
    const endedHistory = await tdb.db
      .select()
      .from(subscriberHistory)
      .where(and(eq(subscriberHistory.subscriberId, subscriberId), eq(subscriberHistory.action, "media-ended")));
    expect(endedHistory).toHaveLength(1);
    const subs = await tdb.db.select().from(subscriptions).where(eq(subscriptions.subscriberId, subscriberId));
    expect(subs).toHaveLength(0);
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

  // I3 (controller ruling): reactivating a deleted subscriber for media only must not restart
  // their old public mail, whether they're reactivated because they confirmed an opt-out or
  // because they simply never opted out in the first place.
  it("I3: re-adding a subscriber who unsubscribed resets timing flags and drops their old public list", async () => {
    const [self] = await tdb.db
      .insert(subscribers)
      .values({ email: "resub@example.test", status: "deleted", source: "self", asItHappens: true, digest: true, endedAt: sql`now()` })
      .returning();
    await tdb.db.insert(subscriptions).values({ subscriberId: self!.id, listKey: "ministries:health" });
    await tdb.db.insert(subscriberHistory).values({ subscriberId: self!.id, actor: "subscriber", action: "unsubscribed" });

    const result = await addMediaMember(tdb.db, "budget", { email: "resub@example.test", source: "manual-media", confirmOptOut: true }, ACTOR);
    expect(result.subscriberId).toBe(self!.id);
    const [s] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, self!.id));
    expect(s).toMatchObject({ status: "active", asItHappens: false, digest: false, source: "self" });
    const subs = await tdb.db.select().from(subscriptions).where(eq(subscriptions.subscriberId, self!.id));
    expect(subs.map((r) => r.listKey)).toEqual(["media-distribution-lists:budget"]);
  });

  it("listMediaLists reports live member counts", async () => {
    await addMediaMember(tdb.db, "budget", { email: "a@example.test", source: "manual-media" }, ACTOR);
    await addMediaMember(tdb.db, "budget", { email: "b@example.test", source: "manual-media" }, ACTOR);
    const rows = await listMediaLists(tdb.db);
    expect(rows).toEqual([{ listKey: "media-distribution-lists:budget", key: "budget", name: "Budget", active: true, members: 2, needsAttention: 0 }]);
  });
  it("a remove that waited out a change of address locks the new address before changing anything", async () => {
    const { subscriberId } = await addMediaMember(tdb.db, "budget", { email: "old@example.test", source: "manual-media" }, ACTOR);
    let releaseMove!: () => void;
    const moveGate = new Promise<void>((r) => (releaseMove = r));
    let moveHeld!: () => void;
    const moveReady = new Promise<void>((r) => (moveHeld = r));
    const move = tdb.db.transaction(async (tx) => {
      await lockAddress(tx, "old@example.test");
      moveHeld();
      await moveGate;
      await tx.update(subscribers).set({ email: "new@example.test" }).where(eq(subscribers.id, subscriberId));
    });
    await moveReady;
    const removing = removeMediaMember(tdb.db, "budget", subscriberId, ACTOR);
    await waitForLockWaiter(tdb.db);

    // A writer on the new address holds its lock while the move commits.
    let releaseOther!: () => void;
    const otherGate = new Promise<void>((r) => (releaseOther = r));
    let otherHeld!: () => void;
    const otherReady = new Promise<void>((r) => (otherHeld = r));
    const other = tdb.db.transaction(async (tx) => {
      await lockAddress(tx, "new@example.test");
      otherHeld();
      await otherGate;
    });
    await otherReady;
    releaseMove();
    await move;

    let settled = false;
    void removing.then(() => (settled = true), () => (settled = true));
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false);
    releaseOther();
    await other;
    expect(await removing).toBe(true);
    const [s] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId));
    expect(s).toMatchObject({ email: "new@example.test", status: "deleted" });
  });
});
