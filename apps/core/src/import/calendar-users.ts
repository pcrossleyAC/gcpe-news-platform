import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Tx } from "@gcpe/db-kit";
import type { SubscriberConfig } from "@gcpe/events";
import { roleGrants, userLegacyIds, userOrganizations, users } from "../db/schema";
import { lockAggregate, userAggregateId } from "../services/aggregate";
import { emitUserUpserted } from "../services/users";
import type { CalendarUserCandidate } from "./legacy-keys";

const emailSchema = z.string().trim().toLowerCase().email().max(254);
/** Trimmed and lowercased; null when blank or not an email (imported as no email: inactive, R12). */
export function normaliseEmail(raw: string | null): string | null {
  if (raw === null || raw.trim() === "") return null;
  const p = emailSchema.safeParse(raw);
  return p.success ? p.data : null;
}

export interface CalendarUserGroup {
  legacyIds: number[];
  email: string | null;
  /** Where the role, ministries and name come from: the active row last updated, else the last updated. */
  representative: CalendarUserCandidate;
  /** Legacy active (any row) and an email. */
  isActive: boolean;
  existingUserId: string | null;
  how: "legacy-id" | "email" | "new";
}
export interface CalendarUserPlan { groups: CalendarUserGroup[]; invalidEmails: number[] }
export interface CalendarUsersResult {
  userIdOf: Map<number, string>;
  created: number;
  linked: number;
  unchanged: number;
  activated: string[];
  accessGranted: string[];
  accessKept: string[];
  groups: { userId: string; legacyIds: number[]; representativeLegacyId: number }[];
}

function representativeOf(members: CalendarUserCandidate[]): CalendarUserCandidate {
  const active = members.filter((m) => m.isActive);
  return [...(active.length ? active : members)].sort((a, b) => b.lastUpdated - a.lastUpdated || b.legacyId - a.legacyId)[0]!;
}

/** Read-only: how each legacy user (or group sharing an email) will land in Core. */
export async function planCalendarUsers(db: Db, candidates: CalendarUserCandidate[]): Promise<CalendarUserPlan> {
  const invalidEmails = candidates.filter((c) => c.email !== null && c.email.trim() !== "" && normaliseEmail(c.email) === null).map((c) => c.legacyId).sort((a, b) => a - b);
  const byKey = new Map<string, CalendarUserCandidate[]>();
  for (const c of candidates) {
    const key = normaliseEmail(c.email) ?? `legacy:${c.legacyId}`;
    byKey.set(key, [...(byKey.get(key) ?? []), c]);
  }
  const known = new Map((await db.select().from(userLegacyIds).where(eq(userLegacyIds.system, "calendar"))).map((r) => [r.legacyId, r.userId]));
  const groups: CalendarUserGroup[] = [];
  for (const [key, members] of byKey) {
    const email = key.startsWith("legacy:") ? null : key;
    const legacyIds = members.map((m) => m.legacyId).sort((a, b) => a - b);
    const viaLegacy = legacyIds.map((id) => known.get(String(id))).find((u): u is string => u !== undefined) ?? null;
    let existingUserId = viaLegacy;
    let how: CalendarUserGroup["how"] = viaLegacy ? "legacy-id" : "new";
    if (!existingUserId && email) {
      const [u] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`);
      if (u) { existingUserId = u.id; how = "email"; }
    }
    groups.push({ legacyIds, email, representative: representativeOf(members), isActive: email !== null && members.some((m) => m.isActive), existingUserId, how });
  }
  return { groups: groups.sort((a, b) => a.legacyIds[0]! - b.legacyIds[0]!), invalidEmails };
}

async function grantAccess(tx: Tx, userId: string, rep: CalendarUserCandidate): Promise<boolean> {
  let granted = false;
  if (rep.calendarRole) { await tx.insert(roleGrants).values({ userId, role: rep.calendarRole }); granted = true; }
  if (rep.organizationIds.length) {
    const rows = await tx.insert(userOrganizations).values(rep.organizationIds.map((organizationId) => ({ userId, organizationId }))).onConflictDoNothing().returning({ userId: userOrganizations.userId });
    granted ||= rows.length > 0;
  }
  return granted;
}

/**
 * Writes the plan. A user matched by legacy id is left exactly as it is. One matched by email keeps
 * its roles, ministries and active flag, except that Calendar access is added when it has none and
 * a role-less inactive placeholder is activated when legacy says active. One user.upserted per
 * changed user, in its own transaction.
 */
export async function applyCalendarUsers(db: Db, plan: CalendarUserPlan, subscribers: SubscriberConfig[]): Promise<CalendarUsersResult> {
  const r: CalendarUsersResult = { userIdOf: new Map(), created: 0, linked: 0, unchanged: 0, activated: [], accessGranted: [], accessKept: [], groups: [] };
  for (const g of plan.groups) {
    const userId = await db.transaction(async (tx) => {
      let id = g.existingUserId;
      let changed = false;
      if (id === null) {
        const [row] = await tx.insert(users).values({ email: g.email, displayName: g.representative.displayName, isActive: g.isActive }).returning({ id: users.id });
        id = row!.id;
        await lockAggregate(tx, userAggregateId(id));
        if (await grantAccess(tx, id, g.representative)) r.accessGranted.push(id);
        changed = true;
        r.created++;
      } else {
        await lockAggregate(tx, userAggregateId(id));
        const [u] = await tx.select({ isActive: users.isActive }).from(users).where(eq(users.id, id)).for("update");
        if (!u) throw new Error("a Core user matched by the import no longer exists");
        if (g.how === "email") {
          const grants = await tx.select({ role: roleGrants.role }).from(roleGrants).where(eq(roleGrants.userId, id));
          const orgs = await tx.select({ id: userOrganizations.organizationId }).from(userOrganizations).where(eq(userOrganizations.userId, id));
          if (!u.isActive && grants.length === 0 && g.isActive) {
            await tx.update(users).set({ isActive: true, updatedAt: new Date() }).where(eq(users.id, id));
            r.activated.push(id);
            changed = true;
          }
          if (!grants.some((x) => x.role.startsWith("Calendar.")) && orgs.length === 0) {
            if (await grantAccess(tx, id, g.representative)) { r.accessGranted.push(id); changed = true; }
          } else {
            r.accessKept.push(id);
          }
          r.linked++;
        } else {
          r.unchanged++;
        }
      }
      await tx.insert(userLegacyIds).values(g.legacyIds.map((l) => ({ system: "calendar" as const, legacyId: String(l), userId: id! }))).onConflictDoNothing();
      if (changed) await emitUserUpserted(tx, id, subscribers);
      return id;
    });
    for (const l of g.legacyIds) r.userIdOf.set(l, userId);
    r.groups.push({ userId, legacyIds: g.legacyIds, representativeLegacyId: g.representative.legacyId });
  }
  return r;
}
