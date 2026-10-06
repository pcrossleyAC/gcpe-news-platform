import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { TestDatabase } from "@gcpe/db-kit";
import { sampleRelease } from "@gcpe/events/testing";
import { createNodTestDb, envelope, sendEvent } from "../../test/helpers";
import type { DistributionClient, MessageRequest } from "../distribution-client";
import { deliveries, nodSettings, operationsLog, sendJobs, subscribers, subscriptions } from "../db/schema";
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
