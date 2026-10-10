import { and, asc, eq, gte, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbOrTx, Tx } from "@gcpe/db-kit";
import type { CalendarRole } from "@gcpe/auth";
import type { ApiDeps } from "./http/routes";
import { activities, commContacts, orgs, userProfiles, users } from "./db/schema";
import { bcMidnight, dbNow, wallClock } from "./time";
import { visibleSql, type Viewer } from "./visibility";

export class CalendarUserNotFoundError extends Error {
  override name = "CalendarUserNotFoundError";
}
export class NotUsersMinistryError extends Error {
  override name = "NotUsersMinistryError";
  constructor(readonly ministryKey: string) {
    super("not one of the user's ministries");
  }
}

export interface CalendarUserRow {
  userId: string;
  displayName: string;
  email: string | null;
  isActive: boolean;
  role: CalendarRole | null;
  ministryKey: string | null;
  ministryAbbreviation: string | null;
  rank: number | null;
}

export interface Profile {
  phone: string | null;
  mobile: string | null;
  jobTitle: string | null;
  description: string | null;
}

export interface CalendarUserDetail {
  user: { id: string; displayName: string; email: string | null; isActive: boolean; role: CalendarRole | null; ministryKeys: string[] };
  profile: Profile;
  commContacts: { ministryKey: string; rank: number | null; isActive: boolean }[];
}

const isUuid = (s: string) => z.string().uuid().safeParse(s).success;
const blankToNull = (v: string | null | undefined) => (v ? v : null);
// PhoneNumber was free NVARCHAR(20) in legacy, with no format check: only the length limit applies.
const phone = z.string().trim().max(20, "at most 20 characters").nullable().transform(blankToNull);
// Legacy's CHECK on MobileNumber (user_profiles_mobile_check in db/schema.ts): blank, or exactly
// 12 characters of digits and hyphens.
const mobile = z
  .string()
  .trim()
  .regex(/^[0-9-]{12}$/, "use 12 digits and hyphens, like 250-555-0100")
  .or(z.literal(""))
  .nullable()
  .transform(blankToNull);

export const profileSchema = z
  .object({
    phone,
    mobile,
    jobTitle: z.string().trim().max(100, "job title: at most 100 characters").nullable().transform(blankToNull),
    description: z.string().trim().max(2000, "description: at most 2000 characters").nullable().transform(blankToNull),
  })
  .strict();

/** Rank 1 Comm Director … 6 Other (Admin/User.aspx.cs:16-25); null is "not a comm contact". */
export const rankSchema = z.object({ rank: z.number().int().min(1).max(6).nullable() }).strict();

/**
 * Legacy's user list (Admin/UserList.aspx.cs:15-39): one row per user and ministry, ordered by
 * ministry abbreviation then name, each with that ministry's comm-contact rank (C165). A user
 * with no ministries gets one row without a ministry.
 */
export async function listCalendarUsers(db: DbOrTx, opts: { inactive: boolean; noAccess: boolean }): Promise<CalendarUserRow[]> {
  const r = await db.execute<Record<string, unknown>>(sql`
    SELECT u.id AS "userId", u.display_name AS "displayName", u.email, u.is_active AS "isActive", u.calendar_role AS "role",
           m.key AS "ministryKey", o.abbreviation AS "ministryAbbreviation",
           CASE WHEN c.is_active THEN c.rank END AS "rank"
    FROM users u
    LEFT JOIN LATERAL unnest(u.organization_keys) AS m(key) ON true
    LEFT JOIN orgs o ON o.key = m.key
    LEFT JOIN comm_contacts c ON c.user_id = u.id AND c.ministry_key = m.key
    WHERE (${opts.inactive} OR u.is_active) AND (${opts.noAccess} OR u.calendar_role IS NOT NULL)
    ORDER BY coalesce(o.abbreviation, m.key, '~'), lower(u.display_name), u.id`);
  return r.rows.map((row) => ({
    userId: row.userId as string,
    displayName: row.displayName as string,
    email: (row.email as string | null) ?? null,
    isActive: row.isActive === true,
    role: (row.role as CalendarRole | null) ?? null,
    ministryKey: (row.ministryKey as string | null) ?? null,
    ministryAbbreviation: (row.ministryAbbreviation as string | null) ?? null,
    rank: (row.rank as number | null) ?? null,
  }));
}

async function projectedUser(db: DbOrTx, id: string) {
  if (!isUuid(id)) throw new CalendarUserNotFoundError();
  const [u] = await db.select().from(users).where(eq(users.id, id));
  if (!u) throw new CalendarUserNotFoundError();
  return u;
}

