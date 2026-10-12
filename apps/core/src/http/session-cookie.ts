import { mintSession, SESSION_TTL_SECONDS, sessionCookie, type SessionUser } from "@gcpe/auth";

/** The one way Core issues a staff session, for password and Entra sign-in alike: the same
 * token, the same `gcpe_session` cookie attributes. `expiresAt` is Unix seconds. */
export async function newSessionCookie(secret: string, secure: boolean, user: SessionUser): Promise<{ cookie: string; expiresAt: number }> {
  const { token, expiresAt } = await mintSession(secret, user);
  return { cookie: sessionCookie(token, { secure, maxAgeSeconds: SESSION_TTL_SECONDS }), expiresAt };
}
