import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "@gcpe/db-kit";
import { HISTORY_FIELDS, type CalendarRules, type ChangeAction, type HistoryFieldKey } from "@gcpe/calendar-contract";
import { activityChangeFields, activityChanges, commContacts, orgs, terms, users, type TermKind } from "../db/schema";
import { wallClock } from "../time";
import type { Content, JoinIds, LookAheadValues } from "./store";

export type Display = Record<HistoryFieldKey, string | null>;
export interface FieldChange {
  key: HistoryFieldKey;
  old: string | null;
  new: string | null;
}

const SECTION_LABELS = { issues_and_reports: "Issues & Reports", events_and_speeches: "Events & Speeches", in_the_news: "In the News", not_on_la: "Not on LA" } as const;
const yesNo = (b: boolean) => (b ? "Yes" : "No");
const text = (s: string) => (s.trim() === "" ? null : s.trim());
const list = (xs: string[]) => (xs.length ? [...xs].sort((a, b) => a.localeCompare(b)).join(", ") : null);

async function names(db: DbOrTx, table: string, ids: number[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const r = await db.execute<{ name: string }>(sql`SELECT name FROM ${sql.identifier(table)} WHERE id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
  return r.rows.map((x) => x.name);
}
async function one(db: DbOrTx, table: string, id: number | null): Promise<string | null> {
  return id === null ? null : ((await names(db, table, [id]))[0] ?? String(id));
}

/** What "View changes" shows for each field (spec addendum §8.3): names, not ids; BC times. */
/** "Name (ABBR)", as legacy's dropdowns; the history and Transfer both label a comm contact this way. */
export function commContactLabel(displayName: string | null, ministryAbbreviation: string | null): string {
  return `${displayName ?? "Unknown"}${ministryAbbreviation ? ` (${ministryAbbreviation})` : ""}`;
}

export async function displayOf(db: DbOrTx, c: Content, la: LookAheadValues, j: JoinIds, keywordNames: string[], rules: CalendarRules): Promise<Display> {
  const when = (d: Date | null, dateOnly: boolean) => {
    if (!d) return null;
    const w = wallClock(d, rules.timeZone);
    return dateOnly ? w.date : `${w.date} ${w.time}`;
  };
  const orgName = async (keys: string[]) => {
    if (keys.length === 0) return [];
    const rows = await db.select({ key: orgs.key, name: orgs.displayName }).from(orgs).where(inArray(orgs.key, keys));
    return keys.map((k) => rows.find((r) => r.key === k)?.name ?? k);
  };
  const termNames = async (kind: TermKind, keys: string[]) => {
    if (keys.length === 0) return [];
    const rows = await db.select({ key: terms.key, name: terms.displayName }).from(terms).where(and(eq(terms.kind, kind), inArray(terms.key, keys)));
    return keys.map((k) => rows.find((r) => r.key === k)?.name ?? `${kind} ${k}`);
  };
  let commContact: string | null = null;
  if (c.commContactId !== null) {
    const [cc] = await db.select({ name: users.displayName, abbr: orgs.abbreviation }).from(commContacts).leftJoin(users, eq(users.id, commContacts.userId)).leftJoin(orgs, eq(orgs.key, commContacts.ministryKey)).where(eq(commContacts.id, c.commContactId));
    commContact = cc ? commContactLabel(cc.name, cc.abbr) : String(c.commContactId);
  }
  return {
    category: list(await names(db, "categories", j.categoryIds)),
    is_confidential: yesNo(c.isConfidential),
    title: text(c.title),
    details: text(c.details),
    is_issue: yesNo(c.isIssue),
    significance: text(c.significance),
    lead_organization: text(c.leadOrganization),
    initiatives: list(await names(db, "initiatives", j.initiativeIds)),
    keywords: list(keywordNames),
    comm_contact: commContact,
    is_milestone: yesNo(c.isMilestone),
    strategy: text(c.strategy),
    comm_materials: list(await names(db, "comm_materials", j.commMaterialIds)),
    comments: text(c.comments),
    contact_ministry: c.contactMinistryKey ? ((await orgName([c.contactMinistryKey]))[0] ?? null) : null,
    is_cross_government: yesNo(c.isCrossGovernment),
    shared_with: list(await orgName(j.sharedWithKeys)),
    hq_comments: text(la.hqComments),
    hq_status: la.hqStatus === null ? null : la.hqStatus === "new" ? "New" : "Changed",
    hq_section: SECTION_LABELS[la.hqSection],
    long_term_outlook: yesNo(la.longTermOutlook),
    start: when(c.startAt, c.isAllDay),
    end: when(c.endAt, c.isAllDay),
    is_all_day: yesNo(c.isAllDay),
    is_confirmed: yesNo(c.isConfirmed),
    potential_dates: text(c.potentialDates),
    schedule: text(c.schedule),
    nr_at: when(c.nrAt, false),
    nr_origins: list(await names(db, "nr_origins", j.nrOriginIds)),
    nr_distribution: await one(db, "nr_distributions", c.nrDistributionId),
    translations: list(c.translations),
    sectors: list(await termNames("sector", j.sectorKeys)),
    themes: list(await termNames("theme", j.themeKeys)),
    tags: list(await termNames("tag", j.tagKeys)),
    premier_requested: await one(db, "premier_requested", c.premierRequestedId),
    representative: await one(db, "government_representatives", c.governmentRepresentativeId),
    is_at_legislature: yesNo(c.isAtLegislature),
    city: await one(db, "cities", c.cityId),
    other_city: text(c.otherCity),
    venue: text(c.venue),
    event_planner: await one(db, "event_planners", c.eventPlannerId),
    videographer: await one(db, "videographers", c.videographerId),
    status: null,
    cloned_from: null,
  };
}

export function diffDisplay(before: Display, after: Display): FieldChange[] {
  return (Object.keys(HISTORY_FIELDS) as HistoryFieldKey[]).filter((k) => before[k] !== after[k]).map((k) => ({ key: k, old: before[k], new: after[k] }));
}

/** Every field with a value, for `created` and `cloned` (spec addendum §7.1). "No" flags aren't "set". */
export function setFields(after: Display): FieldChange[] {
  return (Object.keys(HISTORY_FIELDS) as HistoryFieldKey[]).filter((k) => after[k] !== null && after[k] !== "No").map((k) => ({ key: k, old: null, new: after[k] }));
}

export async function writeChange(
  tx: Tx,
  c: { activityId: number; actor: { userId: string; displayName: string }; action: ChangeAction; contactMinistryKey: string | null; at: Date; fields: FieldChange[] },
): Promise<void> {
  const [row] = await tx
    .insert(activityChanges)
    .values({ activityId: c.activityId, at: c.at, actorId: c.actor.userId, actorName: c.actor.displayName, action: c.action, source: "calendar", contactMinistryKey: c.contactMinistryKey })
    .returning({ id: activityChanges.id });
  if (c.fields.length) {
    await tx.insert(activityChangeFields).values(c.fields.map((f) => ({ changeId: row!.id, fieldKey: f.key, oldValue: f.old, newValue: f.new })));
  }
}
