import type { Request, RequestHandler } from "express";
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { assertSecretStrength, LOCAL_AUDIENCE, LOCAL_ISSUER, localKey } from "./local";
import { CSRF_HEADER, readCookie, SESSION_COOKIE, verifySession, type VerifiedSession } from "./session";

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
  /** Accept Core's staff session cookie (spec addendum §2). */
  session?: { secret: string };
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
  if (opts.session) assertSecretStrength(opts.session.secret);
  const sessionSecret = opts.session?.secret;
  return async (req, res, next) => {
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
    const token = header.slice(7);
    try {
      // Branch on the token's own alg header, but always verify against the
      // pinned algorithm list for that branch — never let the header pick
      // which secret/keyset governs the check.
      const { alg } = decodeProtectedHeader(token);
      let payload: JWTPayload;
      if (alg === "HS256" && local) {
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
