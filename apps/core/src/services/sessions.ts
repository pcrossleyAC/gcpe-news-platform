import { randomBytes } from "node:crypto";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbOrTx } from "@gcpe/db-kit";
import { ADMIN_ROLES, DEFAULT_SESSION_MAX_SECONDS, type SessionGate, type SessionUser } from "@gcpe/auth";
import { roleGrants, staffSessions, users } from "../db/schema";

/** Session id for the environment break-glass admin (LOCAL_ADMIN_*); it has no users row. */
export const BREAK_GLASS_ID = "local:admin";
export const BREAK_GLASS_NAME = "Administrator (break-glass)";
export const breakGlassUser = (): SessionUser => ({ id: BREAK_GLASS_ID, name: BREAK_GLASS_NAME, email: "", roles: [...ADMIN_ROLES] });

/**
 * Records a sign-in (owner decision 2026-10-31) and returns its id, the token's `sid`. `signedAt`
 * is Unix seconds: now for a new sign-in, a pre-limit token's own `iat` when its renewal first
 * records it. Rows past the limit (plus an hour's slack) go as new ones come in; they can no
 * longer be used, since every app refuses a token past the limit on its own.
 */
export async function startSession(db: Db, userId: string, signedAt: number, maxSessionSeconds = DEFAULT_SESSION_MAX_SECONDS): Promise<string> {
  const sid = randomBytes(18).toString("base64url");
  await db.insert(staffSessions).values({ sid, userId, signedAt: new Date(signedAt * 1000) });
  await db.delete(staffSessions).where(lt(staffSessions.signedAt, new Date(Date.now() - (maxSessionSeconds + 3600) * 1000)));
  return sid;
}

/** Sign out: this session is refused from its next request on, in every app. */
export async function endSession(db: Db, sid: string): Promise<void> {
  await db.update(staffSessions).set({ endedAt: new Date() }).where(and(eq(staffSessions.sid, sid), isNull(staffSessions.endedAt)));
}

/** A deactivation ends every one of the person's sessions, so reactivating them later doesn't bring an old cookie back. */
export async function endUserSessions(tx: DbOrTx, userId: string): Promise<void> {
  await tx.update(staffSessions).set({ endedAt: new Date() }).where(and(eq(staffSessions.userId, userId), isNull(staffSessions.endedAt)));
}

const isUuid = (v: string) => z.string().uuid().safeParse(v).success;

/**
 * Core's session gate (see SessionGate): on every cookie request, in Core and, through the
 * stack, in every other app. One indexed query: the person as Core holds them now (active,
 * current roles and name) and this sign-in's row. Not cached, so the very next request after a
 * deactivation or a sign-out is refused, however many processes there are. A token from before
 * the limit has no `sid`: only the person's being active is checked, until its renewal records it.
 */

export function sessionGate(db: Db, opts: { localConfigured: boolean }): SessionGate {
  return async (s) => {
    // Break-glass has no users row; it's only valid while LOCAL_ADMIN_* config exists.
    if (s.id === BREAK_GLASS_ID) {
      if (!opts.localConfigured) return null;
      if (s.sid) {
        const [row] = await db.select({ userId: staffSessions.userId, endedAt: staffSessions.endedAt }).from(staffSessions).where(eq(staffSessions.sid, s.sid));
        if (!row || row.endedAt !== null || row.userId !== s.id) return null;
      }
      return breakGlassUser();
    }
    if (!isUuid(s.id)) return null;
    // One round trip: the person, every role they hold (the Calendar one too, as sessionRolesOf
    // gives it), and this sign-in's row.
    const [row] = await db
      .select({
        isActive: users.isActive,
        name: users.displayName,
        email: users.email,
        roles: sql<string[]>`coalesce((select array_agg(${roleGrants.role}) from ${roleGrants} where ${roleGrants.userId} = ${users.id}), '{}')`,
        sessionUserId: staffSessions.userId,
        endedAt: staffSessions.endedAt,
      })
      .from(users)
      .leftJoin(staffSessions, eq(staffSessions.sid, s.sid ?? ""))
      .where(eq(users.id, s.id));
    if (!row || !row.isActive) return null;
    if (s.sid && (row.sessionUserId === null || row.sessionUserId !== s.id || row.endedAt !== null)) return null;
    // An active user always has an email (users_active_needs_email).
    return { id: s.id, name: row.name, email: row.email ?? "", roles: [...row.roles].sort((a, b) => a.localeCompare(b, "en")) };
  };
}
