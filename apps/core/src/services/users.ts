import { and, asc, eq, inArray, notLike, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbOrTx, Tx } from "@gcpe/db-kit";
import { hashPassword, isCalendarRole, STAFF_ROLES, verifyPassword, type CalendarRole, type SessionUser } from "@gcpe/auth";
import { enqueueEvent, type SubscriberConfig, type UserRecord } from "@gcpe/events";
import { organizations, roleGrants, userOrganizations, users } from "../db/schema";
import { CORE_SOURCE, lockAggregate, userAggregateId } from "./aggregate";

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(12, "use at least 12 characters").max(200);
const roles = z.array(z.enum(STAFF_ROLES)).max(20);
const displayName = z.string().trim().min(1).max(100);

export const createUserSchema = z
  .object({
    /** Null only for an inactive user: legacy Calendar users with no email (spec addendum §4). */
    email: email.nullable().default(null),
    displayName,
    roles: roles.default([]),
    password: password.optional(),
    /** Phase 3e (NRMS legacy importer): legacy staff import as inactive, with no password or roles. */
    isActive: z.boolean().default(true),
  })
  .refine((v) => v.email !== null || !v.isActive, { message: "an active user needs an email", path: ["email"] });
export type CreateUserInput = z.infer<typeof createUserSchema>;
export const linkUserSchema = z.object({ email });
export type LinkUserInput = z.infer<typeof linkUserSchema>;
export const updateUserSchema = z
  .object({ displayName: displayName.optional(), isActive: z.boolean().optional() })
  .refine((v) => v.displayName !== undefined || v.isActive !== undefined, "nothing to update");
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export const setRolesSchema = z.object({ roles });
export const setPasswordSchema = z.object({ password });

export interface UserView {
  id: string;
  /** Null only for an inactive user (spec addendum §4, users without email). */
  email: string | null;
  displayName: string;
  isActive: boolean;
  signInMethod: "local" | "entra";
  /** Flat staff roles (STAFF_ROLES). Never a Calendar role. */
  roles: string[];
  /** The user's one Calendar role, if any. */
  calendarRole: CalendarRole | null;
  /** The user's ministries, M(u), by organization key, sorted. */
  organizationKeys: string[];
}

export class UserExistsError extends Error {}
export class UserNotFoundError extends Error {}
/**
 * Activating a user with no email: refused before it reaches the database, and also thrown
 * if the `users_active_needs_email` check (23514) is hit anyway, so it never surfaces as a raw
 * database error.
 */
export class UserNeedsEmailError extends Error {}
/** Linking an email onto a user that already has one. */
export class UserAlreadyHasEmailError extends Error {}

const isUuid = (id: string) => z.string().uuid().safeParse(id).success;
/** Postgres stores and returns UUIDs lowercased: locking that form makes two differently-cased
 * copies of one id share one lock. After the row is read, writers use the stored row id. */
const lockUser = (tx: Tx, id: string) => lockAggregate(tx, userAggregateId(id.toLowerCase()));
// drizzle wraps driver errors; the pg error (with .code and .constraint) is on .cause. Named,
// not just "any 23505", so a future unique constraint (e.g. role_grants_one_calendar_role)
// doesn't get mistaken for a duplicate email.
const isDuplicateEmail = (e: unknown) => {
  const cause = (e as { cause?: { code?: string; constraint?: string } }).cause;
  return cause?.code === "23505" && cause.constraint === "users_email_lower_idx";
};
const isCheckViolation = (e: unknown, constraint: string) => {
  const cause = (e as { cause?: { code?: string; constraint?: string } }).cause;
  return cause?.code === "23514" && cause.constraint === constraint;
};

type UserRow = typeof users.$inferSelect;

