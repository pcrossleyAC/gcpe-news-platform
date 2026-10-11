import { CALENDAR_ROLES } from "@gcpe/auth";
import { checkActivity, HQ_SECTIONS, type ActivityStatus, type CalendarRules, type HqSection, type HqStatus, type NeedsReviewKey } from "@gcpe/calendar-contract";
import { wallClockToInstant } from "@gcpe/legacy-import";
import type { CalendarUserCandidate, LegacyKeys } from "../../../core/src/import/legacy-keys";
import { fieldsOf, uniqNum, uniqStr, type ActivityRow, type JoinIds } from "../activities/store";
import type { activities } from "../db/schema";
import { JOIN_TABLES, type JoinTable, type LegacyActivity, type LegacyLookup, type LegacySnapshot, type LookupTable } from "./legacy-rows";
import type { Scope } from "./scope";

export type ActivityValues = Required<Omit<typeof activities.$inferInsert, "id" | "version" | "importedVersion">>;
export interface MappedActivity { id: number; values: ActivityValues; joins: JoinIds; notes: string[] }
export interface ActivityMapContext {
  timeZone: string;
  userIdOf(legacyId: number | null): string | null;
  /** The surviving Calendar comm contact for a legacy one (merged duplicates), or null. */
  commContactIdOf(legacyId: number | null): number | null;
  keys: LegacyKeys;
}

export const stripNul = (s: string) => s.replace(/\u0000/g, "");
const txt = (s: string | null) => stripNul(s ?? "");
const opt = (s: string | null) => (s === null ? null : stripNul(s));
const LEGACY_STATUS: Record<number, ActivityStatus> = { 7: "new", 1: "changed", 2: "reviewed" };
const LEGACY_HQ_STATUS: Record<number, HqStatus> = { 7: "new", 1: "changed" };
/** A fixed fallback, so a re-run computes the same value. */
const FALLBACK_WALL = new Date(Date.UTC(2000, 0, 1));
const yearOk = (d: Date | null) => d === null || (d.getUTCFullYear() >= 1900 && d.getUTCFullYear() <= 2199);

/** Legacy HqSection (spec addendum §7.6): 1–4 are the sections, −n is section n with Long Term Outlook. */
export function hqSectionOf(n: number): { hqSection: HqSection; longTermOutlook: boolean } | null {
  const i = Math.abs(n);
  if (!Number.isInteger(n) || i < 1 || i > 4) return null;
  return { hqSection: HQ_SECTIONS[i - 1]!, longTermOutlook: n < 0 };
}

/** Legacy's 23 needs-review columns (spec addendum §7.3). */
export const NEEDS_REVIEW_COLUMNS: Record<NeedsReviewKey, keyof LegacyActivity> = {
  title: "IsTitleNeedsReview", details: "IsDetailsNeedsReview", representative: "IsRepresentativeNeedsReview", city: "IsCityNeedsReview",
  start_date: "IsStartDateNeedsReview", end_date: "IsEndDateNeedsReview", categories: "IsCategoriesNeedsReview",
  comm_materials: "IsCommMaterialsNeedsReview", active: "IsActiveNeedsReview", significance: "IsSignificanceNeedsReview",
  strategy: "IsStrategyNeedsReview", scheduling_considerations: "IsSchedulingConsiderationsNeedsReview", internal_notes: "IsInternalNotesNeedsReview",
  lead_organization: "IsLeadOrganizationNeedsReview", initiatives: "IsInitiativesNeedsReview", tags: "IsTagsNeedsReview",
  origin: "IsOriginNeedsReview", distribution: "IsDistributionNeedsReview", translations_required: "IsTranslationsRequiredNeedsReview",
  premier_requested: "IsPremierRequestedNeedsReview", venue: "IsVenueNeedsReview", event_planner: "IsEventPlannerNeedsReview", digital: "IsDigitalNeedsReview",
};

export function joinsByActivity(scope: Scope): Map<number, Record<JoinTable, (number | string)[]>> {
  const out = new Map<number, Record<JoinTable, (number | string)[]>>();
  for (const a of scope.activities) out.set(a.Id, Object.fromEntries(JOIN_TABLES.map((t) => [t, []])) as unknown as Record<JoinTable, (number | string)[]>);
  for (const t of JOIN_TABLES) for (const r of scope.joins[t]) out.get(r.ActivityId)?.[t].push(r.ValueId);
  return out;
}

