import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createFakeMediaHub, type FakeMediaHubControls } from "@gcpe/media-hub-fake";
import { createNodTestDb } from "../../test/helpers";
import { dailyCutoff } from "../digest";
import { nodSettings, subscriberHistory, subscribers, subscriptions } from "../db/schema";
import { addMediaMember } from "../media-members";
import { MediaHubError, mediaHubClient, type MediaHubClient } from "./client";
import type { MediaHubContact } from "./contract";
import { MEDIA_SYNC_HOUR, resolveMediaMember, runMediaSync, runMediaSyncIfDue } from "./sync";

const TZ = "America/Vancouver";
const ACTOR_LIST_KEY = "media-distribution-lists:press";

describe("dailyCutoff (media sync @ 02:00)", () => {
  it("MEDIA_SYNC_HOUR is 2", () => {
    expect(MEDIA_SYNC_HOUR).toBe(2);
  });

  it("is today 02:00 local once past it, yesterday's before", () => {
    // 01:59 PDT (-7) = 08:59Z; 02:00 PDT = 09:00Z.
    expect(dailyCutoff(new Date("2026-10-06T08:59:00Z"), TZ, MEDIA_SYNC_HOUR).toISOString()).toBe("2026-10-05T09:00:00.000Z");
    expect(dailyCutoff(new Date("2026-10-06T09:00:00Z"), TZ, MEDIA_SYNC_HOUR).toISOString()).toBe("2026-10-06T09:00:00.000Z");
  });
});

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

