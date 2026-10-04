import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createTickRunner, tickRouter, type TickStep } from "./tick";

const TOKEN = "t".repeat(32);

function appWith(steps: TickStep[]) {
  const app = express();
  app.use("/stack", tickRouter(TOKEN, createTickRunner(steps)));
  return app;
}

describe("tick auth", () => {
  it("401s with no token", async () => {
    const app = appWith([]);
    expect((await request(app).post("/stack/tick")).status).toBe(401);
    expect((await request(app).get("/stack/tick")).status).toBe(401);
  });

  it("401s with the wrong bearer token", async () => {
    const app = appWith([]);
    const res = await request(app).post("/stack/tick").set("authorization", "Bearer wrong-token-wrong-token-wrong-token");
    expect(res.status).toBe(401);
  });

  it("accepts the right bearer token", async () => {
    const app = appWith([]);
    const res = await request(app).post("/stack/tick").set("authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
  });

  it("accepts the right ?token= query param (for GET-only schedulers)", async () => {
    const app = appWith([]);
    const res = await request(app).get(`/stack/tick?token=${TOKEN}`);
    expect(res.status).toBe(200);
  });

  it("401s a ?token= query param that's wrong", async () => {
    const app = appWith([]);
    const res = await request(app).get("/stack/tick?token=nope-nope-nope-nope-nope-nope-nope");
    expect(res.status).toBe(401);
  });
});

describe("tick execution", () => {
  it("runs every step in order and reports ok for each", async () => {
    const order: string[] = [];
    const steps: TickStep[] = [
      { name: "nrms.publish", run: async () => void order.push("nrms.publish") },
      { name: "nrms.dispatch", run: async () => void order.push("nrms.dispatch") },
    ];
    const app = appWith(steps);
    const res = await request(app).post("/stack/tick").set("authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ran: { "nrms.publish": "ok", "nrms.dispatch": "ok" }, ms: expect.any(Number) });
    expect(order).toEqual(["nrms.publish", "nrms.dispatch"]);
  });

  it("isolates a failing step in its own try/catch, still running the rest", async () => {
    const order: string[] = [];
    const steps: TickStep[] = [
      { name: "a", run: async () => { throw new Error("boom"); } },
      { name: "b", run: async () => void order.push("b") },
    ];
    const app = appWith(steps);
    const res = await request(app).post("/stack/tick").set("authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.ran).toEqual({ a: "error: boom", b: "ok" });
    expect(order).toEqual(["b"]);
  });

  it("coalesces an overlapping tick into a 202 {skipped:true} instead of running twice concurrently", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const steps: TickStep[] = [
      {
        name: "slow",
        run: async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 50));
          concurrent--;
        },
      },
    ];
    const app = appWith(steps);
    const [first, second] = await Promise.all([
      request(app).post("/stack/tick").set("authorization", `Bearer ${TOKEN}`),
      new Promise<request.Response>((resolve) => setTimeout(() => resolve(request(app).post("/stack/tick").set("authorization", `Bearer ${TOKEN}`)), 5)),
    ]);
    expect(maxConcurrent).toBe(1);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 202]);
    const skipped = [first, second].find((r) => r.status === 202)!;
    expect(skipped.body).toEqual({ skipped: true });
  });

  it("a tick after the previous one finished runs normally (not coalesced forever)", async () => {
    const run = vi.fn(async () => {});
    const app = appWith([{ name: "x", run }]);
    await request(app).post("/stack/tick").set("authorization", `Bearer ${TOKEN}`);
    const res = await request(app).post("/stack/tick").set("authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
