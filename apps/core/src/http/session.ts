import express, { Router, type RequestHandler, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import type { Db } from "@gcpe/db-kit";
import {
  clearedSessionCookie,
  CSRF_HEADER,
  DEFAULT_SESSION_MAX_SECONDS,
  readCookie,
  SESSION_COOKIE,
  SESSION_RENEW_WINDOW_SECONDS,
  verifyPassword,
  verifySession,
  type LocalAuthConfig,
  type SessionGate,
  type SessionUser,
  type VerifiedSession,
} from "@gcpe/auth";
import type { EntraClient } from "../entra/client";
import { entraRoutes } from "../entra/routes";
import { BREAK_GLASS_ID, breakGlassUser, endSession, sessionGate, startSession } from "../services/sessions";
import { passwordSignIn, sessionRolesOf } from "../services/users";
import { newSessionCookie } from "./session-cookie";

export { BREAK_GLASS_ID } from "../services/sessions";

const loginSchema = z.object({ username: z.string().max(254), password: z.string().max(200) });

export interface SessionRouteDeps {
  db: Db;
  secret: string;
  secure: boolean;
  local: LocalAuthConfig | null;
  /** Entra sign-in, when configured. */
  entra?: EntraClient | null;
  /** False refuses every users-row password (production with Entra on); break-glass is unaffected. Default true. */
  userPasswordsAllowed?: boolean;
  ratePerMinute?: number;
  /** Per-IP limit on each Entra route. Default 30 a minute. */
  entraRatePerMinute?: number;
  /** SESSION_MAX_HOURS, in seconds (owner decision 2026-10-31). Default 12 hours. */
  maxSessionSeconds?: number;
  /** Core's session gate; built from `db` and `local` when not given. */
  gate?: SessionGate;
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
  const maxSessionSeconds = deps.maxSessionSeconds ?? DEFAULT_SESSION_MAX_SECONDS;
  const gate = deps.gate ?? sessionGate(deps.db, { localConfigured: deps.local !== null });
  const issue = async (res: Response, user: SessionUser, terms: { sid: string; signedAt: number }) => {
    const { cookie, expiresAt } = await newSessionCookie(deps.secret, deps.secure, user, { ...terms, maxSessionSeconds });
    res.setHeader("set-cookie", cookie);
    res.json({ user, expiresAt: new Date(expiresAt * 1000).toISOString() });
  };
  /** A new sign-in: recorded, then issued. */
  const signIn = async (res: Response, user: SessionUser) => {
    const signedAt = Math.floor(Date.now() / 1000);
    await issue(res, user, { sid: await startSession(deps.db, user.id, signedAt, maxSessionSeconds), signedAt });
  };
  const userPasswordsAllowed = deps.userPasswordsAllowed ?? true;
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
          return void (await signIn(res, breakGlassUser()));
        }
        const result = await passwordSignIn(deps.db, username, password, { usersAllowed: userPasswordsAllowed });
        // The right password for an account that is switched off: say so (the sign-in screen's
        // "Your account is not active"). Anything else stays the one "invalid credentials".
        if (!result.ok) return void res.status(result.reason === "inactive" ? 403 : 401).json({ error: result.reason === "inactive" ? "inactive" : "invalid credentials" });
        const { user } = result;
        await signIn(res, { id: user.id, name: user.displayName, email: user.email ?? "", roles: sessionRolesOf(user) });
      } catch (e) {
        next(e);
      }
    },
  );

  /** Which sign-in methods the sign-in screen offers. `local` covers the break-glass admin too. */
  r.get("/auth/methods", (_req, res) => {
    res.json({ entra: deps.entra != null, local: userPasswordsAllowed || deps.local !== null });
  });

  if (deps.entra) r.use(entraRoutes({ db: deps.db, secret: deps.secret, secure: deps.secure, entra: deps.entra, ratePerMinute: deps.entraRatePerMinute, maxSessionSeconds }));

  // Ends this session on the server too (owner decision 2026-10-31), so a copy of the cookie
  // can't be used afterwards. Only this sign-in: the person's other computers stay signed in.
  r.post("/auth/logout", requireCsrf, async (req, res, next) => {
    try {
      const cookie = readCookie(req.header("cookie"), SESSION_COOKIE);
      const session = cookie ? await verifySession(deps.secret, cookie, { maxSessionSeconds }).catch(() => null) : null;
      if (session?.sid) await endSession(deps.db, session.sid);
      clear(res);
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  r.get("/auth/session", async (req, res, next) => {
    try {
      const cookie = readCookie(req.header("cookie"), SESSION_COOKIE);
      if (!cookie) return void res.status(401).json({ error: "not signed in" });
      let session: VerifiedSession;
      try {
        // Refuses a token past the session limit (12 hours from sign-in by default).
        session = await verifySession(deps.secret, cookie, { maxSessionSeconds });
      } catch {
        return notSignedIn(res);
      }
      // Inactive, signed out or ended by a deactivation: the same refusal every app gives.
      const current = await gate(session);
      if (!current) return notSignedIn(res);
      const now = Math.floor(Date.now() / 1000);
      const limit = session.signedAt + maxSessionSeconds;
      // A token from before the limit has no sid: record it now, counting from its issue time, so
      // Sign out and a deactivation can end it like any other.
      if (!session.sid) return void (await issue(res, current, { sid: await startSession(deps.db, current.id, session.signedAt, maxSessionSeconds), signedAt: session.signedAt }));
      const changed = !sameRoles(session.roles, current.roles) || session.name !== current.name;
      // Renewal can't go past the limit: once the token already runs to it, there is nothing to renew.
      const renew = session.expiresAt - now <= SESSION_RENEW_WINDOW_SECONDS && session.expiresAt < limit;
      if (renew || changed) return void (await issue(res, current, { sid: session.sid, signedAt: session.signedAt }));
      res.json({ user: current, expiresAt: new Date(session.expiresAt * 1000).toISOString() });
    } catch (e) {
      next(e);
    }
  });

  return r;
}
