import { DEFAULT_SESSION_MAX_SECONDS, mintSession, sessionCookie, type SessionUser } from "@gcpe/auth";

export interface SessionTerms {
  /** Core's id for this sign-in (staff_sessions), kept through every renewal. */
  sid: string;
  /** Unix seconds; a renewal passes the original on. */
  signedAt: number;
  maxSessionSeconds?: number;
  /** A break-glass sign-in's password fingerprint (review BG M1), kept through every renewal. */
  pwf?: string;
}

/** The one way Core issues a staff session, for password and Entra sign-in and renewal alike: the
 * same token, the same `gcpe_session` cookie attributes. The cookie lives as long as the token,
 * which never goes past sign-in + the session limit. `expiresAt` is Unix seconds. */
export async function newSessionCookie(secret: string, secure: boolean, user: SessionUser, terms: SessionTerms): Promise<{ cookie: string; expiresAt: number }> {
  const { token, expiresAt } = await mintSession(secret, user, { sid: terms.sid, signedAt: terms.signedAt, pwf: terms.pwf, maxSessionSeconds: terms.maxSessionSeconds ?? DEFAULT_SESSION_MAX_SECONDS });
  const maxAgeSeconds = Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
  return { cookie: sessionCookie(token, { secure, maxAgeSeconds }), expiresAt };
}
