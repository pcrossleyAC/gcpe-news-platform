import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { eq } from "drizzle-orm";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { TestDatabase } from "@gcpe/db-kit";
import { sampleRelease } from "@gcpe/events/testing";
import { createNodTestDb, envelope, sendEvent } from "../../test/helpers";
import { deliveries, sendJobs, subscribers, subscriptions } from "../db/schema";
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
      handlerOptions: { publicSiteUrl: "https://news.gov.bc.ca", manageUrl: "https://news.gov.bc.ca/manage" },
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

    const jobRows = await tdb.db.select().from(sendJobs).where(eq(sendJobs.releaseKey, "ROUTES-TEST-2"));
    expect(jobRows).toHaveLength(0);
    const deliveryRows = await tdb.db.select().from(deliveries).where(eq(deliveries.releaseKey, "ROUTES-TEST-2"));
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
    app = createApp({
      db: tdb.db,
      auth: { issuer, audience, keys },
      eventSecrets: { nrms: "nrms-secret", core: "core-secret" },
      handlerOptions: { publicSiteUrl: "https://news.gov.bc.ca", manageUrl: "https://news.gov.bc.ca/manage" },
    });

    await addSubscriber(tdb.db, { email: "count-all@example.com", lists: "all" });
    await addSubscriber(tdb.db, { email: "count-health@example.com", lists: ["ministries:health"] });
    await addSubscriber(tdb.db, { email: "count-edu@example.com", lists: ["sectors:education"] });
    const [unverified] = await tdb.db
      .insert(subscribers)
      .values({ email: "count-unverified@example.com", manageToken: randomUUID() })
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

  it("counts only '*' subscribers when lists is empty", async () => {
    const empty = await request(app).get("/api/subscribers/count?lists=").set("authorization", `Bearer ${editor}`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ count: 1 });
  });

  it("400s a list key that doesn't match '<kind>:<key>'", async () => {
    const bad = await request(app).get("/api/subscribers/count?lists=bogus").set("authorization", `Bearer ${editor}`);
    expect(bad.status).toBe(400);
  });

  it("403s a token with neither NoD.Admin nor NRMS.Editor", async () => {
    const forbidden = await request(app).get("/api/subscribers/count?lists=ministries:health").set("authorization", `Bearer ${reader}`);
    expect(forbidden.status).toBe(403);
  });
});
