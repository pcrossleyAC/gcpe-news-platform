import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import { decodeJwt } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { hashPassword } from "@gcpe/auth";
import { createFakeOidc, type FakeOidc, type FakeOidcTokenOverrides } from "@gcpe/oidc-fake";
import { createCoreTestDb } from "../../test/helpers";
import { createApp } from "../app";
import { createUser, createUserSchema, matchEntraUser, updateUser } from "../services/users";
import { createEntraClient } from "./client";
import type { EntraSignInConfig } from "./config";
import { openEntraState, sealEntraState } from "./state-cookie";

const SECRET = "session-secret-for-entra-tests-0123456789";
const TENANT = "0000fa4e-0000-4000-8000-000000000003";
const REDIRECT = "https://hub.example.test/core/auth/entra/callback";
const PW = "a long enough password";
const IDENTITIES = [
  { key: "staff", oid: "oid-staff", email: "Staff.Person@example.test", name: "Staff Person" },
  { key: "unknown", oid: "oid-unknown", email: "unknown.person@example.test", name: "Unknown Person" },
  { key: "idle", oid: "oid-idle", email: "idle.person@example.test", name: "Idle Person" },
  { key: "impostor", oid: "oid-impostor", email: "taken.person@example.test", name: "Taken Person" },
];

function setCookies(res: request.Response): string[] {
  return (res.headers["set-cookie"] as unknown as string[] | undefined) ?? [];
}
const cookieValue = (res: request.Response, name: string) => setCookies(res).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1).split(";")[0];

