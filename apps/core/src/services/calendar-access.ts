import { and, eq, inArray, like, or } from "drizzle-orm";
import { z } from "zod";
import type { Db, Tx } from "@gcpe/db-kit";
import { CALENDAR_ROLES, checkCalendarGrant, type CalendarGrantRefusal } from "@gcpe/auth";
import type { SubscriberConfig } from "@gcpe/events";
import { organizations, roleGrants, userOrganizations, users } from "../db/schema";
import { lockAggregate, userAggregateId } from "./aggregate";
import { emitUserUpserted, getUser, linkUser, listUsers, updateUser, UserNotFoundError, type UserGuard, type UserView } from "./users";

/**
 * The whole of a user's Calendar access: one role (or none) and the full set of ministries,
 * replaced together. Strict, so a body can't carry anything that looks like it speaks for the
 * actor: who is acting always comes from the verified session.
 */
export const calendarAccessSchema = z
  .object({
    role: z.enum(CALENDAR_ROLES).nullable(),
    organizationKeys: z.array(z.string().trim().min(1).max(100)).max(100),
  })
  .strict()
  // Legacy's user page refused to save without a ministry (Calendar/Admin/User.aspx.cs:639-642).
  .refine((v) => v.role === null || v.organizationKeys.length > 0, { message: "choose at least one ministry for a Calendar role", path: ["organizationKeys"] });
export type CalendarAccessInput = z.infer<typeof calendarAccessSchema>;

export type CalendarAccessView = Pick<UserView, "id" | "email" | "displayName" | "isActive" | "calendarRole" | "organizationKeys">;

export const REFUSAL_MESSAGES: Record<CalendarGrantRefusal, string> = {
  "not-an-administrator": "only a Calendar Administrator can change Calendar access",
  "own-access": "you can't change your own Calendar access",
  "target-above-ceiling": "only a System Administrator or a Core admin can change a System Administrator's access",
  "above-ceiling": "only a System Administrator or a Core admin can grant System Administrator",
  "hq-organization": "only an HQ Administrator, a System Administrator or a Core admin can add an HQ ministry",
  "hq-target": "only an HQ Administrator, a System Administrator or a Core admin can change the Calendar access of someone with an HQ ministry",
};

export const CALENDAR_ONLY_MESSAGE = "only a Core admin can change a user who also has NRMS or NoD roles";

/** Q55: a Calendar Administrator may change the account of a user whose only access is the Calendar. */
export class CalendarOnlyError extends Error {
  override name = "CalendarOnlyError";
}

export class CalendarGrantRefusedError extends Error {
  constructor(readonly reason: CalendarGrantRefusal) {
    super(reason);
  }
}

/** Only the submitted keys that failed: never anything about the target's other ministries. */
export class UnknownOrganizationError extends Error {
  constructor(readonly keys: string[]) {
    super("unknown or inactive ministry");
  }
}

export interface CalendarActor {
  /** The caller's verified subject: a user id for staff sessions, or a non-UUID for break-glass and service tokens. */
  id: string;
  /** The caller's verified roles (re-derived from the database for session callers). */
  roles: string[];
}

const isUuid = (id: string) => z.string().uuid().safeParse(id).success;

function toView(u: UserView): CalendarAccessView {
  return { id: u.id, email: u.email, displayName: u.displayName, isActive: u.isActive, calendarRole: u.calendarRole, organizationKeys: u.organizationKeys };
}

/**
 * Whether the actor's own user record holds an HQ ministry, read inside the writing transaction
 * rather than trusted from the session. A subject with no user record (break-glass, a service
 * token) holds no ministries, so it is never HQ: the safe direction, and break-glass is Core.Admin,
 * which doesn't need HQ.
 */
