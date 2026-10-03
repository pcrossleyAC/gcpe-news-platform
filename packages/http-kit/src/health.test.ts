import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { healthRoutes } from "./health";

function app(checks: Parameters<typeof healthRoutes>[0]) {
  const a = express();
  a.use(healthRoutes(checks));
  return a;
}

describe("healthRoutes", () => {
  it("live is always ok, even when a readiness check fails", async () => {
    const res = await request(app([() => false])).get("/health/live");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("ready is ok when every check passes (sync or async)", async () => {
    const res = await request(app([() => true, async () => ({ rows: [] }), () => undefined])).get("/health/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it.each([
    ["returns false", () => false],
    ["throws", () => { throw new Error("secret detail"); }],
    ["rejects", async () => { throw new Error("secret detail"); }],
  ])("ready is 503 unavailable when a check %s, without leaking details", async (_name, failing) => {
    const res = await request(app([() => true, failing])).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "unavailable" });
    expect(res.text).not.toContain("secret");
  });
});
