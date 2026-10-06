import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { TestDatabase } from "@gcpe/db-kit";
import { sampleRelease } from "@gcpe/events/testing";
import { createNodTestDb, envelope, sendEvent } from "../../test/helpers";
import type { DistributionClient, MessageRequest } from "../distribution-client";
import { deliveries, nodSettings, operationsLog, sendJobs, subscribers, subscriptions } from "../db/schema";
import type { MediaHubContact } from "../media-hub/contract";
import type { MediaHubClient } from "../media-hub/client";
import { addMediaMember } from "../media-members";
import { addSubscriber } from "../subscribers";
import { createApp } from "../app";

const issuer = "https://login.microsoftonline.com/t/v2.0";
const audience = "api://nod";

describe("NoD HTTP API", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let admin: string;
  let reader: string;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    const pair = await generateKeyPair("RS256");
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k", alg: "RS256" }] });
    const sign = (roles: string[]) =>
      new SignJWT({ roles })
        .setProtectedHeader({ alg: "RS256", kid: "k" })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject("svc")
        .setExpirationTime("5m")
        .sign(pair.privateKey);
    admin = await sign(["NoD.Admin"]);
    reader = await sign([]);
    app = createApp({
      db: tdb.db,
      auth: { issuer, audience, keys },
      eventSecrets: { nrms: "nrms-secret", core: "core-secret" },
      render: { siteUrl: "https://news.gov.bc.ca", bannerUrl: null },
    });
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("GET /health/live needs no auth", async () => {
    expect((await request(app).get("/health/live")).status).toBe(200);
  });

  it("requires a token, and NoD.Admin role, to add a subscriber", async () => {
    const body = { email: "needs-auth@example.com", lists: "all" };
    expect((await request(app).post("/api/subscribers").send(body)).status).toBe(401);
    expect((await request(app).post("/api/subscribers").set("authorization", `Bearer ${reader}`).send(body)).status).toBe(403);
  });

  it("201s a valid subscriber and 409s the same email again", async () => {
    const created = await request(app)
      .post("/api/subscribers")
      .set("authorization", `Bearer ${admin}`)
      .send({ email: "alex.example@example.com", lists: ["ministries:Health"] });
    expect(created.status).toBe(201);
    expect(typeof created.body.id).toBe("string");

    const dup = await request(app)
      .post("/api/subscribers")
      .set("authorization", `Bearer ${admin}`)
      .send({ email: "Alex.Example@Example.com", lists: "all" });
    expect(dup.status).toBe(409);
  });

  it("dedupes list keys that differ only by casing into a single subscription row", async () => {
    const created = await request(app)
      .post("/api/subscribers")
      .set("authorization", `Bearer ${admin}`)
      .send({ email: "dupe-lists@example.com", lists: ["ministries:Health", "ministries:health"] });
    expect(created.status).toBe(201);

    const rows = await tdb.db.select().from(subscriptions).where(eq(subscriptions.subscriberId, created.body.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.listKey).toBe("ministries:health");
  });

  it("400s an invalid email and an invalid list key", async () => {
    const badEmail = await request(app).post("/api/subscribers").set("authorization", `Bearer ${admin}`).send({ email: "not-an-email", lists: "all" });
    expect(badEmail.status).toBe(400);
    expect(Array.isArray(badEmail.body.issues)).toBe(true);

    const badList = await request(app)
      .post("/api/subscribers")
      .set("authorization", `Bearer ${admin}`)
      .send({ email: "sam.example@example.com", lists: ["bogus"] });
    expect(badList.status).toBe(400);
  });

  it("applies an nrms-signed release.published and ignores the same event core-signed", async () => {
    const release = { ...sampleRelease, key: "ROUTES-TEST-1", publishFlags: { ...sampleRelease.publishFlags, toSubscribers: true } };

    const applied = await sendEvent(app, envelope("nrms", "release.published", release, release.key));
    expect(applied.status).toBe(200);
    expect(applied.body).toEqual({ outcome: "applied" });

    const ignored = await sendEvent(app, envelope("core", "release.published", { ...release, key: "ROUTES-TEST-2" }, "ROUTES-TEST-2"));
    expect(ignored.status).toBe(200);
    expect(ignored.body).toEqual({ outcome: "ignored" });

    const jobRows = await tdb.db.select().from(sendJobs).where(eq(sendJobs.itemKey, "ROUTES-TEST-2"));
    expect(jobRows).toHaveLength(0);
    const deliveryRows = await tdb.db.select().from(deliveries).where(eq(deliveries.itemKey, "ROUTES-TEST-2"));
    expect(deliveryRows).toHaveLength(0);
  });
});