export function mapActivity(a: LegacyActivity, j: Record<JoinTable, (number | string)[]>, ctx: ActivityMapContext): MappedActivity | { id: number; skip: string } {
  if (![a.StartDateTime, a.EndDateTime, a.NRDateTime].every(yearOk)) return { id: a.Id, skip: "a date's year is outside 1900–2199" };
  const notes: string[] = [];
  const at = (d: Date | null) => (d ? wallClockToInstant(d, ctx.timeZone) : null);
  const orgKey = (guid: string) => {
    const o = ctx.keys.org(guid);
    if (!o) throw new Error("an unknown legacy ministry reached mapping; the key check runs first");
    return o.key;
  };
  const termKey = (kind: "sector" | "theme" | "tag", guid: string) => {
    const k = ctx.keys.termKey(kind, guid);
    if (!k) throw new Error(`an unknown legacy ${kind} reached mapping; the key check runs first`);
    return k;
  };
  const section = hqSectionOf(a.HqSection);
  if (!section) notes.push(`HqSection ${a.HqSection} is not a legacy section; imported as Not on LA`);
  const status = a.StatusId === null ? undefined : LEGACY_STATUS[a.StatusId];
  if (!status) notes.push(`StatusId ${a.StatusId ?? "null"} imported as New`);
  const lastUpdatedWall = a.LastUpdatedDateTime ?? a.CreatedDateTime ?? a.StartDateTime ?? a.EndDateTime ?? FALLBACK_WALL;
  const createdWall = a.CreatedDateTime ?? a.LastUpdatedDateTime ?? a.StartDateTime ?? a.EndDateTime ?? FALLBACK_WALL;
  const commContactId = ctx.commContactIdOf(a.CommunicationContactId);
  if (a.CommunicationContactId !== null && commContactId === null) notes.push("its comm contact wasn't imported");
  const values: ActivityValues = {
    startAt: at(a.StartDateTime), endAt: at(a.EndDateTime), nrAt: at(a.NRDateTime), potentialDates: opt(a.PotentialDates),
    isAllDay: a.IsAllDay, isConfirmed: a.IsConfirmed,
    title: txt(a.Title), details: txt(a.Details), schedule: txt(a.Schedule), significance: txt(a.Significance),
    strategy: opt(a.Strategy), comments: opt(a.Comments), hqComments: opt(a.HqComments), leadOrganization: opt(a.LeadOrganization),
    venue: opt(a.Venue), otherCity: opt(a.OtherCity),
    translations: txt(a.Translations).split(",").map((t) => t.trim()).filter((t) => t !== ""),
    status: status ?? "new",
    hqStatus: a.HqStatusId === null ? null : (LEGACY_HQ_STATUS[a.HqStatusId] ?? null),
    hqSection: section?.hqSection ?? "not_on_la", longTermOutlook: section?.longTermOutlook ?? false,
    nrDistributionId: a.NRDistributionId, premierRequestedId: a.PremierRequestedId,
    contactMinistryKey: a.ContactMinistryId === null ? null : orgKey(a.ContactMinistryId),
    governmentRepresentativeId: a.GovernmentRepresentativeId, commContactId, eventPlannerId: a.EventPlannerId,
    videographerId: a.VideographerId, cityId: a.CityId,
    isIssue: a.IsIssue, isAtLegislature: a.IsAtLegislature, isConfidential: a.IsConfidential, isCrossGovernment: a.IsCrossGovernment, isMilestone: a.IsMilestone,
    deletedAt: a.IsActive ? null : wallClockToInstant(lastUpdatedWall, ctx.timeZone),
    deletedBy: a.IsActive ? null : ctx.userIdOf(a.LastUpdatedBy),
    needsReview: (Object.keys(NEEDS_REVIEW_COLUMNS) as NeedsReviewKey[]).filter((k) => a[NEEDS_REVIEW_COLUMNS[k]] === true).sort(),
    createdAt: wallClockToInstant(createdWall, ctx.timeZone), createdBy: ctx.userIdOf(a.CreatedBy),
    lastUpdatedAt: wallClockToInstant(lastUpdatedWall, ctx.timeZone), lastUpdatedBy: ctx.userIdOf(a.LastUpdatedBy),
  };
  const nums = (t: JoinTable) => uniqNum(j[t].map(Number));
  const joins: JoinIds = {
    categoryIds: nums("categories"), commMaterialIds: nums("commMaterials"), initiativeIds: nums("initiatives"),
    keywordIds: nums("keywords"), nrOriginIds: nums("nrOrigins"),
    sectorKeys: uniqStr(j.sectors.map((g) => termKey("sector", String(g)))),
    themeKeys: uniqStr(j.themes.map((g) => termKey("theme", String(g)))),
    tagKeys: uniqStr(j.tags.map((g) => termKey("tag", String(g)))),
    sharedWithKeys: uniqStr(j.sharedWith.map((g) => orgKey(String(g)))),
  };
  return { id: a.Id, values, joins, notes };
}

