import type { RequestHandler } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

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

export function requireBearer(opts: { issuer: string; audience: string; keys: JWTVerifyGetKey }): RequestHandler {
  return async (req, res, next) => {
    const header = req.header("authorization");
    if (!header?.startsWith("Bearer ")) return void res.status(401).json({ error: "missing bearer token" });
    try {
      const { payload } = await jwtVerify(header.slice(7), opts.keys, { issuer: opts.issuer, audience: opts.audience });
      req.auth = {
        subject: String(payload.sub),
        roles: Array.isArray(payload.roles) ? payload.roles.map(String) : [],
        claims: payload as Record<string, unknown>,
      };
      next();
    } catch {
      res.status(401).json({ error: "invalid token" });
    }
  };
}

export function requireRole(role: string): RequestHandler {
  return (req, res, next) => (req.auth?.roles.includes(role) ? next() : void res.status(403).json({ error: "forbidden" }));
}