// Its own file-level describe (own db, own app) rather than a case tacked onto "NoD HTTP API"
// above: that describe's db accumulates subscriber fixtures across its own tests (e.g.
// "ministries:health" subscribers from the add-subscriber tests), which would silently
// inflate the counts asserted here if this shared the same database.
describe("GET /api/subscribers/count", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let editor: string;
  let reader: string;
  let subscriberCountService: string;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    const pair = await generateKeyPair("RS256");
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k", alg: "RS256" }] });
    const sign = (roles: string[]) =>
      new SignJWT({ roles })
        .setProtectedHeader({ alg: "RS256", kid: "k" })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject("svc")
        .setExpirationTime("5m")
        .sign(pair.privateKey);
    editor = await sign(["NRMS.Editor"]);
    reader = await sign([]);
    // Fix round 1: NRMS's own service token for this endpoint carries only this dedicated
    // role (apps/nrms/src/start.ts's nodServiceTokenOptions) — never NRMS.Editor.
    subscriberCountService = await sign(["NoD.SubscriberCount"]);
    app = createApp({
      db: tdb.db,
      auth: { issuer, audience, keys },
      eventSecrets: { nrms: "nrms-secret", core: "core-secret" },
      render: { siteUrl: "https://news.gov.bc.ca", bannerUrl: null },
    });

    await addSubscriber(tdb.db, { email: "count-all@example.com", lists: "all" });
    await addSubscriber(tdb.db, { email: "count-health@example.com", lists: ["ministries:health"] });
    await addSubscriber(tdb.db, { email: "count-edu@example.com", lists: ["sectors:education"] });
    const [unverified] = await tdb.db
      .insert(subscribers)
      .values({ email: "count-unverified@example.com" })
      .returning({ id: subscribers.id });
    await tdb.db.insert(subscriptions).values({ subscriberId: unverified!.id, listKey: "ministries:health" });
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("counts verified subscribers on '*' or any of the given list keys, excluding an unverified match", async () => {
    const withLists = await request(app)
      .get("/api/subscribers/count?lists=ministries:health,sectors:health")
      .set("authorization", `Bearer ${editor}`);
    expect(withLists.status).toBe(200);
    expect(withLists.body).toEqual({ count: 2 });
  });

  // Spec "all news" rule (global constraints): '*' only matches when the query carries a
  // ministries: key, same as an item would need one to reach "all news" subscribers. An empty
  // query has no keys at all, so count-all@example.com's '*' subscription doesn't match either
  // — before this rule existed, this asserted `{ count: 1 }`.
  it("counts nobody when lists is empty (no ministries key for '*' to match)", async () => {
    const empty = await request(app).get("/api/subscribers/count?lists=").set("authorization", `Bearer ${editor}`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ count: 0 });
  });

  it("400s a list key that doesn't match '<kind>:<key>'", async () => {
    const bad = await request(app).get("/api/subscribers/count?lists=bogus").set("authorization", `Bearer ${editor}`);
    expect(bad.status).toBe(400);
  });

  it("403s a token with none of NoD.Admin, NRMS.Editor or NoD.SubscriberCount", async () => {
    const forbidden = await request(app).get("/api/subscribers/count?lists=ministries:health").set("authorization", `Bearer ${reader}`);
    expect(forbidden.status).toBe(403);
  });

  it("accepts a token with only the dedicated NoD.SubscriberCount service role", async () => {
    const res = await request(app).get("/api/subscribers/count?lists=ministries:health").set("authorization", `Bearer ${subscriberCountService}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 2 });
  });

  // NRMS's media contact count (WorkflowDeps.countMediaContacts) calls this same route with
  // media-distribution-lists:<key> keys -- previously 400 every time (listKeySchema only allowed
  // ministries|sectors|themes|tags). A member of an active list counts; a member of a list
  // staff has since deactivated does not, matching createMediaSend's own recipient rule.
  it("counts a media-key query, excluding a member of a deactivated list", async () => {
    await tdb.db.execute(sql`
      INSERT INTO lists (list_key, category, key, name, active) VALUES
        ('media-distribution-lists:active-press', 'media-distribution-lists', 'active-press', 'Active Press', true),
        ('media-distribution-lists:inactive-press', 'media-distribution-lists', 'inactive-press', 'Inactive Press', false)
    `);
    await addMediaMember(tdb.db, "active-press", { email: "media-active@example.test", source: "manual-media" }, "staff:jamie");
    await addMediaMember(tdb.db, "inactive-press", { email: "media-inactive@example.test", source: "manual-media" }, "staff:jamie");

    const res = await request(app)
      .get("/api/subscribers/count?lists=media-distribution-lists:active-press,media-distribution-lists:inactive-press")
      .set("authorization", `Bearer ${editor}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 1 });
  });
});

