import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { subscribeRoutes } from "./subscribe";

describe("Subscribe proxy", () => {
  let nod: Server;
  let nodUrl: string;
  const seen: { method: string; url: string; auth?: string; body: unknown }[] = [];

  beforeAll(async () => {
    const stub = express();
    stub.use(express.json());
    stub.all("/{*rest}", (req, res) => {
      seen.push({ method: req.method, url: req.originalUrl, auth: req.header("authorization"), body: req.body });
      if (req.path.endsWith("/CheckEmailActivationToken/bad")) return void res.status(404).json({ message: "nope" });
      res.json(true);
    });
    nod = await new Promise<Server>((r) => {
      const s = stub.listen(0, () => r(s));
    });
    nodUrl = `http://127.0.0.1:${(nod.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    nod.close();
  });

  function app(opts: Parameters<typeof subscribeRoutes>[0]) {
    const a = express();
    a.use("/api", subscribeRoutes(opts));
    return a;
  }

  it("forwards GET with token, dropping api-version", async () => {
    const res = await request(app({ baseUrl: nodUrl, getToken: async () => "tok", rateLimitPerMinute: 100 })).get(
      "/api/Subscribe/SubscriptionItems/ministries?api-version=1.0",
    );
    expect(res.body).toBe(true);
    expect(seen.at(-1)).toMatchObject({ method: "GET", url: "/api/Subscribe/SubscriptionItems/ministries", auth: "Bearer tok" });
  });

  it("forwards POST bodies and passes status codes through", async () => {
    const a = app({ baseUrl: nodUrl, rateLimitPerMinute: 100 });
    await request(a).post("/api/Subscribe/CreateNewsOnDemandEmailSubscriptionWithPreferences?api-version=1.0").send({ emailAddress: "a@b.c", isAsItHappens: true });
    expect(seen.at(-1)!.body).toEqual({ emailAddress: "a@b.c", isAsItHappens: true });
    expect((await request(a).get("/api/Subscribe/CheckEmailActivationToken/bad?api-version=1.0")).status).toBe(404);
  });

  it("503 when NoD is not configured", async () => {
    expect((await request(app(undefined)).get("/api/Subscribe/SubscriptionItems/x?api-version=1.0")).status).toBe(503);
  });

  it("rate limits per client", async () => {
    const a = app({ baseUrl: nodUrl, rateLimitPerMinute: 2 });
    await request(a).get("/api/Subscribe/SubscriptionItems/x");
    await request(a).get("/api/Subscribe/SubscriptionItems/x");
    expect((await request(a).get("/api/Subscribe/SubscriptionItems/x")).status).toBe(429);
  });

  it("502s when the token provider throws, instead of a bare 500", async () => {
    const a = app({
      baseUrl: nodUrl,
      getToken: async () => {
        throw new Error("token service down");
      },
      rateLimitPerMinute: 100,
    });
    const res = await request(a).get("/api/Subscribe/SubscriptionItems/x?api-version=1.0");
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "subscriptions upstream unavailable" });
  });

  it("rejects a '..' path parameter with 400 instead of forwarding it upstream", async () => {
    const a = app({ baseUrl: nodUrl, rateLimitPerMinute: 100 });
    const before = seen.length;
    const res = await request(a).get("/api/Subscribe/CheckEmailActivationToken/..?api-version=1.0");
    expect(res.status).toBe(400);
    expect(seen.length).toBe(before); // never reached the upstream stub
  });

  it("round-trips an email containing + and @ through percent-encoding, intact", async () => {
    const a = app({ baseUrl: nodUrl, rateLimitPerMinute: 100 });
    const email = "a+b@c.com";
    await request(a).get(`/api/Subscribe/ManageNewsOnDemandEmailSubscription/${encodeURIComponent(email)}?api-version=1.0`);
    const last = seen.at(-1)!;
    expect(last.url).toBe(`/api/Subscribe/ManageNewsOnDemandEmailSubscription/${encodeURIComponent(email)}`);
    expect(decodeURIComponent(last.url.split("/").pop()!)).toBe(email);
  });
});