describe("Entra sign-in routes", () => {
  let tdb: TestDatabase;
  let server: Server;
  let fake: FakeOidc;
  let cfg: EntraSignInConfig;
  let app: express.Express;
  let staffId: string;

  beforeAll(async () => {
    tdb = await createCoreTestDb();
    const fakeApp = express();
    server = fakeApp.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/fake-entra`;
    fake = await createFakeOidc({ tenantId: TENANT, clientId: "core-client", clientSecret: "core-secret", redirectUris: [REDIRECT], serverBase: base, browserBase: base, identities: IDENTITIES });
    fakeApp.use("/fake-entra", fake.router);
    cfg = { tenantId: TENANT, clientId: "core-client", clientSecret: "core-secret", authority: fake.issuer, redirectUri: REDIRECT };
    const local = { username: "admin", passwordHash: await hashPassword("break glass password!"), secret: "local-secret-for-entra-tests-0123456789" };
    app = createApp({ db: tdb.db, subscribers: [], auth: { session: { secret: SECRET } }, session: { secret: SECRET, secure: true, local, entra: createEntraClient(cfg), entraRatePerMinute: 1000 } });
    staffId = (await createUser(tdb.db, createUserSchema.parse({ email: "staff.person@example.test", displayName: "Staff Person", roles: ["NRMS.Editor"], password: PW }), [])).id;
    const idle = await createUser(tdb.db, createUserSchema.parse({ email: "idle.person@example.test", displayName: "Idle Person" }), []);
    await updateUser(tdb.db, idle.id, { isActive: false }, []);
    await createUser(tdb.db, createUserSchema.parse({ email: "taken.person@example.test", displayName: "Taken Person" }), []);
    await matchEntraUser(tdb.db, "oid-original-owner", "taken.person@example.test");
  });
  afterAll(async () => {
    server.close();
    await tdb.drop();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** GET /auth/entra, then the fake's picker as a browser would. Returns the callback query and the state cookie. */
  async function startAndPick(key: string, returnTo = "/hub/search?q=fire"): Promise<{ start: request.Response; query: string; stateCookie: string }> {
    const start = await request(app).get(`/auth/entra?returnTo=${encodeURIComponent(returnTo)}`);
    expect(start.status).toBe(302);
    const authorize = new URL(start.headers.location!);
    const page = await (await fetch(authorize)).text();
    const href = new RegExp(`href="(authorize/approve[^"]*user=${key})"`).exec(page)![1]!.replace(/&amp;/g, "&");
    const approved = await fetch(new URL(href, authorize), { redirect: "manual" });
    const back = new URL(approved.headers.get("location")!);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    return { start, query: back.search.slice(1), stateCookie: cookieValue(start, "gcpe_entra")! };
  }
  const callback = (query: string, stateCookie?: string) => {
    const r = request(app).get(`/auth/entra/callback?${query}`);
    return stateCookie ? r.set("cookie", `gcpe_entra=${stateCookie}`) : r;
  };
  async function signIn(key: string, overrides?: FakeOidcTokenOverrides) {
    const { query, stateCookie } = await startAndPick(key);
    if (overrides) fake.controls.setNextTokenOverrides(overrides);
    return callback(query, stateCookie);
  }

  it("GET /auth/entra sets the state cookie and sends the browser to Microsoft with PKCE, state, nonce and select_account", async () => {
    const res = await request(app).get("/auth/entra");
    const to = new URL(res.headers.location!);
    expect(to.href.startsWith(`${fake.issuer.replace(/\/v2\.0$/, "")}/oauth2/v2.0/authorize`)).toBe(true);
    expect(Object.fromEntries(to.searchParams)).toMatchObject({ client_id: "core-client", redirect_uri: REDIRECT, response_type: "code", scope: "openid profile email", code_challenge_method: "S256", prompt: "select_account" });
    const saved = openEntraState(SECRET, cookieValue(res, "gcpe_entra"))!;
    expect(to.searchParams.get("state")).toBe(saved.state);
    expect(to.searchParams.get("nonce")).toBe(saved.nonce);
    expect(saved.returnTo).toBe("/hub/");
    expect(setCookies(res)[0]).toMatch(/^gcpe_entra=[^;]+; Path=\/core\/auth\/entra; HttpOnly; SameSite=Lax; Max-Age=300; Secure$/);
  });

  it("signs a provisioned user in with the same gcpe_session cookie as password sign-in, clears the state cookie and returns to the page", async () => {
    const res = await signIn("staff");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/hub/search?q=fire");
    expect(setCookies(res)).toContain("gcpe_entra=; Path=/core/auth/entra; HttpOnly; SameSite=Lax; Max-Age=0; Secure");
    const entraCookie = setCookies(res).find((c) => c.startsWith("gcpe_session="))!;

    const password = await request(app).post("/auth/login").set("x-gcpe-request", "1").send({ username: "staff.person@example.test", password: PW });
    // Linked now, so the password is refused; the shape comparison uses a second, unlinked user.
    expect(password.status).toBe(401);
    const other = await createUser(tdb.db, createUserSchema.parse({ email: "shape.check@example.test", displayName: "Shape Check", roles: ["NRMS.Editor"], password: PW }), []);
    const local = await request(app).post("/auth/login").set("x-gcpe-request", "1").send({ username: "shape.check@example.test", password: PW });
    const localCookie = setCookies(local).find((c) => c.startsWith("gcpe_session="))!;
    const attrs = (c: string) => c.split("; ").slice(1);
    expect(attrs(entraCookie)).toEqual(attrs(localCookie));
    const entraClaims = decodeJwt(cookieValue(res, "gcpe_session")!);
    const localClaims = decodeJwt(cookieValue(local, "gcpe_session")!);
    expect(Object.keys(entraClaims).sort()).toEqual(Object.keys(localClaims).sort());
    expect(entraClaims).toMatchObject({ sub: staffId, name: "Staff Person", email: "staff.person@example.test", roles: ["NRMS.Editor"] });
    expect(localClaims).toMatchObject({ sub: other.id, roles: ["NRMS.Editor"] });

    const session = await request(app).get("/auth/session").set("cookie", `gcpe_session=${cookieValue(res, "gcpe_session")}`);
    expect(session.body.user).toEqual({ id: staffId, name: "Staff Person", email: "staff.person@example.test", roles: ["NRMS.Editor"] });

    // Owner decision 2026-10-31: a Microsoft sign-in is recorded like a password one (sign-in
    // time and session id, for the 12-hour limit), so Sign out ends it on the server.
    expect(typeof entraClaims.sat).toBe("number");
    expect(typeof entraClaims.sid).toBe("string");
    const cookie = `gcpe_session=${cookieValue(res, "gcpe_session")}`;
    expect((await request(app).post("/auth/logout").set("x-gcpe-request", "1").set("cookie", cookie)).status).toBe(204);
    expect((await request(app).get("/auth/session").set("cookie", cookie)).status).toBe(401);
  });

  it.each([
    ["not_provisioned", "unknown"],
    ["inactive", "idle"],
    ["conflict", "impostor"],
  ])("refuses with %s and issues no session", async (code, key) => {
    const res = await signIn(key);
    expect(res.headers.location).toBe(`/hub/sign-in?error=${code}`);
    expect(cookieValue(res, "gcpe_session")).toBeUndefined();
  });

  it.each([
    ["a wrong nonce", { nonce: "another-nonce" }],
    ["the wrong audience", { aud: "another-client" }],
    ["the wrong issuer", { iss: "https://login.microsoftonline.com/another/v2.0" }],
    ["the wrong tenant", { tid: "0000fa4e-0000-4000-8000-0000000000ff" }],
    ["a signature the tenant's JWKS doesn't verify", { signWithUnpublishedKey: true }],
    // openid-client allows a 30s default clock tolerance, so this must expire well past that.
    ["an already-expired ID token", { exp: Math.floor(Date.now() / 1000) - 120 }],
    ["a token missing the oid claim", { omitOid: true }],
  ])("refuses a token with %s as failed", async (_label, overrides) => {
    const res = await signIn("staff", overrides);
    expect(res.headers.location).toBe("/hub/sign-in?error=failed");
    expect(cookieValue(res, "gcpe_session")).toBeUndefined();
  });

  it("refuses a replayed authorization code as failed, and issues no second session", async () => {
    const { query, stateCookie } = await startAndPick("staff");
    const first = await callback(query, stateCookie);
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe("/hub/search?q=fire");
    expect(cookieValue(first, "gcpe_session")).toBeTruthy();

    // The fake's code is single-use; replaying the same callback query (with a fresh state
    // cookie, since the first callback already cleared it) must fail, not mint a second session.
    const replay = await callback(query, stateCookie);
    expect(replay.headers.location).toBe("/hub/sign-in?error=failed");
    expect(cookieValue(replay, "gcpe_session")).toBeUndefined();
  });

  it("refuses a wrong PKCE verifier as failed (the token endpoint rejects it)", async () => {
    const { query, stateCookie } = await startAndPick("staff");
    const saved = openEntraState(SECRET, stateCookie)!;
    const res = await callback(query, sealEntraState(SECRET, { ...saved, codeVerifier: "w".repeat(43) }));
    expect(res.headers.location).toBe("/hub/sign-in?error=failed");
  });

  it("refuses as expired: no state cookie, a mismatched state, an expired cookie, or a cookie without a verifier", async () => {
    const { query, stateCookie } = await startAndPick("staff");
    const saved = openEntraState(SECRET, stateCookie)!;
    expect((await callback(query)).headers.location).toBe("/hub/sign-in?error=expired");
    expect((await callback(query, sealEntraState(SECRET, { ...saved, state: "another-state" }))).headers.location).toBe("/hub/sign-in?error=expired");
    expect((await callback(query, sealEntraState(SECRET, saved, Date.now() - 6 * 60_000))).headers.location).toBe("/hub/sign-in?error=expired");
    expect((await callback(query, sealEntraState(SECRET, { ...saved, codeVerifier: "" }))).headers.location).toBe("/hub/sign-in?error=expired");
  });

  it("maps access_denied to cancelled, any other error and a missing code to failed", async () => {
    const { stateCookie } = await startAndPick("staff");
    const state = openEntraState(SECRET, stateCookie)!.state;
    expect((await callback(`error=access_denied&state=${state}`, stateCookie)).headers.location).toBe("/hub/sign-in?error=cancelled");
    expect((await callback(`error=server_error&state=${state}`, stateCookie)).headers.location).toBe("/hub/sign-in?error=failed");
    expect((await callback(`state=${state}`, stateCookie)).headers.location).toBe("/hub/sign-in?error=failed");
  });

  it("sends an unsafe returnTo to /hub/", async () => {
    const { query, stateCookie } = await startAndPick("staff", "https://evil.example.test/hub/");
    expect((await callback(query, stateCookie)).headers.location).toBe("/hub/");
  });

  it("logs only the route, the code and the user id: never tokens, codes, state, emails or names", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    const { query, stateCookie } = await startAndPick("impostor");
    await callback(query, stateCookie);
    await signIn("staff", { aud: "another-client" });
    const params = new URLSearchParams(query);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[core\] entra sign-in refused route=\/auth\/entra\/callback code=conflict user=[0-9a-f-]{36}$/);
    expect(lines[1]).toMatch(/^\[core\] entra sign-in refused route=\/auth\/entra\/callback code=failed error=[A-Z_]+$/);
    for (const secret of [params.get("code")!, params.get("state")!, "taken.person", "Taken Person", "staff.person", "Staff Person"]) {
      expect(lines.join("\n")).not.toContain(secret);
    }
  });

  it("a discovery failure sends the browser back with failed, and is retried on the next sign-in", async () => {
    const broken = createApp({
      db: tdb.db,
      subscribers: [],
      auth: { session: { secret: SECRET } },
      session: { secret: SECRET, secure: true, local: null, entra: createEntraClient({ ...cfg, authority: "http://127.0.0.1:1/nowhere/v2.0" }) },
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await request(broken).get("/auth/entra");
    expect(res.headers.location).toBe("/hub/sign-in?error=failed");
    expect(cookieValue(res, "gcpe_entra")).toBeUndefined();
  });

  it("GET /auth/methods reports Entra and local sign-in", async () => {
    expect((await request(app).get("/auth/methods")).body).toEqual({ entra: true, local: true });
  });
});