describe("POST /api/emergency-items", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let admin: string;
  let reader: string;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    const pair = await generateKeyPair("RS256");
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k", alg: "RS256" }] });
    const sign = (roles: string[]) =>
      new SignJWT({ roles })
        .setProtectedHeader({ alg: "RS256", kid: "k" })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject("svc")
        .setExpirationTime("5m")
        .sign(pair.privateKey);
    admin = await sign(["NoD.Admin"]);
    reader = await sign([]);
    app = createApp({
      db: tdb.db,
      auth: { issuer, audience, keys },
      eventSecrets: { nrms: "nrms-secret", core: "core-secret" },
      render: { siteUrl: "https://news.gov.bc.ca", bannerUrl: null },
    });
  });
  afterAll(async () => {
    await tdb.drop();
  });

  const body = { guid: "emergency-guid-1", title: "Evacuation order", summary: "Leave the area immediately.", url: "https://news.gov.bc.ca/emergency/1" };

  it("401s without a token, 403s without NoD.Admin", async () => {
    expect((await request(app).post("/api/emergency-items").send(body)).status).toBe(401);
    expect((await request(app).post("/api/emergency-items").set("authorization", `Bearer ${reader}`).send(body)).status).toBe(403);
  });

  it("201s a new guid, then 200s the same guid again with the same key", async () => {
    const created = await request(app).post("/api/emergency-items").set("authorization", `Bearer ${admin}`).send(body);
    expect(created.status).toBe(201);
    expect(typeof created.body.key).toBe("string");

    const again = await request(app).post("/api/emergency-items").set("authorization", `Bearer ${admin}`).send(body);
    expect(again.status).toBe(200);
    expect(again.body.key).toBe(created.body.key);
  });

  it("400s a title over 500 characters and a non-http(s) url", async () => {
    const longTitle = await request(app)
      .post("/api/emergency-items")
      .set("authorization", `Bearer ${admin}`)
      .send({ ...body, guid: "guid-long-title", title: "x".repeat(501) });
    expect(longTitle.status).toBe(400);

    const badUrl = await request(app)
      .post("/api/emergency-items")
      .set("authorization", `Bearer ${admin}`)
      .send({ ...body, guid: "guid-bad-url", url: "ftp://news.gov.bc.ca/1" });
    expect(badUrl.status).toBe(400);
  });

  it("a subscriber on emergency:alerts gets a delivery even if digest-only; a subscriber not on the list gets none", async () => {
    const onList = (await addSubscriber(tdb.db, { email: "alerts-subscriber@example.com", lists: ["emergency:alerts"] })).id;
    // addSubscriber always sets as_it_happens true; flip it to prove emergency sends ignore timing.
    await tdb.db.update(subscribers).set({ asItHappens: false, digest: true }).where(eq(subscribers.id, onList));
    const offList = (await addSubscriber(tdb.db, { email: "not-on-alerts@example.com", lists: "all" })).id;

    const created = await request(app)
      .post("/api/emergency-items")
      .set("authorization", `Bearer ${admin}`)
      .send({ ...body, guid: "guid-recipients-1" });
    expect(created.status).toBe(201);
    const key = created.body.key as string;

    const deliveryRows = await tdb.db.select().from(deliveries).where(eq(deliveries.itemKey, key));
    expect(deliveryRows.map((d) => d.subscriberId)).toEqual([onList]);
    expect(deliveryRows.map((d) => d.subscriberId)).not.toContain(offList);
  });
});

