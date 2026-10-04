# Phase 3a — Staff Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff sign in once through Core with an email and password, receive one session cookie for the whole site, and every app's API accepts that cookie with the user's roles; Core.Admin manages users and roles.

**Architecture:** `@gcpe/auth` gains a signed session token (HS256, issuer `gcpe-session`) carried in an `HttpOnly` cookie, and `requireBearer` accepts either a bearer token (unchanged) or that cookie, with a CSRF header required on state-changing cookie requests. Core owns `users` and `role_grants`, the `/auth/login|logout|session` endpoints (renewal and active/role re-checks happen in `/auth/session`), and a Core.Admin users API. The stack shares `SESSION_SECRET` with every app, deriving it from `STACK_EVENT_SECRET` when unset so SiteGround needs no new setting.

**Tech Stack:** Node 24, TypeScript 5.9 strict, Express 5, jose 6, Drizzle 0.45 / drizzle-kit 0.31, zod 3.25, express-rate-limit 8, Vitest 4.1, supertest.

**Spec:** `docs/superpowers/specs/2026-10-03-nrms-parity-design.md` §2 (and §10's note on §10.1). Overview of all Phase 3 sub-plans: `docs/superpowers/plans/2026-10-03-phase-3-overview.md`.

## Global Constraints

- Worktree `/Users/paul/gcpe-news-platform-p3`, branch `feat/phase-3`. Commit locally after each task; never push. The worktree has no `node_modules` yet: run `npx -y npm@11 install` once before Task 1.
- Never add a `Co-Authored-By` trailer or any Claude attribution to commits.
- Run tests with: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run <paths>` (the machine's default node is 22). Type-check with `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`.
- Add dependencies with `npx -y npm@11 install <pkg> -w <workspace>`.
- Test databases come from `createTestDatabase` (`@gcpe/db-kit`); every test file drops what it creates in `afterAll`.
- Roles: `Core.Admin`, `NRMS.Editor`, `NRMS.SiteEditor`, `NRMS.Viewer`, `NoD.Admin`, `Distribution.Send`. No ministry scope.
- Session cookie: name `gcpe_session`; `HttpOnly`; `SameSite=Lax`; `Path=/`; `Secure` unless `SESSION_COOKIE_SECURE=false`; lifetime 3600 s; renewal when ≤ 900 s remain.
- `SESSION_SECRET` ≥ 32 characters. CSRF header: `X-GCPE-Request: 1` on every state-changing request authenticated by the cookie, and on `/auth/login` and `/auth/logout`.
- Local passwords ≥ 12 characters, scrypt via the existing `hashPassword`/`verifyPassword`. Emails stored trimmed and lowercased; matched case-insensitively.
- The environment `admin` (LOCAL_ADMIN_*) stays as break-glass: it signs in through the same `/auth/login` with username `admin` and gets `ADMIN_ROLES`.
- Secrets and passwords are never printed, logged, or written to disk by any script.
- **Ruling (spec §2 renewal):** the spec says "any authenticated request in the last 15 minutes renews it, and renewal re-checks the user is still active". Only Core can check the database, so renewal lives in `GET /core/auth/session`; the staff app (3f) calls it on load and every 5 minutes. Other apps accept the cookie until it expires (≤ 1 hour after Core last renewed it). Cost if wrong: a deactivated user's API access outside Core lasts up to an hour.

## Review Focus

1. Email typed with different case or surrounding spaces (`  Editor@Example.TEST `) at login or creation → signs in / is detected as a duplicate exactly as the lowercase form would. (Task 2 tests.)
2. A user deactivated, or with roles changed, while holding a cookie → the next `/auth/session` call clears or reissues the cookie with current roles. (Task 3 tests.)
3. A request carrying both a valid bearer token and a stale/garbage session cookie → the bearer token decides; the cookie is ignored. (Task 1 tests.)
4. An admin removing their own Core.Admin role or deactivating themself → refused with 409, so the last admin can't lock everyone out by accident. (Task 4 tests.)
5. A session token presented as `Authorization: Bearer …`, or a local-admin bearer token presented as the cookie → rejected (different issuers), even though both use HS256. (Task 1 tests.)

---

## File structure

| File | Responsibility |
|---|---|
| `packages/auth/src/roles.ts` (new) | `STAFF_ROLES`, `StaffRole` |
| `packages/auth/src/session.ts` (new) | Mint/verify session tokens; cookie read/write helpers; CSRF header name |
| `packages/auth/src/bearer.ts` | `requireBearer` accepts the session cookie; `requireAnyRole`; `actorOf` |
| `packages/auth/src/from-env.ts` | Reads `SESSION_SECRET` |
| `packages/auth/src/local.ts` | `ADMIN_ROLES` gains `NRMS.SiteEditor` |
| `packages/auth/src/cli/read-hidden.ts` (new) | `readHidden(label)` for TTY prompts, shared by CLIs |
| `apps/core/src/db/schema.ts` + `migrations/0001_users.sql` | `users`, `role_grants` |
| `apps/core/src/services/users.ts` (new) | User/role storage and password checks |
| `apps/core/src/services/seed-test-users.ts` (new) | Idempotent creation of the three test users |
| `apps/core/src/http/session.ts` (new) | `/auth/login`, `/auth/logout`, `/auth/session` |
| `apps/core/src/http/users.ts` (new) | Core.Admin users API |
| `apps/core/src/cli/seed-test-users.ts` (new) | Local CLI wrapper with hidden prompts |
| `scripts/siteground-seed-users.sh` (new) | Same seeding against a deployed stack, through the users API |
| `apps/stack/src/env.ts`, `apps/stack/src/stack.ts` | Share/derive `SESSION_SECRET`; combined login limiter covers `/core/auth/login` |

---

### Task 1: Session tokens and cookie authentication in `@gcpe/auth`

**Files:**
- Create: `packages/auth/src/roles.ts`, `packages/auth/src/session.ts`, `packages/auth/src/session.test.ts`
- Modify: `packages/auth/src/bearer.ts`, `packages/auth/src/from-env.ts`, `packages/auth/src/from-env.test.ts`, `packages/auth/src/local.ts:8`, `packages/auth/src/index.ts`

**Interfaces:**
- Consumes: `assertSecretStrength`, `localKey` (`packages/auth/src/local.ts`).
- Produces:
  - `STAFF_ROLES: readonly ["Core.Admin","NRMS.Editor","NRMS.SiteEditor","NRMS.Viewer","NoD.Admin","Distribution.Send"]`, `type StaffRole`
  - `SESSION_COOKIE = "gcpe_session"`, `SESSION_ISSUER = "gcpe-session"`, `SESSION_TTL_SECONDS = 3600`, `SESSION_RENEW_WINDOW_SECONDS = 900`, `CSRF_HEADER = "x-gcpe-request"`
  - `interface SessionUser { id: string; name: string; email: string; roles: string[] }`, `interface VerifiedSession extends SessionUser { expiresAt: number }` (unix seconds)
  - `mintSession(secret: string, user: SessionUser, ttlSeconds?: number): Promise<{ token: string; expiresAt: number }>`
  - `verifySession(secret: string, token: string): Promise<VerifiedSession>` (throws on any failure)
  - `readCookie(header: string | undefined, name: string): string | undefined`
  - `sessionCookie(token: string, opts: { secure: boolean; maxAgeSeconds: number }): string`, `clearedSessionCookie(opts: { secure: boolean }): string`
  - `BearerOptions.session?: { secret: string }`; `requireAnyRole(...roles: string[]): RequestHandler`; `actorOf(req: Request): { id: string; name: string }`
  - `authFromEnv(env)` now returns `{ bearer, loginRouter, local, session: { secret: string } | null }`

- [ ] **Step 1: Write the failing tests**

Create `packages/auth/src/session.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { actorOf, requireAnyRole, requireBearer } from "./bearer";
import { mintLocalToken } from "./local";
import { STAFF_ROLES } from "./roles";
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
    expect(STAFF_ROLES).toEqual(["Core.Admin", "NRMS.Editor", "NRMS.SiteEditor", "NRMS.Viewer", "NoD.Admin", "Distribution.Send"]);
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
```

Append to `packages/auth/src/from-env.test.ts` (inside its top-level `describe`, reusing that file's existing env fixture — read the file first and follow its naming; the fixture with `LOCAL_ADMIN_ENABLED: "true"` is the base):

```ts
  it("reads SESSION_SECRET (>= 32 chars) into bearer.session and session", async () => {
    const base = { LOCAL_ADMIN_ENABLED: "true", LOCAL_ADMIN_PASSWORD_HASH: await hashPassword("a-long-enough-password"), LOCAL_AUTH_SECRET: "l".repeat(40) };
    expect(authFromEnv(base).session).toBeNull();
    const withSession = authFromEnv({ ...base, SESSION_SECRET: "x".repeat(40) });
    expect(withSession.session).toEqual({ secret: "x".repeat(40) });
    expect(withSession.bearer.session).toEqual({ secret: "x".repeat(40) });
    expect(() => authFromEnv({ ...base, SESSION_SECRET: "short" })).toThrow(/SESSION_SECRET must be at least 32 characters/);
  });
```

(If `hashPassword` isn't already imported in that file, add `import { hashPassword } from "./password";`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/auth`
Expected: FAIL — `./session` and `./roles` don't exist; `requireAnyRole`/`actorOf` aren't exported.

- [ ] **Step 3: Implement**

Create `packages/auth/src/roles.ts`:

```ts
/** Every role a staff user can hold (spec addendum §2). No ministry scope — legacy has none. */
export const STAFF_ROLES = ["Core.Admin", "NRMS.Editor", "NRMS.SiteEditor", "NRMS.Viewer", "NoD.Admin", "Distribution.Send"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
```

Create `packages/auth/src/session.ts`:

```ts
import { jwtVerify, SignJWT } from "jose";
import { assertSecretStrength, localKey } from "./local";

/**
 * Staff session (spec addendum §2): Core signs one token per sign-in and sets it as an
 * HttpOnly cookie for the whole site; every app's API accepts it (see requireBearer). The
 * issuer/audience differ from the local-admin bearer token's, so neither token can be replayed
 * as the other even when the same secret is configured for both.
 */
export const SESSION_COOKIE = "gcpe_session";
export const SESSION_ISSUER = "gcpe-session";
export const SESSION_TTL_SECONDS = 60 * 60;
/** /core/auth/session reissues the cookie once this little lifetime remains. */
export const SESSION_RENEW_WINDOW_SECONDS = 15 * 60;
/** Required (value "1") on every state-changing request authenticated by the cookie: a
 * cross-site form can't set a custom header, so this plus SameSite=Lax blocks CSRF. */
export const CSRF_HEADER = "x-gcpe-request";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  roles: string[];
}

export interface VerifiedSession extends SessionUser {
  /** Unix seconds. */
  expiresAt: number;
}

export async function mintSession(secret: string, user: SessionUser, ttlSeconds = SESSION_TTL_SECONDS): Promise<{ token: string; expiresAt: number }> {
  assertSecretStrength(secret);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ttlSeconds;
  const token = await new SignJWT({ name: user.name, email: user.email, roles: [...user.roles] })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_ISSUER)
    .setSubject(user.id)
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .sign(localKey(secret));
  return { token, expiresAt };
}

export async function verifySession(secret: string, token: string): Promise<VerifiedSession> {
  const { payload } = await jwtVerify(token, localKey(secret), {
    issuer: SESSION_ISSUER,
    audience: SESSION_ISSUER,
    algorithms: ["HS256"],
    requiredClaims: ["exp", "iat", "sub"],
    maxTokenAge: `${SESSION_TTL_SECONDS}s`,
  });
  return {
    id: String(payload.sub),
    name: typeof payload.name === "string" ? payload.name : String(payload.sub),
    email: typeof payload.email === "string" ? payload.email : "",
    roles: Array.isArray(payload.roles) ? payload.roles.map(String) : [],
    expiresAt: payload.exp!,
  };
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function sessionCookie(token: string, opts: { secure: boolean; maxAgeSeconds: number }): string {
  return [`${SESSION_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${opts.maxAgeSeconds}`, ...(opts.secure ? ["Secure"] : [])].join("; ");
}

export function clearedSessionCookie(opts: { secure: boolean }): string {
  return sessionCookie("", { ...opts, maxAgeSeconds: 0 });
}
```

In `packages/auth/src/bearer.ts`:
- Change the express import to `import type { Request, RequestHandler } from "express";`
- Add `import { CSRF_HEADER, readCookie, SESSION_COOKIE, verifySession, type VerifiedSession } from "./session";`
- Add to `BearerOptions`: `/** Accept Core's staff session cookie (spec addendum §2). */ session?: { secret: string };`
- In `requireBearer`, after `const local = …`, add:

```ts
  if (opts.session) assertSecretStrength(opts.session.secret);
  const sessionSecret = opts.session?.secret;
```

- Replace the first two lines of the returned handler (`const header = …` and the `if (!header?.startsWith("Bearer "))` line) with:

```ts
    const header = req.header("authorization");
    if (!header?.startsWith("Bearer ")) {
      // No bearer token: fall back to the staff session cookie when sessions are configured.
      // A bearer token, when present, always decides — a stale cookie can't override it.
      const cookie = sessionSecret ? readCookie(req.header("cookie"), SESSION_COOKIE) : undefined;
      if (!cookie) return void res.status(401).json({ error: "missing bearer token" });
      let session: VerifiedSession;
      try {
        session = await verifySession(sessionSecret!, cookie);
      } catch {
        return void res.status(401).json({ error: "invalid session" });
      }
      if (!SAFE_METHODS.has(req.method) && req.header(CSRF_HEADER) !== "1") {
        return void res.status(403).json({ error: "missing X-GCPE-Request header" });
      }
      req.auth = { subject: session.id, roles: session.roles, claims: { name: session.name, email: session.email, via: "session" } };
      return next();
    }
```

- Above `requireBearer`, add `const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);`
- After `requireRole`, add:

```ts
export function requireAnyRole(...roles: string[]): RequestHandler {
  return (req, res, next) => (req.auth?.roles.some((r) => roles.includes(r)) ? next() : void res.status(403).json({ error: "forbidden" }));
}

/** Who is acting, for audit logs: the session user's id and display name, or the token subject. */
export function actorOf(req: Request): { id: string; name: string } {
  const id = req.auth?.subject ?? "anonymous";
  const name = req.auth?.claims.name;
  return { id, name: typeof name === "string" && name ? name : id };
}
```

In `packages/auth/src/from-env.ts`:
- Add to the schema object: `SESSION_SECRET: z.string().optional(),`
- Add inside `superRefine`, first line: `if (e.SESSION_SECRET !== undefined && e.SESSION_SECRET.length < 32) ctx.addIssue({ code: "custom", message: "SESSION_SECRET must be at least 32 characters" });`
- Change the return type to `{ bearer: BearerOptions; loginRouter: Router | null; local: LocalAuthConfig | null; session: { secret: string } | null }`
- In the returned `bearer` object add `...(e.SESSION_SECRET ? { session: { secret: e.SESSION_SECRET } } : {}),` and add `session: e.SESSION_SECRET ? { secret: e.SESSION_SECRET } : null,` to the returned object.

In `packages/auth/src/local.ts:8` replace the constant with:

```ts
export const ADMIN_ROLES = ["Core.Admin", "NRMS.Editor", "NRMS.SiteEditor", "NoD.Admin", "Distribution.Send"] as const;
```

Replace `packages/auth/src/index.ts` with:

```ts
export { actorOf, entraIssuer, entraJwks, requireAnyRole, requireBearer, requireRole, type AuthContext, type BearerOptions } from "./bearer";
export { createClientCredentialsProvider } from "./client-credentials";
export { authFromEnv } from "./from-env";
export { ADMIN_ROLES, LOCAL_AUDIENCE, LOCAL_ISSUER, localLoginRouter, mintLocalToken, type LocalAuthConfig } from "./local";
export { hashPassword, verifyPassword } from "./password";
export { STAFF_ROLES, type StaffRole } from "./roles";
export {
  clearedSessionCookie,
  CSRF_HEADER,
  mintSession,
  readCookie,
  SESSION_COOKIE,
  SESSION_ISSUER,
  SESSION_RENEW_WINDOW_SECONDS,
  SESSION_TTL_SECONDS,
  sessionCookie,
  verifySession,
  type SessionUser,
  type VerifiedSession,
} from "./session";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run packages/auth`
Expected: PASS (all existing auth tests still pass).

Then the whole suite and type-check, since `ADMIN_ROLES` and `authFromEnv`'s return type are shared:
Run: `npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json && npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run`
Expected: PASS. If a test pinned the old `ADMIN_ROLES` list, update it to include `NRMS.SiteEditor`.

- [ ] **Step 5: Commit**

```bash
git add packages/auth
git commit -m "feat(auth): staff session cookie accepted alongside bearer tokens, with CSRF header"
```

---

### Task 2: Core users and role grants

**Files:**
- Modify: `apps/core/src/db/schema.ts`
- Create: `apps/core/migrations/0001_users.sql` (generated), `apps/core/src/services/users.ts`, `apps/core/src/services/users.test.ts`

**Interfaces:**
- Consumes: `hashPassword`, `verifyPassword`, `STAFF_ROLES`, `type SessionUser` from `@gcpe/auth` (Task 1).
- Produces (all in `apps/core/src/services/users.ts`):
  - `createUserSchema`, `updateUserSchema`, `setRolesSchema`, `setPasswordSchema` (zod)
  - `interface UserView { id: string; email: string; displayName: string; isActive: boolean; signInMethod: "local" | "entra"; roles: string[] }`
  - `class UserExistsError extends Error`, `class UserNotFoundError extends Error`
  - `listUsers(db): Promise<UserView[]>`, `getUser(db, id): Promise<UserView | null>`, `findUserByEmail(db, email): Promise<UserView | null>`
  - `createUser(db, input: CreateUserInput): Promise<UserView>`, `updateUser(db, id, patch: UpdateUserInput): Promise<UserView>`, `setRoles(db, id, roles: string[]): Promise<UserView>`, `setPassword(db, id, password: string): Promise<void>`
  - `authenticate(db, email, password): Promise<UserView | null>`, `sessionUserFor(db, id): Promise<SessionUser | null>`

- [ ] **Step 1: Add the tables**

In `apps/core/src/db/schema.ts`, change the pg-core import to:

```ts
import { boolean, check, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
```

and append:

```ts
/** Staff users (spec addendum §2). Emails are stored trimmed and lowercased. */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    signInMethod: text("sign_in_method").$type<"local" | "entra">().notNull().default("local"),
    passwordHash: text("password_hash"),
    legacyId: uuid("legacy_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("users_email_lower_idx").on(sql`lower(${t.email})`),
    check("users_sign_in_method_check", sql`${t.signInMethod} IN ('local','entra')`),
  ],
);

export const roleGrants = pgTable(
  "role_grants",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.role] })],
);
```

- [ ] **Step 2: Generate the migration**

Run: `cd apps/core && npx -y -p node@24 -- node ../../node_modules/drizzle-kit/bin.cjs generate --name users && cd ../..`
Expected: creates `apps/core/migrations/0001_users.sql` containing `CREATE TABLE "users"`, `CREATE TABLE "role_grants"`, the `users_email_lower_idx` unique index on `lower("email")`, and the foreign key with `ON DELETE cascade`; `meta/_journal.json` gains entry `0001_users`. Open the SQL and confirm those four things before continuing.

- [ ] **Step 3: Write the failing tests**

Create `apps/core/src/services/users.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCoreTestDb } from "../../test/helpers";
import {
  authenticate,
  createUser,
  createUserSchema,
  findUserByEmail,
  getUser,
  listUsers,
  sessionUserFor,
  setPassword,
  setRoles,
  updateUser,
  UserExistsError,
  UserNotFoundError,
} from "./users";

const PW = "correct horse battery";

describe("users service", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCoreTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("creates a user with roles, normalising the email, and never exposes the hash", async () => {
    const u = await createUser(tdb.db, createUserSchema.parse({ email: "  Editor@Example.TEST ", displayName: "Test Editor", roles: ["NRMS.Editor", "NRMS.Editor"], password: PW }));
    expect(u).toEqual({ id: expect.any(String), email: "editor@example.test", displayName: "Test Editor", isActive: true, signInMethod: "local", roles: ["NRMS.Editor"] });
    expect(Object.keys(u)).not.toContain("passwordHash");
    expect(await getUser(tdb.db, u.id)).toEqual(u);
    expect(await findUserByEmail(tdb.db, "EDITOR@example.test")).toEqual(u);
    expect((await listUsers(tdb.db)).map((x) => x.email)).toContain("editor@example.test");
  });

  it("refuses a duplicate email in any case", async () => {
    await expect(createUser(tdb.db, createUserSchema.parse({ email: "EDITOR@example.test", displayName: "Dup" }))).rejects.toBeInstanceOf(UserExistsError);
  });

  it("rejects unknown roles and short passwords at the schema", () => {
    expect(createUserSchema.safeParse({ email: "a@example.test", displayName: "A", roles: ["NRMS.God"] }).success).toBe(false);
    expect(createUserSchema.safeParse({ email: "a@example.test", displayName: "A", password: "short" }).success).toBe(false);
  });

  it("authenticates by email in any case and with surrounding spaces", async () => {
    expect((await authenticate(tdb.db, " editor@EXAMPLE.test ", PW))?.email).toBe("editor@example.test");
    expect(await authenticate(tdb.db, "editor@example.test", "wrong password!!")).toBeNull();
    expect(await authenticate(tdb.db, "nobody@example.test", PW)).toBeNull();
  });

  it("refuses inactive users and users without a password", async () => {
    const noPw = await createUser(tdb.db, createUserSchema.parse({ email: "entra@example.test", displayName: "Entra Person" }));
    expect(await authenticate(tdb.db, "entra@example.test", PW)).toBeNull();
    const v = await createUser(tdb.db, createUserSchema.parse({ email: "viewer@example.test", displayName: "Viewer", roles: ["NRMS.Viewer"], password: PW }));
    await updateUser(tdb.db, v.id, { isActive: false });
    expect(await authenticate(tdb.db, "viewer@example.test", PW)).toBeNull();
    expect(await sessionUserFor(tdb.db, v.id)).toBeNull();
    expect(await sessionUserFor(tdb.db, noPw.id)).toEqual({ id: noPw.id, name: "Entra Person", email: "entra@example.test", roles: [] });
  });

  it("replaces roles, resets passwords, and 404s unknown or malformed ids", async () => {
    const u = (await findUserByEmail(tdb.db, "editor@example.test"))!;
    expect((await setRoles(tdb.db, u.id, ["NRMS.Viewer", "Core.Admin", "Core.Admin"])).roles).toEqual(["Core.Admin", "NRMS.Viewer"]);
    await setPassword(tdb.db, u.id, "a brand new passphrase");
    expect(await authenticate(tdb.db, "editor@example.test", PW)).toBeNull();
    expect(await authenticate(tdb.db, "editor@example.test", "a brand new passphrase")).not.toBeNull();
    await expect(setRoles(tdb.db, "00000000-0000-4000-8000-000000000000", [])).rejects.toBeInstanceOf(UserNotFoundError);
    expect(await getUser(tdb.db, "not-a-uuid")).toBeNull();
    expect(await sessionUserFor(tdb.db, "local:admin")).toBeNull();
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/core/src/services/users.test.ts`
Expected: FAIL — `./users` doesn't exist.

- [ ] **Step 5: Implement**

Create `apps/core/src/services/users.ts`:

```ts
import { asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbOrTx } from "@gcpe/db-kit";
import { hashPassword, STAFF_ROLES, verifyPassword, type SessionUser } from "@gcpe/auth";
import { roleGrants, users } from "../db/schema";

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(12, "use at least 12 characters").max(200);
const roles = z.array(z.enum(STAFF_ROLES)).max(20);
const displayName = z.string().trim().min(1).max(100);

export const createUserSchema = z.object({ email, displayName, roles: roles.default([]), password: password.optional() });
export type CreateUserInput = z.infer<typeof createUserSchema>;
export const updateUserSchema = z
  .object({ displayName: displayName.optional(), isActive: z.boolean().optional() })
  .refine((v) => v.displayName !== undefined || v.isActive !== undefined, "nothing to update");
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export const setRolesSchema = z.object({ roles });
export const setPasswordSchema = z.object({ password });

export interface UserView {
  id: string;
  email: string;
  displayName: string;
  isActive: boolean;
  signInMethod: "local" | "entra";
  roles: string[];
}

export class UserExistsError extends Error {}
export class UserNotFoundError extends Error {}

const isUuid = (id: string) => z.string().uuid().safeParse(id).success;
// drizzle wraps driver errors; the pg error (with .code) is on .cause.
const isUniqueViolation = (e: unknown) => (e as { cause?: { code?: string } }).cause?.code === "23505";

type UserRow = typeof users.$inferSelect;

async function withRoles(db: DbOrTx, rows: UserRow[]): Promise<UserView[]> {
  if (rows.length === 0) return [];
  const grants = await db.select().from(roleGrants).where(inArray(roleGrants.userId, rows.map((r) => r.id)));
  const byUser = new Map<string, string[]>();
  for (const g of grants) byUser.set(g.userId, [...(byUser.get(g.userId) ?? []), g.role]);
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    displayName: r.displayName,
    isActive: r.isActive,
    signInMethod: r.signInMethod,
    roles: (byUser.get(r.id) ?? []).sort(),
  }));
}

export async function listUsers(db: Db): Promise<UserView[]> {
  return withRoles(db, await db.select().from(users).orderBy(asc(sql`lower(${users.displayName})`), asc(users.email)));
}

export async function getUser(db: DbOrTx, id: string): Promise<UserView | null> {
  if (!isUuid(id)) return null;
  const rows = await db.select().from(users).where(eq(users.id, id));
  return (await withRoles(db, rows))[0] ?? null;
}

export async function findUserByEmail(db: Db, address: string): Promise<UserView | null> {
  const rows = await db.select().from(users).where(sql`lower(${users.email}) = ${address.trim().toLowerCase()}`);
  return (await withRoles(db, rows))[0] ?? null;
}

export async function createUser(db: Db, input: CreateUserInput): Promise<UserView> {
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  try {
    const id = await db.transaction(async (tx) => {
      const [row] = await tx.insert(users).values({ email: input.email, displayName: input.displayName, passwordHash }).returning({ id: users.id });
      const unique = [...new Set(input.roles)];
      if (unique.length) await tx.insert(roleGrants).values(unique.map((role) => ({ userId: row!.id, role })));
      return row!.id;
    });
    return (await getUser(db, id))!;
  } catch (e) {
    if (isUniqueViolation(e)) throw new UserExistsError(input.email);
    throw e;
  }
}

export async function updateUser(db: Db, id: string, patch: UpdateUserInput): Promise<UserView> {
  if (!isUuid(id)) throw new UserNotFoundError(id);
  const updated = await db
    .update(users)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(users.id, id))
    .returning({ id: users.id });
  if (updated.length === 0) throw new UserNotFoundError(id);
  return (await getUser(db, id))!;
}

export async function setRoles(db: Db, id: string, next: string[]): Promise<UserView> {
  if (!isUuid(id)) throw new UserNotFoundError(id);
  await db.transaction(async (tx) => {
    const found = await tx.execute(sql`SELECT id FROM ${users} WHERE id = ${id} FOR UPDATE`);
    if (found.rows.length === 0) throw new UserNotFoundError(id);
    await tx.delete(roleGrants).where(eq(roleGrants.userId, id));
    const unique = [...new Set(next)];
    if (unique.length) await tx.insert(roleGrants).values(unique.map((role) => ({ userId: id, role })));
    await tx.update(users).set({ updatedAt: new Date() }).where(eq(users.id, id));
  });
  return (await getUser(db, id))!;
}

export async function setPassword(db: Db, id: string, pw: string): Promise<void> {
  if (!isUuid(id)) throw new UserNotFoundError(id);
  const passwordHash = await hashPassword(pw);
  const updated = await db.update(users).set({ passwordHash, signInMethod: "local", updatedAt: new Date() }).where(eq(users.id, id)).returning({ id: users.id });
  if (updated.length === 0) throw new UserNotFoundError(id);
}

// Compared against when the email is unknown or has no password, so every sign-in attempt
// costs exactly one scrypt verification (no timing tell for "no such user").
let dummyHash: Promise<string> | undefined;

export async function authenticate(db: Db, address: string, pw: string): Promise<UserView | null> {
  const [row] = await db.select().from(users).where(sql`lower(${users.email}) = ${address.trim().toLowerCase()}`);
  const stored = row?.passwordHash ?? (await (dummyHash ??= hashPassword("placeholder-never-matches-anything")));
  const ok = await verifyPassword(pw, stored);
  if (!row || !row.isActive || !row.passwordHash || !ok) return null;
  return getUser(db, row.id);
}

/** The current identity for a session, or null if the user no longer exists or is inactive. */
export async function sessionUserFor(db: Db, id: string): Promise<SessionUser | null> {
  const u = await getUser(db, id);
  return u && u.isActive ? { id: u.id, name: u.displayName, email: u.email, roles: u.roles } : null;
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/core`
Expected: PASS (existing Core tests unaffected).

- [ ] **Step 7: Commit**

```bash
git add apps/core
git commit -m "feat(core): staff users and role grants"
```

---

### Task 3: Core sign-in endpoints

**Files:**
- Create: `apps/core/src/http/session.ts`, `apps/core/src/http/session.test.ts`
- Modify: `apps/core/src/app.ts`, `apps/core/src/start.ts`, `apps/core/package.json` (dependency)

**Interfaces:**
- Consumes: Task 1 (`mintSession`, `verifySession`, `readCookie`, `sessionCookie`, `clearedSessionCookie`, `CSRF_HEADER`, `SESSION_*`, `ADMIN_ROLES`, `verifyPassword`, `LocalAuthConfig`); Task 2 (`authenticate`, `sessionUserFor`).
- Produces:
  - `sessionRoutes(deps: { db: Db; secret: string; secure: boolean; local: LocalAuthConfig | null; ratePerMinute?: number }): Router` with `POST /auth/login` (body `{ username, password }` → 200 `{ user: SessionUser, expiresAt: ISO string }` + Set-Cookie), `POST /auth/logout` (204), `GET /auth/session` (200 same shape, or 401 `{ error: "not signed in" }` with the cookie cleared)
  - `BREAK_GLASS_ID = "local:admin"`
  - `createApp` deps gain `session?: { secret: string; secure: boolean; local: LocalAuthConfig | null }`
  - Core env gains `SESSION_COOKIE_SECURE` (`"true"` default)

- [ ] **Step 1: Add the dependency**

Run: `npx -y npm@11 install express-rate-limit@^8.3.1 -w @gcpe/core`

- [ ] **Step 2: Write the failing tests**

Create `apps/core/src/http/session.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { hashPassword, mintSession } from "@gcpe/auth";
import { createCoreTestDb } from "../../test/helpers";
import { createApp } from "../app";
import { createUser, createUserSchema, setRoles, updateUser } from "../services/users";

const SECRET = "session-secret-for-core-tests-0123456789";
const PW = "correct horse battery";
const ADMIN_PW = "break glass password!";

function sessionToken(res: request.Response): string | undefined {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
  const c = raw?.find((v) => v.startsWith("gcpe_session="));
  return c?.slice("gcpe_session=".length).split(";")[0];
}

describe("Core sign-in", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let editorId: string;

  beforeAll(async () => {
    tdb = await createCoreTestDb();
    const local = { username: "admin", passwordHash: await hashPassword(ADMIN_PW), secret: "local-secret-for-core-tests-0123456789" };
    app = createApp({ db: tdb.db, subscribers: [], auth: { session: { secret: SECRET } }, session: { secret: SECRET, secure: true, local } });
    editorId = (await createUser(tdb.db, createUserSchema.parse({ email: "editor@example.test", displayName: "Test Editor", roles: ["NRMS.Editor"], password: PW }))).id;
  });
  afterAll(async () => {
    await tdb.drop();
  });

  const login = (username: string, password: string, csrf = true) => {
    const r = request(app).post("/auth/login").send({ username, password });
    return csrf ? r.set("x-gcpe-request", "1") : r;
  };

  it("refuses a login without the CSRF header", async () => {
    expect((await login("editor@example.test", PW, false)).status).toBe(403);
  });

  it("refuses wrong credentials with one message", async () => {
    expect((await login("editor@example.test", "wrong password!!")).body).toEqual({ error: "invalid credentials" });
    expect((await login("nobody@example.test", PW)).status).toBe(401);
    expect((await login("", "")).status).toBe(401);
  });

  it("signs in (email in any case) and sets a secure HttpOnly cookie", async () => {
    const res = await login("  EDITOR@example.test ", PW);
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ id: editorId, name: "Test Editor", email: "editor@example.test", roles: ["NRMS.Editor"] });
    const raw = (res.headers["set-cookie"] as unknown as string[])[0]!;
    expect(raw).toMatch(/^gcpe_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=3600; Secure$/);
  });

  it("the cookie authenticates Core's API; writes need the CSRF header", async () => {
    const token = sessionToken(await login("editor@example.test", PW))!;
    expect((await request(app).get("/api/organizations").set("cookie", `gcpe_session=${token}`)).status).toBe(200);
    const write = await request(app).post("/api/admin/republish").set("cookie", `gcpe_session=${token}`);
    expect(write.status).toBe(403);
    expect(write.body).toEqual({ error: "missing X-GCPE-Request header" });
  });

  it("GET /auth/session returns the user without reissuing a fresh cookie", async () => {
    const token = sessionToken(await login("editor@example.test", PW))!;
    const res = await request(app).get("/auth/session").set("cookie", `gcpe_session=${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(editorId);
    expect(sessionToken(res)).toBeUndefined();
  });

  it("renews a cookie in its last 15 minutes", async () => {
    const { token } = await mintSession(SECRET, { id: editorId, name: "Test Editor", email: "editor@example.test", roles: ["NRMS.Editor"] }, 600);
    const res = await request(app).get("/auth/session").set("cookie", `gcpe_session=${token}`);
    expect(res.status).toBe(200);
    expect(sessionToken(res)).toBeDefined();
  });

  it("reissues at once when roles changed, and signs out a deactivated user", async () => {
    const token = sessionToken(await login("editor@example.test", PW))!;
    await setRoles(tdb.db, editorId, ["NRMS.Viewer"]);
    const changed = await request(app).get("/auth/session").set("cookie", `gcpe_session=${token}`);
    expect(changed.body.user.roles).toEqual(["NRMS.Viewer"]);
    expect(sessionToken(changed)).toBeDefined();
    await updateUser(tdb.db, editorId, { isActive: false });
    const gone = await request(app).get("/auth/session").set("cookie", `gcpe_session=${token}`);
    expect(gone.status).toBe(401);
    expect(sessionToken(gone)).toBe("");
    await updateUser(tdb.db, editorId, { isActive: true });
    await setRoles(tdb.db, editorId, ["NRMS.Editor"]);
  });

  it("401s with no cookie or a garbage cookie", async () => {
    expect((await request(app).get("/auth/session")).status).toBe(401);
    expect((await request(app).get("/auth/session").set("cookie", "gcpe_session=garbage")).status).toBe(401);
  });

  it("break-glass admin signs in through the same endpoint", async () => {
    const res = await login("admin", ADMIN_PW);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: "local:admin", roles: ["Core.Admin", "NRMS.Editor", "NRMS.SiteEditor", "NoD.Admin", "Distribution.Send"] });
    const token = sessionToken(res)!;
    expect((await request(app).get("/auth/session").set("cookie", `gcpe_session=${token}`)).status).toBe(200);
    expect((await login("admin", "not the password")).status).toBe(401);
  });

  it("logout needs the CSRF header and clears the cookie", async () => {
    expect((await request(app).post("/auth/logout")).status).toBe(403);
    const res = await request(app).post("/auth/logout").set("x-gcpe-request", "1");
    expect(res.status).toBe(204);
    expect(sessionToken(res)).toBe("");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/core/src/http/session.test.ts`
Expected: FAIL — `createApp` has no `session` option / `/auth/login` is 404.

- [ ] **Step 4: Implement**

Create `apps/core/src/http/session.ts`:

```ts
import express, { Router, type RequestHandler, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import type { Db } from "@gcpe/db-kit";
import {
  ADMIN_ROLES,
  clearedSessionCookie,
  CSRF_HEADER,
  mintSession,
  readCookie,
  SESSION_COOKIE,
  SESSION_RENEW_WINDOW_SECONDS,
  SESSION_TTL_SECONDS,
  sessionCookie,
  verifyPassword,
  verifySession,
  type LocalAuthConfig,
  type SessionUser,
  type VerifiedSession,
} from "@gcpe/auth";
import { authenticate, sessionUserFor } from "../services/users";

/** Session id for the environment break-glass admin (LOCAL_ADMIN_*); it has no users row. */
export const BREAK_GLASS_ID = "local:admin";
const BREAK_GLASS_NAME = "Administrator (break-glass)";

const loginSchema = z.object({ username: z.string().max(254), password: z.string().max(200) });

export interface SessionRouteDeps {
  db: Db;
  secret: string;
  secure: boolean;
  local: LocalAuthConfig | null;
  ratePerMinute?: number;
}

const sameRoles = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((r, i) => r === [...b].sort()[i]);

/**
 * Staff sign-in (spec addendum §2): one cookie for the whole site. Renewal and the
 * still-active / current-roles re-check happen here, in GET /auth/session — the only place
 * with the users table (see plan ruling on renewal).
 */
export function sessionRoutes(deps: SessionRouteDeps): Router {
  const r = Router();
  const clear = (res: Response) => res.setHeader("set-cookie", clearedSessionCookie({ secure: deps.secure }));
  const requireCsrf: RequestHandler = (req, res, next) =>
    req.header(CSRF_HEADER) === "1" ? next() : void res.status(403).json({ error: "missing X-GCPE-Request header" });
  const issue = async (res: Response, user: SessionUser) => {
    const { token, expiresAt } = await mintSession(deps.secret, user);
    res.setHeader("set-cookie", sessionCookie(token, { secure: deps.secure, maxAgeSeconds: SESSION_TTL_SECONDS }));
    res.json({ user, expiresAt: new Date(expiresAt * 1000).toISOString() });
  };
  const notSignedIn = (res: Response) => {
    clear(res);
    res.status(401).json({ error: "not signed in" });
  };

  r.post(
    "/auth/login",
    rateLimit({ windowMs: 60_000, limit: deps.ratePerMinute ?? 10, standardHeaders: "draft-7", legacyHeaders: false }),
    requireCsrf,
    express.json({ limit: "1kb" }),
    async (req, res, next) => {
      try {
        const parsed = loginSchema.safeParse(req.body ?? {});
        if (!parsed.success) return void res.status(401).json({ error: "invalid credentials" });
        const { username, password } = parsed.data;
        // Exactly one scrypt verification on every path, so timing doesn't reveal which path ran.
        if (deps.local && username === deps.local.username) {
          if (!(await verifyPassword(password, deps.local.passwordHash))) return void res.status(401).json({ error: "invalid credentials" });
          return void (await issue(res, { id: BREAK_GLASS_ID, name: BREAK_GLASS_NAME, email: "", roles: [...ADMIN_ROLES] }));
        }
        const user = await authenticate(deps.db, username, password);
        if (!user) return void res.status(401).json({ error: "invalid credentials" });
        await issue(res, { id: user.id, name: user.displayName, email: user.email, roles: user.roles });
      } catch (e) {
        next(e);
      }
    },
  );

  r.post("/auth/logout", requireCsrf, (_req, res) => {
    clear(res);
    res.status(204).end();
  });

  r.get("/auth/session", async (req, res, next) => {
    try {
      const cookie = readCookie(req.header("cookie"), SESSION_COOKIE);
      if (!cookie) return void res.status(401).json({ error: "not signed in" });
      let session: VerifiedSession;
      try {
        session = await verifySession(deps.secret, cookie);
      } catch {
        return notSignedIn(res);
      }
      const current: SessionUser | null =
        session.id === BREAK_GLASS_ID
          ? deps.local
            ? { id: BREAK_GLASS_ID, name: BREAK_GLASS_NAME, email: "", roles: [...ADMIN_ROLES] }
            : null
          : await sessionUserFor(deps.db, session.id);
      if (!current) return notSignedIn(res);
      const remaining = session.expiresAt - Math.floor(Date.now() / 1000);
      if (remaining <= SESSION_RENEW_WINDOW_SECONDS || !sameRoles(session.roles, current.roles) || session.name !== current.name) {
        return void (await issue(res, current));
      }
      res.json({ user: current, expiresAt: new Date(session.expiresAt * 1000).toISOString() });
    } catch (e) {
      next(e);
    }
  });

  return r;
}
```

In `apps/core/src/app.ts`:
- Add imports: `import type { LocalAuthConfig } from "@gcpe/auth";` (merge into the existing `@gcpe/auth` import) and `import { sessionRoutes } from "./http/session";`
- Add to the deps type: `session?: { secret: string; secure: boolean; local: LocalAuthConfig | null };`
- After `if (deps.loginRouter) app.use(deps.loginRouter);` add: `if (deps.session) app.use(sessionRoutes({ db: deps.db, ...deps.session }));`

In `apps/core/src/start.ts`:
- Add to `coreEnvSchema`: `SESSION_COOKIE_SECURE: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),`
- Pass to `createApp`: `session: auth.session ? { secret: auth.session.secret, secure: parsed.SESSION_COOKIE_SECURE, local: auth.local } : undefined,`

- [ ] **Step 5: Run to verify it passes**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/core`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/core package-lock.json
git commit -m "feat(core): staff sign-in, sign-out and session renewal endpoints"
```

---

### Task 4: Core users and roles API (Core.Admin)

**Files:**
- Create: `apps/core/src/http/users.ts`, `apps/core/src/http/users.test.ts`
- Modify: `apps/core/src/http/routes.ts` (mount)

**Interfaces:**
- Consumes: Task 1 (`requireRole`), Task 2 (all of `services/users.ts`), Task 3 (session cookie via `createApp`).
- Produces, mounted at `/api/users`, all requiring Core.Admin:
  - `GET /api/users` → `UserView[]`
  - `POST /api/users` (body `createUserSchema`) → 201 `UserView`; 409 `{ error: "a user with that email already exists" }`
  - `PATCH /api/users/:id` (body `updateUserSchema`) → `UserView`
  - `PUT /api/users/:id/roles` (body `{ roles }`) → `UserView`
  - `POST /api/users/:id/password` (body `{ password }`) → 204
  - 400 `{ error: "invalid request", issues }` on validation; 404 `{ error: "not found" }` for unknown/malformed ids; 409 `{ error: "you can't remove your own admin access" }` when an admin deactivates themself or drops their own Core.Admin

- [ ] **Step 1: Write the failing tests**

Create `apps/core/src/http/users.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { mintSession } from "@gcpe/auth";
import { createCoreTestDb } from "../../test/helpers";
import { createApp } from "../app";
import { createUser, createUserSchema } from "../services/users";

const SECRET = "session-secret-for-users-tests-0123456789";

describe("Core users API", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let adminCookie: string;
  let adminId: string;
  let viewerCookie: string;

  beforeAll(async () => {
    tdb = await createCoreTestDb();
    app = createApp({ db: tdb.db, subscribers: [], auth: { session: { secret: SECRET } }, session: { secret: SECRET, secure: false, local: null } });
    const admin = await createUser(tdb.db, createUserSchema.parse({ email: "admin@example.test", displayName: "Admin", roles: ["Core.Admin"], password: "admin password 123" }));
    adminId = admin.id;
    adminCookie = `gcpe_session=${(await mintSession(SECRET, { id: admin.id, name: "Admin", email: admin.email, roles: ["Core.Admin"] })).token}`;
    viewerCookie = `gcpe_session=${(await mintSession(SECRET, { id: "00000000-0000-4000-8000-0000000000aa", name: "V", email: "v@example.test", roles: ["NRMS.Viewer"] })).token}`;
  });
  afterAll(async () => {
    await tdb.drop();
  });

  const as = (cookie: string) => ({
    get: (p: string) => request(app).get(p).set("cookie", cookie),
    post: (p: string, body?: object) => request(app).post(p).set("cookie", cookie).set("x-gcpe-request", "1").send(body ?? {}),
    patch: (p: string, body: object) => request(app).patch(p).set("cookie", cookie).set("x-gcpe-request", "1").send(body),
    put: (p: string, body: object) => request(app).put(p).set("cookie", cookie).set("x-gcpe-request", "1").send(body),
  });

  it("is Core.Admin only", async () => {
    expect((await as(viewerCookie).get("/api/users")).status).toBe(403);
    expect((await request(app).get("/api/users")).status).toBe(401);
  });

  it("creates, lists, renames, deactivates and re-roles a user; the new user can sign in", async () => {
    const created = await as(adminCookie).post("/api/users", { email: "Site.Editor@Example.test", displayName: "Site Editor", roles: ["NRMS.SiteEditor"], password: "site editor pass 1" });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: expect.any(String), email: "site.editor@example.test", displayName: "Site Editor", isActive: true, signInMethod: "local", roles: ["NRMS.SiteEditor"] });
    expect(JSON.stringify(created.body)).not.toContain("scrypt");
    const id = created.body.id as string;

    const signIn = await request(app).post("/auth/login").set("x-gcpe-request", "1").send({ username: "site.editor@example.test", password: "site editor pass 1" });
    expect(signIn.status).toBe(200);

    expect((await as(adminCookie).get("/api/users")).body.map((u: { email: string }) => u.email)).toEqual(["admin@example.test", "site.editor@example.test"]);
    expect((await as(adminCookie).patch(`/api/users/${id}`, { displayName: "Site Ed" })).body.displayName).toBe("Site Ed");
    expect((await as(adminCookie).put(`/api/users/${id}/roles`, { roles: ["NRMS.Viewer"] })).body.roles).toEqual(["NRMS.Viewer"]);
    expect((await as(adminCookie).post(`/api/users/${id}/password`, { password: "another long pass" })).status).toBe(204);
    expect((await as(adminCookie).patch(`/api/users/${id}`, { isActive: false })).body.isActive).toBe(false);
  });

  it("409s a duplicate email, 400s bad input, 404s unknown or malformed ids", async () => {
    const dup = await as(adminCookie).post("/api/users", { email: "ADMIN@example.test", displayName: "Again" });
    expect(dup.status).toBe(409);
    expect(dup.body).toEqual({ error: "a user with that email already exists" });
    expect((await as(adminCookie).post("/api/users", { email: "not-an-email", displayName: "X" })).status).toBe(400);
    expect((await as(adminCookie).put("/api/users/00000000-0000-4000-8000-000000000000/roles", { roles: [] })).status).toBe(404);
    expect((await as(adminCookie).patch("/api/users/not-a-uuid", { isActive: true })).status).toBe(404);
    expect((await as(adminCookie).post("/api/users/not-a-uuid/password", { password: "long enough pass" })).status).toBe(404);
  });

  it("won't let an admin lock themself out", async () => {
    expect((await as(adminCookie).patch(`/api/users/${adminId}`, { isActive: false })).status).toBe(409);
    const drop = await as(adminCookie).put(`/api/users/${adminId}/roles`, { roles: ["NRMS.Editor"] });
    expect(drop.status).toBe(409);
    expect(drop.body).toEqual({ error: "you can't remove your own admin access" });
    expect((await as(adminCookie).put(`/api/users/${adminId}/roles`, { roles: ["Core.Admin", "NRMS.Editor"] })).status).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/core/src/http/users.test.ts`
Expected: FAIL — `/api/users` is 404.

- [ ] **Step 3: Implement**

Create `apps/core/src/http/users.ts`:

```ts
import { Router, type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import type { Db } from "@gcpe/db-kit";
import {
  createUser,
  createUserSchema,
  listUsers,
  setPassword,
  setPasswordSchema,
  setRoles,
  setRolesSchema,
  updateUser,
  updateUserSchema,
  UserExistsError,
  UserNotFoundError,
} from "../services/users";

class SelfLockoutError extends Error {}

type IdParams = { id: string };
const run = <P>(h: (req: Request<P>, res: Response) => Promise<void>) => (req: Request<P>, res: Response, next: NextFunction) =>
  h(req, res).catch((e: unknown) => {
    if (e instanceof ZodError) return void res.status(400).json({ error: "invalid request", issues: e.issues });
    if (e instanceof UserExistsError) return void res.status(409).json({ error: "a user with that email already exists" });
    if (e instanceof UserNotFoundError) return void res.status(404).json({ error: "not found" });
    if (e instanceof SelfLockoutError) return void res.status(409).json({ error: "you can't remove your own admin access" });
    next(e);
  });

/** Core.Admin user management (spec addendum §2). Mounted behind requireRole("Core.Admin"). */
export function usersRouter(db: Db): Router {
  const r = Router();
  const isSelf = (req: Request<IdParams>) => req.auth?.subject === req.params.id;

  r.get("/", run(async (_req, res) => void res.json(await listUsers(db))));
  r.post("/", run(async (req, res) => void res.status(201).json(await createUser(db, createUserSchema.parse(req.body)))));
  r.patch(
    "/:id",
    run<IdParams>(async (req, res) => {
      const patch = updateUserSchema.parse(req.body);
      if (isSelf(req) && patch.isActive === false) throw new SelfLockoutError();
      res.json(await updateUser(db, req.params.id, patch));
    }),
  );
  r.put(
    "/:id/roles",
    run<IdParams>(async (req, res) => {
      const { roles } = setRolesSchema.parse(req.body);
      if (isSelf(req) && !roles.includes("Core.Admin")) throw new SelfLockoutError();
      res.json(await setRoles(db, req.params.id, roles));
    }),
  );
  r.post(
    "/:id/password",
    run<IdParams>(async (req, res) => {
      await setPassword(db, req.params.id, setPasswordSchema.parse(req.body).password);
      res.status(204).end();
    }),
  );
  return r;
}
```

In `apps/core/src/http/routes.ts`, add `import { usersRouter } from "./users";` and, just before `return r;`, add:

```ts
  r.use("/users", admin, usersRouter(db));
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/core`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core
git commit -m "feat(core): Core.Admin users and roles API"
```

---

### Task 5: Test-user seeding (local CLI and deployed stack)

**Files:**
- Create: `packages/auth/src/cli/read-hidden.ts`, `apps/core/src/services/seed-test-users.ts`, `apps/core/src/services/seed-test-users.test.ts`, `apps/core/src/cli/seed-test-users.ts`, `scripts/siteground-seed-users.sh`, `tests/siteground-seed-users.test.ts`
- Modify: `packages/auth/src/cli/hash-password.ts`, `apps/core/package.json` (script), `package.json` (root script)

**Interfaces:**
- Consumes: Task 2 (`createUser`, `createUserSchema`, `findUserByEmail`, `setRoles`, `setPassword`, `updateUser`); `applyKeypress`, `INITIAL_KEYPRESS_STATE` (`packages/auth/src/cli/hidden-input.ts`).
- Produces:
  - `readHidden(label: string): Promise<string>` (TTY only; throws `Error("…needs a terminal…")` otherwise)
  - `TEST_USERS: readonly { email: string; displayName: string; roles: string[] }[]` — `editor@example.test` (Test Editor, NRMS.Editor), `site-editor@example.test` (Test Site Editor, NRMS.SiteEditor), `viewer@example.test` (Test Viewer, NRMS.Viewer)
  - `seedTestUsers(db, passwords: Record<string, string>): Promise<{ email: string; action: "created" | "updated" }[]>`
  - `npm run core:seed-test-users` (root) and `scripts/siteground-seed-users.sh https://<domain>`

- [ ] **Step 1: Write the failing tests**

Create `apps/core/src/services/seed-test-users.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCoreTestDb } from "../../test/helpers";
import { authenticate, findUserByEmail, updateUser } from "./users";
import { seedTestUsers, TEST_USERS } from "./seed-test-users";

const pw = (n: number) => Object.fromEntries(TEST_USERS.map((u) => [u.email, `password number ${n}`]));

describe("seedTestUsers", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createCoreTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("creates the three test users with their roles", async () => {
    expect(await seedTestUsers(tdb.db, pw(1))).toEqual(TEST_USERS.map((u) => ({ email: u.email, action: "created" })));
    expect((await findUserByEmail(tdb.db, "editor@example.test"))?.roles).toEqual(["NRMS.Editor"]);
    expect((await findUserByEmail(tdb.db, "site-editor@example.test"))?.roles).toEqual(["NRMS.SiteEditor"]);
    expect((await findUserByEmail(tdb.db, "viewer@example.test"))?.roles).toEqual(["NRMS.Viewer"]);
  });

  it("re-running resets passwords and roles and reactivates", async () => {
    const viewer = (await findUserByEmail(tdb.db, "viewer@example.test"))!;
    await updateUser(tdb.db, viewer.id, { isActive: false });
    expect(await seedTestUsers(tdb.db, pw(2))).toEqual(TEST_USERS.map((u) => ({ email: u.email, action: "updated" })));
    expect(await authenticate(tdb.db, "viewer@example.test", "password number 1")).toBeNull();
    expect(await authenticate(tdb.db, "viewer@example.test", "password number 2")).not.toBeNull();
  });

  it("refuses a missing or short password before changing anything", async () => {
    await expect(seedTestUsers(tdb.db, { "editor@example.test": "short" })).rejects.toThrow(/at least 12 characters/);
  });
});
```

Create `tests/siteground-seed-users.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("scripts/siteground-seed-users.sh", () => {
  it("is valid bash", () => {
    execFileSync("bash", ["-n", "scripts/siteground-seed-users.sh"]);
  });
  it("sends the CSRF header, keeps the cookie jar private, and never echoes passwords", () => {
    const s = readFileSync("scripts/siteground-seed-users.sh", "utf8");
    expect(s).toContain("x-gcpe-request: 1");
    expect(s).toMatch(/umask 077/);
    expect(s).toMatch(/trap .*rm -f/);
    expect(s).not.toMatch(/echo .*PASS/);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/core/src/services/seed-test-users.test.ts tests/siteground-seed-users.test.ts`
Expected: FAIL — modules/script missing.

- [ ] **Step 3: Implement the shared prompt and refactor hash-password**

Create `packages/auth/src/cli/read-hidden.ts`:

```ts
import { applyKeypress, INITIAL_KEYPRESS_STATE, type KeypressState } from "./hidden-input";

/**
 * Prompts on stderr and reads one line from a TTY with echo off. Raw mode is switched on
 * before the label appears, so nothing typed or pasted early is echoed. Ctrl-C/Ctrl-D restore
 * the terminal and exit 130.
 */
export function readHidden(label: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return Promise.reject(new Error("this command needs a terminal for hidden password input"));
  return new Promise<string>((resolve, reject) => {
    let state: KeypressState = INITIAL_KEYPRESS_STATE;
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdin.removeListener("error", onError);
    };
    const onData = (chunk: Buffer) => {
      const result = applyKeypress(state, chunk);
      if (result.action === "submit") {
        cleanup();
        process.stderr.write("\n");
        resolve(result.value);
        return;
      }
      if (result.action === "cancel") {
        cleanup();
        process.stderr.write("\n");
        process.exit(130);
      }
      state = result.state;
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    stdin.setRawMode(true);
    stdin.resume();
    process.stderr.write(label);
    stdin.on("data", onData);
    stdin.on("error", onError);
  });
}
```

In `packages/auth/src/cli/hash-password.ts`: delete the `readHiddenFromTTY` function and the now-unused `applyKeypress`/`KeypressState` import, add `import { readHidden } from "./read-hidden";`, and change the TTY branch to `pw = process.stdin.isTTY ? await readHidden("Password for the local admin (input hidden): ") : await readFirstLineFromPipe();`. Behaviour is unchanged.

- [ ] **Step 4: Implement seeding**

Create `apps/core/src/services/seed-test-users.ts`:

```ts
import type { Db } from "@gcpe/db-kit";
import { createUser, createUserSchema, findUserByEmail, setPassword, setPasswordSchema, setRoles, updateUser } from "./users";

/** The three local test users (spec addendum §2). Fictional addresses on the reserved .test TLD. */
export const TEST_USERS = [
  { email: "editor@example.test", displayName: "Test Editor", roles: ["NRMS.Editor"] },
  { email: "site-editor@example.test", displayName: "Test Site Editor", roles: ["NRMS.SiteEditor"] },
  { email: "viewer@example.test", displayName: "Test Viewer", roles: ["NRMS.Viewer"] },
] as const;

/** Creates the test users, or resets an existing one's roles and password and reactivates it. */
export async function seedTestUsers(db: Db, passwords: Record<string, string>): Promise<{ email: string; action: "created" | "updated" }[]> {
  for (const u of TEST_USERS) setPasswordSchema.parse({ password: passwords[u.email] ?? "" });
  const out: { email: string; action: "created" | "updated" }[] = [];
  for (const u of TEST_USERS) {
    const password = passwords[u.email]!;
    const existing = await findUserByEmail(db, u.email);
    if (!existing) {
      await createUser(db, createUserSchema.parse({ email: u.email, displayName: u.displayName, roles: [...u.roles], password }));
      out.push({ email: u.email, action: "created" });
      continue;
    }
    await setRoles(db, existing.id, [...u.roles]);
    await setPassword(db, existing.id, password);
    await updateUser(db, existing.id, { isActive: true, displayName: u.displayName });
    out.push({ email: u.email, action: "updated" });
  }
  return out;
}
```

Note: `setPasswordSchema`'s `min(12)` message is "use at least 12 characters", which the test's `/at least 12 characters/` matches through the thrown ZodError's message.

Create `apps/core/src/cli/seed-test-users.ts`:

```ts
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseEnv } from "@gcpe/config";
import { createDb, runMigrations } from "@gcpe/db-kit";
import { readHidden } from "@gcpe/auth/cli/read-hidden";
import { seedTestUsers, TEST_USERS } from "../services/seed-test-users";

const env = parseEnv(z.object({ DATABASE_URL: z.string().url() }), process.env);
const passwords: Record<string, string> = {};
for (const u of TEST_USERS) passwords[u.email] = await readHidden(`Password for ${u.email} (${u.roles.join(", ")}; input hidden): `);

const { db, pool } = createDb(env.DATABASE_URL);
try {
  await runMigrations(db, fileURLToPath(new URL("../../migrations", import.meta.url)));
  for (const r of await seedTestUsers(db, passwords)) console.log(`${r.action.padEnd(8)} ${r.email}`);
} finally {
  await pool.end();
}
```

Add `"./cli/read-hidden": "./src/cli/read-hidden.ts"` to the `exports` map in `packages/auth/package.json`. Add to `apps/core/package.json` scripts: `"seed:test-users": "tsx src/cli/seed-test-users.ts"`. Add to root `package.json` scripts: `"core:seed-test-users": "npm --workspace @gcpe/core run seed:test-users"`.

Create `scripts/siteground-seed-users.sh` (and `chmod +x` it):

```bash
#!/usr/bin/env bash
# Creates (or resets) the three Phase 3 test users on a deployed stack, through Core's users
# API, signed in as the break-glass admin. Prompts (hidden) for every password; nothing secret
# is printed or kept — the session cookie lives in a private temp file deleted on exit.
#
# Usage: scripts/siteground-seed-users.sh https://boxs.ca
set -euo pipefail

BASE="${1:?usage: $0 https://<domain>}"
BASE="${BASE%/}"
umask 077
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

hidden() { python3 -c 'import getpass,sys; print(getpass.getpass(sys.argv[1]))' "$1"; }
json() { python3 -c 'import json,sys; print(json.dumps(dict(zip(sys.argv[1::2], sys.argv[2::2]))))' "$@"; }
curl_api() { curl -sS -b "$JAR" -c "$JAR" -H 'x-gcpe-request: 1' -H 'content-type: application/json' "$@"; }

ADMIN_PASS="$(hidden 'Break-glass admin password: ')"
STATUS="$(json username admin password "$ADMIN_PASS" | curl_api -o /dev/null -w '%{http_code}' -X POST "$BASE/core/auth/login" -d @-)"
unset ADMIN_PASS
[ "$STATUS" = "200" ] || { echo "admin sign-in failed (HTTP $STATUS)"; exit 1; }

seed() {
  local email="$1" name="$2" role="$3" pass id status
  pass="$(hidden "Password for $email ($role): ")"
  status="$(python3 -c 'import json,sys; print(json.dumps({"email":sys.argv[1],"displayName":sys.argv[2],"roles":[sys.argv[3]],"password":sys.argv[4]}))' "$email" "$name" "$role" "$pass" \
    | curl_api -o /dev/null -w '%{http_code}' -X POST "$BASE/core/api/users" -d @-)"
  if [ "$status" = "201" ]; then
    echo "created  $email"
  elif [ "$status" = "409" ]; then
    id="$(curl_api "$BASE/core/api/users" | python3 -c 'import json,sys; e=sys.argv[1]; print(next(u["id"] for u in json.load(sys.stdin) if u["email"]==e))' "$email")"
    python3 -c 'import json,sys; print(json.dumps({"roles":[sys.argv[1]]}))' "$role" | curl_api -o /dev/null -X PUT "$BASE/core/api/users/$id/roles" -d @-
    json password "$pass" | curl_api -o /dev/null -X POST "$BASE/core/api/users/$id/password" -d @-
    python3 -c 'import json,sys; print(json.dumps({"isActive":True,"displayName":sys.argv[1]}))' "$name" | curl_api -o /dev/null -X PATCH "$BASE/core/api/users/$id" -d @-
    echo "updated  $email"
  else
    echo "failed   $email (HTTP $status)"
  fi
  unset pass
}

seed editor@example.test "Test Editor" NRMS.Editor
seed site-editor@example.test "Test Site Editor" NRMS.SiteEditor
seed viewer@example.test "Test Viewer" NRMS.Viewer
curl_api -o /dev/null -X POST "$BASE/core/auth/logout"
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/core tests/siteground-seed-users.test.ts packages/auth && npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/auth apps/core scripts/siteground-seed-users.sh tests/siteground-seed-users.test.ts package.json package-lock.json
git commit -m "feat(core): seed the three test users locally or on a deployed stack"
```

---

### Task 6: Stack wiring for the session cookie

**Files:**
- Modify: `apps/stack/src/env.ts`, `apps/stack/src/env.test.ts`, `apps/stack/src/stack.ts:231-232`, `apps/stack/src/stack.test.ts`, `docs/deploy/siteground.md`

**Interfaces:**
- Consumes: Tasks 1–4 (every app's `authFromEnv` reads `SESSION_SECRET`; Core serves `/auth/login`).
- Produces: `sessionSecretFrom(stackSecret: string): string` (exported from `apps/stack/src/env.ts`); `SESSION_SECRET` and `SESSION_COOKIE_SECURE` become shared (unprefixed) keys; when `SESSION_SECRET` is unset and `STACK_EVENT_SECRET` is set, every app's view gets `SESSION_SECRET = sessionSecretFrom(STACK_EVENT_SECRET)`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/stack/src/env.test.ts` (add `sessionSecretFrom` to its import from `./env`, and `APP_PREFIXES`, `routeSecret`, `INTERNAL_EVENT_ROUTES` if not already imported):

```ts
describe("SESSION_SECRET for the stack", () => {
  const stackSecret = "e".repeat(40);

  it("derives one session secret for every app from STACK_EVENT_SECRET", () => {
    const derived = sessionSecretFrom(stackSecret);
    expect(derived).toMatch(/^[0-9a-f]{64}$/);
    for (const p of APP_PREFIXES) expect(envFor({ STACK_EVENT_SECRET: stackSecret }, p).SESSION_SECRET).toBe(derived);
    for (const route of INTERNAL_EVENT_ROUTES) expect(routeSecret(stackSecret, route)).not.toBe(derived);
  });

  it("an explicit SESSION_SECRET and SESSION_COOKIE_SECURE are shared as-is", () => {
    const view = envFor({ STACK_EVENT_SECRET: stackSecret, SESSION_SECRET: "x".repeat(40), SESSION_COOKIE_SECURE: "false" }, "NRMS");
    expect(view.SESSION_SECRET).toBe("x".repeat(40));
    expect(view.SESSION_COOKIE_SECURE).toBe("false");
  });

  it("no STACK_EVENT_SECRET and no SESSION_SECRET means no session secret", () => {
    expect(envFor({}, "CORE").SESSION_SECRET).toBeUndefined();
  });
});
```

Append to `apps/stack/src/stack.test.ts` a new `describe`, following the file's existing pattern of calling `setupStack()` in `beforeAll` and `close()` in `afterAll` (read the file's other describes first and mirror them):

```ts
describe("staff session cookie across the stack", () => {
  let inst: StackTestInstance;
  beforeAll(async () => {
    inst = await setupStack({ fetchAdminToken: false });
  });
  afterAll(async () => {
    await inst.close();
  });

  it("a cookie from /core/auth/login authenticates /nrms/api, with the CSRF rule", async () => {
    const login = await fetch(`${inst.stackUrl}/core/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gcpe-request": "1" },
      body: JSON.stringify({ username: "admin", password: ADMIN_PASSWORD }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.getSetCookie().find((c) => c.startsWith("gcpe_session="))!.split(";")[0]!;
    expect((await fetch(`${inst.stackUrl}/nrms/api/releases/NO-SUCH-RELEASE`)).status).toBe(401);
    expect((await fetch(`${inst.stackUrl}/nrms/api/releases/NO-SUCH-RELEASE`, { headers: { cookie } })).status).toBe(404);
    const noCsrf = await fetch(`${inst.stackUrl}/nrms/api/releases`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" });
    expect(noCsrf.status).toBe(403);
    const withCsrf = await fetch(`${inst.stackUrl}/nrms/api/releases`, { method: "POST", headers: { cookie, "content-type": "application/json", "x-gcpe-request": "1" }, body: "{}" });
    expect(withCsrf.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/stack`
Expected: FAIL — `sessionSecretFrom` not exported; `/core/auth/login` 404 in the stack (no `SESSION_SECRET` reaches Core).

- [ ] **Step 3: Implement**

In `apps/stack/src/env.ts`:
- Extend `isSharedKey` to also return true for `key === "SESSION_SECRET" || key === "SESSION_COOKIE_SECURE"`, and add them to the doc comment above it.
- Add after `routeSecret`:

```ts
/** The staff session-cookie signing key (spec addendum §2), derived like the event secrets so a
 * SiteGround deployment needs no extra setting: HMAC-SHA256(STACK_EVENT_SECRET, "gcpe-session"). */
export function sessionSecretFrom(stackSecret: string): string {
  return createHmac("sha256", stackSecret).update("gcpe-session").digest("hex");
}
```

- In `envFor`, after the shared-key loop and before the `internalEventEnv` line, add:

```ts
  if (!view.SESSION_SECRET && env.STACK_EVENT_SECRET) view.SESSION_SECRET = sessionSecretFrom(env.STACK_EVENT_SECRET);
```

In `apps/stack/src/stack.ts`, add `"/core/auth/login"` to the path array passed to `combinedLoginLimiter` (line 232), and extend the comment above it to say the staff sign-in shares the same budget.

In `docs/deploy/siteground.md`, add a section "Staff sign-in (Phase 3)":

```markdown
## Staff sign-in (Phase 3)

Staff sign in at `POST /core/auth/login` and receive one `gcpe_session` cookie that every app's API accepts. Its signing key is derived from `STACK_EVENT_SECRET`, so there is nothing new to add in Site Tools. (Setting `SESSION_SECRET` explicitly overrides the derived one; changing either signs everyone out.)

The break-glass `admin` account signs in through the same endpoint. To create or reset the three test users (`editor@example.test`, `site-editor@example.test`, `viewer@example.test`), run from your Mac:

    scripts/siteground-seed-users.sh https://boxs.ca

It asks for the admin password and a password for each test user (12+ characters, input hidden).
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run apps/stack && npx -y -p node@24 -- node node_modules/typescript/bin/tsc -p tsconfig.json`
Expected: PASS.

Then the full suite once:
Run: `npx -y -p node@24 -- node node_modules/vitest/vitest.mjs run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/stack docs/deploy/siteground.md
git commit -m "feat(stack): share the staff session secret with every app and rate-limit staff sign-in"
```
