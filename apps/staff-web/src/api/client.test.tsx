import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, onUnauthorized } from "./client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("apiFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds X-GCPE-Request on a state-changing request, not on GET, and always sends credentials: same-origin", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse(200, { ok: true });
      }),
    );

    await apiFetch("/nrms/api/categories");
    await apiFetch("/nrms/api/releases", { method: "POST", body: { headline: "x" } });

    const getHeaders = new Headers(calls[0]!.init.headers);
    const postHeaders = new Headers(calls[1]!.init.headers);
    expect(getHeaders.has("X-GCPE-Request")).toBe(false);
    expect(postHeaders.get("X-GCPE-Request")).toBe("1");
    expect(calls[0]!.init.credentials).toBe("same-origin");
    expect(calls[1]!.init.credentials).toBe("same-origin");
    expect(JSON.parse(postHeaders.get("Content-Type") ? (calls[1]!.init.body as string) : "{}")).toEqual({ headline: "x" });
  });

  it("401 notifies onUnauthorized with the current page as the return path, and throws a 401 ApiError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { error: "not signed in" })));
    window.history.pushState({}, "", "/hub/releases/abc-123");

    const seen: string[] = [];
    const off = onUnauthorized((returnTo) => seen.push(returnTo));
    try {
      await expect(apiFetch("/nrms/api/releases/abc-123")).rejects.toMatchObject({ status: 401, message: "not signed in" });
      expect(seen).toEqual(["/hub/releases/abc-123"]);
    } finally {
      off();
    }
  });

  it("409 throws an ApiError with status 409 and the server's message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(409, { error: "Someone else changed this release — reload to see their changes" })));
    await expect(apiFetch("/nrms/api/releases/abc-123/approve", { method: "POST", body: { version: 1 } })).rejects.toMatchObject({
      status: 409,
      message: "Someone else changed this release — reload to see their changes",
    });
  });

  it("422 carries the server's `problems`", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(422, { error: "bad", problems: ["Headline is required."] })));
    await expect(apiFetch("/nrms/api/releases/abc-123/approve", { method: "POST", body: { version: 1 } })).rejects.toMatchObject({
      status: 422,
      problems: ["Headline is required."],
    });
  });
});
