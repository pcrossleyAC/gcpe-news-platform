import { asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbOrTx } from "@gcpe/db-kit";
import { hashPassword, STAFF_ROLES, verifyPassword, type SessionUser } from "@gcpe/auth";
import { roleGrants, users } from "../db/schema";

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(12, "use at least 12 characters").max(200);
const roles = z.array(z.enum(STAFF_ROLES)).max(20);
const displayName = z.string().trim().min(1).max(100);

export const createUserSchema = z.object({ email, displayName, roles: roles.default([]), password: password.optional() });
export type CreateUserInput = z.infer<typeof createUserSchema>;
export const updateUserSchema = z
  .object({ displayName: displayName.optional(), isActive: z.boolean().optional() })
  .refine((v) => v.displayName !== undefined || v.isActive !== undefined, "nothing to update");
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export const setRolesSchema = z.object({ roles });
export const setPasswordSchema = z.object({ password });

export interface UserView {
  id: string;
  email: string;
  displayName: string;
  isActive: boolean;
  signInMethod: "local" | "entra";
  roles: string[];
}

export class UserExistsError extends Error {}
export class UserNotFoundError extends Error {}

const isUuid = (id: string) => z.string().uuid().safeParse(id).success;
// drizzle wraps driver errors; the pg error (with .code) is on .cause.
const isUniqueViolation = (e: unknown) => (e as { cause?: { code?: string } }).cause?.code === "23505";

type UserRow = typeof users.$inferSelect;

async function withRoles(db: DbOrTx, rows: UserRow[]): Promise<UserView[]> {
  if (rows.length === 0) return [];
  const grants = await db.select().from(roleGrants).where(inArray(roleGrants.userId, rows.map((r) => r.id)));
  const byUser = new Map<string, string[]>();
  for (const g of grants) byUser.set(g.userId, [...(byUser.get(g.userId) ?? []), g.role]);
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    displayName: r.displayName,
    isActive: r.isActive,
    signInMethod: r.signInMethod,
    roles: (byUser.get(r.id) ?? []).sort(),
  }));
}

export async function listUsers(db: Db): Promise<UserView[]> {
  return withRoles(db, await db.select().from(users).orderBy(asc(sql`lower(${users.displayName})`), asc(users.email)));
}

export async function getUser(db: DbOrTx, id: string): Promise<UserView | null> {
  if (!isUuid(id)) return null;
  const rows = await db.select().from(users).where(eq(users.id, id));
  return (await withRoles(db, rows))[0] ?? null;
}

export async function findUserByEmail(db: Db, address: string): Promise<UserView | null> {
  const rows = await db.select().from(users).where(sql`lower(${users.email}) = ${address.trim().toLowerCase()}`);
  return (await withRoles(db, rows))[0] ?? null;
}

export async function createUser(db: Db, input: CreateUserInput): Promise<UserView> {
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  try {
    const id = await db.transaction(async (tx) => {
      const [row] = await tx.insert(users).values({ email: input.email, displayName: input.displayName, passwordHash }).returning({ id: users.id });
      const unique = [...new Set(input.roles)];
      if (unique.length) await tx.insert(roleGrants).values(unique.map((role) => ({ userId: row!.id, role })));
      return row!.id;
    });
    return (await getUser(db, id))!;
  } catch (e) {
    if (isUniqueViolation(e)) throw new UserExistsError(input.email);
    throw e;
  }
}

export async function updateUser(db: Db, id: string, patch: UpdateUserInput): Promise<UserView> {
  if (!isUuid(id)) throw new UserNotFoundError(id);
  const updated = await db
    .update(users)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(users.id, id))
    .returning({ id: users.id });
  if (updated.length === 0) throw new UserNotFoundError(id);
  return (await getUser(db, id))!;
}

export async function setRoles(db: Db, id: string, next: string[]): Promise<UserView> {
  if (!isUuid(id)) throw new UserNotFoundError(id);
  await db.transaction(async (tx) => {
    const found = await tx.execute(sql`SELECT id FROM ${users} WHERE id = ${id} FOR UPDATE`);
    if (found.rows.length === 0) throw new UserNotFoundError(id);
    await tx.delete(roleGrants).where(eq(roleGrants.userId, id));
    const unique = [...new Set(next)];
    if (unique.length) await tx.insert(roleGrants).values(unique.map((role) => ({ userId: id, role })));
    await tx.update(users).set({ updatedAt: new Date() }).where(eq(users.id, id));
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
  return u && u.isActive ? { id: u.id, name: u.displayName, email: u.email, roles: u.roles } : null;
}
