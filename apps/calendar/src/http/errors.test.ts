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
  it("leaves anything else to the generic 500 handler", () => expect(sendActivityError(new Error("boom"), fakeRes())).toBe(false));
});
