// Owner decision 2026-10-31 (review S M8): a break-glass bearer token from /<app>/auth/local/token
// stops working when break-glass is turned off, when its password changes, once it is older than
// min(8 h, SESSION_MAX_HOURS), and once it is signed out (Core's session gate, by its own sid).
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { decodeJwt } from "jose";
import { requireBearer, setSessionGate, type BearerOptions, type SessionGate } from "./bearer";
import { authFromEnv } from "./from-env";
import { mintInternalToken, markInternalSocket } from "./internal";
import { ADMIN_ROLES, BREAK_GLASS_ID, localLoginRouter, mintLocalToken } from "./local";
import { hashPassword } from "./password";

const secret = "b".repeat(32) + "-break-glass-token-secret";
const PW = "break glass password!";
const T0 = new Date("2026-11-02T08:00:00Z");
const at = (minutesAfterT0: number) => vi.setSystemTime(new Date(T0.getTime() + minutesAfterT0 * 60_000));

let passwordHash: string;
beforeAll(async () => {
  passwordHash = await hashPassword(PW);
});
afterEach(() => {
  vi.useRealTimers();
  setSessionGate(null);
});

const cfg = () => ({ username: "admin", passwordHash, secret });
const bearerFor = (o: { passwordHash?: string; maxSessionSeconds?: number; gateRequired?: boolean; gate?: SessionGate } = {}): BearerOptions => ({
  local: { secret, breakGlass: { username: "admin", passwordHash: o.passwordHash ?? passwordHash, maxSessionSeconds: o.maxSessionSeconds, gateRequired: o.gateRequired } },
  ...(o.gate ? { session: { secret: "s".repeat(40), gate: o.gate } } : {}),
});
function appWith(bearer: BearerOptions, maxSessionSeconds?: number) {
  const app = express();
  app.use(localLoginRouter(cfg(), { maxSessionSeconds }));
  app.get("/api/x", requireBearer(bearer), (req, res) => void res.json({ sub: req.auth!.subject, roles: req.auth!.roles }));
  return app;
}
const signIn = async (app: express.Express) => {
  const res = await request(app).post("/auth/local/token").send({ username: "admin", password: PW });
  expect(res.status).toBe(200);
  return res.body as { access_token: string; expires_in: number };
};
const call = (app: express.Express, token: string) => request(app).get("/api/x").set("authorization", `Bearer ${token}`);

