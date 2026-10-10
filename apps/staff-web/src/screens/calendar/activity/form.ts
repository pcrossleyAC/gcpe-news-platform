import {
  inferLookAhead, releaseFieldsetHidden, sameCategoryName,
  type ActivityFields, type ActivityView, type EditorCommContact, type EditorMinistry, type EditorOptions, type EditorRules, type EditorTerm,
  type FieldError, type HqSection, type LookAheadInference, type LookAheadInput, type NeedsReviewKey,
} from "@gcpe/calendar-contract";
import { RANK_OPTIONS } from "../users/types";

export interface Choice {
  value: string;
  label: string;
}
type Me = { ministryKeys: readonly string[]; isHq: boolean };

/** A new activity: legacy's 8:00 AM–6:00 PM (spec addendum §8.2), the user's only ministry when they have one. */
export function newActivityFields(me: Me, lookAheadFieldset: boolean): ActivityFields {
  return {
    categoryId: null, title: "", details: "", significance: "", strategy: "", schedule: "", comments: "", leadOrganization: "", venue: "", otherCity: "", potentialDates: "",
    isIssue: false, isConfidential: false, isMilestone: false, isCrossGovernment: false, isAtLegislature: false, isAllDay: false, isConfirmed: false,
    startDate: null, startTime: "08:00", endDate: null, endTime: "18:00", nrDate: null, nrTime: null,
    contactMinistryKey: !me.isHq && me.ministryKeys.length === 1 ? me.ministryKeys[0]! : null,
    commContactId: null, governmentRepresentativeId: null, cityId: null, premierRequestedId: null, nrDistributionId: null, eventPlannerId: null, videographerId: null, nrOriginId: null,
    commMaterialIds: [], initiativeIds: [], keywordNames: [], sectorKeys: [], themeKeys: [], tagKeys: [], sharedWithKeys: [], translations: [],
    ...(lookAheadFieldset ? { lookAhead: { hqComments: "", hqStatus: null, hqSection: "not_on_la" as const, longTermOutlook: false } } : {}),
  };
}

/** Legacy's "MIN-Id". */
export const minIdOf = (v: Pick<ActivityView, "id" | "ministryAbbreviation">) => `${v.ministryAbbreviation ?? "—"}-${v.id}`;
/** The input a field error points at; "lookAhead.hqComments" becomes "activity-lookAhead-hqComments". */
export const fieldId = (field: string) => `activity-${field.replace(/\./g, "-")}`;

export function errorsByField(errors: readonly FieldError[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const e of errors) m.set(e.field, [...(m.get(e.field) ?? []), e.message]);
  return m;
}

const named = (name: string, isActive: boolean) => (isActive ? name : `${name} (no longer in use)`);

/** Active rows, plus any value the activity already holds (DropDownListManager.cs:297). */
export function lookupChoices(rows: readonly { id: number; name: string; isActive: boolean }[], keep: readonly (number | null)[]): Choice[] {
  return rows.filter((r) => r.isActive || keep.includes(r.id)).map((r) => ({ value: String(r.id), label: named(r.name, r.isActive) }));
}

/** HQ Placeholder, inactive in legacy, is offered to HQ only (DropDownListManager.cs:297). */
export function categoryChoices(o: EditorOptions, rules: Pick<EditorRules, "hqPlaceholderCategoryName">, useHqPlaceholder: boolean, current: number | null): Choice[] {
  const placeholder = (name: string) => sameCategoryName(name, rules.hqPlaceholderCategoryName);
  return o.categories
    .filter((c) => c.id === current || (placeholder(c.name) ? useHqPlaceholder : c.isActive))
    .map((c) => ({ value: String(c.id), label: c.isActive || placeholder(c.name) ? c.name : named(c.name, false) }));
}

const ministryLabel = (m: EditorMinistry) => named(`${m.name}${m.abbreviation ? ` (${m.abbreviation})` : ""}`, m.isActive);
const excluded = (m: EditorMinistry, list: readonly string[]) => m.abbreviation !== null && list.includes(m.abbreviation);

/** Their own ministries, or every active ministry for HQ, less the tenant's exclusions (Activity.aspx.cs:390-410). */
export function leadMinistryChoices(o: EditorOptions, rules: Pick<EditorRules, "contactMinistryExcludedAbbreviations">, me: Me, current: string | null): Choice[] {
  return o.ministries
    .filter((m) => m.key === current || (m.isActive && !excluded(m, rules.contactMinistryExcludedAbbreviations) && (me.isHq || me.ministryKeys.includes(m.key))))
    .map((m) => ({ value: m.key, label: ministryLabel(m) }));
}

/** Every active ministry less the tenant's exclusions, plus what the activity already shares with (spec addendum §8.2). */
export function sharedWithChoices(o: EditorOptions, rules: Pick<EditorRules, "sharedWithExcludedAbbreviations">, current: readonly string[]): Choice[] {
  return o.ministries
    .filter((m) => current.includes(m.key) || (m.isActive && !excluded(m, rules.sharedWithExcludedAbbreviations)))
    .map((m) => ({ value: m.key, label: ministryLabel(m) }));
}

export function contactLabel(c: EditorCommContact): string {
  const rank = RANK_OPTIONS.find((r) => r.value !== "" && r.value === String(c.rank))?.label;
  return named(`${c.name}${rank ? ` (${rank})` : ""}`, c.isActive);
}

/** The lead ministry's active comm contacts, plus the one the activity has. */
export function commContactChoices(o: EditorOptions, ministryKey: string | null, current: number | null): Choice[] {
  return o.commContacts.filter((c) => c.id === current || (c.isActive && c.ministryKey === ministryKey)).map((c) => ({ value: String(c.id), label: contactLabel(c) }));
}

