import type { Request, RequestHandler, Response } from "express";
import { safeErrorLabel } from "@gcpe/http-kit";
import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { INTERNAL_AUDIENCE, INTERNAL_ISSUER, internalKey, isInternalRequest } from "./internal";
import { assertSecretStrength, LOCAL_AUDIENCE, LOCAL_ISSUER, localKey } from "./local";
import { clearedSessionCookie, CSRF_HEADER, readCookie, SESSION_COOKIE, verifySession, type SessionUser, type VerifiedSession } from "./session";

export interface AuthContext {
  subject: string;
  roles: string[];
  claims: Record<string, unknown>;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export function entraJwks(tenantId: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`));
}

export function entraIssuer(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}/v2.0`;
}

export interface BearerOptions {
  issuer?: string;
  audience?: string;
  keys?: JWTVerifyGetKey;
  local?: { secret: string };
  /** The stack's own app-to-app token (internal.ts), keyed from STACK_EVENT_SECRET: accepted only
   * on the stack's in-memory connections. */
  internal?: { secret: string };
  /** Accept Core's staff session cookie (spec addendum §2). */
  session?: {
    secret: string;
    /** The cookie's Secure flag, for the cleared cookie a refused session gets back. Default true. */
    secure?: boolean;
    /** SESSION_MAX_HOURS, in seconds. Default 12 hours. */
    maxSessionSeconds?: number;
    /** Core's own check; every other app uses the one the stack installed with setSessionGate. */
    gate?: SessionGate;
    /** The stack sets this (SESSION_GATE_REQUIRED): with no gate installed, a cookie is refused
     * with 503 rather than accepted on its signature alone, so losing the wiring can't silently
     * stop deactivations taking effect. */
    gateRequired?: boolean;
  };
}

/**
 * Owner decision 2026-10-31: whether a signed, unexpired session cookie still stands. Core answers
 * from its users and sessions tables (the person is active, and this sign-in wasn't signed out or
 * ended by a deactivation) with the person as they are now, or null to refuse. Run on every
 * cookie request, so a deactivation is refused on the very next request in every app.
 */
export type SessionGate = (session: VerifiedSession) => Promise<SessionUser | null>;

let installedGate: SessionGate | null = null;

/** Whether the stack has installed Core's gate (stack startup checks it). */
export function sessionGateInstalled(): boolean {
  return installedGate !== null;
}

/** The answer while the session check can't be made (Core's database slow or down): not a
 * sign-out, so the cookie stays and the Hub says to try again. Logged at most once per 30 s, so a
 * page's many calls don't flood the error log. */
const CHECK_UNAVAILABLE = "sign-in check unavailable";
let lastCheckLog = 0;
function logCheckUnavailable(e: unknown): void {
  const now = Date.now();
  if (now - lastCheckLog < 30_000) return;
  lastCheckLog = now;
  // The error's code or kind only, never its message (review S N4).
  console.error(`[auth] session check unavailable (requests answer 503 until it recovers; logged at most every 30 s): ${safeErrorLabel(e)}`);
}

/** The stack installs Core's gate here once Core has started, for every app in the process; null
 * removes it. An app running on its own, without Core in its process, has none: it checks the
 * cookie's signature and limits only. Returns a remover that leaves a gate installed since alone. */
export function setSessionGate(gate: SessionGate | null): () => void {
  installedGate = gate;
  return () => {
    if (installedGate === gate) installedGate = null;
  };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function requireBearer(opts: BearerOptions): RequestHandler {
  const entraFieldsGiven = [opts.issuer, opts.audience, opts.keys].filter((v) => v !== undefined).length;
  if (entraFieldsGiven > 0 && entraFieldsGiven < 3) {
    throw new Error("requireBearer: issuer, audience and keys must all be provided together, or all omitted");
  }
  const entra = entraFieldsGiven === 3 ? { issuer: opts.issuer!, audience: opts.audience!, keys: opts.keys! } : null;
  if (opts.local) assertSecretStrength(opts.local.secret);
  const local = opts.local ? { key: localKey(opts.local.secret) } : null;
  if (opts.internal) assertSecretStrength(opts.internal.secret);
  const internal = opts.internal ? { key: internalKey(opts.internal.secret) } : null;
  if (opts.session) assertSecretStrength(opts.session.secret);
  const sessionSecret = opts.session?.secret;
  const refuseSession = (res: Response, error: string) => {
    res.setHeader("set-cookie", clearedSessionCookie({ secure: opts.session?.secure ?? true }));
    res.status(401).json({ error });
  };
  return async (req, res, next) => {
    const header = req.header("authorization");
    if (!header?.startsWith("Bearer ")) {
      // No bearer token: fall back to the staff session cookie when sessions are configured.
      // A bearer token, when present, always decides — a stale cookie can't override it.
      const cookie = sessionSecret ? readCookie(req.header("cookie"), SESSION_COOKIE) : undefined;
      if (!cookie) return void res.status(401).json({ error: "missing bearer token" });
      let session: VerifiedSession;
      try {
        session = await verifySession(sessionSecret!, cookie, { maxSessionSeconds: opts.session?.maxSessionSeconds });
      } catch {
        return refuseSession(res, "invalid session");
      }
      const gate = opts.session?.gate ?? installedGate;
      let current: SessionUser | null = session;
      if (gate) {
        try {
          current = await gate(session);
        } catch (e) {
          logCheckUnavailable(e);
          res.setHeader("retry-after", "5");
          return void res.status(503).json({ error: CHECK_UNAVAILABLE });
        }
        if (!current) return refuseSession(res, "not signed in");
      } else if (opts.session?.gateRequired) {
        logCheckUnavailable(new Error("no session gate installed"));
        res.setHeader("retry-after", "5");
        return void res.status(503).json({ error: CHECK_UNAVAILABLE });
      }
      if (!SAFE_METHODS.has(req.method) && req.header(CSRF_HEADER) !== "1") {
        return void res.status(403).json({ error: "missing X-GCPE-Request header" });
      }
      // rolesCurrent: the roles are Core's as of now (the gate), not the ones minted into the token,
      // so an app with its own copy (the Calendar) can act on a removal at once.
      req.auth = { subject: session.id, roles: [...current.roles], claims: { name: current.name, email: current.email, via: "session", ...(gate ? { rolesCurrent: true } : {}) } };
      return next();
    }
    const token = header.slice(7);
    try {
      // Branch on the token's own alg header, but always verify against the
      // pinned algorithm list for that branch — never let the header pick
      // which secret/keyset governs the check.
      const { alg } = decodeProtectedHeader(token);
      let payload: JWTPayload;
      // Both HS256 tokens name their issuer; the issuer picks which key must have signed it, and
      // the verify below pins that same issuer, so a token can't pick a key it wasn't signed with.
      const hsIssuer = alg === "HS256" ? decodeJwt(token).iss : undefined;
      if (alg === "HS256" && hsIssuer === INTERNAL_ISSUER && internal) {
        // Only on a connection the stack opened in memory (internal-fetch.ts), never over the network.
        if (!isInternalRequest(req)) throw new Error("internal token on an outside connection");
        ({ payload } = await jwtVerify(token, internal.key, {
          issuer: INTERNAL_ISSUER,
          audience: INTERNAL_AUDIENCE,
          algorithms: ["HS256"],
          requiredClaims: ["exp", "iat", "sub"],
          maxTokenAge: "2h",
        }));
      } else if (alg === "HS256" && hsIssuer !== INTERNAL_ISSUER && local) {
        ({ payload } = await jwtVerify(token, local.key, {
          issuer: LOCAL_ISSUER,
          audience: LOCAL_AUDIENCE,
          algorithms: ["HS256"],
          // A local token is only ever meant to be short-lived (mintLocalToken's default is
          // 8h); requiring exp/iat/sub and bounding age by maxTokenAge means a token can't be
          // crafted to omit exp or to stay "fresh" forever on a far-future expiry alone.
          requiredClaims: ["exp", "iat", "sub"],
          maxTokenAge: "8h",
        }));
      } else if (entra) {
        ({ payload } = await jwtVerify(token, entra.keys, { issuer: entra.issuer, audience: entra.audience, algorithms: ["RS256"] }));
      } else {
        throw new Error("no verifier configured for this token");
      }
      req.auth = {
        subject: String(payload.sub),
        roles: Array.isArray(payload.roles) ? payload.roles.map(String) : [],
        // `via` marks how the caller authenticated, and only the cookie path above may say
        // "session": a token's own claims never get to choose.
        claims: { ...(payload as Record<string, unknown>), via: "bearer" },
      };
      next();
    } catch {
      // decodeProtectedHeader throws on malformed tokens too — same 401, not a 500.
      res.status(401).json({ error: "invalid token" });
    }
  };
}

export function requireRole(role: string): RequestHandler {
  return (req, res, next) => (req.auth?.roles.includes(role) ? next() : void res.status(403).json({ error: "forbidden" }));
}

export function requireAnyRole(...roles: string[]): RequestHandler {
  return (req, res, next) => (req.auth?.roles.some((r) => roles.includes(r)) ? next() : void res.status(403).json({ error: "forbidden" }));
}

/** Who is acting, for audit logs: the session user's id and display name, or the token subject. */
export function actorOf(req: Request): { id: string; name: string } {
  const id = req.auth?.subject ?? "anonymous";
  const name = req.auth?.claims.name;
  return { id, name: typeof name === "string" && name ? name : id };
}
