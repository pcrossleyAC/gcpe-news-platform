import { and, asc, eq, isNull } from "drizzle-orm";
import type { CalendarRules } from "@gcpe/calendar-contract";
import type { Db } from "@gcpe/db-kit";
import { safeErrorLabel } from "@gcpe/http-kit";
import type { CalendarActor } from "./actor";
import { BATCH_SIZE } from "./activities/bulk";
import { ActivityForbiddenError } from "./activities/errors";
import { emitActivity } from "./activities/events";
import { commContactLabel, writeChange, type FieldChange } from "./activities/history";
import { factsOf, loadStored, lockActivity } from "./activities/store";
import { can } from "./capabilities";
import { activities, commContacts, orgs, users } from "./db/schema";
import type { ApiDeps } from "./http/routes";
import { dbNow } from "./time";
import { visible, visibleSql } from "./visibility";

export interface TransferContact {
  id: number;
  userId: string;
  displayName: string;
  ministryKey: string;
  ministryAbbreviation: string | null;
  ministryName: string;
  isActive: boolean;
  /**
   * Whether it may be the contact transferred to: it is active and its ministry may lead an
   * activity, as a save checks (activities/resolve.ts). Any listed contact may be transferred from.
   */
  canReceive: boolean;
  /** "Name (ABBR)", as legacy's dropdowns (Admin/Transfer.aspx.cs:20-27) and the history. */
  label: string;
}

/** HTTP 422. */
export class TransferError extends Error {
  override name = "TransferError";
}
/** HTTP 404: no such contact, or one of a ministry the caller may not transfer for. */
export class TransferContactNotFoundError extends Error {
  override name = "TransferContactNotFoundError";
}

/** Why a contact can't be transferred to, in a save's words (activities/resolve.ts), or null if it can. */
function receiveRefusal(c: { isActive: boolean; ministryIsActive: boolean | null; abbreviation: string | null }, rules: CalendarRules): string | null {
  if (!c.isActive) return "Choose an active comm contact to transfer to";
  if (c.ministryIsActive === null) return "That ministry doesn't exist";
  if (!c.ministryIsActive) return "That ministry is no longer active";
  if (c.abbreviation && rules.contactMinistryExcludedAbbreviations.includes(c.abbreviation)) return "That ministry can't lead an activity";
  return null;
}

async function allContacts(db: Db, rules: CalendarRules): Promise<(TransferContact & { refusal: string | null })[]> {
  const rows = await db
    .select({
      id: commContacts.id, userId: commContacts.userId, ministryKey: commContacts.ministryKey, isActive: commContacts.isActive, displayName: users.displayName,
      abbreviation: orgs.abbreviation, ministryName: orgs.displayName, ministryIsActive: orgs.isActive,
    })
    .from(commContacts)
    .leftJoin(users, eq(users.id, commContacts.userId))
    .leftJoin(orgs, eq(orgs.key, commContacts.ministryKey))
    .orderBy(asc(orgs.abbreviation), asc(users.displayName), asc(commContacts.id));
  return rows.map((r) => {
    const refusal = receiveRefusal(r, rules);
    return {
      id: r.id, userId: r.userId, displayName: r.displayName ?? "Unknown", ministryKey: r.ministryKey, ministryAbbreviation: r.abbreviation, ministryName: r.ministryName ?? r.ministryKey,
      isActive: r.isActive, canReceive: refusal === null, label: commContactLabel(r.displayName, r.abbreviation), refusal,
    };
  });
}

async function usableContacts(db: Db, actor: CalendarActor, rules: CalendarRules) {
  if (!can.transfer(actor)) throw new ActivityForbiddenError("Administrators transfer activities");
  const all = await allContacts(db, rules);
  return actor.isHq ? all : all.filter((c) => actor.ministryKeys.includes(c.ministryKey));
}

const publicOf = ({ refusal: _, ...c }: TransferContact & { refusal: string | null }): TransferContact => c;

/** An HQ Administrator may use any contact; anyone else only their own ministries' (C150). */
export async function transferContacts(db: Db, actor: CalendarActor, rules: CalendarRules): Promise<TransferContact[]> {
  return (await usableContacts(db, actor, rules)).map(publicOf);
}