describe("/api/media-lists", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let admin: string;
  let reader: string;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    const pair = await generateKeyPair("RS256");
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k", alg: "RS256" }] });
    const sign = (roles: string[]) =>
      new SignJWT({ roles })
        .setProtectedHeader({ alg: "RS256", kid: "k" })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject("svc")
        .setExpirationTime("5m")
        .sign(pair.privateKey);
    admin = await sign(["NoD.Admin"]);
    reader = await sign([]);
    app = createApp({
      db: tdb.db,
      auth: { issuer, audience, keys },
      eventSecrets: { nrms: "nrms-secret", core: "core-secret" },
      render: { siteUrl: "https://news.gov.bc.ca", bannerUrl: null },
    });
    await tdb.db.execute(sql`INSERT INTO lists (list_key, category, key, name) VALUES ('media-distribution-lists:budget', 'media-distribution-lists', 'budget', 'Budget')`);
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("401s without a token, 403s without NoD.Admin, for all four routes", async () => {
    expect((await request(app).get("/api/media-lists")).status).toBe(401);
    expect((await request(app).get("/api/media-lists").set("authorization", `Bearer ${reader}`)).status).toBe(403);
    expect((await request(app).get("/api/media-lists/budget/members")).status).toBe(401);
    expect((await request(app).get("/api/media-lists/budget/members").set("authorization", `Bearer ${reader}`)).status).toBe(403);
    expect((await request(app).post("/api/media-lists/budget/members").send({ email: "x@example.test" })).status).toBe(401);
    expect((await request(app).post("/api/media-lists/budget/members").set("authorization", `Bearer ${reader}`).send({ email: "x@example.test" })).status).toBe(403);
    expect((await request(app).delete("/api/media-lists/budget/members/00000000-0000-0000-0000-000000000000")).status).toBe(401);
    expect((await request(app).delete("/api/media-lists/budget/members/00000000-0000-0000-0000-000000000000").set("authorization", `Bearer ${reader}`)).status).toBe(403);
  });

  it("401s without a token, 403s without NoD.Admin, for the sync status/trigger and resolve routes", async () => {
    expect((await request(app).get("/api/media-hub/sync")).status).toBe(401);
    expect((await request(app).get("/api/media-hub/sync").set("authorization", `Bearer ${reader}`)).status).toBe(403);
    expect((await request(app).post("/api/media-hub/sync")).status).toBe(401);
    expect((await request(app).post("/api/media-hub/sync").set("authorization", `Bearer ${reader}`)).status).toBe(403);
    expect((await request(app).post("/api/media-members/00000000-0000-0000-0000-000000000000/resolve")).status).toBe(401);
    expect(
      (await request(app).post("/api/media-members/00000000-0000-0000-0000-000000000000/resolve").set("authorization", `Bearer ${reader}`)).status,
    ).toBe(403);
  });

  it("GET /api/media-lists lists media lists with live member counts", async () => {
    await addMediaMember(tdb.db, "budget", { email: "list-member@example.com", source: "manual-media" }, "test");
    const res = await request(app).get("/api/media-lists").set("authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ listKey: "media-distribution-lists:budget", key: "budget", name: "Budget", active: true, members: 1 }]);
  });

  it("GET /api/media-lists/:key/members 404s for an unknown media list", async () => {
    const res = await request(app).get("/api/media-lists/nope/members").set("authorization", `Bearer ${admin}`);
    expect(res.status).toBe(404);
  });

  it("GET /api/media-lists/:key/members lists the members", async () => {
    const { subscriberId } = await addMediaMember(tdb.db, "budget", { email: "shown@example.com", source: "manual-media" }, "test");
    const res = await request(app).get("/api/media-lists/budget/members").set("authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body).toContainEqual({ subscriberId, email: "shown@example.com", source: "manual-media", mediaHubContactId: null, needsAttention: null });
  });

  it("POST /api/media-lists/:key/members creates (201) then is idempotent (200); 404s an unknown list", async () => {
    const created = await request(app).post("/api/media-lists/budget/members").set("authorization", `Bearer ${admin}`).send({ email: "post-member@example.com" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ created: true });

    const again = await request(app).post("/api/media-lists/budget/members").set("authorization", `Bearer ${admin}`).send({ email: "post-member@example.com" });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: false, subscriberId: created.body.subscriberId });

    const unknown = await request(app).post("/api/media-lists/nope/members").set("authorization", `Bearer ${admin}`).send({ email: "x@example.com" });
    expect(unknown.status).toBe(404);

    const badEmail = await request(app).post("/api/media-lists/budget/members").set("authorization", `Bearer ${admin}`).send({ email: "not-an-email" });
    expect(badEmail.status).toBe(400);
  });

  it("POST /api/media-lists/:key/members 409s an opted-out address without confirmOptOut, then 200s with it", async () => {
    const { subscriberId } = await addMediaMember(tdb.db, "budget", { email: "optout@example.com", source: "manual-media" }, "test");
    await tdb.db.update(subscribers).set({ status: "deleted", endedAt: sql`now()` }).where(eq(subscribers.id, subscriberId));
    await tdb.db.execute(sql`INSERT INTO subscriber_history (subscriber_id, actor, action) VALUES (${subscriberId}, 'subscriber', 'unsubscribed')`);

    const refused = await request(app).post("/api/media-lists/budget/members").set("authorization", `Bearer ${admin}`).send({ email: "optout@example.com" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("opted-out");
    expect(typeof refused.body.at).toBe("string");

    const confirmed = await request(app)
      .post("/api/media-lists/budget/members")
      .set("authorization", `Bearer ${admin}`)
      .send({ email: "optout@example.com", confirmOptOut: true });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.subscriberId).toBe(subscriberId);
  });

  it("DELETE /api/media-lists/:key/members/:subscriberId removes the member (204)", async () => {
    const { subscriberId } = await addMediaMember(tdb.db, "budget", { email: "delete-me@example.com", source: "manual-media" }, "test");
    const res = await request(app).delete(`/api/media-lists/budget/members/${subscriberId}`).set("authorization", `Bearer ${admin}`);
    expect(res.status).toBe(204);
    const members = await tdb.db.select().from(subscriptions).where(eq(subscriptions.subscriberId, subscriberId));
    expect(members).toHaveLength(0);
  });
});

