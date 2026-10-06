import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { hashPassword, verifyPassword } from "@gcpe/auth";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../../test/helpers";
import { createApp } from "../app";
import { subscribers, subscriptions } from "../db/schema";

const USERNAME = "media-hub";
const PASSWORD = "a correct password 123";
const ROUTE = "/Subscribe/SubscriberInformation";

const basicAuth = (username: string, password: string) => `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

function buildApp(tdb: TestDatabase, membership: { username: string; passwordHash: string } | null): Express {
  return createApp({
    db: tdb.db,
    auth: {},
    eventSecrets: {},
    render: { siteUrl: "https://news.example/site", bannerUrl: null },
    membership,
  });
}

describe("legacy Subscribe/SubscriberInformation (C55)", () => {
  let tdb: TestDatabase;
  let app: Express;
  let passwordHash: string;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    passwordHash = await hashPassword(PASSWORD);
    app = buildApp(tdb, { username: USERNAME, passwordHash });

    const [member] = await tdb.db
      .insert(subscribers)
      .values({ email: "journo@example.test", status: "active", source: "self", asItHappens: true, digest: false })
      .returning();
    await tdb.db.insert(subscriptions).values([
      { subscriberId: member!.id, listKey: "media-distribution-lists:001-a-daily" },
      { subscriberId: member!.id, listKey: "tags:x" },
    ]);

    const [plusMember] = await tdb.db
      .insert(subscribers)
      .values({ email: "jane+media@example.test", status: "disabled", source: "media-hub", asItHappens: false, digest: true })
      .returning();
    await tdb.db.insert(subscriptions).values([{ subscriberId: plusMember!.id, listKey: "media-distribution-lists:000-0-victoria" }]);
  });
  afterAll(async () => tdb.drop());

  it("200s with the subscriber's categories (media lists included) under PascalCase keys", async () => {
    const res = await request(app).get(`${ROUTE}?emailAddress=journo@example.test`).set("authorization", basicAuth(USERNAME, PASSWORD));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      EmailAddress: "journo@example.test",
      SubscribedCategories: { "media-distribution-lists": ["001-a-daily"], tags: ["x"] },
      IsAllNews: false,
      IsAsItHappens: true,
      IsDailyDigest: false,
      IsAdminRegistration: false,
      NotifyIfNewCategories: false,
      ExpiredLinkOrUnverifiedEmail: false,
    });
  });

  it("the media list key satisfies Media Hub's own parser (/^(\\d{3})-(\\d|[a-z])-(.+)$/)", async () => {
    const res = await request(app).get(`${ROUTE}?emailAddress=journo@example.test`).set("authorization", basicAuth(USERNAME, PASSWORD));
    const [key] = res.body.SubscribedCategories["media-distribution-lists"];
    expect(key).toMatch(/^(\d{3})-(\d|[a-z])-(.+)$/);
  });

  it("a disabled subscriber still counts, and an address with a literal '+' round-trips through encodeURIComponent and the DB lookup", async () => {
    const email = "jane+media@example.test";
    const res = await request(app).get(`${ROUTE}?emailAddress=${encodeURIComponent(email)}`).set("authorization", basicAuth(USERNAME, PASSWORD));
    expect(res.status).toBe(200);
    expect(res.body.EmailAddress).toBe(email);
    expect(res.body.SubscribedCategories).toEqual({ "media-distribution-lists": ["000-0-victoria"] });
    expect(res.body.IsAdminRegistration).toBe(true); // source: "media-hub" !== "self"
  });

  it("200s with empty categories and every flag false for an email with no subscriber", async () => {
    const res = await request(app).get(`${ROUTE}?emailAddress=unknown@example.test`).set("authorization", basicAuth(USERNAME, PASSWORD));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      EmailAddress: "unknown@example.test",
      SubscribedCategories: {},
      IsAllNews: false,
      IsAsItHappens: false,
      IsDailyDigest: false,
      IsAdminRegistration: false,
      NotifyIfNewCategories: false,
      ExpiredLinkOrUnverifiedEmail: false,
    });
  });

  it("a pending (unverified) subscriber reads exactly like an unknown email -- only active/disabled count", async () => {
    await tdb.db.insert(subscribers).values({ email: "pending@example.test", status: "pending", source: "self" });
    const res = await request(app).get(`${ROUTE}?emailAddress=pending@example.test`).set("authorization", basicAuth(USERNAME, PASSWORD));
    expect(res.status).toBe(200);
    expect(res.body.SubscribedCategories).toEqual({});
  });

  it("401s with WWW-Authenticate on a wrong password, and never names the actual address", async () => {
    const res = await request(app).get(`${ROUTE}?emailAddress=journo@example.test`).set("authorization", basicAuth(USERNAME, "wrong password"));
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toBe('Basic realm="NoD"');
    expect(res.body).toEqual({ error: "unauthorized" });
  });

  it("401s with no Authorization header at all", async () => {
    const res = await request(app).get(`${ROUTE}?emailAddress=journo@example.test`);
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toBe('Basic realm="NoD"');
  });

  it("400s on a missing or invalid emailAddress, once authenticated", async () => {
    const missing = await request(app).get(ROUTE).set("authorization", basicAuth(USERNAME, PASSWORD));
    expect(missing.status).toBe(400);
    const invalid = await request(app).get(`${ROUTE}?emailAddress=not-an-email`).set("authorization", basicAuth(USERNAME, PASSWORD));
    expect(invalid.status).toBe(400);
  });

  it("503s when the endpoint isn't configured, without ever looking at credentials", async () => {
    const unconfigured = buildApp(tdb, null);
    const res = await request(unconfigured).get(`${ROUTE}?emailAddress=journo@example.test`);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "membership endpoint not configured" });
  });

  it("rate-limits failed auth at 10/minute per IP; the 11th bad attempt in that minute is 429", async () => {
    // A fresh app -> a fresh in-memory rate-limit store, so this test's count is never polluted
    // by the other 401s above sharing the same bucket.
    const limited = buildApp(tdb, { username: USERNAME, passwordHash });
    let last;
    for (let i = 0; i < 10; i++) {
      last = await request(limited).get(`${ROUTE}?emailAddress=journo@example.test`).set("authorization", basicAuth(USERNAME, "wrong password"));
      expect(last.status).toBe(401);
    }
    const eleventh = await request(limited).get(`${ROUTE}?emailAddress=journo@example.test`).set("authorization", basicAuth(USERNAME, "wrong password"));
    expect(eleventh.status).toBe(429);
  });

  it("a successful lookup never counts against the failed-auth rate limit", async () => {
    const limited = buildApp(tdb, { username: USERNAME, passwordHash });
    for (let i = 0; i < 15; i++) {
      const res = await request(limited).get(`${ROUTE}?emailAddress=journo@example.test`).set("authorization", basicAuth(USERNAME, PASSWORD));
      expect(res.status).toBe(200);
    }
  });

  it("the hash script's format (hashPassword's output) round-trips through verifyPassword", async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword("wrong password", hash)).toBe(false);
  });
});