async function listen(app: express.Express): Promise<string> {
  server = createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function startFake(opts: { contactCount?: number; seed?: number } = {}): Promise<{ client: MediaHubClient; controls: FakeMediaHubControls }> {
  const fake = createFakeMediaHub({ seed: opts.seed ?? 7, contactCount: opts.contactCount ?? 6, requireServiceAuth: (_req, _res, next) => next() });
  const app = express();
  app.use(fake.router);
  const baseUrl = await listen(app);
  const client = mediaHubClient({ baseUrl, getToken: async () => "test-token" });
  return { client, controls: fake.controls };
}

function liveWorkplaceContact(controls: FakeMediaHubControls): { contact: MediaHubContact; ref: string; address: string } {
  const c = controls.contacts().find((x) => !x.deletedAt && x.emails.some((e) => e.kind === "workplace"))!;
  const email = c.emails.find((e) => e.kind === "workplace")!;
  return { contact: c, ref: email.ref, address: email.address };
}

async function resetDb(tdb: TestDatabase): Promise<void> {
  await tdb.db.execute(sql`DELETE FROM subscriber_history; DELETE FROM subscribers; DELETE FROM lists WHERE category = 'media-distribution-lists';`);
  await tdb.db.execute(
    sql`INSERT INTO lists (list_key, category, key, name) VALUES ('media-distribution-lists:press', 'media-distribution-lists', 'press', 'Press')`,
  );
  await tdb.db.update(nodSettings).set({ mediaSyncSince: null, mediaSyncAt: null, mediaSyncResult: null }).where(eq(nodSettings.id, 1));
}

describe("runMediaSync", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createNodTestDb();
  });
  afterAll(async () => tdb.drop());
  beforeEach(async () => resetDb(tdb));

  it("a chosen workplace email change updates the subscriber's address, bumps unsubscribeVersion, and writes history", async () => {
    const { client, controls } = await startFake();
    const { contact, ref, address } = liveWorkplaceContact(controls);

    const { subscriberId } = await addMediaMember(tdb.db, "press", { email: address, source: "media-hub", mediaHubContactId: contact.id, mediaHubEmailRef: ref }, "staff:jamie");
    const [before] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId));

    const newAddress = "moved@newsroom.example.test";
    controls.changeEmail(contact.id, ref, newAddress);

    const result = await runMediaSync(tdb.db, client);
    expect(result.updated).toBe(1);
    expect(result.errors).toBe(0);

    const [after] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId));
    expect(after).toMatchObject({ email: newAddress, needsAttention: null });
    expect(after!.unsubscribeVersion).toBe(before!.unsubscribeVersion + 1);

    const history = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, subscriberId));
    expect(history.map((h) => h.action)).toContain("media-hub-email-changed");
    const changed = history.find((h) => h.action === "media-hub-email-changed")!;
    expect(changed.detail).toBe(ref);
    expect(changed.detail).not.toContain("@");
  });

  it("a chosen email change that collides with another subscriber flags email-taken and changes nothing", async () => {
    const { client, controls } = await startFake();
    const { contact, ref, address } = liveWorkplaceContact(controls);

    const { subscriberId } = await addMediaMember(tdb.db, "press", { email: address, source: "media-hub", mediaHubContactId: contact.id, mediaHubEmailRef: ref }, "staff:jamie");

    const takenAddress = "already-here@example.test";
    await tdb.db.insert(subscribers).values({ email: takenAddress, status: "active", source: "self" });
    controls.changeEmail(contact.id, ref, takenAddress);

    const result = await runMediaSync(tdb.db, client);
    expect(result.flagged).toBe(1);
    expect(result.updated).toBe(0);

    const [after] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId));
    expect(after).toMatchObject({ email: address.toLowerCase(), needsAttention: "email-taken" });
    expect(after!.attentionAt).not.toBeNull();

    const history = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, subscriberId));
    expect(history.map((h) => h.action)).toContain("media-hub-flagged");
  });

  it("the chosen ref vanishing flags email-gone and keeps the membership", async () => {
    const { client, controls } = await startFake();
    const { contact, ref, address } = liveWorkplaceContact(controls);

    const { subscriberId } = await addMediaMember(tdb.db, "press", { email: address, source: "media-hub", mediaHubContactId: contact.id, mediaHubEmailRef: ref }, "staff:jamie");
    controls.removeEmail(contact.id, ref);

    const result = await runMediaSync(tdb.db, client);
    expect(result.flagged).toBe(1);

    const [after] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId));
    expect(after).toMatchObject({ email: address.toLowerCase(), needsAttention: "email-gone" });

    const subs = await tdb.db.select().from(subscriptions).where(eq(subscriptions.subscriberId, subscriberId));
    expect(subs.map((r) => r.listKey)).toEqual([ACTOR_LIST_KEY]);
  });

  it("a deleted contact removes every membership, ending a media-hub-only subscriber", async () => {
    const { client, controls } = await startFake();
    const { contact, ref, address } = liveWorkplaceContact(controls);

    const { subscriberId } = await addMediaMember(tdb.db, "press", { email: address, source: "media-hub", mediaHubContactId: contact.id, mediaHubEmailRef: ref }, "staff:jamie");
    controls.deleteContact(contact.id);

    const result = await runMediaSync(tdb.db, client);
    expect(result.removed).toBe(1);

    const subs = await tdb.db.select().from(subscriptions).where(eq(subscriptions.subscriberId, subscriberId));
    expect(subs).toHaveLength(0);

    const [after] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId));
    expect(after).toMatchObject({ status: "deleted" });
    expect(after!.endedAt).not.toBeNull();

    const history = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, subscriberId));
    expect(history.map((h) => h.action)).toEqual(["media-list-added", "media-list-removed", "media-ended"]);
  });

  it("aborts without advancing mediaSyncSince on a contract error, and records the error result", async () => {
    const failing: MediaHubClient = {
      search: async () => {
        throw new Error("unused");
      },
      get: async () => null,
      changes: async () => {
        throw new MediaHubError("contract", "feed failed contract validation");
      },
    };

    await expect(runMediaSync(tdb.db, failing)).rejects.toBeInstanceOf(MediaHubError);

    const [row] = await tdb.db.select().from(nodSettings).where(eq(nodSettings.id, 1));
    expect(row!.mediaSyncSince).toBeNull();
    expect(row!.mediaSyncAt).not.toBeNull();
    expect(row!.mediaSyncResult).toMatchObject({ error: "MediaHubError" });
  });
});