const sampleHubContact: MediaHubContact = {
  id: 42,
  firstName: "Sam",
  lastName: "Lee",
  outlet: "Capital Ledger",
  emails: [
    { ref: "personal", address: "sam.lee.42@example.test", kind: "personal", organization: null, preferred: false },
    { ref: "workplace:1", address: "sam.1@capitalledger.example.test", kind: "workplace", organization: "Capital Ledger", preferred: true },
  ],
  deletedAt: null,
};

const deletedHubContact: MediaHubContact = {
  id: 43,
  firstName: "Robin",
  lastName: "Shaw",
  outlet: "Pacific Wire News",
  emails: [{ ref: "personal", address: "robin.shaw.43@example.test", kind: "personal", organization: null, preferred: false }],
  deletedAt: "2026-01-01T00:00:00.000Z",
};

const badEmailHubContact: MediaHubContact = {
  id: 44,
  firstName: "Jess",
  lastName: "Okafor",
  outlet: null,
  emails: [{ ref: "personal", address: "not-an-email", kind: "personal", organization: null, preferred: false }],
  deletedAt: null,
};

const resolveHubContact: MediaHubContact = {
  id: 45,
  firstName: "Casey",
  lastName: "Nolan",
  outlet: "Riverbend Times",
  emails: [
    { ref: "personal", address: "casey.nolan.45@example.test", kind: "personal", organization: null, preferred: false },
    { ref: "workplace:1", address: "casey.1@riverbend.example.test", kind: "workplace", organization: "Riverbend Times", preferred: true },
  ],
  deletedAt: null,
};

const collideHubContact: MediaHubContact = {
  id: 46,
  firstName: "Drew",
  lastName: "Tanaka",
  outlet: null,
  emails: [
    { ref: "personal", address: "drew.tanaka.46@example.test", kind: "personal", organization: null, preferred: false },
    // Deliberately the same address as resolveHubContact's workplace:1, already claimed by
    // an earlier test -- used to prove a resolve re-point onto an address someone else
    // already has 409s instead of merging.
    { ref: "workplace:1", address: "casey.1@riverbend.example.test", kind: "workplace", organization: "Riverbend Times", preferred: true },
  ],
  deletedAt: null,
};