describe("sign-in methods and production password rules", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCoreTestDb();
    await createUser(tdb.db, createUserSchema.parse({ email: "pw.user@example.test", displayName: "Password User", roles: ["NRMS.Viewer"], password: PW }), []);
  });
  afterAll(async () => {
    await tdb.drop();
  });
  const entra = () => createEntraClient({ tenantId: TENANT, clientId: "c", clientSecret: "s", authority: "http://127.0.0.1:1/unused/v2.0", redirectUri: REDIRECT });
  const appWith = async (session: { entra: ReturnType<typeof entra> | null; userPasswordsAllowed: boolean; breakGlass: boolean }) =>
    createApp({
      db: tdb.db,
      subscribers: [],
      auth: { session: { secret: SECRET } },
      session: {
        secret: SECRET,
        secure: true,
        local: session.breakGlass ? { username: "admin", passwordHash: await hashPassword("break glass password!"), secret: "local-secret-for-entra-tests-0123456789" } : null,
        entra: session.entra,
        userPasswordsAllowed: session.userPasswordsAllowed,
      },
    });
  const login = (app: express.Express, username: string, password: string) => request(app).post("/auth/login").set("x-gcpe-request", "1").send({ username, password });

  it("Entra off: no Entra routes, passwords as before", async () => {
    const app = await appWith({ entra: null, userPasswordsAllowed: true, breakGlass: false });
    expect((await request(app).get("/auth/methods")).body).toEqual({ entra: false, local: true });
    expect((await request(app).get("/auth/entra")).status).toBe(404);
    expect((await login(app, "pw.user@example.test", PW)).status).toBe(200);
  });

  it("production with Entra on: user passwords refused like a wrong password; break-glass still works", async () => {
    const app = await appWith({ entra: entra(), userPasswordsAllowed: false, breakGlass: true });
    expect((await request(app).get("/auth/methods")).body).toEqual({ entra: true, local: true });
    const refused = await login(app, "pw.user@example.test", PW);
    expect(refused.status).toBe(401);
    expect(refused.body).toEqual({ error: "invalid credentials" });
    expect((await login(app, "admin", "break glass password!")).status).toBe(200);
  });

  it("production with Entra on and no break-glass: the screen offers Microsoft only", async () => {
    const app = await appWith({ entra: entra(), userPasswordsAllowed: false, breakGlass: false });
    expect((await request(app).get("/auth/methods")).body).toEqual({ entra: true, local: false });
  });
});
