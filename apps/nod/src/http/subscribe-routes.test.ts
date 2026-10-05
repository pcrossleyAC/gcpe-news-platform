import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../../test/helpers";
import { createApp } from "../app";
import type { JourneyDeps } from "../subscribe/journeys";

const issuer = "https://login.microsoftonline.com/t/v2.0";
const audience = "api://nod";
const SECRET = "k".repeat(32);

describe("NoD Subscribe API HTTP routes", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let svc: string;
  let reader: string;
  const sent: { to: string; subject: string; text: string }[] = [];
  const tokenFrom = (i = sent.length - 1) => new URL(sent[i]!.text.match(/https:\S+/)![0]).searchParams.get("token")!;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    await tdb.db.execute(sql`INSERT INTO lists (list_key, category, key, name) VALUES ('ministries:health','ministries','health','Health')`);
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
    svc = await sign(["NoD.SubscribeApi"]);
    reader = await sign([]);

    const deps: JourneyDeps = {
      db: tdb.db,
      pageUrl: "https://boxs.ca/site/subscribe/manage/",
      linkSecret: SECRET,
      distribution: { send: vi.fn(async (m) => { sent.push({ to: m.recipients[0].email, subject: m.subject, text: m.text }); return { batchId: "b" }; }) },
    };

    app = createApp({
      db: tdb.db,
      auth: { issuer, audience, keys },
      eventSecrets: { nrms: "nrms-secret", core: "core-secret" },
      handlerOptions: { publicSiteUrl: "https://news.gov.bc.ca", manageUrl: "https://news.gov.bc.ca/manage" },
      subscribe: deps,
    });
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("needs the subscribe service role", async () => {
    expect((await request(app).get("/api/Subscribe/SubscriptionItems/ministries")).status).toBe(401);
    expect((await request(app).get("/api/Subscribe/SubscriptionItems/ministries").set("authorization", `Bearer ${reader}`)).status).toBe(403);
    expect((await request(app).get("/api/Subscribe/SubscriptionItems/ministries").set("authorization", `Bearer ${svc}`)).status).toBe(200);
  });

  it("runs the whole journey over HTTP with legacy shapes", async () => {
    const auth = { authorization: `Bearer ${svc}` };
    const items = await request(app).get("/api/Subscribe/SubscriptionItems/ministries").set(auth);
    expect(items.body).toEqual([{ key: "health", value: "Health" }]);

    const created = await request(app).post("/api/Subscribe/CreateNewsOnDemandEmailSubscriptionWithPreferences").set(auth)
      .send({ emailAddress: "web@example.test", subscribedCategories: { ministries: ["health"] }, isAllNews: false, isAsItHappens: true, isDailyDigest: false });
    expect(created.status).toBe(204);
    const token = tokenFrom();

    expect((await request(app).get(`/api/Subscribe/CheckEmailActivationToken/${token}`).set(auth)).body).toBe(true);
    const confirmed = await request(app).get(`/api/Subscribe/ConfirmUpdateCreateSubscription/${token}`).set(auth);
    expect(confirmed.body).toMatchObject({ emailAddress: "web@example.test", isAsItHappens: true });

    const updated = await request(app).post(`/api/Subscribe/UpdateNewsOnDemandEmailSubscriptionWithPreferences/${token}`).set(auth)
      .send({ emailAddress: "web@example.test", isAllNews: true, isAsItHappens: false, isDailyDigest: true });
    expect(updated.status).toBe(204);

    expect((await request(app).get(`/api/Subscribe/UnsubscribeSubscriber/${token}`).set(auth)).body).toBe(true);
  });

  it("answers Manage identically for known, unknown and malformed addresses", async () => {
    const auth = { authorization: `Bearer ${svc}` };
    const a = await request(app).get("/api/Subscribe/ManageNewsOnDemandEmailSubscription/web@example.test").set(auth);
    const b = await request(app).get("/api/Subscribe/ManageNewsOnDemandEmailSubscription/nobody@example.test").set(auth);
    const c = await request(app).get("/api/Subscribe/ManageNewsOnDemandEmailSubscription/not-an-email").set(auth);
    expect([a.status, b.status, c.status]).toEqual([204, 204, 204]);
  });

  it("Update with an unknown token is a 404, a bad body a 400, and Confirm of an unknown token is null", async () => {
    const auth = { authorization: `Bearer ${svc}` };
    expect((await request(app).post("/api/Subscribe/UpdateNewsOnDemandEmailSubscriptionWithPreferences/web@example.test").set(auth).send({ emailAddress: "web@example.test", isAllNews: true, isAsItHappens: true })).status).toBe(404);
    expect((await request(app).post("/api/Subscribe/CreateNewsOnDemandEmailSubscriptionWithPreferences").set(auth).send({ emailAddress: "x" })).status).toBe(400);
    const c = await request(app).get("/api/Subscribe/ConfirmUpdateCreateSubscription/nope").set(auth);
    expect(c.status).toBe(200);
    expect(c.body).toBeNull();
  });

  it("one-click unsubscribe accepts the RFC 8058 form body", async () => {
    const res = await request(app).post("/api/Subscribe/OneClickUnsubscribe/whatever").set({ authorization: `Bearer ${svc}` })
      .type("form").send("List-Unsubscribe=One-Click");
    expect(res.status).toBe(200);
    expect(res.body).toBe(true);
  });
});
