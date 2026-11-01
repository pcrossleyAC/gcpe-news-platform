import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { createDb, type Db, type DbOrTx } from "@gcpe/db-kit";
import { ADMIN_ROLES, DEFAULT_SESSION_MAX_SECONDS, type SessionGate, type SessionUser } from "@gcpe/auth";
import { roleGrants, staffSessions, users } from "../db/schema";

/** Session id for the environment break-glass admin (LOCAL_ADMIN_*); it has no users row. */
export const BREAK_GLASS_ID = "local:admin";
export const BREAK_GLASS_NAME = "Administrator (break-glass)";
export const breakGlassUser = (): SessionUser => ({ id: BREAK_GLASS_ID, name: BREAK_GLASS_NAME, email: "", roles: [...ADMIN_ROLES] });

/**
 * Fix round 1 (review S I1): the session check runs on every cookie request in every app, so it
 * gets its own small pool that gives up within seconds: Core's own work can't starve it, and a slow
 * or unreachable database is a quick 503 ("sign-in check unavailable"), never a hang.
 */
export function sessionCheckDb(url: string): ReturnType<typeof createDb> {
  return createDb(url, { max: 4, connectionTimeoutMillis: 2000, statementTimeoutMillis: 2000, queryTimeoutMillis: 2500 });
}

/**
 * The session id of a token from before the 12-hour limit (no `sid`): fixed for that token
 * (person, issue time), so its first check-in records it once, and Sign out or a copy of it can't
 * get a fresh one later (review S M3).
 */
export function legacySid(secret: string, userId: string, issuedAt: number): string {
  return createHash("sha256").update(`${userId}:${issuedAt}:${secret}`).digest("base64url").slice(0, 24);
}

/**
 * Break-glass sessions are also kept in this process's memory (review S I2): break-glass is the
 * way in when Core's database is the problem, so its sign-in, check-in and Sign out must work
 * without it. The database row is still written when it can be (a SiteGround restart, which
 * happens whenever the process sits idle, would otherwise sign break-glass out). sid → ended.
 */
const breakGlassSessions = new Map<string, { ended: boolean; signedAt: number }>();

/** For tests: whether this process still holds a break-glass session in memory. */
export function breakGlassSessionKnown(sid: string): boolean {
  return breakGlassSessions.has(sid);
}

const pruneOld = (db: Db, maxSessionSeconds: number) =>
  db.delete(staffSessions).where(lt(staffSessions.signedAt, new Date(Date.now() - (maxSessionSeconds + 3600) * 1000)));

/**
 * Records a sign-in (owner decision 2026-10-31) and returns its id, the token's `sid`. `signedAt`
 * is Unix seconds: now for a new sign-in, a pre-limit token's own `iat` when its renewal first
 * records it (then with that token's fixed `sid`; recorded once). Rows past the limit (plus an
 * hour's slack) go as new ones come in; they can no longer be used, since every app refuses a
 * token past the limit on its own. Break-glass: see breakGlassSessions; never fails.
 */
export async function startSession(db: Db, userId: string, signedAt: number, maxSessionSeconds = DEFAULT_SESSION_MAX_SECONDS, sid = randomBytes(18).toString("base64url")): Promise<string> {
  if (userId === BREAK_GLASS_ID) {
    // Review S N2: past the limit (plus an hour's slack) a session can't be used anyway.
    const cutoff = Math.floor(Date.now() / 1000) - maxSessionSeconds - 3600;
    for (const [k, v] of breakGlassSessions) if (v.signedAt < cutoff) breakGlassSessions.delete(k);
    if (!breakGlassSessions.has(sid) && signedAt >= cutoff) breakGlassSessions.set(sid, { ended: false, signedAt });
    try {
      await db.insert(staffSessions).values({ sid, userId, signedAt: new Date(signedAt * 1000) }).onConflictDoNothing();
    } catch (e) {
      console.warn(`[core] break-glass session kept in memory only: Core's database is unavailable (${e instanceof Error ? e.name : "error"})`);
    }
    return sid;
  }
  const at = new Date(signedAt * 1000);
  await db.insert(staffSessions).values({ sid, userId, signedAt: at }).onConflictDoNothing();
  // Suite review O3: the Users screen's "Last signed in". Every password and Microsoft sign-in
  // records its session here; a pre-limit token's first renewal passes its own (older) sign-in
  // time, so the latest one is kept.
  if (isUuid(userId)) await db.update(users).set({ lastSignInAt: sql`greatest(${users.lastSignInAt}, ${at.toISOString()}::timestamptz)` }).where(eq(users.id, userId));
  await pruneOld(db, maxSessionSeconds);
  return sid;
}

/** Sign out: this session is refused from its next request on, in every app. For break-glass the
 * memory record is ended first, so this works with the database down; anyone else's throws. */
export async function endSession(db: Db, sid: string, userId: string): Promise<void> {
  const end = () => db.insert(staffSessions).values({ sid, userId, signedAt: new Date(), endedAt: new Date() }).onConflictDoUpdate({ target: staffSessions.sid, set: { endedAt: sql`coalesce(${staffSessions.endedAt}, now())` } });
  if (userId === BREAK_GLASS_ID) {
    breakGlassSessions.set(sid, { ended: true, signedAt: breakGlassSessions.get(sid)?.signedAt ?? Math.floor(Date.now() / 1000) });
    try {
      await end();
    } catch (e) {
      console.warn(`[core] break-glass sign-out recorded in memory only: Core's database is unavailable (${e instanceof Error ? e.name : "error"})`);
    }
    return;
  }
  await end();
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

export function sessionGate(db: Db, opts: { localConfigured: boolean; secret: string }): SessionGate {
  return async (s) => {
    // A pre-limit token has no sid: its fixed one is looked up, and may have no row (not ended).
    const sid = s.sid ?? legacySid(opts.secret, s.id, s.signedAt);
    const rowRequired = s.sid !== undefined;
    // Break-glass has no users row; it's only valid while LOCAL_ADMIN_* config exists. Memory first,
    // then the database; with the database down, break-glass alone is let through (I2).
    if (s.id === BREAK_GLASS_ID) {
      if (!opts.localConfigured) return null;
      const held = breakGlassSessions.get(sid);
      if (held !== undefined) return held.ended ? null : breakGlassUser();
      let row: { userId: string; endedAt: Date | null } | undefined;
      try {
        [row] = await db.select({ userId: staffSessions.userId, endedAt: staffSessions.endedAt }).from(staffSessions).where(eq(staffSessions.sid, sid));
      } catch (e) {
        console.warn(`[core] break-glass session check without the database (${e instanceof Error ? e.name : "error"})`);
        return breakGlassUser();
      }
      if (row ? row.endedAt !== null || row.userId !== s.id : rowRequired) return null;
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
      .leftJoin(staffSessions, eq(staffSessions.sid, sid))
      .where(eq(users.id, s.id));
    if (!row || !row.isActive) return null;
    if (row.sessionUserId === null ? rowRequired : row.sessionUserId !== s.id || row.endedAt !== null) return null;
    // An active user always has an email (users_active_needs_email).
    return { id: s.id, name: row.name, email: row.email ?? "", roles: [...row.roles].sort((a, b) => a.localeCompare(b, "en")) };
  };
}
