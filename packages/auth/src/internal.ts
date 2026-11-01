import type { Request } from "express";
import { SignJWT } from "jose";
import { assertSecretStrength } from "./local";

/**
 * The stack's own app-to-app token (owner decision 2026-10-31, production configuration T2).
 *
 * Every app in the stack runs in one process and calls the others over in-memory connections
 * (apps/stack/src/internal-fetch.ts). Those calls used to carry a token signed with the break-glass
 * admin's LOCAL_AUTH_SECRET, so turning break-glass off stopped the stack starting. This token has
 * its own key, derived by the stack from STACK_EVENT_SECRET (envFor's SERVICE_TOKEN_SECRET), keeps
 * each caller's own subject, azp and roles, and is accepted only on a connection the stack itself
 * opened in memory: a copy of one (from a log, say) is useless from IIS, the DMZ or the network.
 */
export const INTERNAL_ISSUER = "gcpe-internal";
export const INTERNAL_AUDIENCE = "gcpe-internal";
export const INTERNAL_TOKEN_TTL_SECONDS = 3600;

/** The origin every `self:/…` URL resolves to; requests to it never leave the process. */
export const INTERNAL_ORIGIN = "http://stack.internal";

/** Set on the server side of every in-memory connection installInternalFetch opens. A symbol, so
 * no request content (headers, body, address) can set or imitate it. `Symbol.for` so the stack and
 * every app agree on it even if two copies of this package were ever loaded. */
const INTERNAL_SOCKET = Symbol.for("gcpe.internal-socket");

export function markInternalSocket(socket: object): void {
  Object.defineProperty(socket, INTERNAL_SOCKET, { value: true });
}

/** Whether this request arrived on one of the stack's own in-memory connections. */
export function isInternalRequest(req: Pick<Request, "socket">): boolean {
  return (req.socket as unknown as Record<symbol, unknown> | undefined)?.[INTERNAL_SOCKET] === true;
}

/** Whether a URL is served in-process by the stack (so an internal token may be sent to it). */
export function isInternalUrl(url: string | undefined): boolean {
  return url !== undefined && (url === INTERNAL_ORIGIN || url.startsWith(`${INTERNAL_ORIGIN}/`));
}

export const internalKey = (secret: string) => new TextEncoder().encode(secret);

export async function mintInternalToken(o: { secret: string; subject: string; roles: readonly string[]; now?: () => number }): Promise<string> {
  assertSecretStrength(o.secret);
  const now = Math.floor((o.now ?? Date.now)() / 1000);
  return new SignJWT({ roles: [...o.roles], azp: o.subject })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(INTERNAL_ISSUER)
    .setAudience(INTERNAL_AUDIENCE)
    .setSubject(o.subject)
    .setIssuedAt(now)
    .setExpirationTime(now + INTERNAL_TOKEN_TTL_SECONDS)
    .sign(internalKey(o.secret));
}