async function pair(deps: ApiDeps, actor: CalendarActor, fromId: number, toId: number): Promise<{ from: TransferContact; to: TransferContact }> {
  const usable = await usableContacts(deps.db, actor, deps.rules);
  const from = usable.find((c) => c.id === fromId);
  const to = usable.find((c) => c.id === toId);
  if (!from || !to) throw new TransferContactNotFoundError();
  if (from.id === to.id) throw new TransferError("Choose two different comm contacts");
  if (to.refusal) throw new TransferError(to.refusal);
  return { from: publicOf(from), to: publicOf(to) };
}

/**
 * A's non-deleted activities the caller can see. A ministry Administrator moves only those A's
 * ministry leads: one only shared with their ministry stays with the ministry that leads it.
 */
const inScope = (actor: CalendarActor, from: TransferContact) =>
  and(eq(activities.commContactId, from.id), isNull(activities.deletedAt), visibleSql(actor), actor.isHq ? undefined : eq(activities.contactMinistryKey, from.ministryKey));

const candidates = (db: Db, actor: CalendarActor, from: TransferContact) =>
  db.select({ id: activities.id }).from(activities).where(inScope(actor, from)).orderBy(asc(activities.id));

export async function previewTransfer(deps: ApiDeps, actor: CalendarActor, fromId: number, toId: number) {
  const { from, to } = await pair(deps, actor, fromId, toId);
  return { from, to, count: (await candidates(deps.db, actor, from)).length };
}

export interface TransferResult {
  transferred: number;
  /** As with `ReviewSelectedResult.failed` (activities/bulk.ts): a later batch failed after earlier ones committed. */
  failed?: true;
}

/**
 * Moves every non-deleted activity of A that the caller can see to B, and sets its lead ministry
 * to B's, by id (legacy parsed the abbreviation out of the dropdown's text). No needs-review flag,
 * status or "last updated" changes, as legacy (C150); each activity's version moves, so an open
 * editor reloads. Not frozen (spec addendum §7.4).
 */
export async function runTransfer(deps: ApiDeps, actor: CalendarActor, fromId: number, toId: number): Promise<TransferResult> {
  const { from, to } = await pair(deps, actor, fromId, toId);
  const ids = (await candidates(deps.db, actor, from)).map((r) => r.id);
  let transferred = 0;
  // Ascending ids (candidates' order): two transfers over the same rows lock them in the same order.
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    // Counted locally: a batch that throws rolls its whole transaction back.
    let batchTransferred = 0;
    try {
      await deps.db.transaction(async (tx) => {
        const now = await dbNow(tx, deps.now);
        for (const id of ids.slice(i, i + BATCH_SIZE)) {
          await lockActivity(tx, id);
          const s = await loadStored(tx, id, { forUpdate: true });
          // Re-check under the lock: a concurrent transfer, save or delete may have got there first.
          if (!s || s.row.deletedAt || s.row.commContactId !== from.id || !visible(actor, factsOf(s))) continue;
          if (!actor.isHq && s.row.contactMinistryKey !== from.ministryKey) continue;
          await tx.update(activities).set({ commContactId: to.id, contactMinistryKey: to.ministryKey, version: s.row.version + 1 }).where(eq(activities.id, id));
          const fields: FieldChange[] = [{ key: "comm_contact", old: from.label, new: to.label }];
          if (s.row.contactMinistryKey !== to.ministryKey) {
            const [old] = s.row.contactMinistryKey ? await tx.select({ name: orgs.displayName }).from(orgs).where(eq(orgs.key, s.row.contactMinistryKey)) : [];
            fields.push({ key: "contact_ministry", old: old?.name ?? s.row.contactMinistryKey, new: to.ministryName });
          }
          await writeChange(tx, { activityId: id, actor, action: "transferred", contactMinistryKey: to.ministryKey, at: now, fields });
          await emitActivity(tx, deps, id, "activity.updated");
          batchTransferred++;
        }
      });
    } catch (e) {
      // Nothing has committed yet: the request failed as a whole, and the usual error mapping applies.
      if (i === 0) throw e;
      console.error("[calendar] transfer: a batch failed after earlier ones committed", safeErrorLabel(e));
      return { transferred, failed: true };
    }
    transferred += batchTransferred;
  }
  return { transferred };
}