export function termChoices(rows: readonly EditorTerm[], current: readonly string[]): Choice[] {
  return rows.filter((t) => t.isActive || current.includes(t.key)).map((t) => ({ value: t.key, label: named(t.name, t.isActive) }));
}

/** The tenant's languages (Activity.aspx.cs:372), plus any other the activity already has. */
export function translationChoices(defaults: readonly string[], current: readonly string[]): Choice[] {
  return [...defaults, ...current.filter((t) => !defaults.includes(t))].map((t) => ({ value: t, label: t }));
}

/** The inference's inputs, from the form and the options; the server builds the same from its tables. */
export function lookAheadInputOf(f: ActivityFields, o: EditorOptions, currentSection: HqSection | null): LookAheadInput {
  const categoryIds = f.categoryId === null ? [] : [f.categoryId];
  return {
    categoryIds,
    categoryNames: o.categories.filter((c) => categoryIds.includes(c.id)).map((c) => c.name),
    contactMinistryAbbreviation: o.ministries.find((m) => m.key === f.contactMinistryKey)?.abbreviation ?? null,
    isConfidential: f.isConfidential, isIssue: f.isIssue, isConfirmed: f.isConfirmed, commMaterialIds: f.commMaterialIds,
    startDate: f.startDate, endDate: f.endDate, currentSection,
  };
}

/** The section follows the inference until the user chooses another; a fixed section (Awareness, consultations) stays as stored (spec addendum §7.6). */
export function withInferredSection(f: ActivityFields, overridden: boolean, o: EditorOptions, rules: EditorRules, currentSection: HqSection | null): ActivityFields {
  if (!f.lookAhead || overridden) return f;
  const inferred = inferLookAhead(lookAheadInputOf(f, o, currentSection), rules);
  if (inferred.kind !== "section" || inferred.section === f.lookAhead.hqSection) return f;
  return { ...f, lookAhead: { ...f.lookAhead, hqSection: inferred.section } };
}

/** A category that hides the Release fieldset also clears the release time, as legacy did (Scripts/activityhelper.ts:170-196). */
export function withCategory(f: ActivityFields, categoryId: number | null, o: EditorOptions, rules: Pick<EditorRules, "releaseHiddenCategoryNames">): ActivityFields {
  const name = o.categories.find((c) => c.id === categoryId)?.name ?? null;
  return releaseFieldsetHidden(name, rules) ? { ...f, categoryId, nrDate: null, nrTime: null } : { ...f, categoryId };
}

/** A new lead ministry drops a comm contact of another ministry. */
export function withMinistry(f: ActivityFields, key: string | null, o: EditorOptions): ActivityFields {
  const contact = o.commContacts.find((c) => c.id === f.commContactId);
  return { ...f, contactMinistryKey: key, commContactId: contact && contact.ministryKey === key ? f.commContactId : null };
}

/** All Day hides the times; turning it off brings legacy's defaults back where they were empty. */
export function withAllDay(f: ActivityFields, on: boolean): ActivityFields {
  return on ? { ...f, isAllDay: true } : { ...f, isAllDay: false, startTime: f.startTime ?? "08:00", endTime: f.endTime ?? "18:00" };
}

/** What a save sends: the Look Ahead fields only from someone who sees the fieldset (spec addendum §6). */
export function bodyOf(f: ActivityFields, lookAheadFieldset: boolean): ActivityFields {
  if (lookAheadFieldset) return f;
  const { lookAhead: _hidden, ...rest } = f;
  return rest;
}

/** Which fields carry which needs-review flag (Activity.aspx's Markup calls; spec addendum §7.3). */
export const REVIEW_FLAG_OF: Partial<Record<keyof ActivityFields, NeedsReviewKey>> = {
  title: "title", details: "details", governmentRepresentativeId: "representative", cityId: "city", otherCity: "city",
  startDate: "start_date", startTime: "start_date", potentialDates: "start_date", endDate: "end_date", endTime: "end_date",
  categoryId: "categories", isIssue: "categories", isConfidential: "categories", commMaterialIds: "comm_materials",
  significance: "significance", comments: "internal_notes", schedule: "scheduling_considerations", strategy: "strategy",
  leadOrganization: "lead_organization", venue: "venue", initiativeIds: "initiatives", keywordNames: "tags", nrOriginId: "origin",
  nrDistributionId: "distribution", translations: "translations_required", premierRequestedId: "premier_requested",
  eventPlannerId: "event_planner", videographerId: "digital",
};
export function needsReviewOf(field: keyof ActivityFields, flags: readonly NeedsReviewKey[]): boolean {
  const k = REVIEW_FLAG_OF[field];
  return k !== undefined && flags.includes(k);
}

export const SECTION_LABELS: Readonly<Record<HqSection, string>> = {
  issues_and_reports: "Issues & Reports", events_and_speeches: "Events & Speeches", in_the_news: "In the News", not_on_la: "Not on LA",
};
export function inferredLabel(i: LookAheadInference): string {
  return i.kind === "awareness" ? "Awareness Dates" : i.kind === "consultations" ? "Consultations and Dialogues" : SECTION_LABELS[i.section];
}
/** A stored section the inference doesn't give is an HQ override, shown as one (Activity.aspx:2544-2546). */
export function initialOverride(stored: HqSection, inferred: LookAheadInference): boolean {
  return inferred.kind === "section" && inferred.section !== stored;
}