describe("break-glass bearer tokens", () => {
  it("works as before: an admin token for the break-glass account", async () => {
    const app = appWith(bearerFor());
    const { access_token } = await signIn(app);
    const res = await call(app, access_token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sub: "admin", roles: [...ADMIN_ROLES] });
  });

  it("(b) carries a fingerprint of the password, never the password or its hash, and stops working once the password changes", async () => {
    const app = appWith(bearerFor());
    const { access_token } = await signIn(app);
    const claims = decodeJwt(access_token);
    expect(claims).toMatchObject({ bg: true });
    expect(typeof claims.sid).toBe("string");
    expect(typeof claims.pwf).toBe("string");
    expect(access_token).not.toContain(passwordHash);
    expect(JSON.stringify(claims)).not.toContain(PW);
    expect(JSON.stringify(claims)).not.toContain(passwordHash.split("$").at(-1)!);
    // The same secret, a new password: the verifier now holds the new hash.
    const changed = express();
    changed.get("/api/x", requireBearer(bearerFor({ passwordHash: await hashPassword("a brand new password") })), (_req, res) => void res.json({ ok: true }));
    expect((await call(changed, access_token)).status).toBe(401);
    expect((await call(app, access_token)).status).toBe(200);
  });

  it("(c) lasts min(8 h, SESSION_MAX_HOURS): 8 h by default", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(0);
    const app = appWith(bearerFor({ maxSessionSeconds: 12 * 3600 }), 12 * 3600);
    const { access_token, expires_in } = await signIn(app);
    expect(expires_in).toBe(8 * 3600);
    at(8 * 60 - 1);
    expect((await call(app, access_token)).status).toBe(200);
    at(8 * 60 + 1);
    expect((await call(app, access_token)).status).toBe(401);
  });

  it("(c) a shorter SESSION_MAX_HOURS shortens it, even on a token minted with a longer life", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(0);
    const short = appWith(bearerFor({ maxSessionSeconds: 2 * 3600 }), 2 * 3600);
    const { expires_in } = await signIn(short);
    expect(expires_in).toBe(2 * 3600);
    // A token minted by an app still on the 8 h default, checked by one with a 2 h limit.
    const { access_token: long } = await signIn(appWith(bearerFor({ maxSessionSeconds: 12 * 3600 })));
    at(119);
    expect((await call(short, long)).status).toBe(200);
    at(121);
    expect((await call(short, long)).status).toBe(401);
  });

  it("(a) stops working once break-glass is turned off, and the endpoint is gone", async () => {
    const on = authFromEnv({ LOCAL_ADMIN_ENABLED: "true", LOCAL_ADMIN_PASSWORD_HASH: passwordHash, LOCAL_AUTH_SECRET: secret, SESSION_MAX_HOURS: "12" });
    const app = express();
    app.use(on.loginRouter!);
    app.get("/api/x", requireBearer(on.bearer), (_req, res) => void res.json({ ok: true }));
    const { access_token } = await signIn(app);
    expect((await call(app, access_token)).status).toBe(200);

    const offEnv = { ENTRA_TENANT_ID: "t", AUTH_AUDIENCE: "api://core", LOCAL_AUTH_SECRET: secret };
    const off = authFromEnv(offEnv);
    expect(off.loginRouter).toBeNull();
    const offApp = express();
    offApp.get("/api/x", requireBearer(off.bearer), (_req, res) => void res.json({ ok: true }));
    expect((await call(offApp, access_token)).status).toBe(401);
    // Refused outright in production unless allowed (no verifier for it can be built at all).
    expect(() => authFromEnv({ NODE_ENV: "production", LOCAL_ADMIN_ENABLED: "true", LOCAL_ADMIN_PASSWORD_HASH: passwordHash, LOCAL_AUTH_SECRET: secret })).toThrow(/refused when NODE_ENV=production/);
  });

  it("authFromEnv wires the password fingerprint and the session limit into every app's verifier and login", async () => {
    const env = { LOCAL_ADMIN_ENABLED: "true", LOCAL_ADMIN_PASSWORD_HASH: passwordHash, LOCAL_AUTH_SECRET: secret, SESSION_MAX_HOURS: "3" };
    const a = authFromEnv(env);
    expect(a.bearer.local?.breakGlass).toMatchObject({ username: "admin", passwordHash, maxSessionSeconds: 3 * 3600 });
    const app = express();
    app.use(a.loginRouter!);
    expect((await signIn(app)).expires_in).toBe(3 * 3600);
  });

  it("(d) is tied to its own sign-in (sid) in Core's session gate: refused once that is signed out", async () => {
    const seen: Parameters<SessionGate>[0][] = [];
    let ended = false;
    const gate: SessionGate = async (s) => {
      seen.push(s);
      return ended ? null : { id: s.id, name: "Administrator (break-glass)", email: "", roles: [...ADMIN_ROLES] };
    };
    const app = appWith(bearerFor({ gate }));
    const { access_token } = await signIn(app);
    expect((await call(app, access_token)).status).toBe(200);
    expect(seen[0]).toMatchObject({ id: BREAK_GLASS_ID, sid: decodeJwt(access_token).sid, fromToken: true });
    ended = true;
    expect((await call(app, access_token)).status).toBe(401);
  });

  it("(d) uses the gate the stack installed when the app has none of its own", async () => {
    const app = appWith(bearerFor());
    const { access_token } = await signIn(app);
    setSessionGate(async () => null);
    expect((await call(app, access_token)).status).toBe(401);
  });

  it("(d) answers 503 while the check can't be made, and when the stack requires a gate that isn't installed", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const failing = appWith(bearerFor({ gate: async () => Promise.reject(new Error("db down")) }));
      const { access_token } = await signIn(failing);
      const res = await call(failing, access_token);
      expect(res.status).toBe(503);
      expect(res.headers["retry-after"]).toBe("5");
      const required = appWith(bearerFor({ gateRequired: true }));
      expect((await call(required, access_token)).status).toBe(503);
    } finally {
      errors.mockRestore();
    }
  });

  it("a break-glass token from before this change (no fingerprint) is refused; a verifier without the break-glass settings refuses new ones", async () => {
    const old = await mintLocalToken({ secret, subject: "admin", roles: [...ADMIN_ROLES] });
    const app = appWith(bearerFor());
    expect((await call(app, old)).status).toBe(401);
    const { access_token } = await signIn(app);
    const bare = express();
    bare.get("/api/x", requireBearer({ local: { secret } }), (_req, res) => void res.json({ ok: true }));
    expect((await call(bare, access_token)).status).toBe(401);
  });

  it("does not touch service tokens: a local service token (an app run on its own) and the stack's internal token still work, without the gate", async () => {
    const gate = vi.fn<SessionGate>(async () => null);
    const app = express();
    app.use((req, _res, next) => {
      if (req.header("x-test-internal")) markInternalSocket(req.socket);
      next();
    });
    app.get("/api/x", requireBearer({ ...bearerFor({ gate, gateRequired: true }), internal: { secret: "i".repeat(40) } }), (req, res) => void res.json({ sub: req.auth!.subject }));
    const service = await mintLocalToken({ secret, subject: "nod", azp: "nod", roles: ["Distribution.Send"], ttlSeconds: 3600 });
    expect((await call(app, service)).body).toEqual({ sub: "nod" });
    const internal = await mintInternalToken({ secret: "i".repeat(40), subject: "nrms", roles: ["NewsApi.Similar"] });
    expect((await request(app).get("/api/x").set("x-test-internal", "1").set("authorization", `Bearer ${internal}`)).body).toEqual({ sub: "nrms" });
    expect(gate).not.toHaveBeenCalled();
  });

  it("a second stack in the same process shutting down leaves the first stack's gate in place (no 503 for its tokens)", async () => {
    const app = appWith(bearerFor({ gateRequired: true }));
    const { access_token } = await signIn(app);
    const first = vi.fn<SessionGate>(async (s) => ({ id: s.id, name: "x", email: "", roles: [] }));
    setSessionGate(first);
    const removeSecond = setSessionGate(async () => null);
    expect((await call(app, access_token)).status).toBe(401);
    removeSecond();
    expect((await call(app, access_token)).status).toBe(200);
    expect(first).toHaveBeenCalled();
  });

  // Review BG N1: renaming the break-glass account ends the old name's tokens.
  it("refuses a token for a break-glass user name that is no longer the current one", async () => {
    const app = appWith(bearerFor());
    const { access_token } = await signIn(app);
    const renamed = express();
    renamed.get("/api/x", requireBearer({ local: { secret, breakGlass: { username: "ops", passwordHash } } }), (_req, res) => void res.json({ ok: true }));
    expect((await call(renamed, access_token)).status).toBe(401);
  });
});
