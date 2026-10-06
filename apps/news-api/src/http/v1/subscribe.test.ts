import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { subscribeRoutes } from "./subscribe";

describe("Subscribe proxy", () => {
  let nod: Server;
  let nodUrl: string;
  const seen: { method: string; url: string; auth?: string; contentType?: string; body: unknown }[] = [];

  beforeAll(async () => {
    const stub = express();
    stub.use(express.json());
    stub.use(express.urlencoded({ extended: false }));
    stub.all("/{*rest}", (req, res) => {
      seen.push({ method: req.method, url: req.originalUrl, auth: req.header("authorization"), contentType: req.header("content-type"), body: req.body });
      if (req.path.endsWith("/CheckEmailActivationToken/bad")) return void res.status(404).json({ message: "nope" });
      if (req.path.endsWith("/OneClickUnsubscribe/plain-text-token")) return void res.type("text/plain").send("unsubscribed");
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

  // RFC 8058: mail clients POST this with a form body, not JSON, and no ?api-version=.
  it("forwards a one-click unsubscribe form POST as a raw form body, with the bearer header", async () => {
    const a = app({ baseUrl: nodUrl, getToken: async () => "tok", rateLimitPerMinute: 100 });
    const res = await request(a).post("/api/Subscribe/OneClickUnsubscribe/some-token").type("form").send("List-Unsubscribe=One-Click");
    expect(res.status).toBe(200);
    expect(res.body).toBe(true);
    const last = seen.at(-1)!;
    expect(last).toMatchObject({
      method: "POST",
      url: "/api/Subscribe/OneClickUnsubscribe/some-token",
      auth: "Bearer tok",
      contentType: "application/x-www-form-urlencoded",
      body: { "List-Unsubscribe": "One-Click" },
    });
  });

  // Carry-forward: the proxy must not force the response content-type to application/json —
  // it passes through whatever upstream sends, same as the generic loop below.
  it("passes through an upstream text/plain response instead of forcing application/json", async () => {
    const a = app({ baseUrl: nodUrl, rateLimitPerMinute: 100 });
    const res = await request(a).post("/api/Subscribe/OneClickUnsubscribe/plain-text-token").type("form").send("List-Unsubscribe=One-Click");
    expect(res.status).toBe(200);
    expect(res.header["content-type"]).toMatch(/^text\/plain/);
    expect(res.text).toBe("unsubscribed");
  });

  // One-click POSTs arrive from a small pool of shared mail-provider sending IPs, so they get
  // their own rate bucket: the generic /Subscribe limiter must not count them at all.
  it("skips one-click POSTs in the generic /Subscribe limiter, giving them their own bucket", async () => {
    const a = app({ baseUrl: nodUrl, rateLimitPerMinute: 2 });
    const postOneClick = () => request(a).post("/api/Subscribe/OneClickUnsubscribe/some-token").type("form").send("List-Unsubscribe=One-Click");
    const oneClickStatuses = [await postOneClick(), await postOneClick(), await postOneClick()].map((res) => res.status);
    expect(oneClickStatuses).toEqual([200, 200, 200]);

    // The generic limiter (limit 2) still applies as normal to ordinary requests from the
    // same client, proving the skip is specific to the one-click path, not a blanket bypass.
    const getGeneric = () => request(a).get("/api/Subscribe/SubscriptionItems/x");
    const genericStatuses = [await getGeneric(), await getGeneric(), await getGeneric()].map((res) => res.status);
    expect(genericStatuses).toEqual([200, 200, 429]);
  });

  it("rate limits one-click POSTs on their own configured bucket", async () => {
    const a = app({ baseUrl: nodUrl, rateLimitPerMinute: 100, oneClickRateLimitPerMinute: 2 });
    const postOneClick = () => request(a).post("/api/Subscribe/OneClickUnsubscribe/some-token").type("form").send("List-Unsubscribe=One-Click");
    const statuses = [await postOneClick(), await postOneClick(), await postOneClick()].map((res) => res.status);
    expect(statuses).toEqual([200, 200, 429]);
  });

  it("503 when NoD is not configured", async () => {
    expect((await request(app(undefined)).get("/api/Subscribe/SubscriptionItems/x?api-version=1.0")).status).toBe(503);
  });

  // Final review M8: behind gcpe-news-webapp every subscriber shares the webapp's IP, so the
  // per-IP bucket collapses everyone into one. With SUBSCRIBE_CLIENT_IP_HEADER configured,
  // the header the webapp sets is the bucket key instead.
  it("keys the rate limit on the configured client-IP header when set", async () => {
    const a = app({ baseUrl: nodUrl, rateLimitPerMinute: 2, clientIpHeader: "x-client-ip" });
    const get = (ip?: string) => {
      const r = request(a).get("/api/Subscribe/SubscriptionItems/x");
      return (ip ? r.set("x-client-ip", ip) : r).then((res) => res.status);
    };
    expect([await get("203.0.113.1"), await get("203.0.113.1"), await get("203.0.113.1")]).toEqual([200, 200, 429]);
    // A different end user behind the same webapp IP has their own bucket.
    expect([await get("203.0.113.2"), await get("203.0.113.2")]).toEqual([200, 200]);
    // Requests without the header fall back to req.ip.
    expect([await get(), await get(), await get()]).toEqual([200, 200, 429]);
  });

  it("ignores the client-IP header unless explicitly configured", async () => {
    const a = app({ baseUrl: nodUrl, rateLimitPerMinute: 2 });
    const statuses: number[] = [];
    for (const ip of ["203.0.113.1", "203.0.113.2", "203.0.113.3"]) {
      statuses.push((await request(a).get("/api/Subscribe/SubscriptionItems/x").set("x-client-ip", ip)).status);
    }
    expect(statuses).toEqual([200, 200, 429]);
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
