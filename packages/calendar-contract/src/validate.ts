import { cleanDetails, cleanTitle } from "./clean";
import type { HqSection } from "./enums";
import type { ActivityFields } from "./input";
import type { CalendarRules } from "./rules";

export interface FieldError {
  /** The input property, or "lookAhead.hqComments" for the Executive Summary. */
  field: string;
  message: string;
}

export interface CheckContext {
  rules: Pick<CalendarRules, "releaseCategoryIds" | "required">;
  /** HQ at Editor and above: Details, Significance and Scheduling aren't required (Activity.aspx.cs:224-230). */
  relaxRequired: boolean;
  /** The caller sees the Look Ahead fieldset (spec addendum §6). */
  lookAheadFieldset: boolean;
  /** The stored values, on an update: limits apply to changed values only. */
  previous: ActivityFields | null;
  /** The inferred section for the saved values, or null when it is fixed (awareness, consultations). */
  inferredSection: HqSection | null;
}

/** Legacy's limits (Activity.aspx:2630-2668,2788-2798; Potential Dates Activity.aspx:789). */
export const LIMITS = {
  title: 100, details: 700, significance: 500, schedule: 500, strategy: 500, comments: 4000,
  venue: 55, otherCity: 55, leadOrganization: 80, potentialDates: 50, hqComments: 2000,
} as const;
export const LIST_LIMITS = { translations: 30, translationLength: 50, keywords: 20, keywordLength: 255 } as const;
/** The database's own CHECK sizes (apps/calendar/src/db/schema.ts): the ceiling no stored value may ever cross. */
const CHECK_LIMITS = {
  title: 500, details: 700, significance: 500, schedule: 500, strategy: 500, comments: 4000,
  venue: 150, otherCity: 150, leadOrganization: 100, potentialDates: 70, hqComments: 2000,
} as const;

const blank = (s: string) => s.trim() === "";
const offStep = (t: string | null) => t !== null && Number(t.slice(3)) % 5 !== 0;
/** The years the database takes (input.ts's bcDateSchema): a date input lets through 0026 or 20255 as typed. */
const yearInRange = (d: string) => {
  const m = /^(\d{4})-\d{2}-\d{2}$/.exec(d);
  return m !== null && Number(m[1]) >= 1900 && Number(m[1]) <= 2199;
};

