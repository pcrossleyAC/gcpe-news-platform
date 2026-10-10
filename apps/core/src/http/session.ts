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
import { authenticate, sessionRolesOf, sessionUserFor } from "../services/users";

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
        await issue(res, { id: user.id, name: user.displayName, email: user.email ?? "", roles: sessionRolesOf(user) });
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
