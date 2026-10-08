import { describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import { sendActivityError } from "./errors";

function fakeRes() {
  const res = { statusCode: 0, body: undefined as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

describe("sendActivityError", () => {
  it("turns a constraint error into a 409 and logs only its code, never its message", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = fakeRes();
    const e = Object.assign(new Error("duplicate key value violates … (title)=(Sample secret)"), { cause: { code: "23505" } });
    expect(sendActivityError(e, res)).toBe(true);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ code: "conflict", error: "That change conflicts with another one: reload and try again" });
    expect(JSON.stringify(log.mock.calls)).toContain("23505");
    expect(JSON.stringify(log.mock.calls)).not.toContain("Sample secret");
    log.mockRestore();
  });
  it("reads a bare code as well as a wrapped one", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = fakeRes();
    expect(sendActivityError(Object.assign(new Error("duplicate key"), { code: "23505" }), res)).toBe(true);
    expect(res.statusCode).toBe(409);
    log.mockRestore();
  });
  it("turns an invalid value (SQLSTATE class 22) into a 400 and logs only its code", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const code of ["22003", "22021", "22009"]) {
      const res = fakeRes();
      expect(sendActivityError(Object.assign(new Error("invalid byte sequence (Sample secret)"), { cause: { code } }), res)).toBe(true);
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: "invalid value" });
    }
    expect(JSON.stringify(log.mock.calls)).toContain("22021");
    expect(JSON.stringify(log.mock.calls)).not.toContain("Sample secret");
    log.mockRestore();
  });
  it("turns a serialization failure (40001) or a deadlock (40P01) into a 409 that says to try again, and logs only its code", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const e of [
      Object.assign(new Error("could not serialize access (Sample secret)"), { cause: { code: "40001" } }),
      Object.assign(new Error("deadlock detected (Sample secret)"), { cause: { code: "40P01" } }),
      Object.assign(new Error("deadlock detected (Sample secret)"), { code: "40P01" }),
    ]) {
      const res = fakeRes();
      expect(sendActivityError(e, res)).toBe(true);
      expect(res.statusCode).toBe(409);
      expect(res.body).toEqual({ code: "retry", error: "Someone else was saving at the same time: try again." });
    }
    expect(JSON.stringify(log.mock.calls)).toContain("40P01");
    expect(JSON.stringify(log.mock.calls)).not.toContain("Sample secret");
    log.mockRestore();
  });
  it("leaves anything else to the generic 500 handler", () => expect(sendActivityError(new Error("boom"), fakeRes())).toBe(false));
});
