import { describe, expect, it } from "vitest";
import { loginWithPassword, runSmoke, stackHealthy } from "../../scripts/lib/scrub/smoke";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fakeFetch(over: Record<string, () => Response> = {}): typeof fetch {
  const routes: Record<string, () => Response> = {
    "GET /calendar/api/list": () => json({ rows: [], total: 12, offset: 0 }),
    "POST /calendar/api/reports/look-ahead": () => json({ id: "AAAAAAAAAAAAAAAAAAAAAA", report: "look-ahead", status: "running", error: null }, 202),
    "GET /calendar/api/reports/jobs/AAAAAAAAAAAAAAAAAAAAAA": () => json({ id: "AAAAAAAAAAAAAAAAAAAAAA", report: "look-ahead", status: "ready", error: null }),
    "GET /calendar/api/reports/jobs/AAAAAAAAAAAAAAAAAAAAAA/pdf": () => new Response("%PDF-1.7 fictional", { status: 200 }),
    "GET /nrms/api/releases": () => json({ items: [{ id: "r1" }], total: 1, page: 1, pageSize: 1 }),
    "GET /nrms/api/releases/r1": () => json({ id: "r1" }),
    "GET /site/": () => new Response("<!doctype html><html></html>", { status: 200 }),
    ...over,
  };
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const route = routes[`${init?.method ?? "GET"} ${u.pathname}`];
    return route ? route() : new Response("not found", { status: 404 });
  }) as typeof fetch;
}
const opts = (f: typeof fetch) => ({ base: "http://127.0.0.1:1", calendarCookie: "gcpe_session=a", releaseCookie: "gcpe_session=b", today: "2026-10-22", fetch: f, pollMs: 1, timeoutMs: 1000 });

describe("runSmoke", () => {
  it("passes when every check passes", async () => {
    const checks = await runSmoke(opts(fakeFetch()));
    expect(checks.map((c) => [c.name, c.ok])).toEqual([["calendar list", true], ["look ahead pdf", true], ["open a release", true], ["public home page", true]]);
  });

  it("fails an empty calendar and a report that isn't a PDF", async () => {
    const checks = await runSmoke(opts(fakeFetch({ "GET /calendar/api/list": () => json({ rows: [], total: 0, offset: 0 }), "GET /calendar/api/reports/jobs/AAAAAAAAAAAAAAAAAAAAAA/pdf": () => new Response("oops") })));
    expect(checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["calendar list", "look ahead pdf"]);
  });

  it("reports a body that isn't JSON by its error label, never quoting the body", async () => {
    const checks = await runSmoke(opts(fakeFetch({ "GET /calendar/api/list": () => new Response("Quill Ashbury, (604) 555-0142", { status: 200 }) })));
    const list = checks.find((c) => c.name === "calendar list")!;
    expect(list).toEqual({ name: "calendar list", ok: false, detail: "SyntaxError" });
  });

  it("names a report state it doesn't recognise without quoting it", async () => {
    const checks = await runSmoke(opts(fakeFetch({ "GET /calendar/api/reports/jobs/AAAAAAAAAAAAAAAAAAAAAA": () => json({ id: "AAAAAAAAAAAAAAAAAAAAAA", status: "failed: Quill Ashbury" }) })));
    expect(checks.find((c) => c.name === "look ahead pdf")!.detail).toBe("the report ended in an unknown state");
  });
});

describe("sign-in and health", () => {
  it("returns the session cookie", async () => {
    const f = (async () => new Response("{}", { status: 200, headers: { "set-cookie": "gcpe_session=abc.def; Path=/; HttpOnly" } })) as typeof fetch;
    expect(await loginWithPassword("http://x", "editor@example.test", "fictional", f)).toBe("gcpe_session=abc.def");
  });
  it("reports health only for 200 with status ok", async () => {
    expect(await stackHealthy("http://x", (async () => json({ status: "ok" })) as typeof fetch)).toBe(true);
    expect(await stackHealthy("http://x", (async () => json({ status: "unavailable" }, 503)) as typeof fetch)).toBe(false);
    expect(await stackHealthy("http://x", (async () => { throw new Error("down"); }) as typeof fetch)).toBe(false);
  });
});
