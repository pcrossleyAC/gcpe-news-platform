import { and, count, desc, eq, gte, like, lt, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbOrTx } from "@gcpe/db-kit";
import { wallClockToInstant } from "@gcpe/config";
import { coreAudit } from "../db/schema";

/**
 * Suite review O3 (owner decision 2026-10-31): Core's admin audit trail. Every Core admin change
 * to a user, a person's Calendar access, an organization, a sector/theme/tag/service list entry or
 * the cabinet change is recorded here by the service that makes it, inside the same transaction,
 * so an entry exists exactly when the change committed. Kept forever; read by Core.Admin only.
 */

/** Who made a change: the verified caller (actorOf(req)), or a system actor. */
export interface AuditActor {
  id: string;
  name: string;
}

/** A scheduled cabinet change publishing on its own, with nobody signed in. */
export const SCHEDULED_CABINET_ACTOR: AuditActor = { id: "system:cabinet-change", name: "Scheduled cabinet change" };

export type AuditTargetType = (typeof coreAudit.$inferSelect)["targetType"];

/**
 * The actions, by area. The Hub turns each into a sentence (screens/admin/history/describe.ts), so
 * a new action needs a sentence there too.
 *
 * user.created { email, roles, isActive } · user.renamed { from, to } · user.activated ·
 * user.deactivated · user.roles { added, removed } · user.password-set · user.linked { email } ·
 * user.microsoft-unlinked ·
 * calendar.access { role: { from, to }?, added, removed } (ministry keys) ·
 * org.created { abbreviation } · org.edited { name?, abbreviation?, active?, fields } ·
 * org.hq { isHq } · org.public { isPublic } · org.deactivated ·
 * org.handed-over { successors, moveStaff, moveSubscribers, moveCalendar, moveDrafts, takeAbbreviation, staffMoved } ·
 * term.created { kind } · term.edited { kind, name?, fields } · term.deactivated { kind } ·
 * cabinet.saved { operations } · cabinet.scheduled { at } · cabinet.cancelled · cabinet.published { operations } ·
 * core.republished { enqueued } · user.microsoft-linked (the person's own first Microsoft sign-in, under their own name)
 *
 * Any of them may carry `via: "cabinet-change"` when a published cabinet change made it.
 */
export interface AuditEntryInput {
  action: string;
  targetType: AuditTargetType;
  targetId: string;
  targetLabel: string;
  details?: Record<string, unknown>;
}

/** Details are a summary, never a record: anything bigger than this is dropped, keeping only that it was too big. */
const MAX_DETAILS_CHARS = 4000;

/**
 * Writes one entry in `tx` (the change's own transaction). No actor, no entry: the seed, the
 * legacy importer and the tests' fixtures call the same services without one.
 */
export async function recordAudit(tx: DbOrTx, actor: AuditActor | undefined, entry: AuditEntryInput): Promise<void> {
  if (!actor) return;
  const details = entry.details ?? {};
  const small = JSON.stringify(details).length <= MAX_DETAILS_CHARS ? details : { tooLarge: true };
  await tx.insert(coreAudit).values({
    actorId: actor.id,
    actorName: actor.name,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    targetLabel: entry.targetLabel,
    details: small,
  });
}

/** The "What" filter of Admin history: each is a prefix of the actions it covers. */
export const AUDIT_KINDS = { users: "user.", calendar: "calendar.", organizations: "org.", terms: "term.", cabinet: "cabinet." } as const;
export type AuditKind = keyof typeof AUDIT_KINDS;

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a date like 2026-10-31.")
  .refine((d) => new Date(`${d}T00:00:00Z`).toISOString().startsWith(d), "Enter a real date.");

export const auditQuerySchema = z
  .object({
    targetType: z.enum(["user", "organization", "term", "cabinet-change", "core"]).optional(),
    targetId: z.string().trim().min(1).max(300).optional(),
    /** Part of the name of the person who made the change, any case. */
    who: z.string().trim().max(100).optional(),
    kind: z.enum(Object.keys(AUDIT_KINDS) as [AuditKind, ...AuditKind[]]).optional(),
    /** BC dates, both included. */
    from: day.optional(),
    to: day.optional(),
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict()
  .refine((q) => (q.targetId === undefined) === (q.targetType === undefined), { message: "targetType and targetId go together", path: ["targetId"] });
export type AuditQuery = z.infer<typeof auditQuerySchema>;

export interface AuditEntry {
  id: number;
  at: string;
  actorId: string;
  actorName: string;
  action: string;
  targetType: AuditTargetType;
  targetId: string;
  targetLabel: string;
  details: Record<string, unknown>;
}

export interface AuditPage {
  items: AuditEntry[];
  total: number;
  page: number;
  pageSize: number;
}

/** The instant a tenant day ("YYYY-MM-DD") starts, `plusDays` later. */
function dayStart(d: string, timeZone: string, plusDays = 0): Date {
  const wall = new Date(`${d}T00:00:00Z`);
  wall.setUTCDate(wall.getUTCDate() + plusDays);
  return wallClockToInstant(wall, timeZone);
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** One page of entries, newest first, matching every filter given. Dates are the tenant's days. */
export async function listAudit(db: Db, query: AuditQuery, timeZone: string): Promise<AuditPage> {
  const where: SQL[] = [];
  if (query.targetType && query.targetId) where.push(eq(coreAudit.targetType, query.targetType), eq(coreAudit.targetId, query.targetId));
  if (query.who) where.push(sql`${coreAudit.actorName} ilike ${`%${escapeLike(query.who)}%`}`);
  if (query.kind) where.push(like(coreAudit.action, `${AUDIT_KINDS[query.kind]}%`));
  if (query.from) where.push(gte(coreAudit.at, dayStart(query.from, timeZone)));
  if (query.to) where.push(lt(coreAudit.at, dayStart(query.to, timeZone, 1)));
  const filter = where.length ? and(...where) : undefined;
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(coreAudit).where(filter);
  const rows = await db
    .select()
    .from(coreAudit)
    .where(filter)
    .orderBy(desc(coreAudit.at), desc(coreAudit.id))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  return {
    items: rows.map((r) => ({ ...r, at: r.at.toISOString() })),
    total: n,
    page: query.page,
    pageSize: query.pageSize,
  };
}