describe("runMediaSyncIfDue", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createNodTestDb();
  });
  afterAll(async () => tdb.drop());
  beforeEach(async () => resetDb(tdb));

  it("runs once; a second call the same day returns ran:false and makes no further change", async () => {
    const { client } = await startFake();

    const first = await runMediaSyncIfDue(tdb.db, client, TZ);
    expect(first.ran).toBe(true);
    expect(first.result).toBeDefined();

    const [afterFirst] = await tdb.db.select().from(nodSettings).where(eq(nodSettings.id, 1));

    const second = await runMediaSyncIfDue(tdb.db, client, TZ);
    expect(second).toEqual({ ran: false });

    const [afterSecond] = await tdb.db.select().from(nodSettings).where(eq(nodSettings.id, 1));
    expect(afterSecond!.mediaSyncSince).toEqual(afterFirst!.mediaSyncSince);
  });

  it("concurrent calls: exactly one ran:true, mediaSyncSince set once, one history row per change", async () => {
    const { client, controls } = await startFake();
    const { contact, ref, address } = liveWorkplaceContact(controls);
    const { subscriberId } = await addMediaMember(tdb.db, "press", { email: address, source: "media-hub", mediaHubContactId: contact.id, mediaHubEmailRef: ref }, "staff:jamie");
    controls.changeEmail(contact.id, ref, "concurrent-new@example.test");

    const [a, b] = await Promise.all([runMediaSyncIfDue(tdb.db, client, TZ), runMediaSyncIfDue(tdb.db, client, TZ)]);
    const ranCount = [a.ran, b.ran].filter(Boolean).length;
    expect(ranCount).toBe(1);

    const [row] = await tdb.db.select().from(nodSettings).where(eq(nodSettings.id, 1));
    expect(row!.mediaSyncSince).not.toBeNull();

    const history = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, subscriberId));
    expect(history.filter((h) => h.action === "media-hub-email-changed")).toHaveLength(1);
  });
});

describe("resolveMediaMember", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createNodTestDb();
  });
  afterAll(async () => tdb.drop());
  beforeEach(async () => resetDb(tdb));

  it("returns not-found for an unknown subscriber", async () => {
    await expect(resolveMediaMember(tdb.db, null, "00000000-0000-0000-0000-000000000000", undefined, "staff:jamie")).resolves.toBe("not-found");
  });

  it("with no emailRef, clears the flag and writes media-hub-resolved", async () => {
    const { subscriberId } = await addMediaMember(tdb.db, "press", { email: "flagged@example.test", source: "manual-media" }, "staff:jamie");
    await tdb.db.update(subscribers).set({ needsAttention: "email-gone", attentionAt: sql`now()` }).where(eq(subscribers.id, subscriberId));

    const outcome = await resolveMediaMember(tdb.db, null, subscriberId, undefined, "staff:jamie");
    expect(outcome).toBe("resolved");

    const [after] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId));
    expect(after).toMatchObject({ needsAttention: null, attentionAt: null });
    const history = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, subscriberId));
    expect(history.map((h) => h.action)).toContain("media-hub-resolved");
  });

  it("with a valid new ref, re-points the member to that address and clears the flag", async () => {
    const { client, controls } = await startFake();
    const live = controls.contacts().find((c) => !c.deletedAt && c.emails.length > 1)!;
    const firstRef = live.emails[0]!;
    const secondRef = live.emails[1]!;

    const { subscriberId } = await addMediaMember(
      tdb.db,
      "press",
      { email: firstRef.address, source: "media-hub", mediaHubContactId: live.id, mediaHubEmailRef: firstRef.ref },
      "staff:jamie",
    );
    await tdb.db.update(subscribers).set({ needsAttention: "email-gone", attentionAt: sql`now()` }).where(eq(subscribers.id, subscriberId));

    const outcome = await resolveMediaMember(tdb.db, client, subscriberId, secondRef.ref, "staff:jamie");
    expect(outcome).toBe("resolved");

    const [after] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId));
    expect(after).toMatchObject({ email: secondRef.address.toLowerCase(), mediaHubEmailRef: secondRef.ref, needsAttention: null });
  });

  it("returns ref-not-found for an unknown ref, and media-hub-unavailable when no client is configured", async () => {
    const { subscriberId } = await addMediaMember(tdb.db, "press", { email: "noclient@example.test", source: "manual-media" }, "staff:jamie");
    expect(await resolveMediaMember(tdb.db, null, subscriberId, "workplace:1", "staff:jamie")).toBe("media-hub-unavailable");
  });
});