async function withAccess(db: DbOrTx, rows: UserRow[]): Promise<UserView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const grants = await db.select().from(roleGrants).where(inArray(roleGrants.userId, ids));
  const memberships = await db
    .select({ userId: userOrganizations.userId, key: organizations.key })
    .from(userOrganizations)
    .innerJoin(organizations, eq(organizations.id, userOrganizations.organizationId))
    .where(inArray(userOrganizations.userId, ids));
  const flat = new Map<string, string[]>();
  const calendar = new Map<string, CalendarRole>();
  const orgKeys = new Map<string, string[]>();
  for (const g of grants) {
    if (isCalendarRole(g.role)) calendar.set(g.userId, g.role);
    else flat.set(g.userId, [...(flat.get(g.userId) ?? []), g.role]);
  }
  for (const m of memberships) orgKeys.set(m.userId, [...(orgKeys.get(m.userId) ?? []), m.key]);
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    displayName: r.displayName,
    isActive: r.isActive,
    signInMethod: r.signInMethod,
    // Case-insensitive and locale-pinned, so the all-caps "NRMS.*" roles don't jump ahead of
    // "NoD.*" (plain .sort() is case-sensitive) and the order is the same regardless of the
    // server's configured locale (default localeCompare() isn't).
    roles: (flat.get(r.id) ?? []).sort((a, b) => a.localeCompare(b, "en")),
    calendarRole: calendar.get(r.id) ?? null,
    organizationKeys: (orgKeys.get(r.id) ?? []).sort(),
  }));
}

/** The roles a session carries: the flat roles plus the Calendar role, so role checks see both. */
export function sessionRolesOf(u: Pick<UserView, "roles" | "calendarRole">): string[] {
  return [...u.roles, ...(u.calendarRole ? [u.calendarRole] : [])].sort((a, b) => a.localeCompare(b, "en"));
}

export function toUserRecord(u: UserView): UserRecord {
  return { id: u.id, email: u.email, displayName: u.displayName, isActive: u.isActive, calendarRole: u.calendarRole, organizationKeys: u.organizationKeys };
}

/**
 * Enqueues `user.upserted` with the user's current record. Call inside the writing transaction,
 * after lockAggregate(userAggregateId(id)), so sequences follow commit order.
 */
export async function emitUserUpserted(tx: Tx, id: string, subscribers: SubscriberConfig[]): Promise<void> {
  const u = await getUser(tx, id);
  if (!u) return;
  // The stored id, so the event stream is the same whatever case the caller spelled the id in.
  await enqueueEvent(tx, { type: "user.upserted", source: CORE_SOURCE, aggregateId: userAggregateId(u.id), data: toUserRecord(u) }, subscribers);
}

export async function listUsers(db: Db): Promise<UserView[]> {
  return withAccess(db, await db.select().from(users).orderBy(asc(sql`lower(${users.displayName})`), asc(users.email)));
}

/**
 * Plan 3d task 4: the active Core.Admin emails Project Blue Bridge notifies — a narrow read
 * used by NRMS (via `GET /api/directory/admin-emails`, service-only `Core.AdminDirectory` role
 * or `Core.Admin` itself), never the full user list or anything else about each admin.
 */
export async function adminEmails(db: Db): Promise<string[]> {
  const rows = await db
    .select({ email: users.email })
    .from(users)
    .innerJoin(roleGrants, eq(roleGrants.userId, users.id))
    .where(and(eq(users.isActive, true), eq(roleGrants.role, "Core.Admin")));
  return [...new Set(rows.flatMap((r) => (r.email ? [r.email] : [])))].sort();
}

export async function getUser(db: DbOrTx, id: string): Promise<UserView | null> {
  if (!isUuid(id)) return null;
  const rows = await db.select().from(users).where(eq(users.id, id));
  return (await withAccess(db, rows))[0] ?? null;
}

export async function findUserByEmail(db: Db, address: string): Promise<UserView | null> {
  const rows = await db.select().from(users).where(sql`lower(${users.email}) = ${address.trim().toLowerCase()}`);
  return (await withAccess(db, rows))[0] ?? null;
}

export async function createUser(db: Db, input: CreateUserInput, subscribers: SubscriberConfig[]): Promise<UserView> {
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  try {
    const id = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(users)
        .values({ email: input.email, displayName: input.displayName, passwordHash, isActive: input.isActive })
        .returning({ id: users.id });
      await lockAggregate(tx, userAggregateId(row!.id));
      const unique = [...new Set(input.roles)];
      if (unique.length) await tx.insert(roleGrants).values(unique.map((role) => ({ userId: row!.id, role })));
      await emitUserUpserted(tx, row!.id, subscribers);
      return row!.id;
    });
    return (await getUser(db, id))!;
  } catch (e) {
    if (isDuplicateEmail(e)) throw new UserExistsError(input.email ?? "");
    // createUserSchema refuses an active user with no email, but a caller that skips the schema
    // (a legacy Calendar importer) hits users_active_needs_email instead: report it the same way.
    if (isCheckViolation(e, "users_active_needs_email")) throw new UserNeedsEmailError("new user");
    throw e;
  }
}