async function actorIsHq(tx: Tx, actorId: string): Promise<boolean> {
  if (!isUuid(actorId)) return false;
  const rows = await tx
    .select({ id: organizations.id })
    .from(userOrganizations)
    .innerJoin(organizations, eq(organizations.id, userOrganizations.organizationId))
    .where(and(eq(userOrganizations.userId, actorId), eq(organizations.isHq, true)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Whether the user holds an HQ ministry. Their memberships change only under their aggregate lock,
 * which the caller holds; every held organization is read FOR SHARE, so a concurrent HQ change
 * of any of them waits for us, or we see what it committed.
 */
async function targetHoldsHq(tx: Tx, userId: string): Promise<boolean> {
  const heldIds = (await tx.select({ id: userOrganizations.organizationId }).from(userOrganizations).where(eq(userOrganizations.userId, userId))).map((r) => r.id);
  if (heldIds.length === 0) return false;
  const orgs = await tx.select({ isHq: organizations.isHq }).from(organizations).where(inArray(organizations.id, heldIds)).for("share");
  return orgs.some((o) => o.isHq);
}

/**
 * Who may deactivate, reactivate or link a user from the Calendar (spec addendum §8.5, Q55): a
 * Core.Admin always; anyone else only on a user with no flat role, and only where they could change
 * that user's Calendar access with the role left as it is (C125, C159, C160).
 */
function calendarAdminGuard(actor: CalendarActor): UserGuard {
  return async (tx, id) => {
    if (actor.roles.includes("Core.Admin")) return;
    const current = (await getUser(tx, id))!;
    if (current.roles.length > 0) throw new CalendarOnlyError();
    const refusal = checkCalendarGrant({
      actorId: actor.id,
      actorRoles: actor.roles,
      actorIsHq: await actorIsHq(tx, actor.id),
      targetId: id,
      targetRole: current.calendarRole,
      nextRole: current.calendarRole,
      addsHqOrganization: false,
      targetHasHqAfter: await targetHoldsHq(tx, id),
    });
    if (refusal) throw new CalendarGrantRefusedError(refusal);
  };
}

/** Deactivates or reactivates a user from the Calendar's user screen, under calendarAdminGuard. */
export async function setCalendarUserActive(db: Db, actor: CalendarActor, id: string, isActive: boolean, subscribers: SubscriberConfig[]): Promise<CalendarAccessView> {
  return toView(await updateUser(db, id, { isActive }, subscribers, { guard: calendarAdminGuard(actor) }));
}

/** Sets the email of a user who has none, and activates them, under calendarAdminGuard. */
export async function linkCalendarUser(db: Db, actor: CalendarActor, id: string, email: string, subscribers: SubscriberConfig[]): Promise<CalendarAccessView> {
  return toView(await linkUser(db, id, email, subscribers, { guard: calendarAdminGuard(actor) }));
}

export async function listCalendarAccess(db: Db): Promise<CalendarAccessView[]> {
  return (await listUsers(db)).map(toView);
}

/**
 * Replaces a user's Calendar role and ministries, after checkCalendarGrant (C125). The user's
 * aggregate lock, then their row, then every organization involved are locked before anything
 * is checked, so the checks, the write and the user.upserted event all see one state. An inactive
 * ministry the user already holds may be kept; a new one must exist and be active.
 */
export async function setCalendarAccess(db: Db, actor: CalendarActor, requestedId: string, input: CalendarAccessInput, subscribers: SubscriberConfig[]): Promise<CalendarAccessView> {
  if (!isUuid(requestedId)) throw new UserNotFoundError(requestedId);
  const keys = [...new Set(input.organizationKeys)];
  const targetId = await db.transaction(async (tx) => {
    // Postgres stores and returns UUIDs lowercased; locking that form means two differently-cased
    // copies of one id share one lock.
    await lockAggregate(tx, userAggregateId(requestedId.toLowerCase()));
    const [row] = await tx.select({ id: users.id }).from(users).where(eq(users.id, requestedId)).for("update");
    if (!row) throw new UserNotFoundError(requestedId);
    // From here on, the id is the stored one, never the request's spelling of it.
    const id = row.id;
    const current = (await getUser(tx, id))!;

    const heldIds = (await tx.select({ id: userOrganizations.organizationId }).from(userOrganizations).where(eq(userOrganizations.userId, id))).map((r) => r.id);
    const which = [...(heldIds.length ? [inArray(organizations.id, heldIds)] : []), ...(keys.length ? [inArray(organizations.key, keys)] : [])];
    // FOR SHARE: a concurrent deactivation or HQ change of any of these waits for us, or we see
    // what it committed.
    const orgs = which.length
      ? await tx
          .select({ id: organizations.id, key: organizations.key, isActive: organizations.isActive, isHq: organizations.isHq })
          .from(organizations)
          .where(or(...which))
          .for("share")
      : [];
    const held = new Set(heldIds);
    const byKey = new Map(orgs.map((o) => [o.key, o]));
    const bad = keys.filter((k) => {
      const o = byKey.get(k);
      return !o || (!o.isActive && !held.has(o.id));
    });
    if (bad.length) throw new UnknownOrganizationError(bad.sort());
    const next = keys.map((k) => byKey.get(k)!);

    const refusal = checkCalendarGrant({
      actorId: actor.id,
      actorRoles: actor.roles,
      actorIsHq: await actorIsHq(tx, actor.id),
      targetId: id,
      targetRole: current.calendarRole,
      nextRole: input.role,
      addsHqOrganization: next.some((o) => o.isHq && !held.has(o.id)),
      targetHasHqAfter: orgs.some((o) => o.isHq && held.has(o.id)) || next.some((o) => o.isHq),
    });
    if (refusal) throw new CalendarGrantRefusedError(refusal);

    await tx.delete(roleGrants).where(and(eq(roleGrants.userId, id), like(roleGrants.role, "Calendar.%")));
    if (input.role) await tx.insert(roleGrants).values({ userId: id, role: input.role });
    await tx.delete(userOrganizations).where(eq(userOrganizations.userId, id));
    if (next.length) await tx.insert(userOrganizations).values(next.map((o) => ({ userId: id, organizationId: o.id })));
    await tx.update(users).set({ updatedAt: new Date() }).where(eq(users.id, id));
    await emitUserUpserted(tx, id, subscribers);
    return id;
  });
  return toView((await getUser(db, targetId))!);
}
