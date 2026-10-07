import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonErrorHandler, safeErrorLabel } from "./errors";

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

  it("turns anything else into a generic 500 and logs the method, path and a safe label with the prefix", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(app(() => { throw new Error("secret db detail at /srv/x.ts:1"); })).get("/throw");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "internal error" });
    expect(res.text).not.toContain("secret");
    expect(log).toHaveBeenCalledWith("[test] request failed", "GET", "/throw", "Error");
  });

  // A thrown error's own message can embed whatever a failing query bound -- an address, a
  // token -- the same risk safeErrorLabel exists to close everywhere else. jsonErrorHandler
  // must never log the error itself, only method/path/label.
  it("never logs an address that a thrown error's own message carries", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = Object.assign(new Error("Failed query: ...\nparams: someone@example.test"), { code: "23505" });
    const res = await request(app(() => { throw err; })).get("/throw");
    expect(res.status).toBe(500);
    for (const call of log.mock.calls) {
      expect(call.join(" ")).not.toContain("someone@example.test");
    }
    expect(log).toHaveBeenCalledWith("[test] request failed", "GET", "/throw", "23505");
  });
});

describe("safeErrorLabel", () => {
  it("prefers a Postgres-style error code over the message", () => {
    const e = Object.assign(new Error("duplicate key value violates unique constraint (user@example.test)"), { code: "23505" });
    expect(safeErrorLabel(e)).toBe("23505");
  });

  it("falls back to a code nested under cause", () => {
    const e = Object.assign(new Error("Failed query: ...\nparams: user@example.test"), { cause: { code: "40P01" } });
    expect(safeErrorLabel(e)).toBe("40P01");
  });

  it("falls back to the error's name when there's no code anywhere", () => {
    expect(safeErrorLabel(new TypeError("boom for user@example.test"))).toBe("TypeError");
  });

  it("falls back to 'error' for a non-Error thrown value", () => {
    expect(safeErrorLabel("just a string")).toBe("error");
  });
});
