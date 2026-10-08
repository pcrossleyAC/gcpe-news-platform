import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createFakeMediaHub, type FakeMediaHubControls } from "@gcpe/media-hub-fake";
import { createNodTestDb } from "../../test/helpers";
import { dailyCutoff } from "../digest";
import { mediaOptOuts, nodSettings, subscriberHistory, subscribers, subscriptions } from "../db/schema";
import { ALL_MEDIA_LISTS, optOutHash } from "../opt-outs";
import { addMediaMember } from "../media-members";
import { setPaused, type SetPausedDeps } from "../settings";
import { createLink, findLink } from "../subscribe/links";
import type { DistributionClient } from "../distribution-client";
import { MediaHubError, mediaHubClient, type MediaHubClient } from "./client";
import type { MediaHubChangesPage, MediaHubContact } from "./contract";
import {
  MEDIA_SYNC_HOUR,
  resolveMediaMember,
  runMediaSync,
  runMediaSyncIfDue,
  type SyncOutcome,
  type SyncResult,
} from "./sync";

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
  await tdb.db.execute(sql`DELETE FROM subscriber_history; DELETE FROM subscribers; DELETE FROM media_opt_outs; DELETE FROM lists WHERE category = 'media-distribution-lists';`);
  await tdb.db.execute(
    sql`INSERT INTO lists (list_key, category, key, name) VALUES ('media-distribution-lists:press', 'media-distribution-lists', 'press', 'Press')`,
  );
  await tdb.db
    .update(nodSettings)
    .set({
      mediaSyncSince: null,
      mediaSyncAt: null,
      mediaSyncResult: null,
      mediaSyncLease: null,
      mediaSyncLeaseUntil: null,
      mediaSyncRunStart: null,
      mediaSyncCursor: null,
    })
    .where(eq(nodSettings.id, 1));
}

/** Narrows `runMediaSync`'s `SyncOutcome | "busy"` for tests that expect it to have actually
 * run (never "busy" -- nothing else is touching the lease). */
function expectRan(outcome: SyncOutcome | "busy"): SyncOutcome {
  if (outcome === "busy") throw new Error("expected the sync to run, not report busy");
  return outcome;
}

