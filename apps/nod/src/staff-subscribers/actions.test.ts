import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import type { DeliveryBounced } from "@gcpe/events";
import { createNodTestDb, envelope } from "../../test/helpers";
import { onDeliveryBounced } from "../bounces";
import { deliveries, mediaOptOuts, subscriberHistory, subscribers, subscriptions } from "../db/schema";
import { lockAddress } from "../locks";
import { addMediaMember, OptedOutError } from "../media-members";
import { ALL_MEDIA_LISTS, mediaOptOutAt, optOutHash } from "../opt-outs";
import { addSubscriber } from "../subscribers";
import { createLink, findLink } from "../subscribe/links";
import {
  bulkAction, changeEmail, deleteSubscriber, EmailTakenError, MediaHubManagedError, setStatus, StaffPreferencesError, SubscriberStateError, updatePreferences,
} from "./actions";

const ACTOR = "Jamie Staff";

describe("staff subscriber actions", () => {
  let tdb: TestDatabase;
  const add = async (email: string, over: Partial<typeof subscribers.$inferInsert> = {}) =>
    (await tdb.db.insert(subscribers).values({ email, status: "active", asItHappens: true, ...over }).returning())[0]!;
  const keys = async (id: string) => (await tdb.db.select().from(subscriptions).where(eq(subscriptions.subscriberId, id))).map((r) => r.listKey).sort();
  const actions = async (id: string) => (await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, id))).map((h) => h.action).sort();

  beforeAll(async () => {
    tdb = await createNodTestDb();
    await tdb.db.execute(sql`INSERT INTO lists (list_key, category, key, name, active) VALUES
      ('ministries:health','ministries','health','Health',true),
      ('ministries:agri','ministries','agri','Agriculture',true),
      ('ministries:old','ministries','old','Old',false),
      ('media-distribution-lists:budget','media-distribution-lists','budget','Budget',true)`);
  });
  afterAll(async () => tdb.drop());
  beforeEach(async () => {
    await tdb.db.execute(sql`DELETE FROM subscriber_links; DELETE FROM subscribers; DELETE FROM media_opt_outs;`);
  });

  it("staff preferences edit keeps media memberships", async () => {
    const { subscriberId } = await addMediaMember(tdb.db, "budget", { email: "both@example.test", source: "manual-media" }, ACTOR);
    await tdb.db.insert(subscriptions).values({ subscriberId, listKey: "ministries:health" });
    await updatePreferences(tdb.db, subscriberId, { asItHappens: true, digest: true, allNews: false, listKeys: ["ministries:agri"] }, ACTOR);
    expect(await keys(subscriberId)).toEqual(["media-distribution-lists:budget", "ministries:agri"]);
    const [h] = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.action, "staff-preferences-updated"));
    expect(h).toMatchObject({ actor: ACTOR, subscriberId });
  });

  it("refuses lists without timing and timing without lists; a media-only member may clear both", async () => {
    const s = await add("p@example.test");
    await expect(updatePreferences(tdb.db, s.id, { asItHappens: false, digest: false, allNews: false, listKeys: ["ministries:health"] }, ACTOR)).rejects.toThrow(StaffPreferencesError);
    await expect(updatePreferences(tdb.db, s.id, { asItHappens: true, digest: false, allNews: false, listKeys: [] }, ACTOR)).rejects.toThrow(StaffPreferencesError);
    await expect(updatePreferences(tdb.db, s.id, { asItHappens: false, digest: false, allNews: false, listKeys: [] }, ACTOR)).rejects.toThrow(StaffPreferencesError);
    const { subscriberId } = await addMediaMember(tdb.db, "budget", { email: "m@example.test", source: "manual-media" }, ACTOR);
    await updatePreferences(tdb.db, subscriberId, { asItHappens: false, digest: false, allNews: false, listKeys: [] }, ACTOR);
    expect(await keys(subscriberId)).toEqual(["media-distribution-lists:budget"]);
  });

  it("keeps a held inactive list, takes all news as '*', and refuses a media or unknown key", async () => {
    const s = await add("k@example.test");
    await tdb.db.insert(subscriptions).values({ subscriberId: s.id, listKey: "ministries:old" });
    await updatePreferences(tdb.db, s.id, { asItHappens: true, digest: false, allNews: false, listKeys: ["ministries:old", "ministries:health"] }, ACTOR);
    expect(await keys(s.id)).toEqual(["ministries:health", "ministries:old"]);
    await updatePreferences(tdb.db, s.id, { asItHappens: true, digest: false, allNews: true, listKeys: ["ministries:health"] }, ACTOR);
    expect(await keys(s.id)).toEqual(["*"]);
    await expect(updatePreferences(tdb.db, s.id, { asItHappens: true, digest: false, allNews: false, listKeys: ["media-distribution-lists:budget"] }, ACTOR)).rejects.toThrow(StaffPreferencesError);
    await expect(updatePreferences(tdb.db, s.id, { asItHappens: true, digest: false, allNews: false, listKeys: ["ministries:nope"] }, ACTOR)).rejects.toThrow(StaffPreferencesError);
  });

  it("refuses to edit a deleted or pending subscriber", async () => {
    const s = await add("gone@example.test", { status: "deleted" });
    await expect(updatePreferences(tdb.db, s.id, { asItHappens: true, digest: false, allNews: true, listKeys: [] }, ACTOR)).rejects.toThrow(SubscriberStateError);
    const p = await add("waiting@example.test", { status: "pending" });
    await expect(updatePreferences(tdb.db, p.id, { asItHappens: true, digest: false, allNews: true, listKeys: [] }, ACTOR)).rejects.toThrow(SubscriberStateError);
    await expect(changeEmail(tdb.db, p.id, "elsewhere@example.test", ACTOR)).rejects.toThrow(SubscriberStateError);
  });

  it("change email refuses a pending subscriber and leaves the row and its links alone", async () => {
    const p = await add("pending@example.test", { status: "pending" });
    const link = await createLink(tdb.db, { purpose: "verify", email: "pending@example.test", subscriberId: p.id, pending: null });
    const err = await changeEmail(tdb.db, p.id, "moved@example.test", ACTOR).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubscriberStateError);
    expect((err as SubscriberStateError).status).toBe("pending");
    expect((await tdb.db.select().from(subscribers).where(eq(subscribers.id, p.id)))[0]).toMatchObject({ email: "pending@example.test", unsubscribeVersion: p.unsubscribeVersion });
    expect((await findLink(tdb.db, link.token))!.expired).toBe(false);
  });

  it("status: deactivate and activate write history; a no-op is unchanged; a deleted subscriber can't be activated", async () => {
    const s = await add("s@example.test");
    expect(await setStatus(tdb.db, s.id, "disabled", ACTOR)).toEqual({ changed: true });
    expect(await setStatus(tdb.db, s.id, "disabled", ACTOR)).toEqual({ changed: false });
    expect(await setStatus(tdb.db, s.id, "active", ACTOR)).toEqual({ changed: true });
    expect(await actions(s.id)).toEqual(["staff-activated", "staff-deactivated"]);
    const [after] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, s.id));
    expect(after!.bounceWindowFrom).not.toBeNull();
    const d = await add("d@example.test", { status: "deleted" });
    await expect(setStatus(tdb.db, d.id, "active", ACTOR)).rejects.toThrow(SubscriberStateError);
  });

  it("reactivation restarts the bounce count", async () => {
    const s = await add("bouncy@example.test", { status: "disabled" });
    for (let i = 0; i < 10; i++) {
      await tdb.db.insert(deliveries).values({ subscriberId: s.id, itemKey: `old-${i}`, attemptedAt: new Date(Date.now() - 3_600_000), distributionBatchId: randomUUID(), hardBouncedAt: new Date(), bounceStatus: "5.1.1" });
    }
    await setStatus(tdb.db, s.id, "active", ACTOR);
    const batchId = randomUUID();
    await tdb.db.insert(deliveries).values({ subscriberId: s.id, itemKey: "new-1", attemptedAt: new Date(Date.now() + 1000), distributionBatchId: batchId });
    const data: DeliveryBounced = { appId: "nod", batchId, messageId: randomUUID(), email: "bouncy@example.test", hard: true, status: "5.1.1", at: new Date().toISOString() };
    const r = await tdb.db.transaction((tx) => onDeliveryBounced(tx, envelope("distribution", "delivery.bounced", data), { appId: "nod" }));
    expect(r.action).toBe("recorded");
    expect((await tdb.db.select().from(subscribers).where(eq(subscribers.id, s.id)))[0]!.status).toBe("active");
  });

  it("delete ends the subscriber and removes media memberships as staff removals, not opt-outs; re-adding needs no confirmOptOut", async () => {
    const { subscriberId } = await addMediaMember(tdb.db, "budget", { email: "del@example.test", source: "manual-media" }, ACTOR);
    expect(await deleteSubscriber(tdb.db, subscriberId, ACTOR)).toEqual({ changed: true });
    expect(await deleteSubscriber(tdb.db, subscriberId, ACTOR)).toEqual({ changed: false });
    const [row] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId));
    expect(row).toMatchObject({ status: "deleted" });
    expect(row!.endedAt).not.toBeNull();
    expect(await keys(subscriberId)).toEqual([]);
    const acts = await actions(subscriberId);
    expect(acts).toEqual(expect.arrayContaining(["staff-deleted", "media-list-removed"]));
    expect(acts).not.toContain("media-list-opted-out");
    expect(acts).not.toContain("unsubscribed");
    await expect(addMediaMember(tdb.db, "budget", { email: "del@example.test", source: "manual-media" }, ACTOR)).resolves.toMatchObject({ subscriberId });
  });

  it("change email moves the address, rotates the unsubscribe token, ends old links and writes history with no address", async () => {
    const s = await add("old@example.test");
    const link = await createLink(tdb.db, { purpose: "manage", email: "old@example.test", subscriberId: s.id, pending: null });
    expect(await changeEmail(tdb.db, s.id, " New@Example.TEST ", ACTOR)).toEqual({ changed: true });
    const [after] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, s.id));
    expect(after).toMatchObject({ email: "new@example.test", unsubscribeVersion: s.unsubscribeVersion + 1 });
    expect((await findLink(tdb.db, link.token))!.expired).toBe(true);
    const [h] = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.action, "staff-email-changed"));
    expect(h!.detail).not.toContain("@");
    expect(await changeEmail(tdb.db, s.id, "NEW@example.test", ACTOR)).toEqual({ changed: false });
  });

  it("change email refuses an address held by any other row (even deleted), and a Media Hub-sourced member", async () => {
    const s = await add("a@example.test");
    const taken = await add("b@example.test", { status: "deleted" });
    const err = await changeEmail(tdb.db, s.id, "b@example.test", ACTOR).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmailTakenError);
    expect((err as EmailTakenError).id).toBe(taken.id);
    expect((await tdb.db.select().from(subscribers).where(eq(subscribers.id, s.id)))[0]!.email).toBe("a@example.test");
    const hub = await add("hub@example.test", { source: "media-hub", mediaHubContactId: 7 });
    await expect(changeEmail(tdb.db, hub.id, "other@example.test", ACTOR)).rejects.toThrow(MediaHubManagedError);
  });

  it("change email refuses a self-sourced subscriber the Media Hub sync also tracks by contact id", async () => {
    const self = await add("linked@example.test", { source: "self" });
    await addMediaMember(tdb.db, "budget", { email: "linked@example.test", source: "media-hub", mediaHubContactId: 42 }, ACTOR);
    const [linked] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, self.id));
    expect(linked).toMatchObject({ source: "self", mediaHubContactId: 42 });
    await expect(changeEmail(tdb.db, self.id, "elsewhere@example.test", ACTOR)).rejects.toThrow(MediaHubManagedError);
    expect((await tdb.db.select().from(subscribers).where(eq(subscribers.id, self.id)))[0]!.email).toBe("linked@example.test");
  });

  it("bulk over mixed statuses handles each row on its own and reports what it skipped", async () => {
    const active = await add("b1@example.test");
    const disabled = await add("b2@example.test", { status: "disabled" });
    const deleted = await add("b3@example.test", { status: "deleted" });
    const missing = "00000000-0000-0000-0000-000000000000";
    const r = await bulkAction(tdb.db, [active.id, disabled.id, deleted.id, missing, disabled.id], "activate", ACTOR);
    expect(r.changed).toBe(1);
    expect(r.skipped).toEqual([
      { id: active.id, reason: "unchanged" },
      { id: deleted.id, reason: "status" },
      { id: missing, reason: "not-found" },
    ]);
  });

  it("bulk records an unexpected failure on one row as an error, logs no address, and carries on", async () => {
    const before = await add("bulk-a@example.test");
    const broken = await add("bulk-boom@example.test");
    const after = await add("bulk-c@example.test");
    await tdb.db.execute(sql`CREATE FUNCTION refuse_boom() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.email = 'bulk-boom@example.test' THEN RAISE EXCEPTION 'refused by test trigger'; END IF; RETURN NEW; END $$`);
    await tdb.db.execute(sql`CREATE TRIGGER refuse_boom BEFORE UPDATE ON subscribers FOR EACH ROW EXECUTE FUNCTION refuse_boom()`);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await bulkAction(tdb.db, [before.id, broken.id, after.id], "deactivate", ACTOR);
      expect(r).toEqual({ changed: 2, skipped: [{ id: broken.id, reason: "error" }] });
      expect(logged).toHaveBeenCalled();
      expect(JSON.stringify(logged.mock.calls)).not.toContain("@");
    } finally {
      logged.mockRestore();
      await tdb.db.execute(sql`DROP TRIGGER refuse_boom ON subscribers; DROP FUNCTION refuse_boom()`);
    }
    expect((await tdb.db.select().from(subscribers).where(eq(subscribers.id, after.id)))[0]!.status).toBe("disabled");
  });

  it("addSubscriber lowercases, takes timing, and writes staff-added history", async () => {
    const { id } = await addSubscriber(tdb.db, { email: "New.Person@Example.test", lists: ["ministries:health"], asItHappens: false, digest: true }, ACTOR);
    const [row] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, id));
    expect(row).toMatchObject({ email: "new.person@example.test", status: "active", source: "admin", asItHappens: false, digest: true });
    expect(await actions(id)).toEqual(["staff-added"]);
  });

  /** Holds `address`'s lock in another transaction, running `inside` under it, until the
   * returned release is called. */
  const holdLock = async (address: string, inside: (tx: Parameters<Parameters<typeof tdb.db.transaction>[0]>[0]) => Promise<void> = async () => {}) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => (locked = r));
    const done = tdb.db.transaction(async (tx) => {
      await lockAddress(tx, address);
      await inside(tx);
      locked();
      await gate;
    });
    await lockedP;
    return async () => { release(); await done; };
  };

  it("staff delete waits for the address lock, and removes media memberships in the same transaction", async () => {
    const { subscriberId } = await addMediaMember(tdb.db, "budget", { email: "locked@example.test", source: "manual-media" }, ACTOR);
    const release = await holdLock("locked@example.test");
    let settled = false;
    const deleting = deleteSubscriber(tdb.db, subscriberId, ACTOR).finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false);
    expect((await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId)))[0]!.status).toBe("active");
    await release();
    expect(await deleting).toEqual({ changed: true });
    expect(await keys(subscriberId)).toEqual([]);
  });

  it("a staff write whose subscriber's address moves while it waits acts on the moved row", async () => {
    const s = await add("before@example.test");
    const release = await holdLock("before@example.test", async (tx) => {
      await tx.update(subscribers).set({ email: "after@example.test" }).where(eq(subscribers.id, s.id));
    });
    const disabling = setStatus(tdb.db, s.id, "disabled", ACTOR);
    await new Promise((r) => setTimeout(r, 300));
    await release();
    expect(await disabling).toEqual({ changed: true });
    expect((await tdb.db.select().from(subscribers).where(eq(subscribers.id, s.id)))[0]).toMatchObject({ email: "after@example.test", status: "disabled" });
  });

  it("change email onto an address with a kept media opt-out asks first; confirmed, it moves and counts as a re-add", async () => {
    const budget = "media-distribution-lists:budget";
    const { subscriberId } = await addMediaMember(tdb.db, "budget", { email: "b@example.test", source: "manual-media" }, ACTOR);
    const optedOutAt = new Date("2026-06-01T17:00:00Z");
    await tdb.db.insert(mediaOptOuts).values({ emailHash: optOutHash("a@example.test"), listKey: ALL_MEDIA_LISTS, optedOutAt });
    const err = await changeEmail(tdb.db, subscriberId, "a@example.test", ACTOR).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OptedOutError);
    expect((err as OptedOutError).at).toEqual(optedOutAt);
    expect((await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId)))[0]).toMatchObject({ email: "b@example.test" });

    expect(await changeEmail(tdb.db, subscriberId, "a@example.test", ACTOR, { confirmOptOut: true })).toEqual({ changed: true });
    const [s] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId));
    expect(s).toMatchObject({ email: "a@example.test" });
    expect(await keys(subscriberId)).toEqual([budget]);
    expect(await mediaOptOutAt(tdb.db, "a@example.test", budget, s!)).toBeNull();
  });

  it("change email onto an address with a kept opt-out from a list the subscriber isn't on goes ahead", async () => {
    const { subscriberId } = await addMediaMember(tdb.db, "budget", { email: "c@example.test", source: "manual-media" }, ACTOR);
    await tdb.db.insert(mediaOptOuts).values({ emailHash: optOutHash("d@example.test"), listKey: "media-distribution-lists:other", optedOutAt: new Date("2026-06-01T17:00:00Z") });
    expect(await changeEmail(tdb.db, subscriberId, "d@example.test", ACTOR)).toEqual({ changed: true });
  });
});
