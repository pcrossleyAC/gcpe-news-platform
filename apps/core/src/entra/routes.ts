import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import type { Db } from "@gcpe/db-kit";
import { readCookie } from "@gcpe/auth";
import { safeErrorLabel } from "@gcpe/http-kit";
import { matchEntraUser, type EntraRefusal } from "../services/users";
import { newSessionCookie } from "../http/session-cookie";
import { newEntraChecks, type EntraClient } from "./client";
import { safeHubReturnTo } from "./return-to";
import { clearedEntraStateCookie, ENTRA_STATE_COOKIE, entraStateCookie, openEntraState, sealEntraState } from "./state-cookie";

/** The `?error=` codes the staff sign-in screen shows a message for. */
export type EntraErrorCode = "cancelled" | "expired" | "failed" | EntraRefusal;

export interface EntraRouteDeps {
  db: Db;
  secret: string;
  secure: boolean;
  entra: EntraClient;
  ratePerMinute?: number;
}

// Codes an administrator may need to act on go to console.error, which the stack's error log captures.
const NEEDS_ADMIN = new Set<EntraErrorCode>(["failed", "conflict"]);

function refuse(res: Response, route: string, code: EntraErrorCode, extra: { userId?: string; error?: unknown } = {}): void {
  const line = `[core] entra sign-in refused route=${route} code=${code}${extra.userId ? ` user=${extra.userId}` : ""}${extra.error !== undefined ? ` error=${safeErrorLabel(extra.error)}` : ""}`;
  (NEEDS_ADMIN.has(code) ? console.error : console.warn)(line);
  res.redirect(302, `/hub/sign-in?error=${code}`);
}

const queryOf = (req: Request): string => {
  const i = req.originalUrl.indexOf("?");
  return i < 0 ? "" : req.originalUrl.slice(i + 1);
};

/** GET /auth/entra and GET /auth/entra/callback: the authorization-code flow with PKCE. Public routes. */
export function entraRoutes(deps: EntraRouteDeps): Router {
  const r = Router();
  const limit = () => rateLimit({ windowMs: 60_000, limit: deps.ratePerMinute ?? 30, standardHeaders: "draft-7", legacyHeaders: false });
  const cookieOpts = { secure: deps.secure };

  r.get("/auth/entra", limit(), async (req, res) => {
    const returnTo = safeHubReturnTo(req.query.returnTo);
    try {
      const checks = await newEntraChecks();
      const url = await deps.entra.authorizationUrl(checks);
      res.setHeader("set-cookie", entraStateCookie(sealEntraState(deps.secret, { state: checks.state, nonce: checks.nonce, codeVerifier: checks.codeVerifier, returnTo }), cookieOpts));
      res.redirect(302, url.href);
    } catch (e) {
      refuse(res, "/auth/entra", "failed", { error: e });
    }
  });

  r.get("/auth/entra/callback", limit(), async (req, res) => {
    const route = "/auth/entra/callback";
    const saved = openEntraState(deps.secret, readCookie(req.header("cookie"), ENTRA_STATE_COOKIE));
    const cleared = clearedEntraStateCookie(cookieOpts);
    res.setHeader("set-cookie", cleared);
    const { error, state, code } = req.query;
    if (error !== undefined) return refuse(res, route, error === "access_denied" ? "cancelled" : "failed");
    if (!saved || typeof state !== "string" || state !== saved.state) return refuse(res, route, "expired");
    if (typeof code !== "string" || code === "") return refuse(res, route, "failed");
    try {
      const identity = await deps.entra.exchange({ callbackQuery: queryOf(req), state: saved.state, nonce: saved.nonce, codeVerifier: saved.codeVerifier });
      const match = await matchEntraUser(deps.db, identity.oid, identity.email);
      if (!match.ok) return refuse(res, route, match.code, { userId: match.userId });
      const { cookie } = await newSessionCookie(deps.secret, deps.secure, match.user);
      res.setHeader("set-cookie", [cleared, cookie]);
      res.redirect(302, safeHubReturnTo(saved.returnTo));
    } catch (e) {
      refuse(res, route, "failed", { error: e });
    }
  });

  return r;
}
