import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonErrorHandler } from "./errors";

function app(throwIt: () => never) {
  const a = express();
  a.post("/json", express.json({ limit: "1kb" }), (_req, res) => void res.json({ ok: true }));
  a.get("/throw", () => throwIt());
  a.use(jsonErrorHandler({ logPrefix: "[test]" }));
  return a;
}

describe("jsonErrorHandler", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps body-parser's 413 as JSON with its exposed message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(app(() => { throw new Error("x"); })).post("/json").send({ big: "x".repeat(4096) });
    expect(res.status).toBe(413);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.body).toEqual({ error: "request entity too large" });
  });

  it("keeps a malformed-JSON 400 as JSON", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(app(() => { throw new Error("x"); })).post("/json").set("content-type", "application/json").send("{not json");
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.text).not.toMatch(/at \S+ \(|\.ts:\d+:\d+/);
  });

  it("hides the message of a 4xx error that is not marked expose", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const err = Object.assign(new Error("secret detail"), { status: 409 });
    const res = await request(app(() => { throw err; })).get("/throw");
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "request error" });
  });

  it("turns anything else into a generic 500 and logs it with the prefix", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(app(() => { throw new Error("secret db detail at /srv/x.ts:1"); })).get("/throw");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "internal error" });
    expect(res.text).not.toContain("secret");
    expect(log).toHaveBeenCalledWith("[test] request failed", expect.any(Error));
  });
});
