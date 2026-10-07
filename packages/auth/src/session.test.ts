import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { actorOf, requireAnyRole, requireBearer } from "./bearer";
import { mintLocalToken } from "./local";
import { CORE_ADMIN_DIRECTORY_ROLE, STAFF_ROLES } from "./roles";
import { clearedSessionCookie, mintSession, readCookie, sessionCookie, SESSION_COOKIE, verifySession } from "./session";

const secret = "s".repeat(40);
const user = { id: "8a1f0f4e-0000-4000-8000-000000000001", name: "Test Editor", email: "editor@example.test", roles: ["NRMS.Editor"] };

function app(opts: Parameters<typeof requireBearer>[0]) {
  const a = express();
  a.get("/x", requireBearer(opts), (req, res) => void res.json({ auth: req.auth, actor: actorOf(req) }));
  a.post("/x", requireBearer(opts), (_req, res) => void res.json({ ok: true }));
  a.get("/viewer-or-editor", requireBearer(opts), requireAnyRole("NRMS.Viewer", "NRMS.Editor"), (_req, res) => void res.json({ ok: true }));
  a.get("/admin-only", requireBearer(opts), requireAnyRole("Core.Admin"), (_req, res) => void res.json({ ok: true }));
  return a;
}
const cookieFor = (token: string) => `other=1; ${SESSION_COOKIE}=${token}; theme=dark`;

describe("session tokens", () => {
  it("round-trips a user and reports the expiry", async () => {
    const { token, expiresAt } = await mintSession(secret, user);
    const s = await verifySession(secret, token);
    expect(s).toMatchObject(user);
    expect(s.expiresAt).toBe(expiresAt);
    expect(expiresAt - Math.floor(Date.now() / 1000)).toBeGreaterThan(3590);
  });

  it("rejects a wrong secret, an expired token, and a local-admin token", async () => {
    const { token } = await mintSession(secret, user);
    await expect(verifySession("t".repeat(40), token)).rejects.toThrow();
    const expired = await mintSession(secret, user, -10);
    await expect(verifySession(secret, expired.token)).rejects.toThrow();
    const local = await mintLocalToken({ secret, subject: "admin", roles: ["Core.Admin"] });
    await expect(verifySession(secret, local)).rejects.toThrow();
  });

  it("refuses a weak secret", async () => {
    await expect(mintSession("short", user)).rejects.toThrow(/32 characters/);
  });

  it("reads one cookie out of a header", () => {
    expect(readCookie("a=1; gcpe_session=abc.def; b=2", "gcpe_session")).toBe("abc.def");
    expect(readCookie("gcpe_session_x=1", "gcpe_session")).toBeUndefined();
    expect(readCookie(undefined, "gcpe_session")).toBeUndefined();
  });

  it("builds cookie headers with the required flags", () => {
    expect(sessionCookie("tok", { secure: true, maxAgeSeconds: 3600 })).toBe("gcpe_session=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure");
    expect(sessionCookie("tok", { secure: false, maxAgeSeconds: 3600 })).not.toContain("Secure");
    expect(clearedSessionCookie({ secure: true })).toBe("gcpe_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure");
  });

  it("lists every staff role", () => {
    expect(STAFF_ROLES).toEqual(["Core.Admin", "NRMS.Editor", "NRMS.SiteEditor", "NRMS.Viewer", "NoD.Viewer", "NoD.Editor", "NoD.Admin", "Distribution.Send"]);
  });

  it("defines a service-only Core.AdminDirectory role, not a staff role", () => {
    expect(CORE_ADMIN_DIRECTORY_ROLE).toBe("Core.AdminDirectory");
    expect(STAFF_ROLES).not.toContain(CORE_ADMIN_DIRECTORY_ROLE);
  });
});

describe("requireBearer with a session cookie", () => {
  it("authenticates a GET from the cookie and exposes the actor", async () => {
    const { token } = await mintSession(secret, user);
    const res = await request(app({ session: { secret } })).get("/x").set("cookie", cookieFor(token));
    expect(res.status).toBe(200);
    expect(res.body.auth).toEqual({ subject: user.id, roles: ["NRMS.Editor"], claims: { name: "Test Editor", email: "editor@example.test", via: "session" } });
    expect(res.body.actor).toEqual({ id: user.id, name: "Test Editor" });
  });

  it("requires X-GCPE-Request: 1 on a state-changing cookie request", async () => {
    const { token } = await mintSession(secret, user);
    const a = app({ session: { secret } });
    expect((await request(a).post("/x").set("cookie", cookieFor(token))).status).toBe(403);
    expect((await request(a).post("/x").set("cookie", cookieFor(token)).set("x-gcpe-request", "0")).status).toBe(403);
    expect((await request(a).post("/x").set("cookie", cookieFor(token)).set("x-gcpe-request", "1")).status).toBe(200);
  });

  it("401s an invalid cookie, and ignores cookies when sessions aren't configured", async () => {
    expect((await request(app({ session: { secret } })).get("/x").set("cookie", cookieFor("garbage"))).body).toEqual({ error: "invalid session" });
    const { token } = await mintSession(secret, user);
    const res = await request(app({ local: { secret } })).get("/x").set("cookie", cookieFor(token));
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "missing bearer token" });
  });

  it("lets a bearer token win over a cookie, and never accepts a session token as a bearer", async () => {
    const a = app({ local: { secret }, session: { secret } });
    const bearer = await mintLocalToken({ secret, subject: "admin", roles: ["Core.Admin"] });
    const res = await request(a).get("/x").set("authorization", `Bearer ${bearer}`).set("cookie", cookieFor("garbage"));
    expect(res.status).toBe(200);
    expect(res.body.auth.subject).toBe("admin");
    const { token } = await mintSession(secret, user);
    expect((await request(a).get("/x").set("authorization", `Bearer ${token}`)).status).toBe(401);
  });

  it("requireAnyRole passes on any listed role", async () => {
    const { token } = await mintSession(secret, user);
    const a = app({ session: { secret } });
    expect((await request(a).get("/viewer-or-editor").set("cookie", cookieFor(token))).status).toBe(200);
    expect((await request(a).get("/admin-only").set("cookie", cookieFor(token))).status).toBe(403);
  });

  it("refuses a weak session secret at construction", () => {
    expect(() => requireBearer({ session: { secret: "short" } })).toThrow(/32 characters/);
  });
});
