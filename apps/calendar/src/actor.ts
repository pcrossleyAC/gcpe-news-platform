import type { RequestHandler } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbOrTx } from "@gcpe/db-kit";
import { CALENDAR_LEVELS, type CalendarRole } from "@gcpe/auth";
import { safeErrorLabel } from "@gcpe/http-kit";
import { orgs, users } from "./db/schema";

/** Who is asking, as the Calendar's projections say now: L(u), M(u) and HQ(u) of spec addendum §6. */
export interface CalendarActor {
  userId: string;
  displayName: string;
  role: CalendarRole;
  level: number;
  ministryKeys: string[];
  isHq: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      calendar?: CalendarActor;
    }
  }
}

const isUuid = (s: string) => z.string().uuid().safeParse(s).success;

/**
 * The caller's Calendar access from the projections, or null for none: a subject that isn't a
 * projected user, an inactive user, or one with no Calendar role. HQ is any of the user's
 * organizations flagged HQ, whether or not it is still active, the same rule as Core's grant
 * checks (Q56).
 */
export async function loadCalendarActor(db: DbOrTx, subject: string): Promise<CalendarActor | null> {
  if (!isUuid(subject)) return null;
  const [u] = await db.select().from(users).where(eq(users.id, subject.toLowerCase()));
  if (!u || !u.isActive || !u.calendarRole) return null;
  const hq = u.organizationKeys.length
    ? await db.select({ key: orgs.key }).from(orgs).where(and(inArray(orgs.key, u.organizationKeys), eq(orgs.isHq, true))).limit(1)
    : [];
  return { userId: u.id, displayName: u.displayName, role: u.calendarRole, level: CALENDAR_LEVELS[u.calendarRole], ministryKeys: u.organizationKeys, isHq: hq.length > 0 };
}

/**
 * Runs after requireBearer on every /api request. Only a staff session can act in the Calendar.
 * requireBearer sets `via: "session"` only on its cookie path and forces `via: "bearer"` on every
 * token, whatever the token itself claims, so a bearer token (break-glass or service) has no
 * Calendar access even when its subject is a projected user's id.
 * A session cookie's roles were minted at sign-in and can be an hour old, so they are never used
 * here either: a revoked grant takes effect as soon as its user.upserted arrives (spec addendum §4).
 */
export function requireCalendarActor(db: Db): RequestHandler {
  return async (req, res, next) => {
    try {
      const actor = req.auth?.claims.via === "session" ? await loadCalendarActor(db, req.auth.subject) : null;
      if (!actor) return void res.status(403).json({ error: "no Calendar access" });
      req.calendar = actor;
      next();
    } catch (e) {
      console.error("[calendar] actor lookup failed", safeErrorLabel(e));
      res.status(500).json({ error: "internal error" });
    }
  };
}

/** Every check is "level ≥ n" (spec addendum §4). */
export function requireLevel(min: CalendarRole): RequestHandler {
  return (req, res, next) => ((req.calendar?.level ?? 0) >= CALENDAR_LEVELS[min] ? next() : void res.status(403).json({ error: "forbidden" }));
}
