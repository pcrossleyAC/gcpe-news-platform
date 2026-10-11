import type { Request } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx } from "@gcpe/db-kit";
import { CALENDAR_LEVELS } from "@gcpe/auth";
import type { Viewer } from "@gcpe/calendar-contract";
import { calendarViewers, organizations } from "../db/schema";

const isUuid = (s: string) => z.string().uuid().safeParse(s).success;

/**
 * The caller as the Calendar's visibility rule sees them (spec addendum §6), from Core's
 * user.upserted, or null for no Calendar access. Only a staff session counts: a bearer token
 * (break-glass or service) sees no activity, whatever its subject (the Calendar refuses bearer
 * tokens outright). HQ is any of the user's organizations flagged HQ, active or not, as in the
 * Calendar (Q56).
 */
export async function calendarViewerOf(db: DbOrTx, req: Request): Promise<Viewer | null> {
  if (req.auth?.claims.via !== "session" || !isUuid(req.auth.subject)) return null;
  const [v] = await db.select().from(calendarViewers).where(eq(calendarViewers.userId, req.auth.subject.toLowerCase()));
  if (!v || !v.isActive || !v.calendarRole) return null;
  const hq = v.organizationKeys.length
    ? await db.select({ key: organizations.key }).from(organizations).where(and(inArray(organizations.key, v.organizationKeys.map((k) => k.toLowerCase())), eq(organizations.isHq, true))).limit(1)
    : [];
  return { level: CALENDAR_LEVELS[v.calendarRole], isHq: hq.length > 0, ministryKeys: v.organizationKeys };
}