export async function updateUser(db: Db, id: string, patch: UpdateUserInput, subscribers: SubscriberConfig[]): Promise<UserView> {
  if (!isUuid(id)) throw new UserNotFoundError(id);
  try {
    await db.transaction(async (tx) => {
      await lockUser(tx, id);
      const [row] = await tx.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, id)).for("update");
      if (!row) throw new UserNotFoundError(id);
      if (patch.isActive === true && row.email === null) throw new UserNeedsEmailError(id);
      await tx
        .update(users)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(users.id, row.id));
      await emitUserUpserted(tx, row.id, subscribers);
    });
  } catch (e) {
    // A no-email user (legacy Calendar import) can't be reactivated (users_active_needs_email);
    // the check above catches this first, but the database constraint stays the backstop.
    if (isCheckViolation(e, "users_active_needs_email")) throw new UserNeedsEmailError(id);
    throw e;
  }
  return (await getUser(db, id))!;
}

/**
 * Sets the email of a user who has none, and activates them (spec addendum §4): legacy
 * Calendar users imported without an email are linked this way, and Entra matching later uses it.
 */
export async function linkUser(db: Db, id: string, address: string, subscribers: SubscriberConfig[]): Promise<UserView> {
  if (!isUuid(id)) throw new UserNotFoundError(id);
  try {
    await db.transaction(async (tx) => {
      await lockUser(tx, id);
      const [row] = await tx.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, id)).for("update");
      if (!row) throw new UserNotFoundError(id);
      if (row.email !== null) throw new UserAlreadyHasEmailError(id);
      await tx.update(users).set({ email: address, isActive: true, updatedAt: new Date() }).where(eq(users.id, row.id));
      await emitUserUpserted(tx, row.id, subscribers);
    });
  } catch (e) {
    if (isDuplicateEmail(e)) throw new UserExistsError(address);
    throw e;
  }
  return (await getUser(db, id))!;
}

/** Replaces the user's flat roles. The Calendar role is changed only through calendar-access.ts and is kept here. */
export async function setRoles(db: Db, id: string, next: string[], subscribers: SubscriberConfig[]): Promise<UserView> {
  if (next.some(isCalendarRole)) throw new Error("setRoles never sets a Calendar role; use setCalendarAccess");
  if (!isUuid(id)) throw new UserNotFoundError(id);
  await db.transaction(async (tx) => {
    await lockUser(tx, id);
    const [row] = await tx.select({ id: users.id }).from(users).where(eq(users.id, id)).for("update");
    if (!row) throw new UserNotFoundError(id);
    await tx.delete(roleGrants).where(and(eq(roleGrants.userId, row.id), notLike(roleGrants.role, "Calendar.%")));
    const unique = [...new Set(next)];
    if (unique.length) await tx.insert(roleGrants).values(unique.map((role) => ({ userId: row.id, role })));
    await tx.update(users).set({ updatedAt: new Date() }).where(eq(users.id, row.id));
    await emitUserUpserted(tx, row.id, subscribers);
  });
  return (await getUser(db, id))!;
}

export async function setPassword(db: Db, id: string, pw: string): Promise<void> {
  if (!isUuid(id)) throw new UserNotFoundError(id);
  const passwordHash = await hashPassword(pw);
  const updated = await db.update(users).set({ passwordHash, signInMethod: "local", updatedAt: new Date() }).where(eq(users.id, id)).returning({ id: users.id });
  if (updated.length === 0) throw new UserNotFoundError(id);
}

// Compared against when the email is unknown or has no password, so every sign-in attempt
// costs exactly one scrypt verification (no timing tell for "no such user").
let dummyHash: Promise<string> | undefined;

export async function authenticate(db: Db, address: string, pw: string): Promise<UserView | null> {
  const [row] = await db.select().from(users).where(sql`lower(${users.email}) = ${address.trim().toLowerCase()}`);
  const stored = row?.passwordHash ?? (await (dummyHash ??= hashPassword("placeholder-never-matches-anything")));
  const ok = await verifyPassword(pw, stored);
  if (!row || !row.isActive || !row.passwordHash || !ok) return null;
  return getUser(db, row.id);
}

/** The current identity for a session, or null if the user no longer exists or is inactive. */
export async function sessionUserFor(db: Db, id: string): Promise<SessionUser | null> {
  const u = await getUser(db, id);
  // An active user always has an email (users_active_needs_email).
  return u && u.isActive ? { id: u.id, name: u.displayName, email: u.email ?? "", roles: sessionRolesOf(u) } : null;
}
