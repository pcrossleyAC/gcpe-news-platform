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

  // I2: the machine-readable `code` on a 409 (version_conflict vs state) lets a caller tell a
  // real version conflict apart from "this action isn't allowed right now".
  it("409 carries the server's `code` when present", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(409, { error: "Only a draft can be approved.", code: "state" })));
    await expect(apiFetch("/nrms/api/releases/abc-123/approve", { method: "POST", body: { version: 1 } })).rejects.toMatchObject({
      status: 409,
      code: "state",
    });
  });

  it("422 carries the server's `problems`", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(422, { error: "bad", problems: ["Headline is required."] })));
    await expect(apiFetch("/nrms/api/releases/abc-123/approve", { method: "POST", body: { version: 1 } })).rejects.toMatchObject({
      status: 422,
      problems: ["Headline is required."],
    });
  });

  // File uploads (POST .../files?kind=...) are raw bodies, not JSON — `raw` sends the
  // bytes untouched (no JSON.stringify, no Content-Type forced to application/json) while every
  // other apiFetch behaviour (CSRF header, credentials, 401/409/422 handling) stays the same.
  it("a `raw` body is sent untouched, with no Content-Type forced and no JSON encoding", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return jsonResponse(201, { ok: true });
      }),
    );
    const bytes = new Uint8Array([1, 2, 3]);
    await apiFetch("/nrms/api/releases/abc-123/files?kind=asset&version=1&name=a.png", { method: "POST", raw: bytes });

    const call = calls[0]!;
    const headers = new Headers(call.init.headers);
    expect(headers.get("X-GCPE-Request")).toBe("1");
    expect(headers.has("Content-Type")).toBe(false);
    expect(call.init.credentials).toBe("same-origin");
    expect(call.init.body).toBe(bytes);
  });

  // The Website section's 422s (SiteRuleError) send `{ errors: [...] }` instead of
  // `{ error, problems }` — apiFetch must still surface those as `problems`, with a message
  // built from them, so every Website screen can use the exact same problems-list rendering
  // the release screens already use.
  it("a Website-section 422's `errors` array is read as `problems`, with no `error` field needed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(422, { errors: ["Add the M3U playlist URL before turning the Live Feed on."] })));
    await expect(apiFetch("/nrms/api/site/live-feed", { method: "PUT", body: { version: 1 } })).rejects.toMatchObject({
      status: 422,
      problems: ["Add the M3U playlist URL before turning the Live Feed on."],
      message: "Add the M3U playlist URL before turning the Live Feed on.",
    });
  });

  // AddSubscriberScreen's 409 (EmailTakenError-shaped `{ error: "subscriber exists",
  // id }`) needs the whole parsed body, not just `message` — `id` is the existing subscriber's,
  // used to link to their record.
  it("ApiError carries the parsed body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(409, { error: "subscriber exists", id: "44444444-4444-4444-4444-444444444444" })));
    await expect(apiFetch("/nod/api/subscribers", { method: "POST", body: { email: "x@example.test" } })).rejects.toMatchObject({
      status: 409,
      body: { error: "subscriber exists", id: "44444444-4444-4444-4444-444444444444" },
    });
  });

  it("a `raw` body and a JSON `body` can't both be given", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, {})));
    await expect(apiFetch("/x", { method: "POST", body: { a: 1 }, raw: new Uint8Array() })).rejects.toThrow();
  });
});