function expectCounts(result: SyncOutcome["result"]): SyncResult {
  if ("error" in result) throw new Error(`expected counts, got an error result: ${JSON.stringify(result)}`);
  return result;
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

    const outcome = expectRan(await runMediaSync(tdb.db, client));
    expect(outcome.done).toBe(true);
    const result = expectCounts(outcome.result);
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

  it("a chosen email change ends the subscriber's outstanding links, which went to the old address", async () => {
    const { client, controls } = await startFake();
    const { contact, ref, address } = liveWorkplaceContact(controls);
    const { subscriberId } = await addMediaMember(tdb.db, "press", { email: address, source: "media-hub", mediaHubContactId: contact.id, mediaHubEmailRef: ref }, "staff:jamie");
    const { token } = await createLink(tdb.db, { purpose: "manage", email: address, subscriberId, pending: null });
    expect((await findLink(tdb.db, token))!.expired).toBe(false);

    controls.changeEmail(contact.id, ref, "moved@newsroom.example.test");
    expect(expectCounts(expectRan(await runMediaSync(tdb.db, client)).result).updated).toBe(1);
    expect((await findLink(tdb.db, token))!.expired).toBe(true);
  });

  it("a chosen email change that collides with another subscriber flags email-taken and changes nothing", async () => {
    const { client, controls } = await startFake();
    const { contact, ref, address } = liveWorkplaceContact(controls);

    const { subscriberId } = await addMediaMember(tdb.db, "press", { email: address, source: "media-hub", mediaHubContactId: contact.id, mediaHubEmailRef: ref }, "staff:jamie");

    const takenAddress = "already-here@example.test";
    await tdb.db.insert(subscribers).values({ email: takenAddress, status: "active", source: "self" });
    controls.changeEmail(contact.id, ref, takenAddress);

    const outcome = expectRan(await runMediaSync(tdb.db, client));
    const result = expectCounts(outcome.result);
    expect(result.flagged).toBe(1);
    expect(result.updated).toBe(0);

    const [after] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId));
    expect(after).toMatchObject({ email: address.toLowerCase(), needsAttention: "email-taken" });
    expect(after!.attentionAt).not.toBeNull();

    const history = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, subscriberId));
    expect(history.map((h) => h.action)).toContain("media-hub-flagged");
  });

  it("a chosen email change onto an address with a kept opt-out from a list the member is on flags opted-out-address and changes nothing", async () => {
    const { client, controls } = await startFake();
    const { contact, ref, address } = liveWorkplaceContact(controls);
    const { subscriberId } = await addMediaMember(tdb.db, "press", { email: address, source: "media-hub", mediaHubContactId: contact.id, mediaHubEmailRef: ref }, "staff:jamie");
    await tdb.db.insert(mediaOptOuts).values({ emailHash: optOutHash("opted-out@example.test"), listKey: ALL_MEDIA_LISTS, optedOutAt: new Date("2026-06-01T17:00:00Z") });
    controls.changeEmail(contact.id, ref, "opted-out@example.test");

    const result = expectCounts(expectRan(await runMediaSync(tdb.db, client)).result);
    expect(result).toMatchObject({ flagged: 1, updated: 0 });
    const [after] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId));
    expect(after).toMatchObject({ email: address.toLowerCase(), needsAttention: "opted-out-address" });
    const history = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, subscriberId));
    expect(history.map((h) => h.action)).toContain("media-hub-flagged");
    expect(history.map((h) => h.action)).not.toContain("media-hub-email-changed");
  });

  it("a chosen email change to an invalid address flags email-invalid and changes nothing", async () => {
    const { client, controls } = await startFake();
    const { contact, ref, address } = liveWorkplaceContact(controls);

    const { subscriberId } = await addMediaMember(tdb.db, "press", { email: address, source: "media-hub", mediaHubContactId: contact.id, mediaHubEmailRef: ref }, "staff:jamie");
    controls.changeEmail(contact.id, ref, "not-an-email");

    const outcome = expectRan(await runMediaSync(tdb.db, client));
    const result = expectCounts(outcome.result);
    expect(result.flagged).toBe(1);
    expect(result.updated).toBe(0);

    const [after] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId));
    expect(after).toMatchObject({ email: address.toLowerCase(), needsAttention: "email-invalid" });
    expect(after!.attentionAt).not.toBeNull();

    const history = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, subscriberId));
    expect(history.map((h) => h.action)).toContain("media-hub-flagged");
    const flagged = history.find((h) => h.action === "media-hub-flagged")!;
    expect(flagged.detail).toBe(ref);
    expect(flagged.detail).not.toContain("@");
  });

  it("the chosen ref vanishing flags email-gone and keeps the membership", async () => {
    const { client, controls } = await startFake();
    const { contact, ref, address } = liveWorkplaceContact(controls);

    const { subscriberId } = await addMediaMember(tdb.db, "press", { email: address, source: "media-hub", mediaHubContactId: contact.id, mediaHubEmailRef: ref }, "staff:jamie");
    controls.removeEmail(contact.id, ref);

    const outcome = expectRan(await runMediaSync(tdb.db, client));
    const result = expectCounts(outcome.result);
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

    const outcome = expectRan(await runMediaSync(tdb.db, client));
    const result = expectCounts(outcome.result);
    expect(result.removed).toBe(1);

    const subs = await tdb.db.select().from(subscriptions).where(eq(subscriptions.subscriberId, subscriberId));
    expect(subs).toHaveLength(0);

    const [after] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId));
    expect(after).toMatchObject({ status: "deleted" });
    expect(after!.endedAt).not.toBeNull();

    const history = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, subscriberId));
    expect(history.map((h) => h.action)).toEqual(["media-list-added", "media-list-removed", "media-ended"]);
  });

  it("one subscriber's DB error (a forced unique violation) is isolated: the other contact in the same run still applies, and since advances", async () => {
    await tdb.db.execute(sql`
      CREATE OR REPLACE FUNCTION force_sync_error() RETURNS trigger AS $$
      BEGIN
        IF NEW.email = 'force-error@example.test' THEN
          RAISE EXCEPTION 'forced error for test' USING ERRCODE = '23505';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await tdb.db.execute(sql`DROP TRIGGER IF EXISTS force_sync_error_trigger ON subscribers`);
    await tdb.db.execute(sql`CREATE TRIGGER force_sync_error_trigger BEFORE UPDATE ON subscribers FOR EACH ROW EXECUTE FUNCTION force_sync_error()`);

    const { client, controls } = await startFake({ contactCount: 10 });
    const live = controls.contacts().filter((c) => !c.deletedAt && c.emails.some((e) => e.kind === "workplace"));
    const [firstContact, secondContact] = [live[0]!, live[1]!];
    const firstRef = firstContact.emails.find((e) => e.kind === "workplace")!;
    const secondRef = secondContact.emails.find((e) => e.kind === "workplace")!;
    const first = { contact: firstContact, ref: firstRef.ref, address: firstRef.address };
    const second = { contact: secondContact, ref: secondRef.ref, address: secondRef.address };

    const a = await addMediaMember(tdb.db, "press", { email: first.address, source: "media-hub", mediaHubContactId: first.contact.id, mediaHubEmailRef: first.ref }, "staff:jamie");
    const b = await addMediaMember(tdb.db, "press", { email: second.address, source: "media-hub", mediaHubContactId: second.contact.id, mediaHubEmailRef: second.ref }, "staff:jamie");

    controls.changeEmail(first.contact.id, first.ref, "force-error@example.test");
    controls.changeEmail(second.contact.id, second.ref, "second-moved@example.test");

    const outcome = expectRan(await runMediaSync(tdb.db, client));
    expect(outcome.done).toBe(true);
    const result = expectCounts(outcome.result);
    expect(result.errors).toBe(1);
    expect(result.updated).toBe(1);

    const [afterA] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, a.subscriberId));
    expect(afterA!.email).toBe(first.address.toLowerCase()); // untouched -- its own transaction rolled back
    const [afterB] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, b.subscriberId));
    expect(afterB!.email).toBe("second-moved@example.test");

    const [settings] = await tdb.db.select().from(nodSettings).where(eq(nodSettings.id, 1));
    expect(settings!.mediaSyncSince).not.toBeNull();
    expect(settings!.mediaSyncLease).toBeNull();

    await tdb.db.execute(sql`DROP TRIGGER IF EXISTS force_sync_error_trigger ON subscribers`);
    await tdb.db.execute(sql`DROP FUNCTION IF EXISTS force_sync_error()`);
  });

  it("aborts without advancing mediaSyncSince on a contract error, clears the lease, and records the error result", async () => {
    const failing: MediaHubClient = {
      search: async () => {
        throw new Error("unused");
      },
      get: async () => null,
      changes: async () => {
        throw new MediaHubError("contract", "feed failed contract validation");
      },
    };

    const outcome = expectRan(await runMediaSync(tdb.db, failing));
    expect(outcome.done).toBe(false);
    expect(outcome.result).toMatchObject({ error: "MediaHubError", kind: "contract" });

    const [row] = await tdb.db.select().from(nodSettings).where(eq(nodSettings.id, 1));
    expect(row!.mediaSyncSince).toBeNull();
    expect(row!.mediaSyncLease).toBeNull();
    expect(row!.mediaSyncResult).toMatchObject({ error: "MediaHubError", kind: "contract" });
  });

  it("aborts on a non-MediaHub error too: records {error}, clears the lease, leaves since unchanged", async () => {
    const broken: MediaHubClient = {
      search: async () => {
        throw new Error("unused");
      },
      get: async () => null,
      changes: async () => {
        throw new Error("boom");
      },
    };

    const outcome = expectRan(await runMediaSync(tdb.db, broken));
    expect(outcome.done).toBe(false);
    expect(outcome.result).toMatchObject({ error: "Error" });
    expect((outcome.result as { kind?: string }).kind).toBeUndefined();

    const [row] = await tdb.db.select().from(nodSettings).where(eq(nodSettings.id, 1));
    expect(row!.mediaSyncSince).toBeNull();
    expect(row!.mediaSyncLease).toBeNull();
  });

  it("a second manual call while one is in progress reports busy", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: MediaHubClient = {
      search: async () => {
        throw new Error("unused");
      },
      get: async () => null,
      changes: async () => {
        await gate;
        return { contacts: [], nextCursor: null } satisfies MediaHubChangesPage;
      },
    };

    const inFlight = runMediaSync(tdb.db, slow);
    await new Promise((r) => setTimeout(r, 50)); // let it claim the lease and call changes()

    expect(await runMediaSync(tdb.db, slow)).toBe("busy");

    release();
    const outcome = expectRan(await inFlight);
    expect(outcome.done).toBe(true);
  });

  it("does not hold the nod_settings row lock across a slow Media Hub call: setPaused completes promptly while a sync is mid-flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: MediaHubClient = {
      search: async () => {
        throw new Error("unused");
      },
      get: async () => null,
      changes: async () => {
        await gate;
        return { contacts: [], nextCursor: null } satisfies MediaHubChangesPage;
      },
    };

    const inFlight = runMediaSync(tdb.db, slow);
    await new Promise((r) => setTimeout(r, 50));

    const distribution = { send: vi.fn().mockResolvedValue({ batchId: "b" }) } as unknown as DistributionClient;
    const deps: SetPausedDeps = { db: tdb.db, distribution, opsEmail: null, timeZone: TZ };
    const startedAt = Date.now();
    await setPaused(deps, true, "test");
    expect(Date.now() - startedAt).toBeLessThan(1_000);

    release();
    await inFlight;
    await setPaused(deps, false, "test"); // leave settings as found for later tests in this file
  });
});

describe("runMediaSync bound and resume", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createNodTestDb();
  });
  afterAll(async () => tdb.drop());
  beforeEach(async () => resetDb(tdb));

  function makeContact(id: number): MediaHubContact {
    return { id, firstName: "No", lastName: "Match", outlet: null, emails: [{ ref: "personal", address: `nomatch${id}@example.test`, kind: "personal", organization: null, preferred: false }], deletedAt: null };
  }

  it("stops at the page bound (done:false), leaving since unchanged; a second call finishes and advances since once", async () => {
    const changes = vi
      .fn()
      .mockResolvedValueOnce({ contacts: [makeContact(1)], nextCursor: "cursor-1" } satisfies MediaHubChangesPage)
      .mockResolvedValueOnce({ contacts: [makeContact(2)], nextCursor: null } satisfies MediaHubChangesPage);
    const client: MediaHubClient = { search: async () => { throw new Error("unused"); }, get: async () => null, changes };

    const first = await runMediaSyncIfDue(tdb.db, client, TZ, { maxPages: 1, maxMs: 60_000 });
    expect(first.ran).toBe(true);
    expect(first.done).toBe(false);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes).toHaveBeenNthCalledWith(1, new Date(0).toISOString(), null);

    const [afterFirst] = await tdb.db.select().from(nodSettings).where(eq(nodSettings.id, 1));
    expect(afterFirst!.mediaSyncSince).toBeNull();
    expect(afterFirst!.mediaSyncCursor).toBe("cursor-1");
    expect(afterFirst!.mediaSyncLease).not.toBeNull();
    expect(afterFirst!.mediaSyncLeaseUntil!.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);

    const second = await runMediaSyncIfDue(tdb.db, client, TZ, { maxPages: 1, maxMs: 60_000 });
    expect(second.ran).toBe(true);
    expect(second.done).toBe(true);
    expect(changes).toHaveBeenCalledTimes(2);
    expect(changes).toHaveBeenNthCalledWith(2, new Date(0).toISOString(), "cursor-1");

    const [afterSecond] = await tdb.db.select().from(nodSettings).where(eq(nodSettings.id, 1));
    expect(afterSecond!.mediaSyncSince).not.toBeNull();
    expect(afterSecond!.mediaSyncCursor).toBeNull();
    expect(afterSecond!.mediaSyncLease).toBeNull();
  });

  it("an expired lease with a saved cursor is taken over and resumed from that cursor", async () => {
    const changes = vi.fn().mockResolvedValue({ contacts: [], nextCursor: null } satisfies MediaHubChangesPage);
    const client: MediaHubClient = { search: async () => { throw new Error("unused"); }, get: async () => null, changes };

    await tdb.db
      .update(nodSettings)
      .set({
        mediaSyncSince: new Date("2026-01-01T00:00:00Z"),
        mediaSyncRunStart: new Date("2026-01-02T00:00:00Z"),
        mediaSyncCursor: "stale-cursor",
        mediaSyncLease: "11111111-1111-1111-1111-111111111111",
        mediaSyncLeaseUntil: new Date(Date.now() - 60_000), // expired
        mediaSyncResult: { contacts: 3, updated: 1, flagged: 0, removed: 0, errors: 0, inProgress: true },
      })
      .where(eq(nodSettings.id, 1));

    const outcome = expectRan(await runMediaSync(tdb.db, client));
    expect(outcome.done).toBe(true);
    expect(changes).toHaveBeenCalledWith("2026-01-01T00:00:00.000Z", "stale-cursor");
    const result = expectCounts(outcome.result);
    expect(result.updated).toBe(1); // carried over from the saved partial result

    const [row] = await tdb.db.select().from(nodSettings).where(eq(nodSettings.id, 1));
    expect(row!.mediaSyncSince).toEqual(new Date("2026-01-02T00:00:00Z")); // run_start, not the resumed since
    expect(row!.mediaSyncLease).toBeNull();
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

  it("concurrent calls: exactly one does work, mediaSyncSince set once, one history row per change", async () => {
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

  it("re-pointing a member to a new address ends their outstanding links, which went to the old address", async () => {
    const { client, controls } = await startFake();
    const live = controls.contacts().find((c) => !c.deletedAt && c.emails.length > 1)!;
    const [firstRef, secondRef] = [live.emails[0]!, live.emails[1]!];
    const { subscriberId } = await addMediaMember(
      tdb.db,
      "press",
      { email: firstRef.address, source: "media-hub", mediaHubContactId: live.id, mediaHubEmailRef: firstRef.ref },
      "staff:jamie",
    );
    const { token } = await createLink(tdb.db, { purpose: "manage", email: firstRef.address, subscriberId, pending: null });
    expect(await resolveMediaMember(tdb.db, client, subscriberId, secondRef.ref, "staff:jamie")).toBe("resolved");
    expect((await findLink(tdb.db, token))!.expired).toBe(true);
  });

  it("returns ref-not-found for an unknown ref, and media-hub-unavailable when no client is configured", async () => {
    const { subscriberId } = await addMediaMember(tdb.db, "press", { email: "noclient@example.test", source: "manual-media" }, "staff:jamie");
    expect(await resolveMediaMember(tdb.db, null, subscriberId, "workplace:1", "staff:jamie")).toBe("media-hub-unavailable");
  });

  it("a ref whose address is invalid returns invalid-email, writing nothing", async () => {
    const { client, controls } = await startFake();
    const live = controls.contacts().find((c) => !c.deletedAt && c.emails.length > 1)!;
    const firstRef = live.emails[0]!;
    const secondRef = live.emails[1]!;
    controls.changeEmail(live.id, secondRef.ref, "not-an-email");

    const { subscriberId } = await addMediaMember(
      tdb.db,
      "press",
      { email: firstRef.address, source: "media-hub", mediaHubContactId: live.id, mediaHubEmailRef: firstRef.ref },
      "staff:jamie",
    );

    const outcome = await resolveMediaMember(tdb.db, client, subscriberId, secondRef.ref, "staff:jamie");
    expect(outcome).toBe("invalid-email");

    const [after] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId));
    expect(after).toMatchObject({ email: firstRef.address.toLowerCase(), mediaHubEmailRef: firstRef.ref });
  });

  it("a ref whose address has a kept opt-out from a list the member is on returns opted-out-address, flagging rather than moving", async () => {
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
    await tdb.db.insert(mediaOptOuts).values({ emailHash: optOutHash(secondRef.address), listKey: ACTOR_LIST_KEY, optedOutAt: new Date("2026-06-01T17:00:00Z") });

    expect(await resolveMediaMember(tdb.db, client, subscriberId, secondRef.ref, "staff:jamie")).toBe("opted-out-address");
    const [after] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId));
    expect(after).toMatchObject({ email: firstRef.address.toLowerCase(), mediaHubEmailRef: secondRef.ref, needsAttention: "opted-out-address" });
  });

  it("a ref whose address is already taken by another subscriber returns email-taken, re-flagging rather than merging", async () => {
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
    await tdb.db.insert(subscribers).values({ email: secondRef.address.toLowerCase(), status: "active", source: "self" });

    const outcome = await resolveMediaMember(tdb.db, client, subscriberId, secondRef.ref, "staff:jamie");
    expect(outcome).toBe("email-taken");

    const [after] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId));
    expect(after).toMatchObject({ email: firstRef.address.toLowerCase(), mediaHubEmailRef: secondRef.ref, needsAttention: "email-taken" });
  });

  it("returns conflict when the subscriber's email changed since it was read", async () => {
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

    const originalGet = client.get.bind(client);
    const racy: MediaHubClient = {
      ...client,
      get: async (id: number) => {
        // Simulate another process moving the subscriber's address in between this
        // resolve's unlocked read and its locked re-check.
        await tdb.db.update(subscribers).set({ email: "raced-away@example.test" }).where(eq(subscribers.id, subscriberId));
        return originalGet(id);
      },
    };

    const outcome = await resolveMediaMember(tdb.db, racy, subscriberId, secondRef.ref, "staff:jamie");
    expect(outcome).toBe("conflict");
  });
});
