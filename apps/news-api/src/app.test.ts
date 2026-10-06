import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createApp } from "./app";
import { createNewsTestDb, EVENT_SECRETS, TZ } from "../test/helpers";

describe("app-level error handling", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    tdb = await createNewsTestDb();
    app = createApp({
      db: tdb.db,
      timeZone: TZ,
      eventSecrets: EVENT_SECRETS,
      subscribe: { baseUrl: "http://127.0.0.1:1", rateLimitPerMinute: 100 },
    });
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("returns 413 JSON (not 500) for a body over the 100kb limit", async () => {
    const res = await request(app)
      .post("/api/Subscribe/CreateNewsOnDemandEmailSubscriptionWithPreferences?api-version=1.0")
      .send({ big: "x".repeat(200 * 1024) });
    expect(res.status).toBe(413);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.body).toEqual({ error: "request entity too large" });
    expect(res.text).not.toMatch(/at \S+ \(|\.ts:\d+:\d+/);
  });

  // RFC 8058: mail clients never add ?api-version= to the one-click unsubscribe link, so the
  // version check must let this one POST through unversioned instead of 400ing it before it
  // ever reaches the subscribe proxy. baseUrl here refuses connections, so a 502 (reached the
  // proxy, which then failed upstream) — not the 400 ApiVersionUnspecified shape — proves the
  // exemption works.
  it("lets the one-click unsubscribe POST through without api-version", async () => {
    const res = await request(app).post("/api/Subscribe/OneClickUnsubscribe/some-token").type("form").send("List-Unsubscribe=One-Click");
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "subscriptions upstream unavailable" });
  });

  // Every other Subscribe route is unaffected: still requires api-version.
  it("still requires api-version for every other Subscribe route", async () => {
    const res = await request(app).get("/api/Subscribe/SubscriptionItems/ministries");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { code: "ApiVersionUnspecified", message: "An API version is required, but was not specified.", innerError: null } });
  });
});

// Final review M3: unmatched routes used to fall through to Express's HTML "Cannot GET".
describe("unmatched routes", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    tdb = await createNewsTestDb();
    app = createApp({ db: tdb.db, timeZone: TZ, eventSecrets: EVENT_SECRETS });
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("404s an unknown /api route with RFC 7231 problem JSON", async () => {
    const res = await request(app).get("/api/NoSuchThing?api-version=1.0");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toBe("application/problem+json; charset=utf-8");
    expect(JSON.parse(res.text)).toMatchObject({ type: "https://tools.ietf.org/html/rfc7231#section-6.5.4", title: "Not Found", status: 404 });
  });

  it("404s a route outside /api with a JSON error", async () => {
    for (const path of ["/nope", "/health", "/events"]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(404);
      expect(res.headers["content-type"]).toMatch(/^application\/json/);
      expect(res.body).toEqual({ error: "not found" });
    }
  });
});

// Final review M4: /health/ready reflects extra readiness checks (main.ts wires the LISTEN
// connection's isListening() in here).
describe("readiness", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNewsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("is 503 while a readiness check (LISTEN down) reports false, 200 once it recovers", async () => {
    let listening = false;
    const app = createApp({ db: tdb.db, timeZone: TZ, eventSecrets: EVENT_SECRETS, readinessChecks: [() => listening] });
    const down = await request(app).get("/health/ready");
    expect(down.status).toBe(503);
    expect(down.body).toEqual({ status: "unavailable" });
    expect((await request(app).get("/health/live")).status).toBe(200);
    listening = true;
    const up = await request(app).get("/health/ready");
    expect(up.status).toBe(200);
    expect(up.body).toEqual({ status: "ok" });
  });
});