export function checkActivity(i: ActivityFields, ctx: CheckContext): FieldError[] {
  const errors: FieldError[] = [];
  const add = (field: string, message: string) => errors.push({ field, message });

  // Required on every save: an imported activity that breaks one is read as it is, and its next save fixes it.
  if (i.categoryId === null) add("categoryId", "Choose a category");
  if (i.contactMinistryKey === null) add("contactMinistryKey", "Choose the lead ministry");
  // The stored title is the cleaned one, which a lone special character can leave blank.
  if (blank(cleanTitle(i.title))) add("title", "Enter a title");
  if (i.commContactId === null) add("commContactId", "Choose a comm contact");
  if (i.startDate === null) add("startDate", "Enter a start date");
  if (i.endDate === null) add("endDate", "Enter an end date");
  const badYear = (field: "startDate" | "endDate" | "nrDate") => {
    const d = i[field];
    if (d === null || yearInRange(d)) return false;
    add(field, "Enter a year between 1900 and 2199");
    return true;
  };
  const datesOk = ![badYear("startDate"), badYear("endDate"), badYear("nrDate")].some(Boolean);
  if (!i.isAllDay && i.startTime === null) add("startTime", "Enter a start time, or tick All Day");
  if (!i.isAllDay && i.endTime === null) add("endTime", "Enter an end time, or tick All Day");
  if (!ctx.relaxRequired) {
    if (blank(i.details)) add("details", "Enter a summary");
    if (ctx.rules.required.significance && blank(i.significance)) add("significance", "Enter the significance");
    if (ctx.rules.required.scheduling && blank(i.schedule)) add("schedule", "Enter the scheduling considerations");
  }
  if (ctx.rules.required.strategy && blank(i.strategy)) add("strategy", "Enter the strategy");

  // Proposed and Approved Release (Activity.aspx:144-186).
  if (i.categoryId !== null && ctx.rules.releaseCategoryIds.includes(i.categoryId)) {
    if (i.nrOriginId === null) add("nrOriginId", "Choose the origin: this category is a release");
    if (i.nrDistributionId === null) add("nrDistributionId", "Choose the distribution: this category is a release");
    if (i.commMaterialIds.length === 0) add("commMaterialIds", "Choose the comm materials: this category is a release");
  }

  if (datesOk && i.startDate && i.endDate) {
    if (i.endDate < i.startDate) add("endDate", "The end date can't be before the start date");
    else if (i.endDate === i.startDate && !i.isAllDay && i.startTime && i.endTime && i.startTime > i.endTime) add("endTime", "The start time can't be after the end time");
  }
  if (i.nrDate !== null && i.nrTime === null) add("nrTime", "Enter the release time");
  if (i.nrDate === null && i.nrTime !== null) add("nrDate", "Enter the release date");
  if (datesOk && i.nrDate && i.endDate && i.nrDate > i.endDate) add("nrDate", "The release date can't be after the end date");
  if (!i.isAllDay && offStep(i.startTime)) add("startTime", "Use 5-minute steps");
  if (!i.isAllDay && offStep(i.endTime)) add("endTime", "Use 5-minute steps");
  if (offStep(i.nrTime)) add("nrTime", "Use 5-minute steps");
  // Activity.aspx:302-307
  if (/TBC|TBD/i.test(i.potentialDates) || /\d/.test(i.potentialDates)) {
    add("potentialDates", "Potential dates can't use TBC, TBD or numbers. Use a general timeline, like winter or late June.");
  }

  if (i.lookAhead && !ctx.lookAheadFieldset) add("lookAhead", "Only HQ can change the Look Ahead fields");
  if (i.lookAhead && ctx.lookAheadFieldset && i.isConfidential && ctx.inferredSection !== null && i.lookAhead.hqSection !== ctx.inferredSection && blank(i.lookAhead.hqComments)) {
    // Activity.aspx:2419-2421
    add("lookAhead.hqComments", "Enter an Executive Summary: this Not-for-Look-Ahead activity's section is overridden");
  }

  // Lengths apply to new values only: imported titles reach 217 characters (SV 4.5). But the
  // stored, cleaned form must never cross the database's own CHECK, unchanged or not: cleanTitle
  // and cleanDetails can grow a value (an ellipsis triples in length), so a value that fit raw
  // can still blow the column's CHECK once cleaned, on every save including an untouched one.
  const prev = ctx.previous;
  const limit = (field: keyof typeof LIMITS, value: string, before: string | undefined, name: string = field) => {
    if (value.length > CHECK_LIMITS[field]) { add(name, `At most ${LIMITS[field]} characters`); return; }
    if (value.length > LIMITS[field] && value !== before) add(name, `At most ${LIMITS[field]} characters`);
  };
  limit("title", cleanTitle(i.title), prev ? cleanTitle(prev.title) : undefined);
  limit("details", cleanDetails(i.details), prev ? cleanDetails(prev.details) : undefined);
  for (const f of ["significance", "schedule", "strategy", "comments", "venue", "otherCity", "leadOrganization", "potentialDates"] as const) {
    limit(f, i[f].trim(), prev?.[f].trim());
  }
  if (i.lookAhead) limit("hqComments", i.lookAhead.hqComments.trim(), prev?.lookAhead?.hqComments.trim(), "lookAhead.hqComments");

  const translations = [...new Set(i.translations.map((t) => t.trim()))];
  if (translations.length > LIST_LIMITS.translations) add("translations", `At most ${LIST_LIMITS.translations} languages`);
  else if (translations.some((t) => t === "" || t.length > LIST_LIMITS.translationLength || t.includes(","))) {
    add("translations", `Each language: 1 to ${LIST_LIMITS.translationLength} characters, with no comma`);
  }
  const keywords = [...new Set(i.keywordNames.map((k) => k.trim().toLowerCase()))];
  if (keywords.length > LIST_LIMITS.keywords) add("keywordNames", `At most ${LIST_LIMITS.keywords} HQ tags`);
  else if (keywords.some((k) => k === "" || k.length > LIST_LIMITS.keywordLength)) add("keywordNames", `Each HQ tag: 1 to ${LIST_LIMITS.keywordLength} characters`);

  return errors;
}

/** Saved anyway, with a warning (Activity.aspx:731). `todayBc` is BC's date now. */
export function warningsFor(i: ActivityFields, todayBc: string): string[] {
  const w: string[] = [];
  if (i.startDate && i.startDate < todayBc) w.push("The start date is in the past.");
  if (i.endDate && i.endDate < todayBc) w.push("The end date is in the past.");
  return w;
}