describe("media-lists Media Hub integration (search proxy, add-from-hub)", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let admin: string;
  let mediaHub: MediaHubClient & { search: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; changes: ReturnType<typeof vi.fn> };

  beforeAll(async () => {
    tdb = await createNodTestDb();
    const pair = await generateKeyPair("RS256");
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k", alg: "RS256" }] });
    admin = await new SignJWT({ roles: ["NoD.Admin"] })
      .setProtectedHeader({ alg: "RS256", kid: "k" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("svc")
      .setExpirationTime("5m")
      .sign(pair.privateKey);
    const byId = new Map([sampleHubContact, deletedHubContact, badEmailHubContact, resolveHubContact, collideHubContact].map((c) => [c.id, c]));
    mediaHub = {
      search: vi.fn().mockResolvedValue({ contacts: [sampleHubContact], page: 1, pageSize: 25, total: 1 }),
      get: vi.fn(async (id: number) => byId.get(id) ?? null),
      changes: vi.fn(),
    } as unknown as MediaHubClient & { search: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn>; changes: ReturnType<typeof vi.fn> };
    app = createApp({
      db: tdb.db,
      auth: { issuer, audience, keys },
      eventSecrets: { nrms: "nrms-secret", core: "core-secret" },
      render: { siteUrl: "https://news.gov.bc.ca", bannerUrl: null },
      mediaHub,
    });
    await tdb.db.execute(sql`INSERT INTO lists (list_key, category, key, name) VALUES ('media-distribution-lists:hub', 'media-distribution-lists', 'hub', 'Hub List')`);
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("GET /api/media-hub/contacts proxies search with a fixed pageSize of 25", async () => {
    const res = await request(app).get("/api/media-hub/contacts").query({ q: "Sam", page: 1 }).set("authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(mediaHub.search).toHaveBeenCalledWith("Sam", 1, 25);
    expect(res.body.contacts).toEqual([sampleHubContact]);
  });

  it("POST /api/media-lists/:key/members with mediaHubContactId stores the contact id/ref and uses that email's address", async () => {
    const res = await request(app)
      .post("/api/media-lists/hub/members")
      .set("authorization", `Bearer ${admin}`)
      .send({ mediaHubContactId: sampleHubContact.id, emailRef: "workplace:1" });
    expect(res.status).toBe(201);

    const [row] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, res.body.subscriberId));
    expect(row).toMatchObject({
      email: "sam.1@capitalledger.example.test",
      source: "media-hub",
      mediaHubContactId: sampleHubContact.id,
      mediaHubEmailRef: "workplace:1",
    });
  });

  it("POST /api/media-lists/:key/members 404s an unknown emailRef, and 404s an unknown/deleted contact", async () => {
    const badRef = await request(app)
      .post("/api/media-lists/hub/members")
      .set("authorization", `Bearer ${admin}`)
      .send({ mediaHubContactId: sampleHubContact.id, emailRef: "workplace:9" });
    expect(badRef.status).toBe(404);

    const unknownContact = await request(app)
      .post("/api/media-lists/hub/members")
      .set("authorization", `Bearer ${admin}`)
      .send({ mediaHubContactId: 999999, emailRef: "personal" });
    expect(unknownContact.status).toBe(404);
  });

  it("POST /api/media-lists/:key/members 404s a soft-deleted contact, creating nothing", async () => {
    const res = await request(app)
      .post("/api/media-lists/hub/members")
      .set("authorization", `Bearer ${admin}`)
      .send({ mediaHubContactId: deletedHubContact.id, emailRef: "personal" });
    expect(res.status).toBe(404);

    const rows = await tdb.db.select().from(subscribers).where(eq(subscribers.email, deletedHubContact.emails[0]!.address));
    expect(rows).toHaveLength(0);
  });

  it("POST /api/media-lists/:key/members 400s when the chosen Media Hub address isn't a valid email, same status as a manual add's bad email", async () => {
    const res = await request(app)
      .post("/api/media-lists/hub/members")
      .set("authorization", `Bearer ${admin}`)
      .send({ mediaHubContactId: badEmailHubContact.id, emailRef: "personal" });
    expect(res.status).toBe(400);

    const rows = await tdb.db.select().from(subscribers).where(eq(subscribers.email, badEmailHubContact.emails[0]!.address));
    expect(rows).toHaveLength(0);
  });

  it("POST then GET /api/media-hub/sync runs a sync now and reports its result", async () => {
    mediaHub.changes.mockResolvedValue({ contacts: [], nextCursor: null });

    const posted = await request(app).post("/api/media-hub/sync").set("authorization", `Bearer ${admin}`);
    expect(posted.status).toBe(200);
    expect(posted.body).toEqual({ done: true, result: { contacts: 0, updated: 0, flagged: 0, removed: 0, errors: 0 } });

    const got = await request(app).get("/api/media-hub/sync").set("authorization", `Bearer ${admin}`);
    expect(got.status).toBe(200);
    expect(got.body.result).toEqual({ contacts: 0, updated: 0, flagged: 0, removed: 0, errors: 0 });
    expect(typeof got.body.since).toBe("string");
    expect(typeof got.body.at).toBe("string");
    expect(got.body.running).toBe(false);
  });

  it("POST /api/media-hub/sync 409s while one is already in progress", async () => {
    // Deterministic rather than racing two real HTTP requests against each other (flaky under
    // load): the route's own "busy" behaviour is just "claimOrResume saw an active lease",
    // which is exercised directly (and reliably) by sync.test.ts; here it's enough to put that
    // state in the DB by hand and check the route maps it to 409.
    await tdb.db
      .update(nodSettings)
      .set({ mediaSyncLease: "22222222-2222-2222-2222-222222222222", mediaSyncLeaseUntil: new Date(Date.now() + 60_000) })
      .where(eq(nodSettings.id, 1));

    const busy = await request(app).post("/api/media-hub/sync").set("authorization", `Bearer ${admin}`);
    expect(busy.status).toBe(409);
    expect(busy.body).toEqual({ error: "sync in progress" });

    await tdb.db.update(nodSettings).set({ mediaSyncLease: null, mediaSyncLeaseUntil: null }).where(eq(nodSettings.id, 1));
  });

  it("POST /api/media-members/:subscriberId/resolve re-points to a new ref and clears the flag", async () => {
    const { subscriberId } = await request(app)
      .post("/api/media-lists/hub/members")
      .set("authorization", `Bearer ${admin}`)
      .send({ mediaHubContactId: resolveHubContact.id, emailRef: "personal" })
      .then((r) => r.body as { subscriberId: string });
    await tdb.db.update(subscribers).set({ needsAttention: "email-gone", attentionAt: sql`now()` }).where(eq(subscribers.id, subscriberId));

    const resolved = await request(app)
      .post(`/api/media-members/${subscriberId}/resolve`)
      .set("authorization", `Bearer ${admin}`)
      .send({ emailRef: "workplace:1" });
    expect(resolved.status).toBe(200);

    const [row] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId));
    expect(row).toMatchObject({ email: "casey.1@riverbend.example.test", mediaHubEmailRef: "workplace:1", needsAttention: null });
  });

  it("POST /api/media-members/:subscriberId/resolve 404s an unknown subscriber", async () => {
    const res = await request(app)
      .post("/api/media-members/00000000-0000-0000-0000-000000000000/resolve")
      .set("authorization", `Bearer ${admin}`)
      .send({});
    expect(res.status).toBe(404);
  });

  it("POST /api/media-members/:subscriberId/resolve 400s an invalid address, same status as a manual add's bad email", async () => {
    const { subscriberId } = await request(app)
      .post("/api/media-lists/hub/members")
      .set("authorization", `Bearer ${admin}`)
      .send({ mediaHubContactId: resolveHubContact.id, emailRef: "personal" })
      .then((r) => r.body as { subscriberId: string });
    // Points this subscriber at badEmailHubContact (whose only ref's address is invalid) under
    // a ref name that isn't its own, as if an earlier resolve or sync had already set it up --
    // what matters for this test is only that the ref the resolve call asks for, "personal",
    // resolves (via mediaHub.get) to that contact's invalid address.
    await tdb.db.update(subscribers).set({ mediaHubContactId: badEmailHubContact.id, mediaHubEmailRef: "some-other-ref" }).where(eq(subscribers.id, subscriberId));

    const res = await request(app)
      .post(`/api/media-members/${subscriberId}/resolve`)
      .set("authorization", `Bearer ${admin}`)
      .send({ emailRef: "personal" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid email" });

    const [row] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId));
    expect(row).toMatchObject({ mediaHubEmailRef: "some-other-ref" });
  });

  it("POST /api/media-members/:subscriberId/resolve 409s email-taken when the new ref's address already belongs to someone else", async () => {
    const { subscriberId } = await request(app)
      .post("/api/media-lists/hub/members")
      .set("authorization", `Bearer ${admin}`)
      .send({ mediaHubContactId: collideHubContact.id, emailRef: "personal" })
      .then((r) => r.body as { subscriberId: string });

    const res = await request(app)
      .post(`/api/media-members/${subscriberId}/resolve`)
      .set("authorization", `Bearer ${admin}`)
      .send({ emailRef: "workplace:1" }); // casey.1@riverbend.example.test -- already taken (earlier test)
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "email-taken" });

    const [row] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, subscriberId));
    expect(row).toMatchObject({ email: collideHubContact.emails[0]!.address, needsAttention: "email-taken" });
  });
});

