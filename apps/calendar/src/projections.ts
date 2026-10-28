import { and, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import type { EventEnvelope, EventHandler, OrgRecord, OrgSucceeded, ReleaseStatusChanged, TermRecord, UserRecord } from "@gcpe/events";
import { applySuccession, type SuccessionDeps } from "./succession";
import { activities, orgs, releaseLinks, terms, TERM_KINDS, users, type TermKind } from "./db/schema";

// Ordering and redelivery are the receiver's job: it applies an event only when its sequence is
// past the aggregate's (a user, an organization, a term, a release) last one, so each handler can
// simply replace the row with what it carries. Core keys are stored byte for byte, never
// case-folded (spec §5.2): legacy ministry keys are uppercase GUIDs and Core matches keys exactly.

const isTermKind = (kind: string): kind is TermKind => (TERM_KINDS as readonly string[]).includes(kind);

const onOrg: EventHandler = async (tx, e) => {
  const o = e.data as OrgRecord;
  const row = { key: o.key, displayName: o.displayName, abbreviation: o.abbreviation, sortOrder: o.sortOrder, isActive: o.isActive, isHq: o.isHq };
  await tx.insert(orgs).values(row).onConflictDoUpdate({ target: orgs.key, set: row });
};
const onOrgGone: EventHandler = async (tx, e) => {
  await tx.update(orgs).set({ isActive: false }).where(eq(orgs.key, (e.data as { key: string }).key));
};
const onTerm: EventHandler = async (tx, e) => {
  const t = e.data as TermRecord;
  if (!isTermKind(t.kind)) return; // services have no Calendar use
  const row = { kind: t.kind, key: t.key, displayName: t.displayName ?? t.key, sortOrder: t.sortOrder, isActive: t.isActive };
  await tx.insert(terms).values(row).onConflictDoUpdate({ target: [terms.kind, terms.key], set: row });
};
const onTermGone: EventHandler = async (tx, e) => {
  const d = e.data as { kind: string; key: string };
  if (!isTermKind(d.kind)) return;
  await tx.update(terms).set({ isActive: false }).where(and(eq(terms.kind, d.kind), eq(terms.key, d.key)));
};
/** Core's user.upserted (spec addendum §4). The whole record replaces the row: role, ministries and active. */
const onUser: EventHandler = async (tx, e) => {
  const u = e.data as UserRecord;
  const row = {
    id: u.id.toLowerCase(),
    email: u.email,
    displayName: u.displayName,
    isActive: u.isActive,
    calendarRole: u.calendarRole,
    organizationKeys: [...new Set(u.organizationKeys)].sort(),
  };
  await tx.insert(users).values(row).onConflictDoUpdate({ target: users.id, set: row });
};
/** NRMS's release.status_changed (spec addendum §11). A deleted release, an unlinked one, or one
 * moved to an activity the Calendar doesn't hold, leaves no link; otherwise the row is replaced
 * with the status it carries. */
const onReleaseStatusChanged: EventHandler = async (tx, e) => {
  const r = e.data as ReleaseStatusChanged;
  const drop = () => tx.delete(releaseLinks).where(eq(releaseLinks.releaseId, r.releaseId));
  if (r.status === "deleted" || r.activityId === null) return void (await drop());
  const [held] = await tx.select({ id: activities.id }).from(activities).where(eq(activities.id, r.activityId));
  if (!held) return void (await drop());
  const row = {
    releaseId: r.releaseId, activityId: r.activityId, key: r.key, type: r.type, status: r.status,
    publishAt: at(r.publishAt), releasedAt: at(r.releasedAt), reference: r.reference, headline: r.headline,
    lastSequence: e.sequence,
  };
  await tx.insert(releaseLinks).values(row).onConflictDoUpdate({ target: releaseLinks.releaseId, set: row });
};

/** Core's org.succeeded (new-government spec §4); needs the Calendar's rules and subscribers to emit what it moves. */
const onOrgSucceeded = (deps: SuccessionDeps): EventHandler => async (tx, e) => {
  await applySuccession(tx, e.data as OrgSucceeded, deps);
};

const at = (iso: string | null) => (iso === null ? null : new Date(iso));
export function projectionHandler(event: EventEnvelope, deps?: SuccessionDeps): EventHandler | undefined {
  if (event.type === "release.status_changed") return event.source === "nrms" ? onReleaseStatusChanged : undefined;
  if (event.source !== "core") return undefined;
  switch (event.type) {
    case "org.upserted":
      return onOrg;
    case "org.deactivated":
      return onOrgGone;
    case "sector.upserted":
    case "theme.upserted":
    case "tag.upserted":
      return onTerm;
    case "sector.deactivated":
    case "theme.deactivated":
    case "tag.deactivated":
      return onTermGone;
    case "user.upserted":
      return onUser;
    case "org.succeeded":
      return deps ? onOrgSucceeded(deps) : undefined;
    default:
      return undefined;
  }
}

/** True until Core's organizations have reached the Calendar; the stack then asks Core to republish. */
export async function needsReferenceData(db: DbOrTx): Promise<boolean> {
  const r = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${orgs}`);
  return r.rows[0]!.n === 0;
}