export async function getCalendarUser(db: DbOrTx, id: string): Promise<CalendarUserDetail> {
  const u = await projectedUser(db, id);
  const [p] = await db.select().from(userProfiles).where(eq(userProfiles.userId, u.id));
  const contacts = await db.select().from(commContacts).where(eq(commContacts.userId, u.id)).orderBy(commContacts.ministryKey);
  return {
    user: { id: u.id, displayName: u.displayName, email: u.email, isActive: u.isActive, role: u.calendarRole, ministryKeys: u.organizationKeys },
    profile: { phone: p?.phone ?? null, mobile: p?.mobile ?? null, jobTitle: p?.jobTitle ?? null, description: p?.description ?? null },
    commContacts: contacts.map((c) => ({ ministryKey: c.ministryKey, rank: c.rank, isActive: c.isActive })),
  };
}

/**
 * Every write to one user's Calendar data takes this first, then reads what it relies on. The id is
 * lowercased, the form Postgres stores, so two spellings of one id share one lock.
 */
export async function lockUserData(tx: Tx, id: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`calendar-user:${id.toLowerCase()}`}))`);
}

export async function saveProfile(db: Db, id: string, input: Profile): Promise<Profile> {
  return db.transaction(async (tx) => {
    if (!isUuid(id)) throw new CalendarUserNotFoundError();
    await lockUserData(tx, id);
    const u = await projectedUser(tx, id);
    await tx.select().from(userProfiles).where(eq(userProfiles.userId, u.id)).for("update");
    const values = { ...input, updatedAt: new Date() };
    await tx.insert(userProfiles).values({ userId: u.id, ...values }).onConflictDoUpdate({ target: userProfiles.userId, set: values });
    return input;
  });
}

export async function setCommContactRank(db: Db, id: string, ministryKey: string, rank: number | null): Promise<CalendarUserDetail["commContacts"]> {
  return db.transaction(async (tx) => {
    if (!isUuid(id)) throw new CalendarUserNotFoundError();
    await lockUserData(tx, id);
    const u = await projectedUser(tx, id);
    // ministryKey arrives exactly as the Calendar stores it (spec addendum §5.2): Core keys are
    // byte for byte, and legacy's own GCPE ministry keys are uppercase GUIDs.
    if (!u.organizationKeys.includes(ministryKey)) throw new NotUsersMinistryError(ministryKey);
    const [existing] = await tx.select().from(commContacts).where(and(eq(commContacts.userId, u.id), eq(commContacts.ministryKey, ministryKey))).for("update");
    if (existing) {
      await tx
        .update(commContacts)
        .set(rank === null ? { isActive: false } : { rank, isActive: true })
        .where(eq(commContacts.id, existing.id));
    } else if (rank !== null) {
      await tx.insert(commContacts).values({ userId: u.id, ministryKey, rank, isActive: true });
    }
    return (await getCalendarUser(tx, u.id)).commContacts;
  });
}

export interface OpenActivity {
  id: number;
  /** Legacy's MIN-Id. */
  reference: string;
  title: string;
  startAt: string | null;
  endAt: string | null;
  startDate: string | null;
  endDate: string | null;
}

/**
 * What legacy's user page listed before deactivating (User.aspx:183-223): activities whose comm
 * contact is one of the user's active comm contacts, here only those still open (not deleted,
 * ending today or later, or undated) and visible to the Administrator. No count of the rest: it
 * would reveal confidential activities.
 */
export async function openActivitiesOf(deps: ApiDeps, actor: Viewer, userId: string, opts: { limit?: number } = {}): Promise<{ activities: OpenActivity[]; truncated: boolean }> {
  const u = await projectedUser(deps.db, userId);
  const limit = opts.limit ?? 500;
  const now = await dbNow(deps.db, deps.now);
  const today = bcMidnight(wallClock(now, deps.rules.timeZone).date, deps.rules.timeZone);
  const ends = sql`coalesce(${activities.endAt}, ${activities.startAt})`;
  const rows = await deps.db
    .select({ id: activities.id, title: activities.title, startAt: activities.startAt, endAt: activities.endAt, abbreviation: orgs.abbreviation })
    .from(activities)
    .innerJoin(commContacts, eq(commContacts.id, activities.commContactId))
    .leftJoin(orgs, eq(orgs.key, activities.contactMinistryKey))
    .where(and(eq(commContacts.userId, u.id), eq(commContacts.isActive, true), isNull(activities.deletedAt), or(sql`${ends} IS NULL`, gte(ends, today)), visibleSql(actor)))
    .orderBy(sql`${activities.startAt} ASC NULLS LAST`, asc(activities.id))
    .limit(limit + 1);
  const local = (d: Date | null) => (d ? wallClock(d, deps.rules.timeZone).date : null);
  return {
    truncated: rows.length > limit,
    activities: rows.slice(0, limit).map((r) => ({
      id: r.id, reference: `${r.abbreviation ?? "?"}-${r.id}`, title: r.title,
      startAt: r.startAt?.toISOString() ?? null, endAt: r.endAt?.toISOString() ?? null, startDate: local(r.startAt), endDate: local(r.endAt),
    })),
  };
}