describe("media-lists with no Media Hub configured (MEDIA_HUB_URL unset)", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let admin: string;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    const pair = await generateKeyPair("RS256");
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k", alg: "RS256" }] });
    admin = await new SignJWT({ roles: ["NoD.Admin"] })
      .setProtectedHeader({ alg: "RS256", kid: "k" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("svc")
      .setExpirationTime("5m")
      .sign(pair.privateKey);
    // mediaHub omitted entirely -- createApp defaults it to null, same as start.ts does when
    // MEDIA_HUB_URL is unset.
    app = createApp({
      db: tdb.db,
      auth: { issuer, audience, keys },
      eventSecrets: { nrms: "nrms-secret", core: "core-secret" },
      render: { siteUrl: "https://news.gov.bc.ca", bannerUrl: null },
    });
    await tdb.db.execute(sql`INSERT INTO lists (list_key, category, key, name) VALUES ('media-distribution-lists:nohub', 'media-distribution-lists', 'nohub', 'No Hub List')`);
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("503s the search proxy and add-from-hub, while manual add still works", async () => {
    const search = await request(app).get("/api/media-hub/contacts").query({ q: "x" }).set("authorization", `Bearer ${admin}`);
    expect(search.status).toBe(503);
    expect(search.body).toEqual({ error: "media hub not configured" });

    const fromHub = await request(app)
      .post("/api/media-lists/nohub/members")
      .set("authorization", `Bearer ${admin}`)
      .send({ mediaHubContactId: 1, emailRef: "personal" });
    expect(fromHub.status).toBe(503);
    expect(fromHub.body).toEqual({ error: "media hub not configured" });

    const manual = await request(app)
      .post("/api/media-lists/nohub/members")
      .set("authorization", `Bearer ${admin}`)
      .send({ email: "manual-still-works@example.com" });
    expect(manual.status).toBe(201);
  });
});

describe("GET /api/settings, POST /api/settings/pause|resume", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let distribution: DistributionClient & { send: ReturnType<typeof vi.fn> };
  let admin: string;
  let reader: string;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    const pair = await generateKeyPair("RS256");
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k", alg: "RS256" }] });
    const sign = (roles: string[], claims: Record<string, unknown> = {}) =>
      new SignJWT({ roles, ...claims })
        .setProtectedHeader({ alg: "RS256", kid: "k" })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject("svc")
        .setExpirationTime("5m")
        .sign(pair.privateKey);
    admin = await sign(["NoD.Admin"], { name: "Jamie Admin" });
    reader = await sign([]);
    distribution = { send: vi.fn().mockResolvedValue({ batchId: "batch-ops" }) } as unknown as DistributionClient & { send: ReturnType<typeof vi.fn> };
    app = createApp({
      db: tdb.db,
      auth: { issuer, audience, keys },
      eventSecrets: { nrms: "nrms-secret", core: "core-secret" },
      render: { siteUrl: "https://news.gov.bc.ca", bannerUrl: null },
      distribution,
      opsEmail: "ops@example.com",
      timeZone: "America/Vancouver",
    });
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("401s without a token, 403s without NoD.Admin, for all three routes", async () => {
    expect((await request(app).get("/api/settings")).status).toBe(401);
    expect((await request(app).get("/api/settings").set("authorization", `Bearer ${reader}`)).status).toBe(403);
    expect((await request(app).post("/api/settings/pause")).status).toBe(401);
    expect((await request(app).post("/api/settings/pause").set("authorization", `Bearer ${reader}`)).status).toBe(403);
    expect((await request(app).post("/api/settings/resume")).status).toBe(401);
    expect((await request(app).post("/api/settings/resume").set("authorization", `Bearer ${reader}`)).status).toBe(403);
  });

  it("GET /api/settings returns the current paused/lastDigestCutoff shape", async () => {
    const res = await request(app).get("/api/settings").set("authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ paused: false, lastDigestCutoff: null });
  });

  it("pauses, then resumes, logging the bearer's name claim as actor and emailing ops each time", async () => {
    const pause = await request(app).post("/api/settings/pause").set("authorization", `Bearer ${admin}`);
    expect(pause.status).toBe(200);
    expect(pause.body).toEqual({ paused: true, changed: true });

    const [settingsRow] = await tdb.db.select().from(nodSettings);
    expect(settingsRow!.paused).toBe(true);
    const logRows = await tdb.db.select().from(operationsLog);
    expect(logRows).toHaveLength(1);
    expect(logRows[0]!).toMatchObject({ actor: "Jamie Admin", action: "paused" });
    expect(distribution.send).toHaveBeenCalledTimes(1);
    expect((distribution.send.mock.calls[0]![0] as MessageRequest).subject).toBe("BC Gov News On Demand sending paused");

    // A repeat pause changes nothing (same route, same effect as settings.test.ts's direct call).
    const pauseAgain = await request(app).post("/api/settings/pause").set("authorization", `Bearer ${admin}`);
    expect(pauseAgain.body).toEqual({ paused: true, changed: false });
    expect(distribution.send).toHaveBeenCalledTimes(1);

    const resume = await request(app).post("/api/settings/resume").set("authorization", `Bearer ${admin}`);
    expect(resume.status).toBe(200);
    expect(resume.body).toEqual({ paused: false, changed: true });
    expect(distribution.send).toHaveBeenCalledTimes(2);
    expect((distribution.send.mock.calls[1]![0] as MessageRequest).subject).toBe("BC Gov News On Demand sending resumed");

    const settingsAfter = await request(app).get("/api/settings").set("authorization", `Bearer ${admin}`);
    expect(settingsAfter.body).toEqual({ paused: false, lastDigestCutoff: null });
  });
});