/** A lookup row with its legacy id; a NULL name is "", a NULL active flag is inactive. */
export function mapLookup(table: LookupTable, r: LegacyLookup) {
  const base = { id: r.Id, name: txt(r.Name), sortOrder: r.SortOrder ?? 0, isActive: r.IsActive === true };
  switch (table) {
    case "eventPlanners": return { ...base, phone: opt(r.PhoneNumber ?? null), jobTitle: opt(r.JobTitle ?? null) };
    case "governmentRepresentatives": return { ...base, description: opt(r.Description ?? null) };
    case "initiatives": return { ...base, shortName: opt(r.ShortName ?? null) };
    case "videographers": return { ...base, jobTitle: opt(r.JobTitle ?? null) };
    default: return base;
  }
}

export function userCandidates(s: LegacySnapshot, scope: Scope, keys: LegacyKeys): CalendarUserCandidate[] {
  const orgId = (guid: string) => {
    const o = keys.org(guid);
    if (!o) throw new Error("an unknown legacy ministry reached mapping; the key check runs first");
    return o.id;
  };
  return s.users
    .filter((u) => scope.userIds.has(u.Id))
    .sort((a, b) => a.Id - b.Id)
    .map((u) => ({
      legacyId: u.Id,
      email: u.EmailAddress,
      displayName: (txt(u.DisplayName).trim() || txt(u.FullName).trim() || `Legacy user ${u.Id}`).slice(0, 100),
      isActive: u.IsActive === true,
      calendarRole: CALENDAR_ROLES[u.RoleId - 1] ?? null,
      organizationIds: [...new Set(s.userMinistries.filter((m) => m.SystemUserId === u.Id && m.IsActive === true).map((m) => orgId(m.MinistryId)))].sort(),
      lastUpdated: u.LastUpdatedDateTime?.getTime() ?? 0,
    }));
}

export interface UnknownKey { kind: "ministry" | "sector" | "theme" | "tag"; guid: string }
/** Every legacy GUID the in-scope data uses that Core doesn't know. Any one stops the run before it writes ("fix Core first"). */
export function unknownLegacyKeys(s: LegacySnapshot, scope: Scope, keys: LegacyKeys): UnknownKey[] {
  const out = new Map<string, UnknownKey>();
  const check = (kind: UnknownKey["kind"], raw: string | number | null) => {
    if (raw === null) return;
    const guid = String(raw).trim().toLowerCase();
    const ok = kind === "ministry" ? keys.org(guid) !== null : keys.termKey(kind, guid) !== null;
    if (!ok) out.set(`${kind}:${guid}`, { kind, guid });
  };
  for (const a of scope.activities) check("ministry", a.ContactMinistryId);
  for (const r of scope.joins.sharedWith) check("ministry", r.ValueId);
  for (const r of scope.joins.sectors) check("sector", r.ValueId);
  for (const r of scope.joins.themes) check("theme", r.ValueId);
  for (const r of scope.joins.tags) check("tag", r.ValueId);
  for (const c of scope.commContacts) check("ministry", c.MinistryId);
  for (const m of s.userMinistries) if (scope.userIds.has(m.SystemUserId) && m.IsActive === true) check("ministry", m.MinistryId);
  return [...out.values()].sort((a, b) => `${a.kind}${a.guid}`.localeCompare(`${b.kind}${b.guid}`));
}

/** The fields the shared check refuses on every save, unchanged or not (imported anyway; fixed on next save). Names only. */
export function validationProblems(m: MappedActivity, keywordNames: string[], rules: CalendarRules): string[] {
  const row = { ...m.values, id: m.id, version: 1, importedVersion: 1 } as ActivityRow;
  const { lookAhead: _lookAhead, ...fields } = fieldsOf({ row, joins: m.joins, keywordNames }, rules.timeZone);
  const errors = checkActivity(fields, { rules, relaxRequired: false, lookAheadFieldset: false, previous: fields, inferredSection: null });
  return [...new Set(errors.map((e) => e.field))].sort();
}
